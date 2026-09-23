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
    n: 'setN', l: 'setL', m: 'setM',
    wavefunction: 'setWavefunctionMode',
    render: 'setRenderMode',
    color: 'setColorMode',
    psiCriterion: 'setPsiCriterion',
    levelFraction: 'setIsosurfaceLevel',
    plane: 'setSectionPlane',
    sectionMode: 'setSectionMode',
    angularWhich: 'setAngularView',
    radial: 'setRadial',
    autoRotate: 'setAutoRotate',
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
        n: s.n, l: s.l, m: s.m,
        name: '' + s.n + sub,
        chemName: (s.wavefunction === 'real' && window.Formula && window.Formula.realOrbitalName)
          ? window.Formula.realOrbitalName(s.l, s.m) : '',
      },
      mode: {
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
      },
      camera: { autoRotate: s.autoRotate },
      interaction: getTrace(),
    };
    if (extra) Object.assign(snap, extra);
    return snap;
  }

  /** 紧凑文本形式（注入 prompt 时更省 token） */
  function toCompactText(snap) {
    const s = snap || snapshot();
    const it = s.interaction || {};
    const lines = [
      '【当前视图】' + s.orbital.name +
        (s.orbital.chemName ? '(' + s.orbital.chemName + ')' : '') +
        '  n=' + s.orbital.n + ' l=' + s.orbital.l + ' m=' + s.orbital.m,
      '【模式】' + s.mode.wavefunction + ' / ' + s.mode.render + ' / 着色:' + s.mode.color,
      '【等值面】判据 ' + s.isosurface.criterion + '，阈值 ' + (s.isosurface.levelFraction * 100).toFixed(1) + '%',
      '【图表】径向 [' + (s.charts.radial || []).join(',') + ']；角度 ' + s.charts.angular +
        '；截面 ' + s.charts.section.plane + '/' + s.charts.section.mode,
      '【交互】空闲 ' + Math.round((it.idleMs || 0) / 1000) + 's' +
        '；切换次数 ' + JSON.stringify(it.toggleCounts || {}) +
        '；最近动作 ' + (it.recentActions || []).join('→'),
    ];
    return lines.join('\n');
  }

  return { start, stop, snapshot, getTrace, toCompactText, poll };
})();
