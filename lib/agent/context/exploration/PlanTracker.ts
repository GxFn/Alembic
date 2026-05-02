/**
 * PlanTracker — 探索计划跟踪器
 *
 * 从 ExplorationTracker.js 提取的规划与质量评估逻辑。
 * 管理首轮 plan elicitation、周期性 replan、计划进度匹配和质量评分。
 *
 * @module PlanTracker
 */
import { DEFAULT_REPLAN_INTERVAL } from './ExplorationStrategies.js';

// ─── 类型定义 ──────────────────────────────────────────

/** Plan 步骤 */
interface PlanStep {
  description: string;
  status: 'pending' | 'done';
  keywords?: string[];
}

/** Plan 对象 */
interface Plan {
  steps: PlanStep[];
  createdAtIteration: number;
}

/** Trace 统计数据 */
interface TraceStats {
  totalRounds: number;
  thoughtCount: number;
  totalActions: number;
  totalObservations: number;
  reflectionCount: number;
}

/** 工具动作 */
interface ToolAction {
  tool: string;
  params?: Record<string, unknown>;
}

/** ActiveContext 追踪接口 */
export interface ActiveTrace {
  expectPlan?(): void;
  getPlan?(): Plan | null;
  getPlanStepsMutable?(): PlanStep[];
  getCurrentRoundActions?(): ToolAction[];
  getStats?(): TraceStats;
}

/** checkPlanning 的状态参数 */
interface PlanCheckState {
  metrics: { iteration: number };
  budget: { maxIterations: number };
  strategy: { replanInterval?: number };
}

/** 计划进度 */
interface PlanProgress {
  coveredSteps: number;
  totalSteps: number;
  deviationScore: number;
  unplannedActions: number;
  lastReplanIteration: number | null;
  consecutiveOffPlan: number;
}

// ─── 常量 ──────────────────────────────────────────────

/** 默认偏差阈值 */
const DEFAULT_DEVIATION_THRESHOLD = 0.6;
/** 最少经过 N 轮后才允许再次触发 replan（防止 replan 风暴） */
const MIN_REPLAN_GAP = 3;

