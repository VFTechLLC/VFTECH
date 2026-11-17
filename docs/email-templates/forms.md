# Forms, events and their email variables (VF Tech)

Step 3 of the email runbook. Every email the vftech-client-services Worker sends, what triggers it, and the variables
it uses. The handlers are the source of truth: `backend/worker.js` (contact, sign-in, recovery), `billing.js`,
`twofactor.js`, `closing.js` and `admin.js`.

## Forms on the site

| Form | Page | Handler | Team email (inbound) | Customer email (outbound) |
|---|---|---|---|---|
| Project request | /contact.html | `POST /api/contact` | `contact-request` to CONTACT_TO, Reply-To the sender | `contact-confirmation` |
| Sign in / sign up | /account.html | `POST /api/auth/request-code` | none | `sign-in-code` |
| Can't sign in? (account recovery) | /signin-help.html | `POST /api/auth/recovery` | `recovery-request` | **none on purpose**: nothing goes to the new address automatically (security rule, tested in `tests/recovery.test.mjs`) |
| Pay by invoice (Net-30) | /account.html | `POST /api/billing/net30` | `net30-request`, Reply-To the customer | `net30-confirmation` |
| Close account | /account.html | `POST /api/account/close/*` | none | `close-code`, then `account-closed` |
| Two-factor settings | /account.html | `/api/account/2fa/*` | none | `2fa-on`, `2fa-off`, `2fa-new-codes`, `2fa-code-used` |

### Project request fields (the handler's variables)

| Variable | Label shown to people | Type | Required | Example | Customer email | Team email |
|---|---|---|---|---|---|---|
| `name` | Name | text | yes | Pat Sample | yes | yes |
| `email` | Email | email | yes | pat@example.com | yes | yes |
| `business` | Business | text | no | Pat Co | no | yes ("—" if empty) |
| `phone` | Phone | tel | no | (202) 555-0147 | no | yes ("—" if empty) |
| `topics` | What do you need? | checkboxes | no | Website rebuild, AI integration | yes (hidden if empty) | yes |
| `plan` | Plan (from `planId`) | select | no | Standard ($750/mo) | yes (hidden if empty) | yes |
| `times` | Good times to talk | text | no | Weekday mornings | yes (hidden if empty) | yes |
| `message` | Message | textarea | yes | We need a rebuild… | **no** (never echoed to a typed address) | yes |
| `request_id` | (server) | uuid | auto | 7c1f… | yes | yes |
| `plan_on_file` / `priority` | (server: plan of the account with this email) | text | auto | Priority · signed in | no | yes, and [Priority] in the subject |

Dropped on purpose: `website` (honeypot), `turnstileToken`. Never in any email: IP, user agent.

## Events (not forms)

Billing, admin and security emails come from Stripe events, the daily cron and the admin page. They're listed with
the rest below.

## Every email

| Email | To | Trigger | Variables |
|---|---|---|---|
| `2fa-code-used` | Customer | A recovery code was used to sign in (twofactor.js) | `left` `codes_word` `name` |
| `2fa-new-codes` | Customer | New recovery codes made (twofactor.js) | `name` |
| `2fa-off` | Customer | Two-factor turned off (twofactor.js) | `name` |
| `2fa-on` | Customer | Two-factor turned on (twofactor.js) | `name` |
| `2fa-reset-by-team` | Customer | Team turned two-factor off from the admin page (admin.js) | `name` |
| `account-closed` | Customer | Account closed (closing.js) | `name` |
| `close-code` | Customer | Code to confirm closing the account (closing.js) | `code` |
| `contact-confirmation` | Customer | Contact form, to the person who sent it (worker.js /api/contact) | `name` `email` `topics` `plan` `times` `request_id` |
| `contact-request` | Team | Contact form, to the team (worker.js /api/contact) | `priority` `request_id` `name` `topics` `email` `plan_on_file` `business` `phone` `plan` `times` `message` |
| `email-changed` | Customer | Team changed the sign-in email after a recovery request (admin.js) | `name` `address` |
| `hours-80` | Customer | 80% of the month's plan hours used (admin.js addHours) | `resets` `name` `used` `included` `hours_word` `rate` |
| `hours-used` | Customer | All of the month's plan hours used (admin.js addHours) | `resets` `name` `used` `included` `hours_word` `rate` |
| `net30-confirmation` | Customer | Pay by invoice request, to the customer (billing.js requestNet30) | `name` `plan` |
| `net30-request` | Team | Pay by invoice request from the account page, to the team (billing.js requestNet30) | `email` `name` `plan` `interval_word` `business` `phone` `subscription` |
| `payment-day-25` | Customer | Unpaid for 25 days (billing.js dunning) | `plan` `name` `suspends` |
| `payment-day-30` | Customer | Unpaid for 30 days, plan suspended (billing.js dunning) | `plan` `name` `closes` |
| `payment-day-7` | Customer | Unpaid for 7 days (billing.js dunning) | `plan` `name` `suspends` |
| `payment-day-90` | Customer | Unpaid for 90 days, plan closed (billing.js dunning) | `plan` `name` |
| `plan-cancel-scheduled` | Customer | Plan cancelled at period end (billing.js confirmChange) | `from` `when` `name` |
| `plan-change-undone` | Customer | Scheduled switch cancelled (billing.js confirmChange) | `from` `name` `when` |
| `plan-downgrade-scheduled` | Customer | Downgrade scheduled for the end of the period (billing.js confirmChange) | `to` `name` `from` `when` `price` |
| `plan-resumed` | Customer | Cancellation undone (billing.js confirmChange) | `from` `name` `when` |
| `plan-switch-scheduled` | Customer | Annual plan set to switch at renewal (billing.js confirmChange) | `to` `interval_word` `name` `from` `when` `price` |
| `plan-switched-annual` | Customer | Switched to annual billing (billing.js confirmChange) | `to` `name` `yearly_price` |
| `plan-upgraded` | Customer | Plan upgraded (billing.js confirmChange) | `to` `from` `name` `when` `price` |
| `recovery-request` | Team | Can't sign in? form, to the team (worker.js /api/auth/recovery) | `old_email` `name` `new_email` `request_id` `found_line` `invoice` `card_last4` `phone` `message` |
| `renewal-reminder` | Customer | Annual plan renews in 30 days (billing.js renewalReminders) | `plan` `date` `name` `change_line` |
| `sign-in-code` | Customer | Sign-in or sign-up code (worker.js /api/auth/request-code) | `code` |
| `webhook-alert` | Team | Daily check finds Stripe events not delivered (billing.js webhookHealth) | `count` `events_word` `webhook_url` `mode` `first` `last` `by_type` |
| `welcome` | Customer | Stripe checkout completed for a plan (billing.js welcome) | `plan` `name` `features` |

Every template can also use `link_<page>` (home, websites, ai, advisory, process, pricing, about, contact, account,
help, terms, admin, kickoff), `logo_url`, `site_host`, `contact_email` and `sent_at`. They're built from SITE_URL in
`backend/mailer.js`.
