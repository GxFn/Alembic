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
  BootstrapDimensionProjection,
  ToolCallRecord,
} from '#workflows/capabilities/execution/internal-agent/BootstrapProjections.js';

export const PCV_COLD_START_NODE_LOCAL_CONTRACT = 'PCVColdStartNodeLocalBaseline';
export const PCV_COLD_START_NODE_LOCAL_CONTRACT_VERSION = 1;
export const PCV_N8_NODE_ID = 'N8-stage-factory-tool-policy';
export const PCV_N11_NODE_ID = 'N11-produce';
export const PCV_N12_NODE_ID = 'N12-consumers-persistence';

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

export interface PcvN11ProduceEvidence extends PcvNodeLocalEvidenceBase {
  acceptedCount: number;
  evidenceKind: 'producer-cut';
  gapLimit: number | null;
  noTerminalProof: boolean;
  producerOnlyCut: boolean;
  producerToolCalls: Array<{ action: string | null; status: string | null; tool: string }>;
  rejectedCount: number;
  sourceRefs: string[];
  submittedCount: number;
  terminalToolCallCount: number;
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
  n11?: PcvN11ProduceEvidence;
  n12?: PcvN12ConsumerPersistenceEvidence;
}

const TERMINAL_TOOL_IDS = new Set(['terminal', 'terminal_shell', 'terminal_pty']);

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
}: {
  dimId: string;
  needsCandidates: boolean;
  projection: BootstrapDimensionProjection;
}): PcvN11ProduceEvidence {
  const producerOnlyCut = Array.isArray(projection.produceResult?.toolCalls);
  const producerToolCalls = resolveProducerToolCalls(projection);
  const producerSubmitCalls = producerToolCalls.filter(isKnowledgeSubmitToolCall);
  const acceptedCount = producerSubmitCalls.filter(isSuccessfulToolCall).length;
  const rejectedCount = producerSubmitCalls.length - acceptedCount;
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

  const status = !needsCandidates
    ? 'not-applicable'
    : missingLinkReasons.length > 0
      ? 'blocked-by-observability-gap'
      : 'linked';
  return {
    acceptedCount,
    chainNodeId: PCV_N11_NODE_ID,
    contract: PCV_COLD_START_NODE_LOCAL_CONTRACT,
    contractVersion: PCV_COLD_START_NODE_LOCAL_CONTRACT_VERSION,
    dimensionId: dimId,
    evidenceKind: 'producer-cut',
    gapLimit: null,
    missingLinkReasons,
    noTerminalProof: terminalToolCallCount === 0,
    nodeId: PCV_N11_NODE_ID,
    producerOnlyCut,
    producerToolCalls: producerToolCalls.map((call) => ({
      action: actionName(call),
      status: resultStatus(call),
      tool: toolName(call),
    })),
    rejectedCount,
    sourceRefs: collectSourceRefsFromProjection(projection),
    status,
    submittedCount: producerSubmitCalls.length,
    summary: needsCandidates
      ? `Producer submitted ${producerSubmitCalls.length} candidate call(s): ${acceptedCount} accepted, ${rejectedCount} rejected.`
      : 'Producer node is not applicable for skill-only bootstrap dimensions.',
    terminalToolCallCount,
  };
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
  return refs.filter(looksLikeSourceRef);
}

function looksLikeSourceRef(value: string): boolean {
  return /[\w/.-]+\.[\w]+(?::\d+)?$/.test(value.trim());
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
