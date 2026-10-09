/*
 * 交互原型 · 凭证（js/flows-crd.js）：L3 六个流程（第二段接线）
 *   F-AUTH-PANEL  Agent 登录面板：新建任务闸门、凭证页卡片共用一套（空闲 → 设备码 / 授权码 / API Key → 已连上；到期、等太久、被拒、网络异常、起不来）
 *   F-CRD-MODE    切换生效方式：目标已配置 → 确认框；未配置 → 就地展开那种方式的面板，配好即切换；确认前单选不动
 *   F-CRD-REVOKE  删除 Agent 凭证：打开即如实列出会被销毁的任务（读不到 / 没有任务分开说）→ 删除中 → 任务走删除中后移除；删的是在用的那份时追问切过去
 *   F-CRD-GIT     Git 凭证：测试连接三态、配置 HTTPS Token / SSH 密钥（预检）、更换、删除确认（如实列出相关项目）；删掉后私有仓克隆 / 拉取按权限类失败
 *   F-CRD-PAGE    凭证页的状态：直开本页骨架、读取失败各自重试、搜索过滤与无匹配、即将过期 / 已过期、从克隆失败跳来的回程条
 *   F-ACC-UNLOCK  访问口令门：全屏、门之下不挂外壳与工作台；验证中、口令不对、连错 5 次锁定（原型 30 秒，画面写约 5 分钟）、解锁后重跑首屏
 * 标记来源：gap/drafts/f-auth-panel-*、f-crd-*、f-acc-unlock-*（index.html 的 tpl-auth-* / tpl-crd-* / tpl-acc-* 模板，build-proto.cjs 同源拷贝）；
 *           凭证页本身是 P3（tpl-credentials），卡片按 P3 / 补全稿同一套类名由本文件按数据画。
 * 产品口径：gap/product/AUTH.md、CRD.md、ACC.md（AC 的 Then）；接线要点：gap/drafts/notes/crd-a.md §6、crd-b.md §6；待定问题一律按 open-questions 的默认。
 */
