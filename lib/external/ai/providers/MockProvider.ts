/**
 * MockProvider - 测试用 AI 提供商
 * 返回固定/随机数据，不发网络请求
 */

import { AiProvider, type AiProviderConfig, type ChatContext } from '../AiProvider.js';

interface MockResponses {
  chat?: string;
  summarize?: Record<string, unknown>;
  [key: string]: unknown;
}

interface CallLogEntry {
  method: string;
  [key: string]: unknown;
}

export class MockProvider extends AiProvider {
  callLog: CallLogEntry[];

  responses: MockResponses;
  constructor(config: AiProviderConfig & { responses?: MockResponses } = {}) {
    super(config);
    this.name = 'mock';
    this.model = 'mock-model';
    this.responses = config.responses || {};
    this.callLog = [];
  }

  async chat(prompt: string, context: ChatContext = {}) {
    this.callLog.push({ method: 'chat', prompt, context });
    if (this.responses.chat) {
      return this.responses.chat;
    }
    return `Mock response for: ${prompt.slice(0, 80)}`;
  }

  async summarize(code: string) {
    this.callLog.push({ method: 'summarize', code: code?.slice(0, 80) });
    if (this.responses.summarize) {
      return this.responses.summarize;
    }
    return {
      title: 'Mock Summary',
      description: `Summary of ${code?.length || 0} chars`,
      language: 'unknown',
      patterns: [],
      keyAPIs: [],
    };
  }

  async embed(text: string | string[]) {
    this.callLog.push({ method: 'embed', text: Array.isArray(text) ? text.length : 1 });
    const dim = 768;
    const makeVector = () => Array.from({ length: dim }, () => Math.random() * 2 - 1);
    if (Array.isArray(text)) {
      return text.map(() => makeVector());
    }
    return makeVector();
  }

  /**
   * 获取调用日志（测试断言用）
   */
  getCalls() {
    return this.callLog;
  }

  /**
   * 重置调用记录
   */
  reset() {
    this.callLog = [];
  }
}

export default MockProvider;
