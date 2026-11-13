-- Accounts & Subscriptions spec, phase 4 (2026-11-13): annual plans at ten times the monthly price.
-- billing_interval is 'month' or 'year'; pending_interval goes with pending_plan_id for a change at the term end;
-- renewal_reminded holds the period end an annual renewal reminder was sent for (one reminder per term).
ALTER TABLE subscriptions ADD COLUMN billing_interval TEXT NOT NULL DEFAULT 'month';
ALTER TABLE subscriptions ADD COLUMN pending_interval TEXT;
ALTER TABLE subscriptions ADD COLUMN renewal_reminded INTEGER;
ALTER TABLE plan_events ADD COLUMN from_interval TEXT NOT NULL DEFAULT '';
ALTER TABLE plan_events ADD COLUMN to_interval TEXT NOT NULL DEFAULT '';
