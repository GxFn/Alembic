/**
 * MockProvider — Smart Mock AI 提供商
 *
 * 不发网络请求，但根据 prompt 内容智能匹配场景，返回符合格式的仿真响应。
 * 用于让用户在没有 API Key 的情况下体验 Alembic 完整工作流。
 *
 * 智能匹配场景:
 *   1. probe / ping → "pong"
 *   2. 重复度检测 (DUPLICATE/SIMILAR/UNIQUE) → "UNIQUE"
 *   3. 对话压缩总结 → 从消息中提取关键词
 *   4. 代码上下文化 (<chunk>) → 从代码提取函数/类名
 *   5. 候选润色 (JSON 9字段) → 原样回传输入字段
 *   6. 维度摘要 (dimensionDigest) → 模板化 JSON
 *   7. 风格检查建议 → 空数组
 *   8. Agent 路由分类 → functionCall classify_intent
 *   9. 通用 fallback → 语义化占位文本
 *
 * 模拟延迟: 50-200ms 随机延迟，营造 "AI 思考" 体验
 */

import {
  AiProvider,
  type AiProviderConfig,
  type ChatContext,
  type ChatWithToolsOptions,
  type ChatWithToolsResult,
  type StructuredOutputOptions,
} from '../AiProvider.js';

// ── 类型定义 ──────────────────────────────────────────────

interface MockResponses {
  chat?: string;
  summarize?: Record<string, unknown>;
  [key: string]: unknown;
}

interface CallLogEntry {
  method: string;
  [key: string]: unknown;
}

// ── 工具函数 ──────────────────────────────────────────────

