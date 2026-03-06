/**
 * AgentFactory — 统一 Agent 创建工厂
 *
 * 在新架构中，Factory 的职责是:
 *   - 将 Preset 配置 + DI 依赖 → AgentRuntime 实例
 *   - 提供 Router (intent → preset → runtime)
 *   - 提供快捷方法 (createChat, createInsight, ...)
 *
 * 关键变化 (vs 旧 AgentFactory):
 *   - 不再创建独立 Agent 子类
 *   - 只创建 AgentRuntime，通过 Preset 配置差异化行为
 *   - 同一个工厂，同一种 Runtime，不同的配置
 *
 * @module AgentFactory
 */

import Logger from '../../infrastructure/logging/Logger.js';
import { AgentMessage } from './AgentMessage.js';
import { AgentRouter, PresetName } from './AgentRouter.js';
import { AgentRuntime } from './AgentRuntime.js';
import { CapabilityRegistry } from './capabilities.js';
import { BudgetPolicy, PolicyEngine } from './policies.js';
import { getPreset, resolveStrategy } from './presets.js';
import { ContextWindow } from './context/ContextWindow.js';
import { ExplorationTracker } from './context/ExplorationTracker.js';
import { MemoryCoordinator } from './memory/MemoryCoordinator.js';
import { SCAN_TASK_CONFIGS, buildScanPipelineStages, buildRelationsPipelineStages } from './domain/scan-prompts.js';

export class AgentFactory {
  #container;
  #toolRegistry;
  #aiProvider;
  #logger;
  /** @type {AgentRouter|null} */
  #router = null;
  /** @type {Object} 共享的 Capability 实例缓存 (如 MemoryCoordinator) */
  #sharedOpts;

