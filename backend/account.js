// Customer accounts, phase 1 of the Accounts & Subscriptions spec (2026-11-13): the customer's plan tier, profile
// editing and the plan features hub. Billing changes live in billing.js; this module only reads what it stores.

// Statuses where the plan's features stay on. past_due keeps them on during Stripe's retries; the day-7 lock and
// day-30 suspension are phase 2.
const FEATURE_STATUSES = new Set(['active', 'trialing', 'past_due']);
export const TIERS = ['free', 'essentials', 'standard', 'priority'];
export const DAY = 86400;

/**
 * Payment standing (spec phase 2), from the days since the first failed payment that is still unpaid:
 *   ok · past_due (days 0-6: banner, features on) · payment_required (7-29: payment screen, features paused)
 *   · suspended (30-89: features off). Day 90 closes the plan (the daily job in billing.js).
 * A dispute, or a paid plan left with no payment method, also means payment_required.
 */
export function standingOf(row, nowSeconds) {
  const since = row.pastDueSince ?? null;
  const days = since === null ? null : Math.max(0, Math.floor((nowSeconds - since) / DAY));
  const dates = since === null ? {} : { suspendsOn: since + 30 * DAY, closesOn: since + 90 * DAY };
  if (days !== null) return { standing: days >= 30 ? 'suspended' : days >= 7 ? 'payment_required' : 'past_due', days, ...dates };
  if (row.disputed) return { standing: 'payment_required', days: null, reason: 'dispute' };
  if (row.noPaymentMethod) return { standing: 'payment_required', days: null, reason: 'no_payment_method' };
  if (row.status === 'past_due' || row.status === 'unpaid') return { standing: 'past_due', days: 0 };
  return { standing: 'ok', days: null };
}
/** The default card, and whether to show "your card expires soon": from 30 days before its expiry month. */
export function cardOf(row, nowSeconds) {
  if (!row.cardExpires) return null;
  const year = Math.floor(row.cardExpires / 100), month = row.cardExpires % 100;
  const monthStart = Date.UTC(year, month - 1, 1) / 1000, monthEnd = Date.UTC(year, month, 1) / 1000;
  return { last4: row.cardLast4 || '', expires: String(month).padStart(2, '0') + '/' + String(year).slice(-2), expiring: nowSeconds >= monthStart - 30 * DAY, expired: nowSeconds >= monthEnd };
}
export const LOCKED = new Set(['payment_required', 'suspended']);

