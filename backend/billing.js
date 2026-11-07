// Subscriptions and billing through Stripe (spec v0.2, approved 2026-10-31): hosted Checkout to subscribe, the
// hosted Customer Portal to change card, see invoices or cancel, and this Worker's D1 for who has which plan.
// Plain fetch, no SDK. Prices are never typed here: each monthly plan in catalog.json is a Stripe price with the
// lookup key vftech_<plan id>_monthly, created by scripts/stripe-sync.mjs. No secret key = billing switched off.

const STRIPE_API = 'https://api.stripe.com/v1/';
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);
const SIGNATURE_TOLERANCE = 300;

export const lookupKey = (planId) => `vftech_${planId}_monthly`;
const planFromLookupKey = (key) => /^vftech_([a-z0-9-]+)_monthly$/.exec(key || '')?.[1] ?? null;

/** Stripe's form encoding: nested objects as a[b]=c, arrays as a[0][b]=c. */
export function formEncode(params, prefix = '', out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) value.forEach((item, index) => (typeof item === 'object' ? formEncode(item, `${name}[${index}]`, out) : out.append(`${name}[${index}]`, String(item))));
    else if (typeof value === 'object') formEncode(value, name, out);
    else out.append(name, String(value));
  }
  return out;
}

/**
 * Verifies a Stripe webhook signature (Stripe-Signature: t=…,v1=…): HMAC-SHA256 of "t.body" with the endpoint
 * secret, in constant time, and no older than five minutes. Returns the parsed event or null.
 */
