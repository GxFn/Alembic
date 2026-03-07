/**
 * Shared type definitions for MCP handler modules.
 * Runtime-free — only interfaces and type aliases.
 */

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

// ─── MCP Handler Context ─────────────────────────────────

/** MCP handler context passed from McpServer / router layer */
export interface McpContext {
  container: McpServiceContainer;
  startedAt?: number;
  session?: {
    id: string;
    readyCalled: boolean;
    toolCallCount: number;
    toolsUsed: Set<string>;
    startedAt: number;
    [key: string]: unknown;
  };
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
  restoredEpisodic: unknown;
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
