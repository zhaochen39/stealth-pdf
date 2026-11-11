'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../renderer/shared/ranges');
const A = require('../renderer/shared/annos');

test('ranges：基本写法', () => {
  assert.deepEqual(R.parse('1-3, 5', 10).pages, [0, 1, 2, 4]);
  assert.deepEqual(R.parse('8-', 10).pages, [7, 8, 9]);
  assert.deepEqual(R.parse('-2', 10).pages, [0, 1]);
  assert.deepEqual(R.parse('', 3).pages, [0, 1, 2]);
  assert.deepEqual(R.parse('all', 3).pages, [0, 1, 2]);
  assert.deepEqual(R.parse('3，1－2,2', 5).pages, [0, 1, 2], '全角逗号 / 连字符、去重、排序');
});

test('ranges：非法输入给出错误而不是抛异常', () => {
  for (const bad of ['0', '11', '3-1', 'abc', '1-2-3', '1,,x']) {
    const r = R.parse(bad, 10);
    assert.equal(r.ok, false, bad);
    assert.ok(r.error, bad);
  }
  assert.equal(R.parse('1', 0).ok, false);
});

test('annos.viewToUser：四个旋转角下，视图四角对应 PDF 页面的正确角', () => {
  const W = 600, H = 800;          // 未旋转的页面尺寸
  // 旋转 0：视图左上角 = 用户空间左上角 (0,H)
  assert.deepEqual(A.viewToUser(0, 0, 0, W, H), [0, H]);
  // 旋转 90（顺时针）：视图 H×W；视图左上角 = 原页面左下角 (0,0)；视图右上角 (H,0) = 原页面左上角 (0,H)
  assert.deepEqual(A.viewToUser(0, 0, 90, W, H), [0, 0]);
  assert.deepEqual(A.viewToUser(H, 0, 90, W, H), [0, H]);
  // 旋转 180：视图左上角 = 原页面右下角 (W,0)
  assert.deepEqual(A.viewToUser(0, 0, 180, W, H), [W, 0]);
  // 旋转 270：视图左上角 = 原页面右上角 (W,H)；视图右上角 (H,0) = 原页面右下角 (W,0)
  assert.deepEqual(A.viewToUser(0, 0, 270, W, H), [W, H]);
  assert.deepEqual(A.viewToUser(H, 0, 270, W, H), [W, 0]);
  assert.equal(A.normRot(-90), 270);
  assert.equal(A.normRot(450), 90);
});

test('annos.hit / pick：各类标注的命中测试', () => {
  const hl = { type: 'highlight', page: 0, x: 10, y: 10, w: 100, h: 20 };
  const pen = { type: 'pen', page: 0, points: [[0, 0], [100, 0]], width: 2 };
  const rect = { type: 'rect', page: 0, x: 50, y: 50, w: 100, h: 60, width: 2 };
  const txt = { type: 'text', page: 1, x: 20, y: 20, text: 'Hello', size: 16 };
  const ul = { type: 'underline', page: 0, rects: [[10, 100, 80, 12], [10, 114, 40, 12]] };
  assert.ok(A.hit(hl, 50, 20));
  assert.ok(!A.hit(hl, 50, 80));
  assert.ok(A.hit(pen, 50, 2) && !A.hit(pen, 50, 30));
  assert.ok(A.hit(rect, 50, 80), '边框上');
  assert.ok(!A.hit(rect, 100, 80), '矩形内部不响应');
  assert.ok(A.hit(txt, 25, 28));
  assert.ok(A.hit(ul, 20, 118), '多行矩形都能命中');
  // pick：最后添加（最上层）的优先；跨页不串
  const list = [hl, { ...hl, x: 20 }, txt];
  assert.equal(A.pick(list, 0, 30, 15), 1);
  assert.equal(A.pick(list, 1, 25, 28), 2);
  assert.equal(A.pick(list, 0, 500, 500), -1);
});

test('annos.mergeRects：把同一行贴在一起的碎片合成一块，不合并不同行', () => {
  const merged = A.mergeRects([[10, 10, 30, 12], [40, 10, 30, 12], [70.5, 10.4, 20, 11.6], [10, 40, 50, 12]]);
  assert.equal(merged.length, 2);
  assert.ok(Math.abs(merged[0][2] - 80.5) < 1e-9 || merged[0][2] > 79);
  assert.equal(merged[1][1], 40);
});
