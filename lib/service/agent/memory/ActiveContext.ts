/**
 * ActiveContext — 合并 WorkingMemory + ReasoningTrace 为统一的会话工作记忆
 *
 * 设计来源: docs/copilot/memory-system-redesign.md §4.3, §6.2
 *
 * 三个内部子区:
 *   1. Scratchpad   — Agent 通过 note_finding 主动标记的发现 (不可压缩)
 *   2. ObservationLog — 每轮 ReAct 记录 (合并原 RT.rounds + WM.observations，滑动窗口压缩)
 *   3. Plan          — 从 ReasoningTrace 继承的规划追踪
 *
 * 替代关系:
 *   WorkingMemory.js  → Scratchpad + 工具压缩策略 + buildContext + distill
 *   ReasoningTrace.js → rounds + plan + thoughts + extractAndSetPlan + observations
 *
 * 兼容性:
 *   - 提供所有 ReasoningTrace 和 WorkingMemory 的公共方法
 *   - ExplorationTracker 可直接使用 ActiveContext 作为 trace 参数 (L5 缓解)
 *   - MemoryCoordinator 通过 createDimensionScope 创建实例
 *
 * 生命周期: 单次 execute() 调用 (由 MemoryCoordinator 管理创建/蒸馏/销毁)
 *
 * @module ActiveContext
 */

import Logger from '../../../infrastructure/logging/Logger.js';

// ═══════════════════════════════════════════════════════════
// §1: 工具压缩策略 (从 WorkingMemory 迁入)
// ═══════════════════════════════════════════════════════════

/**
 * 工具特化压缩策略 — 不同工具返回不同结构，压缩时保留最有价值的部分
 */
