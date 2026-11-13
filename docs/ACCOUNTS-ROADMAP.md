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
| 1b | Home/features pricing cards: "Your plan" / "Upgrade" states; header initials + plan chip + profile menu | **In review** (`feature/accounts-1b`) |
| 2 | Payment rules and suspension; Can't sign in? page | Not started |
| 3 | Close account, data export, plan history view, honest cancellation, welcome and renewal emails | Not started |
| 4 | Annual pricing, invoices, Google Pay, optional two-factor, hours meter, admin view | Not started |
| 5 | Go live: live Stripe keys | Not started |

## Your next steps (in order)

- [x] **Review PR #9.** (13 Nov: logic checked; fixed the phone overflow from the billing table and the account page wording in `1c74894`.) Backend: `backend/account.js`, `changePlan` in `backend/billing.js`, routes in `backend/worker.js`, migration `0003_accounts.sql`. Client: plan header, profile, features hub and plan picker in `site/services.js`; styles at the end of `site/services.css`.
- [x] **Run the browser tests** (13 Nov: `services-browser.mjs` passes 40 views; `/account.html` checked for Free, Essentials, Standard with a pending downgrade and Priority cancelling, at 1366px and 390px. `homepage-browser.mjs` hangs on `main` too, so it is not from this PR.) (they could not run where PR #9 was written): `npm run test:homepage`, `node tests/services-browser.mjs`, and look at `/account.html` signed in as Free, Essentials, Standard and Priority, on a phone width too.
- [x] **Stripe test-mode pass** (13 Nov on live vftech.io with omojolah@: resume, upgrade with a $364.70 prorated invoice, downgrade schedule, undo, cancel, resume and a declined card all behave. The decline message was out of view; fixed in #10.) with a `BILLING_TEST_EMAILS` address: subscribe; upgrade (a prorated invoice is paid at once); downgrade (a subscription schedule appears in the dashboard, and the account shows "Changes to … on …"); undo; cancel to Free; resume. Then upgrade with test card `4000 0000 0000 0341` (attaches, then declines): the page must say it was declined and nothing changes.
- [x] **Merge PR #9** (13 Nov, `b1de2ad`; migration 0003 applied), then apply the migration: `npx wrangler d1 migrations apply <db> --remote --config backend/wrangler.jsonc`.
- [x] **Stripe dashboard → Customer portal:** (checked 13 Nov in test mode: already off) turn off "Customers can switch plans". Plan changes must go through `/api/billing/change-plan` (proration rules, schedules, Terms acceptance, `plan_events`).
- [x] **Deploy** (13 Nov: Worker and site) the Worker (`wrangler deploy --config backend/wrangler.jsonc`) and the site (run "Deploy to live site (vftech.io)" by hand; see Repo issues).
- [ ] **Client portal links:** for customers with a project portal, `UPDATE customers SET portal_url='https://…' WHERE email='…'` (admin view comes in phase 4).
- [ ] **Phase 1b** (built 13 Nov, in review: the home page has no pricing cards, so the states are on the features page cards; Payment methods shows only on paid plans because Free customers have no Stripe portal to open), then phase 2 onward, as below. Tick the Status table as each lands.

## Repo issues to clear first

- **Push-triggered workflows don't run** on this repo (left over from the fork); only manual dispatch works. Fix: open the Actions tab while signed in as an admin and click the banner that enables workflows.
- **Reduced-motion check (reported earlier):** commit `fa72a1a` forces animations even when the visitor asks for reduced motion, while the test expects them off. The spec requires honouring reduced motion: please make the code respect it rather than changing the test.

## Phase 1b: plan states across the site

- Pricing cards on the home and features pages, by state: signed out → "Choose <plan>"; signed in on Free → "Your plan" on Free, "Upgrade" on paid plans; on a paid plan → "Your plan" on the current card and "Manage subscription" (links to `account.html#vf-billing`) on the others. Read the tier from `GET /api/session` (`plan.tier`).
- Header, top right of every page: signed out → **Sign in**; signed in → initials plus the plan chip (Free plain, Essentials outlined blue, Standard solid blue, Priority gold "★ PRIORITY"). The initials open a menu: Account, Manage subscription, Payment methods (Stripe portal), Sign out. Sign out then lives only in that menu.
- "Most popular" ribbon on Standard (add a `highlight` flag in the catalog generator).
- Reuse the tier colours from `site/services.css` (`.vfs-tier-*`): Essentials #131D25 with #2F6584 border and #86C0E0 accent; Standard #10263A→#163652 with #86C0E0; Priority #0B0B0D with a #7A0F14 glow and gold #E8B84A. Priority stays dark in both site themes. At most one motion (a slow shimmer on the Priority star), off under reduced motion.

## Phase 2: payment rules and suspension; Can't sign in?

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

- **Close account:** the customer confirms with their email plus a fresh code (entered within 10 minutes). A paid plan stops renewing and the account stays open until the paid period ends, with a banner reading "Your account closes on <date>" and **Keep my account**. **Close now** ends the plan and the account at once, with no refund. With no paid plan, a 14-day window applies. On the closing date, delete profile, sessions, challenges and requests from D1 and detach payment methods in Stripe; keep invoices in Stripe as tax records; send a confirmation email.
- **Data export:** "Download my data" (profile, requests, invoice list) as one JSON file.
- **Plan history** view from `plan_events` (already recorded by PR #9).
- **Honest cancellation:** Cancel asks one optional "why" (store it in `plan_events`), offers a lower plan, then confirms. No extra screens.
- **Emails (Resend):** a welcome email per plan from the Checkout-completed webhook (Priority's includes a kickoff-call link); plan-change confirmations; an annual renewal reminder 30 days ahead (daily cron). Stripe sends receipts, retry emails and expiring-card emails, so never duplicate them.

## Phase 4: annual, invoices, wallets, two-factor, hours, admin

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
