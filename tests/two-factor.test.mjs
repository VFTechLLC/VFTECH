// Accounts & Subscriptions spec, phase 4c: optional two-factor sign-in (TOTP) with ten single-use recovery codes.
// Real SQLite, mocked Resend and Turnstile; codes computed here from the secret the setup returns.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './backend-fixture.mjs';
import {totp, unbase32} from '../backend/twofactor.js';

const KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const step = (offset = 0) => Math.floor(Date.now() / 1000 / 30) + offset;
function setup(t, key = KEY) {
  const f = fixture();
  t.after(() => f.close());
  if (key) f.env.TOTP_KEY = key;
  return f;
}
const as = (login, csrf = true) => ({headers: {Cookie: login.cookie, ...(csrf ? {'X-CSRF-Token': login.body.csrfToken} : {})}});
const cookieOf = (r) => r.response.headers.get('Set-Cookie').split(';')[0];
async function turnOn(f) {
  const login = await f.login();
  const made = await f.request('account/2fa/setup', {}, as(login));
  assert.equal(made.status, 201);
  const secret = unbase32(made.body.key);
  const on = await f.request('account/2fa/enable', {code: await totp(secret, step())}, as(login));
  assert.equal(on.status, 200);
  return {login, secret, made, codes: on.body.recoveryCodes};
}
/** Email sign-in for a customer with two-factor on: returns the pending cookie. */
async function signIn(f) {
  const r = await f.request('auth/verify-code', await f.challenge());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {authenticated: false, twoFactor: true});
  return cookieOf(r);
}
const withCookie = (cookie) => ({headers: {Cookie: cookie}});

test('TOTP matches the RFC 6238 test vector (SHA-1, 6 digits)', async () => {
  const secret = new TextEncoder().encode('12345678901234567890');
  assert.equal(await totp(secret, 1), '287082');
  assert.equal(await totp(secret, Math.floor(1111111109 / 30)), '081804');
});

test('Without the TOTP_KEY secret two-factor is unavailable and nothing changes', async (t) => {
  const f = setup(t, ''), login = await f.login();
  assert.deepEqual((await f.request('account/2fa', undefined, as(login, false))).body, {available: false, enabled: false, enabledAt: null, recoveryCodesLeft: 0});
  assert.equal((await f.request('account/2fa/setup', {}, as(login))).status, 503);
});

