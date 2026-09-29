/**
 * demo-mode.js — 课堂演示模式（脚本回放，零 token）
 *
 * ★ 为什么演示回放不走 LLM：
 *   课堂上不能容忍"每点一次下一步就等模型 3 秒"。演示脚本在**首次生成时**由人/模型
 *   编排一次，之后存为脚本反复回放——既保证课堂流畅，也支撑"演示脚本可保存复用"
 *   这一推广卖点。
 *
 * 每个脚本 = 若干步，每步 = 一句讲解 + 一组受控动作。
 * 内置脚本的物理内容已核对（如 3d 的径向节点是 0 个而非 2 个）。
 *
 * ★★ 两条**实测得出**的硬规矩，改脚本前务必先读（都踩过，都有截图）：
 *
 *  ① 阈值读数按 |ψ| 判据写，且每一步的"可见壳层数"都与旁白核对过 ——
 *     核对办法是拿 shellPeakFractions 与 iso = f² 比：径向壳的峰值高于阈值才会显出来。
 *     例如 3s 的 0.012 这个读数，就是为了让三层壳都显出来（旁白要讲"两层内壳"）。
 *     ⚠️ 别按"绝对值等价"去做开方换算：那会把 iso 抬高一两个量级、外层壳全被切掉，
 *     "两层内壳"这句旁白当场就不成立（本轮就这么错过一次）。
 *     → 所以每个脚本的第一步都**显式下发 setPsiCriterion{psi}**，把判据钉死：
 *       脚本里的数字只在 ψ 判据下有那个含义，学生当前若停在 |ψ|² 档，
 *       同一个 0.08 会被平方解释，画面完全对不上。
 *
 *  ② **同心壳必须在截面里讲，不能在三维里讲** —— 这是本轮改写的核心。
 *     径向节点对应的"内层壳"是**同心的**，三维等值面又是实体渲染：外层壳必然把内层
 *     整个包住，降阈值只会让**颜色**变（phase 着色按 sign ψ），形状看上去还是同一个球。
 *     实测：3s 的 0.08 → 0.012，三维截图两张几乎一模一样，而同参数下的 xz 截面从
 *     "一个圈"变成"三圈同心圆"，套娃一目了然。
 *     ⚠️ 由此得到一条更一般的判据：**"旁白声称的现象"才是验收标准，不是"状态值对不对"**。
 *       状态（阈值、壳层数）全对、旁白"看到了吗？像套娃一样出现了内层壳"仍可能是空话。
 *     ⚠️ 顺带实测证伪的两条老路，别再用：
 *       · spotlightNodes{radial} 画的节面球面 —— 标着"×2"，可见的只有最外面那个；
 *       · linkRadialTo3D 的参考球 —— 半径小于等值面时被整个包住，只剩左下角标签可见。
 *       参考球要用得先**把阈值收高**让等值面缩进去（见 rVsD 第 3 步，那里阈值收到 0.45）。
 */
