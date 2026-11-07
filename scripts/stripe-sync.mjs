#!/usr/bin/env node
// Makes Stripe match backend/catalog.json (the one price file, boss 2026-10-31): one product per monthly plan and
// one active monthly USD price with the lookup key vftech_<plan id>_monthly (what the Worker charges); builds
// with a fixed published price ("$3,500 Fixed") get a one-time price with the lookup key vftech_<id>_once. A changed
// price gets a new Stripe price and takes over the lookup key; existing subscribers keep theirs until changed.
// Also sets the Customer Portal: invoices, card updates, and cancel at period end (no refunds).
//
//   node scripts/stripe-sync.mjs            show what would change (no writes)
//   node scripts/stripe-sync.mjs --apply    make the changes
// The key comes from STRIPE_SECRET_KEY or backend/.dev.vars. Only sk_test_ keys unless --live is given too.
import {readFileSync, existsSync} from 'node:fs';
import {formEncode, lookupKey, oneTimeKey, fixedPriceCents} from '../backend/billing.js';

const apply = process.argv.includes('--apply'), live = process.argv.includes('--live');
const catalog = JSON.parse(readFileSync(new URL('../backend/catalog.json', import.meta.url), 'utf8'));
const devVars = new URL('../backend/.dev.vars', import.meta.url);
const key = process.env.STRIPE_SECRET_KEY || (existsSync(devVars) ? readFileSync(devVars, 'utf8').match(/^STRIPE_SECRET_KEY=(.+)$/m)?.[1]?.trim() : '');
if (!key) throw new Error('No STRIPE_SECRET_KEY (environment or backend/.dev.vars).');
if (!key.startsWith('sk_test_') && !(live && key.startsWith('sk_live_'))) throw new Error('Refusing a non-test key. Add --live only when the boss has switched Stripe to live.');
const site = 'https://vftech.io';

async function stripe(method, path, params) {
  const url = new URL(path, 'https://api.stripe.com/v1/');
  if (method === 'GET' && params) url.search = formEncode(params).toString();
  const response = await fetch(url, {method, headers: {Authorization: `Bearer ${key}`, 'Stripe-Version': '2024-06-20', ...(method === 'POST' ? {'Content-Type': 'application/x-www-form-urlencoded'} : {})}, body: method === 'POST' ? formEncode(params || {}) : undefined});
  const result = await response.json();
  if (!response.ok) throw new Error(`Stripe ${method} ${path}: ${result.error?.message || response.status}`);
  return result;
}
const cents = (price) => {
  const match = /^\$([\d,]+(?:\.\d{2})?)\/mo$/.exec(price);
  if (!match) throw new Error(`Can't read a monthly price from "${price}"`);
  return Math.round(Number(match[1].replace(/,/g, '')) * 100);
};
const say = (text) => console.log(`${apply ? '' : '[dry run] '}${text}`);

const items = [...catalog.plans.map((plan) => ({...plan, amount: cents(plan.price), lookup: lookupKey(plan.id), monthly: true})), ...catalog.builds.filter((build) => fixedPriceCents(build.price) !== null).map((build) => ({...build, amount: fixedPriceCents(build.price), lookup: oneTimeKey(build.id), monthly: false}))];
console.log(`Stripe ${key.startsWith('sk_test_') ? 'TEST' : 'LIVE'} mode: ${items.filter((i) => i.monthly).length} monthly plans and ${items.filter((i) => !i.monthly).length} one-time items from backend/catalog.json`);
const products = (await stripe('GET', 'products', {limit: 100, active: 'true'})).data;
for (const plan of items) {
  const amount = plan.amount, lookup = plan.lookup, per = plan.monthly ? '/month' : ' one-time';
  let product = products.find((item) => item.metadata?.vftech_plan_id === plan.id);
  if (!product) {
    say(`create product ${plan.name}`);
    if (apply) product = await stripe('POST', 'products', {name: `VF Tech ${plan.name}`, description: plan.description.slice(0, 500), metadata: {vftech_plan_id: plan.id}, tax_code: 'txcd_10000000'});
  } else if (product.name !== `VF Tech ${plan.name}`) {
    say(`rename product ${product.name} → VF Tech ${plan.name}`);
    if (apply) await stripe('POST', `products/${product.id}`, {name: `VF Tech ${plan.name}`});
  }
  const current = (await stripe('GET', 'prices', {lookup_keys: [lookup], active: 'true', limit: 1})).data[0];
  if (current && current.unit_amount === amount && (plan.monthly ? current.recurring?.interval === 'month' : !current.recurring)) {
    console.log(`ok      ${plan.name}: $${amount / 100}${per} (${current.id})`);
    continue;
  }
  say(`${current ? 'replace' : 'create '} ${plan.name}: $${amount / 100}${per}${current ? ` (was $${current.unit_amount / 100})` : ''}`);
  if (apply) {
    await stripe('POST', 'prices', {product: product.id, currency: 'usd', unit_amount: amount, ...(plan.monthly ? {recurring: {interval: 'month'}} : {}), lookup_key: lookup, transfer_lookup_key: 'true', tax_behavior: 'exclusive', nickname: `${plan.name} ${plan.monthly ? 'monthly' : 'one-time'}`});
    if (current) await stripe('POST', `prices/${current.id}`, {active: 'false'});
  }
}

// Customer Portal (the default configuration): invoices, card updates, cancel at period end, no plan switching yet.
const portal = (await stripe('GET', 'billing_portal/configurations', {is_default: 'true', limit: 1})).data[0];
const portalSettings = {
  business_profile: {headline: 'VF Tech billing: update your card, see invoices, or cancel.', terms_of_service_url: `${site}/terms.html`, privacy_policy_url: `${site}/terms.html#privacy`},
  features: {
    invoice_history: {enabled: 'true'},
    payment_method_update: {enabled: 'true'},
    customer_update: {enabled: 'true', allowed_updates: ['email', 'address', 'name']},
    subscription_cancel: {enabled: 'true', mode: 'at_period_end', proration_behavior: 'none', cancellation_reason: {enabled: 'true', options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'other']}},
    subscription_update: {enabled: 'false'},
  },
  default_return_url: `${site}/account.html`,
};
say(`${portal ? 'update' : 'create'} the Customer Portal settings (invoices, card updates, cancel at period end)`);
if (apply) await stripe('POST', portal ? `billing_portal/configurations/${portal.id}` : 'billing_portal/configurations', portalSettings);
console.log(apply ? 'Done.' : 'Nothing changed. Run again with --apply to make these changes.');
