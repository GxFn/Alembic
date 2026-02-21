/**
 * TaskPipeline — 轻量级 DAG 任务编排引擎
 *
 * 从旧版 ToolOrchestrator 精简而来，保留核心 DAG 能力：
 *   1. 步骤间依赖声明（dependsOn）
 *   2. 参数引用映射（'stepName:path' / 'input:path'）
 *   3. 拓扑排序 → 同层并行执行（Promise.all）
 *   4. 错误策略（continue / fail）+ 重试
 *   5. 条件跳过（when 回调）
 *
 * 与 ChatAgent / ToolRegistry 的关系：
 *   - TaskPipeline 不直接持有 ToolRegistry 引用
 *   - 通过 executor 函数抽象：executor(toolName, params) → result
 *   - ChatAgent 传入 this.executeTool.bind(this) 即可
 *
 * 使用示例：
 * ```js
 * const pipeline = new TaskPipeline('bootstrap_full_pipeline', [
 *   { name: 'bootstrap', tool: 'bootstrap_knowledge', params: { maxFiles: 500, loadSkills: true } },
 *   { name: 'enrich',    tool: 'enrich_candidate',
 *     params: { candidateIds: 'bootstrap:bootstrapCandidates.ids' },
 *     dependsOn: ['bootstrap'] },
 *   { name: 'refine',    tool: 'refine_bootstrap_candidates',
 *     params: { userPrompt: 'input:refinePrompt' },
 *     dependsOn: ['enrich'],
 *     when: (ctx) => ctx._results.bootstrap?.bootstrapCandidates?.created > 0 },
 * ]);
 * const result = await pipeline.execute(executor, { refinePrompt: '...' });
 * ```
 *
 * 步骤定义 (StepDef):
 * @typedef {object} StepDef
 * @property {string}   name          — 步骤唯一名称
 * @property {string}   tool          — 工具名称（传给 executor）
 * @property {object}   [params={}]   — 参数对象（支持引用：'stepName:path' / 'input:path' / function(ctx)）
 * @property {string[]} [dependsOn]   — 依赖步骤名称数组
 * @property {Function} [when]        — 条件回调 (ctx) => boolean，返回 false 则跳过此步骤
 * @property {string}   [errorStrategy='fail'] — 'fail' 中断 | 'continue' 继续
 * @property {number}   [retries=1]   — 最大执行次数（含首次）
 * @property {number}   [retryDelay=0]— 重试间隔 ms
 * @property {Function} [transform]   — (result, ctx) => transformedResult，对工具返回值后处理
 */

import Logger from '../../infrastructure/logging/Logger.js';

export class TaskPipeline {
  /** @type {string} */
  #id;
  /** @type {StepDef[]} */
  #steps;
  /** @type {import('../../infrastructure/logging/Logger.js').default} */
  #logger;

  /**
   * @param {string} id — 管线唯一标识
   * @param {StepDef[]} steps — 步骤定义数组
   */
  constructor(id, steps) {
    this.#id = id;
    this.#steps = steps;
    this.#logger = Logger.getInstance();
    this.#validate();
  }

  // ─── 公共 API ─────────────────────────────────────────

  /** 管线 ID */
  get id() {
    return this.#id;
  }

  /** 步骤数 */
  get size() {
    return this.#steps.length;
  }

  /**
   * 执行管线
   *
   * @param {(toolName: string, params: object) => Promise<any>} executor
   *   工具执行函数，通常是 ChatAgent.executeTool.bind(chatAgent)
   * @param {object} [inputs={}] — 管线初始输入（通过 'input:key' 引用）
   * @returns {Promise<PipelineResult>}
   *
   * @typedef {object} PipelineResult
   * @property {boolean}  success   — 全部步骤成功（或被允许失败）
   * @property {string}   pipelineId
   * @property {object}   outputs   — { stepName: result }
   * @property {object[]} trace     — 执行轨迹 [{ step, status, durationMs, error? }]
   * @property {number}   durationMs
   */
  async execute(executor, inputs = {}) {
    const t0 = Date.now();
    const ctx = {
      _pipelineId: this.#id,
      _inputs: inputs,
      _results: {},
    };
    const trace = [];

    // 拓扑排序 → 按层并行
    const phases = this.#topologicalSort();

    this.#logger.info(
      `[TaskPipeline] "${this.#id}" start — ${this.#steps.length} steps, ${phases.length} phases`
    );

    for (const phase of phases) {
      const promises = phase.map((stepName) => this.#executeStep(stepName, executor, ctx, trace));
      const results = await Promise.allSettled(promises);

      // 检查是否有 fail 策略的步骤失败
      for (const r of results) {
        if (r.status === 'rejected') {
          this.#logger.error(`[TaskPipeline] "${this.#id}" aborted`, { error: r.reason?.message });
          return {
            success: false,
            pipelineId: this.#id,
            outputs: ctx._results,
            trace,
            durationMs: Date.now() - t0,
            error: r.reason?.message,
          };
        }
      }
    }

    this.#logger.info(`[TaskPipeline] "${this.#id}" done — ${Date.now() - t0}ms`);
    return {
      success: true,
      pipelineId: this.#id,
      outputs: ctx._results,
      trace,
      durationMs: Date.now() - t0,
    };
  }

  // ─── 内部实现 ─────────────────────────────────────────

  /**
   * 执行单个步骤（含 when 判断、重试、erorrStrategy）
   */
  async #executeStep(stepName, executor, ctx, trace) {
    const step = this.#steps.find((s) => s.name === stepName);
    const t0 = Date.now();

    // ── when 条件 ──
    if (step.when && !step.when(ctx)) {
      const entry = { step: stepName, status: 'skipped', durationMs: 0 };
      trace.push(entry);
      this.#logger.debug(`[TaskPipeline] Step "${stepName}" skipped (when=false)`);
      ctx._results[stepName] = { _skipped: true };
      return;
    }