window.DemoMode = (function () {
  'use strict';

  const SCRIPTS = {
    /* --------------------------------------------------------------- */
    nodeDistribution: {
      title: '同一层里，径向节点与角度节面如何此消彼长',
      points: ['K5', 'K2'],
      steps: [
        {
          // 钉判据 + 铺好三维语境：3s 是球，角度节面 0 个
          speech: '先看 3s。等值面把 |ψ| 达到峰值 8% 的那些点连成一张曲面——你看到的是一个**球**，'
            + '朝哪个方向看都一样。这说明它的角度部分完全没有方向性：**角度节面 0 个**。'
            + '它的全部结构都藏在半径里面，一张等值面看不出来。',
          actions: [
            { action: 'setPsiCriterion', params: { criterion: 'psi' } },
            { action: 'setWavefunctionMode', params: { mode: 'real' } },
            { action: 'setRenderMode', params: { mode: 'surface' } },
            { action: 'setQuantumNumbers', params: { n: 3, l: 0, m: 0 } },
            { action: 'setIsosurfaceLevel', params: { fraction: 0.08 } },
          ],
        },
        {
          // ★ 必须在**截面**里讲"套娃"，且要先开窗再改图（focusChart 要排最前）
          speech: '三维里看不出来——外层的壳把内层整个包住了。换个看法：把 xz 平面剖开，'
            + '在剖面里标出这同一张等值面的剖线。现在我把阈值从 8% 一路降到 1.2%……'
            + '看：一圈、两圈、三圈同心圆依次冒出来，像套娃一样。'
            + '**每两层壳之间，就夹着一层径向节点**。数一数：三层壳，所以径向节点 2 个。',
          actions: [
            { action: 'focusChart', params: { target: 'section' } },
            { action: 'setSectionPlane', params: { plane: 'xz' } },
            { action: 'setSectionMode', params: { mode: 'intensity' } },
            { action: 'animateIsosurfaceLevel', params: { from: 0.08, to: 0.012, durationMs: 2600 } },
          ],
        },
        {
          // 形状变（三维）+ 壳层少（剖面）—— 一次改两个通道，学生同屏对照
          speech: '换成 3p。看三维：球变成了**哑铃形**，有方向性了——角度节面出现了 1 个，'
            + '就是把上下两瓣分开的那个平面。再看浮窗里的剖面：同心圆少了一圈，'
            + '**内层壳只剩一层**，径向节点只剩 1 个。n 没变，径向节点少了 1 个，正好补到角度上去。',
          actions: [
            { action: 'setQuantumNumbers', params: { n: 3, l: 1, m: 0 } },
            { action: 'setIsosurfaceLevel', params: { fraction: 0.05 } },
          ],
        },
        {
          speech: '再到 3d。三维里形状更复杂——两个瓣外面套一个环，角度节面变成 2 个（两个锥面）。'
            + '剖面里呢？**内层壳一个也没有了**，径向节点 0 个。'
            + '注意这三个轨道：径向节点 2、1、0，角度节面 0、1、2——**总数恒为 n − 1 = 2**。'
            + '它们只是在这两者之间来回搬家。',
          actions: [
            { action: 'setQuantumNumbers', params: { n: 3, l: 2, m: 0 } },
            { action: 'setIsosurfaceLevel', params: { fraction: 0.10 } },
          ],
        },
        {
          // 切回 3s —— 让"两层内壳"与"D(r) 的两个零点"在同一屏上焊起来
          speech: '那两层内壳，在径向分布函数上长什么样？回到 3s，把 D(r) = r²R(r)² 画出来：'
            + '**它两次碰到零线**——这两个零点正是刚才那两层壳的分界。'
            + '径向节点就是 D(r) 的零点个数，一步不多、一步不少。'
            + '（3d 那边则是一次也不碰零，刚才剖面上已经看到了。）',
          actions: [
            { action: 'focusChart', params: { target: 'radial' } },
            { action: 'setQuantumNumbers', params: { n: 3, l: 0, m: 0 } },
            { action: 'setIsosurfaceLevel', params: { fraction: 0.012 } },
            { action: 'showRadial', params: { which: ['D'] } },
            { action: 'highlightRadialFeature', params: { target: 'D', feature: 'zeros' } },
          ],
        },
        {
          speech: '小结：3s 是径向 2 个、角度 0 个；3p 是径向 1 个、角度 1 个；3d 是径向 0 个、角度 2 个。'
            + '**总数恒为主量子数减一**。这就是"同一层里 l 越大，径向节点越少、角度节面越多"的来源。'
            + '操作与讲解不再互相打断——讲快了可以点「上一步」退回重讲。',
          actions: [
            { action: 'focusChart', params: { target: 'none' } },
            { action: 'highlightRadialFeature', params: { target: 'D', feature: null } },
            { action: 'setAutoRotate', params: { on: false } },
          ],
        },
      ],
    },

    /* --------------------------------------------------------------- */
    rVsD: {
      title: 'R(r) 与 D(r)：为什么峰值不在同一个地方',
      points: ['K3'],
      steps: [
        {
          speech: '先看 1s 的径向波函数 R(r)。它是一条从原点开始单调下降的曲线——'
            + '**r = 0 处最大**，越往外越小。物理上这是"离核越近越容易出现"，听起来很合理。'
            + '但这条曲线本身还不是概率：它只是波函数在径向上的那一部分。',
          actions: [
            { action: 'focusChart', params: { target: 'radial' } },
            { action: 'setQuantumNumbers', params: { n: 1, l: 0, m: 0 } },
            { action: 'setWavefunctionMode', params: { mode: 'real' } },
            { action: 'setRenderMode', params: { mode: 'surface' } },
            { action: 'showRadial', params: { which: ['R'] } },
          ],
        },
        {
          speech: '现在把 D(r) = r²R(r)² 也画上去。注意峰值挪地方了：'
            + '**R 的峰在原点，D 的峰却在 r = 1 a₀**——整条曲线在原点附近反而是零。'
            + '为什么会这样？看下去。',
          actions: [
            { action: 'showRadial', params: { which: ['R', 'D'] } },
            { action: 'highlightRadialFeature', params: { target: 'D', feature: 'peak' } },
          ],
        },
        {
          // ★ 参考球要可见，前提是它落在等值面**外面** —— 故把阈值收到 0.45（1s 的面缩到 1 a₀ 以内）
          speech: '我把 D 的峰值半径——1 a₀——在三维里标出来。为了让这层壳露在外面，'
            + '我顺手把等值面阈值收高了一点，球就缩进去了。你看：'
            + '径向图上横坐标的**一个点**，在三维里就是薄薄的一层**球壳**。'
            + '原子的"层"就是这么来的。',
          actions: [
            { action: 'focusChart', params: { target: 'none' } },
            { action: 'setIsosurfaceLevel', params: { fraction: 0.45 } },
            { action: 'linkRadialTo3D', params: { radius: 1 } },
            { action: 'setAutoRotate', params: { on: true } },
          ],
        },
        {
          speech: '为什么差一个 r²？因为**概率**要拿概率密度乘上这一层的体积，而球壳体积正比于 r²。'
            + '原点处密度虽然最大，但那一层几乎不占体积。于是"最密的地方"和"最可能待的地方"'
            + '分了家——这正是 R(r) 与 D(r) 必须分开讲的原因。',
          actions: [
            { action: 'setAutoRotate', params: { on: false } },
            // 演示结束顺手撤掉参考球、把阈值放回去：辅助几何用完不收会把画面一直弄脏
            { action: 'linkRadialTo3D', params: { radius: 0 } },
            { action: 'setIsosurfaceLevel', params: { fraction: 0.10 } },
          ],
        },
      ],
    },

    /* --------------------------------------------------------------- */
    complexReal: {
      title: '实轨道与复轨道：同一个能量，两种长相',
      points: ['K6', 'K7'],
      steps: [
        {
          // ★ 为什么第 1、2 步必须用 2p（l = 1）：
          //   相位缠绕 mφ 只在**绕 z 轴转一圈**（即 xy 平面）上看得见。
          //   而 Θ_l^m ∝ sin^|m|θ · P(cosθ)，当 l − |m| 为**奇数**时含 cosθ 因子，
          //   xy 平面（θ = 90°）就**一定是节面**。l=2, m=1 正是这种情况 ——
          //   实测：3d + m=1 + xy 相位图上整张全是黑的（写着"本平面为节面 |ψ|² ≈ 0"）。
          //   l=1, m=1 时 l − m = 0 为偶，sinθ 在 θ=90° 取极大，缠绕才看得见。
          speech: '先看复函数下的 2p，取 m = +1。它的密度是一个**环**——为什么是环？'
            + '复解的相位是 e^{imφ}，取模之后 |e^{imφ}| = 1，方位角 φ 被彻底消掉了。'
            + '绕着 z 轴转一圈，密度什么都没变，所以它一定是个轴对称的环。',
          actions: [
            { action: 'focusChart', params: { target: 'none' } },
            { action: 'setPsiCriterion', params: { criterion: 'psi' } },
            { action: 'setQuantumNumbers', params: { n: 2, l: 1, m: 1 } },
            { action: 'setWavefunctionMode', params: { mode: 'complex' } },
            { action: 'setRenderMode', params: { mode: 'surface' } },
            { action: 'setAutoRotate', params: { on: true } },
          ],
        },
        {
          speech: '但 φ 并没有真的消失——它藏在**相位**里。切到 xy 截面的相位图：'
            + '绕原点走一圈，颜色连续循环了一整轮，相位正好走完 **1** 个整周期。'
            + '这就是 |m| = 1 的含义。不过 l = 1 的轨道里 m 只能取到 ±1，'
            + '想看更大的缠绕，得换一个轨道。',
          actions: [
            { action: 'focusChart', params: { target: 'section' } },
            { action: 'setSectionPlane', params: { plane: 'xy' } },
            { action: 'setSectionMode', params: { mode: 'phase' } },
          ],
        },
        {
          // ★ 跨轨道是物理决定的，不是偷懒：l−1 与 l−2 一奇一偶，
          //   没有任何一个 l 能让 |m|=1 和 |m|=2 同时在 xy 平面上有值。
          //   所以这里**明说换了轨道**，绝不写"能量没变"（n 从 2 变到 3，能量确实变了）。
          speech: '换成 3d，取 m = +2。还是 xy 截面、还是相位图——绕一圈，颜色循环了**两**轮。'
            + '**|m| 就是绕一圈的周期数**。这里能量虽然跟着主量子数变了，'
            + '但同一个 l 下 m 取几是不影响能量的：3d 的 m = 1 与 m = 2 能量完全相同，'
            + '差别只在绕 z 轴的节拍。',
          actions: [
            { action: 'setQuantumNumbers', params: { n: 3, l: 2, m: 2 } },
          ],
        },
        {
          speech: '现在把这个轨道的复解切成实解。环消失了，变成有明确方向性的**瓣**。'
            + '注意：**能量一点没变**（n = 3、l = 2 都没动，换掉的只是基底）。'
            + '相位图上也看得出来：实解的相位只有 0 与 π 两个值、两种颜色，'
            + '不再是连续缠绕的彩虹。',
          actions: [
            { action: 'setAutoRotate', params: { on: false } },
            { action: 'setWavefunctionMode', params: { mode: 'real' } },
          ],
        },
        {
          speech: '既然能量相同（简并），它们的任意线性组合就还是同一个能量的状态。'
            + '所以"实轨道是复轨道的线性组合"——它们不是两种不同的物理，'
            + '而是同一片空间里的两组基底，看你按什么方向去切它。',
          actions: [
            { action: 'focusChart', params: { target: 'none' } },
          ],
        },
      ],
    },

    /* --------------------------------------------------------------- */
    sectionModes: {
      title: '同一张截面，三种看法：密度 / ψ / 等高线',
      points: ['K5', 'K7'],
      steps: [
        {
          speech: '三维视图给的是**外部形状**，截面给的是**内部结构**。'
            + '现在固定住 3d_z² 在 xz 平面上的一刀，只看截面卡上的三个档位怎么各说各的话。'
            + '第一档是**密度图**：颜色越亮，|ψ|² 越大。上下两个瓣、中间一个环，看得很清楚；'
            + '但正负号被平方吃掉了——这上面分不出哪块是正、哪块是负。',
          actions: [
            { action: 'focusChart', params: { target: 'section' } },
            { action: 'setPsiCriterion', params: { criterion: 'psi' } },
            { action: 'setWavefunctionMode', params: { mode: 'real' } },
            { action: 'setQuantumNumbers', params: { n: 3, l: 2, m: 0 } },
            { action: 'setSectionPlane', params: { plane: 'xz' } },
            { action: 'setSectionMode', params: { mode: 'intensity' } },
          ],
        },
        {
          speech: '第二档是 **ψ 图**：直接画 ψ 本身，正负立刻分开——相邻两块**异色**。'
            + '而两种颜色的交界线就是**节面**：在这个剖面上，它们是几条从原点射出去的直线。'
            + '异色的地方是"波函数在这里翻了符号"，不是"这里没有电子"。',
          actions: [
            { action: 'setSectionMode', params: { mode: 'phase' } },
          ],
        },
        {
          speech: '第三档是**等高线**：把等值线一条条画出来，像地形图。'
            + '看这些从原点出发的直线——每一条都是一层节面。'
            + '数一数就能验证节点公式：这是三个档里最适合"数节面"的一种看法。',
          actions: [
            { action: 'setSectionMode', params: { mode: 'contour' } },
          ],
        },
        {
          speech: '同一份数据，三种画法：密度图回答"哪里多、哪里少"，'
            + 'ψ 图回答"正负怎么分、节面在哪里"，等高线回答"结构分成几块几层"。'
            + '这也正是要开一个浮窗的原因——三维与剖面同屏，形状和内部才对照得起来。',
          actions: [
            { action: 'focusChart', params: { target: 'none' } },
          ],
        },
      ],
    },
  };

  let playing = null, idx = 0, bar = null;

  function el(tag, attrs, kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach((c) => e.appendChild(c));
    return e;
  }

  /** 演示控制条 */
  function ensureBar() {
    if (bar) return bar;
    bar = el('div', { class: 'demo-bar hidden' });
    const title = el('span', { class: 'demo-title', text: '' });
    const prev = el('button', { class: 'agent-tbtn', text: '← 上一步' });
    const next = el('button', { class: 'agent-tbtn primary', text: '下一步 →' });
    const stop = el('button', { class: 'agent-tbtn', text: '停止' });
    const prog = el('span', { class: 'demo-prog', text: '' });
    prev.onclick = () => step(-1);
    next.onclick = () => step(1);
    stop.onclick = () => exit();
    bar.appendChild(title);
    bar.appendChild(prog);
    bar.appendChild(prev);
    bar.appendChild(next);
    bar.appendChild(stop);
    bar._title = title; bar._prog = prog;
    document.body.appendChild(bar);
    return bar;
  }

  function openPicker() {
    const P = window.Panel;
    let html = '<b>选择演示脚本</b>（回放不消耗 token）<div class="agent-picker">';
    Object.keys(SCRIPTS).forEach((k) => {
      html += '<button class="agent-pick-btn" data-s="' + k + '">' + SCRIPTS[k].title + '</button>';
    });
    html += '</div>';
    P.addMsg(html, 'assistant');
    document.querySelectorAll('.agent-pick-btn').forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll('.agent-pick-btn').forEach((x) => { x.disabled = true; });
        play(b.getAttribute('data-s'));
      };
    });
  }

  function play(scriptId) {
    const s = SCRIPTS[scriptId];
    if (!s) return { error: '脚本不存在' };
    playing = s; playing._id = scriptId; idx = -1;
    const b = ensureBar();
    b.classList.remove('show', 'hidden');
    b.classList.add('show');
    b._title.textContent = '演示：' + s.title;
    window.Panel.addChip('已进入演示模式（点「下一步」逐级播放，不消耗 token）');
    step(1);
    return { ok: true, total: s.steps.length };
  }

  async function step(dir) {
    if (!playing) return;
    const n = playing.steps.length;
    const ni = idx + dir;
    if (ni < 0) return;
    if (ni >= n) { finish(); return; }        // 走完最后一步 → 给出重播入口
    idx = ni;
    const st = playing.steps[idx];
    if (dir > 0 && st.speech) {
    window.Panel.addMsg(window.Panel.renderRich(st.speech), 'assistant');
    // ★ 旁白也记进对话：它原先只塞 DOM、完全不进 history，于是模型对内置演示一无所知 ——
    //   学生一说"刚才那个演示的第 2 步"它就断线。用 internal 记入：模型看得到，界面不显示。
    if (window.AgentCore && window.AgentCore.noteExternal) {
      window.AgentCore.noteExternal(st.speech,
        '内置演示《' + (playing && playing.title ? playing.title : '') + '》第 ' + (idx + 1) + ' 步');
    }
  }
    // ★ 进度必须在**发动作之前**更新。动作里可能夹着 2–4 秒的重建（3s 的三层壳、
    //   阈值扫描动画），等到 await 之后再写，旁白早就上屏了、进度条却还停在上一步 ——
    //   演示者会以为"这一下没点上"，于是再点一次。实测连点 6 次，读数依次是
    //   空 / 2 / 3 / 4 / 4 / 6，明显滞后一步；而它本来不依赖任何重建结果。
    if (bar) bar._prog.textContent = (idx + 1) + ' / ' + n;
    if (st.actions && st.actions.length) {
      // auto:true —— 演示者在**脚本层面**已经点过「下一步」了，脚本内部的子动作
      // 应当连贯播完，不再逐个等他确认（否则每一步要点两次）
      await window.SceneBridge.applySequence(st.actions, { auto: true });
    }
    return { idx: idx, total: n };
  }

  /** 演示结束：提供「重新播放」，而不是直接消失 */
  function finish() {
    const id = playing && playing._id;
    const P = window.Panel;
    if (P) {
      const card = P.addMsg(
        '<div class="demo-end">演示已结束' +
        '<button class="agent-btn primary demo-replay">↻ 重新播放</button>' +
        '<button class="agent-btn demo-close">关闭</button></div>', 'assistant');
      const rp = card.querySelector('.demo-replay');
      if (rp) rp.onclick = function () {
        rp.disabled = true;
        if (id) play(id); else exit();
      };
      const cl = card.querySelector('.demo-close');
      if (cl) cl.onclick = function () { card.classList.add('fade'); setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 200); };
    }
    playing = null; idx = 0;
    if (bar) bar.classList.remove('show');
    if (window.SceneBridge) window.SceneBridge.stop();
    return { finished: true, replay: id };
  }

  function exit() {
    playing = null; idx = 0;
    if (bar) bar.classList.remove('show');
    if (window.SceneBridge) window.SceneBridge.stop();
  }

  function list() { return Object.keys(SCRIPTS).map((k) => ({ id: k, title: SCRIPTS[k].title, points: SCRIPTS[k].points })); }

  return { openPicker, play, step, exit, list, SCRIPTS, isPlaying: () => !!playing };
})();
