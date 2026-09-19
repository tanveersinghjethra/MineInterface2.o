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
