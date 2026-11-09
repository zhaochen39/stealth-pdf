/* StealthPDF 渲染进程：pdf.js 负责显示，标注保存在内存，点「保存」时由主进程写入 PDF */
(() => {
  const $ = (id) => document.getElementById(id);
  const viewer = $('viewer'), pagesEl = $('pages');
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

  /* ---------- 状态 ---------- */
  let pdfDoc = null;
  let curPath = null;
  let scale = 1.25;
  let tool = 'hand';
  let color = '#ffd400';
  let annos = [];          // 坐标均为「缩放比例 1」下的页面坐标（pt，左上角为原点）
  let pages = [];          // { idx, el, canvas, overlay, pdfPage, vp, rendered }
  let observer = null;
  let drawing = null;

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

  /* ---------- 标签页 ----------
   * 每个标签独立保存：文档、缩放、滚动位置、未保存的标注。
   * 全局变量 pdfDoc / curPath / scale / annos 始终是「当前标签」的镜像。 */
  let tabs = [];            // { id, path, name, doc, scale, annos, scrollTop }
  let activeId = null;
  let nextTabId = 1;
  let buildToken = 0;       // 快速切换标签时，丢弃过期的页面构建
  let draggingTabId = null;

  const baseName = (p) => p.split(/[\\/]/).pop();
  const normPath = (p) => p.replace(/\//g, '\\').toLowerCase();
  const activeTab = () => tabs.find((t) => t.id === activeId) || null;
  const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));

  function saveActiveState() {
    const t = activeTab();
    if (!t) return;
    t.scrollTop = viewer.scrollTop;
    t.scale = scale;
    t.annos = annos;
  }

  async function activateTab(id, force) {
    const t = tabs.find((x) => x.id === id);
    if (!t) return;
    if (id !== activeId || force) saveActiveState();
    activeId = id;
    pdfDoc = t.doc;
    curPath = t.path;
    scale = t.scale;
    annos = t.annos;
    drawing = null;
    document.title = 'StealthPDF - ' + t.name;
    $('pageTotal').textContent = '/ ' + t.doc.numPages;
    $('pageInput').max = t.doc.numPages;
    renderTabs();
    await buildPages();
    if (activeId === id) viewer.scrollTop = t.scrollTop;   // 构建期间没有被切走才恢复滚动位置
  }

  /** 打开一批文件：已打开的直接切过去，其余各开一个新标签，最后激活最后一个 */
  async function openFiles(list) {
    if (!list || !list.length) return;
    let last = null;
    for (const res of list) {
      if (res.error) { showError(baseName(res.path) + '：' + res.error); continue; }
      const exist = tabs.find((t) => normPath(t.path) === normPath(res.path));
      if (exist) { last = exist.id; continue; }
      try {
        const doc = await pdfjsLib.getDocument({ data: res.data }).promise;
        const t = { id: nextTabId++, path: res.path, name: baseName(res.path), doc, scale, annos: [], scrollTop: 0 };
        tabs.push(t);
        last = t.id;
      } catch (err) {
        showError('无法打开「' + baseName(res.path) + '」（可能已加密或已损坏）');
        console.error(err);
      }
    }
    if (last !== null) await activateTab(last);
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
    const dirty = (id === activeId ? annos : t.annos).length > 0;
    if (dirty && !(await confirmDialog('关闭「' + t.name + '」？', '这个标签页里有未保存的标注，关闭后会丢失。', '不保存，直接关闭'))) return;
    const idx = tabs.indexOf(t);
    const wasActive = id === activeId;
    tabs.splice(idx, 1);
    try { t.doc.destroy(); } catch (_) {}
    if (!wasActive) return renderTabs();
    if (tabs.length) await activateTab(tabs[Math.min(idx, tabs.length - 1)].id);
    else showEmpty();
  }

  function showEmpty() {
    buildToken++;
    if (observer) observer.disconnect();
    activeId = null; pdfDoc = null; curPath = null; annos = []; drawing = null;
    pagesEl.innerHTML = '';
    pages = [];
    $('empty').style.display = '';
    $('pageTotal').textContent = '/ 0';
    $('pageInput').value = 1;
    document.title = 'StealthPDF';
    renderTabs();
  }

  function switchBy(step) {
    if (tabs.length < 2) return;
    const i = tabs.findIndex((t) => t.id === activeId);
    activateTab(tabs[(i + step + tabs.length) % tabs.length].id);
  }

  function renderTabs() {
    const bar = $('tabbar'), box = $('tabs');
    bar.hidden = tabs.length === 0;
    box.innerHTML = '';
    tabs.forEach((t) => {
      const dirty = (t.id === activeId ? annos : t.annos).length > 0;
      const el = document.createElement('div');
      el.className = 'tab' + (t.id === activeId ? ' active' : '');
      el.setAttribute('role', 'tab');
      el.draggable = true;
      el.dataset.id = t.id;
      el.title = t.path + (dirty ? '\n（有未保存的标注）' : '');
      if (dirty) { const d = document.createElement('span'); d.className = 'tab-dot'; el.appendChild(d); }
      const title = document.createElement('span');
      title.className = 'tab-title';
      title.textContent = t.name;
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

  /* ---------- 渲染 ---------- */
  async function buildPages() {
    const token = ++buildToken;
    if (observer) observer.disconnect();
    pagesEl.innerHTML = '';
    pages = [];
    $('empty').style.display = 'none';

    const doc = pdfDoc;
    const list = await Promise.all(
      Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1))
    );
    if (token !== buildToken) return;      // 期间切换了标签，放弃这次构建
    observer = new IntersectionObserver((entries) => {
      entries.forEach(en => { if (en.isIntersecting) renderPage(pages[+en.target.dataset.idx]); });
    }, { root: viewer, rootMargin: '700px 0px' });

    list.forEach((pdfPage, idx) => {
      const vp = pdfPage.getViewport({ scale });
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.idx = idx;
      el.style.width = vp.width + 'px';
      el.style.height = vp.height + 'px';
      pagesEl.appendChild(el);
      pages.push({ idx, el, pdfPage, vp, canvas: null, overlay: null, rendered: false });
      observer.observe(el);
    });
    updateZoomLabel();
  }

  async function renderPage(p) {
    if (p.rendered) return;
    p.rendered = true;
    const dpr = window.devicePixelRatio || 1;
    const vp = p.vp;

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = vp.width + 'px';
    canvas.style.height = vp.height + 'px';
    p.el.appendChild(canvas);
    p.canvas = canvas;

    const overlay = document.createElement('canvas');
    overlay.className = 'overlay';
    overlay.width = canvas.width;
    overlay.height = canvas.height;
    overlay.style.width = vp.width + 'px';
    overlay.style.height = vp.height + 'px';
    p.el.appendChild(overlay);
    p.overlay = overlay;
    bindOverlay(p);

    await p.pdfPage.render({
      canvasContext: canvas.getContext('2d'),
      viewport: vp,
      transform: [dpr, 0, 0, dpr, 0, 0]
    }).promise;
    drawOverlay(p);
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

  function drawOverlay(p) {
    if (!p.overlay) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = p.overlay.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, p.overlay.width, p.overlay.height);
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
    annos.filter(a => a.page === p.idx).forEach(a => drawOne(ctx, a));
    if (drawing && drawing.page === p.idx) drawOne(ctx, drawing);
  }

  /* ---------- 鼠标交互（标注） ---------- */
  function bindOverlay(p) {
    const ov = p.overlay;
    const pos = (e) => {
      const r = ov.getBoundingClientRect();
      return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale];
    };

    ov.addEventListener('pointerdown', (e) => {
      if (tool === 'hand' || e.button !== 0) return;
      const [x, y] = pos(e);
      if (tool === 'text') { startTextInput(p, x, y, color); return; }

      ov.setPointerCapture(e.pointerId);
      if (tool === 'highlight') {
        drawing = { type: 'highlight', page: p.idx, x, y, w: 0, h: 0, sx: x, sy: y, color };
      } else if (tool === 'pen') {
        drawing = { type: 'pen', page: p.idx, points: [[x, y]], width: 2, color };
      }
      drawOverlay(p);
    });

    ov.addEventListener('pointermove', (e) => {
      if (!drawing || drawing.page !== p.idx) return;
      const [x, y] = pos(e);
      if (drawing.type === 'highlight') {
        drawing.x = Math.min(x, drawing.sx);
        drawing.y = Math.min(y, drawing.sy);
        drawing.w = Math.abs(x - drawing.sx);
        drawing.h = Math.abs(y - drawing.sy);
      } else {
        drawing.points.push([x, y]);
      }
      drawOverlay(p);
    });

    const finish = () => {
      if (!drawing || drawing.page !== p.idx) return;
      const d = drawing;
      drawing = null;
      if (d.type === 'highlight') {
        if (d.w < 2 || d.h < 2) { drawOverlay(p); return; }
        delete d.sx; delete d.sy;
      }
      annos.push(d);
      drawOverlay(p);
      renderTabs();                         // 刷新标签上的「未保存」圆点
    };
    ov.addEventListener('pointerup', finish);
    ov.addEventListener('pointercancel', finish);
  }

  function startTextInput(p, x, y, c) {
    const size = 16;
    const input = document.createElement('input');
    input.className = 'text-input';
    input.style.left = x * scale + 'px';
    input.style.top = y * scale + 'px';
    input.style.fontSize = size * scale + 'px';
    input.style.color = c;
    p.el.appendChild(input);
    setTimeout(() => input.focus(), 0);

    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      const text = input.value.trim();
      input.remove();
      if (save && text) {
        annos.push({ type: 'text', page: p.idx, x, y, text, size, color: c });
        drawOverlay(p);
        renderTabs();
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
    const a = annos.pop();
    if (!a) return;
    const p = pages[a.page];
    if (p) drawOverlay(p);
    renderTabs();
  }

  /* ---------- 缩放 / 翻页 ---------- */
  function updateZoomLabel() { $('zoomLabel').textContent = Math.round(scale * 100) + '%'; }

  async function setScale(s) {
    if (!pdfDoc) return;
    const idx = currentPageIndex();
    scale = Math.min(4, Math.max(0.4, +s.toFixed(2)));
    await buildPages();
    if (pages[idx]) pages[idx].el.scrollIntoView();
  }
  const zoom = (d) => setScale(scale + d);

  async function fitWidth() {
    if (!pdfDoc) return;
    const first = await pdfDoc.getPage(1);
    const w = first.getViewport({ scale: 1 }).width;
    await setScale((viewer.clientWidth - 56) / w);
  }

  function currentPageIndex() {
    const top = viewer.getBoundingClientRect().top;
    let best = 0, bestDist = Infinity;
    pages.forEach((p, i) => {
      const d = Math.abs(p.el.getBoundingClientRect().top - top - 22);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    return best;
  }

  viewer.addEventListener('scroll', () => {
    if (!pages.length) return;
    $('pageInput').value = currentPageIndex() + 1;
  });
  $('pageInput').addEventListener('change', (e) => {
    const n = Math.min(pages.length, Math.max(1, +e.target.value || 1));
    if (pages[n - 1]) pages[n - 1].el.scrollIntoView();
  });

  /* ---------- 滚轮 ----------
   * 窗口需要按住 Shift 才会显示，而 Chromium 里 Shift+滚轮 = 横向滚动，
   * 所以这里统一接管：
   *   Ctrl+滚轮        缩放
   *   Shift+滚轮       纵向滚动（修复点）
   *   Shift+Alt+滚轮   横向滚动
   *   普通滚轮         浏览器默认
   */
  viewer.addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      zoom(e.deltaY < 0 ? 0.1 : -0.1);
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

  /* ---------- 手型：按住鼠标拖动页面平移 ----------
   * 手型工具下，左键拖动即可平移；任何工具下，按住鼠标中键拖动同样可以平移。 */
  let pan = null;
  viewer.addEventListener('pointerdown', (e) => {
    const middle = e.button === 1;
    if (!middle && !(tool === 'hand' && e.button === 0)) return;
    if (e.target.closest && e.target.closest('.text-input')) return;
    const r = viewer.getBoundingClientRect();                                 // 点在滚动条上时不抢：让滚动条正常拖
    if (e.clientX - r.left >= viewer.clientWidth || e.clientY - r.top >= viewer.clientHeight) return;
    pan = { id: e.pointerId, x: e.clientX, y: e.clientY, left: viewer.scrollLeft, top: viewer.scrollTop };
    try { viewer.setPointerCapture(e.pointerId); } catch (_) {}
    document.body.classList.add('panning');
    e.preventDefault();
  });
  viewer.addEventListener('pointermove', (e) => {
    if (!pan || e.pointerId !== pan.id) return;
    viewer.scrollLeft = pan.left - (e.clientX - pan.x);
    viewer.scrollTop = pan.top - (e.clientY - pan.y);
  });
  const endPan = () => {
    if (!pan) return;
    try { viewer.releasePointerCapture(pan.id); } catch (_) {}
    pan = null;
    document.body.classList.remove('panning');
  };
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((n) => viewer.addEventListener(n, endPan));
  viewer.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });   // 禁用中键自动滚动圈

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

  async function save(asNew) {
    if (!api) return showError('preload 未加载，无法保存');
    const t = activeTab();
    if (!t) return toast('请先打开一个 PDF');
    if (!asNew && annos.length === 0) return toast('没有需要保存的修改');
    const r = await api.save({ path: t.path, annotations: annos, saveAs: !!asNew });
    if (!r) return;
    const res = await api.open(r.path);       // 重新载入，标注已写入文件
    const item = res && res[0];
    if (!item || item.error) return showError('保存成功，但重新载入失败：' + ((item && item.error) || r.path));
    try {
      const doc = await pdfjsLib.getDocument({ data: item.data }).promise;
      const old = t.doc;
      t.doc = doc;
      t.path = r.path;
      t.name = baseName(r.path);
      t.annos = annos = [];
      if (activeId === t.id) await activateTab(t.id, true);   // 保留当前滚动位置和缩放
      else renderTabs();
      try { old.destroy(); } catch (_) {}
      toast('已保存：' + t.name);
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
  $('btnFit').onclick = fitWidth;
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
    if (!pages.length) return;
    // 键盘翻页
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
})();
