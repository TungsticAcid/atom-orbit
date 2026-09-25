/**
 * tool-registry.js — 工具注册表（两层设计）
 *
 * 第一层（本文件暴露给模型）：语义清晰的少量工具，覆盖"查 / 演 / 教 / 评"四类。
 * 第二层（动作词汇表）：~20 个操控动作经 applySceneActions 统一提交，
 *   由 scene-bridge 校验执行。模型在需要时用 listSceneActions 拉取词汇表，
 *   **不必常驻上下文**——这是 token 效率与选择准确率的关键。
 *
 * ⚠️ 防幻觉的结构性保障：
 *   所有数值型查询（节点数、峰值半径、能量…）一律由 math.js 确定性计算，
 *   模型**不得口算**。工具返回的是"事实"，模型只负责组织语言。
 *   若某依赖模块未就绪，工具返回明确的不可用信息，而不是编造结果。
 */
window.ToolRegistry = (function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 工具定义（OpenAI function-calling 格式）
  // ---------------------------------------------------------------------------
  const TOOLS = [
    {
      type: 'function',
      function: {
        name: 'getSnapshot',
        description: '获取当前视图状态的完整快照，包括量子数、模式、图表设置、相机，以及【交互痕迹】（用户停留时长、切换次数、最近动作）。在需要了解"用户此刻在看什么、刚才做了什么"时必须先调用它。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'queryOrbital',
        description: '查询轨道的确定性事实（数值一律由程序计算，不得自行口算）。kind 取值：nodes=节点数；radialZeros=径向节点半径；radialPeaks=径向分布峰值半径；angularNodes=角节面几何；energy=能级(eV)；degeneracy=简并度；normalization=归一化系数；shape=形状描述；compare=两个轨道对比。',
        parameters: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['nodes', 'radialZeros', 'radialPeaks', 'angularNodes', 'energy', 'degeneracy', 'normalization', 'shape', 'compare', 'observables', 'meanR', 'angleToZ', 'energySplit'] },
            n: { type: 'integer', description: '主量子数 1-6' },
            l: { type: 'integer', description: '角量子数 0..n-1' },
            m: { type: 'integer', description: '磁量子数 -l..l' },
            mode: { type: 'string', enum: ['real', 'complex'], description: '波函数形式，默认 real' },
            a: { type: 'object', description: 'kind=compare 时的第一个轨道 {n,l,m}' },
            b: { type: 'object', description: 'kind=compare 时的第二个轨道 {n,l,m}' },
          },
          required: ['kind'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'listSceneActions',
        description: '列出可以施加到三维视图上的全部受控动作（名称、参数、绑定知识点）。在需要改变视图前调用一次即可，不必每轮都调用。',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'applySceneActions',
        description: '★ 对视图施加一组受控动作（这是你唯一的"手"）。每个动作绑定一个知识点，使演示本身成为教学行为。'
          + '动作会**排成分镜队列逐步播放**：第一步立刻执行，之后停下等学生点「下一步」确认'
          + '（学生也可以选「连续播放」）。因此本工具**立即返回受理回执，不会等演示播完**——'
          + '返回里没有 executed 是正常的，别以为失败了。'
          + '请把每次的步数控制在 4–8 个；需要更长的流程就分几次调用，后续动作会自动接到队尾。',
        parameters: {
          type: 'object',
          properties: {
            actions: {
              type: 'array',
              description: '动作序列，最多 12 个（建议 4–8 个）',
              items: {
                type: 'object',
                properties: {
                  action: { type: 'string', description: '动作名，见 listSceneActions' },
                  params: { type: 'object', description: '动作参数' },
                  speech: { type: 'string', description: '★ 该步的教学旁白（强烈建议每步都写）。播放到这一步时会显示在视图上方，是学生理解"这一步在干什么"的唯一线索，也是学生判断该不该点「下一步」的依据。' },
                  holdMs: { type: 'integer', description: '仅"连续播放"模式下生效：该步的停留时长（毫秒，350–5000）。默认 1200；需要多看一会儿的对比步可调大。' },
                },
                required: ['action'],
              },
            },
          },
          required: ['actions'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'loadKnowledge',
        description: '按 id 加载知识库条目的正文（学科事实、常见误解、教材出处）。系统提示中只列出了条目清单，需要用到某条时才加载它——避免上下文被正文挤占。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: '知识条目 id，如 K3-1' } },
          required: ['id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'loadSkill',
        description: '按名称加载教学技能的完整步骤（如费曼学习法、苏格拉底追问）。系统提示中只有技能清单与一句话说明，需要执行某个教学法时再加载其详细步骤。',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '技能名，如 feynman' } },
          required: ['name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'explainConcept',
        description: '获取某个知识点的标准讲解稿与配套动作建议（讲解稿已经过人工复核）。',
        parameters: {
          type: 'object',
          properties: {
            knowledgePoint: { type: 'string', description: '知识点编号，如 K3' },
            n: { type: 'integer' }, l: { type: 'integer' }, m: { type: 'integer' },
          },
          required: ['knowledgePoint'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'generateQuestion',
        description: '出一道题。数据驱动题的答案由程序计算（零幻觉）；概念题会经三重校验。返回题干、四个选项、答案索引与解析。',
        parameters: {
          type: 'object',
          properties: {
            knowledgePoint: { type: 'string', description: '知识点编号 K1-K9' },
            difficulty: { type: 'string', enum: ['basic', 'core', 'challenge'] },
            exclude: { type: 'array', items: { type: 'string' }, description: '本次会话已出过的题目 id，避免重复' },
          },
          required: ['knowledgePoint'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'diagnoseError',
        description: '学生答错后，给出错因分类与该错误的"可视化诊断动作"——即把视图切换到能揭示错误根源的状态。答错时不要直接给答案，先调用它。',
        parameters: {
          type: 'object',
          properties: {
            questionId: { type: 'string' },
            chosenIndex: { type: 'integer', description: '学生所选选项的下标' },
            correctIndex: { type: 'integer' },
          },
          required: ['questionId', 'chosenIndex'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'generateVariant',
        description: '基于刚做过的题生成变式题（同知识点、换一个维度）。',
        parameters: {
          type: 'object',
          properties: { questionId: { type: 'string' } },
          required: ['questionId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'startFeynmanCheck',
        description: '发起费曼式复述：邀请学生用自己的话解释某个概念，以把"识别性掌握"推进到"生成性掌握"。',
        parameters: {
          type: 'object',
          properties: { knowledgePoint: { type: 'string' } },
          required: ['knowledgePoint'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'evaluateFeynman',
        description: '评估学生的复述，指出概念漏洞并给出对应的观察动作。',
        parameters: {
          type: 'object',
          properties: {
            knowledgePoint: { type: 'string' },
            transcript: { type: 'string', description: '学生的复述原文' },
          },
          required: ['knowledgePoint', 'transcript'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'updateMastery',
        description: '更新某知识点的掌握度（答对 +1、答错 −1、复述通过 +2）。',
        parameters: {
          type: 'object',
          properties: {
            knowledgePoint: { type: 'string' },
            delta: { type: 'number' },
          },
          required: ['knowledgePoint', 'delta'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'recommendNext',
        description: '根据掌握度与知识点—轨道映射矩阵，推荐下一个该学的知识点。',
        parameters: {
          type: 'object',
          properties: { count: { type: 'integer', description: '推荐个数，默认 1' } },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'reviseDemo',
        description: '修订**某一条**演示：改某一步 / 在某步后插入 / 删除某步 / 跳回某步。'
          + '★ 当学生说"刚才那个演示第 3 步不对、换个说法、阈值太高了"时用它 —— '
          + '**不要**用 applySceneActions 把整条演示重发一遍：重发会开一条**新**演示，'
          + '学生已经看过、确认过的其他步骤会全部丢掉。'
          + '★ 可以修订**已经播完**的演示（这是最常见的场景）：整改后程序会按整改后的'
          + '**完整步骤**重播、并快进到被改的那一步停下，所以其他步骤一个都不会少；'
          + '回执里的 steps 就是整改后的完整清单，用它核对。'
          + 'demo_id 与步号取自 getSnapshot 的「演示」一行；学生在动作气泡上点「引用」时，'
          + '输入框里写的「演示 #N 的第 M 步」正是这两个参数（N → demo_id，M-1 → index）。',
        parameters: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['replace', 'insert', 'remove', 'jump'],
              description: 'replace=替换某步 / insert=在该步之后插入 / remove=删除该步 / jump=回到该步（仅当这条演示正在播放时可用）',
            },
            demo_id: {
              type: 'integer',
              description: '要改的演示编号（见 getSnapshot 的「演示」一行）。省略则改当前这条演示。',
            },
            index: { type: 'integer', description: '步号，从 0 开始（见 steps 里的 i）' },
            step: {
              type: 'object',
              description: 'op 为 replace / insert 时必填：新的那一步',
              properties: {
                action: { type: 'string', description: '动作名，见 listSceneActions' },
                params: { type: 'object', description: '动作参数' },
                speech: { type: 'string', description: '该步的教学旁白（强烈建议写）' },
              },
              required: ['action'],
            },
          },
          required: ['op', 'index'],
        },
      },
    },
  ];

  // ---------------------------------------------------------------------------
  // 工具执行
  // ---------------------------------------------------------------------------
  const M = () => window.OM;
  const need = (mod, name) => {
    if (!window[mod]) return { error: '能力尚未就绪：' + name + '（模块 ' + mod + ' 未加载）' };
    return null;
  };

  const EXEC = {
    // ---- 感知 ----
    getSnapshot() {
      const e = need('Perception', '感知快照');
      if (e) return e;
      const snap = window.Perception.snapshot({ mastery: window.MasteryModel ? window.MasteryModel.summary() : undefined });
      // ★ 带上演示播放状态：动作是"等学生点下一步"的，模型必须知道自己上次下发的
      //   分镜走到哪一步了，否则会以为没生效而重复下发同一组动作。
      if (window.SceneBridge && window.SceneBridge.state) snap.演示播放 = window.SceneBridge.state();
      return { snapshot: snap };
    },

    // ---- 确定性查询（防幻觉核心）----
    queryOrbital(p) {
      const OM = M();
      const n = p.n, l = p.l, m = p.m;
      const mode = p.mode || 'real';
      const chk = (needN, needL) => (n == null || l == null);
      switch (p.kind) {
        case 'nodes':
          if (chk()) return { error: '需要 n 与 l' };
          return Object.assign(OM.nodes(n, l), {
            note: '径向节点 = n-l-1，角节点 = l，总数 = n-1（全部由程序计算）',
          });
        case 'radialZeros':
          if (chk()) return { error: '需要 n 与 l' };
          return { radii: OM.radialZeros(n, l), unit: 'a0', count: OM.radialZeros(n, l).length };
        case 'radialPeaks':
          if (chk()) return { error: '需要 n 与 l' };
          return { radii: OM.radialPeaks(n, l), unit: 'a0', note: 'D(r)=r²R² 的局部极大（可能有多个）' };
        case 'angularNodes': {
          if (chk()) return { error: '需要 n 与 l' };
          const a = OM.angularNodes(l, Math.abs(m == null ? 0 : m), mode);
          return {
            conesDeg: a.cones.map((t) => +(t * 180 / Math.PI).toFixed(2)),
            planesDeg: a.planes.map((t) => +(t * 180 / Math.PI).toFixed(2)),
            note: 'cones 为以 z 轴为轴的锥面（给出半顶角）；planes 为过 z 轴的平面（给出方位角）',
          };
        }
        case 'energy':
          if (n == null) return { error: '需要 n' };
          return { eV: +OM.energy(n).toFixed(4), formula: 'E_n = -13.6/n² eV' };
        case 'degeneracy':
          if (n == null) return { error: '需要 n' };
          return { withoutSpin: OM.degeneracy(n), withSpin: 2 * OM.degeneracy(n) };
        case 'normalization':
          if (chk()) return { error: '需要 n 与 l' };
          return { note: '归一化系数由 formula.js 计算并已显示在公式区', Nrad: null };
        case 'shape':
          if (chk() || m == null) return { error: '需要 n、l、m' };
          return OM.shapeDescribe(l, m, mode);

        // ---- 力学量（全部解析式，见 observables.js）----
        case 'observables': {
          if (chk() || m == null) return { error: '需要 n、l、m' };
          const OB = window.Observables;
          if (!OB) return { error: '力学量模块未加载' };
          return Object.assign({ note: '全部由解析式给出（长度单位 a₀，角动量单位 ħ）' }, OB.report(n, l, m));
        }
        case 'meanR': {
          if (chk()) return { error: '需要 n 与 l' };
          const OB = window.Observables;
          if (!OB) return { error: '力学量模块未加载' };
          return {
            meanR: +OB.meanR(n, l).toFixed(4),
            meanInvR: +OB.meanInvR(n).toFixed(4),
            meanR2: +OB.meanR2(n, l).toFixed(4),
            deltaR: +OB.deltaR(n, l).toFixed(4),
            unit: 'a₀',
            formula: '⟨r⟩ = (a₀/2)[3n² − l(l+1)]；⟨1/r⟩ = 1/(n²a₀)（与 l 无关）',
            note: '⟨r⟩ 是对全空间加权的平均距离，比"概率最大半径"(≈n²a₀) 小',
          };
        }
        case 'energySplit': {
          if (n == null) return { error: '需要 n' };
          const OB = window.Observables;
          if (!OB) return { error: '力学量模块未加载' };
          return Object.assign({ unit: 'eV' }, OB.energyBreakdown(n));
        }
        case 'angleToZ': {
          if (l == null || m == null) return { error: '需要 l 与 m' };
          const OB = window.Observables;
          if (!OB) return { error: '力学量模块未加载' };
          const a = OB.angleToZ(l, m);
          if (!a.defined) return { defined: false, note: a.note };
          return {
            cosTheta: +a.cos.toFixed(6),
            thetaDeg: +a.deg.toFixed(3),
            formula: 'cosθ = m / √(l(l+1))',
            note: '常见错误是用 cosθ = m/l（分母应为 √(l(l+1))）',
          };
        }
        case 'compare': {
          if (!p.a || !p.b) return { error: '需要 a 与 b 两个轨道对象' };
          const A = p.a, B = p.b;
          const na = OM.nodes(A.n, A.l), nb = OM.nodes(B.n, B.l);
          return {
            a: { n: A.n, l: A.l, m: A.m, nodes: na, energy: +OM.energy(A.n).toFixed(4) },
            b: { n: B.n, l: B.l, m: B.m, nodes: nb, energy: +OM.energy(B.n).toFixed(4) },
            diff: {
              radialNodes: na.radial - nb.radial,
              angularNodes: na.angular - nb.angular,
              energy_eV: +(OM.energy(A.n) - OM.energy(B.n)).toFixed(4),
            },
          };
        }
        default:
          return { error: '未知 kind：' + p.kind };
      }
    },

    // ---- 动作 ----
    listSceneActions() {
      const e = need('SceneBridge', '受控动作');
      if (e) return e;
      return { actions: window.SceneBridge.listActions() };
    },

    async applySceneActions(p) {
      const e = need('SceneBridge', '受控动作');
      if (e) return e;
      const r = await window.SceneBridge.applySequence(p.actions || []);
      return {
        // ★ demoId 与 perAction 是"动作气泡 ↔ 演示步骤"的对应表：气泡上的第 i 行
        //   靠 perAction[i].stepIndex 才能算出它在这条演示里是第几步（气泡渲染的是
        //   模型原始的动作数组，队列里只有校验通过的部分，两者会错位）。
        //   学生点「引用」时给出的「演示 #N 的第 M 步」就是由这两个字段拼出来的。
        //   它随工具结果一起存档，所以**刷新之后引用依然准确**。
        demoId: r.demoId,
        perAction: r.perAction,
        queued: r.queued || 0,
        accepted: r.accepted || 0,
        failed: r.failed,
        overflow: r.overflow,
        manual: r.manual,
        totalSteps: r.total,
        note: (r.note || '') + ' 提示：学生点「下一步」后才会有下一步动作，中途可以「停止」或「逐步」。',
      };
    },

    // ---- 渐进式披露 ----
    loadKnowledge(p) {
      const e = need('Knowledge', '知识库');
      if (e) return e;
      const k = window.Knowledge.load(p.id);
      return k || { error: '未找到知识条目：' + p.id + '（可用条目见系统提示中的清单）' };
    },
    loadSkill(p) {
      const e = need('Skills', '技能库');
      if (e) return e;
      const s = window.Skills.load(p.name);
      return s || { error: '未找到技能：' + p.name + '（可用技能见系统提示中的清单）' };
    },
    explainConcept(p) {
      const e = need('QuestionEngine', '讲解与出题');
      if (e) return e;
      return window.QuestionEngine.explain(p.knowledgePoint, p);
    },

    // ---- 教学 ----
    generateQuestion(p) {
      const e = need('QuestionEngine', '出题引擎');
      if (e) return e;
      return window.QuestionEngine.generate(p.knowledgePoint, p.difficulty, p.exclude || []);
    },
    diagnoseError(p) {
      const e = need('ErrorDiagnosis', '错因诊断');
      if (e) return e;
      return window.ErrorDiagnosis.diagnose(p.questionId, p.chosenIndex, p.correctIndex);
    },
    generateVariant(p) {
      const e = need('QuestionEngine', '出题引擎');
      if (e) return e;
      return window.QuestionEngine.variant(p.questionId);
    },
    startFeynmanCheck(p) {
      const e = need('Skills', '技能库');
      if (e) return e;
      return window.Skills.startFeynman(p.knowledgePoint);
    },
    evaluateFeynman(p) {
      const e = need('QuestionEngine', '讲解与出题');
      if (e) return e;
      return window.QuestionEngine.evaluateFeynman(p.knowledgePoint, p.transcript);
    },
    updateMastery(p) {
      const e = need('MasteryModel', '掌握度模型');
      if (e) return e;
      return window.MasteryModel.update(p.knowledgePoint, p.delta);
    },
    recommendNext(p) {
      const e = need('MasteryModel', '掌握度模型');
      if (e) return e;
      return window.MasteryModel.recommend(p && p.count);
    },
    reviseDemo(a) {
      const e = need('SceneBridge', '演示队列');
      if (e) return e;
      const i = a && a.index;
      if (typeof i !== 'number' || i < 0) return { error: 'index 应为 ≥ 0 的步号' };
      const S = window.SceneBridge;
      if (typeof S.reviseDemo !== 'function') return { error: '当前版本不支持整改演示' };
      const demoId = (a && a.demo_id != null && a.demo_id !== '') ? a.demo_id : null;
      const r = S.reviseDemo(demoId, (a && a.op), i, (a && a.step) || {});
      if (!r || !r.ok) return { error: (r && r.error) || '修订失败' };
      // ★ 回执里的 steps 是**整改后的完整清单**（不是"只剩被改的这一条"）——
      //   模型据此向学生交代"其余步骤都还在"，不必再调一次 getSnapshot。
      r.note = (r.mode === 'reload')
        ? '已按整改后的完整步骤重播，并快进到第 ' + r.resumedAt + ' 步停下；'
          + '请点「下一步」看这一步改成了什么样。'
        : '已在原队列中就地修改，学生不必重看已经看过的步骤。';
      return r;
    },
  };

  /** 执行一个工具调用，返回可回灌给模型的结果对象 */
  async function execute(name, argsJson) {
    const fn = EXEC[name];
    if (!fn) return { error: '未知工具：' + name };
    let args;
    try { args = typeof argsJson === 'string' ? JSON.parse(argsJson || '{}') : (argsJson || {}); }
    catch (e) { return { error: '参数不是合法 JSON：' + (e && e.message) }; }
    try {
      const r = await fn(args);
      return r == null ? { ok: true } : r;
    } catch (err) {
      // 工具执行异常不中断循环，作为结果回灌让模型自行应对
      return { error: '工具执行异常：' + (err && err.message ? err.message : String(err)) };
    }
  }

  return { TOOLS, execute, names: () => TOOLS.map((t) => t.function.name) };
})();
