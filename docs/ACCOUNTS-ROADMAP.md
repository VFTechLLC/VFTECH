# Accounts & Subscriptions: status and handoff

**Owner:** @hudsonwork-del (primary developer). **Product owner:** Kevin (kevinvf@vftech.io).
**Full spec:** "VF Tech — Accounts & Subscriptions Spec", a Claude Doc (ask Kevin to share it with you). This file is
self-contained: everything needed to build the remaining phases is below, and it is kept up to date as work lands.

Last updated: 13 Nov 2026.

## Status

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Terms of Service v1.0 page, versioned checkout checkbox, `terms_version` in Stripe metadata | **Live** on vftech.io (`55d849e`, deployed 13 Nov) |
| 1 | Free tier, plan badges and themes, profile editing, features hub, Manage subscription (upgrade / downgrade / cancel / undo), per-plan Terms acceptance | **Live** (PR #9, deployed 13 Nov), minus pricing-card states (1b) |
| 1b | Home/features pricing cards: "Your plan" / "Upgrade" states; header initials + plan chip + profile menu | **Live** (PR #11, deployed 13 Nov) |
| 2 | Payment rules and suspension; Can't sign in? page | 2a payment rules **live** (PR #12, 13 Nov); 2b Can't sign in? **live** (PR #13, 13 Nov) |
| 3 | Close account, data export, plan history view, honest cancellation, welcome and renewal emails | 3a close account + data export **live** (PR #14, 13 Nov); 3b history, cancellation and emails **live** (PR #15, 13 Nov) |
| 4 | Annual pricing, invoices, Google Pay, optional two-factor, hours meter, admin view | 4a annual plans **live** (PR #16, 13 Nov); 4b Google Pay, net-30 and Priority flag **live** (PR #17, 13 Nov); 4c two-factor **in review** (`feature/accounts-4c`) |
| 5 | Go live: live Stripe keys | Not started |

## Your next steps (in order)

- [x] **Review PR #9.** (13 Nov: logic checked; fixed the phone overflow from the billing table and the account page wording in `1c74894`.) Backend: `backend/account.js`, `changePlan` in `backend/billing.js`, routes in `backend/worker.js`, migration `0003_accounts.sql`. Client: plan header, profile, features hub and plan picker in `site/services.js`; styles at the end of `site/services.css`.
- [x] **Run the browser tests** (13 Nov: `services-browser.mjs` passes 40 views; `/account.html` checked for Free, Essentials, Standard with a pending downgrade and Priority cancelling, at 1366px and 390px. `homepage-browser.mjs` hangs on `main` too, so it is not from this PR.) (they could not run where PR #9 was written): `npm run test:homepage`, `node tests/services-browser.mjs`, and look at `/account.html` signed in as Free, Essentials, Standard and Priority, on a phone width too.
- [x] **Stripe test-mode pass** (13 Nov on live vftech.io with omojolah@: resume, upgrade with a $364.70 prorated invoice, downgrade schedule, undo, cancel, resume and a declined card all behave. The decline message was out of view; fixed in #10.) with a `BILLING_TEST_EMAILS` address: subscribe; upgrade (a prorated invoice is paid at once); downgrade (a subscription schedule appears in the dashboard, and the account shows "Changes to … on …"); undo; cancel to Free; resume. Then upgrade with test card `4000 0000 0000 0341` (attaches, then declines): the page must say it was declined and nothing changes.
- [x] **Merge PR #9** (13 Nov, `b1de2ad`; migration 0003 applied), then apply the migration: `npx wrangler d1 migrations apply <db> --remote --config backend/wrangler.jsonc`.
- [x] **Stripe dashboard → Customer portal:** (checked 13 Nov in test mode: already off) turn off "Customers can switch plans". Plan changes must go through `/api/billing/change-plan` (proration rules, schedules, Terms acceptance, `plan_events`).
- [x] **Deploy** (13 Nov: Worker and site) the Worker (`wrangler deploy --config backend/wrangler.jsonc`) and the site (run "Deploy to live site (vftech.io)" by hand; see Repo issues).
- [ ] **Client portal links:** for customers with a project portal, `UPDATE customers SET portal_url='https://…' WHERE email='…'` (admin view comes in phase 4).
- [x] **Phase 1b** (live 13 Nov: the home page has no pricing cards, so the states are on the features page cards; Payment methods shows only on paid plans because Free customers have no Stripe portal to open), then phase 2 onward, as below. Tick the Status table as each lands.

## Repo issues to clear first

- **Push-triggered workflows don't run** on this repo (left over from the fork); only manual dispatch works. Fix: open the Actions tab while signed in as an admin and click the banner that enables workflows.
- **Reduced-motion check (reported earlier):** commit `fa72a1a` forces animations even when the visitor asks for reduced motion, while the test expects them off. The spec requires honouring reduced motion: please make the code respect it rather than changing the test.

## Phase 1b: plan states across the site

- Pricing cards on the home and features pages, by state: signed out → "Choose <plan>"; signed in on Free → "Your plan" on Free, "Upgrade" on paid plans; on a paid plan → "Your plan" on the current card and "Manage subscription" (links to `account.html#vf-billing`) on the others. Read the tier from `GET /api/session` (`plan.tier`).
- Header, top right of every page: signed out → **Sign in**; signed in → initials plus the plan chip (Free plain, Essentials outlined blue, Standard solid blue, Priority gold "★ PRIORITY"). The initials open a menu: Account, Manage subscription, Payment methods (Stripe portal), Sign out. Sign out then lives only in that menu.
- "Most popular" ribbon on Standard (add a `highlight` flag in the catalog generator).
- Reuse the tier colours from `site/services.css` (`.vfs-tier-*`): Essentials #131D25 with #2F6584 border and #86C0E0 accent; Standard #10263A→#163652 with #86C0E0; Priority #0B0B0D with a #7A0F14 glow and gold #E8B84A. Priority stays dark in both site themes. At most one motion (a slow shimmer on the Priority star), off under reduced motion.

## Phase 2: payment rules and suspension; Can't sign in?

**2b status (13 Nov): live** (PR #13): `signin-help.html` (generated), `existingOnly` on `/api/auth/request-code`, `/api/auth/recovery` with migration `0005_recovery.sql`, staff steps in `backend/README.md`, tests in `tests/recovery.test.mjs`. Item (3), a lost two-factor device, came with two-factor in 4c: recovery code first, else the recovery form and the staff steps in `backend/README.md`.

**2a status (13 Nov): live** (PR #12): migration `0004_payment_rules.sql`, timeline in `backend/account.js` (`standingOf`, `cardOf`), webhooks and the daily job in `backend/billing.js` (`paymentEvent`, `refreshCard`, `dunning`), banner and payment screen in `site/services.js`, tests in `tests/payment-rules.test.mjs`. Done in test mode on 13 Nov: the eight events are on the Stripe webhook; Smart Retries (8 tries within three weeks, then mark the subscription unpaid); Stripe emails for failed card and bank payments and expiring cards, linking to Stripe-hosted pages. **Repeat all of it in live** at phase 5. Day 90 ends the plan and writes the balance off; deleting the account data comes with the closing steps in phase 3.

- **Stripe settings:** Smart Retries over three weeks, then mark the subscription **unpaid** (not cancelled), so paying the open invoice restores everything. Turn on expiring-card emails.
- **Timeline from the failed payment** (track `past_due_since` from the `invoice.payment_failed` webhook):

| Days | Status | Customer sees | Features |
| --- | --- | --- | --- |
| 0–6 | Past due | Banner on every page | On |
| 7–29 | Payment required | Sign-in lands on a payment screen (add a method, pay what's owed); only billing, contact and sign out work | Paused: no new requests |
| 30–89 | Suspended | Same screen plus a suspension notice | Off |
| 90 | Closed | Final email | Account closed through the normal closing steps; balance written off |

  Paying everything owed before day 90 restores the plan at once. Emails on days 7, 25 and 30 (day 30 says the account closes on day 90). A cron Worker job moves accounts along the timeline. A disputed charge (`charge.dispute.created`) also puts the account on the payment screen.
- **A paid plan always keeps a valid payment method** (Free is exempt). On `payment_method.detached`, if none remain, show the payment screen until one is added. Check in test mode whether the portal lets customers remove their only method.
- **Expiring cards:** from 30 days before the expiry month, a banner with "Update card".
- **Can't sign in? page:** (1) enter any email and a code is sent if it has an account; the response is identical either way (no account enumeration). Google and Microsoft sign-ins with the same verified email already land in the same account. (2) Lost access to the email: a recovery request form; staff verify (invoice number, last four of the card on file, profile phone), change the email in the admin view, end all sessions, and log it. (3) Lost two-factor device: recovery code, else staff recovery.

## Phase 3: closing, export, history, emails

**3b status (13 Nov): live** (PR #15): Plan history (`GET /api/account/history`, a "Plan history" panel on the account page; Checkout now records a `subscribed` event); cancelling offers Essentials at renewal first and asks one optional why from a short list, kept in `plan_events.reason` (migration `0007_plan_reasons.sql`); a welcome email per plan from `checkout.session.completed` (Priority's links to `contact.html?plan=priority` for the kickoff call until there is a booking link); a confirmation email for every plan change. The annual renewal reminder came with annual plans in 4a. Tests in `tests/history-emails.test.mjs`.

**3a status (13 Nov): live** (PR #14): `backend/closing.js` (code to the account email, typed email, end of period / 14 days / now, Keep my account, daily deletion, JSON export), migration `0006_closing.sql`, the "Your data and account" box and the "closes on" banner in `site/services.js`, tests in `tests/closing.test.mjs`. Close now is offered on Free too (closes at once).

- **Close account:** the customer confirms with their email plus a fresh code (entered within 10 minutes). A paid plan stops renewing and the account stays open until the paid period ends, with a banner reading "Your account closes on <date>" and **Keep my account**. **Close now** ends the plan and the account at once, with no refund. With no paid plan, a 14-day window applies. On the closing date, delete profile, sessions, challenges and requests from D1 and detach payment methods in Stripe; keep invoices in Stripe as tax records; send a confirmation email.
- **Data export:** "Download my data" (profile, requests, invoice list) as one JSON file.
- **Plan history** view from `plan_events` (already recorded by PR #9).
- **Honest cancellation:** Cancel asks one optional "why" (store it in `plan_events`), offers a lower plan, then confirms. No extra screens.
- **Emails (Resend):** a welcome email per plan from the Checkout-completed webhook (Priority's includes a kickoff-call link); plan-change confirmations; an annual renewal reminder 30 days ahead (daily cron). Stripe sends receipts, retry emails and expiring-card emails, so never duplicate them.

## Phase 4: annual, invoices, wallets, two-factor, hours, admin

**4a status (13 Nov): live** (PR #16): annual prices `vftech_<plan>_yearly` at ten times monthly, created in the test sandbox by `scripts/stripe-sync.mjs` (run it with `--live` at phase 5); a Monthly / Annual toggle on the features page cards with the saving in dollars; annual in the subscribe form and the plan picker. Monthly → annual is immediate with the unused month credited; annual → monthly, and any move from annual to a monthly plan, waits for the end of the annual term; a higher annual plan is immediate. Migration `0008_annual.sql` (`billing_interval`, `pending_interval`, `renewal_reminded`; intervals on `plan_events`); the renewal reminder 30 days ahead runs in the daily cron. Tests in `tests/annual.test.mjs`. Next: 4d (hours meter and admin view).

**4c status (13 Nov): in review** (`feature/accounts-4c`): optional two-factor in `backend/twofactor.js`. After any sign-in (email code, Google, Microsoft) a customer with it on gets a 10-minute session that opens only the code step (`POST /api/auth/2fa`), then a fresh full session. TOTP (SHA-1, 6 digits, 30 s, ±1 step, each step usable once); the secret is sealed with AES-GCM under the `TOTP_KEY` Worker secret and bound to the account; ten recovery codes stored as HMACs, each used once, with an email when one is used. Setup on the account page shows a QR code (made in the Worker with `qrcode-generator`), the key and an app link; turning it on signs out other devices; turning it off or making new codes needs a fresh code; emails on every change. Rate limited per customer and per IP. Migration `0010_two_factor.sql`; tests in `tests/two-factor.test.mjs` (incl. the RFC 6238 vector). Staff two-factor comes with Cloudflare Access on the admin view (4d). Passkeys later.

**4b status (13 Nov): live** (PR #17): Checkout uses a Stripe payment method configuration named "VFTech checkout" (cards incl. Amex and Discover, ACH, Google Pay on; Apple Pay, Link, Cash App, Amazon Pay, Klarna and the rest off), made by `scripts/stripe-sync.mjs` and already created in the test sandbox; without it Checkout falls back to cards and ACH. Before this, Apple Pay could appear in Checkout on Safari because the default configuration had it on. Net-30 on request: Priority and annual customers get "Ask for invoice billing" on the account page (`POST /api/billing/net30`), staff get one email with the Stripe steps to approve, and the page shows "Billed by invoice" once the subscription is switched in Stripe (`collection_method` kept in D1). Contact requests from a Priority customer get a `[Priority]` subject and every request shows the plan on file and whether the sender was signed in. Migration `0009_invoice_terms.sql`; tests in `tests/payments-net30.test.mjs`. **At phase 5** run `stripe-sync.mjs --live` so live gets the same configuration.

- **Annual plans** at 10 times the monthly price (two months free): a second Stripe price per plan (`vftech_<plan>_yearly`), a monthly/annual toggle on the pricing cards showing the saving in dollars, monthly → annual immediately with credit, annual → monthly at the term end.
- **Payment methods:** cards (Visa, Mastercard, **Amex and Discover allowed**: same fee), ACH, **Google Pay** (dashboard switch; it shows in hosted Checkout automatically). **No Apple Pay until Sign in with Apple exists. No PayPal** (Stripe doesn't process it for US businesses). Net-30 invoices for Priority and annual customers on request (Stripe Invoicing). Update the `payment_method_types` comment in `billing.js` to match.
- **Optional two-factor:** TOTP after any sign-in method; secret encrypted with a Worker secret; 10 hashed single-use recovery codes; turning it off needs a fresh code; never required for customers, always for staff. Passkeys later.
- **Hours meter:** a `time_entries` table (customer, date, hours, note) filled from the admin view, totalled for the current billing period, with a warning at 80%. Extra work is billed at $250/hour, quoted first.
- **Admin view** behind Cloudflare Access: customers by plan and status, hours logging, suspend and reactivate, recovery requests, `portal_url`.
- **Priority flagging:** `/api/contact` looks up the plan; Priority requests get a `[Priority]` subject prefix.

## Phase 5: go live

Live Stripe keys (this lifts the `BILLING_TEST_EMAILS` gate). Before switching: Stripe **test clocks** for renewals, failures, day 7/30/90 and annual reminders; webhook-failure alerts to admin@; the Privacy policy names Stripe and the other processors; set Stripe Tax codes. Treat plans and builds as taxable for Washington customers until the accountant confirms; WA has taxed website development and support since 1 Oct 2025, with hosting and domains excluded.

## Decisions (13 Nov 2026)

- Plans: Free (account, not a service plan; questions answered in 48–72 hours on average, no support for the customer's site), Essentials $350, Standard $750, Priority $1,500 per month. Annual plans at two months free. No free trials.
- Upgrades are immediate and prorated; downgrades and cancellations take effect at the period end; no partial refunds.
- Third-party service costs are included on Standard and Priority and billed back at cost on Essentials; transaction fees and usage overages are always excluded.
- Backups daily, kept 30 days. Extra work $250/hour.
- Sessions, Discord and members-only videos are **GG Trading only**, not vftech.io.
- Terms v1.0 is live as interim terms; attorney review to follow as v2.0. Contracting entity: VF Associates, LLC, d/b/a VFTech. Customers accept the Terms per plan; acceptances are stored in `terms_acceptances`.
- Later: DocuSign for contracts; invoices moving from Mercury into the customer portal.

## Open questions for Kevin

- Third-party costs were described as included on the "$750 and $1,200" plans, but Priority is $1,500: confirm Standard and Priority.
- Confirm transaction fees and usage overages are excluded from included third-party costs (the Terms say so).
