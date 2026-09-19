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
      value = tiltMagnitude((Number(r.roll_rate) || 0) - roll0,
        (Number(r.pitch_rate) || 0) - pitch0);
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
      'strain_mm_per_m', 'displacement_mm', 'vibration_g', 'deltax', 'deltay', 'deltaz', 'delta_pos_mm',
      'damage_class', 'forecast_24h_strain', 'hours_to_threshold', 'last_packet',
    ].join(',');
    const rows = analyses.map((a) => [
      a.nodeCode, a.severity, a.score,
      a.features.tiltDeltaDeg.toFixed(3),
      a.features.tiltRateDegHr.toFixed(4),
      a.features.strainMmPerM.toFixed(3),
      a.features.displacementMm.toFixed(1),
      a.features.vibrationG.toFixed(3),
      a.features.deltax.toFixed(2),
      a.features.deltay.toFixed(2),
      a.features.deltaz.toFixed(2),
      a.features.deltaPos.toFixed(1),
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
          `displacement ${f.displacementMm.toFixed(0)} mm, ` +
          `ΔX ${f.deltax.toFixed(1)} / ΔY ${f.deltay.toFixed(1)} / ΔZ ${f.deltaz.toFixed(1)} mm. ` +
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

            title="Peak risk score"
            value={summary.maxScore.toFixed(2)}
            unit="/ 1.00"
            sub={`${summary.high} node${summary.high === 1 ? '' : 's'} above watch level`}
            danger={summary.maxScore >= 0.8}
          />
          <MetricCard

            title="Horizontal strain"
            value={summary.maxStrain.toFixed(2)}
            unit="mm/m"
            sub={`action level ${THRESHOLDS.strainMmPerM.crit} mm/m`}
            danger={summary.maxStrain >= THRESHOLDS.strainMmPerM.crit}
          />
          <MetricCard

            title="Surface displacement"
            value={summary.maxDisp.toFixed(0)}
            unit="mm"
            sub="largest movement from baseline"
            danger={summary.maxDisp >= THRESHOLDS.displacementMm.crit}
          />
          <MetricCard

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
