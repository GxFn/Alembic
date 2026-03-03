/**
 * Remote Command Router — 飞书 Bot → IDE 编程桥接
 *
 * 架构（长连接模式）:
 *   Mac 本地启动 WSClient 长连接 → 飞书推送消息到本机
 *   → 解析系统命令 / 写入 remote_commands 队列
 *   → VSCode 扩展轮询 GET /pending → 注入 Copilot Chat
 *   → 扩展回写 POST /result → 飞书 Bot 回复用户
 *
 * 健壮性:
 *   ✓ 飞书 WS 随路由加载自动启动
 *   ✓ 系统命令: /help /status /queue /cancel /clear /ping /screen
 *   ✓ 超时自动清理（pending 120s / running 600s）
 *   ✓ 消息去重 + 非文本提示
 *   ✓ SDK Client 回复 + REST 回退
 */

import crypto from 'node:crypto';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import express from 'express';
import Logger from '../../infrastructure/logging/Logger.js';
import { getServiceContainer } from '../../injection/ServiceContainer.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();
const logger = Logger.getInstance();

// ─── 常量 ───────────────────────────────────────────

const PENDING_TIMEOUT_SEC = 120;   // pending 超过 2 分钟 → timeout
const RUNNING_TIMEOUT_SEC = 600;   // running 超过 10 分钟 → timeout
const CLEANUP_INTERVAL_MS = 30_000; // 每 30 秒清理一次

// ─── 数据库辅助 ─────────────────────────────────────

function getDb() {
  const container = getServiceContainer();
  const database = container.get('database');
  return typeof database?.getDb === 'function' ? database.getDb() : database;
}

