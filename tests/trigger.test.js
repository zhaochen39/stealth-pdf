'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../trigger');

test('默认触发键是 Fn，且处于未绑定状态', () => {
  assert.equal(T.FN_DEFAULT.label, 'Fn');
  assert.equal(T.isBound(T.FN_DEFAULT), false);
});

test('未绑定的触发键不会匹配任何事件', () => {
  for (const code of [0, 1, 42, 3640, 65535]) {
    assert.equal(T.matches(T.FN_DEFAULT, 'key', code), false);
    assert.equal(T.matches(T.FN_DEFAULT, 'mouse', code), false);
  }
});

test('已绑定的触发键只匹配相同类型和键码', () => {
  const ralt = { type: 'key', code: T.KEY.AltRight, label: '右 Alt' };
  assert.equal(T.matches(ralt, 'key', T.KEY.AltRight), true);
  assert.equal(T.matches(ralt, 'key', T.KEY.Alt), false);
  assert.equal(T.matches(ralt, 'mouse', T.KEY.AltRight), false);
});

test('normalize：非法输入回退到 Fn', () => {
  for (const bad of [null, undefined, 42, {}, { type: 'touch', code: 1 }, { type: 'key', code: -1 }, { type: 'key', code: 'abc' }, { type: 'key', code: 70000 }]) {
    assert.deepEqual(T.normalize(bad), { ...T.FN_DEFAULT });
  }
});

test('normalize：鼠标键只允许 中 / 后退 / 前进', () => {
  assert.deepEqual(T.normalize({ type: 'mouse', code: 1 }), { ...T.FN_DEFAULT });
  assert.deepEqual(T.normalize({ type: 'mouse', code: 2 }), { ...T.FN_DEFAULT });
  assert.equal(T.normalize({ type: 'mouse', code: 4 }).label, '鼠标后退键');
  assert.equal(T.normalize({ type: 'mouse', code: 5 }).label, '鼠标前进键');
  assert.equal(T.normalize({ type: 'mouse', code: 3 }).label, '鼠标中键');
});

test('normalize：保留已有 label，缺省时自动生成', () => {
  assert.equal(T.normalize({ type: 'key', code: 3640, label: '我的键' }).label, '我的键');
  assert.equal(T.normalize({ type: 'key', code: 3640 }).label, '右 Alt');
  assert.equal(T.normalize({ type: 'key', code: 12345 }).label, '按键码 #12345');
});

test('捕获时不接受鼠标左键 / 右键，接受中键 / 侧键 / 任意键盘键', () => {
  assert.equal(T.capturable('mouse', 1), false);
  assert.equal(T.capturable('mouse', 2), false);
  for (const b of [3, 4, 5]) assert.equal(T.capturable('mouse', b), true);
  assert.equal(T.capturable('key', 999), true);
});

test('功能键 F1–F24 的名称正确', () => {
  // 与 uiohook-napi 的 UiohookKey 对应（F13–F15 为 91–93，F16 起为 99）
  const codes = { 1: 59, 10: 68, 11: 87, 12: 88, 13: 91, 15: 93, 16: 99, 24: 107 };
  for (const [n, code] of Object.entries(codes)) assert.equal(T.labelFor('key', code), 'F' + n);
});

test('预设：id 唯一，且除 Fn 外都已绑定', () => {
  const ids = T.PRESETS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of T.PRESETS) {
    if (p.id === 'fn') assert.equal(T.isBound(p.trigger), false);
    else assert.equal(T.isBound(p.trigger), true, p.id);
    assert.deepEqual(T.normalize(p.trigger), p.trigger, '预设应是已规范化的值：' + p.id);
  }
});
