/* StealthPDF 渲染进程核心：文档 / 标签 / 窗格、渲染、标注、查找、页面编辑、文件操作。
 * 界面（功能区 / 侧栏）在 ribbon.js、sidebar.js，通过 window.App 调用这里的功能。 */
(() => {
  const $ = (id) => document.getElementById(id);
  const stage = $('stage'), panesEl = $('panes');
  const api = window.api;
  const AN = window.Annos, PR = window.PageRange;

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

  /* ---------- 事件 ---------- */
  const listeners = {};
  const on = (evt, fn) => { (listeners[evt] = listeners[evt] || []).push(fn); };
  const emit = (evt, ...a) => (listeners[evt] || []).forEach((fn) => { try { fn(...a); } catch (e) { console.error(e); } });

  /* ---------- 本地偏好（主题等），读写失败时静默 ---------- */
  const pref = {
    get(k, d) { try { const v = localStorage.getItem('sp.' + k); return v === null ? d : v; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem('sp.' + k, v); } catch (_) {} }
  };

  /* ---------- 状态 ----------
   * 标签（tab）→ 最多两个窗格（pane）。每个窗格是一个独立的 PDF：
   *   自己的文档、缩放、旋转、滚动位置、未保存的标注。
   * 缩放 / 页码 / 撤销 / 保存等，作用于「当前标签的焦点窗格」。 */
  let tool = 'hand';
  let color = '#ffd400';
  let penWidth = 2;
  let textSize = 16;
  let tabs = [];            // { id, panes:[pane], focus, ratio, sync }
  let activeId = null;
  let nextTabId = 1;
  let draggingTabId = null;
  let lastScale = 1.25;     // 新打开的窗格沿用最近一次的缩放
  const MIN_PANE = 260;     // 单个窗格最小宽度（px）
  const MARK_TOOLS = { markhl: 'highlight', markul: 'underline', markst: 'strike' };
  const TOOL_HINT = {
    hand: '手型：按住鼠标拖动页面', select: '选择文字：拖选后可复制（Ctrl+C）',
    markhl: '文字高亮：拖选文字即可高亮', markul: '下划线：拖选文字即可添加下划线', markst: '删除线：拖选文字即可添加删除线',
    highlight: '区域高亮：拖拽框选', pen: '画笔：按住拖动', rect: '矩形：拖拽画框', text: '文字：点击页面输入', eraser: '橡皮擦：点击标注即可删除（仅未保存的标注）'
  };

  // pane: { path, name, doc, scale, rotation, twoUp, annos, undo, redo, edited, encrypted, size, scrollTop, scrollLeft, lastTop,
  //         pages, observer, token, drawing, textCache, find, el, viewer, pagesEl, titleEl, dotEl }
  // 标注坐标：缩放 1 时视图里的坐标（pt，左上角原点，已含页面旋转）；a.rot 记录创建时该页的视图旋转角

  const baseName = (p) => p.split(/[\\/]/).pop();
  const dirName = (p) => p.slice(0, Math.max(0, p.length - baseName(p).length)).replace(/[\\/]$/, '');
  const normPath = (p) => p.replace(/\//g, '\\').toLowerCase();
  const activeTab = () => tabs.find((t) => t.id === activeId) || null;
  const focusPane = (t) => (t ? t.panes[t.focus] || t.panes[0] : null);
  const curPane = () => focusPane(activeTab());
  const paneDirty = (p) => p.annos.length > 0 || p.edited;
  const tabDirty = (t) => t.panes.some(paneDirty);
  const tabName = (t) => t.panes.map((p) => p.name).join('  │  ');
  const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
  const clampScale = (s) => Math.min(4, Math.max(0.25, +s.toFixed(2)));
  const confirmDialog = (title, msg, okText) => Dlg.confirm(title, msg, okText || '确定');

  function makePane(path, doc, extra) {
    return Object.assign({
      path, name: baseName(path), doc, scale: lastScale, rotation: 0, twoUp: false, annos: [], undo: [], redo: [], edited: false,
      encrypted: false, size: 0, scrollTop: 0, scrollLeft: 0, lastTop: 0, pages: [], observer: null, token: 0, drawing: null,
      textCache: {}, find: null, el: null, viewer: null, pagesEl: null, titleEl: null, dotEl: null
    }, extra || {});
  }

  /** 是否带加密字典：在文件尾部找 /Encrypt（xref 流或传统 trailer 都在尾部附近） */
  function looksEncrypted(bytes) {
    try {
      const tail = bytes.subarray(Math.max(0, bytes.length - 65536));
      let s = '';
      for (let i = 0; i < tail.length; i += 8192) s += String.fromCharCode.apply(null, tail.subarray(i, i + 8192));
      return /\/Encrypt\s+\d+\s+\d+\s+R/.test(s);
    } catch (_) { return false; }
  }

  /** 用 pdf.js 打开字节；需要密码时弹出输入框。用户取消返回 null */
  async function openBytes(data, name) {
    let password;
    for (;;) {
      try {
        const doc = await pdfjsLib.getDocument({ data: data.slice(), password }).promise;
        return { doc, password };
      } catch (err) {
        if (err && err.name === 'PasswordException') {
          const pw = await Dlg.prompt({
            title: '此文件已加密', type: 'password', okText: '打开',
            message: '请输入「' + name + '」的打开密码' + (err.code === 2 ? '（密码不正确，请重试）' : '') + '。',
            validate: (v) => (v ? null : '请输入密码')
          });
          if (pw === null) return null;
          password = pw;
          continue;
        }
        throw err;
      }
    }
  }

  async function loadPane(res) {
    if (res.error) { showError(baseName(res.path) + '：' + res.error); return null; }
    try {
      const r = await openBytes(res.data, baseName(res.path));
      if (!r) return null;
      return makePane(res.path, r.doc, { size: res.data.length, encrypted: r.password !== undefined || looksEncrypted(res.data) });
    } catch (err) {
      showError('无法打开「' + baseName(res.path) + '」（文件可能已损坏）');
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
    const ci = $('color'); if (ci) ci.value = c;
    document.querySelectorAll('.swatch[data-color]').forEach(s =>
      s.classList.toggle('active', s.dataset.color.toLowerCase() === c.toLowerCase()));
    emit('change');
  }
  function setTool(t) {
    tool = t;
    Array.from(document.body.classList).filter((c) => c.startsWith('tool-')).forEach((c) => document.body.classList.remove(c));
    document.body.classList.add('tool-' + t);
    document.body.classList.toggle('sel-text', t === 'select' || t in MARK_TOOLS);
    // 高亮默认黄色；画笔 / 文字 / 矩形 / 下划线 / 删除线默认红色（只在还是默认色时自动切换，不覆盖用户选的颜色）
    const isY = color.toLowerCase() === '#ffd400', isR = color.toLowerCase() === '#e53935';
    if ((t === 'highlight' || t === 'markhl') && isR) setColor('#ffd400');
    if (['pen', 'text', 'rect', 'markul', 'markst'].includes(t) && isY) setColor('#e53935');
    if (!(t === 'select' || t in MARK_TOOLS)) { const s = window.getSelection(); if (s) s.removeAllRanges(); }
    const h = $('statusHint'); if (h) h.textContent = TOOL_HINT[t] || '';
    emit('change');
  }

  /* ---------- 工具栏 / 状态栏同步 ---------- */
  function syncToolbar() {
    const t = activeTab();
    const p = focusPane(t);
    const split = !!t && t.panes.length === 2;
    if (!p) {
      $('zoomLabel').textContent = Math.round(lastScale * 100) + '%';
      $('zoomSlider').value = Math.round(lastScale * 100);
      $('pageTotal').textContent = '/ 0';
      $('pageInput').value = 1;
      document.title = 'StealthPDF';
      emit('change');
      return;
    }
    $('zoomLabel').textContent = Math.round(p.scale * 100) + '%';
    $('zoomSlider').value = Math.round(p.scale * 100);
    $('pageTotal').textContent = '/ ' + p.doc.numPages;
    $('pageInput').max = p.doc.numPages;
    if (p.pages.length) $('pageInput').value = currentPageIndex(p) + 1;
    $('btnLayoutSingle').classList.toggle('active', !p.twoUp);
    $('btnLayoutTwo').classList.toggle('active', p.twoUp);
    document.title = 'StealthPDF - ' + (split ? tabName(t) : p.name) + (paneDirty(p) ? ' *' : '');
    t.panes.forEach((q, i) => {
      if (!q.el) return;
      q.el.classList.toggle('focus', i === t.focus);
      q.titleEl.textContent = q.name;
      q.titleEl.title = q.path;
      q.dotEl.hidden = !paneDirty(q);
    });
    emit('change');
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
      p.observer = null; p.pages = []; p.drawing = null; p.curIdx = -1;
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
    refreshRecent();
  }

  async function closeTab(id) {
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    if (tabDirty(t) && !(await confirmDialog('关闭「' + tabName(t) + '」？', '这个标签页里有未保存的修改，关闭后会丢失。', '不保存，直接关闭'))) return;
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
    refreshRecent();
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
    if (paneDirty(p) && !(await confirmDialog('关闭「' + p.name + '」？', '这个窗格里有未保存的修改，关闭后会丢失。', '不保存，直接关闭'))) return;
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
    pagesEl.classList.toggle('two-up', !!p.twoUp);
    p.pages = [];
    p.curIdx = -1;

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
      const vp = pdfPage.getViewport({ scale: p.scale, rotation: ((pdfPage.rotate || 0) + p.rotation) % 360 });
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.idx = idx;
      el.style.width = vp.width + 'px';
      el.style.height = vp.height + 'px';
      pagesEl.appendChild(el);
      p.pages.push({ idx, el, pdfPage, vp, canvas: null, overlay: null, textLayer: null, rendered: false });
      observer.observe(el);
    });
    if (focusPane(activeTab()) === p) syncToolbar();
  }

  async function getText(p, idx) {
    if (!p.textCache[idx]) {
      const page = await p.doc.getPage(idx + 1);
      p.textCache[idx] = await page.getTextContent();
    }
    return p.textCache[idx];
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

    const tl = document.createElement('div');          // 文字层：透明文字，用于选择 / 复制
    tl.className = 'textLayer';
    tl.style.setProperty('--scale-factor', String(vp.scale));
    pg.el.appendChild(tl);
    pg.textLayer = tl;

    const overlay = document.createElement('canvas');
    overlay.className = 'overlay';
    overlay.width = canvas.width;
    overlay.height = canvas.height;
    overlay.style.width = vp.width + 'px';
    overlay.style.height = vp.height + 'px';
    pg.el.appendChild(overlay);
    pg.overlay = overlay;
    bindOverlay(p, pg);

    drawFind(p, pg);
    await pg.pdfPage.render({
      canvasContext: canvas.getContext('2d'),
      viewport: vp,
      transform: [dpr, 0, 0, dpr, 0, 0]
    }).promise;
    drawOverlay(p, pg);

    if (typeof pdfjsLib.renderTextLayer === 'function') {
      try {
        const tc = await getText(p, pg.idx);
        if (pg.textLayer === tl && tl.isConnected) {
          await pdfjsLib.renderTextLayer({ textContentSource: tc, container: tl, viewport: vp, textDivs: [] }).promise;
        }
      } catch (err) { console.warn('文字层渲染失败', err); }
    }
  }

  /* ---------- 标注绘制 ---------- */
  function drawOne(ctx, a) {
    if (a.type === 'highlight') {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = a.color;
      AN.rectsOf(a).forEach(([x, y, w, h]) => ctx.fillRect(x, y, w, h));
      ctx.globalAlpha = 1;
    } else if (a.type === 'underline' || a.type === 'strike') {
      ctx.strokeStyle = a.color;
      ctx.lineCap = 'butt';
      AN.rectsOf(a).forEach(([x, y, w, h]) => {
        const ly = a.type === 'underline' ? y + h * 0.92 : y + h * 0.56;
        ctx.lineWidth = Math.max(0.8, h * 0.07);
        ctx.beginPath(); ctx.moveTo(x, ly); ctx.lineTo(x + w, ly); ctx.stroke();
      });
    } else if (a.type === 'rect') {
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width || 2;
      ctx.lineJoin = 'miter';
      ctx.strokeRect(a.x, a.y, a.w, a.h);
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
  const redrawPage = (p, i) => drawOverlay(p, p.pages[i]);

  /* ---------- 标注历史（撤销 / 重做） ---------- */
  function commit(p, a) {
    p.annos.push(a);
    p.undo.push({ k: 'add', a });
    p.redo.length = 0;
    redrawPage(p, a.page);
    markDirty();
  }
  function undo() {
    const p = curPane();
    const e = p && p.undo.pop();
    if (!e) return;
    if (e.k === 'add') { const i = p.annos.lastIndexOf(e.a); if (i >= 0) p.annos.splice(i, 1); }
    else p.annos.splice(Math.min(e.i, p.annos.length), 0, e.a);
    p.redo.push(e);
    redrawPage(p, e.a.page);
    markDirty();
  }
  function redo() {
    const p = curPane();
    const e = p && p.redo.pop();
    if (!e) return;
    if (e.k === 'add') p.annos.push(e.a);
    else { const i = p.annos.lastIndexOf(e.a); if (i >= 0) p.annos.splice(i, 1); }
    p.undo.push(e);
    redrawPage(p, e.a.page);
    markDirty();
  }
  const clearHistory = (p) => { p.annos = []; p.undo = []; p.redo = []; p.drawing = null; };

  /* ---------- 鼠标交互（标注） ---------- */
  function bindOverlay(p, pg) {
    const ov = pg.overlay;
    const pos = (e) => {
      const r = ov.getBoundingClientRect();
      return [(e.clientX - r.left) / p.scale, (e.clientY - r.top) / p.scale];
    };
    const rot = () => pg.vp.rotation;

    ov.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !['highlight', 'pen', 'rect', 'text', 'eraser'].includes(tool)) return;
      const [x, y] = pos(e);
      if (tool === 'text') { startTextInput(p, pg, x, y, color); return; }
      if (tool === 'eraser') {
        const i = AN.pick(p.annos, pg.idx, x, y, 6 / p.scale);
        if (i >= 0) {
          const [a] = p.annos.splice(i, 1);
          p.undo.push({ k: 'del', a, i });
          p.redo.length = 0;
          redrawPage(p, pg.idx);
          markDirty();
        }
        return;
      }
      ov.setPointerCapture(e.pointerId);
      if (tool === 'highlight') {
        p.drawing = { type: 'highlight', page: pg.idx, x, y, w: 0, h: 0, sx: x, sy: y, color, rot: rot() };
      } else if (tool === 'rect') {
        p.drawing = { type: 'rect', page: pg.idx, x, y, w: 0, h: 0, sx: x, sy: y, color, width: penWidth, rot: rot() };
      } else if (tool === 'pen') {
        p.drawing = { type: 'pen', page: pg.idx, points: [[x, y]], width: penWidth, color, rot: rot() };
      }
      drawOverlay(p, pg);
    });

    ov.addEventListener('pointermove', (e) => {
      const d = p.drawing;
      if (!d || d.page !== pg.idx) return;
      const [x, y] = pos(e);
      if (d.type === 'highlight' || d.type === 'rect') {
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
      if (d.type === 'highlight' || d.type === 'rect') {
        if (d.w < 2 || d.h < 2) { drawOverlay(p, pg); return; }
        delete d.sx; delete d.sy;
      }
      commit(p, d);
    };
    ov.addEventListener('pointerup', finish);
    ov.addEventListener('pointercancel', finish);
  }

  function startTextInput(p, pg, x, y, c) {
    const size = textSize;
    const input = document.createElement('input');
    input.className = 'text-input';
    input.style.left = x * p.scale + 'px';
    input.style.top = y * p.scale + 'px';
    input.style.fontSize = size * p.scale + 'px';
    input.style.color = c;
    pg.el.appendChild(input);
    setTimeout(() => input.focus(), 0);

    let done = false;
    const finishText = (save) => {
      if (done) return;
      done = true;
      const text = input.value.trim();
      input.remove();
      if (save && text) commit(p, { type: 'text', page: pg.idx, x, y, text, size, color: c, rot: pg.vp.rotation });
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finishText(true);
      else if (e.key === 'Escape') finishText(false);
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finishText(true));
  }

  /* ---------- 文字选择 → 高亮 / 下划线 / 删除线 / 复制 ---------- */
  function selectionRects(p) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return [];
    const range = sel.getRangeAt(0);
    const out = [];
    p.pages.forEach((pg) => {
      const tl = pg.textLayer;
      if (!tl || !range.intersectsNode(tl)) return;
      const pr = pg.el.getBoundingClientRect();
      const rects = [];
      tl.querySelectorAll('span').forEach((sp) => {
        const tn = sp.firstChild;
        if (!tn || tn.nodeType !== 3 || !range.intersectsNode(sp)) return;
        let so = 0, eo = tn.length;
        if (range.startContainer === tn) so = range.startOffset;
        if (range.endContainer === tn) eo = range.endOffset;
        if (eo <= so) return;
        const r = document.createRange();
        r.setStart(tn, so); r.setEnd(tn, eo);
        const b = r.getBoundingClientRect();
        if (!b.width || !b.height) return;
        rects.push([(b.left - pr.left) / p.scale, (b.top - pr.top) / p.scale, b.width / p.scale, b.height / p.scale]);
      });
      if (rects.length) out.push({ pg, rects: AN.mergeRects(rects) });
    });
    return out;
  }

  /** 把当前选中的文字做成标注。返回是否有内容被标注 */
  function applySelection(kind) {
    const p = curPane();
    if (!p) return false;
    const groups = selectionRects(p);
    if (!groups.length) return false;
    groups.forEach(({ pg, rects }) => commit(p, { type: kind, page: pg.idx, rects, color, rot: pg.vp.rotation }));
    window.getSelection().removeAllRanges();
    return true;
  }
  /** 功能区按钮：切到对应工具；如果已经选中了文字，立即应用 */
  function useMark(kind) {
    const t = { highlight: 'markhl', underline: 'markul', strike: 'markst' }[kind];
    setTool(t);
    if (!applySelection(kind)) toast('请用鼠标拖选要标注的文字');
  }
  document.addEventListener('mouseup', () => {
    const kind = MARK_TOOLS[tool];
    if (!kind) return;
    setTimeout(() => applySelection(kind), 0);
  });

  function selectionText() {
    const s = window.getSelection();
    return s ? s.toString() : '';
  }
  async function copySelection() {
    const text = selectionText();
    if (!text.trim()) return toast('没有选中文字：先用「选择文字」工具拖选');
    try { await navigator.clipboard.writeText(text); }
    catch (_) { document.execCommand('copy'); }
    toast('已复制 ' + text.length + ' 个字符');
  }

  /* ---------- 缩放 / 翻页 / 旋转 / 布局 ---------- */
  async function rebuild(p, idx) {
    if (!p || !p.viewer) return;
    if (idx === undefined) idx = Math.max(0, currentPageIndex(p));
    await buildPages(p);
    const pg = p.pages[idx];
    if (pg && p.viewer) p.viewer.scrollTop = Math.max(0, pg.el.offsetTop - 22);
    p.lastTop = p.viewer ? p.viewer.scrollTop : 0;
    syncToolbar();
  }
  async function setScale(p, s) {
    if (!p || !p.viewer) return;
    p.scale = lastScale = clampScale(s);
    await rebuild(p);
  }
  const zoom = (d, p) => { p = p || curPane(); if (p) setScale(p, p.scale + d); };
  const setZoomPct = (n, p) => { p = p || curPane(); if (p) setScale(p, n / 100); };

  async function pageSize(p, i) {
    const page = await p.doc.getPage((i || 0) + 1);
    const vp = page.getViewport({ scale: 1, rotation: ((page.rotate || 0) + p.rotation) % 360 });
    return [vp.width, vp.height];
  }
  async function fitWidth(p) {
    p = p || curPane();
    if (!p || !p.viewer) return;
    const [w] = await pageSize(p, Math.max(0, currentPageIndex(p)));
    const cols = p.twoUp ? 2 : 1;
    await setScale(p, (p.viewer.clientWidth - 56 - (cols - 1) * 16) / (w * cols));
  }
  async function fitPage(p) {
    p = p || curPane();
    if (!p || !p.viewer) return;
    const [w, h] = await pageSize(p, Math.max(0, currentPageIndex(p)));
    const cols = p.twoUp ? 2 : 1;
    await setScale(p, Math.min((p.viewer.clientWidth - 56 - (cols - 1) * 16) / (w * cols), (p.viewer.clientHeight - 48) / h));
  }
  const actualSize = () => setZoomPct(100);

  async function rotateView(delta) {
    const p = curPane();
    if (!p || !p.viewer) return;
    if (p.annos.length) return toast('有未保存的标注时不能旋转视图，请先保存或撤销标注');
    p.rotation = (((p.rotation + delta) % 360) + 360) % 360;
    await rebuild(p);
    toast('视图旋转 ' + p.rotation + '°（仅影响显示，不修改文件；要改文件请用「编辑」里的旋转页面）');
  }
  async function setLayout(kind) {
    const p = curPane();
    if (!p || !p.viewer) return;
    p.twoUp = kind === 'two';
    await rebuild(p);
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
  function scrollToPage(p, i) {
    if (!p || !p.viewer || !p.pages[i]) return;
    p.viewer.scrollTop = Math.max(0, p.pages[i].el.offsetTop - 22);
  }
  function goToPage(spec) {
    const p = curPane();
    if (!p || !p.pages.length) return;
    const cur = currentPageIndex(p), n = p.pages.length;
    const i = spec === 'first' ? 0 : spec === 'last' ? n - 1 : spec === 'prev' ? cur - 1 : spec === 'next' ? cur + 1 : (+spec || 1) - 1;
    scrollToPage(p, Math.min(n - 1, Math.max(0, i)));
  }
  $('pageInput').addEventListener('change', (e) => goToPage(e.target.value));

  /* ---------- 查找 ---------- */
  const findState = { token: 0 };
  const hitsByPage = (p) => {
    const map = {};
    if (p.find) p.find.matches.forEach((m, k) => { (map[m.page] = map[m.page] || []).push({ k, m }); });
    return map;
  };
  function drawFind(p, pg) {
    if (!pg || !pg.el) return;
    pg.el.querySelectorAll('.find-hit').forEach((n) => n.remove());
    if (!p.find || !p.find.matches.length) return;
    const list = hitsByPage(p)[pg.idx] || [];
    list.forEach(({ k, m }) => {
      m.rects.forEach((r) => {
        const [x1, y1, x2, y2] = pg.vp.convertToViewportRectangle(r);
        const d = document.createElement('div');
        d.className = 'find-hit' + (k === p.find.cur ? ' cur' : '');
        d.style.left = Math.min(x1, x2) + 'px';
        d.style.top = Math.min(y1, y2) + 'px';
        d.style.width = Math.abs(x2 - x1) + 'px';
        d.style.height = Math.abs(y2 - y1) + 'px';
        pg.el.appendChild(d);
      });
    });
  }
  const redrawFind = (p) => p.pages.forEach((pg) => drawFind(p, pg));

  function findInPage(tc, query, cs) {
    let text = '';
    const starts = [];
    tc.items.forEach((it) => {
      if (typeof it.str !== 'string') return;
      starts.push({ it, at: text.length });
      text += it.str + (it.hasEOL ? '\n' : '');
    });
    const hay = cs ? text : text.toLowerCase();
    const needle = cs ? query : query.toLowerCase();
    const found = [];
    let from = 0;
    for (;;) {
      const s = hay.indexOf(needle, from);
      if (s < 0) break;
      const e = s + needle.length;
      const rects = [];
      starts.forEach(({ it, at }) => {
        const len = it.str.length;
        if (!len || at >= e || at + len <= s) return;
        const a = Math.max(s, at) - at, b = Math.min(e, at + len) - at;
        const x = it.transform[4], y = it.transform[5];
        const w = it.width || 0, h = it.height || Math.abs(it.transform[3]) || 10;
        rects.push([x + w * a / len, y - h * 0.2, x + w * b / len, y + h * 0.85]);
      });
      if (rects.length) found.push({ rects });
      from = Math.max(e, s + 1);
    }
    return found;
  }

  function setFindCount(p) {
    const n = p && p.find ? p.find.matches.length : 0;
    $('findCount').textContent = n ? (p.find.cur + 1) + '/' + n : (p && p.find && p.find.q ? '无结果' : '0/0');
    $('findInput').classList.toggle('bad', !!(p && p.find && p.find.q && !n && !p.find.busy));
  }

  async function runFind() {
    const p = curPane();
    const q = $('findInput').value;
    if (!p) return;
    const token = ++findState.token;
    if (!q) { p.find = null; redrawFind(p); setFindCount(p); return; }
    const cs = $('findCase').classList.contains('on');
    const matches = [];
    p.find = { q, matches, cur: -1, busy: true };
    for (let i = 0; i < p.doc.numPages; i++) {
      if (token !== findState.token) return;
      const tc = await getText(p, i);
      findInPage(tc, q, cs).forEach((m) => matches.push({ page: i, rects: m.rects }));
      if (i % 8 === 7) { p.find.cur = matches.length ? 0 : -1; setFindCount(p); }
    }
    if (token !== findState.token) return;
    p.find.busy = false;
    const here = Math.max(0, currentPageIndex(p));
    const first = matches.findIndex((m) => m.page >= here);
    p.find.cur = matches.length ? (first >= 0 ? first : 0) : -1;
    redrawFind(p);
    setFindCount(p);
    if (matches.length) gotoMatch(p, p.find.cur);
  }
  function gotoMatch(p, k) {
    if (!p.find || !p.find.matches.length) return;
    const n = p.find.matches.length;
    p.find.cur = ((k % n) + n) % n;
    const m = p.find.matches[p.find.cur];
    redrawFind(p);
    setFindCount(p);
    const pg = p.pages[m.page];
    if (!pg || !p.viewer) return;
    const [x1, y1, x2, y2] = pg.vp.convertToViewportRectangle(m.rects[0]);
    p.viewer.scrollTop = Math.max(0, pg.el.offsetTop + Math.min(y1, y2) - p.viewer.clientHeight / 3);
    const left = pg.el.offsetLeft + Math.min(x1, x2);
    if (left < p.viewer.scrollLeft + 20 || left > p.viewer.scrollLeft + p.viewer.clientWidth - 40) p.viewer.scrollLeft = Math.max(0, left - p.viewer.clientWidth / 2);
  }
  function findStep(dir) {
    const p = curPane();
    if (!p || !p.find) return;
    gotoMatch(p, p.find.cur + dir);
  }
  function openFind() {
    if (!activeTab()) return toast('请先打开一个 PDF');
    $('findbar').hidden = false;
    const sel = selectionText().trim();
    if (sel && sel.length < 80 && !/\n/.test(sel)) $('findInput').value = sel;
    $('findInput').focus();
    $('findInput').select();
    if ($('findInput').value) runFind();
    emit('change');
  }
  function closeFind() {
    $('findbar').hidden = true;
    if (document.activeElement && document.activeElement.id === 'findInput') document.activeElement.blur();
    findState.token++;
    tabs.forEach((t) => t.panes.forEach((p) => { if (p.find) { p.find = null; redrawFind(p); } }));
    emit('change');
  }
  $('findInput').addEventListener('input', () => runFind());
  $('findInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    e.stopPropagation();
  });
  $('findNext').onclick = () => findStep(1);
  $('findPrev').onclick = () => findStep(-1);
  $('findCase').onclick = () => { $('findCase').classList.toggle('on'); $('findCase').classList.toggle('active'); runFind(); };
  $('findClose').onclick = closeFind;

  /* ---------- 阅读色 / 主题 ---------- */
  let pageColor = pref.get('pagecolor', 'normal');
  function setPageColor(mode) {
    pageColor = ['normal', 'night', 'sepia'].includes(mode) ? mode : 'normal';
    stage.classList.remove('pc-night', 'pc-sepia');
    if (pageColor !== 'normal') stage.classList.add('pc-' + pageColor);
    pref.set('pagecolor', pageColor);
    emit('change');
  }
  let themePref = pref.get('theme', 'dark');
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function applyTheme() {
    const eff = themePref === 'auto' ? (mq && !mq.matches ? 'light' : 'dark') : themePref;
    document.documentElement.setAttribute('data-theme', eff);
    emit('change');
  }
  function setTheme(mode) {
    themePref = ['dark', 'light', 'sepia', 'auto'].includes(mode) ? mode : 'dark';
    pref.set('theme', themePref);
    applyTheme();
  }
  if (mq && mq.addEventListener) mq.addEventListener('change', () => { if (themePref === 'auto') applyTheme(); });

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
      if (t === activeTab() && focusPane(t) === p && p.pages.length) {
        const ci = currentPageIndex(p);
        $('pageInput').value = ci + 1;
        if (ci !== p.curIdx) { p.curIdx = ci; emit('page', p, ci); }
      }
      if (!d || !t.sync || t.panes.length !== 2) return;
      const o = t.panes[0] === p ? t.panes[1] : t.panes[0];
      if (!o.viewer) return;
      o.viewer.scrollTop += d;
      o.lastTop = o.viewer.scrollTop;       // 让对侧的 scroll 事件算出 d = 0，避免来回弹
    });

    /* 滚轮：Ctrl+滚轮 缩放；Shift+滚轮 纵向滚动（Chromium 默认是横向）；Shift+Alt+滚轮 横向滚动；普通滚轮 浏览器默认 */
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

  /* ---------- 最近使用 ---------- */
  let recent = [];
  function renderRecent() {
    const box = $('recentBox'), list = $('recentList');
    list.innerHTML = '';
    recent.slice(0, 6).forEach((r) => {
      const b = document.createElement('button');
      b.className = 'recent-item';
      b.title = r.path;
      b.innerHTML = window.icon('doc') + '<span class="r-name"></span><span class="r-dir"></span>';
      b.querySelector('.r-name').textContent = baseName(r.path);
      b.querySelector('.r-dir').textContent = dirName(r.path);
      b.onclick = () => openRecent(r.path);
      list.appendChild(b);
    });
    box.hidden = recent.length === 0;
  }
  async function refreshRecent() {
    if (!api || !api.getRecent) return;
    try { recent = await api.getRecent(); } catch (_) { recent = []; }
    renderRecent();
    emit('recent');
  }
  async function openRecent(path) {
    if (!pdfReady || !api) return;
    await openFiles(await api.open([path]));
  }
  async function clearRecent() {
    if (api && api.clearRecent) await api.clearRecent();
    await refreshRecent();
  }

  /* ---------- 打开 / 保存 / 导出 / 打印 / 属性 ---------- */
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
    const p = curPane();
    if (!p) return toast('请先打开一个 PDF');
    if (!asNew && !paneDirty(p)) return toast('没有需要保存的修改');
    if (p.encrypted && paneDirty(p)) return showError('加密的 PDF 暂不支持保存修改');
    const bytes = p.edited ? await p.doc.getData() : undefined;      // 做过页面编辑：以当前文档内容为准
    const r = await api.save({ path: p.path, annotations: p.annos, saveAs: !!asNew, bytes });
    if (!r) return;
    const res = await api.open(r.path);       // 重新载入，标注已写入文件
    const item = res && res[0];
    if (!item || item.error) return showError('保存成功，但重新载入失败：' + ((item && item.error) || r.path));
    try {
      const o = await openBytes(item.data, baseName(r.path));
      if (!o) return;
      const old = p.doc;
      p.doc = o.doc;
      p.path = r.path;
      p.name = baseName(r.path);
      p.size = item.data.length;
      p.edited = false;
      p.textCache = {};
      p.find = null;
      clearHistory(p);
      if (p.viewer) {                                        // 只重建这一个窗格，保留滚动位置和缩放
        const keep = p.viewer.scrollTop;
        await buildPages(p);
        if (p.viewer) { p.viewer.scrollTop = keep; p.lastTop = keep; }
      }
      markDirty();
      try { old.destroy(); } catch (_) {}
      toast('已保存：' + p.name);
      refreshRecent();
    } catch (err) {
      showError('保存成功，但重新载入失败');
      console.error(err);
    }
  }

  /** 把某一页（连同未保存的标注）渲染到一张画布 */
  async function renderToCanvas(p, idx, scale) {
    const page = await p.doc.getPage(idx + 1);
    const vp = page.getViewport({ scale, rotation: ((page.rotate || 0) + p.rotation) % 360 });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    p.annos.filter((a) => a.page === idx).forEach((a) => drawOne(ctx, a));
    return c;
  }

  async function exportImage() {
    const p = curPane();
    if (!p) return toast('请先打开一个 PDF');
    if (!api || !api.saveFile) return showError('preload 未加载，无法导出');
    const idx = Math.max(0, currentPageIndex(p));
    toast('正在导出第 ' + (idx + 1) + ' 页…');
    const c = await renderToCanvas(p, idx, 2);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const path = await api.saveFile({
      defaultName: p.name.replace(/\.pdf$/i, '') + '-第' + (idx + 1) + '页.png',
      filters: [{ name: 'PNG 图片', extensions: ['png'] }], bytes
    });
    if (path) toast('已导出图片：' + baseName(path));
  }

  async function printDoc() {
    const p = curPane();
    if (!p) return toast('请先打开一个 PDF');
    const n = p.doc.numPages;
    const text = await Dlg.prompt({
      title: '打印', okText: '打印', value: 'all',
      message: '共 ' + n + ' 页，当前在第 ' + (currentPageIndex(p) + 1) + ' 页。输入要打印的页码，例如 1-3, 5；输入 all 打印全部。',
      validate: (v) => { const r = PR.parse(v, n); return r.ok ? null : r.error; }
    });
    if (text === null) return;
    const pages = PR.parse(text, n).pages;
    const root = $('printRoot');
    root.innerHTML = '';
    for (let k = 0; k < pages.length; k++) {
      showToast('正在准备打印：' + (k + 1) + ' / ' + pages.length, false, true);
      const c = await renderToCanvas(p, pages[k], 1.6);
      const box = document.createElement('div');
      box.className = 'print-page';
      const img = document.createElement('img');
      img.src = c.toDataURL('image/jpeg', 0.92);
      box.appendChild(img);
      root.appendChild(box);
    }
    $('toast').classList.remove('show');
    if (api && api.setHold) api.setHold(true);               // 打印预览期间让主进程别把窗口隐藏
    const done = () => {
      window.removeEventListener('afterprint', done);
      root.innerHTML = '';
      if (api && api.setHold) api.setHold(false);
    };
    window.addEventListener('afterprint', done);
    setTimeout(() => window.print(), 60);
  }

  function pdfDate(s) {
    const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s || '');
    if (!m) return s || '—';
    const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00'] = m;
    return y + '-' + mo + '-' + d + ' ' + h + ':' + mi + ':' + se;
  }
  const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B');

  async function showProperties() {
    const p = curPane();
    if (!p) return toast('请先打开一个 PDF');
    let meta = { info: {} };
    try { meta = await p.doc.getMetadata(); } catch (_) {}
    const info = meta.info || {};
    const first = await p.doc.getPage(1);
    const vp = first.getViewport({ scale: 1, rotation: 0 });
    const mm = (v) => Math.round(v * 25.4 / 72);
    const isA4 = Math.abs(vp.width - 595) < 3 && Math.abs(vp.height - 842) < 3;
    Dlg.info({
      title: '文档属性', sub: p.name,
      rows: [
        ['文件位置', p.path],
        ['文件大小', p.size ? fmtSize(p.size) : '—'],
        ['页数', String(p.doc.numPages)],
        ['页面尺寸', Math.round(vp.width) + ' × ' + Math.round(vp.height) + ' pt（' + mm(vp.width) + ' × ' + mm(vp.height) + ' mm' + (isA4 ? '，A4' : '') + '）'],
        ['标题', info.Title || '—'], ['作者', info.Author || '—'], ['主题', info.Subject || '—'], ['关键词', info.Keywords || '—'],
        ['创建程序', info.Creator || '—'], ['PDF 生成器', info.Producer || '—'],
        ['创建时间', pdfDate(info.CreationDate)], ['修改时间', pdfDate(info.ModDate)],
        ['PDF 版本', info.PDFFormatVersion || '—'],
        ['加密', p.encrypted ? '是' : '否'],
        ['未保存的修改', paneDirty(p) ? '有（' + p.annos.length + ' 个标注' + (p.edited ? '，页面已编辑' : '') + '）' : '无']
      ]
    });
  }

  /* ---------- 页面编辑（旋转 / 删除 / 插入 / 提取 / 合并） ---------- */
  function opGuard(p) {
    if (!p) { toast('请先打开一个 PDF'); return false; }
    if (p.encrypted) { showError('加密的 PDF 暂不支持页面编辑'); return false; }
    if (!api || !api.ops) { showError('preload 未加载，无法编辑页面'); return false; }
    return true;
  }

  /** 用新字节替换窗格里的文档；remap(旧页数, 新页数) 用来调整标注的页码 */
  async function applyDocBytes(p, bytes, o) {
    const r = await openBytes(bytes, p.name);
    if (!r) return false;
    const old = p.doc;
    const oldN = old.numPages;
    p.doc = r.doc;
    p.edited = true;
    p.size = bytes.length;
    p.textCache = {};
    p.find = null;
    if (o.remap) o.remap(oldN, r.doc.numPages);
    await rebuild(p, Math.min(Math.max(0, o.goto == null ? 0 : o.goto), r.doc.numPages - 1));
    try { old.destroy(); } catch (_) {}
    markDirty();
    if (!$('findbar').hidden && $('findInput').value) runFind();
    return true;
  }
  async function runOp(p, op, args, o) {
    const bytes = await p.doc.getData();
    const res = await api.ops(op, bytes, args);
    if (!res || !res.ok) { showError((res && res.error) || '操作失败'); return false; }
    return applyDocBytes(p, res.bytes, o || {});
  }
  /** 页码范围输入框；scope 为 'current' 时直接用当前页 */
  async function askPages(p, title, message, defVal) {
    const n = p.doc.numPages;
    const text = await Dlg.prompt({
      title, message, value: defVal, okText: '确定',
      validate: (v) => { const r = PR.parse(v, n); return r.ok ? null : r.error; }
    });
    return text === null ? null : PR.parse(text, n).pages;
  }

  async function rotatePages(delta, scope) {
    const p = curPane();
    if (!opGuard(p)) return;
    const n = p.doc.numPages, cur = Math.max(0, currentPageIndex(p));
    let pages = [cur];
    if (scope === 'all') pages = Array.from({ length: n }, (_, i) => i);
    else if (scope === 'range') {
      pages = await askPages(p, '旋转页面', '输入要旋转的页码，例如 1-3, 5（共 ' + n + ' 页）。', String(cur + 1));
      if (!pages) return;
    }
    if (p.annos.some((a) => pages.includes(a.page))) return toast('这些页上有未保存的标注，请先保存或撤销标注再旋转页面');
    if (await runOp(p, 'rotate', { pages, delta }, { goto: cur })) toast('已旋转 ' + pages.length + ' 页（保存后写入文件）');
  }

  async function deletePages() {
    const p = curPane();
    if (!opGuard(p)) return;
    const n = p.doc.numPages, cur = Math.max(0, currentPageIndex(p));
    if (n < 2) return toast('只有一页，不能删除');
    const pages = await askPages(p, '删除页面', '输入要删除的页码，例如 2-4, 7（共 ' + n + ' 页）。删除后无法撤销，未保存前关闭标签可放弃。', String(cur + 1));
    if (!pages) return;
    if (pages.length >= n) return toast('不能删除全部页面');
    const hasAnno = p.annos.some((a) => pages.includes(a.page));
    if (hasAnno && !(await Dlg.confirm('删除含标注的页面？', '被删除的页面上有未保存的标注，这些标注会一并丢失。', '继续删除'))) return;
    const gone = new Set(pages);
    const ok = await runOp(p, 'delete', { pages }, {
      goto: Math.min(pages[0], n - pages.length - 1),
      remap: () => {
        p.annos = p.annos.filter((a) => !gone.has(a.page)).map((a) => {
          let shift = 0;
          gone.forEach((g) => { if (g < a.page) shift++; });
          return shift ? { ...a, page: a.page - shift } : a;
        });
        p.undo = []; p.redo = [];
      }
    });
    if (ok) toast('已删除 ' + pages.length + ' 页（保存后写入文件）');
  }

  async function insertBlank(where) {
    const p = curPane();
    if (!opGuard(p)) return;
    const n = p.doc.numPages, cur = Math.max(0, currentPageIndex(p));
    const after = where === 'before' ? cur - 1 : where === 'end' ? n - 1 : cur;
    const ok = await runOp(p, 'blank', { after }, {
      goto: after + 1,
      remap: () => { p.annos = p.annos.map((a) => (a.page > after ? { ...a, page: a.page + 1 } : a)); p.undo = []; p.redo = []; }
    });
    if (ok) toast('已插入空白页（保存后写入文件）');
  }

  /** 把另一个 PDF 的全部页面插入到当前文档 */
  async function insertPdf(where) {
    const p = curPane();
    if (!opGuard(p)) return;
    let res;
    try { res = await api.open(); } catch (err) { return showError(String((err && err.message) || err)); }
    if (!res || !res.length) return;
    const item = res[0];
    if (item.error) return showError(baseName(item.path) + '：' + item.error);
    if (looksEncrypted(item.data)) return showError('要插入的文件已加密，暂不支持');
    const n = p.doc.numPages, cur = Math.max(0, currentPageIndex(p));
    const after = where === 'before' ? cur - 1 : where === 'end' ? n - 1 : cur;
    const ok = await runOp(p, 'insert', { other: item.data, after }, {
      goto: after + 1,
      remap: (oldN, newN) => {
        const add = newN - oldN;
        p.annos = p.annos.map((a) => (a.page > after ? { ...a, page: a.page + add } : a));
        p.undo = []; p.redo = [];
      }
    });
    if (ok) toast('已插入「' + baseName(item.path) + '」（保存后写入文件）');
  }

  /** 把部分页面提取成一个新 PDF 并另存，再在新标签里打开 */
  async function extractPages() {
    const p = curPane();
    if (!opGuard(p)) return;
    if (!api.saveFile) return showError('preload 未加载，无法保存文件');
    const n = p.doc.numPages, cur = Math.max(0, currentPageIndex(p));
    const pages = await askPages(p, '提取页面', '输入要提取的页码，例如 1-3, 5（共 ' + n + ' 页）。提取出的页面会另存为新文件，原文件不变。', String(cur + 1));
    if (!pages) return;
    const bytes = await p.doc.getData();
    const res = await api.ops('extract', bytes, { pages });
    if (!res || !res.ok) return showError((res && res.error) || '提取失败');
    const path = await api.saveFile({ defaultName: p.name.replace(/\.pdf$/i, '') + '-提取.pdf', bytes: res.bytes });
    if (!path) return;
    toast('已提取 ' + pages.length + ' 页：' + baseName(path));
    await openFiles(await api.open([path]));
  }

  /* ---------- 全屏 ---------- */
  let isFs = false;
  async function toggleFullscreen(on) {
    if (!api || !api.setFullscreen) return;
    isFs = !!(await api.setFullscreen(typeof on === 'boolean' ? on : undefined));
    document.body.classList.toggle('fs', isFs);
    if (isFs) toast('已进入全屏，按 F11 或 Esc 退出');
    emit('change');
  }

  /* ---------- 设置缓存（隐身 / 置顶 / 透明度） ---------- */
  let settings = { stealth: true, alwaysOnTop: true, skipTaskbar: false, opacity: 1, trigger: { type: 'key', code: null, label: 'Fn' } };
  function applySettings(s) { settings = Object.assign({}, settings, s); emit('change'); }
  function showStealth(on) {
    settings.stealth = !!on;
    const b = $('btnStealth');
    b.classList.toggle('on', !!on);
    b.classList.toggle('off', !on);
    $('stealthText').textContent = on ? '隐身 开' : '隐身 关';
    $('stealthIcon').setAttribute('href', on ? '#i-eyeoff' : '#i-eye');
    emit('change');
  }
  async function toggleStealth() {
    if (!api || !api.setStealth) return showError('preload 未加载，无法切换隐身');
    const next = !settings.stealth;
    await api.setStealth(next);
    showStealth(next);
    toast(next
      ? '隐身已开启：按住「' + triggerLabel + '」并把光标移到窗口上才显示'
      : '隐身已关闭：窗口将一直显示');
  }
  $('btnStealth').onclick = toggleStealth;

  function showOpacity(v) {
    settings.opacity = v;
    emit('change');
  }
  function setOpacity(v) {
    settings.opacity = v;
    if (api) api.setOpacity(v);
    emit('change');
  }
  async function setSetting(k, v) {
    if (!api || !api.setSetting) return;
    applySettings(await api.setSetting(k, v));
  }

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
    settings.trigger = t;
    $('btnTrigger').title = '触发键：' + t.label + (bound ? '' : '（未绑定，窗口会一直显示）') + '。点击更改';
    $('fnNote').hidden = !(t.label === 'Fn');
    renderChips();
    emit('change');
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

  /* ---------- 事件绑定 ---------- */
  $('btnOpen2').onclick = openDialog;
  $('btnNewTab').onclick = openDialog;
  $('btnZoomIn').onclick = () => zoom(0.1);
  $('btnZoomOut').onclick = () => zoom(-0.1);
  $('btnFit').onclick = () => fitWidth();
  $('btnPrevPage').onclick = () => goToPage('prev');
  $('btnNextPage').onclick = () => goToPage('next');
  $('btnLayoutSingle').onclick = () => setLayout('single');
  $('btnLayoutTwo').onclick = () => setLayout('two');
  $('zoomSlider').addEventListener('change', (e) => setZoomPct(+e.target.value));
  $('zoomSlider').addEventListener('input', (e) => { $('zoomLabel').textContent = e.target.value + '%'; });
  $('sbClose').onclick = () => window.App && App.toggleSidebar(false);

  const SHORTCUT_TOOL = { h: 'hand', v: 'select', m: 'highlight', p: 'pen', t: 'text', r: 'rect', e: 'eraser' };

  window.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '');
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (typing && !['o', 's', 'f', 'p'].includes(k)) return;
      if (k === 'o') { e.preventDefault(); openDialog(); }
      else if (k === 's') { e.preventDefault(); save(e.shiftKey); }
      else if (k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (k === 'y') { e.preventDefault(); redo(); }
      else if (k === 'f') { e.preventDefault(); openFind(); }
      else if (k === 'p') { e.preventDefault(); printDoc(); }
      else if (k === 'g') { e.preventDefault(); $('pageInput').focus(); $('pageInput').select(); }
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
    if (e.key === 'Escape') {
      if (!$('findbar').hidden) { closeFind(); return; }
      if (isFs) { toggleFullscreen(false); return; }
    }
    if (typing) return;
    if (e.key === 'F11') { e.preventDefault(); toggleFullscreen(); return; }
    if (e.key === 'F4') { e.preventDefault(); window.App && App.toggleSidebar(); return; }
    if (e.key === 'F3') { e.preventDefault(); if ($('findbar').hidden) openFind(); else findStep(e.shiftKey ? -1 : 1); return; }
    if (e.key === 'F6') { e.preventDefault(); focusOther(); return; }   // F6：在分屏的两个窗格间切换焦点
    // 工具快捷键：H 手型 / V 选择文字 / M 区域高亮 / P 画笔 / T 文字 / R 矩形 / E 橡皮
    if (!e.altKey && !e.metaKey) {
      const tk = SHORTCUT_TOOL[e.key.toLowerCase()];
      if (tk) { e.preventDefault(); setTool(tk); return; }
    }
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

  /* ---------- 对外接口：功能区 / 侧栏通过它调用核心功能 ---------- */
  window.App = {
    on, emit, toast, error: showError, pref,
    // 状态
    get tool() { return tool; }, get color() { return color; }, get penWidth() { return penWidth; }, get textSize() { return textSize; },
    get tabs() { return tabs; }, get isFullscreen() { return isFs; }, get settings() { return settings; }, get recent() { return recent; },
    get pageColor() { return pageColor; }, get themePref() { return themePref; },
    tab: activeTab, pane: curPane, paneDirty, tabDirty, currentPageIndex,
    // 工具
    setTool, setColor, setPenWidth: (w) => { penWidth = w; emit('change'); }, setTextSize: (s) => { textSize = s; emit('change'); },
    useMark, undo, redo, copySelection, hasSelection: () => !!selectionText().trim(),
    // 文件
    openDialog, openRecent, clearRecent, refreshRecent, save, exportImage, printDoc, showProperties,
    closeTab: () => { if (activeId !== null) closeTab(activeId); },
    closeAllTabs: async () => { for (const t of tabs.slice()) { await closeTab(t.id); } },
    quit: () => api && api.quit && api.quit(),
    // 视图
    zoom, setZoomPct, fitWidth, fitPage, actualSize, rotateView, setLayout, goToPage, scrollToPage,
    setPageColor, setTheme, toggleFullscreen, openFind, closeFind,
    // 分屏
    toggleSplit, toggleSync, swapPanes,
    // 页面编辑
    rotatePages, deletePages, insertBlank, insertPdf, extractPages,
    // 隐身 / 窗口
    toggleStealth, openTriggerDialog, setOpacity, setSetting,
    peek: () => api && api.peek && api.peek().then(() => toast('窗口将保持显示 5 秒')),
    centerWindow: () => api && api.centerWindow && api.centerWindow().then(() => toast('窗口已移回屏幕中央')),
    openLogs: () => api && api.openLogs && api.openLogs(),
    appInfo: () => (api && api.appInfo ? api.appInfo() : Promise.resolve({})),
    // 侧栏占位，由 sidebar.js 覆盖
    toggleSidebar: () => {}
  };

  if (api) {
    api.onOpenFile(async (paths) => { if (pdfReady) await openFiles(await api.open(paths)); });
    if (api.getSettings) {
      api.getSettings().then(applySettings);
      api.onSettingsChanged(applySettings);
    }
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
          showToast('触发键「' + t.label + '」尚未绑定（Fn 通常无法被 Windows 识别），窗口暂时一直显示。点状态栏右侧的「' + t.label + '」选择别的键。', false);
        }
      });
      api.onTriggerChanged((t) => { showTrigger(t); toast('触发键已设为「' + t.label + '」'); });
      api.onOpenTriggerDialog(openTriggerDialog);
    }
    refreshRecent();
  }

  setColor('#ffd400');
  setTool('hand');
  applyTheme();
  setPageColor(pageColor);
  showStealth(true);
  syncToolbar();
})();
