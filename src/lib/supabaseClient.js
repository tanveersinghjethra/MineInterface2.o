import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. ' +
    'Create .env.local from the template in the guide, then restart `npm run dev`.'
  );
}

export const supabase = createClient(url, key, {
  realtime: { params: { eventsPerSecond: 20 } },
  auth: { persistSession: false },
});

export const SITE_CODE = import.meta.env.VITE_SITE_CODE || 'JHARIA-P7';
