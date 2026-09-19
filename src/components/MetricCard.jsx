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
