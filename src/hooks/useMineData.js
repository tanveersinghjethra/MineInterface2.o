import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { analyseNode, HISTORY_LIMIT } from '../lib/analytics.js';

const FLUSH_MS = 900;          // batch incoming packets into one render
const WINDOW_HOURS = 6;        // history depth pulled on first load

export function useMineData() {
  const [nodes, setNodes] = useState([]);       // unique node_numbers seen
  const [readings, setReadings] = useState({});  // node_number -> ascending array
  const [connection, setConnection] = useState('connecting');
  const [lastSync, setLastSync] = useState(null);
  const [error, setError] = useState(null);

  const buffer = useRef([]);
  const prevScores = useRef(new Map());           // nodeNumber -> { ts, score }

  // ── initial load ──────────────────────────────────────────
  const load = useCallback(async () => {
    try {
      setError(null);

      let { data: readRows, error: e1 } = await supabase
        .from('telemetry').select('*')
        .order('updated_at', { ascending: false })
        .limit(2000);
      if (e1) throw e1;
      
      if (readRows && readRows.length) {
        readRows = readRows.reverse();
      }

      // Discover unique nodes from the data
      const nodeSet = new Map();
      const grouped = {};
      for (const r of readRows || []) {
        const nn = r.node_number;
        if (!nodeSet.has(nn)) {
          nodeSet.set(nn, {
            id: nn,
            node_number: nn,
            node_code: `MG-${String(nn).padStart(2, '0')}`,
            label: `Sensor Node ${nn}`,
            mesh_role: 'telemetry-node',
            radio: 'LoRa / IoT',
            status: 'online',
            install_lat: Number(r.latitude) || 30.3583 + (nn - 1) * 0.0003,
            install_lng: Number(r.longitude) || 76.3676 + (nn - 1) * 0.0004,
          });
        }
        (grouped[nn] ||= []).push(r);
      }
      for (const k of Object.keys(grouped)) {
        grouped[k] = grouped[k].slice(-HISTORY_LIMIT);
      }

      setNodes(Array.from(nodeSet.values()));
      setReadings(grouped);
      setLastSync(new Date());
    } catch (err) {
      console.error('[mineguard] load failed', err);
      try {
        const cached = JSON.parse(localStorage.getItem('mineguard:snapshot') || 'null');
        if (cached) {
          setError(`Offline — showing snapshot from ${new Date(cached.at).toLocaleString()}`);
          return;
        }
      } catch { /* ignore */ }
      setError(err.message || String(err));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── realtime subscription ─────────────────────────────────
  useEffect(() => {
    const channel = supabase
      .channel('mineguard-stream')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'telemetry' },
        (payload) => { buffer.current.push(payload.new); })
      .subscribe((s) => {
        setConnection(
          s === 'SUBSCRIBED' ? 'live'
          : s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' ? 'error'
          : 'connecting');
      });

    const timer = setInterval(() => {
      if (!buffer.current.length) return;
      const batch = buffer.current;
      buffer.current = [];

      // Discover new nodes from realtime
      setNodes((prev) => {
        const existing = new Set(prev.map((n) => n.node_number));
        const newNodes = [...prev];
        for (const r of batch) {
          if (!existing.has(r.node_number)) {
            existing.add(r.node_number);
            newNodes.push({
              id: r.node_number,
              node_number: r.node_number,
              node_code: `MG-${String(r.node_number).padStart(2, '0')}`,
              label: `Sensor Node ${r.node_number}`,
              mesh_role: 'telemetry-node',
              radio: 'LoRa / IoT',
              status: 'online',
              install_lat: Number(r.latitude) || 30.3583 + (r.node_number - 1) * 0.0003,
              install_lng: Number(r.longitude) || 76.3676 + (r.node_number - 1) * 0.0004,
            });
          }
        }
        return newNodes.length !== prev.length ? newNodes : prev;
      });

      setReadings((prev) => {
        const next = { ...prev };
        for (const r of batch) {
          const nn = r.node_number;
          const arr = next[nn] ? [...next[nn], r] : [r];
          next[nn] = arr.slice(-HISTORY_LIMIT);
        }
        return next;
      });
      setLastSync(new Date());
    }, FLUSH_MS);

    return () => { clearInterval(timer); supabase.removeChannel(channel); };
  }, []);

  // ── AI analysis (idempotent EWMA, safe under StrictMode) ──
  const analyses = useMemo(() => {
    return nodes.map((node) => {
      const hist = readings[node.node_number] || [];
      const lastTs = hist.length ? hist[hist.length - 1].updated_at : null;
      const cached = prevScores.current.get(node.node_number);
      const prev = cached && cached.ts === lastTs ? cached.prev : cached?.score ?? null;

      const a = analyseNode(node, hist, [], prev);
      prevScores.current.set(node.node_number, { ts: lastTs, score: a.score, prev });

      const latest = hist[hist.length - 1] || null;
      return { ...a, node, latest, links: [], historyLength: hist.length };
    });
  }, [nodes, readings]);

  // offline snapshot cache
  useEffect(() => {
    if (!analyses.length) return;
    try {
      localStorage.setItem('mineguard:snapshot', JSON.stringify({
        at: Date.now(),
        nodes: analyses.map((a) => ({
          code: a.nodeCode, score: a.score, severity: a.severity,
          lat: a.node.install_lat, lng: a.node.install_lng,
          features: a.features,
        })),
      }));
    } catch { /* storage full or blocked */ }
  }, [analyses]);

  const byId = useMemo(
    () => Object.fromEntries(analyses.map((a) => [a.nodeId, a])), [analyses]);

  const summary = useMemo(() => {
    const n = analyses.length || 1;
    const critical = analyses.filter((a) => a.severity === 'Critical').length;
    const high = analyses.filter((a) => a.score >= 0.6).length;
    const online = nodes.filter((x) => x.status === 'online').length;
    const maxStrain = Math.max(0,
      ...analyses.map((a) => Math.abs(a.features.strainMmPerM)));
    const maxDisp = Math.max(0, ...analyses.map((a) => a.features.displacementMm));
    return {
      nodeCount: nodes.length,
      online,
      health: nodes.length ? (online / nodes.length) * 100 : 0,
      critical,
      high,
      avgScore: analyses.reduce((s, a) => s + a.score, 0) / n,
      maxScore: Math.max(0, ...analyses.map((a) => a.score)),
      maxStrain,
      maxDisp,
    };
  }, [analyses, nodes]);

  const site = useMemo(() => {
    let lat = 30.3583;
    let lng = 76.3676;
    if (nodes.length > 0) {
      const valid = nodes.filter(n => n.install_lat && n.install_lng);
      if (valid.length > 0) {
        lat = valid.reduce((s, n) => s + n.install_lat, 0) / valid.length;
        lng = valid.reduce((s, n) => s + n.install_lng, 0) / valid.length;
      }
    }
    return {
      id: '1',
      code: import.meta.env.VITE_SITE_CODE || 'LIVE-MESH',
      name: 'Mine Telemetry Grid',
      district: 'Sector Alpha',
      state: 'Live Feed',
      centroid_lat: lat,
      centroid_lng: lng,
      panel_depth_m: 120,
      seam_thickness_m: 3.0,
      extraction_ratio: 0.65,
      angle_of_draw_deg: 35,
    };
  }, [nodes]);

  return {
    site, nodes, links: [], readings, analyses, byId, summary,
    connection, lastSync, error, refresh: load,
  };
}
