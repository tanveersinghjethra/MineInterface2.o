/**
 * Continuously scores every node, writes anomaly_scores, and raises an
 * early warning when a node crosses the action level.
 *
 *   node simulator/scorer.js
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { analyseNode, SEVERITY_RANK, topDrivers } from '../src/lib/analytics.js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE_CODE = process.env.SITE_CODE || 'JHARIA-P7';
const PERIOD_MS = Number(process.env.SCORE_PERIOD_MS || 5000);
const ALERT_AT = process.env.ALERT_AT || 'High';       // Moderate | High | Critical
const COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS || 10 * 60 * 1000);

if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

const prevScore = new Map();     // nodeId -> smoothed score
const lastAlert = new Map();     // nodeId -> { at, severity }

async function raiseAlert(site, analysis) {
  const f = analysis.features;
  const drivers = topDrivers(analysis).map((d) => d.label.toLowerCase()).join(', ');
  const eta = analysis.forecast.hoursToThreshold;

  const body =
    `MINEGUARD ${site.code}: ${analysis.severity.toUpperCase()} subsidence risk at ` +
    `${analysis.nodeCode} (score ${analysis.score.toFixed(2)}). ` +
    `Tilt ${f.tiltDeltaDeg.toFixed(2)} deg, strain ${f.strainMmPerM.toFixed(2)} mm/m, ` +
    `displacement ${f.displacementMm.toFixed(0)} mm, ` +
    `ΔX ${f.deltax.toFixed(1)} / ΔY ${f.deltay.toFixed(1)} / ΔZ ${f.deltaz.toFixed(1)} mm. ` +
    `Drivers: ${drivers}. ` +
    (eta ? `Action level projected in ~${eta} h. ` : '') +
    `Restrict surface access and verify by survey.`;

  const res = await fetch(`${url}/functions/v1/send-alert`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      site_id: site.id,
      node_id: analysis.nodeId,
      severity: analysis.severity,
      score: analysis.score,
      title: `${analysis.severity} subsidence risk at ${analysis.nodeCode}`,
      body,
      channels: ['sms', 'email'],
      triggered_by: 'scorer',
    }),
  });
  const out = await res.json().catch(() => ({}));
  console.log(`\n  ⚠ alert ${analysis.nodeCode} ${analysis.severity} → ` +
    `${out.sent ?? 0}/${out.recipients ?? 0} recipients${out.mock ? ' (mock)' : ''}`);
}

async function cycle(site, nodes, links) {
  const since = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const { data: readings, error } = await db
    .from('sensor_readings').select('*')
    .gte('ts', since).order('ts', { ascending: true }).limit(8000);
  if (error) { console.error(error.message); return; }

  const grouped = {};
  for (const r of readings) (grouped[r.node_id] ||= []).push(r);

  const scoreRows = [];
  for (const node of nodes) {
    const hist = grouped[node.id] || [];
    if (!hist.length) continue;
    const nodeLinks = links.filter((l) => l.node_a === node.id || l.node_b === node.id);
    const a = analyseNode(node, hist, nodeLinks, prevScore.get(node.id) ?? null);
    prevScore.set(node.id, a.score);

    scoreRows.push({
      node_id: node.id,
      ts: new Date().toISOString(),
      score: a.score,
      severity: a.severity,
      tilt_delta_deg: a.features.tiltDeltaDeg,
      tilt_rate_deg_hr: a.features.tiltRateDegHr,
      strain_mm_per_m: a.features.strainMmPerM,
      displacement_mm: a.features.displacementMm,
      vibration_rms_g: a.features.vibrationG,
      deltax: a.features.deltax,
      deltay: a.features.deltay,
      deltaz: a.features.deltaz,
      contributions: a.contributions,
      forecast_24h: a.forecast,
      model_version: a.modelVersion,
    });

    // escalation logic: fire on first crossing, then only if it gets worse,
    // or after the cooldown expires
    if (SEVERITY_RANK[a.severity] >= SEVERITY_RANK[ALERT_AT]) {
      const prev = lastAlert.get(node.id);
      const worse = !prev || SEVERITY_RANK[a.severity] > SEVERITY_RANK[prev.severity];
      const stale = prev && Date.now() - prev.at > COOLDOWN_MS;
      if (!prev || worse || stale) {
        lastAlert.set(node.id, { at: Date.now(), severity: a.severity });
        raiseAlert(site, a).catch((e) => console.error('alert failed', e));
      }
    }
  }

  if (scoreRows.length) {
    const { error: insErr } = await db.from('anomaly_scores').insert(scoreRows);
    if (insErr) console.error('scores', insErr.message);
  }

  const worst = scoreRows.reduce(
    (m, r) => (r.score > (m?.score ?? -1) ? r : m), null);
  process.stdout.write(
    `\r  scored ${String(scoreRows.length).padStart(2)} nodes · ` +
    `peak ${worst ? worst.score.toFixed(2) : '—'} (${worst?.severity ?? '—'})   `);
}

async function main() {
  const { data: site } = await db
    .from('mine_sites').select('*').eq('code', SITE_CODE).single();
  const { data: nodes } = await db
    .from('sensor_nodes').select('*').eq('site_id', site.id);
  const { data: links } = await db
    .from('node_links').select('*').eq('site_id', site.id);

  console.log(`\nMineGuard scorer`);
  console.log(`  site ${site.code} · ${nodes.length} nodes · alert at ${ALERT_AT}+`);
  console.log(`  cooldown ${COOLDOWN_MS / 60000} min · period ${PERIOD_MS} ms\n`);

  await cycle(site, nodes, links);
  const timer = setInterval(async () => {
    // reload links each cycle: the simulator/gateway keeps updating them
    const { data: fresh } = await db
      .from('node_links').select('*').eq('site_id', site.id);
    await cycle(site, nodes, fresh || links);
  }, PERIOD_MS);

  process.on('SIGINT', () => { clearInterval(timer); console.log('\n  stopped.\n'); process.exit(0); });
}

main().catch((e) => { console.error(e); process.exit(1); });
