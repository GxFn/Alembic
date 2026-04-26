import type { AgentMessage } from '../AgentMessage.js';
import type {
  AgentDiagnostics,
  FileCacheEntry,
  ProgressEvent,
  ToolCallEntry,
} from '../AgentRuntimeTypes.js';
import type { SystemRunContext } from '../core/SystemRunContext.js';

export type BuiltinAgentPreset = 'chat' | 'insight' | 'evolution' | 'lark' | 'remote-exec';

export interface AgentProfileRef {
  id?: string;
  preset?: BuiltinAgentPreset | string;
  params?: Record<string, unknown>;
}

export interface AgentProfileOverride {
  id?: string;
  basePreset: BuiltinAgentPreset | string;
  skills?: string[];
  strategy?: Record<string, unknown>;
  policies?: unknown[];
  persona?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  actionSpace?: AgentActionSpace;
  params?: Record<string, unknown>;
}

export type AgentServiceKind =
  | 'conversation'
  | 'system-analysis'
  | 'knowledge-production'
  | 'translation'
  | 'background-analysis'
  | 'remote-operation';

export interface AgentProfileDefaults {
  skills?: string[];
  policies?: unknown[];
  persona?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  actionSpace?: AgentActionSpace;
}

export type AgentStrategyTemplate =
  | { type: 'preset' }
  | { type: 'single' }
  | { type: 'pipeline'; factory: string; paramsSchema?: string }
  | { type: 'fanout'; childProfile: string; partitioner: string; merge: string };

export interface AgentConcurrencyPlan {
  mode: 'none' | 'tiered' | 'parallel';
  concurrency?: number | { env: string; default: number };
  partitioner?: string;
  childProfile?: string;
  merge?: string;
  abortPolicy?: 'stop-new' | 'cancel-running' | 'finish-tier';
}

export interface AgentProfileDefinition {
  id: string;
  title: string;
  serviceKind: AgentServiceKind;
  lifecycle: 'active' | 'experimental' | 'deprecated';
  basePreset?: BuiltinAgentPreset | string;
  defaults?: AgentProfileDefaults;
  strategy?: AgentStrategyTemplate | Record<string, unknown>;
  projection?: string;
  concurrency?: AgentConcurrencyPlan;
}

export interface AgentProfile {
  id: string;
  title: string;
  lifecycle: 'active' | 'experimental' | 'deprecated';
  skills: string[];
  strategy?: Record<string, unknown>;
  policies?: unknown[];
  persona?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  actionSpace: AgentActionSpace;
}

export type AgentActionSpace =
  | { mode: 'none' }
  | { mode: 'listed'; toolIds: string[] }
  | { mode: 'all'; reason: string };

export interface CompiledAgentProfile {
  kind: 'compiled-agent-profile';
  id: string;
  title: string;
  serviceKind: AgentServiceKind;
  lifecycle: 'active' | 'experimental' | 'deprecated';
  basePreset: BuiltinAgentPreset | string;
  skills?: string[];
  strategy?: Record<string, unknown>;
  policies?: unknown[];
  persona?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  actionSpace: AgentActionSpace;
  additionalTools: string[];
  params: Record<string, unknown>;
  projection?: string;
  concurrency?: AgentConcurrencyPlan;
  runtimeOverrides: Record<string, unknown>;
}

export interface AgentRunMessage {
  content: string;
  role?: 'user' | 'system' | 'internal';
  history?: Array<{ role: string; content: string }>;
  metadata?: Record<string, unknown>;
  sessionId?: string;
}

export interface AgentRunActor {
  role?: string;
  user?: string;
  sessionId?: string;
}

export type AgentRunSource =
  | 'http-chat'
  | 'http-stream'
  | 'lark'
  | 'bootstrap'
  | 'system-workflow'
  | 'mcp'
  | 'internal';

export type AgentRuntimeSource = 'user' | 'system' | 'analyst' | 'producer' | 'remote';

