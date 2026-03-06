/**
 * AgentRouter — Intent → Preset 解析器
 *
 * 在统一架构下，Router 的职责简化为:
 *   - 理解用户意图 (intent classification)
 *   - 映射到正确的 Preset (配置组合)
 *   - 创建 AgentRuntime 并执行
 *
 * 路由策略 (优先级递减):
 *   1. 手动指定 (API `preset` 参数)
 *   2. 渠道特征 (如飞书终端命令以 > 开头 → remote-exec)
 *   3. 关键词匹配 (零延迟正则)
 *   4. LLM 意图分类 (精确但需 AI 调用)
 *   5. 默认 → chat
 *
 * 关键区别 (vs 旧 AgentRouter):
 *   - 旧版路由到 AgentMode (chat/bootstrap/scan/lark_bridge) → 4 种 Agent 类型
 *   - 新版路由到 Preset (chat/insight/remote-exec) → 同一 Runtime 的不同配置
 *   - 不再存在 "LarkBridge" 模式 — 飞书和前端共享同一 Preset
 *
 * @module AgentRouter
 */

import Logger from '../../infrastructure/logging/Logger.js';
import { AgentEventBus } from './AgentEventBus.js';
import { Channel } from './AgentMessage.js';

/**
 * Preset 名称枚举
 */
export const PresetName = Object.freeze({
  CHAT: 'chat',
  INSIGHT: 'insight',
  LARK: 'lark',
  REMOTE_EXEC: 'remote-exec',
});

/**
 * 关键词 → Preset 映射 (零延迟快速路径)
 */
const KEYWORD_ROUTES = [
  {
    preset: PresetName.INSIGHT,
    keywords: [
      /冷启动|cold[\s-]?start|初始化知识库|bootstrap/i,
      /重建知识库|rebuild.*knowledge/i,
      /全项目.*分析|analyze.*entire.*project/i,
      /扫描|scan|分析.*目录|分析.*文件夹|analyze.*folder/i,
      /检查.*target|审计.*模块|audit.*module/i,
      /深度分析.*路径|知识提取/i,
    ],
  },
  {
    preset: PresetName.REMOTE_EXEC,
    keywords: [
      /^[>$]\s*/, // 以 > 或 $ 开头 = 终端命令
      /运行命令|执行命令|run.*command|exec.*command/i,
    ],
  },
];

/**
 * LLM 路由分类 Schema
 */
const ROUTE_CLASSIFICATION_SCHEMA = {
  name: 'classify_intent',
  description: 'Classify user intent to determine which agent preset to use',
  parameters: {
    type: 'object',
    properties: {
      preset: {
        type: 'string',
        enum: ['chat', 'insight', 'lark', 'remote-exec'],
        description:
          'The preset to route to. chat=conversation, insight=code analysis and knowledge extraction, lark=Lark knowledge management, remote-exec=terminal commands',
      },
      confidence: {
        type: 'number',
        description: 'Confidence score 0-1',
      },
      reasoning: {
        type: 'string',
        description: 'Brief reasoning for the classification',
      },
    },
    required: ['preset', 'confidence'],
  },
};

export class AgentRouter {
  #logger;
  #bus;
  /** @type {import('../../external/ai/AiProvider.js').AiProvider|null} */
  #aiProvider: any = null;
  /** @type {Function|null} — (presetName, message, opts) => Promise<AgentResult> */
  #executor: any = null;

  constructor() {
    this.#logger = Logger.getInstance();
    this.#bus = AgentEventBus.getInstance();
  }

  /**
   * 设置 AI Provider (用于 LLM 路由)
   * @param {import('../../external/ai/AiProvider.js').AiProvider} provider
   */
  setAiProvider(provider: any) {
    this.#aiProvider = provider;
  }

  /**
   * 设置执行器 — Factory 提供的 (presetName, message, opts) => AgentResult
   * @param {Function} executor
   */
  setExecutor(executor: any) {
    this.#executor = executor;
  }