export function accounts({ HTTPError, json, now, catalog, field }) {
  const plans = new Map(catalog.plans.map((plan) => [plan.id, plan]));
  const name = (id) => (id === 'free' ? 'Free' : plans.get(id)?.name ?? id);

  /** The customer's plan as the pages need it: tier drives badges, themes and features. Free = no live plan.
   *  A staff hold (admin view, spec phase 4) suspends the account whatever the billing says. */
  async function planFor(env, customerId) {
    const plan = await billingPlan(env, customerId);
    const hold = await env.DB.prepare('SELECT suspended_at AS at FROM customers WHERE id=?').bind(customerId).first();
    return hold?.at ? { ...plan, tier: 'free', standing: 'suspended', reason: 'staff', suspendedAt: hold.at } : plan;
  }
  async function billingPlan(env, customerId) {
    const row = await env.DB.prepare(
      "SELECT plan_id AS planId,status,current_period_end AS periodEnd,cancel_at_period_end AS cancelling,pending_plan_id AS pendingPlanId,billing_interval AS interval,pending_interval AS pendingInterval,past_due_since AS pastDueSince,disputed,no_payment_method AS noPaymentMethod,card_last4 AS cardLast4,card_expires AS cardExpires FROM subscriptions WHERE customer_id=? AND status IN ('active','trialing','past_due','unpaid','incomplete') ORDER BY updated_at DESC LIMIT 1",
    ).bind(customerId).first();
    if (!row || !plans.has(row.planId)) return { tier: 'free', name: 'Free', status: 'none', standing: 'ok' };
    const standing = standingOf(row, now());
    // Features follow the timeline: on until day 30 (paused from day 7), off while suspended.
    const tier = standing.standing === 'suspended' ? 'free' : FEATURE_STATUSES.has(row.status) || row.pastDueSince ? row.planId : 'free';
    return {
      tier,
      planId: row.planId,
      name: name(row.planId),
      status: row.status,
      periodEnd: row.periodEnd ?? null,
      cancelAtPeriodEnd: Boolean(row.cancelling),
      pendingPlanId: row.pendingPlanId || null,
      pendingPlanName: row.pendingPlanId ? name(row.pendingPlanId) : null,
      interval: row.interval === 'year' ? 'year' : 'month',
      pendingInterval: row.pendingPlanId ? (row.pendingInterval || row.interval || 'month') : null,
      ...standing,
      card: cardOf(row, now()),
    };
  }

  /** GET /api/account/profile */
  async function getProfile(env, active) {
    const row = await env.DB.prepare('SELECT email,name,business,phone FROM customers WHERE id=?').bind(active.customer.id).first();
    return json({ profile: row });
  }

  /** POST /api/account/profile {name, business, phone}. Email changes need a fresh code and come with recovery (phase 2). */
  async function saveProfile(env, active, input) {
    if (LOCKED.has((await planFor(env, active.customer.id)).standing)) throw new HTTPError(402, 'Settle your payment first: only billing, contact and sign out work until then.');
    const data = { name: field(input.name, 'your name', 80), business: field(input.business, 'the business name', 160), phone: field(input.phone, 'the phone number', 40) };
    if (data.phone && !/^[0-9+().\- ]{7,40}$/.test(data.phone)) throw new HTTPError(400, 'Check the phone number.');
    if ([data.name, data.business].some((value) => /[\r\n<>]/.test(value))) throw new HTTPError(400, 'Remove line breaks and angle brackets.');
    await env.DB.prepare('UPDATE customers SET name=?,business=?,phone=? WHERE id=?').bind(data.name, data.business, data.phone, active.customer.id).run();
    return json({ profile: { email: active.customer.email, ...data } });
  }

  /** GET /api/account/features: what the customer's plan includes, each with its button, plus what higher plans unlock. */
  async function features(env, active) {
    const plan = await planFor(env, active.customer.id);
    if (LOCKED.has(plan.standing)) return json({ tier: plan.tier, standing: plan.standing, paused: true, included: [], locked: [] });
    const portal = await env.DB.prepare('SELECT portal_url FROM customers WHERE id=?').bind(active.customer.id).first();
    const included = [], locked = [];
    for (const feature of catalog.features || []) {
      const detail = typeof feature.detail === 'object' ? feature.detail?.[plan.tier] : feature.detail;
      if (feature.plans.includes(plan.tier)) {
        const item = { id: feature.id, type: feature.type, label: feature.label, detail: detail || '' };
        if (feature.type === 'link' || feature.type === 'contact') item.href = feature.href;
        // Only a staff-set https URL becomes a button; until then the customer sees that it's coming.
        if (feature.type === 'portal') {
          if (/^https:\/\/[^\s"'<>]+$/.test(portal?.portal_url || '')) item.href = portal.portal_url;
          else item.detail = 'Your portal link appears here once your project portal is set up.';
        }
        included.push(item);
      } else {
        const unlock = TIERS.find((tier) => feature.plans.includes(tier) && TIERS.indexOf(tier) > TIERS.indexOf(plan.tier));
        if (unlock) locked.push({ id: feature.id, label: feature.label, unlockPlanId: unlock, unlockPlanName: name(unlock) });
      }
    }
    return json({ tier: plan.tier, included, locked });
  }

  /** Plan history and Terms acceptances: the audit trail the spec asks for. */
  async function recordEvent(env, customerId, type, fromPlan, toPlan, reason = '', fromInterval = '', toInterval = '') {
    await env.DB.prepare('INSERT INTO plan_events (id,customer_id,type,from_plan,to_plan,reason,from_interval,to_interval,created_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(), customerId, type, fromPlan || '', toPlan || '', reason || '', fromInterval || '', toInterval || '', now()).run();
  }
  /** GET /api/account/history: the customer's plan history, newest first (spec phase 3). */
  async function history(env, active) {
    const events = (await env.DB.prepare('SELECT type,from_plan AS fromPlan,to_plan AS toPlan,from_interval AS fromInterval,to_interval AS toInterval,reason,created_at AS at FROM plan_events WHERE customer_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100').bind(active.customer.id).all()).results || [];
    return json({ events: events.map((e) => ({ ...e, fromName: e.fromPlan ? name(e.fromPlan) + (e.fromInterval === 'year' ? ' (annual)' : '') : '', toName: e.toPlan ? name(e.toPlan) + (e.toInterval === 'year' ? ' (annual)' : '') : '' })) });
  }
  async function recordTerms(env, customerId, itemId, ipHash) {
    await env.DB.prepare('INSERT INTO terms_acceptances (id,customer_id,item_id,version,ip_hash,accepted_at) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(), customerId, itemId, String(catalog.termsVersion || '1.0'), ipHash || '', now()).run();
  }

  // ---- Hours meter (spec phase 4): staff log time in the admin view; the plan's monthly hours are totalled for the
  // current month of the billing period (annual plans too: the allowance is monthly), with a warning at 80%. ----
  const includedHours = (planId) => { const f = (catalog.features || []).find((x) => x.id === 'hours'); return Number(/[\d.]+/.exec(f?.detail?.[planId] || '')?.[0] || 0); };
  const isoDay = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);
  /** The month of the billing period that contains now: anchored on the renewal day, or the calendar month on Free. */
  function meterPeriod(periodEnd, at = now()) {
    if (!periodEnd) { const d = new Date(at * 1000); const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; return { start, end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000 }; }
    const anchor = new Date(periodEnd * 1000);
    const shift = (months) => { const d = new Date(anchor); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + months); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); return Math.floor(d.getTime() / 1000); };
    let k = 0;
    while (shift(k) > at && k > -40) k--;
    while (shift(k + 1) <= at && k < 40) k++;
    return { start: shift(k), end: shift(k + 1) };
  }
  async function meter(env, customerId, plan) {
    plan = plan || (await planFor(env, customerId));
    const period = meterPeriod(plan.periodEnd, now()), from = isoDay(period.start), to = isoDay(period.end);
    const entries = (await env.DB.prepare('SELECT id,work_date AS date,minutes,note FROM time_entries WHERE customer_id=? AND work_date>=? AND work_date<? ORDER BY work_date DESC,created_at DESC').bind(customerId, from, to).all()).results || [];
    const included = plan.planId && plan.status !== 'none' ? includedHours(plan.planId) : 0;
    const used = entries.reduce((sum, e) => sum + e.minutes, 0) / 60;
    return { included, used: Math.round(used * 100) / 100, periodStart: period.start, periodEnd: period.end, warn: included > 0 && used >= included * 0.8, over: included > 0 && used > included, extraRate: 250, entries: entries.map((e) => ({ id: e.id, date: e.date, hours: e.minutes / 60, note: e.note })) };
  }
  /** GET /api/account/hours */
  async function hours(env, active) {
    const m = await meter(env, active.customer.id);
    return json({ ...m, entries: m.entries.map(({ id, ...rest }) => rest) });
  }

  return { planFor, getProfile, saveProfile, features, recordEvent, recordTerms, history, hours, meter, meterPeriod, includedHours };
}
