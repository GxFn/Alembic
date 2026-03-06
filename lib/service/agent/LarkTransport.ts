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
import { AgentMessage } from './AgentMessage.js';
import { ConversationStore } from './ConversationStore.js';
import { Intent, IntentClassifier } from './IntentClassifier.js';

/**
 * @typedef {Object} LarkTransportConfig
 * @property {import('./AgentFactory.js').AgentFactory} agentFactory - Agent 工厂
 * @property {Function} replyFn - (messageId, text) => Promise<void>
 * @property {Function} sendFn - (text) => Promise<void> (主动发送到活跃会话)
 * @property {Function} [sendImageFn] - (caption?) => Promise<{success, message}>
 * @property {Function} [getStatusFn] - () => Promise<string> 获取系统状态
 * @property {Function} [enqueueIdeFn] - (command, meta) => Promise<{id}> 写入 IDE 队列
 * @property {Function} [isUserAllowed] - (userId) => boolean 鉴权
 * @property {import('../../external/ai/AiProvider.js').AiProvider} [aiProvider]
 * @property {string} [projectRoot] 项目根目录 (用于 ConversationStore 持久化)
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

  /** @type {ConversationStore|null} 持久化对话存储 */
  #conversationStore: any = null;
  /** @type {Map<string, string>} chatId → conversationId 映射缓存 */
  #chatConversationMap = new Map();

  /** @type {Map<string, Array<{role: string, content: string}>>} chatId → 最近对话 (降级用) */
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
  constructor(config: any) {
    this.#agentFactory = config.agentFactory;
    this.#replyFn = config.replyFn;
    this.#sendFn = config.sendFn;
    this.#sendImageFn = config.sendImageFn || null;
    this.#getStatusFn = config.getStatusFn || null;
    this.#enqueueIdeFn = config.enqueueIdeFn || null;
    this.#isUserAllowed = config.isUserAllowed || (() => true);
    this.#logger = Logger.getInstance();

    // 初始化持久化对话存储（静默降级）
    try {
      const projectRoot = config.projectRoot || process.cwd();
      this.#conversationStore = new ConversationStore(projectRoot);
      this.#logger.info('[LarkTransport] ConversationStore initialized');
    } catch (err: any) {
      this.#logger.warn(
        `[LarkTransport] ConversationStore init failed, falling back to in-memory: ${err.message}`
      );
      this.#conversationStore = null;
    }

    this.#classifier = new IntentClassifier({
      aiProvider: config.aiProvider || null,
    });
  }

  /**
   * 接收原始飞书消息事件
   *
   * 这是唯一入口 — 替代了 remote.js 中的 handleLarkMessage()
   *
   * @param {Object} data 飞书 im.message.receive_v1 事件数据
   * @returns {Promise<void>}
   */
  async receive(data: any) {
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
          if (now - ts > LarkTransport.DEDUP_TTL) {
            this.#recentMsgIds.delete(id);
          }
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
    if (!text) {
      return;
    }

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
        await this.#handleSystem((classification as any).action, messageId, text);
        break;

      case Intent.IDE_AGENT:
        await this.#handleIdeAgent(text, messageId, chatId, senderId, senderName);
        break;
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
  async #handleSystem(action: any, messageId: any, _text: any) {
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
        await this.#reply(
          messageId,
          [
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
          ].join('\n')
        );
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
   * IDE 编程任务 — 转发到 VSCode Copilot 或服务端远程执行
   *
   * `>` 前缀命令 → 使用 remote-exec preset 在服务端直接执行（含 SafetyPolicy 白名单）
   * 其他 IDE 编程任务 → 转发到 VSCode Copilot Agent Mode
   */
  async #handleIdeAgent(text: any, messageId: any, chatId: any, senderId: any, senderName: any) {
    // ── `>` 前缀: 远程执行命令 ──
    if (text.startsWith('>')) {
      const command = text.slice(1).trim();
      if (!command) {
        await this.#reply(messageId, '❌ 请在 `>` 后输入要执行的命令。');
        return;
      }
      await this.#handleRemoteExec(command, messageId, chatId, senderId, senderName);
      return;
    }

    // ── 其他 IDE 编程任务: 转发到 VSCode ──
    if (!this.#enqueueIdeFn) {
      await this.#reply(messageId, '❌ IDE 桥接未配置，无法转发编程任务。');
      return;
    }

    try {
      const _result = await this.#enqueueIdeFn(text, {
        chatId,
        messageId,
        senderId,
        senderName,
      });

      // 记录到对话历史
      this.#appendHistory(chatId, 'user', text);
      this.#appendHistory(chatId, 'assistant', `[IDE Agent] 已转发: ${text.slice(0, 50)}`);

      await this.#reply(
        messageId,
        [
          '💻 编程任务已转发到 IDE',
          '',
          `> ${text.length > 80 ? `${text.slice(0, 80)}...` : text}`,
          '',
          'Copilot Agent Mode 将自动处理。',
          '执行结果会回传到这里。',
        ].join('\n')
      );
    } catch (err: any) {
      this.#logger.error(`[LarkTransport] IDE enqueue failed: ${err.message}`);
      await this.#reply(messageId, `❌ 转发失败: ${err.message}`);
    }
  }

  /**
   * 远程命令执行 — 使用 remote-exec preset（含 SafetyPolicy 命令白名单）
   */
  async #handleRemoteExec(
    command: any,
    messageId: any,
    chatId: any,
    senderId: any,
    senderName: any
  ) {
    await this.#reply(messageId, `⚡ 正在执行: \`${command.slice(0, 60)}\`...`);

    try {
      const history = this.#getHistory(chatId);

      const agentMessage = AgentMessage.fromLark(
        {
          text: command,
          chatId,
          senderId,
          senderName,
          messageId,
          messageType: 'text',
        },
        null
      );
      agentMessage.session.history = history;

      // 使用 remote-exec preset — 包含 SafetyPolicy 命令白名单 + fileScope
      const runtime = this.#agentFactory.createRemoteExec({
        lang: 'zh',
        onProgress: (event: any) => {
          if (event.type === 'tool_call') {
            this.#send(`🔧 执行: ${event.tool || 'unknown'}...`).catch(() => {});
          }
        },
      });

      const result = await runtime.execute(agentMessage);
      const reply = result?.reply || result?.text || '命令执行完成，无输出。';

      this.#appendHistory(chatId, 'user', `> ${command}`);
      this.#appendHistory(chatId, 'assistant', reply);

      const MAX_LEN = 3800;
      if (reply.length > MAX_LEN) {
        await this.#send(`${reply.slice(0, MAX_LEN)}\n\n... (内容过长已截断)`);
      } else {
        await this.#send(reply);
      }
    } catch (err: any) {
      this.#logger.error(`[LarkTransport] Remote exec error: ${err.message}\n${err.stack}`);
      await this.#reply(messageId, `❌ 执行失败: ${err.message}`);
    }
  }

  /**
   * Bot Agent 知识任务 — 服务端 AgentRuntime 直接处理
   */
  async #handleBotAgent(text: any, messageId: any, chatId: any, senderId: any, senderName: any) {
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
        null // 不设 replyFn — 避免 AgentRuntime 自动回复导致重复发送
      );

      // 注入对话历史
      agentMessage.session.history = history;

      // 创建 Lark Runtime 并执行 — 使用 lark preset（含 SafetyPolicy 鉴权）
      const runtime = this.#agentFactory.createLark({
        lang: 'zh',
        onProgress: (event: any) => {
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
        const truncated = `${reply.slice(0, MAX_LEN)}\n\n... (内容过长已截断)`;
        await this.#send(truncated);
      } else {
        await this.#send(reply);
      }
    } catch (err: any) {
      this.#logger.error(`[LarkTransport] Bot Agent error: ${err.message}\n${err.stack}`);
      await this.#reply(messageId, `❌ 处理失败: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════
  //  对话历史管理 (ConversationStore 持久化 + 内存降级)
  // ═══════════════════════════════════════════════════

  /**
   * 获取或创建 chatId 对应的 conversationId
   * @param {string} chatId
   * @returns {string|null} conversationId (ConversationStore 不可用时返回 null)
   */
  #resolveConversationId(chatId: any) {
    if (!this.#conversationStore || !chatId) {
      return null;
    }

    // 缓存命中
    if (this.#chatConversationMap.has(chatId)) {
      return this.#chatConversationMap.get(chatId);
    }

    // 从索引中查找已有的 lark 对话 (通过 title 匹配 chatId)
    try {
      const existing = this.#conversationStore.list({ category: 'lark', limit: 100 });
      const match = existing.find((e: any) => e.title === chatId);
      if (match) {
        this.#chatConversationMap.set(chatId, match.id);
        return match.id;
      }
    } catch {
      // 索引读取失败，继续创建新对话
    }

    // 创建新对话
    try {
      const convId = this.#conversationStore.create({ category: 'lark', title: chatId });
      this.#chatConversationMap.set(chatId, convId);
      return convId;
    } catch (err: any) {
      this.#logger.warn(
        `[LarkTransport] Failed to create conversation for chatId ${chatId}: ${err.message}`
      );
      return null;
    }
  }

  /**
   * 获取指定会话的历史
   */
  #getHistory(chatId: any) {
    // 优先使用 ConversationStore 持久化历史
    const convId = this.#resolveConversationId(chatId);
    if (convId && this.#conversationStore) {
      try {
        return this.#conversationStore.load(convId);
      } catch (err: any) {
        this.#logger.warn(
          `[LarkTransport] ConversationStore load failed, falling back: ${err.message}`
        );
      }
    }
    // 降级到内存
    return this.#conversationHistory.get(chatId) || [];
  }

  /**
   * 获取最近对话的可读文本 (给 IntentClassifier 提供上下文)
   */
  #getRecentHistoryText(chatId: any) {
    const history = this.#getHistory(chatId);
    if (history.length === 0) {
      return '';
    }
    return history
      .slice(-6)
      .map((h: any) => `${h.role}: ${h.content.slice(0, 100)}`)
      .join('\n');
  }

  /**
   * 追加对话记录 (双写: ConversationStore + 内存降级)
   */
  #appendHistory(chatId: any, role: any, content: any) {
    if (!chatId) {
      return;
    }

    // 写入 ConversationStore（持久化）
    const convId = this.#resolveConversationId(chatId);
    if (convId && this.#conversationStore) {
      try {
        this.#conversationStore.append(convId, { role, content });
      } catch (err: any) {
        this.#logger.warn(`[LarkTransport] ConversationStore append failed: ${err.message}`);
      }
    }

    // 始终写入内存 (作为降级备份 + 用于 IntentClassifier 快速上下文)
    if (!this.#conversationHistory.has(chatId)) {
      this.#conversationHistory.set(chatId, []);
    }
    const history = this.#conversationHistory.get(chatId);
    history.push({ role, content });
    // 限制内存历史长度
    if (history.length > LarkTransport.MAX_HISTORY * 2) {
      history.splice(0, history.length - LarkTransport.MAX_HISTORY * 2);
    }
  }

  // ═══════════════════════════════════════════════════
  //  飞书消息发送
  // ═══════════════════════════════════════════════════

  async #reply(messageId: any, text: any) {
    if (this.#replyFn) {
      await this.#replyFn(messageId, text);
    }
  }

  async #send(text: any) {
    if (this.#sendFn) {
      await this.#sendFn(text);
    }
  }
}

export default LarkTransport;
