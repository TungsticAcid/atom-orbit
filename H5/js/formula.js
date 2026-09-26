/**
 * formula.js — 用 KaTeX 渲染当前 (n,l,m) 波函数的数学表达式
 *
 * 生成一个对齐公式块：ψ = R·Y，其中 R_nl 为径向波函数（含广义拉盖尔），
 * Y 依实/复模式给出球谐（或其实组合）。代入具体的 n,l,m 及归一化系数数值。
 */
window.Formula = (function () {
  'use strict';

  const SUBSHELL = OM.SUBSHELL;

  // e^{imφ} 的指数：|m|=1 时省略系数 1，写出更简洁的 e^{±iφ}
  function mExponent(m) {
    if (m === 1) return '\\mathrm{i}\\phi';
    if (m === -1) return '-\\mathrm{i}\\phi';
    if (m === 0) return '0';
    return m + '\\mathrm{i}\\phi';
  }

  // ---- 关联勒让德 P_l^m(cosθ) 的显式多项式展开 ---------------------------------
  const gcd = (a, b) => { while (b) { const t = a % b; a = b; b = t; } return a || 1; };
  // 把"精确的二进制小数"转成分数（分母为 2 的幂，此处必精确）
  function toFraction(x) {
    let num = x, den = 1;
    while (Math.abs(num - Math.round(num)) > 1e-9 && den < 512) { num *= 2; den *= 2; }
    num = Math.round(num);
    const g = gcd(Math.abs(num), den);
    return { num: num / g, den: den / g };
  }
  // ---- 精确根式：把归一化常数写成整数根式，通篇不出现小数 ------------------------
  //
  // ★ 为什么必须做这件事：教材给出的波函数闭式，归一化常数是**闭式根号**
  //   （如 1/(4√(2π))、1/(81√(6π))），而不是 0.0997…。写小数有两重害处：
  //     ① 学生没法把它代回式子做解析推导，也就无法与教材对照；
  //     ② 小数看起来"精确"，实际是四舍五入的产物 —— 拿它去验算会差在末位，
  //        反而让人怀疑式子本身。所以凡是出现在公式里的数，一律精确。
  //
  // ★ 允许出现的形状只有两种，都由整数运算得出：
  //     √(P/Q)      →  a√s / b        （径向归一化、Θ 的归一化）
  //     √(P/Qπ)     →  a / (b√(sπ))   （含球谐常数后的总系数，即教材那种写法）
  //   其中 s 无平方因子。两个函数都只用整数阶乘，n ≤ 6 时最大 11! < 2^53，不会溢出。

  // ★ 为什么这里必须用 BigInt：n=6、l=5 时 Qrad·n^{2l} ≈ 3×10^18，已超过 double 能
  //   精确表示的整数上界（2^53 ≈ 9×10^15）。用 double 会在**最后几位**悄悄失真，
  //   而失真的后果是根式化简给出一个"看着像对的"错答案 —— 这类错误没有任何报错。
  function gcdBig(a, b) {
    a = a < 0n ? -a : a; b = b < 0n ? -b : b;
    while (b) { const t = a % b; a = b; b = t; }
    return a || 1n;
  }
  function lcmBig(a, b) { return a / gcdBig(a, b) * b; }

  /**
   * 把正整数 n 拆成 n = u²·s（s 无平方因子）—— 全部用 BigInt。
   *
   * ★ 试除只需做到**很小的界**：本文件里出现的数全部由小整数的阶乘与 n^i 相乘而成，
   *   素因子不会超过 n+l ≤ 11。所以循环跑到 d = 64 就一定能除尽（留一倍余量）。
   *   若真遇到除不尽的残数（不该发生），直接把残数当作无平方因子处理 ——
   *   结果依然**正确**，只是未必是最简形式，绝不会算错。
   */
  function squarefreeSplit(n) {
    let u = 1n, s = n;
    for (let d = 2; d <= 64 && BigInt(d) * BigInt(d) <= s; d++) {
      const dd = BigInt(d * d);
      let e = 0;
      while (s % dd === 0n) { s /= dd; e++; }
      if (e) u *= BigInt(d) ** BigInt(e);
    }
    return { u: u, s: s };                 // n = u²·s
  }

  /** 分数 LaTeX：num/den 已互素，den=1 时只写分子 */
  function fracTex(num, den) {
    return den === 1 ? String(num) : '\\frac{' + num + '}{' + den + '}';
  }

  /** 根号 LaTeX：s=1 时退化为 √π 或 1，s>1 时写 √s / √(sπ) */
  function radTex(s, withPi) {
    if (s === 1) return withPi ? '\\sqrt{\\pi}' : '1';
    return '\\sqrt{' + (withPi ? s + '\\pi' : String(s)) + '}';
  }

  /**
   * √(P/Q) 的精确 LaTeX（a√s / b 形，全部化成最简整数）。
   * 例：√(1/24) → √6/12；√(4/243) → 2√3/27。
   */
  function sqrtRatioTex(P, Q) {
    let p = BigInt(P), q = BigInt(Q);
    const g = gcdBig(p, q); p /= g; q /= g;
    const { u, s } = squarefreeSplit(p * q);     // P/Q = (P·Q)/Q² ⇒ 开方后分子的平方部分
    let a = u, b = q;
    const g2 = gcdBig(a, b); a /= g2; b /= g2;
    const sa = Number(a), sb = Number(b), ss = Number(s);
    if (ss === 1) return fracTex(sa, sb);
    const root = radTex(ss, false);
    if (sa === 1) return sb === 1 ? root : '\\frac{' + root + '}{' + sb + '}';
    const top = sa === 1 ? root : sa + root;
    return sb === 1 ? top : '\\frac{' + top + '}{' + sb + '}';
  }

  /**
   * √(P/(Qπ)) 的精确 LaTeX —— 教材里归一化常数的统一写法： √P / (b·√(sπ))，
   * 其中 Q = b²·s、s 无平方因子（P 也顺带提出平方因子）。
   *
   * ★ 为什么只留这一种形式：它一个式子就命中了稿件里的全部写法，不再需要按情况挑：
   *     ψ_{2s} = 1/(4√(2π))      ← P/Q=1/32,  Q=4²·2
   *     ψ_{3d_z²}= 1/(81√(6π))    ← P/Q=1/(81²·6)
   *     ψ_{3p_z}= √2/(81√π)       ← P/Q=2/81²
   *     Y_{p_z} = √3/(2√π)        ← P/Q=3/4
   *     Y_{d_z²}= √5/(4√π)        ← P/Q=5/16
   *     Y_{2,1} = √15/(2√(2π))    ← P/Q=15/8
   *   推导： √(P/(Qπ)) = √P / √(Qπ)；把 Q 里的完全平方因子提到根号外成 b，
   *         剩下的 s 无平方因子，于是分母是 b√(sπ)。P 同理提平方因子到分子。
   */
  function overSqrtPiTex(P, Q) {
    let p = BigInt(P), q = BigInt(Q);
    const g = gcdBig(p, q); p /= g; q /= g;
    const numSplit = squarefreeSplit(p);          // √P = up·√sp
    const denSplit = squarefreeSplit(q);          // √Q = uq·√sq
    let up = Number(numSplit.u); const sp = Number(numSplit.s);
    let uq = Number(denSplit.u); const sq = Number(denSplit.s);
    const gg = gcd(up, uq); up /= gg; uq /= gg;   // 分子分母的平方因子再约一次

    const top = (sp === 1) ? String(up)
      : (up === 1 ? radTex(sp, false) : up + radTex(sp, false));
    const den = (uq === 1 ? '' : String(uq)) + radTex(sq, true);
    if (top === '1') return '\\frac{1}{' + den + '}';
    return '\\frac{' + top + '}{' + den + '}';
  }

  // ---- 任意实数 → 尽量精确的闭式 ------------------------------------------------
  /**
   * 连分数逼近：把 x 写成不超过 maxDen 的最佳有理数；达不到精度返回 null。
   * ★ 不能用 toFraction：那个走的是"反复乘 2"，只对二进制小数精确，
   *   遇到 0.8 这类十进小数会一路乘到 512 然后四舍五入成 205/256 —— 越逼近越荒唐。
   */
  function ratApprox(x, maxDen) {
    let h1 = 1, h0 = 0, k1 = 0, k0 = 1, b = x;
    for (let guard = 0; guard < 64; guard++) {
      const a = Math.floor(b);
      const h2 = a * h1 + h0, k2 = a * k1 + k0;
      if (k2 > maxDen || !isFinite(h2) || !isFinite(k2)) break;
      h0 = h1; h1 = h2; k0 = k1; k1 = k2;
      if (Math.abs(x - h1 / k1) < 1e-12 * Math.max(1, Math.abs(x))) return { num: h1, den: k1 };
      const frac = b - a;
      if (frac < 1e-15) break;
      b = 1 / frac;
      if (!isFinite(b) || Math.abs(b) > 1e15) break;
    }
    return null;
  }

  /**
   * 把实数写成尽量精确的 LaTeX 闭式，优先级：
   *   ① √(有理数) —— 预置系数几乎全是这一类（1/√2、√(2/3)、√(1/3)…），能写成闭式根号
   *   ② 有理数    —— 0.8 → 4/5、0.25 → 1/4
   *   ③ 小数      —— 前两条都不成立时才退让（如模型随手给的 0.37），此时无法强求
   * 判据里都带"回代验算"，避免把 1.4 这类小数误当成某个根式。
   */
  function exactTex(x) {
    if (!isFinite(x)) return String(x);
    const neg = x < 0;
    const a = Math.abs(x);
    if (a < 1e-13) return '0';
    // ① √(有理数)
    const f2 = ratApprox(a * a, 4096);
    if (f2) {
      const v = Math.sqrt(f2.num / f2.den);
      if (Math.abs(v - a) < 1e-9 * Math.max(1, a)) {
        return (neg ? '-' : '') + sqrtRatioTex(f2.num, f2.den);
      }
    }
    // ② 有理数（分母 ≤ 10000 才有意义；再大不如直接写小数）
    const f1 = ratApprox(a, 10000);
    if (f1) return (neg ? '-' : '') + fracTex(f1.num, f1.den);
    // ③ 小数
    return (neg ? '-' : '') + String(Number(a.toPrecision(10)));
  }

  // 通用多项式格式化：coeffs[p] 为 x^p 的系数，term(p) 返回 x^p（p≥1）的 LaTeX。
  // 系数为 ±1 时省略数字（如 -cosθ 而非 -1cosθ）。
  function formatPoly(coeffs, term) {
    const parts = [];
    for (let p = coeffs.length - 1; p >= 0; p--) {
      const c = coeffs[p];
      if (Math.abs(c) < 1e-12) continue;
      const { num, den } = toFraction(c);
      const absNum = Math.abs(num);
      let s;
      if (p === 0) {
        s = den === 1 ? String(absNum) : '\\frac{' + absNum + '}{' + den + '}';
      } else {
        const coefStr = (den === 1 && absNum === 1)
          ? '' : (den === 1 ? String(absNum) : '\\frac{' + absNum + '}{' + den + '}');
        s = coefStr + term(p);
      }
      parts.push({ sign: num < 0 ? '-' : '+', s: s });
    }
    if (!parts.length) return '0';
    let out = '';
    parts.forEach((t, i) => {
      out += (i === 0) ? (t.sign === '-' ? '-' : '') + t.s : (t.sign === '-' ? ' - ' : ' + ') + t.s;
    });
    return out;
  }

  const cosTerm = (p) => (p === 1) ? '\\cos\\theta' : '\\cos^{' + p + '}\\theta';
  const rhoTerm = (p) => (p === 1) ? '\\rho' : '\\rho^{' + p + '}';

  // ---- 广义拉盖尔 L_k^α 的显式展开 ---------------------------------------------
  /** 二项式系数 C(a,b)（a、b 为非负整数） */
  function binom(a, b) {
    if (b < 0 || b > a) return 0;
    let r = 1;
    for (let i = 0; i < b; i++) r = r * (a - i) / (i + 1);
    return Math.round(r);
  }
  /** L_k^α(x) 的系数：L_k^α(x) = Σ_i (-1)^i C(k+α, k-i) x^i / i! */
  function laguerreCoeffs(k, alpha) {
    const c = [];
    for (let i = 0; i <= k; i++) {
      c.push(((i % 2 === 0) ? 1 : -1) * binom(k + alpha, k - i) / OM.factorial(i));
    }
    return c;
  }
  /** L_k^α(ρ) 的 LaTeX（k=0 时恒为 1，调用方应自行省略） */
  function laguerreExp(k, alpha) { return formatPoly(laguerreCoeffs(k, alpha), rhoTerm); }

  /**
   * 返回 P_l^m(cosθ) 展开式的 cosθ 多项式系数（已乘 (-1)^m，不含 sin^mθ 因子）。
   * 数组 index = cosθ 的幂次；仅依赖 (l, |m|)。用于构造 LaTeX 与数值校验。
   */
  function legendreCoeffs(l, m) {
    const a = Math.abs(m);
    // 勒让德多项式系数
    let prev = [1], cur = [0, 1];                       // P_0, P_1
    for (let k = 1; k < l; k++) {                       // 递推 P_{k+1}
      const next = new Array(cur.length + 1).fill(0);
      for (let i = 0; i < cur.length; i++) next[i + 1] += (2 * k + 1) * cur[i];   // (2k+1)xP_k
      for (let i = 0; i < prev.length; i++) next[i] -= k * prev[i];               // -k P_{k-1}
      for (let i = 0; i < next.length; i++) next[i] /= (k + 1);
      prev = cur; cur = next;
    }
    let poly = l === 0 ? prev : cur;
    // 求导 a 次 → (l-m) 次多项式
    for (let d = 0; d < a; d++) {
      const der = new Array(Math.max(0, poly.length - 1)).fill(0);
      for (let i = 1; i < poly.length; i++) der[i - 1] = i * poly[i];
      poly = der;
    }
    const cs = (a % 2 === 0) ? 1 : -1;                  // (-1)^m（Condon–Shortley）
    return poly.map((c) => c * cs);
  }

  /**
   * 展开 P_l^{|m|}(cosθ) 为 LaTeX，并把系数化成**互素整数**。
   *
   * @param {boolean} [dropCS] 去掉 Condon–Shortley 相因子 (-1)^m。
   *        实数解**必须**去掉（理由见 math.js 的 csPhase 说明）；复数解必须保留。
   * @returns {{ tex: string, L: number, G: number }} 显示多项式 = (L/G) × 真正的 P。
   *         因为系数被通分又约分，多出来的倍数 L/G 得从归一化常数里除掉，否则 Y 会整体
   *         差一个因子。教材表 4.2.3 写 Y_{d_{z²}} = √(5/16π)(3cos²θ−1) 而不是
   *         √(5/4π)((3/2)cos²θ−1/2)，做的正是这一步 —— 多项式取整、常数吸收倍数。
   *         L、G 都是小整数，调用方可以直接拿去乘除，不必再过一遍浮点。
   *
   * 原理：P_l^m(x) = (-1)^m (1-x²)^{m/2} d^m/dx^m P_l(x)，其中 (1-x²)^{m/2} = sin^mθ。
   */
  function legendreExpNorm(l, m, dropCS) {
    const a = Math.abs(m);
    let c = legendreCoeffs(l, m);
    if (dropCS && (a % 2 === 1)) c = c.map((v) => -v);

    // ① 通分：所有非零系数同乘 LCM(分母)
    let L = 1;
    c.forEach((v) => {
      if (Math.abs(v) < 1e-12) return;
      const den = toFraction(v).den;
      L = L / gcd(L, den) * den;
    });
    // ② 约分：所有整数系数同除 GCD
    const ints = c.map((v) => (Math.abs(v) < 1e-12 ? 0 : Math.round(toFraction(v).num * (L / toFraction(v).den))));
    let G = 0;
    ints.forEach((v) => { if (v !== 0) G = gcd(Math.abs(v), G || Math.abs(v)); });
    const d = ints.map((v) => v / (G || 1));
    const Lfinal = L, Gfinal = (G || 1);          // 显示多项式 = (L/G) × P

    const sinStr = (a === 1) ? '\\sin\\theta' : '\\sin^{' + a + '}\\theta';
    const cosStrOf = (p) => (p === 0 ? '' : (p === 1 ? '\\cos\\theta' : '\\cos^{' + p + '}\\theta'));

    // 单项（含 m≠0 时 sinᵃθ 的那个 cos 多项式只剩一项）：系数并入，不加括号
    const nz = [];
    d.forEach((v, i) => { if (v !== 0) nz.push({ v: v, p: i }); });
    let body;
    if (nz.length === 1) {
      const { v, p } = nz[0];
      const cosStr = cosStrOf(p);
      if (a === 0) {
        body = (v < 0 ? '-' : '') + (Math.abs(v) === 1 ? '' : String(Math.abs(v))) + cosStr;
        if (p === 0) body = body || '1';
      } else {
        // ±1·sinᵃθ·(cos^pθ 或无) —— 系数必为 ±1（已约分），所以直接写
        body = (v < 0 ? '-' : '') + sinStr + cosStr;
      }
    } else {
      // ★ 多项式**必须加括号**：它后面还跟着别的因子（Φ 一侧的 cos/sin、或 ψ 闭式里的
      //   指数与径向幂），不加括号时 "…√5/(4√π) 3cos²θ − 1" 会被读成"减去 1"。
      //   教材也是加括号的（如 Y_{d_z²} = √(5/16π)(3cos²θ−1)）。
      const poly = '\\left(' + formatPoly(d, cosTerm) + '\\right)';
      body = (a === 0) ? poly : sinStr + poly;
    }
    return { tex: body, L: Lfinal, G: Gfinal, d: d };
  }

  /**
   * @returns {{ latex: string, title: string, modeName: string, note: string }}
   */
  /**
   * @param {Object} [opts]
   * @param {'R'|'Y'|'L'|'P'|'N'} [opts.highlight] 高亮公式中的某一项。
   *   ★ 这是「公式—图形—数值 三向联动」的实现基础：高亮某项的同时，
   *     可联动高亮对应的图表区域与三维特征。
   *   依赖 KaTeX 的 \htmlClass（渲染时需传 trust:true）。
   */
  /**
   * 叠加态公式：ψ = Σ cᵢψᵢ 的展开式 + 各分量权重 |cᵢ|²。
   *
   * ★ 为什么必须单独构建：updateFormula 原先只按 (n,l,m,mode) 生成公式，切到叠加态后
   *   公式区还停在"上一个单一本征态"，与三维视图里真正画出来的东西不是一回事。
   *
   * ★ 顺带把 |cᵢ|² 一并列出 —— 它就是"测到该分量的概率"，是叠加态最该讲清楚的量，
   *   而它正好由程序算出（不经过模型）。放在公式下方比写在正文里更可靠。
   *
   * @param {Array} terms [{n,l,m,c:{re,im}}]
   * @returns {Object|null} 与 buildPsi 同构的 { title, note, latex, mLabel, modeName }
   */
  function buildSuperposition(terms) {
    if (!terms || !terms.length) return null;
    const comp = terms.map(function (t) {
      const re = t.c.re, im = t.c.im || 0;
      const mag = Math.sqrt(re * re + im * im);
      const sub = OM.SUBSHELL[Math.min(t.l, OM.SUBSHELL.length - 1)];
      const md = t.mode || 'real';
      // ★ 逐项按该分量**自己的模式**取记号 —— 一个叠加态里可以实项、复项混着来：
      //   复项写 ψ_{n,l,m}（m 是复球谐的本征值指标，有意义）；
      //   实项写该支壳层的实轨道名 ψ_{3p_x}（教材 ψ_{nlf(r)} 的写法），**不带 m**。
      //   原先这里一律写 ψ_{n,l,m}，等于把复解的指标贴到了实解上。
      const name = (md === 'real') ? realOrbitalName(t.l, t.m) : '';
      const useName = (md === 'real' && name);
      return {
        re: re, im: im, mag: mag, w: mag * mag,
        nm: useName ? ('\\psi_{' + t.n + name + '}')
                    : ('\\psi_{' + t.n + ',' + t.l + ',' + t.m + '}'),
        label: useName ? (t.n + plainName(name))
                       : (t.n + sub + (t.m !== 0 ? '（m=' + (t.m > 0 ? '+' : '') + t.m + '）' : '')),
      };
    });
    // 展开式：系数为 1 时省略；第一项为负要带负号，其余用 ± 连接。
    // ★ 系数一律走 exactTex：1/√2、√(2/3)、1/2 这些预置系数都能写成闭式根号或分数，
    //   原先的 toFixed(3) 会把它写成 0.707 —— 学生没法拿它做解析推导，也与教材对不上。
    let expr = '';
    comp.forEach(function (x, i) {
      const hasIm = Math.abs(x.im) > 1e-12;
      if (hasIm) {
        // 复系数显式写成 (a ± bi)，符号并入括号内 —— 否则会出现"-(a + bi)"这种双重负号。
        // 实部为 0 时不写那个 0 +（纯虚系数很常见，如 0.6i）。
        const reZero = Math.abs(x.re) < 1e-12;
        const reT = reZero ? '' : (x.re < 0 ? '-' : '') + exactTex(Math.abs(x.re));
        const imAbs = (Math.abs(Math.abs(x.im) - 1) < 1e-12) ? '' : exactTex(Math.abs(x.im));
        const sep = reZero ? (x.im < 0 ? '-' : '') : (x.im < 0 ? ' - ' : ' + ');
        expr += (i === 0 ? '' : ' + ') + '\\left(' + reT + sep + imAbs + '\\mathrm{i}\\right)\\,' + x.nm;
        return;
      }
      const tex = exactTex(Math.abs(x.re));
      const cf = (tex === '1') ? '' : tex + '\\,';
      expr += (i === 0 ? (x.re < 0 ? '-' : '') : (x.re < 0 ? '-' : '+')) + cf + x.nm;
    });
    const latex = '\\begin{aligned}'
      + '\\psi &= \\sum_{i} c_i\\,\\psi_{n_i,l_i,m_i} \\\\[2pt]'
      + '&= ' + expr
      + '\\end{aligned}';
    // ★ 这句原先写的是"系数按 Σ|cᵢ|² = 1 自动归一化；|cᵢ|² 是测到该分量的概率"，两处不严谨：
    //   ① Σ|cᵢ|²=1 是**态**的归一化，且以基组正交归一为前提（一般式是 Σᵢⱼ cᵢ*cⱼSᵢⱼ = 1）。
    //      本程序的基组（同一中心的实/复原子轨道、sp/sp³ 杂化轨道）恰好正交归一，所以这条
    //      式子成立 —— 但那是本程序的特例，不是普遍结论；程序实际做的只是把系数**等比缩放**。
    //   ② |cᵢ|² 是**投影到该分量**的概率，只有当该分量确实是所测力学量的本征态时，它才等于
    //      "测到那个本征值"的概率。反例就在本程序里：p_x = (p₊+p₋)/√2 测 L_z 给 ±ℏ 各 1/2
    //      （成立）；但测**能量**时两个分量简并，概率恒为 1，|cᵢ|² 与能量概率无关。
    //   注：#formulaNote 是 textContent 渲染，故这里只能写纯文本，不能用 $...$ 或 **。
    const note = '系数按 Σ|cᵢ|² = 1 等比归一化（本程序基组正交归一，故只需这一条），'
      + '因此只有比值有物理意义；|cᵢ|² 是投影到该分量的概率，'
      + '只有该分量是所测力学量的本征态时才等于"测到该本征值"的概率 —— '
      + comp.map(function (x) { return x.label + ' ' + exactTex(x.w); }).join('、');
    return {
      title: '叠加态 · ' + terms.length + ' 个分量',
      note: note,
      latex: latex,
      mLabel: '',
      modeName: '叠加态',
    };
  }

  function buildPsi(n, l, m, mode, opts) {
    const hl = (opts && opts.highlight) || null;
    /** 按需把某个片段包进高亮 class */
    const W = (part, tex) => (hl === part ? '\\htmlClass{hl-term}{' + tex + '}' : tex);

    const am = Math.abs(m);
    const sub = SUBSHELL[Math.min(l, SUBSHELL.length - 1)];
    const k = n - l - 1;                 // 拉盖尔次数（k=0 时 L_0≡1，可整体省略）

    // ---- 精确的归一化常数：一律以整数比 P/Q 保存，交给根式函数化成最简闭式 ----
    // ★ 这里彻底不谈小数。原先写的是 f4(...)（4 位小数），害处是双重的：
    //   ① 学生没法把它代回式子做解析推导，也就无法与教材对照；② 它看着"精确"，
    //   实为四舍五入的产物，拿去验算会差在末位，反倒让人怀疑式子本身。
    const fact = OM.factorial;
    const Prad = 4 * fact(k);                       // N_{n,l}² = 4k!/(n⁴(n+l)!)
    const Qrad = Math.pow(n, 4) * fact(n + l);
    const Pth = (2 * l + 1) * fact(l - am);         // N_Θ² = (2l+1)/2 · (l−|m|)!/(l+|m|)!
    const Qth = 2 * fact(l + am);
    // 角度常数去掉 π 之后的理性部分：实解 m≠0 的 Φ 是 (1/√π)cos(|m|φ)，其余是
    // (1/√(2π))·（那个 √2 与 PHI_NORM 相消 —— 见 math.js 的 phiFuncReal）
    const phiIsReal = (mode === 'real' && am > 0);
    const Pang = Pth, Qang = phiIsReal ? Qth : 2 * Qth;
    const phiConst = phiIsReal ? '\\frac{1}{\\sqrt{\\pi}}' : '\\frac{1}{\\sqrt{2\\pi}}';

    // ---- P_l^{|m|} 的展开：系数化成互素整数，多出的倍数 (L/G) 由常数吸收 ----
    // ★ 实解要去掉 Condon–Shortley 相因子，复解保留 —— 这是两档**不能共用**的一处约定，
    //   理由见 math.js 的 csPhase 说明（实解是 ±m 组合出来的，组合系数把相因子约掉了）。
    const pLeg = legendreExpNorm(l, am, mode === 'real');
    const Lp = BigInt(pLeg.L), Gp = BigInt(pLeg.G);
    let pExpRaw = pLeg.tex, leadSign = '';
    // ⚠️ 次序：先提取首字符负号，再做高亮包裹 —— 否则 \htmlClass{...} 会挡住负号判断。
    if (pExpRaw.charAt(0) === '-') { leadSign = '-'; pExpRaw = pExpRaw.slice(1); }
    const pExp = W('P', pExpRaw);

    // Φ 一侧的因子：复解 e^{imφ}；实解 cos(mφ)/sin(mφ)（m=0 时无因子）
    let phiTrig = '';
    if (mode === 'complex') {
      if (m !== 0) phiTrig = 'e^{' + mExponent(m) + '}';
    } else if (am > 0) {
      phiTrig = (am === 1)
        ? (m > 0 ? '\\cos\\varphi' : '\\sin\\varphi')
        : (m > 0 ? '\\cos(' + am + '\\varphi)' : '\\sin(' + am + '\\varphi)');
    }

    // ---- 实/复使用不同记法 ----
    // 复解的第三下标是 m 本身（m 是复球谐的本征值指标，在这里有意义）；
    // 实解换成该支壳层的**实轨道名**（ψ_{3p_x}）—— 这正是教材 ψ_{nlf(r)} 的写法，
    // 也让"实解不该用 m 标记"这件事在记号上直接看得出来。
    // ★ l≥4 没有惯用名（g、h 在文献里只按对称性分类），此时用教材的 f(r) 记号本身
    //   作第三下标，而不是退回 m —— 退回 m 等于把复解的指标又贴回实解上。
    const realName = (mode === 'real') ? realOrbitalName(l, m) : '';
    const useName = (mode === 'real' && realName);
    const useFR = (mode === 'real' && !realName);
    const psiTag = useName ? ('\\psi_{' + n + realName + '}')
      : (useFR ? ('\\psi_{' + n + ',' + l + ',f(r)}')
               : ('\\psi_{' + n + ',' + l + ',' + m + '}'));
    const yTag = useName ? ('Y_{' + realName + '}')
      : (useFR ? ('Y_{' + l + ',f(r)}') : ('Y_{' + l + ',' + m + '}'));

    const rows = [];

    // ---- ① 径向部分 R_{n,l}(r)：通式（常数在下一行给出） ----
    // 教材形式 R = N ρˡ e^{-ρ/2} L_k^{2l+1}(ρ)，ρ = 2Zr/(na₀)
    const rParts = [W('N', 'N_{' + n + ',' + l + '}')];
    if (l >= 1) rParts.push(l === 1 ? '\\rho' : '\\rho^{' + l + '}');     // ρ⁰ ≡ 1，省略
    rParts.push('e^{-\\rho/2}');
    if (k > 0) rParts.push(W('L', 'L_{' + k + '}^{' + (2 * l + 1) + '}(\\rho)')); // L₀ ≡ 1，省略
    rows.push('R_{' + n + ',' + l + '}(r) &= ' + W('R', rParts.join('\\,')) +
      ',\\qquad \\rho=\\frac{2Zr}{n a_0}');
    // ② 径向归一化常数 —— 精确根式（原先这里是 4 位小数）
    rows.push('N_{' + n + ',' + l + '} &= ' + sqrtRatioTex(Prad, Qrad));
    if (k > 0) {
      rows.push('L_{' + k + '}^{' + (2 * l + 1) + '}(\\rho) &= ' + W('L', laguerreExp(k, 2 * l + 1)));
    }

    // ---- 角度部分：按 Φ(φ) → Θ(θ) → Y = Θ·Φ 的顺序写 ----
    // ★ 这个顺序是**有意**的。教材讲分离变量多停在 ψ = R(r)·Y(θ,φ) 就停了，学生看不到
    //   "角度部分自己还是两个单变量函数的乘积"。把 Φ、Θ 各自单列一行、再写相乘，
    //   这件事才在公式上看得见 —— 与界面下方那张 Θ/Φ 卡片是同一个论点。

    // ③ 方位角函数 Φ_m(φ)：常数本身就是闭式，不需要近似值
    rows.push('\\Phi_{' + m + '}(\\varphi) &= ' + W('F', phiConst + (phiTrig ? '\\,' + phiTrig : '')));

    // ④ 极角函数 Θ_{l,m}(θ)：多项式已取整，常数同步吸收倍数，故本行与 Y 行逐位一致
    const NthetaDisp = sqrtRatioTex(BigInt(Pth) * Gp * Gp, BigInt(Qth) * Lp * Lp);
    rows.push('\\Theta_{' + l + ',' + m + '}(\\theta) &= ' +
      W('T', NthetaDisp + (pExpRaw === '1' ? '' : '\\,' + W('P', pExpRaw))) +
      ',\\qquad ' + W('N', 'N_{\\Theta}') + ' = ' + NthetaDisp);

    // ⑤ 球谐函数 = 两个因子的乘积，常数已乘开并化成闭式根号
    //    这一行与教材的 Y 表逐项一致：Y_{d_{z²}} = √(5/16π)(3cos²θ−1)、Y_{p_x} = √(3/4π)sinθcosφ
    const yFac = [];
    if (pExpRaw !== '1') yFac.push(pExp);                        // P₀⁰ ≡ 1，省略
    if (phiTrig) yFac.push(phiTrig);                             // e⁰ ≡ 1，省略
    const yCoef = overSqrtPiTex(BigInt(Pang) * Gp * Gp, BigInt(Qang) * Lp * Lp);
    rows.push(yTag + '(\\theta,\\varphi) &= \\Theta_{' + l + ',' + m + '}(\\theta)\\cdot\\Phi_{' + m + '}(\\varphi) = ' +
      W('Y', leadSign + yCoef + (yFac.length ? '\\,' + yFac.join('\\,') : '')));

    // ---- ⑥ 完整波函数：代入并约简后的闭式（与教材 R 表、例题同形） ----
    // 形状： ψ = K (Z/a₀)^{3/2+l} r^l · Q(Zr/a₀) · e^{−Zr/(na₀)} · (角度部分)
    // 其中 Q 是 Zr/a₀ 的**整系数**多项式（k=0 时 Q≡1，整行退化为教材那种简洁写法）。
    //
    // ★ 为什么必须"代入并约简"，而不是只写 ψ = R·Y：前者才是教材最终给出的那个式子
    //   （例 4-7：ψ_2s = 1/(4√(2π))·(1/a₀)^{3/2}(2−r/a₀)e^{−r/2a₀}），学生拿它才能与
    //   教材逐项对照；后者只是"两个符号相乘"，没有可核对的内容。
    //
    // Q 的系数：L_k^{2l+1}(2σ/n) 的第 i 项 = (−1)^i C(k+2l+1, k−i)·(2/n)^i / (i!·n^i) · σ^i
    const qNum = [], qDen = [];
    for (let i = 0; i <= k; i++) {
      const c = ((i % 2 === 0) ? 1 : -1) * binom(k + 2 * l + 1, k - i);
      qNum.push(c * Math.pow(2, i));
      qDen.push(fact(i) * Math.pow(n, i));
    }
    let Lq = 1;
    qDen.forEach((dv) => { Lq = Lq / gcd(Lq, dv) * dv; });
    const qInt = qNum.map((nv, i) => Math.round(nv * (Lq / qDen[i])));
    let Gq = 0;
    qInt.forEach((v) => { if (v !== 0) Gq = gcd(Math.abs(v), Gq || Math.abs(v)); });
    Gq = Gq || 1;
    const qCoef = qInt.map((v) => v / Gq);          // 互素整数系数（显示多项式 = (Lq/Gq)·Q）

    // K² = N_rad² · (2/n)^{2l} · N_ang² ÷ (P 的 L/G)² ÷ (Q 的 Lq/Gq)²
    //     —— 两次"多项式取整"多出来的倍数都要从常数里除掉，否则 ψ 会整体差一个因子
    const Kn = BigInt(Prad) * (2n ** BigInt(2 * l)) * BigInt(Pang) * Gp * Gp * BigInt(Gq) * BigInt(Gq);
    const Kd = BigInt(Qrad) * (BigInt(n) ** BigInt(2 * l)) * BigInt(Qang) *
               Lp * Lp * BigInt(Lq) * BigInt(Lq);
    const kTex = overSqrtPiTex(Kn, Kd);

    // (Zr/a₀) 的 i 次幂 —— 教材用的是展开写法（2Zr/3a₀、2Z²r²/27a₀²），不用 σ 记号
    const sigmaPow = (i) => {
      if (i === 0) return '';
      if (i === 1) return '\\frac{Zr}{a_0}';
      return '\\frac{Z^{' + i + '}r^{' + i + '}}{a_0^{' + i + '}}';
    };
    // ★ 项序按**升幂**（常数项在前）—— 教材就是这么写的：表 4.2.4 的 R_{30} 写
    //   (1 − 2Zr/3a₀ + 2Z²r²/27a₀²)，例 4-7 的 ψ_2s 写 (2 − r/a₀)。降幂会让人一眼认不出。
    const qParts = [];
    for (let i = 0; i < qCoef.length; i++) {
      const c = qCoef[i];
      if (!c) continue;
      const abs = Math.abs(c), sp = sigmaPow(i);
      qParts.push({ sign: c < 0 ? '-' : '+', s: (abs === 1 && i > 0) ? sp : String(abs) + sp });
    }
    let qTex = '';
    qParts.forEach((pt, i) => {
      qTex += (i === 0) ? (pt.sign === '-' ? '-' : '') + pt.s : (pt.sign === '-' ? ' - ' : ' + ') + pt.s;
    });
    // Q 只剩常数项 1 时整段省略（k=0 的情形，如 1s、2p、3d）
    const qShow = (qCoef.length === 1 && qCoef[0] === 1) ? '' : qTex;
    // ★ 多项式必须加括号 —— 后面紧跟的是 e^{-Zr/na₀} 与角度因子，不加括号时
    //   "…(Z/a₀)^{3/2} 2Z²r²/a₀² − 18Zr/a₀ + 27 e^{…}" 里那个 +27 会看起来像在加指数。
    const qBlock = (qParts.length > 1) ? '\\left(' + qShow + '\\right)' : qShow;

    const zExp = (l === 0) ? '\\frac{3}{2}' : ('\\frac{' + (3 + 2 * l) + '}{2}');
    const zPow = '\\left(\\frac{Z}{a_0}\\right)^{' + zExp + '}';
    const rPow = (l === 0) ? '' : (l === 1 ? 'r' : 'r^{' + l + '}');
    const ePow = 'e^{-' + (n === 1 ? 'Zr/a_0' : 'Zr/' + n + 'a_0') + '}';
    const angStr = yFac.length ? ('\\,' + yFac.join('\\,')) : '';

    rows.push(psiTag + '(r,\\theta,\\varphi) &= ' + leadSign + kTex + '\\,' + zPow +
      (rPow ? '\\,' + rPow : '') + (qBlock ? '\\,' + qBlock : '') + '\\,' + ePow + angStr);

    const latex = '\\begin{aligned} ' + rows.join('\\\\[3pt] ') + '\\end{aligned}';

    const modeName = mode === 'real' ? '波函数实数解' : '波函数复数解';
    // ★ 只有复解才写 m —— m 是复球谐的本征值指标，实解换成实轨道名之后这个标记没有意义。
    //   界面上原先无条件拼 "m=+1"，于是实档的标题读起来是"3p 轨道（m=+1 · p_x）"，
    //   把一个只属于复解的指标贴到了实解上。
    const mLabel = useName ? '' : ('m=' + (m > 0 ? '+' + m : m));
    const note = buildNote(n, l, m, mode);

    return {
      latex: latex,
      // ★ 仅供验证脚本使用的数值钩子（界面不读它）：把最后一行公式里的**显示件**
      //   原样交出来 —— 常数、σ 多项式系数（已是整系数）、P 多项式系数（已按本档的
      //   Condon–Shortley 约定定号）。有了它，"把渲染出来的公式代回数值、与 math.js
      //   的 psiComplex 逐点对拍"才做得到。公式里算错一个常数属于**静默故障中最危险的
      //   一种**：不报错、不崩溃，只是安静地给出一个错的式子。
      //   自检脚本见 D:\tmp\orbit-verify\formula-num.js。
      //   注意 d 要**去号**：渲染时 P 的首负号被剥出来由 leadSign 承担（pExpRaw 里没有
      //   它了），所以 d 若原样保留符号，验证脚本会把同一符号算两遍。
      _num: {
        K: Math.sqrt(Number(Kn) / Number(Kd) / Math.PI),
        q: qCoef,
        d: (leadSign === '-') ? pLeg.d.map((v) => -v) : pLeg.d,
        am: am, l: l, n: n, mode: mode,
        lead: (leadSign === '-') ? -1 : 1,
      },

      // 标题走 textContent，所以实轨道名要先转成纯文本（d_{z^2} → d_z²）；
      // 直接塞 LaTeX 名会原样显示成 "d_{z^2}"。
      title: (useName ? (n + plainName(realName)) : (n + sub)) + ' 轨道' +
        (mLabel ? '（' + mLabel + '）' : '') + ' · ' + modeName,
      mLabel: mLabel,
      modeName: modeName,
      note: note,
    };
  }

  /**
   * 实轨道名的**纯文本**版：`d_{z^2}` → `d_z²`。
   * ★ 标题与徽标走 textContent，不能含 LaTeX 花括号；直接塞会原样显示成 "d_{z^2}"。
   */
  function plainName(name) {
    if (!name) return '';
    return name
      .replace(/_\{([^}]*)\}/g, function (mm, inner) { return '_' + inner.replace(/\^2/g, '²'); })
      .replace(/\^2/g, '²');
  }

  /**
   * 实轨道的化学惯用名（d_z²、d_xz…）。
   *
   * ★ 覆盖范围是**有公认命名**的那三档，再多就没有了：
   *     l=0  s
   *     l=1  p_z / p_x / p_y
   *     l=2  d_{z²} / d_{xz} / d_{yz} / d_{x²−y²} / d_{xy}
   *     l=3  f_{z³} / f_{xz²} / f_{yz²} / f_{z(x²−y²)} / f_{xyz} / f_{x(x²−3y²)} / f_{y(3x²−y²)}
   *          （f 这七个是**惯例**，各书用字略有出入，这一套最常见）
   *     l≥4  **没有公认命名** —— g、h 在文献里只按对称性分类（立方谐函数），
   *          不存在 g_{xy} 这样的通名。所以这里返回空串，由调用方改用直角坐标多项式
   *          （realOrbitalCartesian）作标记，见那里的说明。
   *
   * 与 angularReal 的组合约定一致：m>0 → cos(|m|φ) 型，m<0 → sin(|m|φ) 型。
   */
  function realOrbitalName(l, m) {
    if (l === 0) return 's';
    if (l === 1) return ['p_z', 'p_x', 'p_y'][m === 0 ? 0 : (m > 0 ? 1 : 2)];
    if (l === 2) {
      return { '0': 'd_{z^2}', '1': 'd_{xz}', '-1': 'd_{yz}', '2': 'd_{x^2-y^2}', '-2': 'd_{xy}' }[String(m)] || '';
    }
    if (l === 3) {
      return {
        '0': 'f_{z^3}', '1': 'f_{xz^2}', '-1': 'f_{yz^2}',
        '2': 'f_{z(x^2-y^2)}', '-2': 'f_{xyz}',
        '3': 'f_{x(x^2-3y^2)}', '-3': 'f_{y(3x^2-y^2)}',
      }[String(m)] || '';
    }
    return '';
  }

  // ---- 实轨道的直角坐标多项式（无惯用名时的标记法） ---------------------------
  //
  // ★ 依据就是教材自己的写法：实球谐记为 Y_{lf(r)}，而 Y_{lf(r)} = f(x,y,z)/r^l，
  //   其中 f 是关于坐标 x、y、z 的**谐多项式**。于是"这个轨道叫什么"等价于"f 是什么"，
  //   而 f 对任何 l 都存在、且唯一确定 —— g、h 虽无通名，却有 f。本程序据此给 l≥4
  //   起标记（如 4g 的某个轨道记作 `35z⁴−30z²r²+3r⁴`），既不借 m 下标，也不生造名字。
  //
  // ★ 单子式保留 r² 作**符号**而不展开：d_{z²} 因此写成 `3z²−r²`（与教材一字不差），
  //   而不是展开后的 `2z²−x²−y²`；g、h 的四次、五次式也才短得下来。
  //
  // 递推依据：r^l·sinᵃθ·cosᵖθ·{cos,sin}(aφ) = r^(l−a−p)·(r sinθ)ᵃ·(r cosθ)ᵖ·{cos,sin}(aφ)，
  //   而 (r sinθ)ᵃ·{cos,sin}(aφ) = {Re, Im}[(x+iy)ᵃ]，r² = x²+y²+z²。
  //   l−a−p 恒为偶数（P_l^m 各项同奇偶），故 r^(l−a−p) 也是多项式，结果仍是多项式。

  /** 稀疏三元多项式：键 'i,j,k,q' 表示 xⁱyʲzᵏ·(r²)^q */
  function polyMul(A, B) {
    const out = new Map();
    A.forEach((ca, ka) => {
      const a = ka.split(',').map(Number);
      B.forEach((cb, kb) => {
        const b = kb.split(',').map(Number);
        const key = (a[0] + b[0]) + ',' + (a[1] + b[1]) + ',' + (a[2] + b[2]) + ',' + (a[3] + b[3]);
        out.set(key, (out.get(key) || 0) + ca * cb);
      });
    });
    return out;
  }
  function polyAdd(A, B, s) {
    const out = new Map(A);
    B.forEach((c, k) => out.set(k, (out.get(k) || 0) + s * c));
    return out;
  }
  function polyPow(base, n) {
    let r = new Map([['0,0,0,0', 1]]);
    for (let i = 0; i < n; i++) r = polyMul(r, base);
    return r;
  }
  const P_X = new Map([['1,0,0,0', 1]]), P_Y = new Map([['0,1,0,0', 1]]), P_Z = new Map([['0,0,1,0', 1]]);
  /** r^(2q) —— 保留成单个符号，不展开成 (x²+y²+z²)^q */
  const r2Pow = (q) => new Map([[('0,0,0,' + q), 1]]);
  /** (x+iy)ᵃ 的实部 / 虚部 —— 即 ρᵃcos(aφ) 与 ρᵃsin(aφ) */
  function rhoPow(a, isSin) {
    let out = new Map();
    for (let k = isSin ? 1 : 0; k <= a; k += 2) {
      // ★ 两个坑，都踩过：
      //   ① x^{a−k} 与 y^k 是**相乘**（同一个单项式），不是相加 —— 写成 polyAdd 会得到
      //      x+y 这种完全无关的式子，而且因为项数看着对，很容易以为算对了。
      //   ② i^k 的符号：k 偶数时为 (−1)^{k/2}（k=2 是 −1，不是 +1），k 奇数时为
      //      (−1)^{(k−1)/2}。原先写成"偶数就 +1"，在 k ≡ 2 (mod 4) 时符号反了 ——
      //      于是 (x+iy)⁴ 的实部会算成 x⁴+6x²y²+y⁴，与正确的 x⁴−6x²y²+y⁴ 差在中间项。
      const half = isSin ? (k - 1) / 2 : k / 2;
      const coef = binom(a, k) * ((half % 2 === 0) ? 1 : -1);
      const t = polyMul(polyPow(P_X, a - k), polyPow(P_Y, k));
      t.forEach((c, key) => out.set(key, (out.get(key) || 0) + c * coef));
    }
    return out;
  }

  /** 实轨道的直角坐标多项式 f（Y_{l,f} = f/r^l）的 LaTeX，不出现 m */
  function realOrbitalCartesian(l, m) {
    const a = Math.abs(m);
    let c = legendreCoeffs(l, m);
    if (a % 2 === 1) c = c.map((v) => -v);                  // 去掉 Condon–Shortley
    const base = (a === 0) ? new Map([['0,0,0,0', 1]]) : rhoPow(a, m < 0);
    let acc = new Map();
    for (let p = 0; p < c.length; p++) {
      if (Math.abs(c[p]) < 1e-12) continue;
      const q = (l - a - p) / 2;
      if (q < 0 || Math.abs(q - Math.round(q)) > 1e-9) continue;
      acc = polyAdd(acc, polyMul(polyMul(r2Pow(Math.round(q)), polyPow(P_Z, p)), base), c[p]);
    }
    // 系数清成互素整数（全是二进小数，toFraction 精确）
    let L = 1;
    acc.forEach((v) => { if (Math.abs(v) > 1e-12) { const d = toFraction(v).den; L = L / gcd(L, d) * d; } });
    const ints = new Map();
    let G = 0;
    acc.forEach((v, k) => {
      const iv = Math.abs(v) < 1e-12 ? 0 : Math.round(toFraction(v).num * (L / toFraction(v).den));
      if (iv) { ints.set(k, iv); G = gcd(Math.abs(iv), G || Math.abs(iv)); }
    });
    if (!G) return '1';
    // ★ 提出**公因式**（各单项式指数的最小值）。不提取的话 h 轨道的标签会是
    //   `27x^{2}yz^{2} - 9y^{3}z^{2} - 3x^{2}yr^{2} + y^{3}r^{2}` 这种一长串，
    //   按钮排出来没法看；提出 y 之后是 `y(27x²z²−9y²z²−3x²r²+y²r²)`，短了一半，
    //   也更接近它作为"某个球谐的角向部分"的本来面目。
    const keys = [...ints.keys()];
    const pow = keys.map((k) => k.split(',').map(Number));
    const fac = [0, 1, 2, 3].map((d) => Math.min.apply(null, pow.map((p) => p[d])));
    const mono = (p) => (p[0] ? (p[0] === 1 ? 'x' : 'x^{' + p[0] + '}') : '') +
                        (p[1] ? (p[1] === 1 ? 'y' : 'y^{' + p[1] + '}') : '') +
                        (p[2] ? (p[2] === 1 ? 'z' : 'z^{' + p[2] + '}') : '') +
                        (p[3] ? (p[3] === 1 ? 'r^{2}' : 'r^{' + (2 * p[3]) + '}') : '');
    const order = (A, B) => (B[0][2] - A[0][2]) || (B[0][3] - A[0][3]) ||
                            (B[0][0] - A[0][0]) || (B[0][1] - A[0][1]);
    const renderInner = (list) => {
      list.sort(order);
      const parts = [];
      list.forEach(([p, v]) => {
        const m2 = [p[0] - fac[0], p[1] - fac[1], p[2] - fac[2], p[3] - fac[3]];
        let mo = mono(m2);
        const abs = Math.abs(v);
        let sc;
        if (!mo) sc = String(abs);                        // 常数项：只写系数
        else sc = ((abs === 1) ? '' : String(abs)) + mo;  // 带变量：系数为 1 时省略
        parts.push({ sign: v < 0 ? '-' : '+', s: sc });
      });
      let out = '';
      parts.forEach((pt, i) => {
        out += (i === 0) ? (pt.sign === '-' ? '-' : '') + pt.s : (pt.sign === '-' ? ' - ' : ' + ') + pt.s;
      });
      return out;
    };
    const list = keys.map((k) => [k.split(',').map(Number), ints.get(k) / G]);
    const inner = renderInner(list);
    const fm = mono(fac);
    if (!fm) return inner;
    if (inner === '1') return fm;                          // 提出公因式后括号里只剩 1
    return / [+\-] /.test(inner) ? (fm + '\\left(' + inner + '\\right)') : (fm + inner);
  }

  /**
   * 实轨道的**显示名**：有惯用名就用惯用名（p_x / d_{xy} / f_{z^3}），
   * 没有（l≥4）就退到直角坐标多项式。两条路都**不含 m** —— 这是"实解不该用 m 标记"
   * 的兜底：宁可用一个长一点的多项式，也不把复解的本征值指标贴到实解上。
   */
  function realOrbitalLabel(l, m) {
    return realOrbitalName(l, m) || realOrbitalCartesian(l, m);
  }

  /**
   * 反向查：给定支壳层 l 与实轨道惯用名，返回对应的 m；查不到返回 null。
   * 供智能体动作（按名字指定实轨道）与自检脚本使用；正向映射在 realOrbitalName。
   */
  function realOrbitalM(l, name) {
    if (!name) return null;
    const key = String(name).replace(/\s+/g, '');
    for (let m = -l; m <= l; m++) {
      if (realOrbitalName(l, m) === key) return m;
    }
    return null;
  }

  /** 实轨道惯用名的 **HTML 版**（真下标）：`p_z` → `p<sub>z</sub>`、
   * `d_{x^2-y^2}` → `d<sub>x²-y²</sub>`。
   *
   * ★ 必须与 realOrbitalName 分开：那个用于**纯文本**场合（公式区标题走 textContent，
   *   不能含标签），这个用于 innerHTML（右上角轨道标签）。混用会让标签原样显示成
   *   "p_z"，d 轨道尤其扎眼 —— 它内部用的是 LaTeX 花括号语法，会显示成 "d_{xz}"。
   */
  function realOrbitalNameHtml(l, m) {
    const name = realOrbitalName(l, m);
    if (!name) return '';
    return name
      .replace(/_\{([^}]*)\}/g, function (mm, inner) {
        return '<sub>' + inner.replace(/\^2/g, '²') + '</sub>';
      })
      .replace(/_([a-z])/g, function (mm, c) { return '<sub>' + c + '</sub>'; });
  }

  /**
   * 实轨道**显示名**的 HTML 版（供 innerHTML 用：右上角轨道标签、实轨道按钮）。
   * 有惯用名走 realOrbitalNameHtml（p_z → p<sub>z</sub>）；
   * 没有（l≥4）则把直角坐标多项式的 `^{n}` 转成 <sup>n</sup>。
   */
  function realOrbitalLabelHtml(l, m) {
    if (realOrbitalName(l, m)) return realOrbitalNameHtml(l, m);
    return realOrbitalCartesian(l, m)
      .replace(/\\left\(/g, '(').replace(/\\right\)/g, ')')
      .replace(/\^\{(\d+)\}/g, '<sup>$1</sup>');
  }

  /**
   * 实轨道显示名的**纯文本**版（不给 HTML 用的场合，如 console 与标题字符串）。
   */
  function realOrbitalLabelPlain(l, m) {
    return realOrbitalLabelHtml(l, m)
      .replace(/<sup>([^<]*)<\/sup>/g, '$1')
      .replace(/<sub>([^<]*)<\/sub>/g, '$1');
  }

  /** 针对常见情况给出教育性解说 */
  /**
   * 针对当前轨道给出教育性解说。
   *
   * ★ 两个用词是刻意统一的，别改回去：
   *   · 「径向节点 / 角度节面」—— 教材口径就是"径向节点数 n−l−1、角度节面数 l"。
   *     原先把后者写作"角节点"，与知识库另一处的"角度节面"对同一件事用了两个词。
   *   · 「与同 |m| 的 cos 型相差 90°/|m|」—— 原文写的是"瓣垂直于**前一型**"，而"前一型"
   *     在这段文本里无所指（界面上不会同时显示 m>0 那一句），学生根本无从对照。
   *     cos(mφ) 的瓣在 φ = kπ/|m|，sin(mφ) 的在 φ = (π/2+kπ)/|m|，两者相差 π/(2|m|)，
   *     换成角度就是 90°/|m| —— |m|=1 得 90°（x 型转成 y 型）、|m|=2 得 45°（十字转成对角）。
   */
  function buildNote(n, l, m, mode) {
    const sub = SUBSHELL[Math.min(l, SUBSHELL.length - 1)];
    if (n === 1 && l === 0) return '1s：球对称，概率密度随半径单调衰减；没有径向节点。';
    if (l === 0) return n + 's：球对称分布，没有角度节面；径向节点 ' + (n - 1) + ' 个。';
    const radialNodes = n - l - 1;
    const am = Math.abs(m);
    const orient = mode === 'complex'
      ? '复数解绕 z 轴对称（环面 / 锥面），相位沿方位角缠绕。'
      : (m > 0 ? 'cos(' + am + 'φ) 型：瓣在 xy 面内沿一个方向张开。'
              : (m < 0 ? 'sin(' + am + 'φ) 型：瓣与同 |m| 的 cos(' + am + 'φ) 型绕 z 轴相差 '
                  + (90 / am) + '°。'
                       : 'm=0 型：沿 z 轴的"橄榄"形。'));
    // ★ 命名这件事要主动交代，学生问过（"4f 的七个有各自的名字吗？g、h 呢？"）：
    //   p、d 有公认名，f 的七个是惯例用法，g、h 没有通名。界面上给不出名字时，
    //   与其默默写个 m，不如把"为什么没有"和"改用什么标记"一起说清楚。
    let naming = '';
    if (mode === 'real') {
      if (l === 3) naming = '（f 这七个名是惯例用法，各书用字略有出入。）';
      else if (l >= 4) {
        naming = '（' + sub + ' 支壳层没有公认的通名 —— 高角动量轨道在文献里只按对称性分类。'
          + '故这里按教材 Y_{lf(r)} 的写法，把角向部分记作 f(r) = '
          + realOrbitalCartesian(l, m) + '，Y = f(r)/r^' + l + '。）';
      }
    }
    return '径向节点 ' + radialNodes + ' 个、角度节面 ' + l + ' 个；' + orient + naming;
  }

  return {
    buildPsi, buildSuperposition, legendreCoeffs, laguerreCoeffs,
    realOrbitalName, realOrbitalNameHtml, realOrbitalLabel, realOrbitalLabelHtml,
    realOrbitalCartesian, realOrbitalM, realOrbitalLabelPlain,
    /** 把实数写成精确闭式（叠加态系数用），供自检脚本调用 */
    exactTex, plainName,
  };
})();
