#!/usr/bin/env node
// Phase 5 prep (docs/ACCOUNTS-ROADMAP.md): the billing code against REAL Stripe sandbox objects on test clocks.
// The unit tests use hand-made Stripe replies; this runs the Worker (real SQLite D1, as in the tests) against the
// sandbox, fast-forwards Stripe test clocks month by month, replays Stripe's own events into the webhook, and moves
// the Worker's clock with Stripe's so the daily job's day 7/30/90 steps and the annual reminder fire too.
// Emails are captured, never sent. Each scenario has its own test clock, deleted at the end.
//
//   STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-clock-check.mjs [scenario …]
// Scenarios: renewal, dunning, close90, downgrade, annual, cancel (default: all). Test keys only.
import crypto from 'node:crypto';
import {fixture} from '../tests/backend-fixture.mjs';
import {lookupKey} from '../backend/billing.js';

const KEY = process.env.STRIPE_SECRET_KEY || '';
if (!KEY.startsWith('sk_test_')) { console.error('Needs a sk_test_ key in STRIPE_SECRET_KEY. Never runs on live.'); process.exit(2); }
const DAY = 86400, HOUR = 3600, WHSEC = 'whsec_clock_check_' + crypto.randomUUID();
const realFetch = globalThis.fetch, realNow = Date.now;
let clockNow = null; // seconds; the Worker's Date.now follows the test clock while a scenario runs
Date.now = () => (clockNow === null ? realNow() : clockNow * 1000);

// ---- Stripe sandbox ----
function form(params, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? form(item, `${name}[${i}]`, out) : out.append(`${name}[${i}]`, String(item))));
    else if (typeof v === 'object') form(v, name, out);
    else out.append(name, String(v));
  }
  return out;
}
async function stripe(method, path, params) {
  const url = new URL(path, 'https://api.stripe.com/v1/');
  if (method !== 'POST' && params) url.search = form(params).toString();
  const r = await realFetch(url, {method, headers: {Authorization: `Bearer ${KEY}`, 'Stripe-Version': '2024-06-20', ...(method === 'POST' ? {'Content-Type': 'application/x-www-form-urlencoded'} : {})}, body: method === 'POST' ? form(params) : undefined});
  const body = await r.json();
  if (!r.ok) throw new Error(`Stripe ${method} ${path}: ${body.error?.message || r.status}`);
  return body;
}
const priceCache = new Map();
async function price(planId, interval = 'month') {
  const key = lookupKey(planId, interval);
  if (!priceCache.has(key)) priceCache.set(key, (await stripe('GET', 'prices', {lookup_keys: [key], active: 'true', limit: 1})).data[0]);
  const p = priceCache.get(key);
  if (!p) throw new Error(`No sandbox price ${key}: run scripts/stripe-sync.mjs --apply`);
  return p;
}

