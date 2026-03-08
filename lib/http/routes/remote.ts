/**
 * Remote Command Router — 飞书 Bot ↔ IDE 编程桥接 + AI Agent 知识管理
 *
 * 架构（自然语言路由模式 v2）:
 *   飞书消息 → LarkTransport → IntentClassifier 意图分类
 *     → bot_agent: 知识管理任务 → AgentRuntime 直接处理 → 飞书回复
 *     → ide_agent: 编程任务 → remote_commands 队列 → VSCode 扩展 → Copilot Chat
 *     → system: 状态/截图 → 本地直接处理
 *
 * 设计原则:
 *   ✓ 零命令交互 — 全部使用自然语言，AI 自动判断意图
 *   ✓ 双 Agent 分流 — 知识任务服务端处理，编程任务转发 IDE
 *   ✓ 飞书 WS 随路由加载自动启动
 *   ✓ 超时自动清理（pending 120s / running 600s）
 *   ✓ 消息去重 + 非文本提示
 *   ✓ SDK Client 回复 + REST 回退
 */

import crypto from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import express, { type Request, type Response } from 'express';
import Logger from '../../infrastructure/logging/Logger.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import {
  RemoteCommandRepository,
  type StatusCounts,
} from '../../repository/remote/RemoteCommandRepository.js';
import { LarkTransport } from '../../service/agent/LarkTransport.js';
import { resolveProjectRoot } from '../../shared/resolveProjectRoot.js';
import {
  RemoteHistoryQuery,
  RemoteNotifyBody,
  RemoteResultBody,
  RemoteSendBody,
} from '../../shared/schemas/http-requests.js';
import { validate, validateQuery } from '../middleware/validate.js';

/** Lark WS client shape */
interface LarkWsClient {
  close?(): void;
  start(opts: Record<string, unknown>): Promise<void>;
}

/** Lark API client shape */
interface LarkApiClient {
  auth: { tenantAccessToken: { internal(opts: Record<string, unknown>): Promise<unknown> } };
  im: {
    message: {
      reply(opts: Record<string, unknown>): Promise<unknown>;
      create(opts: Record<string, unknown>): Promise<unknown>;
    };
  };
}

/** Lark event data shape */
interface LarkMessageEvent {
  message?: Record<string, string>;
  event?: {
    message?: Record<string, string>;
    sender?: { sender_id?: Record<string, string> };
  };
  sender?: { sender_id?: Record<string, string> };
}

const router = express.Router();
const logger = Logger.getInstance();

// ─── 常量 ───────────────────────────────────────────

const PENDING_TIMEOUT_SEC = 120; // pending 超过 2 分钟 → timeout
const RUNNING_TIMEOUT_SEC = 600; // running 超过 10 分钟 → timeout
const CLEANUP_INTERVAL_MS = 30_000; // 每 30 秒清理一次

// ─── 数据库辅助 ─────────────────────────────────────

function getDb() {
  const container = getServiceContainer();
  const database = container.get('database');
  return typeof database?.getDb === 'function' ? database.getDb() : database;
}

let _repo: RemoteCommandRepository | null = null;

/** 获取或创建 RemoteCommandRepository 单例 */
function getRepo(): RemoteCommandRepository {
  if (!_repo) {
    const db = getDb();
    _repo = new RemoteCommandRepository(db);
  }
  return _repo;
}

