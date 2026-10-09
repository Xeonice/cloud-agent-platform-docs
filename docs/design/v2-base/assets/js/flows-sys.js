/*
 * 交互原型 · 系统状态（js/flows-sys.js）：L5 四个流程（第三段接线）
 *   F-SYS-RESOURCE  本机资源：直开 #system 首屏就是本页骨架（资源卡 / 沙箱环境卡 / 审计 5 行）；场景「每次进入先出骨架」；[刷新]（刷新中…，保留旧数字）；
 *                   告警 / 严重 / 成果过量（主数字、口径句、按触发维度的下一步）；[清理成果] → 跨项目「保留下来的成果」（Q-DS-33 A），删掉一份资源卡同步
 *                   （2026-10-04 用户拍板 Q-SYS-23 A / Q-SBX-03 A：屏上「保留卷」→「保留下来的成果」，资源卡那一行写「成果占用」、按钮 [清理成果]；接口字段 retainedVolumes 不改）
 *   F-SYS-CONN      连接卡（只报本页测到的）、沙箱环境（正常 / 不健康）、离线（阻断横幅 + [重新检测] 就地诊断）、后端不可达（各卡原位读取失败、横幅不自指、
 *                   [刷新] 或 30 秒后自动重取复原）、出网代理（保存中… → 成功一句 +「已配置」/ 格式不对标红；读取失败不给表单 + [重试]）
 *   F-SYS-DIAG      一键诊断：连接中（首帧未到）→ 9 项按清单占位逐项到达 → 完成（三种汇总，超时单列）/ 中断（保留已到结果、其余「未返回」）；
 *                   非正常项默认展开；导出日志；命令 [复制]；横幅 [重新检测]、⌘K「运行诊断」进页即跑一轮（已在本页就地跑）；结果跨页保留
 *   F-SYS-AUDIT     审计流：类别 / 仅告警 / 起止（只填一端也行；起晚于止就地提示、不重查）、行内详情（同一时刻一行）、按任务看完整时间线（就地筛 chip）、
 *                   加载更早（到底「已到最早记录」）、实时中断 + 断层（[加载中间部分] 补一段）、三种空态、加载失败 + [重试]
 * 标记来源：页面骨架 tpl-system ← f-sys-conn-01（header, main）；骨架 / 失败 / 结果句 / 空态 / chip 等部件 ← f-sys-resource-01、f-sys-conn-0x、f-sys-diag-0x、
 *           f-sys-audit-0x（index.html 的 tpl-sys-*，build-proto.cjs 同源拷贝）；资源卡、连接卡、诊断行、审计行按同一套类名由本文件按数据画。
 * 产品口径：gap/product/SYS.md（AC 的 Then）；接线要点：gap/drafts/notes/sys-a.md §5、sys-b.md §4；示例世界 consistency.md ③⑤⑨⑩⑪；待定问题按 open-questions 默认。
 * 给别处的出口：P.requestDiagnose()（横幅 / ⌘K / 向导完成后用）、P.sysNet（最近一次联网检查的结论，离线横幅与向导共用）、P.proxySettings（出网代理，向导第 2 步同一份）、
 *           P.sysResources()（本机资源读数，向导第 5 步读同一份）、P.validateProxy()。
 */
