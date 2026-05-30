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
export const PCV_NODE_EVIDENCE_ENVELOPE_CONTRACT = 'PcvNodeEvidenceEnvelope';
export const PCV_NODE_EVIDENCE_ENVELOPE_CONTRACT_VERSION = 1;
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

export type PcvN11SourceRefReason =
  | 'ambiguous-basename'
  | 'entity-not-file'
  | 'file-not-found'
  | 'missing-prefix'
  | 'outside-project-root'
  | 'package-path-mismatch'
  | 'wrong-extension';

export type PcvN11InvalidSourceRefReason = PcvN11SourceRefReason;

export interface PcvN11SourceRefAttribution {
  action: string | null;
  candidateId: string | null;
  candidateTitle: string | null;
  contentField: string;
  fieldPath: string;
  status: string | null;
  tool: string;
  toolCallIndex: number | null;
}

export interface PcvN11InvalidSourceRef {
  attributions?: PcvN11SourceRefAttribution[];
  candidates?: string[];
  candidateId?: string | null;
  candidateTitle?: string | null;
  contentField?: string | null;
  fieldPath?: string | null;
  normalizedPath: string | null;
  rawReason?: string | null;
  reason: PcvN11InvalidSourceRefReason;
  ref: string;
  source?: 'agent' | 'report-fallback';
  suggestedRef?: string | null;
  toolCallIndex?: number | null;
}

export interface PcvN11RepairedSourceRef {
  from: string;
  rawReason?: string | null;
  reason: Extract<PcvN11SourceRefReason, 'missing-prefix' | 'wrong-extension'>;
  source: 'agent';
  to: string;
}

export interface PcvN11RejectedSourceRef extends PcvN11InvalidSourceRef {
  source: 'agent';
}

export interface PcvN11WarningSourceRef extends PcvN11InvalidSourceRef {
  source: 'agent';
}