let _tableReady = false;
function ensureTable(db) {
  if (_tableReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_commands (
      id              TEXT PRIMARY KEY,
      source          TEXT NOT NULL DEFAULT 'lark',
      chat_id         TEXT,
      message_id      TEXT,
      user_id         TEXT,
      user_name       TEXT,
      command         TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'pending',
      result          TEXT,
      created_at      INTEGER NOT NULL,
      claimed_at      INTEGER,
      completed_at    INTEGER
    )
  `);
  _tableReady = true;
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
  .map(s => s.trim())
  .filter(Boolean);

function isUserAllowed(userId) {
  // 未配置白名单 → 放行所有（向后兼容）
  if (_allowedUserIds.length === 0) return true;
  return _allowedUserIds.includes(userId);
}

// ─── 消息去重 ───────────────────────────────────────

const _processedMsgIds = new Map();
const MSG_DEDUP_TTL = 5 * 60 * 1000;

function isDuplicate(messageId) {
  if (!messageId) return false;
  if (_processedMsgIds.has(messageId)) return true;
  _processedMsgIds.set(messageId, Date.now());
  if (_processedMsgIds.size > 200) {
    const now = Date.now();
    for (const [id, ts] of _processedMsgIds) {
      if (now - ts > MSG_DEDUP_TTL) _processedMsgIds.delete(id);
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════
//  飞书 SDK 长连接
// ═══════════════════════════════════════════════════════

let _wsClient = null;
let _larkClient = null;
let _wsConnected = false;
let _wsStarting = false;

async function startLarkWS({ silent = false } = {}) {
  // 如果已连接且对象存在 → 直接返回
  if (_wsClient && _wsConnected) return { success: true, message: 'Already connected' };
  if (_wsStarting) return { success: true, message: 'Connection in progress' };

  // 如果 _wsClient 存在但已断连 → 先清理再重建
  if (_wsClient && !_wsConnected) {
    try { if (typeof _wsClient.close === 'function') _wsClient.close(); } catch {}
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
    });

    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          await handleLarkMessage(data);
        } catch (err) {
          logger.error(`[Remote/Lark] Handler error: ${err.message}`);
        }
      },
    });

    _wsClient = new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: lark.LoggerLevel?.info ?? 2,
      autoReconnect: true,
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
        sendLarkNotification([
          '🟢 IDE 桥接已上线',
          `时间: ${new Date().toLocaleString('zh-CN')}`,
          `平台: macOS | Node ${process.version}`,
          '',
          '发送任意文字即可远程编程，/help 查看命令。',
        ].join('\n')).catch(() => {});
      }, 1000);
    }

    return { success: true, message: 'Connected via WebSocket' };
  } catch (err) {
    _wsClient = null;
    _wsConnected = false;
    _wsStarting = false;
    logger.error(`[Remote/Lark] WSClient start failed: ${err.message}`);
    return { success: false, message: err.message };
  }
}

function stopLarkWS() {
  if (!_wsClient) return { success: true, message: 'Not running' };
  try {
    if (typeof _wsClient.close === 'function') _wsClient.close();
  } catch { /* ignore */ }
  _wsClient = null;
  _larkClient = null;
  _wsConnected = false;
  logger.info('[Remote/Lark] WebSocket connection stopped');
  return { success: true, message: 'Stopped' };
}

// ─── 自动启动（路由加载时） ─────────────────────────

const { appId: _autoId, appSecret: _autoSecret } = getLarkConfig();
if (_autoId && _autoSecret) {
  // 延迟 3 秒启动，等 express/DB 初始化完成
  setTimeout(async () => {
    logger.info('[Remote/Lark] Auto-starting WebSocket connection...');
    const result = await startLarkWS();
    if (!result.success) {
      logger.warn(`[Remote/Lark] Auto-start failed: ${result.message}`);
    }
  }, 3000);
}

// ─── 连接健康检查 & 自动重连 ────────────────────────

const HEALTH_CHECK_INTERVAL = 30_000; // 30 秒检查一次

setInterval(async () => {
  // 没有凭证 → 跳过
  const cfg = getLarkConfig();
  if (!cfg.appId || !cfg.appSecret) return;

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
    const db = getDb();
    ensureTable(db);
    const now = Math.floor(Date.now() / 1000);

    // pending 超时
    const pendingTimeout = db.prepare(
      'UPDATE remote_commands SET status = ?, completed_at = ? WHERE status = ? AND created_at < ?'
    ).run('timeout', now, 'pending', now - PENDING_TIMEOUT_SEC);

    // running 超时
    const runningTimeout = db.prepare(
      'UPDATE remote_commands SET status = ?, completed_at = ? WHERE status = ? AND claimed_at < ?'
    ).run('timeout', now, 'running', now - RUNNING_TIMEOUT_SEC);

    const total = (pendingTimeout.changes || 0) + (runningTimeout.changes || 0);
    if (total > 0) {
      logger.info(`[Remote] Cleaned ${total} timed-out commands`);
    }
  } catch { /* DB 尚未就绪时静默 */ }
}, CLEANUP_INTERVAL_MS);

// ═══════════════════════════════════════════════════════
//  系统命令处理
// ═══════════════════════════════════════════════════════

const SYSTEM_COMMANDS = {
  '/help': handleHelp,
  '/status': handleStatus,
  '/check': handleStatus,
  '/queue': handleQueue,
  '/cancel': handleCancel,
  '/clear': handleClear,
  '/ping': handlePing,
  '/screen': handleScreen,
};

function isSystemCommand(text) {
  const cmd = text.split(/\s/)[0].toLowerCase();
  return SYSTEM_COMMANDS[cmd] || null;
}

async function handleHelp(_args, messageId) {
  await replyLark(messageId, [
    '🤖 AutoSnippet 远程编程 — 命令帮助',
    '',
    '直接发送文字 → 注入 Copilot Agent Mode 执行编程',
    '',
    '系统命令：',
    '  /status  — 连接诊断 + 队列状态',
    '  /queue   — 查看待执行队列',
    '  /cancel  — 取消所有 pending 指令',
    '  /clear   — 清空历史记录',
    '  /ping    — 测试连通性',
    '  /screen  — 截取 IDE 画面发到飞书 (息屏可用)',
    '  /help    — 显示此帮助',
    '',
    '💡 远程模式自动开启全局 Auto-Approve，',
    '   Copilot 将自动执行工具调用/编辑/终端操作。',
  ].join('\n'));
}

async function handleStatus(_args, messageId) {
  const lines = ['📊 状态面板', ''];
  const now = Math.floor(Date.now() / 1000);
  let ideOk = false;

  // 1. 飞书 WebSocket
  lines.push(`① 飞书 WebSocket: ${_wsConnected ? '✅ 已连接' : '❌ 断开'}`);

  // 2. API 服务器
  lines.push('② API 服务器: ✅ 运行中 (port ' + (process.env.PORT || 3000) + ')');

  // 3. 活跃会话
  lines.push(`③ 活跃会话: ${_activeChatId ? '✅ ' + _activeChatId.slice(0, 16) + '...' : '⚠️ 无活跃会话'}`);

  // 4. IDE 扩展
  try {
    const db = getDb();
    ensureTable(db);

    const hasWaiters = _waiters.size > 0;
    const pollAge = _lastPollAt > 0 ? now - Math.floor(_lastPollAt / 1000) : -1;

    if (hasWaiters) {
      ideOk = true;
      lines.push('④ IDE 扩展: ✅ 在线 (long-poll 连接中)');
    } else if (pollAge >= 0 && pollAge < 30) {
      ideOk = true;
      lines.push(`④ IDE 扩展: ✅ 活跃 (${pollAge}秒前有心跳)`);
    } else {
      const recentClaim = db.prepare(
        'SELECT claimed_at FROM remote_commands WHERE claimed_at IS NOT NULL ORDER BY claimed_at DESC LIMIT 1'
      ).get();
      if (recentClaim?.claimed_at && (now - recentClaim.claimed_at) < 120) {
        ideOk = true;
        lines.push(`④ IDE 扩展: ✅ 活跃 (${now - recentClaim.claimed_at}秒前有 claim)`);
      } else {
        lines.push('④ IDE 扩展: ⚠️ 未检测到活跃连接');
      }
    }

    // 5. 队列
    const counts = {};
    for (const s of ['pending', 'running', 'completed', 'timeout']) {
      counts[s] = db.prepare('SELECT COUNT(*) as c FROM remote_commands WHERE status = ?').get(s)?.c || 0;
    }
    lines.push(`⑤ 队列: ${counts.pending} 待执行 | ${counts.running} 执行中 | ${counts.completed} 已完成 | ${counts.timeout} 超时`);
  } catch (err) {
    lines.push(`④ IDE 扩展: ❓ 查询失败 (${err.message})`);
    lines.push('⑤ 队列: ❓ 查询失败');
  }

  // 6. 通知通道
  lines.push(`⑥ 通知通道: ${isLarkNotificationReady() ? '✅ 就绪' : '❌ 未就绪'}`);

  // 总结
  const allGood = _wsConnected && _activeChatId && ideOk && isLarkNotificationReady();
  lines.push('');
  lines.push(allGood ? '🟢 全链路正常，可以远程编程！' : '🟡 部分链路异常，请检查上方标记。');

  await replyLark(messageId, lines.join('\n'));
}

async function handleQueue(_args, messageId) {
  try {
    const db = getDb();
    ensureTable(db);
    const rows = db.prepare(
      "SELECT id, command, status, created_at FROM remote_commands WHERE status IN ('pending', 'running') ORDER BY created_at ASC LIMIT 10"
    ).all();

    if (rows.length === 0) {
      await replyLark(messageId, '📋 队列为空，没有待执行的指令。');
      return;
    }

    const lines = rows.map((r, i) => {
      const icon = r.status === 'running' ? '🔄' : '⏳';
      const cmd = r.command.length > 40 ? r.command.slice(0, 40) + '...' : r.command;
      return `${i + 1}. ${icon} ${cmd}  (${r.id.slice(-8)})`;
    });

    await replyLark(messageId, `📋 当前队列 (${rows.length} 条)\n\n${lines.join('\n')}`);
  } catch (err) {
    await replyLark(messageId, `❌ 查询失败: ${err.message}`);
  }
}

async function handleCancel(_args, messageId) {
  try {
    const db = getDb();
    ensureTable(db);
    const now = Math.floor(Date.now() / 1000);
    const result = db.prepare(
      'UPDATE remote_commands SET status = ?, completed_at = ? WHERE status = ?'
    ).run('cancelled', now, 'pending');
    await replyLark(messageId, `🗑 已取消 ${result.changes} 条待执行指令。`);
  } catch (err) {
    await replyLark(messageId, `❌ 取消失败: ${err.message}`);
  }
}

async function handleClear(_args, messageId) {
  try {
    const db = getDb();
    ensureTable(db);
    const result = db.prepare(
      "DELETE FROM remote_commands WHERE status IN ('completed', 'timeout', 'cancelled')"
    ).run();
    await replyLark(messageId, `🧹 已清理 ${result.changes} 条历史记录。`);
  } catch (err) {
    await replyLark(messageId, `❌ 清理失败: ${err.message}`);
  }
}

async function handlePing(_args, messageId) {
  await replyLark(messageId, `🏓 pong! (${new Date().toLocaleTimeString('zh-CN')})`);
}

/**
 * /screen — 截取 IDE 窗口截图并发送到飞书（ScreenCaptureKit，息屏可用）
 */
async function handleScreen(_args, messageId) {
  await replyLark(messageId, '📸 正在截取 IDE 画面...');
  try {
    const result = await sendLarkScreenshot('');
    if (!result.success) {
      await replyLark(messageId, `❌ 截图失败: ${result.message}`);
    }
    // 成功时 sendLarkScreenshot 已自动发送图片消息
  } catch (err) {
    await replyLark(messageId, `❌ 截图异常: ${err.message}`);
  }
}

function getProjectRoot() {
  const container = getServiceContainer();
  return container.singletons?._projectRoot || process.env.ASD_PROJECT_DIR || process.cwd();
}

// ═══════════════════════════════════════════════════════
//  飞书消息处理
// ═══════════════════════════════════════════════════════

async function handleLarkMessage(data) {
  const message = data?.message || data?.event?.message || {};
  const sender = data?.sender || data?.event?.sender || {};
  const messageId = message.message_id;
  const chatId = message.chat_id;
  const msgType = message.message_type;

  if (isDuplicate(messageId)) return;

  // ── 发送者白名单校验 ──
  const senderId = sender.sender_id?.user_id || sender.sender_id?.open_id || '';
  if (!isUserAllowed(senderId)) {
    logger.warn(`[Remote/Lark] Blocked unauthorized user: ${senderId}`);
    await replyLark(messageId, '🔒 权限不足，你不在授权用户列表中。');
    return;
  }

  if (msgType !== 'text') {
    await replyLark(messageId, '🤖 目前只支持文本指令。\n发 /help 查看帮助。');
    return;
  }

  let textContent = '';
  try {
    const content = JSON.parse(message.content || '{}');
    textContent = (content.text || '').trim();
  } catch {
    textContent = '';
  }
  if (!textContent) return;

  textContent = textContent.replace(/@_user_\d+/g, '').trim();
  if (!textContent) return;

  // ── 系统命令拦截 ──
  const sysHandler = isSystemCommand(textContent);
  if (sysHandler) {
    const args = textContent.split(/\s+/).slice(1).join(' ');
    await sysHandler(args, messageId);
    return;
  }

  // ── 写入编程指令队列 ──
  const db = getDb();
  ensureTable(db);
  const id = genId();
  const now = Math.floor(Date.now() / 1000);

  const userId = sender.sender_id?.user_id || sender.sender_id?.open_id || '';
  const userName = sender.sender_id?.user_id || 'lark_user';

  // 记录活跃会话（供主动通知使用）
  if (chatId) {
    _activeChatId = chatId;
    _persistActiveChatId(chatId);
  }

  db.prepare(`
    INSERT INTO remote_commands (id, source, chat_id, message_id, user_id, user_name, command, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, 'lark', chatId || '', messageId || '', userId, userName, textContent, now);

  logger.info(`[Remote/Lark] Command queued: ${id} — "${textContent.slice(0, 50)}"`);

  // 立即唤醒 long-poll 等待中的扩展端
  wakeWaiters();

  // 查当前队列深度
  const queueDepth = db.prepare("SELECT COUNT(*) as c FROM remote_commands WHERE status IN ('pending', 'running')").get()?.c || 1;
  const queueInfo = queueDepth > 1 ? `\n\n当前队列: ${queueDepth} 条指令` : '';

  await replyLark(messageId, `📝 收到，已加入执行队列。${queueInfo}`);
}

// ═══════════════════════════════════════════════════════
//  飞书连接管理端点
// ═══════════════════════════════════════════════════════

router.post('/lark/start', asyncHandler(async (_req, res) => {
  res.json(await startLarkWS());
}));

router.post('/lark/stop', asyncHandler(async (_req, res) => {
  res.json(stopLarkWS());
}));

router.get('/lark/status', asyncHandler(async (_req, res) => {
  const config = getLarkConfig();
  let queueInfo = {};
  try {
    const db = getDb();
    ensureTable(db);
    for (const s of ['pending', 'running', 'completed', 'timeout']) {
      queueInfo[s] = db.prepare('SELECT COUNT(*) as c FROM remote_commands WHERE status = ?').get(s)?.c || 0;
    }
  } catch { /* DB 未就绪 */ }

  res.json({
    success: true,
    data: {
      connected: _wsConnected,
      hasCredentials: !!(config.appId && config.appSecret),
      appId: config.appId ? `${config.appId.slice(0, 8)}...` : '',
      activeChatId: _activeChatId ? `${_activeChatId.slice(0, 12)}...` : '',
      notificationReady: isLarkNotificationReady(),
      queue: queueInfo,
    },
  });
}));

// ═══════════════════════════════════════════════════════
//  飞书 Webhook 回调（备用）
// ═══════════════════════════════════════════════════════

router.post('/lark/event', asyncHandler(async (req, res) => {
  const body = req.body;
  if (body.type === 'url_verification') {
    return res.json({ challenge: body.challenge });
  }
  const header = body.header || {};
  const event = body.event || {};
  const larkConfig = getLarkConfig();
  if (larkConfig.verificationToken && header.token !== larkConfig.verificationToken) {
    return res.status(403).json({ success: false, message: 'Invalid token' });
  }
  if (header.event_type === 'im.message.receive_v1') {
    await handleLarkMessage(event);
  }
  res.json({ success: true });
}));

// ═══════════════════════════════════════════════════════
//  VSCode 扩展 API
// ═══════════════════════════════════════════════════════

router.get('/pending', asyncHandler(async (_req, res) => {
  _lastPollAt = Date.now();
  const db = getDb();
  ensureTable(db);
  const row = db.prepare(
    'SELECT * FROM remote_commands WHERE status = ? ORDER BY created_at ASC LIMIT 1'
  ).get('pending');
  res.json({
    success: true,
    data: row ? { id: row.id, command: row.command, source: row.source, userName: row.user_name, messageId: row.message_id, createdAt: row.created_at } : null,
  });
}));

router.post('/claim/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const db = getDb();
  ensureTable(db);
  const result = db.prepare(
    'UPDATE remote_commands SET status = ?, claimed_at = ? WHERE id = ? AND status = ?'
  ).run('running', Math.floor(Date.now() / 1000), id, 'pending');
  if (result.changes === 0) {
    return res.json({ success: false, message: 'Not found or already claimed' });
  }
  // 通知飞书用户：IDE 已开始执行
  const row = db.prepare('SELECT message_id, command FROM remote_commands WHERE id = ?').get(id);
  if (row?.message_id) {
    replyLark(row.message_id, `🚀 IDE 已开始执行...\n\n> ${(row.command || '').slice(0, 60)}`).catch(() => {});
  }
  res.json({ success: true });
}));

