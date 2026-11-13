# VFTech client services

The public GitHub Pages site includes a local site guide, interactive feature
examples, published prices and an account portal. Real email and account creation
remain disabled until the business configures delivery. The contact form prepares
a request without claiming to send it. No provider account, domain or paid service
has been created. The chatbot has no backend endpoint and never sends questions.

The deployable Cloudflare Worker serves the same static site and same-origin APIs.
D1 stores verified customers and request history, Turnstile verifies submissions,
and Resend delivers emails. Keep all credentials out of browser code and git.

## Build and verify

From the repository root:

```sh
npm ci
npm run generate:services
npm run check
bash scripts/assemble.sh preview
npm run backend:check
node tests/services-browser.mjs
node tests/services-live-browser.mjs
```

Tests use real SQLite and mock only the two fixed provider endpoints. Browser
tests exercise the real Worker, including contact delivery, code sign-in, session
restoration, private request history, logout and delivery failure. No emails are
sent during tests. To preview the Worker with services still disabled:

```sh
npx wrangler d1 migrations apply vftech-clients --local --config backend/wrangler.jsonc
npm run backend:dev
```

## Enable delivery when ready

1. Choose the final HTTPS origin and a business-owned email/domain. Create a
   Turnstile widget restricted to that hostname. Verify the sender domain in
   Resend and choose the business inbox for contact requests.
2. Create a D1 database:

   ```sh
   npx wrangler login
   npx wrangler d1 create vftech-clients
   ```

   Replace the all-zero `database_id` in `backend/wrangler.jsonc` with the returned
   ID. Set `SITE_URL` to the HTTPS origin without a path; `TURNSTILE_HOSTNAME` to
   its hostname; `TURNSTILE_SITE_KEY` to the public key; `EMAIL_FROM` to the
   verified sender; and `CONTACT_TO` to the business inbox.
3. Add these secrets using the prompts:

   ```sh
   npx wrangler secret put RESEND_API_KEY --config backend/wrangler.jsonc
   npx wrangler secret put TURNSTILE_SECRET_KEY --config backend/wrangler.jsonc
   npx wrangler secret put SESSION_SECRET --config backend/wrangler.jsonc
   ```

   Generate the session secret with a cryptographically random generator, using
   at least 32 characters. Rotating it invalidates pending codes and CSRF tokens.
4. Apply the migration and deploy:

   ```sh
   npx wrangler d1 migrations apply vftech-clients --remote --config backend/wrangler.jsonc
   npm run generate:services
   bash scripts/assemble.sh production
   npx wrangler deploy --config backend/wrangler.jsonc
   ```

5. Attach the final domain to the Worker if using a custom domain. Confirm the
   `/api/config` readiness flags and update the published business contact details.
   Then test contact delivery, email-code login, logout and a failed CAPTCHA using
   accounts you control. Only this final live check sends real email.

Host assets and APIs on the same HTTPS origin. The Worker generates
`services-config.js` in every design and enables configured forms automatically.
GitHub Pages cannot execute the Worker and keeps real forms disabled; it can link
to the first-party portal. Do not rely on third-party authentication cookies
between GitHub Pages and a separate API domain. The guide remains local.

## Behavior

- Contact: bounded fields, fixed recipient, validated plan/topic IDs, honeypot,
  server-verified CAPTCHA and an atomic IP rate limit. Plain-text email avoids
  visitor-supplied HTML. Idempotency keys prevent duplicate successful sends.
  Success means provider acceptance, not guaranteed downstream inbox delivery.
- Accounts: six-digit codes last ten minutes, allow five attempts and are claimed
  once even during races. Only keyed code hashes are stored. A customer is created
  after verification. Sessions last seven days, store token hashes and use a
  Secure, HttpOnly, SameSite=Strict `__Host-` cookie. Mutations check the configured
  origin; logout also checks CSRF. Each customer sees their verified email's requests.
- Retention: daily cleanup removes expired codes, sessions and rate buckets, plus
  contact requests older than 30 days (up to 31 days between cleanup runs). Inbox
  copies follow the business's policy. Profiles remain until the business removes
  them; self-service deletion is not implemented in this version.
- Guide: quotes bundled public page text with citations, follows the selected
  section/control and declines unmatched questions. It has no model API, neural
  fine-tuning, external browsing, form-value access or private account access.
  Regenerate the corpus after editing site text; stale excerpts fail the checks.
- Demos: charts, streams and workspace accounts use sample data. Real services
  cover identity and contact history; production analytics, project management,
  billing and payments remain future integrations. Prices are discussion starting
  points and selecting a tier does not purchase or activate it.

References: [Turnstile verification](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/),
[Worker assets](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/),
[D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/),
[Resend email API](https://resend.com/docs/api-reference/emails/send-email).

## Accounts & subscriptions, phase 1 (2026-11-13)

From the Accounts & Subscriptions spec (Claude Doc, shared by Kevin). Tests: `tests/account.test.mjs`.

| Endpoint | What it does |
| --- | --- |
| `GET /api/session` | Now also returns `plan`: `tier` (free, essentials, standard, priority), `status`, `periodEnd`, `cancelAtPeriodEnd`, `pendingPlanId`/`pendingPlanName`. `past_due` keeps the tier; `unpaid`/`incomplete` drop features to Free. |
| `GET/POST /api/account/profile` | Name, business, phone (POST needs the CSRF header). Email changes are phase 2, with recovery. |
| `GET /api/account/features` | The plan's features from `catalog.features` (generated in `scripts/build-services.mjs`), each with its button, plus locked ones with the plan that unlocks them. The client-portal button shows only when `customers.portal_url` holds an https URL. |
| `POST /api/billing/change-plan {planId, acceptTerms}` | Higher plan: immediate, prorated difference charged now (`error_if_incomplete`, so a declined card changes nothing and returns 402). Lower plan: Stripe subscription schedule, switches at period end. `free`: cancel at period end. Same plan again: undo a pending downgrade or resume a cancellation. Paid moves need `acceptTerms`; every change lands in `plan_events`, every acceptance in `terms_acceptances` (version + keyed IP hash). Checkout now records acceptances too. |

Before deploying:

1. Apply the migration: `npx wrangler d1 migrations apply <db> --remote --config backend/wrangler.jsonc` (adds `0003_accounts.sql`).
2. Stripe dashboard → Customer portal settings: turn **off** "Customers can switch plans", so plan changes only go through `/api/billing/change-plan` (proration, schedules and Terms acceptance live there). Keep payment methods, invoices and cancellation on.
3. Each plan needs its `vftech_<plan>_monthly` price (already created by `scripts/stripe-sync.mjs`); upgrades and downgrades look prices up the same way Checkout does.

To give a customer a portal button: `UPDATE customers SET portal_url='https://…' WHERE email='…'` in the D1 console (admin view comes in phase 4).
