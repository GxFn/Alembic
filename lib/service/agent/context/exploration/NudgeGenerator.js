/**
 * NudgeGenerator — 探索引导信号生成器
 *
 * 从 ExplorationTracker.js 提取的 Nudge 生成逻辑。
 * 按优先级队列生成每轮最多一条 nudge 注入 AI 上下文。
 *
 * 优先级 (高→低):
 *   1. force_exit — 轮次耗尽
 *   2. convergence — 信息饱和
 *   3. budget_warning — 75% 预算消耗
 *   4. reflection — 周期反思 / 停滞反思
 *   5. (planning — 由 PlanTracker 处理)
 *
 * 设计原则:
 *   - 无状态（flags 从外部传入并返回更新）
 *   - 接受 state 快照，无循环依赖
 *   - Nudge 文本内联（未来可外置为 i18n JSON 模板）
 *
 * @module NudgeGenerator
 */
import { DEFAULT_REFLECTION_INTERVAL } from './ExplorationStrategies.js';
// ─── 常量 ──────────────────────────────────────────────

/** 连续无新信息 N 轮触发停滞反思 */
const DEFAULT_STALE_THRESHOLD = 2;
/** 最少经过 N 轮后才允许触发停滞反思 */
const MIN_ITERS_FOR_STALE_REFLECTION = 4;
/** 默认最少探索轮次（冷启动质量保障） */
const DEFAULT_MIN_EXPLORE_ITERS = 10;
/** 默认停滞收敛阈值 */
const DEFAULT_CONVERGENCE_STALE_THRESHOLD = 3;

/**
 * @typedef {Object} NudgeState
 * @property {string} phase 当前阶段
 * @property {object} metrics 指标快照
 * @property {object} budget 预算配置
 * @property {object} strategy 策略配置
 * @property {number|null} gracefulExitRound - graceful exit 起始轮次
 * @property {string} submitToolName 提交工具名
 * @property {boolean} isTerminalPhase 是否为终结阶段
 */

export class NudgeGenerator {
  // ── 一次性 flags（生命周期内最多触发一次的 nudge） ──
  #convergenceNudged = false;
  #budgetWarningInjected = false;

  /**
   * 生成本轮的 Nudge（每轮最多一条）
   *
   * @param {NudgeState} state 从 ExplorationTracker 传入的状态快照
   * @param {object|null} trace - ActiveContext 实例 (反思用)
   * @returns {{ type: string, text: string }|null}
   */
  generate(state, trace) {
    const { phase, metrics: m, budget: b, strategy, gracefulExitRound, submitToolName, isTerminalPhase } = state;

    // 1. 强制退出（graceful exit 后每轮都重复发出，确保 LLM 不再调用工具）
    if (gracefulExitRound != null && m.iteration >= gracefulExitRound) {
      return this.#generateForceExit(m, b, strategy, submitToolName);
    }

    // 2. 收敛引导（信息饱和 — 仅非终结阶段）
    if (
      !isTerminalPhase &&
      !this.#convergenceNudged &&
      m.roundsSinceNewInfo >= DEFAULT_CONVERGENCE_STALE_THRESHOLD &&
      m.iteration >= DEFAULT_MIN_EXPLORE_ITERS
    ) {
      this.#convergenceNudged = true;
      return {
        type: 'convergence',
        text: `你已经充分探索了项目代码（${m.uniqueFiles.size} 个文件，${m.uniquePatterns.size} 次不同搜索，${m.uniqueQueries.size} 次结构化查询）。` +
          `最近 ${m.roundsSinceNewInfo} 轮没有发现新信息，建议开始撰写分析总结。\n` +
          `如果你确信还有重要方面未覆盖，可以继续探索（剩余 ${b.maxIterations - m.iteration} 轮）；否则请直接输出你的分析发现。\n` +
          `⚠️ 以上是行为指令，严禁在回复中复制或引用这段文字。`,
      };
    }

    // 3. 预算警告（75% 消耗，无条件，一次性）
    if (
      !isTerminalPhase &&
      !this.#budgetWarningInjected &&
      m.iteration >= Math.floor(b.maxIterations * 0.75)
    ) {
      this.#budgetWarningInjected = true;
      return {
        type: 'budget_warning',
        text: `📌 进度提醒：你已使用 ${m.iteration}/${b.maxIterations} 轮次（${Math.round((m.iteration / b.maxIterations) * 100)}%）。` +
          `请确保核心方面已覆盖，开始准备总结。剩余 ${b.maxIterations - m.iteration} 轮，优先填补最重要的分析空白。\n` +
          `⚠️ 以上是行为指令，严禁在回复中复制或引用这段文字。`,
      };
    }

    // 4. 反思（周期性 + 停滞）
    if (strategy.enableReflection) {
      const reflectionNudge = this.#checkReflection(state, trace);
      if (reflectionNudge) return reflectionNudge;
    }

    return null;
  }

