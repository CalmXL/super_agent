import {tool} from 'ai';
import {z} from 'zod';

export const weatherTool = tool({
  description: '查询指定城市的天气信息',
  parameters: z.object({
    city: z.string().describe('城市名称，如“北京”、“上海”'),
  }),
  execute: async ({city}) => {
    const mockWeather: Record<string, string> = {
      北京: '晴，15-25°C，东南风 2 级',
      上海: '多云，18-22°C，西南风 3 级',
      深圳: '阵雨，22-28°C，南风 2 级',
      广州: '多云转晴，20-28°C，东风 3 级',
      杭州: '晴，14-24°C，北风 2 级',
      成都: '阴，16-22°C，微风',
    };
    return mockWeather[city] || `${city}：暂无数据`;
  },
});

export const calculatorTool = tool({
  description: '计算数学表达式的结果。当用户提问涉及数学运算时使用',
  parameters: z.object({
    expression: z.string().describe('数学表达式，如 "2 + 3 * 4"'),
  }),
  execute: async ({expression}) => {
    try {
      const result = new Function(`return ${expression}`)();
      return `${expression} = ${result}`;
    } catch {
      return `无法计算: ${expression}`;
    }
  },
});
