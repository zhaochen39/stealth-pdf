/**
 * 触发键逻辑（纯函数，不依赖 electron，便于测试）
 *
 * trigger = { type: 'key' | 'mouse', code: number | null, label: string }
 *   key   : uiohook 的 keycode
 *   mouse : libuiohook 鼠标键编号（3 中、4 后退、5 前进）
 *   code === null 表示「尚未绑定」（Fn 默认就是这种状态，见 README）
 */

// 与 uiohook-napi 的 UiohookKey 保持一致（硬编码，避免加载原生模块才能用）
const KEY = {
  Escape: 1, Ctrl: 29, Shift: 42, ShiftRight: 54, Alt: 56, CapsLock: 58,
  NumLock: 69, ScrollLock: 70, CtrlRight: 3613, AltRight: 3640,
  Meta: 3675, MetaRight: 3676, PrintScreen: 3639
};

const KEY_NAMES = {
  1: 'Esc', 29: '左 Ctrl', 42: '左 Shift', 54: '右 Shift', 56: '左 Alt', 58: 'CapsLock',
  69: 'NumLock', 70: 'ScrollLock', 3613: '右 Ctrl', 3640: '右 Alt', 3639: 'PrintScreen',
  3675: '左 Win', 3676: '右 Win', 57: '空格', 15: 'Tab', 14: 'Backspace', 28: 'Enter',
  3666: 'Insert', 3667: 'Delete', 3655: 'Home', 3663: 'End', 3657: 'PageUp', 3665: 'PageDown',
  57416: '↑', 57424: '↓', 57419: '←', 57421: '→'
};
for (let n = 1; n <= 24; n++) {                        // F1-F24（uiohook 编号不连续）
  const code = n <= 10 ? 58 + n : n === 11 ? 87 : n === 12 ? 88 : n <= 15 ? 78 + n : 83 + n;
  KEY_NAMES[code] = 'F' + n;
}

const MOUSE_NAMES = { 3: '鼠标中键', 4: '鼠标后退键', 5: '鼠标前进键' };

const FN_DEFAULT = Object.freeze({ type: 'key', code: null, label: 'Fn' });

const PRESETS = [
  { id: 'fn',    trigger: { ...FN_DEFAULT } },
  { id: 'ralt',  trigger: { type: 'key', code: KEY.AltRight, label: '右 Alt' } },
  { id: 'rctrl', trigger: { type: 'key', code: KEY.CtrlRight, label: '右 Ctrl' } },
  { id: 'scrlk', trigger: { type: 'key', code: KEY.ScrollLock, label: 'ScrollLock' } },
  { id: 'back',  trigger: { type: 'mouse', code: 4, label: MOUSE_NAMES[4] } },
  { id: 'fwd',   trigger: { type: 'mouse', code: 5, label: MOUSE_NAMES[5] } },
  { id: 'mid',   trigger: { type: 'mouse', code: 3, label: MOUSE_NAMES[3] } }
];

function labelFor(type, code) {
  if (type === 'mouse') return MOUSE_NAMES[code] || '鼠标键 #' + code;
  return KEY_NAMES[code] || '按键码 #' + code;
}

/** 把任意输入整理成合法的 trigger，非法则回到默认 Fn */
function normalize(t) {
  if (!t || (t.type !== 'key' && t.type !== 'mouse')) return { ...FN_DEFAULT };
  if (t.code === null || t.code === undefined) return { type: t.type, code: null, label: t.label || 'Fn' };
  const code = Number(t.code);
  if (!Number.isInteger(code) || code < 0 || code > 65535) return { ...FN_DEFAULT };
  if (t.type === 'mouse' && ![3, 4, 5].includes(code)) return { ...FN_DEFAULT };
  return { type: t.type, code, label: t.label || labelFor(t.type, code) };
}

const isBound = (t) => !!t && t.code !== null && t.code !== undefined;
const matches = (t, type, code) => isBound(t) && t.type === type && t.code === code;

/** 捕获时是否接受该事件（左右键不接受，避免误绑、也方便点「取消」按钮） */
const capturable = (type, code) => (type === 'mouse' ? [3, 4, 5].includes(code) : true);

module.exports = { KEY, PRESETS, FN_DEFAULT, labelFor, normalize, isBound, matches, capturable };
