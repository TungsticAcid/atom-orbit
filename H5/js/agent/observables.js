/**
 * observables.js — 力学量计算（全部解析式，确定性，模型不得口算）
 *
 * 对**单一本征态** ψ_nlm，以下量都有闭式解，可直接给出精确值：
 *   ⟨r⟩   = (a₀/2)[3n² − l(l+1)]
 *   ⟨1/r⟩ = 1/(n²a₀)                     （与 l 无关）
 *   ⟨r²⟩  = (a₀²n²/2)[5n² + 1 − 3l(l+1)]
 *   ⟨E⟩   = −13.6/n² eV　⟨T⟩ = +13.6/n²　⟨V⟩ = −27.2/n²
 *   ⟨L²⟩  = ħ²l(l+1)　⟨L_z⟩ = ħm
 *   角动量与 z 轴夹角 θ：cosθ = m / √(l(l+1))
 *
 * 对**叠加态** ψ = Σcᵢψᵢ：
 *   ⟨Â⟩ = Σ|cᵢ|²aᵢ ；P(Â=a) = Σ_{aᵢ=a}|cᵢ|²（测量假设）
 *   仅当各本征值相同时该量才有确定值。
 *
 * ★ 这些正是结构化学教材（《物质结构基本原理》第二章）的核心题型：
 *   平均距离、势能平均值、角动量分量是否确定、与 z 轴夹角、本征函数判断。
 *   全部由本模块确定性给出，从结构上杜绝幻觉。
 */
