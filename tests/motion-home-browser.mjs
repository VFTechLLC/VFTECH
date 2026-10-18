// Verify rendered homepage animation, rather than only an installed library or showcase.
import http from 'node:http';
import path from 'node:path';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const root=path.resolve('_site'),base='/VFTECH/';
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'};
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://x'),file=path.resolve(root,url.pathname.slice(base.length)||'index.html');
  if(!url.pathname.startsWith(base)||!file.startsWith(root+path.sep))throw Error();
  res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.end(await readFile(file));
 }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({args:['--disable-webgl']});
const selected=(process.env.ONLY||'3,1,2,4,5,6,7,8,9,10').split(',').map(Number);
let views=0;
await mkdir('checks-out',{recursive:true});
async function make(options){
 const context=await browser.newContext(options);
 await context.route(url=>!url.href.startsWith(origin),route=>route.abort());
 return context;
}
async function settled(page){
 await page.waitForFunction(()=>document.querySelector('main h1') &&
  getComputedStyle(document.querySelector('main h1')).opacity==='1' &&
  !document.querySelector('[data-vf-intro="revealing"]'));
}
try{
 for(const n of selected){
  const prefix=n===1?'':'design-'+n+'/',url=origin+base+prefix+'index.html';
  for(const [width,height,touch] of [[1440,900,false],[320,844,true],[782,844,true]]){
   const context=await make({viewport:{width,height},hasTouch:touch,reducedMotion:'no-preference'});
   await context.addInitScript(()=>{
    window.__vfHomeMinOpacity=1;
    new MutationObserver(()=>{
     const h=document.querySelector('main h1');
     if(h)window.__vfHomeMinOpacity=Math.min(window.__vfHomeMinOpacity,Number(getComputedStyle(h).opacity));
    }).observe(document,{subtree:true,attributes:true,attributeFilter:['style']});
   });
   const page=await context.newPage(),errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   await page.goto(url);await page.waitForFunction(()=>window.VFTechMotion?.diagnostics().enabled);
   await settled(page);
   assert.ok(await page.evaluate(()=>window.__vfHomeMinOpacity<.8),'Homepage title never visibly animated · '+n+'/'+width);
   assert.ok(await page.locator('[data-vf-reveal]').count()>0,'No actual homepage sections animated · '+n);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Sideways scrolling · '+n+'/'+width);
   const card=page.locator('.vf-card-effects').first();
   assert.ok(await card.count(),'No effects on the actual homepage cards · '+n);
   await card.scrollIntoViewIfNeeded();
   if(!touch)await card.hover();
   await page.waitForFunction(()=>[...document.querySelectorAll('.vf-card-active>.vf-spotlight,.vf-card-active>.vf-border-beam')]
    .some(el=>{const r=el.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight&&Number(getComputedStyle(el).opacity)>.1;}),{},{timeout:4000});
   if(touch){
    assert.equal(await page.evaluate(()=>VFTechMotion.diagnostics().lenis),false,'Touch scrolling was replaced');
    await page.waitForFunction(()=>!document.querySelector('.vf-card-active'),{},{timeout:4000});
   }else await page.mouse.move(2,2);
   // The replay action is available on the design itself, and visibly restarts its intro.
   await page.locator('.ds-trigger').click();
   await page.evaluate(()=>window.__vfHomeMinOpacity=1);
   await page.locator('.ds-motion-replay').click();
   await settled(page);
   assert.ok(await page.evaluate(()=>window.__vfHomeMinOpacity<.8),'Replay did not animate the homepage · '+n);
   assert.ok(await page.evaluate(()=>scrollY<2),'Replay did not return to the heading');
   assert.equal(await page.locator('.ds-trigger').getAttribute('aria-expanded'),'false');
   assert.equal(await page.evaluate(()=>document.activeElement.id),'main');
   if(n===7&&!touch){
    await page.selectOption('#ld-filter','Review');
    assert.match(await page.locator('#ld-result-count').textContent(),/2 of 6/);
    await page.locator('.ld-project').first().click();await page.waitForFunction(()=>document.querySelector('#ld-project-dialog').open);
    await page.keyboard.press('Escape');
   }
   if(n===9&&!touch){
    await page.locator('[data-add-task]').first().click();await page.waitForFunction(()=>Boolean(document.querySelector('dialog[open]')));
    await page.keyboard.press('Escape');
   }
   // Pause from the existing control, then resume/replay from the design menu.
   await page.locator('.motion-btn,[data-motion-control]').first().click();
   await page.waitForFunction(()=>!VFTechMotion.diagnostics().enabled);
   assert.equal(await page.locator('[data-vf-reveal="pending"],[data-vf-intro="revealing"]').count(),0);
   await page.locator('.ds-trigger').click();
   await page.locator('.ds-motion-replay').click();
   await page.waitForFunction(()=>VFTechMotion.diagnostics().enabled);await settled(page);
   assert.deepEqual(errors,[]);
   if(width===1440)await page.screenshot({path:'checks-out/home-motion-'+n+'.png'});
   await context.close();views++;
  }
  const context=await make({viewport:{width:390,height:844},hasTouch:true,reducedMotion:'reduce'}),page=await context.newPage(),requests=[];
  page.on('request',r=>requests.push(r.url()));await page.goto(url);
  await page.waitForFunction(()=>document.documentElement.dataset.vfMotionState==='reduced');
  assert.equal(await page.locator('main h1').evaluate(el=>getComputedStyle(el).opacity),'1');
  assert.ok(!requests.some(url=>url.includes('/assets/motion-suite.js')),'Reduced motion loaded the animation bundle');
  await page.locator('.ds-trigger').click();
  assert.equal(await page.locator('.ds-motion-replay').isDisabled(),true);
  assert.match(await page.locator('.ds-motion-replay').textContent(),/Reduced motion/);
  await context.close();views++;
  console.log('Homepage motion OK · design '+n+' · desktop, phone, tablet, replay, pause and reduced motion');
 }
 console.log(views+' actual homepage motion views passed.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
