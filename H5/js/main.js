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
    // ★ 三维里"看什么"：'wave' = 完整波函数 ψ（等值面 / 粒子云）；
    //   'spherical' = 角度部分 Y 的球谐曲面。两者在 render3d.js 里是**两套几何**
    //   （ψ 走标量场 + marching tetrahedra，Y 走极坐标曲面直接三角化），所以切档
    //   不是换个着色，而是换一条重建路径，且各自有各自的取景尺度。
    viewTarget: 'wave',
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
    angWhich: 'Y',           // 球谐档判据：'Y' | 'Y2'（球谐曲面画 |Y| 还是 |Y|²）
    radial: ['R', 'R2', 'D'],   // D² 已移除（零点与峰值和 D 完全相同，见 charts.js 的说明）
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
    thetaPhiChart: $('#thetaPhiChart'),
    targetSeg: $('#targetSeg'), yCritSet: $('#yCritSet'),
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

    state.viewTarget = activeValue('#targetSeg', 'data-target') || 'wave';
    state.mode = activeValue('#modeSeg', 'data-mode') || 'real';
    state.renderMode = activeValue('#renderSeg', 'data-mode') || 'surface';
    state.colorMode = activeValue('#colorSeg', 'data-mode') || 'orbital';
    state.level = levelFromSlider(+els.levelSlider.value);
    state.psiCrit = activeValue('#psiSeg', 'data-mode') || 'psi2';
    state.pointCount = +els.pointCountSlider.value;
    state.plane = activeValue('#planeSeg', 'data-p') || 'xz';
    state.sectionMode = activeValue('#phaseSeg', 'data-mode') || 'intensity';
    state.angWhich = activeValue('#yCritSeg', 'data-k') || 'Y';
    state.radial = Array.from(document.querySelectorAll('#radialSeg .seg-btn.active')).map((b) => b.getAttribute('data-k'));
  }

  function updateOutputs() {
    // 数字框只是滑块的"另一种呈现"：每次重算都同步一次，智能体通过动作改了
    // 阈值/粒子数时输入框也会跟着走（正在输入的那只不覆盖，否则会打断键入）。
    syncNumBox(els.levelInput, state.level * 100);
    syncNumBox(els.pointCountInput, state.pointCount / 10000);
    // 提示两种判据的换算（|ψ| = f ⟺ |ψ|² = f²，故同一读数下 |ψ| 判据得到更大的面），
    // 并给出该轨道的推荐值。百分比按量级取小数位 —— 低端可达 0.02%。
    const pct = (x) => {
      const p = x * 100;
      return (p >= 10 ? p.toFixed(1) : (p >= 1 ? p.toFixed(2) : p.toFixed(3))) + '%';
    };
    const f = state.level;
    const rec = recommendedLevel(state.n, state.l, state.psiCrit);
    // 推荐值被下限顶住时要说出来：4s/5s/6s 的"看全所有壳"推荐值低于下限 0.3%，
    // 直接显示 0.300% 会让学生以为那就是该轨道的推荐值。
    const atFloor = rec > recommendedLevelRaw(state.n, state.l, state.psiCrit) + 1e-12;
    // ★ 用 innerHTML：推荐值后面挂一个「采用」内联按钮（提示行会随每次重算重建，
    //   所以按钮的点击靠事件委托绑定，见 init 里的 psiHint 监听）。内容全是自产数字，
    //   无注入面。
    els.psiHint.innerHTML = ((state.psiCrit === 'psi2')
      ? '阈值＝占 |ψ|² 峰值的比例（' + pct(f) + ' |ψ|² ⟺ ' + pct(Math.sqrt(f)) + ' |ψ|）'
      : '阈值＝占 |ψ| 峰值的比例（' + pct(f) + ' |ψ| ⟺ ' + pct(f * f) + ' |ψ|²）')
      + '　· 本轨道推荐 <b>' + pct(rec) + '</b>' + (atFloor ? '（已到下限）' : '')
      + '<button type="button" class="link-btn" id="levelRecBtn">采用</button>';

    // ★ l = 0（s 轨道）时角度函数是常数、ψ 的符号在整块空间恒定，相位色会退化成一整块
    //   同色（s 蓝变纯红），既无信息又容易让学生以为"红色有特殊含义"。故此时禁用相位色，
    //   并把当前选择拉回支壳层色。★ state 与 DOM 必须**同时**改，否则下一帧
    //   readFromControls 会从 DOM 读回 phase。
    const phaseBtn = document.querySelector('#colorSeg .seg-btn[data-mode="phase"]');
    if (phaseBtn) {
      const noPhase = (state.l === 0);
      phaseBtn.disabled = noPhase;
      if (noPhase && state.colorMode === 'phase') {
        state.colorMode = 'orbital';
        const orbBtn = document.querySelector('#colorSeg .seg-btn[data-mode="orbital"]');
        if (orbBtn) { orbBtn.classList.add('active'); phaseBtn.classList.remove('active'); }
      }
    }
  }

  // ---- 等值面阈值：对数刻度 + 按轨道推荐值 --------------------------------
  /**
   * 阈值滑块的刻度映射。
   * ★ 为什么用对数：可用范围跨 2.4 个数量级，线性刻度下低端（0.3%–1%）只占滑块行程的
   *   百分之几、根本拖不到；而低端恰恰是最需要精细控制的区域（"要看到所有节面"的阈值
   *   常常在 1% 以下）。故滑块用 0–1000 的整数刻度，等比映射到 [LEVEL_MIN, LEVEL_MAX]。
   *
   * ★ 量程的选取（0.3% – 80%）：
   *   · 下限原为 0.02%，实测**用不到那么低**：各轨道"看全所有壳层"所需的阈值最低是
   *     6s 的 0.04%，而 0.04% 下画出来是一团弥散的巨球、教学上反而不如只看内几层。
   *     0.3% 已经能覆盖到 3s 的三层壳（最弱壳峰值 0.46% > 0.3%），是"够用且不空转"的位置。
   *   · 中点 = √(0.003 × 0.8) = **4.9%**。取对数刻度就要看中点落在哪 —— 原来的
   *     0.02%–80% 中点是 1.26%，等于把滑块正中间浪费在了几乎没人用的量级上；
   *     现在中点落在 5% 附近，也就是 3p/4p/4d 这些常用轨道推荐值（4.75% / 1.69% / 7.6%）
   *     的左右，手感与直觉一致。
   */
  const LEVEL_MIN = 0.003, LEVEL_MAX = 0.80;           // 占峰值的比值（0.3% – 80%）
  const LEVEL_LOG_SPAN = Math.log(LEVEL_MAX) - Math.log(LEVEL_MIN);
  const levelFromSlider = (v) => Math.exp(Math.log(LEVEL_MIN) + (v / 1000) * LEVEL_LOG_SPAN);
  const levelToSlider = (f) => Math.round(1000 * (Math.log(f) - Math.log(LEVEL_MIN)) / LEVEL_LOG_SPAN);

  // 用户是否"明确指定过"阈值（拖过滑块 / 改过数字框 / 智能体下发过 setSurfaceLevel 或
  // restoreState）。置位后换轨道就不再套用推荐值 —— 否则会盖掉智能体演示里明确设的值。
  let levelUserAdjusted = false;
  let lastOrbKeyForLevel = null;                        // 上次套用推荐值时的轨道标识

  /**
   * 该轨道的推荐等值面阈值（占峰值的比值，按**当前判据**给出）。
   *
   * 依据：等值面沿 |Y| 最大的方向能否出现，只看该壳的 max R(r)² 够不够高。实测各壳
   *   峰值占比 —— 3p 100/11.9、4p 100/11.1/4.2、5d 100/17.4/8.1、4s 100/1.8/0.42/0.18。
   *   默认的 10% 只对 3p（恰好是默认轨道）勉强成立：4p 会切掉第三层壳、3s 只显示
   *   1.4% 的概率（看起来是个光滑小球），与"展示节面"的教学目标直接冲突。
   *
   * 取最弱壳峰值的 40%：既保证**每一层壳都显示得出来**（0.4 < 1），又留出形态余地
   * （贴着峰值取会让最外壳缩成一个点）。单壳轨道没有"看全节面"的约束，沿用 10%。
   *
   * 下限 0.04% 是防呆而非妥协：n ≤ 6 时实测最弱壳峰值 ≥ 0.05%，所以 0.04% 仍然显示
   * 得出所有壳，只是不让推荐值无限逼近滑块下限。
   */
  function recommendedLevelRaw(n, l, psiCrit) {
    if (!window.OM || !OM.shellPeakFractions) return 0.10;
    let fr;
    try { fr = OM.shellPeakFractions(n, l); } catch (e) { return 0.10; }
    if (!fr || fr.length <= 1) return 0.10;             // 单壳：无约束
    const rec = Math.max(0.0004, Math.min(0.8, 0.4 * Math.min.apply(null, fr)));
    // 判据换算：同一读数下 |ψ| 判据对应 f² 倍峰值（见 render3d.js 的 levelAbsFor）
    return (psiCrit === 'psi') ? Math.sqrt(rec) : rec;
  }

  /**
   * 推荐值（截断到滑块量程内）。★ 与 recommendedLevelRaw 分开是必要的：
   * 4s/5s/6s 的"看全所有壳"推荐值（0.074% / 0.04%）已经低于新的下限 0.3%，
   * 截断后与原始值不同 —— 提示行要据此显示"（已到下限）"，而不是把一个被顶住的
   * 数字当成真正的推荐值报给学生。
   */
  function recommendedLevel(n, l, psiCrit) {
    const raw = recommendedLevelRaw(n, l, psiCrit);
    return Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, raw));
  }

  /**
   * 把推荐阈值写进 state 与滑块。只在"用户没明确指定过"时调用。
   * ★ 此处**直接赋值、不派发 input 事件** —— 派发会触发滑块监听里的
   *   levelUserAdjusted = true，等于自己把自己锁死（推荐值只生效一次）。
   */
  function applyRecommendedLevel() {
    state.level = recommendedLevel(state.n, state.l, state.psiCrit);
    if (els.levelSlider) els.levelSlider.value = levelToSlider(state.level);
  }

  /** 把数值写回数字框 */
  function syncNumBox(el, v) {
    if (!el || document.activeElement === el) return;
    // ★ 精度按量级取：阈值低端可到 0.3%，固定一位小数会把它舍成 0.3 与 0.4 之间跳
    //   （"0.0"既看不出是多少，再键入还会被判非法）；粒子数（万）0.8–8 两位足够。
    const av = Math.abs(v);
    const digits = (av >= 10) ? 1 : (av >= 1 ? 2 : 3);
    const s = String(+v.toFixed(digits));
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
    // ★ 换轨道时套用该轨道的推荐阈值（用户/智能体明确指定过就不动，见 levelUserAdjusted）。
    //   必须放在 readFromControls 之后：那时 n/l/m 已是新值，而 level 刚被滑块覆盖成旧值，
    //   正需要在这里改掉。轨道标识不含 psiCrit —— 切判据按既有设计保持读数不变。
    const orbKey = state.n + ',' + state.l + ',' + state.m + ',' + state.mode;
    if (orbKey !== lastOrbKeyForLevel) {
      lastOrbKeyForLevel = orbKey;
      if (!levelUserAdjusted) applyRecommendedLevel();
    }
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
    // ★ 两个档位是两条独立的重建路径，不是一个开关的两个分支：
    //   'spherical' 画极坐标曲面 r = |Y|（解析形状，直接三角化）；
    //   'wave'      画 ψ 的等值面（标量场 + marching tetrahedra）或粒子云。
    //   所以这里用 if/else 而不是在渲染模式里再加一个维度。
    const sph = (state.viewTarget === 'spherical');
    if (sph) {
      Orbit3D.updateAngular(state.l, state.m, state.mode, state.angWhich);
    } else if (state.renderMode === 'surface') {
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
    Orbit3D.setVisibility(sph ? 'spherical' : state.renderMode);
    Orbit3D.setAutoRotate($('#autoRotate').checked);
    // 右栏参数组：按「档位 + 渲染模式」显示当下真正起作用的那一组，其余收起来。
    // ★ 球谐档要收起「三维渲染」与「三维着色」两整组 —— 球谐是解析曲面，没有
    //   粒子云/等值面之分，配色也由实/复函数决定。留着它们就会出现"点了没反应"。
    els.yCritSet.style.display       = sph ? '' : 'none';
    document.getElementById('renderGroup').style.display = sph ? 'none' : '';
    document.getElementById('colorGroup').style.display  = sph ? 'none' : '';
    els.levelSet.style.display = (!sph && state.renderMode === 'surface') ? '' : 'none';
    els.pointSet.style.display = (!sph && state.renderMode === 'points') ? '' : 'none';
  }

  function updateCharts() {
    Charts.drawRadial(els.radialChart, state.n, state.l, state.radial);
    // Θ/Φ 卡片画的是 Y 的**两个因子**（不随 |Y|/|Y|² 判据变 —— 判据改的是三维里
    // 那张曲面的轮廓，而"Y = Θ·Φ"这个分解关系与判据无关）
    Charts.drawThetaPhi(els.thetaPhiChart, state.l, state.m, state.mode);
    Charts.drawSection(els.sectionChart, state.n, state.l, state.m, state.mode, state.plane, state.sectionMode);
  }

  /**
   * 只重绘截面图（不牵动其余两张），并同步「复位缩放」小控件的显隐。
   * 缩放/平移时用它而不是 updateCharts —— 后者会顺带重算径向与角度图，纯属浪费。
   */
  function redrawSection() {
    Charts.drawSection(els.sectionChart, state.n, state.l, state.m, state.mode, state.plane, state.sectionMode);
    const chip = $('#sectionResetChip');
    if (chip) chip.style.display = Charts.sectionState().userAdjusted ? '' : 'none';
  }

  /**
   * 给任意 canvas 绑上"截面图"的缩放 / 平移 / 复位交互。
   * 抽成函数是因为**卡片与浮动窗要对同一个视图状态**（charts.js 的 sectionView）做同样的
   * 操作 —— 绑两遍时逻辑必须一致，否则两处的缩放手感会漂移。
   * UX 口径照抄三维视图（render3d.js 的 createQuatOrbit）：滚轮缩放、拖拽平移、双击复位。
   * @param {HTMLCanvasElement} cv
   * @param {Function} onChange 视图变化后调用（重画该 canvas）
   * @returns {boolean} 是否绑定成功
   */
  function attachSectionView(cv, onChange) {
    if (!cv) return false;
    const halfE = () => OM.rExtent(state.n, state.l) * 1.05;
    let drag = null;
    // ★ 多点触控：单指拖动平移，**双指捏合缩放**（与三维视图同一套手势约定）。
    //   原先只有 wheel 能缩放 —— 桌面没问题，但触屏上就完全没法放大截面图，
    //   而"放大看暗部"恰恰是这张图的主要用法。故补上捏合。
    const pointers = new Map();
    let lastPinch = 0, lastMid = null;
    cv.style.cursor = 'grab';
    cv.style.touchAction = 'none';        // 触屏上自己处理拖动，别让浏览器把页面滚走

    /** 屏幕坐标 → 截面平面坐标（用作缩放锚点："放大指针底下这一块"） */
    function toPlane(clientX, clientY) {
      const r = cv.getBoundingClientRect();
      const hu = halfE() / Charts.sectionState().scale;
      return {
        u: Charts.sectionState().cu + ((clientX - r.left) / Math.max(1, r.width) - 0.5) * 2 * hu,
        v: Charts.sectionState().cv + ((clientY - r.top) / Math.max(1, r.height) - 0.5) * 2 * hu,
      };
    }

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const a = toPlane(e.clientX, e.clientY);
      if (Charts.zoomSection(Math.exp(-e.deltaY * 0.0015), a.u, a.v)) onChange();
    }, { passive: false });

    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      if (pointers.size === 2) {
        drag = null;                     // 双指落下即转入缩放，不再平移
        const p = [...pointers.values()];
        lastPinch = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        lastMid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
      } else {
        drag = { x: e.clientX, y: e.clientY };
        cv.style.cursor = 'grabbing';
      }
    });
    cv.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const p = [...pointers.values()];
        const pinch = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        const mid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
        let dirty = false;
        if (lastPinch > 0 && pinch > 0) {
          const a = toPlane(mid.x, mid.y);
          if (Charts.zoomSection(pinch / lastPinch, a.u, a.v)) dirty = true;
        }
        lastPinch = pinch; lastMid = mid;
        if (dirty) onChange();
        return;
      }
      if (!drag) return;
      const st = Charts.sectionState();
      // 每像素对应多少平面坐标：视窗全宽 2·E/scale 铺满画布宽度
      const k = (2 * halfE() / st.scale) / Math.max(1, cv.clientWidth);
      // 指针右移 → 内容跟着右移 → 视窗中心左移，故取负号
      Charts.panSection(-(e.clientX - drag.x) * k, -(e.clientY - drag.y) * k);
      drag = { x: e.clientX, y: e.clientY };
      onChange();
    });
    const endDrag = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) { lastPinch = 0; lastMid = null; }
      if (!drag) return;
      drag = null;
      cv.style.cursor = 'grab';
      try { cv.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    };
    cv.addEventListener('pointerup', endDrag);
    cv.addEventListener('pointercancel', endDrag);
    cv.addEventListener('dblclick', () => { Charts.resetSectionView(); onChange(); });
    return true;
  }

  function bindSectionView() {
    attachSectionView(els.sectionChart, redrawSection);
    const chip = $('#sectionResetChip');
    if (chip) chip.addEventListener('click', () => { Charts.resetSectionView(); redrawSection(); });
  }

  // 公式高亮状态（由 agent 的 setFormulaHighlight 动作驱动）
  // 'R' 径向 | 'Y' 角度 | 'L' 拉盖尔 | 'P' 勒让德 | 'N' 归一化常数 | null 无
  let formulaHighlight = null;

  function updateFormula() {
    // ★ 叠加态要单独出公式：否则公式区还停在"上一个单一本征态"，
    //   与三维视图里真正画出来的东西对不上。
    const sup = (state.terms && state.terms.length)
      ? Formula.buildSuperposition(state.terms) : null;
    const f = sup || Formula.buildPsi(state.n, state.l, state.m, state.mode, { highlight: formulaHighlight });
    els.formulaTitle.textContent = f.title;
    els.formulaNote.textContent = f.note;
    // trust:true 是 \htmlClass 生效的前提（用于按项高亮）
    katex.render(f.latex, els.formulaBox, { throwOnError: false, displayMode: true, trust: true });
    if (sup) {
      els.orbitTitle.innerHTML = '叠加态' +
        '<span class="orbit-real">' + state.terms.length + ' 个分量</span>';
      els.modeBadge.textContent = '叠加态';
      return;
    }
    // 右上角轨道标签：n + 支壳层字母 + m 下标（此前漏了 m），实函数附化学惯用名
    const sub = OM.SUBSHELL[Math.min(state.l, OM.SUBSHELL.length - 1)];
    // ★ 用 HTML 版：realName 会经 innerHTML 插入右上角标签，纯文本版会把下标原样
    //   显示成 "p_z"（d 轨道更扎眼 —— 它内部是 LaTeX 花括号语法，显示成 "d_{xz}"）
    const realName = (state.mode === 'real') ? Formula.realOrbitalNameHtml(state.l, state.m) : '';
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
    // 阈值：数字框用"百分比"作人类单位，滑块是 0–1000 的对数刻度（见 levelFromSlider）
    bindNumToSlider(els.levelInput, els.levelSlider, (v) => levelToSlider(v / 100), 0.3, 80);
    bindNumToSlider(els.pointCountInput, els.pointCountSlider, (v) => v * 10000, 0.8, 8);
    // ★ 任何一次阈值输入都算"用户明确指定过"：此后换轨道不再自动套推荐值，免得盖掉
    //   智能体演示里明确设的阈值。（setSlider 也会派发 input，故数字框那条路径一并覆盖）
    els.levelSlider.addEventListener('input', () => { levelUserAdjusted = true; scheduleUpdate(); });
    els.pointCountSlider.addEventListener('input', () => scheduleUpdate());
    // 「采用推荐值」是提示行里的内联按钮；用**事件委托**，因为 hint 每次重算都会重建
    // （直接给按钮绑 onclick 会在第一次重建后失效）。
    if (els.psiHint) {
      els.psiHint.addEventListener('click', (e) => {
        if (!e.target || e.target.id !== 'levelRecBtn') return;
        levelUserAdjusted = false;          // 交回自动模式并立刻套用
        applyRecommendedLevel();
        updateOutputs();
        scheduleUpdate(0);
      });
    }
    bindSectionView();          // 截面图：滚轮缩放 / 拖拽平移 / 双击复位
    // 径向图的特征标注：单选，再点一次取消（与曲线开关并列在卡片头，不再是"看不见的"状态）
    const markSeg = $('#radialMarkSeg');
    if (markSeg) {
      markSeg.addEventListener('click', (e) => {
        const btn = e.target.closest('.seg-btn');
        if (!btn) return;
        const wasOn = btn.classList.contains('active');
        const f = wasOn ? null : btn.getAttribute('data-m');
        // 走动作通路，图表与界面状态只在一处维护
        window.OrbitApp.applyAction({ action: 'setRadialMarks', params: { target: 'ALL', feature: f } });
      });
    }
    // 单选分段
    bindSeg('#modeSeg', 'data-mode');
    bindSeg('#renderSeg', 'data-mode');
    bindSeg('#colorSeg', 'data-mode');
    bindSeg('#psiSeg', 'data-mode');
    bindSeg('#phaseSeg', 'data-mode');
    bindSeg('#planeSeg', 'data-p');
    bindSeg('#yCritSeg', 'data-k');
    bindSeg('#targetSeg', 'data-target');
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
      updateCharts();
    });
  }

  // ---- 动画循环 -----------------------------------------------------------
  // ★ 只有一个渲染器：球谐曲面合并进主场景后，不再有第二套 render。
  //   （漏删这里的 renderAngular() 会让 rAF 链在第一帧就抛错断掉 —— 画面定格、
  //   自动旋转失效，而首帧看起来完全正常，是个很难发现的形态。）
  function animate() {
    Orbit3D.render();
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
      silentSeg('#yCritSeg', 'data-k', s.angularWhich);
      silentSeg('#targetSeg', 'data-target', s.viewTarget);
      // 径向曲线组是多选
      const want = s.radial || [];
      document.querySelectorAll('#radialSeg .seg-btn').forEach((b) => {
        b.classList.toggle('active', want.indexOf(b.getAttribute('data-k')) >= 0);
      });
      if (!document.querySelector('#radialSeg .seg-btn.active')) {
        const db = document.querySelector('#radialSeg .seg-btn[data-k="D"]');
        if (db) db.classList.add('active');
      }
      if (els.levelSlider) els.levelSlider.value = levelToSlider(s.levelFraction);
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
    setColorMode(p) {
      // ★ l = 0（s 轨道）时角度函数是常数、ψ 的符号在整块空间恒定，相位色退化成
      //   一整块同色（s 蓝变纯红）—— 无信息且易误解，故拒绝（界面上该按钮也置灰）
      if (p.mode === 'phase' && state.l === 0) return false;
      return setSeg('#colorSeg', 'data-mode', p.mode);
    },
    setPsiCriterion(p) { return setSeg('#psiSeg', 'data-mode', p.criterion); },
    setIsosurfaceLevel(p) {
      // ★ 滑块现在是 0–1000 的**对数刻度**（见 levelFromSlider），必须换算 ——
      //   把 fraction（0–1 的比值）直接写进滑块会落到刻度底部，阈值变得极小。
      //   setSlider 会派发 input，于是 levelUserAdjusted 自动置位：智能体明确指定过
      //   阈值，此后换轨道就不再套推荐值（否则会盖掉演示里设的值）。
      const f = Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, +p.fraction || LEVEL_MIN));
      return setSlider(els.levelSlider, levelToSlider(f));
    },
    setParticleCount(p) { return setSlider(els.pointCountSlider, p.count); },
    setAngularView(p) { return setSeg('#yCritSeg', 'data-k', p.which); },
    setViewTarget(p) { return setSeg('#targetSeg', 'data-target', p.target); },
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
    /**
     * 径向图的特征标注（峰值 / 零点）—— 与曲线显隐是**同一套控件语义**：
     * 标线只画在"当前可见的曲线"上，关掉 R 曲线，R 的峰值线也跟着没了。
     * feature 为空表示清除标注。target='ALL' 时 R 与 D 各自用自己的颜色标。
     */
    setRadialMarks(p) {
      const f = p && p.feature;
      const target = p && p.target ? p.target : 'ALL';
      const seg = document.querySelector('#radialMarkSeg');
      if (seg) {
        seg.querySelectorAll('.seg-btn').forEach((b) => {
          b.classList.toggle('active', !!f && b.getAttribute('data-m') === f);
        });
      }
      if (window.Charts && window.Charts.setRadialHighlight) {
        window.Charts.setRadialHighlight(f ? target : null, f);
      }
      return true;
    },
    resetCamera() { Orbit3D.resetView(); return true; },
    /** 截面图的缩放/平移复位（智能体可用；对应图表角落的「复位缩放」小控件） */
    resetSectionView() { Charts.resetSectionView(); redrawSection(); return true; },

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
        viewTarget: state.viewTarget,
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

    /**
     * 把某张图按**当前状态**画进任意 canvas —— 供图表浮动窗复用同一条绘制路径。
     * ★ 卡片与浮窗必须共用这一条路径，否则两处的"当前状态"会各自漂移
     *   （浮窗里看到的可能不是卡片上那张图）。
     * ★ 这两个是**给浮窗模块直接调用的 API，不是动作** —— 它们先前被误加进了 ACTIONS
     *   表，而动作表只经 applyAction 派发；ChartOverlay 直接读的是 facade，于是拿到
     *   undefined、浮窗一直画不出内容（canvas 停在默认 300×150 空白）。
     */
    drawChartInto(target, canvas) {
      if (!canvas) return false;
      if (target === 'radial') {
        Charts.drawRadial(canvas, state.n, state.l, state.radial);
        return true;
      }
      if (target === 'section') {
        Charts.drawSection(canvas, state.n, state.l, state.m, state.mode, state.plane, state.sectionMode);
        return true;
      }
      // 球谐曲面不是图表（它是主三维视图本身）；下面那张 Θ/Φ 卡片倒是普通 2D canvas，
      // 技术上可以支持浮窗，本轮先不开放，留作后续。
      return false;
    },

    /**
     * 给浮窗里的 canvas 绑上与卡片同一套交互（目前只有截面图有可交互的内容）。
     * 视图变化时**两处都要重画** —— sectionView 是两者共享的状态。
     */
    attachChartInteractions(target, canvas, onRedraw) {
      if (target !== 'section') return false;
      return attachSectionView(canvas, () => {
        redrawSection();                  // 卡片（含「复位缩放」小控件的显隐）
        if (onRedraw) onRedraw();         // 浮窗自己
      });
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
    bindEvent();
    // 初始尺寸需要等布局稳定（slider 在 style 之后写回，重新布局）
    requestAnimationFrame(() => {
      recompute();
      Orbit3D.resize(els.viewer.clientWidth, els.viewer.clientHeight);
      animate();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
