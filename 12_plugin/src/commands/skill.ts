import {type ModelMessage} from 'ai';
import {agentLoop} from '../agent/loop.js';
import type {CommandHandler} from './index.js';
import type {SkillLoader} from '../skills/loader.js';

/**
 * 创建与 Skill 相关的命令行处理列表
 * @param skillLoader 负责读取和解析本地技能加载器的实现
 * @param activeSkills 当前上下文中已经被激活的技能名称合集
 * @returns 返回一组 CommandHandler 数组，按顺序匹配用户输入的命令
 */
export function createSkillCommands(
  skillLoader: SkillLoader,
  activeSkills: Set<string>,
): CommandHandler[] {
  return [
    // ---------------------------------------------------------
    // 命令：/skill、 /skill list 、skill list
    // 功能：列出所有可用的技能
    // ---------------------------------------------------------
    (cmd, ctx) => {
      if (cmd !== '/skill' && cmd !== '/skill list' && cmd !== 'skill list')
        return false;
      const skills = skillLoader.list();
      if (skills.length === 0) {
        console.log(
          '\n[skills] 没有找到任何 skill。在 .skills/ 目录下创建 skill-name/SKILL.md 即可。\n',
        );
        return true;
      }
      console.log(`\n[skills] 共 ${skills.length} 个可用：`);
      for (const s of skills) {
        const active = activeSkills.has(s.name) ? ' ✓ 已激活' : '';
        console.log(`  /${s.name} — ${s.description}${active}`);
        if (s.whenToUse) console.log(`    适用场景: ${s.whenToUse}`);
      }
      console.log('');
      return true;
    },

    // ---------------------------------------------------------
    // 命令：/skill load <name>
    // 功能：激活指定的技能
    // ---------------------------------------------------------
    (cmd, ctx) => {
      const match = cmd.match(/^\/skill\s+load\s+(\S+)$/);
      if (!match) return false;
      const name = match[1];
      const skill = skillLoader.get(name);
      if (!skill) {
        console.log(`\n[skills] 找不到 skill: ${name}\n`);
        return true;
      }
      activeSkills.add(name);
      console.log(`\n[skills] 已激活: ${name} — ${skill.description}\n`);
      return true;
    },

    // ---------------------------------------------------------
    // 命令：/skill unload <name>
    // 功能：卸载指定的技能
    // ---------------------------------------------------------
    (cmd, ctx) => {
      const match = cmd.match(/^\/skill\s+unload\s+(\S+)$/);
      if (!match) return false;
      const name = match[1];
      if (!activeSkills.has(name)) {
        console.log(`\n[skills] ${name} 未激活\n`);
        return true;
      }
      activeSkills.delete(name);
      console.log(`\n[skills] 已卸载: ${name}\n`);
      return true;
    },

    // ---------------------------------------------------------
    // 命令：/<skill-name> [args]
    // 功能: 动态指令匹配。直接使用斜杠+技能名 如 /code-review 贴入代码
    //      自动激活并触发该技能对应的 Agent 对话逻辑
    // ---------------------------------------------------------
    (cmd, ctx) => {
      if (!cmd.startsWith('/')) return false;
      const parts = cmd.slice(1).split(/\s+/);
      const name = parts[0];

      // 尝试获取同名技能。如果不存在，返回 false。
      const skill = skillLoader.get(name);
      if (!skill) return false;

      // 自动激活技能
      activeSkills.add(name);
      console.log(`\n[skills] 激活 ${name}，开始执行...`);

      const args = parts.slice(1).join(' ');
      const content = args
        ? `${skill.content}\n\n用户指令: ${args}`
        : skill.content;

      // 构件要发送给大模型的新消息，并推入当前对话上下文
      const userMsg: ModelMessage = {role: 'user', content};
      ctx.messages.push(userMsg);
      ctx.timestamps.set(ctx.messages.length - 1, Date.now());
      ctx.sessionStore.append(userMsg);

      // 构件当前系统 Prompt 状态，并记录当前消息列表长度
      const currentSystem = ctx.builder.build(ctx.makePromptCtx());
      const beforeLen = ctx.messages.length;

      agentLoop(
        ctx.model,
        ctx.registry,
        ctx.messages,
        currentSystem,
        ctx.tracker,
      ).then(() => {
        const newMessages = ctx.messages.slice(beforeLen);
        const now = Date.now();
        for (let i = beforeLen; i < ctx.messages.length; i++)
          ctx.timestamps.set(i, now);
        ctx.sessionStore.appendAll(newMessages);
        ctx.ask();
      });

      return 'async';
    },
  ];
}
