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
