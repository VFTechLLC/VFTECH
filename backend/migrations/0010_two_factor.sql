-- Accounts & Subscriptions spec, phase 4 (2026-11-13): optional two-factor sign-in (TOTP).
-- totp_secret / totp_pending are AES-GCM sealed with the TOTP_KEY Worker secret; totp_last_step stops a code being
-- used twice. Recovery codes are stored only as HMACs. A session with mfa_pending=1 is waiting for the code and
-- opens nothing but the two-factor step.
ALTER TABLE customers ADD COLUMN totp_secret TEXT;
ALTER TABLE customers ADD COLUMN totp_pending TEXT;
ALTER TABLE customers ADD COLUMN totp_pending_at INTEGER;
ALTER TABLE customers ADD COLUMN totp_enabled_at INTEGER;
ALTER TABLE customers ADD COLUMN totp_last_step INTEGER NOT NULL DEFAULT 0;
CREATE TABLE recovery_codes (code_hash TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE, used_at INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX recovery_codes_customer ON recovery_codes(customer_id);
ALTER TABLE sessions ADD COLUMN mfa_pending INTEGER NOT NULL DEFAULT 0;
