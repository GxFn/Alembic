/**
 * MessageAdapter — 统一消息操作接口
 *
 * 消除 reactLoop 内的 useCtxWin 双模式分支:
 *   - ContextWindowAdapter: 委托给 ContextWindow 实例 (bootstrap/system 场景)
 *   - SimpleArrayAdapter: 裸数组模式 (对话场景)
 *
 * 两个实现对外暴露完全相同的 API，
 * 使得 reactLoop 及其提取方法无需关心底层消息存储方式。
 *
 * @module core/MessageAdapter
 */

import { isToolResultEnvelope } from '#tools/core/ToolResultPresenter.js';
import type { ContextWindow } from '../context/ContextWindow.js';
import { limitToolResult } from '../context/ContextWindow.js';

/** 工具调用记录 */
interface ToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** 聊天消息 */
interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoningContent?: string | null;
  toolCalls?: ToolCallRecord[];
  toolCallId?: string;
  name?: string;
}

// ─────────────────────────────────────────────
//  Base class (接口定义 + JSDoc)
// ─────────────────────────────────────────────

/** @abstract */
export class MessageAdapter {
  /** 追加用户消息 */
  appendUserMessage(_text: string) {
    throw new Error('not implemented');
  }

  /** 追加助手纯文本回复 */
  appendAssistantText(_text: string, _reasoningContent?: string | null) {
    throw new Error('not implemented');
  }

  /**
   * 追加助手带工具调用的回复
   * @param _calls functionCalls 数组
   * @param _reasoningContent DeepSeek V4 推理内容（可选）
   */
  appendAssistantWithToolCalls(
    _text: string | null,
    _calls: ToolCallRecord[],
    _reasoningContent?: string | null
  ) {
    throw new Error('not implemented');
  }

  /** 追加工具执行结果 */
  appendToolResult(_callId: string, _name: string, _content: string) {
    throw new Error('not implemented');
  }

  /** 追加系统/用户 nudge 消息 */
  appendUserNudge(_text: string) {
    throw new Error('not implemented');
  }

  /**
   * 导出当前消息列表 (供 LLM 调用)
   * @returns >}
   */
  toMessages(): unknown[] {
    throw new Error('not implemented');
  }

  /** 重置到仅保留初始 prompt (错误恢复) */
  resetToPromptOnly() {
    throw new Error('not implemented');
  }

  /**
   * 获取工具结果限额
   * @returns }
   */
  getToolResultQuota(): { maxChars: number; maxMatches: number } {
    throw new Error('not implemented');
  }

  /**
   * 压缩检查 — 如果消息过多则自动压缩
   * @returns }
   */
  compactIfNeeded(): { level: number; removed: number } {
    throw new Error('not implemented');
  }

  /**
   * 格式化工具结果字符串 (统一 limitToolResult 调用)
   * @param rawResult 工具原始返回值
   */
  formatToolResult(toolName: string, rawResult: unknown) {
    const quota = this.getToolResultQuota();
    if (isToolResultEnvelope(rawResult)) {
      return limitToolResult(toolName, rawResult.text, quota);
    }
    return limitToolResult(toolName, rawResult, quota);
  }
}

// ─────────────────────────────────────────────
//  ContextWindowAdapter — 委托给 ContextWindow
// ─────────────────────────────────────────────

/**
 * 委托所有消息操作给 ContextWindow 实例。
 *
 * 用于 bootstrap / system 场景，
 * ContextWindow 提供三级递进压缩 + 动态 token 预算。
 */
export class ContextWindowAdapter extends MessageAdapter {
  #ctxWin;

  constructor(ctxWin: ContextWindow) {
    super();
    this.#ctxWin = ctxWin;
  }

  /** 获取底层 ContextWindow 实例 (供 forced-summary 等外部逻辑使用) */
  get contextWindow() {
    return this.#ctxWin;
  }

  appendUserMessage(text: string) {
    this.#ctxWin.appendUserMessage(text);
  }

  appendAssistantText(text: string, reasoningContent?: string | null) {
    this.#ctxWin.appendAssistantText(text, reasoningContent);
  }

  appendAssistantWithToolCalls(
    text: string | null,
    calls: ToolCallRecord[],
    reasoningContent?: string | null
  ) {
    this.#ctxWin.appendAssistantWithToolCalls(text, calls, reasoningContent);
  }

  appendToolResult(callId: string, name: string, content: string) {
    this.#ctxWin.appendToolResult(callId, name, content);
  }

  appendUserNudge(text: string) {
    this.#ctxWin.appendUserNudge(text);
  }

  toMessages() {
    return this.#ctxWin.toMessages();
  }

  resetToPromptOnly() {
    this.#ctxWin.resetToPromptOnly();
  }

  getToolResultQuota() {
    return this.#ctxWin.getToolResultQuota();
  }

  compactIfNeeded() {
    return this.#ctxWin.compactIfNeeded();
  }
}

// ─────────────────────────────────────────────
//  SimpleArrayAdapter — 裸数组模式
// ─────────────────────────────────────────────

/**
 * 简单数组消息管理 — 对话场景。
 *
 * 不做任何压缩，getToolResultQuota 返回固定 8000。
 * compactIfNeeded 始终返回 no-op。
 */
export class SimpleArrayAdapter extends MessageAdapter {
  #messages: ChatMessage[] = [];

  appendUserMessage(text: string) {
    this.#messages.push({ role: 'user', content: text });
  }

  appendAssistantText(text: string, reasoningContent?: string | null) {
    const msg: ChatMessage = { role: 'assistant', content: text };
    if (reasoningContent != null) {
      msg.reasoningContent = reasoningContent;
    }
    this.#messages.push(msg);
  }

  appendAssistantWithToolCalls(
    text: string | null,
    calls: ToolCallRecord[],
    reasoningContent?: string | null
  ) {
    const msg: ChatMessage = {
      role: 'assistant',
      content: text,
      toolCalls: calls,
      reasoningContent: reasoningContent ?? '',
    };
    this.#messages.push(msg);
  }

  appendToolResult(callId: string, name: string, content: string) {
    this.#messages.push({ role: 'tool', toolCallId: callId, name, content });
  }

  appendUserNudge(text: string) {
    this.#messages.push({ role: 'user', content: text });
  }

  toMessages() {
    return [...this.#messages];
  }

  resetToPromptOnly() {
    const first = this.#messages[0];
    this.#messages.length = 0;
    if (first) {
      this.#messages.push(first);
    }
  }

  getToolResultQuota() {
    return { maxChars: 8000, maxMatches: 20 };
  }

  compactIfNeeded() {
    return { level: 0, removed: 0 };
  }
}

// ─────────────────────────────────────────────
//  Factory helper
// ─────────────────────────────────────────────

/** 根据是否提供 contextWindow 创建对应适配器 */
export function createMessageAdapter(contextWindow: ContextWindow | null | undefined) {
  if (contextWindow) {
    return new ContextWindowAdapter(contextWindow);
  }
  return new SimpleArrayAdapter();
}
