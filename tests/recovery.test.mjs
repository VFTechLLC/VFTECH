// Accounts & Subscriptions spec, phase 2: the "Can't sign in?" page. A code goes only to existing accounts, with the
// same answer either way; a lost-email recovery request is stored and emailed to staff, with the same answer whether
// or not the old email has an account. Real SQLite, mocked Turnstile and Resend.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './backend-fixture.mjs';

function setup(t) { const f = fixture(); t.after(() => f.close()); return f; }
const challenges = (f) => f.sqlite.prepare('SELECT COUNT(*) AS n FROM auth_challenges').get().n;
const recovery = (f, overrides = {}) => ({name: 'Pat Customer', oldEmail: 'one@example.test', newEmail: 'pat@new.example.test', invoice: 'VF-0001', cardLast4: '', phone: '', message: 'Lost my work inbox.', website: '', turnstileToken: f.token('account'), ...overrides});

test('Account-only codes: same answer for unknown emails, and nothing is sent or stored', async (t) => {
  const f = setup(t);
  await f.login('one@example.test');
  const before = {emails: f.state.emails.length, challenges: challenges(f)};
  const unknown = await f.request('auth/request-code', {email: 'nobody@example.test', existingOnly: true, turnstileToken: f.token('account')});
  assert.equal(unknown.status, 201);
  assert.match(unknown.body.challengeId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(unknown.body).sort(), ['challengeId', 'expiresIn']);
  assert.equal(f.state.emails.length, before.emails, 'no email to an unknown address');
  assert.equal(challenges(f), before.challenges, 'no challenge stored');
  // The made-up challenge can't sign anyone in, or create an account.
  const guess = await f.request('auth/verify-code', {email: 'nobody@example.test', challengeId: unknown.body.challengeId, code: '123456'});
  assert.equal(guess.status, 400);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM customers WHERE email='nobody@example.test'").get().n, 0);
  // A known email gets a real code, with an identically shaped answer.
  const known = await f.request('auth/request-code', {email: 'one@example.test', existingOnly: true, turnstileToken: f.token('account')});
  assert.equal(known.status, 201);
  assert.deepEqual(Object.keys(known.body).sort(), ['challengeId', 'expiresIn']);
  assert.equal(f.state.emails.length, before.emails + 1);
  const value = f.state.emails.at(-1).payload.text.match(/\b(\d{6})\b/)[1];
  const signedIn = await f.request('auth/verify-code', {email: 'one@example.test', challengeId: known.body.challengeId, code: value});
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.body.customer.email, 'one@example.test');
});

test('Account-only codes still need the captcha and respect the rate limit', async (t) => {
  const f = setup(t);
  const noCaptcha = await f.request('auth/request-code', {email: 'nobody@example.test', existingOnly: true});
  assert.equal(noCaptcha.status, 400);
  // Three tries per email per 15 minutes, counted before the captcha (the failed try above counts too).
  for (let i = 0; i < 3; i++) assert.equal((await f.request('auth/request-code', {email: 'someone@example.test', existingOnly: true, turnstileToken: f.token('account')})).status, 201);
  assert.equal((await f.request('auth/request-code', {email: 'someone@example.test', existingOnly: true, turnstileToken: f.token('account')})).status, 429);
});

test('A recovery request is stored and emailed to staff; the answer never says whether the account exists', async (t) => {
  const f = setup(t);
  await f.login('one@example.test');
  const sentBefore = f.state.emails.length;
  const known = await f.request('auth/recovery', recovery(f));
  const unknown = await f.request('auth/recovery', recovery(f, {oldEmail: 'nobody@example.test', newEmail: 'x@new.example.test'}));
  assert.equal(known.status, 201);
  assert.deepEqual(unknown, {...unknown, status: 201});
  assert.deepEqual(known.body, unknown.body);
  const rows = f.sqlite.prepare('SELECT old_email AS oldEmail,new_email AS newEmail,invoice,account_found AS found,status FROM recovery_requests ORDER BY created_at,rowid').all().map((r) => ({...r}));
  assert.deepEqual(rows, [
    {oldEmail: 'one@example.test', newEmail: 'pat@new.example.test', invoice: 'VF-0001', found: 1, status: 'open'},
    {oldEmail: 'nobody@example.test', newEmail: 'x@new.example.test', invoice: 'VF-0001', found: 0, status: 'open'},
  ]);
  const staff = f.state.emails.slice(sentBefore);
  assert.equal(staff.length, 2);
  assert.deepEqual(staff[0].payload.to, ['inbox@vftech.test'], 'only staff are emailed');
  assert.match(staff[0].payload.subject, /Account recovery request: one@example\.test/);
  assert.match(staff[0].payload.text, /Account on file for the old email: yes/);
  assert.match(staff[1].payload.text, /Account on file for the old email: NO/);
  assert.ok(!staff.some((m) => m.payload.to.includes('pat@new.example.test')), 'nothing goes to the new address automatically');
});

test('A recovery request needs something checkable and a real change', async (t) => {
  const f = setup(t);
  assert.match((await f.request('auth/recovery', recovery(f, {invoice: '', cardLast4: '', phone: ''}))).body.error, /at least one detail/);
  assert.match((await f.request('auth/recovery', recovery(f, {cardLast4: '12a4'}))).body.error, /last four digits/);
  assert.match((await f.request('auth/recovery', recovery(f, {newEmail: 'one@example.test'}))).body.error, /different email/);
  assert.equal((await f.request('auth/recovery', recovery(f, {name: ''}))).status, 400);
  assert.equal((await f.request('auth/recovery', recovery(f, {website: 'spam'}))).status, 400, 'honeypot');
  assert.equal((await f.request('auth/recovery', recovery(f, {turnstileToken: ''}))).status, 400, 'captcha');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM recovery_requests').get().n, 0);
});
