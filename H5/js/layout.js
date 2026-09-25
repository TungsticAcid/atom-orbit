/**
 * layout.js — 视口自适应：让三维画布"正好"落在浏览器窗口里
 *
 * 为什么需要它：
 *   三维视图的高度原先写死在 CSS 里（clamp(280px, 44vh, 470px)）。写死有两个毛病：
 *     · 在不同窗口高度下，画布要么撑不下、要么下方留一大片空白，怎么调都不"正好"；
 *     · 44vh 没有减去顶栏、卡片标题、内边距这些固定开销，所以"高度=窗口高"这个
 *       直觉上的等式从来就不成立。
 *
 * 做法：
 *   1. 量出画布顶端在**文档**中的位置（该值与画布自身高度无关 → 不会自激）；
 *   2. 用"真实可见高度 − 画布顶端位置 − 底部余量"作为画布高度；
 *   3. 通过 CSS 变量 --viewer-h 下发，CSS 侧只写 `height: var(--viewer-h, 44vh)`，
 *      变量没算出来之前还能用视口单位兜底（渐进增强，不是硬编码）。
 *
 * ★ 移动端注意：地址栏收起/展开会改变 innerHeight，但 visualViewport.height
 *   才是用户**真正看得到**的那块区域，所以优先用它。这也是"适应不同浏览器"的实质。
 */
window.ViewportFit = (function () {
  'use strict';

  const MIN_VIEWER_H = 220;      // 极端窗口下的保底：再小三维视图就没法用了
  const BOTTOM_GAP = 10;         // 画布底边与窗口底边之间留一点呼吸空间
  const MIN_CHANGE = 2;          // 高度变化小于此值就不折腾（避免反复触发重排）
  // 面板等高在 ≤ 这个宽度下不启用：那时栅格已切成单列，面板在三维视图**下面**，
  // 钉死高度只会让它变成一个带滚动条的窄条。
  const PANEL_SYNC_MIN_W = 1024;

  let lastH = 0;
  let lastPanelH = 0;
  let rafId = null;

  /** 用户真正能看到的高度（优先 visualViewport，回退 innerHeight） */
  function visibleHeight() {
    const vv = window.visualViewport;
    const h = (vv && vv.height) || window.innerHeight || 0;
    return Math.round(h);
  }

  /** 量出画布顶端在文档中的纵坐标；量不到就返回 null */
  function viewerTopInDocument() {
    const el = document.getElementById('viewer');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) return null;   // 还没布局
    return Math.round(r.top + (window.scrollY || window.pageYOffset || 0));
  }

  /**
   * 让右侧「量子数 / 显示模式」面板与三维卡片**等高**。
   *
   * 量的是 `.viewer-card` 的实际高度，下发给 `--panel-h`；CSS 侧只写
   * `height: var(--panel-h, auto)`，变量没算出来时按内容排布（渐进增强）。
   *
   * ★ 为什么不会自激（这是本函数唯一的风险点）：
   *   面板高度是从三维卡片**单向**量出来的，而 `.viewer-card` 带 `align-self: start`
   *   —— 它不会被同一行里更高的面板拉伸。所以"面板→栅格行高→三维卡片"这条回路
   *   在结构上就不存在。若哪天有人去掉那个 align-self，这里会开始振荡。
   * ★ 只在布局完成、拿到非零高度时才写，否则会把 --panel-h 钉成 0。
   */
  function syncPanelHeight() {
    const root = document.documentElement;
    if (window.innerWidth <= PANEL_SYNC_MIN_W) {
      if (lastPanelH !== -1) { lastPanelH = -1; root.style.removeProperty('--panel-h'); }
      return;
    }
    const card = document.querySelector('.viewer-card');
    if (!card) return;
    // 上一步刚设过 --viewer-h，这里 getBoundingClientRect 会强制一次同步布局，
    // 所以读到的就是算完后的新高度（不需要等下一帧）。
    const rect = card.getBoundingClientRect();
    const h = Math.round(rect.height);
    if (h < MIN_VIEWER_H) return;                 // 还没布局 / 退化状态，别写
    if (Math.abs(h - lastPanelH) < MIN_CHANGE) return;
    lastPanelH = h;
    root.style.setProperty('--panel-h', h + 'px');
  }

  function apply() {
    rafId = null;
    const vh = visibleHeight();
    const top = viewerTopInDocument();
    if (!vh || top == null) return;

    // 画布高度 = 可见高度 − 画布顶端位置 − 底部余量
    // （顶端位置里已经包含了顶栏、布局内边距、卡片内边距、卡片标题这些固定开销）
    let h = vh - top - BOTTOM_GAP;
    h = Math.max(MIN_VIEWER_H, Math.round(h));
    if (Math.abs(h - lastH) >= MIN_CHANGE) {
      lastH = h;
      document.documentElement.style.setProperty('--viewer-h', h + 'px');
    }
    // ★ 必须放在设 --viewer-h **之后**，且**不能**跟着上面的 if 一起 return ——
    //   窗口只变窄不变高时 --viewer-h 不变，但面板高度仍可能需要重算。
    syncPanelHeight();
  }

  /** 合并到下一帧再算，避免 resize 风暴里反复重排 */
  function schedule() {
    if (rafId) return;
    rafId = requestAnimationFrame(apply);
  }

  /**
   * 监视那些"会改变画布顶端位置、又不受画布高度影响"的元素。
   * ★ 刻意不观察 body —— 改画布高度会改 body 高度，观察 body 会形成自激循环。
   *   顶栏与卡片标题行的高度只由窗口宽度决定，观察它们是安全的。
   */
  function observeChrome() {
    if (!window.ResizeObserver) return;
    const ro = new ResizeObserver(schedule);
    ['.topbar', '.viewer-card .card-head'].forEach(function (sel) {
      const el = document.querySelector(sel);
      if (el) ro.observe(el);
    });
  }

  function init() {
    schedule();
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    if (window.visualViewport) {
      // 移动端地址栏收放 / 软键盘弹出走的是这条路径
      window.visualViewport.addEventListener('resize', schedule);
    }
    observeChrome();
    // 字体/KaTeX 加载完成后布局可能微调，补算一次
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(schedule).catch(function () {});
    }
    window.addEventListener('load', schedule);
  }

  return { init, apply, visibleHeight, _debug: () => ({ viewerH: lastH, panelH: lastPanelH, vh: visibleHeight() }) };
})();

// 自启动：本文件在 main.js **之前**加载，因此这里注册的 rAF 会排在
// main.js 首次 recompute/resize 之前，画布第一次绘制就是正确高度。
(function () {
  var start = function () { window.ViewportFit.init(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
