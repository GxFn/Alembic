/**
 * IntentClassifier — 自然语言意图分类器
 *
 * 核心问题: 用户通过飞书发了一句自然语言，应该交给谁处理？
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │  "帮我搜索一下项目里关于用户认证的知识"                 │
 *   │   → bot_agent (知识管理任务，服务端 AgentRuntime 处理)    │
 *   │                                                          │
 *   │  "把 src/auth.ts 里的 JWT 验证改成 OAuth2"              │
 *   │   → ide_agent (编程任务，转发到 VSCode Copilot)          │
 *   │                                                          │
 *   │  "现在服务状态怎么样"                                    │
 *   │   → system (系统状态查询，本地直接处理)                   │
 *   └──────────────────────────────────────────────────────────┘
 *
 * 三层分类策略 (延迟递增):
 *   1. 规则匹配 — 零延迟关键词/模式 (~0ms)
 *   2. 嵌入相似度 — 轻量向量匹配 (~50ms) [可选]
 *   3. LLM 分类 — 精确但需 AI 调用 (~500ms)
 *
 * 设计原则:
 *   - 宁可多走 LLM 也不要误分类 — 用户体验优先
 *   - bot_agent 是默认，除非明确检测到编程意图
 *   - 系统查询是硬编码模式，不走 AI
 *
 * @module IntentClassifier
 */

import type { AiProvider } from '../../external/ai/AiProvider.js';
import Logger from '../../infrastructure/logging/Logger.js';

/**
 * 意图类型
 */
export const Intent = Object.freeze({
  /** 知识管理任务 — 搜索/创建/分析知识，由服务端 AgentRuntime 处理 */
  BOT_AGENT: 'bot_agent',
  /** IDE 编程任务 — 代码编写/修改/调试/重构，转发到 VSCode Copilot */
  IDE_AGENT: 'ide_agent',
  /** 系统操作 — 状态查询/截图/连接管理，本地直接处理 */
  SYSTEM: 'system',
});

/**
 * 分类结果
 * @typedef {Object} ClassificationResult
 * @property {string} intent - Intent 枚举值
 * @property {number} confidence - 0-1 置信度
 * @property {string} reasoning 分类理由 (用于日志/调试)
 * @property {string} method - 'rule' | 'llm' 分类方法
 * @property {string} [extractedCommand] - 提取的核心指令 (去除 meta 包装)
 */

// ─── 规则匹配表 ─────────────────────────────────

// ── 自然语言 meta 包装模式 ──
// 用户说"在编辑器内输入X"、"让 Copilot 帮我X"，实际指令是 X
const META_WRAPPER_PATTERNS = [
  /^(?:在|去|到)\s*(?:编辑器|IDE|VSCode|VS Code|Copilot|代码编辑器)\s*(?:内|里|中|上)?\s*(?:输入|写|执行|处理|帮我)?\s*/i,
  /^(?:让|请|麻烦)\s*(?:编辑器|IDE|VSCode|VS Code|Copilot|Agent)\s*(?:帮我|帮忙|来)?\s*/i,
  /^(?:请|麻烦)?\s*(?:在|去|到)\s*(?:IDE|编辑器|VSCode)\s*(?:里|中|内)?\s*(?:帮我)?\s*/i,
  /^(?:帮我|请)?\s*(?:在|用)\s*(?:编辑器|IDE|Copilot)\s*(?:里|中)?\s*/i,
];

/**
 * 系统操作规则 — 硬编码匹配，优先级最高
 * 这些过去是 /command，现在用自然语言检测
 */
const SYSTEM_RULES = [
  { pattern: /状态|status|连接.*状态|诊断|服务.*状态|链路/i, action: 'status' },
  { pattern: /截图|screenshot|screen|截屏|画面/i, action: 'screen' },
  { pattern: /帮助|help|怎么用|使用说明/i, action: 'help' },
  { pattern: /队列|queue|排队|待执行/i, action: 'queue' },
  { pattern: /取消|cancel|撤销|不要了|别执行了/i, action: 'cancel' },
  { pattern: /清[理空]|clear|clean.*历史/i, action: 'clear' },
  { pattern: /^(ping|pong|测试连[通接])/i, action: 'ping' },
];

