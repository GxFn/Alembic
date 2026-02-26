/**
 * AI API 路由
 * AI 提供商管理、摘要、翻译、对话、.env LLM 配置
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { createProvider } from '../../external/ai/AiFactory.js';
import Logger from '../../infrastructure/logging/Logger.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { ValidationError } from '../../shared/errors/index.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { createStreamSession, getStreamSession } from '../utils/sse-sessions.js';

const router = express.Router();
const logger = Logger.getInstance();

/** 获取 ChatAgent 实例（统一 AI 入口） */
function getChatAgent() {
  const container = getServiceContainer();
  return container.get('chatAgent');
}

// ═══════════════════════════════════════════════════════
//  UI 语言偏好 — 前端 ↔ 服务端同步
// ═══════════════════════════════════════════════════════

/**
 * GET /api/v1/ai/lang
 * 获取当前默认 UI 语言（由系统环境变量初始化，前端可覆盖）
 */
router.get(
  '/lang',
  asyncHandler(async (req, res) => {
    const chatAgent = getChatAgent();
    res.json({ success: true, data: { lang: chatAgent.getLang() || 'zh' } });
  })
);

/**
 * POST /api/v1/ai/lang
 * 更新默认 UI 语言（前端切语言时同步到服务端）
 */
router.post(
  '/lang',
  asyncHandler(async (req, res) => {
    const { lang } = req.body;
    if (lang !== 'zh' && lang !== 'en') {
      throw new ValidationError('lang must be "zh" or "en"');
    }
    const chatAgent = getChatAgent();
    chatAgent.setLang(lang);
    logger.info(`UI language preference updated to "${lang}"`);
    res.json({ success: true, data: { lang } });
  })
);

/**
 * GET /api/v1/ai/providers
 * 获取可用的 AI 提供商列表
 */
router.get(
  '/providers',
  asyncHandler(async (req, res) => {
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
      hasKey: KEY_ENVS[p.id]
        ? !!process.env[KEY_ENVS[p.id]]
        : true, // ollama / mock 不需要 key，始终可用
    }));

    res.json({ success: true, data: providers });
  })
);

/**
 * GET /api/v1/ai/config
 * 获取当前 AI 配置
 */
router.get(
  '/config',
  asyncHandler(async (req, res) => {
    const container = getServiceContainer();
    const p = container.singletons?.aiProvider;
    res.json({
      success: true,
      data: {
        provider: p?.name || '',
        model: p?.model || '',
      },
    });
  })
);

/**
 * POST /api/v1/ai/config
 * 更新 AI 配置（切换提供商/模型）
 */
router.post(
  '/config',
  asyncHandler(async (req, res) => {
    const { provider, model } = req.body;

    if (!provider || typeof provider !== 'string') {
      throw new ValidationError('provider is required');
    }

    // 创建新的 provider 实例验证配置有效
    let newProvider;
    try {
      newProvider = createProvider({
        provider: provider.toLowerCase(),
        model: model || undefined,
      });
    } catch (error) {
      throw new ValidationError(`Invalid provider: ${error.message}`);
    }

    // 同步到 DI 容器，使 SearchEngine / Agent / IndexingPipeline 等也使用新 provider
    try {
      const container = getServiceContainer();
      container.reloadAiProvider(newProvider);
      logger.info('AI provider synced to DI container', {
        provider: provider.toLowerCase(),
        model: newProvider.model,
      });
    } catch (err) {
      logger.debug('DI container 同步 AI provider 失败', { error: err.message });
    }

    res.json({
      success: true,
      data: {
        provider: provider.toLowerCase(),
        model: newProvider.model,
        name: newProvider.name,
      },
    });
  })
);

/**
 * POST /api/v1/ai/summarize
 * AI 摘要生成
 */
router.post(
  '/summarize',
  asyncHandler(async (req, res) => {
    const { code, language } = req.body;

    if (!code) {
      throw new ValidationError('code is required');
    }

    const chatAgent = getChatAgent();
    const result = await chatAgent.executeTool('summarize_code', { code, language });

    if (result?.error) {
      throw new ValidationError(result.error);
    }

    res.json({ success: true, data: result });
  })
);

