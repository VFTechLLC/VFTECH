// Accounts & Subscriptions spec, phase 2: payment rules. A failed payment starts the day 0-6 / 7-29 / 30-89 / 90
// timeline; paying clears it; disputes and a paid plan with no payment method lock the account; the daily job sends
// the day 7, 25 and 30 emails once each and closes the plan on day 90. Real SQLite, mocked Stripe and Resend.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './backend-fixture.mjs';
import {lookupKey} from '../backend/billing.js';
import {standingOf, cardOf, DAY} from '../backend/account.js';

const now = () => Math.floor(Date.now() / 1000);
function setup(t) {
  const f = fixture();
  t.after(() => f.close());
  f.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
  f.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  f.env.BILLING_TEST_EMAILS = 'one@example.test';
  for (const [id, amount] of Object.entries({essentials: 35000, standard: 75000, priority: 150000})) f.state.stripe.prices[lookupKey(id)] = {id: 'price_' + id, lookup_key: lookupKey(id), unit_amount: amount};
  return f;
}
const as = (login, csrf = true) => ({headers: {Cookie: login.cookie, ...(csrf ? {'X-CSRF-Token': login.body.csrfToken} : {})}});
async function subscriber(f, planId = 'standard') {
  const login = await f.login();
  f.sqlite.prepare("UPDATE customers SET stripe_customer_id='cus_1' WHERE email='one@example.test'").run();
  f.state.stripe.subscriptions.push({id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: now() + 20 * DAY, cancel_at_period_end: false, schedule: null, default_payment_method: 'pm_1', items: {data: [{id: 'si_1', price: f.state.stripe.prices[lookupKey(planId)], current_period_end: now() + 20 * DAY}]}, metadata: {}});
  f.state.stripe.paymentMethods = [{id: 'pm_1', customer: 'cus_1', card: {last4: '4242', exp_month: 12, exp_year: 2030}}];
  await f.request('billing', undefined, as(login, false));
  return login;
}
async function sign(payload, secret, t = now()) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const mac = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)))].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `t=${t},v1=${mac}`;
}
async function hook(f, type, object, extra = {}) {
  const payload = JSON.stringify({id: 'evt_' + crypto.randomUUID().slice(0, 8), type, created: now(), data: {object, ...extra}});
  const response = await f.worker.fetch(new Request('https://vftech.test/api/stripe/webhook', {method: 'POST', headers: {'Stripe-Signature': await sign(payload, 'whsec_test'), 'Content-Type': 'application/json'}, body: payload}), f.env);
  assert.equal(response.status, 200, `${type} webhook accepted`);
}
const plan = async (f, login) => (await f.request('session', undefined, as(login, false))).body.plan;
const daysAgo = (f, days) => f.sqlite.prepare('UPDATE subscriptions SET past_due_since=? WHERE id=?').run(now() - days * DAY - 60, 'sub_1');
async function cron(f) {
  const jobs = [];
  await f.worker.scheduled({cron: '17 3 * * *'}, f.env, {waitUntil: (p) => jobs.push(p)});
  await Promise.all(jobs);
}
const mailTo = (f, subject) => f.state.emails.filter((m) => m.payload.subject.includes(subject));

test('Standing follows the days since the first failed payment', () => {
  const t = 1_900_000_000;
  assert.equal(standingOf({status: 'active'}, t).standing, 'ok');
  assert.equal(standingOf({status: 'past_due', pastDueSince: t - 3 * DAY}, t).standing, 'past_due');
  assert.equal(standingOf({status: 'past_due', pastDueSince: t - 7 * DAY}, t).standing, 'payment_required');
  assert.equal(standingOf({status: 'unpaid', pastDueSince: t - 29 * DAY}, t).standing, 'payment_required');
  const suspended = standingOf({status: 'unpaid', pastDueSince: t - 30 * DAY}, t);
  assert.equal(suspended.standing, 'suspended');
  assert.equal(suspended.closesOn, t + 60 * DAY);
  assert.deepEqual(standingOf({status: 'active', disputed: 1}, t), {standing: 'payment_required', days: null, reason: 'dispute'});
  assert.equal(standingOf({status: 'active', noPaymentMethod: 1}, t).reason, 'no_payment_method');
});

test('Expiring cards show from 30 days before the expiry month', () => {
  const at = (iso) => Date.parse(iso) / 1000;
  assert.equal(cardOf({cardLast4: '4242', cardExpires: 202612}, at('2026-10-31T00:00:00Z')).expiring, false);
  assert.equal(cardOf({cardLast4: '4242', cardExpires: 202612}, at('2026-11-02T00:00:00Z')).expiring, true);
  assert.equal(cardOf({cardLast4: '4242', cardExpires: 202612}, at('2026-11-02T00:00:00Z')).expires, '12/26');
  assert.equal(cardOf({cardLast4: '4242', cardExpires: 202612}, at('2027-01-01T00:00:00Z')).expired, true);
});

