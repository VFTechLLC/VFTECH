// Accounts & Subscriptions spec, phase 1: plan tier on the session, profile editing, the plan features hub and
// changing plans. Real SQLite, mocked Stripe; nothing leaves the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './backend-fixture.mjs';
import {lookupKey} from '../backend/billing.js';

const PRICES = {essentials: 35000, standard: 75000, priority: 150000};
function setup(t) {
  const f = fixture();
  t.after(() => f.close());
  f.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
  f.env.BILLING_TEST_EMAILS = 'one@example.test';
  for (const [id, amount] of Object.entries(PRICES)) f.state.stripe.prices[lookupKey(id)] = {id: 'price_' + id, lookup_key: lookupKey(id), unit_amount: amount};
  return f;
}
const as = (login, csrf = true) => ({headers: {Cookie: login.cookie, ...(csrf ? {'X-CSRF-Token': login.body.csrfToken} : {})}});
/** A signed-in customer on `planId`, with the Stripe side and D1 in step (as after Checkout + webhook). */
async function subscriber(f, planId = 'standard', extra = {}) {
  const login = await f.login();
  f.sqlite.prepare("UPDATE customers SET stripe_customer_id='cus_1' WHERE email='one@example.test'").run();
  f.state.stripe.subscriptions.push({id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: 1900000000, cancel_at_period_end: false, schedule: null, items: {data: [{id: 'si_1', price: f.state.stripe.prices[lookupKey(planId)]}]}, ...extra});
  await f.request('billing', undefined, as(login, false)); // refreshes D1 from Stripe
  return login;
}
const session = async (f, login) => (await f.request('session', undefined, as(login, false))).body;
const events = (f) => f.sqlite.prepare('SELECT type,from_plan AS fromPlan,to_plan AS toPlan FROM plan_events ORDER BY created_at,rowid').all().map((r) => ({...r}));

test('A new account is Free; the session carries the plan tier', async (t) => {
  const f = setup(t), login = await f.login();
  assert.equal(login.body.plan.tier, 'free');
  assert.equal((await session(f, login)).plan.tier, 'free');
});

test('A subscriber sees their plan on the session; an unpaid plan keeps its name but drops to Free features', async (t) => {
  const f = setup(t), login = await subscriber(f, 'priority');
  const plan = (await session(f, login)).plan;
  assert.equal(plan.tier, 'priority');
  assert.equal(plan.name, 'Priority');
  f.sqlite.prepare("UPDATE subscriptions SET status='unpaid'").run();
  const unpaid = (await session(f, login)).plan;
  assert.equal(unpaid.tier, 'free');
  assert.equal(unpaid.name, 'Priority');
  assert.equal(unpaid.status, 'unpaid');
});

test('Profile: read, save, validate, and CSRF required', async (t) => {
  const f = setup(t), login = await f.login();
  assert.equal((await f.request('account/profile', undefined, as(login, false))).body.profile.email, 'one@example.test');
  assert.equal((await f.request('account/profile', {name: 'Jordan Lee', business: 'Lee Plumbing', phone: '425-555-0100'}, as(login, false))).status, 403);
  const saved = await f.request('account/profile', {name: 'Jordan Lee', business: 'Lee Plumbing', phone: '425-555-0100'}, as(login));
  assert.equal(saved.status, 200);
  assert.equal((await f.request('account/profile', undefined, as(login, false))).body.profile.business, 'Lee Plumbing');
  assert.equal((await f.request('account/profile', {name: 'X', business: '', phone: 'call me maybe'}, as(login))).status, 400);
  assert.equal((await f.request('account/profile', {name: 'A\nB', business: '', phone: ''}, as(login))).status, 400);
});

test('Features hub: Free gets the basics with higher-plan features locked; Priority gets everything', async (t) => {
  const f = setup(t), free = await f.login();
  const hub = (await f.request('account/features', undefined, as(free, false))).body;
  assert.equal(hub.tier, 'free');
  assert.deepEqual(hub.included.map((x) => x.id).sort(), ['email', 'request', 'response']);
  assert.match(hub.included.find((x) => x.id === 'response').detail, /no support for your website/);
  assert.equal(hub.locked.find((x) => x.id === 'phone').unlockPlanName, 'Essentials');
  assert.equal(hub.locked.find((x) => x.id === 'review').unlockPlanName, 'Priority');
  const f2 = setup(t), top = await subscriber(f2, 'priority');
  const full = (await f2.request('account/features', undefined, as(top, false))).body;
  assert.equal(full.locked.length, 0);
  assert.equal(full.included.find((x) => x.id === 'hours').detail, '8 hours');
  assert.equal(full.included.find((x) => x.id === 'portal').href, undefined, 'no portal button until staff set a URL');
  f2.sqlite.prepare("UPDATE customers SET portal_url='https://portal.example.test/lee'").run();
  assert.equal((await f2.request('account/features', undefined, as(top, false))).body.included.find((x) => x.id === 'portal').href, 'https://portal.example.test/lee');
  f2.sqlite.prepare("UPDATE customers SET portal_url='javascript:alert(1)'").run();
  assert.equal((await f2.request('account/features', undefined, as(top, false))).body.included.find((x) => x.id === 'portal').href, undefined, 'only https URLs become buttons');
});

