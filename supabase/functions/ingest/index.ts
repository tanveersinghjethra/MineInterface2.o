// supabase/functions/ingest/index.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-ingest-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const reply = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  const key = Deno.env.get('INGEST_KEY');
  if (key && req.headers.get('x-ingest-key') !== key) {
    return reply({ error: 'unauthorised gateway' }, 401);
  }

  try {
    const { gateway = 'GW-01', readings = [], links = [] } = await req.json();
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } });

    const codes = [...new Set([
      ...readings.map((r: any) => r.node_code),
      ...links.flatMap((l: any) => [l.a, l.b]),
    ].filter(Boolean))];

    const { data: nodes, error: nErr } = await admin
      .from('sensor_nodes').select('id,node_code,site_id').in('node_code', codes);
    if (nErr) throw nErr;
    const idOf = Object.fromEntries(nodes.map((n) => [n.node_code, n.id]));

    const rows = readings
      .filter((r: any) => idOf[r.node_code])
      .map((r: any) => ({
        node_id: idOf[r.node_code],
        ts: r.ts || new Date().toISOString(),
        roll_deg: r.roll_deg, pitch_deg: r.pitch_deg, yaw_deg: r.yaw_deg,
        accel_x_g: r.accel_x_g, accel_y_g: r.accel_y_g, accel_z_g: r.accel_z_g,
        accel_rms_g: r.accel_rms_g,
        vibration_rms_g: r.vibration_rms_g, vibration_peak_g: r.vibration_peak_g,
        dominant_freq_hz: r.dominant_freq_hz,
        gps_lat: r.gps_lat, gps_lng: r.gps_lng, gps_alt_m: r.gps_alt_m,
        hdop: r.hdop, satellites: r.satellites,
        delta_distance_mm: r.delta_distance_mm, crack_width_mm: r.crack_width_mm,
        battery_v: r.battery_v, rssi_dbm: r.rssi_dbm, temperature_c: r.temperature_c,
        ingest_source: gateway,
      }));

    if (rows.length) {
      const { error } = await admin.from('sensor_readings').insert(rows);
      if (error) throw error;
    }

    // optional measured link distances (UWB / string pot)
    let linkUpdates = 0;
    for (const l of links) {
      const a = idOf[l.a];
      const b = idOf[l.b];
      if (!a || !b) continue;
      const { data: row } = await admin
        .from('node_links').select('id,baseline_distance_m')
        .or(`and(node_a.eq.${a},node_b.eq.${b}),and(node_a.eq.${b},node_b.eq.${a})`)
        .maybeSingle();
      if (!row) continue;
      const strain = ((l.distance_m - row.baseline_distance_m) * 1000) / row.baseline_distance_m;
      await admin.from('node_links').update({
        current_distance_m: l.distance_m,
        strain_mm_per_m: +strain.toFixed(4),
        rssi_dbm: l.rssi ?? null,
        updated_at: new Date().toISOString(),
      }).eq('id', row.id);
      linkUpdates++;
    }

    return reply({ ok: true, inserted: rows.length, links: linkUpdates });
  } catch (err) {
    console.error('[ingest]', err);
    return reply({ error: String(err) }, 500);
  }
});
