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
    renderMode: 'surface',   // 'points' | 'surface'（默认等值面）
    colorMode: 'orbital',    // 三维着色：'orbital' 轨道色 | 'phase' 相位色
    level: 0.30,             // 等值面阈值（占峰值的比值；默认使 p 轨道两瓣明显分离）
    psiCrit: 'psi2',         // 等值面判据：'psi2' 按 |ψ|² 计 | 'psi' 按 |ψ| 计
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
    nSlider: $('#nSlider'), nInput: $('#nInput'),
    lSlider: $('#lSlider'), lInput: $('#lInput'),
    mSlider: $('#mSlider'), mInput: $('#mInput'),
    levelSlider: $('#levelSlider'), levelVal: $('#levelVal'), levelSet: $('#levelSet'), psiHint: $('#psiHint'),
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
    els.lInput.max = maxL;
    if (+els.lSlider.value > maxL) els.lSlider.value = maxL;
    const l = +els.lSlider.value;
    els.mSlider.min = -l;
    els.mSlider.max = l;
    els.mInput.min = -l;
    els.mInput.max = l;
    if (+els.mSlider.value > l) els.mSlider.value = l;
    if (+els.mSlider.value < -l) els.mSlider.value = -l;
    // 滑块是唯一真值来源；数字框只是它的另一种呈现
    els.nInput.value = n;
    els.lInput.value = l;
    els.mInput.value = els.mSlider.value;
    [els.nInput, els.lInput, els.mInput].forEach((el) => el.classList.remove('invalid'));
  }

  /**
   * 数字框键入提交：解析 → 类型/范围校验 → 合法则写回滑块并即时重算；
   * 非法（空、非整数、越界）只标红提示，不改变当前状态。
   */
  function commitNumber(el, which) {
    const raw = el.value.trim();
    const v = Number(raw);
    if (raw === '' || !Number.isFinite(v) || !Number.isInteger(v)) { el.classList.add('invalid'); return; }
    let lo, hi, slider;
    if (which === 'n') { lo = 1; hi = 6; slider = els.nSlider; }
    else if (which === 'l') { lo = 0; hi = Math.min(+els.nSlider.value - 1, 5); slider = els.lSlider; }
    else { lo = -(+els.lSlider.value); hi = +els.lSlider.value; slider = els.mSlider; }
    if (v < lo || v > hi) { el.classList.add('invalid'); return; }
    el.classList.remove('invalid');
    slider.value = v;
    syncRanges();
    recompute();                     // 键入后立即生效
  }

  function readFromControls() {
    syncRanges();                       // 先确保依赖滑块范围正确
    state.n = +els.nSlider.value;
    state.l = +els.lSlider.value;
    state.m = +els.mSlider.value;

    state.mode = activeValue('#modeSeg', 'data-mode') || 'real';
    state.renderMode = activeValue('#renderSeg', 'data-mode') || 'surface';
    state.colorMode = activeValue('#colorSeg', 'data-mode') || 'orbital';
    state.level = +els.levelSlider.value;
    state.psiCrit = activeValue('#psiSeg', 'data-mode') || 'psi2';
    state.pointCount = +els.pointCountSlider.value;
    state.plane = activeValue('#planeSeg', 'data-p') || 'xz';
    state.sectionMode = activeValue('#phaseSeg', 'data-mode') || 'intensity';
    state.angWhich = activeValue('#angSeg', 'data-k') || 'Y';
    state.radial = Array.from(document.querySelectorAll('#radialSeg .seg-btn.active')).map((b) => b.getAttribute('data-k'));
  }

  function updateOutputs() {
    els.levelVal.textContent = (state.level * 100).toFixed(1) + '%';
    els.pointCountVal.textContent = fmtCount(state.pointCount);
    // 提示两种判据的换算：|ψ| = f ⟺ |ψ|² = f²（故同一读数下 |ψ| 判据得到更大的面）
    const f = state.level;
    els.psiHint.textContent = (state.psiCrit === 'psi2')
      ? '阈值＝占 |ψ|² 峰值的比例（' + (f * 100).toFixed(1) + '% |ψ|² ⟺ ' + (Math.sqrt(f) * 100).toFixed(1) + '% |ψ|）'
      : '阈值＝占 |ψ| 峰值的比例（' + (f * 100).toFixed(1) + '% |ψ| ⟺ ' + (f * f * 100).toFixed(1) + '% |ψ|²）';
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
    return state.n + '-' + state.l + '-' + state.m + '-' + state.mode + '-' + state.psiCrit;
  }

  function updateViewer() {
    if (state.renderMode === 'surface') {
      const key = currentFieldKey();
      if (key !== lastFieldKey) {
        const gridRes = isMobile ? 46 : 68;   // 较高分辨率 → 轮廓更平滑
        Orbit3D.updateSurface(state.n, state.l, state.m, state.mode, gridRes, state.level, state.colorMode, state.psiCrit);
        lastFieldKey = key;
      } else {
        // 仅阈值/着色变化：复用已缓存的标量场与网格
        Orbit3D.setSurfaceLevel(state.level, state.colorMode, state.psiCrit);
      }
    } else {
      const cloud = OM.samplePoints(state.n, state.l, state.m, state.mode, state.pointCount, state.colorMode);
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
    // 右上角轨道标签：n + 支壳层字母 + m 下标（此前漏了 m），实函数附化学惯用名
    const sub = OM.SUBSHELL[Math.min(state.l, OM.SUBSHELL.length - 1)];
    const realName = (state.mode === 'real') ? Formula.realOrbitalName(state.l, state.m) : '';
    els.orbitTitle.innerHTML =
      state.n + sub + '<sub>' + f.mLabel + '</sub>' +
      (realName ? '<span class="orbit-real">' + realName + '</span>' : '');
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
    [els.nSlider, els.lSlider, els.mSlider].forEach((el) => {
      el.addEventListener('input', () => { syncRanges(); scheduleUpdate(); });
    });
    // 量子数数字框：键入即校验；回车提交；失焦时把非法输入还原为当前真值
    const numBind = (el, which) => {
      el.addEventListener('input', () => commitNumber(el, which));
      el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { commitNumber(el, which); el.blur(); } });
      el.addEventListener('blur', () => syncRanges());
    };
    numBind(els.nInput, 'n');
    numBind(els.lInput, 'l');
    numBind(els.mInput, 'm');
    // 等值阈值 / 粒子数
    els.levelSlider.addEventListener('input', () => scheduleUpdate());
    els.pointCountSlider.addEventListener('input', () => scheduleUpdate());
    // 单选分段
    bindSeg('#modeSeg', 'data-mode');
    bindSeg('#renderSeg', 'data-mode');
    bindSeg('#colorSeg', 'data-mode');
    bindSeg('#psiSeg', 'data-mode');
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
