// Render the published homepage and the original first design, including states
// that a scrollWidth-only check misses: clipped text, open overlays and rotation.
// Run npm run test:homepage after installing Playwright Chromium.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {readFile, mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import {parseHTML} from 'linkedom';

const root=path.resolve('_site'), base='/VFTECH/';
const types={'.html':'text/html','.css':'text/css','.js':'text/javascript',
  '.svg':'image/svg+xml','.woff2':'font/woff2','.jpg':'image/jpeg'};
const server=http.createServer(async(req,res)=>{
  try{
    const pathname=decodeURIComponent(new URL(req.url,'http://x').pathname);
    const file=path.resolve(root,pathname.slice(base.length)||'index.html');
    if(!pathname.startsWith(base)||!file.startsWith(root+path.sep))throw Error();
    res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');
    res.end(await readFile(file));
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({args:['--disable-webgl']});
await mkdir('checks-out',{recursive:true});
const views=[[280,653],[320,568],[390,844],[540,720],[640,360],[760,360],
  [782,844],[900,600],[901,600],[980,768],[1100,800],[1101,800],
  [1440,900],[2560,1080],[320,240],[640,450]];
let checked=0;
const failures=[];
async function check(label,options,run){
  if(process.env.HOMEPAGE_CASE&&!process.env.HOMEPAGE_CASE.split(',').some(filter=>label.includes(filter)))return;
  const context=await browser.newContext({reducedMotion:'reduce',...options});
  await context.route(url=>!url.href.startsWith(origin),route=>route.abort());
  const page=await context.newPage(), errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  try{await run(page,context);assert.deepEqual(errors,[],'Browser script errors');checked++;}
  catch(error){failures.push(label+': '+error.message);}
  finally{await context.close();}
}
async function ready(page,url){
  assert.equal((await page.goto(url)).status(),200);
  await page.evaluate(()=>document.fonts.ready);
}
async function fits(page){
  const issues=await page.evaluate(()=>{
    const errors=[], range=document.createRange();
    if(document.documentElement.scrollWidth>innerWidth+1)errors.push('Sideways page scrolling');
    for(const el of document.querySelectorAll('.hero-title .ln,.cell h3,.sit h3')){
      range.selectNodeContents(el);
      const text=range.getBoundingClientRect(),box=el.getBoundingClientRect();
      if(text.left<box.left-1||text.right>box.right+1)errors.push('Text escapes its column: '+el.textContent.trim());
    }
    for(const el of document.querySelectorAll('main .cta,.site-head .nav a,.x-bookbar a')){
      if(!el.getBoundingClientRect().width)continue;
      const tops=new Set(),box=el.getBoundingClientRect();
      for(const node of el.childNodes){
        if(node.nodeType!==Node.TEXT_NODE||!node.textContent.trim())continue;
        range.selectNodeContents(node);
        for(const rect of range.getClientRects()){
          if(!rect.width)continue;
          tops.add(Math.round(rect.top));
          if(rect.left<box.left-1||rect.right>box.right+1)errors.push('Clipped action: '+el.textContent.trim());
        }
      }
      if(tops.size>1)errors.push('Wrapped action: '+el.textContent.trim());
    }
    return errors;
  });
  assert.deepEqual(issues,[]);
}
async function inside(page,selector,container){
  const problem=await page.locator(selector).evaluate((el,parentSelector)=>{
    const r=el.getBoundingClientRect(),p=parentSelector?el.closest(parentSelector).getBoundingClientRect():{left:0,top:0,right:innerWidth,bottom:innerHeight};
    return r.left<p.left-1||r.right>p.right+1||r.top<p.top-1||r.bottom>p.bottom+1;
  },container);
  assert.equal(problem,false,selector+' is clipped');
}
async function accessible(page){
  // Theme colors transition together; assess their settled contrast.
  await page.evaluate(()=>Promise.all(document.getAnimations().filter(animation=>animation instanceof CSSTransition).map(animation=>animation.finished.catch(()=>{}))));
  const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  assert.deepEqual(result.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)})),[]);
}
try{
  for(const [design,directory] of [[1,''],[3,'design-3/']]){
    const url=origin+base+directory+'index.html';
    for(const [width,height] of views)await check('design '+design+' @'+width+'×'+height,
      {viewport:{width,height},hasTouch:width<1101},async page=>{
        await ready(page,url);await fits(page);
        await page.locator('.ds-trigger').click();await inside(page,'.ds-menu');
        if(width===320&&height===568)await accessible(page);
        // Keyboard departure closes the disclosure rather than leaving it over content.
        await page.locator('.vfg-launch').focus();
        assert.equal(await page.locator('.ds-menu').isVisible(),false);
        await page.locator('.vfg-launch').click();
        await inside(page,'.vfg-close','.vfg-panel');
        await inside(page,'.vfg-form input','.vfg-panel');
        await inside(page,'.vfg-form button','.vfg-panel');
        if(width===320&&height===568)await accessible(page);
        await page.locator('.vfg-close').click();
        assert.equal(await page.locator('.vfg-panel').isVisible(),false);
        if(width<=1100){
          await page.locator('.menu-btn').click();await inside(page,'#site-nav');
          await page.locator('#site-nav a').last().scrollIntoViewIfNeeded();
          await inside(page,'#site-nav li:last-child a','#site-nav');
          await page.keyboard.press('Escape');
          assert.equal(await page.locator('.menu-btn').getAttribute('aria-expanded'),'false');
          await page.locator('.menu-btn').click();
          await page.setViewportSize({width:1280,height:800});
          await page.waitForFunction(()=>document.querySelector('.menu-btn').getAttribute('aria-expanded')==='false');
          await page.setViewportSize({width,height});
          assert.equal(await page.locator('#site-nav').isVisible(),false);
        }
        // At 200% desktop zoom a 1280×900 window has a 640×450 CSS viewport.
        if(width===640&&height===450){
          await page.locator('.hero .cta').focus();
          assert.equal(await page.locator('.hero .cta').evaluate(el=>document.activeElement===el),true);
        }
        if(width===1440||width===320&&height===568)
          await page.screenshot({path:'checks-out/home-layout-'+design+'-'+width+'.png',fullPage:true});
      });

    await check('design '+design+' without JavaScript',{viewport:{width:390,height:844},javaScriptEnabled:false},async page=>{
      await ready(page,url);await fits(page);
      assert.equal(await page.locator('#site-nav').isVisible(),true);
      await page.locator('#site-nav a[href="process.html"]').click();
      assert.match(page.url(),/process\.html$/);
    });
    await check('design '+design+' while navigation script loads',{viewport:{width:390,height:844}},async(page,context)=>{
      let release;
      const loading=new Promise(resolve=>{release=resolve;});
      await context.route('**/site.js*',async route=>{await loading;await route.continue();});
      try{
        await page.goto(url,{waitUntil:'commit'});
        await page.waitForFunction(()=>document.styleSheets.length>=10);
        assert.equal(await page.locator('#site-nav').isVisible(),false,'Expanded navigation flashes during load');
      }finally{release();}
      await page.waitForFunction(()=>document.documentElement.classList.contains('nav-ready'));
      await page.locator('.menu-btn').click();assert.equal(await page.locator('#site-nav').isVisible(),true);
    });
    await check('design '+design+' without fonts',{viewport:{width:320,height:568}},async(page,context)=>{
      await context.route('**/*.woff2',route=>route.abort());await ready(page,url);await fits(page);
    });
    await check('design '+design+' with failed optional 3D download',{viewport:{width:390,height:844}},async(page,context)=>{
      await context.route('**/assets/chrome-hero.js*',route=>route.abort());
      await ready(page,url);await page.waitForSelector('.chrome-fallback');
      assert.equal(await page.locator('.hero-drawing').isVisible(),true);await fits(page);
    });
    await check('design '+design+' guide above mobile keyboard',{viewport:{width:390,height:844}},async(page,context)=>{
      await context.addInitScript(()=>{
        const viewport=new EventTarget();Object.assign(viewport,{height:844,offsetTop:0});
        Object.defineProperty(window,'visualViewport',{value:viewport});
      });
      await ready(page,url);await page.locator('.vfg-launch').click();
      await page.evaluate(()=>{Object.assign(visualViewport,{height:260,offsetTop:80});visualViewport.dispatchEvent(new Event('resize'));});
      await inside(page,'.vfg-close','.vfg-panel');await inside(page,'.vfg-form button','.vfg-panel');
      assert.ok(await page.locator('.vfg-panel').evaluate(el=>el.getBoundingClientRect().bottom<=340));
      await page.locator('#vfg-question').fill('What are the prices?');await page.locator('.vfg-form button').click();
      assert.match(await page.locator('.vfg-answer').last().textContent(),/3,500/);
      await page.locator('.vfg-close').click();assert.equal(await page.locator('.vfg-panel').isVisible(),false);
    });
    await check('design '+design+' themes, links and footer',{viewport:{width:1440,height:900}},async page=>{
      await ready(page,url);
      await page.locator('.theme-btn').click();await accessible(page);await fits(page);
      await page.locator('.theme-btn').click();await accessible(page);
      assert.equal(await page.locator('footer').textContent().then(t=>/vftech\.example|000\) 000/.test(t)),false);
      for(const href of await page.locator('a[href]').evaluateAll(links=>links.map(a=>a.href))){
        const link=new URL(href);if(!href.startsWith(origin+base))continue;
        const file=link.pathname.slice(base.length)||'index.html';
        const html=await readFile(path.join(root,file.endsWith('/')?file+'index.html':file),'utf8');
        if(link.hash){const {document}=parseHTML(html);assert.ok(document.getElementById(decodeURIComponent(link.hash.slice(1))),'Missing linked anchor '+href);}
      }
    });
  }
  // Shared navigation and overlays also ship in the eight other designs.
  for(const design of [2,4,5,6,7,8,9,10])await check('shared controls in design '+design,
    {viewport:{width:390,height:844},hasTouch:true},async page=>{
      await ready(page,origin+base+'design-'+design+'/index.html');
      await page.locator('.menu-btn').click();await page.keyboard.press('Escape');
      await page.locator('.ds-trigger').click();await page.keyboard.press('Escape');
      await page.locator('.vfg-launch').click();await inside(page,'.vfg-form button','.vfg-panel');
      await page.locator('.vfg-close').click();
    });
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
console.log(checked+' homepage/device/interaction cases passed.');
if(failures.length){console.error(failures.join('\n'));process.exitCode=1;}