router.post('/result/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { result, status = 'completed' } = req.body;
  const db = getDb();
  ensureTable(db);
  const row = db.prepare('SELECT * FROM remote_commands WHERE id = ?').get(id);
  if (!row) return res.json({ success: false, message: 'Not found' });

  db.prepare(
    'UPDATE remote_commands SET status = ?, result = ?, completed_at = ? WHERE id = ?'
  ).run(status, result || '', Math.floor(Date.now() / 1000), id);

  // 回复飞书
  if (row.message_id && result) {
    const truncated = result.length > 2000
      ? result.slice(0, 2000) + '\n\n... (截断)'
      : result;
    if (status === 'completed') {
      await replyLark(row.message_id, truncated);
    } else {
      const emoji = status === 'failed' ? '❌' : '⚠️';
      const label = status === 'failed' ? '执行失败' : status;
      await replyLark(row.message_id, `${emoji} ${label}\n\n${truncated}`);
    }
  }
  res.json({ success: true });
}));

router.get('/history', asyncHandler(async (req, res) => {
  const db = getDb();
  ensureTable(db);
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const rows = db.prepare('SELECT * FROM remote_commands ORDER BY created_at DESC LIMIT ?').all(limit);
  res.json({ success: true, data: rows });
}));

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
    resolve({ hasNew: true });
  }
  _waiters.clear();
}

