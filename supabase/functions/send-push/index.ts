// Supabase Edge Function: send-push
// Läuft als Cron (jede Minute) – sendet Web Push für fällige Routinen.
// Verwendet nur Web Crypto API (kein npm/esm dependency für push).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Hilfsfunktionen ────────────────────────────────────────────

function b64uToBytes(b64u: string): Uint8Array {
  // Strip whitespace + existing padding, convert to standard base64, re-pad
  const b64 = b64u.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=/g, '');
  const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

function bytesToB64u(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8
  ));
}

// ── VAPID JWT (ES256) ──────────────────────────────────────────

async function createVapidJWT(audience: string, subject: string, privKeyB64u: string, pubKeyB64u: string): Promise<string> {
  const te = new TextEncoder();
  const header  = bytesToB64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const now     = Math.floor(Date.now() / 1000);
  const payload = bytesToB64u(te.encode(JSON.stringify({ aud: audience, exp: now + 43200, sub: subject })));

  // Öffentlichen Key (04 || x || y) in x und y aufteilen für JWK-Import
  const pubBytes = b64uToBytes(pubKeyB64u); // 65 bytes: 04 + 32 + 32
  const x = bytesToB64u(pubBytes.slice(1, 33));
  const y = bytesToB64u(pubBytes.slice(33, 65));

  // JWK-Format statt PKCS8 – zuverlässiger in Deno
  const jwk = { kty: 'EC', crv: 'P-256', d: privKeyB64u, x, y };
  const sigKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig    = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, sigKey, te.encode(`${header}.${payload}`));
  return `${header}.${payload}.${bytesToB64u(new Uint8Array(sig))}`;
}

// ── Web Push Payload Encryption (RFC 8291 / aes128gcm) ────────

async function encryptPayload(p256dhB64u: string, authB64u: string, payload: string): Promise<Uint8Array> {
  const uaPublic   = b64uToBytes(p256dhB64u);  // 65 bytes
  const authSecret = b64uToBytes(authB64u);     // 16 bytes
  const plaintext  = new TextEncoder().encode(payload);

  // Ephemeral P-256 key pair
  const asKP = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKP.publicKey)); // 65 bytes

  // ECDH
  const uaPubKey    = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret  = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPubKey }, asKP.privateKey, 256));

  // RFC 8291: IKM = HKDF(salt=authSecret, ikm=ecdhSecret, info="WebPush: info\0" || uaPublic || asPublic || 0x01, L=32)
  const webpushInfo = new Uint8Array([
    ...new TextEncoder().encode('WebPush: info\x00'),
    ...uaPublic, ...asPublic, 0x01,
  ]);
  const ikm = await hkdf(authSecret, ecdhSecret, webpushInfo, 32);

  // RFC 8188: CEK + nonce via HKDF
  const salt     = crypto.getRandomValues(new Uint8Array(16));
  const cekInfo  = new TextEncoder().encode('Content-Encoding: aes128gcm\x00\x01');
  const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce\x00\x01');
  const cek   = await hkdf(salt, ikm, cekInfo,   16);
  const nonce = await hkdf(salt, ikm, nonceInfo, 12);

  // AES-128-GCM encrypt (payload + 0x02 delimiter)
  const aesKey    = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded    = new Uint8Array([...plaintext, 0x02]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  // RFC 8188 body: salt(16) + rs(4 BE) + idlen(1=65) + asPublic(65) + ciphertext
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  return new Uint8Array([...salt, ...rs, 65, ...asPublic, ...ciphertext]);
}

// ── Push senden ───────────────────────────────────────────────

async function sendPush(
  endpoint: string, p256dh: string, auth: string,
  payload: string, vapidPub: string, vapidPriv: string, vapidSub: string
): Promise<void> {
  const audience = (() => { const u = new URL(endpoint); return `${u.protocol}//${u.host}`; })();
  console.log('1. createVapidJWT...');
  const jwt  = await createVapidJWT(audience, vapidSub, vapidPriv, vapidPub);
  console.log('2. encryptPayload...');
  const body = await encryptPayload(p256dh, auth, payload);
  console.log('3. fetch push endpoint...');
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt},k=${vapidPub}`,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
    },
    body,
  });
  console.log('4. response status:', res.status);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Push HTTP ${res.status}: ${text}`);
  }
}

// ── Main ──────────────────────────────────────────────────────

Deno.serve(async () => {
  const supabaseUrl     = Deno.env.get('SUPABASE_URL')!;
  const serviceKey      = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const vapidSubject    = Deno.env.get('VAPID_SUBJECT')!;
  const vapidPublicKey  = Deno.env.get('VAPID_PUBLIC_KEY')!;
  const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY')!;

  const db = createClient(supabaseUrl, serviceKey);

  // Aktuelle Uhrzeit in Europe/Berlin
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

  // Fällige Routinen laden
  const { data: routinen, error } = await db
    .from('routinen')
    .select('id, titel, zugewiesen_an, haushalt_id, uhrzeit, wiederholung_tage')
    .filter('wiederholung_tage', 'cs', `{${currentDay}}`);

  if (error) { console.error('DB error:', error.message); return new Response('DB error', { status: 500 }); }

  const faellig = (routinen ?? []).filter(r => r.uhrzeit?.slice(0, 5) === currentTime);
  console.log(`Routinen found: ${routinen?.length ?? 0}, faellig: ${faellig.length}`);
  routinen?.forEach(r => console.log(`  Routine "${r.titel}": uhrzeit="${r.uhrzeit}" → slice="${r.uhrzeit?.slice(0,5)}" === currentTime="${currentTime}"? ${r.uhrzeit?.slice(0,5) === currentTime}`));

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
        console.log(`Sending to ${domain}...`);
        await sendPush(sub.endpoint, sub.keys.p256dh, sub.keys.auth, payload, vapidPublicKey, vapidPrivateKey, vapidSubject);
        console.log(`✓ sent to ${domain}`);
        sent++;
      } catch(e) {
        const err = e as Error;
        console.error(`✗ failed ${domain}: ${err.message}`);
        // 410 = Subscription abgelaufen → aus DB löschen
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
