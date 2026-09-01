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
  // 把 cosθ 多项式系数（从高次到 0 次）格式化为 LaTeX
  function formatCosPoly(coeffs) {
    const terms = [];
    for (let p = coeffs.length - 1; p >= 0; p--) {
      const c = coeffs[p];
      if (Math.abs(c) < 1e-12) continue;
      const { num, den } = toFraction(c);
      const sign = num < 0 ? '-' : '+';
      const absNum = Math.abs(num);
      const one = den === 1 && absNum === 1;
      const coefStr = one ? '' : (den === 1 ? String(absNum) : '\\frac{' + absNum + '}{' + den + '}');
      let s;
      if (p === 0) s = den === 1 ? String(absNum) : '\\frac{' + absNum + '}{' + den + '}';
      else s = coefStr + (p === 1 ? '\\cos\\theta' : '\\cos^{' + p + '}\\theta');
      terms.push({ sign, s });
    }
    if (!terms.length) return '0';
    let out = '';
    terms.forEach((t, i) => {
      out += (i === 0)
        ? (t.sign === '-' ? '-' : '') + t.s
        : (t.sign === '-' ? ' - ' : ' + ') + t.s;
    });
    return out;
  }

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
    const deg = c.length - 1;
    const sinStr = (a === 1) ? '\\sin\\theta' : '\\sin^{' + a + '}\\theta';
    if (a === 0) return formatCosPoly(c);               // m=0：纯 Legendre 多项式
    if (deg === 0) {                                     // 多项式为常数 → K·sin^mθ
      const { num, den } = toFraction(c[0]);
      if (den === 1 && num === 1) return sinStr;
      if (den === 1 && num === -1) return '-' + sinStr;
      const k = den === 1 ? String(Math.abs(num)) : '\\frac{' + Math.abs(num) + '}{' + den + '}';
      return (num < 0 ? '-' : '') + k + '\\,' + sinStr;
    }
    return sinStr + '\\left(' + formatCosPoly(c) + '\\right)';
  }

  /**
   * @returns {{ latex: string, title: string, modeName: string, note: string }}
   */
  function buildPsi(n, l, m, mode) {
    const am = Math.abs(m);
    const sub = SUBSHELL[Math.min(l, SUBSHELL.length - 1)];

    // 归一化常数数值
    const Nrad = Math.sqrt((4 * OM.factorial(n - l - 1)) / (Math.pow(n, 4) * OM.factorial(n + l)));
    let Nang = Math.sqrt(((2 * l + 1) / (4 * Math.PI)) * (OM.factorial(l - am) / OM.factorial(l + am)));

    // 径向部分
    // (2r/na₀)^l：l=1 省略指数 1；N 下标用逗号形式 N_{n,l}
    const rhoPow = (l === 1)
      ? '\\left(\\frac{2r}{n a_0}\\right)'
      : '\\left(\\frac{2r}{n a_0}\\right)^{' + l + '}';
    const radial =
      'R_{' + n + ',' + l + '}(r) &= ' +
      'N_{' + n + ',' + l + '}\\,' + rhoPow +
      'e^{-r/(n a_0)}\\,L_{' + (n - l - 1) + '}^{' + (2 * l + 1) + '}' +
      '\\!\\left(\\frac{2r}{n a_0}\\right),\\qquad ' +
      "N_{" + n + "," + l + "}=\\sqrt{\\frac{4\\,(n-l-1)!}{n^{4}(n+l)!}}\\approx " + f4(Nrad);

    // 角度部分（P 直接展开为显式多项式）
    const pExp = legendreExp(l, am);
    let ang;
    if (mode === 'complex') {
      ang = 'Y_{' + l + '}^{' + m + '}(\\theta,\\phi) &= ' +
        'N_{' + l + ',' + m + '}\\, ' + pExp + '\\,e^{' + mExponent(m) + '},\\qquad ' +
        'N_{' + l + ',' + m + '}=\\sqrt{\\frac{2l+1}{4\\pi}\\frac{(l-|m|)!}{(l+|m|)!}}' +
        '\\approx ' + f4(Nang);
    } else if (am === 0) {
      ang = 'Y_{' + l + ',0}(\\theta) &= ' +
        'N\\, ' + pExp + ',\\qquad ' +
        'N=\\sqrt{\\frac{2l+1}{4\\pi}}\\approx ' + f4(Nang);
    } else {
      const trig = (m > 0)
        ? '\\cos(' + am + '\\phi)'
        : '\\sin(' + am + '\\phi)';
      const shown = Math.SQRT2 * Nang;
      ang = 'Y_{' + l + ',' + m + '}(\\theta,\\phi) &= ' +
        '\\sqrt{2}\\,N\\, ' + pExp + '\\,' + trig + ',\\qquad ' +
        '\\sqrt{2}N\\approx ' + f4(shown);
    }

    // 实/复使用不同记法：复球谐 Y_l^m（m 上标）+ 复 ψ_{n,l}^m；
    // 实球谐 Y_{l,m}（逗号下标）+ 实 ψ_{n,l,m}
    const psiTag = (mode === 'complex')
      ? '\\psi_{' + n + ',' + l + '}^{' + m + '}'
      : '\\psi_{' + n + ',' + l + ',' + m + '}';
    const yRealTag = (mode === 'complex')
      ? 'Y_{' + l + '}^{' + m + '}'
      : 'Y_{' + l + ',' + m + '}';

    const latex =
      '\\begin{aligned} ' +
      psiTag + '(r,\\theta,\\phi) &= R_{' + n + ',' + l + '}(r)\\,' + yRealTag + '(\\theta,\\phi)\\\\[4pt] ' +
      radial + '\\\\[4pt] ' + ang +
      '\\end{aligned}';

    const modeName = mode === 'real' ? '实函数波函数' : '复函数波函数';
    const note = buildNote(n, l, m, mode);

    return {
      latex: latex,
      title: n + sub + ' 轨道 · ' + modeName,
      modeName: modeName,
      note: note,
    };
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

  return { buildPsi, legendreCoeffs };
})();
