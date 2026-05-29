import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { AgentRunInput } from '@alembic/agent/service';
import {
  AgentProfileCompiler,
  AgentProfileRegistry,
  AgentStageFactoryRegistry,
} from '@alembic/agent/service';
import {
  buildBootstrapTerminalPolicyHints,
  getBootstrapStageTerminalTools,
  resolveBootstrapTerminalToolset,
} from '@alembic/core/host-agent-workflows';
import type { BootstrapDimensionPlan } from '#workflows/capabilities/execution/internal-agent/BootstrapDimensionRuntimeBuilder.js';
import type {
  AgentResultLike,
  BootstrapDimensionProjection,
  ToolCallRecord,
} from '#workflows/capabilities/execution/internal-agent/BootstrapProjections.js';

export const PCV_COLD_START_NODE_LOCAL_CONTRACT = 'PCVColdStartNodeLocalBaseline';
export const PCV_COLD_START_NODE_LOCAL_CONTRACT_VERSION = 1;
export const PCV_N8_NODE_ID = 'N8-stage-factory-tool-policy';
export const PCV_ANALYZE_GROUNDING_NODE_ID = 'analyze-evidence-grounding-ledger';
export const PCV_N11_NODE_ID = 'N11-produce';
export const PCV_N12_NODE_ID = 'N12-consumers-persistence';
export const PCV_BOOTSTRAP_STAGE_NODE_MAP_CONTRACT = 'PCVBootstrapStageNodeMap';
export const PCV_BOOTSTRAP_STAGE_NODE_MAP_CONTRACT_VERSION = 1;

export type PcvBootstrapStageKey = 'analyze' | 'quality_gate' | 'record_repair' | 'produce';

export interface PcvBootstrapStageNodeIdentity {
  pcvNodeId: string;
  chainNodeId: string;
}

export type PcvBootstrapStageNodeMap = Record<PcvBootstrapStageKey, PcvBootstrapStageNodeIdentity>;

export interface PcvBootstrapStageNodeContext {
  contract: typeof PCV_BOOTSTRAP_STAGE_NODE_MAP_CONTRACT;
  contractVersion: typeof PCV_BOOTSTRAP_STAGE_NODE_MAP_CONTRACT_VERSION;
  pcvStageNodeMap: PcvBootstrapStageNodeMap;
  pcvChainNodes: PcvBootstrapStageNodeMap;
}

export type PcvNodeLocalStatus =
  | 'linked'
  | 'partial-evidence'
  | 'blocked-by-observability-gap'
  | 'not-applicable';

export interface PcvNodeLocalEvidenceBase {
  chainNodeId: string;
  contract: typeof PCV_COLD_START_NODE_LOCAL_CONTRACT;
  contractVersion: typeof PCV_COLD_START_NODE_LOCAL_CONTRACT_VERSION;
  dimensionId: string;
  missingLinkReasons: string[];
  nodeId: string;
  sourceRefs: string[];
  status: PcvNodeLocalStatus;
  summary: string;
}

export type PcvN11SourceRefValidityStatus =
  | 'valid'
  | 'invalid'
  | 'empty'
  | 'not-checked'
  | 'not-applicable';

export type PcvN11InvalidSourceRefReason = 'file-not-found' | 'outside-project-root';

export interface PcvN11InvalidSourceRef {
  normalizedPath: string | null;
  reason: PcvN11InvalidSourceRefReason;
  ref: string;
}

export interface PcvN11SourceRefValiditySummary {
  checked: boolean;
  invalidSourceRefCount: number;
  invalidSourceRefRatio: number;
  invalidSourceRefs: PcvN11InvalidSourceRef[];
  status: PcvN11SourceRefValidityStatus;
  totalSourceRefCount: number;
  uncheckedReason: string | null;
  validSourceRefCount: number;
}

export interface PcvSourceRefValidationContext {
  allFiles?: Array<{ name?: string; path?: string; relativePath?: string }> | null;
  fileExists?: (absolutePath: string) => boolean;
  maxInvalidSourceRefs?: number;
  projectRoot?: string | null;
  targetFileMap?: unknown;
}

export interface PcvN11SourceRefReplayInput {
  acceptedCount?: number;
  dimId: string;
  maxInvalidSourceRefs?: number;
  projectRoot?: string | null;
  rejectedCount?: number;
  sourceRefs: string[];
  validSourceRefs: string[];
}

export interface PcvN8StagePolicy {
  additionalTools: string[];
  stage: string;
  terminalAllowed: boolean;
  terminalTools: string[];
}

export interface PcvN8StageFactoryEvidence extends PcvNodeLocalEvidenceBase {
  evidenceKind: 'stage-factory-tool-policy';
  producerToolRestriction: {
    gapLimit: number | null;
    noTerminalProof: boolean;
    producerStagePresent: boolean;
    requiredSubmitTool: 'knowledge';
    terminalToolIds: string[];
  };
  stageOrder: string[];
  stageToolPolicies: PcvN8StagePolicy[];
  terminalCapabilityHints: ReturnType<typeof buildBootstrapTerminalPolicyHints>;
}

export type PcvAnalyzeGroundingClassification =
  | 'deterministic-evidence-consumed'
  | 'evidence-produced'
  | 'verification-only'
  | 'record-only'
  | 'planning-only'
  | 'invalid-no-evidence'
  | 'summary-only';

