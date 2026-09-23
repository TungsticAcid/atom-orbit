/**
 * settings.js — 设置（BYOK）与持久化
 *
 * ★ 安全约定：
 *   · API Key 只存浏览器 localStorage，**只发往用户自己填写的 endpoint**，无任何中转。
 *   · 界面上**永不显示完整密钥**（只显示 sk-xxxx****xxxx 形式的掩码）。
 *   · 任何日志输出前必须经 LLMClient.redact()。
 *   · 默认不赠送额度；未配置 Key 时引导用户填写自己的。
 */
window.Settings = (function () {
  'use strict';

  const KEY = 'orbit.agent.settings';

  const DEFAULTS = {
    endpoint: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-flash',
    effort: '',              // '' = 用服务端默认；可选 low / high / max
    showReasoning: true,     // 是否显示"思考中"
    proactive: true,         // 主动服务开关
    animSpeed: 1.0,          // 动画速度倍率
    // 演示播放方式：'manual' 每步停下等学生点「下一步」；'auto' 按节奏自动连播。
    // 默认手动——一步一确认，学生才有时间看清画面到底变了什么。
    playback: 'manual',
    // 单次回复的输出上限（思考 + 正文共用）。推理模型在写正文前会先花掉一大段思考，
    // 给太小会导致"正文一个字没写就截断"，界面上表现为空白回复。
    maxTokens: 8192,
  };

  let cache = null;

  function get() {
    if (cache) return cache;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { saved = {}; }
    cache = Object.assign({}, DEFAULTS, saved);
    return cache;
  }

  function set(patch) {
    cache = Object.assign(get(), patch || {});
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) { /* 隐私模式可能禁用 */ }
    return cache;
  }

  /** 掩码显示：sk-abcd****wxyz（保留首尾各 4 位便于辨识，中间全掩） */
  function mask(key) {
    const k = (key || '').trim();
    if (!k) return '（未配置）';
    if (k.length <= 10) return k.slice(0, 3) + '****';
    return k.slice(0, 7) + '****' + k.slice(-4);
  }

  function hasKey() { return !!(get().apiKey || '').trim(); }

  // ---------------------------------------------------------------------------
  // 设置界面
  // ---------------------------------------------------------------------------
  let overlay = null;

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    (children || []).forEach((c) => e.appendChild(c));
    return e;
  }

  function buildOverlay() {
    if (overlay) return overlay;
    const s = get();

    const box = el('div', { class: 'agent-settings-box' });

    // --- 头部 ---
    box.appendChild(el('div', { class: 'agent-settings-head' }, [
      el('span', { class: 'agent-settings-title', text: '设置' }),
      (() => { const b = el('button', { class: 'agent-x', text: '✕' }); b.onclick = close; return b; })(),
    ]));

    const body = el('div', { class: 'agent-settings-body' });

    // --- 分组 1：模型服务 ---
    body.appendChild(el('div', { class: 'agent-sgroup-title', text: '模型服务（改一次就不动）' }));
    const g1 = el('div', { class: 'agent-sgroup' });

    const epInput = el('input', { class: 'agent-input', type: 'text', value: s.endpoint, placeholder: 'https://api.deepseek.com' });
    g1.appendChild(field('接入点 endpoint', epInput, '任何 OpenAI 兼容服务均可'));

    const keyInput = el('input', { class: 'agent-input', type: 'password', placeholder: hasKey() ? mask(s.apiKey) : 'sk-...' });
    keyInput.addEventListener('input', () => { keyInput.dataset.touched = '1'; });
    g1.appendChild(field('API Key（BYOK）', keyInput, hasKey() ? '已配置：' + mask(s.apiKey) + '　留空则保持不变' : '仅存本机，不上传服务器'));

    const modelInput = el('input', { class: 'agent-input', type: 'text', value: s.model, placeholder: 'deepseek-flash' });
    g1.appendChild(field('模型名', modelInput, '如 deepseek-flash / gpt-4o-mini / qwen-plus'));

    const effortSel = el('select', { class: 'agent-input' });
    [['', '服务端默认'], ['low', 'low（快）'], ['high', 'high'], ['max', 'max（强）']].forEach(([v, t]) => {
      const o = el('option', { value: v, text: t });
      if (s.effort === v) o.selected = 'selected';
      effortSel.appendChild(o);
    });
    g1.appendChild(field('推理强度 effort', effortSel, '可选；部分服务不支持则忽略'));

    // 输出上限：思考与正文共用。推理模型写公式题很容易在思考阶段就吃光预算，
    // 表现是"正文一个字都没输出"，所以这里可见可调。
    const maxTokInput = el('input', {
      class: 'agent-input', type: 'number', min: '1024', max: '65536', step: '1024',
      value: String(s.maxTokens),
    });
    g1.appendChild(field('输出上限 max_tokens', maxTokInput,
      '思考 + 正文共用。推理模型提问较长时若出现"没有正文"，把它调大'));

    const testRow = el('div', { class: 'agent-row' });
    const testBtn = el('button', { class: 'agent-btn', text: '测试连接' });
    const testMsg = el('span', { class: 'agent-test-msg', text: '' });
    testBtn.onclick = async () => {
      testMsg.textContent = '测试中…';
      const patch = collect();
      try {
        const r = await window.LLMClient.testConnection(patch);
        testMsg.textContent = '✓ 连接成功（模型：' + r.model + '）';
        testMsg.className = 'agent-test-msg ok';
      } catch (e) {
        testMsg.textContent = '✗ ' + (e.message || '失败');
        testMsg.className = 'agent-test-msg bad';
      }
    };
    testRow.appendChild(testBtn); testRow.appendChild(testMsg);
    g1.appendChild(testRow);
    body.appendChild(g1);

    // --- 分组 2：教学偏好 ---
    body.appendChild(el('div', { class: 'agent-sgroup-title', text: '教学偏好（可能每次教学都调）' }));
    const g2 = el('div', { class: 'agent-sgroup' });

    const cbReason = checkbox('显示"思考中"过程', s.showReasoning);
    g2.appendChild(cbReason.row);
    const cbProactive = checkbox('启用主动服务（在检测到困惑时主动介入）', s.proactive);
    g2.appendChild(cbProactive.row);

    // 演示播放方式：这是"看得清"与"省事"之间的选择，两种场合都用得上，故做成设置
    const pbSel = el('select', { class: 'agent-input' });
    [['manual', '手动：每步停下，点「下一步」继续'],
     ['auto', '自动：按节奏连续播放']].forEach(([v, t]) => {
      pbSel.appendChild(el('option', { value: v, text: t }));
    });
    pbSel.value = s.playback === 'auto' ? 'auto' : 'manual';
    g2.appendChild(field('演示播放方式', pbSel,
      '手动适合跟着讲解走；自动适合课堂一次性放完。演示条上可临时切换。'));

    const spd = el('input', { class: 'agent-input', type: 'range', min: '0.5', max: '2', step: '0.25', value: String(s.animSpeed) });
    g2.appendChild(field('动画速度', spd, '×' + s.animSpeed));
    spd.addEventListener('input', () => set({ animSpeed: +spd.value }));
    body.appendChild(g2);

    // --- 分组 3：数据与隐私 ---
    body.appendChild(el('div', { class: 'agent-sgroup-title', text: '数据与隐私' }));
    const g3 = el('div', { class: 'agent-sgroup' });
    g3.appendChild(el('div', { class: 'agent-note', text:
      '· 学情与设置只存本机浏览器（localStorage），不上传。\n' +
      '· 对话内容不落库；只保留结构化动作序列用于复现与审计。\n' +
      '· API Key 只发往你填写的接入点，不经过任何第三方中转。' }));
    const clearBtn = el('button', { class: 'agent-btn danger', text: '清除本机全部数据' });
    clearBtn.onclick = () => {
      if (!confirm('将清除本机的设置、学情与埋点数据，且不可恢复。确定？')) return;
      try { localStorage.removeItem(KEY); localStorage.removeItem('orbit.mastery'); localStorage.removeItem('orbit.trace'); } catch (e) {}
      cache = null;
      alert('已清除。页面将刷新。');
      location.reload();
    };
    g3.appendChild(clearBtn);
    body.appendChild(g3);

    // --- 分组 4：关于 ---
    body.appendChild(el('div', { class: 'agent-sgroup-title', text: '关于' }));
    const g4 = el('div', { class: 'agent-sgroup' });
    g4.appendChild(el('div', { class: 'agent-note', html:
      '<b>轨道视界</b> · 原子轨道教学智能体<br>' +
      '纯前端 · 可离线运行 · 计算层确定性求值（防幻觉）<br>' +
      '模型：由使用者自备（BYOK），本工具不提供额度' }));
    body.appendChild(g4);

    // --- 底部 ---
    const foot = el('div', { class: 'agent-settings-foot' });
    const save = el('button', { class: 'agent-btn primary', text: '保存' });
    save.onclick = () => { collect(); close(); };
    foot.appendChild(save);
    box.appendChild(body);
    box.appendChild(foot);

    // 收集表单值
    function collect() {
      const patch = {
        endpoint: epInput.value.trim() || DEFAULTS.endpoint,
        model: modelInput.value.trim() || DEFAULTS.model,
        effort: effortSel.value,
        showReasoning: cbReason.input.checked,
        proactive: cbProactive.input.checked,
        animSpeed: +spd.value,
        playback: pbSel.value === 'auto' ? 'auto' : 'manual',
        maxTokens: Math.max(1024, Math.min(65536, Math.round(+maxTokInput.value) || 8192)),
      };
      // 只有用户真正输入过才覆盖 key（否则保留原值）
      if (keyInput.dataset.touched === '1' && keyInput.value.trim()) {
        patch.apiKey = keyInput.value.trim();
      }
      set(patch);
      return get();
    }

    overlay = el('div', { class: 'agent-overlay' }, [box]);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    return overlay;
  }

  function field(label, input, hint) {
    const f = el('div', { class: 'agent-field' });
    f.appendChild(el('label', { class: 'agent-flabel', text: label }));
    f.appendChild(input);
    if (hint) f.appendChild(el('div', { class: 'agent-fhint', text: hint }));
    return f;
  }

  function checkbox(label, checked) {
    const input = el('input', { type: 'checkbox' });
    if (checked) input.checked = true;
    const row = el('label', { class: 'agent-check' }, [input, el('span', { text: ' ' + label })]);
    return { row: row, input: input };
  }

  function open() {
    buildOverlay();
    overlay.classList.add('show');
  }
  function close() {
    if (overlay) overlay.classList.remove('show');
  }

  return { get, set, mask, hasKey, open, close, DEFAULTS, KEY };
})();
