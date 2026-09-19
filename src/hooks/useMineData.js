import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase, SITE_CODE } from '../lib/supabaseClient.js';
import { analyseNode, HISTORY_LIMIT } from '../lib/analytics.js';

const FLUSH_MS = 900;          // batch incoming packets into one render
const WINDOW_HOURS = 6;        // history depth pulled on first load

export function useMineData(siteCode = SITE_CODE) {
  const [site, setSite] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [links, setLinks] = useState([]);
  const [readings, setReadings] = useState({});   // nodeId -> ascending array
  const [connection, setConnection] = useState('connecting');
  const [lastSync, setLastSync] = useState(null);
  const [error, setError] = useState(null);

  const buffer = useRef([]);
  const prevScores = useRef(new Map());           // nodeId -> { ts, score }

  // ── initial load ──────────────────────────────────────────
  const load = useCallback(async () => {
    try {
      setError(null);

      const { data: siteRow, error: e1 } = await supabase
        .from('mine_sites').select('*').eq('code', siteCode).single();
      if (e1) throw e1;
      setSite(siteRow);

      const { data: nodeRows, error: e2 } = await supabase
        .from('sensor_nodes').select('*')
        .eq('site_id', siteRow.id).order('node_code');
      if (e2) throw e2;
      setNodes(nodeRows || []);

      const { data: linkRows, error: e3 } = await supabase
        .from('node_links').select('*').eq('site_id', siteRow.id);
      if (e3) throw e3;
      setLinks(linkRows || []);

      const since = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString();
      const { data: readRows, error: e4 } = await supabase
        .from('sensor_readings').select('*')
        .gte('ts', since).order('ts', { ascending: true }).limit(6000);
      if (e4) throw e4;

      const grouped = {};
      for (const r of readRows || []) (grouped[r.node_id] ||= []).push(r);
      for (const k of Object.keys(grouped)) {
        grouped[k] = grouped[k].slice(-HISTORY_LIMIT);
      }
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
  }, [siteCode]);

  useEffect(() => { load(); }, [load]);

  // ── realtime subscription ─────────────────────────────────
  useEffect(() => {
    if (!site) return undefined;

    const channel = supabase
      .channel('mineguard-stream')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'sensor_readings' },
        (payload) => { buffer.current.push(payload.new); })
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'node_links' },
        (payload) => {
          setLinks((prev) =>
            prev.map((l) => (l.id === payload.new.id ? payload.new : l)));
        })
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'sensor_nodes' },
        (payload) => {
          setNodes((prev) =>
            prev.map((n) => (n.id === payload.new.id ? { ...n, ...payload.new } : n)));
        })
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
      setReadings((prev) => {
        const next = { ...prev };
        for (const r of batch) {
          const arr = next[r.node_id] ? [...next[r.node_id], r] : [r];
          next[r.node_id] = arr.slice(-HISTORY_LIMIT);
        }
        return next;
      });
      setLastSync(new Date());
    }, FLUSH_MS);

    return () => { clearInterval(timer); supabase.removeChannel(channel); };
  }, [site]);

  // ── AI analysis (idempotent EWMA, safe under StrictMode) ──
  const analyses = useMemo(() => {
    return nodes.map((node) => {
      const hist = readings[node.id] || [];
      const nodeLinks = links.filter(
        (l) => l.node_a === node.id || l.node_b === node.id);
      const lastTs = hist.length ? hist[hist.length - 1].ts : null;
      const cached = prevScores.current.get(node.id);
      const prev = cached && cached.ts === lastTs ? cached.prev : cached?.score ?? null;

      const a = analyseNode(node, hist, nodeLinks, prev);
      prevScores.current.set(node.id, { ts: lastTs, score: a.score, prev });

      const latest = hist[hist.length - 1] || null;
      return { ...a, node, latest, links: nodeLinks, historyLength: hist.length };
    });
  }, [nodes, links, readings]);

  // offline snapshot cache
  useEffect(() => {
    if (!analyses.length) return;
    try {
      localStorage.setItem('mineguard:snapshot', JSON.stringify({
        at: Date.now(),
        site,
        nodes: analyses.map((a) => ({
          code: a.nodeCode, score: a.score, severity: a.severity,
          lat: a.node.install_lat, lng: a.node.install_lng,
          features: a.features,
        })),
      }));
    } catch { /* storage full or blocked */ }
  }, [analyses, site]);

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

  return {
    site, nodes, links, readings, analyses, byId, summary,
    connection, lastSync, error, refresh: load,
  };
}
