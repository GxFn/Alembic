/**
 * ToolExecutionPipeline — 工具执行的中间件管道
 *
 * 将 reactLoop 中 ~120 行的工具执行逻辑拆分为独立中间件:
 *   before → execute → after
 *
 * 每个中间件负责一个横切关注点:
 *   1. EventBusPublisher — 事件发布
 *   2. ProgressEmitter — 进度回调
 *   3. AllowlistGate — 当前 capability 白名单拦截
 *   4. ObservationRecord — 记忆记录
 *   5. TrackerSignal — ExplorationTracker 信号收集
 *   6. TraceRecord — ActiveContext 推理链记录
 *   7. SubmitDedup — 提交去重
 *
 * @module core/ToolExecutionPipeline
 */

import type { ToolResultEnvelope } from '#tools/core/ToolResultEnvelope.js';
import { SafetyPolicy } from '../policies/index.js';
import type { AgentRuntime } from './AgentRuntime.js';
import type { LoopContext } from './LoopContext.js';

/** 工具调用描述 */
interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  id: string;
}

/** 工具执行上下文 */
interface ToolExecContext {
  runtime: AgentRuntime;
  loopCtx: LoopContext;
  iteration: number;
}

interface ToolForgeLike {
  temporaryRegistry?: { isTemporary(name: string): boolean };
}

/** 工具执行元数据 */
interface ToolMetadata {
  cacheHit: boolean;
  blocked: boolean;
  isNew: boolean;
  durationMs: number;
  dedupMessage?: string;
  isSubmit?: boolean;
  envelope?: ToolResultEnvelope;
}

/** before 钩子返回值 */
interface BeforeVerdict {
  blocked?: boolean;
  result?: unknown;
}

function diagnosticReason(result: unknown) {
  if (result && typeof result === 'object' && 'error' in result) {
    return String((result as { error?: unknown }).error || 'blocked');
  }
  return 'blocked';
}

