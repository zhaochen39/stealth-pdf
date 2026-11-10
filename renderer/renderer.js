/* StealthPDF 渲染进程：pdf.js 负责显示，标注保存在内存，点「保存」时由主进程写入 PDF */
(() => {
  const $ = (id) => document.getElementById(id);
  const stage = $('stage'), panesEl = $('panes');
  const api = window.api;

  /* ---------- 提示条 ---------- */
  let toastTimer = null;
  function showToast(msg, isErr, sticky) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('err', !!isErr);
    t.classList.add('show');
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => t.classList.remove('show'), isErr ? 6000 : 2500);
  }
  const toast = (m) => showToast(m, false);
  const showError = (m) => showToast('错误：' + m, true);

  window.addEventListener('error', (e) => showError(e.message));
  window.addEventListener('unhandledrejection', (e) => showError(String((e.reason && e.reason.message) || e.reason)));

  const pdfReady = typeof pdfjsLib !== 'undefined';
  if (pdfReady) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  } else {
    showError('pdf.js 未加载（renderer/vendor/pdf.min.js 缺失）');
  }
  if (!api) showError('preload 未加载（window.api 不存在），请查看日志文件');

  /* ---------- 状态 ----------
   * 标签（tab）→ 最多两个窗格（pane）。每个窗格是一个独立的 PDF：
   *   自己的文档、缩放、滚动位置、未保存的标注。
   * 工具栏上的缩放 / 页码 / 撤销 / 保存，作用于「当前标签的焦点窗格」。 */
  let tool = 'hand';
  let color = '#ffd400';
  let tabs = [];            // { id, panes:[pane], focus, ratio, sync }
  let activeId = null;
  let nextTabId = 1;
  let draggingTabId = null;
  let lastScale = 1.25;     // 新打开的窗格沿用最近一次的缩放
  const MIN_PANE = 260;     // 单个窗格最小宽度（px）

  // pane: { path, name, doc, scale, annos, scrollTop, scrollLeft, lastTop, pages, observer, token, drawing,
  //         el, viewer, pagesEl, titleEl, dotEl }   —— 坐标均为「缩放比例 1」下的页面坐标（pt，左上角为原点）

  const baseName = (p) => p.split(/[\\/]/).pop();
  const normPath = (p) => p.replace(/\//g, '\\').toLowerCase();
  const activeTab = () => tabs.find((t) => t.id === activeId) || null;
  const focusPane = (t) => (t ? t.panes[t.focus] || t.panes[0] : null);
  const curPane = () => focusPane(activeTab());
  const tabDirty = (t) => t.panes.some((p) => p.annos.length > 0);
  const tabName = (t) => t.panes.map((p) => p.name).join('  │  ');
  const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
  const clampScale = (s) => Math.min(4, Math.max(0.4, +s.toFixed(2)));

  function makePane(path, doc) {
    return {
      path, name: baseName(path), doc, scale: lastScale, annos: [], scrollTop: 0, scrollLeft: 0, lastTop: 0,
      pages: [], observer: null, token: 0, drawing: null, el: null, viewer: null, pagesEl: null, titleEl: null, dotEl: null
    };
  }

  async function loadPane(res) {
    if (res.error) { showError(baseName(res.path) + '：' + res.error); return null; }
    try {
      const doc = await pdfjsLib.getDocument({ data: res.data }).promise;
      return makePane(res.path, doc);
    } catch (err) {
      showError('无法打开「' + baseName(res.path) + '」（可能已加密或已损坏）');
      console.error(err);
      return null;
    }
  }

  /** 在所有标签的所有窗格里找某个文件 */
  function findPane(path) {
    for (const t of tabs) {
      const i = t.panes.findIndex((p) => normPath(p.path) === normPath(path));
      if (i >= 0) return { tab: t, idx: i };
    }
    return null;
  }

  /* ---------- 工具 / 颜色 ---------- */
  function setColor(c) {
    color = c;
    $('color').value = c;
    document.querySelectorAll('.swatch[data-color]').forEach(s =>
      s.classList.toggle('active', s.dataset.color.toLowerCase() === c.toLowerCase()));
  }
  function setTool(t) {
    tool = t;
    document.body.classList.remove('tool-hand', 'tool-highlight', 'tool-pen', 'tool-text');
    document.body.classList.add('tool-' + t);
    document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    // 高亮默认黄色；画笔 / 文字默认红色（只在还是默认色时自动切换，不覆盖用户选的颜色）
    if (t === 'highlight' && color.toLowerCase() === '#e53935') setColor('#ffd400');
    if ((t === 'pen' || t === 'text') && color.toLowerCase() === '#ffd400') setColor('#e53935');
  }

  /* ---------- 工具栏同步（缩放 / 页码 / 分屏按钮 / 标题） ---------- */
  function syncToolbar() {
    const t = activeTab();
    const p = focusPane(t);
    const split = !!t && t.panes.length === 2;
    $('btnSplit').classList.toggle('active', split);
    $('btnSplit').title = split ? '取消分屏：关闭右侧窗格 (Ctrl+\\)' : '分屏：在右侧再打开一个 PDF (Ctrl+\\)';
    $('splitTools').hidden = !split;
    $('btnSync').classList.toggle('active', !!(t && t.sync));
    if (!p) {
      $('zoomLabel').textContent = Math.round(lastScale * 100) + '%';
      $('pageTotal').textContent = '/ 0';
      $('pageInput').value = 1;
      document.title = 'StealthPDF';
      return;
    }
    $('zoomLabel').textContent = Math.round(p.scale * 100) + '%';
    $('pageTotal').textContent = '/ ' + p.doc.numPages;
    $('pageInput').max = p.doc.numPages;
    if (p.pages.length) $('pageInput').value = currentPageIndex(p) + 1;
    document.title = 'StealthPDF - ' + (split ? tabName(t) : p.name);
    t.panes.forEach((q, i) => {
      if (!q.el) return;
      q.el.classList.toggle('focus', i === t.focus);
      q.titleEl.textContent = q.name;
      q.titleEl.title = q.path;
      q.dotEl.hidden = q.annos.length === 0;
    });
  }
  const markDirty = () => { renderTabs(); syncToolbar(); };

  /* ---------- 标签页 ---------- */
  function saveState(t) {
    t.panes.forEach((p) => {
      if (!p.viewer) return;
      p.scrollTop = p.viewer.scrollTop;
      p.scrollLeft = p.viewer.scrollLeft;
    });
  }

  /** 离开一个标签：记住滚动位置，拆掉它的 DOM，并让还在进行的页面构建作废 */
  function leaveTab(t) {
    saveState(t);
    endPan();
    t.panes.forEach((p) => {
      p.token++;
      if (p.observer) p.observer.disconnect();
      p.observer = null; p.pages = []; p.drawing = null;
      p.el = p.viewer = p.pagesEl = p.titleEl = p.dotEl = null;
    });
    panesEl.innerHTML = '';
  }

  async function showTab(t) {
    const id = t.id;
    layout(t);
    renderTabs();
    syncToolbar();
    await Promise.all(t.panes.map((p) => buildPages(p)));
    if (activeId !== id) return;                       // 构建期间被切走了
    t.panes.forEach((p) => {
      if (!p.viewer) return;
      p.viewer.scrollLeft = p.scrollLeft;
      p.viewer.scrollTop = p.scrollTop;
      p.lastTop = p.viewer.scrollTop;
    });
    syncToolbar();
  }

  async function activateTab(id, force, paneIdx) {
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    if (typeof paneIdx === 'number' && t.panes[paneIdx]) t.focus = paneIdx;
    if (id === activeId && !force) { syncToolbar(); return; }
    const old = activeTab();
    if (old) leaveTab(old);
    activeId = id;
    await showTab(t);
  }

  /** 打开一批文件：已打开的直接切过去，其余各开一个新标签，最后激活最后一个 */
  async function openFiles(list) {
    if (!list || !list.length) return;
    let last = null, lastIdx = 0;
    for (const res of list) {
      if (res.error) { showError(baseName(res.path) + '：' + res.error); continue; }
      const exist = findPane(res.path);
      if (exist) { last = exist.tab.id; lastIdx = exist.idx; continue; }
      const p = await loadPane(res);
      if (!p) continue;
      const t = { id: nextTabId++, panes: [p], focus: 0, ratio: 0.5, sync: false };
      tabs.push(t);
      last = t.id; lastIdx = 0;
    }
    if (last !== null) await activateTab(last, false, lastIdx);
  }

  /** 页内确认弹窗（不用系统 confirm：隐身模式下系统对话框期间窗口可能被隐藏） */
  function confirmDialog(title, msg, okText) {
    return new Promise((resolve) => {
      const m = $('cmodal');
      $('cTitle').textContent = title;
      $('cMsg').textContent = msg;
      $('cOk').textContent = okText;
      m.hidden = false;
      const done = (v) => {
        m.hidden = true;
        $('cOk').onclick = $('cCancel').onclick = null;
        window.removeEventListener('keydown', onKey, true);
        resolve(v);
      };
      const onKey = (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === 'Escape') done(false);
        else if (e.key === 'Enter') done(true);
      };
      window.addEventListener('keydown', onKey, true);
      $('cOk').onclick = () => done(true);
      $('cCancel').onclick = () => done(false);
    });
  }

  async function closeTab(id) {
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    if (tabDirty(t) && !(await confirmDialog('关闭「' + tabName(t) + '」？', '这个标签页里有未保存的标注，关闭后会丢失。', '不保存，直接关闭'))) return;
    const idx = tabs.indexOf(t);
    if (idx < 0) return;
    const wasActive = id === activeId;
    if (wasActive) leaveTab(t);
    tabs.splice(idx, 1);
    t.panes.forEach((p) => { try { p.doc.destroy(); } catch (_) {} });
    if (!wasActive) return renderTabs();
    if (tabs.length) { activeId = null; await activateTab(tabs[Math.min(idx, tabs.length - 1)].id, true); }
    else showEmpty();
  }

  function showEmpty() {
    const t = activeTab();
    if (t) leaveTab(t);
    activeId = null;
    panesEl.innerHTML = '';
    stage.classList.remove('split');
    $('empty').style.display = '';
    renderTabs();
    syncToolbar();
  }

  function switchBy(step) {
    if (tabs.length < 2) return;
    const i = tabs.findIndex((t) => t.id === activeId);
    activateTab(tabs[(i + step + tabs.length) % tabs.length].id);
  }

  const SPLIT_ICON = '<svg class="ic tab-split" aria-hidden="true"><use href="#i-split"/></svg>';

  function renderTabs() {
    const bar = $('tabbar'), box = $('tabs');
    bar.hidden = tabs.length === 0;
    box.innerHTML = '';
    tabs.forEach((t) => {
      const dirty = tabDirty(t);
      const el = document.createElement('div');
      el.className = 'tab' + (t.id === activeId ? ' active' : '') + (t.panes.length === 2 ? ' split' : '');
      el.setAttribute('role', 'tab');
      el.draggable = true;
      el.dataset.id = t.id;
      el.title = t.panes.map((p) => p.path).join('\n') + (dirty ? '\n（有未保存的标注）' : '');
      if (dirty) { const d = document.createElement('span'); d.className = 'tab-dot'; el.appendChild(d); }
      if (t.panes.length === 2) el.insertAdjacentHTML('beforeend', SPLIT_ICON);
      const title = document.createElement('span');
      title.className = 'tab-title';
      title.textContent = tabName(t);
      el.appendChild(title);
      const x = document.createElement('button');
      x.className = 'tab-close';
      x.title = '关闭 (Ctrl+W)';
      x.textContent = '×';
      x.onclick = (e) => { e.stopPropagation(); closeTab(t.id); };
      el.appendChild(x);

      el.onclick = () => { if (t.id !== activeId) activateTab(t.id); };
      el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } });
      el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });   // 阻止中键自动滚动

      // 拖动排序
      el.addEventListener('dragstart', (e) => {
        draggingTabId = t.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-stealth-tab', String(t.id));
        setTimeout(() => el.classList.add('dragging'), 0);
      });
      el.addEventListener('dragend', () => {
        draggingTabId = null;
        box.querySelectorAll('.tab').forEach((n) => n.classList.remove('dragging', 'drop-before', 'drop-after'));
      });
      el.addEventListener('dragover', (e) => {
        if (draggingTabId === null || draggingTabId === t.id) return;
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const before = e.clientX < r.left + r.width / 2;
        el.classList.toggle('drop-before', before);
        el.classList.toggle('drop-after', !before);
      });
      el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
      el.addEventListener('drop', (e) => {
        if (draggingTabId === null || draggingTabId === t.id) return;
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const before = e.clientX < r.left + r.width / 2;
        const from = tabs.findIndex((n) => n.id === draggingTabId);
        const [moved] = tabs.splice(from, 1);
        let to = tabs.findIndex((n) => n.id === t.id);
        if (!before) to += 1;
        tabs.splice(to, 0, moved);
        draggingTabId = null;
        renderTabs();
      });
      box.appendChild(el);
    });
    const act = box.querySelector('.tab.active');
    if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // 标签栏上滚轮 → 横向滚动
  $('tabs').addEventListener('wheel', (e) => {
    e.preventDefault();
    $('tabs').scrollLeft += e.deltaY || e.deltaX;
  }, { passive: false });

  /* ---------- 窗格布局 ---------- */
  function layout(t) {
    panesEl.innerHTML = '';
    stage.classList.toggle('split', t.panes.length === 2);
    $('empty').style.display = 'none';
    t.panes.forEach((p, i) => {
      if (i === 1) {
        const sp = document.createElement('div');
        sp.className = 'splitter';
        sp.title = '拖动调整宽度，双击恢复 50%';
        bindSplitter(sp, t);
        panesEl.appendChild(sp);
      }
      createPaneDom(t, p);
    });
    applyRatio(t);
  }

  function createPaneDom(t, p) {
    const el = document.createElement('section');
    el.className = 'pane';
    el.innerHTML =
      '<header class="pane-head"><span class="pane-dot" hidden></span><span class="pane-title"></span>' +
      '<button class="pane-close" title="关闭这个窗格">×</button></header>' +
      '<div class="viewer"><div class="pages"></div></div>';
    p.el = el;
    p.titleEl = el.querySelector('.pane-title');
    p.dotEl = el.querySelector('.pane-dot');
    p.viewer = el.querySelector('.viewer');
    p.pagesEl = el.querySelector('.pages');
    el.querySelector('.pane-close').onclick = () => closePane(t, p);
    // 按下窗格任意位置 → 它成为焦点窗格（工具栏的缩放 / 保存等作用于它）
    el.addEventListener('pointerdown', () => {
      const i = t.panes.indexOf(p);
      if (t === activeTab() && i >= 0 && t.focus !== i) { t.focus = i; syncToolbar(); }
    }, true);
    bindViewer(t, p);
    panesEl.appendChild(el);
  }

  function applyRatio(t) {
    if (t.panes.length === 2 && t.panes[0].el && t.panes[1].el) {
      t.panes[0].el.style.flex = '0 0 calc(' + (t.ratio * 100) + '% - 3px)';
      t.panes[1].el.style.flex = '1 1 0';
    } else if (t.panes[0] && t.panes[0].el) {
      t.panes[0].el.style.flex = '1 1 auto';
    }
  }

  function bindSplitter(sp, t) {
    let drag = null;
    sp.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = e.pointerId;
      try { sp.setPointerCapture(e.pointerId); } catch (_) {}
      document.body.classList.add('resizing');
      e.preventDefault();
    });
    sp.addEventListener('pointermove', (e) => {
      if (drag !== e.pointerId) return;
      const r = panesEl.getBoundingClientRect();
      const lo = Math.min(0.5, MIN_PANE / r.width), hi = 1 - lo;
      t.ratio = Math.min(hi, Math.max(lo, (e.clientX - r.left) / r.width));
      applyRatio(t);
    });
    const end = () => { drag = null; document.body.classList.remove('resizing'); };
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((n) => sp.addEventListener(n, end));
    sp.addEventListener('dblclick', () => { t.ratio = 0.5; applyRatio(t); });
  }

  /* ---------- 分屏操作 ---------- */
  /** 进入分屏前，按「半屏宽度」算出适合的缩放 */
  async function halfFitScale(p) {
    const first = await p.doc.getPage(1);
    const w = first.getViewport({ scale: 1 }).width;
    const half = (stage.clientWidth - 6) / 2;
    return clampScale((half - 14 - 56) / w);
  }

  /** 把一个窗格加到当前（单窗格）标签的右侧 */
  async function addSplitPane(t, pane) {
    if (t.panes.length !== 1) return;
    const keep = tabs.indexOf(t) >= 0;
    if (!keep) return;
    const left = t.panes[0];
    left.prevScale = left.scale;
    pane.prevScale = pane.scale;
    left.scale = await halfFitScale(left);
    pane.scale = await halfFitScale(pane);
    left.scrollTop = left.viewer ? left.viewer.scrollTop : left.scrollTop;
    if (t === activeTab()) leaveTab(t);
    t.panes.push(pane);
    t.focus = 1; t.ratio = 0.5; t.sync = false;
    if (t.id === activeId) await showTab(t);
    else renderTabs();
    toast('已分屏：左 ' + left.name + ' ｜ 右 ' + pane.name);
  }

  async function splitBrowse() {
    const t = activeTab();
    if (!t || t.panes.length !== 1) return;
    if (!pdfReady || !api) return showError('组件未加载，无法打开文件');
    let res;
    try { res = await api.open(); } catch (err) { return showError(String((err && err.message) || err)); }
    if (!res || !res.length) return;
    if (res.length > 1) toast('分屏一次只能放一个文件，已取第一个');
    await splitWithResult(t, res[0]);
  }

  async function splitWithResult(t, res) {
    if (res.error) return showError(baseName(res.path) + '：' + res.error);
    const exist = findPane(res.path);
    if (exist) {
      if (exist.tab === t) return toast('「' + baseName(res.path) + '」已经在这个标签里了');
      return splitWithTab(t, exist.tab);
    }
    const p = await loadPane(res);
    if (p) await addSplitPane(t, p);
  }

  /** 把另一个（单窗格的）标签并进当前标签右侧 */
  async function splitWithTab(t, other) {
    if (other.panes.length !== 1) return toast('那个标签本身已经是分屏，不能再并入');
    const pane = other.panes[0];
    const i = tabs.indexOf(other);
    if (i < 0) return;
    tabs.splice(i, 1);                      // pane 对象（含未保存的标注）原样搬过去，不销毁文档
    await addSplitPane(t, pane);
  }

  function openSplitChooser(t) {
    const m = $('smodal'), list = $('sList');
    const others = tabs.filter((x) => x !== t && x.panes.length === 1);
    list.innerHTML = '';
    others.forEach((o) => {
      const b = document.createElement('button');
      b.className = 'split-item';
      b.textContent = o.panes[0].name + (o.panes[0].annos.length ? '（有未保存标注）' : '');
      b.title = o.panes[0].path;
      b.onclick = () => { close(); splitWithTab(t, o); };
      list.appendChild(b);
    });
    $('sListWrap').hidden = others.length === 0;
    const onKey = (e) => { e.stopImmediatePropagation(); if (e.key === 'Escape') { e.preventDefault(); close(); } };
    const close = () => { m.hidden = true; window.removeEventListener('keydown', onKey, true); };
    $('sBrowse').onclick = () => { close(); splitBrowse(); };
    $('sCancel').onclick = close;
    m.onmousedown = (e) => { if (e.target === m) close(); };
    window.addEventListener('keydown', onKey, true);
    m.hidden = false;
  }

  async function toggleSplit() {
    const t = activeTab();
    if (!t) return toast('请先打开一个 PDF，再分屏');
    if (t.panes.length === 2) return closePane(t, t.panes[1]);
    if (tabs.some((x) => x !== t && x.panes.length === 1)) openSplitChooser(t);
    else splitBrowse();
  }

  /** 关闭一个窗格；分屏标签只剩一个窗格时恢复成普通标签 */
  async function closePane(t, p) {
    if (t.panes.length < 2) return closeTab(t.id);
    if (p.annos.length && !(await confirmDialog('关闭「' + p.name + '」？', '这个窗格里有未保存的标注，关闭后会丢失。', '不保存，直接关闭'))) return;
    const i = t.panes.indexOf(p);
    if (tabs.indexOf(t) < 0 || i < 0 || t.panes.length < 2) return;
    const wasActive = t.id === activeId;
    if (wasActive) leaveTab(t);
    t.panes.splice(i, 1);
    try { p.doc.destroy(); } catch (_) {}
    const rest = t.panes[0];
    if (rest.prevScale) { rest.scale = rest.prevScale; delete rest.prevScale; }
    t.focus = 0; t.sync = false; t.ratio = 0.5;
    if (wasActive) await showTab(t);
    else renderTabs();
  }

  async function swapPanes() {
    const t = activeTab();
    if (!t || t.panes.length !== 2) return;
    leaveTab(t);
    t.panes.reverse();
    t.focus = 1 - t.focus;
    t.ratio = 1 - t.ratio;
    await showTab(t);
  }

  function toggleSync() {
    const t = activeTab();
    if (!t || t.panes.length !== 2) return;
    t.sync = !t.sync;
    syncToolbar();
    toast(t.sync ? '同步滚动已开启：两侧一起滚动' : '同步滚动已关闭');
  }

  function focusOther() {
    const t = activeTab();
    if (!t || t.panes.length !== 2) return;
    t.focus = 1 - t.focus;
    syncToolbar();
  }

  /* ---------- 渲染 ---------- */
  async function buildPages(p) {
    const token = ++p.token;
    if (p.observer) p.observer.disconnect();
    const viewer = p.viewer, pagesEl = p.pagesEl;
    if (!viewer || !pagesEl) return;
    pagesEl.innerHTML = '';
    p.pages = [];

    const doc = p.doc;
    const list = await Promise.all(
      Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1))
    );
    if (token !== p.token) return;          // 期间切换了标签 / 重建了窗格，放弃这次构建
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(en => { if (en.isIntersecting && token === p.token) renderPage(p, p.pages[+en.target.dataset.idx]); });
    }, { root: viewer, rootMargin: '700px 0px' });
    p.observer = observer;

    list.forEach((pdfPage, idx) => {
      const vp = pdfPage.getViewport({ scale: p.scale });
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.idx = idx;
      el.style.width = vp.width + 'px';
      el.style.height = vp.height + 'px';
      pagesEl.appendChild(el);
      p.pages.push({ idx, el, pdfPage, vp, canvas: null, overlay: null, rendered: false });
      observer.observe(el);
    });
    if (activeTab() && focusPane(activeTab()) === p) syncToolbar();
  }

  async function renderPage(p, pg) {
    if (!pg || pg.rendered) return;
    pg.rendered = true;
    const dpr = window.devicePixelRatio || 1;
    const vp = pg.vp;

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = vp.width + 'px';
    canvas.style.height = vp.height + 'px';
    pg.el.appendChild(canvas);
    pg.canvas = canvas;

    const overlay = document.createElement('canvas');
    overlay.className = 'overlay';
    overlay.width = canvas.width;
    overlay.height = canvas.height;
    overlay.style.width = vp.width + 'px';
    overlay.style.height = vp.height + 'px';
    pg.el.appendChild(overlay);
    pg.overlay = overlay;
    bindOverlay(p, pg);

    await pg.pdfPage.render({
      canvasContext: canvas.getContext('2d'),
      viewport: vp,
      transform: [dpr, 0, 0, dpr, 0, 0]
    }).promise;
    drawOverlay(p, pg);
  }

  /* ---------- 标注绘制 ---------- */
  function drawOne(ctx, a) {
    if (a.type === 'highlight') {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = a.color;
      ctx.fillRect(a.x, a.y, a.w, a.h);
      ctx.globalAlpha = 1;
    } else if (a.type === 'pen') {
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width;
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.beginPath();
      a.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (a.points.length === 1) ctx.lineTo(a.points[0][0] + 0.1, a.points[0][1]);
      ctx.stroke();
    } else if (a.type === 'text') {
      ctx.fillStyle = a.color;
      ctx.font = a.size + 'px sans-serif';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(a.text, a.x, a.y + a.size * 0.85);
    }
  }

  function drawOverlay(p, pg) {
    if (!pg || !pg.overlay) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = pg.overlay.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pg.overlay.width, pg.overlay.height);
    ctx.setTransform(dpr * p.scale, 0, 0, dpr * p.scale, 0, 0);
    p.annos.filter(a => a.page === pg.idx).forEach(a => drawOne(ctx, a));
    if (p.drawing && p.drawing.page === pg.idx) drawOne(ctx, p.drawing);
  }

  /* ---------- 鼠标交互（标注） ---------- */
  function bindOverlay(p, pg) {
    const ov = pg.overlay;
    const pos = (e) => {
      const r = ov.getBoundingClientRect();
      return [(e.clientX - r.left) / p.scale, (e.clientY - r.top) / p.scale];
    };

    ov.addEventListener('pointerdown', (e) => {
      if (tool === 'hand' || e.button !== 0) return;
      const [x, y] = pos(e);
      if (tool === 'text') { startTextInput(p, pg, x, y, color); return; }

      ov.setPointerCapture(e.pointerId);
      if (tool === 'highlight') {
        p.drawing = { type: 'highlight', page: pg.idx, x, y, w: 0, h: 0, sx: x, sy: y, color };
      } else if (tool === 'pen') {
        p.drawing = { type: 'pen', page: pg.idx, points: [[x, y]], width: 2, color };
      }
      drawOverlay(p, pg);
    });

    ov.addEventListener('pointermove', (e) => {
      const d = p.drawing;
      if (!d || d.page !== pg.idx) return;
      const [x, y] = pos(e);
      if (d.type === 'highlight') {
        d.x = Math.min(x, d.sx);
        d.y = Math.min(y, d.sy);
        d.w = Math.abs(x - d.sx);
        d.h = Math.abs(y - d.sy);
      } else {
        d.points.push([x, y]);
      }
      drawOverlay(p, pg);
    });

    const finish = () => {
      const d = p.drawing;
      if (!d || d.page !== pg.idx) return;
      p.drawing = null;
      if (d.type === 'highlight') {
        if (d.w < 2 || d.h < 2) { drawOverlay(p, pg); return; }
        delete d.sx; delete d.sy;
      }
      p.annos.push(d);
      drawOverlay(p, pg);
      markDirty();                          // 刷新标签 / 窗格上的「未保存」圆点
    };
    ov.addEventListener('pointerup', finish);
    ov.addEventListener('pointercancel', finish);
  }

  function startTextInput(p, pg, x, y, c) {
    const size = 16;
    const input = document.createElement('input');
    input.className = 'text-input';
    input.style.left = x * p.scale + 'px';
    input.style.top = y * p.scale + 'px';
    input.style.fontSize = size * p.scale + 'px';
    input.style.color = c;
    pg.el.appendChild(input);
    setTimeout(() => input.focus(), 0);

    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      const text = input.value.trim();
      input.remove();
      if (save && text) {
        p.annos.push({ type: 'text', page: pg.idx, x, y, text, size, color: c });
        drawOverlay(p, pg);
        markDirty();
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit(true);
      else if (e.key === 'Escape') commit(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => commit(true));
  }

  function undo() {
    const p = curPane();
    if (!p) return;
    const a = p.annos.pop();
    if (!a) return;
    drawOverlay(p, p.pages[a.page]);
    markDirty();
  }

  /* ---------- 缩放 / 翻页 ---------- */
  async function setScale(p, s) {
    if (!p || !p.viewer) return;
    const idx = currentPageIndex(p);
    p.scale = lastScale = clampScale(s);
    await buildPages(p);
    const pg = p.pages[idx];
    if (pg && p.viewer) p.viewer.scrollTop = Math.max(0, pg.el.offsetTop - 22);
    p.lastTop = p.viewer ? p.viewer.scrollTop : 0;
    syncToolbar();
  }
  const zoom = (d, p) => { p = p || curPane(); if (p) setScale(p, p.scale + d); };

  async function fitWidth(p) {
    p = p || curPane();
    if (!p || !p.viewer) return;
    const first = await p.doc.getPage(1);
    const w = first.getViewport({ scale: 1 }).width;
    await setScale(p, (p.viewer.clientWidth - 56) / w);
  }

  function currentPageIndex(p) {
    if (!p || !p.viewer) return 0;
    const top = p.viewer.getBoundingClientRect().top;
    let best = 0, bestDist = Infinity;
    p.pages.forEach((pg, i) => {
      const d = Math.abs(pg.el.getBoundingClientRect().top - top - 22);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    return best;
  }

  $('pageInput').addEventListener('change', (e) => {
    const p = curPane();
    if (!p || !p.viewer) return;
    const n = Math.min(p.pages.length, Math.max(1, +e.target.value || 1));
    if (p.pages[n - 1]) p.viewer.scrollTop = Math.max(0, p.pages[n - 1].el.offsetTop - 22);
  });

  /* ---------- 每个窗格的滚动 / 滚轮 / 手型平移 ---------- */
  let pan = null;
  function endPan() {
    if (!pan) return;
    try { pan.viewer.releasePointerCapture(pan.id); } catch (_) {}
    pan = null;
    document.body.classList.remove('panning');
  }

  function bindViewer(t, p) {
    const viewer = p.viewer;

    // 滚动：更新页码；开启「同步滚动」时，另一侧移动相同的距离
    viewer.addEventListener('scroll', () => {
      const d = viewer.scrollTop - p.lastTop;
      p.lastTop = viewer.scrollTop;
      if (t === activeTab() && focusPane(t) === p && p.pages.length) $('pageInput').value = currentPageIndex(p) + 1;
      if (!d || !t.sync || t.panes.length !== 2) return;
      const o = t.panes[0] === p ? t.panes[1] : t.panes[0];
      if (!o.viewer) return;
      o.viewer.scrollTop += d;
      o.lastTop = o.viewer.scrollTop;       // 让对侧的 scroll 事件算出 d = 0，避免来回弹
    });

    /* 滚轮：窗口需要按住 Shift 才会显示（旧版触发键），而 Chromium 里 Shift+滚轮 = 横向滚动，
     * 所以统一接管：Ctrl+滚轮 缩放；Shift+滚轮 纵向滚动；Shift+Alt+滚轮 横向滚动；普通滚轮 浏览器默认 */
    viewer.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        zoom(e.deltaY < 0 ? 0.1 : -0.1, p);
        return;
      }
      if (e.shiftKey) {
        e.preventDefault();
        let d = e.deltaY || e.deltaX;           // 不同平台 Shift 会把纵向增量换到 deltaX
        if (e.deltaMode === 1) d *= 16;         // 行 -> 像素
        else if (e.deltaMode === 2) d *= viewer.clientHeight;
        if (e.altKey) viewer.scrollLeft += d;
        else viewer.scrollTop += d;
      }
    }, { passive: false });

    /* 手型：左键拖动平移；任何工具下，按住鼠标中键拖动同样可以平移 */
    viewer.addEventListener('pointerdown', (e) => {
      const middle = e.button === 1;
      if (!middle && !(tool === 'hand' && e.button === 0)) return;
      if (e.target.closest && e.target.closest('.text-input')) return;
      const r = viewer.getBoundingClientRect();                                 // 点在滚动条上时不抢：让滚动条正常拖
      if (e.clientX - r.left >= viewer.clientWidth || e.clientY - r.top >= viewer.clientHeight) return;
      pan = { viewer, id: e.pointerId, x: e.clientX, y: e.clientY, left: viewer.scrollLeft, top: viewer.scrollTop };
      try { viewer.setPointerCapture(e.pointerId); } catch (_) {}
      document.body.classList.add('panning');
      e.preventDefault();
    });
    viewer.addEventListener('pointermove', (e) => {
      if (!pan || pan.viewer !== viewer || e.pointerId !== pan.id) return;
      viewer.scrollLeft = pan.left - (e.clientX - pan.x);
      viewer.scrollTop = pan.top - (e.clientY - pan.y);
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((n) => viewer.addEventListener(n, endPan));
    viewer.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });   // 禁用中键自动滚动圈
  }

  /* ---------- 打开 / 保存 ---------- */
  async function openDialog() {
    if (!pdfReady) return showError('pdf.js 未加载，无法显示 PDF');
    if (!api) return showError('preload 未加载，无法打开文件');
    try {
      await openFiles(await api.open());     // 对话框可多选，每个文件一个标签
    } catch (err) {
      showError(String((err && err.message) || err));
    }
  }

  /** 保存焦点窗格里的文件（分屏时只保存你正在操作的那一侧） */
  async function save(asNew) {
    if (!api) return showError('preload 未加载，无法保存');
    const t = activeTab();
    const p = focusPane(t);
    if (!p) return toast('请先打开一个 PDF');
    if (!asNew && p.annos.length === 0) return toast('没有需要保存的修改');
    const r = await api.save({ path: p.path, annotations: p.annos, saveAs: !!asNew });
    if (!r) return;
    const res = await api.open(r.path);       // 重新载入，标注已写入文件
    const item = res && res[0];
    if (!item || item.error) return showError('保存成功，但重新载入失败：' + ((item && item.error) || r.path));
    try {
      const doc = await pdfjsLib.getDocument({ data: item.data }).promise;
      const old = p.doc;
      p.doc = doc;
      p.path = r.path;
      p.name = baseName(r.path);
      p.annos = [];
      p.drawing = null;
      if (p.viewer) {                                        // 只重建这一个窗格，保留滚动位置和缩放
        const keep = p.viewer.scrollTop;
        await buildPages(p);
        if (p.viewer) { p.viewer.scrollTop = keep; p.lastTop = keep; }
      }
      markDirty();
      try { old.destroy(); } catch (_) {}
      toast('已保存：' + p.name);
    } catch (err) {
      showError('保存成功，但重新载入失败');
      console.error(err);
    }
  }

  /* ---------- 隐身开关 ---------- */
  function showStealth(on) {
    const b = $('btnStealth');
    b.classList.toggle('on', !!on);
    b.classList.toggle('off', !on);
    $('stealthText').textContent = on ? '隐身 开' : '隐身 关';
    $('stealthIcon').setAttribute('href', on ? '#i-eyeoff' : '#i-eye');
  }
  $('btnStealth').onclick = async () => {
    if (!api || !api.setStealth) return showError('preload 未加载，无法切换隐身');
    const next = !$('btnStealth').classList.contains('on');
    await api.setStealth(next);
    showStealth(next);
    toast(next
      ? '隐身已开启：按住「' + triggerLabel + '」并把光标移到窗口上才显示'
      : '隐身已关闭：窗口将一直显示');
  };

  /* ---------- 触发键设置 ---------- */
  let triggerLabel = 'Fn';
  let triggerCur = { code: null, label: 'Fn', type: 'key' };
  let presets = [];
  const modal = $('modal');

  function showTrigger(t) {
    triggerCur = t;
    triggerLabel = t.label;
    const bound = t.code !== null && t.code !== undefined;
    $('triggerLabel').textContent = t.label;
    $('curTrigger').textContent = t.label + (bound ? '' : '（未绑定）');
    $('hintKey').textContent = t.label;
    $('btnTrigger').classList.toggle('warn', !bound);
    $('btnTrigger').title = '触发键：' + t.label + (bound ? '' : '（未绑定，窗口会一直显示）') + '。点击更改';
    $('fnNote').hidden = !(t.label === 'Fn');
    renderChips();
  }

  function renderChips() {
    const box = $('presetChips');
    box.innerHTML = '';
    presets.forEach((p) => {
      const b = document.createElement('button');
      b.className = 'chip' + (p.label === triggerCur.label ? ' active' : '');
      b.textContent = p.label;
      b.onclick = async () => {
        if (!api) return;
        showTrigger(await api.setTriggerPreset(p.id));
        setCaptureUI('done', '已设置为「' + triggerLabel + '」', '按住它并把光标移到窗口上即可显示');
      };
      box.appendChild(b);
    });
  }

  function setCaptureUI(state, main, sub) {
    const box = $('captureBox');
    box.className = 'capture' + (state ? ' ' + state : '');
    $('captureMain').textContent = main;
    $('captureSub').textContent = sub;
    const listening = state === 'listening';
    $('btnCapture').hidden = listening;
    $('btnCaptureCancel').hidden = !listening;
  }

  async function openTriggerDialog() {
    if (!api || !api.getTrigger) return showError('preload 未加载，无法设置触发键');
    presets = await api.getTriggerPresets();
    showTrigger(await api.getTrigger());
    setCaptureUI('', '点击下面的按钮，然后按下你想用的键', '支持键盘上任意键，以及鼠标中键 / 后退键 / 前进键');
    modal.hidden = false;
  }
  async function closeTriggerDialog() {
    if ($('btnCapture').hidden) await api.cancelCapture();   // 正在录制时先取消
    modal.hidden = true;
  }

  async function startCapture() {
    if (!api) return;
    setCaptureUI('listening', '请现在按下想用的键…', '10 秒内有效；按 Esc 取消。左键 / 右键不会被录制');
    const r = await api.captureTrigger();
    if (modal.hidden) return;
    if (r && r.ok) {
      showTrigger(r.trigger);
      setCaptureUI('done', '已设置为「' + r.trigger.label + '」', '按住它并把光标移到窗口上即可显示');
    } else if (r && r.timedOut) {
      setCaptureUI('fail', '10 秒内没有收到按键',
        '这个键可能不会被 Windows 识别（Fn 键就是这样）。请换一个键，或点下面的常用选项。');
    } else {
      setCaptureUI('', '已取消', '点击「开始录制按键」重试');
    }
  }

  $('btnTrigger').onclick = openTriggerDialog;
  $('btnCapture').onclick = startCapture;
  $('btnCaptureCancel').onclick = () => api && api.cancelCapture();
  $('btnDlgClose').onclick = closeTriggerDialog;
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeTriggerDialog(); });

  // 弹窗打开时，拦截所有按键（避免录制时误触 Ctrl+O 等快捷键），只保留 Esc 关闭
  window.addEventListener('keydown', (e) => {
    if (modal.hidden) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === 'Escape' && $('btnCapture').hidden === false) closeTriggerDialog();
  }, true);

  /* ---------- 透明度 ---------- */
  const opSlider = $('opacity'), opLabel = $('opacityLabel');
  function showOpacity(v) {
    const pct = Math.round(v * 100);
    opSlider.value = pct;
    opLabel.textContent = pct + '%';
  }
  opSlider.addEventListener('input', () => {
    opLabel.textContent = opSlider.value + '%';
    if (api) api.setOpacity(opSlider.value / 100);
  });

  /* ---------- 事件绑定 ---------- */
  $('btnOpen').onclick = openDialog;
  $('btnOpen2').onclick = openDialog;
  $('btnNewTab').onclick = openDialog;
  $('btnSave').onclick = () => save(false);
  $('btnSaveAs').onclick = () => save(true);
  $('btnUndo').onclick = undo;
  $('btnZoomIn').onclick = () => zoom(0.1);
  $('btnZoomOut').onclick = () => zoom(-0.1);
  $('btnFit').onclick = () => fitWidth();
  $('btnSplit').onclick = toggleSplit;
  $('btnSync').onclick = toggleSync;
  $('btnSwap').onclick = swapPanes;
  document.querySelectorAll('.tool').forEach(b => (b.onclick = () => setTool(b.dataset.tool)));
  document.querySelectorAll('.swatch[data-color]').forEach(s => (s.onclick = () => setColor(s.dataset.color)));
  $('color').addEventListener('input', (e) => setColor(e.target.value));

  window.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test((e.target && e.target.tagName) || '');
    if (e.ctrlKey) {
      const k = e.key.toLowerCase();
      if (k === 'o') { e.preventDefault(); openDialog(); }
      else if (k === 's') { e.preventDefault(); save(e.shiftKey); }
      else if (k === 'z') { e.preventDefault(); undo(); }
      else if (k === '=' || k === '+') { e.preventDefault(); zoom(0.1); }
      else if (k === '-') { e.preventDefault(); zoom(-0.1); }
      else if (k === '0') { e.preventDefault(); fitWidth(); }
      else if (k === '\\') { e.preventDefault(); toggleSplit(); }
      else if (k === 'w') { e.preventDefault(); if (activeId !== null) closeTab(activeId); }
      else if (k === 'tab') { e.preventDefault(); switchBy(e.shiftKey ? -1 : 1); }
      else if (k === 'pagedown') { e.preventDefault(); switchBy(1); }
      else if (k === 'pageup') { e.preventDefault(); switchBy(-1); }
      else if (/^[1-9]$/.test(k)) {            // Ctrl+1…8 跳到第 N 个标签，Ctrl+9 跳到最后一个
        e.preventDefault();
        const t = k === '9' ? tabs[tabs.length - 1] : tabs[+k - 1];
        if (t && t.id !== activeId) activateTab(t.id);
      }
      return;
    }
    if (typing) return;
    // 工具快捷键：H 手型 / M 高亮 / P 画笔 / T 文字
    if (!e.altKey && !e.metaKey) {
      const tk = { h: 'hand', m: 'highlight', p: 'pen', t: 'text' }[e.key.toLowerCase()];
      if (tk) { e.preventDefault(); setTool(tk); return; }
    }
    if (e.key === 'F6') { e.preventDefault(); focusOther(); return; }   // F6：在分屏的两个窗格间切换焦点
    const cp = curPane();
    if (!cp || !cp.viewer || !cp.pages.length) return;
    // 键盘翻页（作用于焦点窗格）
    const viewer = cp.viewer;
    const page = viewer.clientHeight * 0.9;
    switch (e.key) {
      case 'PageDown': case ' ': viewer.scrollBy({ top: page }); break;
      case 'PageUp': viewer.scrollBy({ top: -page }); break;
      case 'ArrowDown': viewer.scrollBy({ top: 60 }); break;
      case 'ArrowUp': viewer.scrollBy({ top: -60 }); break;
      case 'ArrowRight': viewer.scrollBy({ left: 60 }); break;
      case 'ArrowLeft': viewer.scrollBy({ left: -60 }); break;
      case 'Home': viewer.scrollTo({ top: 0 }); break;
      case 'End': viewer.scrollTo({ top: viewer.scrollHeight }); break;
      default: return;
    }
    e.preventDefault();
  });

  // 拖拽打开
  let dragDepth = 0;
  // 只有拖入「文件」才显示拖放提示；拖动标签排序时不触发
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    if (!hasFiles(e)) return;
    const paths = Array.from(e.dataTransfer.files)
      .filter((f) => /\.pdf$/i.test(f.name))
      .map((f) => api && api.pathOf(f))
      .filter(Boolean);
    if (api && pdfReady && paths.length) await openFiles(await api.open(paths));   // 可一次拖入多个
  });

  if (api) {
    api.onOpenFile(async (paths) => { if (pdfReady) await openFiles(await api.open(paths)); });
    api.getOpacity().then(showOpacity);
    api.onOpacityChanged(showOpacity);
    if (api.getStealth) {
      api.getStealth().then(showStealth);
      api.onStealthChanged(showStealth);
    }
    if (api.getTrigger) {
      api.getTriggerPresets().then((p) => { presets = p; });
      api.getTrigger().then((t) => {
        showTrigger(t);
        if (t.code === null || t.code === undefined) {
          showToast('触发键「' + t.label + '」尚未绑定（Fn 通常无法被 Windows 识别），窗口暂时一直显示。点工具栏的「' + t.label + '」选择别的键。', false);
        }
      });
      api.onTriggerChanged((t) => { showTrigger(t); toast('触发键已设为「' + t.label + '」'); });
      api.onOpenTriggerDialog(openTriggerDialog);
    }
  }

  setColor('#ffd400');
  setTool('hand');
  showStealth(true);
  syncToolbar();
})();