export interface PcvAnalyzeGroundingLedgerSummary extends PcvNodeLocalEvidenceBase {
  burnCount: number;
  classifications: Record<PcvAnalyzeGroundingClassification, number>;
  deepseekV4NoForcedToolChoiceCount: number;
  deterministicEvidenceConsumedCount: number;
  evidenceKind: 'analyze-grounding-ledger';
  evidenceProducedCount: number;
  invalidNoEvidenceCount: number;
  planningOnlyCount: number;
  recordOnlyCount: number;
  summaryOnlyCount: number;
  toolSchemasVisibleCount: number;
  verificationOnlyCount: number;
}

export interface PcvN11ProduceEvidence extends PcvNodeLocalEvidenceBase {
  acceptedCount: number;
  evidenceKind: 'producer-cut';
  gapLimit: number | null;
  invalidSourceRefCount: number;
  invalidSourceRefRatio: number;
  invalidSourceRefs: PcvN11InvalidSourceRef[];
  noTerminalProof: boolean;
  producerOnlyCut: boolean;
  producerToolCalls: Array<{ action: string | null; status: string | null; tool: string }>;
  rejectedCount: number;
  sourceRefs: string[];
  sourceRefValidity: PcvN11SourceRefValiditySummary;
  sourceRefValidityStatus: PcvN11SourceRefValidityStatus;
  submittedCount: number;
  terminalToolCallCount: number;
  totalSourceRefCount: number;
  validSourceRefCount: number;
}

export interface PcvN12ConsumerPersistenceEvidence extends PcvNodeLocalEvidenceBase {
  acceptedCandidateTitles: string[];
  evidenceKind: 'consumer-persistence';
  failureDetailsPersisted: boolean;
  findableCandidateTitles: string[];
  persistedFailureReason: string | null;
  sessionStoreSnapshotAvailable: boolean;
}

export interface BootstrapPcvNodeEvidenceSet {
  n8?: PcvN8StageFactoryEvidence;
  groundingLedger?: PcvAnalyzeGroundingLedgerSummary;
  n11?: PcvN11ProduceEvidence;
  n12?: PcvN12ConsumerPersistenceEvidence;
}

const BOOTSTRAP_STAGE_NODE_MAP: PcvBootstrapStageNodeMap = {
  analyze: {
    chainNodeId: 'pcvm:cold-start:n9',
    pcvNodeId: 'pcvm:n9:analyze',
  },
  quality_gate: {
    chainNodeId: 'pcvm:cold-start:n9:quality',
    pcvNodeId: 'pcvm:n9:quality_gate',
  },
  record_repair: {
    chainNodeId: 'pcvm:cold-start:n9:repair',
    pcvNodeId: 'pcvm:n9:record_repair',
  },
  produce: {
    chainNodeId: 'pcvm:cold-start:n11',
    pcvNodeId: 'pcvm:n11:produce',
  },
};

const TERMINAL_TOOL_IDS = new Set(['terminal', 'terminal_shell', 'terminal_pty']);
const MAX_INVALID_SOURCE_REFS = 12;
const PRODUCER_SOURCE_REFS_INVALID_REASON = 'producer_source_refs_invalid';

export function buildBootstrapPcvStageNodeMap(): PcvBootstrapStageNodeMap {
  return cloneBootstrapStageNodeMap(BOOTSTRAP_STAGE_NODE_MAP);
}

export function buildBootstrapPcvStageNodeContext(): PcvBootstrapStageNodeContext {
  const pcvStageNodeMap = buildBootstrapPcvStageNodeMap();
  return {
    contract: PCV_BOOTSTRAP_STAGE_NODE_MAP_CONTRACT,
    contractVersion: PCV_BOOTSTRAP_STAGE_NODE_MAP_CONTRACT_VERSION,
    pcvStageNodeMap,
    pcvChainNodes: cloneBootstrapStageNodeMap(pcvStageNodeMap),
  };
}

function cloneBootstrapStageNodeMap(map: PcvBootstrapStageNodeMap): PcvBootstrapStageNodeMap {
  return {
    analyze: { ...map.analyze },
    quality_gate: { ...map.quality_gate },
    record_repair: { ...map.record_repair },
    produce: { ...map.produce },
  };
}

export function buildPcvN8StageFactoryEvidence({
  dimId,
  label,
  plan,
  runInput,
}: {
  dimId: string;
  label?: string | null;
  plan: BootstrapDimensionPlan;
  runInput: AgentRunInput;
}): PcvN8StageFactoryEvidence {
  const terminalCapability = resolveBootstrapTerminalToolset();
  const terminalCapabilityHints = buildBootstrapTerminalPolicyHints(terminalCapability);
  const compiledPolicies = compileBootstrapDimensionStagePolicies(runInput);
  const stageToolPolicies =
    compiledPolicies.length > 0
      ? compiledPolicies
      : fallbackBootstrapDimensionStagePolicies({
          hasExistingRecipes: plan.hasExistingRecipes,
          needsCandidates: plan.needsCandidates,
          prescreenDone: plan.prescreenDone,
          terminalCapability,
        });
  const stageOrder = stageToolPolicies.map((stage) => stage.stage);
  const producerPolicy = stageToolPolicies.find((stage) => stage.stage === 'produce') || null;
  const terminalToolIds = producerPolicy?.terminalTools || [];
  const missingLinkReasons: string[] = [];

  if (stageOrder.length === 0) {
    missingLinkReasons.push('stage_order_missing');
  }
  if (plan.needsCandidates && !producerPolicy) {
    missingLinkReasons.push('producer_stage_missing');
  }
  if (terminalToolIds.length > 0) {
    missingLinkReasons.push('producer_terminal_tools_allowed');
  }

  const status = missingLinkReasons.length > 0 ? 'blocked-by-observability-gap' : 'linked';
  return {
    chainNodeId: PCV_N8_NODE_ID,
    contract: PCV_COLD_START_NODE_LOCAL_CONTRACT,
    contractVersion: PCV_COLD_START_NODE_LOCAL_CONTRACT_VERSION,
    dimensionId: dimId,
    evidenceKind: 'stage-factory-tool-policy',
    missingLinkReasons,
    nodeId: PCV_N8_NODE_ID,
    producerToolRestriction: {
      gapLimit: resolveProducerGapLimit(plan),
      noTerminalProof: terminalToolIds.length === 0,
      producerStagePresent: Boolean(producerPolicy),
      requiredSubmitTool: 'knowledge',
      terminalToolIds,
    },
    sourceRefs: [
      'lib/workflows/capabilities/execution/internal-agent/BootstrapDimensionRuntimeBuilder.ts',
      'lib/workflows/capabilities/execution/internal-agent/BootstrapSessionExecutionBuilder.ts',
      'node_modules/@alembic/agent/src/agent/profiles/AgentStageFactoryRegistry.ts',
      'vendor/AlembicCore/src/workflows/capabilities/planning/dimensions/BootstrapTerminalToolset.ts',
    ],
    stageOrder,
    stageToolPolicies,
    status,
    summary: `${label || dimId} bootstrap stage factory resolved ${stageOrder.length} stage(s); producer terminal tools are ${terminalToolIds.length === 0 ? 'blocked' : 'allowed'}.`,
    terminalCapabilityHints,
  };
}

