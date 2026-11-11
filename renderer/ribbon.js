/* 功能区：文件 / 主页 / 注释 / 编辑 / 视图 / 隐身 / 帮助。声明式配置 + 状态驱动刷新（监听 App 的 change 事件） */
(() => {
  const A = window.App;
  const $ = (id) => document.getElementById(id);
  const ic = window.icon;
  const hasDoc = () => !!A.pane();
  const split = () => { const t = A.tab(); return !!t && t.panes.length === 2; };
  const noDoc = () => !hasDoc();

  const SHORTCUT_GROUPS = [
    { title: '文件与标签', items: [['Ctrl+O', '打开（可多选）'], ['Ctrl+S', '保存'], ['Ctrl+Shift+S', '另存为'], ['Ctrl+P', '打印'], ['Ctrl+W', '关闭标签'], ['Ctrl+Tab', '下一个标签'], ['Ctrl+Shift+Tab', '上一个标签'], ['Ctrl+1…9', '切换到第 N 个标签']] },
    { title: '查看', items: [['Ctrl+滚轮', '缩放'], ['Ctrl++ / Ctrl+-', '放大 / 缩小'], ['Ctrl+0', '适应宽度'], ['PageUp / PageDown', '翻页'], ['Home / End', '到开头 / 结尾'], ['Ctrl+G', '跳转到页码'], ['F4', '侧栏（缩略图 / 目录）'], ['F11', '全屏']] },
    { title: '工具', items: [['H', '手型'], ['V', '选择文字'], ['M', '区域高亮'], ['P', '画笔'], ['T', '文字'], ['R', '矩形'], ['E', '橡皮擦'], ['中键拖动', '任何工具下平移页面']] },
    { title: '编辑与查找', items: [['Ctrl+Z', '撤销标注'], ['Ctrl+Y / Ctrl+Shift+Z', '重做'], ['Ctrl+C', '复制选中文字'], ['Ctrl+F', '查找'], ['F3 / Shift+F3', '下一个 / 上一个结果']] },
    { title: '分屏', items: [['Ctrl+\\', '分屏 / 取消分屏'], ['F6', '切换焦点窗格']] },
    { title: '隐身（全局）', items: [['Ctrl+Alt+H', '开 / 关隐身模式'], ['Ctrl+Alt+↑ / ↓', '窗口透明度 ±10%'], ['触发键', '按住并把光标移到窗口上才显示']] }
  ];

  const ZOOMS = [50, 75, 100, 125, 150, 200, 300, 400];
  const pct = () => { const p = A.pane(); return p ? Math.round(p.scale * 100) : 125; };

  const rotateMenu = () => [
    { label: '当前页：向右旋转 90°', icon: 'rotr', onClick: () => A.rotatePages(90, 'current') },
    { label: '当前页：向左旋转 90°', icon: 'rotl', onClick: () => A.rotatePages(-90, 'current') },
    { separator: true },
    { label: '所有页：向右旋转 90°', onClick: () => A.rotatePages(90, 'all') },
    { label: '所有页：向左旋转 90°', onClick: () => A.rotatePages(-90, 'all') },
    { separator: true },
    { label: '指定页码…', onClick: () => A.rotatePages(90, 'range') }
  ];
  const whereMenu = (fn) => () => [
    { label: '当前页之后', onClick: () => fn('after') },
    { label: '当前页之前', onClick: () => fn('before') },
    { label: '文档末尾', onClick: () => fn('end') }
  ];

  const TABS = [
    { id: 'file', label: '文件', cls: 'file', groups: [
      { label: '打开', items: [
        { id: 'btnOpen', icon: 'open', text: '打开', size: 'lg', title: '打开 (Ctrl+O)', run: () => A.openDialog() },
        { id: 'btnRecent', icon: 'clock', text: '最近使用', size: 'lg', title: '最近打开过的文件',
          menu: () => {
            const r = A.recent;
            if (!r.length) return [{ label: '（暂无记录）', disabled: true }];
            return [...r.map((x) => ({ label: x.path.split(/[\\/]/).pop(), title: x.path, icon: 'doc', onClick: () => A.openRecent(x.path) })),
              { separator: true }, { label: '清除记录', icon: 'trash', onClick: () => A.clearRecent() }];
          } }
      ] },
      { label: '保存', items: [
        { id: 'btnSave', icon: 'save', text: '保存', size: 'lg', title: '保存 (Ctrl+S)', run: () => A.save(false), disabled: () => !hasDoc() },
        { stack: [
          { id: 'btnSaveAs', icon: 'saveas', text: '另存为', size: 'sm', title: '另存为 (Ctrl+Shift+S)', run: () => A.save(true), disabled: noDoc },
          { id: 'btnExportImg', icon: 'image', text: '导出图片', size: 'sm', title: '把当前页导出为 PNG 图片', run: () => A.exportImage(), disabled: noDoc }
        ] }
      ] },
      { label: '打印', items: [
        { id: 'btnPrint', icon: 'print', text: '打印', size: 'lg', title: '打印 (Ctrl+P)', run: () => A.printDoc(), disabled: noDoc }
      ] },
      { label: '文档', items: [
        { id: 'btnProps', icon: 'info', text: '属性', size: 'lg', title: '文档属性', run: () => A.showProperties(), disabled: noDoc },
        { stack: [
          { id: 'btnCloseDoc', icon: 'close', text: '关闭', size: 'sm', title: '关闭当前标签 (Ctrl+W)', run: () => A.closeTab(), disabled: noDoc },
          { id: 'btnCloseAll', icon: 'close', text: '关闭全部', size: 'sm', title: '关闭所有标签', run: () => A.closeAllTabs(), disabled: noDoc }
        ] }
      ] },
      { label: '应用', items: [
        { id: 'btnQuit', icon: 'exit', text: '退出', size: 'lg', title: '退出 StealthPDF', run: () => A.quit() }
      ] }
    ] },

    { id: 'home', label: '主页', groups: [
      { label: '工具', items: [
        { icon: 'hand', text: '手型', size: 'lg', tool: 'hand', title: '手型：按住鼠标拖动页面 (H)', run: () => A.setTool('hand') },
        { icon: 'cursor', text: '选择文字', size: 'lg', tool: 'select', title: '选择文字：拖选后可复制 (V)', run: () => A.setTool('select') },
        { stack: [{ id: 'btnCopy', icon: 'copy', text: '复制', size: 'sm', title: '复制选中的文字 (Ctrl+C)', run: () => A.copySelection(), disabled: noDoc }] }
      ] },
      { label: '查找', items: [
        { id: 'btnFind', icon: 'search', text: '查找', size: 'lg', title: '在文档中查找 (Ctrl+F)', run: () => A.openFind(), disabled: noDoc }
      ] },
      { label: '缩放', items: [
        { id: 'rbFitW', icon: 'fitwidth', text: '适应宽度', size: 'lg', title: '适应宽度 (Ctrl+0)', run: () => A.fitWidth(), disabled: noDoc },
        { id: 'rbFitP', icon: 'fitpage', text: '适应整页', size: 'lg', title: '整页显示在窗口内', run: () => A.fitPage(), disabled: noDoc },
        { id: 'rbActual', icon: 'actual', text: '实际大小', size: 'lg', title: '100%', run: () => A.actualSize(), disabled: noDoc },
        { stack: [
          { id: 'rbZoomIn', icon: 'plus', text: '放大', size: 'sm', title: '放大 (Ctrl++)', run: () => A.zoom(0.1), disabled: noDoc },
          { id: 'rbZoomOut', icon: 'minus', text: '缩小', size: 'sm', title: '缩小 (Ctrl+-)', run: () => A.zoom(-0.1), disabled: noDoc },
          { id: 'rbZoomMenu', icon: 'search', size: 'sm', title: '选择缩放比例', label: () => pct() + '%', caret: true, disabled: noDoc,
            menu: () => ZOOMS.map((z) => ({ label: z + '%', checked: pct() === z, onClick: () => A.setZoomPct(z) })) }
        ] }
      ] },
      { label: '旋转视图', items: [
        { stack: [
          { id: 'rbRotR', icon: 'rotr', text: '向右旋转', size: 'sm', title: '视图顺时针旋转 90°（不修改文件）', run: () => A.rotateView(90), disabled: noDoc },
          { id: 'rbRotL', icon: 'rotl', text: '向左旋转', size: 'sm', title: '视图逆时针旋转 90°（不修改文件）', run: () => A.rotateView(-90), disabled: noDoc }
        ] }
      ] },
      { label: '页面', items: [
        { stack: [
          { id: 'rbFirst', icon: 'first', text: '首页', size: 'sm', run: () => A.goToPage('first'), disabled: noDoc },
          { id: 'rbLast', icon: 'last', text: '末页', size: 'sm', run: () => A.goToPage('last'), disabled: noDoc }
        ] },
        { stack: [
          { id: 'rbPrev', icon: 'up', text: '上一页', size: 'sm', run: () => A.goToPage('prev'), disabled: noDoc },
          { id: 'rbNext', icon: 'down', text: '下一页', size: 'sm', run: () => A.goToPage('next'), disabled: noDoc }
        ] }
      ] },
      { label: '分屏', items: [
        { id: 'btnSplit', icon: 'split', text: '分屏', size: 'lg', title: '分屏：在右侧再打开一个 PDF (Ctrl+\\)', run: () => A.toggleSplit(), active: split, disabled: noDoc },
        { stack: [
          { id: 'btnSync', icon: 'sync', text: '同步滚动', size: 'sm', title: '同步滚动：两侧一起滚动', run: () => A.toggleSync(), active: () => !!(A.tab() && A.tab().sync), hidden: () => !split() },
          { id: 'btnSwap', icon: 'swap', text: '交换左右', size: 'sm', title: '交换左右', run: () => A.swapPanes(), hidden: () => !split() }
        ] }
      ] }
    ] },

    { id: 'annotate', label: '注释', groups: [
      { label: '文字标记', items: [
        { icon: 'highlighter', text: '文字高亮', size: 'lg', tool: 'markhl', title: '拖选文字后高亮；已选中文字时点击立即高亮', run: () => A.useMark('highlight'), disabled: noDoc },
        { icon: 'underline', text: '下划线', size: 'lg', tool: 'markul', title: '拖选文字后添加下划线', run: () => A.useMark('underline'), disabled: noDoc },
        { icon: 'strike', text: '删除线', size: 'lg', tool: 'markst', title: '拖选文字后添加删除线', run: () => A.useMark('strike'), disabled: noDoc }
      ] },
      { label: '绘制', items: [
        { icon: 'area', text: '区域高亮', size: 'lg', tool: 'highlight', title: '区域高亮：拖拽框选 (M)', run: () => A.setTool('highlight'), disabled: noDoc },
        { icon: 'pen', text: '画笔', size: 'lg', tool: 'pen', title: '画笔：按住拖动 (P)', run: () => A.setTool('pen'), disabled: noDoc },
        { icon: 'rect', text: '矩形', size: 'lg', tool: 'rect', title: '矩形：拖拽画框 (R)', run: () => A.setTool('rect'), disabled: noDoc },
        { icon: 'text', text: '文字', size: 'lg', tool: 'text', title: '文字：点击页面输入 (T)', run: () => A.setTool('text'), disabled: noDoc }
      ] },
      { label: '擦除', items: [
        { icon: 'eraser', text: '橡皮擦', size: 'lg', tool: 'eraser', title: '橡皮擦：点击未保存的标注即可删除 (E)', run: () => A.setTool('eraser'), disabled: noDoc }
      ] },
      { label: '样式', items: [{ custom: 'style' }] },
      { label: '历史', items: [
        { id: 'btnUndo', icon: 'undo', text: '撤销', size: 'lg', title: '撤销 (Ctrl+Z)', run: () => A.undo(), disabled: () => !(A.pane() && A.pane().undo.length) },
        { id: 'btnRedo', icon: 'redo', text: '重做', size: 'lg', title: '重做 (Ctrl+Y)', run: () => A.redo(), disabled: () => !(A.pane() && A.pane().redo.length) }
      ] }
    ] },

    { id: 'edit', label: '编辑', groups: [
      { label: '页面', items: [
        { id: 'btnRotatePage', icon: 'rotr', text: '旋转页面', size: 'lg', title: '旋转页面（修改文件，保存后生效）', menu: rotateMenu, disabled: noDoc },
        { id: 'btnDelPage', icon: 'trash', text: '删除页面', size: 'lg', title: '删除页面', run: () => A.deletePages(), disabled: noDoc },
        { id: 'btnBlank', icon: 'fileplus', text: '插入空白页', size: 'lg', title: '插入空白页', menu: whereMenu((w) => A.insertBlank(w)), disabled: noDoc }
      ] },
      { label: '文档', items: [
        { id: 'btnInsertPdf', icon: 'merge', text: '插入 PDF', size: 'lg', title: '把另一个 PDF 的所有页面插入进来（合并）', menu: whereMenu((w) => A.insertPdf(w)), disabled: noDoc },
        { id: 'btnExtract', icon: 'fileout', text: '提取页面', size: 'lg', title: '把部分页面提取成新的 PDF', run: () => A.extractPages(), disabled: noDoc }
      ] },
      { label: '导出', items: [
        { id: 'btnExportImg2', icon: 'image', text: '导出图片', size: 'lg', title: '把当前页导出为 PNG 图片', run: () => A.exportImage(), disabled: noDoc }
      ] },
      { label: '说明', items: [{ custom: 'editnote' }] }
    ] },

    { id: 'view', label: '视图', groups: [
      { label: '导航', items: [
        { id: 'btnSbThumbs', icon: 'thumbs', text: '缩略图', size: 'lg', title: '缩略图侧栏 (F4)', run: () => A.showSidebarMode('thumbs'), active: () => A.sidebar && A.sidebar.visible && A.sidebar.mode === 'thumbs' },
        { id: 'btnSbOutline', icon: 'list', text: '目录', size: 'lg', title: '目录 / 书签侧栏', run: () => A.showSidebarMode('outline'), active: () => A.sidebar && A.sidebar.visible && A.sidebar.mode === 'outline' }
      ] },
      { label: '页面布局', items: [
        { id: 'rbSingle', icon: 'single', text: '单页连续', size: 'lg', run: () => A.setLayout('single'), active: () => !!(A.pane() && !A.pane().twoUp), disabled: noDoc },
        { id: 'rbTwo', icon: 'two', text: '双页', size: 'lg', run: () => A.setLayout('two'), active: () => !!(A.pane() && A.pane().twoUp), disabled: noDoc }
      ] },
      { label: '外观', items: [
        { id: 'rbPageColor', icon: 'page', text: '页面颜色', size: 'lg', title: '页面阅读色：不改变文件，只影响显示',
          menu: () => [['normal', '正常'], ['sepia', '护眼（米黄）'], ['night', '夜间（反色）']].map(([v, l]) => ({ label: l, checked: A.pageColor === v, onClick: () => A.setPageColor(v) })) },
        { id: 'rbTheme', icon: 'palette', text: '界面主题', size: 'lg', title: '界面主题',
          menu: () => [['dark', '深色', 'moon'], ['light', '浅色', 'sun'], ['sepia', '护眼', 'book'], ['auto', '跟随系统', 'monitor']].map(([v, l, i]) => ({ label: l, icon: i, checked: A.themePref === v, onClick: () => A.setTheme(v) })) }
      ] },
      { label: '窗口', items: [
        { id: 'rbFull', icon: 'fullscreen', text: '全屏', size: 'lg', title: '全屏阅读 (F11)', run: () => A.toggleFullscreen(), active: () => A.isFullscreen }
      ] }
    ] },

    { id: 'stealth', label: '隐身', groups: [
      { label: '隐身模式', items: [
        { id: 'rbStealth', icon: 'eyeoff', text: '隐身模式', size: 'lg', title: '隐身模式 (Ctrl+Alt+H)：开启后仅在按住触发键且光标在窗口内时显示',
          run: () => A.toggleStealth(), active: () => A.settings.stealth, icon2: () => (A.settings.stealth ? 'eyeoff' : 'eye'), label: () => (A.settings.stealth ? '隐身 开' : '隐身 关') }
      ] },
      { label: '触发键', items: [
        { id: 'rbTrigger', icon: 'key', text: '触发键', size: 'lg', title: '设置触发键：按住它并把光标移到窗口上，窗口才显示', run: () => A.openTriggerDialog(),
          label: () => '触发键：' + A.settings.trigger.label, warn: () => A.settings.trigger.code === null || A.settings.trigger.code === undefined }
      ] },
      { label: '窗口', items: [{ custom: 'opacity' }, { stack: [
        { id: 'rbTop', icon: 'pin', text: '隐身时置顶', size: 'sm', title: '隐身模式下窗口保持在最前', run: () => A.setSetting('alwaysOnTop', !A.settings.alwaysOnTop), active: () => A.settings.alwaysOnTop },
        { id: 'rbTaskbar', icon: 'monitor', text: '隐藏任务栏图标', size: 'sm', title: '隐身模式下不在任务栏显示', run: () => A.setSetting('skipTaskbar', !A.settings.skipTaskbar), active: () => A.settings.skipTaskbar }
      ] }] },
      { label: '应急', items: [
        { id: 'rbPeek', icon: 'timer', text: '临时显示 5 秒', size: 'lg', title: '让窗口保持显示 5 秒', run: () => A.peek() },
        { id: 'rbCenter', icon: 'center', text: '窗口居中', size: 'lg', title: '把窗口移回屏幕中央', run: () => A.centerWindow() }
      ] }
    ] },

    { id: 'help', label: '帮助', groups: [
      { label: '帮助', items: [
        { id: 'btnQuick', icon: 'book', text: '快速入门', size: 'lg', run: () => quickStart() },
        { id: 'btnShortcuts', icon: 'key', text: '快捷键', size: 'lg', run: () => Dlg.shortcuts(SHORTCUT_GROUPS) }
      ] },
      { label: '关于', items: [
        { id: 'btnLogs', icon: 'logs', text: '日志文件夹', size: 'lg', title: '打开日志与设置所在的文件夹', run: () => A.openLogs() },
        { id: 'btnAbout', icon: 'info', text: '关于', size: 'lg', run: () => about() }
      ] }
    ] }
  ];

  function quickStart() {
    Dlg.info({
      title: '快速入门', size: 'wide',
      html: '<div class="guide">' +
        '<h3>隐身显示</h3><p>开启「隐身」后，窗口只在<b>按住触发键、并且光标在窗口范围内</b>时才显示，其余时候自动隐藏。先到「隐身」标签点<b>触发键</b>绑定一个键（推荐右 Alt）；触发键未绑定时窗口会一直显示，不会把你锁在外面。</p>' +
        '<h3>阅读</h3><p>用<b>手型</b>拖动页面，<b>选择文字</b>复制内容；Ctrl+F 查找；F4 打开缩略图 / 目录；视图里可切换双页、夜间 / 护眼阅读色和界面主题。</p>' +
        '<h3>标注与保存</h3><p>「注释」里有文字高亮、下划线、删除线、画笔、矩形、文字和橡皮擦。标注在点<b>保存</b>之前只在内存里，保存后写入 PDF。</p>' +
        '<h3>多标签与分屏</h3><p>可同时打开多个 PDF；「主页 → 分屏」在同一标签里左右并排两个文件，适合对答案。</p>' +
        '<h3>页面编辑</h3><p>「编辑」里可旋转、删除、插入空白页、合并 PDF、提取页面，这些改动在保存后写入文件。</p></div>'
    });
  }
  async function about() {
    const i = await A.appInfo();
    Dlg.info({
      title: 'StealthPDF', sub: '按住触发键并把光标移到窗口上才显示的 PDF 阅读器',
      rows: [['版本', i.version || '—'], ['Electron', i.electron || '—'], ['Chromium', i.chrome || '—'], ['Node.js', i.node || '—'], ['数据目录', i.userData || '—'], ['许可证', 'MIT（开源）']]
    });
  }

  /* ---------- 构建 ---------- */
  const updaters = [];
  const root = $('ribbon');

  function mkBtn(def) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rb-btn ' + (def.size || 'sm') + (def.tool ? ' tool' : '');
    if (def.id) b.id = def.id;
    if (def.tool) b.dataset.tool = def.tool;
    const label = def.text !== undefined || def.label;
    b.innerHTML = '<span class="ico">' + ic(def.icon) + '</span>' + (label ? '<span class="txt"></span>' : '') +
      (def.menu || def.caret ? ic('down', 'caret') : '');
    b.addEventListener('mousedown', (e) => e.preventDefault());       // 保留文字选区与焦点
    b.addEventListener('click', () => { if (def.menu) Dlg.menu(b, def.menu()); else if (def.run) def.run(); });
    const txt = b.querySelector('.txt');
    updaters.push(() => {
      if (txt) txt.textContent = def.label ? def.label() : def.text;
      if (def.icon2) b.querySelector('.ico').innerHTML = ic(def.icon2());
      if (def.tool) b.classList.toggle('on', A.tool === def.tool);
      else if (def.active) b.classList.toggle('on', !!def.active());
      if (def.warn) b.classList.toggle('warn', !!def.warn());
      b.disabled = !!(def.disabled && def.disabled());
      b.hidden = !!(def.hidden && def.hidden());
      b.title = def.title || '';
    });
    return b;
  }

  function mkCustom(kind) {
    if (kind === 'style') {
      const box = document.createElement('div');
      box.className = 'rb-stack';
      box.innerHTML =
        '<div class="colors" id="swatches">' +
        [['#ffd400', '黄色'], ['#e53935', '红色'], ['#43a047', '绿色'], ['#1e88e5', '蓝色'], ['#111111', '黑色']]
          .map(([c, n]) => '<button class="swatch" data-color="' + c + '" style="--c:' + c + '" title="' + n + '"></button>').join('') +
        '<label class="swatch custom" title="自定义颜色"><input type="color" id="color" value="#ffd400" /></label></div>' +
        '<div class="rb-row"><span class="muted">粗细</span><div class="seg" id="segWidth"></div></div>' +
        '<div class="rb-row"><span class="muted">字号</span><div class="seg" id="segSize"></div></div>';
      const seg = (id, opts, get, set) => {
        const el = box.querySelector('#' + id);
        opts.forEach(([v, t, title]) => {
          const b = document.createElement('button');
          b.type = 'button'; b.textContent = t; b.title = title;
          b.addEventListener('mousedown', (e) => e.preventDefault());
          b.onclick = () => set(v);
          el.appendChild(b);
          b._v = v;
        });
        updaters.push(() => Array.from(el.children).forEach((b) => b.classList.toggle('on', b._v === get())));
      };
      seg('segWidth', [[1.5, '细', '1.5 pt'], [2, '中', '2 pt'], [4, '粗', '4 pt'], [7, '特粗', '7 pt']], () => A.penWidth, (v) => A.setPenWidth(v));
      seg('segSize', [[12, '小', '12 pt'], [16, '中', '16 pt'], [24, '大', '24 pt'], [36, '特大', '36 pt']], () => A.textSize, (v) => A.setTextSize(v));
      box.querySelectorAll('.swatch[data-color]').forEach((s) => (s.onclick = () => A.setColor(s.dataset.color)));
      box.querySelector('#color').addEventListener('input', (e) => A.setColor(e.target.value));
      return box;
    }
    if (kind === 'opacity') {
      const box = document.createElement('div');
      box.className = 'rb-stack';
      box.title = '窗口透明度（Ctrl+Alt+↑/↓）';
      box.innerHTML = '<div class="rb-row">' + ic('opacity', 'muted') + '<input id="opacity" type="range" min="20" max="100" step="5" value="100" /><span id="opacityLabel" class="pill small">100%</span></div>' +
        '<div class="rb-row"><span class="muted">窗口透明度</span></div>';
      const slider = box.querySelector('#opacity'), lab = box.querySelector('#opacityLabel');
      slider.addEventListener('input', () => { lab.textContent = slider.value + '%'; A.setOpacity(slider.value / 100); });
      updaters.push(() => {
        const v = Math.round(A.settings.opacity * 100);
        if (document.activeElement !== slider) slider.value = v;
        lab.textContent = v + '%';
      });
      return box;
    }
    if (kind === 'editnote') {
      const d = document.createElement('div');
      d.className = 'muted';
      d.style.cssText = 'max-width:210px;font-size:12px;line-height:1.5;align-self:center;padding:0 6px';
      d.textContent = '页面编辑会修改文件内容：改动先在内存里，点「保存」才会写入；未保存前关闭标签可放弃。加密的 PDF 暂不支持。';
      return d;
    }
    return document.createElement('div');
  }

  function mkItem(def) {
    if (def.custom) return mkCustom(def.custom);
    if (def.stack) {
      const s = document.createElement('div');
      s.className = 'rb-stack';
      def.stack.forEach((d) => s.appendChild(mkBtn(d)));
      return s;
    }
    return mkBtn(def);
  }

  let activeTab = A.pref.get('ribbonTab', 'home');
  let collapsed = A.pref.get('ribbonCollapsed', '0') === '1';
  if (!TABS.some((t) => t.id === activeTab)) activeTab = 'home';

  const tabsBar = document.createElement('div');
  tabsBar.className = 'rb-tabs';
  tabsBar.setAttribute('role', 'tablist');
  root.appendChild(tabsBar);

  TABS.forEach((t) => {
    const tb = document.createElement('button');
    tb.type = 'button';
    tb.className = 'rb-tab' + (t.cls ? ' ' + t.cls : '');
    tb.dataset.tab = t.id;
    tb.id = 'rbTab-' + t.id;
    tb.textContent = t.label;
    tb.setAttribute('role', 'tab');
    tb.addEventListener('mousedown', (e) => e.preventDefault());   // 切换标签不清除文字选区
    tb.addEventListener('click', () => select(t.id, true));
    tb.addEventListener('dblclick', () => setCollapsed(!collapsed));
    tabsBar.appendChild(tb);

    const panel = document.createElement('div');
    panel.className = 'rb-panel';
    panel.dataset.panel = t.id;
    panel.setAttribute('role', 'tabpanel');
    t.groups.forEach((g) => {
      const grp = document.createElement('div');
      grp.className = 'rb-group';
      const items = document.createElement('div');
      items.className = 'rb-items';
      g.items.forEach((it) => items.appendChild(mkItem(it)));
      const lab = document.createElement('div');
      lab.className = 'rb-label';
      lab.textContent = g.label;
      grp.append(items, lab);
      panel.appendChild(grp);
    });
    root.appendChild(panel);
  });

  const spacer = document.createElement('span');
  spacer.className = 'rb-spacer';
  const tools = document.createElement('div');
  tools.className = 'rb-tools';
  tools.innerHTML = '<button type="button" class="btn icon-only sm" id="rbCollapse" title="折叠 / 展开功能区（双击标签也可以）">' + ic('up') + '</button>';
  tabsBar.append(spacer, tools);
  tools.firstChild.addEventListener('mousedown', (e) => e.preventDefault());
  tools.firstChild.onclick = () => setCollapsed(!collapsed);

  function setCollapsed(c) {
    collapsed = c;
    root.classList.toggle('collapsed', c);
    $('rbCollapse').innerHTML = ic(c ? 'down' : 'up');
    A.pref.set('ribbonCollapsed', c ? '1' : '0');
  }
  function select(id, userClick) {
    activeTab = id;
    A.pref.set('ribbonTab', id);
    if (userClick && collapsed) setCollapsed(false);
    root.querySelectorAll('.rb-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
    root.querySelectorAll('.rb-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === id));
  }

  let raf = 0;
  function refresh() { updaters.forEach((u) => u()); }
  A.on('change', () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; refresh(); }); });

  A.selectRibbonTab = (id) => select(id, true);
  A.shortcutGroups = SHORTCUT_GROUPS;
  setCollapsed(collapsed);
  select(activeTab, false);
  A.setColor(A.color);
  refresh();
})();
