// supabase/functions/send-alert/index.ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const RANK: Record<string, number> = { Moderate: 1, High: 2, Critical: 3 };

interface Recipient {
  id: string; name: string; role: string;
  phone: string | null; email: string | null; min_severity: string;
}

// ── SMS providers ───────────────────────────────────────────
async function sendTwilio(to: string, text: string) {
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID')!;
  const token = Deno.env.get('TWILIO_AUTH_TOKEN')!;
  const from = Deno.env.get('TWILIO_FROM')!;
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${sid}:${token}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: text }),
    });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || 'twilio failed');
  return json.sid as string;
}

async function sendMsg91(to: string, vars: Record<string, string>) {
  const res = await fetch('https://control.msg91.com/api/v5/flow/', {
    method: 'POST',
    headers: {
      authkey: Deno.env.get('MSG91_AUTHKEY')!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      template_id: Deno.env.get('MSG91_TEMPLATE_ID'),
      short_url: '0',
      recipients: [{ mobiles: to.replace('+', ''), ...vars }],
    }),
  });
  const json = await res.json();
  if (!res.ok || json.type === 'error') throw new Error(JSON.stringify(json));
  return json.request_id ?? 'msg91-ok';
}

async function sendFast2Sms(to: string, text: string) {
  const res = await fetch('https://www.fast2sms.com/dev/bulkV2', {
    method: 'POST',
    headers: {
      authorization: Deno.env.get('FAST2SMS_API_KEY')!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      route: 'q',
      message: text,
      language: 'english',
      numbers: to.replace('+91', '').replace('+', ''),
    }),
  });
  const json = await res.json();
  if (!json.return) throw new Error(JSON.stringify(json));
  return json.request_id ?? 'fast2sms-ok';
}

async function sendEmail(to: string, subject: string, text: string) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) return null;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: Deno.env.get('ALERT_FROM_EMAIL') || 'MineGuard <alerts@resend.dev>',
      to: [to],
      subject,
      html: `<pre style="font:14px/1.6 system-ui;white-space:pre-wrap">${text}</pre>`,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || 'email failed');
  return json.id as string;
}

// ── handler ─────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), {
      status, headers: { ...cors, 'Content-Type': 'application/json' },
    });

  try {
    const payload = await req.json();
    const {
      site_id, node_id, severity = 'High', score = null,
      title, body, channels = ['sms'], triggered_by = 'auto',
    } = payload;

    if (!site_id || !title || !body) {
      return json({ error: 'site_id, title and body are required' }, 400);
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } });

    // who should hear about this severity
    const { data: all, error: rErr } = await admin
      .from('alert_recipients')
      .select('*').eq('site_id', site_id).eq('active', true);
    if (rErr) throw rErr;

    const recipients = (all as Recipient[]).filter(
      (r) => RANK[severity] >= RANK[r.min_severity]);

    // audit row first, so nothing is ever sent without a record
    const { data: alertRow, error: aErr } = await admin
      .from('alerts')
      .insert({
        site_id, node_id, severity, score, title, body, channels,
        triggered_by, status: 'queued',
        recipients: recipients.map((r) => ({ name: r.name, role: r.role, phone: r.phone })),
      })
      .select().single();
    if (aErr) throw aErr;

    const provider = (Deno.env.get('SMS_PROVIDER') || 'mock').toLowerCase();
    const results: { to: string; ok: boolean; ref?: string; error?: string }[] = [];

    for (const r of recipients) {
      // SMS
      if (channels.includes('sms') && r.phone) {
        try {
          let ref = 'mock';
          if (provider === 'twilio') ref = await sendTwilio(r.phone, body);
          else if (provider === 'msg91') {
            ref = await sendMsg91(r.phone, {
              VAR1: severity, VAR2: title, VAR3: String(score ?? ''),
            });
          } else if (provider === 'fast2sms') ref = await sendFast2Sms(r.phone, body);
          else console.log(`[mock-sms] → ${r.phone}: ${body}`);
          results.push({ to: r.phone, ok: true, ref });
        } catch (e) {
          results.push({ to: r.phone, ok: false, error: String(e) });
        }
      }
      // Email
      if (channels.includes('email') && r.email) {
        try {
          const ref = await sendEmail(r.email, title, body);
          results.push({ to: r.email, ok: true, ref: ref ?? 'email-skipped' });
        } catch (e) {
          results.push({ to: r.email, ok: false, error: String(e) });
        }
      }
    }

    const sent = results.filter((x) => x.ok).length;
    const failed = results.length - sent;
    const status = results.length === 0 ? 'failed'
      : failed === 0 ? 'sent'
      : sent === 0 ? 'failed' : 'partial';

    await admin.from('alerts').update({
      status,
      sent_at: new Date().toISOString(),
      provider_ref: results.find((x) => x.ok)?.ref ?? null,
      error: failed ? JSON.stringify(results.filter((x) => !x.ok)) : null,
    }).eq('id', alertRow.id);

    return json({
      alert_id: alertRow.id,
      mock: provider === 'mock',
      provider,
      recipients: recipients.length,
      sent, failed, results,
    });
  } catch (err) {
    console.error('[send-alert]', err);
    return json({ error: String(err) }, 500);
  }
});
