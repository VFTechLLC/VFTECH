# Start here

**Active project: Accounts & Subscriptions.** Before changing `backend/`, the account page, pricing or billing, read
[`docs/ACCOUNTS-ROADMAP.md`](docs/ACCOUNTS-ROADMAP.md). It has the current status, the next steps checklist and the
requirements for every remaining phase. When you finish a step, tick it there and update its Status table.

## How this repo works

- **Generated pages:** service pages (`features`, `account`, `terms`, …) and `backend/catalog.json` come from
  `scripts/build-services.mjs`. Edit the generator, then run `node scripts/build-services.mjs`. Don't hand-edit the copies.
- **Shared files** (`services.js`, `services.css`, …) live in `site/` and are copied to `design-2` … `design-10` by
  `node scripts/sync-shared.mjs`.
- **Help guide corpus:** after page text changes, run `node scripts/build-knowledge.mjs`.
- **Checks:** `npm run check` (syntax, generated files up to date, unit and backend tests) must pass. The Worker build:
  `bash scripts/assemble.sh preview && npm run backend:check`.
- **Backend tests** use real SQLite with Stripe, Resend and Turnstile mocked (`tests/backend-fixture.mjs`). New Stripe
  calls need a mock there.
- **Billing safety:** with a Stripe test key, billing works only for `BILLING_TEST_EMAILS`. Keep it that way until phase 5.
- **Changes go through pull requests**, not straight to `main`.
- **Deploys:** push-triggered workflows currently don't run; dispatch "Deploy to live site (vftech.io)" by hand (see the
  roadmap's Repo issues).
