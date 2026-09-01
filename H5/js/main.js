/**
 * main.js — 主控制器：绑定 UI、管理状态、节流重绘
 *
 * 数据流：控件 change → readState() 收窄/夹紧量子数 → recompute()
 *        → 更新 3D（粒子云或等值面）→ 更新 2D 图表 → 更新 KaTeX 公式。
 * 交互：滑块用 120ms 防抖；分段按钮即时重算。
 */
(function () {
  'use strict';

  // ---- 状态 ----------------------------------------------------------------
  const state = {
    n: 3, l: 1, m: 0,
    mode: 'real',            // 'real' | 'complex'
    renderMode: 'points',    // 'points' | 'surface'
    level: 0.08,             // 等值面阈值（占峰值的比值）
    pointCount: 50000,
    plane: 'xz',             // 截面平面
    sectionMode: 'intensity',// 'intensity' | 'phase' | 'contour'
    angWhich: 'Y',           // 'Y' | 'Y2'
    radial: ['R', 'R2', 'D', 'D2'],
  };
  let lastFieldKey = null;
  const isMobile = window.matchMedia('(max-width: 768px)').matches;

  // ---- DOM ----------------------------------------------------------------
  const $ = (s) => document.querySelector(s);
  const els = {
    nSlider: $('#nSlider'), nVal: $('#nVal'),
    lSlider: $('#lSlider'), lVal: $('#lVal'),
    mSlider: $('#mSlider'), mVal: $('#mVal'),
    levelSlider: $('#levelSlider'), levelVal: $('#levelVal'), levelSet: $('#levelSet'),
    pointCountSlider: $('#pointCountSlider'), pointCountVal: $('#pointCountVal'), pointSet: $('#pointSet'),
    angularView: $('#angularView'),
    orbitTitle: $('#orbitTitle'), modeBadge: $('#modeBadge'),
    formulaTitle: $('#formulaTitle'), formulaBox: $('#formulaBox'), formulaNote: $('#formulaNote'),
    radialChart: $('#radialChart'), sectionChart: $('#sectionChart'),
    viewer: $('#viewer'),
  };

  // ---- 通用工具 ------------------------------------------------------------
  function activeValue(segId, attr) {
    const active = $(segId + ' .seg-btn.active');
    return active ? active.getAttribute(attr) : null;
  }
  function setActive(btn) {
    const seg = btn.parentElement;
    seg.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  }
  // 单选分段按钮组
  function bindSeg(segId, attr) {
    $(segId).addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      setActive(btn);
      readFromControls();
      recompute();
    });
  }
  const fmtCount = (x) => x >= 10000 ? (x / 10000).toFixed(1).replace(/\.0$/, '') + ' 万' : '' + x;

  // ---- 从控件读取（并夹紧） -------------------------------------------------
  // 同步依赖滑块的范围：l 上限随 n，m 范围随 l；超界立即夹紧。
  // 在滑块 input 时立即调用，避免"值超过旧上限被浏览器预夹紧再更新范围"的时序问题。
  function syncRanges() {
    const n = +els.nSlider.value;
    const maxL = Math.min(n - 1, 5);
    els.lSlider.max = maxL;
    if (+els.lSlider.value > maxL) els.lSlider.value = maxL;
    const l = +els.lSlider.value;
    els.mSlider.min = -l;
    els.mSlider.max = l;
    if (+els.mSlider.value > l) els.mSlider.value = l;
    if (+els.mSlider.value < -l) els.mSlider.value = -l;
  }

  function readFromControls() {
    syncRanges();                       // 先确保依赖滑块范围正确
    state.n = +els.nSlider.value;
    state.l = +els.lSlider.value;
    state.m = +els.mSlider.value;

    state.mode = activeValue('#modeSeg', 'data-mode') || 'real';
    state.renderMode = activeValue('#renderSeg', 'data-mode') || 'points';
    state.level = +els.levelSlider.value;
    state.pointCount = +els.pointCountSlider.value;
    state.plane = activeValue('#planeSeg', 'data-p') || 'xz';
    state.sectionMode = activeValue('#phaseSeg', 'data-mode') || 'intensity';
    state.angWhich = activeValue('#angSeg', 'data-k') || 'Y';
    state.radial = Array.from(document.querySelectorAll('#radialSeg .seg-btn.active')).map((b) => b.getAttribute('data-k'));
  }

  function updateOutputs() {
    els.nVal.textContent = state.n;
    els.lVal.textContent = state.l;
    els.mVal.textContent = state.m;
    els.levelVal.textContent = (state.level * 100).toFixed(1) + '%';
    els.pointCountVal.textContent = fmtCount(state.pointCount);
  }

  // ---- 主重算 ---------------------------------------------------------------
  function recompute() {
    readFromControls();
    updateOutputs();
    updateViewer();
    updateCharts();
    updateFormula();
  }

  function currentFieldKey() {
    return state.n + '-' + state.l + '-' + state.m + '-' + state.mode;
  }

  function updateViewer() {
    if (state.renderMode === 'surface') {
      const key = currentFieldKey();
      if (key !== lastFieldKey) {
        const gridRes = isMobile ? 46 : 68;   // 较高分辨率 → 轮廓更平滑
        Orbit3D.updateSurface(state.n, state.l, state.m, state.mode, gridRes, state.level);
        lastFieldKey = key;
      } else {
        Orbit3D.setSurfaceLevel(state.level);   // 仅阈值变化，复用标量场
      }
    } else {
      const cloud = OM.samplePoints(state.n, state.l, state.m, state.mode, state.pointCount);
      Orbit3D.updateCloud(cloud);
    }
    Orbit3D.setVisibility(state.renderMode);
    Orbit3D.setAutoRotate($('#autoRotate').checked);
    // 依据渲染模式切换对应的参数组（等值面阈值 / 粒子数）
    els.levelSet.style.display = (state.renderMode === 'surface') ? '' : 'none';
    els.pointSet.style.display = (state.renderMode === 'points') ? '' : 'none';
  }

  function updateCharts() {
    Charts.drawRadial(els.radialChart, state.n, state.l, state.radial);
    Orbit3D.updateAngular(state.l, state.m, state.mode, state.angWhich);
    Charts.drawSection(els.sectionChart, state.n, state.l, state.m, state.mode, state.plane, state.sectionMode);
  }

  function updateFormula() {
    const f = Formula.buildPsi(state.n, state.l, state.m, state.mode);
    els.formulaTitle.textContent = f.title;
    els.formulaNote.textContent = f.note;
    katex.render(f.latex, els.formulaBox, { throwOnError: false, displayMode: true });
    els.orbitTitle.textContent = state.n + OM.SUBSHELL[Math.min(state.l, OM.SUBSHELL.length - 1)];
    els.modeBadge.textContent = f.modeName;
  }

  // ---- 节流 ---------------------------------------------------------------
  let debounceId = null;
  function scheduleUpdate(ms) {
    clearTimeout(debounceId);
    debounceId = setTimeout(recompute, ms == null ? 120 : ms);
  }

  // ---- 事件绑定 -----------------------------------------------------------
  function bindEvent() {
    // 量子数滑块（n/l 变更需先同步依赖范围内的，再异步重算）
    [els.nSlider, els.lSlider].forEach((el) => {
      el.addEventListener('input', () => { syncRanges(); scheduleUpdate(); });
    });
    els.mSlider.addEventListener('input', () => scheduleUpdate());
    // 等值阈值 / 粒子数
    els.levelSlider.addEventListener('input', () => scheduleUpdate());
    els.pointCountSlider.addEventListener('input', () => scheduleUpdate());
    // 单选分段
    bindSeg('#modeSeg', 'data-mode');
    bindSeg('#renderSeg', 'data-mode');
    bindSeg('#phaseSeg', 'data-mode');
    bindSeg('#planeSeg', 'data-p');
    bindSeg('#angSeg', 'data-k');
    // 径向多选（保证至少一个激活）
    $('#radialSeg').addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      // 若这是唯一激活项则不允许取消，否则按需求 toggle
      const activeNow = document.querySelectorAll('#radialSeg .seg-btn.active').length;
      if (btn.classList.contains('active') && activeNow === 1) return;
      btn.classList.toggle('active');
      readFromControls();
      recompute();
    });
    // 通用
    $('#autoRotate').addEventListener('change', () => Orbit3D.setAutoRotate($('#autoRotate').checked));
    $('#resetView').addEventListener('click', () => Orbit3D.resetView());
    // 窗口缩放
    window.addEventListener('resize', () => {
      Orbit3D.resize(els.viewer.clientWidth, els.viewer.clientHeight);
      if (els.angularView) Orbit3D.resizeAngular(els.angularView.clientWidth, els.angularView.clientHeight);
      updateCharts();
    });
  }

  // ---- 动画循环 -----------------------------------------------------------
  function animate() {
    Orbit3D.render();
    Orbit3D.renderAngular();
    requestAnimationFrame(animate);
  }

  // ---- 启动 ---------------------------------------------------------------
  function start() {
    Orbit3D.init(els.viewer);
    if (els.angularView) Orbit3D.initAngular(els.angularView);
    bindEvent();
    // 初始尺寸需要等布局稳定（slider 在 style 之后写回，重新布局）
    requestAnimationFrame(() => {
      recompute();
      Orbit3D.resize(els.viewer.clientWidth, els.viewer.clientHeight);
      if (els.angularView) Orbit3D.resizeAngular(els.angularView.clientWidth, els.angularView.clientHeight);
      animate();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
