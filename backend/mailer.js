// Email rendering (boss's email runbook, 2026-11-17). Every email the Worker sends is one config in
// docs/email-templates/emails/<name>.json placed into a base template (docs/email-templates/base/), compiled into
// emails.generated.js by scripts/build-emails.mjs. One body layout, many configs: no email is hand-written HTML.
//
// A config's "body" is a list of blocks. A string is a paragraph; objects are {heading}, {list: var}, {code: var},
// {details: [[label, var, fallback?]]}, {button: {label, url, text}}, {message: var}, {small}, {signoff: true}.
// Any block can carry "if": var (shown only when that value is non-empty). In any string, {{var}} is a value and
// {{#var}}...{{/var}} is kept only when var is non-empty. Values are HTML-escaped in the HTML version.
import { LAYOUTS, EMAILS } from './emails.generated.js';

export const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The pages the base templates link to, as {{link_<name>}}. */
export const LINKS = {
  home: '/', websites: '/websites.html', ai: '/ai.html', advisory: '/advisory.html', process: '/process.html',
  pricing: '/websites.html#pricing', about: '/about.html', contact: '/contact.html', account: '/account.html',
  help: '/signin-help.html', terms: '/terms.html', admin: '/api/admin', kickoff: '/contact.html?plan=priority',
};
const LOGO = '/assets/brand/vf-tech-logo.png';
const CONTACT_EMAIL = 'kevinvf@vftech.io';

function siteOrigin(env) {
  try { return new URL(env.SITE_URL).origin; } catch { return 'https://vftech.io'; }
}

/** Values every template can use: full links built from SITE_URL, the logo, the contact address. */
export function siteValues(env, sentAt = new Date()) {
  const base = siteOrigin(env);
  return {
    ...Object.fromEntries(Object.entries(LINKS).map(([name, path]) => [`link_${name}`, base + path])),
    logo_url: base + LOGO,
    site_host: new URL(base).host,
    contact_email: CONTACT_EMAIL,
    sent_at: `${sentAt.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })} ET`,
  };
}

const present = (value) => (Array.isArray(value) ? value.length > 0 : String(value ?? '').trim() !== '');

