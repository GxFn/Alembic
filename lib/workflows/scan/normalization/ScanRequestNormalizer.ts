import type { FileChangeEvent, ReactiveEvolutionReport } from '#types/reactive-evolution.js';
import {
  type NormalizedFileChangeEvents,
  normalizeScanChangeSet,
} from '#workflows/scan/normalization/ScanChangeSetNormalizer.js';
import type {
  ScanLifecycleRequest,
  ScanLifecycleSource,
} from '#workflows/scan/ScanLifecycleTypes.js';
import type {
  DeepMiningRequest,
  IncrementalCorrectionRunInput,
  KnowledgeRetrievalInput,
  MaintenanceWorkflowOptions,
  ScanBudget,
  ScanDepth,
  ScanFileEvidenceInput,
  ScanMode,
  ScanPlanRequest,
  ScanScope,
} from '#workflows/scan/ScanTypes.js';

const VALID_SCAN_MODES = new Set<ScanMode>([
  'cold-start',
  'deep-mining',
  'incremental-correction',
  'maintenance',
]);
const VALID_SCAN_DEPTHS = new Set<ScanDepth>(['light', 'standard', 'deep', 'exhaustive']);

export interface ScanRequestNormalizerOptions {
  defaultProjectRoot: string;
}

export interface FileChangesScanOptions {
  enabled: boolean;
  projectRoot: string;
  runAgent: boolean;
  depth: ScanDepth;
  budget?: ScanBudget;
  primaryLang?: string;
}

export class ScanRequestNormalizer {
  readonly #defaultProjectRoot: string;

  constructor(options: ScanRequestNormalizerOptions) {
    this.#defaultProjectRoot = options.defaultProjectRoot;
  }

  toScanPlanRequest(value: unknown): ScanPlanRequest {
    const body = asRecord(value);
    const baseline = readBaseline(body.baseline);
    return {
      projectRoot: readString(body.projectRoot) || this.#defaultProjectRoot,
      intent: readIntent(body.intent),
      requestedMode: readScanMode(body.requestedMode),
      force: readOptionalBoolean(body.force),
      hasBaseline: readOptionalBoolean(body.hasBaseline),
      baselineRunId: readOptionalString(body.baselineRunId) ?? baseline.runId,
      baselineSnapshotId: readOptionalString(body.baselineSnapshotId) ?? baseline.snapshotId,
      totalFileCount: readOptionalNumber(body.totalFileCount),
      allDimensionIds: readStringArray(body.allDimensionIds),
      currentFiles: readFileInputs(body.currentFiles),
      dimensions: readStringArray(body.dimensions),
      modules: readStringArray(body.modules),
      recipeIds: readStringArray(body.recipeIds),
      query: readOptionalString(body.query),
      changeSet: normalizeScanChangeSet(body.changeSet),
      impactedRecipeIds: readStringArray(body.impactedRecipeIds),
      budget: readBudget(body.budget),
    };
  }

  toKnowledgeRetrievalInput(value: unknown): KnowledgeRetrievalInput {
    const body = asRecord(value);
    const mode = readScanMode(body.mode) ?? 'maintenance';
    return {
      projectRoot: readString(body.projectRoot) || this.#defaultProjectRoot,
      mode,
      intent: readRetrievalIntent(body.intent) ?? intentForMode(mode),
      depth: readScanDepth(body.depth),
      scope: readScope(body.scope ?? body),
      changeSet: normalizeScanChangeSet(body.changeSet),
      files: readFileInputs(body.files),
      budget: readBudget(body.budget),
      primaryLang: readOptionalString(body.primaryLang),
    };
  }

  toIncrementalCorrectionRunInput(
    value: unknown,
    events: FileChangeEvent[]
  ): IncrementalCorrectionRunInput {
    const body = asRecord(value);
    return {
      projectRoot: readString(body.projectRoot) || this.#defaultProjectRoot,
      events,
      runDeterministic: readBoolean(body.runDeterministic, true),
      runAgent: readBoolean(body.runAgent, false),
      depth: readScanDepth(body.depth) ?? 'standard',
      budget: readBudget(body.budget),
      primaryLang: readOptionalString(body.primaryLang),
    };
  }

