/*
 * 交互原型 · 公共件（js/ui.js）：gap/drafts/README.md §5 / §6 的 8 个共享件里要 JS 的部分，所有流程共用、不要在各流程里各写一份。
 *   P.toast(kind, title, text)          轻提示（.toast-region 常驻节点，换视图时重新挂到新 #main 末尾——外壳不在时挂到向导这块主区；4 秒后淡出、悬停暂停、最多 3 条）
 *   P.popover.open / close / update     浮层卡（.popover，position: fixed 贴触发器；非模态 role=dialog；Esc / 点外面关闭并还焦点）
 *   P.sheet.open / close                侧弹层（.sheet，不抢焦点、不随 Esc 关、只有 [关闭] 能关）
 *   P.inlineConfirm(btn, opts)          行内确认（.inline-confirm 就地替换按钮；Esc / 取消换回并还焦点；确认后换成进行中）
 *   P.banners.render()                  横幅栈（.banner-stack，#shell-main 里 header 之后、main 之前；数据在 P.world.banners）
 *   P.dialogViews(m, views)             对话框内多视图切换与返回链（同一个 .dialog 就地换内容，不叠第二层遮罩）
 *   P.openAbout(returnTo, tab)          「原型说明」弹层：说明 / 场景两页（场景页列出各流程登记的 P.scenario）
 * 都只用 gap-shared.css / components-v2.css 的类名；出场一律 P.leave()（data-state="closed"，reduced motion 下直接移除）。
 */
