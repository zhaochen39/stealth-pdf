/**
 * StealthPDF - 主进程
 *
 * 隐身规则：只有「按住触发键（默认 Fn，可自定义）」且「鼠标指针位于阅读器窗口范围内」同时成立时，窗口才显示；
 * 其它任何情况窗口都被 hide()（不在任务栏 / Alt+Tab 中出现，也不会拦截鼠标）。
 * 触发键尚未绑定（Fn 通常不会被 Windows 识别）时，为避免「窗口再也出不来」，窗口保持显示。
 */
const {
  app, BrowserWindow, ipcMain, dialog, screen, Tray, Menu, globalShortcut,
  nativeImage, powerMonitor
} = require('electron');
const path = require('path');
const fs = require('fs');
const { applyAnnotations } = require('./annotate');
const T = require('./trigger');

let uIOhook = null;
let hookError = null;
try {
  ({ uIOhook } = require('uiohook-napi'));
} catch (e) {
  hookError = e;
}

/* ---------------- 日志（出问题时方便排查） ---------------- */
const LOG_MAX_BYTES = 1024 * 1024;   // 超过 1 MB 就轮转为 stealth-pdf.log.old，只保留最近两份
function log(...args) {
  try {
    const file = path.join(app.getPath('userData'), 'stealth-pdf.log');
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, file + '.old');
    } catch (_) { /* 日志文件还不存在 */ }
    const line = `[${new Date().toISOString()}] ${args.map(a => (a && a.stack) || String(a)).join(' ')}\n`;
    fs.appendFileSync(file, line);
  } catch (_) {}
}

/* ---------------- 设置（持久化） ---------------- */
// trigger：触发显示的按键（键盘键或鼠标键），详见 trigger.js；默认 Fn
const defaults = { stealth: true, alwaysOnTop: true, skipTaskbar: false, opacity: 1, trigger: { ...T.FN_DEFAULT } };
let settings = { ...defaults };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    settings = { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch (_) { /* 首次运行 */ }
  settings.opacity = clampOpacity(settings.opacity);
  settings.trigger = T.normalize(settings.trigger);
  delete settings.triggerButton;   // 旧版本的字段
}
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch (_) {}
  }, 200);
}
function clampOpacity(v) {
  v = Number(v);
  if (!isFinite(v)) return 1;
  return Math.min(1, Math.max(0.2, Math.round(v * 20) / 20));
}

/* ---------------- 窗口与隐身逻辑 ---------------- */
let win = null;
let tray = null;
let triggerDown = false;    // 触发键是否按住
let capture = null;         // 捕获模式：{ resolve, timer }，等待用户按下想绑定的键
let mouseHeld = false;      // 在窗口内按住鼠标（画笔拖动）时不隐藏
let dialogOpen = false;     // 文件对话框打开期间保持显示
let visible = true;
let graceUntil = 0;         // 启动后的宽限期：窗口正常显示

if (!app.requestSingleInstanceLock()) app.quit();

/** 命令行 / 双击传入的所有 PDF（可能有多个，每个一个标签） */
function pdfsFromArgv(argv) {
  return argv.slice(1).filter(a => /\.pdf$/i.test(a) && fs.existsSync(a));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 640,
    minHeight: 420,
    title: 'StealthPDF',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,          // 让 preload 能正常 require，避免沙箱导致 window.api 缺失
      backgroundThrottling: false
    }
  });
  win.removeMenu();
  win.setOpacity(settings.opacity);

  const wc = win.webContents;
  wc.on('console-message', (...a) => {
    const d = a[0] && a[0].message !== undefined ? a[0] : { level: a[1], message: a[2], sourceId: a[4], lineNumber: a[3] };
    log('[renderer]', d.level, d.message, d.sourceId || '', d.lineNumber || '');
  });
  wc.on('did-fail-load', (_e, code, desc, url) => log('did-fail-load', code, desc, url));
  wc.on('render-process-gone', (_e, d) => log('render-process-gone', JSON.stringify(d)));
  wc.on('preload-error', (_e, p, err) => log('preload-error', p, err));

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  wc.once('did-finish-load', () => {
    const files = pdfsFromArgv(process.argv);
    if (files.length) wc.send('open-file', files);
  });

  win.on('closed', () => { win = null; });
  applyWindowMode();
}

