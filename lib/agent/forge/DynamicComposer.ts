/**
 * DynamicComposer — 运行时动态工具组合
 *
 * 将已有的原子工具按 sequential / parallel / conditional 策略组合成复合工具。
 * 组合结果注册为临时工具（通过 TemporaryToolRegistry）。
 *
 * 与 PipelineStrategy 的区别：
 *   - PipelineStrategy 是 Agent 执行策略（Agent 层）
 *   - DynamicComposer 是工具组合（Tool 层），产出物是单个工具
 */

import Logger from '#infra/logging/Logger.js';

/* ────────────────────── Types ────────────────────── */

interface ToolRegistryLike {
  has(name: string): boolean;
  execute(
    name: string,
    params: Record<string, unknown>,
    context?: Record<string, unknown>
  ): Promise<unknown>;
}

export interface CompositionStep {
  /** 要调用的工具名 */
  tool: string;
  /** 静态参数或从前一步结果构造参数的函数 */
  args: Record<string, unknown> | ((prevResult: unknown) => Record<string, unknown>);
  /** 可选：提取该步结果中的特定字段传给下一步 */
  extractKey?: string;
}

export interface CompositionSpec {
  /** 组合工具的名称 */
  name: string;
  /** 描述 */
  description: string;
  /** 执行步骤 */
  steps: CompositionStep[];
  /** 合并策略 */
  mergeStrategy: 'sequential' | 'parallel';
  /** JSON Schema 参数定义 */
  parameters?: Record<string, unknown>;
}

export interface CompositionResult {
  /** 是否成功 */
  success: boolean;
  /** 组合工具 handler */
  handler?: (params: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>;
  /** 失败原因 */
  error?: string;
}

/* ────────────────────── Class ────────────────────── */

export class DynamicComposer {
  #registry: ToolRegistryLike;
  #logger = Logger.getInstance();

  constructor(registry: ToolRegistryLike) {
    this.#registry = registry;
  }

  /**
   * 验证组合 spec 的可行性（所有工具是否存在）
   */
  validate(spec: CompositionSpec): { valid: boolean; missingTools: string[] } {
    const missing: string[] = [];

    for (const step of spec.steps) {
      if (!this.#registry.has(step.tool)) {
        missing.push(step.tool);
      }
    }

    return { valid: missing.length === 0, missingTools: missing };
  }

  /**
   * 构建组合工具
   */
  compose(spec: CompositionSpec): CompositionResult {
    // 验证
    const { valid, missingTools } = this.validate(spec);
    if (!valid) {
      return {
        success: false,
        error: `Missing tools: ${missingTools.join(', ')}`,
      };
    }

    if (spec.steps.length === 0) {
      return {
        success: false,
        error: 'Composition must have at least one step',
      };
    }

    const registry = this.#registry;
    const logger = this.#logger;

    // 根据策略构建 handler
    const handler =
      spec.mergeStrategy === 'parallel'
        ? this.#buildParallelHandler(spec, registry, logger)
        : this.#buildSequentialHandler(spec, registry, logger);

    return { success: true, handler };
  }

  /* ── Internal ── */

  #buildSequentialHandler(
    spec: CompositionSpec,
    registry: ToolRegistryLike,
    logger: ReturnType<typeof Logger.getInstance>
  ): (params: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown> {
    return async (params, context) => {
      let prevResult: unknown = params;

      for (const step of spec.steps) {
        const args =
          typeof step.args === 'function' ? step.args(prevResult) : { ...step.args, ...params };

        logger.debug(`DynamicComposer [${spec.name}]: executing step "${step.tool}"`);

        const result = await registry.execute(step.tool, args, context);

        if (step.extractKey && typeof result === 'object' && result !== null) {
          prevResult = (result as Record<string, unknown>)[step.extractKey];
        } else {
          prevResult = result;
        }
      }

      return prevResult;
    };
  }

  #buildParallelHandler(
    spec: CompositionSpec,
    registry: ToolRegistryLike,
    logger: ReturnType<typeof Logger.getInstance>
  ): (params: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown> {
    return async (params, context) => {
      logger.debug(
        `DynamicComposer [${spec.name}]: executing ${spec.steps.length} steps in parallel`
      );

      const promises = spec.steps.map(async (step) => {
        const args =
          typeof step.args === 'function' ? step.args(params) : { ...step.args, ...params };

        const result = await registry.execute(step.tool, args, context);

        if (step.extractKey && typeof result === 'object' && result !== null) {
          return { tool: step.tool, result: (result as Record<string, unknown>)[step.extractKey] };
        }
        return { tool: step.tool, result };
      });

      const results = await Promise.allSettled(promises);

      const merged: Record<string, unknown> = {};
      for (const r of results) {
        if (r.status === 'fulfilled') {
          merged[r.value.tool] = r.value.result;
        } else {
          merged[`error_${Object.keys(merged).length}`] = r.reason?.message ?? 'Unknown error';
        }
      }

      return merged;
    };
  }
}
