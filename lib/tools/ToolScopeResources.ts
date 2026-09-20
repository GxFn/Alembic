/** 工具状态由宿主持有：run 记忆与读取视图分离，具体服务和 sandbox 不进入这里。 */
import type { ToolCallRequest, ToolScopeRelease } from '@alembic/agent';
import { DeltaCache, SearchCache } from '@alembic/agent/tools/runtime';
import Logger from '@alembic/core/logging';

class ToolSessionStore {
  #entries: Array<{ key: string; content: string; meta?: Record<string, unknown> }> = [];

  save(key: string, content: string, meta?: Record<string, unknown>): void {
    this.#entries.push({ key, content, meta });
  }

  recall(query?: string, opts?: { tags?: string[]; limit?: number }) {
    const q = query?.toLowerCase();
    return this.#entries
      .filter(
        (entry) =>
          (!q || entry.key.toLowerCase().includes(q) || entry.content.toLowerCase().includes(q)) &&
          (!opts?.tags?.length ||
            opts.tags.some(
              (tag) => Array.isArray(entry.meta?.tags) && entry.meta.tags.includes(tag)
            ))
      )
      .slice(-(opts?.limit ?? 20))
      .map(({ key, content, meta }) => ({ key, content, meta }));
  }

  clear(): void {
    this.#entries = [];
  }
}

interface ReadView {
  revision: number;
  deltaCache: DeltaCache;
  searchCache: SearchCache;
}

class RunResources {
  readonly sessionStore = new ToolSessionStore();
  readonly #views = new Map<string, ReadView>();

  view(id: string, revision: number): ReadView {
    const previous = this.#views.get(id);
    if (previous?.revision === revision) {
      return previous;
    }
    if (previous) {
      this.releaseView(id);
      Logger.getInstance().info('[ToolScopeResources] read view reset after context loss', {
        revision,
      });
    }
    const view = { revision, deltaCache: new DeltaCache(200), searchCache: new SearchCache(100) };
    this.#views.set(id, view);
    return view;
  }

  releaseView(id: string): void {
    const view = this.#views.get(id);
    view?.deltaCache.clear();
    view?.searchCache.clear();
    this.#views.delete(id);
  }

  clear(): void {
    for (const id of this.#views.keys()) {
      this.releaseView(id);
    }
    this.sessionStore.clear();
  }
}

export class ToolScopeResources {
  readonly #runs = new Map<string, Map<string, RunResources>>();
  /** 旧 HTTP/宿主尚未提供 release 生命周期：有身份的兼容会话使用有界 LRU。 */
  readonly #legacySessions = new Map<string, RunResources>();
  readonly #maxLegacySessions = 128;

  forRequest(request: ToolCallRequest) {
    const scope = request.runtime?.resourceScope;
    const owner = JSON.stringify([
      request.surface,
      request.actor?.user,
      request.actor?.role,
      request.actor?.sessionId,
      request.runtime?.agentId,
      request.runtime?.dimensionScopeId,
    ]);
    let resources: RunResources;
    if (scope !== undefined) {
      if (
        !scope ||
        typeof scope.runId !== 'string' ||
        !scope.runId.trim() ||
        typeof scope.viewId !== 'string' ||
        !scope.viewId.trim() ||
        !Number.isSafeInteger(scope.revision) ||
        scope.revision < 0
      ) {
        throw new Error(
          'Invalid tool resource scope: runId, viewId and nonnegative revision are required'
        );
      }
      let owners = this.#runs.get(scope.runId);
      if (!owners) {
        owners = new Map();
        this.#runs.set(scope.runId, owners);
      }
      resources = owners.get(owner) ?? new RunResources();
      owners.set(owner, resources);
    } else if (request.actor?.sessionId || request.runtime?.agentId) {
      const existing = this.#legacySessions.get(owner);
      resources = existing ?? new RunResources();
      this.#legacySessions.delete(owner);
      this.#legacySessions.set(owner, resources);
      if (!existing) {
        Logger.getInstance().info(
          '[ToolScopeResources] legacy identity scope opened; explicit run lifecycle unavailable'
        );
      }
      if (this.#legacySessions.size > this.#maxLegacySessions) {
        const oldest = this.#legacySessions.keys().next().value;
        if (oldest !== undefined) {
          this.#legacySessions.get(oldest)?.clear();
          this.#legacySessions.delete(oldest);
          Logger.getInstance().warn(
            '[ToolScopeResources] legacy session evicted; subsequent reads require a fresh baseline'
          );
        }
      }
    } else {
      // 缺少身份时只给当前调用临时状态，绝不退回宿主级共享会话。
      resources = new RunResources();
      Logger.getInstance().info(
        '[ToolScopeResources] call-local state: no run or session identity'
      );
    }
    return {
      sessionStore: resources.sessionStore,
      ...resources.view(scope?.viewId ?? 'legacy', scope?.revision ?? 0),
    };
  }

  releaseScope(scope: ToolScopeRelease): void {
    const owners = this.#runs.get(scope.runId);
    if (!owners) {
      return;
    }
    for (const resources of owners.values()) {
      if (scope.viewId !== undefined) {
        resources.releaseView(scope.viewId);
      } else {
        resources.clear();
      }
    }
    if (scope.viewId === undefined) {
      this.#runs.delete(scope.runId);
      Logger.getInstance().info('[ToolScopeResources] run state released', { owners: owners.size });
    }
  }
}