function applyWindowMode() {
  if (!win) return;
  win.setAlwaysOnTop(settings.stealth && settings.alwaysOnTop, 'floating');
  win.setSkipTaskbar(settings.stealth && settings.skipTaskbar);
}

function setVisible(v) {
  if (!win || win.isDestroyed()) return;
  visible = v;
  if (v) {
    win.setOpacity(settings.opacity);
    win.showInactive();       // 显示但不抢焦点；点击窗口后自然获得焦点
  } else {
    win.hide();
  }
}

function insideWindow() {
  if (!win || win.isDestroyed()) return false;
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  return p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
}

/** 每 30ms 判定一次：触发键是否按住 && 鼠标是否在窗口范围内 */
function tick() {
  if (!win || win.isDestroyed()) return;

  let want;
  if (!settings.stealth || Date.now() < graceUntil || dialogOpen || capture || !T.isBound(settings.trigger)) {
    want = true;   // 隐身关闭 / 宽限期 / 对话框 / 正在捕获按键 / 触发键未绑定：保持显示
  } else {
    want = (triggerDown && insideWindow()) || (mouseHeld && visible);
  }
  if (want !== visible) setVisible(want);
}

/* ---------------- 触发键（可自定义） ---------------- */
function applyTrigger(t) {
  settings.trigger = T.normalize(t);
  triggerDown = false;
  saveSettings();
  refreshTrayMenu();
  graceUntil = Math.max(graceUntil, Date.now() + 1500);   // 让用户看到设置结果
  if (win && !win.isDestroyed()) win.webContents.send('trigger-changed', settings.trigger);
  log('触发键已设为', JSON.stringify(settings.trigger));
}

/** 进入捕获模式：等用户按下想绑定的键盘键 / 鼠标中、后退、前进键；Esc 或超时则取消，返回 null */
function startCapture(ms = 10000) {
  if (!uIOhook) return Promise.resolve(null);
  if (capture) finishCapture(null);
  return new Promise(resolve => {
    capture = { resolve, timer: setTimeout(() => finishCapture(null, true), ms) };
  });
}
function finishCapture(trigger, timedOut = false) {
  if (!capture) return;
  const c = capture;
  capture = null;
  clearTimeout(c.timer);
  triggerDown = false;
  graceUntil = Math.max(graceUntil, Date.now() + 600);
  if (trigger) applyTrigger(trigger);
  c.resolve(trigger ? { ok: true, trigger: settings.trigger } : { ok: false, timedOut });
}

function startHook() {
  if (!uIOhook) {
    log('uiohook-napi 加载失败', hookError);
    dialog.showErrorBox('StealthPDF', '全局按键监听模块（uiohook-napi）加载失败，隐身功能不可用，已自动关闭隐身模式。\n\n' + String(hookError && hookError.message));
    settings.stealth = false;
    return;
  }
  uIOhook.on('keydown', e => {
    const code = Number(e.keycode);
    if (capture) {
      if (code === T.KEY.Escape) finishCapture(null);
      else finishCapture({ type: 'key', code });
      return;
    }
    if (T.matches(settings.trigger, 'key', code)) triggerDown = true;
  });
  uIOhook.on('keyup', e => {
    if (T.matches(settings.trigger, 'key', Number(e.keycode))) triggerDown = false;
  });
  uIOhook.on('mousedown', e => {
    const b = Number(e.button);
    if (capture) {
      if (T.capturable('mouse', b)) finishCapture({ type: 'mouse', code: b });
      return;                                   // 捕获期间左 / 右键照常，方便点「取消」
    }
    if (T.matches(settings.trigger, 'mouse', b)) triggerDown = true;
    else if (b === 1) mouseHeld = visible && insideWindow();   // 左键拖动（画笔/高亮）时不隐藏
  });
  uIOhook.on('mouseup', e => {
    const b = Number(e.button);
    if (T.matches(settings.trigger, 'mouse', b)) triggerDown = false;
    else if (b === 1) mouseHeld = false;
  });
  uIOhook.start();
}

