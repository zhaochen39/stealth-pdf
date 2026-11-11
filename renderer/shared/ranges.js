/**
 * 页码范围解析（渲染进程与主进程 / 测试共用的纯函数）
 *   "1-3, 5, 8-"  →  [0,1,2,4,7,8,...]（页码从 1 开始，返回 0 起的下标）
 *   "all" / ""    →  全部页
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PageRange = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function parse(text, n) {
    const s = String(text == null ? '' : text).replace(/，/g, ',').replace(/[－—–~～]/g, '-').trim().toLowerCase();
    if (!(n >= 1)) return { ok: false, error: '文档没有页面' };
    if (s === '' || s === 'all' || s === '全部') return { ok: true, pages: Array.from({ length: n }, (_, i) => i) };
    const set = new Set();
    for (const raw of s.split(',')) {
      const part = raw.trim();
      if (!part) continue;
      let m;
      let a, b;
      if ((m = /^(\d+)$/.exec(part))) { a = b = +m[1]; }
      else if ((m = /^(\d+)\s*-\s*(\d*)$/.exec(part))) { a = +m[1]; b = m[2] === '' ? n : +m[2]; }
      else if ((m = /^-\s*(\d+)$/.exec(part))) { a = 1; b = +m[1]; }
      else return { ok: false, error: '无法识别「' + part + '」，示例：1-3, 5, 8-' };
      if (a < 1 || b < 1 || a > n || b > n) return { ok: false, error: '页码超出范围（共 ' + n + ' 页）：' + part };
      if (a > b) return { ok: false, error: '范围起点大于终点：' + part };
      for (let i = a; i <= b; i++) set.add(i - 1);
    }
    if (!set.size) return { ok: false, error: '请输入页码，例如 1-3, 5' };
    return { ok: true, pages: Array.from(set).sort((x, y) => x - y) };
  }
  return { parse };
});
