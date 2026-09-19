-- ============================================================
-- MineGuard 0001_init.sql
-- Mine subsidence monitoring schema
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1. Sites (one row per mine panel under observation)
-- ------------------------------------------------------------
create table if not exists mine_sites (
  id                uuid primary key default gen_random_uuid(),
  code              text unique not null,
  name              text not null,
  district          text,
  state             text default 'Jharkhand',
  centroid_lat      double precision not null,
  centroid_lng      double precision not null,
  -- geo-mining parameters used by the subsidence model
  panel_depth_m     numeric  not null default 120,   -- H, depth of workings
  seam_thickness_m  numeric  not null default 3.0,   -- m
  extraction_ratio  numeric  not null default 0.65,  -- a, subsidence factor
  angle_of_draw_deg numeric  not null default 35,
  panel_geojson     jsonb,                            -- outline polygon
  created_at        timestamptz default now()
);
comment on column mine_sites.extraction_ratio is
  'Subsidence factor a: Smax = a * m * extraction efficiency (Indian bord-and-pillar depillaring ~0.5-0.7)';

-- ------------------------------------------------------------
-- 2. Sensor nodes (the surface mesh)
-- ------------------------------------------------------------
create table if not exists sensor_nodes (
  id                 uuid primary key default gen_random_uuid(),
  site_id            uuid references mine_sites(id) on delete cascade,
  node_code          text unique not null,            -- MG-01
  label              text,
  install_lat        double precision not null,
  install_lng        double precision not null,
  install_alt_m      numeric,
  -- commissioning baseline: subtracted from every reading
  baseline_roll_deg  numeric default 0,
  baseline_pitch_deg numeric default 0,
  baseline_yaw_deg   numeric default 0,
  baseline_lat       double precision,
  baseline_lng       double precision,
  baseline_at        timestamptz,
  mean_link_length_m numeric default 80,              -- for strain fallback
  mesh_role          text default 'node'
                     check (mesh_role in ('gateway','router','node')),
  radio              text default 'LoRa-SX1278',
  firmware           text default 'v0.9.1',
  status             text default 'online'
                     check (status in ('online','degraded','offline')),
  battery_v          numeric,
  rssi_dbm           integer,
  last_seen          timestamptz,
  created_at         timestamptz default now()
);
create index if not exists idx_nodes_site on sensor_nodes(site_id);

-- ------------------------------------------------------------
-- 3. Mesh links (relative distance between nodes)
--    This table is the heart of the "wireless surface mesh" hook.
-- ------------------------------------------------------------
create table if not exists node_links (
  id                  uuid primary key default gen_random_uuid(),
  site_id             uuid references mine_sites(id) on delete cascade,
  node_a              uuid not null references sensor_nodes(id) on delete cascade,
  node_b              uuid not null references sensor_nodes(id) on delete cascade,
  baseline_distance_m numeric not null,
  current_distance_m  numeric,
  delta_mm            numeric generated always as
                      ((current_distance_m - baseline_distance_m) * 1000) stored,
  strain_mm_per_m     numeric,     -- delta_mm / baseline_distance_m
  rssi_dbm            integer,
  updated_at          timestamptz default now(),
  constraint uniq_link unique (node_a, node_b),
  constraint no_self_link check (node_a <> node_b)
);
create index if not exists idx_links_a on node_links(node_a);
create index if not exists idx_links_b on node_links(node_b);

