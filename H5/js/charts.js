/**
 * charts.js — 2D 图表（纯 Canvas 手绘，无外部图表库）
 *
 * 包含三类图表：
 *   1. 径向曲线：R(r) / R(r)² / D(r) / D(r)²，可多选叠加，各自按峰值归一化。
 *   2. 角度分布：Y(θ,φ) 或 |Y|²，在选定方位角切面（φ 滑块）上的极坐标曲线。
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
  const RADIAL_FN = {
    R:  (n, l, r) => OM.radialR(n, l, r),
    R2: (n, l, r) => OM.radialR2(n, l, r),
    D:  (n, l, r) => OM.radialDistribution(n, l, r),
    D2: (n, l, r) => { const d = OM.radialDistribution(n, l, r); return d * d; },
  };
  const RADIAL_PALETTE = {
    R: [120, 200, 255],
    R2: [120, 255, 200],
    D: [255, 190, 90],
    D2: [255, 130, 160],
  };
  const RADIAL_NAME = { R: 'R(r)', R2: 'R(r)²', D: 'D(r)', D2: 'D(r)²' };

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
    ctx.fillText('r (a₀)', w - pad.r - 34, h - 10);
    ctx.fillText('波函数幅度', pad.l - 68, pad.t + 6);

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

    // 特征标注（峰值 / 零点）—— 辨析 R 与 D 的核心手段
    if (radialHighlight) {
      const feat = computeFeature(radialHighlight.target, radialHighlight.feature, n, l);
      const col = RADIAL_PALETTE[radialHighlight.target] || [255, 255, 255];
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = 'rgba(' + col.join(',') + ',0.95)';
      ctx.fillStyle = 'rgb(' + col.join(',') + ')';
      ctx.font = '10px system-ui, sans-serif';
      feat.forEach((r, i) => {
        if (!(r >= 0) || r > rEnd) return;
        const gx = pad.l + (iw * r) / rEnd;
        ctx.beginPath(); ctx.moveTo(gx, pad.t); ctx.lineTo(gx, pad.t + ih); ctx.stroke();
        const label = r.toFixed(2);
        const ty = pad.t + 12 + (i % 2) * 12;
        ctx.fillText(label, Math.min(gx + 3, w - pad.r - 34), ty);
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

  // --- 角度分布（极坐标） ------------------------------------------------------
  function drawAngular(canvas, l, m, mode, which, phiDeg) {
    const { ctx, w, h } = setup(canvas);
    const cx = w * 0.5, cy = h * 0.5;
    const Rho = Math.min(w, h) * 0.42;
    const phi = (phiDeg * Math.PI) / 180;
    const N = 360;

    // 采样 f(θ)，θ 为与 +z 的夹角
    const pts = [];
    let mx = 0;
    for (let i = 0; i <= N; i++) {
      const th = (Math.PI * i) / N;
      const g = (mode === 'real')
        ? OM.angularReal(l, m, th, phi)
        : OM.angularComplex(l, m, th, phi).abs();
      const f = (which === 'Y2') ? g * g : g;
      pts.push(f);
      if (Math.abs(f) > mx) mx = Math.abs(f);
    }
    if (mx < 1e-9) mx = 1e-9;

    // 极坐标网格：圆环 + 自 +z 起每 45° 的辐射线
    ctx.strokeStyle = 'rgba(120,135,170,0.2)';
    ctx.lineWidth = 1;
    for (const fr of [0.5, 1.0]) {
      ctx.beginPath(); ctx.arc(cx, cy, Rho * fr, 0, Math.PI * 2); ctx.stroke();
    }
    for (let deg = 0; deg < 360; deg += 45) {
      const a = (deg * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Rho * Math.sin(a), cy - Rho * Math.cos(a));   // θ=0 在上（+z）
      ctx.stroke();
    }
    // +z / -z 标记
    ctx.fillStyle = 'rgba(200,210,235,0.85)';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('+z', cx - 14, cy - Rho - 6);
    ctx.fillText('−z', cx - 12, cy + Rho + 16);

    // 等高线（圆环）数值标注：外圈 = 峰值，内圈 = 0.5×峰值
    ctx.fillStyle = 'rgba(170,190,225,0.8)';
    ctx.font = '10px system-ui, sans-serif';
    for (const fr of [0.5, 1.0]) {
      ctx.fillText((fr === 1 ? '1.0×' : '0.5×') + ' ≈ ' + (fr * mx).toFixed(3),
        cx + 4, cy + Rho * fr + 14);
    }
    // 左上角峰值说明
    ctx.fillStyle = 'rgba(200,210,235,0.9)';
    ctx.font = '11px system-ui, sans-serif';
    const peakLabel = (which === 'Y2') ? 'max |Y|²' : 'max |Y|';
    ctx.fillText(peakLabel + ' ≈ ' + mx.toFixed(3), 8, 16);

    // 曲线：半径 = |f|（绝对值），极角 = θ（自 +z 向下），符号用颜色区分。
    // 注意：不能用"带符号半径"，否则 cosθ 在南北极与符号同步翻转会把正负瓣坍缩到一侧。
    const scale = Rho / mx;
    const toXY = (i) => {
      const th = (Math.PI * i) / N;
      const radius = Math.abs(pts[i]) * scale;
      return [cx + radius * Math.sin(th), cy - radius * Math.cos(th)];
    };
    // 轻填充（中心闭合，自然形成瓣形）
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    for (let i = 0; i <= N; i++) { const [x, y] = toXY(i); ctx.lineTo(x, y); }
    ctx.lineTo(cx, cy);
    ctx.closePath();
    ctx.fillStyle = 'rgba(120,200,255,0.14)';
    ctx.fill();
    // 描边：按符号着色（正 + 为青，负 − 为橙），显示正负瓣
    const POS = 'rgba(150,215,255,0.95)';
    const NEG = 'rgba(255,170,90,0.95)';
    ctx.lineWidth = 2.2;
    for (let i = 0; i < N; i++) {
      const [x0, y0] = toXY(i);
      const [x1, y1] = toXY(i + 1);
      ctx.strokeStyle = pts[i] >= 0 ? POS : NEG;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
  }

  // --- 截面图 -------------------------------------------------------------
  const PLANES = { xy: 'xy 平面', xz: 'xz 平面', yz: 'yz 平面' };
  // 数值格式化：小的概率密度用科学计数法
  function fmtNum(x) {
    const ax = Math.abs(x);
    if (ax !== 0 && (ax < 1e-3 || ax >= 1e4)) return x.toExponential(1);
    return x.toFixed(3);
  }

  // 统一的坐标轴 + 平面名 + 方向标签
  function drawSectionFrame(ctx, w, h, plane) {
    ctx.strokeStyle = 'rgba(200,210,235,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.fillStyle = 'rgba(220,228,245,0.92)';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(PLANES[plane], 8, 18);
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
  function drawContour(ctx, vals, G, w, h, maxV, n, l, m, mode, plane, uv2xyz, E, nodalPlane) {
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
          const u = -E + (2 * E * i) / (G - 1);
          const v = -E + (2 * E * j) / (G - 1);
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
    const G = 160;                 // 计算分辨率（离屏）
    const E = OM.rExtent(n, l) * 1.05;
    // 平面内坐标 (u,v) ∈ [-E,E] → 空间 (x,y,z)
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
        const u = -E + (2 * E * i) / (G - 1);
        const v = -E + (2 * E * j) / (G - 1);
        const [x, y, z] = uv2xyz(u, v);
        const r = Math.hypot(x, y, z);
        const th = r > 1e-9 ? Math.acos(Math.max(-1, Math.min(1, z / r))) : 0;
        const ph = Math.atan2(y, x);
        const dd = OM.psiDensity(n, l, m, r, th, ph, mode);
        vals[j * G + i] = dd;
        if (dd > maxV) maxV = dd;
        if (sectionMode === 'phase') {
          phases[j * G + i] = (mode === 'real')
            ? (OM.angularReal(l, m, th, ph) >= 0 ? 0 : Math.PI)
            : OM.angularComplex(l, m, th, ph).arg();
        }
      }
    }
    const nodalPlane = maxV < 1e-10;      // 该平面密度近似为 0 → 节点面
    if (maxV < 1e-12) maxV = 1e-12;

    if (sectionMode === 'contour') {
      drawContour(ctx, vals, G, w, h, maxV, n, l, m, mode, plane, uv2xyz, E, nodalPlane);
      drawSectionFrame(ctx, w, h, plane);
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

    drawSectionFrame(ctx, w, h, plane);
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

  return { drawRadial, drawAngular, drawSection, setRadialHighlight };
})();
