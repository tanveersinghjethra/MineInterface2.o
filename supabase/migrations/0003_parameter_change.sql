-- ============================================================
-- MineGuard 0003_parameter_change.sql  (FIXED)
-- Must drop dependent views before altering columns
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 0. Drop dependent views first (they use SELECT *)
-- ────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS v_node_dashboard;
DROP VIEW IF EXISTS v_latest_reading;
DROP VIEW IF EXISTS v_latest_score;

-- ────────────────────────────────────────────────────────────
-- 1. sensor_readings — drop old columns, add new ones
-- ────────────────────────────────────────────────────────────
ALTER TABLE sensor_readings DROP COLUMN IF EXISTS accel_x_g;
ALTER TABLE sensor_readings DROP COLUMN IF EXISTS accel_y_g;
ALTER TABLE sensor_readings DROP COLUMN IF EXISTS accel_z_g;
ALTER TABLE sensor_readings DROP COLUMN IF EXISTS crack_width_mm;
ALTER TABLE sensor_readings DROP COLUMN IF EXISTS temperature_c;
ALTER TABLE sensor_readings DROP COLUMN IF EXISTS dominant_freq_hz;

ALTER TABLE sensor_readings ADD COLUMN IF NOT EXISTS deltax numeric;
ALTER TABLE sensor_readings ADD COLUMN IF NOT EXISTS deltay numeric;
ALTER TABLE sensor_readings ADD COLUMN IF NOT EXISTS deltaz numeric;

-- ────────────────────────────────────────────────────────────
-- 2. anomaly_scores — drop crack_width_mm, add deltax/y/z
-- ────────────────────────────────────────────────────────────
ALTER TABLE anomaly_scores DROP COLUMN IF EXISTS crack_width_mm;

ALTER TABLE anomaly_scores ADD COLUMN IF NOT EXISTS deltax numeric;
ALTER TABLE anomaly_scores ADD COLUMN IF NOT EXISTS deltay numeric;
ALTER TABLE anomaly_scores ADD COLUMN IF NOT EXISTS deltaz numeric;

-- ────────────────────────────────────────────────────────────
-- 3. Recreate all three views
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_latest_reading AS
SELECT DISTINCT ON (node_id) *
FROM sensor_readings
ORDER BY node_id, ts DESC;

CREATE OR REPLACE VIEW v_latest_score AS
SELECT DISTINCT ON (node_id) *
FROM anomaly_scores
ORDER BY node_id, ts DESC;

CREATE OR REPLACE VIEW v_node_dashboard AS
SELECT
  n.id, n.site_id, n.node_code, n.label, n.mesh_role, n.status,
  n.install_lat, n.install_lng,
  n.baseline_roll_deg, n.baseline_pitch_deg, n.baseline_yaw_deg,
  n.baseline_lat, n.baseline_lng, n.mean_link_length_m,
  r.ts               AS last_ts,
  r.roll_deg, r.pitch_deg, r.yaw_deg,
  r.accel_rms_g, r.vibration_rms_g, r.vibration_peak_g,
  r.gps_lat, r.gps_lng, r.hdop, r.satellites,
  r.delta_distance_mm,
  r.deltax, r.deltay, r.deltaz,
  r.battery_v, r.rssi_dbm,
  s.score, s.severity, s.tilt_delta_deg, s.strain_mm_per_m,
  s.displacement_mm, s.contributions, s.forecast_24h
FROM sensor_nodes n
LEFT JOIN v_latest_reading r ON r.node_id = n.id
LEFT JOIN v_latest_score   s ON s.node_id = n.id;

-- ────────────────────────────────────────────────────────────
-- 4. Clear old data
-- ────────────────────────────────────────────────────────────
DELETE FROM sensor_readings WHERE true;
DELETE FROM anomaly_scores WHERE true;
