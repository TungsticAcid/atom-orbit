/**
 * scene-bridge.js — 受控动作执行（智能体的「手」）
 *
 * 唯一入口：任何对视图的改动都必须经过这里，保证可控、可审计、可中断。
 *
 * 关键设计：
 *   1. **不重构渲染层**：动画用 requestAnimationFrame 对现有 setter 做插值调用；
 *      render3d.js 的 setter 保持瞬时语义不变。
 *   2. **每个动作绑定一个知识点**（concept）：使动作可解释、可教学、可复现。
 *   3. **校验与限流**：参数类型/范围校验、单轮动作数上限（**只有步数上限，没有时长上限**）。
 *   4. **可中断**：任何时刻可停止当前序列，并丢弃未执行的动作。
 *   5. **分镜节奏（pacing）**：每个动作之间强制留出"停留时间"，并把它对应的
 *      speech 旁白打出来——否则十几个动作会在几十毫秒内播完，用户根本看不清
 *      中间步骤（这是"讲解时切换过快"的根因）。
 */
window.SceneBridge = (function () {
  'use strict';

  const MAX_ACTIONS_PER_TURN = 12;     // 单轮动作数上限

  // ---- 分镜节奏 ----
  // 瞬时动作：改完立刻返回，但**必须停一下**让肉眼跟上；否则等于没演示。
  const DEFAULT_DWELL_MS = 1200;
  const MIN_DWELL_MS = 350;
  const MAX_DWELL_MS = 5000;
  const AFTER_ANIMATED_MS = 450;       // 动画（扫描类）播完后的落点停顿
  const MAX_QUEUE = 24;                // 播放队列上限（分几次下发时的累计步数）

  const DEFAULT_SWEEP_MS = 2000;

  // ---------------------------------------------------------------------------
  // 动作词汇表 —— 既用于执行，也用于 listSceneActions 告知模型
  // ---------------------------------------------------------------------------
  const VOCAB = {
    setQuantumNumbers: {
      group: '量子数', concept: 'K1',
      desc: '跳转到指定量子数（n/l/m），越界自动夹紧',
      params: { n: 'int? 1–6', l: 'int? 0–n-1', m: 'int? -l–l' },
    },
    sweepQuantumNumber: {
      group: '量子数', concept: 'K1/K4', animated: true,
      desc: '连续扫描某个量子数（如固定 n 扫 l，展示"l 决定形状"）',
      params: { axis: "'n'|'l'|'m'", from: 'int', to: 'int', durationMs: 'int? 默认 2000' },
    },
    setWavefunctionMode: {
      group: '模式', concept: 'K6',
      desc: '切换实函数/复函数（实球谐 ↔ 复球谐）',
      params: { mode: "'real'|'complex'" },
    },
    setRenderMode: {
      group: '模式', concept: '',
      desc: '切换三维渲染方式：粒子云（概率统计）/ 等值面（形状）',
      params: { mode: "'points'|'surface'" },
    },
    setColorMode: {
      group: '模式', concept: 'K7',
      desc: '三维着色：轨道色（按支壳层）/ 相位色（按 arg ψ，使"符号"可见）',
      params: { mode: "'orbital'|'phase'" },
    },
    setPsiCriterion: {
      group: '等值面', concept: 'K8',
      desc: '切换等值面判据 |ψ| 或 |ψ|²（同一读数下二者对应不同大小的曲面）',
      params: { criterion: "'psi'|'psi2'" },
    },
    setIsosurfaceLevel: {
      group: '等值面', concept: 'K8',
      desc: '设置等值面阈值（占峰值的比例）',
      params: { fraction: 'number 0.005–0.8' },
    },
    animateIsosurfaceLevel: {
      group: '等值面', concept: 'K5/K8', animated: true,
      desc: '阈值扫描：降低阈值时内层壳浮现，把径向节点变成可见的"套娃"',
      params: { from: 'number', to: 'number', durationMs: 'int?' },
    },
    showRadial: {
      group: '径向', concept: 'K3',
      desc: '选择径向图显示哪些曲线（可多选）',
      params: { which: "('R'|'R2'|'D')[]" },
    },
    highlightRadialFeature: {
      group: '径向', concept: 'K3',
      desc: '在径向图上标出峰值或零点（辨析 R 与 D 的核心手段）',
      params: { target: "'R'|'D'", feature: "'peak'|'zeros'" },
    },
    linkRadialTo3D: {
      group: '径向', concept: 'K3/K8',
      desc: '★ 在三维视图画出半径为 r 的参考球，把径向图横坐标与三维"一层壳"对应起来。'
        + '传 radius=0 即清除参考球（用完请主动清掉，别让壳一直留在画面上）。'
        + '画布左下角也会出现一枚可点击的撤销标签。',
      params: { radius: 'number (a0)；传 0 表示清除' },
    },
    setAngularView: {
      group: '角度', concept: 'K4',
      desc: '角度分布曲面显示 |Y| 或 |Y|²',
      params: { which: "'Y'|'Y2'" },
    },
    setSectionPlane: {
      group: '截面', concept: 'K5',
      desc: '切换截面平面 xy / xz / yz',
      params: { plane: "'xy'|'xz'|'yz'" },
    },
    setSectionMode: {
      group: '截面', concept: 'K5/K7',
      desc: '截面显示模式：密度着色 / 相位着色 / 等高线（等高线最适合数节面）',
      params: { mode: "'intensity'|'phase'|'contour'" },
    },
    spotlightNodes: {
      group: '节点', concept: 'K5',
      desc: '高亮节面，把"节点数公式"变成可点亮、可数的几何对象。传 on=false 清除高亮。',
      params: { type: "'radial'|'angular'", on: 'bool? 默认 true；false 表示清除' },
    },
    setAutoRotate: {
      group: '相机', concept: '',
      desc: '开关自动旋转',
      params: { on: 'bool' },
    },
    resetCamera: { group: '相机', concept: '', desc: '重置相机视角', params: {} },
    setFormulaHighlight: {
      group: '公式', concept: 'K1/K2',
      desc: '★ 高亮 KaTeX 公式中的某一项（R/Y/L/P/N，null 取消），实现公式—图形—数值三向联动',
      params: { part: "'R'|'Y'|'L'|'P'|'N'|null" },
    },
    showReferenceTable: {
      group: '导航', concept: '',
      desc: '打开教材对照表（R 表 / Y 表）',
      params: { which: "'R'|'Y'", open: 'bool?' },
    },
    loadPreset: {
      group: '叠加态', concept: 'K9',
      desc: '载入预设量子态：叠加态示例或杂化轨道（sp / sp² / sp³）',
      params: { key: '预设键，见 availableKeys' },
    },
    setSuperposition: {
      group: '叠加态', concept: 'K9',
      desc: '★ 自定义叠加态 ψ = Σ cᵢψᵢ（系数可任意，用于构造"不等性杂化"这类非等价组合）。'
        + '传入 2 项以上即退出单一本征态；传空数组等价于回到纯态。系数会自动归一化。',
      params: {
        terms: '[{ n, l, m, mode?, c:{re,im} }, …]　系数 c 为复数，实函数用 im=0 即可',
      },
    },
    setCoefficient: {
      group: '叠加态', concept: 'K9',
      desc: '只改叠加态中第 index 项的系数（从 0 开始计），并自动重新归一化。',
      params: { index: 'int 从 0 开始', re: 'number', im: 'number?' },
    },
    setRelPhase: {
      group: '叠加态', concept: 'K9',
      desc: '设置各项之间的相对相位 φ（弧度）。第 i 项取相位 i·φ。这是相对相位，不是真实时间。',
      params: { phase: 'number 弧度 0–2π' },
    },
    clearSuperposition: {
      group: '叠加态', concept: 'K9',
      desc: '退出叠加态，回到单一本征态 ψ(n,l,m)',
      params: {},
    },
    savePreset: {
      group: '叠加态', concept: 'K9',
      desc: '★ 把叠加态存成一个**具名预设按钮**。现场凑出来的系数（如不等性杂化的示意系数）'
        + '本来对话一过就没了，存成预设后学生自己就能一键复现、反复对照。'
        + '缺省存当前叠加态；建议同时在 note 里写明"示意系数，非真实分子数据"这类边界。',
      params: {
        label: 'string 按钮上显示的名字（如"不等性杂化（示意）"）',
        terms: '[{ n, l, m, mode?, c:{re,im} }, …]? 缺省用当前叠加态',
        note: 'string? 说明文字，会显示在预设下方',
        key: 'string? 自定键名，缺省自动生成（自定义键统一以 u- 开头）',
      },
    },
    deletePreset: {
      group: '叠加态', concept: 'K9',
      desc: '删除一个自定义预设。内置预设（sp/sp²/sp³ 等）不可删——它们是教学内容。',
      params: { key: 'string 预设键，见 loadPreset 的 availableKeys' },
    },
  };

  // ---------------------------------------------------------------------------
  // 运行状态
  // ---------------------------------------------------------------------------
  let rafId = null;
  let generation = 0;                  // 运行代号：区分"哪一次播放"
  let dwellTimer = null;               // 自动连播的停留定时器
  let pendingWait = null;              // 连播停留的 resolve（stop() 必须唤醒它）
  let pendingAnim = null;              // 动画动作的 resolve（同理）
  let gateResolve = null;              // 「下一步」闸门的 resolve（同理，最要紧的一个）
  let progressHooks = [];              // 播放进度回调（支持多个订阅者）

  // ---- 播放列表（分镜）----
  // ★ 为什么要有队列：演示必须"由用户点下一步"，而用户的点击可能在几秒后、也可能
  //   几分钟后才来。工具调用不能干等——那会把整条对话循环一起冻住。所以改成
  //   "入队 + 立即返回"，播放交给后台，节奏由用户掌握。
  let queue = [];                      // [{name, params, speech, holdMs, animated}]
  let qIndex = 0;                      // 下一步待执行的下标
  let qTotal = 0;                      // 本轮播放的总步数（含已执行的）
  let playing = false;
  let manual = true;                   // true=等用户点「下一步」；false=自动连播
  let atGate = false;                   // 是否正停在"等下一步"的闸门上（只有此时才允许回退）

  // ★ 每步执行前的快照，专供「上一步」回退。
  //   为什么不"反向执行动作"：动作带副作用（setQuantumNumbers 会顺手退出叠加态），
  //   反着跑不一定回到原处。存快照才是严格可逆的。
  let snapshots = [];

  const hooks = { ringHighlight: null, spotlightNodes: null, setFormulaHighlight: null };

  /** 由 render3d.js / formula.js 等注册扩展能力（避免硬耦合） */
  function registerHooks(h) { Object.assign(hooks, h || {}); }

  /**
   * 注册播放进度回调：(evt) => void，返回一个取消订阅的函数。
   * ★ 用数组而不是单个槽位：单槽位时后注册者会**静默顶掉**先注册者
   *   （面板就是先注册的那个），表现为"进度条突然不更新了"，极难排查。
   */
  function onProgress(fn) {
    if (typeof fn !== 'function') return function () {};
    progressHooks.push(fn);
    return function off() {
      const i = progressHooks.indexOf(fn);
      if (i >= 0) progressHooks.splice(i, 1);
    };
  }
  function emitProgress(evt) {
    for (let i = 0; i < progressHooks.length; i++) {
      try { progressHooks[i](evt); } catch (e) { /* 单个订阅者异常不应影响演示 */ }
    }
  }

  /**
   * 中止当前播放。
   *
   * ★ 必须同时做到五件事，缺一不可：
   *   ① 让播放循环作废（generation 前进一格）
   *   ② 清空队列、丢弃尚未执行的动作
   *   ③ 取消动画帧与停留定时器
   *   ④ **唤醒所有等待中的 Promise**（停留 / 动画 / 下一步闸门）
   *   ⑤ 通知面板收起进度条
   *
   *   第 ④ 条最容易被漏掉：只 cancelAnimationFrame / clearTimeout 而不 resolve，
   *   对应的 await 会永远挂住。闸门尤其致命——点「停止」本意是退出，结果反而锁死。
   */
  function stop() {
    generation++;                        // 旧循环下次检查时自行退出
    queue = [];
    qIndex = 0;
    qTotal = 0;
    playing = false;
    atGate = false;
    snapshots = [];
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (pendingWait) { const r = pendingWait; pendingWait = null; r(); }
    if (pendingAnim) { const r = pendingAnim; pendingAnim = null; r({ ok: true, aborted: true }); }
    if (gateResolve) { const r = gateResolve; gateResolve = null; r(); }
    emitProgress({ phase: 'stopped' });
  }

  /** 抓一份"足以完整还原视图"的快照 */
  function captureSnapshot() {
    const A = window.OrbitApp;
    if (!A) return null;
    const ann = (window.Orbit3D && window.Orbit3D.getAnnotations)
      ? window.Orbit3D.getAnnotations() : null;
    return { state: A.getState(), annotations: ann };
  }

  /** 还原快照：应用状态 + 辅助几何（参考球 / 节面高亮） */
  function restoreSnapshot(snap) {
    if (!snap) return false;
    const A = window.OrbitApp;
    if (A && snap.state) A.applyAction({ action: 'restoreState', params: { state: snap.state } });
    if (snap.annotations && window.Orbit3D && window.Orbit3D.setAnnotations) {
      window.Orbit3D.setAnnotations(snap.annotations);
    }
    return true;
  }

  /** 可被 stop() 立刻唤醒的停留（自动连播模式用） */
  function wait(ms) {
    return new Promise((resolve) => {
      if (ms <= 0) return resolve();
      pendingWait = () => { pendingWait = null; resolve(); };
      dwellTimer = setTimeout(() => {
        dwellTimer = null;
        const r = pendingWait;
        pendingWait = null;
        if (r) r();
      }, ms);
    });
  }

  /** 「下一步」闸门：一直等到用户点按钮、或切连播、或点停止 */
  function waitGate() {
    return new Promise((resolve) => { gateResolve = resolve; });
  }
  function releaseGate() { if (gateResolve) { const r = gateResolve; gateResolve = null; r(); } }

  /** 用户点了「下一步」 */
  function next() { atGate = false; releaseGate(); }

  /**
   * 用户点了「上一步」：回到上一步执行**之前**的状态。
   *
   * ★ 停在闸门上时：只改下标与画面，**刻意不释放闸门**——闸门一放开，循环就会
   *   立刻重新执行那一步，等于白退。正确做法是让循环继续停在原地等「下一步」。
   * ★ 演示已结束时：说明循环已经退出，于是重新起一个循环并 parkImmediately=true
   *   让它先停在闸门上。这样"播完之后还能退回去重看"才成立。
   * ★ 只在手动模式可用。自动连播中回退会与正在往前跑的循环打架。
   */
  function prev() {
    if (!queue.length) return { ok: false, error: '当前没有可回退的演示' };
    if (!manual) return { ok: false, error: '自动连播中无法回退，请先切到手动逐步' };
    if (playing && !atGate) return { ok: false, error: '当前步骤正在播放，请稍候再回退' };
    if (qIndex <= 0) return { ok: false, error: '已经是第一步了' };
    qIndex--;
    restoreSnapshot(snapshots[qIndex]);
    if (!playing) {
      playing = true;
      runQueue(generation, false, true);   // 先停在闸门上，不立刻执行
    }
    emitProgress({
      phase: 'back', index: qIndex, total: queue.length,
      step: queue[qIndex] ? {
        action: queue[qIndex].name,
        label: describe(queue[qIndex].name, queue[qIndex].params),
        speech: queue[qIndex].speech,
      } : null,
    });
    return { ok: true, index: qIndex, total: queue.length };
  }

  /** 用户点了「连续播放」：后续步骤不再等确认 */
  function autoPlay() {
    manual = false;
    atGate = false;
    if (playing) emitProgress({ phase: 'auto', index: qIndex + 1, total: qTotal });
    releaseGate();
  }

  /** 供智能体/感知层查询当前播放状态 */
  function state() {
    return {
      playing: playing,
      mode: manual ? 'manual' : 'auto',
      index: qIndex,                   // 已执行步数
      total: qTotal,
      waitingForUser: atGate,          // 是否正停在「下一步」闸门上
      canPrev: manual && qIndex > 0 && (!playing || atGate),
      canNext: atGate && qIndex < queue.length,
      canReplay: !playing && queue.length > 0,   // 播完后可重播
      pending: queue.slice(qIndex).map((s) => ({ action: s.name, speech: s.speech || null })),
    };
  }

  // ---------------------------------------------------------------------------
  // 参数校验
  // ---------------------------------------------------------------------------
  const clampInt = (v, lo, hi) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
  };
  const clampNum = (v, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
  };

  /**
   * 归一化系数（Σ|c|² = 1）。
   *
   * ★ 凡是改动系数的入口都必须过这一道：模型/用户给的是"相对大小"，
   *   而密度量级、等值面阈值都是按归一化态定义的。漏掉归一化不会报错，
   *   只会让画出来的东西悄悄错位——最难发现的一类问题。
   *   原先只有 setSuperposition 走了归一化，setCoefficient 直接落库，
   *   于是"把第 0 项改成 0.8"会让 Σ|c|² 变成 1.14，与动作说明自相矛盾。
   */
  function normalizeTerms(list) {
    if (!list || !list.length) return list || [];
    const sm = Math.sqrt(list.reduce((a, t) => a + t.c.re * t.c.re + t.c.im * t.c.im, 0));
    if (sm > 1e-9) list.forEach((t) => { t.c.re /= sm; t.c.im /= sm; });
    return list;
  }

  function validate(name, p) {
    const S = () => (window.OrbitApp ? window.OrbitApp.getState() : {});
    switch (name) {
      case 'setQuantumNumbers': {
        const s = S();
        const out = {};
        if (p.n != null) { const v = clampInt(p.n, 1, 6); if (v == null) return { err: 'n 非法' }; out.n = v; }
        const n = out.n != null ? out.n : s.n;
        if (p.l != null) { const v = clampInt(p.l, 0, n - 1); if (v == null) return { err: 'l 非法' }; out.l = v; }
        const l = out.l != null ? out.l : Math.min(s.l, n - 1);
        if (p.m != null) { const v = clampInt(p.m, -l, l); if (v == null) return { err: 'm 非法' }; out.m = v; }
        return { params: out };
      }
      case 'sweepQuantumNumber': {
        const axis = p.axis;
        if (['n', 'l', 'm'].indexOf(axis) < 0) return { err: "axis 必须是 'n'|'l'|'m'" };
        const s = S();
        const lim = axis === 'n' ? [1, 6] : axis === 'l' ? [0, Math.min((p.n || s.n) - 1, 5)] : [-(p.l || s.l), (p.l || s.l)];
        const from = clampInt(p.from, lim[0], lim[1]);
        const to = clampInt(p.to, lim[0], lim[1]);
        if (from == null || to == null) return { err: 'from/to 非法' };
        return { params: { axis, from, to, durationMs: clampNum(p.durationMs, 300, 6000) || DEFAULT_SWEEP_MS } };
      }
      case 'setWavefunctionMode':
        return ['real', 'complex'].indexOf(p.mode) >= 0 ? { params: { mode: p.mode } } : { err: 'mode 非法' };
      case 'setRenderMode':
        return ['points', 'surface'].indexOf(p.mode) >= 0 ? { params: { mode: p.mode } } : { err: 'mode 非法' };
      case 'setColorMode':
        return ['orbital', 'phase'].indexOf(p.mode) >= 0 ? { params: { mode: p.mode } } : { err: 'mode 非法' };
      case 'setPsiCriterion':
        return ['psi', 'psi2'].indexOf(p.criterion) >= 0 ? { params: { criterion: p.criterion } } : { err: 'criterion 非法' };
      case 'setIsosurfaceLevel': {
        const v = clampNum(p.fraction, 0.005, 0.8);
        return v == null ? { err: 'fraction 非法' } : { params: { fraction: v } };
      }
      case 'animateIsosurfaceLevel': {
        const f = clampNum(p.from, 0.005, 0.8), t = clampNum(p.to, 0.005, 0.8);
        if (f == null || t == null) return { err: 'from/to 非法' };
        return { params: { from: f, to: t, durationMs: clampNum(p.durationMs, 300, 6000) || DEFAULT_SWEEP_MS } };
      }
      case 'showRadial': {
        const ok = ['R', 'R2', 'D'];      // D² 已从界面移除（与 D 的节点结构完全重复）
        const which = (p.which || []).filter((k) => ok.indexOf(k) >= 0);
        return which.length ? { params: { which } } : { err: 'which 非法（应为 R/R2/D 的非空子集）' };
      }
      case 'highlightRadialFeature':
        if (['R', 'D'].indexOf(p.target) < 0) return { err: 'target 应为 R 或 D' };
        if (['peak', 'zeros'].indexOf(p.feature) < 0) return { err: 'feature 应为 peak 或 zeros' };
        return { params: { target: p.target, feature: p.feature } };
      case 'linkRadialTo3D': {
        const v = clampNum(p.radius, 0, 200);
        return v == null ? { err: 'radius 非法' } : { params: { radius: v } };
      }
      case 'setAngularView':
        return ['Y', 'Y2'].indexOf(p.which) >= 0 ? { params: { which: p.which } } : { err: 'which 非法' };
      case 'setSectionPlane':
        return ['xy', 'xz', 'yz'].indexOf(p.plane) >= 0 ? { params: { plane: p.plane } } : { err: 'plane 非法' };
      case 'setSectionMode':
        return ['intensity', 'phase', 'contour'].indexOf(p.mode) >= 0 ? { params: { mode: p.mode } } : { err: 'mode 非法' };
      case 'spotlightNodes':
        return ['radial', 'angular'].indexOf(p.type) >= 0 ? { params: { type: p.type, on: p.on !== false } } : { err: 'type 非法' };
      case 'setFormulaHighlight': {
        const part = p.part || null;
        if (part !== null && ['R', 'Y', 'L', 'P', 'N'].indexOf(part) < 0) {
          return { err: "part 应为 'R'|'Y'|'L'|'P'|'N' 或 null" };
        }
        return { params: { part: part } };
      }
      case 'loadPreset': {
        if (!p.key) return { err: '需要 key' };
        if (!window.StateEditor || !window.StateEditor.PRESETS[p.key]) {
          return { err: '未知预设：' + p.key };
        }
        return { params: { key: p.key } };
      }
      case 'setSuperposition': {
        if (!Array.isArray(p.terms)) return { err: 'terms 必须是数组' };
        const out = [];
        for (const t of (p.terms || [])) {
          if (!t || t.n == null || t.l == null || t.m == null) return { err: '每一项都需要 n / l / m' };
          const n = clampInt(t.n, 1, 6);
          if (n == null) return { err: 'n 非法' };
          const l = clampInt(t.l, 0, n - 1);
          if (l == null) return { err: 'l 非法' };
          const m = clampInt(t.m, -l, l);
          if (m == null) return { err: 'm 非法' };
          const c = t.c || { re: 1, im: 0 };
          const re = Number(c.re), im = Number(c.im || 0);
          if (!Number.isFinite(re) || !Number.isFinite(im)) return { err: '系数必须是数值' };
          out.push({ n: n, l: l, m: m, mode: t.mode === 'complex' ? 'complex' : 'real', c: { re: re, im: im } });
        }
        // 自动归一化 Σ|c|² = 1（否则密度量级失控）
        return { params: { terms: normalizeTerms(out) } };
      }
      case 'setCoefficient': {
        const idx = clampInt(p.index, 0, 16);
        if (idx == null) return { err: 'index 非法' };
        const re = Number(p.re), im = Number(p.im || 0);
        if (!Number.isFinite(re) || !Number.isFinite(im)) return { err: 're / im 必须是数值' };
        return { params: { index: idx, re: re, im: im } };
      }
      case 'setRelPhase': {
        const v = Number(p.phase);
        if (!Number.isFinite(v)) return { err: 'phase 必须是数值' };
        return { params: { phase: Math.max(0, Math.min(2 * Math.PI, v)) } };
      }
      case 'clearSuperposition':
        return { params: {} };
      case 'savePreset': {
        if (!p.label || !String(p.label).trim()) return { err: '需要 label（按钮上显示的名字）' };
        const out = [];
        for (const t of (p.terms || [])) {
          if (!t || t.n == null || t.l == null || t.m == null) return { err: '每一项都需要 n / l / m' };
          const n = clampInt(t.n, 1, 6);
          if (n == null) return { err: 'n 非法' };
          const l = clampInt(t.l, 0, n - 1);
          if (l == null) return { err: 'l 非法' };
          const m = clampInt(t.m, -l, l);
          if (m == null) return { err: 'm 非法' };
          const c = t.c || { re: 1, im: 0 };
          const re = Number(c.re), im = Number(c.im || 0);
          if (!Number.isFinite(re) || !Number.isFinite(im)) return { err: '系数必须是数值' };
          out.push({ n: n, l: l, m: m, mode: t.mode === 'complex' ? 'complex' : 'real', c: { re: re, im: im } });
        }
        return { params: {
          label: String(p.label).trim().slice(0, 16),
          note: p.note ? String(p.note) : '',
          key: p.key ? String(p.key) : '',
          terms: normalizeTerms(out),        // 空数组 ⇒ 由 StateEditor 取当前叠加态
        } };
      }
      case 'deletePreset': {
        if (!p.key) return { err: '需要 key' };
        if (!window.StateEditor || !window.StateEditor.PRESETS[p.key]) {
          return { err: '未知预设：' + p.key };
        }
        if (!window.StateEditor.isCustom(p.key)) {
          return { err: '内置预设不可删除：' + p.key };
        }
        return { params: { key: String(p.key) } };
      }
      case 'setAutoRotate':
        return { params: { on: !!p.on } };
      case 'resetCamera':
        return { params: {} };
      case 'showReferenceTable':
        if (['R', 'Y'].indexOf(p.which) < 0) return { err: 'which 应为 R 或 Y' };
        return { params: { which: p.which, open: p.open !== false } };
      default:
        return { err: '未知动作：' + name };
    }
  }

  // ---------------------------------------------------------------------------
  // 执行
  // ---------------------------------------------------------------------------
  /** 执行一个"瞬时"动作 */
  function applyInstant(name, p) {
    const A = window.OrbitApp;
    if (!A) return { ok: false, error: '应用未就绪' };
    switch (name) {
      case 'setQuantumNumbers': return A.applyAction({ action: 'setQuantumNumbers', params: p });
      case 'setWavefunctionMode': return A.applyAction({ action: 'setWavefunctionMode', params: p });
      case 'setRenderMode': return A.applyAction({ action: 'setRenderMode', params: p });
      case 'setColorMode': return A.applyAction({ action: 'setColorMode', params: p });
      case 'setPsiCriterion': return A.applyAction({ action: 'setPsiCriterion', params: p });
      case 'setIsosurfaceLevel': return A.applyAction({ action: 'setIsosurfaceLevel', params: p });
      case 'showRadial': return A.applyAction({ action: 'showRadial', params: p });
      case 'setAngularView': return A.applyAction({ action: 'setAngularView', params: p });
      case 'setSectionPlane': return A.applyAction({ action: 'setSectionPlane', params: p });
      case 'setSectionMode': return A.applyAction({ action: 'setSectionMode', params: p });
      case 'setAutoRotate': return A.applyAction({ action: 'setAutoRotate', params: p });
      case 'resetCamera': return A.applyAction({ action: 'resetCamera', params: p });
      case 'setFormulaHighlight': return A.applyAction({ action: 'setFormulaHighlight', params: p });

      case 'highlightRadialFeature':
        // 走 setRadialMarks 动作：它同时更新图表与面板上的标注控件，
        // 用户之后可以自己把标注关掉（否则智能体画了就再也没人能收）
        return A.applyAction({ action: 'setRadialMarks', params: { target: p.target, feature: p.feature } });

      case 'linkRadialTo3D':
        if (!hooks.ringHighlight) return { ok: false, error: '三维参考球能力未注册' };
        hooks.ringHighlight(p.radius);
        return { ok: true };

      case 'spotlightNodes':
        if (!hooks.spotlightNodes) return { ok: false, error: '节点高亮能力未注册' };
        hooks.spotlightNodes(p.type, p.on);
        return { ok: true };

      case 'highlightFormulaTerm':
        if (!hooks.setFormulaHighlight) return { ok: false, error: '公式高亮能力未注册' };
        hooks.setFormulaHighlight(p.part);
        return { ok: true };

      case 'showReferenceTable':
        window.dispatchEvent(new CustomEvent('orbit:reftable', { detail: p }));
        return { ok: true };

      // ---- 叠加态（辅助功能）----
      case 'loadPreset': {
        if (!window.StateEditor) return { ok: false, error: '量子态编辑器未就绪' };
        const r = window.StateEditor.applyPreset(p.key);
        return (r && r.ok) ? { ok: true } : { ok: false, error: (r && r.error) || '预设载入失败' };
      }
      case 'setSuperposition': {
        const r = A.applyAction({ action: 'setSuperposition', params: { terms: p.terms } });
        if (!r.ok) return r;
        // 同步编辑器的选中状态（自定义组合不再对应任何预设）
        if (window.StateEditor && p.terms.length) window.StateEditor.expand();
        return { ok: true, terms: p.terms.length };
      }
      case 'setCoefficient': {
        const st = A.getState();
        const list = (st.terms || []).map(function (t) {
          return { n: t.n, l: t.l, m: t.m, mode: t.mode || 'real', c: { re: t.c.re, im: t.c.im } };
        });
        if (!list.length) return { ok: false, error: '当前是单一本征态，没有可改的系数（请先设 setSuperposition 或 loadPreset）' };
        if (p.index >= list.length) return { ok: false, error: '索引 ' + p.index + ' 超出范围（当前 ' + list.length + ' 项）' };
        list[p.index].c = { re: p.re, im: p.im || 0 };
        // ★ 必须归一化：改一项系数会改变整体模长，不归一化就不是一个合法的量子态
        normalizeTerms(list);
        const r2 = A.applyAction({ action: 'setSuperposition', params: { terms: list } });
        if (!r2.ok) return r2;
        const shown = list.map(function (t) { return t.c.re.toFixed(3); });
        return {
          ok: true,
          index: p.index,
          requested: p.re,
          // ★ 你请求的值 ≠ 落库的值：归一化会按比例缩放**全部**系数，所以第 index 项
          //   拿到的不是 p.re。旁白里必须引用下面这个 actual，否则讲解和界面上的数字对不上。
          actual: list[p.index].c.re,
          actualIm: list[p.index].c.im,
          allCoefficients: shown,
          summary: '归一化后全部系数：' + shown.join(' / '),
          note: '你请求的 ' + p.re + ' 经归一化后实际为 ' + list[p.index].c.re.toFixed(3)
            + '。系数只有**比值**有物理意义（Σ|c|²=1 是硬约束），所以"把某项设成某个绝对数值"通常无法精确实现。'
            + '讲解时请引用 summary 里的实际值，不要引用你请求的值。',
        };
      }
      case 'setRelPhase':
        return A.applyAction({ action: 'setRelPhase', params: p });
      case 'clearSuperposition':
        return A.applyAction({ action: 'clearSuperposition', params: p });

      // ---- 自定义预设的增删（内置预设不可删）----
      case 'savePreset': {
        if (!window.StateEditor || !window.StateEditor.addPreset) {
          return { ok: false, error: '量子态编辑器未就绪，无法保存预设' };
        }
        const r = window.StateEditor.addPreset(p.label, p.terms, p.note, p.key);
        if (!r || !r.ok) return { ok: false, error: (r && r.error) || '保存失败' };
        if (window.Panel) window.Panel.addChip('已存为预设：' + r.label);
        return { ok: true, key: r.key, label: r.label, terms: r.terms };
      }
      case 'deletePreset': {
        if (!window.StateEditor || !window.StateEditor.removePreset) {
          return { ok: false, error: '量子态编辑器未就绪' };
        }
        const r = window.StateEditor.removePreset(p.key);
        if (!r || !r.ok) return { ok: false, error: (r && r.error) || '删除失败' };
        return { ok: true, removed: r.removed };
      }

      default:
        return { ok: false, error: '动作未实现：' + name };
    }
  }

  /** 执行一个"动画"动作（返回 Promise）。dead 用于判断本轮是否已被中止/抢占。 */
  function applyAnimated(name, p, dead) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const dur = p.durationMs || DEFAULT_SWEEP_MS;
      const over = () => (dead ? dead() : false);
      // ★ 统一出口：动画无论正常播完还是被 stop() 打断，都必须 resolve 一次，
      //   并把 pendingAnim 清掉。漏掉这一步就会留下永不落地的 Promise。
      const finish = (v) => { pendingAnim = null; rafId = null; resolve(v); };
      pendingAnim = finish;

      if (name === 'sweepQuantumNumber') {
        const { axis, from, to } = p;
        const step = (now) => {
          if (over()) return finish({ ok: true, aborted: true });
          const k = Math.min(1, (now - t0) / dur);
          // 缓动，使首尾更自然
          const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
          const v = Math.round(from + (to - from) * e);
          const params = {}; params[axis] = v;
          window.OrbitApp.applyAction({ action: 'setQuantumNumbers', params });
          if (k < 1) { rafId = requestAnimationFrame(step); }
          else { finish({ ok: true }); }
        };
        rafId = requestAnimationFrame(step);
        return;
      }

      if (name === 'animateIsosurfaceLevel') {
        const { from, to } = p;
        const step = (now) => {
          if (over()) return finish({ ok: true, aborted: true });
          const k = Math.min(1, (now - t0) / dur);
          const v = from + (to - from) * k;
          window.OrbitApp.applyAction({ action: 'setIsosurfaceLevel', params: { fraction: v } });
          if (k < 1) { rafId = requestAnimationFrame(step); }
          else { finish({ ok: true }); }
        };
        rafId = requestAnimationFrame(step);
        return;
      }

      finish({ ok: false, error: '未知动画动作：' + name });
    });
  }

  /**
   * 提交一组动作。
   *
   * 两种模式，返回值语义不同，调用方必须分清：
   *
   *  · **手动模式（默认）**——给智能体用。动作先入队，只执行第一步，之后**停下等
   *    用户点「下一步」**。因为用户的确认可能要等很久，本函数**立即返回**，
   *    绝不阻塞对话循环。返回值是"已入队"的受理回执，不是执行结果。
   *
   *  · **自动连播（opts.auto）**——给课堂演示脚本用。演示者已经在脚本层面点过
   *    「下一步」了，脚本内部的子动作应当连贯播完，故按每步 1.2 秒的节奏自动走完，
   *    并 await 到播完再返回（DemoMode 依赖这个语义）。
   *
   * @param {Array} actions  动作列表，元素可带 speech（旁白）与 holdMs（该步停留时长）
   * @param {Object} opts    { auto:boolean, noPacing:boolean }
   * @returns {Promise<Object>}
   */
  async function applySequence(actions, opts) {
    opts = opts || {};
    const raw = (actions || []).slice(0, MAX_ACTIONS_PER_TURN);
    const dropped = Math.max(0, (actions || []).length - MAX_ACTIONS_PER_TURN);

    // ---- 先全部校验：参数错的步骤当场退回，不入队、不占用户的一次点击 ----
    const okSteps = [];
    const failed = [];
    for (const a of raw) {
      const name = a && a.action;
      const v = validate(name, a.params || {});
      if (v.err) { failed.push({ action: name, error: v.err }); continue; }
      okSteps.push({
        name: name, params: v.params,
        speech: a && a.speech,
        holdMs: clampNum(a && a.holdMs, MIN_DWELL_MS, MAX_DWELL_MS),
        animated: !!(VOCAB[name] && VOCAB[name].animated),
      });
    }
    if (!okSteps.length) return { executed: [], failed: failed, accepted: 0, dropped: dropped };

    // ---- 自动连播：走完再返回（DemoMode 等脚本用）----
    if (opts.auto) {
      stop();
      const gen = generation;
      manual = false;
      queue = okSteps;
      qIndex = 0;
      qTotal = okSteps.length;
      playing = true;
      const r = await runQueue(gen, !opts.noPacing);
      return Object.assign(r, { failed: failed.concat(r.failed || []), dropped: dropped });
    }

    // ---- 手动模式（默认）：入队 + 立即返回 ----
    // 正在播就追加（智能体分几次下发也能接成一条完整的分镜），否则重开一轮
    if (!playing) {
      stop();
      queue = [];
      qIndex = 0;
      // 默认播放方式由设置决定（见设置 → 教学偏好）；演示条上还能临时改成连播
      const cfg = (window.Settings && window.Settings.get) ? window.Settings.get() : {};
      manual = (cfg.playback !== 'auto');
    }
    const room = MAX_QUEUE - qIndex;
    const taken = okSteps.slice(0, Math.max(0, room));
    const overflow = okSteps.length - taken.length;
    queue = queue.concat(taken);
    qTotal = queue.length;

    if (!playing) {
      playing = true;
      const gen = generation;
      runQueue(gen, false);            // 后台播放，不 await
    } else {
      emitProgress({ phase: 'queued', index: qIndex, total: qTotal, added: taken.length });
    }
    return {
      executed: [],
      failed: failed,
      accepted: taken.length,
      queued: taken.length,
      overflow: overflow || undefined,
      dropped: dropped || undefined,
      manual: manual,
      total: qTotal,
      note: '已入队 ' + taken.length + ' 步（共 ' + qTotal + ' 步）。'
        + (manual ? '正在等用户点「下一步」逐步确认——请不要重复下发同样的动作，' +
            '并在回复里告诉学生可以用「下一步 / 连续播放 / 停止」控制节奏。'
          : '正在连续播放。'),
    };
  }

  /**
   * 后台播放循环。gen 是本轮的运行代号：stop() 或新一次 stop() 会让它作废。
   * @returns {Promise<{executed:Array, failed:Array, aborted:boolean}>}
   */
  async function runQueue(gen, paced, parkImmediately) {
    const executed = [];
    const failed = [];
    const dead = () => gen !== generation;
    // ★ 这里**刻意不设"总时长上限"**。曾经有过一条 25 秒的单轮上限（超时即丢弃剩余
    //   队列），但它在自动连播下必然误伤：24 步 × 1.2 秒本来就 > 25 秒，一段正常的
    //   长演示会被从中间砍掉，学生看到"演示中断"却不知道是时间到了。
    //   现在只保留**动作数**上限（MAX_ACTIONS_PER_TURN / MAX_QUEUE），能用步数表达
    //   的约束就不用挂钟表达——步数是确定的，时长取决于设备与动画时长，不可预期。
    //   要提前结束，用户点「停止」即可。
    // ★ 闸门放在**执行之前**（而不是执行完之后）。两种写法在"逐步前进"时完全等价，
    //   但"先闸门"让循环可以从任意一步恢复：用户从已结束的状态点「上一步」时，
    //   重新起一个循环并 parkImmediately=true，就会先停在闸门上而不会立刻执行。
    let skipGate = !parkImmediately;

    while (qIndex < queue.length) {
      if (dead()) return { executed, failed, aborted: true };

      // ★ `&& manual` 这个判断不能少：自动连播时**绝不能**进闸门，
      //   否则第二步就会停在那里永远等一个没人会点的「下一步」——整个演示挂死。
      if (!skipGate && manual) {
        // ★ 闸门：停在这里，等用户点「下一步」。用户不点就一直等——
        //   这是本模块唯一一处"无限期等待"，所以 stop()/next()/autoPlay()
        //   都必须能唤醒它，否则界面会卡在一个再也走不动的进度条上。
        atGate = true;
        emitProgress({
          phase: 'waiting', index: qIndex, total: queue.length, canPrev: qIndex > 0,
          next: {
            action: queue[qIndex].name,
            label: describe(queue[qIndex].name, queue[qIndex].params),
            speech: queue[qIndex].speech,
          },
        });
        await waitGate();
        atGate = false;
        if (dead()) return { executed, failed, aborted: true };
      }
      skipGate = false;

      const st = queue[qIndex];
      emitProgress({ phase: 'step', index: qIndex + 1, total: queue.length, action: st.name,
        label: describe(st.name, st.params), speech: st.speech,
        concept: VOCAB[st.name] && VOCAB[st.name].concept, ok: true, manual: manual });

      // ★ 执行前先存快照：这是「上一步」能把画面退回原样的唯一依据
      snapshots[qIndex] = captureSnapshot();

      if (st.animated) {
        const r = await applyAnimated(st.name, st.params, dead);
        if (dead()) return { executed, failed, aborted: true };
        (r.ok ? executed : failed).push(r.ok ? { action: st.name } : { action: st.name, error: r.error });
      } else {
        const r = applyInstant(st.name, st.params);
        (r.ok ? executed : failed).push(r.ok ? { action: st.name } : { action: st.name, error: r.error });
      }

      qIndex++;
      if (dead()) return { executed, failed, aborted: true };

      if (!manual && paced && qIndex < queue.length) {
        // 自动连播：动画自带时长，播完只需落点停顿；瞬时动作按"看一眼"的时长停留
        const hold = st.holdMs || (st.animated ? AFTER_ANIMATED_MS : DEFAULT_DWELL_MS);
        await wait(hold);
        if (dead()) return { executed, failed, aborted: true };
      }
    }

    // ★ 播完**保留队列与快照**：不清掉才能让用户「重新演示」或退回去重看。
    //   真正的清理交给 stop()（用户点「停止」或开始新演示时）。
    playing = false;
    atGate = false;
    qIndex = queue.length;
    emitProgress({ phase: 'done', total: qTotal, canReplay: queue.length > 0, canPrev: qIndex > 0 });
    return { executed, failed, aborted: false };
  }

  /**
   * 「重新演示」：从第一步重播当前这条分镜。
   * 先把画面还原到演示开始前的样子，再从头走一遍。
   */
  function replay() {
    if (!queue.length) return { ok: false, error: '没有可重播的演示' };
    const q = queue.slice();
    const snaps = snapshots.slice();
    const man = manual;
    stop();                              // 会清空队列并推进 generation
    queue = q;
    snapshots = snaps;
    qIndex = 0;
    qTotal = q.length;
    manual = man;
    playing = true;
    atGate = false;
    restoreSnapshot(snaps[0]);           // 回到"第一步之前"
    emitProgress({ phase: 'replay', total: q.length, manual: manual });
    runQueue(generation, false);         // 后台播放，不 await
    return { ok: true, total: q.length };
  }

  /** 给播放进度用的中文动作名（与 panel 的气泡文案保持一致的语感） */
  const LABEL = {
    setQuantumNumbers: '切换轨道', sweepQuantumNumber: '连续扫描量子数',
    setWavefunctionMode: '切换实/复函数', setRenderMode: '切换渲染方式',
    setColorMode: '切换着色', setPsiCriterion: '切换 |ψ| / |ψ|² 判据',
    setIsosurfaceLevel: '调整等值面阈值', animateIsosurfaceLevel: '扫描等值面阈值',
    showRadial: '切换径向曲线', highlightRadialFeature: '标注峰值/零点',
    linkRadialTo3D: '画出参考球', setAngularView: '切换角度分布',
    setSectionPlane: '切换截面', setSectionMode: '切换截面模式',
    spotlightNodes: '高亮节面', setAutoRotate: '自动旋转', resetCamera: '复位视角',
    setFormulaHighlight: '高亮公式项', showReferenceTable: '打开教材对照表',
    loadPreset: '载入预设态', setSuperposition: '构造叠加态',
    setCoefficient: '改系数', setRelPhase: '调相对相位', clearSuperposition: '回到纯态',
    savePreset: '存为预设', deletePreset: '删除预设',
  };
  function describe(name, p) {
    const label = LABEL[name] || name;
    if (name === 'setQuantumNumbers' && p) {
      return label + ' → n=' + (p.n != null ? p.n : '·') + ' l=' + (p.l != null ? p.l : '·') + ' m=' + (p.m != null ? p.m : '·');
    }
    if (name === 'setCoefficient' && p) return label + '：第 ' + (p.index + 1) + ' 项 → ' + p.re;
    if (name === 'loadPreset' && p) return label + '：' + p.key;
    return label;
  }

  /** 供模型了解可用动作（渐进式披露：按需拉取，不常驻提示词） */
  function listActions() {
    const SE = window.StateEditor;
    const presetKeys = (SE && SE.PRESETS) ? Object.keys(SE.PRESETS) : [];
    const customKeys = presetKeys.filter((k) => SE.isCustom && SE.isCustom(k));
    return Object.keys(VOCAB).map((name) => {
      const v = VOCAB[name];
      const item = {
        action: name, group: v.group, concept: v.concept,
        desc: v.desc, params: v.params, animated: !!v.animated,
      };
      // loadPreset 需要告诉模型有哪些键可用，否则它只能瞎猜；
      // 顺便标出哪些是自定义的（只有这些能被 deletePreset 删掉）
      if (name === 'loadPreset' && presetKeys.length) {
        item.availableKeys = presetKeys;
        item.customKeys = customKeys;
      }
      return item;
    });
  }

  return {
    applySequence, applyInstant, stop, listActions, registerHooks,
    onProgress, next, prev, autoPlay, replay, state,
    isRunning: () => playing,
    MAX_ACTIONS_PER_TURN,
    DEFAULT_DWELL_MS,
  };
})();
