import type { AgentRunInput } from '@alembic/agent/service';
import {
  AgentProfileCompiler,
  AgentProfileRegistry,
  AgentStageFactoryRegistry,
} from '@alembic/agent/service';
import {
  buildGenerateTerminalPolicyHints,
  getGenerateStageTerminalTools,
  resolveGenerateTerminalToolset,
} from '@alembic/core/host-agent-workflows';
import type {
  AgentResultLike,
  GenerateDimensionProjection,
  ToolCallRecord,
} from './AgentRunProjections.js';
import type { GenerateDimensionPlan } from './DimensionRuntimeBuilder.js';

export const PCV_COLD_START_NODE_LOCAL_CONTRACT = 'PCVColdStartNodeLocalBaseline';
export const PCV_COLD_START_NODE_LOCAL_CONTRACT_VERSION = 1;
export const PCV_NODE_EVIDENCE_ENVELOPE_CONTRACT = 'PcvNodeEvidenceEnvelope';
export const PCV_NODE_EVIDENCE_ENVELOPE_CONTRACT_VERSION = 1;
export const PCV_N8_NODE_ID = 'N8-stage-factory-tool-policy';
export const PCV_ANALYZE_GROUNDING_NODE_ID = 'analyze-evidence-grounding-ledger';
export const PCV_N12_NODE_ID = 'N12-consumers-persistence';
export const PCV_GENERATE_STAGE_NODE_MAP_CONTRACT = 'PCVBootstrapStageNodeMap';
export const PCV_GENERATE_STAGE_NODE_MAP_CONTRACT_VERSION = 1;

export type PcvGenerateStageKey = 'analyze' | 'quality_gate' | 'record_repair';

export interface PcvGenerateStageNodeIdentity {
  pcvNodeId: string;
  chainNodeId: string;
}

export type PcvGenerateStageNodeMap = Record<PcvGenerateStageKey, PcvGenerateStageNodeIdentity>;

export interface PcvGenerateStageNodeContext {
  contract: typeof PCV_GENERATE_STAGE_NODE_MAP_CONTRACT;
  contractVersion: typeof PCV_GENERATE_STAGE_NODE_MAP_CONTRACT_VERSION;
  pcvStageNodeMap: PcvGenerateStageNodeMap;
  pcvChainNodes: PcvGenerateStageNodeMap;
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
  status: PcvNodeLocalStatus;
  summary: string;
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
  terminalCapabilityHints: ReturnType<typeof buildGenerateTerminalPolicyHints>;
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
  // AP-6：本 summary 被解读时所处的 grounding enforcement 模式（审计语义）。仅当上游 AP-4 additive 标记
  // 可读时出现：'off'=observe-only（invalid-no-evidence 记为审计材料、不算 linkage 回归，R6），
  // 'guard'=enforcement 生效（保持原质量判定）。标记缺失（旧/异源数据）时字段省略、按原判定处理。
  groundingEnforcement?: 'off' | 'guard';
  invalidNoEvidenceCount: number;
  planningOnlyCount: number;
  recordOnlyCount: number;
  summaryOnlyCount: number;
  toolSchemasVisibleCount: number;
  verificationOnlyCount: number;
}

export type PcvN9StageProjectionKey = Extract<
  PcvGenerateStageKey,
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

export interface PcvN12ConsumerPersistenceEvidence extends PcvNodeLocalEvidenceBase {
  acceptedCandidateTitles: string[];
  evidenceKind: 'consumer-persistence';
  failureDetailsPersisted: boolean;
  findableCandidateTitles: string[];
  persistedFailureReason: string | null;
  sessionStoreSnapshotAvailable: boolean;
}

export interface GeneratePcvNodeEvidenceSet {
  n8?: PcvN8StageFactoryEvidence;
  groundingLedger?: PcvAnalyzeGroundingLedgerSummary;
  n9QualityGate?: PcvN9StageProjectionEvidence;
  n9RecordRepair?: PcvN9StageProjectionEvidence;
  n12?: PcvN12ConsumerPersistenceEvidence;
}