const TOOL_COMPRESS_STRATEGIES = {
  search_project_code(result: any) {
    if (typeof result !== 'object') {
      return String(result).substring(0, 600);
    }
    const matches = result.matches || [];
    const batchResults = result.batchResults || {};
    const lines: string[] = [];
    if (matches.length > 0) {
      lines.push(`搜索到 ${matches.length} 个匹配`);
      const fileGroups: Record<string, any> = {};
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
    for (const [pattern, sub] of Object.entries(batchResults).slice(0, 5)) {
      const subMatches = (sub as any).matches || [];
      lines.push(`  [${pattern}] ${subMatches.length} 个匹配`);
      for (const m of subMatches.slice(0, 3)) {
        lines.push(`    ${m.file}:${m.line}`);
      }
    }
    return lines.join('\n');
  },

  read_project_file(result: any) {
    if (typeof result !== 'object') {
      return String(result).substring(0, 600);
    }
    if (result.files) {
      const lines = [`读取 ${result.files.length} 个文件`];
      for (const f of result.files.slice(0, 5)) {
        const totalLines = (f.content || '').split('\n').length;
        lines.push(`  ${f.path} (${totalLines} 行)`);
      }
      return lines.join('\n');
    }
    const content = result.content || String(result);
    const totalLines = content.split('\n').length;
    return `文件 ${result.path || '?'} (${totalLines} 行)`;
  },

  get_class_info(result: any) {
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

  get_class_hierarchy(result: any) {
    if (typeof result !== 'object') {
      return String(result).substring(0, 600);
    }
    const classes = result.classes || result.hierarchy || [];
    return `类层级: ${Array.isArray(classes) ? classes.length : 0} 个类`;
  },

  get_project_overview(result: any) {
    if (typeof result !== 'object') {
      return String(result).substring(0, 800);
    }
    return JSON.stringify(result).substring(0, 800);
  },

  list_project_structure(result: any) {
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
function defaultCompress(result: any, maxChars = 600) {
  const str = typeof result === 'string' ? result : JSON.stringify(result);
  if (str.length <= maxChars) {
    return str;
  }
  return `${str.substring(0, maxChars)}…(truncated)`;
}

// ═══════════════════════════════════════════════════════════
// §2: ActiveContext 类
// ═══════════════════════════════════════════════════════════

export class ActiveContext {
  // ── 子区 1: Scratchpad (从 WorkingMemory 继承, 不可压缩) ──
  /** @type {Array<{finding: string, evidence: string, importance: number, round: number}>} */
  #scratchpad: any[] = [];

  // ── 子区 2: ObservationLog (合并 RT.rounds + WM.observations) ──
  /** @type {Array<Round>} */
  #rounds: any[] = [];
  /** @type {Round|null} */
  #currentRound: any = null;

  // ── WM 滑动窗口 (保留最近 N 轮原始结果，旧的压缩) ──
  /** @type {Array<{toolName: string, result: any, round: number, timestamp: number}>} */
  #recentObservations: any[] = [];
  /** @type {Array<{toolName: string, round: number, summary: string}>} */
  #compressedObservations: any[] = [];

  // ── 子区 3: Plan (从 ReasoningTrace 继承) ──
  /** @type {Plan|null} */
  #plan: any = null;
  /** @type {Array<Plan>} */
  #planHistory: any[] = [];
  /** @type {boolean} 是否期待下一次响应包含计划 (由 ExplorationTracker 设置) */
  #expectingPlan = false;

  // ── 配置 ──
  /** @type {number} 保留最近 N 轮原始观察 */
  #maxRecentRounds;
  /** @type {boolean} 轻量模式 (User Chat: 仅 RT 功能，禁用 WM 压缩/Scratchpad) */
  #lightweight;
  /** @type {number} 总观察计数 */
  #totalObservations = 0;

  /** @type {import('winston').Logger} */
  #logger;

  /**
   * @param {object} [options]
   * @param {number} [options.maxRecentRounds=3] 保留最近 N 轮原始结果 (WM 滑动窗口)
   * @param {boolean} [options.lightweight=false] 轻量模式: 跳过 WM 的压缩/Scratchpad 逻辑 (D5)
   */
  constructor(options: any = {}) {
    this.#maxRecentRounds = options.maxRecentRounds ?? 3;
    this.#lightweight = options.lightweight ?? false;
    this.#logger = Logger.getInstance();
  }

  // ═══════════════════════════════════════════════════════
  // §2.1: 轮次管理 (合并 RT.startRound/endRound)
  // ═══════════════════════════════════════════════════════

  /**
   * 开始新一轮推理
   * @param {number} iteration 轮次编号
   */
  startRound(iteration: any) {
    if (this.#currentRound) {
      this.endRound(); // 安全关闭上一轮
    }
    this.#currentRound = {
      iteration,
      thought: null,
      actions: [],
      observations: [],
      reflection: null,
      roundSummary: null,
      startTime: Date.now(),
      endTime: null,
    };
  }

  /**
   * 结束当前轮次
   */
  endRound() {
    if (this.#currentRound) {
      this.#currentRound.endTime = Date.now();
      this.#rounds.push(this.#currentRound);
      this.#currentRound = null;
    }
  }

  // ═══════════════════════════════════════════════════════
  // §2.2: 记录 (合并 WM.observe + RT.addAction/addObservation)
  // ═══════════════════════════════════════════════════════

  /**
   * 记录 AI 的推理文本（从 aiResult.text 提取）
   * @param {string} text
   */
  setThought(text: any) {
    if (this.#currentRound && text) {
      this.#currentRound.thought = text;
    }
  }

  /**
   * 统一记录一次工具调用 — 合并原 WM.observe() + RT.addAction() + RT.addObservation()
   *
   * @param {string} toolName 工具名称
   * @param {object} args 工具参数
   * @param {*} result 工具返回的原始结果
   * @param {boolean} isNew 是否发现新信息 (由 ExplorationTracker.recordToolCall 提供)
   */
  recordToolCall(toolName: any, args: any, result: any, isNew: any) {
    const round = this.#currentRound?.iteration || 0;

    // ── RT 部分: Action + Observation ──
    this.#currentRound?.actions.push({ tool: toolName, params: args });
    const observationMeta = ActiveContext.buildObservationMeta(toolName, args, result, isNew);
    this.#currentRound?.observations.push({ tool: toolName, ...observationMeta });

    // ── WM 部分: 滑动窗口压缩 (非轻量模式) ──
    if (!this.#lightweight) {
      this.#totalObservations++;
      this.#recentObservations.push({
        toolName,
        result,
        round,
        timestamp: Date.now(),
      });

      while (this.#recentObservations.length > this.#maxRecentRounds) {
        const oldest = this.#recentObservations.shift();
        const summary = this.#compressObservation(oldest);
        this.#compressedObservations.push(summary);
      }
    }
  }

  /**
   * 兼容旧 RT API: 记录一次工具调用 (Action only)
   * @param {string} toolName
   * @param {object} params
   */
  addAction(toolName: any, params: any) {
    this.#currentRound?.actions.push({ tool: toolName, params });
  }

  /**
   * 兼容旧 RT API: 记录一次工具结果的结构化观察
   * @param {string} toolName
   * @param {object} meta
   */
  addObservation(toolName: any, meta: any) {
    this.#currentRound?.observations.push({ tool: toolName, ...meta });
  }

  /**
   * 兼容旧 WM API: 记录工具调用结果 (Observe, 仅 WM 滑动窗口)
   * @param {string} toolName
   * @param {*} result
   * @param {number} round
   */
  observe(toolName: any, result: any, round: any) {
    if (this.#lightweight) {
      return;
    }
    this.#totalObservations++;
    this.#recentObservations.push({ toolName, result, round, timestamp: Date.now() });
    while (this.#recentObservations.length > this.#maxRecentRounds) {
      const oldest = this.#recentObservations.shift();
      const summary = this.#compressObservation(oldest);
      this.#compressedObservations.push(summary);
    }
  }

  /**
   * 记录反思内容 (ExplorationTracker 使用, L5 修复)
   * @param {string} text
   */
  setReflection(text: any) {
    if (this.#currentRound && text) {
      this.#currentRound.reflection = text;
    }
  }

  /**
   * 记录轮次摘要
   * @param {object} summary - { newInfoCount, totalCalls, submits, cumulativeFiles, cumulativePatterns }
   */
  setRoundSummary(summary: any) {
    if (this.#currentRound) {
      this.#currentRound.roundSummary = summary;
    }
  }

  // ═══════════════════════════════════════════════════════
  // §2.3: Scratchpad (从 WorkingMemory 继承)
  // ═══════════════════════════════════════════════════════

  /**
   * Agent 主动记录关键发现 (note_finding 工具入口)
   *
   * @param {string} finding 关键发现描述
   * @param {string} [evidence] 证据 (文件路径:行号)
   * @param {number} [importance=5] 重要性 1-10
   * @param {number} [round=0] 当前轮次
   */
  noteKeyFinding(finding: any, evidence: any = '', importance = 5, round = 0) {
    // P0 Fix: 防御性保证 evidence 是 string (AI 可能传入 array/object)
    const safeEvidence =
      typeof evidence === 'string'
        ? evidence
        : Array.isArray(evidence)
          ? evidence.join(', ')
          : evidence
            ? String(evidence)
            : '';
    this.#scratchpad.push({
      finding,
      evidence: safeEvidence,
      importance: Math.min(10, Math.max(1, importance)),
      round,
    });

    this.#logger.debug(
      `[ActiveContext] 📌 noted finding (${importance}/10): ${finding.substring(0, 80)}`
    );
  }

  // ═══════════════════════════════════════════════════════
  // §2.4: Plan (从 ReasoningTrace 继承)
  // ═══════════════════════════════════════════════════════

  /**
   * 从 AI 响应文本中提取计划，自动调用 setPlan/updatePlan
   *
   * 防御措施: 已存在计划时，仅在 #expectingPlan 为 true 时才覆盖。
   * 这防止 reflection 回复中的编号列表（非计划的回应文本）污染已有计划。
   * ExplorationTracker 在发送 plan elicitation / replan 时调用 expectPlan() 授权更新。
   *
   * @param {string} text - AI 完整响应文本
   * @param {number} iteration 当前轮次
   * @returns {boolean} 是否成功提取到计划
   */
  extractAndSetPlan(text: any, iteration: any) {
    const planText = this.#extractPlanFromText(text);
    if (!planText) {
      return false;
    }

    // Guard: 已有计划时，仅在 expectPlan 授权下才覆盖
    // 防止 reflection/convergence 回复中的编号列表被误捕获为 plan
    if (this.#plan && !this.#expectingPlan) {
      return false;
    }

    this.#expectingPlan = false;
    if (this.#plan) {
      this.#updatePlan(planText, iteration);
    } else {
      this.#setPlan(planText, iteration);
    }
    return true;
  }

  /**
   * 标记「下一次响应可能包含计划」— 授权 extractAndSetPlan 覆盖已有计划
   * 由 ExplorationTracker 在发送 plan elicitation / replan nudge 时调用。
   */
  expectPlan() {
    this.#expectingPlan = true;
  }

  /**
   * 直接设置计划 (公开接口，供 ExplorationTracker 和测试使用)
   * @param {string} planText
   * @param {number} iteration
   */
  setPlan(planText: any, iteration: any) {
    this.#setPlan(planText, iteration);
  }

  /**
   * 更新计划 (保留旧 plan 到 history)
   * @param {string} replanText
   * @param {number} iteration
   */
  updatePlan(replanText: any, iteration: any) {
    this.#updatePlan(replanText, iteration);
  }

  /**
   * 获取当前计划 (只读副本)
   * @returns {Plan|null}
   */
  getPlan() {
    if (!this.#plan) {
      return null;
    }
    return {
      ...this.#plan,
      steps: this.#plan.steps.map((s: any) => ({ ...s })),
    };
  }

  /**
   * 获取计划步骤的可变引用 (ExplorationTracker.updatePlanProgress 使用)
   * @returns {Array<PlanStep>}
   */
  getPlanStepsMutable() {
    return this.#plan?.steps || [];
  }

  /**
   * 获取计划历史 (F7)
   * @returns {Array<Plan>}
   */
  getPlanHistory() {
    return this.#planHistory.map((p) => ({ ...p, steps: p.steps.map((s: any) => ({ ...s })) }));
  }

  /**
   * 获取当前轮次的 actions (ExplorationTracker.updatePlanProgress 使用, L5 修复)
   * @returns {Array<{tool: string, params: object}>}
   */
  getCurrentRoundActions() {
    return this.#currentRound?.actions || [];
  }

  /**
   * 获取当前轮次的 iteration 编号 (F8)
   * @returns {number|null}
   */
  getCurrentIteration() {
    return this.#currentRound?.iteration || null;
  }

  // ═══════════════════════════════════════════════════════
  // §2.5: 上下文构建 (合并 WM.buildContext, 增加预算控制)
  // ═══════════════════════════════════════════════════════

  /**
   * 构建当前工作记忆的上下文快照
   * 用于注入到 system prompt 或 user nudge 中
   *
   * @param {number} [tokenBudget=Infinity] - token 预算 (新增: 预算控制)
   * @returns {string} Markdown 格式的上下文块，空字符串表示无内容
   */
  buildContext(tokenBudget = Infinity) {
    if (this.#lightweight) {
      return '';
    }

    const parts: string[] = [];
    let remaining = tokenBudget;

    // §1: Scratchpad (最高优先级 — 不会被压缩)
    if (this.#scratchpad.length > 0) {
      const sorted = [...this.#scratchpad].sort((a, b) => b.importance - a.importance);
      const scratchLines = ['## 📌 已确认的关键发现'];
      for (const f of sorted) {
        const badge = f.importance >= 8 ? '⚠️' : f.importance >= 5 ? '📋' : '💡';
        let line = `- ${badge} [${f.importance}/10] ${f.finding}`;
        if (f.evidence) {
          line += ` (${f.evidence})`;
        }
        scratchLines.push(line);
      }
      const scratchSection = scratchLines.join('\n');
      const scratchTokens = this.#estimateTokens(scratchSection);
      if (scratchTokens <= remaining) {
        parts.push(scratchSection);
        remaining -= scratchTokens;
      }
    }

    // §2: 压缩后的旧观察摘要 (中等优先级)
    if (this.#compressedObservations.length > 0 && remaining > 100) {
      const obsLines = ['## 📂 之前的探索摘要'];
      const maxItems = Math.min(15, this.#compressedObservations.length);
      const recent = this.#compressedObservations.slice(-maxItems);

      for (const s of recent) {
        const line = `- [R${s.round}|${s.toolName}] ${s.summary.substring(0, 200)}`;
        const lineTokens = this.#estimateTokens(line);
        if (lineTokens > remaining) {
          break;
        }
        obsLines.push(line);
        remaining -= lineTokens;
      }
      if (this.#compressedObservations.length > maxItems) {
        obsLines.push(`  …(还有 ${this.#compressedObservations.length - maxItems} 条更早的观察)`);
      }
      if (obsLines.length > 1) {
        parts.push(obsLines.join('\n'));
      }
    }

    return parts.join('\n');
  }

  // ═══════════════════════════════════════════════════════
  // §2.6: 蒸馏 (合并 WM.distill, 增强版 — 含 plan + stats)
  // ═══════════════════════════════════════════════════════

  /**
   * 蒸馏 ActiveContext 为结构化报告
   * 在 Agent execute 结束时调用，结果写入 SessionStore
   *
   * @returns {DistilledContext}
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
      stats: this.getStats(),
      plan: this.getPlan(),
      totalObservations: this.#totalObservations,
      compressedCount: this.#compressedObservations.length,
    };
  }

  // ═══════════════════════════════════════════════════════
  // §2.7: 分析方法 (从 ReasoningTrace 继承)
  // ═══════════════════════════════════════════════════════

  /**
   * 获取所有有 Thought 的轮次
   * @returns {Array<{iteration: number, thought: string}>}
   */
  getThoughts() {
    return this.#rounds
      .filter((r) => r.thought)
      .map((r) => ({ iteration: r.iteration, thought: r.thought }));
  }

  /**
   * 获取最近 N 轮的紧凑摘要 (ExplorationTracker.#checkReflection 使用)
   * @param {number} [n=3] 回看轮数
   * @returns {object|null}
   */
  getRecentSummary(n = 3) {
    const recent = this.#rounds.slice(-n);
    if (recent.length === 0) {
      return null;
    }

    const thoughts = recent
      .filter((r) => r.thought)
      .map((r) => (r.thought.length > 100 ? `${r.thought.substring(0, 100)}…` : r.thought));

    const tools = recent.flatMap((r) => r.actions.map((a: any) => a.tool));

    const newInfoCount = recent.reduce(
      (c, r) => c + r.observations.filter((o: any) => o.gotNewInfo).length,
      0
    );
    const totalObs = recent.reduce((c, r) => c + r.observations.length, 0);

    return {
      roundCount: recent.length,
      thoughts,
      toolCalls: tools,
      newInfoRatio: totalObs > 0 ? newInfoCount / totalObs : 0,
      lastIteration: recent[recent.length - 1].iteration,
    };
  }

  /**
   * 统计指标 (ExplorationTracker.getQualityMetrics 使用)
   * @returns {object}
   */
  getStats() {
    return {
      totalRounds: this.#rounds.length,
      thoughtCount: this.#rounds.filter((r) => r.thought).length,
      totalActions: this.#rounds.reduce((c, r) => c + r.actions.length, 0),
      totalObservations: this.#rounds.reduce((c, r) => c + r.observations.length, 0),
      reflectionCount: this.#rounds.filter((r) => r.reflection).length,
      totalDurationMs: this.#rounds.reduce(
        (d, r) => d + ((r.endTime || Date.now()) - r.startTime),
        0
      ),
    };
  }

  // ═══════════════════════════════════════════════════════
  // §2.8: Scratchpad 查询 (从 WorkingMemory 继承)
  // ═══════════════════════════════════════════════════════

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

  // ═══════════════════════════════════════════════════════
  // §2.9: 序列化 (从 ReasoningTrace 继承)
  // ═══════════════════════════════════════════════════════

  /**
   * 可序列化输出
   * @returns {object}
   */
  toJSON() {
    return {
      rounds: this.#rounds.map((r) => ({ ...r })),
      stats: this.getStats(),
      scratchpad: this.#scratchpad.map((f) => ({ ...f })),
      compressedObservations: this.#compressedObservations.length,
      totalObservations: this.#totalObservations,
      ...(this.#plan
        ? {
            plan: {
              text: this.#plan.text,
              steps: this.#plan.steps.map((s: any) => ({ ...s })),
              createdAtIteration: this.#plan.createdAtIteration,
              lastUpdatedAtIteration: this.#plan.lastUpdatedAtIteration,
            },
            planHistory: this.#planHistory.length,
          }
        : {}),
    };
  }

  /**
   * 从 JSON 恢复 ActiveContext (断点续传)
   * @param {object} json - toJSON() 的输出
   * @returns {ActiveContext}
   */
  static fromJSON(json: any) {
    const ctx = new ActiveContext();
    if (json.rounds) {
      ctx.#rounds = json.rounds.map((r: any) => ({ ...r }));
    }
    if (json.scratchpad) {
      ctx.#scratchpad = json.scratchpad.map((f: any) => ({ ...f }));
    }
    if (json.totalObservations) {
      ctx.#totalObservations = json.totalObservations;
    }
    if (json.plan) {
      ctx.#plan = {
        text: json.plan.text,
        steps: json.plan.steps.map((s: any) => ({ ...s })),
        createdAtIteration: json.plan.createdAtIteration,
        lastUpdatedAtIteration: json.plan.lastUpdatedAtIteration,
      };
    }
    return ctx;
  }

  /**
   * 清空 ActiveContext — 释放内存
   */
  clear() {
    this.#scratchpad.length = 0;
    this.#rounds.length = 0;
    this.#currentRound = null;
    this.#recentObservations.length = 0;
    this.#compressedObservations.length = 0;
    this.#plan = null;
    this.#planHistory.length = 0;
    this.#totalObservations = 0;
  }

  // ═══════════════════════════════════════════════════════
  // §2.10: 静态工具 (从 ReasoningTrace 迁入)
  // ═══════════════════════════════════════════════════════

  /**
   * 从工具执行结果构建结构化观察元数据
   * 不改变工具结果传给 AI 的内容，只影响推理链记录
   *
   * @param {string} toolName
   * @param {object} args
   * @param {*} result
   * @param {boolean} isNew 由 ExplorationTracker.recordToolCall 提供
   * @returns {{ gotNewInfo: boolean, resultType: string, keyFacts: string[], resultSize: number }}
   */
  static buildObservationMeta(toolName: any, args: any, result: any, isNew: any) {
    const meta = {
      gotNewInfo: isNew,
      resultType: 'unknown',
      keyFacts: [] as string[],
      resultSize: 0,
    };

    const resultStr = typeof result === 'string' ? result : JSON.stringify(result || '');
    meta.resultSize = resultStr.length;

    switch (toolName) {
      case 'search_project_code': {
        meta.resultType = 'search';
        const matches = result?.matches || [];
        const batchResults = result?.batchResults;
        const totalMatches = batchResults
          ? Object.values(batchResults).reduce((s, br: any) => s + (br.matches?.length || 0), 0)
          : matches.length;
        meta.keyFacts.push(`${totalMatches} matches found`);
        if (isNew) {
          meta.keyFacts.push('new files discovered');
        }
        break;
      }
      case 'read_project_file': {
        meta.resultType = 'file_content';
        const fp = args?.filePath || '';
        const fps = args?.filePaths || [];
        const allPaths = fp ? [fp, ...fps] : fps;
        meta.keyFacts.push(`read ${allPaths.length} file(s)`);
        break;
      }
      case 'submit_knowledge':
      case 'submit_with_check': {
        meta.resultType = 'submit';
        meta.gotNewInfo = true;
        const status = typeof result === 'object' ? result?.status || 'ok' : 'ok';
        const title = args?.title || '(untitled)';
        meta.keyFacts.push(`submit "${title}": ${status}`);
        break;
      }
      case 'list_project_structure': {
        meta.resultType = 'structure';
        meta.keyFacts.push(`list ${args?.directory || '/'}`);
        break;
      }
      case 'get_class_info':
      case 'get_class_hierarchy':
      case 'get_protocol_info':
      case 'get_method_overrides':
      case 'get_category_map': {
        meta.resultType = 'ast_query';
        const target = args?.className || args?.protocolName || args?.name || '';
        meta.keyFacts.push(`${toolName}(${target})`);
        break;
      }
      case 'get_project_overview': {
        meta.resultType = 'overview';
        meta.keyFacts.push('project overview');
        break;
      }
      case 'semantic_search_code':
      case 'get_file_summary':
      case 'get_previous_analysis': {
        meta.resultType = 'query';
        meta.keyFacts.push(toolName);
        break;
      }
      default: {
        meta.resultType = 'other';
        meta.keyFacts.push(toolName);
      }
    }

    return meta;
  }

  // ═══════════════════════════════════════════════════════
  // §3: 私有方法
  // ═══════════════════════════════════════════════════════

  /**
   * 工具结果压缩 — 使用特化策略 (从 WorkingMemory 迁入)
   * @param {{toolName: string, result: any, round: number}} observation
   * @returns {{toolName: string, round: number, summary: string}}
   */
  #compressObservation(observation: any) {
    const strategy = (TOOL_COMPRESS_STRATEGIES as Record<string, any>)[observation.toolName];
    let summary;
    try {
      summary = strategy ? strategy(observation.result) : defaultCompress(observation.result);
    } catch {
      summary = defaultCompress(observation.result);
    }
    return {
      toolName: observation.toolName,
      round: observation.round,
      summary,
    };
  }

  /**
   * 粗糙 token 估算 (1 token ≈ 4 chars)
   * @param {string} text
   * @returns {number}
   */
  #estimateTokens(text: any) {
    return Math.ceil((text || '').length / 4);
  }

  // ── Plan 内部方法 (从 ReasoningTrace 迁入) ──

  /**
   * @param {string} planText
   * @param {number} iteration
   */
  #setPlan(planText: any, iteration: any) {
    this.#plan = {
      text: planText,
      steps: this.#parsePlanSteps(planText),
      createdAtIteration: iteration,
      lastUpdatedAtIteration: iteration,
    };
  }

  /**
   * @param {string} replanText
   * @param {number} iteration
   */
  #updatePlan(replanText: any, iteration: any) {
    if (!this.#plan) {
      this.#setPlan(replanText, iteration);
      return;
    }
    this.#planHistory.push({ ...this.#plan, steps: this.#plan.steps.map((s: any) => ({ ...s })) });
    this.#plan.text = replanText;
    this.#plan.steps = this.#parsePlanSteps(replanText);
    this.#plan.lastUpdatedAtIteration = iteration;
  }

  /**
   * 从 AI 文本中解析计划步骤
   * @param {string} text
   * @returns {Array<PlanStep>}
   */
  #parsePlanSteps(text: any) {
    if (!text) {
      return [];
    }
    const lines = text.split('\n');
    const steps: { description: any; status: string; keywords: any[] }[] = [];
    for (const line of lines) {
      const m = line.match(/^\s*(?:\d+[.)]\s*|[-*]\s+)(.+)/);
      if (m && m[1].trim().length > 5) {
        steps.push({
          description: m[1].trim(),
          status: 'pending',
          keywords: this.#extractKeywords(m[1]),
        });
      }
    }
    return steps;
  }

  /**
   * 从步骤描述中提取关键词
   * @param {string} text
   * @returns {string[]}
   */
  #extractKeywords(text: any) {
    const quoted = [...text.matchAll(/[`"']([A-Za-z_]\w{2,})[`"']/g)].map((m) => m[1]);
    const camelCase = [...text.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g)].map((m) => m[0]);
    const acronyms = [...text.matchAll(/\b([A-Z]{2,}[a-z]\w+)\b/g)].map((m) => m[0]);
    return [...new Set([...quoted, ...camelCase, ...acronyms])];
  }

  /**
   * 从 AI 响应文本中提取"计划"部分
   * @param {string} text
   * @returns {string|null}
   */
  #extractPlanFromText(text: any) {
    if (!text || text.length < 30) {
      return null;
    }

    const searchArea = text.substring(0, 2000);

    const planMarkers = [
      /(?:探索|分析)?计划[:：\s]/i,
      /(?:my\s+)?plan[:：\s]/i,
      /步骤[:：\s]/i,
      /以下是.*(?:计划|步骤)/i,
    ];

    let planStart = -1;
    for (const marker of planMarkers) {
      const match = searchArea.match(marker);
      if (match) {
        planStart = match.index + match[0].length;
        break;
      }
    }

    if (planStart === -1) {
      const listMatch = searchArea.match(/\n\s*1[.)]\s+/);
      if (listMatch) {
        planStart = listMatch.index;
      }
    }

    if (planStart === -1) {
      return null;
    }

    const remaining = searchArea.substring(planStart);
    const lines = remaining.split('\n');
    const planLines: any[] = [];
    let inList = false;

    for (const line of lines) {
      if (/^\s*(?:\d+[.)]\s+|[-*]\s+)/.test(line)) {
        inList = true;
        planLines.push(line);
      } else if (inList && line.trim() === '') {
        break;
      } else if (inList) {
        break;
      }
    }

    if (planLines.length < 2) {
      return null;
    }

    // 防御: 拒绝 "大部分是疑问句" 的编号列表
    // reflection nudge 的 "请评估: 1. ...是什么？ 2. ...？" 会被 LLM 回显，
    // 不是真正的探索计划，不能捕获为 plan steps
    const questionCount = planLines.filter((l) => /[？?]\s*$/.test(l.trim())).length;
    if (questionCount > planLines.length * 0.5) {
      return null;
    }

    return planLines.join('\n').trim();
  }
}

export default ActiveContext;
