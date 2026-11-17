# Email templates (VF Tech)

Every email vftech.io sends is built from this folder, following the VF Tech email runbook (2026-11-17). This folder
is the only copy: `node scripts/build-emails.mjs` compiles it into `backend/emails.generated.js`, and
`npm run check` fails if that file is stale.

```
docs/email-templates/
  README.md            this file
  forms.md             every form and event, its variables, and which email it sends
  base/
    outbound.html/.txt frame for mail TO CUSTOMERS: logo, Websites/AI/Advisory/Your account menu; footer with what
                       VF Tech is, the contact email, How we work/Pricing/About/Contact/Can't sign in?, Terms
    inbound.html/.txt  frame for mail TO THE TEAM: small dark header with the site and what this is; footer with
                       when it was sent and a link to the admin page
  emails/<name>.json   one per email (30): direction, subject, preheader, footer note, body blocks, sample values
  previews/            every email rendered with its sample (.html, .txt) and screenshots (.png: light, dark, phone)
```

## Why each email is a config, not an HTML file

All 30 emails share one body layout (greeting, a few lines, sometimes a list or a details table, a button, the
sign-off). Following the "one template, many configs" rule, each email is a JSON config of blocks, and
`backend/mailer.js` turns the blocks into HTML and plain text. Change a button style once and all 30 change. The
rendered result of each email is in `previews/`.

Blocks: a string is a paragraph; `{heading}`, `{list: var}`, `{code: var}` (big code box, HTML only),
`{details: [[label, var, fallback?]]}` (rows with no value and no fallback disappear), `{button: {label, url, text}}`
(`text` is the plain-text version), `{message: var}` (the visitor's own text, team emails only), `{small}`,
`{signoff: true}`. Any block can have `"if": var`. In any string, `{{var}}` is a value and `{{#var}}…{{/var}}` shows
only when var isn't empty.

## How sending works

- Every module calls the same `send(env, payload, key)` in `backend/worker.js`. A payload with
  `{template, vars}` is rendered by `prepare()` in `backend/mailer.js` into `{subject, html, text}` and sent through
  Resend from `EMAIL_FROM` (unchanged). Values are HTML-escaped in the HTML version; subjects are plain text.
- Team emails go to `CONTACT_TO` with Reply-To set to the customer where there is one.
- Customer copies of a form are sent after the team email and are best-effort: if the copy fails, it's logged and
  the request still succeeds.
- The plain-text versions keep the exact wording the emails had before, so the existing tests still check them.

## Regenerate and check

```
node scripts/build-emails.mjs --previews   # compile + render previews; fails on unfilled {{ }}, "undefined", unescaped HTML
npm run check                              # includes build-emails --check and tests/emails.test.mjs
```

## Adding an email

1. Add `emails/<name>.json` with `direction`, `subject`, `body` and a `sample`. Inbound ones need `header_label`.
2. Send it: `send(env, {to, template: '<name>', vars: {...}}, key)`.
3. Run `node scripts/build-emails.mjs --previews`, look at the preview, and add the email to `forms.md`.

## Test checklist (runbook step 6)

The Worker serves vftech.io directly, so a real send test happens after deploy, with test accounts on
BILLING_TEST_EMAILS / VF Tech addresses only.

- [ ] Contact form, every field: team email + customer copy arrive, values in place, Reply goes to the sender
- [ ] Contact form, required fields only: no empty rows, no `{{ }}` or "undefined"
- [ ] `<b>test</b> & "quotes"` shows as text (also covered by `tests/emails.test.mjs`)
- [ ] Sign-in code, two-factor and close-account emails from a test account
- [ ] Gmail web + app, Outlook, Apple Mail, light and dark
- [ ] Every header, footer and button link opens on vftech.io over https
- [ ] SPF and DKIM pass (Gmail, Show original)
