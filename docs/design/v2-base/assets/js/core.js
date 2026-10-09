/*
 * 设计语言 v2 · 交互原型 · 核心（js/core.js）
 *
 * 命名空间 window.P。经典脚本 + defer，按顺序加载（file:// 下也能用，不用 ES module）：
 *   core → ui → flows-prj → flows-lch → flows-crd → flows-img → flows-sys → flows-dep → flows-wb → flows-aut
 * 本文件：小工具、示例世界（数据层）与派生计数、单一时钟（P.clock）、场景（P.scenario）、路由、渲染总入口（导航 / 树 / 主区 / 顶栏）、
 *        读屏播报、浮层出场、浮动提示（tooltip 与「原因」）、菜单与模态的基础、键盘层、首屏。
 * 各 flows 文件只往注册表里登记：P.views（模板 → refresh / wire）、P.mainTpl（路由 → 模板）、P.actions（data-action）、
 *        P.menus（data-menu）、P.hook / P.emit / P.ask（钩子）、P.scenario.define（场景）、P.clock.ticker（时钟里的进行中对象）。
 *        DOMContentLoaded 时 core 统一 boot（那时所有 defer 脚本都已执行完）。
 * 状态只在内存里（刷新即复原）；主题与侧栏收起记在 localStorage（读写都 try/catch）。
 * 标记与静态稿同一套类名：视图 / 弹层的骨架由 tools/build-proto.cjs 从静态稿（pilot 试点、gap/drafts 补全稿）拷进 index.html 的 <template>，
 *        数据由 JS 按同一套类名填进去。
 * 修正轮（原型评审 F1–F15、PF-01–PF-14）的改动保留在原处并用编号标出（来源 pilot/proto/proto.js，逐条处理见 pilot/notes/proto.md §7）。
 */
