/**
 * 把标注写入 PDF（不依赖 electron，便于单独测试）
 */
const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');
const A = require('./renderer/shared/annos');
const fontkit = require('@pdf-lib/fontkit');

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '') || [null, 'ff0000'];
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function cjkFontPath() {
  const dir = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
  for (const f of ['simhei.ttf', 'msyh.ttf']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * src 可以是文件路径，也可以是 PDF 字节（Buffer / Uint8Array）。
 * 标注坐标是「视图坐标」（缩放 1、左上角原点、已包含页面旋转），这里按 a.rot 与 CropBox 换算回 PDF 用户空间。
 */
async function applyAnnotations(src, annos) {
  const bytes = typeof src === 'string' ? fs.readFileSync(src) : src;
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  pdf.registerFontkit(fontkit);

  const latin = await pdf.embedFont(StandardFonts.Helvetica);
  let cjk = null;
  if (annos.some(a => a.type === 'text' && /[^\x20-\x7E]/.test(a.text))) {
    const fp = cjkFontPath();
    if (fp) cjk = await pdf.embedFont(fs.readFileSync(fp), { subset: true });
  }

  const pages = pdf.getPages();
  for (const a of annos) {
    const page = pages[a.page];
    if (!page) continue;
    const cb = page.getCropBox();
    const rot = A.normRot(a.rot);
    const map = (x, y) => {                       // 视图坐标 → 用户空间
      const [ux, uy] = A.viewToUser(x, y, rot, cb.width, cb.height);
      return [cb.x + ux, cb.y + uy];
    };
    const mapRect = ([x, y, w, h]) => {           // 轴对齐矩形旋转后仍是轴对齐矩形
      const [x1, y1] = map(x, y), [x2, y2] = map(x + w, y + h);
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    };
    const color = hexToRgb(a.color);

    if (a.type === 'highlight') {
      for (const r of A.rectsOf(a)) page.drawRectangle({ ...mapRect(r), color, opacity: 0.35 });
    } else if (a.type === 'underline' || a.type === 'strike') {
      for (const [x, y, w, h] of A.rectsOf(a)) {
        const ly = a.type === 'underline' ? y + h * 0.92 : y + h * 0.56;
        const [x1, y1] = map(x, ly), [x2, y2] = map(x + w, ly);
        page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: Math.max(0.8, h * 0.07), color });
      }
    } else if (a.type === 'rect') {
      page.drawRectangle({ ...mapRect([a.x, a.y, a.w, a.h]), borderColor: color, borderWidth: a.width || 2 });
    } else if (a.type === 'pen') {
      for (let i = 1; i < a.points.length; i++) {
        const [x1, y1] = map(a.points[i - 1][0], a.points[i - 1][1]);
        const [x2, y2] = map(a.points[i][0], a.points[i][1]);
        page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: a.width, color, lineCap: 1 });
      }
    } else if (a.type === 'text') {
      const ascii = !/[^\x20-\x7E]/.test(a.text);
      const font = ascii ? latin : (cjk || latin);
      const text = (font === latin && !ascii) ? a.text.replace(/[^\x20-\x7E]/g, '?') : a.text;
      const [ox, oy] = map(a.x, a.y + a.size * 0.85);   // 基线起点
      page.drawText(text, { x: ox, y: oy, size: a.size, font, color, rotate: degrees(A.textAngle(rot)) });
    }
  }
  return pdf.save();
}

module.exports = { applyAnnotations };
