-- Accounts & Subscriptions spec, phase 1 (2026-11-13): profile fields, scheduled plan changes, plan history and
-- Terms acceptances. Stripe stays the source of truth for money; these rows are what the account page renders.
ALTER TABLE customers ADD COLUMN business TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN phone TEXT NOT NULL DEFAULT '';
-- Set by staff (D1 console for now, admin view later): the customer's own project portal, shown as a button.
ALTER TABLE customers ADD COLUMN portal_url TEXT NOT NULL DEFAULT '';
-- A downgrade waits for the end of the period in a Stripe subscription schedule; these remember what is pending.
ALTER TABLE subscriptions ADD COLUMN pending_plan_id TEXT;
ALTER TABLE subscriptions ADD COLUMN schedule_id TEXT;
CREATE TABLE plan_events (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,type TEXT NOT NULL,from_plan TEXT NOT NULL DEFAULT '',to_plan TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL);
CREATE INDEX plan_events_customer ON plan_events(customer_id,created_at);
CREATE TABLE terms_acceptances (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,item_id TEXT NOT NULL,version TEXT NOT NULL,ip_hash TEXT NOT NULL DEFAULT '',accepted_at INTEGER NOT NULL);
CREATE INDEX terms_customer ON terms_acceptances(customer_id,accepted_at);