export function buildPcvN11ProduceEvidence({
  dimId,
  needsCandidates,
  projection,
  sourceRefValidation,
}: {
  dimId: string;
  needsCandidates: boolean;
  projection: BootstrapDimensionProjection;
  sourceRefValidation?: PcvSourceRefValidationContext | null;
}): PcvN11ProduceEvidence {
  const produceNodeIdentity = buildBootstrapPcvStageNodeMap().produce;
  const producerOnlyCut = Array.isArray(projection.produceResult?.toolCalls);
  const producerToolCalls = resolveProducerToolCalls(projection);
  const producerSubmitCalls = producerToolCalls.filter(isKnowledgeSubmitToolCall);
  const acceptedCount = producerSubmitCalls.filter(isSuccessfulToolCall).length;
  const rejectedCount = producerSubmitCalls.length - acceptedCount;
  const sourceRefs = collectSourceRefsFromProjection(projection);
  const sourceRefValidity = buildSourceRefValiditySummary({
    needsCandidates,
    sourceRefs,
    validation: sourceRefValidation,
  });
  const terminalToolCallCount = producerToolCalls.filter((call) =>
    TERMINAL_TOOL_IDS.has(toolName(call))
  ).length;
  const missingLinkReasons: string[] = [];

  if (needsCandidates && !producerOnlyCut) {
    missingLinkReasons.push('producer_stage_tool_calls_missing');
  }
  if (terminalToolCallCount > 0) {
    missingLinkReasons.push('producer_terminal_tool_call_detected');
  }
  if (needsCandidates && acceptedCount !== projection.successCount) {
    missingLinkReasons.push('producer_accepted_count_mismatch');
  }
  if (needsCandidates && rejectedCount !== projection.rejectedCount) {
    missingLinkReasons.push('producer_rejected_count_mismatch');
  }
  if (needsCandidates && sourceRefValidity.invalidSourceRefCount > 0) {
    missingLinkReasons.push(PRODUCER_SOURCE_REFS_INVALID_REASON);
  }

  const status = !needsCandidates
    ? 'not-applicable'
    : missingLinkReasons.length > 0
      ? 'blocked-by-observability-gap'
      : 'linked';
  return {
    acceptedCount,
    chainNodeId: produceNodeIdentity.chainNodeId,
    contract: PCV_COLD_START_NODE_LOCAL_CONTRACT,
    contractVersion: PCV_COLD_START_NODE_LOCAL_CONTRACT_VERSION,
    dimensionId: dimId,
    evidenceKind: 'producer-cut',
    gapLimit: null,
    invalidSourceRefCount: sourceRefValidity.invalidSourceRefCount,
    invalidSourceRefRatio: sourceRefValidity.invalidSourceRefRatio,
    invalidSourceRefs: sourceRefValidity.invalidSourceRefs,
    missingLinkReasons,
    noTerminalProof: terminalToolCallCount === 0,
    nodeId: produceNodeIdentity.pcvNodeId,
    producerOnlyCut,
    producerToolCalls: producerToolCalls.map((call) => ({
      action: actionName(call),
      status: resultStatus(call),
      tool: toolName(call),
    })),
    rejectedCount,
    sourceRefs,
    sourceRefValidity,
    sourceRefValidityStatus: sourceRefValidity.status,
    status,
    submittedCount: producerSubmitCalls.length,
    summary: needsCandidates
      ? `Producer submitted ${producerSubmitCalls.length} candidate call(s): ${acceptedCount} accepted, ${rejectedCount} rejected.`
      : 'Producer node is not applicable for skill-only bootstrap dimensions.',
    terminalToolCallCount,
    totalSourceRefCount: sourceRefValidity.totalSourceRefCount,
    validSourceRefCount: sourceRefValidity.validSourceRefCount,
  };
}

