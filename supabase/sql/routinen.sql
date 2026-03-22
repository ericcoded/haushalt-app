-- ============================================================
-- Tabelle: routinen
-- Wochentage als INT[]: 0=So, 1=Mo, 2=Di, 3=Mi, 4=Do, 5=Fr, 6=Sa
-- ============================================================
CREATE TABLE routinen (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  haushalt_id       UUID NOT NULL REFERENCES haushalte(id) ON DELETE CASCADE,
  erstellt_von      UUID NOT NULL REFERENCES auth.users(id),
  titel             TEXT NOT NULL,
  zugewiesen_an     TEXT,
  wiederholung_tage INT[]  NOT NULL DEFAULT '{}',
  uhrzeit           TIME   NOT NULL DEFAULT '08:00',
  created_at        TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE routinen ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Haushalt-Mitglieder sehen und verwalten Routinen"
  ON routinen FOR ALL
  USING (
    haushalt_id IN (
      SELECT haushalt_id FROM haushalt_mitglieder WHERE user_id = auth.uid()
    )
  );

-- ============================================================
-- Tabelle: push_subscriptions
-- ============================================================
CREATE TABLE push_subscriptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  haushalt_id       UUID NOT NULL REFERENCES haushalte(id) ON DELETE CASCADE,
  subscription_json TEXT NOT NULL,
  created_at        TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Nutzer verwalten eigene Subscription"
  ON push_subscriptions FOR ALL
  USING (user_id = auth.uid());

-- Damit die Edge Function auf push_subscriptions zugreifen kann
-- (service_role key hat automatisch Zugriff, kein extra Policy nötig)
