// Browser -> real Worker -> real SQLite. Provider calls are mocked; no emails leave tests.
import http from 'node:http';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {fixture} from './backend-fixture.mjs';
const f=fixture(),root=path.resolve('_site'),types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.jpg':'image/jpeg','.woff2':'font/woff2'};
const server=http.createServer(async(req,res)=>{try{
  const url=new URL(req.url,f.env.SITE_URL);
  if(url.pathname.startsWith('/api/')||url.pathname.endsWith('/services-config.js')){const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks),headers={...req.headers,'CF-Connecting-IP':'192.0.2.19'};const result=await f.worker.fetch(new Request(url,{method:req.method,headers,body:bytes.length?bytes:undefined}),f.env);res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));return;}
  const file=path.resolve(root,url.pathname.slice(1)||'index.html');if(!file.startsWith(root+path.sep))throw Error();res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.end(await readFile(file));
}catch{res.writeHead(500);res.end('Test server error');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));f.env.SITE_URL=`http://127.0.0.1:${server.address().port}`;f.env.TURNSTILE_HOSTNAME='127.0.0.1';
const browser=await chromium.launch({args:['--disable-webgl']});
try{
  const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage(),errors=[];
  await context.addInitScript(()=>{let next=0;const widgets=new Map();window.turnstile={render(container,options){container.textContent='CAPTCHA test fixture';const id=++next;widgets.set(id,options);options.callback(options.action+'-'+crypto.randomUUID());return id;},reset(id){const options=widgets.get(id);options.callback(options.action+'-'+crypto.randomUUID());}};});
  await page.route(url=>!url.href.startsWith(f.env.SITE_URL),route=>route.abort());page.on('pageerror',e=>errors.push(e.message));
  await page.goto(f.env.SITE_URL+'/contact.html?plan=business');await page.waitForSelector('#vf-contact-status',{state:'attached'});assert.match(await page.locator('.vfs-contact-status').first().textContent(),/Business/);
  await page.fill('#f-name','Test Customer');await page.fill('#f-email','one@example.test');await page.fill('#f-business','Browser test');await page.fill('#f-message','Please build my customer dashboard.');await page.locator('#book-form button[type=submit]').click();await page.waitForFunction(()=>document.getElementById('vf-contact-status').textContent.includes('your request was sent'));assert.equal(f.state.emails.length,1);assert.equal(await page.locator('#form-out').isVisible(),false);
  await page.goto(f.env.SITE_URL+'/account.html');await page.fill('#vf-name','Test Customer');await page.fill('#vf-email','one@example.test');await page.locator('#vf-account-form button').click();await page.waitForSelector('#vf-code-form:not([hidden])');const value=f.state.emails.at(-1).payload.text.match(/code is (\d{6})/)[1];
  await page.fill('#vf-code',value);await page.locator('#vf-code-form button[type=submit]').click();await page.waitForSelector('#vf-account-home:not([hidden])');await page.waitForFunction(()=>document.getElementById('vf-requests').textContent.includes('Please build my customer dashboard.'));const session=(await context.cookies()).find(c=>c.name==='__Host-vftech-session');assert.ok(session);assert.ok(session.httpOnly&&session.secure&&session.sameSite==='Strict');
  await page.reload();await page.waitForSelector('#vf-account-home:not([hidden])');assert.match(await page.locator('#vf-profile').textContent(),/one@example.test/);await page.click('#vf-logout');await page.waitForSelector('#vf-account-form:not([hidden])');assert.equal((await context.cookies()).some(c=>c.name==='__Host-vftech-session'),false);
  f.state.failMail=true;await page.goto(f.env.SITE_URL+'/design-7/contact.html');await page.fill('#f-name','Test Customer');await page.fill('#f-email','two@example.test');await page.fill('#f-message','Second request');await page.locator('#book-form button[type=submit]').click();await page.waitForFunction(()=>document.getElementById('vf-contact-status').textContent.includes('could not be accepted'));assert.equal(await page.locator('#form-out').isVisible(),false);
  assert.deepEqual(errors,[]);assert.ok(f.state.outbound.every(url=>url==='https://api.resend.com/emails'||url==='https://challenges.cloudflare.com/turnstile/v0/siteverify'));await context.close();console.log('Real Worker/browser flow passed: contact delivery, code sign-in, private requests, session reload, sign-out and provider failure. No emails sent.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));f.close();}