function genId() {
  return `rcmd_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

// ─── 飞书配置 ───────────────────────────────────────

function getLarkConfig() {
  return {
    appId: process.env.ASD_LARK_APP_ID || '',
    appSecret: process.env.ASD_LARK_APP_SECRET || '',
    verificationToken: process.env.ASD_LARK_VERIFICATION_TOKEN || '',
    encryptKey: process.env.ASD_LARK_ENCRYPT_KEY || '',
  };
}

// ─── 发送者白名单 ──────────────────────────────────

/** 允许发送指令的飞书 user_id 列表（逗号分隔） */
const _allowedUserIds = (process.env.ASD_LARK_ALLOWED_USERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isUserAllowed(userId: string) {
  // 未配置白名单 → 放行所有（向后兼容）
  if (_allowedUserIds.length === 0) {
    return true;
  }
  return _allowedUserIds.includes(userId);
}

// ─── 消息去重 ───────────────────────────────────────

const _processedMsgIds = new Map();
const MSG_DEDUP_TTL = 5 * 60 * 1000;

function isDuplicate(messageId: string) {
  if (!messageId) {
    return false;
  }
  if (_processedMsgIds.has(messageId)) {
    return true;
  }
  _processedMsgIds.set(messageId, Date.now());
  if (_processedMsgIds.size > 200) {
    const now = Date.now();
    for (const [id, ts] of _processedMsgIds) {
      if (now - ts > MSG_DEDUP_TTL) {
        _processedMsgIds.delete(id);
      }
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════
//  飞书 SDK 长连接
// ═══════════════════════════════════════════════════════

let _wsClient: LarkWsClient | null = null;
let _larkClient: LarkApiClient | null = null;
let _wsConnected = false;
let _wsStarting = false;

/**
 * Lark SDK 日志适配器 — 将 SDK 内部的 console 输出路由到项目统一 Logger
 * 替代 SDK 默认的 console.log 直出，日志格式与项目其他模块保持一致。
 * 前缀: [Remote/Lark/SDK]
 */
const larkSdkLogger = {
  error(...args: unknown[]) {
    logger.error(`[Remote/Lark/SDK] ${args.map(String).join(' ')}`);
  },
  warn(...args: unknown[]) {
    logger.warn(`[Remote/Lark/SDK] ${args.map(String).join(' ')}`);
  },
  info(...args: unknown[]) {
    logger.info(`[Remote/Lark/SDK] ${args.map(String).join(' ')}`);
  },
  debug(...args: unknown[]) {
    logger.debug(`[Remote/Lark/SDK] ${args.map(String).join(' ')}`);
  },
  trace(...args: unknown[]) {
    logger.debug(`[Remote/Lark/SDK] [trace] ${args.map(String).join(' ')}`);
  },
  log(...args: unknown[]) {
    logger.info(`[Remote/Lark/SDK] ${args.map(String).join(' ')}`);
  },
};

async function startLarkWS({ silent = false } = {}) {
  // 如果已连接且对象存在 → 直接返回
  if (_wsClient && _wsConnected) {
    return { success: true, message: 'Already connected' };
  }
  if (_wsStarting) {
    return { success: true, message: 'Connection in progress' };
  }

  // 如果 _wsClient 存在但已断连 → 先清理再重建
  if (_wsClient && !_wsConnected) {
    try {
      if (typeof _wsClient.close === 'function') {
        _wsClient.close();
      }
    } catch {}
    _wsClient = null;
    _larkClient = null;
  }

  const config = getLarkConfig();
  if (!config.appId || !config.appSecret) {
    return { success: false, message: 'Missing ASD_LARK_APP_ID / ASD_LARK_APP_SECRET' };
  }

  _wsStarting = true;
  try {
    const lark = await import('@larksuiteoapi/node-sdk');

    _larkClient = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      disableTokenCache: false,
    }) as unknown as LarkApiClient;

    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          await handleLarkMessage(data as unknown as LarkMessageEvent);
        } catch (err: unknown) {
          logger.error(`[Remote/Lark] Handler error: ${(err as Error).message}`);
        }
      },
    });

    _wsClient = new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: lark.LoggerLevel?.info ?? 2,
      autoReconnect: true,
      logger: larkSdkLogger,
    });

    await _wsClient.start({ eventDispatcher });
    _wsConnected = true;
    _wsStarting = false;

    // 恢复上次活跃的 chat_id（从数据库）
    _restoreActiveChatId();

    logger.info('[Remote/Lark] ✅ WebSocket long connection established');

    // 向飞书发送上线通知（仅首次启动，重连时静默）
    if (!silent) {
      setTimeout(() => {
        sendLarkNotification(
          [
            '🟢 IDE 桥接已上线',
            `时间: ${new Date().toLocaleString('zh-CN')}`,
            `平台: macOS | Node ${process.version}`,
            '',
            '发送任意文字即可远程编程，/help 查看命令。',
          ].join('\n')
        ).catch(() => {});
      }, 1000);
    }

    return { success: true, message: 'Connected via WebSocket' };
  } catch (err: unknown) {
    _wsClient = null;
    _wsConnected = false;
    _wsStarting = false;
    logger.error(`[Remote/Lark] WSClient start failed: ${(err as Error).message}`);
    return { success: false, message: (err as Error).message };
  }
}

function stopLarkWS() {
  if (!_wsClient) {
    return { success: true, message: 'Not running' };
  }
  try {
    if (typeof _wsClient.close === 'function') {
      _wsClient.close();
    }
  } catch {
    /* ignore */
  }
  _wsClient = null;
  _larkClient = null;
  _wsConnected = false;
  logger.info('[Remote/Lark] WebSocket connection stopped');
  return { success: true, message: 'Stopped' };
}

// ─── 自动启动（路由加载时） ─────────────────────────

const { appId: _autoId, appSecret: _autoSecret } = getLarkConfig();
if (_autoId && _autoSecret) {
  // 延迟启动：setImmediate 确保路由注册、DB init 全部完成后，再等 8s 启动飞书连接
  // 不阻塞主服务启动流程
  setImmediate(() =>
    setTimeout(async () => {
      logger.info('[Remote/Lark] Auto-starting WebSocket connection...');
      const result = await startLarkWS();
      if (!result.success) {
        logger.warn(`[Remote/Lark] Auto-start failed: ${result.message}`);
      }
    }, 8000)
  );
}

// ─── 连接健康检查 & 自动重连 ────────────────────────

const HEALTH_CHECK_INTERVAL = 30_000; // 30 秒检查一次

setInterval(async () => {
  // 没有凭证 → 跳过
  const cfg = getLarkConfig();
  if (!cfg.appId || !cfg.appSecret) {
    return;
  }

  // WSClient 对象存在但 SDK 内部可能已断开 → 尝试探活
  if (_wsClient && _wsConnected) {
    // 发一个轻量 API 调用来验证连通性
    try {
      if (_larkClient) {
        await _larkClient.auth.tenantAccessToken.internal({
          data: { app_id: cfg.appId, app_secret: cfg.appSecret },
        });
      }
      // 有响应 → 正常
      return;
    } catch {
      // 调用失败不代表 WS 断了（可能只是 API 暂时不通），保持状态
      return;
    }
  }

  // WSClient 不存在或已标记断开 → 自动重连（静默，不打扰用户）
  if (!_wsClient && !_wsStarting) {
    logger.info('[Remote/Lark] Connection lost, auto-reconnecting...');
    const result = await startLarkWS({ silent: true });
    if (result.success) {
      logger.info('[Remote/Lark] ✅ Auto-reconnected successfully');
    } else {
      logger.warn(`[Remote/Lark] Auto-reconnect failed: ${result.message}`);
    }
  }
}, HEALTH_CHECK_INTERVAL);

// ─── 超时清理定时器 ─────────────────────────────────

setInterval(() => {
  try {
    const repo = getRepo();
    const total = repo.cleanupTimeouts(PENDING_TIMEOUT_SEC, RUNNING_TIMEOUT_SEC);
    if (total > 0) {
      logger.info(`[Remote] Cleaned ${total} timed-out commands`);
    }
  } catch {
    /* DB 尚未就绪时静默 */
  }
}, CLEANUP_INTERVAL_MS);

// ═══════════════════════════════════════════════════════
//  LarkTransport — 自然语言意图路由
// ═══════════════════════════════════════════════════════

/** @type {LarkTransport|null} */
let _larkTransport: LarkTransport | null = null;

/**
 * 获取或创建 LarkTransport 实例
 * 延迟初始化，等待 ServiceContainer 就绪
 */
function getLarkTransport() {
  if (_larkTransport) {
    return _larkTransport;
  }

  try {
    const container = getServiceContainer();
    const agentFactory = container.get('agentFactory');
    const aiProvider = container.get('aiProvider');

    if (!agentFactory) {
      logger.warn('[Remote/Lark] AgentFactory not available, transport not ready');
      return null;
    }

    _larkTransport = new LarkTransport({
      agentFactory,
      aiProvider,
      replyFn: replyLark,
      sendFn: sendLarkNotification,
      sendImageFn: sendLarkScreenshot,
      getStatusFn: getStatusText,
      enqueueIdeFn: enqueueIdeCommand as (
        command: string,
        meta: Record<string, unknown>
      ) => Promise<{ id: string }>,
      isUserAllowed,
      projectRoot: resolveProjectRoot(container),
    });

    logger.info('[Remote/Lark] LarkTransport initialized');
    return _larkTransport;
  } catch (err: unknown) {
    logger.warn(`[Remote/Lark] LarkTransport init failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * 生成系统状态文本 (给 LarkTransport 系统操作使用)
 */
async function getStatusText() {
  const lines = ['📊 状态面板', ''];
  const now = Math.floor(Date.now() / 1000);
  let ideOk = false;

  lines.push(`① 飞书 WebSocket: ${_wsConnected ? '✅ 已连接' : '❌ 断开'}`);
  lines.push(`② API 服务器: ✅ 运行中 (port ${process.env.PORT || 3000})`);
  lines.push(
    `③ 活跃会话: ${_activeChatId ? `✅ ${_activeChatId.slice(0, 16)}...` : '⚠️ 无活跃会话'}`
  );

  try {
    const repo = getRepo();

    const hasWaiters = _waiters.size > 0;
    const pollAge = _lastPollAt > 0 ? now - Math.floor(_lastPollAt / 1000) : -1;

    if (hasWaiters) {
      ideOk = true;
      lines.push('④ IDE 扩展: ✅ 在线 (long-poll 连接中)');
    } else if (pollAge >= 0 && pollAge < 30) {
      ideOk = true;
      lines.push(`④ IDE 扩展: ✅ 活跃 (${pollAge}秒前有心跳)`);
    } else {
      const recentClaim = repo.findRecentClaim();
      if (recentClaim && now - recentClaim.claimedAt < 120) {
        ideOk = true;
        lines.push(`④ IDE 扩展: ✅ 活跃 (${now - recentClaim.claimedAt}秒前有 claim)`);
      } else {
        lines.push('④ IDE 扩展: ⚠️ 未检测到活跃连接');
      }
    }

    const counts = repo.getStatusCounts();
    lines.push(
      `⑤ 队列: ${counts.pending} 待执行 | ${counts.running} 执行中 | ${counts.completed} 已完成 | ${counts.timeout} 超时`
    );
  } catch (err: unknown) {
    lines.push(`④ IDE 扩展: ❓ 查询失败 (${(err as Error).message})`);
    lines.push('⑤ 队列: ❓ 查询失败');
  }

  lines.push(`⑥ 通知通道: ${isLarkNotificationReady() ? '✅ 就绪' : '❌ 未就绪'}`);

  const allGood = _wsConnected && _activeChatId && ideOk && isLarkNotificationReady();
  lines.push('');
  lines.push(allGood ? '🟢 全链路正常，可以远程编程！' : '🟡 部分链路异常，请检查上方标记。');

  return lines.join('\n');
}

/**
 * 写入 IDE 编程指令队列 (供 LarkTransport 的 ide_agent 路由使用)
 *
 * @param {string} command 自然语言编程指令
 * @param {Object} meta - { chatId, messageId, senderId, senderName }
 * @returns {Promise<{id: string}>}
 */
async function enqueueIdeCommand(command: string, meta: Record<string, string> = {}) {
  const repo = getRepo();
  const id = genId();

  if (meta.chatId) {
    _activeChatId = meta.chatId;
    _persistActiveChatId(meta.chatId);
  }

  repo.enqueue({
    id,
    source: 'lark',
    chatId: meta.chatId,
    messageId: meta.messageId,
    userId: meta.senderId,
    userName: meta.senderName,
    command,
  });

  logger.info(`[Remote/Lark] IDE command queued: ${id} — "${command.slice(0, 50)}"`);
  wakeWaiters();

  return { id };
}

function _getProjectRoot() {
  return resolveProjectRoot(getServiceContainer());
}

// ═══════════════════════════════════════════════════════
//  飞书消息处理 — 通过 LarkTransport 路由
// ═══════════════════════════════════════════════════════

async function handleLarkMessage(data: LarkMessageEvent) {
  const message: Record<string, string> = data?.message || data?.event?.message || {};
  const messageId = message.message_id;
  const chatId = message.chat_id;

  if (isDuplicate(messageId)) {
    return;
  }

  // 更新活跃会话
  if (chatId) {
    _activeChatId = chatId;
    _persistActiveChatId(chatId);
  }

  // 通过 LarkTransport 路由 (自然语言意图分类)
  const transport = getLarkTransport();
  if (transport) {
    await transport.receive(data);
  } else {
    // Transport 未就绪 → 降级模式
    logger.warn('[Remote/Lark] Transport not ready, falling back to queue mode');
    const sender: { sender_id?: Record<string, string> } =
      data?.sender || data?.event?.sender || {};
    let text = '';
    try {
      const content = JSON.parse(message.content || '{}');
      text = (content.text || '')
        .trim()
        .replace(/@_user_\d+/g, '')
        .trim();
    } catch {
      text = '';
    }

    if (text) {
      // ── 降级模式下仍需识别系统指令，避免"状态"等命令被盲目转发 IDE ──
      const FALLBACK_SYSTEM_RE =
        /^(状态|status|截图|screenshot|帮助|help|ping|队列|queue|取消|cancel|清[理空])$/i;
      const FALLBACK_SYSTEM_CONTAINS_RE =
        /状态|status|截图|screenshot|screen|截屏|帮助|help|诊断|链路|连接.*状态|服务.*状态/i;

      if (FALLBACK_SYSTEM_RE.test(text) || FALLBACK_SYSTEM_CONTAINS_RE.test(text)) {
        // 系统指令 — 在降级模式下直接回复状态
        logger.info(`[Remote/Lark] Fallback: system command detected — "${text}"`);
        const statusText = await getStatusText();
        await replyLark(messageId, statusText || '📊 系统状态查询中 (Agent 模式未就绪)');
        return;
      }

      const senderId = sender.sender_id?.user_id || sender.sender_id?.open_id || '';
      const senderName = sender.sender_id?.user_id || 'lark_user';
      await enqueueIdeCommand(text, { chatId, messageId, senderId, senderName });
      await replyLark(messageId, '📝 收到，已加入执行队列。(Agent 模式未就绪)');
    }
  }
}

// ═══════════════════════════════════════════════════════
//  飞书连接管理端点
// ═══════════════════════════════════════════════════════

router.post('/lark/start', async (_req: Request, res: Response): Promise<void> => {
  res.json(await startLarkWS());
});

router.post('/lark/stop', async (_req: Request, res: Response): Promise<void> => {
  res.json(stopLarkWS());
});

router.get('/lark/status', async (_req: Request, res: Response): Promise<void> => {
  const config = getLarkConfig();
  let queueInfo: StatusCounts | Record<string, number> = {};
  try {
    const repo = getRepo();
    queueInfo = repo.getStatusCounts();
  } catch {
    /* DB 未就绪 */
  }

  res.json({
    success: true,
    data: {
      connected: _wsConnected,
      hasCredentials: !!(config.appId && config.appSecret),
      appId: config.appId ? `${config.appId.slice(0, 8)}...` : '',
      activeChatId: _activeChatId ? `${_activeChatId.slice(0, 12)}...` : '',
      notificationReady: isLarkNotificationReady(),
      queue: queueInfo,
      projectRoot: _getProjectRoot(),
    },
  });
});

// ═══════════════════════════════════════════════════════
//  飞书 Webhook 回调（备用）
// ═══════════════════════════════════════════════════════

router.post('/lark/event', async (req: Request, res: Response): Promise<void> => {
  const body = req.body;
  if (body.type === 'url_verification') {
    return void res.json({ challenge: body.challenge });
  }
  const header = body.header || {};
  const event = body.event || {};
  const larkConfig = getLarkConfig();
  if (larkConfig.verificationToken && header.token !== larkConfig.verificationToken) {
    return void res.status(403).json({ success: false, message: 'Invalid token' });
  }
  if (header.event_type === 'im.message.receive_v1') {
    await handleLarkMessage(event);
  }
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════
//  VSCode 扩展 API
// ═══════════════════════════════════════════════════════

router.get('/pending', async (_req: Request, res: Response): Promise<void> => {
  _lastPollAt = Date.now();
  const repo = getRepo();
  const row = repo.findFirstPending();
  res.json({
    success: true,
    data: row
      ? {
          id: row.id,
          command: row.command,
          source: row.source,
          userName: row.userName,
          messageId: row.messageId,
          createdAt: row.createdAt,
        }
      : null,
  });
});

router.post('/claim/:id', async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const repo = getRepo();
  const claimed = repo.claim(id);
  if (!claimed) {
    return void res.json({ success: false, message: 'Not found or already claimed' });
  }
  // 通知飞书用户：IDE 已开始执行
  const row = repo.findById(id);
  if (row?.messageId) {
    replyLark(row.messageId, `🚀 IDE 已开始执行...\n\n> ${(row.command || '').slice(0, 60)}`).catch(
      () => {}
    );
  }
  res.json({ success: true });
});

router.post(
  '/result/:id',
  validate(RemoteResultBody),
  async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id as string;
    const { result, status } = req.body;
    const repo = getRepo();
    const row = repo.findById(id);
    if (!row) {
      return void res.json({ success: false, message: 'Not found' });
    }

    repo.complete(id, result || '', status);

    // 回复飞书
    if (row.messageId && result) {
      const truncated = result.length > 2000 ? `${result.slice(0, 2000)}\n\n... (截断)` : result;
      if (status === 'completed') {
        await replyLark(row.messageId, truncated);
      } else {
        const emoji = status === 'failed' ? '❌' : '⚠️';
        const label = status === 'failed' ? '执行失败' : status;
        await replyLark(row.messageId, `${emoji} ${label}\n\n${truncated}`);
      }
    }
    res.json({ success: true });
  }
);

router.get(
  '/history',
  validateQuery(RemoteHistoryQuery),
  async (req: Request, res: Response): Promise<void> => {
    const repo = getRepo();
    const limit = (req.query as unknown as { limit: number }).limit;
    const rows = repo.getHistory(limit);
    res.json({ success: true, data: rows });
  }
);

// ═══════════════════════════════════════════════════════
//  Long-Poll — 新消息到达时立即唤醒扩展端
// ═══════════════════════════════════════════════════════

/** 等待新消息的 resolve 回调队列 */
const _waiters = new Set();

/** IDE 扩展最后一次轮询/连接时间戳（用于 /check 诊断） */
let _lastPollAt = 0;

/**
 * 唤醒所有等待中的 long-poll 客户端
 * 在 handleLarkMessage 写入新指令后调用
 */
function wakeWaiters() {
  for (const resolve of _waiters) {
    (resolve as (value: { hasNew: boolean }) => void)({ hasNew: true });
  }
  _waiters.clear();
}

router.get('/wait', (req, res) => {
  _lastPollAt = Date.now();
  const timeout = Math.min(parseInt(req.query.timeout as string) || 25000, 60000);
  let resolved = false;

  const resolve = (data: Record<string, unknown>) => {
    if (resolved) {
      return;
    }
    resolved = true;
    _waiters.delete(resolve);
    clearTimeout(timer);
    res.json(data);
  };

  const timer = setTimeout(() => resolve({ hasNew: false }), timeout);
  _waiters.add(resolve);

  // 客户端断开时清理
  req.on('close', () => {
    if (!resolved) {
      resolved = true;
      _waiters.delete(resolve);
      clearTimeout(timer);
    }
  });
});

// POST /flush — IDE 重连时清理所有积压的 pending 指令
router.post('/flush', async (req: Request, res: Response): Promise<void> => {
  const repo = getRepo();
  const pending = repo.flushPending();

  if (pending.length === 0) {
    return void res.json({ success: true, flushed: 0, commands: [] });
  }

  const now = Math.floor(Date.now() / 1000);
  const summaries = pending.map((r) => ({
    id: r.id,
    command: r.command?.slice(0, 60) || '',
    age: now - r.createdAt,
  }));

  logger.info(`[Remote] Flushed ${pending.length} stale pending commands on IDE reconnect`);

  // 飞书通知
  const lines = summaries.map(
    (s: { command: string; age: number }, i: number) =>
      `  ${i + 1}. ${s.command}${s.command.length >= 60 ? '…' : ''} (${s.age}s ago)`
  );
  sendLarkNotification(
    `🗑 IDE 重连，已清理 ${pending.length} 条积压指令：\n${lines.join('\n')}`
  ).catch(() => {});

  res.json({ success: true, flushed: pending.length, commands: summaries });
});

router.post(
  '/send',
  validate(RemoteSendBody),
  async (req: Request, res: Response): Promise<void> => {
    const { command } = req.body;
    const repo = getRepo();
    const id = genId();
    repo.enqueue({
      id,
      source: 'manual',
      userName: 'developer',
      command,
    });
    res.json({ success: true, data: { id, command } });
  }
);

// POST /api/v1/remote/notify — 通用通知（扩展/外部模块主动推送飞书）
router.post(
  '/notify',
  validate(RemoteNotifyBody),
  async (req: Request, res: Response): Promise<void> => {
    const { text } = req.body;
    const sent = await sendLarkNotification(text);
    res.json({ success: sent, message: sent ? 'Sent' : 'Lark not connected or no active chat' });
  }
);

// POST /api/v1/remote/screenshot — 截取 IDE 窗口并发送到飞书
router.post('/screenshot', async (req: Request, res: Response): Promise<void> => {
  const { caption } = req.body || {};
  const result = await sendLarkScreenshot(caption || '');
  res.json(result);
});

// ═══════════════════════════════════════════════════════
//  飞书回复辅助
// ═══════════════════════════════════════════════════════

let _tenantToken = '';
let _tenantTokenExpiry = 0;

async function getTenantToken() {
  if (_tenantToken && Date.now() < _tenantTokenExpiry) {
    return _tenantToken;
  }
  const config = getLarkConfig();
  if (!config.appId || !config.appSecret) {
    return '';
  }
  try {
    const resp = await fetch(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
      }
    );
    const data = (await resp.json()) as Record<string, unknown> & {
      code: number;
      tenant_access_token?: string;
      expire?: number;
    };
    if (data.code === 0 && data.tenant_access_token) {
      _tenantToken = data.tenant_access_token;
      _tenantTokenExpiry = Date.now() + ((data.expire ?? 7200) - 300) * 1000;
      return _tenantToken;
    }
    return '';
  } catch {
    return '';
  }
}

