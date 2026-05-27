// 导入 AI SDK 的消息类型定义，用于表示对话中的消息结构
import type {ModelMessage} from 'ai';

// ── Layer 1: Token 估算 ────────────────────────
// 追踪并估算当前上下文的 token 消耗，当接近窗口上限时触发防线动作

/**
 * Token 追踪器
 * 结合 API 返回的精确 token 数和本地字符估算，提供实时 token 水位
 */
export class TokenTracker {
  // 上次 API 返回的精确 prompt_tokens 数，作为估算基准
  private lastPreciseCount = 0;
  // 上次 API 调用后新增的字符数，用于本地增量估算
  private pendingChars = 0;

  /**
   * 用 API 返回的精确 prompt_tokens 校准计数器
   * 每次 LLM 调用后调用此方法，重置 pending 计数
   */
  updateFromAPI(promptTokens: number): void {
    // 更新精确 token 数为 API 返回的值
    this.lastPreciseCount = promptTokens;
    // 重置待处理字符计数，因为已通过 API 精确值校准
    this.pendingChars = 0;
  }

  /**
   * 记录新增消息的字符数
   * 用于在两次 API 调用之间做本地近似估算
   */
  addMessage(content: string): void {
    // 累加新增内容的字符长度
    this.pendingChars += content.length;
  }

  /**
   * 估算当前总 token 数
   * 公式：上次 API 精确值 + 新增字符数 / 4（平均每 token 4 字符）
   */
  get estimatedTokens(): number {
    // 返回上次精确值 + 新增字符估算值
    return this.lastPreciseCount + Math.ceil(this.pendingChars / 4);
  }

  /**
   * 返回当前状态摘要
   * 包含估算 token 数、占窗口百分比、是否需要触发告警
   */
  get status(): {tokens: number; percent: number; needsAction: boolean} {
    // 获取当前估算 token 数
    const tokens = this.estimatedTokens;
    // 计算占上下文窗口的百分比
    const percent = Math.round((tokens / CONTEXT_WINDOW) * 100);
    return {
      tokens,            // 当前估算 token 数
      percent,           // 百分比
      needsAction: percent >= 75,  // 超过 75% 窗口容量时标记为需要干预
    };
  }
}

/**
 * 假设的上下文窗口大小
 * 参考 Claude 200K 模型的上下文窗口，单位 token
 */
const CONTEXT_WINDOW = 200_000;

/**
 * 估算消息列表的 token 数（独立函数版）
 * 公式：全部字符数 / 4 × 1.2（中文安全系数）
 * 遍历每条消息，累加 text 字段和 tool output 字段的字符数
 */
export function estimateMessageTokens(messages: ModelMessage[]): number {
  // 初始化字符计数器
  let chars = 0;
  // 遍历所有消息
  for (const msg of messages) {
    // 如果消息内容是纯字符串类型
    if (typeof msg.content === 'string') {
      // 直接累加字符串长度
      chars += msg.content.length;
    // 如果消息内容是数组类型（包含多个 content part）
    } else if (Array.isArray(msg.content)) {
      // 遍历数组中的每个 content part
      for (const part of msg.content) {
        // 如果 part 包含 text 字段（模型生成的文本回复）
        if ('text' in part && typeof part.text === 'string') {
          // 累加 text 内容的字符数
          chars += part.text.length;
        // 如果 part 包含 output 字段（工具调用的结果）
        } else if ('output' in part) {
          // 将 output 统一转为字符串：已经是字符串则直接用，否则 JSON 序列化
          const out =
            typeof part.output === 'string'
              ? part.output
              : JSON.stringify(part.output);
          // 累加 output 内容的字符数
          chars += out.length;
        }
      }
    }
  }
  // 按 4 字符/token 换算，再乘以 1.2 的中文安全系数（中文占更多 token）
  return Math.ceil((chars / 4) * 1.2);
}

// ── Layer 2: 动态工具结果截断 ──────────────────
// 两条策略：
//   Pass 1 — 单条超长结果按 Head 60% / Tail 40% 截断，保留关键信息
//   Pass 2 — 整体字符预算超额时，从最早的消息开始逐一压缩为占位符

/**
 * 截断配置接口
 * 控制单条结果和总预算的字符上限
 */
interface TruncationConfig {
  // 单条工具结果的最大字符数，超过则触发 Head/Tail 截断
  maxSingleResult: number;
  // 所有工具结果的总字符预算，超过则从旧到新压缩
  contextBudgetChars: number;
}

