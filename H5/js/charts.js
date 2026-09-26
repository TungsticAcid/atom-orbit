/**
 * charts.js — 2D 图表（纯 Canvas 手绘，无外部图表库）
 *
 * 包含三类图表：
 *   1. 径向曲线：R(r) / R(r)² / D(r)，可多选叠加，各自按峰值归一化。
 *      （D(r)² 已移除：它的零点与峰值和 D(r) 完全相同，却常被误当成独立的物理量。）
 *   2. 角度部分的两个因子：Θ(θ) 与 Φ(φ) 各自的极坐标图 —— 用来把 Y = Θ·Φ 讲清楚。
 *      ★ 球谐曲面 Y 本身**不在这里**：它已并入主三维视图（见 render3d.js 的
 *        updateAngular），这样它就能和完整波函数共用同一套相机与操作。
 *   3. 截面热力图：|ψ|²（可切换相位着色）在 xy / xz / yz 平面上的彩色图。
 *
 * 统一使用设备像素比（devicePixelRatio）缩放，保证高分屏清晰。
 */
window.Charts = (function () {
  'use strict';

  // --- Canvas 基础工具 --------------------------------------------------------
  function setup(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 200;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  // 基于 canvas 元素上的"字符"设置，绘制淡色网格/轴（通用）
  function drawFrame(ctx, w, h, pad) {
    ctx.strokeStyle = 'rgba(120,135,170,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad.l, pad.t, w - pad.l - pad.r, h - pad.t - pad.b);
  }

  // --- 强度配色（深蓝 → 蓝 → 青 → 黄 → 红，类火图） ----------------------------
  const STOPS = [
    [0.00, 8, 14, 40],
    [0.25, 34, 82, 170],
    [0.50, 43, 182, 216],
    [0.75, 255, 211, 77],
    [1.00, 255, 77, 77],
  ];
  function colorScale(t) {
    t = Math.max(0, Math.min(1, t));
    for (let i = 1; i < STOPS.length; i++) {
      if (t <= STOPS[i][0]) {
        const [t0, r0, g0, b0] = STOPS[i - 1];
        const [t1, r1, g1, b1] = STOPS[i];
        const k = (t - t0) / (t1 - t0);
        return [
          Math.round(r0 + (r1 - r0) * k),
          Math.round(g0 + (g1 - g0) * k),
          Math.round(b0 + (b1 - b0) * k),
        ];
      }
    }
    return [STOPS[STOPS.length - 1][1], STOPS[STOPS.length - 1][2], STOPS[STOPS.length - 1][3]];
  }

  // 等高线用的亮色序列（每层一个色，便于区分层级）
  const CONT_COLORS = [
    [150, 210, 255], [120, 255, 190], [255, 235, 130], [255, 165, 95],
    [255, 120, 190], [200, 150, 255], [150, 180, 255], [255, 255, 255],
  ];

  // --- 径向曲线 ---------------------------------------------------------------
  // ★ 只有 R / R² / D 三条。原先还有 D²，但 D ≥ 0 恒成立，平方**不改变极值点与零点**，
  //   画出来只是同一条曲线换个纵轴刻度，对"辨析径向节点"这个教学目的没有增量，
  //   故从界面、函数表、配色表、名称表一并移除。
  const RADIAL_FN = {
    R:  (n, l, r) => OM.radialR(n, l, r),
    R2: (n, l, r) => OM.radialR2(n, l, r),
    D:  (n, l, r) => OM.radialDistribution(n, l, r),
  };
  const RADIAL_PALETTE = {
    R: [120, 200, 255],
    R2: [120, 255, 200],
    D: [255, 190, 90],
  };
  const RADIAL_NAME = { R: 'R(r)', R2: 'R(r)²', D: 'D(r)' };

  // 径向图的特征标注状态（由 scene-bridge 的 highlightRadialFeature 驱动）
  let radialHighlight = null;
  let lastRadialArgs = null;

  /**
   * 求某个径向函数的"特征半径"。
   *   D 的峰值/零点直接用 math.js 的确定性函数（数值求极值 / 求根）
   *   R 的零点与 D 相同（R=0 ⟺ r²R²=0），峰值需自行扫描 |R|
   * 全部由计算层给出，不依赖视觉推断。
   */
  function computeFeature(target, feature, n, l) {
    if (target === 'D') {
      return feature === 'peak' ? OM.radialPeaks(n, l) : OM.radialZeros(n, l);
    }
    if (feature === 'zeros') return OM.radialZeros(n, l);
    // |R| 的局部极大
    const rMax = OM.rExtent(n, l);
    const steps = 1200;
    const h = rMax / steps;
    const out = [];
    let a = Math.abs(OM.radialR(n, l, 1e-9));
    let b = Math.abs(OM.radialR(n, l, h));
    for (let i = 2; i <= steps; i++) {
      const c = Math.abs(OM.radialR(n, l, (rMax * i) / steps));
      if (b > a && b >= c && b > 1e-12) out.push((rMax * (i - 1)) / steps);
      a = b; b = c;
    }
    return out;
  }

  /**
   * 当前**实际会画出来**的特征标线。
   *
   * ★ 标线跟着**曲线显隐**走：只标当前可见曲线对应的半径。原先这两件事是割裂的——
   *   曲线能开关，标线却只由外部的 highlightRadialFeature 动作驱动、界面上没有入口，
   *   于是"关了 R 却还留着 R 的峰值线"，很难控制。
   * @returns {Array<{r:number, col:number[]}>}
   */
  function computeMarks(n, l, whichList) {
    if (!radialHighlight) return [];
    const t = radialHighlight.target, f = radialHighlight.feature;
    const showR = whichList.indexOf('R') >= 0 || whichList.indexOf('R2') >= 0;
    const showD = whichList.indexOf('D') >= 0;
    const marks = [];
    if ((t === 'R' || t === 'ALL') && showR) {
      computeFeature('R', f, n, l).forEach((r) => marks.push({ r: r, col: RADIAL_PALETTE.R }));
    }
    if ((t === 'D' || t === 'ALL') && showD) {
      computeFeature('D', f, n, l).forEach((r) => marks.push({ r: r, col: RADIAL_PALETTE.D }));
    }
    // 去重：R 与 D 的零点完全相同（D = r²R²），重复画只会叠成一条
    const uniq = [];
    marks.forEach((m) => {
      if (!uniq.some((u) => Math.abs(u.r - m.r) < 1e-6)) uniq.push(m);
    });
    return uniq;
  }

  /** 设置/清除径向图的特征标注（target=null 表示清除） */
  function setRadialHighlight(target, feature) {
    radialHighlight = target ? { target: target, feature: feature } : null;
    if (lastRadialArgs) {
      const a = lastRadialArgs;
      drawRadial(a.canvas, a.n, a.l, a.whichList);
    }
  }

  function drawRadial(canvas, n, l, whichList) {
    lastRadialArgs = { canvas: canvas, n: n, l: l, whichList: whichList.slice() };
    const { ctx, w, h } = setup(canvas);
    const pad = { l: 46, r: 16, t: 16, b: 34 };
    drawFrame(ctx, w, h, pad);
    const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;

    const rEnd = OM.rExtent(n, l) * 1.02;
    const N = 360;
    const curves = whichList.map((key) => {
      const fn = RADIAL_FN[key];
      let mx = 0;
      const pts = [];
      for (let i = 0; i <= N; i++) {
        const r = (rEnd * i) / N;
        const v = fn(n, l, r);
        pts.push(v);
        if (Math.abs(v) > mx) mx = Math.abs(v);
      }
      return { key, pts, mx: mx || 1e-12 };
    });

    const signed = whichList.includes('R');
    const yMin = signed ? -1 : 0, yMax = 1;
    // 值 → 像素 y 的统一映射（有负值时纵轴从 -1 到 +1）
    const valueToY = (v) => pad.t + ih * (1 - (v - yMin) / (yMax - yMin));

    // 水平网格线 + 刻度（纵轴值，支持负值）
    ctx.strokeStyle = 'rgba(120,135,170,0.18)';
    ctx.fillStyle = 'rgba(170,185,215,0.7)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.lineWidth = 1;
    const yTicks = signed ? [-1, -0.5, 0, 0.5, 1] : [0, 0.2, 0.4, 0.6, 0.8, 1];
    yTicks.forEach((tv) => {
      const gy = valueToY(tv);
      ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(w - pad.r, gy); ctx.stroke();
      ctx.fillText(tv.toFixed(tv % 1 === 0 ? 1 : 2), pad.l - 34, gy + 4);
    });
    // 垂直网格线（r 轴）
    for (let g = 0; g <= 5; g++) {
      const gx = pad.l + (iw * g) / 5;
      ctx.beginPath(); ctx.moveTo(gx, pad.t); ctx.lineTo(gx, h - pad.b); ctx.stroke();
      const rv = (rEnd * g) / 5;
      ctx.fillText(rv.toFixed(1), gx - 8, h - pad.b + 16);
    }
    // 轴标签
    ctx.fillStyle = 'rgba(200,210,235,0.9)';
    ctx.font = '12px system-ui, sans-serif';
    // x 轴：钟标居中偏右、**压在刻度数字下面一行**（原先 x = w−pad.r−34 与最后一个
    // 刻度（如 41.4）横向重叠，看着挤在一起）
    ctx.fillText('r (a₀)', w - pad.r - 46, h - 4);
    // y 轴：原先写作 (pad.l − 68) = 负坐标 → 一半画到画布外被裁，看着像"数幅度"。
    // 改放在绘图区左上方的留白里（那里正好空着，图例在右上）
    ctx.fillText('归一化值', pad.l + 2, pad.t - 5);

    // 绘制各曲线（按其峰值归一化，便于比较节点结构）
    curves.forEach((c) => {
      const col = RADIAL_PALETTE[c.key];
      ctx.strokeStyle = 'rgb(' + col.join(',') + ')';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      for (let i = 0; i <= N; i++) {
        const x = pad.l + (iw * i) / N;
        const y = valueToY(c.pts[i] / c.mx);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });

    // 特征标注（峰值 / 零点）—— 辨析 R 与 D 的核心手段（口径见 computeMarks）
    const marks = computeMarks(n, l, whichList);
    if (marks.length) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.6;
      ctx.font = '10px system-ui, sans-serif';
      let row = 0;
      marks.forEach((m) => {
        if (!(m.r >= 0) || m.r > rEnd) return;
        const gx = pad.l + (iw * m.r) / rEnd;
        ctx.strokeStyle = 'rgba(' + m.col.join(',') + ',0.95)';
        ctx.beginPath(); ctx.moveTo(gx, pad.t); ctx.lineTo(gx, pad.t + ih); ctx.stroke();
        ctx.fillStyle = 'rgb(' + m.col.join(',') + ')';
        // 标签分两行交错，避免相邻标线的数值贴在一起
        ctx.fillText(m.r.toFixed(2), Math.min(gx + 3, w - pad.r - 30), pad.t + 12 + (row % 2) * 12);
        row++;
      });
      ctx.restore();
    }

    // 图例
    let lx = w - pad.r - 150;
    curves.forEach((c) => {
      const col = RADIAL_PALETTE[c.key];
      ctx.fillStyle = 'rgb(' + col.join(',') + ')';
      ctx.fillRect(lx, pad.t + 2, 12, 3);
      ctx.fillStyle = 'rgba(220,228,245,0.9)';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(RADIAL_NAME[c.key], lx + 15, pad.t + 6);
      lx += 64;
    });
  }

  // --- 角度部分的两个因子：Θ(θ) 与 Φ(φ) ---------------------------------------
  /**
   * 把分离变量再拆一层：Y(θ,φ) = Θ(θ)·Φ(φ)，左右各一幅极坐标图。
   *
   * ★ 为什么值得单独一张卡：教材讲到 ψ = R(r)·Y(θ,φ) 通常就停了，学生看不到
   *   "角度部分自己还能分成两个**单变量**函数的乘积"。左右并排、中间一个「×」，
   *   这件事才看得见；底部那行再把 max|Θ| × max|Φ| = max|Y| 的真实数字写出来，
   *   让"相乘"从一句话变成可核对的事实。
   *
   * ★ 两幅图的极角基准**不同**，图上必须各自标清楚，否则学生会以为能叠在一起：
   *     Θ 画在 xz 平面，极角 = θ，自 **+z（朝上）** 起算；
   *     Φ 画在 xy 平面，极角 = φ，自 **+x（朝右）** 起算。
   *
   * ★ 曲线的视觉半径各按**自身峰值**归一化（与径向图的约定一致），那只影响形状
   *   看起来多大；乘积关系由底部那行的**真实数值**保证，不依赖视觉半径。
   *
   * @param mode 'real' | 'complex' —— 只影响 Φ（Θ 恒为实数）；复解取模，画出来
   *             就是教材说的"一个圆圈"，并按相位彩虹着色。
   */
  function drawThetaPhi(canvas, l, m, mode) {
    const { ctx, w, h } = setup(canvas);
    const padX = 6;
    const colW = (w - padX * 2) / 2;
    const Rho = Math.min(colW * 0.84, h * 0.34);
    const cy = h * 0.55;
    const cxT = padX + colW * 0.5;        // 左：Θ 的极点
    const cxP = padX + colW * 1.5;        // 右：Φ 的极点
    const N = 360;

    // ---- 采样两个因子 ----
    const thArr = [], TH = [], phArr = [], PH = [];
    let mxT = 0, mxP = 0;
    for (let i = 0; i <= N; i++) {
      const t = (Math.PI * i) / N;
      thArr.push(t);
      const v = OM.thetaFunc(l, m, t);
      TH.push(v);
      if (Math.abs(v) > mxT) mxT = Math.abs(v);
    }
    for (let i = 0; i <= N; i++) {
      const p = (2 * Math.PI * i) / N;
      phArr.push(p);
      const v = (mode === 'complex')
        ? OM.phiFuncComplex(m, p).abs()
        : OM.phiFuncReal(m, p);
      PH.push(v);
      if (Math.abs(v) > mxP) mxP = Math.abs(v);
    }
    if (mxT < 1e-12) mxT = 1e-12;
    if (mxP < 1e-12) mxP = 1e-12;

    // ---- 极坐标网格（两幅共用）----
    // 8 条 45° 辐射线对"自 +z 起"与"自 +x 起"两种基准是**同一组**线，
    // 所以不必分两套画法，只有角标文字不同。
    ctx.strokeStyle = 'rgba(120,135,170,0.2)';
    ctx.lineWidth = 1;
    for (const cx of [cxT, cxP]) {
      for (const fr of [0.5, 1.0]) {
        ctx.beginPath(); ctx.arc(cx, cy, Rho * fr, 0, Math.PI * 2); ctx.stroke();
      }
      for (let deg = 0; deg < 360; deg += 45) {
        const a = (deg * Math.PI) / 180;
        ctx.beginPath(); ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Rho * Math.sin(a), cy - Rho * Math.cos(a));
        ctx.stroke();
      }
    }

    // ---- 曲线：先填充（回路闭合自然成瓣）再逐段描边 ----
    const POS = 'rgba(150,215,255,0.95)';
    const NEG = 'rgba(255,170,90,0.95)';
    const FILL = 'rgba(120,200,255,0.14)';

    /**
     * @param cx    极点 x
     * @param count 采样点数（分段数 = count）
     * @param toXY  (i) → [x, y]
     * @param sign  (i) → 该点的**带符号**值（决定正/负瓣配色）
     * @param phase 非空时按相位逐段彩虹着色（复解用），此时忽略正负配色
     */
    function strokeCurve(cx, count, toXY, sign, phase) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      for (let i = 0; i <= count; i++) { const p = toXY(i); ctx.lineTo(p[0], p[1]); }
      ctx.closePath();
      ctx.fillStyle = FILL; ctx.fill();
      ctx.lineWidth = 2.2;
      for (let i = 0; i < count; i++) {
        const p0 = toXY(i), p1 = toXY(i + 1);
        if (phase) {
          // ★ phaseColor 返回的是 **0..1 的 THREE 风格三元组**（见 math.js 的 lColor 注释），
          //   而 CSS 的 rgba() 是 0..255 量纲 —— 直接拼会把 0.9 当 0.9/255 处理，
          //   画出来是一条黑线（实测踩过）。必须 ×255。
          const c = phase(i);
          ctx.strokeStyle = 'rgba(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) +
            ',' + Math.round(c[2] * 255) + ',0.95)';
        } else {
          ctx.strokeStyle = sign(i) >= 0 ? POS : NEG;
        }
        ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
      }
    }

    // ---- 左：Θ(θ) 的**完整剖面** ----
    // ★ 为什么不能只沿 θ∈[0,π] 画一遍：θ 只扫过半个平面，而半径取 |Θ| 恒为非负，
    //   于是曲线**全部落在 x ≥ 0 的半边**（x = |Θ|·sinθ，sinθ ≥ 0）。
    //   角度分布的剖面是"绕 z 轴旋转体的截面"，左右两侧都要画 —— 教材上 p_z 的
    //   角度分布图是**两个相切的整圆**，只画右半边会变成两段半圆弧，与上面那张
    //   三维球谐曲面（用完整球面映射，两个整球）**对不上**。
    //   故：先沿 θ: 0→π 走右侧，再沿 θ: π→0 折回走左侧（x 取负），拼成闭合回路。
    const sT = Rho / mxT;
    const kOf = function (i) { return i <= N ? i : (2 * N - i); };   // 折返
    const rightOf = function (i) { return i <= N; };
    strokeCurve(cxT, 2 * N, function (i) {
      const k = kOf(i);
      const r = Math.abs(TH[k]) * sT;
      const x = r * Math.sin(thArr[k]);
      return [cxT + (rightOf(i) ? x : -x), cy - r * Math.cos(thArr[k])];
    }, function (i) { return TH[kOf(i)]; }, null);

    // ---- 右：Φ(φ) ----
    // 这里 φ 扫满 2π，本身就把左右两侧都走到了（r = |cos φ| 的两瓣正是两个整圆），
    // 不需要像 Θ 那样折返。
    const sP = Rho / mxP;
    const phaseCols = (mode === 'complex')
      ? function (i) { return OM.phaseColor(m * phArr[i], 0.6); }
      : null;
    strokeCurve(cxP, N, function (i) {
      const r = Math.abs(PH[i]) * sP;
      return [cxP + r * Math.cos(phArr[i]), cy - r * Math.sin(phArr[i])];
    }, function (i) { return PH[i]; }, phaseCols);

    // ---- 标注 ----
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(200,210,235,0.95)';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillText('Θ(θ)', cxT, 14);
    ctx.fillText('Φ(φ)', cxP, 14);
    // 中间的乘号 —— 整张卡的论点就是它
    ctx.fillStyle = 'rgba(150,170,210,0.9)';
    ctx.font = 'bold 15px system-ui, sans-serif';
    ctx.fillText('×', w * 0.5, cy + 5);

    // 极角基准：两幅不同，各自标出
    ctx.textAlign = 'left';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(170,190,225,0.85)';
    ctx.fillText('+z', cxT + 3, cy - Rho + 11);
    ctx.fillText('−z', cxT + 3, cy + Rho - 2);
    ctx.fillText('+x', cxP + Rho - 15, cy - 3);
    ctx.fillText('+y', cxP + 3, cy - Rho + 11);

    // ---- 底部：把"相乘"落成可核对的数字 ----
    // ★ max|Y| 取两因子峰值之积。Y = Θ·Φ 且两个自变量独立，所以 |Y| 的最大值
    //   必在两个峰值处同时取到 —— 这是**恒等式而非近似**（验证脚本会与网格实测的
    //   max|Y| 对照，见 README 的验证一节）。
    ctx.textAlign = 'center';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(170,190,225,0.9)';
    const f3 = function (x) { return x.toFixed(3); };
    ctx.fillText('max:  Θ ' + f3(mxT) + '  ×  Φ ' + f3(mxP) + '  =  Y ' + f3(mxT * mxP),
                 w * 0.5, h - 5);
  }

  // --- 截面图 -------------------------------------------------------------
  const PLANES = { xy: 'xy 平面', xz: 'xz 平面', yz: 'yz 平面' };

  /**
   * 截面视图窗口（缩放 / 平移）。由 main.js 的事件绑定驱动（滚轮缩放、拖拽平移、
   * 双击复位），UX 口径与三维视图一致。
   *
   * ★ 核心设计：让**视窗恒等于采样窗口** —— drawSection 采样 (u,v) ∈ 视窗，而
   *   marchSquareSegments 假定采样网格铺满画布（dx = w/(G-1)）。只要这个等式成立，
   *   热力图 / 等高线 / 节面 / 数值标注**全都不用改**，改的只是"采样哪一块区域"。
   *   反之若"采样全范围、绘图时再缩放"，就得动 marchSquareSegments 与所有标注的坐标。
   *
   * 缺省（scale=1、cu=cv=0）时视窗正是原来的 [-E, E]，行为与改造前完全一致。
   */
  const SECTION_SCALE_MIN = 0.25, SECTION_SCALE_MAX = 8;
  const sectionView = { scale: 1, cu: 0, cv: 0, userAdjusted: false };

  /** 截面视窗的半宽（世界单位）：缺省时跟随全范围 E = rExtent × 1.05 */
  function sectionHalfWidth(n, l) {
    return (OM.rExtent(n, l) * 1.05) / sectionView.scale;
  }
  // 数值格式化：小的概率密度用科学计数法
  function fmtNum(x) {
    const ax = Math.abs(x);
    if (ax !== 0 && (ax < 1e-3 || ax >= 1e4)) return x.toExponential(1);
    return x.toFixed(3);
  }

  /**
   * 截面视图控制 —— 供 main.js 的事件绑定调用。
   * 视图状态留在这里而不是 main.js：它直接决定采样窗口，属于绘制的一部分。
   */
  function zoomSection(factor, anchorU, anchorV) {
    const s0 = sectionView.scale;
    const s1 = Math.max(SECTION_SCALE_MIN, Math.min(SECTION_SCALE_MAX, s0 * factor));
    if (s1 === s0) return false;
    if (anchorU != null && anchorV != null) {
      // 让锚点在视窗里的**相对位置保持不变**（"放大看指针底下这一块"）：
      // 旧偏移 d = a − cu 对应归一化 d·s0/E；要求新归一化相同 ⇒ cu' = a + (cu − a)·s0/s1
      const k = s0 / s1;
      sectionView.cu = anchorU + (sectionView.cu - anchorU) * k;
      sectionView.cv = anchorV + (sectionView.cv - anchorV) * k;
    }
    sectionView.scale = s1;
    sectionView.userAdjusted = true;
    return true;
  }

  /** 平移视窗（世界单位；正值 = 视窗中心向右 / 向下移动） */
  function panSection(du, dv) {
    sectionView.cu += du;
    sectionView.cv += dv;
    sectionView.userAdjusted = true;
  }

  function resetSectionView() {
    sectionView.scale = 1; sectionView.cu = 0; sectionView.cv = 0;
    sectionView.userAdjusted = false;
  }

  /** 视窗状态只读副本（供 main.js 换算像素↔世界坐标、以及决定是否显示复位按钮） */
  function sectionState() {
    return {
      scale: sectionView.scale, cu: sectionView.cu, cv: sectionView.cv,
      userAdjusted: sectionView.userAdjusted,
    };
  }

  // 统一的坐标轴 + 平面名 + 方向标签
  function drawSectionFrame(ctx, w, h, plane, win) {
    ctx.strokeStyle = 'rgba(200,210,235,0.35)';
    ctx.lineWidth = 1;
    // ★ 十字线（u=0 / v=0）随视窗移动 —— 原先写死在 w/2、h/2，缩放平移后就不对了。
    //   线跑出画布时不画（免得在边缘留下一条看着像轴线的假线）。
    const x0 = win ? ((0 - win.u0) / (2 * win.hu)) * w : w / 2;
    const y0 = win ? ((0 - win.v0) / (2 * win.hv)) * h : h / 2;
    if (x0 >= 0 && x0 <= w) { ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0, h); ctx.stroke(); }
    if (y0 >= 0 && y0 <= h) { ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(w, y0); ctx.stroke(); }
    ctx.fillStyle = 'rgba(220,228,245,0.92)';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(PLANES[plane], 8, 18);
    // 轴名固定贴在画布边缘：它说明的是"横/纵轴各是什么"，与视窗位置无关
    const lab = plane === 'xy' ? ['x', 'y'] : plane === 'xz' ? ['x', 'z'] : ['y', 'z'];
    ctx.fillText(lab[0], w - 14, h / 2 - 6);
    ctx.fillText(lab[1], w / 2 + 6, 16);
  }

  // 2D 行进方块：网格 vals(G×G) 上提取 level 等高线线段（像素坐标）
  function marchSquareSegments(vals, G, level, w, h) {
    const segs = [];
    const at = (i, j) => vals[j * G + i];
    const dx = w / (G - 1), dy = h / (G - 1);
    for (let j = 0; j < G - 1; j++) {
      for (let i = 0; i < G - 1; i++) {
        const v00 = at(i, j), v10 = at(i + 1, j), v11 = at(i + 1, j + 1), v01 = at(i, j + 1);
        let bits = 0;
        bits |= (v00 >= level ? 1 : 0);
        bits |= (v10 >= level ? 1 : 0) << 1;
        bits |= (v11 >= level ? 1 : 0) << 2;
        bits |= (v01 >= level ? 1 : 0) << 3;
        if (bits === 0 || bits === 15) continue;
        const X = i * dx, Y = j * dy;
        const lp = (va, vb, ax, ay, bx, by) => {
          const t = (level - va) / ((vb - va) || 1e-12);
          return [ax + t * (bx - ax), ay + t * (by - ay)];
        };
        const pt = [null, null, null, null];   // 0下 1右 2上 3左
        if ((bits & 1) !== ((bits >> 1) & 1)) pt[0] = lp(v00, v10, X, Y, X + dx, Y);
        if (((bits >> 1) & 1) !== ((bits >> 2) & 1)) pt[1] = lp(v10, v11, X + dx, Y, X + dx, Y + dy);
        if (((bits >> 2) & 1) !== ((bits >> 3) & 1)) pt[2] = lp(v11, v01, X + dx, Y + dy, X, Y + dy);
        if (((bits >> 3) & 1) !== (bits & 1)) pt[3] = lp(v01, v00, X, Y + dy, X, Y);
        const cross = [0, 1, 2, 3].filter((e) => pt[e]);
        if (cross.length === 2) {
          segs.push([pt[cross[0]], pt[cross[1]]]);
        } else if (cross.length === 4) {
          // 鞍点：用中心平均消歧
          const c = (v00 + v10 + v11 + v01) / 4;
          if (c >= level) segs.push([pt[0], pt[1]], [pt[2], pt[3]]);
          else segs.push([pt[1], pt[2]], [pt[3], pt[0]]);
        }
      }
    }
    return segs;
  }

  // 无填色等高线 + 节面(白线) + 数值标注
  function drawContour(ctx, vals, G, w, h, maxV, n, l, m, mode, plane, uv2xyz, win, nodalPlane) {
    ctx.fillStyle = '#0a0f1f';                 // 暗底，突出线条
    ctx.fillRect(0, 0, w, h);
    if (nodalPlane) {                          // 整面为节点面
      ctx.fillStyle = 'rgba(255,170,90,0.95)';
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('本平面为节点面 · |ψ|² ≈ 0', w / 2, h / 2 - 6);
      ctx.textAlign = 'left';
      return;
    }
    // 等高线层：对数间距（0.6%→100% 峰值，8 层，疏密合适）；保存每层线段供线上标注
    const NLEV = 8, lf0 = 0.006, lf1 = 1.0;
    const levelCols = [];
    for (let i = 0; i < NLEV; i++) {
      const frac = Math.pow(10, Math.log10(lf0) + (Math.log10(lf1) - Math.log10(lf0)) * i / (NLEV - 1));
      const L = frac * maxV;
      const col = CONT_COLORS[i % CONT_COLORS.length];
      const segs = marchSquareSegments(vals, G, L, w, h);
      levelCols.push({ L: L, col: col, segs: segs });
      ctx.strokeStyle = 'rgb(' + col.join(',') + ')';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const s of segs) { ctx.moveTo(s[0][0], s[0][1]); ctx.lineTo(s[1][0], s[1][1]); }
      ctx.stroke();
    }
    // 节面（ψ=0）：实函数用符号变化线；复函数用极小层描出密度=0 区域
    let nodeSegs = null;
    if (mode === 'real') {
      const sg = new Float32Array(G * G);
      for (let j = 0; j < G; j++) {
        for (let i = 0; i < G; i++) {
          const u = win.u0 + (2 * win.hu * i) / (G - 1);
          const v = win.v0 + (2 * win.hv * j) / (G - 1);
          const [x, y, z] = uv2xyz(u, v);
          const r = Math.hypot(x, y, z);
          const th = r > 1e-9 ? Math.acos(Math.max(-1, Math.min(1, z / r))) : 0;
          const ph = Math.atan2(y, x);
          sg[j * G + i] = OM.psiComplex(n, l, m, r, th, ph, 'real').re;   // 含径向+角度符号
        }
      }
      nodeSegs = marchSquareSegments(sg, G, 0, w, h);
    } else {
      nodeSegs = marchSquareSegments(vals, G, maxV * 1e-4, w, h);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    for (const s of nodeSegs) { ctx.moveTo(s[0][0], s[0][1]); ctx.lineTo(s[1][0], s[1][1]); }
    ctx.stroke();
    // 数值直接标在线上（贪心避让：优先较长线段，且与已标文字保持间距；暗色底板保证可读）
    const placed = [];
    for (let i = 0; i < NLEV; i++) {
      const L = levelCols[i].L, col = levelCols[i].col;
      let best = null;
      for (const s of levelCols[i].segs) {
        const mx = (s[0][0] + s[1][0]) / 2, my = (s[0][1] + s[1][1]) / 2;
        const len = Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);
        if (mx < 4 || mx > w - 4 || my < 4 || my > h - 4) continue;   // 出界跳过
        let clear = true;
        for (const pl of placed) if (Math.hypot(mx - pl.x, my - pl.y) < 26) { clear = false; break; }
        if (clear && (!best || len > best.len)) best = { x: mx, y: my, len: len };
      }
      if (best) {
        drawContourLabel(ctx, fmtNum(L), best.x, best.y, col);
        placed.push({ x: best.x, y: best.y });
      }
    }
    // 说明
    ctx.fillStyle = 'rgba(200,215,240,0.8)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText('等高线 |ψ|² · 白线 = 节面 (ψ = 0)', 8, h - 6);
  }

  // 在等高线上标数值：深色底板 + 同层色文字，居中于 (x,y)
  function drawContourLabel(ctx, text, x, y, col) {
    ctx.save();
    ctx.font = '10px system-ui, sans-serif';
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(8,12,24,0.85)';
    ctx.fillRect(x - tw / 2 - 3, y - 7, tw + 6, 14);
    ctx.fillStyle = 'rgb(' + col.join(',') + ')';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function drawSection(canvas, n, l, m, mode, plane, sectionMode) {
    const { ctx, w, h } = setup(canvas);
    // ★ 计算分辨率随缩放提高：视窗缩到 1/4 后仍用 160² 拉大到画布就是插值糊，
    //   "放大"等于没做。上限 512²（约 26 万次 psiDensity，仍是可接受的开销）。
    const G = Math.max(160, Math.min(512, Math.round(160 * sectionView.scale)));
    // 视窗（半宽 + 中心）；scale = 1 时即原来的 [-E, E]
    const hu = sectionHalfWidth(n, l);
    const win = { u0: sectionView.cu - hu, v0: sectionView.cv - hu, hu: hu, hv: hu };
    // 平面内坐标 (u,v) → 空间 (x,y,z)
    const uv2xyz = (u, v) => {
      if (plane === 'xy') return [u, v, 0];
      if (plane === 'xz') return [u, 0, v];
      return [0, u, v];      // yz
    };

    // 采样 |ψ|²（相位模式下再采相位）
    const vals = new Float32Array(G * G);
    const phases = new Float32Array(G * G);
    let maxV = 0;
    for (let j = 0; j < G; j++) {
      for (let i = 0; i < G; i++) {
        const u = win.u0 + (2 * win.hu * i) / (G - 1);
        const v = win.v0 + (2 * win.hv * j) / (G - 1);
        const [x, y, z] = uv2xyz(u, v);
        const r = Math.hypot(x, y, z);
        const th = r > 1e-9 ? Math.acos(Math.max(-1, Math.min(1, z / r))) : 0;
        const ph = Math.atan2(y, x);
        const dd = OM.psiDensity(n, l, m, r, th, ph, mode);
        vals[j * G + i] = dd;
        if (dd > maxV) maxV = dd;
        if (sectionMode === 'phase') {
          phases[j * G + i] = (mode === 'real')
            // ★ 完整 ψ 的符号（含 R(r)）—— 只看 Y 会漏掉径向节点处的符号翻转
            ? (OM.radialR(n, l, r) * OM.angularReal(l, m, th, ph) >= 0 ? 0 : Math.PI)
            : OM.angularComplex(l, m, th, ph).arg();
        }
      }
    }
    const nodalPlane = maxV < 1e-10;      // 该平面密度近似为 0 → 节点面
    if (maxV < 1e-12) maxV = 1e-12;

    if (sectionMode === 'contour') {
      // ★ maxV 是**视窗内**的峰值：放大后颜色映射与 8 层等高线会整体重标定（越放大越亮）。
      //   这是有意选择 —— 放大看暗部（外层壳、概率尾巴）正是这个功能的目的。
      drawContour(ctx, vals, G, w, h, maxV, n, l, m, mode, plane, uv2xyz, win, nodalPlane);
      drawSectionFrame(ctx, w, h, plane, win);
      return;
    }

    // 密度 / 相位：填色热力图
    const tmp = document.createElement('canvas');
    tmp.width = G; tmp.height = G;
    const tctx = tmp.getContext('2d');
    const img = tctx.createImageData(G, G);
    const data = img.data;
    for (let p = 0; p < G * G; p++) {
      const t = Math.pow(vals[p] / maxV, 0.55);
      let rgb = colorScale(t);
      if (sectionMode === 'phase') {
        const hue = ((phases[p] / (2 * Math.PI)) % 1 + 1) % 1 * 360;
        const hsl = OM.hslToRgb(hue, 0.85, 0.15 + 0.62 * t);
        rgb = [Math.round(hsl[0] * 255), Math.round(hsl[1] * 255), Math.round(hsl[2] * 255)];
      }
      const o = p * 4;
      data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2]; data[o + 3] = 255;
    }
    tctx.putImageData(img, 0, 0);
    ctx.drawImage(tmp, 0, 0, w, h);

    drawSectionFrame(ctx, w, h, plane, win);
    // 节点面提示（填色模式下，把"空白"变成教学点）
    if (nodalPlane) {
      ctx.fillStyle = 'rgba(255,170,90,0.95)';
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('本平面为节点面 · |ψ|² ≈ 0', w / 2, h / 2 - 6);
      ctx.textAlign = 'left';
    }
    // 颜色图例
    drawSectionLegend(ctx, w, h, sectionMode === 'phase', maxV);
  }

  // 颜色图例：右上角竖直色条 + 数值标注
  function drawSectionLegend(ctx, w, h, phaseMode, maxV) {
    const bw = 11, bh = Math.min(104, h * 0.4);
    const x = w - bw - 20, y = h - bh - 14;
    ctx.strokeStyle = 'rgba(220,228,245,0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 0.5, y - 0.5, bw + 1, bh + 1);
    // 逐像素填充色条：顶部为高端值/相位 0，底部为低端
    for (let i = 0; i < bh; i++) {
      const tt = 1 - i / bh;
      let rgb;
      if (phaseMode) {
        const hue = (i / bh) * 360;
        const hsl = OM.hslToRgb(hue, 0.85, 0.6);
        rgb = [Math.round(hsl[0] * 255), Math.round(hsl[1] * 255), Math.round(hsl[2] * 255)];
      } else {
        rgb = colorScale(tt);
      }
      ctx.fillStyle = 'rgb(' + rgb.join(',') + ')';
      ctx.fillRect(x, y + i, bw, 1);
    }
    // 标注
    ctx.fillStyle = 'rgba(220,228,245,0.9)';
    ctx.font = '10px system-ui, sans-serif';
    if (phaseMode) {
      ctx.fillText('0', x + bw + 4, y + 9);
      ctx.fillText('π', x + bw + 4, y + bh / 2 + 3);
      ctx.fillText('2π', x + bw + 4, y + bh + 3);
      ctx.fillStyle = 'rgba(180,196,225,0.75)';
      ctx.fillText('相位 arg ψ', x + bw + 4, y + bh + 15);
    } else {
      ctx.fillText('最大', x + bw + 4, y + 9);
      ctx.fillText('0', x + bw + 4, y + bh + 3);
      ctx.fillStyle = 'rgba(180,196,225,0.75)';
      ctx.fillText('|ψ|² 最大 ' + fmtNum(maxV), x - 8, y - 4);
    }
  }

  return {
    drawRadial, drawThetaPhi, drawSection, setRadialHighlight,
    /** 截面视图控制（缩放 / 平移 / 复位），由 main.js 的事件绑定驱动 */
    zoomSection, panSection, resetSectionView, sectionState, sectionHalfWidth,
    /** 调试/测试：给定曲线显隐时实际会画的标线（只读，不改变状态） */
    _marksDebug: (n, l, whichList) => computeMarks(n, l, whichList),
  };
})();