/* ---------------- 透明度 ---------------- */
function setOpacitySetting(v, { notifyRenderer = true } = {}) {
  settings.opacity = clampOpacity(v);
  saveSettings();
  if (win && !win.isDestroyed() && visible) win.setOpacity(settings.opacity);
  if (notifyRenderer && win && !win.isDestroyed()) win.webContents.send('opacity-changed', settings.opacity);
  refreshTrayMenu();
}

/* ---------------- 托盘 ---------------- */
function buildTray() {
  // 托盘使用专门的小尺寸简化图标（build/tray.png，32px），在高 DPI 下更清晰
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png')).resize({ width: 16, height: 16, quality: 'best' });
  tray = new Tray(img);
  tray.setToolTip('StealthPDF（按住触发键并把光标移到窗口上显示）');
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const presets = [1, 0.8, 0.6, 0.4, 0.2].map(v => ({
    label: Math.round(v * 100) + '%',
    type: 'radio',
    checked: Math.abs(settings.opacity - v) < 0.01,
    click: () => setOpacitySetting(v)
  }));
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '隐身模式（Ctrl+Alt+H）', type: 'checkbox', checked: settings.stealth,
      click: m => toggleStealth(m.checked)
    },
    { label: '窗口透明度（Ctrl+Alt+↑/↓）', submenu: presets },
    {
      label: '触发键：' + settings.trigger.label + (T.isBound(settings.trigger) ? '' : '（未绑定）'),
      submenu: [
        ...T.PRESETS.map(p => ({
          label: p.trigger.label + (p.id === 'fn' ? '（默认，多数键盘无法识别）' : ''),
          type: 'radio',
          checked: p.trigger.type === settings.trigger.type && p.trigger.code === settings.trigger.code,
          click: () => applyTrigger(p.trigger)
        })),
        { type: 'separator' },
        {
          label: '自定义…（按下想用的键）',
          click: () => {
            graceUntil = Date.now() + 1000;
            if (win && !win.isDestroyed()) win.webContents.send('open-trigger-dialog');
          }
        }
      ]
    },
    {
      label: '隐身时窗口置顶', type: 'checkbox', checked: settings.alwaysOnTop,
      click: m => { settings.alwaysOnTop = m.checked; saveSettings(); applyWindowMode(); }
    },
    {
      label: '隐身时隐藏任务栏图标', type: 'checkbox', checked: settings.skipTaskbar,
      click: m => { settings.skipTaskbar = m.checked; saveSettings(); applyWindowMode(); }
    },
    { type: 'separator' },
    { label: '临时显示窗口 5 秒', click: () => { graceUntil = Date.now() + 5000; } },
    { label: '把窗口移回屏幕中央', click: () => { graceUntil = Date.now() + 2000; if (win) win.center(); } },
    { label: '打开日志文件夹', click: () => require('electron').shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]));
}

function toggleStealth(on) {
  settings.stealth = typeof on === 'boolean' ? on : !settings.stealth;
  saveSettings();
  applyWindowMode();
  if (!settings.stealth) setVisible(true);
  // 刚开启时留 2 秒让用户看到提示，之后按「触发键+光标在窗口内」规则隐藏
  else graceUntil = Date.now() + 2000;
  refreshTrayMenu();
  if (win && !win.isDestroyed()) win.webContents.send('stealth-changed', settings.stealth);
}

