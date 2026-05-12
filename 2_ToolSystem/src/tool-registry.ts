import {jsonSchema} from 'ai';
import {MCPClient, MockMCPClient} from './mcp-client';

/**
 * 工具注册系统
 * 提供工具定义、注册管理和执行控制功能
 * @module
 */

export interface ToolDefinition {
  /** 工具名称，AI模型通过此名称调用工具 */
  name: string;
  /** 工具功能描述，帮助模型理解何时使用该工具 */
  description: string;
  /** JSON Schema格式的参数定义 */
  parameters: Record<string, unknown>;
  /** 是否允许多工具并发执行，默认为false（独占执行） */
  isConcurrencySafe?: boolean;
  /** 是否为只读操作，只读工具可更好地支持并发 */
  isReadOnly?: boolean;
  /** 返回结果最大字符数，超过会被截断 */
  maxResultChars?: number;
  /** 工具执行函数，接收输入参数并返回结果 */
  execute: (input: any) => Promise<unknown>;
}

/** 默认最大返回字符数 */
const DEFAULT_MAX_RESULT_CHARS = 3000;

/**
 * 工具注册中心
 * 管理工具的注册、获取和执行控制
 * 支持并发安全（共享锁）和独占执行（串行锁）两种模式
 */
export class ToolRegistry {
  /** 工具存储映射，key为工具名称 */
  private tools = new Map<string, ToolDefinition>();

  /** 独占锁标志，true表示有工具正在独占执行 */
  private exclusiveLock = false;
  /** 当前并发执行的工具数量 */
  private concurrentCount = 0;
  /** 等待队列，存储等待执行的Promise resolve函数 */
  private waitQueue: Array<() => void> = [];

  /**
   * 注册一个或多个工具
   * @param tools 要注册的工具定义列表
   */
  register(...tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  /**
   * 根据名称获取工具定义
   * @param name 工具名称
   * @returns 工具定义或undefined
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * 获取所有已注册的工具
   * @returns 工具定义数组
   */
  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * 获取并发执行权限（共享锁）
   * 若存在独占锁则等待，否则递增并发计数
   */
  private async acquireConcurrent(): Promise<void> {
    while (this.exclusiveLock) {
      await new Promise<void>((r) => this.waitQueue.push(r));
    }
    this.concurrentCount++;
  }

  /**
   * 释放并发执行权限
   * 递减并发计数，若计数为0则唤醒等待队列
   */
  private releaseConcurrent(): void {
    this.concurrentCount--;
    if (this.concurrentCount === 0) this.drainQueue();
  }

  /**
   * 获取独占执行权限（串行锁）
   * 等待所有并发工具和独占锁完成，然后设置独占锁
   */
  private async acquireExclusive(): Promise<void> {
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise<void>((r) => this.waitQueue.push(r));
    }
    this.exclusiveLock = true;
  }

  /**
   * 释放独占执行权限
   * 清除独占锁标志并唤醒等待队列
   */
  private releaseExclusive(): void {
    this.exclusiveLock = false;
    this.drainQueue();
  }

  /**
   * 排空等待队列，唤醒所有等待中的Promise
   */
  private drainQueue(): void {
    const waiting = this.waitQueue.splice(0);
    for (const resolve of waiting) resolve();
  }

  /**
   * 转换为AI SDK格式
   * 生成符合AI SDK规范的工具定义对象
   * @returns 工具名称到定义对象的映射
   */
  toAISDKFormat(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [name, tool] of this.tools) {
      const maxChars = tool.maxResultChars;
      const executeFn = tool.execute;
      const isSafe = tool.isConcurrencySafe === true;
      const registry = this;

      result[name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        /** 执行函数：获取锁 → 执行工具 → 截断结果 → 释放锁 */
        execute: async (input: any) => {
          // 根据工具类型获取相应锁
          if (isSafe) {
            await registry.acquireConcurrent();
            console.log(`  [并发] ${name} 获取共享锁`);
          } else {
            await registry.acquireExclusive();
            console.log(`  [串行] ${name} 获取独占锁，等待其他工具完成`);
          }
          try {
            // 执行工具并将结果转为字符串
            const raw = await executeFn(input);
            const text =
              typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
            // 截断过长结果
            return truncateResult(text, maxChars);
          } finally {
            // 无论成功或失败都释放锁
            if (isSafe) {
              registry.releaseConcurrent();
            } else {
              registry.releaseExclusive();
            }
          }
        },
      };
    }
    return result;
  }

  private mcpClients: Array<MCPClient | MockMCPClient> = [];

  async registerMCPServer(
    serverName: string,
    client: MCPClient | MockMCPClient,
  ): Promise<string[]> {
    await client.connect();
    this.mcpClients.push(client);

    const tools = await client.listTools();
    const registered: string[] = [];

    for (const tool of tools) {
      // 命名空间隔离
      const prefixedName = `mcp__${serverName}__${tool.name}`;
      if (this.tools.has(prefixedName)) continue;

      const toolClient = client;
      const originalName = tool.name;

      // 注册工具定义
      this.register({
        name: prefixedName,
        description: `[MCP:${serverName}] ${tool.description}`,
        parameters: tool.inputSchema as Record<string, unknown>,
        isConcurrencySafe: true,
        isReadOnly: true,
        maxResultChars: 3000,
        execute: async (input: any) => {
          // 执行工具并返回结果文本
          return await toolClient.callTool(originalName, input);
        },
      });

      registered.push(prefixedName);
    }

    return registered;
  }

  async closeAllMCP(): Promise<void> {
    for (const tool of this.mcpClients) {
      await tool.close();
    }
    this.mcpClients = [];
  }
}

/**
 * 截断工具返回结果
 * 当结果过长时保留头部60%和尾部40%，中间显示省略提示
 * @param text 原始结果文本
 * @param maxChars 最大字符数（默认3000）
 * @returns 截断后的文本
 */
export function truncateResult(
  text: string,
  maxChars: number = DEFAULT_MAX_RESULT_CHARS,
): string {
  if (text.length <= maxChars) return text;

  const headSize = Math.floor(maxChars * 0.6); // 60% 头部大小
  const tailSize = maxChars - headSize; // 尾部大小
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const dropped = text.length - headSize - tailSize;

  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`;
}
