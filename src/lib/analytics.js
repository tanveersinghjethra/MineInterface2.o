// src/lib/analytics.js — shared by the React app and simulator/scorer.js
import { haversineM } from './geo.js';

export const MODEL_VERSION = 'mineguard-ewma-v1';
export const HISTORY_LIMIT = 240;      // readings kept per node in memory

/**
 * Thresholds. `warn` is the onset of concern, `crit` is the action level.
 * Strain bands follow the NCB/Subsidence Engineers' damage classification
 * used in Indian coalfield practice. CALIBRATE THESE PER SITE with your
 * mine's survey data before any real deployment.
 */
export const THRESHOLDS = {
  tiltDeltaDeg:   { warn: 0.35, crit: 1.20 },
  tiltRateDegHr:  { warn: 0.08, crit: 0.30 },
  strainMmPerM:   { warn: 2.0,  crit: 6.0  },
  displacementMm: { warn: 25,   crit: 100  },
  vibrationG:     { warn: 0.12, crit: 0.45 },
  deltaPos:       { warn: 5.0,  crit: 20.0 },
};

export const WEIGHTS = {
  tilt: 0.26,
  tiltRate: 0.16,
  strain: 0.22,
  displacement: 0.16,
  vibration: 0.12,
  deltaPos: 0.08,
};

export const FEATURE_LABELS = {
  tilt: 'Ground tilt',
  tiltRate: 'Tilt acceleration',
  strain: 'Horizontal strain',
  displacement: 'Surface displacement',
  vibration: 'Vibration energy',
  deltaPos: '3D positional shift',
};

export const GPS_HDOP_LIMIT = 2.5;     // reject fixes worse than this

// ── primitives ──────────────────────────────────────────────
const D2R = Math.PI / 180;

/** Piecewise ramp: 0 → warn maps to 0–0.45, warn → crit to 0.45–0.85, beyond to 0.85–1. */
export function ramp(v, warn, crit) {
  const x = Math.abs(Number(v) || 0);
  if (x <= 0) return 0;
  if (x <= warn) return 0.45 * (x / warn);
  if (x <= crit) return 0.45 + 0.4 * ((x - warn) / (crit - warn));
  return Math.min(1, 0.85 + 0.15 * ((x - crit) / crit));
}

/** True tilt from the vertical for a roll/pitch pair, in degrees. */
export function tiltMagnitude(rollDeg = 0, pitchDeg = 0) {
  const c = Math.cos(rollDeg * D2R) * Math.cos(pitchDeg * D2R);
  return Math.acos(Math.max(-1, Math.min(1, c))) / D2R;
}

