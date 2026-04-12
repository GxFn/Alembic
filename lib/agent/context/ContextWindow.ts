/**
 * ContextWindow — Agent 的上下文窗口管理器
 *
 * 业界最佳实践:
 *   - OpenAI Compaction: 阈值触发自动压缩，保留关键上下文
 *   - LangChain trim_messages: 按 token 裁剪，保证消息合法性
 *   - Anthropic 长上下文: 长文档前置，查询后置
 *   - Gemini API: functionResponse 必须紧跟 functionCall
 *
 * 设计不变量:
 *   1. messages[0] 始终是原始 user prompt（不可删除）
 *   2. assistant(toolCalls) 与其 tool results 是原子单元（不可拆分）
 *   3. 每次 AI 调用前自动压缩到 TOKEN_BUDGET 以内
 *   4. 不通过追加 user 消息来控制 AI 行为（由 ExplorationTracker 管理）
 *
 * 三级递进压缩:
 *   L1 (60-80%): 截断旧的 tool results 内容
 *   L2 (80-95%): 摘要历史轮次，保留最后 2 轮完整链
 *   L3 (>95%):  仅保留 prompt + 最后 1 轮 + 已提交列表
 *
 * @module ContextWindow
 */

import Logger from '#infra/logging/Logger.js';
import { estimateTokensFast } from '#shared/token-utils.js';

// ─── 类型定义 ──────────────────────────────────────────

/** 工具调用信息 */
interface ToolCallInfo {
  id: string;
  name: string;
  args?: Record<string, unknown>;
}

/** 上下文窗口中的消息 */
export interface ContextMessage {
  role: 'user' | 'assistant' | 'tool';
  content?: string | null;
  toolCalls?: ToolCallInfo[];
  toolCallId?: string;
  name?: string;
}

/** 搜索结果匹配项 */
interface SearchMatch {
  file?: string;
  line?: number;
  code?: string;
  context?: string;
  score?: number;
  lines?: string[];
  _truncated?: boolean;
}

/** 搜索结果对象 */
interface SearchResultLike {
  matches?: SearchMatch[];
  batchResults?: Record<string, SearchResultLike>;
  total?: number;
  searchedFiles?: number;
  _note?: string;
  _raw?: string;
}

/** 文件内容结果对象 */
interface FileResultLike {
  content?: string;
  batchResults?: Record<string, FileResultLike>;
}

/** 工具结果配额 */
interface ToolResultQuota {
  maxChars?: number;
  maxMatches?: number;
}

/**
 * 一组相关消息的原子单元:
 * - assistant(toolCalls) + 所有后续 tool results
 * - 或单独的 user/assistant 文本消息
 */

export class ContextWindow {
  /** 统一格式消息 */
  #messages: ContextMessage[] = [];
  /** token 预算（默认 24000，约对应 Gemini 的安全阈值） */
  #tokenBudget;
  /** 被压缩掉的轮次摘要（用于 digest 生成） */
  #compactionLog: string[] = [];
  /** 被压缩前提取的已提交候选标题 */
  #compactedSubmits = new Set();
  /** 日志器 */
  #logger;

