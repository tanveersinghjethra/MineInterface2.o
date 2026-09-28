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
          label={FEATURE_LABELS.deltaPos} value={features.deltaPos} unit="mm"
          warn={THRESHOLDS.deltaPos.warn} crit={THRESHOLDS.deltaPos.crit} decimals={1} />
      </div>

      <div className="rawGrid">
        <div><Compass size={13} /><span>Roll / Pitch / Yaw</span>
          <b>{Number(latest?.angle_roll ?? 0).toFixed(2)}° · {Number(latest?.angle_pitch ?? 0).toFixed(2)}° · {Number(latest?.angle_yaw ?? 0).toFixed(1)}°</b>
        </div>
        <div><Activity size={13} /><span>Accel (X/Y/Z) & Resultant</span>
          <b>{Number(latest?.acc_x_ms2 ?? 0).toFixed(2)} / {Number(latest?.acc_y_ms2 ?? 0).toFixed(2)} / {Number(latest?.acc_z_ms2 ?? 0).toFixed(2)} m/s² · <span style={{color: '#f5c542'}}>{features.resAccel?.toFixed(2)} m/s²</span></b>
        </div>
        <div><Activity size={13} /><span>Gyro Rates (R/P/Y)</span>
          <b>{Number(latest?.rate_roll ?? 0).toFixed(1)} / {Number(latest?.rate_pitch ?? 0).toFixed(1)} / {Number(latest?.rate_yaw ?? 0).toFixed(1)} °/s</b>
        </div>
        <div><Waves size={13} /><span>Delta X / Y / Z</span>
          <b>{features.deltax.toFixed(2)} / {features.deltay.toFixed(2)} / {features.deltaz.toFixed(2)} mm</b>
        </div>
        <div><MapPin size={13} /><span>GNSS fix & Altitude</span>
          <b>{latest?.latitude ? fmtLatLng(latest.latitude, latest.longitude) : '—'} · {latest?.altitude ? `${Number(latest.altitude).toFixed(1)} m` : '—'}</b>
        </div>
        <div><Signal size={13} /><span>Latest Sequence</span>
          <b>#{latest?.sequence_number ?? '—'} · {latest?.is_high_precision ? 'RTK Fixed' : 'Float'}</b>
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