export function median(values) {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Ordinary least squares on {x,y} points. */
export function linreg(points) {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: n ? points[0].y : 0, r2: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (const p of points) {
    sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; syy += p.y * p.y;
  }
  const d = n * sxx - sx * sx;
  if (Math.abs(d) < 1e-12) return { slope: 0, intercept: sy / n, r2: 0 };
  const slope = (n * sxy - sx * sy) / d;
  const intercept = (sy - slope * sx) / n;
  const ssTot = syy - (sy * sy) / n;
  const ssRes = points.reduce(
    (a, p) => a + (p.y - (slope * p.x + intercept)) ** 2, 0);
  return {
    slope,
    intercept,
    r2: ssTot > 1e-12 ? Math.max(0, 1 - ssRes / ssTot) : 0,
  };
}

/** Exponentially weighted moving average — suppresses single-packet spikes. */
export function ewma(prev, next, alpha = 0.35) {
  return prev == null ? next : prev + alpha * (next - prev);
}

// ── feature extraction ──────────────────────────────────────
/**
 * @param node      row from v_node_dashboard / sensor_nodes (holds baselines)
 * @param readings  ascending by ts, most recent last
 * @param links     node_links rows touching this node (optional)
 */
export function extractFeatures(node, readings, links = []) {
  const empty = {
    tiltDeltaDeg: 0, tiltRateDegHr: 0, strainMmPerM: 0,
    displacementMm: 0, vibrationG: 0, deltaPos: 0,
    deltax: 0, deltay: 0, deltaz: 0,
    yawDriftDeg: 0, sampleCount: 0, lastTs: null,
  };
  if (!readings || !readings.length) return empty;

  const last = readings[readings.length - 1];
  const b = {
    roll: Number(node.baseline_roll_deg) || 0,
    pitch: Number(node.baseline_pitch_deg) || 0,
    yaw: Number(node.baseline_yaw_deg) || 0,
    lat: node.baseline_lat ?? node.install_lat,
    lng: node.baseline_lng ?? node.install_lng,
  };

  // tilt: median of the last 5 packets kills IMU noise
  const tiltSeries = readings.map((r) => ({
    t: new Date(r.ts).getTime(),
    v: tiltMagnitude(
      (Number(r.roll_rate) || 0) - b.roll,
      (Number(r.pitch_rate) || 0) - b.pitch
    ),
  }));
  const tiltDeltaDeg = median(tiltSeries.slice(-5).map((p) => p.v));

  // tilt rate over the last 30 minutes, expressed in deg/hour
  const cutoff = tiltSeries[tiltSeries.length - 1].t - 30 * 60 * 1000;
  const window = tiltSeries.filter((p) => p.t >= cutoff);
  const t0 = window.length ? window[0].t : 0;
  const { slope } = linreg(
    window.map((p) => ({ x: (p.t - t0) / 3600000, y: p.v }))
  );
  const tiltRateDegHr = Number.isFinite(slope) ? slope : 0;

  // horizontal strain: prefer measured mesh links, fall back to the
  // node's own mean delta distance
  let strainMmPerM = 0;
  const linkStrains = links
    .map((l) => Number(l.strain_mm_per_m))
    .filter(Number.isFinite);
  if (linkStrains.length) {
    strainMmPerM = linkStrains.reduce(
      (m, s) => (Math.abs(s) > Math.abs(m) ? s : m), 0);
  } else {
    const baseLen = Number(node.mean_link_length_m) || 80;
    strainMmPerM = (Number(last.delta_distance_mm) || 0) / baseLen;
  }

  // GPS displacement: median over the last 9 usable fixes
  const fixes = readings
    .slice(-9)
    .filter((r) =>
      Number.isFinite(Number(r.gps_lat)) &&
      Number.isFinite(Number(r.gps_lng)) &&
      (r.hdop == null || Number(r.hdop) <= GPS_HDOP_LIMIT))
    .map((r) => haversineM([b.lat, b.lng], [Number(r.gps_lat), Number(r.gps_lng)]) * 1000);
  const displacementMm = median(fixes);

  const vibrationG = Math.max(
    ...readings.slice(-3).map((r) => Number(r.vibration_rms_g) || 0), 0);
  const deltax = Number(last.deltax) || 0;
  const deltay = Number(last.deltay) || 0;
  const deltaz = Number(last.deltaz) || 0;
  const deltaPos = Math.sqrt(deltax * deltax + deltay * deltay + deltaz * deltaz);
  const yawDriftDeg = ((Number(last.yaw_rate) || 0) - b.yaw + 540) % 360 - 180;

  return {
    tiltDeltaDeg, tiltRateDegHr, strainMmPerM, displacementMm,
    vibrationG, deltaPos, deltax, deltay, deltaz, yawDriftDeg,
    sampleCount: readings.length,
    lastTs: last.ts,
  };
}

// ── scoring ─────────────────────────────────────────────────
export function scoreFeatures(f) {
  const parts = {
    tilt: ramp(f.tiltDeltaDeg, THRESHOLDS.tiltDeltaDeg.warn, THRESHOLDS.tiltDeltaDeg.crit),
    tiltRate: ramp(f.tiltRateDegHr, THRESHOLDS.tiltRateDegHr.warn, THRESHOLDS.tiltRateDegHr.crit),
    strain: ramp(f.strainMmPerM, THRESHOLDS.strainMmPerM.warn, THRESHOLDS.strainMmPerM.crit),
    displacement: ramp(f.displacementMm, THRESHOLDS.displacementMm.warn, THRESHOLDS.displacementMm.crit),
    vibration: ramp(f.vibrationG, THRESHOLDS.vibrationG.warn, THRESHOLDS.vibrationG.crit),
    deltaPos: ramp(f.deltaPos, THRESHOLDS.deltaPos.warn, THRESHOLDS.deltaPos.crit),
  };

  let raw = 0;
  const contributions = {};
  for (const k of Object.keys(WEIGHTS)) {
    const c = WEIGHTS[k] * parts[k];
    contributions[k] = +c.toFixed(4);
    raw += c;
  }

  // Corroboration rule: two independent physical signals agreeing is a far
  // stronger indicator than one loud sensor. Boost when >=2 features are hot.
  const hot = Object.values(parts).filter((p) => p >= 0.45).length;
  const corroboration = hot >= 3 ? 1.18 : hot === 2 ? 1.09 : 1.0;

  const score = Math.max(0, Math.min(1, raw * corroboration));
  return { score: +score.toFixed(4), parts, contributions, corroboration, hot };
}

export function severityOf(score) {
  if (score >= 0.8) return 'Critical';
  if (score >= 0.6) return 'High';
  if (score >= 0.3) return 'Moderate';
  return 'Low';
}

export const SEVERITY_RANK = { Low: 0, Moderate: 1, High: 2, Critical: 3 };

export function riskColor(score) {
  if (score >= 0.8) return '#ff4d5f';
  if (score >= 0.6) return '#ff8a34';
  if (score >= 0.3) return '#f5c542';
  return '#32d583';
}

/** NCB damage classification from horizontal strain (mm/m). */
export function damageClass(strain) {
  const s = Math.abs(strain);
  if (s < 0.5) return 'Negligible';
  if (s < 1.0) return 'Very slight';
  if (s < 2.0) return 'Slight';
  if (s < 3.0) return 'Appreciable';
  if (s < 6.0) return 'Severe';
  return 'Very severe';
}

// ── prediction ──────────────────────────────────────────────
/**
 * Project tilt and strain forward and estimate hours until the critical
 * threshold is reached. Uses the trend of the observed window; r² is
 * reported so the UI can show how much to trust the projection.
 */
export function forecast(readings, node, links = [], horizonH = 24) {
  if (!readings || readings.length < 4) {
    return { tilt24h: 0, strain24h: 0, hoursToThreshold: null, confidence: 0, trend: 'stable' };
  }
  const b = {
    roll: Number(node.baseline_roll_deg) || 0,
    pitch: Number(node.baseline_pitch_deg) || 0,
  };
  const t0 = new Date(readings[0].ts).getTime();
  const toH = (ts) => (new Date(ts).getTime() - t0) / 3600000;

  const tiltPts = readings.map((r) => ({
    x: toH(r.ts),
    y: tiltMagnitude((Number(r.roll_rate) || 0) - b.roll, (Number(r.pitch_rate) || 0) - b.pitch),
  }));
  const baseLen = Number(node.mean_link_length_m) || 80;
  const strainPts = readings.map((r) => ({
    x: toH(r.ts),
    y: (Number(r.delta_distance_mm) || 0) / baseLen,
  }));

  const tiltFit = linreg(tiltPts);
  const strainFit = linreg(strainPts);
  const nowX = tiltPts.at(-1).x;

  const tilt24h = tiltFit.slope * (nowX + horizonH) + tiltFit.intercept;
  const strain24h = strainFit.slope * (nowX + horizonH) + strainFit.intercept;

  let hoursToThreshold = null;
  if (tiltFit.slope > 1e-4) {
    const h = (THRESHOLDS.tiltDeltaDeg.crit - tiltPts.at(-1).y) / tiltFit.slope;
    if (h > 0 && h < 24 * 30) hoursToThreshold = h;
  }
  if (Math.abs(strainFit.slope) > 1e-4) {
    const h =
      (THRESHOLDS.strainMmPerM.crit - Math.abs(strainPts.at(-1).y)) /
      Math.abs(strainFit.slope);
    if (h > 0 && (hoursToThreshold == null || h < hoursToThreshold)) hoursToThreshold = h;
  }

  const confidence = Math.round(
    100 * Math.min(0.97, 0.45 + 0.5 * Math.max(tiltFit.r2, strainFit.r2)));
  const trend =
    tiltFit.slope > 0.01 || Math.abs(strainFit.slope) > 0.05
      ? 'increasing'
      : tiltFit.slope < -0.01
      ? 'recovering'
      : 'stable';

  return {
    tilt24h: +Math.max(0, tilt24h).toFixed(3),
    strain24h: +strain24h.toFixed(3),
    hoursToThreshold: hoursToThreshold == null ? null : +hoursToThreshold.toFixed(1),
    confidence,
    trend,
    tiltSlope: +tiltFit.slope.toFixed(5),
    strainSlope: +strainFit.slope.toFixed(5),
  };
}

/** One call → everything the UI and the alert engine need for one node. */
export function analyseNode(node, readings, links = [], prevScore = null) {
  const features = extractFeatures(node, readings, links);
  const scored = scoreFeatures(features);
  const smoothed = +Math.min(1, Math.max(0, ewma(prevScore, scored.score, 0.35))).toFixed(4);
  const fc = forecast(readings, node, links);
  return {
    nodeId: node.id,
    nodeCode: node.node_code,
    features,
    parts: scored.parts,
    contributions: scored.contributions,
    corroboration: scored.corroboration,
    hot: scored.hot,
    rawScore: scored.score,
    score: smoothed,
    severity: severityOf(smoothed),
    color: riskColor(smoothed),
    damage: damageClass(features.strainMmPerM),
    forecast: fc,
    modelVersion: MODEL_VERSION,
  };
}

/** Top-3 human-readable drivers, for the "why" line in the UI and the SMS. */
export function topDrivers(analysis, n = 3) {
  return Object.entries(analysis.contributions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .filter(([, v]) => v > 0.005)
    .map(([k, v]) => ({
      key: k,
      label: FEATURE_LABELS[k],
      share: analysis.rawScore > 0 ? Math.round((v / analysis.rawScore) * 100) : 0,
    }));
}
