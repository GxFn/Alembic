import type { SystemRunContext } from './SystemRunContext.js';
import type { ToolResultEnvelope } from './ToolResultEnvelope.js';

export type ToolSurface = 'runtime' | 'http' | 'mcp' | 'dashboard' | 'composer' | 'system';

export interface ToolActor {
  role?: string;
  user?: string;
  sessionId?: string;
}

export interface ToolCallSource {
  kind: 'runtime' | 'http' | 'mcp' | 'dashboard' | 'composer' | 'system';
  name?: string;
}

export interface ToolServiceLocator {
  get<T = unknown>(name: string): T;
}

export interface ToolRoutingServiceContract {
  toolRouter?: unknown | null;
}

export interface ToolKnowledgeServiceContract {
  getKnowledgeService(): unknown | null;
  getSearchEngine(): unknown | null;
  getKnowledgeGraphService(): unknown | null;
}

export interface ToolGuardServiceContract {
  getGuardService(): unknown | null;
  getGuardCheckEngine(): unknown | null;
  getViolationsStore(): unknown | null;
}

export interface ToolLifecycleServiceContract {
  getKnowledgeLifecycleService(): unknown | null;
  getProposalRepository(): unknown | null;
  getEvolutionGateway(): unknown | null;
  getConsolidationAdvisor(): unknown | null;
}

export interface ToolInfraServiceContract {
  getKnowledgeGraphService(): unknown | null;
  getIndexingPipeline(): unknown | null;
  getAuditLogger(): unknown | null;
}

export interface ToolQualityServiceContract {
  getQualityScorer(): unknown | null;
  getRecipeCandidateValidator(): unknown | null;
  getFeedbackCollector(): unknown | null;
}

export interface ToolServiceContracts {
  toolRouting?: ToolRoutingServiceContract;
  knowledge?: ToolKnowledgeServiceContract;
  guard?: ToolGuardServiceContract;
  lifecycle?: ToolLifecycleServiceContract;
  infra?: ToolInfraServiceContract;
  quality?: ToolQualityServiceContract;
}

export interface ToolPolicyValidator {
  validateToolCall(
    toolName: string,
    args: Record<string, unknown>
  ): { ok: boolean; reason?: string };
}

export interface ToolResultCacheProvider {
  getCachedResult(toolName: string, args: Record<string, unknown>): unknown | null | undefined;
  cacheToolResult?(toolName: string, args: Record<string, unknown>, result: unknown): void;
}

export interface ToolDiagnosticsRecorder {
  recordToolCallEnvelope(
    envelope: ToolResultEnvelope,
    context?: {
      kind?: string;
      surface?: ToolSurface;
      source?: string;
    }
  ): void;
}

export interface ToolRuntimeCallContext {
  agentId?: string;
  presetName?: string;
  iteration?: number;
  policyValidator?: ToolPolicyValidator | null;
  cache?: ToolResultCacheProvider | null;
  diagnostics?: ToolDiagnosticsRecorder | null;
  logger?: unknown;
  aiProvider?: unknown;
  safetyPolicy?: unknown;
  fileCache?: unknown;
  dataRoot?: string | null;
  lang?: string | null;
  sharedState?: Record<string, unknown> | null;
  dimensionMeta?: unknown;
  projectLanguage?: string | null;
  validator?: unknown;
  submittedTitles?: Set<string> | null;
  submittedPatterns?: Set<string> | null;
  submittedTriggers?: Set<string> | null;
  sessionToolCalls?: Array<{ tool: string; params?: Record<string, unknown> }> | null;
  bootstrapDedup?: unknown;
  memoryCoordinator?: unknown;
  currentRound?: number;
  dimensionScopeId?: string | null;
}

export interface ToolCallContext {
  callId: string;
  parentCallId?: string;
  toolId: string;
  surface: ToolSurface;
  actor: ToolActor;
  source: ToolCallSource;
  runtime?: ToolRuntimeCallContext;
  systemRunContext?: SystemRunContext;
  abortSignal?: AbortSignal | null;
  projectRoot: string;
  services: ToolServiceLocator;
  serviceContracts?: ToolServiceContracts;
}