router.get('/wait', (req, res) => {
  _lastPollAt = Date.now();
  const timeout = Math.min(parseInt(req.query.timeout) || 25000, 60000);
  let resolved = false;

  const resolve = (data) => {
    if (resolved) return;
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
router.post('/flush', asyncHandler(async (req, res) => {
  const db = getDb();
  ensureTable(db);

  // 查出所有 pending 指令的摘要
  const pending = db.prepare(
    "SELECT id, command, created_at FROM remote_commands WHERE status = 'pending' ORDER BY created_at ASC"
  ).all();

  if (pending.length === 0) {
    return res.json({ success: true, flushed: 0, commands: [] });
  }

  // 批量标记为 cancelled
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "UPDATE remote_commands SET status = 'cancelled', result = '🗑 IDE 重连时自动清理（积压指令）', completed_at = ? WHERE status = 'pending'"
  ).run(now);

  const summaries = pending.map(r => ({
    id: r.id,
    command: r.command?.slice(0, 60) || '',
    age: now - r.created_at,
  }));

  logger.info(`[Remote] Flushed ${pending.length} stale pending commands on IDE reconnect`);

  // 飞书通知
  const lines = summaries.map((s, i) =>
    `  ${i + 1}. ${s.command}${s.command.length >= 60 ? '…' : ''} (${s.age}s ago)`
  );
  sendLarkNotification(
    `🗑 IDE 重连，已清理 ${pending.length} 条积压指令：\n${lines.join('\n')}`
  ).catch(() => {});

  res.json({ success: true, flushed: pending.length, commands: summaries });
}));

router.post('/send', asyncHandler(async (req, res) => {
  const { command } = req.body;
  if (!command?.trim()) return res.status(400).json({ success: false, message: 'command required' });
  const db = getDb();
  ensureTable(db);
  const id = genId();
  db.prepare('INSERT INTO remote_commands (id, source, command, status, user_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'manual', command.trim(), 'pending', 'developer', Math.floor(Date.now() / 1000));
  res.json({ success: true, data: { id, command: command.trim() } });
}));

// POST /api/v1/remote/notify — 通用通知（扩展/外部模块主动推送飞书）
router.post('/notify', asyncHandler(async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ success: false, message: 'text required' });
  const sent = await sendLarkNotification(text.trim());
  res.json({ success: sent, message: sent ? 'Sent' : 'Lark not connected or no active chat' });
}));

