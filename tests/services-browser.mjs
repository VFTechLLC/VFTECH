// Meaningful interaction checks for the new features, in each site's shell.
import http from 'node:http';
import path from 'node:path';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
const root=path.resolve('_site'),base='/VFTECH/';
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.jpg':'image/jpeg','.woff2':'font/woff2'};
const server=http.createServer(async(req,res)=>{try{const pathname=new URL(req.url,'http://x').pathname;if(!pathname.startsWith(base))throw Error();const file=path.resolve(root,pathname.slice(base.length)||'index.html');if(!file.startsWith(root+path.sep))throw Error();res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({args:['--disable-webgl']});
await mkdir('checks-out',{recursive:true});
let views=0;
try{
  for(const n of [3,1,2,4,5,6,7,8,9,10].filter(n=>!process.env.ONLY||process.env.ONLY.split(',').includes(String(n))))for(const width of [320,1440]){
    const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('response',response=>{if(response.url().startsWith(origin)&&response.status()>=400)errors.push(`${response.status()} ${response.url()}`);});
    await page.route(url=>!url.href.startsWith(origin),route=>route.abort());
    const prefix=n===1?'':`design-${n}/`;
    await page.goto(`${origin}${base}${prefix}features.html`);await page.waitForSelector('#vfg-launch');
    assert.deepEqual(await page.evaluate(()=>Array.from(document.querySelectorAll('body *')).filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.right>innerWidth+1&&getComputedStyle(el).position!=='fixed';}).map(el=>({tag:el.tagName,cls:el.className,id:el.id,right:Math.round(el.getBoundingClientRect().right)})).slice(0,12)),[],`features ${n} ${width} overflow`);
    await page.click('[data-vfs-range="30"]');assert.match(await page.locator('#vfs-chart-label').textContent(),/30 days/);
    await page.click('#vfg-launch');await page.fill('#vfg-question','What are the prices?');await page.locator('.vfg-form button').click();
    assert.match(await page.locator('.vfg-answer').last().textContent(),/\$3,500/);
    assert.ok((await page.locator('.vfg-sources a').last().getAttribute('href')).startsWith(origin+base));
    const network=[];page.on('request',request=>network.push(request.url()));await context.setOffline(true);
    await page.fill('#vfg-question','Are the demos real data?');await page.locator('.vfg-form button').click();
    assert.match(await page.locator('.vfg-answer').last().textContent(),/sample data/);
    await page.fill('#vfg-question','What is the weather in Paris?');await page.locator('.vfg-form button').click();
    assert.match(await page.locator('.vfg-answer').last().textContent(),/only answer from VFTech/);
    await page.waitForTimeout(100);assert.deepEqual(network,[],`Guide requested a network resource in design ${n}`);
    await context.setOffline(false);await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'vfg-launch');
    await page.locator('#feature-charts h3').click();assert.equal(await page.evaluate(()=>VFTechGuide.context.recordId),'feature-charts');
    if(n===3&&width===1440){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'checks-out/features-desktop.png',fullPage:true});await page.click('#vfg-launch');await page.screenshot({path:'checks-out/local-guide.png'});await page.keyboard.press('Escape');}
    if(n===8&&width===320)await page.screenshot({path:'checks-out/features-mobile.png',fullPage:true});
    const a11y=await new AxeBuilder({page}).include('.vfs-main').withRules(['color-contrast','label','button-name','link-name','aria-valid-attr-value']).analyze();assert.deepEqual(a11y.violations.map(v=>`${v.id}: ${v.nodes.map(x=>x.target).join(',')}`),[],`Features accessibility ${n} ${width}`);
    await page.goto(`${origin}${base}${prefix}account.html`);await page.waitForSelector('#vfg-launch');
    assert.ok(await page.locator('#vf-account-form button').isDisabled());assert.match(await page.locator('#vf-service-status').textContent(),/not enabled/);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`account ${n} ${width} overflow`);
    assert.deepEqual(errors,[],`Design ${n} errors`);await context.close();views+=2;console.log(`Service pages OK · design ${n} · ${width}px`);
  }
  const context=await browser.newContext(),page=await context.newPage();await page.goto(`${origin}${base}design-6/index.html?demo=chart#showcase`);await page.waitForSelector('#vfg-launch');assert.equal(await page.locator('#sc-tab-chart').getAttribute('aria-selected'),'true');await page.click('#sc-tab-data');assert.equal(await page.evaluate(()=>VFTechGuide.context.recordId),'feature-data');await page.goto(`${origin}${base}design-8/index.html`);await page.waitForSelector('#vfg-launch');await page.locator('.cx-range [data-range="24h"]').click();assert.equal(await page.evaluate(()=>VFTechGuide.context.recordId),'feature-charts');await context.close();
  console.log(`${views} service page views + offline answers and contextual demo navigation passed.`);
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
