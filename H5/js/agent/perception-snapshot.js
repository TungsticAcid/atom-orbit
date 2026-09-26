/**
 * perception-snapshot.js — 感知快照（智能体的「眼」）
 *
 * 职责：把当前应用状态 + **交互痕迹** 序列化成结构化对象，供 LLM 决策。
 *
 * 关键设计：
 *   1. 交互痕迹通过**轮询 getState() 差分**得到，因此**无需侵入任何现有事件处理**。
 *   2. 只记录「动作类型 + 时间戳 + 数值」，**绝不记录任何输入文本**（隐私合规）。
 *   3. 快照每次对话前**实时生成**，不缓存——用户可能在自己操作视图后立刻提问。
 *   4. 体积受控（约 400–600 token），不足以挤占上下文。
 */
window.Perception = (function () {
  'use strict';

  const POLL_MS = 500;          // 采样周期
  const MAX_RECENT = 12;        // 最近动作保留条数
  const DWELL_KEEP = 6;         // 每个控件保留最近几次停留时长

  // 状态字段 → 简短的"动作名"（用于痕迹可读性）
  const FIELD_LABEL = {
    nuclearCharge: 'setNuclearCharge',
    n: 'setN', l: 'setL', m: 'setM',
    wavefunction: 'setWavefunctionMode',
    render: 'setRenderMode',
    color: 'setColorMode',
    psiCriterion: 'setPsiCriterion',
    levelFraction: 'setIsosurfaceLevel',
    plane: 'setSectionPlane',
    sectionMode: 'setSectionMode',
    viewTarget: 'setViewTarget',
    angularWhich: 'setAngularView',
    radial: 'setRadial',
    autoRotate: 'setAutoRotate',
    chartTerm: 'setChartTerm',
  };

  const trace = {
    recentActions: [],                                   // [{ a, from, to, at }]
    toggleCounts: {},                                    // { setM: 8, ... }
    dwellMs: {},                                         // { m: [9000, 7000, ...] } 每个值被"停留"多久
    lastChangeAt: Date.now(),
  };

  let prev = null;
  let timer = null;

  function eq(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
    }
    return a === b;
  }

  /** 差分出变化的字段 */
  function diffStates(a, b) {
    const out = [];
    for (const k of Object.keys(b)) {
      if (!eq(a[k], b[k])) out.push({ key: k, from: a[k], to: b[k] });
    }
    return out;
  }

  function poll() {
    if (!window.OrbitApp) return;
    const cur = window.OrbitApp.getState();
    const now = Date.now();

    if (prev) {
      const changes = diffStates(prev, cur);
      if (changes.length) {
        const held = now - trace.lastChangeAt;   // 上一个状态被保持了多久
        for (const ch of changes) {
          const label = FIELD_LABEL[ch.key] || ch.key;
          trace.toggleCounts[label] = (trace.toggleCounts[label] || 0) + 1;
          trace.recentActions.push({ a: label, from: ch.from, to: ch.to, at: now });
          // 记录"上一个值"的停留时长（对量子数最有意义）
          if (ch.key === 'n' || ch.key === 'l' || ch.key === 'm') {
            const arr = trace.dwellMs[ch.key] || (trace.dwellMs[ch.key] = []);
            arr.push(held);
            if (arr.length > DWELL_KEEP) arr.shift();
          }
        }
        if (trace.recentActions.length > MAX_RECENT) {
          trace.recentActions.splice(0, trace.recentActions.length - MAX_RECENT);
        }
        trace.lastChangeAt = now;
      }
    } else {
      trace.lastChangeAt = now;
    }
    prev = cur;
  }

  function start() {
    if (timer) return;
    poll();
    timer = setInterval(poll, POLL_MS);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  /** 交互痕迹（供主动服务规则与快照共用） */
  function getTrace() {
    return {
      idleMs: Date.now() - trace.lastChangeAt,
      toggleCounts: Object.assign({}, trace.toggleCounts),
      dwellMs: JSON.parse(JSON.stringify(trace.dwellMs)),
      recentActions: trace.recentActions.map((r) => r.a),
    };
  }

  /**
   * 生成完整快照。
   * @param {Object} [extra] 可附加学情等外部信息（如 mastery）
   */
  function snapshot(extra) {
    const s = (window.OrbitApp && window.OrbitApp.getState()) || {};
    const SUBSHELL = ['s', 'p', 'd', 'f', 'g', 'h'];
    const sub = SUBSHELL[Math.min(s.l || 0, SUBSHELL.length - 1)];

    const snap = {
      orbital: {
        // 核电荷数（类氢）：Z=1 氢 / 2 氦离子 / 3 锂离子。放进 orbital 而非单独一层 ——
        // 它和 n/l/m 一起决定"这是哪个原子轨道"，模型读一行就够。
        nuclearCharge: s.nuclearCharge,
        n: s.n, l: s.l, m: s.m,
        name: '' + s.n + sub,
        // ★ 实数解的**名字**（p_x / d_{xy} / f_{z³}…）。l≥4 没有公认惯用名，此时
        //   realOrbitalLabel 会给出角向部分的直角坐标多项式 —— 总之不退回 m：
        //   m 是复球谐的本征值指标，实解不是 L̂z 的本征函数（这是量子力学的基本事实），
        //   拿它给实解命名会把一个它不再拥有的量子数写进模型看到的状态里。
        //   m 字段本身仍保留（动作 setQuantumNumbers 要用，且它是渲染的真值来源）。
        chemName: (s.wavefunction === 'real' && window.Formula && window.Formula.realOrbitalLabel)
          ? window.Formula.realOrbitalLabel(s.l, s.m) : '',
      },
      mode: {
        // 三维里正在看哪一层：'spherical' 球谐曲面（角度部分）| 'wave' 完整波函数
        target: s.viewTarget,
        wavefunction: s.wavefunction,
        render: s.render,
        color: s.color,
      },
      isosurface: {
        criterion: s.psiCriterion,
        levelFraction: s.levelFraction,
      },
      charts: {
        radial: s.radial,
        angular: s.angularWhich,
        section: { plane: s.plane, mode: s.sectionMode },
        // ★ 有叠加态时，三张 2D 图各自在画哪一份（第 G 批）：'super' = 叠加态整体
        //   （只有截面图支持），数字 = 第 i 个分量。没有它，模型会以为 2D 图与三维
        //   画的是同一个东西，然后指着分量说"这就是叠加态"。
        term: (s.terms && s.terms.length) ? (s.chartTerm == null ? 'super' : s.chartTerm) : null,
      },
      camera: { autoRotate: s.autoRotate },
      interaction: getTrace(),
    };
    // ★ 叠加态：模型**必须**知道"现在是不是叠加态、有哪几个分量、各自是实解还是复解"，
    //   否则它会以为画面是某个单一本征态，然后讲错一整段。原先快照里没有这一层。
    //   标记按分量自己的解型给：实解用实轨道名、复解用 m（与公式区、编辑器一致）。
    if (s.terms && s.terms.length) {
      snap.superposition = {
        count: s.terms.length,
        relPhasePi: +((s.relPhase || 0) / Math.PI).toFixed(3),
        terms: s.terms.map(function (t) {
          const md = t.mode || 'real';
          const nm = (md === 'real' && window.Formula && window.Formula.realOrbitalLabelPlain)
            ? window.Formula.realOrbitalLabelPlain(t.l, t.m) : '';
          return {
            n: t.n, l: t.l, m: t.m, mode: md,
            label: (md === 'real' && nm) ? nm : ('m=' + t.m),
            c: { re: +t.c.re.toFixed(4), im: +(t.c.im || 0).toFixed(4) },
          };
        }),
      };
    }
    if (extra) Object.assign(snap, extra);
    return snap;
  }

  /** 紧凑文本形式（注入 prompt 时更省 token） */
  function toCompactText(snap) {
    const s = snap || snapshot();
    const it = s.interaction || {};
    const SUBSHELL = ['s', 'p', 'd', 'f', 'g', 'h'];
    const lines = [
      '【当前视图】' + s.orbital.name +
        (s.orbital.chemName ? '(' + s.orbital.chemName + ')' : '') +
        '  n=' + s.orbital.n + ' l=' + s.orbital.l + ' m=' + s.orbital.m +
        // Z 只有非 1 时才写出来 —— 默认的氢原子不必每轮占一个字段的位置
        (s.orbital.nuclearCharge && s.orbital.nuclearCharge !== 1
          ? ' Z=' + s.orbital.nuclearCharge + '（类氢，非氢原子）' : ''),
      '【模式】看' + (s.mode.target === 'spherical' ? '球谐函数 Y' : '完整波函数 ψ') +
        ' / ' + s.mode.wavefunction + ' / ' + s.mode.render + ' / 着色:' + s.mode.color,
      '【等值面】判据 ' + s.isosurface.criterion + '，阈值 ' + (s.isosurface.levelFraction * 100).toFixed(1) + '%',
      '【图表】径向 [' + (s.charts.radial || []).join(',') + ']；球谐判据 ' + s.charts.angular +
        '；截面 ' + s.charts.section.plane + '/' + s.charts.section.mode +
        // 有叠加态时才写：这三张 2D 图各自在画哪一份（第 G 批）
        (s.charts.term != null
          ? '；分量 径向/ΘΦ=' + (s.charts.term === 'super' ? '第1个分量（这两张图不支持叠加态）' : '#' + (Number(s.charts.term) + 1)) +
            '、截面=' + (s.charts.term === 'super' ? '叠加态整体' : '#' + (Number(s.charts.term) + 1))
          : ''),
      '【交互】空闲 ' + Math.round((it.idleMs || 0) / 1000) + 's' +
        '；切换次数 ' + JSON.stringify(it.toggleCounts || {}) +
        '；最近动作 ' + (it.recentActions || []).join('→'),
    ];
    // ★ 叠加态必须进快照（原先完全没有）—— 不写这一行，模型会把"叠加态"当成单一本征态。
    if (s.superposition) {
      lines.push('【叠加态】' + s.superposition.count + ' 个分量，相对相位 '
        + s.superposition.relPhasePi + 'π：'
        + s.superposition.terms.map(function (t) {
            // 实项写实轨道名（2p_x），复项写 n+支壳层+m（2p(m=+1)）—— 与界面、公式一致
            const lb = (t.mode === 'complex')
              ? ('' + t.n + SUBSHELL[Math.min(t.l, SUBSHELL.length - 1)] + '(m=' + (t.m > 0 ? '+' + t.m : t.m) + ')')
              : ('' + t.n + t.label);
            return lb + ' c=' + t.c.re + (t.c.im ? ((t.c.im > 0 ? '+' : '') + t.c.im + 'i') : '');
          }).join(' + '));
    }
    // ★ 演示状态原先**不在**每轮注入的快照里（只有模型主动调 getSnapshot 才看得到），
    //   于是它常常不带"演示走到哪一步"就开始说话。补上这一行。
    const dl = demoLine();
    if (dl) lines.push(dl);
    return lines.join('\n');
  }

  /**
   * 演示状态摘要 —— 让模型每轮都知道：现在播的是哪一条、走到第几步、下一步是什么，
   * **以及一共有哪些演示、各自的编号**。没有后者，模型接不住学生说的"刚才那个演示"。
   *
   * ★ 播完的演示同样列在清单里：它们现在**可以被重播与整改**（见 scene-bridge 的
   *   "演示记录"一节）——队列清空了不代表演示消失了。
   */
  function demoLine() {
    const S = window.SceneBridge;
    if (!S || !S.state) return null;
    const out = [];
    let st = null;
    try { st = S.state(); } catch (e) { st = null; }
    if (st && st.total) {
      const next = (st.steps || []).filter(function (s) { return !s.done; })[0];
      out.push('【演示】#' + st.demoId + '（' + (st.origin || '未知来源') + '）'
        + (st.playing ? '播放中' : '已播完')
        + ' · 第 ' + (st.index + 1) + '/' + st.total + ' 步'
        + (st.waitingForUser ? '（正在等学生点「下一步」）' : '')
        + (next ? '；下一步：' + next.action : '；已播完'));
    }
    if (S.listDemos) {
      let ds = [];
      try { ds = S.listDemos() || []; } catch (e) { ds = []; }
      if (ds.length) {
        out.push('【演示清单】' + ds.map(function (d) {
          return '#' + d.id + '(' + d.steps + '步' + (d.current ? '·当前' : '')
            + (d.label ? '·' + String(d.label).slice(0, 14) : '') + ')';
        }).join(' '));
      }
    }
    if (!out.length) return null;
    out.push('（学生若要求改动，用 reviseDemo 并指定 demo_id 与步号，别重发整条演示）');
    return out.join('\n');
  }

  return { start, stop, snapshot, getTrace, toCompactText, poll };
})();