async function replyLark(messageId: string, text: string): Promise<void> {
  if (!messageId) {
    return;
  }

  // SDK Client 优先
  if (_larkClient) {
    try {
      await _larkClient.im.message.reply({
        path: { message_id: messageId },
        data: { content: JSON.stringify({ text }), msg_type: 'text' },
      });
      return;
    } catch (err: unknown) {
      logger.warn(`[Remote/Lark] SDK reply failed: ${(err as Error).message}`);
    }
  }

  // REST 回退
  const token = await getTenantToken();
  if (!token) {
    return;
  }
  try {
    await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: JSON.stringify({ text }), msg_type: 'text' }),
    });
  } catch {
    /* silent */
  }
}

// ═══════════════════════════════════════════════════════
//  IDE 窗口截图 + 飞书发送（ScreenCaptureKit，息屏可用）
// ═══════════════════════════════════════════════════════

/**
 * 截取 IDE 窗口截图（通过 ScreenCaptureKit 原生 API，息屏时可用）
 * @param {object} [opts]
 * @param {string} [opts.windowTitle] 窗口标题关键词（默认 "Code"）
 * @returns {Promise<{path: string|null, error: string|null}>}
 */
async function captureIDEScreenshot(opts: { windowTitle?: string } = {}) {
  try {
    const { screenshot } = await import('../../platform/ScreenCaptureService.js');

    // 统一使用窗口截取（desktopIndependentWindow，亮屏/息屏均可用）
    // 优先截取 IDE 窗口
    const windowTitle = opts.windowTitle || 'Code';
    let result = await screenshot({ windowTitle, format: 'png' });

    // IDE 窗口未找到 → 尝试常见 IDE 名称
    if (!result.success) {
      for (const alt of ['Visual Studio', 'Cursor', 'Xcode', 'IntelliJ', 'WebStorm']) {
        if (alt.toLowerCase() === windowTitle.toLowerCase()) {
          continue;
        }
        result = await screenshot({ windowTitle: alt, format: 'png' });
        if (result.success) {
          break;
        }
      }
    }

    // 仍未找到 → 不指定窗口名，Swift 工具会自动选最大窗口
    if (!result.success) {
      logger.info(`[Remote/Screenshot] IDE window not found, capturing largest available window`);
      result = await screenshot({ format: 'png' });
    }

    if (result.success) {
      logger.info(
        `[Remote/Screenshot] Captured: ${result.path} (${result.width}x${result.height})`
      );
      return { path: result.path, error: null };
    }

    return { path: null, error: result.error || 'Screenshot failed' };
  } catch (err: unknown) {
    logger.warn(`[Remote/Screenshot] ScreenCaptureKit error: ${(err as Error).message}`);
    return { path: null, error: (err as Error).message };
  }
}

