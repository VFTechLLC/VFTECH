// Optional two-factor sign-in (Accounts & Subscriptions spec, phase 4): a time-based code (TOTP, RFC 6238: SHA-1,
// six digits, 30 seconds, as every authenticator app expects) asked after any sign-in method. Never required for
// customers. The secret is stored encrypted (AES-GCM) with the TOTP_KEY Worker secret; ten single-use recovery codes
// are stored only as HMACs. Turning it off, or making new recovery codes, needs a fresh code. Staff always use
// two-factor through Cloudflare Access on the admin view (phase 4d). Passkeys come later.
import qrcode from 'qrcode-generator';

const STEP = 30, DIGITS = 6, WINDOW = 1, SETUP_SECONDS = 15 * 60, RECOVERY_COUNT = 10;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const encoder = new TextEncoder();

export function base32(bytes) {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}
export function unbase32(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, ''), out = [];
  let bits = 0, value = 0;
  for (const c of clean) { value = (value << 5) | BASE32.indexOf(c); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return new Uint8Array(out);
}
/** The code for one 30-second step (RFC 4226 dynamic truncation). */
export async function totp(secret, step) {
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setUint32(4, step >>> 0);
  new DataView(counter.buffer).setUint32(0, Math.floor(step / 2 ** 32));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
  const offset = mac[mac.length - 1] & 15;
  const number = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(number % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function twoFactor({ HTTPError, json, now, hmac, digest, equal, send, limit, origin }) {
  const ready = (env) => /^[A-Za-z0-9+/=_-]{40,}$/.test(String(env.TOTP_KEY || ''));
  const need = (env) => { if (!ready(env)) throw new HTTPError(503, 'Two-factor sign-in is not switched on yet.'); };

  async function aesKey(env) {
    const raw = Uint8Array.from(atob(String(env.TOTP_KEY).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    if (raw.length < 32) throw new HTTPError(503, 'Two-factor sign-in is not switched on yet.');
    return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
  const b64 = (bytes) => btoa(String.fromCharCode(...bytes));
  const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  /** "v1.<iv>.<ciphertext>", bound to the customer so a secret can't be moved to another account. */
  async function seal(env, customerId, secret) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(customerId) }, await aesKey(env), secret));
    return `v1.${b64(iv)}.${b64(data)}`;
  }
  async function open(env, customerId, sealed) {
    const [version, iv, data] = String(sealed || '').split('.');
    if (version !== 'v1' || !iv || !data) return null;
    try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: encoder.encode(customerId) }, await aesKey(env), unb64(data))); }
    catch { return null; }
  }

  /** The step a code matches within ±1 step, or null. */
  async function matchStep(secret, code, after = 0) {
    const current = Math.floor(now() / STEP);
    for (let step = current - WINDOW; step <= current + WINDOW; step++) if (step > after && equal(await totp(secret, step), code)) return step;
    return null;
  }
  const normalRecovery = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const recoveryHash = (env, customerId, text) => hmac(env, `recovery:${customerId}:${normalRecovery(text)}`);
  function recoveryCode() {
    const text = base32(crypto.getRandomValues(new Uint8Array(5))).toLowerCase();
    return `${text.slice(0, 4)}-${text.slice(4, 8)}`;
  }
  async function newRecoveryCodes(env, customerId) {
    const codes = Array.from({ length: RECOVERY_COUNT }, recoveryCode);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM recovery_codes WHERE customer_id=?').bind(customerId),
      ...(await Promise.all(codes.map(async (c) => env.DB.prepare('INSERT INTO recovery_codes (code_hash,customer_id,created_at) VALUES (?,?,?)').bind(await recoveryHash(env, customerId, c), customerId, now())))),
    ]);
    return codes;
  }

  const enabledFor = async (env, customerId) => Boolean((await env.DB.prepare('SELECT totp_secret FROM customers WHERE id=?').bind(customerId).first())?.totp_secret);

  /**
   * Checks a six-digit code or a recovery code for a customer with two-factor on. A code works once (the step is
   * remembered); a recovery code is used up. Returns 'totp', 'recovery' or null.
   */
  async function check(env, customerId, input) {
    const row = await env.DB.prepare('SELECT totp_secret AS sealed,totp_last_step AS last FROM customers WHERE id=?').bind(customerId).first();
    if (!row?.sealed) return null;
    const code = String(input?.code || '').replace(/\s+/g, '');
    if (/^\d{6}$/.test(code)) {
      const secret = await open(env, customerId, row.sealed);
      const step = secret && (await matchStep(secret, code, row.last || 0));
      if (!step) return null;
      const claimed = await env.DB.prepare('UPDATE customers SET totp_last_step=? WHERE id=? AND totp_last_step<?').bind(step, customerId, step).run();
      return claimed.meta.changes === 1 ? 'totp' : null;
    }
    if (normalRecovery(input?.recoveryCode).length === 8) {
      const used = await env.DB.prepare('UPDATE recovery_codes SET used_at=? WHERE code_hash=? AND customer_id=? AND used_at IS NULL').bind(now(), await recoveryHash(env, customerId, input.recoveryCode), customerId).run();
      return used.meta.changes === 1 ? 'recovery' : null;
    }
    return null;
  }
  async function guarded(env, customerId, input) {
    await limit(env, '2fa', customerId, 6, 900);
    const how = await check(env, customerId, input);
    if (!how) throw new HTTPError(400, input?.recoveryCode ? 'That recovery code is wrong or already used.' : 'That code is wrong or expired. Use the newest code from your app.');
    return how;
  }
  async function notify(env, customer, subject, line) {
    try { await send(env, { to: [customer.email], subject, text: `Hi ${customer.name || 'there'},\n\n${line}\n\nIf this wasn't you, reply to this email or use the Can't sign in? page straight away: ${origin(env)}/signin-help.html\n\nVF Tech\nkevinvf@vftech.io` }, `2fa-${customer.id}-${now()}`); }
    catch (error) { console.error('2fa email', error?.message); }
  }

  /** GET /api/account/2fa */
  async function status(env, active) {
    const row = await env.DB.prepare('SELECT totp_enabled_at AS enabledAt FROM customers WHERE id=?').bind(active.customer.id).first();
    const left = (await env.DB.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE customer_id=? AND used_at IS NULL').bind(active.customer.id).first())?.n ?? 0;
    return json({ available: ready(env), enabled: Boolean(row?.enabledAt), enabledAt: row?.enabledAt ?? null, recoveryCodesLeft: row?.enabledAt ? left : 0 });
  }
  /** POST /api/account/2fa/setup: a new secret to scan (kept for 15 minutes until confirmed). */
  async function setup(env, active) {
    need(env);
    if (await enabledFor(env, active.customer.id)) throw new HTTPError(409, 'Two-factor sign-in is already on.');
    const secret = crypto.getRandomValues(new Uint8Array(20)), key = base32(secret);
    await env.DB.prepare('UPDATE customers SET totp_pending=?,totp_pending_at=? WHERE id=?').bind(await seal(env, active.customer.id, secret), now(), active.customer.id).run();
    const uri = `otpauth://totp/${encodeURIComponent('VFTech:' + active.customer.email)}?secret=${key}&issuer=VFTech&algorithm=SHA1&digits=6&period=30`;
    const qr = qrcode(0, 'M'); qr.addData(uri); qr.make();
    return json({ key: key.replace(/(.{4})/g, '$1 ').trim(), uri, qrSvg: qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true }) }, 201);
  }
  /** POST /api/account/2fa/enable {code}: confirms the app works, turns two-factor on, returns the recovery codes once. */
  async function enable(env, active, input) {
    need(env);
    await limit(env, '2fa-setup', active.customer.id, 6, 900);
    const row = await env.DB.prepare('SELECT totp_pending AS sealed,totp_pending_at AS at,totp_secret AS current FROM customers WHERE id=?').bind(active.customer.id).first();
    if (row?.current) throw new HTTPError(409, 'Two-factor sign-in is already on.');
    if (!row?.sealed || now() - row.at > SETUP_SECONDS) throw new HTTPError(400, 'The setup expired. Start again.');
    const secret = await open(env, active.customer.id, row.sealed), code = String(input?.code || '').replace(/\s+/g, '');
    const step = secret && /^\d{6}$/.test(code) ? await matchStep(secret, code) : null;
    if (!step) throw new HTTPError(400, 'That code doesn’t match. Check the time on your phone and use the newest code.');
    await env.DB.prepare('UPDATE customers SET totp_secret=totp_pending,totp_pending=NULL,totp_pending_at=NULL,totp_enabled_at=?,totp_last_step=? WHERE id=?').bind(now(), step, active.customer.id).run();
    const codes = await newRecoveryCodes(env, active.customer.id);
    // Other devices signed in before two-factor was on are signed out.
    await env.DB.prepare('DELETE FROM sessions WHERE customer_id=? AND token_hash<>?').bind(active.customer.id, await digest(active.token)).run();
    await notify(env, active.customer, 'Two-factor sign-in is on', 'Two-factor sign-in is now on for your VFTech account. After you sign in, we\'ll ask for the code from your authenticator app. Keep your recovery codes somewhere safe: each one works once if you lose your phone.');
    return json({ enabled: true, recoveryCodes: codes });
  }
  /** POST /api/account/2fa/disable {code | recoveryCode} */
  async function disable(env, active, input) {
    if (!(await enabledFor(env, active.customer.id))) throw new HTTPError(409, 'Two-factor sign-in is already off.');
    await guarded(env, active.customer.id, input);
    await env.DB.batch([
      env.DB.prepare('UPDATE customers SET totp_secret=NULL,totp_pending=NULL,totp_pending_at=NULL,totp_enabled_at=NULL,totp_last_step=0 WHERE id=?').bind(active.customer.id),
      env.DB.prepare('DELETE FROM recovery_codes WHERE customer_id=?').bind(active.customer.id),
    ]);
    await notify(env, active.customer, 'Two-factor sign-in is off', 'Two-factor sign-in is now off for your VFTech account. You can turn it back on from your account page at any time.');
    return json({ enabled: false });
  }
  /** POST /api/account/2fa/recovery-codes {code | recoveryCode}: ten new codes; the old ones stop working. */
  async function regenerate(env, active, input) {
    if (!(await enabledFor(env, active.customer.id))) throw new HTTPError(409, 'Turn on two-factor sign-in first.');
    await guarded(env, active.customer.id, input);
    const codes = await newRecoveryCodes(env, active.customer.id);
    await notify(env, active.customer, 'New recovery codes for your VFTech account', 'You made new two-factor recovery codes. The old ones no longer work.');
    return json({ recoveryCodes: codes });
  }
  /** After sign-in, for a session waiting on two-factor: true once a code or recovery code checks out. */
  async function verifySignIn(env, customer, input) {
    const how = await guarded(env, customer.id, input);
    if (how === 'recovery') {
      const left = (await env.DB.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE customer_id=? AND used_at IS NULL').bind(customer.id).first())?.n ?? 0;
      await notify(env, customer, 'A recovery code was used', `Someone signed in to your VFTech account with a recovery code. ${left} unused code${left === 1 ? '' : 's'} left. If you've lost your phone, turn two-factor off and on again from your account page to move it to a new one.`);
    }
    return how;
  }
  return { ready, enabledFor, status, setup, enable, disable, regenerate, verifySignIn, check };
}
