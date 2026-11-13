// Subscriptions and billing through Stripe (spec v0.2, approved 2026-10-31): hosted Checkout to subscribe, the
// hosted Customer Portal to change card, see invoices or cancel, and this Worker's D1 for who has which plan.
// Plain fetch, no SDK. Prices are never typed here: each plan in catalog.json is a monthly Stripe price with the
// lookup key vftech_<plan id>_monthly and an annual one (ten times the monthly price, spec phase 4) with
// vftech_<plan id>_yearly, both created by scripts/stripe-sync.mjs. No secret key = billing switched off.

const STRIPE_API = 'https://api.stripe.com/v1/';
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete']);
const SIGNATURE_TOLERANCE = 300;
/** The Stripe payment method configuration Checkout uses (made by scripts/stripe-sync.mjs): cards (Visa, Mastercard,
 *  Amex, Discover), ACH bank debit and Google Pay. No Apple Pay until Sign in with Apple exists; no Link, Cash App,
 *  Amazon Pay, Klarna or other methods; no PayPal (Stripe doesn't process it for US businesses). Spec phase 4. */
export const CHECKOUT_METHODS = 'VFTech checkout';
const methodConfigs = new Map();

export const lookupKey = (planId, interval = 'month') => `vftech_${planId}_${interval === 'year' ? 'yearly' : 'monthly'}`;
/** Annual plans cost ten times the monthly price: two months free (spec phase 4). */
export const ANNUAL_MONTHS = 10;
/** One-time purchases: catalog builds with a fixed published price ("$3,500 Fixed"). Ranges and quotes aren't sold online. */
export const oneTimeKey = (itemId) => `vftech_${itemId}_once`;
export function fixedPriceCents(price) {
  const match = /^\$([\d,]+(?:\.\d{2})?) Fixed$/.exec(price || '');
  return match ? Math.round(Number(match[1].replace(/,/g, '')) * 100) : null;
}
const planFromLookupKey = (key) => /^vftech_([a-z0-9-]+)_(?:monthly|yearly)$/.exec(key || '')?.[1] ?? null;
const intervalOf = (price) => (price?.recurring?.interval === 'year' || /_yearly$/.test(price?.lookup_key || '') ? 'year' : 'month');
const intervalInput = (value) => (value === 'year' || value === 'month' ? value : null);

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