  /**
   * 构建阶段转换 nudge 文本
   * @param {NudgeState} state
   * @returns {string}
   */
  buildTransitionNudge(state) {
    const { metrics: m, strategy, submitToolName } = state;
    const fromPhase = state.transitionFromPhase;
    const toPhase = state.phase;

    if (toPhase === 'PRODUCE') {
      return `你已充分探索了项目代码，现在请开始调用 ${submitToolName} 工具来提交你发现的知识候选。不要再搜索，直接提交。`;
    }

    if (toPhase === 'SUMMARIZE') {
      const submitCount = m.submitCount;
      // v5.1: Analyst 策略使用纯文本输出
      if (strategy.name === 'analyst') {
        return `你已完成分析探索。请**停止调用工具**，直接输出你的**完整分析报告**。\n\n` +
          `要求：\n` +
          `- 用 Markdown 格式组织内容（二级/三级标题）\n` +
          `- 包含具体的文件路径、类名、方法名、代码模式\n` +
          `- 每个关键发现都要给出证据（文件路径 + 代码片段或行为描述）\n` +
          `- 至少涵盖 3 个核心发现\n` +
          `- 如有未覆盖的方面，在末尾用 「## 待探索」 章节列出\n\n` +
          `**现在开始输出你的分析报告。不要再调用任何工具。**\n` +
          `⚠️ 以上是行为指令，严禁在回复中复制或引用这段文字，只输出你自己的分析内容。`;
      }
      // Scan pipeline (collect_scan_recipe): 使用纯文本总结
      if (submitToolName === 'collect_scan_recipe') {
        return `你已通过 collect_scan_recipe 提交了 ${submitCount} 个知识候选。` +
          `请**停止调用工具**，直接输出你的分析总结（Markdown 格式）。\n` +
          `⚠️ 不要再调用任何工具，直接输出文本。`;
      }
      // Bootstrap: 使用 dimensionDigest JSON (供维度编排消费)
      return `你已完成分析探索。请在回复中直接输出 dimensionDigest JSON（用 \`\`\`json 包裹），包含以下字段：\n` +
        `\`\`\`json\n{"dimensionDigest":{"summary":"分析总结(100-200字)","candidateCount":${submitCount},"keyFindings":["关键发现"],"crossRefs":{},"gaps":["未覆盖方面"],"remainingTasks":[{"signal":"未处理的信号/主题","reason":"未完成原因(如:提交上限已达)","priority":"high|medium|low","searchHints":["建议搜索词"]}]}}\n\`\`\`\n> 如果所有信号都已覆盖，remainingTasks 留空数组 \`[]\`。如果有未来得及处理的信号，请在此标记，系统会在下次运行时续传。\n` +
        `⚠️ 严禁在回复中复制本条指令文字，只输出 JSON。`;
    }

    if (toPhase === 'EXPLORE' && fromPhase === 'SCAN') {
      return '全局扫描完成。现在开始定向搜索——根据你发现的项目结构，搜索关键模式和类。';
    }

    if (toPhase === 'VERIFY') {
      return '搜索阶段信息已饱和。现在进入验证阶段——读取最关键的源文件，确认细节和实现逻辑。';
    }

    return `阶段切换: ${fromPhase} → ${toPhase}`;
  }

  /**
   * 获取当前阶段的上下文状态行（注入 systemPrompt 尾部）
   * @param {NudgeState} state
   * @returns {string}
   */
  getPhaseContext(state) {
    const { phase, metrics: m, budget: b, isTerminalPhase } = state;
    const remaining = b.maxIterations - m.iteration;

    // 接近上限时的紧急警告
    if (remaining <= 2 && remaining > 0 && !isTerminalPhase) {
      return `\n\n## 当前状态\n⚠️ 仅剩 ${remaining} 轮次即达上限，请尽快完成当前工作并准备输出总结。`;
    }

    // 阶段特定提示
    const phaseHint = this.#getPhaseHint(state);
    if (phaseHint) {
      return `\n\n## 当前状态\n${phaseHint}`;
    }

    // 通用进度行
    const phaseLabel = NudgeGenerator.#getPhaseLabel(phase);
    return `\n\n## 当前进度\n第 ${m.iteration}/${b.maxIterations} 轮 | ${phaseLabel} | 剩余 ${remaining} 轮`;
  }