/**
 * POST /api/v1/ai/translate
 * AI 翻译（中文 → 英文）
 */
router.post(
  '/translate',
  asyncHandler(async (req, res) => {
    const { summary, usageGuide } = req.body;

    if (!summary && !usageGuide) {
      return res.json({
        success: true,
        data: { summaryEn: '', usageGuideEn: '' },
      });
    }

    try {
      const chatAgent = getChatAgent();
      const result = await chatAgent.executeTool('ai_translate', { summary, usageGuide });

      if (result?.error) {
        // AI 不可用，降级返回原文
        logger.warn('AI translate tool returned error', { error: result.error });
        return res.json({
          success: true,
          data: { summaryEn: summary || '', usageGuideEn: usageGuide || '' },
          warning: result.error,
        });
      }

      res.json({ success: true, data: result });
    } catch (err) {
      logger.warn('AI translate failed, returning original text', { error: err.message });
      res.json({
        success: true,
        data: { summaryEn: summary || '', usageGuideEn: usageGuide || '' },
        warning: `Translation failed: ${err.message}`,
      });
    }
  })
);

/**
 * POST /api/v1/ai/chat
 * AI 对话（RAG 模式，结合项目知识库）
 */
router.post(
  '/chat',
  asyncHandler(async (req, res) => {
    const { prompt, history = [], lang } = req.body;

    if (!prompt) {
      throw new ValidationError('prompt is required');
    }

    const chatAgent = getChatAgent();
    const result = await chatAgent.execute(prompt, { history, lang });

    res.json({
      success: true,
      data: {
        reply: result.reply,
        hasContext: result.hasContext,
        toolCalls: result.toolCalls,
        reasoningQuality: result.reasoningQuality || null,
      },
    });
  })
);

/**
 * POST /api/v1/ai/agent/tool
 * 程序化直接调用 Agent 工具（跳过 ReAct 循环）
 * Body: { tool: string, params: object }
 */
router.post(
  '/agent/tool',
  asyncHandler(async (req, res) => {
    const { tool, params = {} } = req.body;

    if (!tool) {
      throw new ValidationError('tool name is required');
    }

    const chatAgent = getChatAgent();
    const result = await chatAgent.executeTool(tool, params);

    res.json({ success: true, data: result });
  })
);

/**
 * POST /api/v1/ai/agent/task
 * 执行预定义任务流（查重提交 / 批量关系发现 / 批量补全）
 * Body: { task: string, params: object }
 */
router.post(
  '/agent/task',
  asyncHandler(async (req, res) => {
    const { task, params = {} } = req.body;

    if (!task) {
      throw new ValidationError('task name is required');
    }

    const chatAgent = getChatAgent();
    const result = await chatAgent.runTask(task, params);

    res.json({ success: true, data: result });
  })
);

/**
 * GET /api/v1/ai/agent/capabilities
 * 获取 Agent 能力清单（工具列表 + 任务列表）
 */
router.get(
  '/agent/capabilities',
  asyncHandler(async (req, res) => {
    const chatAgent = getChatAgent();
    res.json({ success: true, data: chatAgent.getCapabilities() });
  })
);

/**
 * POST /api/v1/ai/format-usage-guide
 * 格式化 usageGuide 文本（纯文本处理，不涉及 AI 调用）
 * 注：虽非 AI 功能，但前端从 /ai/ 路径调用，保留以维持 API 兼容
 */