  /**
   * 路由并执行
   *
   * @param {import('./AgentMessage.js').AgentMessage} message 统一消息
   * @param {Object} [opts]
   * @param {string} [opts.preset] 手动指定 Preset (跳过路由)
   * @param {Object} [opts.strategyOpts] 策略特定选项 (如 FanOut 的 items)
   * @returns {Promise<{preset: string, result: Object}>}
   */
  async route(message: any, opts: any = {}) {
    // 1. 手动指定
    let preset = opts.preset || message.metadata?.mode;

    // 2. 渠道特征路由
    if (!preset) {
      preset = this.#matchChannel(message);
      if (preset) {
        this.#logger.info(`[AgentRouter] Channel match → ${preset}`);
      }
    }

    // 3. 关键词匹配
    if (!preset) {
      preset = this.#matchKeyword(message.content);
      if (preset) {
        this.#logger.info(`[AgentRouter] Keyword match → ${preset}`);
      }
    }

    // 4. LLM 分类
    if (!preset && this.#aiProvider) {
      preset = await this.#classifyWithLLM(message.content);
      if (preset) {
        this.#logger.info(`[AgentRouter] LLM classification → ${preset}`);
      }
    }

    // 5. 默认 → chat
    if (!preset) {
      preset = PresetName.CHAT;
    }

    // 执行
    if (!this.#executor) {
      throw new Error('[AgentRouter] No executor set. Call setExecutor() first.');
    }

    this.#logger.info(`[AgentRouter] Dispatching → preset="${preset}" channel=${message.channel}`);

    const result = await this.#executor(preset, message, opts);
    return { preset, result };
  }

  /**
   * 仅分类意图，不执行
   * @param {import('./AgentMessage.js').AgentMessage} message
   * @returns {Promise<string>} preset name
   */
  async classify(message: any) {
    let preset = message.metadata?.mode;
    if (!preset) {
      preset = this.#matchChannel(message);
    }
    if (!preset) {
      preset = this.#matchKeyword(message.content);
    }
    if (!preset && this.#aiProvider) {
      preset = await this.#classifyWithLLM(message.content);
    }
    return preset || PresetName.CHAT;
  }

  // ─── 私有方法 ────────────────────────────────

  /**
   * 渠道特征路由
   * 飞书消息默认 → lark preset (知识管理对话)
   * 飞书终端命令 (> 开头) → remote-exec
   */
  #matchChannel(message: any) {
    if (message.channel === Channel.LARK) {
      const text = message.content.trim();
      // 飞书消息以 > 或 $ 开头 → 终端命令
      if (/^[>$]\s*/.test(text)) {
        return PresetName.REMOTE_EXEC;
      }
      // 默认走 lark preset (知识管理对话)
      return PresetName.LARK;
    }
    return null;
  }

  #matchKeyword(prompt: any) {
    for (const route of KEYWORD_ROUTES) {
      for (const re of route.keywords) {
        if (re.test(prompt)) {
          return route.preset;
        }
      }
    }
    return null;
  }

  async #classifyWithLLM(prompt: any) {
    try {
      const result = await this.#aiProvider.chatWithTools(
        `Classify this user message into the correct preset: "${prompt.slice(0, 300)}"`,
        {
          messages: [],
          toolSchemas: [ROUTE_CLASSIFICATION_SCHEMA],
          toolChoice: 'required',
          systemPrompt:
            'You classify user intents for an AI coding assistant. Respond by calling the classify_intent function.',
          temperature: 0,
          maxTokens: 200,
        }
      );

      if (result.functionCalls?.[0]?.args?.preset) {
        const classified = result.functionCalls[0].args;
        if (classified.confidence > 0.6) {
          return classified.preset;
        }
      }
    } catch (err: any) {
      this.#logger.warn(`[AgentRouter] LLM classification failed: ${err.message}`);
    }
    return null;
  }
}

export default AgentRouter;
