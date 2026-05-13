/** Agent 循环执行模块
 * 负责多步骤推理-执行循环，包含重试、循环检测和Token预算控制
 * @module
 */

import {streamText, type ModelMessage} from 'ai';
import {detect, recordCall, recordResult, resetHistory} from './loop_detection';
import {isRetryable, calculateDelay, sleep} from './retry.js';
import {ToolRegistry} from './tool-registry';

/** 最大迭代步数 */
const MAX_STEPS = 15;
/** 最大重试次数 */
const MAX_RETRIES = 3;
/** Token 预算上限 */
const TOKEN_BUDGET = 50000;

/**
 * Agent 主循环
 * 执行多步骤的推理-执行循环：调用模型 → 处理工具调用 → 收集结果 → 继续下一步
 * @param model AI 模型实例
 * @param registry 工具注册中心
 * @param messages 对话消息历史（会被修改）
 * @param system 系统提示词
 */
export async function agentLoop(
  model: any,
  registry: ToolRegistry,
  messages: ModelMessage[],
  system: string,
) {
  /** 当前步数 */
  let step = 0;
  /** 累计消耗Token数 */
  let totalTokens = 0;
  // 初始化循环检测历史
  resetHistory();

  // 主循环：最多执行 MAX_STEPS 步
  while (step < MAX_STEPS) {
    step++;
    console.log(`\n--- Step ${step} ---`);

    /** 本步是否有工具调用 */
    let hasToolCall = false;
    /** 本步累积的完整文本 */
    let fullText = '';
    /** 是否因检测到循环而需要停止 */
    let shouldBreak = false;
    /** 记录最后一个工具调用信息（用于关联结果） */
    let lastToolCall: {name: string; input: unknown} | null = null;
    let stepResponse: Awaited<ReturnType<typeof streamText>['response']>;
    let stepUsage: Awaited<ReturnType<typeof streamText>['usage']>;

    // 步骤级重试：包裹整个 stream 消费过程
    for (let attempt = 1; ; attempt++) {
      try {
        // 调用模型流式输出
        const result = streamText({
          model,
          system,
          tools: registry.toAISDKFormat(),
          messages,
          maxRetries: 0,
          onError: (err) => {
            // console.log('错误原因：', err);
          },
        });

        // 消费流，处理各类型输出
        for await (const part of result.fullStream) {
          // console.log('🚀 ~ agentLoop ~ part:', part);
          switch (part.type) {
            // 文本增量：直接输出并累积
            case 'text-delta':
              process.stdout.write(part.text);
              fullText += part.text;
              break;

            // 工具调用：执行工具并检测循环
            case 'tool-call': {
              hasToolCall = true;
              lastToolCall = {name: part.toolName, input: part.input};
              console.log(
                `  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`,
              );

              // 检测是否陷入循环
              const detection = detect(part.toolName, part.input);
              if (detection.stuck) {
                console.log(`  ${detection.message}`);
                // critical级别立即停止，否则插入提醒消息让模型换思路
                if (detection.level === 'critical') {
                  shouldBreak = true;
                } else {
                  messages.push({
                    role: 'user' as const,
                    content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
                  });
                }
              }
              // 记录本次调用
              recordCall(part.toolName, part.input);
              break;
            }

            // 工具结果：记录并输出
            case 'tool-result':
              // console.log(`  [结果: ${JSON.stringify(part.output)}]`);
              if (lastToolCall) {
                recordResult(
                  lastToolCall.name,
                  lastToolCall.input,
                  part.output,
                );
              }
              break;
          }
        }

        // 获取响应消息和使用量
        stepResponse = await result.response;
        stepUsage = await result.usage;
        break;
      } catch (error) {
        // 错误处理：检查是否可重试
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error;
        const delay = calculateDelay(attempt);
        console.log(
          `  [重试] 第 ${attempt}/${MAX_RETRIES} 次失败，${delay}ms 后重试...`,
        );
        await sleep(delay);
        // 重置本步状态
        hasToolCall = false;
        fullText = '';
        shouldBreak = false;
        lastToolCall = null;
      }
    }

    // 循环检测触发：停止执行
    if (shouldBreak) {
      console.log('\n[循环检测触发，Agent 已停止]');
      break;
    }

    // 将本步产生的消息追加到历史
    // console.log('  [本步消息]');
    // console.log(...stepResponse!.messages.map((msg) => msg.content));
    messages.push(...stepResponse!.messages);

    // Token 预算追踪：计算输入+输出Token
    const inp =
      typeof stepUsage?.inputTokens === 'number'
        ? stepUsage.inputTokens
        : (stepUsage?.inputTokens?.total ?? 0);
    const out =
      typeof stepUsage?.outputTokens === 'number'
        ? stepUsage.outputTokens
        : (stepUsage?.outputTokens?.total ?? 0);
    totalTokens += inp + out;
    const pct = Math.round((totalTokens / TOKEN_BUDGET) * 100);
    console.log(`  [Token] ${totalTokens}/${TOKEN_BUDGET} (${pct}%)`);
    // Token 超预算：强制停止
    if (totalTokens > TOKEN_BUDGET) {
      console.log('\n[Token 预算耗尽，强制停止]');
      break;
    }

    // 无工具调用：说明模型已完成任务
    if (!hasToolCall) {
      if (fullText) console.log(fullText);
      break;
    }

    console.log('  → 继续下一步...');
  }

  // 达到最大步数限制
  if (step >= MAX_STEPS) {
    console.log('\n[达到最大步数限制，强制停止]');
  }
}