/**
 * 上传图片到飞书 Image API
 * @param {string} filePath 本地图片路径
 * @returns {Promise<{imageKey: string|null, error: string|null}>}
 */
async function _uploadImageToLark(filePath: string) {
  const token = await getTenantToken();
  if (!token) {
    return { imageKey: null, error: '获取 tenant_access_token 失败' };
  }
  try {
    const fileData = readFileSync(filePath);
    const blob = new Blob([fileData], { type: 'image/jpeg' });
    const form = new FormData();
    form.append('image_type', 'message');
    form.append('image', blob, 'screenshot.jpg');

    const resp = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const data = (await resp.json()) as Record<string, unknown> & {
      code: number;
      data?: { image_key?: string };
      msg?: string;
    };
    if (data.code === 0 && data.data?.image_key) {
      return { imageKey: data.data.image_key, error: null };
    }
    const errMsg = `飞书图片上传失败 (code=${data.code}): ${data.msg || '未知错误'}`;
    logger.warn(`[Remote/Screenshot] Upload failed: code=${data.code} msg=${data.msg}`);
    return { imageKey: null, error: errMsg };
  } catch (err: unknown) {
    logger.warn(`[Remote/Screenshot] Upload error: ${(err as Error).message}`);
    return { imageKey: null, error: `上传异常: ${(err as Error).message}` };
  }
}

