/*
 * 交互原型 · 工作台外壳（js/flows-wb.js）：项目总览（P2）、终端标签（P1）、⌘K 命令面板、快捷键一览、侧栏与顶栏的菜单（实例 / 外观 / 筛选 /
 * 范围 / 面包屑切换器 / 新建 / 新终端 / 更多操作）、树的展开 / 定位 / 筛选。
 * 第一段只把 pilot 原型里已有的这些搬过来，并让它们认得新的状态（准备中 / 可能卡住 / 停止中 / 删除中 / 无头）与新的数据（失败码、克隆进度）。
 * 第四段（L6a）接上外壳的 7 个流程：F-WB-WELCOME / BANNER / LIVE / CMDK / ROUTE / OVERVIEW / SHELL（总览筛选与本机资源卡在 fillOverview，⌘K 动作在 paletteItems，
 * 其余在文件末尾「第四段」一节）。
 */
(function () {
  'use strict';
  const P = window.P;
  const { $, $$, esc, ui, STATE } = P;
  const world = P.world;
  const T = P.TIMING;

  // ------------------------------------------------------------------ 项目总览（P2）：需要你处理、项目卡、最近任务（全部由数据算出来）
  const ovMatch = (t) => { const q = ui.ovQuery.trim().toLowerCase(); return !q || t.name.toLowerCase().includes(q) || P.proj(t.project).name.toLowerCase().includes(q); };
  const ovMatchProject = (p) => { const q = ui.ovQuery.trim().toLowerCase(); return !q || p.name.toLowerCase().includes(q) || (p.repoShort || '').toLowerCase().includes(q); };
  const chipHtml = (p) => `<span class="chip"><span class="icon i-folder" aria-hidden="true"></span>${esc(p.name)}</span>`;
  const rowMenuBtn = (t, fk) => `<button class="btn btn--tertiary btn--24 btn--icon" type="button" aria-label="${esc(t.name)} 的任务菜单" data-tip="${esc(t.name)} 的任务菜单" aria-haspopup="menu" aria-expanded="false" data-menu="task" data-task="${t.id}" data-fk="${fk}:${t.id}"><span class="icon i-ellipsis" aria-hidden="true"></span></button>`;
  function todoStatus(t) {
    if (t.state === 'error') return `<span class="list__status ${t.code === 'TIMEOUT' ? 'tone-timeout' : 'tone-error'}">${esc(t.reason)}</span>`;
    if (t.state === 'stuck') return `<span class="list__status tone-stuck">可能卡住 · ${P.liveSince(t.since)} 无进展</span>`;
    return `<span class="list__status tone-waiting">等待你输入</span>`;
  }
  function todoRow(t) {
    const p = P.proj(t.project);
    const s = STATE[t.state];
    const time = t.age != null ? `<span class="list__time">活跃于 ${esc(t.active)}</span>` : '';
    return `<li class="list__row list__row--link" data-row-task="${t.id}"><span class="list__lead"><span class="status-dot status-dot--${s.dot}" aria-hidden="true"></span></span><div class="list__main"><a class="list__title" href="#task-${t.id}" data-fk="ot:${t.id}">${esc(t.name)}</a><div class="list__meta">${todoStatus(t)}${chipHtml(p)}</div></div><div class="list__end">${time}${rowMenuBtn(t, 'om')}</div></li>`;
  }
  function recentRow(t) {
    const p = P.proj(t.project);
    const s = STATE[t.state];
    const lead = t.state === 'stopped' ? `<span class="status-dot status-dot--stopped" aria-hidden="true"></span>` : `<span class="status-dot status-dot--${s.dot}" role="img" aria-label="${s.word}"></span>`;
    const extra = t.state === 'idle' ? '<span class="list__status">空闲</span>'
      : t.state === 'stopped' ? '<span class="list__status">已停止</span>'
        : t.state === 'stopping' ? '<span class="list__status">停止中…</span>'
          : t.state === 'preparing' || t.state === 'starting' ? '<span class="list__status">准备中</span>' : '';
    const time = t.age != null ? `<span class="list__time">活跃于 ${esc(t.active)}</span>` : '';
    return `<li class="list__row list__row--link" data-row-task="${t.id}"><span class="list__lead">${lead}</span><div class="list__main"><a class="list__title" href="#task-${t.id}" data-fk="rt:${t.id}">${esc(t.name)}</a><div class="list__meta">${chipHtml(p)}${extra}</div></div><div class="list__end">${time}${rowMenuBtn(t, 'rm')}</div></li>`;
  }
  // 项目卡第一行的状态计数：异常 > 可能卡住 > 等待你输入 > 运行中（含空闲）> 准备中 > 已停止（含停止中）；删除中的不算（REQ-SBX-020）
  P.statsHtml = function statsHtml(ts) {
    const c = { error: 0, stuck: 0, waiting: 0, running: 0, preparing: 0, stopped: 0 };
    for (const t of ts) {
      const k = { idle: 'running', starting: 'preparing', stopping: 'stopped' }[t.state] || t.state;
      if (k in c) c[k]++;
    }
    const parts = [];
    if (c.error) parts.push(['error', `${c.error} 异常`]);
    if (c.stuck) parts.push(['stuck', `${c.stuck} 可能卡住`]);
    if (c.waiting) parts.push(['waiting', `${c.waiting} 等待你输入`]);
    if (c.running) parts.push(['running', `${c.running} 运行中`]);
    if (c.preparing) parts.push(['preparing', `${c.preparing} 准备中`]);
    if (c.stopped) parts.push(['stopped', `${c.stopped} 已停止`]);
    return parts.map(([d, txt]) => `<span class="entity__stat"><span class="status-dot status-dot--${d}" aria-hidden="true"></span>${txt}</span>`).join('');
  };
  function projectCard(p, shownTasks) {
    const ts = shownTasks || P.tasksOf(p.id); // 第四段（F-WB-OVERVIEW）：按状态筛选时卡上计数只写该档
    const menuBtn = `<button class="btn btn--tertiary btn--24 btn--icon" type="button" aria-label="${esc(p.name)} 的项目菜单" data-tip="${esc(p.name)} 的项目菜单" aria-haspopup="menu" aria-expanded="false" data-menu="project" data-project="${p.id}" data-fk="cm:${p.id}"><span class="icon i-ellipsis" aria-hidden="true"></span></button>`;
    let end = menuBtn, line1, line2;
    if (p.status === 'failed' || p.status === 'cloning') {
      // 克隆失败 / 克隆中：两行由项目流程给（失败码的说明与出口、实时进度；REQ-PRJ-010 / 012）
      end = P.projectBadge(p, 24) + menuBtn;
      [line1, line2] = P.projectCardLines(p);
    } else {
      line1 = ts.length
        ? `<p class="entity__line entity__line--lead entity__stats">${P.statsHtml(ts)}</p>`
        : `<p class="entity__line entity__line--lead entity__line--indent entity__actions"><span>还没有任务</span><a class="link" href="#" title="在 ${esc(p.name)} 中发起第一个任务"${blockedAttrs(p)} data-action="new-task" data-project="${p.id}" data-fk="cn:${p.id}">发起第一个任务<span class="icon i-arrow-right" aria-hidden="true"></span></a></p>`;
      line2 = p.source === 'empty'
        ? `<p class="entity__line" title="空项目（没有关联仓库） · 创建于 ${esc(p.createdAt)}"><span class="icon i-info" aria-hidden="true"></span><span class="entity__text">空项目 · 创建于 ${esc(p.createdAt.split(' ')[0])}</span></p>`
        : `<p class="entity__line" title="分支 ${esc(p.branch || '远端默认分支')} · 代码体积 ${esc(p.size)} · 最后拉取 ${esc(p.pulledFull || p.pulled)}"><span class="icon i-git-branch" aria-hidden="true"></span><span class="entity__text">${esc(p.branch || '远端默认分支')} · ${esc(p.size)} · 最后拉取 ${esc(p.pulledShort)}</span></p>`;
    }
    const sub = p.source === 'empty' ? '空项目' : p.repoShort;
    return `<article class="card card--interactive card--entity" aria-labelledby="pc-${p.id}" data-card-project="${p.id}"><div class="card__body"><div class="entity__head"><span class="avatar" aria-hidden="true">${esc(p.avatar)}</span><div class="entity__id"><h3 class="entity__name" id="pc-${p.id}"><a href="${P.projectHref(p)}" data-fk="cl:${p.id}">${esc(p.name)}</a></h3><span class="entity__sub" title="${esc(p.source === 'empty' ? '空项目（没有关联仓库）' : p.repo)}">${esc(sub)}</span></div><div class="entity__end">${end}</div></div>${line1}${line2}</div></article>`;
  }
  function fillOverview(host) {
    const q = ui.ovQuery.trim();
    const slot = (name) => $(`[data-slot="${name}"]`, host);
    // 第四段（F-WB-OVERVIEW，REQ-WB-050 / Q-DS-30 A）：总览的「按状态筛选」与左侧树共用 ui.filter——筛的是任务：两张列表只留该档的任务，
    // 项目卡只留有该档任务的项目、卡上计数只写该档，分区标题行右侧「按筛选显示 n 个 / 共 m 个」；搜索与筛选取交集；本机资源卡不受影响
    const filt = ui.filter;
    const fOK = (t) => filt === 'all' || P.matchesFilter(t);
    const label = P.filterLabel(filt);
    const filteredEmpty = (txt) => `<div class="empty empty--card" role="status"><p class="empty__title">${esc(txt)}</p></div>`; // 筛空一句（f-wb-overview-01）
    const allTodo = P.todoTasks();
    const todo = allTodo.filter(ovMatch).filter(fOK);
    // F15①：搜索时计数写成「匹配数 / 总数」，不再出现「徽标 3、列表说没有匹配」；筛选时只写该档的条数
    const set = (el, html) => { if (el && el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; } };
    set(slot('todo-count'), !allTodo.length ? ''
      : q ? `<span class="badge badge--20 badge--neutral" aria-hidden="true">${todo.length} / ${allTodo.length}</span><span class="u-sr-only">匹配 ${todo.length} 项，共 ${allTodo.length} 项</span>`
        : `<span class="badge badge--20 badge--neutral" aria-hidden="true">${todo.length}</span><span class="u-sr-only">${todo.length} 项</span>`);
    if (todo.length) set(slot('todo'), `<ul class="list list--two-line">${todo.map(todoRow).join('')}</ul>`);
    else if (q) set(slot('todo'), `<div class="empty empty--card"><p class="empty__desc">没有找到匹配“${esc(q)}”的任务</p></div>`);
    else if (filt !== 'all') set(slot('todo'), filteredEmpty(`没有${label}的任务`));
    else set(slot('todo'), `<div class="empty empty--card"><p class="empty__title">现在没有要你处理的任务</p><p class="empty__desc">有任务在等你输入、或者出了异常时，会列在这里。</p></div>`);
    const cards = world.projects.filter(ovMatchProject).map((p) => [p, filt === 'all' ? null : P.tasksOf(p.id).filter((t) => fOK(t) && ovMatch(t))]).filter(([, ts]) => !ts || ts.length);
    // 一个项目都没有（初始化向导刚完成的新实例）：主区是欢迎态（F-WB-WELCOME），这里不会画到
    set(slot('cards'), cards.length ? cards.map(([p, ts]) => projectCard(p, ts)).join('') : q ? `<p class="page-desc">没有找到匹配“${esc(q)}”的项目</p>` : filt !== 'all' ? filteredEmpty(`没有${label}的任务`) : '');
    const meta = slot('cards-meta');
    if (meta) { meta.hidden = filt === 'all'; const mt = filt === 'all' ? '' : `按筛选显示 ${cards.length} 个 / 共 ${world.projects.length} 个`; if (meta.textContent !== mt) meta.textContent = mt; }
    const todoSet = new Set(allTodo);
    const recent = filt === 'all' ? P.recentTasks().filter(ovMatch)
      : world.tasks.filter((t) => !todoSet.has(t) && t.state !== 'destroying' && fOK(t) && ovMatch(t)).sort(P.sortByRecency).slice(0, 4);
    // F15②：一个任务都没有时不说「别的」；筛空时「需要你处理」收的两档（等待输入、异常）说清去哪看（两张列表不重复列同一个任务）
    if (recent.length) set(slot('recent'), `<ul class="list list--two-line">${recent.map(recentRow).join('')}</ul>`);
    else if (filt !== 'all' && !q) set(slot('recent'), filteredEmpty(filt === 'waiting' || filt === 'error' ? `${label}的任务都列在「需要你处理」里` : `没有${label}的任务`));
    else set(slot('recent'), `<div class="empty empty--card"><p class="empty__desc">${q ? `没有找到匹配“${esc(q)}”的任务` : world.tasks.length ? '还没有别的任务' : '还没有任务'}</p></div>`);
    const search = $('[data-ov-search]', host);
    if (search && search.value !== ui.ovQuery) search.value = ui.ovQuery;
    // 工具行：筛选按钮说当前档；已选筛选的 chip 紧跟在按钮后面（与树那边的 chip 同一份筛选，读屏名「移除筛选：<档名>」）
    const fb = $('[data-fk="ov-filter"]', host);
    if (fb) {
      fb.dataset.tip = `按状态筛选：${label}`;
      let chip = $('[data-ov-chip]', host);
      if (filt === 'all') { if (chip) chip.remove(); }
      else {
        const html = `<span class="chip chip--removable" data-ov-chip>${esc(label)}<button class="chip__remove" type="button" aria-label="移除筛选：${esc(label)}" data-tip="移除筛选" data-action="clear-filter" data-fk="ov-filter-chip"><span class="icon i-x" aria-hidden="true"></span></button></span>`;
        if (!chip || chip.dataset.html !== html) { const n = frag(html); n.dataset.html = html; if (chip) chip.replaceWith(n); else fb.after(n); }
      }
    }
    paintUsage(slot('usage'));
  }
  // 「本机资源」卡（P2）：与系统状态同一份读数（P.sysResources()，一台机器一份）；越过阈值才上色（徽标 + 色条，f-wb-banner-03）
  const fmtN = (n) => { const r = Math.round(n * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); };
  function paintUsage(card) {
    if (!card || !P.sysResources) return;
    const R = P.sysResources();
    const BADGE = { warn: '<span class="badge badge--20 badge--warn"><span class="icon i-triangle-alert" aria-hidden="true"></span>警告</span>', critical: '<span class="badge badge--20 badge--fail"><span class="icon i-x" aria-hidden="true"></span>严重</span>' };
    const row = (name, value, g, extra) => `<li class="usage__item"${extra || ''}><div class="usage__row"><span class="usage__name">${name}</span>${BADGE[g.level] || ''}<span class="usage__value">${value}</span></div><span class="meter" role="progressbar" aria-label="${name} 使用率" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(g.pct)}"><span class="meter__bar${g.level === 'warn' ? ' meter__bar--warn' : g.level === 'critical' ? ' meter__bar--fail' : ''}" style="width: ${fmtN(g.pct)}%"></span></span></li>`;
    const html = `<div class="card__body"><div class="card__head"><p class="kpi"><span>还能再发</span><span class="kpi__value">${R.cap.remaining}</span><span>个任务</span></p><span class="contract-note" title="待契约（DR-08）：这个数要由后端按准入规则给（capacity.remainingTasks），前端不自己算；契约定下来之前，这张卡先不上线（Q-DS-28 推荐）">待契约 · DR-08</span></div><p class="card__desc card__desc--zh">按配额登记计算，含已停止的任务。<br>下面的实时占用率只作参考。</p><ul class="usage">`
      + row('CPU', `${fmtN(R.cpu.used)} / ${R.cpu.total} 核（${fmtN(R.cpu.pct)}%）`, R.cpu)
      + row('内存', `${fmtN(R.ram.used)} / ${R.ram.total} GB（${fmtN(R.ram.pct)}%）`, R.ram)
      + row('磁盘', `${fmtN(R.disk.used)} / ${R.disk.total} GB（${fmtN(R.disk.pct)}%）`, R.disk, ' title="数据目录 /srv/agent-platform/data"')
      + '</ul></div>';
    if (card.dataset.html !== html) { card.innerHTML = html; card.dataset.html = html; }
  }
  const frag = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; };
  // 不能发起任务的原因（离线等）：入口只置灰、不隐藏，按下 / 聚焦时说原因（REQ-WB-014）
  function blockedAttrs(p) { const why = P.newTaskBlocked(p); return why ? ` aria-disabled="true" data-reason="${esc(why)}"` : ''; }
  P.views['tpl-overview'] = { refresh: (host) => fillOverview(host) };
  // P2 总览：卡片 / 行的空白处 = 点它的标题链接
  P.hook('click', (t) => {
    const row = t.closest('[data-row-task]');
    if (row && !t.closest('a, button')) { P.go(`task-${row.dataset.rowTask}`); return true; }
    const card = t.closest('[data-card-project]');
    if (card && !t.closest('a, button')) { P.enterProject(card.dataset.cardProject); return true; }
    return undefined;
  });
  // P2 搜索框：输入即过滤三块；「/」聚焦（焦点在输入框或终端里时不抢）
  document.addEventListener('input', (e) => {
    if (e.target.matches && e.target.matches('[data-ov-search]')) { ui.ovQuery = e.target.value; P.refreshMain(); }
  });
  P.hook('keydown', (e, { inTerm }) => {
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !P.isEditable(e.target) && !P.modals.length && !P.menu.el && ui.route.view === 'overview' && !ui.loading && !inTerm) {
      const s = $('[data-ov-search]');
      if (s) { e.preventDefault(); s.focus(); }
    }
  });

  // ------------------------------------------------------------------ 终端：标签（Agent / 终端 1 / 新开的）与面板
  P.TERM_STATES = new Set(['waiting', 'running', 'idle', 'stopping']);
  P.mainTpl.push((r) => {
    if (r.view !== 'task') return undefined;
    const t = P.task(r.taskId);
    return t && !t.headless && P.TERM_STATES.has(t.state) ? 'tpl-task-term' : undefined;
  });
  function tabsState(t) {
    if (!ui.tabs[t.id]) {
      const list = [{ id: `${t.id}-agent`, kind: 'agent', label: 'Agent', tpl: t.term, html: t.termHtml }];
      (t.extraTabs || []).forEach((x, i) => list.push({ id: `${t.id}-u${i + 1}`, kind: x.kind, label: x.label, tpl: x.tpl }));
      ui.tabs[t.id] = { list, active: list[0].id, seq: list.length - 1 };
    }
    return ui.tabs[t.id];
  }
  P.tabsState = tabsState;
  const PROMPT = {
    agent: '<span class="ansi-cyan">›</span> <span class="term__cursor"> </span>',
    codex: '<span class="ansi-cyan">›</span> <span class="term__cursor"> </span>',
    claude: '<span class="ansi-dim">&gt;</span> <span class="term__cursor"> </span>',
    shell: '<span class="ansi-green">/workspace</span> <span class="ansi-dim">$</span> <span class="term__cursor"> </span>',
  };
  function tabContent(t, tab) {
    if (ui.cleared[tab.id]) return PROMPT[tab.kind];
    if (tab.html) return tab.html;
    return $(`#${tab.tpl}`).innerHTML.replace(/<!--[\s\S]*?-->/g, '');
  }
  P.termTemplate = (id) => $(`#${id}`).innerHTML.replace(/<!--[\s\S]*?-->/g, '');
  function termStyle() {
    if (ui.termFont === 14) return '';
    return ` style="--term-font-size: ${ui.termFont}px; --term-line-height: ${Math.round(ui.termFont * 9 / 7)}px"`;
  }
  function renderTerm(host, t) {
    const st = tabsState(t);
    const tabsHost = $('[data-slot="tabs"]', host);
    const tabsHtml = st.list.map((tab) => {
      const sel = tab.id === st.active;
      const icon = tab.kind === 'agent' ? 'i-bot' : 'i-terminal';
      const close = tab.kind === 'agent' ? '' : `<button class="ttab__close" type="button" aria-label="关闭 ${esc(tab.label)}" data-tip="关闭 ${esc(tab.label)}" data-action="close-tab" data-tab="${tab.id}" data-fk="tc:${tab.id}"><span class="icon i-x" aria-hidden="true"></span></button>`;
      return `<div class="ttab"><button class="ttab__main" type="button" role="tab" id="tab-${tab.id}" aria-selected="${sel}" aria-controls="term-${tab.id}" tabindex="${sel ? 0 : -1}" data-action="select-tab" data-tab="${tab.id}" data-fk="tb:${tab.id}"><span class="icon ${icon}" aria-hidden="true"></span>${esc(tab.label)}</button>${close}</div>`;
    }).join('');
    const stopping = t.state === 'stopping';
    const panelsHtml = st.list.map((tab) => {
      const sel = tab.id === st.active;
      let content = tabContent(t, tab);
      if (stopping) content = content.replace(/ ?<span class="term__cursor"> <\/span>/g, ''); // 停止中：终端停在最后一屏、不接收输入（REQ-SBX-011）
      return `<div class="term" role="tabpanel" id="term-${tab.id}" aria-labelledby="tab-${tab.id}" tabindex="0"${termStyle()}${sel ? '' : ' hidden'}><pre class="term__screen">${content}</pre></div>`;
    }).join('');
    if (tabsHost.dataset.html !== tabsHtml) { tabsHost.innerHTML = tabsHtml; tabsHost.dataset.html = tabsHtml; }
    const panels = $('[data-slot="panels"]', host);
    if (panels.dataset.html !== panelsHtml) { panels.innerHTML = panelsHtml; panels.dataset.html = panelsHtml; }
    syncFontButtons(host);
    updateTabFades(tabsHost);
    P.emit('term:rendered', host, t);
  }
  P.renderTerm = renderTerm;
  // F10：选中的标签总在可见范围里（标签多 / 窄屏时 tablist 横向滚动，滚动条是隐藏的）；两端有内容时渐隐，滚轮可横向滚
  function revealActiveTab() {
    const b = $('#shell-main [role="tab"][aria-selected="true"]');
    if (!b) return;
    const list = b.closest('.termbar__tabs');
    const tab = b.closest('.ttab') || b;
    const lr = list.getBoundingClientRect(), tr = tab.getBoundingClientRect();
    const pad = list.scrollWidth > list.clientWidth ? 24 : 0; // 让开两端的渐隐
    if (tr.left < lr.left + pad) list.scrollLeft -= (lr.left + pad) - tr.left;
    else if (tr.right > lr.right - pad) list.scrollLeft += tr.right - (lr.right - pad);
    updateTabFades(list);
  }
  function updateTabFades(list) {
    if (!list) return;
    const max = list.scrollWidth - list.clientWidth;
    const l = max > 1 && list.scrollLeft > 1, r = max > 1 && list.scrollLeft < max - 1;
    const v = (l ? 'l' : '') + (r ? 'r' : '');
    if (v) list.setAttribute('data-fade', v); else list.removeAttribute('data-fade');
  }
  function wireTermbar(main) {
    const list = $('.termbar__tabs', main);
    if (!list) return;
    list.addEventListener('scroll', () => updateTabFades(list), { passive: true });
    list.addEventListener('wheel', (e) => {
      if (list.scrollWidth <= list.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      list.scrollLeft += e.deltaY;
      e.preventDefault();
    }, { passive: false });
  }
  P.views['tpl-task-term'] = {
    wire: (main) => wireTermbar(main),
    refresh: (host, r) => { const t = P.task(r.taskId); if (t) renderTerm(host, t); },
  };
  P.hook('resize', () => updateTabFades($('#shell-main .termbar__tabs')));
  P.currentTermTask = function currentTermTask() { const t = P.currentTask(); return t && !t.headless && (t.state === 'waiting' || t.state === 'running' || t.state === 'idle') ? t : null; };
  function selectTab(tabId, focus) {
    const t = P.currentTask(); if (!t || !P.TERM_STATES.has(t.state) || t.headless) return;
    const st = tabsState(t);
    if (!st.list.some((x) => x.id === tabId)) return;
    st.active = tabId;
    renderTerm($('#shell-main'), t);
    if (focus) { const b = $(`#tab-${CSS.escape(tabId)}`); if (b) b.focus({ preventScroll: true }); }
    revealActiveTab();
  }
  function addTab(kind) {
    const t = P.currentTermTask(); if (!t) return;
    const st = tabsState(t);
    st.seq += 1; // 用户标签的序号只增不减（v1 shellTabLabel）
    const name = kind === 'codex' ? 'Codex' : kind === 'claude' ? 'Claude Code' : '终端';
    const tpl = kind === 'codex' ? 'term-new-codex' : kind === 'claude' ? 'term-new-claude' : 'term-new-shell';
    const tab = { id: `${t.id}-n${st.seq}`, kind, label: `${name} ${st.seq}`, tpl };
    st.list.push(tab);
    st.active = tab.id;
    renderTerm($('#shell-main'), t);
    const b = $(`#tab-${CSS.escape(tab.id)}`); if (b) b.focus({ preventScroll: true });
    revealActiveTab();
    P.announce(`已新开 ${tab.label}`);
  }
  function closeTab(tabId) {
    const t = P.currentTask(); if (!t || !ui.tabs[t.id]) return;
    const st = tabsState(t);
    const i = st.list.findIndex((x) => x.id === tabId);
    if (i < 1) return; // Agent 标签没有关闭（关掉它不会停下任务）
    const [gone] = st.list.splice(i, 1);
    delete ui.cleared[tabId];
    if (st.active === tabId) st.active = st.list[Math.max(0, i - 1)].id;
    renderTerm($('#shell-main'), t);
    const b = $(`#tab-${CSS.escape(st.active)}`); if (b) b.focus({ preventScroll: true });
    revealActiveTab();
    P.announce(`已关闭 ${gone.label}`);
  }
  function clearTerm(from) {
    const t = P.currentTermTask();
    if (!t) { if (from) P.hint(from, '当前没有终端'); return; }
    const st = tabsState(t);
    ui.cleared[st.active] = true;
    renderTerm($('#shell-main'), t);
    P.announce('已清屏');
  }
  P.clearTerm = clearTerm;
  const FONT_MIN = 12, FONT_MAX = 20;
  // F15③：字号到头时 A− / A+ 不可用并说原因（还能聚焦，点了在旁边说明）
  function syncFontButtons(host) {
    for (const [act, lim, reason] of [['font-down', FONT_MIN, `已经是最小字号（${FONT_MIN}px）`], ['font-up', FONT_MAX, `已经是最大字号（${FONT_MAX}px）`]]) {
      const b = $(`[data-action="${act}"]`, host || document);
      if (!b) continue;
      if (ui.termFont === lim) { b.setAttribute('aria-disabled', 'true'); b.dataset.reason = reason; }
      else { b.removeAttribute('aria-disabled'); delete b.dataset.reason; }
    }
  }
  function setFont(delta) {
    const next = Math.max(FONT_MIN, Math.min(FONT_MAX, ui.termFont + delta));
    if (next === ui.termFont) return;
    ui.termFont = next;
    for (const el of $$('#shell-main .term')) {
      if (next === 14) el.removeAttribute('style');
      else { el.style.setProperty('--term-font-size', `${next}px`); el.style.setProperty('--term-line-height', `${Math.round(next * 9 / 7)}px`); }
    }
    const panels = $('#shell-main [data-slot="panels"]'); if (panels) delete panels.dataset.html;
    syncFontButtons();
    P.announce(`终端字号 ${next}px`);
  }
  P.sessionCount = (t) => tabsState(t).list.length;
  Object.assign(P.actions, {
    'select-tab': (a) => selectTab(a.dataset.tab, true),
    'close-tab': (a) => closeTab(a.dataset.tab),
    clear: (a) => clearTerm(a),
    'font-down': () => setFont(-1),
    'font-up': () => setFont(1),
  });
  // 终端标签（tablist）：← → Home End 切换并选中；Delete 关闭可关的标签
  P.hook('keydown:bubble', (e) => {
    const tab = e.target instanceof Element && e.target.closest('#shell-main [role="tab"]');
    if (!tab || !tab.dataset.tab) return; // 只管终端标签（凭证页登录面板的方式标签由 flows-crd.js 自己处理）
    const tabs = $$('[role="tab"]', tab.closest('[role="tablist"]'));
    const i = tabs.indexOf(tab);
    let next = null;
    if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === 'Home') next = tabs[0];
    else if (e.key === 'End') next = tabs[tabs.length - 1];
    else if (e.key === 'Delete' && i > 0) { e.preventDefault(); closeTab(tab.dataset.tab); return; }
    if (next) { e.preventDefault(); selectTab(next.dataset.tab, true); }
  });

  // ------------------------------------------------------------------ 树：展开 / 收起、定位、筛选
  P.setFilter = function setFilter(k) {
    ui.filter = k;
    P.render();
    P.announce(k === 'all' ? '显示全部任务' : `只看${P.filterLabel(k)}的任务`);
  };
  P.locateProject = function locateProject(pid) {
    if (!pid) return;
    // F11：图标轨里定位 = 临时展开侧栏（不改你记住的收起偏好），并播报
    if (ui.rail && !P.MQ_NARROW.matches) P.setRail(false, { persist: false });
    if (ui.filter !== 'all') ui.filter = 'all';
    ui.expanded[pid] = true;
    P.render();
    const b = $(`[data-fk="ps:${pid}"]`);
    if (b) { b.scrollIntoView({ block: 'nearest' }); b.focus({ preventScroll: true }); }
  };
  function toggleProject(pid) { ui.expanded[pid] = !ui.expanded[pid]; P.render(); }
  Object.assign(P.actions, {
    'toggle-project': (a) => toggleProject(a.dataset.project),
    'select-project': (a) => { const pid = a.dataset.project; if (P.tasksOf(pid).length) toggleProject(pid); else P.goFromTree(`project-${pid}`); },
    // chip 在哪一处被移除，焦点就回哪一处的筛选按钮（总览工具行 / 侧栏「项目」分区；两处是同一份筛选，REQ-WB-050）
    'clear-filter': (a) => { const inMain = !!a.closest('#shell-main'); P.setFilter('all'); const f = $(inMain ? '[data-fk="ov-filter"]' : '[data-fk="filter"]'); if (f) f.focus(); },
    palette: (a) => P.togglePalette(a),
    shortcuts: (a) => openShortcuts(a),
  });

  // ------------------------------------------------------------------ 菜单：实例 / 外观 / 筛选 / 范围 / 面包屑 / 新建 / 新终端 / 更多操作
  const { menuItem, SEP } = P;
  function projectRadios(currentId, withAll) {
    let html = '';
    if (withAll) html += menuItem({ label: '全部项目', radio: true, checked: !currentId, act: () => P.go('overview') }) + SEP;
    html += P.menuGroup('切换项目', world.projects.map((p) => menuItem({
      label: p.name, radio: true, checked: p.id === currentId,
      end: p.status === 'failed' ? '克隆失败' : p.status === 'cloning' ? '克隆中' : `${P.tasksOf(p.id).length} 个任务`,
      act: () => P.enterProject(p.id),
    })).join(''));
    return html;
  }
  const headerNarrow = () => { const h = $('#shell-main .header'); return h && h.clientWidth < 800; };
  Object.assign(P.menus, {
    instance: () => ({
      label: '实例菜单', align: 'start',
      html: menuItem({ label: '系统状态', icon: 'i-activity', act: () => P.go('system') }) + SEP
        + P.menuGroup('外观', P.THEMES.map(([k, name]) => menuItem({ label: name, radio: true, checked: ui.theme === k, act: () => P.setTheme(k) })).join('')) + SEP
        + menuItem({ label: '快捷键', icon: 'i-keyboard', act: (ret) => openShortcuts(ret) })
        // 第四段（F-WB-SHELL，Q-DS-34 默认 A / REQ-WB-060）：不放「文档」——没有可指向的现成文档地址，离线部署也打不开外链
        + P.collect('instance.items').join(''), // 各流程补充的项（第三段：flows-dep.js 的「演示初始化向导…」，原型专用）
    }),
    appearance: () => ({ label: '外观', align: 'start', html: P.THEMES.map(([k, name, icon]) => menuItem({ label: name, icon, radio: true, checked: ui.theme === k, act: () => P.setTheme(k) })).join('') }),
    filter: () => ({ label: '按状态筛选任务', align: 'start', html: P.FILTERS.map(([k, name]) => menuItem({ label: name, radio: true, checked: ui.filter === k, act: () => P.setFilter(k) })).join('') }),
    scope: () => ({ label: '切换项目', align: 'start', html: projectRadios(null, true) }),
    'crumb-project': () => {
      const cur = P.currentProjectId();
      // F11：窄屏（< 640）没有任务树——不放「在左侧树中定位当前项目」
      const locate = P.MQ_NARROW.matches ? '' : menuItem({ label: '在左侧树中定位当前项目', icon: 'i-folder-open', act: () => P.locateProject(cur) }) + SEP;
      return { label: '切换项目', align: 'start', html: locate + projectRadios(cur, false) };
    },
    'crumb-task': () => {
      const t = P.currentTask(); if (!t) return null;
      return { label: '切换任务', align: 'start', html: P.menuGroup('切换任务', P.tasksOf(t.project).filter((x) => x.state !== 'destroying').map((x) => menuItem({ label: x.name, radio: true, checked: x.id === t.id, end: STATE[x.state].word, act: () => P.go(`task-${x.id}`) })).join('')) };
    },
    more: () => {
      const t = P.currentTask();
      if (t) return { label: '更多操作', align: 'end', html: P.taskMenuItems(t, headerNarrow()) };
      const p = P.proj(P.currentProjectId());
      return p ? { label: '更多操作', align: 'end', html: P.projectMenuItems(p, headerNarrow()) } : null;
    },
    create: () => ({
      label: '新建', align: 'end',
      // 离线时「新任务…」置灰并说原因（REQ-WB-014：总览「新建 ⌄」里的那一项也算发起入口）
      html: menuItem({ label: '新任务…', icon: 'i-square-terminal', disabled: !!newTaskReason(), reason: newTaskReason(), act: (ret) => P.openNewTask(null, ret) })
        + menuItem({ label: '新建项目…', icon: 'i-folder-plus', act: (ret) => P.openNewProject({}, ret) }),
    }),
    newterm: () => ({
      label: '新终端', align: 'start',
      html: menuItem({ label: 'Codex', icon: 'i-bot', act: () => addTab('codex') }) + menuItem({ label: 'Claude Code', icon: 'i-bot', act: () => addTab('claude') }) + menuItem({ label: '终端', icon: 'i-terminal', act: () => addTab('shell') }),
    }),
  });

  // ------------------------------------------------------------------ 快捷键一览（含「重播首屏加载」）
  const kbd = (...keys) => `<span class="kbd-group">${keys.map((k) => `<span class="kbd kbd--24">${esc(k)}</span>`).join('')}</span>`;
  const keyAlt = (txt) => `<span class="proto-keys__alt">${esc(txt)}</span>`;
  function openShortcuts(returnTo) {
    const html = `<div class="dialog dialog--576" role="dialog" aria-modal="true" aria-labelledby="sc-title" data-dialog="shortcuts"><div class="dialog__header"><h2 class="dialog__title" id="sc-title">快捷键</h2><p class="dialog__subtitle">终端优先：焦点在终端里时，只有 ⌘ 组合（以及 Ctrl Shift K）归平台</p></div><div class="dialog__body">
<dl class="proto-keys">
<dt>打开命令面板（查找任务、项目与动作）</dt><dd>${kbd('⌘', 'K')}${keyAlt('macOS')}${kbd('Ctrl', 'K')}${keyAlt('终端外')}${kbd('Ctrl', 'Shift', 'K')}${keyAlt('终端里')}</dd>
<dt>收起 / 展开侧栏</dt><dd>${kbd('⌘', 'B')}${keyAlt('macOS')}${kbd('Ctrl', 'B')}${keyAlt('终端外')}</dd>
<dt>关闭最上层的浮层（菜单、浮层卡、对话框、命令面板）</dt><dd>${kbd('Esc')}</dd>
<dt>在菜单、命令面板里上下移动 · 执行</dt><dd>${kbd('↑', '↓')}${kbd('Enter')}</dd>
<dt>在终端标签之间切换（焦点在标签上时）</dt><dd>${kbd('←', '→')}</dd>
<dt>聚焦项目总览的搜索框</dt><dd>${kbd('/')}</dd>
</dl>
<p class="proto-dlg__lead">终端有焦点时只有 ⌘ 组合（以及 Linux / Windows 的 Ctrl Shift K）归平台，其余按键都交给终端：Ctrl K（readline 删到行尾）、Ctrl B（tmux 前缀、左移一字）都到得了终端；macOS 上 Ctrl 组合一律不截。Esc 只关最上层浮层，没有浮层时交给终端（Codex 会提示「esc to cancel」）。macOS 上 ⌘K 在 iTerm 里是清屏，所以命令面板里放了一条「清屏」。原型里的终端是静态文本：点一下终端画布再按 Ctrl K / Ctrl B，可以看到平台不接这两个键。</p>
</div><div class="dialog__footer"><button class="btn btn--secondary btn--32" type="button" data-dlg="cancel">关闭</button><div class="dialog__footer-end"><button class="btn btn--secondary btn--32" type="button" data-dlg="replay"><span class="icon i-rotate-ccw" aria-hidden="true"></span>重播首屏加载</button></div></div><button class="btn btn--tertiary btn--28 btn--icon dialog__close" type="button" aria-label="关闭" data-dlg="cancel"><span class="icon i-x" aria-hidden="true"></span></button></div>`;
    const m = P.openModal(html, { kind: 'shortcuts', returnTo });
    m.box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dlg]'); if (!b) return;
      P.closeModal(m);
      if (b.dataset.dlg === 'replay') P.startLoading();
    });
  }
  P.openShortcuts = openShortcuts;

  // ------------------------------------------------------------------ 命令面板（⌘K）：输入即过滤；需要你处理 / 任务 / 项目 / 前往 / 动作；↑↓ 选择、Enter 执行、Esc 关闭；不放破坏性动作
  // PF-03：密度照 Geist Command Menu（输入 18/28、行 36、分组标题 13 次要灰 36 高、上距 15%），去掉放大镜、底部按键条与「↵」
  const GROUPS = ['需要你处理', '任务', '项目', '前往', '动作'];
  function taskMeta(t) {
    const pn = P.proj(t.project).name;
    if (t.state === 'error') return `${pn} · ${t.reason}`;
    if (t.state === 'stuck') return `${pn} · 可能卡住`;
    if (t.state === 'preparing' || t.state === 'starting') return `${pn} · 准备中 · ${P.PHASES[P.PHASE_OF[t.status] || 0]}`;
    return `${pn} · ${STATE[t.state].word}${t.state === 'idle' ? ' · 空闲' : ''}`;
  }
  function paletteItems() {
    const items = [];
    const todo = P.todoTasks();
    const dot = (t) => `<span class="status-dot status-dot--${STATE[t.state].dot}" aria-hidden="true"></span>`;
    const icon = (name) => `<span class="icon ${name}" aria-hidden="true"></span>`;
    for (const t of todo) items.push({ g: '需要你处理', label: t.name, meta: t.state === 'waiting' ? `${P.proj(t.project).name} · 等待你输入` : taskMeta(t), icon: dot(t), run: () => P.go(`task-${t.id}`) });
    for (const t of world.tasks.filter((x) => !todo.includes(x) && x.state !== 'destroying')) items.push({ g: '任务', label: t.name, meta: taskMeta(t), icon: dot(t), run: () => P.go(`task-${t.id}`) });
    for (const p of world.projects) {
      const n = P.tasksOf(p.id).length;
      // 克隆进度与主区进度块、总览卡同一个来源（P.cloneView：按克隆引擎现算；进度未知时不写百分比）
      const pct = p.status === 'cloning' && p.clone && P.cloneView ? P.cloneView(p).pct : null;
      const meta = p.status === 'failed' ? '克隆失败' : p.status === 'cloning' ? (pct != null ? `克隆中 ${pct}%` : '克隆中') : n ? `${n} 个任务` : '还没有任务';
      items.push({ g: '项目', label: p.name, meta, icon: icon('i-folder'), run: () => P.enterProject(p.id) });
    }
    items.push({ g: '前往', label: '项目总览', meta: '任务', icon: icon('i-square-terminal'), run: () => P.go('overview') });
    items.push({ g: '前往', label: '凭证管理', icon: icon('i-key-round'), run: () => P.go('credentials') });
    items.push({ g: '前往', label: '镜像管理', icon: icon('i-package'), run: () => P.go('images') });
    items.push({ g: '前往', label: '系统状态', icon: icon('i-activity'), run: () => P.go('system') });
    // 第四段（F-WB-CMDK，REQ-WB-031 / 032）：「新任务…」带同义词；离线 / 一个项目都没有时禁用、说明写原因（回车不执行）
    const ntWhy = newTaskReason();
    items.push({ g: '动作', label: '新任务…', keywords: '新建任务 发起任务', meta: ntWhy || undefined, disabled: !!ntWhy, icon: icon('i-plus'), run: (ret) => P.openNewTask(P.currentProjectId(), ret) });
    for (const it of P.collect('palette.items')) items.push(it); // 各流程补充的动作：新建项目…（flows-prj）、注册新镜像…（flows-img）、运行诊断（flows-sys）
    // 项目级两项：在某个项目里只各一条、说明写项目名；没有当前项目时逐项目列出——规则只列就绪的项目（说明写条数），成果只列有成果的项目（说明写份数）
    const cur = P.currentProjectId();
    const cp = cur && P.proj(cur);
    if (cp) {
      if (P.openAutomations) items.push({ g: '动作', label: '自动化规则…', meta: cp.name, keywords: '自动化 定时 规则', icon: icon('i-settings'), run: (ret) => P.openAutomations(cp.id, ret) });
      items.push({ g: '动作', label: '保留下来的成果…', meta: cp.name, keywords: '成果 保留 下载', icon: icon('i-gift'), run: (ret) => P.openRetained(cp.id, ret) });
    } else {
      if (P.openAutomations) for (const p of world.projects.filter(P.isReady)) { const n = P.automationsOf(p.id).length; items.push({ g: '动作', label: `自动化规则 · ${p.name}`, meta: n ? `${n} 条` : '还没有规则', keywords: '自动化 定时 规则', icon: icon('i-settings'), run: (ret) => P.openAutomations(p.id, ret) }); }
      for (const p of world.projects) { const n = P.retainedOf(p.id).length; if (n) items.push({ g: '动作', label: `保留下来的成果 · ${p.name}`, meta: `${n} 份`, keywords: '成果 保留 下载', icon: icon('i-gift'), run: (ret) => P.openRetained(p.id, ret) }); }
    }
    // F15④：主题动作只给「会变的那一个」（切到亮色 / 切到暗色）；「跟随系统」另列一条，不再三态循环出现一步看不出变化
    const eff = P.effectiveTheme();
    items.push({ g: '动作', label: eff === 'dark' ? '切到亮色' : '切到暗色', keywords: '切换主题 外观 主题', meta: `现在：${P.themeName(ui.theme)}${ui.theme === 'system' ? `（${eff === 'dark' ? '暗色' : '亮色'}）` : ''}`, icon: icon(eff === 'dark' ? 'i-sun' : 'i-moon'), run: () => P.setTheme(eff === 'dark' ? 'light' : 'dark') });
    if (ui.theme !== 'system') items.push({ g: '动作', label: '外观跟随系统', keywords: '切换主题 外观 主题', icon: icon('i-monitor'), run: () => P.setTheme('system') });
    const railNow = ui.rail || P.MQ_NARROW.matches;
    items.push({ g: '动作', label: railNow ? '展开侧栏' : '收起侧栏', kbd: P.KBD_RAIL, icon: icon(railNow ? 'i-panel-left-open' : 'i-panel-left-close'), run: (ret) => P.toggleRail(ret) });
    const hasTerm = !!P.currentTermTask();
    items.push({ g: '动作', label: '清屏', meta: hasTerm ? '当前终端' : '当前没有终端', disabled: !hasTerm, icon: icon('i-eraser'), run: (ret) => clearTerm(ret) });
    return items;
  }
  function openPalette(returnTo) {
    const html = `<div class="proto-cmd" role="dialog" aria-modal="true" aria-label="命令面板" data-dialog="palette">
<div class="proto-cmd__search"><input class="proto-cmd__input" type="text" role="combobox" aria-expanded="true" aria-controls="proto-cmd-list" aria-autocomplete="list" aria-label="查找任务、项目与动作" placeholder="查找任务、项目与动作…" autocomplete="off" spellcheck="false"><span class="kbd" aria-hidden="true">Esc</span></div>
<div class="proto-cmd__list" id="proto-cmd-list" role="listbox" aria-label="查找结果"></div>
<p class="proto-cmd__empty" role="status" hidden></p>
</div>`;
    const m = P.openModal(html, { kind: 'palette', cls: 'proto-cmd-overlay', returnTo, initialFocus: '.proto-cmd__input' });
    const input = $('.proto-cmd__input', m.box);
    const list = $('.proto-cmd__list', m.box);
    const emptyEl = $('.proto-cmd__empty', m.box);
    const all = paletteItems();
    let shown = [];
    let active = 0;
    const setActive = (i, scroll) => {
      if (!shown.length) { input.removeAttribute('aria-activedescendant'); return; }
      active = (i + shown.length) % shown.length;
      $$('[role="option"]', list).forEach((o, k) => o.setAttribute('aria-selected', String(k === active)));
      input.setAttribute('aria-activedescendant', `proto-cmd-${active}`);
      const el = $(`#proto-cmd-${active}`, list);
      if (el && scroll) el.scrollIntoView({ block: 'nearest' });
    };
    // F9：名称完全匹配 > 名称开头匹配 > 名称包含 > 只在说明 / 分组 / 关键词里命中；分组按组内最好的命中排序（没有输入时保持默认顺序）
    const score = (it, q) => { const l = it.label.toLowerCase(); return l === q ? 0 : l.startsWith(q) ? 1 : l.includes(q) ? 2 : 3; };
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      const hits = all.filter((it) => !q || `${it.label} ${it.meta || ''} ${it.g} ${it.keywords || ''}`.toLowerCase().includes(q)).map((it) => ({ it, s: q ? score(it, q) : 0 }));
      if (!hits.length) {
        shown = [];
        list.innerHTML = ''; list.hidden = true;
        emptyEl.hidden = false; emptyEl.textContent = `没有找到匹配“${input.value.trim()}”的结果`;
        input.removeAttribute('aria-activedescendant');
        input.setAttribute('aria-expanded', 'false'); // F13①：列表收起时 combobox 也说「收起」
        return;
      }
      list.hidden = false; emptyEl.hidden = true;
      input.setAttribute('aria-expanded', 'true');
      const best = new Map();
      for (const h of hits) best.set(h.it.g, Math.min(best.has(h.it.g) ? best.get(h.it.g) : 9, h.s));
      const groups = GROUPS.filter((g) => best.has(g)).sort((a, b) => best.get(a) - best.get(b) || GROUPS.indexOf(a) - GROUPS.indexOf(b));
      let out = '', n = 0;
      shown = [];
      for (const g of groups) {
        const its = hits.filter((h) => h.it.g === g).sort((a, b) => a.s - b.s).map((h) => h.it);
        const gid = `proto-cmd-g${GROUPS.indexOf(g)}`;
        out += `<div class="proto-cmd__group" role="group" aria-labelledby="${gid}"><div class="proto-cmd__group-label" id="${gid}">${esc(g)}</div>`;
        for (const it of its) {
          const idx = n++;
          shown.push(it);
          out += `<div class="proto-cmd__item" role="option" id="proto-cmd-${idx}" aria-selected="false"${it.disabled ? ' aria-disabled="true"' : ''} data-idx="${idx}"><span class="proto-cmd__icon">${it.icon}</span><span class="proto-cmd__label">${esc(it.label)}</span>${it.meta ? `<span class="proto-cmd__meta">${esc(it.meta)}</span>` : ''}${it.kbd ? `<span class="kbd" aria-hidden="true">${esc(it.kbd)}</span>` : ''}</div>`;
        }
        out += '</div>';
      }
      list.innerHTML = out;
      setActive(0, true);
    };
    const exec = (i) => {
      const it = shown[i];
      if (!it || it.disabled) return;
      const ret = m.returnTo;
      P.closeModal(m);
      it.run(ret && ret.isConnected ? ret : null);
    };
    // F2：输入法组字中（拼音选字）Enter / ↑↓ / Esc 都归输入法；Safari 组字结束那一下 Enter 的 isComposing 是 false，靠 compositionend 的时间认
    let compositionEndAt = -1;
    input.addEventListener('compositionend', () => { compositionEndAt = performance.now(); });
    input.addEventListener('input', draw);
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && performance.now() - compositionEndAt < 80) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1, true); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1, true); }
      else if (e.key === 'Enter') { e.preventDefault(); exec(active); }
    });
    list.addEventListener('mousemove', (e) => { const o = e.target.closest('[role="option"]'); if (o && Number(o.dataset.idx) !== active) setActive(Number(o.dataset.idx), false); });
    list.addEventListener('mousedown', (e) => e.preventDefault()); // 焦点留在输入框
    list.addEventListener('click', (e) => { const o = e.target.closest('[role="option"]'); if (o) exec(Number(o.dataset.idx)); });
    draw();
  }
  P.togglePalette = function togglePalette(returnTo) {
    const top = P.topModal();
    if (top && top.kind === 'palette') { P.closeModal(top); return; }
    if (P.modals.length) return; // 有对话框时不叠面板
    openPalette(returnTo);
  };
  // ================================================================== 第四段（L6a）：工作台外壳的 7 个流程
  //   F-WB-WELCOME 欢迎态（没有任何项目：两张入口卡，Q-DS-31 A）· F-WB-BANNER 横幅栈（两条阻断由 flows-sys 维护；这里补治理类：自动化需关注 / 磁盘 / 保留下来的成果 /
  //   Agent 帐号登录到期，Q-DS-32 B；顶栏「后端不可用」）· F-WB-LIVE 终端连接条四态 + /events 断开的侧栏条（时钟 hold：启动 / 克隆停在最后已知状态，恢复时补拍 = 重同步）·
  //   F-WB-CMDK（paletteItems 里补 5 个动作，见上）· F-WB-ROUTE 对象已不在：回落总览 + 一句 · F-WB-OVERVIEW（fillOverview 里，见上）· F-WB-SHELL 实例菜单去「文档」、
  //   骨架期「更多操作」置灰（tpl-loading 换成 f-wb-shell-01）、终端 [复制] 三句反馈
  // 产品口径：gap/product/WB.md（AC 的 Then）；接线要点：gap/drafts/notes/wb.md §6；待定问题按 open-questions 默认（Q-DS-30…35、Q-WB-01 A、Q-WB-03 A、Q-WB-05 A）
  const GW = '工作台';
  P.scenario.define({ key: 'wb-world', group: GW, label: '项目', def: 'sample', options: [['sample', '示例世界（5 个项目）'], ['none', '还没有任何项目（欢迎态）']] });
  P.scenario.define({ key: 'events', group: GW, label: '实时更新（/events）', def: 'ok', options: [['ok', '连着'], ['drop', '断开：正在重连（列表停在最后已知状态）']] });
  P.scenario.define({ key: 'term-conn', group: GW, label: '终端连接', def: 'ok', options: [['ok', '连着'], ['drop', '断线：每 2 秒自动重连一次，8 次后次数用完'], ['handshake', '握手被拒：页面版本与后端不一致'], ['ended', '会话已结束：没能连上运行环境'], ['exit', '会话已结束：进程退出（退出码 0）']] });
  const backendDown = () => P.scenario.is('sys-conn', 'down');
  function newTaskReason() { const off = P.ask('newTask.blocked', null); if (off) return off; return world.projects.length ? null : '先新建一个项目'; }

  // ------------------------------------------------------------------ F-WB-WELCOME（REQ-WB-001–003）
  // 场景「还没有任何项目」：示例世界的项目 / 任务 / 成果 / 规则先收起来（切回示例世界原样放回；空世界里新建的也留着）
  let worldStash = null;
  function applyWorld() {
    const none = P.scenario.is('wb-world', 'none');
    if (none && !worldStash) {
      worldStash = { projects: world.projects.splice(0), tasks: world.tasks.splice(0), retained: world.retained.splice(0), automations: world.automations.splice(0) };
      ui.filter = 'all'; ui.ovQuery = ''; ui.pinned = null;
    } else if (!none && worldStash) {
      for (const k of ['projects', 'tasks', 'retained', 'automations']) world[k].unshift(...worldStash[k]);
      worldStash = null;
    } else return;
    if (P.isWorkbench() && ui.route.view !== 'overview') P.replaceRoute('overview'); else P.render(); // 地址写 #overview（没有项目时工作台一律是欢迎态）
  }
  P.mainTpl.unshift((r) => (P.isWorkbench(r) && !world.projects.length ? 'tpl-welcome' : undefined));
  P.views['tpl-welcome'] = {
    wire(main) {
      const host = main.parentElement;
      const nb = $('.header__actions .btn', host); nb.dataset.fk = 'h-new';
      const [git, empty] = $$('.wb-entry', main);
      Object.assign(git.dataset, { action: 'welcome-git', fk: 'we-git' });
      Object.assign(empty.dataset, { action: 'welcome-empty', fk: 'we-empty' });
      const title = $('.empty__title', main); title.tabIndex = -1; // 初始化完成后的第一屏：焦点落到主区标题（AC-WB-003.3、AC-DEP-015.1）
    },
    refresh(host) {
      // [新任务]：能聚焦、按下才说原因（离线优先于「先新建一个项目」，AC-WB-001.3）；顶栏不放「更多操作」
      const why = newTaskReason() || '先新建一个项目';
      const nb = $('[data-fk="h-new"]', host);
      if (nb && nb.dataset.reason !== why) { nb.dataset.reason = why; nb.title = why; const s = $('#why-new', host); if (s) s.textContent = why; }
      // 「开一个空项目」：名称预填「未命名项目 N」（前端按现有名取最大 N+1，Q-WB-02 默认 A）
      const strong = $('#we-empty-d strong', host); const nm = `「${P.nextUntitled()}」`;
      if (strong && strong.textContent !== nm) strong.textContent = nm;
    },
  };
  Object.assign(P.actions, {
    'welcome-git': (a) => P.openNewProject({ source: 'git', focus: 'repo' }, a), // 来源预选 Git、焦点进仓库地址（AC-WB-002.2）
    'welcome-empty': (a) => P.openNewProject({ source: 'empty', name: P.nextUntitled() }, a), // 预选空项目、名称预填；还没发任何创建请求（AC-WB-002.3）
  });
  // 第一个项目建好：选中它——空项目落「还没有任务」（flows-prj 本来就跳过去）；Git 项目落克隆进度（AC-WB-003.2）。新建项目弹层还开着（进度视图），所以不走 onRoute（它会关掉弹层）
  P.hook('project:created', (p, { first } = {}) => {
    if (!first || p.source !== 'git') return;
    ui.route = { view: 'project', projectId: p.id }; ui.pinned = p.id; ui.expanded[p.id] = true;
    try { history.replaceState(null, '', `#project-${p.id}`); } catch (e) { /* 拿不到时照常 */ }
    P.render();
  });
  // 初始化向导写入成功 → 第一屏（没有项目时就是欢迎态）：焦点给主区标题，不出「初始化完成」类提示（flows-dep 的 'loaded' 先把焦点给 #main，这里接着落到标题）
  let welcomeFocus = false;
  P.hook('init:done', () => { welcomeFocus = true; });
  P.hook('loaded', () => {
    if (!welcomeFocus) return; welcomeFocus = false;
    const t = $('#shell-main .wb-welcome .empty__title'); if (t) t.focus({ preventScroll: true });
  });

  // ------------------------------------------------------------------ F-WB-BANNER（REQ-WB-010–015）：治理横幅的数据（ui.js 画；两条阻断由 flows-sys 维护）
  // 同档按出现先后（第一次命中时排到治理类末尾）；同一刻一起命中时按 自动化 → 磁盘 → 凭证 → 成果；读取失败（后端不可达）时这几条都不出（读不到不等于有问题）
  const fmtGB = (mb) => { const g = mb / 1024; return g < 10 ? `${Math.round(g * 10) / 10} GB` : `${Math.round(g)} GB`; };
  function wantGovern() {
    if (backendDown() || !P.sysResources) return [];
    const out = [];
    const reLogin = (rt) => ({ label: '重新登录', act: () => { ui.pendingRelogin = rt.id; if (ui.route.view === 'credentials') runRelogin(); else P.go('credentials'); } });
    const clean = { label: '去清理', act: (btn) => P.openRetained(null, btn) }; // Q-DS-33 A：跨项目的「保留下来的成果」
    // 自动化需关注（2026-10-04 用户拍板 Q-WB-01 B；REQ-WB-013）：按全部项目判定（跨项目规则概览），总览、任何项目、设置页上都出；说明点名「<项目> 的「<规则>」」；
    // [查看这些规则] 打开说明里第一条规则所在项目的自动化规则（列表视图；不一定是当前项目，当前选中不变）。概览读不到（P.autAttention 答 null）= 不出这一条
    const at = P.autAttention ? P.autAttention() : null;
    if (at && at.needs) out.push({ id: 'gov-aut', level: 'govern', title: at.title, text: at.text, action: { label: '查看这些规则', act: (btn) => P.openAutomations(at.project, btn) }, dismiss: 'today' });
    const R = P.sysResources();
    const free = fmtGB((R.disk.total - R.disk.used) * 1024);
    if (R.disk.level === 'warn') out.push({ id: 'gov-disk', level: 'govern', title: '磁盘快满了', text: `数据目录所在的磁盘已用 ${Math.round(R.disk.pct)}%，还剩 ${free}。满了以后克隆仓库、拉镜像、准备代码副本都会失败。`, action: clean, dismiss: 'today' });
    if (R.disk.level === 'critical') out.push({ id: 'gov-disk', level: 'govern', title: '磁盘已满', text: `数据目录所在的磁盘已用 ${Math.round(R.disk.pct)}%，还剩 ${free}。新任务很可能建不起来，先清掉不再需要的成果。`, action: clean, dismiss: 'today' });
    for (const rt of world.runtimes) {
      const c = P.credStatus ? P.credStatus(rt) : rt.cred;
      if (c === 'expiring' && rt.account) out.push({ id: `gov-cred-${rt.id}`, level: 'govern', title: `${rt.name} 的帐号登录 ${Math.ceil(rt.account.daysLeft)} 天后过期`, text: '建议在它到期前重新登录一次，免得任务跑到一半断掉。', action: reLogin(rt), dismiss: 'today' });
      if (c === 'expired') out.push({ id: `gov-cred-${rt.id}`, level: 'govern', title: `${rt.name} 的帐号登录已过期`, text: '现在用它发任务会失败，点 [重新登录] 换一份。', action: reLogin(rt), dismiss: 'today' });
    }
    if (R.retained.level === 'warn') out.push({ id: 'gov-retained', level: 'govern', title: `保留下来的成果占了数据目录的 ${Math.round(R.retained.pct)}%`, text: `共 ${fmtGB(R.retained.mb)}，都是销毁任务时留下的代码副本，各自到期后自动清理；等不及的话，先删掉用不着的几份。`, action: clean, dismiss: 'today' });
    return out;
  }
  function syncGovern() {
    const list = world.banners;
    const want = wantGovern();
    for (let i = list.length - 1; i >= 0; i--) if (list[i].level === 'govern' && list[i].id.startsWith('gov-') && !want.some((w) => w.id === list[i].id)) list.splice(i, 1);
    for (const w of want) { const c = list.find((b) => b.id === w.id); if (c) Object.assign(c, w); else list.push(w); }
  }
  P.hook('main:refreshed', () => syncGovern(), { first: true });
  // [重新登录]：去凭证管理并展开该 Agent 的帐号登录面板（F-AUTH-PANEL；凭证页还在骨架里时等它读完）
  function runRelogin() {
    const id = ui.pendingRelogin; if (!id || ui.route.view !== 'credentials') return;
    const b = $(`[data-fk="crd-login:${id}:acc"]`); if (!b) return;
    ui.pendingRelogin = null;
    if (b.getAttribute('aria-expanded') !== 'true' && P.actions['crd-login']) P.actions['crd-login'](b);
  }
  P.hook('main:refreshed', () => { if (ui.pendingRelogin) queueMicrotask(runRelogin); });
  P.hook('route', (r) => { if (r.view !== 'credentials') ui.pendingRelogin = null; });
  // 顶栏「后端不可用」：健康检查读不到时（场景「后端不可达」）出在顶栏右侧，正常时不渲染任何健康文字（REQ-WB-014、f-wb-banner-01）
  function paintHealth() {
    const hdr = $('#shell-main > .header');
    const old = $('#hdr-health');
    if (!hdr || !backendDown() || ui.loading) { if (old) old.remove(); return; }
    if (old && hdr.contains(old)) return;
    if (old) old.remove();
    let acts = $(':scope > .header__actions', hdr);
    if (!acts) { acts = document.createElement('div'); acts.className = 'header__actions'; hdr.appendChild(acts); }
    acts.prepend(P.fromTpl('tpl-wb-health'));
  }
  P.hook('main:refreshed', paintHealth);

  // ------------------------------------------------------------------ F-WB-ROUTE（REQ-WB-040）：对象已不在 → 回落总览 + 一句；「知道名字」= 本次会话里见过它
  const seenName = { task: {}, project: {} };
  P.hook('rendered', () => { for (const t of world.tasks) seenName.task[t.id] = t.name; for (const p of world.projects) seenName.project[p.id] = p.name; });
  P.hook('route.unknown', (h) => {
    const m = /^(task|project)-(.+)$/.exec(h || '');
    if (m) return { view: 'overview', missing: { kind: m[1], id: m[2] } };
    return { view: 'overview', missing: { kind: 'page', id: h } };
  });
  P.missingTitle = function missingTitle(kind, id) {
    const name = kind === 'task' ? seenName.task[id] : kind === 'project' ? seenName.project[id] : null;
    if (kind === 'task') return name ? `找不到任务「${name}」：可能已被销毁。` : '找不到这个任务：可能已被销毁。';
    if (kind === 'project') return name ? `找不到项目「${name}」：可能已被删除。` : '找不到这个项目：可能已被删除。';
    return '这个地址没有对应的页面，已打开项目总览。';
  };
  P.hook('route.missing', (ms) => { ui.notice = { key: 'overview', kind: 'missing', page: ms.kind === 'page', title: P.missingTitle(ms.kind, ms.id), fresh: true }; });

  // ------------------------------------------------------------------ F-WB-LIVE · 终端连接条（REQ-TRM-001–003）：终端栏与画布之间；连上时不显示；画布保留断线前的输出
  // 优先级：会话已结束 > 握手被拒 > 次数用完 > 正在重连 > 连接中（原因确定时不再显示「正在重连…」）
  const TC = { state: 'open', attempt: 0, next: 0 };
  const RECONNECT_MAX = 8; // PARAM.TERM_RECONNECT_MAX
  function setTC(state, attempt) { Object.assign(TC, { state, attempt: attempt || 0, next: P.clock.now() + (state === 'connecting' ? T.termConnect : T.termReconnect) }); P.clock.wake(); P.dirty(); }
  function applyTermScenario() {
    const v = P.scenario.get('term-conn');
    if (v === 'drop') { if (TC.state !== 'reconnecting' && TC.state !== 'closed') { setTC('reconnecting', 1); P.announce('终端连接断开，正在重连…（第 1 次）。任务在后台继续跑，不会因为这次断线中断。'); } }
    else if (v === 'handshake') { setTC('rejected'); P.announce('页面版本与后端不一致（前端不是最新的），请刷新页面；重连不会解决这个问题。'); }
    else if (v === 'ended') { setTC('ended'); P.announce('终端会话已结束——没能连上这个任务的运行环境（多半已经回收了）。重连不会有结果，请重新发起一个任务。'); }
    else if (v === 'exit') { setTC('exited'); P.announce('终端会话已结束（退出码 0）。'); }
    else if (['rejected', 'ended', 'exited'].includes(TC.state)) setTC('open'); // 改回「连着」= 刷新后重新连上（原型演示用）
    // 「正在重连」时改回「连着」：下一次重连就成功；次数用完时要等用户点 [手动重连]
  }
  P.clock.ticker({
    active: () => TC.state === 'reconnecting' || TC.state === 'connecting',
    tick(now) {
      if ((TC.state !== 'reconnecting' && TC.state !== 'connecting') || now < TC.next) return;
      const up = !P.scenario.is('term-conn', 'drop');
      if (up) { setTC('open'); P.announce('终端已重新连上'); return; }
      if (TC.state === 'connecting') { setTC('reconnecting', 1); return; } // [手动重连] 清零重来一整轮（REQ-TRM-002）
      if (TC.attempt >= RECONNECT_MAX) { setTC('closed'); P.announce('自动重连的次数用完了，暂时停手。这只说明这几次没连上，不代表连不上；任务本身还在后台跑，重新连上就能接着看。'); return; }
      setTC('reconnecting', TC.attempt + 1);
    },
  });
  function connBarHtml() {
    const wrap = (cls, role, icon, title, rest, btn) => `<div class="conn-bar${cls}" role="${role}" data-term-conn><span class="icon ${icon}" aria-hidden="true"></span><span class="wb-conn__text"><span class="conn-bar__title">${title}</span>${rest}</span>${btn || ''}</div>`;
    switch (TC.state) {
      case 'reconnecting': { const n = P.fromTpl('tpl-wb-conn-warn', { keepRoles: true }); $('.conn-bar__title', n).textContent = `正在重连…（第 ${TC.attempt} 次）。`; n.dataset.termConn = ''; return n.outerHTML; }
      case 'closed': { const n = P.fromTpl('tpl-wb-conn-fail', { keepRoles: true }); Object.assign($('.conn-bar__end .btn', n).dataset, { action: 'term-reconnect', fk: 'term-reconnect' }); n.dataset.termConn = ''; return n.outerHTML; }
      case 'connecting': return '<div class="conn-bar" role="status" data-term-conn><span class="icon icon--spin i-loader-circle" aria-hidden="true"></span><span><span class="conn-bar__title">连接中…</span></span></div>';
      case 'rejected': return wrap(' conn-bar--fail wb-conn--wrap', 'alert', 'i-unplug', '页面版本与后端不一致（前端不是最新的），', '请刷新页面；重连不会解决这个问题。');
      case 'ended': return wrap(' conn-bar--warn wb-conn--wrap', 'alert', 'i-unplug', '终端会话已结束——', '没能连上这个任务的运行环境（多半已经回收了）。重连不会有结果，请重新发起一个任务。');
      case 'exited': return wrap(' conn-bar--warn wb-conn--wrap', 'alert', 'i-unplug', '终端会话已结束（退出码 0）。', '');
      default: return '';
    }
  }
  P.hook('term:rendered', (host, t) => {
    let bar = $('[data-term-conn]', host);
    const html = t.state === 'stopping' ? '' : connBarHtml(); // 停止中有自己的那条（flows-lch「停止中…」），不叠两条
    if (!html) { if (bar) bar.remove(); }
    else if (!bar || bar.dataset.html !== html) { const n = frag(html); n.dataset.html = html; if (bar) bar.replaceWith(n); else $('.termbar', host).after(n); }
    // 进程退出：画布另写一行「[进程已退出，code 0]」（附着失败那种不写退出行）
    for (const pre of $$('.term .term__screen', host)) {
      const line = $('[data-term-exit]', pre);
      if (TC.state === 'exited' && !line) pre.insertAdjacentHTML('beforeend', '<span data-term-exit>\n<span class="ansi-dim">[进程已退出，code 0]</span></span>');
      else if (TC.state !== 'exited' && line) line.remove();
    }
  });
  P.actions['term-reconnect'] = () => { if (TC.state !== 'closed') return; setTC('connecting'); P.announce('连接中…'); };

  // ------------------------------------------------------------------ F-WB-LIVE · /events 断开（REQ-EVT-001 / 002）：侧栏查找框下、导航之上一条 warn 提示（role=status，没有按钮）；
  // 断开期间树、总览、等待计数保留最后已知状态（时钟 hold：克隆与启动四段不再推进界面）；恢复后自动重同步（补拍）、提示消失；终端是另一条连接，照常
  function applyEvents() {
    const down = P.scenario.is('events', 'drop');
    P.clock.hold(down);
    let el = $('#sidebar [data-events-alert]');
    if (down && !el) { el = P.fromTpl('tpl-wb-events', { keepRoles: true }); el.dataset.eventsAlert = ''; $('#sidebar .sidebar__top').after(el); P.announce('实时更新已中断，正在重连… 列表可能不是最新的'); }
    else if (!down && el) { el.remove(); P.announce('实时更新已恢复，列表已重新同步'); }
    P.render();
  }

  // ------------------------------------------------------------------ F-WB-SHELL · 终端 [复制]（REQ-WB-063）：有选区复制选区，没有就复制整屏文本；三句反馈（轻提示）
  P.actions['term-copy'] = () => {
    const t = P.currentTask(); if (!t || !P.TERM_STATES.has(t.state) || t.headless) return;
    const st = P.tabsState(t);
    const pre = $(`#term-${CSS.escape(st.active)} .term__screen`);
    const sel = window.getSelection();
    let text = '';
    if (sel && !sel.isCollapsed && pre && pre.contains(sel.anchorNode) && pre.contains(sel.focusNode)) text = sel.toString();
    else if (pre && !ui.cleared[st.active]) text = pre.textContent;
    text = text.replace(/ /g, ' ').replace(/[ \t]+$/gm, '').trim();
    if (!text) { P.toast('fail', '终端里还没有可复制的内容'); return; } // 不写剪贴板（失败样式，Q-WB-05 默认 A）
    // 剪贴板不可用（非 HTTPS 的局域网部署里 navigator.clipboard 不存在）或写入被拒：同一句失败（AC-WB-063.4；跟场景「剪贴板」走）
    P.copyText(text, () => P.toast('ok', '已复制到剪贴板'), () => P.toast('fail', '复制失败，请手动选中终端内容复制'));
  };
  // 终端画布是静态文本（U-16 按计划不做真实输入输出）：在画布里敲字 / 回车时就地照实说一句（不是「原型：未接入」），4 秒内只说一次
  let termHintAt = -1e9;
  P.hook('keydown', (e, { inTerm }) => {
    if (!inTerm || e.ctrlKey || e.metaKey || e.altKey || !(e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace')) return;
    if (performance.now() - termHintAt < 4000) return;
    termHintAt = performance.now();
    const tab = $('#shell-main [role="tab"][aria-selected="true"]');
    if (tab) P.hint(tab, '原型里的终端是静态画面：键入不会送到 Agent（真实产品里在这里直接输入）');
  });

  // ------------------------------------------------------------------ 其余发起入口的离线置灰（REQ-WB-014）：P6 空态「新任务」；没有项目时侧栏不出「按状态筛选」（AC-WB-001.1）
  P.hook('main:refreshed', (host, r) => {
    const en = $('[data-fk="e-new"]', host);
    if (en && r.view === 'project') { const why = P.newTaskBlocked(P.proj(r.projectId)); if (why) { en.setAttribute('aria-disabled', 'true'); en.dataset.reason = why; } else { en.removeAttribute('aria-disabled'); delete en.dataset.reason; } }
  });
  P.hook('rendered', () => {
    const fb = $('#sidebar [data-fk="filter"]');
    if (fb) fb.hidden = !world.projects.length && !ui.loading;
  });

  P.hook('scenario', (k) => {
    if (k === 'wb-world') applyWorld();
    else if (k === 'events') applyEvents();
    else if (k === 'term-conn') applyTermScenario();
    else if (k === 'cred-expiry' || k.startsWith('sys-')) P.dirty(); // 治理横幅随凭证 / 本机资源的场景重算
  });
  P.hook('boot', () => {
    if (P.scenario.is('wb-world', 'none')) applyWorld();
    // 第五段（R1-05）：地址带 &scenario=events:drop 直开时，读地址参数那一步已经经 'scenario' 钩子插过一条（applyEvents）——这里只补没插上的情况，不再叠第二条
    if (P.scenario.is('events', 'drop')) { P.clock.hold(true); if (!$('#sidebar [data-events-alert]')) { const el = P.fromTpl('tpl-wb-events', { keepRoles: true }); el.dataset.eventsAlert = ''; $('#sidebar .sidebar__top').after(el); } }
    if (!P.scenario.is('term-conn', 'ok')) applyTermScenario();
  });

  // ------------------------------------------------------------------ 测试出口（只读快照）
  P.stateExtras.push(() => ({
    wb: {
      world: worldStash ? 'none' : 'sample', welcome: $('#shell-main') ? $('#shell-main').dataset.tpl === 'tpl-welcome' : false,
      banners: P.banners.list().map((b) => ({ id: b.id, level: b.level, title: b.title })), hidden: [...P.banners.ui.hidden.keys()],
      term: { state: TC.state, attempt: TC.attempt }, events: P.scenario.get('events'), held: P.clock.held, health: !!$('#hdr-health'),
    },
  }));
})();