test('A failed payment shows a banner; paying everything owed clears it', async (t) => {
  const f = setup(t), login = await subscriber(f);
  assert.equal((await plan(f, login)).standing, 'ok');
  f.state.stripe.invoices.push({id: 'in_1', customer: 'cus_1', subscription: 'sub_1', status: 'open', total: 75000, created: now()});
  await hook(f, 'invoice.payment_failed', {id: 'in_1', customer: 'cus_1', subscription: 'sub_1'});
  let p = await plan(f, login);
  assert.equal(p.standing, 'past_due');
  assert.equal(p.tier, 'standard', 'features stay on during days 0-6');
  // A second failure keeps the original start date.
  const first = f.sqlite.prepare('SELECT past_due_since AS s FROM subscriptions').get().s;
  await hook(f, 'invoice.payment_failed', {id: 'in_1', customer: 'cus_1', subscription: 'sub_1'});
  assert.equal(f.sqlite.prepare('SELECT past_due_since AS s FROM subscriptions').get().s, first);
  // Paid, but another invoice is still open: still past due.
  f.state.stripe.invoices.push({id: 'in_2', customer: 'cus_1', subscription: 'sub_1', status: 'open', total: 100, created: now()});
  f.state.stripe.invoices[0].status = 'paid';
  await hook(f, 'invoice.paid', {id: 'in_1', customer: 'cus_1', subscription: 'sub_1'});
  assert.equal((await plan(f, login)).standing, 'past_due');
  f.state.stripe.invoices[1].status = 'paid';
  await hook(f, 'invoice.paid', {id: 'in_2', customer: 'cus_1', subscription: 'sub_1'});
  p = await plan(f, login);
  assert.equal(p.standing, 'ok');
  assert.equal(p.tier, 'standard');
});

test('Day 7: payment screen, features paused, profile locked; the email goes once', async (t) => {
  const f = setup(t), login = await subscriber(f);
  daysAgo(f, 8);
  const p = await plan(f, login);
  assert.equal(p.standing, 'payment_required');
  const features = (await f.request('account/features', undefined, as(login, false))).body;
  assert.equal(features.paused, true);
  assert.deepEqual(features.included, []);
  const save = await f.request('account/profile', {name: 'New', business: '', phone: ''}, as(login));
  assert.equal(save.status, 402);
  assert.match(save.body.error, /Settle your payment first/);
  // Billing still works.
  assert.equal((await f.request('billing', undefined, as(login, false))).status, 200);
  assert.equal((await f.request('billing/portal', {}, as(login))).status, 200);
  await cron(f);
  await cron(f);
  const sent = mailTo(f, 'Payment needed');
  assert.equal(sent.length, 1, 'day 7 email sent once');
  assert.deepEqual(sent[0].payload.to, ['one@example.test']);
  assert.match(sent[0].payload.text, /paused/);
});

test('Day 30: suspended, features off; only the latest email goes if steps were missed', async (t) => {
  const f = setup(t), login = await subscriber(f);
  daysAgo(f, 31);
  const p = await plan(f, login);
  assert.equal(p.standing, 'suspended');
  assert.equal(p.tier, 'free', 'features off while suspended');
  assert.equal(p.planId, 'standard', 'the plan is still known, so paying restores it');
  await cron(f);
  assert.equal(mailTo(f, 'is suspended').length, 1);
  assert.equal(mailTo(f, 'Payment needed').length, 0);
  assert.equal(mailTo(f, 'in 5 days').length, 0);
});

test('Day 90: the plan ends, the balance is written off, a final email goes', async (t) => {
  const f = setup(t), login = await subscriber(f);
  f.state.stripe.invoices.push({id: 'in_9', customer: 'cus_1', subscription: 'sub_1', status: 'open', total: 75000, created: now()});
  daysAgo(f, 91);
  await cron(f);
  assert.equal(f.state.stripe.subscriptions[0].status, 'canceled');
  assert.equal(f.state.stripe.invoices[0].status, 'uncollectible');
  const p = await plan(f, login);
  assert.equal(p.tier, 'free');
  assert.equal(p.standing, 'ok');
  assert.equal(mailTo(f, 'is closed').length, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM plan_events WHERE type='closed_unpaid'").get().n, 1);
  await cron(f);
  assert.equal(mailTo(f, 'is closed').length, 1, 'nothing repeats');
});

test('A dispute locks the account until it is won', async (t) => {
  const f = setup(t), login = await subscriber(f);
  f.state.stripe.charges = [{id: 'ch_1', customer: 'cus_1'}];
  await hook(f, 'charge.dispute.created', {id: 'dp_1', charge: 'ch_1', status: 'needs_response'});
  let p = await plan(f, login);
  assert.equal(p.standing, 'payment_required');
  assert.equal(p.reason, 'dispute');
  await hook(f, 'charge.dispute.closed', {id: 'dp_1', charge: 'ch_1', status: 'lost'});
  assert.equal((await plan(f, login)).reason, 'dispute', 'a lost dispute keeps the lock');
  await hook(f, 'charge.dispute.closed', {id: 'dp_1', charge: 'ch_1', status: 'won'});
  p = await plan(f, login);
  assert.equal(p.standing, 'ok');
});

test('A paid plan must keep a payment method; the card on file is remembered', async (t) => {
  const f = setup(t), login = await subscriber(f);
  await hook(f, 'payment_method.attached', {id: 'pm_1', customer: 'cus_1'});
  let p = await plan(f, login);
  assert.equal(p.card.last4, '4242');
  assert.equal(p.card.expires, '12/30');
  assert.equal(p.card.expiring, false);
  f.state.stripe.paymentMethods = [];
  await hook(f, 'payment_method.detached', {id: 'pm_1', customer: null}, {previous_attributes: {customer: 'cus_1'}});
  p = await plan(f, login);
  assert.equal(p.standing, 'payment_required');
  assert.equal(p.reason, 'no_payment_method');
  const month = new Date(Date.now() + 10 * DAY);
  f.state.stripe.paymentMethods = [{id: 'pm_2', customer: 'cus_1', card: {last4: '0005', exp_month: month.getUTCMonth() + 1, exp_year: month.getUTCFullYear()}}];
  f.state.stripe.subscriptions[0].default_payment_method = 'pm_2';
  await hook(f, 'payment_method.attached', {id: 'pm_2', customer: 'cus_1'});
  p = await plan(f, login);
  assert.equal(p.standing, 'ok');
  assert.equal(p.card.last4, '0005');
  assert.equal(p.card.expiring, true, 'a card expiring within the month shows the banner');
});
