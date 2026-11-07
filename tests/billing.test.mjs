// Billing (backend/billing.js) against real SQLite and a mocked Stripe API. Nothing reaches Stripe.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './backend-fixture.mjs';
import {formEncode, verifyWebhook, lookupKey} from '../backend/billing.js';

function setup(t, {key = true} = {}) {
  const f = fixture();
  t.after(() => f.close());
  if (key) f.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
  f.state.stripe.prices[lookupKey('standard')] = {id: 'price_standard', lookup_key: lookupKey('standard'), unit_amount: 75000};
  return f;
}
const as = (login, csrf = true) => ({headers: {Cookie: login.cookie, ...(csrf ? {'X-CSRF-Token': login.body.csrfToken} : {})}});
const stripeCalls = (f) => f.state.outbound.filter((url) => url.startsWith('https://api.stripe.com/'));
async function sign(payload, secret, t = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const mac = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)))].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `t=${t},v1=${mac}`;
}

test('Without a Stripe key billing is off and Stripe is never called', async (t) => {
  const f = setup(t, {key: false}), login = await f.login();
  assert.equal((await f.request('config')).body.billingEnabled, false);
  assert.deepEqual((await f.request('billing', undefined, as(login))).body, {enabled: false});
  assert.equal((await f.request('billing/checkout', {planId: 'standard', acceptTerms: true}, as(login))).status, 503);
  assert.equal(stripeCalls(f).length, 0);
});

test('Checkout needs a session, the CSRF token, accepted terms and a published monthly plan', async (t) => {
  const f = setup(t), login = await f.login();
  assert.equal((await f.request('config')).body.billingEnabled, true);
  assert.equal((await f.request('billing/checkout', {planId: 'standard', acceptTerms: true})).status, 401);
  assert.equal((await f.request('billing/checkout', {planId: 'standard', acceptTerms: true}, as(login, false))).status, 403);
  assert.equal((await f.request('billing/checkout', {planId: 'standard'}, as(login))).status, 400);
  assert.equal((await f.request('billing/checkout', {planId: 'business', acceptTerms: true}, as(login))).status, 400, 'builds are quoted, not subscribed');
  assert.equal((await f.request('billing/checkout', {planId: 'essentials', acceptTerms: true}, as(login))).status, 503, 'no Stripe price yet');
  assert.equal(stripeCalls(f).filter((url) => !url.includes('/prices')).length, 0);
});

test('Checkout creates the Stripe customer once and a subscription session for the plan price', async (t) => {
  const f = setup(t), login = await f.login();
  const first = await f.request('billing/checkout', {planId: 'standard', acceptTerms: true}, as(login));
  assert.equal(first.status, 200);
  assert.equal(first.body.url, 'https://checkout.stripe.test/cs_test');
  const session = f.state.stripe.sessions[0];
  assert.equal(session.mode, 'subscription');
  assert.equal(session['line_items[0][price]'], 'price_standard');
  assert.equal(session.customer, 'cus_1');
  assert.equal(session.success_url, 'https://vftech.test/account.html?billing=success');
  assert.equal(session['subscription_data[metadata][plan_id]'], 'standard');
  assert.equal(session['automatic_tax[enabled]'], 'false');
  assert.ok(f.state.stripe.keys.includes(`customer-${login.body.customer.id}`), 'customer creation is idempotent');
  await f.request('billing/checkout', {planId: 'standard', acceptTerms: true}, as(login));
  assert.equal(f.state.stripe.customers.length, 1, 'second checkout reuses the customer');
  f.env.STRIPE_TAX = 'on';
  await f.request('billing/checkout', {planId: 'standard', acceptTerms: true}, as(login));
  assert.equal(f.state.stripe.sessions.at(-1)['automatic_tax[enabled]'], 'true');
});

