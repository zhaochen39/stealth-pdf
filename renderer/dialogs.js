/* 通用对话框与弹出菜单：确认 / 输入 / 信息 / 快捷键 / 关于 / 下拉菜单。
 * 不使用系统对话框：隐身模式下系统对话框可能被隐藏，页内弹窗更可靠。 */
(() => {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /** 打开一个模态框。build(box, close) 往 box 里填内容；返回 close 函数。Esc 关闭（可由 opts.onEsc 接管） */
  function modal(build, opts = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = '<div class="dialog ' + (opts.size || 'small') + '" role="dialog" aria-modal="true"></div>';
    const box = wrap.firstChild;
    document.body.appendChild(wrap);
    let closed = false;
    const close = (v) => {
      if (closed) return;
      closed = true;
      window.removeEventListener('keydown', onKey, true);
      wrap.remove();
      if (opts.onClose) opts.onClose(v);
    };
    const onKey = (e) => {
      if (!wrap.isConnected) return;
      const inField = e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); (opts.onEsc || close)(); return; }
      if (e.key === 'Enter' && opts.onEnter && !(e.target && e.target.tagName === 'BUTTON')) { e.preventDefault(); e.stopImmediatePropagation(); opts.onEnter(); return; }
      if (!inField) e.stopImmediatePropagation();          // 弹窗期间屏蔽主界面的快捷键
    };
    window.addEventListener('keydown', onKey, true);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap && opts.dismiss !== false) (opts.onEsc || close)(); });
    build(box, close);
    return close;
  }

  function confirm(title, message, okText, opts = {}) {
    return new Promise((resolve) => {
      modal((box, close) => {
        box.innerHTML = '<h2>' + esc(title) + '</h2><p class="dlg-sub">' + esc(message) + '</p>' +
          '<div class="dlg-row end"><button class="btn" data-a="no">' + esc(opts.cancelText || '取消（Esc）') + '</button>' +
          '<button class="btn primary" data-a="yes">' + esc(okText || '确定') + '</button></div>';
        box.querySelector('[data-a=no]').onclick = () => close(false);
        box.querySelector('[data-a=yes]').onclick = () => close(true);
        box.querySelector('[data-a=yes]').focus();
      }, { onClose: (v) => resolve(!!v), onEnter: () => document.querySelector('.modal-wrap [data-a=yes]').click() });
    });
  }

  /** 输入框。validate(value) 返回错误文字则不关闭。取消返回 null */
  function prompt(o) {
    return new Promise((resolve) => {
      modal((box, close) => {
        box.innerHTML = '<h2>' + esc(o.title) + '</h2>' + (o.message ? '<p class="dlg-sub">' + esc(o.message) + '</p>' : '') +
          '<input class="dlg-input" type="' + (o.type || 'text') + '" placeholder="' + esc(o.placeholder || '') + '" value="' + esc(o.value || '') + '" />' +
          '<div class="dlg-err" hidden></div>' +
          '<div class="dlg-row end"><button class="btn" data-a="no">取消（Esc）</button><button class="btn primary" data-a="yes">' + esc(o.okText || '确定') + '</button></div>';
        const input = box.querySelector('input'), err = box.querySelector('.dlg-err');
        const submit = () => {
          const msg = o.validate ? o.validate(input.value) : null;
          if (msg) { err.textContent = msg; err.hidden = false; input.focus(); return; }
          close(input.value);
        };
        box.querySelector('[data-a=no]').onclick = () => close(null);
        box.querySelector('[data-a=yes]').onclick = submit;
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit(); } });
        setTimeout(() => { input.focus(); input.select(); }, 0);
      }, { onClose: (v) => resolve(v == null ? null : String(v)) });
    });
  }

  /** 信息框：rows 为 [[名称, 值], ...]，或直接传 html */
  function info(o) {
    return new Promise((resolve) => {
      modal((box, close) => {
        const rows = (o.rows || []).map(([k, v]) => '<tr><th>' + esc(k) + '</th><td>' + esc(v) + '</td></tr>').join('');
        box.innerHTML = '<h2>' + esc(o.title) + '</h2>' + (o.sub ? '<p class="dlg-sub">' + esc(o.sub) + '</p>' : '') +
          (rows ? '<table class="info-table">' + rows + '</table>' : '') + (o.html || '') +
          '<div class="dlg-row end"><button class="btn primary" data-a="ok">关闭</button></div>';
        box.querySelector('[data-a=ok]').onclick = () => close();
        box.querySelector('[data-a=ok]').focus();
      }, { size: o.size || 'small', onClose: () => resolve(), onEnter: () => document.querySelector('.modal-wrap [data-a=ok]').click() });
    });
  }

  function kbd(keys) { return String(keys).split('+').map((k) => '<kbd>' + esc(k.trim()) + '</kbd>').join('+'); }

  function shortcuts(groups) {
    return info({
      title: '快捷键', size: 'wide',
      html: '<div class="sc-grid">' + groups.map((g) => '<section><h3>' + esc(g.title) + '</h3>' +
        g.items.map(([k, d]) => '<div class="sc-row"><span>' + esc(d) + '</span><span>' + kbd(k) + '</span></div>').join('') + '</section>').join('') + '</div>'
    });
  }

  /* ---------- 下拉菜单 ---------- */
  let openMenu = null;
  function closeMenu() { if (openMenu) { openMenu.close(); openMenu = null; } }

  /** items: { label, icon?, hint?, checked?, disabled?, onClick?, separator?, header? } */
  function menu(anchor, items, opts = {}) {
    closeMenu();
    const el = document.createElement('div');
    el.className = 'menu';
    el.setAttribute('role', 'menu');
    items.forEach((it) => {
      if (it.separator) { el.insertAdjacentHTML('beforeend', '<div class="menu-sep"></div>'); return; }
      if (it.header) { el.insertAdjacentHTML('beforeend', '<div class="menu-head">' + esc(it.header) + '</div>'); return; }
      const b = document.createElement('button');
      b.className = 'menu-item' + (it.checked ? ' checked' : '') + (it.disabled ? ' disabled' : '');
      b.disabled = !!it.disabled;
      b.innerHTML = '<span class="mi-check">' + (it.checked ? window.icon('check') : '') + '</span>' +
        (it.icon ? '<span class="mi-ic">' + window.icon(it.icon) + '</span>' : '') +
        '<span class="mi-label" title="' + esc(it.title || '') + '">' + esc(it.label) + '</span>' +
        (it.hint ? '<span class="mi-hint">' + esc(it.hint) + '</span>' : '');
      b.onclick = () => { closeMenu(); if (it.onClick) it.onClick(); };
      el.appendChild(b);
    });
    if (!items.length) el.innerHTML = '<div class="menu-head">（空）</div>';
    document.body.appendChild(el);
    const r = anchor.getBoundingClientRect();
    const mw = el.offsetWidth, mh = el.offsetHeight;
    let left = opts.align === 'right' ? r.right - mw : r.left;
    let top = r.bottom + 2;
    if (opts.up || top + mh > window.innerHeight - 6) top = Math.max(6, r.top - mh - 2);
    left = Math.max(6, Math.min(left, window.innerWidth - mw - 6));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    const onDown = (e) => { if (!el.contains(e.target)) closeMenu(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); closeMenu(); } };
    setTimeout(() => { window.addEventListener('mousedown', onDown, true); }, 0);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeMenu);
    openMenu = {
      close() {
        window.removeEventListener('mousedown', onDown, true);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('blur', closeMenu);
        el.remove();
      }
    };
    return el;
  }

  window.Dlg = { modal, confirm, prompt, info, shortcuts, menu, closeMenu, esc, kbd };
})();
