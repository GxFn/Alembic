import { randomUUID } from "node:crypto";
import type {
  AgentMessageLike,
  AgentMessageSender,
  AgentMessageSession,
} from "./AgentRuntimeTypes.js";

export const Channel = Object.freeze({
  HTTP: "http",
  LARK: "lark",
  CLI: "cli",
  MCP: "mcp",
  INTERNAL: "internal",
} as const);

type ReplyFn = (text: string) => void | Promise<void>;

interface AgentMessageOptions {
  readonly content?: string;
  readonly channel?: string;
  readonly session?: AgentMessageSession;
  readonly sender?: AgentMessageSender;
  readonly metadata?: Record<string, unknown>;
  readonly replyFn?: ReplyFn | null;
}

interface HttpRequestBody {
  readonly prompt?: string;
  readonly message?: string;
  readonly content?: string;
  readonly conversationId?: string;
  readonly sessionId?: string;
  readonly history?: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  readonly userId?: string;
  readonly userName?: string;
  readonly lang?: string;
  readonly mode?: string;
  readonly context?: unknown;
  readonly stream?: boolean;
}

interface HttpRequest {
  readonly body?: HttpRequestBody;
  readonly ip?: string;
}

interface LarkMessage {
  readonly text?: string;
  readonly content?: string;
  readonly chatId?: string;
  readonly senderId?: string;
  readonly userId?: string;
  readonly senderName?: string;
  readonly messageId?: string;
  readonly messageType?: string;
  readonly [key: string]: unknown;
}

interface CliOptions {
  readonly sessionId?: string;
  readonly history?: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  readonly cwd?: string;
  readonly mode?: string;
  readonly metadata?: Record<string, unknown>;
}

interface InternalMessageOptions {
  readonly session?: AgentMessageSession;
  readonly sessionId?: string;
  readonly history?: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  readonly sourceAgentId?: string;
  readonly parentAgentId?: string;
  readonly dimension?: string;
  readonly phase?: string;
  readonly metadata?: Record<string, unknown>;
}

interface McpRequest {
  readonly prompt?: string;
  readonly content?: string;
  readonly arguments?: Record<string, unknown> & { readonly prompt?: string };
  readonly sessionId?: string;
  readonly history?: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  readonly clientId?: string;
  readonly clientName?: string;
  readonly toolName?: string;
  readonly mode?: string;
  readonly metadata?: Record<string, unknown>;
}

export class AgentMessage implements AgentMessageLike {
  readonly id: string;
  readonly content: string;
  readonly channel: string;
  readonly session: AgentMessageSession;
  readonly sender: AgentMessageSender;
  readonly metadata: Record<string, unknown>;
  readonly replyFn: ReplyFn | null;
  readonly timestamp: number;

  constructor({
    content,
    channel = Channel.HTTP,
    session,
    sender,
    metadata,
    replyFn,
  }: AgentMessageOptions = {}) {
    this.id = randomUUID();
    this.content = content ?? "";
    this.channel = channel;
    this.session = session ?? { id: randomUUID(), history: [] };
    this.sender = sender ?? { id: "anonymous", type: "user" };
    this.metadata = metadata ?? {};
    this.replyFn = replyFn ?? null;
    this.timestamp = Date.now();
  }

  get history(): ReadonlyArray<{ readonly role: string; readonly content: string }> {
    return this.session.history ?? [];
  }

  async reply(text: string): Promise<void> {
    await this.replyFn?.(text);
  }

  static fromHttp(req: HttpRequest, replyFn?: ReplyFn): AgentMessage {
    const body = req.body ?? {};
    return new AgentMessage({
      content: body.prompt ?? body.message ?? body.content ?? "",
      channel: Channel.HTTP,
      session: {
        id: body.conversationId ?? body.sessionId ?? randomUUID(),
        history: body.history ?? [],
      },
      sender: {
        id: body.userId ?? req.ip ?? "http-user",
        ...(body.userName ? { name: body.userName } : {}),
        type: "user",
      },
      metadata: {
        lang: body.lang,
        mode: body.mode,
        context: body.context,
        stream: body.stream ?? true,
      },
      ...(replyFn ? { replyFn } : {}),
    });
  }

  static fromLark(larkMsg: LarkMessage, replyFn?: ReplyFn | null): AgentMessage {
    return new AgentMessage({
      content: larkMsg.text ?? larkMsg.content ?? "",
      channel: Channel.LARK,
      session: { id: larkMsg.chatId ?? randomUUID(), history: [] },
      sender: {
        id: larkMsg.senderId ?? larkMsg.userId ?? "lark-user",
        ...(larkMsg.senderName ? { name: larkMsg.senderName } : {}),
        type: "user",
      },
      metadata: {
        messageId: larkMsg.messageId,
        chatId: larkMsg.chatId,
        messageType: larkMsg.messageType,
        raw: larkMsg,
      },
      ...(replyFn ? { replyFn } : {}),
    });
  }

  static fromCli(input: string, opts: CliOptions = {}): AgentMessage {
    return new AgentMessage({
      content: input,
      channel: Channel.CLI,
      session: { id: opts.sessionId ?? "cli-session", history: opts.history ?? [] },
      sender: { id: "cli-user", type: "user" },
      metadata: {
        cwd: opts.cwd ?? process.cwd(),
        mode: opts.mode,
        ...opts.metadata,
      },
    });
  }

  static internal(content: string, opts: InternalMessageOptions = {}): AgentMessage {
    return new AgentMessage({
      content,
      channel: Channel.INTERNAL,
      session: opts.session ?? { id: opts.sessionId ?? randomUUID(), history: opts.history ?? [] },
      sender: { id: opts.sourceAgentId ?? "system", type: "agent" },
      metadata: {
        parentAgentId: opts.parentAgentId,
        dimension: opts.dimension,
        phase: opts.phase,
        ...opts.metadata,
      },
    });
  }

  static fromMcp(mcpReq: McpRequest, replyFn?: ReplyFn): AgentMessage {
    return new AgentMessage({
      content: mcpReq.prompt ?? mcpReq.content ?? mcpReq.arguments?.prompt ?? "",
      channel: Channel.MCP,
      session: { id: mcpReq.sessionId ?? randomUUID(), history: mcpReq.history ?? [] },
      sender: {
        id: mcpReq.clientId ?? "mcp-client",
        ...(mcpReq.clientName ? { name: mcpReq.clientName } : {}),
        type: "user",
      },
      metadata: {
        toolName: mcpReq.toolName,
        arguments: mcpReq.arguments,
        mode: mcpReq.mode,
        ...mcpReq.metadata,
      },
      ...(replyFn ? { replyFn } : {}),
    });
  }

  toJSON(): Record<string, unknown> {
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
