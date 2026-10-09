/*
 * 交互原型 · 镜像（js/flows-img.js）：L4 六个流程（第二段接线）
 *   F-IMG-REGISTER  注册新镜像：验证（只读预检）→ 通过 / 有警告可保存 / 无效不可保存；格式错就地提示、改地址即作废；已注册 → [定位到该镜像]；镜像要求侧弹层
 *   F-IMG-ENV       运行参数：卡内行内编辑、Secret 不回显、四类预检标在出错那一格、50 条上限写原因、保存一句
 *   F-IMG-VERSION   版本：展开全串 / 复制、检查更新（解析中 / 已是最新 / 有新版本 → 提示条 + 对比弹层 → 更新到新版本）、重新验证、切换到此版本
 *   F-IMG-STATE     禁用（乐观、停用色调）/ 启用（启用中…）/ 删除（只给自定义镜像；被任务引用 → 打开即拦 + [改为禁用]）
 *   F-IMG-PRESET    预制镜像下载到本机（暂行入口 DR-36）：准备 → 进度（有分母 / 进度未知）→ 完成重新检测 / 失败留阶段句 + 出路
 *   F-IMG-PAGE      镜像页的空与加载：直开本页骨架；一张都没有（开机播种失败）的空态；过滤后为空另一句；列表读不到（不冒充「没有镜像」）+ [重试]
 * 标记来源：P7（tpl-images 的页头、工具行、卡片类名）+ gap/drafts/f-img-*（index.html 的 tpl-img-* 模板，build-proto.cjs 同源拷贝）；
 *           卡片按 P7 同一套类名由本文件按数据画（逐段比对，没变的段不重画——编辑器里的输入、焦点都留着）。
 * 从失败任务跳来的「来源提示」与定位那个任务用的镜像卡在 flows-lch.js（F-SBX-RELAUNCH 的 'view:wired' 钩子），本文件重画时保住它加的定位环与徽标。
 * 产品口径：gap/product/IMG.md（AC 的 Then）；接线要点：gap/drafts/notes/img-a.md §9、img-b.md §9；待定问题按 open-questions 的默认（Q-IMG-07 A…）。
 * 2026-10-04 用户拍板（原话「补全 10 条按推荐」）：Q-IMG-04 A 禁用预制镜像先弹一步非破坏性确认（f-img-state-04）；Q-IMG-06 A 徽标与正文统一写「预制」；
 *   Q-IMG-03 C 运行参数随版本、更新时继承（本来就是，没改）；Q-LCH-03 B「谁在用这一版」按任务记下的镜像算（t.image，flows-lch.js）。
 */
