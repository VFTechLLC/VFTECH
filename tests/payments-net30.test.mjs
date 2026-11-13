// Accounts & Subscriptions spec, phase 4b: Checkout's payment methods (cards, ACH, Google Pay; no Apple Pay), net-30
// invoices on request for Priority and annual plans, and the [Priority] flag on contact requests. Real SQLite,
// mocked Stripe, Resend and Turnstile.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './backend-fixture.mjs';
import {lookupKey, CHECKOUT_METHODS} from '../backend/billing.js';

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
async function subscriber(f, planId, interval = 'month', extra = {}) {
  const login = await f.login();
  f.sqlite.prepare("UPDATE customers SET stripe_customer_id='cus_1', name='Pat', business='Pat Co' WHERE email='one@example.test'").run();
  f.state.stripe.subscriptions.push({id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: now() + 20 * DAY, cancel_at_period_end: false, schedule: null, collection_method: 'charge_automatically', items: {data: [{id: 'si_1', price: f.state.stripe.prices[lookupKey(planId, interval)], current_period_end: now() + 20 * DAY}]}, metadata: {}, ...extra});
  await f.request('billing', undefined, as(login, false));
  return login;
}

test('Checkout uses the "VFTech checkout" payment methods when Stripe has them, else cards and ACH', async (t) => {
  const f = setup(t), login = await f.login();
  await f.request('billing/checkout', {itemId: 'standard', acceptTerms: true}, as(login));
  let session = f.state.stripe.sessions.at(-1);
  assert.equal(session['payment_method_types[0]'], 'card');
  assert.equal(session['payment_method_types[1]'], 'us_bank_account');
  assert.equal(session.payment_method_configuration, undefined);
  f.state.stripe.paymentConfigs = [{id: 'pmc_other', name: 'Default', active: true}, {id: 'pmc_vf', name: CHECKOUT_METHODS, active: true}];
  await f.request('billing/checkout', {itemId: 'standard', acceptTerms: true}, as(login));
  session = f.state.stripe.sessions.at(-1);
  assert.equal(session.payment_method_configuration, 'pmc_vf');
  assert.equal(session['payment_method_types[0]'], undefined, 'Stripe takes one or the other, never both');
});

for (const [planId, interval] of [['priority', 'month'], ['standard', 'year']]) test(`Net 30: ${planId} ${interval} can ask once; staff get one email`, async (t) => {
  const f = setup(t), login = await subscriber(f, planId, interval);
  let status = (await f.request('billing', undefined, as(login, false))).body.net30;
  assert.deepEqual(status, {eligible: true, active: false, requestedAt: null});
  const sent = f.state.emails.length;
  const r = await f.request('billing/net30', {}, as(login));
  assert.equal(r.status, 200);
  assert.ok(r.body.requestedAt);
  assert.equal(f.state.emails.length, sent + 1);
  const mail = f.state.emails.at(-1).payload;
  assert.deepEqual(mail.to, ['inbox@vftech.test']);
  assert.equal(mail.reply_to, 'one@example.test');
  assert.match(mail.subject, /Net-30 invoice request: one@example.test/);
  assert.match(mail.text, /Email invoice to the customer/);
  assert.match(mail.text, /Business: Pat Co/);
  await f.request('billing/net30', {}, as(login));
  assert.equal(f.state.emails.length, sent + 1, 'asking again within 30 days sends nothing');
  status = (await f.request('billing', undefined, as(login, false))).body.net30;
  assert.equal(status.requestedAt, r.body.requestedAt);
  assert.equal((await f.request('account/history', undefined, as(login, false))).body.events[0].type, 'net30_requested');
});

test('Net 30 is not offered on monthly Essentials or Standard, needs CSRF, and shows once Stripe bills by invoice', async (t) => {
  const f = setup(t), login = await subscriber(f, 'standard');
  assert.equal((await f.request('billing', undefined, as(login, false))).body.net30.eligible, false);
  assert.equal((await f.request('billing/net30', {}, as(login))).status, 409);
  assert.equal((await f.request('billing/net30', {}, as(login, false))).status, 403);
  // Staff switch a Priority plan to invoices in Stripe; the refresh picks it up.
  f.state.stripe.subscriptions[0].items.data[0].price = f.state.stripe.prices[lookupKey('priority')];
  f.state.stripe.subscriptions[0].collection_method = 'send_invoice';
  const body = (await f.request('billing', undefined, as(login, false))).body;
  assert.equal(body.subscription.collectionMethod, 'send_invoice');
  assert.deepEqual(body.net30, {eligible: true, active: true, requestedAt: null});
  assert.equal((await f.request('billing/net30', {}, as(login))).status, 409, 'already billed by invoice');
});

test('Contact requests from a Priority customer get [Priority] and the plan on file', async (t) => {
  const f = setup(t), login = await subscriber(f, 'priority');
  let r = await f.request('contact', f.contact(), as(login, false));
  assert.equal(r.status, 201);
  let mail = f.state.emails.at(-1).payload;
  assert.match(mail.subject, /^\[Priority\] VFTech project request /);
  assert.match(mail.text, /Plan on file: Priority · signed in/);
  // Same email, not signed in: still flagged, and staff can see it wasn't signed in.
  r = await f.request('contact', f.contact());
  mail = f.state.emails.at(-1).payload;
  assert.match(mail.subject, /^\[Priority\] /);
  assert.match(mail.text, /not signed in, same email/);
});

test('Other contact requests are not flagged', async (t) => {
  const f = setup(t);
  await f.request('contact', f.contact({email: 'stranger@example.test'}));
  let mail = f.state.emails.at(-1).payload;
  assert.match(mail.subject, /^VFTech project request /);
  assert.match(mail.text, /Plan on file: No account/);
  await subscriber(f, 'standard');
  await f.request('contact', f.contact());
  mail = f.state.emails.at(-1).payload;
  assert.match(mail.subject, /^VFTech project request /);
  assert.match(mail.text, /Plan on file: Standard/);
});
