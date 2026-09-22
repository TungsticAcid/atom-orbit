/**
 * math.js — 原子轨道物理/数学引擎（纯 JS，无外部依赖）
 *
 * 统一约定：
 *   - 玻尔半径 a0 = 1（所有长度以 a0 为单位）。
 *   - 球坐标 (r, θ, φ)：θ 为与 z 轴的夹角（极角，0..π），φ 为方位角（0..2π）。
 *   - 所有波函数均为归一化形式：∫|ψ|² dV = 1。
 *
 * 说明：这里之所以不用 NumPy/Pyodide（~15MB，首屏慢、移动端不友好），是因为
 * 类氢原子波函数所需的数学（广义拉盖尔、关联勒让德、球谐函数）用少量递推公式
 * 即可在 JS 中精确实现，n≤6 时阶乘不越界、float64 精度足够。
 */
window.OM = (function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 复数运算
  // ---------------------------------------------------------------------------
  class Complex {
    constructor(re, im) {
      this.re = re;
      this.im = im;
    }
    add(o) { return new Complex(this.re + o.re, this.im + o.im); }
    sub(o) { return new Complex(this.re - o.re, this.im - o.im); }
    mul(o) {
      return new Complex(
        this.re * o.re - this.im * o.im,
        this.re * o.im + this.im * o.re
      );
    }
    timesReal(s) { return new Complex(this.re * s, this.im * s); }
    /** 模长 |z| = sqrt(re² + im²) */
    abs() { return Math.hypot(this.re, this.im); }
    /** 模平方 |z|² */
    abs2() { return this.re * this.re + this.im * this.im; }
    /** 辐角 arg(z) ∈ (-π, π] */
    arg() { return Math.atan2(this.im, this.re); }
    /** 共轭 */
    conj() { return new Complex(this.re, -this.im); }
  }
  /** e^{iφ} = cosφ + i sinφ */
  Complex.expI = function (phi) { return new Complex(Math.cos(phi), Math.sin(phi)); };

  // ---------------------------------------------------------------------------
  // 阶乘 / 双阶乘（小范围，精确整数）
  // ---------------------------------------------------------------------------
  const factCache = [1];
  function factorial(n) {
    if (n < 0) return 1;
    while (factCache.length <= n) {
      const k = factCache.length;
      factCache.push(factCache[k - 1] * k);
    }
    return factCache[n];
  }
  /** (2m-1)!! = 1·3·5···(2m-1)，要求 m ≥ 0 */
  function doubleFactorial(m) {
    let r = 1;
    for (let i = 1; i <= m; i++) r *= (2 * i - 1);
    return r;
  }

  // ---------------------------------------------------------------------------
  // 广义拉盖尔多项式 L_k^α(x)（递推，k = 次数 = n-l-1，α = 2l+1）
  // ---------------------------------------------------------------------------
  function laguerre(k, alpha, x) {
    if (k === 0) return 1;
    let Lk2 = 1;                          // L_{0}
    let Lk1 = 1 + alpha - x;              // L_{1}
    if (k === 1) return Lk1;
    for (let i = 2; i <= k; i++) {
      // (i)L_i = (2i-1+α-x)L_{i-1} - (i-1+α)L_{i-2}
      const L = ((2 * i - 1 + alpha - x) * Lk1 - (i - 1 + alpha) * Lk2) / i;
      Lk2 = Lk1;
      Lk1 = L;
    }
    return Lk1;
  }

  // ---------------------------------------------------------------------------
  // 关联勒让德函数 P_l^m(x)，0 ≤ m ≤ l，x = cosθ
  // 递推式已含 Condon–Shortley 相因子 (-1)^m（见 P_m^m 的定义）。
  // ---------------------------------------------------------------------------
  function assocLegendre(l, m, x) {
    m = Math.abs(m);
    if (m > l) return 0;
    const s = Math.sqrt(Math.max(0, (1 - x) * (1 + x)));   // sinθ, 数值更稳
    // P_m^m = (-1)^m (2m-1)!! (1-x²)^{m/2}
    let Pm = (m % 2 === 0 ? 1 : -1) * doubleFactorial(m) * Math.pow(s, m);
    if (l === m) return Pm;
    // P_{m+1}^m = (2m+1) x P_m^m
    let Pm1 = (2 * m + 1) * x * Pm;
    if (l === m + 1) return Pm1;
    let Pk2 = Pm, Pk1 = Pm1;
    for (let k = m + 2; k <= l; k++) {
      // (k-m)P_k^m = (2k-1) x P_{k-1}^m - (k-1+m)P_{k-2}^m
      const Pk = ((2 * k - 1) * x * Pk1 - (k - 1 + m) * Pk2) / (k - m);
      Pk2 = Pk1;
      Pk1 = Pk;
    }
    return Pk1;
  }

  // ---------------------------------------------------------------------------
  // 径向波函数 R_nl(r)（a0 = 1）
  // ---------------------------------------------------------------------------
  function radialR(n, l, r) {
    const a0 = 1;
    const rho = (2 * r) / (n * a0);                     // 无量纲量 2r/(n·a0)
    const norm = Math.sqrt(
      Math.pow(2 / (n * a0), 3) *
      factorial(n - l - 1) / (2 * n * factorial(n + l))
    );
    return norm * Math.pow(rho, l) * Math.exp(-r / (n * a0)) * laguerre(n - l - 1, 2 * l + 1, rho);
  }
  /** R_nl(r)² */
  function radialR2(n, l, r) { const R = radialR(n, l, r); return R * R; }
  /** 径向分布函数 D(r) = r² |R(r)|²（径向概率密度） */
  function radialDistribution(n, l, r) { return r * r * radialR2(n, l, r); }

  // ---------------------------------------------------------------------------
  // 角度部分：复球谐 Y_l^m 与 实球谐 Y_{l,m}
  // ---------------------------------------------------------------------------
  /** 球谐归一化系数 N_l^m（不含相因子） */
  function yNorm(l, m) {
    const am = Math.abs(m);
    return Math.sqrt(((2 * l + 1) / (4 * Math.PI)) * (factorial(l - am) / factorial(l + am)));
  }

  /**
   * 复球谐函数 Y_l^m(θ, φ)（复数）。
   * 约定：基于含 Condon–Shortley 相因子的 P_l^{|m|}；|Y|² 与 φ 无关（这是复轨道
   * "绕 z 轴对称环/锥面"的来源）。整体相因子为约定，不影响密度 |
   * .
   * 密度 |ψ|²。
   */
  function angularComplex(l, m, theta, phi) {
    const am = Math.abs(m);
    const P = assocLegendre(l, am, Math.cos(theta));
    const base = yNorm(l, m) * P;                       // 实数幅值
    const e = Complex.expI(m * phi);                    // e^{imφ}
    return (new Complex(base, 0)).mul(e);
  }

  /**
   * 实球谐函数 Y_{l,m}(θ, φ)（实数）。
   * m=0 → P_l^0 型（沿 z）；m>0 → cos(mφ) 型（如 p_x）；m<0 → sin(|m|φ) 型（如 p_y）。
   * 整体符号为约定，|Y|² 不受影响。
   */
  function angularReal(l, m, theta, phi) {
    const am = Math.abs(m);
    const P = assocLegendre(l, am, Math.cos(theta));
    const N = yNorm(l, m);
    if (am === 0) return N * P;
    if (m > 0) return Math.SQRT2 * N * P * Math.cos(am * phi);
    return Math.SQRT2 * N * P * Math.sin(am * phi);
  }

  // ---------------------------------------------------------------------------
  // 波函数与概率密度
  // ---------------------------------------------------------------------------
  /**
   * 复波函数 ψ_nlm(r,θ,φ)。mode: 'complex' | 'real'。
   * 返回 Complex（real 模式下虚部恒为 0）。
   */
  function psiComplex(n, l, m, r, theta, phi, mode) {
    const R = radialR(n, l, r);
    if (mode === 'real') {
      return new Complex(R * angularReal(l, m, theta, phi), 0);
    }
    return (new Complex(R, 0)).mul(angularComplex(l, m, theta, phi));
  }
  /** 概率密度 |ψ|²（实数，密度云/等值面/截面均基于此） */
  function psiDensity(n, l, m, r, theta, phi, mode) {
    const R = radialR(n, l, r);
    const ang = (mode === 'real')
      ? Math.abs(angularReal(l, m, theta, phi))
      : angularComplex(l, m, theta, phi).abs();
    return R * R * ang * ang;
  }

  // ---------------------------------------------------------------------------
  // 采样用元数据：径向范围、峰值、角度峰值（带缓存，键 = 量子数+模式）
  // ---------------------------------------------------------------------------
  const metaCache = new Map();

  /**
   * 计算径向采样的 rMax 与 D(r) 峰值。
   * 经典尺度 ~n²·a0，取扫描上限 2n²+8 足够覆盖尾端。
   */
  function samplingRadius(n, l) {
    const key = 'r' + n + '-' + l;
    if (metaCache.has(key)) return metaCache.get(key);
    const scanMax = 2 * n * n + 8;                 // 经典尺度 ~n²·a0，取富余上限
    const steps = 800;
    // 第一次扫描：求 D(r) 峰值（稳定基准）
    let stableMax = 0;
    for (let i = 0; i <= steps; i++) {
      const r = (scanMax * i) / steps;
      const d = radialDistribution(n, l, r);
      if (d > stableMax) stableMax = d;
    }
    // 第二次扫描：从峰值基准确定有效尾部范围
    let tail = 0;
    for (let i = 0; i <= steps; i++) {
      const r = (scanMax * i) / steps;
      const d = radialDistribution(n, l, r);
      if (d > 1e-4 * stableMax) tail = r;
    }
    const result = { rMax: tail + 0.6, maxD: stableMax };
    metaCache.set(key, result);
    return result;
  }

  /** 角度部分 |Y|² 的最大值（对 θ 与,实模式下 φ 求 max），用于拒绝采样 */
  function samplingAngleMax(l, m, mode) {
    const key = 'a' + l + '-' + m + '-' + mode;
    if (metaCache.has(key)) return metaCache.get(key);
    const pts = 720;
    let mx = 0;
    if (mode === 'complex') {
      for (let i = 0; i <= pts; i++) {
        const t = (Math.PI * i) / pts;
        const v = angularComplex(l, m, t, 0).abs2();
        if (v > mx) mx = v;
      }
    } else {
      for (let i = 0; i <= pts; i++) {
        const t = (Math.PI * i) / pts;
        for (let j = 0; j <= pts; j++) {
          const p = (2 * Math.PI * j) / pts;
          const w = angularReal(l, m, t, p);
          const v = w * w;
          if (v > mx) mx = v;
        }
      }
    }
    metaCache.set(key, mx);
    return mx;
  }

  // ---------------------------------------------------------------------------
  // 颜色工具（轨道基础色、相位着色）
  // ---------------------------------------------------------------------------
  /** 各角量子数 l 对应轨道类型（s/p/d/f/g/h） */
  const SUBSHELL = ['s', 'p', 'd', 'f', 'g', 'h'];
  /** 基础色（HSL，0..360 色相 / 0..1 饱和度与亮度） */
  const SUBSHELL_COLOR = [
    { h: 210, s: 0.75, l: 0.60 },   // s 蓝
    { h: 140, s: 0.70, l: 0.60 },   // p 绿
    { h: 28,  s: 0.85, l: 0.62 },   // d 橙
    { h: 285, s: 0.65, l: 0.62 },   // f 紫
    { h: 340, s: 0.65, l: 0.64 },   // g 玫红
    { h: 180, s: 0.60, l: 0.60 },   // h 青
  ];
  /** HSL→RGB，返回 [0..1] 三元组 */
  function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = h / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else { r = c; b = x; }
    const m = l - c / 2;
    return [r + m, g + m, b + m];
  }
  /** 轨道基础色（返回 THREE 风格 [r,g,b] 0..1） */
  function lColor(l) {
    const c = SUBSHELL_COLOR[Math.min(l, SUBSHELL_COLOR.length - 1)];
    return hslToRgb(c.h, c.s, c.l);
  }
  /** 相位着色：色相由相位决定，亮度由强度（0..1）决定 */
  function phaseColor(phase, intensity) {
    const hue = ((phase / (2 * Math.PI)) % 1 + 1) % 1 * 360;
    return hslToRgb(hue, 0.85, 0.15 + 0.65 * intensity);
  }

  // ---------------------------------------------------------------------------
  // 点云采样：按 |ψ|² 重要性采样（概率上即真实的电子分布）
  // ---------------------------------------------------------------------------
  /**
   * 采样 N 个三维点，返回 { positions, colors, extent }。
   * positions/colors 为 Float32Array（position 长度 3N，color 长度 3N）。
   * extent 为坐标内最大绝对半径（用于相机取景）。
   * colorMode：'phase' 相位着色（实函数 → ±红/青双色，复函数 → 彩虹相位）；
   *            'orbital' 轨道色（按 l 的支壳层基础色，亮度随密度）。
   */
  function samplePoints(n, l, m, mode, N, colorMode) {
    const usePhase = (colorMode !== 'orbital');
    const { rMax, maxD } = samplingRadius(n, l);
    const maxAng = samplingAngleMax(l, m, mode);
    const extent = rMax * 1.05;

    // 先采样位置、强度与相位（相位在采样时顺手算出，避免二次遍历重算）
    const pos = new Float32Array(N * 3);
    const tmpDensity = new Float32Array(N);
    const tmpPhase = usePhase ? new Float32Array(N) : null;
    let maxShiftDensity = 0;
    let count = 0, guard = 0;
    while (count < N && guard < N * 200) {
      guard++;
      // —— 径向：拒绝采样 r ~ D(r)
      const r = rMax * Math.random();
      const d = radialDistribution(n, l, r);
      if (d < maxD * Math.random()) continue;
      // —— 方向：均匀球面 (θ,φ)，按 |Y|² 拒绝接收（复模式与 φ 无关）
      const cosTheta = 2 * Math.random() - 1;
      const theta = Math.acos(cosTheta);
      const phi = 2 * Math.PI * Math.random();
      let Yre = 0, ang2 = 0;
      if (mode === 'real') {
        Yre = angularReal(l, m, theta, phi);
        ang2 = Yre * Yre;
      } else {
        ang2 = angularComplex(l, m, theta, phi).abs2();
      }
      if (ang2 < maxAng * Math.random()) continue;

      const x = r * Math.sin(theta) * Math.cos(phi);
      const y = r * Math.sin(theta) * Math.sin(phi);
      const z = r * Math.cos(theta);
      pos[3 * count] = x;
      pos[3 * count + 1] = y;
      pos[3 * count + 2] = z;
      // 粒子亮度 ∝ 概率密度 |ψ|² = R²|Y|²（用 d/r² * ang2 表示，避免再算一次）
      const density = r > 1e-9 ? (d / (r * r)) * ang2 : 0;
      tmpDensity[count] = density;
      if (density > maxShiftDensity) maxShiftDensity = density;
      if (usePhase) {
        // 相位：复函数取 arg ψ（R≥0，故等于 arg Y）；实函数取符号 → 0 或 π
        tmpPhase[count] = (mode === 'real')
          ? (Yre >= 0 ? 0 : Math.PI)
          : angularComplex(l, m, theta, phi).arg();
      }
      count++;
    }
    const nUsed = count;
    // —— 第二遍：生成颜色
    const colors = new Float32Array(nUsed * 3);
    const base = lColor(l);
    for (let i = 0; i < nUsed; i++) {
      const t = maxShiftDensity > 0 ? tmpDensity[i] / maxShiftDensity : 0;
      const k = Math.pow(t, 0.7);
      if (usePhase) {
        const col = phaseColor(tmpPhase[i], k);
        colors[3 * i] = col[0]; colors[3 * i + 1] = col[1]; colors[3 * i + 2] = col[2];
      } else {
        // 轨道色：基础色 + 亮度随密度增强（下限稍高，避免稀疏点过暗）
        colors[3 * i] = 0.50 + (base[0] - 0.50) * k;
        colors[3 * i + 1] = 0.50 + (base[1] - 0.50) * k;
        colors[3 * i + 2] = 0.52 + (base[2] - 0.52) * k;
      }
    }
    return {
      positions: pos.subarray ? pos.subarray(0, nUsed * 3).slice() : pos,
      colors: colors,
      extent: extent,
      count: nUsed,
    };
  }

  /**
   * 相位 → 颜色（供三维着色复用：点云 / 等值面共用同一套配色）。
   * 实函数传入 0 或 π，即得青/红双色。
   */
  function phaseColorFor(mode, realVal, cplx, intensity) {
    const phase = (mode === 'real') ? (realVal >= 0 ? 0 : Math.PI) : cplx.arg();
    return phaseColor(phase, intensity);
  }

  // ---------------------------------------------------------------------------
  // 快捷工具：轨道标签 / 取景范围 / 直角→球坐标
  // ---------------------------------------------------------------------------
  function orbitLabel(n, l, m, mode) {
    const sub = SUBSHELL[Math.min(l, SUBSHELL.length - 1)];
    return n + sub + (mode === 'complex' ? ' (复)' : ' (实)');
  }
  function rExtent(n, l) {
    return samplingRadius(n, l).rMax;
  }

  /**
   * |ψ|² 的全局峰值 = max_r R(r)² × max|Y|²。
   * 有了它，"阈值占峰值的比例"才能先于标量场被换算成绝对值，
   * 进而决定网格范围（否则峰值↔范围↔阈值会循环依赖）。
   */
  function maxDensity(n, l, m, mode) {
    const Ymax2 = samplingAngleMax(l, m, mode);
    const scanMax = 2 * n * n + 14;
    const steps = 900;
    let maxR2 = 0;
    for (let i = 0; i <= steps; i++) {
      const r = (scanMax * i) / steps;
      const R = radialR(n, l, r);
      if (R * R > maxR2) maxR2 = R * R;
    }
    return maxR2 * Ymax2;
  }

  /**
   * 给定阈值 level（|ψ|² 的绝对值，非比值）下，等值面的最外延半径。
   *
   * 原理：|ψ|² = R(r)²·|Y(θ,φ)|²，而 |Y| 在球面上的最大值为 Ymax，
   * 故半径 r 的球面上 |ψ|² 的最大值为 R(r)²·Ymax²。只需沿 r 扫描
   * R(r)²·Ymax² ≥ level 的最外层交点即可。
   *
   * 用途：把行进四面体的网格范围收紧到"等值面实际所在区域"，
   * 而不是按波函数的渐近尾部（后者可能大出数倍）。同分辨率下格距
   * 可因此细数倍——这对 p 轨道节面附近两瓣之间的窄缝尤其关键。
   */
  function isoRadius(n, l, m, mode, level) {
    if (!(level > 0)) return rExtent(n, l);
    const Ymax2 = samplingAngleMax(l, m, mode);
    const scanMax = 2 * n * n + 14;      // 足够覆盖任何可达的等值面外沿
    const steps = 900;
    let rOuter = 0;
    for (let i = 0; i <= steps; i++) {
      const r = (scanMax * i) / steps;
      const R = radialR(n, l, r);
      if (R * R * Ymax2 >= level) rOuter = r;
    }
    return Math.max(rOuter, 0.5);
  }
  function cartToSpherical(x, y, z) {
    const r = Math.hypot(x, y, z);
    const theta = r > 1e-9 ? Math.acos(Math.max(-1, Math.min(1, z / r))) : 0;
    const phi = Math.atan2(y, x);
    return { r: r, theta: theta, phi: phi };
  }

  return {
    Complex, factorial, laguerre, assocLegendre,
    radialR, radialR2, radialDistribution,
    angularComplex, angularReal,
    psiComplex, psiDensity,
    samplingRadius, samplingAngleMax,
    samplePoints,
    lColor, phaseColor, phaseColorFor, hslToRgb,
    orbitLabel, rExtent, isoRadius, maxDensity, cartToSpherical,
    SUBSHELL, SUBSHELL_COLOR,
  };
})();
