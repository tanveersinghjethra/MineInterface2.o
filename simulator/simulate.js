/**
 * MineGuard hardware simulator.
 *
 *   node simulator/simulate.js --scenario=trough --interval=2500
 *
 * Scenarios
 *   normal  stable panel, sensor noise only
 *   creep   slow subsidence over ~20 min — the realistic early-warning case
 *   trough  basin develops to 0.9 m in ~8 min — the demo case
 *   blast   stable panel plus periodic blast vibration signatures
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { haversineM, destination, bearingDeg } from '../src/lib/geo.js';
import {
  influenceRadius, maxSubsidenceMm, subsidenceMm, tiltMmPerM,
  strainMmPerM, horizontalDispMm, tiltToDegrees,
} from './subsidence.js';

// ── config ──────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }));

const SCENARIO = args.scenario || 'trough';
const INTERVAL = Number(args.interval || 2500);
const SITE_CODE = process.env.SITE_CODE || 'JHARIA-P7';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

// ── helpers ─────────────────────────────────────────────────
const gauss = (sd = 1) => {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const r4 = (n) => +Number(n).toFixed(4);

/** Growth of the basin over time, per scenario. Returns Smax in mm. */
function basinDepth(elapsedS, Sfull) {
  switch (SCENARIO) {
    case 'normal':
    case 'blast':
      return 0;
    case 'creep':
      // logistic growth to 8% of full subsidence over ~20 minutes
      return Sfull * 0.08 / (1 + Math.exp(-(elapsedS - 600) / 140));
    case 'trough':
    default:
      // logistic growth to 46% of full subsidence over ~8 minutes
      return Sfull * 0.46 / (1 + Math.exp(-(elapsedS - 260) / 70));
  }
}

function blastVibration(elapsedS) {
  if (SCENARIO !== 'blast') return 0;
  const phase = elapsedS % 90;              // a round every 90 s
  return phase < 4 ? 0.35 + Math.random() * 0.4 : 0;
}

