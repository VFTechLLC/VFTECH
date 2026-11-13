-- Accounts & Subscriptions spec, phase 4 (2026-11-13): net-30 invoices on request for Priority and annual plans.
-- collection_method mirrors Stripe ('charge_automatically' or 'send_invoice'); net30_requested_at is when the
-- customer asked, so staff get one email and the account page can say it's being looked at.
ALTER TABLE subscriptions ADD COLUMN collection_method TEXT NOT NULL DEFAULT 'charge_automatically';
ALTER TABLE customers ADD COLUMN net30_requested_at INTEGER;
