-- Accounts & Subscriptions spec, phase 3 (2026-11-13): the optional "why" a customer gives when cancelling.
ALTER TABLE plan_events ADD COLUMN reason TEXT NOT NULL DEFAULT '';