/**
 * 默认截断配置
 * maxSingleResult: 窗口 50% × 2 char/token 的粗略换算
 * contextBudgetChars: 窗口 75% × 4 char/token，为其他消息预留空间
 */
const DEFAULT_TRUNCATION: TruncationConfig = {
  maxSingleResult: Math.floor(CONTEXT_WINDOW * 0.5 * 2),
  contextBudgetChars: Math.floor(CONTEXT_WINDOW * 0.75 * 4),
};

/**
 * 核心截断函数：执行两轮工具结果处理
 *
 * Pass 1: 对单条超长结果做 Head/Tail 60/40 分割
 *   - 保留开头 60%（通常包含关键上下文和前置说明）
 *   - 保留结尾 40%（通常包含最终结果和结论）
 *   - 中间部分替换为截断标记，注明原始长度
 *
 * Pass 2: 如果所有工具结果总字符仍超预算
 *   - 从旧到新（数组头部开始）逐一压缩
 *   - 将完整输出替换为简短占位符
 *
 * 返回值包含处理后的消息列表、截断数和压缩数
 */
export function truncateToolResults(
  messages: ModelMessage[],
  config: TruncationConfig = DEFAULT_TRUNCATION,
): {messages: ModelMessage[]; truncated: number; compacted: number} {
  // 记录被截断的单条结果数量
  let truncated = 0;
  // 记录因总预算超额被压缩的结果数量
  let compacted = 0;

  // Pass 1: 遍历所有消息，对超长的单条工具结果做 Head/Tail 截断
  let result = messages.map((msg) => {
    // 只处理 role 为 'tool' 且 content 为数组的消息
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;

    // 处理该消息中的所有 content part
    const newContent = msg.content.map((part: any) => {
      // 跳过没有 output 字段或 output 不是字符串的 part
      if (!part.output || typeof part.output !== 'string') return part;
      // 未超过单条上限则跳过，不做截断
      if (part.output.length <= config.maxSingleResult) return part;

      // 标记此条被截断
      truncated++;
      // 获取单条上限
      const maxChars = config.maxSingleResult;
      // 头部保留 60% 的空间
      const headSize = Math.floor(maxChars * 0.6);
      // 尾部保留 40% 的空间
      const tailSize = Math.floor(maxChars * 0.4);
      // 提取头部内容
      const head = part.output.slice(0, headSize);
      // 提取尾部内容
      const tail = part.output.slice(-tailSize);

      // 返回保留头尾、中间替换为截断标记的新 part
      return {
        ...part,
        output: `${head}\n\n[truncated: ${part.output.length} → ${maxChars} chars]\n\n${tail}`,
      };
    });

    // 更新消息的 content 为处理后的新 content
    return {...msg, content: newContent};
  });

  // Pass 2: 计算所有工具结果的总字符数
  let totalChars = result.reduce((sum, msg) => {
    // 字符串类型的 content 直接累加
    if (typeof msg.content === 'string') return sum + msg.content.length;
    // 数组类型的 content 遍历累加 output 和 text 字段
    if (Array.isArray(msg.content)) {
      return (
        sum +
        (msg.content as any[]).reduce(
          (s, p) =>
            s +
            ((p.output as string)?.length || (p.text as string)?.length || 0),
          0,
        )
      );
    }
    // 其他类型不计数
    return sum;
  }, 0);

  // 如果总字符超过预算，从最早的（索引最小的）消息开始压缩
  if (totalChars > config.contextBudgetChars) {
    // 循环压缩，直到总字符降至预算以下或全部遍历完
    for (
      let i = 0;
      i < result.length && totalChars > config.contextBudgetChars;
      i++
    ) {
      // 取当前消息
      const msg = result[i];
      // 跳过非 tool 消息或非数组 content
      if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue;
      // 获取工具名用于占位符提示
      const toolName = (msg.content as any[])[0]?.toolName || 'unknown';
      // 计算这条消息的原始字符数
      const oldSize = (msg.content as any[]).reduce(
        (s: number, p: any) => s + ((p.output as string)?.length || 0),
        0,
      );
      // 将整条消息的 output 替换为压缩占位符
      result[i] = {
        ...msg,
        content: (msg.content as any[]).map((p: any) => ({
          ...p,
          output: `[compacted: ${toolName} output removed to free context]`,
        })),
      };
      // 从总计数中减去原始字符数
      totalChars -= oldSize;
      // 标记此条被压缩
      compacted++;
    }
  }

  // 返回处理结果：新消息列表、截断数、压缩数
  return {messages: result, truncated, compacted};
}