/**
 * 向飞书发送图片消息
 * @param {string} imageKey
 * @returns {Promise<boolean>}
 */
async function _sendLarkImageMsg(imageKey: string) {
  if (!_activeChatId || !_wsConnected) {
    return false;
  }

  // SDK Client 优先
  if (_larkClient) {
    try {
      await _larkClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: _activeChatId,
          content: JSON.stringify({ image_key: imageKey }),
          msg_type: 'image',
        },
      });
      return true;
    } catch (err: unknown) {
      logger.warn(`[Remote/Screenshot] SDK image send failed: ${(err as Error).message}`);
    }
  }

  // REST 回退
  const token = await getTenantToken();
  if (!token) {
    return false;
  }
  try {
    const resp = await fetch(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          receive_id: _activeChatId,
          content: JSON.stringify({ image_key: imageKey }),
          msg_type: 'image',
        }),
      }
    );
    const data = (await resp.json()) as Record<string, unknown> & { code: number };
    return data.code === 0;
  } catch {
    return false;
  }
}

/**
 * 截取 IDE 窗口 → 上传飞书 → 发送图片消息（完整流水线）
 * @param {string} [caption] 可选文字说明（会先发一条文本）
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function sendLarkScreenshot(caption = '') {
  if (!_activeChatId || !_wsConnected) {
    return { success: false, message: 'Lark not connected or no active chat' };
  }

  // 1. 截图（ScreenCaptureKit，息屏可用）
  const capture = await captureIDEScreenshot();
  if (!capture.path) {
    return { success: false, message: capture.error || 'Screenshot capture failed' };
  }

  const filePath = capture.path;
  try {
    // 2. 可选：先发文字说明
    if (caption.trim()) {
      await sendLarkNotification(caption.trim());
    }

    // 3. 上传
    const upload = await _uploadImageToLark(filePath);
    if (!upload.imageKey) {
      return { success: false, message: upload.error || 'Image upload to Lark failed' };
    }

    // 4. 发送图片消息
    const sent = await _sendLarkImageMsg(upload.imageKey);
    return {
      success: sent,
      message: sent ? 'Screenshot sent' : 'Failed to send image message',
    };
  } finally {
    // 清理临时文件
    try {
      unlinkSync(filePath);
    } catch {
      /* ignore */
    }
  }
}