  /**
   * 模型名 → 上下文窗口大小映射（token 数）。
   * 键为正则模式，按优先级从上到下匹配。
   * 值为模型的原始上下文窗口上限。
   */
  static MODEL_CONTEXT_WINDOWS = [
    // ── Google Gemini ──
    [/gemini-3/i, 1_000_000],
    [/gemini-2\.5/i, 1_000_000],
    [/gemini-2/i, 1_000_000],
    [/gemini-1\.5-pro/i, 1_000_000],
    [/gemini-1\.5-flash/i, 1_000_000],
    [/gemini-1\.0/i, 32_000],
    [/gemini/i, 1_000_000], // 未知版本回退
    // ── OpenAI ──
    [/gpt-5\.4-(?:mini|nano)/i, 400_000],
    [/gpt-5/i, 1_000_000],
    [/gpt-4o/i, 128_000],
    [/gpt-4-turbo/i, 128_000],
    [/gpt-4-(?!turbo)/i, 8_192],
    [/gpt-3\.5-turbo-16k/i, 16_384],
    [/gpt-3\.5/i, 4_096],
    [/o1|o3|o4/i, 200_000], // OpenAI reasoning models
    // ── Anthropic ──
    [/claude-(?:opus|sonnet)-4[.-]6/i, 1_000_000], // Opus 4.6 / Sonnet 4.6
    [/claude-.*sonnet-4/i, 200_000],
    [/claude-3[.-]5/i, 200_000],
    [/claude-3[.-]opus/i, 200_000],
    [/claude-3/i, 200_000],
    [/claude/i, 200_000], // 未知 claude 回退
    // ── DeepSeek ──
    [/deepseek/i, 64_000],
    // ── 本地 Ollama ──
    [/llama3[.-]?[23]/i, 128_000],
    [/llama3/i, 8_192],
    [/llama/i, 4_096],
    [/mistral/i, 32_000],
    [/qwen/i, 128_000],
    [/phi/i, 128_000],
    // ── Mock（测试） ──
    [/mock/i, 32_000],
  ];

  /**
   * 根据模型名称解析合适的 ContextWindow token 预算。
   *
   * 策略: 取模型最大上下文窗口的一个安全分片，
   *   - 超大窗口 (≥400k): 预算 48000（1M 级模型可容纳更多上下文）
   *   - 大窗口 (≥200k): 预算 32000（tool schemas + system prompt 占显著空间）
   *   - 中窗口 (≥64k):  预算 24000
   *   - 小窗口 (≥16k):  预算 12000
   *   - 微窗口 (<16k):  预算 = 窗口 × 0.7（留 30% 给 prompt/tool schema）
   *
   * @param modelName 模型名称，如 'gemini-3-flash-preview', 'gpt-5.4-mini'
   * @param [opts] - isSystem 为 true 时给予更高预算
   * @returns 建议的 token 预算
   */
  static resolveTokenBudget(modelName: string, opts: { isSystem?: boolean } = {}) {
    const { isSystem = false } = opts;

    // 1. 查找模型上下文窗口大小
    let contextSize = 32_000; // 默认回退值
    if (modelName) {
      for (const [pattern, size] of ContextWindow.MODEL_CONTEXT_WINDOWS) {
        if ((pattern as RegExp).test(modelName)) {
          contextSize = size as number;
          break;
        }
      }
    }

    // 2. 按分级策略计算 token 预算
    let budget: number;
    if (contextSize >= 400_000) {
      budget = isSystem ? 48_000 : 36_000;
    } else if (contextSize >= 200_000) {
      budget = isSystem ? 32_000 : 24_000;
    } else if (contextSize >= 64_000) {
      budget = isSystem ? 24_000 : 20_000;
    } else if (contextSize >= 16_000) {
      budget = isSystem ? 14_000 : 12_000;
    } else {
      budget = Math.floor(contextSize * (isSystem ? 0.75 : 0.65));
    }

    return budget;
  }

  /** @param [tokenBudget=24000] token 预算上限 */
  constructor(tokenBudget = 24000) {
    this.#tokenBudget = tokenBudget;
    this.#logger = Logger.getInstance();
  }

  // ─── 消息添加 API ──────────────────────────────────────

  /** 追加用户消息 */
  appendUserMessage(content: string) {
    this.#messages.push({ role: 'user', content });
  }

  /**
   * 追加阶段过渡引导消息 — 轻量级 user 消息，用于在 ExplorationTracker 阶段转换时
   * 向 AI 明确传达新阶段的行为期望。与 appendUserMessage 功能相同，
   * 独立命名以便审计和搜索。
   */
  appendUserNudge(content: string) {
    this.#messages.push({ role: 'user', content });
  }