export interface PcvNodeEvidenceEnvelope {
  contract: typeof PCV_NODE_EVIDENCE_ENVELOPE_CONTRACT;
  contractVersion: typeof PCV_NODE_EVIDENCE_ENVELOPE_CONTRACT_VERSION;
  dimensionId: string;
  evidence: GeneratePcvNodeEvidenceSet;
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

const BOOTSTRAP_STAGE_NODE_MAP: PcvGenerateStageNodeMap = {
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
};

const TERMINAL_TOOL_IDS = new Set(['terminal']);

export function buildGeneratePcvStageNodeMap(): PcvGenerateStageNodeMap {
  return cloneBootstrapStageNodeMap(BOOTSTRAP_STAGE_NODE_MAP);
}

export function buildGeneratePcvStageNodeContext(): PcvGenerateStageNodeContext {
  const pcvStageNodeMap = buildGeneratePcvStageNodeMap();
  return {
    contract: PCV_GENERATE_STAGE_NODE_MAP_CONTRACT,
    contractVersion: PCV_GENERATE_STAGE_NODE_MAP_CONTRACT_VERSION,
    pcvStageNodeMap,
    pcvChainNodes: cloneBootstrapStageNodeMap(pcvStageNodeMap),
  };
}

function cloneBootstrapStageNodeMap(map: PcvGenerateStageNodeMap): PcvGenerateStageNodeMap {
  return {
    analyze: { ...map.analyze },
    quality_gate: { ...map.quality_gate },
    record_repair: { ...map.record_repair },
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
  plan: GenerateDimensionPlan;
  runInput: AgentRunInput;
}): PcvN8StageFactoryEvidence {
  const terminalCapability = resolveGenerateTerminalToolset();
  const terminalCapabilityHints = buildGenerateTerminalPolicyHints(terminalCapability);
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
    stageOrder,
    stageToolPolicies,
    status,
    summary: `${label || dimId} bootstrap stage factory resolved ${stageOrder.length} stage(s); producer terminal tools are ${terminalToolIds.length === 0 ? 'blocked' : 'allowed'}.`,
    terminalCapabilityHints,
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

  const analyzeNodeIdentity = buildGeneratePcvStageNodeMap().analyze;
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

  // AP-6：据上游 AP-4 标记把 grounding ledger 解读为审计语义（R6）。observe-only（'off'）下增多的
  // invalid-no-evidence 是 PCV 纯观察的预期产物——记为审计材料、不推 missingLink、不降级 status 误判回归；
  // 'guard' 或标记缺失时保持原质量判定（invalid-no-evidence 仍是真实信号）。计数本身始终保留作审计材料。
  const groundingEnforcement = collectPcvAnalyzeGroundingEnforcement(runResult);
  const groundingObserveOnly = groundingEnforcement === 'off';

  if (invalidNoEvidenceCount > 0 && !groundingObserveOnly) {
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
    ...(groundingEnforcement ? { groundingEnforcement } : {}),
    invalidNoEvidenceCount,
    missingLinkReasons,
    nodeId: analyzeNodeIdentity.pcvNodeId,
    planningOnlyCount,
    recordOnlyCount,
    status:
      missingLinkReasons.length > 0
        ? 'partial-evidence'
        : evidenceThroughCount > 0
          ? 'linked'
          : 'not-applicable',
    summary:
      `${label || dimId} analyze grounding ledger recorded ${entries.length} burn(s): ${evidenceProducedCount} produced evidence, ${deterministicEvidenceConsumedCount} consumed deterministic evidence, ${invalidNoEvidenceCount} lacked evidence.` +
      (groundingObserveOnly && invalidNoEvidenceCount > 0
        ? ' Observe-only grounding enforcement: invalid-no-evidence recorded as audit material, not a linkage regression.'
        : ''),
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

  const identity = buildGeneratePcvStageNodeMap()[stage];
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
  const identity = buildGeneratePcvStageNodeMap().record_repair;
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

export function mergeGeneratePcvNodeEvidence(
  existing: unknown,
  next: GeneratePcvNodeEvidenceSet
): GeneratePcvNodeEvidenceSet {
  return {
    ...(isRecord(existing) ? existing : {}),
    ...next,
  } as GeneratePcvNodeEvidenceSet;
}

export function buildPcvNodeEvidenceEnvelope({
  dimId,
  evidence,
  evidenceScope = 'fixture',
  source,
}: {
  dimId: string;
  evidence: GeneratePcvNodeEvidenceSet;
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
  projection: GenerateDimensionProjection
): ToolCallRecord[] {
  if (Array.isArray(projection.produceResult?.toolCalls)) {
    return projection.produceResult.toolCalls;
  }
  return projection.runtimeToolCalls || [];
}

export function successfulProducerSubmitCalls(
  projection: GenerateDimensionProjection
): ToolCallRecord[] {
  return resolveProducerToolCalls(projection).filter(
    (call) => isKnowledgeSubmitToolCall(call) && isSuccessfulToolCall(call)
  );
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

// AP-6：从同一组 candidate（runResult + phases）的 pcvNodeEvidence 读取上游 AP-4 additive 标记
// groundingEnforcement（'off'=observe-only / 'guard'=AnalyzeGroundingGuard 生效），与 ledger entries 同源
// 遍历，取首个携带该标记的 candidate。标记缺失（旧/异源数据）返回 undefined，调用方据此回落到原质量判定，
// 保持纯 additive（老数据/老路径行为不变）。纯观察，不驱动控流。
function collectPcvAnalyzeGroundingEnforcement(
  runResult: AgentResultLike
): 'off' | 'guard' | undefined {
  const candidates: unknown[] = [runResult];
  const phases = runResult.phases || {};
  const qualityGate = phases.quality_gate;
  candidates.push(phases.analyze);
  if (isRecord(qualityGate)) {
    candidates.push(qualityGate.artifact);
  }
  for (const phase of Object.values(phases)) {
    candidates.push(phase);
  }
  for (const candidate of candidates) {
    const pcvNodeEvidence = isRecord(candidate) ? candidate.pcvNodeEvidence : null;
    const enforcement = isRecord(pcvNodeEvidence)
      ? pcvNodeEvidence.groundingEnforcement
      : undefined;
    if (enforcement === 'off' || enforcement === 'guard') {
      return enforcement;
    }
  }
  return undefined;
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
  terminalCapability: ReturnType<typeof resolveGenerateTerminalToolset>;
}): PcvN8StagePolicy[] {
  const stageOrder = !needsCandidates
    ? ['analyze']
    : hasExistingRecipes && !prescreenDone
      ? ['evolve', 'evolution_gate', 'analyze', 'quality_gate', 'produce', 'rejection_gate']
      : ['analyze', 'quality_gate', 'produce', 'rejection_gate'];
  return stageOrder.map((stage) => {
    const additionalTools = getGenerateStageTerminalTools(stage, terminalCapability);
    return {
      additionalTools,
      stage,
      terminalAllowed: additionalTools.some((tool) => TERMINAL_TOOL_IDS.has(tool)),
      terminalTools: additionalTools.filter((tool) => TERMINAL_TOOL_IDS.has(tool)),
    };
  });
}

function resolveProducerGapLimit(plan: GenerateDimensionPlan): number | null {
  const createBudget = plan.rescanExecutionDecision?.createBudget;
  return typeof createBudget === 'number' && Number.isFinite(createBudget)
    ? Math.max(0, Math.floor(createBudget))
    : null;
}

function isKnowledgeSubmitToolCall(call: ToolCallRecord): boolean {
  return toolName(call) === 'knowledge' && actionName(call) === 'submit';
}

function isSuccessfulToolCall(call: ToolCallRecord): boolean {
  const result = call.result;
  // 核心修正:失败的 submit 经 fail(...) → data:null 折叠成 null 结果；非结构化结果同样不是成功。
  // 旧逻辑把这两种都 return true(误记为成功，掩盖真库 0 行)。null/非结构化判为失败;其余保持原判据。
  if (!result) {
    return false;
  }
  if (typeof result === 'string') {
    return !result.includes('rejected') && !result.includes('error');
  }
  if (!isRecord(result)) {
    return false;
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
