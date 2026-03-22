// Supabase Edge Function: send-push
// Läuft als Cron (z.B. jede Minute) und sendet Push-Benachrichtigungen
// für Routinen, deren Uhrzeit auf die aktuelle Minute fällt.
//
// Cron-Setup im Supabase Dashboard:
//   Project → Edge Functions → send-push → Schedule: "* * * * *"
//
// Benötigte Supabase Secrets (Project → Settings → Edge Functions → Secrets):
//   VAPID_SUBJECT    = mailto:hallo@haushaltspro.de
//   VAPID_PUBLIC_KEY = <public key aus npx web-push generate-vapid-keys>
//   VAPID_PRIVATE_KEY= <private key aus npx web-push generate-vapid-keys>

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
// @ts-ignore
import webpush from 'npm:web-push@3.6.7';

Deno.serve(async () => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const vapidSubject    = Deno.env.get('VAPID_SUBJECT')!;
  const vapidPublicKey  = Deno.env.get('VAPID_PUBLIC_KEY')!;
  const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY')!;

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  const db = createClient(supabaseUrl, serviceKey);

  // Aktuelle Uhrzeit auf Minuten gerundet (UTC)
  const now = new Date();
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const currentTime = `${hh}:${mm}`;
  const currentDay  = now.getUTCDay(); // 0=So … 6=Sa

  // Routinen finden, die jetzt fällig sind
  // wiederholung_tage enthält den aktuellen Wochentag UND uhrzeit passt
  const { data: routinen, error: rErr } = await db
    .from('routinen')
    .select('id, titel, zugewiesen_an, haushalt_id, uhrzeit, wiederholung_tage')
    .filter('wiederholung_tage', 'cs', `{${currentDay}}`);

  if (rErr || !routinen?.length) {
    return new Response('OK (keine fälligen Routinen)', { status: 200 });
  }

  // Nur die Routinen, deren Uhrzeit auf die aktuelle Minute passt
  // (uhrzeit ist im Format HH:MM:SS, wir vergleichen HH:MM)
  const faellig = routinen.filter(r => r.uhrzeit?.slice(0, 5) === currentTime);

  if (!faellig.length) {
    return new Response('OK (keine fälligen Routinen zur aktuellen Minute)', { status: 200 });
  }

  // Für jede fällige Routine: Push an alle Mitglieder des Haushalts senden
  const results = await Promise.allSettled(
    faellig.map(async (routine) => {
      const { data: subs } = await db
        .from('push_subscriptions')
        .select('subscription_json')
        .eq('haushalt_id', routine.haushalt_id);

      if (!subs?.length) return;

      const body = routine.zugewiesen_an
        ? `Heute fällig für ${routine.zugewiesen_an}`
        : 'Heute fällig';

      const payload = JSON.stringify({
        title: routine.titel,
        body,
        url: '/app',
        tag: `routine-${routine.id}`,
      });

      await Promise.allSettled(
        subs.map(async ({ subscription_json }) => {
          try {
            const sub = JSON.parse(subscription_json);
            await webpush.sendNotification(sub, payload);
          } catch (e) {
            // Abgelaufene Subscriptions ignorieren (410 Gone → löschen)
            if ((e as any).statusCode === 410) {
              // Optional: subscription löschen
            }
          }
        })
      );
    })
  );

  return new Response(`OK (${faellig.length} Routinen, ${results.length} Haushalte)`, { status: 200 });
});
