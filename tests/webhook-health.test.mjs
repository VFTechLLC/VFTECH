// Phase 5 prep: the daily job emails the team when Stripe couldn't deliver webhooks to us. Mocked Stripe and Resend.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './backend-fixture.mjs';

function setup(t) {
  const f = fixture();
  t.after(() => f.close());
  f.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
  return f;
}
async function cron(f) {
  const jobs = [];
  await f.worker.scheduled({cron: '17 3 * * *', scheduledTime: Date.now()}, f.env, {waitUntil: (p) => jobs.push(p)});
  await Promise.all(jobs);
}
const alerts = (f) => f.state.emails.filter((e) => /Stripe webhooks failing/.test(e.payload.subject));
const now = () => Math.floor(Date.now() / 1000);

test('No failed deliveries: no email; the check asks Stripe for the last day only', async (t) => {
  const f = setup(t);
  await cron(f);
  assert.equal(alerts(f).length, 0);
  const q = f.state.stripe.eventQueries.at(-1);
  assert.equal(q.delivery_success, 'false');
  assert.ok(Math.abs(Number(q['created[gte]']) - (now() - 26 * 3600)) < 5);
});

test('Failed deliveries: one email to the team, with counts per event type and what to check', async (t) => {
  const f = setup(t);
  f.state.stripe.failedEvents = [
    {id: 'evt_1', type: 'invoice.payment_failed', created: now() - 7200},
    {id: 'evt_2', type: 'invoice.payment_failed', created: now() - 3600},
    {id: 'evt_3', type: 'customer.subscription.updated', created: now() - 600},
  ];
  await cron(f);
  assert.equal(alerts(f).length, 1);
  const mail = alerts(f)[0];
  assert.deepEqual(mail.payload.to, ['inbox@vftech.test'], 'CONTACT_TO when ALERT_TO is not set');
  assert.match(mail.payload.subject, /3 events not delivered/);
  assert.match(mail.payload.text, /- invoice\.payment_failed: 2\n- customer\.subscription\.updated: 1/);
  assert.match(mail.payload.text, /test mode/);
  assert.match(mail.payload.text, /STRIPE_WEBHOOK_SECRET/);
  assert.match(mail.key, /^webhook-health-\d{4}-\d{2}-\d{2}$/, 'one email a day (Resend idempotency key per day)');
  f.env.ALERT_TO = 'ops@vftech.test, admin@vftech.test';
  await cron(f);
  assert.deepEqual(alerts(f).at(-1).payload.to, ['ops@vftech.test', 'admin@vftech.test']);
  assert.equal(alerts(f).at(-1).key, mail.key, 'same day, same key: Resend sends it once');
});

test('Billing off: no Stripe call', async (t) => {
  const f = setup(t);
  delete f.env.STRIPE_SECRET_KEY;
  await cron(f);
  assert.equal(f.state.stripe.eventQueries, undefined);
});
