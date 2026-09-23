/**
 * agent-core.js — 对话循环（ReAct）
 *
 * 流程（最多 MAX_ROUNDS 轮）：
 *   ① 采集感知快照          ← ★ 每轮都重新采集
 *   ② 组装 messages（system = 基础契约 + 工具契约 + 知识/技能清单 + 就近提示）
 *   ③ LLM 流式调用
 *   ④ 解析增量（reasoning / content / tool_calls）
 *   ⑤ 有 tool_calls → 本地执行 → 结果回灌 → continue；无 → 结束
 *
 * 三个必须做对的细节（见实施计划 §7.2）：
 *   · 每轮重采快照：工具真的改了视图，沿用旧快照会让模型重复下发已生效的动作
 *   · 动作按分镜队列播放：applySceneActions 只入队并立即返回，逐步播放由学生点
 *     「下一步」驱动（见设置 → 演示播放方式），故工具不会阻塞对话循环
 *   · 只发工具调用时 content 为空：此时面板只显示动作气泡
 *
 * 用户控制权（§7.5）：任何时刻可 stop()，并**丢弃尚未执行的剩余工具调用**。
 */
window.AgentCore = (function () {
  'use strict';

  const MAX_ROUNDS = 6;
  // 被长度上限截断时允许"接着写"的次数。给 2 次足够补完一段长推导，
  // 又不至于把一轮对话拖成没完没了的续写。
  const MAX_CONTINUES = 2;

  let history = [];          // 会话历史（OpenAI messages 格式，不含 system）
  let abortCtrl = null;
  let running = false;
  let aborted = false;

  // ---------------------------------------------------------------------------
  // 系统提示：常驻部分只放"清单"，正文由模型按需拉取（渐进式披露）
  // ---------------------------------------------------------------------------
  function manifestText() {
    const lines = [];
    if (window.Knowledge && window.Knowledge.index) {
      const idx = window.Knowledge.index();
      if (idx.length) {
        lines.push('【知识库清单】（正文需用 loadKnowledge(id) 按需加载，不要臆测内容）');
        lines.push(idx.map((e) => `${e.id}｜${e.kp}｜${e.title}｜关键词:${(e.keywords || []).join('/')}`).join('\n'));
      }
    }
    if (window.Skills && window.Skills.index) {
      const sk = window.Skills.index();
      if (sk.length) {
        lines.push('【教学技能清单】（完整步骤需用 loadSkill(name) 加载）');
        lines.push(sk.map((s) => `${s.name}｜${s.desc}`).join('\n'));
      }
    }
    return lines.join('\n\n');
  }

  function buildSystem() {
    const role = [
      '你是「轨道视界」原子轨道教学智能体，服务于结构化学课程中"原子结构"章节的教与学。',
      '',
      '【你的本质】你不是问答机器人，而是能感知用户在做什么、能动手把话演示出来的教学智能体。',
      '因此：凡是可以用视图演示的，都要用 applySceneActions 演示，而不是只用文字描述。',
      '',
      '【硬性约定】',
      '1. 任何数值（节点数、峰值半径、能级、概率…）必须用 queryOrbital 获取，**绝对不要自己口算**。',
      '2. 改变视图只能通过 applySceneActions。动作会排成**分镜队列逐步播放**：第一步立刻执行，',
      '   之后停下等学生自己点「下一步」确认。因此本工具**立即返回受理回执、不会等演示播完**，',
      '   返回里没有 executed 是正常的。单次控制在 4–8 个动作；长流程分几次调用，后续动作会自动接在队尾。',
      '   想知道演示走到哪一步了，调 getSnapshot 看「演示播放」字段。',
      '3. 回答前先调用 getSnapshot 了解用户当前在看什么、刚才做了什么（尤其"交互痕迹"）。',
      '4. 回答范围限于原子结构/波函数。涉及晶体堆积、分子对称性等，请说明并建议使用「晶典在线」「对称视界」模块。',
      '5. 用中文回答，简洁清晰。',
      '',
      '【公式写法】（渲染器按 LaTeX 解析，务必遵守，否则会显示成乱码）',
      '· 行内公式用一对 $，且**不要跨行**：写法如 $\\psi_{nlm}=R_{n,l}(r)Y_{l,m}(\\theta,\\phi)$。',
      '· 独立成行的公式用 $$…$$，且 $$ 必须独占一行（不要夹在句子中间）。',
      '· 不要把公式拆到多行；不要用 \\( \\) 或 \\[ \\]。',
      '',
      '【常用动作速查】（完整清单与参数说明可用 listSceneActions 拉取）',
      '量子数  setQuantumNumbers{n,l,m} ｜ sweepQuantumNumber{axis,from,to}',
      '模式    setWavefunctionMode{mode:real|complex} ｜ setRenderMode{mode:points|surface} ｜ setColorMode{mode:orbital|phase}',
      '等值面  setPsiCriterion{criterion:psi|psi2} ｜ setIsosurfaceLevel{fraction} ｜ animateIsosurfaceLevel{from,to}',
      '图表    showRadial{which:[R,R2,D,D2]} ｜ highlightRadialFeature{target:R|D,feature:peak|zeros}',
      '        setAngularView{which:Y|Y2} ｜ setSectionPlane{plane:xy|xz|yz} ｜ setSectionMode{mode:intensity|phase|contour}',
      '三维    linkRadialTo3D{radius}（radius=0 清除参考球） ｜ spotlightNodes{type,on}（on=false 清除） ｜ setFormulaHighlight{part:R|Y|L|P|N}',
      '叠加态  loadPreset{key} ｜ setSuperposition{terms} ｜ setCoefficient{index,re,im} ｜ setRelPhase{phase} ｜ clearSuperposition{}',
      '        savePreset{label,terms?,note?}（把当前叠加态存成面板上的按钮） ｜ deletePreset{key}',
      '',
      '【演示的节奏：由学生掌握】',
      '· 每个动作就是"一屏"，学生看清后自己点「下一步」；也可以「上一步」退回去重看、',
      '  「连续播放」一把放完、「停止」中止。播完之后还可以「重新演示」从头再来。',
      '· 所以**每一步都必须写 speech**：它是学生判断"这一步发生了什么、要不要继续"的唯一依据。',
      '  没写旁白的那一步，学生会看到画面莫名其妙地跳了一下。',
      '· 不要把 speech 写成"点击下一步继续"这类操作指令——按钮本身已经说明了这件事。',
      '  一句话交代这一步在做什么、要学生看哪里即可。',
      '· 讲解里如果需要引用具体数值（尤其是系数），请用工具返回的**实际值**，不要用你请求的值。',
      '',
      '【叠加态：系数由你定，不必只挑预设】',
      '叠加态是**任意系数的线性组合** ψ = Σ cᵢψᵢ（系数自动归一化），所以"不等性杂化"这类',
      '**非等价组合**你完全可以亲手做出来：',
      '· setSuperposition —— 直接给出 [{n,l,m,c:{re,im}}, …]，一次建好全部分量；',
      '· setCoefficient    —— 只改第 index 项的系数（先用 loadPreset 或 setSuperposition 建立分量）；',
      '· setRelPhase       —— 设置各项相对相位（这是相对相位，不是真实时间）。',
      '',
      '★ 需要分清的两件事（不是不让你做，是要说清楚）：',
      '  · 禁止：给一组系数，然后**声称**它"就是"水分子的真实 sp³ 杂化系数。',
      '    真实的 sp³ 不等性系数要由量子化学计算给出，本模块算不出来。',
      '  · 鼓励：给一组**示意系数**，把"系数不等 → 轨道不再等价 → 夹角偏离 109.5°"',
      '    这个因果关系演示出来，并明确标注"以下系数为示意，不是真实水分子数据"。',
      '  只声明边界、却不肯动手演示，学生什么也看不到；把示意系数的**教学含义**讲清楚，',
      '  才是这个模块该做的事——因果链本身是对的，学生看着轨道变形就能懂。',
      '',
      '【示范：学生问"水的 sp³ 不等性杂化"时可以这样演】',
      '  ① loadPreset{key:"sp-1"} —— 建立 ψ = (1/√2)(ψ₂ₛ + ψ₂p_z)，两个等权分量（也可用 sp³-1 看四面体方向）；',
      '  ② setCoefficient{index:0, re:0.80} —— s 成分变多：那一瓣变胖、变短、更贴核；',
      '  ③ setCoefficient{index:0, re:0.45} —— s 成分变少、p 成分变多：瓣变细长、伸得更远。',
      '  每一步都配 speech，例如："系数一旦不等，两瓣就不再一样大——这就是\'不等性\'的几何含义。"',
      '  最后一句务必交代：这里的系数是**示意值**，真实水分子的杂化系数要由量子化学计算给出，',
      '  但"系数不等 ⇒ 轨道不等价"这条因果链是普适的。',
      '',
      '★ 讲完顺手存成预设（建议做，别让它随对话消失）：',
      '  savePreset{label:"不等性杂化（示意）", note:"系数为示意值，用于说明系数不等 ⇒ 两瓣不再对称；',
      '  真实水分子的 sp³ 不等性系数需量子化学计算。"}',
      '  存好后学生会看到面板上多出一个按钮，随时能一键复现、反复对照。这一步把"一次回答"变成了',
      '  "一件留在工具里的教具"，很值得做。',
    ].join('\n');

    const manifest = manifestText();
    const node = window.AgentCore._nodePrompt || '';
    return [role, manifest, node].filter(Boolean).join('\n\n');
  }

  // ---------------------------------------------------------------------------
  // 主循环
  // ---------------------------------------------------------------------------
  /**
   * @param {string} userText
   * @param {Object} handlers
   *   onDelta(evt)      流式增量 {type:'reasoning'|'content'|'tool_call_start', text}
   *   onToolCall(info)  即将执行工具 {name, args, round}
   *   onToolResult(info) 工具执行完 {name, result, round}
   *   onMessage(msg)    追加一条完整消息（供面板渲染）
   *   onDone(summary)   本轮结束
   *   onError(err)      出错
   */
  async function send(userText, handlers) {
    handlers = handlers || {};
    if (running) stop();                 // 新一轮先中止上一轮
    aborted = false;
    running = true;
    abortCtrl = new AbortController();

    const H = {
      onDelta: handlers.onDelta || (() => {}),
      onToolCall: handlers.onToolCall || (() => {}),
      onToolResult: handlers.onToolResult || (() => {}),
      onMessage: handlers.onMessage || (() => {}),
      onNotice: handlers.onNotice || (() => {}),
      onDone: handlers.onDone || (() => {}),
      onError: handlers.onError || (() => {}),
    };

    if (userText) history.push({ role: 'user', content: userText });

    const settings = (window.Settings && window.Settings.get) ? window.Settings.get() : null;
    if (!settings || !settings.apiKey) {
      running = false;
      const err = new Error('尚未配置 API Key，请在设置中填写你自己的模型密钥。');
      err.kind = 'no_key';
      H.onError(err);
      return { ok: false, error: err.message };
    }

    const executedTools = [];
    let rounds = 0;
    let continues = 0;              // 因长度截断而"接着写"的次数（有上限）
    // 留证据：空正文到底是怎么来的，靠这两个字段才能说清，而不是猜
    let lastFinishReason = null;
    let lastUsage = null;

    try {
      while (rounds < MAX_ROUNDS) {
        if (aborted) break;
        rounds++;

        // ① 每轮重采快照（关键：工具可能已改变视图）
        let snapshotText = '';
        if (window.Perception) {
          snapshotText = '【当前视图快照（实时）】\n' + window.Perception.toCompactText();
        }

        // ② 组装 messages
        const msgs = [{ role: 'system', content: buildSystem() }]
          .concat(history);

        // 把快照作为一条临时的 system 注入（不写入 history，避免累积膨胀）
        if (snapshotText) {
          msgs.splice(1, 0, { role: 'system', content: snapshotText });
        }

        // ③ 调用（流式）
        // 记录本轮"流式吐出来的"思考长度：有些服务不走流式、只在最终 payload 里
        // 给 reasoning_content，那样面板上的"思考"永远是空的，下面补发一次。
        let streamedReasoning = '';
        const out = await window.LLMClient.chat({
          settings: settings,
          maxTokens: settings.maxTokens,
          messages: msgs,
          tools: window.ToolRegistry.TOOLS,
          signal: abortCtrl.signal,
          onNotice: (n) => { if (!aborted) H.onNotice(n); },
          onDelta: (ev) => {
            if (aborted) return;
            if (ev.type === 'reasoning') streamedReasoning += ev.text;
            H.onDelta(ev);
          },
        });

        if (aborted) break;

        lastFinishReason = out.finishReason;
        lastUsage = out.usage;

        // 补发没流式吐出来的思考内容（只补差额，避免与已流出的部分重复）
        if (out.reasoning && out.reasoning.length > streamedReasoning.length) {
          const rest = out.reasoning.slice(streamedReasoning.length);
          streamedReasoning = out.reasoning;
          H.onDelta({ type: 'reasoning', text: rest });
        }

        // 记录 assistant 消息（含工具调用），保持历史完整
        const asstMsg = { role: 'assistant', content: out.content || '' };
        if (out.toolCalls.length) {
          asstMsg.tool_calls = out.toolCalls.map((t) => ({
            id: t.id, type: 'function',
            function: { name: t.function.name, arguments: t.function.arguments },
          }));
        }
        history.push(asstMsg);
        if (out.content) H.onMessage({ role: 'assistant', content: out.content });

        // ⑤ 无工具调用 → 结束（截断的情况见下面第 ⑥ 步，要先处理掉）
        const truncated = out.finishReason === 'length';
        if (!out.toolCalls.length && !truncated) break;

        // 逐个执行工具；若用户中止，**丢弃剩余未执行的调用**
        for (let i = 0; i < out.toolCalls.length; i++) {
          if (aborted) {
            // 未执行的调用也要回灌一条结果，否则历史里 tool_calls 与 tool 消息不配对
            for (let k = i; k < out.toolCalls.length; k++) {
              history.push({
                role: 'tool', tool_call_id: out.toolCalls[k].id,
                content: JSON.stringify({ aborted: true, note: '用户已中止本次循环，该动作未执行' }),
              });
            }
            break;
          }
          const tc = out.toolCalls[i];
          const name = tc.function.name;
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) { args = {}; }

          H.onToolCall({ name, args, round: rounds });
          const result = await window.ToolRegistry.execute(name, tc.function.arguments);
          executedTools.push(name);
          H.onToolResult({ name, args, result, round: rounds });

          history.push({
            role: 'tool', tool_call_id: tc.id,
            content: JSON.stringify(result),
          });
        }

        // ⑥ 长度截断：`finish_reason === 'length'` 表示这次回复被 max_tokens 砍断了。
        //   ★ 不处理会有两种"静默故障"：正文写了一半就没了；更糟的是推理模型把预算
        //     全烧在思考阶段，正文一个字都没写——界面上只出现一个空白气泡，
        //     用户只会觉得"没输出"，而错误信息一条都没有。
        //   所以这里显式续写（有次数上限），并把截断这件事报给面板。
        if (truncated) {
          H.onNotice({ kind: 'truncated', round: rounds, continues: continues });
          if (continues < MAX_CONTINUES) {
            continues++;
            history.push({
              role: 'user',
              content: '（上一条回复因长度上限被截断，请从中断处继续写完，不要重复已经写过的内容。'
                + '公式务必写成：行内 $…$ 不跨行，独立成行的 $$…$$ 独占一行。）',
            });
            continue;
          }
          H.onNotice({ kind: 'truncated_giveup', continues: continues });
          break;
        }

        // 继续下一轮，让模型看到工具结果后再决定
      }

      running = false;
      const summary = { ok: true, rounds, tools: executedTools, aborted,
        finishReason: lastFinishReason, usage: lastUsage };
      H.onDone(summary);
      return summary;

    } catch (err) {
      running = false;
      if (err && err.name === 'AbortError') {
        const summary = { ok: true, rounds, tools: executedTools, aborted: true,
          finishReason: lastFinishReason, usage: lastUsage };
        H.onDone(summary);
        return summary;
      }
      H.onError(err);
      return { ok: false, error: err.message, kind: err.kind };
    }
  }

  // ---------------------------------------------------------------------------
  // 用户控制权
  // ---------------------------------------------------------------------------
  /**
   * 中止当前循环。
   * ★ 必须同时做到三件事：中止 LLM 请求、停止动画、丢弃未执行的工具调用。
   *   （丢弃剩余调用是"退出权"能否真正生效的关键——模型可能一次返回 5 个动作，
   *    用户在第 2 个时叫停，继续执行后 3 个就违背了用户意图。）
   */
  function stop() {
    aborted = true;
    if (abortCtrl) { try { abortCtrl.abort(); } catch (e) { /* ignore */ } }
    if (window.SceneBridge) window.SceneBridge.stop();
  }

  function reset() {
    stop();
    history = [];
    running = false;
  }

  return {
    send, stop, reset,
    isRunning: () => running,
    getHistory: () => history.slice(),
    buildSystem,
    _nodePrompt: '',
  };
})();
