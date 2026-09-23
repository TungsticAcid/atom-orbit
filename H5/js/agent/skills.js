/**
 * skills.js — 教学技能加载器（渐进式披露）
 *
 * 与 knowledge.js 同理：技能以 <script> 自注册（离线可用），
 * 系统提示里只放【名称 + 一句话说明】，完整步骤由模型按需 loadSkill(name) 拉取。
 *
 * 技能 = 面向**过程**的方法（怎么教），知识 = 面向**内容**的事实（教什么）。
 * 二者分层存放：知识被多个节点共享（集中），技能被多个教学场景调用（集中），
 * 而各节点自己的角色指令则就近放在模块目录里（见各 prompt.md）。
 */
window.Skills = (function () {
  'use strict';

  const skills = Object.create(null);

  function register(list) {
    (list || []).forEach(function (s) { if (s && s.name) skills[s.name] = s; });
  }

  function index() {
    return Object.keys(skills).map(function (n) {
      return { name: n, title: skills[n].title, desc: skills[n].desc, when: skills[n].when };
    });
  }

  function load(name) {
    const s = skills[name];
    if (!s) return null;
    return {
      name: s.name, title: s.title,
      when: s.when, steps: s.steps, phrases: s.phrases || [],
      exit: s.exit, cautions: s.cautions || [],
    };
  }

  /** 发起费曼式复述：返回邀请语与评分要点（供 evaluateFeynman 参考） */
  function startFeynman(knowledgePoint) {
    const s = skills['feynman'];
    if (!s) return { error: '费曼技能未注册' };
    return {
      skill: 'feynman',
      knowledgePoint: knowledgePoint,
      invitation: '试着用**你自己的话**说一遍，就当我是完全没学过的同学——不要背公式，讲你理解的那个版本。',
      rubric: s.steps && s.steps.length ? s.steps : [],
      note: '学生复述后调用 evaluateFeynman 评估',
    };
  }

  return { register, index, load, startFeynman, count: function () { return Object.keys(skills).length; } };
})();