export function buildPcvAnalyzeGroundingLedgerSummary({
  dimId,
  label,
  runResult,
}: {
  dimId: string;
  label?: string | null;
  runResult: AgentResultLike;
}): PcvAnalyzeGroundingLedgerSummary | null {
  const entries = collectPcvAnalyzeGroundingLedgerEntries(runResult);
  if (entries.length === 0) {
    return null;
  }

  const analyzeNodeIdentity = buildBootstrapPcvStageNodeMap().analyze;
  const classifications = emptyGroundingClassifications();
  let toolSchemasVisibleCount = 0;
  let deepseekV4NoForcedToolChoiceCount = 0;

  for (const entry of entries) {
    const classification = groundingClassification(entry);
    classifications[classification] += 1;
    if (
      entry.toolSchemasVisible === true ||
      (entry.toolSchemasVisible !== false && stringArray(entry.toolSchemaNames).length > 0)
    ) {
      toolSchemasVisibleCount += 1;
    }
    if (entry.deepseekV4ToolChoiceMode === 'tools-visible-no-forced-tool-choice') {
      deepseekV4NoForcedToolChoiceCount += 1;
    }
  }

  const invalidNoEvidenceCount = classifications['invalid-no-evidence'];
  const planningOnlyCount = classifications['planning-only'];
  const evidenceProducedCount = classifications['evidence-produced'];
  const deterministicEvidenceConsumedCount = classifications['deterministic-evidence-consumed'];
  const verificationOnlyCount = classifications['verification-only'];
  const recordOnlyCount = classifications['record-only'];
  const summaryOnlyCount = classifications['summary-only'];
  const evidenceThroughCount =
    evidenceProducedCount +
    deterministicEvidenceConsumedCount +
    verificationOnlyCount +
    recordOnlyCount;
  const missingLinkReasons: string[] = [];

  if (invalidNoEvidenceCount > 0) {
    missingLinkReasons.push('analyze_grounding_invalid_no_evidence');
  }
  if (evidenceThroughCount === 0 && planningOnlyCount > 0) {
    missingLinkReasons.push('analyze_grounding_planning_only');
  }

  return {
    burnCount: entries.length,
    chainNodeId: analyzeNodeIdentity.chainNodeId,
    classifications,
    contract: PCV_COLD_START_NODE_LOCAL_CONTRACT,
    contractVersion: PCV_COLD_START_NODE_LOCAL_CONTRACT_VERSION,
    deepseekV4NoForcedToolChoiceCount,
    deterministicEvidenceConsumedCount,
    dimensionId: dimId,
    evidenceKind: 'analyze-grounding-ledger',
    evidenceProducedCount,
    invalidNoEvidenceCount,
    missingLinkReasons,
    nodeId: analyzeNodeIdentity.pcvNodeId,
    planningOnlyCount,
    recordOnlyCount,
    sourceRefs: [
      'lib/workflows/capabilities/execution/internal-agent/BootstrapConsumers.ts',
      'lib/workflows/capabilities/execution/internal-agent/BootstrapPcvNodeLocalEvidence.ts',
      'node_modules/@alembic/agent/src/agent/runtime/PcvNodeEvidence.ts',
    ],
    status:
      missingLinkReasons.length > 0
        ? 'partial-evidence'
        : evidenceThroughCount > 0
          ? 'linked'
          : 'not-applicable',
    summary: `${label || dimId} analyze grounding ledger recorded ${entries.length} burn(s): ${evidenceProducedCount} produced evidence, ${deterministicEvidenceConsumedCount} consumed deterministic evidence, ${invalidNoEvidenceCount} lacked evidence.`,
    summaryOnlyCount,
    toolSchemasVisibleCount,
    verificationOnlyCount,
  };
}

export function buildPcvN11SourceRefReplayEvidence({
  acceptedCount = 1,
  dimId,
  maxInvalidSourceRefs,
  projectRoot = null,
  rejectedCount = 0,
  sourceRefs,
  validSourceRefs,
}: PcvN11SourceRefReplayInput): PcvN11ProduceEvidence {
  const projection: BootstrapDimensionProjection = {
    analysisReport: {
      analysisText: `Deterministic N11 sourceRef replay for ${dimId}.`,
      dimensionId: dimId,
      findings: [],
      referencedFiles: sourceRefs,
    },
    produceResult: {
      reply: 'deterministic N11 sourceRef replay',
      toolCalls: buildReplayProducerToolCalls({ acceptedCount, rejectedCount, sourceRefs }),
    },
    rejectedCount,
    runtimeToolCalls: [],
    successCount: acceptedCount,
  } as unknown as BootstrapDimensionProjection;

  return buildPcvN11ProduceEvidence({
    dimId,
    needsCandidates: true,
    projection,
    sourceRefValidation: {
      allFiles: validSourceRefs.map((ref) => ({ relativePath: ref })),
      fileExists: () => false,
      maxInvalidSourceRefs,
      projectRoot,
    },
  });
}

