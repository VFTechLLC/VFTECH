(function(){
  'use strict';
  var settings=window.VFTechServices||{},catalog=window.VFTechPrices||{builds:[],plans:[]};
  var contact=document.getElementById('book-form'),signin=document.getElementById('vf-account-form');
  function element(tag,cls,text){var node=document.createElement(tag);if(cls)node.className=cls;if(text)node.textContent=text;return node;}
  function plan(id){return catalog.builds.concat(catalog.plans).find(function(p){return p.id===id;});}
  var api;
  try{api=settings.apiBase?new URL(settings.apiBase.replace(/\/$/,'')+'/',location.origin):null;if(api&&api.origin!==location.origin)api=null;}catch{api=null;}
  async function call(path,data,csrf){var headers={'Accept':'application/json'};if(data!==undefined)headers['Content-Type']='application/json';if(csrf)headers['X-CSRF-Token']=csrf;var response=await fetch(new URL(path,api),{method:data===undefined?'GET':'POST',credentials:'same-origin',headers:headers,body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(15000)});var result;try{result=await response.json();}catch{throw Error('The service could not respond. Please try again.');}if(!response.ok)throw Error(result.error||'The request could not be completed.');return result;}
  // Subscribe buttons on the plan cards (features page) only show when the Worker has billing switched on.
  // In test mode (sandbox key) they show only for signed-in testers, once /api/billing says billing is on for them.
  function showSubscribe(){document.querySelectorAll('[data-vf-subscribe]').forEach(function(link){link.hidden=false;});}
  if(settings.billingEnabled)showSubscribe();
  else if(settings.billingTest&&api&&document.querySelector('[data-vf-subscribe]'))call('billing').then(function(d){if(d&&d.enabled)showSubscribe();}).catch(function(){});
  var loader;
  function loadCaptcha(){if(window.turnstile)return Promise.resolve();if(loader)return loader;loader=new Promise(function(resolve,reject){window.vfTechTurnstileReady=resolve;var script=element('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=vfTechTurnstileReady';script.async=true;script.onerror=function(){reject(Error('Verification could not load. Please try again.'));};document.head.append(script);});return loader;}
  function verification(container,action,submit,status){var token='',widget=null;submit.disabled=true;loadCaptcha().then(function(){widget=turnstile.render(container,{sitekey:settings.turnstileSiteKey,action:action,size:'flexible',callback:function(value){token=value;submit.disabled=false;},'expired-callback':function(){token='';submit.disabled=true;status.textContent='Verification expired. Please verify again.';},'error-callback':function(){token='';submit.disabled=true;status.textContent='Verification could not complete. Please try again.';}});}).catch(function(error){status.textContent=error.message;});return {get:function(){return token;},reset:function(){token='';submit.disabled=true;if(widget!==null)turnstile.reset(widget);}};}
  function trap(form){var box=element('div','vfs-trap'),label=element('label','','Leave this field empty'),input=element('input');input.name='website';input.autocomplete='off';input.tabIndex=-1;input.setAttribute('aria-hidden','true');label.append(input);box.append(label);box.setAttribute('aria-hidden','true');form.append(box);return input;}
  if(contact){
    Object.entries({name:80,email:254,business:160,phone:40,times:300,message:4000}).forEach(function(pair){var input=contact.elements.namedItem(pair[0]);if(input)input.maxLength=pair[1];});
    var selected=plan(new URLSearchParams(location.search).get('plan')),selection=element('input');selection.type='hidden';selection.name='planId';selection.value=selected?selected.id:'';contact.append(selection);
    if(selected){var note=element('p','vfs-contact-status','Selected: '+selected.name+' · '+selected.price+'. This requests a discussion; it does not purchase or activate a plan.');contact.prepend(note);}
    var honey=trap(contact),submit=contact.querySelector('button[type=submit]'),hint=document.getElementById('submit-hint');
    if(api&&settings.contactEnabled&&settings.turnstileSiteKey){
      submit.firstChild.textContent='Send my request ';hint.textContent='Complete verification, then send your request to VFTech. Avoid passwords, payment details and sensitive documents. Requests are retained for up to 31 days in the portal.';
      var container=element('div');container.id='vf-contact-captcha';contact.querySelector('.submit-row').before(container);
      var status=element('p','vfs-contact-status');status.id='vf-contact-status';status.setAttribute('role','status');container.after(status);
      var captcha=verification(container,'contact',submit,status),key=crypto.randomUUID(),lastBody='';
      contact.addEventListener('submit',async function(event){
        event.preventDefault();event.stopImmediatePropagation();if(!contact.reportValidity())return;if(!captcha.get()){status.textContent='Complete verification before sending.';return;}
        var fd=new FormData(contact),payload={name:fd.get('name'),email:fd.get('email'),business:fd.get('business'),phone:fd.get('phone'),times:fd.get('times'),topics:fd.getAll('topic'),message:fd.get('message'),planId:selection.value,website:honey.value};
        var fingerprint=JSON.stringify(payload);if(lastBody&&lastBody!==fingerprint)key=crypto.randomUUID();lastBody=fingerprint;payload.idempotencyKey=key;payload.turnstileToken=captcha.get();submit.disabled=true;status.textContent='Sending your request…';
        try{var result=await call('contact',payload);status.textContent='Thanks, your request was sent. We will reply by email soon.';contact.reset();selection.value=selected?selected.id:'';key=crypto.randomUUID();lastBody='';document.getElementById('form-out').hidden=true;}catch(error){status.textContent=error.message||'The request could not be sent. Please try again.';}finally{captcha.reset();}
      },true);
    }else{hint.textContent='Email delivery is not enabled. This form prepares a request for you to copy; nothing is sent.';var output=document.querySelector('#form-out>p');if(output)output.textContent='Nothing has been sent. Copy this request for your records. A business inbox still needs to be configured.';}
  }
  if(signin&&api&&settings.accountsEnabled&&settings.turnstileSiteKey){
    var accountStatus=document.getElementById('vf-service-status'),codeForm=document.getElementById('vf-code-form'),home=document.getElementById('vf-account-home'),signSubmit=signin.querySelector('button[type=submit]'),state={email:'',challengeId:'',csrf:''};
    accountStatus.textContent='Enter your email and complete verification to receive a sign-in code.';
    var accountCaptcha=verification(document.getElementById('vf-account-captcha'),'account',signSubmit,accountStatus),accountHoney=trap(signin);
    var social=null,providers=[['google','Continue with Google',settings.googleEnabled],['microsoft','Continue with Microsoft',settings.microsoftEnabled]].filter(function(p){return p[2];});
    if(providers.length){social=element('div','vfs-social');providers.forEach(function(p){var link=element('a','vfs-button vfs-secondary',p[1]);link.href=new URL('auth/'+p[0]+'/start',api).href;social.append(link);});social.append(element('p','vfs-small','Or get a one-time code by email:'));signin.before(social);}
    var signinError=new URLSearchParams(location.search).get('signin_error');if(signinError){accountStatus.textContent=signinError;history.replaceState(null,'',location.pathname);}
    function showLoggedOut(){home.hidden=true;signin.hidden=false;if(social)social.hidden=false;codeForm.hidden=true;document.getElementById('vf-account-title').textContent='Create an account or sign in';state.csrf='';state.challengeId='';codeForm.reset();}
    async function showAccount(result){state.csrf=result.csrfToken;signin.hidden=true;if(social)social.hidden=true;codeForm.hidden=true;home.hidden=false;document.getElementById('vf-account-title').textContent='Your customer account';state.customer=result.customer;state.plan=result.plan||{tier:'free',name:'Free',status:'none'};renderTier();loadProfile();loadFeatures();accountStatus.textContent='You are signed in.';var list=document.getElementById('vf-requests');list.textContent='Loading your requests…';try{var data=await call('account/requests');list.textContent='';if(!data.requests.length)list.append(element('p','vfs-small','No requests yet. Send a project request using this verified email address.'));data.requests.forEach(function(request){var item=element('article','vfs-request'),selectedPlan=plan(request.planId);item.append(element('strong','',request.business||'Project request'),element('p','',new Date(request.createdAt*1000).toLocaleDateString()+' · '+(request.status==='sent'?'Accepted for email delivery':request.status==='failed'?'Delivery failed':'Processing')),element('p','',request.message));if(selectedPlan)item.append(element('p','',selectedPlan.name+' · '+selectedPlan.price));list.append(item);});}catch(error){list.textContent=error.message;}}
    signin.addEventListener('submit',async function(event){event.preventDefault();if(!signin.reportValidity())return;if(!accountCaptcha.get()){accountStatus.textContent='Complete verification to receive a code.';return;}signSubmit.disabled=true;var fd=new FormData(signin);state.email=String(fd.get('email')).trim().toLowerCase();accountStatus.textContent='Requesting your verification code…';try{var result=await call('auth/request-code',{name:fd.get('name'),email:state.email,website:accountHoney.value,turnstileToken:accountCaptcha.get()});state.challengeId=result.challengeId;signin.hidden=true;codeForm.hidden=false;accountStatus.textContent='A code was accepted for delivery to '+state.email+'. Check your email.';document.getElementById('vf-code').focus();}catch(error){accountStatus.textContent=error.message;}finally{accountCaptcha.reset();}});
    codeForm.addEventListener('submit',async function(event){event.preventDefault();if(!codeForm.reportValidity())return;var submit=codeForm.querySelector('button[type=submit]');submit.disabled=true;accountStatus.textContent='Verifying your code…';try{var result=await call('auth/verify-code',{email:state.email,challengeId:state.challengeId,code:document.getElementById('vf-code').value});codeForm.reset();await showAccount(result);}catch(error){accountStatus.textContent=error.message;}finally{submit.disabled=false;}});
    document.getElementById('vf-change-email').addEventListener('click',function(){showLoggedOut();accountCaptcha.reset();accountStatus.textContent='Enter your email and complete verification for a new code.';document.getElementById('vf-email').focus();});
    document.getElementById('vf-logout').addEventListener('click',async function(){this.disabled=true;try{await call('auth/logout',{},state.csrf);showLoggedOut();accountCaptcha.reset();accountStatus.textContent='You are signed out.';}catch(error){accountStatus.textContent=error.message;}finally{this.disabled=false;}});
    // Billing (backend/billing.js): the customer's plan, Manage billing (Stripe's portal: card, invoices, cancel) and
    // invoices with tax. Subscribing goes through Stripe Checkout after the Terms are accepted. Only when the Worker
    // says billing is on.
    var billingBox=document.getElementById('vf-billing'),billingBody=document.getElementById('vf-billing-body');
    var query=new URLSearchParams(location.search),wantedPlan=query.get('subscribe')||query.get('buy'),billingResult=query.get('billing');
    try{if(wantedPlan&&plan(wantedPlan))sessionStorage.setItem('vf-subscribe',wantedPlan);else wantedPlan=sessionStorage.getItem('vf-subscribe');}catch{}
    if(wantedPlan&&!plan(wantedPlan))wantedPlan=null;
    function monthly(id){return catalog.plans.some(function(p){return p.id===id;});}
    if(billingResult||query.get('subscribe')||query.get('buy'))history.replaceState(null,'',location.pathname);
    if(wantedPlan&&settings.billingEnabled)accountStatus.textContent='Sign in to '+(monthly(wantedPlan)?'subscribe to ':'pay for ')+plan(wantedPlan).name+'.';
    function money(cents,currency){return (cents/100).toLocaleString('en-US',{style:'currency',currency:(currency||'usd').toUpperCase()});}
    function day(seconds){return new Date(seconds*1000).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});}
    async function goTo(path,data,button){button.disabled=true;try{var result=await call(path,data,state.csrf);location.href=result.url;}catch(error){accountStatus.textContent=error.message;button.disabled=false;}}
    function subscribeForm(id){
      var chosen=plan(id),recurring=monthly(id),form=element('form','vfs-form vfs-subscribe');
      form.append(element('p','',recurring?'Subscribe to '+chosen.name+' for '+chosen.price.replace('/mo',' a month')+', plus tax where it applies. Billed monthly; cancel any time from this page.':'Pay for '+chosen.name+': '+chosen.price.replace(' Fixed','')+' one-time, plus tax where it applies. The receipt will appear in your billing history.'));
      var label=element('label','vfs-check'),box=element('input');box.type='checkbox';box.required=true;box.id='vf-accept-terms';label.append(box,document.createTextNode(' I have read and agree to the '));var link=element('a','','Terms of Service');link.href='terms.html';link.target='_blank';label.append(link,document.createTextNode(' (version '+(catalog.termsVersion||'1.0')+')'+(recurring?', including section 5 for '+chosen.name+'. Renews automatically; no refunds for partial periods.':'.')));
      var go=element('button','vfs-button','Continue to secure payment');go.type='submit';
      var other=element('button','vfs-button vfs-secondary',recurring?'Choose another plan':'Not now');other.type='button';other.addEventListener('click',function(){try{sessionStorage.removeItem('vf-subscribe');}catch{}renderBilling({enabled:true,subscription:null,invoices:[]});});
      form.append(label,go,other);
      form.addEventListener('submit',function(event){event.preventDefault();if(!form.reportValidity())return;try{sessionStorage.removeItem('vf-subscribe');}catch{}accountStatus.textContent='Opening secure payment…';goTo('billing/checkout',{itemId:id,acceptTerms:true},go);});
      return form;
    }
    // Accounts & Subscriptions spec, phase 1: plan header with badge and tier theme, profile editing, the plan
    // features hub and Manage subscription (upgrade now, switch at renewal, cancel to Free, undo).
    var TIERS=['free','essentials','standard','priority'];
    function tierName(id){return id==='free'?'Free':(plan(id)||{name:id}).name;}
    function renderTier(){
      var p=state.plan||{tier:'free',status:'none'},c=state.customer||{},tier=TIERS.indexOf(p.tier)>=0?p.tier:'free',nm=String(c.name||'').trim();
      document.getElementById('vf-tier-card').className='vfs-tier vfs-tier-'+tier;
      document.getElementById('vf-avatar').textContent=(nm?nm.split(/\s+/).slice(0,2).map(function(w){return w.charAt(0);}).join(''):String(c.email||'?').charAt(0)).toUpperCase();
      document.getElementById('vf-profile').textContent=nm||'Customer';
      document.getElementById('vf-profile-sub').textContent=[state.business,c.email].filter(Boolean).join(' · ');
      document.getElementById('vf-plan-badge').textContent=tier==='priority'?'★ Priority':tierName(tier);
      var line='No plan yet · Free account, no service plan';
      if(p.status==='past_due'||p.status==='unpaid'||p.status==='incomplete')line=(p.name||'Your plan')+' · payment failed: update your payment method below';
      else if(p.status!=='none'&&p.cancelAtPeriodEnd&&p.periodEnd)line='Ends '+day(p.periodEnd)+', then Free';
      else if(p.status!=='none'&&p.pendingPlanName&&p.periodEnd)line='Changes to '+p.pendingPlanName+' on '+day(p.periodEnd);
      else if(p.status!=='none'&&p.periodEnd)line='Renews '+day(p.periodEnd)+' · '+((plan(p.planId)||{}).price||'');
      document.getElementById('vf-plan-line').textContent=line;
    }
    async function loadProfile(){try{var pr=(await call('account/profile')).profile;state.business=pr.business||'';document.getElementById('vf-p-name').value=pr.name||'';document.getElementById('vf-p-business').value=pr.business||'';document.getElementById('vf-p-phone').value=pr.phone||'';renderTier();}catch{}}
    var profileForm=document.getElementById('vf-profile-form');
    if(profileForm)profileForm.addEventListener('submit',async function(event){event.preventDefault();var save=profileForm.querySelector('button[type=submit]');save.disabled=true;var fd=new FormData(profileForm);try{var pr=(await call('account/profile',{name:fd.get('name'),business:fd.get('business'),phone:fd.get('phone')},state.csrf)).profile;state.customer.name=pr.name;state.business=pr.business;renderTier();document.getElementById('vf-profile-edit').open=false;accountStatus.textContent='Profile saved.';}catch(error){accountStatus.textContent=error.message;}finally{save.disabled=false;}});
    async function loadFeatures(){
      var body=document.getElementById('vf-features-body');if(!body)return;body.textContent='Loading…';
      try{
        var d=await call('account/features');body.textContent='';
        var list=element('ul','vfs-feature-list');
        d.included.forEach(function(f){var li=element('li','vfs-feature'),text=element('div');text.append(element('strong','',f.label));if(f.detail)text.append(element('span','vfs-small',f.detail));li.append(text);
          if(f.href){var a=element('a','vfs-button vfs-secondary',f.id==='phone'?'Call':f.id==='email'?'Email':'Open');a.href=f.href;if(f.type==='portal'){a.target='_blank';a.rel='noopener';}li.append(a);}list.append(li);});
        body.append(list);
        if(d.locked.length){body.append(element('h4','','Available on higher plans'));var locked=element('ul','vfs-feature-list vfs-locked');
          d.locked.forEach(function(f){var li=element('li','vfs-feature'),text=element('div');text.append(element('strong','',f.label),element('span','vfs-small','Included in '+f.unlockPlanName));li.append(text);locked.append(li);});
          body.append(locked);var compare=element('button','vfs-button vfs-secondary','Compare plans');compare.type='button';compare.addEventListener('click',function(){if(billingBox&&!billingBox.hidden)billingBox.scrollIntoView({behavior:'smooth',block:'start'});else location.href='features.html';});body.append(compare);}
      }catch(error){body.textContent=error.message;}
    }
    async function refreshAccount(){billingResult=null;try{var s=await call('session');if(s.authenticated){state.plan=s.plan;renderTier();}}catch{}loadFeatures();loadBilling();}
    function planPicker(sub){
      var grid=element('div','vfs-plan-grid'),rank=function(id){return TIERS.indexOf(id);},until=sub.currentPeriodEnd?day(sub.currentPeriodEnd):'';
      TIERS.forEach(function(id){
        var card=element('div','vfs-plan-card vfs-tier-'+id),p=plan(id),label,kind=null;
        card.append(element('strong','',id==='priority'?'★ Priority':tierName(id)),element('span','vfs-small',id==='free'?'$0 · no service plan':p.price.replace('/mo',' a month')));
        if(id===sub.planId){if(sub.cancelAtPeriodEnd){label='Keep '+tierName(id);kind='resume';}else if(sub.pendingPlanId){label='Keep '+tierName(id);kind='undo';}else label='Your plan';}
        else if(id==='free'){if(sub.cancelAtPeriodEnd)label='From '+until;else{label='Cancel plan';kind='free';}}
        else if(id===sub.pendingPlanId)label='Starts '+until;
        else if(rank(id)>rank(sub.planId)){label='Upgrade now';kind='up';}
        else{label='Switch at renewal';kind='down';}
        var button=element('button','vfs-button'+(kind==='up'?'':' vfs-secondary'),label);button.type='button';
        if(kind)button.addEventListener('click',function(){confirmChange(id,kind,sub,grid);});else button.disabled=true;
        card.append(button);grid.append(card);
      });
      return grid;
    }
    function confirmChange(id,kind,sub,anchor){
      var previous=document.getElementById('vf-change-form');if(previous)previous.remove();
      var form=element('form','vfs-form vfs-subscribe'),name=tierName(id),until=sub.currentPeriodEnd?day(sub.currentPeriodEnd):'the end of your billing period',needTerms=kind==='up'||kind==='down';form.id='vf-change-form';
      form.append(element('p','',{up:'Upgrade to '+name+' now. Today you pay the prorated difference for the rest of this billing period; after that, '+((plan(id)||{}).price||'').replace('/mo',' a month')+' plus tax where it applies.',down:'Switch to '+name+' on '+until+'. You keep '+tierName(sub.planId)+' until then, and nothing is charged today.',free:'Cancel your plan. It stays active until '+until+', then your account continues as Free, with no service plan. No refund for the current period.',resume:'Keep '+name+'. It will renew as usual on '+until+'.',undo:'Keep '+name+' and cancel the scheduled change.'}[kind]));
      if(needTerms){var label=element('label','vfs-check'),box=element('input');box.type='checkbox';box.required=true;label.append(box,document.createTextNode(' I have read and agree to the '));var link=element('a','','Terms of Service');link.href='terms.html';link.target='_blank';label.append(link,document.createTextNode(' (version '+(catalog.termsVersion||'1.0')+'), including section 5 for '+name+'.'));form.append(label);}
      var go=element('button','vfs-button',{up:'Upgrade and pay the difference',down:'Schedule the switch',free:'Cancel plan',resume:'Keep my plan',undo:'Keep my plan'}[kind]);go.type='submit';
      var back=element('button','vfs-button vfs-secondary','Never mind');back.type='button';back.addEventListener('click',function(){form.remove();});
      var note=element('p','vfs-small vfs-form-note');note.setAttribute('role','alert');
      form.append(note,go,back);
      form.addEventListener('submit',async function(event){event.preventDefault();if(!form.reportValidity())return;go.disabled=true;note.textContent='';accountStatus.textContent='Updating your plan…';
        try{await call('billing/change-plan',{planId:kind==='resume'||kind==='undo'?sub.planId:id,acceptTerms:needTerms},state.csrf);
          accountStatus.textContent={up:'You’re on '+name+' now.',down:'Switch to '+name+' scheduled for '+until+'.',free:'Plan cancelled. It stays active until '+until+'.',resume:'Your plan will renew as usual.',undo:'Scheduled change cancelled.'}[kind];await refreshAccount();}
        catch(error){accountStatus.textContent=error.message;note.textContent=error.message;go.disabled=false;}});
      anchor.after(form);box?box.focus():go.focus();
    }
    function renderBilling(data){
      billingBody.textContent='';
      var sub=data.subscription;
      if(sub){
        var states={active:'Active',trialing:'Active',past_due:'Payment failed',unpaid:'Payment failed',incomplete:'Waiting for payment'};
        var line=element('p','vfs-plan-line');line.append(element('strong','',sub.planName+' plan'),document.createTextNode(' · '+(states[sub.status]||sub.status)));billingBody.append(line);
        if(sub.currentPeriodEnd)billingBody.append(element('p','vfs-small',sub.cancelAtPeriodEnd?'Cancelled: active until '+day(sub.currentPeriodEnd)+', then it stops. No further charges.':'Renews on '+day(sub.currentPeriodEnd)+'.'));
        if(sub.status==='past_due'||sub.status==='unpaid')billingBody.append(element('p','vfs-status','Your last payment didn’t go through. Update your payment method below to keep the plan.'));
        if(sub.pendingPlanName&&sub.currentPeriodEnd)billingBody.append(element('p','vfs-small','Switching to '+sub.pendingPlanName+' on '+day(sub.currentPeriodEnd)+'.'));
        if(sub.status==='active'||sub.status==='trialing')billingBody.append(planPicker(sub));
      }
      if(wantedPlan&&!(sub&&monthly(wantedPlan))){billingBody.append(subscribeForm(wantedPlan));}
      else if(sub){if(wantedPlan)accountStatus.textContent='You already have a plan. Use Manage billing to change or cancel it.';}
      else{
        billingBody.append(element('p','vfs-small','You don’t have a monthly plan yet.'));
        var choices=element('div','vfs-plan-choices');catalog.plans.forEach(function(p){var b=element('button','vfs-button vfs-secondary','Choose '+p.name+' · '+p.price);b.type='button';b.addEventListener('click',function(){wantedPlan=p.id;renderBilling(data);});choices.append(b);});billingBody.append(choices);
      }
      if(sub||data.invoices.length){var manage=element('button','vfs-button vfs-secondary','Payment methods and invoices');manage.type='button';manage.addEventListener('click',function(){accountStatus.textContent='Opening billing…';goTo('billing/portal',{},manage);});billingBody.append(manage);}
      if(data.invoices.length){
        billingBody.append(element('h4','','Billing history'));
        var table=element('table','vfs-invoices'),head=element('tr');['Date','Invoice','Amount','Tax','Status',''].forEach(function(h){head.append(element('th','',h));});var thead=element('thead');thead.append(head);table.append(thead);var tbody=element('tbody');
        data.invoices.forEach(function(inv){var row=element('tr');[day(inv.date),inv.number||'—',money(inv.total,inv.currency),money(inv.tax||0,inv.currency),inv.status==='paid'?'Paid':inv.status==='open'?'Due':inv.status].forEach(function(v){row.append(element('td','',v));});var cell=element('td');if(inv.url){var a=element('a','','View');a.href=inv.url;a.target='_blank';a.rel='noopener';cell.append(a);}if(inv.pdf){var p=element('a','',' PDF');p.href=inv.pdf;p.target='_blank';p.rel='noopener';cell.append(p);}row.append(cell);tbody.append(row);});
        table.append(tbody);billingBody.append(table);
      }
    }
    async function loadBilling(){
      if(!(settings.billingEnabled||settings.billingTest)||!billingBox)return;
      billingBox.hidden=false;billingBody.textContent='Loading your plan…';
      if(billingResult==='success')accountStatus.textContent='Thank you. Your plan is set up; it may take a moment to show here.';
      if(billingResult==='paid')accountStatus.textContent='Thank you, your payment went through. The receipt is in your billing history.';
      if(billingResult==='cancelled')accountStatus.textContent='Payment cancelled. Nothing was charged.';
      try{var data=await call('billing');if(!data.enabled){billingBox.hidden=true;return;}if(!settings.billingEnabled)showSubscribe();renderBilling(data);}catch(error){billingBody.textContent=error.message;}
    }
    var baseShowAccount=showAccount;showAccount=async function(result){await baseShowAccount(result);loadBilling();};
    call('session').then(function(result){if(result.authenticated)showAccount(result);}).catch(function(){accountStatus.textContent='The account service could not be reached. Please try again later.';signSubmit.disabled=true;});
  }
})();