// POST /api/v1/remote/screenshot — 截取 IDE 窗口并发送到飞书
router.post('/screenshot', asyncHandler(async (req, res) => {
  const { caption } = req.body || {};
  const result = await sendLarkScreenshot(caption || '');
  res.json(result);
}));

// ═══════════════════════════════════════════════════════
//  飞书回复辅助
// ═══════════════════════════════════════════════════════

let _tenantToken = '';
let _tenantTokenExpiry = 0;

async function getTenantToken() {
  if (_tenantToken && Date.now() < _tenantTokenExpiry) return _tenantToken;
  const config = getLarkConfig();
  if (!config.appId || !config.appSecret) return '';
  try {
    const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
    });
    const data = await resp.json();
    if (data.code === 0 && data.tenant_access_token) {
      _tenantToken = data.tenant_access_token;
      _tenantTokenExpiry = Date.now() + (data.expire - 300) * 1000;
      return _tenantToken;
    }
    return '';
  } catch { return ''; }
}

async function replyLark(messageId, text) {
  if (!messageId) return;

  // SDK Client 优先
  if (_larkClient) {
    try {
      await _larkClient.im.message.reply({
        path: { message_id: messageId },
        data: { content: JSON.stringify({ text }), msg_type: 'text' },
      });
      return;
    } catch (err) {
      logger.warn(`[Remote/Lark] SDK reply failed: ${err.message}`);
    }
  }

  // REST 回退
  const token = await getTenantToken();
  if (!token) return;
  try {
    await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content: JSON.stringify({ text }), msg_type: 'text' }),
    });
  } catch { /* silent */ }
}

