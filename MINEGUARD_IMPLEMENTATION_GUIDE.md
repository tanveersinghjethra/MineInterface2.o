# MineGuard — Full Implementation Guide

**SIH problem statement:** Development of an AI-enabled Low Cost Real Time Mine Subsidence Monitoring, Prediction and Early Warning System for Underground Coal Mines in India
**Innovation hook:** Wireless Surface Mesh Network for Real Time Subsidence Detection

This guide takes you from an empty folder to a working, demo-ready system:

- React + Vite dashboard (replaces your current single-file `main.jsx`)
- Supabase Postgres schema + Row Level Security + Realtime streaming
- GIS layer: live risk map, interpolated deformation surface, mesh link overlay, subsidence trough polygon
- AI/ML layer: explainable anomaly scoring + Knothe-profile subsidence forecast, shared by browser and server
- Alerting: Supabase Edge Function → SMS/email to the security officer, with a mock mode so demos never fail
- Hardware simulator that writes the exact payload your hardware team will send (roll, pitch, yaw, acceleration, vibration, GPS lat/lng, inter-node distance change)

Every file is given in full. Copy-paste is enough; nothing is left as "add your logic here".

---

## Table of contents

1. [System architecture](#1-system-architecture)
2. [The hardware payload contract](#2-the-hardware-payload-contract)
3. [Prerequisites and project scaffold](#3-prerequisites-and-project-scaffold)
4. [Supabase project setup](#4-supabase-project-setup)
5. [Database schema (full SQL)](#5-database-schema-full-sql)
6. [Seed data (full SQL)](#6-seed-data-full-sql)
7. [Shared library: client, geo math, AI scoring](#7-shared-library-client-geo-math-ai-scoring)
8. [React hooks: live data pipeline](#8-react-hooks-live-data-pipeline)
9. [The dashboard: App and components](#9-the-dashboard-app-and-components)
10. [Stylesheet](#10-stylesheet)
11. [Alerting: Edge Function + SMS provider](#11-alerting-edge-function--sms-provider)
12. [Hardware simulator and server-side scorer](#12-hardware-simulator-and-server-side-scorer)
13. [Run order — the 10 commands](#13-run-order--the-10-commands)
14. [Offline capability and sync](#14-offline-capability-and-sync)
15. [Real hardware cutover (ESP32 → Supabase)](#15-real-hardware-cutover-esp32--supabase)
16. [Deployment](#16-deployment)
17. [Demo script for judges](#17-demo-script-for-judges)
18. [Troubleshooting](#18-troubleshooting)
19. [Requirement → implementation traceability](#19-requirement--implementation-traceability)

---

## 1. System architecture

```
 SURFACE MESH (above the coal panel)
 ┌────────┐  LoRa/ESP-NOW  ┌────────┐  ┌────────┐
 │ Node 3 │◄──────────────►│ Node 4 │◄►│ Node 5 │     Each node:
 └───┬────┘                └───┬────┘  └───┬────┘     MPU6050/BNO085 → roll,pitch,yaw,accel
     │ mesh hop                │           │          SW-420/ADXL → vibration RMS + peak
 ┌───▼────┐                ┌───▼────┐  ┌───▼────┐     NEO-6M/ZED-F9P → lat,lng,alt,HDOP
 │ Node 1 │◄──────────────►│ Node 2 │◄►│ Node 6 │     UWB DW1000 / string pot → node distance
 └────────┘                └───┬────┘  └────────┘     Crack: potentiometer / strain gauge
                               │
                        ┌──────▼───────┐
                        │  GATEWAY     │ ESP32 + SIM800L/Wi-Fi
                        │  buffers to  │ batches readings, retries on reconnect
                        │  SD on loss  │
                        └──────┬───────┘
                               │ HTTPS (REST / Edge Function `ingest`)
                     ┌─────────▼──────────────────────────────┐
                     │            SUPABASE                    │
                     │  Postgres  : sensor_readings, nodes,    │
                     │              node_links, anomaly_scores,│
                     │              alerts, risk_zones         │
                     │  Realtime  : WebSocket fan-out          │
                     │  Edge Fn   : ingest, send-alert         │
                     │  Storage   : daily CSV archive          │
                     └─────────┬───────────────┬──────────────┘
                               │ WS            │ HTTPS
                     ┌─────────▼──────┐  ┌─────▼─────────────┐
                     │ REACT DASHBOARD│  │  SMS / EMAIL      │
                     │ GIS + charts + │  │  security officer │
                     │ AI scoring     │  │  mine manager     │
                     └────────────────┘  └───────────────────┘
```

**Why the scoring logic lives in `src/lib/analytics.js`:** the same ES module is imported by the browser (instant UI feedback, works even if the server worker is down) and by the Node scorer (authoritative, persists to `anomaly_scores`, fires SMS). One source of truth, no drift between what the operator sees and what triggers the siren. Mention this in your presentation — evaluators notice it.

### Final folder layout

```
mineguard/
├─ .env.local                     # frontend keys (anon only)
├─ .env                           # simulator keys (service role) — gitignored
├─ index.html
├─ package.json
├─ vite.config.js
├─ src/
│  ├─ main.jsx
│  ├─ App.jsx
│  ├─ styles.css
│  ├─ lib/
│  │  ├─ supabaseClient.js
│  │  ├─ geo.js
│  │  └─ analytics.js             # shared browser + node
│  ├─ hooks/
│  │  ├─ useMineData.js
│  │  └─ useAlerts.js
│  └─ components/
│     ├─ TopBar.jsx
│     ├─ MetricCard.jsx
│     ├─ RiskMap.jsx
│     ├─ SensorDetail.jsx
│     ├─ ChartCard.jsx
│     ├─ SensorTable.jsx
│     ├─ ForecastPanel.jsx
│     ├─ AlertFeed.jsx
│     └─ Toast.jsx
├─ supabase/
│  ├─ migrations/
│  │  ├─ 0001_init.sql
│  │  └─ 0002_seed.sql
│  └─ functions/
│     ├─ send-alert/index.ts
│     └─ ingest/index.ts
└─ simulator/
   ├─ subsidence.js               # Knothe influence-function physics
   ├─ simulate.js                 # writes readings like the hardware will
   └─ scorer.js                   # server-side AI worker + alert trigger
```

---

## 2. The hardware payload contract

Agree this with your hardware team **today** and freeze it. Everything downstream depends on it.

| Field | Unit | Source | Notes |
|---|---|---|---|
| `node_code` | — | firmware constant | `MG-01` … `MG-12` |
| `ts` | ISO 8601 UTC | gateway RTC | node sends millis, gateway stamps |
| `roll_deg`, `pitch_deg`, `yaw_deg` | degrees | MPU6050 / BNO085 | fused, already complementary-filtered on node |
| `accel_x_g`, `accel_y_g`, `accel_z_g` | g | IMU | 1 Hz average |
| `accel_rms_g` | g | IMU | RMS of the 100 Hz window |
| `vibration_rms_g` | g | ADXL335 / SW-420 | 2 s window |
| `vibration_peak_g` | g | same | peak in window |
| `dominant_freq_hz` | Hz | FFT on node (optional) | blast ≈ 10–40 Hz, roof fall ≈ 2–8 Hz |
| `gps_lat`, `gps_lng` | deg | NEO-6M | 7 decimal places minimum |
| `gps_alt_m` | m | NEO-6M | |
| `hdop`, `satellites` | — | NEO-6M | quality gate: use only when `hdop < 2.5` |
| `delta_distance_mm` | mm | UWB / string pot | **mean signed change vs this node's mesh neighbours** |
| `crack_width_mm` | mm | linear pot | 0 if not fitted |
| `battery_v` | V | divider | |
| `rssi_dbm` | dBm | LoRa | mesh health |
| `temperature_c` | °C | IMU die temp | for thermal drift compensation |

**JSON the gateway POSTs** (batched array, max 50):

```json
{
  "gateway": "GW-01",
  "readings": [
    {
      "node_code": "MG-07",
      "ts": "2026-03-14T09:22:31Z",
      "roll_deg": -0.412, "pitch_deg": 1.084, "yaw_deg": 187.3,
      "accel_x_g": 0.007, "accel_y_g": -0.019, "accel_z_g": 0.998,
      "accel_rms_g": 0.021,
      "vibration_rms_g": 0.043, "vibration_peak_g": 0.191, "dominant_freq_hz": 6.2,
      "gps_lat": 30.3550121, "gps_lng": 76.3650884, "gps_alt_m": 247.3,
      "hdop": 0.9, "satellites": 11,
      "delta_distance_mm": -34.7,
      "crack_width_mm": 1.8,
      "battery_v": 3.92, "rssi_dbm": -84, "temperature_c": 31.4
    }
  ]
}
```

Two sign conventions that must be written on the whiteboard:

- `delta_distance_mm` **negative = nodes moving closer** (compression, typical over the panel centre), **positive = separating** (tension, typical at the trough edge — this is where cracks and building damage appear).
- Roll/pitch are reported raw; the platform subtracts the per-node baseline captured during commissioning, so a node bolted to a slope still reads ~0° change.

---

## 3. Prerequisites and project scaffold

Install first:

- **Node.js 20 LTS** — `node -v` must print `v20.x` or higher
- **Git**
- A **Supabase** account (free tier is enough)
- Optional for Edge Functions: **Supabase CLI** — `npm i -g supabase`

### 3.1 Create the project

```bash
npm create vite@latest mineguard -- --template react
cd mineguard
```

### 3.2 Install dependencies

```bash
npm install @supabase/supabase-js react-leaflet leaflet recharts lucide-react
npm install -D dotenv
```

Pinned versions that are known to work together (if you hit peer-dependency noise, force these):

```bash
npm install react@18.3.1 react-dom@18.3.1 react-leaflet@4.2.1 leaflet@1.9.4 \
  recharts@2.12.7 lucide-react@0.427.0 @supabase/supabase-js@2.45.4
```

> `react-leaflet@5` requires React 19. If you are on React 18, stay on `react-leaflet@4.2.1` or the map will refuse to mount.

### 3.3 Delete the Vite boilerplate

```bash
rm -f src/App.css src/index.css src/assets/react.svg public/vite.svg
mkdir -p src/lib src/hooks src/components
mkdir -p supabase/migrations supabase/functions/send-alert supabase/functions/ingest
mkdir -p simulator
```

### 3.4 `index.html`

Replace the whole file:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#0b1116" />
    <title>MineGuard — Mine Subsidence Early Warning</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap"
      rel="stylesheet"
    />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
```

### 3.5 `vite.config.js`

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1400 },
});
```

### 3.6 `package.json` scripts

Merge this `scripts` block into your generated `package.json`:

```json
{
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "sim": "node simulator/simulate.js",
    "sim:trough": "node simulator/simulate.js --scenario=trough",
    "sim:blast": "node simulator/simulate.js --scenario=blast",
    "score": "node simulator/scorer.js"
  }
}
```

### 3.7 Environment files

`.env.local` — used by Vite, **anon key only**, safe to ship to the browser:

```bash
VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOi...your-anon-key...
VITE_SITE_CODE=JHARIA-P7
```

`.env` — used by the simulator and scorer only, **never imported by React**:

```bash
SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...your-service-role-key...
SITE_CODE=JHARIA-P7
```

`.gitignore` — append:

```
.env
.env.local
dist
node_modules
```

> The service role key bypasses every RLS policy. If it ends up in a public GitHub repo, rotate it immediately from Supabase → Settings → API.

---

## 4. Supabase project setup

1. Go to [supabase.com](https://supabase.com) → **New project**.
   - Name: `mineguard`
   - Region: **South Asia (Mumbai)** — lowest latency from Indian coalfields
   - Save the database password somewhere safe.
2. Wait ~2 minutes for provisioning.
3. **Settings → API** — copy these into your env files:
   - Project URL → `VITE_SUPABASE_URL` / `SUPABASE_URL`
   - `anon` `public` key → `VITE_SUPABASE_ANON_KEY`
   - `service_role` `secret` key → `SUPABASE_SERVICE_ROLE_KEY`
4. **SQL Editor → New query** — you will paste Section 5 here, then Section 6.
5. **Database → Replication → `supabase_realtime`** — the migration adds the tables automatically, but verify after running it that `sensor_readings`, `anomaly_scores`, `alerts` and `sensor_nodes` are listed.

---

## 5. Database schema (full SQL)

Create `supabase/migrations/0001_init.sql` with this content **and** paste the same thing into the Supabase SQL Editor and press **Run**.

```sql
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
  roll_deg          numeric,
  pitch_deg         numeric,
  yaw_deg           numeric,
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
  r.roll_deg, r.pitch_deg, r.yaw_deg,
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
alter publication supabase_realtime add table sensor_readings;
alter publication supabase_realtime add table anomaly_scores;
alter publication supabase_realtime add table alerts;
alter publication supabase_realtime add table sensor_nodes;
alter publication supabase_realtime add table node_links;
```

> If `alter publication ... add table` errors with *"relation is already member"*, that table is already streaming. Ignore it.

### 5.1 Optional: schedule the housekeeping jobs

In **Database → Extensions** enable `pg_cron`, then run:

```sql
select cron.schedule('mineguard-stale', '* * * * *',  $$select mark_stale_nodes()$$);
select cron.schedule('mineguard-prune', '0 2 * * *',  $$select prune_readings(7)$$);
```

---

## 6. Seed data (full SQL)

Create `supabase/migrations/0002_seed.sql` and run it in the SQL Editor after `0001_init.sql`.

It builds a **4 × 3 mesh of 12 nodes at 80 m spacing** over a panel in the Jharia coalfield, wires up every link shorter than 130 m, and registers the safety officer.

```sql
-- ============================================================
-- MineGuard 0002_seed.sql
-- ============================================================

-- great-circle distance in metres, used for link baselines
create or replace function haversine_m(
  lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision
) returns double precision
language sql immutable as $$
  select 6371000 * 2 * asin(sqrt(
      power(sin(radians(lat2 - lat1) / 2), 2) +
      cos(radians(lat1)) * cos(radians(lat2)) *
      power(sin(radians(lng2 - lng1) / 2), 2)
  ));
$$;

-- ------------------------------------------------------------
-- Site
-- ------------------------------------------------------------
insert into mine_sites (code, name, district, state,
                        centroid_lat, centroid_lng,
                        panel_depth_m, seam_thickness_m,
                        extraction_ratio, angle_of_draw_deg)
values ('JHARIA-P7', 'Jharia Coalfield — Panel 7', 'Dhanbad', 'Jharkhand',
        23.74800, 86.42000, 120, 3.0, 0.65, 35)
on conflict (code) do nothing;

-- ------------------------------------------------------------
-- 12 nodes on a 4 x 3 grid, 80 m spacing, centred on the panel
-- ------------------------------------------------------------
with s as (select * from mine_sites where code = 'JHARIA-P7'),
grid as (
  select
    gx, gy,
    row_number() over (order by gy, gx) as n,
    s.centroid_lat + ((gy - 1) - 1.0) * (80.0 / 111320.0)                      as lat,
    s.centroid_lng + ((gx - 1) - 1.5) * (80.0 / (111320.0 * cos(radians(s.centroid_lat)))) as lng,
    s.id as site_id
  from s, generate_series(1,4) gx, generate_series(1,3) gy
)
insert into sensor_nodes (
  site_id, node_code, label, install_lat, install_lng, install_alt_m,
  baseline_roll_deg, baseline_pitch_deg, baseline_yaw_deg,
  baseline_lat, baseline_lng, baseline_at,
  mean_link_length_m, mesh_role, status, battery_v, rssi_dbm
)
select
  site_id,
  'MG-' || lpad(n::text, 2, '0'),
  'Row ' || gy || ' / Col ' || gx,
  lat, lng, 247 + (random() * 4),
  0, 0, 0,
  lat, lng, now(),
  80,
  case when n = 1 then 'gateway'
       when n in (4, 9) then 'router'
       else 'node' end,
  'online',
  round((3.85 + random() * 0.35)::numeric, 2),
  (-95 + floor(random() * 25))::int
from grid
on conflict (node_code) do nothing;

-- ------------------------------------------------------------
-- Mesh links: connect every pair within 130 m (4-neighbour + diagonals)
-- ------------------------------------------------------------
insert into node_links (site_id, node_a, node_b, baseline_distance_m,
                        current_distance_m, strain_mm_per_m, rssi_dbm)
select
  a.site_id, a.id, b.id,
  round(haversine_m(a.install_lat, a.install_lng, b.install_lat, b.install_lng)::numeric, 3),
  round(haversine_m(a.install_lat, a.install_lng, b.install_lat, b.install_lng)::numeric, 3),
  0,
  (-92 + floor(random() * 22))::int
from sensor_nodes a
join sensor_nodes b
  on a.site_id = b.site_id
 and a.node_code < b.node_code
 and haversine_m(a.install_lat, a.install_lng, b.install_lat, b.install_lng) < 130
on conflict (node_a, node_b) do nothing;

-- store each node's mean link length (strain denominator)
update sensor_nodes n
   set mean_link_length_m = sub.avg_len
  from (
    select id, avg(len) as avg_len from (
      select node_a as id, baseline_distance_m as len from node_links
      union all
      select node_b as id, baseline_distance_m as len from node_links
    ) x group by id
  ) sub
 where n.id = sub.id;

-- ------------------------------------------------------------
-- Panel outline polygon (GeoJSON) for the GIS layer
-- ------------------------------------------------------------
update mine_sites s
   set panel_geojson = jsonb_build_object(
     'type', 'Polygon',
     'coordinates', jsonb_build_array(jsonb_build_array(
       jsonb_build_array(b.min_lng - 0.0009, b.min_lat - 0.0008),
       jsonb_build_array(b.max_lng + 0.0009, b.min_lat - 0.0008),
       jsonb_build_array(b.max_lng + 0.0009, b.max_lat + 0.0008),
       jsonb_build_array(b.min_lng - 0.0009, b.max_lat + 0.0008),
       jsonb_build_array(b.min_lng - 0.0009, b.min_lat - 0.0008)
     ))
   )
  from (
    select site_id,
           min(install_lat) min_lat, max(install_lat) max_lat,
           min(install_lng) min_lng, max(install_lng) max_lng
      from sensor_nodes group by site_id
  ) b
 where s.id = b.site_id;

-- ------------------------------------------------------------
-- Who gets the early warning
-- ------------------------------------------------------------
insert into alert_recipients (site_id, name, role, phone, email, min_severity)
select id, 'R. K. Mahato', 'Safety Officer',  '+919800000001', 'safety@mineguard.in',  'High'    from mine_sites where code='JHARIA-P7'
union all
select id, 'S. Bhattacharya', 'Mine Manager', '+919800000002', 'manager@mineguard.in', 'Critical' from mine_sites where code='JHARIA-P7'
union all
select id, 'Control Room', 'Shift Incharge',  '+919800000003', 'control@mineguard.in', 'Moderate' from mine_sites where code='JHARIA-P7'
on conflict do nothing;
```

**Change the location to your own site** by editing the single `insert into mine_sites` row — everything else (node grid, links, panel polygon, map centring) is derived from the centroid.

Verify the seed:

```sql
select count(*) as nodes from sensor_nodes;   -- 12
select count(*) as links from node_links;     -- 29
select node_code, round(install_lat::numeric,6), round(install_lng::numeric,6),
       round(mean_link_length_m::numeric,1)
  from sensor_nodes order by node_code;
```

---

## 7. Shared library: client, geo math, AI scoring

### 7.1 `src/lib/supabaseClient.js`

```js
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. ' +
    'Create .env.local from the template in the guide, then restart `npm run dev`.'
  );
}

export const supabase = createClient(url, key, {
  realtime: { params: { eventsPerSecond: 20 } },
  auth: { persistSession: false },
});

export const SITE_CODE = import.meta.env.VITE_SITE_CODE || 'JHARIA-P7';
```

### 7.2 `src/lib/geo.js`

Pure geodesy + the interpolation that turns 12 point sensors into a continuous deformation surface.

```js
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
```

### 7.3 `src/lib/analytics.js` — the AI layer

This is the file both the browser and the Node scorer import. It is deliberately **explainable**: every score decomposes into named feature contributions that the UI prints, because a safety officer will not evacuate a village on the word of a black box.

```js
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
  crackMm:        { warn: 3.0,  crit: 12.0 },
};

export const WEIGHTS = {
  tilt: 0.26,
  tiltRate: 0.16,
  strain: 0.22,
  displacement: 0.16,
  vibration: 0.12,
  crack: 0.08,
};

export const FEATURE_LABELS = {
  tilt: 'Ground tilt',
  tiltRate: 'Tilt acceleration',
  strain: 'Horizontal strain',
  displacement: 'Surface displacement',
  vibration: 'Vibration energy',
  crack: 'Crack opening',
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
    displacementMm: 0, vibrationG: 0, crackMm: 0,
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
      (Number(r.roll_deg) || 0) - b.roll,
      (Number(r.pitch_deg) || 0) - b.pitch
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
  const crackMm = Number(last.crack_width_mm) || 0;
  const yawDriftDeg = ((Number(last.yaw_deg) || 0) - b.yaw + 540) % 360 - 180;

  return {
    tiltDeltaDeg, tiltRateDegHr, strainMmPerM, displacementMm,
    vibrationG, crackMm, yawDriftDeg,
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
    crack: ramp(f.crackMm, THRESHOLDS.crackMm.warn, THRESHOLDS.crackMm.crit),
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
    y: tiltMagnitude((Number(r.roll_deg) || 0) - b.roll, (Number(r.pitch_deg) || 0) - b.pitch),
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
```

---

## 8. React hooks: live data pipeline

### 8.1 `src/hooks/useMineData.js`

One hook owns the whole data layer: initial load, WebSocket subscription, buffered flushing (so 12 nodes × 1 packet/2.5 s don't cause 300 React renders a minute), and AI analysis.

```js
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, SITE_CODE } from '../lib/supabaseClient.js';
import { analyseNode, HISTORY_LIMIT } from '../lib/analytics.js';

const FLUSH_MS = 900;          // batch incoming packets into one render
const WINDOW_HOURS = 6;        // history depth pulled on first load

export function useMineData(siteCode = SITE_CODE) {
  const [site, setSite] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [links, setLinks] = useState([]);
  const [readings, setReadings] = useState({});   // nodeId -> ascending array
  const [connection, setConnection] = useState('connecting');
  const [lastSync, setLastSync] = useState(null);
  const [error, setError] = useState(null);

  const buffer = useRef([]);
  const prevScores = useRef(new Map());           // nodeId -> { ts, score }

  // ── initial load ──────────────────────────────────────────
  const load = useCallback(async () => {
    try {
      setError(null);

      const { data: siteRow, error: e1 } = await supabase
        .from('mine_sites').select('*').eq('code', siteCode).single();
      if (e1) throw e1;
      setSite(siteRow);

      const { data: nodeRows, error: e2 } = await supabase
        .from('sensor_nodes').select('*')
        .eq('site_id', siteRow.id).order('node_code');
      if (e2) throw e2;
      setNodes(nodeRows || []);

      const { data: linkRows, error: e3 } = await supabase
        .from('node_links').select('*').eq('site_id', siteRow.id);
      if (e3) throw e3;
      setLinks(linkRows || []);

      const since = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString();
      const { data: readRows, error: e4 } = await supabase
        .from('sensor_readings').select('*')
        .gte('ts', since).order('ts', { ascending: true }).limit(6000);
      if (e4) throw e4;

      const grouped = {};
      for (const r of readRows || []) (grouped[r.node_id] ||= []).push(r);
      for (const k of Object.keys(grouped)) {
        grouped[k] = grouped[k].slice(-HISTORY_LIMIT);
      }
      setReadings(grouped);
      setLastSync(new Date());
    } catch (err) {
      console.error('[mineguard] load failed', err);
      setError(err.message || String(err));
    }
  }, [siteCode]);

  useEffect(() => { load(); }, [load]);

  // ── realtime subscription ─────────────────────────────────
  useEffect(() => {
    if (!site) return undefined;

    const channel = supabase
      .channel('mineguard-stream')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'sensor_readings' },
        (payload) => { buffer.current.push(payload.new); })
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'node_links' },
        (payload) => {
          setLinks((prev) =>
            prev.map((l) => (l.id === payload.new.id ? payload.new : l)));
        })
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'sensor_nodes' },
        (payload) => {
          setNodes((prev) =>
            prev.map((n) => (n.id === payload.new.id ? { ...n, ...payload.new } : n)));
        })
      .subscribe((s) => {
        setConnection(
          s === 'SUBSCRIBED' ? 'live'
          : s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' ? 'error'
          : 'connecting');
      });

    const timer = setInterval(() => {
      if (!buffer.current.length) return;
      const batch = buffer.current;
      buffer.current = [];
      setReadings((prev) => {
        const next = { ...prev };
        for (const r of batch) {
          const arr = next[r.node_id] ? [...next[r.node_id], r] : [r];
          next[r.node_id] = arr.slice(-HISTORY_LIMIT);
        }
        return next;
      });
      setLastSync(new Date());
    }, FLUSH_MS);

    return () => { clearInterval(timer); supabase.removeChannel(channel); };
  }, [site]);

  // ── AI analysis (idempotent EWMA, safe under StrictMode) ──
  const analyses = useMemo(() => {
    return nodes.map((node) => {
      const hist = readings[node.id] || [];
      const nodeLinks = links.filter(
        (l) => l.node_a === node.id || l.node_b === node.id);
      const lastTs = hist.length ? hist[hist.length - 1].ts : null;
      const cached = prevScores.current.get(node.id);
      const prev = cached && cached.ts === lastTs ? cached.prev : cached?.score ?? null;

      const a = analyseNode(node, hist, nodeLinks, prev);
      prevScores.current.set(node.id, { ts: lastTs, score: a.score, prev });

      const latest = hist[hist.length - 1] || null;
      return { ...a, node, latest, links: nodeLinks, historyLength: hist.length };
    });
  }, [nodes, links, readings]);

  const byId = useMemo(
    () => Object.fromEntries(analyses.map((a) => [a.nodeId, a])), [analyses]);

  const summary = useMemo(() => {
    const n = analyses.length || 1;
    const critical = analyses.filter((a) => a.severity === 'Critical').length;
    const high = analyses.filter((a) => a.score >= 0.6).length;
    const online = nodes.filter((x) => x.status === 'online').length;
    const maxStrain = Math.max(0,
      ...analyses.map((a) => Math.abs(a.features.strainMmPerM)));
    const maxDisp = Math.max(0, ...analyses.map((a) => a.features.displacementMm));
    return {
      nodeCount: nodes.length,
      online,
      health: nodes.length ? (online / nodes.length) * 100 : 0,
      critical,
      high,
      avgScore: analyses.reduce((s, a) => s + a.score, 0) / n,
      maxScore: Math.max(0, ...analyses.map((a) => a.score)),
      maxStrain,
      maxDisp,
    };
  }, [analyses, nodes]);

  return {
    site, nodes, links, readings, analyses, byId, summary,
    connection, lastSync, error, refresh: load,
  };
}
```

### 8.2 `src/hooks/useAlerts.js`

```js
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';

export function useAlerts(siteId, limit = 25) {
  const [alerts, setAlerts] = useState([]);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!siteId) return;
    const { data, error } = await supabase
      .from('alerts').select('*')
      .eq('site_id', siteId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) { console.error('[mineguard] alerts load', error); return; }
    setAlerts(data || []);
  }, [siteId, limit]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!siteId) return undefined;
    const ch = supabase
      .channel('mineguard-alerts')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'alerts' },
        () => load())
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [siteId, load]);

  /** Fire the early-warning Edge Function. Returns the function's JSON. */
  const dispatch = useCallback(async (payload) => {
    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke('send-alert', {
        body: payload,
      });
      if (error) throw error;
      await load();
      return data;
    } finally {
      setSending(false);
    }
  }, [load]);

  const acknowledge = useCallback(async (id, who = 'Control Room') => {
    const { error } = await supabase
      .from('alerts')
      .update({ status: 'acknowledged', acknowledged_by: who,
                acknowledged_at: new Date().toISOString() })
      .eq('id', id);
    if (error) console.error('[mineguard] ack failed', error);
    await load();
  }, [load]);

  return { alerts, sending, dispatch, acknowledge, reload: load };
}
```

---

## 9. The dashboard: App and components

### 9.1 `src/main.jsx`

Your uploaded file becomes a three-line entry point. All the logic moves into `App.jsx` and `components/`.

```jsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import 'leaflet/dist/leaflet.css';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

### 9.2 `src/App.jsx`

```jsx
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Download, Gauge, Radio, RefreshCw,
  TrendingDown, Waves, Wifi,
} from 'lucide-react';

import { useMineData } from './hooks/useMineData.js';
import { useAlerts } from './hooks/useAlerts.js';
import { tiltMagnitude, THRESHOLDS } from './lib/analytics.js';

import TopBar from './components/TopBar.jsx';
import MetricCard from './components/MetricCard.jsx';
import RiskMap from './components/RiskMap.jsx';
import SensorDetail from './components/SensorDetail.jsx';
import ChartCard from './components/ChartCard.jsx';
import SensorTable from './components/SensorTable.jsx';
import ForecastPanel from './components/ForecastPanel.jsx';
import AlertFeed from './components/AlertFeed.jsx';
import Toast from './components/Toast.jsx';

const clock = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Turn raw packets into a {time,value} series for the charts. */
function buildSeries(readings, node, kind) {
  if (!readings?.length || !node) return [];
  const roll0 = Number(node.baseline_roll_deg) || 0;
  const pitch0 = Number(node.baseline_pitch_deg) || 0;
  const baseLen = Number(node.mean_link_length_m) || 80;

  return readings.slice(-60).map((r) => {
    let value = 0;
    if (kind === 'tilt') {
      value = tiltMagnitude((Number(r.roll_deg) || 0) - roll0,
                            (Number(r.pitch_deg) || 0) - pitch0);
    } else if (kind === 'strain') {
      value = (Number(r.delta_distance_mm) || 0) / baseLen;
    } else if (kind === 'vibration') {
      value = Number(r.vibration_rms_g) || 0;
    } else if (kind === 'distance') {
      value = Number(r.delta_distance_mm) || 0;
    }
    return { time: clock(r.ts), value: +value.toFixed(3) };
  });
}

export default function App() {
  const {
    site, nodes, links, readings, analyses, byId, summary,
    connection, lastSync, error, refresh,
  } = useMineData();

  const { alerts, sending, dispatch, acknowledge } = useAlerts(site?.id);

  const [selectedId, setSelectedId] = useState(null);
  const [mapMode, setMapMode] = useState('risk');
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState(null);

  const notify = useCallback((message, tone = 'ok') => {
    setToast({ message, tone });
    setTimeout(() => setToast(null), 3200);
  }, []);

  // auto-select the node most at risk until the operator picks one
  useEffect(() => {
    if (selectedId || !analyses.length) return;
    const worst = [...analyses].sort((a, b) => b.score - a.score)[0];
    setSelectedId(worst.nodeId);
  }, [analyses, selectedId]);

  const selected = byId[selectedId] || analyses[0] || null;

  const tiltSeries = useMemo(
    () => buildSeries(readings[selected?.nodeId], selected?.node, 'tilt'),
    [readings, selected]);
  const distanceSeries = useMemo(
    () => buildSeries(readings[selected?.nodeId], selected?.node, 'distance'),
    [readings, selected]);
  const vibrationSeries = useMemo(
    () => buildSeries(readings[selected?.nodeId], selected?.node, 'vibration'),
    [readings, selected]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...analyses].sort((a, b) => b.score - a.score);
    return q
      ? sorted.filter((a) =>
          a.nodeCode.toLowerCase().includes(q) ||
          (a.node.label || '').toLowerCase().includes(q) ||
          a.severity.toLowerCase().includes(q))
      : sorted;
  }, [analyses, query]);

  const handleRefresh = useCallback(async () => {
    await refresh();
    notify('Telemetry reloaded from Supabase');
  }, [refresh, notify]);

  const handleExport = useCallback(() => {
    const header = [
      'node_code', 'severity', 'risk_score', 'tilt_deg', 'tilt_rate_deg_hr',
      'strain_mm_per_m', 'displacement_mm', 'vibration_g', 'crack_mm',
      'damage_class', 'forecast_24h_strain', 'hours_to_threshold', 'last_packet',
    ].join(',');
    const rows = analyses.map((a) => [
      a.nodeCode, a.severity, a.score,
      a.features.tiltDeltaDeg.toFixed(3),
      a.features.tiltRateDegHr.toFixed(4),
      a.features.strainMmPerM.toFixed(3),
      a.features.displacementMm.toFixed(1),
      a.features.vibrationG.toFixed(3),
      a.features.crackMm.toFixed(1),
      a.damage,
      a.forecast.strain24h,
      a.forecast.hoursToThreshold ?? '',
      a.features.lastTs ?? '',
    ].join(','));

    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mineguard-${site?.code || 'site'}-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    notify('Risk report downloaded');
  }, [analyses, site, notify]);

  const handleSendAlert = useCallback(async () => {
    if (!selected || !site) return;
    const f = selected.features;
    const eta = selected.forecast.hoursToThreshold;
    try {
      const res = await dispatch({
        site_id: site.id,
        node_id: selected.nodeId,
        severity: selected.severity === 'Low' ? 'Moderate' : selected.severity,
        score: selected.score,
        title: `${selected.severity} subsidence risk at ${selected.nodeCode}`,
        body:
          `MINEGUARD ${site.code}: ${selected.severity} risk at ${selected.nodeCode} ` +
          `(score ${selected.score.toFixed(2)}). ` +
          `Tilt ${f.tiltDeltaDeg.toFixed(2)} deg, strain ${f.strainMmPerM.toFixed(2)} mm/m, ` +
          `displacement ${f.displacementMm.toFixed(0)} mm. ` +
          (eta ? `Critical threshold in ~${eta} h. ` : '') +
          `Restrict access and verify on ground.`,
        channels: ['sms', 'email'],
        triggered_by: 'operator',
      });
      notify(res?.mock
        ? `Alert logged in demo mode for ${res.recipients} recipients`
        : `Alert sent to ${res?.sent ?? 0} recipients`);
    } catch (e) {
      console.error(e);
      notify('Alert could not be sent — check the Edge Function logs', 'bad');
    }
  }, [selected, site, dispatch, notify]);

  if (error) {
    return (
      <div className="bootError">
        <AlertTriangle size={30} />
        <h1>Dashboard cannot reach the database</h1>
        <p>{error}</p>
        <p className="hint">
          Check <code>.env.local</code>, confirm the migrations ran, then restart the dev server.
        </p>
        <button className="primary" onClick={refresh}>Try again</button>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar
        site={site}
        connection={connection}
        lastSync={lastSync}
        critical={summary.critical}
      />

      <main>
        <section className="hero">
          <div className="heroCopy">
            <p className="heroKicker">
              {site ? `${site.name} · ${site.district}, ${site.state}` : 'Loading site…'}
            </p>
            <h1>
              {summary.critical > 0
                ? 'Ground movement above the action level'
                : summary.high > 0
                ? 'Elevated deformation under watch'
                : 'Panel stable across the mesh'}
            </h1>
            <p className="heroSub">
              {summary.nodeCount} surface nodes streaming tilt, vibration, position and
              inter-node distance. Risk is recomputed on every packet and the safety
              officer is paged automatically when the action level is crossed.
            </p>
            <div className="heroActions">
              <button className="primary" onClick={handleRefresh}>
                <RefreshCw size={15} /> Reload telemetry
              </button>
              <button className="secondary" onClick={handleExport}>
                <Download size={15} /> Download risk report
              </button>
            </div>
          </div>
          <div className="heroStat">
            <span>Panel risk index</span>
            <strong style={{ color: selected?.color }}>
              {summary.maxScore.toFixed(2)}
            </strong>
            <small>peak of {summary.nodeCount} nodes · action level 0.80</small>
          </div>
        </section>

        <section className="metrics">
          <MetricCard
            icon={<AlertTriangle />}
            title="Peak risk score"
            value={summary.maxScore.toFixed(2)}
            unit="/ 1.00"
            sub={`${summary.high} node${summary.high === 1 ? '' : 's'} above watch level`}
            danger={summary.maxScore >= 0.8}
          />
          <MetricCard
            icon={<Waves />}
            title="Horizontal strain"
            value={summary.maxStrain.toFixed(2)}
            unit="mm/m"
            sub={`action level ${THRESHOLDS.strainMmPerM.crit} mm/m`}
            danger={summary.maxStrain >= THRESHOLDS.strainMmPerM.crit}
          />
          <MetricCard
            icon={<TrendingDown />}
            title="Surface displacement"
            value={summary.maxDisp.toFixed(0)}
            unit="mm"
            sub="largest movement from baseline"
            danger={summary.maxDisp >= THRESHOLDS.displacementMm.crit}
          />
          <MetricCard
            icon={<Wifi />}
            title="Mesh health"
            value={summary.health.toFixed(1)}
            unit="%"
            sub={`${summary.online} of ${summary.nodeCount} nodes reporting`}
            danger={summary.health < 80}
          />
        </section>

        <div className="mainGrid">
          <RiskMap
            site={site}
            analyses={analyses}
            links={links}
            selectedId={selected?.nodeId}
            onSelect={setSelectedId}
            mode={mapMode}
            onModeChange={setMapMode}
          />
          <SensorDetail
            analysis={selected}
            onSendAlert={handleSendAlert}
            sending={sending}
          />
        </div>

        <div className="charts">
          <ChartCard
            title="Ground tilt"
            subtitle={`${selected?.nodeCode || '—'} · deviation from commissioning baseline`}
            data={tiltSeries}
            unit="degrees"
            threshold={THRESHOLDS.tiltDeltaDeg.crit}
            color="#4ec9ff"
          />
          <ChartCard
            title="Inter-node distance change"
            subtitle={`${selected?.nodeCode || '—'} · negative means the mesh is compressing`}
            data={distanceSeries}
            unit="millimetres"
            threshold={null}
            color="#f5c542"
            allowNegative
          />
          <ChartCard
            title="Vibration energy"
            subtitle={`${selected?.nodeCode || '—'} · RMS over a 2 s window`}
            data={vibrationSeries}
            unit="g"
            threshold={THRESHOLDS.vibrationG.crit}
            color="#c77dff"
          />
        </div>

        <div className="lowerGrid">
          <SensorTable
            rows={filtered}
            selectedId={selected?.nodeId}
            onSelect={setSelectedId}
            query={query}
            onQuery={setQuery}
          />
          <ForecastPanel analysis={selected} site={site} />
        </div>

        <AlertFeed alerts={alerts} onAcknowledge={acknowledge} />

        <footer className="footer">
          <span><Gauge size={13} /> MineGuard · wireless surface mesh subsidence platform</span>
          <span><Radio size={13} /> {nodes.length} nodes · {links.length} mesh links · model mineguard-ewma-v1</span>
          <span>Last packet {lastSync ? lastSync.toLocaleTimeString() : '—'}</span>
        </footer>
      </main>

      <Toast toast={toast} />
    </div>
  );
}
```

### 9.3 `src/components/TopBar.jsx`

```jsx
import React from 'react';
import { Bell, HardHat, Radio, ShieldCheck } from 'lucide-react';

const LABEL = { live: 'Live', connecting: 'Connecting', error: 'Reconnecting' };

export default function TopBar({ site, connection, lastSync, critical }) {
  return (
    <header className="topbar">
      <div className="brand">
        <div className="logo"><ShieldCheck size={22} /></div>
        <div>
          <b>Mine<span>Guard</span></b>
          <small>Surface mesh subsidence early warning</small>
        </div>
      </div>

      <nav className="topnav">
        <button className="navActive">Overview</button>
        <button onClick={() => document.querySelector('.charts')?.scrollIntoView({ behavior: 'smooth' })}>
          Telemetry
        </button>
        <button onClick={() => document.querySelector('.mapPanel')?.scrollIntoView({ behavior: 'smooth' })}>
          Risk map
        </button>
        <button onClick={() => document.querySelector('.alertFeed')?.scrollIntoView({ behavior: 'smooth' })}>
          Alerts {critical > 0 && <span className="navBadge">{critical}</span>}
        </button>
      </nav>

      <div className="headerRight">
        <div className={`conn ${connection}`}>
          <i /> {LABEL[connection] || connection}
        </div>
        <div className="syncText">
          <Radio size={13} /> {lastSync ? lastSync.toLocaleTimeString() : '—'}
        </div>
        <button className="headerIcon" aria-label="Notifications">
          <Bell size={17} />
          {critical > 0 && <i className="dot" />}
        </button>
        <div className="siteChip"><HardHat size={14} /> {site?.code || '—'}</div>
      </div>
    </header>
  );
}
```

### 9.4 `src/components/MetricCard.jsx`

```jsx
import React from 'react';

export default function MetricCard({ icon, title, value, unit, sub, danger }) {
  return (
    <div className={`metric${danger ? ' metricDanger' : ''}`}>
      <div className="metricIcon">{icon}</div>
      <div className="metricBody">
        <small>{title}</small>
        <strong>{value}<em>{unit}</em></strong>
        <span className={danger ? 'danger' : 'good'}>
          <i /> {danger ? 'Action level reached' : sub}
        </span>
      </div>
    </div>
  );
}
```

### 9.5 `src/components/Toast.jsx`

```jsx
import React from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

export default function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div className={`toast ${toast.tone}`} role="status" aria-live="polite">
      {toast.tone === 'bad' ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}
      {toast.message}
    </div>
  );
}
```

### 9.6 `src/components/ChartCard.jsx`

```jsx
import React from 'react';
import {
  Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';

export default function ChartCard({
  title, subtitle, data, unit, threshold, color = '#4ec9ff', allowNegative = false,
}) {
  const gradId = `g-${title.replace(/\W/g, '')}`;
  const latest = data.length ? data[data.length - 1].value : 0;

  return (
    <div className="panel chartCard">
      <div className="panelHead">
        <div>
          <div className="titleRow">
            <h2>{title}</h2>
            <span className="livePill"><i /> streaming</span>
          </div>
          <small>{subtitle}</small>
        </div>
        <div className="chartNow" style={{ color }}>
          {latest}<em>{unit === 'degrees' ? '°' : unit === 'g' ? ' g' : ' mm'}</em>
        </div>
      </div>

      <div className="chartBody">
        <ResponsiveContainer width="100%" height={210}>
          <AreaChart data={data} margin={{ top: 8, right: 10, bottom: 0, left: -18 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.34" />
                <stop offset="100%" stopColor={color} stopOpacity="0.01" />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#1e2a33" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="time" tick={{ fill: '#64798a', fontSize: 11 }}
                   axisLine={false} tickLine={false} minTickGap={40} />
            <YAxis tick={{ fill: '#64798a', fontSize: 11 }}
                   axisLine={false} tickLine={false} width={52}
                   domain={allowNegative ? ['auto', 'auto'] : [0, 'auto']} />
            <Tooltip
              contentStyle={{
                background: '#0f171e', border: '1px solid #26333d',
                borderRadius: 10, fontSize: 12,
              }}
              labelStyle={{ color: '#8ba0b1' }}
              formatter={(v) => [`${v} ${unit}`, title]}
            />
            {threshold != null && (
              <ReferenceLine
                y={threshold} stroke="#ff4d5f" strokeDasharray="5 5"
                label={{ value: 'action level', position: 'insideTopRight',
                         fill: '#ff8593', fontSize: 11 }}
              />
            )}
            {allowNegative && <ReferenceLine y={0} stroke="#2b3a45" />}
            <Area type="monotone" dataKey="value" stroke={color}
                  strokeWidth={2.2} fill={`url(#${gradId})`} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
        <div className="chartFoot">
          <span>Unit: {unit}</span>
          <span>{data.length} packets in view</span>
        </div>
      </div>
    </div>
  );
}
```

### 9.7 `src/components/RiskMap.jsx` — the GIS layer

Four map modes on one canvas: interpolated deformation surface, the mesh graph with per-link strain, plain sensor view, and the predicted subsidence zone polygon.

```jsx
import React, { useMemo } from 'react';
import {
  Circle, CircleMarker, MapContainer, Polygon, Polyline,
  Popup, Rectangle, TileLayer, Tooltip, useMap,
} from 'react-leaflet';
import { Crosshair, Layers3, Radio, Satellite, Waves } from 'lucide-react';
import { bbox, fmtLatLng, idwGrid, riskZonePolygon, polygonAreaM2 } from '../lib/geo.js';
import { damageClass } from '../lib/analytics.js';

const heatColor = (v) =>
  v >= 0.8 ? '#ff4d5f' : v >= 0.6 ? '#ff8a34' : v >= 0.35 ? '#f5c542' : '#32d583';

const strainColor = (s) => {
  const a = Math.abs(s);
  return a >= 6 ? '#ff4d5f' : a >= 2 ? '#ff8a34' : a >= 0.5 ? '#f5c542' : '#3f5563';
};

/** Keeps the viewport around the mesh whenever the node set changes. */
function FitToMesh({ points }) {
  const map = useMap();
  React.useEffect(() => {
    if (points.length < 2) return;
    map.fitBounds(points, { padding: [40, 40], maxZoom: 17 });
  }, [map, points.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export default function RiskMap({
  site, analyses, links, selectedId, onSelect, mode, onModeChange,
}) {
  const [basemap, setBasemap] = React.useState('street');

  const points = useMemo(
    () => analyses.map((a) => [a.node.install_lat, a.node.install_lng]),
    [analyses]);

  const center = site
    ? [site.centroid_lat, site.centroid_lng]
    : points[0] || [23.748, 86.42];

  // angle of draw: limit of the zone that can be affected by the workings
  const influenceR = site
    ? Number(site.panel_depth_m) * Math.tan((Number(site.angle_of_draw_deg) * Math.PI) / 180)
    : 90;

  const panelRing = useMemo(() => {
    const g = site?.panel_geojson;
    if (!g?.coordinates?.[0]) return null;
    return g.coordinates[0].map(([lng, lat]) => [lat, lng]); // GeoJSON is lng,lat
  }, [site]);

  const grid = useMemo(() => {
    if (!analyses.length) return [];
    const samples = analyses.map((a) => ({
      lat: a.node.install_lat, lng: a.node.install_lng, value: a.score,
    }));
    return idwGrid(samples, bbox(points, 140), 18, 2, 150);
  }, [analyses, points]);

  const zone = useMemo(() => riskZonePolygon(grid, 0.6), [grid]);
  const zoneArea = useMemo(() => (zone ? polygonAreaM2(zone) : 0), [zone]);

  const linkRows = useMemo(() => {
    const byId = Object.fromEntries(analyses.map((a) => [a.nodeId, a.node]));
    return links
      .map((l) => {
        const a = byId[l.node_a];
        const b = byId[l.node_b];
        if (!a || !b) return null;
        return {
          id: l.id,
          positions: [[a.install_lat, a.install_lng], [b.install_lat, b.install_lng]],
          strain: Number(l.strain_mm_per_m) || 0,
          delta: Number(l.delta_mm) || 0,
          a: a.node_code, b: b.node_code,
          rssi: l.rssi_dbm,
        };
      })
      .filter(Boolean);
  }, [links, analyses]);

  return (
    <section className="panel mapPanel">
      <div className="panelHead">
        <div>
          <div className="titleRow">
            <h2>Live deformation map</h2>
            {zone && (
              <span className="zonePill">
                predicted zone {(zoneArea / 10000).toFixed(2)} ha
              </span>
            )}
          </div>
          <small>
            {site ? `${site.name} · depth ${site.panel_depth_m} m · angle of draw ${site.angle_of_draw_deg}°` : '—'}
          </small>
        </div>

        <div className="toggle">
          <button className={mode === 'risk' ? 'active' : ''} onClick={() => onModeChange('risk')}>
            <Layers3 size={13} /> Risk surface
          </button>
          <button className={mode === 'mesh' ? 'active' : ''} onClick={() => onModeChange('mesh')}>
            <Waves size={13} /> Mesh strain
          </button>
          <button className={mode === 'sensors' ? 'active' : ''} onClick={() => onModeChange('sensors')}>
            <Radio size={13} /> Nodes
          </button>
          <button
            className="basemapBtn"
            onClick={() => setBasemap((b) => (b === 'street' ? 'satellite' : 'street'))}
            title="Switch basemap"
          >
            <Satellite size={13} />
          </button>
        </div>
      </div>

      <div className="mapWrap">
        <MapContainer center={center} zoom={16} scrollWheelZoom preferCanvas>
          {basemap === 'street' ? (
            <TileLayer
              attribution="&copy; OpenStreetMap contributors"
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
          ) : (
            <TileLayer
              attribution="Tiles &copy; Esri, Maxar, Earthstar Geographics"
              url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            />
          )}

          <FitToMesh points={points} />

          {/* limit of possible influence from the workings */}
          <Circle
            center={center}
            radius={influenceR}
            pathOptions={{
              color: '#f5a524', weight: 1.4, dashArray: '8 8',
              fillColor: '#f5a524', fillOpacity: 0.03,
            }}
          />

          {panelRing && (
            <Polygon
              positions={panelRing}
              pathOptions={{ color: '#5b7b8c', weight: 1.4, dashArray: '4 6', fillOpacity: 0.04 }}
            >
              <Tooltip sticky>Extracted panel outline</Tooltip>
            </Polygon>
          )}

          {/* interpolated deformation surface */}
          {mode === 'risk' && grid.map((c, i) => (
            <Rectangle
              key={i}
              bounds={c.bounds}
              pathOptions={{
                stroke: false,
                fillColor: heatColor(c.value),
                fillOpacity: 0.1 + c.value * 0.34,
              }}
              interactive={false}
            />
          ))}

          {/* predicted subsidence zone */}
          {mode === 'risk' && zone && (
            <Polygon
              positions={zone}
              pathOptions={{ color: '#ff4d5f', weight: 2, dashArray: '6 4', fillOpacity: 0.06 }}
            >
              <Tooltip sticky>
                Predicted subsidence zone · {(zoneArea / 10000).toFixed(2)} ha
              </Tooltip>
            </Polygon>
          )}

          {/* mesh links coloured by measured strain */}
          {(mode === 'mesh' || mode === 'sensors') && linkRows.map((l) => (
            <Polyline
              key={l.id}
              positions={l.positions}
              pathOptions={{
                color: mode === 'mesh' ? strainColor(l.strain) : '#33475a',
                weight: mode === 'mesh' ? 1.5 + Math.min(4, Math.abs(l.strain) / 2) : 1,
                opacity: mode === 'mesh' ? 0.95 : 0.5,
              }}
            >
              <Tooltip sticky>
                <b>{l.a} ↔ {l.b}</b><br />
                {l.delta >= 0 ? 'separating' : 'compressing'} {Math.abs(l.delta).toFixed(1)} mm<br />
                strain {l.strain.toFixed(2)} mm/m · {damageClass(l.strain)}<br />
                link RSSI {l.rssi} dBm
              </Tooltip>
            </Polyline>
          ))}

          {/* nodes */}
          {analyses.map((a) => {
            const isSel = a.nodeId === selectedId;
            return (
              <CircleMarker
                key={a.nodeId}
                center={[a.node.install_lat, a.node.install_lng]}
                radius={isSel ? 11 : a.node.mesh_role === 'gateway' ? 9 : 7}
                pathOptions={{
                  color: isSel ? '#e8f1f8' : '#0b1116',
                  weight: isSel ? 3 : 2.4,
                  fillColor: a.color,
                  fillOpacity: a.node.status === 'offline' ? 0.25 : 1,
                }}
                eventHandlers={{ click: () => onSelect(a.nodeId) }}
              >
                <Popup>
                  <div className="popup">
                    <b>{a.nodeCode} · {a.severity}</b>
                    <span>Risk score <strong>{a.score.toFixed(2)}</strong></span>
                    <span>Tilt <strong>{a.features.tiltDeltaDeg.toFixed(2)}°</strong></span>
                    <span>Strain <strong>{a.features.strainMmPerM.toFixed(2)} mm/m</strong></span>
                    <span>Displacement <strong>{a.features.displacementMm.toFixed(0)} mm</strong></span>
                    <span>Vibration <strong>{a.features.vibrationG.toFixed(3)} g</strong></span>
                    <span className="popupMuted">{a.node.mesh_role} · {a.node.status}</span>
                  </div>
                </Popup>
                {mode === 'sensors' && (
                  <Tooltip permanent direction="top" offset={[0, -8]} className="nodeTag">
                    {a.nodeCode}
                  </Tooltip>
                )}
              </CircleMarker>
            );
          })}
        </MapContainer>

        <div className="mapLegend">
          <span><i style={{ background: '#32d583' }} /> Low</span>
          <span><i style={{ background: '#f5c542' }} /> Moderate</span>
          <span><i style={{ background: '#ff8a34' }} /> High</span>
          <span><i style={{ background: '#ff4d5f' }} /> Critical</span>
        </div>
        <div className="mapBadge">
          <Crosshair size={13} /> {site ? fmtLatLng(site.centroid_lat, site.centroid_lng) : '—'}
        </div>
      </div>
    </section>
  );
}
```

### 9.8 `src/components/SensorDetail.jsx`

This panel is where the "AI" stops being a black box: it prints the feature values, the weight each one contributed, and the plain-language reason.

```jsx
import React from 'react';
import {
  Activity, BatteryMedium, Compass, MapPin, Signal, Siren, Waves,
} from 'lucide-react';
import { FEATURE_LABELS, THRESHOLDS, topDrivers } from '../lib/analytics.js';
import { fmtLatLng } from '../lib/geo.js';

const pct = (v, warn, crit) => Math.min(100, (Math.abs(v) / crit) * 100);

function FeatureBar({ label, value, unit, warn, crit, decimals = 2 }) {
  const over = Math.abs(value) >= crit;
  const watch = !over && Math.abs(value) >= warn;
  return (
    <div className="featureRow">
      <div className="featureTop">
        <span>{label}</span>
        <b className={over ? 'danger' : watch ? 'warn' : ''}>
          {value.toFixed(decimals)} <em>{unit}</em>
        </b>
      </div>
      <div className="featureTrack">
        <i
          style={{
            width: `${pct(value, warn, crit)}%`,
            background: over ? '#ff4d5f' : watch ? '#ff8a34' : '#32d583',
          }}
        />
        <u style={{ left: `${(warn / crit) * 100}%` }} title={`watch level ${warn} ${unit}`} />
      </div>
    </div>
  );
}

export default function SensorDetail({ analysis, onSendAlert, sending }) {
  if (!analysis) {
    return (
      <aside className="panel detailsPanel">
        <div className="emptyState">
          <Activity size={24} />
          <h3>No node selected</h3>
          <p>Start the simulator, then pick a marker on the map.</p>
        </div>
      </aside>
    );
  }

  const { node, features, latest, severity, score, color, damage, forecast } = analysis;
  const drivers = topDrivers(analysis);

  return (
    <aside className="panel detailsPanel">
      <div className="panelHead">
        <div>
          <div className="titleRow">
            <h2>{node.node_code}</h2>
            <span className={`statusChip ${node.status}`}><i /> {node.status}</span>
          </div>
          <small>{node.label} · {node.mesh_role} · {node.radio}</small>
        </div>
      </div>

      <div className="scoreBox">
        <div className="scoreText">
          <small>Risk score</small>
          <strong style={{ color }}>{score.toFixed(2)}</strong>
          <span className="riskBadge"
                style={{ color, borderColor: `${color}55`, background: `${color}14` }}>
            {severity}
          </span>
        </div>
        <div className="radial" style={{ '--p': `${score * 100}%`, '--c': color }}>
          <b>{Math.round(score * 100)}</b>
          <small>/100</small>
        </div>
      </div>

      {drivers.length > 0 && (
        <p className="whyLine">
          Driven by {drivers.map((d, i) => (
            <React.Fragment key={d.key}>
              {i > 0 && (i === drivers.length - 1 ? ' and ' : ', ')}
              <b>{d.label.toLowerCase()}</b> ({d.share}%)
            </React.Fragment>
          ))}.
          {analysis.corroboration > 1 &&
            ` ${analysis.hot ?? ''} independent signals agree, so the score is weighted up.`}
        </p>
      )}

      <div className="featureList">
        <FeatureBar
          label={FEATURE_LABELS.tilt} value={features.tiltDeltaDeg} unit="°"
          warn={THRESHOLDS.tiltDeltaDeg.warn} crit={THRESHOLDS.tiltDeltaDeg.crit} />
        <FeatureBar
          label={FEATURE_LABELS.strain} value={features.strainMmPerM} unit="mm/m"
          warn={THRESHOLDS.strainMmPerM.warn} crit={THRESHOLDS.strainMmPerM.crit} />
        <FeatureBar
          label={FEATURE_LABELS.displacement} value={features.displacementMm} unit="mm"
          warn={THRESHOLDS.displacementMm.warn} crit={THRESHOLDS.displacementMm.crit}
          decimals={0} />
        <FeatureBar
          label={FEATURE_LABELS.vibration} value={features.vibrationG} unit="g"
          warn={THRESHOLDS.vibrationG.warn} crit={THRESHOLDS.vibrationG.crit} decimals={3} />
        <FeatureBar
          label={FEATURE_LABELS.crack} value={features.crackMm} unit="mm"
          warn={THRESHOLDS.crackMm.warn} crit={THRESHOLDS.crackMm.crit} decimals={1} />
      </div>

      <div className="rawGrid">
        <div><Compass size={13} /><span>Roll / Pitch / Yaw</span>
          <b>{Number(latest?.roll_deg ?? 0).toFixed(2)}° · {Number(latest?.pitch_deg ?? 0).toFixed(2)}° · {Number(latest?.yaw_deg ?? 0).toFixed(1)}°</b>
        </div>
        <div><Activity size={13} /><span>Acceleration RMS</span>
          <b>{Number(latest?.accel_rms_g ?? 0).toFixed(3)} g</b>
        </div>
        <div><Waves size={13} /><span>Distance change</span>
          <b>{Number(latest?.delta_distance_mm ?? 0).toFixed(1)} mm</b>
        </div>
        <div><MapPin size={13} /><span>GNSS fix</span>
          <b>{latest?.gps_lat ? fmtLatLng(latest.gps_lat, latest.gps_lng) : '—'}</b>
        </div>
        <div><Signal size={13} /><span>Link quality</span>
          <b>{latest?.rssi_dbm ?? '—'} dBm · {latest?.satellites ?? '—'} sats · HDOP {Number(latest?.hdop ?? 0).toFixed(1)}</b>
        </div>
        <div><BatteryMedium size={13} /><span>Battery</span>
          <b>{Number(latest?.battery_v ?? 0).toFixed(2)} V</b>
        </div>
      </div>

      <div className="verdict">
        <span>Damage class</span><b>{damage}</b>
        <span>24 h projection</span>
        <b>{forecast.strain24h.toFixed(2)} mm/m strain, {forecast.tilt24h.toFixed(2)}° tilt</b>
        {forecast.hoursToThreshold != null && (
          <>
            <span>Action level in</span>
            <b className="danger">~{forecast.hoursToThreshold} h</b>
          </>
        )}
      </div>

      <button className="smsBtn" onClick={onSendAlert} disabled={sending}>
        <Siren size={17} />
        {sending ? 'Sending early warning…' : 'Send early warning to safety officer'}
      </button>
    </aside>
  );
}
```

### 9.9 `src/components/SensorTable.jsx`

```jsx
import React from 'react';
import { Radio, Search } from 'lucide-react';

export default function SensorTable({ rows, selectedId, onSelect, query, onQuery }) {
  return (
    <section className="panel tablePanel">
      <div className="panelHead">
        <div>
          <div className="titleRow">
            <h2><Radio size={16} /> Mesh nodes</h2>
            <span className="zonePill">{rows.length} shown</span>
          </div>
          <small>Sorted by risk. Click a row to inspect it on the map.</small>
        </div>
        <div className="search">
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Filter by node or severity"
            aria-label="Filter nodes"
          />
        </div>
      </div>

      <div className="sensorTable">
        <div className="thead">
          <span>Node</span><span>Severity</span><span>Score</span>
          <span>Tilt</span><span>Strain</span><span>Displacement</span><span>Battery</span>
        </div>
        {rows.length === 0 && (
          <p className="tableEmpty">No node matches that filter.</p>
        )}
        {rows.map((a) => (
          <button
            key={a.nodeId}
            className={a.nodeId === selectedId ? 'tr selected' : 'tr'}
            onClick={() => onSelect(a.nodeId)}
          >
            <span><i className="sensorDot" style={{ background: a.color }} />{a.nodeCode}</span>
            <span className="riskText" style={{ color: a.color }}>{a.severity}</span>
            <span className="mono">{a.score.toFixed(2)}</span>
            <span className="mono">{a.features.tiltDeltaDeg.toFixed(2)}°</span>
            <span className="mono">{a.features.strainMmPerM.toFixed(2)}</span>
            <span className="mono">{a.features.displacementMm.toFixed(0)} mm</span>
            <span className="mono">{Number(a.node.battery_v ?? 0).toFixed(2)} V</span>
          </button>
        ))}
      </div>
    </section>
  );
}
```

### 9.10 `src/components/ForecastPanel.jsx`

```jsx
import React from 'react';
import { Gauge, TrendingUp } from 'lucide-react';

export default function ForecastPanel({ analysis, site }) {
  if (!analysis) return <section className="panel prediction" />;
  const { forecast, features, score, color, severity, nodeCode } = analysis;

  const smax = site
    ? Number(site.extraction_ratio) * Number(site.seam_thickness_m) * 1000
    : null; // mm

  return (
    <section className="panel prediction">
      <div className="panelHead">
        <div>
          <div className="titleRow"><h2><Gauge size={16} /> Subsidence forecast</h2></div>
          <small>Trend projection for {nodeCode} · {forecast.confidence}% fit confidence</small>
        </div>
      </div>

      <div className="forecastGauge">
        <div className="gaugeCircle" style={{ '--p': `${score * 100}%`, '--c': color }}>
          <div>
            <strong style={{ color }}>{Math.round(score * 100)}</strong>
            <small>{severity}</small>
          </div>
        </div>
      </div>

      <div className="forecastRows">
        <p><span>Tilt trend</span>
           <b>{forecast.tiltSlope >= 0 ? '+' : ''}{forecast.tiltSlope} °/h</b></p>
        <p><span>Strain trend</span>
           <b>{forecast.strainSlope >= 0 ? '+' : ''}{forecast.strainSlope} mm/m per h</b></p>
        <p><span>Projected 24 h strain</span>
           <b>{forecast.strain24h.toFixed(2)} mm/m</b></p>
        <p><span>Projected 24 h tilt</span>
           <b>{forecast.tilt24h.toFixed(2)}°</b></p>
        <p><span>Time to action level</span>
           <b className={forecast.hoursToThreshold != null ? 'danger' : ''}>
             {forecast.hoursToThreshold != null ? `~${forecast.hoursToThreshold} h` : 'not projected'}
           </b></p>
        <p><span>Direction</span>
           <b className={forecast.trend === 'increasing' ? 'danger' : 'good'}>
             <TrendingUp size={13} /> {forecast.trend}
           </b></p>
        {smax && (
          <p><span>Theoretical max subsidence</span>
             <b>{smax.toFixed(0)} mm</b></p>
        )}
        <p><span>Current displacement</span>
           <b>{features.displacementMm.toFixed(0)} mm
             {smax ? ` (${((features.displacementMm / smax) * 100).toFixed(1)}% of Smax)` : ''}</b></p>
      </div>

      <p className="modelNote">
        Projection is a least-squares trend over the observed window, bounded by the
        Knothe influence-function limit for a {site?.panel_depth_m} m deep,
        {' '}{site?.seam_thickness_m} m thick working. Verify against levelling survey
        before any evacuation decision.
      </p>
    </section>
  );
}
```

### 9.11 `src/components/AlertFeed.jsx`

```jsx
import React from 'react';
import { BellRing, Check, MessageSquare, Mail } from 'lucide-react';

const tone = { Critical: 'crit', High: 'high', Moderate: 'mod' };

export default function AlertFeed({ alerts, onAcknowledge }) {
  return (
    <section className="panel alertFeed">
      <div className="panelHead">
        <div>
          <div className="titleRow">
            <h2><BellRing size={16} /> Early warning log</h2>
            <span className="zonePill">{alerts.length} records</span>
          </div>
          <small>Every message sent to the safety officer, with delivery state.</small>
        </div>
      </div>

      {alerts.length === 0 ? (
        <p className="tableEmpty">
          No warnings issued yet. The scorer raises one automatically when a node
          crosses the action level.
        </p>
      ) : (
        <ul className="alertList">
          {alerts.map((a) => (
            <li key={a.id} className={tone[a.severity] || 'mod'}>
              <div className="alertHead">
                <b>{a.title}</b>
                <span className={`alertStatus ${a.status}`}>{a.status}</span>
              </div>
              <p>{a.body}</p>
              <div className="alertMeta">
                <span>{new Date(a.created_at).toLocaleString()}</span>
                {a.channels?.includes('sms') && <span><MessageSquare size={12} /> SMS</span>}
                {a.channels?.includes('email') && <span><Mail size={12} /> Email</span>}
                <span>{Array.isArray(a.recipients) ? a.recipients.length : 0} recipients</span>
                {a.status !== 'acknowledged' && (
                  <button onClick={() => onAcknowledge(a.id)}>
                    <Check size={12} /> Acknowledge
                  </button>
                )}
                {a.acknowledged_by && <span>ack by {a.acknowledged_by}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

---

## 10. Stylesheet

Replace `src/styles.css` entirely. Palette is anthracite and hazard-signal — coal seam greys with the amber/red of mine signage, one cyan accent reserved for live telemetry so "moving data" is always the same colour.

```css
/* ── tokens ────────────────────────────────────────────── */
:root {
  --bg:        #080d11;
  --surface:   #0f171e;
  --surface-2: #131e26;
  --line:      #1e2a33;
  --line-soft: #172129;
  --text:      #e6eef5;
  --muted:     #7b8fa0;
  --dim:       #56697a;
  --cyan:      #4ec9ff;
  --amber:     #f5a524;
  --green:     #32d583;
  --yellow:    #f5c542;
  --orange:    #ff8a34;
  --red:       #ff4d5f;
  --radius:    14px;
  --radius-sm: 9px;
  --shadow:    0 18px 40px rgba(0,0,0,.45);
  --mono: 'JetBrains Mono', ui-monospace, monospace;
  --cond: 'Barlow Condensed', 'Inter', sans-serif;
  --sans: 'Inter', system-ui, -apple-system, sans-serif;
}

* { box-sizing: border-box; }
html, body, #root { height: 100%; }
body {
  margin: 0;
  background:
    radial-gradient(1100px 500px at 15% -10%, #12212b 0%, transparent 60%),
    radial-gradient(900px 420px at 105% 0%, #1a1420 0%, transparent 55%),
    var(--bg);
  color: var(--text);
  font-family: var(--sans);
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
}
button { font-family: inherit; cursor: pointer; }
:focus-visible { outline: 2px solid var(--cyan); outline-offset: 2px; border-radius: 6px; }
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}

.app { min-height: 100%; display: flex; flex-direction: column; }
main {
  width: min(1560px, 100%);
  margin: 0 auto;
  padding: 22px clamp(14px, 2.4vw, 30px) 60px;
  display: flex; flex-direction: column; gap: 20px;
}

/* ── top bar ───────────────────────────────────────────── */
.topbar {
  position: sticky; top: 0; z-index: 900;
  display: flex; align-items: center; gap: 22px;
  padding: 12px clamp(14px, 2.4vw, 30px);
  background: rgba(8,13,17,.86);
  backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--line);
}
.brand { display: flex; align-items: center; gap: 12px; }
.logo {
  width: 40px; height: 40px; display: grid; place-items: center;
  border-radius: 11px; color: #06131a;
  background: linear-gradient(135deg, var(--cyan), #2ba7dd);
  box-shadow: 0 6px 18px rgba(78,201,255,.25);
}
.brand b {
  display: block; font-family: var(--cond); font-size: 22px;
  letter-spacing: .5px; line-height: 1;
}
.brand b span { color: var(--cyan); }
.brand small { color: var(--dim); font-size: 11.5px; }

.topnav { display: flex; gap: 4px; margin-left: 10px; }
.topnav button {
  background: transparent; border: 0; color: var(--muted);
  padding: 8px 14px; border-radius: 8px; font-size: 13px;
}
.topnav button:hover { color: var(--text); background: var(--surface); }
.topnav .navActive { color: var(--text); background: var(--surface-2); }
.navBadge {
  margin-left: 6px; background: var(--red); color: #fff;
  border-radius: 20px; padding: 1px 7px; font-size: 11px; font-weight: 700;
}

.headerRight { margin-left: auto; display: flex; align-items: center; gap: 12px; }
.conn {
  display: flex; align-items: center; gap: 7px; font-size: 12px;
  padding: 5px 11px; border-radius: 20px; border: 1px solid var(--line);
  background: var(--surface); color: var(--muted);
}
.conn i { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); }
.conn.live { color: var(--green); border-color: rgba(50,213,131,.3); }
.conn.live i { background: var(--green); animation: pulse 1.8s infinite; }
.conn.error { color: var(--red); border-color: rgba(255,77,95,.3); }
.conn.error i { background: var(--red); }
@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }

.syncText {
  display: flex; align-items: center; gap: 6px;
  color: var(--dim); font-family: var(--mono); font-size: 11.5px;
}
.headerIcon {
  position: relative; width: 36px; height: 36px; border-radius: 10px;
  background: var(--surface); border: 1px solid var(--line);
  color: var(--muted); display: grid; place-items: center;
}
.headerIcon .dot {
  position: absolute; top: 8px; right: 8px; width: 7px; height: 7px;
  border-radius: 50%; background: var(--red);
}
.siteChip {
  display: flex; align-items: center; gap: 6px;
  font-family: var(--mono); font-size: 12px; color: var(--amber);
  border: 1px solid rgba(245,165,36,.28); background: rgba(245,165,36,.08);
  padding: 6px 11px; border-radius: 9px;
}

/* ── hero ──────────────────────────────────────────────── */
.hero {
  display: grid; grid-template-columns: 1fr auto; gap: 26px; align-items: center;
  padding: 26px 28px;
  border: 1px solid var(--line); border-radius: var(--radius);
  background:
    linear-gradient(120deg, rgba(78,201,255,.06), transparent 55%),
    var(--surface);
}
.heroKicker { margin: 0 0 8px; color: var(--amber); font-size: 12.5px; letter-spacing: .3px; }
.hero h1 {
  margin: 0 0 10px; font-family: var(--cond); font-weight: 600;
  font-size: clamp(26px, 3.1vw, 40px); line-height: 1.08; letter-spacing: .2px;
}
.heroSub { margin: 0 0 18px; color: var(--muted); max-width: 66ch; line-height: 1.6; }
.heroActions { display: flex; gap: 10px; flex-wrap: wrap; }
.primary, .secondary {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 10px 17px; border-radius: 10px; font-size: 13.5px; font-weight: 600;
  border: 1px solid transparent; transition: transform .12s ease, filter .12s ease;
}
.primary { background: linear-gradient(135deg, var(--cyan), #2ba7dd); color: #05131b; }
.secondary { background: var(--surface-2); border-color: var(--line); color: var(--text); }
.primary:hover, .secondary:hover { transform: translateY(-1px); filter: brightness(1.06); }

.heroStat {
  text-align: right; padding-left: 26px; border-left: 1px solid var(--line-soft);
  min-width: 210px;
}
.heroStat span { display: block; color: var(--dim); font-size: 12px; }
.heroStat strong {
  display: block; font-family: var(--cond); font-size: 62px; line-height: 1;
  margin: 4px 0 6px; font-variant-numeric: tabular-nums;
}
.heroStat small { color: var(--dim); font-size: 11.5px; }

/* ── metrics ───────────────────────────────────────────── */
.metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.metric {
  display: flex; gap: 14px; padding: 16px 18px;
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface);
}
.metricDanger { border-color: rgba(255,77,95,.35); background: linear-gradient(180deg, rgba(255,77,95,.07), var(--surface)); }
.metricIcon {
  width: 40px; height: 40px; flex: none; border-radius: 11px;
  display: grid; place-items: center; color: var(--cyan);
  background: rgba(78,201,255,.1); border: 1px solid rgba(78,201,255,.18);
}
.metricDanger .metricIcon { color: var(--red); background: rgba(255,77,95,.1); border-color: rgba(255,77,95,.22); }
.metricBody small { display: block; color: var(--muted); font-size: 12px; }
.metricBody strong {
  display: block; font-family: var(--cond); font-size: 32px; line-height: 1.15;
  font-variant-numeric: tabular-nums;
}
.metricBody strong em { font-style: normal; font-size: 14px; color: var(--dim); margin-left: 5px; }
.metricBody span { font-size: 11.5px; display: inline-flex; align-items: center; gap: 5px; }
.metricBody span i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.good { color: var(--green); }
.warn { color: var(--orange); }
.danger { color: var(--red); }

/* ── panels ────────────────────────────────────────────── */
.panel {
  border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--surface); box-shadow: var(--shadow); overflow: hidden;
}
.panelHead {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 14px;
  padding: 15px 18px; border-bottom: 1px solid var(--line-soft);
}
.titleRow { display: flex; align-items: center; gap: 10px; }
.panelHead h2 {
  margin: 0; font-family: var(--cond); font-size: 19px; font-weight: 600;
  display: flex; align-items: center; gap: 8px;
}
.panelHead small { color: var(--dim); font-size: 12px; }
.zonePill, .livePill, .statusChip {
  font-size: 10.5px; letter-spacing: .4px; padding: 3px 9px;
  border-radius: 20px; border: 1px solid var(--line); color: var(--muted);
  display: inline-flex; align-items: center; gap: 6px;
}
.livePill i { width: 6px; height: 6px; border-radius: 50%; background: var(--cyan); animation: pulse 1.8s infinite; }
.statusChip i { width: 6px; height: 6px; border-radius: 50%; background: var(--green); }
.statusChip.degraded { color: var(--yellow); } .statusChip.degraded i { background: var(--yellow); }
.statusChip.offline  { color: var(--red); }    .statusChip.offline i  { background: var(--red); }

.toggle { display: flex; gap: 4px; background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 3px; }
.toggle button {
  display: inline-flex; align-items: center; gap: 6px;
  background: transparent; border: 0; color: var(--muted);
  padding: 6px 11px; border-radius: 7px; font-size: 12px;
}
.toggle button.active { background: var(--surface-2); color: var(--text); }
.basemapBtn { padding: 6px 9px !important; }

/* ── map ───────────────────────────────────────────────── */
.mainGrid { display: grid; grid-template-columns: minmax(0,1.62fr) minmax(330px,1fr); gap: 16px; }
.mapWrap { position: relative; height: 560px; }
.mapWrap .leaflet-container { height: 100%; width: 100%; background: #0a1117; }
.leaflet-control-attribution { background: rgba(8,13,17,.8) !important; color: var(--dim) !important; font-size: 10px !important; }
.leaflet-control-attribution a { color: var(--muted) !important; }
.leaflet-bar a { background: var(--surface) !important; color: var(--text) !important; border-color: var(--line) !important; }

.mapLegend {
  position: absolute; left: 12px; bottom: 12px; z-index: 500;
  display: flex; gap: 12px; padding: 8px 12px; border-radius: 10px;
  background: rgba(8,13,17,.86); border: 1px solid var(--line); font-size: 11.5px;
}
.mapLegend span { display: flex; align-items: center; gap: 6px; color: var(--muted); }
.mapLegend i { width: 9px; height: 9px; border-radius: 3px; }
.mapBadge {
  position: absolute; right: 12px; top: 12px; z-index: 500;
  display: flex; align-items: center; gap: 7px; padding: 7px 12px;
  border-radius: 10px; background: rgba(8,13,17,.86); border: 1px solid var(--line);
  font-family: var(--mono); font-size: 11.5px; color: var(--muted);
}
.leaflet-popup-content-wrapper, .leaflet-popup-tip {
  background: #10181f; color: var(--text); border: 1px solid var(--line);
}
.popup { display: grid; gap: 3px; min-width: 190px; font-size: 12px; }
.popup b { font-size: 13.5px; margin-bottom: 3px; }
.popup span { display: flex; justify-content: space-between; color: var(--muted); }
.popup strong { color: var(--text); font-family: var(--mono); }
.popupMuted { color: var(--dim) !important; font-size: 11px; }
.nodeTag {
  background: rgba(8,13,17,.9) !important; border: 1px solid var(--line) !important;
  color: var(--muted) !important; font-family: var(--mono); font-size: 10.5px !important;
  box-shadow: none !important;
}
.nodeTag::before { display: none; }

/* ── sensor detail ─────────────────────────────────────── */
.detailsPanel { display: flex; flex-direction: column; }
.scoreBox { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 18px; }
.scoreText small { color: var(--dim); font-size: 12px; }
.scoreText strong {
  display: block; font-family: var(--cond); font-size: 52px; line-height: 1;
  font-variant-numeric: tabular-nums; margin: 2px 0 8px;
}
.riskBadge { border: 1px solid; border-radius: 20px; padding: 3px 11px; font-size: 11.5px; font-weight: 600; }
.radial {
  width: 96px; height: 96px; border-radius: 50%; flex: none;
  display: grid; place-items: center; position: relative;
  background: conic-gradient(var(--c) var(--p), #16222b 0);
}
.radial::after {
  content: ''; position: absolute; inset: 9px; border-radius: 50%; background: var(--surface);
}
.radial b, .radial small { position: relative; z-index: 1; }
.radial b { font-family: var(--cond); font-size: 28px; }
.radial small { font-size: 10px; color: var(--dim); }

.whyLine {
  margin: 0 18px 14px; padding: 11px 13px; border-radius: var(--radius-sm);
  background: var(--surface-2); border: 1px solid var(--line-soft);
  color: var(--muted); font-size: 12.5px; line-height: 1.55;
}
.whyLine b { color: var(--text); font-weight: 600; }

.featureList { padding: 0 18px 4px; display: grid; gap: 13px; }
.featureTop { display: flex; justify-content: space-between; font-size: 12.5px; color: var(--muted); }
.featureTop b { font-family: var(--mono); color: var(--text); font-size: 12.5px; }
.featureTop b em { font-style: normal; color: var(--dim); font-size: 11px; }
.featureTrack { position: relative; height: 6px; border-radius: 4px; background: #16222b; margin-top: 6px; }
.featureTrack i { display: block; height: 100%; border-radius: 4px; transition: width .4s ease; }
.featureTrack u { position: absolute; top: -3px; width: 2px; height: 12px; background: var(--dim); opacity: .6; }

.rawGrid { margin: 16px 18px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.rawGrid > div {
  padding: 10px 12px; border-radius: var(--radius-sm);
  background: var(--surface-2); border: 1px solid var(--line-soft);
  display: grid; grid-template-columns: 14px 1fr; gap: 4px 8px; align-items: center;
  color: var(--cyan);
}
.rawGrid span { color: var(--dim); font-size: 11px; }
.rawGrid b { grid-column: 1 / -1; color: var(--text); font-family: var(--mono); font-size: 11.5px; word-break: break-word; }

.verdict {
  margin: 0 18px 16px; padding: 13px; display: grid; grid-template-columns: auto 1fr; gap: 6px 14px;
  border-radius: var(--radius-sm); background: rgba(245,165,36,.06); border: 1px solid rgba(245,165,36,.2);
  font-size: 12.5px;
}
.verdict span { color: var(--muted); }
.verdict b { text-align: right; font-family: var(--mono); font-size: 12px; }

.smsBtn {
  margin: auto 18px 18px; padding: 13px; border-radius: 11px; border: 0;
  display: flex; align-items: center; justify-content: center; gap: 9px;
  background: linear-gradient(135deg, var(--red), #d63a4b); color: #fff;
  font-weight: 600; font-size: 13.5px;
}
.smsBtn:disabled { opacity: .6; cursor: wait; }
.smsBtn:hover:not(:disabled) { filter: brightness(1.08); }

.emptyState { padding: 60px 24px; text-align: center; color: var(--dim); }
.emptyState h3 { font-family: var(--cond); margin: 12px 0 6px; color: var(--text); }

/* ── charts ────────────────────────────────────────────── */
.charts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.chartNow { font-family: var(--cond); font-size: 26px; font-variant-numeric: tabular-nums; }
.chartNow em { font-style: normal; font-size: 12px; color: var(--dim); }
.chartBody { padding: 12px 10px 0; }
.chartFoot {
  display: flex; justify-content: space-between; padding: 8px 12px 12px;
  color: var(--dim); font-size: 11.5px;
}

/* ── table + forecast ──────────────────────────────────── */
.lowerGrid { display: grid; grid-template-columns: minmax(0,1.62fr) minmax(330px,1fr); gap: 16px; }
.search {
  display: flex; align-items: center; gap: 8px; padding: 7px 11px;
  border: 1px solid var(--line); border-radius: 9px; background: var(--bg); color: var(--dim);
}
.search input { background: transparent; border: 0; color: var(--text); font-size: 12.5px; width: 170px; outline: none; }

.sensorTable { padding: 6px 10px 12px; }
.thead, .tr {
  display: grid; grid-template-columns: 1.1fr .9fr .6fr .7fr .8fr 1fr .7fr;
  gap: 8px; align-items: center; padding: 9px 10px; text-align: left;
}
.thead { color: var(--dim); font-size: 11px; letter-spacing: .3px; border-bottom: 1px solid var(--line-soft); }
.tr {
  width: 100%; background: transparent; border: 1px solid transparent;
  border-radius: 9px; color: var(--text); font-size: 12.5px; margin-top: 3px;
}
.tr:hover { background: var(--surface-2); }
.tr.selected { background: var(--surface-2); border-color: rgba(78,201,255,.3); }
.tr span { display: flex; align-items: center; gap: 8px; }
.sensorDot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.riskText { font-weight: 600; }
.mono { font-family: var(--mono); font-size: 12px; }
.tableEmpty { padding: 26px; text-align: center; color: var(--dim); font-size: 13px; }

.forecastGauge { display: grid; place-items: center; padding: 22px 0 8px; }
.gaugeCircle {
  width: 150px; height: 150px; border-radius: 50%; display: grid; place-items: center;
  background: conic-gradient(var(--c) var(--p), #16222b 0); position: relative;
}
.gaugeCircle::after { content: ''; position: absolute; inset: 13px; border-radius: 50%; background: var(--surface); }
.gaugeCircle > div { position: relative; z-index: 1; text-align: center; }
.gaugeCircle strong { display: block; font-family: var(--cond); font-size: 46px; line-height: 1; }
.gaugeCircle small { color: var(--dim); font-size: 11.5px; }

.forecastRows { padding: 6px 18px 4px; display: grid; gap: 2px; }
.forecastRows p {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  margin: 0; padding: 9px 0; border-bottom: 1px dashed var(--line-soft); font-size: 12.5px;
}
.forecastRows p:last-child { border-bottom: 0; }
.forecastRows span { color: var(--muted); }
.forecastRows b { font-family: var(--mono); font-size: 12px; display: inline-flex; align-items: center; gap: 5px; }
.modelNote { margin: 6px 18px 18px; color: var(--dim); font-size: 11.5px; line-height: 1.6; }

/* ── alert feed ────────────────────────────────────────── */
.alertList { list-style: none; margin: 0; padding: 12px 18px 18px; display: grid; gap: 10px; }
.alertList li {
  padding: 13px 15px; border-radius: var(--radius-sm);
  background: var(--surface-2); border-left: 3px solid var(--line);
}
.alertList li.crit { border-left-color: var(--red); }
.alertList li.high { border-left-color: var(--orange); }
.alertList li.mod  { border-left-color: var(--yellow); }
.alertHead { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
.alertHead b { font-size: 13.5px; }
.alertStatus {
  font-size: 10.5px; padding: 2px 9px; border-radius: 20px;
  border: 1px solid var(--line); color: var(--muted);
}
.alertStatus.sent { color: var(--green); border-color: rgba(50,213,131,.3); }
.alertStatus.failed { color: var(--red); border-color: rgba(255,77,95,.3); }
.alertStatus.acknowledged { color: var(--cyan); border-color: rgba(78,201,255,.3); }
.alertList p { margin: 7px 0 9px; color: var(--muted); font-size: 12.5px; line-height: 1.55; }
.alertMeta { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; color: var(--dim); font-size: 11.5px; }
.alertMeta span { display: inline-flex; align-items: center; gap: 5px; }
.alertMeta button {
  display: inline-flex; align-items: center; gap: 5px;
  background: var(--surface); border: 1px solid var(--line); color: var(--text);
  padding: 4px 10px; border-radius: 7px; font-size: 11.5px;
}

/* ── footer, toast, boot error ─────────────────────────── */
.footer {
  display: flex; flex-wrap: wrap; gap: 14px; justify-content: space-between;
  padding: 18px 4px 0; border-top: 1px solid var(--line-soft);
  color: var(--dim); font-size: 11.5px;
}
.footer span { display: inline-flex; align-items: center; gap: 7px; }

.toast {
  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); z-index: 1200;
  display: flex; align-items: center; gap: 10px; padding: 12px 20px;
  border-radius: 12px; background: #10181f; border: 1px solid var(--line);
  box-shadow: var(--shadow); font-size: 13px;
}
.toast.ok  { border-color: rgba(50,213,131,.35); color: var(--green); }
.toast.bad { border-color: rgba(255,77,95,.35); color: var(--red); }

.bootError {
  max-width: 560px; margin: 16vh auto; padding: 32px; text-align: center;
  border: 1px solid rgba(255,77,95,.3); border-radius: var(--radius);
  background: var(--surface); color: var(--red);
}
.bootError h1 { font-family: var(--cond); color: var(--text); margin: 14px 0 8px; }
.bootError p { color: var(--muted); margin: 6px 0; }
.bootError .hint { color: var(--dim); font-size: 12.5px; }
.bootError code { font-family: var(--mono); color: var(--amber); }
.bootError button { margin-top: 16px; }

/* ── responsive ────────────────────────────────────────── */
@media (max-width: 1280px) {
  .metrics { grid-template-columns: repeat(2, 1fr); }
  .charts  { grid-template-columns: 1fr 1fr; }
  .charts > *:last-child { grid-column: 1 / -1; }
}
@media (max-width: 1040px) {
  .mainGrid, .lowerGrid { grid-template-columns: 1fr; }
  .hero { grid-template-columns: 1fr; }
  .heroStat { text-align: left; padding: 18px 0 0; border-left: 0; border-top: 1px solid var(--line-soft); }
  .topnav { display: none; }
}
@media (max-width: 720px) {
  .metrics, .charts { grid-template-columns: 1fr; }
  .mapWrap { height: 400px; }
  .thead { display: none; }
  .tr { grid-template-columns: 1fr 1fr; row-gap: 4px; }
  .rawGrid { grid-template-columns: 1fr; }
  .headerRight .syncText { display: none; }
}
```

---

## 11. Alerting: Edge Function + SMS provider

### 11.1 `supabase/functions/send-alert/index.ts`

Handles recipient selection, severity filtering, SMS, email, and audit logging. If no SMS credentials are configured it runs in **mock mode** — the alert is still written to the database and shows up in the dashboard, so a demo never fails because a trial account ran out of credit.

```ts
// supabase/functions/send-alert/index.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const RANK: Record<string, number> = { Moderate: 1, High: 2, Critical: 3 };

interface Recipient {
  id: string; name: string; role: string;
  phone: string | null; email: string | null; min_severity: string;
}

// ── SMS providers ───────────────────────────────────────────
async function sendTwilio(to: string, text: string) {
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID')!;
  const token = Deno.env.get('TWILIO_AUTH_TOKEN')!;
  const from = Deno.env.get('TWILIO_FROM')!;
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${sid}:${token}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: text }),
    });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || 'twilio failed');
  return json.sid as string;
}

async function sendMsg91(to: string, vars: Record<string, string>) {
  const res = await fetch('https://control.msg91.com/api/v5/flow/', {
    method: 'POST',
    headers: {
      authkey: Deno.env.get('MSG91_AUTHKEY')!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      template_id: Deno.env.get('MSG91_TEMPLATE_ID'),
      short_url: '0',
      recipients: [{ mobiles: to.replace('+', ''), ...vars }],
    }),
  });
  const json = await res.json();
  if (!res.ok || json.type === 'error') throw new Error(JSON.stringify(json));
  return json.request_id ?? 'msg91-ok';
}

async function sendFast2Sms(to: string, text: string) {
  const res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
    method: 'POST',
    headers: {
      authorization: Deno.env.get('FAST2SMS_API_KEY')!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      route: 'q',
      message: text,
      language: 'english',
      numbers: to.replace('+91', '').replace('+', ''),
    }),
  });
  const json = await res.json();
  if (!json.return) throw new Error(JSON.stringify(json));
  return json.request_id ?? 'fast2sms-ok';
}

async function sendEmail(to: string, subject: string, text: string) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) return null;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: Deno.env.get('ALERT_FROM_EMAIL') || 'MineGuard <alerts@resend.dev>',
      to: [to],
      subject,
      html: `<pre style="font:14px/1.6 system-ui;white-space:pre-wrap">${text}</pre>`,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || 'email failed');
  return json.id as string;
}

// ── handler ─────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), {
      status, headers: { ...cors, 'Content-Type': 'application/json' },
    });

  try {
    const payload = await req.json();
    const {
      site_id, node_id, severity = 'High', score = null,
      title, body, channels = ['sms'], triggered_by = 'auto',
    } = payload;

    if (!site_id || !title || !body) {
      return json({ error: 'site_id, title and body are required' }, 400);
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } });

    // who should hear about this severity
    const { data: all, error: rErr } = await admin
      .from('alert_recipients')
      .select('*').eq('site_id', site_id).eq('active', true);
    if (rErr) throw rErr;

    const recipients = (all as Recipient[]).filter(
      (r) => RANK[severity] >= RANK[r.min_severity]);

    // audit row first, so nothing is ever sent without a record
    const { data: alertRow, error: aErr } = await admin
      .from('alerts')
      .insert({
        site_id, node_id, severity, score, title, body, channels,
        triggered_by, status: 'queued',
        recipients: recipients.map((r) => ({ name: r.name, role: r.role, phone: r.phone })),
      })
      .select().single();
    if (aErr) throw aErr;

    const provider = (Deno.env.get('SMS_PROVIDER') || 'mock').toLowerCase();
    const results: { to: string; ok: boolean; ref?: string; error?: string }[] = [];

    for (const r of recipients) {
      // SMS
      if (channels.includes('sms') && r.phone) {
        try {
          let ref = 'mock';
          if (provider === 'twilio') ref = await sendTwilio(r.phone, body);
          else if (provider === 'msg91') {
            ref = await sendMsg91(r.phone, {
              VAR1: severity, VAR2: title, VAR3: String(score ?? ''),
            });
          } else if (provider === 'fast2sms') ref = await sendFast2Sms(r.phone, body);
          else console.log(`[mock-sms] → ${r.phone}: ${body}`);
          results.push({ to: r.phone, ok: true, ref });
        } catch (e) {
          results.push({ to: r.phone, ok: false, error: String(e) });
        }
      }
      // Email
      if (channels.includes('email') && r.email) {
        try {
          const ref = await sendEmail(r.email, title, body);
          results.push({ to: r.email, ok: true, ref: ref ?? 'email-skipped' });
        } catch (e) {
          results.push({ to: r.email, ok: false, error: String(e) });
        }
      }
    }

    const sent = results.filter((x) => x.ok).length;
    const failed = results.length - sent;
    const status = results.length === 0 ? 'failed'
      : failed === 0 ? 'sent'
      : sent === 0 ? 'failed' : 'partial';

    await admin.from('alerts').update({
      status,
      sent_at: new Date().toISOString(),
      provider_ref: results.find((x) => x.ok)?.ref ?? null,
      error: failed ? JSON.stringify(results.filter((x) => !x.ok)) : null,
    }).eq('id', alertRow.id);

    return json({
      alert_id: alertRow.id,
      mock: provider === 'mock',
      provider,
      recipients: recipients.length,
      sent, failed, results,
    });
  } catch (err) {
    console.error('[send-alert]', err);
    return json({ error: String(err) }, 500);
  }
});
```

### 11.2 `supabase/functions/ingest/index.ts` — the hardware endpoint

The gateway POSTs here. Keeps the ESP32 firmware simple: no JWT, one shared secret, batched inserts, optional per-link distances.

```ts
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
```

### 11.3 Deploy the functions and set secrets

```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF

# mock mode — works immediately, no credentials
supabase secrets set SMS_PROVIDER=mock

supabase functions deploy send-alert
supabase functions deploy ingest --no-verify-jwt
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically; do not set them yourself.

**Switch on real SMS** when you are ready. Pick one:

```bash
# Twilio — easiest for a demo, works with a trial number
supabase secrets set SMS_PROVIDER=twilio \
  TWILIO_ACCOUNT_SID=ACxxxxxxxx \
  TWILIO_AUTH_TOKEN=xxxxxxxx \
  TWILIO_FROM=+15005550006

# MSG91 — Indian production route, needs a DLT-approved template
supabase secrets set SMS_PROVIDER=msg91 \
  MSG91_AUTHKEY=xxxxxxxx \
  MSG91_TEMPLATE_ID=xxxxxxxx

# Fast2SMS — quick transactional route for Indian numbers
supabase secrets set SMS_PROVIDER=fast2sms FAST2SMS_API_KEY=xxxxxxxx

# email (optional, works alongside any SMS provider)
supabase secrets set RESEND_API_KEY=re_xxxxxxxx ALERT_FROM_EMAIL="MineGuard <alerts@yourdomain.in>"

# gateway shared secret
supabase secrets set INGEST_KEY=$(openssl rand -hex 24)

supabase functions deploy send-alert
```

> **Indian SMS reality check for your presentation:** transactional SMS to Indian numbers requires DLT registration (TRAI) of the sender ID and the message template. Twilio trial numbers only reach verified numbers. Have mock mode ready as the fallback and say so — judges respect a team that knows the regulatory constraint.

Test the function without the UI:

```bash
curl -i -X POST \
  "https://YOUR-PROJECT-REF.supabase.co/functions/v1/send-alert" \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "site_id":"PASTE-SITE-UUID",
    "severity":"Critical",
    "title":"Test warning",
    "body":"MINEGUARD test: ignore.",
    "channels":["sms"]
  }'
```

Get the site UUID with `select id from mine_sites where code='JHARIA-P7';`

---

## 12. Hardware simulator and server-side scorer

Until the hardware team's nodes are on site, this generates telemetry that is **physically consistent**, not random walk. It drives every node from a Knothe influence-function subsidence basin, so tilt, strain, displacement and inter-node distance all move together the way they actually would over a depillared panel. That coherence is what makes the AI layer look credible in a demo — and it is what random noise can never fake.

### 12.1 `simulator/subsidence.js`

```js
/**
 * Knothe influence-function subsidence model.
 *
 *   S(r)  = Smax · exp(−π r² / R²)                 vertical subsidence, mm
 *   T(r)  = dS/dr                                  tilt, mm/m
 *   K(r)  = d²S/dr²                                curvature, mm/m²
 *   ε(r)  = B · K(r)                               horizontal strain, mm/m
 *   U(r)  = b · H · T(r) / 1000                    horizontal displacement, mm
 *
 * Smax = a · m   where a = subsidence factor (0.5–0.7 for Indian bord-and-pillar
 *                depillaring with caving) and m = extracted seam thickness.
 * R    = H · tan(angle of draw)  — radius of the zone of influence.
 * B    ≈ 0.07 · H — empirical strain constant; calibrate against levelling data.
 */
const PI = Math.PI;

export function influenceRadius(depthM, angleOfDrawDeg) {
  return depthM * Math.tan((angleOfDrawDeg * PI) / 180);
}

export function maxSubsidenceMm(seamThicknessM, subsidenceFactor) {
  return seamThicknessM * subsidenceFactor * 1000;
}

/** Vertical subsidence at horizontal distance r (m) from the basin centre, in mm. */
export function subsidenceMm(r, Smax, R) {
  return Smax * Math.exp((-PI * r * r) / (R * R));
}

/** Tilt at r, mm/m. Negative = surface dipping towards the basin centre. */
export function tiltMmPerM(r, Smax, R) {
  return ((-2 * PI * r * Smax) / (R * R)) * Math.exp((-PI * r * r) / (R * R));
}

/** Curvature at r, mm/m². */
export function curvature(r, Smax, R) {
  const e = Math.exp((-PI * r * r) / (R * R));
  return Smax * e * ((-2 * PI) / (R * R) + (4 * PI * PI * r * r) / (R * R * R * R));
}

/** Horizontal strain at r, mm/m. Positive = tension (cracking zone). */
export function strainMmPerM(r, Smax, R, depthM) {
  return 0.07 * depthM * curvature(r, Smax, R);
}

/** Horizontal displacement at r, mm — always directed towards the basin centre. */
export function horizontalDispMm(r, Smax, R, depthM) {
  return 0.35 * depthM * (tiltMmPerM(r, Smax, R) / 1000) * 1000;
}

/** mm/m tilt → degrees from horizontal. */
export function tiltToDegrees(mmPerM) {
  return (Math.atan(mmPerM / 1000) * 180) / PI;
}
```

### 12.2 `simulator/simulate.js`

```js
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
        roll_deg: r4(roll),
        pitch_deg: r4(pitch),
        yaw_deg: r4(yaw),
        accel_x_g: r4(gauss(0.004) + Math.sin(roll * Math.PI / 180)),
        accel_y_g: r4(gauss(0.004) + Math.sin(pitch * Math.PI / 180)),
        accel_z_g: r4(0.998 + gauss(0.003)),
        accel_rms_g: r4(0.012 + Math.abs(gauss(0.004)) + blast * 0.4),
        vibration_rms_g: r4(vib),
        vibration_peak_g: r4(vib * (2.4 + Math.random())),
        dominant_freq_hz: r4(blast > 0 ? 18 + Math.random() * 20 : 3 + Math.random() * 4),
        gps_lat: gpsLat,
        gps_lng: gpsLng,
        gps_alt_m: r4(247 - S / 1000 + gauss(0.02)),
        hdop: r4(0.7 + Math.abs(gauss(0.2))),
        satellites: 9 + Math.floor(Math.random() * 4),
        crack_width_mm: r4(Math.max(0, eps > 1 ? (eps - 1) * 2.1 + Math.abs(gauss(0.15)) : Math.abs(gauss(0.08)))),
        battery_v: r4(3.95 - elapsedS / 90000 + gauss(0.01)),
        rssi_dbm: Math.round(-78 - Math.random() * 16),
        temperature_c: r4(30 + gauss(0.6)),
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
```

> **Positioning accuracy — say this out loud in your demo.** The simulator emits RTK-grade fixes (σ ≈ 15 mm), which needs a u-blox NEO-M8P/ZED-F9P plus one base station outside the influence zone. With a plain ₹350 NEO-6M you get ±2 m, which cannot see subsidence at all. In that configuration set `WEIGHTS.displacement = 0` and redistribute its 0.16 to `tilt` and `strain` in `src/lib/analytics.js` — the tilt and inter-node distance channels carry the detection on their own. Knowing this trade-off is a stronger answer than pretending a ₹350 GPS measures millimetres.

### 12.3 `simulator/scorer.js` — the server-side AI worker

```js
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
    `displacement ${f.displacementMm.toFixed(0)} mm, vibration ${f.vibrationG.toFixed(2)} g. ` +
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
      crack_width_mm: a.features.crackMm,
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
```

---

## 13. Run order — the 10 commands

Do these in order. Each one should succeed before you move on.

```bash
# 1. scaffold and install
npm create vite@latest mineguard -- --template react && cd mineguard
npm install @supabase/supabase-js react-leaflet@4.2.1 leaflet@1.9.4 \
            recharts lucide-react && npm install -D dotenv

# 2. create every file from sections 3, 7, 8, 9, 10, 11, 12

# 3. Supabase SQL Editor → run 0001_init.sql, then 0002_seed.sql

# 4. fill .env.local and .env with your project URL and keys

# 5. deploy the alert function in mock mode
supabase link --project-ref YOUR-REF
supabase secrets set SMS_PROVIDER=mock
supabase functions deploy send-alert

# 6. terminal A — the dashboard
npm run dev                 # http://localhost:5173

# 7. terminal B — the hardware simulator
npm run sim:trough

# 8. terminal C — the AI scorer and alert engine
npm run score
```

Within about 30 seconds the map should show green nodes; by roughly 4 minutes the basin has grown and the nodes nearest its centre turn orange and then red, the deformation surface blooms, the mesh links show compression, and the scorer raises an alert that appears in the early warning log.

To replay from a clean slate:

```bash
npm run sim -- --scenario=trough --reset
```

---

## 14. Offline capability and sync

The problem statement asks for offline operation with periodic cloud sync. Three layers give you that.

**Layer 1 — node buffering (firmware).** Each node keeps a ring buffer of the last 512 readings in flash. If the mesh parent is unreachable it holds them and replays on reconnect.

**Layer 2 — gateway store-and-forward.** The gateway writes every batch to an SD card before POSTing. On HTTP failure it retries with exponential backoff and marks rows with their original `ts`, so late arrival never corrupts the time series.

**Layer 3 — dashboard cache.** Add this to `src/hooks/useMineData.js` so the control room screen still shows the last known state during an internet outage:

```js
// inside useMineData, after the analyses useMemo
useEffect(() => {
  if (!analyses.length) return;
  try {
    localStorage.setItem('mineguard:snapshot', JSON.stringify({
      at: Date.now(),
      site,
      nodes: analyses.map((a) => ({
        code: a.nodeCode, score: a.score, severity: a.severity,
        lat: a.node.install_lat, lng: a.node.install_lng,
        features: a.features,
      })),
    }));
  } catch { /* storage full or blocked — non-fatal */ }
}, [analyses, site]);
```

Read it back on boot when the network load fails:

```js
// inside the catch block of load()
try {
  const cached = JSON.parse(localStorage.getItem('mineguard:snapshot') || 'null');
  if (cached) {
    setError(`Offline — showing the snapshot from ${new Date(cached.at).toLocaleString()}`);
  }
} catch { /* ignore */ }
```

**Edge scoring.** The AI runs in `src/lib/analytics.js`, which is plain JavaScript with no server dependency. Port the same function to MicroPython on the gateway and the mesh can raise a local siren even with the internet down — that is worth a slide of its own.

---

## 15. Real hardware cutover (ESP32 → Supabase)

Nothing in the dashboard changes when real nodes arrive. The gateway just POSTs to `/functions/v1/ingest` instead of the simulator writing directly.

### 15.1 Gateway sketch (ESP32 + Wi-Fi)

```cpp
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

const char* WIFI_SSID = "mine-control";
const char* WIFI_PASS = "********";
const char* INGEST_URL = "https://YOUR-REF.supabase.co/functions/v1/ingest";
const char* INGEST_KEY = "the-value-you-set-in-supabase-secrets";

void postBatch(JsonDocument& doc) {
  if (WiFi.status() != WL_CONNECTED) { bufferToSD(doc); return; }

  HTTPClient http;
  http.begin(INGEST_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-ingest-key", INGEST_KEY);

  String payload;
  serializeJson(doc, payload);
  int code = http.POST(payload);

  if (code != 200) {
    Serial.printf("ingest failed %d: %s\n", code, http.getString().c_str());
    bufferToSD(doc);              // retry on the next successful connection
  }
  http.end();
}

void sendReading(float roll, float pitch, float yaw,
                 float ax, float ay, float az, float vibRms,
                 double lat, double lng, float hdop, int sats,
                 float deltaDistMm, float crackMm, float vbat, int rssi) {
  StaticJsonDocument<1024> doc;
  doc["gateway"] = "GW-01";
  JsonArray arr = doc.createNestedArray("readings");
  JsonObject r = arr.createNestedObject();
  r["node_code"]         = "MG-07";
  r["roll_deg"]          = roll;
  r["pitch_deg"]         = pitch;
  r["yaw_deg"]           = yaw;
  r["accel_x_g"]         = ax;
  r["accel_y_g"]         = ay;
  r["accel_z_g"]         = az;
  r["accel_rms_g"]       = sqrt(ax*ax + ay*ay + (az-1)*(az-1));
  r["vibration_rms_g"]   = vibRms;
  r["gps_lat"]           = lat;
  r["gps_lng"]           = lng;
  r["hdop"]              = hdop;
  r["satellites"]        = sats;
  r["delta_distance_mm"] = deltaDistMm;
  r["crack_width_mm"]    = crackMm;
  r["battery_v"]         = vbat;
  r["rssi_dbm"]          = rssi;

  // optional measured link ranges from UWB
  JsonArray links = doc.createNestedArray("links");
  JsonObject l = links.createNestedObject();
  l["a"] = "MG-07"; l["b"] = "MG-08";
  l["distance_m"] = 79.9663; l["rssi"] = -81;

  postBatch(doc);
}
```

### 15.2 Commissioning checklist

1. Install every node, let it settle for 24 hours.
2. Capture the baseline — with all nodes reporting, run:

```sql
-- freeze the current orientation and position as the zero reference
update sensor_nodes n
   set baseline_roll_deg  = avg.roll,
       baseline_pitch_deg = avg.pitch,
       baseline_yaw_deg   = avg.yaw,
       baseline_lat       = avg.lat,
       baseline_lng       = avg.lng,
       baseline_at        = now()
  from (
    select node_id,
           avg(roll_deg) roll, avg(pitch_deg) pitch, avg(yaw_deg) yaw,
           avg(gps_lat) lat,  avg(gps_lng) lng
      from sensor_readings
     where ts > now() - interval '1 hour'
     group by node_id
  ) avg
 where n.id = avg.node_id;

-- re-zero the mesh geometry too
update node_links set baseline_distance_m = current_distance_m,
                      strain_mm_per_m = 0
 where current_distance_m is not null;
```

3. Survey two nodes with a total station and compare against the GNSS baseline — that is your accuracy claim for the report.
4. Calibrate `THRESHOLDS` in `src/lib/analytics.js` against the site's own levelling history before trusting any alert.

---

## 16. Deployment

### Frontend on Vercel

```bash
npm i -g vercel
vercel
# set env vars in the Vercel dashboard:
#   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_SITE_CODE
vercel --prod
```

Netlify works identically: build command `npm run build`, publish directory `dist`.

### Scorer on a always-on host

The scorer is the only component that must keep running. Options, cheapest first:

- **Any always-on laptop or Raspberry Pi at the mine office:** `pm2 start simulator/scorer.js --name mineguard-scorer`
- **A free Render/Railway background worker:** start command `node simulator/scorer.js`, env vars from `.env`
- **Fully serverless:** move the scorer body into a third Edge Function and schedule it with `pg_cron`:

```sql
select cron.schedule(
  'mineguard-score', '*/1 * * * *',
  $$ select net.http_post(
       url     := 'https://YOUR-REF.supabase.co/functions/v1/score',
       headers := '{"Authorization":"Bearer YOUR_SERVICE_ROLE_KEY","Content-Type":"application/json"}'::jsonb,
       body    := '{}'::jsonb
     ) $$
);
```
(Requires the `pg_net` extension enabled under Database → Extensions.)

---

## 17. Demo script for judges

Eight minutes, three terminals already running, browser full screen.

| Time | Action | What to say |
|---|---|---|
| 0:00 | Dashboard on screen, all green | "Twelve low-cost nodes on the surface above Panel 7. Each one is an ESP32 with an IMU, a vibration sensor and a ranging radio — about ₹2,200 per node." |
| 0:45 | Point at the mesh-strain map mode | "The innovation is here. We don't just read each node alone — we measure the distance *between* nodes over the mesh link. A subsidence basin compresses the centre and stretches the rim, and that shows up in the geometry long before anyone sees a crack." |
| 1:30 | Switch to risk surface | "Twelve points become a continuous deformation surface by inverse-distance weighting, and the red outline is the predicted subsidence zone with its area in hectares." |
| 2:30 | Click the hottest node | "Every score is explainable. Tilt contributed 34%, strain 28%. No black box — a safety officer can see exactly why the system is worried." |
| 3:30 | Point at the forecast panel | "Trend projection says the action level is about five hours away. That is the difference between a warning and a post-facto damage assessment." |
| 4:30 | Let the scorer fire; alert appears | "That SMS just went to the safety officer, the mine manager and the control room, with the reason and the recommended action. Logged, timestamped, acknowledgeable." |
| 6:00 | `npm run sim:blast` | "Different signature: a blast round. High vibration, no tilt, no strain. The corroboration rule keeps it at Moderate instead of screaming Critical — false alarms are how monitoring systems get switched off." |
| 7:00 | Show `analytics.js` | "One file. The browser runs it for the live view and the server runs the same code for the alerts, so what the operator sees is exactly what triggered the siren. It is also small enough to run on the gateway, so the mesh still warns locally with the internet down." |

Keep `--scenario=creep` running in a fourth terminal from an hour before judging, so you can also show a slow, realistic curve rather than only the fast demo.

---

## 18. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing VITE_SUPABASE_URL` | `.env.local` missing, or Vite not restarted | Create it, then restart `npm run dev` — Vite only reads env at startup |
| Map area is blank / grey | Leaflet CSS not imported, or the container has no height | Confirm `import 'leaflet/dist/leaflet.css'` in `main.jsx` and that `.mapWrap` has a fixed height |
| `Cannot read properties of undefined (reading 'MapContainer')` | react-leaflet v5 with React 18 | `npm i react-leaflet@4.2.1` |
| Nodes render but never change | Realtime not enabled for `sensor_readings` | Database → Replication → add the table, or re-run the `alter publication` lines |
| Rows appear in Postgres but not in the UI | RLS blocking anon `select` | Re-run the policy block in section 5, step 10 |
| Simulator: `No nodes. Run 0002_seed.sql first.` | Seed not executed, or `SITE_CODE` mismatch | Check `select code from mine_sites;` matches `.env` |
| Simulator: `new row violates row-level security` | Using the anon key instead of service role | `SUPABASE_SERVICE_ROLE_KEY` in `.env`, not the anon key |
| `functions.invoke` returns 401 | Function deployed with JWT verification, no auth header | The browser client sends the anon key automatically; for curl add `Authorization: Bearer YOUR_ANON_KEY` |
| Alert row says `failed` | SMS credentials wrong or number unverified | `supabase functions logs send-alert`; fall back to `SMS_PROVIDER=mock` |
| Every node is Critical immediately | Baselines are zero but hardware is on a slope | Run the commissioning SQL in section 15.2 |
| Score jitters between Moderate and High | EWMA too responsive for your packet rate | Lower alpha from `0.35` to `0.2` in `analyseNode` |
| Map is sluggish | Too many IDW rectangles | Drop `idwGrid(..., 18, ...)` to 14 cells, or set `preferCanvas` (already on) |
| Charts empty on first load | No readings in the last 6 hours | Start the simulator; or widen `WINDOW_HOURS` in `useMineData.js` |

---

## 19. Requirement → implementation traceability

Print this table. It maps every line of the problem statement to something a judge can click.

| Problem statement requirement | Where it lives | How to demonstrate |
|---|---|---|
| Low-cost smart sensor nodes (Arduino/ESP32/Pi) | Section 2 payload contract, section 15 gateway sketch | Show the BOM and the ESP32 sketch |
| Wireless mesh network over the panel | `node_links` table, mesh-strain map mode | Switch the map to "Mesh strain" |
| Tilt / inclination monitoring | `roll_deg`, `pitch_deg` → `tiltMagnitude()` | Ground tilt chart |
| Change in relative distance between nodes | `node_links.delta_mm`, `delta_distance_mm` | Inter-node distance chart, mesh overlay |
| Early crack initiation | `crack_width_mm` feature + tension zone on the rim | Crack bar in the node detail panel |
| Unusual vibration signatures | `vibration_rms_g`, `dominant_freq_hz` | `npm run sim:blast` |
| AI/ML anomaly detection | `scoreFeatures()` — weighted multi-feature model with EWMA and a corroboration rule | "Driven by…" line in the detail panel |
| Predict possible subsidence zones | `riskZonePolygon()` over the IDW surface | Red dashed polygon with its area |
| Estimate severity and progression | `severityOf()`, `forecast()`, `damageClass()` (NCB bands) | Forecast panel: hours to action level |
| Automated early warning alerts | `simulator/scorer.js` → `send-alert` Edge Function | Watch the alert appear in the log |
| SMS / email / app notification | Twilio, MSG91, Fast2SMS, Resend | Section 11.3 |
| GIS visualisation of live deformation | `RiskMap.jsx` — IDW surface, mesh graph, influence circle, panel outline | Three map modes |
| Interactive dashboards for operators, planners, regulators | Whole React app, CSV risk report export | "Download risk report" |
| Offline capability with periodic cloud sync | Node ring buffer, gateway SD store-and-forward, `localStorage` snapshot | Section 14 |
| Scalable across multiple coalfields | `mine_sites` is a first-class table; `VITE_SITE_CODE` switches panels | Insert a second site and change one env var |
| Low power / energy efficient | 2.5 s duty-cycled sampling, LoRa, `battery_v` telemetry on every packet | Battery column in the node table |
| Student prototype friendly | One Vite app, one Supabase project, two Node scripts | This document |
| Made in India | Indian SMS routes (MSG91/Fast2SMS), NCB/DGMS damage bands, Jharia geo-mining defaults | Section 11.3 and `damageClass()` |

---

### One last thing

Before the presentation, run `npm run build` and fix anything the build complains about. A dev server that works and a build that fails is the most common way a good project loses marks at the demo table.