-- ------------------------------------------------------------
-- 4. Raw telemetry — exactly the hardware payload
-- ------------------------------------------------------------
create table if not exists sensor_readings (
  id                bigserial primary key,
  node_id           uuid not null references sensor_nodes(id) on delete cascade,
  ts                timestamptz not null default now(),
  -- orientation
  roll_rate          numeric,
  pitch_rate         numeric,
  yaw_rate           numeric,
  -- acceleration
  accel_x_g         numeric,
  accel_y_g         numeric,
  accel_z_g         numeric,
  accel_rms_g       numeric,
  -- vibration
  vibration_rms_g   numeric,
  vibration_peak_g  numeric,
  dominant_freq_hz  numeric,
  -- positioning
  gps_lat           double precision,
  gps_lng           double precision,
  gps_alt_m         numeric,
  hdop              numeric,
  satellites        integer,
  -- mesh geometry + cracks
  delta_distance_mm numeric,
  crack_width_mm    numeric,
  -- housekeeping
  battery_v         numeric,
  rssi_dbm          integer,
  temperature_c     numeric,
  ingest_source     text default 'gateway',
  raw               jsonb
);
create index if not exists idx_readings_node_ts on sensor_readings(node_id, ts desc);
create index if not exists idx_readings_ts      on sensor_readings(ts desc);

-- ------------------------------------------------------------
-- 5. AI output
-- ------------------------------------------------------------
create table if not exists anomaly_scores (
  id                bigserial primary key,
  node_id           uuid not null references sensor_nodes(id) on delete cascade,
  ts                timestamptz not null default now(),
  score             numeric not null check (score >= 0 and score <= 1),
  severity          text not null
                    check (severity in ('Low','Moderate','High','Critical')),
  tilt_delta_deg    numeric,
  tilt_rate_deg_hr  numeric,
  strain_mm_per_m   numeric,
  displacement_mm   numeric,
  vibration_rms_g   numeric,
  crack_width_mm    numeric,
  contributions     jsonb,               -- explainability: per-feature share
  forecast_24h      jsonb,               -- {strain, tilt, hours_to_threshold}
  model_version     text default 'mineguard-ewma-v1'
);
create index if not exists idx_scores_node_ts on anomaly_scores(node_id, ts desc);

-- ------------------------------------------------------------
-- 6. Early warning
-- ------------------------------------------------------------
create table if not exists alert_recipients (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid references mine_sites(id) on delete cascade,
  name          text not null,
  role          text not null,           -- 'Safety Officer', 'Mine Manager', 'DGMS'
  phone         text,                    -- E.164, e.g. +919812345678
  email         text,
  min_severity  text default 'High'
                check (min_severity in ('Moderate','High','Critical')),
  active        boolean default true,
  created_at    timestamptz default now()
);

create table if not exists alerts (
  id              uuid primary key default gen_random_uuid(),
  site_id         uuid references mine_sites(id) on delete cascade,
  node_id         uuid references sensor_nodes(id) on delete set null,
  severity        text not null
                  check (severity in ('Moderate','High','Critical')),
  score           numeric,
  title           text not null,
  body            text not null,
  channels        text[] default array['sms'],
  recipients      jsonb,                 -- snapshot of who was notified
  status          text default 'queued'
                  check (status in ('queued','sent','partial','failed','acknowledged')),
  provider_ref    text,
  error           text,
  triggered_by    text default 'auto',
  created_at      timestamptz default now(),
  sent_at         timestamptz,
  acknowledged_by text,
  acknowledged_at timestamptz
);
create index if not exists idx_alerts_created on alerts(created_at desc);

-- ------------------------------------------------------------
-- 7. GIS risk zones (generated polygons)
-- ------------------------------------------------------------
create table if not exists risk_zones (
  id           uuid primary key default gen_random_uuid(),
  site_id      uuid references mine_sites(id) on delete cascade,
  name         text,
  severity     text check (severity in ('Moderate','High','Critical')),
  geojson      jsonb not null,
  area_m2      numeric,
  generated_at timestamptz default now()
);

-- ------------------------------------------------------------
-- 8. Convenience views
-- ------------------------------------------------------------
create or replace view v_latest_reading as
select distinct on (node_id) *
from sensor_readings
order by node_id, ts desc;

create or replace view v_latest_score as
select distinct on (node_id) *
from anomaly_scores
order by node_id, ts desc;

