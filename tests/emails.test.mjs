// Email runbook (2026-11-17): every email is a config in docs/email-templates/emails, sent as HTML + plain text in
// the site's base templates; each form sends the team email and, where safe, a copy to the person who sent it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {fixture} from './backend-fixture.mjs';
import {render, EMAIL_NAMES} from './email-helpers.mjs';

function setup(t) { const f = fixture(); t.after(() => f.close()); return f; }

test('Every email config renders with its sample: HTML + text, no unfilled placeholders, links on the site', () => {
  const names = readdirSync('docs/email-templates/emails').filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, ''));
  assert.deepEqual([...EMAIL_NAMES].sort(), names.sort(), 'backend/emails.generated.js matches the docs (run node scripts/build-emails.mjs)');
  for (const name of names) {
    const {sample = {}} = JSON.parse(readFileSync(`docs/email-templates/emails/${name}.json`, 'utf8'));
    const email = render(name, sample, {SITE_URL: 'https://vftech.test'});
    assert.ok(email.subject && email.html.startsWith('<!doctype html>') && email.text, name);
    assert.doesNotMatch(`${email.subject}${email.html}${email.text}`, /\{\{[#/]?\w+\}\}/, `${name}: unfilled placeholder`);
    assert.doesNotMatch(`${email.subject}${email.text}`, /undefined|\bnull\b/, name);
    for (const [, url] of email.html.matchAll(/href="(https?:[^"]+)"/g)) assert.ok(/^https:\/\/(vftech\.test|www\.|kevinvanflandern)/.test(url) || !url.includes('vftech'), `${name}: ${url}`);
  }
});

test('Values are HTML-escaped and empty optional rows disappear', () => {
  const email = render('contact-request', {request_id: 'r1', name: '<b>test</b> & "quotes"', email: 'a@example.test', plan_on_file: 'No account', topics: 'AI integration', message: '<script>x</script>'}, {SITE_URL: 'https://vftech.test'});
  assert.match(email.html, /&lt;b&gt;test&lt;\/b&gt; &amp; &quot;quotes&quot;/);
  assert.doesNotMatch(email.html, /<b>test<\/b>|<script>x/);
  assert.match(email.text, /<b>test<\/b>/, 'plain text stays literal');
  assert.match(email.text, /Business: —/, 'team emails keep a dash for an empty business');
  const copy = render('contact-confirmation', {name: 'Pat', email: 'a@example.test', topics: 'AI integration', request_id: 'r1'}, {SITE_URL: 'https://vftech.test'});
  assert.doesNotMatch(copy.text, /Plan:|Availability:/, 'customer copy hides rows they left empty');
});

test('A contact request sends the team email, then a copy to the sender without their message', async (t) => {
  const f = setup(t), data = {...f.contact(), name: 'Pat <b>Sample</b>', message: 'Please call me about https://spam.example'};
  const result = await f.request('contact', data);
  assert.equal(result.status, 201);
  assert.equal(f.state.emails.length, 2);
  const [team, copy] = f.state.emails.map((e) => e.payload);
  assert.deepEqual(team.to, [f.env.CONTACT_TO]);
  assert.equal(team.reply_to, data.email);
  assert.ok(team.html && team.text, 'team email has HTML and text');
  assert.deepEqual(copy.to, [data.email]);
  assert.match(copy.subject, /^We got your request, Pat <b>Sample<\/b>$/, 'subjects are plain text');
  assert.match(copy.html, /Pat &lt;b&gt;Sample&lt;\/b&gt;/);
  assert.doesNotMatch(`${copy.html}${copy.text}`, /spam\.example/, 'the free-text message is never echoed to an address the visitor typed');
  assert.match(copy.html, /https:\/\/vftech\.test\/process\.html/);
});

test('Every email the Worker sends has both an HTML and a plain-text version', async (t) => {
  const f = setup(t);
  await f.request('contact', f.contact());
  await f.login();
  assert.ok(f.state.emails.length >= 3);
  for (const {payload} of f.state.emails) assert.ok(payload.html?.includes('</html>') && payload.text && !payload.template, payload.subject);
});
