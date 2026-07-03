import { JobStore } from '@alembic/core/daemon';
import { resolveProjectRoot } from '@alembic/core/workspace';
import type { ServiceContainer } from '../../injection/ServiceContainer.js';
import { resolveAlembicWorkspace } from '../../project-scope/ProjectScopeRegistry.js';
import { JobDisplaySnapshotStore } from '../observability/JobDisplaySnapshotStore.js';
import { JobProcessEventRecorder } from '../observability/JobProcessEventRecorder.js';

/**
 * AD4 managed lifecycle: daemon-job fallbacks (used when a container lacks
 * the registered recorder/snapshot-store singletons) live inside this lazy,
 * disposable registry instead of eager module-scope instances — the recorder
 * is no longer constructed at import time.
 */
class DaemonJobFallbacks {
  #recorder: JobProcessEventRecorder | null = null;
  #snapshotStores = new Map<string, JobDisplaySnapshotStore>();

  get recorder(): JobProcessEventRecorder {
    this.#recorder ??= new JobProcessEventRecorder();
    return this.#recorder;
  }

  snapshotStore(dataRoot: string): JobDisplaySnapshotStore {
    const existing = this.#snapshotStores.get(dataRoot);
    if (existing) {
      return existing;
    }
    const store = new JobDisplaySnapshotStore({ dataRoot });
    this.#snapshotStores.set(dataRoot, store);
    return store;
  }

  clear() {
    this.#recorder = null;
    this.#snapshotStores.clear();
  }
}

let defaultDaemonJobFallbacks: DaemonJobFallbacks | null = null;

function getDaemonJobFallbacks(): DaemonJobFallbacks {
  defaultDaemonJobFallbacks ??= new DaemonJobFallbacks();
  return defaultDaemonJobFallbacks;
}

/** 重置 fallback 状态（测试用） */
export function resetDaemonJobFallbacks() {
  defaultDaemonJobFallbacks?.clear();
}

export function getJobStore(container: ServiceContainer): JobStore {
  try {
    return container.get('jobStore');
  } catch {
    const resolver = resolveAlembicWorkspace(resolveProjectRoot(container));
    return new JobStore({ projectRoot: resolver.dataRoot });
  }
}

export function getJobProcessEventRecorder(container: ServiceContainer): JobProcessEventRecorder {
  try {
    return container.get('jobProcessEventRecorder');
  } catch {
    return getDaemonJobFallbacks().recorder;
  }
}

export function getJobDisplaySnapshotStore(container: ServiceContainer): JobDisplaySnapshotStore {
  try {
    return container.get('jobDisplaySnapshotStore');
  } catch {
    const resolver = resolveAlembicWorkspace(resolveProjectRoot(container));
    return getFallbackJobDisplaySnapshotStore(resolver.dataRoot);
  }
}

function getFallbackJobDisplaySnapshotStore(dataRoot: string): JobDisplaySnapshotStore {
  return getDaemonJobFallbacks().snapshotStore(dataRoot);
}
