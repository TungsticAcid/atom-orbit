/**
 * formula.js — 用 KaTeX 渲染当前 (n,l,m) 波函数的数学表达式
 *
 * 生成一个对齐公式块：ψ = R·Y，其中 R_nl 为径向波函数（含广义拉盖尔），
 * Y 依实/复模式给出球谐（或其实组合）。代入具体的 n,l,m 及归一化系数数值。
 */
window.Formula = (function () {
  'use strict';

  const SUBSHELL = OM.SUBSHELL;
  const f4 = (x) => x.toFixed(4);

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

  /** 多项式非零项个数（用于决定是否加括号） */
  function termCount(coeffs) {
    return coeffs.reduce((a, c) => a + (Math.abs(c) > 1e-12 ? 1 : 0), 0);
  }

  const cosTerm = (p) => (p === 1) ? '\\cos\\theta' : '\\cos^{' + p + '}\\theta';
  const rhoTerm = (p) => (p === 1) ? '\\rho' : '\\rho^{' + p + '}';
  /** cosθ 多项式（关联勒让德展开用） */
  function formatCosPoly(coeffs) { return formatPoly(coeffs, cosTerm); }

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
   * 展开 P_l^m(cosθ)（含相因子 (-1)^m）。原理：
   *   P_l^m(x) = (-1)^m (1-x²)^{m/2} d^m/dx^m P_l(x)，其中 (1-x²)^{m/2}=sin^mθ。
   * 返回 LaTeX 表达式（含排版优化：sin 指数 1 省略、常数多项式直接并进系数）。
   */
  function legendreExp(l, m) {
    const a = Math.abs(m);
    const c = legendreCoeffs(l, m);
    const sinStr = (a === 1) ? '\\sin\\theta' : '\\sin^{' + a + '}\\theta';
    if (a === 0) return formatCosPoly(c);                // m=0：纯 Legendre 多项式
    if (termCount(c) === 1) {
      // 单项：系数并入，得 ±K·sinᵃθ·cosᵖθ，且不加括号（如 -3sinθcosθ）
      let p = 0;
      for (let i = c.length - 1; i >= 0; i--) if (Math.abs(c[i]) > 1e-12) { p = i; break; }
      const { num, den } = toFraction(c[p]);
      const absNum = Math.abs(num);
      const coefStr = (den === 1 && absNum === 1)
        ? '' : (den === 1 ? String(absNum) : '\\frac{' + absNum + '}{' + den + '}');
      const cosStr = (p === 0) ? '' : (p === 1 ? '\\cos\\theta' : '\\cos^{' + p + '}\\theta');
      return (num < 0 ? '-' : '') + coefStr + sinStr + cosStr;
    }
    return sinStr + '\\left(' + formatCosPoly(c) + '\\right)';
  }

  /**
   * @returns {{ latex: string, title: string, modeName: string, note: string }}
   */
  function buildPsi(n, l, m, mode) {
    const am = Math.abs(m);
    const sub = SUBSHELL[Math.min(l, SUBSHELL.length - 1)];
    const k = n - l - 1;                 // 拉盖尔次数（k=0 时 L_0≡1，可整体省略）

    // 归一化常数数值
    const Nrad = Math.sqrt((4 * OM.factorial(k)) / (Math.pow(n, 4) * OM.factorial(n + l)));
    const Nang = Math.sqrt(((2 * l + 1) / (4 * Math.PI)) * (OM.factorial(l - am) / OM.factorial(l + am)));

    // 实/复使用不同记法：复球谐 Y_l^m（m 上标）+ 复 ψ_{n,l}^m；
    // 实球谐 Y_{l,m}（逗号下标）+ 实 ψ_{n,l,m}
    const psiTag = (mode === 'complex')
      ? '\\psi_{' + n + ',' + l + '}^{' + m + '}'
      : '\\psi_{' + n + ',' + l + ',' + m + '}';
    const yTag = (mode === 'complex')
      ? 'Y_{' + l + '}^{' + m + '}'
      : 'Y_{' + l + ',' + m + '}';

    const rows = [];
    rows.push(psiTag + '(r,\\theta,\\phi) &= R_{' + n + ',' + l + '}(r)\\,' + yTag + '(\\theta,\\phi)');

    // ---- 径向：教科书形式 R = N ρˡ e^{-ρ/2} L_k^{2l+1}(ρ)，ρ = 2r/(na₀) ----
    const rParts = ['N_{' + n + ',' + l + '}'];
    if (l >= 1) rParts.push(l === 1 ? '\\rho' : '\\rho^{' + l + '}');     // ρ⁰ ≡ 1，省略
    rParts.push('e^{-\\rho/2}');
    if (k > 0) rParts.push('L_{' + k + '}^{' + (2 * l + 1) + '}(\\rho)'); // L₀ ≡ 1，省略
    rows.push('R_{' + n + ',' + l + '}(r) &= ' + rParts.join('\\,') + ',\\qquad \\rho=\\frac{2r}{n a_0}');
    rows.push('N_{' + n + ',' + l + '} &= \\sqrt{\\frac{4\\cdot ' + k + '!}{' + n + '^{4}\\cdot ' + (n + l) + '!}}\\approx ' + f4(Nrad));
    if (k > 0) {
      rows.push('L_{' + k + '}^{' + (2 * l + 1) + '}(\\rho) &= ' + laguerreExp(k, 2 * l + 1));
    }

    // ---- 角度：P 展开为显式多项式，并清理所有冗余的 1 ----
    const pExp = legendreExp(l, am);
    const factors = [];
    if (pExp !== '1') factors.push(pExp);                                // P₀⁰ ≡ 1，省略
    let coef, coefRow;
    if (mode === 'complex') {
      coef = 'N_{' + l + ',' + m + '}';
      if (m !== 0) factors.push('e^{' + mExponent(m) + '}');             // m=0 时 e⁰ ≡ 1，省略
      coefRow = 'N_{' + l + ',' + m + '} &= \\sqrt{\\frac{' + (2 * l + 1) + '}{4\\pi}\\cdot' +
        '\\frac{' + (l - am) + '!}{' + (l + am) + '!}}\\approx ' + f4(Nang);
    } else if (am === 0) {
      coef = 'N';
      coefRow = 'N &= \\sqrt{\\frac{' + (2 * l + 1) + '}{4\\pi}}\\approx ' + f4(Nang);
    } else {
      coef = '\\sqrt{2}\\,N';
      // m=±1 时省略三角函数内的系数 1（写 cosφ 而非 cos(1φ)）
      factors.push(am === 1
        ? (m > 0 ? '\\cos\\phi' : '\\sin\\phi')
        : (m > 0 ? '\\cos(' + am + '\\phi)' : '\\sin(' + am + '\\phi)'));
      coefRow = 'N &= \\sqrt{\\frac{' + (2 * l + 1) + '}{4\\pi}\\cdot\\frac{' + (l - am) + '!}{' + (l + am) + '!}}' +
        '\\approx ' + f4(Nang) + ',\\qquad \\sqrt{2}N\\approx ' + f4(Math.SQRT2 * Nang);
    }
    // 把因子开头的负号提到整项最前：避免 "√2N −3sinθcosθ" 被误读为减法
    let leadSign = '';
    const posFactors = factors.map((f) => {
      if (f.charAt(0) === '-') { leadSign = (leadSign === '-') ? '' : '-'; return f.slice(1); }
      return f;
    });
    const yRhs = posFactors.length
      ? (leadSign + coef + '\\,' + posFactors.join('\\,'))
      : (leadSign + coef);
    rows.push(yTag + '(\\theta,\\phi) &= ' + yRhs);
    rows.push(coefRow);

    const latex = '\\begin{aligned} ' + rows.join('\\\\[3pt] ') + '\\end{aligned}';

    const modeName = mode === 'real' ? '实函数波函数' : '复函数波函数';
    const mLabel = 'm=' + (m > 0 ? '+' + m : m);
    const realName = (mode === 'real') ? realOrbitalName(l, m) : '';
    const note = buildNote(n, l, m, mode);

    return {
      latex: latex,
      title: n + sub + ' 轨道（' + mLabel + (realName ? ' · ' + realName : '') + '） · ' + modeName,
      mLabel: mLabel,
      modeName: modeName,
      note: note,
    };
  }

  /**
   * 实轨道的化学惯用名（d_z²、d_xz…），仅 l ≤ 2 有公认命名。
   * 与 angularReal 的组合约定一致：m>0 → cos(|m|φ) 型，m<0 → sin(|m|φ) 型。
   */
  function realOrbitalName(l, m) {
    if (l === 0) return 's';
    if (l === 1) return ['p_z', 'p_x', 'p_y'][m === 0 ? 0 : (m > 0 ? 1 : 2)];
    if (l === 2) {
      return { '0': 'd_{z^2}', '1': 'd_{xz}', '-1': 'd_{yz}', '2': 'd_{x^2-y^2}', '-2': 'd_{xy}' }[String(m)] || '';
    }
    return '';
  }

  /** 针对常见情况给出教育性解说 */
  function buildNote(n, l, m, mode) {
    const sub = SUBSHELL[Math.min(l, SUBSHELL.length - 1)];
    if (n === 1 && l === 0) return '1s：球对称，概率密度随半径单调衰减。';
    if (l === 0) return n + 's：无角节点，球对称分布；径向节点数为 ' + (n - 1) + '。';
    const radialNodes = n - l - 1;
    const angularNodes = l;
    const orient = mode === 'complex'
      ? '复函数下绕 z 轴对称（环/锥面），相位沿方位角缠绕。'
      : (m > 0 ? 'cos(' + Math.abs(m) + 'φ) 型，瓣沿一个方向张开。'
              : (m < 0 ? 'sin(' + Math.abs(m) + 'φ) 型，瓣垂直于前一型。'
                       : 'm=0：沿 z 轴的"橄榄"形。'));
    return '径向节点 ' + radialNodes + ' 个、角节点 ' + angularNodes + ' 个；' + orient;
  }

  return { buildPsi, legendreCoeffs, laguerreCoeffs, realOrbitalName };
})();
