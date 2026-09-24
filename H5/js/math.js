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
  /**
   * 等值面"细颈"的半宽 —— 等值面离**角节面**的最近距离。
   *
   * 用途：判断曲面是否出现了网格分辨不出的窄缝。例：4p 在 3.5% 阈值下，最内层壳
   * 上下两瓣在核附近只隔 0.274 a₀，而网格单元格就有 0.82 a₀ —— 缝隙比单元格还小，
   * 网格必然把两瓣连成一个"花生"。有这个量才能**提前判断**该不该上细网格。
   *
   * 推导：|ψ|² = R(r)²·|Y|² ≥ level ⇒ |Y| ≥ √level/|R(r)|。
   * 角节面上 |Y| = 0；而"离节面多远"这个几何量正比于 r（角节面都过原点：锥面是
   * θ=常数、平面是 φ=常数，到原点的距离都随 r 线性增长），于是
   *   最近距离 = (√level / Ymax) · min_r ( r / |R(r)| )。
   *
   * ★ 这是**下界**（推导里对角度取了最宽松的取值），偏保守：宁可多触发一次精细化，
   *   也不要把真正需要精细化的情况漏掉。
   * l = 0 没有角节面 → 不存在细颈，返回 Infinity。
   */
  function isoNeckHalf(n, l, m, mode, level, rMax) {
    if (l < 1 || !(level > 0)) return Infinity;
    const Ymax = Math.sqrt(Math.max(0, samplingAngleMax(l, m, mode || 'real')));
    if (!(Ymax > 0)) return Infinity;
    let best = Infinity;
    const steps = 600;
    for (let i = 1; i <= steps; i++) {
      const r = (rMax * i) / steps;
      const R = Math.abs(radialR(n, l, r));
      if (R < 1e-12) continue;
      const v = r / R;
      if (v < best) best = v;
    }
    if (!isFinite(best)) return Infinity;
    return (Math.sqrt(level) / Ymax) * best;
  }

  /**
   * 全部"空档"：每两层壳之间的**中点半径** + 该空档的**宽度**。
   *
   * 中点可放"必然无曲面"的分界球面 —— 局部精细化要把粗/细两张网格分开，而分界球面
   * 若被曲面穿过，两套网格就会在交界处各画一遍（重叠、z-fighting、碎三角片）。
   *
   * 依据（**严格**，不依赖任何估计）：|ψ|² = R(r)²·|Y|² ≤ R(r)²·Ymax²，故
   *   {|ψ|² ≥ level} ⊆ { R(r)²·Ymax² ≥ level }
   * 后者沿 r 是一串区间（每层径向壳一个）；区间之间那整个空档里，对所有角度都有
   * |ψ|² < level —— 取其中点即可。
   *
   * 宽度是**安全闸门**的依据：分派判据看的是"单元有没有一部分落在球内"，所以只有当
   * 空档宽到容得下跨界单元的伸出量时，才不会出现"同一个单元既含曲面、又被判到另一
   * 侧"（推导见 render3d.js 的 planFinePatch）。只有一层壳时返回空数组（无法分层）。
   *
   * 局部精细化据此**逐层外扩**：盒子覆盖到第几层，由 planFinePatch 按"不越界"与
   * "分辨率够"两道关权衡决定。
   */
  function shellGaps(n, l, m, mode, level) {
    if (!(level > 0)) return [];
    const Ymax2 = samplingAngleMax(l, m, mode || 'real');
    if (!(Ymax2 > 0)) return [];
    const scanMax = 2 * n * n + 14;
    const steps = 2000;
    const bands = [];
    let start = -1;
    for (let i = 0; i <= steps; i++) {
      const r = (scanMax * i) / steps;
      const R = radialR(n, l, r);
      const ok = R * R * Ymax2 >= level;
      if (ok && start < 0) start = r;
      else if (!ok && start >= 0) { bands.push({ from: start, to: r }); start = -1; }
    }
    if (start >= 0) bands.push({ from: start, to: scanMax });
    const gaps = [];
    for (let i = 0; i + 1 < bands.length; i++) {
      gaps.push({
        r: (bands[i].to + bands[i + 1].from) / 2,
        width: bands[i + 1].from - bands[i].to,
      });
    }
    return gaps;
  }

  /**
   * 径向节点半径 —— 即 R_{n,l}(r) = 0 的 r 值（个数应为 n-l-1）。
   * 用变号扫描 + 二分细化求根（对多项式×指数形式足够精确）。
   */
  function radialZeros(n, l) {
    const zeros = [];
    if (n - l - 1 <= 0) return zeros;
    const rMax = 2 * n * n + 10;
    const steps = 3000;
    let prev = radialR(n, l, 1e-6);
    for (let i = 1; i <= steps; i++) {
      const r = (rMax * i) / steps;
      const v = radialR(n, l, r);
      if (prev !== 0 && v !== 0 && (v > 0) !== (prev > 0)) {
        let a = (rMax * (i - 1)) / steps, b = r;
        for (let k = 0; k < 50; k++) {
          const c = (a + b) / 2;
          if ((radialR(n, l, c) > 0) === (radialR(n, l, a) > 0)) a = c; else b = c;
        }
        const z = (a + b) / 2;
        if (z > 1e-3) zeros.push(z);
      }
      prev = v;
    }
    return zeros;
  }

  /**
   * 角节点几何 —— 返回 { cones: [θ…], planes: [φ…] }。
   *   cones  ：P_l^{|m|}(cosθ) = 0 的极角 → 以 z 轴为轴的锥面
   *   planes ：实函数且 m≠0 时，cos(mφ)/sin(mφ) = 0 的方位角 → 过 z 轴的平面
   * 注：复函数 |Y| 与 φ 无关，故无 planes。
   */
  function angularNodes(l, m, mode) {
    const am = Math.abs(m);
    const cones = [];
    const steps = 3000;
    let prev = assocLegendre(l, am, Math.cos(1e-6));
    for (let i = 1; i <= steps; i++) {
      const th = (Math.PI * i) / steps;
      const v = assocLegendre(l, am, Math.cos(th));
      if (prev !== 0 && v !== 0 && (v > 0) !== (prev > 0)) {
        let a = (Math.PI * (i - 1)) / steps, b = th;
        for (let k = 0; k < 50; k++) {
          const c = (a + b) / 2;
          if ((assocLegendre(l, am, Math.cos(c)) > 0) === (assocLegendre(l, am, Math.cos(a)) > 0)) a = c; else b = c;
        }
        const tk = (a + b) / 2;
        // 排除极点附近的退化解（那是 P_l^m 的端点行为，不是真正的节面）
        if (tk > 1e-2 && tk < Math.PI - 1e-2) cones.push(tk);
      }
      prev = v;
    }
    const planes = [];
    if (mode === 'real' && am > 0) {
      // 平面 φ 与 φ+π 等价，故在 [0, π) 内取 am 个
      for (let k = 0; k < am; k++) {
        planes.push(m > 0 ? ((2 * k + 1) * Math.PI) / (2 * am) : (k * Math.PI) / am);
      }
    }
    return { cones, planes };
  }

  /**
   * 轨道节点汇总（供出题与讲解引用，全部确定性计算）
   */
  function nodes(n, l) {
    return { radial: n - l - 1, angular: l, total: n - 1 };
  }

  /** 能级（类氢，eV）：E_n = -13.6 / n² */
  function energy(n) { return -13.6 / (n * n); }

  /** 能级简并度（不含自旋） */
  function degeneracy(n) { return n * n; }

  /** 径向分布 D(r)=r²R² 的峰值半径（可能有多个局部极大，全部返回） */
  function radialPeaks(n, l) {
    const rMax = 2 * n * n + 10;
    const steps = 3000;
    const peaks = [];
    let prev = radialDistribution(n, l, 1e-6);
    let cur = radialDistribution(n, l, rMax / steps);
    for (let i = 2; i <= steps; i++) {
      const r = (rMax * i) / steps;
      const next = radialDistribution(n, l, r);
      if (cur > prev && cur >= next && cur > 1e-12) {
        // 抛物线插值细化
        const h = rMax / steps;
        const denom = prev - 2 * cur + next;
        const delta = Math.abs(denom) > 1e-30 ? (0.5 * (prev - next)) / denom : 0;
        peaks.push(r - h + delta * h);
      }
      prev = cur; cur = next;
    }
    return peaks;
  }

  /** 轨道形状描述（全部由 (l,m,mode) 规则判定，不靠模型想象） */
  function shapeDescribe(l, m, mode) {
    const am = Math.abs(m);
    const lobes = (l === 0) ? 1 : (am === 0 ? 2 : (2 * am >= 2 * l ? 2 : 2 * am));
    const names = ['球形', '哑铃形（双瓣）', '四叶草形', '六瓣形', '八瓣形'];
    let shape = l === 0 ? '球形' : (l === 1 ? '哑铃形（双瓣）' : (l === 2 ? '四叶草形' : names[Math.min(l, names.length - 1)]));
    const axis = mode === 'complex'
      ? '绕 z 轴旋转对称（密度与 φ 无关）'
      : (am === 0 ? '沿 z 轴' : '在 xy 平面内定向（' + (m > 0 ? 'cos' : 'sin') + am + 'φ 型）');
    return { shape, lobes: l === 0 ? 1 : (mode === 'complex' ? 2 : (am === 0 ? 2 : 2 * am)), axis };
  }

  /**
   * 为体数据计算预生成 R²(r) 的查表器。
   *
   * 动机：计算 |ψ|² 标量场时，每个网格节点都要算一次 R(r)，而 R 含
   * Math.pow + Math.exp + 拉盖尔递推——是整个场计算里最贵的部分。
   * 但 R 只依赖 (n,l,r)，在固定 (n,l) 下可用一维查表 + 线性插值替代，
   * 精度损失可忽略（R 光滑；l≥1 时 r→0 处 R∝rˡ 且绝对量趋零）。
   *
   * 实测收益：等值面模式下单次重建从 ~1200ms 降到 ~250ms 量级。
   */
  function makeRadialLUT(n, l, rMax, samples) {
    const N = samples || 8192;
    const inv = N / rMax;
    const tab = new Float64Array(N + 2);
    for (let i = 0; i <= N + 1; i++) {
      const R = radialR(n, l, i / inv);
      tab[i] = R * R;
    }
    return function R2(r) {
      if (!(r > 0)) return tab[0];
      if (r >= rMax) return 0;
      const x = r * inv;
      const i = x | 0;
      const f = x - i;
      return tab[i] + (tab[i + 1] - tab[i]) * f;
    };
  }

  /**
   * 在给定网格上快速求 |ψ|²（用 R² 查表 + 解析角度部分）。
   * 与 psiDensity 结果一致，但快得多——专供等值面/粒子云的体数据计算。
   */
  function makePsiDensityFast(n, l, m, mode, rMax) {
    const R2 = makeRadialLUT(n, l, rMax);
    if (mode === 'real') {
      return function (r, theta, phi) {
        const Y = angularReal(l, m, theta, phi);
        return R2(r) * Y * Y;
      };
    }
    return function (r, theta, phi) {
      return R2(r) * angularComplex(l, m, theta, phi).abs2();
    };
  }

  // ---------------------------------------------------------------------------
  // 叠加态：ψ = Σᵢ cᵢ ψᵢ · e^{iφᵢ}
  //   ★ 干涉项 |ψ|² = Σᵢⱼ cᵢ*cⱼ ψᵢ*ψⱼ e^{i(φᵢ−φⱼ)} 在"先复数求和、再取模方"中
  //     自然出现——这正是叠加区别于"概率简单相加"的本质，也是本功能的核心教学点。
  //   ★ φᵢ 是**相对相位**（φ = ΔE·t/ħ），不是真实时间：真实频率达 10¹⁵ Hz 量级，
  //     不可视化；而干涉图样只依赖相对相位，故用相对相位作参数既物理正确又可见。
  // ---------------------------------------------------------------------------

  /** 叠加态复波函数。terms = [{n,l,m,mode,c:{re,im}}]；phases 为各项相对相位（弧度） */
  function psiSuperposition(terms, r, theta, phi, phases) {
    let re = 0, im = 0;
    for (let i = 0; i < terms.length; i++) {
      const t = terms[i];
      const psi = psiComplex(t.n, t.l, t.m, r, theta, phi, t.mode || 'real');
      const ph = phases ? phases[i] : 0;
      const cp = Math.cos(ph), sp = Math.sin(ph);
      // 先做 e^{iφ} 旋转，再乘复系数 c
      const pr = psi.re * cp - psi.im * sp;
      const pi = psi.re * sp + psi.im * cp;
      re += t.c.re * pr - t.c.im * pi;
      im += t.c.re * pi + t.c.im * pr;
    }
    return new Complex(re, im);
  }

  /** 叠加态概率密度 |ψ|²（含干涉项） */
  function densitySuperposition(terms, r, theta, phi, phases) {
    const p = psiSuperposition(terms, r, theta, phi, phases);
    return p.re * p.re + p.im * p.im;
  }

  /**
   * 叠加态是否为定态：**各分量能量是否简并**。
   * 简并 → 整体时间因子可提到求和号外，取模后消失 → 密度不随时间变化（仍是定态）。
   * 例：2ψ_{3dz²} + 3ψ_{3dxy} 是同能量组合 → 定态，呈静态干涉图样。
   */
  function isStationary(terms) {
    if (!terms || terms.length < 2) return true;
    const E0 = energy(terms[0].n);
    for (let i = 1; i < terms.length; i++) {
      if (Math.abs(energy(terms[i].n) - E0) > 1e-9) return false;
    }
    return true;
  }

  /** 叠加态取景半径（各分量外延的最大值） */
  function superpositionExtent(terms) {
    let m = 1;
    (terms || []).forEach((t) => {
      const e = rExtent(t.n, t.l);
      if (e > m) m = e;
    });
    return m;
  }

  /**
   * 叠加态的「取景参考半径」。
   *
   * ★ 不能用 superpositionExtent（那是各分量的**渐近尾部**，可能比实际内容大 2–3 倍），
   *   否则取景过松、轨道在画面里缩成一小团。
   *   这里取「各分量在自身 30% 峰值处的等值面外延」的最大值——与单一本征态的取景基准一致。
   */
  function superpositionRefExtent(terms) {
    const REF = 0.30;
    let m = 1.2;
    (terms || []).forEach(function (t) {
      const pk = maxDensity(t.n, t.l, t.m, t.mode || 'real');
      const e = isoRadius(t.n, t.l, t.m, t.mode || 'real', REF * pk) * 1.12;
      if (e > m) m = e;
    });
    return m;
  }

  /**
   * 叠加态的「无干涉参考峰值」= Σ|cᵢ|²·peakᵢ。
   *
   * ★ 这是**等值面阈值**该用的基准，而不是实际扫描峰值：
   *   干涉会让实际峰值显著高于此值（相长干涉实测可达近 2 倍），
   *   若按实际峰值取 30%，得到的曲面会比单一轨道小得多、还会碎成几块，
   *   看起来像"渲染坏了"。按参考峰值取阈值，叠加态的曲面尺寸与形状才与单一轨道可比。
   *
   * （粒子云的拒绝采样必须用**实际**峰值，见 maxDensitySuperposition。）
   */
  function superpositionRefPeak(terms) {
    let s = 0;
    (terms || []).forEach(function (t) {
      const w = t.c.re * t.c.re + t.c.im * t.c.im;
      s += w * maxDensity(t.n, t.l, t.m, t.mode || 'real');
    });
    return s > 0 ? s : 1e-12;
  }

  /**
   * 叠加态在给定绝对阈值 level（|ψ|²）下的等值面外延半径 —— 用于定标量场的网格范围。
   *
   * 原理与 isoRadius 相同，只是把"单一分量"换成"叠加态的上界"：
   *   |ψ|² = |Σ cᵢψᵢ|² ≤ ( Σ |cᵢ|·Rᵢ(r)·Ymaxᵢ )²  ≡ S(r)²
   * （三角不等式。Rᵢ、Ymaxᵢ 分别是第 i 个分量的径向函数与球面最大角向值。）
   * 于是沿 r 扫描 S(r) ≥ √level 的最外层交点即可。
   *
   * ★ 这是**严格上界**，用它定网格绝不会把曲面裁掉。
   *   反过来，"各分量各自外延取最大"在叠加态里会**低估**——相长干涉会把密度
   *   抬高，实际的等值面伸得比任何单个分量都远，低阈值下就会被网格盒子切出
   *   平的边缘（这正是叠加态低阈值出现"平切面"的原因）。
   */
  function superpositionIsoRadius(terms, level) {
    if (!terms || !terms.length) return 1.2;
    if (!(level > 0)) return superpositionExtent(terms);
    const need = Math.sqrt(level);
    let nMax = 1;
    const parts = terms.map(function (t) {
      if (t.n > nMax) nMax = t.n;
      return {
        c: Math.sqrt(t.c.re * t.c.re + t.c.im * t.c.im),     // |cᵢ|
        n: t.n, l: t.l,
        y: Math.sqrt(Math.max(0, samplingAngleMax(t.l, t.m, t.mode || 'real'))),  // √(max|Y|²)
      };
    });
    const scanMax = 2 * nMax * nMax + 14;
    const steps = 900;
    let rOuter = 0;
    for (let i = 0; i <= steps; i++) {
      const r = (scanMax * i) / steps;
      let s = 0;
      for (let k = 0; k < parts.length; k++) {
        const p = parts[k];
        s += p.c * Math.abs(radialR(p.n, p.l, r)) * p.y;
      }
      if (s >= need) rOuter = r;
    }
    return Math.max(rOuter, 0.5);
  }

  /**
   * 叠加态的 |ψ|² 的峰值估计（粗网格扫描）。
   * 不能简单用各分量峰值之和——分量之间可能**相长干涉**，峰值会更高，
   * 也可能相消。扫描一遍最可靠（几千次求值，代价可忽略）。
   */
  function maxDensitySuperposition(terms) {
    if (!terms || !terms.length) return 1e-12;
    const rMax = superpositionExtent(terms) * 0.9;
    const NR = 60, NT = 24, NP = 32;
    let mx = 0;
    for (let ir = 1; ir <= NR; ir++) {
      const r = (rMax * ir) / NR;
      for (let it = 0; it <= NT; it++) {
        const th = (Math.PI * it) / NT;
        for (let ip = 0; ip < NP; ip++) {
          const ph = (2 * Math.PI * ip) / NP;
          const v = densitySuperposition(terms, r, th, ph, null);
          if (v > mx) mx = v;
        }
      }
    }
    return mx > 0 ? mx : 1e-12;
  }

  /**
   * 叠加态的粒子云采样：直接对整体 |ψ|² 做三维拒绝采样。
   * （叠加态不能像单一本征态那样把径向与角度分开处理——干涉项是 r 与 (θ,φ) 的耦合项。）
   */
  function samplePointsSuperposition(terms, N, colorMode, phases) {
    const rMax = superpositionExtent(terms) * 1.05;
    const peak = maxDensitySuperposition(terms);
    const pos = new Float32Array(N * 3);
    const cols = new Float32Array(N * 3);
    const phArr = new Float32Array(N);
    const dArr = new Float32Array(N);
    let maxD = 0, count = 0, guard = 0;
    const usePhase = (colorMode !== 'orbital');

    while (count < N && guard < N * 400) {
      guard++;
      const r = rMax * Math.pow(Math.random(), 1 / 3);   // 球内均匀
      const u = 2 * Math.random() - 1;
      const th = Math.acos(u);
      const ph = 2 * Math.PI * Math.random();
      const v = densitySuperposition(terms, r, th, ph, phases);
      if (v < peak * Math.random()) continue;
      pos[3 * count] = r * Math.sin(th) * Math.cos(ph);
      pos[3 * count + 1] = r * Math.sin(th) * Math.sin(ph);
      pos[3 * count + 2] = r * Math.cos(th);
      dArr[count] = v;
      if (v > maxD) maxD = v;
      if (usePhase) phArr[count] = psiSuperposition(terms, r, th, ph, phases).arg();
      count++;
    }
    const nUsed = count;
    const base = lColor(terms[0].l);
    for (let i = 0; i < nUsed; i++) {
      const t = maxD > 0 ? dArr[i] / maxD : 0;
      const k = Math.pow(t, 0.7);
      if (usePhase) {
        const col = phaseColor(phArr[i], k);
        cols[3 * i] = col[0]; cols[3 * i + 1] = col[1]; cols[3 * i + 2] = col[2];
      } else {
        cols[3 * i] = 0.50 + (base[0] - 0.50) * k;
        cols[3 * i + 1] = 0.50 + (base[1] - 0.50) * k;
        cols[3 * i + 2] = 0.52 + (base[2] - 0.52) * k;
      }
    }
    return {
      positions: pos.subarray(0, nUsed * 3).slice(),
      colors: cols.subarray(0, nUsed * 3).slice(),
      extent: rMax,
      count: nUsed,
    };
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
    radialZeros, angularNodes, nodes, energy, degeneracy, radialPeaks, shapeDescribe,
    isoNeckHalf, shellGaps,
    makeRadialLUT, makePsiDensityFast,
    psiSuperposition, densitySuperposition, isStationary, superpositionExtent,
    maxDensitySuperposition, superpositionRefPeak, superpositionRefExtent,
    superpositionIsoRadius,
    samplePointsSuperposition,
    SUBSHELL, SUBSHELL_COLOR,
  };
})();