  /**
   * 追加 assistant 消息（含工具调用）
   * @param text assistant 文本
   * @param toolCalls [{id, name, args}]
   */
  appendAssistantWithToolCalls(text: string | null, toolCalls: ToolCallInfo[]) {
    this.#messages.push({
      role: 'assistant',
      content: text || null,
      toolCalls,
    });
  }

  /**
   * 追加工具结果（必须紧跟 assistant toolCalls 后）
   * @param name 工具名
   * @param content 工具返回内容（已经过 ToolResultLimiter 截断）
   */
  appendToolResult(toolCallId: string, name: string, content: string) {
    this.#messages.push({
      role: 'tool',
      toolCallId,
      name,
      content,
    });
  }

  /** 追加 assistant 纯文本消息（无工具调用） */
  appendAssistantText(text: string) {
    this.#messages.push({
      role: 'assistant',
      content: text,
    });
  }

  // ─── 压缩 API ─────────────────────────────────────────

  /**
   * 在每次 AI 调用前调用 — 根据 token 使用率执行分级压缩
   *
   * @returns } 压缩结果
   */
  compactIfNeeded() {
    const usage = this.getTokenUsageRatio();

    if (usage < 0.6 || this.#messages.length <= 4) {
      return { level: 0, removed: 0 };
    }

    if (usage < 0.8) {
      return this.#compactL1();
    }

    if (usage < 0.95) {
      return this.#compactL2();
    }

    return this.#compactL3();
  }

  /**
   * L1 压缩: 截断旧轮次的工具结果内容
   * 仅缩短 text 长度，不删除消息
   */
  #compactL1() {
    const TRUNCATE_THRESHOLD = 2000; // 超过此长度的 tool result 截断
    const TRUNCATE_TO = 500;
    let truncated = 0;

    // 找到最后一个 assistant-with-toolCalls 的位置
    const lastRoundStart = this.#findLastToolRoundStart();
    if (lastRoundStart < 0) {
      return { level: 1, removed: 0 };
    }

    // 只截断 lastRoundStart 之前的 tool results
    for (let i = 1; i < lastRoundStart; i++) {
      const msg = this.#messages[i];
      if (msg.role === 'tool' && msg.content && msg.content.length > TRUNCATE_THRESHOLD) {
        msg.content = `${msg.content.substring(0, TRUNCATE_TO)}\n... [truncated from ${msg.content.length} chars]`;
        truncated++;
      }
    }

    if (truncated > 0) {
      this.#logger.info(`[ContextWindow] L1 compact: truncated ${truncated} tool results`);
    }
    return { level: 1, removed: truncated };
  }

  /**
   * L2 压缩: 删除历史轮次，保留 prompt + 摘要 + 最后 2 轮完整链
   * 1. 找到倒数第 2 轮 assistant(toolCalls) 的起始位置
   * 2. 提取 messages[1..start-1] 中的已提交候选
   * 3. 用精简的摘要占位替换
   */
  #compactL2() {
    // 找到倒数第 2 个 tool round 的起始（保留最后 2 轮）
    const roundStarts = this.#findAllToolRoundStarts();
    if (roundStarts.length < 2) {
      return { level: 2, removed: 0 };
    }

    const keepFrom = roundStarts[roundStarts.length - 2]; // 保留从倒数第 2 轮开始
    if (keepFrom <= 1) {
      return { level: 2, removed: 0 };
    }

    return this.#spliceAndSummarize(keepFrom, 2);
  }

  /** L3 压缩: 激进模式 — 仅保留 prompt + 最后 1 轮 */
  #compactL3() {
    const lastRoundStart = this.#findLastToolRoundStart();
    if (lastRoundStart <= 1) {
      // 没有 tool round，保留 prompt + 最后一条消息
      if (this.#messages.length > 3) {
        const removed = this.#messages.splice(1, this.#messages.length - 2);
        this.#compactionLog.push(`L3: removed ${removed.length} messages (no tool rounds)`);
        return { level: 3, removed: removed.length };
      }
      return { level: 3, removed: 0 };
    }

    return this.#spliceAndSummarize(lastRoundStart, 3);
  }

  /**
   * 执行 splice + summarize（L2/L3 共用）
   * @param keepFrom 保留的消息起始位置
   * @param level 压缩级别
   *
   * ⚠ 注意：此方法在 messages[1] 插入 role='user' 摘要，
   *   与 messages[0]（也是 user）形成连续同角色消息。
   *   Provider 层（GoogleGeminiProvider / ClaudeProvider）的 #convertMessages
   *   已通过 pushOrMerge 自动合并连续同角色消息来处理此情况。
   */
  #spliceAndSummarize(keepFrom: number, level: number) {
    const removed = this.#messages.slice(1, keepFrom);

    // 从被移除的消息中提取已提交候选标题
    for (const m of removed) {
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) {
          if (tc.name === 'submit_knowledge' || tc.name === 'submit_with_check') {
            this.#compactedSubmits.add(tc.args?.title || tc.args?.category || 'untitled');
          }
        }
      }
    }

    // 计算历史统计
    const toolCallCount = removed.filter((m) => m.role === 'assistant' && m.toolCalls).length;
    const toolResultCount = removed.filter((m) => m.role === 'tool').length;

    // Splice: 移除 messages[1..keepFrom-1]
    this.#messages.splice(1, keepFrom - 1);

    // 插入精简摘要（不包含控制指令）
    const summaryParts = [
      `[Context compressed: ${toolCallCount} tool rounds, ${toolResultCount} results removed]`,
    ];
    if (this.#compactedSubmits.size > 0) {
      summaryParts.push(`[Submitted candidates: ${[...this.#compactedSubmits].join(', ')}]`);
    }

    this.#messages.splice(1, 0, {
      role: 'user',
      content: summaryParts.join('\n'),
    });

    const removedCount = keepFrom - 1;
    this.#compactionLog.push(
      `L${level}: removed ${removedCount} messages (${toolCallCount} rounds)`
    );
    this.#logger.info(
      `[ContextWindow] L${level} compact: removed ${removedCount} messages, kept last ${level === 2 ? 2 : 1} rounds`
    );

    return { level, removed: removedCount };
  }

  // ─── 查询 API ─────────────────────────────────────────

  /** 导出消息（供 AI Provider 使用） */
  toMessages() {
    return this.#messages;
  }

  /** 获取消息数量 */
  get length() {
    return this.#messages.length;
  }

  /** 获取 token 预算 */
  get tokenBudget() {
    return this.#tokenBudget;
  }

  /** 估算当前 token 使用量 */
  estimateTokens() {
    let total = 0;
    for (const m of this.#messages) {
      if (m.content) {
        total += estimateTokensFast(m.content);
      }
      if (m.toolCalls) {
        total += estimateTokensFast(JSON.stringify(m.toolCalls));
      }
    }
    return total;
  }

  /** 获取 token 使用率 (0-1) */
  getTokenUsageRatio() {
    return this.estimateTokens() / this.#tokenBudget;
  }

  /**
   * 获取动态工具结果配额
   * 根据当前 token 使用率返回工具结果的大小限制
   * @returns }
   */
  getToolResultQuota() {
    const usage = this.getTokenUsageRatio();
    if (usage < 0.4) {
      return { maxChars: 6000, maxMatches: 15 };
    }
    if (usage < 0.6) {
      return { maxChars: 3000, maxMatches: 8 };
    }
    if (usage < 0.8) {
      return { maxChars: 1500, maxMatches: 5 };
    }
    return { maxChars: 800, maxMatches: 3 };
  }

  /** 获取压缩日志（用于调试） */
  getCompactionLog() {
    return [...this.#compactionLog];
  }

  /** 获取被压缩掉的已提交候选标题 */
  getCompactedSubmits() {
    return new Set(this.#compactedSubmits);
  }

  /**
   * 清空消息 — 仅保留首条 prompt
   * 用于致命错误后的恢复
   */
  resetToPromptOnly() {
    if (this.#messages.length > 1) {
      // 提取所有已提交候选
      this.#extractCompactedSubmits(1);
      this.#messages.length = 1;
      this.#compactionLog.push(`RESET: cleared all messages except prompt`);
    }
  }

  /**
   * Pipeline 阶段隔离 — 清空全部消息。
   *
   * 用于 PipelineStrategy 在阶段间重置 ContextWindow：
   *   analyze → (reset) → produce
   *
   * reactLoop 会将新阶段的 prompt 追加为 messages[0]，
   * systemPrompt 通过 chatWithTools 参数独立传递，不受影响。
   *
   * 保留 compactedSubmits 以支持跨阶段提交去重。
   */
  resetForNewStage() {
    this.#extractCompactedSubmits(0);
    this.#messages = [];
    this.#compactionLog.push('RESET_STAGE: cleared all messages for new pipeline stage');
  }

  /**
   * 从消息中提取已提交候选到 compactedSubmits
   * @param fromIdx 从哪个索引开始扫描
   */
  #extractCompactedSubmits(fromIdx: number) {
    for (let i = fromIdx; i < this.#messages.length; i++) {
      const m = this.#messages[i];
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) {
          if (tc.name === 'submit_knowledge' || tc.name === 'submit_with_check') {
            this.#compactedSubmits.add(tc.args?.title || tc.args?.category || 'untitled');
          }
        }
      }
    }
  }

  // ─── 内部方法 ──────────────────────────────────────────

  /**
   * 找到最后一个 assistant(toolCalls) 的位置
   * @returns 位置索引，-1 表示找不到
   */
  #findLastToolRoundStart() {
    for (let i = this.#messages.length - 1; i >= 1; i--) {
      if (
        this.#messages[i].role === 'assistant' &&
        (this.#messages[i].toolCalls?.length ?? 0) > 0
      ) {
        return i;
      }
    }
    return -1;
  }

  /** 找到所有 assistant(toolCalls) 的位置（按顺序） */
  #findAllToolRoundStarts() {
    const starts: number[] = [];
    for (let i = 1; i < this.#messages.length; i++) {
      if (
        this.#messages[i].role === 'assistant' &&
        (this.#messages[i].toolCalls?.length ?? 0) > 0
      ) {
        starts.push(i);
      }
    }
    return starts;
  }
}