(function () {
  'use strict';
  const P = window.P;
  const { $, $$, esc, ui } = P;
  const world = P.world;
  const T = P.TIMING;
  const frag = (html) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild; };
  const tplEl = (id, sel, opts) => { const t = P.fromTpl(id, opts); return sel ? $(sel, t) || t : t; };

  // ------------------------------------------------------------------ 场景（「原型说明 › 场景 › 系统状态」；也可 #system&scenario=键:值）
  const G = '系统状态';
  P.scenario.define({ key: 'sys-load', group: G, label: '系统状态页读取', def: 'ok', options: [['ok', '正常'], ['slow', '每次进入先出骨架']] });
  P.scenario.define({ key: 'sys-resource', group: G, label: '本机资源', def: 'normal', options: [['normal', '正常（名额与成果占用按示例世界推导）'], ['warn', '告警：CPU 87%，还能再发 1 个'], ['critical', '严重：磁盘 96%，还能再发 0 个'], ['retained', '成果过量：保留下来的成果占数据目录 82%，磁盘 88%']] });
  P.scenario.define({ key: 'sys-env', group: G, label: '沙箱环境', def: 'normal', options: [['normal', '正常（boxlite 0/14，aio 无样本）'], ['unhealthy', '不健康：boxlite 最近 1h 失败率 12%（6/50）']] });
  P.scenario.define({ key: 'sys-conn', group: G, label: '连接', def: 'normal', options: [['normal', '正常'], ['offline', '离线：模型 API 全部连不上（横幅 + 诊断第 ⑤ 项失败）'], ['down', '后端不可达（各卡读取失败 + 横幅「无法确认平台状态」）']] });
  P.scenario.define({ key: 'sys-diag', group: G, label: '下一轮诊断', def: 'ok', options: [['ok', '按示例世界（⑤ 跟着「连接」，⑧ 跟着「镜像 › 预制镜像在本机」）'], ['fail', '有失败：④ 端口被占 · ⑤ 应答慢 · ⑥ 超时未响应'], ['abort', '中断：5/9 项返回后断开'], ['early', '连接即断：拿到检查清单之前就断了']] });
  P.scenario.define({ key: 'sys-audit', group: G, label: '审计流', def: 'ok', options: [['ok', '正常（示例 11 条）'], ['live', '实时更新中断（列表中间有一段没加载）'], ['empty', '暂无记录（全新部署）'], ['unrecorded', '镜像类事件平台尚未记录']] });
  const backendDown = () => P.scenario.is('sys-conn', 'down');

  // ================================================================== 数据（notes/sys-a.md §4、§5.1；consistency.md ③⑤）
  // 一台机器只有一份读数（初始化向导第 5 步读同一份，notes/dep.md §5）。场景值取 v1 g6-03 / g6-04 / g6-05；正常场景的名额与成果占用按示例世界推导。
  // 磁盘「已用」= 其余占用 + 保留下来的成果（从 RETAINED 现算：在跨项目视图里删掉一份，磁盘与成果块一起变）
  const DATA_ROOT = '/srv/agent-platform/data';
  const MACHINE = {
    normal: { cpu: [3.1, 10], ram: [11.5, 32], diskTotal: 500, diskOther: 210 - 4300 / 1024 },
    warn: { cpu: [8.7, 10], ram: [23, 32], diskTotal: 500, diskOther: 210 - 4300 / 1024, cap: { remaining: 1, registered: 7, max: 8 } },
    critical: { cpu: [1.2, 10], ram: [9.6, 32], diskTotal: 500, diskOther: 435, cap: { remaining: 0, registered: 1, max: 8, basis: '磁盘已用 96%' } },
    retained: { cpu: [3.1, 10], ram: [11.5, 32], diskTotal: 500, diskOther: 30, cap: { remaining: 6, registered: 2, max: 8 } },
  };
  // 场景「严重 / 成果过量」把 3 份成果的占用放大到场景值（45 GB · 9% / 410 GB · 82%；sys-a §4 第 3 条、consistency W3 第 3 条），跨项目视图看到的就是这 3 份
  const RETAINED_MB = {
    critical: { 'rv-c8d2': 19149, 'rv-7f3a': 15872, 'rv-a91e': 11059 },
    retained: { 'rv-c8d2': 174387, 'rv-7f3a': 163431, 'rv-a91e': 82022 },
  };
  const retainedStash = {};
  function applyRetainedScenario() {
    const want = RETAINED_MB[P.scenario.get('sys-resource')] || null;
    for (const r of world.retained) {
      if (!(r.id in retainedStash)) { if (want && want[r.id]) { retainedStash[r.id] = r.diskMB; r.diskMB = want[r.id]; } }
      else if (want && want[r.id]) r.diskMB = want[r.id];
      else { r.diskMB = retainedStash[r.id]; delete retainedStash[r.id]; }
    }
  }
  const MAX_TASKS = 11; // 正常场景「本机最多」：待契约示例值（DR-08 / Q-SYS-17；8 个已登记 + 还能再发 3）
  const fmtNum = (n) => { const r = Math.round(n * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); };
  const fmtGB = (mb) => { const g = mb / 1024; return g < 10 ? `${fmtNum(g)} GB` : `${Math.round(g)} GB`; };
  const pctTxt = (p) => (p < 10 ? fmtNum(p) : String(Math.round(p)));
  const lvlCpu = (p) => (p >= 95 ? 'critical' : p >= 80 ? 'warn' : 'ok'); // PARAM.CPU_RAM_WARN_PCT / CRITICAL_PCT
  const lvlDisk = (p) => (p >= 90 ? 'critical' : p >= 75 ? 'warn' : 'ok'); // PARAM.DISK_WARN_PCT / CRITICAL_PCT
  const RANK = { ok: 0, warn: 1, critical: 2 };
  const worst = (...ls) => ls.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok');
  function resources() {
    const sc = P.scenario.get('sys-resource');
    const m = MACHINE[sc] || MACHINE.normal;
    const rv = P.retainedSummary ? P.retainedSummary() : { count: 0, diskMB: 0, earliest: null };
    const retGB = rv.diskMB / 1024;
    const diskUsed = Math.round((m.diskOther + retGB) * 10) / 10;
    const cpu = { used: m.cpu[0], total: m.cpu[1], pct: (m.cpu[0] / m.cpu[1]) * 100 };
    const ram = { used: m.ram[0], total: m.ram[1], pct: Math.round((m.ram[0] / m.ram[1]) * 1000) / 10 };
    const disk = { used: diskUsed, total: m.diskTotal, pct: Math.round((diskUsed / m.diskTotal) * 1000) / 10 };
    cpu.level = lvlCpu(cpu.pct); ram.level = lvlCpu(ram.pct); disk.level = lvlDisk(disk.pct);
    const retPct = (retGB / m.diskTotal) * 100;
    const retained = { count: rv.count, mb: rv.diskMB, pct: retPct, level: retPct >= 80 ? 'warn' : 'ok', earliest: rv.earliest }; // PARAM.RETAINED_WARN_PCT
    // 名额（REQ-SYS-071）：原型里这组数由示例世界模拟后端给出——已登记 = 没异常、没在删除的任务（含已停止的，DR-03 A）；界面不另算
    let cap = m.cap;
    if (!cap) {
      const registered = world.tasks.filter((t) => t.state !== 'error' && t.state !== 'destroying').length;
      cap = { registered, max: MAX_TASKS, remaining: Math.max(0, MAX_TASKS - registered), basis: '已登记的任务数到了本机上限' };
    }
    return { scenario: sc, cpu, ram, disk, retained, cap, overall: worst(cpu.level, ram.level, disk.level), reservedPct: 15 };
  }
  P.sysResources = resources;

  // ================================================================== 页面状态
  const S = {
    res: 'ok',            // 资源卡与沙箱环境卡：'loading'（骨架）| 'ok' | 'fail'（同一次重取，REQ-SYS-070 / 075）
    refreshing: false,    // [刷新] / 自动重取在途：刷新中…（旧数字保留）
    pollTimer: 0,
    focusAfter: null,     // 忙态按钮被禁用、焦点掉到 body：结果出来后还给它（data-fk）
    proxy: { state: 'ok', saved: null, saving: false, msg: null, field: null, retrying: false, form: null },
  };
  // 最近一次联网检查的结论（离线横幅、诊断第 ⑤ 项、向导第 1 步的结果共用；REQ-SYS-076、REQ-WB-014）
  const NET = (P.sysNet = { offline: false, at: 0 });
  P.proxySettings = S.proxy;

  // ---- 时间写法：横幅「（上次检测：2026-10-02 14:31:05（刚刚））」、向导「上次检测：…」
  const pad = (n) => String(n).padStart(2, '0');
  const shDate = (ms) => new Date(ms + 8 * 3600e3);
  P.fmtDash = (ms) => { const d = shDate(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };
  P.fmtAgo = (ms) => { const s = Math.max(0, (P.clock.wall() - ms) / 1000); if (s < 60) return '刚刚'; if (s < 3600) return `${Math.floor(s / 60)} 分钟前`; if (s < 86400) return `${Math.floor(s / 3600)} 小时前`; return `${Math.floor(s / 86400)} 天前`; };

  // ================================================================== 横幅（F-WB-BANNER 的两条阻断：离线 / 无法确认平台状态；数据放 P.world.banners，ui.js 画）
  // 离线：最近一次联网检查判模型 API 全部连不上（场景「离线」= 刚做过一次判为离线的检查）；[重新检测] 在 #system 就地跑诊断、别处进页即跑（REQ-SYS-076）
  // 无法确认平台状态：后端不可达（读 init-status 失败）；动作「查看系统状态」在本页不出（UX-DS-311，ui.js 按 action.view 判）
  const OFFLINE_TEXT = '当前连不上外网，Agent 将不可用 —— 每个 Agent 都必须能访问自己的模型 API，这是物理约束，不是配置问题。平台其余功能（项目管理、凭证与镜像配置、系统诊断）照常可用。';
  function syncBanners() {
    const want = [];
    if (backendDown()) want.push({ id: 'sys-unknown', level: 'block', title: '无法确认平台状态', text: '读取平台初始化状态失败（后端没有响应）。这多半是后端没起来或不可达 —— 在它恢复之前，「Agent 是否可用」无法判定：既不表示网络正常，也不表示离线。', action: { label: '查看系统状态', view: 'system' }, dismiss: 'close' });
    if (NET.offline) want.push({ id: 'sys-offline', level: 'block', title: '离线模式：Agent 不可用', text: `${OFFLINE_TEXT}（上次检测：${P.fmtDash(NET.at)}（${P.fmtAgo(NET.at)}））`, action: { label: '重新检测', act: () => P.requestDiagnose() }, dismiss: 'close' });
    const list = world.banners;
    let changed = false;
    for (let i = list.length - 1; i >= 0; i--) { const b = list[i]; if ((b.id === 'sys-unknown' || b.id === 'sys-offline') && !want.some((w) => w.id === b.id)) { list.splice(i, 1); changed = true; } }
    for (const w of want) {
      const cur = list.find((b) => b.id === w.id);
      if (!cur) { list.unshift(w); changed = true; } else if (cur.text !== w.text) { cur.text = w.text; changed = true; }
    }
    // 阻断里「无法确认平台状态」排在离线之前（wb notes §6.2）
    list.sort((a, b) => (a.id === 'sys-unknown' ? -1 : b.id === 'sys-unknown' ? 1 : 0));
    return changed;
  }
  P.hook('main:refreshed', () => { syncBanners(); }, { first: true }); // 在 ui.js 画横幅之前
  P.hook('live', () => { if (NET.offline && syncBanners() && !ui.loading && !P.gated) P.banners.render(); }); // 「（刚刚）」→「（1 分钟前）」
  // 离线时发起任务的入口置灰并说原因（REQ-WB-014；第四段起所有发起入口都先问这里：顶栏、⌘K、树里空组、总览卡、P6、「新建 ⌄」、欢迎态、新建任务弹层）
  P.hook('newTask.blocked', () => (NET.offline ? '离线模式：需连接网络才能发起任务' : undefined));

  // ================================================================== 视图：wire / refresh
  const sec = (host, id) => $(`section[aria-labelledby="${id}"]`, host);
  const onSystem = () => P.ui.route.view === 'system' && !P.ui.loading && !P.gated;
  P.views['tpl-system'] = {
    wire(main) {
      // 每次进入 = 一次新的读取（资源与沙箱环境、出网代理、审计流）；诊断结果跨页保留（REQ-DIA-001）
      P.clock.cancel(S.pollTimer); S.pollTimer = 0;
      S.refreshing = false; S.focusAfter = null;
      Object.assign(S.proxy, { saving: false, msg: null, field: null, retrying: false, state: backendDown() ? 'fail' : 'ok' });
      resetAudit();
      if (P.scenario.is('sys-load', 'slow')) {
        S.res = 'loading'; A.state = 'loading';
        const key = P.viewKey();
        P.clock.after(T.sysLoad, () => { if (P.viewKey() !== key || !onSystem()) return; S.res = backendDown() ? 'fail' : 'ok'; A.state = backendDown() ? 'fail' : 'ok'; if (S.res === 'fail') schedulePoll(); P.dirty(); P.announce(S.res === 'fail' ? '本机资源读取失败，当前数字不可用' : '本机资源已读取'); });
      } else { S.res = backendDown() ? 'fail' : 'ok'; A.state = backendDown() ? 'fail' : 'ok'; if (S.res === 'fail') schedulePoll(); }
      wireProxy(main);
      wireAudit(main);
      if (D.autorun) { D.autorun = false; queueMicrotask(() => { if (onSystem()) runDiag(); }); } // 横幅 [重新检测] / ⌘K 留下的一次性意图：进页消费掉再跑
    },
    refresh(host) { paintSystem(host); },
  };
  // 直接打开 #system（含刷新）：首屏就是本页骨架（f-sys-resource-01；REQ-SYS-070、U-75）——连接卡 REST「未知」、出网代理照常、诊断「尚未运行」、审计 5 行骨架
  P.hook('loading.tpl', (r) => (r.view === 'system' ? 'tpl-system' : undefined));
  P.hook('loading:wired', (tplId, main) => {
    if (tplId !== 'tpl-system') return;
    S.res = 'loading';
    const host = main.parentElement;
    paintResource(host); paintConn(host); paintEnv(host);
    const list = $('section[aria-labelledby="audit-stream-heading"] .log__list', main);
    if (list) list.replaceWith(P.fromTpl('tpl-sys-audit-skeleton', { keepRoles: true }));
    const more = $('section[aria-labelledby="audit-stream-heading"] .list__more', main); if (more) more.remove();
    paintDiag(host);
  });
  P.hook('route', (r) => { if (r.view !== 'system') { P.clock.cancel(S.pollTimer); S.pollTimer = 0; } });

  function paintSystem(host) {
    const a = document.activeElement, afk = a && a.getAttribute && a.getAttribute('data-fk');
    paintResource(host); paintConn(host); paintEnv(host); paintProxy(host); paintDiag(host); paintAudit(host);
    // 变了的段整段换掉：焦点按 data-fk 找回；忙态里被禁用的按钮等结果出来再还（S.focusAfter）
    if (afk && a !== document.activeElement && !a.isConnected) { const again = $(`[data-fk="${CSS.escape(afk)}"]`, host); if (again && !again.disabled && P.isShown(again)) again.focus({ preventScroll: true }); }
    if (S.focusAfter) {
      const want = $(`[data-fk="${CSS.escape(S.focusAfter)}"]`, host);
      const lost = !document.activeElement || document.activeElement === document.body || document.activeElement.id === 'main';
      if (want && !want.disabled && P.isShown(want)) { if (lost) want.focus({ preventScroll: true }); S.focusAfter = null; }
    }
  }
  // 只在内容变了时替换（键 = 生成的 HTML）：没变的段不重画（输入、焦点、展开都留着）
  function put(container, cur, html, build) {
    if (cur && cur.dataset.html === html) return cur;
    const n = build ? build() : frag(html);
    n.dataset.html = html;
    if (cur) cur.replaceWith(n); else container.appendChild(n);
    return n;
  }

  // ================================================================== F-SYS-RESOURCE 本机资源卡（Usage 卡：.card--usage / .kpi / .usage / .meter）
  const BADGE = {
    ok: '<span class="badge badge--20 badge--ok"><span class="icon i-check" aria-hidden="true"></span>正常</span>',
    warn: '<span class="badge badge--20 badge--warn"><span class="icon i-triangle-alert" aria-hidden="true"></span>警告</span>',
    critical: '<span class="badge badge--20 badge--fail"><span class="icon i-x" aria-hidden="true"></span>严重</span>',
  };
  const BAR = { ok: '', warn: ' meter__bar--warn', critical: ' meter__bar--fail' };
  const refreshBtn = () => (S.refreshing || S.res === 'loading'
    ? '<button class="btn btn--secondary btn--24 is-loading" type="button" aria-disabled="true" aria-busy="true" data-fk="sys-refresh">刷新中…</button>' // 只换字、不加转圈（f-sys-resource-01 差异 5）；第五段（R1-03）：aria-busy，焦点不丢
    : '<button class="btn btn--secondary btn--24" type="button" data-action="sys-refresh" data-fk="sys-refresh">刷新</button>');
  function gauge(key, icon, name, value, g, path) {
    const now = Math.round(g.pct);
    return `<li class="usage__item" data-testid="resource-gauge-${key}"><div class="usage__row"><span class="usage__name"><span class="icon ${icon}" aria-hidden="true"></span>${name}</span>${BADGE[g.level]}<span class="usage__value">${value}</span></div>${path ? `<span class="usage__path" title="${DATA_ROOT}">${DATA_ROOT}</span>` : ''}<span class="meter" role="progressbar" aria-label="${name} 使用率" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${now}"><span class="meter__bar${BAR[g.level]}" style="width: ${fmtNum(g.pct)}%"></span></span></li>`;
  }
  function resourceCardHtml(R) {
    const c = R.cap;
    const icon = c.remaining === 0 ? '<span class="icon l5a-kpi-icon l5a-kpi-icon--fail i-circle-x" aria-hidden="true"></span>' : c.remaining === 1 ? '<span class="icon l5a-kpi-icon l5a-kpi-icon--warn i-triangle-alert" aria-hidden="true"></span>' : '';
    const quota = `按配额登记计算：已登记 <span class="u-nowrap">${c.registered} 个任务</span>（含已停止的），本机最多 <span class="u-nowrap">${c.max} 个</span>。`;
    const desc = c.remaining === 0 ? `新任务会被拒绝：${esc(c.basis)}。${quota}` : `${quota}下面的实时占用率只作参考。`;
    // 结论块（REQ-SYS-011 / 012）：整体档位取最差的一维；下一步按触发维度说——CPU / 内存「停掉一些任务」，磁盘「清理成果或删掉不用的项目」（不说停任务，DR-03 A；Q-SYS-23 A）
    const cpuRam = worst(R.cpu.level, R.ram.level), disk = R.disk.level;
    let concl = R.overall === 'ok' ? '资源充足' : R.overall === 'warn' ? '资源紧张' : c.remaining === 0 ? '资源耗尽，现在建不了新任务' : '资源耗尽';
    const steps = [];
    if (cpuRam !== 'ok' && disk === 'ok') concl += '，建议停掉一些任务'; // 只有 CPU / 内存触发：并进结论句（f-sys-resource-02）
    else {
      if (cpuRam !== 'ok') steps.push([RANK[cpuRam], '建议停掉一些任务']);
      if (disk !== 'ok') steps.push([RANK[disk], `${disk === 'critical' ? '磁盘满了' : '磁盘快满了'}：清理成果或删掉不用的项目`]);
      steps.sort((a, b) => b[0] - a[0]); // 几个维度同时越线：各一句、严重的在前（Q-SYS-19 A）
    }
    const overall = `<p class="usage__item usage__item--row" data-testid="resource-overall">${BADGE[R.overall]}<span class="u-nowrap"><span class="u-medium u-fg">${concl}</span> <span class="u-muted">·</span></span>${steps.map((x) => `<span class="u-fg">${x[1]} <span class="u-muted">·</span></span>`).join('')}<span class="u-muted">留出 ${R.reservedPct}% 不拿去跑任务（上面的进度条分母仍然是总容量）</span></p>`;
    // 成果块（REQ-SYS-020）：占用从 RETAINED 现算；倒计时按最早到期那一份；≥ 80% 多一行警告 + 建议句；磁盘不是正常或成果超量时给 [清理成果]（Q-DS-33 A；Q-SYS-23 A 之前叫「保留卷」）
    const rv = R.retained;
    let rvHtml = `<span class="icon-line"><span class="icon i-gift" aria-hidden="true"></span><span>成果占用 ${fmtGB(rv.mb)}（${rv.count} 个 · 占数据目录（DATA_ROOT）的 ${pctTxt(rv.pct)}%）</span></span>`;
    if (rv.earliest) {
      const left = P.retainedLeft(rv.earliest);
      rvHtml += `<span class="icon-line icon-line--muted"><span class="icon i-clock" aria-hidden="true"></span><span>最早的成果${left === '即将清理' ? '即将清理' : left === '不足 1 天' ? '不足 1 天后清理' : `${left}清理`}</span></span>`;
    }
    if (rv.level === 'warn') rvHtml += `<p class="l5a-retained-alert" role="status" data-testid="retained-overuse"><span class="badge badge--20 badge--warn"><span class="icon i-triangle-alert" aria-hidden="true"></span>警告</span><span>保留下来的成果已占数据目录的 ${pctTxt(rv.pct)}%，<span class="u-nowrap">建议手动清理</span></span></p>`;
    if (disk !== 'ok' || rv.level === 'warn') rvHtml += '<div class="l5a-retained-actions"><button class="btn btn--secondary btn--32" type="button" aria-haspopup="dialog" data-action="sys-clean" data-fk="sys-clean">清理成果</button></div>';
    return `<div class="card card--usage"><div class="card__body">`
      + `<div class="card__head" data-testid="resource-headroom"><p class="kpi">${icon}<span>还能再发</span><span class="kpi__value">${c.remaining}</span><span>个任务</span></p><div class="card__head-end"><span class="contract-note" title="待契约（DR-08）：这个数要由后端按准入规则给（capacity.remainingTasks / registeredTasks），前端不自己算">待契约 · DR-08</span>${refreshBtn()}</div></div>`
      + `<p class="card__desc">${desc}</p>`
      + `<ul class="usage">${gauge('cpu', 'i-cpu', 'CPU', `${fmtNum(R.cpu.used)} / ${R.cpu.total} 核（${fmtNum(R.cpu.pct)}%）`, R.cpu)}${gauge('ram', 'i-memory-stick', '内存', `${fmtNum(R.ram.used)} / ${R.ram.total} GB（${fmtNum(R.ram.pct)}%）`, R.ram)}${gauge('disk', 'i-hard-drive', '磁盘', `${fmtNum(R.disk.used)} / ${R.disk.total} GB（${fmtNum(R.disk.pct)}%）`, R.disk, true)}</ul>`
      + `<div class="usage">${overall}<div class="usage__item usage__item--stack" data-testid="retained-volumes">${rvHtml}</div></div>`
      + `</div></div>`;
  }
  let lastRetainedWarn = false;
  function paintResource(host) {
    const s = sec(host, 'resource-pool-heading'); if (!s) return;
    const cur = $(':scope > .card', s);
    if (S.res === 'loading') { put(s, cur, 'loading', () => P.fromTpl('tpl-sys-res-skeleton', { keepRoles: true })); lastRetainedWarn = false; return; }
    if (S.res === 'fail') {
      const html = `fail:${S.refreshing}`;
      put(s, cur, html, () => {
        const card = tplEl('tpl-sys-res-fail', '.card', { keepRoles: true });
        const b = $('.l5a-failrow__end .btn', card);
        b.outerHTML = refreshBtn();
        return card;
      });
      lastRetainedWarn = false;
      return;
    }
    const R = resources();
    const n = put(s, cur, resourceCardHtml(R));
    // 成果超量那一行（role="status"）：数字刷新后跨进超量档时播报一次（sys-a §5.2）
    if (R.retained.level === 'warn' && !lastRetainedWarn && n) P.announce(`保留下来的成果已占数据目录的 ${pctTxt(R.retained.pct)}%，建议手动清理`);
    lastRetainedWarn = R.retained.level === 'warn';
  }
  // [刷新]：资源与沙箱环境一起重取，刷新中…（数字、徽标、水位条保持上一次的值，AC-SYS-010.7）→ 按当前场景重画；后端不可达 → 两张卡换失败句
  function refetch(viaPoll) {
    if (S.refreshing || S.res === 'loading') return;
    S.refreshing = true;
    if (!viaPoll) S.focusAfter = 'sys-refresh';
    P.clock.cancel(S.pollTimer); S.pollTimer = 0;
    P.refreshMain();
    const key = P.viewKey();
    P.clock.after(T.sysRefresh, () => {
      S.refreshing = false;
      if (P.viewKey() !== key) return;
      const was = S.res;
      S.res = backendDown() ? 'fail' : 'ok';
      if (S.res === 'fail') schedulePoll();
      P.dirty();
      if (S.res === 'fail') P.announce('本机资源读取失败，当前数字不可用 —— 请点 [刷新] 重试');
      else if (was === 'fail') P.announce('本机资源已恢复');
    });
  }
  // 读取失败时排一次 30 秒后的自动重取（PARAM.SYS_POLL_INTERVAL_S；AC-SYS-075.3）——只在失败态排，时钟不为常态轮询空转
  function schedulePoll() {
    P.clock.cancel(S.pollTimer);
    const key = P.viewKey();
    S.pollTimer = P.clock.after(T.sysPoll, () => { S.pollTimer = 0; if (P.viewKey() === key && onSystem() && S.res === 'fail') refetch(true); });
  }
  P.actions['sys-refresh'] = () => refetch(false);
  // [清理成果] → 「保留下来的成果」跨项目视图（范围「全部项目」、按项目分组）；关闭后焦点回到按钮（重画过就按 data-fk 找回）
  P.actions['sys-clean'] = (btn) => P.openRetained(null, btn);

  // ================================================================== F-SYS-CONN 连接卡（只报本页测到的，REQ-SYS-040）
  function paintConn(host) {
    const s = sec(host, 'connection-status-heading'); if (!s) return;
    // REST：两个查询都还没回来 →「未知」（AC-SYS-040.6，原型先行）；失败 →「异常 · 请求失败」；成功 →「正常（本页数据刚取回）」
    const rest = S.res === 'loading' ? '<span class="list__desc">本页数据还没取回</span><span class="badge badge--20 badge--unknown"><span class="icon i-circle" aria-hidden="true"></span>未知</span>'
      : S.res === 'fail' ? '<span class="list__desc">请求失败</span><span class="badge badge--20 badge--fail"><span class="icon i-x" aria-hidden="true"></span>异常</span>'
        : '<span class="list__desc">正常（本页数据刚取回）</span><span class="badge badge--20 badge--ok"><span class="icon i-check" aria-hidden="true"></span>正常</span>';
    // 终端连接：只报数量，不挂「正常」（AC-SYS-040.4，原型先行）——终端随工作台卸载，本页通常是 0
    const html = `<div class="card"><ul class="list list--stack"><li class="list__row" data-testid="connection-row-rest"><div class="list__line"><span class="list__name">REST</span>${rest}</div></li><li class="list__row" data-testid="connection-row-events"><div class="list__line"><span class="list__name">WS /events</span><span class="list__desc">本页未测量</span><span class="badge badge--20 badge--unknown"><span class="icon i-circle" aria-hidden="true"></span>未知</span></div><p class="list__note">/events 只在工作台挂载（本页不另开一条连接：那测的是新连接通不通，不是工作台那条）；通道断连时工作台会自行退避重连，无需在此干预</p></li><li class="list__row" data-testid="connection-row-terminals"><div class="list__line"><span class="list__name">终端连接</span><span class="list__desc">0 个终端会话</span></div></li></ul></div>`;
    put(s, $(':scope > .card', s), html);
  }

  // ================================================================== F-SYS-CONN 沙箱环境卡（D9 · Q-SYS-04 ②：最近 1h 失败率 + 无样本）
  const AUTH_METHODS = { codex: 'oauth-device · api-key', 'claude-code': 'setup-token · api-key' };
  function runtimeRowsHtml() {
    // 与 flows-crd.js 的 'main:refreshed' 同一写法（凭证同源；那边每次刷新照样再写一遍）
    return world.runtimes.map((rt) => {
      const st = P.credStatus ? P.credStatus(rt) : 'none';
      const [cls, icon, word] = st === 'none' ? ['badge--inactive', 'i-square-filled', '凭证未配置'] : st === 'expired' ? ['badge--fail', 'i-x', '凭证已过期'] : ['badge--ok', 'i-check', '凭证已配置'];
      return `<li class="check-line" data-testid="runtime-row-${rt.id}"><span class="badge badge--20 ${cls} badge--icon" role="img" aria-label="${word}"><span class="icon ${icon}" aria-hidden="true"></span></span><span><span class="u-fg">${esc(rt.name)}（${esc(rt.vendor)}）</span>· ${word} · 授权方式 ${AUTH_METHODS[rt.id] || 'api-key'}</span></li>`;
    }).join('');
  }
  function paintEnv(host) {
    const s = sec(host, 'sandbox-env-status-heading'); if (!s) return;
    const head = $('.section-head', s);
    const meta = $('.section-head__meta', head);
    const state = S.res === 'ok' ? P.scenario.get('sys-env') : S.res;
    // 健康统计窗口：读到之前、读取失败时不显示（AC-SYS-070.4、AC-SYS-030.7）
    if (state === 'loading' || state === 'fail') { if (meta) meta.remove(); }
    else if (!meta) head.insertAdjacentHTML('beforeend', '<span class="section-head__meta">健康统计窗口：最近 1 小时（阈值 &gt;1% 警告 · &gt;10% 故障）</span>');
    const key = state === 'loading' || state === 'fail' ? state : `${state}:${runtimeRowsHtml()}`;
    put(s, $(':scope > .card', s), key, () => {
      if (state === 'loading') return P.fromTpl('tpl-sys-env-skeleton', { keepRoles: true });
      if (state === 'fail') return tplEl('tpl-sys-env-fail', '.card', { keepRoles: true });
      const card = tplEl(state === 'unhealthy' ? 'tpl-sys-env-unhealthy' : 'tpl-sys-env-ok', '.card');
      const ul = $('[data-testid^="runtime-row-"]', card).parentElement;
      ul.innerHTML = runtimeRowsHtml();
      return card;
    });
  }

  // ================================================================== F-SYS-CONN 出网代理（REQ-SYS-060：回填、只存不重测、格式校验、成功 / 失败；读取失败不给表单）
  const PROXY_RE = /^https?:\/\//i;
  // 前端只拦一件事：HTTP_PROXY / HTTPS_PROXY 必须是 http(s):// 地址（联网检查只走 HTTP CONNECT；无协议的 host:port 同样拒绝，Q-SYS-20 A）。向导第 2 步同一张表单、同一个校验
  P.validateProxy = (v) => { for (const [k, name] of [['httpProxy', 'HTTP_PROXY'], ['httpsProxy', 'HTTPS_PROXY']]) { const x = (v[k] || '').trim(); if (x && !PROXY_RE.test(x)) return { field: k, text: `保存失败：代理地址格式不对 —— ${name} 要以 http:// 或 https:// 开头` }; } return null; };
  P.saveProxy = (v) => { const clean = { httpProxy: (v.httpProxy || '').trim(), httpsProxy: (v.httpsProxy || '').trim(), noProxy: (v.noProxy || '').trim() }; S.proxy.saved = clean.httpProxy || clean.httpsProxy || clean.noProxy ? clean : null; return S.proxy.saved; };
  const FIELDS = [['httpProxy', 'proxy-http'], ['httpsProxy', 'proxy-https'], ['noProxy', 'proxy-no']];
  function wireProxy(main) {
    const form = $('form[data-testid="proxy-config-form"]', main); if (!form) return;
    S.proxy.form = form;
    for (const [name, fk] of FIELDS) { const i = $(`input[name="${name}"]`, form); i.dataset.fk = fk; i.value = S.proxy.saved ? S.proxy.saved[name] : ''; }
    const submit = $('[type="submit"]', form); submit.dataset.fk = 'proxy-save'; submit.dataset.action = 'proxy-save';
    form.addEventListener('submit', (e) => { e.preventDefault(); saveProxy(); }); // 输入框里按 Enter 也是提交
  }
  function saveProxy() {
    const p = S.proxy, form = p.form;
    if (!form || p.saving || p.state !== 'ok') return;
    const v = Object.fromEntries(FIELDS.map(([name]) => [name, $(`input[name="${name}"]`, form).value]));
    p.saving = true; p.msg = null; p.field = null; p.focusSave = true;
    paintProxy($('#shell-main'));
    P.announce('保存中…');
    P.clock.after(T.proxySave, () => {
      p.saving = false;
      if (!form.isConnected) return;
      const bad = P.validateProxy(v);
      if (bad) { p.msg = { kind: 'fail', text: bad.text }; p.field = bad.field; }
      else { P.saveProxy(v); p.msg = { kind: 'ok' }; } // 只存配置、不重新检测：横幅与诊断结果保持原样（AC-SYS-060.3）
      paintProxy($('#shell-main'));
      P.announce(bad ? bad.text : '已保存。下一轮联网检查会走这组代理。');
    });
  }
  function paintProxy(host) {
    const s = host && $('section[data-testid="proxy-settings-card"]', host); if (!s) return;
    const p = S.proxy;
    const head = $('.section-head', s);
    // 「已配置」中性徽标：已存配置里有任一项时显示，清空保存后去掉（AC-SYS-060.8）；读取失败时不知道存了什么，不显示
    const showBadge = p.state === 'ok' && !!p.saved;
    let badge = $('[data-testid="proxy-configured"]', head);
    if (showBadge && !badge) { head.classList.add('section-head--inline'); head.appendChild(P.fromTpl('tpl-sys-proxy-badge')); }
    else if (!showBadge && badge) { badge.remove(); head.classList.remove('section-head--inline'); }
    const card = $(':scope > .card', s);
    if (p.state === 'fail') {
      // 读到已存的配置之前不给表单（UX-DS-310）：原位一句 + [重试]（只重取设置）
      put(s, card, `fail:${p.retrying}`, () => {
        const c = tplEl('tpl-sys-proxy-fail', '.card', { keepRoles: true });
        const b = $('.l5a-failrow__end .btn', c);
        Object.assign(b.dataset, { action: 'proxy-retry', fk: 'proxy-retry' });
        if (p.retrying) P.setBusy(b, true, '重试中…'); // 第五段（R1-03）
        return c;
      });
      return;
    }
    if (card !== p.form && p.form) { card.replaceWith(p.form); for (const [name] of FIELDS) $(`input[name="${name}"]`, p.form).value = p.saved ? p.saved[name] : ''; }
    const form = p.form; if (!form) return;
    const submit = $('[type="submit"]', form);
    // 第五段（R1-03）：[保存] 保存中用 aria-busy（焦点不丢）；在输入框里按回车保存的，焦点先交给 [保存] 再把输入框暂时禁用
    if (p.saving && form.contains(document.activeElement) && document.activeElement !== submit) submit.focus({ preventScroll: true });
    P.setBusy(submit, p.saving, p.saving ? P.busyHtml('保存中…') : '保存');
    // 结果句：保存失败（role=alert，出错的字段标红并指向这一句）/ 成功（role=status）；保留到下一次提交
    const body = $('.card__body', form);
    const old = $('.l5a-msg', body);
    const want = p.msg ? `${p.msg.kind}:${p.msg.text || ''}` : '';
    if ((old ? old.dataset.key : '') !== want) {
      if (old) old.remove();
      if (p.msg) {
        const n = P.fromTpl(p.msg.kind === 'fail' ? 'tpl-sys-proxy-error' : 'tpl-sys-proxy-saved', { keepRoles: true });
        if (p.msg.kind === 'fail') $('span:last-child', n).textContent = p.msg.text;
        n.dataset.key = want;
        $('.form-note', body).after(n);
      }
    }
    for (const [name] of FIELDS) {
      const i = $(`input[name="${name}"]`, form);
      i.disabled = p.saving;
      if (p.field === name) { i.setAttribute('aria-invalid', 'true'); i.setAttribute('aria-describedby', 'proxy-error'); }
      else { i.removeAttribute('aria-invalid'); i.removeAttribute('aria-describedby'); }
    }
    // 保存结束：失败 → 焦点交给出错的输入框（它此刻还停在 [保存] 上、或已丢到 body 时）；成功 → 留在 [保存]（丢了才还给它）
    if (!p.saving && p.focusSave) {
      p.focusSave = false;
      const a = document.activeElement;
      const lost = !a || a === document.body || a.id === 'main';
      if (p.field && (lost || a === submit)) $(`input[name="${p.field}"]`, form).focus({ preventScroll: true });
      else if (lost) submit.focus({ preventScroll: true });
    }
  }
  P.actions['proxy-save'] = () => saveProxy();
  P.actions['proxy-retry'] = () => {
    const p = S.proxy; if (p.retrying) return;
    p.retrying = true; S.focusAfter = 'proxy-retry';
    P.refreshMain();
    P.clock.after(T.proxyRetry, () => {
      p.retrying = false;
      if (backendDown()) { P.dirty(); P.announce('出网代理读取失败'); return; }
      p.state = 'ok'; S.focusAfter = 'proxy-http';
      P.dirty(); P.announce('出网代理已读取');
    });
  };

  // ================================================================== F-SYS-DIAG 一键诊断（REQ-DIA-001…003、040；f-sys-diag-01…06）
  const ITEMS = [
    ['container-runtime', '①', '容器服务可达'], ['dev-kvm', '②', '轻量虚拟机沙箱可用'], ['disk-space', '③', '磁盘余量'], ['port-conflict', '④', '端口占用'],
    ['outbound-network', '⑤', '联网检查（模型 API / 镜像下载源）'], ['ws-loopback', '⑥', '实时推送自检'], ['data-root-fs', '⑦', '数据目录文件系统'], ['preset-image', '⑧', '预制镜像就绪'], ['auth-helper', '⑨', '帐号登录环境'],
  ];
  const NOTE8 = '前 4 项已通过，已到第 5 项（共 5 项） · 有没有下载到本机（没下载只影响首个任务的耗时）';
  const PORT_FAIL = { st: 'fail', ms: '71ms', res: '端口 3000 被占用，平台起不来', why: '端口 3000（平台 HTTP/WS 服务）被 com.docke (pid 41235) 占用。', next: '先确认它是什么，确实该让路就停掉它；否则给平台换一个端口（PORT=<其它端口>）后重启平台。', cmd: 'lsof -nP -iTCP:3000 -sTCP:LISTEN' };
  // 各项结论（文字与耗时照 f-sys-diag-03 / 04 / 05 / 06、f-sys-conn-02；正常项展开后的说明照 sys-b §4.2 第 8 条）
  function itemResult(id, mode) {
    const R = resources();
    switch (id) {
      case 'container-runtime': return mode === 'abort'
        ? { st: 'info', ms: '38ms', res: '没有容器服务，但这台机器不需要', why: '/var/run/docker.sock 上没有容器服务在应答。这台机器的沙箱环境不跑在容器里，这不挡任何默认路径。', next: '只有显式选容器沙箱的任务才用得上它；真要用就装好 docker 再重跑诊断。' }
        : { st: 'ok', ms: '14ms', res: '容器服务可达', why: '/var/run/docker.sock，14ms · Docker/27.3.1 (linux)。' };
      case 'dev-kvm': return mode === 'abort' ? { st: 'ok', ms: '21ms', res: '轻量虚拟机沙箱可用，正在用它', why: '这台机器的硬件虚拟化设备可读写。' } : { st: 'ok', ms: '3ms', res: '轻量虚拟机沙箱可用', why: '这台机器的硬件虚拟化设备可读写。' };
      case 'disk-space': {
        // 与资源卡同一份读数、同一组阈值（REQ-DIA-012）
        const why = `${DATA_ROOT}：已用 ${fmtNum(R.disk.used)} GB / ${R.disk.total} GB（${fmtNum(R.disk.pct)}%），可用 ${fmtNum(R.disk.total - R.disk.used)} GB。`;
        // 下一步与资源卡同一口径（REQ-DIA-012，2026-10-04 Q-SYS-23 A / Q-SBX-03 A：不再写「保留卷」「工作区」）
        if (R.disk.level === 'critical') return { st: 'fail', ms: '12ms', res: '磁盘满了，新任务会被拒绝', why, next: '先清理保留下来的成果（系统状态「成果占用」那一行的 [清理成果]），或删掉不用的项目。' };
        if (R.disk.level === 'warn') return { st: 'warn', ms: '12ms', res: '磁盘快满了', why, next: '先清理保留下来的成果（系统状态「成果占用」那一行的 [清理成果]），或删掉不用的项目。' };
        return { st: 'ok', ms: '12ms', res: '磁盘余量充足', why };
      }
      case 'port-conflict': return mode === 'ok' ? { st: 'ok', ms: '64ms', res: '端口没有冲突', why: '端口 3000（平台 HTTP/WS 服务）正由平台自己监听（pid 2817）。' } : PORT_FAIL;
      case 'outbound-network':
        if (P.scenario.is('sys-conn', 'offline')) return { st: 'fail', ms: '3.5s', res: '连不上模型 API，Agent 不可用', why: 'api.openai.com 不可达、api.anthropic.com 不可达、ghcr.io 未在超时时限内应答。当前是离线环境。', next: 'DNS 解析不了 api.openai.com（Codex 的模型 API）。内网环境通常要配代理：在初始化向导 / 系统设置里填 HTTP_PROXY / HTTPS_PROXY', offline: true };
        if (mode === 'fail') return { st: 'warn', ms: '3.5s', res: '模型 API 应答慢，未必连不上', why: 'api.openai.com 未在超时时限内应答、api.anthropic.com 未在超时时限内应答。模型 API 都没在超时时限内应答 —— 这不等于连不上：一条时快时慢的链路会周期性越过时限，而 Agent 用的是长连接，可能照样能用。', next: '重跑一次诊断看它稳不稳定：偶发多半只是慢，可以直接往下走；每次都这样就按不通处理（内网常见形态是「网络通、但要走代理」，在系统设置里填 HTTPS_PROXY 后重试）。' };
        return { st: 'ok', ms: '1.3s', res: '外网都能连上', why: 'api.openai.com、api.anthropic.com、ghcr.io 均可达，最快 212ms。' };
      case 'ws-loopback': return mode === 'fail'
        ? { st: 'timeout', ms: '10s', res: '10 秒内没有结果', why: '这一项这次没有结论，其余项不受影响。', next: '看这一项依赖的东西是卡住了还是在报错；再跑一次诊断，看它是不是每次都超时。' }
        : { st: 'ok', ms: '9ms', res: '实时推送正常', why: '本机 127.0.0.1:3000 应答正常（9ms）。' };
      case 'data-root-fs': return { st: 'ok', ms: '22ms', res: '秒级复制加速可用', why: `数据目录（DATA_ROOT）${DATA_ROOT} 是 XFS，每个任务复制一份代码副本近乎零字节。` };
      case 'preset-image': return P.presetImageStaged && !P.presetImageStaged()
        ? { st: 'info', ms: '512ms', res: '镜像还没下载到本机', note: NOTE8, why: '镜像本身没问题，只是这台机器上还没有它的副本（镜像约 320 MB，通常十几秒到一分钟）。', next: '去「镜像管理」的预制镜像卡里点 [准备镜像]，平台先拉一次，不必等第一个任务。', goImages: true }
        : { st: 'ok', ms: '431ms', res: '预制镜像就绪，可以立即发起任务', note: NOTE8, why: "'ghcr.io/agent-infra/sandbox:latest' 平台检查过，而且已经下载到这台机器上。镜像就在本机，此刻不需要镜像仓库 —— 外网连通那一项若报镜像仓库不可达，只影响拉新镜像。" };
      default: return { st: 'ok', ms: '6ms', res: '帐号登录可用', why: 'auth helper 容器已就绪 —— 「帐号登录」会在它里面跑官方 CLI，与任务沙箱用同一张镜像（因此 CLI 版本一致）。' };
    }
  }
  // 到达顺序（sys-b §4.2 第 4 条）：全部正常 ⑨⑥③②⑦①④⑧⑤；有失败 ⑨③②⑦①④⑧⑤ 之后 ⑥ 超时最后到；中断 ⑥③②①④ 之后断开
  const ORDER = {
    ok: ['auth-helper', 'ws-loopback', 'disk-space', 'dev-kvm', 'data-root-fs', 'container-runtime', 'port-conflict', 'preset-image', 'outbound-network'],
    fail: ['auth-helper', 'disk-space', 'dev-kvm', 'data-root-fs', 'container-runtime', 'port-conflict', 'preset-image', 'outbound-network'],
    abort: ['ws-loopback', 'disk-space', 'dev-kvm', 'container-runtime', 'port-conflict'],
  };
  const D = { phase: 'idle', run: 0, checks: false, results: {}, opened: {}, totalMs: 0, autorun: false, mode: 'ok', arrived: 0 };
  const ST = {
    ok: ['badge--ok', 'i-check', '正常'], info: ['badge--info', 'i-info', '提示'], warn: ['badge--warn', 'i-triangle-alert', '警告'], fail: ['badge--fail', 'i-x', '失败'],
    timeout: ['badge--timeout', 'i-clock', '超时未响应'], pending: ['badge--pending', 'i-loader-circle icon--spin', '检查中…'], unknown: ['badge--unknown', 'i-circle', '未返回'],
  };
  const durTxt = (ms) => (ms < 1000 ? `${ms}ms` : ms % 1000 === 0 ? `${ms / 1000}s` : `${(ms / 1000).toFixed(1)}s`);
  // 开始一轮（[重新诊断]、横幅 [重新检测]、⌘K「运行诊断」同一路径）：新一轮作废旧一轮的迟到结果（AC-DIA-001.3）
  function runDiag() {
    const run = ++D.run;
    D.mode = P.scenario.get('sys-diag');
    D.phase = 'connecting'; D.results = {}; D.opened = {}; D.arrived = 0;
    D.focusAfter = true;
    P.refreshMain();
    if (!D.checks) P.announce('正在连接诊断流…（检查清单由服务端下发）');
    const live = () => D.run === run;
    // 后端不可达 / 场景「连接即断」：拿到清单之前就断了（AC-DIA-003.5）
    if (backendDown() || D.mode === 'early') {
      P.clock.after(T.diagConnect, () => { if (!live()) return; D.phase = 'aborted'; D.early = true; D.checks = false; afterDiag(); P.announce('诊断中断：连接在拿到检查清单之前就断了 —— 可点 [重新诊断] 重跑'); });
      return;
    }
    D.early = false;
    P.clock.after(T.diagConnect, () => {
      if (!live()) return;
      D.phase = 'running'; D.checks = true; // 首帧到：9 项按清单顺序占位（之后的每一轮都先用这份清单原地占位，AC-DIA-001.6）
      P.dirty();
      const mode = D.mode === 'fail' || D.mode === 'abort' ? D.mode : 'ok';
      const order = ORDER[mode];
      order.forEach((id, i) => P.clock.after(T.diagFirst + i * T.diagStep, () => { if (!live()) return; arrive(id, mode); }));
      if (mode === 'fail') P.clock.after(T.diagTimeout, () => { if (!live()) return; arrive('ws-loopback', mode); finish(10000); });
      else if (mode === 'abort') P.clock.after(T.diagAbort, () => { if (!live()) return; D.phase = 'aborted'; afterDiag(); P.announce(`诊断中断：${Object.keys(D.results).length}/9 项已返回，其余项没有结论 —— 已到达的结果保留在下方，可点 [重新诊断] 重跑`); });
      else P.clock.after(T.diagFirst + (order.length - 1) * T.diagStep, () => { if (!live()) return; finish(P.scenario.is('sys-conn', 'offline') ? 3500 : 1400); });
    });
  }
  function arrive(id, mode) {
    const r = itemResult(id, mode);
    D.results[id] = r; D.arrived++;
    P.dirty();
  }
  function finish(totalMs) {
    D.phase = 'done'; D.totalMs = totalMs; // 「整轮」= done 帧的 totalMs（各项并行，约等于最慢的一项）
    // 第 ⑤ 项是这一轮的联网检查：结论同步给离线横幅（REQ-SYS-076：第 ⑤ 项通过后横幅消失）
    const net = D.results['outbound-network'];
    if (net) { NET.offline = !!net.offline; NET.at = P.clock.wall(); if (NET.offline) P.banners.ui.hidden.delete('sys-offline'); }
    afterDiag();
    P.announce(summaryText());
  }
  function afterDiag() { P.dirty(); }
  function summaryText() {
    const c = { ok: 0, info: 0, warn: 0, fail: 0, timeout: 0 };
    for (const r of Object.values(D.results)) c[r.st]++;
    const x = durTxt(D.totalMs);
    if (!c.info && !c.warn && !c.fail && !c.timeout) return `${c.ok} 项全部正常 · 整轮 ${x}`;
    return [[c.ok, '项正常'], [c.info, '项提示'], [c.warn, '项警告'], [c.fail, '项失败'], [c.timeout, '项超时未响应']].filter(([n]) => n).map(([n, w]) => `${n} ${w}`).concat(`整轮 ${x}`).join(' · ');
  }
  const AUTO_OPEN = new Set(['warn', 'fail', 'timeout']); // 非正常项默认展开；正常与提示收起（AC-DIA-040.5）
  function itemRowHtml([id, ord, title]) {
    const r = D.results[id];
    const st = r ? r.st : D.phase === 'aborted' ? 'unknown' : 'pending';
    const open = r ? (id in D.opened ? D.opened[id] : AUTO_OPEN.has(r.st)) : false;
    const [cls, icon, word] = ST[st];
    const metas = (r ? `<span class="check-row__meta">${r.ms}</span>` : '') + (id === 'outbound-network' ? '<span class="check-row__meta">超时时限 10s</span>' : '');
    const toggle = r
      ? `<h3 class="check-row__toggle"><button class="btn btn--tertiary btn--24" type="button" aria-expanded="${open}"${open ? ` aria-controls="diag-d-${id}"` : ''} data-action="diag-toggle" data-diag="${id}" data-fk="diag-t:${id}">${open ? '收起' : '展开详情'}<span class="icon icon--14 ${open ? 'i-chevron-up' : 'i-chevron-down'} btn__trail" aria-hidden="true"></span></button></h3>`
      : '<span class="check-row__toggle-slot" aria-hidden="true"></span>';
    let body = '';
    if (r) {
      body += `<span class="check-row__result">${esc(r.res)}</span>`;
      if (r.note) body += `<span class="check-row__note">${esc(r.note)}</span>`;
      if (open) body += `<div class="check-row__detail" id="diag-d-${id}">${r.why ? `<span class="check-row__why">${esc(r.why)}</span>` : ''}${r.next ? `<span class="check-row__next">${esc(r.next)}</span>` : ''}${r.cmd ? `<span class="check-row__cmd"><code class="check-row__code" tabindex="0">${esc(r.cmd)}</code><button class="btn btn--secondary btn--24" type="button" data-action="diag-copy" data-diag="${id}" data-fk="diag-copy:${id}">复制</button></span>` : ''}${r.goImages ? '<span><button class="btn btn--tertiary btn--24" type="button" data-action="diag-go-images" data-fk="diag-go-images">去镜像管理<span class="icon icon--14 i-arrow-right btn__trail" aria-hidden="true"></span></button></span>' : ''}</div>`;
    }
    return `<li class="list__row" data-testid="diagnostic-item-${id}" data-status="${st}" data-expanded="${open}"><div class="check-row__head"><span class="check-row__ord" aria-hidden="true">${ord}</span><span class="check-row__title">${esc(title)}</span>${metas}<span class="check-row__status"><span class="badge badge--20 ${cls}"><span class="icon ${icon}" aria-hidden="true"></span>${word}</span></span>${toggle}</div>${body}</li>`;
  }
  function diagLeadHtml() {
    if (D.phase === 'idle') return '<p class="card__desc">尚未运行。点 [重新诊断] 跑一轮：各项并行，某一项超时也不阻塞其余项。</p>';
    if (D.phase === 'connecting' && !D.checks) return P.fromTpl('tpl-sys-diag-connecting', { keepRoles: true }).outerHTML;
    if (D.phase === 'aborted') {
      const n = P.fromTpl('tpl-sys-diag-aborted', { keepRoles: true });
      $('span:last-child', n).textContent = D.early ? '诊断中断：连接在拿到检查清单之前就断了 —— 可点 [重新诊断] 重跑' : `诊断中断：${Object.keys(D.results).length}/9 项已返回，其余项没有结论 —— 已到达的结果保留在下方，可点 [重新诊断] 重跑`;
      return n.outerHTML;
    }
    return `<p class="card__desc" role="status" data-testid="diagnose-summary">${D.phase === 'done' ? esc(summaryText()) : ''}</p>`;
  }
  function paintDiag(host) {
    const s = host && $('section[data-testid="system-status-diagnostics-row"]', host); if (!s) return;
    const busy = D.phase === 'connecting' || D.phase === 'running';
    const run = busy
      ? '<button class="btn btn--primary btn--32 is-loading" type="button" aria-disabled="true" aria-busy="true" data-fk="diag-run"><span class="icon i-loader-circle icon--spin" aria-hidden="true"></span>诊断中…</button>' // 第五段（R1-03）：aria-busy，焦点留在它上面
      : '<button class="btn btn--primary btn--32" type="button" data-action="diag-run" data-fk="diag-run">重新诊断</button>';
    const rows = D.checks && !(D.phase === 'aborted' && D.early) ? `<ul class="list check-list sysb-checks">${ITEMS.map(itemRowHtml).join('')}</ul>` : '';
    const html = `<div class="card"><div class="card__row">${diagLeadHtml()}<div class="card__row-end"><button class="btn btn--secondary btn--32" type="button" data-action="diag-export" data-fk="diag-export">导出日志</button>${run}</div></div>${rows}</div>`;
    const card = $(':scope > .card', s);
    put(s, card, html);
    if (!busy && D.focusAfter) {
      const b = $('[data-fk="diag-run"]', s);
      const lost = !document.activeElement || document.activeElement === document.body || document.activeElement.id === 'main';
      if (b && lost) b.focus({ preventScroll: true });
      D.focusAfter = false;
    }
  }
  P.actions['diag-run'] = () => runDiag();
  P.actions['diag-toggle'] = (b) => {
    const id = b.dataset.diag; const r = D.results[id]; if (!r) return;
    const open = id in D.opened ? D.opened[id] : AUTO_OPEN.has(r.st);
    D.opened[id] = !open; // 手动开 / 关只影响这一项；后到的项仍按默认规则
    P.refreshMain();
    const again = $(`[data-fk="diag-t:${id}"]`); if (again) again.focus({ preventScroll: true });
  };
  // [导出日志]：产品里是浏览器原生下载、应用内没有进度也不弹提示（REQ-AUD-006）；原型不产生文件，用一条中性轻提示做替身（只是原型说明）
  P.actions['diag-export'] = () => P.toast('neutral', '已开始下载日志包', '原型不产生文件；产品里由浏览器的下载栏显示进度');
  P.actions['diag-copy'] = (b) => {
    const r = D.results[b.dataset.diag]; if (!r || !r.cmd) return;
    P.copyText(r.cmd, () => P.toast('ok', '已复制', r.cmd), () => P.toast('fail', '复制失败', '请手动选中命令复制'));
  };
  // ⑧「去镜像管理」：下一步指向镜像管理预制镜像卡的「下载到本机」块（DR-36、REQ-DIA-018 合并说明），焦点交给 [准备镜像]
  let focusImgProvision = false;
  P.actions['diag-go-images'] = () => { focusImgProvision = true; P.go('images'); };
  P.hook('main:refreshed', (host) => {
    if (!focusImgProvision || host.dataset.tpl !== 'tpl-images') return;
    const b = $('[data-fk="img-provision"]', host);
    if (b) { focusImgProvision = false; requestAnimationFrame(() => { b.scrollIntoView({ block: 'center' }); b.focus({ preventScroll: true }); }); }
  });
  // 横幅 [重新检测] / ⌘K「运行诊断」：已在本页就地跑一轮（不跳页）；在别处先留一次性的意图，进页消费掉再跑（REQ-DIA-001、AC-DIA-001.5）
  P.requestDiagnose = function requestDiagnose() {
    if (onSystem()) { runDiag(); return; }
    D.autorun = true;
    P.go('system');
  };
  P.hook('palette.items', () => [{ g: '动作', label: '运行诊断', meta: '系统状态', keywords: '诊断 检查 系统状态', icon: '<span class="icon i-list-checks" aria-hidden="true"></span>', run: () => P.requestDiagnose() }]);

  // ================================================================== F-SYS-AUDIT 审计流（REQ-AUD-002…004、020、021；f-sys-audit-01…06）
  // 示例 11 条（sys-b §3.1；consistency 改动 10 / 11：105 = TIMEOUT · 10m 0s、103 = 创建项目 infra-scripts）；seq 只用来排序与做游标
  const AUDIT = [
    { seq: 108, at: '14:28:59.588', cat: 'task', sev: 'info', sum: '任务状态 准备中 → 运行中', meta: ['沙箱环境事件'], subject: 'login' },
    { seq: 107, at: '14:27:59.912', cat: 'task', sev: 'info', sum: '创建任务「修一下登录态刷新」', meta: ['4.2s', '成功', '调度器'], subject: 'login', detail: { provider: 'boxlite', image: 'ghcr.io/agent-infra/sandbox:latest' } },
    { seq: 106, at: '14:21:00.000', cat: 'credential', sev: 'info', sum: '保存凭证 Codex · API Key', meta: ['用户'] },
    { seq: 105, at: '14:16:00.000', cat: 'task', sev: 'error', sum: '创建任务「升级依赖到 Node 22」失败', meta: ['10m 0s', '失败', { code: 'TIMEOUT' }, '调度器'], subject: 'node22', detail: { provider: 'boxlite', reason: 'create instance: no response from the container service within 600s' } },
    { seq: 104, at: '14:08:00.000', cat: 'image', sev: 'warn', sum: '校验镜像 docker.io/acme/ml-agent:v1.0：有警告', meta: ['系统'], detail: { status: 'warning', warnings: ['未预装 claude-code'] } },
    { seq: 103, at: '13:53:00.000', cat: 'project', sev: 'info', sum: '创建项目 infra-scripts', meta: ['用户'] },
    { seq: 102, at: '13:35:00.000', cat: 'system', sev: 'warn', sum: '诊断完成：1 项失败 · 1 项警告', meta: ['用户'] },
    // 「保留成果」的对象是成果，按 detail 里来源任务筛（Q-AUD-04 默认 A）；来源任务已销毁 → chip 写 ID 前 8 位
    // 2026-10-04（Q-SYS-23 A / Q-SBX-03 A）：后端拼的「保留工作区卷（…）」由前端改写上屏为「保留成果（…）」（AC-AUD-003.6 的偏离清单；f-sys-audit-*）
    { seq: 101, at: '13:27:00.000', cat: 'project', sev: 'info', sum: '保留成果（磁盘 1288490188 字节 / 下载 0 字节）', meta: ['用户'], subject: '7f3a1c2e-9d08-4b7f-a6e1-0c2d4f6b8a93' },
    { seq: 100, at: '13:12:40.318', cat: 'task', sev: 'error', sum: '任务状态 准备中 → 异常', meta: ['失败', { code: 'IMAGE_PULL_FAILED' }, '沙箱环境事件'], subject: 'build' },
    { seq: 99, at: '13:12:40.296', cat: 'task', sev: 'error', sum: '创建任务「迁移构建脚本」失败', meta: ['1m 12s', '失败', { code: 'IMAGE_PULL_FAILED' }, '调度器'], subject: 'build', detail: { provider: 'boxlite', reason: 'pull ghcr.io/agent-infra/sandbox@sha256:4b17e…344: dial tcp: lookup ghcr.io: i/o timeout' } },
    { seq: 98, at: '13:11:28.140', cat: 'task', sev: 'info', sum: '任务状态 创建中 → 准备中', meta: ['沙箱环境事件'], subject: 'build' },
  ];
  // 断层补段（场景「实时中断」：106 与 105 之间没拉到的一段，[加载中间部分] 补上；sys-b §3.1）
  const AUDIT_GAP = [
    { seq: 105.2, at: '14:20:05.402', cat: 'task', sev: 'info', sum: '任务状态 准备中 → 运行中', meta: ['沙箱环境事件'], subject: 'pay', gap: true },
    { seq: 105.1, at: '14:19:58.117', cat: 'task', sev: 'info', sum: '创建任务「重构支付回调」', meta: ['3.9s', '成功', '调度器'], subject: 'pay', gap: true },
  ];
  let auditWiped = false; // 首次启动（flows-dep.js 演示初始化向导）= 全新部署：没有任何审计记录
  P.wipeAudit = () => { auditWiped = true; D.phase = 'idle'; D.checks = false; D.results = {}; D.opened = {}; NET.offline = false; };
  const PAGE = 8; // PARAM.AUDIT_PAGE_SIZE（原型 8 条一页）
  const CAT = { task: '任务', project: '项目', credential: '凭证', image: '镜像', system: '系统' };
  const CAT_BY_NAME = Object.fromEntries(Object.entries(CAT).map(([k, v]) => [v, k]));
  const SEV = { info: ['info', '信息'], warn: ['warn', '警告'], error: ['fail', '错误'] };
  const A = { state: 'ok', cat: 'all', warn: false, from: '', to: '', applied: { from: '', to: '' }, rangeErr: null, subject: null, pages: 1, open: null, more: false, live: false, gap: false, gapLoading: false, liveRetrying: false, retrying: false };
  function resetAudit() {
    Object.assign(A, { cat: 'all', warn: false, from: '', to: '', applied: { from: '', to: '' }, rangeErr: null, subject: null, pages: 1, open: null, more: false, gapLoading: false, gapFilled: false, liveRetrying: false, retrying: false });
    const live = P.scenario.is('sys-audit', 'live');
    A.live = live; A.gap = live;
  }
  // 换审计流场景 = 换一份服务端数据：从头拉（补过的断层那一段只属于「实时中断」那一份，不带过去）
  P.hook('scenario', (k, v) => {
    if (k === 'sys-audit') { A.live = v === 'live'; A.gap = v === 'live'; A.gapFilled = false; A.gapLoading = false; A.pages = 1; A.open = null; if (onSystem()) P.render(); }
  });
  const stamp = (r) => `2026-10-02T${r.at}`;
  const filtersActive = () => A.cat !== 'all' || A.warn || !!A.applied.from || !!A.applied.to || !!A.subject;
  const unrecorded = () => (P.scenario.is('sys-audit', 'unrecorded') ? ['image'] : []);
  function baseRecords() {
    if (auditWiped || P.scenario.is('sys-audit', 'empty')) return [];
    return AUDIT.filter((r) => !unrecorded().includes(r.cat));
  }
  function matches(r) {
    if (A.subject && r.subject !== A.subject) return false;
    if (A.cat !== 'all' && r.cat !== A.cat) return false;
    if (A.warn && r.sev === 'info') return false; // 仅告警 = 警告 + 错误
    if (A.applied.from && stamp(r) < A.applied.from) return false;
    if (A.applied.to && stamp(r) > `${A.applied.to}:59.999`) return false;
    return true;
  }
  // 查询（模拟服务端：筛选在服务端做，最近 N 条与翻页游标不截断筛选；sys-b §4.5）
  function query() {
    const base = baseRecords().filter(matches);
    const vis = base.slice(0, A.pages * PAGE);
    const minSeq = vis.length ? vis[vis.length - 1].seq : Infinity;
    const gapRecs = A.gapFilled ? AUDIT_GAP.filter(matches).filter((g) => g.seq > minSeq) : []; // 补上的那一段（只在「实时中断」场景里存在）
    const shown = vis.concat(gapRecs).sort((a, b) => b.seq - a.seq);
    return { shown, hasOlder: base.length > vis.length, total: base.length };
  }
  const subjectName = (sid) => { const t = P.task(sid); return t ? t.name : String(sid).slice(0, 8); };
  const human = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})$/.exec(v); if (!m) return v; const md = `${+m[2]}月${+m[3]}日 ${m[4]}`; return +m[1] === 2026 ? md : `${m[1]}年${md}`; };
  function condText() {
    const parts = [];
    if (A.cat !== 'all') parts.push(`类别：${CAT[A.cat]}`);
    if (A.warn) parts.push('仅告警');
    if (A.subject) parts.push(`任务：${subjectName(A.subject)}`);
    if (A.applied.from) parts.push(`起：${human(A.applied.from)}`);
    if (A.applied.to) parts.push(`止：${human(A.applied.to)}`);
    return parts.length ? parts.join(' · ') : '当前无筛选条件（全部类别、全部严重度）';
  }
  function rowHtml(r) {
    const [dot, word] = SEV[r.sev];
    const meta = r.meta.map((m) => (typeof m === 'string' ? `<span>${esc(m)}</span>` : `<code class="code code--fail">${esc(m.code)}</code>`)).join('');
    const open = A.open === r.seq;
    const inner = `<time class="log__time">${r.at}</time><span class="status-label"><span class="status-dot status-dot--${dot}" aria-hidden="true"></span>${word}</span><span class="log__summary">${esc(r.sum)}</span><span class="log__meta">${meta}</span>`;
    const id = `aud-d-${String(r.seq).replace('.', '-')}`;
    const main = r.detail
      ? `<button class="log__main" type="button" aria-expanded="${open}"${open ? ` aria-controls="${id}"` : ''} data-action="aud-row" data-seq="${r.seq}" data-fk="aud-row:${r.seq}"><span class="icon icon--14 ${open ? 'i-chevron-down' : 'i-chevron-right'} log__caret" aria-hidden="true"></span>${inner}</button>`
      : `<div class="log__main"><span class="log__caret" aria-hidden="true"></span>${inner}</div>`;
    // 已按任务筛选时行尾这一列收起、不再重复按钮（AC-AUD-003.5）
    const end = r.subject && !A.subject ? `<div class="log__end"><button class="btn btn--tertiary btn--24" type="button" data-action="aud-subject" data-seq="${r.seq}" data-fk="aud-tl:${r.seq}">查看该任务完整时间线</button></div>` : '';
    const detail = open ? `<pre class="log__detail" id="${id}" data-testid="audit-detail-panel">${esc(JSON.stringify(r.detail, null, 2))}</pre>` : '';
    return `<li class="log__row">${main}${end}${detail}</li>`;
  }
  function wireAudit(main) {
    const tb = $('section[aria-labelledby="audit-stream-heading"] .card__toolbar', main); if (!tb) return;
    const sel = $('select', tb), sw = $('input[role="switch"]', tb), [from, to] = $$('input[type="datetime-local"]', tb);
    sel.dataset.fk = 'aud-cat'; sw.dataset.fk = 'aud-warn'; from.dataset.fk = 'aud-from'; to.dataset.fk = 'aud-to';
    for (const o of sel.options) o.value = o.textContent.trim();
    sel.value = '全部'; sw.checked = false; from.value = ''; to.value = '';
    sel.addEventListener('change', () => { A.cat = CAT_BY_NAME[sel.value] || 'all'; refilter(); });
    sw.addEventListener('change', () => { A.warn = sw.checked; refilter(); });
    from.addEventListener('change', () => onRange('from', from.value));
    to.addEventListener('change', () => onRange('to', to.value));
  }
  // 改任意一项筛选都从头拉：pages 回 1、收起展开的行（AC-AUD-002.3）
  function refilter() {
    A.pages = 1; A.open = null;
    P.refreshMain();
    if (A.state === 'ok') P.announce(`共 ${query().shown.length} 条`);
  }
  // 起止（REQ-AUD-020）：只填一端也行；值不完整不当条件；起晚于止就地提示、不重查、列表与条件句保持上一次的结果
  function onRange(which, value) {
    A[which] = value;
    const ok = (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v);
    const f = ok(A.from) ? A.from : '', t = ok(A.to) ? A.to : '';
    if (f && t && f > t) { A.rangeErr = which; P.refreshMain(); return; }
    A.rangeErr = null; A.applied = { from: f, to: t };
    refilter();
  }
  function paintToolbar(card) {
    const tb = $('.card__toolbar', card); if (!tb) return;
    const [from, to] = $$('input[type="datetime-local"]', tb);
    for (const [inp, k] of [[from, 'from'], [to, 'to']]) {
      inp.classList.toggle('is-filled', !!inp.value);
      if (A.rangeErr === k) { inp.setAttribute('aria-invalid', 'true'); inp.setAttribute('aria-describedby', 'audit-range-error'); }
      else { inp.removeAttribute('aria-invalid'); inp.removeAttribute('aria-describedby'); }
    }
    let err = $('#audit-range-error', tb);
    if (A.rangeErr) {
      const text = A.rangeErr === 'to' ? '「止」早于「起」：这组时间没有生效，下面仍是上一次的筛选结果。' : '「起」晚于「止」：这组时间没有生效，下面仍是上一次的筛选结果。';
      if (!err || err.dataset.kind !== A.rangeErr) {
        const n = P.fromTpl('tpl-sys-audit-range', { keepRoles: true });
        n.lastChild.textContent = text; n.dataset.kind = A.rangeErr;
        if (err) err.replaceWith(n); else tb.appendChild(n);
        P.announce(text);
      }
    } else if (err) err.remove();
    // 按任务看完整时间线：筛选条末尾一个可移除的 chip「任务：<名>」（f-sys-audit-06），卡片收起行尾列
    let chip = $('[data-testid="audit-subject-filter"]', tb);
    const want = A.subject ? `任务：${subjectName(A.subject)}` : null;
    if (want && (!chip || chip.dataset.label !== want)) {
      const n = P.fromTpl('tpl-sys-audit-chip');
      const t = $('.chip__text', n); t.textContent = want; t.title = want;
      const x = $('.chip__remove', n); x.setAttribute('aria-label', `清除筛选「${want}」`); Object.assign(x.dataset, { action: 'aud-chip-x', fk: 'aud-chip-x' });
      n.dataset.label = want;
      if (chip) chip.replaceWith(n); else { const e = $('#audit-range-error', tb); if (e) e.before(n); else tb.appendChild(n); }
      P.upgradeTips(n);
    } else if (!want && chip) chip.remove();
    card.classList.toggle('log--subject', !!A.subject);
  }
  function auditBodyHtml() {
    // 筛选条下面：实时中断提示 → 列表（或空态 / 失败 / 骨架）→ 底部「加载更早 / 已到最早」
    if (A.state === 'loading') return { kind: 'loading' };
    if (A.state === 'fail') return { kind: 'fail' };
    const q = query();
    const live = A.live ? 'live' : '';
    let list;
    if (!q.shown.length) list = { empty: true };
    else {
      let rows = '';
      const gapAt = A.gap && !filtersActive() && q.shown.some((r) => r.seq === 106) && q.shown.some((r) => r.seq === 105);
      for (const r of q.shown) {
        rows += rowHtml(r);
        if (gapAt && r.seq === 106) rows += 'GAP';
      }
      list = { rows };
    }
    const more = q.hasOlder
      ? `<div class="list__more"><button class="btn btn--tertiary btn--32${A.more ? ' is-loading' : ''}" type="button"${A.more ? ' aria-disabled="true" aria-busy="true"' : ''} data-action="aud-more" data-fk="aud-more">${A.more ? '加载中…' : '加载更早的记录'}</button></div>`
      : q.shown.length ? '<div class="list__more"><span class="list__end-text" tabindex="-1" data-fk="aud-end">已到最早记录</span></div>' : '';
    return { kind: 'ok', live, list, more, q };
  }
  function paintAudit(host) {
    const s = host && $('section[data-testid="system-status-audit-row"]', host); if (!s) return;
    const card = $('.card.log', s); if (!card) return;
    paintToolbar(card);
    const b = auditBodyHtml();
    // 筛选条之后的部分整体按键比对（筛选条是常驻元素：选中的类别、输入的时间、焦点都留着）
    const tb = $('.card__toolbar', card);
    let key;
    if (b.kind !== 'ok') key = `${b.kind}:${A.retrying}`;
    else key = JSON.stringify([b.live, A.liveRetrying, b.list.empty ? `empty:${emptyKind()}:${condText()}` : b.list.rows, A.gapLoading, b.more]);
    if (card.dataset.body === key) return;
    card.dataset.body = key;
    while (tb.nextSibling) tb.nextSibling.remove();
    if (b.kind === 'loading') { tb.after(P.fromTpl('tpl-sys-audit-skeleton', { keepRoles: true })); return; }
    if (b.kind === 'fail') {
      const n = P.fromTpl('tpl-sys-audit-fail', { keepRoles: true });
      const r = $('.note__end .btn', n); Object.assign(r.dataset, { action: 'aud-retry', fk: 'aud-retry' });
      if (A.retrying) P.setBusy(r, true, '重试中…'); // 第五段（R1-03）
      tb.after(n);
      return;
    }
    const parts = [];
    if (b.live) {
      const n = P.fromTpl('tpl-sys-audit-live', { keepRoles: true });
      const r = $('.note__end .btn', n); Object.assign(r.dataset, { action: 'aud-live-retry', fk: 'aud-live-retry' });
      if (A.liveRetrying) P.setBusy(r, true, '重试中…');
      parts.push(n);
    }
    if (b.list.empty) parts.push(emptyEl());
    else {
      const ul = frag(`<ul class="log__list">${b.list.rows.replace('GAP', '<li data-gap-slot></li>')}</ul>`);
      const slot = $('[data-gap-slot]', ul);
      if (slot) {
        const g = P.fromTpl('tpl-sys-audit-gap', { keepRoles: true });
        const gb = $('.note__end .btn', g); Object.assign(gb.dataset, { action: 'aud-gap', fk: 'aud-gap' });
        if (A.gapLoading) P.setBusy(gb, true, '加载中…');
        slot.replaceWith(g);
      }
      parts.push(ul);
    }
    if (b.more) parts.push(frag(b.more));
    let after = tb;
    for (const p of parts) { after.after(p); after = p; }
    P.upgradeTips(card);
  }
  function emptyKind() {
    if (A.cat !== 'all' && unrecorded().includes(A.cat)) return 'category-not-yet-emitted'; // 类别判断优先于其他筛选（AC-AUD-004.6）
    return filtersActive() ? 'filtered-out' : 'no-records';
  }
  function emptyEl() {
    const kind = emptyKind();
    const n = P.fromTpl(kind === 'category-not-yet-emitted' ? 'tpl-sys-audit-empty-unrecorded' : kind === 'filtered-out' ? 'tpl-sys-audit-empty-filtered' : 'tpl-sys-audit-empty-none');
    $('.empty__desc', n).textContent = condText();
    const c = $('.empty__actions .btn', n); if (c) Object.assign(c.dataset, { action: 'aud-clear', fk: 'aud-clear' });
    return n;
  }
  P.actions['aud-row'] = (btn) => {
    const seq = Number(btn.dataset.seq);
    A.open = A.open === seq ? null : seq; // 同一时刻只展开一行（AC-AUD-003.2）
    P.refreshMain();
    const again = $(`[data-fk="aud-row:${seq}"]`); if (again) again.focus({ preventScroll: true });
  };
  // [查看该任务完整时间线]：本页就地按任务筛（Q-AUD-01 ②）——其余筛选清回默认（Q-AUD-03 A）、从头拉；焦点给 chip 的移除按钮
  P.actions['aud-subject'] = (btn) => {
    const r = AUDIT.concat(AUDIT_GAP).find((x) => x.seq === Number(btn.dataset.seq)); if (!r) return;
    setFilters({ subject: r.subject });
    P.refreshMain();
    const n = query().shown.length;
    const x = $('[data-fk="aud-chip-x"]'); if (x) x.focus({ preventScroll: true });
    P.announce(`已按任务「${subjectName(r.subject)}」筛选，共 ${n} 条`);
  };
  function setFilters({ subject = null } = {}) {
    Object.assign(A, { cat: 'all', warn: false, from: '', to: '', applied: { from: '', to: '' }, rangeErr: null, subject, pages: 1, open: null });
    const tb = $('#shell-main section[aria-labelledby="audit-stream-heading"] .card__toolbar');
    if (tb) { $('select', tb).value = '全部'; $('input[role="switch"]', tb).checked = false; for (const i of $$('input[type="datetime-local"]', tb)) i.value = ''; }
  }
  // chip 的 ×：回到全部记录，焦点回到筛选条第一个控件（AC-AUD-003.4）；[清除筛选]：四项（含按任务）都回默认，焦点给类别下拉
  P.actions['aud-chip-x'] = () => { setFilters(); P.refreshMain(); const f = $('[data-fk="aud-cat"]'); if (f) f.focus({ preventScroll: true }); P.announce(`已清除筛选，共 ${query().shown.length} 条`); };
  P.actions['aud-clear'] = P.actions['aud-chip-x'];
  // [加载更早的记录]：按已加载最老一条往更早翻一页（与当前筛选一起发）→ 加载中… → 接在末尾；到底「已到最早记录」（REQ-AUD-021）
  P.actions['aud-more'] = () => {
    if (A.more) return;
    A.more = true; P.refreshMain();
    const key = P.viewKey();
    P.clock.after(T.auditMore, () => {
      A.more = false;
      if (P.viewKey() !== key) return;
      const before = query().shown.length;
      A.pages++;
      P.dirty();
      requestAnimationFrame(() => {
        const q = query();
        const f = $('[data-fk="aud-more"]') || $('[data-fk="aud-end"]');
        if (f && (!document.activeElement || document.activeElement === document.body || document.activeElement.id === 'main')) f.focus({ preventScroll: true });
        P.announce(`已加载更早的 ${q.shown.length - before} 条${q.hasOlder ? '' : '，已到最早记录'}`);
      });
    });
  };
  // 实时中断：[重试] 只重试增量通道（AC-AUD-004.7）——提示条拿掉、退出这个场景；断层不受影响（要点 [加载中间部分]）
  P.actions['aud-live-retry'] = () => {
    if (A.liveRetrying) return;
    A.liveRetrying = true; P.refreshMain();
    P.clock.after(T.auditRetry, () => { A.liveRetrying = false; A.live = false; P.scenario.reset('sys-audit'); P.dirty(); P.announce('实时更新已恢复'); });
  };
  // 断层：点一次补一段（不自动循环补齐，AC-AUD-004.8）
  P.actions['aud-gap'] = () => {
    if (A.gapLoading) return;
    A.gapLoading = true; P.refreshMain();
    P.clock.after(T.auditMore, () => {
      A.gapLoading = false; A.gap = false; A.gapFilled = true;
      P.dirty();
      P.announce('已补上中间缺的 2 条');
    });
  };
  // 加载失败 [重试]：场景还在就仍然失败（并播报），后端恢复就出列表
  P.actions['aud-retry'] = () => {
    if (A.retrying) return;
    A.retrying = true; P.refreshMain();
    P.clock.after(T.auditRetry, () => {
      A.retrying = false;
      if (backendDown()) { P.dirty(); P.announce('审计流加载失败'); return; }
      A.state = 'ok'; P.dirty(); P.announce('审计流已加载');
    });
  };

  // ================================================================== 场景改了：本页立即重画（后端不可达 = 下一次重取失败；恢复要等 [刷新] / 30 秒重取 / 各卡 [重试]）
  P.hook('scenario', (k, v) => {
    if (k === 'sys-resource') applyRetainedScenario();
    if (k === 'sys-conn') {
      if (v === 'offline') { NET.offline = true; NET.at = P.clock.wall(); P.banners.ui.hidden.delete('sys-offline'); } // 「刚做过一次判为离线的检查」
      if (v === 'down') {
        P.banners.ui.hidden.delete('sys-unknown');
        if (onSystem()) { S.res = 'fail'; S.proxy.state = 'fail'; A.state = 'fail'; schedulePoll(); }
      }
    }
    if (k.startsWith('sys-') && !P.gated) P.render();
  });

  // ------------------------------------------------------------------ 测试出口（只读快照）
  P.stateExtras.push(() => {
    const R = resources();
    const q = query();
    return {
      sys: {
        res: S.res, refreshing: S.refreshing,
        resources: { remaining: R.cap.remaining, registered: R.cap.registered, max: R.cap.max, overall: R.overall, cpu: R.cpu.level, ram: R.ram.level, disk: R.disk.level, diskUsed: R.disk.used, retainedCount: R.retained.count, retainedMB: R.retained.mb, retainedLevel: R.retained.level },
        proxy: { state: S.proxy.state, saved: S.proxy.saved ? { ...S.proxy.saved } : null, saving: S.proxy.saving, msg: S.proxy.msg ? S.proxy.msg.kind : null },
        net: { offline: NET.offline, at: NET.at },
        diag: { phase: D.phase, checks: D.checks, early: !!D.early, results: Object.fromEntries(Object.entries(D.results).map(([id, r]) => [id, r.st])), summary: D.phase === 'done' ? summaryText() : null },
        audit: { state: A.state, cat: A.cat, warn: A.warn, applied: { ...A.applied }, rangeErr: A.rangeErr, subject: A.subject, pages: A.pages, open: A.open, shown: q.shown.map((r) => r.seq), hasOlder: q.hasOlder, live: A.live, gap: A.gap, gapFilled: !!A.gapFilled, emptyKind: q.shown.length ? null : emptyKind() },
      },
    };
  });
})();