/** 模拟延迟 (50-200ms) */
function mockDelay(): Promise<void> {
  const ms = 50 + Math.floor(Math.random() * 150);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 模拟 token 用量 */
function mockUsage(prompt: string, response: string) {
  return {
    inputTokens: Math.ceil(prompt.length / 4),
    outputTokens: Math.ceil(response.length / 4),
    totalTokens: Math.ceil(prompt.length / 4) + Math.ceil(response.length / 4),
  };
}

/** 从代码片段中提取函数/类/结构名称 */
function extractCodeSymbols(code: string): string[] {
  const symbols: string[] = [];
  // Swift/TS class/struct/protocol/enum
  for (const m of code.matchAll(/(?:class|struct|protocol|enum|interface|type)\s+(\w+)/g)) {
    symbols.push(m[1]);
  }
  // func/function
  for (const m of code.matchAll(/(?:func|function)\s+(\w+)/g)) {
    symbols.push(m[1]);
  }
  // property patterns
  for (const m of code.matchAll(/(?:let|var|const)\s+(\w+)/g)) {
    if (m[1].length > 3) {
      symbols.push(m[1]);
    }
  }
  return [...new Set(symbols)].slice(0, 8);
}

/** 从 prompt 中尝试提取 JSON 输入（用于润色回传） */
function extractJsonFromPrompt(prompt: string): Record<string, unknown> | null {
  try {
    const match = prompt.match(/\{[\s\S]*?"description"[\s\S]*?\}/);
    if (match) {
      return JSON.parse(match[0]) as Record<string, unknown>;
    }
  } catch {
    /* parse failed */
  }
  return null;
}

// ── MockProvider ─────────────────────────────────────────

export class MockProvider extends AiProvider {
  callLog: CallLogEntry[];
  responses: MockResponses;

  constructor(config: AiProviderConfig & { responses?: MockResponses } = {}) {
    super(config);
    this.name = 'mock';
    this.model = 'mock-smart';
    this.responses = config.responses || {};
    this.callLog = [];
  }

  // ── 核心: chat() 智能路由 ──────────────────────────────

  async chat(prompt: string, context: ChatContext = {}): Promise<string> {
    this.callLog.push({ method: 'chat', prompt: prompt.slice(0, 200), context });
    await mockDelay();

    // 0. 用户注入的固定响应（单元测试用）
    if (this.responses.chat) {
      return this.responses.chat;
    }

    const p = prompt.toLowerCase();

    // 1. Probe / ping
    if (p === 'ping' || p.includes('ping')) {
      return 'pong';
    }

    // 2. 重复度检测 — "请回答: DUPLICATE / SIMILAR / UNIQUE"
    if (p.includes('duplicate') && p.includes('similar') && p.includes('unique')) {
      return 'UNIQUE';
    }

    // 3. 对话压缩总结 — "请用 2-3 句话总结"
    if (p.includes('总结以下对话') || p.includes('summarize the following')) {
      const lines = prompt
        .split('\n')
        .filter((l) => l.startsWith('[user]') || l.startsWith('[assistant]'));
      const topics = lines
        .slice(0, 3)
        .map((l) => l.slice(0, 60))
        .join('；');
      return `[Mock 摘要] 对话涉及: ${topics || '项目开发相关讨论'}。用户和助手讨论了代码实现和架构设计。`;
    }

    // 4. 代码上下文化 — <chunk>...</chunk>
    if (p.includes('<chunk>')) {
      const chunkMatch = prompt.match(/<chunk>([\s\S]*?)<\/chunk>/);
      if (chunkMatch) {
        const symbols = extractCodeSymbols(chunkMatch[1]);
        if (symbols.length > 0) {
          return `This chunk defines ${symbols.slice(0, 3).join(', ')} which handles ${symbols.length > 3 ? symbols.slice(3, 5).join(' and ') : 'core logic'} in the module.`;
        }
        return 'This chunk contains utility code for the module.';
      }
    }

    // 5. 候选润色 — "知识库条目润色助手" + JSON 输出
    if (p.includes('知识库条目润色') || p.includes('润色助手')) {
      const existing = extractJsonFromPrompt(prompt);
      if (existing) {
        return JSON.stringify(existing);
      }
      return JSON.stringify({
        description: '[Mock] 保持原内容不变',
        pattern: '',
        markdown: '',
        rationale: '',
        tags: [],
        confidence: 0.8,
        aiInsight: null,
        agentNotes: null,
        relations: {},
      });
    }

    // 6. 维度摘要 — "dimensionDigest"
    if (p.includes('dimensiondigest') || p.includes('dimension digest')) {
      const dimMatch =
        prompt.match(/维度[：:]\s*["']?(\w[\w-]+)/i) ||
        prompt.match(/dimension[：:]\s*["']?(\w[\w-]+)/i);
      const dimId = dimMatch?.[1] || 'unknown';
      const countMatch = prompt.match(/提交了\s*(\d+)\s*个候选/);
      const count = countMatch ? parseInt(countMatch[1], 10) : 3;
      return `\`\`\`json
${JSON.stringify(
  {
    dimensionDigest: {
      summary: `[Mock] ${dimId} 维度分析完成，基于项目代码结构生成了 ${count} 个候选知识。`,
      candidateCount: count,
      keyFindings: ['项目采用模块化架构设计', '发现多个核心设计模式', '代码风格整体一致'],
      crossRefs: {},
      gaps: ['部分模块缺少充分的文档注释'],
      remainingTasks: [],
    },
  },
  null,
  2
)}
\`\`\``;
    }

    // 7. 风格检查建议 — "violation" + "suggestion"
    if (p.includes('violation') && p.includes('suggestion')) {
      return '[]';
    }

    // 8. 分析报告 — "Markdown 格式" + "代码分析报告"
    if (p.includes('代码分析报告') || p.includes('分析报告')) {
      const symbols = extractCodeSymbols(prompt);
      return `## Mock 代码分析报告

### 核心发现

1. **模块结构**: 项目采用分层架构，${symbols.length > 0 ? `核心类型包括 ${symbols.slice(0, 3).join('、')}` : '各模块职责清晰'}
2. **设计模式**: 广泛使用协议/接口抽象和依赖注入
3. **代码质量**: 类型安全处理规范，错误处理完善

### 文件分析

分析的文件展现了良好的代码组织，模块间通过明确的接口通信。

> ⚠️ 此报告由 Mock AI 生成，仅包含模板化分析结果。`;
    }

    // 9. 通用 fallback — 语义化占位
    const symbols = extractCodeSymbols(prompt);
    const topic =
      symbols.length > 0
        ? `关于 ${symbols.slice(0, 3).join('、')} 的分析`
        : `对 ${prompt.slice(0, 40).replace(/\n/g, ' ')} 的回复`;
    return `[Mock AI] ${topic}。此响应由 Mock 模式生成，非真实 AI 分析结果。`;
  }

  // ── chatWithTools() — 智能函数调用模拟 ─────────────────

  async chatWithTools(
    prompt: string,
    opts: ChatWithToolsOptions = {}
  ): Promise<ChatWithToolsResult> {
    this.callLog.push({
      method: 'chatWithTools',
      prompt: prompt.slice(0, 200),
      toolChoice: opts.toolChoice,
    });
    await mockDelay();

    const schemas = (opts.toolSchemas || []) as Array<{ name: string }>;
    const schemaNames = schemas.map((s) => s.name);

    // toolChoice='none' → 纯文本回复（维度摘要、最终总结等）
    if (opts.toolChoice === 'none') {
      const text = await this.chat(prompt, {
        systemPrompt: opts.systemPrompt,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
      });
      return { text, functionCalls: null, usage: mockUsage(prompt, text) };
    }

    // Agent 路由分类 — classify_intent tool
    if (schemaNames.includes('classify_intent')) {
      const response = JSON.stringify({ type: 'general', confidence: 0.9 });
      return {
        text: null,
        functionCalls: [
          {
            id: `mock-fc-${Date.now()}`,
            name: 'classify_intent',
            args: { type: 'general', confidence: 0.9 },
          },
        ],
        usage: mockUsage(prompt, response),
      };
    }

    // 有 tool schemas → 返回文本（让 AgentRuntime 的文本解析处理）
    // Mock 不模拟复杂的多步工具调用链 — bootstrap 走 lightweight pipeline
    if (schemas.length > 0) {
      const text = `[Mock] 我已完成对项目代码的分析。基于代码结构，发现了几个关键的设计模式和架构约定。

以下是主要发现：
1. 项目采用模块化分层架构
2. 核心模块使用依赖注入模式
3. 错误处理遵循统一的类型安全约定

> 此分析由 Mock AI 生成，结果基于模板。切换到真实 AI Provider 可获得深度项目分析。`;
      return { text, functionCalls: null, usage: mockUsage(prompt, text) };
    }

    // 无 tools → 纯文本
    const text = await this.chat(prompt, {
      systemPrompt: opts.systemPrompt,
      temperature: opts.temperature,
      maxTokens: opts.maxTokens,
    });
    return { text, functionCalls: null, usage: mockUsage(prompt, text) };
  }

  // ── chatWithStructuredOutput() — 结构化 JSON 模拟 ──────

  async chatWithStructuredOutput(
    prompt: string,
    opts: StructuredOutputOptions = {}
  ): Promise<unknown> {
    this.callLog.push({ method: 'chatWithStructuredOutput', prompt: prompt.slice(0, 200) });
    await mockDelay();

    const p = prompt.toLowerCase();

    // 候选润色 → 尝试回传 prompt 中的 JSON
    if (p.includes('润色') || p.includes('refine')) {
      const existing = extractJsonFromPrompt(prompt);
      if (existing) {
        return existing;
      }
      return {
        description: '[Mock] 保持原内容',
        pattern: '',
        markdown: '',
        rationale: '',
        tags: [],
        confidence: 0.8,
        aiInsight: null,
        agentNotes: null,
        relations: {},
      };
    }

    // 风格检查 → 空数组
    if (opts.openChar === '[' || p.includes('violation')) {
      return [];
    }

    // 通用 → 尝试从 prompt 中提取已有 JSON，否则返回空对象
    const existing = extractJsonFromPrompt(prompt);
    return existing || {};
  }

  // ── summarize() — 代码摘要 ─────────────────────────────

  async summarize(code: string) {
    this.callLog.push({ method: 'summarize', code: code?.slice(0, 80) });
    await mockDelay();

    if (this.responses.summarize) {
      return this.responses.summarize;
    }

    const symbols = extractCodeSymbols(code || '');
    const lang = code?.includes('func ')
      ? 'swift'
      : code?.includes('function ')
        ? 'typescript'
        : code?.includes('def ')
          ? 'python'
          : 'unknown';

    return {
      title: symbols.length > 0 ? `${symbols[0]} 模块` : 'Mock Summary',
      description:
        symbols.length > 0
          ? `定义了 ${symbols.slice(0, 3).join('、')} 等 ${symbols.length} 个核心类型`
          : `Summary of ${code?.length || 0} chars`,
      language: lang,
      patterns: symbols.slice(0, 3).map((s) => `${s} pattern`),
      keyAPIs: symbols.slice(0, 4),
    };
  }

  // ── embed() — 确定性伪向量 ─────────────────────────────

  async embed(text: string | string[]) {
    this.callLog.push({ method: 'embed', text: Array.isArray(text) ? text.length : 1 });

    // 使用基于内容的确定性哈希生成向量（相似文本产生相似向量）
    const dim = 768;
    const makeVector = (input: string) => {
      let hash = 0;
      for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
      }
      return Array.from({ length: dim }, (_, i) => {
        // 基于 hash + 位置的伪随机，范围 [-1, 1]
        const x = Math.sin(hash * 0.001 + i * 0.7127) * 43758.5453;
        return (x - Math.floor(x)) * 2 - 1;
      });
    };

    if (Array.isArray(text)) {
      return text.map((t) => makeVector(t));
    }
    return makeVector(text);
  }

  // ── probe() — 连接检测 ────────────────────────────────

  async probe(): Promise<boolean> {
    this.callLog.push({ method: 'probe' });
    return true;
  }

  // ── 辅助方法 ──────────────────────────────────────────

  /** 获取调用日志（测试断言用） */
  getCalls() {
    return this.callLog;
  }

  /** 重置调用记录 */
  reset() {
    this.callLog = [];
  }
}

export default MockProvider;