(function () {
  'use strict';
  const P = window.P;
  const { $, $$, esc } = P;

  // ------------------------------------------------------------------ 轻提示（只确认用户刚做的一步；不报告异步结果——UX-DS-508）
  const TOAST_MS = 4000, TOAST_MAX = 3;
  let region = null;
  function ensureRegion() {
    if (!region) {
      region = document.createElement('section');
      region.className = 'toast-region';
      region.setAttribute('aria-label', '通知');
    }
    // 外壳不在 DOM 里时（初始化向导整屏盖着，第三段）挂到当前那块主区地标末尾：产品里轻提示挂在应用根（AC-DEP-010.6 向导里 [复制] 的「已复制」、AC-AUTH-008.3 任一宿主的「凭证已更新」）
    const main = $('#shell-main #main') || $('#frame > [role="main"]');
    if (main && (region.parentNode !== main || main.lastElementChild !== region)) main.appendChild(region);
    return region;
  }
  P.hook('main:refreshed', () => { if (region && region.childElementCount) ensureRegion(); });
  P.toast = function toast(kind, title, text) {
    const r = ensureRegion();
    const el = document.createElement('div');
    el.className = `toast${kind === 'ok' ? ' toast--ok' : kind === 'fail' ? ' toast--fail' : ''}`;
    el.setAttribute('role', kind === 'fail' ? 'alert' : 'status');
    const icon = kind === 'ok' ? 'i-circle-check' : kind === 'fail' ? 'i-circle-x' : 'i-info';
    el.innerHTML = `<span class="icon ${icon}" aria-hidden="true"></span><div class="toast__body">${title ? `<p class="toast__title">${esc(title)}</p>` : ''}${text ? `<p class="toast__text">${esc(text)}</p>` : ''}</div>`;
    r.prepend(el);
    while (r.childElementCount > TOAST_MAX) r.lastElementChild.remove();
    // 4 秒后淡出；悬停时暂停（sonner 默认）
    let left = TOAST_MS, started = performance.now(), timer = 0;
    const arm = () => { started = performance.now(); timer = setTimeout(() => P.leave(el), left); };
    el.addEventListener('mouseenter', () => { clearTimeout(timer); left -= performance.now() - started; });
    el.addEventListener('mouseleave', arm);
    arm();
    // 区域随视图重新插入后 live 区域不可靠：同时走读屏播报（README §6）
    P.announce([title, text].filter(Boolean).join('。'));
    return el;
  };

  // ------------------------------------------------------------------ 浮层卡（.popover）：非模态；打开时焦点进第一个控件（没有控件就落在卡上）；Esc / 点外面关闭并把焦点还给触发器
  const pop = { el: null, trigger: null, fk: null, id: null, onClose: null };
  function placePopover() {
    if (!pop.el || !pop.trigger) return;
    const r = pop.trigger.getBoundingClientRect();
    const w = pop.el.offsetWidth, h = pop.el.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (vw < 640) { pop.el.style.left = '8px'; pop.el.style.right = '8px'; pop.el.style.width = 'auto'; }
    else {
      pop.el.style.right = ''; pop.el.style.width = '';
      // 第五段（R2-29）：右缘对齐到触发器右缘向上取整的整像素（触发器右缘常落在半像素上：1143.47 → 1144），与稿件「right = 画框宽 − 向上取整的右缘」同一取法，
      // 浮层不落在半像素 / 差 1 像素的位置上，整块文字的抗锯齿与稿件一致
      pop.el.style.left = `${Math.max(8, Math.min(Math.ceil(r.right) - Math.round(w), vw - Math.round(w) - 8))}px`;
    }
    pop.el.style.top = `${Math.round(Math.max(8, Math.min(r.bottom + 4, vh - h - 8)))}px`;
  }
  function markTrigger(on) {
    if (!pop.trigger) return;
    pop.trigger.classList.toggle('is-open', on);
    pop.trigger.setAttribute('aria-expanded', String(on));
  }
  // 触发器被重画（顶栏刷新）后找回同名触发器：优先看得见的那个（≥ 960 是 chip，窄顶栏是 ⓘ）
  function findTrigger() {
    if (!pop.fks) return null;
    for (const k of pop.fks) { const el = $(`[data-fk="${k}"]`); if (P.isShown(el)) return el; }
    return null;
  }
  P.popover = {
    get el() { return pop.el; },
    get trigger() { return pop.trigger; },
    isOpenFor: (id) => !!(pop.el && pop.id === id),
    open(trigger, { id, html, focus = true, fks, onClose, label } = {}) {
      P.popover.close(false);
      const el = document.createElement('div');
      el.className = 'popover proto-popover';
      el.id = id || 'proto-popover';
      el.setAttribute('role', 'dialog');
      if (label) el.setAttribute('aria-label', label);
      el.innerHTML = html;
      const title = $('.popover__title', el);
      if (title) { if (!title.id) title.id = `${el.id}-t`; el.setAttribute('aria-labelledby', title.id); }
      $('#frame').appendChild(el);
      pop.el = el; pop.trigger = trigger; pop.id = el.id; pop.onClose = onClose; pop.fks = fks || [trigger.getAttribute('data-fk')];
      markTrigger(true);
      placePopover();
      P.upgradeTips(el);
      el.addEventListener('keydown', onPopoverTab);
      if (focus) {
        const f = P.focusables(el)[0];
        if (f) f.focus({ preventScroll: true }); else { el.tabIndex = -1; el.focus({ preventScroll: true }); }
      }
      return el;
    },
    // 就地换内容（拉取中 / 结果句）：保住焦点所在的那个控件（按 data-fk）
    update(html) {
      if (!pop.el) return;
      const a = document.activeElement;
      const fk = a && pop.el.contains(a) ? a.getAttribute('data-fk') : null;
      const hadFocus = !!(a && pop.el.contains(a));
      pop.el.innerHTML = html;
      const title = $('.popover__title', pop.el);
      if (title && !title.id) { title.id = `${pop.el.id}-t`; pop.el.setAttribute('aria-labelledby', title.id); }
      P.upgradeTips(pop.el);
      placePopover();
      if (hadFocus) {
        const again = fk && $(`[data-fk="${CSS.escape(fk)}"]`, pop.el);
        if (again && !again.disabled) again.focus({ preventScroll: true }); else { pop.el.tabIndex = -1; pop.el.focus({ preventScroll: true }); }
      }
    },
    close(restoreFocus = true) {
      if (!pop.el) return;
      const el = pop.el;
      const hadFocus = el.contains(document.activeElement) || document.activeElement === el;
      markTrigger(false);
      const trig = pop.trigger;
      const fks = pop.fks;
      const cb = pop.onClose;
      pop.el = null; pop.trigger = null; pop.id = null; pop.onClose = null;
      el.removeAttribute('role');
      P.leave(el);
      // 先跑关闭回调（可能重画顶栏、换掉触发器），再还焦点：原触发器不在了就按 data-fk 找回同名的那个
      if (cb) cb();
      if (restoreFocus && hadFocus) {
        const again = P.isShown(trig) ? trig : (fks || []).map((k) => $(`[data-fk="${k}"]`)).find((x) => P.isShown(x));
        if (again) again.focus({ preventScroll: true }); else P.focusMain();
      }
    },
  };
  // 第五段（W4，评审 R1-07）：浮层是非模态的，但 DOM 挂在画框末尾——从它的最后一个控件按 Tab 会跳到文档末尾（「交互原型 · 返回画廊」浮标），
  // 浮层还开着压在内容上；从第一个控件按 Shift+Tab 落到不可识别的位置。改成：焦点要离开浮层时先关掉它，Tab 交给触发器之后的下一个可聚焦元素，
  // Shift+Tab 回到触发器（焦点顺序跟视觉顺序走，WCAG 2.4.3）
  function tabbablesInOrder() {
    return P.focusables(document.body).filter((x) => !x.closest('[inert]') && !(pop.el && pop.el.contains(x)) && !x.closest('.proto-float'));
  }
  function onPopoverTab(e) {
    if (e.key !== 'Tab' || !pop.el || e.defaultPrevented) return;
    const items = P.focusables(pop.el);
    const first = items[0], last = items[items.length - 1];
    const a = document.activeElement;
    const leaving = !items.length || (e.shiftKey ? a === first || a === pop.el : a === last);
    if (!leaving) return;
    e.preventDefault();
    const trig = P.isShown(pop.trigger) ? pop.trigger : findTrigger();
    let target = trig;
    if (!e.shiftKey && trig) {
      const all = tabbablesInOrder();
      target = all.find((x) => trig.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING && !trig.contains(x)) || trig;
    }
    // 关浮层会重画顶栏（触发器与它后面的按钮都会被换掉）：先记下 data-fk，关完再按它找回
    const tfk = target && target.getAttribute('data-fk');
    P.popover.close(false);
    const again = target && target.isConnected ? target : tfk ? $(`[data-fk="${CSS.escape(tfk)}"]`) : null;
    if (again && P.isShown(again)) again.focus({ preventScroll: true }); else P.focusMain();
  }
  P.hook('escape', () => { if (pop.el) { P.popover.close(true); return true; } return undefined; });
  P.hook('pointerdown', (e) => {
    if (!pop.el) return;
    const t = e.target;
    if (pop.el.contains(t) || (pop.trigger && pop.trigger.contains(t))) return;
    if (t instanceof Element && pop.fks && pop.fks.some((k) => t.closest(`[data-fk="${k}"]`))) return;
    P.popover.close(false);
  });
  P.hook('rendered', () => {
    if (!pop.el) return;
    if (!pop.trigger || !pop.trigger.isConnected || !P.isShown(pop.trigger)) {
      const again = findTrigger();
      if (!again) { P.popover.close(false); return; }
      pop.trigger = again;
      markTrigger(true);
    }
    placePopover();
  });
  P.hook('resize', () => { if (!pop.el) return; const again = findTrigger(); if (again) { if (again !== pop.trigger) { markTrigger(false); pop.trigger = again; markTrigger(true); } placePopover(); } });
  P.hook('route', () => P.popover.close(false));
  P.hook('inert', (on) => { if (on) P.popover.close(false); });

  // ------------------------------------------------------------------ 侧弹层（.sheet）：无遮罩、不抢焦点；只有 [关闭] 能关；再点触发按钮复用已开的那个
  // 第二段（F-IMG-REGISTER 镜像要求）：一个面板可以有多个触发器（注册弹层里的链接、无效结论、卡片、空态），都记下来：
  // 打开时被点的那个 aria-expanded="true"，关闭时全部回 false；焦点在面板里时还给最后一个还在页面上的触发器
  const sh = { el: null, triggers: [] };
  P.sheet = {
    get el() { return sh.el; },
    isOpen: (id) => !!(sh.el && (!id || sh.el.id === id)),
    open(trigger, { html, label, id, attrs } = {}) {
      if (!sh.el) {
        const el = document.createElement('aside');
        el.className = 'sheet proto-sheet';
        el.id = id || 'proto-sheet';
        el.setAttribute('role', 'complementary');
        if (label) el.setAttribute('aria-label', label);
        for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
        el.innerHTML = html;
        P.upgradeTips(el);
        $('#frame').appendChild(el);
        sh.el = el;
      }
      if (trigger) {
        if (!sh.triggers.includes(trigger)) sh.triggers.push(trigger);
        trigger.setAttribute('aria-expanded', 'true'); trigger.setAttribute('aria-controls', sh.el.id);
      }
      return sh.el;
    },
    close() {
      if (!sh.el) return;
      const el = sh.el, trigs = sh.triggers.slice();
      sh.el = null; sh.triggers = [];
      for (const t of trigs) if (t.isConnected) t.setAttribute('aria-expanded', 'false');
      for (const t of $$(`[aria-controls="${CSS.escape(el.id)}"]`)) t.setAttribute('aria-expanded', 'false'); // 重画过的触发器（卡片刷新后的新按钮）也一起改
      const hadFocus = el.contains(document.activeElement);
      P.leave(el);
      if (hadFocus) { const back = trigs.reverse().find((t) => P.isShown(t)); if (back) back.focus({ preventScroll: true }); else P.focusMain(); }
    },
  };
  P.actions['sheet-close'] = () => P.sheet.close();

  // ------------------------------------------------------------------ 行内确认（.inline-confirm）：不删数据的动作（终止本轮运行）；删除类走同一弹层就地切换的统一确认
  let ic = null; // { box, btn, onCancel }
  P.inlineConfirm = function inlineConfirm(btn, { text, confirm = '确认', cancel = '取消', label = '确认', onConfirm, onCancel }) {
    P.inlineConfirm.cancel(false);
    const box = document.createElement('div');
    box.className = 'inline-confirm';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', label);
    box.innerHTML = `<p class="inline-confirm__text" role="alert"><span class="icon i-triangle-alert" aria-hidden="true"></span>${esc(text)}</p><div class="inline-confirm__actions"><button class="btn btn--secondary btn--28" type="button" data-ic="yes">${esc(confirm)}</button><button class="btn btn--tertiary btn--28" type="button" data-ic="no">${esc(cancel)}</button></div>`;
    btn.replaceWith(box);
    ic = { box, btn, onCancel };
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ic]'); if (!b) return;
      e.stopPropagation();
      if (b.dataset.ic === 'no') { P.inlineConfirm.cancel(true); return; }
      const cur = ic; ic = null;
      if (onConfirm) onConfirm(cur.box);
    });
    $('[data-ic="yes"]', box).focus({ preventScroll: true });
    return box;
  };
  P.inlineConfirm.cancel = function (restoreFocus) {
    if (!ic) return;
    const cur = ic; ic = null;
    if (cur.box.isConnected) cur.box.replaceWith(cur.btn);
    if (restoreFocus && P.isShown(cur.btn)) cur.btn.focus({ preventScroll: true });
    if (cur.onCancel) cur.onCancel();
  };
  P.inlineConfirm.pending = function (box, text) {
    box.className = 'inline-confirm inline-confirm--pending';
    box.removeAttribute('aria-label');
    box.removeAttribute('role');
    box.innerHTML = `<p class="inline-confirm__text" role="status"><span class="icon icon--spin i-loader-circle" aria-hidden="true"></span>${esc(text)}</p>`;
    P.focusMain();
  };
  P.hook('escape', () => { if (ic && ic.box.isConnected && ic.box.contains(document.activeElement)) { P.inlineConfirm.cancel(true); return true; } return undefined; });

  // ------------------------------------------------------------------ 横幅栈（.banner-stack）：阻断 > 治理 > 提示；最多 2 条 +「还有 N 条提示」；× / 今天不再提示 = 本次会话隐藏
  // 数据：P.world.banners = [{ id, level: 'block' | 'govern' | 'info', title, text, action: { label, view?, act? }, dismiss: 'close' | 'today' }]（F-WB-BANNER 填）
  const LEVEL = { block: { cls: 'banner--fail', icon: 'i-octagon-alert', sr: '阻断', rank: 0 }, govern: { cls: 'banner--warn', icon: 'i-triangle-alert', sr: '治理', rank: 1 }, info: { cls: 'banner--info', icon: 'i-info', sr: '提示', rank: 2 } };
  // hidden：id → 关闭方式。阻断类（×）只在本次会话、且只到判定消失为止——消失后再次命中要重新出现（REQ-WB-012，第四段）；
  // 治理类「今天不再提示」在原型里按本次会话 = 当天，判定先消失又复现也不再弹
  const bannerUi = { expanded: false, hidden: new Map() };
  P.banners = {
    ui: bannerUi,
    list() {
      const all = P.world.banners || [];
      for (const [id, how] of bannerUi.hidden) if (how !== 'today' && !all.some((b) => b.id === id)) bannerUi.hidden.delete(id);
      return all.filter((b) => !bannerUi.hidden.has(b.id)).sort((a, b) => LEVEL[a.level].rank - LEVEL[b.level].rank);
    },
    render() {
      const host = $('#shell-main');
      if (!host || P.ui.loading || P.gated) return;
      let stack = $(':scope > .banner-stack', host);
      const list = P.banners.list();
      if (!list.length) { if (stack) stack.remove(); return; }
      const cur = P.ui.route.view;
      const shown = bannerUi.expanded ? list : list.slice(0, 2);
      const rest = list.slice(2);
      let html = shown.map((b) => {
        const L = LEVEL[b.level];
        const act = b.action && b.action.view !== cur ? `<button class="btn btn--secondary btn--32" type="button" data-action="banner-act" data-banner="${esc(b.id)}" data-fk="bn-act:${esc(b.id)}">${esc(b.action.label)}</button>` : '';
        const dis = b.dismiss === 'today'
          ? `<button class="btn btn--tertiary btn--32" type="button" aria-label="今天不再提示「${esc(b.title)}」" data-action="banner-hide" data-banner="${esc(b.id)}" data-fk="bn-hide:${esc(b.id)}">今天不再提示</button>`
          : b.dismiss === 'close' ? `<button class="btn btn--tertiary btn--24 btn--icon" type="button" aria-label="关闭「${esc(b.title)}」提示" data-tip="关闭" data-action="banner-hide" data-banner="${esc(b.id)}" data-fk="bn-hide:${esc(b.id)}"><span class="icon i-x" aria-hidden="true"></span></button>` : '';
        return `<div class="banner ${L.cls}" role="alert"><span class="icon ${L.icon}" aria-hidden="true"></span><span class="u-sr-only">${L.sr}</span><p class="banner__body"><span class="banner__title">${esc(b.title)}</span>${b.text ? `<span class="banner__text">${esc(b.text)}</span>` : ''}</p><div class="banner__end">${act}${dis}</div></div>`;
      }).join('');
      // 「还有 N 条提示」：行里带被收起的标题（f-wb-banner-03；读屏名「还有 N 条提示：<标题>」），点开展开全部、再点收起（aria-expanded 跟着变）
      if (rest.length) html += bannerUi.expanded
        ? `<button class="banner-stack__more" type="button" aria-expanded="true" aria-label="收起，只显示前 2 条提示" data-action="banner-more" data-fk="bn-more"><span class="icon i-chevron-down" aria-hidden="true"></span>收起</button>`
        : `<button class="banner-stack__more" type="button" aria-expanded="false" aria-label="${esc(`还有 ${rest.length} 条提示：${rest.map((b) => b.title).join('、')}`)}" data-action="banner-more" data-fk="bn-more"><span class="icon i-chevron-down" aria-hidden="true"></span>还有 ${rest.length} 条提示<span class="banner-stack__more-names">${esc(rest.map((b) => b.title).join('、'))}</span></button>`;
      if (!stack) {
        stack = document.createElement('div');
        stack.className = 'banner-stack';
        stack.setAttribute('role', 'region');
        stack.setAttribute('aria-label', '全局提示');
      }
      const header = $(':scope > .header', host);
      if (header && stack.previousElementSibling !== header) header.after(stack);
      if (stack.dataset.html !== html) { stack.innerHTML = html; stack.dataset.html = html; P.upgradeTips(stack); }
    },
  };
  P.hook('main:refreshed', () => P.banners.render());
  P.actions['banner-more'] = () => { bannerUi.expanded = !bannerUi.expanded; P.banners.render(); const b = $('[data-fk="bn-more"]'); if (b) b.focus(); };
  P.actions['banner-hide'] = (a) => {
    const b = (P.world.banners || []).find((x) => x.id === a.dataset.banner);
    bannerUi.hidden.set(a.dataset.banner, b && b.dismiss === 'today' ? 'today' : 'close');
    P.banners.render(); P.focusMain();
    if (b) P.announce(b.dismiss === 'today' ? `今天不再提示「${b.title}」` : `已关闭「${b.title}」提示`);
  };
  P.actions['banner-act'] = (a) => {
    const b = (P.world.banners || []).find((x) => x.id === a.dataset.banner);
    if (!b || !b.action) return;
    if (b.action.act) b.action.act(a); else if (b.action.view) P.go(b.action.view);
  };

  // ------------------------------------------------------------------ 对话框内多视图（同一个 .dialog 就地换内容）与返回链
  // views：{ 名称: (args, ctl) => ({ html, focus?, init?(box) }) }；html = 对话框内层（header + body + footer + 关闭按钮）
  // ctl.show(name, args, opts)  换到某个视图（不入返回链）；ctl.push(name, args, { returnFk })  进下一层，记下回来时把焦点还给谁；ctl.back()
  P.dialogViews = function dialogViews(m, views) {
    const stack = [];
    const ctl = {
      m, current: null, args: null,
      show(name, args, opts) {
        const v = views[name](args || {}, ctl);
        ctl.current = name; ctl.args = args || {};
        const box = m.box;
        box.innerHTML = v.html;
        box.classList.remove('is-scrolled'); // 第五段（R1-13）：换视图后正文从顶上开始，头部分隔线跟着撤
        const title = $('.dialog__title', box);
        if (title) { if (!title.id) title.id = `${box.dataset.dialog || 'dlg'}-title`; box.setAttribute('aria-labelledby', title.id); }
        const sub = $('.dialog__subtitle', box);
        if (sub && sub.id) box.setAttribute('aria-describedby', sub.id); else box.removeAttribute('aria-describedby');
        P.upgradeTips(box);
        if (v.init) v.init(box);
        const focusSel = (opts && opts.focus) || v.focus;
        if (opts && opts.focusFk) {
          const el = $(`[data-fk="${CSS.escape(opts.focusFk)}"]`, box);
          if (el && !el.disabled) { el.focus({ preventScroll: true }); return ctl; }
        }
        P.focusInto(box, focusSel);
        return ctl;
      },
      push(name, args, { returnFk } = {}) { stack.push({ name: ctl.current, args: ctl.args, returnFk }); return ctl.show(name, args); },
      back() { const prev = stack.pop(); if (!prev) return ctl; return ctl.show(prev.name, prev.args, { focusFk: prev.returnFk }); },
      get depth() { return stack.length; },
      refresh(opts) { return ctl.show(ctl.current, ctl.args, opts); },
    };
    return ctl;
  };

  // ------------------------------------------------------------------ 「原型说明」弹层：说明 / 场景两页（tablist）。场景页按组列出各流程登记的 P.scenario，选了立即生效
  P.openAbout = function openAbout(returnTo, tab) {
    const html = `<div class="dialog dialog--576" role="dialog" aria-modal="true" aria-labelledby="ab-title" data-dialog="about"><div class="dialog__header"><h2 class="dialog__title" id="ab-title">原型说明</h2><p class="dialog__subtitle">把 v2 试点与补全稿串起来的交互原型（设计稿本身仍然零 JS）</p>
<div class="tabs tabs--40 proto-about__tabs" role="tablist" aria-label="原型说明"><button class="tab" type="button" role="tab" id="ab-tab-about" aria-controls="ab-panel-about" data-ab="about" data-fk="ab-tab-about">说明</button><button class="tab" type="button" role="tab" id="ab-tab-scn" aria-controls="ab-panel-scn" data-ab="scn" data-fk="ab-tab-scn">场景</button></div></div>
<div class="dialog__body proto-about" id="ab-panel-about" role="tabpanel" aria-labelledby="ab-tab-about">${aboutHtml()}</div>
<div class="dialog__body proto-about proto-scn" id="ab-panel-scn" role="tabpanel" aria-labelledby="ab-tab-scn" hidden>${scenarioHtml()}</div>
<div class="dialog__footer"><a class="btn btn--secondary btn--32" href="https://claude.ai/artifact/AH5ctp5L6swGEhNWPTfyfu"><span class="icon i-arrow-left" aria-hidden="true"></span>返回画廊</a><div class="dialog__footer-end"><button class="btn btn--secondary btn--32" type="button" data-dlg="cancel">知道了</button></div></div><button class="btn btn--tertiary btn--28 btn--icon dialog__close" type="button" aria-label="关闭" data-dlg="cancel"><span class="icon i-x" aria-hidden="true"></span></button></div>`;
    const m = P.openModal(html, { kind: 'about', returnTo, initialFocus: '[data-dlg="cancel"]' });
    const box = m.box;
    const select = (which, focus) => {
      for (const t of $$('[role="tab"]', box)) { const on = t.dataset.ab === which; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; if (on && focus) t.focus(); }
      $('#ab-panel-about', box).hidden = which !== 'about';
      $('#ab-panel-scn', box).hidden = which !== 'scn';
    };
    select(tab === 'scn' ? 'scn' : 'about', false);
    if (tab === 'scn') $('[data-ab="scn"]', box).focus();
    box.addEventListener('click', (e) => {
      if (e.target.closest('[data-dlg="cancel"]')) { P.closeModal(m); return; }
      const t = e.target.closest('[role="tab"]'); if (t) select(t.dataset.ab, true);
    });
    box.addEventListener('keydown', (e) => {
      const t = e.target.closest('[role="tab"]'); if (!t) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') { e.preventDefault(); select(t.dataset.ab === 'about' ? 'scn' : 'about', true); }
    });
    box.addEventListener('change', (e) => {
      const s = e.target.closest('select[data-scn]'); if (!s) return;
      P.scenario.set(s.dataset.scn, s.value);
      const d = P.scenario.defs().find((x) => x.key === s.dataset.scn);
      const o = d && d.options.find((x) => x[0] === s.value);
      P.announce(`场景：${d ? d.label : s.dataset.scn} = ${o ? o[1] : s.value}`);
    });
    return m;
  };
  P.actions.about = (a) => P.openAbout(a);
  function scenarioHtml() {
    const defs = P.scenario.defs();
    const groups = [];
    for (const d of defs) { let g = groups.find((x) => x.name === d.group); if (!g) groups.push((g = { name: d.group, items: [] })); g.items.push(d); }
    const body = groups.map((g) => `<section class="proto-scn__group" aria-labelledby="scn-g-${esc(g.name)}"><h3 id="scn-g-${esc(g.name)}">${esc(g.name)}</h3><div class="proto-scn__grid">${g.items.map((d) => `<label class="field proto-scn__field"><span class="field__label">${esc(d.label)}${d.once ? '<span class="field__optional">（只作用于下一次）</span>' : ''}</span><span class="select select--32"><select class="select__control" data-scn="${esc(d.key)}" data-fk="scn:${esc(d.key)}">${d.options.map(([v, l]) => `<option value="${esc(v)}"${P.scenario.get(d.key) === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select><span class="icon i-chevron-down select__icon" aria-hidden="true"></span></span></label>`).join('')}</div></section>`).join('');
    return `<p>用来切换失败分支与特殊状态（克隆失败、拉取要凭证、启动卡住…）。标「只作用于下一次」的，用过一次就复位成第一项；其余一直生效到你改回来。也可以在地址里写 <code class="code">#overview&amp;scenario=launch:stuck,clone:network</code>（读完会从地址里抹掉），<code class="code">&amp;speed=10</code> 让时钟快 10 倍。</p>${body}`;
  }
  function aboutHtml() {
    const T = P.TIMING;
    return `<div><h3>能点的地方</h3><ul class="bullets">
<li>侧栏导航切页；树里点任务换主区，点项目行展开 / 收起；${esc(P.KBD_PALETTE)} 命令面板、${esc(P.KBD_RAIL)} 收起侧栏、外观、面包屑切换器、项目区筛选。</li>
<li>项目：新建项目（Git 仓库 / 空项目，克隆进度随时钟推进）、克隆中 / 克隆失败的处置（重试克隆、改为空项目、取消克隆）、项目信息浮层与拉取最新代码、项目详情、删除项目、保留下来的成果。</li>
<li>任务：新建任务弹层的全部状态（含可选的「镜像」一栏：默认平台预制镜像，已禁用 / 无效的置灰写原因，列表读不到只降级）、发起后的启动流程（创建中 → 准备中四阶段 → 运行中，或可能卡住 / 失败；进度卡与结果卡写「镜像：…」）、重新发起（预选原任务的镜像）、检查镜像地址（定位那个任务用的那张）、复制诊断信息、环境类错误的 [运行诊断]、停止与启动、销毁过程（删除中 → 移除）、无头任务的只读输出与终止。</li>
<li>凭证：新建任务里的凭证闸门与登录面板（设备码 / 授权码 / API Key，到期、等太久、被拒、网络异常、起不来），凭证页卡片里的同一个面板；切换生效方式、删除 Agent 凭证（如实列出会被销毁的任务）、Git 凭证（测试连接、配置 HTTPS Token / SSH 密钥、更换、删除）；凭证页的骨架、读取失败、搜索、有效期与从克隆失败跳来的回程条。访问口令门在「场景 › 首次启动」里打开。</li>
<li>镜像：注册新镜像（验证的三级结论、地址格式提示、改地址即作废、已注册时定位）与镜像要求侧弹层，运行参数编辑，展开 / 复制版本号、检查更新与对比弹层、重新验证、切换到此版本，禁用 / 启用 / 删除（被任务引用时打开即拦；禁用预制镜像先确认），预制镜像下载到本机，空态与列表读不到。</li>
<li>系统状态：本机资源（直接打开先出本页骨架、[刷新]、告警 / 严重 / 成果过量、[清理成果] 打开跨项目的「保留下来的成果」）、连接卡、沙箱环境（正常 / 不健康）、出网代理（保存中 → 格式不对 / 已保存 +「已配置」，读不到时不给表单）；一键诊断（连接中 → 逐项到达 → 汇总，中断与连接即断，展开、复制命令、导出日志，⌘K「运行诊断」）；审计流（类别 / 仅告警 / 起止、行内详情、按任务看完整时间线、加载更早、实时中断与断层、三种空态、加载失败）；离线横幅与「无法确认平台状态」横幅。</li>
<li>首次启动：启动检查中 → 初始化向导五步（联网检查：上次结果、3 秒节流、离线要显式确认；代理配置；沙箱镜像检查链与自动下载到本机；模型帐号用同一个登录面板；本机资源）→ [确认，开始使用]（写入失败、网络断开、写入时发现离线回第 1 步、已经初始化过了直接放行）→ 进工作台。入口：「场景 › 首次启动 › 初始化状态」或实例菜单「演示初始化向导…」（换成首次启动的世界：没有项目、两个 Agent 都没配）。</li>
<li>工作台外壳：还没有任何项目时的欢迎态（两张入口卡打开新建项目并预选来源，「场景 › 工作台 › 项目」切过去）；全局横幅栈（阻断 > 治理：无法确认平台状态、离线、自动化需关注（按全部项目判定，任何页面都出）、磁盘快满 / 已满、保留下来的成果过多、Agent 帐号登录即将过期 / 已过期；最多显示 2 条 +「还有 N 条提示」，× 只管本次会话，「今天不再提示」）与顶栏「后端不可用」；离线时所有发起入口置灰说原因；终端连接条（正在重连第 n 次 → 次数用完 [手动重连]、握手被拒、会话已结束）与侧栏「实时更新已中断」（列表停在最后已知状态，恢复后补齐）；⌘K 动作（新建项目、注册新镜像、运行诊断、自动化规则、保留下来的成果；不放破坏性动作）；地址或后退指向已不在的对象时回落总览并说一句；总览按状态筛选与左侧树共用一份；终端 [复制]（三句反馈）。</li>
<li>自动化规则（项目「⋯」、项目空态「设置自动化规则 →」、⌘K、横幅 [查看这些规则]）：一个弹层四个视图——列表（四种规则状态、关掉 / 开启 / 重新开启即时生效、20 条上限、空态、读取失败）、新建 / 编辑（字段错误改过或失焦才亮、紧贴字段，时区快照与「已修改」，Webhook [测试连接]，保存中 / 保存失败）、详情与运行历史（六类结果、[查看全部] / [加载更多]、运行详情与 [打开任务]、历史为空 / 读取失败）、删除确认（Esc 回详情）。</li>
</ul></div>
<div><h3>时间与场景</h3><p>所有过程共用一个时钟，只在有进行中的对象时走。画面上写真实口径，原型压缩了时长：克隆约 ${T.clone / 1000} 秒、启动四段约 ${Math.round((T.phase.pending + T.phase['preparing-workspace'] + T.phase.creating + T.phase.starting) / 1000)} 秒、「可能卡住」原型按 ${T.stuck / 1000} 秒判（产品口径暂行 300 秒，画面不写阈值）、停止 ${T.stop / 1000} 秒、启动 ${T.start / 1000} 秒、删除中 ${T.destroy / 1000} 秒；设备码倒计时从 09:59 起（画面口径：有效期以后端给的到期时间为准）、点 [打开授权页] 后约 ${T.deviceAuthorize / 1000} 秒连上，口令连错 5 次锁 ${T.passcodeLock / 1000} 秒（画面写「约 5 分钟」），预制镜像下载每秒推进 7%。系统状态：[刷新] ${T.sysRefresh / 1000} 秒（场景「每次进入先出骨架」${T.sysLoad / 1000} 秒），读取失败后 ${T.sysPoll / 1000} 秒自动重取一次，诊断 ${T.diagConnect / 1000} 秒拿到清单、一轮约 ${(T.diagConnect + T.diagFirst + 8 * T.diagStep) / 1000} 秒（有失败时第 ⑥ 项 ${T.diagTimeout / 1000} 秒才回），出网代理保存 ${T.proxySave / 1000} 秒。向导：启动检查 ${T.bootCheck / 1000} 秒，联网检查 ${T.connCheck / 1000} 秒、两次之间 ${T.recheckThrottle / 1000} 秒节流，镜像检查 ${T.chainCheck / 1000} 秒，写入 ${T.initFinish / 1000} 秒。终端断线后每 ${T.termReconnect / 1000} 秒重连一次（画面口径：退避 0.5 → 30 秒封顶），8 次后次数用完。自动化规则：启停 ${T.autToggle / 1000} 秒、保存 ${T.autSave / 1000} 秒、[测试连接] ${T.autTest / 1000} 秒（画面口径最多 10 秒）、删除 ${T.autDelete / 1000} 秒。失败分支在「场景」页里切。</p></div>
<div><h3>快捷键与「终端优先」</h3><p>⌘K（macOS）/ Ctrl K（其它平台，终端外）/ Ctrl Shift K（终端里）打开命令面板，⌘B / Ctrl B（终端外）收起侧栏，Esc 关最上层浮层，↑ ↓ Enter 在菜单与面板里移动和执行，标签上 ← → 切换终端，总览里 / 聚焦搜索。终端有焦点时只有 ⌘ 组合（以及 Ctrl Shift K）归平台，其余按键都交给终端；Esc 只关最上层浮层，没有浮层时交给终端。</p></div>
<div><h3>本原型不做的（照实说明）</h3><p>终端画布是静态画面：键入不会送到 Agent，审批提示答不了，「等待你输入 → 运行中」的转变演示不了（真实产品里由终端 WebSocket 承担；在画布里敲字时旁边会照实说一句）。窄屏（&lt; 640）侧栏固定为图标轨，没有抽屉（按「展开侧栏」会说原因）。项目重命名、归档 / 解档（后端没有接口，未排期）；系统状态里的访问口令管理区块（D9 推荐延后）；任务深链 <code class="code">?taskId=</code>（计划中，原型用自己的 <code class="code">#task-&lt;id&gt;</code>）；总览的「列表」视图（Q-DS-30 A 去掉了「卡片 / 列表」分段）。首屏骨架期顶栏「新任务」「更多操作」只置灰、不写原因，⌘K「清屏」在没有终端时禁用——这几处按设计如此。数据只在本页内存里，刷新即复原；主题与侧栏收起会记住。</p></div>
<div><h3>原型先行</h3><p>下面这些行为产品文档已经定了，但实现还没做或做偏了（gap/product 里标「未实现」「偏离」）；原型按文档演示，开发以 gap/product 的验收标准为准：</p><ul class="bullets">
<li>项目：空项目提交即就绪（REQ-PRJ-006）、未就绪项目的组头（011）、克隆中主区进度卡（012）、未就绪原因分两句（016）、项目信息浮层（020）、拉取结果（022）、删除项目的拦截 / 清单 / 删除中（040、041、043）、成果就地确认删除（053）、成果跨项目视图（056）。</li>
<li>发起任务：「镜像」一栏（REQ-LCH-004，含门口拒绝）、弹层自己的加载与失败（006）、同步失败留在弹层（007）、开不了终端（008）、可能卡住（013）、取消并删除（014，从已停止重新启动的给「留下来」）、任务上看得到用的是哪张镜像（017）。</li>
<li>任务生命周期：异常结果卡与环境类错误的 [运行诊断]（REQ-SBX-001）、重新发起预选镜像（003）、检查镜像地址定位那个任务用的那张（004）、复制诊断信息带镜像一行（005）、停止与启动全套（010–014）、删除中与删当前任务（020、021）、异常任务销毁照常给「留下来」（022）、无头任务只读输出（031）。</li>
<li>登录面板：点了才开始、收起即取消（REQ-AUTH-003），设备码轮询网络异常时 [重试] 不换码（004），授权码的说法与被拒（006），API Key 被拒给原因、去处句点名厂商（007），「已连上」停留（008），错误按码说人话（011）。</li>
<li>凭证：删除确认只说「删除」、打开即如实列出会被销毁的任务（REQ-CRD-001、002），只销毁本 Agent 注入过这一份的任务（003），配好即生效的规则（011），单选确认前不动（012），删除 Git 凭证的统一确认（026）。</li>
<li>访问口令：全屏口令门、门下不挂工作台、解锁后重跑首屏（REQ-ACC-003），口令卡的验证中 / 口令不对（004），连错 5 次锁定、按分钟说（005）。</li>
<li>镜像：三级结论（REQ-IMG-003），镜像要求侧弹层（007），请求本身失败原位说（008），50 条上限写原因（013），重新验证不乐观、判无效也不自动禁用（023），切换不弹确认（024），运行参数跟着版本走（026），禁用 / 启用（030、031），禁用预制镜像先确认、徽标写「预制」（032），删除确认与被拦（033、034），预制镜像下载入口与完成（040、043），空态说明句（051），列表读不到（052）。</li>
<li>系统状态：下一步按触发维度说（REQ-SYS-011、012），成果占用、超量一行与 [清理成果] 打开跨项目视图（020、021），「凭证未配置」用停用徽标（030），终端连接不挂「正常」、两个查询没回来 REST 写「未知」（040），出网代理格式校验、成功一句与「已配置」、读不到不给表单、说明只承诺联网检查（060），直接打开出本页骨架（070），主数字「还能再发 N 个任务」与口径句（071，待契约 DR-08），后端不可达时横幅不自指、代理不给表单（075）。</li>
<li>诊断与审计：连接中那一句（REQ-DIA-001），9 项都有序号（002），「超时未响应」单列、中断时其余项「未返回」、连接即断那一句（003、040），汇总在卡内首行原位播报（040）；审计类别写「任务」（REQ-AUD-002），按任务看时间线的 chip 与 ×、行尾那一列收起、摘要说人话（003），起止写人读的时间、起晚于止就地提示不重查（020）。</li>
<li>首次启动：口令门之下不挂工作台、解锁后重跑判定（REQ-DEP-002），去处写「系统状态」（003），「第 N / 5 步」与走过没达成的读屏（004），「镜像下载源」（006），全部超时不算离线（007），离线确认留痕（008），代理失败按码说、说明句随结果换（009），镜像检查完成前不给下一步、「第 N 项（共 5 项）」、停止点之后「未检查」（010），百分比只在行尾（011），拦截说明只说一处（012、013），面板停在空闲态（013），不提进度条（014），确认按钮在页脚条（015），两种 409 分流与网络断开的前端句（016）。</li>
<li>工作台外壳：欢迎态两张入口卡与「先新建一个项目」（REQ-WB-001–003），横幅在主列顶部、最多 2 条 +「还有 N 条」、阻断按会话关 / 治理「今天不再提示」、动作指向当前页时不出、「自动化需关注」按全部项目判定并点名项目与规则（010–013），离线置灰全部发起入口（014），三种治理横幅（015），⌘K 动作组与同义词（030–032），对象已不在时回落总览并说一句（040），总览筛选与树共用、去掉「卡片 / 列表」（050、051），实例菜单不放「文档」（060），骨架期「更多操作」也置灰（061），剪贴板不可用时 [复制] 也有反馈（063）；/events 断开时侧栏如实说、恢复后重同步（REQ-EVT-001、002）。</li>
<li>自动化规则：Agent 写显示名（REQ-AUT-003），上限时 [新建规则] 能聚焦、原因在页脚（005），列表读取失败 + [重试]（006），并发「还没开放」（010），名称 / 描述长度与「改过或失焦才亮」、错误紧贴字段（013），保存失败进页脚条、断网句（014），[删除] 红字、任务内容预览能聚焦（020），运行行 aria-expanded（021），历史读不到写「共 — 次」+ [重试]（022），[查看原因] 滚进视野并把焦点给 [收起]（023），删除确认是同一弹层的第四个视图（024）。</li>
</ul></div>
<div><h3>示例世界</h3><p>acme-web 7 个任务（2 个等你输入、3 个运行中其中 1 个空闲 1 个是自动化跑的无头任务、1 个启动失败、1 个超时未响应），示例项目 3 个已停止的任务；acme-api 克隆失败、docs-site 还没有任务、infra-scripts 正在克隆（42%，慢速推进）。保留下来的成果 3 份（示例项目 2、acme-web 1），自动化规则 acme-web 4 条（已开启 / 已关掉 / 被放慢 / 自动停用各一条，「每天凌晨跑一遍回归」42 次运行、六类结果都有）、示例项目 1 条、docs-site 没有规则；「自动化需关注」按全部项目判定（用户拍板 Q-WB-01 B），示例世界里它在每一页都该出——默认按「今天已点过『今天不再提示』」处理（同稿件），「场景 › 自动化规则」改成「还没点过」就能看到它（说明点名 acme-web 的两条规则）。凭证：Codex 帐号登录（a***@example.com，剩 26 天，当前使用）+ API Key（sk-…f3a9），Claude Code 两种都没配，Git 凭证一份 HTTPS Token（ghp_…ab12，白名单 github.com）。镜像 3 张：预制 sandbox（验证通过）、ml-agent（有警告，补 e2e 用例与跑一遍示例测试用的就是它，上游有新版本）、just-registered（无效）；其余任务用平台预制镜像。访问口令门默认不出；示例口令 AB12-CD34-EF56（手测也认 demo），真实产品里口令只在首次启动的服务日志里给一次（f-acc-unlock-01）。系统状态：这台机器 10 核 / 32 GB / 500 GB，已登记的任务按示例世界算（没异常、没在删除的，含已停止的）、本机最多 11 个（待契约示例值），「成果占用」就是上面那 3 份保留下来的成果；出网代理没配；审计流 11 条（14:28 起往前）。首次启动的世界：没有项目、任务、成果与 Git 凭证，两个 Agent 都没配，预制镜像没下载到本机，审计为空，上次联网检查 2026-10-01 18:40:12 全部连得上。</p></div>
<div><h3>访问口令</h3><p>口令门在「场景 › 首次启动 › 访问口令」里打开。解锁后会话固定 7 天（从输对那一刻算，不随使用顺延；按浏览器记，换浏览器或无痕窗口要重新输入）。换口令有两条路：部署配置改 <code class="code">ACCESS_PASSCODE</code> 后重启；或者解锁后调 <code class="code">PUT /api/system/access-passcode {"action":"regenerate"}</code>（新口令只在那次响应里给一次）。换口令默认不影响已经登录的浏览器（各自到 7 天期满）；要让它们同时失效（比如口令泄露了），接口那条路在请求里加 <code class="code">"signOutAllSessions": true</code>（参数名由实现定），环境变量那条路同时把 <code class="code">PASSCODE_COOKIE_SECRET</code> 换成新值再重启（用户拍板 Q-ACC-01 C；REQ-ACC-006、007）。界面里没有换口令的入口——口令管理区块延后（U-112），原型不为这一项新造页面；同样的说明在首次启动的服务日志横幅（f-acc-unlock-01）与部署说明里。</p></div>
<div><h3>说明文档</h3><p>模块、公共函数、场景与每个流程怎么走，见 gap/proto/notes/wiring.md。</p></div>`;
  }
})();
