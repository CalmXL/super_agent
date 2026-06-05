import {generateText, ModelMessage} from 'ai';

/**
 * 估算消息列表的 token 数量
 * 使用经验公式：字符数 / 4
 */
function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ('text' in part && typeof part.text === 'string') {
          chars += part.text.length;
        } else if ('output' in part) {
          chars += JSON.stringify(part.output).length;
        }
      }
    }
  }

  return Math.ceil(chars / 4);
}

// 可清理的工具列表（这些工具的结果通常很长但价值有限）
const CLEARABLE_TOOLS = new Set([
  'read_file',
  'bash',
  'grep',
  'glob',
  'list_directory',
  'edit_file',
  'write_file',
]);

// 保留最近 N 个工具结果不被清理
const KEEP_RECENT_TOOL_RESULTS = 3;

// ------ Layer 1: Microcompact --------------------------
// 轻量级压缩：将旧工具结果替换为占位符，大幅减少 token 消耗

export function microcompact(messages: ModelMessage[]): {
  messages: ModelMessage[];
  cleared: number;
} {
  let cleared = 0;

  // 收集所有 tool 角色的消息索引
  const toolResultIndices: number[] = [];

  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') toolResultIndices.push(i);
  }

  // 只清理超出保留数量的旧工具结果
  const toClear = toolResultIndices.slice(
    0,
    Math.max(0, toolResultIndices.length - KEEP_RECENT_TOOL_RESULTS),
  );

  const result = messages.map((msg, idx) => {
    // 非目标索引不处理
    if (!toClear.includes(idx)) return msg;
    // 确保是工具消息且内容是数组
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;

    // 检查工具是否在可清理白名单中
    const toolName = (msg.content[0] as any)?.toolName || 'unknown';
    if (!CLEARABLE_TOOLS.has(toolName)) return msg;

    cleared++;

    // 将实际输出替换为占位符，减少 token
    return {
      ...msg,
      content: msg.content.map((part: any) => ({
        ...part,
        output: '[tool result cleared]',
      })),
    };
  });

  return {
    messages: result,
    cleared,
  };
}

// -------- Layer 2: Summarization ----------------------------------------------
// 使用 LLM 将早期对话压缩为结构化摘要

// 压缩提示词：指导 LLM 如何生成摘要
const COMPRESS_PROMPT = `你是一个对话压缩系统。你的任务是把 Agent 和用户之间的
对话历史压缩成一份结构化摘要，确保后续对话能够无缝继续。

请严格按照以下模板输出，每个字段都要填写：

## 用户意图
（用户在这次对话中想要完成什么）

## 已完成的操作
（Agent 执行了哪些工具调用、产生了什么结果）

## 关键发现
（读取的文件内容要点、搜索结果、命令输出中的关键信息）

## 当前状态
（对话进行到哪一步了、还有什么没做完）

## 需要保留的细节
（文件路径、变量名、配置值、错误信息等不能丢失的具体内容）

注意事项：
- 用对话中使用的语言输出
- 文件路径、UUID、版本号等标识符必须原样保留，不要翻译或改写
- 不要写笼统的概述，只保留具体的、可操作的信息
- 总长度控制在 800 字以内`;

// 触发压缩的 token 阈值
const CONTEXT_TOKEN_THRESHOLD = 300;
// 压缩后保留的最近消息数量
const KEEP_RECENT_MESSAGES = 6;

// 压缩结果接口
export interface CompactionResult {
  messages: ModelMessage[];    // 压缩后的消息列表
  summary: string;             // 生成的摘要文本
  compressedCount: number;    // 被压缩的消息数量
}

/**
 * 使用 LLM 对对话历史进行压缩摘要
 * @param model - AI 模型实例
 * @param messages - 消息历史
 * @param existingSummary - 已有的摘要（用于增量压缩）
 */
export async function summarize(
  model: any,
  messages: ModelMessage[],
  existingSummary?: string,
): Promise<CompactionResult> {
  // 估算当前 token 数量
  const tokenEstimate = estimateTokens(messages);

  // 满足条件则跳过压缩
  if (
    tokenEstimate < CONTEXT_TOKEN_THRESHOLD ||
    messages.length <= KEEP_RECENT_MESSAGES
  ) {
    return {
      messages,
      summary: existingSummary || '',
      compressedCount: 0,
    };
  }

  // 计算分割点，保留最近 N 条消息
  const splitIdx = Math.max(0, messages.length - KEEP_RECENT_MESSAGES);

  // 对齐到 user 消息边界，保持对话完整性
  let alignedIdx = splitIdx;
  while (alignedIdx > 0 && messages[alignedIdx].role !== 'user') {
    alignedIdx--;
  }

  // 无法对齐则跳过
  if (alignedIdx === 0) {
    return {
      messages,
      summary: existingSummary || '',
      compressedCount: 0,
    };
  }

  // 待压缩的早期消息
  const toCompress = messages.slice(0, alignedIdx);
  // 保留的最近消息
  const toKeep = messages.slice(alignedIdx);

  // 将消息列表转换为可读文本
  const conversationText = toCompress
    .map((msg) => {
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .map((p: any) => p.text || JSON.stringify(p.output || ''))
                .join('')
            : '';

      return content ? `**${msg.role}**: ${content}` : '';
    })
    .filter(Boolean)
    .join('\n\n');

  // 无有效内容则跳过
  if (!conversationText.trim()) {
    return {
      messages,
      summary: existingSummary || '',
      compressedCount: 0,
    };
  }

  // 构建提示词：有摘要则进行增量压缩
  const userPrompt = existingSummary
    ? `## 已有摘要（上一次压缩的结果）\n\n${existingSummary}\n\n##需要压缩的新对话\n\n${conversationText}`
    : conversationText;

  try {
    // 调用 LLM 生成摘要
    const {text: summary} = await generateText({
      model,
      system: COMPRESS_PROMPT,
      prompt: userPrompt,
    });

    // 将摘要作为系统消息插入，保持上下文连贯
    const summaryMessage: ModelMessage = {
      role: 'user',
      content: `[以下是之前对话的压缩摘要]\n\n${summary}\n\n[摘要结束，以下是最近的对话]`,
    };

    const newMessages: ModelMessage[] = [summaryMessage, ...toKeep];
    return {
      messages: newMessages,
      summary,
      compressedCount: toCompress.length,
    };
  } catch (err) {
    console.error('[Compaction] LLM 摘要失败：', err);
    return {
      messages,
      summary: existingSummary || '',
      compressedCount: 0,
    };
  }
}

// 导出 token 估算函数供外部使用
export {estimateTokens};
