-- Accounts & Subscriptions spec, phase 2 (2026-11-13): payment rules. A failed payment starts a timeline counted from
-- past_due_since: banner (days 0-6), payment screen (7-29), suspended (30-89), closed (day 90). Paying everything owed
-- clears it. A dispute or a paid plan with no payment method also puts the account on the payment screen.
ALTER TABLE subscriptions ADD COLUMN past_due_since INTEGER;
-- The last timeline step already handled (email sent): 0, 7, 25, 30 or 90.
ALTER TABLE subscriptions ADD COLUMN dunning_stage INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN disputed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN no_payment_method INTEGER NOT NULL DEFAULT 0;
-- The default card, for the "your card expires soon" banner: last four digits and YYYYMM.
ALTER TABLE subscriptions ADD COLUMN card_last4 TEXT;
ALTER TABLE subscriptions ADD COLUMN card_expires INTEGER;
CREATE INDEX subscriptions_past_due ON subscriptions(past_due_since) WHERE past_due_since IS NOT NULL;
