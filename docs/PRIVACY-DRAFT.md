# Privacy wording for the Terms: draft for Kevin

**Status:** draft, not live. Phase 5 needs the privacy section to name Stripe and the other services that handle customer data (`docs/ACCOUNTS-ROADMAP.md`, phase 5). Today clause 15.2 of the Terms (v1.0) names only Stripe. The Terms are accepted per plan, so changing them means a new version (v1.1) and new acceptances from that point; the attorney review planned for v2.0 should look at this too.

Everything below matches what the system does today (checked 2026-11-16 in `backend/` and `site/`). If something changes, change this text with it.

## Proposed clause 15 (replaces 15.2; 15.1 stays)

**15.2 What we keep.** To provide the service we keep: your name, email address, business name and phone number; the requests and messages you send us; your plan, its history, and the answers you give when you change or cancel it; the hours we log for work on your plan; which version of these Terms you accepted for each plan, and when; a record of your sign-ins; and, if you turn on two-factor sign-in, an encrypted key and one-way hashed recovery codes. We do not keep your card or bank details.

**15.3 Who helps us run the service.** We share only what each one needs:
- **Stripe** processes payments and keeps your payment details, invoices and receipts, under its own privacy policy.
- **Cloudflare** hosts the website and our systems, and runs the security check on our forms.
- **Resend** sends our emails, such as sign-in codes, receipts of your requests, and plan notices.
- **Google** and **Microsoft**, only if you choose to sign in with them; they tell us your verified email address and name.

We do not sell your data or share it for advertising.

**15.4 Cookies.** The site sets one cookie to keep you signed in, and a short-lived one while you sign in with Google or Microsoft. We use no advertising or analytics cookies.

**15.5 How long we keep it.** Contact-form requests from people without an account are deleted after 30 days. Sign-in codes and sessions expire. When you close your account we delete your profile, sign-ins, requests, plan history and logged hours; invoices stay with Stripe as tax records.

**15.6 Your choices.** You can download your data from your account page at any time, correct your profile there, or close your account. To ask about your data, contact us at kevinvf@vftech.io.

## Decisions for Kevin

1. OK with this wording, and with publishing it as Terms **v1.1**? (Existing customers keep v1.0 until their next plan change, when they accept v1.1, as the per-plan acceptance already works.)
2. Should privacy also get its own page (`/privacy`), linked from the footer and the sign-up forms? Many people look for it there.
3. Contact address for privacy questions: kevinvf@vftech.io, or a role address such as privacy@vftech.io?
