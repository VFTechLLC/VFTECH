// Accounts & Subscriptions spec, phase 3: closing an account (typed email + fresh code; end of paid period, 14-day
// window, or now) and downloading the account's data. Real SQLite, mocked Stripe and Resend.
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
  for (const [id, amount] of Object.entries({essentials: 35000, standard: 75000, priority: 150000})) f.state.stripe.prices[lookupKey(id)] = {id: 'price_' + id, lookup_key: lookupKey(id), unit_amount: amount};
  return f;
}
const as = (login, csrf = true) => ({headers: {Cookie: login.cookie, ...(csrf ? {'X-CSRF-Token': login.body.csrfToken} : {})}});
async function subscriber(f) {
  const login = await f.login();
  f.sqlite.prepare("UPDATE customers SET stripe_customer_id='cus_1' WHERE email='one@example.test'").run();
  f.state.stripe.subscriptions.push({id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: now() + 20 * DAY, cancel_at_period_end: false, schedule: null, items: {data: [{id: 'si_1', price: f.state.stripe.prices[lookupKey('standard')], current_period_end: now() + 20 * DAY}]}, metadata: {}});
  f.state.stripe.paymentMethods = [{id: 'pm_1', customer: 'cus_1', card: {last4: '4242', exp_month: 12, exp_year: 2030}}];
  f.state.stripe.invoices.push({id: 'in_1', number: 'VF-0001', customer: 'cus_1', subscription: 'sub_1', status: 'paid', total: 75000, currency: 'usd', created: now() - DAY, hosted_invoice_url: 'https://invoice.stripe.test/in_1'});
  await f.request('billing', undefined, as(login, false));
  return login;
}
async function code(f, login) {
  const r = await f.request('account/close/code', {}, as(login));
  assert.equal(r.status, 201);
  const mail = f.state.emails.at(-1);
  assert.match(mail.payload.subject, /close your VFTech account/);
  return {challengeId: r.body.challengeId, code: mail.payload.text.match(/\b(\d{6})\b/)[1]};
}
async function cron(f) { const jobs = []; await f.worker.scheduled({cron: '17 3 * * *'}, f.env, {waitUntil: (p) => jobs.push(p)}); await Promise.all(jobs); }
const count = (f, sql) => f.sqlite.prepare(sql).get().n;

test('Closing needs the typed email and a fresh, unused code', async (t) => {
  const f = setup(t), login = await f.login();
  const c = await code(f, login);
  assert.match((await f.request('account/close', {email: 'wrong@example.test', ...c}, as(login))).body.error, /Type the email/);
  assert.match((await f.request('account/close', {email: 'one@example.test', challengeId: c.challengeId, code: '000000'}, as(login))).body.error, /invalid or expired/);
  assert.equal((await f.request('account/close', {email: 'one@example.test', ...c}, as(login, false))).status, 403, 'CSRF required');
  const ok = await f.request('account/close', {email: 'One@Example.test', ...c}, as(login));
  assert.equal(ok.status, 200);
  assert.match((await f.request('account/close', {email: 'one@example.test', ...c}, as(login))).body.error, /invalid or expired|already been used/, 'a code works once');
  // A sign-in code can't be used to close.
  const signIn = await f.challenge('one@example.test');
  assert.equal((await f.request('account/close', {email: 'one@example.test', challengeId: signIn.challengeId, code: signIn.code}, as(login))).status, 400);
});

test('Free account: 14-day window, shown on the session; Keep my account undoes it', async (t) => {
  const f = setup(t), login = await f.login();
  const r = await f.request('account/close', {email: 'one@example.test', ...(await code(f, login))}, as(login));
  assert.ok(Math.abs(r.body.closingAt - (now() + 14 * DAY)) < 5);
  assert.equal((await f.request('session', undefined, as(login, false))).body.customer.closingAt, r.body.closingAt);
  assert.equal((await f.request('account/keep', {}, as(login))).status, 200);
  assert.equal((await f.request('session', undefined, as(login, false))).body.customer.closingAt, null);
  assert.equal((await f.request('account/keep', {}, as(login))).status, 409);
});

