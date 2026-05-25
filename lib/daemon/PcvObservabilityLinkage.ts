import type { JobProcessEventArtifactRef } from '@alembic/core/daemon';
import type { BootstrapProcessEventDraft } from '#service/bootstrap/bootstrap-event-types.js';

export const PCV_N9_NODE_ID = 'N9-agent-analyze-quality';
export const PCV_N9_OBSERVABILITY_CONTRACT_VERSION = 1;

type PcvN9NodeIdentitySource =
  | 'agent-explicit'
  | 'host-stage-profile'
  | 'host-quality-gate'
  | 'host-findings-digest';

type PcvN9LinkageStatus = 'linked' | 'blocked-by-observability-gap';

type PcvN9MissingLinkReason =
  | 'artifact_missing'
  | 'metrics_missing'
  | 'node_identity_missing'
  | 'source_ref_missing'
  | 'trace_id_missing';

export interface PcvN9ObservabilityCarry {
  contractVersion: typeof PCV_N9_OBSERVABILITY_CONTRACT_VERSION;
  evidenceLinks: {
    artifactRefs: string[];
    metricsPath: string | null;
    sourceRefs: string[];
    traceId: string | null;
  };
  firstFix: string[];
  jobId: string;
  linkageStatus: PcvN9LinkageStatus;
  missingLinkReasons: PcvN9MissingLinkReason[];
  nodeId: typeof PCV_N9_NODE_ID;
  nodeIdentitySource: PcvN9NodeIdentitySource | null;
  sessionId: string | null;
}

/**
 * Alembic 主仓库只负责 host/daemon 层 carry，不定义新的跨包 schema。
 * 这里把 Agent 已发出的 developer-safe process event 草稿补成 PCV N9 可读的
 * job-level linkage 元数据：同一个 node id 能同时指向 artifact、trace、metrics
 * 和 source refs；缺哪个字段就明确记录 missing reason，继续保持
 * blocked-by-observability-gap，而不是伪造质量分。
 */
export function attachPcvN9ObservabilityCarry({
  artifactRefs,
  draft,
  jobId,
  metadata,
}: {
  artifactRefs: JobProcessEventArtifactRef[];
  draft: BootstrapProcessEventDraft;
  jobId: string;
  metadata: Record<string, unknown>;
}): Record<string, unknown> {
  const rawTraceEnvelope = asRecord(metadata.traceEnvelope);
  const nodeIdentity = resolvePcvN9NodeIdentity({
    draft,
    metadata,
    traceEnvelope: rawTraceEnvelope,
  });
  if (!nodeIdentity.applies) {
    return metadata;
  }

  const sourceRefs = collectSourceRefs(metadata);
  const artifactRefValues = artifactRefs.map((artifactRef) => artifactRef.ref).filter(Boolean);
  const traceId =
    stringValue(rawTraceEnvelope?.traceId) ||
    stringValue(rawTraceEnvelope?.correlationId) ||
    stringValue(draft.correlationId) ||
    stringValue(metadata.traceId) ||
    null;
  const hasMetrics = isRecord(metadata.llmMetrics);
  const missingLinkReasons = buildMissingLinkReasons({
    artifactRefValues,
    hasMetrics,
    nodeIdentity,
    sourceRefs,
    traceId,
  });
  const linkageStatus: PcvN9LinkageStatus =
    missingLinkReasons.length === 0 ? 'linked' : 'blocked-by-observability-gap';
  const nodeId = nodeIdentity.nodeId ?? PCV_N9_NODE_ID;
  const sessionId =
    stringValue(metadata.sessionId) || stringValue(rawTraceEnvelope?.sessionId) || null;

  const traceEnvelope = {
    ...(rawTraceEnvelope || {}),
    artifactRefs: artifactRefValues,
    chainNodeId: stringValue(rawTraceEnvelope?.chainNodeId) || nodeId,
    jobId,
    metricsPath: hasMetrics ? 'metadata.llmMetrics' : null,
    nodeId,
    pcvNodeId: nodeId,
    sessionId,
    sourceRefs,
    traceId,
  };
  const pcvN9Observability: PcvN9ObservabilityCarry = {
    contractVersion: PCV_N9_OBSERVABILITY_CONTRACT_VERSION,
    evidenceLinks: {
      artifactRefs: artifactRefValues,
      metricsPath: hasMetrics ? 'metadata.llmMetrics' : null,
      sourceRefs,
      traceId,
    },
    firstFix: firstFixForMissingLinks(missingLinkReasons),
    jobId,
    linkageStatus,
    missingLinkReasons,
    nodeId,
    nodeIdentitySource: nodeIdentity.source,
    sessionId,
  };

  return {
    ...metadata,
    pcvN9Observability,
    pcvObservability: {
      ...(isRecord(metadata.pcvObservability) ? metadata.pcvObservability : {}),
      n9: pcvN9Observability,
    },
    traceEnvelope,
  };
}

