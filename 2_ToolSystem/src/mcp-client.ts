// 导入 child_process 模块的 spawn 函数（用于启动子进程）和 ChildProcess 类型
import {spawn, type ChildProcess} from 'node:child_process';
// 导入 readline 模块的 createInterface 函数（用于逐行读取）和 Interface 类型
import {createInterface, type Interface} from 'node:readline';

/** MCP 工具描述 */
interface MCPTool {
  name: string; // 工具名称
  description: string; // 工具描述
  inputSchema: Record<string, unknown>; // 工具参数 JSON Schema
}

/** MCP 工具调用返回结果 */
interface MCPCallResult {
  content: Array<{type: string; text?: string}>; // 返回内容数组（每个元素有类型和文本）
  isError?: boolean; // 是否执行出错
}

/**
 * MCP 客户端
 * 通过 stdio 与 MCP 服务器子进程通信，基于 JSON-RPC 2.0 协议
 */
export class MCPClient {
  /** MCP 服务器子进程（初始为 null，connect 时赋值） */
  private process: ChildProcess | null = null;
  /** stdout 逐行读取接口（初始为 null，connect 时赋值） */
  private rl: Interface | null = null;
  /** 自增请求 ID，每次 send 调用 +1，用于匹配请求与响应 */
  private requestId = 0;
  /** 等待响应的请求映射表 key=请求ID, value={resolve, reject} */
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void; // 成功回调
      reject: (e: Error) => void; // 失败回调
    }
  >();
  /** 服务器名称（仅用于标识，从 args 末尾提取） */
  private serverName: string;

  /**
   * 构造函数
   * @param command 要执行的命令（如 npx）
   * @param args 命令参数列表
   * @param env 额外的环境变量（可选）
   */
  constructor(
    private command: string,
    private args: string[],
    private env?: Record<string, string>,
  ) {
    // 从 args 末尾提取服务器名称，如 "@anthropic/claude-code" → "claude-code"
    this.serverName =
      args[args.length - 1]?.replace(/^@.*\//, '') || 'mcp-server';
  }

  /**
   * 连接到 MCP 服务器
   * 启动子进程 → 建立 readline 监听 → 发送 initialize → 发送 initialized 通知
   */
  async connect(): Promise<void> {
    // 通过 spawn 启动 MCP 服务器子进程（stdio 全部用管道以便通信）
    this.process = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {...process.env, ...this.env}, // 合并系统环境变量与自定义变量
    });

    // 监听子进程启动失败事件
    this.process.on('error', (err) => {
      console.error(`  [MCP] 进程启动失败: ${err.message}`);
    });
    // 消费 stderr 数据（防止背压，实际忽略）
    this.process.stderr?.on('data', () => {});

    // 创建 readline 接口，逐行读取子进程的 stdout
    this.rl = createInterface({input: this.process.stdout!});
    // 每收到一行数据（JSON-RPC 响应），解析并匹配 pending 中的请求
    this.rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line); // 尝试解析 JSON
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!; // 获取对应的 resolve/reject
          this.pending.delete(msg.id); // 从 pending 中移除
          if (msg.error) {
            p.reject( // 服务端返回错误 → reject
              new Error(`MCP error ${msg.error.code}: ${msg.error.message}`),
            );
          } else {
            p.resolve(msg.result); // 正常返回 → resolve
          }
        }
      } catch {
        /* 忽略非 JSON 行（如日志） */
      }
    });

    // 发送 initialize 请求进行协议握手（必须的第一个请求）
    await this.send('initialize', {
      protocolVersion: '2024-11-05', // 协议版本
      capabilities: {}, // 客户端能力声明
      clientInfo: {name: 'super-agent', version: '0.5.0'}, // 客户端标识
    });

    // 发送 notifications/initialized 通知（通知服务器初始化完成，无需响应）
    this.process.stdin!.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }) + '\n',
    );
  }

  /**
   * 发送 JSON-RPC 请求，返回 Promise
   * 15 秒超时自动 reject
   * @param method RPC 方法名
   * @param params 参数
   */
  private send(method: string, params?: any): Promise<any> {
    // 返回一个 Promise，在收到响应时 resolve/reject
    return new Promise((resolve, reject) => {
      const id = ++this.requestId; // 生成唯一请求 ID
      const timeout = setTimeout(() => { // 15 秒超时定时器
        this.pending.delete(id); // 超时后从 pending 中移除
        reject(new Error(`MCP request timeout: ${method}`));
      }, 15000);

      // 将 resolve/reject 注册到 pending 表
      this.pending.set(id, {
        resolve: (v: any) => {
          clearTimeout(timeout); // 收到响应 → 清除超时定时器
          resolve(v);
        },
        reject: (e: Error) => {
          clearTimeout(timeout); // 收到错误 → 清除超时定时器
          reject(e);
        },
      });

      // 构造 JSON-RPC 2.0 请求消息并写入 stdin
      const msg = JSON.stringify({jsonrpc: '2.0', id, method, params});
      this.process!.stdin!.write(msg + '\n');
    });
  }

  /** 获取服务器提供的工具列表 */
  async listTools(): Promise<MCPTool[]> {
    // 调用 tools/list 方法
    const result = await this.send('tools/list', {});
    return result.tools || []; // 返回工具列表，如果没有则返回空数组
  }

  /** 调用指定工具，返回拼接后的文本内容 */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    // 调用 tools/call 方法，传入工具名和参数
    const result: MCPCallResult = await this.send('tools/call', {
      name,
      arguments: args,
    });
    // 从返回内容中提取所有 type='text' 且有 text 值的片段
    const texts = (result.content || [])
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!);
    return texts.join('\n') || '(无返回内容)'; // 拼接为字符串
  }

  /** 关闭连接，清理资源 */
  async close(): Promise<void> {
    if (this.rl) this.rl.close(); // 关闭 readline 接口
    if (this.process) this.process.kill(); // 杀死子进程
  }
}

