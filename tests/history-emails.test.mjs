// Accounts & Subscriptions spec, phase 3: plan history, the optional cancellation "why", the welcome email per plan
// (Priority's has a kickoff link) and a confirmation email for every plan change. Real SQLite, mocked Stripe and Resend.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './backend-fixture.mjs';
import {lookupKey} from '../backend/billing.js';

const DAY = 86400, now = () => Math.floor(Date.now() / 1000);
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
  f.sqlite.prepare("UPDATE customers SET stripe_customer_id='cus_1', name='Pat' WHERE email='one@example.test'").run();
  f.state.stripe.subscriptions.push({id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: now() + 20 * DAY, cancel_at_period_end: false, schedule: null, items: {data: [{id: 'si_1', price: f.state.stripe.prices[lookupKey(planId)], current_period_end: now() + 20 * DAY}]}, metadata: {}});
  await f.request('billing', undefined, as(login, false));
  return login;
}
async function sign(payload, secret, t = now()) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const mac = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)))].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `t=${t},v1=${mac}`;
}
async function hook(f, type, object) {
  const payload = JSON.stringify({id: 'evt_' + crypto.randomUUID().slice(0, 8), type, created: now(), data: {object}});
  const response = await f.worker.fetch(new Request('https://vftech.test/api/stripe/webhook', {method: 'POST', headers: {'Stripe-Signature': await sign(payload, 'whsec_test'), 'Content-Type': 'application/json'}, body: payload}), f.env);
  assert.equal(response.status, 200);
}
const lastMail = (f) => f.state.emails.at(-1).payload;
const history = async (f, login) => (await f.request('account/history', undefined, as(login, false))).body.events;

for (const planId of ['essentials', 'priority']) test(`Checkout completed sends the ${planId} welcome and starts the history`, async (t) => {
  const f = setup(t), login = await subscriber(f, planId);
  const sent = f.state.emails.length;
  await hook(f, 'checkout.session.completed', {id: 'cs_1', mode: 'subscription', customer: 'cus_1', subscription: 'sub_1'});
  assert.equal(f.state.emails.length, sent + 1);
  const mail = lastMail(f);
  assert.deepEqual(mail.to, ['one@example.test']);
  assert.match(mail.subject, planId === 'priority' ? /Welcome to VFTech Priority/ : /Welcome to VFTech Essentials/);
  assert.match(mail.text, /^Hi Pat,/);
  if (planId === 'priority') { assert.match(mail.text, /kickoff call/); assert.match(mail.text, /8 hours/); }
  else { assert.doesNotMatch(mail.text, /kickoff/); assert.match(mail.text, /1 hour/); }
  assert.equal(f.state.emails.at(-1).key, 'welcome-cs_1', 'a repeated webhook reuses the same email key');
  const events = await history(f, login);
  assert.equal(events[0].type, 'subscribed');
  assert.equal(events[0].toPlan, planId);
  // One-time payments get no plan welcome.
  await hook(f, 'checkout.session.completed', {id: 'cs_2', mode: 'payment', customer: 'cus_1'});
  assert.equal(f.state.emails.length, sent + 1);
});

test('Cancelling keeps the optional why; every change is confirmed by email and shows in the history', async (t) => {
  const f = setup(t), login = await subscriber(f, 'standard');
  const change = (body) => f.request('billing/change-plan', body, as(login));
  assert.equal((await change({planId: 'free', reason: 'Too expensive\n<script>'})).status, 200);
  assert.match(lastMail(f).subject, /Your Standard plan is cancelled/);
  assert.match(lastMail(f).text, /continues as Free/);
  assert.equal((await change({planId: 'standard'})).status, 200);
  assert.match(lastMail(f).subject, /Your Standard plan will renew/);
  assert.equal((await change({planId: 'priority', acceptTerms: true})).status, 200);
  assert.match(lastMail(f).subject, /You're on Priority now/);
  assert.match(lastMail(f).text, /\$1,500 a month/);
  assert.equal((await change({planId: 'essentials', acceptTerms: true})).status, 200);
  assert.match(lastMail(f).subject, /Your switch to Essentials is scheduled/);
  assert.equal((await change({planId: 'priority'})).status, 200);
  assert.match(lastMail(f).subject, /You're staying on Priority/);
  const events = await history(f, login);
  assert.deepEqual(events.map((e) => e.type), ['change_undone', 'downgrade_scheduled', 'upgraded', 'resumed', 'cancel_scheduled']);
  assert.equal(events.at(-1).reason, 'Too expensive script', 'the why is kept, cleaned');
  assert.equal(events.find((e) => e.type === 'upgraded').toName, 'Priority');
  // A reason is only kept on cancellation.
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM plan_events WHERE reason<>'' AND type<>'cancel_scheduled'").get().n, 0);
});

test('A failed email never undoes a plan change', async (t) => {
  const f = setup(t), login = await subscriber(f, 'standard');
  f.state.failMail = true;
  const r = await f.request('billing/change-plan', {planId: 'free'}, as(login));
  assert.equal(r.status, 200);
  assert.equal(f.state.stripe.subscriptions[0].cancel_at_period_end, true);
});

test('Plan history is for the signed-in customer only', async (t) => {
  const f = setup(t);
  assert.equal((await f.request('account/history')).status, 401);
});
