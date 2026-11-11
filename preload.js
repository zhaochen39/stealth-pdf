const { contextBridge, ipcRenderer } = require('electron');

// webUtils 在较老的 Electron 里不存在，做兼容，避免 preload 因此整体失败
let webUtils = null;
try { webUtils = require('electron').webUtils; } catch (_) {}

try {
  contextBridge.exposeInMainWorld('api', {
    open: (p) => ipcRenderer.invoke('pdf:open', p),
    save: (opts) => ipcRenderer.invoke('pdf:save', opts),
    ops: (op, bytes, args) => ipcRenderer.invoke('pdf:ops', { op, bytes, args }),
    saveFile: (opts) => ipcRenderer.invoke('file:save', opts),
    getRecent: () => ipcRenderer.invoke('recent:get'),
    clearRecent: () => ipcRenderer.invoke('recent:clear'),
    getSettings: () => ipcRenderer.invoke('settings:get'),
    setSetting: (k, v) => ipcRenderer.invoke('settings:set', k, v),
    onSettingsChanged: (cb) => ipcRenderer.on('settings-changed', (_e, v) => cb(v)),
    setHold: (on) => ipcRenderer.invoke('win:hold', on),
    peek: () => ipcRenderer.invoke('win:peek'),
    centerWindow: () => ipcRenderer.invoke('win:center'),
    setFullscreen: (on) => ipcRenderer.invoke('win:fullscreen', on),
    appInfo: () => ipcRenderer.invoke('app:info'),
    openLogs: () => ipcRenderer.invoke('app:openLogs'),
    quit: () => ipcRenderer.invoke('app:quit'),
    pathOf: (file) => (webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : file.path),
    onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, p) => cb(p)),   // p 为路径数组
    getOpacity: () => ipcRenderer.invoke('opacity:get'),
    setOpacity: (v) => ipcRenderer.invoke('opacity:set', v),
    onOpacityChanged: (cb) => ipcRenderer.on('opacity-changed', (_e, v) => cb(v)),
    getStealth: () => ipcRenderer.invoke('stealth:get'),
    setStealth: (on) => ipcRenderer.invoke('stealth:set', on),
    onStealthChanged: (cb) => ipcRenderer.on('stealth-changed', (_e, v) => cb(v)),
    getTrigger: () => ipcRenderer.invoke('trigger:get'),
    getTriggerPresets: () => ipcRenderer.invoke('trigger:presets'),
    setTriggerPreset: (id) => ipcRenderer.invoke('trigger:preset', id),
    captureTrigger: () => ipcRenderer.invoke('trigger:capture'),
    cancelCapture: () => ipcRenderer.invoke('trigger:cancel'),
    onTriggerChanged: (cb) => ipcRenderer.on('trigger-changed', (_e, v) => cb(v)),
    onOpenTriggerDialog: (cb) => ipcRenderer.on('open-trigger-dialog', () => cb())
  });
} catch (err) {
  console.error('[preload] 暴露 api 失败：', err && err.stack || err);
}
