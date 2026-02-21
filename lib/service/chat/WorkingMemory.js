/**
 * WorkingMemory — 会话级工作记忆 (Tier 1)
 *
 * 管理单次 ChatAgent.execute() 中的上下文压缩与关键发现暂存。
 *
 * 策略:
 *   1. 最近 N 轮工具结果保留原文 (由 ContextWindow 自然携带)
 *   2. 更早的工具结果自动压缩为摘要 (≤200 tokens/条)
 *   3. Scratchpad: Agent 通过 note_finding 工具主动标记关键发现
 *   4. 蒸馏: execute 结束时提取结构化数据供 EpisodicMemory 使用
 *
 * 生命周期: 与单次 execute() 调用一致，不持久化。
 *
 * @module WorkingMemory
 */

import Logger from '../../infrastructure/logging/Logger.js';

/**
 * 工具特化压缩策略
 * 不同工具返回不同结构，压缩时保留最有价值的部分
 */
const TOOL_COMPRESS_STRATEGIES = {
  search_project_code(result) {
    if (typeof result !== 'object') {
      return String(result).substring(0, 600);
    }
    const matches = result.matches || [];
    const batchResults = result.batchResults || {};

    const lines = [];
    // 单模式搜索
    if (matches.length > 0) {
      lines.push(`搜索到 ${matches.length} 个匹配`);
      const fileGroups = {};
      for (const m of matches) {
        if (!fileGroups[m.file]) {
          fileGroups[m.file] = [];
        }
        fileGroups[m.file].push(m.line);
      }
      for (const [file, lineNums] of Object.entries(fileGroups).slice(0, 8)) {
        lines.push(`  ${file}: L${lineNums.slice(0, 3).join(',')}`);
      }
    }
    // 批量搜索
    for (const [pattern, sub] of Object.entries(batchResults).slice(0, 5)) {
      const subMatches = sub.matches || [];
      lines.push(`  [${pattern}] ${subMatches.length} 个匹配`);
      for (const m of subMatches.slice(0, 3)) {
        lines.push(`    ${m.file}:${m.line}`);
      }
    }
    return lines.join('\n');
  },

  read_project_file(result) {
    if (typeof result !== 'object') {
      return String(result).substring(0, 600);
    }
    // 批量读取结果
    if (result.files) {
      const lines = [`读取 ${result.files.length} 个文件`];
      for (const f of result.files.slice(0, 5)) {
        const totalLines = (f.content || '').split('\n').length;
        lines.push(`  ${f.path} (${totalLines} 行)`);
      }
      return lines.join('\n');
    }
    // 单文件结果
    const content = result.content || String(result);
    const totalLines = content.split('\n').length;
    return `文件 ${result.path || '?'} (${totalLines} 行)`;
  },

  get_class_info(result) {
    if (typeof result !== 'object') {
      return String(result).substring(0, 600);
    }
    const lines = [`类 ${result.className || '?'}`];
    if (result.superClass) {
      lines.push(`  继承: ${result.superClass}`);
    }
    if (result.protocols?.length) {
      lines.push(`  协议: ${result.protocols.join(', ')}`);
    }
    if (result.methods?.length) {
      lines.push(`  方法数: ${result.methods.length}`);
    }
    if (result.properties?.length) {
      lines.push(`  属性数: ${result.properties.length}`);
    }
    return lines.join('\n');
  },

  get_class_hierarchy(result) {
    if (typeof result !== 'object') {
      return String(result).substring(0, 600);
    }
    const classes = result.classes || result.hierarchy || [];
    return `类层级: ${Array.isArray(classes) ? classes.length : 0} 个类`;
  },

  get_project_overview(result) {
    if (typeof result !== 'object') {
      return String(result).substring(0, 800);
    }
    return JSON.stringify(result).substring(0, 800);
  },

  list_project_structure(result) {
    if (typeof result !== 'object') {
      return String(result).substring(0, 600);
    }
    const entries = result.entries || result.children || [];
    return `目录结构: ${Array.isArray(entries) ? entries.length : 0} 个条目`;
  },
};

/**
 * 默认压缩 — 截断到 maxChars
 */
function defaultCompress(result, maxChars = 600) {
  const str = typeof result === 'string' ? result : JSON.stringify(result);
  if (str.length <= maxChars) {
    return str;
  }
  return `${str.substring(0, maxChars)}…(truncated)`;
}

export class WorkingMemory {
  /** @type {Array<{toolName: string, result: any, round: number, timestamp: number}>} */
  #recentObservations = [];

  /** @type {Array<{toolName: string, round: number, summary: string}>} */
  #compressedObservations = [];

  /**
   * Scratchpad — Agent 主动标记的关键发现
   * @type {Array<{finding: string, evidence: string, importance: number, round: number}>}
   */
  #scratchpad = [];

  /** @type {number} 保留最近 N 轮原始观察 */
  #maxRecentRounds = 3;

  /** @type {number} 总观察计数 */
  #totalObservations = 0;

  /** @type {import('../../infrastructure/logging/Logger.js').default} */
  #logger;

  /**
   * @param {object} [options]
   * @param {number} [options.maxRecentRounds=3] - 保留最近 N 轮原始结果
   */
  constructor(options = {}) {
    this.#maxRecentRounds = options.maxRecentRounds ?? 3;
    this.#logger = Logger.getInstance();
  }

  // ─── 核心操作 ──────────────────────────────────────────

