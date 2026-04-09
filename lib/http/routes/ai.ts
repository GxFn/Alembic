/**
 * AI API 路由
 * AI 提供商管理、摘要、翻译、对话、.env LLM 配置
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Request, type Response } from 'express';
import { AgentMessage, Channel } from '../../agent/AgentMessage.js';
import { ConversationStore } from '../../agent/ConversationStore.js';
import { buildProjectBriefing } from '../../agent/core/ChatAgentPrompts.js';
import {
  taskCheckAndSubmit,
  taskDiscoverAllRelations,
  taskFullEnrich,
  taskGuardFullScan,
  taskQualityAudit,
} from '../../agent/domain/ChatAgentTasks.js';
import { PRESETS } from '../../agent/presets.js';
import { createProvider } from '../../external/ai/AiFactory.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { getRealtimeService } from '../../infrastructure/realtime/RealtimeService.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { ValidationError } from '../../shared/errors/index.js';
import { resolveProjectRoot } from '../../shared/resolveProjectRoot.js';
import {
  AiChatBody,
  AiConfigBody,
  AiEnvConfigBody,
  AiFormatUsageGuideBody,
  AiLangBody,
  AiStreamBody,
  AiSummarizeBody,
  AiTaskBody,
  AiToolBody,
  AiTranslateBody,
} from '../../shared/schemas/http-requests.js';
import { validate } from '../middleware/validate.js';
import { createStreamSession, getStreamSession } from '../utils/sse-sessions.js';

const router = express.Router();
const logger = Logger.getInstance();

/** 获取 DI 容器 */
function getContainer() {
  return getServiceContainer();
}

/** 检查 AI Provider 是否可用（非 mock），不可用则抛 ValidationError */
function requireAiReady() {
  const container = getContainer();
  const manager = container.singletons?._aiProviderManager as { isMock: boolean } | undefined;
  if (manager?.isMock) {
    throw new ValidationError('AI Provider 未配置，当前为 Mock 模式。请先在 .env 中配置 API Key。');
  }
  return container;
}

// ═══════════════════════════════════════════════════════
//  UI 语言偏好 — 前端 ↔ 服务端同步
// ═══════════════════════════════════════════════════════

/**
 * GET /api/v1/ai/lang
 * 获取当前默认 UI 语言（由系统环境变量初始化，前端可覆盖）
 */
router.get('/lang', async (req: Request, res: Response): Promise<void> => {
  const container = getContainer();
  res.json({ success: true, data: { lang: container.getLang() || 'zh' } });
});

/**
 * POST /api/v1/ai/lang
 * 更新默认 UI 语言（前端切语言时同步到服务端）
 */
router.post('/lang', validate(AiLangBody), async (req: Request, res: Response): Promise<void> => {
  const { lang } = req.body;
  const container = getContainer();
  container.setLang(lang);
  logger.info(`UI language preference updated to "${lang}"`);
  res.json({ success: true, data: { lang } });
});

/**
 * GET /api/v1/ai/providers
 * 获取可用的 AI 提供商列表
 */
