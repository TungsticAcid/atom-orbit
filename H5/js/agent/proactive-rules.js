/**
 * proactive-rules.js — 主动服务规则引擎（本地，零 token）
 *
 * ★ 两级过滤：本地规则先筛（每秒检查、不花 token），**只有命中才唤起 LLM**。
 *   因此"主动服务"在未命中时完全不产生成本。
 *
 * ★ 依据的是**行为数据**而非对话内容——这正是"自主感知"的体现：
 *   模型从对话文本里得不到"用户反复拖了 8 次 m"这类信息。
 *
 * 冷却机制：同一规则 N 分钟内不重复触发；用户可在设置里全局关闭。
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
                '而 m 的差别体现在**相位缠绕**上（arg = mφ）。',
          suggest: [
            { action: 'setWavefunctionMode', params: { mode: 'complex' } },
            { action: 'setColorMode', params: { mode: 'phase' } },
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
                's 轨道没有角节点，全部节面都是**球壳**——在 D(r) 上就表现为零点，数零点就是数径向节点。',
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
      if (!hit) continue;
      if (!canFire(r.id)) continue;

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
  function reset() { Object.keys(lastFired).forEach((k) => delete lastFired[k]); lastAnyFire = 0; firedCount = 0; }

  return { start, stop, reset, tick, RULES: RULES.map((r) => r.id) };
})();