export function buildPcvN12ConsumerPersistenceEvidence({
  acceptedSubmitCalls,
  dimId,
  runIssueReason,
  sessionStore,
}: {
  acceptedSubmitCalls: ToolCallRecord[];
  dimId: string;
  runIssueReason?: string | null;
  sessionStore: unknown;
}): PcvN12ConsumerPersistenceEvidence {
  const sessionSnapshot = safeSessionStoreSnapshot(sessionStore);
  const acceptedCandidateTitles = acceptedSubmitCalls
    .map((call) => candidateTitle(call))
    .filter((title): title is string => Boolean(title));
  const findableCandidateTitles = sessionSnapshot
    ? extractSubmittedCandidateTitles(sessionSnapshot, dimId)
    : [];
  const missingAcceptedTitles = acceptedCandidateTitles.filter(
    (title) => !findableCandidateTitles.includes(title)
  );
  const missingLinkReasons: string[] = [];

  if (acceptedCandidateTitles.length > 0 && !sessionSnapshot) {
    missingLinkReasons.push('session_store_snapshot_missing');
  }
  if (missingAcceptedTitles.length > 0) {
    missingLinkReasons.push('accepted_candidates_not_findable');
  }
  if (runIssueReason && runIssueReason.trim().length === 0) {
    missingLinkReasons.push('failure_reason_empty');
  }

  return {
    acceptedCandidateTitles,
    chainNodeId: PCV_N12_NODE_ID,
    contract: PCV_COLD_START_NODE_LOCAL_CONTRACT,
    contractVersion: PCV_COLD_START_NODE_LOCAL_CONTRACT_VERSION,
    dimensionId: dimId,
    evidenceKind: 'consumer-persistence',
    failureDetailsPersisted: !runIssueReason || runIssueReason.trim().length > 0,
    findableCandidateTitles,
    missingLinkReasons,
    nodeId: PCV_N12_NODE_ID,
    persistedFailureReason: runIssueReason || null,
    sessionStoreSnapshotAvailable: Boolean(sessionSnapshot),
    sourceRefs: [
      'lib/workflows/capabilities/execution/internal-agent/BootstrapConsumers.ts',
      'node_modules/@alembic/agent/src/agent/memory/SessionStore.ts',
      'lib/workflows/capabilities/execution/internal-agent/InternalDimensionFillFinalizer.ts',
    ],
    status: missingLinkReasons.length > 0 ? 'blocked-by-observability-gap' : 'linked',
    summary:
      acceptedCandidateTitles.length > 0
        ? `${findableCandidateTitles.length}/${acceptedCandidateTitles.length} accepted candidate(s) are findable in SessionStore.`
        : 'Consumer persistence recorded no accepted producer candidates for this dimension.',
  };
}

export function buildPcvN12ErrorEvidence({
  dimId,
  error,
}: {
  dimId: string;
  error: string;
}): PcvN12ConsumerPersistenceEvidence {
  return buildPcvN12ConsumerPersistenceEvidence({
    acceptedSubmitCalls: [],
    dimId,
    runIssueReason: error,
    sessionStore: null,
  });
}

export function mergeBootstrapPcvNodeEvidence(
  existing: unknown,
  next: BootstrapPcvNodeEvidenceSet
): BootstrapPcvNodeEvidenceSet {
  return {
    ...(isRecord(existing) ? existing : {}),
    ...next,
  } as BootstrapPcvNodeEvidenceSet;
}

export function resolveProducerToolCalls(
  projection: BootstrapDimensionProjection
): ToolCallRecord[] {
  if (Array.isArray(projection.produceResult?.toolCalls)) {
    return projection.produceResult.toolCalls;
  }
  return projection.runtimeToolCalls || [];
}

export function successfulProducerSubmitCalls(
  projection: BootstrapDimensionProjection
): ToolCallRecord[] {
  return resolveProducerToolCalls(projection).filter(
    (call) => isKnowledgeSubmitToolCall(call) && isSuccessfulToolCall(call)
  );
}

function buildReplayProducerToolCalls({
  acceptedCount,
  rejectedCount,
  sourceRefs,
}: {
  acceptedCount: number;
  rejectedCount: number;
  sourceRefs: string[];
}): ToolCallRecord[] {
  const acceptedCalls = Array.from({ length: acceptedCount }, (_, index) => ({
    args: {
      action: 'submit',
      params: {
        sourceRefs: index === 0 ? sourceRefs : [],
        title: `Deterministic N11 replay candidate ${index + 1}`,
      },
    },
    result: { status: 'created', title: `Deterministic N11 replay candidate ${index + 1}` },
    tool: 'knowledge',
  }));
  const rejectedCalls = Array.from({ length: rejectedCount }, (_, index) => ({
    args: {
      action: 'submit',
      params: {
        sourceRefs: [],
        title: `Rejected deterministic N11 replay candidate ${index + 1}`,
      },
    },
    result: { error: 'deterministic replay rejected candidate' },
    tool: 'knowledge',
  }));
  return [...acceptedCalls, ...rejectedCalls] as ToolCallRecord[];
}

function collectPcvAnalyzeGroundingLedgerEntries(
  runResult: AgentResultLike
): Array<Record<string, unknown>> {
  const candidates: unknown[] = [runResult];
  const phases = runResult.phases || {};
  const analyze = phases.analyze;
  const qualityGate = phases.quality_gate;
  candidates.push(analyze);
  if (isRecord(qualityGate)) {
    candidates.push(qualityGate.artifact);
  }
  for (const phase of Object.values(phases)) {
    candidates.push(phase);
  }

  const entries: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const pcvNodeEvidence = isRecord(candidate) ? candidate.pcvNodeEvidence : null;
    const ledger = isRecord(pcvNodeEvidence) ? pcvNodeEvidence.groundingLedger : null;
    if (!Array.isArray(ledger)) {
      continue;
    }
    for (const item of ledger) {
      if (!isRecord(item)) {
        continue;
      }
      const ref = stringValue(item.ref) || JSON.stringify(item);
      if (seen.has(ref)) {
        continue;
      }
      seen.add(ref);
      entries.push(item);
    }
  }
  return entries;
}

function emptyGroundingClassifications(): Record<PcvAnalyzeGroundingClassification, number> {
  return {
    'deterministic-evidence-consumed': 0,
    'evidence-produced': 0,
    'invalid-no-evidence': 0,
    'planning-only': 0,
    'record-only': 0,
    'summary-only': 0,
    'verification-only': 0,
  };
}

