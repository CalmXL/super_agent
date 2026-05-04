import {createHash} from 'node:crypto';

/**
 * 工具调用记录
 * 用于存储单次工具调用的相关信息，包括工具名称、参数哈希、结果哈希和时间戳
 */
export interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  resultHash?: string;
  timestamp: number;
}

/**
 * 检测器类型
 * - generic_repeat: 通用重复检测（相同工具+相同参数重复调用）
 * - ping_pong: 乒乓循环检测（两个状态交替循环）
 * - global_circuit_breaker: 全局熔断器（连续无进展次数超过阈值）
 */
export type DetectorKind =
  | 'generic_repeat'
  | 'ping_pong'
  | 'global_circuit_breaker';

/**
 * 检测结果
 * 如果 stuck 为 false，表示未检测到循环；如果为 true，表示检测到循环问题
 */
export type DetectionResult =
  | {stuck: false}
  | {
      stuck: true;
      level: 'warning' | 'critical';
      detector: DetectorKind;
      count: number;
      message: string;
    };

/**
 * 历史记录保存的最大条目数量
 */
const HISTORY_SIZE = 30;
/**
 * 警告阈值：达到此次数时给出警告
 */
const WARNING_THRESHOLD = 5;
/**
 * 严重阈值：达到此次数时触发熔断
 */
const CRITICAL_THRESHOLD = 8;
/**
 * 熔断阈值：超过此次数直接熔断
 */
const BREAKER_THRESHOLD = 10;

/**
 * 稳定序列化：将任意值序列化为确定的字符串形式
 * 保证相同对象无论属性顺序如何，序列化结果都相同
 * @param value - 要序列化的值
 * @returns 序列化后的字符串
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`).join(',')}}`;
}

/**
 * SHA256 哈希计算
 * @param input - 输入字符串
 * @returns 16位十六进制哈希值
 */
function hash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * hash化 tool
 * @param toolName
 * @param params
 */
