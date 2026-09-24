/**
 * conv-store.js — 对话存储：多会话 / 分支树 / 持久化
 *
 * 为什么要有它：原先对话历史只是 agent-core.js 里的一个模块内数组 `let history = []`，
 * 刷新即失；而界面上的消息气泡是纯 DOM，与 history **不是 1:1**（演示旁白、动作气泡、
 * 题目卡都不进 history）。要做"持久化 / fork / 编辑 / 复制"，就必须先有一个能同时
 * 表达"协议历史"与"展示消息"的数据模型。
 *
 * 设计要点：
 *   · 用 `parent` 单亲指针把消息连成**一棵树**，扁平存在 nodes 里 —— 一条消息全局只存
 *     一份，任何 fork 都不复制已存在的字节。"共享前缀"是结构自带的，不需要"前缀共享 +
 *     分支点索引"之类的额外机制，也不单独存 branches 数组（存了就有两处真相）。
 *   · `leaf` 指向"当前分支的末端"；分支 = 根到 leaf 的一条路径，随时可以算出来。
 *     切分支只是**移动一个指针**（节点从不删除），所以"切回旧分支时后续消息还在"是
 *     自然结果，而不是需要额外维护的性质。
 *   · `projection()` 把当前路径投影成 OpenAI messages —— 它是**纯函数**，因此不可能出现
 *     "裁剪后 tool_calls 悬空"这类不一致（history 降级为派生量，不再双写）。
 *   · 角色为 'card' 的节点（题目卡 / 反馈卡 / 主动提示卡）**留在链上、参与路径，但被
 *     投影过滤掉** —— 这就是"展示消息也持久化、却不污染协议历史"的全部机制；
 *     顺序也天然正确（card 真的夹在两条消息之间），不需要额外的映射表。
 *
 * ★ 本模块**不引用 document**：这样它能被 node 直接加载跑断言（本环境没有浏览器自动化
 *   工具，这是唯一能自动化验证的那部分逻辑）。依赖只有 localStorage。
 */