// ═══════════════════════════════════════════════════════
//  IDE 窗口截图 + 飞书发送（ScreenCaptureKit，息屏可用）
// ═══════════════════════════════════════════════════════

/**
 * 截取 IDE 窗口截图（通过 ScreenCaptureKit 原生 API，息屏时可用）
 * @param {object} [opts]
 * @param {string} [opts.windowTitle] — 窗口标题关键词（默认 "Code"）
 * @returns {Promise<{path: string|null, error: string|null}>}
 */
async function captureIDEScreenshot(opts = {}) {
  try {
    const { screenshot } = await import('../../service/agent/ScreenCaptureService.js');

    // 优先截取 IDE 窗口
    const windowTitle = opts.windowTitle || 'Code';
    let result = await screenshot({ windowTitle, format: 'png' });

    // 窗口截取失败时回退到全屏
    if (!result.success) {
      logger.info(`[Remote/Screenshot] Window capture failed, falling back to full screen`);
      result = await screenshot({ format: 'png' });
    }

    if (result.success) {
      logger.info(`[Remote/Screenshot] Captured: ${result.path} (${result.width}x${result.height})`);
      return { path: result.path, error: null };
    }

    return { path: null, error: result.error || 'Screenshot failed' };
  } catch (err) {
    logger.warn(`[Remote/Screenshot] ScreenCaptureKit error: ${err.message}`);
    return { path: null, error: err.message };
  }
}

