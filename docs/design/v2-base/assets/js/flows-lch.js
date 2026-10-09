/*
 * 交互原型 · 任务生命周期（js/flows-lch.js）：L2 六个流程
 *   F-LCH-FORM      新建任务弹层（项目下拉、Agent 必选与凭证闸门、指令上限、加载中 / 加载失败 / 开不了终端、同步失败回填、深链 #new&project=）
 *   F-LCH-STARTUP   发起后的启动流程（创建中 → 准备中四阶段 → 运行中；可能卡住 → 继续等待 / 取消并删除；拉镜像失败 / 超时转异常）
 *   F-SBX-RELAUNCH  失败任务怎么重来（[重新发起] 预选项目与 Agent、[检查镜像地址] 跳镜像页带来源提示、[复制诊断信息]）
 *   F-SBX-STOPSTART 停止与启动（停止中 → 已停止 → 启动中 → 运行中；停止 / 启动失败转异常；状态已变 409）
 *   F-SBX-DESTROY   销毁过程（确认 → 删除中 → 移除；页内提示两态）
 *   F-SBX-HEADLESS  无头任务（只读输出逐条追加、剩余时间、行内确认终止、事件流重连 / 断开、本轮结果、续接与下一轮）
 * 标记来源：gap/drafts/f-lch-*.html、f-sbx-*.html（index.html 的 tpl-new-task / tpl-nt-* / tpl-task-* / tpl-hl-* / tpl-cancel-delete 模板）；
 * 产品口径：gap/product/LCH.md、SBX.md（AC 的 Then）；接线要点：gap/drafts/notes/lch-a.md §6、lch-b.md §8、consistency.md。
 * 2026-10-04 用户拍板（原话「补全 10 条按推荐」，consistency.md §9、notes/wiring.md §15）：
 *   Q-LCH-03 B  新建任务的可选「镜像」一栏（f-lch-form-10 的展开列表）、[重新发起] 预选原任务的镜像、任务记下锁定的那一版（启动进度卡 / 结果卡 / 任务菜单 / 复制诊断信息）
 *   Q-SYS-01② A 环境类错误（PROVIDER_UNAVAILABLE、DISK_INSUFFICIENT）的结果卡带 [运行诊断]（去系统状态并自动开始一轮诊断）
 *   Q-SBX-02 B  只有首次启动阶段失败的不给「留下来作为成果」；其余异常任务给且默认选中（f-sbx-destroy-03 那一句按失败阶段换说法）
 *   Q-SBX-03 A  屏上统一叫「代码副本」（代码里的 keep / workdir 这类标识符不改）
 */
