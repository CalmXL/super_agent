/**
 * Prompt 上下文接口，包含构建 prompt 所需的运行时信息
 */
export interface PromptContext {
  /** 当前可用的工具数量 */
  toolCount: number;
  /** 延迟工具的描述摘要，仅在需要额外工具时非空 */
  deferredToolSummary: string;
  /** 当前会话的历史消息数 */
  sessionMessageCount: number;
  /** 会话的唯一标识 ID */
  sessionId: string;
}

/**
 * Pipe 函数类型
 * 接收 PromptContext，返回一段文本或 null（返回 null 表示该 pipe 不生效）
 */
type PipeFn = (ctx: PromptContext) => string | null;

/**
 * PromptBuilder —— 基于 pipe 模式的 prompt 构建器
 *
 * 工作原理：
 * - 通过 .pipe() 注册多个"管道"（每个管道是一个命名函数）
 * - 调用 build() 时，依次执行所有 pipe，收集非 null 的返回结果
 * - 所有结果用空行（\n\n）拼接，形成最终的 prompt 字符串
 *
 * 这种模式的好处：
 * - 每个 pipe 职责单一，可以独立开关
 * - 新增/删除/调整 prompt 片段不影响其他部分
 * - debug() 方法可以直观看到每个 pipe 的生效状态和输出长度
 */
export class PromptBuilder {
  /** 存储所有注册的 pipe，每个 pipe 包含名称和函数 */
  private pipes: Array<{ name: string; fn: PipeFn }> = [];

  /**
   * 注册一个新的 pipe
   * @param name - pipe 的名称，用于 debug 标识
   * @param fn   - pipe 函数，返回文本片段或 null（不生效）
   * @returns this 实例，支持链式调用
   */
  pipe(name: string, fn: PipeFn): this {
    this.pipes.push({ name, fn });
    return this;
  }

  /**
   * 执行所有 pipe 并组装最终的 prompt
   *
   * 遍历 pipes 数组，逐个调用 pipe 函数：
   * - 如果返回 null，则跳过该片段
   * - 如果返回字符串，则收集到 sections 数组中
   * 最后用双换行符（\n\n）连接所有片段
   *
   * @param ctx - 当前 prompt 上下文
   * @returns 组装完成的 prompt 字符串
   */
  build(ctx: PromptContext): string {
    const sections: string[] = [];

    for (const { fn } of this.pipes) {
      const result = fn(ctx);
      if (result !== null) {
        sections.push(result);
      }
    }

    return sections.join('\n\n');
  }

  /**
   * 调试模式：打印每个 pipe 的生效状态
   *
   * 输出格式：
   *   pipe名称: [ON] N chars   → pipe 生效，输出了 N 个字符
   *   pipe名称: [OFF]          → pipe 返回 null，未生效
   */
  debug(ctx: PromptContext): void {
    console.log('\n=== Prompt Pipe Debug ===');
    for (const { name, fn } of this.pipes) {
      const result = fn(ctx);
      const status = result !== null ? `[ON] ${result.length} chars` : '[OFF]';
      console.log(`  ${name}: ${status}`);
    }
    console.log('========================\n');
  }
}

// ── 预定义的 Pipe 工厂函数 ────────────────────────────────

/**
 * 核心规则 pipe
 *
 * 始终生效（不依赖上下文），返回 AI 助手的基础行为约束：
 * - 先读后写，不凭记忆编辑
 * - 不 scope creep
 * - 工具调用失败时换思路而非重试
 * - 简洁直接回答
 */
export function coreRules(): PipeFn {
  return () => `你是 Super Agent，一个有工具调用能力的 AI 助手。
你的行为准则：
- 先读文件再修改，不要凭记忆编辑
- 不要加没被要求的功能
- 工具调用失败时，换一个思路而不是重复同样的操作
- 回答要简洁直接`;
}

/**
 * 工具指引 pipe
 *
 * 仅当存在可用工具（toolCount > 0）时生效。
 * 告知 AI 当前可用的工具数量，并提示使用方式（内置工具 vs MCP 工具）。
 */
export function toolGuide(): PipeFn {
  return (ctx) => {
    if (ctx.toolCount === 0) return null;
    return `你有 ${ctx.toolCount} 个工具可用。需要操作本地文件时使用内置工具，需要访问外部服务时使用 MCP 工具。`;
  };
}

/**
 * 延迟工具 pipe
 *
 * 当 deferredToolSummary 不为空时生效。
 * 提示 AI 可以通过 tool_search 搜索并获取当前列表中未出现的工具。
 * deferredToolSummary 通常来自注册中心的延迟工具描述。
 */
export function deferredTools(): PipeFn {
  return (ctx) => {
    if (!ctx.deferredToolSummary) return null;
    return `如果你需要的工具不在当前列表中，使用 tool_search 工具搜索。${ctx.deferredToolSummary}`;
  };
}

/**
 * 会话上下文 pipe
 *
 * 当会话中有历史消息（sessionMessageCount > 0）时生效。
 * 提供当前会话的 ID 和历史消息数量，帮助 AI 理解对话的连续性。
 */
export function sessionContext(): PipeFn {
  return (ctx) => {
    if (ctx.sessionMessageCount === 0) return null;
    return `[会话信息] 当前会话 ${ctx.sessionId}，已有 ${ctx.sessionMessageCount} 条历史消息。`;
  };
}
