// Supabase Edge Function: send-push
// Läuft als Cron (jede Minute) – sendet Web Push für fällige Routinen.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

// ── Hilfsfunktionen ────────────────────────────────────────────

function bytesToB64u(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64uToBytes(b64u: string): Uint8Array {
  const b64 = b64u.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=/g, '');
  const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

// ── VAPID JWT (ES256) – eigene Implementierung via JWK (kein PKCS8) ──

async function createVapidJWT(audience: string, subject: string, privKeyB64u: string, pubKeyB64u: string): Promise<string> {
  const te = new TextEncoder();
  const header  = bytesToB64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const now     = Math.floor(Date.now() / 1000);
  const payload = bytesToB64u(te.encode(JSON.stringify({ aud: audience, exp: now + 43200, sub: subject })));

  const pubBytes = b64uToBytes(pubKeyB64u);
  const x = bytesToB64u(pubBytes.slice(1, 33));
  const y = bytesToB64u(pubBytes.slice(33, 65));

  const jwk = { kty: 'EC', crv: 'P-256', d: privKeyB64u, x, y };
  const sigKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig    = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, sigKey, te.encode(`${header}.${payload}`));
  return `${header}.${payload}.${bytesToB64u(new Uint8Array(sig))}`;
}

// ── Push senden ───────────────────────────────────────────────

async function sendPush(
  endpoint: string, p256dh: string, auth: string,
  payload: string | null, vapidPub: string, vapidPriv: string, vapidSub: string
): Promise<void> {
  const domain = new URL(endpoint).hostname;

  if (payload === null) {
    // Leerer Push: eigene VAPID JWT + kein Body
    const audience = (() => { const u = new URL(endpoint); return `${u.protocol}//${u.host}`; })();
    const jwt = await createVapidJWT(audience, vapidSub, vapidPriv, vapidPub);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `vapid t=${jwt},k=${vapidPub}`,
        'TTL': '86400',
        'Urgency': 'high',
      },
    });
    const text = await res.text();
    console.log(`Empty push to ${domain}: ${res.status} ${text}`);
    if (!res.ok) throw new Error(`Push HTTP ${res.status}: ${text}`);
    return;
  }

  // Verschlüsselter Push via npm:web-push (bewährte Encryption)
  webpush.setVapidDetails(vapidSub, vapidPub, vapidPriv);
  const sub = { endpoint, keys: { p256dh, auth } };
  console.log(`Sending to ${domain}...`);
  const result = await webpush.sendNotification(sub, payload, {
    TTL: 86400,
    urgency: 'high',
  });
  console.log(`✓ sent to ${domain}: ${result.statusCode}`);
}

// ── Main ──────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const supabaseUrl     = Deno.env.get('SUPABASE_URL')!;
  const serviceKey      = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const vapidSubject    = Deno.env.get('VAPID_SUBJECT')!;
  const vapidPublicKey  = Deno.env.get('VAPID_PUBLIC_KEY')!;
  const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY')!;

  const db = createClient(supabaseUrl, serviceKey);

  // ── POST: Direkter Test-Push mit übergebener Subscription ─────
  if (req.method === 'POST') {
    let sub: { endpoint: string; keys: { p256dh: string; auth: string } };
    try {
      const body = await req.json();
      sub = body.subscription;
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('invalid');
    } catch {
      return new Response('Bad Request: subscription fehlt', { status: 400, headers: CORS });
    }
    const empty = new URL(req.url).searchParams.get('empty') === '1';
    const payload = empty ? null : JSON.stringify({ title: '🔔 Server-Test', body: 'Push über Server empfangen!', url: '/app', tag: 'server-test' });
    const domain = new URL(sub.endpoint).hostname;
    try {
      await sendPush(sub.endpoint, sub.keys.p256dh, sub.keys.auth, payload, vapidPublicKey, vapidPrivateKey, vapidSubject);
      return new Response(`Test: sent to ${domain}`, { status: 200, headers: CORS });
    } catch(e) {
      const err = e as Error;
      console.error(`✗ test push failed ${domain}: ${err.message}`);
      if (err.message.includes('410')) {
        await db.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      }
      return new Response(`Test failed: ${err.message}`, { status: 500, headers: CORS });
    }
  }

  // ── GET: Cron – fällige Routinen senden ───────────────────────
  const now  = new Date();
  const fmt  = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  });
  const parts      = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const currentTime = `${parts.hour.padStart(2,'0')}:${parts.minute.padStart(2,'0')}`;
  const WEEKDAY_MAP: Record<string,number> = { So:0,Mo:1,Di:2,Mi:3,Do:4,Fr:5,Sa:6 };
  const currentDay  = WEEKDAY_MAP[parts.weekday] ?? now.getDay();

  console.log(`Berlin time: ${currentTime}, day: ${currentDay}`);

  const { data: routinen, error } = await db
    .from('routinen')
    .select('id, titel, zugewiesen_an, haushalt_id, uhrzeit, wiederholung_tage')
    .filter('wiederholung_tage', 'cs', `{${currentDay}}`);

  if (error) { console.error('DB error:', error.message); return new Response('DB error', { status: 500 }); }

  const faellig = (routinen ?? []).filter(r => r.uhrzeit?.slice(0, 5) === currentTime);
  console.log(`Routinen found: ${routinen?.length ?? 0}, faellig: ${faellig.length}`);

  if (!faellig.length) return new Response('OK – keine fälligen Routinen', { status: 200 });

  let sent = 0, failed = 0;

  for (const routine of faellig) {
    const { data: subs } = await db
      .from('push_subscriptions')
      .select('subscription_json')
      .eq('haushalt_id', routine.haushalt_id);

    if (!subs?.length) { console.log(`No subs for haushalt ${routine.haushalt_id}`); continue; }

    const body = routine.zugewiesen_an ? `Heute fällig für ${routine.zugewiesen_an}` : 'Heute fällig';
    const payload = JSON.stringify({ title: routine.titel, body, url: '/app', tag: `routine-${routine.id}` });

    for (const { subscription_json } of subs) {
      const sub = JSON.parse(subscription_json);
      const domain = new URL(sub.endpoint).hostname;
      try {
        await sendPush(sub.endpoint, sub.keys.p256dh, sub.keys.auth, payload, vapidPublicKey, vapidPrivateKey, vapidSubject);
        console.log(`✓ sent to ${domain}`);
        sent++;
      } catch(e) {
        const err = e as Error;
        console.error(`✗ failed ${domain}: ${err.message}`);
        if (err.message.includes('410')) {
          await db.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
          console.log(`Deleted stale subscription for ${domain}`);
        }
        failed++;
      }
    }
  }

  return new Response(`OK – sent: ${sent}, failed: ${failed}`, { status: 200 });
});
