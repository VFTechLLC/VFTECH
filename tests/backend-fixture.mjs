// Real SQLite queries; only the external providers (Turnstile, Resend, Stripe) are mocked. Nothing leaves tests.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import worker from '../backend/worker.js';
export function fixture(){
  const sqlite=new DatabaseSync(':memory:');for(const file of readdirSync('backend/migrations').filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync('backend/migrations/'+file,'utf8'));
  function statement(sql,args=[]){return {bind(...values){return statement(sql,values);},async first(){return sqlite.prepare(sql).get(...args)||null;},async all(){return {results:sqlite.prepare(sql).all(...args)};},async run(){const result=sqlite.prepare(sql).run(...args);return {success:true,meta:{changes:Number(result.changes)}};},sql,args};}
  const DB={prepare:statement,async batch(items){sqlite.exec('BEGIN');try{const results=items.map(item=>{const result=sqlite.prepare(item.sql).run(...item.args);return {success:true,meta:{changes:Number(result.changes)}};});sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  const env={DB,SITE_URL:'https://vftech.test',TURNSTILE_SITE_KEY:'test-site-key',TURNSTILE_SECRET_KEY:'test-secret',TURNSTILE_HOSTNAME:'vftech.test',RESEND_API_KEY:'test-mail-key',EMAIL_FROM:'VFTech <test@vftech.test>',CONTACT_TO:'inbox@vftech.test',SESSION_SECRET:'test-only-session-secret-at-least-thirty-two-characters'};
  const state={emails:[],outbound:[],failMail:false,failCaptcha:false,hostname:null,action:null,stripe:{prices:{},customers:[],subscriptions:[],invoices:[],sessions:[],keys:[]}};
  const used=new Set(),original=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    state.outbound.push(String(url));
    if(String(url)==='https://challenges.cloudflare.com/turnstile/v0/siteverify'){const token=options.body.get('response'),action=token?.startsWith('contact-')?'contact':'account',valid=/^(contact|account)-/.test(token||'')&&!used.has(token)&&!state.failCaptcha;used.add(token);return Response.json({success:valid,hostname:state.hostname||env.TURNSTILE_HOSTNAME,action:state.action||action});}
    if(String(url)==='https://api.resend.com/emails'){if(state.failMail)return Response.json({error:'provider unavailable'},{status:500});state.emails.push({payload:JSON.parse(options.body),key:options.headers['Idempotency-Key']});return Response.json({id:crypto.randomUUID()});}
    if(String(url).startsWith('https://api.stripe.com/v1/')){const u=new URL(url),path=u.pathname.slice(4),method=options.method||'GET',params=method==='POST'?new URLSearchParams(String(options.body)):u.searchParams,s=state.stripe;s.keys.push(options.headers['Idempotency-Key']||null);
      if(method==='POST'&&path==='customers'){const id='cus_'+(s.customers.length+1);s.customers.push({id,email:params.get('email')});return Response.json({id});}
      if(method==='GET'&&path==='prices'){const price=s.prices[params.get('lookup_keys[0]')];return Response.json({data:price?[price]:[]});}
      if(method==='POST'&&path==='checkout/sessions'){s.sessions.push(Object.fromEntries(params));return Response.json({id:'cs_test',url:'https://checkout.stripe.test/cs_test'});}
      if(method==='GET'&&path==='payment_method_configurations')return Response.json({data:s.paymentConfigs||[]});
      if(method==='POST'&&path==='billing_portal/sessions')return Response.json({url:'https://billing.stripe.test/p_'+params.get('customer')});
      if(method==='GET'&&path==='subscriptions')return Response.json({data:s.subscriptions.filter(x=>x.customer===params.get('customer'))});
      if(method==='GET'&&path.startsWith('subscriptions/')){const sub=s.subscriptions.find(x=>x.id===path.split('/')[1]);return sub?Response.json(sub):Response.json({error:{type:'invalid_request_error'}},{status:404});}
      if(method==='GET'&&path==='invoices')return Response.json({data:s.invoices.filter(x=>(!params.get('customer')||x.customer===params.get('customer'))&&(!params.get('subscription')||x.subscription===params.get('subscription'))&&(!params.get('status')||x.status===params.get('status')))});
      // Payment rules (phase 2): payment methods, customers, charges, cancelling and writing off.
      if(method==='GET'&&/^customers\/cus_\w+\/payment_methods$/.test(path))return Response.json({data:(s.paymentMethods||[]).filter(m=>m.customer===path.split('/')[1])});
      if(method==='GET'&&/^customers\/cus_\w+$/.test(path))return Response.json({id:path.split('/')[1],invoice_settings:{default_payment_method:s.defaultPaymentMethod||null}});
      if(method==='GET'&&/^charges\/ch_\w+$/.test(path))return Response.json((s.charges||[]).find(c=>c.id===path.split('/')[1])||{});
      if(method==='POST'&&/^payment_methods\/pm_\w+\/detach$/.test(path)){const id=path.split('/')[1];s.detached=(s.detached||[]).concat([id]);s.paymentMethods=(s.paymentMethods||[]).filter(m=>m.id!==id);return Response.json({id,customer:null});}
      if(method==='DELETE'&&/^subscriptions\/sub_\w+$/.test(path)){const sub=s.subscriptions.find(x=>x.id===path.split('/')[1]);if(sub)sub.status='canceled';return Response.json(sub||{});}
      if(method==='POST'&&/^invoices\/in_\w+\/mark_uncollectible$/.test(path)){const invoice=s.invoices.find(x=>x.id===path.split('/')[1]);if(invoice)invoice.status='uncollectible';return Response.json(invoice||{});}
      // Plan changes (phase 1): subscription updates and schedules. s.declineNext makes the next update a card decline.
      const priceById=id=>Object.values(s.prices).find(p=>p.id===id);
      if(method==='POST'&&/^subscriptions\/sub_\w+$/.test(path)){const sub=s.subscriptions.find(x=>x.id===path.split('/')[1]);if(!sub)return Response.json({error:{type:'invalid_request_error'}},{status:404});if(s.declineNext&&params.get('items[0][price]')){s.declineNext=false;return Response.json({error:{type:'card_error',code:'card_declined'}},{status:402});}s.updates=(s.updates||[]).concat([{id:sub.id,...Object.fromEntries(params)}]);if(params.has('cancel_at_period_end'))sub.cancel_at_period_end=params.get('cancel_at_period_end')==='true';if(params.has('metadata[closing_account]'))sub.metadata={...(sub.metadata||{}),closing_account:params.get('metadata[closing_account]')};if(params.get('items[0][price]'))sub.items.data[0].price=priceById(params.get('items[0][price]'));return Response.json(sub);}
      if(method==='POST'&&path==='subscription_schedules'){const sub=s.subscriptions.find(x=>x.id===params.get('from_subscription'));const sched={id:'sub_sched_'+((s.schedules||[]).length+1),subscription:sub.id,phases:[{start_date:1890000000,end_date:sub.current_period_end,items:[{price:sub.items.data[0].price.id}]}]};s.schedules=(s.schedules||[]).concat([sched]);sub.schedule=sched.id;return Response.json(sched);}
      if(method==='GET'&&/^subscription_schedules\/\w+$/.test(path))return Response.json((s.schedules||[]).find(x=>x.id===path.split('/')[1]));
      if(method==='POST'&&/^subscription_schedules\/\w+\/release$/.test(path)){const sched=(s.schedules||[]).find(x=>x.id===path.split('/')[1]);const sub=s.subscriptions.find(x=>x.id===sched.subscription);sub.schedule=null;s.released=(s.released||0)+1;return Response.json({...sched,status:'released'});}
      if(method==='POST'&&/^subscription_schedules\/\w+$/.test(path)){s.scheduleUpdates=(s.scheduleUpdates||[]).concat([Object.fromEntries(params)]);return Response.json((s.schedules||[]).find(x=>x.id===path.split('/')[1]));}
      return Response.json({error:{type:'invalid_request_error'}},{status:400});}
    throw Error('Unexpected outbound request: '+url);
  };
  async function request(path,data,extra={}){const headers={...(data===undefined?{}:{'Content-Type':'application/json','Origin':new URL(env.SITE_URL).origin}),'CF-Connecting-IP':'192.0.2.10',...extra.headers};const response=await worker.fetch(new Request(new URL('/api/'+path,env.SITE_URL),{method:extra.method||(data===undefined?'GET':'POST'),headers,body:data===undefined?undefined:JSON.stringify(data)}),env);return {response,status:response.status,body:await response.json()};}
  function token(action){return `${action}-${crypto.randomUUID()}`;}
  function contact(overrides={}){return {name:'Test Customer',email:'one@example.test',business:'A business',phone:'',topics:['Website rebuild'],times:'Tomorrow afternoon',message:'Please build a dashboard.',planId:'business',website:'',idempotencyKey:crypto.randomUUID(),turnstileToken:token('contact'),...overrides};}
  async function challenge(address='one@example.test'){const result=await request('auth/request-code',{email:address,name:'Test Customer',turnstileToken:token('account')});if(result.status!==201)throw Error(JSON.stringify(result));const value=state.emails.at(-1).payload.text.match(/code is (\d{6})/)[1];return {email:address,challengeId:result.body.challengeId,code:value};}
  async function login(address='one@example.test'){const data=await challenge(address),result=await request('auth/verify-code',data);if(result.status!==200)throw Error(JSON.stringify(result));return {...result,cookie:result.response.headers.get('Set-Cookie').split(';')[0]};}
  return {worker,sqlite,env,state,request,token,contact,challenge,login,close(){globalThis.fetch=original;sqlite.close();}};
}