// ---- one scenario's world: fixture Worker + a test clock ----
async function world(name, email) {
  const f = fixture();
  const fixtureFetch = globalThis.fetch;
  // Stripe calls go to the real sandbox; Resend is captured; everything else stays with the fixture's fakes.
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    if (u.startsWith('https://api.stripe.com/')) {
      const headers = new Headers(options?.headers);
      headers.set('Authorization', `Bearer ${KEY}`);
      return realFetch(url, {...options, headers});
    }
    return fixtureFetch(url, options);
  };
  Object.assign(f.env, {STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: WHSEC, BILLING_TEST_EMAILS: email});
  const start = Math.floor(realNow() / 1000);
  const clock = await stripe('POST', 'test_helpers/test_clocks', {frozen_time: start, name: `vftech ${name} ${new Date().toISOString().slice(0, 16)}`});
  clockNow = clock.frozen_time;
  const login = await f.login(email);
  const customerId = f.sqlite.prepare('SELECT id FROM customers WHERE email=?').get(email).id;
  const cus = await stripe('POST', 'customers', {email, name: 'Clock Check', test_clock: clock.id, payment_method: 'pm_card_visa', invoice_settings: {default_payment_method: 'pm_card_visa'}});
  f.sqlite.prepare('UPDATE customers SET stripe_customer_id=?, name=? WHERE id=?').run(cus.id, 'Clock Check', customerId);
  const seen = new Set();
  const w = {
    f, login, clock, cus, customerId, email,
    as: (csrf = true) => ({headers: {Cookie: login.cookie, ...(csrf ? {'X-CSRF-Token': login.body.csrfToken} : {})}}),
    /** Replays every new Stripe event for this customer (oldest first) into the Worker's webhook, signed. */
    async sync() {
      // Handling an event can make Stripe emit more (e.g. settling the rest of what's owed): repeat until quiet.
      const all = [];
      for (let round = 0; round < 4; round++) { const got = await w.syncOnce(); all.push(...got); if (!got.length) break; await new Promise((r) => setTimeout(r, 1500)); }
      return all;
    },
    async syncOnce() {
      const events = [];
      for (let page = null, more = true; more;) {
        const r = await stripe('GET', 'events', {limit: 100, ...(page ? {starting_after: page} : {})});
        for (const e of r.data) {
          const o = e.data?.object || {};
          const mine = o.customer === cus.id || o.id === cus.id;
          if (mine && !seen.has(e.id)) events.push(e);
        }
        more = r.has_more && r.data.at(-1).created >= start - HOUR; page = r.data.at(-1)?.id;
      }
      events.sort((a, b) => a.created - b.created);
      for (const e of events) {
        seen.add(e.id);
        // Stripe stamps events with real time; on a test clock they happened at the clock's time.
        const payload = JSON.stringify({...e, created: clockNow}), t = clockNow;
        const sig = crypto.createHmac('sha256', WHSEC).update(`${t}.${payload}`).digest('hex');
        const res = await f.worker.fetch(new Request('https://vftech.test/api/stripe/webhook', {method: 'POST', headers: {'Stripe-Signature': `t=${t},v1=${sig}`, 'Content-Type': 'application/json'}, body: payload}), f.env);
        if (res.status !== 200) throw new Error(`webhook ${e.type}: HTTP ${res.status} ${await res.text()}`);
      }
      return events.map((e) => e.type);
    },
    /** Moves Stripe's clock (and the Worker's) to `to`, waits until Stripe has caught up, then syncs. */
    async advance(to) {
      while (to - clockNow > 55 * DAY) await w.advance(clockNow + 55 * DAY);
      await stripe('POST', `test_helpers/test_clocks/${clock.id}/advance`, {frozen_time: to});
      for (let i = 0; i < 120; i++) {
        const c = await stripe('GET', `test_helpers/test_clocks/${clock.id}`);
        if (c.status === 'ready') break;
        if (c.status === 'internal_failure') throw new Error('test clock failed');
        await new Promise((r) => setTimeout(r, 2000));
      }
      clockNow = to;
      w.keepSignedIn();
      return w.sync();
    },
    /** The test sign-in lasts 7 days; keep it valid as the clock moves (the daily job would otherwise delete it). */
    keepSignedIn() { f.sqlite.prepare("UPDATE sessions SET expires_at=? WHERE customer_id=?").run(clockNow + 7 * DAY, customerId); },
    async cron() { const jobs = []; await f.worker.scheduled({cron: '17 3 * * *', scheduledTime: clockNow * 1000}, f.env, {waitUntil: (p) => jobs.push(p)}); await Promise.all(jobs); },
    row: () => f.sqlite.prepare('SELECT plan_id AS planId,billing_interval AS interval,status,current_period_end AS periodEnd,cancel_at_period_end AS cancelling,pending_plan_id AS pendingPlanId,pending_interval AS pendingInterval,past_due_since AS pastDueSince,dunning_stage AS stage FROM subscriptions ORDER BY updated_at DESC LIMIT 1').get(),
    plan: async () => (await f.request('session', undefined, w.as(false))).body.plan,
    mails: () => f.state.emails.map((m) => m.payload.subject),
    async subscribe(planId, interval = 'month') {
      const sub = await stripe('POST', 'subscriptions', {customer: cus.id, items: [{price: (await price(planId, interval)).id}], metadata: {plan_id: planId, interval}});
      await w.sync();
      return sub;
    },
    async change(body) { const r = await f.request('billing/change-plan', body, w.as()); if (r.status !== 200) throw new Error(`change-plan ${JSON.stringify(body)}: ${r.status} ${JSON.stringify(r.body)}`); await w.sync(); return r.body; },
    async end() { clockNow = null; globalThis.fetch = fixtureFetch; f.close(); await stripe('DELETE', `test_helpers/test_clocks/${clock.id}`).catch(() => {}); },
  };
  await w.sync();
  return w;
}

