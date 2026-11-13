// Generate the same service content in each design's existing header/footer shell.
import {readFileSync,writeFileSync} from 'node:fs';
import {parseHTML} from 'linkedom';
const check=process.argv.includes('--check');
const folders=['site',...Array.from({length:9},(_,i)=>`design-${i+2}`)];
const clean=el=>el.textContent.replace(/\s+/g,' ').trim();
const {document:source}=parseHTML(readFileSync('design-3/websites.html','utf8'));
const slug=s=>s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-$/,'');
const builds=[...source.querySelectorAll('#pricing .tier')].map(el=>{
  const price=el.querySelector('.price').cloneNode(true);price.querySelectorAll('.vh').forEach(x=>x.remove());
  price.querySelectorAll('small').forEach(x=>x.replaceWith(source.createTextNode(' '+clean(x))));
  const name=clean(el.querySelector('h3'));
  return {id:slug(name),name,price:clean(price),description:clean(el.querySelector('p')),kind:'build'};
});
const planNames=[...source.querySelectorAll('#plans thead th')].map(clean);
const planRows=[...source.querySelectorAll('#plans tbody tr')];
const plans=planNames.map((name,i)=>({id:slug(name),name,price:clean(planRows[0].querySelectorAll('td')[i])+'/mo',kind:'maintenance',...(slug(name)==='standard'?{highlight:true}:{}),description:planRows.slice(1).map(row=>`${clean(row.querySelector('th'))}: ${clean(row.querySelectorAll('td')[i])}`).join('. ')}));
// What each plan includes, shown on the account page (spec: "Plan features in the account"). type: link (a button
// to href), contact (mailto/tel), portal (the customer's own portal URL, set per customer), included (no button).
// detail may differ per plan. Locked features show the lowest plan that includes them.
const PAID=['essentials','standard','priority'],ALL=['free',...PAID];
const planFeatures=[
  {id:'request',type:'link',label:'Send a request',href:'contact.html',plans:ALL,detail:{free:'Questions about our services, or a quote for new work',essentials:'Changes and support for your website',standard:'Changes and support for your website',priority:'Flagged as Priority when it arrives'}},
  {id:'email',type:'contact',label:'Email us',href:'mailto:kevinvf@vftech.io',plans:ALL},
  {id:'phone',type:'contact',label:'Call us',href:'tel:+14257615502',plans:PAID},
  {id:'portal',type:'portal',label:'Open your client portal',plans:PAID},
  {id:'response',type:'included',label:'Response time',plans:ALL,detail:{free:'48–72 hours on average, for questions about our services; no support for your website',essentials:'Within 3 business days',standard:'By the next business day',priority:'Within 4 business hours'}},
  {id:'hosting',type:'included',label:'Hosting, domain and SSL',plans:PAID},
  {id:'backups',type:'included',label:'Daily backups, kept 30 days',plans:PAID},
  {id:'monitoring',type:'included',label:'Uptime monitoring, security and dependency updates',plans:PAID},
  {id:'hours',type:'included',label:'Change hours each month',plans:PAID,detail:{essentials:'1 hour',standard:'3 hours',priority:'8 hours'}},
  {id:'third-party',type:'included',label:'Third-party service costs included',plans:['standard','priority']},
  {id:'ai',type:'included',label:'AI update assistant',plans:['standard','priority']},
  {id:'report',type:'included',label:'Monthly traffic and lead report',plans:['standard','priority']},
  {id:'review',type:'included',label:'Quarterly technology and search review',plans:['priority']},
];
const catalog={version:1,termsVersion:'1.0',builds,plans,features:planFeatures};
function save(path,value){if(check){if(readFileSync(path,'utf8')!==value)throw Error(`Generated file is stale: ${path}`);}else writeFileSync(path,value);}
save('backend/catalog.json',JSON.stringify(catalog,null,2)+'\n');
save('site/service-catalog.js',`window.VFTechPrices = ${JSON.stringify(catalog)};\n`);
const esc=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
// Annual plans (Accounts spec, phase 4): ten times the monthly price, two months free.
const cents=price=>Number((/^\$([\d,]+)/.exec(price)||[,'0'])[1].replace(/,/g,''))*100;
const usd=c=>'$'+(c/100).toLocaleString('en-US');
const yearly=price=>usd(cents(price)*10)+'/yr';
const saving=price=>usd(cents(price)*2);
function pricing(items){return items.map(p=>`<article class="vfs-price${p.highlight?' vfs-price-highlight':''}"${p.kind==='maintenance'?` data-vf-plan-card="${p.id}"`:''}>${p.highlight?'<span class="vfs-ribbon">Most popular</span>':''}<span class="vfs-kicker">${p.kind==='build'?'Build':'Ongoing care'}</span><h3>${esc(p.name)}</h3><p class="vfs-price-value"${p.kind==='maintenance'?` data-vf-monthly="${esc(p.price)}" data-vf-yearly="${esc(yearly(p.price))}"`:''}>${esc(p.price)}</p>${p.kind==='maintenance'?`<p class="vfs-small vfs-saving" data-vf-saving hidden>Billed yearly: save ${esc(saving(p.price))}</p>`:''}<p>${esc(p.description)}</p><a class="vfs-link" href="contact.html?plan=${p.id}">Discuss ${esc(p.name)} <span aria-hidden="true">↗</span></a>${p.kind==='maintenance'?`<a class="vfs-button" href="account.html?subscribe=${p.id}" data-vf-subscribe hidden>Choose ${esc(p.name)}</a>`:/^\$[\d,]+ Fixed$/.test(p.price)?`<a class="vfs-button" href="account.html?buy=${p.id}" data-vf-subscribe hidden>Buy ${esc(p.name)}</a>`:''}</article>`).join('\n');}
function subnav(active){return `<nav class="vfs-subnav" aria-label="Features and customer services"><a href="features.html"${active==='features'?' aria-current="page"':''}>Features</a><a href="features.html#prices">Pricing</a><a href="account.html"${active==='account'?' aria-current="page"':''}>Customer account</a></nav>`;}
function features(root){return `<main id="main" class="vfs-main"><div class="vfs-shell">${subnav('features')}
<section class="vfs-intro" id="feature-sites" data-vf-record="feature-sites" data-vf-tags="vftech build website sites showcase"><span class="vfs-kicker">Explore the possibilities</span><h1>See what your site can do.</h1><p>VFTech builds websites, custom applications, dashboards and integrations. Explore working examples, compare the published prices and prepare a project request.</p><div class="vfs-actions"><a class="vfs-button" href="#demos">Try the demos</a><a class="vfs-button vfs-secondary" href="${root}design-3/compare.html">All ten designs</a></div></section>
<section id="demos" class="vfs-section" aria-labelledby="demos-title"><div class="vfs-section-head"><span class="vfs-kicker">Interactive examples</span><h2 id="demos-title">Click it. Change it. Ask about it.</h2><p>These examples use generated sample data. They do not display live customer information.</p></div>
<div class="vfs-demo-grid">
<article class="vfs-card" id="feature-dashboard" data-vf-record="feature-dashboard" data-vf-tags="dashboard metrics projects ledger"><span class="vfs-chip">01 / Dashboard</span><h3>One place to see the work.</h3><p>Dashboards bring project status, leads and key metrics together. The Ledger demo lets you filter projects, open details and complete review items using sample data.</p><div class="vfs-mini-metrics" aria-label="Sample dashboard"><div><span>Active projects</span><strong>12</strong></div><div><span>Ready for review</span><strong>4</strong></div><div><span>Uptime</span><strong>99.98%</strong></div></div><a class="vfs-link" href="${root}design-7/index.html">Open project dashboard ↗</a></article>
<article class="vfs-card" id="feature-charts" data-vf-record="feature-charts" data-vf-tags="charts chart analytics range graphs"><span class="vfs-chip">02 / Charts</span><h3>Make a trend easy to read.</h3><p>Interactive charts let you change the time range and inspect values. These figures are sample visits, not real analytics. The Lumen and Console demos include charts and monitoring views.</p><div class="vfs-range" role="group" aria-label="Sample chart range"><button type="button" data-vfs-range="7" aria-pressed="true">7 days</button><button type="button" data-vfs-range="30" aria-pressed="false">30 days</button><button type="button" data-vfs-range="90" aria-pressed="false">90 days</button></div><figure class="vfs-chart"><svg id="vfs-chart" role="img" aria-labelledby="vfs-chart-label" viewBox="0 0 420 104"></svg><figcaption id="vfs-chart-label">Sample visits · 7 days</figcaption></figure><a class="vfs-link" href="${root}design-6/index.html?demo=chart#showcase">Open interactive charts ↗</a></article>
<article class="vfs-card" id="feature-data" data-vf-record="feature-data" data-vf-tags="dynamic data demo demos real orders live sample"><span class="vfs-chip">03 / Dynamic data</span><h3>A page that keeps up.</h3><p>Dynamic data can update an order list or dashboard without reloading the page. All demos here use generated sample data, not real customer data. The sample below adds a row every six seconds while visible. Pause it whenever you like.</p><div class="vfs-data-tools"><span class="vfs-live">Sample stream</span><button type="button" id="vfs-stream-toggle" aria-pressed="false">Pause updates</button></div><div class="vfs-table-wrap"><table class="vfs-table"><caption class="vfs-sr">Generated sample orders</caption><thead><tr><th scope="col">Order</th><th scope="col">Service</th><th scope="col">Status</th></tr></thead><tbody id="vfs-orders"><tr><td>#1042</td><td>Website audit</td><td>Received</td></tr><tr><td>#1041</td><td>Dashboard</td><td>Review</td></tr></tbody></table></div><p id="vfs-stream-status" class="vfs-small" role="status">2 sample orders</p><a class="vfs-link" href="${root}design-6/index.html?demo=data#showcase">Open sortable data demo ↗</a></article>
<article class="vfs-card" id="feature-accounts" data-vf-record="feature-accounts" data-vf-tags="account customer login signup register"><span class="vfs-chip">04 / Customer accounts</span><h3>A private place for each customer.</h3><p>The customer portal supports email verification codes and a view of your own submitted requests after the delivery services are configured. Account creation is available only after email delivery and verification services are configured. The account page shows whether sign-in is enabled. The Lumen account preview is a simulation and does not create an account or take payments.</p><div class="vfs-account-preview" aria-hidden="true"><span class="vfs-avatar">S</span><div><strong>Sample customer</strong><span>Projects · Requests · Settings</span></div><span class="vfs-chip">Preview</span></div><div class="vfs-actions"><a class="vfs-link" href="account.html">Customer portal ↗</a><a class="vfs-link" href="${root}design-6/index.html?demo=acct#showcase">Try the account preview ↗</a></div></article>
</div></section>
<section class="vfs-section" id="other-designs"><div class="vfs-section-head"><span class="vfs-kicker">More ways to present a product</span><h2>Three different workspaces.</h2><p>Showcase distinct sites and features through a collection of linked, interactive examples.</p></div><div class="vfs-projects">
${[[8,'Console','Monitoring and incident detail'],[9,'Pulse','An editable task board'],[10,'Mono','A searchable knowledge base']].map(([n,name,description])=>`<a class="vfs-project" href="${root}design-${n}/index.html"><img src="${root}design-${n}/social/vftech-card.jpg" alt="${name} design preview" loading="lazy" width="1200" height="630"><div><h3>${name}</h3><p>${description}</p><span class="vfs-link">Explore design ↗</span></div></a>`).join('')}
</div><p class="vfs-small"><a href="${root}design-3/compare.html">Browse all ten website designs</a></p></section>
<section id="feature-board" class="vfs-callout" data-vf-record="feature-board" data-vf-tags="pulse board kanban tasks"><h2>Try a task board.</h2><p>Pulse is a sample task workspace. Search, filter by assignee, add a task and move it between workflow stages. Changes stay in memory for the current page; this demo is not a shared project database.</p><a class="vfs-link" href="${root}design-9/index.html">Open Pulse ↗</a></section>
<section id="guide" class="vfs-callout" data-vf-record="guide-about" data-vf-tags="chatbot guide offline local internet trained questions"><h2>Your guide, right on the page.</h2><p>The VFTech guide answers locally from text bundled with this site. It quotes published page content and links to its source. It does not send questions to an AI service, search the internet or read linked websites. It declines questions it cannot match to the site. Chat remains in this tab. After the guide files load, answers work without an internet connection. It is a local text guide, not a model trained on private customer data.</p><p>With “Follow this page” enabled, clicking a demo or section updates the guide’s About button. It reads control and section names, never the contents of your contact or account form.</p><button class="vfs-button" type="button" data-open-guide>Ask the site guide</button></section>
<section id="contact-delivery" class="vfs-callout" data-vf-record="guide-contact" data-vf-tags="email contact form captcha verification turnstile delivery"><h2>A request that reaches the right person.</h2><p>The contact form prepares a request you can copy. Email delivery remains disabled until the business email and backend are configured. When enabled, the form uses Cloudflare Turnstile verification, validates your details and sends the request to the configured business inbox. A submission is marked sent only after the email provider accepts it. Please do not include passwords, payment details or sensitive documents.</p><a class="vfs-link" href="contact.html">Prepare a project request ↗</a></section>
<section class="vfs-section" id="prices"><div class="vfs-section-head"><span class="vfs-kicker">Published build pricing</span><h2>Choose a starting point.</h2><p>The audit comes first, then your fixed quote. These are the same five tiers published on the Website rebuilds page.</p><p id="price-overview" data-vf-record="guide-pricing" data-vf-tags="pricing prices cost fees build tiers">${builds.map(p=>`${esc(p.name)}: ${esc(p.price)}`).join('; ')}.</p></div><div class="vfs-prices">${pricing(builds)}</div><p class="vfs-small">Fixed build fees are paid in thirds: signing, design approval and launch. Scope freezes at design approval; later changes are quoted in writing first. <a href="websites.html#terms">Read the terms</a>.</p></section>
<section class="vfs-section" id="care"><div class="vfs-section-head"><span class="vfs-kicker">Optional ongoing care</span><h2>Support after handover.</h2><p id="care-overview" data-vf-record="guide-care" data-vf-tags="monthly maintenance plans essentials standard priority hosting">${plans.map(p=>`${esc(p.name)}: ${esc(p.price)}`).join('; ')}.</p></div><div class="vfs-range vfs-interval" role="group" aria-label="Billing period"><button type="button" data-vf-interval="month" aria-pressed="true">Monthly</button><button type="button" data-vf-interval="year" aria-pressed="false">Annual · 2 months free</button></div><div class="vfs-prices vfs-care">${pricing(plans)}</div><p class="vfs-small">Plans attached to a build start with a 12-month initial term, then run month to month with 30 days’ notice. Included hours do not roll over. Annual billing costs ten months for twelve and renews yearly, with a reminder 30 days before. <a href="websites.html#plans">Compare the full plan terms</a>.</p></section>
</div></main>`;}
function account(root){return `<main id="main" class="vfs-main"><div class="vfs-shell">${subnav('account')}<section class="vfs-intro"><span class="vfs-kicker">Customer portal</span><h1>Your work. Your account.</h1><p>Sign in with a short-lived email verification code. New customers create an account by verifying their email; no password is stored.</p></section>
<div class="vfs-account-layout"><section class="vfs-card" aria-labelledby="vf-account-title"><h2 id="vf-account-title">Create an account or sign in</h2><p id="vf-service-status" class="vfs-status" role="status">Live account creation is not enabled yet. Email delivery and verification services still need configuration.</p><form id="vf-account-form" class="vfs-form"><label for="vf-name">Your name <span class="vfs-small">(optional for returning customers)</span></label><input id="vf-name" name="name" autocomplete="name" maxlength="80"><label for="vf-email">Email address</label><input id="vf-email" name="email" type="email" autocomplete="email" required maxlength="254"><div id="vf-account-captcha"></div><button class="vfs-button" type="submit" disabled>Send verification code</button><a class="vfs-link vfs-small" href="signin-help.html">Can’t sign in?</a></form>
<form id="vf-code-form" class="vfs-form" hidden><label for="vf-code">Verification code</label><input id="vf-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required><p class="vfs-small">Enter the six-digit code from your email. It expires after ten minutes.</p><button class="vfs-button" type="submit">Verify and sign in</button><button class="vfs-link" type="button" id="vf-change-email">Use a different email</button></form>
<div id="vf-account-home" hidden><div id="vf-tier-card" class="vfs-tier vfs-tier-free"><span class="vfs-avatar" id="vf-avatar" aria-hidden="true"></span><div><p id="vf-profile" class="vfs-tier-name"></p><p id="vf-profile-sub" class="vfs-small"></p><span id="vf-plan-badge" class="vfs-badge">Free</span></div><p id="vf-plan-line" class="vfs-tier-line vfs-small"></p></div><details id="vf-profile-edit" class="vfs-details"><summary>Edit profile</summary><form id="vf-profile-form" class="vfs-form"><label for="vf-p-name">Name</label><input id="vf-p-name" name="name" autocomplete="name" maxlength="80"><label for="vf-p-business">Business</label><input id="vf-p-business" name="business" autocomplete="organization" maxlength="160"><label for="vf-p-phone">Phone</label><input id="vf-p-phone" name="phone" type="tel" autocomplete="tel" maxlength="40"><p class="vfs-small">To change your sign-in email, contact us.</p><button class="vfs-button" type="submit">Save profile</button></form></details><section id="vf-features" class="vfs-features" aria-labelledby="vf-features-title"><h3 id="vf-features-title">What your plan includes</h3><div id="vf-features-body" aria-live="polite"></div></section><section id="vf-billing" class="vfs-billing" aria-labelledby="vf-billing-title" hidden><h3 id="vf-billing-title">Manage subscription</h3><div id="vf-billing-body" aria-live="polite"></div></section><details id="vf-history" class="vfs-details"><summary>Plan history</summary><div id="vf-history-body" aria-live="polite"></div></details><h3>Your submitted requests</h3><div id="vf-requests"></div><section id="vf-close" class="vfs-close" aria-labelledby="vf-close-title"><h3 id="vf-close-title">Your data and account</h3><p class="vfs-small">Download everything we hold about you, or close your account.</p><div class="vfs-close-actions"><button class="vfs-button vfs-secondary" id="vf-export" type="button">Download my data</button><button class="vfs-button vfs-secondary" id="vf-close-start" type="button">Close my account</button></div><div id="vf-close-body" aria-live="polite"></div></section><button class="vfs-button vfs-secondary" id="vf-logout" type="button">Sign out</button></div></section>
<section id="account-how" class="vfs-callout" data-vf-record="guide-accounts" data-vf-tags="account create sign login register verification email code captcha secure"><span class="vfs-kicker">How it works</span><h2>A code instead of a password.</h2><p>Enter your email, or continue with Google, and confirm you are human. We email you a six-digit code that works once and expires after ten minutes. Entering it signs you in, and creates your account the first time.</p><p>Your account shows the requests you have sent us and, if you have a plan, your billing. Signing out ends your session on this device.</p><a class="vfs-link" href="contact.html">Prepare a project request ↗</a></section></div></div></main>`;}
function signinHelp(root){return `<main id="main" class="vfs-main"><div class="vfs-shell">${subnav('account')}<section class="vfs-intro"><span class="vfs-kicker">Customer account</span><h1>Can’t sign in?</h1><p>Two ways back into your VFTech account. Neither needs a password.</p></section>
<div class="vfs-account-layout"><section class="vfs-card" aria-labelledby="vf-help-title"><h2 id="vf-help-title">Get a sign-in code</h2><p>Enter the email on your account. If there’s an account for it, we email you a six-digit code.</p><p class="vfs-small">Signed up with Google? Use Continue with Google on the <a href="account.html">sign-in page</a>. It opens the same account as your email.</p><p id="vf-help-status" class="vfs-status" role="status">Account help is not switched on yet.</p><form id="vf-help-form" class="vfs-form"><label for="vf-help-email">Email address</label><input id="vf-help-email" name="email" type="email" autocomplete="email" required maxlength="254"><div id="vf-help-captcha"></div><button class="vfs-button" type="submit" disabled>Send a code</button></form>
<form id="vf-help-code" class="vfs-form" hidden><label for="vf-help-code-input">Verification code</label><input id="vf-help-code-input" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required><p class="vfs-small">The code expires after ten minutes and works once.</p><button class="vfs-button" type="submit">Verify and sign in</button></form></section>
<section class="vfs-card" aria-labelledby="vf-recover-title"><h2 id="vf-recover-title">Lost access to your email?</h2><p>Tell us a new email you can use and something we can check. We verify it against our records before changing anything, then reply to the new address.</p><p id="vf-recover-status" class="vfs-status" role="status" hidden></p><form id="vf-recover-form" class="vfs-form"><label for="vf-r-name">Your name</label><input id="vf-r-name" name="name" autocomplete="name" required maxlength="80"><label for="vf-r-old">The email on your account</label><input id="vf-r-old" name="oldEmail" type="email" required maxlength="254"><label for="vf-r-new">A new email you can use now</label><input id="vf-r-new" name="newEmail" type="email" autocomplete="email" required maxlength="254"><p class="vfs-small">Give at least one of these so we can check it’s you:</p><label for="vf-r-invoice">An invoice number <span class="vfs-small">(from a VFTech invoice or receipt)</span></label><input id="vf-r-invoice" name="invoice" maxlength="60"><label for="vf-r-card">Last four digits of the card on file</label><input id="vf-r-card" name="cardLast4" inputmode="numeric" pattern="[0-9]{4}" maxlength="4"><label for="vf-r-phone">The phone number on your profile</label><input id="vf-r-phone" name="phone" type="tel" autocomplete="tel" maxlength="40"><label for="vf-r-message">Anything else <span class="vfs-small">(optional)</span></label><textarea id="vf-r-message" name="message" rows="3" maxlength="2000"></textarea><div id="vf-recover-captcha"></div><button class="vfs-button" type="submit" disabled>Send recovery request</button></form></section></div></div></main>`;}
function terms(root){return `<main id="main" class="vfs-main"><div class="vfs-shell vfs-legal">
<header class="vfs-legal-head">
<span class="vfs-kicker">Legal</span>
<h1>Terms of Service</h1>
<p class="vfs-legal-meta">VF Associates, LLC, doing business as VFTech &middot; Version 1.0 &middot; Effective November 13, 2026</p>
<p>Please read these Terms carefully. They form a binding agreement between you and VF Associates, LLC. You accept them when you create an account and each time you subscribe to, upgrade or downgrade a plan, or buy a service through this website.</p>
</header>
<nav class="vfs-legal-toc" aria-label="Contents"><h2>Contents</h2><ol>
<li><a href="#t1">Agreement</a></li><li><a href="#t2">Acceptance and changes</a></li><li><a href="#t3">Your account</a></li><li><a href="#t4">Definitions</a></li><li><a href="#t5">What each plan covers</a></li><li><a href="#t6">Third-party services and costs</a></li><li><a href="#t7">Fees, renewal and cancellation</a></li><li><a href="#t8">Payment</a></li><li><a href="#t9">Late payment, suspension and closure</a></li><li><a href="#t10">Builds and quoted work</a></li><li><a href="#t11">Ownership</a></li><li><a href="#t12">Access you give us</a></li><li><a href="#t13">AI-assisted work</a></li><li><a href="#t14">Acceptable use</a></li><li><a href="#t15">Confidentiality and privacy</a></li><li><a href="#t16">Warranties and disclaimers</a></li><li><a href="#t17">Limitation of liability</a></li><li><a href="#t18">Indemnity</a></li><li><a href="#t19">Closing your account and termination</a></li><li><a href="#t20">Governing law and disputes</a></li><li><a href="#t21">Notices and electronic records</a></li><li><a href="#t22">General</a></li><li><a href="#t23">Contact</a></li>
</ol></nav>

<section id="t1"><h2>1. Agreement</h2>
<p><span class="vfs-cl">1.1</span> These Terms of Service (&ldquo;Terms&rdquo;) are an agreement between you and VF Associates, LLC, a Washington limited liability company doing business as VFTech (&ldquo;VFTech&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;), located in King County, Washington. They govern your vftech.io account, any plan you subscribe to, and anything you buy through vftech.io.</p>
<p><span class="vfs-cl">1.2</span> Our services are offered to businesses. If you use them as an individual consumer, nothing in these Terms limits rights you have under consumer protection law that cannot be waived.</p></section>

<section id="t2"><h2>2. Acceptance and changes</h2>
<p><span class="vfs-cl">2.1</span> You accept these Terms when you create an account. Each time you subscribe to, upgrade or downgrade a plan, or buy a service, you accept the Terms then in effect, including the section for that plan. We record the version you accepted, the plan or service, and the date and time.</p>
<p><span class="vfs-cl">2.2</span> We may update these Terms. For material changes we will email you at least 30 days before they take effect, and you may cancel before then. Continuing to use a plan after the effective date means you accept the update.</p></section>

<section id="t3"><h2>3. Your account</h2>
<p><span class="vfs-cl">3.1</span> You must give us accurate information and keep it current.</p>
<p><span class="vfs-cl">3.2</span> You are responsible for activity under your account and for keeping access to the email address you sign in with. Tell us promptly at <a href="mailto:kevinvf@vftech.io">kevinvf@vftech.io</a> if you believe someone else has accessed your account.</p>
<p><span class="vfs-cl">3.3</span> You must be at least 18 years old and authorized to accept these Terms on behalf of your business. Each sign-in is for one person.</p></section>

<section id="t4"><h2>4. Definitions</h2>
<p><span class="vfs-cl">4.1</span> <strong>Business hours</strong> means Monday to Friday, 9:00 a.m. to 5:00 p.m. Pacific time, excluding US federal holidays.</p>
<p><span class="vfs-cl">4.2</span> <strong>Response time</strong> means the time until a person replies to your request with a next step. It is not the time to complete the work.</p>
<p><span class="vfs-cl">4.3</span> <strong>Change hours</strong> means staff time spent on changes you request, tracked in 15-minute increments. Change hours reset each billing month, do not roll over, and have no cash value. Work beyond your included hours is quoted first and billed at $250 per hour only if you approve it.</p>
<p><span class="vfs-cl">4.4</span> <strong>Your website</strong> means the website or system named in your account for your plan.</p>
<p><span class="vfs-cl">4.5</span> <strong>Backups</strong> means copies of your website&rsquo;s code, content, database and configuration on the systems we manage. Backups are taken daily and kept for 30 days, so your website can be restored to how it was on any day in the previous 30 days. Backups do not include email mailboxes, files on your own computers, or data held only in third-party services.</p></section>

<section id="t5"><h2>5. What each plan covers</h2>
<h3>5.1 Free</h3>
<p>Free is an account, not a service plan.</p>
<div class="vfs-table-wrap"><table class="vfs-legal-table"><thead><tr><th scope="col">We will</th><th scope="col">We will not</th></tr></thead><tbody>
<tr><td>Keep your account, request history and invoices</td><td>Host, maintain, monitor, back up, secure or fix any website or system</td></tr>
<tr><td>Answer questions about our services, typically within 48 to 72 hours (a typical time, not a guarantee)</td><td>Provide technical support, emergency help or any response-time commitment</td></tr>
<tr><td>Sell fixed-price builds and quote other work</td><td>Perform any work without a separate purchase or signed quote</td></tr>
</tbody></table></div>

<h3>5.2 Essentials ($350 per month or $3,500 per year)</h3>
<div class="vfs-table-wrap"><table class="vfs-legal-table"><thead><tr><th scope="col">We will</th><th scope="col">We will not</th></tr></thead><tbody>
<tr><td>Host your website, on accounts in your name where the provider allows</td><td>Absorb third-party costs; these are billed to you as described in section 6</td></tr>
<tr><td>Manage your domain settings and SSL certificate</td><td>Write content, design new pages or add features beyond your change hours</td></tr>
<tr><td>Back up your website daily and keep backups for 30 days</td><td>Guarantee recovery of data changed outside the systems we manage</td></tr>
<tr><td>Monitor uptime and respond to outages we detect</td><td>Guarantee uptime or provide service credits, unless agreed in writing</td></tr>
<tr><td>Apply security and dependency updates</td><td>Fix problems caused by changes made by you or other vendors, except as paid work</td></tr>
<tr><td>Handle up to 1 hour of changes per month</td><td>Carry unused hours into the next month</td></tr>
<tr><td>Respond within 3 business days</td><td>Respond outside business hours</td></tr>
</tbody></table></div>

<h3>5.3 Standard ($750 per month or $7,500 per year)</h3>
<p>Everything in Essentials, plus:</p>
<div class="vfs-table-wrap"><table class="vfs-legal-table"><thead><tr><th scope="col">We will</th><th scope="col">We will not</th></tr></thead><tbody>
<tr><td>Cover the third-party services we use to manage your website, as described in section 6</td><td>Cover transaction fees, usage-based charges or your own business software</td></tr>
<tr><td>Provide the AI update assistant; a person reviews and approves every change before it is published</td><td>Publish AI-generated changes without human review</td></tr>
<tr><td>Handle up to 3 hours of changes per month</td><td>Carry unused hours into the next month</td></tr>
<tr><td>Respond by the next business day</td><td>Respond outside business hours</td></tr>
<tr><td>Send a monthly traffic and lead report</td><td>Guarantee traffic, rankings or leads</td></tr>
</tbody></table></div>

<h3>5.4 Priority ($1,500 per month or $15,000 per year)</h3>
<p>Everything in Standard, plus:</p>
<div class="vfs-table-wrap"><table class="vfs-legal-table"><thead><tr><th scope="col">We will</th><th scope="col">We will not</th></tr></thead><tbody>
<tr><td>Handle up to 8 hours of changes per month</td><td>Carry unused hours into the next month</td></tr>
<tr><td>Respond within 4 business hours</td><td>Provide 24/7 coverage, unless agreed in writing</td></tr>
<tr><td>Carry out the quarterly technology and search review in section 5.5</td><td>Guarantee search rankings or results</td></tr>
</tbody></table></div>

<h3>5.5 Priority quarterly technology and search review</h3>
<p>Each quarter we review your website against the following checklist, apply the updates that fit within your plan, and send you a short summary. Larger changes are quoted first.</p>
<ol class="vfs-legal-list">
<li>Technology updates and upgrades, including improvements to the shared components and modules we maintain across our client websites.</li>
<li>Current AI and large-language-model capabilities that would benefit your website or its tools.</li>
<li>Search optimization: page titles and descriptions, structured data, sitemaps, indexing and search-console issues.</li>
<li>Performance: page speed and loading on mobile and desktop.</li>
<li>Content health: outdated pages, broken links and missing images.</li>
<li>Accessibility spot-check of key pages.</li>
<li>Security: certificates, dependencies, and a review of who has access to your accounts.</li>
<li>Lead capture: forms, routing and analytics working end to end.</li>
<li>Live-site requirements: certificates, privacy and cookie notices, and the accounts and subscriptions your website relies on.</li>
</ol>

<h3>5.6 Not covered by any plan</h3>
<p>Unless agreed in writing, no plan covers: new websites, redesigns or new features (quoted separately); outages or policy changes of third-party services, although we will help restore service; email deliverability and mailbox setup; your devices and networks; legal advice, including certifying accessibility, privacy or other legal compliance; or recovering access to third-party accounts you own and control.</p></section>

<section id="t6"><h2>6. Third-party services and costs</h2>
<p><span class="vfs-cl">6.1</span> Your website relies on third-party services, for example hosting, GitHub, Cloudflare, HubSpot and Stripe, each under its own terms. We are not responsible for their outages, pricing or policy changes, but we will work with you to keep your website running.</p>
<p><span class="vfs-cl">6.2</span> <strong>Standard and Priority:</strong> the subscription costs of the third-party services we use to build, host and manage your website are included in your plan price.</p>
<p><span class="vfs-cl">6.3</span> <strong>Essentials and quoted work:</strong> those costs are billed to you at cost, or paid by you directly to the provider.</p>
<p><span class="vfs-cl">6.4</span> No plan includes transaction fees (for example payment-processing fees on your own sales), usage charges above normal levels, or software your business uses for its own operations.</p></section>

<section id="t7"><h2>7. Fees, renewal and cancellation</h2>
<p><span class="vfs-cl">7.1</span> Prices are those shown on vftech.io when you subscribe, in US dollars, charged in advance each month or each year.</p>
<p><span class="vfs-cl">7.2</span> <strong>Your plan renews automatically</strong> at the end of each billing period until you cancel. For annual plans, we email you a reminder at least 30 days before renewal.</p>
<p><span class="vfs-cl">7.3</span> You may cancel online at any time from your account. Your plan remains active until the end of the period you have paid for, then stops. We do not refund partial periods, except where required by law.</p>
<p><span class="vfs-cl">7.4</span> Upgrades take effect immediately, and the prorated difference is charged at once. Downgrades take effect at the next renewal.</p>
<p><span class="vfs-cl">7.5</span> Price changes take effect at your next renewal after at least 30 days&rsquo; notice by email.</p>
<p><span class="vfs-cl">7.6</span> Prices exclude taxes. We add sales tax where required, including Washington sales tax on website development and support services.</p></section>

<section id="t8"><h2>8. Payment</h2>
<p><span class="vfs-cl">8.1</span> Payments are processed by Stripe. We never see or store your full card or bank account number.</p>
<p><span class="vfs-cl">8.2</span> By subscribing, you authorize us to charge your payment method for each renewal and for changes you approve. Bank debits follow the authorization you give at checkout.</p>
<p><span class="vfs-cl">8.3</span> A paid plan must have a valid payment method on file at all times. You may not remove your last payment method while a paid plan is active.</p></section>

<section id="t9"><h2>9. Late payment, suspension and closure</h2>
<p><span class="vfs-cl">9.1</span> If a payment fails, we and Stripe will retry it and notify you by email.</p>
<p><span class="vfs-cl">9.2</span> From day 7 after a failed payment, you must update your payment method and pay the amount owed before using your account, and plan services are paused.</p>
<p><span class="vfs-cl">9.3</span> From day 30, your account is suspended and plan services stop.</p>
<p><span class="vfs-cl">9.4</span> On day 90, your plan is cancelled and your account is closed.</p>
<p><span class="vfs-cl">9.5</span> Paying everything owed before day 90 restores your plan immediately.</p>
<p><span class="vfs-cl">9.6</span> Please contact us before disputing a charge with your bank. While a dispute is open, your account is limited to billing.</p></section>

<section id="t10"><h2>10. Builds and quoted work</h2>
<p><span class="vfs-cl">10.1</span> Fixed-price builds bought online include what their description lists at the time of purchase. Other work is performed under a written quote or statement of work, which controls if it conflicts with these Terms.</p></section>

<section id="t11"><h2>11. Ownership</h2>
<p><span class="vfs-cl">11.1</span> You own your content, your domain and accounts set up in your name.</p>
<p><span class="vfs-cl">11.2</span> Once you have paid in full, you own the work we create specifically for you.</p>
<p><span class="vfs-cl">11.3</span> We retain ownership of our pre-existing tools, templates, shared components and know-how, and grant you a perpetual license to use any of them that are built into your work.</p>
<p><span class="vfs-cl">11.4</span> We show your work in our portfolio only with your permission.</p></section>

<section id="t12"><h2>12. Access you give us</h2>
<p><span class="vfs-cl">12.1</span> You give us the access we need to provide your plan, and we use it only for that purpose. When your plan ends, we return or transfer the credentials we hold, remove our own access, and provide a final backup if you request it within 30 days.</p></section>

<section id="t13"><h2>13. AI-assisted work</h2>
<p><span class="vfs-cl">13.1</span> We may use AI tools to draft changes. A person reviews and approves every change before it is published. We do not use your confidential information to train AI models.</p></section>

<section id="t14"><h2>14. Acceptable use</h2>
<p><span class="vfs-cl">14.1</span> You may not use our services for anything unlawful, for malware or spam, or to publish material that infringes the rights of others. We may refuse or stop work that would.</p></section>

<section id="t15"><h2>15. Confidentiality and privacy</h2>
<p><span class="vfs-cl">15.1</span> Each party will keep the other&rsquo;s non-public business information confidential and use it only for this relationship.</p>
<p id="privacy"><span class="vfs-cl">15.2</span> We keep your name, email address, the requests you send us, and your plan and invoice status, in order to provide the service. We do not sell your data. Stripe holds your payment details under its own privacy policy. To ask about or remove your data, <a href="${root}contact.html">contact us</a>.</p></section>

<section id="t16"><h2>16. Warranties and disclaimers</h2>
<p><span class="vfs-cl">16.1</span> We will perform our services in a professional and workmanlike manner. Except as stated in these Terms and to the extent permitted by law, our services are provided &ldquo;as is&rdquo;, without other warranties, and we do not guarantee particular results such as traffic, rankings or leads.</p></section>

<section id="t17"><h2>17. Limitation of liability</h2>
<p><span class="vfs-cl">17.1</span> To the extent permitted by law, neither party is liable for indirect, incidental, special or consequential damages, or for lost profits, and our total liability for any claim is limited to the fees you paid us in the 12 months before the claim arose.</p></section>

<section id="t18"><h2>18. Indemnity</h2>
<p><span class="vfs-cl">18.1</span> You will defend us against third-party claims arising from content or instructions you provide. We will defend you against third-party claims that original work we created for you infringes another person&rsquo;s rights.</p></section>

<section id="t19"><h2>19. Closing your account and termination</h2>
<p><span class="vfs-cl">19.1</span> You may close your account from your account page. A paid plan remains active until the end of the period you have paid for, and the account closes then, unless you choose to close it immediately, which forfeits the remaining time without refund.</p>
<p><span class="vfs-cl">19.2</span> We may terminate these Terms if you materially breach them and do not cure the breach within 15 days of our notice, or immediately for unlawful use.</p>
<p><span class="vfs-cl">19.3</span> Provisions that by their nature should survive termination, including payment obligations, ownership, confidentiality, limitation of liability and dispute resolution, survive.</p></section>

<section id="t20"><h2>20. Governing law and disputes</h2>
<p><span class="vfs-cl">20.1</span> These Terms are governed by the laws of the State of Washington, without regard to its conflict-of-laws rules.</p>
<p><span class="vfs-cl">20.2</span> Before filing a claim, each party will try to resolve the dispute informally for 30 days after written notice.</p>
<p><span class="vfs-cl">20.3</span> Any lawsuit must be brought in the state or federal courts located in King County, Washington, and each party consents to their jurisdiction. Either party may use small claims court where eligible.</p></section>

<section id="t21"><h2>21. Notices and electronic records</h2>
<p><span class="vfs-cl">21.1</span> You agree that we may send notices, invoices and receipts by email, and that accepting these Terms electronically has the same effect as a signature.</p></section>

<section id="t22"><h2>22. General</h2>
<p><span class="vfs-cl">22.1</span> These Terms, together with any quote or statement of work, are the entire agreement between the parties on their subject. If any provision is unenforceable, the remainder stays in effect. Neither party is liable for delays caused by events beyond its reasonable control. Failure to enforce a provision is not a waiver. You may not assign these Terms without our consent. The parties are independent contractors.</p></section>

<section id="t23"><h2>23. Contact</h2>
<p>VF Associates, LLC, doing business as VFTech &middot; King County, Washington &middot; <a href="mailto:kevinvf@vftech.io">kevinvf@vftech.io</a> &middot; <a href="tel:+14257615502">425-761-5502</a></p></section>
</div></main>`;}
for(const [i,folder] of folders.entries()){
  const number=i+1,root=number===1?'':'../';
  for(const [file,title,desc,main] of [['features.html','Features and pricing','Try dashboards, charts, dynamic data and customer account examples. Compare VFTech’s published build tiers and maintenance plans.',features(root)],['account.html','Customer account','Create a VFTech customer account or sign in with an email verification code when live delivery is enabled.',account(root)],['signin-help.html','Can’t sign in?','Get a one-time sign-in code for your VFTech account, or ask us to recover it if you lost access to your email.',signinHelp(root)],['terms.html','Terms of Service','Terms of Service for VFTech plans, builds and accounts: what each plan covers, billing, renewal, cancellation and Washington law.',terms(root)]]){
    let html=readFileSync(`${folder}/about.html`,'utf8');
    html=html.replace(/<main\b[\s\S]*?<\/main>/,main).replace(' aria-current="page"','');
    if(html.includes('data-vf-motion-suite'))html=html.replace('<main id="main"','<main id="main" tabindex="-1"');
    html=html.replaceAll('About · VFTech',`${title} · VFTech`).replace(/(<meta (?:name="description"|property="og:description"|name="twitter:description") content=")[^"]*(")/g,`$1${esc(desc)}$2`);
    html=html.replaceAll('/about.html',`/${file}`).replace(/<style>[\s\S]*?<\/style>/,'');
    if(!html.includes('services.css'))html=html.replace('</head>','<link rel="stylesheet" href="services.css">\n</head>');
    if(!html.includes('feature-showcase.js'))html=html.replace('</body>','<script src="feature-showcase.js" defer></script>\n</body>');
    save(`${folder}/${file}`,html);
  }
}
console.log(check?'Service pages and catalog are current.':'Generated service pages and catalog.');