(function () {
  'use strict';
  const P = window.P;
  const { $, $$, esc, ui } = P;
  const world = P.world;
  const T = P.TIMING;

  // ------------------------------------------------------------------ 场景
  const G = '镜像';
  P.scenario.define({ key: 'img-load', group: G, label: '镜像页读取', def: 'ok', options: [['ok', '正常'], ['slow', '每次进入先出骨架'], ['empty', '一张镜像都没有（开机播种失败）'], ['fail', '读不到（骨架之后出读取失败，[重试] 后复位）']] });
  P.scenario.define({ key: 'img-check', group: G, label: '[检查更新] 的结果', def: 'auto', options: [['auto', 'ml-agent 上游有新版本，其余已是最新'], ['invalid', 'ml-agent 上游新版本无效'], ['gone', '下载源上已经找不到这个 tag'], ['fail', '连不上镜像下载源']] });
  P.scenario.define({ key: 'img-revalidate', group: G, label: '[重新验证] 的结果', def: 'auto', options: [['auto', '按各自的结论（just-registered 判为无效）'], ['upstream', 'tag 已经指向另一版（结论不改）'], ['fail', '请求失败']] });
  P.scenario.define({ key: 'img-preset', group: G, label: '预制镜像在本机', def: 'staged', options: [['staged', '已下载到本机'], ['missing', '还没下载到本机（出「下载到本机」块）'], ['fail', '还没下载，且下载会失败（校验 sha256 对不上）']] });
  P.scenario.define({ key: 'img-env', group: G, label: 'ml-agent 的运行参数', def: 'normal', options: [['normal', '3 条（示例世界）'], ['51', '51 条（超过上限的防御态）']] });
  // 第五段（W4，评审 R2-34②）：注册弹层里预检请求本身失败（REQ-IMG-008；f-img-register-06）——按地址演示结论之外的两种请求失败
  P.scenario.define({ key: 'img-register', group: G, label: '下一次注册 [验证]', once: true, def: 'ok', options: [['ok', '照常（按地址演示结论）'], ['unreachable', '连不上镜像下载源（REGISTRY_UNREACHABLE，可重试）'], ['notfound', '下载源上没有这个名字或版本（REF_NOT_FOUND，不给重试）']] });

  P.scenario.define({ key: 'img-alias-save', group: G, label: '下一次保存镜像别名', once: true, def: 'ok', options: [['ok', '保存成功'], ['fail', '保存失败（保留草稿）']] });

  // ------------------------------------------------------------------ 数据与派生（notes/img-a.md §9.0、img-b.md §9.0）
  const short = (d) => (d ? `${d.slice(0, 12)}…${d.slice(-3)}` : '');
  const img = (id) => world.images.find((i) => i.id === id);
  P.image = img;
  let seq = 0;
  for (const i of world.images) { i.seq = ++seq; i.alias = i.alias || null; } // 注册先后（同组新注册的在前）
  // 引用卡面这一版、还没销毁的任务（含已停止，DR-19）：按任务记下的镜像算（t.image = 发起那一刻锁定的那一版，flows-lch.js；2026-10-04 Q-LCH-03 B 之后新建任务也能选这张）
  const usedBy = (i) => world.tasks.filter((t) => t.image && t.image.id === i.id && t.image.digest === i.face.digest && t.state !== 'destroying');
  const RANK = { valid: 0, warning: 1, invalid: 2 };
  const ordered = () => world.images.slice().sort((a, b) => RANK[a.face.status] - RANK[b.face.status] || b.seq - a.seq);
  P.imagesOrdered = ordered; // 新建任务「镜像」一栏的选项顺序同镜像页（flows-lch.js）
  const envSummary = (env) => (env && env.length ? env.map((e) => `${e.key}=${e.secret ? '***' : e.value}`).join(' · ') : '（未配置）');
  const titleId = (i) => ({ sandbox: 'p7-img-sandbox', 'ml-agent': 'p7-img-ml', 'just-registered': 'p7-img-just' }[i.id] || `p7-img-${i.id}`);
  const SCOPE = '只影响之后新建的任务；已经建好的任务继续用各自建的时候锁定的那一版。';
  const WORKDIR_REASON = '镜像没有声明工作目录（WorkingDir）：平台不知道把代码放在哪儿。';
  P.presetImageStaged = () => { const s = world.images.find((i) => i.builtin); return !!(s && s.preset && s.preset.staged); }; // 诊断第 ⑧ 项（L5）读它

  // 场景改数据
  let emptyStash = null, env51Stash = null;
  function applyImgScenario(k) {
    if (k === 'img-load') {
      if (P.scenario.is('img-load', 'empty') && !emptyStash) { emptyStash = world.images.splice(0); }
      else if (!P.scenario.is('img-load', 'empty') && emptyStash) { world.images.push(...emptyStash); emptyStash = null; }
    }
    if (k === 'img-preset') {
      const s = world.images.find((i) => i.builtin) || (emptyStash || []).find((i) => i.builtin);
      if (s && s.preset && !s.preset.run) s.preset.staged = P.scenario.is('img-preset', 'staged');
    }
    if (k === 'img-env') {
      const m = img('ml-agent'); if (!m) return;
      if (P.scenario.is('img-env', '51') && !env51Stash) {
        env51Stash = m.face.env;
        m.face.env = [{ key: 'LOG_LEVEL', value: 'info' }, { key: 'MY_SECRET', value: '', secret: true }, { key: 'HTTP_TIMEOUT', value: '30' }]
          .concat(Array.from({ length: 48 }, (_, n) => ({ key: `FEATURE_FLAG_${String(n + 1).padStart(2, '0')}`, value: ['on', 'on', 'off'][n % 3] })));
      } else if (!P.scenario.is('img-env', '51') && env51Stash) { m.face.env = env51Stash; env51Stash = null; }
    }
    P.render();
  }
  P.hook('scenario', (k) => { if (k.startsWith('img-')) applyImgScenario(k); });

  // ------------------------------------------------------------------ 页面状态（每次进入镜像页复位；定位环保留到下一次定位或离开本页，Q-IMG-07 A）
  const ip = { load: 'ok', filter: 'all', query: '', expanded: {}, busy: {}, switching: null, env: null, alias: null, located: null, pendingFilter: null };
  const FILTER_KEYS = ['all', 'valid', 'warning', 'invalid'];
  P.hook('params', (token, params) => { if (token === 'images' && FILTER_KEYS.includes(params.filter)) ip.pendingFilter = params.filter; }); // #images&filter=warning（REQ-WB 路由深链，现状 /settings/images?filter=warning）
  const frag = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; };

  // ------------------------------------------------------------------ 卡片（P7 同一套标记；f-img-state-01 已禁用、f-img-version-01…04、f-img-preset-01…03）
  function verdictHtml(i, busy) {
    const f = i.face;
    const [cls, icon, word, tail] = f.status === 'valid' ? ['badge--ok', 'i-check', '验证通过', '镜像可用'] : f.status === 'warning' ? ['badge--warn', 'i-triangle-alert', '有警告', '镜像仍可用'] : ['badge--fail', 'i-x', '无效', '镜像不符合平台约定'];
    const spin = busy ? P.fromTpl('tpl-img-busy', { keepRoles: true }).outerHTML : ''; // f-img-version-02：结论行末尾「重新验证中…」
    const bullets = f.reasons && f.reasons.length ? `<ul class="bullets">${f.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '';
    const sheetOpen = P.sheet.isOpen('img-req'); // 卡片重画时触发按钮跟着侧弹层的开合（带 aria-controls，关掉时 P.sheet.close 能找到它）
    const req = f.status === 'invalid' ? `<button class="btn btn--secondary btn--32" type="button" aria-expanded="${sheetOpen}"${sheetOpen ? ' aria-controls="img-req"' : ''} data-action="img-req" data-fk="img-req:${i.id}">查看镜像要求</button>` : '';
    return `<div class="p7-verdict" data-status="${f.status}"><div class="p7-verdict__line${busy ? ' l4b-verdict__line--busy' : ''}"><span class="badge badge--20 ${cls}"><span class="icon ${icon}" aria-hidden="true"></span>${word}</span><span>${tail}</span>${spin}</div>${bullets}${req}</div>`;
  }
  function headHtml(i) {
    const state = i.active ? '<span class="badge badge--ok" data-testid="enable-state"><span class="icon i-check" aria-hidden="true"></span>已启用</span>' : '<span class="badge badge--inactive" data-testid="enable-state"><span class="icon i-square-filled" aria-hidden="true"></span>已禁用</span>';
    // 按版本直接注册（坐标带 @sha256:…、没有 tag）：卡上标一句，[检查更新] 置灰时指向它（REQ-IMG-021；没有稿件，用中性徽标）
    const byDigest = i.byDigest ? `<span class="badge badge--20 badge--neutral" id="img-bydigest-${i.id}">按版本直接注册（没有 tag）</span>` : '';
    return `<div class="card__head p7-card-head"><div class="card__head-main"><div class="p7-name"><h3 class="card__title card__title--14" id="${titleId(i)}">${esc(i.name)}</h3><span class="badge badge--20 badge--neutral">${i.builtin ? '预制' : '自定义'}</span>${byDigest}<button class="btn btn--tertiary btn--24" type="button" data-action="img-alias" data-img="${i.id}" data-fk="img-alias:${i.id}">编辑别名</button></div><span class="p7-ref">${esc(i.ref)}</span></div>${state}</div>`;
  }
  function kvHtml(i) {
    const f = i.face;
    const open = !!ip.expanded[i.id];
    const digest = open
      ? `<span class="text-mono-13 l4b-digest-full" data-testid="pinned-digest">${esc(f.digest)}</span><button class="link link--muted" type="button" aria-expanded="true" data-action="img-expand" data-img="${i.id}" data-fk="img-expand:${i.id}">收起</button>`
      : `<span class="text-mono-13">${esc(short(f.digest))}</span><button class="link link--muted" type="button" aria-expanded="false" data-action="img-expand" data-img="${i.id}" data-fk="img-expand:${i.id}">展开全串</button>`;
    return `<dl class="kv"><dt>适用：</dt><dd>${esc(f.runtimes)}</dd><dt>运行的版本：</dt><dd class="p7-identity" data-testid="image-identity-row">${digest}<button class="link link--muted" type="button" aria-label="复制版本号" data-action="img-copy" data-img="${i.id}" data-fk="img-copy:${i.id}">复制</button><span class="p7-identity__time"><span class="meta-sep" aria-hidden="true"></span>解析于 ${esc(f.resolved)}</span></dd><dt>来源：</dt><dd data-testid="image-lineage">${esc(f.lineage)}</dd></dl>`;
  }
  function upstreamHtml(i) {
    const n = P.fromTpl('tpl-img-upstream');
    $('.text-mono-13', n).textContent = short(i.upstream.digest);
    const l = $('.l4b-upstream__link', n); Object.assign(l.dataset, { action: 'img-check', img: i.id, fk: `img-upstream:${i.id}`, via: 'note' });
    return n.outerHTML;
  }
  function btnRowHtml(i) {
    const b = ip.busy[i.id];
    const btn = (label, action, extra = '', busyLabel = null) => busyLabel
      ? `<button class="btn btn--secondary btn--32 is-loading" type="button" aria-disabled="true" aria-busy="true" data-fk="img-${action}:${i.id}"><span class="icon icon--spin i-loader-circle" aria-hidden="true"></span>${busyLabel}</button>` // 第五段（R1-03）：进行中 aria-busy，不用原生 disabled
      : `<button class="btn btn--secondary btn--32" type="button"${extra} data-action="img-${action}" data-img="${i.id}" data-fk="img-${action}:${i.id}">${label}</button>`;
    const check = i.byDigest
      ? `<button class="btn btn--secondary btn--32" type="button" aria-disabled="true" aria-describedby="img-bydigest-${i.id}" data-reason="这张镜像是直接按版本注册的（没有 tag），所以不会有新版本" data-fk="img-check:${i.id}">检查更新</button>` // 置灰不隐藏，说原因（DR-39）
      : btn('检查更新', 'check', '', b === 'check' ? '解析中…' : null);
    let h = check + btn('重新验证', 'revalidate', '', b === 'revalidate' ? '重新验证中…' : null);
    h += i.active ? `<button class="btn btn--secondary btn--32" type="button" data-action="img-disable" data-img="${i.id}" data-fk="img-toggle:${i.id}">禁用</button>`
      : b === 'enable' ? `<button class="btn btn--secondary btn--32 is-loading" type="button" aria-disabled="true" aria-busy="true" data-fk="img-toggle:${i.id}"><span class="icon icon--spin i-loader-circle" aria-hidden="true"></span>启用中…</button>`
        : `<button class="btn btn--secondary btn--32" type="button" data-action="img-enable" data-img="${i.id}" data-fk="img-toggle:${i.id}">启用</button>`;
    if (!i.builtin) h += `<button class="btn btn--danger-tertiary btn--32" type="button" aria-haspopup="dialog" data-action="img-delete" data-img="${i.id}" data-fk="img-delete:${i.id}">删除</button>`;
    return `<div class="btn-row">${h}</div>`;
  }
  function historyHtml(i) {
    if (!i.history.length) return '';
    const many = i.history.length > 1;
    const badge = (st) => (st === 'valid' ? '<span class="badge badge--20 badge--ok"><span class="icon i-check" aria-hidden="true"></span>有效</span>' : st === 'warning' ? '<span class="badge badge--20 badge--warn"><span class="icon i-triangle-alert" aria-hidden="true"></span>有警告</span>' : '<span class="badge badge--20 badge--fail"><span class="icon i-x" aria-hidden="true"></span>无效</span>');
    const swBtn = (v, k, size) => {
      const fk = `img-switch:${i.id}:${k}`;
      if (ip.switching && ip.switching.id === i.id && ip.switching.k === k) return `<button class="btn btn--secondary ${size} is-loading" type="button" aria-disabled="true" aria-busy="true" data-fk="${fk}"><span class="icon icon--spin i-loader-circle" aria-hidden="true"></span>切换中…</button>`;
      // 判为无效的版本不能切过去（切了新任务都会被门口拒）：置灰并写原因（DR-39，AC-IMG-024.5）
      if (v.status === 'invalid') return `<button class="btn btn--secondary ${size}" type="button" aria-disabled="true" aria-describedby="img-swr-${i.id}-${k}" data-reason="这一版校验不通过，切过去新任务会被拒" data-fk="${fk}">切换到此版本</button><span class="l4b-reason" id="img-swr-${i.id}-${k}">这一版校验不通过，切过去新任务会被拒</span>`;
      return `<button class="btn btn--secondary ${size}" type="button" data-action="img-switch" data-img="${i.id}" data-k="${k}" data-fk="${fk}">切换到此版本</button>`;
    };
    const rows = i.history.map((v, k) => `<li class="p7-history__row" data-testid="image-version-row"><span class="text-mono-13">${esc(v.version)}</span><span class="text-mono-13 u-muted">${esc(short(v.digest))}</span>${badge(v.status)}${many ? swBtn(v, k, 'btn--28') : ''}</li>`).join('');
    // 只有一行时按钮放页脚右端（P7）；多行时每行行尾一个（img-b §9.1 给的写法，需看稿）
    return `<div class="card__footer"><div class="p7-history"><span class="p7-history__label"><span class="icon i-clock" aria-hidden="true"></span>历史版本（${i.history.length}）</span><ul class="p7-history__list" data-testid="image-version-history">${rows}</ul></div>${many ? '' : `<div class="card__footer-end">${swBtn(i.history[0], 0, 'btn--32')}</div>`}</div>`;
  }
  function paramsHead(i) {
    const open = !!(ip.env && ip.env.id === i.id);
    return `<div class="p7-params__head"><span class="icon-line icon-line--muted"><span class="icon i-wrench" aria-hidden="true"></span>运行参数</span><button class="btn btn--tertiary btn--24" type="button" aria-expanded="${open}"${open ? ` aria-controls="env-${i.id}"` : ''} data-action="img-env" data-img="${i.id}" data-fk="img-env:${i.id}">编辑环境变量</button></div>`;
  }
  // 逐段对比（键 = 生成的 HTML）：没变的段不碰
  function reconcile(box, items) {
    const want = items.map(([k, x]) => {
      if (x instanceof Element) { x.dataset.part = k; return x; }
      let el = $(`:scope > [data-part="${k}"]`, box);
      if (el && el.dataset.html === x) return el;
      const n = frag(x); n.dataset.part = k; n.dataset.html = x;
      // 从失败任务跳来时 flows-lch.js 在卡头加的「…用的镜像」徽标：卡头重画时带过去
      if (el && k === 'head') { const loc = $('.sbx-located', el); const nm = $('.p7-name', n); if (loc && nm) nm.appendChild(loc); }
      if (el) el.replaceWith(n);
      return n;
    });
    for (const el of [...box.children]) if (!want.includes(el)) el.remove();
    want.forEach((el, idx) => { if (box.children[idx] !== el) box.insertBefore(el, box.children[idx] || null); });
  }
  const cardEls = {}; // 本次进入镜像页的卡片元素（id → { art, body, params }）
  function paintCard(i) {
    let c = cardEls[i.id];
    if (!c || !c.art.isConnected) {
      const art = document.createElement('article');
      art.className = 'card card--lg';
      art.setAttribute('data-testid', 'image-card');
      const body = document.createElement('div'); body.className = 'card__body';
      const params = document.createElement('div'); params.className = 'card__inset p7-params';
      art.appendChild(body);
      c = cardEls[i.id] = { art, body, params };
    }
    const { art, body, params } = c;
    art.setAttribute('aria-labelledby', titleId(i));
    art.dataset.img = i.id; art.dataset.status = i.face.status; art.dataset.active = String(!!i.active);
    const items = [['head', headHtml(i)], ['verdict', verdictHtml(i, ip.busy[i.id] === 'revalidate')], ['kv', kvHtml(i)]];
    if (ip.alias && ip.alias.id === i.id) items.splice(1, 0, ['alias', ip.alias.el]);
    if (i.upstream) items.push(['upstream', upstreamHtml(i)]);
    if (i.preset && !i.preset.staged) items.push(['provision', provisionEl(i)]);
    // 运行参数块：头与摘要按数据画，编辑器元素常驻（输入、焦点不丢）
    reconcile(params, [['phead', paramsHead(i)], ['summary', `<span class="p7-params__summary" data-testid="env-summary">环境变量：${esc(envSummary(i.face.env))}</span>`]].concat(ip.env && ip.env.id === i.id ? [['editor', ip.env.el]] : []));
    items.push(['params', params], ['btns', btnRowHtml(i)]);
    reconcile(body, items);
    const title = document.getElementById(titleId(i)) || $('h3', body); if (title) title.textContent = i.alias || i.ref;
    const foot = historyHtml(i);
    const items2 = [['body', body]];
    if (foot) items2.push(['foot', foot]);
    reconcile(art, items2);
    return art;
  }

  // ------------------------------------------------------------------ 页面
  function stackOf(host) { return host && $('section[aria-labelledby="p7-list"] [data-img-list]', host); }
  function paintImages(host) {
    const sec = host && $('section[aria-labelledby="p7-list"]', host); if (!sec) return;
    let list = $('[data-img-list]', sec);
    const empty = !world.images.length;
    const state = ip.load === 'loading' ? 'loading' : ip.load === 'fail' ? 'fail' : empty ? 'empty' : 'ok';
    if (list.dataset.state !== state) {
      let el;
      if (state === 'loading') el = P.fromTpl('tpl-img-skeleton', { keepRoles: true });
      else if (state === 'fail') {
        // 列表读不到（REQ-IMG-052；第五段起按稿 f-img-page-03）：说清是「读不到」不是「没有」；不出空态句、不给注册 CTA
        el = P.fromTpl('tpl-img-load-fail', { keepRoles: true });
        const b = $('.note__end .btn', el); Object.assign(b.dataset, { action: 'img-retry-load', fk: 'img-retry-load' });
      } else if (state === 'empty') {
        // 一张都没有（f-img-page-01；只在开机播种失败时出现）：虚线框空态，两个按钮；说明句不承诺「镜像下拉」（REQ-IMG-051；第五段起稿件已改成同一句，不再在这里换字），稿注不进原型
        el = P.fromTpl('tpl-img-empty');
        const cn = $('.contract-note', el); if (cn) cn.remove();
        const [reg, req] = $$('.empty__actions .btn', el);
        Object.assign(reg.dataset, { action: 'img-register', fk: 'img-register-empty' });
        Object.assign(req.dataset, { action: 'img-req', fk: 'img-req:empty' });
      } else { el = document.createElement('div'); el.className = 'stack stack--16'; }
      el.dataset.imgList = ''; el.dataset.state = state;
      list.replaceWith(el); list = el;
    }
    // 页头 [注册新镜像]：空态里主按钮在空态卡上，页头降为次按钮（f-img-page-01）
    const reg = $('[data-fk="img-register"]', host);
    if (reg) { reg.classList.toggle('btn--primary', state !== 'empty'); reg.classList.toggle('btn--secondary', state === 'empty'); }
    const filtered = $('[data-testid="images-filtered-empty"]', host);
    if (state !== 'ok') { if (filtered) filtered.hidden = true; return; }
    // 重画会换掉变了的那一段（按钮文字、aria-expanded…）：焦点按 data-fk 找回（排序挪动了卡片也一样）；找回的按钮若进入忙态被禁用，就等结果出来再还（refocus）
    const a = document.activeElement, afk = a && a.getAttribute && a.getAttribute('data-fk');
    const want = ordered().map(paintCard);
    for (const el of [...list.children]) if (!want.includes(el)) el.remove();
    want.forEach((el, idx) => { if (list.children[idx] !== el) list.insertBefore(el, list.children[idx] || null); });
    if (afk && a !== document.activeElement) { const again = $(`[data-fk="${CSS.escape(afk)}"]`); if (again && !again.disabled && P.isShown(again)) again.focus({ preventScroll: true }); }
    applyFilter(host);
    P.upgradeTips(list);
  }
  // 状态过滤（分段）与搜索：前端就地过滤；过滤后为空是另一句话（不是空态、没有 CTA）
  function applyFilter(host) {
    const list = stackOf(host); if (!list || list.dataset.state !== 'ok') return;
    let n = 0;
    for (const i of world.images) {
      const art = cardEls[i.id] && cardEls[i.id].art; if (!art) continue;
      const text = `${i.alias || ''} ${i.name} ${i.ref} ${i.face.version || ''}`.toLowerCase();
      const ok = (ip.filter === 'all' || i.face.status === ip.filter) && (!ip.query || text.includes(ip.query));
      art.hidden = !ok;
      if (ok) n++;
    }
    const e = $('[data-testid="images-filtered-empty"]', host);
    if (e) e.hidden = n > 0;
    const seg = $('.segmented[aria-label="状态过滤"]', host);
    if (seg) for (const b of $$('.segmented__item', seg)) b.setAttribute('aria-pressed', String(b.dataset.imgFilter === ip.filter));
  }
  P.views['tpl-images'] = {
    wire(main) {
      for (const k of Object.keys(cardEls)) delete cardEls[k];
      Object.assign(ip, { load: 'ok', filter: ip.pendingFilter || 'all', query: '', expanded: {}, busy: {}, switching: null, env: null, alias: null, located: null });
      ip.pendingFilter = null;
      if (P.scenario.is('img-load', 'slow') || P.scenario.is('img-load', 'fail')) {
        // 先骨架；「读不到」是骨架之后才出读取失败（重试用完，AC-IMG-052.1）
        ip.load = 'loading';
        const key = P.viewKey();
        const fail = P.scenario.is('img-load', 'fail');
        P.clock.after(T.imgLoad, () => { if (P.viewKey() !== key) return; ip.load = fail ? 'fail' : 'ok'; P.render(); P.announce(fail ? '镜像列表没能加载出来' : '镜像列表已读取'); });
      }
      const reg = $('.header__actions .btn', main.closest('#shell-main')); // 页头在 <main> 外面
      Object.assign(reg.dataset, { action: 'img-register', fk: 'img-register' });
      // P7 的分段与搜索：按数据过滤
      const seg = $('.segmented[aria-label="状态过滤"]', main);
      $$('.segmented__item', seg).forEach((b, k) => { b.dataset.imgFilter = FILTER_KEYS[k]; b.dataset.fk = `img-f-${FILTER_KEYS[k]}`; });
      seg.addEventListener('click', (e) => { const b = e.target.closest('.segmented__item'); if (!b) return; e.stopPropagation(); ip.filter = b.dataset.imgFilter; applyFilter($('#shell-main')); });
      const input = $('input[type="search"]', main);
      input.dataset.fk = 'img-search'; input.placeholder = '搜索镜像别名、名称或坐标';
      input.addEventListener('input', () => { ip.query = input.value.trim().toLowerCase(); applyFilter($('#shell-main')); });
      const stack = $('section[aria-labelledby="p7-list"] .stack', main);
      const empty = document.createElement('p');
      empty.className = 'page-desc';
      empty.setAttribute('data-testid', 'images-filtered-empty');
      empty.textContent = '没有符合当前搜索/过滤条件的镜像。';
      empty.hidden = true;
      stack.before(empty);
      stack.textContent = ''; stack.dataset.imgList = ''; stack.dataset.state = 'ok';
      main.addEventListener('input', onEnvInput);
      main.addEventListener('change', onEnvChange);
      paintImages(main.closest('#shell-main'));
      if (ip.registerOnEnter) { ip.registerOnEnter = false; requestAnimationFrame(() => P.openRegisterImage($('[data-fk="img-register"]'))); }
    },
    refresh(host) { paintImages(host); },
  };
  // 直接打开 #images（含刷新）：页头与工具行照常，列表位置是两张卡片骨架（f-img-page-02；F-WB-SHELL 的路由规则）
  P.hook('loading.tpl', (r) => (r.view === 'images' ? 'tpl-images' : undefined));
  P.hook('loading:wired', (tplId, main) => {
    if (tplId !== 'tpl-images') return;
    const stack = $('section[aria-labelledby="p7-list"] .stack', main);
    stack.replaceWith(P.fromTpl('tpl-img-skeleton', { keepRoles: true }));
  });
  P.hook('route', (r, changed) => { if (changed && r.view !== 'images' && P.sheet.isOpen('img-req')) P.sheet.close(); });
  // [重试]（读取失败条）：回到骨架 → 这次读到了，回到正常列表（AC-IMG-052.2）；场景复位，焦点落搜索框
  P.actions['img-retry-load'] = () => {
    ip.load = 'loading'; P.render();
    const key = P.viewKey();
    P.clock.after(T.imgRetry, () => {
      if (P.viewKey() !== key) return;
      ip.load = 'ok';
      if (P.scenario.is('img-load', 'fail')) P.scenario.reset('img-load'); // reset 不发 'scenario'，下面自己重画
      P.render();
      const s = $('[data-fk="img-search"]'); if (s) s.focus({ preventScroll: true });
      P.announce('镜像列表已读取');
    });
  };
  // 定位到一张卡（[定位到该镜像]）：先清搜索、过滤回「全部」，滚到那张卡，焦点色环保留到下一次定位或离开本页，焦点落卡
  function locate(id) {
    ip.filter = 'all'; ip.query = '';
    const s = $('[data-fk="img-search"]'); if (s) s.value = '';
    P.render();
    for (const a of $$('#shell-main article.is-current')) a.classList.remove('is-current');
    const art = cardEls[id] && cardEls[id].art; if (!art) return;
    art.classList.add('is-current'); art.tabIndex = -1;
    art.scrollIntoView({ block: 'center' });
    art.focus({ preventScroll: true });
    P.announce(`已定位到 ${img(id).name}`);
  }


  // ------------------------------------------------------------------ 别名：整张镜像共用，不改 ref、版本、启用状态；卡头独立行内编辑。
  function repositoryOf(ref) {
    if (ref.includes('@')) return ref.slice(0, ref.indexOf('@'));
    const at = ref.lastIndexOf(':'); return at > ref.lastIndexOf('/') ? ref.slice(0, at) : ref;
  }
  function aliasCheck(raw) {
    if (/[\p{Cc}\u2028\u2029]/u.test(raw)) return { error: '别名不能包含控制字符或换行。' };
    const value = raw.trim();
    if (Array.from(value).length > 64) return { error: '别名最多 64 个字符。' };
    return { value: value || null };
  }
  function setRepositoryAlias(image, value) {
    for (const i of world.images) if (i.name === image.name) i.alias = value;
  }
  function aliasField(id, labelText) {
    const field = document.createElement('div'); field.className = 'field';
    const label = document.createElement('label'); label.className = 'field__label'; label.htmlFor = id; label.textContent = labelText;
    const labelRow = document.createElement('div'); labelRow.className = 'image-alias-editor__label';
    const count = document.createElement('span'); count.className = 'u-muted'; count.id = `${id}-count`; count.textContent = '0/64'; labelRow.append(label, count);
    const input = document.createElement('textarea'); input.className = 'input'; input.id = id; input.rows = 1; input.spellcheck = false; input.autocomplete = 'off'; input.dataset.aliasInput = ''; input.dataset.fk = id;
    const help = document.createElement('p'); help.className = 'field__help'; help.textContent = '仅用于显示和搜索，不改变镜像地址；留空显示真实坐标。';
    const error = document.createElement('p'); error.className = 'field__error'; error.id = `${id}-error`; error.setAttribute('role', 'alert'); error.hidden = true;
    input.setAttribute('aria-describedby', `${count.id} ${error.id}`);
    field.append(labelRow, input, help, error);
    return { field, input, count, error };
  }
  function aliasError(parts, message) {
    parts.count.textContent = `${Array.from(parts.input.value.trim()).length}/64`;
    parts.error.textContent = message || ''; parts.error.hidden = !message;
    parts.input.classList.toggle('is-invalid', !!message); if (message) parts.input.setAttribute('aria-invalid', 'true'); else parts.input.removeAttribute('aria-invalid');
  }
  P.actions['img-alias'] = el => {
    const i = img(el.dataset.img); if (!i || (ip.alias && ip.alias.busy)) return;
    const editor = document.createElement('div'); editor.className = 'card__inset image-alias-editor'; editor.id = 'alias-form';
    const parts = aliasField('alias-draft', '镜像别名'); parts.input.value = i.alias || '';
    const controls = document.createElement('fieldset'); controls.style.border = '0'; controls.style.padding = '0'; controls.style.minWidth = '0'; controls.appendChild(parts.field);
    const row = document.createElement('div'); row.className = 'btn-row';
    const make = (label, action, id) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn btn--secondary btn--32'; b.textContent = label; b.dataset.action = action; b.dataset.fk = action; if (id) b.id = id; return b; };
    const save = make('保存别名', 'img-alias-save', 'save-alias'), cancel = make('取消', 'img-alias-cancel', 'cancel-alias'), clear = make('清除别名', 'img-alias-clear', 'clear-alias');
    save.classList.replace('btn--secondary', 'btn--primary'); row.append(save, cancel, clear); editor.append(controls, row);
    const state = ip.alias = { id: i.id, el: editor, controls, parts, save, cancel, clear, busy: false, original: i.alias };
    const validateDraft = () => { const result = aliasCheck(parts.input.value); aliasError(parts, result.error); save.disabled = !!result.error; };
    parts.input.addEventListener('input', validateDraft); validateDraft();
    P.render(); requestAnimationFrame(() => { if (ip.alias === state) parts.input.focus({ preventScroll: true }); });
  };
  P.actions['img-alias-cancel'] = () => { const a = ip.alias; if (!a || a.busy) return; ip.alias = null; P.render(); requestAnimationFrame(() => { const b = $(`[data-fk="img-alias:${a.id}"]`); if (b && P.isShown(b)) b.focus({ preventScroll: true }); else { const search = $('[data-fk="img-search"]'); if (search) search.focus({ preventScroll: true }); } }); };
  P.hook('escape', () => { const a = ip.alias; if (!a || P.topModal()) return undefined; if (!a.busy) P.actions['img-alias-cancel'](); return true; });
  P.actions['img-alias-clear'] = () => { const a = ip.alias; if (!a || a.busy) return; a.parts.input.value = ''; aliasError(a.parts); a.save.disabled = false; a.parts.input.focus({ preventScroll: true }); };
  P.actions['img-alias-save'] = () => {
    const a = ip.alias; if (!a || a.busy) return;
    const checked = aliasCheck(a.parts.input.value); aliasError(a.parts, checked.error);
    if (checked.error) { a.save.disabled = true; a.parts.input.focus({ preventScroll: true }); return; }
    a.busy = true; a.controls.disabled = true; a.cancel.disabled = a.clear.disabled = true; P.setBusy(a.save, true, P.busyHtml('保存中…'));
    P.clock.after(T.imgSave, () => {
      if (ip.alias !== a) return;
      a.busy = false; a.controls.disabled = false; a.cancel.disabled = a.clear.disabled = false; P.setBusy(a.save, false, '保存别名');
      if (P.scenario.take('img-alias-save') === 'fail') { aliasError(a.parts, '别名保存失败，请重试。'); P.announce('别名保存失败，输入已保留'); return; }
      const i = img(a.id); if (!i) return;
      setRepositoryAlias(i, checked.value); ip.alias = null; P.render(); P.toast('ok', checked.value ? '镜像别名已保存' : '镜像别名已清除');
      requestAnimationFrame(() => { const b = $(`[data-fk="img-alias:${a.id}"]`); if (b && P.isShown(b)) b.focus({ preventScroll: true }); else { const search = $('[data-fk="img-search"]'); if (search) search.focus({ preventScroll: true }); } });
    });
  };

  // ================================================================== F-IMG-REGISTER 注册弹层（f-img-register-01…04）与镜像要求侧弹层（05）
  const reg = { m: null };
  function fakeDigest(seed, pre, suf) {
    let h = 2166136261; let out = '';
    while (out.length < 64) { for (const ch of seed + out.length) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } out += h.toString(16).padStart(8, '0'); }
    out = out.slice(0, 64);
    if (pre) out = pre + out.slice(pre.length);
    if (suf) out = out.slice(0, 64 - suf.length) + suf;
    return `sha256:${out}`;
  }
  const BAD_CHARS = /[\s\u0000-\u001f\u007f​-‍⁠﻿]/;
  P.openRegisterImage = function openRegisterImage(returnTo) {
    const box = P.fromTpl('tpl-img-register', { keepRoles: true });
    box.dataset.dialog = 'register-image';
    box.removeAttribute('aria-describedby');
    const verdictTpl = $('.l4a-reg__verdict', box); verdictTpl.remove();
    const input = $('#reg-uri', box); input.value = ''; input.dataset.fk = 'reg-uri';
    const alias = aliasField('reg-alias', '镜像别名（可选）');
    alias.field.classList.add('image-alias-editor'); input.closest('.field').after(alias.field);
    alias.input.addEventListener('input', () => { const checked = aliasCheck(alias.input.value); aliasError(alias, checked.error); if (st.phase === 'idle') save.disabled = !!checked.error; const locate = $('#locate-existing-image', box); if (locate) locate.remove(); });
    const link = $('.l4a-reg__constraint .link', box); Object.assign(link.dataset, { action: 'img-req', fk: 'img-req:reg' }); link.setAttribute('aria-expanded', String(P.sheet.isOpen('img-req')));
    const cancel = $('.dialog__footer > .btn', box); cancel.dataset.rg = 'cancel'; cancel.dataset.fk = 'reg-cancel';
    const end = $('.dialog__footer-end', box);
    const [validate, save] = $$('.btn', end);
    validate.dataset.rg = 'validate'; validate.dataset.fk = 'reg-validate'; validate.disabled = true;
    save.remove(); save.dataset.rg = 'save'; save.dataset.fk = 'reg-save';
    const st = { uri: '', validatedUri: null, result: null, phase: 'idle' };
    const m = P.openModal(box, { kind: 'register-image', returnTo, initialFocus: '#reg-uri' });
    reg.m = m;
    const body = $('.dialog__body', m.box);
    const clearAfterNote = () => { for (const el of $$('.l4a-reg__verdict, .l4a-reg__stale, [data-testid="duplicate-hint"], [data-rg="fail"]', body)) el.remove(); };
    function paintInput() {
      const v = input.value.trim();
      const oldLocate = $('#locate-existing-image', box); if (oldLocate) oldLocate.remove();
      aliasError(alias, aliasCheck(alias.input.value).error);
      // 格式就地提示（REQ-IMG-004）：前端只提前说、不放宽，[验证] 照样可点
      const bad = !!v && BAD_CHARS.test(v);
      let e = $('#reg-uri-error', body);
      if (bad && !e) { e = P.fromTpl('tpl-img-uri-error', { keepRoles: true }); input.after(e); P.announce('镜像地址不能包含空格、换行或不可见字符。'); }
      else if (!bad && e) e.remove();
      input.classList.toggle('is-invalid', bad);
      if (bad) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', 'reg-uri-error'); } else { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
      // 改地址即作废结论：整块清掉、[保存] 消失、原位一句；改回原值也不复活
      if (st.result && v !== st.validatedUri) {
        st.result = null; st.validatedUri = null;
        clearAfterNote();
        const s = P.fromTpl('tpl-img-stale'); body.appendChild(s);
        if (save.isConnected) save.remove();
        P.announce('已修改镜像地址，请重新验证');
      }
      validate.disabled = !v || st.phase !== 'idle';
    }
    input.addEventListener('input', paintInput);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && !validate.disabled) { e.preventDefault(); doValidate(); } });
    function setBusy(on, which) {
      st.phase = on ? which : 'idle';
      m.busy = on; // 验证中 / 保存中：Esc、[取消]、点遮罩都不关，输入框只读（REQ-IMG-001 / 002）
      input.readOnly = on; alias.input.readOnly = on; cancel.disabled = on;
      // 第五段（R1-03）：进行中的那颗（[验证] / [保存]）用 aria-busy，焦点不丢；另一颗与「地址为空」照旧原生 disabled
      if (on && which === 'validating') P.setBusy(validate, true, P.busyHtml('验证中…'));
      else { P.setBusy(validate, false, '验证'); validate.disabled = on || !input.value.trim(); }
      if (save.isConnected) {
        if (on && which === 'saving') P.setBusy(save, true, P.busyHtml('保存中…'));
        else { P.setBusy(save, false, '保存'); save.disabled = on || !!aliasCheck(alias.input.value).error; }
      }
    }
    function failNote(title, text, actionHtml, code) {
      // 预检 / 保存请求本身失败（REQ-IMG-008；第五段起按稿 f-img-register-06：.note--fail 原位说清，页脚按钮上方；稿件画的是 REGISTRY_UNREACHABLE + [重试]，其余码换标题、句子与动作）
      const n = P.fromTpl('tpl-img-reg-fail', { keepRoles: true });
      n.dataset.rg = 'fail'; n.dataset.code = code || '';
      if (title) $('.note__title', n).textContent = title;
      if (text) $('.note__text', n).textContent = text;
      const acts = $('.note__actions', n);
      if (actionHtml === undefined) { const b = $('.btn', acts); Object.assign(b.dataset, { rg: 'retry', fk: 'reg-retry' }); } // 稿件的 [重试]
      else if (actionHtml) acts.innerHTML = actionHtml; else acts.remove();
      return n;
    }
    function doValidate() {
      const v = input.value.trim(); if (!v || st.phase !== 'idle') return;
      clearAfterNote();
      if (save.isConnected) save.remove();
      st.result = null;
      setBusy(true, 'validating');
      P.announce('验证中…');
      P.clock.after(T.imgValidate, () => {
        if (!P.modals.includes(m)) return;
        setBusy(false);
        if (!world.images.some((i) => i.builtin)) {
          // 平台还没有预制镜像可作来源比对（开机播种失败，INVALID_STATE）
          body.appendChild(failNote('平台自己的预制镜像还没准备好', '这是平台的部署问题，不是你这张镜像的问题，不用改 Dockerfile。去系统状态看看诊断，按那里的下一步处理。', '<button class="btn btn--secondary btn--32" type="button" data-rg="system" data-fk="reg-system">查看系统状态</button>', 'INVALID_STATE'));
          P.announce('平台自己的预制镜像还没准备好'); return;
        }
        if (BAD_CHARS.test(v)) { body.appendChild(failNote('镜像地址里混进了空白或控制字符', '删掉地址里的空格、换行或看不见的字符，再点 [验证]。', null, 'INVALID_IMAGE_REFERENCE')); P.announce('镜像地址里混进了空白或控制字符'); return; }
        // 第五段（R2-34②）：请求本身失败——连不上镜像下载源（可重试，稿件 f-img-register-06 原样）/ 下载源上没有这个版本（不给重试）
        const req = P.scenario.take('img-register');
        if (req === 'unreachable') { body.appendChild(failNote(null, null, undefined, 'REGISTRY_UNREACHABLE')); P.announce('连不上镜像下载源'); return; }
        if (req === 'notfound') { body.appendChild(failNote('镜像下载源上没有这个名字或这个版本', '下载源能连上，但里面找不到它 —— 名字拼错了、版本被删了，或者这是个私有仓库而平台没有拉取凭证。重试帮不上忙：先确认名字与版本的拼写、以及这张镜像对平台可见，再重新验证。', null, 'REF_NOT_FOUND')); P.announce('镜像下载源上没有这个名字或这个版本'); return; }
        const existing = world.images.find((i) => i.ref === v);
        const status = /py-agent/.test(v) ? 'invalid' : /web-agent/.test(v) ? 'warning' : existing ? existing.face.status : 'valid';
        st.result = { status }; st.validatedUri = v;
        let vd;
        if (status === 'invalid') {
          vd = P.fromTpl('tpl-img-verdict-invalid', { keepRoles: true });
          const rb = $('.btn', vd); Object.assign(rb.dataset, { action: 'img-req', fk: 'img-req:verdict' }); rb.setAttribute('aria-expanded', String(P.sheet.isOpen('img-req')));
        } else {
          vd = verdictTpl.cloneNode(true);
          const pin = $('.l4a-pin', vd); if (pin) pin.remove(); // 「钉定」一行等预检接口回 digest（DR-11），不回复默认不显示
          if (status === 'valid') {
            vd.setAttribute('data-status', 'valid');
            const bd = $('.badge', vd); bd.className = 'badge badge--20 badge--ok'; bd.innerHTML = '<span class="icon i-check" aria-hidden="true"></span>验证通过';
            $('.p7-verdict__line > span:last-child', vd).textContent = '镜像可用';
            const ul = $('.bullets', vd); if (ul) ul.remove();
          }
          end.appendChild(save); setBusy(false);
        }
        body.appendChild(vd);
        P.announce(`验证结果：${status === 'valid' ? '验证通过，镜像可用' : status === 'warning' ? '有警告，镜像仍可用' : '无效，镜像不符合平台约定'}`);
      });
    }
    function doSave() {
      if (!st.result || st.phase !== 'idle' || st.result.status === 'invalid') return;
      const v = st.validatedUri;
      const checked = aliasCheck(alias.input.value); aliasError(alias, checked.error);
      if (checked.error) { alias.input.focus({ preventScroll: true }); return; }
      const repository = repositoryOf(v), sameRepository = world.images.find(i => i.name === repository);
      // 空输入表示省略 alias；同仓新 tag 也不能通过注册隐式改名。
      if (sameRepository && checked.value && checked.value !== (sameRepository.alias || null)) {
        aliasError(alias, '这张镜像已存在，注册新版本不能修改别名。请到镜像卡头编辑。');
        let locateButton = $('#locate-existing-image', box);
        if (!locateButton) { locateButton = document.createElement('button'); locateButton.id = 'locate-existing-image'; locateButton.className = 'link'; locateButton.type = 'button'; locateButton.textContent = '定位到该镜像'; locateButton.dataset.rg = 'locate'; locateButton.dataset.img = sameRepository.id; locateButton.dataset.fk = 'reg-locate-existing'; alias.field.appendChild(locateButton); }
        alias.input.focus({ preventScroll: true }); return;
      }
      setBusy(true, 'saving');
      P.announce('保存中…');
      P.clock.after(T.imgSave, () => {
        if (!P.modals.includes(m)) return;
        setBusy(false);
        const existing = world.images.find((i) => i.ref === v);
        if (existing) {
          // 已经注册过（按镜像 + 版本号幂等）：不当错误，就地提示 + [定位到该镜像]；结论与 [保存] 保留（REQ-IMG-005）
          const dup = P.fromTpl('tpl-img-dup', { keepRoles: true });
          $('.note__text', dup).textContent = `该镜像已注册（${existing.ref}，锁定在 ${short(existing.face.digest)}）。`;
          const lb = $('.note__end .btn', dup); lb.dataset.rg = 'locate'; lb.dataset.img = existing.id; lb.dataset.fk = 'reg-locate';
          const vd = $('.l4a-reg__verdict', body); vd.before(dup);
          P.announce(`该镜像已注册，锁定在 ${short(existing.face.digest)}`);
          return;
        }
        // 新建：弹层关闭、列表按排序出现新卡（已启用）、轻提示补一句
        // 坐标：仓库[:tag]，或仓库@sha256:<64 位>（按版本直接注册，没有 tag，锁定的就是给的那一版）
        const pin = /@(sha256:[0-9a-f]{64})$/i.exec(v);
        let name, tag;
        if (v.includes('@')) { name = v.slice(0, v.indexOf('@')); tag = null; }
        else { const at = v.lastIndexOf(':'); const slash = v.lastIndexOf('/'); name = at > slash ? v.slice(0, at) : v; tag = at > slash ? v.slice(at + 1) : 'latest'; }
        const status = st.result.status;
        const digest = pin ? pin[1].toLowerCase() : /web-agent/.test(v) ? fakeDigest(v, '5d8c4', 'f60') : fakeDigest(v);
        // P.newId 只查任务与项目：镜像自己找一个没被占的 id（含「一张都没有」场景暂存起来的那几张）
        let n = 1; const taken = (x) => world.images.some((y) => y.id === x) || (emptyStash || []).some((y) => y.id === x);
        while (taken(`img${n}`)) n++;
        const id = `img${n}`;
        world.images.push({ id, name, ref: v, alias: sameRepository ? sameRepository.alias || null : checked.value, builtin: false, active: true, byDigest: !tag, history: [], upstreamNext: null, seq: ++seq,
          face: { version: tag, digest, status, reasons: status === 'warning' ? ['未预装 claude-code，创建时需现装，启动会明显变慢'] : [], runtimes: status === 'warning' ? 'codex' : 'codex、claude-code', resolved: '刚刚', lineage: '从预制镜像 sha256:4b17e…344 改来的', env: [] } });
        P.closeModal(m);
        P.render();
        P.toast('ok', `已注册，锁定在 ${short(digest)}`);
      });
    }
    m.box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-rg]'); if (!b || b.disabled) return;
      const k = b.dataset.rg;
      if (k === 'cancel') { if (!m.busy) P.closeModal(m); }
      else if (k === 'validate') doValidate();
      else if (k === 'save') doSave();
      else if (k === 'locate') { P.closeModal(m, { restoreFocus: false }); locate(b.dataset.img); }
      else if (k === 'system') { P.closeModal(m, { restoreFocus: false }); P.go('system'); }
      else if (k === 'retry') { validate.focus({ preventScroll: true }); doValidate(); } // [重试] 就在失败句里，重新验证时这一句会清掉：焦点先交给 [验证]（随即进入「验证中…」）
    });
    return m;
  };
  P.actions['img-register'] = (el) => P.openRegisterImage(el);
  // ⌘K「注册新镜像…」（F-WB-CMDK 的动作之一）：先到镜像页再开同一个弹层（换页会关掉开着的弹层，所以等镜像页接好再开）
  P.hook('palette.items', () => [{ g: '动作', label: '注册新镜像…', meta: '镜像管理', keywords: '镜像 注册 image register', // 说明写去处（第四段 F-WB-CMDK，f-wb-cmdk-02）
     icon: '<span class="icon i-package" aria-hidden="true"></span>', run: (ret) => { if (P.ui.route.view === 'images' && !P.ui.loading) P.openRegisterImage(ret); else { ip.registerOnEnter = true; P.go('images'); } } }]);
  // 镜像要求（f-img-register-05）：侧弹层，无遮罩、不抢焦点、只有 [关闭] 能关；再点触发器复用已开的那个
  P.actions['img-req'] = (el) => {
    const tpl = P.fromTpl('tpl-img-sheet');
    const close = $('.sheet__close', tpl); Object.assign(close.dataset, { action: 'sheet-close', fk: 'img-req-close' });
    P.sheet.open(el, { id: 'img-req', label: '平台对镜像的要求', attrs: { 'data-testid': 'image-requirements-panel' }, html: tpl.innerHTML });
    P.announce('已在右侧打开「平台对镜像的要求」');
  };

  // ================================================================== F-IMG-ENV 运行参数（f-img-env-01…03）
  const RESERVED = new Set(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_CLIENT_ID', 'CODEX_CLIENT_SECRET', 'GIT_PRIVATE_KEY', 'SSH_PRIVATE_KEY', 'CLAUDE_CONFIG_DIR', 'HOME', 'KUBECONFIG', 'USER', 'PATH', 'PWD', 'DOCKER_HOST', 'DOCKER_CONFIG']);
  const ENV_MAX = 50, VALUE_MAX = 4096, KEY_MAX = 64;
  const bytes = (s) => new TextEncoder().encode(s || '').length;
  // 前端预检（与平台同名同句，REQ-IMG-012）：变量名非法 / 系统保留 / 重复（两行都标）/ 太长太大；空变量名不报名字类错误
  function envCheck(rows) {
    const counts = {};
    for (const r of rows) if (r.key) counts[r.key] = (counts[r.key] || 0) + 1;
    const per = rows.map((r) => {
      const e = [];
      const k = r.key;
      if (k) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) e.push({ code: 'ENV_NAME_INVALID', field: 'key', text: '变量名只能包含字母、数字、下划线，且不能以数字开头' });
        else if (RESERVED.has(k) || k.startsWith('GIT_') || k.startsWith('CODEX_')) e.push({ code: 'ENV_NAME_RESERVED', field: 'key', text: '该变量名为系统保留，请使用凭证管理配置' });
        else if (k.length > KEY_MAX) e.push({ code: 'ENV_LIMIT_EXCEEDED', field: 'key', text: '变量名太长（最多 64 个字符）' });
        if (counts[k] > 1) e.push({ code: 'ENV_DUPLICATE_KEY', field: 'key', text: '变量名重复' });
      }
      else if (r.blank) e.push({ code: 'ENV_NAME_INVALID', field: 'key', text: '变量名只能包含字母、数字、下划线，且不能以数字开头' }); // 空变量名：保存时平台判、映回这一行（REQ-IMG-012 / 014）
      if (bytes(r.value) > VALUE_MAX) e.push({ code: 'ENV_LIMIT_EXCEEDED', field: 'value', text: '变量值太大（最多 4096 字节）' });
      return e;
    });
    const table = rows.length > ENV_MAX ? { code: 'ENV_LIMIT_EXCEEDED', text: '变量条数太多（每张镜像最多 50 条）' } : null;
    return { per, table, any: per.some((e) => e.length) || !!table };
  }
  function openEnv(i) {
    const tpl = P.fromTpl('tpl-img-env');
    tpl.id = `env-${i.id}`;
    const rowsBox = $('.l4a-env__rows', tpl);
    const rowTpl = $('.l4a-env__row', rowsBox).cloneNode(true);
    for (const r of $$('.l4a-env__row', rowsBox)) r.remove();
    const addBox = $('.l4a-env__add', rowsBox);
    const addBtn = $('.btn', addBox); Object.assign(addBtn.dataset, { action: 'img-env-add', fk: 'img-env-add' });
    const [saveBtn, cancelBtn] = $$(':scope > .btn-row .btn', tpl);
    Object.assign(saveBtn.dataset, { action: 'img-env-save', fk: 'img-env-save' });
    Object.assign(cancelBtn.dataset, { action: 'img-env-cancel', fk: 'img-env-cancel' });
    let nid = 0;
    // 已存的 Secret：值输入框为空、占位「（保持不变，输入即覆盖）」，原值不进页面（REQ-IMG-011）
    ip.env = { id: i.id, el: tpl, rowTpl, rowsBox, addBox, saving: false, rows: i.face.env.map((e) => ({ rid: ++nid, key: e.key, value: e.secret ? '' : e.value, secret: !!e.secret, stored: !!e.secret })), nid };
    ip.env.nextId = () => ++ip.env.nid;
    buildEnvRows();
  }
  function rowEl(r, n) {
    const el = ip.env.rowTpl.cloneNode(true);
    el.dataset.rid = r.rid; el.dataset.rowIndex = String(n - 1);
    const [k, v] = $$('input.input', el);
    const sec = $('input[type="checkbox"]', el);
    const del = $('.btn', el);
    k.value = r.key; k.setAttribute('aria-label', `变量名 ${n}`); k.dataset.env = 'key'; k.dataset.fk = `env-key:${r.rid}`;
    v.value = r.value; v.setAttribute('aria-label', `变量值 ${n}`); v.dataset.env = 'value'; v.dataset.fk = `env-value:${r.rid}`;
    v.type = r.secret ? 'password' : 'text';
    v.placeholder = r.secret && r.stored ? '（保持不变，输入即覆盖）' : 'info';
    sec.checked = r.secret; sec.setAttribute('aria-label', `Secret ${n}`); sec.dataset.env = 'secret'; sec.dataset.fk = `env-secret:${r.rid}`;
    del.setAttribute('aria-label', `删除变量 ${n}`); Object.assign(del.dataset, { action: 'img-env-del', rid: r.rid, fk: `env-del:${r.rid}` });
    return el;
  }
  function buildEnvRows() {
    const E = ip.env; if (!E) return;
    for (const el of $$('.l4a-env__row, .l4a-env__empty, [data-env-table]', E.rowsBox)) el.remove();
    E.rows.forEach((r, k) => E.rowsBox.insertBefore(rowEl(r, k + 1), E.addBox));
    if (!E.rows.length) { const p = document.createElement('p'); p.className = 'field__help l4a-env__empty'; p.textContent = '还没有环境变量。'; E.rowsBox.insertBefore(p, E.addBox); }
    paintEnvErrors();
  }
  // 行下的错误句（f-img-env-02 的写法：role=alert、data-testid、data-code）
  function errHtml(id, code, text) {
    const p = P.fromTpl('tpl-img-env-error', { keepRoles: true });
    p.id = id; p.dataset.code = code; p.lastChild.nodeValue = text;
    return p.outerHTML;
  }
  // 出错的那一格：错误态 + aria-invalid + aria-describedby 指向行下的错误句（role=alert、带 data-code）；字节计数超限变红；整表错误跟在最后一行之后
  function paintEnvErrors() {
    const E = ip.env; if (!E) return;
    const res = envCheck(E.rows);
    E.rows.forEach((r, k) => {
      const el = $(`.l4a-env__row[data-rid="${r.rid}"]`, E.rowsBox); if (!el) return;
      const errs = res.per[k];
      const n = k + 1;
      const key = $('[data-env="key"]', el), val = $('[data-env="value"]', el);
      const html = errs.map((e, x) => errHtml(`env-r${n}-e${x + 1}`, e.code, e.text)).join('');
      const old = $$(':scope > .field__error', el);
      if (el.dataset.errs !== html) { old.forEach((x) => x.remove()); if (html) el.insertAdjacentHTML('beforeend', html); el.dataset.errs = html; }
      for (const [input, field] of [[key, 'key'], [val, 'value']]) {
        const ids = errs.map((e, x) => (e.field === field ? `env-r${n}-e${x + 1}` : null)).filter(Boolean);
        input.classList.toggle('is-invalid', ids.length > 0);
        if (ids.length) { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', ids.join(' ')); } else { input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); }
      }
      const b = bytes(r.value);
      const cnt = $('.l4a-env__bytes', el); cnt.textContent = `${b} / ${VALUE_MAX} 字节`; cnt.classList.toggle('is-over', b > VALUE_MAX);
    });
    let tb = $('[data-env-table]', E.rowsBox);
    if (res.table && !tb) { tb = frag(`<p class="field__error" role="alert" data-code="${res.table.code}" data-env-table><span class="icon i-circle-alert" aria-hidden="true"></span>${res.table.text}</p>`); E.rowsBox.insertBefore(tb, E.addBox); }
    else if (!res.table && tb) tb.remove();
    // 50 条：[添加变量] 不可用但能聚焦、旁边写原因（DR-39，REQ-IMG-013）
    const full = E.rows.length >= ENV_MAX;
    const add = $('.btn', E.addBox);
    let lim = $('.l4a-env__limit', E.addBox);
    if (full) {
      add.setAttribute('aria-disabled', 'true'); add.setAttribute('aria-describedby', `env-${E.id}-limit`); add.dataset.reason = '每张镜像最多 50 条';
      if (!lim) { lim = $('.l4a-env__limit', P.fromTpl('tpl-img-env-add-limit')); lim.id = `env-${E.id}-limit`; E.addBox.appendChild(lim); } // f-img-env-03 的原因句
    } else { add.removeAttribute('aria-disabled'); add.removeAttribute('aria-describedby'); delete add.dataset.reason; if (lim) lim.remove(); }
  }
  function onEnvInput(e) {
    const E = ip.env; const t = e.target;
    if (!E || !t.dataset || !t.dataset.env || !E.el.contains(t)) return;
    const r = E.rows.find((x) => String(x.rid) === t.closest('.l4a-env__row').dataset.rid); if (!r) return;
    if (t.dataset.env === 'key') { r.key = t.value; r.blank = false; }
    if (t.dataset.env === 'value') { r.value = t.value; if (r.stored) { r.stored = false; t.placeholder = 'info'; } } // 一输入就是覆盖
    paintEnvErrors();
  }
  function onEnvChange(e) {
    const E = ip.env; const t = e.target;
    if (!E || !t.dataset || t.dataset.env !== 'secret' || !E.el.contains(t)) return;
    const r = E.rows.find((x) => String(x.rid) === t.closest('.l4a-env__row').dataset.rid); if (!r) return;
    r.secret = t.checked;
    // 取消勾选 Secret = 这一行要重新填明文（AC-IMG-011.3）
    if (!t.checked && r.stored) { r.stored = false; r.value = ''; }
    const v = $('[data-env="value"]', t.closest('.l4a-env__row'));
    v.type = r.secret ? 'password' : 'text';
    v.placeholder = r.secret && r.stored ? '（保持不变，输入即覆盖）' : 'info';
    v.value = r.value;
    paintEnvErrors();
  }
  function closeEnv(focus) {
    const E = ip.env; if (!E) return;
    ip.env = null;
    P.render();
    if (focus) { const b = $(`[data-fk="img-env:${E.id}"]`); if (b) b.focus({ preventScroll: true }); }
  }
  P.actions['img-env'] = (el) => {
    const i = img(el.dataset.img); if (!i) return;
    if (ip.env && ip.env.id === i.id) { closeEnv(true); P.announce('已收起，草稿已丢弃'); return; } // 再点一次 = 收起并丢弃草稿
    if (ip.env) ip.env = null; // 同一时刻只有一张卡在编辑：打开另一张时前一张收起、草稿丢弃
    openEnv(i);
    P.render();
    P.announce(`已展开 ${i.name} 的运行参数编辑器`); // 焦点不动（同实现）
  };
  P.actions['img-env-add'] = () => {
    const E = ip.env; if (!E || E.rows.length >= ENV_MAX) return;
    const r = { rid: E.nextId(), key: '', value: '', secret: false, stored: false };
    E.rows.push(r);
    buildEnvRows();
    const k = $(`[data-fk="env-key:${r.rid}"]`, E.el); if (k) k.focus({ preventScroll: true });
  };
  P.actions['img-env-del'] = (el) => {
    const E = ip.env; if (!E) return;
    const k = E.rows.findIndex((r) => String(r.rid) === el.dataset.rid); if (k < 0) return;
    E.rows.splice(k, 1);
    buildEnvRows();
    const next = E.rows[k] ? $(`[data-fk="env-del:${E.rows[k].rid}"]`, E.el) : $('[data-action="img-env-add"]', E.el);
    if (next) next.focus({ preventScroll: true });
    P.announce('已删除这一行');
  };
  P.actions['img-env-cancel'] = () => closeEnv(true);
  P.actions['img-env-save'] = (el) => {
    const E = ip.env; if (!E || E.saving) return;
    if (envCheck(E.rows).any) { P.toast('fail', '运行参数还有未修正的问题，请按行内提示改完再保存。'); return; } // 预检没过不发请求
    E.rows = E.rows.filter((r) => r.key || r.value); // 整行都空的不提交
    const blanks = E.rows.filter((r) => !r.key);
    if (blanks.length) {
      // 变量名空着、值填了：平台 400（details[].path = env[i].key）→ 标回那一行，编辑器不收起
      for (const r of blanks) r.blank = true;
      buildEnvRows();
      P.announce('平台没有接受：有变量名空着，已标在那一行');
      const k = $(`[data-fk="env-key:${blanks[0].rid}"]`, E.el); if (k) k.focus({ preventScroll: true });
      return;
    }
    E.saving = true;
    // 第五段（R1-03）：[保存运行参数] 保存中用 aria-busy（焦点留在它上面；在格子里按回车保存的，焦点先交给它），其余输入与按钮照旧禁用
    if (E.el.contains(document.activeElement) && document.activeElement !== el) el.focus({ preventScroll: true });
    for (const x of $$('input, button', E.el)) if (x !== el) x.disabled = true;
    P.setBusy(el, true, P.busyHtml('保存中…'));
    P.announce('保存中…');
    P.clock.after(T.envSave, () => {
      if (ip.env !== E) return;
      const i = img(E.id); if (!i) { ip.env = null; return; }
      // 写回（Secret 的值不进页面：已存且没改 = 保持不变）；摘要按新值更新是原位结果，轻提示只作补充
      i.face.env = E.rows.filter((r) => r.key).map((r) => ({ key: r.key, value: r.secret ? '' : r.value, secret: r.secret }));
      closeEnv(true);
      P.toast('ok', '运行参数已保存。');
    });
  };

  // ================================================================== F-IMG-VERSION 版本（f-img-version-01…04）
  P.actions['img-expand'] = (el) => { const id = el.dataset.img; ip.expanded[id] = !ip.expanded[id]; P.render(); }; // 纯本地显示，不发请求
  P.actions['img-copy'] = (el) => {
    const i = img(el.dataset.img); if (!i) return;
    // 复制的是完整版本号（sha256: + 64 位），不是 tag；失败不能静默（REQ-IMG-020）
    P.copyText(i.face.digest, () => P.toast('ok', '版本号已复制。'), () => P.toast('fail', '复制失败（需要 HTTPS 或 localhost 才允许自动复制），请手动选中复制。'));
  };
  P.actions['img-check'] = (el) => {
    const i = img(el.dataset.img); if (!i || ip.busy[i.id]) return;
    if (el.dataset.via === 'note' && i.upstream) { openCompare(i, el.dataset.fk); return; } // 提示条上的 [查看变更]：结果已在手，直接开对比弹层（不再解析一次）
    // 解析中：按钮「解析中…」禁用，卡片其余一个字不改、同卡其他按钮照常（REQ-IMG-021）
    ip.busy[i.id] = 'check'; P.render();
    P.announce('解析中…');
    P.clock.after(T.imgCheck, () => {
      delete ip.busy[i.id];
      const scen = P.scenario.get('img-check');
      if (!img(i.id)) return;
      if (scen === 'fail') { P.render(); P.toast('fail', '连不上镜像下载源', '网络、DNS、代理，或下载源自己在抖；卡片没有变化，稍后再点 [检查更新]。'); refocus(`img-check:${i.id}`); return; } // 第五段：「镜像仓库」是退役词（Q-DS-21 A，lint E8），同 f-img-register-06
      if (scen === 'gone') { P.render(); P.toast('neutral', '镜像下载源上已经找不到这个 tag 了，所以没有可更新的目标。', '平台没有顺带去查你锁定的那一版还在不在源里 —— 那要等下一次真的拉取时才知道。'); refocus(`img-check:${i.id}`); return; }
      if (!i.upstreamNext) { P.render(); P.toast('ok', `已是最新（${short(i.face.digest)}）`); refocus(`img-check:${i.id}`); return; }
      i.upstream = { ...i.upstreamNext, status: scen === 'invalid' ? 'invalid' : i.upstreamNext.status, reasons: scen === 'invalid' ? ['不是从平台的预制镜像改起的：Dockerfile 第一行要 FROM ghcr.io/agent-infra/sandbox:latest（或它的派生）。'] : [] };
      P.render();
      P.announce(`下载源上这个 tag 已经指向另一版（${short(i.upstream.digest)}）`);
      openCompare(i);
    });
  };
  function refocus(fk) { const a = document.activeElement; if (!a || a === document.body || a.id === 'main') { const b = $(`[data-fk="${CSS.escape(fk)}"]`); if (b) b.focus({ preventScroll: true }); } }
  function openCompare(i, returnFk = `img-check:${i.id}`) {
    // 对比弹层（f-img-version-01）：当前 / 上游两行 + 上游结论 + 作用范围；上游无效时不给 [更新到新版本]（只剩 [暂不更新] + 已保留当前版本）
    const box = P.fromTpl('tpl-img-compare', { keepRoles: true });
    box.dataset.dialog = 'img-compare';
    box.setAttribute('aria-label', `${i.name} 的上游更新`);
    $('.dialog__subtitle', box).textContent = i.ref;
    const [cur, up] = $$('.l4b-compare dd', box);
    cur.innerHTML = `<span class="text-mono-13">${esc(short(i.face.digest))}</span><span class="u-muted">（解析于 ${esc(i.face.resolved)}）</span>`;
    up.innerHTML = `<span class="text-mono-13">${esc(short(i.upstream.digest))}</span>`;
    const vd = $('.p7-verdict', box);
    const valid = i.upstream.status !== 'invalid';
    if (!valid) {
      vd.outerHTML = `<div class="p7-verdict" role="alert" data-status="invalid"><div class="p7-verdict__line"><span class="badge badge--20 badge--fail"><span class="icon i-x" aria-hidden="true"></span>无效</span><span>镜像不符合平台约定</span></div><ul class="bullets">${i.upstream.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>`;
    }
    const scope = $('.l4b-scope', box);
    if (!valid) scope.outerHTML = `<p class="l4b-kept">上游新版本不满足平台约定，<strong>已保留当前版本</strong>。</p><button class="btn btn--secondary btn--32" type="button" aria-expanded="${P.sheet.isOpen('img-req')}" data-action="img-req" data-fk="img-req:compare">查看镜像要求</button>`;
    const later = $('.dialog__footer > .btn', box); later.dataset.cmp = 'later'; later.dataset.fk = 'cmp-later';
    const upd = $('.dialog__footer-end .btn', box);
    if (!valid) upd.closest('.dialog__footer-end').remove(); else { upd.dataset.cmp = 'update'; upd.dataset.fk = 'cmp-update'; }
    const m = P.openModal(box, { kind: 'img-compare', returnTo: $(`[data-fk="${CSS.escape(returnFk)}"]`), initialFocus: '[data-cmp="later"]' });
    m.returnFk = returnFk;
    m.box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cmp]'); if (!b || m.busy) return;
      if (b.dataset.cmp === 'later') { P.closeModal(m); return; } // 什么都不写，提示条留着
      // [更新到新版本] = 登记新版本再切过去（与 [切换到此版本] 同一个动作）；运行参数带过去（Q-IMG-03 默认 C）
      m.busy = true; later.disabled = true;
      P.setBusy(upd, true, P.busyHtml('更新中…')); // 第五段（R1-03）
      P.announce('更新中…');
      P.clock.after(T.imgActivate, () => {
        m.busy = false;
        const old = i.face;
        i.face = { version: old.version, digest: i.upstream.digest, status: i.upstream.status, reasons: i.upstream.reasons || [], runtimes: i.upstream.runtimes, resolved: '刚刚', lineage: old.lineage, env: old.env.map((x) => ({ ...x })) };
        i.history.unshift(old);
        i.upstream = null; i.upstreamNext = null;
        i.active = true; // 更新 = 登记新版本并切过去（activate），与 [切换到此版本]、[启用] 同一个动作：切完就是启用的
        P.closeModal(m, { restoreFocus: false });
        P.render();
        P.toast('ok', `已更新到新版本（${short(i.face.digest)}）。`, SCOPE);
        const back = $(`[data-fk="img-check:${i.id}"]`); if (back) back.focus({ preventScroll: true }); // 提示条随更新消失：焦点回 [检查更新]
      });
    });
  }
  P.actions['img-revalidate'] = (el) => {
    const i = img(el.dataset.img); if (!i || ip.busy[i.id]) return;
    // 重新验证中：按钮与结论行末尾两处，服务端返回前结论一个字不改（不整卡骨架、不乐观，REQ-IMG-023）
    ip.busy[i.id] = 'revalidate'; P.render();
    P.announce('重新验证中…');
    P.clock.after(T.imgRevalidate, () => {
      delete ip.busy[i.id];
      if (!img(i.id)) return;
      const scen = P.scenario.get('img-revalidate');
      if (scen === 'fail') { P.render(); P.toast('fail', '重新验证没能完成', '卡片保持原来的结论；稍后再试。'); refocus(`img-revalidate:${i.id}`); return; }
      if (scen === 'upstream' && i.upstreamNext) {
        // tag 已经指向另一版：不写回结论（结论描述的是另一份内容），卡上出提示条
        i.upstream = { ...i.upstreamNext, reasons: [] };
        P.render();
        P.toast('neutral', `镜像下载源上这个 tag 已经指向另一版（${short(i.upstream.digest)}）；你正在用的这一版结论未变。点 [检查更新] 看对比。`);
        refocus(`img-revalidate:${i.id}`); return;
      }
      if (i.id === 'just-registered' || (i.face.status === 'invalid' && !i.face.reasons.includes(WORKDIR_REASON))) i.face.reasons = [WORKDIR_REASON];
      P.render();
      const st = i.face.status;
      // 判为无效也不自动禁用：卡片仍「已启用」，由用户决定禁用还是换版本
      if (st === 'valid') P.toast('ok', '这一版仍通过平台校验（启动命令、工作目录、预装声明）。本次没有重新检查它是从哪张预制镜像改来的 —— 那是注册时判定的。');
      else if (st === 'warning') P.toast('neutral', '重新验证通过，但有警告——后果说明在卡上。');
      else P.toast('fail', '重新验证不通过：平台校验规则已更新，这一版现已不满足要求。');
      P.announce(`结论：${st === 'valid' ? '验证通过' : st === 'warning' ? '有警告' : '无效'}`);
      refocus(`img-revalidate:${i.id}`);
    });
  };
  P.actions['img-switch'] = (el) => {
    const i = img(el.dataset.img); const k = Number(el.dataset.k); if (!i || !i.history[k] || ip.switching) return;
    // 不弹确认（按实现）；进行中只有被点的那一行「切换中…」，卡面与其他行不动（REQ-IMG-024）
    ip.switching = { id: i.id, k }; P.render();
    P.announce('切换中…');
    P.clock.after(T.imgActivate, () => {
      ip.switching = null;
      if (!img(i.id) || !i.history[k]) { P.render(); return; }
      const next = i.history.splice(k, 1)[0];
      i.history.unshift(i.face);
      i.face = next; // 卡面整张换成那一版自己的样子（结论、适用、解析时间、运行参数——运行参数跟着版本走，REQ-IMG-026）
      i.active = true;
      P.render();
      P.toast('ok', '已切换到该版本。', SCOPE);
      const b = $(`[data-fk="img-switch:${i.id}:0"]`) || $(`[data-fk="img-check:${i.id}"]`); if (b) b.focus({ preventScroll: true });
    });
  };

  // ================================================================== F-IMG-STATE 禁用 / 启用 / 删除（f-img-state-01…04）
  function disable(i) {
    // 乐观：立刻「已禁用」、按钮变 [启用]；停用色调、不转圈、不降透明（REQ-IMG-030）；预制镜像的轻提示正文说它特有的后果（REQ-IMG-032 原句）
    i.active = false;
    P.render();
    P.toast('ok', '已禁用', i.builtin ? '在重新启用之前，新任务默认用不了它；可以在新建任务的「镜像」一栏改选别的镜像。' : '新任务不能再选用这张镜像；已经在用它的任务不受影响。');
  }
  // 预制镜像的 [禁用] 先出一步非破坏性确认（2026-10-04 用户拍板 Q-IMG-04 A；REQ-IMG-032；f-img-state-04）：新建任务默认用它、自动化到点发起的也用它——
  // 说清后果（新任务会被拒，直到再启用或换镜像；在跑的不受影响）；[取消] 打开时焦点在这里，[禁用] 是普通次按钮（可逆，不用危险色）；Esc / 点遮罩 / 关闭 = 取消，什么都不改
  function confirmDisablePreset(i, el) {
    const box = P.fromTpl('tpl-img-disable-preset');
    box.dataset.dialog = 'img-disable';
    $('.l4b-title-ref', box).textContent = `「${i.ref}」？`;
    $('.dialog__subtitle', box).innerHTML = `平台预制镜像 · 当前版本 <span class="text-mono-13">${esc(short(i.face.digest))}</span> · 已启用`;
    const [cancel, ok] = $$('.dialog__footer .btn', box);
    cancel.dataset.dis = 'cancel'; cancel.dataset.fk = 'img-dis-cancel';
    ok.dataset.dis = 'confirm'; ok.dataset.fk = 'img-dis-confirm';
    $('.dialog__close', box).dataset.dis = 'cancel';
    const m = P.openModal(box, { kind: 'img-disable', returnTo: el, initialFocus: '[data-initial-focus]' });
    m.returnFk = `img-toggle:${i.id}`;
    m.box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dis]'); if (!b) return;
      if (b.dataset.dis === 'cancel') { P.closeModal(m); return; }
      P.closeModal(m, { restoreFocus: false });
      disable(i);
      const t = $(`[data-fk="img-toggle:${i.id}"]`); if (t) t.focus({ preventScroll: true }); // 焦点回这张卡上变成 [启用] 的那颗
    });
  }
  P.actions['img-disable'] = (el) => {
    const i = img(el.dataset.img); if (!i || !i.active) return;
    if (i.builtin) { confirmDisablePreset(i, el); return; }
    disable(i); // 自定义镜像不确认（REQ-IMG-030）
    const b = $(`[data-fk="img-toggle:${i.id}"]`); if (b) b.focus({ preventScroll: true });
  };
  P.actions['img-enable'] = (el) => {
    const i = img(el.dataset.img); if (!i || i.active || ip.busy[i.id]) return;
    // 启用 = 把这一版重新设为当前（activate），不乐观：启用中…（REQ-IMG-031）
    ip.busy[i.id] = 'enable'; P.render();
    P.announce('启用中…');
    P.clock.after(T.imgEnable, () => {
      delete ip.busy[i.id];
      if (!img(i.id)) return;
      i.active = true;
      P.render();
      P.toast('ok', '已启用', i.builtin ? '新任务可以照常发起了。' : '新任务又可以选用这张镜像了。');
      refocus(`img-toggle:${i.id}`);
    });
  };
  P.actions['img-delete'] = (el) => {
    const i = img(el.dataset.img); if (!i || i.builtin) return;
    const users = usedBy(i);
    const sub = `自定义镜像 · 当前版本 <span class="text-mono-13">${esc(short(i.face.digest))}</span> · ${i.active ? '已启用' : '已禁用'}`;
    let box;
    if (users.length) {
      // 被任务引用：打开即拦（f-img-state-03）——任务清单 + [改为禁用]，[删除镜像] 禁用并写原因
      box = P.fromTpl('tpl-img-delete-blocked');
      $('.note__title', box).textContent = `有 ${users.length} 个任务在用这一版，删不了`;
      $('.l4b-blocker-list', box).innerHTML = users.map((t) => `<li>${esc(t.name)} <span class="dconfirm__meta">· ${esc(P.proj(t.project).name)} · ${esc((P.STATE[t.state] || {}).word || '')}</span></li>`).join('');
      $('.l4b-blocker-list ~ .note__text', box).textContent = `删掉会让它们指向一张不存在的镜像。改为禁用：新任务不能再选用它，这 ${users.length} 个任务照常运行，之后随时能在卡片上点 [启用] 恢复。`;
      const dis = $('.note__actions .btn', box); dis.dataset.del = 'disable'; dis.dataset.fk = 'img-del-disable';
      if (!i.active) { dis.disabled = true; dis.textContent = '已经禁用了'; }
    } else {
      box = P.fromTpl('tpl-img-delete');
      const env = i.face.env || [];
      const secrets = env.filter((x) => x.secret).length;
      const envNote = env.length ? `连同它的验证结论和运行参数（${env.length} 个环境变量${secrets ? `，其中 ${secrets} 个是 Secret` : ''}）。` : '连同它的验证结论；它没有配置运行参数。';
      const host = (i.ref.split('/')[0] || '').includes('.') ? i.ref.split('/')[0] : 'docker.io';
      const blocks = [
        `<div class="dconfirm__block"><div class="dconfirm__title">会删掉</div><ul class="bullets"><li>这一版的登记 <span class="dconfirm__meta">· ${i.face.version ? `<span class="text-mono-13">${esc(i.face.version)}</span> · ` : ''}<span class="text-mono-13">${esc(short(i.face.digest))}</span></span><span class="dconfirm__note">${esc(envNote)}</span></li>${i.history.length ? '' : `<li>这张镜像的卡片<span class="dconfirm__note">它只有这一版，删掉之后列表里不再有 ${esc(i.name)}。</span></li>`}</ul></div>`,
        i.history.length ? `<div class="dconfirm__block"><div class="dconfirm__title">会留下</div><ul class="bullets"><li>历史里的另一版 <span class="dconfirm__meta">· <span class="text-mono-13">${esc(i.history[0].version)}</span> · <span class="text-mono-13">${esc(short(i.history[0].digest))}</span> · 未启用</span><span class="dconfirm__note">卡片会退回到这一版，它现在没有启用；要继续用这张镜像，到卡片上点 [启用]。</span></li><li>这台机器上已经下载的镜像层<span class="dconfirm__note">平台不清理本机缓存，删除不会腾出磁盘空间。</span></li></ul></div>` : '',
        '<div class="dconfirm__block"><div class="dconfirm__title">删掉之后</div><ul class="bullets"><li>拿不回来；要再用这一版，只能重新注册同一个地址<span class="dconfirm__note">那时会按镜像下载源上当时的内容重新锁定版本，未必还是同一版。</span></li></ul></div>',
        `<div class="dconfirm__block dconfirm__block--untouched"><div class="dconfirm__title">不受影响</div><ul class="bullets"><li>镜像下载源（${esc(host)}）上的镜像本身</li><li>已有的任务 <span class="dconfirm__meta">· 现在没有任务在用这一版</span></li></ul></div>`,
        '<p class="dconfirm__source">清单来源：后端返回（这张镜像的版本列表、引用这一版的任务数）。</p>',
      ];
      $('.dialog__body', box).innerHTML = blocks.join('');
      const danger = $('.btn--danger', box); danger.dataset.del = 'confirm'; danger.dataset.fk = 'img-del-confirm';
    }
    box.dataset.dialog = 'img-delete';
    $('.dialog__title', box).textContent = `删除镜像「${i.ref}」？`;
    $('.dialog__subtitle', box).innerHTML = sub;
    const cancel = $('.dialog__footer > .btn', box); cancel.dataset.del = 'cancel';
    $('.dialog__close', box).dataset.del = 'cancel';
    const m = P.openModal(box, { kind: 'img-delete', returnTo: el, initialFocus: '[data-initial-focus]' });
    m.returnFk = `img-delete:${i.id}`;
    m.box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-del]'); if (!b || m.busy || b.disabled) return;
      if (b.dataset.del === 'cancel') { P.closeModal(m); return; }
      if (b.dataset.del === 'disable') {
        // [改为禁用] = 关弹层 + 对这一版做 [禁用]，焦点回这张卡的 [删除]（AC-IMG-034.2）
        P.closeModal(m);
        disable(i);
        const d = $(`[data-fk="img-delete:${i.id}"]`); if (d) d.focus({ preventScroll: true });
        return;
      }
      m.busy = true; cancel.disabled = true; for (const x of $$('.dialog__close', m.box)) x.disabled = true;
      P.setBusy(b, true, P.busyHtml('删除中…')); // 第五段（R1-03）
      P.announce('删除中…');
      P.clock.after(T.imgDelete, () => {
        m.busy = false;
        P.closeModal(m, { restoreFocus: false });
        // 还有别的版本：卡片退回到最近登记的那一版（「已禁用」+ [启用]）；最后一版：整张卡消失
        if (i.history.length) { i.face = i.history.shift(); i.active = false; }
        else world.images.splice(world.images.indexOf(i), 1);
        if (ip.env && ip.env.id === i.id) ip.env = null;
        P.render();
        P.toast('ok', '已删除。');
        const f = $(`[data-fk="img-toggle:${i.id}"]`) || $('[data-fk="img-search"]'); if (f) f.focus({ preventScroll: true });
      });
    });
  };

  // ================================================================== F-IMG-PRESET 预制镜像下载到本机（f-img-preset-01…03；暂行入口 DR-36）
  function provisionEl(i) {
    const pr = i.preset;
    if (!pr.el) {
      const el = P.fromTpl('tpl-img-provision');
      const old = $('.progress', el); if (old) old.remove();
      const b = $('[data-testid="preset-provision-button"]', el); Object.assign(b.dataset, { action: 'img-provision', img: i.id, fk: 'img-provision' });
      $('.l4b-provision__plan', el).textContent = pr.plan;
      pr.el = el;
    }
    paintProvision(i);
    return pr.el;
  }
  const STAGES = [
    [0, () => '看这台机器够不够得着镜像：正在连镜像下载源 ghcr.io'],
    [14, (p) => `下载：ghcr.io/agent-infra/sandbox 第 ${Math.min(7, 1 + Math.floor((p - 14) / 8))} / 7 层`],
    [70, () => '校验完整性：正在校验镜像包（约 320 MB）…'],
    [80, () => '装载镜像：正在写入本机镜像库'],
    // 93–100：恢复有分母，按已下载字节说（notes/dep.md §6.4 第 9 条；向导第 3 步与镜像页同一个搬运、同一套阶段句——第三段统一）
    [93, (p) => `放到位：已下载 ${Math.round((Math.min(100, p) * 320) / 100)} MB / 约 320 MB`],
  ];
  const stageText = (p) => { let s = STAGES[0]; for (const x of STAGES) if (p >= x[0]) s = x; return s[1](p); };
  const elapsedText = (ms) => { const s = Math.floor(ms / 1000); return `已用时 ${Math.floor(s / 60)} 分 ${s % 60} 秒`; };
  function paintProvision(i) {
    const pr = i.preset, el = pr.el; if (!el) return;
    const b = $('[data-testid="preset-provision-button"]', el);
    const running = pr.run && pr.run.phase === 'run';
    // 第五段（R1-04）：准备中用 aria-busy——焦点留在这颗按钮上；失败后它变回 [准备镜像]，焦点还在它上面（失败句就在它前面）
    P.setBusy(b, running, running ? P.busyHtml('准备中…') : '准备镜像');
    paintProgress(el, pr.run);
  }
  // 进度块（镜像页预制镜像卡与向导第 3 步的「下载到本机」块共用，第三段抽出）：opts.failTpl = 失败时用哪张稿的进度块（向导：f-dep-init-10 的出路句）
  function paintProgress(el, r, opts = {}) {
    let prog = $('.progress', el);
    let doneLine = $('[data-preset-done]', el);
    if (!r) { if (prog) prog.remove(); if (doneLine) doneLine.remove(); return; }
    if (r.phase === 'done') {
      if (prog) prog.remove();
      if (!doneLine) { doneLine = frag('<p class="icon-line icon-line--muted" role="status" data-preset-done><span class="icon i-loader-circle icon--spin" aria-hidden="true"></span>已下载到本机，正在重新检测…</p>'); el.appendChild(doneLine); }
      return;
    }
    if (doneLine) doneLine.remove();
    const unknown = r.phase === 'run' && r.pct >= 80 && r.pct < 93;
    const kind = r.phase === 'fail' ? 'fail' : unknown ? 'unknown' : 'pct';
    if (!prog || prog.dataset.kind !== kind) {
      const n = P.fromTpl(kind === 'fail' ? (opts.failTpl || 'tpl-img-progress-fail') : kind === 'unknown' ? 'tpl-img-progress-unknown' : 'tpl-img-progress', { keepRoles: true });
      n.dataset.kind = kind;
      if (prog) prog.replaceWith(n); else el.appendChild(n);
      prog = n;
    }
    // 失败：留最后一条阶段句（停在哪一步）+ 失败句；失败原因跟着这次搬运走（镜像页校验失败 / 向导里连接中断）
    $('.progress__detail', prog).textContent = r.phase === 'fail' ? (r.failStage || '校验完整性：正在校验镜像包（约 320 MB）…') : stageText(r.pct);
    if (kind === 'fail' && r.failText) { const t = $('[data-testid="preset-provision-error"] > span:last-child', prog); if (t) t.textContent = r.failText; }
    const el2 = $('.progress__elapsed', prog); if (el2) el2.textContent = elapsedText(r.elapsed);
    if (kind === 'pct') {
      const pct = Math.min(100, Math.round(r.pct));
      const meter = $('.meter', prog); meter.setAttribute('aria-valuenow', String(pct)); $('.meter__bar', meter).style.width = `${pct}%`;
      $('.progress__pct', prog).textContent = `${pct}%`;
    }
  }
  // 开始一次搬运（镜像页 [准备镜像]、向导第 3 步自动开始 / [准备镜像] 同一个）：fail = false | 'sha'（校验对不上，70% 停在校验）| 'eof'（连接中断，到「放到位」时断开）
  const EOF_TEXT = '拉取 ghcr.io/agent-infra/sandbox:latest 时连接中断（unexpected EOF），这次没有放到位';
  function startProvision(i, fail) {
    i.preset.run = { phase: 'run', pct: 0, elapsed: 0, fail: fail || false };
    P.emit('preset:progress', i);
    P.clock.wake();
  }
  P.presetProvision = {
    image: () => world.images.find((i) => i.builtin) || null,
    start: (fail) => { const i = world.images.find((x) => x.builtin); if (i && i.preset && !(i.preset.run && i.preset.run.phase === 'run')) startProvision(i, fail); return i; },
    paint: paintProgress,
    stageText,
  };
  P.actions['img-provision'] = (el) => {
    const i = img(el.dataset.img); if (!i || !i.preset || (i.preset.run && i.preset.run.phase === 'run')) return;
    // [准备镜像]：镜像页手动开始（向导里自动，同一个搬运）；失败后不自动重开，点了才从头来（REQ-IMG-040–042）
    startProvision(i, P.scenario.is('img-preset', 'fail') ? 'sha' : false);
    P.render();
    P.announce('准备中…');
    P.clock.wake();
  };
  P.clock.ticker({
    active: () => world.images.some((i) => i.preset && i.preset.run && i.preset.run.phase === 'run'),
    tick() {
      for (const i of world.images) {
        const r = i.preset && i.preset.run;
        if (!r || r.phase !== 'run') continue;
        r.elapsed += 1000;
        r.pct += 7; // 每秒 +7%（原型压缩）
        if ((r.fail === true || r.fail === 'sha') && r.pct >= 70) {
          // 校验 sha256 对不上：撤掉条、留最后一条阶段句 + 失败句 + 出路，按钮回到可点（不自动重试）
          r.phase = 'fail'; r.pct = 70;
          P.announce('校验 sha256 对不上：已停在校验这一步，没有装载。');
        } else if (r.fail === 'eof' && r.pct >= 93) {
          // 向导第 3 步的场景「下载失败」（f-dep-init-10）：放到位途中连接断开——留这一刻的阶段句与失败原因，不自动重试
          r.phase = 'fail'; r.failStage = stageText(r.pct); r.failText = EOF_TEXT;
          P.announce(EOF_TEXT);
        } else if (r.pct >= 100) {
          r.pct = 100; r.phase = 'done';
          P.announce('已下载到本机，正在重新检测…');
          P.clock.after(T.presetDone, () => {
            // 结论只认「预制镜像就绪」那项检查（与诊断第 ⑧ 项同源）：就绪 → 块收起，卡片回到常态，不弹轻提示
            const hadFocus = !!(i.preset.el && i.preset.el.contains(document.activeElement));
            i.preset.staged = true; i.preset.run = null; i.preset.el = null;
            if (!P.scenario.is('img-preset', 'staged')) P.scenario.reset('img-preset');
            P.render();
            // 第五段（R1-04）：块收起时焦点在块里（[准备镜像]）——交给这张预制镜像卡的第一个动作，不落到 body / 主区（结果由下面的播报说，不弹轻提示）
            if (hadFocus) { const f = $(`[data-fk="img-check:${i.id}"]`) || $(`[data-img="${i.id}"] .btn`); if (f && P.isShown(f)) f.focus({ preventScroll: true }); }
            P.announce('预制镜像就绪，可以立即发起任务');
            P.emit('preset:staged', i); // 向导第 3 步重跑镜像检查；诊断第 ⑧ 项下一轮读 P.presetImageStaged()
          });
        }
        if (i.preset.el && i.preset.el.isConnected) paintProvision(i);
        else P.dirty();
        P.emit('preset:progress', i); // 向导第 3 步的「下载到本机」块就地刷新
      }
    },
  });

  // ------------------------------------------------------------------ 测试出口（只读快照）
  P.stateExtras.push(() => ({
    images: world.images.map((i) => ({ id: i.id, ref: i.ref, builtin: !!i.builtin, status: i.face.status, active: !!i.active, usedBy: usedBy(i).map((t) => t.id), digest: i.face.digest, version: i.face.version, history: i.history.map((h) => h.digest), env: (i.face.env || []).map((e) => `${e.key}=${e.secret ? '***' : e.value}`), upstream: i.upstream ? i.upstream.digest : null, staged: i.preset ? !!i.preset.staged : null, provision: i.preset && i.preset.run ? { phase: i.preset.run.phase, pct: i.preset.run.pct } : null })),
    imagePage: { load: ip.load, filter: ip.filter, query: ip.query, editing: ip.env ? ip.env.id : null, located: ($('#shell-main article.is-current') || { dataset: {} }).dataset.img || null },
  }));
})();
