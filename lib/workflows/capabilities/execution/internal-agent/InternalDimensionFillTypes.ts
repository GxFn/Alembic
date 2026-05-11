import type { AgentService, SystemRunContextFactory } from '#agent/service/index.js';
import type { BootstrapFileEntry } from '#workflows/capabilities/execution/internal-agent/BootstrapInputBuilders.js';
import type { BootstrapProjectGraphLike } from '#workflows/capabilities/execution/internal-agent/BootstrapRuntimeInitializer.js';

interface BootstrapWorkflowSingletons {
  aiProvider?: {
    name?: string;
    model?: string;
    supportsEmbedding?: () => boolean;
    [key: string]: unknown;
  } | null;
  _embedProvider?: { embed?: (text: string) => Promise<number[]>; [key: string]: unknown } | null;
  _fileCache?: BootstrapFileEntry[] | null;
  _projectRoot?: string;
  _config?: Record<string, unknown>;
  _lang?: string | null;
  [key: string]: unknown;
}

interface BootstrapWorkflowServiceKeys {
  agentService: AgentService;
  systemRunContextFactory: SystemRunContextFactory;
  bootstrapTaskManager: BootstrapTaskManagerLike;
  database: unknown;
}

export interface BootstrapWorkflowContainer {
  get<K extends keyof BootstrapWorkflowServiceKeys>(name: K): BootstrapWorkflowServiceKeys[K];
  get(name: string): unknown;
  singletons: BootstrapWorkflowSingletons;
  buildProjectGraph?(
    projectRoot: string,
    options?: Record<string, unknown>
  ): Promise<BootstrapProjectGraphLike | null>;
  [key: string]: unknown;
}

export interface BootstrapWorkflowContext {
  container: BootstrapWorkflowContainer;
  [key: string]: unknown;
}

export interface BootstrapTaskManagerLike {
  isSessionValid(sessionId: string): boolean;
  isUserCancelled?(sessionId: string): boolean;
  getSessionAbortSignal?(): AbortSignal | null;
  emitProgress?(event: string, data: Record<string, unknown>): void;
  [key: string]: unknown;
}
