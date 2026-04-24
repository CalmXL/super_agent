/**
 * Mock Model v0.3 — 支持 Tool Calling + 死循环模拟
 * 
 * 本模拟模型用于本地测试，模拟真实的 API 调用行为：
 * - 支持工具调用（tool call）意图检测
 * - 支持流式输出（streaming）
 * - 支持重试机制模拟（429 错误）
 * - 支持死循环测试（触发循环检测）
 * 
 * 使用方式：在 .env 中配置 DASHSCOPE_API_KEY 即可切换到真实 Qwen 模型
 */

let retryTestCount = 0;

const TEXT_RESPONSES: Record<string, string> = {
  default:
    '你好！我是 Super Agent 的模拟模型。当前使用本地模拟回复，工具调用的机制和真实 API 完全一样。\n\n在 .env 里填入 DASHSCOPE_API_KEY 即可切换到真实的 Qwen 模型。',
  greeting:
    '你好！我是 Super Agent v0.3，现在我不只能聊天，还有保险丝保护了 :)',
  name: '你刚才告诉我了呀！不过说实话，我是模拟模型，能"记住"是因为代码把对话历史传给了我。',
};

interface ToolCallIntent {
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * 从对话历史中提取用户最新的文本输入
 * 
 * 处理逻辑：
 * 1. 过滤出所有 role 为 'user' 的消息
 * 2. 取最后一条用户消息
 * 3. 提取 content 数组中的 text 字段并合并
 * 4. 转为小写以便匹配关键词
 * 
 * @param prompt - 对话历史数组
 * @returns 提取后的用户文本（小写）
 */
function extractUserText(prompt: any[]): string {
  const userMsgs = (prompt || []).filter((m: any) => m.role === 'user');
  const last = userMsgs[userMsgs.length - 1];
  if (!last) return '';
  return (last.content || [])
    .map((c: any) => c.text || '')
    .join('')
    .toLowerCase();
}

/**
 * 检查对话历史中是否存在工具返回结果
 * 
 * @param prompt - 对话历史数组
 * @returns 是否存在 tool 角色的消息
 */
function hasToolResults(prompt: any[]): boolean {
  return (prompt || []).some((m: any) => m.role === 'tool');
}

/**
 * 检测用户是否意图调用工具
 * 
 * 支持的工具意图：
 * 1. 天气查询 - 包含天气/温度/城市名等关键词
 * 2. 计算器 - 包含数字和运算符号
 * 3. 死循环测试 - 触发 loop_detection 的测试用例
 * 
 * 检测优先级：
 * 1. 死循环测试（最高优先级，用于测试）
 * 2. 天气查询
 * 3. 计算器
 * 
 * @param prompt - 对话历史数组
 * @returns 检测到的工具意图，未检测到则返回 null
 */
function detectToolIntent(prompt: any[]): ToolCallIntent | null {
  const text = extractUserText(prompt);
  console.log('detectToolIntent', text);

  // 死循环测试：触发无限循环用于测试 loop_detection 模块
  if (text.includes('测试死循环') || text.includes('test dead loop')) {
    return { toolName: 'get_weather', args: { city: '北京' } };
  }

  // 如果已经有工具结果，则不再检测新意图
  if (hasToolResults(prompt)) return null;

  // 天气查询意图检测
  const weatherKeywords = ['天气', 'weather', '温度', '热', '冷', '气温', '下雨', '晴'];
  const hasWeatherIntent = weatherKeywords.some((kw) => text.includes(kw));
  const cities = text.match(/(北京|上海|深圳|广州|杭州|成都)/g);
  if (hasWeatherIntent && cities && cities.length > 0) {
    return { toolName: 'get_weather', args: { city: cities[0] } };
  }

  // 计算器意图检测：匹配 "数字 运算符 数字" 格式
  const calcMatch = text.match(/(\d+)\s*[+\-*/加减乘除]\s*(\d+)/);
  if (calcMatch) {
    const op = text.match(/[+*/]|加|减|乘|除|-/)?.[0] || '+';
    const opMap: Record<string, string> = { '加': '+', '减': '-', '乘': '*', '除': '/' };
    const expression = `${calcMatch[1]} ${opMap[op] || op} ${calcMatch[2]}`;
    return { toolName: 'calculator', args: { expression } };
  }
  // 备用计算器检测：包含"计算"或"等于"关键词，且至少有2个数字
  if (text.includes('计算') || text.includes('等于')) {
    const nums = text.match(/\d+/g);
    if (nums && nums.length >= 2) {
      return { toolName: 'calculator', args: { expression: `${nums[0]} + ${nums[1]}` } };
    }
  }

  return null;
}

/**
 * 根据对话历史选择合适的文本回复
 * 
 * 回复策略：
 * 1. 如果存在工具结果 - 根据结果内容生成对应回复
 * 2. 如果用户问候/打招呼 - 返回 greeting 回复
 * 3. 如果用户询问名字 - 返回 name 回复
 * 4. 默认 - 返回 default 回复
 * 
 * @param prompt - 对话历史数组
 * @returns 生成的文本回复
 */
function pickTextResponse(prompt: any[]): string {
  // 检测并处理工具返回的结果
  if (hasToolResults(prompt)) {
    const toolMsgs = (prompt || []).filter((m: any) => m.role === 'tool');
    const lastResult = toolMsgs[toolMsgs.length - 1];
    const content = (lastResult?.content || [])
      .map((c: any) => {
        if (c.output?.value) return c.output.value;
        if (c.output) return String(c.output);
        return c.text || c.result || '';
      })
      .join('');
    if (content.includes('°C') || content.includes('天气')) return `根据查询结果：${content}`;
    if (content.includes('=')) return `计算结果：${content}`;
    return `工具返回了以下信息：${content}`;
  }
  // 基于用户输入选择固定回复
  const text = extractUserText(prompt);
  if (text.includes('你好') || text.includes('hello') || text.includes('hi'))
    return TEXT_RESPONSES.greeting;
  if (text.includes('叫什么') || text.includes('名字') || text.includes('记'))
    return TEXT_RESPONSES.name;
  return TEXT_RESPONSES.default;
}

/**
 * Mock 模型的 usage 统计（固定值）
 * 模拟真实 API 的 token 消耗统计
 */
const USAGE = {
  inputTokens: { total: 3000, noCache: 3000, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1500, text: 1500, reasoning: undefined },
};

/**
 * 创建延迟流式输出
 * 
 * 将数组中的内容分块逐步输出，模拟真实的流式 API 行为
 * 每个 chunk 之间会延迟 delayMs 毫秒
 * 
 * @param chunks - 要输出的数据块数组
 * @param delayMs - 块之间的延迟毫秒数
 * @returns ReadableStream 实例
 */
function createDelayedStream(chunks: any[], delayMs = 30): ReadableStream {
  return new ReadableStream({
    start(controller) {
      let i = 0;
      function next() {
        if (i < chunks.length) {
          controller.enqueue(chunks[i++]);
          setTimeout(next, delayMs);
        } else {
          controller.close();
        }
      }
      next();
    },
  });
}

/**
 * 创建 Mock 模型实例
 * 
 * 提供与真实模型一致的接口：
 * - doGenerate: 非流式生成
 * - doStream: 流式生成
 * - supportedUrls: 支持的工具列表
 * 
 * @returns 模型实例
 */
export function createMockModel() {
  return {
    specificationVersion: 'v2' as const,
    provider: 'mock',
    modelId: 'mock-model',

    get supportedUrls() {
      return Promise.resolve({});
    },

    /**
     * 非流式生成
     * 
     * 支持的功能：
     * 1. 重试测试 - 模拟 429 错误，测试重试机制
     * 2. 工具调用 - 检测用户意图并返回工具调用请求
     * 3. 文本回复 - 根据对话历史生成回复
     * 
     * @param prompt - 对话历史数组
     * @returns 生成结果
     */
    async doGenerate({ prompt }: any) {
      const text = extractUserText(prompt);

      // 重试测试：模拟 API 限流，前2次抛出 429 错误
      if (text.includes('测试重试') || text.includes('test retry')) {
        retryTestCount++;
        if (retryTestCount <= 2) {
          throw new Error('429 Too Many Requests - Rate limit exceeded');
        }
        retryTestCount = 0;
        return {
          content: [{ type: 'text' as const, text: '重试成功！经过几次 429 错误后，我终于回来了。' }],
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      }

      // 检测工具调用意图
      const intent = detectToolIntent(prompt);
      if (intent) {
        return {
          content: [{
            type: 'tool-call' as const,
            toolCallId: `call-${Date.now()}`,
            toolName: intent.toolName,
            input: intent.args,
          }],
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: USAGE,
          warnings: [],
        };
      }

      // 默认文本回复
      return {
        content: [{ type: 'text' as const, text: pickTextResponse(prompt) }],
        finishReason: { unified: 'stop' as const, raw: undefined },
        usage: USAGE,
        warnings: [],
      };
    },

    /**
     * 流式生成
     * 
     * 支持的功能与非流式相同，但通过流式输出模拟真实 API 的 chunked 响应
     * 
     * @param prompt - 对话历史数组
     * @returns 流式响应对象
     */
    async doStream({ prompt }: any) {
      const text = extractUserText(prompt);

      // 重试测试：模拟 429 错误
      if (text.includes('测试重试') || text.includes('test retry')) {
        retryTestCount++;
        if (retryTestCount <= 2) {
          throw new Error('429 Too Many Requests - Rate limit exceeded');
        }
        retryTestCount = 0;
        const reply = '重试成功！经过几次 429 错误后，我终于回来了。';
        const id = 'text-1';
        const chunks: any[] = [
          { type: 'text-start', id },
          ...reply.split('').map((char: string) => ({ type: 'text-delta', id, delta: char })),
          { type: 'text-end', id },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE },
        ];
        return { stream: createDelayedStream(chunks, 30) };
      }

      // 工具调用流式输出
      const intent = detectToolIntent(prompt);
      if (intent) {
        const callId = `call-${Date.now()}`;
        const argsJson = JSON.stringify(intent.args);
        const chunks: any[] = [
          { type: 'tool-input-start', id: callId, toolName: intent.toolName },
          { type: 'tool-input-delta', id: callId, delta: argsJson },
          { type: 'tool-input-end', id: callId },
          { type: 'tool-call', toolCallId: callId, toolName: intent.toolName, input: argsJson },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE },
        ];
        return { stream: createDelayedStream(chunks, 20) };
      }

      // 文本流式输出：将回复逐字符输出
      const replyText = pickTextResponse(prompt);
      const id = 'text-1';
      const chunks: any[] = [
        { type: 'text-start', id },
        ...replyText.split('').map((char: string) => ({ type: 'text-delta', id, delta: char })),
        { type: 'text-end', id },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: USAGE },
      ];
      return { stream: createDelayedStream(chunks, 30) };
    },
  };
}