// ─── ToolResultLimiter ──────────────────────────────────

/**
 * 工具结果入口限制器 — 在工具结果进入 ContextWindow 前压缩
 *
 * @param toolName 工具名
 * @param result 工具原始返回
 * @param quota 动态配额
 * @returns 压缩后的结果字符串
 */
export function limitToolResult(toolName: string, result: unknown, quota: ToolResultQuota) {
  const { maxChars = 4000, maxMatches = 10 } = quota;

  // submit_knowledge / submit_with_check 结果很短，不截断
  if (toolName === 'submit_knowledge' || toolName === 'submit_with_check') {
    const raw = typeof result === 'string' ? result : JSON.stringify(result);
    return raw.length > 500 ? raw.substring(0, 500) : raw;
  }

  // search_project_code: 限制匹配数 + 截断上下文（支持批量模式）
  if (toolName === 'search_project_code') {
    if (result && typeof result === 'object' && (result as SearchResultLike).batchResults) {
      // 批量模式：对每个 pattern 的结果独立限制（直接操作对象，避免 stringify→parse 往返）
      const limited: SearchResultLike = { ...(result as SearchResultLike) };
      const perKeyChars = Math.floor(maxChars / Object.keys(limited.batchResults!).length);
      for (const [key, sub] of Object.entries(limited.batchResults!)) {
        limited.batchResults![key] = limitSearchResultObj(
          sub,
          Math.min(maxMatches, 3),
          perKeyChars
        );
      }
      const raw = JSON.stringify(limited);
      return raw.length > maxChars ? `${raw.substring(0, maxChars)}\n... [batch truncated]` : raw;
    }
    return limitSearchResult(result, maxMatches, maxChars);
  }

  // read_project_file: 限制字符数（支持批量模式）
  if (toolName === 'read_project_file') {
    if (result && typeof result === 'object' && (result as FileResultLike).batchResults) {
      const raw = JSON.stringify(result);
      return raw.length > maxChars ? `${raw.substring(0, maxChars)}\n... [batch truncated]` : raw;
    }
    return limitFileContent(result, maxChars);
  }

  // 通用: 按字符限制
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  if (raw.length > maxChars) {
    return `${raw.substring(0, maxChars)}\n... [truncated, ${raw.length} total chars]`;
  }
  return raw;
}

