import type { AgentService, SystemRunContextFactory } from '@alembic/agent/service';
import type { GenerateFileEntry } from './AgentRunInputBuilders.js';

interface BootstrapWorkflowSingletons {
  aiProvider?: {
    name?: string;
    model?: string;
    supportsEmbedding?: () => boolean;
    [key: string]: unknown;
  } | null;
  _embedProvider?: { embed?: (text: string) => Promise<number[]>; [key: string]: unknown } | null;
  _fileCache?: GenerateFileEntry[] | null;
  _projectRoot?: string;
  _config?: Record<string, unknown>;
  _lang?: string | null;
  [key: string]: unknown;
}

interface BootstrapWorkflowServiceKeys {
  agentService: AgentService;
  systemRunContextFactory: SystemRunContextFactory;
  generateTaskManager: GenerateTaskManagerLike;
  database: unknown;
}

export interface GenerateWorkflowContainer {
  get<K extends keyof BootstrapWorkflowServiceKeys>(name: K): BootstrapWorkflowServiceKeys[K];
  get(name: string): unknown;
  singletons: BootstrapWorkflowSingletons;
  [key: string]: unknown;
}

export interface GenerateWorkflowContext {
  container: GenerateWorkflowContainer;
  [key: string]: unknown;
}

export interface GenerateTaskManagerLike {
  isSessionValid(sessionId: string): boolean;
  isUserCancelled?(sessionId: string): boolean;
  getSessionAbortSignal?(): AbortSignal | null;
  emitProgress?(event: string, data: Record<string, unknown>): void;
  [key: string]: unknown;
}