(function () {
  'use strict';
  const P = window.P;
  const { $, $$, esc, ui } = P;
  const world = P.world;
  const T = P.TIMING;

  // ------------------------------------------------------------------ 场景（「原型说明 › 场景」；也可 #…&scenario=键:值）
  const G = '凭证', GA = '首次启动';
  P.scenario.define({ key: 'cred-codex', group: G, label: 'Codex 的凭证', def: 'ok', options: [['ok', '帐号登录 + API Key（示例世界）'], ['none', '两种都没配（新建任务里走闸门）']] });
  P.scenario.define({ key: 'cred-expiry', group: G, label: '有效期', def: 'normal', options: [['normal', '正常'], ['soon', 'Codex 帐号登录即将过期（剩 5 天）'], ['expired', 'Claude Code 帐号登录已过期（当前使用）'], ['both', '两者都有']] });
  P.scenario.define({ key: 'cred-load', group: G, label: '凭证页读取', def: 'ok', options: [['ok', '正常'], ['slow', '每次进入先出骨架'], ['fail', '两份都读不出来（[重试] 后复位）'], ['fail-git', '只有 Git 凭证读不出来']] });
  P.scenario.define({ key: 'auth-device', group: G, label: '设备码登录（Codex）', def: 'ok', options: [['ok', '点 [打开授权页] 后 5 秒连上'], ['expire', '让设备码过期（从 00:03 倒数）'], ['gaveup', '等太久先停下'], ['popup', '浏览器拦了弹窗'], ['network', '轮询网络异常']] });
  P.scenario.define({ key: 'auth-setup', group: G, label: '授权码登录（Claude Code）', def: 'reject-once', options: [['reject-once', '第一次粘贴被拒、第二次成功'], ['ok', '一次就成功'], ['auto', '同机部署：授权自动送回']] });
  P.scenario.define({ key: 'auth-begin', group: G, label: '下一次 [开始帐号登录]', once: true, def: 'ok', options: [['ok', '正常'], ['unavailable', '本机登录程序起不来（503）'], ['network', '请求没发出去']] });
  P.scenario.define({ key: 'revoke-list', group: G, label: '删除凭证的任务清单', def: 'ok', options: [['ok', '读得到'], ['fail', '读不到（[重试读取] 后复位）']] });
  P.scenario.define({ key: 'crd-delete', group: G, label: '下一次删除 Agent 凭证', once: true, def: 'ok', options: [['ok', '成功'], ['fail', '失败（500）']] });
  P.scenario.define({ key: 'git-test', group: G, label: 'Git 测试连接', def: 'auto', options: [['auto', '按白名单判（目标 host 在白名单里就连接成功）'], ['auth', '认证失败'], ['network', '网络错误'], ['timeout', '超时（15 秒）']] });
  P.scenario.define({ key: 'git-retry', group: G, label: '回程条 [重试克隆]', once: true, def: 'ok', options: [['ok', '成功'], ['fail', '失败']] });
  P.scenario.define({ key: 'access', group: GA, label: '访问口令', def: 'off', options: [['off', '已解锁（不出口令门）'], ['required', '需要访问口令'], ['locked', '口令门已锁定（连错 5 次）']] });

  // ------------------------------------------------------------------ 数据与派生（notes/crd-a.md §6.1、crd-b.md §6.1）
  const METHOD = { account: '帐号登录', apiKey: 'API Key' };
  // 方式名嵌进中文句子：只有英文的 API Key 两侧留空格（DR-35 ⑩「中英文之间留空格」），帐号登录直接接
  const ws = (m) => (m === 'apiKey' ? ' API Key' : '帐号登录'); // 句中、后面跟标点或句尾：「切换到 API Key」「切换到帐号登录」
  const wm = (m) => (m === 'apiKey' ? ' API Key ' : '帐号登录'); // 句中、后面还有中文：「它的 API Key 还留着」「它的帐号登录还留着」
  const SHORT = { codex: 'cx', 'claude-code': 'cc' };
  const TITLE_ID = { codex: 'p3-codex', 'claude-code': 'p3-claude' }; // P3 原样的标题 id（视觉同源）
  const RADIO = { codex: 'codex-auth', 'claude-code': 'claude-auth' };
  const CONSOLE = { OpenAI: 'OpenAI 后台', Anthropic: 'Anthropic 控制台' };
  const PASSCODES = ['AB12-CD34-EF56', 'demo']; // 示例口令（f-acc-unlock-01）；demo 方便手测
  const other = (m) => (m === 'account' ? 'apiKey' : 'account');
  const credOf = (rt) => (rt.active ? rt[rt.active] : null);
  const usable = (rt, m) => !!(m && rt[m] && !rt[m].expired);
  // credentialStatus：没有生效方式或生效的那份不在 → none；过期 → expired；帐号登录不足 7 天 → expiring（PARAM.CRED_EXPIRY_WARN_DAYS）
  function credStatus(rt) {
    const c = credOf(rt);
    if (!c) return 'none';
    if (c.expired) return 'expired';
    if (rt.active === 'account' && c.daysLeft != null && c.daysLeft < 7) return 'expiring';
    return 'active';
  }
  P.credStatus = credStatus;
  // 新建任务闸门（flows-lch.js）读 rt.cred / rt.identity：挂成派生属性，数据只有一份
  for (const rt of world.runtimes) {
    Object.defineProperties(rt, {
      cred: { configurable: true, get() { return credStatus(this); } },
      identity: { configurable: true, get() { const c = credOf(this); return c ? c.masked : null; } },
    });
  }
  const daysText = (c) => (c.daysLeft < 1 ? '剩 <1 天' : `剩 ${c.daysLeft} 天`);
  const runtimeOfTask = (t) => world.runtimes.find((r) => r.name === t.agent);
  // 注入记录（D3：只注入任务自己那个 Agent 的那一份）：示例世界里 Codex 的任务都是用帐号登录起来的；之后的在「启动运行环境」这一步按当时的生效方式记
  for (const t of world.tasks) if (t.credBind === undefined && t.agent === 'Codex') t.credBind = 'account';
  P.hook('task:inject', (t) => { const rt = runtimeOfTask(t); t.credBind = rt && usable(rt, rt.active) ? rt.active : null; });
  // 删除凭证会销毁的 = 注入过这一份、仍在运行（running / idle / 等待你输入 / 启动中）的任务；准备中、还没走到注入的写进「删掉之后」
  function revokeImpact(rt, m) {
    const mine = world.tasks.filter((t) => t.agent === rt.name && t.state !== 'destroying');
    const prep = (t) => t.state === 'preparing' || t.state === 'stuck';
    const injected = (t) => ['running', 'idle', 'waiting', 'starting'].includes(t.state) || (prep(t) && t.status === 'starting');
    return { destroy: mine.filter((t) => injected(t) && t.credBind === m), preparing: rt.active === m ? mine.filter((t) => prep(t) && t.status !== 'starting') : [] };
  }
  const STATE_WORD = (t) => (t.state === 'idle' ? '空闲' : t.state === 'starting' || t.state === 'preparing' ? '准备中' : (P.STATE[t.state] || {}).word || '');

  // 场景改数据（只改场景自己加的那一份；改回默认时复原）
  const SNAP = JSON.stringify(world.runtimes.map((r) => ({ active: r.active, account: r.account, apiKey: r.apiKey })));
  const scnFlags = { codexNone: false, soon: false, expired: false };
  function applyCredScenario() {
    const [cx, cc] = [P.runtime('codex'), P.runtime('claude-code')];
    const snap = JSON.parse(SNAP);
    const wantNone = P.scenario.is('cred-codex', 'none');
    if (wantNone && !scnFlags.codexNone) { Object.assign(cx, { active: null, account: null, apiKey: null }); scnFlags.codexNone = true; }
    else if (!wantNone && scnFlags.codexNone) { Object.assign(cx, snap[0]); scnFlags.codexNone = false; }
    const exp = P.scenario.get('cred-expiry');
    const soon = exp === 'soon' || exp === 'both', expired = exp === 'expired' || exp === 'both';
    if (soon !== scnFlags.soon) { if (cx.account) cx.account = { ...cx.account, daysLeft: soon ? 5 : 26 }; scnFlags.soon = soon; }
    if (expired && !scnFlags.expired) { cc.account = { masked: 'sk-ant-oat01-…x7k2', mono: true, expired: true, fromScenario: true }; cc.active = 'account'; scnFlags.expired = true; }
    else if (!expired && scnFlags.expired) { if (cc.account && cc.account.fromScenario) { cc.account = null; if (cc.active === 'account') cc.active = cc.apiKey ? 'apiKey' : null; } scnFlags.expired = false; }
    credChanged();
  }
  P.hook('scenario', (k) => { if (k === 'cred-codex' || k === 'cred-expiry') applyCredScenario(); });
  // 凭证一变：凭证页、新建任务弹层（闸门 / 身份句）、P5「Agent」一节同时刷新
  function credChanged() {
    P.render();
    for (const box of $$('[data-dialog="new-task"]')) box.dispatchEvent(new CustomEvent('nt:sync'));
    P.emit('cred:changed'); // 第三段：初始化向导第 4 步「模型帐号」按同一份凭证重画（向导盖着时 render() 不画）
  }

  // ================================================================== F-AUTH-PANEL 登录面板（f-auth-panel-01…09）
  const AP = { cur: null }; // 全页同一时刻只开一个面板（开另一个先收起前一个）
  const FIRST_CODE = { newtask: 'WDJB-MJHT', cred: 'QFRT-7KXM', wizard: 'QFRT-7KXM' };
  const NEXT_CODES = ['KPLM-3RTX', 'HZQD-4WNV', 'MRXT-8BPC'];
  let codeSeq = 0;
  // 宿主（第三段加 wizard）：newtask = 新建任务闸门、cred = 凭证页卡片、wizard = 初始化向导第 4 步那一行（f-dep-init-11；[收起] 是那一行行尾的按钮，由向导管）
  const panelIds = (host, rt) => { const b = host === 'newtask' ? 'nt-auth-panel' : `${SHORT[rt.id]}-auth-panel`; return { panel: b, slot: `${b}-slot`, acc: `${b}-tab-acc`, key: `${b}-tab-key` }; };
  const isDevice = (rt) => rt.accountMethod === 'oauth-device';
  const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const leftSec = (ap) => Math.max(0, Math.ceil((ap.acc.endsAt - P.clock.now()) / 1000));
  const live = (ap) => AP.cur === ap && ap.root.isConnected;

  function openPanel(o) {
    // o：{ host: 'newtask' | 'cred' | 'wizard', rt, tab: 'acc' | 'key', box（新建任务弹层）, card（凭证页卡片 / 向导那一行）, triggerFk, fromRadio, onClose（wizard：收起后重画那一行） }
    if (AP.cur) closePanel(AP.cur, { restore: false, cancel: true });
    const { host, rt } = o;
    const ids = panelIds(host, rt);
    const root = P.fromTpl(host === 'newtask' ? 'tpl-auth-nt' : host === 'wizard' ? 'tpl-auth-wiz' : 'tpl-auth-cred');
    const sec = root.matches('.auth-panel') ? root : $('.auth-panel', root);
    sec.id = ids.panel; sec.setAttribute('aria-label', `配置 ${rt.name} 凭证`);
    $('.auth-panel__title', sec).textContent = `配置 ${rt.name} 凭证`;
    // 一次性说明只在新建任务闸门、且这个 Agent 从来没配过时出（REQ-AUTH-001；已过期走 [重新授权] 不出）
    const notice = $('.auth-panel__notice', sec);
    if (notice && !(host === 'newtask' && !rt.account && !rt.apiKey)) notice.remove();
    const [tAcc, tKey] = $$('[role="tab"]', sec);
    tAcc.id = ids.acc; tKey.id = ids.key;
    for (const [t, k] of [[tAcc, 'acc'], [tKey, 'key']]) { t.setAttribute('aria-controls', ids.slot); t.dataset.action = 'auth-tab'; t.dataset.tab = k; t.dataset.fk = `auth-tab:${k}`; }
    const slot = $('.auth-panel__slot', sec); slot.id = ids.slot; slot.textContent = '';
    const foot = $('.auth-panel__foot .link', sec);
    if (foot) { foot.dataset.action = 'auth-manage'; foot.dataset.fk = 'auth-manage'; }
    const col = $('.auth-collapse', root);
    if (col) { col.setAttribute('aria-controls', ids.panel); col.dataset.action = 'auth-collapse'; col.dataset.fk = 'auth-collapse'; }
    const ap = { ...o, ids, root, sec, slot, tab: o.tab || 'acc', acc: { phase: 'idle' }, key: { phase: 'form' }, token: 0, slotKey: null, done: false };
    if (host === 'newtask') {
      ap.note = $('#nt-agent-note', o.box);
      ap.note.replaceWith(root);
      // 关掉新建任务弹层（Esc、取消、遮罩）= 取消这次登录（REQ-AUTH-003）：挂在弹层的 onClose 上
      const mm = P.modals.find((x) => x.box === o.box);
      if (mm && !mm.authHooked) {
        const prev = mm.onClose;
        mm.onClose = () => { if (AP.cur && AP.cur.box === o.box) closePanel(AP.cur, { restore: false, cancel: true }); if (prev) prev(); };
        mm.authHooked = true;
      }
    } else o.card.appendChild(root);
    AP.cur = ap;
    root.addEventListener('keydown', (e) => onPanelKey(ap, e));
    root.addEventListener('input', (e) => onPanelInput(ap, e));
    root.addEventListener('submit', (e) => { e.preventDefault(); const f = e.target; if (f.matches('[aria-label="API Key"]')) submitKey(ap); else submitCode(ap); });
    paintPanel(ap);
    if (host === 'newtask') o.box.dispatchEvent(new CustomEvent('nt:sync')); else if (host === 'cred') paintAgents($('#shell-main'));
    P.upgradeTips(root);
    root.scrollIntoView({ block: 'nearest' });
    $(`#${ap.tab === 'acc' ? ids.acc : ids.key}`, root).focus({ preventScroll: true });
    P.announce(`已展开「配置 ${rt.name} 凭证」`);
    return ap;
  }
  P.openAuthPanel = openPanel;
  // 第三段：向导第 4 步的 [收起] 在那一行行尾（不在面板里），由向导调这里收起（= 取消这次登录）；authPanelOf 告诉宿主现在开着哪一个
  P.closeAuthPanel = (opts) => { if (AP.cur) closePanel(AP.cur, { restore: false, cancel: true, ...(opts || {}) }); };
  P.authPanelOf = () => (AP.cur ? { host: AP.cur.host, rt: AP.cur.rt.id, done: AP.cur.done, root: AP.cur.root } : null);

  function closePanel(ap, { restore = true, cancel = false } = {}) {
    if (AP.cur !== ap) return;
    AP.cur = null;
    ap.token++; // 作废这次登录里还没到点的定时器（停轮询、丢掉这次的码）
    const inProgress = ap.acc.phase === 'preparing' || ap.acc.phase === 'polling' || ap.acc.phase === 'awaiting';
    if (ap.host === 'newtask') {
      if (ap.root.isConnected) ap.root.replaceWith(ap.note);
      ap.box.dispatchEvent(new CustomEvent('nt:sync'));
      if (restore) {
        const f = $('[data-fk="nt-gate"]', ap.box) || $('input[name="nt-agent"]:checked', ap.box);
        if (f) f.focus({ preventScroll: true });
      }
    } else {
      ap.root.remove();
      const main = $('#shell-main');
      if (main && main.dataset.tpl === 'tpl-credentials') paintAgents(main);
      if (ap.onClose) ap.onClose(ap); // 向导：那一行换回 [去配置] / 已配置
      if (restore) { const f = ap.triggerFk && $(`[data-fk="${CSS.escape(ap.triggerFk)}"]`); if (f && P.isShown(f)) f.focus({ preventScroll: true }); else if (ap.host !== 'wizard') P.focusMain(); }
    }
    if (cancel && inProgress && !ap.done) P.announce('已取消这次登录');
  }

  // ---- 面板内容（按方式标签与阶段换槽位；倒计时只就地改字）
  function paintPanel(ap) {
    for (const t of $$('[role="tab"]', ap.sec)) {
      const on = t.dataset.tab === ap.tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    }
    ap.slot.setAttribute('aria-labelledby', ap.tab === 'acc' ? ap.ids.acc : ap.ids.key);
    const st = ap.tab === 'acc' ? ap.acc : ap.key;
    const key = JSON.stringify([ap.tab, st.phase, ap.done, ap.tab === 'acc' ? [st.code, st.opened, st.popup, st.netErr, st.rejected] : [st.reasons]]);
    if (ap.slotKey === key) { if (ap.tab === 'acc' && ap.acc.phase === 'polling') paintCountdown(ap); return; }
    ap.slotKey = key;
    const hadFocus = ap.slot.contains(document.activeElement);
    ap.slot.textContent = '';
    if (ap.done) ap.slot.appendChild(P.fromTpl('tpl-auth-done', { keepRoles: true }));
    else if (ap.tab === 'key') ap.slot.appendChild(keyForm(ap));
    else ap.slot.appendChild(accContent(ap));
    P.upgradeTips(ap.slot);
    if (hadFocus) focusSlot(ap);
  }
  // 槽位换了内容、焦点原来在槽位里：落到新内容的第一个可操作控件（没有就落在槽位上，读屏接着念状态句）
  function focusSlot(ap) {
    const f = $('input:not([disabled]), button:not([disabled]):not([aria-disabled="true"]), a[href]', ap.slot);
    if (f) f.focus({ preventScroll: true }); else { ap.slot.tabIndex = -1; ap.slot.focus({ preventScroll: true }); }
  }
  function statusLine(text) { const p = document.createElement('p'); p.className = 'auth-status'; p.setAttribute('role', 'status'); p.innerHTML = `<span class="icon i-loader-circle icon--spin" aria-hidden="true"></span>${esc(text)}`; return p; }
  function failNote(title, actions) {
    // 卡内提示条（f-auth-panel-04 的 .note--fail 同一写法）：标题一句 + 动作行
    const n = P.fromTpl('tpl-auth-expired', { keepRoles: true });
    $('.note__title', n).textContent = title;
    $('.note__actions', n).innerHTML = actions;
    return n;
  }
  function accContent(ap) {
    const rt = ap.rt, a = ap.acc;
    const frag = document.createDocumentFragment();
    if (a.phase === 'idle') {
      const el = P.fromTpl('tpl-auth-idle');
      const b = $('.btn', el); b.dataset.action = 'auth-start'; b.dataset.fk = 'auth-start';
      const first = isDevice(rt) ? `点了才开始：平台这时才向 ${rt.vendor} 申请一串设备码，再带你去授权页。` : `点了才开始：平台这时才去准备 ${rt.name} 的登录链接。`;
      // 向导里没有弹层可关（AC-AUTH-003.5）：第二句去掉「或关掉弹层」
      $('.auth-help', el).textContent = `${first}登录开始后，切到 API Key、点「收起」${ap.host === 'wizard' ? '' : '或关掉弹层'}，这次登录都会取消。`;
      frag.appendChild(el);
    } else if (a.phase === 'preparing') {
      frag.appendChild(statusLine(isDevice(rt) ? '正在准备登录…' : '正在准备登录链接…'));
    } else if (a.phase === 'begin-fail') {
      // REQ-AUTH-011：503 本机登录程序起不来 / 请求本身没发出去，各自一句人话 + [重试]（503 另给去系统状态诊断的入口）
      const sys = a.code === 'unavailable' && ap.host !== 'wizard' ? '<button class="link" type="button" data-action="auth-go-system" data-fk="auth-go-system">去系统状态跑一次诊断</button>' : ''; // 向导盖着时去不了系统状态
      frag.appendChild(failNote(a.code === 'unavailable' ? '本机的登录程序没能启动，暂时没法开始登录。' : '没能开始登录，请重试。', `<button class="btn btn--secondary btn--32" type="button" data-action="auth-start" data-fk="auth-retry-begin"><span class="icon i-rotate-ccw" aria-hidden="true"></span>重试</button>${sys}`));
    } else if (isDevice(rt)) {
      // 设备码（f-auth-panel-03 / 04 / 08）：[打开授权页] → 码 + [复制] → 倒计时 → 等待授权中… / 到期 / 等太久
      const tpl = P.fromTpl('tpl-auth-device', { keepRoles: true });
      while (tpl.firstChild) frag.appendChild(tpl.firstChild);
      const steps = $$('.auth-step', frag);
      const open = $('.btn', steps[0]); open.dataset.action = 'auth-open-page'; open.dataset.fk = 'auth-open-page';
      if (a.popup) {
        const w = document.createElement('p');
        w.className = 'tone-warn'; w.setAttribute('role', 'alert');
        w.innerHTML = '浏览器拦了弹窗 —— <a class="link" href="#" data-action="auth-popup-link" data-fk="auth-popup-link">点这里手动打开</a>';
        steps[0].appendChild(w);
      }
      $('.auth-label', steps[1]).textContent = `在新标签页粘贴这串设备码${a.opened ? '（已复制到剪贴板）' : ''}：`;
      $('.auth-code', steps[1]).textContent = a.code;
      const copy = $('.auth-code-row .btn', steps[1]); copy.dataset.action = 'auth-copy-code'; copy.dataset.fk = 'auth-copy-code';
      const cd = $('.auth-countdown', frag);
      const status = $('.auth-status', frag);
      if (a.phase === 'expired' || a.phase === 'gaveup') {
        cd.classList.add('auth-countdown--fail');
        $('[role="timer"]', cd).textContent = mmss(a.phase === 'expired' ? 0 : a.frozenSec);
        const n = failNote('这串设备码已经到期了。', '<button class="btn btn--secondary btn--32" type="button" data-action="auth-renew" data-fk="auth-renew"><span class="icon i-rotate-ccw" aria-hidden="true"></span>换一串重来</button>');
        if (a.phase === 'gaveup') {
          // 「等太久先停下」（f-auth-panel-04 头注释另一变体）：警示色、标题位写整句（码可能还有效）
          n.className = 'note note--warn';
          $('.icon', n).className = 'icon i-triangle-alert';
          $('.note__title', n).textContent = '等了 10 分钟还没等到授权结果，这边先停下了 —— 这串码可能还有效，如果你刚在浏览器里点完，可以先换一串重来。';
        }
        status.replaceWith(n);
      } else {
        $('[role="timer"]', cd).textContent = mmss(leftSec(ap));
        cd.classList.toggle('auth-countdown--warn', leftSec(ap) <= T.deviceWarnSec);
        if (a.netErr) {
          // 轮询网络异常（REQ-AUTH-004 AC .5，Q-AUTH-01 A）：[重试] 立即再查一次，不换码、不重置倒计时
          const w = document.createElement('p');
          w.className = 'tone-warn'; w.setAttribute('role', 'alert'); w.textContent = '网络异常，正在重试…';
          const r = document.createElement('button');
          r.className = 'btn btn--tertiary btn--28 auth-retry'; r.type = 'button'; r.dataset.action = 'auth-net-retry'; r.dataset.fk = 'auth-net-retry'; r.textContent = '重试';
          status.replaceWith(w, r);
        }
      }
    } else {
      // 授权码（Claude Code setup-token，f-auth-panel-05）
      const form = P.fromTpl('tpl-auth-setup', { keepRoles: true });
      const err = $('#st-err', form); if (err) err.remove();
      const input = $('#st-code', form);
      input.value = ''; input.removeAttribute('aria-describedby'); input.dataset.fk = 'auth-code-input';
      const link = $('.auth-link', form); link.dataset.action = 'auth-open-link'; link.dataset.fk = 'auth-open-link';
      const reveal = $('[aria-controls="st-code"]', form); reveal.dataset.action = 'auth-reveal'; reveal.dataset.fk = 'auth-reveal';
      const submit = $('[type="submit"]', form); submit.dataset.action = 'auth-submit-code'; submit.dataset.fk = 'auth-submit-code'; submit.disabled = true;
      if (a.rejected) {
        // 被拒：固定前端句（DR-33），粘贴框已清空，[提交] 回到禁用（REQ-AUTH-006）
        const e = document.createElement('p');
        e.className = 'auth-field-msg'; e.id = 'st-err'; e.setAttribute('role', 'alert');
        e.innerHTML = '<span class="icon i-circle-alert" aria-hidden="true"></span>这串授权码不对或已经失效，请重新取一次再粘贴。';
        $('.auth-input-row', form).after(e);
        input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', 'st-err');
      }
      frag.appendChild(form);
    }
    return frag;
  }
  function keyForm(ap) {
    // API Key（f-auth-panel-06 / 09）：前缀提示不拦提交；服务端拒绝给原因；提交即清空
    const rt = ap.rt, k = ap.key;
    const form = P.fromTpl('tpl-auth-apikey', { keepRoles: true });
    const pre = $('#ak-prefix', form); if (pre) pre.remove();
    const note = $('.note--fail', form); if (note) note.remove();
    const input = $('#ak', form);
    input.value = ''; input.removeAttribute('aria-invalid'); input.setAttribute('aria-describedby', 'ak-help'); input.placeholder = `${rt.prefix}…`; input.dataset.fk = 'auth-key-input';
    // 去处句点名厂商（AC-AUTH-007.6：新建任务闸门与凭证页都点名；现状闸门用兜底句——原型先行）
    $('#ak-help', form).textContent = `在 ${rt.vendor} 的控制台创建一个 API Key，粘到这里；按用量计费。`;
    const submit = $('[type="submit"]', form); submit.dataset.action = 'auth-submit-key'; submit.dataset.fk = 'auth-submit-key'; submit.disabled = true;
    if (k.phase === 'rejected' && k.reasons) {
      const n = document.createElement('div');
      n.className = 'note note--fail'; n.setAttribute('role', 'alert');
      n.innerHTML = `<span class="icon i-circle-x" aria-hidden="true"></span><div class="note__body"><span class="note__title">这串 API Key 格式不对，没有保存。</span>${k.reasons.length ? `<ul class="bullets auth-reasons">${k.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}</div>`;
      submit.before(n);
    }
    return form;
  }
  function paintCountdown(ap) {
    const cd = $('.auth-countdown', ap.slot); if (!cd) return;
    const s = leftSec(ap);
    const t = $('[role="timer"]', cd); const txt = mmss(s);
    if (t.textContent !== txt) t.textContent = txt;
    cd.classList.toggle('auth-countdown--warn', s <= T.deviceWarnSec && s > 0);
  }
  // 前缀提示：输入非空且不以前缀开头 → 输入框错误态 + 一句（只在出现 / 消失时改，不每个字重播）
  function onPanelInput(ap, e) {
    const t = e.target;
    if (t.id === 'ak') {
      const v = t.value;
      const bad = !!v && !v.startsWith(ap.rt.prefix);
      let pre = $('#ak-prefix', ap.slot);
      if (bad && !pre) {
        pre = document.createElement('p'); pre.className = 'auth-field-msg'; pre.id = 'ak-prefix'; pre.setAttribute('role', 'alert');
        pre.innerHTML = `<span class="icon i-circle-alert" aria-hidden="true"></span>这串 key 一般以 ${esc(ap.rt.prefix)} 开头 —— 确认没拿错的话，也可以直接提交，由服务端判定。`;
        t.after(pre); t.setAttribute('aria-invalid', 'true'); t.setAttribute('aria-describedby', 'ak-prefix ak-help');
      } else if (!bad && pre) { pre.remove(); t.removeAttribute('aria-invalid'); t.setAttribute('aria-describedby', 'ak-help'); }
      $('[data-action="auth-submit-key"]', ap.slot).disabled = !v.trim();
    } else if (t.id === 'st-code') {
      $('[data-action="auth-submit-code"]', ap.slot).disabled = !t.value.trim();
    }
  }
  function onPanelKey(ap, e) {
    const tab = e.target.closest && e.target.closest('[role="tab"]');
    if (!tab || !ap.sec.contains(tab)) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    const next = e.key === 'Home' ? 'acc' : e.key === 'End' ? 'key' : tab.dataset.tab === 'acc' ? 'key' : 'acc';
    switchTab(ap, next);
    $(`#${next === 'acc' ? ap.ids.acc : ap.ids.key}`, ap.sec).focus();
  }
  function switchTab(ap, tab) {
    if (ap.done || ap.tab === tab) return;
    // 切到 API Key 即取消进行中的帐号登录（REQ-AUTH-003）；切回帐号登录停在空闲态，不自动开始
    if (ap.tab === 'acc' && ['preparing', 'polling', 'awaiting'].includes(ap.acc.phase)) P.announce('已取消这次登录');
    ap.token++;
    ap.tab = tab;
    ap.acc = { phase: 'idle' }; ap.key = { phase: 'form' };
    paintPanel(ap);
    if (ap.host === 'cred') paintAgents($('#shell-main'));
  }
  // ---- 动作
  const apOf = (el) => (AP.cur && AP.cur.root.contains(el) ? AP.cur : null);
  P.actions['auth-tab'] = (el) => { const ap = apOf(el); if (ap) switchTab(ap, el.dataset.tab); };
  P.actions['auth-collapse'] = (el) => { const ap = apOf(el); if (ap) closePanel(ap, { cancel: true }); };
  P.actions['auth-start'] = (el) => {
    const ap = apOf(el); if (!ap) return;
    // 点了才开始（FE1）：先「准备中」，拿到挑战后进设备码 / 授权码；一次点击恰好开始一次
    const tok = ++ap.token;
    const scen = P.scenario.take('auth-begin');
    ap.acc = { phase: 'preparing' };
    paintPanel(ap); focusSlot(ap);
    P.clock.after(T.authPrepare, () => {
      if (!live(ap) || ap.token !== tok) return;
      if (scen !== 'ok') { ap.acc = { phase: 'begin-fail', code: scen }; paintPanel(ap); focusSlot(ap); P.announce(scen === 'unavailable' ? '本机的登录程序没能启动，暂时没法开始登录。' : '没能开始登录，请重试。'); return; }
      if (isDevice(ap.rt)) beginDevice(ap, tok);
      else {
        ap.acc = { phase: 'awaiting' };
        paintPanel(ap); focusSlot(ap);
        P.announce('授权链接准备好了');
        if (P.scenario.is('auth-setup', 'auto')) P.clock.after(T.setupAuto, () => { if (live(ap) && ap.token === tok && ap.acc.phase === 'awaiting') succeed(ap, 'account'); });
      }
    });
  };
  function beginDevice(ap, tok) {
    const scen = P.scenario.get('auth-device');
    const code = codeSeq++ === 0 ? FIRST_CODE[ap.host] : NEXT_CODES[(codeSeq - 2) % NEXT_CODES.length];
    // 到期时刻对齐时钟的整秒拍（ticker 每个整秒走一格）：拿到码时显示 09:59（场景「让设备码过期」00:03），之后每拍减一，归零那一拍转到期
    const nextSec = (Math.floor(P.clock.now() / 1000) + 1) * 1000;
    ap.acc = { phase: 'polling', code, endsAt: nextSec + ((scen === 'expire' ? 3 : T.deviceCodeSec) - 1) * 1000, opened: false, popup: false, netErr: false };
    paintPanel(ap); focusSlot(ap);
    P.announce(`设备码 ${code}，等待授权中`);
    if (scen === 'gaveup') P.clock.after(T.deviceGiveUp, () => { if (live(ap) && ap.token === tok && ap.acc.phase === 'polling') { ap.acc.frozenSec = leftSec(ap); ap.acc.phase = 'gaveup'; paintPanel(ap); P.announce('等了 10 分钟还没等到授权结果，这边先停下了'); } });
    if (scen === 'network') P.clock.after(T.deviceNetErr, () => { if (live(ap) && ap.token === tok && ap.acc.phase === 'polling') { ap.acc.netErr = true; paintPanel(ap); P.announce('网络异常，正在重试…'); } });
    P.clock.wake();
  }
  function authorizeLater(ap) {
    const tok = ap.token;
    if (ap.acc.authorizing) return;
    ap.acc.authorizing = true;
    P.clock.after(T.deviceAuthorize, () => {
      if (!live(ap) || ap.token !== tok || ap.acc.phase !== 'polling') return;
      if (ap.acc.netErr) { ap.acc.pendingOk = true; return; } // 网络异常期间查不到结果，恢复后下一次查询就拿到
      succeed(ap, 'account');
    });
  }
  P.actions['auth-open-page'] = (el) => {
    const ap = apOf(el); if (!ap || ap.acc.phase !== 'polling') return;
    // 原型不打开外部页面（零外部请求）：同步「新开标签页」+ 码进剪贴板，这里只改标签句并等授权结果
    ap.acc.opened = true;
    if (P.scenario.is('auth-device', 'popup') && !ap.acc.popupSeen) { ap.acc.popup = true; ap.acc.popupSeen = true; paintPanel(ap); P.announce('浏览器拦了弹窗 —— 可以点「点这里手动打开」'); return; }
    paintPanel(ap);
    P.announce('已在新标签页打开授权页（原型不打开外部页面），设备码已复制到剪贴板');
    authorizeLater(ap);
  };
  P.actions['auth-popup-link'] = (el) => {
    const ap = apOf(el); if (!ap || ap.acc.phase !== 'polling') return;
    ap.acc.popup = false; paintPanel(ap);
    P.announce('已手动打开授权页（原型不打开外部页面）');
    authorizeLater(ap);
  };
  P.actions['auth-copy-code'] = (el) => {
    const ap = apOf(el); if (!ap) return;
    // 只把码放进剪贴板并播报（现状没有轻提示）；剪贴板不可用时如实说（码本身可全选）
    copyText(ap.acc.code, () => P.announce('设备码已复制'), () => P.announce('没能自动复制，请手动选中设备码复制'));
  };
  P.actions['auth-net-retry'] = (el) => {
    const ap = apOf(el); if (!ap) return;
    ap.acc.netErr = false; paintPanel(ap); focusSlot(ap);
    P.announce('等待授权中…');
    if (ap.acc.pendingOk) succeed(ap, 'account');
  };
  P.actions['auth-renew'] = (el) => {
    const ap = apOf(el); if (!ap) return;
    const tok = ++ap.token;
    ap.acc = { phase: 'preparing' }; paintPanel(ap); focusSlot(ap);
    P.clock.after(T.authPrepare, () => { if (live(ap) && ap.token === tok) beginDevice(ap, tok); });
  };
  P.actions['auth-open-link'] = (el) => { if (apOf(el)) P.announce('已在新标签页打开授权链接（原型不打开外部页面）'); };
  P.actions['auth-reveal'] = (el) => {
    const ap = apOf(el); if (!ap) return;
    const input = $('#st-code', ap.slot);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    el.setAttribute('aria-pressed', String(show));
    el.innerHTML = `<span class="icon ${show ? 'i-eye-off' : 'i-eye'}" aria-hidden="true"></span>${show ? '隐藏' : '展开查看'}`;
  };
  P.actions['auth-submit-code'] = (el) => { const ap = apOf(el); if (ap) submitCode(ap); };
  P.actions['auth-submit-key'] = (el) => { const ap = apOf(el); if (ap) submitKey(ap); };
  // 第四段：[去系统状态跑一次诊断] 去了就跑一轮（P.requestDiagnose：在别处 = 去系统状态、进页即跑），与横幅 [重新检测]、⌘K「运行诊断」同一个动作
  P.actions['auth-go-system'] = (el) => { const ap = apOf(el); if (!ap) return; leaveDialogTo(ap, 'system', true); };
  P.actions['auth-manage'] = (el) => { const ap = apOf(el); if (!ap) return; leaveDialogTo(ap, 'credentials'); };
  // [管理所有凭证]：去凭证页 = 关掉新建任务弹层（已填的指令不保留，REQ-AUTH-001）
  function leaveDialogTo(ap, view, diagnose) {
    closePanel(ap, { restore: false, cancel: true });
    const m = P.topModal();
    if (m && m.kind === 'new-task') P.closeModal(m, { restoreFocus: false, force: true });
    if (diagnose && P.requestDiagnose) P.requestDiagnose(); else P.go(view);
  }
  function submitCode(ap) {
    const input = $('#st-code', ap.slot); const btn = $('[data-action="auth-submit-code"]', ap.slot);
    if (!input || !input.value.trim() || btn.disabled || P.isBusy(btn)) return;
    const tok = ap.token;
    // 第五段（R1-03）：[提交] 进行中用 aria-busy（焦点不丢）；在粘贴框里按回车提交的，焦点先交给 [提交] 再禁用粘贴框
    if (document.activeElement === input) btn.focus({ preventScroll: true });
    input.value = ''; input.disabled = true; // 提交即清空粘贴框
    P.setBusy(btn, true, P.busyHtml('提交中…'));
    P.announce('提交中…');
    ap.acc.tries = (ap.acc.tries || 0) + 1;
    P.clock.after(T.authSubmit, () => {
      if (!live(ap) || ap.token !== tok || ap.acc.phase !== 'awaiting') return;
      if (P.scenario.is('auth-setup', 'reject-once') && ap.acc.tries === 1) {
        // 第一次被拒（演示）：后端会话已失效时平台自己重新准备链接，用户直接再粘一次就行（Q-AUTH-02 A）
        ap.acc.rejected = true; paintPanel(ap);
        const i2 = $('#st-code', ap.slot); if (i2) i2.focus({ preventScroll: true });
        P.announce('这串授权码不对或已经失效，请重新取一次再粘贴。');
        return;
      }
      succeed(ap, 'account');
    });
  }
  function keyReasons(rt, v) {
    // 照后端格式检查（token-format.validator.ts）判：前缀 → 空白 → 长度，给一条原因
    if (!v.startsWith(rt.prefix)) return [`开头不是 ${rt.prefix}，可能拿错了 key。`];
    if (/\s/.test(v)) return ['里面混进了空格或换行，请重新完整复制一遍。'];
    if (v.length < 16) return ['比正常的 key 短，可能只复制到了一部分。'];
    return [];
  }
  function submitKey(ap) {
    const input = $('#ak', ap.slot); const btn = $('[data-action="auth-submit-key"]', ap.slot);
    if (!input || !input.value.trim() || btn.disabled || P.isBusy(btn)) return;
    const v = input.value.trim();
    const tok = ap.token;
    if (document.activeElement === input) btn.focus({ preventScroll: true }); // 第五段（R1-03）：同 submitCode
    input.value = ''; input.disabled = true; // 提交即清空（不论成败）
    const pre = $('#ak-prefix', ap.slot); if (pre) pre.remove();
    input.removeAttribute('aria-invalid'); input.setAttribute('aria-describedby', 'ak-help');
    P.setBusy(btn, true, P.busyHtml('校验中…'));
    P.announce('校验中…');
    P.clock.after(T.authSubmit, () => {
      if (!live(ap) || ap.token !== tok || ap.tab !== 'key') return;
      const reasons = keyReasons(ap.rt, v);
      if (reasons.length) {
        ap.key = { phase: 'rejected', reasons }; paintPanel(ap);
        const i2 = $('#ak', ap.slot); if (i2) i2.focus({ preventScroll: true });
        P.announce(`这串 API Key 格式不对，没有保存。${reasons.join('')}`);
        return;
      }
      succeed(ap, 'apiKey', { masked: `${ap.rt.prefix}…${v.slice(-4)}` });
    });
  }
  // 成功（三种方式共用，REQ-AUTH-008 / REQ-CRD-011）：原位「已连上」停留 → 数据与依赖它的地方立刻更新 → 轻提示补充 → 停留够了再收起
  function succeed(ap, m, cred) {
    const rt = ap.rt;
    if (!cred) cred = isDevice(rt) ? { masked: 'a***@example.com', daysLeft: 30 } : { masked: 'sk-ant-oat01-…f3a9', mono: true, daysLeft: 30 };
    const prev = rt.active;
    rt[m] = cred;
    // 生效方式（REQ-CRD-011）：从单选来 → 就用这一种；没有可用的生效方式（从未配置 / 已删 / 已过期）→ 这一种；其余只保存
    let switched = false;
    if (ap.fromRadio || !usable(rt, prev)) { switched = prev !== m; rt.active = m; }
    ap.done = true;
    ap.token++;
    // 焦点在面板里，或因 [提交] 进入忙态被禁用而掉到了 body：落到 [收起]（不抢用户移到别处的焦点）
    const lost = () => !document.activeElement || document.activeElement === document.body;
    const hadFocus = ap.root.contains(document.activeElement) || lost();
    paintPanel(ap);
    if (hadFocus) { const col = $('.auth-collapse', ap.root) || (ap.triggerFk && $(`[data-fk="${CSS.escape(ap.triggerFk)}"]`)); if (col) col.focus({ preventScroll: true }); }
    if (ap.host === 'newtask') {
      // 身份句先出现在面板前（f-auth-panel-07），闸门不闪回、[发起] 立刻可用
      ap.note.textContent = `将以 ${rt.identity} 身份运行`;
      ap.root.prepend(ap.note);
    }
    credChanged();
    // 原位「已连上」是主反馈，轻提示只作补充（UX-DS-508）；任一宿主都给（AC-AUTH-008.3）——向导盖着时轻提示挂在向导这块主区（ui.js）
    P.toast('ok', ap.fromRadio && switched ? `已切换到${ws(m)}` : '凭证已更新');
    P.announce('已连上');
    const tok = ap.token;
    P.clock.after(T.authSuccessHold, () => { if (AP.cur === ap && ap.token === tok) closePanel(ap, { restore: ap.root.contains(document.activeElement) || lost() }); });
  }
  // 时钟：设备码倒计时（每秒就地改字；≤ 5 分钟警示色；归零转到期）；面板被拿掉（关弹层、离开页面）= 取消
  P.clock.ticker({
    active: () => !!(AP.cur && AP.cur.tab === 'acc' && AP.cur.acc.phase === 'polling' && !AP.cur.done),
    tick() {
      const ap = AP.cur; if (!ap) return;
      if (!ap.root.isConnected) { closePanel(ap, { restore: false }); return; }
      if (ap.done || ap.tab !== 'acc' || ap.acc.phase !== 'polling') return;
      if (leftSec(ap) <= 0) { ap.acc.phase = 'expired'; paintPanel(ap); P.announce('这串设备码已经到期了。'); return; }
      paintCountdown(ap);
    },
  });
  P.hook('route', (r, changed) => { if (changed && AP.cur && AP.cur.host === 'cred') closePanel(AP.cur, { restore: false, cancel: true }); });
  // ---- 新建任务闸门（f-auth-panel-01 / 02 / 07）：flows-lch.js 的 sync() 先问这里；面板开着时返回 { open: true }
  P.hook('newTask.agent', ({ box, rt }) => {
    const ap = AP.cur;
    if (!ap || ap.host !== 'newtask' || ap.box !== box) return undefined;
    if (!ap.root.isConnected && !box.contains(ap.note)) return undefined;
    if (ap.rt !== rt) { closePanel(ap, { restore: false, cancel: true }); return undefined; } // 换 Agent：已展开的面板收起（取消）
    return { open: true };
  });
  P.actions['auth-gate'] = (btn) => {
    const box = btn.closest('[data-dialog="new-task"]'); if (!box) return;
    const a = ($('input[name="nt-agent"]:checked', box) || {}).value;
    const rt = a && P.runtime(a); if (!rt) return;
    openPanel({ host: 'newtask', rt, tab: 'acc', box });
  };

  // ------------------------------------------------------------------ 剪贴板（与 flows-lch 的「复制诊断信息」同一个场景开关）
  function copyText(text, ok, fail) {
    const mode = P.scenario.get('clipboard');
    if (mode === 'ok') { ok(); return; }
    if (mode === 'fail') { fail(); return; }
    try { const pr = navigator.clipboard && navigator.clipboard.writeText(text); if (!pr || typeof pr.then !== 'function') { fail(); return; } pr.then(ok, fail); } catch (e) { fail(); }
  }
  P.copyText = copyText;

  // ================================================================== 凭证页（P3 + f-crd-*）：Agent 分区、Git 分区、页面级状态
  const cp = { agent: 'ok', git: 'ok', query: '', test: {}, form: null, retrying: false };
  const PLATFORM = { github: ['GitHub', 'github.com'], gitlab: ['GitLab', 'gitlab.com'], gitee: ['Gitee', 'gitee.com'], gitea: ['Gitea', 'gitea.com'], other: ['其他（自建）', null] };
  const GIT_FAIL = {
    auth: '认证失败：凭证无效、没有该仓库访问权限，或目标 host 不在白名单内，请检查凭证与 host 白名单。',
    network: '网络错误，请检查网络后重试。',
    timeout: '测试连接超时（等了 15 秒没有结果）。这只说明没等到回应，不代表凭证有问题。',
  };
  const frag = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; };
  // 只在内容变了时替换（键 = 生成的 HTML），保住没变的部分（面板、表单输入、焦点）
  function patch(el, html) { if (el.dataset.html === html) return el; const n = frag(html); n.dataset.html = html; el.replaceWith(n); return n; }

  // ---- Agent 卡（P3 原样的标记 + f-crd-page-04 的有效期写法）
  function cardHeadHtml(rt) {
    const st = credStatus(rt);
    const badge = st === 'none' ? '<span class="badge badge--inactive"><span class="icon i-square-filled" aria-hidden="true"></span>未配置</span>'
      : st === 'expired' ? '<span class="badge badge--fail"><span class="icon i-x" aria-hidden="true"></span>已过期</span>'
        : st === 'expiring' ? '<span class="badge badge--warn"><span class="icon i-triangle-alert" aria-hidden="true"></span>即将过期</span>'
          : '<span class="badge badge--ok"><span class="icon i-check" aria-hidden="true"></span>有效</span>';
    return `<div class="card__header"><div class="card__header-main"><h3 class="card__title card__title--14" id="${TITLE_ID[rt.id]}">${esc(rt.name)}</h3><span class="card__desc">${esc(rt.vendor)}</span></div>${badge}</div>`;
  }
  function rowHtml(rt, m) {
    const c = rt[m];
    const on = rt.active === m && !!c;
    const ap = AP.cur && AP.cur.host === 'cred' && AP.cur.rt === rt ? AP.cur : null;
    const tab = m === 'account' ? 'acc' : 'key';
    const open = !!(ap && ap.tab === tab && ap.triggerFk === `crd-login:${rt.id}:${tab}`);
    const cur = on ? '<span class="badge badge--20 badge--ok"><span class="icon i-check" aria-hidden="true"></span>当前使用</span>' : '';
    let meta = '';
    if (c && m === 'account') {
      const exp = c.expired ? '<span class="crd-expiry tone-fail"><span class="icon i-x" aria-hidden="true"></span>已过期</span>'
        : c.daysLeft < 7 ? `<span class="crd-expiry tone-warn"><span class="icon i-triangle-alert" aria-hidden="true"></span>${daysText(c)}</span>`
          : `<span class="u-tabular u-nowrap">${daysText(c)}</span>`;
      meta = `<p class="option-row__meta"><span class="${c.mono ? 'text-mono-13 u-truncate' : 'u-truncate'}">${esc(c.masked)}</span><span class="meta-sep" aria-hidden="true"></span>${exp}</p>`;
      if (c.expired) meta += '<p class="option-row__meta crd-row-hint">现在用它发任务会失败，点 [重新登录] 换一份。</p>';
      else if (c.daysLeft < 7) meta += '<p class="option-row__meta crd-row-hint">建议在它到期前重新登录一次，免得任务跑到一半断掉。</p>';
    } else if (c) meta = `<p class="option-row__meta"><span class="text-mono-13 u-truncate">${esc(c.masked)}</span></p>`;
    const label = m === 'account' ? (c ? '重新登录' : '登录帐号') : c ? '更换' : '添加 API Key';
    const fk = `crd-login:${rt.id}:${tab}`;
    const loginBtn = `<button class="btn btn--secondary btn--32${open ? ' is-open' : ''}" type="button" aria-expanded="${open}"${open ? ` aria-controls="${ap.ids.panel}"` : ''} data-action="crd-login" data-rt="${rt.id}" data-tab="${tab}" data-fk="${fk}">${label}</button>`;
    const delBtn = c ? `<button class="btn btn--danger-tertiary btn--32" type="button" data-action="crd-revoke" data-rt="${rt.id}" data-method="${m}" data-fk="crd-del:${rt.id}:${m}">删除</button>` : '';
    return `<div class="option-row"><div class="option-row__main"><label class="option-row__choice"><input class="radio" type="radio" name="${RADIO[rt.id]}" value="${m === 'account' ? 'account' : 'api-key'}" aria-label="${METHOD[m]}"${on ? ' checked' : ''} data-fk="crd-radio:${rt.id}:${m}"><span class="option-row__name">${METHOD[m]}</span>${cur}</label>${meta}</div><div class="btn-row option-row__actions">${loginBtn}${delBtn}</div></div>`;
  }
  // 搜索（REQ-CRD-032）：Agent 名，或任一方式打码标识的可见段（按 *、...、… 切开），不分大小写；不匹配被遮住的中间段
  function cardMatches(rt, q) {
    if (!q) return true;
    if (rt.name.toLowerCase().includes(q)) return true;
    return ['account', 'apiKey'].some((m) => rt[m] && rt[m].masked.split(/\*+|\.\.\.|…/).some((seg) => seg && seg.toLowerCase().includes(q)));
  }
  function paintAgents(host) {
    const sec = host && $('section[aria-labelledby="sec-agent"]', host); if (!sec) return;
    let body = $('[data-crd="agents"]', sec); if (!body) return;
    if (body.dataset.state !== cp.agent) {
      let el;
      if (cp.agent === 'loading') el = P.fromTpl('tpl-crd-sk-agent', { keepRoles: true });
      else if (cp.agent === 'fail') { el = P.fromTpl('tpl-crd-fail-agent', { keepRoles: true }); const b = $('.note__end .btn', el); b.dataset.action = 'crd-retry-load'; b.dataset.part = 'agent'; b.dataset.fk = 'crd-retry:agent'; }
      else { el = document.createElement('div'); el.className = 'stack stack--16'; }
      el.dataset.crd = 'agents'; el.dataset.state = cp.agent;
      const empty = $('.crd-empty-line', sec); if (empty) empty.remove();
      body.replaceWith(el); body = el;
    }
    if (cp.agent !== 'ok') return;
    for (const rt of world.runtimes) {
      let card = $(`:scope > [data-rt="${rt.id}"]`, body);
      if (!card) {
        card = frag(`<div class="card card--lg" role="group" aria-label="${esc(rt.name)}" data-rt="${rt.id}"><div class="card__header"></div><div class="option-list" role="radiogroup" aria-labelledby="${TITLE_ID[rt.id]}"><div class="option-row"></div><div class="option-row"></div></div></div>`);
        body.appendChild(card);
      }
      patch($('.card__header', card), cardHeadHtml(rt));
      const rows = $$('.option-list > .option-row', card);
      patch(rows[0], rowHtml(rt, 'account'));
      patch(rows[1], rowHtml(rt, 'apiKey'));
      // 单选只反映「当前使用」（点了之后确认 / 配好之前不动，REQ-CRD-012）
      for (const r of $$('input[type="radio"]', card)) r.checked = rt.active === (r.value === 'account' ? 'account' : 'apiKey') && !!credOf(rt);
      card.hidden = !cardMatches(rt, cp.query);
    }
    const anyShown = world.runtimes.some((rt) => cardMatches(rt, cp.query));
    body.hidden = !anyShown;
    let empty = $('.crd-empty-line', sec);
    if (!anyShown && !empty) { empty = P.fromTpl('tpl-crd-empty-line', { keepRoles: true }); body.after(empty); P.announce('没有匹配的 Agent。'); }
    else if (anyShown && empty) empty.remove();
  }

  // ---- Git 分区（f-crd-git-01…05、f-crd-page-05）
  const gitHostOf = (repo) => { const m = /^https?:\/\/([^/]+)\//.exec(repo || ''); return m ? m[1].toLowerCase() : null; };
  const isSshRepo = (repo) => /^(git@|ssh:\/\/)/.test(repo || '');
  function resultHtml(r, id) {
    // f-crd-git-01 的结果句（成功写法）为底：进行中 / 失败换类名、实时角色、图标与句子（REQ-CRD-023 原位三态）
    const p = P.fromTpl('tpl-crd-git-result', { keepRoles: true });
    const [icon, text] = p.children;
    if (id) p.id = id;
    if (r.phase === 'pending') { p.className = 'crd-result crd-result--pending'; p.setAttribute('role', 'status'); icon.className = 'icon i-loader-circle icon--spin'; text.textContent = '正在测试连接…（最多 15 秒）'; }
    else if (r.phase !== 'ok') { p.className = 'crd-result crd-result--fail'; p.setAttribute('role', 'alert'); icon.className = 'icon i-circle-x'; text.textContent = GIT_FAIL[r.code] || GIT_FAIL.auth; }
    return p.outerHTML;
  }
  function gitBtns(kind) {
    const pending = cp.test[kind] && cp.test[kind].phase === 'pending';
    return `<div class="card__body-end"><button class="btn btn--secondary btn--32" type="button" data-action="crd-git-replace" data-kind="${kind}" data-fk="crd-git-replace:${kind}">更换</button><button class="btn btn--secondary btn--32${pending ? ' is-loading' : ''}" type="button"${pending ? ' aria-disabled="true" aria-busy="true"' : ''} data-action="crd-git-test" data-kind="${kind}" data-fk="crd-git-test:${kind}">测试连接</button><button class="btn btn--danger-tertiary btn--32" type="button" data-action="crd-git-delete" data-kind="${kind}" data-fk="crd-git-del:${kind}">删除</button></div>`;
  }
  function gitFooter(missing) {
    return `<div class="card__footer"><span class="card__footer-help">添加其他类型凭证：</span><div class="card__footer-end"><button class="btn btn--secondary btn--32" type="button" data-action="crd-git-config" data-kind="${missing}" data-fk="crd-git-add:${missing}">${missing === 'ssh' ? '配置 SSH 密钥' : '配置 HTTPS Token'}</button></div></div>`;
  }
  function httpsCardHtml(c, only) {
    const kv = `<dt>类型：</dt><dd class="u-medium">HTTPS Token</dd><dt>Token 尾号：</dt><dd class="u-break-all"><span class="text-mono-13">${esc(c.masked)}</span></dd><dt>host 白名单：</dt><dd>${esc(c.hosts.join('、'))}</dd>${c.lastUsed ? `<dt>最后使用：</dt><dd>${esc(c.lastUsed)}</dd>` : ''}`;
    const t = cp.test.https;
    // 没有测试结果时与 P3 原样（dl.kv.u-grow）；有结果时左栏 = 键值 + 结果句（f-crd-git-01 .crd-git-main）
    const left = t ? `<div class="crd-git-main"><dl class="kv">${kv}</dl>${resultHtml(t)}</div>` : `<dl class="kv u-grow">${kv}</dl>`;
    return `<div class="card card--lg" data-key="https"><div class="card__body card__body--split" role="group" aria-label="HTTPS Token">${left}${gitBtns('https')}</div>${only ? gitFooter('ssh') : ''}</div>`;
  }
  function sshCardHtml(c, only) {
    // 结构取 f-crd-git-04 的 SSH 卡；「已记录主机指纹」块按 DR-14 默认不画（后端还不写 knownHosts）
    const body = P.fromTpl('tpl-crd-ssh-body');
    const kh = $('.crd-knownhosts', body); if (kh) kh.remove();
    const dl = $('dl', body);
    dl.innerHTML = `<dt>类型：</dt><dd class="u-medium">SSH 私钥</dd><dt>指纹：</dt><dd class="u-break-all"><span class="text-mono-13">${esc(c.fingerprint)}</span></dd>${c.lastUsed ? `<dt>最后使用：</dt><dd>${esc(c.lastUsed)}</dd>` : ''}`;
    const t = cp.test.ssh;
    if (t) $('.crd-git-main', body).insertAdjacentHTML('beforeend', resultHtml(t));
    $('.card__body-end', body).outerHTML = gitBtns('ssh');
    return `<div class="card card--lg" data-key="ssh">${body.outerHTML}${only ? gitFooter('https') : ''}</div>`;
  }
  function emptyCardHtml() {
    const body = P.fromTpl('tpl-crd-git-empty');
    const [ssh, https] = $$('.btn', body);
    Object.assign(ssh.dataset, { action: 'crd-git-config', kind: 'ssh', fk: 'crd-git-add:ssh' });
    Object.assign(https.dataset, { action: 'crd-git-config', kind: 'https', fk: 'crd-git-add:https' });
    return `<div class="card card--lg" data-key="empty">${body.outerHTML}</div>`;
  }
  function returnBarHtml(p) {
    const bar = P.fromTpl('tpl-crd-return', { keepRoles: true });
    $('.note__text', bar).textContent = `为项目「${p.name}」配置凭证后，可重试克隆。`;
    const [retry, give] = $$('.note__actions .btn', bar);
    Object.assign(retry.dataset, { action: 'crd-retry-clone', fk: 'crd-retry-clone' });
    Object.assign(give.dataset, { action: 'crd-giveup', fk: 'crd-giveup' });
    if (cp.retrying) {
      give.disabled = true;
      P.setBusy(retry, true, P.busyHtml('重试中…')); // 第五段（R1-03）：重画后焦点按 data-fk 找回到这颗按钮（aria-busy，不是原生 disabled）
    }
    bar.dataset.key = 'return';
    return bar.outerHTML;
  }
  const pendingClone = () => { const pc = ui.pendingProjectCreate; const p = pc && P.proj(pc.projectId); return p && p.status === 'failed' ? p : null; };
  function paintGit(host) {
    const sec = host && $('section[aria-labelledby="sec-git"]', host); if (!sec) return;
    let body = $('[data-crd="git"]', sec); if (!body) return;
    if (body.dataset.state !== cp.git) {
      let el;
      if (cp.git === 'loading') el = P.fromTpl('tpl-crd-sk-git', { keepRoles: true });
      else if (cp.git === 'fail') { el = P.fromTpl('tpl-crd-fail-git', { keepRoles: true }); const b = $('.note__end .btn', el); b.dataset.action = 'crd-retry-load'; b.dataset.part = 'git'; b.dataset.fk = 'crd-retry:git'; }
      else el = document.createElement('div');
      el.dataset.crd = 'git'; el.dataset.state = cp.git;
      body.replaceWith(el); body = el;
      if (cp.git !== 'ok' && cp.form) cp.form = null; // 读不到时不出表单与「未配置」卡（REQ-CRD-031）
    }
    if (cp.git !== 'ok') return;
    const g = world.gitCreds;
    const items = [];
    const p = pendingClone();
    if (p) items.push(['return', returnBarHtml(p)]);
    const only = !!g.https !== !!g.ssh;
    if (g.https) items.push(['https', httpsCardHtml(g.https, only)]);
    if (g.ssh) items.push(['ssh', sshCardHtml(g.ssh, only)]);
    if (!g.https && !g.ssh) items.push(['empty', emptyCardHtml()]);
    // 一个以上的块用 .stack（回程条 / 两张卡 / 表单，f-crd-git-03 / 04、f-crd-page-05）；只有一张卡时与 P3 一样直接放
    const want = items.map(([k, html]) => { let el = $(`:scope > [data-key="${k}"]`, body); if (el && el.dataset.html === html) return el; const n = frag(html); n.dataset.html = html; if (el) el.replaceWith(n); return n; });
    if (cp.form) want.push(cp.form.el);
    for (const el of [...body.children]) if (!want.includes(el)) el.remove();
    want.forEach((el, i) => { if (body.children[i] !== el) body.insertBefore(el, body.children[i] || null); });
    body.className = want.length > 1 ? 'stack stack--16' : '';
    P.upgradeTips(body);
  }
  function paintCredentials(host) {
    // 变了的段整段换掉（按钮文字、打开态…）：焦点按 data-fk 找回；找回的按钮若进入忙态被禁用，就等结果出来再还
    const a = document.activeElement, afk = a && a.getAttribute && a.getAttribute('data-fk');
    paintAgents(host); paintGit(host);
    if (afk && a !== document.activeElement && !a.isConnected) { const again = $(`[data-fk="${CSS.escape(afk)}"]`); if (again && !again.disabled && P.isShown(again)) again.focus({ preventScroll: true }); }
  }

  // ---- 视图：wire / refresh
  P.views['tpl-credentials'] = {
    wire(main) {
      Object.assign(cp, { agent: 'ok', git: 'ok', query: '', test: {}, form: null, retrying: false });
      const load = P.scenario.get('cred-load');
      if (load === 'fail') { cp.agent = 'fail'; cp.git = 'fail'; } else if (load === 'fail-git') cp.git = 'fail';
      else if (load === 'slow') {
        cp.agent = 'loading'; cp.git = 'loading';
        const key = P.viewKey();
        P.clock.after(T.credLoad, () => { if (P.viewKey() !== key || P.ui.loading) return; cp.agent = 'ok'; cp.git = 'ok'; P.render(); P.announce('凭证已读取'); });
      }
      // P3 的两块静态内容换成按数据画的容器（Agent 的 .stack 留着，Git 的卡换成一个容器）
      const agentStack = $('section[aria-labelledby="sec-agent"] .stack', main);
      agentStack.dataset.crd = 'agents'; agentStack.dataset.state = 'ok'; agentStack.textContent = '';
      const gitCard = $('section[aria-labelledby="sec-git"] > .card', main);
      const gitBox = document.createElement('div'); gitBox.dataset.crd = 'git'; gitBox.dataset.state = 'ok';
      gitCard.replaceWith(gitBox);
      const search = $('input[type="search"]', main);
      search.dataset.fk = 'crd-search';
      search.addEventListener('input', () => { cp.query = search.value.trim().toLowerCase(); paintAgents($('#shell-main')); });
      main.addEventListener('change', onRadioChange);
      // 从项目流程跳来（[配置 Git 凭证]、拉取失败）：视口落到 Git 分区并聚焦它的标题（克隆失败来的另有回程条）
      if (ui.focusSection) {
        const id = ui.focusSection; ui.focusSection = null;
        const sec = $(`#${CSS.escape(id)}`, main);
        const h = sec && ($('h2, h3', sec) || sec);
        if (h) { h.setAttribute('tabindex', '-1'); requestAnimationFrame(() => { h.scrollIntoView({ block: 'start' }); h.focus({ preventScroll: true }); }); }
      }
    },
    refresh(host) { paintCredentials(host); },
  };
  // 直接打开 #credentials（含刷新）：首屏骨架就是本页骨架（f-crd-page-01；F-WB-SHELL 的路由规则）
  P.hook('loading.tpl', (r) => (r.view === 'credentials' ? 'tpl-credentials' : undefined));
  P.hook('loading:wired', (tplId, main) => {
    if (tplId !== 'tpl-credentials') return;
    const a = $('section[aria-labelledby="sec-agent"] .stack', main);
    const sk1 = P.fromTpl('tpl-crd-sk-agent', { keepRoles: true }); a.replaceWith(sk1);
    const g = $('section[aria-labelledby="sec-git"] > .card', main);
    const sk2 = P.fromTpl('tpl-crd-sk-git', { keepRoles: true }); g.replaceWith(sk2);
  });
  // 离开凭证页：回程只活在这一次（REQ-CRD-034）
  P.hook('route', (r) => { if (r.view !== 'credentials') { ui.pendingProjectCreate = null; ui.pendingProjectSync = null; cp.form = null; } });
  P.actions['crd-retry-load'] = (el) => {
    const part = el.dataset.part;
    cp[part] = 'loading'; P.render();
    const key = P.viewKey();
    P.clock.after(T.credRetry, () => {
      if (P.viewKey() !== key) return;
      cp[part] = 'ok';
      if (cp.agent === 'ok' && cp.git === 'ok' && P.scenario.get('cred-load').startsWith('fail')) P.scenario.reset('cred-load'); // [重试] 后复位
      P.render();
      const f = part === 'agent' ? $('[data-fk="crd-search"]') : $('#sec-git');
      if (f) { if (!f.matches('input')) f.setAttribute('tabindex', '-1'); f.focus({ preventScroll: true }); }
      P.announce(part === 'agent' ? 'Agent 列表已读取' : 'Git 凭证已读取');
    });
  };

  // ---- Agent 卡的动作：登录 / 添加 / 更换（展开面板）、删除（确认框）、单选（切换生效方式）
  P.actions['crd-login'] = (el) => {
    const rt = P.runtime(el.dataset.rt); if (!rt) return;
    const tab = el.dataset.tab;
    const fk = el.dataset.fk;
    if (AP.cur && AP.cur.host === 'cred' && AP.cur.triggerFk === fk) { closePanel(AP.cur, { cancel: true }); return; } // 再点一次 = 收起
    const card = el.closest('.card[data-rt]'); // 按钮自己也带 data-rt：找外层的卡
    openPanel({ host: 'cred', rt, tab, card, triggerFk: fk, fromRadio: false });
  };
  function onRadioChange(e) {
    const r = e.target;
    if (!(r instanceof HTMLInputElement) || r.type !== 'radio' || !r.closest('.option-list')) return;
    const card = r.closest('.card[data-rt]'); if (!card) return;
    const rt = P.runtime(card.dataset.rt);
    const m = r.value === 'account' ? 'account' : 'apiKey';
    paintAgents($('#shell-main')); // 先把单选恢复原样（确认之前不动）
    if (rt.active === m && credOf(rt)) return;
    if (rt[m]) openModeDialog(rt, m, { returnFk: `crd-radio:${rt.id}:${m}` });
    else {
      // 目标方式没配：不弹框、不报错，就地展开那种方式的面板，配好即切换（REQ-CRD-011 第 1 条）
      openPanel({ host: 'cred', rt, tab: m === 'account' ? 'acc' : 'key', card, triggerFk: `crd-radio:${rt.id}:${m}`, fromRadio: true }); // 收起时焦点回这个单选
    }
  }

  // ================================================================== F-CRD-MODE 切换生效方式（f-crd-mode-01；删除后的追问是同一个框的变体）
  function openModeDialog(rt, m, { returnFk, afterDelete } = {}) {
    const box = P.fromTpl('tpl-crd-mode');
    box.dataset.dialog = 'crd-mode';
    $('.dialog__title', box).textContent = `切换到${ws(m)}`;
    const sub = $('.dialog__subtitle', box);
    if (afterDelete) sub.remove();
    else sub.textContent = `${rt.name} · 当前使用：${rt.active && credOf(rt) ? METHOD[rt.active] : '没有生效的凭证'}`;
    $('#sw-desc', box).textContent = afterDelete
      ? `这个 Agent 现在没有可用的凭证了。它的${wm(m)}还留着 —— 要现在切过去用吗？`
      : m === 'apiKey' ? '之后新开的任务会用 API Key（按量计费），已经在跑的任务不受影响。' : '之后新开的任务会用帐号登录（走订阅额度），已经在跑的任务不受影响。';
    const cancel = $('.dialog__footer > .btn', box); cancel.dataset.dlg = 'cancel';
    const ok = $('.dialog__footer-end .btn', box); ok.dataset.dlg = 'ok'; ok.textContent = afterDelete ? '切过去' : '切换';
    $('.dialog__close', box).dataset.dlg = 'cancel';
    const ret = returnFk && $(`[data-fk="${CSS.escape(returnFk)}"]`);
    const mm = P.openModal(box, { kind: 'crd-mode', returnTo: ret || null, initialFocus: '[data-initial-focus]' });
    if (returnFk) mm.returnFk = returnFk;
    mm.box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dlg]'); if (!b || mm.busy) return;
      if (b.dataset.dlg === 'cancel') { P.closeModal(mm); return; }
      // [切换]：切换中（按钮忙、不可重复提交）→ 成功：「当前使用」与单选移到新的一行 + 轻提示
      mm.busy = true;
      cancel.disabled = true; for (const x of $$('.dialog__close', mm.box)) x.disabled = true;
      P.setBusy(ok, true, P.busyHtml('切换中…')); // 第五段（R1-03）：焦点留在 [切换] 上
      P.announce('切换中…');
      P.clock.after(T.modeSwitch, () => {
        mm.busy = false;
        rt.active = m;
        P.closeModal(mm, { restoreFocus: false });
        credChanged();
        P.toast('ok', `已切换到${ws(m)}`);
        const r = $(`[data-fk="crd-radio:${rt.id}:${m}"]`); if (r) r.focus({ preventScroll: true }); else P.focusMain();
      });
    });
    return mm;
  }
  P.openModeDialog = openModeDialog;

  // ================================================================== F-CRD-REVOKE 删除 Agent 凭证（f-crd-revoke-01…03）
  function revokeBody(rt, m, impact) {
    const o = other(m);
    const vendorNote = `担心已经外流的话，去 ${CONSOLE[rt.vendor] || `${rt.vendor} 后台`}把它作废，只有那边能让它真正失效。`;
    const cant = `<div class="dconfirm__block"><div class="dconfirm__title">平台删不掉</div><ul class="bullets"><li>已经从任务里带出去的 ${m === 'account' ? 'token' : 'key'}<span class="dconfirm__note">${esc(vendorNote)}</span></li></ul></div>`;
    const after = [];
    if (rt.active === m) {
      after.push(rt[o] ? `这个 Agent 现在用的就是它，删掉就不能用了 —— 它的${wm(o)}还留着，删完会问你要不要切过去` : `这个 Agent 现在用的就是它，删掉就不能用了 —— 要再发 ${esc(rt.name)} 任务，先登录帐号或重新添加 API Key`);
      for (const t of (impact ? impact.preparing : [])) {
        after.push(`${esc(t.name)} <span class="dconfirm__meta">· ${esc(rt.name)} · 准备中</span><span class="dconfirm__note">还没注入凭证，不会被销毁；但它启动时 ${esc(rt.name)} 若还没有可用的凭证（没切到${ws(o)}、也没${m === 'account' ? '重新登录' : '重新添加 API Key'}），会以未登录状态起来。</span>`);
      }
    }
    const afterBlock = after.length ? `<div class="dconfirm__block"><div class="dconfirm__title">删掉之后</div><ul class="bullets">${after.map((x) => `<li>${x}</li>`).join('')}</ul></div>` : '';
    if (!impact) {
      // 清单读不到（f-crd-revoke-02）：警示块 + [重试读取]；不说成「没有任务」，按钮写「删除凭证」
      const warn = P.fromTpl('tpl-crd-revoke-warn', { keepRoles: true });
      const b = $('.note__actions .btn', warn); b.dataset.dlg = 'retry'; b.dataset.fk = 'revoke-retry';
      return warn.outerHTML
        + '<div class="dconfirm__block"><div class="dconfirm__title">会留下</div><ul class="bullets"><li>被销毁任务的代码副本，自动保留为成果，30 天后自动清理</li></ul></div>'
        + cant + afterBlock + '<p class="dconfirm__source">清单来源：后端凭证绑定表（这次没读出来）。</p>';
    }
    const n = impact.destroy.length;
    if (n) {
      // 有清单（f-crd-revoke-01）：最多列 10 条，多出的折成「等共 N 个」（PARAM.REVOKE_LIST_MAX）
      const list = impact.destroy.slice(0, 10).map((t) => `<li>${esc(t.name)} <span class="dconfirm__meta">· ${esc(rt.name)} · ${STATE_WORD(t)}</span></li>`).join('') + (n > 10 ? `<li>等共 ${n} 个</li>` : '');
      const keep = rt[o] ? `${esc(rt.name)} 的${ws(o)}、Git 凭证：都不动` : 'Git 凭证：不动';
      return `<div class="dconfirm__block"><div class="dconfirm__title">会销毁这 ${n} 个任务</div><ul class="bullets">${list}</ul></div>`
        + `<div class="dconfirm__block"><div class="dconfirm__title">会留下</div><ul class="bullets"><li>这 ${n} 个任务的代码副本，自动保留为成果，30 天后自动清理</li></ul></div>`
        + cant + afterBlock
        + `<div class="dconfirm__block dconfirm__block--untouched"><div class="dconfirm__title">不受影响</div><ul class="bullets"><li>${keep}</li><li>其他 Agent 的任务：这份凭证只注入 ${esc(rt.name)} 自己的任务</li><li>各项目的代码和远端 Git 仓库：都不动</li></ul></div>`
        + '<p class="dconfirm__source">清单来源：后端凭证绑定表，不在前端按 Agent 自己算。</p>';
    }
    // 没有任务在用（f-crd-revoke-03）
    return `<div class="dconfirm__block"><div class="dconfirm__title">会删掉</div><ul class="bullets"><li>这台机器上保存的这份${wm(m)}<span class="dconfirm__meta">（${esc(rt[m].masked)}）</span></li></ul></div>`
      + cant + afterBlock
      + '<div class="dconfirm__block dconfirm__block--untouched"><div class="dconfirm__title">不受影响</div><ul class="bullets"><li>现在没有任务在用这份凭证，不会销毁任何任务</li></ul></div>'
      + '<p class="dconfirm__source">清单来源：后端凭证绑定表（没有记录）。</p>';
  }
  function openRevoke(rt, m, returnFk) {
    const box = P.fromTpl('tpl-crd-revoke');
    box.dataset.dialog = 'crd-revoke';
    $('.dialog__title', box).textContent = `删除 ${rt.name} 的${m === 'apiKey' ? ' API Key' : '帐号登录'}？`;
    $('.dialog__subtitle', box).textContent = rt.active === m ? '凭证 · 当前在用' : '凭证';
    const body = $('.dialog__body', box);
    const cancel = $('.dialog__footer > .btn', box); cancel.dataset.dlg = 'cancel'; cancel.dataset.fk = 'revoke-cancel';
    const danger = $('.btn--danger', box); danger.dataset.dlg = 'confirm'; danger.dataset.fk = 'revoke-confirm';
    $('.dialog__close', box).dataset.dlg = 'cancel';
    const fill = (impact) => {
      body.innerHTML = revokeBody(rt, m, impact);
      danger.textContent = impact && impact.destroy.length ? `删除并销毁 ${impact.destroy.length} 个任务` : '删除凭证';
    };
    fill(P.scenario.is('revoke-list', 'fail') ? null : revokeImpact(rt, m));
    const ret = $(`[data-fk="${CSS.escape(returnFk)}"]`);
    const mm = P.openModal(box, { kind: 'crd-revoke', returnTo: ret, initialFocus: '[data-initial-focus]' });
    mm.returnFk = returnFk;
    mm.box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dlg]'); if (!b || mm.busy) return;
      if (b.dataset.dlg === 'cancel') { P.closeModal(mm); return; }
      if (b.dataset.dlg === 'retry') {
        // [重试读取]：同一个框里换成清单（或「没有任务在用」），框不关、焦点留在框内（AC-CRD-002.4）
        P.setBusy(b, true, P.busyHtml('重试读取')); // 第五段（R1-03，AC-CRD-002.4）：重试中焦点留在框内这颗按钮上，不出框
        P.clock.after(T.revokeRetry, () => {
          if (!P.modals.includes(mm)) return;
          P.scenario.reset('revoke-list');
          const impact = revokeImpact(rt, m);
          fill(impact);
          cancel.focus({ preventScroll: true });
          P.announce(impact.destroy.length ? `读到了：会销毁 ${impact.destroy.length} 个任务` : '读到了：现在没有任务在用这份凭证');
        });
        return;
      }
      // 确认：两个按钮禁用、「删除中…」，Esc 不关
      mm.busy = true;
      cancel.disabled = true; for (const x of $$('.dialog__close', mm.box)) x.disabled = true;
      P.setBusy(danger, true, P.busyHtml('删除中…')); // 第五段（R1-03）：焦点留在 [删除凭证] 上
      P.announce('删除中…');
      P.clock.after(T.revoke, () => {
        mm.busy = false;
        P.closeModal(mm, { restoreFocus: false });
        if (P.scenario.take('crd-delete') === 'fail') {
          // 失败：关框，轻提示前端句（不上屏后端 message），凭证不变（AC-CRD-005.3）
          P.toast('fail', '删除失败，请稍后重试。');
          const f = $(`[data-fk="${CSS.escape(returnFk)}"]`); if (f) f.focus({ preventScroll: true });
          return;
        }
        finishRevoke(rt, m);
      });
    });
    return mm;
  }
  function finishRevoke(rt, m) {
    const wasActive = rt.active === m;
    const impact = revokeImpact(rt, m); // 按删除这一刻的绑定销毁（与后端同一口径）
    rt[m] = null;
    if (wasActive) rt.active = null;
    P.toast('ok', '已删除');
    // 清单里的任务：删除中 → 移除（代码副本保留为成果；树组计数、徽标、总览由 render 一起变——F-SBX-DESTROY 的过程）
    for (const t of impact.destroy) P.destroyTask(t, true, { firstLaunch: false });
    credChanged();
    const o = other(m);
    if (wasActive && rt[o]) {
      // 删的是在用的那份、另一种还在：追问要不要切过去（REQ-CRD-004；取消 = 没有生效方式，卡头「未配置」）
      openModeDialog(rt, o, { afterDelete: true, returnFk: `crd-radio:${rt.id}:${o}` });
      return;
    }
    const f = $(`[data-fk="crd-login:${rt.id}:${m === 'account' ? 'acc' : 'key'}"]`);
    if (f) f.focus({ preventScroll: true }); else P.focusMain();
  }
  P.actions['crd-revoke'] = (el) => { const rt = P.runtime(el.dataset.rt); if (rt && rt[el.dataset.method]) openRevoke(rt, el.dataset.method, el.dataset.fk); };

  // ================================================================== F-CRD-GIT Git 凭证（f-crd-git-01…05）
  function testOutcome(kind, hosts) {
    const scen = P.scenario.get('git-test');
    if (scen !== 'auto') return scen;
    // 目标仓库：从克隆失败跳来时 = 那个项目的仓库；其它时候 = 白名单第一个 host 的根地址（现状，Q-CRD-03 默认 B）
    const p = pendingClone();
    const target = p && p.repo ? { host: gitHostOf(p.repo), ssh: isSshRepo(p.repo) } : { host: kind === 'https' ? (hosts || [])[0] : null, ssh: kind === 'ssh' };
    if (kind === 'https') return target.ssh || !target.host || !(hosts || []).includes(target.host) ? 'auth' : 'ok'; // Token 只发给白名单里的 host（REQ-CRD-024）
    return target.ssh || !p ? 'ok' : 'auth';
  }
  P.actions['crd-git-test'] = (el) => {
    const kind = el.dataset.kind; const c = world.gitCreds[kind]; if (!c) return;
    // 原位三态（REQ-CRD-023）：进行中句 + 本按钮禁用 → 成功 / 失败（按码说人话）；结果不用轻提示
    cp.test[kind] = { phase: 'pending' }; P.render();
    P.announce('正在测试连接…（最多 15 秒）');
    const key = P.viewKey();
    P.clock.after(T.gitTest, () => {
      if (P.viewKey() !== key || !world.gitCreds[kind]) return;
      const out = testOutcome(kind, c.hosts);
      cp.test[kind] = out === 'ok' ? { phase: 'ok' } : { phase: 'fail', code: out };
      P.render();
      P.announce(out === 'ok' ? '连接成功' : GIT_FAIL[out]);
      const a = document.activeElement, b = $(`[data-fk="crd-git-test:${kind}"]`);
      if (b && (!a || a === document.body || a.id === 'main')) b.focus({ preventScroll: true }); // 进行中按钮禁用时焦点被挤到主区：结果出来还给它
    });
  };
  // ---- 表单（配置 HTTPS Token / 配置 SSH 密钥；分区底部就地展开，同一时刻一张）
  function openGitForm(kind, mode, triggerFk) {
    const prev = world.gitCreds.https;
    const f = { kind, mode, triggerFk, platform: mode === 'replace' && prev ? prev.platform : 'github', hosts: mode === 'replace' && prev ? prev.hosts.slice() : ['github.com'], test: null, saving: false };
    const el = P.fromTpl(kind === 'https' ? 'tpl-crd-https-form' : 'tpl-crd-ssh-form');
    el.dataset.key = 'form'; el.dataset.kind = kind;
    for (const r of $$('.crd-result', el)) r.remove();
    const [cancel, test, save] = [$('.card__footer > .btn', el), $('.card__footer-end .btn--secondary', el), $('[type="submit"]', el)];
    Object.assign(cancel.dataset, { action: 'crd-form-cancel', fk: 'crd-form-cancel' });
    Object.assign(test.dataset, { action: 'crd-form-test', fk: 'crd-form-test' });
    Object.assign(save.dataset, { action: 'crd-form-save', fk: 'crd-form-save' });
    if (kind === 'https') {
      $('#crd-https-token', el).value = '';
      $('#crd-https-token', el).dataset.fk = 'crd-token';
      for (const r of $$('input[name="git-platform"]', el)) { r.checked = r.value === f.platform; r.dataset.fk = `crd-platform:${r.value}`; }
      const add = $('.crd-host-add .btn', el); Object.assign(add.dataset, { action: 'crd-host-add', fk: 'crd-host-add' });
      const hi = $('.crd-host-add .input', el); hi.dataset.fk = 'crd-host-input';
      hi.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addHost(); } });
      $('#crd-https-form', el).textContent = '配置 HTTPS Token';
    } else {
      const ta = $('#crd-ssh-key', el); ta.value = ''; ta.removeAttribute('aria-describedby'); ta.dataset.fk = 'crd-ssh-key';
      const w = $('#crd-ssh-warn', el); if (w) w.remove();
    }
    el.addEventListener('input', () => paintForm());
    el.addEventListener('change', (e) => { if (e.target.name === 'git-platform') { f.platform = e.target.value; const h = PLATFORM[f.platform][1]; f.hosts = h ? [h] : []; paintForm(); } });
    el.addEventListener('submit', (e) => { e.preventDefault(); saveForm(); });
    f.el = el;
    cp.form = f;
    paintForm();
    P.render();
    requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest' }));
    const first = kind === 'https' ? (mode === 'replace' ? $('#crd-https-token', el) : $('input[name="git-platform"]:checked', el)) : $('#crd-ssh-key', el);
    first.focus({ preventScroll: true });
    P.announce(kind === 'https' ? '已展开「配置 HTTPS Token」' : '已展开「配置 SSH 密钥」');
  }
  // SSH 私钥本地预检（REQ-CRD-022）：带 passphrase → 那一句；不像私钥（多半粘成了 .pub）→ 那一句；都禁用测试与保存
  function sshCheck(v) {
    if (!v.trim()) return null;
    if (/Proc-Type:\s*4,ENCRYPTED|BEGIN ENCRYPTED PRIVATE KEY|DEK-Info:/.test(v)) return '检测到带 passphrase 的私钥，当前不支持，请改用无口令的密钥。';
    if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(v)) return '这看起来不是私钥（应以 -----BEGIN … PRIVATE KEY----- 开头）。最常见的原因是粘成了 .pub 公钥文件 —— 要的是没有 .pub 后缀的那一个（如 id_ed25519）。';
    return '';
  }
  function paintForm() {
    const f = cp.form; if (!f) return;
    const el = f.el;
    let ready;
    if (f.kind === 'https') {
      const row = $('.chip-row', el);
      const html = f.hosts.map((h) => `<span class="chip chip--removable">${esc(h)}<button class="chip__remove" type="button" aria-label="移除 ${esc(h)}" data-action="crd-host-remove" data-host="${esc(h)}" data-fk="crd-host-rm:${esc(h)}"><span class="icon i-x" aria-hidden="true"></span></button></span>`).join('');
      if (row.dataset.html !== html) { row.innerHTML = html; row.dataset.html = html; }
      row.hidden = !f.hosts.length;
      ready = !!$('#crd-https-token', el).value.trim() && f.hosts.length > 0; // Token 空或白名单空 → 测试与保存禁用（AC-CRD-021.2）
    } else {
      const ta = $('#crd-ssh-key', el);
      const warn = sshCheck(ta.value);
      let w = $('#crd-ssh-warn', el);
      if (warn) {
        if (!w) { w = document.createElement('p'); w.className = 'crd-result crd-result--warn'; w.id = 'crd-ssh-warn'; w.setAttribute('role', 'alert'); ta.closest('.field').after(w); }
        const html = `<span class="icon i-triangle-alert" aria-hidden="true"></span><span>${esc(warn)}</span>`;
        if (w.innerHTML !== html) w.innerHTML = html;
        ta.setAttribute('aria-describedby', 'crd-ssh-warn'); ta.setAttribute('aria-invalid', 'true');
      } else if (w) { w.remove(); ta.removeAttribute('aria-describedby'); ta.removeAttribute('aria-invalid'); }
      ready = warn === '';
    }
    const res = $('#crd-form-result', el);
    if (f.test) {
      const html = resultHtml(f.test, 'crd-form-result');
      if (!res || res.outerHTML !== html) { const n = frag(html); if (res) res.replaceWith(n); else $('.fields', el).appendChild(n); }
    } else if (res) res.remove();
    // 第五段（R1-03）：进行中的那颗按钮用 aria-busy（焦点不丢）；条件不满足（Token / 白名单空、私钥预检不过）仍是原生 disabled
    const testing = !!(f.test && f.test.phase === 'pending');
    const tb = $('[data-action="crd-form-test"]', el), sb = $('[data-action="crd-form-save"]', el);
    if (testing) P.setBusy(tb, true); else { P.setBusy(tb, false); tb.disabled = !ready || f.saving; }
    if (f.saving) { if (el.contains(document.activeElement) && document.activeElement !== sb) sb.focus({ preventScroll: true }); P.setBusy(sb, true, P.busyHtml('保存中…')); }
    else { P.setBusy(sb, false, '保存'); sb.disabled = !ready; }
    $('[data-action="crd-form-cancel"]', el).disabled = f.saving;
    for (const x of $$('input, textarea', el)) x.disabled = f.saving;
    for (const x of $$('.chip__remove, .crd-host-add .btn', el)) x.disabled = f.saving;
  }
  function addHost() {
    const f = cp.form; if (!f) return;
    const i = $('.crd-host-add .input', f.el);
    const h = i.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!h) return;
    if (!f.hosts.includes(h)) f.hosts.push(h);
    i.value = '';
    paintForm();
    P.announce(`已添加 ${h}`);
  }
  P.actions['crd-host-add'] = () => addHost();
  P.actions['crd-host-remove'] = (el) => {
    const f = cp.form; if (!f) return;
    f.hosts = f.hosts.filter((h) => h !== el.dataset.host);
    paintForm();
    $('.crd-host-add .input', f.el).focus({ preventScroll: true });
    P.announce(`已移除 ${el.dataset.host}`);
  };
  function closeForm(focusFk) {
    const f = cp.form; if (!f) return;
    cp.form = null;
    P.render();
    const t = $(`[data-fk="${CSS.escape(focusFk || f.triggerFk || '')}"]`);
    if (t && P.isShown(t)) t.focus({ preventScroll: true }); else { const h = $('#sec-git'); if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); } }
  }
  P.actions['crd-form-cancel'] = () => closeForm(); // 只收起、清空，旧的那份不动（AC-CRD-025.4）
  P.actions['crd-form-test'] = () => {
    const f = cp.form; if (!f) return;
    f.test = { phase: 'pending' }; paintForm();
    P.announce('正在测试连接…（最多 15 秒）');
    P.clock.after(T.gitTest, () => {
      if (cp.form !== f) return;
      const out = testOutcome(f.kind, f.hosts);
      f.test = out === 'ok' ? { phase: 'ok' } : { phase: 'fail', code: out };
      paintForm();
      P.announce(out === 'ok' ? '连接成功' : GIT_FAIL[out]);
    });
  };
  function maskToken(tok) { const m = /^(ghp_|gho_|github_pat_|glpat-)/.exec(tok); return `${m ? m[1] : tok.slice(0, 4)}…${tok.slice(-4)}`; }
  function saveForm() {
    const f = cp.form; if (!f) return;
    const save = $('[data-action="crd-form-save"]', f.el);
    if (save.disabled || P.isBusy(save)) return;
    const secret = f.kind === 'https' ? $('#crd-https-token', f.el).value.trim() : $('#crd-ssh-key', f.el).value;
    f.saving = true; paintForm();
    P.announce('保存中…');
    P.clock.after(T.gitSave, () => {
      if (cp.form !== f) return;
      // 保存即替换旧的那份（REQ-CRD-025）；明文不回显，只留尾号 / 指纹；刚保存的没用过，不显示「最后使用」
      if (f.kind === 'https') world.gitCreds.https = { masked: maskToken(secret), platform: f.platform, hosts: f.hosts.slice(), lastUsed: null };
      else world.gitCreds.ssh = { fingerprint: 'SHA256:3f…9c', lastUsed: null };
      delete cp.test[f.kind];
      cp.form = null;
      P.render();
      P.toast('ok', f.kind === 'https' ? 'HTTPS Token 已保存' : 'SSH 密钥已保存');
      const next = $('[data-fk="crd-retry-clone"]') || $(`[data-fk="crd-git-test:${f.kind}"]`);
      if (next) next.focus({ preventScroll: true });
    });
  }
  P.actions['crd-form-save'] = () => saveForm();
  P.actions['crd-git-config'] = (el) => openGitForm(el.dataset.kind, 'new', el.dataset.fk);
  P.actions['crd-git-replace'] = (el) => openGitForm(el.dataset.kind, 'replace', el.dataset.fk);
  // ---- 删除 Git 凭证（f-crd-git-05；SSH 私钥同一个框，文字按 REQ-CRD-026 末段）
  P.actions['crd-git-delete'] = (el) => {
    const kind = el.dataset.kind; const c = world.gitCreds[kind]; if (!c) return;
    const box = P.fromTpl('tpl-crd-git-delete');
    box.dataset.dialog = 'crd-git-delete';
    const body = $('.dialog__body', box);
    if (kind === 'https') {
      const hosts = c.hosts.join('、');
      const owner = PLATFORM[c.platform] && PLATFORM[c.platform][1] ? PLATFORM[c.platform][0] : 'Git 服务';
      const ps = world.projects.filter((p) => p.source === 'git' && c.hosts.includes(gitHostOf(p.repo)));
      $('.dialog__title', box).textContent = `删除 Git 凭证「HTTPS Token · ${hosts}」？`;
      $('.dialog__subtitle', box).textContent = c.lastUsed ? `Git 凭证 · 最后使用 ${c.lastUsed}` : 'Git 凭证';
      body.innerHTML = `<div class="dconfirm__block"><div class="dconfirm__title">会删掉</div><ul class="bullets"><li>这份 HTTPS Token <span class="dconfirm__meta">（${esc(c.masked)}）</span><span class="dconfirm__note">平台不再保存它，也不会再拿它访问 ${esc(hosts)}。</span></li></ul></div>`
        + `<div class="dconfirm__block"><div class="dconfirm__title">平台删不掉</div><ul class="bullets"><li>${esc(owner)} 上的这个 Token 本身<span class="dconfirm__note">去 ${esc(owner)} 的设置里把它作废，否则它在 ${esc(owner)} 那边一直有效。</span></li></ul></div>`
        + `<div class="dconfirm__block"><div class="dconfirm__title">删掉之后</div><ul class="bullets"><li>克隆或拉取 ${esc(hosts)} 上的私有仓库会失败，直到重新配置凭证</li><li>${ps.length ? `仓库在 ${esc(hosts)} 的 ${ps.length} 个项目：${ps.map((p) => esc(p.name)).join('、')}<span class="dconfirm__note">仓库是私有的话，项目里的「拉取最新代码」会失败；新建任务仍用这台机器上已有的代码副本。</span>` : `现在没有仓库在 ${esc(hosts)} 的项目`}</li></ul></div>`
        + '<div class="dconfirm__block dconfirm__block--untouched"><div class="dconfirm__title">不受影响</div><ul class="bullets"><li>已经建好的任务：代码副本已在这台机器上，Git 凭证也不会注入任务</li></ul></div>'
        + `<p class="dconfirm__source">项目清单来源：项目列表里仓库 host 在这份 Token 白名单（${esc(hosts)}）内的项目。</p>`;
    } else {
      const ps = world.projects.filter((p) => p.source === 'git' && isSshRepo(p.repo));
      $('.dialog__title', box).textContent = '删除 Git 凭证「SSH 私钥」？';
      $('.dialog__subtitle', box).textContent = c.lastUsed ? `Git 凭证 · 最后使用 ${c.lastUsed}` : 'Git 凭证';
      body.innerHTML = `<div class="dconfirm__block"><div class="dconfirm__title">会删掉</div><ul class="bullets"><li>这把 SSH 私钥 <span class="dconfirm__meta">（${esc(c.fingerprint)}）</span><span class="dconfirm__note">平台不再保存它，也不会再拿它连 SSH 地址的仓库。</span></li></ul></div>`
        + '<div class="dconfirm__block"><div class="dconfirm__title">平台删不掉</div><ul class="bullets"><li>Git 服务上登记的对应公钥<span class="dconfirm__note">去 Git 服务的 SSH Keys 设置里删，否则它在那边一直有效。</span></li></ul></div>'
        + `<div class="dconfirm__block"><div class="dconfirm__title">删掉之后</div><ul class="bullets"><li>克隆或拉取 SSH 地址（git@ / ssh://）的私有仓会失败，直到重新配置凭证</li><li>${ps.length ? `仓库是 SSH 地址的 ${ps.length} 个项目：${ps.map((p) => esc(p.name)).join('、')}` : '现在没有仓库是 SSH 地址的项目'}</li></ul></div>`
        + '<div class="dconfirm__block dconfirm__block--untouched"><div class="dconfirm__title">不受影响</div><ul class="bullets"><li>已经建好的任务：代码副本已在这台机器上，Git 凭证也不会注入任务</li></ul></div>'
        + '<p class="dconfirm__source">项目清单来源：项目列表里仓库地址是 SSH 形式（git@ / ssh://）的项目。</p>';
    }
    const cancel = $('.dialog__footer > .btn', box); cancel.dataset.dlg = 'cancel';
    const danger = $('.btn--danger', box); danger.dataset.dlg = 'confirm'; danger.dataset.fk = 'git-del-confirm';
    $('.dialog__close', box).dataset.dlg = 'cancel';
    const mm = P.openModal(box, { kind: 'crd-git-delete', returnTo: el, initialFocus: '[data-initial-focus]' });
    mm.box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dlg]'); if (!b || mm.busy) return;
      if (b.dataset.dlg === 'cancel') { P.closeModal(mm); return; }
      mm.busy = true;
      cancel.disabled = true; for (const x of $$('.dialog__close', mm.box)) x.disabled = true;
      P.setBusy(danger, true, P.busyHtml('删除中…')); // 第五段（R1-03）
      P.clock.after(T.gitDelete, () => {
        mm.busy = false;
        P.closeModal(mm, { restoreFocus: false });
        world.gitCreds[kind] = null;
        delete cp.test[kind];
        P.render();
        P.toast('ok', '凭证已删除'); // DR-35 ①（Q-CRD-02 默认 C：与「已删除」各自保留）
        const f = $('[data-fk^="crd-git-add:"]') || $('[data-fk^="crd-git-replace:"]'); if (f) f.focus({ preventScroll: true }); else P.focusMain();
      });
    });
  };
  // ---- 回程条（f-crd-page-05，REQ-CRD-034）：[重试克隆] 成功回工作台、项目进入克隆中；[放弃] 只收起
  P.actions['crd-retry-clone'] = () => {
    const p = pendingClone(); if (!p || cp.retrying) return;
    cp.retrying = true; P.render();
    P.announce('重试中…');
    P.clock.after(T.retryCloneReturn, () => {
      cp.retrying = false;
      if (P.scenario.take('git-retry') === 'fail') { P.render(); P.toast('fail', '重试克隆失败，请稍后重试。'); const b = $('[data-fk="crd-retry-clone"]'); if (b) b.focus({ preventScroll: true }); return; }
      ui.pendingProjectCreate = null;
      P.retryClone(p, { force: true });
      P.enterProject(p.id);
    });
  };
  P.actions['crd-giveup'] = () => {
    ui.pendingProjectCreate = null;
    P.render();
    const h = $('#sec-git'); if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
    P.announce('已放弃重试，项目仍是克隆失败');
  };
  // ---- 联动：私有仓没有能用的 Git 凭证时，克隆 / 拉取按权限类失败（flows-prj.js 问这里；示例世界里 github.com/acme/* 是私有仓，一直靠那份 HTTPS Token）
  P.hook('git.access', (p) => {
    if (!p || p.source !== 'git' || !p.repo) return undefined;
    const host = gitHostOf(p.repo);
    if (host !== 'github.com' || !/^https?:\/\/github\.com\/acme\//i.test(p.repo)) return undefined;
    const c = world.gitCreds.https;
    return c && c.hosts.includes(host) ? undefined : 'permission';
  });

  // ================================================================== P5 系统状态「Agent」一节：与凭证同源（consistency.md 改动 9；f-sys-conn-01 的写法）
  const AUTH_METHODS = { codex: 'oauth-device · api-key', 'claude-code': 'setup-token · api-key' };
  P.hook('main:refreshed', (host) => {
    if (host.dataset.tpl !== 'tpl-system') return;
    for (const rt of world.runtimes) {
      const li = $(`[data-testid="runtime-row-${rt.id}"]`, host); if (!li) continue;
      const st = credStatus(rt);
      const [cls, icon, word] = st === 'none' ? ['badge--inactive', 'i-square-filled', '凭证未配置'] : st === 'expired' ? ['badge--fail', 'i-x', '凭证已过期'] : ['badge--ok', 'i-check', '凭证已配置'];
      const html = `<span class="badge badge--20 ${cls} badge--icon" role="img" aria-label="${word}"><span class="icon ${icon}" aria-hidden="true"></span></span><span><span class="u-fg">${esc(rt.name)}（${esc(rt.vendor)}）</span>· ${word} · 授权方式 ${AUTH_METHODS[rt.id]}</span>`;
      if (li.dataset.html !== html) { li.innerHTML = html; li.dataset.html = html; }
    }
  });

  // ================================================================== F-ACC-UNLOCK 访问口令门（f-acc-unlock-02 / 03；口令从哪来见 f-acc-unlock-01 与「原型说明」）
  const acc = { failures: 0, lockedUntil: 0, verifying: false, el: null, parts: null, unlockTimer: 0, booted: false };
  const locked = () => P.clock.now() < acc.lockedUntil;
  function raiseGate(atBoot) {
    if (acc.el) return;
    if (!atBoot) {
      // 解锁之后又被拒（会话到期 / 场景切回）：收起一切浮层，整个应用换成口令门；解锁后重跑首屏
      if (AP.cur) closePanel(AP.cur, { restore: false, cancel: true });
      if (P.menu.el) P.closeMenu(false, { instant: true });
      if (P.popover) P.popover.close(false);
      if (P.sheet) P.sheet.close();
      while (P.modals.length) P.closeModal(P.topModal(), { restoreFocus: false, instant: true, force: true });
      P.ui.loading = true;
    }
    P.gated = true;
    acc.parts = [$('.skip-link'), $('#shell')].filter(Boolean);
    for (const el of acc.parts) el.remove(); // 门之下不挂外壳与工作台（DR-28）：不是盖一层，是不在 DOM 里
    const gate = P.fromTpl('tpl-acc-gate');
    gate.id = 'proto-gate';
    gate.setAttribute('role', 'main'); // 门是这时页面上唯一的内容：整块作为主区地标（品牌行也要落在地标里）。第五段起稿件 f-acc-unlock-02 的 .gate 本身就是 <main>（R2-18），这一句只是兜底
    const input = $('#passcode', gate); input.dataset.fk = 'acc-input';
    const btn = $('[type="submit"]', gate); btn.dataset.fk = 'acc-submit'; btn.disabled = true;
    const form = $('.gate__form', gate);
    input.addEventListener('input', () => { paintGate(); });
    form.addEventListener('submit', (e) => { e.preventDefault(); submitPasscode(); });
    gate.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return; // 口令卡是模态对话框：Tab 在卡里循环
      const card = $('.gate__card', gate);
      const fs = P.focusables(card); if (!fs.length) return;
      const first = fs[0], last = fs[fs.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    $('#frame').appendChild(gate);
    acc.el = gate;
    if (P.scenario.is('access', 'locked') && !locked()) { acc.failures = Math.max(acc.failures, 5); lockFor(); acc.showLocked = true; }
    paintGate();
    document.title = '需要访问口令 · 交互原型 · Agent 管理平台';
    input.focus({ preventScroll: true });
    P.announce('需要访问口令');
  }
  function lockFor() {
    acc.lockedUntil = P.clock.now() + T.passcodeLock;
    P.clock.cancel(acc.unlockTimer);
    acc.unlockTimer = P.clock.after(T.passcodeLock, () => { acc.showLocked = false; paintGate(); if (acc.el) P.announce('可以再试一次了'); });
  }
  function paintGate() {
    const g = acc.el; if (!g) return;
    const input = $('#passcode', g), btn = $('[type="submit"]', g);
    let msg = $('.gate__msg', g);
    const want = acc.showLocked && locked() ? 'locked' : acc.wrong ? 'wrong' : null;
    if (!want && msg) { msg.remove(); msg = null; }
    if (want && (!msg || msg.dataset.kind !== want)) {
      // 口令不对（圆叉）/ 锁定（锁，按分钟说、向上取整；原型的 30 秒对应画面上的 5 分钟）
      const n = P.fromTpl(want === 'locked' ? 'tpl-acc-msg-locked' : 'tpl-acc-msg-wrong', { keepRoles: true });
      n.id = 'passcode-msg'; n.dataset.kind = want;
      if (msg) msg.replaceWith(n); else $('.field', g).after(n);
      msg = n;
    }
    if (want === 'locked') $('span:last-child', msg).textContent = `错得太多次，已暂时锁定，约 ${Math.max(1, Math.ceil(((acc.lockedUntil - P.clock.now()) / T.passcodeLock) * 5))} 分钟后再试。`;
    // 第五段（R1-03）：验证中焦点不丢——在输入框里按回车提交的，焦点先交给 [解锁]（aria-busy）再禁用输入框
    if (acc.verifying && document.activeElement === input) btn.focus({ preventScroll: true });
    input.disabled = acc.verifying;
    if (want === 'wrong') input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    input.setAttribute('aria-describedby', msg ? 'passcode-msg passcode-note' : 'passcode-note');
    if (acc.verifying) P.setBusy(btn, true, P.busyHtml('验证中…'));
    else { P.setBusy(btn, false, '解锁'); btn.disabled = !input.value.trim() || want === 'locked'; }
  }
  function submitPasscode() {
    const g = acc.el; if (!g || acc.verifying) return;
    const input = $('#passcode', g);
    const v = input.value.trim();
    if (!v || (acc.showLocked && locked())) return;
    acc.verifying = true; paintGate();
    P.announce('验证中…');
    P.clock.after(T.passcodeVerify, () => {
      acc.verifying = false;
      if (!acc.el) return;
      if (locked()) { acc.showLocked = true; acc.wrong = false; paintGate(); P.announce('错得太多次，已暂时锁定，约 5 分钟后再试。'); input.focus({ preventScroll: true }); return; }
      if (PASSCODES.includes(v)) { acc.failures = 0; acc.wrong = false; acc.showLocked = false; unlock(); return; }
      // 口令不对：保留输入、可再提交；连错 5 次那一次仍说「口令不对」，同时锁上（下一次提交起才是锁定，AC-ACC-005.1）；计数到解锁成功才清零（AC-ACC-005.4）
      acc.failures++;
      acc.wrong = true;
      if (acc.failures >= 5) lockFor();
      paintGate();
      input.focus({ preventScroll: true });
      P.announce('口令不对，再试一次。');
    });
  }
  function unlock() {
    const g = acc.el; if (!g) return;
    acc.el = null;
    P.clock.cancel(acc.unlockTimer);
    g.remove();
    const frame = $('#frame');
    for (const el of acc.parts.slice().reverse()) frame.prepend(el);
    acc.parts = null;
    P.gated = false;
    ui.focusAfterLoad = true; // 第五段（R1-06 ⑤）：外壳回来、首屏走完后焦点交给主区（原来停在 body，下一次 Tab 从「跳到主区」重来）
    if (!P.scenario.is('access', 'off')) P.scenario.set('access', 'off');
    if (P.modals.length) P.setInert(true);
    // 解锁后重跑「初始化判定」（REQ-DEP-002 / AC-DEP-002.3）：未初始化 → 启动检查中 → 向导（flows-dep.js）；已初始化 → 重播首屏（骨架 → 地址指的视图）
    P.proceedBoot();
  }
  P.hook('boot', () => { acc.booted = true; });
  P.hook('boot:hold', () => { if (P.scenario.is('access', 'off')) return undefined; raiseGate(true); return true; });
  P.hook('scenario', (k, v) => {
    if (k !== 'access' || !acc.booted) return;
    if (v === 'off') { if (acc.el) { acc.failures = 0; acc.wrong = false; acc.showLocked = false; unlock(); } return; }
    if (!acc.el) raiseGate(false);
    else if (v === 'locked') { acc.failures = Math.max(acc.failures, 5); lockFor(); acc.showLocked = true; acc.wrong = false; paintGate(); }
  });

  // ------------------------------------------------------------------ 测试出口（只读快照）
  P.stateExtras.push(() => ({
    runtimes: world.runtimes.map((r) => ({ id: r.id, active: r.active, cred: credStatus(r), identity: r.identity, account: r.account ? r.account.masked : null, apiKey: r.apiKey ? r.apiKey.masked : null })),
    git: { https: world.gitCreds.https ? { masked: world.gitCreds.https.masked, hosts: world.gitCreds.https.hosts.slice(), platform: world.gitCreds.https.platform } : null, ssh: world.gitCreds.ssh ? { fingerprint: world.gitCreds.ssh.fingerprint } : null },
    access: { gated: P.gated, failures: acc.failures, locked: locked() },
    authPanel: AP.cur ? { host: AP.cur.host, rt: AP.cur.rt.id, tab: AP.cur.tab, phase: AP.cur.done ? 'success' : AP.cur.tab === 'acc' ? AP.cur.acc.phase : AP.cur.key.phase, code: AP.cur.acc.code || null } : null,
    pendingClone: ui.pendingProjectCreate ? ui.pendingProjectCreate.projectId : null,
    credBinds: Object.fromEntries(world.tasks.filter((t) => t.credBind).map((t) => [t.id, t.credBind])), // 注入记录（删除凭证的清单按它算）
  }));
})();
