# AI SDK

## streamText

streamText 可以简化从大语言模型中提取文本流的操作。

### result.fullStream

可以从 `fullStream` 属性来读取包含所有事件的流。

```javascript
import {streamText} from 'ai';
import {z} from 'zod';

const result = streamText({
  model: 'anthropic/claude-sonnet-4.5',
  tools: {
    cityAttractions: {
      inputSchema: z.object({city: z.string()}),
      execute: async ({city}) => ({
        attractions: ['attraction1', 'attraction2', 'attraction3'],
      }),
    },
  },
  prompt: 'What are some San Francisco tourist attractions?',
});

for await (const part of result.fullStream) {
  switch (part.type) {
    case 'start': {
      // 整个流式传输过程正式启动
      break;
    }
    case 'start-step': {
      // 开始了一个新的交互步
      break;
    }
    case 'text-start': {
      // 模型开始输出真正的人类可见文本。
      break;
    }
    case 'text-delta': {
      // 文本流的切片（比如输出了一个字或一个词 part.textDelta）。
      break;
    }
    case 'text-end': {
      // 当前文本段落输出完毕。
      break;
    }
    case 'reasoning-start': {
      // handle reasoning start
      break;
    }
    case 'reasoning-delta': {
      // handle reasoning delta here
      break;
    }
    case 'reasoning-end': {
      // handle reasoning end
      break;
    }
    case 'source': {
      // handle source here
      break;
    }
    case 'file': {
      // handle file here
      break;
    }
    case 'tool-call': {
      // 模型发出了调用工具的指令，并确定了参数（例如给 city 传了 "San Francisco"）。
      switch (part.toolName) {
        case 'cityAttractions': {
          // handle tool call here
          break;
        }
      }
      break;
    }
    case 'tool-input-start': {
      // handle tool input start
      break;
    }
    case 'tool-input-delta': {
      // handle tool input delta
      break;
    }
    case 'tool-input-end': {
      // handle tool input end
      break;
    }
    case 'tool-result': {
      // 工具（你的 execute 函数）执行完毕，并返回了数据（['attraction1', ...]）。
      switch (part.toolName) {
        case 'cityAttractions': {
          // handle tool result here
          break;
        }
      }
      break;
    }
    case 'tool-error': {
      // handle tool error
      break;
    }
    case 'finish-step': {
      // handle finish step
      break;
    }
    case 'finish': {
      // 整个流完全结束（所有的模型回复、工具调用、多不循环全部彻底填装完毕）
      break;
    }
    case 'error': {
      // 流传输过程中发生了未捕获的严重异常（如网络中断、API 凭证失效、模型崩了）
      break;
    }
    case 'raw': {
      // handle raw value
      break;
    }
  }
}
```
