// Customer accounts, phase 1 of the Accounts & Subscriptions spec (2026-11-13): the customer's plan tier, profile
// editing and the plan features hub. Billing changes live in billing.js; this module only reads what it stores.

// Statuses where the plan's features stay on. past_due keeps them on during Stripe's retries; the day-7 lock and
// day-30 suspension are phase 2.
const FEATURE_STATUSES = new Set(['active', 'trialing', 'past_due']);
export const TIERS = ['free', 'essentials', 'standard', 'priority'];

export function accounts({ HTTPError, json, now, catalog, field }) {
  const plans = new Map(catalog.plans.map((plan) => [plan.id, plan]));
  const name = (id) => (id === 'free' ? 'Free' : plans.get(id)?.name ?? id);

  /** The customer's plan as the pages need it: tier drives badges, themes and features. Free = no live plan. */
  async function planFor(env, customerId) {
    const row = await env.DB.prepare(
      "SELECT plan_id AS planId,status,current_period_end AS periodEnd,cancel_at_period_end AS cancelling,pending_plan_id AS pendingPlanId FROM subscriptions WHERE customer_id=? AND status IN ('active','trialing','past_due','unpaid','incomplete') ORDER BY updated_at DESC LIMIT 1",
    ).bind(customerId).first();
    if (!row || !plans.has(row.planId)) return { tier: 'free', name: 'Free', status: 'none' };
    const tier = FEATURE_STATUSES.has(row.status) ? row.planId : 'free';
    return {
      tier,
      planId: row.planId,
      name: name(row.planId),
      status: row.status,
      periodEnd: row.periodEnd ?? null,
      cancelAtPeriodEnd: Boolean(row.cancelling),
      pendingPlanId: row.pendingPlanId || null,
      pendingPlanName: row.pendingPlanId ? name(row.pendingPlanId) : null,
    };
  }

  /** GET /api/account/profile */
  async function getProfile(env, active) {
    const row = await env.DB.prepare('SELECT email,name,business,phone FROM customers WHERE id=?').bind(active.customer.id).first();
    return json({ profile: row });
  }

  /** POST /api/account/profile {name, business, phone}. Email changes need a fresh code and come with recovery (phase 2). */
  async function saveProfile(env, active, input) {
    const data = { name: field(input.name, 'your name', 80), business: field(input.business, 'the business name', 160), phone: field(input.phone, 'the phone number', 40) };
    if (data.phone && !/^[0-9+().\- ]{7,40}$/.test(data.phone)) throw new HTTPError(400, 'Check the phone number.');
    if ([data.name, data.business].some((value) => /[\r\n<>]/.test(value))) throw new HTTPError(400, 'Remove line breaks and angle brackets.');
    await env.DB.prepare('UPDATE customers SET name=?,business=?,phone=? WHERE id=?').bind(data.name, data.business, data.phone, active.customer.id).run();
    return json({ profile: { email: active.customer.email, ...data } });
  }

  /** GET /api/account/features: what the customer's plan includes, each with its button, plus what higher plans unlock. */
  async function features(env, active) {
    const plan = await planFor(env, active.customer.id);
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
  async function recordEvent(env, customerId, type, fromPlan, toPlan) {
    await env.DB.prepare('INSERT INTO plan_events (id,customer_id,type,from_plan,to_plan,created_at) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(), customerId, type, fromPlan || '', toPlan || '', now()).run();
  }
  async function recordTerms(env, customerId, itemId, ipHash) {
    await env.DB.prepare('INSERT INTO terms_acceptances (id,customer_id,item_id,version,ip_hash,accepted_at) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(), customerId, itemId, String(catalog.termsVersion || '1.0'), ipHash || '', now()).run();
  }

  return { planFor, getProfile, saveProfile, features, recordEvent, recordTerms };
}