test('Turning it on: QR and key, a code must match, ten recovery codes, other devices signed out, email sent', async (t) => {
  const f = setup(t), login = await f.login(), other = await f.login();
  assert.equal((await f.request('account/2fa/setup', {}, as(login, false))).status, 403, 'needs CSRF');
  const made = await f.request('account/2fa/setup', {}, as(login));
  assert.match(made.body.qrSvg, /^<svg/);
  assert.match(made.body.uri, /^otpauth:\/\/totp\/VFTech%3Aone%40example.test\?secret=[A-Z2-7]{32}&issuer=VFTech/);
  assert.match(made.body.key, /^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
  const stored = f.sqlite.prepare('SELECT totp_pending FROM customers').get().totp_pending;
  assert.ok(stored.startsWith('v1.') && !stored.includes(made.body.key.replace(/ /g, '')), 'the secret is stored sealed');
  assert.equal((await f.request('account/2fa/enable', {code: '000000'}, as(login))).status, 400);
  const secret = unbase32(made.body.key);
  const on = await f.request('account/2fa/enable', {code: await totp(secret, step())}, as(login));
  assert.equal(on.status, 200);
  assert.equal(on.body.recoveryCodes.length, 10);
  assert.equal(new Set(on.body.recoveryCodes).size, 10);
  for (const c of on.body.recoveryCodes) assert.match(c, /^[a-z2-7]{4}-[a-z2-7]{4}$/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM recovery_codes').get().n, 10);
  assert.ok(!JSON.stringify(f.sqlite.prepare('SELECT code_hash FROM recovery_codes').all()).includes(on.body.recoveryCodes[0].replace('-', '')), 'codes are stored hashed');
  assert.equal((await f.request('account/profile', undefined, as(login, false))).status, 200, 'this device stays signed in');
  assert.equal((await f.request('account/profile', undefined, as(other, false))).status, 401, 'other devices are signed out');
  assert.match(f.state.emails.at(-1).payload.subject, /Two-factor sign-in is on/);
  const status = (await f.request('account/2fa', undefined, as(login, false))).body;
  assert.equal(status.enabled, true);
  assert.equal(status.recoveryCodesLeft, 10);
});

test('Signing in asks for the code; the pending session opens nothing else; a code works once', async (t) => {
  const f = setup(t), {secret} = await turnOn(f);
  const pending = await signIn(f);
  assert.deepEqual((await f.request('session', undefined, withCookie(pending))).body, {authenticated: false, twoFactor: true});
  assert.equal((await f.request('account/profile', undefined, withCookie(pending))).status, 401);
  assert.equal((await f.request('billing', undefined, withCookie(pending))).status, 401);
  assert.equal((await f.request('auth/2fa', {code: '123456'}, withCookie(pending))).status, 400);
  const code = await totp(secret, step(1));
  const done = await f.request('auth/2fa', {code}, withCookie(pending));
  assert.equal(done.status, 200);
  assert.equal(done.body.authenticated, true);
  assert.ok(done.body.csrfToken);
  const full = cookieOf(done);
  assert.notEqual(full, pending, 'a new session token after the code');
  assert.equal((await f.request('account/profile', undefined, withCookie(full))).status, 200);
  assert.deepEqual((await f.request('session', undefined, withCookie(pending))).body, {authenticated: false}, 'the pending session is gone');
  // The same code, or an older one, can't be used again.
  const again = await signIn(f);
  assert.equal((await f.request('auth/2fa', {code}, withCookie(again))).status, 400);
  assert.equal((await f.request('auth/2fa', {code: await totp(secret, step())}, withCookie(again))).status, 400);
});

test('No pending session, no code step', async (t) => {
  const f = setup(t);
  await turnOn(f);
  assert.equal((await f.request('auth/2fa', {code: '123456'})).status, 401);
});

test('Recovery codes sign in once each and warn by email', async (t) => {
  const f = setup(t), {codes} = await turnOn(f);
  let pending = await signIn(f);
  const ok = await f.request('auth/2fa', {recoveryCode: codes[3].toUpperCase().replace('-', ' ')}, withCookie(pending));
  assert.equal(ok.status, 200, 'case and separators don\'t matter');
  assert.match(f.state.emails.at(-1).payload.subject, /A recovery code was used/);
  assert.match(f.state.emails.at(-1).payload.text, /9 unused codes left/);
  pending = await signIn(f);
  assert.equal((await f.request('auth/2fa', {recoveryCode: codes[3]}, withCookie(pending))).status, 400);
  const status = (await f.request('account/2fa', undefined, {headers: {Cookie: cookieOf(ok)}})).body;
  assert.equal(status.recoveryCodesLeft, 9);
});

test('Wrong codes are rate limited per customer', async (t) => {
  const f = setup(t), {secret} = await turnOn(f);
  const pending = await signIn(f);
  for (let i = 0; i < 6; i++) assert.equal((await f.request('auth/2fa', {code: '000000'}, withCookie(pending))).status, 400);
  assert.equal((await f.request('auth/2fa', {code: await totp(secret, step(1))}, withCookie(pending))).status, 429);
});

test('Turning it off or making new recovery codes needs a fresh code; off means no code step', async (t) => {
  const f = setup(t), {login, secret, codes} = await turnOn(f);
  assert.equal((await f.request('account/2fa/disable', {}, as(login))).status, 400);
  const fresh = await f.request('account/2fa/recovery-codes', {code: await totp(secret, step(1))}, as(login));
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.recoveryCodes.length, 10);
  assert.equal((await f.request('account/2fa/disable', {recoveryCode: codes[0]}, as(login))).status, 400, 'old recovery codes stopped working');
  assert.equal((await f.request('account/2fa/disable', {recoveryCode: fresh.body.recoveryCodes[0]}, as(login))).status, 200);
  assert.match(f.state.emails.at(-1).payload.subject, /Two-factor sign-in is off/);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM recovery_codes').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT totp_secret FROM customers').get().totp_secret, null);
  const r = await f.request('auth/verify-code', await f.challenge());
  assert.equal(r.body.authenticated, true);
});

test('A sealed secret only opens for its own account', async (t) => {
  const f = setup(t), {secret} = await turnOn(f);
  await f.login('two@example.test');
  f.sqlite.prepare("UPDATE customers SET totp_secret=(SELECT totp_secret FROM customers WHERE email='one@example.test'),totp_enabled_at=1 WHERE email='two@example.test'").run();
  const r = await f.request('auth/verify-code', await f.challenge('two@example.test'));
  assert.equal(r.body.twoFactor, true);
  assert.equal((await f.request('auth/2fa', {code: await totp(secret, step(1))}, withCookie(cookieOf(r)))).status, 400);
});
