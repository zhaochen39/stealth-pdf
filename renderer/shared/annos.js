/**
 * 标注的几何计算（纯函数，渲染进程与主进程 / 测试共用）。
 * 标注坐标：当前页面「缩放 1」时视图里的坐标，单位 pt，原点在左上角，已包含页面旋转。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Annos = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const normRot = (r) => (((Math.round((+r || 0) / 90) * 90) % 360) + 360) % 360;

  /** 视图坐标（缩放 1，左上角原点，已旋转）→ PDF 用户空间（相对 CropBox 左下角）。W、H 为未旋转的 CropBox 宽高 */
  function viewToUser(x, y, rot, W, H) {
    switch (normRot(rot)) {
      case 90: return [y, x];
      case 180: return [W - x, y];
      case 270: return [W - y, H - x];
      default: return [x, H - y];
    }
  }

  /** 文字批注在 PDF 里的旋转角度（逆时针，度） */
  const textAngle = (rot) => normRot(rot);

  const textWidth = (a) => {
    let w = 0;
    for (const ch of String(a.text || '')) w += /[\x20-\x7E]/.test(ch) ? 0.56 : 1;
    return Math.max(w * a.size, a.size);
  };

  function rectsOf(a) {
    if (a.type === 'highlight' || a.type === 'underline' || a.type === 'strike') {
      if (Array.isArray(a.rects) && a.rects.length) return a.rects;
      return [[a.x, a.y, a.w, a.h]];
    }
    if (a.type === 'rect') return [[a.x, a.y, a.w, a.h]];
    if (a.type === 'text') return [[a.x, a.y, textWidth(a), a.size * 1.2]];
    return [];
  }

  function distSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  /** 点 (x,y)（页面坐标）是否点中了这个标注；tol 为容差（pt） */
  function hit(a, x, y, tol) {
    tol = tol || 4;
    if (a.type === 'pen') {
      const pts = a.points || [];
      const r = Math.max(tol, (a.width || 2) / 2 + 2);
      if (pts.length === 1) return Math.hypot(x - pts[0][0], y - pts[0][1]) <= r;
      for (let i = 1; i < pts.length; i++) {
        if (distSeg(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= r) return true;
      }
      return false;
    }
    if (a.type === 'rect') {                 // 只响应边框，方便点中后面的内容
      const [rx, ry, rw, rh] = rectsOf(a)[0];
      const inOuter = x >= rx - tol && x <= rx + rw + tol && y >= ry - tol && y <= ry + rh + tol;
      const inInner = x > rx + tol && x < rx + rw - tol && y > ry + tol && y < ry + rh - tol;
      return inOuter && !inInner;
    }
    return rectsOf(a).some(([rx, ry, rw, rh]) => x >= rx - tol && x <= rx + rw + tol && y >= ry - tol && y <= ry + rh + tol);
  }

  /** 在某一页的标注里找最上面（最后添加）被点中的，返回下标，没有返回 -1 */
  function pick(annos, page, x, y, tol) {
    for (let i = annos.length - 1; i >= 0; i--) {
      if (annos[i].page === page && hit(annos[i], x, y, tol)) return i;
    }
    return -1;
  }

  /** 把同一行里贴在一起的矩形合并（文字选区常被切成很多小块） */
  function mergeRects(rects) {
    const out = [];
    for (const r of rects.map((q) => q.slice())) {
      const last = out[out.length - 1];
      if (last && Math.abs(last[1] - r[1]) < Math.max(last[3], r[3]) * 0.4 && r[0] <= last[0] + last[2] + 2 && r[0] >= last[0] - 2) {
        const x2 = Math.max(last[0] + last[2], r[0] + r[2]);
        const y1 = Math.min(last[1], r[1]);
        const y2 = Math.max(last[1] + last[3], r[1] + r[3]);
        last[2] = x2 - last[0]; last[1] = y1; last[3] = y2 - y1;
      } else out.push(r);
    }
    return out;
  }

  return { normRot, viewToUser, textAngle, textWidth, rectsOf, hit, pick, mergeRects, distSeg };
});