function groundingClassification(
  entry: Record<string, unknown>
): PcvAnalyzeGroundingClassification {
  const classification = stringValue(entry.classification);
  if (
    classification === 'deterministic-evidence-consumed' ||
    classification === 'evidence-produced' ||
    classification === 'verification-only' ||
    classification === 'record-only' ||
    classification === 'planning-only' ||
    classification === 'invalid-no-evidence' ||
    classification === 'summary-only'
  ) {
    return classification;
  }
  return 'summary-only';
}

function compileBootstrapDimensionStagePolicies(runInput: AgentRunInput): PcvN8StagePolicy[] {
  try {
    const compiler = new AgentProfileCompiler({
      profileRegistry: new AgentProfileRegistry(),
      stageFactoryRegistry: new AgentStageFactoryRegistry(),
    });
    const profile = compiler.compile(runInput.profile, {
      context: runInput.context,
      params: runInput.params || {},
    });
    const strategy = profile.runtimeOverrides?.strategy as
      | { stages?: Array<Record<string, unknown>> }
      | undefined;
    return (strategy?.stages || [])
      .map((stage) => {
        const stageName = typeof stage.name === 'string' ? stage.name : null;
        if (!stageName) {
          return null;
        }
        const additionalTools = stringArray(stage.additionalTools);
        return {
          additionalTools,
          stage: stageName,
          terminalAllowed: additionalTools.some((tool) => TERMINAL_TOOL_IDS.has(tool)),
          terminalTools: additionalTools.filter((tool) => TERMINAL_TOOL_IDS.has(tool)),
        };
      })
      .filter((stage): stage is PcvN8StagePolicy => Boolean(stage));
  } catch {
    return [];
  }
}

function fallbackBootstrapDimensionStagePolicies({
  hasExistingRecipes,
  needsCandidates,
  prescreenDone,
  terminalCapability,
}: {
  hasExistingRecipes: boolean;
  needsCandidates: boolean;
  prescreenDone: boolean;
  terminalCapability: ReturnType<typeof resolveBootstrapTerminalToolset>;
}): PcvN8StagePolicy[] {
  const stageOrder = !needsCandidates
    ? ['analyze']
    : hasExistingRecipes && !prescreenDone
      ? ['evolve', 'evolution_gate', 'analyze', 'quality_gate', 'produce', 'rejection_gate']
      : ['analyze', 'quality_gate', 'produce', 'rejection_gate'];
  return stageOrder.map((stage) => {
    const additionalTools = getBootstrapStageTerminalTools(stage, terminalCapability);
    return {
      additionalTools,
      stage,
      terminalAllowed: additionalTools.some((tool) => TERMINAL_TOOL_IDS.has(tool)),
      terminalTools: additionalTools.filter((tool) => TERMINAL_TOOL_IDS.has(tool)),
    };
  });
}

function resolveProducerGapLimit(plan: BootstrapDimensionPlan): number | null {
  const createBudget = plan.rescanExecutionDecision?.createBudget;
  return typeof createBudget === 'number' && Number.isFinite(createBudget)
    ? Math.max(0, Math.floor(createBudget))
    : null;
}

function collectSourceRefsFromProjection(projection: BootstrapDimensionProjection): string[] {
  const refs = new Set<string>();
  for (const ref of projection.analysisReport?.referencedFiles || []) {
    refs.add(ref);
  }
  for (const call of resolveProducerToolCalls(projection)) {
    for (const ref of sourceRefsFromValue([call.args, call.params, call.result])) {
      refs.add(ref);
    }
  }
  return [...refs].slice(0, 50);
}

function sourceRefsFromValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(sourceRefsFromValue);
  }
  if (!isRecord(value)) {
    return typeof value === 'string' && looksLikeSourceRef(value) ? [value] : [];
  }
  const refs: string[] = [];
  for (const key of ['sourceRefs', 'referencedFiles', 'filePaths']) {
    const entry = value[key];
    if (Array.isArray(entry)) {
      refs.push(...entry.filter((item): item is string => typeof item === 'string'));
    }
  }
  for (const key of ['sourceRef', 'referencedFile', 'filePath']) {
    const entry = value[key];
    if (typeof entry === 'string') {
      refs.push(entry);
    }
  }
  const nestedParams = value.params;
  if (isRecord(nestedParams)) {
    refs.push(...sourceRefsFromValue(nestedParams));
  }
  return refs.filter(looksLikeSourceRef);
}

function looksLikeSourceRef(value: string): boolean {
  return /^(?:file:\/\/)?[\w/.-]+\.[\w]+(?::\d+)?(?::\d+)?$/.test(value.trim());
}

function buildSourceRefValiditySummary({
  needsCandidates,
  sourceRefs,
  validation,
}: {
  needsCandidates: boolean;
  sourceRefs: string[];
  validation?: PcvSourceRefValidationContext | null;
}): PcvN11SourceRefValiditySummary {
  if (!needsCandidates) {
    return sourceRefValiditySummary({
      checked: false,
      invalidRefs: [],
      sourceRefs,
      status: 'not-applicable',
      uncheckedReason: 'dimension_does_not_need_candidates',
      validCount: 0,
    });
  }
  if (sourceRefs.length === 0) {
    return sourceRefValiditySummary({
      checked: true,
      invalidRefs: [],
      sourceRefs,
      status: 'empty',
      uncheckedReason: null,
      validCount: 0,
    });
  }

  const index = buildSourceRefValidationIndex(validation);
  if (!index) {
    return sourceRefValiditySummary({
      checked: false,
      invalidRefs: [],
      sourceRefs,
      status: 'not-checked',
      uncheckedReason: 'project_file_index_unavailable',
      validCount: 0,
    });
  }

  let validCount = 0;
  const invalidRefs: PcvN11InvalidSourceRef[] = [];
  for (const ref of sourceRefs) {
    const result = validateSourceRef(ref, index);
    if (result.valid) {
      validCount++;
    } else {
      invalidRefs.push({
        normalizedPath: result.normalizedPath,
        reason: result.reason,
        ref,
      });
    }
  }

  return sourceRefValiditySummary({
    checked: true,
    invalidRefs,
    sourceRefs,
    status: invalidRefs.length > 0 ? 'invalid' : 'valid',
    uncheckedReason: null,
    validCount,
    maxInvalidRefs: validation?.maxInvalidSourceRefs,
  });
}