export interface PcvN11SourceRefValiditySummary {
  attributedInvalidSourceRefCount: number;
  checked: boolean;
  invalidSourceRefCount: number;
  invalidSourceRefRatio: number;
  invalidSourceRefs: PcvN11InvalidSourceRef[];
  reasonCounts: Record<PcvN11SourceRefReason, number>;
  repairedSourceRefCount: number;
  repairedSourceRefs: PcvN11RepairedSourceRef[];
  rejectedSourceRefCount: number;
  rejectedSourceRefs: PcvN11RejectedSourceRef[];
  status: PcvN11SourceRefValidityStatus;
  totalSourceRefCount: number;
  unattributedInvalidSourceRefCount: number;
  uncheckedReason: string | null;
  validSourceRefCount: number;
  validationMode: string | null;
  validationPolicy: Record<string, unknown> | null;
  warningSourceRefCount: number;
  warningSourceRefs: PcvN11WarningSourceRef[];
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

export type PcvN9StageProjectionKey = Extract<
  PcvBootstrapStageKey,
  'quality_gate' | 'record_repair'
>;

export interface PcvN9StageProjectionEvidence extends PcvNodeLocalEvidenceBase {
  action: string | null;
  evidenceKind: 'n9-stage-projection';
  pass: boolean | null;
  phasePresent: boolean;
  projectionSource: 'phase' | 'stage-map';
  stageId: PcvN9StageProjectionKey;
  timedOut: boolean;
}

export interface PcvN11ProduceEvidence extends PcvNodeLocalEvidenceBase {
  acceptedCount: number;
  attributedInvalidSourceRefCount: number;
  evidenceKind: 'producer-cut';
  gapLimit: number | null;
  invalidSourceRefCount: number;
  invalidSourceRefRatio: number;
  invalidSourceRefs: PcvN11InvalidSourceRef[];
  noTerminalProof: boolean;
  producerOnlyCut: boolean;
  producerToolCalls: Array<{ action: string | null; status: string | null; tool: string }>;
  repairedSourceRefCount: number;
  repairedSourceRefs: PcvN11RepairedSourceRef[];
  rejectedCount: number;
  rejectedSourceRefCount: number;
  rejectedSourceRefs: PcvN11RejectedSourceRef[];
  sourceRefReasonCounts: Record<PcvN11SourceRefReason, number>;
  sourceRefs: string[];
  sourceRefValidity: PcvN11SourceRefValiditySummary;
  sourceRefValidityStatus: PcvN11SourceRefValidityStatus;
  sourceRefValidationMode: string | null;
  sourceRefValidationPolicy: Record<string, unknown> | null;
  submittedCount: number;
  terminalToolCallCount: number;
  totalSourceRefCount: number;
  unattributedInvalidSourceRefCount: number;
  validSourceRefCount: number;
  warningSourceRefCount: number;
  warningSourceRefs: PcvN11WarningSourceRef[];
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
  n9QualityGate?: PcvN9StageProjectionEvidence;
  n9RecordRepair?: PcvN9StageProjectionEvidence;
  n11?: PcvN11ProduceEvidence;
  n12?: PcvN12ConsumerPersistenceEvidence;
}

export interface PcvNodeEvidenceEnvelope {
  contract: typeof PCV_NODE_EVIDENCE_ENVELOPE_CONTRACT;
  contractVersion: typeof PCV_NODE_EVIDENCE_ENVELOPE_CONTRACT_VERSION;
  dimensionId: string;
  evidence: BootstrapPcvNodeEvidenceSet;
  evidenceScope:
    | 'fixture'
    | 'unit'
    | 'targeted-integration'
    | 'live-ai-local'
    | 'runtime-dashboard'
    | 'delivery';
  source:
    | 'bootstrap-dimension-consumer'
    | 'bootstrap-dimension-error'
    | 'bootstrap-session-builder';
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
  const sourceRefCollection = collectSourceRefsFromProjection(projection);
  const { attributionByRef, sourceRefs } = sourceRefCollection;
  const agentSourceRefValidation = collectAgentSourceRefValidation(producerSubmitCalls);
  const sourceRefValidity = buildSourceRefValiditySummary({
    agentValidation: agentSourceRefValidation,
    attributionByRef,
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
    attributedInvalidSourceRefCount: sourceRefValidity.attributedInvalidSourceRefCount,
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
    repairedSourceRefCount: sourceRefValidity.repairedSourceRefCount,
    repairedSourceRefs: sourceRefValidity.repairedSourceRefs,
    rejectedCount,
    rejectedSourceRefCount: sourceRefValidity.rejectedSourceRefCount,
    rejectedSourceRefs: sourceRefValidity.rejectedSourceRefs,
    sourceRefReasonCounts: sourceRefValidity.reasonCounts,
    sourceRefs,
    sourceRefValidity,
    sourceRefValidityStatus: sourceRefValidity.status,
    sourceRefValidationMode: sourceRefValidity.validationMode,
    sourceRefValidationPolicy: sourceRefValidity.validationPolicy,
    status,
    submittedCount: producerSubmitCalls.length,
    summary: needsCandidates
      ? `Producer submitted ${producerSubmitCalls.length} candidate call(s): ${acceptedCount} accepted, ${rejectedCount} rejected.`
      : 'Producer node is not applicable for skill-only bootstrap dimensions.',
    terminalToolCallCount,
    totalSourceRefCount: sourceRefValidity.totalSourceRefCount,
    unattributedInvalidSourceRefCount: sourceRefValidity.unattributedInvalidSourceRefCount,
    validSourceRefCount: sourceRefValidity.validSourceRefCount,
    warningSourceRefCount: sourceRefValidity.warningSourceRefCount,
    warningSourceRefs: sourceRefValidity.warningSourceRefs,
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

// report / persisted report 不能直接依赖 raw process events；这里把已执行的 N9
// 子阶段投成稳定的 pcvScorecard evidence，避免 canonical stage identity 只停在 events。
export function buildPcvN9StageProjectionEvidence({
  dimId,
  label,
  runResult,
  stage,
}: {
  dimId: string;
  label?: string | null;
  runResult: AgentResultLike;
  stage: PcvN9StageProjectionKey;
}): PcvN9StageProjectionEvidence | null {
  const phase = resolvePcvN9ProjectionPhase(runResult, stage);
  if (!isRecord(phase)) {
    return null;
  }

  const identity = buildBootstrapPcvStageNodeMap()[stage];
  const pass = typeof phase.pass === 'boolean' ? phase.pass : null;
  const timedOut = phase.timedOut === true;
  const action =
    stringValue(phase.action) ||
    stringValue(phase.status) ||
    (pass === true ? 'pass' : pass === false ? 'fail' : null);
  const missingLinkReasons = timedOut ? [`${stage}_timed_out`] : [];

  return {
    action,
    chainNodeId: identity.chainNodeId,
    contract: PCV_COLD_START_NODE_LOCAL_CONTRACT,
    contractVersion: PCV_COLD_START_NODE_LOCAL_CONTRACT_VERSION,
    dimensionId: dimId,
    evidenceKind: 'n9-stage-projection',
    missingLinkReasons,
    nodeId: identity.pcvNodeId,
    pass,
    phasePresent: true,
    projectionSource: 'phase',
    sourceRefs: [
      'lib/workflows/capabilities/execution/internal-agent/BootstrapPcvNodeLocalEvidence.ts',
      'lib/workflows/capabilities/execution/internal-agent/BootstrapConsumers.ts',
      'node_modules/@alembic/agent/src/agent/strategies/PipelineStrategy.ts',
    ],
    stageId: stage,
    status: missingLinkReasons.length > 0 ? 'partial-evidence' : 'linked',
    summary: `${label || dimId} ${stage} stage was observed and projected to report-facing PCV scorecard evidence.`,
    timedOut,
  };
}

// record_repair 可能只是作为 PCV stage map 的可执行节点进入 input/events，
// 并不会在 quality_gate 已通过时真正形成 phase；报告面仍要保留 canonical identity。
export function buildPcvN9RecordRepairStageMapEvidence({
  dimId,
  label,
}: {
  dimId: string;
  label?: string | null;
}): PcvN9StageProjectionEvidence {
  const identity = buildBootstrapPcvStageNodeMap().record_repair;
  return {
    action: 'stage-map-available',
    chainNodeId: identity.chainNodeId,
    contract: PCV_COLD_START_NODE_LOCAL_CONTRACT,
    contractVersion: PCV_COLD_START_NODE_LOCAL_CONTRACT_VERSION,
    dimensionId: dimId,
    evidenceKind: 'n9-stage-projection',
    missingLinkReasons: [],
    nodeId: identity.pcvNodeId,
    pass: null,
    phasePresent: false,
    projectionSource: 'stage-map',
    sourceRefs: [
      'lib/workflows/capabilities/execution/internal-agent/BootstrapSessionExecutionBuilder.ts',
      'lib/workflows/capabilities/execution/internal-agent/BootstrapPcvNodeLocalEvidence.ts',
    ],
    stageId: 'record_repair',
    status: 'not-applicable',
    summary: `${label || dimId} record_repair stage identity is available in the bootstrap PCV stage map; no repair phase execution was required.`,
    timedOut: false,
  };
}

function resolvePcvN9ProjectionPhase(
  runResult: AgentResultLike,
  stage: PcvN9StageProjectionKey
): unknown {
  const phases = runResult.phases || {};
  if (stage === 'record_repair') {
    return phases.record_repair || phases.quality_gate_record_repair;
  }
  return phases[stage];
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

export function buildPcvNodeEvidenceEnvelope({
  dimId,
  evidence,
  evidenceScope = 'fixture',
  source,
}: {
  dimId: string;
  evidence: BootstrapPcvNodeEvidenceSet;
  evidenceScope?: PcvNodeEvidenceEnvelope['evidenceScope'];
  source: PcvNodeEvidenceEnvelope['source'];
}): PcvNodeEvidenceEnvelope {
  return {
    contract: PCV_NODE_EVIDENCE_ENVELOPE_CONTRACT,
    contractVersion: PCV_NODE_EVIDENCE_ENVELOPE_CONTRACT_VERSION,
    dimensionId: dimId,
    evidence,
    evidenceScope,
    source,
  };
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

interface SourceRefCollection {
  attributionByRef: Map<string, PcvN11SourceRefAttribution[]>;
  sourceRefs: string[];
}

interface SourceRefOccurrence {
  fieldPath: string;
  ref: string;
}

interface ToolCallAttributionContext {
  action: string | null;
  candidateId: string | null;
  candidateTitle: string | null;
  status: string | null;
  tool: string;
  toolCallIndex: number;
}

function collectSourceRefsFromProjection(
  projection: BootstrapDimensionProjection
): SourceRefCollection {
  const refs = new Set<string>();
  const attributionByRef = new Map<string, PcvN11SourceRefAttribution[]>();
  for (const ref of projection.analysisReport?.referencedFiles || []) {
    refs.add(ref);
  }
  for (const [toolCallIndex, call] of resolveProducerToolCalls(projection).entries()) {
    const context = buildToolCallAttributionContext(call, toolCallIndex);
    for (const root of [
      { fieldPath: 'args', value: call.args },
      { fieldPath: 'params', value: call.params },
      { fieldPath: 'result', value: call.result },
    ]) {
      for (const occurrence of sourceRefOccurrencesFromValue(root.value, root.fieldPath)) {
        refs.add(occurrence.ref);
        addSourceRefAttribution(attributionByRef, occurrence, context);
      }
    }
  }
  const sourceRefs = [...refs].slice(0, 50);
  const includedRefs = new Set(sourceRefs);
  for (const ref of [...attributionByRef.keys()]) {
    if (!includedRefs.has(ref)) {
      attributionByRef.delete(ref);
    }
  }
  return { attributionByRef, sourceRefs };
}

function sourceRefOccurrencesFromValue(
  value: unknown,
  fieldPath: string,
  depth = 0
): SourceRefOccurrence[] {
  if (depth > 5) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      sourceRefOccurrencesFromValue(item, `${fieldPath}[${index}]`, depth + 1)
    );
  }
  if (!isRecord(value)) {
    if (typeof value !== 'string') {
      return [];
    }
    if (looksLikeSourceRef(value)) {
      return [{ fieldPath, ref: value }];
    }
    if (shouldExtractEmbeddedSourceRefs(fieldPath)) {
      return extractEmbeddedSourceRefs(value).map((ref) => ({ fieldPath, ref }));
    }
    return [];
  }
  const occurrences: SourceRefOccurrence[] = [];
  for (const key of ['sourceRefs', 'referencedFiles', 'filePaths']) {
    const entry = value[key];
    if (Array.isArray(entry)) {
      occurrences.push(
        ...entry.flatMap((item, index) =>
          typeof item === 'string'
            ? [{ fieldPath: `${fieldPath}.${key}[${index}]`, ref: item }]
            : []
        )
      );
    }
  }
  for (const key of ['sourceRef', 'referencedFile', 'filePath']) {
    const entry = value[key];
    if (typeof entry === 'string') {
      occurrences.push({ fieldPath: `${fieldPath}.${key}`, ref: entry });
    }
  }
  const nestedParams = value.params;
  if (isRecord(nestedParams)) {
    occurrences.push(
      ...sourceRefOccurrencesFromValue(nestedParams, `${fieldPath}.params`, depth + 1)
    );
  }
  const sourceRefValidation = value.sourceRefValidation;
  if (isRecord(sourceRefValidation)) {
    occurrences.push(
      ...sourceRefOccurrencesFromAgentValidationRecord(
        sourceRefValidation,
        `${fieldPath}.sourceRefValidation`
      )
    );
  }
  for (const key of [
    'data',
    'item',
    'items',
    'candidate',
    'candidates',
    'result',
    'content',
    'reasoning',
  ]) {
    occurrences.push(
      ...sourceRefOccurrencesFromValue(value[key], `${fieldPath}.${key}`, depth + 1)
    );
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && shouldExtractEmbeddedSourceRefs(`${fieldPath}.${key}`)) {
      occurrences.push(
        ...extractEmbeddedSourceRefs(entry).map((ref) => ({
          fieldPath: `${fieldPath}.${key}`,
          ref,
        }))
      );
    }
  }
  return occurrences.filter((occurrence) => looksLikeSourceRef(occurrence.ref));
}

function sourceRefOccurrencesFromAgentValidationRecord(
  validation: Record<string, unknown>,
  fieldPath: string
): SourceRefOccurrence[] {
  const occurrences: SourceRefOccurrence[] = [];
  for (const repair of recordArray(validation.repairedSourceRefs)) {
    for (const key of ['from', 'to', 'ref', 'sourceRef', 'normalizedRef', 'normalizedPath']) {
      const value = repair[key];
      if (typeof value === 'string') {
        occurrences.push({ fieldPath: `${fieldPath}.repairedSourceRefs.${key}`, ref: value });
      }
    }
  }
  for (const key of ['rejectedSourceRefs', 'invalidSourceRefs', 'warnings']) {
    for (const [index, invalid] of recordArray(validation[key]).entries()) {
      for (const sourceKey of [
        'ref',
        'sourceRef',
        'from',
        'normalizedPath',
        'suggestedRef',
        'to',
      ]) {
        const value = invalid[sourceKey];
        if (typeof value === 'string') {
          occurrences.push({
            fieldPath: `${fieldPath}.${key}[${index}].${sourceKey}`,
            ref: value,
          });
        }
      }
    }
  }
  return occurrences.filter((occurrence) => looksLikeSourceRef(occurrence.ref));
}

function buildToolCallAttributionContext(
  call: ToolCallRecord,
  toolCallIndex: number
): ToolCallAttributionContext {
  return {
    action: actionName(call),
    candidateId: candidateId(call),
    candidateTitle: candidateTitle(call),
    status: resultStatus(call),
    tool: toolName(call),
    toolCallIndex,
  };
}

function addSourceRefAttribution(
  attributionByRef: Map<string, PcvN11SourceRefAttribution[]>,
  occurrence: SourceRefOccurrence,
  context: ToolCallAttributionContext
): void {
  const attributions = attributionByRef.get(occurrence.ref) || [];
  const attribution: PcvN11SourceRefAttribution = {
    action: context.action,
    candidateId: context.candidateId,
    candidateTitle: context.candidateTitle,
    contentField: contentFieldFromPath(occurrence.fieldPath),
    fieldPath: occurrence.fieldPath,
    status: context.status,
    tool: context.tool,
    toolCallIndex: context.toolCallIndex,
  };
  if (
    attributions.some(
      (entry) =>
        entry.fieldPath === attribution.fieldPath &&
        entry.toolCallIndex === attribution.toolCallIndex
    )
  ) {
    return;
  }
  attributionByRef.set(occurrence.ref, [...attributions, attribution]);
}

function shouldExtractEmbeddedSourceRefs(fieldPath: string): boolean {
  const normalized = fieldPath.toLowerCase();
  return (
    normalized.includes('.content') ||
    normalized.endsWith('.markdown') ||
    normalized.endsWith('.summary') ||
    normalized.endsWith('.description') ||
    normalized.includes('.reasoning') ||
    normalized.includes('.sources') ||
    normalized.includes('.evidence')
  );
}

function extractEmbeddedSourceRefs(value: string): string[] {
  const refs = new Set<string>();
  for (const match of value.matchAll(/`([^`\s]+\.[\w]+(?::\d+)?(?::\d+)?)`/g)) {
    refs.add(match[1]);
  }
  for (const match of value.matchAll(
    /\b(?:file:\/\/)?[\w/.-]+\.[A-Za-z0-9]+(?::\d+)?(?::\d+)?\b/g
  )) {
    refs.add(match[0]);
  }
  return [...refs].filter(looksLikeSourceRef);
}

function contentFieldFromPath(fieldPath: string): string {
  return fieldPath.replace(/^(args|params|result)(\.params)?\./, '').replace(/\[\d+\]/g, '[]');
}

function looksLikeSourceRef(value: string): boolean {
  return /^(?:file:\/\/)?[\w/.-]+\.[\w]+(?::\d+)?(?::\d+)?$/.test(value.trim());
}

interface AgentSourceRefValidationCarry {
  reasonCounts: Record<PcvN11SourceRefReason, number>;
  repairedSourceRefs: PcvN11RepairedSourceRef[];
  rejectedSourceRefs: PcvN11RejectedSourceRef[];
  validationMode: string | null;
  validationPolicy: Record<string, unknown> | null;
  warningSourceRefs: PcvN11WarningSourceRef[];
}

function collectAgentSourceRefValidation(
  producerSubmitCalls: ToolCallRecord[]
): AgentSourceRefValidationCarry {
  const reasonCounts = emptySourceRefReasonCounts();
  const modes = new Set<string>();
  let validationPolicy: Record<string, unknown> | null = null;
  const repaired = new Map<string, PcvN11RepairedSourceRef>();
  const rejected = new Map<string, PcvN11RejectedSourceRef>();
  const warnings = new Map<string, PcvN11WarningSourceRef>();

  for (const call of producerSubmitCalls) {
    for (const validation of sourceRefValidationRecordsFromToolCall(call)) {
      const mode = stringValue(validation.mode);
      if (mode) {
        modes.add(mode);
      }
      if (!validationPolicy && isRecord(validation.policy)) {
        validationPolicy = { ...validation.policy };
      }
      for (const entry of recordArray(validation.repairedSourceRefs)) {
        const repair = normalizeAgentRepairedSourceRef(entry);
        if (!repair) {
          continue;
        }
        const key = `${repair.from}\u0000${repair.to}\u0000${repair.reason}`;
        if (!repaired.has(key)) {
          repaired.set(key, repair);
          incrementSourceRefReasonCount(reasonCounts, repair.reason);
        }
      }
      for (const entry of recordArray(validation.rejectedSourceRefs)) {
        const invalid = normalizeAgentRejectedSourceRef(entry);
        if (!invalid) {
          continue;
        }
        const key = `${invalid.ref}\u0000${invalid.reason}`;
        if (!rejected.has(key)) {
          rejected.set(key, invalid);
          incrementSourceRefReasonCount(reasonCounts, invalid.reason);
        }
      }
      for (const entry of recordArray(validation.invalidSourceRefs)) {
        const warning = normalizeAgentWarningSourceRef(entry);
        if (!warning) {
          continue;
        }
        const key = `${warning.ref}\u0000${warning.reason}`;
        if (!warnings.has(key)) {
          warnings.set(key, warning);
          incrementSourceRefReasonCount(reasonCounts, warning.reason);
        }
      }
      for (const entry of recordArray(validation.warnings)) {
        const warning = normalizeAgentWarningSourceRef(entry);
        if (!warning) {
          continue;
        }
        const key = `${warning.ref}\u0000${warning.reason}`;
        if (!warnings.has(key)) {
          warnings.set(key, warning);
          incrementSourceRefReasonCount(reasonCounts, warning.reason);
        }
      }
    }
  }

  return {
    reasonCounts,
    repairedSourceRefs: [...repaired.values()],
    rejectedSourceRefs: [...rejected.values()],
    validationMode: [...modes].sort().join('+') || null,
    validationPolicy,
    warningSourceRefs: [...warnings.values()],
  };
}

function sourceRefValidationRecordsFromToolCall(call: ToolCallRecord): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const value of [call.result, call.args, call.params]) {
    records.push(...findSourceRefValidationRecords(value));
  }
  return records;
}

function findSourceRefValidationRecords(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 5 || value == null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => findSourceRefValidationRecords(entry, depth + 1));
  }
  if (!isRecord(value)) {
    return [];
  }
  const records: Record<string, unknown>[] = [];
  if (isRecord(value.sourceRefValidation)) {
    records.push(value.sourceRefValidation);
  }
  for (const key of ['data', 'item', 'items', 'candidate', 'candidates', 'result', 'params']) {
    records.push(...findSourceRefValidationRecords(value[key], depth + 1));
  }
  return records;
}

function normalizeAgentRepairedSourceRef(
  entry: Record<string, unknown>
): PcvN11RepairedSourceRef | null {
  const from = stringValue(entry.from) || stringValue(entry.ref) || stringValue(entry.sourceRef);
  const to =
    stringValue(entry.to) ||
    stringValue(entry.normalizedRef) ||
    stringValue(entry.normalizedPath) ||
    stringValue(entry.path);
  if (!from || !to || from === to) {
    return null;
  }
  const rawReason = stringValue(entry.reason);
  return {
    from,
    rawReason,
    reason: normalizeSourceRefRepairReason(rawReason),
    source: 'agent',
    to,
  };
}

function normalizeAgentRejectedSourceRef(
  entry: Record<string, unknown>
): PcvN11RejectedSourceRef | null {
  const ref = stringValue(entry.ref) || stringValue(entry.sourceRef) || stringValue(entry.from);
  if (!ref) {
    return null;
  }
  const rawReason = stringValue(entry.reason);
  return {
    candidates: stringArray(entry.candidates),
    normalizedPath: stringValue(entry.normalizedPath),
    rawReason,
    reason: normalizeSourceRefReason(rawReason, 'file-not-found'),
    ref,
    source: 'agent',
    suggestedRef: stringValue(entry.suggestedRef) || stringValue(entry.to),
  };
}

function normalizeAgentWarningSourceRef(
  entry: Record<string, unknown>
): PcvN11WarningSourceRef | null {
  const ref = stringValue(entry.ref) || stringValue(entry.sourceRef) || stringValue(entry.from);
  if (!ref) {
    return null;
  }
  const rawReason = stringValue(entry.reason) || stringValue(entry.message);
  return {
    candidates: stringArray(entry.candidates),
    normalizedPath: stringValue(entry.normalizedPath),
    rawReason,
    reason: normalizeSourceRefReason(rawReason, 'file-not-found'),
    ref,
    source: 'agent',
    suggestedRef: stringValue(entry.suggestedRef) || stringValue(entry.to),
  };
}

function normalizeSourceRefRepairReason(
  reason: string | null
): Extract<PcvN11SourceRefReason, 'missing-prefix' | 'wrong-extension'> {
  return normalizeSourceRefReason(reason, 'missing-prefix') === 'wrong-extension'
    ? 'wrong-extension'
    : 'missing-prefix';
}

function normalizeSourceRefReason(
  reason: string | null | undefined,
  fallback: PcvN11SourceRefReason
): PcvN11SourceRefReason {
  const normalized = (reason || '').trim().toLowerCase();
  if (isPcvN11SourceRefReason(normalized)) {
    return normalized;
  }
  if (normalized.includes('wrong-extension') || normalized.includes('extension')) {
    return 'wrong-extension';
  }
  if (
    normalized.includes('missing-prefix') ||
    normalized.includes('unique-basename') ||
    normalized.includes('basename-match')
  ) {
    return 'missing-prefix';
  }
  if (normalized.includes('package-path') || normalized.includes('path-mismatch')) {
    return 'package-path-mismatch';
  }
  if (normalized.includes('entity')) {
    return 'entity-not-file';
  }
  if (normalized.includes('ambiguous')) {
    return 'ambiguous-basename';
  }
  if (normalized.includes('outside')) {
    return 'outside-project-root';
  }
  return fallback;
}

function isPcvN11SourceRefReason(value: string): value is PcvN11SourceRefReason {
  return (
    value === 'ambiguous-basename' ||
    value === 'entity-not-file' ||
    value === 'file-not-found' ||
    value === 'missing-prefix' ||
    value === 'outside-project-root' ||
    value === 'package-path-mismatch' ||
    value === 'wrong-extension'
  );
}

function emptySourceRefReasonCounts(): Record<PcvN11SourceRefReason, number> {
  return {
    'ambiguous-basename': 0,
    'entity-not-file': 0,
    'file-not-found': 0,
    'missing-prefix': 0,
    'outside-project-root': 0,
    'package-path-mismatch': 0,
    'wrong-extension': 0,
  };
}

function incrementSourceRefReasonCount(
  counts: Record<PcvN11SourceRefReason, number>,
  reason: PcvN11SourceRefReason
): void {
  counts[reason] += 1;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

function buildSourceRefValiditySummary({
  agentValidation,
  attributionByRef,
  needsCandidates,
  sourceRefs,
  validation,
}: {
  agentValidation?: AgentSourceRefValidationCarry;
  attributionByRef?: Map<string, PcvN11SourceRefAttribution[]>;
  needsCandidates: boolean;
  sourceRefs: string[];
  validation?: PcvSourceRefValidationContext | null;
}): PcvN11SourceRefValiditySummary {
  const mergedSourceRefs = mergeSourceRefsWithAgentValidation(sourceRefs, agentValidation);
  if (!needsCandidates) {
    return sourceRefValiditySummary({
      agentValidation,
      checked: false,
      invalidRefs: [],
      sourceRefs: mergedSourceRefs,
      status: 'not-applicable',
      uncheckedReason: 'dimension_does_not_need_candidates',
      validCount: 0,
    });
  }
  if (mergedSourceRefs.length === 0) {
    return sourceRefValiditySummary({
      agentValidation,
      checked: true,
      invalidRefs: [],
      sourceRefs: mergedSourceRefs,
      status: 'empty',
      uncheckedReason: null,
      validCount: 0,
    });
  }

  const agentInvalidRefs = dedupeInvalidSourceRefs([
    ...(agentValidation?.rejectedSourceRefs || []),
    ...(agentValidation?.warningSourceRefs || []),
  ]).map((invalid) => attachSourceRefAttributions(invalid, attributionByRef));
  const index = buildSourceRefValidationIndex(validation);
  if (!index) {
    if (agentValidation?.validationMode || agentInvalidRefs.length > 0) {
      return sourceRefValiditySummary({
        agentValidation,
        checked: true,
        invalidRefs: agentInvalidRefs,
        sourceRefs: mergedSourceRefs,
        status: agentInvalidRefs.length > 0 ? 'invalid' : 'valid',
        uncheckedReason: null,
        validCount: countValidSourceRefs(mergedSourceRefs, agentInvalidRefs),
        maxInvalidRefs: validation?.maxInvalidSourceRefs,
      });
    }
    return sourceRefValiditySummary({
      agentValidation,
      checked: false,
      invalidRefs: [],
      sourceRefs: mergedSourceRefs,
      status: 'not-checked',
      uncheckedReason: 'project_file_index_unavailable',
      validCount: 0,
    });
  }

  const repairedRefs = new Set(
    (agentValidation?.repairedSourceRefs || []).map((entry) => entry.from)
  );
  const invalidRefs: PcvN11InvalidSourceRef[] = [];
  for (const ref of mergedSourceRefs) {
    if (repairedRefs.has(ref)) {
      continue;
    }
    const result = validateSourceRef(ref, index);
    if (!result.valid) {
      invalidRefs.push({
        ...sourceRefAttributionFields(ref, attributionByRef),
        candidates: result.candidates,
        normalizedPath: result.normalizedPath,
        rawReason: result.rawReason,
        reason: result.reason,
        ref,
        source: 'report-fallback',
        suggestedRef: result.suggestedRef,
      });
    }
  }
  const mergedInvalidRefs = dedupeInvalidSourceRefs([...agentInvalidRefs, ...invalidRefs]);

  return sourceRefValiditySummary({
    agentValidation,
    checked: true,
    invalidRefs: mergedInvalidRefs,
    sourceRefs: mergedSourceRefs,
    status: mergedInvalidRefs.length > 0 ? 'invalid' : 'valid',
    uncheckedReason: null,
    validCount: countValidSourceRefs(mergedSourceRefs, mergedInvalidRefs),
    maxInvalidRefs: validation?.maxInvalidSourceRefs,
  });
}

function sourceRefValiditySummary({
  agentValidation,
  checked,
  invalidRefs,
  maxInvalidRefs,
  sourceRefs,
  status,
  uncheckedReason,
  validCount,
}: {
  agentValidation?: AgentSourceRefValidationCarry;
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
  const attributedInvalidSourceRefCount = invalidRefs.filter(
    (invalid) => (invalid.attributions || []).length > 0
  ).length;
  const invalidSourceRefRatio = total > 0 ? Number((invalidCount / total).toFixed(4)) : 0;
  const reasonCounts = mergeSourceRefReasonCounts(agentValidation, invalidRefs);
  const limit =
    typeof maxInvalidRefs === 'number' && Number.isFinite(maxInvalidRefs)
      ? Math.max(0, Math.floor(maxInvalidRefs))
      : MAX_INVALID_SOURCE_REFS;
  return {
    attributedInvalidSourceRefCount,
    checked,
    invalidSourceRefCount: invalidCount,
    invalidSourceRefRatio,
    invalidSourceRefs: invalidRefs.slice(0, limit),
    reasonCounts,
    repairedSourceRefCount: agentValidation?.repairedSourceRefs.length || 0,
    repairedSourceRefs: agentValidation?.repairedSourceRefs || [],
    rejectedSourceRefCount: agentValidation?.rejectedSourceRefs.length || 0,
    rejectedSourceRefs: agentValidation?.rejectedSourceRefs || [],
    status,
    totalSourceRefCount: total,
    unattributedInvalidSourceRefCount: Math.max(0, invalidCount - attributedInvalidSourceRefCount),
    uncheckedReason,
    validSourceRefCount: validCount,
    validationMode: agentValidation?.validationMode || (checked ? 'report-fallback' : null),
    validationPolicy: agentValidation?.validationPolicy || null,
    warningSourceRefCount: agentValidation?.warningSourceRefs.length || 0,
    warningSourceRefs: agentValidation?.warningSourceRefs || [],
  };
}

function mergeSourceRefsWithAgentValidation(
  sourceRefs: string[],
  agentValidation?: AgentSourceRefValidationCarry
): string[] {
  const refs = new Set(sourceRefs);
  for (const repair of agentValidation?.repairedSourceRefs || []) {
    refs.add(repair.from);
  }
  for (const invalid of [
    ...(agentValidation?.rejectedSourceRefs || []),
    ...(agentValidation?.warningSourceRefs || []),
  ]) {
    refs.add(invalid.ref);
  }
  return [...refs];
}

function dedupeInvalidSourceRefs(invalidRefs: PcvN11InvalidSourceRef[]): PcvN11InvalidSourceRef[] {
  const refs = new Map<string, PcvN11InvalidSourceRef>();
  for (const invalid of invalidRefs) {
    const key = `${invalid.ref}\u0000${invalid.reason}`;
    const existing = refs.get(key);
    if (!existing || existing.source !== 'agent') {
      refs.set(key, invalid);
      continue;
    }
    if ((invalid.attributions || []).length > 0 && (existing.attributions || []).length === 0) {
      refs.set(key, {
        ...existing,
        ...sourceRefAttributionFields(
          invalid.ref,
          new Map([[invalid.ref, invalid.attributions || []]])
        ),
      });
    }
  }
  return [...refs.values()];
}

function attachSourceRefAttributions(
  invalid: PcvN11InvalidSourceRef,
  attributionByRef?: Map<string, PcvN11SourceRefAttribution[]>
): PcvN11InvalidSourceRef {
  return {
    ...invalid,
    ...sourceRefAttributionFields(invalid.ref, attributionByRef),
  };
}

function sourceRefAttributionFields(
  ref: string,
  attributionByRef?: Map<string, PcvN11SourceRefAttribution[]>
): Pick<
  PcvN11InvalidSourceRef,
  'attributions' | 'candidateId' | 'candidateTitle' | 'contentField' | 'fieldPath' | 'toolCallIndex'
> {
  const attributions = attributionByRef?.get(ref) || [];
  const primary = attributions[0] || null;
  return {
    attributions,
    candidateId: primary?.candidateId ?? null,
    candidateTitle: primary?.candidateTitle ?? null,
    contentField: primary?.contentField ?? null,
    fieldPath: primary?.fieldPath ?? null,
    toolCallIndex: primary?.toolCallIndex ?? null,
  };
}

function countValidSourceRefs(sourceRefs: string[], invalidRefs: PcvN11InvalidSourceRef[]): number {
  const invalidRefNames = new Set(invalidRefs.map((entry) => entry.ref));
  return Math.max(0, sourceRefs.filter((ref) => !invalidRefNames.has(ref)).length);
}

function mergeSourceRefReasonCounts(
  agentValidation: AgentSourceRefValidationCarry | undefined,
  invalidRefs: PcvN11InvalidSourceRef[]
): Record<PcvN11SourceRefReason, number> {
  const counts = { ...(agentValidation?.reasonCounts || emptySourceRefReasonCounts()) };
  for (const invalid of invalidRefs) {
    if (invalid.source === 'agent') {
      continue;
    }
    incrementSourceRefReasonCount(counts, invalid.reason);
  }
  return counts;
}

interface SourceRefValidationIndex {
  byBasename: Map<string, string[]>;
  byStem: Map<string, string[]>;
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
    byBasename: buildSourceRefBasenameIndex(fileSet),
    byStem: buildSourceRefStemIndex(fileSet),
    fileExists: validation?.fileExists || existsSync,
    fileSet,
    projectRoot,
    projectRootName: projectRoot ? path.basename(projectRoot) : null,
  };
}

function buildSourceRefBasenameIndex(fileSet: Set<string>): Map<string, string[]> {
  const byBasename = new Map<string, string[]>();
  for (const file of fileSet) {
    const basename = path.posix.basename(file);
    byBasename.set(basename, [...(byBasename.get(basename) || []), file]);
  }
  return byBasename;
}

function buildSourceRefStemIndex(fileSet: Set<string>): Map<string, string[]> {
  const byStem = new Map<string, string[]>();
  for (const file of fileSet) {
    const parsed = path.posix.parse(file);
    const key = `${path.posix.dirname(file)}/${parsed.name}`;
    byStem.set(key, [...(byStem.get(key) || []), file]);
    byStem.set(parsed.name, [...(byStem.get(parsed.name) || []), file]);
  }
  return byStem;
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
  | {
      candidates?: string[];
      normalizedPath: string | null;
      rawReason?: string | null;
      reason: PcvN11InvalidSourceRefReason;
      suggestedRef?: string | null;
      valid: false;
    } {
  const resolution = resolveSourceRefCandidates(ref, index);
  if (!resolution || resolution.outsideProjectRoot) {
    return {
      candidates: [],
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
  return classifyInvalidSourceRef(resolution.normalizedPath, index);
}

function classifyInvalidSourceRef(
  normalizedPath: string,
  index: SourceRefValidationIndex
): {
  candidates?: string[];
  normalizedPath: string;
  rawReason?: string | null;
  reason: PcvN11InvalidSourceRefReason;
  suggestedRef?: string | null;
  valid: false;
} {
  const basename = path.posix.basename(normalizedPath);
  const parsed = path.posix.parse(normalizedPath);
  const dirname = path.posix.dirname(normalizedPath);
  const directoryStemMatches = uniqueStrings(index.byStem.get(`${dirname}/${parsed.name}`) || []);
  if (directoryStemMatches.length === 1 && directoryStemMatches[0] !== normalizedPath) {
    return {
      candidates: directoryStemMatches,
      normalizedPath,
      reason: 'wrong-extension',
      suggestedRef: directoryStemMatches[0],
      valid: false,
    };
  }
  if (directoryStemMatches.length > 1) {
    return {
      candidates: directoryStemMatches,
      normalizedPath,
      reason: 'ambiguous-basename',
      valid: false,
    };
  }

  const basenameMatches = uniqueStrings(index.byBasename.get(basename) || []);
  if (basenameMatches.length === 1) {
    return {
      candidates: basenameMatches,
      normalizedPath,
      reason: normalizedPath.includes('/') ? 'package-path-mismatch' : 'missing-prefix',
      suggestedRef: basenameMatches[0],
      valid: false,
    };
  }
  if (basenameMatches.length > 1) {
    return {
      candidates: basenameMatches,
      normalizedPath,
      reason: 'ambiguous-basename',
      valid: false,
    };
  }

  const stemMatches = uniqueStrings(index.byStem.get(parsed.name) || []);
  if (stemMatches.length === 1) {
    return {
      candidates: stemMatches,
      normalizedPath,
      reason: 'wrong-extension',
      suggestedRef: stemMatches[0],
      valid: false,
    };
  }
  if (stemMatches.length > 1) {
    return {
      candidates: stemMatches,
      normalizedPath,
      reason: 'ambiguous-basename',
      valid: false,
    };
  }

  if (!normalizedPath.includes('/') && parsed.ext) {
    return {
      candidates: [],
      normalizedPath,
      reason: 'entity-not-file',
      valid: false,
    };
  }

  return {
    candidates: [],
    normalizedPath,
    reason: 'file-not-found',
    valid: false,
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
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

function candidateId(call: ToolCallRecord): string | null {
  const args = call.args || call.params || {};
  const nested = isRecord(args.params) ? args.params : args;
  const result = isRecord(call.result) ? call.result : {};
  return (
    stringValue(nested.id) ||
    stringValue(nested.candidateId) ||
    stringValue(nested.client_id) ||
    stringValue(nested.clientId) ||
    stringValue(result.id) ||
    stringValue(result.candidateId) ||
    stringValue(result.client_id) ||
    stringValue(result.clientId)
  );
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
