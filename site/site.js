/* VFTech, shared behaviour: theme toggle, menu, copy buttons, contact form.
   Each page also carries a one-line inline script in <head> that applies a saved theme before paint. */
(function () {
  var root = document.documentElement;
  var mqDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : { matches: false };

  /* ---- theme ---- */
  function current() { return root.getAttribute('data-theme') || (mqDark.matches ? 'dark' : 'light'); }
  var themeBtn = document.querySelector('.theme-btn');
  function labelTheme() {
    var dark = current() === 'dark';
    document.querySelectorAll('.theme-btn, .ds-theme').forEach(function (btn) {
      btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
      btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
      if (btn.classList.contains('ds-theme')) btn.querySelector('span').textContent = dark ? 'Dark' : 'Light';
    });
  }
  function toggleTheme() {
    var next = current() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('vftech-theme', next); } catch (e) {}
    labelTheme();
  }
  if (themeBtn) {
    labelTheme();
    themeBtn.addEventListener('click', toggleTheme);
    if (mqDark.addEventListener) mqDark.addEventListener('change', labelTheme);
  }

  /* ---- menu (under 1100px) ---- */
  var menuBtn = document.querySelector('.menu-btn');
  var nav = document.getElementById('site-nav');
  /* Sign in / account link, added here once instead of in every page's menu. Sits before Contact. */
  (function () {
    var list = nav && nav.querySelector('ul');
    if (!list || list.querySelector('a[href="account.html"]')) return;
    var item = document.createElement('li'), link = document.createElement('a');
    link.href = 'account.html'; link.textContent = 'Sign in';
    if (/\/account\.html$/.test(location.pathname)) link.setAttribute('aria-current', 'page');
    item.appendChild(link);
    var contact = list.querySelector('a.tab');
    list.insertBefore(item, contact ? contact.closest('li') : null);
  })();
  var mobileNav = matchMedia('(max-width: 1100px)');
  function setMenu(open) {
    if (!menuBtn || !nav) return;
    open = !!open && mobileNav.matches;
    menuBtn.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('open', open);
  }
  if (menuBtn && nav) {
    // Reset disclosure state across desktop/mobile and orientation changes.
    function resetMenu() {
      var focused = nav.contains(document.activeElement);
      setMenu(false);
      if (focused && mobileNav.matches) menuBtn.focus();
    }
    if (mobileNav.addEventListener) mobileNav.addEventListener('change', resetMenu);
    else mobileNav.addListener(resetMenu);
    nav.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
    root.classList.add('nav-ready');
    menuBtn.addEventListener('click', function () {
      var open = menuBtn.getAttribute('aria-expanded') !== 'true';
      setMenu(open);
      /* the nav comes before this button in the source, so move focus into it; otherwise Tab lands on the page underneath the open menu */
      var first = open && nav.querySelector('a');
      if (first) first.focus();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menuBtn.getAttribute('aria-expanded') === 'true') { setMenu(false); menuBtn.focus(); }
    });
    document.addEventListener('click', function (e) {
      if (menuBtn.getAttribute('aria-expanded') === 'true' && !nav.contains(e.target) && !menuBtn.contains(e.target)) setMenu(false);
    });
    document.addEventListener('focusin', function (e) { /* tabbing out of the open menu closes it */
      if (menuBtn.getAttribute('aria-expanded') === 'true' && !nav.contains(e.target) && !menuBtn.contains(e.target)) setMenu(false);
    });
  }

  /* ---- copy to clipboard, falling back to selecting the text ---- */
  function selectText(el) {
    try { var r = document.createRange(); r.selectNodeContents(el); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } catch (e) {}
  }
  function copyFrom(el, btn, idle) {
    var text = el.value !== undefined && el.tagName !== 'CODE' ? el.value : el.textContent;
    function say(t) { btn.textContent = t; setTimeout(function () { btn.textContent = idle; }, 2200); }
    function fallback() { selectText(el); say('Selected: press Ctrl+C'); }
    try {
      navigator.clipboard.writeText(text).then(function () { say('Copied'); }, fallback);
    } catch (e) { fallback(); }
  }
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    var idle = btn.textContent;
    btn.addEventListener('click', function () {
      var el = document.getElementById(btn.getAttribute('data-copy'));
      if (el) copyFrom(el, btn, idle);
    });
  });

  /* ---- shared motion: chrome hero, schematic figures and footer pattern ---- */
  var foot = document.querySelector('.site-foot');
  var motionButtons = document.querySelectorAll('.motion-btn, [data-motion-control]');
  root.classList.add('motion-controls-ready');
  function setPaused(paused) {
    root.classList.toggle('motion-paused', paused);
    if (foot) foot.classList.toggle('paused', paused);
    motionButtons.forEach(function (btn) {
      if (btn.hasAttribute('data-motion-icon')) {
        // icon toggle: a constant name, with the state carried by aria-pressed and the icon
        btn.setAttribute('aria-pressed', String(paused));
        btn.title = paused ? 'Resume motion' : 'Pause motion';
      } else {
        // text button: the label itself says what the next click does
        btn.textContent = paused ? 'Resume motion' : 'Pause motion';
        btn.removeAttribute('aria-pressed');
      }
    });
    document.dispatchEvent(new CustomEvent('vftech:motion-change'));
  }
  // A pause lasts for this visit only, so motion is back on the next one. (The old permanent
  // preference is cleared, so nobody stays stuck on a pause made while testing.)
  // Motion always plays by default; there is no on-page pause control.
  try { localStorage.removeItem('vftech-pattern'); sessionStorage.removeItem('vftech-motion'); } catch (e) {}
  setPaused(false);
  motionButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var paused = !root.classList.contains('motion-paused');
      setPaused(paused);
      try { sessionStorage.setItem('vftech-motion', paused ? 'paused' : 'moving'); } catch (e) {}
    });
  });

  // Reveal the technical drawings when they enter the viewport. Content stays
  // fully visible without JS, and each diagram is animated only while in view.
  if ('IntersectionObserver' in window) {
    var diagrams = document.querySelectorAll('.hero-figure, .flowfig');
    var drawingObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        entry.target.classList.toggle('drawing-in-view', entry.isIntersecting);
        if (entry.isIntersecting) entry.target.classList.add('drawing-revealed');
      });
    }, { threshold: 0.12 });
    diagrams.forEach(function (diagram) {
      diagram.classList.add('drawing-motion');
      drawingObserver.observe(diagram);
    });
  }
  /* ---- scroll reveal: sheet content rises into place as it enters the viewport ----
     Rows of a list reveal one by one; otherwise each block reveals whole. Items entering together are
     staggered in reading order. Nothing is hidden until this runs, so content never depends on it. */
  if ('IntersectionObserver' in window && !document.querySelector('script[data-vf-motion-suite]')) {
    var ROWS = '.ledger > div, .sits > .sit, .tier, .steps > li, .decl li, .frame .cell, .tours > *, .parts > *';
    var BLOCKS = '.page-head-grid > div > *, .page-head-grid > :not(div), .sect-aside > *, .sect-grid > :not(.sect-aside) > *, .closing-grid > *, .tblock, .foot-meta';
    var revealEls = [];
    document.querySelectorAll(ROWS).forEach(function (el) { if (!el.closest('.hero')) revealEls.push(el); });
    document.querySelectorAll(BLOCKS).forEach(function (el) {
      if (el.closest('.hero') || el.matches(ROWS) || el.querySelector(ROWS) || el.parentElement.closest(ROWS)) return;
      revealEls.push(el);
    });
    var revealObserver = new IntersectionObserver(function (entries) {
      var batch = entries.filter(function (e) { return e.isIntersecting; }).map(function (e) { return e.target; });
      batch.sort(function (a, b) { return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1; });
      batch.forEach(function (el, i) {
        el.style.setProperty('--rd', Math.min(i, 4) * 0.05 + 's');
        el.classList.add('in');
        revealObserver.unobserve(el);
      });
    }, { rootMargin: '0px 0px 12% 0px', threshold: 0 });
    revealEls.forEach(function (el) { el.classList.add('reveal'); revealObserver.observe(el); });
    // A safety net, so nothing can stay hidden: anything at or above the bottom of the screen is shown,
    // and reaching the end of the page shows the rest (the last lines can sit too low to ever "enter").
    var sweepQueued = false;
    var sweep = function () {
      sweepQueued = false;
      var atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      document.querySelectorAll('.reveal:not(.in)').forEach(function (el) {
        if (atEnd || el.getBoundingClientRect().top < window.innerHeight * 1.12) { el.classList.add('in'); revealObserver.unobserve(el); }
      });
    };
    window.addEventListener('scroll', function () { if (!sweepQueued) { sweepQueued = true; requestAnimationFrame(sweep); } }, { passive: true });
    window.addEventListener('load', function () { setTimeout(sweep, 600); });

    // the heavy rule over each list or table draws across from the left
    var ruleObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); ruleObserver.unobserve(e.target); } });
    }, { threshold: 0.05 });
    document.querySelectorAll('.ledger, .sits, .tiers, .steps, .toc ul, .table-wrap').forEach(function (el) {
      el.classList.add('rule-draw'); ruleObserver.observe(el);
    });
    root.classList.add('reveal-ready');
  }

  /* ---- header: a soft shadow lifts it off the sheet once the page scrolls ---- */
  var head = document.querySelector('.site-head');
  if (head) {
    var syncHead = function () { head.classList.toggle('scrolled', window.scrollY > 4); };
    window.addEventListener('scroll', syncHead, { passive: true });
    syncHead();

    // reading progress: a dimension line along the header's bottom edge, measuring how far down the sheet you are
    var prog = document.createElement('div');
    prog.className = 'read-progress';
    prog.setAttribute('aria-hidden', 'true');
    prog.innerHTML = '<i></i>';
    head.appendChild(prog);
    var progQueued = false;
    var syncProgress = function () {
      progQueued = false;
      var max = document.documentElement.scrollHeight - window.innerHeight;
      prog.style.setProperty('--p', max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)).toFixed(4) : '0');
    };
    window.addEventListener('scroll', function () { if (!progQueued) { progQueued = true; requestAnimationFrame(syncProgress); } }, { passive: true });
    window.addEventListener('resize', syncProgress);
    syncProgress();
  }

  /* ---- studio hero: aim the key light at the 3D mark, wherever the layout puts it ---- */
  var studio = document.querySelector('.hero--studio');
  var stage = studio && studio.querySelector('.chrome-stage');
  if (studio && stage) {
    var aimLight = function () {
      var h = studio.getBoundingClientRect(), s = stage.getBoundingClientRect();
      if (!s.width) return;
      studio.style.setProperty('--mark-x', (s.left - h.left + s.width / 2).toFixed(1) + 'px');
      studio.style.setProperty('--mark-y', (s.top - h.top + s.height * 0.48).toFixed(1) + 'px');  // the mark's optical centre
      studio.style.setProperty('--mark-w', s.width.toFixed(1) + 'px');
    };
    aimLight();
    if ('ResizeObserver' in window) { var aim = new ResizeObserver(aimLight); aim.observe(studio); aim.observe(stage); }
    else window.addEventListener('resize', aimLight);
  }

  function syncPageVisibility() { root.classList.toggle('page-hidden', document.hidden); }
  document.addEventListener('visibilitychange', syncPageVisibility);
  syncPageVisibility();

  /* ---- contact form: not connected to delivery yet, so compose the request and offer to copy it ---- */
  var form = document.getElementById('book-form');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!form.checkValidity()) { form.reportValidity(); return; }
      var fd = new FormData(form);
      var lines = [
        'Request: free 30-minute conversation',
        'Name: ' + (fd.get('name') || ''),
        'Business: ' + (fd.get('business') || '—'),
        'Plan: ' + (fd.get('planId') || 'Not selected'),
        'Email: ' + (fd.get('email') || ''),
        'Phone: ' + (fd.get('phone') || '—'),
        'Topic: ' + (fd.getAll('topic').join(', ') || '—'),
        'Best times: ' + (fd.get('times') || '—'),
        '',
        "What's broken:",
        fd.get('message') || ''
      ];
      var out = document.getElementById('form-out');
      var pre = document.getElementById('form-text');
      pre.textContent = lines.join('\n');
      out.hidden = false;
      out.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
      var focusTarget = document.getElementById('form-out-title');
      if (focusTarget) focusTarget.focus();
    });
  }

  /* ---- design switcher: the same page in each of the five designs (published side by side) ---- */
  (function () {
    var HERE = 1, ROOT = '../';   // this design, and the path from here to the site root
    var file = root.getAttribute('data-page') || location.pathname.split('/').pop();   // the 404 page names itself index.html
    if (!/^[\w-]+\.html$/.test(file)) file = 'index.html';
    var page = file === 'index.html' ? '' : file;
    function href(n) {
      if (n === 3) return (ROOT || './') + page;
      return ROOT + 'design-' + n + '/' + (page || 'index.html');
    }
    var names = ['Drafting', 'Kiln', 'Signal', 'Phosphor', 'Orbit'];
    var seg = names.map(function (name, i) {
      var n = i + 1, label = '<b>' + n + '</b><span class="ds-name">' + name + '</span>';
      return n === HERE ? '<span aria-current="page">' + label + '</span>'
                        : '<a href="' + href(n) + '" aria-label="Open this page in design ' + n + ', ' + name + '">' + label + '</a>';
    }).join('');
    var bar = document.createElement('nav');
    bar.className = 'design-switch';
    bar.setAttribute('aria-label', 'Design and theme');
    bar.innerHTML = '<span class="ds-label">Design</span><span class="ds-seg" style="--count:' + names.length + ';--on:' + HERE + '">' + seg + '</span>';
    bar.querySelectorAll('.ds-seg a').forEach(function (a) {
      a.addEventListener('click', function (e) {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
        e.preventDefault();
        var n = [].indexOf.call(a.parentNode.children, a) + 1;
        a.parentNode.style.setProperty('--on', n);   // slide the highlight across, then go
        setTimeout(function () { location.href = a.href; }, root.classList.contains('motion-paused') ? 0 : 230);
      });
    });
    var compare = document.createElement('a');
    compare.className = 'ds-compare';
    compare.href = ROOT + 'compare.html';
    compare.setAttribute('aria-label', 'Compare all five designs');
    compare.innerHTML = '<span>Compare</span><i aria-hidden="true">↗</i>';
    bar.appendChild(compare);
    // the light/dark theme, beside the design choice
    var tb = document.createElement('button');
    tb.type = 'button';
    tb.className = 'ds-theme';
    tb.innerHTML = '<svg viewBox="0 0 18 16" aria-hidden="true" focusable="false"><path class="half" d="M1 1.5h8v13.3Z"/><path class="outline" d="M1 1.5h16L9 14.8Z"/></svg><span></span>';
    tb.addEventListener('click', toggleTheme);
    bar.appendChild(tb);
    document.body.appendChild(bar);
    labelTheme();
  })();
})();