// ── Layer 3: TTL 修剪 ─────────────────────────
// 按消息年龄自动清理或缩短工具结果
//   - hardTTL (10min) → 硬清除：整条替换为过期标记
//   - softTTL  (5min)  → 软修剪：保留头尾各 1500 字符
//   - 错误结果永不修剪（保留失败现场供后续分析和调试）

/**
 * TTL 修剪配置接口
 * 定义时间阈值和保留字符数
 */
interface TTLConfig {
  // 软修剪时间阈值：超过此时间的消息会被缩短
  softTTLMs: number;
  // 硬清除时间阈值：超过此时间的消息会被完全替换
  hardTTLMs: number;
  // 软修剪时保留的头尾字符数
  keepHeadTail: number;
}

/**
 * 默认 TTL 配置
 * softTTL = 5 分钟，hardTTL = 10 分钟
 * 软修剪保留头尾各 1500 字符（共 3000 字符）
 */
const DEFAULT_TTL: TTLConfig = {
  softTTLMs: 5 * 60 * 1000,
  hardTTLMs: 10 * 60 * 1000,
  keepHeadTail: 1500,
};

/**
 * 修剪结果接口
 * 返回处理后的消息列表和各修剪类型的计数
 */
export interface PruneResult {
  messages: ModelMessage[];
  softPruned: number;   // 被软修剪的消息条数
  hardPruned: number;   // 被硬清除的消息条数
}

/**
 * TTL 修剪主函数
 *
 * 遍历所有消息，对每条 tool 消息按以下规则处理：
 * 1. 错误结果保护 — 内容匹配 error/失败/不存在/denied/refused/timeout 的永不修剪
 * 2. 硬清除 — age >= hardTTLMs，替换为 "[tool result expired: xxx]"
 * 3. 软修剪 — softTTLMs <= age < hardTTLMs，保留头尾，中间替换为修剪标记
 * 4. 保 留 — age < softTTLMs，完整保留原始内容
 *
 * user 和 assistant 角色的消息不受 TTL 影响
 */
export function ttlPrune(
  messages: ModelMessage[],
  timestamps: Map<number, number>,
  config: TTLConfig = DEFAULT_TTL,
): PruneResult {
  // 当前时间戳，用于计算消息年龄
  const now = Date.now();
  // 被软修剪的消息计数
  let softPruned = 0;
  // 被硬清除的消息计数
  let hardPruned = 0;

  // 遍历所有消息，按 TTL 策略处理每条 tool 消息
  const result = messages.map((msg, idx) => {
    // 只处理 role 为 'tool' 且 content 为数组的消息
    // user 和 assistant 消息不受 TTL 影响，直接原样返回
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;

    // 获取该消息的时间戳
    const ts = timestamps.get(idx);
    // 如果没有时间戳记录，无法判断年龄，直接保留
    if (!ts) return msg;

    // 计算消息的年龄（毫秒）
    const age = now - ts;

    // 收集该消息中所有 output 文本，用于检查是否包含错误关键词
    const outputText = (msg.content as any[])
      .map((p: any) => (typeof p.output === 'string' ? p.output : ''))
      .join('');
    // 使用正则匹配常见的错误关键词（中英文混合）
    const isError = /error|失败|不存在|denied|refused|timeout/i.test(
      outputText,
    );
    // 错误结果跳过修剪，保留完整内容供模型分析失败原因
    if (isError) return msg;

    // ── 硬清除分支 ──
    // 超过 hardTTL 阈值的旧消息，整条替换为简短的过期标记
    if (age >= config.hardTTLMs) {
      // 增加硬清除计数
      hardPruned++;
      // 获取工具名用于占位符提示
      const toolName = (msg.content[0] as any)?.toolName || 'unknown';
      // 将所有 content part 的 output 替换为过期标记
      return {
        ...msg,
        content: msg.content.map((part: any) => ({
          ...part,
          output: `[tool result expired: ${toolName}]`,
        })),
      };
    }

    // ── 软修剪分支 ──
    // 超过 softTTL 但未到 hardTTL，保留头尾关键信息
    if (age >= config.softTTLMs) {
      // 处理该消息的所有 content part
      const newContent = msg.content.map((part: any) => {
        // 跳过没有 output 的 part
        if (!part.output || typeof part.output !== 'string') return part;
        // 如果内容本身不长（小于 keepHeadTail 的两倍），不做修剪
        if (part.output.length <= config.keepHeadTail * 2) return part;

        // 标记此 part 被软修剪
        softPruned++;
        // 提取头部 keepHeadTail 字符
        const head = part.output.slice(0, config.keepHeadTail);
        // 提取尾部 keepHeadTail 字符
        const tail = part.output.slice(-config.keepHeadTail);
        // 计算被移除的中间部分字符数
        const removed = part.output.length - config.keepHeadTail * 2;

        // 返回保留头尾、中间替换为修剪标记的新 part
        return {
          ...part,
          output: `${head}\n\n[soft pruned: ${removed} chars removed, content older than ${Math.round(config.softTTLMs / 60000)}min]\n\n${tail}`,
        };
      });
      // 更新消息的 content
      return {...msg, content: newContent};
    }

    // ── 保留分支 ──
    // 年龄小于 softTTL，消息还比较新，完整保留
    return msg;
  });

  // 返回修剪后的消息列表和统计信息
  return {messages: result, softPruned, hardPruned};
}

