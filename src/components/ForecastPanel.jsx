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