create or replace view v_node_dashboard as
select
  n.id, n.site_id, n.node_code, n.label, n.mesh_role, n.status,
  n.install_lat, n.install_lng,
  n.baseline_roll_deg, n.baseline_pitch_deg, n.baseline_yaw_deg,
  n.baseline_lat, n.baseline_lng, n.mean_link_length_m,
  r.ts               as last_ts,
  r.roll_rate, r.pitch_rate, r.yaw_rate,
  r.accel_rms_g, r.vibration_rms_g, r.vibration_peak_g,
  r.gps_lat, r.gps_lng, r.hdop, r.satellites,
  r.delta_distance_mm, r.crack_width_mm,
  r.battery_v, r.rssi_dbm, r.temperature_c,
  s.score, s.severity, s.tilt_delta_deg, s.strain_mm_per_m,
  s.displacement_mm, s.contributions, s.forecast_24h
from sensor_nodes n
left join v_latest_reading r on r.node_id = n.id
left join v_latest_score   s on s.node_id = n.id;

-- ------------------------------------------------------------
-- 9. Housekeeping: mark stale nodes offline, prune old rows
-- ------------------------------------------------------------
create or replace function mark_stale_nodes() returns void
language sql as $$
  update sensor_nodes
     set status = case
                    when last_seen is null                     then 'offline'
                    when last_seen < now() - interval '2 min'  then 'offline'
                    when last_seen < now() - interval '30 sec' then 'degraded'
                    else 'online'
                  end;
$$;

create or replace function prune_readings(keep_days int default 7) returns void
language sql as $$
  delete from sensor_readings where ts < now() - (keep_days || ' days')::interval;
  delete from anomaly_scores  where ts < now() - (keep_days || ' days')::interval;
$$;

-- keep sensor_nodes.last_seen fresh on every insert
create or replace function touch_node() returns trigger
language plpgsql as $$
begin
  update sensor_nodes
     set last_seen = new.ts,
         battery_v = coalesce(new.battery_v, battery_v),
         rssi_dbm  = coalesce(new.rssi_dbm,  rssi_dbm),
         status    = 'online'
   where id = new.node_id;
  return new;
end;
$$;

drop trigger if exists trg_touch_node on sensor_readings;
create trigger trg_touch_node
after insert on sensor_readings
for each row execute function touch_node();

-- ------------------------------------------------------------
-- 10. Row Level Security
--     Prototype posture: anonymous READ everywhere (public safety
--     dashboard), WRITE only via service_role (gateway + scorer).
--     Acknowledging an alert is the one anon write we allow.
-- ------------------------------------------------------------
alter table mine_sites       enable row level security;
alter table sensor_nodes     enable row level security;
alter table node_links       enable row level security;
alter table sensor_readings  enable row level security;
alter table anomaly_scores   enable row level security;
alter table alerts           enable row level security;
alter table alert_recipients enable row level security;
alter table risk_zones       enable row level security;

do $$
declare t text;
begin
  foreach t in array array[
    'mine_sites','sensor_nodes','node_links','sensor_readings',
    'anomaly_scores','alerts','risk_zones'
  ] loop
    execute format(
      'drop policy if exists %I on %I; create policy %I on %I for select using (true);',
      'read_'||t, t, 'read_'||t, t);
  end loop;
end $$;

-- recipients hold phone numbers: never expose to anon
drop policy if exists read_recipients on alert_recipients;
create policy read_recipients on alert_recipients
  for select to authenticated using (true);

-- operator can acknowledge an alert from the dashboard
drop policy if exists ack_alert on alerts;
create policy ack_alert on alerts
  for update using (true)
  with check (status = 'acknowledged');

-- ------------------------------------------------------------
-- 11. Realtime
-- ------------------------------------------------------------
do $$
begin
  begin
    alter publication supabase_realtime add table sensor_readings;
  exception when others then null;
  end;
  begin
    alter publication supabase_realtime add table anomaly_scores;
  exception when others then null;
  end;
  begin
    alter publication supabase_realtime add table alerts;
  exception when others then null;
  end;
  begin
    alter publication supabase_realtime add table sensor_nodes;
  exception when others then null;
  end;
  begin
    alter publication supabase_realtime add table node_links;
  exception when others then null;
  end;
end $$;