test('Upgrade: immediate and prorated, needs the Terms, records acceptance and history', async (t) => {
  const f = setup(t), login = await subscriber(f, 'standard');
  assert.equal((await f.request('billing/change-plan', {planId: 'priority'}, as(login))).status, 400, 'Terms required');
  const result = await f.request('billing/change-plan', {planId: 'priority', acceptTerms: true}, as(login));
  assert.equal(result.status, 200);
  assert.equal(result.body.changed, 'upgraded');
  const update = f.state.stripe.updates.at(-1);
  assert.equal(update['items[0][price]'], 'price_priority');
  assert.equal(update.proration_behavior, 'always_invoice');
  assert.equal(update.payment_behavior, 'error_if_incomplete');
  assert.equal((await session(f, login)).plan.tier, 'priority');
  assert.deepEqual(events(f), [{type: 'upgraded', fromPlan: 'standard', toPlan: 'priority'}]);
  assert.equal(f.sqlite.prepare("SELECT version FROM terms_acceptances WHERE item_id='priority'").get().version, '1.0');
});

test('Upgrade with a declined card changes nothing and says so', async (t) => {
  const f = setup(t), login = await subscriber(f, 'essentials');
  f.state.stripe.declineNext = true;
  const result = await f.request('billing/change-plan', {planId: 'standard', acceptTerms: true}, as(login));
  assert.equal(result.status, 402);
  assert.match(result.body.error, /declined/);
  assert.equal((await session(f, login)).plan.tier, 'essentials');
  assert.deepEqual(events(f), []);
});

test('Downgrade: scheduled for the period end, shown as pending, and undone by choosing the current plan', async (t) => {
  const f = setup(t), login = await subscriber(f, 'priority');
  const result = await f.request('billing/change-plan', {planId: 'essentials', acceptTerms: true}, as(login));
  assert.equal(result.body.changed, 'downgrade_scheduled');
  const phases = f.state.stripe.scheduleUpdates.at(-1);
  assert.equal(phases['phases[0][items][0][price]'], 'price_priority', 'keeps the current plan until the period ends');
  assert.equal(phases['phases[0][end_date]'], '1900000000');
  assert.equal(phases['phases[1][items][0][price]'], 'price_essentials');
  assert.equal(phases.end_behavior, 'release');
  let plan = (await session(f, login)).plan;
  assert.equal(plan.tier, 'priority', 'still Priority until the period ends');
  assert.equal(plan.pendingPlanName, 'Essentials');
  const billing = (await f.request('billing', undefined, as(login, false))).body;
  assert.equal(billing.subscription.pendingPlanName, 'Essentials', 'a refresh from Stripe keeps the pending change');
  assert.equal((await f.request('billing/change-plan', {planId: 'priority'}, as(login))).body.changed, 'change_undone');
  assert.equal(f.state.stripe.released, 1);
  plan = (await session(f, login)).plan;
  assert.equal(plan.pendingPlanId, null);
  assert.deepEqual(events(f).map((e) => e.type), ['downgrade_scheduled', 'change_undone']);
});

test('Cancel to Free stops at the period end and can be resumed', async (t) => {
  const f = setup(t), login = await subscriber(f, 'standard');
  assert.equal((await f.request('billing/change-plan', {planId: 'free'}, as(login))).body.changed, 'cancel_scheduled');
  let plan = (await session(f, login)).plan;
  assert.equal(plan.tier, 'standard', 'features stay on until the paid period ends');
  assert.equal(plan.cancelAtPeriodEnd, true);
  assert.equal((await f.request('billing/change-plan', {planId: 'standard'}, as(login))).body.changed, 'resumed');
  plan = (await session(f, login)).plan;
  assert.equal(plan.cancelAtPeriodEnd, false);
});

test('Change-plan guards: signed in, CSRF, a published plan, a current subscription, and no change while a payment is failing', async (t) => {
  const f = setup(t), free = await f.login();
  assert.equal((await f.request('billing/change-plan', {planId: 'standard', acceptTerms: true}, as(free, false))).status, 403);
  assert.equal((await f.request('billing/change-plan', {planId: 'gold', acceptTerms: true}, as(free))).status, 400);
  assert.equal((await f.request('billing/change-plan', {planId: 'standard', acceptTerms: true}, as(free))).status, 409, 'Free customers subscribe through Checkout');
  const f2 = setup(t), late = await subscriber(f2, 'standard', {status: 'past_due'});
  assert.equal((await f2.request('billing/change-plan', {planId: 'priority', acceptTerms: true}, as(late))).status, 409);
});

test('Checkout records the Terms acceptance in D1', async (t) => {
  const f = setup(t), login = await f.login();
  assert.equal((await f.request('billing/checkout', {planId: 'standard', acceptTerms: true}, as(login))).status, 200);
  const row = f.sqlite.prepare('SELECT item_id,version,ip_hash FROM terms_acceptances').get();
  assert.equal(row.item_id, 'standard');
  assert.equal(row.version, '1.0');
  assert.match(row.ip_hash, /^[a-f0-9]{64}$/, 'stores a keyed hash, never the raw IP');
});
