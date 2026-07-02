/**
 * Shared type definitions for Alembic daemon handler-runtime modules
 * (task dispatch, skill file service, bootstrap refine) consumed by HTTP routes.
 * Runtime-free — only interfaces and type aliases.
 *
 * RIC-3: relocated out of the deleted lib/resident/ MCP-mirror layer. Some
 * handler-arg interfaces here are now orphaned (their handlers were deleted with
 * the MCP mirror) and can be trimmed in RIC-4.
 */

import type {
  DimensionCheckpointResult,
  GenerateFile,
  IncrementalPlan,
  LoggerLike,
  SaveSnapshotParams,
} from '@alembic/core/types';

// ─── DI Container (minimal shape) ────────────────────────

/**
 * Minimal DI container shape used by resident tool handlers.
 * Compatible with both the full ServiceContainer class and the
 * lightweight ServiceContainer interface in agent tools.
 */
export interface McpServiceContainer {
  get<T = any>(name: string): T;
  getServiceNames?(): string[];
  singletons?: Record<string, unknown>;
}

// ─── Intent Lifecycle ────────────────────────────────────

/** A single decision recorded during an intent lifecycle */
export interface DecisionRecord {
  id: string;
  title: string;
  description: string;
  rationale?: string;
  tags?: string[];
  recordedAt: number;
}

/** A single tool call record within an intent */
export interface ToolCallRecord {
  tool: string;
  timestamp: number;
  args_summary: string;
}

/** A drift event detected during an intent */
export interface DriftEvent {
  timestamp: number;
  trigger: string;
  type: 'new_module' | 'new_class' | 'search_shift' | 'file_shift';
  detail: string;
  primeOverlap: number;
}

// ─── Resident Tool Handler Context ───────────────────────

/** MCP session tracking */
export interface McpSession {
  id: string;
  startedAt: number;
  toolCallCount: number;
  toolsUsed: Set<string>;
  lastActivityAt: number;
}

/** Handler context passed from API or internal router layers */
export interface McpContext {
  container: McpServiceContainer;
  startedAt?: number;
  session?: McpSession;
  [key: string]: unknown;
}

// ─── Search ──────────────────────────────────────────────

/** Common search handler args */
export interface SearchArgs {
  query: string;
  activeFile?: string;
  limit?: number;
  kind?: string;
  type?: string;
  mode?: string;
  language?: string;
  sessionHistory?: unknown[];
  hostDeclaredIntent?: unknown;
  hostTurnMeta?: unknown;
  intentContext?: unknown;
  [key: string]: unknown;
}

