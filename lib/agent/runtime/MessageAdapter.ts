import type {
  RuntimeChatMessage,
  RuntimeToolCallRecord,
  ToolCallEntry,
} from "./AgentRuntimeTypes.js";

export interface RuntimeContextWindowLike {
  appendUserMessage(text: string): void;
  appendAssistantText(text: string, reasoningContent?: string | null): void;
  appendAssistantWithToolCalls(
    text: string | null,
    calls: readonly RuntimeToolCallRecord[],
    reasoningContent?: string | null,
  ): void;
  appendToolResult(callId: string, name: string, content: string): void;
  appendUserNudge?(text: string): void;
  toMessages(): unknown[];
  toProjectedMessages?(): unknown[];
  resetToPromptOnly(): void;
  getToolResultQuota?(): { readonly maxChars: number; readonly maxMatches: number };
  compactIfNeeded?(): { readonly level: number; readonly removed: number };
}

export abstract class MessageAdapter {
  abstract appendUserMessage(text: string): void;

  abstract appendAssistantText(text: string, reasoningContent?: string | null): void;

  abstract appendAssistantWithToolCalls(
    text: string | null,
    calls: readonly RuntimeToolCallRecord[],
    reasoningContent?: string | null,
  ): void;

  abstract appendToolResult(callId: string, name: string, content: string): void;

  abstract appendUserNudge(text: string): void;

  abstract toMessages(): unknown[];

  toProjectedMessages(): unknown[] {
    return this.toMessages();
  }

  abstract resetToPromptOnly(): void;

  abstract getToolResultQuota(): { readonly maxChars: number; readonly maxMatches: number };

  abstract compactIfNeeded(): { readonly level: number; readonly removed: number };

  formatToolResult(toolName: string, rawResult: unknown): string {
    const quota = this.getToolResultQuota();
    const value = isToolResultEnvelopeLike(rawResult)
      ? (rawResult.text ?? rawResult.data ?? rawResult.error)
      : rawResult;
    return limitToolResult(toolName, value, quota);
  }
}

export class ContextWindowAdapter extends MessageAdapter {
  readonly #ctxWin: RuntimeContextWindowLike;

  constructor(ctxWin: RuntimeContextWindowLike) {
    super();
    this.#ctxWin = ctxWin;
  }

  get contextWindow(): RuntimeContextWindowLike {
    return this.#ctxWin;
  }

  appendUserMessage(text: string): void {
    this.#ctxWin.appendUserMessage(text);
  }

  appendAssistantText(text: string, reasoningContent?: string | null): void {
    this.#ctxWin.appendAssistantText(text, reasoningContent);
  }

  appendAssistantWithToolCalls(
    text: string | null,
    calls: readonly RuntimeToolCallRecord[],
    reasoningContent?: string | null,
  ): void {
    this.#ctxWin.appendAssistantWithToolCalls(text, calls, reasoningContent);
  }

  appendToolResult(callId: string, name: string, content: string): void {
    this.#ctxWin.appendToolResult(callId, name, content);
  }

  appendUserNudge(text: string): void {
    if (this.#ctxWin.appendUserNudge) {
      this.#ctxWin.appendUserNudge(text);
      return;
    }
    this.#ctxWin.appendUserMessage(text);
  }

  toMessages(): unknown[] {
    return this.#ctxWin.toMessages();
  }

  override toProjectedMessages(): unknown[] {
    return this.#ctxWin.toProjectedMessages?.() ?? this.#ctxWin.toMessages();
  }

  resetToPromptOnly(): void {
    this.#ctxWin.resetToPromptOnly();
  }

  getToolResultQuota(): { readonly maxChars: number; readonly maxMatches: number } {
    return this.#ctxWin.getToolResultQuota?.() ?? { maxChars: 8000, maxMatches: 20 };
  }

