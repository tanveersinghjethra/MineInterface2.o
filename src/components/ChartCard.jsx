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
          {latest}<em>{unit === 'degrees' || unit === '°' ? '°' : unit === '°/s' ? ' °/s' : unit === 'm/s²' ? ' m/s²' : unit === 'g' ? ' g' : unit === 'mm' ? ' mm' : ` ${unit}`}</em>
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
