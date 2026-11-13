// Accounts & Subscriptions spec, phase 4d: the staff admin view behind Cloudflare Access (the Worker checks Access's
// RS256 token itself) and the hours meter. Real SQLite; Access keys, Stripe and Resend mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './backend-fixture.mjs';
import {lookupKey} from '../backend/billing.js';

const DAY = 86400, now = () => Math.floor(Date.now() / 1000);
const TEAM = 'vftech.cloudflareaccess.com', AUD = 'aud-test-123';
const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const pair = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify']);
const other = await crypto.subtle.generateKey({name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256'}, true, ['sign', 'verify']);
const publicJwk = {...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig'};
async function jwt(claims = {}, key = pair.privateKey, kid = 'k1') {
  const h = b64url(JSON.stringify({alg: 'RS256', kid, typ: 'JWT'}));
  const p = b64url(JSON.stringify({iss: `https://${TEAM}`, aud: [AUD], email: 'staff@vftech.test', exp: now() + 600, iat: now(), ...claims}));
  return `${h}.${p}.${b64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${h}.${p}`))))}`;
}
function setup(t, configured = true) {
  const f = fixture();
  t.after(() => f.close());
  f.env.STRIPE_SECRET_KEY = 'sk_test_fixture';
  f.env.BILLING_TEST_EMAILS = 'one@example.test';
  if (configured) Object.assign(f.env, {ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ADMIN_EMAILS: 'Staff@vftech.test, boss@vftech.test'});
  f.state.accessKeys = [publicJwk];
  for (const [id, amount] of Object.entries({essentials: 35000, standard: 75000, priority: 150000})) f.state.stripe.prices[lookupKey(id)] = {id: `price_${id}_m`, lookup_key: lookupKey(id), unit_amount: amount, recurring: {interval: 'month'}};
  return f;
}
const as = (login, csrf = true) => ({headers: {Cookie: login.cookie, ...(csrf ? {'X-CSRF-Token': login.body.csrfToken} : {})}});
async function staffCall(f, path, data, token) { return f.request('admin/' + path, data, {headers: {'Cf-Access-Jwt-Assertion': token || (await jwt())}}); }
async function subscriber(f, planId = 'standard', periodEnd = now() + 20 * DAY) {
  const login = await f.login();
  f.sqlite.prepare("UPDATE customers SET stripe_customer_id='cus_1', name='Pat', phone='555 0100' WHERE email='one@example.test'").run();
  f.state.stripe.subscriptions.push({id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: periodEnd, cancel_at_period_end: false, schedule: null, collection_method: 'charge_automatically', items: {data: [{id: 'si_1', price: f.state.stripe.prices[lookupKey(planId)], current_period_end: periodEnd}]}, metadata: {}});
  await f.request('billing', undefined, as(login, false));
  const id = f.sqlite.prepare("SELECT id FROM customers WHERE email='one@example.test'").get().id;
  return {login, id};
}
const today = () => new Date().toISOString().slice(0, 10);

test('Fails closed until Access is configured', async (t) => {
  const f = setup(t, false);
  assert.equal((await staffCall(f, 'customers')).status, 503);
  assert.equal((await f.request('admin', undefined, {headers: {'Cf-Access-Jwt-Assertion': await jwt()}})).status, 503);
});

test('Only a valid Access token for a listed staff email gets in', async (t) => {
  const f = setup(t);
  assert.equal((await f.request('admin/customers')).status, 401, 'no token');
  assert.equal((await staffCall(f, 'customers', undefined, await jwt({}, other.privateKey))).status, 401, 'wrong key');
  assert.equal((await staffCall(f, 'customers', undefined, await jwt({}, other.privateKey, 'k-unknown'))).status, 401, 'unknown key id');
  assert.equal((await staffCall(f, 'customers', undefined, await jwt({aud: ['someone-else']}))).status, 401, 'wrong audience');
  assert.equal((await staffCall(f, 'customers', undefined, await jwt({iss: 'https://evil.cloudflareaccess.com'}))).status, 401, 'wrong issuer');
  assert.equal((await staffCall(f, 'customers', undefined, await jwt({exp: now() - 5}))).status, 401, 'expired');
  const [h, p, s] = (await jwt()).split('.');
  const forged = b64url(JSON.stringify({...JSON.parse(Buffer.from(p, 'base64url')), email: 'boss@vftech.test'}));
  assert.equal((await staffCall(f, 'customers', undefined, `${h}.${forged}.${s}`)).status, 401, 'edited claims break the signature');
  assert.equal((await staffCall(f, 'customers', undefined, await jwt({email: 'customer@example.test'}))).status, 403, 'not on the staff list');
  assert.equal((await staffCall(f, 'customers')).status, 200);
  // The page and its script come from the Worker with a strict CSP; the Access cookie works too.
  const page = await f.worker.fetch(new Request('https://vftech.test/api/admin', {headers: {Cookie: `CF_Authorization=${await jwt()}`}}), f.env);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Type'), /text\/html/);
  assert.match(page.headers.get('Content-Security-Policy'), /script-src 'self'/);
  assert.match(await page.text(), /VFTech admin/);
  assert.equal((await f.worker.fetch(new Request('https://vftech.test/api/admin/app.js', {headers: {'Cf-Access-Jwt-Assertion': await jwt()}}), f.env)).status, 200);
  assert.equal(f.state.certFetches, 2, 'keys are cached; one refetch for an unknown key id');
});

test('Customers list with plan, standing, hours and totals; one customer in detail', async (t) => {
  const f = setup(t), {id} = await subscriber(f);
  await f.login('two@example.test');
  const list = (await staffCall(f, 'customers')).body;
  assert.equal(list.totals.customers, 2);
  assert.deepEqual(list.totals.byPlan, {Standard: 1, Free: 1});
  const pat = list.customers.find((c) => c.id === id);
  assert.equal(pat.planName, 'Standard');
  assert.equal(pat.standing, 'ok');
  assert.equal(pat.hoursIncluded, 3);
  assert.equal((await staffCall(f, 'customers?q=two@')).body.customers.length, 1);
  const detail = (await staffCall(f, 'customer?id=' + id)).body;
  assert.equal(detail.customer.email, 'one@example.test');
  assert.equal(detail.plan.planName, 'Standard');
  assert.equal(detail.sessions, 1);
  assert.equal((await staffCall(f, 'customer?id=nope')).status, 404);
});

test('Hours: logged by staff, totalled for the month, one email at 80%, shown to the customer', async (t) => {
  const f = setup(t), {login, id} = await subscriber(f, 'standard');
  assert.equal((await staffCall(f, 'hours', {customerId: id, date: today(), hours: 0})).status, 400);
  assert.equal((await staffCall(f, 'hours', {customerId: id, date: '2026-13-40', hours: 1})).status, 400);
  assert.equal((await f.request('admin/hours', {customerId: id, date: today(), hours: 1}, {headers: {'Cf-Access-Jwt-Assertion': await jwt(), Origin: 'https://evil.test'}})).status, 403, 'POSTs must come from the site');
  const sent = f.state.emails.length;
  let r = await staffCall(f, 'hours', {customerId: id, date: today(), hours: 2, note: 'Homepage copy'});
  assert.equal(r.status, 201);
  assert.equal(r.body.hours.used, 2);
  assert.equal(f.state.emails.length, sent, 'under 80%: no email');
  r = await staffCall(f, 'hours', {customerId: id, date: today(), hours: 0.5, note: 'Fix form'});
  assert.equal(r.body.hours.warn, true);
  assert.equal(f.state.emails.length, sent + 1);
  const mail = f.state.emails.at(-1).payload;
  assert.deepEqual(mail.to, ['one@example.test']);
  assert.match(mail.subject, /80% of this month’s plan hours/);
  assert.match(mail.text, /2\.5 of the 3 hours/);
  assert.match(mail.text, /\$250 an hour/);
  r = await staffCall(f, 'hours', {customerId: id, date: today(), hours: 1});
  assert.equal(r.body.hours.over, true);
  assert.equal(f.state.emails.length, sent + 1, 'one warning per month');
  const mine = (await f.request('account/hours', undefined, as(login, false))).body;
  assert.equal(mine.included, 3);
  assert.equal(mine.used, 3.5);
  assert.equal(mine.over, true);
  assert.equal(mine.entries.length, 3);
  assert.equal(mine.entries[0].id, undefined, 'entry ids stay staff-side');
  const entry = (await staffCall(f, 'customer?id=' + id)).body.hours.entries.find((e) => e.hours === 1);
  assert.equal((await staffCall(f, 'hours/delete', {id: entry.id})).body.hours.used, 2.5);
  // Hours from before this month don't count.
  f.sqlite.prepare("INSERT INTO time_entries (id,customer_id,work_date,minutes,note,created_by,created_at) VALUES ('old',?,'2020-01-01',600,'',?,0)").run(id, 'staff@vftech.test');
  assert.equal((await f.request('account/hours', undefined, as(login, false))).body.used, 2.5);
  const log = (await staffCall(f, 'log')).body.log;
  assert.equal(log.filter((e) => e.action === 'hours_added').length, 3);
  assert.equal(log[0].action, 'hours_deleted');
  assert.equal(log[0].actor, 'staff@vftech.test');
});

test('The meter month is anchored on the renewal day', async (t) => {
  const f = setup(t);
  const {meterPeriod} = (await import('../backend/account.js')).accounts({HTTPError: Error, json: (x) => x, now: () => 0, catalog: {plans: [], features: []}, field: () => ''});
  const at = Date.UTC(2026, 10, 13) / 1000;
  const p = meterPeriod(Date.UTC(2026, 11, 3) / 1000, at);
  assert.equal(new Date(p.start * 1000).toISOString().slice(0, 10), '2026-11-03');
  assert.equal(new Date(p.end * 1000).toISOString().slice(0, 10), '2026-12-03');
  const yearly = meterPeriod(Date.UTC(2027, 0, 31) / 1000, Date.UTC(2026, 1, 15) / 1000);
  assert.equal(new Date(yearly.start * 1000).toISOString().slice(0, 10), '2026-01-31');
  assert.equal(new Date(yearly.end * 1000).toISOString().slice(0, 10), '2026-02-28', 'short months clamp to their last day');
  const free = meterPeriod(null, at);
  assert.equal(new Date(free.start * 1000).toISOString().slice(0, 10), '2026-11-01');
  void f;
});

test('Suspend turns features off and tells the customer to contact us; reactivate restores', async (t) => {
  const f = setup(t), {login, id} = await subscriber(f, 'standard');
  assert.equal((await staffCall(f, 'suspend', {customerId: id})).status, 400, 'needs a reason');
  assert.equal((await staffCall(f, 'suspend', {customerId: id, reason: 'Abuse report'})).status, 200);
  const session = (await f.request('session', undefined, as(login, false))).body;
  assert.equal(session.plan.standing, 'suspended');
  assert.equal(session.plan.reason, 'staff');
  assert.equal(session.plan.tier, 'free');
  assert.equal((await f.request('account/features', undefined, as(login, false))).body.paused, true);
  assert.equal((await f.request('account/profile', {name: 'X', business: '', phone: ''}, as(login))).status, 402);
  assert.equal((await staffCall(f, 'reactivate', {customerId: id})).status, 200);
  assert.equal((await f.request('session', undefined, as(login, false))).body.plan.standing, 'ok');
  const types = (await f.request('account/history', undefined, as(login, false))).body.events.map((e) => e.type);
  assert.deepEqual(types.slice(0, 2), ['reactivated_by_staff', 'suspended_by_staff']);
});

test('Portal link, two-factor reset, sign out everywhere', async (t) => {
  const f = setup(t), {login, id} = await subscriber(f);
  assert.equal((await staffCall(f, 'portal-url', {customerId: id, url: 'http://insecure.test'})).status, 400);
  assert.equal((await staffCall(f, 'portal-url', {customerId: id, url: 'https://portal.vftech.io/pat'})).status, 200);
  assert.equal(f.sqlite.prepare('SELECT portal_url AS u FROM customers WHERE id=?').get(id).u, 'https://portal.vftech.io/pat');
  f.sqlite.prepare("UPDATE customers SET totp_secret='v1.x.y',totp_enabled_at=1 WHERE id=?").run(id);
  f.sqlite.prepare("INSERT INTO recovery_codes (code_hash,customer_id,created_at) VALUES ('h',?,1)").run(id);
  assert.equal((await staffCall(f, 'reset-2fa', {customerId: id})).status, 200);
  assert.equal(f.sqlite.prepare('SELECT totp_secret AS s FROM customers WHERE id=?').get(id).s, null);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM recovery_codes').get().n, 0);
  assert.equal((await f.request('account/profile', undefined, as(login, false))).status, 401, 'signed out');
  assert.match(f.state.emails.at(-1).payload.subject, /Two-factor sign-in was turned off by our team/);
  const again = await f.login();
  assert.equal((await staffCall(f, 'end-sessions', {customerId: id})).status, 200);
  assert.equal((await f.request('account/profile', undefined, as(again, false))).status, 401);
});

test('Recovery: open requests listed; email change ends sign-ins, updates Stripe and closes the request', async (t) => {
  const f = setup(t), {id} = await subscriber(f);
  await f.login('taken@example.test');
  f.sqlite.prepare("INSERT INTO recovery_requests (id,old_email,new_email,name,invoice,phone,account_found,created_at) VALUES ('r1','one@example.test','new@example.test','Pat','INV-1','555 0100',1,?)").run(now());
  f.sqlite.prepare("INSERT INTO recovery_requests (id,old_email,new_email,created_at) VALUES ('r2','ghost@example.test','x@example.test',?)").run(now());
  const open = (await staffCall(f, 'recovery')).body.requests;
  assert.equal(open.length, 2);
  assert.equal(open.find((r) => r.id === 'r1').customerId, id);
  assert.equal(open.find((r) => r.id === 'r1').phoneOnFile, '555 0100');
  assert.equal((await staffCall(f, 'change-email', {customerId: id, email: 'taken@example.test'})).status, 409);
  assert.equal((await staffCall(f, 'change-email', {customerId: id, email: 'New@Example.test', requestId: 'r1'})).status, 200);
  assert.equal(f.sqlite.prepare('SELECT email FROM customers WHERE id=?').get(id).email, 'new@example.test');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions WHERE customer_id=?').get(id).n, 0);
  assert.equal(f.sqlite.prepare("SELECT status FROM recovery_requests WHERE id='r1'").get().status, 'done');
  assert.deepEqual(f.state.emails.at(-1).payload.to, ['new@example.test']);
  assert.equal((await staffCall(f, 'recovery/close', {id: 'r2', note: 'Could not verify'})).status, 200);
  assert.equal((await staffCall(f, 'recovery')).body.requests.length, 0);
});