/**
 * 限制搜索结果 — 只保留 topN 匹配，每个匹配的 context 截断
 *
 * search_project_code 返回格式:
 *   { matches: [{ file, line, code, context, score }], total, searchedFiles }
 */
function limitSearchResult(result: unknown, maxMatches: number, maxChars: number) {
  if (typeof result === 'string') {
    return result.length > maxChars ? `${result.substring(0, maxChars)}\n... [truncated]` : result;
  }

  if (!result || typeof result !== 'object') {
    return JSON.stringify(result || {});
  }

  // 深拷贝避免修改原对象
  const src = result as SearchResultLike;
  const limited: SearchResultLike = { ...src };
  if (Array.isArray(limited.matches)) {
    limited.matches = limited.matches.slice(0, maxMatches).map((m: SearchMatch) => {
      const copy: SearchMatch = { ...m };
      // 截断每个匹配的 context 字段（多行文本）
      if (copy.context && typeof copy.context === 'string') {
        const contextLines = copy.context.split('\n');
        if (contextLines.length > 7) {
          copy.context = `${contextLines.slice(0, 7).join('\n')}\n... [truncated]`;
        }
      }
      // 兼容旧格式: 也处理 lines 数组
      if (Array.isArray(copy.lines) && copy.lines.length > 5) {
        copy.lines = copy.lines.slice(0, 5);
        copy._truncated = true;
      }
      return copy;
    });
    if (src.matches!.length > maxMatches) {
      limited._note = `Showing ${maxMatches} of ${src.matches!.length} matches`;
    }
  }

  const str = JSON.stringify(limited);
  if (str.length > maxChars) {
    return `${str.substring(0, maxChars)}\n... [truncated]`;
  }
  return str;
}

