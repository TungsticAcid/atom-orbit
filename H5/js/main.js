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
    level: 0.10,             // 等值面阈值（占峰值的比值）
    // ★ 默认 10% 而不是 30%：径向节点会把等值面切成多层壳，而**外层壳的峰值
    //   往往很低**（3p 的外层壳只有全局峰值的 11.9%）——按 30% 取阈值时外层壳
    //   整体落到阈值以下、直接消失，看起来"3p 只有两瓣"。取 10% 才能把多层壳
    //   都显示出来。注意取景已相应改为"同时装得下当前阈值"，否则低阈值会胀出画面。
    psiCrit: 'psi2',         // 等值面判据：'psi2' 按 |ψ|² 计 | 'psi' 按 |ψ| 计
    pointCount: 50000,
    plane: 'xz',             // 截面平面
    sectionMode: 'intensity',// 'intensity' | 'phase' | 'contour'
    angWhich: 'Y',           // 'Y' | 'Y2'
    radial: ['R', 'R2', 'D', 'D2'],
    // ★ 叠加态（辅助功能）：terms 为空时退化为单一本征态 ψ_{n,l,m}
    terms: [],               // [{n,l,m,mode,c:{re,im}}]
    relPhase: 0,             // 相对相位 φ（≠ 真实时间，见方案 §5.3）
  };
  let lastFieldKey = null;
  const isMobile = window.matchMedia('(max-width: 768px)').matches;

  // ---- DOM ----------------------------------------------------------------
  const $ = (s) => document.querySelector(s);
  const els = {
    nSlider: $('#nSlider'), nInput: $('#nInput'),
    lSlider: $('#lSlider'), lInput: $('#lInput'),
    mSlider: $('#mSlider'), mInput: $('#mInput'),
    levelSlider: $('#levelSlider'), levelInput: $('#levelInput'), levelSet: $('#levelSet'), psiHint: $('#psiHint'),
    pointCountSlider: $('#pointCountSlider'), pointCountInput: $('#pointCountInput'), pointSet: $('#pointSet'),
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
    // 数字框只是滑块的"另一种呈现"：每次重算都同步一次，智能体通过动作改了
    // 阈值/粒子数时输入框也会跟着走（正在输入的那只不覆盖，否则会打断键入）。
    syncNumBox(els.levelInput, state.level * 100);
    syncNumBox(els.pointCountInput, state.pointCount / 10000);
    // 提示两种判据的换算：|ψ| = f ⟺ |ψ|² = f²（故同一读数下 |ψ| 判据得到更大的面）
    const f = state.level;
    els.psiHint.textContent = (state.psiCrit === 'psi2')
      ? '阈值＝占 |ψ|² 峰值的比例（' + (f * 100).toFixed(1) + '% |ψ|² ⟺ ' + (Math.sqrt(f) * 100).toFixed(1) + '% |ψ|）'
      : '阈值＝占 |ψ| 峰值的比例（' + (f * 100).toFixed(1) + '% |ψ| ⟺ ' + (f * f * 100).toFixed(1) + '% |ψ|²）';
  }

  /** 把数值写回数字框（正整数一位小数足够：阈值步长 0.5%、粒子数步长 0.1 万） */
  function syncNumBox(el, v) {
    if (!el || document.activeElement === el) return;
    const s = String(Math.round(v * 10) / 10);
    if (el.value !== s) el.value = s;
  }

  /**
   * 把数字框绑到滑块上（lo/hi 是**数字框**的单位，换算函数负责两个方向）。
   *
   * ★ 与量子数不同，这两个量键入时必须**防抖**：改阈值会触发等值面重建（约 250ms），
   *   逐字符重建会让输入卡顿；改粒子数则要重采样数万个点。所以键入中只防抖重算，
   *   回车/失焦立即提交。
   */
  function bindNumToSlider(input, slider, toSlider, lo, hi) {
    if (!input || !slider) return;
    const valid = () => {
      const raw = input.value.trim();
      const v = Number(raw);
      if (raw === '' || !Number.isFinite(v) || v < lo || v > hi) { input.classList.add('invalid'); return null; }
      input.classList.remove('invalid');
      return v;
    };
    input.addEventListener('input', () => {
      const v = valid();
      if (v == null) return;
      setSlider(slider, toSlider(v));
      scheduleUpdate();                    // 键入中：防抖
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      const v = valid();
      if (v != null) { setSlider(slider, toSlider(v)); scheduleUpdate(0); }
      input.blur();
    });
    input.addEventListener('blur', () => {
      const v = valid();
      if (v != null) { setSlider(slider, toSlider(v)); scheduleUpdate(0); }
    });
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
    const sig = (state.terms || []).map(function (t) {
      return t.n + ',' + t.l + ',' + t.m + ',' + t.c.re.toFixed(3) + ',' + t.c.im.toFixed(3);
    }).join('|');
    return state.n + '-' + state.l + '-' + state.m + '-' + state.mode + '-' + state.psiCrit +
      (sig ? '-S:' + sig + '@' + state.relPhase : '');
  }

  function updateViewer() {
    if (state.renderMode === 'surface') {
      const key = currentFieldKey();
      if (key !== lastFieldKey) {
        // 拖动相位滑块时用较低分辨率预览（每帧重建等值面，高分辨率会卡）；
        // 松手后 __ORBIT_PREVIEW__ 复位，会以全分辨率重建一次
        const preview = !!window.__ORBIT_PREVIEW__;
        const gridRes = preview ? (isMobile ? 30 : 40) : (isMobile ? 46 : 68);
        Orbit3D.updateSurface(state.n, state.l, state.m, state.mode, gridRes, state.level,
          state.colorMode, state.psiCrit, state.terms, state.relPhase);
        lastFieldKey = key;
      } else {
        // 仅阈值/着色变化：复用已缓存的标量场与网格
        Orbit3D.setSurfaceLevel(state.level, state.colorMode, state.psiCrit);
      }
    } else {
      const cloud = (state.terms && state.terms.length)
        ? OM.samplePointsSuperposition(state.terms, state.pointCount, state.colorMode,
            state.terms.map(function (t, i) { return i * state.relPhase; }))
        : OM.samplePoints(state.n, state.l, state.m, state.mode, state.pointCount, state.colorMode);
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

  // 公式高亮状态（由 agent 的 highlightFormulaTerm 动作驱动）
  // 'R' 径向 | 'Y' 角度 | 'L' 拉盖尔 | 'P' 勒让德 | 'N' 归一化常数 | null 无
  let formulaHighlight = null;

  function updateFormula() {
    const f = Formula.buildPsi(state.n, state.l, state.m, state.mode, { highlight: formulaHighlight });
    els.formulaTitle.textContent = f.title;
    els.formulaNote.textContent = f.note;
    // trust:true 是 \htmlClass 生效的前提（用于按项高亮）
    katex.render(f.latex, els.formulaBox, { throwOnError: false, displayMode: true, trust: true });
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
    // 等值阈值 / 粒子数：滑块仍是真值来源，数字框用更贴近显示的"人类单位"
    // （百分比 / 万），换算在绑定时给。
    bindNumToSlider(els.levelInput, els.levelSlider, (v) => v / 100, 0.5, 80);
    bindNumToSlider(els.pointCountInput, els.pointCountSlider, (v) => v * 10000, 0.8, 8);
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

  // ---- 对外门面（供 agent 层使用）------------------------------------------
  // 设计原则：agent 层不直接操作 DOM / Three.js，一律经由这里的受控动作；
  // 每个动作最终翻译为「对现有控件的设置 + recompute()」，最大化复用既有逻辑。
  // 交互痕迹的采集不在这里做——由 perception-snapshot 轮询 getState() 差分得到，
  // 因此**无需改动任何现有事件处理**（零侵入）。

  /** 程序化设置滑块（会触发既有的 input 处理链） */
  function setSlider(el, v) {
    if (!el) return false;
    const nv = Number(v);
    if (!Number.isFinite(nv)) return false;
    el.value = nv;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  /** 程序化选中某个分段按钮 */
  function setSeg(segId, attr, val) {
    const btn = document.querySelector(segId + ' .seg-btn[' + attr + '="' + val + '"]');
    if (!btn) return false;
    setActive(btn);
    return true;
  }

  // 动作表：每个动作用最朴素的方式驱动既有控件
  const ACTIONS = {
    // 仅供"只重算、不改参数"的场景（如叠加态系数/相位变化后触发一次重绘）
    recomputeOnly() { return true; },

    /**
     * 恢复一整套视图状态（供演示「上一步」回退使用）。
     *
     * ★ 为什么不让回退去"反向执行"原来的动作：动作语义是有副作用的
     *   （例如 setQuantumNumbers 会顺手退出叠加态），反向执行不一定回到原处。
     *   直接写回快照才是严格可逆的。
     * ★ 这里刻意**只改控件与 state、不触发重算**——重算由 applyAction 统一做一次，
     *   否则一次回退会连着重算七八遍（等值面每次约 250ms，会明显卡顿）。
     */
    restoreState(p) {
      const s = p && p.state;
      if (!s) return false;
      const silentSeg = (segId, attr, val) => {
        const btn = document.querySelector(segId + ' .seg-btn[' + attr + '="' + (val == null ? '' : val) + '"]');
        if (!btn) return;
        btn.parentElement.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      };
      // 量子数：先设 n 再设 l/m，范围才正确
      if (els.nSlider) els.nSlider.value = s.n;
      syncRanges();
      if (els.lSlider) els.lSlider.value = s.l;
      syncRanges();
      if (els.mSlider) els.mSlider.value = s.m;
      syncRanges();
      if (els.nInput) els.nInput.value = s.n;
      if (els.lInput) els.lInput.value = s.l;
      if (els.mInput) els.mInput.value = s.m;

      silentSeg('#modeSeg', 'data-mode', s.wavefunction);
      silentSeg('#renderSeg', 'data-mode', s.render);
      silentSeg('#colorSeg', 'data-mode', s.color);
      silentSeg('#psiSeg', 'data-mode', s.psiCriterion);
      silentSeg('#planeSeg', 'data-p', s.plane);
      silentSeg('#phaseSeg', 'data-mode', s.sectionMode);
      silentSeg('#angSeg', 'data-k', s.angularWhich);
      // 径向曲线组是多选
      const want = s.radial || [];
      document.querySelectorAll('#radialSeg .seg-btn').forEach((b) => {
        b.classList.toggle('active', want.indexOf(b.getAttribute('data-k')) >= 0);
      });
      if (!document.querySelector('#radialSeg .seg-btn.active')) {
        const db = document.querySelector('#radialSeg .seg-btn[data-k="D"]');
        if (db) db.classList.add('active');
      }
      if (els.levelSlider) els.levelSlider.value = s.levelFraction;
      if (els.pointCountSlider) els.pointCountSlider.value = s.pointCount;

      const cb = document.querySelector('#autoRotate');
      if (cb) {
        cb.checked = !!s.autoRotate;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // 叠加态（含相对相位）
      state.terms = (s.terms || []).map((t) => ({
        n: t.n, l: t.l, m: t.m, mode: t.mode || 'real', c: { re: t.c.re, im: t.c.im },
      }));
      state.relPhase = s.relPhase || 0;
      return true;
    },
    setQuantumNumbers(p) {
      // ★ 指定了具体量子数即意味着"要看这个单一本征态" → 自动退出叠加态。
      //   否则会出现"演示脚本设了 n/l/m，画面却仍是叠加态"的错位
      //   （叠加态优先于 n/l/m，不退出就看不到任何变化）。
      const given = (p.n != null) || (p.l != null) || (p.m != null);
      if (given && state.terms && state.terms.length) {
        state.terms = []; state.relPhase = 0;
        if (window.StateEditor && window.StateEditor.clear) window.StateEditor.clear();
      }
      // n → l → m 依次设置，每步都收敛范围，避免越界被夹紧而丢失意图
      if (p.n != null) { setSlider(els.nSlider, p.n); syncRanges(); }
      if (p.l != null) { setSlider(els.lSlider, p.l); syncRanges(); }
      if (p.m != null) { setSlider(els.mSlider, p.m); syncRanges(); }
    },
    setWavefunctionMode(p) { return setSeg('#modeSeg', 'data-mode', p.mode); },
    setRenderMode(p) { return setSeg('#renderSeg', 'data-mode', p.mode); },
    setColorMode(p) { return setSeg('#colorSeg', 'data-mode', p.mode); },
    setPsiCriterion(p) { return setSeg('#psiSeg', 'data-mode', p.criterion); },
    setIsosurfaceLevel(p) { return setSlider(els.levelSlider, p.fraction); },
    setParticleCount(p) { return setSlider(els.pointCountSlider, p.count); },
    setAngularView(p) { return setSeg('#angSeg', 'data-k', p.which); },
    setSectionPlane(p) { return setSeg('#planeSeg', 'data-p', p.plane); },
    setSectionMode(p) { return setSeg('#phaseSeg', 'data-mode', p.mode); },
    showRadial(p) {
      const want = p.which || [];
      document.querySelectorAll('#radialSeg .seg-btn').forEach((b) => {
        b.classList.toggle('active', want.indexOf(b.getAttribute('data-k')) >= 0);
      });
      // 至少保留一条曲线，否则图表会空白
      if (!document.querySelector('#radialSeg .seg-btn.active')) {
        const d = document.querySelector('#radialSeg .seg-btn[data-k="D"]');
        if (d) d.classList.add('active');
      }
      return true;
    },
    setAutoRotate(p) {
      const cb = document.querySelector('#autoRotate');
      if (!cb) return false;
      cb.checked = !!p.on;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    resetCamera() { Orbit3D.resetView(); return true; },
    // 公式按项高亮（'R'|'Y'|'L'|'P'|'N'|null）——三向联动的中枢
    setFormulaHighlight(p) { formulaHighlight = p.part || null; return true; },

    // ---- 叠加态（辅助功能）----
    setSuperposition(p) {
      const list = (p && p.terms) || [];
      state.terms = list.map(function (t) {
        return {
          n: t.n, l: t.l, m: t.m, mode: t.mode || 'real',
          c: t.c || { re: 1, im: 0 },
        };
      });
      state.relPhase = 0;
      return true;
    },
    clearSuperposition() { state.terms = []; state.relPhase = 0; return true; },
    setRelPhase(p) {
      const v = Number(p && p.phase);
      if (!Number.isFinite(v)) return false;
      state.relPhase = v;
      return true;
    },
  };

  const actionListeners = [];

  const facade = {
    /** 只读状态快照（供 agent 的感知层使用） */
    getState() {
      const seg = (id, attr) => {
        const b = document.querySelector(id + ' .seg-btn.active');
        return b ? b.getAttribute(attr) : null;
      };
      return {
        n: state.n, l: state.l, m: state.m,
        wavefunction: state.mode,
        render: state.renderMode,
        color: state.colorMode,
        psiCriterion: state.psiCrit,
        levelFraction: state.level,
        pointCount: state.pointCount,
        plane: state.plane,
        sectionMode: state.sectionMode,
        angularWhich: state.angWhich,
        radial: state.radial.slice(),
        autoRotate: !!(document.querySelector('#autoRotate') || {}).checked,
        terms: state.terms.map(function (t) { return { n: t.n, l: t.l, m: t.m, mode: t.mode || 'real', c: { re: t.c.re, im: t.c.im } }; }),
        relPhase: state.relPhase,
      };
    },

    /** 应用一个受控动作。返回 { ok, error? } */
    applyAction(action) {
      if (!action || !action.action) return { ok: false, error: '动作缺少 action 字段' };
      const fn = ACTIONS[action.action];
      if (!fn) return { ok: false, error: '未知动作：' + action.action };
      let ok = true;
      try { ok = fn(action.params || {}) !== false; }
      catch (e) { return { ok: false, error: '动作执行异常：' + (e && e.message) }; }
      if (!ok) return { ok: false, error: '动作参数无效或目标不存在' };
      recompute();
      // 通知订阅者（量子态编辑器据此同步 UI；主动服务也可用）
      for (let i = 0; i < actionListeners.length; i++) {
        try { actionListeners[i](action); } catch (e) { /* 订阅者异常不影响主流程 */ }
      }
      return { ok: true };
    },

    /** 订阅视图变化（供主动服务与埋点使用） */
    onAction(fn) {
      if (typeof fn === 'function') actionListeners.push(fn);
      return () => {
        const i = actionListeners.indexOf(fn);
        if (i >= 0) actionListeners.splice(i, 1);
      };
    },

    /** 导出当前视图为 PNG（教师备课用） */
    exportViewPNG() {
      try { return els.viewer.querySelector('canvas').toDataURL('image/png'); }
      catch (e) { return null; }
    },
  };

  window.OrbitApp = facade;

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
