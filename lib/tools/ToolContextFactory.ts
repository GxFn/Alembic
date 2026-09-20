/**
 * ToolContextFactory — 绑定 Core 受控服务与可信身份，为每次工具调用组装 ToolContext。
 *
 * 无状态 compressor/sandbox bridge 随宿主复用；会话和缓存由显式 run/view 管理。
 * 重量级 DI 服务 (searchEngine 等) 按需从容器获取。
 */

import type { ToolCallRequest, ToolScopeRelease } from '@alembic/agent';
import {
  type MemoryCoordinatorLike,
  OutputCompressor,
  type ToolAuditSinkLike,
  type ToolContext,
} from '@alembic/agent/tools/runtime';
import {
  createKnowledgeServiceAdapter,
  type KnowledgeServiceHostPort,
} from './KnowledgeServiceAdapter.js';
import { ToolScopeResources } from './ToolScopeResources.js';

interface ServiceContainer {
  get(name: string): unknown;
}

/**
 * SandboxExecutorBridge — 将 SandboxExecutor + SandboxPolicy 封装为
 * terminal handler 所需的精简接口，避免 handler 直接依赖 sandbox 模块。
 *
 * 使用延迟 import 加载 sandbox 依赖，避免模块加载时引入整条依赖链
 * （sandbox 模块依赖 Logger、SandboxProbe 等重量级组件）。
 */
class SandboxExecutorBridge {
  async exec(
    command: string,
    opts: { cwd: string; projectRoot: string; timeout: number; signal?: AbortSignal }
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    diagnostics: { sandboxed: boolean; fallbackUsed: boolean; degradeReason?: string };
  }> {
    const { sandboxExec } = await import('#sandbox/SandboxExecutor.js');
    const { buildSandboxProfile } = await import('#sandbox/SandboxPolicy.js');

    const profile = buildSandboxProfile({
      network: 'none',
      filesystem: 'project-write',
      cwd: opts.cwd,
      projectRoot: opts.projectRoot,
      timeoutMs: opts.timeout,
    });

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) {
        env[k] = v;
      }
    }

    const result = await sandboxExec(
      {
        bin: '/bin/sh',
        args: ['-c', command],
        cwd: opts.cwd,
        env: { ...env, TERM: 'dumb', NO_COLOR: '1' },
        timeout: opts.timeout,
        maxBuffer: 1024 * 1024,
        signal: opts.signal,
      },
      profile
    );
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      diagnostics: {
        sandboxed: result.sandboxed,
        fallbackUsed: result.sandboxed === false,
        ...(result.degradeReason ? { degradeReason: result.degradeReason } : {}),
      },
    };
  }
}

export interface ToolContextFactoryDeps {
  container: ServiceContainer;
  projectRoot: string;
  defaultTokenBudget?: number;
}

export class ToolContextFactory {
  readonly #deps: ToolContextFactoryDeps;
  readonly #resources = new ToolScopeResources();
  readonly #compressor: OutputCompressor;
  readonly #sandboxBridge: SandboxExecutorBridge;

  constructor(deps: ToolContextFactoryDeps) {
    this.#deps = deps;
    this.#compressor = new OutputCompressor();
    this.#sandboxBridge = new SandboxExecutorBridge();
  }

  getContainer(): ServiceContainer {
    return this.#deps.container;
  }

  create(request: ToolCallRequest): ToolContext {
    const c = this.#deps.container;
    const resources = this.#resources.forRequest(request);
    const service = tryGet(c, 'knowledgeService');
    // 不能把 raw repository 强转成管理服务；缺服务时让 handler 明确报告缺失端口。
    const knowledge = isKnowledgeService(service)
      ? createKnowledgeServiceAdapter(service, request.actor?.user || 'anonymous')
      : undefined;

    return {
      projectRoot: this.#deps.projectRoot,

      projectGraph: null,
      searchEngine: tryGet(c, 'searchEngine'),
      recipeGateway: tryGet(c, 'recipeProductionGateway'),
      knowledgeRead: knowledge,
      knowledgeManagement: knowledge,
      // staging 复核通道（2026-07-06）：knowledge.manage review 经此提交复核结论。
      stagingManager: tryGet(c, 'stagingManager'),
      proposalGateway: tryGet(c, 'proposalGateway'),
      astAnalyzer: tryGet(c, 'astAnalyzer'),
      safetyPolicy: request.runtime?.safetyPolicy ?? undefined,
      sandboxExecutor: this.#sandboxBridge,
      auditSink: tryGetAuditSink(c, 'auditLogger'),

      deltaCache: resources.deltaCache,
      searchCache: resources.searchCache,
      compressor: this.#compressor,
      sessionStore: resources.sessionStore,

      tokenBudget: this.#deps.defaultTokenBudget ?? 8000,
      abortSignal: request.abortSignal ?? undefined,
      memoryCoordinator: (request.runtime?.memoryCoordinator as MemoryCoordinatorLike) ?? undefined,
      runtime: request.runtime ?? undefined,
    };
  }

  releaseScope(scope: ToolScopeRelease): void {
    this.#resources.releaseScope(scope);
  }
}

function isKnowledgeService(value: unknown): value is KnowledgeServiceHostPort {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return ['get', 'update', 'reject'].every(
    (key) => typeof (value as Record<string, unknown>)[key] === 'function'
  );
}

function tryGet(container: ServiceContainer, name: string): unknown {
  try {
    return container.get(name);
  } catch {
    return undefined;
  }
}

function tryGetAuditSink(container: ServiceContainer, name: string): ToolAuditSinkLike | undefined {
  const service = tryGet(container, name);
  if (isAuditSinkLike(service)) {
    return service;
  }
  return undefined;
}

function isAuditSinkLike(value: unknown): value is ToolAuditSinkLike {
  return Boolean(
    value && typeof value === 'object' && typeof (value as { log?: unknown }).log === 'function'
  );
}
