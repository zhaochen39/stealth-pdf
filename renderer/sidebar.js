/* 侧栏：缩略图 / 目录。针对「当前标签的焦点窗格」，切换标签 / 窗格 / 文档时自动重建 */
(() => {
  const $ = (id) => document.getElementById(id);
  const A = window.App;
  const side = $('sidebar'), body = $('sbBody');
  let visible = A.pref.get('sidebar', '0') === '1';
  let mode = A.pref.get('sidebarMode', 'thumbs');
  let built = { pane: null, doc: null, mode: null, rot: null };
  let thumbObserver = null;
  let token = 0;

  function setTabsUI() {
    document.querySelectorAll('.sb-tab').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  }

  function toggle(on, m) {
    visible = typeof on === 'boolean' ? on : !visible;
    if (m) mode = m;
    side.hidden = !visible;
    A.pref.set('sidebar', visible ? '1' : '0');
    A.pref.set('sidebarMode', mode);
    setTabsUI();
    if (visible) rebuild();
    A.emit('change');
  }
  function showMode(m) {
    if (visible && mode === m) toggle(false);
    else toggle(true, m);
  }

  function clearBody(msg) {
    if (thumbObserver) { thumbObserver.disconnect(); thumbObserver = null; }
    body.innerHTML = msg ? '<div class="sb-empty">' + msg + '</div>' : '';
  }

  function rebuild() {
    const p = A.pane();
    const my = ++token;
    built = { pane: p, doc: p && p.doc, mode, rot: p && p.rotation };
    if (!p) return clearBody('没有打开的文档');
    if (mode === 'thumbs') buildThumbs(p, my);
    else buildOutline(p, my);
  }

  /* ---------- 缩略图 ---------- */
  function buildThumbs(p, my) {
    clearBody();
    const W = 150, dpr = window.devicePixelRatio || 1;
    thumbObserver = new IntersectionObserver((entries) => {
      entries.forEach(async (en) => {
        if (!en.isIntersecting) return;
        const el = en.target;
        thumbObserver && thumbObserver.unobserve(el);
        const i = +el.dataset.idx;
        try {
          const page = await p.doc.getPage(i + 1);
          if (my !== token) return;
          const vp0 = page.getViewport({ scale: 1, rotation: ((page.rotate || 0) + p.rotation) % 360 });
          const s = W / vp0.width;
          const vp = page.getViewport({ scale: s, rotation: vp0.rotation });
          const c = el.querySelector('canvas');
          c.width = Math.floor(vp.width * dpr); c.height = Math.floor(vp.height * dpr);
          c.style.width = vp.width + 'px'; c.style.height = vp.height + 'px';
          await page.render({ canvasContext: c.getContext('2d'), viewport: vp, transform: [dpr, 0, 0, dpr, 0, 0] }).promise;
        } catch (_) {}
      });
    }, { root: body, rootMargin: '300px 0px' });
    for (let i = 0; i < p.doc.numPages; i++) {
      const el = document.createElement('div');
      el.className = 'thumb';
      el.dataset.idx = i;
      el.innerHTML = '<canvas width="150" height="200" style="width:150px;height:200px"></canvas><span class="t-no">' + (i + 1) + '</span>';
      el.onclick = () => A.scrollToPage(p, i);
      body.appendChild(el);
      thumbObserver.observe(el);
    }
    markCurrent();
  }

  function markCurrent() {
    if (!visible || mode !== 'thumbs') return;
    const p = A.pane();
    if (!p || p !== built.pane) return;
    const cur = Math.max(0, A.currentPageIndex(p));
    let curEl = null;
    body.querySelectorAll('.thumb').forEach((t) => {
      const on = +t.dataset.idx === cur;
      t.classList.toggle('current', on);
      if (on) curEl = t;
    });
    if (curEl) {
      const r = curEl.getBoundingClientRect(), b = body.getBoundingClientRect();
      if (r.top < b.top || r.bottom > b.bottom) curEl.scrollIntoView({ block: 'nearest' });
    }
  }

  /* ---------- 目录 ---------- */
  async function buildOutline(p, my) {
    clearBody('正在读取目录…');
    let outline = null;
    try { outline = await p.doc.getOutline(); } catch (_) {}
    if (my !== token) return;
    if (!outline || !outline.length) return clearBody('此文档没有目录（书签）');
    body.innerHTML = '';
    const go = async (it) => {
      try {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await p.doc.getDestination(dest);
        if (!Array.isArray(dest)) return;
        const ref = dest[0];
        const idx = typeof ref === 'object' && ref !== null ? await p.doc.getPageIndex(ref) : ref;
        A.scrollToPage(p, idx);
      } catch (_) {}
    };
    const render = (items, parent, depth) => {
      items.forEach((it) => {
        const wrap = document.createElement('div');
        const row = document.createElement('div');
        row.className = 'ol-row';
        const hasKids = it.items && it.items.length;
        const tg = document.createElement('span');
        tg.className = 'ol-toggle' + (hasKids && depth === 0 ? ' open' : '');
        tg.innerHTML = hasKids ? window.icon('chevright') : '';
        const title = document.createElement('span');
        title.className = 'ol-title';
        title.textContent = it.title || '（无标题）';
        if (it.bold) title.style.fontWeight = '600';
        if (it.italic) title.style.fontStyle = 'italic';
        row.append(tg, title);
        row.onclick = () => go(it);
        wrap.appendChild(row);
        if (hasKids) {
          const kids = document.createElement('div');
          kids.className = 'ol-kids';
          kids.hidden = depth !== 0;
          render(it.items, kids, depth + 1);
          wrap.appendChild(kids);
          tg.onclick = (e) => { e.stopPropagation(); kids.hidden = !kids.hidden; tg.classList.toggle('open', !kids.hidden); };
        }
        parent.appendChild(wrap);
      });
    };
    render(outline, body, 0);
  }

  document.querySelectorAll('.sb-tab').forEach((b) => (b.onclick = () => { mode = b.dataset.mode; toggle(true); }));

  A.on('change', () => {
    if (!visible) return;
    const p = A.pane();
    if (!p ? built.pane !== null : (p !== built.pane || p.doc !== built.doc || mode !== built.mode || p.rotation !== built.rot)) rebuild();
  });
  A.on('page', markCurrent);

  A.toggleSidebar = toggle;
  A.showSidebarMode = showMode;
  A.sidebar = { get visible() { return visible; }, get mode() { return mode; } };
  side.hidden = !visible;
  setTabsUI();
  if (visible) rebuild();
})();