/**
 * MockMCPClient — 模拟 MCP 客户端
 * 无需真实服务器即可测试，硬编码了三个 GitHub 相关工具的假数据
 */
export class MockMCPClient {
  // 模拟连接（空操作）
  async connect(): Promise<void> {}

  // 返回三个硬编码的模拟工具定义
  async listTools(): Promise<MCPTool[]> {
    return [
      {
        name: 'list_issues', // 工具名：列出 Issues
        description: '列出 GitHub 仓库的 Issues',
        inputSchema: {
          type: 'object',
          properties: {
            owner: {type: 'string', description: '仓库所有者'},
            repo: {type: 'string', description: '仓库名称'},
          },
          required: ['owner', 'repo'],
        },
      },
      {
        name: 'search_repositories', // 工具名：搜索仓库
        description: '搜索 GitHub 仓库',
        inputSchema: {
          type: 'object',
          properties: {
            query: {type: 'string', description: '搜索关键词'},
          },
          required: ['query'],
        },
      },
      {
        name: 'get_file_contents', // 工具名：获取文件内容
        description: '获取仓库中文件的内容',
        inputSchema: {
          type: 'object',
          properties: {
            owner: {type: 'string', description: '仓库所有者'},
            repo: {type: 'string', description: '仓库名称'},
            path: {type: 'string', description: '文件路径'},
          },
          required: ['owner', 'repo', 'path'],
        },
      },
    ];
  }

  // 根据工具名返回模拟数据
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'list_issues': // 返回两个 open + 一个 closed 的 Issue 列表
        return JSON.stringify(
          [
            {
              number: 42,
              title: '支持 MCP 协议接入',
              state: 'open',
              labels: ['enhancement'],
            },
            {
              number: 41,
              title: '循环检测阈值可配置化',
              state: 'open',
              labels: ['feature'],
            },
            {
              number: 39,
              title: 'Token 预算用完后的优雅降级',
              state: 'closed',
              labels: ['bug'],
            },
          ],
          null,
          2,
        );
      case 'search_repositories': // 返回三个模拟的仓库搜索结果
        return JSON.stringify(
          [
            {
              full_name: 'anthropics/anthropic-sdk-python',
              stars: 2800,
              description: 'Anthropic Python SDK',
            },
            {
              full_name: 'vercel/ai',
              stars: 12000,
              description: 'AI SDK for TypeScript',
            },
            {
              full_name: 'modelcontextprotocol/servers',
              stars: 5600,
              description: 'MCP Servers',
            },
          ],
          null,
          2,
        );
      case 'get_file_contents': // 返回简单的模拟 README 内容
        return `# README\n\nThis is a mock file content for ${args.owner}/${args.repo}/${args.path}`;
      default: // 未识别的工具名
        return `未知工具: ${name}`;
    }
  }

  // 模拟关闭（空操作）
  async close(): Promise<void> {}
}