/** Fills {{#var}}...{{/var}} sections and {{var}} values; `escape` is applied to each value. */
function fill(template, values, escape) {
  let out = String(template ?? '');
  for (let previous = ''; previous !== out;) {
    previous = out;
    out = out.replace(/\{\{#(\w+)\}\}((?:(?!\{\{#\1\}\})[\s\S])*?)\{\{\/\1\}\}/g, (match, key, inner) => (present(values[key]) ? inner : ''));
  }
  return out.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in values ? escape(Array.isArray(values[key]) ? values[key].join(', ') : String(values[key] ?? '')) : match));
}

const FONT = 'font-family:Arial,Helvetica,sans-serif;';
const MONO = "font-family:Menlo,Consolas,'Courier New',monospace;";

/** One block in both forms. Returns null when the block is hidden. */
function block(part, values) {
  const html = (text) => fill(text, values, escapeHtml).replace(/\n/g, '<br>');
  const text = (value) => fill(value, values, (v) => v);
  if (typeof part === 'string') {
    return { html: `<p class="em-t" style="margin:0 0 16px 0;${FONT}font-size:15px;color:#14181b;line-height:1.6;">${html(part)}</p>`, text: text(part) };
  }
  if (part.if && !present(values[part.if])) return null;
  if (part.heading) {
    return { html: `<p class="em-h" style="margin:0 0 14px 0;${FONT}font-size:24px;font-weight:700;color:#14181b;line-height:1.25;">${html(part.heading)}</p>`, text: text(part.heading) };
  }
  if (part.small) {
    return { html: `<p class="em-m" style="margin:0 0 16px 0;${FONT}font-size:13px;color:#4b5459;line-height:1.6;">${html(part.small)}</p>`, text: text(part.small) };
  }
  if (part.list) {
    const items = (values[part.list] || []).filter(present);
    if (!items.length) return null;
    return {
      html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px 0;">${items.map((item) => `<tr><td width="18" style="vertical-align:top;padding:3px 0;${MONO}font-size:14px;color:#2a6889;">&rsaquo;</td><td class="em-t" style="padding:3px 0;${FONT}font-size:15px;color:#14181b;line-height:1.5;">${escapeHtml(item)}</td></tr>`).join('')}</table>`,
      text: items.map((item) => `- ${item}`).join('\n'),
    };
  }
  if (part.code) {
    // HTML only: the code also sits in the sentence around it, which is what the plain-text version shows.
    return { html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px 0;"><tr><td class="em-panel" bgcolor="#f3f4f1" style="background-color:#f3f4f1;border:1px solid #cdd2d3;padding:14px 22px;${MONO}font-size:30px;font-weight:700;letter-spacing:.18em;color:#14181b;"><span class="em-h">${escapeHtml(values[part.code])}</span></td></tr></table>`, text: '' };
  }
  if (part.details) {
    const rows = part.details
      .map(([label, key, fallback]) => [label, present(values[key]) ? (Array.isArray(values[key]) ? values[key].join(', ') : String(values[key])) : fallback])
      .filter(([, value]) => present(value));
    if (!rows.length) return null;
    return {
      html: `<table role="presentation" class="em-panel" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f4f1" style="background-color:#f3f4f1;border:1px solid #cdd2d3;border-left:3px solid #2a6889;margin:0 0 18px 0;"><tr><td style="padding:14px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.map(([label, value]) => `<tr><td class="em-m" style="padding:5px 12px 5px 0;${MONO}font-size:12px;color:#4b5459;width:150px;vertical-align:top;">${escapeHtml(label)}</td><td class="em-h" style="padding:5px 0;${FONT}font-size:14px;color:#14181b;vertical-align:top;word-break:break-word;">${escapeHtml(value)}</td></tr>`).join('')}</table></td></tr></table>`,
      text: rows.map(([label, value]) => `${label}: ${value}`).join('\n'),
    };
  }
  if (part.button) {
    const url = fill(part.button.url, values, (v) => v);
    return {
      html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px 0;"><tr><td class="em-btn" bgcolor="#14181b" style="background-color:#14181b;"><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;${FONT}font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${html(part.button.label)}</a></td></tr></table>`,
      text: text(part.button.text || `${part.button.label}: ${url}`),
    };
  }
  if (part.message) {
    const value = String(values[part.message] ?? '');
    if (!present(value)) return null;
    return { html: `<div class="em-panel em-h" style="margin:0 0 18px 0;padding:14px 18px;background-color:#ffffff;border:1px solid #cdd2d3;${FONT}font-size:15px;color:#14181b;line-height:1.6;white-space:pre-line;">${escapeHtml(value)}</div>`, text: value };
  }
  if (part.signoff) {
    return { html: `<p class="em-h" style="margin:8px 0 0 0;${FONT}font-size:15px;color:#14181b;line-height:1.5;">VF Tech<br><a class="em-link" href="mailto:${CONTACT_EMAIL}" style="color:#2a6889;text-decoration:none;">${CONTACT_EMAIL}</a></p>`, text: `VF Tech\n${CONTACT_EMAIL}` };
  }
  throw new Error(`Unknown email block: ${JSON.stringify(part)}`);
}

/** Renders one email by name: { subject, html, text }. Throws on an unknown name so a typo fails the tests. */
export function render(name, vars = {}, env = {}, sentAt = new Date()) {
  const email = EMAILS[name];
  if (!email) throw new Error(`No email template "${name}" in docs/email-templates/emails.`);
  const values = { ...siteValues(env, sentAt), ...vars };
  const raw = (template) => fill(template, values, (v) => v);
  const subject = raw(email.subject).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
  const parts = email.body.map((part) => block(part, values)).filter(Boolean);
  const layout = LAYOUTS[email.direction];
  const frame = { subject, preheader: raw(email.preheader), header_label: raw(email.header_label), footer_note: raw(email.footer_note) };
  const pieces = (kind) => ({ ...values, ...frame, content: parts.map((p) => p[kind]).filter((p) => p !== '').join(kind === 'html' ? '\n' : '\n\n') });
  const htmlValues = pieces('html');
  const html = fill(layout.html, Object.fromEntries(Object.entries(htmlValues).map(([k, v]) => [k, k === 'content' ? v : escapeHtml(Array.isArray(v) ? v.join(', ') : v)])), (v) => v);
  const text = fill(layout.text, pieces('text'), (v) => v).replace(/\n{3,}/g, '\n\n').trim();
  return { subject, html, text };
}

/**
 * Turns a send payload that names a template ({ template, vars }) into a ready one ({ subject, html, text }).
 * Payloads without a template pass through unchanged.
 */
export function prepare(env, payload) {
  if (!payload?.template) return payload;
  const { template, vars, ...rest } = payload;
  return { ...rest, ...render(template, vars, env) };
}
