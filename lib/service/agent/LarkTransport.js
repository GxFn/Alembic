/**
 * LarkTransport — 飞书消息传输层
 *
 * 职责: 将飞书 SDK 的原始消息格式转换为统一 AgentMessage，
 *        并把 Agent 的回复写回飞书。
 *
 * 架构位置:
 *   飞书 WS Event → LarkTransport.receive(rawEvent)
 *     → 解析文本/附件 → AgentMessage.fromLark(...)
 *     → IntentClassifier.classify(text)
 *     → 路由到 Bot Agent (服务端) 或 IDE Agent (VSCode)
 *     → 回复通过 replyFn/sendFn 写回飞书
 *
 * 与 remote.js 的关系:
 *   remote.js 仍然管理飞书 WS 连接和 HTTP 端点，
 *   LarkTransport 处理消息语义层 (NL 理解、Agent 路由、回复格式化)。
 *
 * @module LarkTransport
 */

import Logger from '../../infrastructure/logging/Logger.js';
import { AgentMessage, Channel } from './AgentMessage.js';
import { IntentClassifier, Intent } from './IntentClassifier.js';

/**
 * @typedef {Object} LarkTransportConfig
 * @property {import('./AgentFactory.js').AgentFactory} agentFactory — Agent 工厂
 * @property {Function} replyFn — (messageId, text) => Promise<void>
 * @property {Function} sendFn — (text) => Promise<void> (主动发送到活跃会话)
 * @property {Function} [sendImageFn] — (caption?) => Promise<{success, message}>
 * @property {Function} [getStatusFn] — () => Promise<string> 获取系统状态
 * @property {Function} [enqueueIdeFn] — (command, meta) => Promise<{id}> 写入 IDE 队列
 * @property {Function} [isUserAllowed] — (userId) => boolean 鉴权
 * @property {import('../../external/ai/AiProvider.js').AiProvider} [aiProvider]
 */

export class LarkTransport {
  #agentFactory;
  #classifier;
  #logger;
  #replyFn;
  #sendFn;
  #sendImageFn;
  #getStatusFn;
  #enqueueIdeFn;
  #isUserAllowed;

  /** @type {Map<string, Array<{role: string, content: string}>>} chatId → 最近对话 */
  #conversationHistory = new Map();
  /** 对话历史最大轮数 */
  static MAX_HISTORY = 20;

  /** @type {Map<string, number>} messageId → timestamp, 消息去重 */
  #recentMsgIds = new Map();
  /** 去重 TTL (5 分钟) */
  static DEDUP_TTL = 5 * 60 * 1000;