/**
 * IDE 编程意图 — 强信号关键词
 * 如果匹配到这些，大概率是编程任务
 */
const IDE_STRONG_SIGNALS = [
  // 直接编程动作
  /修改|修复|改一下|改成|fix|refactor|重构|优化.*代码/i,
  /写一个|实现|implement|创建.*文件|新建.*组件|添加.*功能/i,
  /删除.*代码|移除|remove.*from|把.*去掉/i,
  /调试|debug|排查.*bug|解决.*报错|修.*error/i,
  // 文件/代码引用
  /\.(?:ts|js|tsx|jsx|py|go|rs|java|swift|vue|css|html|json)\b/i,
  /src\/|lib\/|components\/|pages\/|app\//i,
  // 技术术语 + 动作
  /(?:函数|方法|接口|类|组件|模块|hook).{0,10}(?:改|加|删|写|重构|优化)/i,
  /(?:改|加|删|写|重构|优化).{0,10}(?:函数|方法|接口|类|组件|模块|hook)/i,
  // 终端/构建命令
  /运行|执行|run.*command|exec|npm|yarn|pnpm|cargo|go run|python/i,
  /编译|build|compile|部署|deploy/i,
  // Git 操作
  /commit|push|pull|merge|branch|rebase|cherry.?pick|stash|git\s+(log|status|diff|show|add|reset|checkout|switch|tag)/i,
  // 代码审查
  /review.*代码|看看.*写得|检查.*实现/i,
];

/**
 * Bot Agent 意图 — 知识管理相关关键词
 */
const BOT_STRONG_SIGNALS = [
  // 知识库操作
  /知识库|knowledge.*base|搜索知识|查[找询].*知识/i,
  /recipe|候选|candidate|snippet/i,
  /冷启动|bootstrap|初始化.*项目/i,
  // 分析/理解（非编程修改）
  /解释|explain|帮我理解|什么意思|是什么/i,
  /分析.*架构|项目.*结构|代码.*组织/i,
  /总结|summarize|概括|提取.*要点/i,
  // 翻译
  /翻[译成]|translate/i,
  // 知识管理对话
  /聊聊|讨论|你觉得|建议|推荐/i,
  /guard|规则|约束|violation|违规/i,
];

// ─── LLM 分类 Schema ────────────────────────────

const CLASSIFY_SCHEMA = {
  name: 'classify_lark_intent',
  description: 'Classify a Lark message and extract the core command to forward',
  parameters: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        enum: ['bot_agent', 'ide_agent'],
        description:
          'bot_agent: knowledge search/management/analysis/conversation tasks handled on the server. ide_agent: code writing/editing/debugging/refactoring/terminal tasks forwarded to VSCode Copilot.',
      },
      confidence: {
        type: 'number',
        description: 'Confidence 0-1',
      },
      reasoning: {
        type: 'string',
        description: 'Brief reasoning in Chinese',
      },
      extractedCommand: {
        type: 'string',
        description:
          'The core task/command extracted from the user message, removing meta-instructions like "在编辑器内输入", "让 Copilot 帮我", "请在 IDE 里" etc. If the message is already a direct command, return it as-is. For bot_agent, this is the core question/request.',
      },
    },
    required: ['intent', 'confidence', 'extractedCommand'],
  },
};

