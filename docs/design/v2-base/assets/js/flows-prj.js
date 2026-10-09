/*
 * 交互原型 · 项目（js/flows-prj.js）：L1 六个流程
 *   F-PRJ-CREATE   新建项目（侧栏「新建项目」图标、总览「新建 ⌄」、⌘K、欢迎态卡 → 同一弹层；表单 / 被拒 / 进度 / 完成 / 失败五个视图）
 *   F-PRJ-CLONE    克隆中与克隆失败的项目（主区进度卡 / 恢复引导、项目菜单、总览卡三处共用 retryClone / convertToEmpty / cancelClone / configureGitCredentials）
 *   F-PRJ-INFO     项目信息浮层（顶栏分支 chip / ⓘ）与拉取最新代码（浮层按钮、顶栏按钮、窄顶栏「⋯」菜单三处同一个 pullProject）
 *   F-PRJ-DETAIL   项目详情（只读五行，计数从任务 / 成果 / 规则三份数据现算）
 *   F-PRJ-DELETE   删除项目（打开即按数据选态：被拦 / 可删 / 克隆中；删除中不可关；失败就地说）
 *   F-PRJ-RETAINED 保留下来的成果（列表 / 空 / 读取失败 / 同一弹层就地确认删除 / 跨项目视图）
 * 标记来源：gap/drafts/f-prj-*.html（index.html 的 tpl-np-* / tpl-pop-* / tpl-del-* / tpl-rv-* / tpl-project-* 模板，build-proto.cjs 同源拷贝）；
 * 产品口径：gap/product/PRJ.md（AC 的 Then）；接线要点：gap/drafts/notes/prj-a.md §6、prj-b.md §6、consistency.md。
 */
