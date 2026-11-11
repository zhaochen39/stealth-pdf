/**
 * 页面级编辑（旋转 / 删除 / 插入空白页 / 提取 / 合并），基于 pdf-lib，不依赖 electron。
 * 输入输出都是字节（Uint8Array / Buffer），页码均为 0 起的下标。
 */
const { PDFDocument, degrees } = require('pdf-lib');

const load = (bytes) => PDFDocument.load(bytes, { ignoreEncryption: true });

function checkIndexes(pdf, indexes) {
  const n = pdf.getPageCount();
  const list = Array.from(new Set(indexes || [])).sort((a, b) => a - b);
  if (!list.length) throw new Error('没有选中任何页面');
  if (list.some((i) => !Number.isInteger(i) || i < 0 || i >= n)) throw new Error('页码超出范围');
  return list;
}

/** 旋转：delta 为 90 的倍数（正数顺时针） */
async function rotatePages(bytes, indexes, delta) {
  const pdf = await load(bytes);
  for (const i of checkIndexes(pdf, indexes)) {
    const page = pdf.getPage(i);
    const cur = page.getRotation().angle || 0;
    page.setRotation(degrees((((cur + delta) % 360) + 360) % 360));
  }
  return pdf.save();
}

async function deletePages(bytes, indexes) {
  const pdf = await load(bytes);
  const list = checkIndexes(pdf, indexes);
  if (list.length >= pdf.getPageCount()) throw new Error('不能删除全部页面');
  for (const i of list.reverse()) pdf.removePage(i);
  return pdf.save();
}

/** 在 afterIndex 之后插入一张空白页（afterIndex = -1 表示插到最前面），尺寸参照相邻页 */
async function insertBlank(bytes, afterIndex) {
  const pdf = await load(bytes);
  const n = pdf.getPageCount();
  const ref = pdf.getPage(Math.min(Math.max(afterIndex, 0), n - 1));
  const { width, height } = ref.getSize();
  pdf.insertPage(Math.min(Math.max(afterIndex + 1, 0), n), [width, height]);
  return pdf.save();
}

/** 把 indexes 指定的页面提取成新文件 */
async function extractPages(bytes, indexes) {
  const src = await load(bytes);
  const list = checkIndexes(src, indexes);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, list);
  pages.forEach((p) => out.addPage(p));
  return out.save();
}

/** 把另一个 PDF 的全部页面插入到 afterIndex 之后（-1 = 最前面） */
async function insertPdf(bytes, otherBytes, afterIndex) {
  const dst = await load(bytes);
  const src = await load(otherBytes);
  const copied = await dst.copyPages(src, src.getPageIndices());
  let at = Math.min(Math.max(afterIndex + 1, 0), dst.getPageCount());
  copied.forEach((p) => dst.insertPage(at++, p));
  return dst.save();
}

async function run(op, bytes, args = {}) {
  switch (op) {
    case 'rotate': return rotatePages(bytes, args.pages, args.delta);
    case 'delete': return deletePages(bytes, args.pages);
    case 'blank': return insertBlank(bytes, args.after);
    case 'extract': return extractPages(bytes, args.pages);
    case 'insert': return insertPdf(bytes, args.other, args.after);
    default: throw new Error('未知操作：' + op);
  }
}

module.exports = { rotatePages, deletePages, insertBlank, extractPages, insertPdf, run };
