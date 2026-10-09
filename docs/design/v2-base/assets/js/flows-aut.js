/*
 * 交互原型 · 自动化规则（js/flows-aut.js）：F-AUT-RULES（第四段接线，L6b）
 *   一个居中弹层、四个视图（REQ-AUT-002）：列表（四种规则状态、20 条上限、空态、读取失败）↔ 详情（配置 8 行、任务内容预览、启停、运行历史六类、
 *   [查看全部] / [加载更多]、运行详情与 [打开任务]、历史为空 / 读取失败）↔ 表单（新建 / 编辑：校验紧贴字段、改过或失焦才亮、时区快照、Webhook [测试连接]、
 *   保存中 / 保存失败进页脚条）↔ 删除确认（同一弹层就地切视图，Esc = 取消回详情）。全程只有一个 role="dialog"。
 *   入口：项目「⋯」→「自动化规则」、P6 空态「设置自动化规则 →」（flows-prj.js 见 P.openAutomations 即接上）、⌘K「自动化规则…」（flows-wb.js）、
 *   治理横幅「有 N 条定时规则…」[查看这些规则]（flows-wb.js；2026-10-04 用户拍板 Q-WB-01 B：按全部项目判定，数据来自后端新增的跨项目规则概览，
 *   任何页面都出、不要求打开过哪个项目的规则；说明点名「<项目> 的「<规则>」」，按钮去第一条所在的项目）。
 * 标记来源：gap/drafts/f-aut-rules-01…11（index.html 的 tpl-aut-*，build-proto.cjs 同源拷贝）；规则行、运行行、表单里随数据变的部分按同一套类名由本文件画。
 * 产品口径：gap/product/AUT.md（AC 的 Then）；接线要点 gap/drafts/notes/aut.md §6；示例世界 notes/aut.md §5；待定问题按 open-questions 默认（Q-AUT-01 A 超时红叉、
 *   Q-AUT-02 A（[打开任务] 只在任务还在时出）、Q-AUT-03 A（数量由后端给）、Q-AUT-04 A（[查看原因] 滚进视野 + 焦点给 [收起]）、Q-AUT-05 A、Q-AUT-06 A（改过或失焦才亮））。
 * 给别处的出口：P.openAutomations(projectId, returnTo, opts)、P.autOverview()（跨项目规则概览：被放慢 / 自动停用的规则；读取失败 = null）、
 *   P.autAttention()（横幅的标题 / 说明 / 去哪个项目；概览读不到 = null，「读不到」≠「没问题」）、P.autRuleText(rule)。
 */
