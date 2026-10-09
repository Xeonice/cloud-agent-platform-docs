/* v2 原稿扩展：按钮触发的可搜索单选；仅内存交互，沿用原样式与原 change 链路。 */
(function () {
  'use strict';
  const P = window.P;
  let opened = null, serial = 0;
  P.hook('escape', () => { if (!opened) return undefined; opened.close(true); return true; }, { first: true });
  P.hook('pointerdown', e => { if (opened && !opened.owns(e.target)) opened.close(false); });
  P.hook('resize', () => { if (opened) opened.place(); });
  P.hook('scroll', () => { if (opened) opened.place(); });
  P.hook('inert', on => { if (!on && opened) opened.close(false); });
  // 列表搜索框在 Dialog 的末尾；Tab 按触发器在原表单中的位置继续，不改已选值。
  document.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229 || e.key !== 'Tab' || !opened || !opened.owns(e.target)) return;
    const c = opened, dlg = c.btn.closest('.dialog');
    c.close(false);
    const items = P.focusables(dlg), at = items.indexOf(c.btn);
    const next = items[(at + (e.shiftKey ? -1 : 1) + items.length) % items.length];
    e.preventDefault(); e.stopImmediatePropagation(); if (next) next.focus({ preventScroll: true });
  }, true);
  P.searchSelect = function searchSelect(config) {
    const btn = config.btn, label = config.valueEl;
    const key = config.key || `search-${++serial}`;
    let opts = [], value = config.value == null ? '' : config.value;
    let pop = null, input = null, results = null, visible = [], active = -1, query = '';
    btn.id = `${key}-trigger`; btn.setAttribute('aria-expanded', 'false'); btn.removeAttribute('aria-controls');
    const option = () => opts.find(o => o.value === value) || null;
    function paintValue() { const o = option(); if (o) { label.textContent = o.label; btn.title = o.description ? `${o.label} · ${o.description}` : o.label; } }
    function mark() {
      if (!results) return;
      for (const el of results.querySelectorAll('[role="option"]')) el.classList.toggle('is-focus', Number(el.dataset.index) === active);
      if (active >= 0) input.setAttribute('aria-activedescendant', `${key}-option-${active}`); else input.removeAttribute('aria-activedescendant');
      const target = results.querySelector('.is-focus'); if (target) target.scrollIntoView({ block: 'nearest' });
    }
    function paintList() {
      if (!pop) return;
      const q = query.trim().toLowerCase();
      visible = opts.filter(o => o.fixed || !q || String(o.search == null ? `${o.label} ${o.description || ''}` : o.search).toLowerCase().includes(q));
      results.replaceChildren();
      const matches = visible.filter(o => !o.fixed);
      visible.forEach((o, n) => {
        const row = document.createElement('div'); row.className = 'menu__item search-select__option'; row.id = `${key}-option-${n}`;
        row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(o.value === value)); row.dataset.index = n; row.dataset.value = o.value;
        if (o.disabled) row.setAttribute('aria-disabled', 'true');
        if (o.fixed) row.classList.add('search-select__default');
        const copy = document.createElement('span'); copy.className = 'search-select__copy';
        const main = document.createElement('span'); main.textContent = o.label; copy.appendChild(main);
        if (o.description) { const sub = document.createElement('span'); sub.className = 'search-select__description'; sub.textContent = o.description; copy.appendChild(sub); }
        if (o.reason || o.warning) { const reason = document.createElement('span'); reason.className = 'search-select__description'; reason.textContent = o.reason || o.warning; copy.appendChild(reason); }
        row.appendChild(copy); results.appendChild(row);
      });
      if ((!q && !visible.length) || (q && !matches.length)) {
        const empty = document.createElement('p'); empty.className = 'menu__note search-select__empty'; empty.dataset.testid = `${key}-empty`;
        empty.textContent = q ? `没有匹配的${config.kind || '选项'}。` : `没有可选的${config.kind || '选项'}。`; results.appendChild(empty);
        if (q) { const clear = document.createElement('button'); clear.className = 'link search-select__clear'; clear.type = 'button'; clear.textContent = '清空搜索'; clear.dataset.clearSearch = ''; results.appendChild(clear); }
      }
      active = visible.findIndex(o => !o.disabled && (!q || !o.fixed)); mark(); place();
    }
    function place() {
      if (!pop) return;
      const dlg = btn.closest('[role="dialog"]');
      if (!btn.isConnected || !dlg) { close(false); return; }
      const r = btn.getBoundingClientRect(), width = Math.min(r.width, window.innerWidth - 16), left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      pop.style.width = `${width}px`; pop.style.left = `${left}px`;
      // 浮层只占 Dialog 正文的可见区域，固定头部和页脚始终露出。
      const body = dlg.querySelector('.dialog__body'), header = dlg.querySelector('.dialog__header'), footer = dlg.querySelector('.dialog__footer');
      const bodyRect = body ? body.getBoundingClientRect() : dlg.getBoundingClientRect();
      const upper = Math.max(8, bodyRect.top, header ? header.getBoundingClientRect().bottom : 8);
      const lower = Math.min(window.innerHeight - 8, bodyRect.bottom, footer ? footer.getBoundingClientRect().top : window.innerHeight - 8);
      const below = Math.max(0, lower - r.bottom - 4), above = Math.max(0, r.top - upper - 4);
      const down = below >= 160 || below >= above;
      const room = Math.max(0, Math.floor(down ? below : above));
      pop.style.maxHeight = `${Math.min(320, room)}px`;
      const height = pop.getBoundingClientRect().height;
      const wanted = down ? r.bottom + 4 : r.top - height - 4;
      pop.style.top = `${Math.max(upper, Math.min(wanted, lower - height))}px`;
    }

    function pick(n) { const o = visible[n]; if (!o || o.disabled) return; const changed = value !== o.value; value = o.value; paintValue(); close(true); if (changed && config.onPick) config.onPick(o); }
    function close(focusBack) {
      query = '';
      if (!pop) return;
      pop.remove(); pop = input = results = null; active = -1;
      btn.setAttribute('aria-expanded', 'false'); btn.removeAttribute('aria-controls');
      if (opened === C) opened = null;
      if (focusBack && btn.isConnected && !btn.disabled) btn.focus({ preventScroll: true });
    }
    function open() {
      if (btn.disabled || pop) return;
      const dlg = btn.closest('.dialog'); if (!dlg) return;
      if (opened) opened.close(false);
      pop = document.createElement('div'); pop.className = 'menu nt-listbox search-select'; pop.id = `${key}-popover`;
      const bar = document.createElement('div'); bar.className = 'search-select__search';
      input = document.createElement('input'); input.className = 'input'; input.id = `${key}-search`; input.type = 'search'; input.autocomplete = 'off'; input.spellcheck = false;
      input.dataset.searchInput = ''; input.placeholder = `搜索${config.kind || '选项'}`; input.setAttribute('aria-label', input.placeholder); input.setAttribute('role', 'combobox'); input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-controls', `${key}-list`);
      bar.appendChild(input); pop.appendChild(bar);
      results = document.createElement('div'); results.className = 'search-select__results'; results.id = `${key}-list`; results.setAttribute('role', 'listbox'); results.setAttribute('aria-label', config.kind || '选项'); pop.appendChild(results);
      dlg.appendChild(pop); opened = C; query = ''; btn.setAttribute('aria-expanded', 'true'); btn.setAttribute('aria-controls', pop.id);
      paintList(); input.focus({ preventScroll: true });
      input.addEventListener('input', () => { query = input.value; paintList(); });
      input.addEventListener('keydown', e => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault(); const step = e.key === 'ArrowDown' ? 1 : -1;
          let n = active; for (let tries = 0; tries < visible.length; tries++) { n = (n + step + visible.length) % visible.length; if (!visible[n].disabled) { active = n; break; } } mark();
        } else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (active >= 0) pick(active); }
      });
      pop.addEventListener('mousedown', e => { if (e.target !== input) e.preventDefault(); });
      pop.addEventListener('click', e => { const clear = e.target.closest('[data-clear-search]'); if (clear) { input.value = query = ''; paintList(); input.focus(); return; } const row = e.target.closest('[role="option"]'); if (row) pick(Number(row.dataset.index)); });
      pop.addEventListener('pointermove', e => { const row = e.target.closest('[role="option"]'); if (row && row.getAttribute('aria-disabled') !== 'true') { active = Number(row.dataset.index); mark(); } });
      for (const a of dlg.getAnimations()) a.finished.then(() => place(), () => {});
      requestAnimationFrame(() => { place(); if (input) input.focus({ preventScroll: true }); });
    }
    btn.addEventListener('click', () => pop ? close(true) : open());
    btn.addEventListener('keydown', e => { if (['ArrowDown', 'ArrowUp'].includes(e.key) && !e.isComposing) { e.preventDefault(); open(); } });
    const C = { btn, get value() { return value; }, option, set(v) { value = v; paintValue(); if (pop) paintList(); }, setOptions(o) { opts = o; if (!opts.some(x => x.value === value)) { const fallback = opts.find(x => x.fixed) || opts[0]; if (fallback) value = fallback.value; } paintValue(); if (pop) paintList(); }, disable(on) { btn.disabled = on; if (on) close(false); }, open, close, place, owns: el => !!(el && (btn.contains(el) || (pop && pop.contains(el)))), isOpen: () => !!pop };
    return C;
  };
  P.searchNativeSelect = function searchNativeSelect(native, config) {
    const btn = document.createElement('button'); btn.className = 'select__control nt-combo'; btn.type = 'button'; btn.setAttribute('role', 'combobox'); btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-label', native.getAttribute('aria-label'));
    btn.dataset.nt = native.dataset.nt; btn.dataset.fk = native.dataset.fk;
    const valueEl = document.createElement('span'); btn.appendChild(valueEl); native.before(btn);
    native.hidden = true; native.tabIndex = -1; native.setAttribute('aria-hidden', 'true'); delete native.dataset.nt; delete native.dataset.fk;
    const C = P.searchSelect({ btn, valueEl, key: config.key, kind: config.kind, value: native.value, onPick(o) { native.value = o.value; native.dispatchEvent(new Event('change', { bubbles: true })); } });
    C.refresh = () => { C.setOptions([...native.options].map(o => Object.assign({ value: o.value, label: o.textContent, disabled: o.disabled, fixed: config.fixedDefault && o.value === '' }, config.option ? config.option(o) : {}))); C.set(native.value); C.disable(native.disabled); };
    const observer = new MutationObserver(() => { if (!native.closest('[role="dialog"]') && native.isConnected) { C.close(false); } C.refresh(); }); observer.observe(native, { childList: true, attributes: true, subtree: true });
    native.addEventListener('change', C.refresh); C.refresh(); return C;
  };
})();