// ---- checks ----
const results = [];
function check(scenario, label, ok, detail = '') { results.push({scenario, label, ok: Boolean(ok), detail}); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`); }
const day = (s) => new Date(s * 1000).toISOString().slice(0, 10);

const scenarios = {
  async renewal() {
    const w = await world('renewal', `clock-renewal-${Date.now()}@vftech.test`);
    try {
      await w.subscribe('standard');
      const first = w.row();
      check('renewal', 'subscription saved from Stripe\'s own events', first?.planId === 'standard' && first.status === 'active', `${first?.planId} ${first?.status} ends ${day(first?.periodEnd)}`);
      const types = await w.advance(first.periodEnd + 2 * HOUR);
      const after = w.row();
      check('renewal', 'renews a month later: invoice paid, period moved on', after.status === 'active' && after.periodEnd > first.periodEnd && types.includes('invoice.paid'), `ends ${day(after.periodEnd)}; events ${[...new Set(types)].join(', ')}`);
      check('renewal', 'standing stays ok, features on', (await w.plan()).standing === 'ok' && (await w.plan()).tier === 'standard');
    } finally { await w.end(); }
  },

  async dunning() {
    const w = await world('dunning', `clock-dunning-${Date.now()}@vftech.test`);
    try {
      const sub = await w.subscribe('standard');
      // The card on file starts failing before the first renewal.
      const bad = await stripe('POST', 'payment_methods/pm_card_chargeCustomerFail/attach', {customer: w.cus.id});
      await stripe('POST', `customers/${w.cus.id}`, {invoice_settings: {default_payment_method: bad.id}});
      await w.sync();
      const renewAt = w.row().periodEnd;
      const types = await w.advance(renewAt + 2 * HOUR);
      let r = w.row();
      check('dunning', 'failed renewal: invoice.payment_failed marks it past due', r.pastDueSince && types.includes('invoice.payment_failed'), `status ${r.status}, since ${day(r.pastDueSince || 0)}`);
      check('dunning', 'day 0-6: banner only, features on', (await w.plan()).standing === 'past_due' && (await w.plan()).tier === 'standard');
      await w.advance(r.pastDueSince + 8 * DAY); await w.cron(); r = w.row();
      const p8 = await w.plan();
      check('dunning', 'day 7: payment screen, features paused, day-7 email', p8.standing === 'payment_required' && r.stage === 7 && w.mails().some((s) => /payment/i.test(s)), `stage ${r.stage}, Stripe status ${r.status}`);
      await w.advance(r.pastDueSince + 22 * DAY);
      r = w.row();
      check('dunning', 'Smart Retries done (3 weeks): Stripe marks it unpaid, not cancelled', r.status === 'unpaid', `Stripe status ${r.status}`);
      await w.advance(r.pastDueSince + 31 * DAY); await w.cron(); r = w.row();
      check('dunning', 'day 30: suspended, features off, day-30 email', (await w.plan()).standing === 'suspended' && (await w.plan()).tier === 'free' && r.stage === 30, `stage ${r.stage}`);
      // The customer adds a working card and pays what's owed.
      const good = await stripe('POST', 'payment_methods/pm_card_visa/attach', {customer: w.cus.id});
      await stripe('POST', `customers/${w.cus.id}`, {invoice_settings: {default_payment_method: good.id}});
      // The customer opens the payment screen (owed drafts become open invoices) and pays the oldest one once;
      // our webhook has to settle the rest so the plan comes back.
      const owed = (await w.f.request('billing', undefined, w.as(false))).body.invoices.filter((i) => i.status === 'open');
      check('dunning', 'the payment screen shows every month owed, renewal included', owed.length >= 2, `${owed.length} open, $${owed.reduce((n, i) => n + i.total, 0) / 100}`);
      const oldest = (await stripe('GET', 'invoices', {subscription: sub.id, status: 'open', limit: 10})).data.sort((x, y) => x.created - y.created)[0];
      await stripe('POST', `invoices/${oldest.id}/pay`, {payment_method: good.id});
      await w.advance(clockNow + HOUR);
      r = w.row(); const back = await w.plan();
      const invs = (await stripe('GET', 'invoices', {subscription: sub.id, limit: 10})).data.map((i) => `${i.status}${i.auto_advance === false ? '(no auto)' : ''} $${i.amount_due / 100}`);
      console.log(`    invoices after paying: ${invs.join(', ')}; subscription ${(await stripe('GET', `subscriptions/${sub.id}`)).status}`);
      check('dunning', 'paying everything owed restores the plan at once', !r.pastDueSince && back.standing === 'ok' && back.tier === 'standard', `status ${r.status}, standing ${back.standing}`);
    } finally { await w.end(); }
  },

  async close90() {
    const w = await world('close90', `clock-close90-${Date.now()}@vftech.test`);
    try {
      const sub = await w.subscribe('essentials');
      const bad = await stripe('POST', 'payment_methods/pm_card_chargeCustomerFail/attach', {customer: w.cus.id});
      await stripe('POST', `customers/${w.cus.id}`, {invoice_settings: {default_payment_method: bad.id}});
      await w.advance(w.row().periodEnd + 2 * HOUR);
      const since = w.row().pastDueSince;
      for (const d of [8, 31, 59]) { await w.advance(since + d * DAY); await w.cron(); }
      await w.advance(since + 91 * DAY); await w.cron();
      const s = await stripe('GET', `subscriptions/${sub.id}`);
      const open = (await stripe('GET', 'invoices', {subscription: sub.id, status: 'open', limit: 10})).data.length;
      check('close90', 'day 90: Stripe subscription cancelled, balance written off, plan ends', s.status === 'canceled' && open === 0 && w.row().status === 'canceled', `Stripe ${s.status}, open invoices ${open}, emails: ${w.mails().filter((m) => !/code/i.test(m)).length}`);
      check('close90', 'account falls back to Free', (await w.plan()).tier === 'free');
    } finally { await w.end(); }
  },

  async downgrade() {
    const w = await world('downgrade', `clock-downgrade-${Date.now()}@vftech.test`);
    try {
      await w.subscribe('standard');
      await w.change({planId: 'essentials', acceptTerms: true});
      let r = w.row();
      check('downgrade', 'switch to Essentials scheduled, Standard kept until renewal', r.planId === 'standard' && r.pendingPlanId === 'essentials', `pending ${r.pendingPlanId}`);
      await w.advance(r.periodEnd + 2 * HOUR);
      r = w.row();
      check('downgrade', 'at renewal the plan is Essentials and nothing is pending', r.planId === 'essentials' && !r.pendingPlanId, `${r.planId}, pending ${r.pendingPlanId}`);
      const inv = (await stripe('GET', 'invoices', {customer: w.cus.id, limit: 1})).data[0];
      check('downgrade', 'the renewal invoice is the Essentials price', inv?.amount_due === (await price('essentials')).unit_amount, `$${(inv?.amount_due || 0) / 100}`);
    } finally { await w.end(); }
  },

  async annual() {
    const w = await world('annual', `clock-annual-${Date.now()}@vftech.test`);
    try {
      await w.subscribe('standard');
      await w.advance(clockNow + 10 * DAY);
      await w.change({planId: 'standard', interval: 'year', acceptTerms: true});
      let r = w.row();
      const inv = (await stripe('GET', 'invoices', {customer: w.cus.id, limit: 1})).data[0];
      const year = (await price('standard', 'year')).unit_amount, month = (await price('standard')).unit_amount;
      check('annual', 'monthly → annual now: billed yearly, unused month credited', r.interval === 'year' && inv.amount_paid > year - month && inv.amount_paid < year, `invoice $${inv.amount_paid / 100} (year $${year / 100})`);
      await w.change({planId: 'standard', interval: 'month', acceptTerms: true});
      r = w.row();
      check('annual', 'annual → monthly scheduled for the term end', r.interval === 'year' && r.pendingPlanId === 'standard' && r.pendingInterval === 'month');
      await w.advance(r.periodEnd - 20 * DAY); await w.cron();
      check('annual', 'renewal reminder ~30 days before the annual term ends', w.mails().some((s) => /renews on/.test(s)), w.mails().filter((s) => /renews on/.test(s))[0] || 'no reminder');
      await w.advance(r.periodEnd + 2 * HOUR);
      r = w.row();
      check('annual', 'at the term end it continues monthly', r.interval === 'month' && r.planId === 'standard' && !r.pendingPlanId, `${r.planId} ${r.interval}`);
    } finally { await w.end(); }
  },

  async cancel() {
    const w = await world('cancel', `clock-cancel-${Date.now()}@vftech.test`);
    try {
      await w.subscribe('priority');
      await w.change({planId: 'free', reason: 'Clock check'});
      let r = w.row();
      check('cancel', 'cancel keeps the plan until the period ends', r.cancelling === 1 && r.status === 'active');
      await w.advance(r.periodEnd + 2 * HOUR);
      check('cancel', 'after the period it ends and the account is Free', (await w.plan()).tier === 'free', `Stripe status ${w.row()?.status}`);
    } finally { await w.end(); }
  },
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenarios);
for (const name of wanted) {
  if (!scenarios[name]) { console.error(`Unknown scenario ${name}`); process.exit(2); }
  console.log(`\n${name}`);
  try { await scenarios[name](); } catch (error) { check(name, 'scenario ran to the end', false, error.message); }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed: ${failed.map((r) => `${r.scenario}: ${r.label}`).join(' | ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
