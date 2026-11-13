// Staff admin view (Accounts & Subscriptions spec, phase 4) at /api/admin, behind Cloudflare Access.
// Two locks: Cloudflare Access on the path (sign-in, with two-factor, before anything reaches the Worker), and this
// module checking Access's signed token itself (issuer, audience, expiry, RS256 signature against the team's keys)
// plus the ADMIN_EMAILS list. Without ACCESS_TEAM_DOMAIN, ACCESS_AUD and ADMIN_EMAILS every admin route answers 503.
// Every change is written to admin_log with the staff email.

const CERTS_SECONDS = 3600, MAX_ENTRY_MINUTES = 24 * 60;
const certs = new Map();

const b64urlBytes = (text) => Uint8Array.from(atob(String(text).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(text).length % 4)) % 4)), (c) => c.charCodeAt(0));
const b64urlJson = (text) => JSON.parse(new TextDecoder().decode(b64urlBytes(text)));

export function admin({ HTTPError, json, now, origin, catalog, send, stripe, planFor, meter, recordEvent }) {
  const plans = new Map(catalog.plans.map((plan) => [plan.id, plan]));
  const planName = (id) => (id === 'free' || !id ? 'Free' : plans.get(id)?.name ?? id);
  const list = (value) => String(value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const team = (env) => String(env.ACCESS_TEAM_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const configured = (env) => Boolean(team(env) && env.ACCESS_AUD && list(env.ADMIN_EMAILS).length);

  async function keysFor(env, refresh = false) {
    const host = team(env), cached = certs.get(host);
    if (cached && !refresh && now() - cached.at < CERTS_SECONDS) return cached.keys;
    const response = await fetch(`https://${host}/cdn-cgi/access/certs`);
    if (!response.ok) throw new HTTPError(503, 'Cloudflare Access could not be reached. Try again.');
    const keys = (await response.json()).keys || [];
    certs.set(host, { at: now(), keys });
    return keys;
  }
  /** The signed-in staff member, from Cloudflare Access's token. */
  async function staff(request, env) {
    if (!configured(env)) throw new HTTPError(503, 'The admin view is not set up yet.');
    const cookie = (request.headers.get('Cookie') || '').split(';').map((x) => x.trim()).find((x) => x.startsWith('CF_Authorization='))?.slice(17);
    const token = request.headers.get('Cf-Access-Jwt-Assertion') || cookie;
    if (!token) throw new HTTPError(401, 'Sign in through Cloudflare Access.');
    const [h, p, s] = token.split('.');
    let header, payload;
    try { header = b64urlJson(h); payload = b64urlJson(p); } catch { throw new HTTPError(401, 'Sign in through Cloudflare Access.'); }
    if (header.alg !== 'RS256' || !s) throw new HTTPError(401, 'Sign in through Cloudflare Access.');
    let jwk = (await keysFor(env)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await keysFor(env, true)).find((k) => k.kid === header.kid);
    if (!jwk) throw new HTTPError(401, 'Sign in through Cloudflare Access.');
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const t = now();
    if (!valid || payload.iss !== `https://${team(env)}` || !audiences.includes(env.ACCESS_AUD) || !(payload.exp > t) || (payload.nbf && payload.nbf > t + 60)) throw new HTTPError(401, 'Sign in through Cloudflare Access.');
    const email = String(payload.email || '').toLowerCase();
    if (!list(env.ADMIN_EMAILS).includes(email)) throw new HTTPError(403, 'This account is not on the staff list.');
    return { email };
  }

  const log = (env, actor, action, customerId, detail = '') =>
    env.DB.prepare('INSERT INTO admin_log (id,actor,action,customer_id,detail,created_at) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(), actor.email, action, customerId || null, String(detail).slice(0, 500), now()).run();
  const text = (value, label, max, required = false) => {
    const v = typeof value === 'string' ? value.trim() : '';
    if (required && !v) throw new HTTPError(400, `Enter ${label}.`);
    if (v.length > max || /[\r\n<>]/.test(v)) throw new HTTPError(400, `Check ${label}.`);
    return v;
  };
  async function customer(env, id) {
    const row = typeof id === 'string' && (await env.DB.prepare('SELECT id,email,name,business,phone,portal_url AS portalUrl,stripe_customer_id AS stripeCustomer,suspended_at AS suspendedAt,suspended_reason AS suspendedReason,totp_enabled_at AS twoFactorSince,net30_requested_at AS net30RequestedAt,closing_at AS closingAt,hours_warned AS hoursWarned,created_at AS createdAt FROM customers WHERE id=?').bind(id).first());
    if (!row) throw new HTTPError(404, 'No such customer.');
    return row;
  }
  const endSessions = (env, id) => env.DB.prepare('DELETE FROM sessions WHERE customer_id=?').bind(id).run();
  async function mailCustomer(env, row, subject, body, key) {
    try { await send(env, { to: [row.email], subject, text: `Hi ${row.name || 'there'},\n\n${body}\n\nVF Tech\nkevinvf@vftech.io` }, key); }
    catch (error) { console.error('admin email', key, error?.message); }
  }

  /** GET /api/admin/customers?q=: everyone, newest first, with plan, standing, hours and flags; plus totals. */
  async function customers(env, url) {
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 100);
    const rows = (await env.DB.prepare(`SELECT id,email,name,business,suspended_at AS suspendedAt,totp_enabled_at AS twoFactorSince,net30_requested_at AS net30RequestedAt,closing_at AS closingAt,created_at AS createdAt FROM customers ${q ? "WHERE lower(email) LIKE ?1 OR lower(name) LIKE ?1 OR lower(business) LIKE ?1" : ''} ORDER BY created_at DESC LIMIT 500`).bind(...(q ? [`%${q}%`] : [])).all()).results || [];
    const out = [];
    for (const row of rows) {
      const plan = await planFor(env, row.id), m = await meter(env, row.id, plan);
      const sub = await env.DB.prepare("SELECT collection_method AS collection FROM subscriptions WHERE customer_id=? AND status IN ('active','trialing','past_due','unpaid','incomplete') ORDER BY updated_at DESC LIMIT 1").bind(row.id).first();
      out.push({ ...row, planId: plan.planId || 'free', planName: plan.planId ? planName(plan.planId) : 'Free', interval: plan.interval || null, status: plan.status, standing: plan.standing, reason: plan.reason || null, periodEnd: plan.periodEnd || null, hoursUsed: m.used, hoursIncluded: m.included, invoiceBilling: sub?.collection === 'send_invoice' });
    }
    const totals = { customers: out.length, byPlan: {}, locked: out.filter((c) => c.standing !== 'ok').length, openRecovery: (await env.DB.prepare("SELECT COUNT(*) AS n FROM recovery_requests WHERE status='open'").first())?.n ?? 0, net30Waiting: out.filter((c) => c.net30RequestedAt && !c.invoiceBilling).length };
    for (const c of out) totals.byPlan[c.planName] = (totals.byPlan[c.planName] || 0) + 1;
    return json({ customers: out, totals });
  }
  /** GET /api/admin/customer?id=: one customer with this period's hours, plan history and the staff log. */
  async function detail(env, url) {
    const row = await customer(env, url.searchParams.get('id'));
    const plan = await planFor(env, row.id), m = await meter(env, row.id, plan);
    const events = (await env.DB.prepare('SELECT type,from_plan AS fromPlan,to_plan AS toPlan,reason,created_at AS at FROM plan_events WHERE customer_id=? ORDER BY created_at DESC LIMIT 50').bind(row.id).all()).results || [];
    const staffLog = (await env.DB.prepare('SELECT actor,action,detail,created_at AS at FROM admin_log WHERE customer_id=? ORDER BY created_at DESC LIMIT 50').bind(row.id).all()).results || [];
    const recovery = (await env.DB.prepare('SELECT id,new_email AS newEmail,status,created_at AS at FROM recovery_requests WHERE old_email=? ORDER BY created_at DESC LIMIT 10').bind(row.email).all()).results || [];
    const sessions = (await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE customer_id=? AND expires_at>?').bind(row.id, now()).first())?.n ?? 0;
    const { hoursWarned, ...profile } = row;
    return json({ customer: profile, plan: { ...plan, planName: plan.planId ? planName(plan.planId) : 'Free' }, hours: m, events, staffLog, recovery, sessions });
  }

  /** POST /api/admin/hours {customerId, date, hours, note}: logs work; emails the customer once at 80% of the month. */
  async function addHours(env, actor, input) {
    const row = await customer(env, input.customerId);
    const date = text(input.date, 'the date', 10, true);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z'))) throw new HTTPError(400, 'Check the date.');
    const minutes = Math.round(Number(input.hours) * 60);
    if (!(minutes > 0 && minutes <= MAX_ENTRY_MINUTES)) throw new HTTPError(400, 'Hours must be more than 0 and at most 24.');
    const note = text(input.note, 'the note', 300);
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO time_entries (id,customer_id,work_date,minutes,note,created_by,created_at) VALUES (?,?,?,?,?,?,?)').bind(id, row.id, date, minutes, note, actor.email, now()).run();
    await log(env, actor, 'hours_added', row.id, `${date} ${minutes / 60}h ${note}`);
    const m = await meter(env, row.id);
    const mark = `${m.periodStart}:80`;
    if (m.warn && row.hoursWarned !== mark) {
      await env.DB.prepare('UPDATE customers SET hours_warned=? WHERE id=?').bind(mark, row.id).run();
      const resets = new Date(m.periodEnd * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
      await mailCustomer(env, row, m.over ? 'You’ve used this month’s plan hours' : 'You’ve used 80% of this month’s plan hours',
        `So far this month we've spent ${m.used} of the ${m.included} hour${m.included === 1 ? '' : 's'} your plan includes. Your hours reset on ${resets}.\n\nExtra work is $${m.extraRate} an hour, and we always quote it before we start, so nothing extra is charged without your OK. See the details on your account page: ${origin(env)}/account.html`,
        `hours-${row.id}-${mark}`);
    }
    return json({ id, hours: m }, 201);
  }
  /** POST /api/admin/hours/delete {id} */
  async function deleteHours(env, actor, input) {
    const entry = typeof input.id === 'string' && (await env.DB.prepare('SELECT id,customer_id AS customerId,work_date AS date,minutes,note FROM time_entries WHERE id=?').bind(input.id).first());
    if (!entry) throw new HTTPError(404, 'No such entry.');
    await env.DB.prepare('DELETE FROM time_entries WHERE id=?').bind(entry.id).run();
    await log(env, actor, 'hours_deleted', entry.customerId, `${entry.date} ${entry.minutes / 60}h ${entry.note}`);
    return json({ deleted: true, hours: await meter(env, entry.customerId) });
  }
  /** POST /api/admin/suspend {customerId, reason} and /api/admin/reactivate {customerId} */
  async function suspend(env, actor, input) {
    const row = await customer(env, input.customerId), reason = text(input.reason, 'the reason', 300, true);
    await env.DB.prepare('UPDATE customers SET suspended_at=?,suspended_reason=? WHERE id=?').bind(now(), reason, row.id).run();
    await recordEvent(env, row.id, 'suspended_by_staff', '', '');
    await log(env, actor, 'suspended', row.id, reason);
    return json({ suspended: true });
  }
  async function reactivate(env, actor, input) {
    const row = await customer(env, input.customerId);
    await env.DB.prepare("UPDATE customers SET suspended_at=NULL,suspended_reason='' WHERE id=?").bind(row.id).run();
    await recordEvent(env, row.id, 'reactivated_by_staff', '', '');
    await log(env, actor, 'reactivated', row.id);
    return json({ suspended: false });
  }
  /** POST /api/admin/portal-url {customerId, url}: the customer's project portal link ('' removes it). */
  async function portalUrl(env, actor, input) {
    const row = await customer(env, input.customerId), value = text(input.url, 'the portal link', 500);
    if (value) { let u; try { u = new URL(value); } catch { throw new HTTPError(400, 'Use a full https:// link.'); } if (u.protocol !== 'https:') throw new HTTPError(400, 'Use a full https:// link.'); }
    await env.DB.prepare('UPDATE customers SET portal_url=? WHERE id=?').bind(value, row.id).run();
    await log(env, actor, 'portal_url', row.id, value || '(removed)');
    return json({ portalUrl: value });
  }
  /** POST /api/admin/reset-2fa {customerId}: lost device and no recovery codes, after checking who they are. */
  async function resetTwoFactor(env, actor, input) {
    const row = await customer(env, input.customerId);
    await env.DB.batch([
      env.DB.prepare('UPDATE customers SET totp_secret=NULL,totp_pending=NULL,totp_pending_at=NULL,totp_enabled_at=NULL,totp_last_step=0 WHERE id=?').bind(row.id),
      env.DB.prepare('DELETE FROM recovery_codes WHERE customer_id=?').bind(row.id),
      env.DB.prepare('DELETE FROM sessions WHERE customer_id=?').bind(row.id),
    ]);
    await log(env, actor, 'two_factor_reset', row.id);
    await mailCustomer(env, row, 'Two-factor sign-in was turned off by our team', 'As you asked, we turned off two-factor sign-in for your VFTech account and signed out every device. Sign in with your email, then turn two-factor on again from your account page with your new phone.', `2fa-reset-${row.id}-${now()}`);
    return json({ reset: true });
  }
  /** POST /api/admin/end-sessions {customerId} */
  async function endAll(env, actor, input) {
    const row = await customer(env, input.customerId);
    await endSessions(env, row.id);
    await log(env, actor, 'sessions_ended', row.id);
    return json({ ended: true });
  }
  /** POST /api/admin/change-email {customerId, email, requestId?}: account recovery; ends every sign-in, updates Stripe. */
  async function changeEmail(env, actor, input) {
    const row = await customer(env, input.customerId);
    const address = text(input.email, 'the new email', 254, true).toLowerCase();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) throw new HTTPError(400, 'Check the new email.');
    if (await env.DB.prepare('SELECT 1 FROM customers WHERE email=?').bind(address).first()) throw new HTTPError(409, 'Another account already uses that email.');
    await env.DB.prepare('UPDATE customers SET email=? WHERE id=?').bind(address, row.id).run();
    await endSessions(env, row.id);
    if (row.stripeCustomer && env.STRIPE_SECRET_KEY) { try { await stripe(env, 'POST', `customers/${row.stripeCustomer}`, { email: address }); } catch (error) { console.error('stripe email', error?.message); } }
    if (typeof input.requestId === 'string' && input.requestId) await env.DB.prepare("UPDATE recovery_requests SET status='done',handled_by=?,handled_at=? WHERE id=?").bind(actor.email, now(), input.requestId).run();
    await log(env, actor, 'email_changed', row.id, `${row.email} -> ${address}`);
    await mailCustomer(env, { ...row, email: address }, 'Your VFTech sign-in email changed', `As you asked, your VFTech account now signs in with ${address}. Every device was signed out. If you didn't ask for this, reply straight away.`, `email-changed-${row.id}-${now()}`);
    return json({ email: address });
  }
  /** GET /api/admin/recovery: open "Can't sign in?" requests, with the account they point to. */
  async function recovery(env) {
    const rows = (await env.DB.prepare("SELECT r.id,r.old_email AS oldEmail,r.new_email AS newEmail,r.name,r.invoice,r.card_last4 AS cardLast4,r.phone,r.message,r.status,r.created_at AS at,c.id AS customerId,c.phone AS phoneOnFile FROM recovery_requests r LEFT JOIN customers c ON c.email=r.old_email WHERE r.status='open' ORDER BY r.created_at DESC LIMIT 100").all()).results || [];
    return json({ requests: rows });
  }
  /** POST /api/admin/recovery/close {id, note} */
  async function closeRecovery(env, actor, input) {
    const row = typeof input.id === 'string' && (await env.DB.prepare('SELECT id,old_email AS oldEmail FROM recovery_requests WHERE id=?').bind(input.id).first());
    if (!row) throw new HTTPError(404, 'No such request.');
    await env.DB.prepare("UPDATE recovery_requests SET status='closed',handled_by=?,handled_at=? WHERE id=?").bind(actor.email, now(), row.id).run();
    await log(env, actor, 'recovery_closed', null, `${row.oldEmail} ${text(input.note, 'the note', 300)}`);
    return json({ closed: true });
  }
  /** GET /api/admin/log */
  async function staffLog(env) {
    return json({ log: (await env.DB.prepare('SELECT l.actor,l.action,l.detail,l.created_at AS at,c.email FROM admin_log l LEFT JOIN customers c ON c.id=l.customer_id ORDER BY l.created_at DESC LIMIT 200').all()).results || [] });
  }

  const PAGE_HEADERS = { 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };
  const reads = { '/api/admin/customers': customers, '/api/admin/customer': detail, '/api/admin/recovery': recovery, '/api/admin/log': staffLog };
  const writes = { '/api/admin/hours': addHours, '/api/admin/hours/delete': deleteHours, '/api/admin/suspend': suspend, '/api/admin/reactivate': reactivate, '/api/admin/portal-url': portalUrl, '/api/admin/reset-2fa': resetTwoFactor, '/api/admin/end-sessions': endAll, '/api/admin/change-email': changeEmail, '/api/admin/recovery/close': closeRecovery };

  /** Handles /api/admin and everything under it; null for other paths. */
  async function handle(request, env, url, readBody) {
    if (url.pathname !== '/api/admin' && !url.pathname.startsWith('/api/admin/')) return null;
    const actor = await staff(request, env);
    if (request.method === 'GET' && (url.pathname === '/api/admin' || url.pathname === '/api/admin/')) return new Response(ADMIN_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...PAGE_HEADERS } });
    if (request.method === 'GET' && url.pathname === '/api/admin/app.js') return new Response(ADMIN_SCRIPT, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', ...PAGE_HEADERS } });
    if (request.method === 'GET' && url.pathname === '/api/admin/app.css') return new Response(ADMIN_STYLE, { headers: { 'Content-Type': 'text/css; charset=utf-8', ...PAGE_HEADERS } });
    if (request.method === 'GET' && reads[url.pathname]) return await reads[url.pathname](env, url);
    if (request.method === 'POST' && writes[url.pathname]) return await writes[url.pathname](env, actor, await readBody());
    throw new HTTPError(404, 'Not found.');
  }
  return { handle, staff, configured };
}

const ADMIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>VFTech admin</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/api/admin/app.css"></head>
<body><header><strong>VFTech admin</strong><nav><button type="button" data-tab="customers" aria-pressed="true">Customers</button><button type="button" data-tab="recovery" aria-pressed="false">Recovery requests</button><button type="button" data-tab="log" aria-pressed="false">Staff log</button></nav></header>
<main><p id="status" role="status"></p>
<section id="tab-customers"><div id="totals"></div><form id="search"><input id="q" type="search" placeholder="Search name, email or business" aria-label="Search customers"><button type="submit">Search</button></form><div class="scroll"><table id="customers"><thead><tr><th>Customer</th><th>Plan</th><th>Standing</th><th>Hours this month</th><th>Flags</th></tr></thead><tbody></tbody></table></div><section id="detail" hidden></section></section>
<section id="tab-recovery" hidden><div id="recovery"></div></section>
<section id="tab-log" hidden><div class="scroll"><table id="log"><thead><tr><th>When</th><th>Staff</th><th>Action</th><th>Customer</th><th>Detail</th></tr></thead><tbody></tbody></table></div></section>
</main><script src="/api/admin/app.js"></script></body></html>`;

const ADMIN_STYLE = `:root{color-scheme:light dark;--ink:#172239;--paper:#f6f7f9;--sheet:#fff;--rule:#d5dae3;--accent:#183ccc;--warn:#9a5b00;--bad:#b42318}
@media(prefers-color-scheme:dark){:root{--ink:#e7eaf0;--paper:#0f141b;--sheet:#161d27;--rule:#2b3544;--accent:#7f9cff;--warn:#f5b54a;--bad:#ff8a80}}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;font:15px/1.5 system-ui,sans-serif;color:var(--ink);background:var(--paper)}header{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;padding:14px 20px;border-bottom:1px solid var(--rule);background:var(--sheet)}
nav{display:flex;gap:6px;flex-wrap:wrap}button,input,select,textarea{font:inherit;color:inherit}button{border:1px solid var(--rule);background:var(--sheet);border-radius:6px;padding:6px 12px;cursor:pointer}button[aria-pressed=true],button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{border-color:var(--bad);color:var(--bad)}button:disabled{opacity:.6}
main{padding:16px 20px 60px;max-width:1200px;margin:auto}input,select,textarea{border:1px solid var(--rule);border-radius:6px;padding:6px 8px;background:var(--sheet);min-width:0}#search{display:flex;gap:8px;margin:12px 0}#q{flex:1;max-width:420px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;background:var(--sheet);font-size:14px}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--rule);vertical-align:top}tbody tr[data-id]{cursor:pointer}tbody tr[data-id]:hover{background:rgba(127,156,255,.08)}
.small{font-size:13px;opacity:.8}.chip{display:inline-block;font-size:12px;border:1px solid var(--rule);border-radius:4px;padding:0 6px;margin:0 4px 4px 0}.warn{color:var(--warn)}.bad{color:var(--bad)}
#totals{display:flex;flex-wrap:wrap;gap:8px}#totals span{background:var(--sheet);border:1px solid var(--rule);border-radius:8px;padding:6px 10px;font-size:13px}
#detail{margin-top:18px;background:var(--sheet);border:1px solid var(--rule);border-radius:10px;padding:16px;display:grid;gap:16px}#detail h2,#detail h3{margin:0}#detail form{display:flex;flex-wrap:wrap;gap:8px;align-items:end}#detail label{display:grid;gap:2px;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}.box{border:1px solid var(--rule);border-radius:8px;padding:12px;display:grid;gap:8px;align-content:start}ul{margin:0;padding-left:18px}
.bar{height:8px;border-radius:4px;background:var(--rule);overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}.bar.warn i{background:var(--warn)}.bar.bad i{background:var(--bad)}
.card{background:var(--sheet);border:1px solid var(--rule);border-radius:10px;padding:14px;margin:0 0 12px;display:grid;gap:6px}#status{min-height:1.5em;margin:0 0 6px}`;

const ADMIN_SCRIPT = `(function(){'use strict';
var statusLine=document.getElementById('status');
function el(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=String(text);return n;}
function day(s){return s?new Date(s*1000).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'—';}
function when(s){return s?new Date(s*1000).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'—';}
async function api(path,data){var r=await fetch('/api/admin/'+path,{method:data?'POST':'GET',credentials:'same-origin',headers:data?{'Content-Type':'application/json','Accept':'application/json'}:{'Accept':'application/json'},body:data?JSON.stringify(data):undefined});var j;try{j=await r.json();}catch(e){throw Error('The service could not respond.');}if(!r.ok)throw Error(j.error||'That did not work.');return j;}
function say(t){statusLine.textContent=t;}
var standingText={ok:'OK',past_due:'Past due',payment_required:'Payment required',suspended:'Suspended'};
document.querySelectorAll('[data-tab]').forEach(function(b){b.addEventListener('click',function(){document.querySelectorAll('[data-tab]').forEach(function(x){x.setAttribute('aria-pressed',String(x===b));document.getElementById('tab-'+x.dataset.tab).hidden=x!==b;});if(b.dataset.tab==='recovery')loadRecovery();if(b.dataset.tab==='log')loadLog();});});
function meterBar(h){var pct=h.included?Math.min(100,Math.round(h.used/h.included*100)):0,bar=el('div','bar'+(h.over?' bad':h.warn?' warn':''));var fill=el('i');fill.style.width=pct+'%';bar.append(fill);return bar;}
async function loadCustomers(quiet){
  if(!quiet)say('Loading customers…');
  try{var q=document.getElementById('q').value.trim(),d=await api('customers'+(q?'?q='+encodeURIComponent(q):''));
    var totals=document.getElementById('totals');totals.textContent='';
    totals.append(el('span','',d.totals.customers+' customers'));Object.keys(d.totals.byPlan).forEach(function(k){totals.append(el('span','',k+': '+d.totals.byPlan[k]));});
    totals.append(el('span',d.totals.locked?'warn':'',d.totals.locked+' not in good standing'),el('span',d.totals.openRecovery?'warn':'',d.totals.openRecovery+' open recovery'),el('span',d.totals.net30Waiting?'warn':'',d.totals.net30Waiting+' net-30 waiting'));
    var body=document.querySelector('#customers tbody');body.textContent='';
    if(!d.customers.length){var tr=el('tr');var td=el('td','small','No customers found.');td.colSpan=5;tr.append(td);body.append(tr);}
    d.customers.forEach(function(c){var tr=el('tr');tr.dataset.id=c.id;tr.tabIndex=0;
      var who=el('td');who.append(el('strong','',c.name||'(no name)'),el('div','small',c.email+(c.business?' · '+c.business:'')));
      var plan=el('td','',c.planName+(c.interval==='year'?' (annual)':'')+(c.periodEnd?'':''));if(c.periodEnd)plan.append(el('div','small','renews '+day(c.periodEnd)));
      var st=el('td',c.standing==='ok'?'':'bad',standingText[c.standing]||c.standing);if(c.reason)st.append(el('div','small',c.reason==='staff'?'on hold by staff':c.reason.replace(/_/g,' ')));
      var hours=el('td');if(c.hoursIncluded){hours.append(el('div','',c.hoursUsed+' / '+c.hoursIncluded+' h'),meterBar({used:c.hoursUsed,included:c.hoursIncluded,warn:c.hoursUsed>=c.hoursIncluded*.8,over:c.hoursUsed>c.hoursIncluded}));}else hours.append(el('span','small',c.hoursUsed?c.hoursUsed+' h (no plan hours)':'—'));
      var flags=el('td');if(c.twoFactorSince)flags.append(el('span','chip','2FA'));if(c.invoiceBilling)flags.append(el('span','chip','Invoice billing'));else if(c.net30RequestedAt)flags.append(el('span','chip warn','Net-30 asked'));if(c.suspendedAt)flags.append(el('span','chip bad','Held by staff'));if(c.closingAt)flags.append(el('span','chip warn','Closing '+day(c.closingAt)));
      tr.append(who,plan,st,hours,flags);function open(){showCustomer(c.id);}tr.addEventListener('click',open);tr.addEventListener('keydown',function(e){if(e.key==='Enter')open();});body.append(tr);});
    if(!quiet)say('');}catch(e){say(e.message);}
}
function action(label,cls,run){var b=el('button',cls||'',label);b.type='button';b.addEventListener('click',async function(){b.disabled=true;try{var msg=await run();if(msg)say(msg);}catch(e){say(e.message);}finally{b.disabled=false;}});return b;}
async function showCustomer(id){
  var box=document.getElementById('detail');box.hidden=false;box.textContent='Loading…';
  try{var d=await api('customer?id='+encodeURIComponent(id)),c=d.customer,p=d.plan,h=d.hours;box.textContent='';
    var head=el('div');head.append(el('h2','',c.name||c.email),el('div','small',c.email+(c.business?' · '+c.business:'')+(c.phone?' · '+c.phone:'')+' · customer since '+day(c.createdAt)));box.append(head);
    var grid=el('div','grid');box.append(grid);
    var planBox=el('div','box');planBox.append(el('h3','','Plan'),el('div','',p.planName+(p.interval==='year'?' (annual)':'')+' · '+(standingText[p.standing]||p.standing)+(p.reason?' ('+(p.reason==='staff'?'on hold by staff':p.reason.replace(/_/g,' '))+')':'')));
    if(p.periodEnd)planBox.append(el('div','small',(p.cancelAtPeriodEnd?'Ends ':'Renews ')+day(p.periodEnd)+(p.pendingPlanName?' · switching to '+p.pendingPlanName:'')));
    if(c.net30RequestedAt)planBox.append(el('div','small warn','Asked for net-30 invoices on '+day(c.net30RequestedAt)+'. Approve in Stripe (subscription > payment > email invoice, 30 days).'));
    planBox.append(el('div','small',(c.twoFactorSince?'Two-factor on since '+day(c.twoFactorSince):'Two-factor off')+' · '+d.sessions+' active sign-in'+(d.sessions===1?'':'s')));
    if(c.stripeCustomer){var s=el('a','small','Open in Stripe');s.href='https://dashboard.stripe.com/customers/'+encodeURIComponent(c.stripeCustomer);s.target='_blank';s.rel='noopener';planBox.append(s);}
    grid.append(planBox);
    var hoursBox=el('div','box');hoursBox.append(el('h3','','Hours, '+day(h.periodStart)+' to '+day(h.periodEnd-86400)),el('div','',h.used+' of '+h.included+' included hours used'+(h.over?' (over: extra work is $'+h.extraRate+'/h, quoted first)':h.warn?' (80% or more)':'')),meterBar(h));
    var add=el('form');var date=el('input');date.type='date';date.required=true;date.value=new Date().toISOString().slice(0,10);var hrs=el('input');hrs.type='number';hrs.step='0.25';hrs.min='0.25';hrs.max='24';hrs.required=true;hrs.placeholder='1.5';hrs.style.width='80px';var note=el('input');note.maxLength=300;note.placeholder='What was done';
    var l1=el('label','','Date');l1.append(date);var l2=el('label','','Hours');l2.append(hrs);var l3=el('label','','Note');l3.append(note);var go=el('button','primary','Log hours');go.type='submit';add.append(l1,l2,l3,go);
    add.addEventListener('submit',async function(e){e.preventDefault();go.disabled=true;try{await api('hours',{customerId:c.id,date:date.value,hours:Number(hrs.value),note:note.value});say('Hours logged.');showCustomer(c.id);loadCustomers(true);}catch(err){say(err.message);go.disabled=false;}});
    hoursBox.append(add);
    if(h.entries.length){var ul=el('ul');h.entries.forEach(function(e){var li=el('li');li.append(document.createTextNode(e.date+' · '+e.hours+' h'+(e.note?' · '+e.note:'')+' '),action('Delete','danger',async function(){if(!confirm('Delete this entry?'))return;await api('hours/delete',{id:e.id});showCustomer(c.id);loadCustomers(true);return 'Entry deleted.';}));ul.append(li);});hoursBox.append(ul);}else hoursBox.append(el('div','small','No hours logged this month.'));
    grid.append(hoursBox);
    var acts=el('div','box');acts.append(el('h3','','Actions'));
    if(c.suspendedAt){acts.append(el('div','small bad','Held since '+day(c.suspendedAt)+': '+c.suspendedReason),action('Reactivate','primary',async function(){await api('reactivate',{customerId:c.id});showCustomer(c.id);loadCustomers(true);return 'Reactivated.';}));}
    else{var sf=el('form');var why=el('input');why.required=true;why.maxLength=300;why.placeholder='Reason (staff only)';var sl=el('label','','Suspend: features off, customer asked to contact us');sl.append(why);var sb=el('button','danger','Suspend');sb.type='submit';sf.append(sl,sb);sf.addEventListener('submit',async function(e){e.preventDefault();if(!confirm('Suspend '+c.email+'?'))return;try{await api('suspend',{customerId:c.id,reason:why.value});say('Suspended.');showCustomer(c.id);loadCustomers(true);}catch(err){say(err.message);}});acts.append(sf);}
    var pf=el('form');var purl=el('input');purl.type='url';purl.value=c.portalUrl||'';purl.placeholder='https://…';var pl=el('label','','Project portal link');pl.append(purl);var pb=el('button','','Save link');pb.type='submit';pf.append(pl,pb);pf.addEventListener('submit',async function(e){e.preventDefault();try{await api('portal-url',{customerId:c.id,url:purl.value.trim()});say('Portal link saved.');}catch(err){say(err.message);}});acts.append(pf);
    var ef=el('form');var mail=el('input');mail.type='email';mail.required=true;mail.placeholder='new@example.com';var elab=el('label','','Change sign-in email (recovery, after checking who they are)');elab.append(mail);var eb=el('button','','Change email');eb.type='submit';ef.append(elab,eb);ef.addEventListener('submit',async function(e){e.preventDefault();if(!confirm('Change '+c.email+' to '+mail.value+' and sign out every device?'))return;try{await api('change-email',{customerId:c.id,email:mail.value,requestId:(d.recovery.find(function(r){return r.status==='open';})||{}).id});say('Email changed.');showCustomer(c.id);loadCustomers(true);}catch(err){say(err.message);}});acts.append(ef);
    var row=el('div');row.style.display='flex';row.style.flexWrap='wrap';row.style.gap='8px';
    if(c.twoFactorSince)row.append(action('Reset two-factor','danger',async function(){if(!confirm('Turn off two-factor for '+c.email+' and sign out every device? Only after checking who they are.'))return;await api('reset-2fa',{customerId:c.id});showCustomer(c.id);loadCustomers(true);return 'Two-factor reset.';}));
    row.append(action('Sign out every device','',async function(){if(!confirm('Sign out every device for '+c.email+'?'))return;await api('end-sessions',{customerId:c.id});showCustomer(c.id);return 'Signed out everywhere.';}));
    acts.append(row);grid.append(acts);
    var hist=el('div','box');hist.append(el('h3','','Plan history'));if(d.events.length){var hl=el('ul');d.events.forEach(function(e){hl.append(el('li','',day(e.at)+' · '+e.type.replace(/_/g,' ')+(e.fromPlan||e.toPlan?' · '+(e.fromPlan||'—')+' → '+(e.toPlan||'—'):'')+(e.reason?' · '+e.reason:'')));});hist.append(hl);}else hist.append(el('div','small','Nothing yet.'));grid.append(hist);
    var lg=el('div','box');lg.append(el('h3','','Staff log'));if(d.staffLog.length){var ll=el('ul');d.staffLog.forEach(function(e){ll.append(el('li','',when(e.at)+' · '+e.actor+' · '+e.action.replace(/_/g,' ')+(e.detail?' · '+e.detail:'')));});lg.append(ll);}else lg.append(el('div','small','No staff actions yet.'));grid.append(lg);
    box.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){box.textContent=e.message;}
}
async function loadRecovery(){var box=document.getElementById('recovery');box.textContent='Loading…';
  try{var d=await api('recovery');box.textContent='';if(!d.requests.length){box.append(el('p','small','No open requests.'));return;}
    d.requests.forEach(function(r){var card=el('div','card');card.append(el('strong','',r.oldEmail+' → '+r.newEmail),el('div','small','Sent '+when(r.at)+(r.name?' · '+r.name:'')),el('div','','Invoice: '+(r.invoice||'—')+' · card last four: '+(r.cardLast4||'—')+' · phone: '+(r.phone||'—')+(r.customerId?' (on file: '+(r.phoneOnFile||'—')+')':'')),el('div','small',r.message||''),el('div',r.customerId?'small':'small warn',r.customerId?'Account found. Check a detail against Stripe or the profile, then change the email from the customer page.':'No account with the old email.'));
      var row=el('div');row.style.display='flex';row.style.gap='8px';row.style.flexWrap='wrap';
      if(r.customerId)row.append(action('Open customer','primary',async function(){document.querySelector('[data-tab=customers]').click();await showCustomer(r.customerId);}));
      row.append(action('Close without changes','',async function(){var note=prompt('Note for the log (why it was closed)')||'';await api('recovery/close',{id:r.id,note:note});loadRecovery();return 'Request closed.';}));
      card.append(row);box.append(card);});
  }catch(e){box.textContent=e.message;}}
async function loadLog(){var body=document.querySelector('#log tbody');body.textContent='';try{var d=await api('log');d.log.forEach(function(e){var tr=el('tr');[when(e.at),e.actor,e.action.replace(/_/g,' '),e.email||'—',e.detail].forEach(function(v){tr.append(el('td','',v));});body.append(tr);});}catch(e){say(e.message);}}
document.getElementById('search').addEventListener('submit',function(e){e.preventDefault();loadCustomers();});
loadCustomers();
})();`;