router.get('/providers', async (req: Request, res: Response): Promise<void> => {
  // API Key 环境变量映射（与 AiFactory.autoDetectProvider 保持一致）
  const KEY_ENVS = {
    google: 'ASD_GOOGLE_API_KEY',
    openai: 'ASD_OPENAI_API_KEY',
    deepseek: 'ASD_DEEPSEEK_API_KEY',
    claude: 'ASD_CLAUDE_API_KEY',
  };

  const providers = [
    { id: 'google', label: 'Google Gemini', defaultModel: 'gemini-3-flash-preview' },
    { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-4o' },
    { id: 'deepseek', label: 'DeepSeek', defaultModel: 'deepseek-chat' },
    { id: 'claude', label: 'Claude', defaultModel: 'claude-3-5-sonnet-20240620' },
    { id: 'ollama', label: 'Ollama', defaultModel: 'llama3' },
    { id: 'mock', label: 'Mock (测试)', defaultModel: 'mock-l3' },
  ].map((p) => ({
    ...p,
    hasKey: (KEY_ENVS as Record<string, string>)[p.id]
      ? !!process.env[(KEY_ENVS as Record<string, string>)[p.id]]
      : true, // ollama / mock 不需要 key，始终可用
  }));

  res.json({ success: true, data: providers });
});

/**
 * GET /api/v1/ai/config
 * 获取当前 AI 配置（优先从 AiProviderManager 读取）
 */
router.get('/config', async (req: Request, res: Response): Promise<void> => {
  const container = getServiceContainer();
  const manager = container.singletons?._aiProviderManager as {
    name: string;
    model: string;
    isMock: boolean;
  };
  res.json({
    success: true,
    data: { provider: manager.name, model: manager.model, isMock: manager.isMock },
  });
});

/**
 * POST /api/v1/ai/config
 * 更新 AI 配置（切换提供商/模型）— 通过 AiProviderManager 统一热切换
 */
router.post(
  '/config',
  validate(AiConfigBody),
  async (req: Request, res: Response): Promise<void> => {
    const { provider, model } = req.body;

    // 创建新的 provider 实例验证配置有效
    let newProvider: ReturnType<typeof createProvider>;
    try {
      newProvider = createProvider({
        provider: provider.toLowerCase(),
        model: model || undefined,
      });
    } catch (error: unknown) {
      throw new ValidationError(`Invalid provider: ${(error as Error).message}`);
    }

    // 通过 reloadAiProvider → AiProviderManager.switchProvider() 统一热切换
    const container = getServiceContainer();
    container.reloadAiProvider(newProvider as unknown as Record<string, unknown>);
    logger.info('AI provider switched via AiProviderManager', {
      provider: provider.toLowerCase(),
      model: newProvider.model,
    });

    res.json({
      success: true,
      data: {
        provider: provider.toLowerCase(),
        model: newProvider.model,
        name: newProvider.name,
      },
    });
  }
);

/**
 * POST /api/v1/ai/mock/cleanup
 * 清理 Mock 模式产生的候选数据
 */
router.post('/mock/cleanup', async (_req: Request, res: Response): Promise<void> => {
  const container = getContainer();
  const knowledgeService = container.get('knowledgeService');
  const dbConn = container.get('database') as {
    getDb(): {
      prepare(sql: string): { all(...p: unknown[]): unknown[]; run(...p: unknown[]): void };
    };
  };
  const rawDb = dbConn.getDb();

  // 查找所有 mock 来源的候选
  const mockSources = ['mock-bootstrap', 'mock-pipeline'];
  let totalDeleted = 0;

  for (const source of mockSources) {
    const rows = rawDb
      .prepare('SELECT id FROM knowledge_entries WHERE source = ?')
      .all(source) as Array<{ id: string }>;

    for (const row of rows) {
      try {
        await knowledgeService.delete(row.id, { userId: 'system:mock-cleanup' });
        totalDeleted++;
      } catch {
        logger.debug(`Mock cleanup: failed to delete ${row.id}`);
      }
    }
  }

  // 清理 mock 相关的 semantic_memories
  try {
    rawDb
      .prepare(
        "DELETE FROM semantic_memories WHERE source = 'bootstrap' AND metadata LIKE '%mock%'"
      )
      .run();
  } catch {
    // 表可能不存在
  }

  logger.info(`Mock cleanup completed: ${totalDeleted} entries deleted`);

  const rt = getRealtimeService();
  if (rt) {
    rt.broadcastEvent('mock-cleanup-completed', { deleted: totalDeleted });
  }

  res.json({
    success: true,
    data: { deleted: totalDeleted },
  });
});

/**
 * POST /api/v1/ai/summarize
 * AI 摘要生成
 */
router.post(
  '/summarize',
  validate(AiSummarizeBody),
  async (req: Request, res: Response): Promise<void> => {
    const { code, language } = req.body;

    const container = requireAiReady();
    const factory = container.get('agentFactory');
    const result = await factory.scanKnowledge({
      label: 'code',
      files: [{ name: 'code', content: code, language }],
      task: 'summarize',
    });

    if (result?.error) {
      throw new ValidationError(result.error);
    }

    res.json({ success: true, data: result });
  }
);

/**
 * POST /api/v1/ai/translate
 * AI 翻译（中文 → 英文）
 */
router.post(
  '/translate',
  validate(AiTranslateBody),
  async (req: Request, res: Response): Promise<void> => {
    const { summary, usageGuide } = req.body;

    if (!summary && !usageGuide) {
      return void res.json({
        success: true,
        data: { summaryEn: '', usageGuideEn: '' },
      });
    }

    try {
      const container = requireAiReady();
      const factory = container.get('agentFactory');
      const result = await factory.translateToEnglish(summary, usageGuide);

      if (result?.error) {
        // AI 不可用，降级返回原文
        logger.warn('AI translate tool returned error', { error: result.error });
        return void res.json({
          success: true,
          data: { summaryEn: summary || '', usageGuideEn: usageGuide || '' },
          warning: result.error,
        });
      }

      res.json({ success: true, data: result });
    } catch (err: unknown) {
      logger.warn('AI translate failed, returning original text', {
        error: (err as Error).message,
      });
      res.json({
        success: true,
        data: { summaryEn: summary || '', usageGuideEn: usageGuide || '' },
        warning: `Translation failed: ${(err as Error).message}`,
      });
    }
  }
);

/**
 * POST /api/v1/ai/chat
 * AI 对话（RAG 模式，结合项目知识库）
 *
 * 增强特性 (Engine Migration):
 *   - 对话持久化 (ConversationStore)
 *   - ContextWindow 上下文窗口管理
 *   - Token 用量持久化
 *   - 项目概况注入 (buildProjectBriefing)
 *   - SSE 流式最终回答 (text:start/delta/end)
 *   - MemoryCoordinator 记忆提取
 */
router.post('/chat', validate(AiChatBody), async (req: Request, res: Response): Promise<void> => {
  const { prompt, history, lang, conversationId } = req.body;

  const container = requireAiReady();
  const factory = container.get('agentFactory');

  // ── 对话持久化: 从 ConversationStore 加载历史 ──
  let convStore: ConversationStore | null = null;
  let effectiveHistory = history;
  let effectiveConvId = conversationId || null;
  try {
    const projectRoot = resolveProjectRoot(container);
    convStore = new ConversationStore(projectRoot);
    if (effectiveConvId) {
      effectiveHistory = convStore.load(effectiveConvId);
      convStore.append(effectiveConvId, { role: 'user', content: prompt });
    } else {
      effectiveConvId = convStore.create({ category: 'user', title: prompt.slice(0, 50) });
      convStore.append(effectiveConvId, { role: 'user', content: prompt });
    }
  } catch {
    /* ConversationStore 不可用时静默降级 */
  }

  // ── 项目概况刷新 ──
  let _projectBriefing = '';
  try {
    _projectBriefing = await buildProjectBriefing({ container });
  } catch {
    /* 静默降级 */
  }

  // ── 创建 ContextWindow ──
  const _contextWindow = factory.createContextWindow({ isSystem: false });

  // ── 创建 Runtime 并注入 onProgress ──
  const message = AgentMessage.fromHttp(req);
  // 加载持久化历史到 message
  if (effectiveHistory.length > 0) {
    message.session.history = effectiveHistory;
  }

  const runtime = factory.createChat({
    lang,
    onProgress: (event: Record<string, unknown>) => {
      // SSE 流式进度 (如果前端通过 SSE 建立了连接)
      try {
        const sessionId = req.body.sseSessionId;
        if (sessionId) {
          const session = getStreamSession(sessionId);
          if (session) {
            session.send(event);
          }
        }
      } catch {
        /* SSE 不可用时静默 */
      }
    },
  });
  const result = await runtime.execute(message);

  // ── 持久化 assistant 回复 ──
  if (convStore && effectiveConvId && result.reply) {
    try {
      convStore.append(effectiveConvId, { role: 'assistant', content: result.reply });
    } catch {
      /* 静默降级 */
    }
  }

  // ── Token 用量持久化 ──
  try {
    const tokenStore = container.get('tokenUsageStore');
    if (tokenStore && result.tokenUsage) {
      const aiProvider = container.singletons?.aiProvider as
        | { name?: string; model?: string }
        | undefined;
      tokenStore.record({
        source: 'user',
        dimension: undefined,
        provider: aiProvider?.name ?? undefined,
        model: aiProvider?.model ?? undefined,
        inputTokens: result.tokenUsage.input || 0,
        outputTokens: result.tokenUsage.output || 0,
        durationMs: result.durationMs || 0,
        toolCalls: result.toolCalls?.length || 0,
        sessionId: effectiveConvId,
      });
      // 通知前端 token 用量变化
      try {
        const realtime = getRealtimeService();
        realtime?.broadcastTokenUsageUpdated?.();
      } catch {
        /* optional */
      }
    }
  } catch {
    /* token logging should never break execution */
  }

  res.json({
    success: true,
    data: {
      reply: result.reply,
      toolCalls: result.toolCalls,
      iterations: result.iterations || null,
      conversationId: effectiveConvId,
      tokenUsage: result.tokenUsage || null,
    },
  });
});

/**
 * POST /api/v1/ai/agent/tool
 * 程序化直接调用 Agent 工具（跳过 ReAct 循环）
 * Body: { tool: string, params: object }
 */
router.post(
  '/agent/tool',
  validate(AiToolBody),
  async (req: Request, res: Response): Promise<void> => {
    const { tool, params } = req.body;

    const container = requireAiReady();
    const factory = container.get('agentFactory');
    const result = await factory.invokeAgent(tool, params);

    res.json({ success: true, data: result });
  }
);

/**
 * POST /api/v1/ai/agent/task
 * 执行预定义任务流（查重提交 / 批量关系发现 / 批量补全）
 * Body: { task: string, params: object }
 *
 * 支持两种任务类型:
 *   1. ToolRegistry 注册的工具 (直接通过 toolName 调用)
 *   2. ChatAgentTasks 的 5 个预定义 DAG 任务
 */
const DAG_TASK_HANDLERS = {
  check_and_submit: taskCheckAndSubmit,
  discover_all_relations: taskDiscoverAllRelations,
  full_enrich: taskFullEnrich,
  quality_audit: taskQualityAudit,
  guard_full_scan: taskGuardFullScan,
};

router.post(
  '/agent/task',
  validate(AiTaskBody),
  async (req: Request, res: Response): Promise<void> => {
    const { task, params } = req.body;

    const container = requireAiReady();
    const factory = container.get('agentFactory');

    // 优先尝试 DAG 任务
    const dagHandler = (
      DAG_TASK_HANDLERS as Record<string, (...args: unknown[]) => Promise<unknown>>
    )[task];
    if (dagHandler) {
      const aiProvider = container.singletons?.aiProvider;
      const taskContext = {
        invokeAgent: (name: string, p: Record<string, unknown>) => factory.invokeAgent(name, p),
        aiProvider,
        container,
        logger,
      };
      const result = await dagHandler(taskContext, params);
      return void res.json({ success: true, data: result });
    }

    // 回退到 Agent 工具执行
    const result = await factory.invokeAgent(task, params);

    res.json({ success: true, data: result });
  }
);

/**
 * GET /api/v1/ai/agent/capabilities
 * 获取 Agent 能力清单（工具列表 + 任务列表）
 */
router.get('/agent/capabilities', async (req: Request, res: Response): Promise<void> => {
  const container = getContainer();
  const toolRegistry = container.get('toolRegistry');
  const tools = toolRegistry.getToolSchemas();
  const presets = Object.entries(PRESETS).map(([name, p]) => ({
    name,
    description: p.description,
    capabilities: p.capabilities,
    strategy: p.strategy?.type || 'single',
  }));
  res.json({
    success: true,
    data: {
      tools,
      presets,
      tasks: [
        { name: 'check_and_submit', description: '提交候选前自动查重 + 质量预评' },
        { name: 'discover_all_relations', description: '批量发现 Recipe 之间的知识图谱关系' },
        { name: 'full_enrich', description: '批量 AI 语义补全候选字段' },
        { name: 'quality_audit', description: '批量质量审计全部 Recipe，标记低分项' },
        { name: 'guard_full_scan', description: '用全部 Guard 规则扫描指定代码，生成完整报告' },
      ],
    },
  });
});

/**
 * POST /api/v1/ai/format-usage-guide
 * 格式化 usageGuide 文本（纯文本处理，不涉及 AI 调用）
 * 注：虽非 AI 功能，但前端从 /ai/ 路径调用，保留以维持 API 兼容
 */
router.post(
  '/format-usage-guide',
  validate(AiFormatUsageGuideBody),
  async (req: Request, res: Response): Promise<void> => {
    const { text } = req.body;

    if (!text) {
      return void res.json({ success: true, data: { formatted: '' } });
    }

    // 简单文本格式化处理
    let formatted = text.trim();
    // 确保段落间有空行
    formatted = formatted.replace(/\n{3,}/g, '\n\n');
    // 确保代码块格式
    formatted = formatted.replace(/```(\w+)?\n/g, '\n```$1\n');

    res.json({ success: true, data: { formatted } });
  }
);

// ═══════════════════════════════════════════════════════
//  .env LLM 配置读写
// ═══════════════════════════════════════════════════════

/** 获取用户项目目录下 .env 的路径 */
function _getProjectEnvPath() {
  const container = getServiceContainer();
  const projectRoot =
    (container.singletons?._projectRoot as string | undefined) ||
    process.env.ASD_PROJECT_DIR ||
    process.cwd();
  return join(projectRoot, '.env');
}

/** LLM 相关的 env 变量名 → 标签映射 */
const LLM_ENV_KEYS = [
  'ASD_AI_PROVIDER',
  'ASD_AI_MODEL',
  'ASD_GOOGLE_API_KEY',
  'ASD_OPENAI_API_KEY',
  'ASD_CLAUDE_API_KEY',
  'ASD_DEEPSEEK_API_KEY',
  'ASD_AI_PROXY',
];

/**
 * 解析 .env 内容为 key-value（仅提取 LLM 相关变量）
 * 返回 { vars, hasEnvFile, llmReady }
 *   llmReady: provider + 至少一个对应 API Key 已配置
 */
function parseLlmEnv(envPath: string) {
  if (!existsSync(envPath)) {
    return { vars: {}, hasEnvFile: false, llmReady: false };
  }

  const raw = readFileSync(envPath, 'utf8');
  const vars: Record<string, string> = {};

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    // 跳过注释和空行
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) {
      continue;
    }
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed
      .slice(eqIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (LLM_ENV_KEYS.includes(key)) {
      vars[key] = val;
    }
  }

  // 判断 LLM 是否可用：有 provider + 对应的 API Key
  const provider = vars.ASD_AI_PROVIDER || '';
  const keyMap = {
    google: 'ASD_GOOGLE_API_KEY',
    openai: 'ASD_OPENAI_API_KEY',
    claude: 'ASD_CLAUDE_API_KEY',
    deepseek: 'ASD_DEEPSEEK_API_KEY',
    ollama: '', // ollama 不需要 key
    mock: '', // mock 不需要 key
  };
  const neededKey = (keyMap as Record<string, string>)[provider] || '';
  const llmReady = !!provider && (!neededKey || !!vars[neededKey]);

  return { vars, hasEnvFile: true, llmReady };
}

/**
 * GET /api/v1/ai/env-config
 * 读取用户项目 .env 中的 LLM 配置
 */
router.get('/env-config', async (req: Request, res: Response): Promise<void> => {
  const envPath = _getProjectEnvPath();
  const result = parseLlmEnv(envPath);
  res.json({ success: true, data: result });
});

/**
 * POST /api/v1/ai/env-config
 * 写入 / 更新用户项目 .env 中的 LLM 配置
 *
 * Body: { provider, model, apiKey, proxy? }
 */
router.post(
  '/env-config',
  validate(AiEnvConfigBody),
  async (req: Request, res: Response): Promise<void> => {
    const { provider, model, apiKey, proxy } = req.body;

    const envPath = _getProjectEnvPath();
    let content = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';

    // 构建 key-value 更新列表
    const updates: Record<string, string> = {
      ASD_AI_PROVIDER: provider,
    };
    if (model) {
      updates.ASD_AI_MODEL = model;
    }
    if (proxy) {
      updates.ASD_AI_PROXY = proxy;
    }

    // 根据 provider 决定写入哪个 API Key 变量
    const providerKeyMap = {
      google: 'ASD_GOOGLE_API_KEY',
      openai: 'ASD_OPENAI_API_KEY',
      claude: 'ASD_CLAUDE_API_KEY',
      deepseek: 'ASD_DEEPSEEK_API_KEY',
    };
    const keyName = (providerKeyMap as Record<string, string>)[provider];
    if (keyName && apiKey) {
      updates[keyName] = apiKey;
    }

    // 逐条合并到 .env 内容
    for (const [k, v] of Object.entries(updates)) {
      // 匹配已有行（包括被注释的行）
      const activeRe = new RegExp(`^${k}\\s*=.*$`, 'm');
      const commentedRe = new RegExp(`^#\\s*${k}\\s*=.*$`, 'm');

      if (activeRe.test(content)) {
        // 替换已有活动行
        content = content.replace(activeRe, `${k}=${v}`);
      } else if (commentedRe.test(content)) {
        // 取消注释并赋值
        content = content.replace(commentedRe, `${k}=${v}`);
      } else {
        // 追加到末尾
        if (!content.endsWith('\n')) {
          content += '\n';
        }
        content += `${k}=${v}\n`;
      }
    }

    writeFileSync(envPath, content);
    logger.info('LLM env config updated', { provider, model });

    // 同步到当前进程环境变量（热生效）
    for (const [k, v] of Object.entries(updates)) {
      process.env[k] = String(v);
    }

    // 尝试热切换 AI Provider（通过 AiProviderManager 统一处理）
    try {
      const newProvider = createProvider({
        provider: provider.toLowerCase(),
        model: model || undefined,
      });
      const container = getServiceContainer();
      container.reloadAiProvider(newProvider as unknown as Record<string, unknown>);
      logger.info('AI provider hot-swapped via AiProviderManager after env update', {
        provider,
        model: newProvider.model,
      });
    } catch (err: unknown) {
      logger.debug('Hot-swap AI provider failed (will take effect on restart)', {
        error: (err as Error).message,
      });
    }

    const result = parseLlmEnv(envPath);
    res.json({ success: true, data: result });
  }
);

// ═══════════════════════════════════════════════════════
//  SSE Streaming — 流式对话（Session + EventSource 架构）
// ═══════════════════════════════════════════════════════

/**
 * POST /api/v1/ai/chat/stream
 * 启动 AI 对话流 — 创建 session，后台执行 AgentRuntime，立即返回 sessionId
 *
 * 客户端拿到 sessionId 后通过 GET /chat/events/:sessionId (EventSource) 消费事件
 *
 * 协议事件（通过 session 缓冲 + EventSource 交付）:
 *   step:start    — 新推理步骤开始 {step, maxSteps, phase}
 *   step:end      — 推理步骤结束 {step}
 *   tool:start    — 工具调用开始 {id, tool, args}
 *   tool:end      — 工具调用结束 {tool, status, resultSize?, duration?, error?}
 *   text:start    — 文本流开始 {id, role}
 *   text:delta    — 文本分块 {id, delta}
 *   text:end      — 文本流结束 {id}
 *   stream:done   — 会话完成 {text, toolCalls, hasContext}
 *   stream:error  — 会话错误 {message}
 *
 * Body: { prompt: string, history?: Array<{role,content}> }
 * Response: { success: true, sessionId: string }
 */
router.post(
  '/chat/stream',
  validate(AiStreamBody),
  async (req: Request, res: Response): Promise<void> => {
    const { prompt, history, lang } = req.body;

    const container = requireAiReady();
    const factory = container.get('agentFactory');
    const session = createStreamSession('chat');

    logger.debug('SSE session created', { sessionId: session.sessionId });

    // 立即返回 sessionId（不等待 Agent 执行）
    res.json({ success: true, sessionId: session.sessionId });

    // AgentMessage 构建
    const message = new AgentMessage({
      content: prompt,
      channel: Channel.HTTP,
      session: { id: session.sessionId, history },
      sender: { id: req.ip || 'http-user', type: 'user' },
      metadata: { lang, stream: true },
    });

    // 创建 Runtime — 挂载 onProgress 回调映射到 SSE 事件
    const runtime = factory.createChat({
      lang,
      onProgress: (event: Record<string, unknown>) => {
        // 将 AgentRuntime 内部事件映射到前端 SSE 协议
        switch (event.type) {
          case 'thinking':
            session.send({
              type: 'step:start',
              step: event.iteration,
              maxSteps: event.maxIterations,
              phase: 'thinking',
            });
            break;
          case 'tool_call':
            session.send({ type: 'tool:start', tool: event.tool, args: event.args });
            break;
          case 'tool_end':
            session.send({
              type: 'tool:end',
              tool: event.tool,
              status: event.status,
              resultSize: event.resultSize,
              duration: event.duration,
              error: event.error,
            });
            break;
          default:
            session.send(event);
        }
      },
    });

    // 后台执行 AgentRuntime
    runtime
      .execute(message)
      .then((result: Record<string, unknown>) => {
        const replyText = (result.reply as string) || '';

        // 发送最终文本
        if (replyText) {
          const textId = `text_${Date.now()}`;
          session.send({ type: 'text:start', id: textId, role: 'assistant' });
          session.send({ type: 'text:delta', id: textId, delta: replyText });
          session.send({ type: 'text:end', id: textId });
        } else {
          logger.warn('SSE session: empty reply from AgentRuntime', {
            sessionId: session.sessionId,
            iterations: result.iterations,
            toolCalls: (result.toolCalls as unknown[] | undefined)?.length || 0,
          });
        }
        session.end({
          text: replyText || '抱歉，AI 未能生成有效回复。请重试或换个问题。',
          toolCalls: result.toolCalls || [],
          iterations: result.iterations || 0,
        });

        // ── Token 用量持久化（streaming） ──
        try {
          const tokenUsage = result.tokenUsage as { input?: number; output?: number } | undefined;
          if (tokenUsage) {
            const tokenStore = container.get('tokenUsageStore');
            const aiProvider = container.singletons?.aiProvider as
              | { name?: string; model?: string }
              | undefined;
            tokenStore.record({
              source: 'user',
              provider: aiProvider?.name ?? undefined,
              model: aiProvider?.model ?? undefined,
              inputTokens: tokenUsage.input || 0,
              outputTokens: tokenUsage.output || 0,
              durationMs: (result.durationMs as number | undefined) || 0,
              toolCalls: (result.toolCalls as unknown[] | undefined)?.length || 0,
            });
            try {
              const realtime = getRealtimeService();
              realtime?.broadcastTokenUsageUpdated?.();
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* token tracking should never break streaming */
        }

        logger.debug('SSE session completed', {
          sessionId: session.sessionId,
          events: session.buffer.length,
        });
      })
      .catch((err: unknown) => {
        logger.warn('SSE session error', {
          sessionId: session.sessionId,
          error: (err as Error).message,
        });
        session.error((err as Error).message, 'RUNTIME_ERROR');
      });
  }
);

/**
 * GET /api/v1/ai/chat/events/:sessionId
 * EventSource SSE 端点 — 消费指定 session 的实时事件
 *
 * 流程:
 *   1. 回放 session 缓冲区中已积累的所有事件
 *   2. 如果 session 已完成 → 直接结束流
 *   3. 否则订阅实时事件，直到 stream:done / stream:error
 *
 * 使用原生 EventSource API 消费（浏览器内置 SSE 支持，无缓冲问题）
 */
router.get('/chat/events/:sessionId', (req, res) => {
  const session = getStreamSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ success: false, error: 'Session not found or expired' });
    return;
  }

  // ─── SSE Headers ───
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  if (res.socket) {
    res.socket.setNoDelay(true);
    res.socket.setTimeout(0);
  }

  /** 写入一个 SSE data 行 */
  function writeEvent(event: Record<string, unknown>) {
    if (res.writableEnded) {
      return;
    }
    const line = `data: ${JSON.stringify(event)}\n\n`;
    res.write(line);
  }

  // 1) 回放缓冲区
  let isDone = false;
  for (const event of session.buffer) {
    writeEvent(event);
    if (event.type === 'stream:done' || event.type === 'stream:error') {
      isDone = true;
    }
  }

  // 2) 如果已完成，直接关闭
  if (isDone || session.completed) {
    res.end();
    return;
  }

  // 3) 订阅实时事件
  const unsubscribe = session.on((event: Record<string, unknown>) => {
    writeEvent(event);
    if (event.type === 'stream:done' || event.type === 'stream:error') {
      unsubscribe();
      clearInterval(heartbeat);
      res.end();
    }
  });

  // 心跳保活 (每 15 秒)
  const heartbeat = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(heartbeat);
      return;
    }
    res.write(`: ping ${Date.now()}\n\n`);
  }, 15_000);

  // 客户端断开连接时清理
  res.on('close', () => {
    unsubscribe();
    clearInterval(heartbeat);
  });
});

/**
 * GET /api/v1/ai/token-usage
 * 近 7 日 Token 消耗报告（按日 + 按来源 + 总计）
 */
router.get('/token-usage', async (req: Request, res: Response): Promise<void> => {
  const container = getServiceContainer();
  let tokenStore: { getLast7DaysReport(): unknown };
  try {
    tokenStore = container.get('tokenUsageStore');
  } catch {
    return void res.json({
      success: true,
      data: {
        daily: [],
        bySource: [],
        summary: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          call_count: 0,
          avg_per_call: 0,
        },
      },
    });
  }
  const report = tokenStore.getLast7DaysReport();
  res.json({ success: true, data: report });
});

export default router;
