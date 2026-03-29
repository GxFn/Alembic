/**
 * ToolExecutionPipeline — 工具执行的中间件管道
 *
 * 将 reactLoop 中 ~120 行的工具执行逻辑拆分为独立中间件:
 *   before → execute → after
 *
 * 每个中间件负责一个横切关注点:
 *   1. EventBusPublisher — 事件发布
 *   2. ProgressEmitter — 进度回调
 *   3. SafetyGate — SafetyPolicy 安全拦截
 *   4. CacheCheck — MemoryCoordinator 缓存命中
 *   5. ObservationRecord — 记忆记录
 *   6. TrackerSignal — ExplorationTracker 信号收集
 *   7. TraceRecord — ActiveContext 推理链记录
 *   8. SubmitDedup — 提交去重
 *
 * @module core/ToolExecutionPipeline
 */

import type { AgentRuntime } from '../AgentRuntime.js';
import { SafetyPolicy } from '../policies.js';
import type { LoopContext } from './LoopContext.js';

/** 工具调用描述 */
interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  id: string;
}

/** 工具 Schema 定义 */
interface ToolSchema {
  name?: string;
  function?: { name: string };
}

/** 工具执行上下文 */
interface ToolExecContext {
  runtime: AgentRuntime;
  loopCtx: LoopContext;
  iteration: number;
}

/** 工具执行元数据 */
interface ToolMetadata {
  cacheHit: boolean;
  blocked: boolean;
  isNew: boolean;
  durationMs: number;
  dedupMessage?: string;
  isSubmit?: boolean;
}

/** before 钩子返回值 */
interface BeforeVerdict {
  blocked?: boolean;
  result?: unknown;
}

/** 工具中间件 */
interface ToolMiddleware {
  name: string;
  before?: (
    call: ToolCall,
    ctx: ToolExecContext,
    metadata: ToolMetadata
  ) => BeforeVerdict | undefined | void | Promise<BeforeVerdict | undefined | void>;
  after?: (
    call: ToolCall,
    result: unknown,
    ctx: ToolExecContext,
    metadata: ToolMetadata
  ) => void | Promise<void>;
}

export class ToolExecutionPipeline {
  #middlewares: ToolMiddleware[] = [];

  /** 注册中间件 */
  use(middleware: ToolMiddleware) {
    this.#middlewares.push(middleware);
    return this;
  }

  /**
   * 执行单个工具调用
   *
   * 执行流:
   *   1. 依次调用 before 钩子 — 任一返回 blocked/result 则短路
   *   2. 实际执行工具 (toolRegistry.execute)
   *   3. 依次调用 after 钩子
   *
   * @param call { name, args, id }
   * @param context { runtime, loopCtx, iteration }
   * @returns >}
   */
  async execute(call: ToolCall, context: ToolExecContext) {
    let toolResult: unknown = null;
    const metadata: ToolMetadata = { cacheHit: false, blocked: false, isNew: false, durationMs: 0 };

    // ── before 阶段 ──
    for (const mw of this.#middlewares) {
      if (mw.before) {
        const verdict = await mw.before(call, context, metadata);
        if (verdict?.blocked) {
          toolResult = verdict.result;
          metadata.blocked = true;
          break;
        }
        if (verdict?.result !== undefined) {
          toolResult = verdict.result;
          metadata.cacheHit = true;
          break;
        }
      }
    }

    // ── execute 阶段 ──
    if (toolResult === null) {
      const t0 = Date.now();
      try {
        const { runtime, loopCtx } = context;
        const safetyPolicy = runtime.policies.get?.(SafetyPolicy) || null;
        toolResult = await runtime.toolRegistry.execute(call.name, call.args, {
          agentId: runtime.id,
          source: loopCtx.source || runtime.presetName,
          container: runtime.container,
          safetyPolicy,
          projectRoot: runtime.projectRoot,
          fileCache: runtime.fileCache,
          lang: runtime.lang,
          logger: runtime.logger || null,
          aiProvider: runtime.aiProvider || null,
          // ── bootstrap 维度上下文 (从 sharedState 透传) ──
          _submittedTitles: loopCtx.sharedState?.submittedTitles || null,
          _submittedPatterns: loopCtx.sharedState?.submittedPatterns || null,
          _sharedState: loopCtx.sharedState || null,
          _dimensionMeta: loopCtx.sharedState?._dimensionMeta || null,
          _projectLanguage: loopCtx.sharedState?._projectLanguage || null,
          _memoryCoordinator: loopCtx.memoryCoordinator || null,
          _dimensionScopeId: loopCtx.sharedState?._dimensionScopeId || null,
          _currentRound: loopCtx.iteration || 0,
        });
      } catch (err: unknown) {
        toolResult = { error: (err as Error).message };
      }
      metadata.durationMs = Date.now() - t0;
    }

    // ── after 阶段 ──
    for (const mw of this.#middlewares) {
      if (mw.after) {
        await mw.after(call, toolResult, context, metadata);
      }
    }

    return { result: toolResult, metadata };
  }
}

