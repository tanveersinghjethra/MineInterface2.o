-- ============================================================
-- MineGuard 0002_new_schema.sql
-- Supporting tables for the new single-telemetry-table database.
--
-- The `telemetry` table already exists in Supabase with live
-- hardware data. This migration adds the scoring, alerting,
-- and housekeeping infrastructure around it.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Indexes on telemetry for dashboard queries
-- ------------------------------------------------------------
create index if not exists idx_telemetry_node_updated
  on telemetry(node_number, updated_at desc);

create index if not exists idx_telemetry_updated
  on telemetry(updated_at desc);

-- ------------------------------------------------------------
-- 2. Anomaly scores — AI/EWMA scoring output
-- ------------------------------------------------------------
create table if not exists anomaly_scores (
  id                bigserial primary key,
  node_number       bigint not null,
  ts                timestamptz not null default now(),
  score             numeric not null check (score >= 0 and score <= 1),
  severity          text not null
                    check (severity in ('Low','Moderate','High','Critical')),
  tilt_delta_deg    numeric,
  tilt_rate_deg_hr  numeric,
  strain_mm_per_m   numeric,
  displacement_mm   numeric,
  vibration_detected boolean,
  disp_x_m          numeric,
  disp_y_m          numeric,
  disp_z_m          numeric,
  contributions     jsonb,
  forecast_24h      jsonb,
  model_version     text default 'mineguard-ewma-v2'
);
create index if not exists idx_scores_node_ts
  on anomaly_scores(node_number, ts desc);

-- ------------------------------------------------------------
-- 3. Alerts — early warning system
-- ------------------------------------------------------------
create table if not exists alerts (
  id              uuid primary key default gen_random_uuid(),
  node_number     bigint,
  severity        text not null
                  check (severity in ('Moderate','High','Critical')),
  score           numeric,
  title           text not null,
  body            text not null,
  channels        text[] default array['sms'],
  recipients      jsonb,
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
create index if not exists idx_alerts_created
  on alerts(created_at desc);

-- ------------------------------------------------------------
-- 4. Alert recipients
-- ------------------------------------------------------------
create table if not exists alert_recipients (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  role          text not null,
  phone         text,
  email         text,
  min_severity  text default 'High'
                check (min_severity in ('Moderate','High','Critical')),
  active        boolean default true,
  created_at    timestamptz default now()
);

-- ------------------------------------------------------------
-- 5. Convenience view: latest reading per node
-- ------------------------------------------------------------
create or replace view v_latest_telemetry as
select distinct on (node_number) *
from telemetry
order by node_number, updated_at desc;

-- ------------------------------------------------------------
-- 6. Convenience view: latest score per node
-- ------------------------------------------------------------
create or replace view v_latest_score as
select distinct on (node_number) *
from anomaly_scores
order by node_number, ts desc;

-- ------------------------------------------------------------
-- 7. Housekeeping: prune old data
-- ------------------------------------------------------------
create or replace function prune_telemetry(keep_days int default 7) returns void
language sql as $$
  delete from telemetry where updated_at < now() - (keep_days || ' days')::interval;
  delete from anomaly_scores where ts < now() - (keep_days || ' days')::interval;
$$;

-- ------------------------------------------------------------
-- 8. Row Level Security
--    Anonymous READ on telemetry, scores, alerts.
--    WRITE only via service_role (gateway + scorer).
-- ------------------------------------------------------------
alter table telemetry        enable row level security;
alter table anomaly_scores   enable row level security;
alter table alerts           enable row level security;
alter table alert_recipients enable row level security;

-- Read policies for public dashboard
do $$
declare t text;
begin
  foreach t in array array[
    'telemetry','anomaly_scores','alerts'
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
-- 9. Realtime publication
-- ------------------------------------------------------------
do $$
begin
  begin
    alter publication supabase_realtime add table telemetry;
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
end $$;