(function () {
  'use strict';
  const P = window.P;
  const { $, $$, esc } = P;
  const world = P.world;
  const T = P.TIMING;
  // 模板克隆后经 outerHTML 拼进对话框：勾选状态要写成属性（checked 属性不随 outerHTML 序列化）
  const chk = (x, on) => { if (on) x.setAttribute('checked', ''); else x.removeAttribute('checked'); };

  // ------------------------------------------------------------------ 场景（「原型说明 › 场景 › 自动化规则」）
  const G = '自动化规则';
  // 2026-10-04 用户拍板 Q-WB-01 B：横幅按全部项目判定、任何页面都出——示例世界 acme-web 有 1 条自动停用 + 1 条被放慢，所以默认按「今天已点过『今天不再提示』」
  // 处理（与稿件的约定一致：除横幅专题稿 f-wb-banner-02 / 04 外都不画这一条，consistency.md §9.1 第 9 条）；改成「还没点过」就能在任何页面看到它
  P.scenario.define({ key: 'aut-banner', group: G, label: '「自动化需关注」横幅（按全部项目判定）', def: 'today', options: [['today', '今天已点过「今天不再提示」（示例世界默认，同稿件约定）'], ['show', '还没点过：任何页面都出（总览、项目、设置页）'], ['fail', '跨项目规则概览读取失败：不出这一条']] });
  P.scenario.define({ key: 'aut-limit', group: G, label: 'acme-web 的规则条数', def: 'normal', options: [['normal', '4 条（示例世界）'], ['full', '已满 20 条']] });
  P.scenario.define({ key: 'aut-load', group: G, label: '规则列表读取', def: 'ok', options: [['ok', '正常'], ['fail', '读取失败（[重试] 后复位）']] });
  P.scenario.define({ key: 'aut-history', group: G, label: '运行历史读取', def: 'ok', options: [['ok', '正常'], ['fail', '读取失败（[重试] 后复位）']] });
  P.scenario.define({ key: 'aut-save', group: G, label: '下一次保存规则', once: true, def: 'ok', options: [['ok', '成功'], ['network', '断网（请求没到后端）']] });
  P.scenario.define({ key: 'aut-test', group: G, label: '下一次 [测试连接]', once: true, def: 'ok', options: [['ok', '送到了'], ['timeout', '超时（TIMEOUT）'], ['upstream', '对方没正常回应（UPSTREAM_UNAVAILABLE）']] });
  P.scenario.define({ key: 'aut-toggle', group: G, label: '下一次关掉 / 开启', once: true, def: 'ok', options: [['ok', '成功'], ['fail', '失败（回滚并说原因）']] });
  P.scenario.define({ key: 'aut-delete', group: G, label: '下一次删除规则', once: true, def: 'ok', options: [['ok', '成功'], ['fail', '失败（网络不通）']] });

  // ================================================================== 时区与调度（REQ-AUT-003 / 011：时区是快照、永远写出来；下次触发按规则自己的时区）
  const LOCAL_TZ = 'Asia/Shanghai'; // 示例世界的本机时区（「你现在是 Asia/Shanghai」）
  const pad = (n) => String(n).padStart(2, '0');
  const now = () => P.clock.wall();
  function tzOffsetMin(tz, at) {
    if (tz === 'UTC') return 0;
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date(at));
      const v = (parts.find((x) => x.type === 'timeZoneName') || {}).value || 'GMT';
      const m = /GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?/.exec(v);
      if (!m || !m[1]) return 0;
      return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
    } catch (e) { return null; }
  }
  // IANA 城市写法（UTC+8 这类固定偏移、写错的城市名由服务端以 INVALID_TIMEZONE 拒绝，表单页脚按码说人话）
  const validTz = (tz) => (tz === 'UTC' || /^[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2}$/.test(tz)) && tzOffsetMin(tz, now()) != null;
  const utcLabel = (off) => `UTC${off < 0 ? '-' : '+'}${Math.floor(Math.abs(off) / 60)}${Math.abs(off) % 60 ? `:${pad(Math.abs(off) % 60)}` : ''}`;
  function fmtAt(ms, tz) { const off = tzOffsetMin(tz, ms) || 0; const d = new Date(ms + off * 60000); return `${d.getUTCMonth() + 1}-${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }
  const DAYS = ['日', '一', '二', '三', '四', '五', '六'];
  function schedText(s) {
    if (s.kind === 'hourly') return `每小时 :${pad(s.minute)}`;
    if (s.kind === 'weekly') return s.days.length ? `每周${s.days.slice().sort((a, b) => a - b).map((d) => DAYS[d]).join('')} ${s.time}` : `每周（未选星期）${s.time}`;
    return `每天 ${s.time}`;
  }
  // 下次触发：已关掉 / 自动停用没有；被放慢 = 每天只试一次（原调度不改写；每小时规则落到次日 00:MM，同 f-aut-rules-01）
  function nextFire(r) {
    if (r.state === 'off' || r.state === 'auto-disabled') return null;
    const t0 = now();
    const off = tzOffsetMin(r.tz, t0); if (off == null) return null;
    const l = new Date(t0 + off * 60000);
    const y = l.getUTCFullYear(), mo = l.getUTCMonth(), d = l.getUTCDate(), dow = l.getUTCDay();
    const at = (dd, h, mi) => Date.UTC(y, mo, dd, h, mi) - off * 60000;
    const s = r.sched;
    if (s.kind === 'hourly') {
      if (r.state === 'throttled') return at(d + 1, 0, s.minute);
      let c = at(d, l.getUTCHours(), s.minute); if (c <= t0) c += 3600000; return c;
    }
    const [h, mi] = s.time.split(':').map(Number);
    if (s.kind === 'daily') { const c = at(d, h, mi); return c > t0 ? c : at(d + 1, h, mi); }
    for (let k = 0; k < 8; k++) { if (!s.days.includes((dow + k) % 7)) continue; const c = at(d + k, h, mi); if (c > t0) return c; }
    return null;
  }
  const nextText = (r) => { const n = nextFire(r); return n == null ? null : fmtAt(n, r.tz); };
  const TIMEOUTS = [[30, '30 分钟'], [60, '1 小时'], [120, '2 小时'], [240, '4 小时']];
  const KEEPS = [3, 7, 30];
  const TRIGGERS = [['failure', '仅失败（含超时）', '只在失败时发（超时也算失败）'], ['success', '仅成功', '只在成功时发'], ['all', '全部', '每次都发']];
  const tLabel = (min) => (TIMEOUTS.find((x) => x[0] === min) || [0, `${min} 分钟`])[1];

  // ================================================================== 示例世界的规则（notes/aut.md §5；core.js 只放了 id / 项目 / 名称 / Agent / 状态 / 失败次数，这里补全）
  const RULES = {
    'rule-nightly': { desc: 'main 分支每晚回归一次，失败发通知', sched: { kind: 'daily', time: '03:00', minute: 0, days: [] }, timeoutMin: 120, keepDays: 7, hook: { url: 'https://hooks.example.com/agent/acme-web', on: 'failure' },
      prompt: '在 main 分支最新代码上跑一遍完整回归：\n1. pnpm install --frozen-lockfile\n2. pnpm test（单元测试）\n3. pnpm exec playwright test（e2e）\n有失败就把失败用例、报错和最近相关的提交整理成一段说明，写进 reports/nightly.md；不要改业务代码。' },
    'rule-deps': { desc: '', sched: { kind: 'weekly', time: '09:00', minute: 0, days: [1] }, timeoutMin: 60, keepDays: 7, hook: null,
      prompt: '检查各个 package.json 里可以安全升级的依赖：只升补丁版本和小版本，跑一遍 pnpm test，把升级清单和测试结果写进 reports/deps.md。' },
    'rule-alerts': { desc: '', sched: { kind: 'hourly', time: '00:15', minute: 15, days: [] }, timeoutMin: 30, keepDays: 3, hook: null,
      prompt: '读一遍最近一小时的 CI 构建日志，把新出现的告警按严重程度排好，写进 reports/build-alerts.md。' },
    'rule-release': { desc: '', sched: { kind: 'daily', time: '18:00', minute: 0, days: [] }, timeoutMin: 60, keepDays: 3, hook: { url: 'https://hooks.example.com/agent/release', on: 'failure' },
      prompt: '汇总从上一个 tag 到 main 的合并记录，按 feat / fix / chore 分组写成发布说明草稿，提交到 release-notes 分支并推送。' },
    'rule-demo': { desc: '', sched: { kind: 'daily', time: '09:00', minute: 0, days: [] }, timeoutMin: 60, keepDays: 7, hook: null,
      prompt: '在示例项目里跑一遍 pnpm test，把失败的用例和报错整理成一段说明。' },
  };
  // 运行记录：时刻按规则时区写（M-D HH:mm）。k = running / pending / queued / success / failed / resource / timeout / skip-auth / skip-prev / missed
  const atOf = (tz, md, hm) => { const [mo, d] = md.split('-').map(Number); const [h, mi] = hm.split(':').map(Number); return Date.UTC(2026, mo - 1, d, h, mi) - (tzOffsetMin(tz, Date.UTC(2026, mo - 1, d)) || 0) * 60000; };
  const dayBack = (ms, n) => ms - n * 86400000;
  const PUSH_FAIL = "codex exited with code 1\nfatal: could not read Username for 'https://github.com': terminal prompts disabled";
  const RELEASE_SUMMARY = "$ git fetch --tags origin\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n• 拉不到远端 tag，改用本地最近的 tag：v2.3.0\n• 汇总 v2.3.0..main 的 37 条合并记录（feat 12 · fix 19 · chore 6）\n• 写入 release-notes/2026-10-01.md\n$ git push origin release-notes\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n✗ 推送失败，草稿留在工作目录里";
  let runSeq = 0;
  const mkRun = (rule, ms, k, x) => ({ id: `run-${++runSeq}`, at: ms, k, ...(x || {}) });
  function seedRuns() {
    const tzS = 'Asia/Shanghai', tzT = 'Asia/Tokyo';
    const R = {};
    // 每天凌晨跑一遍回归：07 的 10 条（六类各一）+ 更早的成功，总数 42（删除预检用）；第一页 20 条
    {
      const a = (md, k, x) => mkRun('rule-nightly', atOf(tzS, md, '03:00'), k, x);
      const list = [
        a('10-2', 'running', { task: 'nightly' }), a('10-1', 'queued', { n: 2 }), a('9-30', 'skip-auth', { hook: 'sent' }), a('9-29', 'missed'),
        a('9-28', 'failed', { dur: '12 分 40 秒', hook: 'sent', err: 'pnpm exec playwright test exited with code 1\n3 failed, 214 passed (12m 31s)' }),
        a('9-27', 'success', { dur: '18 分 5 秒', hook: 'skipped' }), a('9-26', 'success', { dur: '17 分 52 秒', hook: 'skipped' }), a('9-25', 'success', { dur: '18 分 31 秒', hook: 'skipped' }),
        a('9-24', 'timeout', { dur: '2 小时 0 分', hook: 'sent' }), a('9-23', 'success', { dur: '18 分 2 秒', hook: 'skipped' }),
      ];
      const base = atOf(tzS, '9-23', '03:00');
      for (let i = 1; list.length < 42; i++) list.push(mkRun('rule-nightly', dayBack(base, i), 'success', { dur: `${17 + (i % 3)} 分 ${10 + ((i * 7) % 49)} 秒`, hook: 'skipped' }));
      R['rule-nightly'] = list;
    }
    // 每天生成发布说明草稿：连着失败 10 次（10-1 … 9-22，9-28 超时；10-1 那条带后端原文、Webhook 没发出去、输出摘要）+ 更早的成功，共 26 次
    {
      const a = (md, k, x) => mkRun('rule-release', atOf(tzS, md, '18:00'), k, x);
      const list = [a('10-1', 'failed', { dur: '1 分 12 秒', err: PUSH_FAIL, hook: 'failed', summary: RELEASE_SUMMARY })];
      for (const [md, dur] of [['9-30', '1 分 5 秒'], ['9-29', '1 分 9 秒']]) list.push(a(md, 'failed', { dur, err: PUSH_FAIL, hook: 'sent' }));
      list.push(a('9-28', 'timeout', { dur: '1 小时 0 分', hook: 'sent' }));
      for (const [md, dur] of [['9-27', '58 秒'], ['9-26', '1 分 2 秒'], ['9-25', '1 分 7 秒'], ['9-24', '59 秒'], ['9-23', '1 分 4 秒'], ['9-22', '1 分 11 秒']]) list.push(a(md, 'failed', { dur, err: PUSH_FAIL, hook: 'sent' }));
      const base = atOf(tzS, '9-22', '18:00');
      for (let i = 1; list.length < 26; i++) list.push(mkRun('rule-release', dayBack(base, i), 'success', { dur: `1 分 ${20 + i} 秒`, hook: 'skipped' }));
      R['rule-release'] = list;
    }
    // 每小时检查构建告警：最近 4 次失败（第 3 次之后放慢成每天一次）+ 更早的成功，共 24 次
    {
      const err = 'codex exited with code 1\nerror: build log not found: /workspace/.ci/latest.log (CI artifact expired)';
      const list = [mkRun('rule-alerts', atOf(tzS, '10-2', '00:15'), 'failed', { dur: '2 分 4 秒', err })];
      for (const hm of ['23:15', '22:15', '21:15']) list.push(mkRun('rule-alerts', atOf(tzS, '10-1', hm), 'failed', { dur: '2 分 1 秒', err }));
      const base = atOf(tzS, '10-1', '21:15');
      for (let i = 1; list.length < 24; i++) list.push(mkRun('rule-alerts', base - i * 3600000, 'success', { dur: `1 分 ${40 + (i % 15)} 秒` }));
      R['rule-alerts'] = list;
    }
    R['rule-deps'] = ['9-28', '9-21', '9-14'].map((md, i) => mkRun('rule-deps', atOf(tzT, md, '09:00'), 'success', { dur: `${6 + i} 分 ${12 + i * 9} 秒` }));
    R['rule-demo'] = [['10-2', '2 分 3 秒'], ['10-1', '2 分 11 秒'], ['9-30', '1 分 58 秒']].map(([md, dur]) => mkRun('rule-demo', atOf(tzS, md, '09:00'), 'success', { dur }));
    return R;
  }
  const SEED_RUNS = seedRuns();
  function enrich(r) {
    const x = RULES[r.id];
    if (!x || r.sched) return r;
    Object.assign(r, { desc: x.desc, sched: { ...x.sched, days: x.sched.days.slice() }, timeoutMin: x.timeoutMin, keepDays: x.keepDays, hook: x.hook ? { ...x.hook } : null, prompt: x.prompt, runs: SEED_RUNS[r.id] || [] });
    return r;
  }
  for (const r of world.automations) enrich(r);
  const ruleOf = (id) => world.automations.find((r) => r.id === id);
  const sched = (r) => r.sched || { kind: 'daily', time: '08:00', minute: 0, days: [] };
  P.autRuleText = (r) => schedText(sched(r));
  // 规则状态 → 画面（REQ-AUT-003 / 004）
  const LIFE = { on: 'on', off: 'off', throttled: 'degraded', 'auto-disabled': 'autoDisabled' };
  const ICON = { on: 'tone-ok i-check', off: 'tone-neutral i-square-filled', throttled: 'tone-warn i-triangle-alert', 'auto-disabled': 'tone-fail i-x' };
  const statusLine = (r) => (r.state === 'on' ? '已开启' : r.state === 'off' ? '已关掉（到点不会触发）'
    : r.state === 'throttled' ? `连着失败 ${r.fails} 次，已经放慢：现在每天只试一次` : `连着失败 ${r.fails} 次（放慢后又失败 ${Math.max(0, r.fails - 3)} 次），已自动停用`);
  const statusWord = (r) => ({ on: '已开启', off: '已关掉', throttled: '已放慢', 'auto-disabled': '已自动停用' })[r.state];
  const toggleLabel = (r) => (r.state === 'off' ? '开启' : r.state === 'auto-disabled' ? '重新开启' : '关掉');
  const agentName = (r) => (P.runtime(r.agentId) || {}).name || r.agent; // 显示名（DR-24）
  for (const r of world.automations) r.agentId = r.agentId || (r.agent === 'Claude Code' ? 'claude-code' : 'codex');

  // 「已满 20 条」场景（f-aut-rules-02 的 16 条，只在这个场景里出现；notes/aut.md §5）
  const LIMIT_ROWS = [
    ['每天检查过期依赖', 'codex', 'daily', '07:30', 'on'], ['每周五汇总本周合并请求', 'claude-code', 'weekly', '17:00', 'on', [5]], ['每天清理过期预览环境', 'codex', 'daily', '01:00', 'on'],
    ['每小时同步翻译词条', 'codex', 'hourly', ':00', 'on'], ['每周三跑一遍性能基准', 'codex', 'weekly', '02:00', 'on', [3]], ['每天巡检错误日志', 'claude-code', 'daily', '09:00', 'on'],
    ['每周一更新 API 文档', 'codex', 'weekly', '10:00', 'on', [1]], ['每天校对配置漂移', 'codex', 'daily', '06:00', 'off'], ['每天导出测试覆盖率', 'codex', 'daily', '22:00', 'on'],
    ['每周二清理旧分支', 'codex', 'weekly', '08:00', 'on', [2]], ['每小时检查证书到期', 'codex', 'hourly', ':30', 'on'], ['每天生成依赖许可证清单', 'claude-code', 'daily', '05:00', 'on'],
    ['每周四复查无障碍问题', 'claude-code', 'weekly', '15:00', 'on', [4]], ['每天备份种子数据', 'codex', 'daily', '04:00', 'on'], ['每周六整理 issue 标签', 'codex', 'weekly', '11:00', 'off', [6]],
    ['每天跑一遍冒烟测试', 'codex', 'daily', '12:00', 'on'],
  ];
  function applyLimit() {
    const full = P.scenario.is('aut-limit', 'full');
    const has = world.automations.some((r) => r.id.startsWith('rule-x'));
    if (full && !has && P.proj('web')) {
      LIMIT_ROWS.forEach(([name, agentId, kind, time, state, days], i) => {
        const minute = kind === 'hourly' ? Number(time.slice(1)) : 0;
        world.automations.push({ id: `rule-x${i + 1}`, project: 'web', name, agent: agentId === 'codex' ? 'Codex' : 'Claude Code', agentId, schedule: '', tz: LOCAL_TZ, state, fails: 0, desc: '', sched: { kind, time: kind === 'hourly' ? '00:00' : time, minute, days: days || [] }, timeoutMin: 60, keepDays: 7, hook: null, prompt: `${name}。`, runs: [] });
      });
    } else if (!full && has) {
      for (let i = world.automations.length - 1; i >= 0; i--) if (world.automations[i].id.startsWith('rule-x')) world.automations.splice(i, 1);
    }
  }
  const LIMIT = 20; // PARAM.AUTOMATION_RULE_LIMIT
  const LIMIT_TEXT = '每个项目最多 20 条规则，先删一条再建。';

  // ================================================================== 「自动化需关注」横幅的数据（flows-wb.js 画；2026-10-04 用户拍板 Q-WB-01 B；REQ-WB-013 / REQ-AUT-004）
  // 按全部项目判定：数据来自后端新增的跨项目规则概览（一次返回所有被放慢、已自动停用的规则：项目、规则、状态、连续失败次数；只读、与按项目的列表同一套判定）——
  // 不要求当前项目、不要求打开过该项目的自动化弹层（要防的恰恰是从不打开它的人）。原型里概览就是 world.automations 现算；场景「概览读取失败」= null
  const seen = new Set(); // 打开过哪些项目的规则（只进测试快照；横幅不再看它）
  const TIER = { 'auto-disabled': 0, throttled: 1 };
  P.autOverview = function autOverview() {
    if (P.scenario.is('aut-banner', 'fail')) return null; // 读不到 ≠ 没问题，也 ≠ 有问题：不出这一条，不拿当前项目的缓存冒充（AC-WB-013.6）
    const order = world.automations.slice();
    return world.automations.filter((r) => r.state in TIER && P.proj(r.project)).sort((a, b) => TIER[a.state] - TIER[b.state] || order.indexOf(a) - order.indexOf(b))
      .map((r) => ({ id: r.id, project: r.project, projectName: P.proj(r.project).name, name: r.name, state: r.state, fails: r.fails }));
  };
  // 标题按最重的一档数全部项目（先报自动停用，没有时报被放慢）；说明逐条点名「<项目> 的「<规则名>」」——自动停用的在前，同一档的名字用顿号连、
  // 后面跟这一档的那句，最多点名 3 条，多出的写「（等共 N 条）」；句末保留「定时任务停了不会有别的提示…」；[查看这些规则] 去第一条所在的项目
  const TIER_TEXT = { 'auto-disabled': '连着失败 10 次后已经不再触发，要重新开启才会继续跑', throttled: '被放慢成每天只试一次' };
  P.autAttention = function autAttention() {
    const all = P.autOverview();
    if (!all) return null;
    if (!all.length) return { needs: false };
    const d = all.filter((r) => r.state === 'auto-disabled').length, g = all.length - d;
    const named = all.slice(0, 3);
    const parts = [];
    for (const st of Object.keys(TIER)) { const rs = named.filter((r) => r.state === st); if (rs.length) parts.push(`${rs.map((r) => `${r.projectName} 的「${r.name}」`).join('、')}${TIER_TEXT[st]}`); }
    const more = all.length > named.length ? `（等共 ${all.length} 条）` : '';
    return { needs: true, project: all[0].project, rules: all.map((r) => r.id), title: d ? `有 ${d} 条定时规则已自动停用` : `有 ${g} 条定时规则被放慢了`, text: `${parts.join('；')}${more}。定时任务停了不会有别的提示，这里是唯一会主动告诉你的地方。` };
  };
  // 「今天不再提示」：场景「今天已点过」= 横幅栈里这一条记成今天已隐藏（原型按会话记，刷新即复原；产品按天）；改成「还没点过」/「读取失败」就撤掉这条记录
  function applyBannerScenario() {
    const h = P.banners && P.banners.ui && P.banners.ui.hidden; if (!h) return;
    if (P.scenario.is('aut-banner', 'today')) h.set('gov-aut', 'today'); else if (h.get('gov-aut') === 'today') h.delete('gov-aut');
  }
  P.hook('boot:before', applyBannerScenario);

  // ================================================================== 运行历史的六类（REQ-AUT-021 表）
  const KIND = {
    running: { cat: 'running', icon: 'icon--spin tone-info i-loader-circle', label: '运行中', lc: 'tone-info', counts: false, why: '任务正在跑。' },
    pending: { cat: 'waiting', icon: 'icon--spin tone-warn i-loader-circle', label: '待执行', lc: 'tone-warn', counts: false, why: '已经触发，正在创建任务。' },
    queued: { cat: 'waiting', icon: 'icon--spin tone-warn i-loader-circle', label: '排队重试中', lc: 'tone-warn', counts: false, why: '触发的时候没有空闲资源，正在按 24 分钟一次的间隔排队重试（最多 5 次）。还没有结果，这次不算失败。' },
    success: { cat: 'success', icon: 'tone-ok i-check', label: '成功', lc: 'tone-ok', counts: false, why: '任务跑完了，成功。之前累计的失败次数已经清零。' },
    failed: { cat: 'failure', icon: 'tone-fail i-x', label: '失败', lc: 'tone-fail', counts: true, why: '任务真的跑起来了，但没跑成。这次算一次失败：累计 3 次会自动放慢（每天只试一次）。' },
    resource: { cat: 'failure', icon: 'tone-fail i-x', label: '没排到资源', lc: 'tone-fail', counts: true, why: '一直没排到资源，等了 5 次还是没跑起来，这一次就不再等了。任务没有真正开始，所以没有输出可看。这次算一次失败：累计 3 次会自动放慢（每天只试一次）。' },
    timeout: { cat: 'failure', icon: 'tone-fail i-x', label: '超时', lc: 'tone-fail', counts: true, why: '跑到了规则里设的最长运行时间，被强制结束，按失败处理。这次算一次失败；可以在规则里把最长运行时间调大一档。' },
    'skip-auth': { cat: 'skipped', icon: 'tone-neutral i-minus', label: '跳过', lc: 'u-muted', counts: false, why: '这个 Agent 的凭证已过期或被删除，本次没有触发。重新授权后会按原来的时间表继续。这次没有执行，不算失败。' },
    'skip-prev': { cat: 'skipped', icon: 'tone-neutral i-minus', label: '跳过', lc: 'u-muted', counts: false, why: '上一次触发的任务当时还在跑，按「跳过」的策略这次没有再起一个。这次没有执行，不算失败。' },
    missed: { cat: 'missed', icon: 'tone-neutral i-circle', label: '错过', lc: 'u-muted', counts: false, why: '平台的定时调度当时没在运行，错过了这个时刻。这不是规则的问题；按设计也不会补跑（补跑会让凌晨的任务在中午执行）。这次不算失败。' },
  };
  const HOOK_NOTE = {
    sent: 'Webhook 通知已送达。',
    failed: 'Webhook 通知没发出去（重试 2 次后放弃）。只是通知没送到，规则本身的状态不受影响。',
    skipped: '按这条规则「什么时候发通知」的设置，这次不发 Webhook。',
  };
  const PAGE = 20, PREVIEW = 10; // PARAM.AUTOMATION_RUNS_PAGE_SIZE / AUTOMATION_RUNS_PREVIEW

  // ================================================================== 弹层（一个 .dialog--aut，四个视图就地切换）
  let A = null; // 当前开着的弹层：{ m, ctl, pid, view, ruleId, list, hist, form, err, busy… }
  const proj = () => (A ? P.proj(A.pid) : null);
  P.openAutomations = function openAutomations(pid, returnTo, opts) {
    const p = P.proj(pid); if (!p) return null;
    if (A && P.modals.includes(A.m)) return A.m;
    seen.add(pid); // 打开过 = 这个项目的规则拉到过（只记进测试快照；2026-10-04 起横幅按跨项目概览判定，不看它）
    const box = P.fromTpl('tpl-aut-list');
    box.dataset.dialog = 'automations';
    const m = P.openModal(box, { kind: 'automations', returnTo });
    A = { m, pid, view: 'list', ruleId: null, hist: {}, form: null, listErr: null, actErr: null, toggling: {}, listPhase: P.scenario.is('aut-load', 'fail') ? 'fail' : 'ok' };
    const st = A;
    m.onClose = () => { if (A === st) A = null; P.render(); }; // 关掉即丢弃一切视图状态与草稿（REQ-AUT-002）；横幅随数据重算
    A.ctl = P.dialogViews(m, { list: listView, detail: detailView, form: formView, confirm: confirmView });
    box.addEventListener('input', onInput);
    box.addEventListener('change', onInput);
    box.addEventListener('focusout', onBlur);
    if (opts && opts.reason) showDetail(opts.reason, { reason: true });
    else show('list');
    P.announce(`自动化规则 · 在 ${p.name} 中`);
    return m;
  };
  function show(view, args, opts) {
    A.view = view;
    A.m.box.classList.remove('aut-scrolled');
    A.ctl.show(view, args || {}, opts);
  }
  const header = (title, sub) => `<div class="dialog__header"><h2 class="dialog__title" id="aut-title">${esc(title)}</h2><p class="dialog__subtitle" id="aut-sub">${esc(sub)}</p></div>`;
  const closeBtn = '<button class="btn btn--tertiary btn--28 btn--icon dialog__close" type="button" aria-label="关闭" data-action="aut-close" data-fk="aut-close"><span class="icon i-x" aria-hidden="true"></span></button>';
  // 正文滚动后头部底边出 1px 分隔（.aut-scrolled，l6b-aut.css）
  function wireScroll(box) { const b = $('.dialog__body', box); if (b) b.addEventListener('scroll', () => box.classList.toggle('aut-scrolled', b.scrollTop > 0), { passive: true }); }

  // ---------------------------------------------------------------- 列表（f-aut-rules-01 / 02 / 03；读取失败照 11 的失败条写法）
  function ruleRow(r) {
    const nx = r.state === 'on' || r.state === 'throttled' ? nextText(r) : null;
    const off = tzOffsetMin(r.tz, now());
    const tzLine = `时区 ${r.tz}${off != null ? `（现在是 ${utcLabel(off)}）` : ''}${r.tz !== LOCAL_TZ ? ` · 按 ${r.tz} 的钟点触发（你现在是 ${LOCAL_TZ}）` : ''}`;
    const warn = r.state === 'throttled' || r.state === 'auto-disabled';
    const busy = !!A.toggling[r.id];
    // 启停在途：只这一行的按钮不可用（aria-disabled：焦点留在原位，等后端回来再还；REQ-AUT-003）
    const why = warn ? `<button class="btn btn--tertiary btn--28" type="button"${busy ? ' aria-disabled="true"' : ''} data-action="aut-why" data-rule="${r.id}" data-fk="aut-why:${r.id}">查看原因</button>` : '';
    const note = r.state === 'auto-disabled' ? '<p class="aut-rule__note">[重新开启] 会把失败次数清零，规则按原来的时间表继续。</p>' : '';
    return `<li class="aut-rule" data-lifecycle="${LIFE[r.state]}" data-rule="${r.id}"><button class="aut-rule__main" type="button" data-action="aut-open" data-rule="${r.id}" data-fk="aut-row:${r.id}"><span class="icon ${ICON[r.state]}" aria-hidden="true"></span><span class="aut-rule__name">${esc(r.name)}</span><span class="aut-rule__line">${esc(agentName(r))} · ${esc(schedText(sched(r)))}${nx ? ` · 下次: ${nx}` : ''}</span><span class="aut-rule__line">${esc(tzLine)}</span><span class="aut-rule__line${warn ? ' tone-warn' : ''}">${esc(statusLine(r))}</span></button><div class="aut-rule__end"><button class="btn btn--secondary btn--28" type="button"${busy ? ' aria-disabled="true"' : ''} data-action="aut-toggle" data-rule="${r.id}" data-fk="aut-toggle:${r.id}">${toggleLabel(r)}</button>${why}</div>${note}</li>`;
  }
  const failNote = (text, act, fk) => { const n = P.fromTpl('tpl-aut-history-fail', { keepRoles: true }); $('.note__text', n).textContent = text; const b = $('.note__end .btn', n); Object.assign(b.dataset, { action: act, fk }); return n.outerHTML; };
  const loadingLine = (text) => `<p class="aut-history__empty" role="status">${esc(text)}</p>`;
  function listView() {
    const p = proj();
    const el = P.fromTpl('tpl-aut-list');
    const rules = P.automationsOf(A.pid);
    const body = $('.dialog__body', el);
    const foot = $('.dialog__footer', el);
    let bodyHtml, footHtml = '';
    if (A.listPhase === 'fail') bodyHtml = failNote('规则没读出来：服务出错了。', 'aut-load-retry', 'aut-load-retry'); // 取不回来不画成空态（REQ-AUT-006）
    else if (A.listPhase === 'loading') bodyHtml = loadingLine('正在读取自动化规则…');
    else if (!rules.length) {
      const e = P.fromTpl('tpl-aut-empty');
      Object.assign($('.empty__actions .btn', e).dataset, { action: 'aut-new', fk: 'aut-new' });
      bodyHtml = e.outerHTML; // 空态时页脚不出第二个 [新建规则]
    } else {
      const err = A.listErr ? `<div class="note note--fail note--center" role="alert"><span class="icon i-circle-x" aria-hidden="true"></span><div class="note__body"><span class="note__text">${esc(A.listErr)}</span></div></div>` : '';
      bodyHtml = `${err}<ul class="aut-rules" aria-label="自动化规则列表">${rules.map(ruleRow).join('')}</ul>`;
      if (rules.length >= LIMIT) {
        footHtml = `${P.fromTpl('tpl-aut-limit').outerHTML}<div class="dialog__footer-end"><button class="btn btn--primary btn--32" type="button" aria-disabled="true" aria-describedby="aut-limit" data-reason="${LIMIT_TEXT}" data-fk="aut-new"><span class="icon i-plus" aria-hidden="true"></span>新建规则</button></div>`;
      } else {
        const b = $('.dialog__footer-end .btn', foot); Object.assign(b.dataset, { action: 'aut-new', fk: 'aut-new' });
        footHtml = foot.innerHTML;
      }
    }
    body.innerHTML = bodyHtml;
    const html = header('自动化规则', `在 ${p.name} 中`) + body.outerHTML + (footHtml ? `<div class="dialog__footer">${footHtml}</div>` : '') + closeBtn;
    return { html, init: wireScroll, focus: rules.length && A.listPhase === 'ok' ? '.aut-rule__main' : '.dialog__body .btn, .dialog__footer .btn, .dialog__close' };
  }

  // ---------------------------------------------------------------- 详情（f-aut-rules-07 / 08 / 10 / 11）
  function histState(r) {
    if (!A.hist[r.id]) A.hist[r.id] = { phase: P.scenario.is('aut-history', 'fail') ? 'fail' : 'ok', loaded: Math.min(PAGE, (r.runs || []).length), all: false, open: new Set(), more: false };
    return A.hist[r.id];
  }
  function runRow(r, run) {
    const K = KIND[run.k];
    const h = histState(r);
    const open = h.open.has(run.id);
    const label = run.k === 'queued' ? `${K.label} ${run.n || 1}/5` : K.label;
    const t = run.task ? P.task(run.task) : null;
    let detail = '';
    if (open) {
      // 运行详情的标记来自 f-aut-rules-08（tpl-aut-run-detail）：按这次运行换字，没有的块删掉
      const d = P.fromTpl('tpl-aut-run-detail');
      d.id = `aut-run-${run.id}`;
      $('.aut-run__why', d).textContent = K.why;
      const errBox = $('.aut-run__err', d);
      if (run.err) { const pre = $('pre', errBox); pre.textContent = run.err; pre.tabIndex = 0; pre.setAttribute('aria-label', '失败信息（后端原文）'); } else errBox.remove(); // 等宽块会横向滚动：能聚焦（axe scrollable-region-focusable）
      const hookNote = $(':scope > p.aut-run__note', d);
      if (r.hook && run.hook) hookNote.textContent = HOOK_NOTE[run.hook]; else hookNote.remove();
      const sumPre = $(':scope > pre.aut-code--tall', d);
      if (run.summary) { sumPre.textContent = run.summary; sumPre.tabIndex = 0; } else sumPre.remove();
      // [打开任务]：只在这次运行带得出任务、且那个任务还在时出（Q-AUT-02 默认 A：跑完收尾之后已结束的运行没有任务可开）
      const openBox = $('.aut-run__open', d);
      if (t && t.state !== 'destroying') Object.assign($('.btn', openBox).dataset, { action: 'aut-open-task', task: t.id, fk: `aut-task:${run.id}` }); else openBox.remove();
      detail = d.outerHTML;
    }
    const counts = K.counts ? '<p class="aut-run__count aut-run__count--counts"><span class="icon icon--14 tone-warn i-triangle-alert" aria-hidden="true"></span>这次算一次失败</p>' : '<p class="aut-run__count">这次不算失败</p>';
    return `<li class="aut-run" data-category="${K.cat}" data-run="${run.id}"><div class="aut-run__head"><span class="icon ${K.icon}" aria-hidden="true"></span><span class="aut-run__label ${K.lc}">${esc(label)}</span><span class="aut-run__time">${fmtAt(run.at, r.tz)}</span>${run.dur ? `<span class="aut-run__dur">耗时 ${esc(run.dur)}</span>` : ''}<button class="btn btn--tertiary btn--28 aut-run__toggle" type="button" aria-expanded="${open}"${open ? ` aria-controls="aut-run-${run.id}"` : ''} data-action="aut-run" data-run="${run.id}" data-fk="aut-run:${run.id}">${open ? '收起' : '详情'}</button></div>${counts}${detail}</li>`;
  }
  function historyHtml(r) {
    const h = histState(r);
    const runs = r.runs || [];
    let meta, inner;
    if (h.phase === 'fail') { meta = '共 — 次'; inner = failNote('运行历史没读出来：服务出错了。', 'aut-hist-retry', 'aut-hist-retry'); } // 读不到不写「共 0 次」（DR-22）
    else if (h.phase === 'loading') { meta = ''; inner = loadingLine('正在读取运行历史…'); }
    else if (!runs.length) { meta = '共 0 次'; inner = P.fromTpl('tpl-aut-history-empty').outerHTML; }
    else {
      const hasMore = h.loaded < runs.length;
      meta = hasMore ? `已加载 ${h.loaded} 次` : `共 ${h.loaded} 次`; // 游标拿不到总数：翻到底才写「共 N 次」
      const shown = runs.slice(0, h.all ? h.loaded : Math.min(PREVIEW, h.loaded));
      let more = '';
      if (!h.all && h.loaded > PREVIEW) more = '<div class="aut-runs__more"><button class="btn btn--tertiary btn--32" type="button" data-action="aut-all" data-fk="aut-all">查看全部</button></div>';
      else if (h.all && hasMore) more = h.more ? '<div class="aut-runs__more"><button class="btn btn--tertiary btn--32 is-loading" type="button" aria-disabled="true" aria-busy="true" data-fk="aut-more"><span class="icon icon--spin i-loader-circle" aria-hidden="true"></span>加载中…</button></div>' : '<div class="aut-runs__more"><button class="btn btn--tertiary btn--32" type="button" data-action="aut-more" data-fk="aut-more">加载更多</button></div>';
      inner = `<ul class="aut-runs">${shown.map((x) => runRow(r, x)).join('')}</ul>${more}`;
    }
    return `<section class="aut-history" aria-labelledby="aut-hist-t"><div class="aut-history__head"><h4 class="aut-history__title" id="aut-hist-t">运行历史</h4>${meta ? `<span class="aut-history__meta">${meta}</span>` : ''}</div>${inner}</section>`;
  }
  function detailView({ ruleId }) {
    const r = ruleOf(ruleId);
    const p = proj();
    const el = P.fromTpl('tpl-aut-detail');
    const body = $('.dialog__body', el);
    Object.assign($('.aut-back', body).dataset, { action: 'aut-back', fk: 'aut-back' });
    const warn = r.state === 'throttled' || r.state === 'auto-disabled';
    $('.aut-detail__head', body).innerHTML = `<h3 class="aut-detail__name"><span class="icon ${ICON[r.state]}" aria-hidden="true"></span><span>${esc(r.name)}</span></h3><p class="aut-detail__status${warn ? ' tone-warn' : ''}">${esc(statusLine(r))}</p>`;
    const hook = r.hook ? `${esc(r.hook.url)} · ${(TRIGGERS.find((x) => x[0] === r.hook.on) || TRIGGERS[0])[2]}` : '没开';
    $('.aut-kv', body).innerHTML = `<dt>Agent</dt><dd>${esc(agentName(r))}</dd><dt>什么时候跑</dt><dd>${esc(schedText(sched(r)))}</dd><dt>时区</dt><dd>${esc(r.tz)}（建规则时定下的，改别的字段不会动它）</dd><dt>最长运行时间</dt><dd>${tLabel(r.timeoutMin)}</dd><dt>成果保留期</dt><dd>${r.keepDays} 天（存放在项目的「保留下来的成果」里）</dd><dt>撞上了怎么办</dt><dd>跳过（上一次还在跑，这一次就不再起一个）</dd><dt>Webhook 通知</dt><dd>${hook}</dd><dt>连着失败</dt><dd>${r.fails} 次</dd>`;
    const cps = P.cp(r.prompt || '');
    $('.aut-prompt-box', body).textContent = cps.length > 300 ? `${cps.slice(0, 300).join('')}…` : cps.join(''); // 前 300 字，超出加「…」（REQ-AUT-020）
    const busy = !!A.toggling[r.id];
    const row = $('.btn-row', body);
    row.innerHTML = `<button class="btn btn--secondary btn--32" type="button" data-action="aut-edit" data-rule="${r.id}" data-fk="aut-edit">编辑</button><button class="btn btn--secondary btn--32" type="button"${busy ? ' aria-disabled="true"' : ''} data-action="aut-toggle" data-rule="${r.id}" data-fk="aut-dtoggle">${toggleLabel(r)}</button><button class="btn btn--danger-tertiary btn--32" type="button" data-action="aut-delete" data-rule="${r.id}" data-fk="aut-delete">删除</button>`;
    if (A.actErr) row.insertAdjacentHTML('beforebegin', `<div class="note note--fail note--center" role="alert"><span class="icon i-circle-x" aria-hidden="true"></span><div class="note__body"><span class="note__text">${esc(A.actErr)}</span></div></div>`);
    $('.aut-history', body).outerHTML = historyHtml(r);
    const html = header('自动化规则', `在 ${p.name} 中`) + body.outerHTML + closeBtn;
    return { html, init: wireScroll, focus: '[data-fk="aut-back"]' };
  }
  function showDetail(ruleId, { reason = false, focusFk } = {}) {
    const r = ruleOf(ruleId); if (!r) { show('list'); return; }
    A.ruleId = ruleId; A.actErr = null;
    const h = histState(r);
    let target = null;
    if (reason && h.phase === 'ok') {
      // [查看原因]：自动展开最近一次算失败的运行；不在最近 10 条里就同时展开全部（REQ-AUT-023 / Q-AUT-04 A：滚进视野、焦点给它的 [收起]）
      const runs = r.runs || [];
      const i = runs.findIndex((x) => KIND[x.k].counts);
      if (i >= 0) { target = runs[i]; if (i >= PREVIEW) { h.all = true; h.loaded = Math.max(h.loaded, Math.min(runs.length, Math.ceil((i + 1) / PAGE) * PAGE)); } h.open.add(target.id); }
    }
    show('detail', { ruleId }, target ? { focusFk: `aut-run:${target.id}` } : focusFk ? { focusFk } : undefined);
    // 第五段（R2-28）：展开的那条运行滚到正文顶部（上留 12），失败信息、输出摘要、[打开任务] 都进视野——原来只把标题滚进视野（block: 'nearest'），
    // 视口上方露出的是 Webhook 设置与任务内容；焦点已经在它的 [收起] 上（Q-AUT-04 A，AC-AUT-023.4）
    if (target) {
      const li = $(`[data-run="${target.id}"]`, A.m.box), body = $('.dialog__body', A.m.box);
      if (li && body) { body.scrollTop = Math.max(0, li.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 12); body.dispatchEvent(new Event('scroll')); }
    }
  }
  // 只重画运行历史一节（展开 / 收起、查看全部、加载更多不把正文滚回顶部），焦点按 data-fk 找回
  function paintHistory(focusFk) {
    const r = ruleOf(A.ruleId); if (!r || A.view !== 'detail') return;
    const sec = $('.aut-history', A.m.box); if (!sec) return;
    const a = document.activeElement, fk = focusFk || (a && a.getAttribute && a.getAttribute('data-fk'));
    sec.outerHTML = historyHtml(r);
    const again = fk && $(`[data-fk="${CSS.escape(fk)}"]`, A.m.box);
    if (again && !again.disabled) again.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- 表单（f-aut-rules-04 / 05 / 06）
  const RE_URL_ERR = { empty: '启用了通知就必须填 Webhook URL。', bad: 'URL 格式不正确（需要形如 https://example.com/hook）。', proto: '只支持 http / https。' };
  function urlError(u) {
    const v = (u || '').trim();
    if (!v) return RE_URL_ERR.empty;
    let x; try { x = new URL(v); } catch (e) { return RE_URL_ERR.bad; }
    return x.protocol === 'http:' || x.protocol === 'https:' ? null : RE_URL_ERR.proto;
  }
  function errorsOf(f) {
    const e = {};
    if (!f.name.trim()) e.name = '请填写规则名称。'; else if (P.cp(f.name.trim()).length > 60) e.name = '规则名称最多 60 个字。'; // 长度两条为新增暂行句（Q-AUT-06 合并说明）
    if (P.cp(f.desc.trim()).length > 500) e.desc = '描述最多 500 个字。';
    if (!f.agent) e.agent = '请选择用哪个 Agent 跑。';
    const n = P.cp(f.prompt.trim()).length;
    if (!n) e.prompt = '请填写任务内容。'; else if (n > 8000) e.prompt = '任务内容超出 8000 字符上限。';
    if (f.kind === 'hourly') { if (String(f.minute).trim() === '') e.sched = '请填写每小时触发的分钟。'; else if (!/^\d{1,2}$/.test(String(f.minute).trim()) || Number(f.minute) > 59) e.sched = '分钟必须是 0–59 的整数。'; }
    else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(f.time || '')) e.sched = '请填写合法的触发时间（HH:MM）。';
    else if (f.kind === 'weekly' && !f.days.length) e.sched = '请至少选择一天。';
    if (f.hookOn) { const u = urlError(f.url); if (u) e.url = u; }
    return e;
  }
  const draftSched = (f) => ({ kind: f.kind, time: f.time, minute: Number(f.minute) || 0, days: f.days.slice() });
  function newDraft() {
    return { mode: 'new', ruleId: null, name: '', desc: '', agent: '', prompt: '', timeout: 120, kind: 'daily', time: '08:00', minute: '0', days: [], tz: LOCAL_TZ, tz0: LOCAL_TZ, keep: 7, hookOn: false, url: '', on: 'failure', touched: new Set(), test: null, testing: false, saving: false, saveErr: null, adv: false };
  }
  function editDraft(r) {
    const s = sched(r);
    return { mode: 'edit', ruleId: r.id, name: r.name, desc: r.desc || '', agent: r.agentId, prompt: r.prompt || '', timeout: r.timeoutMin, kind: s.kind, time: s.kind === 'hourly' ? '08:00' : s.time, minute: String(s.minute), days: s.days.slice(), tz: r.tz, tz0: r.tz, keep: r.keepDays, hookOn: !!r.hook, url: r.hook ? r.hook.url : '', on: r.hook ? r.hook.on : 'failure', touched: new Set(), test: null, testing: false, saving: false, saveErr: null, adv: false };
  }
  // 调度一组里随「每天 / 每小时 / 每周」换的输入（时间 / 分钟 / 星期），标记同 04 / 06
  function schedInputs(f) {
    if (f.kind === 'hourly') return `<div class="aut-inline" data-aut-sched><label class="aut-sublabel" for="f-minute">第几分钟</label><input class="input input--32 aut-time" id="f-minute" type="text" inputmode="numeric" value="${esc(f.minute)}" data-af="minute" data-fk="aut-f-minute"></div>`;
    const time = `<div class="aut-inline" data-aut-sched><label class="aut-sublabel" for="f-time">时间</label><input class="input input--32 aut-time i-clock" id="f-time" type="time" value="${esc(f.time)}" data-af="time" data-fk="aut-f-time"></div>`;
    if (f.kind !== 'weekly') return time;
    const days = P.fromTpl('tpl-aut-days');
    days.dataset.autSched = '';
    $$('input.checkbox', days).forEach((c, i) => { c.dataset.af = 'day'; c.value = String(i); chk(c, f.days.includes(i)); c.dataset.fk = `aut-f-day:${i}`; });
    return time + days.outerHTML;
  }
  function formView() {
    const f = A.form;
    const p = proj();
    const el = P.fromTpl('tpl-aut-form');
    const body = $('.dialog__body', el);
    $('.form-note', body).textContent = `${f.mode === 'edit' ? '编辑' : '新建'}自动化规则：到点自动起一个无头任务，跑完自动销毁实例、只留成果。`;
    const set = (sel, v, af) => { const i = $(sel, body); i.setAttribute('value', v); i.dataset.af = af; i.dataset.fk = `aut-f-${af}`; return i; };
    set('#f-name', f.name, 'name');
    set('#f-desc', f.desc, 'desc');
    const ag = $('#f-agent', body); ag.dataset.af = 'agent'; ag.dataset.fk = 'aut-f-agent';
    ag.innerHTML = `<option value=""${f.agent ? '' : ' selected'}>请选择</option>${world.runtimes.map((rt) => `<option value="${rt.id}"${f.agent === rt.id ? ' selected' : ''}>${esc(rt.name)}</option>`).join('')}`;
    const pr = $('#f-prompt', body); pr.textContent = f.prompt; pr.dataset.af = 'prompt'; pr.dataset.fk = 'aut-f-prompt';
    const fs = $$('fieldset.aut-fieldset', body);
    // 最长运行时间
    $$('input[name="f-timeout"]', fs[0]).forEach((x, i) => { x.value = String(TIMEOUTS[i][0]); chk(x, TIMEOUTS[i][0] === f.timeout); x.dataset.af = 'timeout'; x.dataset.fk = `aut-f-timeout:${x.value}`; });
    // 调度：种类 + 随种类换的输入 + 时区
    const kinds = ['daily', 'hourly', 'weekly'];
    $$('input[name="f-kind"]', fs[1]).forEach((x, i) => { if (x.disabled) return; x.value = kinds[i]; chk(x, kinds[i] === f.kind); x.dataset.af = 'kind'; x.dataset.fk = `aut-f-kind:${kinds[i]}`; });
    $(':scope > .aut-inline', fs[1]).outerHTML = schedInputs(f);
    const tz = set('#f-tz', f.tz, 'tz');
    $('#f-tz-help', fs[1]).textContent = f.mode === 'edit' ? '时区是建这条规则时定下的。不动它，保存时就不会重传——否则换台机器编辑一次，触发时刻就跟着这台机器挪走了。' : '默认取你当前的时区，建好之后就定下来了；之后你换机器或改系统时区都不会影响这条规则。';
    tz.closest('.field').querySelector('label').dataset.aTzLabel = '';
    // 高级选项（默认收起）：并发只开放「跳过」；成果保留期 3 / 7 / 30 天
    const adv = $('details.aut-adv', body); if (!f.adv) adv.removeAttribute('open'); else adv.setAttribute('open', '');
    $('summary', adv).dataset.fk = 'aut-f-adv';
    $$('input[name="f-keep"]', adv).forEach((x, i) => { x.value = String(KEEPS[i]); chk(x, KEEPS[i] === f.keep); x.dataset.af = 'keep'; x.dataset.fk = `aut-f-keep:${KEEPS[i]}`; });
    $$('input[name="f-conc"]', adv).forEach((x) => { if (!x.disabled) x.dataset.fk = 'aut-f-conc'; });
    // Webhook
    const hookFs = fs[fs.length - 1];
    const cb = $('.aut-check input', hookFs); chk(cb, f.hookOn); cb.dataset.af = 'hookOn'; cb.dataset.fk = 'aut-f-hook';
    const url = set('#f-url', f.url, 'url');
    $$('input[name="f-trigger"]', hookFs).forEach((x, i) => { x.value = TRIGGERS[i][0]; chk(x, TRIGGERS[i][0] === f.on); x.dataset.af = 'on'; x.dataset.fk = `aut-f-on:${x.value}`; });
    const row = $('.aut-test-row', hookFs);
    row.innerHTML = `<button class="btn btn--secondary btn--32" type="button" data-action="aut-test" data-fk="aut-test">测试连接</button>`;
    // 页脚：[取消] [保存规则]
    const foot = $('.dialog__footer', el);
    const [cancel] = $$(':scope > .btn', foot);
    Object.assign(cancel.dataset, { action: 'aut-cancel', fk: 'aut-cancel' });
    Object.assign($('.dialog__footer-end .btn', foot).dataset, { action: 'aut-save', fk: 'aut-save' });
    // 没启用 Webhook 时地址框、时机、测试一起收起（请求里也不带这两个键，REQ-AUT-012）
    for (const x of [url, $('[role="radiogroup"]', hookFs), row]) x.dataset.autHook = '';
    const html = header('自动化规则', `在 ${p.name} 中`) + body.outerHTML + foot.outerHTML + closeBtn;
    return { html, init: (box) => { wireScroll(box); syncForm(box); }, focus: '#f-name' };
  }
  // 表单里随输入变的部分就地改（不重建：输入、焦点、光标都留着）：计数、预览、时区「已修改」、字段错误（改过或失焦才亮，Q-AUT-06 A）、Webhook 一节、测试结果、页脚
  function syncForm(box) {
    box = box || A.m.box;
    const f = A.form; if (!f || A.view !== 'form') return;
    const errs = errorsOf(f);
    const n = P.cp(f.prompt.trim()).length;
    const cnt = $('#f-prompt-count', box); cnt.textContent = `${n} / 8000`; cnt.classList.toggle('tone-fail', n > 8000);
    $('.aut-preview > span:last-child', box).textContent = `预览：${schedText(draftSched(f))}（${f.tz.trim() || '…'}）`;
    const lab = $('[data-a-tz-label]', box);
    const touchedTz = f.mode === 'edit' && f.tz.trim() !== f.tz0;
    let tt = $('.aut-tz-touched', lab);
    if (touchedTz && !tt) lab.appendChild(P.fromTpl('tpl-aut-tz-touched'));
    else if (!touchedTz && tt) tt.remove();
    // 字段错误：紧贴出错的控件；控件 aria-invalid + aria-describedby 指过去
    const place = { name: '#f-name', desc: '#f-desc', agent: '#f-agent', prompt: '#f-prompt', url: '#f-url' };
    const shown = (k) => errs[k] && (f.touched.has(k) || f.submitTried);
    for (const k of ['name', 'desc', 'agent', 'prompt', 'url', 'sched']) {
      const id = `f-${k}-err`;
      let e = $(`#${id}`, box);
      const want = shown(k);
      if (!want) { if (e) e.remove(); }
      else {
        if (!e) {
          e = P.fromTpl('tpl-aut-field-error', { keepRoles: true }); e.id = id;
          if (k === 'sched') $$('[data-aut-sched]', box).pop().after(e);
          else if (k === 'agent') $('#f-agent', box).closest('.select').after(e);
          else $(place[k], box).after(e);
        }
        const txt = errs[k];
        if (e.lastChild.textContent !== txt) e.lastChild.textContent = txt;
      }
      // 「请至少选择一天。」属于星期那一组（组的 aria-describedby 指过去，不把时间框标红）；其余调度错误标在时间 / 分钟框上
      const daysErr = k === 'sched' && f.kind === 'weekly' && /^([01]\d|2[0-3]):[0-5]\d$/.test(f.time || '');
      const ctl = k === 'sched' ? (daysErr ? $('[role="group"][data-aut-sched]', box) : $('[data-aut-sched] input:not([type="checkbox"])', box)) : $(place[k], box);
      for (const o of $$('[data-aut-sched]', box)) if (k === 'sched' && o !== ctl && !o.contains(ctl)) { const i = o.matches('[role="group"]') ? o : $('input', o); if (i) { i.removeAttribute('aria-invalid'); i.removeAttribute('aria-describedby'); } }
      if (!ctl) continue;
      const base = k === 'prompt' ? 'f-prompt-count' : '';
      if (want) { if (!daysErr) ctl.setAttribute('aria-invalid', 'true'); ctl.setAttribute('aria-describedby', [base, id].filter(Boolean).join(' ')); }
      else { ctl.removeAttribute('aria-invalid'); if (base) ctl.setAttribute('aria-describedby', base); else ctl.removeAttribute('aria-describedby'); }
    }
    for (const x of $$('[data-aut-hook]', box)) x.hidden = !f.hookOn;
    // 测试结果（按钮右侧；图标带色、句子正文色）
    const row = $('.aut-test-row', box);
    const tb = $('[data-fk="aut-test"]', row);
    // 第五段（R1-03）：进行中的那颗按钮用 aria-disabled + aria-busy（焦点不丢）；保存中顺带不可点的 [测试连接] 照旧原生 disabled（焦点不在它上面）
    if (f.testing) P.setBusy(tb, true, P.busyHtml('测试中…'));
    else { P.setBusy(tb, false, '测试连接'); tb.disabled = f.saving; }
    let msg = $('.aut-msg', row);
    const want = f.test && !f.testing ? (f.test.ok ? `<p class="aut-msg aut-msg--ok" role="status"><span class="icon i-circle-check" aria-hidden="true"></span><span>测试消息已经送到了</span></p>` : (() => { const t = P.fromTpl('tpl-aut-msg-fail', { keepRoles: true }); t.lastElementChild.textContent = f.test.text; return t.outerHTML; })()) : '';
    if (!want && msg) msg.remove();
    else if (want && (!msg || msg.outerHTML !== want)) { if (msg) msg.remove(); row.insertAdjacentHTML('beforeend', want); }
    // 页脚：保存失败一句在第一行（role=alert，在 [保存规则] 上方、不随正文滚走）；保存中两个按钮都不可点；有任一错误 [保存规则] 不可用
    const foot = $('.dialog__footer', box);
    foot.classList.toggle('aut-footer--msg', !!f.saveErr);
    let fm = $('.aut-footer__msg', foot);
    if (f.saveErr) {
      if (!fm) { fm = P.fromTpl('tpl-aut-footer-msg', { keepRoles: true }); foot.prepend(fm); }
      $('.note__text', fm).textContent = f.saveErr;
    } else if (fm) fm.remove();
    const save = $('[data-fk="aut-save"]', foot);
    // 第五段（R1-03）：保存中 = aria-busy（焦点留在 [保存规则]；在字段里触发的保存，焦点先交给它再禁用字段）；有错时的「不可用」仍是原生 disabled（条件不满足，待定规范见 notes/wiring.md §14）
    if (f.saving) { if (box.contains(document.activeElement) && document.activeElement !== save && document.activeElement.closest('.dialog__body')) save.focus({ preventScroll: true }); P.setBusy(save, true, P.busyHtml('保存中…')); }
    else { P.setBusy(save, false, '保存规则'); save.disabled = Object.keys(errs).length > 0; }
    $('[data-fk="aut-cancel"]', foot).disabled = f.saving;
    for (const x of $$('.dialog__body input, .dialog__body select, .dialog__body textarea', box)) x.disabled = !!(f.saving || x.closest('.aut-option--disabled'));
  }
  function onInput(e) {
    if (!A || A.view !== 'form' || !A.form) return;
    const x = e.target; const k = x.dataset && x.dataset.af; if (!k) return;
    const f = A.form;
    if (k === 'day') { const d = Number(x.value); f.days = x.checked ? [...new Set([...f.days, d])] : f.days.filter((v) => v !== d); f.touched.add('sched'); }
    else if (k === 'hookOn') { f.hookOn = x.checked; f.test = null; }
    else if (k === 'timeout' || k === 'keep') f[k] = Number(x.value);
    else if (k === 'kind') {
      f.kind = x.value; f.touched.delete('sched');
      const old = $$('[data-aut-sched]', A.m.box); const at = old[0];
      at.insertAdjacentHTML('beforebegin', schedInputs(f)); for (const o of old) o.remove();
      const err = $('#f-sched-err', A.m.box); if (err) err.remove();
    }
    else { f[k] = x.value; if (k === 'url') f.test = null; }
    if (['name', 'desc', 'agent', 'prompt', 'url'].includes(k) && e.type === 'input') f.touched.add(k);
    if (['time', 'minute'].includes(k)) f.touched.add('sched');
    if (k === 'agent') f.touched.add('agent');
    if (f.saveErr && e.type === 'input') f.saveErr = null;
    syncForm();
  }
  // 失焦才亮的错误（Q-AUT-06 A）：鼠标按下引起的失焦，等松开之后再插错误句——否则错误句把下面的控件往下推，这一下点击会落空
  let pointerHeld = false, blurPending = false;
  document.addEventListener('pointerdown', () => { pointerHeld = true; }, true);
  document.addEventListener('pointerup', () => { pointerHeld = false; if (blurPending) { blurPending = false; setTimeout(() => syncForm(), 0); } }, true);
  function onBlur(e) {
    if (!A || A.view !== 'form' || !A.form) return;
    const k = e.target.dataset && e.target.dataset.af;
    if (!k || !['name', 'desc', 'agent', 'prompt', 'url', 'time', 'minute'].includes(k)) return;
    A.form.touched.add(k === 'time' || k === 'minute' ? 'sched' : k);
    if (pointerHeld) blurPending = true; else syncForm();
  }
  const INTERNAL = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
  function testHook() {
    const f = A.form;
    const u = urlError(f.url);
    if (u) { f.touched.add('url'); syncForm(); const i = $('#f-url', A.m.box); if (i) i.focus(); return; }
    f.testing = true; f.test = null; syncForm();
    P.announce('测试中…');
    const st = A;
    P.clock.after(T.autTest, () => {
      if (A !== st || A.view !== 'form' || !A.form) return;
      const sc = P.scenario.take('aut-test');
      let host = ''; try { host = new URL(f.url.trim()).hostname; } catch (e) { /* 上面已校验 */ }
      // 地址解析到内网时，只有这台机器开了访问口令才放行（HOST_NOT_ALLOWED 只在测试连接与投递时出现，保存不会回这个码）
      const code = INTERNAL.test(host) && P.scenario.is('access', 'off') ? 'HOST_NOT_ALLOWED' : sc === 'timeout' ? 'TIMEOUT' : sc === 'upstream' ? 'UPSTREAM_UNAVAILABLE' : null;
      const TEXT = {
        TIMEOUT: '发过去之后对方一直没回应（超时）。确认一下这个地址现在能不能收。',
        UPSTREAM_UNAVAILABLE: '发过去了，但对方没有正常回应。确认一下这个地址现在能不能收。',
        HOST_NOT_ALLOWED: 'Webhook 地址指向的是内网地址，出于安全没有放行。换一个公网能访问到的地址；如果确实要发到内网，需要先给这台机器开启访问口令。',
      };
      f.testing = false; f.test = code ? { ok: false, code, text: TEXT[code] } : { ok: true };
      syncForm();
      const tb = $('[data-fk="aut-test"]', A.m.box); if (tb && (document.activeElement === document.body || !A.m.box.contains(document.activeElement))) tb.focus();
      P.announce(code ? TEXT[code] : '测试消息已经送到了');
    });
  }
  function saveRule() {
    const f = A.form;
    f.submitTried = true;
    if (Object.keys(errorsOf(f)).length) { syncForm(); return; }
    f.saving = true; f.saveErr = null; A.m.busy = true; syncForm();
    P.announce('保存中…');
    const st = A;
    P.clock.after(T.autSave, () => {
      if (A !== st) return;
      A.m.busy = false; f.saving = false;
      const sc = P.scenario.take('aut-save');
      // 按码查表（REQ-AUT-014）：时区不是 IANA 名 → INVALID_TIMEZONE；断网 → 前端句；都不显示后端原文
      const tzOk = validTz(f.tz.trim());
      const err = sc === 'network' ? '规则没保存：网络不通，检查网络后再点 [保存规则]。'
        : !tzOk && (f.mode === 'new' || f.tz.trim() !== f.tz0) ? '这个时区名用不了。请选一个城市写法的时区（例如 Asia/Shanghai）—— 像 UTC+8 这样的固定偏移写法表达不了夏令时，规则会在换季时跑错点。'
          : null;
      if (err) { f.saveErr = err; syncForm(); P.announce(err); const sb = $('[data-fk="aut-save"]', A.m.box); if (sb && !sb.disabled) sb.focus(); return; }
      const values = { name: f.name.trim(), desc: f.desc.trim(), agentId: f.agent, agent: (P.runtime(f.agent) || {}).name, prompt: f.prompt.trim(), timeoutMin: f.timeout, keepDays: f.keep, sched: draftSched(f), hook: f.hookOn ? { url: f.url.trim(), on: f.on } : null };
      values.schedule = schedText(values.sched);
      let r;
      if (f.mode === 'edit') {
        r = ruleOf(f.ruleId);
        if (!r) { show('list'); return; }
        Object.assign(r, values);
        if (f.tz.trim() !== f.tz0) r.tz = f.tz.trim(); // 编辑时没显式改时区就不提交这个键（REQ-AUT-011）
      } else {
        let i = 1; while (ruleOf(`rule-n${i}`)) i++;
        r = { id: `rule-n${i}`, project: A.pid, state: 'on', fails: 0, tz: f.tz.trim(), runs: [], ...values };
        world.automations.push(r);
      }
      A.form = null;
      P.render(); // 项目详情的规则数、⌘K 的条数、横幅一起重算
      showDetail(r.id); // 新建 → 落在新规则的详情（历史「共 0 次」）；编辑 → 回该规则的详情
      P.announce(`已保存规则「${r.name}」`);
    });
  }

  // ---------------------------------------------------------------- 删除确认（f-aut-rules-09；同一弹层就地切视图，Esc = [取消] 回详情）
  function confirmView({ ruleId }) {
    const r = ruleOf(ruleId);
    const p = proj();
    const el = P.fromTpl('tpl-aut-confirm');
    const body = $('.dialog__body', el);
    const blocks = $$('.dconfirm__block', body);
    const total = (r.runs || []).length;
    const nx = nextText(r);
    // N、M 与正在跑的任务：后端预检的数（原型按示例世界给；Q-AUT-03 A）
    $('.bullets', blocks[0]).innerHTML = `<li>${total ? `这条规则，以及它的 ${total} 次运行历史` : '这条规则（它还没有运行过，没有运行历史）'}</li><li>之后不会再按时触发${nx ? ` <span class="dconfirm__meta">（原定下次 ${nx}）</span>` : ''}</li>`;
    const arts = world.retained.filter((x) => x.source === 'automation-artifact' && x.project === r.project && x.name.startsWith(`${r.name} #`));
    const running = world.tasks.filter((t) => t.headless && t.rule === r.name && t.state !== 'destroying' && P.ACTIVE.has(t.state));
    const artNote = arts.length ? `<span class="dconfirm__note">它留下的 ${arts.length} 份运行成果（来自任务 ${arts.map((a) => `${a.sandboxId.slice(0, 8)}…`).join('、')}）仍在「保留下来的成果」里，到期自动清理；到期之前都可以下载。</span>` : '';
    $('.bullets', blocks[2]).innerHTML = `<li>已经由它发起、还保留着的成果与任务${artNote}</li>${running.map((t) => `<li>正在跑的任务「${esc(t.name)}」：不会被中断，会跑完</li>`).join('')}`;
    const foot = $('.dialog__footer', el);
    const cancel = $(':scope > .btn', foot); Object.assign(cancel.dataset, { action: 'aut-del-cancel', fk: 'aut-del-cancel' });
    Object.assign($('.dialog__footer-end .btn', foot).dataset, { action: 'aut-del-confirm', fk: 'aut-del-confirm' });
    const html = header(`删除自动化规则「${r.name}」？`, `自动化规则 · 在 ${p.name} 中 · ${statusWord(r)}`) + body.outerHTML + foot.outerHTML + closeBtn;
    return { html, init: wireScroll, focus: '[data-fk="aut-del-cancel"]' };
  }
  function confirmBusy(on, err) {
    const box = A.m.box;
    const ok = $('[data-fk="aut-del-confirm"]', box), cancel = $('[data-fk="aut-del-cancel"]', box);
    cancel.disabled = on; $('[data-fk="aut-close"]', box).disabled = on;
    P.setBusy(ok, on, on ? P.busyHtml('正在删除…') : '删除规则'); // 第五段（R1-03）：焦点留在 [删除规则] 上
    A.m.busy = on;
    const foot = $('.dialog__footer', box);
    let fm = $('.aut-footer__msg', foot);
    foot.classList.toggle('aut-footer--msg', !!err);
    if (err) { if (!fm) { fm = P.fromTpl('tpl-aut-footer-msg', { keepRoles: true }); foot.prepend(fm); } $('.note__text', fm).textContent = err; }
    else if (fm) fm.remove();
  }
  function deleteRule() {
    const r = ruleOf(A.ruleId); if (!r) return;
    confirmBusy(true);
    P.announce('正在删除…');
    const st = A;
    P.clock.after(T.autDelete, () => {
      if (A !== st) return;
      if (P.scenario.take('aut-delete') === 'fail') {
        confirmBusy(false, '规则没删掉：网络不通，检查网络后再点 [删除规则]。');
        P.announce('规则没删掉：网络不通，检查网络后再点 [删除规则]。');
        $('[data-fk="aut-del-confirm"]', A.m.box).focus();
        return;
      }
      A.m.busy = false;
      const all = P.automationsOf(A.pid);
      const i = all.indexOf(r);
      const nextR = all[i + 1] || all[i - 1] || null;
      world.automations.splice(world.automations.indexOf(r), 1); // 只删规则与它的运行历史，不碰任务与成果（REQ-AUT-024）
      delete A.hist[r.id];
      A.ruleId = null;
      P.render();
      show('list', {}, nextR ? { focusFk: `aut-row:${nextR.id}` } : undefined);
      P.announce(`已删除规则「${r.name}」`);
    });
  }

  // ---------------------------------------------------------------- 启停（先改界面、再等后端；失败回滚并说原因；只禁正在启停的那一行）
  function toggleRule(r) {
    if (A.toggling[r.id]) return;
    const before = { state: r.state, fails: r.fails };
    const verb = toggleLabel(r);
    if (r.state === 'on' || r.state === 'throttled') r.state = 'off';
    else { r.state = 'on'; r.fails = 0; } // [开启] 与 [重新开启] 是同一个动作：同时清零计数与放慢标记（REQ-AUT-004）
    A.toggling[r.id] = true; A.listErr = null; A.actErr = null;
    const where = A.view;
    const fk = where === 'detail' ? 'aut-dtoggle' : `aut-toggle:${r.id}`;
    repaint(fk);
    P.render();
    P.announce(`「${r.name}」${statusLine(r)}`);
    const st = A;
    P.clock.after(T.autToggle, () => {
      if (A !== st) return;
      delete A.toggling[r.id];
      if (P.scenario.take('aut-toggle') === 'fail') {
        Object.assign(r, before);
        const msg = `没能${verb}「${r.name}」：网络不通，请稍后再试。`;
        if (A.view === 'detail') A.actErr = msg; else A.listErr = msg;
        P.announce(msg);
      }
      repaint(fk);
      P.render();
    });
  }
  function repaint(focusFk) {
    if (A.view === 'list') show('list', {}, { focusFk });
    else if (A.view === 'detail') {
      const b = $('.dialog__body', A.m.box); const top = b ? b.scrollTop : 0;
      show('detail', { ruleId: A.ruleId }, { focusFk });
      const b2 = $('.dialog__body', A.m.box); if (b2) b2.scrollTop = top;
    }
  }

  // ---------------------------------------------------------------- 动作
  Object.assign(P.actions, {
    'aut-close': () => { if (A) P.closeModal(A.m); },
    'aut-open': (el) => showDetail(el.dataset.rule),
    'aut-why': (el) => { if (el.getAttribute('aria-disabled') !== 'true') showDetail(el.dataset.rule, { reason: true }); },
    'aut-back': () => { const id = A.ruleId; A.ruleId = null; show('list', {}, { focusFk: `aut-row:${id}` }); },
    'aut-toggle': (el) => { const r = ruleOf(el.dataset.rule); if (r) toggleRule(r); },
    'aut-new': () => { A.form = newDraft(); A.formFrom = { view: A.view }; show('form'); },
    'aut-edit': (el) => { const r = ruleOf(el.dataset.rule); if (!r) return; A.form = editDraft(r); A.formFrom = { view: 'detail', ruleId: r.id }; show('form'); },
    'aut-cancel': () => {
      const from = A.formFrom || { view: 'list' };
      A.form = null;
      if (from.view === 'detail' && ruleOf(from.ruleId)) showDetail(from.ruleId, { focusFk: 'aut-edit' }); // 编辑 [取消] → 回该规则的详情，改动丢弃
      else show('list', {}, { focusFk: 'aut-new' });
    },
    'aut-save': () => { if (A && A.form && !A.form.saving) saveRule(); },
    'aut-test': () => { if (A && A.form && !A.form.testing) testHook(); },
    'aut-delete': (el) => { A.ruleId = el.dataset.rule; show('confirm', { ruleId: el.dataset.rule }, { focus: '[data-fk="aut-del-cancel"]' }); },
    'aut-del-cancel': () => showDetail(A.ruleId, { focusFk: 'aut-delete' }),
    'aut-del-confirm': () => deleteRule(),
    'aut-run': (el) => {
      const h = A.hist[A.ruleId]; if (!h) return;
      const id = el.dataset.run;
      if (h.open.has(id)) h.open.delete(id); else h.open.add(id);
      paintHistory(`aut-run:${id}`);
    },
    'aut-all': () => { const h = A.hist[A.ruleId]; h.all = true; paintHistory('aut-more'); const f = $('[data-fk="aut-more"]', A.m.box); if (!f) { const first = $(`.aut-run:nth-child(${PREVIEW + 1}) .aut-run__toggle`, A.m.box); if (first) first.focus({ preventScroll: true }); } },
    'aut-more': () => {
      const r = ruleOf(A.ruleId); const h = A.hist[r.id]; if (h.more) return;
      h.more = true; paintHistory('aut-more');
      P.announce('加载中…');
      const st = A, from = h.loaded;
      P.clock.after(T.autMore, () => {
        if (A !== st || A.ruleId !== r.id) return;
        h.more = false; h.loaded = Math.min((r.runs || []).length, h.loaded + PAGE);
        const first = r.runs[from];
        paintHistory(first ? `aut-run:${first.id}` : null);
        P.announce(h.loaded >= r.runs.length ? `运行历史已全部加载：共 ${h.loaded} 次` : `已加载 ${h.loaded} 次`);
      });
    },
    'aut-hist-retry': () => {
      const r = ruleOf(A.ruleId); const h = A.hist[r.id];
      h.phase = 'loading'; paintHistory();
      P.announce('正在读取运行历史…');
      const st = A;
      P.clock.after(T.autLoad, () => {
        if (A !== st || A.ruleId !== r.id) return;
        P.scenario.reset('aut-history');
        h.phase = 'ok'; h.loaded = Math.min(PAGE, (r.runs || []).length);
        paintHistory();
        const t = $('.aut-history .aut-run__toggle, .aut-history__empty', A.m.box);
        if (t && t.matches('button')) t.focus({ preventScroll: true });
        P.announce(r.runs.length ? `运行历史已读取：${r.runs.length > PAGE ? `已加载 ${h.loaded}` : `共 ${h.loaded}`} 次` : '这条规则还没有运行过');
      });
    },
    'aut-load-retry': () => {
      A.listPhase = 'loading'; show('list');
      P.announce('正在读取自动化规则…');
      const st = A;
      P.clock.after(T.autLoad, () => { if (A !== st) return; P.scenario.reset('aut-load'); A.listPhase = 'ok'; show('list'); P.announce('自动化规则已读取'); });
    },
    'aut-open-task': (el) => {
      // [打开任务]：关掉弹层，在工作台选中这个无头任务（F-SBX-HEADLESS 只读输出）
      const id = el.dataset.task;
      P.closeModal(A.m, { restoreFocus: false });
      P.go(`task-${id}`);
    },
  });
  // Esc：删除确认视图里 = [取消]（回详情、弹层不关）；其余视图照常关整个弹层（REQ-AUT-002 / AC-AUT-024.2）
  P.hook('escape', () => {
    const top = P.topModal();
    if (!A || !top || top !== A.m || A.view !== 'confirm' || A.m.busy) return undefined;
    showDetail(A.ruleId, { focusFk: 'aut-delete' });
    return true;
  });
  // 「已满 20 条」场景：acme-web 补到 20 条（开着的弹层就地重画）
  P.hook('scenario', (k) => {
    if (k === 'aut-limit') { applyLimit(); if (A && A.view === 'list') show('list'); P.render(); }
    if (k === 'aut-banner') { applyBannerScenario(); P.render(); }
  });
  P.hook('boot', () => applyLimit());

  // ---------------------------------------------------------------- 测试出口（只读快照）
  P.stateExtras.push(() => ({
    aut: {
      open: !!(A && P.modals.includes(A.m)), project: A ? A.pid : null, view: A ? A.view : null, rule: A ? A.ruleId : null, seen: [...seen],
      overview: (P.autOverview() || null) && P.autOverview().map((r) => r.id), // 跨项目规则概览（读取失败 = null）
      form: A && A.form ? { mode: A.form.mode, saving: A.form.saving, testing: A.form.testing, errors: errorsOf(A.form), touched: [...A.form.touched], tzTouched: A.form.mode === 'edit' && A.form.tz.trim() !== A.form.tz0 } : null,
      rules: world.automations.map((r) => ({ id: r.id, project: r.project, name: r.name, agent: r.agentId, state: r.state, fails: r.fails, tz: r.tz, schedule: schedText(sched(r)), next: nextText(r), runs: (r.runs || []).length, timeoutMin: r.timeoutMin, keepDays: r.keepDays, hook: r.hook ? { ...r.hook } : null })),
    },
  }));
})();
