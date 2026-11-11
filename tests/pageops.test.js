'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const ops = require('../pageops');

async function sample(n, sizes) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) {
    const [w, h] = (sizes && sizes[i]) || [595, 842];
    d.addPage([w, h]).drawText('P' + (i + 1), { x: 50, y: h - 60, size: 24, font: f });
  }
  return d.save();
}
const count = async (b) => (await PDFDocument.load(b)).getPageCount();

test('rotate：叠加旋转角度，且只影响选中的页', async () => {
  const b = await sample(3);
  const r1 = await ops.rotatePages(b, [1], 90);
  let d = await PDFDocument.load(r1);
  assert.deepEqual(d.getPages().map((p) => p.getRotation().angle), [0, 90, 0]);
  const r2 = await ops.rotatePages(r1, [1, 2], -90);
  d = await PDFDocument.load(r2);
  assert.deepEqual(d.getPages().map((p) => p.getRotation().angle), [0, 0, 270]);
});

test('delete：删除指定页；不允许删光；越界报错', async () => {
  const b = await sample(4);
  assert.equal(await count(await ops.deletePages(b, [0, 2])), 2);
  await assert.rejects(() => ops.deletePages(b, [0, 1, 2, 3]), /不能删除全部/);
  await assert.rejects(() => ops.deletePages(b, [9]), /超出范围/);
  await assert.rejects(() => ops.deletePages(b, []), /没有选中/);
});

test('blank：在指定页之后插入，尺寸跟随相邻页；-1 插到最前', async () => {
  const b = await sample(2, [[400, 300], [595, 842]]);
  let d = await PDFDocument.load(await ops.insertBlank(b, 0));
  assert.equal(d.getPageCount(), 3);
  assert.deepEqual([d.getPage(1).getWidth(), d.getPage(1).getHeight()], [400, 300]);
  d = await PDFDocument.load(await ops.insertBlank(b, -1));
  assert.equal(d.getPageCount(), 3);
  assert.deepEqual([d.getPage(0).getWidth(), d.getPage(0).getHeight()], [400, 300]);
});

test('extract：提取为新文件，不改动原文件字节', async () => {
  const b = await sample(5);
  const copy = Buffer.from(b);
  const out = await ops.extractPages(b, [1, 3]);
  assert.equal(await count(out), 2);
  assert.deepEqual(Buffer.from(b), copy);
});

test('insert：把另一个 PDF 合并到指定位置之后', async () => {
  const a = await sample(2), o = await sample(3, [[300, 300], [300, 300], [300, 300]]);
  const merged = await PDFDocument.load(await ops.insertPdf(a, o, 0));
  assert.equal(merged.getPageCount(), 5);
  assert.equal(merged.getPage(1).getWidth(), 300);
  assert.equal(merged.getPage(4).getWidth(), 595);
  const atEnd = await PDFDocument.load(await ops.insertPdf(a, o, 1));
  assert.equal(atEnd.getPage(4).getWidth(), 300);
});

test('run：按操作名分发，未知操作报错', async () => {
  const b = await sample(2);
  assert.equal(await count(await ops.run('blank', b, { after: 1 })), 3);
  await assert.rejects(() => ops.run('nope', b), /未知操作/);
});
