# HaushaltsPRO – Projektkontext

Vanilla JS PWA + Supabase (Auth, Realtime, PostgreSQL) + Vercel → haushaltspro.de
Alle Files in `/Users/Eric_1/haushalt-app/`.

---

## Architektur-Besonderheiten

**Auth ohne Web Locks:**
- `persistSession: false` + manuelles localStorage-Management (`STORAGE_KEY = 'hp-v4'`)
- Custom fetch injiziert Token bei jedem API-Call aus localStorage
- `db.realtime.setAuth(token)` muss vor `subscribeRealtime()` aufgerufen werden (sonst läuft Realtime mit Anon-Key)
- Token-Refresh manuell alle 60s via `startTokenRefresh()`

**Supabase-Tabellen:**
- `haushalte` — Haushalt mit Code (z.B. HAUS-4729)
- `haushalt_mitglieder` — User ↔ Haushalt
- `haushalt_items` — Vorrat + Einkauf (typ: 'vorrat'|'einkauf', source: 'vorrat'|'manuell', status: 'ok'|'low'|'out'|'counter')
- `aufgaben` — Aufgaben mit Priorität, Fälligkeit, Kosten, Link, Notizen
- `routinen` — Wochentag-Routinen mit Uhrzeit und Zuweisung
- `push_subscriptions` — VAPID Push-Subscriptions
- `notvorrat_items` — Notvorrat-Artikel (neu, 27.03.2026)

**Einkauf-Logik:**
- Status 'low'/'out' → Artikel landet automatisch auf Einkaufsliste
- buy_count trackt Kaufhäufigkeit → "Häufig gekauft"-Chips (max 15)
- Counter-Items (status='counter') = gekaufte manuelle Artikel die Highscore-Eintrag behalten
- menge TEXT nullable in haushalt_items

---

## Tab-Struktur

1. **Vorrat** — Haushaltsartikel mit Status ok/low/out, Kategorien: Küche, Bad, Putzen, Haushalt, Sonstiges
2. **Einkauf** — Automatisch befüllt + manuelle Artikel, Einkaufsmodus-Overlay, Häufig-gekauft-Chips
3. **Aufgaben** — Aufgaben + Routinen, Push Notifications (aktiviert aber Android-Hintergrund-Problem offen)
4. **Notvorrat** — Neu (27.03.2026), siehe unten

---

## Session-Log

### Session 22. März 2026
- Realtime-Fix: `db.realtime.setAuth(token)` vor `subscribeRealtime()`
- ✕-Button zum direkten Löschen von Shop-Items (Counter-Logik bleibt erhalten)
- Mengenangabe: Textfeld inline editierbar im shop-item (blur/Enter speichert)
- Bug fix: `menge: null` beim Counter-Update in `addFromFrequently`
- EMOJIS-Map von ~35 auf ~115 Einträge erweitert (Obst, Gemüse, Fleisch, Fisch, etc.)
- Highscore-Limit von 8 auf 15 erhöht

### Session 23. März 2026
- Push Notifications implementiert und debuggt
- `npm:web-push` Fix für Supabase Edge Functions
- Android-Hintergrund-Problem: Notifications kommen nicht wenn App im Hintergrund — noch offen

### Session 27. März 2026
- **Notvorrat-Tab** implementiert (4. Tab)
- Basis: Schweizer Bundesamt-Merkblatt "Kluger Rat – Notvorrat" (BWL)
- 29 Starterartikel, 6 Kategorien: Getränke, Fertigessen, Zutaten, Medizin, Hygiene, Ausrüstung
- Fortschrittsbalken (X von Y vorhanden)
- MHD-Datum pro Artikel, Ampel: grün >6 Monate, gelb 1–6 Monate, rot <30 Tage/abgelaufen
- MHD-Alarm-Sektion wenn Artikel bald ablaufen
- "Zum Einkauf"-Button: fehlende Artikel → Einkauf-Tab
- Auto-Init: Starterartikel beim ersten Öffnen automatisch angelegt (localStorage-Flag)
- Realtime-Sync, Dark Mode
- Supabase: neue Tabelle `notvorrat_items` + Realtime aktiviert

---

## Offen / Nächste Schritte

- Notvorrat-Tab: kleinere UI-Tweaks (Eric beschreibt in nächster Session)
- Push Notifications Android-Hintergrund-Problem (offen seit 23.03.)
- Push Notifications iOS: nur ab iOS 16.4+ als installierte PWA

---

## Google Analytics
G-07QN4QCQZZ — in index.html und app.html eingebunden

## VAPID Public Key
`BEZ35rfnfi2IGnkKnSoO1EFYI40O6sALID7WTTX4l0lz_JR7sXASsh_KXRTLJ6LfdqqKcJNJsDxYRz1psuEx2Zg`