function sourceRefValiditySummary({
  checked,
  invalidRefs,
  maxInvalidRefs,
  sourceRefs,
  status,
  uncheckedReason,
  validCount,
}: {
  checked: boolean;
  invalidRefs: PcvN11InvalidSourceRef[];
  maxInvalidRefs?: number;
  sourceRefs: string[];
  status: PcvN11SourceRefValidityStatus;
  uncheckedReason: string | null;
  validCount: number;
}): PcvN11SourceRefValiditySummary {
  const total = sourceRefs.length;
  const invalidCount = invalidRefs.length;
  const invalidSourceRefRatio = total > 0 ? Number((invalidCount / total).toFixed(4)) : 0;
  const limit =
    typeof maxInvalidRefs === 'number' && Number.isFinite(maxInvalidRefs)
      ? Math.max(0, Math.floor(maxInvalidRefs))
      : MAX_INVALID_SOURCE_REFS;
  return {
    checked,
    invalidSourceRefCount: invalidCount,
    invalidSourceRefRatio,
    invalidSourceRefs: invalidRefs.slice(0, limit),
    status,
    totalSourceRefCount: total,
    uncheckedReason,
    validSourceRefCount: validCount,
  };
}

interface SourceRefValidationIndex {
  fileExists: (absolutePath: string) => boolean;
  fileSet: Set<string>;
  projectRoot: string | null;
  projectRootName: string | null;
}

function buildSourceRefValidationIndex(
  validation?: PcvSourceRefValidationContext | null
): SourceRefValidationIndex | null {
  const projectRoot = normalizeAbsolutePath(validation?.projectRoot || null);
  const fileSet = new Set<string>();
  for (const file of validation?.allFiles || []) {
    addSourceFileRef(fileSet, file.relativePath, projectRoot);
    addSourceFileRef(fileSet, file.path, projectRoot);
    addSourceFileRef(fileSet, file.name, projectRoot);
  }
  for (const ref of sourceRefsFromTargetFileMap(validation?.targetFileMap)) {
    addSourceFileRef(fileSet, ref, projectRoot);
  }
  if (!projectRoot && fileSet.size === 0) {
    return null;
  }
  return {
    fileExists: validation?.fileExists || existsSync,
    fileSet,
    projectRoot,
    projectRootName: projectRoot ? path.basename(projectRoot) : null,
  };
}

function addSourceFileRef(fileSet: Set<string>, value: unknown, projectRoot: string | null): void {
  if (typeof value !== 'string' || !value.trim()) {
    return;
  }
  const normalized = normalizeKnownFilePath(value, projectRoot);
  if (normalized) {
    fileSet.add(normalized);
  }
}

function sourceRefsFromTargetFileMap(value: unknown, depth = 0): string[] {
  if (depth > 5 || value == null) {
    return [];
  }
  if (typeof value === 'string') {
    return looksLikeSourceRef(value) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => sourceRefsFromTargetFileMap(item, depth + 1));
  }
  if (!isRecord(value)) {
    return [];
  }
  const refs: string[] = [];
  for (const key of ['relativePath', 'path', 'filePath', 'name']) {
    const entry = value[key];
    if (typeof entry === 'string' && looksLikeSourceRef(entry)) {
      refs.push(entry);
    }
  }
  for (const entry of Object.values(value)) {
    refs.push(...sourceRefsFromTargetFileMap(entry, depth + 1));
    if (refs.length >= 2000) {
      break;
    }
  }
  return refs.slice(0, 2000);
}

function validateSourceRef(
  ref: string,
  index: SourceRefValidationIndex
):
  | { normalizedPath: string; valid: true }
  | { normalizedPath: string | null; reason: PcvN11InvalidSourceRefReason; valid: false } {
  const resolution = resolveSourceRefCandidates(ref, index);
  if (!resolution || resolution.outsideProjectRoot) {
    return {
      normalizedPath: resolution?.normalizedPath || null,
      reason: 'outside-project-root',
      valid: false,
    };
  }
  for (const candidate of resolution.candidates) {
    if (index.fileSet.has(candidate)) {
      return { normalizedPath: candidate, valid: true };
    }
    if (index.projectRoot) {
      const absolutePath = path.join(index.projectRoot, ...candidate.split('/'));
      if (index.fileExists(absolutePath)) {
        return { normalizedPath: candidate, valid: true };
      }
    }
  }
  return {
    normalizedPath: resolution.normalizedPath,
    reason: 'file-not-found',
    valid: false,
  };
}

