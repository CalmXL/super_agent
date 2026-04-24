import {streamText, type ModelMessage} from 'ai';
import {detect, recordCall, recordResult, resetHistory} from './loop_detection';

// Agent 单次运行的最大步数，防止无限循环
const MAX_STEPS = 15;

/**
 * Agent 主循环函数
 * @param model - AI 模型实例
 * @param tools - 可用工具定义
 * @param messages - 对话消息历史
 * @param system - 系统提示词
 * @returns 最后返回完整消息数组
 */
export async function agentLoop(
  model: any,
  tools: any,
  messages: ModelMessage[],
  system: string,
) {
  // 当前步数计数器
  let step = 0;
  // 重置循环检测历史记录
  resetHistory();

  // 主循环：持续执行直至达到最大步数或主动退出
  while (step < MAX_STEPS) {
    step++;
    console.log(`\n--- Step ${step} ---`);

    // 调用 AI 模型生成响应，支持流式输出
    const result = streamText({
      model,
      system,
      tools,
      messages,
      maxRetries: 0,
      onError: () => {},
    });

    // 标记本次循环是否有工具调用
    let hasToolCall = false;
    // 累积完整文本响应
    let fullText = '';
    // 是否需要立即终止循环
    let shouldBreak = false;
    // 记录最后一次工具调用信息（用于关联结果）
    let lastToolCall: {name: string; input: unknown} | null = null;

    // 流式处理模型输出
    for await (const part of result.fullStream) {
      switch (part.type) {
        // 处理文本增量输出
        case 'text-delta':
          process.stdout.write(part.text);
          fullText += part.text;
          break;

        // 处理工具调用请求
        case 'tool-call': {
          hasToolCall = true;
          lastToolCall = {name: part.toolName, input: part.input};
          console.log(
            `  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`,
          );

          // 循环检测：检查是否存在重复调用模式
          const detection = detect(part.toolName, part.input);
          if (detection.stuck) {
            console.log(`  ${detection.message}`);
            // 严重级别直接终止循环
            if (detection.level === 'critical') {
              shouldBreak = true;
            } else {
              // 非严重级别：向用户发送提示消息，引导改变思路
              messages.push({
                role: 'user' as const,
                content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
              });
            }
          }
          // 记录本次工具调用供循环检测使用
          recordCall(part.toolName, part.input);
          break;
        }

        // 处理工具执行结果
        case 'tool-result':
          console.log(`  [结果: ${JSON.stringify(part.output)}]`);
          if (lastToolCall) {
            recordResult(lastToolCall.name, lastToolCall.input, part.output);
          }
          break;
      }
    }

    // 循环检测触发严重级别，直接终止
    if (shouldBreak) {
      console.log('\n[循环检测触发，Agent 已停止]');
      break;
    }

    // 获取完整响应并更新消息历史
    const stepResult = await result.response;
    messages.push(...stepResult.messages);

    // 无工具调用说明本次响应已完成，退出循环
    if (!hasToolCall) {
      if (fullText) console.log();
      break;
    }

    console.log('  \u2192 继续下一步...');
  }

  // 达到最大步数限制时的提示
  if (step >= MAX_STEPS) {
    console.log('\n[达到最大步数限制，强制停止]');
  }
}
