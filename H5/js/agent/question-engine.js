/**
 * question-engine.js — 双通道出题引擎 + 练习闭环
 *
 * 通道 A（优先，~70%）：**数据驱动题** —— 题干与选项由计算层确定性生成，
 *   答案来自 math.js，从结构上杜绝幻觉。
 * 通道 B（兜底，~30%）：**概念题** —— 由模板生成，需通过自校验。
 *
 * 自校验（生成后自动执行）：选项去重、唯一正确、干扰项确实错误、数值与计算层一致；
 * 不通过即丢弃重生成。
 *
 * ★ 判定（GRADING）**不经过 LLM**：答案在出题时就已由计算层确定，判定只是比较下标。
 *   模型的任何解释都不参与对错判定——这是防幻觉的又一处结构性保障。
 */
window.QuestionEngine = (function () {
  'use strict';

  const SUB = ['s', 'p', 'd', 'f', 'g', 'h'];
  const bank = Object.create(null);     // id → 题目
  const issued = [];                    // 本次会话已出的题 id
  let seq = 0;

  const OM = () => window.OM;
  const subOf = (n, l) => n + SUB[Math.min(l, SUB.length - 1)];
  const rnd = (a) => a[Math.floor(Math.random() * a.length)];

  // ---------------------------------------------------------------------------
  // 选项装配 + 自校验
  // ---------------------------------------------------------------------------
  function assemble(stem, correct, distractorPool, explanation, meta) {
    const opts = [];
    const seen = Object.create(null);
    const key = (v) => String(v);
    opts.push(correct); seen[key(correct)] = 1;

    for (let i = 0; i < distractorPool.length && opts.length < 4; i++) {
      const d = distractorPool[i];
      if (d == null) continue;
      if (seen[key(d)]) continue;          // 自校验：干扰项不得与任何已有选项重复
      opts.push(d); seen[key(d)] = 1;
    }
    if (opts.length < 4) return null;      // 自校验不通过 → 丢弃重生成

    // 洗牌并记录正确下标
    const order = opts.map((v, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
    const shuffled = order.map((i) => opts[i]);
    const answerIndex = order.indexOf(0);

    if (answerIndex < 0 || shuffled.length !== 4) return null;

    const id = 'q' + (++seq);
    const q = {
      id: id,
      kp: meta.kp,
      difficulty: meta.difficulty || 'core',
      stem: stem,
      options: shuffled,
      answerIndex: answerIndex,
      explanation: explanation,
      /** 答错时可据此把视图切到"暴露错误根源"的状态 */
      diagnosticHint: meta.diagnosticHint || null,
      presetView: meta.presetView || null,
      origin: meta.origin || 'A',
    };
    bank[id] = q;
    return q;
  }

  // ---------------------------------------------------------------------------
  // 通道 A：数据驱动题模板（答案全部来自计算层）
  // ---------------------------------------------------------------------------
  const BUILDERS = {
    /** 径向节点数 */
    radialNodes(pick) {
      const { n, l } = pick;
      const nd = OM().nodes(n, l);
      const stem = `对 **${subOf(n, l)}** 轨道，它有几个**径向节点**（球壳状节面）？`;
      return assemble(stem, nd.radial,
        [nd.angular, nd.total, nd.radial + 1, Math.max(0, nd.radial - 1)],
        `径向节点数 = n − l − 1 = ${n} − ${l} − 1 = **${nd.radial}**。\n` +
        `（同一 ${n} 层的角节点数是 ${nd.angular}，总节点数是 ${nd.total}——三者容易混。）`,
        { kp: 'K5', difficulty: 'core', diagnosticHint: 'radial-nodes',
          presetView: { n: n, l: l, m: 0, radial: ['D'], render: 'surface', level: 0.08 } });
    },

    /** 角节点数 */
    angularNodes(pick) {
      const { n, l } = pick;
      const nd = OM().nodes(n, l);
      const stem = `对 **${subOf(n, l)}** 轨道，它有几个**角节点**？`;
      return assemble(stem, nd.angular,
        [nd.radial, nd.total, nd.angular + 1, Math.max(0, nd.angular - 1)],
        `角节点数 = l = **${nd.angular}**。`,
        { kp: 'K5', difficulty: 'basic',
          presetView: { n: n, l: l, m: 0, sectionMode: 'contour' } });
    },

    /** 总节点数 */
    totalNodes(pick) {
      const { n, l } = pick;
      const nd = OM().nodes(n, l);
      const stem = `**${subOf(n, l)}** 轨道的**总节点数**是多少？`;
      return assemble(stem, nd.total,
        [nd.radial, nd.angular, nd.total + 1, n],
        `总节点数 = n − 1 = **${nd.total}**，**与 l 无关**。\n` +
        `这正是"同一层内 l 增大时，径向节点减少、角节点增多，总数不变"的来源。`,
        { kp: 'K5', difficulty: 'core' });
    },

    /** 能级 */
    energy(pick) {
      const n = pick.n;
      const E = OM().energy(n);
      const stem = `氢原子 **${n}s** 轨道的能量约为多少 eV？（E_n = −13.6/n²）`;
      return assemble(stem, E.toFixed(2) + ' eV',
        [OM().energy(n + 1).toFixed(2) + ' eV', OM().energy(Math.max(1, n - 1)).toFixed(2) + ' eV',
         (-13.6).toFixed(2) + ' eV'],
        `E_${n} = −13.6 / ${n}² = **${E.toFixed(2)} eV**。能量只依赖 n（氢原子）。`,
        { kp: 'K1', difficulty: 'basic' });
    },

    /** 简并度 */
    degeneracy(pick) {
      const n = pick.n;
      const d = OM().degeneracy(n);
      const stem = `第 **n = ${n}** 层共有多少个**轨道**（不计自旋）？`;
      return assemble(stem, d, [2 * n + 1, n, 2 * d, d - 1],
        `第 n 层的轨道数 = n² = **${d}**（含自旋则为 2n² = ${2 * d}）。`,
        { kp: 'K1', difficulty: 'basic' });
    },

    /** D(r) 峰值半径（函数辨析） */
    radialPeak(pick) {
      const { n, l } = pick;
      const peaks = OM().radialPeaks(n, l);
      const main = peaks[peaks.length - 1];
      const stem = `对 **${subOf(n, l)}** 轨道，电子出现**概率最大**的半径约为多少？（单位 a₀）`;
      return assemble(stem, main.toFixed(1) + ' a₀',
        [(n * n).toFixed(1) + ' a₀', (0).toFixed(1) + ' a₀', (peaks[0]).toFixed(1) + ' a₀', (main * 1.8).toFixed(1) + ' a₀'],
        `**注意**：要用径向分布函数 D(r) = r²R(r)² 求极值，其主峰在 **r ≈ ${main.toFixed(1)} a₀**。\n` +
        `若误用 R(r) 的峰值会得到 r=0（R 在原点最大），但那里球壳体积趋于零、概率反而最小——` +
        `这正是"概率幅最大 ≠ 概率最大"的经典陷阱。`,
        { kp: 'K3', difficulty: 'core', diagnosticHint: 'R-vs-D',
          presetView: { n: n, l: l, m: 0, radial: ['R', 'D'] } });
    },

    /** 1s 概率最大半径（特例，考点明确） */
    peak1s() {
      const peaks = OM().radialPeaks(1, 0);
      const stem = `对 **1s** 轨道，电子出现概率最大的半径是？（单位 a₀）`;
      return assemble(stem, '1.0 a₀', ['0（原子核处）', '0.5 a₀', '2.0 a₀', '无限远'],
        `1s 的 D(r) = r²R² 峰值在 **r = 1 a₀**。\n` +
        `常见的错选是「0」——因为 R(r) 确实在原点最大，但球壳体积 ∝ r²，` +
        `两者相乘后原点处为零。`,
        { kp: 'K3', difficulty: 'basic', diagnosticHint: 'R-vs-D',
          presetView: { n: 1, l: 0, m: 0, radial: ['R', 'D'] } });
    },

    /** 角节面几何（锥面 vs 平面） */
    angularGeometry(pick) {
      const { l, m } = pick;
      const a = OM().angularNodes(l, Math.abs(m), 'real');
      const nCones = a.cones.length, nPlanes = a.planes.length;
      const shape = (nCones && nPlanes) ? (nCones + ' 个锥面 + ' + nPlanes + ' 个平面')
        : (nCones ? nCones + ' 个锥面' : nPlanes + ' 个平面');
      const stem = `轨道 **${subOf(pick.n, l)}**（m=${m} 的实函数）的角节面是什么形状？`;
      return assemble(stem, shape,
        [nPlanes + ' 个锥面', nCones + ' 个平面', (nCones + nPlanes) + ' 个锥面', '没有角节面'],
        `由 math.js 计算：该轨道有 **${shape}**。\n` +
        `★ 常见误解是"角节面一律是平面"——但 P_l^{|m|}(cosθ)=0 给出的是**锥面**，` +
        `只有 cos(mφ)/sin(mφ)=0 才给出平面。`,
        { kp: 'K5', difficulty: 'challenge',
          presetView: { n: pick.n, l: l, m: m, sectionMode: 'contour' } });
    },

    /** R 与 D 的峰值位置辨析 */
    rVsD(pick) {
      const { n, l } = pick;
      const stem = `对 **${subOf(n, l)}** 轨道，下面哪句话是对的？`;
      return assemble(stem, 'R(r) 的最大值出现在 r = 0，但概率最大的半径不是 0',
        ['R(r) 与 D(r) 的峰值半径总是相同', 'D(r) 的最大值一定在 r = 0',
         '概率最大的半径与 n 无关'],
        `R(r) 在原点最大（对 l=0），但 D(r) = r²R² 含球壳体积因子 r²，` +
        `其峰值在 **r ≈ n²a₀**。\n★ "概率幅最大"与"概率最大"是两件事。`,
        { kp: 'K3', difficulty: 'core', diagnosticHint: 'R-vs-D',
          presetView: { n: n, l: l, m: 0, radial: ['R', 'D'] } });
    },

    /** |ψ| 与 |ψ|² 判据换算（双向出题，模板数翻倍） */
    psiVsPsi2() {
      const vals = [4, 9, 16, 25];                 // 取平方数，开方后答案干净
      const pct = vals[Math.floor(Math.random() * vals.length)];
      const root = Math.sqrt(pct / 100) * 100;
      if (Math.random() < 0.5) {
        // 正向：给 |ψ|²，问 |ψ|
        const stem = `等值面判据按 **|ψ|²** 计为 **${pct}%** 时，等价于按 **|ψ|** 计多少？`;
        return assemble(stem, root.toFixed(0) + '%',
          [(pct * 2).toFixed(0) + '%', (pct / 2).toFixed(0) + '%', (100 - pct).toFixed(0) + '%'],
          `|ψ| = c ⟺ |ψ|² = c²，所以 ${pct}% = (${root.toFixed(0)}%)²。\n` +
          `★ 二者是**同一族曲面**，切换判据只改变读数的含义，不改变形状族。`,
          { kp: 'K8', difficulty: 'core' });
      }
      // 反向：给 |ψ|，问 |ψ|²
      const stem = `等值面判据按 **|ψ|** 计为 **${root.toFixed(0)}%** 时，等价于按 **|ψ|²** 计多少？`;
      return assemble(stem, pct + '%',
        [(root * 2).toFixed(0) + '%', (100 - pct) + '%', (pct + 10) + '%'],
        `|ψ| = ${root.toFixed(0)}% ⟹ |ψ|² = (${root.toFixed(0)}%)² = **${pct}%**。\n` +
        `★ 同一读数下按 |ψ| 计算得到的绝对阈值更小，故曲面**更大**。`,
        { kp: 'K8', difficulty: 'core' });
    },

    /** 平均距离 ⟨r⟩（教材经典题型，解析式 + 已数值积分验证） */
    meanRadius(pick) {
      const { n, l } = pick;
      const OB = window.Observables;
      if (!OB) return null;
      const v = OB.meanR(n, l);
      const stem = `氢原子 **${subOf(n, l)}** 态电子离核的**平均距离 ⟨r⟩** 约为多少？（单位 a₀）`;
      const byR = v / 1.5, by2 = v * 1.5, byn2 = (n * n).toFixed(1) + ' a₀';
      return assemble(stem, v.toFixed(1) + ' a₀',
        [byR.toFixed(1) + ' a₀', by2.toFixed(1) + ' a₀', byn2, (0).toFixed(1) + ' a₀'],
        `⟨r⟩ = (a₀/2)[3n² − l(l+1)] = (1/2)[3×${n}² − ${l}×${l + 1}] = **${v.toFixed(1)} a₀**。\n` +
        `注意它比"概率最大半径"（≈n²a₀）小——因为 D(r) 的峰在远处，而 ⟨r⟩ 是对全空间加权的平均。`,
        { kp: 'K3', difficulty: 'challenge',
          presetView: { n: n, l: l, m: 0, radial: ['D'] } });
    },

    /** 角动量与 z 轴的夹角（教材经典题型） */
    angleToZ(pick) {
      const { n, l, m } = pick;
      if (l === 0) return null;                    // l=0 角动量为零，夹角无定义
      const OB = window.Observables;
      if (!OB) return null;
      const a = OB.angleToZ(l, m);
      const correct = a.deg.toFixed(1) + '°';
      const deg = (x) => (Math.acos(Math.max(-1, Math.min(1, x))) * 180 / Math.PI).toFixed(1) + '°';
      const stem = `**${subOf(n, l)}** 轨道（m=${m}）中，电子的轨道角动量矢量与 z 轴的夹角约为？`;
      return assemble(stem, correct,
        [deg(m / l), deg(l / (l + 1)), (180 - a.deg).toFixed(1) + '°', '90.0°'],
        `cosθ = m / √(l(l+1)) = ${m} / √(${l}×${l + 1}) ⇒ θ = **${correct}**。\n` +
        `★ 常见错误是用 cosθ = m/l（把 L_z/L 当成了 m/l），正确的分母是 √(l(l+1)) 而非 l。\n` +
        `特别地：m = ±l 时夹角最小但不为 0（角动量不可能与 z 轴重合）；m = 0 时夹角为 90°。`,
        { kp: 'K9', difficulty: 'challenge' });
    },

    /** 由节面数反推量子数（教材经典反推题） */
    nodesReverse() {
      const wantR = 1, wantA = 2;          // 题面给定：径向节面 1 个、角节面 2 个
      const stem = '某氢原子波函数有 **一个径向节面**、**两个角节面**。' +
        '不查表，它的主量子数 n 与角量子数 l 分别是？';
      const correct = `n = ${wantR + wantA + 1}，l = ${wantA}`;
      return assemble(stem, correct,
        [`n = ${wantR + wantA}，l = ${wantA}`,
         `n = ${wantA + 1}，l = ${wantR}`,
         `n = ${wantR + 1}，l = ${wantA}`,
         `n = ${wantR + wantA + 1}，l = ${wantA + 1}`],
        `径向节面数 = n − l − 1，角节面数 = l。\n` +
        `由角节面 2 个 ⇒ **l = 2**；代回 n − 2 − 1 = 1 ⇒ **n = 4**。\n` +
        `★ 所以该态是 **4d**。检验：总节点数 = n − 1 = 3，与 1 + 2 = 3 一致。`,
        { kp: 'K5', difficulty: 'challenge',
          presetView: { n: 4, l: 2, m: 0, sectionMode: 'contour', spotlight: 'radial' } });
    },

    /** 能量分解：动能/势能平均值（维里定理） */
    energySplit(pick) {
      const n = pick.n;
      const OB = window.Observables;
      if (!OB) return null;
      const e = OB.energyBreakdown(n);
      const stem = `氢原子 **${n}s** 态电子的**势能平均值 ⟨V⟩** 约为多少 eV？（维里定理）`;
      return assemble(stem, e.V.toFixed(1) + ' eV',
        [e.T.toFixed(1) + ' eV', e.E.toFixed(1) + ' eV', (e.V * 0.5).toFixed(1) + ' eV', (-13.6).toFixed(1) + ' eV'],
        `维里定理（库仑势）：2⟨T⟩ = −⟨V⟩，且 ⟨E⟩ = ⟨T⟩ + ⟨V⟩。\n` +
        `由 E_${n} = −13.6/${n}² = ${e.E.toFixed(2)} eV 得 **⟨V⟩ = 2⟨E⟩ = ${e.V.toFixed(1)} eV**、⟨T⟩ = ${e.T.toFixed(1)} eV。\n` +
        `★ 注意 ⟨V⟩ 是 ⟨E⟩ 的两倍（负得更多），而动能恰为 −⟨E⟩ > 0。`,
        { kp: 'K9', difficulty: 'challenge' });
    },


    complexSymmetry(pick) {
      const modes = [
        { q: '**复函数**下轨道的密度为什么绕 z 轴对称？', a: '因为 |e^{imφ}| = 1，相位因子取模后消失',
          w: ['因为电子在绕 z 轴旋转', '因为复函数的 l 更小', '因为复函数没有角节点'] },
      ];
      const t = modes[0];
      return assemble(t.q, t.a, t.w,
        `|Y_l^m|² = N²·P²·|e^{imφ}|² = N²·P²，与 φ 无关 → 绕 z 轴旋转对称。\n` +
        `实函数含 cos(mφ)/sin(mφ)，取模后仍依赖 φ → 呈定向的瓣。`,
        { kp: 'K6', difficulty: 'core' });
    },
  };

  // ---------------------------------------------------------------------------
  // 通道 B：概念题（模板 + 校验）
  // ---------------------------------------------------------------------------
  const CONCEPT = {
    K6: [
      {
        stem: '**p_x** 轨道可以由哪两个复轨道线性组合得到？',
        correct: 'm = +1 与 m = −1',
        wrong: ['m = 0 与 m = +1', 'm = 0 与 m = −1', 'm = +1 与 m = +1'],
        exp: '实轨道是复轨道的线性组合：p_x ∝ (Y_1^{−1} − Y_1^{+1})。\n' +
             '因为三者能量简并，组合态仍是合法的本征态。',
      },
      {
        stem: '为什么**复函数**的密度绕 z 轴对称，而实函数呈定向的瓣？',
        correct: '复函数含 e^{imφ}，取模后 |e^{imφ}| = 1，φ 消失了',
        wrong: ['复函数的电子在绕 z 轴旋转（经典图像）',
                '复函数的 l 更小', '复函数没有角节点'],
        exp: '|Y_l^m|² = N²P²·|e^{imφ}|² = N²P²，与 φ 无关 → 绕 z 轴旋转对称。\n' +
             '实函数含 cos(mφ)/sin(mφ)，取模后仍依赖 φ → 呈定向的瓣。',
      },
    ],
    K7: [
      {
        stem: '为什么说**相位**不是"多余的数学"？',
        correct: '相位决定波函数如何叠加：同相增强、反相抵消，是成键/反键的根源',
        wrong: ['相位只是计算中间量，没有物理意义',
                '相位对应电子的自旋方向',
                '相位只影响能量大小'],
        exp: '概率密度只用到 |ψ|²，但两个态叠加时 ψ = ψ₁ + ψ₂ 的干涉项依赖相对相位：\n' +
             '同相 → 增强（成键），反相 → 抵消（反键）。这是化学键的量子力学根源。',
      },
      {
        stem: '**实函数**轨道的正负两色瓣代表什么？',
        correct: '同一个波函数在不同区域取正号或负号（相位 0 或 π）',
        wrong: ['两个不同的电子云', '两个不同的轨道', '电子的自旋两种取向'],
        exp: '实函数的相位只有 0 与 π 两种，故表现为正负两色。\n' +
             '中间隔开的那个面就是节面——相位在那里翻转。\n' +
             '它不是"两个电子"，而是同一个波函数的不同符号区域。',
      },
      {
        stem: '复轨道 e^{imφ} 的相位绕 z 轴转一圈（φ: 0→2π）会怎样？',
        correct: '相位增加 2πm，即缠绕 m 圈',
        wrong: ['相位不变（因为 |e^{imφ}|=1）', '相位增加 2π，与 m 无关', '相位增加 πm'],
        exp: 'arg = mφ，φ 走完 2π 时 arg 增加 2πm。\n' +
             '★ 用相位着色可以直接看到：m=1 绕一圈彩虹走一周，m=2 走两周。',
      },
      {
        stem: '为什么只用 |ψ|² 讲不清"化学键为什么形成"？',
        correct: '因为成键与否取决于相位关系，|ψ|² 把相位信息丢掉了',
        wrong: ['因为 |ψ|² 计算太复杂', '因为 |ψ|² 只适用于 s 轨道', '因为 |ψ|² 不是可观测量'],
        exp: '|ψ|² 是可观测的概率密度，但它**丢掉了相位**。\n' +
             '两个原子轨道靠近时，同相叠加使中间区域电子密度增大（成键），' +
             '反相叠加使中间出现节面（反键）——这个差别完全来自相位。',
      },
    ],
    K9: [
      {
        stem: '**2ψ_{3dz²} + 3ψ_{3dxy}** 这个叠加态是定态吗？',
        correct: '是定态——两个分量能量简并',
        wrong: ['不是定态——叠加态都会随时间变化',
                '不是定态——因为系数不相等',
                '无法判断'],
        exp: '两个分量同属 n=3、l=2，**能量简并**。整体时间因子 e^{−iEt/ħ} 可提到求和号外，\n' +
             '取模后消失 → 密度**不随时间变化**，故仍是定态。\n' +
             '★ 只有**不同能量**的态叠加才是非定态。',
      },
      {
        stem: '对叠加态 ψ = Σcᵢψᵢ，测得力学量 L_z 取值为 ħm 的概率是？',
        correct: '所有 mᵢ = m 的分量的 |cᵢ|² 之和',
        wrong: ['|cᵢ|² 的最大值', 'Σ|cᵢ|²  (恒为 1)', 'cᵢ 本身'],
        exp: '测量假设：测得本征值 a 的概率 = 对应本征态系数模方之和 P(a) = Σ_{aᵢ=a}|cᵢ|²。\n' +
             '期望值则是 ⟨Â⟩ = Σ|cᵢ|²aᵢ。',
      },
      {
        stem: '**sp³** 杂化轨道由哪些原子轨道组合而成？',
        correct: '一个 s 与三个 p（p_x, p_y, p_z）',
        wrong: ['一个 s 与两个 p', '两个 s 与两个 p', '三个 s 与一个 p'],
        exp: 'sp³ = ½(s + p_x + p_y + p_z)，共 4 个等价杂化轨道，指向正四面体，夹角 109.5°。\n' +
             '★ 杂化轨道是**叠加态的特例**，系数由对称性唯一确定。',
      },
    ],
  };

  // ---------------------------------------------------------------------------
  // 选点：为数据驱动题挑一组合适的量子数
  // ---------------------------------------------------------------------------
  function pickOrbital(kp) {
    const S = (window.OrbitApp && window.OrbitApp.getState()) || { n: 3, l: 1, m: 0 };
    const cur = { n: S.n, l: S.l, m: S.m };
    switch (kp) {
      case 'K1': return { n: rnd([2, 3, 4]), l: 0 };
      case 'K3': return rnd([{ n: 1, l: 0 }, { n: 2, l: 0 }, { n: 3, l: 0 }, { n: 2, l: 1 }, cur]);
      case 'K5': return rnd([{ n: 3, l: 0 }, { n: 3, l: 1 }, { n: 3, l: 2 }, { n: 4, l: 2 }, { n: 5, l: 2 }, cur]);
      case 'K8': return cur;
      default: return cur;
    }
  }

  // ---------------------------------------------------------------------------
  // 对外：出题
  // ---------------------------------------------------------------------------
  /**
   * 按知识点构造一道题（不做去重）。
   * 返回 null 表示模板未能产出合法题目，交由调用方重试。
   */
  function buildOnce(kp, difficulty) {
    const pick = pickOrbital(kp);
    switch (kp) {
      case 'K1':
        return (Math.random() < 0.5 ? BUILDERS.energy(pick) : BUILDERS.degeneracy(pick));
      case 'K3':
        if (pick.n === 1 && pick.l === 0) return BUILDERS.peak1s();
        {
          const r = Math.random();
          if (r < 0.35) return BUILDERS.radialPeak(pick);
          if (r < 0.55) return BUILDERS.meanRadius(pick);      // ⟨r⟩：教材经典题型
          return BUILDERS.rVsD(pick);
        }
      case 'K5': {
        const r = Math.random();
        if (r < 0.2) return BUILDERS.nodesReverse();           // 由节面数反推 n、l
        return ([BUILDERS.radialNodes, BUILDERS.angularNodes, BUILDERS.totalNodes][Math.floor(Math.random() * 3)])(pick)
          || BUILDERS.angularGeometry({ n: 3, l: 2, m: rnd([0, 1, 2]) });
      }
      case 'K8':
        return BUILDERS.psiVsPsi2();
      case 'K9': {
        // 力学量数据题（答案完全来自 Observables 的解析式，零幻觉）
        if (Math.random() < 0.6) {
          const q = Math.random() < 0.5
            ? BUILDERS.energySplit({ n: rnd([1, 2, 3]) })
            : BUILDERS.angleToZ({ n: rnd([3, 4]), l: 2, m: rnd([-2, -1, 0, 1, 2]) });
          if (q) return q;
        }
        const t9 = rnd(CONCEPT.K9);
        const q9 = assemble(t9.stem, t9.correct, t9.wrong, t9.exp,
          { kp: 'K9', difficulty: difficulty || 'core', origin: 'B' });
        if (q9) q9.presetView = { advanced: true };
        return q9;
      }
      case 'K6': case 'K7': {
        const list = CONCEPT[kp] || CONCEPT.K6;
        const t = rnd(list);
        return assemble(t.stem, t.correct, t.wrong, t.exp,
          { kp: kp, difficulty: difficulty || 'core', origin: 'B' });
      }
      default: {
        const pool = [BUILDERS.radialNodes, BUILDERS.angularNodes, BUILDERS.totalNodes, BUILDERS.radialPeak];
        return rnd(pool)(pick);
      }
    }
  }

  function generate(kp, difficulty, exclude) {
    // 去重只与**最近若干题**比较：概念题模板池有限，若与整个会话比较，
    // 出到第 5、6 题时会因"必然全部碰撞"而彻底无法出题。
    const avoid = (exclude || []).concat(issued.slice(-2));

    for (let i = 0; i < 14; i++) {
      const q = buildOnce(kp, difficulty);
      // 自校验：四选项、答案下标合法、题干不与最近出的重复
      if (!q || !q.options || q.options.length !== 4) continue;
      if (!(q.answerIndex >= 0 && q.answerIndex < 4)) continue;
      if (avoid.some((id) => bank[id] && bank[id].stem === q.stem)) continue;
      issued.push(q.id);
      return q;
    }

    // ★ 兜底：严格去重全部失败时，放开去重再试——
    //   宁可偶尔重复，也不能出现"出不了题"把教学流程卡死的情况。
    for (let k = 0; k < 6; k++) {
      const q2 = buildOnce(kp, difficulty);
      if (q2 && q2.options && q2.options.length === 4 && q2.answerIndex >= 0) {
        q2.duplicated = true;
        issued.push(q2.id);
        return q2;
      }
    }
    return { error: '出题失败：题目模板不可用（知识点 ' + kp + '）' };
  }

  /** 变式题：同知识点，变动一个维度 */
  function variant(questionId) {
    const q = bank[questionId];
    if (!q) return { error: '找不到原题：' + questionId };
    const kp = q.kp;
    // 优先换量子数 / 换问法
    for (let i = 0; i < 8; i++) {
      const nq = generate(kp, q.difficulty, [questionId]);
      if (nq && !nq.error && nq.stem !== q.stem) {
        nq.isVariant = true;
        nq.fromQuestion = questionId;
        return nq;
      }
    }
    return { error: '未能生成变式题' };
  }


  function get(id) { return bank[id] || null; }

  // ---------------------------------------------------------------------------
  // 讲解
  // ---------------------------------------------------------------------------
  function explain(kp, opts) {
    const K = window.Knowledge;
    const entries = K ? K.byKnowledgePoint(kp) : [];
    const meta = window.MasteryModel ? window.MasteryModel.meta(kp) : null;
    return {
      knowledgePoint: kp,
      name: meta ? meta.name : kp,
      entries: entries.map((e) => ({ id: e.id, title: e.title, body: e.body, source: e.source,
        misconceptions: e.misconceptions })),
      presetView: opts && opts.presetView ? opts.presetView : (meta && meta.orbital ? meta.orbital[0] : null),
      tip: '讲解时请按条目顺序组织，并配套 applySceneActions 把关键结论"演示"出来，而不是只念文字。',
    };
  }

  // ---------------------------------------------------------------------------
  // 费曼复述评估（离线规则初筛，供模型参考）
  // ---------------------------------------------------------------------------
  const FEYNMAN_KEYS = {
    K3: [['r²', 'r方', '体积', '球壳'], ['峰值', '最大'], ['密度', '概率']],
    K5: [['节点', '节面'], ['径向', '角'], ['n', 'l']],
    K6: [['简并', '能量相同', '同能量'], ['组合', '叠加', '线性'], ['φ', 'phi', '相位', '轴对称']],
    K7: [['相位', '符号'], ['叠加', '干涉'], ['成键', '反键', '增强', '抵消']],
    K9: [['简并', '能量相同'], ['定态', '不随时间', '随时间'], ['系数', '模方', '概率']],
  };

  function evaluateFeynman(kp, transcript) {
    const t = String(transcript || '');
    const keys = FEYNMAN_KEYS[kp] || [];
    const groups = keys.map((g) => ({ hit: g.some((k) => t.indexOf(k) >= 0), keys: g }));
    const hitCount = groups.filter((g) => g.hit).length;
    const missing = keys.filter((g, i) => !groups[i].hit).map((g) => g[0]);
    const verdict = hitCount >= keys.length ? 'complete'
      : (hitCount >= Math.ceil(keys.length / 2) ? 'partial' : 'insufficient');
    return {
      knowledgePoint: kp,
      verdict: verdict,
      coveredGroups: hitCount,
      totalGroups: keys.length,
      missingKeywords: missing,
      suggestedMasteryDelta: verdict === 'complete' ? 2 : (verdict === 'partial' ? 1 : 0),
      note: verdict === 'complete'
        ? '复述覆盖了全部关键概念，可判定掌握。'
        : '复述缺少部分关键概念，请针对缺失项追问（不要直接说出答案）。',
    };
  }

  // ---------------------------------------------------------------------------
  // 练习闭环 UI（状态机由 panel/主干驱动）
  // ---------------------------------------------------------------------------
  const flow = { active: false, kp: null, current: null, stage: 'idle' };

  function startFlow(kp) {
    flow.active = true;
    flow.kp = kp || null;
    if (!kp) return pickKnowledgePoint();
    return launch(kp);
  }

  function pickKnowledgePoint() {
    const P = window.Panel;
    const list = window.MasteryModel ? window.MasteryModel.allKnowledgePoints() : ['K1', 'K3', 'K5', 'K6', 'K7', 'K8', 'K9'];
    let html = '<b>选择要练习的知识点：</b><div class="agent-picker">';
    list.forEach((k) => {
      const m = window.MasteryModel.meta(k);
      const s = window.MasteryModel.summary()[k];
      const tag = s.mastered ? '已掌握' : (s.wrong ? '待巩固' : '');
      html += '<button class="agent-pick-btn" data-kp="' + k + '">' + k + ' · ' + m.name +
        (tag ? '<span class="agent-pick-tag">' + tag + '</span>' : '') + '</button>';
    });
    html += '</div>';
    P.addMsg(html, 'assistant');
    const last = P.addMsg;   // 绑定点击
    document.querySelectorAll('.agent-pick-btn').forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll('.agent-pick-btn').forEach((x) => { x.disabled = true; });
        launch(b.getAttribute('data-kp'));
      };
    });
    return { ok: true, awaiting: 'knowledgePoint' };
  }

  /** 进入某知识点的讲解（走 LLM 的讲解节点），结束后给出"出题"入口 */
  async function launch(kp) {
    flow.kp = kp;
    flow.active = true;
    const meta = window.MasteryModel.meta(kp);
    await window.Panel.runAgent(
      '请讲解知识点 ' + kp + '（' + meta.name + '）。先用 explainConcept 取讲解稿，' +
      '再按讲解稿用 applySceneActions 把关键结论**演示**出来（不要只念文字）。' +
      '控制在 300 字以内，最后用一句话总结。'
    );

    // 讲解结束 → 给出出题入口（闭环的下一步）
    const P = window.Panel;
    const card = P.addMsg('<button class="agent-btn primary agent-go-quiz">我懂了，出题吧 →</button>', 'assistant');
    const btn = card.querySelector('.agent-go-quiz');
    if (btn) btn.onclick = function () { btn.disabled = true; btn.textContent = '出题中…'; askQuestion(); };
    return { ok: true, kp: kp };
  }

  /** 出题并渲染题目卡（判定完全本地） */
  function askQuestion() {
    const q = generate(flow.kp || 'K5');
    renderQuestion(q);
    return q;
  }

  /** 渲染题目卡（判定完全本地，不经 LLM） */
  function renderQuestion(q) {
    if (!q || q.error) { window.Panel.addMsg('<span class="agent-err">' + (q && q.error) + '</span>', 'assistant'); return; }
    flow.current = q;
    const P = window.Panel;
    let html = '<div class="agent-q"><div class="agent-q-kp">' + q.kp + ' · 难度 ' + q.difficulty + '</div>' +
      '<div class="agent-q-stem">' + P.renderRich(q.stem) + '</div><div class="agent-opts">';
    q.options.forEach((o, i) => {
      html += '<button class="agent-opt" data-i="' + i + '">' +
        String.fromCharCode(65 + i) + '. ' + P.renderRich(String(o)) + '</button>';
    });
    html += '</div></div>';
    P.addMsg(html, 'assistant');
    const card = document.querySelector('.agent-msg.assistant:last-of-type');
    card.querySelectorAll('.agent-opt').forEach((b) => {
      b.onclick = () => answer(q.id, +b.getAttribute('data-i'), card);
    });
  }

  /** 判定 —— 纯本地比较，不经过 LLM */
  function answer(questionId, chosenIndex, cardEl) {
    const q = bank[questionId];
    if (!q) return { error: '题目不存在' };
    const correct = (chosenIndex === q.answerIndex);
    // 标记选项
    if (cardEl) {
      cardEl.querySelectorAll('.agent-opt').forEach((b) => {
        const i = +b.getAttribute('data-i');
        b.disabled = true;
        if (i === q.answerIndex) b.classList.add('right');
        if (i === chosenIndex && !correct) b.classList.add('wrong');
      });
    }
    // 掌握度
    if (window.MasteryModel) window.MasteryModel.update(q.kp, correct ? 1 : -1);

    const P = window.Panel;
    let fb = '<div class="agent-fb ' + (correct ? 'ok' : 'bad') + '">' +
      '<b>' + (correct ? '✓ 答对了' : '✗ 不对') + '</b>' +
      '<div class="agent-fb-exp">' + P.renderRich(q.explanation) + '</div>';
    if (q.presetView) {
      fb += '<button class="agent-btn agent-goto" data-qid="' + q.id + '">去看结构 →</button>';
    }
    fb += '</div>';
    P.addMsg(fb, 'assistant');
    const fbEl = document.querySelector('.agent-msg.assistant:last-of-type .agent-goto');
    if (fbEl) fbEl.onclick = () => gotoStructure(q);

    // 答错 → 触发诊断节点（走 LLM，让它组织引导语并执行诊断动作）
    if (!correct) {
      P.runAgent('学生答错了这道题（questionId=' + q.id + '，他选了第 ' + chosenIndex +
        ' 项，正确是第 ' + q.answerIndex + ' 项）。请调用 diagnoseError 取得错因与诊断动作，' +
        '**不要直接说出正确答案**，而是把视图切到能揭示错误根源的状态并引导学生自己看出来。');
    } else {
      P.runAgent('学生答对了这道题（questionId=' + q.id + '）。请先调用 startFeynmanCheck 邀请他用自己的话复述，' +
        '以把"识别性掌握"推进到"生成性掌握"。');
    }
    return { correct: correct, answerIndex: q.answerIndex };
  }

  /** 「去看结构」：一键溯源，且观察状态已预置 */
  function gotoStructure(q) {
    if (!q.presetView) return;
    const p = q.presetView;
    const actions = [];
    const qn = {};
    if (p.n != null) qn.n = p.n;
    if (p.l != null) qn.l = p.l;
    if (p.m != null) qn.m = p.m;
    if (Object.keys(qn).length) actions.push({ action: 'setQuantumNumbers', params: qn });
    if (p.render) actions.push({ action: 'setRenderMode', params: { mode: p.render } });
    if (p.level) actions.push({ action: 'setIsosurfaceLevel', params: { fraction: p.level } });
    if (p.radial) actions.push({ action: 'showRadial', params: { which: p.radial } });
    if (p.sectionMode) actions.push({ action: 'setSectionMode', params: { mode: p.sectionMode } });
    window.SceneBridge.applySequence(actions);
    window.Panel.addChip('已切换到对应结构（观察状态已预置）');
  }

  function next() { return generate(flow.kp || 'K5'); }

  return {
    generate, variant, get, explain, evaluateFeynman,
    startFlow, launch, askQuestion, renderQuestion, answer, gotoStructure, next,
    flow: flow,
    _bank: bank,
  };
})();