function resolvePcvN9NodeIdentity({
  draft,
  metadata,
  traceEnvelope,
}: {
  draft: BootstrapProcessEventDraft;
  metadata: Record<string, unknown>;
  traceEnvelope: Record<string, unknown> | null;
}): {
  applies: boolean;
  nodeId: typeof PCV_N9_NODE_ID | null;
  source: PcvN9NodeIdentitySource | null;
} {
  const pcvNode = asRecord(metadata.pcvNode);
  const pcvNodeEvidence = asRecord(metadata.pcvNodeEvidence);
  const explicitNodeIds = [
    metadata.pcvNodeId,
    metadata.nodeId,
    metadata.chainNodeId,
    pcvNode?.nodeId,
    // AlembicAgent 当前把 N9 compact evidence 放在 nested metadata.pcvNodeEvidence。
    // 这里把 nested node id 视作 explicit identity，避免退回 host-stage 推断。
    pcvNodeEvidence?.nodeId,
    pcvNodeEvidence?.chainNodeId,
    traceEnvelope?.pcvNodeId,
    traceEnvelope?.nodeId,
    traceEnvelope?.chainNodeId,
  ]
    .map((value) => stringValue(value))
    .filter((value): value is string => Boolean(value));
  if (explicitNodeIds.includes(PCV_N9_NODE_ID)) {
    return { applies: true, nodeId: PCV_N9_NODE_ID, source: 'agent-explicit' };
  }

  const stageProfile = normalizeStage(
    stringValue(metadata.inputStageProfile) ||
      stringValue(traceEnvelope?.stageId) ||
      stringValue(draft.phase) ||
      stringValue(metadata.phase)
  );
  if (stageProfile === 'analyze' || stageProfile === 'verify' || stageProfile === 'record') {
    return { applies: true, nodeId: PCV_N9_NODE_ID, source: 'host-stage-profile' };
  }

  if (stringValue(metadata.reflectionSource) === 'quality-gate-diagnostics') {
    return { applies: true, nodeId: PCV_N9_NODE_ID, source: 'host-quality-gate' };
  }
  if (stringValue(metadata.projection) === 'dimension-findings-digest') {
    return { applies: true, nodeId: PCV_N9_NODE_ID, source: 'host-findings-digest' };
  }

  return { applies: false, nodeId: null, source: null };
}

function buildMissingLinkReasons({
  artifactRefValues,
  hasMetrics,
  nodeIdentity,
  sourceRefs,
  traceId,
}: {
  artifactRefValues: string[];
  hasMetrics: boolean;
  nodeIdentity: {
    nodeId: typeof PCV_N9_NODE_ID | null;
  };
  sourceRefs: string[];
  traceId: string | null;
}): PcvN9MissingLinkReason[] {
  const missing: PcvN9MissingLinkReason[] = [];
  if (!nodeIdentity.nodeId) {
    missing.push('node_identity_missing');
  }
  if (artifactRefValues.length === 0) {
    missing.push('artifact_missing');
  }
  if (!traceId) {
    missing.push('trace_id_missing');
  }
  if (!hasMetrics) {
    missing.push('metrics_missing');
  }
  if (sourceRefs.length === 0) {
    missing.push('source_ref_missing');
  }
  return missing;
}

function firstFixForMissingLinks(reasons: PcvN9MissingLinkReason[]): string[] {
  const fixes: string[] = [];
  if (reasons.includes('node_identity_missing')) {
    fixes.push('Emit pcvNodeId or chainNodeId for N9 from the Agent process event producer.');
  }
  if (reasons.includes('artifact_missing')) {
    fixes.push('Attach a redacted analysis artifactRef or report field to the N9 process event.');
  }
  if (reasons.includes('trace_id_missing')) {
    fixes.push('Carry correlationId/traceId through the N9 process event trace envelope.');
  }
  if (reasons.includes('metrics_missing')) {
    fixes.push('Attach llmMetrics to the N9 LLM input/output or quality-gate process event.');
  }
  if (reasons.includes('source_ref_missing')) {
    fixes.push('Carry file-level sourceRefs or referencedFiles used by N9 note_finding evidence.');
  }
  return fixes;
}

function collectSourceRefs(metadata: Record<string, unknown>): string[] {
  const pcvNodeEvidence = asRecord(metadata.pcvNodeEvidence);
  const refs = [
    ...stringArray(metadata.sourceRefs),
    ...stringArray(pcvNodeEvidence?.sourceRefs),
    ...stringArray(metadata.referencedFiles),
    ...stringArray(pcvNodeEvidence?.referencedFiles),
    ...sourceRefsFromFindings(metadata.findings),
    ...sourceRefsFromFindings(pcvNodeEvidence?.findings),
  ];
  return [...new Set(refs.map((ref) => ref.trim()).filter(Boolean))];
}

function sourceRefsFromFindings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const refs: string[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    refs.push(...stringArray(record.sourceRefs));
    const evidence = stringValue(record.evidence);
    if (evidence) {
      refs.push(evidence);
    }
  }
  return refs;
}

function normalizeStage(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (normalized.includes('record')) {
    return 'record';
  }
  if (normalized.includes('verify')) {
    return 'verify';
  }
  if (normalized.includes('analyze') || normalized.includes('analysis')) {
    return 'analyze';
  }
  return normalized;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