/* ---------------- IPC ---------------- */
async function withDialog(fn) {
  dialogOpen = true;
  try { return await fn(); }
  finally { dialogOpen = false; graceUntil = Math.max(graceUntil, Date.now() + 500); }
}

/**
 * 打开 PDF：参数是路径（或路径数组）则直接读取；不传则弹出可多选的对话框。
 * 始终返回数组：[{ path, data } | { path, error }]；用户取消返回 []。
 */
ipcMain.handle('pdf:open', async (_e, p) => {
  let files;
  if (p) {
    files = Array.isArray(p) ? p : [p];
  } else {
    const r = await withDialog(() => dialog.showOpenDialog(win, {
      title: '打开 PDF（可多选）',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile', 'multiSelections']
    }));
    if (r.canceled) return [];
    files = r.filePaths;
  }
  return files.map(file => {
    try {
      return { path: file, data: new Uint8Array(fs.readFileSync(file)) };
    } catch (err) {
      log('读取失败', file, err);
      return { path: file, error: String(err && err.message ? err.message : err) };
    }
  });
});

ipcMain.handle('pdf:save', async (_e, { path: src, annotations, saveAs }) => {
  let target = src;
  if (saveAs) {
    const r = await withDialog(() => dialog.showSaveDialog(win, {
      title: '另存为',
      defaultPath: src,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    }));
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  try {
    if (!annotations || annotations.length === 0) {
      if (target !== src) fs.copyFileSync(src, target);
    } else {
      const out = await applyAnnotations(src, annotations);
      fs.writeFileSync(target, out);
    }
    return { path: target };
  } catch (err) {
    log('保存失败', err);
    await withDialog(() => dialog.showMessageBox(win, { type: 'error', title: '保存失败', message: String(err && err.message ? err.message : err) }));
    return null;
  }
});

ipcMain.handle('trigger:get', () => settings.trigger);
ipcMain.handle('trigger:preset', (_e, id) => {
  const p = T.PRESETS.find(x => x.id === id);
  if (p) applyTrigger(p.trigger);
  return settings.trigger;
});
ipcMain.handle('trigger:capture', () => startCapture());
ipcMain.handle('trigger:cancel', () => { finishCapture(null); return true; });
ipcMain.handle('trigger:presets', () => T.PRESETS.map(p => ({ id: p.id, label: p.trigger.label })));
ipcMain.handle('stealth:get', () => settings.stealth);
ipcMain.handle('stealth:set', (_e, on) => { toggleStealth(!!on); return settings.stealth; });
ipcMain.handle('opacity:get', () => settings.opacity);
ipcMain.handle('opacity:set', (_e, v) => { setOpacitySetting(v, { notifyRenderer: false }); return settings.opacity; });

/* ---------------- 生命周期 ---------------- */
app.on('second-instance', (_e, argv) => {
  const files = pdfsFromArgv(argv);
  if (files.length && win) win.webContents.send('open-file', files);
  graceUntil = Date.now() + 3000;
});

app.whenReady().then(() => {
  loadSettings();
  log('启动', app.getVersion());
  createWindow();
  buildTray();
  startHook();
  graceUntil = Date.now() + 4000;
  setInterval(tick, 30);

  globalShortcut.register('Control+Alt+H', () => toggleStealth());
  globalShortcut.register('Control+Alt+Up', () => setOpacitySetting(settings.opacity + 0.1));
  globalShortcut.register('Control+Alt+Down', () => setOpacitySetting(settings.opacity - 0.1));

  // 锁屏 / 睡眠后按键抬起事件可能丢失，复位避免"卡住"
  powerMonitor.on('lock-screen', () => { triggerDown = false; mouseHeld = false; });
  powerMonitor.on('resume', () => { triggerDown = false; mouseHeld = false; });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  try { if (uIOhook) uIOhook.stop(); } catch (_) {}
});