// ─────────────────────────────────────────────
//  预置中间件
// ─────────────────────────────────────────────

/**
 * AllowlistGate — 工具白名单守卫
 *
 * 防止 LLM hallucinate 不在当前 capability 允许列表中的工具调用。
 * 从 LoopContext.toolSchemas 中提取允许的工具名列表，
 * 拒绝不在列表中的调用（返回 error 提示）。
 *
 * Forge 集成：不在白名单的工具如果已由 ToolForge 锻造（存在于 ToolRegistry），则放行。
 *
 * before: 如果工具不在白名单中且非锻造工具则短路返回 error
 */
export const allowlistGate = {
  name: 'allowlistGate',
  before(call: ToolCall, ctx: ToolExecContext): BeforeVerdict | undefined {
    const schemas: ToolSchema[] | undefined = ctx.loopCtx?.toolSchemas;
    // 如果没有 schema 列表（全工具模式），跳过检查
    if (!schemas || schemas.length === 0) {
      return undefined;
    }

    const allowedNames = new Set(schemas.map((s: ToolSchema) => s.name || s.function?.name));
    if (!allowedNames.has(call.name)) {
      // Forge fallback: 不在白名单但已注册到 ToolRegistry（如锻造的临时工具）则放行
      if (ctx.runtime.toolRegistry?.has(call.name)) {
        ctx.runtime.logger.info(
          `[ToolPipeline] Tool "${call.name}" not in allowlist but exists in registry (forged?) — allowed`
        );
        return undefined;
      }

      ctx.runtime.logger.warn(
        `[ToolPipeline] ⛔ Tool "${call.name}" not in allowlist — blocked (hallucinated call)`
      );
      return {
        blocked: true,
        result: {
          error: `工具 "${call.name}" 不可用。当前可用工具: ${[...allowedNames].slice(0, 5).join(', ')}${allowedNames.size > 5 ? '...' : ''}`,
        },
      };
    }
    return undefined;
  },
};

/**
 * SafetyGate — SafetyPolicy 安全拦截
 *
 * before: 如果策略拒绝则短路返回 error
 */
export const safetyGate = {
  name: 'safetyGate',
  before(call: ToolCall, ctx: ToolExecContext): BeforeVerdict | undefined {
    const check = ctx.runtime.policies.validateToolCall(call.name, call.args);
    if (!check.ok) {
      ctx.runtime.logger.warn(
        `[ToolPipeline] Tool blocked by Policy: ${call.name} — ${check.reason}`
      );
      return { blocked: true, result: { error: check.reason } };
    }
    return undefined;
  },
};

/**
 * CacheCheck — MemoryCoordinator 缓存命中
 *
 * before: 如果缓存命中则短路返回缓存值
 */
export const cacheCheck = {
  name: 'cacheCheck',
  before(call: ToolCall, ctx: ToolExecContext): BeforeVerdict | undefined {
    const mc = ctx.loopCtx.memoryCoordinator;
    if (!mc) {
      return undefined;
    }
    const cached = mc.getCachedResult?.(call.name, call.args);
    if (cached !== null && cached !== undefined) {
      ctx.runtime.logger.info(`[ToolPipeline] 🔧 CACHE HIT: ${call.name} → skipped execution`);
      return { result: cached };
    }
    return undefined;
  },
};

/**
 * ObservationRecord — MemoryCoordinator 观察记录
 *
 * after: 记录工具执行观察
 */
export const observationRecord = {
  name: 'observationRecord',
  after(call: ToolCall, result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    ctx.loopCtx.memoryCoordinator?.recordObservation?.(
      call.name,
      call.args,
      result,
      ctx.iteration,
      meta.cacheHit
    );
  },
};

/**
 * TrackerSignal — ExplorationTracker 信号收集
 *
 * after: 记录工具调用信号，更新 isNew 标记
 */
export const trackerSignal = {
  name: 'trackerSignal',
  after(call: ToolCall, result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    if (ctx.loopCtx.tracker) {
      const r = ctx.loopCtx.tracker.recordToolCall(call.name, call.args, result);
      meta.isNew = r.isNew;
    }
  },
};

/**
 * TraceRecord — ActiveContext 推理链记录
 *
 * after: 记录 Action + Observation 到推理链
 */
export const traceRecord = {
  name: 'traceRecord',
  after(call: ToolCall, result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    ctx.loopCtx.trace?.recordToolCall(call.name, call.args, result, meta.isNew);
  },
};

