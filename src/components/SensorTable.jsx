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
