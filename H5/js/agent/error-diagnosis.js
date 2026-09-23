/**
 * error-diagnosis.js — 错因分类 → 可视化诊断动作
 *
 * 核心理念：**答错时不直接给答案**，而是把视图切换到"能揭示错误根源"的状态，
 * 让学生自己看出矛盾。这是本工具区别于通用问答模型的关键创新之一。
 *
 * 四级错因（对应实施计划 §6.3 的 E1–E4）：
 *   E1 概念混淆 / E2 公式误用 / E3 空间想象错误 / E4 计算失误
 */
window.ErrorDiagnosis = (function () {
  'use strict';

  /**
   * 诊断处方库：key 与 question-engine 的 diagnosticHint 对应。
   * 每条含：错因归类、诊断动作序列、引导话术、以及"不要做什么"。
   */
  const PRESCRIPTIONS = {
    'R-vs-D': {
      cause: 'E1 概念混淆',
      label: '混淆了「概率幅最大」与「概率最大」',
      actions: [
        // 同时画出 R 与 D，并标出各自的峰值位置——两条曲线峰值不同，一眼可见
        { action: 'showRadial', params: { which: ['R', 'D'] } },
        { action: 'highlightRadialFeature', params: { target: 'D', feature: 'peak' } },
        { action: 'linkRadialTo3D', params: { radius: '__PEAK__' } },
      ],
      speech: '先不急着说答案。我把 R(r) 和 D(r) 画在同一张图上了——' +
        '你看它们的峰顶是不是不在同一个位置？再想想：球壳的体积随半径怎么变？',
      avoid: '不要直接说出正确答案；不要一次给出全部解释。',
      followUp: '要不要我把这个半径对应的一层"球壳"在三维里标出来？',
    },

    'radial-nodes': {
      cause: 'E2 公式误用',
      label: '节点计数公式记错（径向 / 角 / 总数的混淆）',
      actions: [
        { action: 'setQuantumNumbers', params: { '__SELF__': true } },
        { action: 'setRenderMode', params: { mode: 'surface' } },
        { action: 'setIsosurfaceLevel', params: { fraction: 0.05 } },   // 降阈值显套娃
        { action: 'spotlightNodes', params: { type: 'radial', on: true } },
      ],
      speech: '我把等值面阈值降下来，你看这个"套娃"结构——每两层壳之间就是一层径向节点。' +
        '数一数有几层？对照公式 n−l−1 看看。',
      avoid: '不要只说"公式是 n−l−1"，要让学生**数出来**。',
      followUp: '那角节点呢？换个平面看看。',
    },

    'node-shape': {
      cause: 'E3 空间想象错误',
      label: '把角节面一律当成平面（忽略了锥面）',
      actions: [
        { action: 'setSectionMode', params: { mode: 'contour' } },
        { action: 'spotlightNodes', params: { type: 'angular', on: true } },
        { action: 'setAutoRotate', params: { on: true } },
      ],
      speech: '我打开等高线和角节面高亮。注意看节面的形状——它是平的一个面，' +
        '还是绕着 z 轴转出来的一圈？',
      avoid: '不要用"锥面"这个词直接提示，先让学生描述看到的形状。',
      followUp: '想想 P_l^{|m|}(cosθ)=0 解出来的 θ 是常数还是 φ 是常数？',
    },

    'psi-vs-psi2': {
      cause: 'E1 概念混淆',
      label: '把 |ψ| 与 |ψ|² 的百分比读数混为一谈',
      actions: [
        { action: 'setPsiCriterion', params: { criterion: 'psi2' } },
        { action: 'setIsosurfaceLevel', params: { fraction: 0.09 } },
        { action: 'setPsiCriterion', params: { criterion: 'psi' } },
      ],
      speech: '我先把判据切到 |ψ|²、阈值设成 9%，再切成 |ψ| 看看——' +
        '同一个曲面，两种读法。它们是什么关系？',
      avoid: '不要直接给出平方关系，让学生从两次读数自己推。',
      followUp: '所以同一读数下，按哪个判据得到的曲面更大？',
    },

    'complex-real': {
      cause: 'E1 概念混淆',
      label: '把实轨道与复轨道当成两种不同的物理',
      actions: [
        { action: 'setWavefunctionMode', params: { mode: 'complex' } },
        { action: 'setColorMode', params: { mode: 'phase' } },
        { action: 'setColorMode', params: { mode: 'orbital' } },
        { action: 'setWavefunctionMode', params: { mode: 'real' } },
      ],
      speech: '你看，切到复函数时密度是个环，切回实函数变成两个瓣。' +
        '但它们的**能量**变了吗？想想为什么能量不变，形状却变了。',
      avoid: '不要直接说"线性组合"，先让学生注意到能量没变这个事实。',
      followUp: '既然能量一样，它们的任意组合是不是也是合法状态？',
    },
  };

  /** 兜底处方：无法匹配到具体错因时使用通用流程 */
  const FALLBACK = {
    cause: 'E1 概念混淆',
    label: '需要进一步确认学生的推理路径',
    actions: [],
    speech: '先说说你是怎么想的？我想知道你推到哪一步觉得不对。',
    avoid: '在了解学生思路前不要给任何提示。',
    followUp: '',
  };

  /**
   * @returns {{ cause, label, actions, speech, avoid, followUp }}
   */
  function diagnose(questionId, chosenIndex, correctIndex, hintKey) {
    let q = null;
    if (window.QuestionEngine && window.QuestionEngine.get) q = window.QuestionEngine.get(questionId);

    // 优先用题目自带的 hint，其次由题目内容推断
    let key = hintKey || (q && q.diagnosticHint) || null;
    if (!key && q) {
      const s = (q.stem || '') + (q.explanation || '');
      if (/D\(r\)|概率最大|径向分布函数/.test(s)) key = 'R-vs-D';
      else if (/径向节点|角节点|总节点/.test(s)) key = 'radial-nodes';
      else if (/节面|锥面|平面/.test(s)) key = 'node-shape';
      else if (/\|ψ\|²|判据/.test(s)) key = 'psi-vs-psi2';
      else if (/复轨道|实轨道|组合/.test(s)) key = 'complex-real';
    }

    const rx = PRESCRIPTIONS[key] || FALLBACK;

    // 把占位参数替换成实际值
    const S = (window.OrbitApp && window.OrbitApp.getState()) || {};
    const actions = (rx.actions || []).map(function (a) {
      const params = Object.assign({}, a.params);
      if (params['__SELF__']) {
        delete params['__SELF__'];
        params.n = S.n; params.l = S.l; params.m = S.m;
      }
      if (params.radius === '__PEAK__' && window.OM && S.n != null) {
        const peaks = window.OM.radialPeaks(S.n, S.l);
        params.radius = peaks.length ? peaks[peaks.length - 1] : 1;
      }
      return { action: a.action, params: params };
    });

    return {
      questionId: questionId,
      cause: rx.cause,
      label: rx.label,
      actions: actions,
      speech: rx.speech,
      avoid: rx.avoid,
      followUp: rx.followUp,
      diagnosisKey: key || 'fallback',
      note: '请按 speech 的语气引导，并执行 actions；**不要直接说出正确答案**。',
    };
  }

  /** 供讲解节点参考：某知识点最容易犯的错 */
  function commonMistakes(kp) {
    const map = {
      K3: ['R-vs-D'],
      K5: ['radial-nodes', 'node-shape'],
      K6: ['complex-real'],
      K8: ['psi-vs-psi2'],
    };
    return (map[kp] || []).map(function (k) {
      return { key: k, cause: PRESCRIPTIONS[k].cause, label: PRESCRIPTIONS[k].label };
    });
  }

  return { diagnose, commonMistakes, PRESCRIPTIONS };
})();
