-- Accounts & Subscriptions spec, phase 3 (2026-11-13): closing an account. When set, the account closes at this time
-- (the end of the paid period, or 14 days after asking with no paid plan); the daily job then deletes it.
ALTER TABLE customers ADD COLUMN closing_at INTEGER;
CREATE INDEX customers_closing ON customers(closing_at) WHERE closing_at IS NOT NULL;