/** 工具中间件 */
interface ToolMiddleware {
  name: string;
  before?: (
    call: ToolCall,
    ctx: ToolExecContext,
    metadata: ToolMetadata
  ) => BeforeVerdict | undefined | Promise<BeforeVerdict | undefined>;
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
   *   2. 实际执行工具 (ToolRouter only)
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
          context.loopCtx.diagnostics?.recordBlockedTool(call.name, diagnosticReason(toolResult));
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
        const envelope = await runtime.toolRouter.execute({
          toolId: call.name,
          args: call.args,
          surface: 'runtime',
          actor: { role: 'developer', user: runtime.id },
          source: {
            kind: 'runtime',
            name:
              typeof loopCtx.context?.pipelinePhase === 'string'
                ? loopCtx.context.pipelinePhase
                : loopCtx.source || runtime.presetName,
          },
          abortSignal: loopCtx.abortSignal || null,
          runtime: {
            agentId: runtime.id,
            presetName: runtime.presetName,
            iteration: loopCtx.iteration || 0,
            policyValidator: runtime.policies,
            cache: loopCtx.memoryCoordinator || null,
            diagnostics: loopCtx.diagnostics || null,
            safetyPolicy,
            fileCache: runtime.fileCache,
            dataRoot: runtime.dataRoot,
            lang: runtime.lang,
            logger: runtime.logger || null,
            aiProvider: runtime.aiProvider || null,
            sharedState: loopCtx.sharedState || null,
            dimensionMeta: loopCtx.sharedState?._dimensionMeta || null,
            projectLanguage:
              typeof loopCtx.sharedState?._projectLanguage === 'string'
                ? loopCtx.sharedState._projectLanguage
                : null,
            submittedTitles: loopCtx.sharedState?.submittedTitles || null,
            submittedPatterns: loopCtx.sharedState?.submittedPatterns || null,
            submittedTriggers: loopCtx.sharedState?.submittedTriggers || null,
            sessionToolCalls: Array.isArray(loopCtx.toolCalls)
              ? loopCtx.toolCalls.map((entry: { tool?: string; args?: unknown }) => ({
                  tool: String(entry.tool || ''),
                  params:
                    entry.args && typeof entry.args === 'object'
                      ? (entry.args as Record<string, unknown>)
                      : undefined,
                }))
              : null,
            bootstrapDedup: loopCtx.sharedState?._bootstrapDedup || null,
            memoryCoordinator: loopCtx.memoryCoordinator || null,
            dimensionScopeId:
              typeof loopCtx.sharedState?._dimensionScopeId === 'string'
                ? loopCtx.sharedState._dimensionScopeId
                : null,
            currentRound: loopCtx.iteration || 0,
          },
        });
        metadata.envelope = envelope;
        metadata.cacheHit = envelope.cache?.hit === true;
        if (
          !envelope.ok &&
          ['blocked', 'needs-confirmation', 'aborted', 'timeout'].includes(envelope.status)
        ) {
          metadata.blocked = true;
          loopCtx.diagnostics?.recordBlockedTool(call.name, envelope.text);
        }
        toolResult = !envelope.ok
          ? { error: envelope.text }
          : envelope.structuredContent !== undefined
            ? envelope.structuredContent
            : { success: true, message: envelope.text };
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
 * 从 LoopContext.allowedToolIds 中提取允许的工具名列表，
 * 拒绝不在列表中的调用（返回 error 提示）。空数组表示严格禁用所有 capability 工具。
 *
 * Forge 集成：不在白名单的工具如果已由 ToolForge 锻造（存在于 ToolRegistry），则放行。
 *
 * before: 如果工具不在白名单中且非锻造工具则短路返回 error
 */
export const allowlistGate = {
  name: 'allowlistGate',
  before(call: ToolCall, ctx: ToolExecContext): BeforeVerdict | undefined {
    const allowedNames = new Set(ctx.loopCtx?.allowedToolIds || []);
    if (!allowedNames.has(call.name)) {
      const container = ctx.runtime.container as { get?: (name: string) => unknown } | null;
      const toolForge = container?.get?.('toolForge') as ToolForgeLike | undefined;
      const isTemporaryTool = toolForge?.temporaryRegistry?.isTemporary(call.name) === true;
      // Forge fallback: 仅允许确认为 TemporaryToolRegistry 管理的动态工具放行。
      if (isTemporaryTool) {
        ctx.runtime.logger.info(
          `[ToolPipeline] Tool "${call.name}" not in allowlist but is a temporary forged tool — allowed`
        );
        return undefined;
      }

      ctx.runtime.logger.warn(
        `[ToolPipeline] ⛔ Tool "${call.name}" not in allowlist — blocked (hallucinated call)`
      );
      const availableTools = [...allowedNames].slice(0, 5).join(', ');
      return {
        blocked: true,
        result: {
          error:
            allowedNames.size === 0
              ? `工具 "${call.name}" 不可用。当前阶段未开放任何工具。`
              : `工具 "${call.name}" 不可用。当前可用工具: ${availableTools}${allowedNames.size > 5 ? '...' : ''}`,
        },
      };
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
      meta.envelope || result,
      ctx.iteration,
      meta.envelope ? true : meta.cacheHit
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
    ctx.loopCtx.trace?.recordToolCall(call.name, call.args, meta.envelope || result, meta.isNew);
  },
};

/**
 * SubmitDedup — 提交去重
 *
 * after: 检查并标记重复提交 (修改 metadata)
 */
export const submitDedup = {
  name: 'submitDedup',

  before(call: ToolCall, ctx: ToolExecContext): BeforeVerdict | undefined {
    if (call.name !== 'knowledge') {
      return;
    }
    const { sharedState } = ctx.loopCtx;
    if (!sharedState?.submittedTitles) {
      return;
    }

    // V2 args structure: { action: "submit", params: { title, ... } }
    const params = (call.args?.params as Record<string, unknown>) ?? call.args ?? {};
    const title = String(params.title || params.category || '');
    const normalizedTitle = title.toLowerCase().trim();
    if (!normalizedTitle) {
      return;
    }

    // trigger 去重 — 不同 title 但相同 trigger 的跨维度重复
    const trigger = String(params.trigger || '')
      .toLowerCase()
      .trim();
    if (trigger && sharedState.submittedTriggers?.has(trigger)) {
      ctx.runtime.logger.info(`[ToolPipeline] 🔁 duplicate trigger: "${trigger}"`);
      return {
        blocked: true,
        result: {
          submitted: false,
          status: 'duplicate',
          reason: `重复 trigger: "${trigger}" 已被其他候选占用。请更换 trigger 后重试或跳过此条目。`,
        },
      };
    }

    // title 去重 — 已存在的 recipe 或本次 session 已提交的标题
    if (sharedState.submittedTitles.has(normalizedTitle)) {
      ctx.runtime.logger.info(`[ToolPipeline] 🔁 duplicate blocked: "${title}"`);
      return {
        blocked: true,
        result: {
          submitted: false,
          status: 'duplicate',
          reason: `重复提交: "${title}" 已存在。请提交不同主题的知识条目。`,
        },
      };
    }
    return undefined;
  },

  after(call: ToolCall, result: unknown, ctx: ToolExecContext, meta: ToolMetadata) {
    if (call.name !== 'knowledge') {
      return;
    }
    const { sharedState } = ctx.loopCtx;
    if (!sharedState?.submittedTitles) {
      return;
    }

    const resultObj = result as Record<string, unknown> | null;
    const isRejected = typeof result === 'object' && resultObj?.status === 'rejected';
    const isError =
      typeof result === 'object' && (resultObj?.error || resultObj?.status === 'error');

    if (isRejected || isError) {
      return;
    }

    // V2 args structure: { action: "submit", params: { title, ... } }
    const params = (call.args?.params as Record<string, unknown>) ?? call.args ?? {};
    const title = String(params.title || params.category || '');
    const normalizedTitle = title.toLowerCase().trim();
    if (!normalizedTitle) {
      return;
    }

    // 提交成功 — 注册标题/trigger/指纹以防后续重复
    sharedState.submittedTitles.add(normalizedTitle);

    const trigger = String(params.trigger || '')
      .toLowerCase()
      .trim();
    if (trigger && sharedState.submittedTriggers) {
      sharedState.submittedTriggers.add(trigger);
    }

    const contentObj = params.content as Record<string, unknown> | undefined;
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
 *   1. allowlistGate (当前 capability 白名单 — 可短路)
 *   2. observationRecord (记忆记录)
 *   3. trackerSignal (信号收集)
 *   4. traceRecord (推理链)
 *   5. submitDedup (提交去重)
 *
 * Runtime SafetyPolicy 已迁入 ToolRouter/GovernanceEngine 的 approve 阶段。
 *
 * NOTE: eventBusPublisher 和 progressEmitter 不在默认管道中，
 * 由 #processToolCalls 直接处理，以保持与原始 reactLoop 完全一致的事件顺序
 * (progress_end 需要 resultStr.length，在管道外计算)。
 */
export function createToolPipeline() {
  return new ToolExecutionPipeline()
    .use(allowlistGate)
    .use(observationRecord)
    .use(trackerSignal)
    .use(traceRecord)
    .use(submitDedup);
}
