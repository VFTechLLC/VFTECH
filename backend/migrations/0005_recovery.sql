-- Accounts & Subscriptions spec, phase 2 (2026-11-13): "Can't sign in?" recovery requests from customers who lost
-- access to their email. Staff verify them (invoice number, last four of the card on file, profile phone), change the
-- email, end all sessions and mark the request handled. See backend/README.md.
CREATE TABLE recovery_requests (id TEXT PRIMARY KEY,old_email TEXT NOT NULL,new_email TEXT NOT NULL,name TEXT NOT NULL DEFAULT '',invoice TEXT NOT NULL DEFAULT '',card_last4 TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',message TEXT NOT NULL DEFAULT '',account_found INTEGER NOT NULL DEFAULT 0,ip_hash TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'open',handled_by TEXT,handled_at INTEGER,created_at INTEGER NOT NULL);
CREATE INDEX recovery_status ON recovery_requests(status,created_at);
