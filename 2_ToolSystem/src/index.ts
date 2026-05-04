import 'dotenv/config';
import {type ModelMessage} from 'ai';
import {createOpenAI} from '@ai-sdk/openai';
import {createMockModel} from './mock-model';
import {createInterface} from 'node:readline';
import {ToolRegistry} from './tool-registry';
import {allTools} from './tools';
import {agentLoop} from './agent-loop';

const cc = createOpenAI({
  baseURL: 'https://147ai.online/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
});

console.log(process.env.DASHSCOPE_API_KEY);

const model = process.env.TEST_KEY
  ? cc.chat('claude-sonnet-4-6')
  : createMockModel();

const registry = new ToolRegistry();
registry.register(...allTools);

console.log(`已注册 ${registry.getAll().length} 个工具: `);

for (const tool of registry.getAll()) {
  const flags = [
    tool.isConcurrencySafe ? '可并发' : '串行',
    tool.isReadOnly ? '只读' : '读写',
  ].join(', ');
  console.log(` - ${tool.name} (${flags})`);
}

const messages: ModelMessage[] = [];
const rl = createInterface({input: process.stdin, output: process.stdout});

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
你有以下工具可用：get_weather, calculator, read_file, write_file, list_directory。
需要查询信息或操作文件时，主动使用工具，不要编造数据。
可以同时调用多个互不冲突的工具来提高效率。
回答要简洁直接。`;

function ask() {
  rl.question('\nYou: ', async (input) => {
    const trimmed = input.trim();
    if (!trimmed || trimmed === 'exit') {
      console.log('Bye!');
      rl.close();
      return;
    }

    messages.push({role: 'user', content: trimmed});

    await agentLoop(model, registry, messages, SYSTEM);

    ask();
  });
}

console.log('Super Agent v0.3 — Fuses (type "exit" to quit)\n');
console.log('试试输入：“测试死循环”、“测试重试” 或随便聊几轮观察 Token 用量\n');
ask();
