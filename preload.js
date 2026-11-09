const { contextBridge, ipcRenderer } = require('electron');

// webUtils 在较老的 Electron 里不存在，做兼容，避免 preload 因此整体失败
let webUtils = null;
try { webUtils = require('electron').webUtils; } catch (_) {}

try {
  contextBridge.exposeInMainWorld('api', {
    open: (p) => ipcRenderer.invoke('pdf:open', p),
    save: (opts) => ipcRenderer.invoke('pdf:save', opts),
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