test('Billing status shows the live subscription and invoices with tax, and blocks a second plan', async (t) => {
  const f = setup(t), login = await f.login();
  await f.request('billing/checkout', {planId: 'standard', acceptTerms: true}, as(login));
  f.state.stripe.subscriptions.push({id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: 1900000000, cancel_at_period_end: false, items: {data: [{price: {lookup_key: lookupKey('standard')}}]}});
  f.state.stripe.invoices.push({id: 'in_1', customer: 'cus_1', number: 'VF-0001', created: 1890000000, total: 81975, tax: 6975, currency: 'usd', status: 'paid', hosted_invoice_url: 'https://invoice.stripe.test/1', invoice_pdf: 'https://invoice.stripe.test/1.pdf'});
  f.state.stripe.invoices.push({id: 'in_draft', customer: 'cus_1', status: 'draft', total: 1, created: 1});
  const status = await f.request('billing', undefined, as(login, false));
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.subscription, {id: 'sub_1', planId: 'standard', planName: 'Standard', status: 'active', currentPeriodEnd: 1900000000, cancelAtPeriodEnd: false});
  assert.deepEqual(status.body.invoices.map((invoice) => [invoice.number, invoice.total, invoice.tax, invoice.status]), [['VF-0001', 81975, 6975, 'paid']]);
  assert.equal((await f.request('billing/checkout', {planId: 'priority', acceptTerms: true}, as(login))).status, 409);
  const other = await f.login('two@example.test');
  const theirs = await f.request('billing', undefined, as(other, false));
  assert.equal(theirs.body.subscription, null);
  assert.deepEqual(theirs.body.invoices, []);
});

test('The billing portal opens only for a customer with a billing account', async (t) => {
  const f = setup(t), login = await f.login();
  assert.equal((await f.request('billing/portal', {}, as(login))).status, 404);
  await f.request('billing/checkout', {planId: 'standard', acceptTerms: true}, as(login));
  const portal = await f.request('billing/portal', {}, as(login));
  assert.equal(portal.status, 200);
  assert.equal(portal.body.url, 'https://billing.stripe.test/p_cus_1');
  assert.equal((await f.request('billing/portal', {}, as(login, false))).status, 403);
});

test('Webhooks need a valid recent signature and re-read the subscription from Stripe', async (t) => {
  const f = setup(t), login = await f.login();
  await f.request('billing/checkout', {planId: 'standard', acceptTerms: true}, as(login));
  const hook = (payload, signature) => f.worker.fetch(new Request('https://vftech.test/api/stripe/webhook', {method: 'POST', headers: {'Stripe-Signature': signature, 'Content-Type': 'application/json'}, body: payload}), f.env);
  const payload = JSON.stringify({id: 'evt_1', type: 'customer.subscription.updated', data: {object: {id: 'sub_9', status: 'active'}}});
  assert.equal((await hook(payload, await sign(payload, 'whsec_test'))).status, 404, 'no webhook secret, no endpoint');
  f.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  assert.equal((await hook(payload, await sign(payload, 'whsec_wrong'))).status, 400);
  assert.equal((await hook(payload, await sign(payload, 'whsec_test', Math.floor(Date.now() / 1000) - 3600))).status, 400, 'too old');
  // The event says active, but Stripe now says it cancels at period end: Stripe wins.
  f.state.stripe.subscriptions.push({id: 'sub_9', customer: 'cus_1', status: 'active', current_period_end: 1900000000, cancel_at_period_end: true, items: {data: [{price: {lookup_key: lookupKey('standard')}}]}});
  const ok = await hook(payload, await sign(payload, 'whsec_test'));
  assert.equal(ok.status, 200);
  assert.deepEqual({...f.sqlite.prepare('SELECT plan_id,status,cancel_at_period_end FROM subscriptions WHERE id=?').get('sub_9')}, {plan_id: 'standard', status: 'active', cancel_at_period_end: 1});
});

test('Helpers: Stripe form encoding and signature checks', async () => {
  assert.equal(formEncode({a: 1, line_items: [{price: 'p', quantity: 1}], meta: {x: 'y'}, skip: undefined}).toString(), 'a=1&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1&meta%5Bx%5D=y');
  const payload = '{"id":"evt"}', now = Math.floor(Date.now() / 1000);
  assert.ok(await verifyWebhook(payload, await sign(payload, 's', now), 's', now));
  assert.equal(await verifyWebhook(payload + ' ', await sign(payload, 's', now), 's', now), null);
  assert.equal(await verifyWebhook(payload, '', 's', now), null);
});
