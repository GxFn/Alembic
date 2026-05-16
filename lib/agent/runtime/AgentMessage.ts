/**
 * AgentMessage — 统一消息信封
 *
 * 核心抽象: Agent 永远不需要知道消息来自哪个渠道。
 * Transport 适配器负责将渠道特定格式转换为 AgentMessage,
 * Agent 只处理 AgentMessage, 通过 replyFn 返回结果。
 *
 * 这是将"飞书聊天"和"前端聊天"统一为同一概念的关键:
 *   - HTTP/SSE (Dashboard)  → AgentMessage { channel: 'http', ... }
 *   - WebSocket (Lark/飞书)  → AgentMessage { channel: 'lark', ... }
 *   - CLI (终端)             → AgentMessage { channel: 'cli',  ... }
 *   - MCP (IDE 扩展)         → AgentMessage { channel: 'mcp',  ... }
 *
 * @module AgentMessage
 */

import { randomUUID } from 'node:crypto';

/** Reply callback type */
type ReplyFn = (text: string) => Promise<void>;

/** Sender identity */
interface Sender {
  id: string;
  name?: string;
  type: 'user' | 'system' | 'agent';
}

/** Session context */
interface Session {
  id: string;
  history?: Array<{ role: string; content: string }>;
}

/** AgentMessage constructor options */
interface AgentMessageOptions {
  content?: string;
  channel?: string;
  session?: Session;
  sender?: Sender;
  metadata?: Record<string, unknown>;
  replyFn?: ReplyFn | null;
}

/** HTTP request body shape */
interface HttpRequestBody {
  prompt?: string;
  message?: string;
  content?: string;
  conversationId?: string;
  sessionId?: string;
  history?: Array<{ role: string; content: string }>;
  userId?: string;
  userName?: string;
  lang?: string;
  mode?: string;
  context?: unknown;
  stream?: boolean;
}

/** Minimal Express-like request */
interface HttpRequest {
  body?: HttpRequestBody;
  ip?: string;
}

/** Lark message shape */
interface LarkMessage {
  text?: string;
  content?: string;
  chatId?: string;
  senderId?: string;
  userId?: string;
  senderName?: string;
  messageId?: string;
  messageType?: string;
  [key: string]: unknown;
}

/** CLI options */
interface CliOptions {
  sessionId?: string;
  history?: Array<{ role: string; content: string }>;
  cwd?: string;
  mode?: string;
  metadata?: Record<string, unknown>;
}

/** Internal message options */
interface InternalMessageOptions {
  session?: Session;
  sessionId?: string;
  history?: Array<{ role: string; content: string }>;
  sourceAgentId?: string;
  parentAgentId?: string;
  dimension?: string;
  phase?: string;
  metadata?: Record<string, unknown>;
  /** Extra pass-through keys (e.g. 'source') */
  [key: string]: unknown;
}

/** MCP request shape */
interface McpRequest {
  prompt?: string;
  content?: string;
  arguments?: Record<string, unknown> & { prompt?: string };
  sessionId?: string;
  history?: Array<{ role: string; content: string }>;
  clientId?: string;
  clientName?: string;
  toolName?: string;
  mode?: string;
  metadata?: Record<string, unknown>;
}

/** 通信渠道枚举 */
export const Channel = Object.freeze({
  HTTP: 'http',
  LARK: 'lark',
  CLI: 'cli',
  MCP: 'mcp',
  INTERNAL: 'internal', // Agent 间通信
});

export class AgentMessage {
  /** 消息唯一 ID */
  id;
  /** 用户输入内容 */
  content;
  /** 通信渠道 */
  channel;
  /** 会话信息 */
  session;
  /** 发送者 */
  sender;
  /** 渠道特定元数据 */
  metadata;
  /** 回复函数 (text: string) => Promise<void> */
  replyFn;
  /** 时间戳 */
  timestamp;

  /**
   * @param opts.content 用户输入
   * @param [opts.channel='http'] 渠道
   * @param [opts.session] 会话
   * @param [opts.sender] 发送者
   * @param [opts.metadata] 元数据
   * @param [opts.replyFn] 回复函数
   */
  constructor({
    content,
    channel = Channel.HTTP,
    session,
    sender,
    metadata,
    replyFn,
  }: AgentMessageOptions = {}) {
    this.id = randomUUID();
    this.content = content || '';
    this.channel = channel;
    this.session = session || { id: randomUUID(), history: [] };
    this.sender = sender || { id: 'anonymous', type: 'user' };
    this.metadata = metadata || {};
    this.replyFn = replyFn || null;
    this.timestamp = Date.now();
  }