  /**
   * @param {Object} opts
   * @param {Object} opts.container - ServiceContainer 实例
   * @param {import('./tools/ToolRegistry.js').ToolRegistry} opts.toolRegistry
   * @param {import('../../external/ai/AiProvider.js').AiProvider} opts.aiProvider
   * @param {Object} [opts.memoryCoordinator] - MemoryCoordinator 实例 (注入 Conversation)
   * @param {string} [opts.projectBriefing] 项目概况文本
   * @param {string} [opts.projectRoot] 项目根目录
   */
  constructor({ container, toolRegistry, aiProvider, memoryCoordinator, projectBriefing, projectRoot }) {
    this.#container = container;
    this.#toolRegistry = toolRegistry;
    this.#aiProvider = aiProvider;
    this.#logger = Logger.getInstance();
    this.#sharedOpts = {
      memoryCoordinator: memoryCoordinator || null,
      projectBriefing: projectBriefing || null,
      projectRoot: projectRoot || process.cwd(),
    };
  }

  // ─── Router ──────────────────────────────────

  /**
   * 创建带路由器的自动调度系统
   * @returns {AgentRouter}
   */
  createRouter() {
    if (this.#router) return this.#router;

    const router = new AgentRouter();
    router.setAiProvider(this.#aiProvider);
    router.setExecutor((presetName, message, opts) => {
      const runtime = this.createRuntime(presetName, opts);
      return runtime.execute(message, opts.strategyOpts || opts);
    });

    this.#router = router;
    this.#logger.info('[AgentFactory] Router created');
    return router;
  }

  // ─── 核心创建方法 ─────────────────────────────

  /**
   * 根据 Preset 名称创建 AgentRuntime
   *
   * 这是一切的根基 — 任何 "Agent 类型" 都通过这个方法创建。
   *
   * @param {string} presetName - Preset 名称 (chat/insight/remote-exec)
   * @param {Object} [overrides] 覆盖 preset 配置
   * @returns {AgentRuntime}
   */
  createRuntime(presetName, overrides: any = {}) {
    const preset = getPreset(presetName, overrides);

    // 实例化 Capabilities
    const capabilities = preset.capabilities.map(name => {
      const opts = this.#getCapabilityOpts(name);
      return CapabilityRegistry.create(name, opts);
    });

    // 实例化 Policies — 支持工厂函数延迟实例化 (Preset 中 policy 可为 instance 或 factory)
    const resolvedPolicies = (preset.policies || []).map(policyOrFactory =>
      typeof policyOrFactory === 'function' ? policyOrFactory(overrides) : policyOrFactory
    );
    const policyEngine = new PolicyEngine(resolvedPolicies);

    return new AgentRuntime({
      presetName,
      aiProvider: this.#aiProvider,
      toolRegistry: this.#toolRegistry,
      container: this.#container,
      capabilities,
      strategy: preset.strategyInstance,
      policies: policyEngine,
      persona: preset.persona,
      memory: preset.memory,
      onProgress: overrides.onProgress || null,
      onToolCall: overrides.onToolCall || null,
      lang: overrides.lang || null,
      additionalTools: overrides.additionalTools || [],
      projectRoot: this.#sharedOpts.projectRoot,
    });
  }

  // ─── 快捷方法 (语义化) ─────────────────────

  /**
   * 创建 ContextWindow (根据当前 AI Provider 自动解析 token 预算)
   * @param {{ isSystem?: boolean }} [opts]
   * @returns {ContextWindow}
   */
  createContextWindow(opts: any = {}) {
    const modelName = this.#aiProvider?.model || '';
    const tokenBudget = ContextWindow.resolveTokenBudget(modelName, opts);
    return new ContextWindow(tokenBudget);
  }

  /**
   * 构建系统级多轮执行上下文 — 统一基础设施
   *
   * 抽取 bootstrap orchestrator 中创建 ExplorationTracker / ContextWindow / source 的
   * 通用逻辑，供 scanKnowledge 等系统场景共用完整的多轮 Agent 框架。
   *
   * 与 bootstrap orchestrator 保持一致的 MemoryCoordinator 管理模式:
   *   - 创建轻量级 MemoryCoordinator (无 PersistentMemory/SessionStore)
   *   - 通过 MC.createDimensionScope 创建并注册 ActiveContext
   *   - trace 从 MC.getActiveContext 获取 (统一生命周期管理)
   *   - memoryCoordinator 传入 strategyContext，供 reactLoop 每轮 buildDynamicMemoryPrompt
   *
   * 与 bootstrap orchestrator 对齐的关键字段:
   *   - activeContext: 与 trace 同一实例 — insightGateEvaluator 通过此字段
   *     决定走 buildAnalysisArtifact (完整: findings/evidenceMap/negativeSignals)
   *     还是 buildAnalysisReport (降级: 仅文本)
   *   - outputType: 'candidate' — 设置 quality_gate 的评判标准
   *   - dimId: 维度 ID — buildAnalysisArtifact 的 dimensionId 参数
   *
   * bootstrap orchestrator 不使用此方法（它还需要领域特定的 SessionStore / dimContext 等），
   * 但引擎层基础设施是一致的。
   *
   * @param {Object} [opts]
   * @param {Object} [opts.budget] 预算覆盖 (透传给 ExplorationTracker)
   * @param {string} [opts.trackerStrategy='analyst'] - tracker 策略名: 'analyst' | 'producer' | 'bootstrap'
   * @param {string} [opts.label='default'] 作用域标签 (用于 scopeId 命名 + dimId)
   * @param {string} [opts.lang] 项目语言 (透传给 sharedState._projectLanguage)
   * @returns {{ contextWindow: ContextWindow, tracker: ExplorationTracker, trace: import('./memory/ActiveContext.js').ActiveContext, activeContext: import('./memory/ActiveContext.js').ActiveContext, memoryCoordinator: MemoryCoordinator, outputType: string, dimId: string, sharedState: Object, source: string, scopeId: string }}
   */
  buildSystemContext({ budget, trackerStrategy = 'analyst', label = 'default', lang }: any = {}) {
    // 创建轻量级 MemoryCoordinator (scan 场景无 PersistentMemory/SessionStore)
    const mc = new MemoryCoordinator({ mode: 'bootstrap' });
    const scopeId = `scan:${label}`;
    mc.createDimensionScope(scopeId);

    const activeContext = mc.getActiveContext(scopeId);

    return {
      contextWindow: this.createContextWindow({ isSystem: true }),
      tracker: ExplorationTracker.resolve(
        { source: 'system', strategy: trackerStrategy },
        budget || {},
      ),
      // trace & activeContext 是同一个 ActiveContext 实例
      // trace: AgentRuntime reactLoop 使用 (startRound/setThought/endRound)
      // activeContext: insightGateEvaluator 检查此字段决定 artifact 路径
      trace: activeContext,
      activeContext,
      memoryCoordinator: mc,
      // outputType: bootstrap orchestrator 设为 'candidate'（insightGateEvaluator 的评判标准）
      outputType: 'candidate',
      // dimId: buildAnalysisArtifact 的 dimensionId 参数
      dimId: label,
      sharedState: {
        submittedTitles: new Set(),
        submittedPatterns: new Set(),
        // G6: _projectLanguage — ToolExecutionPipeline 透传给工具 handler 上下文
        _projectLanguage: lang || null,
        // G7: _dimensionScopeId — ToolExecutionPipeline 透传给工具 handler (note_finding scope)
        _dimensionScopeId: scopeId,
      },
      source: 'system',
      scopeId,
    };
  }

  /**
   * 获取 AI Provider 信息 (供 orchestrator 等外部使用)
   * @returns {{ model: string, name: string }}
   */
  getAiProviderInfo() {
    return {
      model: this.#aiProvider?.model || 'unknown',
      name: this.#aiProvider?.name || 'unknown',
    };
  }

  /**
   * 创建对话 Runtime (Dashboard / 飞书聊天)
   * @param {Object} [opts]
   */
  createChat(opts: any = {}) {
    return this.createRuntime(PresetName.CHAT, opts);
  }

  /**
   * 创建洞察 Runtime (深度代码分析 + 知识提取)
   * @param {Object} [opts]
   * @param {Array} [opts.dimensions] 维度列表 (传给 FanOutStrategy 的 items)
   * @param {Object} [opts.projectInfo] 项目信息
   */
  createInsight(opts: any = {}) {
    return this.createRuntime(PresetName.INSIGHT, opts);
  }

  /**
   * 创建飞书对话 Runtime (知识管理，服务端处理)
   * @param {Object} [opts]
   */
  createLark(opts: any = {}) {
    return this.createRuntime(PresetName.LARK, opts);
  }

  /**
   * 创建远程执行 Runtime (飞书终端 / 远程操作)
   * @param {Object} [opts]
   */
  createRemoteExec(opts: any = {}) {
    return this.createRuntime(PresetName.REMOTE_EXEC, opts);
  }

  // ─── 领域语义方法 (意图驱动, Agent 直接完成 AI 推理) ─────

  /**
   * 统一知识扫描 — 走 insight 管线 (Analyze → QualityGate → Produce → RejectionGate)
   *
   * extract 和 summarize 共享工具驱动管线 (collect_scan_recipe)，
   * 仅 Produce 阶段的 systemPrompt 和预算不同:
   * - extract: 多文件 target 扫描，24 iter analyze，24 iter produce
   * - summarize: 单文件/代码片段，12 iter analyze，12 iter produce
   *
   * 关系发现请使用单独的 discoverRelations() 方法。
   *
   * @param {Object} opts
   * @param {string} opts.label              上下文标签（target 名 / 文件名）
   * @param {Array<{name, content, language?}>} opts.files 源文件
   * @param {'extract'|'summarize'} [opts.task='extract'] 任务类型
   * @param {string} [opts.lang]             语言提示
   * @param {boolean} [opts.comprehensive]   深度扫描标志
   * @returns {Promise<Object>}              - task-specific JSON
   */
  async scanKnowledge({ label, files, task = 'extract', lang, comprehensive }: any = {}) {
    const taskConfig = SCAN_TASK_CONFIGS[task];
    if (!taskConfig) {
      throw new Error(`Unknown scanKnowledge task: "${task}". Available: ${Object.keys(SCAN_TASK_CONFIGS).join(', ')}`);
    }
    const { producePrompt, fallback } = taskConfig;

    // extract 和 summarize 都使用 code_analysis 分析 + scan_production 工具驱动
    const analyzeCaps = ['code_analysis'];
    const produceCaps = ['scan_production'];

    // ── 统一 4 阶段 Pipeline (与冷启动 orchestrator 对齐) ──
    // summarize (单文件) 使用较低预算
    const analyzeMaxIter = task === 'summarize' ? 12 : 24;
    const stages = buildScanPipelineStages({
      task,
      producePrompt,
      analyzeCaps,
      produceCaps,
      files,
      analyzeMaxIter,
    });

    // ── 创建 Runtime — 使用 insight preset + 对齐 policies ──
    const runtime = this.createRuntime(PresetName.INSIGHT, {
      strategy: { type: 'pipeline', maxRetries: 1, stages },
      capabilities: analyzeCaps,
      policies: [
        new BudgetPolicy({
          maxIterations: 30, // 24 stage budget + 6 tracker grace
          maxTokens: 8192,
          temperature: 0.3,
          timeoutMs: 600_000,
        }),
      ],
      memory: { enabled: false },
      lang,
    });
    if (files?.length) {
      runtime.setFileCache(files);
    }

    // ── 完整的系统级多轮基础设施 (含 MemoryCoordinator 管理 ActiveContext) ──
    const systemCtx = this.buildSystemContext({
      budget: { maxIterations: analyzeMaxIter },
      trackerStrategy: 'analyst',
      label: `${task}:${label}`,
      lang,
    });

    // ── 执行 ──
    const message = AgentMessage.internal(
      `分析 "${label}" 的 ${files?.length || 0} 个源文件。${comprehensive ? '请进行深度分析。' : ''}`,
    );
    const result = await runtime.execute(message, { strategyContext: systemCtx });

    // ── 提取结果 — extract 和 summarize 统一从 toolCalls 提取 ──
    const allToolCalls = result.toolCalls || [];
    const recipes = allToolCalls
      .filter(tc => (tc.tool || tc.name) === 'collect_scan_recipe')
      .map(tc => {
        const res = tc.result;
        if (res && typeof res === 'object' && res.status === 'collected' && res.recipe) {
          return res.recipe;
        }
        return null;
      })
      .filter(Boolean);

    if (recipes.length > 0) {
      // summarize 向后兼容: 扁平化首个 recipe 为 { title, summary, usageGuide, ... }
      if (task === 'summarize') {
        const first = recipes[0];
        return {
          title: first.title || '',
          summary: first.description || first.summary || '',
          usageGuide: first.usageGuide || '',
          category: first.category || '',
          headers: first.headers || [],
          tags: first.tags || [],
          trigger: first.trigger || '',
          recipes,
          extracted: recipes.length,
        };
      }
      return { targetName: label, extracted: recipes.length, recipes };
    }

    // Fallback: 工具未被调用时，尝试从文本解析
    const produceReply = result.phases?.produce?.reply || result.reply;
    return this.#parseJsonResponse(produceReply, fallback(label));
  }

  /**
   * 知识图谱关系发现 — 独立管线 (Explore → Synthesize)
   *
   * 与 scanKnowledge 不同，relations 不需要源文件输入，
   * 而是通过查询知识库 + 读取源码发现知识条目间的语义关系。
   *
   * @param {Object} [opts]
   * @param {number} [opts.batchSize=20] 批次大小提示
   * @returns {Promise<{ analyzed: number, relations: Array }>}
   */
  async discoverRelations({ batchSize = 20 } = {}) {
    const stages = buildRelationsPipelineStages();

    const runtime = this.createRuntime(PresetName.INSIGHT, {
      strategy: { type: 'pipeline', stages },
      capabilities: ['knowledge_production', 'code_analysis'],
      policies: [
        new BudgetPolicy({
          maxIterations: 28,
          maxTokens: 8192,
          temperature: 0.3,
          timeoutMs: 420_000,
        }),
      ],
      memory: { enabled: false },
    });

    const message = AgentMessage.internal(
      `探索知识库中所有知识条目之间的语义关系。每批分析约 ${batchSize} 条知识。`,
    );
    const result = await runtime.execute(message);

    const synthesizeReply = result.phases?.synthesize?.reply || result.reply;
    return this.#parseJsonResponse(synthesizeReply, { analyzed: 0, relations: [] });
  }

  /**
   * AI 翻译 — chat 模式，单轮生成
   *
   * Agent(LLM) 直接翻译文本，无需工具。
   *
   * @param {string} summary 中文摘要
   * @param {string} [usageGuide] 中文使用指南
   * @returns {Promise<{ summaryEn?: string, usageGuideEn?: string, error?: string }>}
   */
  async translateToEnglish(summary, usageGuide) {
    if (!summary && !usageGuide) {
      return { summaryEn: '', usageGuideEn: '' };
    }

    const runtime = this.createChat({
      policies: [
        new BudgetPolicy({ maxIterations: 1, maxTokens: 4096, temperature: 0.2, timeoutMs: 60_000 }),
      ],
      persona: {
        description: [
          '你是技术文档翻译专家。将中文技术内容翻译为地道的英文。保持技术术语不变。',
          '',
          '## 输出格式（必须是纯 JSON，不包含任何其他文字）',
          '{ "summaryEn": "...", "usageGuideEn": "..." }',
        ].join('\n'),
      },
      memory: { enabled: false },
    });

    const message = AgentMessage.internal(
      `翻译以下内容为英文，输出纯 JSON：\nsummary: ${summary || '(空)'}\nusageGuide: ${usageGuide || '(空)'}`,
    );

    const result = await runtime.execute(message);
    return this.#parseJsonResponse(result.reply, {
      summaryEn: summary || '',
      usageGuideEn: usageGuide || '',
    });
  }

  /**
   * 冷启动知识库 — 直接调用 handler（纯启发式，不需要 LLM）
   *
   * bootstrap_knowledge 是纯启发式工具：SPM Target 扫描 → 依赖图谱 → Guard 审计 →
   * Candidate 创建，全程无 AI 推理。直接调用 handler 即可，无需创建 Agent。
   *
   * @param {{ maxFiles?: number, skipGuard?: boolean, contentMaxLines?: number, loadSkills?: boolean, skipAsyncFill?: boolean }} [opts]
   * @returns {Promise<Object>}
   */
  async bootstrapKnowledge(opts: any = {}) {
    const { bootstrapKnowledge } = await import('../../external/mcp/handlers/bootstrap-internal.js');
    const result = await bootstrapKnowledge(
      { container: this.#container, logger: this.#logger },
      {
        maxFiles: opts.maxFiles || 500,
        skipGuard: opts.skipGuard || false,
        contentMaxLines: opts.contentMaxLines || 120,
        loadSkills: opts.loadSkills ?? true,
        skipAsyncFill: opts.skipAsyncFill || false,
      },
    );
    const parsed = typeof result === 'string' ? JSON.parse(result) : result;
    return parsed?.data || parsed;
  }

  /**
   * 通用工具执行 — 直接调用工具 handler
   *
   * 纯数据工具直接执行，无需创建 Agent。
   * AI 推理由各语义方法的 Agent 自主完成，此方法仅用于纯数据工具。
   *
   * @param {string} toolName 工具名称
   * @param {Object} params 工具参数
   * @returns {Promise<*>} 工具原始返回值
   */
  async invokeAgent(toolName, params) {
    return this.#toolRegistry.execute(toolName, params, this.#makeToolContext());
  }

  // ─── 私有方法 ────────────────────────────────

  /**
   * 解析 Agent 响应中的 JSON（支持 markdown 代码块包装）
   * @param {string} text - Agent 响应文本
   * @param {Object} fallback 解析失败时的默认值
   * @returns {Object}
   */
  #parseJsonResponse(text, fallback) {
    if (!text) return fallback;
    try {
      // 尝试从 markdown 代码块中提取 JSON
      const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        return JSON.parse(codeBlockMatch[1].trim());
      }
      // 尝试直接提取 JSON 对象
      const objMatch = text.match(/(\{[\s\S]*\})/);
      if (objMatch) {
        return JSON.parse(objMatch[1].trim());
      }
      return JSON.parse(text.trim());
    } catch {
      this.#logger.warn('[AgentFactory] Failed to parse JSON from Agent response');
      return fallback;
    }
  }

  /**
   * 构建工具 handler 执行所需的上下文对象
   * @returns {Object}
   */
  #makeToolContext() {
    return {
      aiProvider: this.#aiProvider,
      container: this.#container,
      logger: this.#logger,
      projectRoot: this.#sharedOpts.projectRoot,
    };
  }

  /**
   * 获取 Capability 实例化时需要的依赖注入参数
   */
  #getCapabilityOpts(capabilityName) {
    switch (capabilityName) {
      case 'conversation':
        return {
          memoryCoordinator: this.#sharedOpts.memoryCoordinator,
          projectBriefing: this.#sharedOpts.projectBriefing,
        };
      case 'system_interaction':
        return {
          projectRoot: this.#sharedOpts.projectRoot,
        };
      default:
        return {};
    }
  }
}

export default AgentFactory;
