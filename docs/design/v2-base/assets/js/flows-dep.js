/*
 * 交互原型 · 启动检查与初始化向导（js/flows-dep.js）：F-DEP-INIT（第三段接线）
 *   启动检查中（f-dep-init-01）：init-status 回来之前整屏一句，外壳、向导、口令门都不挂；判定之后只挂一个——口令门（flows-crd.js，先于这里）/ 向导 / 工作台；
 *     读不到（场景「系统状态 › 连接：后端不可达」）→ 放行进工作台 + 横幅「无法确认平台状态」，不掉进向导（REQ-DEP-001、002）
 *   向导五步（外壳之外整屏阻断、不可关闭；f-dep-init-02…14）：联网检查（先显示上次结果，没有才自动跑；[重新检测] 3 秒节流；离线要显式确认）→
 *     代理配置（只在联网有失败项时进流程，否则「可跳过」；保存并重新检测）→ 沙箱镜像（五项检查链；第 5 项「没下载到本机」自动开始准备，复用镜像段的「下载到本机」块）→
 *     模型帐号（同一个登录面板，宿主 wizard；至少一个可用才不拦）→ 本机资源（偏低不是门）→ [确认，开始使用]（写入失败 / 网络断开 → [重试]；409 写入时发现离线 → 回第 1 步；
 *     409 已经初始化过了 → 直接放行，REQ-DEP-016）→ 卸载向导、进工作台
 *   入口：场景「首次启动 › 初始化状态：未初始化」（#…&scenario=init:fresh 同）或实例菜单「演示初始化向导…」——示例世界换成首次启动的世界（没有项目与任务、
 *     两个 Agent 都没配、预制镜像没下载、审计为空；notes/dep.md §5）
 * 标记来源：gap/drafts/f-dep-init-01…14（index.html 的 tpl-dep-*、tpl-auth-wiz，build-proto.cjs 同源拷贝）；检查行、Agent 行、资源行按同一套类名由本文件按数据画。
 * 产品口径：gap/product/DEP.md（AC 的 Then）；接线要点：gap/drafts/notes/dep.md §6；待定问题按 open-questions 的默认（Q-DEP-01 A、Q-DEP-02 A、Q-SYS-16 A）。
 */
