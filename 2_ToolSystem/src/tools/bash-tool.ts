import {execSync} from 'child_process';
import {ToolDefinition} from '../tool-registry';

export const bashTool: ToolDefinition = {
  name: 'bash',
  description:
    '执行 shell 命令并返回输出。适合运行脚本、检测环境、执行构建等操作。',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: '要执行的 shell 命令',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  maxResultChars: 3000,
  execute: async ({command}) => {
    // 先检测环境是否支持 child_process
    try {
      execSync('echo test', {stdio: 'ignore'});
    } catch {
      return `[base 不可用] 当前环境不支持 shell 命令。本地终端运行可使用。`;
    }

    try {
      const output = execSync(command, {
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });
      return output || '(命令执行成功，无输出)';
    } catch (error: any) {
      return `命令执行失败 (exit ${error.status || 1}:\n${error.stderr || error.message})`;
    }
  },
};