const CLASSIFY_SYSTEM_PROMPT = `你是一个意图分类器。用户通过飞书发送消息，你需要判断这条消息应该交给哪个 Agent 处理：

**bot_agent** — 知识管理 Bot (服务端处理):
- 搜索/查询/浏览项目知识库
- 创建/编辑/管理知识条目 (Recipe/Candidate)
- 项目架构分析、代码解释、翻译、总结
- 一般性对话、建议、推荐
- 知识库冷启动、Guard 规则管理
- 不需要直接修改源代码文件

**ide_agent** — IDE 编程 Agent (VSCode Copilot 处理):
- 创建/修改/删除源代码文件
- 调试、修复 bug、重构代码
- 运行终端命令 (npm/yarn/cargo/git 等)
- 代码审查、PR 相关操作
- 任何需要直接操作项目文件的任务

关键判断原则:
1. 如果任务涉及"修改源代码"→ ide_agent
2. 如果任务涉及"理解/搜索/管理知识"→ bot_agent
3. 模糊时倾向 bot_agent (成本更低，用户可重新触发)

**extractedCommand 提取规则:**
用户消息可能包含 meta 指令包装，你需要提取出核心任务：
- "在编辑器内输入新增按钮" → extractedCommand: "新增按钮"
- "让 Copilot 帮我重构 auth 模块" → extractedCommand: "重构 auth 模块"
- "请在 IDE 里把登录页改成暗色主题" → extractedCommand: "把登录页改成暗色主题"
- "帮我搜索一下认证相关知识" → extractedCommand: "搜索认证相关知识"
- "修复 src/app.ts 的类型错误" → extractedCommand: "修复 src/app.ts 的类型错误" (已是直接指令，原样返回)
去掉"在编辑器/IDE/Copilot 里"、"帮我输入"、"请执行"等 meta 包装，保留核心意图。`;

// ─── IntentClassifier 实现 ──────────────────────

export class IntentClassifier {
  /** @type {import('../../external/ai/AiProvider.js').AiProvider|null} */
  #aiProvider: AiProvider | null;
  #logger;

  /**
   * 从用户消息中提取核心指令，去除 meta 包装
   *
   * "在编辑器内输入新增按钮" → "新增按钮"
   * "让 Copilot 帮我重构 auth" → "重构 auth"
   * "修复 bug" → "修复 bug" (无包装，原样返回)
   */
  static extractCommand(text: string): string {
    let result = text;
    for (const pattern of META_WRAPPER_PATTERNS) {
      const match = result.match(pattern);
      if (match && match[0].length < result.length) {
        result = result.slice(match[0].length).trim();
        break; // 只匹配第一个 meta 包装
      }
    }
    return result || text; // 防止提取为空
  }

  /**
   * @param {Object} opts
   * @param {import('../../external/ai/AiProvider.js').AiProvider} [opts.aiProvider]
   */
  constructor({ aiProvider = null } = {}) {
    this.#aiProvider = aiProvider;
    this.#logger = Logger.getInstance();
  }

  /**
   * 分类用户消息意图
   *
   * @param {string} text 用户原始消息文本
   * @param {Object} [context] 额外上下文 (如对话历史、最近操作)
   * @returns {Promise<ClassificationResult>}
   */
  async classify(text: string, context: Record<string, unknown> = {}) {
    if (!text?.trim()) {
      return { intent: Intent.BOT_AGENT, confidence: 1, reasoning: '空消息', method: 'rule' };
    }

    const trimmed = text.trim();

    // ── Layer 0: 提取 meta 包装中的核心指令 ──
    // "在编辑器内输入新增按钮" → extracted="新增按钮", 原始保留用于后续分类
    const extracted = IntentClassifier.extractCommand(trimmed);

    // ── Layer 1: 系统操作 (硬编码，零延迟) ──
    // 对原始文本和提取后文本都检查
    const sysMatch =
      this.#matchSystem(trimmed) || (extracted !== trimmed ? this.#matchSystem(extracted) : null);
    if (sysMatch) {
      return sysMatch;
    }

    // ── Layer 2: 强信号关键词匹配 ──
    // 如果有 meta 包装（"在编辑器里输入X"），直接判定为 ide_agent
    if (extracted !== trimmed) {
      return {
        intent: Intent.IDE_AGENT,
        confidence: 0.95,
        reasoning: `Meta 包装检测: 原始="${trimmed.slice(0, 40)}" → 核心="${extracted.slice(0, 40)}"`,
        method: 'rule',
        extractedCommand: extracted,
      };
    }

    const ruleMatch = this.#matchRules(trimmed);
    if (ruleMatch && ruleMatch.confidence >= 0.8) {
      this.#logger.info(
        `[IntentClassifier] Rule match: ${ruleMatch.intent} (${ruleMatch.confidence})`
      );
      return ruleMatch;
    }

