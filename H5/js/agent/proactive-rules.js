/**
 * proactive-rules.js — 主动服务规则引擎（本地，零 token）
 *
 * ★ **提示文案是本地写死的，全程不调用模型**：`build()` 返回字面量字符串，
 *   `deliver()` 把它拼成一张 DOM 卡片。所以主动提示既不花 token，也不进对话存储
 *   （因此不会推高后续每一轮的上下文）。会花 token 的只有卡片上那个「出题检验」按钮
 *   —— 它走 `QuestionEngine.startFlow()` → `launch()` → `Panel.runAgent(...)`，先讲一遍
 *   知识点再出题；而那已经是**用户主动点击**了。
 *   （原文案曾写"只有命中才唤起 LLM"，与实现不符，已改正。）
 *
 * ★ 检查周期 TICK_MS = 2.5s，纯本地计算。
 *
 * ★ 依据的是**行为数据**而非对话内容——这正是"自主感知"的体现：
 *   模型从对话文本里得不到"用户反复拖了 8 次 m"这类信息。
 *
 * ★ 触发策略：**边沿触发 + 冷却**，两者缺一不可（见 armed 的说明）。
 *   用户可在设置里全局关闭。
 */
window.ProactiveRules = (function () {
  'use strict';

  const TICK_MS = 2500;
  const COOLDOWN_MS = 3 * 60 * 1000;    // 同一规则 3 分钟内不重复打扰
  const GLOBAL_MIN_INTERVAL = 45 * 1000; // 两次主动提示至少间隔 45 秒

  let timer = null;
  const lastFired = Object.create(null);
  let lastAnyFire = 0;
  const sessionStart = Date.now();
  let firedCount = 0;

  /**
   * 每条规则是否"已就绪"（可以触发）。false = 这一段困惑已经提示过。
   *
   * ★ 必须**边沿触发**，不能只靠冷却。规则条件读的是 Perception 的交互计数，
   *   而那些计数（`toggleCounts`）**只增不减、也没有衰减** —— 于是
   *   "拖了 6 次 m 却没切过实/复"这类条件一旦成立就**永远成立**。只靠冷却的话，
   *   同一条提示会在 COOLDOWN_MS 到点后再弹一次、再等一轮再弹一次，直到关掉页面，
   *   这正是"同一个主动提示连续触发"。
   *   改为：条件**为假**时重新就绪；为真且就绪时才触发。于是同一段困惑只提示一次，
   *   而用户真的换了做法（例如切到复函数、打开径向图）之后再来一遍，还能再提示。
   */
  const armed = Object.create(null);

  // ---------------------------------------------------------------------------
  // 规则表
  // ---------------------------------------------------------------------------
  const RULES = [
    {
      id: 'm-fiddling',
      /** 反复调 m 却没意识到实/复差异 → 主动解释 */
      check: function (tr, st) {
        const c = tr.toggleCounts || {};
        const n = c.setM || 0;
        // 拖了很多次 m，但几乎没切过实/复模式
        return n >= 6 && (c.setWavefunctionMode || 0) === 0 && st.wavefunction === 'real';
      },
      build: function (st) {
        return {
          text: '发现你在反复调 m。在**实函数**模式下，m>0 与 m<0 分别是 cos(mφ) 与 sin(mφ) 两种取向——' +
                '形状确实会变，但都是"两瓣"。要不要切成**复函数**看看？那时密度会变成绕 z 轴的环，' +
                '而 m 的差别体现在**相位缠绕**上（arg = mφ，截面的相位图能看到完整一圈）。',
          suggest: [
            { action: 'setWavefunctionMode', params: { mode: 'complex' } },
            { action: 'setSectionPlane', params: { plane: 'xy' } },
            { action: 'setSectionMode', params: { mode: 'phase' } },
          ],
        };
      },
    },
    {
      id: 's-orbital-switching',
      /** 在几个 s 轨道间来回切 → 主动叠画 D(r) 对比径向节点 */
      check: function (tr, st) {
        return st.l === 0 && (tr.toggleCounts.setN || 0) >= 4 &&
               (tr.toggleCounts.showRadial || 0) === 0;
      },
      build: function (st) {
        return {
          text: '看起来你在比较不同 n 的 s 轨道。要我把它们的 **D(r) = r²R²** 画出来吗？' +
                's 轨道没有角度节面，全部节面都是**球壳**——在 D(r) 上就表现为节点，数节点就是数径向节点。',
          suggest: [
            { action: 'showRadial', params: { which: ['D'] } },
            { action: 'highlightRadialFeature', params: { target: 'D', feature: 'zeros' } },
          ],
        };
      },
    },
    {
      id: 'idle-no-practice',
      /** 长时间无操作且没进过练习 → 邀请检验 */
      check: function (tr, st) {
        return tr.idleMs > 45000 &&
               (Date.now() - sessionStart) > 60000 &&
               !firedCount &&
               !(window.QuestionEngine && window.QuestionEngine.flow && window.QuestionEngine.flow.active);
      },
      build: function () {
        return {
          text: '看了一会儿了——要不要出两道题检验一下？' +
                '答错也没关系，我会把视图切到能看出来的状态，带你自己找到原因。',
          suggest: [],
          offerPractice: true,
        };
      },
    },
  ];

  // ---------------------------------------------------------------------------
  // 主循环
  // ---------------------------------------------------------------------------
  function canFire(id) {
    const now = Date.now();
    if (now - lastAnyFire < GLOBAL_MIN_INTERVAL) return false;
    if (lastFired[id] && now - lastFired[id] < COOLDOWN_MS) return false;
    return true;
  }

  function tick() {
    // 全局开关
    if (window.Settings && !window.Settings.get().proactive) return;
    // 未配置 Key 时不能调 LLM，但可以静默累积；不打扰
    if (!window.Settings || !window.Settings.hasKey()) return;
    if (!window.Perception || !window.OrbitApp) return;
    if (window.AgentCore && window.AgentCore.isRunning()) return;   // 正在对话时不打扰
    if (window.DemoMode && window.DemoMode.isPlaying && window.DemoMode.isPlaying()) return;

    const tr = window.Perception.getTrace();
    const st = window.OrbitApp.getState();

    for (const r of RULES) {
      let hit = false;
      try { hit = r.check(tr, st); } catch (e) { hit = false; }
      // ★ 条件不再成立 → 重新就绪（"这一段困惑过去了"）。
      //   必须先于下面所有判断执行：否则一条一直为真的规则永远得不到复位。
      if (!hit) { armed[r.id] = true; continue; }
      if (armed[r.id] === false) continue;    // 这一段困惑已经提示过，不再打扰
      if (!canFire(r.id)) continue;

      armed[r.id] = false;
      lastFired[r.id] = Date.now();
      lastAnyFire = Date.now();
      firedCount++;
      deliver(r.build(st, tr));
      break;   // 一次只发一条，避免打扰
    }
  }

  /** 渲染为「提示卡」，由用户决定是否展开 */
  function deliver(payload) {
    const P = window.Panel;
    if (!P) return;
    const wrap = document.createElement('div');
    wrap.className = 'agent-msg assistant agent-proactive';
    wrap.innerHTML =
      '<div class="agent-pro-head">💡 主动提示</div>' +
      '<div class="agent-pro-body">' + P.renderRich(payload.text) + '</div>' +
      '<div class="agent-pro-act">' +
      (payload.suggest && payload.suggest.length ? '<button class="agent-btn pro-show">给我看看</button>' : '') +
      (payload.offerPractice ? '<button class="agent-btn primary pro-practice">出题检验</button>' : '') +
      '<button class="agent-btn pro-dismiss">知道了</button>' +
      '</div>';

    const box = document.querySelector('.agent-msgs');
    if (box) { box.appendChild(wrap); box.scrollTop = box.scrollHeight; }
    P.markUnread();

    const showBtn = wrap.querySelector('.pro-show');
    if (showBtn) showBtn.onclick = function () {
      window.SceneBridge.applySequence(payload.suggest || []);
      showBtn.disabled = true;
      showBtn.textContent = '已应用';
    };
    const pracBtn = wrap.querySelector('.pro-practice');
    if (pracBtn) pracBtn.onclick = function () {
      pracBtn.disabled = true;
      if (window.QuestionEngine) window.QuestionEngine.startFlow();
    };
    wrap.querySelector('.pro-dismiss').onclick = function () {
      wrap.classList.add('dismissed');
      setTimeout(function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, 200);
    };
  }

  function start() {
    if (timer) return;
    // 首次检查延后，避免一进页面就弹
    setTimeout(function () { timer = setInterval(tick, TICK_MS); }, 20000);
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  function reset() {
    Object.keys(lastFired).forEach((k) => delete lastFired[k]);
    Object.keys(armed).forEach((k) => delete armed[k]);   // 连同"就绪"状态一起复位
    lastAnyFire = 0;
    firedCount = 0;
  }

  return { start, stop, reset, tick, RULES: RULES.map((r) => r.id) };
})();
