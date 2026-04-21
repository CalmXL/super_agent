import {jsonSchema} from 'ai';

export const weatherTool = {
  description: '查询指定城市的天气信息',
  inputSchema: jsonSchema({
    type: 'object' as const,
    properties: {
      city: {
        type: 'string' as const,
        description: '城市名称，如“北京”、“上海”',
      },
    },
    required: ['city'],
    additionalProperties: false,
  }),
  execute: async ({city}: {city: string}) => {
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
};

export const calculatorTool = {
  description: '计算数学表达式的结果。当用户提问涉及数学运算时使用',
  inputSchema: jsonSchema({
    type: 'object' as const,
    properties: {
      expression: {
        type: 'string' as const,
        description: '数学表达式，如 "2 + 3 * 4"',
      },
    },
    required: ['expression'],
    additionalProperties: false,
  }),
  execute: async ({expression}: {expression: string}) => {
    try {
      const result = new Function(`return ${expression}`)();
      return `${expression} = ${result}`;
    } catch {
      return `无法计算: ${expression}`;
    }
  },
};