// ═══════════════════════════════════════════════════════
//  主动通知能力（供 task.js 等外部模块调用）
// ═══════════════════════════════════════════════════════

/** 最近活跃的飞书 chat_id（收到消息时更新） */
let _activeChatId = '';

/** 持久化 active chat_id 到数据库 */
function _persistActiveChatId(chatId: string) {
  try {
    const repo = getRepo();
    repo.setState('active_chat_id', chatId);
  } catch {
    /* DB 未就绪 */
  }
}

/** 从数据库恢复 active chat_id */
function _restoreActiveChatId() {
  try {
    const repo = getRepo();

    // 优先从 remote_state 恢复
    const value = repo.getState('active_chat_id');
    if (value) {
      _activeChatId = value;
      logger.info(
        `[Remote/Lark] Restored active chat from state: ${_activeChatId.slice(0, 12)}...`
      );
      return;
    }

    // 回退：从 remote_commands 取最近有 chat_id 的记录
    const chatId = repo.findRecentChatId();
    if (chatId) {
      _activeChatId = chatId;
      repo.setState('active_chat_id', chatId);
      logger.info(
        `[Remote/Lark] Restored active chat from history: ${_activeChatId.slice(0, 12)}...`
      );
    }
  } catch {
    /* DB 未就绪 */
  }
}

/**
 * 向飞书活跃会话发送主动通知（非回复）
 * 用于任务进度、Guard 结果等非指令触发的通知
 *
 * @param {string} text 纯文本通知内容
 * @returns {Promise<boolean>} 发送是否成功
 */
export async function sendLarkNotification(text: string) {
  if (!_activeChatId || !_wsConnected) {
    return false;
  }

  // SDK Client 优先
  if (_larkClient) {
    try {
      await _larkClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: _activeChatId,
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
      return true;
    } catch (err: unknown) {
      logger.warn(`[Remote/Lark] SDK send failed: ${(err as Error).message}`);
    }
  }

  // REST 回退
  const token = await getTenantToken();
  if (!token) {
    return false;
  }
  try {
    const resp = await fetch(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          receive_id: _activeChatId,
          content: JSON.stringify({ text }),
          msg_type: 'text',
        }),
      }
    );
    const data = (await resp.json()) as Record<string, unknown> & { code: number };
    return data.code === 0;
  } catch {
    return false;
  }
}

/**
 * 查询飞书通知是否可用
 */
export function isLarkNotificationReady() {
  return !!(_activeChatId && _wsConnected);
}

export default router;