(function () {
  'use strict';
  const P = window.P;
  const { $, $$, esc, ui, menuItem, SEP, STATE } = P;
  const world = P.world;
  const T = P.TIMING;

  // ------------------------------------------------------------------ 场景
  const G1 = '发起任务', G2 = '任务生命周期';
  // 2026-10-04：加三种——两种环境类错误（Q-SYS-01② A：结果卡带 [运行诊断]）与「所选镜像在提交前刚被禁用」的门口拒绝（Q-LCH-03 B，AC-LCH-004.9）
  P.scenario.define({ key: 'launch', group: G1, label: '下一次发起', once: true, def: 'ok', options: [['ok', '成功'], ['resource', '资源不够（429）'], ['gate', '门口拒绝（分支不存在）'], ['image-gone', '门口拒绝（所选镜像刚被别处禁用：这张镜像随之标成已禁用）'], ['stuck', '卡住（停在拉取镜像）'], ['pull-fail', '拉镜像失败'], ['timeout', '超时'], ['first-image', '首次使用镜像（长等待）'], ['provider', '容器服务没有响应（环境类错误）'], ['disk', '磁盘空间不够，代码副本没能准备出来（环境类错误）']] });
  P.scenario.define({ key: 'nt-load', group: G1, label: '新建任务弹层（打开时）', def: 'ok', options: [['ok', '正常'], ['loading', '加载中'], ['fail', '加载失败'], ['notty', '这台机器开不了终端']] });
  P.scenario.define({ key: 'nt-images', group: G1, label: '新建任务弹层：镜像列表', def: 'ok', options: [['ok', '正常（列出镜像管理里的镜像）'], ['fail', '读不到（只剩平台预制镜像，照常可发起）']] });
  P.scenario.define({ key: 'stop', group: G2, label: '下一次停止', once: true, def: 'ok', options: [['ok', '成功'], ['fail', '失败（容器服务没有响应）'], ['conflict', '状态已变（409）']] });
  P.scenario.define({ key: 'start', group: G2, label: '下一次启动', once: true, def: 'ok', options: [['ok', '成功'], ['fail', '失败（容器服务没有响应）'], ['conflict', '状态已变（409）']] });
  // 第五段（W4，评审 R2-34④）：销毁失败（REQ-SBX-022；f-sbx-destroy-02）——provider.destroy 抛错：任务转异常、名额释放，结果卡给 [销毁任务…]（删除幂等，再试一次）
  P.scenario.define({ key: 'destroy', group: G2, label: '下一次销毁', once: true, def: 'ok', options: [['ok', '成功'], ['fail', '失败（容器服务没有响应）']] });
  P.scenario.define({ key: 'hl-stream', group: G2, label: '无头任务：事件流', def: 'ok', options: [['ok', '正常'], ['drop', '断开（自动重连 8 次后停）']] });
  P.scenario.define({ key: 'hl-end', group: G2, label: '无头任务：本轮', once: true, def: 'run', options: [['run', '照常跑'], ['fail', '马上结束（失败）']] });
  P.scenario.define({ key: 'hl-session', group: G2, label: '无头任务：会话引用', def: 'yes', options: [['yes', '拿到了'], ['no', '没拿到（不能续接）']] });
  P.scenario.define({ key: 'clipboard', group: G2, label: '剪贴板', def: 'auto', options: [['auto', '按浏览器（file:// 下多半失败）'], ['ok', '可用'], ['fail', '不可用']] });

  // ------------------------------------------------------------------ 失败文案（按错误码查表；码不进句子，只进诊断码行、data-code 与复制文本——REQ-SBX-001、DR-34）
  const FAILURE = (P.FAILURE = {
    IMAGE_PULL_FAILED: { tone: 'fail', icon: 'i-circle-x', title: '没能把镜像拉下来（网络不通，或者镜像名写错了）', desc: '先确认平台这台机器能连上镜像下载源，再检查镜像地址有没有写错，然后<span class="u-nowrap">重新发起</span>。', actions: ['relaunch', 'check-image', 'copy-diag'] },
    // Q-SBX-01 默认 A：拿不到时长就不写数字（稿件 f-sbx-relaunch-02 的「600 秒」是 v1 示例值）
    TIMEOUT: { tone: 'timeout', icon: 'i-clock', title: '超时未响应：这一步等太久，平台先停下了', desc: '在限定时间内没有等到应答。超时只说明这次在限定时间内没做完，不等于对面连不上。可以<span class="u-nowrap">重新发起</span>；一直超时就看看容器服务是不是负载过高。', actions: ['relaunch', 'copy-diag'] },
    // 环境类错误（2026-10-04 用户拍板 Q-SYS-01② A；REQ-SBX-001、f-sbx-stopstart-04 / f-sbx-destroy-02）：原因在这台机器的运行环境、不在任务配置里——
    // 动作里另有 [运行诊断]（secondary，排在主动作之后、[复制诊断信息] 之前；= 去系统状态并自动开始一轮诊断，同离线横幅 [重新检测]）；
    // 建议句不再只点名 Docker Desktop / OrbStack（这台机器跑的可能是 boxlite），改指向 [运行诊断]
    PROVIDER_UNAVAILABLE: { tone: 'fail', icon: 'i-circle-x', env: true, title: '容器服务没有响应', desc: '平台连不上这台机器上的容器服务。点 [运行诊断] <span class="u-nowrap">看看用的是哪一种沙箱环境</span>、起没起来，它起来之后<span class="u-nowrap">重新发起</span>。', actions: ['relaunch', 'diagnose', 'copy-diag'],
      note: { start: '这次是在 [启动] 时失败的，任务已转为异常、不能再启动。<span class="u-nowrap">代码副本还在</span>：销毁时选「留下来作为成果」就不会丢。', stop: '这次是在 [停止] 时失败的，任务已转为异常、不能再启动。<span class="u-nowrap">代码副本还在</span>：销毁时选「留下来作为成果」就不会丢。', destroy: '这次是在销毁时失败的：任务已转为异常，占的名额已经释放。删除可以放心再试一次——同一个任务删两次不会出错。' },
      // 第五段（R2-34④，f-sbx-destroy-02）：销毁失败时建议句与动作换成「再销毁一次」——删除幂等，[重新发起] 不对题
      descAt: { destroy: '平台连不上这台机器上的容器服务。点 [运行诊断] <span class="u-nowrap">看看用的是哪一种沙箱环境</span>、起没起来，它起来之后<span class="u-nowrap">再销毁一次</span>。' },
      actionsAt: { destroy: ['destroy', 'diagnose', 'copy-diag'] } },
    // 另一个环境类码（REQ-SBX-001 的「磁盘空间不够，代码副本没能准备出来」）：示例世界里没有这张卡，场景「下一次发起：磁盘空间不够」演示；建议句没有稿件，按资源卡的下一步写
    DISK_INSUFFICIENT: { tone: 'fail', icon: 'i-circle-x', env: true, title: '磁盘空间不够，代码副本没能准备出来', desc: '这台机器的磁盘放不下这个任务的代码副本。点 [运行诊断] <span class="u-nowrap">看看磁盘还剩多少</span>；清理保留下来的成果或删掉不用的项目之后，<span class="u-nowrap">重新发起</span>。', actions: ['relaunch', 'diagnose', 'copy-diag'] },
  });
  const FALLBACK = { tone: 'fail', icon: 'i-circle-x', title: '操作没有完成', desc: '未能获取具体原因，可以重试一次；若持续失败请查看系统状态。', actions: ['relaunch', 'copy-diag'] };
  const failureOf = (t) => FAILURE[t.code] || FALLBACK;
  const DETAIL = {
    IMAGE_PULL_FAILED: 'pull ghcr.io/agent-infra/sandbox@sha256:4b17e…344: dial tcp: lookup ghcr.io: i/o timeout',
    TIMEOUT: 'create instance: no response from the container service within 600s',
    PROVIDER_UNAVAILABLE_start: 'start instance: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    PROVIDER_UNAVAILABLE_stop: 'stop instance: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    PROVIDER_UNAVAILABLE_destroy: 'destroy instance: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    PROVIDER_UNAVAILABLE_launch: 'create instance: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    DISK_INSUFFICIENT_launch: 'prepare workspace: write /srv/agent-platform/data/workspaces: no space left on device',
  };
  // 失败那一刻树副行写的「哪一步 + 人话」（DR-31）
  const LAUNCH_REASON = { IMAGE_PULL_FAILED: '启动失败：没能把镜像拉下来', TIMEOUT: '超时未响应：这一步等太久，平台先停下了', PROVIDER_UNAVAILABLE: '启动失败：容器服务没有响应', DISK_INSUFFICIENT: '启动失败：磁盘空间不够，代码副本没能准备出来' };
  const AGENT_ID = { Codex: 'codex', 'Claude Code': 'claude-code' };

  // ------------------------------------------------------------------ 任务用的镜像（2026-10-04 用户拍板 Q-LCH-03 B；REQ-LCH-017）
  // 每个任务记下发起那一刻锁定的那一版：t.image = { id, ref, digest, version, builtin }。启动进度卡、结果卡、任务菜单、[复制诊断信息]、
  // [检查镜像地址] 的定位都读它；之后镜像管理里这张镜像怎么更新、切换，这一行都不变（REQ-IMG-025，不拿镜像页现在的当前版本冒充）。
  // 示例世界：face.usedBy 里的任务（补 e2e 用例、跑一遍示例测试）用 ml-agent 当时的卡面那一版，其余用平台预制镜像；「谁在用这一版」从此按任务上记的算（flows-img usedBy）
  const presetImage = () => world.images.find((i) => i.builtin) || null;
  const lockImage = (i) => (i ? { id: i.id, ref: i.ref, digest: i.face.digest, version: i.face.version, builtin: !!i.builtin } : null);
  for (const t of world.tasks) if (!t.image) t.image = lockImage(world.images.find((i) => (i.face.usedBy || []).includes(t.id)) || presetImage());
  const imageLine = (t) => (t.image ? `镜像：${t.image.ref}${t.image.builtin ? '（平台预制镜像）' : ''}` : null);
  P.taskImageLine = imageLine;

  // ------------------------------------------------------------------ 任务「⋯」菜单（树行、总览两张列表、顶栏「更多操作」共用；v1 g2-08 / g2-09 / g2-09b）
  P.taskMenuItems = function taskMenuItems(t, withPull) {
    // 最上面一行只读的「镜像：…」（AC-LCH-017.5：不是菜单项，不可点、不进 Tab 顺序；菜单 aria-describedby 指过来，core openMenu 认 data-menu-desc）。
    // 画法同菜单说明句（12 次要灰，proto.css），但不用 .menu__note——那个类专指「属于某一项、由那一项 describedby 指过来」的说明句
    const img = imageLine(t);
    let html = P.menuLabel(t.name) + (img && t.state !== 'destroying' ? `<p class="proto-menu-image" id="proto-menu-image" data-menu-desc aria-hidden="true">${esc(img)}</p>` : '') + SEP;
    if (t.state === 'destroying') return html + menuItem({ label: '删除中…', disabled: true, reason: '正在删除这个任务' });
    const p = P.proj(t.project);
    if (withPull && p && p.status === 'ready' && p.source !== 'empty') {
      const pulling = !!ui.pulling[p.id];
      html += menuItem({ label: pulling ? '正在拉取…' : '拉取最新代码', icon: 'i-refresh-cw', disabled: pulling, reason: '正在拉取，稍等', act: () => P.pullProject(p) }) + SEP;
    }
    if (t.state === 'preparing' || t.state === 'stuck' || t.state === 'starting') {
      // 准备中不能停；删除入口叫「取消并删除…」（REQ-LCH-014、REQ-SBX-020）
      return html + menuItem({ label: '取消并删除…', icon: 'i-trash-2', danger: true, act: (ret) => openCancelDelete(t, ret) });
    }
    if (t.state === 'running' || t.state === 'idle' || t.state === 'waiting') html += menuItem({ label: '停止', icon: 'i-circle-stop', act: () => stopTask(t) }) + SEP;
    else if (t.state === 'stopped') html += menuItem({ label: '启动', icon: 'i-play', act: () => startTask(t) }) + SEP;
    else if (t.state === 'stopping') {
      const n = P.menuNote('正在停止，停好后才能启动。');
      html += menuItem({ label: '启动', icon: 'i-play', disabled: true, reason: '正在停止，停好后才能启动', describedBy: n.id }) + n.html + SEP;
    }
    const note = t.state !== 'error' ? P.menuNote('销毁前会让你确认代码副本留不留。') : null;
    html += menuItem({ label: '销毁任务…', icon: 'i-trash-2', danger: true, act: (ret) => openDestroy(t, ret), describedBy: note && note.id });
    if (note) html += note.html;
    return html;
  };
  P.menus.task = (trig) => { const t = P.task(trig.dataset.task); return t ? { label: `${t.name} 的任务菜单`, align: 'end', html: P.taskMenuItems(t, false) } : null; };

  // ------------------------------------------------------------------ 主区模板：异常 / 已停止 / 准备中（首次）/ 启动中（从已停止）/ 无头
  P.mainTpl.push((r) => {
    if (r.view !== 'task') return undefined;
    const t = P.task(r.taskId);
    if (!t) return undefined;
    if (t.state === 'error') return 'tpl-task-error';
    if (t.state === 'stopped') return 'tpl-task-stopped';
    if (t.state === 'preparing' || t.state === 'stuck') return 'tpl-task-startup';
    if (t.state === 'starting') return 'tpl-task-restart';
    if (t.headless && (t.state === 'running' || t.state === 'idle' || t.state === 'waiting')) return 'tpl-task-headless';
    return undefined;
  });

  // ================================================================== F-LCH-FORM 新建任务弹层（f-lch-form-01…09、f-lch-startup-02、f-sbx-relaunch-03）
  const deriveName = (P.deriveTaskName = (prompt) => {
    // task-name.policy.ts：第一个非空行 trim 后取前 20 个码点，被截断或后面还有非空行就加「…」
    const lines = String(prompt || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return null;
    const cps = P.cp(lines[0]);
    const cut = cps.slice(0, 20).join('');
    return cps.length > 20 || lines.length > 1 ? `${cut}…` : cut;
  });
  // ================================================================== 「镜像」一栏（2026-10-04 用户拍板 Q-LCH-03 B；REQ-LCH-004；f-lch-form-01…10、f-sbx-relaunch-03）
  // 放在「分支」之后，Git 项目与空项目都有；可选，默认项「平台预制镜像（默认）」= 不指定（平台按这台机器的档取预制镜像）。选项来自镜像管理（world.images，
  // 顺序同镜像页），一张镜像一项写坐标；已禁用的、当前版本验证没通过的置灰不可选、括号里写原因（不藏——同「项目」下拉的「acme-api（克隆失败）」）；
  // 选了某个 Agent 时，没预装它的镜像补「（没有预装 <Agent>，启动会明显变慢）」，选中后字段下一句，不拦（REQ-IMG-003）。
  // 收起时的触发器拷 f-lch-form-10 的 .nt-combo（外观就是 .select__control，与「项目」「分支」两个下拉一样），展开是同一张稿的 .nt-listbox：菜单材质、
  // fixed 定位到触发器下方（稿件用 CSS 锚点，原型用 JS 定位，浏览器支持面更宽）。稿件把它画在遮罩层里、对话框之后（同 Radix Select 的 portal）；原型把它放进
  // 对话框的 DOM（视觉上一样：fixed 不受对话框 overflow 裁切）——aria-modal 对话框之外的内容读屏可能够不着，axe 也会按「内容不在地标里」（region）报它。
  // 键盘照 APG 的 select-only combobox：↓ / ↑ / Enter / 空格打开（停在当前选中的那一项），↑ ↓ Home End 移动（置灰项也停得上、念得出原因，但选不中），
  // Enter / 空格选中并收起，Esc 只收起列表（不关弹层），Tab 收起、不改选；指针打开不预选任何一项（同菜单，PF-04），悬停高亮
  const IMG_DEFAULT = '';
  function imageOptions(agentId) {
    const pre = presetImage();
    const preOff = !!(pre && !pre.active);
    const opts = [{ value: IMG_DEFAULT, label: preOff ? '平台预制镜像（已禁用）' : '平台预制镜像（默认）', description: pre ? `${pre.alias ? pre.alias + ' · ' : ''}${pre.ref}` : '', fixed: true, disabled: preOff, reason: preOff ? '已禁用' : null, image: pre }];
    for (const i of (P.imagesOrdered ? P.imagesOrdered() : world.images)) {
      if (i.builtin) continue;
      const why = !i.active ? '已禁用' : i.face.status === 'invalid' ? '无效：不符合平台约定' : null;
      const lacks = !why && !!agentId && !String(i.face.runtimes || '').split('、').includes(agentId);
      opts.push({ value: i.id, label: i.alias || i.ref, description: i.alias ? i.ref : '', search: `${i.alias || ''} ${i.ref} ${i.face.version || ''}`, warning: lacks ? `没有预装 ${agentId}，启动会明显变慢` : null, disabled: !!why, reason: why, lacks, image: i });
    }
    return opts;
  }
  let openCombo = null; // 同一时刻最多一个展开的「镜像」列表
  P.hook('escape', () => { if (!openCombo) return undefined; openCombo.close(true); return true; }); // Esc 只收起列表，不关新建任务弹层（不管时答 undefined：P.ask 认第一个非空的答案）
  P.hook('pointerdown', (e) => { if (openCombo && !openCombo.owns(e.target)) openCombo.close(false); });
  P.hook('resize', () => { if (openCombo) openCombo.place(); }); // 视口变了：列表跟着触发器重新定位（同稿件的 CSS 锚点），不收起
  P.hook('scroll', () => { if (openCombo) openCombo.place(); }); // 对话框正文滚动：列表跟着触发器走
  function baselineImageCombo(field, onPick) {
    const btn = $('.nt-combo', field);
    const valueEl = $('#nt-image-value', field);
    btn.setAttribute('aria-expanded', 'false'); btn.removeAttribute('aria-controls'); // 稿件 10 画的是展开那一刻
    btn.dataset.nt = 'image'; btn.dataset.fk = 'nt-image';
    let opts = [], value = IMG_DEFAULT, list = null, active = -1, how = 'key';
    const selIdx = () => Math.max(0, opts.findIndex((o) => o.value === value));
    const paintValue = () => { const o = opts.find((x) => x.value === value) || opts[0]; if (o && valueEl.textContent !== o.label) valueEl.textContent = o.label; };
    function mark() {
      if (!list) return;
      for (const el of $$('[role="option"]', list)) {
        const on = Number(el.dataset.k) === active;
        el.classList.toggle('is-focus', on && how === 'key'); // 键盘 = 悬停底 + 内嵌蓝环（T-29）；指针 = 只铺悬停底
        el.classList.toggle('is-hover', on && how === 'pointer');
        if (on && how === 'key' && list.scrollHeight > list.clientHeight) el.scrollIntoView({ block: 'nearest' });
      }
      if (active >= 0) btn.setAttribute('aria-activedescendant', `nt-img-opt-${active}`); else btn.removeAttribute('aria-activedescendant');
    }
    function paintList() {
      if (!list) return;
      const anyOff = opts.some((o) => o.disabled);
      list.innerHTML = opts.map((o, k) => `<div class="menu__item" role="option" id="nt-img-opt-${k}" aria-selected="${o.value === value}"${o.disabled ? ' aria-disabled="true"' : ''} data-k="${k}"><span>${esc(o.label)}</span></div>`).join('')
        + (anyOff ? '<p class="menu__note" id="nt-image-list-note" aria-hidden="true">置灰的镜像不能选：到「镜像管理」里处理好再回来。</p>' : '');
      if (anyOff) list.setAttribute('aria-describedby', 'nt-image-list-note'); else list.removeAttribute('aria-describedby');
      mark();
    }
    function place() {
      if (!list) return;
      if (!btn.isConnected) { close(false); return; }
      const r = btn.getBoundingClientRect();
      const top = r.bottom + 4; // 贴在触发器下方 4px、宽同触发器（l2a-lch §7 的锚点定位）；不取整——对话框常落在半像素上（y = 80.5）
      Object.assign(list.style, { top: `${top}px`, left: `${r.left}px`, width: `${r.width}px`, maxHeight: '', overflowY: '' });
      // 只在视口下方放不下时才让列表自己滚（镜像注册得多了）；平时不设 overflow——滚动容器里的字在 Chromium 里换成灰阶抗锯齿，和稿件不一样
      const room = Math.floor(window.innerHeight - top - 8);
      if (list.scrollHeight > room) Object.assign(list.style, { maxHeight: `${Math.max(120, room)}px`, overflowY: 'auto' });
    }
    function open(start, viaPointer) {
      if (list || btn.disabled) return;
      const dlg = btn.closest('.dialog'); if (!dlg || !dlg.parentElement) return;
      if (openCombo && openCombo !== C) openCombo.close(false);
      list = P.fromTpl('tpl-nt-image-list');
      list.removeAttribute('aria-describedby');
      how = viaPointer ? 'pointer' : 'key';
      active = viaPointer ? -1 : start;
      paintList();
      dlg.appendChild(list); // 放在对话框 DOM 末尾（见上）；fixed 定位，视觉上贴在触发器下方
      btn.setAttribute('aria-expanded', 'true'); btn.setAttribute('aria-controls', list.id);
      place();
      // 对话框刚打开、出场动画（v2-pop：从 .96 缩放到 1）还没走完就展开时，量到的是缩放中的触发器——动画走完、下一帧再各量一次
      for (const a of dlg.getAnimations()) a.finished.then(() => place(), () => {});
      requestAnimationFrame(() => place());
      openCombo = C;
      list.addEventListener('mousedown', (e) => e.preventDefault()); // 焦点留在触发器上
      list.addEventListener('pointermove', (e) => {
        const o = e.target.closest('[role="option"]'); if (!o || o.getAttribute('aria-disabled') === 'true') return;
        const k = Number(o.dataset.k); if (k !== active || how !== 'pointer') { active = k; how = 'pointer'; mark(); }
      });
      list.addEventListener('click', (e) => { const o = e.target.closest('[role="option"]'); if (o) pick(Number(o.dataset.k)); });
    }
    function close(focusBack) {
      if (!list) return;
      list.remove(); list = null; active = -1;
      if (openCombo === C) openCombo = null;
      btn.setAttribute('aria-expanded', 'false'); btn.removeAttribute('aria-controls'); btn.removeAttribute('aria-activedescendant');
      if (focusBack && btn.isConnected) btn.focus({ preventScroll: true });
    }
    function pick(k) {
      const o = opts[k]; if (!o || o.disabled) return; // 置灰项选不中（原因写在括号里，列表底那一句说去哪儿处理）
      const changed = o.value !== value;
      value = o.value; paintValue(); close(true);
      if (changed) onPick(o);
    }
    btn.addEventListener('click', (e) => { if (btn.disabled) return; if (list) close(true); else open(selIdx(), e.detail > 0); });
    btn.addEventListener('keydown', (e) => {
      if (btn.disabled) return;
      const k = e.key;
      if (!list) {
        if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); open(selIdx(), false); }
        else if (k === 'Home') { e.preventDefault(); open(0, false); }
        else if (k === 'End') { e.preventDefault(); open(opts.length - 1, false); }
        return; // Enter / 空格：按钮自己的 click 打开（键盘触发的 click detail = 0，停在当前选中的那一项）
      }
      const to = (n) => { e.preventDefault(); active = Math.max(0, Math.min(opts.length - 1, n)); how = 'key'; mark(); };
      if (k === 'ArrowDown') to(active < 0 ? 0 : active + 1);
      else if (k === 'ArrowUp' && e.altKey) { e.preventDefault(); if (active >= 0) pick(active); else close(true); }
      else if (k === 'ArrowUp') to(active < 0 ? opts.length - 1 : active - 1);
      else if (k === 'Home') to(0);
      else if (k === 'End') to(opts.length - 1);
      else if (k === 'Enter' || k === ' ') { e.preventDefault(); if (active >= 0) pick(active); else close(true); }
      else if (k === 'Tab') close(false); // 收起、不改选，焦点照常移走
    });
    const C = {
      btn,
      get value() { return value; },
      option: () => opts.find((o) => o.value === value) || null,
      set(v) { value = v; paintValue(); paintList(); },
      setOptions(o) { opts = o; if (!opts.some((x) => x.value === value)) value = IMG_DEFAULT; paintValue(); paintList(); },
      disable(on) { if (on) close(false); btn.disabled = on; },
      open, close, place,
      owns: (el) => !!(el && (btn.contains(el) || (list && list.contains(el)))),
      isOpen: () => !!list,
    };
    return C;
  }

  function imageCombo(field, onPick) {
    if (!P.searchSelect) return baselineImageCombo(field, onPick);
    const btn = $('.nt-combo', field);
    btn.dataset.nt = 'image'; btn.dataset.fk = 'nt-image';
    return P.searchSelect({ btn, valueEl: $('#nt-image-value', field), key: 'nt-image', kind: '镜像别名、坐标或 tag', onPick });
  }

  const MAX = 8000;
  P.openNewTask = function openNewTask(projectId, returnTo, opts) {
    opts = opts || {};
    const ready = (id) => P.isReady(P.proj(id));
    const cur = P.currentProjectId();
    // 默认项目：打开时所在的项目；从总览 / ⌘K 打开且没有当前项目时 = 左侧树里第一个就绪项目（Q-LCH-05 A）
    const pid = projectId && ready(projectId) ? projectId : cur && ready(cur) ? cur : P.treeOrder().find(ready);
    if (!pid) { if (returnTo) P.hint(returnTo, P.newTaskBlocked(P.proj(projectId || cur)) || '先新建一个项目'); return null; }
    const box = P.fromTpl('tpl-new-task');
    box.dataset.dialog = 'new-task';
    const q = (sel) => $(sel, box);
    const projSel = q('select[aria-label="项目"]'); projSel.dataset.nt = 'project'; projSel.dataset.fk = 'nt-project';
    const fieldset = q('.nt-agents'); fieldset.dataset.nt = 'agents';
    const note = q('#nt-agent-note'); note.dataset.nt = 'agent-note'; note.setAttribute('aria-live', 'polite');
    let branchSel = q('select[aria-label="分支（可选）"]'); branchSel.dataset.nt = 'branch'; branchSel.dataset.fk = 'nt-branch';
    const prompt = q('#nt-prompt'); prompt.dataset.nt = 'prompt'; prompt.dataset.fk = 'nt-prompt'; prompt.value = '';
    const count = q('#nt-count'); count.dataset.nt = 'count';
    const meta = q('.nt-meta');
    q('.dialog__subtitle').dataset.nt = 'sub';
    q('.nt-lead').dataset.nt = 'lead';
    const cancel = q('.dialog__footer > .btn'); cancel.dataset.dlg = 'cancel'; cancel.dataset.fk = 'nt-cancel';
    const submit = q('.dialog__footer .btn--primary'); submit.dataset.dlg = 'submit'; submit.dataset.fk = 'nt-submit';
    q('.dialog__close').dataset.dlg = 'cancel';
    for (const r of $$('input[name="nt-agent"]', box)) { r.checked = false; r.dataset.fk = `nt-agent-${r.value}`; }
    // 项目下拉：顺序同左侧树（当前项目置顶）；克隆中 / 克隆失败不可选并写原因（REQ-LCH-001 / REQ-PRJ-016）
    projSel.innerHTML = P.treeOrder().map((id) => { const p = P.proj(id); return `<option value="${p.id}"${p.status === 'ready' ? '' : ' disabled'}>${esc(p.name)}${p.status === 'failed' ? '（克隆失败）' : p.status === 'cloning' ? '（克隆中）' : ''}</option>`; }).join('');
    projSel.value = pid;
    // 「镜像」一栏（2026-10-04 用户拍板 Q-LCH-03 B）：稿件 01 的原生下拉换成 f-lch-form-10 的触发器（外观一样，展开是同稿的选项列表）；
    // 列表读不到（场景「镜像列表：读不到」）→ f-lch-form-05 那一格：只剩默认项 + 一句（role=status），照常可发起——与分支读不到同一处理（AC-LCH-004.7）
    const imgNative = q('select[aria-label="镜像（可选）"]').closest('.field');
    let imgField, combo = null;
    if (P.scenario.is('nt-images', 'fail')) {
      imgField = P.fromTpl('tpl-nt-image-fail', { keepRoles: true });
      const s0 = $('select', imgField); s0.dataset.nt = 'image'; s0.dataset.fk = 'nt-image';
    } else {
      imgField = P.fromTpl('tpl-nt-image');
      combo = imageCombo(imgField, () => { clearSyncNote(); sync(); });
      combo.setOptions(imageOptions(null));
    }
    imgField.dataset.nt = 'image-field';
    imgNative.replaceWith(imgField);
    const paintImageHelp = (text) => {
      if (!combo) return;
      let h = $('#nt-image-note', imgField);
      if (!text) { if (h) h.remove(); combo.btn.removeAttribute('aria-describedby'); return; }
      if (!h) { h = document.createElement('p'); h.className = 'field__help'; h.id = 'nt-image-note'; h.setAttribute('role', 'status'); imgField.appendChild(h); }
      if (h.textContent !== text) h.textContent = text;
      combo.btn.setAttribute('aria-describedby', 'nt-image-note');
    };
    // 重新发起（F-SBX-RELAUNCH 03）：顶部来源说明、分支与指令各一句「没带过来」；预选原任务的 Agent（不悄悄改选别的）与镜像
    const from = opts.relaunchFrom;
    if (from) {
      const rn = P.fromTpl('tpl-nt-relaunch-note');
      rn.id = 'nt-relaunch';
      $('.note__title', rn).textContent = `从失败的任务「${from.name}」重新发起`;
      q('.dialog__body').insertBefore(rn, q('.nt-lead'));
      box.setAttribute('aria-describedby', 'nt-sub nt-relaunch');
      const bf = P.fromTpl('tpl-nt-relaunch-branch');
      const cn = $('.contract-note', bf); if (cn) cn.remove(); // 稿注「待后端 · 回显分支」只是看稿标注，不进原型
      branchSel.closest('.field').replaceWith(bf);
      branchSel = $('select', bf); branchSel.dataset.nt = 'branch'; branchSel.dataset.fk = 'nt-branch';
      const help = document.createElement('p'); help.className = 'field__help'; help.id = 'nt-prompt-note'; help.textContent = '原来的任务指令没有带过来（平台不回显提交过的指令），需要的话重新填写。';
      meta.insertBefore(help, count);
      prompt.setAttribute('aria-describedby', 'nt-prompt-note nt-count');
      const want = $(`input[name="nt-agent"][value="${AGENT_ID[from.agent] || 'codex'}"]`, box); if (want) want.checked = true;
      // 镜像预选原任务用的那一张（Q-LCH-03 B；AC-SBX-003.1 / 003.5）：预选的是这张镜像、不是它锁定的那一版（发起时用它那一刻的当前版本）；
      // 它现在已禁用 / 验证没通过也照样预选（置灰写原因 + 字段下一句 + 主按钮不可发起），不悄悄换成平台预制镜像
      if (combo && from.image && !from.image.builtin && P.image && P.image(from.image.id)) combo.set(from.image.id);
    } else if (opts.deepLink) {
      // 深链刷新后（REQ-LCH-009；f-lch-form-09）：指令框为空，框下一句（role=status）；站内打开不出这句
      const help = document.createElement('p'); help.className = 'field__help'; help.id = 'nt-prompt-note'; help.setAttribute('role', 'status'); help.textContent = '刷新后指令未保留，请重新输入';
      meta.insertBefore(help, count);
      prompt.setAttribute('aria-describedby', 'nt-prompt-note nt-count');
    }
    const nativeSearch = P.searchNativeSelect || ((select) => ({ close() {}, refresh() {}, disable(on) { select.disabled = on; } }));
    const projectSearch = nativeSearch(projSel, { key: 'nt-project', kind: '项目名称', option(o) { const p = P.proj(o.value); return { label: p.name, search: p.name, reason: p.status === 'failed' ? '克隆失败，请到项目页重试' : p.status === 'cloning' ? '克隆中，准备好后才能发起任务' : null }; } });
    const branchSearch = nativeSearch(branchSel, { key: 'nt-branch', kind: '分支', fixedDefault: true });
    const m = P.openModal(box, { kind: 'new-task', returnTo, initialFocus: '[data-nt="project"]', onClose() { projectSearch.close(false); branchSearch.close(false); if (combo) combo.close(false); } });
    const st = { load: P.scenario.get('nt-load'), agentsLoading: false, envLoading: false, agentsFail: false, envFail: false, over: false, busy: false, stash: null, relaunchImage: from && from.image && !from.image.builtin ? from.image.id : null };
    const agentsKids = $$(':scope > :not(legend)', fieldset); // 两个单选 + 说明句（加载中 / 失败时拿下来，好了再放回去）
    const agentId = () => ($('input[name="nt-agent"]:checked', box) || {}).value;
    const setAgents = (mode) => {
      for (const el of $$(':scope > :not(legend)', fieldset)) el.remove();
      if (mode === 'ok') agentsKids.forEach((el) => fieldset.appendChild(el));
      else if (mode === 'loading') fieldset.appendChild(P.fromTpl('tpl-nt-skel-agents', { keepRoles: true }));
      else { const f = P.fromTpl('tpl-nt-fail-agents', { keepRoles: true }); const b = $('.note__end .btn', f); b.dataset.nt = 'retry-agents'; b.dataset.fk = 'nt-retry-agents'; fieldset.appendChild(f); }
    };
    const setEnv = (mode) => {
      const old = q('[data-nt="env"]'); if (old) old.remove();
      if (mode === 'ok') return;
      const el = mode === 'loading' ? P.fromTpl('tpl-nt-skel-env', { keepRoles: true }) : P.fromTpl('tpl-nt-fail-env', { keepRoles: true });
      el.dataset.nt = 'env';
      if (mode === 'fail') { const b = $('.note__end .btn', el); b.dataset.nt = 'retry-env'; b.dataset.fk = 'nt-retry-env'; }
      fieldset.after(el);
    };
    let branchReal = branchSel.closest('.field');
    const setBranchLoading = (on) => {
      if (on) { const sk = P.fromTpl('tpl-nt-skel-branch', { keepRoles: true }); sk.dataset.nt = 'branch-skel'; branchReal.replaceWith(sk); }
      else { const sk = q('[data-nt="branch-skel"]'); if (sk) sk.replaceWith(branchReal); }
    };
    const fillBranches = (keep) => {
      const p = P.proj(projSel.value);
      const k = keep ? branchSel.value : '';
      branchSel.innerHTML = `<option value="">跟随项目当前的分支（默认）</option>${(p.branches || []).map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join('')}`;
      if (k && (p.branches || []).includes(k)) branchSel.value = k;
      branchReal.hidden = p.source === 'empty'; branchSel.disabled = p.source === 'empty';
      branchSearch.close(false); branchSearch.refresh();
    };
    const setImageLoading = (on) => {
      // 镜像一格骨架（f-lch-form-04：「正在加载可选镜像」，不拦发起——默认项照常能发）
      if (on) { const sk = P.fromTpl('tpl-nt-image-skel', { keepRoles: true }); sk.dataset.nt = 'image-skel'; imgField.replaceWith(sk); }
      else { const sk = q('[data-nt="image-skel"]'); if (sk) sk.replaceWith(imgField); }
    };
    const clearSyncNote = () => { const n = q('[data-nt="sync"]'); if (n) n.remove(); };
    // 06 / 07 / 08 的结果句（role=alert）在字段栈之后：「镜像」一栏加进来后它会落到正文可视区以下，出现时滚进视野（正文滚动后头部底边出分隔，core 统一挂 .is-scrolled）
    const revealNote = (n) => { if (n && n.isConnected) n.scrollIntoView({ block: 'nearest' }); };
    function sync() {
      const p = P.proj(projSel.value);
      q('[data-nt="sub"]').textContent = `在「${p.name}」中发起`;
      q('[data-nt="lead"]').innerHTML = `在「${esc(p.name)}」中发起一个任务，让 Agent 去跑；填了任务指令，Agent <strong>启动时就开始执行</strong>，不必等你打开终端`;
      const a = agentId();
      const rt = a && P.runtime(a);
      const gate = !!(rt && (rt.cred === 'none' || rt.cred === 'expired'));
      // 凭证面板展开着（或「已连上」停留中）时，Agent 一组的说明位由 flows-crd.js 接管（F-AUTH-PANEL；返回 { open: true }）
      const panel = rt ? P.ask('newTask.agent', { box, note, rt, gate }) : null;
      if (!a) note.textContent = '请选择一个 Agent —— 平台没有默认 Agent，必须你来指定';
      else if (panel) { /* 面板接管 */ }
      else if (!gate) note.textContent = `将以 ${rt.identity} 身份运行${rt.cred === 'expiring' ? '（凭证即将到期，建议尽快重新授权）' : ''}`;
      else note.innerHTML = `<span class="nt-gate"><span>${esc(rt.name)} ${rt.cred === 'expired' ? '的凭证已过期，重新授权后才能发起任务。' : '还没有配置凭证，配置好才能发起任务。'}</span><button class="btn btn--secondary btn--24" type="button" aria-expanded="false" data-action="auth-gate" data-nt="gate" data-fk="nt-gate">${rt.cred === 'expired' ? '重新授权' : '配置凭证'}</button></span>`;
      // 「镜像」（Q-LCH-03 B）：选项按镜像管理此刻的样子与所选 Agent 现算（没预装的后缀跟着 Agent 变）；字段下那一句与 [发起] 的原因（AC-LCH-004.4 / 004.8、AC-SBX-003.5）
      let imgBlock = null;
      if (combo) {
        combo.setOptions(imageOptions(a || null));
        const o = combo.option();
        let help = null;
        if (o && o.disabled) {
          help = o.value === IMG_DEFAULT ? '平台预制镜像已禁用，新任务用不了它：改选一张镜像，或到「镜像管理」重新启用它。'
            : `${o.value === st.relaunchImage ? '原任务用的镜像' : '选中的镜像'}「${o.image.ref}」现在不能用（${o.reason}）：改选一张，或到「镜像管理」重新启用它。`;
          imgBlock = help;
        } else if (o && o.lacks) help = `这张镜像没有预装 ${a}，启动会明显变慢。`;
        paintImageHelp(help);
      }
      // 闸门在场时弹层底部一句（REQ-LCH-003）；开不了终端时那条琥珀提示占着 nt-block，闸门句不再重复
      let block = q('[data-nt="block"]');
      const notty = st.load === 'notty';
      const off = P.ask('newTask.blocked', p); // 第四段（REQ-WB-014）：离线时 [发起] 也置灰，弹层底部同一位置说原因（排在凭证闸门之前）
      const blockText = off || (gate && !notty ? `先完成上面的 ${rt.name} 登录，才能发起任务。` : null);
      if (blockText) {
        if (!block) { block = document.createElement('p'); block.className = 'tone-warn'; block.id = 'nt-block'; block.dataset.nt = 'block'; q('.fields').after(block); }
        if (block.textContent !== blockText) block.textContent = blockText;
      } else if (block) block.remove();
      // 指令计数（按码点、按提交的内容计，Q-LCH-01 A；AC-LCH-005.3）：只在跨过上限时切换字段错误写法，避免读屏连播
      const n = P.cp(prompt.value.trim()).length;
      const over = n > MAX;
      if (over !== st.over) {
        st.over = over;
        prompt.classList.toggle('is-invalid', over);
        if (over) { prompt.setAttribute('aria-invalid', 'true'); count.className = 'nt-counter nt-counter--error'; count.setAttribute('role', 'alert'); }
        else { prompt.removeAttribute('aria-invalid'); count.className = 'nt-counter'; count.removeAttribute('role'); }
      }
      count.innerHTML = over ? `<span class="icon i-circle-alert" aria-hidden="true"></span>${n}/${MAX} —— 已超出上限，请精简后再发起` : `${n}/${MAX}`;
      // 不可发起：能聚焦、能说原因的禁用（aria-disabled + aria-describedby + data-reason；DR-39、原型评审 F3）
      let reason = null, desc = 'nt-agent-note';
      if (off) { reason = off; desc = 'nt-block'; }
      else if (st.agentsLoading || st.envLoading) reason = '正在加载可选 Agent 与这台机器的沙箱环境，稍等';
      else if (st.agentsFail || st.envFail) reason = st.agentsFail ? 'Agent 列表没读出来，先点「重试加载 Agent」' : '没能确认这台机器的沙箱环境，先点「重试」';
      else if (notty) { reason = '这台机器的沙箱环境开不了终端'; desc = 'nt-block'; }
      else if (!a) reason = '请选择一个 Agent —— 平台没有默认 Agent，必须你来指定';
      else if (gate) { reason = `先完成上面的 ${rt.name} 登录，才能发起任务。`; desc = panel ? 'nt-block' : 'nt-agent-note nt-block'; }
      else if (imgBlock) { reason = imgBlock; desc = 'nt-image-note'; } // 不等点了发起才被门口拒（AC-LCH-004.8）
      else if (over) { reason = '指令超出上限，请精简后再发起'; desc = 'nt-count'; }
      if (st.busy) { /* 第五段（R1-03）：创建中由 setBusy 管（aria-disabled + aria-busy），这里不动它 */ }
      else if (reason) { submit.setAttribute('aria-disabled', 'true'); submit.dataset.reason = reason; }
      else { submit.removeAttribute('aria-disabled'); delete submit.dataset.reason; }
      submit.setAttribute('aria-describedby', desc);
    }
    fillBranches(false);
    // 打开时的场景（REQ-LCH-006 / 008）：加载中、加载失败、开不了终端
    if (st.load === 'loading') {
      st.agentsLoading = st.envLoading = true; setAgents('loading'); setEnv('loading'); setBranchLoading(true); setImageLoading(true);
      P.clock.after(T.formLoad, () => { if (!box.isConnected) return; st.agentsLoading = st.envLoading = false; setAgents('ok'); setEnv('ok'); setBranchLoading(false); setImageLoading(false); sync(); P.announce('Agent 列表已加载'); });
    } else if (st.load === 'fail') {
      st.agentsFail = st.envFail = true; setAgents('fail'); setEnv('fail');
    } else if (st.load === 'notty') {
      const nt = P.fromTpl('tpl-nt-notty', { keepRoles: true }); nt.dataset.nt = 'notty';
      q('.fields').after(nt);
      revealNote(nt);
    }
    sync();
    box.addEventListener('nt:sync', () => sync()); // 凭证面板（flows-crd.js）状态变了：重算闸门、身份句与 [发起] 可用性
    box.addEventListener('change', (e) => {
      if (st.busy) return;
      if (e.target === projSel) { fillBranches(false); clearSyncNote(); sync(); } // 改选项目：Agent 与指令保留，分支回到默认（Q-LCH-05 A）
      else if (e.target.matches('input[name="nt-agent"]')) { clearSyncNote(); sync(); }
      else if (e.target === branchSel || e.target.matches('[data-nt="branch"]')) { clearSyncNote(); }
    });
    prompt.addEventListener('input', () => { clearSyncNote(); sync(); });
    box.addEventListener('click', (e) => {
      const r = e.target.closest('[data-nt="retry-agents"], [data-nt="retry-env"]');
      if (r) {
        const which = r.dataset.nt === 'retry-agents' ? 'agents' : 'env';
        // 第五段（R1-03）：重试中就地把这颗按钮换成「重试中…」（aria-busy，焦点留在它上面），不先拆掉失败条——拆掉会把焦点甩到 body
        P.setBusy(r, true, P.busyHtml('重试中…'));
        if (which === 'agents') { st.agentsFail = false; st.agentsLoading = true; }
        else { st.envFail = false; st.envLoading = true; }
        sync();
        P.clock.after(T.formRetry, () => {
          if (!box.isConnected) return;
          const hadFocus = box.contains(document.activeElement) && document.activeElement.closest('[data-nt="retry-agents"], [data-nt="retry-env"]');
          if (which === 'agents') { st.agentsLoading = false; setAgents('ok'); const f = $('input[name="nt-agent"]', box); if (f) f.focus(); }
          else { st.envLoading = false; setEnv('ok'); if (hadFocus || !box.contains(document.activeElement)) { const f = $('input[name="nt-agent"]:checked', box) || $('input[name="nt-agent"]', box) || submit; f.focus(); } }
          sync();
        });
        return;
      }
      const b = e.target.closest('[data-dlg]'); if (!b || st.busy) return;
      if (b.dataset.dlg === 'cancel') { P.closeModal(m); return; }
      if (b.dataset.dlg === 'submit' && b.getAttribute('aria-disabled') !== 'true') submitTask();
    });
    function setBusy(on) {
      st.busy = on; m.busy = on;
      if (on) box.setAttribute('aria-busy', 'true'); else box.removeAttribute('aria-busy');
      // 第五段（R1-03）：[发起任务并打开终端] 创建中用 aria-disabled + aria-busy（P.setBusy），焦点留在它上面；在字段里提交的，焦点先交给它再禁用字段
      if (on && box.contains(document.activeElement) && document.activeElement !== submit) submit.focus({ preventScroll: true });
      projSel.disabled = on; branchSel.disabled = on || P.proj(projSel.value).source === 'empty'; fieldset.disabled = on; prompt.disabled = on;
      projectSearch.disable(on); branchSearch.disable(branchSel.disabled);
      if (combo) combo.disable(on); else { const s1 = $('select', imgField); if (s1) s1.disabled = on; } // 镜像随「创建中」一起禁用（f-lch-startup-02）
      for (const b of $$('[data-dlg="cancel"]', box)) b.disabled = on;
      P.setBusy(submit, on, on ? P.busyHtml('创建中…') : '发起任务并打开终端');
    }
    function submitTask() {
      // 创建中（REQ-LCH-010；f-lch-startup-02）：字段、取消、关闭全部禁用，Esc / 点遮罩都不关；指令在提交这一刻从框里取走
      clearSyncNote();
      st.stash = prompt.value;
      prompt.value = '';
      setBusy(true);
      sync();
      P.announce('创建中…');
      const pid2 = projSel.value, branch = branchSel.value, agent = agentId();
      const pickImg = combo ? combo.option() : null;
      P.clock.after(T.create, () => {
        const scen = P.scenario.take('launch');
        if (scen === 'resource' || scen === 'gate' || scen === 'image-gone') {
          // 同步失败留在弹层，就地一条提示，指令放回（DR-02 A；REQ-LCH-007；f-lch-form-06 / 07）
          // image-gone（2026-10-04，AC-LCH-004.9）：所选镜像在提交前刚被别处禁用——同 07 的琥珀路径、不给重试；这张镜像随之标成已禁用，弹层里它跟着置灰写原因
          if (scen === 'image-gone') { const gone = (pickImg && pickImg.image) || presetImage(); if (gone) gone.active = false; }
          setBusy(false);
          prompt.value = st.stash;
          const n = P.fromTpl(scen === 'resource' ? 'tpl-nt-resource' : 'tpl-nt-gate', { keepRoles: true });
          if (scen === 'image-gone') $('.note__text', n).textContent = '无法用当前配置创建：这张镜像现在不能被新任务选用（刚被禁用、验证没通过或已删除）。请改选一张镜像后再试（本次请求未创建任何任务）。';
          n.dataset.nt = 'sync';
          q('.dialog__body').appendChild(n);
          sync();
          submit.focus();
          revealNote(n);
          return;
        }
        P.closeModal(m, { restoreFocus: false });
        // 镜像：默认项 = 平台预制镜像；受理这一刻按它的当前版本锁定（REQ-IMG-025），任务上记下的就是这一版
        const image = lockImage(pickImg && pickImg.value !== IMG_DEFAULT ? pickImg.image : presetImage());
        launchTask({ pid: pid2, agent, branch, prompt: st.stash, scen, image });
      });
    }
    return m;
  };
  P.actions['new-task'] = (a) => P.openNewTask(a.dataset.project || P.currentProjectId(), a);

  // ================================================================== F-LCH-STARTUP 发起后的启动流程（f-lch-startup-01…06）
  const ORDER = ['pending', 'preparing-workspace', 'creating', 'starting']; // 状态机顺序（时钟按它推进；格按展示序判，Q-LCH-02 默认 C）
  function launchTask({ pid, agent, branch, prompt, scen, image }) {
    const rt = P.runtime(agent) || P.runtime('codex');
    const now = P.clock.now();
    const name = deriveName(prompt) || `${rt.name} · ${P.fmtHM(P.clock.wall())}`;
    const t = { id: P.newId('n'), project: pid, name, agent: rt.name, state: 'preparing', status: 'pending', since: now, observed: true, scen, imageStaged: scen === 'first-image' ? false : true, prompt: prompt || '', branch: branch || null, image: image || lockImage(presetImage()), active: '刚刚', age: 0, touched: now };
    world.tasks.unshift(t); // 新任务插在组首（tasksOf 按数组顺序）
    ui.expanded[pid] = true;
    P.announce(`已受理：正在启动「${name}」`);
    P.go(`task-${t.id}`);
    P.clock.wake();
    return t;
  }
  P.launchTask = launchTask;
  function failLaunch(t, code) {
    t.state = 'error';
    t.code = code;
    t.failedAt = 'launch';
    t.reason = LAUNCH_REASON[code] || '启动失败：操作没有完成';
    t.detail = DETAIL[`${code}_launch`] || DETAIL[code];
    t.age = null;
    delete t.status;
    P.announce(`「${t.name}」${t.reason}`);
    P.dirty();
  }
  function welcomeHtml(t, extraLine) {
    let html = P.termTemplate('term-new-codex');
    const tail = '<span class="ansi-cyan">›</span> <span class="term__cursor"> </span>';
    if (extraLine) html = html.replace(tail, `${extraLine}\n\n${tail}`);
    else if (t.prompt) {
      const first = (t.prompt.split(/\r?\n/).find((s) => s.trim()) || '').trim();
      html = html.replace(tail, `<span class="ansi-cyan">›</span> ${esc(first)}\n\n<span class="ansi-dim">• Working (esc to interrupt)</span> <span class="term__cursor"> </span>`);
    }
    return html;
  }
  function becomeRunning(t, extraLine) {
    const now = P.clock.now();
    Object.assign(t, { state: 'running', term: 'term-new-codex', termHtml: welcomeHtml(t, extraLine), extraTabs: [], active: '刚刚', age: 0, touched: now });
    delete t.status; delete t.restart;
    delete ui.tabs[t.id];
    P.announce(`「${t.name}」已运行，终端已连上`);
    P.dirty();
  }
  P.clock.ticker({
    bg: true, // 第四段（F-WB-LIVE）：/events 断开时启动四段停在最后已知状态，恢复时补拍（P.clock.hold）
    active: () => world.tasks.some((t) => (t.state === 'preparing' || t.state === 'stuck') && !t.restart),
    tick(now) {
      for (const t of world.tasks.slice()) {
        if ((t.state !== 'preparing' && t.state !== 'stuck') || t.restart) continue;
        const el = now - t.since;
        if (t.status === 'creating' && t.scen === 'pull-fail' && el >= T.pullFailAt) { failLaunch(t, 'IMAGE_PULL_FAILED'); continue; }
        if (t.status === 'creating' && t.scen === 'timeout' && el >= T.timeoutAt) { failLaunch(t, 'TIMEOUT'); continue; }
        // 环境类错误（Q-SYS-01② A）：拉取镜像那一格容器服务没有响应 / 准备代码副本那一格磁盘写满
        if (t.status === 'creating' && t.scen === 'provider' && el >= T.envFailAt) { failLaunch(t, 'PROVIDER_UNAVAILABLE'); continue; }
        if (t.status === 'preparing-workspace' && t.scen === 'disk' && el >= T.envFailAt) { failLaunch(t, 'DISK_INSUFFICIENT'); continue; }
        if (t.status === 'creating' && t.scen === 'stuck') {
          // 可能卡住：同一阶段超过阈值没有新进展（原型 15 秒；产品口径 PARAM.STUCK_HINT_S 暂行 300 秒，画面不写阈值）；装命令行工具期间不判
          if (t.state === 'preparing' && !t.installing && el >= T.stuck) { t.state = 'stuck'; P.announce(`「${t.name}」可能卡住了`); P.dirty(); }
          continue;
        }
        const dur = t.status === 'starting' && t.imageStaged === false ? T.startingFirstImage : T.phase[t.status];
        if (el >= dur) {
          const i = ORDER.indexOf(t.status);
          if (i === ORDER.length - 1) { becomeRunning(t); continue; }
          t.status = ORDER[i + 1];
          t.since = now;
          if (t.status === 'starting') P.emit('task:inject', t); // 第 ④ 步：注入凭证并记账（删除凭证的清单按这份记录算，flows-crd.js）
          P.dirty();
        }
      }
    },
  });
  // 准备中的主区：启动进度卡（f-lch-startup-03 / 04 / 05）。结构变了才重画（状态、阶段、卡住、镜像在不在本机），已等待由 data-live-since 每秒就地写
  const PHASE_NOTE = {
    // 卡住时的阶段说明：拉取镜像有定稿（v1 g2-03）；其余三格补文案之前用通用句（Q-LCH-06 默认 B）
    creating: '拉取镜像通常会持续推进；这么久没有任何进展，多半是网络或镜像下载源的问题。',
    generic: '这一步通常会持续推进；这么久没有任何进展，可能出了问题。',
  };
  function phasesHtml(t, reused) {
    const cur = P.PHASE_OF[t.status] != null ? P.PHASE_OF[t.status] : 3;
    const pct = P.PHASE_PCT[t.status] || 80;
    const items = P.PHASES.map((label, i) => {
      const state = reused && i < 3 ? 'reused' : i < cur ? 'done' : i === cur ? 'active' : 'pending';
      const icon = state === 'done' || state === 'reused' ? 'icon phases__icon i-check' : state === 'active' ? 'icon icon--14 phases__icon i-circle-filled' : 'icon icon--14 phases__icon i-circle';
      let metaHtml = '';
      if (state === 'reused') metaHtml = '<span class="phases__meta">沿用</span>';
      else if (state === 'active' && t.observed !== false) metaHtml = `<span class="phases__meta">已等待 ${P.liveSince(t.since)}</span>`;
      let noteHtml = '';
      if (state === 'active' && i === 3) {
        const n = reused ? '重新检查 Agent 的命令行工具、注入凭证，再起一个新的 Agent 会话…'
          : t.installing ? `正在安装 ${AGENT_ID[t.agent] || 'codex'} 的命令行工具…（这张镜像里没有预装它，现装可能要十几分钟，不是卡死）`
            : t.imageStaged === false ? '本机还没有这个镜像，正在下载到本机并启动运行环境…（首次使用可能持续数分钟，期间没有输出，不是卡死）'
              : t.imageStaged === true ? '镜像已在本机，正在启动运行环境…' : '正在启动运行环境…';
        noteHtml = `<p class="phases__note">${esc(n)}</p>`;
      }
      return `<li class="phases__item" data-phase-state="${state}"><span class="${icon}" aria-hidden="true"></span><span class="phases__label">${label}</span>${metaHtml}${noteHtml}</li>`;
    }).join('');
    return { pct, items };
  }
  function paintPhases(host, t, reused) {
    const ph = $('.phases', host);
    const key = JSON.stringify([t.state, t.status, t.observed, t.imageStaged, t.installing, !!reused]);
    if (ph.dataset.key === key) return;
    ph.dataset.key = key;
    const { pct, items } = phasesHtml(t, reused);
    ph.dataset.status = t.status || 'starting';
    const meter = $('.meter', ph); meter.setAttribute('aria-valuenow', String(pct)); $('.meter__bar', meter).style.width = `${pct}%`;
    $('.phases__list', ph).innerHTML = items;
    // 可能卡住：进度卡最后一条琥珀提示（[取消并删除…] 在前、[继续等待] 在后；卡里进行中那格的点不变色）
    const old = $(':scope > .note', ph); if (old) old.remove();
    if (t.state === 'stuck') {
      const n = P.fromTpl('tpl-stuck-note');
      const phase = P.PHASES[P.PHASE_OF[t.status]];
      $('.note__title', n).innerHTML = `可能卡住了：已 ${P.liveSince(t.since)} 没有新进展`;
      $('.note__text', n).textContent = t.status === 'creating' ? PHASE_NOTE.creating : PHASE_NOTE.generic.replace('这一步', `「${phase}」这一步`);
      const [del, wait] = $$('.note__actions .btn', n);
      del.dataset.action = 'cancel-delete'; del.dataset.task = t.id; del.dataset.fk = 'stuck-delete';
      wait.dataset.action = 'keep-waiting'; wait.dataset.task = t.id; wait.dataset.fk = 'stuck-wait';
      ph.appendChild(n);
    }
    P.updateLive();
  }
  // 「镜像：…」一行（2026-10-04 Q-LCH-03 B；REQ-LCH-017）：启动进度卡在标题（与副标题）之后、结果卡在主语行之后，.empty__subject 同主语行写法，
  // 放在 role 容器之外、不进播报；写这个任务锁定的那一版（t.image），平台预制镜像加「（平台预制镜像）」。模板里稿件的示例值在 wire 时认出来、按任务填
  function markImageLine(card) {
    const el = [...card.querySelectorAll(':scope > .empty__subject')].find((x) => x.textContent.startsWith('镜像：'));
    if (el) el.dataset.imageLine = '';
  }
  function paintImageLine(card, t) {
    const el = $(':scope > [data-image-line]', card); if (!el) return;
    const txt = imageLine(t);
    el.hidden = !txt;
    if (txt && el.textContent !== txt) el.textContent = txt;
  }
  P.views['tpl-task-startup'] = {
    wire(main) { const ph = $('.phases', main); ph.removeAttribute('role'); ph.removeAttribute('aria-live'); markImageLine($('.empty', main)); },
    refresh(host, r) {
      const t = P.task(r.taskId); if (!t) return;
      const card = $('#main > .empty', host);
      $('.empty__title', card).textContent = `正在启动：${t.name}`;
      // 副标题只在「启动运行环境」这一格、本机没有这张镜像时出（平台只在这一格之后才问得出来，REQ-LCH-012）；在镜像那一行之前（f-lch-startup-04）
      let sub = $(':scope > [data-first-image]', card);
      const want = t.status === 'starting' && t.imageStaged === false;
      if (want && !sub) { sub = document.createElement('p'); sub.className = 'empty__subject'; sub.dataset.firstImage = ''; sub.textContent = '首次使用这个镜像，要先把它下载到本机 —— 整个启动里这一步最久'; $('.empty__title', card).after(sub); }
      else if (!want && sub) sub.remove();
      paintImageLine(card, t);
      paintPhases(host, t, false);
    },
  };
  P.actions['keep-waiting'] = (a) => {
    const t = P.task(a.dataset.task); if (!t || t.state !== 'stuck') return;
    t.state = 'preparing'; t.since = P.clock.now(); // [继续等待] = 收起提示、从这一刻重新计时，树点回到准备中（REQ-LCH-013）
    P.announce('继续等待，从现在重新计时');
    P.render();
    P.focusMain();
  };
  P.actions['cancel-delete'] = (a) => { const t = P.task(a.dataset.task); if (t) openCancelDelete(t, a); };
  // 取消并删除（REQ-LCH-014；f-lch-startup-06）：首次启动不给「留下来」；从已停止重新启动的给（默认留下，Q-SBX-02 B）
  function openCancelDelete(t, returnTo) {
    const p = P.proj(t.project);
    const box = P.fromTpl('tpl-cancel-delete');
    box.dataset.dialog = 'cancel-delete';
    $('.dialog__title', box).textContent = `取消并删除任务「${t.name}」？`;
    $('.dialog__subtitle', box).textContent = `${p.name} · ${t.agent} · 准备中${t.state === 'stuck' ? '（可能卡住）' : ''}`;
    const blocks = $$('.dconfirm__block', box);
    const phase = P.PHASES[P.PHASE_OF[t.status] != null ? P.PHASE_OF[t.status] : 3];
    const dur = P.fmtDur(P.clock.now() - t.since);
    $('.bullets', blocks[0]).innerHTML = `<li>准备到一半的运行环境 <span class="dconfirm__meta">（${t.state === 'stuck' ? `卡在「${esc(phase)}」，已 ${dur} 没有新进展` : `正在「${esc(phase)}」，已等待 ${dur}`}）</span></li><li>这条任务记录</li>`;
    if (t.restart) {
      // 从已停止重新启动、还在准备中：之前的改动还在代码副本里，照常给「留下来」并默认选中（Q-SBX-02 B，AC-LCH-014.4；单选组与那一句同 f-sbx-destroy-03）
      const wd = keepBlock('它是从已停止重新启动的，之前的改动还在代码副本里。');
      blocks[1].replaceWith(wd);
    }
    const cancel = $('.dialog__footer > .btn', box); cancel.dataset.dlg = 'cancel';
    $('.dialog__close', box).dataset.dlg = 'cancel';
    const danger = $('.btn--danger', box); danger.dataset.dlg = 'confirm';
    const m = P.openModal(box, { kind: 'cancel-delete', returnTo, initialFocus: '[data-initial-focus]' });
    m.box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dlg]'); if (!b) return;
      if (b.dataset.dlg === 'cancel') { P.closeModal(m); return; }
      const keep = !!$('.dconfirm__option input[value="keep"]:checked', m.box);
      P.closeModal(m, { restoreFocus: false });
      destroyTask(t, t.restart ? keep : false, { firstLaunch: !t.restart });
    });
  }

  // ================================================================== F-SBX-DESTROY 销毁确认（试点 P4 结构）与删除中两段（f-sbx-destroy-01）
  // Q-SBX-02 B（2026-10-04 用户拍板）：只有「首次启动阶段失败」的异常任务不给「留下来」；停止失败 / 重新启动失败 / 上一次销毁失败的异常任务给，默认留下
  const noOutcome = (t) => t.state === 'error' && (!t.failedAt || t.failedAt === 'launch');
  // 异常任务的「代码副本怎么处理」：f-sbx-destroy-03 的单选组（默认留下）+ 下面一句为什么照常给（按失败阶段换说法）
  const KEEP_WHY = { start: '它是重新启动时失败的，之前的改动还在代码副本里。', stop: '它是停止时失败的，之前的改动还在代码副本里。', destroy: '上一次没能销毁它，之前的改动还在代码副本里。' };
  const ENV_NOW = { start: '这次没能启动起来，没有终端会话', stop: '停止时出了问题，没有终端会话', destroy: '上一次没能删掉，没有终端会话' };
  const STAGE_WORD = { launch: '启动失败', start: '启动失败', stop: '停止失败', destroy: '删除失败' };
  function keepBlock(why) {
    const el = P.fromTpl('tpl-destroy-keep');
    const n = $('.dconfirm__note', el);
    if (why) n.textContent = why; else { n.remove(); el.removeAttribute('aria-describedby'); }
    return el;
  }
  function openDestroy(t, returnTo) {
    const p = P.proj(t.project);
    const s = STATE[t.state];
    let blocks;
    // 运行中 / 已停止的任务：试点 P4 的单选组（Q-SBX-03 A：「工作目录」→「代码副本」）
    const keepRadios = `<div class="dconfirm__block" role="radiogroup" aria-label="代码副本怎么处理"><span class="dconfirm__title">代码副本怎么处理</span><label class="dconfirm__option"><input class="radio" type="radio" name="proto-copy" value="keep" checked><span class="dconfirm__option-label">留下来作为成果 <span class="dconfirm__meta">（默认；30 天后自动清理，<span class="u-nowrap">可在「保留下来的成果」里下载）</span></span></span></label><label class="dconfirm__option"><input class="radio" type="radio" name="proto-copy" value="delete"><span class="dconfirm__option-label">一起删掉，不留成果</span></label></div>`;
    if (noOutcome(t)) {
      // 首次启动阶段失败：运行环境没起来、Agent 没开始干活——同 v1 g2-04 与 f-lch-startup-06 的口径，不给「留下来」
      blocks = `<div class="dconfirm__block"><div class="dconfirm__title">会删掉</div><ul class="bullets"><li>没能启动的运行环境 <span class="dconfirm__meta">（${esc(t.reason)}）</span></li><li>这条任务记录</li></ul></div>`
        + `<div class="dconfirm__block"><div class="dconfirm__title">代码副本怎么处理</div><ul class="bullets"><li>一起删掉，不留成果<span class="dconfirm__note">Agent 还没开始干活，代码副本里只有刚复制出来的项目代码，没有成果可留，所以这里不给「留下来」的选项。</span></li></ul></div>`;
    } else if (t.state === 'error') {
      // 停止失败 / 重新启动失败 / 上一次销毁失败（f-sbx-destroy-03）：照常给「留下来」并默认选中，单选组下一句说为什么
      const env = ENV_NOW[t.failedAt] ? `运行环境 <span class="dconfirm__meta">（${ENV_NOW[t.failedAt]}）</span>` : `出了问题的运行环境 <span class="dconfirm__meta">（${esc(t.reason)}）</span>`;
      blocks = `<div class="dconfirm__block"><div class="dconfirm__title">会删掉</div><ul class="bullets"><li>${env}</li><li>代码副本里还没推送到远端的改动<span class="dconfirm__note">平台不检查有没有推送；拿不准就选下面的「留下」。</span></li></ul></div>` + keepBlock(KEEP_WHY[t.failedAt] || null).outerHTML;
    } else {
      const n = t.state === 'stopped' || t.headless ? 0 : P.sessionCount(t);
      const env = t.state === 'stopped'
        ? `运行环境 <span class="dconfirm__meta">（已停止，没有打开着的终端会话）</span>`
        : t.headless ? `运行环境 <span class="dconfirm__meta">（正在跑的这一轮无头运行会被终止）</span>`
          : `运行环境，以及 ${n} 个终端会话 <span class="dconfirm__meta">（Agent 会话${n > 1 ? ` + ${n - 1} 个独立终端` : ''}）</span>`;
      blocks = `<div class="dconfirm__block"><div class="dconfirm__title">会删掉</div><ul class="bullets"><li>${env}</li><li>代码副本里还没推送到远端的改动<span class="dconfirm__note">平台不检查有没有推送；拿不准就选下面的「留下」。</span></li></ul></div>` + keepRadios;
    }
    blocks += `<div class="dconfirm__block dconfirm__block--untouched"><div class="dconfirm__title">不受影响</div><ul class="bullets"><li>远端 Git 仓库，以及同项目的其他任务</li></ul></div>`
      + `<p class="dconfirm__source">清单来源：后端返回（任务详情${t.state === 'error' ? '' : ' + 终端会话登记'}）。</p>`;
    // 副标题 = 项目 · Agent · 状态；异常任务在状态后括注失败在哪一步（f-sbx-destroy-03「异常（启动失败）」）
    const word = t.state === 'error' && STAGE_WORD[t.failedAt] ? `${s.word}（${STAGE_WORD[t.failedAt]}）` : s.word;
    const html = `<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="proto-dlg-title" data-dialog="destroy"><div class="dialog__header"><h2 class="dialog__title" id="proto-dlg-title">销毁任务「${esc(t.name)}」？</h2><p class="dialog__subtitle">${esc(p.name)} · ${esc(t.agent)} · ${word}</p></div><div class="dialog__body dconfirm">${blocks}</div><div class="dialog__footer"><button class="btn btn--secondary btn--32" type="button" data-initial-focus data-dlg="cancel">取消</button><div class="dialog__footer-end"><button class="btn btn--danger btn--32" type="button" data-dlg="confirm">销毁任务</button></div></div><button class="btn btn--tertiary btn--28 btn--icon dialog__close" type="button" aria-label="关闭" data-dlg="cancel"><span class="icon i-x" aria-hidden="true"></span></button></div>`;
    const m = P.openModal(html, { kind: 'destroy', initialFocus: '[data-initial-focus]', returnTo });
    m.box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dlg]'); if (!b) return;
      if (b.dataset.dlg === 'cancel') { P.closeModal(m); return; }
      const keep = !!$('.dconfirm__option input[value="keep"]:checked', m.box);
      P.closeModal(m, { restoreFocus: false });
      destroyTask(t, keep, { firstLaunch: noOutcome(t) });
    });
  }
  P.openDestroy = openDestroy;
  // 两段：确认后先进「删除中」（树行淡出点 + 半透明 +「删除中…」、菜单只剩禁用项、计数不再算它），TIMING.destroy 后移除
  function destroyTask(t, keep, { firstLaunch } = {}) {
    if (t.state === 'destroying') return;
    const wasCurrent = ui.route.view === 'task' && ui.route.taskId === t.id;
    const keepOk = keep && !firstLaunch;
    t.prevState = t.state;
    t.state = 'destroying';
    t.keep = keepOk;
    const progText = firstLaunch ? '完成后从左侧移除；它没有成果可留，代码副本一起删掉。' : keepOk ? '完成后从左侧移除；代码副本会留下来作为成果。' : '完成后从左侧移除；代码副本一起删掉。';
    if (wasCurrent) {
      // 删的是当前任务：主区立刻离开它、回项目总览，页内提示「正在销毁…」（REQ-SBX-021）
      ui.notice = { key: 'overview', progress: true, title: `正在销毁任务「${t.name}」…`, text: progText, fresh: true };
      P.go('overview');
    } else {
      P.render();
      P.announce(`正在销毁任务「${t.name}」…`);
    }
    P.focusMain();
    P.clock.after(T.destroy, () => finishDestroy(t, keepOk, firstLaunch));
  }
  P.destroyTask = destroyTask;
  function finishDestroy(t, keep, firstLaunch) {
    if (P.scenario.take('destroy') === 'fail') { failDestroy(t); return; }
    const i = world.tasks.indexOf(t);
    if (i >= 0) world.tasks.splice(i, 1);
    delete ui.tabs[t.id];
    for (const k of Object.keys(ui.cleared)) if (k.startsWith(`${t.id}-`)) delete ui.cleared[k];
    if (keep) world.retained.push({ id: `rv-${t.id}`, project: t.project, name: t.name, sandboxId: `${t.id}-0000-4000-8000-000000000000`, source: 'manual-destroy', retainedAt: P.fmtFull(P.clock.wall()), keepDays: 30, diskMB: 900, dlMB: 120 });
    const text = firstLaunch ? '代码副本一起删掉了（没有成果可留）。' : keep ? '代码副本留下来作为成果：30 天后自动清理，可在「保留下来的成果」里下载。' : '代码副本一起删掉了，没有留成果。';
    const textHtml = keep ? `代码副本留下来作为成果：30 天后自动清理，可在<button class="link proto-notice__link" type="button" data-action="open-retained" data-project="${t.project}" data-fk="notice-retained">「保留下来的成果」</button>里下载。` : null;
    // 完成提示：主区在哪就出在哪（总览里是页内提示，其余视图叠在右上角，PF-07）
    ui.notice = { key: P.viewKey(), title: `已销毁任务「${t.name}」`, text, textHtml, protoNote: '原型：只在本页内存里删除，刷新即复原', fresh: false };
    P.render();
    P.announce(`已销毁任务「${t.name}」。${text}`);
  }
  P.actions['open-retained'] = (a) => P.openRetained(a.dataset.project || null, a);
  // 第五段（W4，评审 R2-34④；REQ-SBX-022 / f-sbx-destroy-02）：销毁没成功——任务转异常（红点 +「删除失败：…」）、名额释放（异常是终态），
  // 主区若停在它上面就是异常结果卡（[销毁任务…][复制诊断信息]）；当时若正看着它，主区已回总览，那条「正在销毁…」页内提示换成失败一句（可关）
  function failDestroy(t) {
    Object.assign(t, { state: 'error', code: 'PROVIDER_UNAVAILABLE', failedAt: 'destroy', reason: '删除失败：容器服务没有响应', detail: DETAIL.PROVIDER_UNAVAILABLE_destroy, age: null, keep: false });
    const text = '容器服务没有响应。任务已转为异常，名额已释放；在左侧点开它可以再试一次。';
    // 「正在销毁…」那条进行中提示在哪（删的是当前任务时在总览），失败句就换在哪——不按此刻的路由算（换路由的 hashchange 可能还没到）
    const prev = ui.notice;
    ui.notice = { key: prev && prev.progress ? prev.key : P.viewKey(), title: `没能销毁任务「${t.name}」`, text, icon: 'i-circle-x tone-fail', fresh: false };
    P.render();
    P.announce(`没能销毁任务「${t.name}」：${text}`);
  }
  P.actions['destroy-task'] = (a) => { const t = P.task(a.dataset.task); if (t && t.state !== 'destroying') openDestroy(t, a); };

  // ================================================================== F-SBX-RELAUNCH 异常结果卡（f-sbx-relaunch-01 / 02、f-sbx-stopstart-04）
  P.views['tpl-task-error'] = {
    refresh(host, r) {
      const t = P.task(r.taskId); if (!t) return;
      const f = failureOf(t);
      const card = $('.empty--outcome', host);
      const key = JSON.stringify([t.id, t.code, t.failedAt, t.detail, imageLine(t)]);
      if (card.dataset.key === key) return;
      card.dataset.key = key;
      if (!card.querySelector(':scope > [data-image-line]')) markImageLine(card);
      paintImageLine(card, t);
      if (t.code) card.dataset.code = t.code; else delete card.dataset.code;
      const ic = $('.empty__icon', card);
      ic.className = `empty__icon empty__icon--${f.tone}`;
      ic.innerHTML = `<span class="icon ${f.icon}" aria-hidden="true"></span>`;
      const title = $('.empty__title', card);
      title.className = `empty__title ${f.tone === 'timeout' ? 'tone-timeout' : 'tone-fail'}`;
      title.textContent = f.title;
      $('.empty__subject', card).textContent = `任务：${t.name}`;
      $('.empty__desc', card).innerHTML = (f.descAt && t.failedAt && f.descAt[t.failedAt]) || f.desc;
      let pre = $('.empty__detail', card);
      if (t.detail) { if (!pre) { pre = document.createElement('pre'); pre.className = 'empty__detail'; $('.empty__desc', card).after(pre); } pre.textContent = t.detail; } else if (pre) pre.remove();
      const LABEL = { relaunch: '重新发起', 'check-image': '检查镜像地址', diagnose: '运行诊断', 'copy-diag': '复制诊断信息', destroy: '销毁任务…' };
      const ACT = { destroy: 'destroy-task' };
      const CLS = { 'copy-diag': 'btn--tertiary', destroy: 'btn--danger-tertiary' }; // [销毁任务…] 是进入二次确认的入口（danger-tertiary）
      const acts = (f.actionsAt && t.failedAt && f.actionsAt[t.failedAt]) || f.actions;
      $('.btn-row', card).innerHTML = acts.filter((a) => a !== 'copy-diag' || t.code || t.detail).map((a) => `<button class="btn ${CLS[a] || 'btn--secondary'}" type="button"${a === 'relaunch' || a === 'destroy' ? ' aria-haspopup="dialog"' : ''} data-action="${ACT[a] || a}" data-task="${t.id}" data-fk="o-${a}">${LABEL[a]}</button>`).join('');
      const actions = $('.empty__actions', card);
      let note = $('.empty__note', actions);
      const noteHtml = f.note && t.failedAt && f.note[t.failedAt];
      if (noteHtml) { if (!note) { note = document.createElement('p'); note.className = 'empty__note'; actions.appendChild(note); } note.innerHTML = noteHtml; } else if (note) note.remove();
      // 诊断码行：没有错误码时不画，也不把 UNKNOWN 当码上屏（AC-SBX-001.3）
      let code = $('.empty__code', card);
      if (t.code) { if (!code) { code = document.createElement('p'); code.className = 'empty__code'; card.appendChild(code); } code.innerHTML = `诊断码：<code>${esc(t.code)}</code>`; } else if (code) code.remove();
    },
  };
  P.actions.relaunch = (a) => { const t = P.task(a.dataset.task); if (t) P.openNewTask(t.project, a, { relaunchFrom: t }); };
  P.actions['check-image'] = (a) => {
    const t = P.task(a.dataset.task); if (!t) return;
    // 定位这个任务用的那张镜像（按任务记下的镜像找卡，REQ-SBX-004；工作台发起的任务也可能用自定义镜像了——Q-LCH-03 B）
    ui.source = { taskId: t.id, name: t.name, title: failureOf(t).title.replace(/（.*$/, ''), imageId: t.image ? t.image.id : null, builtin: !t.image || t.image.builtin };
    P.go('images');
  };
  // [运行诊断]（环境类错误，Q-SYS-01② A）：去系统状态并自动开始一轮诊断（同离线横幅 [重新检测]；已在系统状态就就地跑）
  P.actions.diagnose = () => { if (P.requestDiagnose) P.requestDiagnose(); };
  let lastDiag = null;
  P.stateExtras.push(() => ({ lastDiag }));
  P.actions['copy-diag'] = (a) => {
    const t = P.task(a.dataset.task); if (!t) return;
    const f = failureOf(t);
    // 「任务：」之后一行「镜像：<坐标>@<完整版本号>」（REQ-SBX-005、AC-LCH-017.4）
    const text = [`任务：${t.name}`, t.image ? `镜像：${t.image.ref}@${t.image.digest}` : null, `现象：${f.title}`, t.code ? `错误码：${t.code}` : null, t.detail ? `细节：${t.detail}` : null].filter(Boolean).join('\n');
    lastDiag = text; // 测试出口：__proto.state.lastDiag（剪贴板在 file:// 下读不回来）
    const ok = () => P.toast('ok', '诊断信息已复制');
    const fail = () => P.toast('fail', '复制失败，请手动选中下面的失败细节复制');
    const mode = P.scenario.get('clipboard');
    if (mode === 'ok') { ok(); return; }
    if (mode === 'fail') { fail(); return; }
    try {
      const pr = navigator.clipboard && navigator.clipboard.writeText(text);
      if (!pr || typeof pr.then !== 'function') { fail(); return; }
      pr.then(ok, fail);
    } catch (e) { fail(); } // 非 HTTPS 部署里 navigator.clipboard 不存在：不能静默（AC-SBX-005.2）
  };
  // 检查镜像地址 → 镜像管理：内容顶部来源提示（可关）+ 定位这个任务用的那张镜像卡（f-sbx-relaunch-04）；提示只属于这一次跳转
  P.hook('view:wired', (tplId, main) => {
    if (tplId !== 'tpl-images' || !ui.source) return;
    const src = ui.source;
    const note = P.fromTpl('tpl-source-note');
    note.dataset.fk = 'src-note';
    $('.note__title', note).textContent = `从任务「${src.name}」来：${src.title}——看看镜像地址与验证结论`;
    // 正文第一句点名这个任务用的是哪张（稿件示例是「迁移构建脚本」+ 平台预制镜像），其余照稿（Q-SYS-16 A：只说联网检查，不提出网代理）
    const nt = $('.note__text', note);
    nt.textContent = nt.textContent.replace(/^「[^」]*」用的是下面标出的这张镜像(（平台预制镜像）)?。/, `「${src.name}」用的是下面标出的这张镜像${src.builtin ? '（平台预制镜像）' : ''}。`);
    const [back, sys] = $$('.note__actions a', note);
    back.innerHTML = `<span class="icon i-arrow-left" aria-hidden="true"></span>回到任务「${esc(src.name)}」`;
    back.setAttribute('href', `#task-${src.taskId}`); back.dataset.fk = 'src-back';
    sys.setAttribute('href', '#system'); sys.dataset.fk = 'src-system';
    const x = $('.note__end .btn', note); x.dataset.action = 'close-source'; x.dataset.fk = 'src-close';
    const toolbar = $('.page-toolbar', main);
    if (toolbar) toolbar.before(note); else $('.content__inner', main).prepend(note);
    const card = (src.imageId && $(`article[data-img="${CSS.escape(src.imageId)}"]`, main)) || $('article[aria-labelledby="p7-img-sandbox"]', main) || $('article[data-status="valid"]', main);
    if (card) {
      card.classList.add('is-current');
      card.setAttribute('aria-describedby', 'p7-located');
      const nm = $('.p7-name', card);
      if (nm) nm.insertAdjacentHTML('beforeend', `<span class="badge badge--20 badge--info sbx-located" id="p7-located">「${esc(src.name)}」用的镜像</span>`);
      requestAnimationFrame(() => card.scrollIntoView({ block: 'nearest' }));
    }
    P.upgradeTips(note);
  });
  P.hook('route', (r) => { if (r.view !== 'images') ui.source = null; });
  P.actions['close-source'] = (a) => {
    ui.source = null;
    const n = a.closest('.sbx-source'); if (n) n.remove();
    const card = $('#shell-main article.is-current'); if (card) { card.classList.remove('is-current'); card.removeAttribute('aria-describedby'); const b = $('#p7-located'); if (b) b.remove(); }
    const s = $('[data-fk="img-search"]'); if (s) s.focus();
  };

  // ================================================================== F-SBX-STOPSTART 停止与启动（f-sbx-stopstart-01…04）
  function conflictToast() { P.toast('neutral', '现在的状态不允许做这件事', '这个任务的状态在你操作之前已经变了。刷新一下，按新的状态再操作。'); }
  function stopTask(t) {
    if (!['running', 'idle', 'waiting'].includes(t.state)) return;
    const scen = P.scenario.take('stop');
    if (scen === 'conflict') { conflictToast(); return; } // 409：不把任务标成异常（REQ-SBX-015）
    // 停止 = 暂停：不二次确认；停止中副行「停止中…」、终端只读、新终端与 [启动] 不可用（REQ-SBX-010 / 011）
    t.prevState = t.state;
    t.state = 'stopping';
    P.announce(`正在停止「${t.name}」…`);
    P.render();
    P.clock.after(T.stop, () => {
      if (t.state !== 'stopping') return;
      if (scen === 'fail') {
        Object.assign(t, { state: 'error', code: 'PROVIDER_UNAVAILABLE', failedAt: 'stop', reason: '停止失败：容器服务没有响应', detail: DETAIL.PROVIDER_UNAVAILABLE_stop, age: null });
        delete ui.tabs[t.id];
        P.announce(`「${t.name}」停止失败：容器服务没有响应`);
      } else {
        t.state = 'stopped';
        t.age = null;
        delete ui.tabs[t.id]; // 终端标签收起
        P.announce(`已停止任务「${t.name}」`);
      }
      P.render();
    });
  }
  function startTask(t) {
    if (t.state !== 'stopped') return;
    const scen = P.scenario.take('start');
    if (scen === 'conflict') { conflictToast(); return; }
    // 启动：从「启动运行环境」开始，前三格沿用，会话从头、指令不重放（REQ-SBX-013）
    Object.assign(t, { state: 'starting', status: 'starting', since: P.clock.now(), observed: true, restart: true, imageStaged: true });
    P.emit('task:inject', t); // 重新启动也从「启动运行环境」这一步注入凭证（按这一刻的生效方式）
    P.announce(`正在启动「${t.name}」`);
    P.render();
    P.clock.after(T.start, () => {
      if (t.state !== 'starting') return;
      if (scen === 'fail') {
        Object.assign(t, { state: 'error', code: 'PROVIDER_UNAVAILABLE', failedAt: 'start', reason: '启动失败：容器服务没有响应', detail: DETAIL.PROVIDER_UNAVAILABLE_start, age: null });
        delete t.status; delete t.restart;
        P.announce(`「${t.name}」启动失败：容器服务没有响应`);
        P.dirty();
      } else becomeRunning(t, '<span class="ansi-dim">Agent 会话从头开始（原来的任务指令不会再执行一遍）</span>');
    });
  }
  P.stopTask = stopTask;
  P.startTask = startTask;
  P.actions['start-task'] = (a) => { const t = P.task(a.dataset.task || (P.currentTask() || {}).id); if (t) startTask(t); };
  // 停止中的终端视图：终端栏下一条「正在停止…」连接条；[新终端] 不可用并说原因（f-sbx-stopstart-01）
  P.hook('term:rendered', (host, t) => {
    const nt = $('[data-fk="newterm"]', host);
    let bar = $('[data-stop-line]', host);
    if (t.state === 'stopping') {
      if (!bar) { bar = P.fromTpl('tpl-stop-line'); bar.dataset.stopLine = ''; $('.termbar', host).after(bar); }
      if (nt) { nt.setAttribute('aria-disabled', 'true'); nt.setAttribute('aria-describedby', 'stop-line'); nt.dataset.reason = '正在停止，不能再开新终端'; }
    } else {
      if (bar) bar.remove();
      if (nt) { nt.removeAttribute('aria-disabled'); nt.removeAttribute('aria-describedby'); delete nt.dataset.reason; }
    }
  });
  // 已停止结果卡（DR-03 A 文案；[启动][发起新任务]）
  P.views['tpl-task-stopped'] = {
    wire(main) { markImageLine($('.empty--outcome', main)); },
    refresh(host, r) {
      const t = P.task(r.taskId); if (!t) return;
      $('.empty__subject', host).textContent = `任务：${t.name}`;
      paintImageLine($('.empty--outcome', host), t);
      const [start, again] = $$('.btn-row .btn', host);
      start.dataset.action = 'start-task'; start.dataset.task = t.id; start.dataset.fk = 'o-start';
      again.dataset.action = 'new-task'; again.dataset.project = t.project; again.dataset.fk = 'o-new';
    },
  };
  // 从已停止重新启动的进度卡（f-sbx-stopstart-03：前三格「沿用」、第 4 格进行中）
  P.views['tpl-task-restart'] = {
    wire(main) { const ph = $('.phases', main); ph.removeAttribute('role'); ph.removeAttribute('aria-live'); markImageLine($('.empty', main)); },
    refresh(host, r) {
      const t = P.task(r.taskId); if (!t) return;
      $('.empty__title', host).textContent = `正在启动：${t.name}`;
      paintImageLine($('#main > .empty', host), t);
      paintPhases(host, t, true);
    },
  };

  // ================================================================== F-SBX-HEADLESS 无头任务（f-sbx-headless-01…05）
  // 输出脚本（notes/lch-b.md §7，与稿件逐条对应）：前 8 条是打开时已有的（第 8 条工具调用还在跑），之后逐条追加，最后出本轮结果
  const LOG = [
    { kind: 'msg', text: '我先看一下上一轮（#11）之后 main 上新增的提交，再按 e2e/regression.config.ts 跑一遍回归。' },
    { kind: 'tool', input: 'cat e2e/regression.config.ts', status: 'ok', exit: 0 },
    { kind: 'tool', input: 'git log --oneline regression-11..main', output: '3f9c2e1 feat(auth): 登录态过期后静默续期\na71d0b4 fix(pay): 支付回调重复入账\n9e2c4f8 chore(deps): 升级依赖到 Node 22', status: 'ok', exit: 0, open: true },
    { kind: 'error', text: '历史输出回放失败，下方内容可能不完整；重连或刷新可以再试一次。', code: 'REPLAY_FAILED' },
    { kind: 'msg', text: '#11 之后有 3 个提交：登录态续期、支付回调、依赖升级各 1 个。先跑这三块相关的用例，再跑全量。' },
    { kind: 'tool', input: 'pnpm exec playwright test e2e/regression/auth.spec.ts', status: 'fail', exit: 1 },
    { kind: 'msg', text: 'auth.spec.ts 有 1 个用例超时（静默续期之后的重放请求），我加一次重试再跑，看是不是偶发。' },
    { kind: 'tool', input: 'pnpm exec playwright test e2e/regression/auth.spec.ts --retries=1', status: 'fail', exit: 1, open: true, slow: true },
    { kind: 'msg', text: '重跑后还是同一个用例超时：3 个请求同时 401 时，第 3 个请求重放时带的仍是旧 token，不是偶发。\n我没有改代码，报告和录屏放进了产物，留给你决定。' },
    { kind: 'notice', text: '任务执行结束' },
  ];
  // 步骤：0–7 依次出现前 8 条；8 = 第 8 条工具调用落定（失败，退出码 1）；9、10 = 后两条；11 = 本轮结果
  const STEPS_DONE = 11;
  const OUTCOME = {
    failed: { title: '任务失败', tone: 'tone-fail', icon: 'i-circle-x', exit: '<b>1</b>', advice: '任务以失败告终（CLI 非零退出或运行途中报错）。可以看上方输出定位原因后重跑。 CLI 以退出码 1 结束。', code: 'TASK_FAILED', artifacts: [{ name: 'regression-report.html', icon: 'i-file-code', size: '412 KB', at: '2026-10-02T06:21:37.000Z' }, { name: 'auth.spec.trace.zip', icon: 'i-archive', size: '2.3 MB', at: '2026-10-02T06:22:05.000Z' }] },
    killed: { title: '任务被终止', tone: 'tone-fail', icon: 'i-circle-x', exit: '<b>未知（进程被信号终止，没有退出码）</b>', advice: '任务已被终止（你点了「终止任务」，或平台执行了强杀）。本轮不可恢复，可以重新发起一轮。 本次没有拿到退出码——进程被信号终止（超时强杀 / OOM / 手动终止）时不会留下退出码，已按非零退出处理。', code: 'TASK_KILLED', artifacts: [] },
    timeout: { title: '任务超时，已被强制终止', tone: 'tone-timeout', icon: 'i-clock', exit: '<b>未知（进程被信号终止，没有退出码）</b>', advice: '这一轮跑满了超时档还没结束，平台已强制终止。可以调大超时档后重跑。', code: 'TIMEOUT', artifacts: [] },
  };
  function hlOf(t) {
    if (!t.hl) t.hl = { step: 8, stream: 'open', attempt: 0, missed: 0, outcome: null, cancel: 'idle', nextStepAt: null, nextMinuteAt: null, launcher: null, dl: null };
    return t.hl;
  }
  function logHtml(t) {
    const hl = hlOf(t);
    // 步骤 → 可见条数：0–8 步 = 前 step 条（第 8 条工具调用还在跑）；第 9 步它落定；之后每步多一条
    const n = hl.step <= 8 ? hl.step : Math.min(hl.step - 1, 10);
    return LOG.slice(0, Math.max(0, n)).map((e, i) => {
      if (e.kind === 'msg') return `<li class="hl-line hl-line--message"><pre>${esc(e.text)}</pre></li>`;
      if (e.kind === 'notice') return `<li class="hl-line hl-line--notice"><pre>${esc(e.text)}</pre></li>`;
      if (e.kind === 'error') return `<li class="hl-line hl-line--error"><span class="icon i-circle-x" aria-hidden="true"></span><div class="hl-line__body"><pre>${esc(e.text)}</pre><p class="hl-line__code">诊断码：<code>${esc(e.code)}</code></p></div></li>`;
      const running = e.slow && hl.step <= 8;
      const status = running ? '<span class="hl-tool__status">运行中…</span>' : e.status === 'fail' ? `<span class="hl-tool__status hl-tool__status--fail">失败（退出码 ${e.exit}）</span>` : `<span class="hl-tool__status">已完成（退出码 ${e.exit}）</span>`;
      const body = `<p class="hl-tool__label">入参</p><pre class="hl-tool__pre">${esc(e.input)}</pre>${e.output ? `<p class="hl-tool__label">输出</p><pre class="hl-tool__pre">${esc(e.output)}</pre>` : ''}${running ? '<p class="hl-tool__wait">结果还没回来（完成事件到达后会就地补上，不会另起一条）。</p>' : ''}`;
      return `<li class="hl-line"><details class="hl-tool${!running && e.status === 'fail' ? ' hl-tool--fail' : ''}"${e.open && (i !== 7 || running) ? ' open' : ''} data-fk="hl-tool-${i}"><summary class="hl-tool__summary"><span class="icon hl-tool__chev i-chevron-right" aria-hidden="true"></span><span class="icon i-wrench" aria-hidden="true"></span>工具调用：<span class="hl-tool__name">shell</span>${status}</summary><div class="hl-tool__body">${body}</div></details></li>`;
    }).join('');
  }
  function deadlineText(t) {
    if (t.leftMin <= 0) return '已超过硬超时上限，平台正在强制终止…';
    const h = Math.floor(t.leftMin / 60), m = t.leftMin % 60;
    return `还剩 ${h ? `${h} 小时 ` : ''}${m} 分`;
  }
  function viewingHl(t) { return ui.route.view === 'task' && ui.route.taskId === t.id && !ui.loading; }
  function finishRun(t, kind) {
    const hl = hlOf(t);
    if (kind === 'failed') hl.step = STEPS_DONE;
    hl.outcome = { ...OUTCOME[kind], session: !P.scenario.is('hl-session', 'no') };
    hl.cancel = 'idle';
    hl.launcher = null;
    P.announce(`「${t.name}」本轮结束：${hl.outcome.title}`);
    P.dirty();
  }
  P.clock.ticker({
    active: () => world.tasks.some((t) => t.headless && t.state === 'running' && !(t.hl && t.hl.outcome)),
    tick(now) {
      for (const t of world.tasks) {
        if (!t.headless || t.state !== 'running') continue;
        const hl = hlOf(t);
        if (hl.outcome) continue;
        // 剩余时间（原型每 10 秒减 1 分）；跑满超时档 → 强制终止
        if (hl.nextMinuteAt == null) hl.nextMinuteAt = now + T.hlMinute;
        if (now >= hl.nextMinuteAt) { hl.nextMinuteAt = now + T.hlMinute; if (t.leftMin > 0) t.leftMin--; else { finishRun(t, 'timeout'); continue; } }
        // 事件流断开：自动重连（第 N 次）每秒一次，8 次后停（REQ-SBX-033）；断开期间输出攒着
        if (hl.stream === 'reconnecting') {
          if (hl.attempt < T.hlReconnectMax) hl.attempt++; else hl.stream = 'closed';
          P.dirty();
        }
        // 输出只在打开着这个任务时逐条到达（事件流在打开任务时订阅）；断开时记下缺的步数，重连后一次补上、不重复
        if (!viewingHl(t)) { hl.nextStepAt = null; continue; }
        if (hl.nextStepAt == null) hl.nextStepAt = now + T.hlTick;
        if (now >= hl.nextStepAt) {
          hl.nextStepAt = now + T.hlTick;
          if (hl.stream !== 'open') { hl.missed++; continue; }
          if (hl.cancel === 'canceling') continue;
          hl.step++;
          if (hl.step >= STEPS_DONE) finishRun(t, 'failed'); else P.dirty();
        }
      }
    },
  });
  P.hook('scenario', (k, v) => {
    const t = world.tasks.find((x) => x.headless && x.state === 'running' && !(x.hl && x.hl.outcome));
    if (!t) return;
    const hl = hlOf(t);
    if (k === 'hl-stream' && v === 'drop' && hl.stream === 'open') { hl.stream = 'reconnecting'; hl.attempt = 1; P.dirty(); P.clock.wake(); }
    if (k === 'hl-stream' && v === 'ok' && hl.stream !== 'open') reconnect(t);
    if (k === 'hl-end' && v === 'fail') { P.scenario.reset('hl-end'); finishRun(t, 'failed'); }
  });
  function reconnect(t) {
    const hl = hlOf(t);
    hl.stream = 'open'; hl.attempt = 0;
    // 补上断开期间缺的那一截（按序号续，不重复不丢）
    while (hl.missed > 0 && hl.step < STEPS_DONE - 1) { hl.step++; hl.missed--; }
    hl.missed = 0;
    if (P.scenario.is('hl-stream', 'drop')) P.scenario.set('hl-stream', 'ok');
    P.announce('事件流已重新连上，补上了断开期间的输出');
    P.dirty();
  }
  P.views['tpl-task-headless'] = {
    wire(main, r) {
      const t = P.task(r.taskId); if (!t) return;
      const hl = hlOf(t);
      // 第五段（R2-05）：稿件已回改——role="log" 挂在外层可滚动的 .hl-log 上、<ul> 保持列表（f-sbx-headless-01…05），模板同源拷过来就对，运行时补丁删掉
      if (hl.cancel === 'confirming') hl.cancel = 'idle';
      const end = $('.hl-bar__end', main);
      if (end) { const btn = $('.btn', end); btn.dataset.action = 'hl-cancel'; btn.dataset.task = t.id; btn.dataset.fk = 'hl-cancel'; }
    },
    refresh(host, r) {
      const t = P.task(r.taskId); if (!t) return;
      const hl = hlOf(t);
      const main = $('#main', host);
      const bar = $('.hl-bar', main);
      // 输出栏右侧：剩余时间 + [终止任务]（行内确认期间不动它）；本轮结束后整段去掉
      let end = $('.hl-bar__end', bar);
      if (hl.outcome) { if (end) end.remove(); }
      else {
        if (!end) { end = document.createElement('div'); end.className = 'hl-bar__end'; end.innerHTML = `<span class="hl-bar__deadline"></span><button class="btn btn--secondary btn--28" type="button" data-action="hl-cancel" data-task="${t.id}" data-fk="hl-cancel">终止任务</button>`; bar.appendChild(end); }
        const dl = $('.hl-bar__deadline', end);
        const txt = deadlineText(t);
        if (dl.textContent !== txt) dl.textContent = txt;
        dl.classList.toggle('tone-warn', t.leftMin <= 0);
      }
      // 连接条（重连中 / 已断开）
      const want = hl.outcome ? null : hl.stream === 'reconnecting' ? 'tpl-hl-reconnecting' : hl.stream === 'closed' ? 'tpl-hl-closed' : null;
      let conn = $('[data-hl-conn]', main);
      if (!want && conn) conn.remove();
      if (want) {
        if (!conn || conn.dataset.hlConn !== want) {
          if (conn) conn.remove();
          conn = P.fromTpl(want, { keepRoles: true });
          conn.dataset.hlConn = want;
          const b = $('.conn-bar__end .btn', conn); if (b) { b.dataset.action = 'hl-reconnect'; b.dataset.task = t.id; b.dataset.fk = 'hl-reconnect'; }
          bar.after(conn);
        }
        const title = $('.conn-bar__title', conn);
        if (want === 'tpl-hl-reconnecting' && title) title.textContent = `正在重连事件流…（第 ${hl.attempt} 次）；`;
      }
      // 输出流（只在条数变了时重画；用户没往上翻时跟随到底）
      const log = $('.hl-log', main);
      const list = $('.hl-log__list', log);
      const html = logHtml(t);
      if (list.dataset.html !== html) {
        const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
        const openNow = new Set($$('details[open]', list).map((d) => d.dataset.fk));
        list.innerHTML = html; list.dataset.html = html;
        for (const d of $$('details', list)) if (openNow.has(d.dataset.fk)) d.open = true;
        if (atEnd) log.scrollTop = log.scrollHeight;
      }
      log.classList.toggle('hl-log--end', !!hl.outcome);
      // 本轮结果（f-sbx-headless-04）或续接的发起表单
      let res = $('[data-hl-result]', main);
      const key = hl.outcome ? JSON.stringify([hl.outcome.code, hl.outcome.session, hl.launcher, hl.dl]) : null;
      if (!key && res) res.remove();
      if (key && (!res || res.dataset.key !== key)) {
        const next = hl.launcher ? launcherEl(t) : resultEl(t);
        next.dataset.hlResult = ''; next.dataset.key = key;
        // 第五段：表单换模式（续接 ↔ 全新，[改为全新会话]）时，已经写的指令、超时与 --verbose 带过去（现状也只是清掉 resumeFrom）
        const oldTa = res && $('#hl-prompt', res);
        if (oldTa && hl.launcher) {
          const ta = $('#hl-prompt', next); ta.value = oldTa.value;
          $('#hl-timeout', next).value = $('#hl-timeout', res).value; $('.hl-launch__check input', next).checked = $('.hl-launch__check input', res).checked;
        }
        if (res) res.replaceWith(next); else log.after(next);
        res = next;
        if (oldTa && hl.launcher) $('#hl-prompt', next).dispatchEvent(new Event('input', { bubbles: true })); // 计数与 [发起] 可用性跟着重算
      }
    },
  };
  function resultEl(t) {
    const o = hlOf(t).outcome;
    const el = P.fromTpl('tpl-hl-result');
    el.dataset.code = o.code;
    const title = $('.hl-result__title', el);
    title.className = `hl-result__title ${o.tone}`;
    title.innerHTML = `<span class="icon ${o.icon}" aria-hidden="true"></span>${esc(o.title)}`;
    $('.hl-result__exit', el).innerHTML = `退出码：${o.exit}`;
    $('.hl-result__advice', el).textContent = o.advice;
    const sec = $('.hl-result__section', el);
    if (!o.artifacts.length) sec.remove();
    else {
      const busy = hlOf(t).dl;
      $('.list', sec).innerHTML = o.artifacts.map((a, i) => `<li class="list__row"><span class="hl-artifact__name"><span class="icon ${a.icon}" aria-hidden="true"></span>${esc(a.name)}</span><span class="hl-artifact__meta"><span>${esc(a.size)}</span><span class="meta-sep" aria-hidden="true"></span><span>${esc(a.at)}</span></span><div class="list__end"><button class="btn btn--secondary btn--28" type="button" data-action="hl-download" data-task="${t.id}" data-i="${i}" data-fk="hl-dl-${i}"${busy === i ? ' aria-disabled="true" aria-busy="true"' : busy != null ? ' disabled' : ''}>${busy === i ? '下载中…' : '下载'}</button></div></li>`).join('');
    }
    const acts = $('.hl-result__actions', el);
    acts.innerHTML = `<button class="btn btn--secondary" type="button" data-action="hl-resume" data-task="${t.id}" data-fk="hl-resume"${o.session ? '' : ' disabled aria-describedby="hl-nosession"'}>接着聊（续接这轮会话）</button><button class="btn btn--tertiary" type="button" data-action="hl-new" data-task="${t.id}" data-fk="hl-new">发起全新任务</button>`;
    if (!o.session) acts.insertAdjacentHTML('afterend', '<p class="hl-result__advice" id="hl-nosession">这轮没有拿到会话引用（CLI 未上报 session-started），无法续接；可以发起一轮全新任务。</p>');
    $('.hl-result__code', el).innerHTML = `诊断码：<code>${esc(o.code)}</code>`;
    const head = $('.hl-result__head', el); head.removeAttribute('role');
    return el;
  }
  // [接着聊] / [发起全新任务] 打开的发起表单（REQ-SBX-035）：第五段起有稿 f-sbx-headless-06（tpl-hl-launch 同源拷贝）——标题随入口、
  // 续接时多一条「本次将续接上一轮会话（…）」+ [改为全新会话]；指令按码点计、8000 上限；超时档 30 分钟 / 1 / 2 / 4 小时（默认 2 小时）；--verbose；
  // 指令为空或超长时 [接着跑] / [发起无头任务] 不可用（能聚焦、说原因，同新建任务弹层）；[收起] 回结果区
  const HL_SESSION = '0199a6c3…4f2e'; // 示例会话引用（稿件同一串）
  function launcherEl(t) {
    const resume = hlOf(t).launcher === 'resume';
    const el = P.fromTpl('tpl-hl-launch');
    el.classList.add('proto-hl-launch');
    $('.hl-result__title', el).textContent = resume ? '接着聊（续接这轮会话）' : '发起无头运行';
    $('.nt-lead', el).innerHTML = `在同一个运行环境里再跑一轮无头运行${resume ? '，带上这一轮的会话引用' : ''}；<strong>不会新建任务</strong>，左侧树不变。`;
    const note = $('.hl-launch__resume', el);
    if (!resume) note.remove();
    else { $('code', note).textContent = HL_SESSION; Object.assign($('.link', note).dataset, { action: 'hl-new', task: t.id, fk: 'hl-fresh' }); }
    const ta = $('#hl-prompt', el); ta.value = ''; ta.textContent = ''; ta.dataset.fk = 'hl-prompt';
    $('#hl-count', el).textContent = `0/${MAX}`;
    $('#hl-timeout', el).dataset.fk = 'hl-timeout';
    const cb = $('.hl-launch__check input', el); cb.dataset.fk = 'hl-verbose';
    const [go, close] = $$('.hl-result__actions .btn', el);
    go.textContent = resume ? '接着跑（续接会话）' : '发起无头任务';
    Object.assign(go.dataset, { action: 'hl-launch', task: t.id, fk: 'hl-launch' });
    go.setAttribute('aria-disabled', 'true'); go.dataset.reason = '先写任务指令'; go.setAttribute('aria-describedby', 'hl-count');
    Object.assign(close.dataset, { action: 'hl-launch-close', task: t.id, fk: 'hl-launch-close' });
    return el;
  }
  // 指令计数与 [发起] 可用性（按码点、按提交的内容计，同 F-LCH-FORM）
  document.addEventListener('input', (e) => {
    if (!(e.target instanceof HTMLTextAreaElement) || e.target.id !== 'hl-prompt') return;
    const box = e.target.closest('.hl-launch'); if (!box) return;
    const n = P.cp(e.target.value.trim()).length, over = n > MAX;
    const count = $('#hl-count', box), go = $('[data-fk="hl-launch"]', box);
    count.className = over ? 'nt-counter nt-counter--error' : 'nt-counter';
    if (over) count.setAttribute('role', 'alert'); else count.removeAttribute('role');
    count.innerHTML = over ? `<span class="icon i-circle-alert" aria-hidden="true"></span>${n}/${MAX} —— 已超出上限，请精简后再发起` : `${n}/${MAX}`;
    e.target.classList.toggle('is-invalid', over);
    if (over) e.target.setAttribute('aria-invalid', 'true'); else e.target.removeAttribute('aria-invalid');
    const why = !n ? '先写任务指令' : over ? '指令超出上限，请精简后再发起' : null;
    if (why) { go.setAttribute('aria-disabled', 'true'); go.dataset.reason = why; } else { go.removeAttribute('aria-disabled'); delete go.dataset.reason; }
  });
  Object.assign(P.actions, {
    'hl-cancel': (a) => {
      const t = P.task(a.dataset.task); if (!t) return;
      const hl = hlOf(t);
      hl.cancel = 'confirming';
      // 终止只结束本轮、不删数据：行内确认（不进统一破坏性确认，gap-shared §8）
      P.inlineConfirm(a, {
        text: '终止后本轮无法恢复，确定？', confirm: '确认终止', cancel: '取消', label: '确认终止',
        onCancel: () => { hl.cancel = 'idle'; },
        onConfirm: (box) => {
          hl.cancel = 'canceling';
          P.inlineConfirm.pending(box, '正在终止…（两阶段强杀）');
          P.announce('正在终止…');
          P.clock.after(T.hlCancel, () => finishRun(t, 'killed'));
        },
      });
    },
    'hl-reconnect': (a) => { const t = P.task(a.dataset.task); if (t) { reconnect(t); P.focusMain(); } },
    'hl-resume': (a) => { const t = P.task(a.dataset.task); if (!t) return; hlOf(t).launcher = 'resume'; P.refreshMain(); const f = $('#hl-prompt'); if (f) f.focus(); },
    'hl-new': (a) => { const t = P.task(a.dataset.task); if (!t) return; hlOf(t).launcher = 'new'; P.refreshMain(); const f = $('#hl-prompt'); if (f) f.focus(); },
    'hl-launch-close': (a) => { const t = P.task(a.dataset.task); if (!t) return; hlOf(t).launcher = null; P.refreshMain(); const b = $('[data-fk="hl-resume"]:not([disabled])') || $('[data-fk="hl-new"]'); if (b) b.focus(); },
    'hl-launch': (a) => {
      const t = P.task(a.dataset.task); if (!t || a.getAttribute('aria-disabled') === 'true') return;
      const min = Number(($('[data-fk="hl-timeout"]') || {}).value || 120);
      // 新一轮：同一个运行环境、树上的任务不变；输出从头、剩余时间按新的超时档重新计
      t.hl = { step: 0, stream: 'open', attempt: 0, missed: 0, outcome: null, cancel: 'idle', nextStepAt: null, nextMinuteAt: null, launcher: null, dl: null };
      t.leftMin = min; t.timeoutMin = min;
      if (P.scenario.is('hl-stream', 'drop')) P.scenario.set('hl-stream', 'ok');
      P.announce('已发起新一轮无头运行');
      P.render(); P.focusMain(); P.clock.wake();
    },
    'hl-download': (a) => {
      const t = P.task(a.dataset.task); if (!t) return;
      const hl = hlOf(t);
      hl.dl = Number(a.dataset.i); // 下载中这一行写「下载中…」，其余 [下载] 暂不可点（AC-SBX-034.3）
      P.refreshMain();
      P.clock.after(1500, () => { hl.dl = null; P.dirty(); P.toast('neutral', '已开始下载', '原型不产生文件'); });
    },
  });

  // ================================================================== 深链 #new&project=<id>（REQ-LCH-009；f-lch-form-09，回落画面归 F-WB-ROUTE）
  P.hook('deeplink', (d) => {
    if (d.kind !== 'new-task' || !d.project) return; // 只带 #new、没带项目：不算深链，什么都不做
    const p = P.proj(d.project);
    if (!p) {
      ui.notice = { key: 'overview', kind: 'missing', title: P.missingTitle ? P.missingTitle('project', d.project) : '找不到这个项目：可能已被删除。', fresh: true }; // 同 REQ-WB-040 那一套句子（第四段）
      if (ui.route.view === 'overview') { P.refreshMain(); P.announce(ui.notice.title); } else P.replaceRoute('overview');
      return;
    }
    if (p.status !== 'ready') {
      const title = p.status === 'cloning' ? `「${p.name}」还在克隆，克隆完成后才能发起任务。` : `「${p.name}」克隆失败了，重试克隆或改为空项目之后才能发起任务。`;
      ui.notice = { key: `project:${p.id}`, title, icon: 'i-info', fresh: true, closable: true };
      P.replaceRoute(`project-${p.id}`);
      return;
    }
    const t = P.latestTask(p.id);
    P.replaceRoute(t ? `task-${t.id}` : `project-${p.id}`);
    P.openNewTask(p.id, null, { deepLink: true });
  });
})();