export async function verifyWebhook(payload, header, secret, nowSeconds) {
  const parts = Object.fromEntries((header || '').split(',').map((part) => part.split('=')).filter((pair) => pair.length === 2));
  const timestamp = Number(parts.t);
  const signatures = (header || '').split(',').filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
  if (!secret || !Number.isFinite(timestamp) || !signatures.length || Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE) return null;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`)))].map((x) => x.toString(16).padStart(2, '0')).join('');
  const same = (a, b) => { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; };
  if (!signatures.some((signature) => same(signature, mac))) return null;
  try { return JSON.parse(payload); } catch { return null; }
}

export function billing({ HTTPError, json, now, origin, catalog }) {
  const plans = new Map(catalog.plans.map((plan) => [plan.id, plan]));
  const enabled = (env) => Boolean(env.STRIPE_SECRET_KEY && env.DB && origin(env));

  async function stripe(env, method, path, params, idempotencyKey) {
    const url = new URL(path, STRIPE_API);
    if (method === 'GET' && params) url.search = formEncode(params).toString();
    const headers = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': '2024-06-20' };
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let response;
    try {
      response = await fetch(url, { method, headers, body: method === 'POST' ? formEncode(params || {}) : undefined, signal: AbortSignal.timeout(10000) });
    } catch {
      throw new HTTPError(502, 'Billing is temporarily unavailable. Please try again.');
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('Stripe', method, path, response.status, result?.error?.type, result?.error?.code);
      throw new HTTPError(502, 'Billing is temporarily unavailable. Please try again.');
    }
    return result;
  }

  /** The customer's Stripe id, created once (idempotent on our customer id) and remembered in D1. */
  async function stripeCustomer(env, customer) {
    const row = await env.DB.prepare('SELECT stripe_customer_id FROM customers WHERE id=?').bind(customer.id).first();
    if (row?.stripe_customer_id) return row.stripe_customer_id;
    const created = await stripe(env, 'POST', 'customers', { email: customer.email, name: customer.name || undefined, metadata: { vftech_customer_id: customer.id } }, `customer-${customer.id}`);
    await env.DB.prepare('UPDATE customers SET stripe_customer_id=? WHERE id=? AND stripe_customer_id IS NULL').bind(created.id, customer.id).run();
    return (await env.DB.prepare('SELECT stripe_customer_id FROM customers WHERE id=?').bind(customer.id).first()).stripe_customer_id;
  }

  /** Stores Stripe's view of one subscription (from a webhook or a refresh). Unknown customers are ignored. */
  async function saveSubscription(env, subscription) {
    const owner = await env.DB.prepare('SELECT id FROM customers WHERE stripe_customer_id=?').bind(subscription.customer).first();
    if (!owner) return false;
    const item = subscription.items?.data?.[0];
    const planId = planFromLookupKey(item?.price?.lookup_key) || subscription.metadata?.plan_id || 'unknown';
    await env.DB.prepare(
      'INSERT INTO subscriptions (id,customer_id,plan_id,status,current_period_end,cancel_at_period_end,updated_at) VALUES (?,?,?,?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET plan_id=excluded.plan_id,status=excluded.status,current_period_end=excluded.current_period_end,cancel_at_period_end=excluded.cancel_at_period_end,updated_at=excluded.updated_at',
    ).bind(subscription.id, owner.id, planId, subscription.status, subscription.current_period_end ?? item?.current_period_end ?? null, subscription.cancel_at_period_end ? 1 : 0, now()).run();
    return true;
  }

  const currentSubscription = (env, customerId) =>
    env.DB.prepare(`SELECT id,plan_id AS planId,status,current_period_end AS currentPeriodEnd,cancel_at_period_end AS cancelAtPeriodEnd FROM subscriptions WHERE customer_id=? AND status IN (${[...LIVE_STATUSES].map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT 1`)
      .bind(customerId, ...LIVE_STATUSES)
      .first();

  /** GET /api/billing: the signed-in customer's plan and invoices (amount, tax, status, links), fresh from Stripe. */
  async function status(env, active) {
    if (!enabled(env)) return json({ enabled: false });
    const row = await env.DB.prepare('SELECT stripe_customer_id FROM customers WHERE id=?').bind(active.customer.id).first();
    let invoices = [];
    if (row?.stripe_customer_id) {
      // Refresh from Stripe so the page is right even if a webhook was missed.
      const subscriptions = await stripe(env, 'GET', 'subscriptions', { customer: row.stripe_customer_id, status: 'all', limit: 5 });
      for (const subscription of subscriptions.data || []) await saveSubscription(env, subscription);
      const list = await stripe(env, 'GET', 'invoices', { customer: row.stripe_customer_id, limit: 12 });
      invoices = (list.data || []).filter((invoice) => invoice.status !== 'draft').map((invoice) => ({
        id: invoice.id,
        number: invoice.number,
        date: invoice.created,
        total: invoice.total,
        tax: invoice.tax ?? (invoice.total_taxes || []).reduce((sum, tax) => sum + (tax.amount || 0), 0),
        currency: invoice.currency,
        status: invoice.status,
        url: invoice.hosted_invoice_url,
        pdf: invoice.invoice_pdf,
      }));
    }
    const subscription = await currentSubscription(env, active.customer.id);
    return json({ enabled: true, subscription: subscription ? { ...subscription, cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd), planName: plans.get(subscription.planId)?.name ?? subscription.planId } : null, invoices });
  }

  /** POST /api/billing/checkout {planId, acceptTerms}: a Stripe Checkout page for one monthly plan. */
  async function checkout(env, active, input) {
    if (!enabled(env)) throw new HTTPError(503, 'Online payment is not switched on yet. Contact us to start a plan.');
    const plan = plans.get(typeof input.planId === 'string' ? input.planId : '');
    if (!plan) throw new HTTPError(400, 'Choose one of the monthly plans.');
    if (input.acceptTerms !== true) throw new HTTPError(400, 'Please accept the Terms of Service to continue.');
    if (await currentSubscription(env, active.customer.id)) throw new HTTPError(409, 'You already have a plan. Use Manage billing to change or cancel it.');
    const prices = await stripe(env, 'GET', 'prices', { lookup_keys: [lookupKey(plan.id)], active: 'true', limit: 1 });
    const price = prices.data?.[0];
    if (!price) throw new HTTPError(503, `${plan.name} isn't available for online payment yet. Contact us to start it.`);
    const customer = await stripeCustomer(env, active.customer);
    const base = origin(env);
    const session = await stripe(env, 'POST', 'checkout/sessions', {
      mode: 'subscription',
      customer,
      client_reference_id: active.customer.id,
      line_items: [{ price: price.id, quantity: 1 }],
      success_url: `${base}/account.html?billing=success`,
      cancel_url: `${base}/account.html?billing=cancelled`,
      billing_address_collection: 'required',
      customer_update: { address: 'auto', name: 'auto' },
      automatic_tax: { enabled: env.STRIPE_TAX === 'on' ? 'true' : 'false' },
      subscription_data: { metadata: { vftech_customer_id: active.customer.id, plan_id: plan.id, terms_accepted_at: String(now()) } },
      allow_promotion_codes: 'false',
    });
    return json({ url: session.url });
  }

  /** POST /api/billing/portal: Stripe's page to change card, see invoices or cancel (cancel takes effect at period end). */
  async function portal(env, active) {
    if (!enabled(env)) throw new HTTPError(503, 'Online billing is not switched on yet.');
    const row = await env.DB.prepare('SELECT stripe_customer_id FROM customers WHERE id=?').bind(active.customer.id).first();
    if (!row?.stripe_customer_id) throw new HTTPError(404, 'There is no billing account yet. Choose a plan first.');
    const session = await stripe(env, 'POST', 'billing_portal/sessions', { customer: row.stripe_customer_id, return_url: `${origin(env)}/account.html` });
    return json({ url: session.url });
  }

  /**
   * POST /api/stripe/webhook: subscription changes from Stripe, signature-checked. Events can arrive late or out of
   * order, so the subscription is re-read from Stripe and saved as it is now; replays are harmless.
   */
  async function webhook(request, env) {
    if (!enabled(env) || !env.STRIPE_WEBHOOK_SECRET) throw new HTTPError(404, 'This endpoint was not found.');
    if (Number(request.headers.get('Content-Length')) > 262144) throw new HTTPError(413, 'This request is too large.');
    const payload = await request.text();
    const event = await verifyWebhook(payload, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET, now());
    if (!event?.id || !event.type) throw new HTTPError(400, 'Invalid signature.');
    const subscriptionId = event.type.startsWith('customer.subscription.') ? event.data?.object?.id : event.type === 'checkout.session.completed' ? event.data?.object?.subscription : null;
    if (typeof subscriptionId === 'string' && /^sub_[A-Za-z0-9]+$/.test(subscriptionId)) await saveSubscription(env, await stripe(env, 'GET', `subscriptions/${subscriptionId}`));
    return json({ received: true });
  }

  return { enabled, status, checkout, portal, webhook };
}