  compactIfNeeded(): { readonly level: number; readonly removed: number } {
    return this.#ctxWin.compactIfNeeded?.() ?? { level: 0, removed: 0 };
  }
}

export class SimpleArrayAdapter extends MessageAdapter {
  readonly #messages: RuntimeChatMessage[] = [];

  appendUserMessage(text: string): void {
    this.#messages.push({ role: "user", content: text });
  }

  appendAssistantText(text: string, reasoningContent?: string | null): void {
    this.#messages.push({
      role: "assistant",
      content: text,
      ...(reasoningContent != null ? { reasoningContent } : {}),
    });
  }

  appendAssistantWithToolCalls(
    text: string | null,
    calls: readonly RuntimeToolCallRecord[],
    reasoningContent?: string | null,
  ): void {
    this.#messages.push({
      role: "assistant",
      content: text,
      toolCalls: calls.map((call) => ({ ...call, args: { ...call.args } })),
      ...(reasoningContent != null ? { reasoningContent } : {}),
    });
  }

  appendToolResult(callId: string, name: string, content: string): void {
    this.#messages.push({ role: "tool", toolCallId: callId, name, content });
  }

  appendUserNudge(text: string): void {
    this.#messages.push({ role: "user", content: text });
  }

  toMessages(): RuntimeChatMessage[] {
    return this.#messages.map(cloneMessage);
  }

  resetToPromptOnly(): void {
    const first = this.#messages[0];
    this.#messages.length = 0;
    if (first) {
      this.#messages.push(first);
    }
  }

  getToolResultQuota(): { readonly maxChars: number; readonly maxMatches: number } {
    return { maxChars: 8000, maxMatches: 20 };
  }

  compactIfNeeded(): { readonly level: number; readonly removed: number } {
    return { level: 0, removed: 0 };
  }
}

export function createMessageAdapter(contextWindow: unknown): MessageAdapter {
  return isContextWindowLike(contextWindow)
    ? new ContextWindowAdapter(contextWindow)
    : new SimpleArrayAdapter();
}

export function formatToolCallHistory(entries: readonly ToolCallEntry[]): string {
  if (entries.length === 0) {
    return "没有工具调用记录。";
  }
  return entries
    .map((entry, index) => {
      const output = limitString(stringify(entry.result), 1200);
      return `#${index + 1} ${entry.tool}\nargs: ${stringify(entry.args)}\nresult: ${output}`;
    })
    .join("\n\n");
}

function isContextWindowLike(value: unknown): value is RuntimeContextWindowLike {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<RuntimeContextWindowLike>;
  return (
    typeof candidate.appendUserMessage === "function" &&
    typeof candidate.appendAssistantText === "function" &&
    typeof candidate.appendAssistantWithToolCalls === "function" &&
    typeof candidate.appendToolResult === "function" &&
    typeof candidate.toMessages === "function" &&
    typeof candidate.resetToPromptOnly === "function"
  );
}

function isToolResultEnvelopeLike(value: unknown): value is {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly text?: string;
  readonly error?: unknown;
} {
  return (
    !!value &&
    typeof value === "object" &&
    "ok" in value &&
    "status" in value &&
    ("data" in value || "error" in value)
  );
}

function limitToolResult(
  toolName: string,
  value: unknown,
  quota: { readonly maxChars: number; readonly maxMatches: number },
): string {
  const text = limitString(stringify(value), quota.maxChars);
  return text.length === 0 ? `[${toolName}] 工具没有返回内容。` : text;
}

function limitString(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 80))}\n...[truncated ${text.length - maxChars} chars]`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function cloneMessage(message: RuntimeChatMessage): RuntimeChatMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.reasoningContent !== undefined
      ? { reasoningContent: message.reasoningContent }
      : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.name ? { name: message.name } : {}),
    ...(message.toolCalls
      ? { toolCalls: message.toolCalls.map((call) => ({ ...call, args: { ...call.args } })) }
      : {}),
  };
}
