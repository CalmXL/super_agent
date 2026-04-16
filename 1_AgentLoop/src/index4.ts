import 'dotenv/config';
import {generateText, ModelMessage, stepCountIs, streamText} from 'ai';
import {createOpenAI} from '@ai-sdk/openai';
import {createMockModel} from './mock-model';
import {createInterface} from 'node:readline';
import {weatherTool, calculatorTool} from './tools';

const tools = {
  get_weather: weatherTool,
  calculator: calculatorTool,
};

const qwen = createOpenAI({
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
});

const model = process.env.DASHSCOPE_API_KEY
  ? qwen.chat('qwen-plus-latest')
  : createMockModel();

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

const messages: ModelMessage[] = [];

function ask() {
  rl.question('\nYou: ', async (input) => {
    const trimmed = input.trim();
    if (!trimmed || trimmed === 'exit') {
      console.log('Bye!');
      rl.close();
      return;
    }

    messages.push({role: 'user', content: trimmed});

    const result = streamText({
      model,
      system:
        '你是 Super Agent，一个有工具调用能力的 AI 助手。需要时主动使用工具获取信息，不要编造数据。',
      tools,
      messages,
      stopWhen: stepCountIs(5),
    });

    process.stdout.write('Assistant: ');
    let fullResponse = '';

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          process.stdout.write(part.text);
          fullResponse += part.text;
          break;
        case 'tool-call':
          console.log(
            `\n  [调用工具: ${part.toolName}(${JSON.stringify(part.input)})]`,
          );
          break;
        case 'tool-result':
          console.log(`  [工具返回: ${JSON.stringify(part.output)}]`);
          break;
      }
    }

    console.log(); // 换行
    messages.push({role: 'assistant', content: fullResponse});

    ask();
  });
}

console.log('Super Agent v0.2 — Agent Loop (type "exit" to quit)\n');
ask();