router.post(
  '/format-usage-guide',
  asyncHandler(async (req, res) => {
    const { text } = req.body;

    if (!text) {
      return res.json({ success: true, data: { formatted: '' } });
    }

    // 简单文本格式化处理
    let formatted = text.trim();
    // 确保段落间有空行
    formatted = formatted.replace(/\n{3,}/g, '\n\n');
    // 确保代码块格式
    formatted = formatted.replace(/```(\w+)?\n/g, '\n```$1\n');

    res.json({ success: true, data: { formatted } });
  })
);

// ═══════════════════════════════════════════════════════
//  .env LLM 配置读写
// ═══════════════════════════════════════════════════════

/** 获取用户项目目录下 .env 的路径 */
function _getProjectEnvPath() {
  const container = getServiceContainer();
  const projectRoot =
    container.singletons?._projectRoot || process.env.ASD_PROJECT_DIR || process.cwd();
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
function parseLlmEnv(envPath) {
  if (!existsSync(envPath)) {
    return { vars: {}, hasEnvFile: false, llmReady: false };
  }

  const raw = readFileSync(envPath, 'utf8');
  const vars = {};

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
  const neededKey = keyMap[provider] || '';
  const llmReady = !!provider && (!neededKey || !!vars[neededKey]);

  return { vars, hasEnvFile: true, llmReady };
}

/**
 * GET /api/v1/ai/env-config
 * 读取用户项目 .env 中的 LLM 配置
 */
router.get(
  '/env-config',
  asyncHandler(async (req, res) => {
    const envPath = _getProjectEnvPath();
    const result = parseLlmEnv(envPath);
    res.json({ success: true, data: result });
  })
);

/**
 * POST /api/v1/ai/env-config
 * 写入 / 更新用户项目 .env 中的 LLM 配置
 *
 * Body: { provider, model, apiKey, proxy? }
 */
router.post(
  '/env-config',
  asyncHandler(async (req, res) => {
    const { provider, model, apiKey, proxy } = req.body;
    if (!provider || typeof provider !== 'string') {
      throw new ValidationError('provider is required');
    }

    const envPath = _getProjectEnvPath();
    let content = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';

    // 构建 key-value 更新列表
    const updates = {
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
    const keyName = providerKeyMap[provider];
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
      process.env[k] = v;
    }

    // 尝试热切换 AI Provider（包括依赖 AI 的所有服务）
    try {
      const newProvider = createProvider({
        provider: provider.toLowerCase(),
        model: model || undefined,
      });
      const container = getServiceContainer();
      container.reloadAiProvider(newProvider);
      logger.info('AI provider hot-swapped after env update', {
        provider,
        model: newProvider.model,
      });
    } catch (err) {
      logger.debug('Hot-swap AI provider failed (will take effect on restart)', {
        error: err.message,
      });
    }

    const result = parseLlmEnv(envPath);
    res.json({ success: true, data: result });
  })
);

// ═══════════════════════════════════════════════════════
//  SSE Streaming — 流式对话（Session + EventSource 架构）
// ═══════════════════════════════════════════════════════

/**
 * POST /api/v1/ai/chat/stream
 * 启动 AI 对话流 — 创建 session，后台执行 ChatAgent，立即返回 sessionId
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
  asyncHandler(async (req, res) => {
    const { prompt, history = [], lang } = req.body;
    if (!prompt) {
      throw new ValidationError('prompt is required');
    }

    const chatAgent = getChatAgent();
    const session = createStreamSession('chat');

    logger.debug('SSE session created', { sessionId: session.sessionId });

    // 立即返回 sessionId（不等待 ChatAgent 执行）
    res.json({ success: true, sessionId: session.sessionId });

    // 后台执行 ChatAgent — 事件通过 session.send() 缓冲
    chatAgent
      .execute(prompt, {
        history,
        lang,
        onProgress: (event) => session.send(event),
      })
      .then((result) => {
        // text:start/delta/end 已由 ChatAgent.execute() 内部通过 onProgress 发送
        session.end({
          text: result.reply,
          toolCalls: result.toolCalls || [],
          hasContext: result.hasContext || false,
        });
        logger.debug('SSE session completed', {
          sessionId: session.sessionId,
          events: session.buffer.length,
        });
      })
      .catch((err) => {
        logger.warn('SSE session error', { sessionId: session.sessionId, error: err.message });
        session.error(err.message);
      });
  })
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
    return res.status(404).json({ success: false, error: 'Session not found or expired' });
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
  function writeEvent(event) {
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
  const unsubscribe = session.on((event) => {
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
router.get(
  '/token-usage',
  asyncHandler(async (req, res) => {
    const container = getServiceContainer();
    let tokenStore;
    try {
      tokenStore = container.get('tokenUsageStore');
    } catch {
      return res.json({
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
  })
);

export default router;