/**
 * 限制搜索结果（返回对象） — 用于批量模式，避免 JSON.stringify → JSON.parse 往返
 * 当源码含控制字符时，stringify→substring 截断会破坏 JSON 结构导致 parse 失败
 */
function limitSearchResultObj(
  result: unknown,
  maxMatches: number,
  maxChars: number
): SearchResultLike {
  if (!result || typeof result !== 'object') {
    return (result || {}) as SearchResultLike;
  }
  if (typeof result === 'string') {
    return { _raw: (result as string).substring(0, maxChars) };
  }

  const src = result as SearchResultLike;
  const limited: SearchResultLike = { ...src };
  if (Array.isArray(limited.matches)) {
    limited.matches = limited.matches.slice(0, maxMatches).map((m: SearchMatch) => {
      const copy: SearchMatch = { ...m };
      if (copy.context && typeof copy.context === 'string') {
        const contextLines = copy.context.split('\n');
        if (contextLines.length > 7) {
          copy.context = `${contextLines.slice(0, 7).join('\n')}\n... [truncated]`;
        }
        // 按字符上限截断 context（防止单个代码块过大）
        if (copy.context.length > 500) {
          copy.context = `${copy.context.substring(0, 500)}\n... [truncated]`;
        }
      }
      if (Array.isArray(copy.lines) && copy.lines.length > 5) {
        copy.lines = copy.lines.slice(0, 5);
        copy._truncated = true;
      }
      return copy;
    });
    if (src.matches!.length > maxMatches) {
      limited._note = `Showing ${maxMatches} of ${src.matches!.length} matches`;
    }
  }
  return limited;
}

/** 限制文件内容 — 截断 content 字段 */
function limitFileContent(result: unknown, maxChars: number) {
  if (typeof result === 'string') {
    return result.length > maxChars ? `${result.substring(0, maxChars)}\n... [truncated]` : result;
  }

  if (!result || typeof result !== 'object') {
    return JSON.stringify(result || {});
  }

  const src = result as FileResultLike;
  const limited: FileResultLike = { ...src };
  if (limited.content && limited.content.length > maxChars) {
    const lines = limited.content.split('\n');
    let truncated = '';
    for (const line of lines) {
      if (truncated.length + line.length + 1 > maxChars) {
        break;
      }
      truncated += `${line}\n`;
    }
    limited.content = `${truncated}... [truncated at ${maxChars} chars, total ${src.content!.length}]`;
  }

  return JSON.stringify(limited);
}