    // ── 解析参数 ──
    const params = this.#resolveParams(step.params || {}, ctx);

    // ── 执行（含重试）──
    const maxAttempts = step.retries || 1;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.#logger.debug(`[TaskPipeline] Step "${stepName}" attempt ${attempt}/${maxAttempts}`);
        let result = await executor(step.tool, params);

        // transform 后处理
        if (step.transform) {
          result = step.transform(result, ctx);
        }

        ctx._results[stepName] = result;
        trace.push({ step: stepName, status: 'ok', durationMs: Date.now() - t0, attempt });
        return;
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts && step.retryDelay) {
          await new Promise((r) => setTimeout(r, step.retryDelay));
        }
      }
    }

    // ── 全部重试失败 ──
    const errorMsg = lastError?.message || 'unknown error';
    trace.push({
      step: stepName,
      status: 'failed',
      durationMs: Date.now() - t0,
      error: errorMsg,
      attempts: maxAttempts,
    });
    ctx._results[stepName] = { _error: errorMsg };

    if ((step.errorStrategy || 'fail') === 'fail') {
      throw new Error(`[TaskPipeline] Step "${stepName}" failed: ${errorMsg}`);
    }
    // errorStrategy: 'continue' → 不抛异常
    this.#logger.warn(`[TaskPipeline] Step "${stepName}" failed (continue): ${errorMsg}`);
  }

  /**
   * 解析参数引用
   *
   * 规则:
   *   'input:key'       → ctx._inputs.key
   *   'stepName:path'   → ctx._results.stepName.path (支持嵌套 a.b.c)
   *   function(ctx)     → 执行函数获取值
   *   其他              → 字面值
   */
  #resolveParams(params, ctx) {
    const resolved = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'function') {
        resolved[key] = value(ctx);
      } else if (typeof value === 'string' && value.includes(':')) {
        const colonIdx = value.indexOf(':');
        const source = value.substring(0, colonIdx);
        const path = value.substring(colonIdx + 1);

        if (source === 'input') {
          resolved[key] = this.#getNestedValue(ctx._inputs, path);
        } else if (ctx._results[source] !== undefined) {
          resolved[key] = this.#getNestedValue(ctx._results[source], path);
        } else {
          // 无法解析 → 保留原始字符串（可能是普通 URL 等含冒号的值）
          resolved[key] = value;
        }
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }

  /**
   * 嵌套取值: 'a.b.c' → obj.a.b.c
   */
  #getNestedValue(obj, path) {
    if (obj == null) {
      return undefined;
    }
    return path.split('.').reduce((acc, key) => acc?.[key], obj);
  }

  /**
   * 拓扑排序 → 分层（同层可并行）
   * @returns {string[][]} phases — [[stepA, stepB], [stepC], ...]
   */
  #topologicalSort() {
    const graph = new Map();
    for (const step of this.#steps) {
      graph.set(step.name, step.dependsOn || []);
    }

    // 检测环 + 拓扑排序
    const visited = new Set();
    const visiting = new Set();
    const sorted = [];

    const visit = (name) => {
      if (visited.has(name)) {
        return;
      }
      if (visiting.has(name)) {
        throw new Error(`[TaskPipeline] Circular dependency: ${name}`);
      }
      visiting.add(name);
      for (const dep of graph.get(name) || []) {
        visit(dep);
      }
      visiting.delete(name);
      visited.add(name);
      sorted.push(name);
    };

    for (const name of graph.keys()) {
      visit(name);
    }

    // 分层：按最大依赖深度
    const depth = new Map();
    for (const name of sorted) {
      const deps = graph.get(name) || [];
      const d = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => (depth.get(dep) || 0) + 1));
      depth.set(name, d);
    }

    const maxDepth = Math.max(0, ...depth.values());
    const phases = Array.from({ length: maxDepth + 1 }, () => []);
    for (const [name, d] of depth) {
      phases[d].push(name);
    }

    return phases.filter((p) => p.length > 0);
  }

  /**
   * 校验步骤定义
   */
  #validate() {
    const names = new Set();
    for (const step of this.#steps) {
      if (!step.name) {
        throw new Error('[TaskPipeline] Step must have a name');
      }
      if (!step.tool) {
        throw new Error(`[TaskPipeline] Step "${step.name}" must have a tool`);
      }
      if (names.has(step.name)) {
        throw new Error(`[TaskPipeline] Duplicate step name: "${step.name}"`);
      }
      names.add(step.name);
    }
    // 检查 dependsOn 引用是否存在
    for (const step of this.#steps) {
      for (const dep of step.dependsOn || []) {
        if (!names.has(dep)) {
          throw new Error(`[TaskPipeline] Step "${step.name}" depends on unknown step "${dep}"`);
        }
      }
    }
  }

  /**
   * 获取管线的描述信息（用于调试/日志）
   */
  describe() {
    const phases = this.#topologicalSort();
    return {
      id: this.#id,
      steps: this.#steps.map((s) => ({
        name: s.name,
        tool: s.tool,
        dependsOn: s.dependsOn || [],
        errorStrategy: s.errorStrategy || 'fail',
        hasWhen: !!s.when,
      })),
      phases: phases.map((p, i) => ({ phase: i, parallel: p })),
    };
  }
}

// ─── 便捷工厂函数 ────────────────────────────────────────

/**
 * 快速创建管线（函数式 API）
 *
 * @param {string} id
 * @param {StepDef[]} steps
 * @returns {TaskPipeline}
 */
export function createPipeline(id, steps) {
  return new TaskPipeline(id, steps);
}

export default TaskPipeline;
