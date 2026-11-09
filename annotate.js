/**
 * 把标注写入 PDF（不依赖 electron，便于单独测试）
 */
const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
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

async function applyAnnotations(srcPath, annos) {
  const bytes = fs.readFileSync(srcPath);
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
    const { height } = page.getSize();
    const color = hexToRgb(a.color);

    if (a.type === 'highlight') {
      page.drawRectangle({
        x: a.x, y: height - a.y - a.h, width: a.w, height: a.h,
        color, opacity: 0.35
      });
    } else if (a.type === 'pen') {
      for (let i = 1; i < a.points.length; i++) {
        const [x1, y1] = a.points[i - 1];
        const [x2, y2] = a.points[i];
        page.drawLine({
          start: { x: x1, y: height - y1 },
          end: { x: x2, y: height - y2 },
          thickness: a.width, color, lineCap: 1
        });
      }
    } else if (a.type === 'text') {
      const ascii = !/[^\x20-\x7E]/.test(a.text);
      const font = ascii ? latin : (cjk || latin);
      const text = (font === latin && !ascii) ? a.text.replace(/[^\x20-\x7E]/g, '?') : a.text;
      page.drawText(text, {
        x: a.x, y: height - a.y - a.size * 0.85,
        size: a.size, font, color
      });
    }
  }
  return pdf.save();
}

module.exports = { applyAnnotations };
