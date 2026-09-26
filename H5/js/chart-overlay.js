/**
 * chart-overlay.js — 图表浮动窗
 *
 * 为什么需要它：分镜演示讲到"看径向分布 / 截面密度"时，那两张图在页面**底部**，
 * 学生盯着三维视图根本看不到它们 —— 讲解与画面脱节。演示驱动时把对应图表放大到
 * 浮窗里，讲解与图就同时可见了。
 *
 * 为什么不用现成的两个浮层：
 *   · reference-table.js 的 .reftable-zoom 只认 <img>，而且是"每次新建 DOM、关闭即
 *     removeChild"，没有任何引用留存 —— 做不了 resize 时重画，也做不了被脚本切换目标。
 *   · settings.js 的 .agent-overlay 是**模态**（inset:0 遮罩 + 背景模糊），会把三维视图
 *     整个挡住，而这里恰恰要"边看三维边看图"。
 *   故取后者的"惰性单例 + .show 类切换 + 只点盒子外才关"，去掉模态遮罩的视觉阻断
 *   （外加 pointer-events: none，让浮窗之外的点击穿透到三维，键盘/滚轮照常可用）。
 *
 * 内容用**新 canvas + 重绘**，不搬 DOM、也不做像素快照：
 *   · 搬 DOM 要处理"尺寸/重绘归谁管"，而 cards 的绘制函数都从 canvas 的 clientWidth
 *     读尺寸，搬来搬去容易漏掉重绘；
 *   · 快照会定格，无法支持浮窗内的缩放平移 —— 而那正是截面图刚加上的能力。
 */
window.ChartOverlay = (function () {
  'use strict';

  // 浮窗支持的目标。
  // ★ 球谐函数不在其中，而且**理由已经变了**：它原先是一个独立的 three.js 小场景
  //   （单例，没法"再画一份"），现已并入主三维视图 —— 也就是说它本身就占着主舞台，
  //   不需要再被"搬到三维旁边"（那正是浮窗存在的意义，见本文件开头）。
  //   下面那张 Θ/Φ 卡片倒是普通 2D canvas，技术上能支持，留给后续。
  const TARGETS = {
    radial: { title: '径向分布' },
    section: { title: '截面密度' },
  };

  let overlay = null, box = null, titleEl = null, canvas = null;
  let cur = null, rafId = null, interactionsBound = false;

  function el(tag, cls) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    return d;
  }

  /** 惰性单例：只建一次，之后靠 .show 类开合（与 settings.js 的 overlay 同一套路） */
  function build() {
    if (overlay) return;
    box = el('div', 'chart-overlay-box');
    const head = el('div', 'chart-overlay-head');
    titleEl = el('span', 'chart-overlay-title');
    const closeBtn = el('button', 'chart-overlay-x');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.title = '关闭（Esc）';
    closeBtn.addEventListener('click', close);
    head.appendChild(titleEl);
    head.appendChild(closeBtn);
    canvas = el('canvas', 'chart-overlay-canvas');
    box.appendChild(head);
    box.appendChild(canvas);
    overlay = el('div', 'chart-overlay');
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // 只观察浮窗内容盒 —— **不要**观察 body（layout.js 里有自激循环的注释警告）
    if (window.ResizeObserver) {
      new ResizeObserver(scheduleRedraw).observe(box);
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isOpen()) close();
    });
  }

  /** rAF 合并重画：放大后 drawSection 会做 G² 次 psiDensity（G 随缩放升到 512），
   *  拖窗口时逐帧重算会明显卡顿 */
  function scheduleRedraw() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = null; redraw(); });
  }

  function redraw() {
    if (!cur || !canvas) return;
    const A = window.OrbitApp;
    if (!A || !A.drawChartInto) return;
    A.drawChartInto(cur, canvas);
  }

  /**
   * 打开浮窗并切到指定图表。
   * @param {'radial'|'section'} target
   */
  function open(target) {
    if (!TARGETS[target] || !window.OrbitApp) return false;
    build();
    if (cur !== target) { cur = target; titleEl.textContent = TARGETS[target].title; }
    overlay.classList.add('show');
    // 截面图在浮窗里同样可缩放/平移（sectionView 是 charts.js 的模块状态，与卡片共用）。
    // 只绑一次 —— 重复绑定会让一次拖拽走两遍。
    if (!interactionsBound && window.OrbitApp.attachChartInteractions) {
      interactionsBound = window.OrbitApp.attachChartInteractions('section', canvas, scheduleRedraw);
    }
    // 尺寸要等 .show 生效、布局完成之后才量得到，故走下一帧
    scheduleRedraw();
    return true;
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove('show');
    cur = null;
  }

  function isOpen() {
    return !!(overlay && overlay.classList.contains('show'));
  }

  return {
    open: open,
    close: close,
    isOpen: isOpen,
    target: () => cur,
    redraw: scheduleRedraw,
    TARGETS: TARGETS,
  };
})();
