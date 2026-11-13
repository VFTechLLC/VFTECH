// Accounts & Subscriptions spec, phase 4: annual plans at ten times the monthly price (two months free). Monthly →
// annual is immediate with credit; annual → monthly waits for the term end; a reminder goes out 30 days before an
// annual renewal. Real SQLite, mocked Stripe and Resend.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './backend-fixture.mjs';
import {lookupKey} from '../backend/billing.js';

const DAY = 86400, now = () => Math.floor(Date.now() / 1000);
function setup(t) {
  const f = fixture();
  t.after(() => f.close());
  f.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
  f.env.BILLING_TEST_EMAILS = 'one@example.test';
  for (const [id, amount] of Object.entries({essentials: 35000, standard: 75000, priority: 150000})) {
    f.state.stripe.prices[lookupKey(id)] = {id: `price_${id}_m`, lookup_key: lookupKey(id), unit_amount: amount, recurring: {interval: 'month'}};
    f.state.stripe.prices[lookupKey(id, 'year')] = {id: `price_${id}_y`, lookup_key: lookupKey(id, 'year'), unit_amount: amount * 10, recurring: {interval: 'year'}};
  }
  return f;
}
const as = (login, csrf = true) => ({headers: {Cookie: login.cookie, ...(csrf ? {'X-CSRF-Token': login.body.csrfToken} : {})}});
async function subscriber(f, planId, interval = 'month', periodEnd = now() + 20 * DAY) {
  const login = await f.login();
  f.sqlite.prepare("UPDATE customers SET stripe_customer_id='cus_1', name='Pat' WHERE email='one@example.test'").run();
  f.state.stripe.subscriptions.push({id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: periodEnd, cancel_at_period_end: false, schedule: null, items: {data: [{id: 'si_1', price: f.state.stripe.prices[lookupKey(planId, interval)], current_period_end: periodEnd}]}, metadata: {}});
  await f.request('billing', undefined, as(login, false));
  return login;
}
const billing = async (f, login) => (await f.request('billing', undefined, as(login, false))).body.subscription;
const change = (f, login, body) => f.request('billing/change-plan', body, as(login));
async function cron(f) {
  const jobs = [];
  await f.worker.scheduled({cron: '17 3 * * *', scheduledTime: Date.now()}, f.env, {waitUntil: (p) => jobs.push(p)});
  await Promise.all(jobs);
}

test('lookup keys: monthly stays as it was, annual is _yearly', () => {
  assert.equal(lookupKey('standard'), 'vftech_standard_monthly');
  assert.equal(lookupKey('standard', 'month'), 'vftech_standard_monthly');
  assert.equal(lookupKey('standard', 'year'), 'vftech_standard_yearly');
});

test('Checkout can start an annual plan', async (t) => {
  const f = setup(t), login = await f.login();
  assert.equal((await f.request('billing/checkout', {itemId: 'standard', interval: 'year', acceptTerms: true}, as(login))).status, 200);
  const session = f.state.stripe.sessions.at(-1);
  assert.equal(session['line_items[0][price]'], 'price_standard_y');
  assert.equal(session['subscription_data[metadata][interval]'], 'year');
  await f.request('billing/checkout', {itemId: 'standard', acceptTerms: true}, as(login));
  assert.equal(f.state.stripe.sessions.at(-1)['line_items[0][price]'], 'price_standard_m', 'monthly is the default');
});