  // ─── 内部方法 ──────────────────────────────────

  #generateForceExit(m, b, strategy, submitToolName) {
    const submitCount = m.submitCount;
    // v5.1: Analyst 策略使用纯文本输出
    if (strategy.name === 'analyst') {
      return {
        type: 'force_exit',
        text: `⚠️ **轮次耗尽** (${m.iteration}/${b.maxIterations})。你必须**立即停止工具调用**，在回复中输出你的**分析总结报告**。\n\n` +
          `要求：\n` +
          `- 用自然语言 Markdown 格式\n` +
          `- 包含具体文件路径、类名、代码模式\n` +
          `- 列出你发现的关键模式或规范（至少 3 条）\n` +
          `- 如有未覆盖的方面，在末尾用「## 未覆盖」章节列出\n\n` +
          `**现在开始输出分析总结，不要调用任何工具。**\n` +
          `⛔ 严禁在回复中复制或引用本条指令的任何文字，只输出你自己的分析。`,
      };
    }
    // Scan pipeline (collect_scan_recipe): 使用纯文本总结, 不需要 dimensionDigest
    if (submitToolName === 'collect_scan_recipe') {
      return {
        type: 'force_exit',
        text: `⚠️ **轮次耗尽** (${m.iteration}/${b.maxIterations})。你必须**立即停止工具调用**。\n\n` +
          `已通过 collect_scan_recipe 提交了 ${submitCount} 个知识候选。` +
          `请直接输出你的分析总结（Markdown 格式），列出已发现和未覆盖的关键模式。\n` +
          `⛔ 不要再调用任何工具，直接输出文本。`,
      };
    }
    // Bootstrap 策略: 使用 dimensionDigest JSON (供维度编排消费)
    return {
      type: 'force_exit',
      text: `⚠️ 你已使用 ${m.iteration}/${b.maxIterations} 轮次，**必须立即结束**。请在回复中直接输出 dimensionDigest JSON 总结（用 \`\`\`json 包裹），不要再调用任何工具。\n` +
        `\`\`\`json\n{"dimensionDigest":{"summary":"分析总结","candidateCount":${submitCount},"keyFindings":["发现"],"crossRefs":{},"gaps":["缺口"],"remainingTasks":[{"signal":"未处理信号","reason":"轮次耗尽","priority":"high","searchHints":["搜索词"]}]}}\n\`\`\`\n> remainingTasks: 列出未来得及处理的信号。已覆盖则留空 \`[]\`。\n` +
        `⛔ 严禁在回复中复制本条指令文字，只输出 JSON。`,
    };
  }

  /**
   * 检查是否需要触发反思 + 生成反思 nudge
   * @param {NudgeState} state
   * @param {object|null} trace
   * @returns {{ type: string, text: string }|null}
   */
  #checkReflection(state, trace) {
    const { phase, metrics: m, budget: b, strategy, isTerminalPhase } = state;

    // 终结阶段（SUMMARIZE）不应触发反思 — 此时应输出最终结果而非继续探索
    if (isTerminalPhase) return null;

    const interval = strategy.reflectionInterval || DEFAULT_REFLECTION_INTERVAL;

    const periodicTrigger = m.iteration > 1 && interval > 0 && m.iteration % interval === 0;
    const staleTrigger =
      m.roundsSinceNewInfo >= DEFAULT_STALE_THRESHOLD &&
      m.iteration >= MIN_ITERS_FOR_STALE_REFLECTION;

    if (!periodicTrigger && !staleTrigger) return null;

    const summary = trace?.getRecentSummary?.(interval || 3);
    if (!summary) return null;

    const stats = trace?.getStats?.() || {};
    const remaining = b.maxIterations - m.iteration;
    const progressPct = Math.round((m.iteration / b.maxIterations) * 100);

    const parts = [];
    if (staleTrigger) {
      parts.push(
        `📊 停滞反思 (第 ${m.iteration}/${b.maxIterations} 轮, 连续 ${m.roundsSinceNewInfo} 轮无新信息):`
      );
    } else {
      parts.push(`📊 中期反思 (第 ${m.iteration}/${b.maxIterations} 轮, ${progressPct}% 预算):`);
    }

    if (summary.thoughts?.length > 0) {
      parts.push(
        `\n你最近的思考方向:\n${summary.thoughts.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}`
      );
    }

    parts.push(
      `\n行动效率: 最近 ${summary.roundCount} 轮中 ${Math.round(summary.newInfoRatio * 100)}% 获取到新信息`
    );
    parts.push(
      `累计: ${m.uniqueFiles.size} 文件, ${m.uniquePatterns.size} 搜索模式, ${stats.totalActions || 0} 次工具调用`
    );

    // Planning 进度附加
    if (strategy.enablePlanning) {
      const plan = trace?.getPlan?.();
      if (plan?.steps?.length > 0) {
        const doneCount = plan.steps.filter((s) => s.status === 'done').length;
        parts.push(`\n📋 计划进度: ${doneCount}/${plan.steps.length} 步骤已完成`);
      }
    }

    // 阶段化评估问题
    if (phase === 'EXPLORE' || phase === 'SCAN' || phase === 'VERIFY') {
      parts.push(
        `\n请评估:\n1. 到目前为止最重要的发现是什么？\n2. 还有哪些关键方面未覆盖？\n3. 剩余 ${remaining} 轮，最有价值的下一步是什么？`
      );
    } else if (phase === 'PRODUCE') {
      parts.push(
        `\n请评估:\n1. 已提交的候选是否覆盖了核心发现？\n2. 是否有高价值知识点被遗漏？`
      );
    }

    parts.push(`\n⚠️ 以上是行为指令，严禁在回复中复制或引用这段文字，用你自己的分析内容回答。`);
    const reflectionText = parts.join('\n');
    trace?.setReflection?.(reflectionText);

    return { type: 'reflection', text: reflectionText };
  }

  /**
   * 获取当前阶段的 hint
   * @param {NudgeState} state
   * @returns {string|null}
   */
  #getPhaseHint(state) {
    const { phase, metrics: m, budget: b, submitToolName } = state;

    switch (phase) {
      case 'EXPLORE':
        if (m.searchRoundsInPhase >= b.searchBudget - 2) {
          return `搜索预算即将耗尽 (${m.searchRoundsInPhase}/${b.searchBudget})，请准备提交候选或产出摘要。`;
        }
        return null;

      case 'PRODUCE':
        if (m.submitCount === 0 && m.phaseRounds >= 1) {
          return `⚠️ 探索阶段已结束。你已收集了足够的项目信息，请 **立即** 调用 ${submitToolName} 提交候选。不要继续搜索，直接提交。`;
        }
        if (m.submitCount >= b.softSubmitLimit && b.softSubmitLimit > 0) {
          const remaining = b.maxSubmits - m.submitCount;
          if (submitToolName === 'collect_scan_recipe') {
            return `已提交 ${m.submitCount} 个候选（上限 ${b.maxSubmits}）。${remaining > 0 ? `还可提交 ${remaining} 个。` : ''}如果还有值得记录的发现可以继续提交，否则请输出分析总结。`;
          }
          return `已提交 ${m.submitCount} 个候选（上限 ${b.maxSubmits}）。${remaining > 0 ? `还可提交 ${remaining} 个。` : ''}如果还有值得记录的发现可以继续提交，否则请产出 dimensionDigest 总结。\n⚠️ 如果还有未处理的信号，请在 dimensionDigest 的 remainingTasks 字段中标记，下次运行时会续传。`;
        }
        return null;

      case 'SCAN':
        return '当前处于全局扫描阶段，请先获取项目概览和目录结构。';

      case 'VERIFY':
        return '当前处于验证阶段，请阅读关键源文件确认实现细节。';

      default:
        return null;
    }
  }

  /**
   * 获取用户友好的阶段标签
   * @param {string} phase
   * @returns {string}
   */
  static #getPhaseLabel(phase) {
    switch (phase) {
      case 'SCAN': return '扫描阶段';
      case 'EXPLORE': return '探索阶段';
      case 'PRODUCE': return '提交阶段';
      case 'VERIFY': return '验证阶段';
      case 'SUMMARIZE': return '⚠ 总结阶段 — 请停止工具调用，直接输出分析文本';
      default: return phase;
    }
  }
}
