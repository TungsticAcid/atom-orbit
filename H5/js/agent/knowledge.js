/**
 * knowledge.js — 知识库加载器（渐进式披露）
 *
 * ★ 关键设计：知识正文以 <script> 自注册的方式加载（见 knowledge/entries/index.js），
 *   而不是运行时 fetch(.md)。原因是浏览器在 file:// 下会以 opaque origin 拦截 fetch，
 *   这会让"双击离线可用"这一核心资产失效。
 *
 * ★ 但渐进式披露依然成立：脚本加载 ≠ 进入 LLM 上下文。
 *   系统提示里只放【清单】（id / 知识点 / 标题 / 关键词），
 *   正文只有在模型调用 loadKnowledge(id) 时才被注入对话。
 *
 * ★ 单一事实来源：讲解、出题、诊断三个节点都引用这里的同一份内容，
 *   杜绝"出题数值 ≠ 讲解数值"这类教学事故。
 */
window.Knowledge = (function () {
  'use strict';

  const entries = Object.create(null);

  /** 由 knowledge/entries/index.js 调用 */
  function register(list) {
    (list || []).forEach(function (e) {
      if (e && e.id) entries[e.id] = e;
    });
  }

  /** 清单（进系统提示的那部分，不含正文） */
  function index() {
    return Object.keys(entries).sort().map(function (id) {
      const e = entries[id];
      return { id: e.id, kp: e.kp, title: e.title, keywords: e.keywords || [] };
    });
  }

  /** 按需取正文 */
  function load(id) {
    const e = entries[id];
    if (!e) return null;
    return {
      id: e.id, kp: e.kp, title: e.title,
      body: e.body,
      source: e.source || '',
      misconceptions: e.misconceptions || [],
    };
  }

  /** 取某知识点的全部条目（供讲解节点组织内容） */
  function byKnowledgePoint(kp) {
    return Object.keys(entries)
      .filter(function (id) { return entries[id].kp === kp; })
      .sort()
      .map(function (id) { return load(id); });
  }

  return { register, index, load, byKnowledgePoint, count: function () { return Object.keys(entries).length; } };
})();