  toIncrementalCorrectionLifecycleRequest(
    value: unknown,
    events: FileChangeEvent[],
    source: ScanLifecycleSource = 'http'
  ): ScanLifecycleRequest {
    const input = this.toIncrementalCorrectionRunInput(value, events);
    return {
      projectRoot: input.projectRoot,
      source,
      requestedMode: 'incremental-correction',
      intent: 'change-set',
      events: input.events,
      budget: input.budget,
      depth: input.depth,
      primaryLang: input.primaryLang ?? undefined,
      execution: {
        runAgent: input.runAgent,
        runDeterministic: input.runDeterministic,
      },
    };
  }

  toDeepMiningRequest(value: unknown): DeepMiningRequest {
    const body = asRecord(value);
    const depth = readScanDepth(body.depth);
    const baseline = readBaseline(body.baseline);
    return {
      projectRoot: readString(body.projectRoot) || this.#defaultProjectRoot,
      baselineRunId: readOptionalString(body.baselineRunId) ?? baseline.runId,
      baselineSnapshotId: readOptionalString(body.baselineSnapshotId) ?? baseline.snapshotId,
      dimensions: readStringArray(body.dimensions),
      modules: readStringArray(body.modules),
      query: readOptionalString(body.query),
      depth: depth === 'exhaustive' ? 'exhaustive' : 'deep',
      maxNewCandidates: readOptionalNumber(body.maxNewCandidates),
      files: readFileInputs(body.files),
      runAgent: readBoolean(body.runAgent, false),
      primaryLang: readOptionalString(body.primaryLang),
    };
  }

  toDeepMiningLifecycleRequest(
    value: unknown,
    source: ScanLifecycleSource = 'http'
  ): ScanLifecycleRequest {
    const request = this.toDeepMiningRequest(value);
    return {
      projectRoot: request.projectRoot,
      source,
      requestedMode: 'deep-mining',
      intent: 'deep-mining',
      baseline: {
        runId: request.baselineRunId,
        snapshotId: request.baselineSnapshotId,
      },
      dimensions: request.dimensions,
      modules: request.modules,
      query: request.query,
      files: request.files,
      budget: request.maxNewCandidates
        ? { maxKnowledgeItems: request.maxNewCandidates }
        : undefined,
      depth: request.depth,
      primaryLang: request.primaryLang ?? undefined,
      execution: {
        runAgent: request.runAgent,
      },
    };
  }

  toMaintenanceOptions(value: unknown): MaintenanceWorkflowOptions {
    const body = asRecord(value);
    return {
      projectRoot: readString(body.projectRoot) || this.#defaultProjectRoot,
      forceSourceRefReconcile: readOptionalBoolean(body.forceSourceRefReconcile),
      refreshSearchIndex: readOptionalBoolean(body.refreshSearchIndex),
      includeDecay: readOptionalBoolean(body.includeDecay),
      includeEnhancements: readOptionalBoolean(body.includeEnhancements),
      includeRedundancy: readOptionalBoolean(body.includeRedundancy),
    };
  }

  toMaintenanceLifecycleRequest(
    value: unknown,
    source: ScanLifecycleSource = 'http'
  ): ScanLifecycleRequest {
    const options = this.toMaintenanceOptions(value);
    return {
      projectRoot: options.projectRoot,
      source,
      requestedMode: 'maintenance',
      intent: 'maintenance',
      depth: 'light',
      maintenance: {
        forceSourceRefReconcile: options.forceSourceRefReconcile,
        refreshSearchIndex: options.refreshSearchIndex,
        includeDecay: options.includeDecay,
        includeEnhancements: options.includeEnhancements,
        includeRedundancy: options.includeRedundancy,
      },
    };
  }

  toFileChangesLifecycleRequest(
    scanValue: unknown,
    bodyValue: unknown,
    events: FileChangeEvent[],
    reactiveReport?: ReactiveEvolutionReport,
    source: ScanLifecycleSource = 'file-changes'
  ): ScanLifecycleRequest | null {
    const options = this.toFileChangesScanOptions(scanValue, bodyValue);
    if (!options.enabled) {
      return null;
    }
    return {
      projectRoot: options.projectRoot,
      source,
      requestedMode: 'incremental-correction',
      intent: 'change-set',
      events,
      reactiveReport,
      budget: options.budget,
      depth: options.depth,
      primaryLang: options.primaryLang,
      execution: {
        runAgent: options.runAgent,
        runDeterministic: false,
      },
    };
  }