test('Monthly → annual on the same plan is immediate, credited, confirmed and recorded', async (t) => {
  const f = setup(t), login = await subscriber(f, 'standard');
  assert.equal((await change(f, login, {planId: 'standard', interval: 'year'})).status, 400, 'needs the Terms');
  const r = await change(f, login, {planId: 'standard', interval: 'year', acceptTerms: true});
  assert.equal(r.status, 200);
  assert.equal(r.body.changed, 'switched_annual');
  const update = f.state.stripe.updates.at(-1);
  assert.equal(update['items[0][price]'], 'price_standard_y');
  assert.equal(update.proration_behavior, 'always_invoice', 'the unused month is credited and the year invoiced now');
  assert.equal((await billing(f, login)).interval, 'year');
  assert.match(f.state.emails.at(-1).payload.subject, /You're on Standard annual now/);
  assert.match(f.state.emails.at(-1).payload.text, /\$7,500 a year/);
  const events = (await f.request('account/history', undefined, as(login, false))).body.events;
  assert.equal(events[0].type, 'switched_annual');
  assert.equal(events[0].toName, 'Standard (annual)');
  assert.equal(events[0].fromName, 'Standard');
});

test('Annual → monthly waits for the term end, survives a refresh, and can be undone', async (t) => {
  const f = setup(t), login = await subscriber(f, 'standard', 'year');
  const r = await change(f, login, {planId: 'standard', interval: 'month', acceptTerms: true});
  assert.equal(r.body.changed, 'switch_scheduled');
  assert.equal(f.state.stripe.updates, undefined, 'nothing changes on the subscription today');
  const phases = f.state.stripe.scheduleUpdates.at(-1);
  assert.equal(phases['phases[0][items][0][price]'], 'price_standard_y');
  assert.equal(phases['phases[1][items][0][price]'], 'price_standard_m');
  let sub = await billing(f, login);
  assert.equal(sub.interval, 'year');
  assert.equal(sub.pendingPlanId, 'standard');
  assert.equal(sub.pendingInterval, 'month', 'a refresh from Stripe keeps the pending switch to monthly');
  assert.match(f.state.emails.at(-1).payload.subject, /Your switch to Standard monthly is scheduled/);
  // Same plan, same (annual) interval again = keep the annual plan.
  assert.equal((await change(f, login, {planId: 'standard', interval: 'year'})).body.changed, 'change_undone');
  sub = await billing(f, login);
  assert.equal(sub.pendingPlanId, null);
});

test('From annual, a higher monthly plan waits for the term end; a higher annual plan is immediate', async (t) => {
  const f = setup(t), login = await subscriber(f, 'standard', 'year');
  assert.equal((await change(f, login, {planId: 'priority', interval: 'month', acceptTerms: true})).body.changed, 'switch_scheduled');
  assert.equal((await change(f, login, {planId: 'priority', interval: 'year', acceptTerms: true})).body.changed, 'upgraded');
  assert.equal(f.state.stripe.updates.at(-1)['items[0][price]'], 'price_priority_y');
  assert.match(f.state.emails.at(-1).payload.text, /\$15,000 a year/);
});

test('A lower annual plan from monthly is scheduled at renewal, at the annual price', async (t) => {
  const f = setup(t), login = await subscriber(f, 'standard');
  assert.equal((await change(f, login, {planId: 'essentials', interval: 'year', acceptTerms: true})).body.changed, 'downgrade_scheduled');
  assert.equal(f.state.stripe.scheduleUpdates.at(-1)['phases[1][items][0][price]'], 'price_essentials_y');
  assert.match(f.state.emails.at(-1).payload.text, /\$3,500 a year/);
});

test('The annual renewal reminder goes out once, 30 days ahead, and never for monthly or ending plans', async (t) => {
  const f = setup(t), login = await subscriber(f, 'standard', 'year', now() + 20 * DAY);
  const before = f.state.emails.length;
  await cron(f);
  const reminders = () => f.state.emails.slice(before).filter((e) => /renews on/.test(e.payload.subject));
  assert.equal(reminders().length, 1);
  assert.match(reminders()[0].payload.text, /renews for another year at \$7,500 a year/);
  assert.deepEqual(reminders()[0].payload.to, ['one@example.test']);
  await cron(f);
  assert.equal(reminders().length, 1, 'one reminder per term');
  // Far from renewal, monthly, or cancelled: nothing.
  f.sqlite.prepare("UPDATE subscriptions SET renewal_reminded=NULL,current_period_end=?").run(now() + 60 * DAY);
  await cron(f);
  f.sqlite.prepare("UPDATE subscriptions SET current_period_end=?,billing_interval='month'").run(now() + 20 * DAY);
  await cron(f);
  f.sqlite.prepare("UPDATE subscriptions SET billing_interval='year',cancel_at_period_end=1").run();
  await cron(f);
  assert.equal(reminders().length, 1);
  void login;
});