    // ── Layer 3: LLM 分类 (精确，需 AI) ──
    if (this.#aiProvider && this.#aiProvider.name !== 'mock') {
      const llmResult = await this.#classifyWithLLM(trimmed, context);
      if (llmResult) {
        this.#logger.info(
          `[IntentClassifier] LLM: ${llmResult.intent} (${llmResult.confidence}) — ${llmResult.reasoning}`
        );
        return llmResult;
      }
    }

    // ── Fallback: 使用规则结果或默认 bot_agent ──
    if (ruleMatch) {
      return ruleMatch;
    }

    return {
      intent: Intent.BOT_AGENT,
      confidence: 0.5,
      reasoning: '无法确定意图，默认使用 Bot Agent',
      method: 'fallback',
    };
  }

  // ─── 私有方法 ────────────────────────────────

  /**
   * 系统操作匹配 (优先级最高)
   */
  #matchSystem(text: string) {
    for (const rule of SYSTEM_RULES) {
      if (rule.pattern.test(text)) {
        return {
          intent: Intent.SYSTEM,
          confidence: 1,
          reasoning: `系统操作: ${rule.action}`,
          method: 'rule',
          action: rule.action,
        };
      }
    }
    return null;
  }

  /**
   * 强信号关键词匹配
   */
  #matchRules(text: string) {
    let ideScore = 0;
    let botScore = 0;
    const ideMatches: string[] = [];
    const botMatches: string[] = [];

    for (const re of IDE_STRONG_SIGNALS) {
      if (re.test(text)) {
        ideScore++;
        ideMatches.push(re.source.slice(0, 30));
      }
    }

    for (const re of BOT_STRONG_SIGNALS) {
      if (re.test(text)) {
        botScore++;
        botMatches.push(re.source.slice(0, 30));
      }
    }

    // 没有任何匹配 → null (交给 LLM)
    if (ideScore === 0 && botScore === 0) {
      return null;
    }

    // 明确的分差
    if (ideScore > botScore && ideScore >= 2) {
      return {
        intent: Intent.IDE_AGENT,
        confidence: Math.min(0.6 + ideScore * 0.1, 0.95),
        reasoning: `IDE 信号: ${ideMatches.join(', ')}`,
        method: 'rule',
      };
    }

    if (botScore > ideScore && botScore >= 2) {
      return {
        intent: Intent.BOT_AGENT,
        confidence: Math.min(0.6 + botScore * 0.1, 0.95),
        reasoning: `Bot 信号: ${botMatches.join(', ')}`,
        method: 'rule',
      };
    }

    // 分差不明确 → 返回低置信度结果 (让 LLM 决定)
    const winner = ideScore > botScore ? Intent.IDE_AGENT : Intent.BOT_AGENT;
    return {
      intent: winner,
      confidence: 0.5 + Math.abs(ideScore - botScore) * 0.1,
      reasoning: `弱信号: IDE=${ideScore} Bot=${botScore}`,
      method: 'rule',
    };
  }

  /**
   * LLM 分类
   */
  async #classifyWithLLM(text: string, context: Record<string, unknown> = {}) {
    try {
      const recentHistory = context.recentHistory as string | undefined;
      const userMsg = recentHistory
        ? `最近对话:\n${recentHistory}\n\n当前消息: "${text}"`
        : `用户消息: "${text}"`;

      const result = await this.#aiProvider!.chatWithTools(userMsg, {
        messages: [],
        toolSchemas: [CLASSIFY_SCHEMA],
        toolChoice: 'required',
        systemPrompt: CLASSIFY_SYSTEM_PROMPT,
        temperature: 0,
        maxTokens: 200,
      });

      const call = result.functionCalls?.[0]?.args;
      if (call?.intent) {
        return {
          intent: call.intent as string,
          confidence: (call.confidence as number) ?? 0.8,
          reasoning: (call.reasoning as string) || 'LLM 分类',
          method: 'llm',
          extractedCommand: (call.extractedCommand as string) || undefined,
        };
      }
    } catch (err: unknown) {
      this.#logger.warn(
        `[IntentClassifier] LLM error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return null;
  }
}

export default IntentClassifier;