/**
 * 上传图片到飞书 Image API
 * @param {string} filePath — 本地图片路径
 * @returns {Promise<{imageKey: string|null, error: string|null}>}
 */
async function _uploadImageToLark(filePath) {
  const token = await getTenantToken();
  if (!token) return { imageKey: null, error: '获取 tenant_access_token 失败' };
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
    const data = await resp.json();
    if (data.code === 0 && data.data?.image_key) {
      return { imageKey: data.data.image_key, error: null };
    }
    const errMsg = `飞书图片上传失败 (code=${data.code}): ${data.msg || '未知错误'}`;
    logger.warn(`[Remote/Screenshot] Upload failed: code=${data.code} msg=${data.msg}`);
    return { imageKey: null, error: errMsg };
  } catch (err) {
    logger.warn(`[Remote/Screenshot] Upload error: ${err.message}`);
    return { imageKey: null, error: `上传异常: ${err.message}` };
  }
}

/**
 * 向飞书发送图片消息
 * @param {string} imageKey
 * @returns {Promise<boolean>}
 */
async function _sendLarkImageMsg(imageKey) {
  if (!_activeChatId || !_wsConnected) return false;

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
    } catch (err) {
      logger.warn(`[Remote/Screenshot] SDK image send failed: ${err.message}`);
    }
  }

  // REST 回退
  const token = await getTenantToken();
  if (!token) return false;
  try {
    const resp = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        receive_id: _activeChatId,
        content: JSON.stringify({ image_key: imageKey }),
        msg_type: 'image',
      }),
    });
    const data = await resp.json();
    return data.code === 0;
  } catch {
    return false;
  }
}