// ── main ────────────────────────────────────────────────────
async function main() {
  const { data: site, error: se } = await db
    .from('mine_sites').select('*').eq('code', SITE_CODE).single();
  if (se) throw se;

  const { data: nodes, error: ne } = await db
    .from('sensor_nodes').select('*').eq('site_id', site.id).order('node_code');
  if (ne) throw ne;
  if (!nodes.length) throw new Error('No nodes. Run 0002_seed.sql first.');

  const { data: links, error: le } = await db
    .from('node_links').select('*').eq('site_id', site.id);
  if (le) throw le;

  if (args.reset) {
    await db.from('sensor_readings').delete().neq('id', 0);
    await db.from('anomaly_scores').delete().neq('id', 0);
    console.log('· cleared previous readings and scores');
  }

  const R = influenceRadius(Number(site.panel_depth_m), Number(site.angle_of_draw_deg));
  const Sfull = maxSubsidenceMm(Number(site.seam_thickness_m), Number(site.extraction_ratio));

  // put the basin centre 35 m north-east of the panel centroid so that some
  // nodes go critical while others stay green — a uniform map proves nothing
  const centre = destination([site.centroid_lat, site.centroid_lng], 48, 35);

  console.log(`\nMineGuard simulator`);
  console.log(`  site       ${site.code} — ${site.name}`);
  console.log(`  scenario   ${SCENARIO}   interval ${INTERVAL} ms`);
  console.log(`  nodes      ${nodes.length}   links ${links.length}`);
  console.log(`  basin      R = ${R.toFixed(1)} m,  Smax(full) = ${Sfull.toFixed(0)} mm`);
  console.log(`  centre     ${centre[0].toFixed(6)}, ${centre[1].toFixed(6)}`);
  console.log(`  Ctrl+C to stop\n`);

  const t0 = Date.now();
  let tick = 0;

  const step = async () => {
    tick += 1;
    const elapsedS = (Date.now() - t0) / 1000;
    const Smax = basinDepth(elapsedS, Sfull);
    const blast = blastVibration(elapsedS);
    const ts = new Date().toISOString();

    const displaced = {};   // node_code -> [lat,lng] after horizontal movement
    const rows = [];

    for (const n of nodes) {
      const home = [Number(n.install_lat), Number(n.install_lng)];
      const r = haversineM(centre, home);

      const S = subsidenceMm(r, Smax, R);                    // mm down
      const T = tiltMmPerM(r, Smax, R);                      // mm/m
      const U = horizontalDispMm(r, Smax, R, Number(site.panel_depth_m)); // mm towards centre

      // ground dips towards the basin centre; split the tilt into roll/pitch
      const toCentre = bearingDeg(home, centre);
      const tiltDeg = Math.abs(tiltToDegrees(T));
      const roll = tiltDeg * Math.sin((toCentre * Math.PI) / 180) + gauss(0.008);
      const pitch = tiltDeg * Math.cos((toCentre * Math.PI) / 180) + gauss(0.008);
      const yaw = ((Number(n.install_lng) * 1000) % 360) + gauss(0.05);

      // horizontal ground movement carries the node towards the centre
      const moved = destination(home, toCentre, Math.abs(U) / 1000);
      displaced[n.node_code] = moved;

      // RTK-grade fix: sigma ~15 mm. With a plain NEO-6M you would see ~2 m
      // here — see the note under this section.
      const gpsLat = moved[0] + gauss(15 / 111320);
      const gpsLng = moved[1] + gauss(15 / (111320 * Math.cos(moved[0] * Math.PI / 180)));

      const eps = strainMmPerM(r, Smax, R, Number(site.panel_depth_m));
      const vibBase = 0.012 + Math.abs(T) * 0.0009 + Math.abs(gauss(0.006));
      const vib = vibBase + blast;

      rows.push({
        node_id: n.id,
        ts,
        roll_rate: r4(roll),
        pitch_rate: r4(pitch),
        yaw_rate: r4(yaw),
        accel_rms_g: r4(0.012 + Math.abs(gauss(0.004)) + blast * 0.4),
        vibration_rms_g: r4(vib),
        vibration_peak_g: r4(vib * (2.4 + Math.random())),
        gps_lat: gpsLat,
        gps_lng: gpsLng,
        gps_alt_m: r4(247 - S / 1000 + gauss(0.02)),
        hdop: r4(0.7 + Math.abs(gauss(0.2))),
        satellites: 9 + Math.floor(Math.random() * 4),
        deltax: r4(Math.abs(U) * Math.sin((toCentre * Math.PI) / 180) + gauss(0.3)),
        deltay: r4(Math.abs(U) * Math.cos((toCentre * Math.PI) / 180) + gauss(0.3)),
        deltaz: r4(-S / 1000 + gauss(0.15)),
        battery_v: r4(3.95 - elapsedS / 90000 + gauss(0.01)),
        rssi_dbm: Math.round(-78 - Math.random() * 16),
        ingest_source: `sim:${SCENARIO}`,
      });
    }

    // recompute mesh geometry from the displaced positions — this is what a
    // UWB ranging pair or a string potentiometer would actually measure
    const byCode = Object.fromEntries(nodes.map((n) => [n.id, n.node_code]));
    const deltasByNode = {};
    const linkUpdates = [];

    for (const l of links) {
      const a = displaced[byCode[l.node_a]];
      const b = displaced[byCode[l.node_b]];
      if (!a || !b) continue;
      const nowM = haversineM(a, b) + gauss(0.0015);       // ±1.5 mm ranging noise
      const base = Number(l.baseline_distance_m);
      const deltaMm = (nowM - base) * 1000;
      const strain = deltaMm / base;

      linkUpdates.push({
        id: l.id, site_id: l.site_id, node_a: l.node_a, node_b: l.node_b,
        baseline_distance_m: base,
        current_distance_m: r4(nowM),
        strain_mm_per_m: r4(strain),
        rssi_dbm: Math.round(-76 - Math.random() * 18),
        updated_at: ts,
      });

      (deltasByNode[l.node_a] ||= []).push(deltaMm);
      (deltasByNode[l.node_b] ||= []).push(deltaMm);
    }

    for (const row of rows) {
      const ds = deltasByNode[row.node_id] || [0];
      row.delta_distance_mm = r4(ds.reduce((s, d) => s + d, 0) / ds.length);
    }

    const [{ error: insErr }, { error: upErr }] = await Promise.all([
      db.from('sensor_readings').insert(rows),
      db.from('node_links').upsert(linkUpdates, { onConflict: 'id' }),
    ]);
    if (insErr) console.error('insert', insErr.message);
    if (upErr) console.error('links', upErr.message);

    const peak = Math.max(...rows.map((r) => Math.abs(r.delta_distance_mm)));
    process.stdout.write(
      `\r  tick ${String(tick).padStart(4)} · t+${elapsedS.toFixed(0)}s · ` +
      `Smax ${Smax.toFixed(0)} mm · peak Δdistance ${peak.toFixed(1)} mm   `);
  };

  await step();
  const timer = setInterval(step, INTERVAL);
  process.on('SIGINT', () => {
    clearInterval(timer);
    console.log('\n  stopped.\n');
    process.exit(0);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