  /**
   * @param {LarkTransportConfig} config
   */
  constructor(config) {
    this.#agentFactory = config.agentFactory;
    this.#replyFn = config.replyFn;
    this.#sendFn = config.sendFn;
    this.#sendImageFn = config.sendImageFn || null;
    this.#getStatusFn = config.getStatusFn || null;
    this.#enqueueIdeFn = config.enqueueIdeFn || null;
    this.#isUserAllowed = config.isUserAllowed || (() => true);
    this.#logger = Logger.getInstance();

    this.#classifier = new IntentClassifier({
      aiProvider: config.aiProvider || null,
    });
  }

  /**
   * 接收原始飞书消息事件
   *
   * 这是唯一入口 — 替代了 remote.js 中的 handleLarkMessage()
   *
   * @param {Object} data — 飞书 im.message.receive_v1 事件数据
   * @returns {Promise<void>}
   */
  async receive(data) {
    const message = data?.message || data?.event?.message || {};
    const sender = data?.sender || data?.event?.sender || {};
    const messageId = message.message_id;
    const chatId = message.chat_id;
    const msgType = message.message_type;

    // ── 消息去重 (defense-in-depth, remote.js 也有外层去重) ──
    if (messageId && this.#recentMsgIds.has(messageId)) {
      this.#logger.debug(`[LarkTransport] Dedup: ${messageId}`);
      return;
    }
    if (messageId) {
      this.#recentMsgIds.set(messageId, Date.now());
      // 清理过期条目
      if (this.#recentMsgIds.size > 200) {
        const now = Date.now();
        for (const [id, ts] of this.#recentMsgIds) {
          if (now - ts > LarkTransport.DEDUP_TTL) this.#recentMsgIds.delete(id);
        }
      }
    }

    // ── 鉴权 ──
    const senderId = sender.sender_id?.user_id || sender.sender_id?.open_id || '';
    const senderName = sender.sender_id?.user_id || 'lark_user';

    if (!this.#isUserAllowed(senderId)) {
      this.#logger.warn(`[LarkTransport] Blocked: ${senderId}`);
      await this.#reply(messageId, '🔒 权限不足。');
      return;
    }

    // ── 非文本提示 ──
    if (msgType !== 'text') {
      await this.#reply(messageId, '💬 请发送文字消息，我理解自然语言。');
      return;
    }

    // ── 解析文本 ──
    let text = '';
    try {
      const content = JSON.parse(message.content || '{}');
      text = (content.text || '').trim();
    } catch {
      text = '';
    }
    text = text.replace(/@_user_\d+/g, '').trim();
    if (!text) return;

    this.#logger.info(`[LarkTransport] Received: "${text.slice(0, 80)}" from ${senderName}`);

    // ── 意图分类 ──
    const recentHistory = this.#getRecentHistoryText(chatId);
    const classification = await this.#classifier.classify(text, { recentHistory });

    this.#logger.info(
      `[LarkTransport] Intent: ${classification.intent} (${classification.confidence.toFixed(2)}) — ${classification.reasoning}`
    );

    // ── 路由处理 ──
    switch (classification.intent) {
      case Intent.SYSTEM:
        await this.#handleSystem(classification.action, messageId, text);
        break;

      case Intent.IDE_AGENT:
        await this.#handleIdeAgent(text, messageId, chatId, senderId, senderName);
        break;

      case Intent.BOT_AGENT:
      default:
        await this.#handleBotAgent(text, messageId, chatId, senderId, senderName);
        break;
    }
  }

  // ═══════════════════════════════════════════════════
  //  意图处理器
  // ═══════════════════════════════════════════════════

  /**
   * 系统操作 — 直接处理，不走 Agent
   */
  async #handleSystem(action, messageId, _text) {
    switch (action) {
      case 'status':
        if (this.#getStatusFn) {
          const status = await this.#getStatusFn();
          await this.#reply(messageId, status);
        } else {
          await this.#reply(messageId, '📊 状态查询暂不可用');
        }
        break;

      case 'screen':
        if (this.#sendImageFn) {
          await this.#reply(messageId, '📸 正在截取 IDE 画面...');
          const result = await this.#sendImageFn('');
          if (!result.success) {
            await this.#reply(messageId, `❌ 截图失败: ${result.message}`);
          }
        } else {
          await this.#reply(messageId, '📸 截图功能未配置');
        }
        break;

      case 'help':
        await this.#reply(messageId, [
          '🤖 AutoSnippet 智能助手',
          '',
          '直接用自然语言和我对话即可:',
          '',
          '📚 知识管理 (我来处理):',
          '  "搜索项目里关于认证的知识"',
          '  "解释一下这个项目的架构"',
          '  "帮我创建一个关于缓存策略的知识"',
          '  "翻译这段代码注释"',
          '',
          '💻 代码编程 (转发到 IDE):',
          '  "修改 src/auth.ts 的 JWT 验证"',
          '  "写一个新的 React 组件"',
          '  "修复这个 TypeScript 报错"',
          '  "运行一下测试"',
          '',
          '🔧 系统操作:',
          '  "查看状态" — 连接诊断',
          '  "截图" — 截取 IDE 画面',
          '  "帮助" — 显示此信息',
          '',
          '💡 我会自动判断你的意图类型。',
          '   知识类任务我直接处理，编程类任务转发到 VSCode。',
        ].join('\n'));
        break;

      case 'queue':
        await this.#reply(messageId, '📋 请说"查看队列状态"获取更多信息。');
        break;

      case 'cancel':
        await this.#reply(messageId, '🗑 取消操作已发送。');
        break;

      case 'clear':
        await this.#reply(messageId, '🧹 清理操作已发送。');
        break;

      case 'ping':
        await this.#reply(messageId, `🏓 pong! (${new Date().toLocaleTimeString('zh-CN')})`);
        break;

      default:
        await this.#reply(messageId, '❓ 未识别的系统操作。');
    }
  }

  /**
   * IDE 编程任务 — 转发到 VSCode Copilot 执行
   */
  async #handleIdeAgent(text, messageId, chatId, senderId, senderName) {
    if (!this.#enqueueIdeFn) {
      await this.#reply(messageId, '❌ IDE 桥接未配置，无法转发编程任务。');
      return;
    }

    try {
      const result = await this.#enqueueIdeFn(text, {
        chatId, messageId, senderId, senderName,
      });

      // 记录到对话历史
      this.#appendHistory(chatId, 'user', text);
      this.#appendHistory(chatId, 'assistant', `[IDE Agent] 已转发: ${text.slice(0, 50)}`);

      await this.#reply(messageId, [
        '💻 编程任务已转发到 IDE',
        '',
        `> ${text.length > 80 ? text.slice(0, 80) + '...' : text}`,
        '',
        'Copilot Agent Mode 将自动处理。',
        '执行结果会回传到这里。',
      ].join('\n'));
    } catch (err) {
      this.#logger.error(`[LarkTransport] IDE enqueue failed: ${err.message}`);
      await this.#reply(messageId, `❌ 转发失败: ${err.message}`);
    }
  }

  /**
   * Bot Agent 知识任务 — 服务端 AgentRuntime 直接处理
   */
  async #handleBotAgent(text, messageId, chatId, senderId, senderName) {
    // 进度提示
    await this.#reply(messageId, '🤔 正在思考...');

    try {
      // 获取对话历史
      const history = this.#getHistory(chatId);

      // 构建 AgentMessage
      // 注意: 不传 replyFn — AgentRuntime.execute() 会自动调用 message.reply()，
      // 但我们需要在外层处理截断逻辑，所以由下面的 #send 手动发送最终回复。
      const agentMessage = AgentMessage.fromLark(
        {
          text,
          chatId,
          senderId,
          senderName,
          messageId,
          messageType: 'text',
        },
        null, // 不设 replyFn — 避免 AgentRuntime 自动回复导致重复发送
      );

      // 注入对话历史
      agentMessage.session.history = history;

      // 创建 Chat Runtime 并执行
      const runtime = this.#agentFactory.createChat({
        lang: 'zh',
        onProgress: (event) => {
          // 工具调用时发送进度
          if (event.type === 'tool_call') {
            this.#send(`🔧 调用工具: ${event.tool || 'unknown'}...`).catch(() => {});
          }
        },
      });

      const result = await runtime.execute(agentMessage);

      // 提取回复
      const reply = result?.reply || result?.text || '抱歉，没有生成有效回复。';

      // 记录对话历史
      this.#appendHistory(chatId, 'user', text);
      this.#appendHistory(chatId, 'assistant', reply);

      // 发送最终回复 (去掉之前的"正在思考"，直接发新消息)
      // 飞书回复字数限制 ~4000，需截断
      const MAX_LEN = 3800;
      if (reply.length > MAX_LEN) {
        const truncated = reply.slice(0, MAX_LEN) + '\n\n... (内容过长已截断)';
        await this.#send(truncated);
      } else {
        await this.#send(reply);
      }

    } catch (err) {
      this.#logger.error(`[LarkTransport] Bot Agent error: ${err.message}\n${err.stack}`);
      await this.#reply(messageId, `❌ 处理失败: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════
  //  对话历史管理
  // ═══════════════════════════════════════════════════

  /**
   * 获取指定会话的历史
   */
  #getHistory(chatId) {
    return this.#conversationHistory.get(chatId) || [];
  }

  /**
   * 获取最近对话的可读文本 (给 IntentClassifier 提供上下文)
   */
  #getRecentHistoryText(chatId) {
    const history = this.#getHistory(chatId);
    if (history.length === 0) return '';
    return history
      .slice(-6)
      .map(h => `${h.role}: ${h.content.slice(0, 100)}`)
      .join('\n');
  }

  /**
   * 追加对话记录
   */
  #appendHistory(chatId, role, content) {
    if (!chatId) return;
    if (!this.#conversationHistory.has(chatId)) {
      this.#conversationHistory.set(chatId, []);
    }
    const history = this.#conversationHistory.get(chatId);
    history.push({ role, content });
    // 限制历史长度
    if (history.length > LarkTransport.MAX_HISTORY * 2) {
      history.splice(0, history.length - LarkTransport.MAX_HISTORY * 2);
    }
  }

  // ═══════════════════════════════════════════════════
  //  飞书消息发送
  // ═══════════════════════════════════════════════════

  async #reply(messageId, text) {
    if (this.#replyFn) await this.#replyFn(messageId, text);
  }

  async #send(text) {
    if (this.#sendFn) await this.#sendFn(text);
  }
}

export default LarkTransport;