  toFileChangesScanOptions(scanValue: unknown, bodyValue: unknown): FileChangesScanOptions {
    const options = asRecord(scanValue);
    const body = asRecord(bodyValue);
    return {
      enabled: options.enabled === true,
      projectRoot:
        readString(options.projectRoot) || readString(body.projectRoot) || this.#defaultProjectRoot,
      runAgent: readBoolean(options.runAgent, false),
      depth: readScanDepth(options.depth) ?? 'standard',
      budget: readBudget(options.budget),
      primaryLang: readOptionalString(options.primaryLang),
    };
  }
}

export function hasValidFileChangeEvents(normalized: NormalizedFileChangeEvents): boolean {
  return normalized.wasArray && normalized.inputCount > 0 && normalized.events.length > 0;
}

function readBaseline(value: unknown): { runId: string | null; snapshotId: string | null } {
  const baseline = asRecord(value);
  return {
    runId: readOptionalString(baseline.runId) ?? null,
    snapshotId: readOptionalString(baseline.snapshotId) ?? null,
  };
}

function readScope(value: unknown): ScanScope {
  const body = asRecord(value);
  return {
    dimensions: readStringArray(body.dimensions),
    files: readStringArray(body.files),
    modules: readStringArray(body.modules),
    symbols: readStringArray(body.symbols),
    recipeIds: readStringArray(body.recipeIds),
    query: readOptionalString(body.query),
  };
}

function readFileInputs(value: unknown): ScanFileEvidenceInput[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((item) => {
    const record = asRecord(item);
    const relativePath = readString(record.relativePath) || readString(record.path);
    if (!relativePath) {
      return [];
    }

    const file: ScanFileEvidenceInput = { relativePath };
    const path = readOptionalString(record.path);
    const name = readOptionalString(record.name);
    const language = readOptionalString(record.language);
    const content = readOptionalString(record.content);
    const hash = readOptionalString(record.hash);

    if (path) {
      file.path = path;
    }
    if (name) {
      file.name = name;
    }
    if (language) {
      file.language = language;
    }
    if (content) {
      file.content = content;
    }
    if (hash) {
      file.hash = hash;
    }

    return [file];
  });
}

function readBudget(value: unknown): ScanBudget | undefined {
  const body = asRecord(value);
  if (Object.keys(body).length === 0) {
    return undefined;
  }
  return {
    maxFiles: readOptionalNumber(body.maxFiles),
    maxFileChars: readOptionalNumber(body.maxFileChars),
    maxKnowledgeItems: readOptionalNumber(body.maxKnowledgeItems),
    maxGraphEdges: readOptionalNumber(body.maxGraphEdges),
    maxTotalChars: readOptionalNumber(body.maxTotalChars),
  };
}

function readIntent(value: unknown): ScanPlanRequest['intent'] {
  return value === 'bootstrap' ||
    value === 'change-set' ||
    value === 'deep-mining' ||
    value === 'maintenance'
    ? value
    : undefined;
}

function readRetrievalIntent(value: unknown): KnowledgeRetrievalInput['intent'] | undefined {
  return value === 'build-baseline' ||
    value === 'fill-coverage-gap' ||
    value === 'repair-stale-knowledge' ||
    value === 'audit-impacted-recipes' ||
    value === 'maintain-health'
    ? value
    : undefined;
}

function intentForMode(mode: ScanMode): KnowledgeRetrievalInput['intent'] {
  switch (mode) {
    case 'cold-start':
      return 'build-baseline';
    case 'deep-mining':
      return 'fill-coverage-gap';
    case 'incremental-correction':
      return 'audit-impacted-recipes';
    case 'maintenance':
      return 'maintain-health';
  }
}

function readScanMode(value: unknown): ScanMode | undefined {
  return typeof value === 'string' && VALID_SCAN_MODES.has(value as ScanMode)
    ? (value as ScanMode)
    : undefined;
}

function readScanDepth(value: unknown): ScanDepth | undefined {
  return typeof value === 'string' && VALID_SCAN_DEPTHS.has(value as ScanDepth)
    ? (value as ScanDepth)
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