export function billing({ HTTPError, json, now, origin, catalog, audit, mail }) {
  const plans = new Map(catalog.plans.map((plan) => [plan.id, plan]));
  const oneTime = new Map(catalog.builds.filter((build) => fixedPriceCents(build.price) !== null).map((build) => [build.id, build]));
  const enabled = (env) => Boolean(env.STRIPE_SECRET_KEY && env.DB && origin(env));
  const live = (env) => String(env.STRIPE_SECRET_KEY || '').startsWith('sk_live_');
  /** With a live key billing is on for everyone; with a test key only for BILLING_TEST_EMAILS (comma-separated), so a
   *  sandbox key on the live site can't reach real customers. */
  const enabledFor = (env, email) => {
    if (!enabled(env)) return false;
    if (live(env)) return true;
    const testers = String(env.BILLING_TEST_EMAILS || '').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
    return Boolean(email) && testers.includes(String(email).toLowerCase());
  };

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
      if (result?.error?.type === 'card_error') throw new HTTPError(402, 'Your payment method was declined, so nothing changed. Update it in Manage billing and try again.');
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
      'INSERT INTO subscriptions (id,customer_id,plan_id,billing_interval,collection_method,status,current_period_end,cancel_at_period_end,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ' +
        'ON CONFLICT(id) DO UPDATE SET plan_id=excluded.plan_id,billing_interval=excluded.billing_interval,collection_method=excluded.collection_method,status=excluded.status,current_period_end=excluded.current_period_end,cancel_at_period_end=excluded.cancel_at_period_end,updated_at=excluded.updated_at',
    ).bind(subscription.id, owner.id, planId, intervalOf(item?.price), subscription.collection_method === 'send_invoice' ? 'send_invoice' : 'charge_automatically', subscription.status, subscription.current_period_end ?? item?.current_period_end ?? null, subscription.cancel_at_period_end ? 1 : 0, now()).run();
    // A scheduled downgrade is pending only while Stripe still holds the schedule and it hasn't taken effect yet.
    await env.DB.prepare('UPDATE subscriptions SET pending_plan_id=NULL,pending_interval=NULL,schedule_id=NULL WHERE id=? AND (? IS NULL OR (pending_plan_id=plan_id AND COALESCE(pending_interval,billing_interval)=billing_interval))').bind(subscription.id, subscription.schedule || null).run();
    return true;
  }

  const currentSubscription = (env, customerId) =>
    env.DB.prepare(`SELECT id,plan_id AS planId,status,current_period_end AS currentPeriodEnd,cancel_at_period_end AS cancelAtPeriodEnd,pending_plan_id AS pendingPlanId,billing_interval AS interval,pending_interval AS pendingInterval,collection_method AS collectionMethod FROM subscriptions WHERE customer_id=? AND status IN (${[...LIVE_STATUSES].map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT 1`)
      .bind(customerId, ...LIVE_STATUSES)
      .first();

  /** GET /api/billing: the signed-in customer's plan and invoices (amount, tax, status, links), fresh from Stripe. */
  async function status(env, active) {
    if (!enabledFor(env, active.customer.email)) return json({ enabled: false });
    const row = await env.DB.prepare('SELECT stripe_customer_id,net30_requested_at FROM customers WHERE id=?').bind(active.customer.id).first();
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
    const net30 = subscription ? { eligible: net30Eligible(subscription), active: subscription.collectionMethod === 'send_invoice', requestedAt: row?.net30_requested_at ?? null } : null;
    return json({ enabled: true, net30, subscription: subscription ? { ...subscription, cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd), planName: plans.get(subscription.planId)?.name ?? subscription.planId, interval: subscription.interval === 'year' ? 'year' : 'month', pendingInterval: subscription.pendingPlanId ? subscription.pendingInterval || subscription.interval || 'month' : null, pendingPlanName: subscription.pendingPlanId ? plans.get(subscription.pendingPlanId)?.name ?? null : null } : null, invoices });
  }

  /**
   * POST /api/billing/checkout {itemId, interval, acceptTerms}: a Stripe Checkout page. A plan becomes a subscription
   * (interval 'month', the default, or 'year' at ten times the monthly price);
   * a fixed-price build (e.g. "$3,500 Fixed") is a one-time payment with an invoice, so it shows in billing history.
   * Ranged or quoted work can't be bought here: VF Tech sends a Stripe invoice once the price is agreed.
   */
  async function checkout(env, active, input, ipHash) {
    if (!enabledFor(env, active.customer.email)) throw new HTTPError(503, 'Online payment is not switched on yet. Contact us to start a plan.');
    const id = typeof input.itemId === 'string' ? input.itemId : typeof input.planId === 'string' ? input.planId : '';
    const plan = plans.get(id), item = oneTime.get(id);
    if (!plan && !item) throw new HTTPError(400, catalog.builds.some((build) => build.id === id) ? 'This is quoted work. Contact us and we’ll send an invoice once the price is agreed.' : 'Choose one of the published plans.');
    if (input.acceptTerms !== true) throw new HTTPError(400, 'Please accept the Terms of Service to continue.');
    if (plan && (await currentSubscription(env, active.customer.id))) throw new HTTPError(409, 'You already have a plan. Use Manage billing to change or cancel it.');
    const chosen = plan || item;
    const interval = intervalInput(input.interval) || 'month';
    const prices = await stripe(env, 'GET', 'prices', { lookup_keys: [plan ? lookupKey(plan.id, interval) : oneTimeKey(item.id)], active: 'true', limit: 1 });
    const price = prices.data?.[0];
    if (!price) throw new HTTPError(503, `${chosen.name} isn't available for online payment yet. Contact us to start it.`);
    const customer = await stripeCustomer(env, active.customer);
    const base = origin(env);
    const metadata = { vftech_customer_id: active.customer.id, item_id: chosen.id, terms_accepted_at: String(now()), terms_version: String(catalog.termsVersion || '1.0') };
    await audit?.recordTerms(env, active.customer.id, chosen.id, ipHash);
    const session = await stripe(env, 'POST', 'checkout/sessions', {
      mode: plan ? 'subscription' : 'payment',
      customer,
      client_reference_id: active.customer.id,
      line_items: [{ price: price.id, quantity: 1 }],
      // Cards, ACH and Google Pay through the "VFTech checkout" configuration; cards and ACH only if it's missing.
      ...(await checkoutMethods(env)),
      success_url: `${base}/account.html?billing=${plan ? 'success' : 'paid'}`,
      cancel_url: `${base}/account.html?billing=cancelled`,
      billing_address_collection: 'required',
      customer_update: { address: 'auto', name: 'auto' },
      automatic_tax: { enabled: env.STRIPE_TAX === 'on' ? 'true' : 'false' },
      ...(plan
        ? { subscription_data: { metadata: { ...metadata, plan_id: plan.id, interval } } }
        : { invoice_creation: { enabled: 'true', invoice_data: { description: `VF Tech ${item.name}`, metadata } }, payment_intent_data: { metadata } }),
      allow_promotion_codes: 'false',
    });
    return json({ url: session.url });
  }

  /** Finds the "VFTech checkout" payment method configuration once per Worker instance and key. */
  async function checkoutMethods(env) {
    const key = live(env) ? 'live' : 'test';
    if (!methodConfigs.has(key)) {
      let id = null;
      try { id = ((await stripe(env, 'GET', 'payment_method_configurations', { limit: 100 })).data || []).find((c) => c.name === CHECKOUT_METHODS && c.active)?.id || null; }
      catch (error) { console.error('payment method configuration', error?.message); }
      if (!id) return { payment_method_types: ['card', 'us_bank_account'] };
      methodConfigs.set(key, id);
    }
    return { payment_method_configuration: methodConfigs.get(key) };
  }

  /** POST /api/billing/portal: Stripe's page to change card, see invoices or cancel (cancel takes effect at period end). */
  async function portal(env, active) {
    if (!enabledFor(env, active.customer.email)) throw new HTTPError(503, 'Online billing is not switched on yet.');
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
    if (event.type === 'checkout.session.completed' || event.type === 'customer.subscription.created') await refreshCard(env, event.data?.object?.customer);
    if (event.type === 'checkout.session.completed' && event.data?.object?.mode === 'subscription') await welcome(env, event.data.object);
    await paymentEvent(env, event);
    return json({ received: true });
  }


  /**
   * POST /api/billing/change-plan {planId, acceptTerms} — the Manage subscription page (spec: Billing rules).
   *  - higher plan: immediately, prorated difference charged now (declined card = nothing changes)
   *  - lower plan: at the end of the period, through a Stripe subscription schedule; choosing the current plan undoes it
   *  - 'free': the plan stops at the end of the period; choosing the current plan again resumes it
   * Moving to a paid plan needs the Terms accepted for that plan. Every change is recorded in plan_events.
   */
  async function changePlan(env, active, input, ipHash) {
    if (!enabledFor(env, active.customer.email)) throw new HTTPError(503, 'Online billing is not switched on yet.');
    const target = typeof input.planId === 'string' ? input.planId : '';
    if (target !== 'free' && !plans.has(target)) throw new HTTPError(400, 'Choose one of the published plans.');
    const current = await currentSubscription(env, active.customer.id);
    if (!current) throw new HTTPError(409, target === 'free' ? 'You are already on Free.' : 'You don’t have a plan yet. Choose one to subscribe.');
    const fromInterval = current.interval === 'year' ? 'year' : 'month', interval = target === 'free' ? '' : intervalInput(input.interval) || fromInterval;
    if (!['active', 'trialing'].includes(current.status)) throw new HTTPError(409, 'Settle your last payment in Manage billing before changing plans.');
    const rank = (id) => (id === 'free' ? 0 : catalog.plans.findIndex((plan) => plan.id === id) + 1);
    const sub = await stripe(env, 'GET', `subscriptions/${current.id}`);
    const item = sub.items?.data?.[0];
    if (!item) throw new HTTPError(502, 'Billing is temporarily unavailable. Please try again.');
    const release = async () => { if (sub.schedule) await stripe(env, 'POST', `subscription_schedules/${sub.schedule}/release`, {}); };
    const priceFor = async (planId) => {
      const price = (await stripe(env, 'GET', 'prices', { lookup_keys: [lookupKey(planId, interval)], active: 'true', limit: 1 })).data?.[0];
      if (!price) throw new HTTPError(503, `${plans.get(planId).name} isn’t available for online payment yet. Contact us to switch.`);
      return price;
    };
    const needTerms = () => { if (input.acceptTerms !== true) throw new HTTPError(400, 'Please accept the Terms of Service for the new plan to continue.'); };
    let event;
    // Spec phase 4: monthly → annual takes effect now, with the unused month credited; annual → monthly waits for
    // the end of the annual term. A higher plan is immediate unless it also leaves an annual term early.
    const sameInterval = interval === fromInterval;
    const immediate = target !== 'free' && (rank(target) > rank(current.planId) || (target === current.planId && interval === 'year')) && !(fromInterval === 'year' && interval === 'month');
    if (target === current.planId && sameInterval) {
      if (sub.cancel_at_period_end) { await stripe(env, 'POST', `subscriptions/${sub.id}`, { cancel_at_period_end: 'false' }); event = 'resumed'; }
      else if (sub.schedule) { await release(); event = 'change_undone'; }
      else throw new HTTPError(409, `You’re already on ${plans.get(target).name}.`);
    } else if (target === 'free') {
      await release();
      await stripe(env, 'POST', `subscriptions/${sub.id}`, { cancel_at_period_end: 'true' });
      event = 'cancel_scheduled';
    } else if (immediate) {
      needTerms();
      const price = await priceFor(target);
      await release();
      await stripe(env, 'POST', `subscriptions/${sub.id}`, {
        items: [{ id: item.id, price: price.id }],
        proration_behavior: 'always_invoice',
        payment_behavior: 'error_if_incomplete',
        cancel_at_period_end: 'false',
        metadata: { plan_id: target, interval, terms_version: String(catalog.termsVersion || '1.0'), terms_accepted_at: String(now()) },
      }, `upgrade-${sub.id}-${target}-${interval}-${now()}`);
      event = target === current.planId ? 'switched_annual' : 'upgraded';
    } else {
      needTerms();
      const price = await priceFor(target);
      if (sub.cancel_at_period_end) await stripe(env, 'POST', `subscriptions/${sub.id}`, { cancel_at_period_end: 'false' });
      const schedule = sub.schedule ? await stripe(env, 'GET', `subscription_schedules/${sub.schedule}`) : await stripe(env, 'POST', 'subscription_schedules', { from_subscription: sub.id });
      const phase = schedule.phases?.[0];
      if (!phase) throw new HTTPError(502, 'Billing is temporarily unavailable. Please try again.');
      await stripe(env, 'POST', `subscription_schedules/${schedule.id}`, {
        end_behavior: 'release',
        proration_behavior: 'none',
        phases: [
          { items: [{ price: item.price.id, quantity: 1 }], start_date: phase.start_date, end_date: phase.end_date },
          { items: [{ price: price.id, quantity: 1 }], iterations: 1, metadata: { plan_id: target, interval, terms_version: String(catalog.termsVersion || '1.0') } },
        ],
      });
      await env.DB.prepare('UPDATE subscriptions SET pending_plan_id=?,pending_interval=?,schedule_id=? WHERE id=?').bind(target, interval, schedule.id, sub.id).run();
      event = rank(target) < rank(current.planId) ? 'downgrade_scheduled' : 'switch_scheduled';
    }
    if (target !== 'free' && !(target === current.planId && sameInterval)) await audit?.recordTerms(env, active.customer.id, target, ipHash);
    // Cancelling asks one optional "why" (spec: honest cancellation); it is kept with the event.
    const reason = event === 'cancel_scheduled' && typeof input.reason === 'string' ? input.reason.replace(/[\r\n<>]+/g, ' ').trim().slice(0, 300) : '';
    await audit?.recordEvent(env, active.customer.id, event, current.planId, target, reason, fromInterval, interval || '');
    const fresh = await stripe(env, 'GET', `subscriptions/${sub.id}`);
    await saveSubscription(env, fresh);
    await confirmChange(env, active.customer, event, current.planId, target, fresh.current_period_end ?? fresh.items?.data?.[0]?.current_period_end, interval || fromInterval);
    if (event === 'downgrade_scheduled' || event === 'switch_scheduled') await env.DB.prepare('UPDATE subscriptions SET pending_plan_id=?,pending_interval=?,schedule_id=? WHERE id=?').bind(target, interval, fresh.schedule || null, sub.id).run();
    return json({ changed: event });
  }


  // ---- Net-30 invoices (spec phase 4): on request for Priority and annual plans. The customer asks here; staff
  // approve it and switch the subscription to "email invoice, due in 30 days" in Stripe (the admin view comes in 4d). ----
  const net30Eligible = (sub) => Boolean(sub && ['active', 'trialing'].includes(sub.status) && (sub.planId === 'priority' || sub.interval === 'year'));
  /** POST /api/billing/net30: asks for invoice billing, net 30. One staff email per 30 days. */
  async function requestNet30(env, active) {
    if (!enabledFor(env, active.customer.email)) throw new HTTPError(503, 'Online billing is not switched on yet.');
    const sub = await currentSubscription(env, active.customer.id);
    if (!net30Eligible(sub)) throw new HTTPError(409, 'Invoice billing with 30 days to pay is for Priority and annual plans.');
    if (sub.collectionMethod === 'send_invoice') throw new HTTPError(409, 'Your plan is already billed by invoice.');
    const row = await env.DB.prepare('SELECT name,business,phone,net30_requested_at AS at FROM customers WHERE id=?').bind(active.customer.id).first();
    if (row?.at && now() - row.at < 30 * DAY) return json({ requestedAt: row.at });
    const at = now(), staff = String(env.CONTACT_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
    await env.DB.prepare('UPDATE customers SET net30_requested_at=? WHERE id=?').bind(at, active.customer.id).run();
    await audit?.recordEvent(env, active.customer.id, 'net30_requested', sub.planId, sub.planId, '', sub.interval, sub.interval);
    if (staff.length) await sendSafely(env, {
      to: staff,
      reply_to: active.customer.email,
      subject: `Net-30 invoice request: ${active.customer.email}`,
      text: [
        `${row?.name || 'A customer'} (${active.customer.email}) asks to pay ${plans.get(sub.planId)?.name ?? sub.planId} ${sub.interval === 'year' ? 'annual' : 'monthly'} by invoice, due 30 days after it's sent.`,
        `Business: ${row?.business || '—'}`, `Phone: ${row?.phone || '—'}`, `Subscription: ${sub.id}`, '',
        'To approve: in Stripe, open the subscription, Edit, Payment, choose "Email invoice to the customer to pay manually" with 30 days to pay. The account page shows it once Stripe tells us. To decline, reply to the customer.',
      ].join('\n'),
    }, `net30-${active.customer.id}-${at}`);
    return json({ requestedAt: at });
  }

  // ---- Emails (spec phase 3): a welcome per plan, and a confirmation for every plan change. Stripe sends receipts,
  // retry and expiring-card emails, so none of those are duplicated here. A failed email never undoes a change. ----
  const monthlyPrice = (id) => String(plans.get(id)?.price || '').replace('/mo', ' a month');
  const yearlyPrice = (id) => { const cents = monthlyCents(id); return cents ? `$${(cents * ANNUAL_MONTHS / 100).toLocaleString('en-US')} a year` : ''; };
  const monthlyCents = (id) => { const m = /^\$([\d,]+)/.exec(plans.get(id)?.price || ''); return m ? Number(m[1].replace(/,/g, '')) * 100 : 0; };
  const priceText = (id, interval) => (interval === 'year' ? yearlyPrice(id) : monthlyPrice(id));
  const featureDetail = (featureId, planId) => { const f = (catalog.features || []).find((x) => x.id === featureId); return typeof f?.detail === 'object' ? f.detail[planId] || '' : f?.detail || ''; };
  const sendSafely = async (env, payload, key) => { if (!mail) return; try { await mail(env, payload, key); } catch (error) { console.error('email', key, error?.message); } };
  const shortDay = (seconds) => (seconds ? new Date(seconds * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'the end of this billing period');

  async function welcome(env, session) {
    const owner = session.customer && (await env.DB.prepare('SELECT id,email,name FROM customers WHERE stripe_customer_id=?').bind(session.customer).first());
    const row = owner && session.subscription && (await env.DB.prepare('SELECT plan_id AS planId FROM subscriptions WHERE id=?').bind(session.subscription).first());
    if (!owner || !row || !plans.has(row.planId)) return;
    const id = row.planId, plan = plans.get(id), account = `${origin(env)}/account.html`;
    await audit?.recordEvent(env, owner.id, 'subscribed', 'free', id);
    const lines = [
      `Hi ${owner.name || 'there'},`, '',
      `Welcome to VFTech ${plan.name}. Thank you for choosing us.`, '',
      'What your plan includes:',
      `- Changes handled by us: ${featureDetail('hours', id) || 'as agreed'} each month`,
      `- Response time: ${featureDetail('response', id) || 'as agreed'}`,
      '- Hosting, domain and SSL, daily backups kept 30 days, uptime monitoring and security updates',
    ];
    if (id !== 'essentials') lines.push('- The AI update assistant and a monthly traffic and lead report');
    if (id === 'priority') lines.push('- A quarterly technology and search review', '', `First step: book your kickoff call so we can plan the work together: ${origin(env)}/contact.html?plan=priority`);
    lines.push('', `Send requests and see your plan any time from your account: ${account}`, 'Your receipt comes separately from our payment provider.', '', 'VF Tech', 'kevinvf@vftech.io');
    await sendSafely(env, { to: [owner.email], subject: `Welcome to VFTech ${plan.name}`, text: lines.join('\n') }, `welcome-${session.id}`);
  }

  async function confirmChange(env, customer, event, fromId, toId, periodEnd, interval = 'month') {
    const from = plans.get(fromId)?.name ?? fromId, to = toId === 'free' ? 'Free' : plans.get(toId)?.name ?? toId, when = shortDay(periodEnd);
    const message = {
      upgraded: [`You're on ${to} now`, `Your plan changed from ${from} to ${to} today. The difference for the rest of this billing period was charged now, and your receipt comes separately. From ${when} it's ${priceText(toId, interval)}, plus tax where it applies.`],
      switched_annual: [`You're on ${to} annual now`, `Your ${to} plan is billed yearly from today at ${yearlyPrice(toId)}, two months free compared with monthly. The unused part of this month was credited against the first year, and your receipt comes separately. You'll get a reminder 30 days before it renews.`],
      switch_scheduled: [`Your switch to ${to} ${interval === 'year' ? 'annual' : 'monthly'} is scheduled`, `You keep your annual ${from} plan until ${when}, then it continues as ${to} at ${priceText(toId, interval)}. Nothing is charged today. Changed your mind? Keep your plan from your account page.`],
      downgrade_scheduled: [`Your switch to ${to} is scheduled`, `You keep ${from} until ${when}, then your plan switches to ${to} at ${priceText(toId, interval)}. Nothing is charged today. Changed your mind? Keep ${from} from your account page.`],
      cancel_scheduled: [`Your ${from} plan is cancelled`, `Your plan stays active until ${when}, then your account continues as Free, with no service plan. There are no further charges. Changed your mind? Keep your plan from your account page.`],
      resumed: [`Your ${from} plan will renew`, `Your cancellation is undone. Your plan renews as usual on ${when}.`],
      change_undone: [`You're staying on ${from}`, `Your scheduled switch is cancelled. You stay on ${from}, and it renews as usual on ${when}.`],
    }[event];
    if (!message) return;
    await sendSafely(env, { to: [customer.email], subject: message[0], text: `Hi ${customer.name || 'there'},\n\n${message[1]}\n\nYour account: ${origin(env)}/account.html\n\nVF Tech\nkevinvf@vftech.io` }, `plan-${event}-${customer.id}-${now()}`);
  }

  // ---- Payment rules (spec phase 2) ----
  const DAY = 86400;
  const subIdOf = (invoice) => invoice?.subscription || invoice?.parent?.subscription_details?.subscription || null;
  const ownerOf = (env, stripeCustomer) => env.DB.prepare('SELECT id,email,name FROM customers WHERE stripe_customer_id=?').bind(stripeCustomer).first();

  /** The customer's default payment method, kept in D1 for the expiring-card banner and the "no method" rule. */
  async function refreshCard(env, stripeCustomer) {
    if (typeof stripeCustomer !== 'string' || !/^cus_\w+$/.test(stripeCustomer)) return;
    const owner = await ownerOf(env, stripeCustomer);
    if (!owner) return;
    const methods = (await stripe(env, 'GET', `customers/${stripeCustomer}/payment_methods`, { limit: 20 })).data || [];
    const customer = await stripe(env, 'GET', `customers/${stripeCustomer}`);
    const row = await currentSubscription(env, owner.id);
    const sub = row ? await stripe(env, 'GET', `subscriptions/${row.id}`) : null;
    const pick = (value) => (value && typeof value === 'object' ? value.id : value);
    const chosen = pick(sub?.default_payment_method) || pick(customer.invoice_settings?.default_payment_method) || methods[0]?.id;
    const card = (methods.find((m) => m.id === chosen) || methods[0])?.card;
    await env.DB.prepare(`UPDATE subscriptions SET no_payment_method=?,card_last4=?,card_expires=? WHERE customer_id=? AND status IN (${[...LIVE_STATUSES].map(() => '?').join(',')})`)
      .bind(methods.length ? 0 : 1, card?.last4 ?? null, card ? card.exp_year * 100 + card.exp_month : null, owner.id, ...LIVE_STATUSES).run();
  }

  /** Webhook events for the payment timeline. Stripe stays the source of truth: each one re-reads what it needs. */
  async function paymentEvent(env, event) {
    const object = event.data?.object || {};
    if (event.type === 'invoice.payment_failed') {
      const subId = subIdOf(object);
      if (subId) await env.DB.prepare('UPDATE subscriptions SET past_due_since=COALESCE(past_due_since,?) WHERE id=?').bind(Number(event.created) || now(), subId).run();
    } else if (event.type === 'invoice.paid') {
      const subId = subIdOf(object);
      if (!subId) return;
      const open = (await stripe(env, 'GET', 'invoices', { subscription: subId, status: 'open', limit: 1 })).data || [];
      if (!open.length) await env.DB.prepare('UPDATE subscriptions SET past_due_since=NULL,dunning_stage=0 WHERE id=?').bind(subId).run();
    } else if (event.type === 'charge.dispute.created' || event.type === 'charge.dispute.closed') {
      const charge = typeof object.charge === 'string' ? await stripe(env, 'GET', `charges/${object.charge}`) : object.charge;
      const owner = charge?.customer && (await ownerOf(env, charge.customer));
      // A dispute puts the account on the payment screen; it lifts only when the dispute is won.
      if (owner && (event.type === 'charge.dispute.created' || object.status === 'won'))
        await env.DB.prepare('UPDATE subscriptions SET disputed=? WHERE customer_id=?').bind(event.type === 'charge.dispute.created' ? 1 : 0, owner.id).run();
    } else if (event.type.startsWith('payment_method.') || event.type === 'customer.updated') {
      await refreshCard(env, event.type === 'customer.updated' ? object.id : object.customer || event.data?.previous_attributes?.customer);
    }
  }

  const TIMELINE = [7, 25, 30, 90];
  const longDate = (seconds) => new Date(seconds * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  function timelineEmail(env, step, row) {
    const plan = plans.get(row.planId)?.name ?? 'VFTech', hi = `Hi ${row.name || 'there'},`, link = `${origin(env)}/account.html`;
    const suspends = longDate(row.since + 30 * DAY), closes = longDate(row.since + 90 * DAY), sign = 'VF Tech\nkevinvf@vftech.io';
    const text = {
      7: [`Payment needed for your ${plan} plan`, `${hi}\n\nWe still haven't been able to collect payment for your ${plan} plan, so work on your plan is paused until it's paid.\n\nSign in to pay what's owed or update your card: ${link}\n\nIf it's still unpaid on ${suspends}, your plan is suspended.\n\n${sign}`],
      25: [`Your ${plan} plan is suspended in 5 days`, `${hi}\n\nYour ${plan} plan still has an unpaid balance. On ${suspends} it will be suspended and its features switched off.\n\nPay what's owed here: ${link}\n\n${sign}`],
      30: [`Your ${plan} plan is suspended`, `${hi}\n\nYour ${plan} plan is now suspended because of an unpaid balance. Paying everything owed restores it straight away.\n\nIf it's not paid by ${closes}, your plan will be closed.\n\nPay here: ${link}\n\n${sign}`],
      90: [`Your ${plan} plan is closed`, `${hi}\n\nThe balance on your ${plan} plan stayed unpaid for 90 days, so we have ended the plan and written the balance off. You can still sign in, and you're welcome back any time.\n\n${sign}`],
    }[step];
    return { subject: text[0], text: text[1] };
  }

  /**
   * Daily job (cron): moves each past-due subscription along the timeline. Sends the day 7, 25 and 30 emails once
   * each (only the latest step if several fall due together) and on day 90 ends the plan and writes the balance off.
   */
  async function dunning(env, mail) {
    if (!enabled(env)) return { checked: 0, sent: 0, closed: 0 };
    const rows = (await env.DB.prepare('SELECT s.id,s.plan_id AS planId,s.past_due_since AS since,s.dunning_stage AS stage,c.id AS customerId,c.email,c.name FROM subscriptions s JOIN customers c ON c.id=s.customer_id WHERE s.past_due_since IS NOT NULL').all()).results || [];
    let sent = 0, closed = 0;
    for (const row of rows) {
      const days = Math.floor((now() - row.since) / DAY);
      const step = TIMELINE.filter((d) => days >= d && d > row.stage).pop();
      if (!step) continue;
      if (step === 90) {
        try { await stripe(env, 'DELETE', `subscriptions/${row.id}`); } catch (error) { console.error('dunning cancel', row.id, error?.message); }
        for (const invoice of (await stripe(env, 'GET', 'invoices', { subscription: row.id, status: 'open', limit: 20 })).data || [])
          await stripe(env, 'POST', `invoices/${invoice.id}/mark_uncollectible`, {});
        await env.DB.prepare("UPDATE subscriptions SET status='canceled',past_due_since=NULL,dunning_stage=90,updated_at=? WHERE id=?").bind(now(), row.id).run();
        await audit?.recordEvent(env, row.customerId, 'closed_unpaid', row.planId, 'free');
        closed++;
      } else await env.DB.prepare('UPDATE subscriptions SET dunning_stage=? WHERE id=?').bind(step, row.id).run();
      try { await mail(env, { to: [row.email], ...timelineEmail(env, step, row) }, `dunning-${row.id}-${step}`); sent++; }
      catch (error) { console.error('dunning email', row.id, step, error?.message); }
    }
    return { checked: rows.length, sent, closed };
  }

  /**
   * Daily job (cron): one email per annual term, 30 days before it renews, with the date and the price. Monthly plans
   * and plans set to end get none; Stripe's own receipt follows when it renews.
   */
  async function renewalReminders(env) {
    if (!enabled(env)) return { sent: 0 };
    const rows = (await env.DB.prepare("SELECT s.id,s.plan_id AS planId,s.current_period_end AS periodEnd,s.pending_plan_id AS pendingPlanId,s.pending_interval AS pendingInterval,c.email,c.name FROM subscriptions s JOIN customers c ON c.id=s.customer_id WHERE s.billing_interval='year' AND s.status IN ('active','trialing') AND s.cancel_at_period_end=0 AND s.current_period_end BETWEEN ? AND ? AND COALESCE(s.renewal_reminded,0)<>s.current_period_end").bind(now(), now() + 30 * DAY).all()).results || [];
    let sent = 0;
    for (const row of rows) {
      const nextId = row.pendingPlanId || row.planId, nextInterval = row.pendingPlanId ? row.pendingInterval || 'year' : 'year';
      const next = plans.get(nextId)?.name ?? nextId, plan = plans.get(row.planId)?.name ?? row.planId;
      const change = row.pendingPlanId ? `As you asked, it continues as ${next} ${nextInterval === 'year' ? 'annual' : 'monthly'} at ${priceText(nextId, nextInterval)}.` : `It renews for another year at ${yearlyPrice(row.planId)}, plus tax where it applies.`;
      const text = `Hi ${row.name || 'there'},\n\nA reminder that your ${plan} annual plan renews on ${shortDay(row.periodEnd)}. ${change}\n\nNothing to do if that's what you want. To switch plans, move to monthly billing or cancel, use your account page before that date: ${origin(env)}/account.html\n\nVF Tech\nkevinvf@vftech.io`;
      try {
        await mail(env, { to: [row.email], subject: `Your ${plan} plan renews on ${shortDay(row.periodEnd)}`, text }, `renewal-${row.id}-${row.periodEnd}`);
        await env.DB.prepare('UPDATE subscriptions SET renewal_reminded=? WHERE id=?').bind(row.periodEnd, row.id).run();
        sent++;
      } catch (error) { console.error('renewal reminder', row.id, error?.message); }
    }
    return { sent };
  }

  return { enabled, live, enabledFor, status, checkout, portal, webhook, changePlan, requestNet30, dunning, renewalReminders, refreshCard, stripe };
}