/**
 * 截取 IDE 窗口 → 上传飞书 → 发送图片消息（完整流水线）
 * @param {string} [caption] — 可选文字说明（会先发一条文本）
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
    try { unlinkSync(filePath); } catch { /* ignore */ }
  }
}

// ═══════════════════════════════════════════════════════
//  主动通知能力（供 task.js 等外部模块调用）
// ═══════════════════════════════════════════════════════

/** 最近活跃的飞书 chat_id（收到消息时更新） */
let _activeChatId = '';

/** 持久化 active chat_id 到数据库 */
function _persistActiveChatId(chatId) {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS remote_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)`);
    db.prepare('INSERT OR REPLACE INTO remote_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run('active_chat_id', chatId, Math.floor(Date.now() / 1000));
  } catch { /* DB 未就绪 */ }
}

/** 从数据库恢复 active chat_id */
function _restoreActiveChatId() {
  try {
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS remote_state (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)`);

    // 优先从 remote_state 恢复
    const row = db.prepare('SELECT value FROM remote_state WHERE key = ?').get('active_chat_id');
    if (row?.value) {
      _activeChatId = row.value;
      logger.info(`[Remote/Lark] Restored active chat from state: ${_activeChatId.slice(0, 12)}...`);
      return;
    }

    // 回退：从 remote_commands 取最近有 chat_id 的记录
    const cmdRow = db.prepare(
      "SELECT chat_id FROM remote_commands WHERE chat_id != '' ORDER BY created_at DESC LIMIT 1"
    ).get();
    if (cmdRow?.chat_id) {
      _activeChatId = cmdRow.chat_id;
      _persistActiveChatId(cmdRow.chat_id);
      logger.info(`[Remote/Lark] Restored active chat from history: ${_activeChatId.slice(0, 12)}...`);
    }
  } catch { /* DB 未就绪 */ }
}

/**
 * 向飞书活跃会话发送主动通知（非回复）
 * 用于任务进度、Guard 结果等非指令触发的通知
 *
 * @param {string} text — 纯文本通知内容
 * @returns {Promise<boolean>} — 发送是否成功
 */
export async function sendLarkNotification(text) {
  if (!_activeChatId || !_wsConnected) return false;

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
    } catch (err) {
      logger.warn(`[Remote/Lark] SDK send failed: ${err.message}`);
    }
  }

  // REST 回退
  const token = await getTenantToken();
  if (!token) return false;
  try {
    const resp = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        receive_id: _activeChatId,
        content: JSON.stringify({ text }),
        msg_type: 'text',
      }),
    });
    const data = await resp.json();
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