(function () {
  'use strict';
  const P = window.P;
  const { $, $$, esc, ui } = P;
  const world = P.world;
  const T = P.TIMING;
  const frag = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; };

  // ------------------------------------------------------------------ 场景（「原型说明 › 场景 › 首次启动」，与访问口令同一组）
  const G = '首次启动';
  P.scenario.define({ key: 'init', group: G, label: '初始化状态', def: 'done', options: [['done', '已初始化（示例世界）'], ['fresh', '未初始化：首次启动（启动检查 → 初始化向导）']] });
  P.scenario.define({ key: 'init-history', group: G, label: '向导 · 上次联网检查', def: 'ok', options: [['ok', '有（2026-10-01 18:40:12，全部连得上）'], ['none', '没有（进向导自动跑一轮）']] });
  P.scenario.define({ key: 'init-conn', group: G, label: '向导 · 联网检查结果', def: 'ok', options: [['ok', '全部连得上'], ['partial', '镜像下载源超时未响应'], ['offline', '离线：模型 API 全部连不上'], ['timeout', '模型 API 全部超时（不判离线）']] });
  P.scenario.define({ key: 'init-proxy', group: G, label: '向导 · 下一次保存代理', once: true, def: 'ok', options: [['ok', '成功'], ['timeout', '请求超时']] });
  P.scenario.define({ key: 'init-chain', group: G, label: '向导 · 镜像检查', def: 'auto', options: [['auto', '按预制镜像在不在本机（不在：第 5 项提示，自动准备）'], ['registry', '第 2 项未通过（自建镜像没推上去）'], ['abort', '检查中断']] });
  P.scenario.define({ key: 'init-provision', group: G, label: '向导 · 准备镜像', def: 'ok', options: [['ok', '成功'], ['fail', '下载失败（连接中断，不自动重试）']] });
  P.scenario.define({ key: 'init-runtimes', group: G, label: '向导 · Agent 列表', def: 'ok', options: [['ok', '读得到'], ['fail', '读不到']] });
  P.scenario.define({ key: 'init-resource', group: G, label: '向导 · 本机资源', def: 'auto', options: [['auto', '读系统状态同一份读数'], ['low', '偏低（另一台机器：可用磁盘 38 GB）'], ['fail', '读不到']] });
  P.scenario.define({ key: 'init-write', group: G, label: '向导 · 下一次写入「已初始化」', once: true, def: 'ok', options: [['ok', '成功'], ['fail', '写入失败（数据目录只读；[重试] 成功）'], ['network', '网络断开（请求没到平台）'], ['offline', '写入时发现离线（409，回联网检查）'], ['already', '已经初始化过了（409：另一个标签页先完成，直接放行）']] });
  const backendDown = () => P.scenario.is('sys-conn', 'down');

  // ================================================================== 数据（notes/dep.md §5；f-dep-init-02…14 的示例值）
  const STEPS = [['connectivity', '联网检查'], ['proxy', '代理配置'], ['preset-image', '沙箱镜像'], ['subscription', '模型帐号'], ['resource', '本机资源']];
  // 探测目标：由已注册的 Agent 申报（模型 API）与 SANDBOX_DEFAULT_IMAGE 推出（镜像下载源）；单目标时限 = 10 秒的 70%（PARAM.DIAG_TARGET_BUDGET_PCT）
  const TARGETS = [
    { host: 'api.openai.com', kind: '模型 API', model: true, desc: 'Codex 的模型 API', ms: 182 },
    { host: 'api.anthropic.com', kind: '模型 API', model: true, desc: 'Claude Code 的模型 API', ms: 236 },
    { host: 'ghcr.io', kind: '镜像下载源', model: false, desc: '预制镜像所在的镜像下载源（由 SANDBOX_DEFAULT_IMAGE 推出）', ms: 412 },
  ];
  const TIMEOUT_HINT = (t) => `这不等于连不上：${t.host}（${t.desc}）7000ms 内未完成 TLS 握手，而一条时快时慢的链路会周期性越过超时时限，Agent 用的是长连接，在这种链路上通常照样能用。重跑一次看它稳不稳定：偶发多半只是慢，可以直接往下走；每次都这样就按不通处理（内网常见形态是「网络通、但要走代理」，在系统设置里填 HTTPS_PROXY 后重试）`;
  const DNS_HINT = (t) => `DNS 解析不了 ${t.host}（${t.desc}）。内网环境通常要配代理：在初始化向导 / 系统设置里填 HTTP_PROXY / HTTPS_PROXY`;
  // 逐目标结果（REQ-DEP-006）与结论（REQ-DEP-007：只有模型 API 全部「连不上」才算离线；全部超时不算）
  const rowState = (kind, t) => (kind === 'offline' ? 'fail' : kind === 'partial' && !t.model ? 'timeout' : kind === 'timeout' && t.model ? 'timeout' : 'ok');
  const VERDICT = {
    ok: ['muted', null, '联网正常：模型 API 与镜像下载源都连得上。'],
    partial: ['warn', 'i-triangle-alert', '有镜像下载源超时未响应 —— 模型 API 都连得上，Agent 可用；受影响的只是下载新镜像。超时不等于连不上：一条时快时慢的链路会周期性超过这次检查的超时时限，重跑一次看它是否稳定。'],
    offline: ['fail', 'i-circle-x', '当前连不上外网，Agent 将不可用 —— 每个 Agent 都必须能访问自己的模型 API，这是物理约束，不是配置问题。平台其余功能（项目管理、凭证与镜像配置、系统诊断）照常可用。'],
    timeout: ['warn', 'i-triangle-alert', '模型 API 都超时未响应 —— 这不等于连不上，平台不按离线处理。一条时快时慢的链路会周期性超过这次检查的超时时限，重跑一次看它是否稳定：偶发多半只是慢，可以直接往下走；每次都这样就按不通处理。'],
    none: ['muted', null, '还没有检查过这台机器能不能联网。'],
  };
  const HISTORY_AT = Date.UTC(2026, 9, 1, 10, 40, 12); // 2026-10-01 18:40:12（东八区）：init-status 里的上次结果（g8-02）
  const CHAIN = [
    ['config', '该用哪张镜像（没指定 = 平台按你的机器自动选）'], ['registry', '镜像下载源里有没有这张镜像'], ['lineage', '来源对不对：是不是平台自己构建的那一张'],
    ['registration', '平台检查过没有、能不能选用'], ['staged', '有没有下载到本机（只影响首个任务的耗时）'],
  ];
  const REGISTRY_CMD = 'docker build -t localhost:5001/platform/sandbox:v2 api/images/platform-sandbox && docker push localhost:5001/platform/sandbox:v2';
  const LOW = { cpu: 2, ramGB: 4, diskFreeGB: 50 }; // PARAM.INIT_LOW_CPU_CORES / INIT_LOW_RAM_GB / INIT_LOW_DISK_FREE_GB

  // ================================================================== 状态
  const W = {
    phase: 'off',         // off | boot | wizard（off = 外壳在；boot / wizard = 外壳不在 DOM 里，P.gated）
    step: 0, reached: 0,
    history: null,        // init-status 里的上次结果 { kind, at }
    conn: { phase: 'idle', kind: null, at: 0 }, connTok: 0, cooldownUntil: 0, autoRuns: 0, forceOffline: false,
    offlineAck: false, proxyBack: false,
    proxy: { saving: false, error: null, draft: null },
    chain: { phase: 'idle', result: null, autoRuns: 0 }, chainTok: 0, provAuto: false, provEl: null,
    finishing: false, retrying: false, error: null,
    root: null, parts: null, focusAfter: null, focusFrom: null, suspended: false,
  };
  const ICON = { ok: ['badge--ok', 'i-check'], timeout: ['badge--timeout', 'i-clock'], fail: ['badge--fail', 'i-x'], pending: ['badge--pending', 'i-loader-circle icon--spin'], unknown: ['badge--unknown', 'i-circle'], info: ['badge--info', 'i-info'], warn: ['badge--warn', 'i-triangle-alert'], inactive: ['badge--inactive', 'i-square-filled'] };
  const badge = (st, word) => { const [c, i] = ICON[st]; return `<span class="badge badge--20 ${c}"><span class="icon ${i}" aria-hidden="true"></span>${word}</span>`; };
  const effective = () => (W.conn.phase === 'done' ? { kind: W.conn.kind, at: W.conn.at, fresh: true } : W.history ? { kind: W.history.kind, at: W.history.at, fresh: false } : null);
  const proxyActive = () => { const e = effective(); return !!e && e.kind !== 'ok'; }; // 联网有失败项（连不上或超时）才进流程（REQ-DEP-004）
  const offlineBlocked = () => { const e = effective(); return !!e && e.kind === 'offline' && !W.offlineAck; };
  const usableRuntimes = () => world.runtimes.filter((rt) => ['active', 'expiring'].includes(P.credStatus(rt)));
  const chainReady = () => W.chain.phase === 'done' && (W.chain.result === 'ready' || W.chain.result === 'staged'); // 第 5 项「没下载到本机」是提示，镜像仍算就绪（REQ-DEP-010）
  const cooldownLeft = () => Math.max(0, Math.ceil((W.cooldownUntil - P.clock.now()) / 1000));

  // ================================================================== 首次启动的世界（notes/dep.md §5）：没有项目与任务、两个 Agent 都没配、预制镜像没下载、没有 Git 凭证、审计为空
  function firstBootWorld() {
    world.projects.splice(0); world.tasks.splice(0); world.retained.splice(0); world.automations.splice(0);
    for (const rt of world.runtimes) Object.assign(rt, { active: null, account: null, apiKey: null });
    world.gitCreds.https = null; world.gitCreds.ssh = null;
    const keep = world.images.filter((i) => i.builtin);
    world.images.splice(0, world.images.length, ...keep);
    for (const i of keep) if (i.preset) Object.assign(i.preset, { staged: false, run: null, el: null });
    for (const k of Object.keys(ui.expanded)) delete ui.expanded[k];
    Object.assign(ui, { pinned: null, notice: null, filter: 'all', ovQuery: '', tabs: {}, cleared: {}, pulling: {} });
    if (P.wipeAudit) P.wipeAudit();
    if (P.proxySettings) P.proxySettings.saved = null;
    W.history = P.scenario.is('init-history', 'none') ? null : { kind: 'ok', at: HISTORY_AT };
    Object.assign(W, { step: 0, reached: 0, conn: { phase: 'idle', kind: null, at: 0 }, cooldownUntil: 0, autoRuns: 0, forceOffline: false, offlineAck: false, proxyBack: false, chain: { phase: 'idle', result: null, autoRuns: 0 }, provAuto: false, provEl: null, finishing: false, retrying: false, error: null });
    W.proxy = { saving: false, error: null, draft: null };
  }

  // ================================================================== 启动检查 → 判定（REQ-DEP-001 / 002）：外壳、向导、口令门只挂一个
  function holdShell() {
    if (!W.parts) { W.parts = [$('.skip-link'), $('#shell')].filter(Boolean); for (const el of W.parts) el.remove(); }
    P.gated = true;
    ui.loading = true;
  }
  function releaseShell() {
    const frame = $('#frame');
    if (W.parts) { for (const el of W.parts.slice().reverse()) frame.prepend(el); W.parts = null; }
    P.gated = false;
    if (P.modals.length) P.setInert(true);
  }
  function closeFloating() {
    if (P.closeAuthPanel) P.closeAuthPanel();
    if (P.menu.el) P.closeMenu(false, { instant: true });
    if (P.popover) P.popover.close(false);
    if (P.sheet) P.sheet.close();
    while (P.modals.length) P.closeModal(P.topModal(), { restoreFocus: false, instant: true, force: true });
  }
  function enterBoot() {
    holdShell();
    W.phase = 'boot';
    removeScreens();
    // 稿件 f-dep-init-01 只有居中一句（role=status）；原型外面包一层主区地标 + 读屏用的 h1（此刻页面上只有它：axe landmark-one-main / page-has-heading-one）
    const el = frag('<div class="proto-boot" id="proto-boot" role="main"><h1 class="u-sr-only">Agent 管理平台</h1></div>');
    el.appendChild(P.fromTpl('tpl-dep-boot', { keepRoles: true }));
    $('#frame').appendChild(el);
    document.title = '正在检查平台初始化状态… · 交互原型 · Agent 管理平台';
    P.announce('正在检查平台初始化状态…');
    P.clock.after(T.bootCheck, () => {
      if (W.phase !== 'boot') return;
      // 读 init-status 失败（后端不可达）：放行进工作台 + 横幅「无法确认平台状态」，不进向导（AC-DEP-002.4）
      if (backendDown() || !P.scenario.is('init', 'fresh')) { release(); return; }
      showWizard();
    });
  }
  function removeScreens() { for (const id of ['proto-boot', 'proto-wiz']) { const e = $(`#${id}`); if (e) e.remove(); } W.root = null; }
  function release() {
    removeScreens();
    W.phase = 'off';
    releaseShell();
    P.startLoading();
  }
  // 'boot:judge'：首屏之前（以及口令门解锁之后）先问这里——未初始化 → 启动检查 → 向导；后端不可达 → 启动检查 → 放行 + 横幅；其余不接管（照旧出首屏骨架）
  let booted = false;
  P.hook('boot', () => { booted = true; });
  P.hook('boot:judge', () => {
    const fresh = P.scenario.is('init', 'fresh');
    if (!fresh && !backendDown()) return undefined;
    if (fresh && W.phase === 'off' && !W.inFlow) { firstBootWorld(); W.inFlow = true; }
    if (W.phase === 'wizard' && W.root) return true;
    enterBoot();
    return true;
  });
  // 运行中改场景：设为「未初始化」= 演示一次首次启动（收起一切浮层，整个应用换成启动检查 → 向导）；设回「已初始化」= 当作别处已经完成（409 ALREADY_INITIALIZED，放行）
  P.hook('scenario', (k, v) => {
    if (!booted) return;
    if (k === 'init') {
      if (v === 'fresh' && W.phase === 'off') {
        if (P.gated) return; // 口令门盖着：解锁后的判定会接上
        closeFloating();
        firstBootWorld(); W.inFlow = true;
        enterBoot();
      } else if (v === 'done' && W.phase !== 'off') { if (P.closeAuthPanel) P.closeAuthPanel(); W.inFlow = false; release(); }
      return;
    }
    // 向导开着时，凭证 / 镜像 / 向导自己的场景一改就重画（凭证有自己的 'cred:changed'）
    if (W.phase === 'wizard' && (k.startsWith('init-') || k === 'img-preset')) {
      if (k === 'init-history' && W.conn.phase === 'idle') W.history = v === 'none' ? null : { kind: 'ok', at: HISTORY_AT };
      paint();
    }
    // 口令门在向导开着时又盖上（使用中被拒）：向导先拿掉，解锁后重跑判定再回来（状态留着）
    if (k === 'access' && v !== 'off' && W.phase !== 'off') { removeScreens(); W.phase = 'off'; W.suspended = true; }
  });
  // 实例菜单「演示初始化向导…」（原型专用入口；产品里没有）
  P.hook('instance.items', () => [P.SEP + P.menuGroup('原型演示', P.menuItem({ label: '演示初始化向导…', icon: 'i-rotate-ccw', act: () => P.scenario.set('init', 'fresh') }))]);

  // ================================================================== 向导外壳（f-dep-init-03 的 .wiz：品牌行 → 模态对话框（页头 + 步骤条 + 向导卡））
  function showWizard() {
    removeScreens();
    W.phase = 'wizard'; W.suspended = false;
    const root = P.fromTpl('tpl-dep-wiz', { keepRoles: true });
    root.id = 'proto-wiz';
    root.setAttribute('role', 'main'); // 向导是这时页面上唯一的内容（外壳不在 DOM 里）：整块作为主区地标，品牌行也落在地标里（同口令门）；第五段起稿件的 .wiz 本身就是 <main>（R2-18）
    $('#frame').appendChild(root);
    W.root = root;
    const dlg = $('.wiz__dialog', root);
    // 不可关闭（REQ-DEP-003）：没有关闭按钮，Esc 与点外面都不关；Tab 在对话框里循环
    dlg.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const fs = P.focusables(dlg); if (!fs.length) return;
      const first = fs[0], last = fs[fs.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    dlg.addEventListener('submit', (e) => { e.preventDefault(); if (e.target.matches('.dep-proxy')) saveProxy(); });
    dlg.addEventListener('input', (e) => { const f = e.target.closest('.dep-proxy'); if (f) W.proxy.draft = readProxy(f); });
    document.title = '平台初始化 · 交互原型 · Agent 管理平台';
    gotoStep(W.step, { first: true });
  }
  function gotoStep(i, opts = {}) {
    if (P.authPanelOf && P.authPanelOf() && P.authPanelOf().host === 'wizard') P.closeAuthPanel(); // 换步 = 收起登录面板（取消这次登录）
    W.step = i; W.reached = Math.max(W.reached, i);
    W.provEl = null;
    const card = $('.wiz__card', W.root);
    const id = STEPS[i][0];
    // 每一步的卡片来自那一步的代表稿（卡头步骤名与说明、页脚条）；内容由下面按状态画
    const tpl = { connectivity: null, proxy: 'tpl-dep-card-proxy', 'preset-image': 'tpl-dep-card-chain', subscription: 'tpl-dep-card-sub', resource: 'tpl-dep-card-res' }[id];
    if (tpl) { const n = P.fromTpl(tpl, { keepRoles: true }); card.replaceWith(n); }
    else if (!opts.first) { const n = $('.wiz__card', P.fromTpl('tpl-dep-wiz', { keepRoles: true })); card.replaceWith(n); }
    const c = $('.wiz__card', W.root);
    c.dataset.step = id;
    for (const el of $$('[role="alert"], [role="status"]', $('.wiz__step-head', c))) el.removeAttribute('role');
    const h = $('.wiz__step-title', c); h.setAttribute('tabindex', '-1');
    if (id === 'proxy') initProxyForm(c);
    paint();
    h.focus({ preventScroll: true });
    W.root.scrollTop = 0;
    P.announce(`第 ${i + 1} 步：${STEPS[i][1]}`);
    // 进这一步时该自动跑的：第 1 步没有任何结果 → 跑一轮（REQ-DEP-005）；第 3 步还没有镜像结论 → 跑一轮（REQ-DEP-010）
    if (id === 'connectivity' && !effective() && W.conn.phase !== 'running' && W.autoRuns < 2) { W.autoRuns++; runConn(true); }
    if (id === 'preset-image' && W.chain.phase === 'idle') runChain(true);
  }
  function stepsHtml() {
    return STEPS.map(([id, name], i) => {
      const label = id === 'proxy' && !proxyActive() ? '代理配置（可跳过）' : name;
      let state = '', icon = '', sr = '';
      if (i === W.step) state = 'current';
      else if (i <= W.reached && !(id === 'proxy' && !proxyActive())) { // 走过的（不进流程的代理配置不打勾：没配过就不能说配过）
        if (achieved(id)) { state = 'done'; icon = 'i-check'; sr = '（已完成）'; } else { state = 'skipped'; icon = 'i-triangle-alert'; sr = '（走过、没有完成）'; }
      }
      const inner = icon ? `<span class="icon ${icon}" aria-hidden="true"></span>${esc(label)}<span class="u-sr-only">${sr}</span>` : esc(label);
      return `<li class="wiz-steps__item" data-testid="init-step-${id}"${state ? ` data-state="${state}"` : ''}${state === 'current' ? ' aria-current="step"' : ''}><span class="wiz-steps__bar" aria-hidden="true"></span><span class="wiz-steps__label">${inner}</span></li>`;
    }).join('');
  }
  function achieved(id) {
    if (id === 'connectivity') return !!effective() && !offlineBlocked();
    if (id === 'proxy') return true;
    if (id === 'preset-image') return chainReady();
    if (id === 'subscription') return usableRuntimes().length > 0;
    return false;
  }

  // ---- 画：页头「第 N / 5 步」、步骤条、当前这一步的内容与页脚条（只换变了的块；焦点按 data-fk 找回，忙态里禁用的按钮等结果出来再还）
  function paint() {
    if (W.phase !== 'wizard' || !W.root) return;
    const a = document.activeElement, afk = a && W.root.contains(a) ? a.getAttribute('data-fk') : null;
    const count = $('.wiz__count', W.root);
    const ch = `第 <b>${W.step + 1}</b> / 5 步`;
    if (count.innerHTML !== ch) count.innerHTML = ch;
    const ol = $('.wiz-steps', W.root); const sh = stepsHtml();
    if (ol.dataset.html !== sh) { ol.innerHTML = sh; ol.dataset.html = sh; }
    const card = $('.wiz__card', W.root);
    const body = $('.wiz__body', card);
    const id = STEPS[W.step][0];
    ({ connectivity: paintConnStep, proxy: paintProxyStep, 'preset-image': paintChainStep, subscription: paintSubStep, resource: paintResStep })[id](body);
    paintFooter(card, id);
    if (afk && (!a.isConnected || a.disabled)) {
      const again = $(`[data-fk="${CSS.escape(afk)}"]`, W.root);
      if (again && !again.disabled) again.focus({ preventScroll: true }); else W.focusAfter = W.focusAfter || afk;
    }
    if (W.focusAfter) {
      const want = $(`[data-fk="${CSS.escape(W.focusAfter)}"]`, W.root);
      // 第五段（R1-03）：进行中的按钮不再被原生禁用、焦点一直停在它上面——结果要把焦点交给别处时（失败后的 [重试] / [回到联网检查]），
      // 焦点还停在发起它的那颗按钮上（W.focusFrom）也算「该挪」；用户中途自己 Tab 走了就不抢
      const cur = document.activeElement;
      const lost = !cur || cur === document.body || (!!W.focusFrom && !!cur.getAttribute && cur.getAttribute('data-fk') === W.focusFrom);
      if (want && !want.disabled && P.isShown(want)) { if (lost) want.focus({ preventScroll: true }); W.focusAfter = null; W.focusFrom = null; }
    }
  }
  // 按键替换一块（data-wk = 块名）：内容没变就不动
  function block(body, key, html, before) {
    let el = $(`:scope > [data-wk="${key}"]`, body);
    if (html == null) { if (el) el.remove(); return null; }
    if (el && el.dataset.html === html) return el;
    const n = frag(html); n.dataset.wk = key; n.dataset.html = html;
    if (el) el.replaceWith(n); else if (before) before.before(n); else body.appendChild(n);
    return n;
  }
  function footerBtns({ prev = true, next = '下一步', nextDisabled = false, describedBy = null, busy = false, prevDisabled = false }) {
    const p = prev ? `<button class="btn btn--secondary" type="button"${prevDisabled ? ' disabled' : ''} data-action="wiz-prev" data-fk="wiz-prev">上一步</button>` : '';
    const n = busy
      ? `<button class="btn btn--primary is-loading" type="button" aria-disabled="true" aria-busy="true" data-fk="wiz-next"><span class="icon i-loader-circle icon--spin" aria-hidden="true"></span>${busy}</button>` // 第五段（R1-03）：进行中 aria-busy，焦点留在它上面
      : `<button class="btn btn--primary" type="button"${nextDisabled ? ' disabled' : ''}${describedBy ? ` aria-describedby="${describedBy}"` : ''} data-action="wiz-next" data-fk="wiz-next">${next}</button>`;
    return `<div class="wiz__actions">${p}${n}</div>`;
  }
  function paintFooter(card, id) {
    const foot = $('.wiz__footer', card);
    let note = '', btns = '';
    if (id === 'connectivity') {
      if (offlineBlocked()) note = '请先在上方确认「以离线模式继续」。';
      btns = footerBtns({ prev: false, nextDisabled: offlineBlocked() });
    } else if (id === 'proxy') { if (offlineBlocked()) note = '请先在上方确认「以离线模式继续」。'; btns = footerBtns({ next: '跳过，下一步', nextDisabled: offlineBlocked() }); }
    else if (id === 'preset-image') {
      if (W.chain.phase !== 'done') { note = '镜像检查完成后才能继续。'; btns = footerBtns({ nextDisabled: true }); }
      else if (chainReady()) btns = footerBtns({});
      else btns = footerBtns({ next: '稍后配置，下一步', describedBy: W.chain.result === 'registry' ? 'preset-blocked' : null });
    } else if (id === 'subscription') {
      const ready = P.scenario.is('init-runtimes', 'ok') && usableRuntimes().length > 0;
      btns = footerBtns(ready ? {} : { next: '稍后配置，下一步', describedBy: P.scenario.is('init-runtimes', 'ok') ? 'sub-blocked' : null });
    } else {
      note = '点它才算装完 —— 这一步只做一次，之后要改任何配置都在「系统状态」里。';
      btns = footerBtns({ next: '确认，开始使用', busy: W.finishing ? '正在完成…' : false, prevDisabled: W.finishing });
    }
    const html = `${note ? `<p class="wiz__note" id="wiz-note">${note}</p>` : ''}${btns}`;
    if (foot.dataset.html !== html) { foot.innerHTML = html; foot.dataset.html = html; }
  }

  // ================================================================== 第 1 步 联网检查（REQ-DEP-005…008；f-dep-init-02…05）
  function connSectionHtml() {
    const res = effective();
    const running = W.conn.phase === 'running';
    const vk = res ? res.kind : 'none';
    const [tone, icon, text] = VERDICT[vk];
    const verdict = `<p class="dep-msg dep-msg--${tone}" role="status" data-testid="connectivity-verdict">${icon ? `<span class="icon ${icon}" aria-hidden="true"></span><span>${esc(text)}</span>` : esc(text)}</p>`;
    const cd = cooldownLeft();
    // [重新检测]：检测中…（前缀转圈）；两次之间 3 秒，冷却中写「重新检测（Ns）」并禁用（AC-DEP-005.3）
    // 第五段（R1-03）：检测中 = aria-busy；冷却中 = 能聚焦、说原因的禁用（aria-disabled + data-reason）——刚按过它的人焦点一直留在它上面
    const btn = running ? '<button class="btn btn--secondary btn--32 is-loading" type="button" aria-disabled="true" aria-busy="true" data-fk="wiz-recheck"><span class="icon i-loader-circle icon--spin" aria-hidden="true"></span>检测中…</button>'
      : cd > 0 ? `<button class="btn btn--secondary btn--32" type="button" aria-disabled="true" data-reason="两次检测之间要隔 3 秒" data-fk="wiz-recheck">重新检测（${cd}s）</button>`
        : '<button class="btn btn--secondary btn--32" type="button" data-action="wiz-recheck" data-fk="wiz-recheck">重新检测</button>';
    let list = '';
    if (res) {
      list = `<ul class="list check-list dep-checks">${TARGETS.map((t) => {
        const st = rowState(res.kind, t);
        const ok = st === 'ok';
        const head = running
          ? `<span class="check-row__status dep-push">${badge('pending', '检测中…')}</span>` // 整轮一起转（后端不逐目标推送）
          : ok ? `<span class="check-row__meta dep-push">${t.ms}ms</span><span class="check-row__status">${badge('ok', '连得上')}</span>`
            : `<span class="check-row__status dep-push">${st === 'timeout' ? badge('timeout', '超时未响应') : badge('fail', '连不上')}</span>`;
        const hint = !running && !ok ? `<p class="dep-hint">${esc(st === 'timeout' ? TIMEOUT_HINT(t) : DNS_HINT(t))}</p>` : '';
        return `<li class="list__row" data-testid="connectivity-item-${t.host}" data-ok="${ok}" data-timed-out="${st === 'timeout'}" data-model-api="${t.model}"><div class="check-row__head"><span class="check-row__title">${t.host}</span><span class="dep-value" data-testid="connectivity-kind">${t.kind}</span>${head}</div>${hint}</li>`;
      }).join('')}</ul>`;
    } else if (running) list = '<p class="dep-msg dep-msg--muted" data-testid="connectivity-pending">正在检测联网状况…</p>';
    const at = res ? `<p class="dep-checked-at" data-testid="connectivity-checked-at">上次检测：${P.fmtDash(res.at)}（${P.fmtAgo(res.at)}）（${res.fresh ? '本轮刚检测' : '上次检测的结果，进向导不重跑'}）</p>` : '';
    const dv = vk === 'offline' ? 'offline' : vk === 'ok' ? 'ok' : vk === 'none' ? 'none' : 'partial';
    return `<section class="wiz__section" aria-label="联网检查" data-testid="connectivity-check" data-verdict="${dv}"><div class="dep-verdict">${verdict}${btn}</div>${list}${at}</section>`;
  }
  function offlineNoticeEl() {
    // 离线确认（REQ-DEP-008；f-dep-init-05）：确认之前 [下一步] 禁用；确认后提示条留着，按钮那一行换成「已确认…」
    const n = P.fromTpl('tpl-dep-offline', { keepRoles: true });
    const acts = $('.dep-actions', n);
    if (W.offlineAck) {
      n.dataset.acknowledged = 'true';
      acts.innerHTML = '<span class="dep-actions__note" data-testid="offline-acknowledged"><span class="icon icon--inline i-check" aria-hidden="true"></span>已确认以离线模式继续 —— 完成初始化后，工作台会常驻一条离线横幅，发起任务的入口会置灰（只置灰、不隐藏）。</span>';
    } else Object.assign($('.btn', acts).dataset, { action: 'wiz-ack', fk: 'wiz-ack' });
    return n;
  }
  function paintOffline(body) {
    const e = effective();
    if (e && e.kind === 'offline' && W.conn.phase !== 'running') {
      const key = `offline:${W.offlineAck}`;
      let el = $(':scope > [data-wk="offline"]', body);
      if (!el || el.dataset.html !== key) { const n = offlineNoticeEl(); n.dataset.wk = 'offline'; n.dataset.html = key; if (el) el.replaceWith(n); else body.appendChild(n); }
    } else block(body, 'offline', null);
  }
  function paintConnStep(body) {
    block(body, 'conn', connSectionHtml());
    paintOffline(body);
    for (const el of $$(':scope > :not([data-wk]):not(.wiz__step-head)', body)) el.remove(); // 模板里的示例内容
  }
  function runConn(auto) {
    if (W.conn.phase === 'running') return;
    if (!auto && P.clock.now() < W.cooldownUntil) return; // 节流：冷却中点了无效（按钮本来也禁用着）
    W.cooldownUntil = P.clock.now() + T.recheckThrottle;
    P.clock.after(T.recheckThrottle, () => paint()); // 冷却到点那一刻就还原按钮（每秒的重画落在整秒上，可能晚到最多 1 秒）
    const prev = W.conn;
    W.conn = { phase: 'running', kind: prev.kind, at: prev.at };
    const tok = ++W.connTok;
    paint();
    P.announce('检测中…');
    P.clock.after(T.connCheck, () => {
      if (tok !== W.connTok || W.phase !== 'wizard') return;
      const kind = W.forceOffline ? 'offline' : P.scenario.get('init-conn');
      W.forceOffline = false;
      W.conn = { phase: 'done', kind, at: P.clock.wall() };
      if (kind !== 'offline') W.offlineAck = false; // 不再离线：之前那次确认作废；仍是离线：确认留痕
      paint();
      P.announce(VERDICT[kind][2]);
    });
  }
  P.actions['wiz-recheck'] = () => { W.focusAfter = 'wiz-recheck'; runConn(false); };
  P.actions['wiz-ack'] = () => {
    W.offlineAck = true;
    W.focusAfter = 'wiz-next';
    paint();
    const n = $('[data-fk="wiz-next"]', W.root); if (n && !n.disabled) n.focus({ preventScroll: true });
    P.announce('已确认以离线模式继续');
  };
  // 冷却倒数与「（刚刚）→（1 分钟前）」：每个时钟秒就地重画（只在冷却中或有进行中对象时时钟才走）
  P.clock.ticker({ active: () => W.phase === 'wizard' && P.clock.now() < W.cooldownUntil, tick: () => paint() });

  // ================================================================== 第 2 步 代理配置（REQ-DEP-009；f-dep-init-06）：只存配置、存完立即重检（共用节流）；失败按码说人话
  const PROXY_FIELDS = [['httpProxy', 'wiz-proxy-http'], ['httpsProxy', 'wiz-proxy-https'], ['noProxy', 'wiz-proxy-no']];
  const readProxy = (f) => Object.fromEntries(PROXY_FIELDS.map(([n]) => [n, $(`input[name="${n}"]`, f).value]));
  function initProxyForm(card) {
    const f = $('form.dep-proxy', card);
    const saved = (P.proxySettings && P.proxySettings.saved) || { httpProxy: '', httpsProxy: '', noProxy: '' };
    const v = W.proxy.draft || saved;
    for (const [n, fk] of PROXY_FIELDS) { const i = $(`input[name="${n}"]`, f); i.value = v[n] || ''; i.dataset.fk = fk; }
    const err = $('.dep-msg--fail', f); if (err) err.remove();
    const b = $('[type="submit"]', f); b.dataset.fk = 'wiz-proxy-save'; b.dataset.action = 'wiz-proxy-save';
    $('.dep-divider', card).dataset.wk = 'divider';
    $('.dep-divider', card).dataset.html = 'divider';
    f.dataset.wk = 'form'; f.dataset.html = 'form';
  }
  function paintProxyStep(body) {
    const head = $('.wiz__step-desc', body);
    // 从第 3 步 [上一步] 回来、而联网其实都连得上：不说「上一步有目标连不上」（AC-DEP-009.5，暂行句）
    const e = effective();
    const desc = W.proxyBack && e && e.kind === 'ok' ? '联网检查都连得上，不配代理也能往下走；要改代理的话，配好后点 [保存并重新检测]。' : '上一步有目标连不上。内网环境通常需要配置代理；配好后点 [保存并重新检测]。';
    if (head.textContent !== desc) head.textContent = desc;
    const f = $('form.dep-proxy', body);
    const b = $('[type="submit"]', f);
    const cd = cooldownLeft();
    const running = W.conn.phase === 'running';
    // 第五段（R1-03）：保存中 / 检测中 = aria-busy，冷却中 = aria-disabled + 原因（都能聚焦，焦点不丢）；在输入框里回车保存的，焦点先交给这颗按钮
    if (W.proxy.saving && f.contains(document.activeElement) && document.activeElement !== b) b.focus({ preventScroll: true });
    P.setBusy(b, W.proxy.saving || running);
    if (!(W.proxy.saving || running)) { if (cd > 0) { b.setAttribute('aria-disabled', 'true'); b.dataset.reason = '两次检测之间要隔 3 秒'; } else { b.removeAttribute('aria-disabled'); delete b.dataset.reason; } } else delete b.dataset.reason;
    const label = W.proxy.saving ? P.busyHtml('保存中…') : cd > 0 ? `保存并重新检测（${cd}s）` : '保存并重新检测';
    if (b.innerHTML !== label) b.innerHTML = label;
    for (const [n] of PROXY_FIELDS) {
      const i = $(`input[name="${n}"]`, f);
      i.disabled = W.proxy.saving;
      if (W.proxy.error && W.proxy.error.field === n) { i.setAttribute('aria-invalid', 'true'); i.setAttribute('aria-describedby', 'wiz-proxy-error'); } else { i.removeAttribute('aria-invalid'); i.removeAttribute('aria-describedby'); }
    }
    let err = $('[data-testid="proxy-error"]', f);
    const want = W.proxy.error ? W.proxy.error.text : null;
    if (want && (!err || err.lastChild.textContent !== want)) {
      const n = frag(`<p class="dep-msg dep-msg--fail" role="alert" id="wiz-proxy-error" data-testid="proxy-error"><span class="icon i-circle-x" aria-hidden="true"></span><span>${esc(want)}</span></p>`); // 同 f-dep-init-06 的失败句
      if (err) err.replaceWith(n); else $('.dep-actions', f).before(n);
    } else if (!want && err) err.remove();
    block(body, 'conn', connSectionHtml()); // 表单下面同时显示联网结果（离线时连同离线确认），看着结果改代理（REQ-DEP-009）
    paintOffline(body);
    for (const el of $$(':scope > :not([data-wk]):not(.wiz__step-head)', body)) el.remove();
  }
  P.actions['wiz-proxy-save'] = () => saveProxy();
  function saveProxy() {
    const f = W.root && $('form.dep-proxy', W.root);
    if (!f || W.proxy.saving || W.conn.phase === 'running' || cooldownLeft() > 0) return;
    const v = readProxy(f);
    W.proxy.draft = v; W.proxy.saving = true; W.proxy.error = null;
    W.focusAfter = 'wiz-proxy-save';
    paint();
    P.announce('保存中…');
    P.clock.after(T.proxySave, () => {
      W.proxy.saving = false;
      if (W.phase !== 'wizard') return;
      const bad = P.validateProxy(v);
      const scen = bad ? 'ok' : P.scenario.take('init-proxy');
      if (bad) W.proxy.error = { text: bad.text, field: bad.field };
      else if (scen === 'timeout') W.proxy.error = { text: '保存失败：这次请求超时了，可以再试一次。' }; // 按码给前端句，不拼后端原句（AC-DEP-009.3）
      if (W.proxy.error) { paint(); P.announce(W.proxy.error.text); return; }
      P.saveProxy(v); // 系统状态「出网代理」同一份（只存配置，不结束初始化）
      W.proxy.draft = null;
      paint();
      runConn(true); // 存成功立即重检（与 [重新检测] 共用节流）
    });
  }

  // ================================================================== 第 3 步 沙箱镜像（REQ-DEP-010…012；f-dep-init-07…10）
  function runChain(auto) {
    const tok = ++W.chainTok;
    const runs = W.chain.autoRuns + (auto ? 1 : 0);
    W.chain = { phase: 'running', result: W.chain.result, autoRuns: runs };
    paint();
    P.announce('镜像检查中…');
    P.clock.after(T.chainCheck, () => {
      if (tok !== W.chainTok) return;
      const sc = P.scenario.get('init-chain');
      const staged = P.presetImageStaged ? P.presetImageStaged() : true;
      const result = sc === 'registry' ? 'registry' : sc === 'abort' ? 'abort' : staged ? 'ready' : 'staged';
      W.chain = { phase: 'done', result, autoRuns: runs };
      // 第 5 项「没下载到本机」且平台搬得了 → 进这一步就自动开始准备（只自动开一次，REQ-DEP-011）
      if (result === 'staged' && !W.provAuto) { W.provAuto = true; startProvision(); }
      paint();
      P.announce(result === 'abort' ? '镜像检查中断：这一轮没有拿到结论，可点 [重新检测] 重跑。' : result === 'registry' ? '镜像检查：第 2 项未通过，镜像下载源里找不到这张镜像' : result === 'staged' ? '镜像检查：镜像还没下载到本机，正在准备' : '镜像检查：五项都通过');
      // 自动跑的那一轮断了，最多再自动跑一次（PARAM.INIT_AUTO_CHECK_RUNS = 2）
      if (result === 'abort' && auto && runs < 2) runChain(true);
    });
  }
  function startProvision() {
    const fail = P.scenario.is('init-provision', 'fail') ? 'eof' : P.scenario.is('img-preset', 'fail') ? 'sha' : false;
    P.presetProvision.start(fail);
    paint();
  }
  function chainRowHtml(i, st) {
    const [key, name] = CHAIN[i];
    const word = { pass: ['ok', '通过'], pending: ['pending', '检查中…'], unchecked: ['unknown', '未检查'], info: ['info', '提示'], fail: ['fail', '未通过'] }[st];
    return `<li class="list__row" data-testid="preset-step-${key}" data-state="${st}"><div class="check-row__head"><span class="check-row__title"><span class="dep-ord">第 ${i + 1} 项（共 5 项） · </span>${name}</span><span class="check-row__status dep-push">${badge(word[0], word[1])}</span></div></li>`;
  }
  function paintChainStep(body) {
    const ch = W.chain;
    const running = ch.phase !== 'done';
    const r = ch.result;
    let rows = [];
    if (running) rows = CHAIN.map((_, i) => chainRowHtml(i, 'pending'));
    else if (r === 'registry') rows = [chainRowHtml(0, 'pass'), 'REGISTRY', chainRowHtml(2, 'unchecked'), chainRowHtml(3, 'unchecked'), chainRowHtml(4, 'unchecked')];
    else if (r === 'abort') rows = CHAIN.map((_, i) => chainRowHtml(i, 'unchecked'));
    else rows = CHAIN.map((_, i) => chainRowHtml(i, i === 4 && r === 'staged' ? 'info' : 'pass'));
    const btn = running ? '<button class="btn btn--secondary btn--32 is-loading" type="button" aria-disabled="true" aria-busy="true" data-fk="wiz-chain-recheck"><span class="icon i-loader-circle icon--spin" aria-hidden="true"></span>检测中…</button>' // 第五段（R1-03）
      : '<button class="btn btn--secondary btn--32" type="button" data-action="wiz-chain-recheck" data-fk="wiz-chain-recheck">重新检测</button>';
    const abort = !running && r === 'abort' ? '<p class="dep-msg dep-msg--fail" role="alert" data-testid="preset-image-aborted"><span class="icon i-circle-x" aria-hidden="true"></span><span>镜像检查中断：这一轮没有拿到结论，可点 [重新检测] 重跑。</span></p>' : '';
    const key = JSON.stringify([running, r, rows.length]);
    let secEl = $(':scope > [data-wk="chain"]', body);
    if (!secEl || secEl.dataset.html !== key) {
      const html = `<section class="wiz__section" aria-label="镜像检查" data-testid="preset-image-check" data-ready="${!running && (r === 'ready' || r === 'staged')}"><div class="dep-verdict"><p class="dep-msg dep-msg--muted">镜像检查共 5 项，任一项未通过即止 —— 每一项的修复动作都不一样。</p>${btn}</div>${abort}<ol class="list check-list dep-checks">${rows.join('').replace('REGISTRY', '<li data-slot="registry"></li>')}</ol></section>`;
      const n = frag(html); n.dataset.wk = 'chain'; n.dataset.html = key;
      const slot = $('[data-slot="registry"]', n);
      if (slot) {
        // 第 2 项未通过：结论 → 证据 → 这一项自己的修复动作 → 命令 + [复制] → 错误码（f-dep-init-08；DR-23）
        const li = P.fromTpl('tpl-dep-chain-fail', { keepRoles: true });
        Object.assign($('.check-row__cmd .btn', li).dataset, { action: 'wiz-copy', fk: 'wiz-copy' });
        $('.check-row__code', li).tabIndex = 0; // 命令一行放不下时横向滚动：能 Tab 到才能用键盘滚（axe scrollable-region-focusable）
        slot.replaceWith(li);
        n.appendChild(P.fromTpl('tpl-dep-chain-blocked', { keepRoles: true })); // 拦截说明一屏只说一次（卡内，DR-25）
      }
      if (!running && r === 'staged') {
        // 第 5 项提示：一句结论 + 为什么 +「下载到本机」块（与镜像页同一个搬运、同一个进度块，f-dep-init-09 / 10）
        const li = $('[data-testid="preset-step-staged"]', n);
        li.insertAdjacentHTML('beforeend', '<p class="check-row__result">镜像还没下载到本机</p><p class="dep-hint">镜像本身没问题，只是这台机器上还没有它的副本（镜像压缩后约 0.3GB，通常十几秒到一分钟）。</p>');
        li.appendChild(provisionEl());
      }
      if (secEl) secEl.replaceWith(n); else body.appendChild(n);
      secEl = n;
    }
    paintProvision();
    for (const el of $$(':scope > :not([data-wk]):not(.wiz__step-head)', body)) el.remove();
  }
  function provisionEl() {
    if (W.provEl) return W.provEl;
    const el = P.fromTpl('tpl-dep-provision', { keepRoles: true });
    const old = $('.progress', el); if (old) old.remove();
    Object.assign($('[data-testid="preset-provision-button"]', el).dataset, { action: 'wiz-provision', fk: 'wiz-provision' });
    W.provEl = el;
    return el;
  }
  function paintProvision() {
    const el = W.provEl; if (!el || !el.isConnected) return;
    const i = P.presetProvision.image(); const r = i && i.preset ? i.preset.run : null;
    const b = $('[data-testid="preset-provision-button"]', el);
    const running = !!(r && r.phase === 'run');
    const busy = running || !!(r && r.phase === 'done');
    P.setBusy(b, busy); // 第五段（R1-04）：准备中 aria-busy（焦点留在它上面）
    const label = busy ? P.busyHtml('准备中…') : '准备镜像';
    if (b.innerHTML !== label) b.innerHTML = label;
    P.presetProvision.paint(el, r, { failTpl: 'tpl-dep-progress-fail' }); // 失败：撤掉条，留阶段句 + 失败句 + 出路（不承诺代理，Q-SYS-16 A）
  }
  P.hook('preset:progress', () => { if (W.phase === 'wizard') { paintProvision(); if (STEPS[W.step][0] === 'preset-image') paintFooter($('.wiz__card', W.root), 'preset-image'); } });
  // 下载完成：重跑镜像检查，由检查结论宣布就绪（这一块自己不说「好了」，AC-DEP-011.5）
  // 第五段（R1-03 / R1-04 同类）：焦点在「下载到本机」块里（刚按过 [准备镜像]）时，块随重跑收起——焦点交给这一步的 [重新检测]（重跑中 aria-busy，能聚焦），不落到 body
  P.hook('preset:staged', () => {
    if (W.phase !== 'wizard' || W.chain.phase !== 'done') return;
    const inBlock = !!(W.provEl && W.provEl.contains(document.activeElement));
    W.provEl = null;
    if (inBlock) { W.focusAfter = 'wiz-chain-recheck'; W.focusFrom = 'wiz-provision'; }
    runChain(false);
  });
  P.actions['wiz-chain-recheck'] = () => { W.focusAfter = 'wiz-chain-recheck'; runChain(false); };
  P.actions['wiz-provision'] = () => { W.focusAfter = 'wiz-provision'; startProvision(); P.announce('准备中…'); }; // 失败后点了才从头来，不自动重试
  P.actions['wiz-copy'] = () => P.copyText(REGISTRY_CMD, () => P.toast('ok', '已复制', REGISTRY_CMD), () => P.toast('fail', '复制失败，请手动选中命令复制'));

  // ================================================================== 第 4 步 模型帐号（REQ-DEP-013；f-dep-init-11 / 12）：同一个登录面板（宿主 wizard），至少一个可用才不拦
  function subHeadHtml(rt, open) {
    const st = P.credStatus(rt);
    const statusB = st === 'none' ? badge('inactive', '未配置') : st === 'expired' ? badge('warn', '凭证已过期') : badge('ok', '已配置');
    const ident = st !== 'none' && rt.identity ? `<span class="dep-value">${esc(rt.identity)}</span>` : '';
    const fk = `wiz-sub:${rt.id}`;
    let act = '';
    if (open) act = `<button class="btn btn--tertiary btn--28" type="button" aria-expanded="true" aria-controls="${rt.id === 'codex' ? 'cx' : 'cc'}-auth-panel" data-action="wiz-sub" data-rt="${rt.id}" data-fk="${fk}"><span class="icon i-chevron-up" aria-hidden="true"></span>收起</button>`;
    else if (st === 'none') act = `<button class="btn btn--secondary btn--28" type="button" aria-expanded="false" data-testid="subscription-configure-${rt.id}" data-action="wiz-sub" data-rt="${rt.id}" data-fk="${fk}">去配置</button>`;
    else if (st === 'expired') act = `<button class="btn btn--secondary btn--28" type="button" aria-expanded="false" data-testid="subscription-configure-${rt.id}" data-action="wiz-sub" data-rt="${rt.id}" data-fk="${fk}">重新授权</button>`;
    return `<div class="check-row__head"><span class="check-row__title">${esc(rt.name)}</span>${ident}<span class="check-row__status dep-push">${statusB}</span><span class="dep-row-action">${act}</span></div>`;
  }
  function paintSubStep(body) {
    const secEl = $('section[data-testid="subscription-setup"]', body);
    const lead = $('.dep-msg', secEl);
    if (!P.scenario.is('init-runtimes', 'ok')) {
      // 读不到 Agent 列表：列表位置一句（role=alert）；可以先跳过（AC-DEP-013.5）
      for (const el of $$(':scope > :not(.dep-msg)', secEl)) el.remove();
      if (!$('[data-testid="subscription-load-fail"]', secEl)) lead.insertAdjacentHTML('afterend', '<p class="dep-msg dep-msg--fail" role="alert" data-testid="subscription-load-fail"><span class="icon i-circle-x" aria-hidden="true"></span><span>读不到 Agent 列表 —— 无法判断凭证状态。可以先跳过，之后在凭证管理页配置。</span></p>');
      secEl.dataset.ready = 'false';
      return;
    }
    const fail = $('[data-testid="subscription-load-fail"]', secEl); if (fail) fail.remove();
    let ul = $('ul.dep-checks', secEl);
    if (!ul) { ul = frag('<ul class="list check-list dep-checks"></ul>'); lead.after(ul); }
    const ap = P.authPanelOf ? P.authPanelOf() : null;
    for (const rt of world.runtimes) {
      let li = $(`:scope > [data-testid="subscription-runtime-${rt.id}"]`, ul);
      if (li && !li.dataset.rt) { li.remove(); li = null; } // 模板里的示例行
      if (!li) { li = frag(`<li class="list__row" data-testid="subscription-runtime-${rt.id}" data-rt="${rt.id}"><div class="check-row__head"></div></li>`); ul.appendChild(li); }
      const st = P.credStatus(rt);
      li.dataset.state = st === 'none' ? 'none' : st === 'expired' ? 'expired' : 'ready';
      const open = !!(ap && ap.host === 'wizard' && ap.rt === rt.id && li.contains(ap.root));
      const html = subHeadHtml(rt, open);
      const head = $(':scope > .check-row__head', li);
      if (head.dataset.html !== html) { const n = frag(html); n.dataset.html = html; head.replaceWith(n); }
    }
    for (const li of $$(':scope > li', ul)) if (!li.dataset.rt || !P.runtime(li.dataset.rt)) li.remove();
    const ready = usableRuntimes().length > 0;
    secEl.dataset.ready = String(ready);
    // 拦截说明（一个都不可用时；一屏只说一次，[稍后配置，下一步] 用 aria-describedby 指向它）
    let note = $('#sub-blocked', secEl);
    if (!ready && !note) secEl.appendChild(P.fromTpl('tpl-dep-sub-blocked', { keepRoles: true }));
    else if (ready && note) note.remove();
  }
  P.actions['wiz-sub'] = (btn) => {
    const rt = P.runtime(btn.dataset.rt); if (!rt) return;
    const ap = P.authPanelOf();
    if (ap && ap.host === 'wizard' && ap.rt === rt.id) { P.closeAuthPanel(); paint(); const b = $(`[data-fk="wiz-sub:${rt.id}"]`, W.root); if (b) b.focus({ preventScroll: true }); return; } // [收起] = 取消这次登录
    const li = $(`[data-testid="subscription-runtime-${rt.id}"]`, W.root);
    // 就地展开同一个登录面板：停在空闲态，点 [开始帐号登录] 才开始（REQ-AUTH-003）；没有一次性说明与 [管理所有凭证]（REQ-AUTH-001）
    P.openAuthPanel({ host: 'wizard', rt, tab: 'acc', card: li, triggerFk: `wiz-sub:${rt.id}`, fromRadio: false, onClose: onPanelClosed });
    paint();
  };
  // 面板收起（[收起] / 配好后「已连上」停留够了 / 换步）：那一行换回 [去配置]、已配置或 [重新授权]；焦点掉了就交给那一行的按钮，没有按钮（已配置）给页脚主按钮
  function onPanelClosed(ap) {
    paint();
    const lost = !document.activeElement || document.activeElement === document.body;
    if (!lost || W.phase !== 'wizard') return;
    const f = $(`[data-fk="wiz-sub:${ap.rt.id}"]`, W.root) || $('[data-fk="wiz-next"]', W.root);
    if (f) f.focus({ preventScroll: true });
  }
  P.hook('cred:changed', () => { if (W.phase === 'wizard') paint(); });

  // ================================================================== 第 5 步 本机资源（REQ-DEP-014；f-dep-init-13 / 14）：偏低不是门
  function machine() {
    if (P.scenario.is('init-resource', 'low')) return { cores: 4, load: 23.5, ramGB: 8, ramPct: 41.2, diskFree: 38, diskTotal: 120, diskPct: 68.3 }; // g8-13 那台机器
    const R = P.sysResources(); // 一台机器只有一份读数：与系统状态页同一份（notes/dep.md §5）
    return { cores: R.cpu.total, load: Math.round(R.cpu.pct * 10) / 10, ramGB: R.ram.total, ramPct: R.ram.pct, diskFree: Math.round((R.disk.total - R.disk.used) * 10) / 10, diskTotal: R.disk.total, diskPct: R.disk.pct };
  }
  const num = (n) => { const r = Math.round(n * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); };
  function resSectionHtml() {
    if (P.scenario.is('init-resource', 'fail')) {
      return '<section class="wiz__section" aria-label="本机资源" data-testid="resource-confirm"><p class="dep-msg dep-msg--fail" role="alert" data-testid="resource-load-fail"><span class="icon i-circle-x" aria-hidden="true"></span><span>读不到本机资源占用 —— <strong>这不代表资源充足</strong>，只代表这一项没查出来。仍可继续初始化，装好后可在系统状态页再看。</span></p></section>';
    }
    const m = machine();
    const low = { cpu: m.cores < LOW.cpu, ram: m.ramGB < LOW.ramGB, disk: m.diskFree < LOW.diskFreeGB };
    const row = (key, name, value, isLow, extra = '') => `<li class="list__row" data-testid="resource-row-${key}" data-low="${isLow}"><div class="check-row__head"><span class="check-row__title">${name}</span><span class="dep-value">${value}</span><span class="check-row__status dep-push">${isLow ? badge('warn', '偏低') : badge('ok', '正常')}</span></div>${extra}</li>`;
    const comp = '<p class="dep-hint">磁盘会被三样东西持续吃掉：预制镜像下载到本机后约 1.3GB（下载 0.3GB）· 沙箱环境自己的镜像缓存实测约 31GB · 每个任务一份代码副本。所以这里看的是可用容量，不是总量。</p>';
    const rows = row('cpu', 'CPU', `${m.cores} 核 · 当前负载 ${num(m.load)}%`, low.cpu) + row('ram', '内存', `${num(m.ramGB)} GB（已用 ${num(m.ramPct)}%）`, low.ram)
      + row('disk', '磁盘', `可用 ${num(m.diskFree)} GB / 总 ${num(m.diskTotal)} GB（已用 ${num(m.diskPct)}%，/srv/agent-platform/data）`, low.disk, comp);
    const reserved = `<p class="dep-hint" data-testid="resource-reserved">平台会留出总容量的 15% 不拿去跑任务：内存最多能分出 ${num(m.ramGB * 0.85)} GB、磁盘 ${num(m.diskTotal * 0.85)} GB —— 磁盘还要与当前可用的 ${num(m.diskFree)} GB 取小。</p>`;
    let lowNote = '';
    if (low.cpu || low.ram || low.disk) {
      const why = [low.cpu ? `CPU ${m.cores} 核（建议 ≥ ${LOW.cpu} 核）` : '', low.ram ? `内存 ${num(m.ramGB)} GB（建议 ≥ ${LOW.ramGB} GB）` : '', low.disk ? `可用磁盘 ${num(m.diskFree)} GB（建议 ≥ ${LOW.diskFreeGB} GB）` : ''].filter(Boolean).join('、');
      const n = P.fromTpl('tpl-dep-res-low', { keepRoles: true });
      $('.note__text', n).textContent = `仍可继续 —— 当前这台机器的资源偏低（${why}），建议加上去之后再正式投入使用；现在就用也行，只是同时能跑的任务更少、镜像下载到本机更慢。`;
      lowNote = n.outerHTML;
    }
    return `<section class="wiz__section" aria-label="本机资源" data-testid="resource-confirm"><ul class="list check-list dep-checks">${rows}</ul>${reserved}${lowNote}</section>`;
  }
  function errorPanelHtml() {
    if (!W.error) return null;
    const n = P.fromTpl('tpl-dep-error', { keepRoles: true });
    const acts = $('.note__actions', n);
    if (W.error === 'offline') {
      // 写入时发现离线（409 OFFLINE_NOT_ACKNOWLEDGED）：按码给前端句 + [回到联网检查]（Q-DEP-01 A），不原样显示后端句
      $('.note__text', n).textContent = '刚才这一轮联网检查发现模型 API 全部连不上：回第 1 步重新检测，确认以离线模式继续后再完成。';
      acts.innerHTML = '<button class="btn btn--secondary btn--32" type="button" data-action="wiz-back-conn" data-fk="wiz-back-conn">回到联网检查</button>';
    } else {
      // 其余失败：原因用后端信封里的人话（稿件示例「写入失败：数据目录只读…」）；拿不到信封（网络断开）用前端句，不上屏「Failed to fetch」（AC-DEP-016.6，暂行句）
      if (W.error === 'network') $('.note__text', n).textContent = '网络请求失败，平台没收到这次写入。检查网络后再点 [重试]。';
      const b = $('.btn', acts);
      Object.assign(b.dataset, { action: 'wiz-retry', fk: 'wiz-retry' });
      if (W.retrying) P.setBusy(b, true, P.busyHtml('重试中…')); // 第五段（R1-03）
    }
    return n.outerHTML;
  }
  function paintResStep(body) {
    block(body, 'res', resSectionHtml());
    block(body, 'error', errorPanelHtml());
    for (const el of $$(':scope > :not([data-wk]):not(.wiz__step-head)', body)) el.remove();
  }
  // [确认，开始使用]：唯一写入「已初始化」的动作（REQ-DEP-015）；在途「正在完成…」、[上一步] 禁用；不自动重试
  function finish(viaRetry) {
    if (W.finishing) return;
    W.finishing = true; W.retrying = !!viaRetry;
    W.focusAfter = viaRetry ? 'wiz-retry' : 'wiz-next';
    paint();
    P.announce('正在完成…');
    P.clock.after(T.initFinish, () => {
      W.finishing = false; W.retrying = false;
      if (W.phase !== 'wizard') return;
      const sc = P.scenario.take('init-write');
      // 按码分流（REQ-DEP-016）：409 ALREADY_INITIALIZED = 目标状态已达成 → 直接放行、不出错误；409 OFFLINE_NOT_ACKNOWLEDGED（没确认过离线时）→ 前端句 + [回到联网检查]；其余失败停在向导 + [重试]
      const from = viaRetry ? 'wiz-retry' : 'wiz-next';
      if (sc === 'fail' || sc === 'network') { W.error = sc; W.focusAfter = 'wiz-retry'; W.focusFrom = from; paint(); P.announce(`初始化没有完成。${sc === 'network' ? '网络请求失败，平台没收到这次写入。检查网络后再点 [重试]。' : '写入失败：数据目录只读（/srv/agent-platform/data）。请检查挂载权限后重试。'}`); return; }
      if (sc === 'offline' && !W.offlineAck) { W.error = 'offline'; W.focusAfter = 'wiz-back-conn'; W.focusFrom = from; paint(); P.announce('初始化没有完成。刚才这一轮联网检查发现模型 API 全部连不上：回第 1 步重新检测，确认以离线模式继续后再完成。'); return; }
      complete();
    });
  }
  // 成功：向导整棵卸载（不出「初始化完成」类提示），第一屏按地址渲染；最后一轮联网结论写进历史——离线时工作台常驻离线横幅（REQ-DEP-008 / 015）
  let landFocus = false;
  function complete() {
    if (P.closeAuthPanel) P.closeAuthPanel();
    const e = effective();
    if (e && P.sysNet) { P.sysNet.offline = e.kind === 'offline'; P.sysNet.at = e.at; }
    W.inFlow = false; W.error = null;
    P.scenario.reset('init'); // 已初始化（不发 'scenario'：世界就是向导里留下的这一份，不换回示例世界）
    landFocus = true;
    release();
    P.emit('init:done');
  }
  P.hook('loaded', () => { if (!landFocus) return; landFocus = false; P.focusMain(); }); // 没有项目时第一屏是欢迎态：flows-wb（F-WB-WELCOME，第四段）在这之后把焦点交给它的标题 h2.empty__title
  P.actions['wiz-retry'] = () => finish(true);
  P.actions['wiz-back-conn'] = () => { W.error = null; W.forceOffline = true; W.conn = { phase: 'idle', kind: null, at: 0 }; gotoStep(0); runConn(true); };

  // ================================================================== 翻步（REQ-DEP-004）：代理配置不进流程时 [下一步] 跳过它；第 3 步 [上一步] 永远回得去代理配置
  P.actions['wiz-next'] = () => {
    const id = STEPS[W.step][0];
    if (offlineBlocked() && (id === 'connectivity' || id === 'proxy')) return;
    if (id === 'connectivity') { W.proxyBack = false; gotoStep(proxyActive() ? 1 : 2); return; }
    if (id === 'resource') { finish(false); return; }
    if (id === 'preset-image' && W.chain.phase !== 'done') return;
    gotoStep(W.step + 1);
  };
  P.actions['wiz-prev'] = () => {
    if (W.finishing) return;
    const id = STEPS[W.step][0];
    if (id === 'preset-image') W.proxyBack = true; // 联网都连得上时代理配置的说明句换成暂行句（AC-DEP-009.5）
    gotoStep(Math.max(0, W.step - 1));
  };

  // ------------------------------------------------------------------ 测试出口（只读快照）
  P.stateExtras.push(() => {
    const e = effective();
    return {
      init: {
        initialized: !P.scenario.is('init', 'fresh'), phase: W.phase, step: W.phase === 'wizard' ? STEPS[W.step][0] : null, reached: W.reached,
        conn: { phase: W.conn.phase, kind: e ? e.kind : null, fresh: e ? e.fresh : null }, cooldown: cooldownLeft(), offlineAck: W.offlineAck, proxyActive: proxyActive(),
        chain: { phase: W.chain.phase, result: W.chain.result }, provAuto: W.provAuto, finishing: W.finishing, error: W.error,
      },
    };
  });
})();