window.Observables = (function () {
  'use strict';

  const a0 = 1;                    // 长度单位统一为 a₀
  const HBAR = 1;                  // 角动量单位统一为 ħ

  // ---------------------------------------------------------------------------
  // 单一本征态
  // ---------------------------------------------------------------------------

  /** ⟨r⟩ = (a₀/2)[3n² − l(l+1)]（单位 a₀） */
  function meanR(n, l) { return (a0 / 2) * (3 * n * n - l * (l + 1)); }

  /** ⟨1/r⟩ = 1/(n²a₀)（单位 1/a₀，与 l 无关） */
  function meanInvR(n) { return 1 / (n * n * a0); }

  /** ⟨r²⟩ = (a₀²n²/2)[5n² + 1 − 3l(l+1)]（单位 a₀²） */
  function meanR2(n, l) { return (a0 * a0 * n * n / 2) * (5 * n * n + 1 - 3 * l * (l + 1)); }

  /** 径向不确定度 Δr = √(⟨r²⟩ − ⟨r⟩²) */
  function deltaR(n, l) {
    const m2 = meanR2(n, l), m1 = meanR(n, l);
    return Math.sqrt(Math.max(0, m2 - m1 * m1));
  }

  /** 能量分解（eV）：E = T + V，且由维里定理 2⟨T⟩ = −⟨V⟩ */
  function energyBreakdown(n) {
    const E = -13.6 / (n * n);
    return { E: E, T: -E, V: 2 * E, note: '维里定理：⟨T⟩ = −⟨E⟩，⟨V⟩ = 2⟨E⟩' };
  }

  /** 角动量量子化：L = ħ√(l(l+1))，L_z = ħm */
  function angularMomentum(l, m) {
    return {
      L: HBAR * Math.sqrt(l * (l + 1)),
      L2: HBAR * HBAR * l * (l + 1),
      Lz: HBAR * m,
    };
  }

  /**
   * 角动量与 z 轴的夹角（弧度/度）。
   * cosθ = m / √(l(l+1))；l=0 时角动量为零，夹角无定义。
   */
  function angleToZ(l, m) {
    if (l === 0) return { defined: false, note: 'l=0 时角动量为零，夹角无定义' };
    const cos = m / Math.sqrt(l * (l + 1));
    const rad = Math.acos(Math.max(-1, Math.min(1, cos)));
    return { defined: true, cos: cos, rad: rad, deg: rad * 180 / Math.PI };
  }

  // ---------------------------------------------------------------------------
  // 叠加态
  // ---------------------------------------------------------------------------
  /** 归一化检查：Σ|c|² 应为 1 */
  function normCheck(terms) {
    const s = terms.reduce((a, t) => a + (t.c.re * t.c.re + t.c.im * t.c.im), 0);
    return { sum: s, normalized: Math.abs(s - 1) < 1e-6 };
  }

  /**
   * 叠加态的力学量。
   * @param {Array} terms [{n,l,m,c:{re,im}}]
   */
  function superposition(terms) {
    if (!terms || !terms.length) return { error: '叠加态至少需要一项' };
    const w = terms.map((t) => t.c.re * t.c.re + t.c.im * t.c.im);   // |c|²

    // 能量
    const E = terms.reduce((a, t, i) => a + w[i] * (-13.6 / (t.n * t.n)), 0);
    const energies = terms.map((t) => -13.6 / (t.n * t.n));
    const eSame = energies.every((e) => Math.abs(e - energies[0]) < 1e-9);

    // L²（只依赖 l）
    const L2 = terms.reduce((a, t, i) => a + w[i] * HBAR * HBAR * t.l * (t.l + 1), 0);
    const ls = terms.map((t) => t.l);
    const lSame = ls.every((v) => v === ls[0]);

    // ---- L_z：**必须按实/复分档**，这是原先算错的地方 ----
    // ★ m 是**复**解 ψ_{n,l,m} 的 L̂z 本征值；而**实数解**由 ±m 两个复解等权组合而来，
    //   **不是 L̂z 的本征函数** —— 对实解测 L_z，会以各 1/2 的概率得到 ±|m|ħ。
    //   所以实分量在"L_z 谱"上贡献的是 ±|m| 各一半，而不是 m 这一处。
    //   这恰好解释了 p_x 的 ⟨L_z⟩ = 0（它确实为 0）。
    //   连带后果：单个实分量 m≠0 的态，L_z **没有**确定值 —— 修前会被报成"有确定值"。
    const spectrum = {};
    const addSp = (mm, p) => { spectrum[mm] = (spectrum[mm] || 0) + p; };
    terms.forEach((t, i) => {
      const md = t.mode || 'real';
      if (md === 'complex' || t.m === 0) addSp(t.m, w[i]);        // m=0 时实解与复解同形
      else { addSp(Math.abs(t.m), w[i] / 2); addSp(-Math.abs(t.m), w[i] / 2); }
    });
    let Lz = 0, Lz2 = 0;
    Object.keys(spectrum).forEach((k) => {
      const mm = Number(k), p = spectrum[k];
      Lz += p * HBAR * mm;
      Lz2 += p * HBAR * HBAR * mm * mm;
    });
    const dLz = Math.sqrt(Math.max(0, Lz2 - Lz * Lz));
    const specKeys = Object.keys(spectrum).filter((k) => spectrum[k] > 1e-9);
    const mSame = (specKeys.length <= 1);                          // 谱落在单一 m 上才有确定值
    const hasRealNonZero = terms.some((t) => (t.mode || 'real') !== 'complex' && t.m !== 0);

    const stationary = eSame;   // 各分量能量简并 → 仍是定态

    return {
      weights: w.map((x) => +x.toFixed(6)),
      norm: normCheck(terms),
      energy: {
        mean: +E.toFixed(4),
        definite: eSame,
        values: Array.from(new Set(energies)).map((x) => +x.toFixed(4)),
        note: eSame ? '各分量能量简并 → 能量有确定值，且态仍是定态' : '各分量能量不同 → 能量无确定值（非定态）',
      },
      L2: {
        mean: +L2.toFixed(4),
        definite: lSame,
        note: lSame ? '各分量 l 相同 → L² 有确定值' : '各分量 l 不同 → L² 无确定值',
      },
      Lz: {
        mean: +Lz.toFixed(4),
        definite: mSame,
        spectrum: Object.keys(spectrum).sort((a, b) => a - b).map((k) => ({ m: +k, prob: +spectrum[k].toFixed(6) })),
        hasRealNonZero: hasRealNonZero,
        note: hasRealNonZero
          ? '含**实数解**分量（m≠0）：实解不是 L̂z 的本征函数，它在 L_z 谱上贡献 ±|m| 各 1/2，'
            + '所以这类态的 ⟨L_z⟩ 恒为 0、L_z 也没有确定值。'
          : (mSame ? '各分量 m 相同 → L_z 有确定值' : '各分量 m 不同 → L_z 无确定值，只能给谱分布与平均值'),
      },
      deltaLz: +dLz.toFixed(4),
      isStationary: stationary,
      note: '测量假设：测得本征值 a 的概率 = 对应系数模方之和；仅当所有分量本征值相同时该量才有确定值。'
        + '★ L_z 的本征函数是**复数解** —— 实数解（m≠0）由 ±m 两个复解组合而来，不是它的本征函数。',
    };
  }

  // ---------------------------------------------------------------------------
  // 综合报告（供 queryOrbital / 出题 / 讲解共用）
  // ---------------------------------------------------------------------------
  function report(n, l, m) {
    const e = energyBreakdown(n);
    const am = angularMomentum(l, m);
    return {
      n: n, l: l, m: m,
      meanR: +meanR(n, l).toFixed(4),
      meanInvR: +meanInvR(n).toFixed(4),
      meanR2: +meanR2(n, l).toFixed(4),
      deltaR: +deltaR(n, l).toFixed(4),
      energy: { E: +e.E.toFixed(4), T: +e.T.toFixed(4), V: +e.V.toFixed(4), unit: 'eV' },
      angular: { L: +am.L.toFixed(4), L2: +am.L2.toFixed(4), Lz: +am.Lz.toFixed(4), unit: 'ħ' },
      angleToZ: (function () { const a = angleToZ(l, m); return a.defined ? { cos: +a.cos.toFixed(4), deg: +a.deg.toFixed(2) } : a; })(),
      unit: { length: 'a₀' },
    };
  }

  return {
    meanR, meanInvR, meanR2, deltaR, energyBreakdown,
    angularMomentum, angleToZ, normCheck, superposition, report,
    HBAR, a0,
  };
})();
