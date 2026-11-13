// Site delivery only. The local chatbot has no endpoint and never calls this Worker.
import catalog from './catalog.json' with {type:'json'};
import {billing} from './billing.js';
import {accounts} from './account.js';
import {closing} from './closing.js';
import {twoFactor} from './twofactor.js';
import {admin} from './admin.js';
const COOKIE='__Host-vftech-session',SESSION_SECONDS=7*24*3600,CODE_SECONDS=600,MFA_SECONDS=600;
const encoder=new TextEncoder();
const TOPICS=new Set(['Website rebuild','Platform migration','AI integration','Support plan','Advisory or fractional leadership','Not sure yet']);
const PLAN_IDS=new Set([...catalog.builds,...catalog.plans].map(p=>p.id));
class HTTPError extends Error{constructor(status,message){super(message);this.status=status;}}
function json(value,status=200,headers={}){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin',...headers}});}
function now(){return Math.floor(Date.now()/1000);}
function field(value,name,max,required=false){if(typeof value!=='string')value='';value=value.trim();if(value.length>max||(required&&!value))throw new HTTPError(400,`Check ${name}.`);return value;}
function email(value){const text=field(value,'your email address',254,true).toLowerCase();if(!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(text)||/[\r\n]/.test(text))throw new HTTPError(400,'Enter a valid email address.');return text;}
function origin(env){try{const url=new URL(env.SITE_URL);if(url.protocol!=='https:' && !(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))return '';return url.origin;}catch{return '';}}
function ready(env){const base=Boolean(env.DB&&origin(env)&&env.RESEND_API_KEY&&env.TURNSTILE_SECRET_KEY&&env.TURNSTILE_SITE_KEY&&env.TURNSTILE_HOSTNAME&&env.EMAIL_FROM&&!/[\r\n]/.test(env.EMAIL_FROM));return {contactEnabled:Boolean(base&&env.CONTACT_TO),accountsEnabled:Boolean(base&&env.SESSION_SECRET?.length>=32)};}
function config(env){return {apiBase:'/api',...ready(env),billingEnabled:Boolean(ready(env).accountsEnabled&&bills.enabled(env)&&bills.live(env)),billingTest:Boolean(ready(env).accountsEnabled&&bills.enabled(env)&&!bills.live(env)),googleEnabled:oauthReady(env,'google'),microsoftEnabled:oauthReady(env,'microsoft'),turnstileSiteKey:env.TURNSTILE_SITE_KEY||''};}
function requireReady(env,kind){if(!ready(env)[kind])throw new HTTPError(503,'Live delivery is not configured yet. Please use the request preview.');}
function sameOrigin(request,env){const expected=origin(env);if(!expected||new URL(request.url).origin!==expected||request.headers.get('Origin')!==expected)throw new HTTPError(403,'Submit this form from the VFTech site.');}
async function body(request){if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw new HTTPError(415,'Send a JSON request.');if(Number(request.headers.get('Content-Length'))>16384)throw new HTTPError(413,'This request is too large.');const reader=request.body?.getReader();if(!reader)throw new HTTPError(400,'The request is empty.');let size=0,chunks=[];for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16384){await reader.cancel();throw new HTTPError(413,'This request is too large.');}chunks.push(value);}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}try{const result=JSON.parse(new TextDecoder().decode(bytes));if(!result||typeof result!=='object'||Array.isArray(result))throw Error();return result;}catch{throw new HTTPError(400,'The request could not be read.');}}
function random(){const bytes=crypto.getRandomValues(new Uint8Array(32));return [...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');}
function code(){const n=new Uint32Array(1);do{crypto.getRandomValues(n);}while(n[0]>=4294000000);return String(n[0]%1000000).padStart(6,'0');}
async function digest(text){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function hmac(env,text){const key=await crypto.subtle.importKey('raw',encoder.encode(env.SESSION_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
function equal(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
async function limit(env,label,value,max,seconds){const timestamp=now(),bucket=Math.floor(timestamp/seconds),key=await digest(`${label}:${value}:${bucket}`);const row=await env.DB.prepare('INSERT INTO rate_limits (key,hits,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET hits=hits+1 RETURNING hits').bind(key,(bucket+1)*seconds).first();if(row.hits>max)throw new HTTPError(429,'Too many attempts. Please try again later.');}
async function captcha(request,env,input,action){const token=field(input.turnstileToken,'verification',2048,true);try{const fields={secret:env.TURNSTILE_SECRET_KEY,response:token};const ip=request.headers.get('CF-Connecting-IP');if(ip)fields.remoteip=ip;const response=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',body:new URLSearchParams(fields),signal:AbortSignal.timeout(8000)});if(!response.ok)throw Error();const result=await response.json();if(result.success!==true||result.hostname!==env.TURNSTILE_HOSTNAME||result.action!==action)throw new HTTPError(400,'Verification failed. Please try the CAPTCHA again.');}catch(error){if(error instanceof HTTPError)throw error;throw new HTTPError(503,'Verification is temporarily unavailable. Please try again.');}}
async function send(env,payload,key){try{const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({from:env.EMAIL_FROM,...payload}),signal:AbortSignal.timeout(10000)});if(!response.ok||!(await response.json()).id)throw Error();}catch{throw new HTTPError(502,'Email delivery could not be accepted. Please try again.');}}
function uuid(value,name){if(typeof value!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))throw new HTTPError(400,`Check ${name}.`);return value.toLowerCase();}
async function contact(request,env,input){
  requireReady(env,'contactEnabled');if(input.website)throw new HTTPError(400,'The request could not be verified.');
  const key=uuid(input.idempotencyKey,'the request identifier');
  const data={name:field(input.name,'your name',80,true),email:email(input.email),business:field(input.business,'the business name',160),phone:field(input.phone,'the phone number',40),times:field(input.times,'your availability',300),message:field(input.message,'your message',4000,true),planId:field(input.planId,'the selected plan',40),topics:input.topics??[]};
  if(data.planId&&!PLAN_IDS.has(data.planId))throw new HTTPError(400,'Choose a published plan.');if(!Array.isArray(data.topics)||data.topics.length>6||data.topics.some(topic=>!TOPICS.has(topic)))throw new HTTPError(400,'Choose a listed topic.');
  const hash=await digest(JSON.stringify(data));
  const prior=await env.DB.prepare('SELECT id,body_hash,status FROM contact_requests WHERE idempotency_key=?').bind(key).first();
  if(prior){if(!equal(prior.body_hash,hash))throw new HTTPError(409,'This request identifier has already been used.');if(prior.status==='sent')return json({accepted:true,requestId:prior.id});if(prior.status==='pending')throw new HTTPError(409,'This request is still processing. Please wait before retrying.');}
  await limit(env,'contact-ip',request.headers.get('CF-Connecting-IP')||'unknown',5,3600);await captcha(request,env,input,'contact');
  const id=prior?.id||crypto.randomUUID();
  const claim=prior?await env.DB.prepare("UPDATE contact_requests SET status='pending' WHERE id=? AND status='failed'").bind(id).run():await env.DB.prepare("INSERT OR IGNORE INTO contact_requests (id,idempotency_key,body_hash,email,name,business,phone,topics,times,message,plan_id,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?)").bind(id,key,hash,data.email,data.name,data.business,data.phone,JSON.stringify(data.topics),data.times,data.message,data.planId,now()).run();
  if(claim.meta.changes!==1)throw new HTTPError(409,'This request is already processing.');
  // Priority flagging (spec phase 4): the plan on file for this email, and whether the sender was signed in as it.
  const onFile=await planOnFile(request,env,data.email);
  try{const selected=[...catalog.builds,...catalog.plans].find(p=>p.id===data.planId);await send(env,{to:env.CONTACT_TO.split(",").map(s=>s.trim()).filter(Boolean),reply_to:data.email,subject:`${onFile.tier==='priority'?'[Priority] ':''}VFTech project request ${id}`,text:[`Request: ${id}`,`Name: ${data.name}`,`Email: ${data.email}`,`Plan on file: ${onFile.label}`,`Business: ${data.business||'—'}`,`Phone: ${data.phone||'—'}`,`Topics: ${data.topics.join(', ')||'Not selected'}`,`Plan: ${selected?`${selected.name} (${selected.price})`:'Not selected'}`,`Availability: ${data.times||'—'}`,'',data.message].join('\n')},`contact-${id}`);await env.DB.prepare("UPDATE contact_requests SET status='sent' WHERE id=?").bind(id).run();return json({accepted:true,requestId:id},201);}catch(error){await env.DB.prepare("UPDATE contact_requests SET status='failed' WHERE id=?").bind(id).run();throw error;}
}
async function planOnFile(request,env,address){
  try{const owner=await env.DB.prepare('SELECT id FROM customers WHERE email=?').bind(address).first();if(!owner)return {tier:null,label:'No account'};
    const plan=await acct.planFor(env,owner.id);let signed=false;try{signed=(await session(request,env))?.customer?.id===owner.id;}catch{}
    return {tier:plan.tier,label:`${plan.name}${plan.interval==='year'?' (annual)':''}${plan.standing&&plan.standing!=='ok'?`, ${plan.standing.replace('_',' ')}`:''} · ${signed?'signed in':'not signed in, same email'}`};}
  catch(error){console.error('plan on file',error?.message);return {tier:null,label:'Unknown'};}
}
async function requestCode(request,env,input){
  requireReady(env,'accountsEnabled');if(input.website)throw new HTTPError(400,'The request could not be verified.');const address=email(input.email),name=field(input.name,'your name',80);
  await limit(env,'code-ip',request.headers.get('CF-Connecting-IP')||'unknown',10,3600);await limit(env,'code-email',address,3,900);await captcha(request,env,input,'account');
  // existingOnly (Can't sign in? page): send a code only to an existing account, and answer exactly as if one was sent,
  // so the page never reveals which emails have accounts.
  if(input.existingOnly===true&&!(await env.DB.prepare('SELECT 1 AS found FROM customers WHERE email=?').bind(address).first()))return json({challengeId:crypto.randomUUID(),expiresIn:CODE_SECONDS},201);
  const id=crypto.randomUUID(),value=code(),timestamp=now(),hash=await hmac(env,`code:${id}:${address}:${value}`);
  await env.DB.prepare('INSERT INTO auth_challenges (id,email,name,code_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)').bind(id,address,name,hash,timestamp+CODE_SECONDS,timestamp).run();
  try{await send(env,{to:[address],subject:'Your VFTech verification code',text:`Your VFTech verification code is ${value}.\n\nIt expires in ten minutes and can be used once. If you did not request it, ignore this email. Never share your code.`},`code-${id}`);}catch(error){await env.DB.prepare('DELETE FROM auth_challenges WHERE id=?').bind(id).run();throw error;}
  return json({challengeId:id,expiresIn:CODE_SECONDS},201);
}
async function recovery(request,env,input){
  requireReady(env,'accountsEnabled');if(input.website)throw new HTTPError(400,'The request could not be verified.');
  const data={oldEmail:email(input.oldEmail),newEmail:email(input.newEmail),name:field(input.name,'your name',80,true),invoice:field(input.invoice,'the invoice number',60),cardLast4:field(input.cardLast4,'the last four digits',4),phone:field(input.phone,'the phone number',40),message:field(input.message,'your message',2000)};
  if(data.cardLast4&&!/^[0-9]{4}$/.test(data.cardLast4))throw new HTTPError(400,'Enter the last four digits of the card, or leave it empty.');
  if(data.oldEmail===data.newEmail)throw new HTTPError(400,'Enter a different email address that you can use now.');
  if(!data.invoice&&!data.cardLast4&&!data.phone)throw new HTTPError(400,'Give at least one detail we can check: an invoice number, the last four digits of your card, or your phone number.');
  await limit(env,'recovery-ip',request.headers.get('CF-Connecting-IP')||'unknown',5,3600);await limit(env,'recovery-email',data.oldEmail,3,86400);await captcha(request,env,input,'account');
  const id=crypto.randomUUID(),found=await env.DB.prepare('SELECT id FROM customers WHERE email=?').bind(data.oldEmail).first();
  await env.DB.prepare('INSERT INTO recovery_requests (id,old_email,new_email,name,invoice,card_last4,phone,message,account_found,ip_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(id,data.oldEmail,data.newEmail,data.name,data.invoice,data.cardLast4,data.phone,data.message,found?1:0,await hmac(env,'ip:'+(request.headers.get('CF-Connecting-IP')||'unknown')),now()).run();
  await send(env,{to:env.CONTACT_TO.split(',').map(s=>s.trim()).filter(Boolean),subject:`Account recovery request: ${data.oldEmail}`,text:[`Request: ${id}`,`Account on file for the old email: ${found?'yes':'NO, nothing to recover'}`,`Name: ${data.name}`,`Old email (lost access): ${data.oldEmail}`,`New email: ${data.newEmail}`,`Invoice number: ${data.invoice||'—'}`,`Card last four: ${data.cardLast4||'—'}`,`Phone: ${data.phone||'—'}`,'',data.message||'(no message)','','Verify at least one detail against Stripe and the profile before changing anything. Steps: backend/README.md, "Account recovery".'].join('\n')},`recovery-${id}`);
  return json({received:true},201);
}
async function verifyCode(request,env,input){
  requireReady(env,'accountsEnabled');const id=uuid(input.challengeId,'the verification request'),address=email(input.email),value=field(input.code,'the verification code',6,true);if(!/^\d{6}$/.test(value))throw new HTTPError(400,'Enter the six-digit code.');
  await limit(env,'verify-ip',request.headers.get('CF-Connecting-IP')||'unknown',30,900);
  const timestamp=now(),row=await env.DB.prepare('UPDATE auth_challenges SET attempts=attempts+1 WHERE id=? AND email=? AND consumed=0 AND expires_at>? AND attempts<5 RETURNING *').bind(id,address,timestamp).first();
  if(!row||!equal(row.code_hash,await hmac(env,`code:${id}:${address}:${value}`)))throw new HTTPError(400,'The code is invalid or expired. Request a new code.');const claimed=await env.DB.prepare('UPDATE auth_challenges SET consumed=1 WHERE id=? AND consumed=0 AND expires_at>?').bind(id,timestamp).run();if(claimed.meta.changes!==1)throw new HTTPError(400,'This code has already been used. Request a new code.');
  await env.DB.prepare('INSERT INTO customers (id,email,name,created_at) VALUES (?,?,?,?) ON CONFLICT(email) DO NOTHING').bind(crypto.randomUUID(),address,row.name,timestamp).run();
  const profile=await env.DB.prepare('SELECT id,email,name,closing_at AS closingAt FROM customers WHERE email=?').bind(address).first();
  const started=await startSession(env,profile.id);
  if(started.pending)return json({authenticated:false,twoFactor:true},200,{'Set-Cookie':started.cookie});
  return json({authenticated:true,customer:profile,csrfToken:await hmac(env,`csrf:${started.token}`),plan:await acct.planFor(env,profile.id)},200,{'Set-Cookie':started.cookie});
}
async function session(request,env){requireReady(env,'accountsEnabled');const token=(request.headers.get('Cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);if(!token||!/^[a-f0-9]{64}$/.test(token))return null;const customer=await env.DB.prepare('SELECT c.id,c.email,c.name,c.closing_at AS closingAt FROM sessions s JOIN customers c ON c.id=s.customer_id WHERE s.token_hash=? AND s.expires_at>? AND s.mfa_pending=0').bind(await digest(token),now()).first();return customer?{customer,token,csrfToken:await hmac(env,`csrf:${token}`)}:null;}
// Two-factor (backend/twofactor.js): with it on, any sign-in first makes a 10-minute session that only opens the code step.
function cookieToken(request){const token=(request.headers.get('Cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);return token&&/^[a-f0-9]{64}$/.test(token)?token:null;}
async function pendingSession(request,env){requireReady(env,'accountsEnabled');const token=cookieToken(request);if(!token)return null;const customer=await env.DB.prepare('SELECT c.id,c.email,c.name FROM sessions s JOIN customers c ON c.id=s.customer_id WHERE s.token_hash=? AND s.expires_at>? AND s.mfa_pending=1').bind(await digest(token),now()).first();return customer?{customer,token}:null;}
async function startSession(env,customerId,skipTwoFactor=false){const pending=!skipTwoFactor&&await mfa.enabledFor(env,customerId),token=random(),timestamp=now(),seconds=pending?MFA_SECONDS:SESSION_SECONDS;await env.DB.prepare('INSERT INTO sessions (token_hash,customer_id,expires_at,created_at,mfa_pending) VALUES (?,?,?,?,?)').bind(await digest(token),customerId,timestamp+seconds,timestamp,pending?1:0).run();return {token,pending,cookie:`${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}`};}
async function finishTwoFactor(request,env,input){const pending=await pendingSession(request,env);if(!pending)throw new HTTPError(401,'Your sign-in expired. Sign in again.');await limit(env,'2fa-ip',request.headers.get('CF-Connecting-IP')||'unknown',30,900);await mfa.verifySignIn(env,pending.customer,input);
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(pending.token)).run();const started=await startSession(env,pending.customer.id,true);const profile=await env.DB.prepare('SELECT id,email,name,closing_at AS closingAt FROM customers WHERE id=?').bind(pending.customer.id).first();
  return json({authenticated:true,customer:profile,csrfToken:await hmac(env,`csrf:${started.token}`),plan:await acct.planFor(env,profile.id)},200,{'Set-Cookie':started.cookie});}
async function cancelTwoFactor(request,env){const pending=await pendingSession(request,env);if(pending)await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(pending.token)).run();return json({authenticated:false},200,{'Set-Cookie':`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`});}
async function cleanup(env){if(!env.DB)return;const timestamp=now();await env.DB.batch([env.DB.prepare('DELETE FROM auth_challenges WHERE expires_at<=?').bind(timestamp),env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(timestamp),env.DB.prepare('DELETE FROM rate_limits WHERE expires_at<=?').bind(timestamp),env.DB.prepare('DELETE FROM contact_requests WHERE created_at<?').bind(timestamp-30*24*3600)]);}
// Subscriptions (backend/billing.js): signed-in customers only, CSRF-checked like logout.
const acct=accounts({HTTPError,json,now,catalog,field});
const bills=billing({HTTPError,json,now,origin,catalog,audit:acct,mail:send});
// Closing an account and downloading its data (backend/closing.js).
const mfa=twoFactor({HTTPError,json,now,hmac,digest,equal,send,limit,origin});
// Staff admin view (backend/admin.js) at /api/admin, behind Cloudflare Access.
const adm=admin({HTTPError,json,now,origin,catalog,send,stripe:bills.stripe,planFor:acct.planFor,meter:acct.meter,recordEvent:acct.recordEvent});
const shut=closing({HTTPError,json,now,hmac,code,equal,send,codeSeconds:CODE_SECONDS,stripe:bills.stripe,planFor:acct.planFor,recordEvent:acct.recordEvent});
async function ipHash(request,env){return hmac(env,'ip:'+(request.headers.get('CF-Connecting-IP')||'unknown'));}
async function signedIn(request,env,csrf){const active=await session(request,env);if(!active)throw new HTTPError(401,'Sign in to continue.');if(csrf&&!equal(request.headers.get('X-CSRF-Token'),active.csrfToken))throw new HTTPError(403,'Refresh your account page and try again.');return active;}
const OAUTH_COOKIE='__Host-vftech-oauth',OAUTH_SECONDS=600,MS_PERSONAL_TENANT='9188040d-6c67-4c5b-b112-36a304b66dad';
const PROVIDERS={google:{env:'GOOGLE',label:'Google',authorize:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token'},microsoft:{env:'MICROSOFT',label:'Microsoft',authorize:'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',token:'https://login.microsoftonline.com/common/oauth2/v2.0/token'}};
function oauthReady(env,name){const p=PROVIDERS[name];return Boolean(p&&ready(env).accountsEnabled&&env[`${p.env}_CLIENT_ID`]&&env[`${p.env}_CLIENT_SECRET`]);}
function base64url(bytes){return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
// The ID token comes straight from the provider's token endpoint over TLS, so its claims are read without re-checking the signature (OIDC Core 3.1.3.7).
function claims(token){const part=String(token||'').split('.')[1]||'';const text=atob(part.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-part.length%4)%4));return JSON.parse(new TextDecoder().decode(Uint8Array.from(text,c=>c.charCodeAt(0))));}
function landing(path,cookies){const headers=new Headers({'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});for(const cookie of cookies)headers.append('Set-Cookie',cookie);const href=path.replace(/&/g,'&amp;').replace(/"/g,'&quot;');return new Response(`<!doctype html><meta charset="utf-8"><title>Signing in</title><meta http-equiv="refresh" content="0;url=${href}"><script>location.replace(${JSON.stringify(path)})</script><p><a href="${href}">Continue to your VFTech account</a></p>`,{headers});}
async function oauthStart(request,env,name){if(!oauthReady(env,name))throw new HTTPError(404,'This sign-in option is not available.');await limit(env,'oauth-ip',request.headers.get('CF-Connecting-IP')||'unknown',30,900);
  const p=PROVIDERS[name],state=random(),verifier=random(),challenge=base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(verifier))));
  const target=new URL(p.authorize);target.search=new URLSearchParams({client_id:env[`${p.env}_CLIENT_ID`],redirect_uri:`${origin(env)}/api/auth/${name}/callback`,response_type:'code',scope:'openid email profile',state,code_challenge:challenge,code_challenge_method:'S256',prompt:'select_account'}).toString();
  const value=`${name}.${now()}.${state}.${verifier}`;
  return new Response(null,{status:302,headers:{Location:target.toString(),'Cache-Control':'no-store','Set-Cookie':`${OAUTH_COOKIE}=${value}.${await hmac(env,`oauth:${value}`)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${OAUTH_SECONDS}`}});
}
async function oauthCallback(request,env,name,url){const clear=`${OAUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  try{if(!oauthReady(env,name))throw new HTTPError(404,'This sign-in option is not available.');const p=PROVIDERS[name];
    if(url.searchParams.get('error'))throw new HTTPError(400,`${p.label} sign-in was cancelled.`);
    const raw=(request.headers.get('Cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(OAUTH_COOKIE+'='))?.slice(OAUTH_COOKIE.length+1)||'';
    const [saved,issued,state,verifier,mac]=raw.split('.'),value=`${saved}.${issued}.${state}.${verifier}`,code=url.searchParams.get('code')||'';
    if(!mac||saved!==name||!equal(mac,await hmac(env,`oauth:${value}`))||!(now()-Number(issued)<=OAUTH_SECONDS)||!equal(state,url.searchParams.get('state')||'')||!code||code.length>4096)throw new HTTPError(400,'Your sign-in expired. Please try again.');
    const response=await fetch(p.token,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:new URLSearchParams({client_id:env[`${p.env}_CLIENT_ID`],client_secret:env[`${p.env}_CLIENT_SECRET`],code,code_verifier:verifier,grant_type:'authorization_code',redirect_uri:`${origin(env)}/api/auth/${name}/callback`})});
    const tokens=await response.json().catch(()=>({}));if(!response.ok||!tokens.id_token)throw new HTTPError(502,`${p.label} could not confirm your sign-in. Please try again.`);
    const c=claims(tokens.id_token);if(c.aud!==env[`${p.env}_CLIENT_ID`])throw new HTTPError(400,`${p.label} could not confirm your sign-in. Please try again.`);
    // Google says whether the email is verified. Microsoft personal accounts always own their email; work/school accounts only count when Microsoft marks the domain verified (xms_edov).
    const verified=name==='google'?c.email_verified===true||c.email_verified==='true':c.tid===MS_PERSONAL_TENANT||c.xms_edov===true||c.xms_edov==='true'||c.xms_edov===1;
    if(!c.email||!verified)throw new HTTPError(400,`This ${p.label} account doesn't share a verified email. Use email sign-in instead.`);
    const address=email(c.email),display=String(c.name||'').replace(/[\r\n]/g,' ').trim().slice(0,120),timestamp=now();
    await env.DB.prepare('INSERT INTO customers (id,email,name,created_at) VALUES (?,?,?,?) ON CONFLICT(email) DO NOTHING').bind(crypto.randomUUID(),address,display,timestamp).run();
    const owner=await env.DB.prepare('SELECT id FROM customers WHERE email=?').bind(address).first(),started=await startSession(env,owner.id);
    return landing('/account.html',[clear,started.cookie]);
  }catch(error){return landing('/account.html?signin_error='+encodeURIComponent(error instanceof HTTPError?error.message:'Sign-in failed. Please try again.'),[clear]);}
}
export default {
  async fetch(request,env){const url=new URL(request.url);if(url.pathname.endsWith('/services-config.js'))return new Response(`window.VFTechServices = Object.freeze(${JSON.stringify(config(env))});\n`,{headers:{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});if(!url.pathname.startsWith('/api/'))return env.ASSETS?env.ASSETS.fetch(request):new Response('Not found',{status:404});
    try{if(request.method==='GET'&&url.pathname==='/api/config')return json(config(env));if(request.method==='GET'&&url.pathname==='/api/prices')return json(catalog);if(origin(env)&&url.origin!==origin(env))throw new HTTPError(403,'Use the configured VFTech site.');
      const provider=request.method==='GET'&&url.pathname.match(/^\/api\/auth\/(google|microsoft)\/(start|callback)$/);if(provider)return provider[2]==='start'?await oauthStart(request,env,provider[1]):await oauthCallback(request,env,provider[1],url);
      if(request.method==='POST'&&url.pathname==='/api/stripe/webhook')return await bills.webhook(request,env);
      if(url.pathname==='/api/admin'||url.pathname.startsWith('/api/admin/')){if(request.method==='POST')sameOrigin(request,env);return await adm.handle(request,env,url,()=>body(request));}
      if(request.method==='GET'&&url.pathname==='/api/billing')return await bills.status(env,await signedIn(request,env,false));
      if(request.method==='GET'&&url.pathname==='/api/account/profile')return await acct.getProfile(env,await signedIn(request,env,false));
      if(request.method==='GET'&&url.pathname==='/api/account/hours')return await acct.hours(env,await signedIn(request,env,false));
      if(request.method==='GET'&&url.pathname==='/api/account/2fa')return await mfa.status(env,await signedIn(request,env,false));
      if(request.method==='GET'&&url.pathname==='/api/account/history')return await acct.history(env,await signedIn(request,env,false));
      if(request.method==='GET'&&url.pathname==='/api/account/export')return await shut.exportData(env,await signedIn(request,env,false));
      if(request.method==='GET'&&url.pathname==='/api/account/features')return await acct.features(env,await signedIn(request,env,false));
      if(request.method==='POST'){sameOrigin(request,env);const billingRoute=url.pathname==='/api/billing/checkout'?'checkout':url.pathname==='/api/billing/portal'?'portal':url.pathname==='/api/billing/change-plan'?'change':url.pathname==='/api/billing/net30'?'net30':null;const input=await body(request);if(url.pathname==='/api/contact')return await contact(request,env,input);if(url.pathname==='/api/auth/request-code')return await requestCode(request,env,input);if(url.pathname==='/api/auth/verify-code')return await verifyCode(request,env,input);if(url.pathname==='/api/auth/recovery')return await recovery(request,env,input);if(url.pathname==='/api/auth/2fa')return await finishTwoFactor(request,env,input);if(url.pathname==='/api/auth/2fa/cancel')return await cancelTwoFactor(request,env);
        const twoFactorRoute={'/api/account/2fa/setup':'setup','/api/account/2fa/enable':'enable','/api/account/2fa/disable':'disable','/api/account/2fa/recovery-codes':'regenerate'}[url.pathname];
        if(twoFactorRoute){const active=await signedIn(request,env,true);await limit(env,'2fa-account',active.customer.id,20,3600);return await mfa[twoFactorRoute](env,active,input);}
        if(billingRoute){const active=await signedIn(request,env,true);await limit(env,'billing',active.customer.id,20,3600);return billingRoute==='net30'?await bills.requestNet30(env,active):billingRoute==='checkout'?await bills.checkout(env,active,input,await ipHash(request,env)):billingRoute==='change'?await bills.changePlan(env,active,input,await ipHash(request,env)):await bills.portal(env,active);}
        if(url.pathname==='/api/account/close/code'){const active=await signedIn(request,env,true);await limit(env,'close-code',active.customer.id,5,3600);return await shut.requestCode(env,active);}
        if(url.pathname==='/api/account/close'){const active=await signedIn(request,env,true);await limit(env,'close',active.customer.id,10,3600);return await shut.close(env,active,input);}
        if(url.pathname==='/api/account/keep'){const active=await signedIn(request,env,true);return await shut.keep(env,active);}
        if(url.pathname==='/api/account/profile'){const active=await signedIn(request,env,true);await limit(env,'profile',active.customer.id,30,3600);return await acct.saveProfile(env,active,input);}
        if(url.pathname==='/api/auth/logout'){const active=await session(request,env);if(!active)throw new HTTPError(401,'Sign in to continue.');if(!equal(request.headers.get('X-CSRF-Token'),active.csrfToken))throw new HTTPError(403,'Refresh your account page and try again.');await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await digest(active.token)).run();return json({authenticated:false},200,{'Set-Cookie':`${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`});}}
      if(request.method==='GET'&&['/api/session','/api/account/requests'].includes(url.pathname)){const active=await session(request,env);if(url.pathname==='/api/session')return json(active?{authenticated:true,customer:active.customer,csrfToken:active.csrfToken,plan:await acct.planFor(env,active.customer.id)}:(await pendingSession(request,env))?{authenticated:false,twoFactor:true}:{authenticated:false});if(!active)throw new HTTPError(401,'Sign in to see your requests.');const result=await env.DB.prepare('SELECT id,business,topics,message,plan_id AS planId,status,created_at AS createdAt FROM contact_requests WHERE email=? ORDER BY created_at DESC LIMIT 50').bind(active.customer.email).all();return json({requests:result.results});}
      throw new HTTPError(404,'This endpoint was not found.');
    }catch(error){return json({error:error instanceof HTTPError?error.message:'The service is temporarily unavailable. Please try again.'},error instanceof HTTPError?error.status:500);}
  },async scheduled(controller,env,ctx){ctx.waitUntil(Promise.all([cleanup(env),bills.dunning(env,send).catch(error=>console.error('dunning',error?.message)),bills.renewalReminders(env).catch(error=>console.error('renewals',error?.message)),shut.closeDue(env).catch(error=>console.error('closing',error?.message))]));}
};
