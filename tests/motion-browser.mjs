// Behavioral checks: enhanced and native scrolling, accessibility, failure fallback,
// motion preferences, idle work and the guide's offline boundary.
import http from 'node:http';
import path from 'node:path';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const root=path.resolve('_site'),base='/VFTECH/';
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.jpg':'image/jpeg','.woff2':'font/woff2'};
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://x');const file=path.resolve(root,url.pathname.slice(base.length)||'index.html');if(!url.pathname.startsWith(base)||!file.startsWith(root+path.sep))throw Error();res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({args:['--disable-webgl']});
await mkdir('checks-out',{recursive:true});
const selected=(process.env.ONLY||'3,1,2,4,5,6,7,8,9,10').split(',').map(Number);
let views=0;
async function make(options){const context=await browser.newContext(options);await context.route(url=>!url.href.startsWith(origin),route=>route.abort());return context;}
try{
 for(const n of selected){
  const prefix=n===1?'':`design-${n}/`,url=origin+base+prefix+'features.html';
  for(const [width,height,touch] of [[1440,900,false],[320,844,true],[844,390,true]]){
   const context=await make({viewport:{width,height},hasTouch:touch,reducedMotion:'no-preference'}),page=await context.newPage(),errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   await page.goto(url);await page.waitForFunction(()=>window.VFTechMotion?.diagnostics().enabled);
   assert.equal(await page.evaluate(()=>VFTechMotion.diagnostics().lenis),!touch&&width>=900);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Sideways scrolling at '+n+'/'+width);
   if(!touch){
    const card=page.locator('.vf-card-effects').first();
    await card.hover();await page.waitForTimeout(280);
    assert.ok(await card.locator('.vf-spotlight,.vf-border-beam').evaluate(el=>Number(getComputedStyle(el).opacity)>0),'Card hover did not render');
    if(n===4||n===8)assert.equal(await card.locator('.vf-border-beam>i').evaluate(el=>getComputedStyle(el).animationIterationCount),'1','Border sweep repeats indefinitely');
    await page.locator('[data-vfs-range="30"]').click();
    assert.match(await page.locator('#vfs-chart-label').textContent(),/30 days/,'Motion blocked the chart control');
   }
   await page.mouse.move(width/2,height/2);await page.mouse.wheel(0,420);await page.waitForTimeout(1000);
   const idle=await page.evaluate(()=>VFTechMotion.diagnostics());assert.equal(idle.tickerActive,false);
   await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>VFTechMotion.diagnostics().lenisFrames),idle.lenisFrames,'Idle Lenis work');
   await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));await page.waitForTimeout(800);
   assert.equal(await page.locator('[data-vf-reveal="pending"]').count(),0,'Content stayed hidden after a scroll jump');
   try { await page.locator('.foot-meta .motion-btn').first().click({timeout:5000}); }
   catch(error) {
    console.log('Pause control',n,width,height,await page.locator('.foot-meta .motion-btn').first().boundingBox());
    await page.screenshot({path:`checks-out/motion-pause-failure-${n}-${width}.png`});throw error;
   }
   await page.waitForFunction(()=>!VFTechMotion.diagnostics().enabled);
   assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('lenis')),false);
   assert.equal(await page.locator('[data-vf-reveal="pending"]').count(),0);
   try { await page.locator('.foot-meta .motion-btn').first().click({timeout:5000}); }
   catch(error) {
    console.log('Pause control',n,width,height,await page.locator('.foot-meta .motion-btn').first().boundingBox());
    await page.screenshot({path:`checks-out/motion-pause-failure-${n}-${width}.png`});throw error;
   }await page.waitForFunction(()=>VFTechMotion.diagnostics().enabled);
   await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));await page.waitForFunction(()=>scrollY<2);
   try { await page.locator('.vfs-subnav a[href="features.html#prices"]').click({timeout:5000}); }
   catch(error) {
    console.log(await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollY,header:document.querySelector('.site-head').getBoundingClientRect().toJSON(),nav:document.querySelector('.vfs-subnav').getBoundingClientRect().toJSON(),main:document.querySelector('main').getBoundingClientRect().toJSON()})));
    await page.screenshot({path:`checks-out/motion-nav-failure-${n}-${width}.png`});throw error;
   }
   await page.waitForFunction(()=>location.hash==='#prices');await page.waitForTimeout(750);
   assert.ok(await page.locator('#prices').evaluate(el=>Math.abs(el.getBoundingClientRect().top)<250),'Native price anchor');
   if(n===3&&width===1440){
    await page.click('#vfg-launch');
    const requests=[];page.on('request',r=>requests.push(r.url()));await context.setOffline(true);
    await page.fill('#vfg-question','What are the prices?');await page.locator('.vfg-form button').click();assert.match(await page.locator('.vfg-answer').last().textContent(),/\$3,500/);
    await page.fill('#vfg-question','What is the weather in Paris?');await page.locator('.vfg-form button').click();assert.match(await page.locator('.vfg-answer').last().textContent(),/only answer from VFTech/);
    const log=page.locator('.vfg-log');
    await log.evaluate(el=>el.scrollTop=0);await log.hover();
    const before=await page.evaluate(()=>scrollY);
    await page.mouse.wheel(0,180);await page.waitForTimeout(250);
    assert.ok(await log.evaluate(el=>el.scrollTop>0),'Chat history did not scroll');
    assert.equal(await page.evaluate(()=>scrollY),before,'Scrolling the chat moved the page');
    assert.deepEqual(requests,[]);await context.setOffline(false);await page.keyboard.press('Escape');
    await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));await page.waitForFunction(()=>scrollY<2);await page.screenshot({path:'checks-out/motion-signal-features.png'});
   }
   if(!touch){
    await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>!VFTechMotion.diagnostics().enabled);
    assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('lenis')),false);
    await page.emulateMedia({reducedMotion:'no-preference'});await page.waitForFunction(()=>VFTechMotion.diagnostics().enabled);
   }
   assert.deepEqual(errors,[]);await context.close();views++;
  }
  const context=await make({viewport:{width:1440,height:900},reducedMotion:'reduce'}),page=await context.newPage(),requests=[];
  page.on('request',r=>requests.push(r.url()));await page.goto(url);
  await page.waitForFunction(()=>document.documentElement.dataset.vfMotionState==='reduced');
  assert.ok(!requests.some(url=>url.includes('/assets/motion-suite.js')),'Reduced motion unnecessarily loaded the animation bundle');
  assert.equal(await page.locator('[data-vf-reveal="pending"]').count(),0);
  await page.keyboard.press('Tab');await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>document.activeElement.id),'main','Skip link focus');
  await context.close();views++;console.log('Motion OK · design '+n+' · desktop, narrow mobile, landscape, reduced motion and keyboard');
 }
 if(selected.includes(3))for(const mode of ['no-js','failed-bundle','data-saver']){
  const context=await make({viewport:{width:320,height:844},javaScriptEnabled:mode!=='no-js'}),page=await context.newPage();
  if(mode==='failed-bundle')await page.route('**/assets/motion-suite.js*',route=>route.abort());
  if(mode==='data-saver')await context.addInitScript(()=>Object.defineProperty(navigator,'connection',{value:Object.assign(new EventTarget(),{saveData:true}),configurable:true}));
  await page.goto(origin+base+'features.html');
  if(mode!=='no-js')await page.waitForFunction(expected=>document.documentElement.dataset.vfMotionState===expected,mode==='failed-bundle'?'unavailable':'data-saver');
  assert.equal(await page.locator('[data-vf-reveal="pending"]').count(),0);
  assert.equal(await page.locator('.vfs-intro h1').evaluate(el=>getComputedStyle(el).opacity),'1');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await context.close();views++;console.log('Content fallback OK · '+mode);
 }
 console.log(views+' motion views passed.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
