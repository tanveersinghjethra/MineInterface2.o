// src/lib/geo.js — no framework imports, runs in browser and Node
const R_EARTH = 6371000;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Great-circle distance in metres between [lat,lng] pairs. */
export function haversineM(a, b) {
  const dLat = (b[0] - a[0]) * D2R;
  const dLng = (b[1] - a[1]) * D2R;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * D2R) * Math.cos(b[0] * D2R) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing a → b, degrees clockwise from north. */
export function bearingDeg(a, b) {
  const dLng = (b[1] - a[1]) * D2R;
  const y = Math.sin(dLng) * Math.cos(b[0] * D2R);
  const x =
    Math.cos(a[0] * D2R) * Math.sin(b[0] * D2R) -
    Math.sin(a[0] * D2R) * Math.cos(b[0] * D2R) * Math.cos(dLng);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

/** Move distM metres along bearing from [lat,lng]. */
export function destination([lat, lng], bearing, distM) {
  const d = distM / R_EARTH;
  const br = bearing * D2R;
  const la1 = lat * D2R;
  const lo1 = lng * D2R;
  const la2 = Math.asin(
    Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br)
  );
  const lo2 =
    lo1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(la1),
      Math.cos(d) - Math.sin(la1) * Math.sin(la2)
    );
  return [la2 * R2D, ((lo2 * R2D + 540) % 360) - 180];
}

/** Degrees per metre at a given latitude — handy for building grids. */
export function degPerMetre(lat) {
  return {
    dLat: 1 / 111320,
    dLng: 1 / (111320 * Math.cos(lat * D2R)),
  };
}

/** Bounding box of [lat,lng] points, padded by padM metres. */
export function bbox(points, padM = 0) {
  const lats = points.map((p) => p[0]);
  const lngs = points.map((p) => p[1]);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const { dLat, dLng } = degPerMetre(midLat);
  return {
    minLat: Math.min(...lats) - padM * dLat,
    maxLat: Math.max(...lats) + padM * dLat,
    minLng: Math.min(...lngs) - padM * dLng,
    maxLng: Math.max(...lngs) + padM * dLng,
  };
}

/**
 * Inverse-distance-weighted deformation surface.
 * Turns discrete node risk scores into a raster the operator can read as a map.
 * Returns cells: { bounds:[[s,w],[n,e]], value:0..1, lat, lng }
 */
export function idwGrid(samples, box, cells = 22, power = 2, influenceM = 160) {
  if (!samples.length) return [];
  const latStep = (box.maxLat - box.minLat) / cells;
  const lngStep = (box.maxLng - box.minLng) / cells;
  const out = [];

  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      const s = box.minLat + i * latStep;
      const w = box.minLng + j * lngStep;
      const c = [s + latStep / 2, w + lngStep / 2];

      let num = 0;
      let den = 0;
      let nearest = Infinity;
      for (const smp of samples) {
        const d = Math.max(1, haversineM(c, [smp.lat, smp.lng]));
        nearest = Math.min(nearest, d);
        const wt = 1 / Math.pow(d, power);
        num += wt * smp.value;
        den += wt;
      }
      // fade the surface out beyond the mesh so we never claim to know
      // what is happening where there are no sensors
      const fade = Math.exp(-nearest / influenceM);
      const value = (num / den) * fade;
      if (value > 0.04) {
        out.push({
          bounds: [[s, w], [s + latStep, w + lngStep]],
          value: Math.min(1, value),
          lat: c[0],
          lng: c[1],
        });
      }
    }
  }
  return out;
}

/** Andrew monotone-chain convex hull over [lat,lng] points. */
export function convexHull(points) {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const cross = (o, a, b) =>
    (a[1] - o[1]) * (b[0] - o[0]) - (a[0] - o[0]) * (b[1] - o[1]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Build a risk-zone polygon from the hot cells of an IDW grid. */
export function riskZonePolygon(grid, minValue = 0.6) {
  const hot = grid.filter((c) => c.value >= minValue).map((c) => [c.lat, c.lng]);
  if (hot.length < 3) return null;
  return convexHull(hot);
}

/** Spherical-excess area of a lat/lng ring, in m². */
export function polygonAreaM2(ring) {
  if (!ring || ring.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const [lat1, lng1] = ring[i];
    const [lat2, lng2] = ring[(i + 1) % ring.length];
    total += (lng2 - lng1) * D2R * (2 + Math.sin(lat1 * D2R) + Math.sin(lat2 * D2R));
  }
  return Math.abs((total * R_EARTH * R_EARTH) / 2);
}

export function fmtLatLng(lat, lng) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lng >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(5)}°${ns} / ${Math.abs(lng).toFixed(5)}°${ew}`;
}