(function () {
  'use strict';
  const P = window.P;
  const { $, $$, esc, ui, menuItem, SEP } = P;
  const world = P.world;
  const T = P.TIMING;

  // ------------------------------------------------------------------ 场景（「原型说明 › 场景」）
  const S = '项目';
  P.scenario.define({ key: 'clone', group: S, label: '下一次克隆', once: true, def: 'ok', options: [['ok', '成功'], ['network', '网络错误'], ['permission', '需要 Git 凭证'], ['notfound', '打不开仓库'], ['timeout', '超时'], ['disk', '磁盘不足']] });
  P.scenario.define({ key: 'clone-progress', group: S, label: '克隆进度', def: 'pct', options: [['pct', '有百分比'], ['unknown', '进度未知']] });
  P.scenario.define({ key: 'clone-slow', group: S, label: '克隆慢提示', def: 'normal', options: [['normal', '按时（画面口径 600 秒）'], ['now', '立即出现']] });
  P.scenario.define({ key: 'clone-base', group: S, label: 'infra-scripts 那次克隆', def: 'run', options: [['run', '慢速推进（每 3 秒 1%）'], ['pause', '暂停在 42%']] });
  P.scenario.define({ key: 'project-submit', group: S, label: '下一次提交新建项目', once: true, def: 'ok', options: [['ok', '服务端接受'], ['invalid-url', '地址不合法'], ['limit', '到上限（50 个）'], ['offline', '没有应答（断网）']] });
  P.scenario.define({ key: 'pull', group: S, label: '下一次拉取', once: true, def: 'ok', options: [['ok', '成功'], ['permission', '需要 Git 凭证'], ['network', '网络不通']] });
  P.scenario.define({ key: 'delete-project', group: S, label: '下一次删除项目', once: true, def: 'ok', options: [['ok', '成功'], ['fail', '失败（网络不通）']] });
  P.scenario.define({ key: 'retained', group: S, label: '保留下来的成果', def: 'ok', options: [['ok', '正常'], ['fail', '读取失败']] });

  // ------------------------------------------------------------------ 克隆失败码 → 说明与出口（REQ-PRJ-005 的表；PERMISSION / NOT_FOUND 不给重试、给配置 Git 凭证）
  const CLONE_FAIL = (P.CLONE_FAIL = {
    CLONE_FAILED_PERMISSION: { desc: '远端拒绝了这次访问：凭证无效或没有这个仓库的权限。配置 Git 访问凭证后可重试克隆。', retry: false },
    CLONE_FAILED_NOT_FOUND: { desc: '打不开这个仓库：可能是私有仓库还没配 Git 凭证，也可能是地址写错了。如果是私有仓库，配好凭证后可以重试克隆；如果是地址写错了，远端地址建好之后改不了，需要删掉这个项目重新建一个。', retry: false },
    CLONE_FAILED_NETWORK: { desc: '网络错误导致克隆失败，请检查网络后重试。', retry: true },
    TIMEOUT: { desc: '克隆超时（仓库较大或网络较慢），可重试。', retry: true },
    INTERRUPTED: { desc: '克隆被中断，请重试。', retry: true },
    DISK_INSUFFICIENT: { desc: '磁盘空间不足，没能克隆完。清理出空间后可以在这个项目上重试克隆；也可以改为空项目。', retry: true },
    UNKNOWN: { desc: '克隆失败，请重试。', retry: true },
  });
  const failOf = (p) => CLONE_FAIL[p.failCode] || CLONE_FAIL.UNKNOWN;
  const SCEN_CODE = { network: 'CLONE_FAILED_NETWORK', permission: 'CLONE_FAILED_PERMISSION', notfound: 'CLONE_FAILED_NOT_FOUND', timeout: 'TIMEOUT', disk: 'DISK_INSUFFICIENT' };
  const NOTE_CONVERT_MAIN = '[改为空项目]：项目留着、已有的任务也留着，只是工作区从空的开始，不再关联这个仓库。';
  const NOTE_CONVERT_MENU = '[改为空项目]：项目和它下面已有的任务都留着，只是工作区从空的开始，不再关联这个仓库。';

  // ------------------------------------------------------------------ 克隆引擎（单一时钟里的进行中对象）
  // 六个阶段（LIVE-RUN L-2；按对象数说进度，不写字节进度）：枚举 0.6 s → 清点 0.6 s → 压缩 1.2 s → 接收（百分比主体）→ 解析增量 1 s → 检出 1 s。
  // 百分比是当前阶段的（git 的口径），接收对象阶段占大头；clone.run = 已推进的「进度时间」（毫秒），暂停时不加。
  const STAGES = (P.CLONE_STAGES = ['枚举远端对象', '清点对象', '远端压缩', '接收对象', '解析增量', '检出文件']);
  const PRE = [600, 600, 1200];
  const POST = [1000, 1000];
  function stageInfo(c) {
    let t = c.run, s = 0;
    for (; s < 3; s++) { if (t < PRE[s]) return { s, pct: (t / PRE[s]) * 100 }; t -= PRE[s]; }
    const recv = 100 * c.msPerPct;
    if (t < recv) return { s: 3, pct: t / c.msPerPct };
    t -= recv;
    for (let k = 0; k < 2; k++) { if (t < POST[k]) return { s: 4 + k, pct: (t / POST[k]) * 100 }; t -= POST[k]; }
    return { s: 6, pct: 100 };
  }
  const totalRun = (c) => PRE[0] + PRE[1] + PRE[2] + 100 * c.msPerPct + POST[0] + POST[1];
  const nf = (n) => n.toLocaleString('en-US');
  function cloneView(p) {
    const c = p.clone;
    const { s, pct } = stageInfo(c);
    const st = Math.min(s, 5);
    const unknown = c.unknown;
    const total = c.objectsTotal || 26348;
    const objs = st === 0 ? `共 ${nf(total)} 个对象`
      : st === 4 ? `${nf(Math.round(total * 0.62 * pct / 100))}/${nf(Math.round(total * 0.62))}`
        : st === 5 ? `${nf(Math.round(1284 * pct / 100))}/${nf(1284)}`
          : `${nf(Math.round(total * pct / 100))}/${nf(total)}`;
    const stage = `${STAGES[st]}（第 ${st + 1}/6 步）`;
    const recv = st >= 3 ? `${(st === 3 ? (c.totalMB || 43.8) * pct / 100 : (c.totalMB || 43.8)).toFixed(1)} MB` : '';
    const rate = st === 3 ? (c.rate || '1.2 MB/s') : '';
    const detail = unknown ? `${STAGES[0]}（第 1/6 步） · 共 ${nf(total)} 个对象` : [stage, objs, recv, rate].filter(Boolean).join(' · ');
    const elapsed = c.elapsed; // 已用：每过一个时钟秒加 1 秒（场景「暂停」时连已用一起停，截图与静态稿一致）
    const slow = c.slow || P.scenario.is('clone-slow', 'now') || elapsed >= T.cloneSlow;
    if (slow) c.slow = true;
    return { pct: unknown ? null : Math.floor(pct), stage, detail, recv, rate, elapsed, slow, st };
  }
  P.cloneView = cloneView;
  function startClone(p, { base = false } = {}) {
    let scen = base ? 'ok' : P.scenario.take('clone');
    // Git 凭证联动（F-CRD-GIT）：私有仓没有能用的凭证时按权限类失败（flows-crd.js 的 'git.access' 钩子判；场景优先）
    if (scen === 'ok' && !base) scen = P.ask('git.access', p) || 'ok';
    p.status = 'cloning';
    delete p.failCode;
    p.clone = { run: 0, elapsed: 0, msPerPct: (T.clone - 4400) / 100, since: P.clock.now(), unknown: P.scenario.is('clone-progress', 'unknown'), totalMB: 45.2, rate: '3.4 MB/s', objectsTotal: 26348, failCode: SCEN_CODE[scen] || null, failAt: SCEN_CODE[scen] ? P.clock.now() + T.cloneFail : null };
    P.clock.wake();
  }
  // 示例世界预置的那次克隆（infra-scripts，42%，已用 0:38）：慢速推进（每 3 秒 1%），场景可暂停
  (function seedBaseClone() {
    const p = world.projects.find((x) => x.id === 'infra');
    const c = p.clone;
    Object.assign(c, { msPerPct: T.cloneBaseStep, run: PRE[0] + PRE[1] + PRE[2] + 42 * T.cloneBaseStep, elapsed: 38000, unknown: false, totalMB: 43.8, objectsTotal: 26348 });
  })();
  // 「暂停」只冻住进度与已用时间；取消克隆 / 场景失败照常在 failAt 落定
  const pausedBase = (c) => c.base && P.scenario.is('clone-base', 'pause');
  P.clock.ticker({
    bg: true, // 第四段（F-WB-LIVE）：/events 断开时克隆进度停在最后已知状态，恢复时补拍（P.clock.hold）
    active: () => world.projects.some((p) => p.status === 'cloning' && (!pausedBase(p.clone) || p.clone.failAt != null)),
    tick(now) {
      for (const p of world.projects.slice()) {
        if (p.status !== 'cloning') continue;
        const c = p.clone;
        if (c.failAt != null && now >= c.failAt) { finishClone(p, c.failCode); continue; }
        if (pausedBase(c)) continue;
        const before = stageInfo(c).s;
        c.run += 1000;
        c.elapsed += 1000;
        const after = stageInfo(c).s;
        if (after >= 6 || c.run >= totalRun(c)) { finishClone(p, null); continue; }
        if (after !== before) P.emit('clone:stage', p);
      }
    },
  });
  function finishClone(p, code) {
    const name = p.name;
    delete p.clone;
    if (code) {
      p.status = 'failed';
      p.failCode = code;
      P.announce(`「${name}」克隆失败：${failOf(p).desc}`); // 异步结果在原位播报（UX-DS-508）；结果卡插入时不带 role
    } else {
      p.status = 'ready';
      p.branch = p.branch || null; // 建项目时没填分支 = 远端默认分支（REQ-PRJ-020.4）
      p.size = p.id === 'infra' ? '9 MB' : '6 MB';
      p.branches = p.branches && p.branches.length ? p.branches : ['main'];
      const now = P.clock.wall();
      p.pulled = P.fmtFull(now); p.pulledFull = P.fmtFull(now); p.pulledShort = `今天 ${P.fmtHM(now)}`;
      const dlgOpen = npDialog && npDialog.pid === p.id && P.modals.includes(npDialog.m);
      // 完成：弹层开着时换「项目可用了」；弹层已关时原位可见（树徽标消失、选中它时主区换「还没有任务」）+ 轻提示补充（不得只靠轻提示，UX-DS-508）
      if (!dlgOpen) { P.toast('ok', `项目「${name}」可用了`); }
      else P.announce(`项目「${name}」可用了`);
    }
    P.emit('clone:done', p, code);
    P.dirty();
  }

  // ------------------------------------------------------------------ 克隆中 / 克隆失败的三处共用动作（主区、项目菜单、总览卡点一次只改一次状态）
  P.retryClone = function retryClone(p, opts) {
    // force：凭证页回程条的 [重试克隆]（F-CRD-PAGE）——权限类失败本来不给重试，配好凭证后从回程条重试
    if (!p || p.status !== 'failed' || (!failOf(p).retry && !(opts && opts.force))) return;
    startClone(p);
    P.announce(`正在重新克隆「${p.name}」`);
    P.render();
  };
  P.convertToEmpty = function convertToEmpty(p) {
    if (!p || p.status !== 'failed') return;
    Object.assign(p, { status: 'ready', source: 'empty', branch: null, branches: [], size: null, pulled: null, pulledFull: null, pulledShort: null });
    delete p.failCode; delete p.clone;
    p.repoShort = '空项目';
    ui.expanded[p.id] = true;
    P.announce(`「${p.name}」已改为空项目`);
    P.go(`project-${p.id}`);
    P.render();
  };
  P.cancelClone = function cancelClone(p) {
    if (!p || p.status !== 'cloning') return;
    if (p.clone) { p.clone.failAt = P.clock.now() + T.cancelClone; p.clone.failCode = 'INTERRUPTED'; }
    P.announce(`正在取消「${p.name}」的克隆…`);
    P.clock.wake();
  };
  P.configureGitCredentials = function configureGitCredentials(p) {
    ui.pendingProjectCreate = { projectId: p.id }; // 凭证页的回程条（F-CRD-PAGE f-crd-page-05）对同一个项目重试克隆
    ui.focusSection = 'sec-git';
    P.go('credentials');
  };
  Object.assign(P.actions, {
    'retry-clone': (a) => P.retryClone(P.proj(a.dataset.project)),
    'convert-empty': (a) => P.convertToEmpty(P.proj(a.dataset.project)),
    'config-git': (a) => P.configureGitCredentials(P.proj(a.dataset.project)),
    'new-project': (a) => P.openNewProject({}, a),
  });

  // ------------------------------------------------------------------ 进度块的就地刷新（每秒；弹层、主区、总览卡用同一份数据）
  function paintProgress(el, p) {
    const v = cloneView(p);
    const meter = $('.meter', el);
    const bar = $('.meter__bar', el);
    const pctEl = $('.progress__pct', el);
    el.classList.toggle('progress--indeterminate', v.pct == null);
    if (v.pct == null) {
      meter.removeAttribute('aria-valuenow'); meter.setAttribute('aria-label', '克隆进度未知'); bar.removeAttribute('style');
      if (pctEl) pctEl.remove();
    } else {
      meter.setAttribute('aria-label', '克隆进度'); meter.setAttribute('aria-valuemin', '0'); meter.setAttribute('aria-valuemax', '100'); meter.setAttribute('aria-valuenow', String(v.pct));
      bar.style.width = `${v.pct}%`;
      if (!pctEl) { const s = document.createElement('span'); s.className = 'progress__pct'; s.textContent = `${v.pct}%`; $('.progress__track', el).appendChild(s); }
      else if (pctEl.textContent !== `${v.pct}%`) pctEl.textContent = `${v.pct}%`;
    }
    const d = $('.progress__detail', el); if (d && d.textContent !== v.detail) d.textContent = v.detail;
    const e = $('.progress__elapsed', el); const et = `已用 ${P.fmtDur(v.elapsed)}`; if (e && e.textContent !== et) e.textContent = et;
    let note = $('.progress__note--warn', el);
    if (v.slow && !note) {
      note = document.createElement('p');
      note.className = 'progress__note progress__note--warn';
      note.innerHTML = '<span class="icon i-triangle-alert" aria-hidden="true"></span><span>还在克隆。仓库比较大或者网络比较慢，可能要等一会儿——不用一直守在这一屏。</span>';
      el.appendChild(note);
    }
  }
  function cardLines(p) {
    const v = cloneView(p);
    const l1 = v.pct == null ? `进度未知 · ${STAGES[0]}（第 1/6 步）` : `${v.pct}% · ${v.stage}`;
    const title = v.pct == null ? `正在克隆项目… ${v.detail}` : `正在克隆项目… ${v.stage} · ${v.detail.split(' · ')[1] || ''} · ${v.pct}%`;
    const l2 = [v.recv, v.rate, `已用 ${P.fmtDur(v.elapsed)}`].filter(Boolean).join(' · ');
    return { l1, title, l2 };
  }
  P.hook('live', () => {
    for (const el of $$('[data-live-clone]')) { const p = P.proj(el.dataset.liveClone); if (p && p.status === 'cloning' && p.clone) paintProgress(el, p); }
    for (const el of $$('[data-live-clone-card]')) {
      const p = P.proj(el.dataset.liveCloneCard); if (!p || p.status !== 'cloning' || !p.clone) continue;
      const v = cardLines(p);
      const a = $('[data-clone-l1]', el), b = $('[data-clone-l2]', el);
      if (a && a.textContent !== v.l1) { a.textContent = v.l1; a.parentElement.title = v.title; }
      if (b && b.textContent !== v.l2) b.textContent = v.l2;
    }
  });
  // 总览项目卡的两行（克隆失败：失败码的说明 + 同一组出口；克隆中：进度 + 已收 · 速率 · 已用，每秒刷新）——标记照 P2 静态稿
  P.projectCardLines = function projectCardLines(p) {
    if (p.status === 'failed') {
      const f = failOf(p);
      const act = f.retry
        ? `<button class="link" type="button" data-action="retry-clone" data-project="${p.id}" data-fk="cr:${p.id}">重试克隆</button>`
        : `<button class="link" type="button" data-action="config-git" data-project="${p.id}" data-fk="cg:${p.id}">配置 Git 凭证</button>`;
      return [
        `<p class="entity__line entity__line--lead"><span class="icon i-circle-alert entity__alert" aria-hidden="true"></span><span class="entity__text">${esc(f.desc)}</span></p>`,
        `<div class="entity__line entity__line--indent entity__actions">${act}<button class="link link--muted" type="button" data-action="convert-empty" data-project="${p.id}" data-fk="ce:${p.id}">改为空项目</button></div>`,
      ];
    }
    const v = cardLines(p);
    return [
      `<p class="entity__line entity__line--lead" title="${esc(v.title)}" data-live-clone-card="${p.id}"><span class="icon i-loader-circle icon--spin" aria-hidden="true"></span><span class="entity__text" data-clone-l1>${esc(v.l1)}</span></p>`,
      `<p class="entity__line" data-live-clone-card="${p.id}"><span class="icon i-download" aria-hidden="true"></span><span class="entity__text" data-clone-l2>${esc(v.l2)}</span></p>`,
    ];
  };

  // ------------------------------------------------------------------ 主区：项目视图（还没有任务 = P6；克隆中 = f-prj-clone-01 / 02；克隆失败 = f-prj-clone-04 / 05 / 06）
  P.mainTpl.push((r) => {
    if (r.view !== 'project') return undefined;
    const p = P.proj(r.projectId);
    if (!p) return undefined;
    return p.status === 'failed' ? 'tpl-project-failed' : p.status === 'cloning' ? 'tpl-project-cloning' : 'tpl-project-empty';
  });
  P.views['tpl-project-empty'] = {
    refresh(host, r) {
      const p = P.proj(r.projectId);
      const t = $('[data-slot="empty-title"]', host); if (t) t.textContent = `「${p.name}」下还没有任务`;
      const rl = $('[data-slot="rules-link"]', host);
      if (rl) {
        rl.title = `打开 ${p.name} 的自动化规则`;
        // 「设置自动化规则」归 F-AUT-RULES：flows-aut.js 定义了 P.openAutomations 就接上（第四段已定义）
        if (P.openAutomations) { rl.removeAttribute('data-nohook'); rl.dataset.action = 'open-automations'; rl.dataset.project = p.id; }
      }
    },
  };
  P.actions['open-automations'] = (a) => { if (P.openAutomations) P.openAutomations(a.dataset.project || P.currentProjectId(), a); };
  P.views['tpl-project-cloning'] = {
    wire(main) { const pr = $('.progress', main); if (pr) pr.removeAttribute('role'); },
    refresh(host, r) {
      const p = P.proj(r.projectId);
      const sub = $('.empty__subject', host); if (sub) sub.textContent = p.name;
      const pr = $('.progress', host);
      if (pr && p.clone) { pr.dataset.liveClone = p.id; paintProgress(pr, p); }
    },
  };
  P.views['tpl-project-failed'] = {
    refresh(host, r) {
      const p = P.proj(r.projectId);
      const f = failOf(p);
      const card = $('.empty--outcome', host);
      card.dataset.code = p.failCode || 'UNKNOWN';
      $('.empty__subject', card).textContent = p.name;
      $('.empty__desc', card).textContent = f.desc;
      const row = $('.btn-row', card);
      const html = (f.retry
        ? `<button class="btn btn--secondary" type="button" data-action="retry-clone" data-project="${p.id}" data-fk="o-reclone">重试克隆</button>`
        : `<button class="btn btn--secondary" type="button" data-action="config-git" data-project="${p.id}" data-fk="o-creds">配置 Git 凭证</button>`)
        + `<button class="btn btn--tertiary" type="button" aria-describedby="cv-note" data-action="convert-empty" data-project="${p.id}" data-fk="o-empty">改为空项目</button>`;
      if (row.dataset.html !== html) { row.innerHTML = html; row.dataset.html = html; }
    },
  };

  // ------------------------------------------------------------------ 项目「⋯」菜单（树组头、顶栏「⋯ 更多操作」、总览卡共用一份；REQ-PRJ-010 / 013 / 014）
  P.projectMenuItems = function projectMenuItems(p, withPull) {
    let html = P.menuLabel(p.name) + SEP;
    if (withPull && p.status === 'ready' && p.source !== 'empty') {
      const pulling = !!ui.pulling[p.id];
      html += menuItem({ label: pulling ? '正在拉取…' : '拉取最新代码', icon: 'i-refresh-cw', disabled: pulling, reason: '正在拉取，稍等', act: () => P.pullProject(p) }) + SEP;
    }
    html += menuItem({ label: '项目详情', icon: 'i-info', act: (ret) => P.openProjectDetail(p, ret) })
      + menuItem({ label: '保留下来的成果', icon: 'i-gift', act: (ret) => P.openRetained(p.id, ret) })
      + menuItem({ label: '自动化规则', icon: 'i-settings', act: P.openAutomations ? (ret) => P.openAutomations(p.id, ret) : null, nohook: !P.openAutomations });
    if (p.status === 'failed') {
      const note = P.menuNote(NOTE_CONVERT_MENU);
      // 第五段（R2-12）：同一菜单里的项都带图标（文字列对齐；f-prj-clone-04），说明句跟着对齐到文字列（gap-shared §11）
      html += SEP + (failOf(p).retry ? menuItem({ label: '重试克隆', icon: 'i-refresh-cw', act: () => P.retryClone(p) }) : menuItem({ label: '配置 Git 凭证', icon: 'i-key-round', act: () => P.configureGitCredentials(p) }))
        + menuItem({ label: '改为空项目', icon: 'i-folder-minus', act: () => P.convertToEmpty(p), describedBy: note.id }) + note.html;
    } else if (p.status === 'cloning') {
      const note = P.menuNote('只停下这次克隆，项目留在树里；之后可以重试克隆，或改为空项目。');
      html += SEP + menuItem({ label: '取消克隆（保留项目）', icon: 'i-circle-stop', act: () => P.cancelClone(p), describedBy: note.id }) + note.html;
    }
    html += SEP + menuItem({ label: '删除项目…', icon: 'i-trash-2', danger: true, act: (ret) => P.openDeleteProject(p, ret) });
    return html;
  };
  P.menus.project = (trig) => { const p = P.proj(trig.dataset.project); return p ? { label: `${p.name} 的项目菜单`, align: 'end', html: P.projectMenuItems(p, false) } : null; };

  // ------------------------------------------------------------------ F-PRJ-CREATE 新建项目（f-prj-create-01…08）
  let npDialog = null; // { m, ctl, pid }
  const nextUntitled = (P.nextUntitled = () => { let n = 0; for (const p of world.projects) { const m = /^未命名项目 (\d+)$/.exec(p.name); if (m) n = Math.max(n, +m[1]); } return `未命名项目 ${n + 1}`; });
  const avatarOf = (name) => { const s = name.replace(/[^\p{L}\p{N}]/gu, ''); return /^[\x00-\x7f]/.test(s) ? s.slice(0, 2).toUpperCase() : P.cp(s)[0] || '项'; };
  const repoShortOf = (url) => url.replace(/^[a-z]+:\/\//i, '').replace(/^git@([^:]+):/, '$1/').replace(/\.git$/, '');
  P.openNewProject = function openNewProject(opts, returnTo) {
    opts = opts || {};
    const box = P.fromTpl('tpl-np-form');
    box.dataset.dialog = 'new-project';
    const m = P.openModal(box, { kind: 'new-project', returnTo });
    const views = {
      form: (a) => formView(a),
      progress: (a) => ({ html: bodyFromTpl('tpl-np-progress', a.pid), init: (b) => initProgress(b, a.pid), focus: '[data-np="back"]' }),
      done: (a) => ({ html: bodyFromTpl('tpl-np-done', a.pid), init: (b) => initDone(b, a.pid), focus: '[data-np="open"]' }),
      failed: (a) => ({ html: bodyFromTpl(P.proj(a.pid).failCode === 'CLONE_FAILED_NOT_FOUND' ? 'tpl-np-failed-404' : 'tpl-np-failed-perm', a.pid), init: (b) => initFailed(b, a.pid), focus: '.btn-row .btn' }),
    };
    const ctl = P.dialogViews(m, views);
    npDialog = { m, ctl, pid: null };
    const formState = { name: opts.name || '', source: opts.source || 'git', repo: '', branch: '' };
    function formView() {
      const tpl = P.fromTpl('tpl-np-form');
      return {
        html: tpl.innerHTML,
        init: (b) => initForm(b, formState),
        // 第四段（F-WB-WELCOME）：欢迎态「用我的代码库」打开时焦点进仓库地址（opts.focus = 'repo'，AC-WB-002.2）
        focus: opts.focus === 'repo' && formState.source === 'git' ? '[data-np="repo"]' : formState.name ? (formState.source === 'git' ? '[data-np="repo"]' : '[data-np="name"]') : '[data-np="name"]',
      };
    }
    ctl.show('form');
    return m;
  };
  // 弹层的进度 / 完成 / 失败视图：取对应稿件的 .dialog__body，配上同一个标题与右上关闭
  function bodyFromTpl(tplId, pid) {
    const body = P.fromTpl(tplId);
    return `<div class="dialog__header"><h2 class="dialog__title" id="np-title">新建项目</h2></div>${body.outerHTML}<button class="btn btn--tertiary btn--28 btn--icon dialog__close" type="button" aria-label="关闭" data-np="close"><span class="icon i-x" aria-hidden="true"></span></button>`;
  }
  function initForm(b, st) {
    const name = $('input[name="project-name"]', b);
    const repoField = $('#np-repo', b).closest('.field');
    const branchField = $('input[name="repo-branch"]', b).closest('.field');
    const submit = $('button[type="submit"]', b);
    const cancel = $('.dialog__footer > .btn', b);
    name.dataset.np = 'name'; name.dataset.fk = 'np-name'; name.value = st.name;
    const repo = $('#np-repo', b); repo.dataset.np = 'repo'; repo.dataset.fk = 'np-repo'; repo.value = st.repo;
    const branch = $('input[name="repo-branch"]', b); branch.dataset.np = 'branch'; branch.dataset.fk = 'np-branch'; branch.value = st.branch;
    submit.dataset.np = 'submit'; submit.dataset.fk = 'np-submit';
    cancel.dataset.np = 'cancel'; cancel.dataset.fk = 'np-cancel';
    $('.dialog__close', b).dataset.np = 'close';
    for (const r of $$('input[name="source-type"]', b)) { r.checked = r.value === st.source; r.dataset.fk = `np-src-${r.value}`; }
    // 来源切到「空项目」时仓库地址与分支两栏整块不渲染（不是置灰，REQ-PRJ-002）
    const fields = $('.fields', b);
    const place = () => {
      if (st.source === 'git') { if (!repoField.isConnected) { fields.appendChild(repoField); fields.appendChild(branchField); } }
      else { repoField.remove(); branchField.remove(); }
    };
    const sync = () => {
      const ok = st.name.trim() && (st.source === 'empty' || st.repo.trim());
      submit.disabled = !ok;
    };
    place(); sync();
    const form = $('form', b);
    form.addEventListener('input', (e) => {
      if (e.target === name) st.name = name.value;
      if (e.target === repo) st.repo = repo.value;
      if (e.target === branch) st.branch = branch.value;
      const err = $('[data-np="error"]', b); if (err) err.remove();
      sync();
    });
    form.addEventListener('change', (e) => {
      if (e.target.name === 'source-type') { st.source = e.target.value; place(); sync(); }
    });
    cancel.addEventListener('click', () => P.closeModal(npDialog.m));
    $('.dialog__close', b).addEventListener('click', () => P.closeModal(npDialog.m));
    form.addEventListener('submit', (e) => { e.preventDefault(); if (!submit.disabled) submitProject(b, st); });
  }
  function setFormBusy(b, busy) {
    const submit = $('[data-np="submit"]', b);
    // 第五段（R1-03）：[创建项目] 进行中用 aria-disabled + aria-busy（P.setBusy），焦点不丢；在输入框里按回车提交的，焦点先交给这颗按钮再禁用字段
    if (busy && b.contains(document.activeElement) && document.activeElement !== submit) submit.focus({ preventScroll: true });
    P.setBusy(submit, busy, busy ? P.busyHtml('创建中…') : '创建项目');
    for (const el of $$('input', b)) el.disabled = busy;
    $('[data-np="cancel"]', b).disabled = busy;
    $('[data-np="close"]', b).disabled = busy;
    npDialog.m.busy = busy;
  }
  function submitProject(b, st) {
    setFormBusy(b, true);
    P.announce('创建中…');
    P.clock.after(T.submitProject, () => {
      if (!npDialog || !b.isConnected) return;
      setFormBusy(b, false);
      const name = st.name.trim();
      const scen = P.scenario.take('project-submit');
      let err = null;
      if (world.projects.some((p) => p.name === name)) err = '项目名已存在，请换一个名称。';
      else if (scen === 'invalid-url' && st.source === 'git') err = '这个仓库地址看起来不对，检查一下再试。';
      else if (scen === 'limit') err = '项目数量已经到上限（最多 50 个）。先删掉一个用不上的项目，再建新的。';
      else if (scen === 'offline') err = '网络不通，请稍后再试。';
      if (err) {
        // 被拒：弹层不关、输入全部保留，最后一个字段之后一句（role="alert"；f-prj-create-03）
        const note = P.fromTpl('tpl-np-error', { keepRoles: true });
        note.dataset.np = 'error';
        $('.note__text', note).textContent = err;
        $('.dialog__body', b).appendChild(note);
        $('[data-np="submit"]', b).disabled = false;
        $('[data-np="name"]', b).focus();
        return;
      }
      const id = P.newId('p');
      const first = !world.projects.length; // 第一个项目（欢迎态建的）：建好后选中它（F-WB-WELCOME，flows-wb.js 接 'project:created'）
      const p = { id, name, avatar: avatarOf(name), createdAt: P.fmtFull(P.clock.wall()), branches: [] };
      if (st.source === 'empty') {
        // 空项目：提交即就绪，直接关弹层、选中它、落到「还没有任务」（不经进度视图，不发轻提示；REQ-PRJ-006）
        Object.assign(p, { source: 'empty', status: 'ready', repoShort: '空项目', branch: null });
        world.projects.push(p);
        ui.expanded[id] = true;
        P.closeModal(npDialog.m, { restoreFocus: false });
        npDialog = null;
        P.announce(`已创建空项目「${name}」`);
        P.go(`project-${id}`);
        return;
      }
      Object.assign(p, { source: 'git', repo: st.repo.trim(), repoShort: repoShortOf(st.repo.trim()), branch: st.branch.trim() || null });
      world.projects.push(p);
      startClone(p);
      npDialog.pid = id;
      P.render(); // 树里立即出现「克隆中」、总览卡 +1、⌘K 与新建任务下拉同源
      P.emit('project:created', p, { first });
      npDialog.ctl.show('progress', { pid: id });
      P.announce(`正在克隆项目「${name}」…`);
    });
  }
  function initProgress(b, pid) {
    const p = P.proj(pid);
    $('.empty__subject', b).textContent = p.name;
    const pr = $('.progress', b);
    pr.dataset.liveClone = pid;
    pr.setAttribute('role', 'status'); pr.setAttribute('aria-live', 'polite'); // 进度块以 polite 播报（按钮不在 live 区域里，REQ-PRJ-004）
    const back = $('.empty__actions .btn', b);
    back.dataset.np = 'back'; back.dataset.fk = 'np-back';
    back.addEventListener('click', () => { P.closeModal(npDialog.m); }); // 只关弹层，不中断克隆
    $('[data-np="close"]', b).addEventListener('click', () => P.closeModal(npDialog.m));
    if (p.clone) paintProgress(pr, p);
  }
  function initDone(b, pid) {
    const p = P.proj(pid);
    $('.empty__subject', b).textContent = p.name;
    const open = $('.empty__actions .btn', b);
    open.dataset.np = 'open'; open.dataset.fk = 'np-open';
    open.addEventListener('click', () => { P.closeModal(npDialog.m, { restoreFocus: false }); npDialog = null; ui.expanded[pid] = true; P.go(`project-${pid}`); });
    $('[data-np="close"]', b).addEventListener('click', () => P.closeModal(npDialog.m));
  }
  function initFailed(b, pid) {
    const p = P.proj(pid);
    const f = failOf(p);
    const card = $('.empty--outcome', b);
    card.dataset.code = p.failCode;
    $('.empty__subject', card).textContent = p.name;
    $('.empty__desc', card).textContent = f.desc;
    const row = $('.btn-row', card);
    row.innerHTML = (f.retry
      ? `<button class="btn btn--secondary" type="button" data-np="retry" data-fk="np-retry">重试克隆</button>`
      : `<button class="btn btn--secondary" type="button" data-np="creds" data-fk="np-creds">配置 Git 凭证</button>`)
      + `<button class="btn btn--tertiary" type="button" aria-describedby="np-note" data-np="empty" data-fk="np-empty">改为空项目</button>`;
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-np]'); if (!btn) return;
      if (btn.dataset.np === 'retry') { P.retryClone(p); npDialog.ctl.show('progress', { pid }); }
      else if (btn.dataset.np === 'creds') { P.closeModal(npDialog.m, { restoreFocus: false }); npDialog = null; P.configureGitCredentials(p); }
      else if (btn.dataset.np === 'empty') { P.closeModal(npDialog.m, { restoreFocus: false }); npDialog = null; P.convertToEmpty(p); }
    });
    $('[data-np="close"]', b).addEventListener('click', () => P.closeModal(npDialog.m));
  }
  // 克隆落定时，弹层还开着就换视图（完成 / 失败）
  P.hook('clone:done', (p, code) => {
    if (!npDialog || npDialog.pid !== p.id || !P.modals.includes(npDialog.m)) return;
    npDialog.ctl.show(code ? 'failed' : 'done', { pid: p.id });
  });
  P.hook('palette.items', () => [{ g: '动作', label: '新建项目…', keywords: '创建项目 新建 项目', icon: '<span class="icon i-folder-plus" aria-hidden="true"></span>', run: (ret) => P.openNewProject({}, ret) }]);

  // ------------------------------------------------------------------ F-PRJ-INFO 项目信息浮层与拉取最新代码（f-prj-info-01…05）
  const pullResult = {}; // 项目 id → { kind: 'ok' | 'fail', code }
  function infoHtml(p) {
    const tpl = P.fromTpl(p.source === 'empty' ? 'tpl-pop-empty' : 'tpl-pop-git');
    $('.popover__title', tpl).textContent = p.name;
    const dd = $$('.kv > dd', tpl);
    if (p.source === 'empty') {
      dd[0].textContent = '空项目（没有关联仓库）';
      dd[1].textContent = p.createdAt;
    } else {
      dd[0].textContent = p.repo;
      dd[1].textContent = p.branch || '远端默认分支';
      dd[2].textContent = p.size;
      dd[3].innerHTML = p.pulledShort === '刚刚' ? `<time datetime="${esc(p.pulledFull)}" title="${esc(p.pulledFull)}">刚刚</time>` : esc(p.pulledFull || p.pulled);
      const btn = $('.popover__actions .btn', tpl);
      btn.dataset.fk = 'pi-pull';
      if (ui.pulling[p.id]) {
        btn.className = 'btn btn--secondary btn--32';
        P.setBusy(btn, true, P.busyHtml('正在拉取…')); // 第五段（R1-01）：进行中不用原生 disabled，焦点留在浮层里这颗按钮上
        btn.setAttribute('aria-label', '正在拉取最新代码');
        const st = document.createElement('p'); st.className = 'u-sr-only'; st.setAttribute('role', 'status'); st.textContent = `正在拉取 ${p.name} 的最新代码…`;
        $('.popover__body', tpl).appendChild(st);
      } else { btn.dataset.action = 'pull'; btn.dataset.project = p.id; }
      const r = pullResult[p.id];
      if (r && !ui.pulling[p.id]) {
        const msg = P.fromTpl(r.kind === 'ok' ? 'tpl-pop-ok' : 'tpl-pop-fail', { keepRoles: true });
        if (r.kind === 'fail') {
          const span = $('.popover__msg-body > span', msg);
          const link = $('.popover__msg-body .link', msg);
          if (r.code === 'network') { span.textContent = '网络不通，没拉下来。检查网络后再点「拉取最新代码」。'; link.remove(); }
          else { link.dataset.action = 'pull-creds'; link.dataset.project = p.id; link.dataset.fk = 'pi-creds'; }
        }
        $('.popover__body', tpl).appendChild(msg);
      }
    }
    return tpl.innerHTML;
  }
  P.openProjectInfo = function openProjectInfo(trigger, { focus = true } = {}) {
    const p = P.proj(P.currentProjectId());
    if (!p || p.status !== 'ready') return;
    if (P.popover.isOpenFor('pi') && focus) { P.popover.close(true); return; } // 再点一次触发器 = 关
    P.popover.open(trigger, { id: 'pi', html: infoHtml(p), fks: ['h-chip', 'h-info'], focus, onClose: () => { delete pullResult[p.id]; P.refreshMain(); } });
    P.refreshMain();
  };
  P.actions['project-info'] = (a) => P.openProjectInfo(a);
  P.pullProject = function pullProject(p) {
    if (!p || p.status !== 'ready' || p.source === 'empty' || ui.pulling[p.id]) return;
    ui.pulling[p.id] = true;
    delete pullResult[p.id];
    if (P.popover.isOpenFor('pi')) P.popover.update(infoHtml(p));
    P.refreshMain();
    P.announce(`正在拉取 ${p.name} 的最新代码…`);
    P.clock.after(T.pull, () => {
      let scen = P.scenario.take('pull');
      if (scen === 'ok') scen = P.ask('git.access', p) || 'ok'; // Git 凭证删掉之后私有仓拉不下来（F-CRD-GIT 联动）
      ui.pulling[p.id] = false;
      if (scen === 'ok') {
        if (p.id === 'web') p.size = '46 MB';
        const now = P.clock.wall();
        p.pulledFull = P.fmtFull(now); p.pulled = p.pulledFull; p.pulledShort = '刚刚';
        pullResult[p.id] = { kind: 'ok' };
        if (P.popover.isOpenFor('pi')) P.popover.update(infoHtml(p));
        else { delete pullResult[p.id]; }
        P.announce('已更新到最新；已建好的任务不受影响'); // 浮层关着时不自动打开，只播报（AC-PRJ-022.6）
      } else {
        pullResult[p.id] = { kind: 'fail', code: scen };
        if (P.popover.isOpenFor('pi')) P.popover.update(infoHtml(p));
        else if (P.currentProjectId() === p.id) {
          // 浮层关着时失败：自动打开、贴在触发器下、不抢焦点（Q-PRJ-08 A；AC-PRJ-022.5）
          const trig = [$('[data-fk="h-chip"]'), $('[data-fk="h-info"]')].find((x) => P.isShown(x));
          if (trig) P.openProjectInfo(trig, { focus: false });
        }
        P.announce(scen === 'network' ? '网络不通，没拉下来。' : '远端拒绝了这次访问：凭证无效或没有这个仓库的权限。');
      }
      P.render();
    });
  };
  P.actions.pull = (a) => P.pullProject(P.proj(a.dataset.project || P.currentProjectId()));
  P.actions['pull-creds'] = (a) => { const p = P.proj(a.dataset.project); P.popover.close(false); ui.focusSection = 'sec-git'; ui.pendingProjectSync = { projectId: p.id }; P.go('credentials'); };

  // ------------------------------------------------------------------ F-PRJ-DETAIL 项目详情（f-prj-detail-01；零按钮，只有右上关闭）
  P.openProjectDetail = function openProjectDetail(p, returnTo) {
    const box = P.fromTpl('tpl-project-detail');
    box.dataset.dialog = 'project-detail';
    $('.dialog__subtitle', box).textContent = p.name;
    const dd = $$('.kv > dd', box);
    dd[0].textContent = p.status === 'ready' ? '可用' : p.status === 'cloning' ? '正在克隆' : '克隆失败';
    dd[1].textContent = String(P.tasksOf(p.id).length);
    dd[2].textContent = p.createdAt || '—';
    // 计数不知道（读取失败）写「—」，不写 0（REQ-PRJ-030）
    dd[3].textContent = P.scenario.is('retained', 'fail') ? '—' : `${P.retainedOf(p.id).length} 项`;
    dd[4].textContent = `${P.automationsOf(p.id).length} 条`;
    if (p.status === 'failed') {
      const hint = document.createElement('p');
      hint.className = 'hint proto-detail-hint';
      hint.innerHTML = '<span class="icon i-info" aria-hidden="true"></span>克隆没成功。[重试克隆] 和 [改为空项目] 在项目名右边的「⋯」菜单里，不用删掉重建。';
      $('.dialog__body', box).appendChild(hint);
    }
    const m = P.openModal(box, { kind: 'project-detail', returnTo, initialFocus: '.dialog__close' });
    $('.dialog__close', m.box).addEventListener('click', () => P.closeModal(m));
    return m;
  };

  // ------------------------------------------------------------------ F-PRJ-DELETE 删除项目（f-prj-delete-01…04；打开即按数据选态，不等按下才被拒）
  function deleteState(p) {
    const ts = P.tasksOf(p.id);
    return { ts, active: ts.filter((t) => P.ACTIVE.has(t.state)), live: P.retainedOf(p.id), rules: P.automationsOf(p.id) };
  }
  function bullets(items) { return `<ul class="bullets">${items.map((x) => `<li>${x}</li>`).join('')}</ul>`; }
  const meta = (s) => ` <span class="dconfirm__meta">（${esc(s)}）</span>`;
  P.openDeleteProject = function openDeleteProject(p, returnTo) {
    const { ts, active, live, rules } = deleteState(p);
    const kind = p.status === 'cloning' ? 'cloning' : active.length || live.length ? 'blocked' : 'ok';
    const box = P.fromTpl(kind === 'cloning' ? 'tpl-del-cloning' : kind === 'blocked' ? 'tpl-del-blocked' : 'tpl-del-ok');
    box.dataset.dialog = 'delete-project';
    $('.dialog__title', box).textContent = `删除项目「${p.name}」？`;
    const sub = $('.dialog__subtitle', box);
    const stopped = ts.filter((t) => !P.ACTIVE.has(t.state));
    const allStopped = stopped.length && stopped.every((t) => t.state === 'stopped');
    sub.textContent = p.status === 'cloning' ? '项目 · 正在克隆'
      : p.status === 'failed' ? '项目 · 克隆失败'
        : !ts.length ? '项目 · 还没有任务'
          : active.length ? `项目 · ${ts.length} 个任务，其中 ${active.length} 个还在活动`
            : `项目 · ${ts.length} 个任务，${allStopped ? '都已停止' : '都已停止或异常'}`;
    const blocks = $$('.dconfirm__block', box);
    // 「会删掉」（可删）/「处理完之后，会删掉」（被拦）：没有的那一项不写
    const willDelete = [];
    if (p.status === 'cloning') {
      const mb = p.clone ? cloneView(p).recv || '0 MB' : '0 MB';
      willDelete.push(`正在进行的这次克隆：先停掉，已经下载的 ${esc(mb)} 直接丢弃`);
      willDelete.push(`项目「${esc(p.name)}」本身${meta('还没有任务、保留成果和自动化规则')}`);
    } else if (kind === 'blocked') {
      if (active.length) willDelete.push(`这个项目下剩下的任务和它们的代码副本${meta(`现在共 ${ts.length} 个`)}`);
      else if (ts.length) willDelete.push(`${ts.length} 个任务和它们的代码副本：${ts.map((t) => esc(t.name)).join('、')}${meta(allStopped ? '都已停止' : '都已停止或异常')}`);
      if (p.source === 'git' && p.status === 'ready') willDelete.push(`这台机器上的仓库副本${meta(p.size)}`);
      if (rules.length) willDelete.push(`${rules.length} 条自动化规则，以及${rules.length > 1 ? '它们' : '它'}的运行历史`);
    } else if (p.status === 'failed') {
      willDelete.push(`项目「${esc(p.name)}」本身${meta('克隆没成功，这台机器上没有它的代码；也没有任务、保留成果和自动化规则')}`);
    } else {
      if (ts.length) willDelete.push(`${ts.length} 个任务和它们的代码副本：${ts.map((t) => esc(t.name)).join('、')}${meta(allStopped ? '都已停止' : '都已停止或异常')}`);
      if (p.source === 'git') willDelete.push(`这台机器上的仓库副本${meta(p.size)}`);
      if (rules.length) willDelete.push(`${rules.length} 条自动化规则，以及${rules.length > 1 ? '它们' : '它'}的运行历史`);
    }
    const listBlock = blocks[0];
    $('.bullets', listBlock).outerHTML = bullets(willDelete);
    if (kind === 'blocked') {
      // 拦截块：活跃任务逐个列「名字 · 状态」+ [去停止或销毁]；没清理的成果一句 + [去清理]（REQ-PRJ-040；f-prj-delete-02）
      const note = $('.note--warn', box);
      $('.note__title', note).textContent = active.length ? `请先停止或销毁 ${active.length} 个还在活动的任务` : `请先清理 ${live.length} 份保留下来的成果`;
      const items = [];
      if (active.length) items.push(`<li class="l1b-blockers__item"><p class="l1b-blockers__text">${active.map((t) => `<span class="u-nowrap">${esc(t.name)} <span class="l1b-state">· ${esc(P.STATE[t.state].word)}</span></span>`).join('、')}</p><button class="btn btn--secondary btn--28" type="button" data-del="goto" data-fk="del-goto">去停止或销毁</button></li>`);
      if (live.length) items.push(`<li class="l1b-blockers__item"><p class="l1b-blockers__text">还有 ${live.length} 份保留下来的成果没清理：${live.map((r) => `<span class="u-nowrap">${esc(r.name)}</span>`).join('、')}<span class="l1b-state">（也可以等${live.length > 1 ? '它们' : '它'}到期自动清理）</span></p><button class="btn btn--secondary btn--28" type="button" aria-haspopup="dialog" data-del="clean" data-fk="del-clean">去清理</button></li>`);
      $('.l1b-blockers', note).innerHTML = items.join('');
      note.removeAttribute('role');
      const why = active.length && live.length ? `先停止或销毁上面 ${active.length} 个任务，并清理 ${live.length} 份成果` : active.length ? `先停止或销毁上面 ${active.length} 个任务` : `先清理上面 ${live.length} 份成果`;
      $('#del-why', box).textContent = why;
      const danger = $('.btn--danger', box);
      danger.dataset.reason = why;
      danger.dataset.fk = 'del-confirm';
    }
    const src = $('.dconfirm__source', box);
    if (kind === 'ok') src.textContent = !ts.length && !live.length ? `清单来源：后端返回（任务列表、保留成果列表、自动化规则）。这个项目现在没有任务，也没有保留成果。` : '清单来源：后端返回（任务列表、保留成果列表、自动化规则）。这个项目现在没有活跃任务，也没有没清理的保留成果。';
    // 「不受影响」：克隆中只有远端仓库一条（稿件原样）
    const cancel = $('.dialog__footer > .btn', box); cancel.dataset.del = 'cancel'; cancel.dataset.fk = 'del-cancel';
    $('.dialog__close', box).dataset.del = 'cancel';
    const danger = $('.btn--danger', box); danger.dataset.fk = 'del-confirm'; if (kind !== 'blocked') danger.dataset.del = 'confirm';
    if (kind === 'cloning') { const b = $('.note__actions .btn', box); b.dataset.del = 'cancel-clone'; b.dataset.fk = 'del-cancel-clone'; }
    const m = P.openModal(box, { kind: 'delete-project', returnTo, initialFocus: '[data-initial-focus]' });
    m.box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-del]'); if (!b || b.disabled) return;
      const k = b.dataset.del;
      if (k === 'cancel') P.closeModal(m);
      else if (k === 'goto') { P.closeModal(m, { restoreFocus: false }); P.locateProject(p.id); }
      else if (k === 'clean') { const ret = m.returnTo; P.closeModal(m, { restoreFocus: false }); P.openRetained(p.id, ret); }
      else if (k === 'cancel-clone') { P.closeModal(m); P.cancelClone(p); }
      else if (k === 'confirm') confirmDelete(m, p);
    });
    return m;
  };
  function confirmDelete(m, p) {
    const box = m.box;
    const danger = $('[data-del="confirm"]', box);
    const old = $('.l1b-fail', box); if (old) old.remove();
    // 删除中：按钮转圈禁用，[取消] 与关闭也禁用，Esc / 点遮罩都不关（REQ-PRJ-043）
    m.busy = true;
    P.setBusy(danger, true, P.busyHtml('删除中…')); // 第五段（R1-03）：焦点留在 [删除项目] 上
    for (const b of $$('[data-del="cancel"]', box)) b.disabled = true;
    const st = document.createElement('p'); st.className = 'u-sr-only'; st.setAttribute('role', 'status'); st.textContent = `正在删除项目「${p.name}」…`; st.dataset.del = 'status';
    $('.dconfirm', box).appendChild(st);
    P.clock.after(T.deleteProject, () => {
      const scen = P.scenario.take('delete-project');
      if (scen === 'fail') {
        m.busy = false;
        st.remove();
        P.setBusy(danger, false, '删除项目');
        for (const b of $$('[data-del="cancel"]', box)) b.disabled = false;
        const fail = P.fromTpl('tpl-del-fail', { keepRoles: true });
        $('.dconfirm', box).appendChild(fail);
        danger.focus();
        return;
      }
      const { ts, rules } = deleteState(p);
      const wasHere = P.currentProjectId() === p.id;
      // 同一次删掉：项目、它的任务、成果（应为空）、规则；树 / 总览 / ⌘K / 新建任务下拉 / 导航徽标全部由 render 重算（REQ-PRJ-044）
      world.tasks.splice(0, world.tasks.length, ...world.tasks.filter((t) => t.project !== p.id));
      for (const t of ts) delete ui.tabs[t.id];
      world.retained.splice(0, world.retained.length, ...world.retained.filter((r) => r.project !== p.id));
      world.automations.splice(0, world.automations.length, ...world.automations.filter((a) => a.project !== p.id));
      world.projects.splice(world.projects.indexOf(p), 1);
      delete ui.expanded[p.id];
      if (ui.pinned === p.id) ui.pinned = null;
      const what = ts.length || rules.length
        ? `它的${ts.length ? ` ${ts.length} 个任务` : ''}${ts.length && rules.length ? '和' : ''}${rules.length ? ` ${rules.length} 条自动化规则` : ''}一起删掉了；远端 Git 仓库不受影响。`
        : p.source === 'git' && p.status === 'ready' ? '这台机器上的仓库副本一起删掉了；远端 Git 仓库不受影响。' : '远端 Git 仓库不受影响。';
      m.busy = false;
      P.closeModal(m, { restoreFocus: false });
      if (wasHere) {
        // 删的正是当前项目：主区回项目总览 + 页内提示；同步换路由（被删的项目不留在历史记录里、中间不会有指着它的渲染）
        ui.notice = { key: 'overview', title: `已删除项目「${p.name}」`, text: what, fresh: true, protoNote: '原型：只在本页内存里删除，刷新即复原' };
        P.replaceRoute('overview');
      } else {
        P.render();
        P.announce(`已删除项目「${p.name}」。${what}`);
        P.focusMain();
      }
    });
  }

  // ------------------------------------------------------------------ F-PRJ-RETAINED 保留下来的成果（f-prj-retained-01…05；一个对话框、视图在里面切、不叠遮罩）
  const DAY = 86400e3;
  function expiresIn(r) { return (P.parseFull(r.retainedAt) + r.keepDays * DAY - P.clock.wall()) / DAY; }
  function leftHtml(r) {
    const d = expiresIn(r);
    if (d >= 1) return { warn: false, text: `还需 ${Math.floor(d)} 天` };
    return { warn: true, text: d > 0 ? '不足 1 天' : '即将清理' };
  }
  P.retainedLeft = (r) => leftHtml(r).text;
  const sortRv = (a, b) => expiresIn(a) - expiresIn(b);
  const sum = (list, k) => list.reduce((s, r) => s + r[k], 0);
  P.retainedSummary = () => { const all = world.retained; return { count: all.length, diskMB: sum(all, 'diskMB'), dlMB: sum(all, 'dlMB'), earliest: all.slice().sort(sortRv)[0] || null }; };
  const SRC_WORD = { 'manual-destroy': '销毁任务时保留', 'automation-artifact': '自动化产物' };
  function rowHtml(r, busy) {
    const left = leftHtml(r);
    const end = left.warn ? `<span class="badge badge--20 badge--warn"><span class="icon i-triangle-alert" aria-hidden="true"></span>${left.text}</span>` : `<span class="l1b-rv__left">${left.text}</span>`;
    const dl = P.fmtMB(r.dlMB);
    const del = busy
      ? `<button class="btn btn--danger-tertiary btn--28 is-loading" type="button" aria-disabled="true" aria-busy="true" data-fk="rv-del:${r.id}"><span class="icon icon--spin i-loader-circle" aria-hidden="true"></span>删除中…</button>` // 第五段（R1-03）：确认后回到列表，焦点还给这一行的 [删除]（删除中…），不落到 body
      : `<button class="btn btn--danger-tertiary btn--28" type="button" aria-haspopup="dialog" data-rv="del" data-rv-id="${r.id}" data-fk="rv-del:${r.id}">删除</button>`;
    return `<li class="list__row l1b-rv"><div class="list__line"><span class="l1b-rv__lead"><span class="icon i-gift" aria-hidden="true"></span></span><span class="list__name l1b-rv__name" title="来源任务 ${esc(r.sandboxId)}">${esc(r.name)}</span>${end}</div><p class="l1b-rv__meta">${SRC_WORD[r.source] || '销毁任务时保留'} · 保留于 ${esc(r.retainedAt)}</p><p class="l1b-rv__meta">占用 <span class="l1b-num">${P.fmtMB(r.diskMB)}</span> · 下载 <span class="l1b-num">${dl}</span></p><div class="btn-row l1b-rv__actions"><a class="btn btn--secondary btn--28${busy ? ' is-disabled' : ''}" href="#" data-rv="dl" data-rv-id="${r.id}" data-fk="rv-dl:${r.id}"${busy ? ' aria-disabled="true"' : ''}><span class="icon i-download" aria-hidden="true"></span>下载（${dl}）</a>${del}</div></li>`;
  }
  const totalsHtml = (list) => `共 ${list.length} 个 · 占用 <span class="l1b-num">${P.fmtMB(sum(list, 'diskMB'))}</span> · 全部下载 <span class="l1b-num">${P.fmtMB(sum(list, 'dlMB'))}</span>`;
  P.openRetained = function openRetained(scope, returnTo) {
    const st = { scope: scope || null, cross: scope == null, busy: new Set(), loading: false };
    const box = P.fromTpl('tpl-rv-list');
    box.dataset.dialog = 'retained';
    const m = P.openModal(box, { kind: 'retained', returnTo });
    const ctl = P.dialogViews(m, {
      list: () => listView(st),
      confirm: (a) => confirmView(st, a.id),
    });
    m.box.addEventListener('click', (e) => onClick(e, st, ctl, m));
    m.box.addEventListener('change', (e) => { if (e.target.matches('[data-rv="scope"]')) { st.scope = e.target.value || null; ctl.show('list', {}, { focus: '[data-rv="scope"]' }); } });
    ctl.show('list', {}, { focus: st.cross ? '[data-rv="scope"]' : '.dialog__close' });
    return m;
  };
  function listView(st) {
    const scopeP = st.scope && P.proj(st.scope);
    const tpl = P.fromTpl(st.cross ? 'tpl-rv-cross' : 'tpl-rv-list');
    const sub = $('.dialog__subtitle', tpl);
    sub.textContent = scopeP ? `在 ${scopeP.name} 中` : '全部项目';
    const body = $('.dialog__body', tpl);
    const list = P.retainedOf(st.scope).sort(sortRv);
    const intro = $('.l1b-rv-intro', body);
    if (!st.cross) intro.textContent = `${scopeP.name} 保留下来的成果：销毁任务时选择留下的那份代码副本。到期后由后台自动清理。`;
    // 读取失败（场景）：失败提示 + [重试]，不显示空态或合计（REQ-PRJ-054；f-prj-retained-04）
    if (P.scenario.is('retained', 'fail') || st.loading) {
      const fail = P.fromTpl('tpl-rv-fail', { keepRoles: true });
      const retry = $('.note__end .btn', fail); retry.dataset.rv = 'retry'; retry.dataset.fk = 'rv-retry';
      if (st.loading) P.setBusy(retry, true, P.busyHtml('重试')); // 第五段（R1-03）：重试中焦点留在它上面
      for (const el of $$(':scope > :not(.l1b-rv-intro)', body)) el.remove();
      if (st.cross) intro.textContent = '按项目分组；删掉一份，马上腾出它「占用」那么多磁盘。到期的由后台自动清理。';
      body.appendChild(fail);
      return { html: tpl.innerHTML, init: (b) => initList(b, st), focus: '[data-rv="retry"]' };
    }
    if (!list.length) {
      // 空态（f-prj-retained-03）；跨项目视图一份都没有时标题改「还没有保留下来的成果」
      const empty = P.fromTpl('tpl-rv-empty');
      if (!scopeP) $('.empty__title', empty).textContent = '还没有保留下来的成果';
      for (const el of $$(':scope > :not(.l1b-rv-intro)', body)) el.remove();
      body.appendChild(empty);
      return { html: tpl.innerHTML, init: (b) => initList(b, st) };
    }
    if (st.cross) {
      // 跨项目视图：范围选择 + 合计同一行，按项目分组（组按项目顺序，组头「N 个 · 占用 X」；REQ-PRJ-056）
      const sel = $('.l1b-scope select', body);
      const withRv = world.projects.filter((p) => P.retainedOf(p.id).length);
      sel.innerHTML = `<option value="">全部项目</option>${withRv.map((p) => `<option value="${p.id}"${p.id === st.scope ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}`;
      sel.dataset.rv = 'scope'; sel.dataset.fk = 'rv-scope';
      $('.l1b-rv-totals', body).innerHTML = totalsHtml(list);
      const groups = world.projects.filter((p) => (!st.scope || p.id === st.scope) && P.retainedOf(p.id).length);
      $('.l1b-groups', body).innerHTML = groups.map((p) => {
        const rs = P.retainedOf(p.id).sort(sortRv);
        return `<section class="l1b-group" aria-label="${esc(p.name)}：${rs.length} 个，占用 ${P.fmtMB(sum(rs, 'diskMB'))}"><h3 class="l1b-group-head"><span class="icon i-folder" aria-hidden="true"></span>${esc(p.name)}<span class="l1b-group-head__meta">${rs.length} 个 · 占用 ${P.fmtMB(sum(rs, 'diskMB'))}</span></h3><ul class="list list--stack l1b-rv-list" aria-label="${esc(p.name)} 保留下来的成果">${rs.map((r) => rowHtml(r, st.busy.has(r.id))).join('')}</ul></section>`;
      }).join('');
    } else {
      $('.l1b-rv-totals', body).innerHTML = totalsHtml(list);
      const ul = $('.l1b-rv-list', body);
      ul.setAttribute('aria-label', `${scopeP.name} 保留下来的成果`);
      ul.innerHTML = list.map((r) => rowHtml(r, st.busy.has(r.id))).join('');
    }
    return { html: tpl.innerHTML, init: (b) => initList(b, st) };
  }
  function initList(b) { const c = $('.dialog__close', b); if (c) c.dataset.rv = 'close'; }
  function confirmView(st, id) {
    const r = world.retained.find((x) => x.id === id);
    const p = P.proj(r.project);
    const tpl = P.fromTpl('tpl-rv-confirm');
    $('.dialog__title', tpl).textContent = `删除成果「${r.name}」？`;
    $('.dialog__subtitle', tpl).textContent = `${p.name} · ${SRC_WORD[r.source]} · ${leftHtml(r).text}`;
    const blocks = $$('.dconfirm__block', tpl);
    $('.bullets', blocks[0]).innerHTML = `<li>这份代码副本${meta(`占用 ${P.fmtMB(r.diskMB)}`)}</li>`;
    const others = P.retainedOf(p.id).length - 1;
    const n = P.tasksOf(p.id).length;
    $('.bullets', blocks[2]).innerHTML = `${others > 0 ? `<li>同项目里另外 ${others} 份成果</li>` : ''}<li>${esc(p.name)}本身，以及它的 ${n} 个任务</li>`;
    const cancel = $('.dialog__footer > .btn', tpl); cancel.dataset.rv = 'back'; cancel.dataset.fk = 'rv-back';
    const danger = $('.btn--danger', tpl); danger.dataset.rv = 'confirm'; danger.dataset.rvId = id; danger.dataset.fk = 'rv-confirm';
    $('.dialog__close', tpl).dataset.rv = 'close';
    return { html: tpl.innerHTML, focus: '[data-initial-focus]' };
  }
  function onClick(e, st, ctl, m) {
    const b = e.target.closest('[data-rv]'); if (!b) return;
    const k = b.dataset.rv;
    if (k === 'close') { P.closeModal(m); return; }
    if (k === 'scope') return;
    e.preventDefault();
    if (k === 'dl') { if (b.getAttribute('aria-disabled') !== 'true') P.toast('neutral', '已开始下载', '原型不产生文件'); return; } // 产品里是浏览器原生下载、没有轻提示（REQ-PRJ-052）
    if (k === 'del') { ctl.push('confirm', { id: b.dataset.rvId }, { returnFk: `rv-del:${b.dataset.rvId}` }); return; }
    if (k === 'back') { ctl.back(); return; }
    if (k === 'confirm') {
      const id = b.dataset.rvId;
      const r = world.retained.find((x) => x.id === id);
      st.busy.add(id);
      ctl.back(); // 回到列表：只有这一行显示删除中（REQ-PRJ-053）
      const fkAfter = () => { const next = $('[data-rv="del"]', m.box) || $('[data-rv="scope"]', m.box) || $('.dialog__close', m.box); return next; };
      P.clock.after(T.deleteRetained, () => {
        st.busy.delete(id);
        const i = world.retained.indexOf(r); if (i >= 0) world.retained.splice(i, 1);
        if (P.modals.includes(m)) { ctl.show('list'); const f = fkAfter(); if (f) f.focus(); }
        P.announce(`已删除成果「${r.name}」`);
        P.render(); // 项目详情计数、删除项目的拦截块、⌘K、系统状态成果占用都从 RETAINED 现算
      });
      return;
    }
    if (k === 'retry') {
      st.loading = true; ctl.show('list');
      P.clock.after(T.retainedRetry, () => { st.loading = false; P.scenario.set('retained', 'ok'); if (P.modals.includes(m)) ctl.show('list', {}, { focus: st.cross ? '[data-rv="scope"]' : '.dialog__close' }); });
    }
  }
})();
