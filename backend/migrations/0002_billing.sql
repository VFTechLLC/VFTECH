-- Subscriptions and billing (Stripe, spec v0.2). Stripe holds cards, invoices and tax; D1 only remembers which
-- Stripe customer belongs to which account, and each subscription's plan and status (refreshed from Stripe).
ALTER TABLE customers ADD COLUMN stripe_customer_id TEXT;
CREATE UNIQUE INDEX customers_stripe ON customers(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE TABLE subscriptions (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,plan_id TEXT NOT NULL,status TEXT NOT NULL,current_period_end INTEGER,cancel_at_period_end INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
CREATE INDEX subscriptions_customer ON subscriptions(customer_id,updated_at);