(function () {
  'use strict';
  const P = (window.P = window.P || {});

  // ------------------------------------------------------------------ 小工具
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* 拿不到存储：照常工作，只是不记 */ } },
  };
  const mq = (q) => { try { return window.matchMedia(q); } catch (e) { return { matches: false, addEventListener() {} }; } };
  const MQ_LIGHT = mq('(prefers-color-scheme: light)');
  const MQ_NARROW = mq('(max-width: 639px)');
  const MQ_REDUCE = mq('(prefers-reduced-motion: reduce)');
  const reduceMotion = () => MQ_REDUCE.matches;
  // 平台（F1 / PF-01）：macOS 只认 ⌘ 组合；其它平台用 Ctrl，终端有焦点时另有规则（见键盘层）
  const PLATFORM = (() => { try { return String(navigator.platform || (navigator.userAgentData && navigator.userAgentData.platform) || ''); } catch (e) { return ''; } })();
  const IS_MAC = /mac|iphone|ipad|ipod/i.test(PLATFORM);
  const KBD_PALETTE = IS_MAC ? '⌘K' : 'Ctrl K';
  const KBD_RAIL = IS_MAC ? '⌘B' : 'Ctrl B';
  const KEY_THEME = 'pilot-proto-theme';
  const KEY_RAIL = 'pilot-proto-rail';
  const LOADING_MS = 600; // 首屏骨架（真实时间；测试里的 holdLoading 按 600 认这一个定时器，别的地方不要用 600ms 的 setTimeout）
  const NOHOOK = '原型：未接入';
  const NARROW_RAIL_REASON = '窄屏下侧栏固定为图标轨（窄屏抽屉不在本原型范围）';
  const isShown = (el) => !!(el && el.isConnected && !el.closest('[inert]') && el.getClientRects().length);
  const cp = (s) => Array.from(String(s || '')); // 按码点切（Q-LCH-01 A：指令长度、任务名截断都按码点）
  Object.assign(P, { $, $$, esc, store, mq, MQ_LIGHT, MQ_NARROW, MQ_REDUCE, reduceMotion, IS_MAC, KBD_PALETTE, KBD_RAIL, NOHOOK, isShown, cp });

  // ------------------------------------------------------------------ 注册表与钩子（flows 文件往这里登记）
  P.views = {};    // 模板 id → { wire(main, r), refresh(host, r) }
  P.mainTpl = [];  // [(route) => 模板 id | undefined]，按登记顺序问，先给出答案的胜出（要覆盖就 unshift）
  P.actions = {};  // data-action 名 → (el, event) => void
  P.menus = {};    // data-menu 名 → (trigger) => { label, html, align } | null
  P.hooks = {};
  P.hook = (name, fn, opts) => { (P.hooks[name] = P.hooks[name] || [])[opts && opts.first ? 'unshift' : 'push'](fn); };
  P.emit = (name, ...args) => { for (const fn of P.hooks[name] || []) fn(...args); };
  P.ask = (name, ...args) => { for (const fn of P.hooks[name] || []) { const v = fn(...args); if (v !== undefined && v !== null) return v; } return undefined; };
  P.collect = (name, ...args) => (P.hooks[name] || []).reduce((acc, fn) => acc.concat(fn(...args) || []), []);
  P.stateExtras = []; // window.__proto.state 的补充字段（各流程登记）
  P.gated = false;    // 访问口令门盖着（flows-crd.js F-ACC-UNLOCK）：外壳不在 DOM 里，渲染全部暂停

  // ------------------------------------------------------------------ 时长常量（画面写真实口径，原型可压缩；全部集中在这里）
  const TIMING = (P.TIMING = {
    submitProject: 600,   // 提交新建项目 → 服务端回答
    clone: 12000,         // 新克隆从 0 到 100%（原型压缩）
    cloneBaseStep: 3000,  // 示例世界里 infra-scripts 那次克隆：每 3 秒 +1%（场景「预置的克隆：暂停」时不动）
    cloneFail: 4000,      // 场景「下一次克隆：失败」在开始后多久落定
    cloneSlow: 600000,    // 慢提示：画面口径 600 秒（PARAM.CLONE_SLOW_AFTER_S）；场景「慢提示：立即出现」时为 0
    cancelClone: 800,     // 取消克隆 → 落定「克隆失败 · 被中断」
    pull: 2000,           // 拉取最新代码
    deleteProject: 1000,  // 删除项目
    deleteRetained: 800,  // 删除一份成果
    retainedRetry: 700,   // 成果列表读取失败后 [重试]
    formLoad: 1500,       // 新建任务弹层：加载中（场景）
    formRetry: 700,       // 新建任务弹层：加载失败后重试
    create: 700,          // 创建中（发起 → 平台受理）
    phase: { pending: 2000, 'preparing-workspace': 3000, creating: 6000, starting: 4000 }, // 启动四段（状态机顺序）
    startingFirstImage: 10000, // 场景「首次使用镜像」：启动运行环境这一格拉长
    pullFailAt: 3000,     // 场景「拉镜像失败」：拉取镜像这一格开始后多久转异常
    timeoutAt: 4000,      // 场景「超时」
    envFailAt: 2000,      // 2026-10-04（Q-SYS-01② A）：场景「容器服务没有响应 / 磁盘空间不够」——那一格（拉取镜像 / 准备代码副本）开始后多久转异常
    stuck: 15000,         // 可能卡住：画面口径 PARAM.STUCK_HINT_S 暂行 300 秒，原型按 15 秒（不上屏）
    stop: 1500, start: 3000, destroy: 1200,
    hlTick: 2000,         // 无头输出每 2 秒追加一行
    hlMinute: 10000,      // 无头「还剩 X 分」：原型每 10 秒减 1 分
    hlCancel: 1500, hlReconnect: 1000, hlReconnectMax: 8,
    // —— 第二段 L3 凭证（notes/crd-a.md §6.3、crd-b.md §6；画面写真实口径）
    authPrepare: 600,     // 点 [开始帐号登录] → 拿到设备码 / 授权链接（准备中句）
    deviceCodeSec: 599,   // 设备码倒计时从 09:59 起（画面口径：有效期 15 分钟，以后端给的到期时间为准）
    deviceWarnSec: 300,   // 剩 ≤ 5 分钟转警示色（PARAM.DEVICE_CODE_WARN_S）
    deviceAuthorize: 5000, // 点 [打开授权页] 后，用户在新标签页里完成授权
    deviceGiveUp: 4000,   // 场景「等太久先停下」：画面口径前端等满 10 分钟（PARAM.AUTH_POLL_MAX_MIN）
    deviceNetErr: 3000,   // 场景「轮询网络异常」：开始轮询后多久出现（画面口径连续 3 次查询失败）
    setupAuto: 4000,      // 场景「同机部署自动送回」：拿到授权链接后多久自己连上
    authSubmit: 600,      // 提交授权码 / API Key（提交中… / 校验中…）
    authSuccessHold: 2000, // 「已连上」最短停留（PARAM.AUTH_SUCCESS_HOLD_MS）
    modeSwitch: 600,      // 切换生效方式（切换中…）
    revoke: 600,          // 删除 Agent 凭证（删除中…）
    revokeRetry: 800,     // 删除确认框里 [重试读取]
    gitTest: 1500,        // 测试连接（画面口径最多 15 秒）
    gitSave: 600, gitDelete: 600,
    retryCloneReturn: 1000, // 凭证页回程条 [重试克隆]
    credLoad: 1500,       // 场景「每次进入凭证页先出骨架」
    credRetry: 600,       // 读取失败后 [重试]
    passcodeVerify: 600,  // 口令门「验证中…」
    passcodeLock: 30000,  // 连错 5 次锁定（画面写「约 5 分钟」，PARAM.PASSCODE_LOCK_MIN）
    // —— 第二段 L4 镜像（notes/img-a.md §9.0、img-b.md §9.0）
    imgValidate: 1200, imgSave: 800, envSave: 600,
    imgCheck: 1200, imgRevalidate: 1200, imgActivate: 1200, imgEnable: 1200, imgDelete: 800,
    imgLoad: 1500,        // 场景「每次进入镜像页先出骨架」「读不到」（骨架之后才出读取失败）
    imgRetry: 600,        // 镜像列表读取失败后 [重试]
    presetStep: 1000,     // 预制镜像下载：每秒 +7%
    presetDone: 1000,     // 「已下载到本机，正在重新检测…」停留
    // —— 第三段 L5 系统状态（notes/sys-a.md §5.1、sys-b.md §4.2）与初始化向导（notes/dep.md §6.3）；画面写真实口径
    sysLoad: 1500,        // 场景「每次进入系统状态先出骨架」：资源卡、沙箱环境卡、审计流的骨架停留
    sysRefresh: 800,      // [刷新]：刷新中…（资源与沙箱环境一起重取）
    sysPoll: 30000,       // 读取失败时的下一次自动重取（PARAM.SYS_POLL_INTERVAL_S = 30；只在失败态排一次，时钟不为常态轮询空转）
    proxySave: 600,       // 出网代理「保存中…」（系统状态与向导第 2 步同一张表单）
    proxyRetry: 600,      // 出网代理读取失败后 [重试]
    diagConnect: 500,     // 诊断：连接中（首帧还没到）
    diagFirst: 300,       // 首帧之后第一项到达
    diagStep: 75,         // 之后每项间隔（9 项落在 300–900ms）
    diagTimeout: 1500,    // 超时未响应的那一项最后到（画面写「10s」= 首帧 timeoutMs）
    diagAbort: 900,       // 场景「中断」：首帧之后多久断开
    auditMore: 700,       // [加载更早的记录] / [加载中间部分]：加载中…
    auditRetry: 600,      // 审计：实时更新 [重试]、加载失败 [重试]
    bootCheck: 600,       // 启动检查中（init-status 还没回来）
    connCheck: 2000,      // 向导第 1 步：一轮联网检查（真实最长约 PARAM.DIAG_ITEM_TIMEOUT_MS = 10 秒）
    recheckThrottle: 3000, // [重新检测] / [保存并重新检测] 两次之间（PARAM.INIT_RECHECK_THROTTLE_S）
    chainCheck: 1500,     // 向导第 3 步：镜像检查（后端一帧回结论，五项一起出）
    initFinish: 1200,     // [确认，开始使用] / [重试]：正在完成…（真实最长约 10 秒：写入前后端再跑一轮联网检查）
    // —— 第四段 L6 工作台外壳（notes/wb.md §6）与自动化规则（notes/aut.md §6）；画面写真实口径
    termReconnect: 2000,  // 终端断线后每 2 秒重连一次、第 n 次 +1（画面口径：退避 0.5 → 30 秒封顶，PARAM.WS_BACKOFF_CAP_S；8 次后次数用完，PARAM.TERM_RECONNECT_MAX）
    termConnect: 1000,    // [手动重连] 之后「连接中…」
    autLoad: 600,         // 自动化规则：列表 / 运行历史读取失败后 [重试]（正在读取…）
    autToggle: 400,       // 关掉 / 开启 / 重新开启：先改界面、只禁这一行的按钮，等后端
    autSave: 800,         // [保存规则]：保存中…
    autTest: 1500,        // Webhook [测试连接]：测试中…（画面口径：超时 10 秒，PARAM.WEBHOOK_TIMEOUT_S）
    autDelete: 800,       // [删除规则]：正在删除…
    autMore: 600,         // 运行历史 [加载更多]：加载中…
  });

  // ------------------------------------------------------------------ 单一时钟（虚拟时间）：只在有进行中对象（定时器或活跃的 ticker）时跑
  // P.clock.after(ms, fn) 是虚拟毫秒；P.clock.ticker({ tick(now), active() }) 每过一个虚拟秒调一次 tick；
  // 实际节拍 100ms 一步，每步前进 100 × speed 虚拟毫秒（#…&speed=N 可加速）；测试可以 __proto.clock.advance(ms) 同步快进。
  const NOW0 = Date.UTC(2026, 9, 2, 1, 40, 0); // 「现在」= 2026/10/2 09:40:00（Asia/Shanghai）；示例世界的相对时间都按它算
  // manual：测试用（#…&clock=manual 或 __proto.clock.manual(true)）——虚拟时钟不随真实时间走，只由 advance() 推进，断言不受机器快慢影响
  // hold（第四段，F-WB-LIVE）：实时更新（/events）断开时，「后台进行中」的 ticker（bg: true——克隆、启动四段）不再推进界面里的状态（列表保持最后已知状态）；
  //   时间照走（后端那边仍在推进），恢复时把断开期间漏掉的整秒拍按顺序一次补上（= 重同步，REQ-EVT-002）
  const ck = { t: 0, speed: 1, timers: [], tickers: [], seq: 0, handle: 0, stepping: false, manual: false, hold: false, holdFrom: 0 };
  const STEP_REAL = 100;
  function ckActive() { return ck.timers.length > 0 || ck.tickers.some((tk) => { try { return !!tk.active(); } catch (e) { return false; } }); }
  function ckRun(to) {
    // 推进到虚拟时刻 to：按先后触发到期的定时器；每跨过一个整秒调一次 ticker
    ck.stepping = true;
    try {
      while (ck.t < to) {
        const nextSec = (Math.floor(ck.t / 1000) + 1) * 1000;
        const nextTimer = ck.timers.length ? ck.timers[0].at : Infinity;
        const next = Math.min(to, nextSec, nextTimer);
        ck.t = next;
        while (ck.timers.length && ck.timers[0].at <= ck.t) { const tm = ck.timers.shift(); try { tm.fn(); } catch (e) { setTimeout(() => { throw e; }); } }
        if (ck.t === nextSec) for (const tk of ck.tickers) { if (ck.hold && tk.bg) continue; try { tk.tick(ck.t); } catch (e) { setTimeout(() => { throw e; }); } }
      }
    } finally { ck.stepping = false; }
    flushDirty();
    updateLive();
  }
  function ckHold(on) {
    on = !!on;
    if (on === ck.hold) return;
    ck.hold = on;
    if (on) { ck.holdFrom = ck.t; return; }
    // 恢复：断开期间漏掉的整秒拍按时间先后补给 bg ticker（tick 拿到的是当时那一秒，阶段与进度按真实先后落定）
    ck.stepping = true;
    try {
      for (let s = Math.floor(ck.holdFrom / 1000) + 1; s * 1000 <= ck.t; s++) for (const tk of ck.tickers) { if (!tk.bg) continue; try { tk.tick(s * 1000); } catch (e) { setTimeout(() => { throw e; }); } }
    } finally { ck.stepping = false; }
    flushDirty();
    updateLive();
    ckWake();
  }
  function ckStep() { ckRun(ck.t + STEP_REAL * ck.speed); if (!ckActive()) { clearInterval(ck.handle); ck.handle = 0; } }
  function ckWake() { if (!ck.handle && !ck.manual && ckActive()) ck.handle = setInterval(ckStep, STEP_REAL); }
  P.clock = {
    now: () => ck.t,
    wall: () => NOW0 + ck.t,
    after(ms, fn) { const id = ++ck.seq; ck.timers.push({ at: ck.t + Math.max(0, ms), fn, id, seq: id }); ck.timers.sort((a, b) => a.at - b.at || a.seq - b.seq); ckWake(); return id; },
    cancel(id) { const i = ck.timers.findIndex((x) => x.id === id); if (i >= 0) ck.timers.splice(i, 1); },
    ticker(tk) { ck.tickers.push(tk); },
    wake: ckWake,
    advance(ms) { ckRun(ck.t + ms); ckWake(); },
    get speed() { return ck.speed; },
    set speed(v) { ck.speed = Math.max(0.1, Math.min(200, Number(v) || 1)); },
    get running() { return !!ck.handle; },
    manual(on) { ck.manual = !!on; if (ck.manual && ck.handle) { clearInterval(ck.handle); ck.handle = 0; } else ckWake(); },
    hold: ckHold,                 // 第四段：/events 断开（bg ticker 停拍）↔ 恢复（补拍 = 重同步）
    get held() { return ck.hold; },
  };
  // 时间与大小的写法（东八区，与示例世界一致）
  const pad = (n) => String(n).padStart(2, '0');
  const sh = (ms) => new Date(ms + 8 * 3600e3);
  P.fmtFull = (ms) => { const d = sh(ms); return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };
  P.fmtHM = (ms) => { const d = sh(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  P.parseFull = (s) => { const m = /^(\d+)\/(\d+)\/(\d+) (\d+):(\d+)(?::(\d+))?$/.exec(s); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +(m[6] || 0)) : NaN; };
  P.fmtDur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60; return h ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`; };
  P.fmtMB = (mb) => (mb < 1024 ? `${Math.round(mb)} MB` : mb >= 100 * 1024 ? `${Math.round(mb / 1024)} GB` : `${(mb / 1024).toFixed(1)} GB`); // ≥ 100 GB 写整数（第三段：保留卷过量场景的成果动辄几百 GB）

  // 「需要渲染」标记：时钟一步里的多次状态变化合成一次 render（时钟之外调用时下一个微任务里渲染）
  let dirty = false, dirtyScheduled = false;
  function flushDirty() { if (dirty) { dirty = false; render(); } }
  P.dirty = () => { dirty = true; if (ck.stepping || dirtyScheduled) return; dirtyScheduled = true; Promise.resolve().then(() => { dirtyScheduled = false; flushDirty(); }); };

  // 每秒的就地更新：data-live-since 的元素写成「已过去的 m:ss」；其余由各流程挂在 'live' 钩子上（进度条、剩余时间…），不重建 DOM
  function updateLive() {
    if ((P.ui && P.ui.loading) || P.gated) return;
    const now = ck.t;
    for (const el of $$('[data-live-since]')) { const txt = P.fmtDur(now - Number(el.dataset.liveSince)); if (el.textContent !== txt) el.textContent = txt; }
    P.emit('live', now);
  }
  P.updateLive = updateLive;

  // ------------------------------------------------------------------ 场景（「原型说明 › 场景」页；也支持 #…&scenario=键:值,键:值 供测试）
  // define({ key, group, label, options: [[值, 说明], …], def, once })：once = 只作用于下一次，用完复位成默认值
  const scen = { defs: [], values: {} };
  P.scenario = {
    define(d) { if (scen.defs.some((x) => x.key === d.key)) return; scen.defs.push(d); if (!(d.key in scen.values) || !d.options.some((o) => o[0] === scen.values[d.key])) scen.values[d.key] = d.def; },
    get(k) { return scen.values[k]; },
    is(k, v) { return scen.values[k] === v; },
    // 改了场景可能让某个进行中的对象重新动起来（如「infra-scripts 那次克隆」从暂停改回推进）：顺手叫醒时钟
    set(k, v) { const d = scen.defs.find((x) => x.key === k); if (!d || !d.options.some((o) => o[0] === v)) return false; scen.values[k] = v; P.emit('scenario', k, v); P.clock.wake(); return true; },
    take(k) { const d = scen.defs.find((x) => x.key === k); const v = scen.values[k]; if (d && d.once) scen.values[k] = d.def; return v; },
    reset(k) { const d = scen.defs.find((x) => x.key === k); if (d) scen.values[k] = d.def; },
    defs: () => scen.defs.slice(),
    snapshot: () => ({ ...scen.values }),
  };
  function applyScenarioParam(str) {
    for (const pair of String(str || '').split(',')) {
      const i = pair.indexOf(':');
      // 已登记的键：值不在选项里就忽略（保持原值）；还没登记的键（别的 flows 后登记）先记下，登记时再校验
      if (i > 0) { const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim(); if (!P.scenario.set(k, v) && !scen.defs.some((d) => d.key === k)) scen.values[k] = v; }
    }
  }

  // ------------------------------------------------------------------ 示例世界（全原型共用一份；计数、徽标、树、总览、⌘K、新建任务下拉全部由它派生）
  // 基线 = pilot 原型（P2 一致），按 plan conventions.sample_world 与 notes/consistency.md ④ 增补：acme-web 7 个任务（原 5 个 +「升级依赖到 Node 22」超时 +
  // 「每天凌晨跑一遍回归 #12」无头）、保留下来的成果 3 份、自动化规则 5 条、项目补 source / createdAt、克隆数据、失败码。
  const world = (P.world = {
    projects: [
      { id: 'demo', name: '示例项目', avatar: '示', source: 'git', repo: 'https://github.com/acme/demo.git', repoShort: 'github.com/acme/demo', status: 'ready', branch: 'main', size: '12 MB', pulled: '2026/9/28 16:20', pulledShort: '9月28日', branches: ['main'], createdAt: '2026/9/1 09:30:00' },
      { id: 'web', name: 'acme-web', avatar: 'AW', source: 'git', repo: 'https://github.com/acme/web.git', repoShort: 'github.com/acme/web', status: 'ready', branch: 'main', size: '45 MB', pulled: '2026/10/2 09:12:01', pulledShort: '今天 09:12', branches: ['main', 'feat/login-refresh', 'fix/payment-callback', 'chore/node-22'], createdAt: '2026/9/8 14:02:33' },
      { id: 'api', name: 'acme-api', avatar: 'AA', source: 'git', repo: 'https://github.com/acme/api.git', repoShort: 'github.com/acme/api', status: 'failed', failCode: 'CLONE_FAILED_NETWORK', createdAt: '2026/10/2 10:05:12' },
      { id: 'docs', name: 'docs-site', avatar: 'DS', source: 'git', repo: 'https://github.com/acme/docs.git', repoShort: 'github.com/acme/docs', status: 'ready', branch: 'main', size: '8 MB', pulled: '2026/9/30 18:40', pulledShort: '9月30日', branches: ['main'], createdAt: '2026/9/20 15:44:10' },
      // 克隆中：数值同 P2 项目卡 / v1 g7-05（42% · 接收对象第 4/6 步 · 11,066/26,348 · 18.4 MB · 1.2 MB/s · 已用 0:38）；base = 示例世界预置的那次克隆（慢速推进，可暂停）
      { id: 'infra', name: 'infra-scripts', avatar: 'IS', source: 'git', repo: 'https://github.com/acme/infra.git', repoShort: 'github.com/acme/infra', status: 'cloning', createdAt: '2026/10/2 13:53:00', branches: [],
        clone: { pct: 42, since: -38000, base: true, receivedMB: 18.4, rate: '1.2 MB/s', objectsTotal: 26348 } },
    ],
    // 组内顺序 = 树里的顺序；age = 最后活跃距今的分钟数（排「最近任务」、选「最近活跃的任务」用；拿不到时写 null）；touched = 虚拟时刻（同为「刚刚」时谁更近）
    tasks: [
      { id: 'e2e', project: 'web', name: '补 e2e 用例', agent: 'Codex', state: 'waiting', active: '刚刚', age: 0, term: 'term-e2e', extraTabs: [] },
      { id: 'login', project: 'web', name: '修一下登录态刷新', agent: 'Codex', state: 'running', active: '1 分钟前', age: 1, term: 'term-login', extraTabs: [{ kind: 'shell', label: '终端 1', tpl: 'term-login-shell' }] },
      { id: 'notes', project: 'web', name: '整理发布说明', agent: 'Codex', state: 'idle', active: '1 小时前', age: 60, term: 'term-notes', extraTabs: [] },
      { id: 'pay', project: 'web', name: '重构支付回调', agent: 'Codex', state: 'waiting', active: '4 分钟前', age: 4, term: 'term-pay', extraTabs: [] },
      { id: 'build', project: 'web', name: '迁移构建脚本', agent: 'Codex', state: 'error', code: 'IMAGE_PULL_FAILED', failedAt: 'launch', reason: '启动失败：没能把镜像拉下来', detail: 'pull ghcr.io/agent-infra/sandbox@sha256:4b17e…344: dial tcp: lookup ghcr.io: i/o timeout', age: null },
      { id: 'node22', project: 'web', name: '升级依赖到 Node 22', agent: 'Codex', state: 'error', code: 'TIMEOUT', failedAt: 'launch', reason: '超时未响应：这一步等太久，平台先停下了', detail: 'create instance: no response from the container service within 600s', age: null },
      { id: 'nightly', project: 'web', name: '每天凌晨跑一遍回归 #12', agent: 'Codex', state: 'running', headless: true, active: '刚刚', age: 0, timeoutMin: 120, leftMin: 83, rule: '每天凌晨跑一遍回归' },
      { id: 'demo-test', project: 'demo', name: '跑一遍示例测试', agent: 'Codex', state: 'stopped', age: null },
      { id: 'demo-tree', project: 'demo', name: '梳理目录结构', agent: 'Codex', state: 'stopped', age: null },
      { id: 'demo-rules', project: 'demo', name: '试用自动化规则', agent: 'Codex', state: 'stopped', age: null },
    ],
    // 保留下来的成果（notes/prj-b.md §5；#11 按 consistency ②：保留于 2026/9/27 03:18:05，规则保留期 7 天）
    retained: [
      { id: 'rv-c8d2', project: 'demo', name: '改一处示例代码', sandboxId: 'c8d2f14a-3b6e-4f0a-9d21-5e7c0b8a1f36', source: 'manual-destroy', retainedAt: '2026/9/2 18:20:41', keepDays: 30, diskMB: 1638, dlMB: 412 },
      { id: 'rv-7f3a', project: 'demo', name: '补一份示例 README', sandboxId: '7f3a1c2e-9d08-4b7f-a6e1-0c2d4f6b8a93', source: 'manual-destroy', retainedAt: '2026/9/29 10:12:00', keepDays: 30, diskMB: 2150, dlMB: 618 },
      { id: 'rv-a91e', project: 'web', name: '每天凌晨跑一遍回归 #11', sandboxId: 'a91e07d3-6c4b-4e19-8f02-1d7a9b3c5e60', source: 'automation-artifact', retainedAt: '2026/9/27 03:18:05', keepDays: 7, diskMB: 512, dlMB: 96 },
    ],
    // 自动化规则（notes/aut.md §5；运行历史等由 F-AUT-RULES 补）
    automations: [
      { id: 'rule-nightly', project: 'web', name: '每天凌晨跑一遍回归', agent: 'Codex', schedule: '每天 03:00', tz: 'Asia/Shanghai', state: 'on', fails: 1 },
      { id: 'rule-deps', project: 'web', name: '每周一整理依赖升级', agent: 'Claude Code', schedule: '每周一 09:00', tz: 'Asia/Tokyo', state: 'off', fails: 0 },
      { id: 'rule-alerts', project: 'web', name: '每小时检查构建告警', agent: 'Codex', schedule: '每小时 :15', tz: 'Asia/Shanghai', state: 'throttled', fails: 4 },
      { id: 'rule-release', project: 'web', name: '每天生成发布说明草稿', agent: 'Codex', schedule: '每天 18:00', tz: 'Asia/Shanghai', state: 'auto-disabled', fails: 10 },
      { id: 'rule-demo', project: 'demo', name: '每天跑一遍示例测试', agent: 'Codex', schedule: '每天 09:00', tz: 'Asia/Shanghai', state: 'on', fails: 0 },
    ],
    // Agent 注册表与凭证（notes/crd-a.md §6.1、crd-b.md §6.1）：每个 Agent 两种方式各最多一份，active = 生效方式（'account' | 'apiKey' | null）。
    // 派生：credStatus（none / active / expiring / expired）与打码身份由 flows-crd.js 挂成 rt.cred / rt.identity（新建任务闸门、P3、P5 共用）
    runtimes: [
      { id: 'codex', name: 'Codex', vendor: 'OpenAI', prefix: 'sk-', accountMethod: 'oauth-device', active: 'account',
        account: { masked: 'a***@example.com', daysLeft: 26 }, apiKey: { masked: 'sk-…f3a9' } },
      { id: 'claude-code', name: 'Claude Code', vendor: 'Anthropic', prefix: 'sk-ant-', accountMethod: 'setup-token', active: null, account: null, apiKey: null },
    ],
    // 镜像（P7 三张 + notes/img-a.md §7、img-b.md §8 的增补）：卡面 face = 这个 tag 当前那一版；history = 同一张镜像的其他版本（注册时间倒序）；
    // upstreamNext = 下载源上这个 tag 现在指向的那一版（[检查更新] 才看得到）；face.usedBy = 示例世界里用这一版建的任务（flows-lch 据此给示例任务记下 t.image；
    // 之后「谁在用这一版」一律按任务上记的那一版算——2026-10-04 Q-LCH-03 B 后新建任务也能选它，flows-img usedBy）；preset = 预制镜像下载到本机
    images: [
      { id: 'sandbox', name: 'ghcr.io/agent-infra/sandbox', ref: 'ghcr.io/agent-infra/sandbox:latest', builtin: true, active: true, history: [], upstreamNext: null,
        face: { version: 'latest', digest: 'sha256:4b17eb7ad567477c83756aab9a542b2be04f77dbae25115d85f22070d74d8344', status: 'valid', reasons: [], runtimes: 'codex、claude-code', resolved: '7 天前', lineage: '这就是平台的预制镜像（其他镜像从它改起）', env: [] },
        preset: { staged: true, plan: 'ghcr.io/agent-infra/sandbox:latest → 本机镜像库 · 约 320 MB' } },
      { id: 'ml-agent', name: 'docker.io/acme/ml-agent', ref: 'docker.io/acme/ml-agent:v1.0', builtin: false, active: true,
        face: { version: 'v1.0', digest: 'sha256:8e05a5d58d41913d9fea4e42cecd7a5d1b692aa6d0d792977ad7c6d6bb150d77', status: 'warning', usedBy: ['e2e', 'demo-test'], reasons: ['未预装 claude-code，创建时需现装，启动会明显变慢'], runtimes: 'codex', resolved: '3 天前', lineage: '从预制镜像 sha256:4b17e…344 改来的',
          env: [{ key: 'LOG_LEVEL', value: 'info' }, { key: 'MY_SECRET', value: '', secret: true }, { key: 'HTTP_TIMEOUT', value: '30' }] },
        history: [{ version: 'v1.0', digest: 'sha256:2c9d10b9a588ed3d7be06df7a171f7777c6d10ada396e6dbd6644a235ce05b08', status: 'valid', reasons: [], runtimes: 'codex、claude-code', resolved: '12 天前', lineage: '从预制镜像 sha256:4b17e…344 改来的',
          env: [{ key: 'LOG_LEVEL', value: 'info' }, { key: 'MY_SECRET', value: '', secret: true }] }],
        upstreamNext: { digest: 'sha256:c1f9ed06a59d76f3610e390e5d553a1ca036115a48e96205efd3f55756440a20', status: 'valid', reasons: [], runtimes: 'codex、claude-code' } },
      { id: 'just-registered', name: 'docker.io/acme/just-registered', ref: 'docker.io/acme/just-registered:v1', builtin: false, active: true, history: [], upstreamNext: null,
        face: { version: 'v1', digest: 'sha256:7a3f2b2c66dfd45dd07f58d2246b695660b220ee429c6a8ba95f27e4c57f0e91', status: 'invalid', reasons: ['平台还没有对这张镜像出具验证结论（数据异常），因此它现在不能用于创建任务。点 [重新验证] 让平台判定一次。'], runtimes: 'codex、claude-code', resolved: '2 小时前', lineage: '从预制镜像 sha256:4b17e…344 改来的', env: [] } },
    ],
    // Git 凭证（每种协议最多一份；notes/crd-b.md §6.1）：HTTPS Token 只发给白名单里的 host
    gitCreds: { https: { masked: 'ghp_…ab12', platform: 'github', hosts: ['github.com'], lastUsed: '2 小时前' }, ssh: null },
    audit: [],
    banners: [],
  });
  // 用户态（Q-DS-15 ②A）：点的色调、顶栏徽标色调、状态词、筛选档。空闲归运行中（副行只加「空闲」）；可能卡住归「准备中」档；停止中归「已停止」；删除中不进任何档
  const STATE = (P.STATE = {
    waiting: { word: '等待你输入', dot: 'waiting', badge: 'info', filter: 'waiting' },
    running: { word: '运行中', dot: 'running', badge: 'ok', filter: 'running' },
    idle: { word: '运行中', dot: 'running', badge: 'ok', filter: 'running' },
    error: { word: '异常', dot: 'error', badge: 'fail', filter: 'error' },
    stopped: { word: '已停止', dot: 'stopped', badge: 'neutral', filter: 'stopped' },
    preparing: { word: '准备中', dot: 'preparing', badge: 'neutral', filter: 'preparing' },
    stuck: { word: '可能卡住', dot: 'stuck', badge: 'warn', filter: 'preparing' },
    starting: { word: '准备中', dot: 'preparing', badge: 'neutral', filter: 'preparing' },
    stopping: { word: '停止中…', dot: 'stopped', badge: 'neutral', filter: 'stopped' },
    destroying: { word: '删除中…', dot: 'removing', badge: 'neutral', filter: null },
  });
  // 活跃 = 准备中（含可能卡住、启动中）、运行中（含空闲）、等待你输入、停止中（REQ-PRJ-040）
  P.ACTIVE = new Set(['preparing', 'stuck', 'starting', 'running', 'idle', 'waiting', 'stopping']);
  P.FILTERS = [['all', '全部'], ['preparing', '准备中'], ['running', '运行中'], ['waiting', '等待输入'], ['stopped', '已停止'], ['error', '异常']];
  P.THEMES = [['system', '跟随系统', 'i-monitor'], ['light', '亮色', 'i-sun'], ['dark', '暗色', 'i-moon']];
  P.VIEW_NAMES = { overview: '项目总览', credentials: '凭证管理', images: '镜像管理', system: '系统状态' };

  const proj = (P.proj = (id) => world.projects.find((p) => p.id === id));
  const task = (P.task = (id) => world.tasks.find((t) => t.id === id));
  const tasksOf = (P.tasksOf = (pid) => world.tasks.filter((t) => t.project === pid));
  P.retainedOf = (pid) => world.retained.filter((r) => pid == null || r.project === pid);
  P.automationsOf = (pid) => world.automations.filter((a) => a.project === pid);
  P.runtime = (id) => world.runtimes.find((r) => r.id === id);
  const waitingCount = (P.waitingCount = () => world.tasks.filter((t) => t.state === 'waiting').length);
  P.filterLabel = (k) => (P.FILTERS.find((f) => f[0] === k) || P.FILTERS[0])[1];
  const themeName = (P.themeName = (k) => (P.THEMES.find((t) => t[0] === k) || P.THEMES[0])[1]);
  // 最近活跃在前；拿不到时间的排最后（同为 null 时保持树里的顺序：sort 是稳定的）；同为「刚刚」时后发生的在前
  const sortByRecency = (P.sortByRecency = (a, b) => ((a.age == null ? Infinity : a.age) - (b.age == null ? Infinity : b.age)) || ((b.touched || 0) - (a.touched || 0)));
  // F9：「进入项目」= 打开它最近活跃的任务（项目卡、范围切换器 / 面包屑、⌘K 项目结果、地址栏 #project-x 共用）；删除中的不算
  const latestTask = (P.latestTask = (pid) => tasksOf(pid).filter((t) => t.state !== 'destroying').sort(sortByRecency)[0] || null);
  // 「需要你处理」：异常 > 可能卡住 > 等待你输入（Q-LCH-04 A；后两类按最后活跃）；删除中的不算
  P.todoTasks = () => {
    const err = world.tasks.filter((t) => t.state === 'error');
    const stuck = world.tasks.filter((t) => t.state === 'stuck');
    const wait = world.tasks.filter((t) => t.state === 'waiting').sort(sortByRecency);
    return err.concat(stuck, wait);
  };
  P.recentTasks = () => { const todo = new Set(P.todoTasks()); return world.tasks.filter((t) => !todo.has(t) && t.state !== 'destroying').sort(sortByRecency).slice(0, 4); };
  P.isReady = (p) => !!p && p.status === 'ready';
  P.newId = (prefix) => { let i = 1; while (task(`${prefix}${i}`) || proj(`${prefix}${i}`)) i++; return `${prefix}${i}`; };

  // ------------------------------------------------------------------ 界面状态（只在内存里）
  const ui = (P.ui = {
    route: { view: 'overview' },
    expanded: { demo: false, web: true, api: false, docs: false, infra: false },
    filter: 'all',
    rail: store.get(KEY_RAIL) === '1',
    theme: ['system', 'light', 'dark'].includes(store.get(KEY_THEME)) ? store.get(KEY_THEME) : 'system',
    loading: true,
    termFont: 14,
    tabs: {},        // 任务 id → { list, active, seq }
    cleared: {},     // 「任务:标签」→ 清过屏
    notice: null,    // 页内提示 { key, title, text, icon, progress, closable, fresh }
    ovQuery: '',
    pinned: null,    // 树里置顶的项目（F6：只在从树以外的地方进来时更新）
    pulling: {},     // 项目 id → true（拉取中）
  });

  // ------------------------------------------------------------------ 主题（跟随系统 / 亮 / 暗）
  const effectiveTheme = (P.effectiveTheme = () => (ui.theme === 'system' ? (MQ_LIGHT.matches ? 'light' : 'dark') : ui.theme));
  function applyTheme() {
    const root = document.documentElement;
    const t = effectiveTheme();
    const changed = root.getAttribute('data-theme') !== t;
    // PF-09：切主题这一帧关掉全部过渡（next-themes disableTransitionOnChange 的做法），按钮不再拖着上一个主题的颜色过渡 150ms
    if (changed) root.classList.add('proto-theme-switching');
    root.setAttribute('data-theme', t);
    root.setAttribute('data-proto-theme', ui.theme);
    if (changed) {
      void (document.body || root).offsetHeight; // 强制按新主题算一次样式（这一帧没有过渡）
      requestAnimationFrame(() => root.classList.remove('proto-theme-switching'));
    }
    const b = $('[data-menu="appearance"]');
    if (b) b.setAttribute('aria-label', `外观（当前：${themeName(ui.theme)}）`);
  }
  P.setTheme = function setTheme(mode) {
    ui.theme = mode;
    store.set(KEY_THEME, mode);
    applyTheme();
    announce(`外观：${themeName(mode)}`);
  };
  MQ_LIGHT.addEventListener('change', () => { if (ui.theme === 'system') applyTheme(); });

  // ------------------------------------------------------------------ 侧栏收起（⌘B）：48 图标轨，导航保留可访问名称，等待徽标缩成点（CSS：.shell--rail）
  // PF-06：收起 = 文字先淡出 100ms → 宽度 256 → 48（200ms standard）→ 收完才换成图标轨的排布；展开反过来（宽度到位再淡入文字）。
  // 宽度动画结束后「终端 fit 一次」（T-32）——原型里只把次数记在 <html data-proto-term-fit>。reduce 时整段跳过，直接换类。
  const RAIL_TEXT_MS = 100, RAIL_WIDTH_MS = 200;
  let railSeq = null, termFitCount = 0;
  function termFit() { termFitCount++; document.documentElement.setAttribute('data-proto-term-fit', String(termFitCount)); }
  function railClasses(on) {
    const shell = $('#shell');
    shell.classList.remove('proto-rail-anim', 'proto-rail-fade', 'proto-rail-narrow');
    shell.classList.toggle('shell--rail', on);
  }
  function finishRailSeq() {
    if (!railSeq) return;
    const s = railSeq; railSeq = null;
    s.timers.forEach(clearTimeout);
    s.end();
  }
  function animateRail(on) {
    finishRailSeq();
    const shell = $('#shell');
    if (reduceMotion() || MQ_NARROW.matches) { railClasses(on); termFit(); return; }
    const seq = { timers: [], fitted: false };
    const later = (fn, ms) => seq.timers.push(setTimeout(fn, ms));
    seq.end = () => { railClasses(on); if (!seq.fitted) termFit(); };
    railSeq = seq;
    if (on) {
      shell.classList.add('proto-rail-anim', 'proto-rail-fade');               // 1 文字淡出
      later(() => {
        shell.classList.add('proto-rail-narrow');                              // 2 宽度 256 → 48
        later(() => { railSeq = null; seq.end(); }, RAIL_WIDTH_MS + 30);       // 3 收完换成图标轨的排布，终端 fit 一次
      }, RAIL_TEXT_MS);
    } else {
      shell.classList.add('proto-rail-anim', 'proto-rail-fade', 'proto-rail-narrow');
      shell.classList.remove('shell--rail');                                   // 1 换回展开态的排布：宽度仍是 48、文字先藏着
      void shell.offsetWidth;
      shell.classList.remove('proto-rail-narrow');                             // 2 宽度 48 → 256
      later(() => {
        seq.fitted = true; termFit();                                          // 3 宽度到位：终端 fit 一次，文字淡入
        shell.classList.remove('proto-rail-fade');
        later(() => { railSeq = null; railClasses(false); }, RAIL_TEXT_MS + 30);
      }, RAIL_WIDTH_MS + 30);
    }
  }
  function applyRail(animate) {
    if (!$('#shell')) return; // 访问口令门盖着时外壳不在 DOM 里（F-ACC-UNLOCK），解锁后再按记住的状态排
    const narrow = MQ_NARROW.matches;
    const rail = ui.rail || narrow;
    if (animate) animateRail(ui.rail); else { finishRailSeq(); railClasses(ui.rail); }
    const b = $('#rail-btn');
    b.setAttribute('aria-expanded', String(!rail));
    b.setAttribute('aria-label', rail ? '展开侧栏' : '收起侧栏');
    b.dataset.tip = narrow ? '窄屏下侧栏固定为图标轨' : rail ? '展开侧栏' : '收起侧栏';
    if (narrow) delete b.dataset.tipKbd; else b.dataset.tipKbd = KBD_RAIL;
    b.setAttribute('aria-keyshortcuts', IS_MAC ? 'Meta+B' : 'Control+B');
    b.removeAttribute('title');
    b.firstElementChild.className = 'icon ' + (rail ? 'i-panel-left-open' : 'i-panel-left-close');
    // 图标轨里 Logo 的产品名与「本机」标签都不显示：给链接一个名称（展开时名称就是看得见的文字，不加 aria-label）
    const home = $('.scope__home');
    if (home) { if (rail) home.setAttribute('aria-label', 'Agent 管理平台 · 回到工作台'); else home.removeAttribute('aria-label'); }
    // F11：窄屏（< 640）侧栏固定为图标轨——按钮不可用但能聚焦、能说原因（点了在旁边说明，不再假装能展开）
    if (narrow) { b.setAttribute('aria-disabled', 'true'); b.dataset.reason = NARROW_RAIL_REASON; }
    else { b.removeAttribute('aria-disabled'); delete b.dataset.reason; }
    document.documentElement.setAttribute('data-proto-rail', rail ? '1' : '0');
  }
  P.setRail = function setRail(on, { persist = true } = {}) {
    ui.rail = on;
    if (persist) store.set(KEY_RAIL, on ? '1' : '0');
    hideTip();
    closeMenu(false, { instant: true }); // 侧栏宽度变了，挂在侧栏触发器旁的菜单位置就不对了（焦点在菜单里时还给触发器，F8）
    applyRail(true);
    announce(on ? '侧栏已收起' : '侧栏已展开');
  };
  P.toggleRail = function toggleRail(from) {
    if (P.gated) return;
    if (MQ_NARROW.matches) { hint(from || $('#rail-btn'), NARROW_RAIL_REASON); return; }
    P.setRail(!ui.rail);
  };
  MQ_NARROW.addEventListener('change', () => applyRail(false));

  // ------------------------------------------------------------------ 读屏播报（F4：60ms 内的几条合成一句，不互相顶掉）
  let liveTimer = 0, livePending = [];
  function announce(msg) {
    const live = $('#proto-live');
    if (!live || !msg) return;
    if (!livePending.includes(msg)) livePending.push(msg);
    live.textContent = '';
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { live.textContent = livePending.join(' '); livePending = []; }, 60);
  }
  P.announce = announce;

  // ------------------------------------------------------------------ 浮层出场（PF-02）：先挂 data-state="closed"（不接收指针、读屏看不到），播完再移除；reduce 时直接移除
  function leave(el, instant) {
    if (!el || !el.isConnected) return;
    if (instant || reduceMotion()) { el.remove(); return; }
    el.setAttribute('data-state', 'closed');
    el.setAttribute('aria-hidden', 'true');
    el.inert = true;
    el.removeAttribute('id');
    let done = false;
    const fin = () => { if (!done) { done = true; el.remove(); } };
    el.addEventListener('animationend', (e) => { if (e.target === el) fin(); });
    setTimeout(fin, 400); // 兜底：最长的出场 300ms
  }
  P.leave = leave;

  // ------------------------------------------------------------------ 浮动小提示：tooltip 与「为什么不可用」共用一套定位（PF-05 / PF-14）
  // prefer：'above'（tooltip，Geist 默认在上方）| 'below'（点按钮之后的说明，出在按钮下面）；图标轨里的放在图标右侧
  function placeFloating(el, target, prefer) {
    const r = target.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    if ((ui.rail || MQ_NARROW.matches) && target.closest('#sidebar')) {
      el.classList.add('proto-tip--right');
      el.style.left = `${Math.round(r.right + 10)}px`;
      el.style.top = `${Math.round(Math.max(8, Math.min(r.top + r.height / 2 - h / 2, vh - h - 8)))}px`;
      return;
    }
    let left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, vw - w - 8));
    const above = r.top - h - 8, below = r.bottom + 8;
    let top, isBelow;
    if (prefer === 'below') { isBelow = below + h <= vh - 8 || above < 8; top = isBelow ? below : above; }
    else { isBelow = above < 8; top = isBelow ? below : above; }
    el.classList.toggle('tooltip--below', isBelow);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.setProperty('--arrow-x', `${Math.round(Math.max(10, Math.min(w - 10, r.left + r.width / 2 - left)))}px`);
  }
  P.placeFloating = placeFloating;

  // 「为什么不可用」：tooltip 材质，2 秒后淡出（PF-14）。不给 text 时是「原型：未接入」（前面多一个原型标记点）——第四段起所有控件都接上了，
  // 这一支只作为安全网留着（漏接的控件不至于静默）；守卫测试（tools/proto-test.cjs「守卫」组）盯着任何视图、菜单、弹层里不再出现这几个字
  let hintEl = null, hintTimer = 0;
  function hint(anchor, text) {
    const nohook = !text || text === NOHOOK;
    text = text || NOHOOK;
    removeHint(true);
    hintEl = document.createElement('div');
    hintEl.className = `tooltip proto-hint${nohook ? ' proto-hint--nohook' : ''}`;
    hintEl.setAttribute('aria-hidden', 'true');
    hintEl.setAttribute('data-proto-hint', '');
    hintEl.innerHTML = (nohook ? '<span class="proto-hint__dot"></span>' : '') + esc(text);
    document.body.appendChild(hintEl);
    placeFloating(hintEl, anchor, 'below');
    announce(text);
    hintTimer = setTimeout(() => removeHint(false), 2000);
  }
  function removeHint(instant) {
    clearTimeout(hintTimer);
    if (!hintEl) return;
    const el = hintEl; hintEl = null;
    leave(el, instant);
  }
  P.hint = hint;

  // ------------------------------------------------------------------ 路由：location.hash 的纯 token（#overview #credentials #images #system #task-<id> #project-<id>）
  // 另认两种参数（读完就从地址里抹掉，地址栏回到纯 token）：&scenario=键:值,…（场景）、&speed=N（时钟加速）；深链 #new&project=<id>（REQ-LCH-009）
  function splitHash(raw) {
    const h = raw != null ? raw : decodeURIComponent((window.location.hash || '').slice(1));
    const parts = h.split('&');
    const params = {};
    for (const kv of parts.slice(1)) { const i = kv.indexOf('='); if (i > 0) params[kv.slice(0, i)] = kv.slice(i + 1); }
    return { token: parts[0], params };
  }
  function parseHash(raw) {
    const h = raw != null ? raw : splitHash().token;
    if (!h || h === 'overview') return { view: 'overview' };
    if (P.VIEW_NAMES[h]) return { view: h };
    let m = /^task-([a-z0-9-]+)$/.exec(h);
    if (m && task(m[1])) return { view: 'task', taskId: m[1] };
    m = /^project-([a-z0-9]+)$/.exec(h);
    if (m && proj(m[1])) return { view: 'project', projectId: m[1] };
    return P.ask('route.unknown', h) || null; // F-WB-ROUTE（flows-wb.js）：答 { view: 'overview', missing: { kind, id, name } }；没人答时回总览
  }
  P.parseHash = parseHash;
  function viewKey(r) { r = r || ui.route; return r.view + (r.taskId ? ':' + r.taskId : r.projectId ? ':' + r.projectId : ''); }
  P.viewKey = viewKey;
  function isWorkbench(r) { r = r || ui.route; return r.view === 'overview' || r.view === 'task' || r.view === 'project'; }
  P.isWorkbench = isWorkbench;
  function projectOf(r) {
    if (r.view === 'task') { const t = task(r.taskId); return t ? t.project : null; }
    if (r.view === 'project') return r.projectId;
    return null;
  }
  const currentProjectId = (P.currentProjectId = () => projectOf(ui.route));
  P.currentTask = () => (ui.route.view === 'task' ? task(ui.route.taskId) : null);
  let routeFromTree = false;
  function go(token) {
    if (decodeURIComponent((window.location.hash || '').slice(1)) === token) { onRoute(); return; }
    try { window.location.hash = token; } catch (e) { onRoute(token); }
  }
  P.go = go;
  // 同步换路由、不留历史记录（被删的对象不该能「后退」回去；也避免 hashchange 异步期间的渲染指着已删的对象）
  P.replaceRoute = function replaceRoute(token) { try { history.replaceState(null, '', '#' + token); } catch (e) { /* 拿不到时照常 */ } onRoute(token); };
  // F6：树里点的切换不重排树（被点的行留在指针下面）；从树以外的地方进来时才把当前项目置顶
  P.goFromTree = function goFromTree(token) { routeFromTree = true; go(token); };
  P.enterProject = function enterProject(pid) {
    const t = latestTask(pid);
    go(t ? `task-${t.id}` : `project-${pid}`);
  };
  P.projectHref = (p) => { const t = latestTask(p.id); return t ? `#task-${t.id}` : `#project-${p.id}`; };
  // 地址里的参数：读完就抹掉（history.replaceState 不触发 hashchange），返回需要另外处理的深链
  function consumeParams() {
    const { token, params } = splitHash();
    if (!Object.keys(params).length && token !== 'new') return null;
    if (params.scenario) applyScenarioParam(params.scenario);
    if (params.speed) P.clock.speed = params.speed;
    if (params.clock === 'manual') P.clock.manual(true);
    let deep = null;
    if (token === 'new') deep = { kind: 'new-task', project: params.project || null };
    P.emit('params', token, params); // 视图自己的地址参数（如 #images&filter=warning，flows-img.js）：读完一样抹掉
    const clean = token === 'new' ? viewKeyToken(ui.route || { view: 'overview' }) : token;
    try { history.replaceState(null, '', '#' + clean); } catch (e) { /* file:// 下也可用；拿不到时照常 */ }
    return deep;
  }
  function viewKeyToken(r) { return r.view === 'task' ? `task-${r.taskId}` : r.view === 'project' ? `project-${r.projectId}` : r.view; }
  P.routeToken = viewKeyToken;

  // F-WB-ROUTE（REQ-WB-040，第四段）：地址 / 前进后退指向已不在的对象或不存在的页面——回落总览、内容顶部一句（flows-wb.js 按 'route.missing' 写页内提示）、
  // 地址改成 #overview（替换当前历史记录，不再多留一条坏记录），这一句并进路由播报
  function landMissing(r) {
    if (!r || !r.missing) return r;
    P.emit('route.missing', r.missing);
    try { history.replaceState(null, '', '#overview'); } catch (e) { /* 拿不到时照常 */ }
    return { view: 'overview', missed: true };
  }
  function onRoute(rawToken) {
    const deep = rawToken == null ? consumeParams() : null;
    if (deep) { handleDeepLink(deep); return; }
    let r = landMissing(parseHash(rawToken));
    if (!r) r = { view: 'overview' };
    const forced = !!r.missed;
    if (forced) r = { view: 'overview' };
    // 项目下有任务时没有「只选项目」这一态（项目行点击 = 展开 / 收起）：进它最近活跃的任务
    if (r.view === 'project' && latestTask(r.projectId)) {
      const t = latestTask(r.projectId);
      try { window.location.replace(`#task-${t.id}`); return; } catch (e) { r = { view: 'task', taskId: t.id }; }
    }
    // 正在删除的任务：主区不再停在它上面（REQ-SBX-021），回总览
    if (r.view === 'task' && task(r.taskId).state === 'destroying') { try { window.location.replace('#overview'); return; } catch (e) { r = { view: 'overview' }; } }
    const changed = viewKey(r) !== viewKey();
    if (changed && r.view !== 'overview') ui.ovQuery = ''; // 离开总览时清掉总览搜索词（回来时是完整的总览）
    ui.route = r;
    if (!routeFromTree) ui.pinned = projectOf(r);
    routeFromTree = false;
    if (r.view === 'task') ui.expanded[task(r.taskId).project] = true;
    if (r.view === 'project' && proj(r.projectId).status === 'ready') ui.expanded[r.projectId] = true;
    if (ui.notice && ui.notice.key !== viewKey()) ui.notice = null;
    closeMenu(false, { instant: true });
    P.emit('route', r, changed);
    // 浏览器前进 / 后退时如果还开着对话框：先关掉；焦点没处去时落到主区（F8）
    const hadModal = modals.length > 0;
    while (modals.length) closeModal(topModal(), { restoreFocus: false, instant: true, force: true });
    render();
    if (hadModal && (!document.activeElement || document.activeElement === document.body)) focusMain();
    if ((changed || forced) && !ui.loading) announce(routeMsg());
  }
  P.onRoute = onRoute;
  // 路由播报：「已打开 …」；刚落下的页内提示并进同一句（F4；第四段：「找不到…。已打开 项目总览」）
  function routeMsg() {
    let msg = `已打开 ${pageTitle()}`;
    const n = ui.notice;
    if (n && n.fresh && n.key === viewKey()) {
      // F4：销毁的是当前任务时，结果并进这一句路由播报（单独播报会被「已打开 项目总览」顶掉）
      if (n.kind === 'missing') msg = n.page ? n.title : `${n.title}${msg}`; // 「找不到…：可能已被销毁。已打开 项目总览」；页面不存在那句本身就说了「已打开项目总览」
      else msg = `${n.title}。${n.text || ''} ${msg}`;
      n.fresh = false;
    }
    return msg;
  }
  // 深链（REQ-LCH-009，原型写作 #new&project=<id>）：首屏加载完再处理
  let pendingDeep = null;
  function handleDeepLink(deep) {
    if (ui.loading) { pendingDeep = deep; return; }
    P.emit('deeplink', deep);
  }
  function pageTitle() {
    const r = ui.route;
    if (r.view === 'task') { const t = task(r.taskId); return `${t.name} · ${proj(t.project).name}`; }
    if (r.view === 'project') return proj(r.projectId).name;
    return P.VIEW_NAMES[r.view];
  }
  P.pageTitle = pageTitle;

  // ------------------------------------------------------------------ 渲染：总入口（保住焦点、树的滚动位置、开着的菜单）
  // 第五段（W4，评审 R1-01 / R1-03 / R1-11）：被重画换掉的焦点控件按 data-fk 找回——render 与单独调用的 refreshMain 共用
  function refocus(fk, fallbackMain) {
    const again = fk && $(`[data-fk="${CSS.escape(fk)}"]`);
    if (again && !again.closest('[inert]') && !again.disabled && isShown(again)) { again.focus({ preventScroll: true }); return true; }
    if (fallbackMain) focusMain();
    return false;
  }
  // 焦点在树里、那一行被移除（删除中 → 移除，或筛选后不在了）：依次给同组下一行、上一行、组头（R1-11）
  function treeContext(active) {
    const tree = $('#tree');
    if (!active || !tree || !tree.contains(active)) return null;
    const sec = active.closest('.tree-group');
    if (!sec) return null;
    const rows = $$('[data-fk^="tt:"]', sec).map((b) => b.getAttribute('data-fk'));
    const li = active.closest('.tree-task');
    const own = li && $('[data-fk^="tt:"]', li);
    const head = $('[data-fk^="ps:"]', sec);
    return { rows, idx: own ? rows.indexOf(own.getAttribute('data-fk')) : -1, head: head ? head.getAttribute('data-fk') : null };
  }
  function refocusTree(ctx) {
    if (!ctx) return false;
    const order = ctx.idx < 0 ? ctx.rows : [...ctx.rows.slice(ctx.idx + 1), ...ctx.rows.slice(0, ctx.idx).reverse()];
    for (const k of order) if (refocus(k, false)) return true;
    return !!(ctx.head && refocus(ctx.head, false));
  }
  // 焦点此刻是否丢了：被移除的控件在 Chromium 里会让 activeElement 落回 body
  function focusLost() { const a = document.activeElement; return !a || a === document.body; }
  // 关掉弹层时没还焦点（restoreFocus: false——紧接着换路由 / 换整屏的那些路径）：下一次 render 时焦点若还在 body，就交给主区（R1-06）
  let focusPending = false;
  function render(forceMain) {
    // 访问口令门（F-ACC-UNLOCK）：门之下不挂外壳与工作台，解锁前什么都不画（状态照常在内存里变，解锁后一次画出来）
    if (P.gated) return;
    // 路由指着的对象已经不在了（被删）：先落到总览（F-WB-ROUTE 另有「找不到…」的说法）
    const rr = ui.route;
    if ((rr.view === 'task' && !task(rr.taskId)) || (rr.view === 'project' && !proj(rr.projectId))) ui.route = { view: 'overview' };
    const active = document.activeElement;
    const fk = active && active.getAttribute && active.getAttribute('data-fk');
    const focusInMain = !!(active && $('#shell-main').contains(active));
    const treeCtx = treeContext(active);
    const scroller = $('#tree-scroll');
    const scrollTop = scroller ? scroller.scrollTop : 0;

    renderNav();
    renderFilterUi();
    renderTree();
    renderMain(forceMain);
    document.title = `${ui.loading ? '正在加载' : pageTitle()} · 交互原型 · Agent 管理平台`;

    if (scroller) scroller.scrollTop = scrollTop;
    // 菜单开着、触发器被重画了：换到新的同名触发器上（找不到就关）
    if (menu.el && menu.trigger && !menu.trigger.isConnected) {
      const fkT = menu.trigger.getAttribute('data-fk');
      const again = fkT && $(`[data-fk="${CSS.escape(fkT)}"]`);
      if (again) { menu.trigger = again; again.setAttribute('aria-expanded', 'true'); again.setAttribute('aria-controls', 'proto-menu'); again.classList.add('is-open'); }
      else closeMenu(false, { instant: true });
    }
    // 只在焦点此刻确实丢了（落在 body）时兜底：各视图的 paint 可能已经把焦点交给了别处（出错的字段、结果里的 [重试]），不盖掉它
    if (active && !active.isConnected && focusLost() && !refocus(fk, false) && !refocusTree(treeCtx) && (focusInMain || active === document.body)) focusMain();
    if (focusPending && !modals.length) {
      focusPending = false;
      const a = document.activeElement;
      if (!a || a === document.body) focusMain();
    }
    P.emit('rendered');
    updateLive();
  }
  P.render = render;
  function focusMain() { const m = $('#main'); if (m) m.focus({ preventScroll: true }); }
  P.focusMain = focusMain;

  // ------------------------------------------------------------------ 侧栏：导航（当前项、等待徽标）
  function renderNav() {
    // 首屏加载：工作台视图出 P6b 骨架（侧栏「任务」为当前）；凭证 / 镜像这类设置页直接打开时出本页骨架，侧栏就是那一页（F-CRD-PAGE / F-IMG-PAGE）
    const wb = (ui.loading && resolveTpl(ui.route) === 'tpl-loading') || isWorkbench();
    const cur = wb ? 'tasks' : ui.route.view;
    for (const a of $$('.nav-item')) {
      const on = a.dataset.nav === cur;
      a.classList.toggle('is-current', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    const item = $('.nav-item[data-nav="tasks"]');
    let badge = item.querySelector('.badge');
    let status = item.querySelector('[role="status"]');
    if (wb) {
      // 工作台（挂 /events）：「N 等待你输入」徽标 aria-hidden + 同一链接里视觉隐藏的 role="status"（没有等待时留空的 status 区域）
      const n = ui.loading ? 0 : waitingCount();
      if (!status) { status = document.createElement('span'); status.className = 'u-sr-only'; status.setAttribute('role', 'status'); item.appendChild(status); }
      if (n) {
        if (!badge) { badge = document.createElement('span'); badge.className = 'badge badge--20 badge--info'; badge.setAttribute('aria-hidden', 'true'); item.insertBefore(badge, status); }
        badge.textContent = `${n} 等待你输入`;
      } else if (badge) badge.remove();
      const txt = n ? `${n} 个任务等待你输入` : '';
      if (status.textContent !== txt) status.textContent = txt;
    } else {
      // 阶段 1 的设置类页面不挂 /events：不显示徽标、也不放 status 区域（foundation §1.4，D4）
      if (badge) badge.remove();
      if (status) status.remove();
    }
    for (const el of $$('[data-wb-only]')) el.hidden = !wb;
  }

  // ------------------------------------------------------------------ 侧栏：「项目」分区筛选（状态单选菜单 + 可移除的筛选 chip）
  function renderFilterUi() {
    const btn = $('[data-menu="filter"]');
    btn.dataset.tip = `按状态筛选任务：${P.filterLabel(ui.filter)}`;
    btn.removeAttribute('title');
    const chips = $('#filter-chips');
    if (ui.filter === 'all' || ui.loading) { chips.hidden = true; chips.innerHTML = ''; return; }
    chips.hidden = false;
    const label = P.filterLabel(ui.filter);
    chips.innerHTML = `<span class="chip chip--removable">${esc(label)}<button class="chip__remove" type="button" aria-label="移除筛选：${esc(label)}" data-tip="移除筛选" data-action="clear-filter" data-fk="filter-chip"><span class="icon i-x" aria-hidden="true"></span></button></span>`;
  }
  const matchesFilter = (P.matchesFilter = (t) => ui.filter === 'all' || (STATE[t.state] && STATE[t.state].filter === ui.filter));

  // ------------------------------------------------------------------ 侧栏：树（标记与 P1 / P2 / P6 静态稿逐字相同；读屏名称按 F13 / F14 补全；过程行照 f-lch-startup-01 / f-sbx-destroy-01）
  function treeOrder() {
    // v1 规则（selectProjectTaskTree）：组间按项目顺序，当前项目置顶——F6：置顶的是 ui.pinned（树里点的不重排）
    const order = world.projects.map((p) => p.id);
    const pin = ui.pinned;
    if (pin && order.includes(pin)) { order.splice(order.indexOf(pin), 1); order.unshift(pin); }
    return order;
  }
  P.treeOrder = treeOrder;
  // 启动四格（展示序：初始化 → 拉取镜像 → 准备代码副本 → 启动运行环境）；后端状态 → 格（Q-LCH-02 默认 C：与实现一致，格按展示下标判）
  P.PHASES = ['初始化', '拉取镜像', '准备代码副本', '启动运行环境'];
  P.PHASE_OF = { pending: 0, 'preparing-workspace': 2, creating: 1, starting: 3 };
  P.PHASE_PCT = { pending: 20, 'preparing-workspace': 40, creating: 60, starting: 80 };
  const live = (since) => `<span data-live-since="${since}">${P.fmtDur(P.clock.now() - since)}</span>`;
  P.liveSince = live;
  function taskSub(t) {
    switch (t.state) {
      case 'waiting': return `活跃于 ${esc(t.active)} · <span class="tone-waiting">等待你输入</span>`;
      case 'running': return `活跃于 ${esc(t.active)}`;
      case 'idle': return `活跃于 ${esc(t.active)} · 空闲`;
      case 'error': return `<span class="${t.code === 'TIMEOUT' ? 'tone-timeout' : 'tone-error'}">${esc(t.reason)}</span>`;
      case 'preparing': case 'starting': return `准备中 · ${esc(P.PHASES[P.PHASE_OF[t.status] || 0])}`;
      case 'stuck': return `<span class="tone-stuck">可能卡住 · ${t.observed === false ? live(t.watchSince) : live(t.since)} 无进展</span>`;
      case 'stopping': return '停止中…';
      case 'destroying': return '删除中…';
      default: return '已停止';
    }
  }
  P.taskSub = taskSub;
  function treeTask(t) {
    const s = STATE[t.state];
    const cur = ui.route.view === 'task' && ui.route.taskId === t.id;
    const removing = t.state === 'destroying';
    const menuName = `${t.name} 的任务菜单${removing ? '（删除中）' : ''}`;
    const dotLabel = removing ? '删除中' : s.word;
    return `<li class="tree-task${cur ? ' is-current' : ''}${removing ? ' is-removing' : ''}"><button class="tree-task__main" type="button"${cur ? ' aria-current="true"' : ''}${removing ? ' disabled' : ''} data-action="open-task" data-task="${t.id}" data-fk="tt:${t.id}"><span class="status-dot status-dot--${s.dot}" role="img" aria-label="${dotLabel}"></span><span class="tree-task__name">${esc(t.name)}</span></button><button class="btn btn--tertiary btn--24 btn--icon tree-task__more" type="button" aria-label="${esc(menuName)}" data-tip="${esc(menuName)}" aria-haspopup="menu" aria-expanded="false" data-menu="task" data-task="${t.id}" data-fk="tm:${t.id}"><span class="icon i-ellipsis" aria-hidden="true"></span></button><p class="tree-task__sub">${taskSub(t)}</p></li>`;
  }
  function projectBadge(p, size) {
    const cls = size === 20 ? 'badge badge--20' : 'badge';
    if (p.status === 'failed') return `<span class="${cls} badge--fail">克隆失败</span>`;
    if (p.status === 'cloning') return `<span class="${cls} badge--warn">克隆中</span>`;
    return '';
  }
  P.projectBadge = projectBadge;
  function renderTree() {
    const tree = $('#tree');
    if (ui.loading) {
      tree.setAttribute('aria-busy', 'true');
      tree.innerHTML = $('#tpl-loading-tree').innerHTML;
      return;
    }
    tree.removeAttribute('aria-busy');
    let html = '';
    let groups = 0;
    for (const pid of treeOrder()) {
      const p = proj(pid);
      const all = tasksOf(pid);
      const vis = all.filter(matchesFilter);
      if (ui.filter !== 'all' && !vis.length) continue; // 过滤后没有任务的组整组不渲染（g1-03）
      groups++;
      const open = !!ui.expanded[pid];
      const cur = ui.route.view === 'project' && ui.route.projectId === pid;
      // 组计数：任务数（删除中的行还在，移除时才减；克隆中的项目计数位也写任务数，consistency ①）
      const count = ui.filter === 'all' ? all.length : vis.length;
      const hasTasks = all.length > 0;
      const canExpand = hasTasks || p.status === 'ready'; // F13③ / REQ-PRJ-011：没就绪、也没有任务的项目展开了什么也没有——折叠箭头不可用并说原因
      const toggleName = `${open ? '收起' : '展开'} ${p.name}`;
      const toggle = canExpand
        ? `<button class="tree-project__toggle" type="button" aria-label="${esc(toggleName)}" aria-expanded="${open}" data-tip="${esc(toggleName)}" data-action="toggle-project" data-project="${pid}" data-fk="pt:${pid}"><span class="icon i-chevron-down" aria-hidden="true"></span></button>`
        : `<button class="tree-project__toggle" type="button" aria-label="${esc(`展开 ${p.name}`)}" aria-expanded="false" aria-disabled="true" data-reason="${p.status === 'failed' ? '克隆失败，分组里还没有内容' : '正在克隆，分组里还没有内容'}" data-fk="pt:${pid}"><span class="icon i-chevron-down" aria-hidden="true"></span></button>`;
      // F14：计数带单位、状态写进名称（读屏念「acme-web，7 个任务」）；F13②：承担折叠的项目名按钮同步 aria-expanded
      const selName = `${p.name}${p.status === 'failed' ? '，克隆失败' : p.status === 'cloning' ? '，克隆中' : ''}，${ui.filter === 'all' ? `${count} 个任务` : `${count} 个${P.filterLabel(ui.filter)}的任务`}`;
      const menuName = `${p.name} 的项目菜单`;
      html += `<section class="tree-group"><div class="tree-project${cur ? ' is-current' : ''}">`
        + toggle
        + `<button class="tree-project__select" type="button"${cur ? ' aria-current="true"' : ''}${hasTasks ? ` aria-expanded="${open}"` : ''} aria-label="${esc(selName)}" data-action="select-project" data-project="${pid}" data-fk="ps:${pid}"><span class="icon i-folder" aria-hidden="true"></span><span class="tree-project__name">${esc(p.name)}</span>${projectBadge(p, 20)}<span class="tree-project__count">${count}</span></button>`
        + `<button class="btn btn--tertiary btn--24 btn--icon tree-project__menu" type="button" aria-label="${esc(menuName)}" data-tip="${esc(menuName)}" aria-haspopup="menu" aria-expanded="false" data-menu="project" data-project="${pid}" data-fk="pm:${pid}"><span class="icon i-ellipsis" aria-hidden="true"></span></button>`
        + `</div>`;
      if (open && vis.length) html += `<ul class="tree-group__tasks">${vis.map(treeTask).join('')}</ul>`;
      // 只对就绪的项目给「发起第一个任务」（REQ-PRJ-011 / AC-LCH-001.4：不复现未就绪空组的幽灵弹层）
      // 第四段（F-WB-LIVE / REQ-WB-014）：离线时这个入口也置灰并说原因（只置灰、不隐藏；实现漏了这一处，原型照 AC-WB-014.5 做全）
      else if (open && !all.length && p.status === 'ready') {
        const why = P.newTaskBlocked(p);
        html += `<button class="tree-empty" type="button" title="在 ${esc(p.name)} 中发起第一个任务"${why ? ` aria-disabled="true" data-reason="${esc(why)}"` : ''} data-action="new-task" data-project="${pid}" data-fk="pe:${pid}">发起第一个任务<span class="icon icon--14 i-arrow-right" aria-hidden="true"></span></button>`;
      }
      html += `</section>`;
    }
    // 筛选后一条都不剩时说一句；一个项目都没有（初始化向导刚完成的新实例）时树就是空的（欢迎态归 F-WB-WELCOME）
    if (!groups) html = world.projects.length ? `<p class="proto-tree-empty" role="status">没有${esc(P.filterLabel(ui.filter))}的任务</p>` : '';
    if (tree.dataset.html !== html) { tree.innerHTML = html; tree.dataset.html = html; }
  }
  P.renderTree = renderTree;

  // ------------------------------------------------------------------ 主区
  // 模板：静态稿同源拷贝（index.html 的 <template>）。拷来的稿件带着静态态（.is-focus / .is-hover / 稿件定位类 / role="alert"…），克隆后统一清一遍
  P.cloneTpl = function cloneTpl(id) { return document.importNode($(`#${id}`).content, true); };
  P.fromTpl = function fromTpl(id, { keepRoles = false } = {}) {
    const frag = P.cloneTpl(id);
    const box = document.createElement('div');
    box.appendChild(frag);
    for (const el of $$('.is-focus, .is-hover, .is-open', box)) el.classList.remove('is-focus', 'is-hover', 'is-open');
    // F13⑤：随视图插入的静态内容不带 role="alert" / "status"（单页应用里每次插入都会被当成实时消息念出来），结果改由 announce() 播报
    if (!keepRoles) for (const el of $$('[role="alert"], [role="status"]', box)) { if (!el.matches('.toast, .toast-region *')) el.removeAttribute('role'); el.removeAttribute('aria-live'); }
    return box.firstElementChild;
  };
  // PF-05：纯图标控件的提示改成 v2 tooltip——title 挪进 data-tip（可访问名称本来就在 aria-label 里），不再同时出系统原生提示
  const TIP_SEL = '.btn--icon[title], .segmented__item--icon[title], .ttab__close[title], .tree-project__toggle[title], .chip__remove[title]';
  function upgradeTips(root) {
    for (const el of $$(TIP_SEL, root)) {
      if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', el.title);
      el.dataset.tip = el.title;
      el.removeAttribute('title');
    }
  }
  P.upgradeTips = upgradeTips;
  // 主区模板的选择：先问各流程登记的 P.mainTpl，最后兜底（总览 / 设置页）
  function resolveTpl(r) {
    if (ui.loading) return P.ask('loading.tpl', r) || 'tpl-loading'; // 设置页直接打开时由各流程给出本页模板（骨架在 'loading:wired' 里换上）
    for (const fn of P.mainTpl) { const id = fn(r); if (id) return id; }
    if (r.view === 'credentials' || r.view === 'images' || r.view === 'system') return `tpl-${r.view}`;
    return 'tpl-overview';
  }
  P.resolveTpl = resolveTpl;
  function renderMain(force) {
    const host = $('#shell-main');
    const key = ui.loading ? 'loading' : viewKey();
    const tplId = resolveTpl(ui.route);
    if (!force && host.dataset.view === key && host.dataset.tpl === tplId) { refreshMain(); return; }
    host.dataset.view = key;
    host.dataset.tpl = tplId;
    host.classList.toggle('proto-loading', ui.loading && tplId === 'tpl-loading');
    host.textContent = '';
    host.appendChild(P.cloneTpl(tplId));
    const main = $('#main', host);
    if (main) main.setAttribute('tabindex', '-1');
    if (ui.loading) { if (tplId !== 'tpl-loading') { upgradeTips(host); P.emit('loading:wired', tplId, main); } return; }
    // F13⑤：从补全稿拷来的结果卡 / 进度块带着 role="alert" / "status"（静态稿整页加载时不会播报）；在单页应用里随视图插入会被当成实时消息念出来、
    // 打断「已打开 …」——视图插入时去掉，结果改由 announce() 播报（试点拷来的 P3 / P5 页不动，P7 在 wireImages 里自己去）
    if (tplId.startsWith('tpl-task-') || tplId.startsWith('tpl-project-')) for (const el of $$('[role="alert"], [role="status"]', main)) { el.removeAttribute('role'); el.removeAttribute('aria-live'); }
    upgradeTips(host);
    // 局部交互的监听挂在这次新建的 <main> 上（视图换掉时跟着一起丢掉，不在常驻的 #shell-main 上越积越多）
    const v = P.views[tplId];
    if (v && v.wire) v.wire(main, ui.route);
    P.emit('view:wired', tplId, main, ui.route);
    refreshMain();
  }
  // 数据变了（销毁、切标签、清屏、时钟推进…）时只重画受影响的槽，不重建整个视图（输入框里打的字、滚动位置都留着）
  function refreshMain() {
    if (ui.loading || P.gated) return;
    const host = $('#shell-main');
    const active = document.activeElement;
    const afk = active && active.getAttribute && active.getAttribute('data-fk');
    const focusInMain = !!(active && host.contains(active));
    const r = ui.route;
    const slot = (name) => $(`[data-slot="${name}"]`, host);
    const notice = slot('notice');
    if (notice) notice.innerHTML = ui.notice && ui.notice.key === viewKey() ? noticeHtml(ui.notice, r.view === 'overview') : '';
    const hdr = slot('header');
    if (hdr && (r.view === 'task' || r.view === 'project')) {
      const t = r.view === 'task' ? task(r.taskId) : null;
      const p = proj(t ? t.project : r.projectId);
      const html = wbHeader(t ? 'task' : 'project', p, t);
      if (hdr.dataset.html !== html) { hdr.innerHTML = html; hdr.dataset.html = html; }
    }
    const v = P.views[host.dataset.tpl];
    if (v && v.refresh) v.refresh(host, r);
    P.emit('main:refreshed', host, r);
    upgradeTips(host);
    // 第五段（R1-01）：顶栏 / 主区的槽被就地换掉（拉取中把顶栏 [拉取最新代码] 换成「正在拉取…」等）——焦点按 data-fk 找回，不落到 body
    if (active && active !== document.body && !active.isConnected && focusLost()) refocus(afk, focusInMain);
  }
  P.refreshMain = refreshMain;
  // 页内提示（PF-07）：总览里是内容顶部的页内提示（.note，随内容滚动）；终端视图与结果卡视图里叠在主区右上角（不占布局）。
  // 进行中（删除中…）带转圈、没有 ×；完成态带 ×；中性色调。
  function noticeHtml(n, inline) {
    // 第四段（F-WB-ROUTE）：「找不到…」这一句用 f-wb-route-01 的页内提示（tpl-wb-notice；第五段起稿件改用共享件 .page-notice：中性、只有标题、正文色、行尾关闭；不带「（原型：…）」尾巴）
    if (n.kind === 'missing') {
      const el = P.fromTpl('tpl-wb-notice');
      el.classList.add('proto-notice');
      $('.note__title', el).textContent = n.title;
      const b = $('.note__end .btn', el);
      b.removeAttribute('title'); // 原型的提示走 data-tip（同其余图标按钮）
      Object.assign(b.dataset, { tip: '关闭提示', action: 'close-notice', fk: 'notice-close' });
      return el.outerHTML;
    }
    const icon = n.progress ? '<span class="icon icon--spin i-loader-circle" aria-hidden="true"></span>' : `<span class="icon ${n.icon || 'i-circle-check'}" aria-hidden="true"></span>`;
    const close = n.progress || n.closable === false ? '' : `<div class="note__end"><button class="btn btn--tertiary btn--24 btn--icon" type="button" aria-label="关闭提示" data-tip="关闭提示" data-action="close-notice" data-fk="notice-close"><span class="icon i-x" aria-hidden="true"></span></button></div>`;
    const proto = n.protoNote ? `（${esc(n.protoNote)}）` : '';
    const text = n.textHtml ? `<span class="note__text">${n.textHtml}${proto}</span>` : n.text ? `<span class="note__text">${esc(n.text)}${proto}</span>` : '';
    const body = `${icon}<div class="note__body"><span class="note__title">${esc(n.title)}</span>${text}</div>${close}`;
    const extra = n.progress ? ' proto-notice--progress' : '';
    return inline
      ? `<div class="note note--neutral page-notice proto-notice proto-notice--inline${extra}">${body}</div>` // 第五段（R2-27）：共享件 .page-notice
      : `<div class="note--neutral proto-notice proto-notice--float${extra}">${body}</div>`;
  }
  P.setNotice = (n) => { ui.notice = n; refreshMain(); };

  // ---- 工作台顶栏（与 P1 / P6 / f-prj-* / f-lch-* / f-sbx-* 的标记一致）
  const PULL_TIP = (P.PULL_TIP = '只更新项目里的这份代码。已经建好的任务用的是各自建的时候复制的那一份，不会跟着变；下次新建任务才会用到刚拉下来的代码。');
  // 不能发起任务的原因（顶栏「新任务」、新建任务下拉）：先问钩子（离线等，F-WB-LIVE 接），再按项目状态分两句（REQ-PRJ-016）
  P.newTaskBlocked = (p) => {
    const r = P.ask('newTask.blocked', p);
    if (r) return r;
    if (!p) return world.projects.length ? '先在左侧选中一个项目' : '先新建一个项目'; // 一个项目都没有时「先选中」做不到（REQ-WB-001，第四段）
    if (p.status === 'cloning') return '项目还在克隆，克隆完成后可发起';
    if (p.status === 'failed') return '克隆失败的项目不能发起任务：先重试克隆或改为空项目';
    return null;
  };
  P.projectInfoLabel = (p) => (p.source === 'empty'
    ? `空项目（没有关联仓库） · 创建于 ${p.createdAt}`
    : `仓库 ${p.repo} · 分支 ${p.branch || '远端默认分支'} · 代码体积 ${p.size} · 最后拉取 ${p.pulledFull || p.pulled}`);
  function wbHeader(kind, p, t) {
    const projCrumb = (current) => `<li class="crumbs__item"><button class="crumb" type="button"${current ? ' aria-current="page"' : ''} aria-haspopup="menu" aria-expanded="false" aria-label="切换项目（当前 ${esc(p.name)}）" title="切换项目；菜单首项：在左侧树中定位当前项目" data-menu="crumb-project" data-fk="crumb-project"><span class="icon i-folder" aria-hidden="true"></span><span class="crumb__label">${esc(p.name)}</span><span class="icon crumb__switch i-chevrons-up-down" aria-hidden="true"></span></button></li>`;
    let h1, crumbs, badge = '';
    if (kind === 'task') {
      h1 = `工作台：${p.name} / ${t.name}`;
      crumbs = projCrumb(false)
        + `<li class="crumbs__item" aria-hidden="true"><span class="icon crumbs__sep i-slash"></span></li>`
        + `<li class="crumbs__item"><button class="crumb" type="button" aria-current="page" aria-haspopup="menu" aria-expanded="false" aria-label="切换任务（当前 ${esc(t.name)}）" title="切换任务" data-menu="crumb-task" data-fk="crumb-task"><span class="crumb__label">${esc(t.name)}</span><span class="icon crumb__switch i-chevrons-up-down" aria-hidden="true"></span></button></li>`;
      const s = STATE[t.state];
      badge = `<span class="badge badge--${s.badge}"><span class="status-dot status-dot--${s.dot}" aria-hidden="true"></span><span class="badge__label">${s.word}</span></span>`;
    } else {
      h1 = `工作台：${p.name}`;
      crumbs = projCrumb(true);
      badge = projectBadge(p, 24);
    }
    let actions = '';
    const blocked = P.newTaskBlocked(p);
    if (p.status === 'ready') {
      const info = P.projectInfoLabel(p);
      const open = !!(P.popover && P.popover.isOpenFor && P.popover.isOpenFor('pi'));
      const exp = ` aria-expanded="${open}" aria-controls="pi"`;
      if (p.source === 'empty') {
        // 空项目：chip 写「空项目」（i-info），不出「拉取最新代码」（f-prj-info-02 / f-prj-clone-07）
        actions += `<button class="chip header__hide-below-960${open ? ' is-open' : ''}" type="button" aria-haspopup="dialog"${exp} aria-label="项目信息：${esc(info)}" title="${esc(info)}" data-action="project-info" data-fk="h-chip"><span class="icon i-info" aria-hidden="true"></span>空项目</button>`
          + `<button class="btn btn--tertiary btn--32 btn--icon header__show-below-960${open ? ' is-open' : ''}" type="button" aria-haspopup="dialog"${exp} aria-label="项目信息：${esc(info)}" data-tip="项目信息" data-action="project-info" data-fk="h-info"><span class="icon i-info" aria-hidden="true"></span></button>`;
      } else {
        const pulling = !!ui.pulling[p.id];
        actions += `<button class="chip header__hide-below-960${open ? ' is-open' : ''}" type="button" aria-haspopup="dialog"${exp} aria-label="项目信息：${esc(info)}" title="${esc(info)}" data-action="project-info" data-fk="h-chip"><span class="icon i-git-branch" aria-hidden="true"></span>${esc(p.branch || '远端默认分支')}</button>`
          + `<button class="btn btn--tertiary btn--32 btn--icon header__show-below-960${open ? ' is-open' : ''}" type="button" aria-haspopup="dialog"${exp} aria-label="项目信息：${esc(info)}" data-tip="项目信息" data-action="project-info" data-fk="h-info"><span class="icon i-info" aria-hidden="true"></span></button>`
          + (pulling
            ? `<button class="btn btn--secondary btn--32 header__hide-below-800 is-loading" type="button" aria-disabled="true" aria-busy="true" title="${PULL_TIP}" aria-label="正在拉取最新代码" data-fk="h-pull"><span class="icon icon--spin i-loader-circle" aria-hidden="true"></span>正在拉取…</button>` // 第五段（R1-01）：进行中不用原生 disabled，焦点留在它上面
            : `<button class="btn btn--secondary btn--32 header__hide-below-800" type="button" title="${PULL_TIP}" aria-label="拉取最新代码。${PULL_TIP}" data-action="pull" data-project="${p.id}" data-fk="h-pull"><span class="icon i-refresh-cw" aria-hidden="true"></span>拉取最新代码</button>`);
      }
      // 创建入口规则（foundation §1.4）：同屏主区另有实心「新任务」（P6 空态）时，顶栏这一处降为次按钮
      if (blocked) actions += `<button class="btn ${kind === 'project' ? 'btn--secondary' : 'btn--primary'} btn--32" type="button" aria-haspopup="dialog" aria-disabled="true" aria-describedby="nt-why" title="${esc(blocked)}" data-reason="${esc(blocked)}" data-fk="h-new"><span class="icon i-plus" aria-hidden="true"></span><span class="btn__label">新任务</span></button><span class="u-sr-only" id="nt-why">${esc(blocked)}</span>`;
      else actions += `<button class="btn ${kind === 'project' ? 'btn--secondary' : 'btn--primary'} btn--32" type="button" aria-haspopup="dialog" data-action="new-task" data-fk="h-new"><span class="icon i-plus" aria-hidden="true"></span><span class="btn__label">新任务</span></button>`;
    } else {
      // 克隆中 / 克隆失败：不出 chip / ⓘ / 拉取；「新任务」不可用并说原因（两句，REQ-PRJ-016；f-prj-clone-01 / 04）
      actions += `<button class="btn btn--primary btn--32" type="button" aria-haspopup="dialog" aria-disabled="true" aria-describedby="nt-why" title="${esc(blocked)}" data-reason="${esc(blocked)}" data-fk="h-new"><span class="icon i-plus" aria-hidden="true"></span><span class="btn__label">新任务</span></button><span class="u-sr-only" id="nt-why">${esc(blocked)}</span>`;
    }
    actions += `<button class="btn btn--tertiary btn--32 btn--icon" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="更多操作" data-tip="更多操作" data-menu="more" data-fk="h-more"><span class="icon i-ellipsis" aria-hidden="true"></span></button>`;
    return `<h1 class="u-sr-only">${esc(h1)}</h1><div class="header__lead"><nav class="u-min-w-0" aria-label="当前位置"><ol class="crumbs">${crumbs}</ol></nav>${badge}</div><div class="header__actions">${actions}</div>`;
  }
  P.wbHeader = wbHeader;

  // ------------------------------------------------------------------ 菜单（r12、行 36、fill-hover；键盘：↑ ↓ Home End Enter Space Esc Tab）
  // PF-04：指针打开不预选（焦点在菜单容器上，↓ 到第一项、↑ 到最后一项）；悬停即把焦点移过去——悬停与键盘共用一个高亮
  const menu = (P.menu = { el: null, trigger: null, actions: [] });
  let menuNoteSeq = 0;
  P.menuItem = function menuItem({ label, icon, end, danger, radio, checked, act, nohook, disabled, dot, describedBy, reason, fk }) {
    const i = menu.actions.push({ act, nohook, reason }) - 1;
    const role = radio ? 'menuitemradio' : 'menuitem';
    const cls = `menu__item${danger ? ' menu__item--danger' : ''}`;
    const lead = dot ? `<span class="status-dot status-dot--${dot}" aria-hidden="true"></span>` : icon ? `<span class="icon ${icon}" aria-hidden="true"></span>` : '';
    return `<button class="${cls}" type="button" role="${role}"${radio ? ` aria-checked="${!!checked}"` : ''} tabindex="-1" data-mi="${i}"${fk ? ` data-mfk="${fk}"` : ''}${nohook ? ' data-nohook' : ''}${disabled ? ' aria-disabled="true"' : ''}${describedBy ? ` aria-describedby="${describedBy}"` : ''}>${lead}${esc(label)}${end ? `<span class="menu__end">${esc(end)}</span>` : ''}</button>`;
  };
  // F13④：菜单里的说明句属于某一项——那一项 aria-describedby 指过来，句子本身 aria-hidden（菜单里只放菜单项、分组、分隔）
  P.menuNote = (text) => { const id = `proto-mn-${++menuNoteSeq}`; return { id, html: `<p class="menu__note" id="${id}" aria-hidden="true">${esc(text)}</p>` }; };
  P.SEP = '<div class="menu__sep" role="separator"></div>';
  let menuGroupSeq = 0;
  P.menuGroup = (label, inner) => { const id = `proto-mg-${++menuGroupSeq}`; return `<div class="menu__label" id="${id}">${esc(label)}</div><div role="group" aria-labelledby="${id}">${inner}</div>`; };
  P.menuLabel = (text) => `<div class="menu__label" aria-hidden="true">${esc(text)}</div>`; // 与菜单的可访问名称重复，读屏不念第二遍
  function buildMenu(kind, trigger) {
    menu.actions = [];
    const fn = P.menus[kind];
    return fn ? fn(trigger) : null;
  }
  function openMenu(trigger, viaKeyboard, focusLast) {
    closeMenu(false, { instant: true });
    hideTip();
    const def = buildMenu(trigger.dataset.menu, trigger);
    if (!def) return;
    const el = document.createElement('div');
    el.className = 'menu proto-menu';
    el.id = 'proto-menu';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', def.label);
    el.tabIndex = -1;
    el.innerHTML = def.html;
    // 菜单里只读的说明行（2026-10-04：任务菜单最上面的「镜像：…」，AC-LCH-017.5）——不是菜单项、不进 Tab 顺序；读屏经菜单的 aria-describedby 念到它
    const desc = el.querySelector('[data-menu-desc]');
    if (desc) el.setAttribute('aria-describedby', desc.id);
    // 菜单挂在触发器所在的地标里（侧栏 aside 或 main；顶栏的菜单挂进 main）：读屏按地标浏览时菜单不落在地标外（axe region）。
    // 用 position: fixed 定位在视口上；这两个容器都没有 transform / containment，不会改变 fixed 的参照
    const host = trigger.closest('#sidebar') || $('#main') || $('#frame');
    host.appendChild(el);
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', 'proto-menu');
    trigger.classList.add('is-open');
    menu.el = el; menu.trigger = trigger;
    placeMenu(el, trigger, def.align);
    if (viaKeyboard) {
      const items = menuItems();
      const checked = items.find((i) => i.getAttribute('aria-checked') === 'true');
      const first = focusLast ? items[items.length - 1] : (checked || items[0]);
      if (first) first.focus({ preventScroll: true });
    } else el.focus({ preventScroll: true });
  }
  P.openMenu = openMenu;
  function placeMenu(el, trigger, align) {
    const r = trigger.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = align === 'end' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8 && r.top - 4 - h >= 8) top = r.top - 4 - h; // 下面放不下就开在上面（侧栏底部的「外观」）
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }
  const menuItems = () => (menu.el ? $$('[role^="menuitem"]', menu.el).filter((i) => i.getAttribute('aria-disabled') !== 'true') : []);
  // F8：焦点在菜单里时，不管因为什么关菜单（⌘B、滚动、窗口变化、开面板）都把焦点还给触发器（触发器不在了就给主区）
  function closeMenu(restoreFocus, opts) {
    if (!menu.el) return;
    const el = menu.el, trig = menu.trigger;
    const hadFocus = el === document.activeElement || el.contains(document.activeElement);
    menu.el = null; menu.trigger = null;
    if (trig) {
      trig.setAttribute('aria-expanded', 'false');
      trig.removeAttribute('aria-controls');
      trig.classList.remove('is-open');
    }
    if (restoreFocus || hadFocus) {
      if (isShown(trig)) trig.focus({ preventScroll: true });
      else if (hadFocus) focusMain();
    }
    el.removeAttribute('role');
    leave(el, opts && opts.instant);
  }
  P.closeMenu = closeMenu;
  function runMenuItem(btn) {
    const a = menu.actions[Number(btn.dataset.mi)];
    if (!a) return;
    if (a.nohook) {
      // 安全网：漏接的菜单项（nohook）不关菜单，就在这一项的尾部出 2 秒「原型：未接入」（第四段起没有这样的项，守卫组盯着）
      let end = btn.querySelector('.proto-nohook-end');
      if (!end) { end = document.createElement('span'); end.className = 'menu__end proto-nohook-end'; btn.appendChild(end); }
      end.textContent = NOHOOK;
      announce(NOHOOK);
      setTimeout(() => { if (end.isConnected) end.remove(); }, 2000);
      return;
    }
    const ret = menu.trigger;
    closeMenu(true);
    if (a.act) a.act(ret);
  }

  // ------------------------------------------------------------------ 模态（对话框、命令面板）：焦点进入、Tab 循环、Esc 关闭、关闭后焦点回到触发点；底层 inert
  const modals = (P.modals = []);
  function setInert(on) {
    // 口令门 / 启动检查 / 初始化向导盖着时外壳不在 DOM 里（只剩那一屏与角落浮标）：缺的跳过
    for (const el of [$('#shell'), $('.skip-link'), $('#proto-float'), $('#proto-gate'), $('#proto-boot'), $('#proto-wiz')]) { if (!el) continue; if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert'); }
    P.emit('inert', on);
  }
  P.setInert = setInert;
  // html：字符串或元素；opts：kind、cls（遮罩类）、returnTo、initialFocus（选择器）、onClose、busy（m.busy 为真时 Esc / 遮罩 / 关闭都不关，创建中 / 删除中）
  function openModal(html, opts) {
    // F8：从菜单里打开（菜单项、菜单开着时按 ⌘K）——关掉之后焦点回菜单的触发器，不回已经被删掉的菜单项
    let ret = opts.returnTo || document.activeElement;
    if (menu.el && ret && (ret === menu.el || menu.el.contains(ret))) ret = menu.trigger || ret;
    // 第五段（R1-07）：从浮层卡里打开（浮层开着时按 ⌘K）——浮层会随遮罩收起，关掉之后焦点回浮层的触发器，不回已经不在的浮层控件
    const popEl = P.popover && P.popover.el;
    if (popEl && ret && (ret === popEl || popEl.contains(ret))) ret = P.popover.trigger || ret;
    closeMenu(false, { instant: true });
    hideTip();
    for (const o of $$('.overlay[data-state="closed"]')) o.remove(); // 上一个还在出场的浮层：直接收掉
    const overlay = document.createElement('div');
    overlay.className = `overlay${opts.cls ? ' ' + opts.cls : ''}`;
    if (typeof html === 'string') overlay.innerHTML = html; else overlay.appendChild(html);
    $('#frame').appendChild(overlay);
    const m = { overlay, box: overlay.firstElementChild, kind: opts.kind, returnTo: ret, returnFk: ret && ret.getAttribute ? ret.getAttribute('data-fk') : null, onClose: opts.onClose, openedAt: performance.now(), busy: false };
    modals.push(m);
    setInert(true);
    // F5：点遮罩关闭只认「在遮罩上按下、又在遮罩上松开」的单击；双击入口时第二下落在刚出现的遮罩上，不算（detail = 2），刚打开 250ms 内的也不算
    let pressOnOverlay = false;
    overlay.addEventListener('mousedown', (e) => {
      if (e.target !== overlay) { pressOnOverlay = false; return; }
      e.preventDefault(); // 焦点留在对话框里
      pressOnOverlay = e.detail <= 1 && performance.now() - m.openedAt > 250;
    });
    overlay.addEventListener('click', (e) => { if (e.target === overlay && pressOnOverlay) { pressOnOverlay = false; closeModal(m); } });
    upgradeTips(overlay);
    P.focusInto(m.box, opts.initialFocus);
    return m;
  }
  P.openModal = openModal;
  P.focusInto = (box, sel) => { const f = (sel && $(sel, box)) || focusables(box)[0] || box; if (f === box && !box.hasAttribute('tabindex')) box.tabIndex = -1; f.focus({ preventScroll: true }); };
  function closeModal(m, opts) {
    if (!m) return;
    if (m.busy && !(opts && opts.force)) return; // 创建中 / 删除中：Esc、点遮罩、关闭都不关（REQ-LCH-010、REQ-PRJ-043）
    const restore = !opts || opts.restoreFocus !== false;
    const i = modals.indexOf(m);
    if (i < 0) return;
    modals.splice(i, 1);
    if (!modals.length) setInert(false);
    // 出场期间对话框不再算「开着」：去掉 role / aria-modal / data-dialog（测试与读屏都按这些认）
    const box = m.box;
    if (box) { box.removeAttribute('role'); box.removeAttribute('aria-modal'); if (box.dataset.dialog) { box.dataset.dialogClosed = box.dataset.dialog; delete box.dataset.dialog; } }
    if (m.onClose) m.onClose();
    if (!restore) focusPending = true; // 第五段（R1-06）：调用方说「别还焦点」（紧接着换路由 / 换整屏），下一次 render 兜底给主区
    if (restore) {
      let r = m.returnTo;
      if ((!r || !r.isConnected) && m.returnFk) r = $(`[data-fk="${CSS.escape(m.returnFk)}"]`);
      if (isShown(r) && !r.disabled) r.focus({ preventScroll: true });
      else focusMain();
    }
    leave(m.overlay, opts && opts.instant);
  }
  P.closeModal = closeModal;
  const topModal = (P.topModal = () => modals[modals.length - 1]);
  function focusables(root) {
    const all = $$('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])', root)
      .filter((el) => el.getClientRects().length && !el.closest('[hidden]') && !el.closest('fieldset:disabled'));
    // 单选组只算一个 Tab 停靠点（选中的那个；都没选时第一个）
    const seen = new Set();
    return all.filter((el) => {
      if (!(el instanceof HTMLInputElement) || el.type !== 'radio') return true;
      if (seen.has(el.name)) return false;
      const groupEls = all.filter((x) => x instanceof HTMLInputElement && x.type === 'radio' && x.name === el.name);
      const stop = groupEls.find((x) => x.checked) || groupEls[0];
      if (stop === el) { seen.add(el.name); return true; }
      return false;
    });
  }
  P.focusables = focusables;

  // ------------------------------------------------------------------ 第五段（W4，评审 R1-03）：「进行中」的按钮
  // 按下后进入进行中（创建中… / 保存中… / 删除中… / 正在拉取…）的那颗按钮不用原生 disabled——Chromium 会把焦点甩到 body：模态里下一次 Tab
  // 被拉回第一个控件、非模态里从页首重来，读屏用户丢了上下文。改成 aria-disabled + aria-busy：外观同禁用（components-v2 .btn[aria-disabled="true"]），
  // 焦点留在原地（键盘聚焦时照样画焦点环）；点击 / 回车 / 空格、所在表单被回车提交，都在捕获阶段直接忽略（先于各流程挂在弹层或表单上的监听）。
  // 结束后由各流程换回（或整段重画——重画后焦点按 data-fk 找回，见 render / refreshMain）。「条件不满足」的禁用（没填名称、没选 Agent…）不在这里，照旧
  P.busyHtml = (label) => `<span class="icon icon--spin i-loader-circle" aria-hidden="true"></span>${esc(label)}`;
  P.setBusy = function setBusy(btn, on, html) {
    if (!btn) return;
    if (on) {
      if (btn.disabled) btn.disabled = false;
      btn.setAttribute('aria-disabled', 'true'); btn.setAttribute('aria-busy', 'true'); btn.classList.add('is-loading');
    } else if (btn.getAttribute('aria-busy') === 'true') {
      btn.removeAttribute('aria-busy'); btn.removeAttribute('aria-disabled'); btn.classList.remove('is-loading');
    }
    if (html != null) btn.innerHTML = html;
  };
  P.isBusy = (el) => !!(el && el.getAttribute && el.getAttribute('aria-busy') === 'true');
  document.addEventListener('click', (e) => {
    const b = e.target instanceof Element && e.target.closest('button[aria-busy="true"]');
    if (b) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (f instanceof HTMLFormElement && f.querySelector('button[type="submit"][aria-busy="true"]')) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // ------------------------------------------------------------------ tooltip（PF-05）：所有纯图标控件（[data-tip]）+ 图标轨里的导航（[data-rail-tip]，只在收起时出）
  // 悬停 400ms 出现、键盘聚焦立即出现；关掉后 300ms 内移到相邻的触发器只等 100ms（跳过延迟）；淡入 100ms ease-in；按下、Esc、滚动时收起
  const TIP_DELAY = 400, TIP_SKIP_DELAY = 100, TIP_SKIP_WINDOW = 300;
  let tipEl = null, tipTimer = 0, tipFor = null, tipHiddenAt = -1e9;
  const TIP_TARGET = '[data-tip], [data-rail-tip]';
  function tipTextOf(el) {
    if (el.hasAttribute('data-tip')) return el.dataset.tip;
    if (el.hasAttribute('data-rail-tip') && (ui.rail || MQ_NARROW.matches)) return el.dataset.railTip;
    return null;
  }
  function showTip(target) {
    hideTip();
    const text = tipTextOf(target);
    if (!text || !isShown(target) || menu.el) return;
    tipEl = document.createElement('div');
    tipEl.className = 'tooltip proto-tip';
    tipEl.setAttribute('aria-hidden', 'true'); // 文字与控件的可访问名称相同（快捷键另有 aria-keyshortcuts），读屏不念第二遍
    tipEl.innerHTML = esc(text) + (target.dataset.tipKbd ? `<span class="kbd">${esc(target.dataset.tipKbd)}</span>` : '');
    document.body.appendChild(tipEl);
    // 顶栏、终端栏这一带（视口上方 ~110px）的图标：提示放在下面，不盖住顶栏右侧的动作按钮；其余照 Geist 默认放上面
    placeFloating(tipEl, target, target.getBoundingClientRect().top < 110 ? 'below' : 'above');
    tipFor = target;
  }
  function hideTip() {
    clearTimeout(tipTimer);
    if (tipEl) { tipEl.remove(); tipEl = null; tipHiddenAt = performance.now(); }
    tipFor = null;
  }
  P.hideTip = hideTip;
  document.addEventListener('mouseover', (e) => {
    const t = e.target instanceof Element && e.target.closest(TIP_TARGET);
    if (!t || (e.relatedTarget instanceof Node && t.contains(e.relatedTarget)) || !tipTextOf(t)) return;
    clearTimeout(tipTimer);
    const delay = tipEl || performance.now() - tipHiddenAt < TIP_SKIP_WINDOW ? TIP_SKIP_DELAY : TIP_DELAY;
    tipTimer = setTimeout(() => showTip(t), delay);
  });
  document.addEventListener('mouseout', (e) => {
    const t = e.target instanceof Element && e.target.closest(TIP_TARGET);
    if (!t || (e.relatedTarget instanceof Node && t.contains(e.relatedTarget))) return;
    clearTimeout(tipTimer);
    if (tipFor === t && t !== document.activeElement) hideTip();
  });
  document.addEventListener('focusin', (e) => {
    const t = e.target instanceof Element && e.target.closest(TIP_TARGET);
    if (t && t.matches(':focus-visible') && tipTextOf(t)) { clearTimeout(tipTimer); showTip(t); }
    else if (tipEl) hideTip();
    checkFloat();
  });
  document.addEventListener('focusout', (e) => { if (tipFor && e.target === tipFor) hideTip(); setTimeout(checkFloat, 0); });

  // ------------------------------------------------------------------ 角落浮标（F7）：键盘焦点落到被它盖住的控件上时先藏起来（焦点进浮标自己时照常显示）
  function checkFloat() {
    const f = $('#proto-float');
    if (!f) return;
    const a = document.activeElement;
    let tuck = false;
    if (a && a !== document.body && !f.contains(a) && a.id !== 'main' && !a.closest('.overlay, .proto-menu')) {
      const r = a.getBoundingClientRect(), q = f.getBoundingClientRect();
      tuck = r.width > 0 && r.right + 4 > q.left && r.left - 4 < q.right && r.bottom + 4 > q.top && r.top - 4 < q.bottom;
    }
    f.classList.toggle('proto-float--tucked', tuck);
  }
  P.checkFloat = checkFloat;

  // ------------------------------------------------------------------ 事件：点击（统一代理）
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    // 菜单项
    const mi = t.closest('.proto-menu [data-mi]');
    if (mi) { e.preventDefault(); if (mi.getAttribute('aria-disabled') !== 'true') runMenuItem(mi); else { const a = menu.actions[Number(mi.dataset.mi)]; if (a && a.reason) hint(mi, a.reason); } return; }
    if (t.closest('.proto-menu')) return;
    if (t.closest('.overlay')) {
      // 对话框里的：有原因的禁用 → 说原因；动作 → 执行；漏接的（安全网）→「原型：未接入」
      const dis = t.closest('[aria-disabled="true"][data-reason]');
      if (dis) { e.preventDefault(); hint(dis, dis.dataset.reason); return; }
      const a = t.closest('[data-action]');
      if (a && P.actions[a.dataset.action]) { e.preventDefault(); P.actions[a.dataset.action](a, e); return; }
      const nh = t.closest('[data-nohook]');
      if (nh) { e.preventDefault(); hint(nh); }
      return;
    }
    // 跳到主区
    if (t.closest('[data-skip-link]')) { e.preventDefault(); focusMain(); return; }
    // 菜单触发器（键盘触发的 click 的 detail 是 0：焦点进首项；指针打开不预选，PF-04）
    const mt = t.closest('[data-menu]');
    if (mt) {
      e.preventDefault();
      if (mt.getAttribute('aria-disabled') === 'true' && mt.dataset.reason) { hint(mt, mt.dataset.reason); return; }
      if (menu.trigger === mt) closeMenu(true); else openMenu(mt, e.detail === 0);
      return;
    }
    // 有原因的禁用（项目没就绪时的「新任务」、窄屏的收起按钮、字号到头的 A− / A+、没内容的折叠箭头…）
    const dis = t.closest('[aria-disabled="true"][data-reason]');
    if (dis) { e.preventDefault(); hint(dis, dis.dataset.reason); return; }
    // 动作
    const a = t.closest('[data-action]');
    if (a) { e.preventDefault(); runAction(a, e); return; }
    if (P.ask('click', t, e)) return; // 流程自己处理的点击（返回 true 表示处理过）
    // 没接上的按钮与「#」链接（别的组还没接的）：就地提示，不弹窗
    const nh = t.closest('[data-nohook], #shell-main button, #shell-main a[href="#"], .sidebar button');
    if (nh && !nh.closest('.segmented[aria-label="状态过滤"]') && !nh.matches('[role="tab"]') && nh.getAttribute('aria-pressed') !== 'true' && !nh.closest('details > summary') && !nh.closest('.toast-region')) {
      e.preventDefault();
      hint(nh);
    }
  });
  function runAction(a, e) {
    const fn = P.actions[a.dataset.action];
    if (fn) fn(a, e);
  }
  P.runAction = runAction;
  // 核心自带的几个动作
  P.actions['close-notice'] = (a) => {
    ui.notice = null;
    const el = a.closest('.proto-notice');
    focusMain();
    if (el && !reduceMotion()) { el.setAttribute('data-state', 'closed'); setTimeout(() => refreshMain(), 160); } else refreshMain();
  };
  P.actions.rail = (a) => P.toggleRail(a);
  P.actions['open-task'] = (a) => P.goFromTree(`task-${a.dataset.task}`);

  // ------------------------------------------------------------------ 事件：键盘（全局键在捕获阶段：终端会吞掉冒泡的键）
  // F1 / PF-01「终端优先」（简报 §5.2、§7.5）：焦点在终端里时只有 ⌘ 组合（以及 Ctrl Shift K）归平台，其余键（Ctrl K、Ctrl B…）
  // 不拦、不 preventDefault，原样交给终端；macOS 上 Ctrl 组合一律不截（文本框里是 Emacs 编辑键）
  const isEditable = (P.isEditable = (el) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
  window.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // F2：输入法组字中的按键一律归输入法
    const k = (e.key || '').toLowerCase();
    const inTerm = !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.term'));
    const paletteKey = k === 'k' && !e.altKey && (
      (e.metaKey && !e.ctrlKey && !e.shiftKey)
      || (!IS_MAC && e.ctrlKey && !e.metaKey && (inTerm ? e.shiftKey : true)));
    if (paletteKey) { e.preventDefault(); if (P.togglePalette && !P.gated) P.togglePalette(document.activeElement); return; }
    const railKey = k === 'b' && !e.altKey && !e.shiftKey && (
      (e.metaKey && !e.ctrlKey)
      || (!IS_MAC && e.ctrlKey && !e.metaKey && !inTerm));
    if (railKey) { e.preventDefault(); if (!modals.length && !P.gated) P.toggleRail(); return; }
    if (e.key === 'Escape') {
      if (menu.el) { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
      if (P.ask('escape', e)) { e.preventDefault(); e.stopPropagation(); return; } // 浮层卡、行内确认等（ui.js 接）
      if (modals.length) { e.preventDefault(); e.stopPropagation(); closeModal(topModal()); return; }
      hideTip();
      return; // 没有浮层时 Esc 交给终端（原型里终端是静态文本，什么也不做）
    }
    if (e.key === 'Tab' && modals.length) {
      const box = topModal().box;
      const f = focusables(box);
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1];
      const inside = box.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
      return;
    }
    // 菜单里按 Tab：关菜单、焦点先回触发器，不拦默认动作——浏览器接着把焦点移到触发器的下一个（Shift 时上一个）元素（APG）
    if (e.key === 'Tab' && menu.el) { closeMenu(true, { instant: true }); return; }
    P.emit('keydown', e, { inTerm });
  }, true);
  // 菜单里的方向键（焦点在菜单容器上时 ↓ 到第一项、↑ 到最后一项）；菜单触发器上的 ↓ / ↑ 打开菜单
  document.addEventListener('keydown', (e) => {
    if (menu.el && (menu.el === document.activeElement || menu.el.contains(document.activeElement))) {
      const items = menuItems();
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      let next = null;
      if (e.key === 'ArrowDown') next = i < 0 ? items[0] : items[(i + 1) % items.length];
      else if (e.key === 'ArrowUp') next = i < 0 ? items[items.length - 1] : items[(i - 1 + items.length) % items.length];
      else if (e.key === 'Home') next = items[0];
      else if (e.key === 'End') next = items[items.length - 1];
      if (next) { e.preventDefault(); next.focus(); }
      return;
    }
    const trig = e.target instanceof Element && e.target.closest('[data-menu]');
    if (trig && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !menu.el) {
      e.preventDefault();
      if (trig.getAttribute('aria-disabled') === 'true') { if (trig.dataset.reason) hint(trig, trig.dataset.reason); return; }
      openMenu(trig, true, e.key === 'ArrowUp'); return;
    }
    P.emit('keydown:bubble', e);
  });
  // 悬停菜单项 = 焦点移过去（PF-04：悬停与键盘共用一个高亮）
  document.addEventListener('pointermove', (e) => {
    if (!menu.el || e.pointerType === 'touch') return;
    const it = e.target instanceof Element && e.target.closest('[role^="menuitem"]');
    if (it && menu.el.contains(it) && it.getAttribute('aria-disabled') !== 'true' && document.activeElement !== it) it.focus({ preventScroll: true });
  });
  // 外部点击关菜单；按下时收起 tooltip
  document.addEventListener('pointerdown', (e) => {
    hideTip();
    if (menu.el && !menu.el.contains(e.target) && !(menu.trigger && menu.trigger.contains(e.target))) closeMenu(false);
    P.emit('pointerdown', e);
  }, true);
  window.addEventListener('resize', () => { closeMenu(false, { instant: true }); hideTip(); P.emit('resize'); checkFloat(); });
  // 内容区 / 树滚动时关菜单（菜单固定在视口上，触发器跟着内容走了）；菜单自己滚动不算
  document.addEventListener('scroll', (e) => {
    // 第五段（R1-13）：对话框正文滚动后头部底边出 1px 分隔（gap-shared §11 .dialog.is-scrolled；自动化弹层另有 .aut-scrolled 同一画法）
    if (e.target instanceof Element && e.target.matches('.dialog__body')) { const d = e.target.closest('.dialog'); if (d) d.classList.toggle('is-scrolled', e.target.scrollTop > 0); }
    if (menu.el && !(e.target instanceof Node && menu.el.contains(e.target))) closeMenu(false, { instant: true });
    hideTip();
    P.emit('scroll', e);
    checkFloat();
  }, true);
  window.addEventListener('hashchange', () => onRoute());

  // ------------------------------------------------------------------ 首屏：约 600ms 的 P6b 骨架再进入（快捷键一览里可「重播首屏加载」）
  let loadTimer = 0;
  P.startLoading = function startLoading() {
    clearTimeout(loadTimer);
    ui.loading = true;
    document.documentElement.removeAttribute('data-proto-ready');
    render(true);
    announce('正在加载项目和任务…');
    loadTimer = setTimeout(() => {
      ui.loading = false;
      render(true);
      document.documentElement.setAttribute('data-proto-ready', '1');
      announce(routeMsg());
      // 第五段（R1-06 ⑤）：口令门解锁后外壳回来——焦点交给主区（首次打开页面时不抢焦点，只在流程要求时）
      if (ui.focusAfterLoad) { ui.focusAfterLoad = false; const a = document.activeElement; if (!a || a === document.body) focusMain(); }
      if (pendingDeep) { const d = pendingDeep; pendingDeep = null; P.emit('deeplink', d); }
      P.clock.wake();
      P.emit('loaded'); // 首屏结束（初始化向导写入成功后落到工作台：焦点交给主区，flows-dep.js）
    }, LOADING_MS);
  };
  // 「判定之后只挂一个」（REQ-DEP-002，第三段）：首屏之前先问 'boot:judge'——答真表示由流程接管（启动检查中 → 初始化向导 / 放行）；
  // 口令门解锁之后同样走这里（解锁后重跑判定，AC-DEP-002.3）。没人接管就是原来的首屏骨架
  P.proceedBoot = function proceedBoot() { if (P.ask('boot:judge')) return; P.startLoading(); };

  // 侧栏里常驻的控件：图标按钮的提示换成 tooltip；查找的快捷键按平台写（macOS ⌘K，其它 Ctrl K）
  function prepareSidebar() {
    const side = $('#sidebar');
    upgradeTips(side);
    const home = $('.scope__home', side);
    if (home) { home.dataset.tip = '回到工作台'; home.removeAttribute('title'); home.removeAttribute('data-rail-tip'); }
    const find = $('.find', side);
    if (find) {
      find.dataset.tipKbd = KBD_PALETTE;
      find.setAttribute('aria-keyshortcuts', IS_MAC ? 'Meta+K' : 'Control+K');
      find.setAttribute('aria-label', `查找任务、项目与动作（${KBD_PALETTE}）`);
      if (!IS_MAC) { const k = $('.kbd', find); if (k) k.textContent = KBD_PALETTE; }
    }
  }

  function boot() {
    P.emit('boot:before');
    prepareSidebar();
    applyTheme();
    applyRail(false);
    pendingDeep = consumeParams();
    let r = landMissing(parseHash()); // 直接打开指向已不在的对象 / 不存在页面的地址：同样回落总览 + 一句（首屏结束时并进「已打开 …」播报）
    if (r && r.missed) r = { view: 'overview' };
    if (r && r.view === 'project' && latestTask(r.projectId)) r = { view: 'task', taskId: latestTask(r.projectId).id };
    ui.route = r || { view: 'overview' };
    ui.pinned = currentProjectId();
    if (ui.route.view === 'task') ui.expanded[task(ui.route.taskId).project] = true;
    if (ui.route.view === 'project' && proj(ui.route.projectId).status === 'ready') ui.expanded[ui.route.projectId] = true;
    P.emit('boot');
    // 访问口令门（F-ACC-UNLOCK，DR-28）：要口令时先只出口令门，不渲染外壳与工作台；解锁后由 flows-crd.js 调 P.proceedBoot() 重跑判定
    // 判定（第三段，F-DEP-INIT）：未初始化 → 启动检查中 → 初始化向导（flows-dep.js 接 'boot:judge'）；其余照旧出首屏骨架
    if (P.ask('boot:hold')) { requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('proto-booting'))); return; }
    P.proceedBoot();
    // 启动这一刻按记住的状态收起侧栏不播过渡；画出两帧之后才打开 ⌘B 的宽度过渡
    requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('proto-booting')));
  }
  document.addEventListener('DOMContentLoaded', boot);

  // 测试与调试用的出口：state 只读快照；clock / scenario 可操作（与「原型说明 › 场景」页同一套）
  window.__proto = {
    get state() {
      return {
        route: { ...ui.route }, filter: ui.filter, rail: ui.rail, theme: ui.theme, loading: ui.loading, pinned: ui.pinned, platformMac: IS_MAC,
        notice: ui.notice ? { ...ui.notice } : null,
        tasks: world.tasks.map((t) => ({ id: t.id, name: t.name, project: t.project, agent: t.agent, state: t.state, status: t.status, code: t.code, age: t.age, touched: t.touched || 0, headless: !!t.headless, image: t.image ? { ...t.image } : null })),
        projects: world.projects.map((p) => ({ id: p.id, name: p.name, status: p.status, source: p.source, repo: p.repo || null, failCode: p.failCode, pct: p.clone && P.cloneView ? P.cloneView(p).pct : undefined })),
        automations: world.automations.map((a) => ({ id: a.id, project: a.project })),
        treeOrder: P.treeOrder ? P.treeOrder() : null,
        retained: world.retained.map((r) => ({ id: r.id, project: r.project, name: r.name })),
        clock: P.clock.now(), scenario: P.scenario.snapshot(),
        // 各流程补充的只读快照（凭证、访问口令、镜像…）：P.stateExtras.push(() => ({ 键: 值 }))
        ...P.stateExtras.reduce((o, fn) => Object.assign(o, fn()), {}),
      };
    },
    clock: { advance: (ms) => P.clock.advance(ms), now: () => P.clock.now(), setSpeed: (v) => { P.clock.speed = v; }, speed: () => P.clock.speed, running: () => P.clock.running, manual: (on) => P.clock.manual(on) },
    scenario: { set: (k, v) => P.scenario.set(k, v), get: (k) => P.scenario.get(k) },
  };
})();