/**
 * SubmitDedup — 提交去重
 *
 * after: 检查并标记重复提交 (修改 metadata)
 */
export const submitDedup = {
  name: 'submitDedup',
  after(call: ToolCall, result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    const { sharedState } = ctx.loopCtx;
    if (!sharedState) {
      return;
    }
    if (call.name !== 'submit_knowledge' && call.name !== 'submit_with_check') {
      return;
    }

    const title = String(call.args?.title || call.args?.category || '');
    const resultObj = result as Record<string, unknown> | null;
    const isRejected = typeof result === 'object' && resultObj?.status === 'rejected';
    const isError =
      typeof result === 'object' && (resultObj?.error || resultObj?.status === 'error');

    if (!isRejected && !isError && sharedState.submittedTitles) {
      const normalizedTitle = title.toLowerCase().trim();
      if (sharedState.submittedTitles.has(normalizedTitle)) {
        meta.dedupMessage = `⚠ 重复提交: "${title}" 已存在。`;
        ctx.runtime.logger.info(`[ToolPipeline] 🔁 duplicate: "${title}"`);
      } else {
        sharedState.submittedTitles.add(normalizedTitle);
        // 模式指纹去重
        const contentObj = call.args?.content as Record<string, unknown> | undefined;
        const pattern = String(contentObj?.pattern || '');
        if (pattern.length >= 30 && sharedState.submittedPatterns) {
          const fp = pattern
            .replace(/\/\/[^\n]*/g, '')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/[\s]+/g, '')
            .toLowerCase()
            .slice(0, 200);
          if (fp.length >= 20) {
            sharedState.submittedPatterns.add(fp);
          }
        }
        meta.isSubmit = true;
      }
    }
  },
};

/**
 * ProgressEmitter — 进度回调 (可选，需 runtime.emitProgress 为 public)
 *
 * NOTE: 默认管道不包含此中间件，因为 tool_end 事件需要 resultStr.length，
 * 而 resultStr 在管道外部计算。由 #processToolCalls 直接处理。
 */
export const progressEmitter = {
  name: 'progressEmitter',
  before(call: ToolCall, ctx: ToolExecContext) {
    ctx.runtime.emitProgress?.('tool_call', { tool: call.name, args: call.args });
  },
  after(call: ToolCall, result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    const resultObj = result as Record<string, unknown> | null;
    ctx.runtime.emitProgress?.('tool_end', {
      tool: call.name,
      duration: meta.durationMs,
      status: resultObj?.error ? 'error' : 'ok',
      error: (resultObj?.error as string | undefined) || undefined,
    });
  },
};

/**
 * EventBusPublisher — EventBus 事件发布 (可选)
 *
 * NOTE: 默认管道不包含此中间件。由 #processToolCalls 直接处理，
 * 与原始 reactLoop 保持完全一致的事件顺序。
 */
export const eventBusPublisher = {
  name: 'eventBusPublisher',
  before(call: ToolCall, ctx: ToolExecContext) {
    if (ctx.runtime.bus?.publish) {
      ctx.runtime.bus.publish(
        'tool:call:start',
        {
          agentId: ctx.runtime.id,
          tool: call.name,
        },
        { source: ctx.runtime.id }
      );
    }
  },
  after(call: ToolCall, result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    const resultObj = result as Record<string, unknown> | null;
    if (ctx.runtime.bus?.publish) {
      ctx.runtime.bus.publish(
        'tool:call:end',
        {
          agentId: ctx.runtime.id,
          tool: call.name,
          durationMs: meta.durationMs,
          success: !resultObj?.error,
        },
        { source: ctx.runtime.id }
      );
    }
  },
};

// ─────────────────────────────────────────────
//  Factory helper
// ─────────────────────────────────────────────

/**
 * 创建预配置的工具执行管道
 *
 * 中间件顺序:
 *   1. safetyGate (安全拦截 — 可短路)
 *   2. cacheCheck (缓存检查 — 可短路)
 *   3. observationRecord (记忆记录)
 *   4. trackerSignal (信号收集)
 *   5. traceRecord (推理链)
 *   6. submitDedup (提交去重)
 *
 * NOTE: eventBusPublisher 和 progressEmitter 不在默认管道中，
 * 由 #processToolCalls 直接处理，以保持与原始 reactLoop 完全一致的事件顺序
 * (progress_end 需要 resultStr.length，在管道外计算)。
 */
export function createToolPipeline() {
  return new ToolExecutionPipeline()
    .use(allowlistGate)
    .use(safetyGate)
    .use(cacheCheck)
    .use(observationRecord)
    .use(trackerSignal)
    .use(traceRecord)
    .use(submitDedup);
}
