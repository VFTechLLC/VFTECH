// Accounts & Subscriptions spec, phase 3 (2026-11-13): closing an account and downloading its data.
//
// Closing needs the customer to type their email and enter a fresh code sent to it (valid ten minutes).
//  - Paid plan: the plan stops renewing and the account stays open until the paid period ends ("Your account closes on
//    <date>", with Keep my account). Close now ends the plan and the account at once, with no refund.
//  - No paid plan: a 14-day window, or Close now.
// On the closing date the daily job deletes the profile, sessions, challenges and requests from D1, cancels any plan and
// detaches payment methods in Stripe. Invoices stay in Stripe as tax records. A confirmation email goes first.

export const CLOSE_WINDOW_DAYS = 14;
const DAY = 86400;

export function closing({ HTTPError, json, now, hmac, code, equal, send, codeSeconds, stripe, planFor, recordEvent }) {
  const live = "status IN ('active','trialing','past_due','unpaid','incomplete')";

  /** POST /api/account/close/code: emails a six-digit code to the signed-in customer. */
  async function requestCode(env, active) {
    const id = crypto.randomUUID(), value = code(), timestamp = now(), address = active.customer.email;
    await env.DB.prepare('INSERT INTO auth_challenges (id,email,name,code_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)')
      .bind(id, address, 'close-account', await hmac(env, `close:${id}:${address}:${value}`), timestamp + codeSeconds, timestamp).run();
    try {
      await send(env, { to: [address], subject: 'Your code to close your VFTech account', text: `Your code to close your VFTech account is ${value}.\n\nIt expires in ten minutes and can be used once. If you didn't ask to close your account, ignore this email and nothing will change. Never share your code.` }, `close-code-${id}`);
    } catch (error) {
      await env.DB.prepare('DELETE FROM auth_challenges WHERE id=?').bind(id).run();
      throw error;
    }
    return json({ challengeId: id, expiresIn: codeSeconds }, 201);
  }

  async function checkCode(env, address, input) {
    const id = typeof input.challengeId === 'string' ? input.challengeId : '', value = typeof input.code === 'string' ? input.code.trim() : '';
    if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9]{6}$/.test(value)) throw new HTTPError(400, 'Enter the six-digit code from your email.');
    const row = await env.DB.prepare("UPDATE auth_challenges SET attempts=attempts+1 WHERE id=? AND email=? AND name='close-account' AND consumed=0 AND expires_at>? AND attempts<5 RETURNING *").bind(id, address, now()).first();
    if (!row || !equal(row.code_hash, await hmac(env, `close:${id}:${address}:${value}`))) throw new HTTPError(400, 'The code is invalid or expired. Request a new code.');
    const claimed = await env.DB.prepare('UPDATE auth_challenges SET consumed=1 WHERE id=? AND consumed=0').bind(id).run();
    if (claimed.meta.changes !== 1) throw new HTTPError(400, 'This code has already been used. Request a new code.');
  }

  const subscriptionOf = (env, customerId) =>
    env.DB.prepare(`SELECT id,plan_id AS planId,status,current_period_end AS periodEnd FROM subscriptions WHERE customer_id=? AND ${live} ORDER BY updated_at DESC LIMIT 1`).bind(customerId).first();

  /** POST /api/account/close {email, challengeId, code, when: 'period_end' | 'now'} */
  async function close(env, active, input) {
    const address = active.customer.email;
    if (String(input.email || '').trim().toLowerCase() !== address) throw new HTTPError(400, 'Type the email on this account to confirm.');
    await checkCode(env, address, input);
    const customer = await env.DB.prepare('SELECT id,stripe_customer_id AS stripeCustomer,closing_at AS closingAt FROM customers WHERE id=?').bind(active.customer.id).first();
    const sub = await subscriptionOf(env, customer.id);
    const paid = Boolean(sub && ['active', 'trialing', 'past_due', 'unpaid'].includes(sub.status));
    if (input.when === 'now') {
      if (sub) await cancelInStripe(env, sub.id);
      await env.DB.prepare('UPDATE customers SET closing_at=? WHERE id=?').bind(now(), customer.id).run();
      await recordEvent(env, customer.id, 'account_closed_now', sub?.planId || 'free', '');
      await closeAccount(env, customer.id);
      return json({ closed: true }, 200, { 'Set-Cookie': '__Host-vftech-session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
    }
    let closingAt;
    if (paid) {
      const stripeSub = await stripe(env, 'GET', `subscriptions/${sub.id}`);
      if (stripeSub.schedule) await stripe(env, 'POST', `subscription_schedules/${stripeSub.schedule}/release`, {});
      await stripe(env, 'POST', `subscriptions/${sub.id}`, { cancel_at_period_end: 'true', metadata: { closing_account: '1' } });
      await env.DB.prepare('UPDATE subscriptions SET cancel_at_period_end=1,pending_plan_id=NULL,schedule_id=NULL WHERE id=?').bind(sub.id).run();
      closingAt = stripeSub.current_period_end ?? stripeSub.items?.data?.[0]?.current_period_end ?? sub.periodEnd ?? now();
    } else closingAt = now() + CLOSE_WINDOW_DAYS * DAY;
    await env.DB.prepare('UPDATE customers SET closing_at=? WHERE id=?').bind(closingAt, customer.id).run();
    await recordEvent(env, customer.id, 'account_close_scheduled', sub?.planId || 'free', '');
    return json({ closingAt });
  }

  /** POST /api/account/keep: undoes a scheduled close (and resumes the plan if closing had stopped it). */
  async function keep(env, active) {
    const customer = await env.DB.prepare('SELECT id,closing_at AS closingAt FROM customers WHERE id=?').bind(active.customer.id).first();
    if (!customer.closingAt) throw new HTTPError(409, 'Your account isn’t set to close.');
    const sub = await subscriptionOf(env, customer.id);
    if (sub) {
      const stripeSub = await stripe(env, 'GET', `subscriptions/${sub.id}`);
      if (stripeSub.cancel_at_period_end && stripeSub.metadata?.closing_account === '1') {
        await stripe(env, 'POST', `subscriptions/${sub.id}`, { cancel_at_period_end: 'false', metadata: { closing_account: '' } });
        await env.DB.prepare('UPDATE subscriptions SET cancel_at_period_end=0 WHERE id=?').bind(sub.id).run();
      }
    }
    await env.DB.prepare('UPDATE customers SET closing_at=NULL WHERE id=?').bind(customer.id).run();
    await recordEvent(env, customer.id, 'account_close_cancelled', sub?.planId || 'free', sub?.planId || 'free');
    return json({ kept: true });
  }

  async function cancelInStripe(env, subId) {
    // Already cancelled in Stripe is fine: closing goes ahead either way.
    try { await stripe(env, 'DELETE', `subscriptions/${subId}`); } catch (error) { console.error('close: cancel', subId, error?.message); }
  }

  /** Deletes the account: cancels any plan, detaches payment methods, deletes D1 rows. Invoices stay in Stripe. */
  async function closeAccount(env, customerId) {
    const customer = await env.DB.prepare('SELECT id,email,name,stripe_customer_id AS stripeCustomer FROM customers WHERE id=?').bind(customerId).first();
    if (!customer) return false;
    if (customer.stripeCustomer && env.STRIPE_SECRET_KEY) {
      const subs = (await env.DB.prepare(`SELECT id FROM subscriptions WHERE customer_id=? AND ${live}`).bind(customerId).all()).results || [];
      for (const sub of subs) await cancelInStripe(env, sub.id);
      const methods = (await stripe(env, 'GET', `customers/${customer.stripeCustomer}/payment_methods`, { limit: 100 })).data || [];
      for (const method of methods) await stripe(env, 'POST', `payment_methods/${method.id}/detach`, {});
    }
    try {
      await send(env, { to: [customer.email], subject: 'Your VFTech account is closed', text: `Hi ${customer.name || 'there'},\n\nYour VFTech account is now closed. We've deleted your profile, sign-ins and requests. Your invoices stay with our payment provider as tax records, and no further charges will be made.\n\nYou're welcome back any time: signing in with this email again starts a new account.\n\nVF Tech\nkevinvf@vftech.io` }, `closed-${customerId}`);
    } catch (error) { console.error('closing email', customerId, error?.message); }
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE customer_id=?').bind(customerId),
      env.DB.prepare('DELETE FROM auth_challenges WHERE email=?').bind(customer.email),
      env.DB.prepare('DELETE FROM contact_requests WHERE email=?').bind(customer.email),
      env.DB.prepare('DELETE FROM plan_events WHERE customer_id=?').bind(customerId),
      env.DB.prepare('DELETE FROM terms_acceptances WHERE customer_id=?').bind(customerId),
      env.DB.prepare('DELETE FROM subscriptions WHERE customer_id=?').bind(customerId),
      env.DB.prepare('DELETE FROM customers WHERE id=?').bind(customerId),
    ]);
    return true;
  }

  /** Daily job: closes every account whose closing date has passed. */
  async function closeDue(env) {
    const due = (await env.DB.prepare('SELECT id FROM customers WHERE closing_at IS NOT NULL AND closing_at<=?').bind(now()).all()).results || [];
    let closed = 0;
    for (const row of due) { try { if (await closeAccount(env, row.id)) closed++; } catch (error) { console.error('close account', row.id, error?.message); } }
    return { closed };
  }

  /** GET /api/account/export: everything we hold about the customer, as one JSON file. */
  async function exportData(env, active) {
    const id = active.customer.id;
    const profile = await env.DB.prepare('SELECT email,name,business,phone,created_at AS createdAt,closing_at AS closingAt FROM customers WHERE id=?').bind(id).first();
    const all = async (sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results || [];
    const data = {
      exportedAt: new Date(now() * 1000).toISOString(),
      profile,
      plan: await planFor(env, id),
      requests: await all('SELECT id,business,phone,topics,times,message,plan_id AS planId,status,created_at AS createdAt FROM contact_requests WHERE email=? ORDER BY created_at', profile.email),
      planHistory: await all('SELECT type,from_plan AS fromPlan,to_plan AS toPlan,created_at AS at FROM plan_events WHERE customer_id=? ORDER BY created_at', id),
      termsAccepted: await all('SELECT item_id AS item,version,accepted_at AS at FROM terms_acceptances WHERE customer_id=? ORDER BY accepted_at', id),
      invoices: [],
    };
    const stripeCustomer = (await env.DB.prepare('SELECT stripe_customer_id AS s FROM customers WHERE id=?').bind(id).first())?.s;
    if (stripeCustomer && env.STRIPE_SECRET_KEY) {
      data.invoices = ((await stripe(env, 'GET', 'invoices', { customer: stripeCustomer, limit: 100 })).data || [])
        .filter((invoice) => invoice.status !== 'draft')
        .map((invoice) => ({ number: invoice.number, date: invoice.created, total: invoice.total, currency: invoice.currency, status: invoice.status, url: invoice.hosted_invoice_url }));
    }
    return new Response(JSON.stringify(data, null, 2) + '\n', { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="vftech-account-data.json"', 'Cache-Control': 'no-store' } });
  }

  return { requestCode, close, keep, closeAccount, closeDue, exportData };
}