  /** 对话历史 (快捷访问) */
  get history() {
    return this.session.history || [];
  }

  /** 向发送方回复 */
  async reply(text: string) {
    if (this.replyFn) {
      await this.replyFn(text);
    }
  }

  // ─── Transport 工厂方法 ─────────────────────

  /**
   * 从 HTTP 请求构建
   * @param req Express request
   * @param [replyFn] SSE 或 JSON 回复
   */
  static fromHttp(req: HttpRequest, replyFn?: ReplyFn) {
    const body = req.body || ({} as HttpRequestBody);
    return new AgentMessage({
      content: body.prompt || body.message || body.content || '',
      channel: Channel.HTTP,
      session: {
        id: body.conversationId || body.sessionId || randomUUID(),
        history: body.history || [],
      },
      sender: {
        id: body.userId || req.ip || 'http-user',
        name: body.userName,
        type: 'user',
      },
      metadata: {
        lang: body.lang,
        mode: body.mode, // 手动指定 preset
        context: body.context, // 额外上下文
        stream: body.stream ?? true,
      },
      replyFn,
    });
  }

  /**
   * 从飞书消息构建
   * @param larkMsg 飞书消息对象
   * @param replyFn 飞书回复函数
   */
  static fromLark(larkMsg: LarkMessage, replyFn?: ReplyFn | null) {
    return new AgentMessage({
      content: larkMsg.text || larkMsg.content || '',
      channel: Channel.LARK,
      session: {
        id: larkMsg.chatId || randomUUID(),
        history: [],
      },
      sender: {
        id: larkMsg.senderId || larkMsg.userId || 'lark-user',
        name: larkMsg.senderName,
        type: 'user',
      },
      metadata: {
        messageId: larkMsg.messageId,
        chatId: larkMsg.chatId,
        messageType: larkMsg.messageType,
        // 飞书特有字段透传
        raw: larkMsg,
      },
      replyFn,
    });
  }

  /**
   * 从 CLI 输入构建
   * @param input 命令行输入
   */
  static fromCli(input: string, opts: CliOptions = {}) {
    return new AgentMessage({
      content: input,
      channel: Channel.CLI,
      session: { id: opts.sessionId || 'cli-session', history: opts.history || [] },
      sender: { id: 'cli-user', type: 'user' },
      metadata: {
        cwd: opts.cwd || process.cwd(),
        mode: opts.mode,
        ...opts.metadata,
      },
    });
  }

  /**
   * Agent 间内部消息
   * @param content 消息内容
   */
  static internal(content: string, opts: InternalMessageOptions = {}) {
    return new AgentMessage({
      content,
      channel: Channel.INTERNAL,
      session: opts.session || { id: opts.sessionId || randomUUID(), history: opts.history || [] },
      sender: {
        id: opts.sourceAgentId || 'system',
        type: 'agent',
      },
      metadata: {
        parentAgentId: opts.parentAgentId,
        dimension: opts.dimension,
        phase: opts.phase,
        ...opts.metadata,
      },
    });
  }

  /**
   * 从 MCP 请求构建
   * @param mcpReq MCP tool call request
   * @param [replyFn] 回复函数
   */
  static fromMcp(mcpReq: McpRequest, replyFn?: ReplyFn) {
    return new AgentMessage({
      content: mcpReq.prompt || mcpReq.content || mcpReq.arguments?.prompt || '',
      channel: Channel.MCP,
      session: {
        id: mcpReq.sessionId || randomUUID(),
        history: mcpReq.history || [],
      },
      sender: {
        id: mcpReq.clientId || 'mcp-client',
        name: mcpReq.clientName,
        type: 'user',
      },
      metadata: {
        toolName: mcpReq.toolName,
        arguments: mcpReq.arguments,
        mode: mcpReq.mode,
        ...mcpReq.metadata,
      },
      replyFn,
    });
  }

  /** 序列化 */
  toJSON() {
    return {
      id: this.id,
      content: this.content,
      channel: this.channel,
      session: { id: this.session.id, historyLength: this.history.length },
      sender: this.sender,
      metadata: this.metadata,
      timestamp: this.timestamp,
    };
  }
}

export default AgentMessage;