export class PlanTracker {
  /** 等待 AI 输出 replan */
  #pendingReplan = false;
  /** 计划进度 */
  #planProgress: PlanProgress = {
    coveredSteps: 0,
    totalSteps: 0,
    deviationScore: 0,
    unplannedActions: 0,
    lastReplanIteration: null,
    consecutiveOffPlan: 0,
  };

  /** 获取计划进度 */
  get progress() {
    return { ...this.#planProgress };
  }

  /**
   * 检查是否需要触发规划 + 生成规划 nudge
   *
   * @param state 从 ExplorationTracker 传入
   * @param trace ActiveContext 实例
   * @returns |null}
   */
  checkPlanning(state: PlanCheckState, trace: ActiveTrace | null) {
    const { metrics, budget: b, strategy } = state;
    const m = metrics;

    // 第 1 轮: plan elicitation
    if (m.iteration === 1) {
      trace?.expectPlan?.();
      return {
        type: 'planning',
        text: this.#buildPlanElicitationPrompt(b.maxIterations || 30),
      };
    }

    // 有计划时: 检查 replan
    const plan = trace?.getPlan?.();
    if (!plan) {
      return null;
    }

    const progress = this.#planProgress;
    const interval = strategy.replanInterval || DEFAULT_REPLAN_INTERVAL;

    const baseIteration = progress.lastReplanIteration || plan.createdAtIteration;
    const periodicTrigger =
      interval > 0 && m.iteration > 1 && m.iteration - baseIteration >= interval;
    const deviationTrigger =
      progress.consecutiveOffPlan >= 3 ||
      (progress.totalSteps > 0 && progress.deviationScore > DEFAULT_DEVIATION_THRESHOLD);

    if (!periodicTrigger && !deviationTrigger) {
      return null;
    }

    // 冷却间隔
    if (
      progress.lastReplanIteration &&
      m.iteration - progress.lastReplanIteration < MIN_REPLAN_GAP
    ) {
      return null;
    }

    const remaining = b.maxIterations - m.iteration;
    const parts: string[] = [];
    if (deviationTrigger) {
      parts.push(`📋 计划偏差检查 (第 ${m.iteration}/${b.maxIterations} 轮):`);
      if (progress.consecutiveOffPlan >= 3) {
        parts.push(`你的行为已连续 ${progress.consecutiveOffPlan} 轮偏离原定计划。`);
      }
    } else {
      parts.push(`📋 计划进度回顾 (第 ${m.iteration}/${b.maxIterations} 轮):`);
    }

    const doneSteps = plan.steps.filter((s: PlanStep) => s.status === 'done');
    const pendingSteps = plan.steps.filter((s: PlanStep) => s.status === 'pending');
    if (doneSteps.length > 0) {
      parts.push(`\n✅ 已完成 (${doneSteps.length}/${plan.steps.length}):`);
      for (const s of doneSteps) {
        parts.push(`  - ${s.description}`);
      }
    }
    if (pendingSteps.length > 0) {
      parts.push(`\n⏳ 未完成 (${pendingSteps.length}/${plan.steps.length}):`);
      for (const s of pendingSteps) {
        parts.push(`  - ${s.description}`);
      }
    }
    if (progress.unplannedActions > 0) {
      parts.push(`\n⚡ 计划外行为: ${progress.unplannedActions} 次`);
    }
    parts.push(`\n剩余 ${remaining} 轮。请评估:`);
    parts.push(`1. 未完成的步骤是否仍然相关？`);
    parts.push(`2. 是否需要根据新发现调整后续步骤？`);
    parts.push(`3. 请更新你的探索计划（用编号列表）。`);

    progress.lastReplanIteration = m.iteration;
    this.#pendingReplan = true;
    trace?.expectPlan?.();

    return { type: 'planning', text: parts.join('\n') };
  }

  /**
   * 更新计划进度（从 ReasoningLayer 迁入）
   * 将本轮工具调用与 plan 步骤进行模糊匹配
   *
   * @param trace ActiveContext 实例
   */
  updatePlanProgress(trace: ActiveTrace | null) {
    const steps = trace?.getPlanStepsMutable?.() || [];
    if (steps.length === 0) {
      return;
    }

    // 处理 pending replan
    if (this.#pendingReplan) {
      const plan = trace?.getPlan?.();
      if (plan) {
        this.#planProgress.coveredSteps = plan.steps.filter(
          (s: PlanStep) => s.status === 'done'
        ).length;
        this.#planProgress.totalSteps = plan.steps.length;
        this.#planProgress.unplannedActions = 0;
        this.#planProgress.consecutiveOffPlan = 0;
        this.#pendingReplan = false;
      }
    }

    const actions = trace?.getCurrentRoundActions?.() || [];
    if (actions.length === 0) {
      return;
    }

    let matchedThisRound = false;

    for (const action of actions) {
      const matchedStep = this.#findMatchingStep(steps, action);
      if (matchedStep) {
        matchedStep.status = 'done';
        matchedThisRound = true;
      } else {
        this.#planProgress.unplannedActions++;
      }
    }

    if (matchedThisRound) {
      this.#planProgress.consecutiveOffPlan = 0;
    } else {
      this.#planProgress.consecutiveOffPlan++;
    }

    this.#planProgress.coveredSteps = steps.filter((s: PlanStep) => s.status === 'done').length;
    this.#planProgress.totalSteps = steps.length;
    this.#planProgress.deviationScore =
      steps.length > 0 ? 1 - this.#planProgress.coveredSteps / steps.length : 0;
  }

  /**
   * 推理质量评分
   * @returns }
   */
  getQualityMetrics(trace: ActiveTrace | null) {
    const stats = trace?.getStats?.() || {
      totalRounds: 0,
      thoughtCount: 0,
      totalActions: 0,
      totalObservations: 0,
      reflectionCount: 0,
    };
    const totalRounds = stats.totalRounds || 1;

    const thoughtRatio = stats.thoughtCount / totalRounds;
    const reflectionRatio = stats.reflectionCount / totalRounds;
    const actionEfficiency = Math.min(stats.totalActions / totalRounds / 3, 1);
    const observationCoverage = stats.totalObservations > 0 ? 1 : 0;

    const plan = trace?.getPlan?.();
    const hasPlan = plan && plan.steps.length > 0;
    let planScore = 0;
    if (hasPlan) {
      const completionRate =
        this.#planProgress.totalSteps > 0
          ? this.#planProgress.coveredSteps / this.#planProgress.totalSteps
          : 0;
      const adherenceRate = 1 - (this.#planProgress.deviationScore || 0);
      planScore = completionRate * 0.6 + adherenceRate * 0.4;
    }

    const score = hasPlan
      ? Math.round(
          (thoughtRatio * 0.3 +
            reflectionRatio * 0.15 +
            actionEfficiency * 0.15 +
            observationCoverage * 0.15 +
            planScore * 0.25) *
            100
        )
      : Math.round(
          (thoughtRatio * 0.4 +
            reflectionRatio * 0.2 +
            actionEfficiency * 0.2 +
            observationCoverage * 0.2) *
            100
        );

    const breakdown: Record<string, number> = {
      ...stats,
      thoughtRatio: Math.round(thoughtRatio * 100),
      reflectionRatio: Math.round(reflectionRatio * 100),
      actionEfficiency: Math.round(actionEfficiency * 100),
      observationCoverage: Math.round(observationCoverage * 100),
    };

    if (hasPlan) {
      breakdown.planCompletion = Math.round(
        (this.#planProgress.totalSteps > 0
          ? this.#planProgress.coveredSteps / this.#planProgress.totalSteps
          : 0) * 100
      );
      breakdown.planAdherence = Math.round((1 - (this.#planProgress.deviationScore || 0)) * 100);
      breakdown.planScore = Math.round(planScore * 100);
    }

    return { score, breakdown };
  }

  // ─── 内部方法 ──────────────────────────────────

  #buildPlanElicitationPrompt(maxIter: number) {
    return [
      `📋 在开始探索前，请先制定一个简要的探索计划。`,
      ``,
      `你有 ${maxIter} 轮工具调用机会。请在你的回复中用编号列表简述 3-6 个探索步骤:`,
      `- 每个步骤应描述要搜索/阅读的目标（具体的类名、模式、文件路径）`,
      `- 步骤应从宏观到微观递进（先概览 → 再搜索关键模式 → 再深入关键文件）`,
      `- 最后一步应是"总结分析发现"`,
      ``,
      `例如:`,
      `1. 获取项目概览和目录结构，识别核心模块`,
      `2. 搜索网络请求相关类，分析请求模式`,
      `3. 搜索错误处理和响应解析模式`,
      `4. 深入阅读 3-5 个典型实现文件，确认关键细节`,
      `5. 总结分析发现`,
      ``,
      `制定计划后请立即开始执行第 1 步（可在同一轮中同时输出计划文本并调用工具）。`,
    ].join('\n');
  }

  /**
   * 模糊匹配: 将工具调用匹配到 plan 步骤
   * @param action { tool, params }
   */
  #findMatchingStep(steps: PlanStep[], action: ToolAction): PlanStep | null {
    const toolName = action.tool;
    const argsStr = JSON.stringify(action.params || {}).toLowerCase();

    for (const step of steps) {
      if (step.status === 'done') {
        continue;
      }

      // 策略 1: 关键词匹配
      if ((step.keywords?.length ?? 0) > 0) {
        const matched = step.keywords!.some((kw: string) => argsStr.includes(kw.toLowerCase()));
        if (matched) {
          return step;
        }
      }

      // 策略 2: 工具类型 → 步骤描述的语义匹配
      const desc = step.description.toLowerCase();
      const actionName = (action.params?.action as string) || '';

      if (
        toolName === 'code' &&
        actionName === 'structure' &&
        (desc.includes('概览') ||
          desc.includes('overview') ||
          desc.includes('目录') ||
          desc.includes('结构') ||
          desc.includes('structure') ||
          desc.includes('项目'))
      ) {
        return step;
      }
      if (
        toolName === 'graph' &&
        (desc.includes('继承') ||
          desc.includes('类') ||
          desc.includes('hierarchy') ||
          desc.includes('class') ||
          desc.includes('图谱') ||
          desc.includes('graph') ||
          desc.includes('调用') ||
          desc.includes('call') ||
          desc.includes('关系') ||
          desc.includes('依赖'))
      ) {
        return step;
      }
      if (
        toolName === 'code' &&
        actionName === 'read' &&
        (desc.includes('阅读') ||
          desc.includes('read') ||
          desc.includes('深入') ||
          desc.includes('查看') ||
          desc.includes('文件'))
      ) {
        return step;
      }
      if (
        toolName === 'code' &&
        actionName === 'search' &&
        (desc.includes('搜索') ||
          desc.includes('search') ||
          desc.includes('查找') ||
          desc.includes('分析'))
      ) {
        return step;
      }
    }

    return null;
  }
}