/** Raw search result item before projection */
export interface SearchResultItem {
  id: string;
  title: string;
  trigger?: string;
  kind?: string;
  language?: string;
  score?: number;
  description?: string;
  doClause?: string;
  whenClause?: string;
  metadata?: { kind?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Slim search item after projection */
export interface SlimSearchItem {
  id: string;
  title: string;
  trigger: string;
  kind: string;
  language: string;
  score?: number;
  description: string;
  actionHint?: string;
}

// ─── Knowledge / Browse ──────────────────────────────────

/** Minimal shape of a knowledge entry JSON (read-only projections) */
export interface KnowledgeEntryJSON {
  id: string;
  title: string;
  trigger?: string;
  kind?: string;
  language?: string;
  category?: string;
  lifecycle?: string;
  complexity?: string;
  description?: string;
  knowledgeType?: string;
  doClause?: string;
  whenClause?: string;
  dontClause?: string;
  coreCode?: string;
  tags?: string[];
  scope?: string;
  headers?: string[];
  content?: {
    pattern?: string;
    markdown?: string;
    rationale?: string;
    steps?: unknown[];
    codeChanges?: unknown[];
    verification?: unknown;
    [key: string]: unknown;
  };
  reasoning?: {
    whyStandard?: string;
    confidence?: number;
    sources?: unknown[];
    qualitySignals?: unknown;
    alternatives?: unknown;
    [key: string]: unknown;
  };
  relations?: Record<string, unknown[]>;
  constraints?: {
    guards?: unknown[];
    sideEffects?: unknown[];
    boundaries?: unknown[];
    preconditions?: unknown[];
    [key: string]: unknown;
  };
  quality?: {
    overall?: number | null;
    completeness?: number | null;
    adaptation?: number | null;
    documentation?: number | null;
    [key: string]: unknown;
  };
  stats?: {
    adoptions?: number;
    applications?: number;
    guardHits?: number;
    views?: number;
    searchHits?: number;
    [key: string]: unknown;
  };
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  toJSON?: () => KnowledgeEntryJSON;
  [key: string]: unknown;
}

// ─── Browse handler args ─────────────────────────────────

export interface BrowseListArgs {
  kind?: string;
  language?: string;
  category?: string;
  knowledgeType?: string;
  complexity?: string;
  status?: string;
  limit?: number;
  [key: string]: unknown;
}

export interface BrowseGetArgs {
  id?: string;
  [key: string]: unknown;
}

export interface ConfirmUsageArgs {
  recipeId?: string;
  id?: string;
  usageType?: string;
  feedback?: string | null;
  [key: string]: unknown;
}

// ─── Candidate handler args ──────────────────────────────

export interface ValidateCandidateArgs {
  candidate?: Record<string, unknown>;
  strict?: boolean;
  [key: string]: unknown;
}

/** Shape of a candidate object expected by validateCandidate (input from Agent) */
export interface CandidateInput {
  title?: string;
  code?: string;
  language?: string;
  category?: string;
  knowledgeType?: string;
  complexity?: string;
  trigger?: string;
  summary?: string;
  description?: string;
  usageGuide?: string;
  rationale?: string;
  headers?: string[];
  steps?: unknown;
  codeChanges?: unknown;
  constraints?: unknown;
  reasoning?: {
    whyStandard?: string;
    sources?: unknown[];
    confidence?: number;
  };
  [key: string]: unknown;
}

export interface CheckDuplicateArgs {
  candidate?: Record<string, unknown>;
  threshold?: number;
  topK?: number;
  [key: string]: unknown;
}

// ─── Consolidated handler args ───────────────────────────

export interface ConsolidatedSearchArgs extends SearchArgs {
  mode?: string;
}

export interface ConsolidatedKnowledgeArgs extends BrowseListArgs, BrowseGetArgs {
  operation?: string;
  recipeId?: string;
  usageType?: string;
  feedback?: string | null;
}

export interface ConsolidatedStructureArgs {
  operation?: string;
  [key: string]: unknown;
}

export interface ConsolidatedGraphArgs {
  operation?: string;
  [key: string]: unknown;
}

export interface ConsolidatedGuardArgs {
  operation?: 'check' | 'review' | 'coverage_matrix' | 'compliance_report';
  code?: string;
  files?: Array<string | { path?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface ConsolidatedSkillArgs {
  operation?: string;
  name?: string;
  skillName?: string;
  [key: string]: unknown;
}

export interface SubmitKnowledgeArgs {
  title?: string;
  description?: string;
  content?: { pattern?: string; [key: string]: unknown };
  dimensionId?: string;
  knowledgeType?: string;
  skipConsolidation?: boolean;
  [key: string]: unknown;
}

// ─── Knowledge health stats ──────────────────────────────

export interface KnowledgeBaseStats {
  recipes: {
    total: number;
    active: number;
    rules: number;
    patterns: number;
    facts: number;
  };
  candidates: { total: number; pending: number };
  vectorIndex?: { documentCount: number };
}

// ─── Bootstrap / Incremental ─────────────────────────────

export type { GenerateFile, IncrementalPlan, SaveSnapshotParams };

// ─── Dimension checkpoint ────────────────────────────────

export type { DimensionCheckpointResult };

// ─── Logger-like interface ───────────────────────────────

export type { LoggerLike };

// ─── Duplicate check result ──────────────────────────────

export interface DuplicateCheckResult {
  hasSimilar: boolean;
  closest?: Record<string, unknown> | null;
  note?: string;
}

// ─── ByKind grouping ─────────────────────────────────────

export interface ByKindGroup {
  rule: SlimSearchItem[];
  pattern: SlimSearchItem[];
  fact: SlimSearchItem[];
}