// ── 三层防线组合 ───────────────────────────────
// 按 Layer 2 → Layer 3 → Layer 1 的顺序执行：
//   1. 先截断超长工具结果（空间优化）
//   2. 再按 TTL 修剪过期结果（时间优化）
//   3. 最后估算处理后的 token 数（结果度量）

/**
 * 防线执行结果接口
 * 汇总三层防线的所有处理统计
 */
export interface DefenseResult {
  messages: ModelMessage[];  // 经过三层防线处理后的消息列表
  tokenEstimate: number;     // 防线处理后的估算 token 数
  truncated: number;         // Layer 2 中单条截断的次数
  compacted: number;         // Layer 2 中因预算超额被压缩的次数
  softPruned: number;        // Layer 3 中软修剪的消息数
  hardPruned: number;        // Layer 3 中硬清除的消息数
}

/**
 * applyDefense — 执行完整的三层上下文防线
 *
 * 执行顺序（从后往前处理）：
 *   Layer 2 → truncateToolResults
 *     先处理"空间"维度：把超长的工具结果截短
 *     包括单条超限截断（Head/Tail）和总预算超额压缩
 *   Layer 3 → ttlPrune
 *     再处理"时间"维度：把太旧但仍有价值的工具结果缩短或清除
 *     按 TTL 策略分级处理（保留/软修剪/硬清除）
 *   Layer 1 → estimateMessageTokens
 *     最后估算结果：计算处理后还剩多少 token
 *     注意：TokenTracker 类在对话过程中持续运作，
 *          这里的 estimateMessageTokens 是一次性批量估算
 *
 * 设计原则：
 * - 先做有损操作（截断/压缩），再做无损操作（估算）
 * - 每一层都尽可能保留对模型最有价值的信息
 * - 错误结果跨越所有层级保护，永不丢弃
 */
export function applyDefense(
  messages: ModelMessage[],
  timestamps: Map<number, number>,
): DefenseResult {
  // ── Layer 2: 截断超长工具结果 ──
  // 对单条超长结果做 Head/Tail 截断，并对总预算超额做压缩
  const trunc = truncateToolResults(messages);
  let result = trunc.messages;

  // ── Layer 3: TTL 修剪过期工具结果 ──
  // 按消息年龄做分级处理：软修剪（缩短）或硬清除（替换占位符）
  const prune = ttlPrune(result, timestamps);
  result = prune.messages;

  // ── Layer 1: 估算最终 token 数 ──
  // 对经过所有防线处理后的消息做一次 token 估算
  const tokenEstimate = estimateMessageTokens(result);

  // 返回完整的防线处理结果
  return {
    messages: result,          // 防线处理后的最终消息列表
    tokenEstimate,             // 估算 token 数
    truncated: trunc.truncated, // Layer 2 截断统计
    compacted: trunc.compacted, // Layer 2 压缩统计
    softPruned: prune.softPruned, // Layer 3 软修剪统计
    hardPruned: prune.hardPruned, // Layer 3 硬清除统计
  };
}