window.ConvStore = (function () {
  'use strict';

  const IDX_KEY = 'orbit.agent.conv';           // 索引（小、写频繁）
  const DOC_PREFIX = 'orbit.agent.conv.';       // 单会话正文（大、按会话隔离）
  const V = 1;
  // 上限（数值连同"为什么"）：
  //   · 会话数：一个会话一回合约 10–20KB（工具结果 + reasoning），20 个足够日常使用，
  //     再多就该让用户先删旧的，而不是无声地把 localStorage 撑爆。
  //   · 节点数：超出后优先裁"不在当前路径上的最老分支"。
  const MAX_SESSIONS = 20;
  const MAX_NODES_PER_SESSION = 400;
  const MAX_TOOL_CHARS = 2000;                  // 工具结果超出即截断（见 append 里的说明）
  const MAX_REASONING_CHARS = 4000;
  const SAVE_DEBOUNCE_MS = 400;

  let idx = null;          // 索引文档
  let doc = null;          // 当前会话文档
  let persist = true;      // 写盘是否可用（配额满 / 无痕模式下置 false）
  let saveTimer = null;
  const listeners = [];

  // ---- 小工具 ---------------------------------------------------------------

  function now() { return Date.now(); }

  function newSessionId() {
    return 's-' + now().toString(36) + Math.random().toString(36).slice(2, 5);
  }

  function isQuotaError(e) {
    if (!e) return false;
    return e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014;
  }

  function notify(what) {
    for (let i = 0; i < listeners.length; i++) {
      try { listeners[i](what); } catch (e) { /* 监听器出错不该影响存储 */ }
    }
  }

  /** 读 JSON：坏数据一律当空（照 state-editor.js 的做法，不抛） */
  function readJson(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  /**
   * 写盘：**永不向上抛** —— 写失败绝不能打断对话。
   * 配额阶梯：① 淘汰最旧的非活动会话（最多连试 3 次）② 放弃并置 persist=false。
   * ★ 置 false 后不再尝试写：Safari 无痕下任何写都抛且配额为 0，
   *   不这么做会变成"每条消息一次 try/catch 风暴"。
   */
  function safeSet(key, str) {
    if (!persist) return false;
    try { localStorage.setItem(key, str); return true; }
    catch (e) {
      if (isQuotaError(e)) {
        for (let i = 0; i < 3; i++) {
          if (!evictOldestInactiveSession()) break;
          try { localStorage.setItem(key, str); return true; } catch (e2) { /* 再试 */ }
        }
      }
      persist = false;
      notify('persist-off');
      return false;
    }
  }

  function evictOldestInactiveSession() {
    if (!idx || idx.sessions.length <= 1) return false;
    const cand = idx.sessions
      .filter(function (s) { return s.id !== idx.active; })
      .sort(function (a, b) { return (a.updatedAt || 0) - (b.updatedAt || 0); });
    if (!cand.length) return false;
    const victim = cand[0];
    try { localStorage.removeItem(DOC_PREFIX + victim.id); } catch (e) { /* 忽略 */ }
    idx.sessions = idx.sessions.filter(function (s) { return s.id !== victim.id; });
    return true;
  }

  // ---- 树操作 ---------------------------------------------------------------

  function nodes() { return doc ? doc.nodes : {}; }

  function nodeById(id) { return nodes()[id] || null; }

  /** 某节点的孩子（按 seq 升序）；返回 {id, n} 以便调用方拿到 id */
  function children(id) {
    const out = [];
    const ns = nodes();
    for (const k in ns) {
      if (ns[k].parent === id) out.push({ id: k, n: ns[k] });
    }
    out.sort(function (a, b) { return a.n.seq - b.n.seq; });
    return out;
  }

  /**
   * seq → 节点 id 的反查表。
   * path() 返回的是节点对象本身，而 UI（dataset.mid）需要 id；逐个反查是 O(N)，
   * 渲染时会对每个节点都调一次 → O(N²)。建一次表即可。
   */
  function idMap() {
    const out = Object.create(null);
    const ns = nodes();
    for (const k in ns) out[ns[k].seq] = k;
    return out;
  }

  /** 根 → 该节点的路径（带 visited 与步数上限防环） */
  function chainTo(nodeId) {
    const ns = nodes();
    if (!nodeId || !ns[nodeId]) return [];
    const chain = [];
    const seen = Object.create(null);
    let cur = nodeId;
    while (cur && ns[cur] && !seen[cur]) {
      seen[cur] = 1;
      chain.push(ns[cur]);
      cur = ns[cur].parent;
      if (chain.length > 1000) break;
    }
    chain.reverse();
    return chain;
  }

  /** 当前分支（根 → leaf） */
  function path(leafId) {
    const target = leafId || (doc && doc.leaf);
    return target ? chainTo(target) : [];
  }

  /**
   * 投影成 OpenAI messages。
   * ★ 每次生成**全新的对象**（而非共享引用）—— 现有 getHistory() 的 history.slice()
   *   是浅拷贝，fork 时两边会共享同一批消息对象，任何一方改写都会污染另一方。
   */
  function projection(leafId) {
    return path(leafId)
      .filter(function (n) { return n.role !== 'card'; })
      .map(function (n) {
        if (n.role === 'tool') {
          return { role: 'tool', tool_call_id: n.tool_call_id, content: n.content };
        }
        const m = { role: n.role, content: n.content || '' };
        if (n.tool_calls && n.tool_calls.length) {
          m.tool_calls = n.tool_calls.map(function (tc) {
            return {
              id: tc.id,
              type: tc.type || 'function',
              function: { name: tc.function.name, arguments: tc.function.arguments },
            };
          });
        }
        return m;
      });
  }

  /**
   * 追加节点。parent 缺省取当前 leaf；追加后 **leaf 移向新节点**（连续 append 自然成链）。
   *
   * ★ 工具结果在**进入 store 时**就按上限截断，而不是写盘时才截 —— 否则"内存里全量、
   *   存档里截断"就成了两套内容，会制造"刷新前后模型行为不一致"这种最难查的 bug。
   */
  function append(node, parentId) {
    if (!doc) doc = blankDoc();
    const pid = (parentId !== undefined) ? parentId : doc.leaf;
    const id = 'm' + (++doc.seq);
    const n = Object.assign({}, node, { seq: doc.seq, parent: pid || null, ts: now() });
    if (typeof n.content !== 'string') n.content = '';
    if (n.role === 'tool' && n.content.length > MAX_TOOL_CHARS) {
      n.content = n.content.slice(0, MAX_TOOL_CHARS) + '…（内容因本机存储上限被截断）';
      n._trimmed = true;
    }
    if (typeof n.reasoning === 'string' && n.reasoning.length > MAX_REASONING_CHARS) {
      n.reasoning = n.reasoning.slice(0, MAX_REASONING_CHARS - 800)
        + '\n…（略）\n' + n.reasoning.slice(-800);
    }
    doc.nodes[id] = n;
    doc.leaf = id;
    touch();
    scheduleSave();
    return id;
  }

  function appendUser(text, origin) {
    return append({ role: 'user', content: text, origin: origin || 'user' });
  }

  function appendCard(kind, meta) {
    return append({ role: 'card', kind: kind, content: '', meta: meta || {} });
  }

  /** 就地改字段（题目卡的 answered、主动提示卡的 dismissed 之类） */
  function patch(nodeId, fields) {
    const n = nodeById(nodeId);
    if (!n) return false;
    Object.assign(n, fields);
    touch();
    scheduleSave();
    return true;
  }

  /**
   * 协议修复：保证投影出的 messages 里，"assistant 的每个 tool_call_id 都有配对的
   * tool 结果"。缺的就地为**当前分支**补一条合成结果（与 agent-core 中止时的回灌同形）。
   *
   * 什么时候会缺：工具循环中途若 onToolCall 抛异常，异常逃到外层 catch，剩余结果不会
   * 被回灌 —— 历史尾部就留下悬空的 tool_calls，下一次请求被 OpenAI 协议判 400，
   * 用户只看到"这个会话突然不能用了"。把它前移到每次组装 messages 之前，这个洞一并堵上。
   *
   * ★ 补位节点挂在**当前 leaf 之下**（而不是挂到那个 assistant 之下）：后者会让 leaf
   *   改道、丢掉路径上已有的 tool 结果。
   */
  function ensureValid() {
    if (!doc) return;
    const chain = path();
    let lastAsst = null;
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].role === 'assistant' && chain[i].tool_calls && chain[i].tool_calls.length) {
        lastAsst = chain[i];
        break;
      }
    }
    if (!lastAsst) return;
    const have = Object.create(null);
    for (let i = 0; i < chain.length; i++) {
      if (chain[i].role === 'tool') have[chain[i].tool_call_id] = 1;
    }
    let added = 0;
    lastAsst.tool_calls.forEach(function (tc) {
      if (have[tc.id]) return;
      append({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify({ aborted: true, note: '（该调用未执行，已自动补位）' }),
      });
      added++;
    });
    if (added) scheduleSave();
  }

  /**
   * 从某节点分叉：把 leaf 移过去，再修一次协议。
   * ★ 分叉**不是"创建"动作，只是移动一个指针** —— 节点一个都不删，
   *   所以切回旧分支时它的后续消息都还在。
   */
  function branchFrom(nodeId) {
    if (!nodeById(nodeId)) return false;
    doc.leaf = nodeId;
    ensureValid();
    touch();
    scheduleSave();
    return true;
  }

  /** 切到某条分支：移到以该节点为起点的那条分支的**最深叶**（用户想看的是结果，不是分叉点） */
  function switchLeaf(nodeId) {
    if (!nodeById(nodeId)) return false;
    let cur = nodeId;
    for (let guard = 0; guard < 1000; guard++) {
      const ch = children(cur);
      if (!ch.length) break;
      cur = ch[ch.length - 1].id;
    }
    doc.leaf = cur;
    ensureValid();
    touch();
    scheduleSave();
    return true;
  }

  /** 该节点所属回合的起点（最近的 user 节点，含 internal / continuation 的） */
  function turnStart(nodeId) {
    const chain = chainTo(nodeId);
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].role === 'user') return chain[i];
    }
    return null;
  }

  /** 该回合在**当前路径**上的最后一个节点（「重答」要把切点放在它后面） */
  function lastNodeOfTurn(nodeId) {
    const st = turnStart(nodeId);
    if (!st) return nodeById(nodeId);
    const chain = path();
    let last = st, seen = false;
    for (let i = 0; i < chain.length; i++) {
      if (chain[i].seq === st.seq) seen = true;
      if (seen) last = chain[i];
    }
    return last;
  }

  /** 同一 parent 下的兄弟节点 id（用于分支条：只在真正分叉处才 > 1） */
  function siblings(nodeId) {
    const n = nodeById(nodeId);
    if (!n) return [];
    if (!n.parent) return [nodeId];
    return children(n.parent).map(function (c) { return c.id; });
  }

  // ---- 会话管理 -------------------------------------------------------------

  function blankDoc(id) {
    return { v: V, id: id || '', seq: 0, nodes: {}, leaf: null, title: '' };
  }

  function activeMeta() {
    if (!idx || !idx.active) return null;
    return idx.sessions.filter(function (s) { return s.id === idx.active; })[0] || null;
  }

  function loadDoc(id) {
    const d = readJson(DOC_PREFIX + id);
    if (!d || typeof d !== 'object' || !d.nodes || typeof d.nodes !== 'object') return blankDoc(id);
    if (d.v != null && d.v !== V) {
      // 未知版本：只读不写，免得旧代码把新格式写坏
      persist = false;
      notify('persist-off');
    }
    // 逐条校验，坏数据丢弃（照 state-editor.js 的 loadCustomPresets）
    const clean = {};
    for (const k in d.nodes) {
      const n = d.nodes[k];
      if (!n || typeof n !== 'object') continue;
      if (['user', 'assistant', 'tool', 'card'].indexOf(n.role) < 0) continue;
      if (typeof n.content !== 'string') continue;
      if (n.role === 'tool' && typeof n.tool_call_id !== 'string') continue;
      if (n.tool_calls && !Array.isArray(n.tool_calls)) continue;
      clean[k] = n;
    }
    // 父缺失 → 当作根（走链时有 visited 保护，环也不会死循环）
    for (const k in clean) {
      if (clean[k].parent && !clean[clean[k].parent]) clean[k].parent = null;
    }
    let maxSeq = 0;
    for (const k in clean) if (clean[k].seq > maxSeq) maxSeq = clean[k].seq;
    const out = {
      v: V, id: d.id || id, title: d.title || '',
      seq: Math.max(d.seq || 0, maxSeq),
      nodes: clean, leaf: null,
    };
    // leaf 兜底：索引里记的无效时，退回到"从根沿最后一个孩子走到的最深叶"
    const meta = idx && idx.sessions.filter(function (s) { return s.id === id; })[0];
    if (meta && meta.leaf && clean[meta.leaf]) out.leaf = meta.leaf;
    else out.leaf = deepestLeafIn(out);
    return out;
  }

  function deepestLeafIn(d) {
    const roots = Object.keys(d.nodes).filter(function (k) { return !d.nodes[k].parent; });
    if (!roots.length) return null;
    roots.sort(function (a, b) { return d.nodes[a].seq - d.nodes[b].seq; });
    let cur = roots[0];
    for (let guard = 0; guard < 1000; guard++) {
      const kids = Object.keys(d.nodes).filter(function (k) { return d.nodes[k].parent === cur; });
      if (!kids.length) break;
      kids.sort(function (a, b) { return d.nodes[a].seq - d.nodes[b].seq; });
      cur = kids[kids.length - 1];
    }
    return cur;
  }

  function saveIndex() {
    if (!idx) return;
    if (idx.sessions.length > MAX_SESSIONS) {
      // 淘汰最旧的非活动会话（确认交给调用方，这里只做数据侧）
      const extra = idx.sessions.length - MAX_SESSIONS;
      const cand = idx.sessions
        .filter(function (s) { return s.id !== idx.active; })
        .sort(function (a, b) { return (a.updatedAt || 0) - (b.updatedAt || 0); })
        .slice(0, extra);
      cand.forEach(function (v) {
        try { localStorage.removeItem(DOC_PREFIX + v.id); } catch (e) { /* 忽略 */ }
      });
      idx.sessions = idx.sessions.filter(function (s) { return cand.indexOf(s) < 0; });
    }
    safeSet(IDX_KEY, JSON.stringify(idx));
  }

  /** 把当前会话的元数据同步进索引（leaf / updatedAt / count / bytes） */
  function touch() {
    if (!doc) return;
    const meta = activeMeta();
    const str = JSON.stringify(doc);
    doc.bytes = str.length;
    if (meta) {
      meta.leaf = doc.leaf;
      meta.updatedAt = now();
      meta.count = Object.keys(doc.nodes).length;
      meta.bytes = str.length;
      if (!meta.title && doc.title) meta.title = doc.title;
    }
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () { saveTimer = null; flush(); }, SAVE_DEBOUNCE_MS);
  }

  /** 立即落盘（回合边界、pagehide、结构性操作都该调它） */
  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!doc || !idx) return;
    trimNodes();
    touch();
    safeSet(DOC_PREFIX + doc.id, JSON.stringify(doc));
    saveIndex();
  }

  /**
   * 节点数超限时裁剪：优先裁"**不在当前活动路径上**的最老分支" —— 那条分支已经离开
   * 视线的，保留分叉点与分支条，内容置 trimmed，切回去会看到一条灰色说明。
   */
  function trimNodes() {
    if (!doc) return false;
    const keys = Object.keys(doc.nodes);
    if (keys.length <= MAX_NODES_PER_SESSION) return false;
    const onPath = Object.create(null);
    path().forEach(function (n) { onPath[n.seq] = 1; });
    const off = keys
      .filter(function (k) { return !onPath[doc.nodes[k].seq]; })
      .sort(function (a, b) { return doc.nodes[a].seq - doc.nodes[b].seq; });
    let over = keys.length - MAX_NODES_PER_SESSION;
    for (let i = 0; i < off.length && over > 0; i++) {
      delete doc.nodes[off[i]];
      over--;
    }
    doc.trimmed = true;
    return true;
  }

  // ---- 对外 API -------------------------------------------------------------

  function load() {
    idx = readJson(IDX_KEY);
    if (!idx || typeof idx !== 'object' || !Array.isArray(idx.sessions)) {
      idx = { v: V, active: null, sessions: [] };
    }
    if (!idx.sessions.length) {
      const id = newSessionId();
      idx.sessions.push({
        id: id, title: '', createdAt: now(), updatedAt: now(),
        leaf: null, count: 0, bytes: 0, trimmed: false,
      });
      idx.active = id;
      doc = blankDoc(id);
      saveIndex();
      return;
    }
    const ok = idx.sessions.some(function (s) { return s.id === idx.active; });
    if (!ok) idx.active = idx.sessions[0].id;
    doc = loadDoc(idx.active);
    ensureValid();
    return;
  }

  function newSession(title) {
    flush();
    const id = newSessionId();
    idx.sessions.push({
      id: id, title: title || '', createdAt: now(), updatedAt: now(),
      leaf: null, count: 0, bytes: 0, trimmed: false,
    });
    idx.active = id;
    doc = blankDoc(id);
    saveIndex();
    notify('session');
    return id;
  }

  function switchSession(id) {
    if (!idx || id === idx.active) return false;
    if (!idx.sessions.some(function (s) { return s.id === id; })) return false;
    flush();
    idx.active = id;
    doc = loadDoc(id);
    ensureValid();
    saveIndex();
    notify('session');
    return true;
  }

  function renameSession(id, title) {
    const meta = idx && idx.sessions.filter(function (s) { return s.id === id; })[0];
    if (!meta) return false;
    meta.title = String(title || '').slice(0, 40);
    if (id === idx.active && doc) doc.title = meta.title;
    meta.updatedAt = now();
    saveIndex();
    if (id === idx.active) scheduleSave();
    notify('session');
    return true;
  }

  function deleteSession(id) {
    if (!idx) return false;
    if (idx.sessions.length <= 1) return false;      // 至少留一个
    const meta = idx.sessions.filter(function (s) { return s.id === id; })[0];
    if (!meta) return false;
    try { localStorage.removeItem(DOC_PREFIX + id); } catch (e) { /* 忽略 */ }
    idx.sessions = idx.sessions.filter(function (s) { return s.id !== id; });
    if (idx.active === id) {
      idx.active = idx.sessions[0].id;
      doc = loadDoc(idx.active);
      ensureValid();
    }
    saveIndex();
    notify('session');
    return true;
  }

  function sessions() {
    return idx ? idx.sessions.slice() : [];
  }

  function stats() {
    let total = 0;
    if (idx) idx.sessions.forEach(function (s) { total += (s.bytes || 0); });
    return {
      sessions: idx ? idx.sessions.length : 0,
      bytes: total,
      persist: persist,
      active: idx ? idx.active : null,
      nodes: doc ? Object.keys(doc.nodes).length : 0,
    };
  }

  /** 清空当前会话内容（保留会话本身）—— 取代原先无人调用的 AgentCore.reset() */
  function clearActiveSession() {
    if (!doc) return false;
    doc = blankDoc(doc.id);
    const meta = activeMeta();
    if (meta) { meta.leaf = null; meta.count = 0; meta.bytes = 0; meta.title = ''; }
    flush();
    notify('session');
    return true;
  }

  function reset() {
    try {
      localStorage.removeItem(IDX_KEY);
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(DOC_PREFIX) === 0) keys.push(k);
      }
      keys.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) { /* 忽略 */ }
    idx = null; doc = null;
    load();
    notify('session');
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  return {
    // 读
    path: path, projection: projection, nodeById: nodeById, children: children, idMap: idMap,
    activeLeafId: function () { return doc ? doc.leaf : null; },
    activeSessionId: function () { return idx ? idx.active : null; },
    sessions: sessions, stats: stats,
    isEmpty: function () { return !doc || !Object.keys(doc.nodes).length; },
    // 结构写
    append: append, appendUser: appendUser, appendCard: appendCard, patch: patch,
    branchFrom: branchFrom, switchLeaf: switchLeaf, ensureValid: ensureValid,
    turnStart: turnStart, lastNodeOfTurn: lastNodeOfTurn, siblings: siblings,
    // 会话
    newSession: newSession, switchSession: switchSession, renameSession: renameSession,
    deleteSession: deleteSession, clearActiveSession: clearActiveSession,
    // 持久化
    load: load, flush: flush, scheduleSave: scheduleSave, reset: reset, onChange: onChange,
    // 常量（供 UI 显示上限）
    MAX_SESSIONS: MAX_SESSIONS, MAX_NODES_PER_SESSION: MAX_NODES_PER_SESSION,
  };
})();
