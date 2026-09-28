import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';

export function useAlerts(limit = 25) {
  const [alerts, setAlerts] = useState([]);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('alerts').select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) { console.error('[mineguard] alerts load', error); return; }
    setAlerts(data || []);
  }, [limit]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const ch = supabase
      .channel('mineguard-alerts')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'alerts' },
        () => load())
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [load]);

  /** Fire the early-warning Edge Function. Returns the function's JSON. */
  const dispatch = useCallback(async (payload) => {
    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke('send-alert', {
        body: payload,
      });
      if (error) throw error;
      await load();
      return data;
    } finally {
      setSending(false);
    }
  }, [load]);

  const acknowledge = useCallback(async (id, who = 'Control Room') => {
    const { error } = await supabase
      .from('alerts')
      .update({ status: 'acknowledged', acknowledged_by: who,
                acknowledged_at: new Date().toISOString() })
      .eq('id', id);
    if (error) console.error('[mineguard] ack failed', error);
    await load();
  }, [load]);

  return { alerts, sending, dispatch, acknowledge, reload: load };
}
