'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { applyAnnotations } = require('../annotate');

async function makeSamplePdf(dir, pages = 3) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    doc.addPage([595, 842]).drawText('page ' + i, { x: 50, y: 780, size: 20, font });
  }
  const file = path.join(dir, 'sample.pdf');
  fs.writeFileSync(file, await doc.save());
  return file;
}

test('applyAnnotations：写入高亮 / 画笔 / 英文文字后仍是合法 PDF，页数不变', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stealthpdf-'));
  try {
    const src = await makeSamplePdf(dir, 3);
    const before = fs.statSync(src).size;
    const out = await applyAnnotations(src, [
      { type: 'highlight', page: 0, x: 60, y: 60, w: 200, h: 30, color: '#ffd400' },
      { type: 'pen', page: 1, points: [[100, 100], [150, 130], [200, 110]], width: 2, color: '#e53935' },
      { type: 'text', page: 2, x: 80, y: 200, text: 'Hello annotate', size: 16, color: '#0000ff' }
    ]);
    const reopened = await PDFDocument.load(out);
    assert.equal(reopened.getPageCount(), 3);
    assert.ok(out.length > before, '写入标注后文件应变大');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyAnnotations：不会修改源文件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stealthpdf-'));
  try {
    const src = await makeSamplePdf(dir, 1);
    const snapshot = fs.readFileSync(src);
    await applyAnnotations(src, [{ type: 'highlight', page: 0, x: 10, y: 10, w: 50, h: 20, color: '#ffd400' }]);
    assert.deepEqual(fs.readFileSync(src), snapshot);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyAnnotations：忽略不存在的页码，不抛错', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stealthpdf-'));
  try {
    const src = await makeSamplePdf(dir, 1);
    const out = await applyAnnotations(src, [{ type: 'highlight', page: 99, x: 1, y: 1, w: 5, h: 5, color: '#ffd400' }]);
    assert.equal((await PDFDocument.load(out)).getPageCount(), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyAnnotations：非法颜色回退为红色，不抛错', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stealthpdf-'));
  try {
    const src = await makeSamplePdf(dir, 1);
    const out = await applyAnnotations(src, [{ type: 'highlight', page: 0, x: 1, y: 1, w: 50, h: 20, color: 'not-a-color' }]);
    assert.ok(out.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applyAnnotations：没有中文字体时，中文文字退化为 ? 但不崩溃', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stealthpdf-'));
  try {
    const src = await makeSamplePdf(dir, 1);
    const out = await applyAnnotations(src, [{ type: 'text', page: 0, x: 50, y: 100, text: '中文 abc', size: 14, color: '#000000' }]);
    assert.equal((await PDFDocument.load(out)).getPageCount(), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