export interface AgentRunCoordinationHooks {
  onChildResult?: (event: {
    childInput: AgentRunInput;
    result: AgentRunResult;
    profile: CompiledAgentProfile;
  }) => void | Promise<void>;
  onTierComplete?: (event: {
    tierIndex: number;
    childInputs: AgentRunInput[];
    results: AgentRunResult[];
    profile: CompiledAgentProfile;
  }) => void | Promise<void>;
}

export type AgentChildInputFactory = (event: {
  plannedInput: AgentRunInput;
  parentInput: AgentRunInput;
}) => AgentRunInput | Promise<AgentRunInput>;

export interface AgentRunContext {
  source: AgentRunSource;
  runtimeSource?: AgentRuntimeSource;
  actor?: AgentRunActor;
  lang?: string | null;
  promptContext?: Record<string, unknown>;
  systemRunContext?: SystemRunContext;
  strategyContext?: Record<string, unknown>;
  memoryCoordinator?: unknown;
  contextWindow?: unknown;
  trace?: unknown;
  sharedState?: Record<string, unknown>;
  fileCache?: FileCacheEntry[] | null;
  childContexts?: Record<string, Partial<Omit<AgentRunContext, 'childContexts'>>>;
  childInputFactories?: Record<string, AgentChildInputFactory>;
  coordination?: AgentRunCoordinationHooks;
}

export interface AgentRunExecutionOptions {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  shouldAbort?: () => boolean | Promise<boolean>;
  budgetOverride?: Record<string, unknown>;
  toolChoiceOverride?: 'auto' | 'required' | 'none';
  diagnostics?: unknown;
  onProgress?: ((event: ProgressEvent) => void) | null;
  onToolCall?:
    | ((name: string, args: Record<string, unknown>, result: unknown, iteration: number) => void)
    | null;
}

export interface AgentRunPresentationOptions {
  stream?: boolean;
  responseShape?: 'agent-result' | 'chat-reply' | 'system-task-result';
}

export interface AgentRunInput {
  profile: AgentProfileRef | AgentProfileOverride;
  message: AgentRunMessage;
  params?: Record<string, unknown>;
  context: AgentRunContext;
  execution?: AgentRunExecutionOptions;
  presentation?: AgentRunPresentationOptions;
}

export type AgentRunStatus = 'success' | 'blocked' | 'aborted' | 'timeout' | 'error';

export interface AgentRunUsage {
  inputTokens: number;
  outputTokens: number;
  iterations: number;
  durationMs: number;
}

export interface AgentRunResult {
  runId: string;
  profileId: string;
  reply: string;
  status: AgentRunStatus;
  phases?: Record<string, unknown>;
  toolCalls: ToolCallEntry[];
  usage: AgentRunUsage;
  diagnostics: AgentDiagnostics | null;
}

export interface AgentRuntimeRunOptions {
  abortSignal?: AbortSignal;
  diagnostics?: unknown;
  strategyContext?: Record<string, unknown>;
  systemRunContext?: SystemRunContext;
  budgetOverride?: Record<string, unknown>;
  toolChoiceOverride?: 'auto' | 'required' | 'none';
  contextWindow?: unknown;
  trace?: unknown;
  memoryCoordinator?: unknown;
  sharedState?: Record<string, unknown>;
  context?: Record<string, unknown>;
  source?: AgentRuntimeSource | string;
}

export interface AgentRuntimeBuildOptions {
  lang?: string | null;
  onProgress?: ((event: ProgressEvent) => void) | null;
  onToolCall?:
    | ((name: string, args: Record<string, unknown>, result: unknown, iteration: number) => void)
    | null;
}

export interface AgentRuntimeLike {
  id: string;
  setFileCache?(files: FileCacheEntry[] | null): void;
  execute(
    message: AgentMessage,
    opts?: AgentRuntimeRunOptions
  ): Promise<{
    reply: string;
    toolCalls?: ToolCallEntry[];
    tokenUsage?: { input?: number; output?: number };
    iterations?: number;
    durationMs?: number;
    phases?: Record<string, unknown>;
    diagnostics?: AgentDiagnostics;
  }>;
}
