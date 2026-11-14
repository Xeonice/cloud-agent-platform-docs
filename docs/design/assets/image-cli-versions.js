/* 原 v2 的镜像 CLI 版本增量；仅在显式 feature 参数启用，不修改基础快照。 */
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  if (params.get('feature') !== 'runtime-versions') return;
  const P = window.P;
  if (!P) return;
  document.documentElement.dataset.cliVersionsDesign = '';
  document.title = '镜像 CLI 版本 · 原 v2 增量设计';
  const NAMES = [['codex', 'Codex'], ['claude-code', 'Claude Code']];
  const UNKNOWN = '未报告';
  const EXPLAIN = '镜像构建声明；任务实际版本以任务环境为准。';
  // 所有数值均为设计示例。以 digest 为键，切换/回滚不会借用另一版本的声明。
  const reported = new Map();
  const preset = P.world.images.find(i => i.builtin);
  const custom = P.world.images.find(i => i.id === 'ml-agent');
  if (preset) reported.set(preset.face.digest, { codex: '0.150.1', 'claude-code': '2.1.251' });
  if (custom) {
    reported.set(custom.face.digest, { codex: '0.150.1' });
    for (const v of custom.history) reported.set(v.digest, { codex: '0.149.0', 'claude-code': '2.1.240' });
    if (custom.upstreamNext) reported.set(custom.upstreamNext.digest, { codex: '0.150.2', 'claude-code': '2.1.252' });
  }
  P.scenario.define({ key: 'img-cli-versions', group: '镜像', label: 'CLI 版本构建声明', def: 'reported', options: [['reported', '已报告 / 部分未知 / 未报告'], ['unknown', '旧 API 或镜像未报告（全部未知）']] });
  function versions(digest) { return P.scenario.is('img-cli-versions', 'unknown') ? {} : reported.get(digest) || {}; }
  function summary(digest) { const v = versions(digest); return NAMES.map(([id, name]) => `${name} ${v[id] || UNKNOWN}`).join(' · '); }
  function line(digest, cls) {
    const el = document.createElement('span');
    el.className = cls || 'image-cli-versions'; el.textContent = summary(digest);
    el.title = EXPLAIN; el.setAttribute('aria-label', `镜像声明：${summary(digest)}。${EXPLAIN}`);
    return el;
  }
  function replaceLine(parent, key, digest, cls) {
    let el = parent.querySelector(`[data-cli-versions="${key}"]`);
    const next = line(digest, cls); next.dataset.cliVersions = key;
    if (el) { if (el.textContent !== next.textContent) el.replaceWith(next); }
    else parent.appendChild(next);
  }
  const wiredSearch = new WeakSet();
  const wiredFilter = new WeakSet();
  function filterByVersion() {
    const input = document.querySelector('[data-fk="img-search"]'); if (!input) return;
    const query = input.value.trim().toLowerCase();
    const state = window.__proto && window.__proto.state.imagePage;
    const filter = state ? state.filter : 'all';
    let count = 0;
    for (const card of document.querySelectorAll('article[data-img]')) {
      const i = P.world.images.find(x => x.id === card.dataset.img); if (!i) continue;
      const text = `${i.alias || ''} ${i.name} ${i.ref} ${i.face.version || ''} ${summary(i.face.digest)}`.toLowerCase();
      card.hidden = !((filter === 'all' || i.face.status === filter) && (!query || text.includes(query)));
      if (!card.hidden) count++;
    }
    const empty = document.querySelector('[data-testid="images-filtered-empty"]'); if (empty) empty.hidden = count > 0;
  }
  function paintCards() {
    for (const card of document.querySelectorAll('article[data-img]')) {
      const i = P.world.images.find(x => x.id === card.dataset.img); if (!i) continue;
      const kv = card.querySelector('[data-part="kv"]');
      if (kv) {
        if (!kv.querySelector('[data-cli-version-label]')) {
          const dt = document.createElement('dt'); dt.dataset.cliVersionLabel = ''; dt.textContent = 'CLI 版本：'; dt.title = EXPLAIN;
          const dd = document.createElement('dd'); dd.dataset.cliVersionCurrent = ''; dd.className = 'image-cli-versions__current';
          const declared = document.createElement('span'); declared.className = 'u-muted image-cli-versions__source'; declared.textContent = '镜像声明';
          dd.appendChild(declared); kv.append(dt, dd);
        }
        replaceLine(kv.querySelector('[data-cli-version-current]'), 'current', i.face.digest);
      }
      card.querySelectorAll('[data-testid="image-version-row"]').forEach((row, n) => {
        if (i.history[n]) replaceLine(row, 'history', i.history[n].digest, 'image-cli-versions image-cli-versions--history');
      });
    }
    const input = document.querySelector('[data-fk="img-search"]');
    if (input && !wiredSearch.has(input)) { wiredSearch.add(input); input.placeholder = '搜索别名、坐标或 CLI 版本'; input.addEventListener('input', filterByVersion); }
    const filter = document.querySelector('.segmented[aria-label="状态过滤"]');
    if (filter && !wiredFilter.has(filter)) { wiredFilter.add(filter); filter.addEventListener('click', filterByVersion); }
    filterByVersion();
  }
  // 复用搜索单选的既有 option、稳定 value 与 onPick，不改变选择和搜索规则。
  const searchSelect = P.searchSelect;
  P.searchSelect = function (config) {
    if (config.key !== 'nt-image') return searchSelect(config);
    let options = [];
    let control;
    const oldPick = config.onPick;
    const c = { ...config, onPick(o) { if (oldPick) oldPick(o); paintSelected(); } };
    control = searchSelect(c);
    function paintSelected() {
      const o = options.find(x => x.value === control.value);
      const field = config.btn.closest('.field'); if (!field) return;
      let help = field.querySelector('[data-cli-selected]');
      if (!help) { help = document.createElement('p'); help.className = 'field__help image-cli-versions__selected'; help.dataset.cliSelected = ''; field.appendChild(help); }
      help.textContent = `镜像声明：${summary(o && o.image && o.image.face.digest)}`; help.title = EXPLAIN;
    }
    const setOptions = control.setOptions, set = control.set;
    control.setOptions = function (list) {
      options = list;
      setOptions(list.map(o => ({ ...o, description: [o.description, `镜像声明：${summary(o.image && o.image.face.digest)}`].filter(Boolean).join(' · '), search: `${o.search || [o.label, o.description].filter(Boolean).join(' ')} ${summary(o.image && o.image.face.digest)}` })));
      paintSelected();
    };
    control.set = function (v) { set(v); paintSelected(); };
    return control;
  };
  const openModal = P.openModal;
  P.openModal = function (html, opts) {
    const m = openModal(html, opts);
    if (opts.kind === 'img-compare') {
      const ref = m.box.querySelector('.dialog__subtitle');
      const i = ref && P.world.images.find(x => x.ref === ref.textContent);
      const rows = m.box.querySelectorAll('.l4b-compare dd');
      if (i && rows.length >= 2) {
        replaceLine(rows[0], 'current', i.face.digest);
        replaceLine(rows[1], 'upstream', i.upstream && i.upstream.digest);
        for (const row of rows) { const note = document.createElement('span'); note.className = 'u-muted image-cli-versions__source'; note.textContent = '镜像声明'; row.appendChild(note); }
      }
    }
    if (opts.kind === 'register-image') {
      const update = () => {
        const verdict = m.box.querySelector('.p7-verdict'); if (!verdict) return;
        const input = m.box.querySelector('input');
        const i = input && P.world.images.find(x => x.ref === input.value.trim());
        if (!verdict.querySelector('[data-cli-validation-label]')) { const label = document.createElement('span'); label.dataset.cliValidationLabel = ''; label.className = 'u-muted image-cli-versions__source'; label.textContent = '镜像声明'; verdict.appendChild(label); }
        replaceLine(verdict, 'validation', i && i.face.digest);
      };
      const observer = new MutationObserver(update); observer.observe(m.box, { childList: true, subtree: true });
      const close = m.onClose; m.onClose = function (...args) { observer.disconnect(); if (close) close(...args); };
    }
    return m;
  };
  P.hook('rendered', paintCards);
  P.hook('main:refreshed', paintCards);
  P.hook('scenario', key => { if (key === 'img-cli-versions') P.render(); });
  P.hook('loaded', () => {
    if (params.get('scene') === 'cli-unknown') P.scenario.set('img-cli-versions', 'unknown');
    if (!location.hash || location.hash === '#images') P.go('images');
    paintCards();
  });
})();
