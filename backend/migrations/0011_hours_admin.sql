-- Accounts & Subscriptions spec, phase 4 (2026-11-13): the hours meter and the admin view.
-- time_entries: work done for a customer, logged by staff in the admin view (minutes, so quarter hours add up exactly).
-- admin_log: every staff action, with who did it. suspended_at: a staff hold on the account (features off, like a
-- payment suspension, but the customer is told to contact us). hours_warned: '<period start>:80' once the 80% email
-- went out for that period, so it goes once.
CREATE TABLE time_entries (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE, work_date TEXT NOT NULL, minutes INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX time_entries_customer ON time_entries(customer_id, work_date);
CREATE TABLE admin_log (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, customer_id TEXT, detail TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE INDEX admin_log_customer ON admin_log(customer_id, created_at);
CREATE INDEX admin_log_time ON admin_log(created_at);
ALTER TABLE customers ADD COLUMN suspended_at INTEGER;
ALTER TABLE customers ADD COLUMN suspended_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN hours_warned TEXT NOT NULL DEFAULT '';
