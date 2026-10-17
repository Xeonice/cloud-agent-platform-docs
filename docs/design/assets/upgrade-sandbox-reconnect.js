/*
 * 离线设计增量：服务升级与原沙箱续接。
 * 复用 v2 的外壳、任务、终端、模态、主题与场景；不向服务发请求、不触发部署。
 * fakeCatalog 只模拟 CD 发布的安装包目录；它不会开始实例升级、变更服务或刷新页面。
 * offline request 仅为交互夹具；真实访问保护、幂等受理和升级须由后端验证，未调用真实 API。
 * sessionStorage 只保存此离线示例的标签描述和演示计数，不保存任何真实会话凭据。
 * 独立 localStorage 提醒记录仅含虚构实例 ID 和本地自然日，不含版本、资源或身份凭据。
 */
(function () {
  'use strict';
  const P = window.P;
  const { $, $$, esc } = P;
  const STORE = 'agent-platform-upgrade-design-v1';
  const DEMO_INSTANCE = 'demo-instance';
  const REMINDER_STORE = 'agent-platform-upgrade-design-daily-reminder-v1:demo-user:demo-instance';
  const VERSION_POPOVER = 'upgrade-version-popover';
  const TASK = 'login';
  const PROCESS = 'demo-process-7841';
  const BASE_VERSION = 'v0.3.8';
  const TARGET_VERSION = 'v0.3.9';
  const TARGET_REVISION = 'demo-web-0.3.9';
  const BASE_REVISION = 'demo-web-0.3.8';
  const fakeCatalog = { version: TARGET_VERSION, packageRevision: 'demo-package-0.3.9' };
  const entryScene = new URLSearchParams(window.location.search).get('scene');
  const PROGRESS_STEPS = [
    { percent: 20, stage: '下载／校验安装包与候选准备' },
    { percent: 45, stage: '候选实例健康检查' },
    { percent: 75, stage: '切换服务入口' },
    { percent: 95, stage: '核对本实例激活状态' },
    { percent: 100, stage: '本实例激活已确认' },
  ];
  const SCENARIOS = [
    ['normal', '正常使用：原任务持续运行'],
    ['installable', '发现安装包：等待用户立即升级'],
    ['shared-web', '复用原页面构建：本实例待升级，无需刷新'],
    ['page-target', '页面已经是新版：本实例仍待升级'],
    ['preparing', '准备新版本：尚未就绪，原服务继续运行'],
    ['upgrading', '已主动发起升级：确认受理与示例进度'],
    ['available', '本实例已安装新版：等待刷新页面'],
    ['reconnect-confirmed', '连接切换：已确认原任务继续运行'],
    ['reconnect-unknown', '连接中断：当前任务状态尚未确认'],
    ['retry-exhausted', '重连暂未成功：保留输出、手动重试'],
    ['candidate-failed', '候选检查失败：旧服务继续提供服务'],
    ['maintenance-delayed', '维护升级延后：等待长任务自然结束'],
    ['version-unknown', '版本读取失败：保留上次确认，结论待确认'],
    ['restored', '已刷新：重新连接原任务和原终端'],
    ['contract-waiting', '旧数据格式：回退窗口尚未结束'],
    ['contract-available', '旧数据格式：可由用户单独清理'],
    ['contract-clearing', '旧数据格式：已主动发起清理'],
    ['contract-completed', '旧数据格式：清理完成，历史回退关闭'],
    ['contract-unknown', '旧数据格式：原清理请求结果待确认'],
  ];
  const templates = new Set(['term-login', 'term-login-shell', 'term-new-shell', 'term-new-codex', 'term-new-claude']);
  const kinds = new Set(['agent', 'shell', 'codex', 'claude']);
  let syncingScenario = false;
  const state = {
    scenario: 'normal', sequence: 41, observedSequence: 41,
    refreshed: false, shellRecovered: false, lastVerifiedAt: '刚刚', timer: 0,
    snoozedDate: null, demoDayOffset: 0, versionChecking: false, focusVersionCard: false,
    progress: null, entryScene: null, attempt: null, requestSeq: 0, acceptedCount: 0,
    contract: null,
    catalog: { version: BASE_VERSION, packageRevision: null, verified: true },
    version: { service: BASE_VERSION, page: BASE_VERSION, loadedWebRevision: BASE_REVISION, target: null,
      targetWebRevision: null, requiresRefresh: false, phase: 'current', verified: true, checkedAt: '刚刚（示例）' },
  };
  let saved = null;
  try {
    const record = JSON.parse(sessionStorage.getItem(STORE) || 'null');
    if (record && record.schemaVersion === 1 && record.taskId === TASK && Array.isArray(record.tabs) && record.tabs.length <= 20) saved = record;
  } catch (e) { /* 离线存储不可用时内存演示仍然可用。 */ }

  // 原型 hash 只定位示例任务，不新增产品分享功能。默认展示已有运行中任务。
  if (!window.location.hash) history.replaceState(null, '', '#task-login');
  P.scenario.define({ key: 'upgrade', group: '服务升级与沙箱续接', label: '升级与连接', def: 'normal', options: SCENARIOS });

  const target = () => P.task(TASK);
  const unknown = () => state.scenario === 'reconnect-unknown' || state.scenario === 'retry-exhausted';
  const disconnected = () => unknown() || state.scenario === 'reconnect-confirmed';
  function reminderToday() {
    // 只用于离线提醒演示；不用 P.clock.wall()，也不改全局 Date 或任何认证时钟。
    const date = new Date(); date.setDate(date.getDate() + state.demoDayOffset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }
  function readDailyReminder() {
    try {
      const record = JSON.parse(localStorage.getItem(REMINDER_STORE) || 'null');
      state.snoozedDate = record && record.instance === DEMO_INSTANCE && typeof record.date === 'string'
        && /^\d{4}-\d{2}-\d{2}$/.test(record.date) ? record.date : null;
    } catch (e) { /* 存储不可用时保留本标签页的内存提醒设置。 */ }
  }
  function snoozeToday() {
    if (!canShowUpdate()) return false;
    state.snoozedDate = reminderToday();
    try { localStorage.setItem(REMINDER_STORE, JSON.stringify({ instance: DEMO_INSTANCE, date: state.snoozedDate })); } catch (e) { /* 内存设置仍有效。 */ }
    return true;
  }
  function remember() {
    const tabs = P.ui.tabs[TASK];
    if (!tabs) return;
    const record = {
      schemaVersion: 1, taskId: TASK, activeTabId: tabs.active, sequence: state.sequence,
      observedSequence: state.observedSequence, scenario: state.scenario,
      refreshed: state.refreshed, version: state.version,
      progress: state.progress ? { percent: state.progress.percent, confirmedAt: state.progress.confirmedAt } : null, entryScene: state.entryScene,
      catalog: state.catalog,
      attempt: state.attempt, requestSeq: state.requestSeq, acceptedCount: state.acceptedCount,
      contract: state.contract,
      tabs: tabs.list.map((tab) => ({
        id: tab.id, kind: tab.kind, label: tab.label, template: tab.tpl,
        demoOutput: tab.demoOutput === true,
      })),
    };
    try { sessionStorage.setItem(STORE, JSON.stringify(record)); } catch (e) { /* 不阻断原型。 */ }
  }
  function restoreRecord(record) {
    if (!record) return false;
    const tabs = record.tabs.filter((tab) => tab && typeof tab.id === 'string' && /^login-[a-z0-9-]{1,64}$/.test(tab.id)
      && kinds.has(tab.kind) && typeof tab.label === 'string' && tab.label.length <= 64 && templates.has(tab.template))
      .map((tab) => ({ id: tab.id, kind: tab.kind, label: tab.label, tpl: tab.template, demoOutput: tab.demoOutput === true }));
    if (tabs.length === 0 || tabs[0].kind !== 'agent' || tabs[0].id !== 'login-agent' || tabs[0].tpl !== 'term-login') return false;
    if (new Set(tabs.map((tab) => tab.id)).size !== tabs.length) return false;
    P.ui.tabs[TASK] = {
      list: tabs,
      active: tabs.some((tab) => tab.id === record.activeTabId) ? record.activeTabId : tabs[0].id,
      seq: Math.max(tabs.length - 1, ...tabs.map((tab) => Number((tab.id.match(/-n(\d+)$/) || [])[1]) || 0)),
    };
    if (Number.isSafeInteger(record.sequence) && record.sequence >= 41 && record.sequence < 1000000) state.sequence = record.sequence;
    if (Number.isSafeInteger(record.observedSequence) && record.observedSequence >= 41 && record.observedSequence <= state.sequence) state.observedSequence = record.observedSequence;
    state.refreshed = record.refreshed === true;
    // 上一版按 revision 永久关闭的字段已废弃，不迁移为本日设置，也不挡新规则。
    const version = record.version;
    if (version && [BASE_VERSION, TARGET_VERSION].includes(version.service) && [BASE_VERSION, TARGET_VERSION].includes(version.page)
      && (version.target === null || version.target === TARGET_VERSION)
      && ['current', 'available-installable', 'preparing', 'upgrading', 'ready', 'failed', 'delayed', 'unknown'].includes(version.phase)) {
      state.version = { service: version.service, page: version.page, target: version.target,
        loadedWebRevision: version.page === TARGET_VERSION ? TARGET_REVISION : BASE_REVISION,
        targetWebRevision: version.target === TARGET_VERSION ? (version.requiresRefresh === false ? (version.page === TARGET_VERSION ? TARGET_REVISION : BASE_REVISION) : TARGET_REVISION) : null,
        requiresRefresh: version.requiresRefresh !== false,
        phase: version.phase, verified: version.verified === true, checkedAt: '上次确认（示例）' };
    } else if (state.refreshed) {
      state.version = { service: TARGET_VERSION, page: TARGET_VERSION, target: TARGET_VERSION,
        loadedWebRevision: TARGET_REVISION, targetWebRevision: TARGET_REVISION, requiresRefresh: false,
        phase: 'current', verified: true, checkedAt: '上次确认（示例）' };
    }
    const progress = record.progress && PROGRESS_STEPS.find((step) => step.percent === record.progress.percent);
    const confirmedAt = record.progress && typeof record.progress.confirmedAt === 'string' && record.progress.confirmedAt.length < 40
      && Number.isFinite(Date.parse(record.progress.confirmedAt)) ? record.progress.confirmedAt : null;
    state.progress = progress ? { ...progress, confirmedAt } : null;
    if (state.version.phase === 'upgrading' && (!state.progress || state.progress.percent >= 100)) {
      state.version = { ...state.version, phase: 'unknown', verified: false }; state.progress = null;
    }
    if (record.catalog && [BASE_VERSION, TARGET_VERSION].includes(record.catalog.version)) {
      state.catalog = { version: record.catalog.version, packageRevision: record.catalog.version === TARGET_VERSION ? fakeCatalog.packageRevision : null, verified: record.catalog.verified === true };
    } else if (state.version.target) state.catalog = { ...fakeCatalog, verified: state.version.verified };
    // 旧独立升级权限夹具不再恢复；本设计是通过原访问保护后的平台页面。
    if (Number.isSafeInteger(record.requestSeq) && record.requestSeq >= 0 && record.requestSeq < 1000000) state.requestSeq = record.requestSeq;
    if (Number.isSafeInteger(record.acceptedCount) && record.acceptedCount >= 0 && record.acceptedCount <= state.requestSeq) state.acceptedCount = record.acceptedCount;
    if (record.attempt && /^demo-upgrade-\d+$/.test(record.attempt.id) && record.attempt.target === TARGET_VERSION
      && ['accepted', 'upgrading', 'completed', 'failed', 'delayed', 'unknown'].includes(record.attempt.status)) {
      state.attempt = { id: record.attempt.id, requestId: `demo-request-${state.requestSeq}`, target: TARGET_VERSION,
        initiatedBy: 'offline-explicit-user', status: record.attempt.status };
    }
    // 兼容上一版的已发起夹具记录；目录发现记录本身绝不创建 attempt。
    if (!state.attempt && state.progress) createOfflineAttempt(state.progress.percent === 100 ? 'completed' : 'upgrading');
    state.entryScene = ['upgrade-available', 'upgrade-ready', 'upgrade-progress', 'upgrade-shared-web', 'upgrade-page-target', 'upgrade-contract'].includes(record.entryScene) ? record.entryScene : null;
    if (SCENARIOS.some(([value]) => value === record.scenario)) state.scenario = record.scenario;
    if (record.contract && ['waiting', 'available', 'clearing', 'completed', 'unknown'].includes(record.contract.phase)) {
      state.contract = { phase: record.contract.phase,
        requestId: /^demo-contract-\d+$/.test(record.contract.requestId || '') ? record.contract.requestId : null };
    }
    state.shellRecovered = tabs.some((tab) => tab.kind !== 'agent');
    return true;
  }
  function paintOutput() {
    const t = target();
    if (!t || !P.ui.tabs[TASK]) return;
    for (const tab of P.ui.tabs[TASK].list) {
      if (tab.kind !== 'agent' && !tab.demoOutput) continue;
      // 原 renderer 以 tab.html 比较整块画布。保持模板不变，把续播输出追加到
      // 已有 pre 中；状态提示或输出推进均不重建 panel，不改已选中的文本节点。
      tab.html = P.termTemplate(tab.tpl);
      const panel = $(`#term-${CSS.escape(tab.id)}`);
      const screen = panel && $('.term__screen', panel);
      if (!screen || P.ui.cleared[tab.id]) continue;
      const last = $('[data-upgrade-output]:last-child', screen);
      if (last && Number(last.dataset.sequence) === state.observedSequence) continue;
      const line = document.createElement('span');
      line.className = 'ansi-dim';
      line.dataset.upgradeOutput = '';
      line.dataset.sequence = String(state.observedSequence);
      line.textContent = tab.kind === 'agent'
        ? `\n[后台输出 ${state.observedSequence}] 原任务继续校验代码，等待下一条结果。\n`
        : `\n[输出 ${state.observedSequence}] tail 仍在原终端会话中，连接恢复后继续显示。\n`;
      screen.appendChild(line);
    }
  }
  function canRefreshVersion() {
    return state.version.verified && state.version.phase === 'ready'
      && state.version.requiresRefresh && state.version.targetWebRevision && state.version.loadedWebRevision !== state.version.targetWebRevision;
  }
  function installable() {
    return state.catalog.verified && state.version.verified && state.version.phase === 'available-installable'
      && state.version.target === state.catalog.version && state.version.service !== state.catalog.version;
  }
  function canInstallVersion() { return installable(); }
  function installIntentText() {
    return '已进入平台，可直接点击立即升级；原任务继续运行。（离线受理模拟）';
  }
  function inProgress() {
    return state.version.verified && state.version.phase === 'upgrading' && state.progress
      && state.progress.percent < 100 && state.version.targetWebRevision && !!state.attempt;
  }
  function canShowUpdate() { return installable() || inProgress() || canRefreshVersion(); }
  function switchingService() { return inProgress() && state.progress.percent >= 75; }
  function serviceVersionText() { return switchingService() ? '切换中／待确认' : state.version.service; }
  function showProgress() { return state.version.verified && state.progress && ['upgrading', 'ready', 'current'].includes(state.version.phase); }
  function progressFact() {
    return unknown() ? '模拟运行证据：当前任务状态待确认，已保留上次输出。' : '模拟运行证据：原任务继续运行。';
  }
  function demoProgress(step) { return { ...step, confirmedAt: new Date().toISOString() }; }
  function createOfflineAttempt(status = 'accepted') {
    state.requestSeq += 1; state.acceptedCount += 1;
    state.attempt = { id: `demo-upgrade-${state.requestSeq}`, requestId: `demo-request-${state.requestSeq}`,
      target: TARGET_VERSION, initiatedBy: 'offline-explicit-user', status };
  }
  function startInstanceUpgrade() {
    // 离线受理夹具：真实产品必须服务端验证已有访问会话、Origin／CSRF、实例绑定、安装包身份、实例兼容与幂等键。
    // 重复请求返回原 attempt；不替换目标，不清除本日提醒，也不启动任何真实部署。
    if (state.attempt && ['accepted', 'upgrading'].includes(state.attempt.status)) {
      P.announce('本实例升级已受理，继续查看同一次升级进度。'); return;
    }
    if (!canInstallVersion()) {
      P.announce(installable() ? installIntentText() : '当前没有可受理的新版本升级，请先检查版本。'); return;
    }
    const active = document.activeElement;
    createOfflineAttempt(); setProgress(20);
    if (!P.isShown(active) && active && active.matches('[data-action="upgrade-install-version"]')) {
      const card = $('#upgrade-version-card'); const trigger = $('[data-action="upgrade-toggle-versions"]');
      const safe = P.isShown(card) ? card : trigger;
      if (safe) safe.focus({ preventScroll: true });
    }
    P.announce('离线模拟：立即升级请求已受理，20%，原任务与终端保持不变。');
  }
  function progressHistoryHtml() {
    if (!state.progress || showProgress()) return '';
    const historyState = state.progress.percent === 100 ? '曾确认完成；当前可用性需重新核验'
      : state.version.phase === 'failed' ? '本次未完成'
      : state.version.phase === 'delayed' ? '升级已延后，本次未完成' : '进度待确认';
    const time = state.progress.confirmedAt ? new Date(state.progress.confirmedAt).toLocaleString('zh-CN', { hour12: false }) : '上次确认（示例）';
    return `<p class="popover__note upgrade-progress-history" data-upgrade-progress-history>上次确认 ${state.progress.percent}% · 阶段：${esc(state.progress.stage)} · ${historyState}<br>确认于 ${esc(time)}（模拟证据）；这是历史读数，不代表当前进度或升级完成。</p>`;
  }
  function progressDisplayHtml() { return showProgress() ? progressHtml() : progressHistoryHtml(); }
  function progressHtml() {
    if (!showProgress()) return '';
    const { percent, stage } = state.progress;
    return `<div class="progress upgrade-publish-progress" data-upgrade-progress-container><div class="progress__track"><div class="meter" role="progressbar" aria-label="本实例升级发布进度（模拟）" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-valuetext="${percent}%，${esc(stage)}，模拟进度" data-upgrade-progress><span class="meter__bar" style="width:${percent}%"></span></div><span class="progress__pct" data-upgrade-progress-percent>${percent}%</span></div><div class="progress__meta"><span class="progress__detail" data-upgrade-progress-stage>${esc(stage)}</span><span>模拟进度</span></div><p class="progress__note" data-upgrade-progress-fact>${esc(progressFact())}</p></div>`;
  }
  function setProgress(percent) {
    const step = PROGRESS_STEPS.find((item) => item.percent === percent);
    if (!step) return;
    state.progress = demoProgress(step);
    state.catalog = { ...fakeCatalog, verified: true };
    if (!state.attempt) createOfflineAttempt();
    state.attempt.status = percent === 100 ? 'completed' : 'upgrading';
    if (!state.entryScene) state.entryScene = 'upgrade-progress';
    state.version = { service: percent === 100 ? TARGET_VERSION : BASE_VERSION, page: state.version.page,
      loadedWebRevision: state.version.loadedWebRevision, requiresRefresh: state.version.requiresRefresh,
      target: TARGET_VERSION, targetWebRevision: state.version.targetWebRevision || TARGET_REVISION,
      phase: percent === 100 ? (!state.version.requiresRefresh || state.version.loadedWebRevision === state.version.targetWebRevision ? 'current' : 'ready') : 'upgrading',
      verified: true, checkedAt: '刚刚（示例）' };
    if (disconnected()) update(); else setScenario(percent === 100 ? 'available' : 'upgrading', { versions: false });
  }
  function applyVersionScenario(value) {
    const version = state.version;
    state.contract = null;
    const known = (service, target, phase, reuseWeb = false) => {
      state.version = { service, page: version.page, target,
        loadedWebRevision: version.page === TARGET_VERSION ? TARGET_REVISION : BASE_REVISION,
        targetWebRevision: target ? (reuseWeb ? BASE_REVISION : TARGET_REVISION) : null,
        requiresRefresh: !!target && !reuseWeb, phase, verified: true, checkedAt: '刚刚（示例）' };
    };
    if (['normal', 'preparing', 'installable', 'shared-web', 'page-target'].includes(value)) { state.progress = null; state.attempt = null; }
    if (value.startsWith('contract-')) {
      known(TARGET_VERSION, TARGET_VERSION, 'current');
      state.version.page = TARGET_VERSION; state.version.loadedWebRevision = TARGET_REVISION;
      state.version.requiresRefresh = false;
      state.progress = demoProgress(PROGRESS_STEPS[4]);
      state.catalog = { ...fakeCatalog, verified: true };
      if (!state.attempt) createOfflineAttempt('completed'); else state.attempt.status = 'completed';
      const phase = value.slice('contract-'.length);
      state.contract = { phase, requestId: ['clearing', 'completed', 'unknown'].includes(phase) ? 'demo-contract-1' : null };
    }
    else if (value === 'normal') {
      known(version.service, null, 'current'); state.catalog = { version: version.service, packageRevision: null, verified: true };
    }
    else if (['installable', 'shared-web', 'page-target'].includes(value)) {
      known(BASE_VERSION, TARGET_VERSION, 'available-installable', value === 'shared-web');
      if (value === 'shared-web') { state.version.page = BASE_VERSION; state.version.loadedWebRevision = BASE_REVISION; }
      if (value === 'page-target') { state.version.page = TARGET_VERSION; state.version.loadedWebRevision = TARGET_REVISION; }
      state.catalog = { ...fakeCatalog, verified: true };
      if (!state.entryScene) state.entryScene = value === 'shared-web' ? 'upgrade-shared-web' : value === 'page-target' ? 'upgrade-page-target' : 'upgrade-available';
    }
    else if (value === 'preparing') {
      known(BASE_VERSION, TARGET_VERSION, 'preparing'); state.catalog = { version: BASE_VERSION, packageRevision: null, verified: true };
    }
    else if (value === 'upgrading') {
      known(BASE_VERSION, TARGET_VERSION, 'upgrading'); state.progress = demoProgress(PROGRESS_STEPS[1]);
      state.catalog = { ...fakeCatalog, verified: true }; createOfflineAttempt('upgrading');
      if (!state.entryScene) state.entryScene = 'upgrade-progress';
    }
    else if (value === 'available') {
      known(TARGET_VERSION, TARGET_VERSION, version.page === TARGET_VERSION ? 'current' : 'ready'); state.progress = demoProgress(PROGRESS_STEPS[4]);
      state.catalog = { ...fakeCatalog, verified: true };
      if (!state.attempt) createOfflineAttempt('completed'); else state.attempt.status = 'completed';
    }
    else if (value === 'candidate-failed') { known(version.service, TARGET_VERSION, 'failed'); if (state.attempt) state.attempt.status = 'failed'; }
    else if (value === 'maintenance-delayed') { known(version.service, TARGET_VERSION, 'delayed'); if (state.attempt) state.attempt.status = 'delayed'; }
    else if (value === 'version-unknown') {
      state.version = { ...version, phase: 'unknown', verified: false }; state.catalog.verified = false;
      if (state.attempt) state.attempt.status = 'unknown';
    }
    else if (value === 'restored') {
      state.version = { service: TARGET_VERSION, page: TARGET_VERSION, target: TARGET_VERSION,
        loadedWebRevision: TARGET_REVISION, targetWebRevision: TARGET_REVISION, requiresRefresh: false,
        phase: 'current', verified: true, checkedAt: '刚刚（示例）' };
      state.progress = demoProgress(PROGRESS_STEPS[4]);
      state.catalog = { ...fakeCatalog, verified: true };
      if (!state.attempt) createOfflineAttempt('completed'); else state.attempt.status = 'completed';
    }
    // 终端断线、重连与次数用完不构成版本证据，完整保留已有版本读数。
  }
  function versionStatus() {
    if (!state.version.verified) return { title: '待确认', tone: 'neutral', text: '版本信息读取失败；下面保留上次确认的读数，不能据此判断更新是否完成。' };
    switch (state.version.phase) {
      case 'available-installable': return { title: '待你升级', tone: 'info', text: `已发现安装包 ${state.catalog.version}；本实例仍安装 ${state.version.service}，当前页面为 ${state.version.page}。发布安装包不会自动升级本实例；只有明确选择「立即升级」才受理升级。${!state.version.requiresRefresh ? '本次复用原页面构建，实例升级完成后无需刷新页面。' : ''}` };
      case 'preparing': return { title: '准备中', tone: 'neutral', text: `正在准备 ${TARGET_VERSION}，当前服务仍为 ${BASE_VERSION}；版本尚未就绪。` };
      case 'upgrading': return { title: '升级中', tone: 'neutral', text: `用户已主动发起，本实例升级请求已受理（离线模拟）。阶段「${state.progress.stage}」，示例进度 ${state.progress.percent}%。${switchingService() ? `整体激活尚未确认，上次完整安装为 ${state.version.service}。` : `已安装服务仍为 ${state.version.service}。`}安装包已发布不等于实例已激活；仅本实例激活且页面可用后允许刷新。` };
      case 'ready': return { title: '已安装，待刷新页面', tone: 'info', text: `本实例已安装 ${state.version.service}。页面 ${state.version.page} → ${state.version.target}；当前页面尚未更新，刷新页面只重载本页面并重连原任务和终端。` };
      case 'failed': return { title: '更新未完成', tone: 'warn', text: `候选版本未通过检查，当前仍由 ${state.version.service} 提供服务；原任务不受影响。` };
      case 'delayed': return { title: '已延后', tone: 'neutral', text: `维护升级已延后，当前仍由 ${state.version.service} 提供服务；等待长任务自然结束，不停止任务或暂停自动化。` };
      default: return state.version.target && !state.version.requiresRefresh ? { title: '本实例已完成升级', tone: 'neutral', text: `本实例已安装 ${state.version.service}；页面仍是实际加载的 ${state.version.page}，本次复用原页面构建，无需刷新。` }
        : { title: '当前页面已同步', tone: 'neutral', text: '已核对当前服务与页面；没有需要刷新加载的目标页面。' };
    }
  }
  function paintVersionEntry() {
    const existing = $('[data-action="upgrade-toggle-versions"]');
    if (!canShowUpdate()) {
      const open = P.popover.isOpenFor(VERSION_POPOVER);
      const active = document.activeElement;
      const hadFocus = !!((existing && existing.contains(active)) || (open && P.popover.el.contains(active)));
      // 更新读数不再可信或页面已同步时，不能留下没有触发器的浮层，也不还焦点给将删除的按钮。
      if (open) P.popover.close(false);
      if (existing) {
        const actions = existing.parentElement; existing.remove();
        if (actions && actions.hasAttribute('data-upgrade-header-actions') && !actions.children.length) actions.remove();
      }
      if (hadFocus && !P.modals.length && !P.gated) {
        const card = $('#upgrade-version-card');
        const panel = $('#shell-main .term[role="tabpanel"]:not([hidden])');
        const safe = P.isShown(card) ? card : P.isShown(panel) ? panel : null;
        if (safe) safe.focus({ preventScroll: true }); else P.focusMain();
      }
      return;
    }
    const header = $('#shell-main .header');
    if (!header || P.gated) return;
    let actions = $('.header__actions', header);
    if (!actions) {
      actions = document.createElement('div'); actions.className = 'header__actions'; actions.dataset.upgradeHeaderActions = '';
      header.appendChild(actions);
    }
    let button = $('[data-action="upgrade-toggle-versions"]', actions);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button'; button.className = 'btn btn--tertiary btn--32 btn--icon upgrade-version-trigger';
      button.dataset.action = 'upgrade-toggle-versions'; button.dataset.fk = 'upgrade-version-trigger';
      button.dataset.tip = '版本与更新';
      button.setAttribute('aria-haspopup', 'dialog');
      button.innerHTML = '<span class="icon i-circle-arrow-up" aria-hidden="true"></span><span class="upgrade-update-dot" data-upgrade-update-dot aria-hidden="true" hidden></span>';
      actions.appendChild(button);
    }
    button.setAttribute('aria-label', inProgress() ? '版本与更新，本实例正在升级' : installable() ? '版本与更新，发现可安装新版本' : '版本与更新，有可用页面更新');
    const open = P.popover.isOpenFor(VERSION_POPOVER);
    button.setAttribute('aria-expanded', String(open));
    if (open) button.setAttribute('aria-controls', VERSION_POPOVER); else button.removeAttribute('aria-controls');
    button.classList.toggle('is-open', open);
    $('[data-upgrade-update-dot]', button).hidden = !(installable() || canRefreshVersion());
  }
  function paintUpdateNotice() {
    const trigger = $('[data-action="upgrade-toggle-versions"]');
    let notice = $('[data-upgrade-update-notice]');
    const show = canShowUpdate() && state.snoozedDate !== reminderToday();
    if (!show) { if (notice) notice.hidden = true; return; }
    if (!notice) {
      notice = document.createElement('aside');
      notice.className = 'card upgrade-update-notice'; notice.dataset.upgradeUpdateNotice = '';
      notice.setAttribute('role', 'region'); notice.setAttribute('aria-labelledby', 'upgrade-update-notice-title');
      notice.innerHTML = '<div class="upgrade-update-notice__head"><div><h2 id="upgrade-update-notice-title">发现新版本</h2><p data-upgrade-notice-versions></p></div><button class="btn btn--tertiary btn--24 btn--icon" type="button" data-action="upgrade-dismiss-today" data-fk="upgrade-notice-close" aria-label="今天不再提醒" data-tip="今天不再提醒"><span class="icon i-x" aria-hidden="true"></span></button></div><p class="popover__note" data-upgrade-notice-summary></p><div data-upgrade-notice-progress></div><div class="popover__actions"><button class="btn btn--secondary btn--32" type="button" data-action="upgrade-install-version" data-fk="upgrade-notice-install">立即升级</button><button class="btn btn--secondary btn--32" type="button" data-action="upgrade-refresh-version" data-fk="upgrade-notice-refresh">刷新页面</button><button class="btn btn--tertiary btn--32" type="button" data-action="upgrade-open-versions" data-fk="upgrade-notice-detail">查看详情</button></div>';
      $('#frame').appendChild(notice); P.upgradeTips(notice);
    }
    // 完整读数浮层由用户主动打开时暂时覆盖提醒；关闭后提醒仍按本日规则常驻。
    notice.hidden = !trigger || P.gated || P.ui.loading || P.popover.isOpenFor(VERSION_POPOVER);
    notice.inert = P.modals.length > 0;
    $('#upgrade-update-notice-title', notice).textContent = inProgress() ? `正在升级到 ${state.version.target}` : installable() ? `发现新版本 ${state.catalog.version}` : '升级完成，页面待刷新';
    const text = installable() ? `已安装 ${state.version.service} · 页面 ${state.version.page}` : `页面 ${state.version.page} → ${state.version.target}`;
    if ($('[data-upgrade-notice-versions]', notice).textContent !== text) $('[data-upgrade-notice-versions]', notice).textContent = text;
    const summary = $('[data-upgrade-notice-summary]', notice);
    summary.textContent = installable() ? (canInstallVersion() ? '安装包已发布，等待你主动升级本实例。' : installIntentText())
      : canRefreshVersion() ? `本实例已安装 ${state.version.service}；页面仍旧，刷新后重连原任务。` : '';
    summary.hidden = !summary.textContent;
    const progress = $('[data-upgrade-notice-progress]', notice); const progressMarkup = progressHtml();
    if (progress.dataset.html !== progressMarkup) { progress.innerHTML = progressMarkup; progress.dataset.html = progressMarkup; }
    progress.hidden = !progressMarkup;
    const refresh = $('[data-action="upgrade-refresh-version"]', notice);
    refresh.hidden = !canRefreshVersion();
    $('[data-action="upgrade-install-version"]', notice).hidden = !canInstallVersion();
    if (!notice.hidden) {
      const rect = trigger.getBoundingClientRect();
      const header = trigger.closest('.header');
      const headerBottom = header ? header.getBoundingClientRect().bottom : rect.bottom;
      notice.style.right = `${Math.max(8, window.innerWidth - Math.ceil(rect.right))}px`;
      notice.style.top = `${Math.round(Math.max(8, Math.min(headerBottom + 8, window.innerHeight - notice.offsetHeight - 8)))}px`;
    }
  }
  function checkReminderDay() {
    paintUpdateNotice(); paintDemoEvidence();
  }
  function versionPopoverHtml() {
    const status = versionStatus();
    const previous = switchingService() ? ` <span class="upgrade-version-last">上次完整发布 ${esc(state.version.service)}</span>`
      : state.version.verified ? '' : ' <span class="upgrade-version-last">上次确认</span>';
    const previousTarget = state.version.verified ? '' : ' <span class="upgrade-version-last">上次确认</span>';
    return `<div class="popover__head"><h2 class="popover__title" id="upgrade-version-popover-title">版本与更新</h2><p class="popover__desc">版本号仅为设计示例</p></div>
      <div class="popover__body"><dl class="kv"><dt>已发布可用版本</dt><dd data-upgrade-catalog-version>${esc(state.catalog.version)}${state.catalog.verified ? '' : ' · 上次确认'}</dd><dt>已安装服务版本</dt><dd data-upgrade-service-version>${esc(serviceVersionText())}${previous}</dd><dt>当前页面版本</dt><dd data-upgrade-current-page>${esc(state.version.page)}</dd><dt>本次已受理目标</dt><dd data-upgrade-target-version>${esc(state.attempt ? state.attempt.target : '—（尚未发起升级）')}${state.attempt ? previousTarget : ''}</dd><dt>更新状态</dt><dd><span class="badge badge--20 badge--${status.tone}" data-upgrade-version-status>${esc(status.title)}</span></dd></dl><p class="popover__note" data-upgrade-version-description>${esc(status.text)}</p>${installable() ? `<p class="popover__note" data-upgrade-install-permission>${esc(installIntentText())}</p>` : ''}${progressDisplayHtml()}</div>
      <div class="popover__foot"><div class="popover__actions"><button class="btn btn--tertiary btn--32" type="button" data-action="upgrade-check-version" data-fk="upgrade-popover-check" aria-busy="${state.versionChecking}" aria-disabled="${state.versionChecking}">${state.versionChecking ? '检查中…' : '检查更新'}</button><button class="btn btn--secondary btn--32" type="button" data-action="upgrade-install-version" data-fk="upgrade-popover-install"${canInstallVersion() ? '' : ' hidden'}>立即升级</button><button class="btn btn--secondary btn--32" type="button" data-action="upgrade-refresh-version" data-fk="upgrade-popover-refresh"${canRefreshVersion() ? '' : ' hidden'}>刷新页面</button><button class="btn btn--tertiary btn--32" type="button" data-action="upgrade-later" data-fk="upgrade-popover-later">稍后</button></div><button class="link" type="button" data-action="upgrade-open-versions" data-fk="upgrade-popover-detail">查看版本详情</button><p class="popover__note" data-upgrade-version-time>${esc(state.version.verified ? `检查于 ${state.version.checkedAt}` : `${state.version.checkedAt} · 当前待确认`)}</p></div>`;
  }
  function paintVersionPopover() {
    if (!P.popover.isOpenFor(VERSION_POPOVER)) return;
    const html = versionPopoverHtml();
    if (P.popover.el.dataset.versionHtml === html) return;
    P.popover.update(html); P.popover.el.dataset.versionHtml = html;
  }
  function paintVersionCard() {
    if (P.ui.loading || P.ui.route.view !== 'system') return;
    const board = $('#shell-main [data-testid="system-status-grid"]');
    if (!board) return;
    let section = $('[data-upgrade-version-section]', board);
    if (!section) {
      section = document.createElement('section'); section.className = 'section upgrade-version-section';
      section.dataset.upgradeVersionSection = ''; section.setAttribute('aria-labelledby', 'upgrade-version-heading');
      section.innerHTML = `<div class="section-head"><h2 class="section-head__title" id="upgrade-version-heading">版本与更新</h2><span class="section-head__meta">版本号仅为设计示例，不代表发布计划</span></div>
        <article class="card" id="upgrade-version-card" tabindex="-1" aria-labelledby="upgrade-version-heading">
          <ul class="list list--stack">
            <li class="list__row"><div class="list__line"><span class="list__name">已发布可用版本</span><span class="list__desc text-mono-13" data-upgrade-catalog-version></span><span class="upgrade-version-last" data-upgrade-last-catalog hidden>上次确认</span></div></li>
            <li class="list__row"><div class="list__line"><span class="list__name">已安装服务版本</span><span class="list__desc text-mono-13" data-upgrade-service-version></span><span class="upgrade-version-last" data-upgrade-last-service hidden>上次确认</span></div></li>
            <li class="list__row"><div class="list__line"><span class="list__name">当前页面版本</span><span class="list__desc text-mono-13" data-upgrade-current-page></span></div></li>
            <li class="list__row"><div class="list__line"><span class="list__name">本次已受理目标</span><span class="list__desc text-mono-13" data-upgrade-target-version></span><span class="upgrade-version-last" data-upgrade-last-target hidden>上次确认</span></div></li>
            <li class="list__row"><div class="list__line"><span class="list__name">更新状态</span><span class="badge badge--20 badge--neutral" data-upgrade-version-status></span></div><p class="list__note" data-upgrade-version-description role="status"></p></li>
            <li class="list__row" data-upgrade-card-progress hidden></li>
            <li class="list__row" data-upgrade-install-permission hidden></li>
          </ul><section class="upgrade-contract-section" aria-labelledby="upgrade-contract-heading" data-upgrade-contract hidden></section><div class="card__footer"><span class="card__footer-help" data-upgrade-version-time></span><div class="card__footer-end"><button class="btn btn--tertiary btn--32" type="button" data-action="upgrade-check-version" data-fk="upgrade-check-version">检查更新</button><button class="btn btn--secondary btn--32" type="button" data-action="upgrade-install-version" data-fk="upgrade-install-version" hidden>立即升级</button><button class="btn btn--secondary btn--32" type="button" data-action="upgrade-refresh-version" data-fk="upgrade-refresh-version" hidden>刷新页面</button></div></div>
        </article>`;
      board.prepend(section);
    }
    const status = versionStatus();
    $('[data-upgrade-catalog-version]', section).textContent = state.catalog.version;
    $('[data-upgrade-last-catalog]', section).hidden = state.catalog.verified;
    $('[data-upgrade-service-version]', section).textContent = serviceVersionText();
    $('[data-upgrade-current-page]', section).textContent = state.version.page;
    $('[data-upgrade-target-version]', section).textContent = state.attempt ? state.attempt.target : '—（尚未发起升级）';
    const lastService = $('[data-upgrade-last-service]', section);
    lastService.textContent = switchingService() ? `上次完整发布 ${state.version.service}` : '上次确认';
    lastService.hidden = state.version.verified && !switchingService();
    $('[data-upgrade-last-target]', section).hidden = state.version.verified || !state.attempt;
    const badge = $('[data-upgrade-version-status]', section);
    badge.className = `badge badge--20 badge--${status.tone}`; badge.textContent = status.title;
    const description = $('[data-upgrade-version-description]', section);
    if (description.textContent !== status.text) description.textContent = status.text;
    $('[data-upgrade-version-time]', section).textContent = state.version.verified ? `检查于 ${state.version.checkedAt}` : `${state.version.checkedAt} · 当前待确认`;
    const check = $('[data-action="upgrade-check-version"]', section);
    check.textContent = state.versionChecking ? '检查中…' : '检查更新';
    check.setAttribute('aria-busy', String(state.versionChecking)); check.setAttribute('aria-disabled', String(state.versionChecking));
    const refresh = $('[data-action="upgrade-refresh-version"]', section);
    refresh.hidden = !canRefreshVersion(); refresh.textContent = '刷新页面';
    $('[data-action="upgrade-install-version"]', section).hidden = !canInstallVersion();
    const permission = $('[data-upgrade-install-permission]', section);
    permission.textContent = installIntentText(); permission.hidden = !installable();
    const progress = $('[data-upgrade-card-progress]', section); const progressMarkup = progressDisplayHtml();
    if (progress.dataset.html !== progressMarkup) { progress.innerHTML = progressMarkup; progress.dataset.html = progressMarkup; }
    progress.hidden = !progressMarkup;
    paintContract(section);
    if (state.focusVersionCard) {
      state.focusVersionCard = false; const card = $('#upgrade-version-card');
      card.focus({ preventScroll: true }); section.scrollIntoView({ block: 'start', behavior: 'auto' });
    }
  }
  function paintContract(section) {
    const element = $('[data-upgrade-contract]', section), contract = state.contract;
    element.hidden = !contract;
    if (!contract) return;
    const labels = { waiting: '旧数据格式继续保留', available: '旧数据格式可单独清理',
      clearing: '正在清理旧数据格式', completed: '旧数据格式清理已完成', unknown: '清理结果待确认' };
    const reason = contract.phase === 'waiting' ? '回退窗口尚未结束，继续保留旧数据格式。'
      : contract.phase === 'unknown' ? '仅查询原请求，不重复执行。历史升级的100%记录保持不变。'
      : contract.phase === 'completed' ? '使用旧数据格式的历史版本无法重新接流。原任务继续运行。' : '';
    const html = `<h3 class="section-head__title" id="upgrade-contract-heading">旧数据格式清理</h3><p class="text-muted" role="status">${labels[contract.phase]}</p>${reason ? `<p class="text-muted">${esc(reason)}</p>` : ''}<dl class="kv"><dt>所属服务版本</dt><dd>${TARGET_VERSION}</dd><dt>回退窗口截止</dt><dd>${contract.phase === 'waiting' ? '明天 09:00（示例）' : '今天 09:00，已结束（示例）'}</dd><dt>旧版本读者</dt><dd>${['completed', 'clearing'].includes(contract.phase) ? '0' : '1'}（示例）</dd>${contract.requestId ? `<dt>本次清理阶段</dt><dd>${contract.phase === 'completed' ? 'completed' : contract.phase === 'unknown' ? '待确认' : 'clearing'}</dd><dt>已清理行数</dt><dd>${contract.phase === 'completed' ? '3 / 3' : contract.phase === 'unknown' ? '待确认' : '1 / 3'}（示例）</dd>` : ''}</dl>${contract.phase === 'available' ? '<button class="btn btn--secondary btn--32" type="button" data-action="upgrade-contract-confirm">清理旧数据格式</button>' : ''}`;
    if (element.dataset.html !== html) { element.innerHTML = html; element.dataset.html = html; }
  }
  function connectionHtml() {
    if (state.scenario === 'reconnect-confirmed') return `<div class="conn-bar conn-bar--warn wb-conn--wrap upgrade-connection" role="status" data-upgrade-connection><span class="icon icon--spin i-loader-circle" aria-hidden="true"></span><span class="wb-conn__text"><span class="conn-bar__title">连接短暂切换，正在重连。</span> 已确认原任务仍在后台运行，重新连接后继续显示输出。</span></div>`;
    if (state.scenario === 'reconnect-unknown') return `<div class="conn-bar conn-bar--warn wb-conn--wrap upgrade-connection" role="status" data-upgrade-connection><span class="icon icon--spin i-loader-circle" aria-hidden="true"></span><span class="wb-conn__text"><span class="conn-bar__title">连接暂时中断，正在重连。</span> 当前任务状态尚未确认；已保留上次输出，连接恢复后重新核对。</span></div>`;
    if (state.scenario === 'retry-exhausted') return `<div class="conn-bar conn-bar--warn wb-conn--wrap upgrade-connection" role="status" data-upgrade-connection><span class="icon i-unplug" aria-hidden="true"></span><span class="wb-conn__text"><span class="conn-bar__title">暂时未能重新连接。</span> 当前任务状态尚未确认；上次输出仍保留，不会因此发起停止或新建任务。</span><div class="conn-bar__end"><button class="btn btn--secondary btn--24" type="button" data-action="upgrade-retry" data-fk="upgrade-retry">重新连接</button></div></div>`;
    if (state.scenario === 'restored') return `<div class="conn-bar wb-conn--wrap upgrade-connection upgrade-connection--restored" role="status" data-upgrade-connection><span class="icon i-circle-check" aria-hidden="true"></span><span class="wb-conn__text"><span class="conn-bar__title">已重新连接原任务。</span> Agent 与已打开的终端继续使用原会话。</span></div>`;
    return '';
  }
  function paintConnection(host, t) {
    if (t.id !== TASK) return;
    let node = $('[data-upgrade-connection]', host);
    const html = connectionHtml();
    if (!html) { if (node) node.remove(); }
    else if (!node || node.dataset.html !== html) {
      const template = document.createElement('template'); template.innerHTML = html;
      const next = template.content.firstElementChild; next.dataset.html = html;
      if (node) node.replaceWith(next); else $('.termbar', host).after(next);
    }
    for (const panel of $$('.term[role="tabpanel"]', host)) {
      panel.dataset.upgradeTransport = disconnected() ? 'reconnecting' : 'connected';
    }
  }
  function paintUnknownStatus() {
    const row = $(`[data-fk="tt:${TASK}"]`);
    const t = target();
    if (row) {
      const dot = $('.status-dot', row);
      const sub = $('.tree-task__sub', row.closest('.tree-task'));
      if (unknown()) {
        dot.className = 'status-dot status-dot--stopped';
        dot.setAttribute('aria-label', '当前状态待确认');
        sub.textContent = `上次状态：${P.STATE[t.state].word} · 当前待确认`;
      } else {
        dot.className = `status-dot status-dot--${P.STATE[t.state].dot}`;
        dot.setAttribute('aria-label', P.STATE[t.state].word);
        sub.innerHTML = P.taskSub(t);
      }
    }
    if (!P.currentTask() || P.currentTask().id !== TASK) return;
    const badge = $('#shell-main [data-slot="header"] .badge');
    if (!badge) return;
    const label = $('.badge__label', badge);
    const dot = $('.status-dot', badge);
    badge.className = unknown() ? 'badge badge--neutral' : `badge badge--${P.STATE[t.state].badge}`;
    if (label) label.textContent = unknown() ? '状态待确认' : P.STATE[t.state].word;
    if (dot) dot.className = unknown() ? 'status-dot status-dot--stopped' : `status-dot status-dot--${P.STATE[t.state].dot}`;
  }
  function update() {
    paintOutput(); P.refreshMain(); paintUnknownStatus(); paintVersionEntry(); paintVersionCard(); paintVersionPopover(); paintUpdateNotice(); remember(); paintDemoEvidence();
  }
  function setScenario(value, { announce = true, versions = true } = {}) {
    if (!SCENARIOS.some(([key]) => key === value)) return;
    clearTimeout(state.timer);
    state.scenario = value;
    if (versions) applyVersionScenario(value);
    if (P.scenario.get('upgrade') !== value) {
      syncingScenario = true;
      P.scenario.set('upgrade', value);
      syncingScenario = false;
    }
    // 提醒按实例 / 当前示例用户的本地自然日关闭，与目标 revision 无关。
    if (!unknown()) { state.observedSequence = state.sequence; state.lastVerifiedAt = '刚刚'; }
    update();
    if (announce) P.announce(SCENARIOS.find(([key]) => key === value)[1]);
    if (value === 'restored') state.timer = setTimeout(() => setScenario('normal', { announce: false, versions: false }), 5000);
  }
  function ensureTask() {
    const t = target();
    if (!t || !P.TERM_STATES.has(t.state) || t.state === 'stopping') return false;
    if (!P.currentTask() || P.currentTask().id !== TASK) P.go(`task-${TASK}`);
    P.tabsState(t); return true;
  }
  function refreshPage() {
    if (!canRefreshVersion()) { P.announce('没有已确认就绪的新页面版本，请先检查版本信息。'); return; }
    const activeBefore = document.activeElement;
    const taskStateUnknown = unknown();
    const oldTask = target();
    const before = P.ui.tabs[TASK] && P.ui.tabs[TASK].list.map((tab) => ({ ...tab }));
    state.refreshed = true;
    // 模拟浏览器重新装配，并从权威的示例清单附着既有会话；不创建任务或重跑指令。
    if (before && oldTask && P.TERM_STATES.has(oldTask.state)) {
      const active = P.ui.tabs[TASK].active;
      P.ui.tabs[TASK] = { list: before, active, seq: P.ui.tabs[TASK].seq };
      state.shellRecovered = before.some((tab) => tab.kind !== 'agent');
    }
    state.version = { ...state.version, page: state.version.target, loadedWebRevision: state.version.targetWebRevision, phase: 'current', checkedAt: '刚刚（示例）' };
    // 刷新页面不证明终端已恢复；任务状态未知时仍保留待确认状态。
    setScenario(taskStateUnknown ? 'reconnect-unknown' : 'restored', { versions: false });
    if (P.popover.isOpenFor(VERSION_POPOVER)) P.popover.close(true);
    if (!P.isShown(activeBefore)) {
      const card = $('#upgrade-version-card');
      const activePanel = $('#shell-main .term[role="tabpanel"]:not([hidden])');
      if (card) card.focus({ preventScroll: true }); else if (activePanel) activePanel.focus({ preventScroll: true });
    }
  }
  function addDemoShell() {
    if (!ensureTask()) return;
    const tabs = P.tabsState(target());
    tabs.seq += 1;
    const tab = { id: `login-n${tabs.seq}`, kind: 'shell', label: `终端 ${tabs.seq}`, tpl: 'term-login-shell', demoOutput: true };
    tabs.list.push(tab); tabs.active = tab.id; update();
    P.announce(`演示：已打开 ${tab.label}。刷新后仍连接这个终端。`);
  }
  function evidenceText() {
    switch (state.scenario) {
      case 'candidate-failed': return '候选版本未通过检查，未接管流量；旧服务继续提供服务。原任务、原进程和终端均未被停止。';
      case 'maintenance-delayed': return '本次维护升级无法安全续接运行环境，已延后。继续等待长任务自然结束；没有停止任务，也没有自动暂停自动化规则。';
      case 'reconnect-unknown': case 'retry-exhausted': return `当前任务状态尚未确认。仅保留上次已核对的输出序号 ${state.observedSequence}；界面不宣称任务仍在运行或已经停止。`;
      case 'reconnect-confirmed': return '独立运行状态已确认：原任务仍在后台运行。这里仅重建浏览器连接，不重启运行环境。';
      case 'restored': return '已核对并重新连接同一个原任务和原进程；原用户终端清单已恢复，原指令没有再次执行。';
      case 'available': return '右上角图标与紧凑浮卡仅在存在已就绪的新页面时出现，不抢焦点、不自动刷新。关闭或点「稍后」后当天跨页、刷新和新标签不再浮卡提醒；下一本地自然日仍有可用新版才恢复。今日关闭后仍有新版，图标与静态小点继续可用；系统页版本卡始终可查。';
      case 'installable': case 'shared-web': case 'page-target': return 'fakeCatalog 只模拟 CD 发布安装包。发现 v0.3.9 时本实例仍安装 v0.3.8，不创建升级尝试、不显示百分比、不刷新；已进入平台的用户直接选择产品「立即升级」才模拟受理，无需额外口令、密钥或授权。真实请求必须由后端验证已有访问会话、Origin／CSRF、实例绑定与幂等性。页面与实例版本独立；复用原页面构建无需刷新，页面已是新版也不表示实例已安装。当天关闭提醒不阻止主动升级，升级阶段也不清当天设置。';
      case 'upgrading': return `这是用户已主动发起并受理的实例升级夹具，当前模拟阶段为「${state.progress.stage}」${state.progress.percent}%。不是目录发布自动部署；百分比由演示按钮手动推进，正常产品读取本实例真实升级进度。原任务与终端保持不变，本实例激活确认后才可刷新。`;
      case 'preparing': return '正在准备示例 v0.3.9；当前服务仍为 v0.3.8。尚未通过就绪检查，不提供刷新到新版本的入口。';
      case 'version-unknown': return '版本读数待确认；只展示上次已知服务与目标版本，不从终端断线推断服务已经升级。';
      default: return '原任务持续运行。演示只改变服务版本与连接状态，不触发停止、启动、销毁或再次发起原指令。';
    }
  }
  function paintDemoEvidence() {
    const evidence = $('[data-upgrade-evidence]');
    if (!evidence) return;
    const tabs = P.ui.tabs[TASK] || P.tabsState(target());
    $('[data-upgrade-evidence-text]', evidence).textContent = evidenceText();
    $('[data-upgrade-process]', evidence).textContent = unknown() ? `${PROCESS}（上次确认）` : PROCESS;
    $('[data-upgrade-sequence]', evidence).textContent = String(state.observedSequence);
    $('[data-upgrade-tabs]', evidence).textContent = tabs.list.map((tab) => tab.label).join('、');
    $('[data-upgrade-focus]', evidence).textContent = state.refreshed ? '已刷新并附着原会话' : '尚未刷新';
    $('[data-upgrade-reminder-today]', evidence).textContent = `${reminderToday()}（本地自然日${state.demoDayOffset ? `，示例已前进 ${state.demoDayOffset} 天` : ''}）`;
    $('[data-upgrade-reminder-state]', evidence).textContent = state.snoozedDate === reminderToday() ? '今天已关闭浮卡；仍可主动查看、升级或刷新' : '今天尚未关闭；仅可信待升级、进行中或待刷新时提醒';
    $('[data-upgrade-request-evidence]', evidence).textContent = state.attempt ? `${state.attempt.id} · 请求 ${state.attempt.requestId} · 累计受理 ${state.acceptedCount} 次（模拟）` : '未受理实例升级；没有 attempt／百分比';
  }
  function openDemo(returnTo) {
    const html = `<div class="dialog dialog--576" role="dialog" aria-modal="true" aria-labelledby="upgrade-demo-title" aria-describedby="upgrade-demo-description" data-dialog="upgrade-demo">
      <div class="dialog__header"><h2 class="dialog__title" id="upgrade-demo-title">服务升级与沙箱续接 · 演示</h2><p class="dialog__subtitle" id="upgrade-demo-description">沿用现有 v2 工作台，只演示新增的升级与连接状态。</p></div>
      <div class="dialog__body proto-about upgrade-demo-body">
        <p>这是离线设计稿，使用 fakeCatalog 和 offline request 模拟，不连接服务、不执行部署。v0.3.8／v0.3.9 仅为展示示例。CD 只发布安装包；发现新包后等待用户在产品浮卡／版本详情里点「立即升级」，真实实施须由后端验证已有访问会话、Origin／CSRF、实例绑定、实例兼容和幂等受理。受理后才有实例 attempt 与百分比；20／45／75／95／100 只用演示按钮手动推进。100% 表示本实例激活已确认；页面仍旧才提供「刷新页面」。关闭浮卡只暂停本地当天提醒，不阻止主动升级，跨待升级／进行中／待刷新也不重出；次日复核后恢复。系统页始终可查。</p>
        <label class="field"><span class="field__label">演示场景</span><span class="select select--32"><select class="select__control" data-upgrade-scenario data-fk="upgrade-scenario">${SCENARIOS.map(([value, label]) => `<option value="${value}"${state.scenario === value ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select><span class="icon i-chevron-down select__icon" aria-hidden="true"></span></span></label>
        <div class="upgrade-demo-actions"><button class="btn btn--secondary btn--32" type="button" data-action="upgrade-restore-reminder">恢复新版提示</button><button class="btn btn--secondary btn--32" type="button" data-action="upgrade-start-progress">开始升级演示</button><button class="btn btn--secondary btn--32" type="button" data-action="upgrade-advance-progress">推进升级</button><button class="btn btn--secondary btn--32" type="button" data-action="upgrade-installed-ready">已安装待刷新</button><button class="btn btn--secondary btn--32" type="button" data-action="upgrade-show-task">查看原任务</button><button class="btn btn--secondary btn--32" type="button" data-action="upgrade-add-shell">打开一个示例终端</button><button class="btn btn--secondary btn--32" type="button" data-action="upgrade-simulate-refresh">演示刷新并重连</button><button class="btn btn--secondary btn--32" type="button" data-action="upgrade-recover">模拟连接恢复并核对</button><button class="btn btn--secondary btn--32" type="button" data-action="upgrade-next-day">模拟到明天</button></div>
        <section class="upgrade-demo-evidence" aria-labelledby="upgrade-evidence-title" data-upgrade-evidence><h3 id="upgrade-evidence-title">示例证据（用于评审）</h3><p data-upgrade-evidence-text></p><dl><dt>原任务</dt><dd>修一下登录态刷新 · login</dd><dt>原进程</dt><dd data-upgrade-process></dd><dt>已核对输出序号</dt><dd data-upgrade-sequence></dd><dt>原终端清单</dt><dd data-upgrade-tabs></dd><dt>页面状态</dt><dd data-upgrade-focus></dd><dt>提醒日期</dt><dd data-upgrade-reminder-today></dd><dt>本日提醒</dt><dd data-upgrade-reminder-state></dd><dt>升级受理</dt><dd data-upgrade-request-evidence></dd><dt>停止／重跑原指令</dt><dd>0 次／0 次</dd></dl></section>
        <p class="upgrade-demo-footnote">通过 <code class="code">?scene=upgrade-available</code> 首次进入待用户升级场景；<code class="code">?scene=upgrade-progress</code> 为已主动发起的45%夹具，<code class="code">?scene=upgrade-ready</code> 为已安装待刷新夹具；<code class="code">?scene=upgrade-shared-web</code> 展示实际页面v0.3.8构建复用、实例仍待升级；<code class="code">?scene=upgrade-page-target</code> 展示页面已新但实例仍旧。实际刷新保留示例安装状态、attempt、进度、页面和今日关闭设置。「恢复新版提示」主动恢复待升级样例并仅清此设计提醒；「已安装待刷新」直接载入已激活夹具；「开始升级演示」直接载入已受理20%夹具并重置本设计提醒，「推进升级」手动执行20／45／75／95／100%。这些工具均保留原任务、标签与虚拟输出时钟，不能作为生产部署入口。本设计展示通过现有访问保护后的页面，没有升级授权按钮或密钥表单；产品立即升级处理器仍检查可安装状态与同一attempt幂等性。「模拟到明天」只改变本页提醒日期偏移，不改全局Date或认证时钟。终端记录仅含虚构示例，不保存真实shellId、token、socketSessionKey、口令或任务指令。</p>
      </div><div class="dialog__footer"><button class="btn btn--tertiary btn--32" type="button" data-action="upgrade-reset">重置演示</button><div class="dialog__footer-end"><button class="btn btn--secondary btn--32" type="button" data-dlg="cancel">回到工作台</button></div></div><button class="btn btn--tertiary btn--28 btn--icon dialog__close" type="button" aria-label="关闭演示" data-dlg="cancel"><span class="icon i-x" aria-hidden="true"></span></button></div>`;
    const modal = P.openModal(html, { kind: 'upgrade-demo', returnTo, initialFocus: '[data-upgrade-scenario]' });
    modal.box.addEventListener('click', (event) => { if (event.target.closest('[data-dlg="cancel"]')) P.closeModal(modal); });
    modal.box.addEventListener('change', (event) => { if (event.target.matches('[data-upgrade-scenario]')) P.scenario.set('upgrade', event.target.value); });
    paintDemoEvidence();
  }
  function closeDemo() { const modal = P.topModal(); if (modal && modal.kind === 'upgrade-demo') P.closeModal(modal); }
  P.actions['upgrade-demo'] = openDemo;
  P.actions['upgrade-show-task'] = () => { closeDemo(); ensureTask(); };
  P.actions['upgrade-add-shell'] = () => { closeDemo(); addDemoShell(); };
  P.actions['upgrade-simulate-refresh'] = () => { closeDemo(); if (!canRefreshVersion()) setScenario('available'); refreshPage(); };
  P.actions['upgrade-recover'] = () => { closeDemo(); state.observedSequence = state.sequence; setScenario('restored', { versions: false }); };
  P.actions['upgrade-retry'] = () => { setScenario('reconnect-unknown', { versions: false }); state.timer = setTimeout(() => { state.observedSequence = state.sequence; setScenario('restored', { versions: false }); }, 1500); };
  P.actions['upgrade-next-day'] = () => { closeDemo(); state.demoDayOffset += 1; checkReminderDay(); P.announce(`演示提醒日期已前进到 ${reminderToday()}，原任务和版本读数保持不变。`); };
  P.actions['upgrade-install-version'] = () => startInstanceUpgrade();
  P.actions['upgrade-start-progress'] = () => {
    closeDemo(); state.snoozedDate = null; state.demoDayOffset = 0; state.refreshed = false; state.entryScene = 'upgrade-progress';
    try { localStorage.removeItem(REMINDER_STORE); } catch (e) { /* 不阻断本页的显式演示。 */ }
    state.version = { ...state.version, page: BASE_VERSION, loadedWebRevision: BASE_REVISION,
      targetWebRevision: TARGET_REVISION, requiresRefresh: true }; state.attempt = null; createOfflineAttempt(); setProgress(20);
    P.announce('已开始模拟升级：20%，原任务与终端保持不变。');
  };
  P.actions['upgrade-advance-progress'] = () => {
    closeDemo();
    if (!inProgress()) { P.announce('没有可信的进行中示例，请先开始升级演示。'); return; }
    const next = PROGRESS_STEPS[PROGRESS_STEPS.findIndex((step) => step.percent === state.progress.percent) + 1];
    if (next) { setProgress(next.percent); P.announce(`模拟升级进度 ${next.percent}%，${next.stage}。`); }
  };
  P.actions['upgrade-restore-reminder'] = () => {
    closeDemo(); state.snoozedDate = null; state.demoDayOffset = 0; state.refreshed = false; state.entryScene = 'upgrade-available';
    try { localStorage.removeItem(REMINDER_STORE); } catch (e) { /* 不阻断本页的演示恢复。 */ }
    state.version = { ...state.version, page: BASE_VERSION };
    applyVersionScenario('installable');
    if (disconnected()) update(); else setScenario('installable', { versions: false });
    P.announce('已主动恢复待升级安装包提示；本实例尚未升级，原任务和终端保持不变。');
  };
  P.actions['upgrade-installed-ready'] = () => {
    closeDemo(); state.refreshed = false; state.entryScene = 'upgrade-ready';
    state.version = { ...state.version, page: BASE_VERSION }; setScenario('available');
    P.announce('离线夹具：本实例已安装新版，当前页面待刷新。');
  };
  P.actions['upgrade-toggle-versions'] = (trigger) => {
    if (!canShowUpdate()) { paintVersionEntry(); return; }
    if (P.popover.isOpenFor(VERSION_POPOVER)) { P.popover.close(true); return; }
    const html = versionPopoverHtml();
    const popover = P.popover.open(trigger, { id: VERSION_POPOVER, html, fks: ['upgrade-version-trigger'], focus: true, onClose: () => { paintVersionEntry(); paintUpdateNotice(); } });
    popover.classList.add('upgrade-version-popover'); popover.dataset.upgradeVersionPopover = ''; popover.dataset.versionHtml = html;
    paintVersionEntry(); paintUpdateNotice();
  };
  P.actions['upgrade-open-versions'] = () => {
    if (P.popover.isOpenFor(VERSION_POPOVER)) P.popover.close(false);
    state.focusVersionCard = true;
    if (P.ui.route.view !== 'system') P.go('system'); else paintVersionCard();
  };
  P.actions['upgrade-refresh-version'] = () => refreshPage();
  P.actions['upgrade-contract-confirm'] = () => {
    if (state.contract?.phase !== 'available') return;
    const modal = P.openModal(`<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="upgrade-contract-title"><div class="dialog__header"><h2 class="dialog__title" id="upgrade-contract-title">确认清理旧数据格式</h2></div><div class="dialog__body"><p>这一步单独提交清理请求。服务端会重新核验回退窗口已结束、旧版本读者已退休、数据对账一致，随后停用旧数据表示并继续使用当前格式。</p><p>清理完成后，使用旧数据格式的历史版本无法重新接流。</p></div><div class="dialog__footer"><div class="dialog__footer-end"><button class="btn btn--secondary btn--32" type="button" data-dlg="cancel">取消</button><button class="btn btn--primary btn--32" type="button" data-contract-accept>确认清理</button></div></div></div>`, { kind: 'upgrade-contract', returnTo: document.activeElement, initialFocus: '[data-dlg="cancel"]' });
    modal.box.addEventListener('click', (event) => {
      if (event.target.closest('[data-dlg="cancel"]')) { P.closeModal(modal); return; }
      if (!event.target.closest('[data-contract-accept]')) return;
      if (state.contract?.phase !== 'available') { P.closeModal(modal); return; }
      state.contract = { phase: 'clearing', requestId: 'demo-contract-1' };
      state.scenario = 'contract-clearing'; P.closeModal(modal); update();
      P.announce('离线模拟：独立清理请求已受理。用演示场景切换查看完成或待确认状态。');
    });
  };
  P.actions['upgrade-check-version'] = () => {
    if (state.versionChecking) return;
    state.versionChecking = true; paintVersionCard(); paintVersionPopover();
    setTimeout(() => {
      state.versionChecking = false;
      if (state.version.verified) state.version.checkedAt = '刚刚（示例）';
      paintVersionCard(); paintVersionEntry(); paintVersionPopover(); paintUpdateNotice(); remember();
      P.announce(state.version.verified ? '版本信息已重新核对。' : '版本信息仍未读取成功，保留上次确认的读数。');
    }, 650);
  };
  P.actions['upgrade-later'] = () => {
    const ready = snoozeToday();
    if (P.popover.isOpenFor(VERSION_POPOVER)) P.popover.close(true);
    paintVersionEntry(); paintVersionCard(); paintUpdateNotice(); remember();
    P.announce(ready ? '今天不再提醒，仍可主动查看详情、升级或刷新页面。' : '已关闭版本详情。');
  };
  P.actions['upgrade-dismiss-today'] = () => {
    const notice = $('[data-upgrade-update-notice]'); const hadFocus = notice && notice.contains(document.activeElement);
    if (!snoozeToday()) return;
    paintUpdateNotice(); paintDemoEvidence();
    if (hadFocus) { const trigger = $('[data-action="upgrade-toggle-versions"]'); if (trigger) trigger.focus({ preventScroll: true }); }
    P.announce('今天不再提醒，仍可主动查看详情、升级或刷新页面。');
  };
  P.actions['upgrade-reset'] = () => {
    closeDemo(); clearTimeout(state.timer);
    state.sequence = 41; state.observedSequence = 41; state.refreshed = false; state.shellRecovered = false;
    state.snoozedDate = null; state.demoDayOffset = 0; state.versionChecking = false;
    state.progress = null; state.entryScene = null; state.attempt = null; state.requestSeq = 0; state.acceptedCount = 0;
    state.contract = null;
    state.catalog = { version: BASE_VERSION, packageRevision: null, verified: true };
    state.version = { service: BASE_VERSION, page: BASE_VERSION, loadedWebRevision: BASE_REVISION,
      target: null, targetWebRevision: null, requiresRefresh: false, phase: 'current', verified: true, checkedAt: '刚刚（示例）' };
    delete P.ui.tabs[TASK];
    try { sessionStorage.removeItem(STORE); localStorage.removeItem(REMINDER_STORE); } catch (e) { /* 不阻断原型。 */ }
    ensureTask(); setScenario('normal');
  };
  P.hook('scenario', (key, value) => { if (key === 'upgrade' && !syncingScenario) setScenario(value); });
  P.hook('main:refreshed', () => { paintUnknownStatus(); paintVersionEntry(); paintVersionCard(); paintVersionPopover(); paintUpdateNotice(); });
  P.hook('rendered', () => { paintUnknownStatus(); paintVersionEntry(); paintVersionCard(); paintUpdateNotice(); remember(); });
  P.hook('resize', () => paintUpdateNotice());
  P.hook('inert', (on) => { const notice = $('[data-upgrade-update-notice]'); if (notice) notice.inert = on; });
  P.hook('term:rendered', (host, task) => {
    paintConnection(host, task);
    if (task.id === TASK) { paintOutput(); remember(); }
  });
  P.hook('boot', () => {
    readDailyReminder();
    const restored = restoreRecord(saved);
    if (entryScene === 'upgrade-contract' && !state.entryScene) {
      state.entryScene = entryScene; state.scenario = 'contract-available'; applyVersionScenario(state.scenario);
    }
    if (restored && state.refreshed && state.version.verified && ['normal', 'restored'].includes(state.scenario)) state.scenario = 'restored';
    if (['upgrade-available', 'upgrade-ready', 'upgrade-progress', 'upgrade-shared-web', 'upgrade-page-target'].includes(entryScene)
      && !state.entryScene && !state.progress && !state.attempt && state.version.service !== TARGET_VERSION) {
      state.entryScene = entryScene;
      const scenario = entryScene === 'upgrade-progress' ? 'upgrading' : entryScene === 'upgrade-ready' ? 'available'
        : entryScene === 'upgrade-shared-web' ? 'shared-web' : entryScene === 'upgrade-page-target' ? 'page-target' : 'installable';
      applyVersionScenario(scenario);
      if (!disconnected()) state.scenario = scenario;
    }
    syncingScenario = true;
    P.scenario.set('upgrade', state.scenario);
    syncingScenario = false;
    paintOutput(); paintVersionEntry();
  });
  P.hook('loaded', () => { if (entryScene === 'upgrade-contract') P.go('system'); update(); });
  P.clock.ticker({
    active: () => !!target() && target().state === 'running',
    tick(now) {
      if (now < (state.nextOutput || 0)) return;
      state.nextOutput = now + 4000;
      state.sequence += 1;
      if (!disconnected()) state.observedSequence = state.sequence;
      paintOutput(); remember(); paintDemoEvidence();
    },
  });
  // 延续已有原型说明，补充本轮入口，修正关于实际 taskId 路由的历史说明。
  const originalAbout = P.openAbout;
  P.openAbout = function (...args) {
    const modal = originalAbout(...args);
    const panel = $('#ab-panel-about', modal.box);
    for (const paragraph of $$('p', panel)) {
      paragraph.innerHTML = paragraph.innerHTML.replace('任务深链 <code class="code">?taskId=</code>（计划中，原型用自己的 <code class="code">#task-&lt;id&gt;</code>）；', '本原型使用 <code class="code">#task-&lt;id&gt;</code> 定位示例任务；真实页面的 <code class="code">?taskId=</code> 值为 sandbox ID，本轮沿用现有任务定位；');
    }
    const note = document.createElement('div');
    note.innerHTML = '<h3>本轮：服务升级与原沙箱续接</h3><p>CD只发布安装包；<code class="code">?scene=upgrade-available</code> 首次展示发现新版但本实例尚未升级，用户进入平台后直接点「立即升级」才模拟受理，无需额外升级密钥或授权步骤。待升级和已安装待刷新有静态点；进行中无点且百分比只由演示按钮推进。<code class="code">?scene=upgrade-progress</code> 是已主动发起45%夹具，<code class="code">?scene=upgrade-ready</code> 是已安装待刷新夹具。今日关闭浮卡不会阻止主动升级，阶段变化不重出；次日复核恢复。右下角升级演示有恢复待升级提示、已安装待刷新、开始／推进升级；原任务与终端保持。系统页区分已发布包、已安装服务和已加载页面。<code class="code">?scene=upgrade-contract</code> 展示独立旧数据格式清理；演示场景可切换等待、可清理、进行中、完成与结果待确认，原升级100%与原任务保持。</p>';
    panel.prepend(note);
    const gallery = $('.dialog__footer a', modal.box);
    if (gallery) { gallery.href = 'task-search-image-alias.html'; gallery.lastChild.textContent = '原 v2 原型'; }
    return modal;
  };
  P.stateExtras.push(() => ({ upgrade: {
    scenario: state.scenario, taskId: TASK, processId: PROCESS, sequence: state.sequence,
    observedSequence: state.observedSequence, refreshed: state.refreshed, shellRecovered: state.shellRecovered,
    version: { ...state.version }, progress: state.progress ? { ...state.progress } : null,
    catalog: { ...state.catalog },
    attempt: state.attempt ? { ...state.attempt } : null, requestSeq: state.requestSeq, acceptedCount: state.acceptedCount,
    acceptedTarget: state.attempt ? state.attempt.target : null,
    installAcceptedCount: state.acceptedCount, requiresRefresh: state.version.requiresRefresh,
    loadedWebRevision: state.version.loadedWebRevision, targetWebRevision: state.version.targetWebRevision,
    entryScene: state.entryScene, reminderToday: reminderToday(), snoozedDate: state.snoozedDate,
    demoDayOffset: state.demoDayOffset, reminderKey: REMINDER_STORE,
    stopCommands: 0, promptReplays: 0,
  } }));
  // 自然日提醒用浏览器本地时钟，低频检查；回到页面立即复核，不依赖虚拟任务时钟。
  setInterval(checkReminderDay, 60000);
  const resumeReminder = () => { readDailyReminder(); checkReminderDay(); };
  window.addEventListener('focus', resumeReminder);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resumeReminder(); });
  window.addEventListener('storage', (event) => { if (event.key === REMINDER_STORE || event.key === null) resumeReminder(); });
  window.addEventListener('pagehide', remember);
})();