export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${hash(stableStringify(params))}`;
}

/**
 * 对结果进行哈希
 * @param result - 工具执行结果
 * @returns 结果的哈希值
 */
export function hashResult(result: unknown): string {
  return hash(stableStringify(result));
}

/**
 * 工具调用历史记录，用于检测循环
 */
const history: ToolCallRecord[] = [];

/**
 * 记录工具调用
 * 将工具名称和参数哈希加入历史记录
 * @param toolName - 工具名称
 * @param params - 工具参数
 */
export function recordCall(toolName: string, params: unknown): void {
  history.push({
    toolName,
    argsHash: hashToolCall(toolName, params),
    timestamp: Date.now(),
  });
  if (history.length > HISTORY_SIZE) history.shift();
}

/**
 * 记录工具调用结果
 * 将结果哈希关联到对应的工具调用记录
 * @param toolName - 工具名称
 * @param params - 工具参数
 * @param result - 工具执行结果
 */
export function recordResult(
  toolName: string,
  params: unknown,
  result: unknown,
): void {
  const argsHash = hashToolCall(toolName, params);
  const resultH = hashResult(result);
  for (let i = history.length - 1; i >= 0; i--) {
    if (
      history[i].toolName === toolName &&
      history[i].argsHash === argsHash &&
      !history[i].resultHash
    ) {
      history[i].resultHash = resultH;
      break;
    }
  }
}

/**
 * 重置历史记录
 * 清空所有工具调用历史
 */
export function resetHistory(): void {
  history.length = 0;
}

/**
 * 计算某个特定工具（Tool）在完全相同的参数下，连续产生相同结果（即“无进展”）的次数。
 *
 * 核心逻辑：从最新记录向前遍历，找出连续产生相同结果哈希的调用次数
 * 例如：如果工具A以参数X调用3次且3次都返回相同结果，则认为“卡住”了
 *
 * @param toolName - 工具名称
 * @param argsHash - 参数哈希
 * @returns 连续无进展的次数
 */
function getNoProgressStreak(toolName: string, argsHash: string): number {
  let streak = 0;
  let lastResultHash: string | undefined;
  // 从最新的历史记录向前遍历
  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i];
    // 跳过不匹配的工具调用
    if (r.toolName !== toolName || r.argsHash !== argsHash) continue;
    // 跳过没有结果记录的调用
    if (!r.resultHash) continue;
    // 第一次匹配到时，设置为基准结果
    if (!lastResultHash) {
      lastResultHash = r.resultHash;
      streak = 1;
      continue;
    }
    // 如果结果与基准不同，说明有进展，停止计数
    if (r.resultHash !== lastResultHash) break;
    // 结果相同，继续计数
    streak++;
  }
  return streak;
}

/**
 * 检测乒乓循环次数
 *
 * 乒乓循环是指在两个不同的参数状态之间来回切换（例如：A->B->A->B...）
 * 这种模式常见于两个工具互相调用但始终无法达成目标的情况
 *
 * 核心算法：
 * 1. 找到最近出现的“另一个”参数哈希
 * 2. 验证是否存在 A-B-A-B 的交替模式
 * 3. 如果当前调用是另一个哈希且交替次数足够，判定为乒乓循环
 *
 * @param currentHash - 当前工具调用的参数哈希
 * @returns 循环次数，0表示未检测到乒乓循环
 */
function getPingPongCount(currentHash: string): number {
  // 至少需要3条记录才能形成有效的乒乓模式
  if (history.length < 3) return 0;
  const last = history[history.length - 1];
  let otherHash: string | undefined;
  // 找到最近出现的、与最新记录不同的参数哈希
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].argsHash !== last.argsHash) {
      otherHash = history[i].argsHash;
      break;
    }
  }
  if (!otherHash) return 0;
  // 从后向前计数，验证是否是 A-B-A-B 的交替模式
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const expected = count % 2 === 0 ? last.argsHash : otherHash;
    if (history[i].argsHash !== expected) break;
    count++;
  }
  // 如果当前调用是另一个哈希且交替次数>=2，则判定为乒乓循环
  // 需要+1是因为当前调用也被计入循环
  if (currentHash === otherHash && count >= 2) return count + 1;
  return 0;
}

/**
 * 检测循环
 *
 * 三层检测机制（按优先级）：
 * 1. 全局熔断器 (global_circuit_breaker)：检测同参数重复调用且结果相同（无进展）
 * 2. 乒乓检测 (ping_pong)：检测两状态交替循环
 * 3. 通用重复检测 (generic_repeat)：检测同参数重复调用次数
 *
 * 检测优先级：熔断 > 乒乓 > 通用重复
 * 同一种检测类型内，WARNING_THRESHOLD -> CRITICAL_THRESHOLD
 *
 * @param toolName - 工具名称
 * @param params - 工具参数
 * @returns 检测结果，包含级别、检测器类型、计数和消息
 */
export function detect(toolName: string, params: unknown): DetectionResult {
  const argsHash = hashToolCall(toolName, params);

  // 第一层：全局熔断器 - 检测连续相同结果的重复调用
  const noProgress = getNoProgressStreak(toolName, argsHash);
  if (noProgress >= BREAKER_THRESHOLD) {
    return {
      stuck: true, // 卡主
      level: 'critical',
      detector: 'global_circuit_breaker',
      count: noProgress,
      message: `[熔断] ${toolName} 已重复 ${noProgress} 次且无进展，强制停止`,
    };
  }

  // 第二层：乒乓循环检测 - 检测两状态交替
  const pingPong = getPingPongCount(argsHash);
  if (pingPong >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'ping_pong',
      count: pingPong,
      message: `[熔断] 检测到乒乓循环（${pingPong} 次交替），强制停止`,
    };
  }
  if (pingPong >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'ping_pong',
      count: pingPong,
      message: `[警告] 检测到乒乓循环（${pingPong} 次交替），建议换个思路`,
    };
  }

  // 第三层：通用重复检测 - 统计同参数调用次数
  const recentCount = history.filter(
    (h) => h.toolName === toolName && h.argsHash === argsHash,
  ).length;
  if (recentCount >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'generic_repeat',
      count: recentCount,
      message: `[熔断] ${toolName} 相同参数已调用 ${recentCount} 次，强制停止`,
    };
  }
  if (recentCount >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'generic_repeat',
      count: recentCount,
      message: `[警告] ${toolName} 相同参数已调用 ${recentCount} 次，你可能陷入了重复`,
    };
  }

  return {stuck: false};
}
