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
    // ★ 核电荷数 Z（类氢）：Z=1 氢原子、2 氦离子 He⁺、3 锂离子 Li²⁺。
    //   类氢与氢只差一条标度关系（r → r/Z、E ∝ Z²），角向部分与 Z 无关 ——
    //   所以引入 Z 没有改变任何公式的形状，只是把"这个原子带几份核电荷"接进来。
    Z: 1,
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
    // ★ 2D 图表画哪一份（第 G 批）：'super' = 叠加态整体（**只有截面图支持** ——
    //   Θ/Φ 卡与径向分布画不了叠加态，Σcᵢψᵢ 未必能因子化出角度部分），
    //   0/1/2… = 叠加态中的第 i 个分量。没有叠加态时这个字段不起作用（画滑块上的纯态）。
    chartTerm: 'super',
  };
  let lastFieldKey = null;
  const isMobile = window.matchMedia('(max-width: 768px)').matches;

  // ---- DOM ----------------------------------------------------------------
  const $ = (s) => document.querySelector(s);
  const els = {
    zSlider: $('#zSlider'), zInput: $('#zInput'),
    nSlider: $('#nSlider'), nInput: $('#nInput'),
    lSlider: $('#lSlider'), lInput: $('#lInput'),
    mSlider: $('#mSlider'), mInput: $('#mInput'), mSet: $('#mSet'),
    realOrbSet: $('#realOrbSet'), realOrbSeg: $('#realOrbSeg'), realOrbHint: $('#realOrbHint'),
    levelSlider: $('#levelSlider'), levelInput: $('#levelInput'), levelSet: $('#levelSet'), psiHint: $('#psiHint'),
    pointCountSlider: $('#pointCountSlider'), pointCountInput: $('#pointCountInput'), pointSet: $('#pointSet'),
    thetaPhiChart: $('#thetaPhiChart'),
    targetSeg: $('#targetSeg'), yCritSet: $('#yCritSet'),
    yCritSeg: $('#yCritSeg'), yCritHint: $('#yCritHint'),
    sphColorHint: $('#sphColorHint'),
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
    els.zInput.value = els.zSlider.value;      // Z 的范围固定 1–3，不随 n/l/m 变，回写即可
    [els.nInput, els.lInput, els.mInput, els.zInput].forEach((el) => el.classList.remove('invalid'));
  }

  /**
   * 实轨道选择器：按当前 l 列出该支壳层的全部实轨道。
   *
   * ★ 为什么实档不用 m 滑块：m 是**复**球谐 Y_l^m 的本征值指标，而实数解由 ±m 两个
   *   复解线性组合而来，**不再是 L̂z 的本征函数**（这是量子力学的基本事实）。用它给实轨道当名字，
   *   等于把一个它不再拥有的量子数贴上去。所以实档直接选"哪个实轨道"，按钮上的字
   *   就是它的名字（p_x、d_{xy}、f_{z³}…）；g、h 没有公认名，改用直角坐标多项式。
   *
   * 顺序取化学惯例 m = 0, +1, −1, +2, −2, …（cos 型在前、sin 型在后）。
   * 只在 l 变化时重建按钮，其余只同步选中态 —— 重建会打断点击反馈与键盘焦点。
   */
  let realOrbL = -1;
  function syncRealOrbitButtons() {
    const l = state.l;
    if (l !== realOrbL) {
      realOrbL = l;
      const order = [0];
      for (let mm = 1; mm <= l; mm++) { order.push(mm, -mm); }
      els.realOrbSeg.innerHTML = order.map(function (mm) {
        const named = !!Formula.realOrbitalName(l, mm);
        // ★ 用 HTML 版：l≥4 的标签是直角坐标多项式（含 x^{4} 这类记号），
        //   直接塞纯文本会原样显示成 "x^{4}"。
        return '<button class="seg-btn" data-m="' + mm + '"' +
          (named ? '' : ' title="该支壳层没有公认的惯用名，这里用角向部分的直角坐标多项式标记"') +
          '>' + Formula.realOrbitalLabelHtml(l, mm) + '</button>';
      }).join('');
      // 没有惯用名的支壳层给一句说明，否则学生会以为程序忘了起名
      els.realOrbHint.textContent = (l >= 4)
        ? '这一支壳层没有公认的惯用名（高角动量轨道在文献里只按对称性分类），'
          + '故用角向部分的直角坐标多项式标记。'
        : '';
    }
    const btns = els.realOrbSeg.querySelectorAll('.seg-btn');
    for (let i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('active', +btns[i].dataset.m === state.m);
    }
  }

  /**
   * 切换「视图对象」的连带规则（第 9 条）：**球谐档没有叠加态可言**。
   *
   * ★ 理由：叠加态描述的是**完整波函数** ψ = Σcᵢψᵢ，而球谐曲面画的是**角度部分** Y。
   *   render3d 在球谐档只拿 l/m/mode 去画（见 updateViewer 的 sph 分支），各分量的 n
   *   被整块丢弃 —— 二者只有在各分量 n 相同时才能对上，而内置预设 ψ_1s+ψ_2s 恰恰是
   *   n 不同的那一类。保留叠加态就会出现"三维画着某个单一 l 的曲面、公式却写着多分量
   *   叠加"的当场矛盾。故切到球谐档即清掉叠加态（与"拖 n/l/m 自动退出"同一层保护），
   *   并把量子态入口收起来。
   * ★ 切回波函数档**不自动恢复** —— 那是有意的（叠加态已被清空），界面上写明了。
   */
  function applyViewTargetRules() {
    const sph = (activeValue('#targetSeg', 'data-target') || 'wave') === 'spherical';
    if (sph) exitSuperposition();
    if (window.StateEditor && window.StateEditor.setAvailable) window.StateEditor.setAvailable(!sph);
  }

  /**
   * 两档各自的**默认着色**（第 19 条）。切换档位时重置为该档默认；同一档内用户手动
   * 改过之后保持不变 —— 只在他再次切换档位时才覆盖，不偷偷改他的显式选择。
   *   实数解 → 相位色（正负双色）：符号翻转是实解最核心、最该第一眼看见的物理；
   *   复数解 → 支壳层色（纯色）：复解的相位绕 z 轴一圈就把颜色走遍，默认给彩虹的话
   *            学生第一眼看到的是"花"，而不是"这个轨道长什么样"。
   * 想要复解那一圈彩虹的，去「进阶 → 三维着色」里打开（界面上写明了位置 ——
   * 收起来不等于删掉，不写清楚就会被当成"这功能没了"）。
   */
  let lastModeForColor = null;
  function applyModeDefaultColor() {
    const m = activeValue('#modeSeg', 'data-mode') || 'real';
    if (m === lastModeForColor) return;
    lastModeForColor = m;
    setSeg('#colorSeg', 'data-mode', (m === 'real') ? 'phase' : 'orbital');
  }

  /**
   * 球谐判据（|Y| / |Y|²）的提示与可用性 —— **按 l 变**。
   *
   * ★ 第 6 条：这段提示原先写死成"|Y|² 的曲面比 |Y| 的瘦（教材所谓"相切的鸡蛋"）"，
   *   而"两个相切的球面/鸡蛋"是 **p 轨道（l=1）** 才有的形状。l=0 的学生看到的是一个
   *   球，却被告诉"这是相切的鸡蛋"—— 说明文字与眼前的图形当场矛盾。
   *   l=0 时 Y 是常数，|Y| 与 |Y|² 只差一个正的比例因子，两个判据画出来一模一样，
   *   所以按钮一并禁用（留着能点却毫无变化，比没有更糟）。
   */
  function syncYCritHint() {
    if (!els.yCritHint || !els.yCritSeg) return;
    const l = state.l;
    const degenerate = (l === 0);
    els.yCritSeg.querySelectorAll('.seg-btn').forEach((b) => { b.disabled = degenerate; });
    if (degenerate) {
      els.yCritHint.textContent = 'l = 0 时 Y 是常数，|Y| 与 |Y|² 只差一个比例因子 —— 曲面都退化成同一个球面，两个判据没有区别。';
    } else if (l === 1) {
      els.yCritHint.textContent = 'p 轨道：|Y|² 的曲面比 |Y| 的"瘦" —— 两个相切的球面变成两个相切的椭球。';
    } else {
      els.yCritHint.textContent = '判据换成平方后，瓣与节面的**位置**不变，只是径向轮廓整体收缩。';
    }
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
    if (which === 'z') { lo = 1; hi = 3; slider = els.zSlider; }
    else if (which === 'n') { lo = 1; hi = 6; slider = els.nSlider; }
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
    state.Z = +els.zSlider.value;
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
    // 实轨道按钮要与 state.m 保持一致（智能体改 m、拖滑块、点按钮三条路都会走到这里）
    syncRealOrbitButtons();
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
    try { fr = OM.shellPeakFractions(n, l, state.Z); } catch (e) { return 0.10; }
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
    // ★ Z 必须进 key —— 不进就会"换了 Z 画面不变"（走缓存复用分支）
    return 'Z' + state.Z + '-' + state.n + '-' + state.l + '-' + state.m + '-' + state.mode + '-' + state.psiCrit +
      (sig ? '-S:' + sig + '@' + state.relPhase : '');
  }

  function updateViewer() {
    // ★ 两个档位是两条独立的重建路径，不是一个开关的两个分支：
    //   'spherical' 画极坐标曲面 r = |Y|（解析形状，直接三角化）；
    //   'wave'      画 ψ 的等值面（标量场 + marching tetrahedra）或粒子云。
    //   所以这里用 if/else 而不是在渲染模式里再加一个维度。
    const sph = (state.viewTarget === 'spherical');
    if (sph) {
      // 球谐曲面是**纯角度函数**，与 Z 无关 —— 所以这一档不传 Z，也不需要传
      Orbit3D.updateAngular(state.l, state.m, state.mode, state.angWhich);
    } else if (state.renderMode === 'surface') {
      const key = currentFieldKey();
      if (key !== lastFieldKey) {
        // 拖动相位滑块时用较低分辨率预览（每帧重建等值面，高分辨率会卡）；
        // 松手后 __ORBIT_PREVIEW__ 复位，会以全分辨率重建一次
        const preview = !!window.__ORBIT_PREVIEW__;
        const gridRes = preview ? (isMobile ? 30 : 40) : (isMobile ? 46 : 68);
        Orbit3D.updateSurface(state.n, state.l, state.m, state.mode, gridRes, state.level,
          state.colorMode, state.psiCrit, state.terms, state.relPhase, state.Z);
        lastFieldKey = key;
      } else {
        // 仅阈值/着色变化：复用已缓存的标量场与网格
        Orbit3D.setSurfaceLevel(state.level, state.colorMode, state.psiCrit);
      }
    } else {
      const cloud = (state.terms && state.terms.length)
        ? OM.samplePointsSuperposition(state.terms, state.pointCount, state.colorMode,
            state.terms.map(function (t, i) { return i * state.relPhase; }), state.Z)
        : OM.samplePoints(state.n, state.l, state.m, state.mode, state.pointCount, state.colorMode, state.Z);
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
    // ★ 第 8 条：球谐档原先把「三维着色」整组**静默隐藏**，用户会以为漏做了。
    //   改为一并显示一行说明，讲清"为什么这一档没有着色选项"。
    if (els.sphColorHint) els.sphColorHint.style.display = sph ? '' : 'none';
    if (sph) syncYCritHint();
    els.levelSet.style.display = (!sph && state.renderMode === 'surface') ? '' : 'none';
    els.pointSet.style.display = (!sph && state.renderMode === 'points') ? '' : 'none';
    // ★ 「磁量子数 m」与「实轨道」**互斥显示**：m 是复解的本征值指标，实解不用它
    //   （理由见 syncRealOrbitButtons 的说明）。两档各留一个，避免出现"两个控件说的是
    //   同一件事、却可能对不上"的局面。
    const realMode = (state.mode === 'real');
    els.mSet.style.display = realMode ? 'none' : '';
    els.realOrbSet.style.display = realMode ? '' : 'none';
    if (realMode) syncRealOrbitButtons();
  }

  /**
   * 2D 图表当前该画哪一份（第 G 批）。
   *
   * ★ 三张 2D 图的能力**不一样**，不能一律对待：
   *   · 径向分布、Θ/Φ 卡 —— 画不了叠加态。Σcᵢψᵢ 只有在各分量 n 相同时才能因子化出
   *     角度部分，一般做不到（内置预设 ψ_1s+ψ_2s 恰恰不是）。所以它们只能画**某一个分量**。
   *   · 截面密度 —— **可以**直接画叠加态：在平面上求 |ψ_super|² 即可，
   *     densitySuperposition 已经算得动。这是四张图里唯一能真正画出叠加态的那张。
   * 原先三张图一律画滑块上的纯态，与三维画的叠加态对不上，而界面上没有任何提示 ——
   * 学生看着"三维是叠加态、2D 图是另一个轨道"，无从察觉。
   */
  function chartTermState(allowSuper) {
    const t = state.terms || [];
    if (!t.length) {
      return { kind: 'pure', idx: -1, n: state.n, l: state.l, m: state.m, mode: state.mode };
    }
    if (allowSuper && state.chartTerm === 'super') {
      return { kind: 'super', idx: -1, terms: t, n: state.n, l: state.l, m: state.m, mode: state.mode };
    }
    let idx = (state.chartTerm === 'super') ? 0 : Number(state.chartTerm);
    if (!Number.isFinite(idx) || idx < 0 || idx >= t.length) idx = 0;
    const x = t[idx];
    return { kind: 'term', idx: idx, terms: t, n: x.n, l: x.l, m: x.m, mode: x.mode || 'real' };
  }

  /** 分量选择器：有叠加态才出现；选项按各分量**自己的解型**取标记（实项名字 / 复项 m） */
  function syncChartTermBars() {
    const t = state.terms || [];
    const has = t.length > 0;
    const labelOf = (x, i) => {
      const md = x.mode || 'real';
      const nm = (md === 'real' && window.Formula && window.Formula.realOrbitalLabelPlain)
        ? window.Formula.realOrbitalLabelPlain(x.l, x.m) : '';
      return '#' + (i + 1) + ' ' + x.n +
        (md === 'real' && nm ? nm : '（m=' + (x.m > 0 ? '+' + x.m : x.m) + '）');
    };
    const cur = (state.chartTerm === 'super') ? 'super' : String(state.chartTerm);
    [['#radialTermBar', '#radialTermSel', false],
      ['#thetaPhiTermBar', '#thetaPhiTermSel', false],
      ['#sectionTermBar', '#sectionTermSel', true]].forEach(function (spec) {
      const bar = $(spec[0]), sel = $(spec[1]);
      if (!bar || !sel) return;
      bar.style.display = has ? '' : 'none';
      if (!has) { sel.innerHTML = ''; return; }
      let html = '';
      if (spec[2]) html += '<option value="super">叠加态 ψ = Σcᵢψᵢ（本图可直接画）</option>';
      t.forEach(function (x, i) { html += '<option value="' + i + '">' + labelOf(x, i) + '</option>'; });
      sel.innerHTML = html;
      // 不支持叠加态的图：当前选的是 'super' 时落到第 1 个分量（state.chartTerm 不动，
      // 这样从截面图切回来时仍记得"要看叠加态"）
      sel.value = (spec[2] || cur !== 'super') ? cur : '0';
      sel.onchange = function () {
        state.chartTerm = (sel.value === 'super') ? 'super' : Number(sel.value);
        updateCharts();
      };
    });
  }

  function updateCharts() {
    syncChartTermBars();
    const rt = chartTermState(false);        // 径向与 Θ/Φ：不支持叠加态，落到某个分量
    const st = chartTermState(true);         // 截面：支持叠加态
    Charts.drawRadial(els.radialChart, rt.n, rt.l, state.radial, state.Z);
    // Θ/Φ 卡片画的是 Y 的**两个因子**（不随 |Y|/|Y|² 判据变 —— 判据改的是三维里
    // 那张曲面的轮廓，而"Y = Θ·Φ"这个分解关系与判据无关）
    Charts.drawThetaPhi(els.thetaPhiChart, rt.l, rt.m, rt.mode);
    Charts.drawSection(els.sectionChart, st.n, st.l, st.m, st.mode, state.plane, state.sectionMode, state.Z,
      (st.kind === 'super') ? st.terms : null, state.relPhase);
    // 换轨道 / 换平面都会改变"这一面是不是节面"，光标与触摸策略要跟着变（第 11 条）
    syncSectionUI();
  }

  /**
   * 只重绘截面图（不牵动其余两张），并同步「复位缩放」小控件的显隐。
   * 缩放/平移时用它而不是 updateCharts —— 后者会顺带重算径向与角度图，纯属浪费。
   */
  function redrawSection() {
    const st = chartTermState(true);
    Charts.drawSection(els.sectionChart, st.n, st.l, st.m, st.mode, state.plane, state.sectionMode, state.Z,
      (st.kind === 'super') ? st.terms : null, state.relPhase);
    // ★ 节面上不显示「复位缩放」小控件 —— 那上面本来就没有可缩放的内容（第 11 条）
    const chip = $('#sectionResetChip');
    const s = Charts.sectionState();
    if (chip) chip.style.display = (!s.nodal && s.userAdjusted) ? '' : 'none';
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
  /**
   * 截面图"节面"状态下的界面收尾（第 11 条）。
   * ★ 主守卫在 charts.js 的数据入口（zoomSection / panSection 一进门就 return false），
   *   这里只做两件数据层看不到的事：把光标还原、放开触摸滚动 —— 否则节面上拖动会被
   *   "抓住"却毫无响应，看着像卡死。
   * ★ 必须**集中一处**同步，因为"节面与否"会在三条路变化：换截面平面（updateCharts）、
   *   缩放平移（attachSectionView 的 onChange）、换轨道。原先只在 attachSectionView 里
   *   同步，换平面时就漏了 —— 实测换到 2p_z 的 xy 截面后光标仍是 grab。
   */
  const sectionCanvases = [];                 // 卡片图 + 浮窗图（同一份视图状态）
  function registerSectionCanvas(cv) {
    if (cv && sectionCanvases.indexOf(cv) < 0) sectionCanvases.push(cv);
    syncSectionUI();
  }
  function syncSectionUI() {
    const nodal = !!Charts.sectionState().nodal;
    sectionCanvases.forEach((cv) => {
      cv.style.cursor = nodal ? 'default' : 'grab';
      cv.style.touchAction = nodal ? 'auto' : 'none';
    });
  }

  function attachSectionView(cv, onChange) {
    if (!cv) return false;
    const halfE = () => OM.rExtent(state.n, state.l, state.Z) * 1.05;
    let drag = null;
    // ★ 多点触控：单指拖动平移，**双指捏合缩放**（与三维视图同一套手势约定）。
    //   原先只有 wheel 能缩放 —— 桌面没问题，但触屏上就完全没法放大截面图，
    //   而"放大看暗部"恰恰是这张图的主要用法。故补上捏合。
    const pointers = new Map();
    let lastPinch = 0, lastMid = null;

    const changed = () => { onChange(); syncSectionUI(); };
    registerSectionCanvas(cv);

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
      if (Charts.zoomSection(Math.exp(-e.deltaY * 0.0015), a.u, a.v)) changed();
    }, { passive: false });

    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // 节面：整片空白没什么可拖动/缩放的，不进入手势（否则光标会变 grabbing 却毫无响应）
      if (Charts.sectionState().nodal) return;
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
        if (dirty) changed();
        return;
      }
      if (!drag) return;
      const st = Charts.sectionState();
      // 每像素对应多少平面坐标：视窗全宽 2·E/scale 铺满画布宽度
      const k = (2 * halfE() / st.scale) / Math.max(1, cv.clientWidth);
      // 指针右移 → 内容跟着右移 → 视窗中心左移，故取负号
      Charts.panSection(-(e.clientX - drag.x) * k, -(e.clientY - drag.y) * k);
      drag = { x: e.clientX, y: e.clientY };
      changed();
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
    cv.addEventListener("dblclick", () => { Charts.resetSectionView(); changed(); });
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
    // 右上角轨道标签。
    // ★ 实档**不写 m**：m 是复球谐 Y_l^m 的本征值指标，而实解由 ±m 组合而来、
    //   不再是 L̂z 的本征函数 —— 把它贴在实解上等于用一个它已不拥有的量子数命名。
    //   实档直接显示该实轨道的名字（3p_x 显示成 "3p" + 下标 x）；l≥4 没有惯用名，
    //   显示直角坐标多项式。复档保留 m 下标（在那里 m 名副其实）。
    const sub = OM.SUBSHELL[Math.min(state.l, OM.SUBSHELL.length - 1)];
    if (state.mode === 'real') {
      // 有惯用名时名字里已含支壳层字母（p_z、d_{xy}），前缀只写 n，得 3p_z；
      // l≥4 的多项式不含字母，才需要 n + 支壳层字母，得 "6h 3xyz³−xyzr²"。
      const named = !!Formula.realOrbitalName(state.l, state.m);
      els.orbitTitle.innerHTML = state.n +
        (named ? '' : sub + ' ') +
        '<span class="orbit-real">' + Formula.realOrbitalLabelHtml(state.l, state.m) + '</span>';
    } else {
      els.orbitTitle.innerHTML = state.n + sub + '<sub>' + f.mLabel + '</sub>';
    }
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
    // 量子数滑块（n/l 变更需先同步依赖范围内的，再异步重算）。
    // Z 也走同一条通路 —— 它与 n/l/m 一样是"改了就整场重算"的参数。
    [els.zSlider, els.nSlider, els.lSlider, els.mSlider].forEach((el) => {
      el.addEventListener('input', () => {
        // ★ 拖 n/l/m 与"用动作设量子数"是同一个意图（要看这个单一本征态），
        //   所以走同一层保护；Z 不指定本征态，故不退出叠加态（见 exitSuperposition）。
        if (el !== els.zSlider) exitSuperposition();
        syncRanges();
        scheduleUpdate();
      });
    });
    // 实轨道按钮组：实档下取代 m 滑块。
    // ★ 不写进 state 里另立一份"实轨道"真值 —— 它仍然是 m，只是换了个呈现方式。
    //   另立一份就会出现两套状态互相追着改的经典问题（谁是真值、谁该跟谁走）。
    els.realOrbSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      exitSuperposition();               // 与拖 m 滑块同一意图：要看单一本征态
      els.mSlider.value = btn.dataset.m;
      readFromControls();
      recompute();
    });
    // 量子数数字框：键入即校验；回车提交；失焦时把非法输入还原为当前真值
    const numBind = (el, which) => {
      el.addEventListener('input', () => commitNumber(el, which));
      el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { commitNumber(el, which); el.blur(); } });
      el.addEventListener('blur', () => syncRanges());
    };
    numBind(els.zInput, 'z');
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
    // 径向图的特征标注：**峰值与节点可同时标注**（第 17 条），点一下切换该按钮。
    // 仍走动作通路 —— 图表状态与按钮亮灭只由 setRadialMarks 一处回写，避免两处各改一半。
    const markSeg = $('#radialMarkSeg');
    if (markSeg) {
      markSeg.addEventListener('click', (e) => {
        const btn = e.target.closest('.seg-btn');
        if (!btn) return;
        const next = [];
        markSeg.querySelectorAll('.seg-btn').forEach((b) => {
          const on = (b === btn) ? !b.classList.contains('active') : b.classList.contains('active');
          if (on) next.push(b.getAttribute('data-m'));
        });
        window.OrbitApp.applyAction({ action: 'setRadialMarks', params: { target: 'ALL', feature: next } });
      });
    }
    // 单选分段
    // 波函数形式：切换时要**顺带重置着色**为该档的默认（第 19 条），
    // 所以不能走通用 bindSeg —— 那会在 readFromControls 之后才改控件，读到旧值。
    $('#modeSeg').addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      setActive(btn);
      applyModeDefaultColor();          // 必须在 readFromControls 之前
      readFromControls();
      recompute();
    });
    bindSeg('#renderSeg', 'data-mode');
    bindSeg('#colorSeg', 'data-mode');
    bindSeg('#psiSeg', 'data-mode');
    bindSeg('#phaseSeg', 'data-mode');
    bindSeg('#planeSeg', 'data-p');
    // 视图对象：切到球谐档要连带退出叠加态并收起量子态入口（第 9 条，理由见 applyViewTargetRules）
    $('#targetSeg').addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      setActive(btn);
      applyViewTargetRules();
      readFromControls();
      recompute();
    });
    bindSeg('#yCritSeg', 'data-k');
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
    // 节面显示（第 18 条）：一枚按钮一次点亮两类节面（径向球壳 + 角度锥/平面），再点清除。
    // ★ 节面属于"画上去的辅助几何"，不在 OrbitApp 的 state 里（见 render3d 的
    //   getAnnotations/setAnnotations），所以这里与智能体走的是**同一个** render3d 函数；
    //   按钮亮态由 setAuxChangeHandler 广播同步 —— 清除它的入口不止一个（按钮、画布
    //   左上角的标签、智能体的 spotlightNodes），各处自己同步必然会漏。
    const nodeBtn = $('#nodeBtn');
    if (nodeBtn) {
      Orbit3D.setAuxChangeHandler(function () {
        const cur = Orbit3D.getAnnotations().spotlight;
        nodeBtn.classList.toggle('active', !!(cur && cur.types && cur.types.length));
      });
      nodeBtn.addEventListener('click', function () {
        const cur = Orbit3D.getAnnotations().spotlight;
        const on = !(cur && cur.types && cur.types.length);
        Orbit3D.spotlightNodes(['radial', 'angular'], on);
      });
    }
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

  /**
   * 退出叠加态，回到"当前滑块的纯态"。返回是否真的退出了。
   *
   * ★ 两条入口必须共用它：受控动作 `setQuantumNumbers` 与**界面上的 n/l/m 滑块**。
   *   原先只有动作路径有这层保护（那里的注释写得很清楚："指定了具体量子数即意味着
   *   要看这个单一本征态"），滑块路径没有 —— 于是"设好叠加态后拖一下滑块"会出现：
   *   三维与公式仍是叠加态（terms 优先于 n/l/m），而三张 2D 图已经变成纯态图
   *   （charts.js 不支持叠加态），三者当场矛盾。
   *   **同一个建模意图走两条入口却有两种行为**，就是这类错位的来源。
   */
  function exitSuperposition() {
    if (!(state.terms && state.terms.length)) return false;
    state.terms = []; state.relPhase = 0;
    state.chartTerm = 'super';                 // 分量选择器随之复位（第 G 批）
    if (window.StateEditor && window.StateEditor.clear) window.StateEditor.clear();
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
      // ★ 直接写 value、不派发 input 事件 —— 所以不会触发 exitSuperposition
      //   （恢复一套含叠加态的状态时，若在这里退出叠加态就会把刚恢复的 terms 清掉）。
      if (els.zSlider) els.zSlider.value = s.nuclearCharge || 1;
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
      // 球谐档要收起量子态入口（第 9 条）；这里只改控件不重算 —— 重算由 applyAction 统一做
      if (window.StateEditor && window.StateEditor.setAvailable) {
        window.StateEditor.setAvailable(s.viewTarget !== 'spherical');
      }
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
      // ★ 指定了具体量子数即意味着"要看这个单一本征态" → 自动退出叠加态
      //   （判据与界面滑块共用 exitSuperposition，两条入口行为一致）。
      const given = (p.n != null) || (p.l != null) || (p.m != null);
      if (given) exitSuperposition();
      // n → l → m 依次设置，每步都收敛范围，避免越界被夹紧而丢失意图
      if (p.n != null) { setSlider(els.nSlider, p.n); syncRanges(); }
      if (p.l != null) { setSlider(els.lSlider, p.l); syncRanges(); }
      if (p.m != null) { setSlider(els.mSlider, p.m); syncRanges(); }
    },
    /**
     * 设置核电荷数 Z（类氢）。
     * ★ 与量子数不同，**换 Z 不退出叠加态** —— Z 是"原子"的属性，叠加态整体跟着
     *   缩放即可（psiSuperposition 已接受 Z），不需要退回纯态。
     */
    setNuclearCharge(p) {
      const v = Math.round(+p.Z);
      if (!(v >= 1 && v <= 3)) return false;
      setSlider(els.zSlider, v);
      return true;
    },
    setWavefunctionMode(p) {
      const ok = setSeg('#modeSeg', 'data-mode', p.mode);
      // ★ 与界面点按钮同一条语义：换档就把着色重置为该档默认（第 19 条）。
      //   若智能体随后还要指定着色，再调 setColorMode 即可 —— 它排在后、以后者为准。
      if (ok) applyModeDefaultColor();
      return ok;
    },
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
    setViewTarget(p) {
      const ok = setSeg('#targetSeg', 'data-target', p.target);
      // 与界面点按钮同一条语义：切球谐档要退出叠加态并收起量子态入口（第 9 条）
      if (ok) applyViewTargetRules();
      return ok;
    },
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
      // ★ feature 支持**数组**（峰值与节点同屏，第 17 条）；传字符串时按"只标这一类"处理，
      //   保持向后兼容 —— 智能体沿用旧的单值写法依然有效。
      const raw = p && p.feature;
      const list = (raw == null) ? [] : (Array.isArray(raw) ? raw.slice() : [raw]);
      const target = (p && p.target) ? p.target : 'ALL';
      const seg = document.querySelector('#radialMarkSeg');
      if (seg) {
        seg.querySelectorAll('.seg-btn').forEach((b) => {
          b.classList.toggle('active', list.indexOf(b.getAttribute('data-m')) >= 0);
        });
      }
      if (window.Charts && window.Charts.setRadialHighlight) {
        window.Charts.setRadialHighlight(list.length ? target : null, list);
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
    clearSuperposition() { state.terms = []; state.relPhase = 0; state.chartTerm = 'super'; return true; },
    /**
     * 2D 图表画哪一份（第 G 批）：'super' = 叠加态整体（**只有截面图**能这么画），
     * 数字 = 叠加态中的第 i 个分量（从 0 起）。没有叠加态时该动作无效果。
     */
    setChartTerm(p) {
      const t = state.terms || [];
      if (!t.length) return false;
      const v = p && p.term;
      if (v === 'super' || v == null) { state.chartTerm = 'super'; return true; }
      const i = Number(v);
      if (!Number.isFinite(i) || i < 0 || i >= t.length) return false;
      state.chartTerm = Math.floor(i);
      return true;
    },
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
        nuclearCharge: state.Z,
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
        chartTerm: state.chartTerm,
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
        Charts.drawRadial(canvas, state.n, state.l, state.radial, state.Z);
        return true;
      }
      if (target === 'section') {
        Charts.drawSection(canvas, state.n, state.l, state.m, state.mode, state.plane, state.sectionMode, state.Z);
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
    // 记下初始档位 —— 这样 applyModeDefaultColor 只在**真的换档**时才重置着色，
    // 不会在启动时把 HTML 里写好的初始选中项又改一遍。
    lastModeForColor = activeValue('#modeSeg', 'data-mode') || 'real';
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