  /**
   * 记录工具调用结果 (Observe)
   *
   * 自动执行滑动窗口压缩:
   * - 最新的 maxRecentRounds 轮保留原文 (由 ContextWindow 内部携带)
   * - 更早轮次的结果自动压缩为摘要
   *
   * @param {string} toolName
   * @param {*} result - 工具返回的原始结果
   * @param {number} round - 当前迭代轮次
   */
  observe(toolName, result, round) {
    this.#totalObservations++;

    this.#recentObservations.push({
      toolName,
      result,
      round,
      timestamp: Date.now(),
    });

    // 滑动窗口压缩
    while (this.#recentObservations.length > this.#maxRecentRounds) {
      const oldest = this.#recentObservations.shift();
      const summary = this.#compress(oldest);
      this.#compressedObservations.push(summary);
    }
  }

  /**
   * Agent 主动记录关键发现 (note_finding 工具入口)
   *
   * @param {string} finding - 关键发现描述
   * @param {string} [evidence] - 证据 (文件路径:行号)
   * @param {number} [importance=5] - 重要性 1-10
   * @param {number} [round=0] - 当前轮次
   */
  noteKeyFinding(finding, evidence = '', importance = 5, round = 0) {
    this.#scratchpad.push({
      finding,
      evidence,
      importance: Math.min(10, Math.max(1, importance)),
      round,
    });

    this.#logger.debug(
      `[WorkingMemory] 📌 noted finding (${importance}/10): ${finding.substring(0, 80)}`
    );
  }

  // ─── 上下文构建 ────────────────────────────────────────

  /**
   * 构建当前 Working Memory 的上下文快照
   * 用于注入到 system prompt 或 user nudge 中
   *
   * @returns {string} Markdown 格式的上下文块，空字符串表示无内容
   */
  buildContext() {
    const parts = [];

    // §1: Scratchpad (最高优先级 — 不会被压缩)
    if (this.#scratchpad.length > 0) {
      const sorted = [...this.#scratchpad].sort((a, b) => b.importance - a.importance);
      parts.push('## 📌 已确认的关键发现');
      for (const f of sorted) {
        const badge = f.importance >= 8 ? '⚠️' : f.importance >= 5 ? '📋' : '💡';
        let line = `- ${badge} [${f.importance}/10] ${f.finding}`;
        if (f.evidence) {
          line += ` (${f.evidence})`;
        }
        parts.push(line);
      }
    }

    // §2: 压缩后的旧观察摘要 (中等优先级)
    if (this.#compressedObservations.length > 0) {
      parts.push('## 📂 之前的探索摘要');
      // 只展示最近 15 条压缩摘要，避免膨胀
      const recent = this.#compressedObservations.slice(-15);
      for (const s of recent) {
        parts.push(`- [R${s.round}|${s.toolName}] ${s.summary.substring(0, 200)}`);
      }
      if (this.#compressedObservations.length > 15) {
        parts.push(`  …(还有 ${this.#compressedObservations.length - 15} 条更早的观察)`);
      }
    }

    // 最近原始结果由 ContextWindow 的对话历史自然携带，不重复注入
    return parts.join('\n');
  }

  // ─── 蒸馏 (Working → Episodic) ─────────────────────────

  /**
   * 蒸馏 Working Memory 为结构化报告
   * 在 Agent execute 结束时调用，结果写入 EpisodicMemory
   *
   * @returns {{
   *   keyFindings: Array<{finding: string, evidence: string, importance: number}>,
   *   toolCallSummary: string[],
   *   totalObservations: number,
   *   compressedCount: number,
   * }}
   */
  distill() {
    return {
      keyFindings: this.#scratchpad.map((f) => ({
        finding: f.finding,
        evidence: f.evidence,
        importance: f.importance,
      })),
      toolCallSummary: this.#compressedObservations.map(
        (s) => `[${s.toolName}] ${s.summary.substring(0, 150)}`
      ),
      totalObservations: this.#totalObservations,
      compressedCount: this.#compressedObservations.length,
    };
  }

  // ─── 查询 ─────────────────────────────────────────────

  /**
   * 获取 scratchpad 中的关键发现数量
   * @returns {number}
   */
  get scratchpadSize() {
    return this.#scratchpad.length;
  }

  /**
   * 获取总观察数
   * @returns {number}
   */
  get totalObservations() {
    return this.#totalObservations;
  }

  /**
   * 获取 scratchpad 中的高重要性发现
   * @param {number} [minImportance=7]
   * @returns {Array<{finding: string, evidence: string, importance: number}>}
   */
  getHighPriorityFindings(minImportance = 7) {
    return this.#scratchpad
      .filter((f) => f.importance >= minImportance)
      .sort((a, b) => b.importance - a.importance);
  }

  /**
   * 清空 WorkingMemory — 释放内存
   * 在 Agent execute 结束后调用，避免残留引用导致内存泄漏
   */
  clear() {
    this.#recentObservations.length = 0;
    this.#compressedObservations.length = 0;
    this.#scratchpad.length = 0;
    this.#totalObservations = 0;
  }

  // ─── 内部 ─────────────────────────────────────────────

  /**
   * 工具结果压缩 — 使用特化策略
   * @param {{toolName: string, result: any, round: number}} observation
   * @returns {{toolName: string, round: number, summary: string}}
   */
  #compress(observation) {
    const strategy = TOOL_COMPRESS_STRATEGIES[observation.toolName];
    let summary;

    try {
      if (strategy) {
        summary = strategy(observation.result);
      } else {
        summary = defaultCompress(observation.result);
      }
    } catch {
      summary = defaultCompress(observation.result);
    }

    return {
      toolName: observation.toolName,
      round: observation.round,
      summary,
    };
  }
}

export default WorkingMemory;