test('Paid plan: stops renewing, closes at the end of the period; keeping resumes the plan', async (t) => {
  const f = setup(t), login = await subscriber(f);
  const r = await f.request('account/close', {email: 'one@example.test', ...(await code(f, login))}, as(login));
  const sub = f.state.stripe.subscriptions[0];
  assert.equal(r.body.closingAt, sub.current_period_end);
  assert.equal(sub.cancel_at_period_end, true);
  assert.equal(sub.metadata.closing_account, '1');
  await f.request('account/keep', {}, as(login));
  assert.equal(sub.cancel_at_period_end, false, 'the plan renews again');
  // Keeping the account doesn't undo a cancellation the customer made separately.
  sub.cancel_at_period_end = true; sub.metadata = {};
  f.sqlite.prepare('UPDATE customers SET closing_at=?').run(now() + DAY);
  await f.request('account/keep', {}, as(login));
  assert.equal(sub.cancel_at_period_end, true);
});

test('On the closing date the daily job deletes the account; invoices stay in Stripe', async (t) => {
  const f = setup(t), login = await subscriber(f);
  await f.request('account/close', {email: 'one@example.test', ...(await code(f, login))}, as(login));
  await cron(f);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM customers'), 1, 'not before the date');
  f.sqlite.prepare('UPDATE customers SET closing_at=?').run(now() - 60);
  await cron(f);
  for (const table of ['customers', 'sessions', 'subscriptions', 'plan_events', 'terms_acceptances']) assert.equal(count(f, `SELECT COUNT(*) AS n FROM ${table}`), 0, table + ' emptied');
  assert.equal(count(f, "SELECT COUNT(*) AS n FROM auth_challenges WHERE email='one@example.test'"), 0);
  assert.equal(f.state.stripe.subscriptions[0].status, 'canceled');
  assert.deepEqual(f.state.stripe.detached, ['pm_1'], 'payment methods detached');
  assert.equal(f.state.stripe.invoices[0].status, 'paid', 'invoices untouched');
  assert.match(f.state.emails.at(-1).payload.subject, /account is closed/);
  assert.equal((await f.request('session', undefined, as(login, false))).body.authenticated, false, 'signed out everywhere');
});

test('Close now ends the plan and the account at once, with no refund', async (t) => {
  const f = setup(t), login = await subscriber(f);
  const r = await f.request('account/close', {email: 'one@example.test', when: 'now', ...(await code(f, login))}, as(login));
  assert.equal(r.status, 200);
  assert.match(r.response.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal(count(f, 'SELECT COUNT(*) AS n FROM customers'), 0);
  assert.equal(f.state.stripe.subscriptions[0].status, 'canceled');
  assert.ok(!(f.state.stripe.refunds || []).length, 'no refund');
});

test('Download my data: profile, plan, requests, history and invoices in one JSON file', async (t) => {
  const f = setup(t), login = await subscriber(f);
  await f.request('contact', f.contact({email: 'one@example.test', idempotencyKey: crypto.randomUUID(), turnstileToken: f.token('contact')}));
  const r = await f.worker.fetch(new Request('https://vftech.test/api/account/export', {headers: {Cookie: login.cookie}}), f.env);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Content-Disposition'), /attachment; filename="vftech-account-data.json"/);
  const data = await r.json();
  assert.equal(data.profile.email, 'one@example.test');
  assert.equal(data.plan.tier, 'standard');
  assert.equal(data.invoices[0].number, 'VF-0001');
  assert.ok(Array.isArray(data.requests) && Array.isArray(data.planHistory) && Array.isArray(data.termsAccepted));
  assert.equal((await f.worker.fetch(new Request('https://vftech.test/api/account/export'), f.env)).status, 401, 'signed in only');
});