function resolveSourceRefCandidates(
  ref: string,
  index: SourceRefValidationIndex
): { candidates: string[]; normalizedPath: string; outsideProjectRoot: boolean } | null {
  const cleaned = stripSourceRefLineSuffix(stripFileUrl(safeDecodeURIComponent(ref.trim())));
  if (!cleaned) {
    return null;
  }

  const platformPath = cleaned.replace(/\//g, path.sep);
  let normalizedPath: string | null = null;
  let outsideProjectRoot = false;

  if (path.isAbsolute(platformPath)) {
    const absolutePath = path.resolve(platformPath);
    if (index.projectRoot) {
      if (!isPathInsideProjectRoot(absolutePath, index.projectRoot)) {
        outsideProjectRoot = true;
      } else {
        normalizedPath = toPosixPath(path.relative(index.projectRoot, absolutePath));
      }
    } else {
      normalizedPath = toPosixPath(path.normalize(absolutePath));
    }
  } else {
    normalizedPath = normalizeRelativeSourcePath(cleaned);
    outsideProjectRoot =
      !normalizedPath || normalizedPath === '..' || normalizedPath.startsWith('../');
  }

  if (!normalizedPath || normalizedPath === '.' || outsideProjectRoot) {
    return { candidates: [], normalizedPath: normalizedPath || cleaned, outsideProjectRoot: true };
  }

  const candidates = [normalizedPath];
  if (index.projectRootName && normalizedPath.startsWith(`${index.projectRootName}/`)) {
    candidates.push(normalizedPath.slice(index.projectRootName.length + 1));
  }
  return { candidates: [...new Set(candidates)], normalizedPath, outsideProjectRoot: false };
}

function normalizeKnownFilePath(value: string, projectRoot: string | null): string | null {
  const cleaned = stripSourceRefLineSuffix(stripFileUrl(safeDecodeURIComponent(value.trim())));
  if (!cleaned) {
    return null;
  }
  const platformPath = cleaned.replace(/\//g, path.sep);
  if (path.isAbsolute(platformPath)) {
    const absolutePath = path.resolve(platformPath);
    if (projectRoot && isPathInsideProjectRoot(absolutePath, projectRoot)) {
      return toPosixPath(path.relative(projectRoot, absolutePath));
    }
    return toPosixPath(path.normalize(absolutePath));
  }
  return normalizeRelativeSourcePath(cleaned);
}

function normalizeAbsolutePath(value: string | null): string | null {
  if (!value || !value.trim()) {
    return null;
  }
  return path.resolve(value.trim());
}

function normalizeRelativeSourcePath(value: string): string | null {
  const normalized = path.posix.normalize(toPosixPath(value).replace(/^\.\//, ''));
  if (!normalized || normalized === '.') {
    return null;
  }
  return normalized;
}

function stripFileUrl(value: string): string {
  return value.startsWith('file://') ? value.slice('file://'.length) : value;
}

function stripSourceRefLineSuffix(value: string): string {
  return value.replace(/:(\d+)(?::\d+)?$/, '');
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isPathInsideProjectRoot(absolutePath: string, projectRoot: string): boolean {
  const relative = path.relative(projectRoot, absolutePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function isKnowledgeSubmitToolCall(call: ToolCallRecord): boolean {
  return toolName(call) === 'knowledge' && actionName(call) === 'submit';
}

function isSuccessfulToolCall(call: ToolCallRecord): boolean {
  const result = call.result;
  if (!result) {
    return true;
  }
  if (typeof result === 'string') {
    return !result.includes('rejected') && !result.includes('error');
  }
  if (!isRecord(result)) {
    return true;
  }
  if (result.error || result.submitted === false) {
    return false;
  }
  return result.status !== 'rejected' && result.status !== 'error';
}

function actionName(call: ToolCallRecord): string | null {
  const args = call.args || call.params || {};
  const nested = isRecord(args.params) ? args.params : args;
  return typeof nested.action === 'string'
    ? nested.action
    : typeof args.action === 'string'
      ? args.action
      : null;
}

function candidateTitle(call: ToolCallRecord): string | null {
  const args = call.args || call.params || {};
  const nested = isRecord(args.params) ? args.params : args;
  const result = isRecord(call.result) ? call.result : {};
  return stringValue(nested.title) || stringValue(result.title);
}

function resultStatus(call: ToolCallRecord): string | null {
  const result = call.result;
  if (typeof result === 'string') {
    return result.includes('rejected') || result.includes('error') ? 'error' : 'ok';
  }
  if (!isRecord(result)) {
    return result ? 'ok' : null;
  }
  return (
    stringValue(result.status) ||
    (result.error ? 'error' : result.submitted === false ? 'rejected' : 'ok')
  );
}

function toolName(call: ToolCallRecord): string {
  return call.tool || call.name || 'unknown';
}

function safeSessionStoreSnapshot(sessionStore: unknown): Record<string, unknown> | null {
  if (!sessionStore || typeof sessionStore !== 'object') {
    return null;
  }
  const toJSON = (sessionStore as { toJSON?: unknown }).toJSON;
  if (typeof toJSON !== 'function') {
    return null;
  }
  try {
    const snapshot = toJSON.call(sessionStore);
    return isRecord(snapshot) ? snapshot : null;
  } catch {
    return null;
  }
}

function extractSubmittedCandidateTitles(
  sessionSnapshot: Record<string, unknown>,
  dimId: string
): string[] {
  const submittedCandidates = sessionSnapshot.submittedCandidates;
  if (!isRecord(submittedCandidates)) {
    return [];
  }
  const dimensionCandidates = submittedCandidates[dimId];
  if (!Array.isArray(dimensionCandidates)) {
    return [];
  }
  return dimensionCandidates
    .map((item) => (isRecord(item) ? stringValue(item.title) : null))
    .filter((title): title is string => Boolean(title));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
