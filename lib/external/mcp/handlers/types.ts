/**
 * Shared type definitions for MCP handler modules.
 * Runtime-free — only interfaces and type aliases.
 */

import type { SessionStore } from '#agent/memory/SessionStore.js';

// ─── DI Container (minimal shape) ────────────────────────

/**
 * Minimal DI container shape used by MCP handlers.
 * Compatible with both the full ServiceContainer class and the
 * lightweight ServiceContainer interface in agent tools.
 */
export interface McpServiceContainer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DI container: callers know the service type
  get(name: string): any;
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

/** Intent lifecycle state machine — tracks user intent from prime to close/fail */
export interface IntentState {
  // ─── Lifecycle ───
  phase: 'idle' | 'active' | 'ended';

  // ─── Prime baseline (set when phase = active) ───
  primeQuery: string;
  primeActiveFile?: string;
  primeRecipeIds: string[];
  primeAt: number;

  // ─── Prime baseline (enriched by IntentExtractor) ───
  primeLanguage: string | null;
  primeModule: string | null;
  primeScenario: string;

  // ─── Search metadata (set by PrimeSearchPipeline) ───
  searchMeta?: {
    queries: string[];
    resultCount: number;
    filteredCount: number;
  };

  // ─── Anchor (set after create) ───
  taskId?: string;
  taskTitle?: string;

  // ─── Context accumulation (appended on each tool call) ───
  toolCalls: ToolCallRecord[];
  searchQueries: string[];
  mentionedFiles: string[];
  mentionedModules: Set<string>;
  decisions: DecisionRecord[];

  // ─── Drift tracking ───
  driftEvents: DriftEvent[];
}

/** Create a fresh idle IntentState */
export function createIdleIntent(): IntentState {
  return {
    phase: 'idle',
    primeQuery: '',
    primeRecipeIds: [],
    primeAt: 0,
    primeLanguage: null,
    primeModule: null,
    primeScenario: 'search',
    toolCalls: [],
    searchQueries: [],
    mentionedFiles: [],
    mentionedModules: new Set(),
    decisions: [],
    driftEvents: [],
  };
}

// ─── JSONL Signal Record ─────────────────────────────────

/** A complete intent chain record, written to JSONL on close/fail */
export interface IntentChainRecord {
  sessionId: string;
  taskId?: string;
  outcome: 'completed' | 'failed' | 'abandoned';

  primeQuery: string;
  primeActiveFile?: string;
  primeRecipeIds: string[];
  primeAt: number;
  primeLanguage: string | null;
  primeModule: string | null;
  primeScenario: string;

  searchMeta?: {
    queries: string[];
    resultCount: number;
    filteredCount: number;
  };

  toolCalls: ToolCallRecord[];
  searchQueries: string[];
  mentionedFiles: string[];
  decisions: DecisionRecord[];

  driftEvents: DriftEvent[];
  driftScore: number;

  closeReason?: string;
  failReason?: string;
  guardViolations?: number;
  startedAt: number;
  endedAt: number;
  duration: number;
}

// ─── MCP Handler Context ─────────────────────────────────

/** MCP session tracking */
export interface McpSession {
  id: string;
  startedAt: number;
  toolCallCount: number;
  toolsUsed: Set<string>;
  lastActivityAt: number;
  intent: IntentState;
}

/** MCP handler context passed from McpServer / router layer */
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
  limit?: number;
  kind?: string;
  type?: string;
  mode?: string;
  language?: string;
  sessionHistory?: unknown[];
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

export interface EnrichCandidatesArgs {
  candidateIds?: string[];
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
  operation?: 'check' | 'review' | 'reverse_audit' | 'coverage_matrix' | 'compliance_report';
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
  skipDuplicateCheck?: boolean;
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

// ─── Enrichment result entry ─────────────────────────────

export interface EnrichResultEntry {
  id: string;
  found: boolean;
  title?: string;
  language?: string;
  lifecycle?: string;
  kind?: string;
  missingFields: string[];
  recipeReadyMissing: { field: string; hint: string }[];
  complete?: boolean;
  error?: string;
}

// ─── Bootstrap / Incremental ─────────────────────────────

export interface BootstrapFile {
  path: string;
  relativePath: string;
  content: string;
}

export interface IncrementalPlan {
  canIncremental: boolean;
  mode: 'incremental' | 'full';
  affectedDimensions: string[];
  skippedDimensions: string[];
  previousSnapshot: Record<string, unknown> | null;
  diff: {
    added: string[];
    modified: string[];
    deleted: string[];
    unchanged: string[];
    changeRatio: number;
  } | null;
  reason: string;
  restoredEpisodic: SessionStore | null;
}

export interface SaveSnapshotParams {
  sessionId: string;
  allFiles: BootstrapFile[];
  dimensionStats: Record<string, Record<string, unknown>>;
  episodicMemory?: {
    toJSON(): unknown;
    getCompletedDimensions(): string[];
    getDimensionReport?(dimId: string): { referencedFiles?: string[] } | null;
  } | null;
  meta?: Record<string, unknown>;
  plan?: IncrementalPlan | null;
}

// ─── Dimension checkpoint ────────────────────────────────

export interface DimensionCheckpointResult {
  dimId?: string;
  sessionId?: string;
  completedAt?: number;
  digest?: unknown;
  [key: string]: unknown;
}

// ─── Logger-like interface ───────────────────────────────

export interface LoggerLike {
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  error?(...args: unknown[]): void;
  debug?(...args: unknown[]): void;
}

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
