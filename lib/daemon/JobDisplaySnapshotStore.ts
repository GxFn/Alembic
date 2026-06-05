import fs from 'node:fs';
import path from 'node:path';
import {
  ALEMBIC_JOB_DISPLAY_SNAPSHOT_PATH,
  createJobDisplaySnapshot,
  createJobDisplaySnapshotArtifactRef,
  createJobDisplaySnapshotEvidenceIncomplete,
  type DaemonJobRecord,
  type JobDisplaySnapshot,
  type JobDisplaySnapshotArtifactRef,
  type JobDisplaySnapshotEvidenceIncomplete,
  type JobDisplaySnapshotEvidenceItem,
  type JobDisplaySnapshotLlmIoKind,
  type JobDisplaySnapshotPhaseStatus,
  type JobDisplaySnapshotPhaseTimelineItem,
  type JobDisplaySnapshotSection,
  type JobDisplaySnapshotValidationResult,
  type JobDisplaySnapshotWarning,
  validateJobDisplaySnapshot,
} from '@alembic/core/daemon';
import { readJobProcessEventArtifact } from './JobProcessEventArtifacts.js';
import type {
  JobProcessEventListResult,
  JobProcessEventRecorder,
} from './JobProcessEventRecorder.js';

const JOB_DISPLAY_SNAPSHOT_ROOT = 'job-display-snapshots';
const SNAPSHOT_FILE_NAME = 'snapshot.json';
const SNAPSHOT_FILE_MODE = 0o600;
const SNAPSHOT_DIR_MODE = 0o700;
const SNAPSHOT_PRODUCER_MODULES = [
  'lib/daemon/DaemonJobRunner.ts',
  'lib/daemon/JobDisplaySnapshotStore.ts',
  'lib/http/routes/jobs.ts',
];

export interface JobDisplaySnapshotReadResult {
  absolutePath: string;
  snapshot: JobDisplaySnapshot;
  validation: JobDisplaySnapshotValidationResult;
}

export interface JobDisplaySnapshotWriteResult extends JobDisplaySnapshotReadResult {
  written: true;
}

export interface JobDisplaySnapshotStoreOptions {
  dataRoot: string;
  producerVersion?: string | null;
}

export class JobDisplaySnapshotStore {
  readonly dataRoot: string;
  readonly producerVersion: string | null;

  constructor(options: JobDisplaySnapshotStoreOptions) {
    this.dataRoot = options.dataRoot;
    this.producerVersion = options.producerVersion ?? null;
  }

  read(jobId: string): JobDisplaySnapshotReadResult | null {
    return this.#readAtDataRoot(jobId, this.dataRoot);
  }

  readForJob(job: DaemonJobRecord): JobDisplaySnapshotReadResult | null {
    return this.#readAtDataRoot(job.id, this.#dataRootForJob(job));
  }

  #readAtDataRoot(jobId: string, dataRoot: string): JobDisplaySnapshotReadResult | null {
    if (!isSafePathPart(jobId)) {
      return null;
    }
    const absolutePath = this.#snapshotPath(jobId, dataRoot);
    try {
      const snapshot = JSON.parse(fs.readFileSync(absolutePath, 'utf8')) as JobDisplaySnapshot;
      return {
        absolutePath,
        snapshot,
        validation: validateJobDisplaySnapshot(snapshot),
      };
    } catch {
      return null;
    }
  }

  writeFromJob(options: {
    job: DaemonJobRecord;
    recorder?: JobProcessEventRecorder | null;
  }): JobDisplaySnapshotWriteResult {
    const dataRoot = this.#dataRootForJob(options.job);
    const now = new Date().toISOString();
    const existing = this.readForJob(options.job)?.snapshot ?? null;
    const eventList = options.recorder
      ? options.recorder.list(options.job.id, {
          includeHidden: true,
          limit: options.recorder.maxEventsPerJob,
        })
      : createEmptyEventList(options.job.id);
    const snapshot = this.buildSnapshot({
      existing,
      eventList,
      job: options.job,
      now,
    });
    const absolutePath = this.#snapshotPath(options.job.id, dataRoot);
    assertPathInside(absolutePath, this.#jobRoot(options.job.id, dataRoot));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: SNAPSHOT_DIR_MODE });
    fs.writeFileSync(absolutePath, JSON.stringify(snapshot, null, 2), {
      encoding: 'utf8',
      mode: SNAPSHOT_FILE_MODE,
    });
    return {
      absolutePath,
      snapshot,
      validation: validateJobDisplaySnapshot(snapshot),
      written: true,
    };
  }

  buildSnapshot(options: {
    eventList?: JobProcessEventListResult;
    existing?: JobDisplaySnapshot | null;
    job: DaemonJobRecord;
    now?: string;
  }): JobDisplaySnapshot {
    const now = options.now ?? new Date().toISOString();
    const eventList = options.eventList ?? createEmptyEventList(options.job.id);
    const dataRoot = this.#dataRootForJob(options.job);
    const artifacts = collectSnapshotArtifacts({
      dataRoot,
      events: eventList.events,
      jobId: options.job.id,
    });
    const sourceRefs = collectSourceRefs(eventList);
    const findings = collectEvidenceItems(eventList, 'findings');
    const candidates = collectEvidenceItems(eventList, 'candidates');
    const evidenceIncomplete = [
      ...collectCompletenessEvidence(options.job, eventList, artifacts),
      ...artifacts.evidenceIncomplete,
    ];
    const warnings = evidenceIncomplete.map((evidence) => warningFromEvidence(evidence));
    const snapshot = createJobDisplaySnapshot({
      artifacts: artifacts.refs,
      candidates,
      developerViews: eventList.developerViews,
      events: eventList.events,
      evidenceIncomplete,
      findings,
      job: buildJobIdentity(options.job),
      phaseTimeline: buildPhaseTimeline(options.job, eventList),
      producer: {
        modules: SNAPSHOT_PRODUCER_MODULES,
        name: 'alembic',
        producedAt: now,
        version: this.producerVersion,
      },
      snapshot: {
        createdAt: options.existing?.snapshot.createdAt ?? now,
        jobId: options.job.id,
        ref: buildJobDisplaySnapshotApiRef(options.job.id),
        snapshotId: options.existing?.snapshot.snapshotId ?? `${options.job.id}_display_snapshot`,
        snapshotVersion: (options.existing?.snapshot.snapshotVersion ?? 0) + 1,
        sourceJobUpdatedAt: options.job.updatedAt ?? null,
        updatedAt: now,
      },
      sourceRefs,
      summary: buildSnapshotSummary(options.job, eventList),
      warnings,
    });
    return snapshot;
  }

  buildIncompleteSnapshot(options: {
    job: DaemonJobRecord;
    message?: string;
    reason?: JobDisplaySnapshotEvidenceIncomplete['reason'];
  }): JobDisplaySnapshot {
    const now = new Date().toISOString();
    const reason = options.reason ?? 'events_missing_after_restart';
    const evidence = createJobDisplaySnapshotEvidenceIncomplete({
      message:
        options.message ??
        'No retained display snapshot was found; only durable job metadata is available.',
      reason,
      section: reason === 'llm_io_missing' ? 'llm-io' : 'events',
    });
    return createJobDisplaySnapshot({
      evidenceIncomplete: [evidence],
      job: buildJobIdentity(options.job),
      producer: {
        modules: SNAPSHOT_PRODUCER_MODULES,
        name: 'alembic',
        producedAt: now,
        version: this.producerVersion,
      },
      snapshot: {
        createdAt: now,
        jobId: options.job.id,
        ref: buildJobDisplaySnapshotApiRef(options.job.id),
        snapshotId: `${options.job.id}_display_snapshot_missing`,
        snapshotVersion: 1,
        sourceJobUpdatedAt: options.job.updatedAt ?? null,
        updatedAt: now,
      },
      summary: buildSnapshotSummary(options.job, createEmptyEventList(options.job.id)),
      warnings: [warningFromEvidence(evidence)],
    });
  }

  #dataRootForJob(job: DaemonJobRecord): string {
    return typeof job.dataRoot === 'string' && job.dataRoot.length > 0
      ? job.dataRoot
      : this.dataRoot;
  }

  #jobRoot(jobId: string, dataRoot: string): string {
    return path.join(dataRoot, '.asd', JOB_DISPLAY_SNAPSHOT_ROOT, safePathPart(jobId));
  }

  #snapshotPath(jobId: string, dataRoot: string): string {
    return path.join(this.#jobRoot(jobId, dataRoot), SNAPSHOT_FILE_NAME);
  }
}

export function buildJobDisplaySnapshotApiRef(jobId: string): string {
  return ALEMBIC_JOB_DISPLAY_SNAPSHOT_PATH.replace(':jobId', encodeURIComponent(jobId));
}

export function summarizeJobDisplaySnapshotForApi(
  snapshot: JobDisplaySnapshot | null | undefined
): Record<string, unknown> | null {
  if (!snapshot) {
    return null;
  }
  return {
    available: true,
    checksum: snapshot.snapshot.checksum,
    checksumAlgorithm: snapshot.snapshot.checksumAlgorithm,
    evidenceIncompleteCount:
      snapshot.evidenceIncomplete.length + snapshot.llmIo.evidenceIncomplete.length,
    ref: snapshot.snapshot.ref,
    snapshotId: snapshot.snapshot.snapshotId,
    snapshotVersion: snapshot.snapshot.snapshotVersion,
    updatedAt: snapshot.snapshot.updatedAt,
    warningCount: snapshot.warnings.length,
  };
}

function buildJobIdentity(job: DaemonJobRecord): JobDisplaySnapshot['job'] {
  return {
    bootstrapSessionId: job.bootstrapSessionId ?? null,
    completedAt: job.completedAt ?? null,
    createdAt: job.createdAt,
    dataRoot: job.dataRoot ?? null,
    id: job.id,
    kind: job.kind,
    projectId: job.projectId ?? null,
    projectRoot: job.projectRoot ?? null,
    startedAt: job.startedAt ?? null,
    status: job.status,
    updatedAt: job.updatedAt,
  };
}

function buildSnapshotSummary(
  job: DaemonJobRecord,
  eventList: JobProcessEventListResult
): JobDisplaySnapshot['summary'] {
  const lastSummary =
    [...eventList.events]
      .reverse()
      .find((event) => event.kind === 'summary' || event.kind === 'workflow') ?? null;
  return {
    message: lastSummary?.summary ?? job.error?.message ?? null,
    phase: lastSummary?.phase ?? null,
    progress: null,
    statusText: job.status,
    title: lastSummary?.title ?? `${job.kind} job ${job.status}`,
  };
}

function buildPhaseTimeline(
  job: DaemonJobRecord,
  eventList: JobProcessEventListResult
): JobDisplaySnapshotPhaseTimelineItem[] {
  const byPhase = new Map<string, typeof eventList.events>();
  for (const event of eventList.events) {
    const phase = event.phase || event.kind || 'job';
    byPhase.set(phase, [...(byPhase.get(phase) ?? []), event]);
  }
  if (byPhase.size === 0) {
    return [
      {
        completedAt: isTerminalJobStatus(job.status) ? (job.completedAt ?? job.updatedAt) : null,
        eventIds: [],
        phase: job.status,
        startedAt: job.startedAt ?? job.createdAt,
        status: job.status,
        summary: job.error?.message ?? null,
        title: `${job.kind} job ${job.status}`,
      },
    ];
  }
  return [...byPhase.entries()].map(([phase, events]) => ({
    completedAt: events[events.length - 1]?.createdAt ?? null,
    eventIds: events.map((event) => event.id),
    phase,
    startedAt: events[0]?.createdAt ?? null,
    status: phaseStatusFromEvents(job, events),
    summary: events[events.length - 1]?.summary ?? null,
    title: events[events.length - 1]?.title ?? phase,
  }));
}

function phaseStatusFromEvents(
  job: DaemonJobRecord,
  events: JobProcessEventListResult['events']
): JobDisplaySnapshotPhaseStatus {
  const last = events[events.length - 1];
  if (!last) {
    return 'unknown';
  }
  if (last.severity === 'error') {
    return 'failed';
  }
  if (last.severity === 'success' || isTerminalJobStatus(job.status)) {
    return job.status === 'failed' && last.severity === 'success' ? 'completed' : job.status;
  }
  if (last.phase === 'queued') {
    return 'queued';
  }
  if (last.phase === 'running' || job.status === 'running') {
    return 'running';
  }
  return 'unknown';
}

function collectSnapshotArtifacts({
  dataRoot,
  events,
  jobId,
}: {
  dataRoot: string;
  events: JobProcessEventListResult['events'];
  jobId: string;
}): {
  evidenceIncomplete: JobDisplaySnapshotEvidenceIncomplete[];
  refs: JobDisplaySnapshotArtifactRef[];
} {
  const refs = new Map<string, JobDisplaySnapshotArtifactRef>();
  const evidenceIncomplete: JobDisplaySnapshotEvidenceIncomplete[] = [];
  for (const event of events) {
    for (const artifactRef of event.artifactRefs) {
      const metadata = event.metadata;
      const artifact = createJobDisplaySnapshotArtifactRef({
        ...artifactRef,
        originalChars: numberFromUnknown(metadata.artifactOriginalChars),
        redactionState: normalizeRedactionState(metadata.artifactRedactionState),
        retained: metadata.artifactRetained !== false,
        retainedChars: numberFromUnknown(metadata.artifactRetainedChars),
        storageKind: artifactRef.ref.startsWith(
          `/api/v1/jobs/${encodeURIComponent(jobId)}/artifacts/`
        )
          ? 'job-artifact'
          : 'external-ref',
        truncated:
          metadata.contentTruncated === true ||
          isTruncated(
            numberFromUnknown(metadata.artifactOriginalChars),
            numberFromUnknown(metadata.artifactRetainedChars)
          ),
      });
      refs.set(artifact.ref, artifact);
      const artifactId = artifactIdFromRef(artifact.ref);
      if (artifact.storageKind === 'job-artifact' && artifact.retained && artifactId) {
        const artifactContent = readJobProcessEventArtifact({ artifactId, dataRoot, jobId });
        if (!artifactContent) {
          evidenceIncomplete.push(
            createJobDisplaySnapshotEvidenceIncomplete({
              artifactRef: artifact.ref,
              eventId: event.id,
              message: `Retained job artifact is missing or unreadable: ${artifact.ref}`,
              reason: 'artifact_missing',
              section: 'artifacts',
              severity: 'warning',
            })
          );
        }
      }
      if (artifact.truncated && isLlmIoKind(event.kind)) {
        evidenceIncomplete.push(
          createJobDisplaySnapshotEvidenceIncomplete({
            artifactRef: artifact.ref,
            eventId: event.id,
            message: `LLM IO artifact is truncated in the job display snapshot: ${artifact.ref}`,
            reason: 'llm_io_truncated',
            section: 'llm-io',
            severity: 'warning',
          })
        );
      }
      if (
        artifact.redactionState === 'redacted' ||
        artifact.redactionState === 'partially-redacted'
      ) {
        evidenceIncomplete.push(
          createJobDisplaySnapshotEvidenceIncomplete({
            artifactRef: artifact.ref,
            eventId: event.id,
            message: `Artifact content is ${artifact.redactionState} for developer-safe display.`,
            reason: 'snapshot_redacted',
            section: isLlmIoKind(event.kind) ? 'llm-io' : 'artifacts',
            severity: 'info',
          })
        );
      }
      if (metadata.artifactRetained === false) {
        evidenceIncomplete.push(
          createJobDisplaySnapshotEvidenceIncomplete({
            artifactRef: artifact.ref,
            eventId: event.id,
            message:
              typeof metadata.artifactRetainError === 'string'
                ? metadata.artifactRetainError
                : 'Artifact retention failed before snapshot capture.',
            reason: 'artifact_unreadable',
            section: 'artifacts',
            severity: 'warning',
          })
        );
      }
    }
  }
  return {
    evidenceIncomplete,
    refs: [...refs.values()],
  };
}

function collectCompletenessEvidence(
  job: DaemonJobRecord,
  eventList: JobProcessEventListResult,
  artifacts: { refs: JobDisplaySnapshotArtifactRef[] }
): JobDisplaySnapshotEvidenceIncomplete[] {
  const evidence: JobDisplaySnapshotEvidenceIncomplete[] = [];
  if (eventList.events.length === 0 && job.status !== 'queued') {
    evidence.push(
      createJobDisplaySnapshotEvidenceIncomplete({
        message:
          'No retained process events were available when the display snapshot was produced.',
        reason: 'events_missing_after_restart',
        section: 'events',
        severity: 'warning',
      })
    );
  }
  if (
    isTerminalJobStatus(job.status) &&
    !eventList.events.some((event) => isLlmIoKind(event.kind))
  ) {
    evidence.push(
      createJobDisplaySnapshotEvidenceIncomplete({
        message: 'No retained LLM IO events were available for this terminal job.',
        reason: 'llm_io_missing',
        section: 'llm-io',
        severity: 'warning',
      })
    );
  }
  if (job.kind === 'bootstrap' && isTerminalJobStatus(job.status) && !hasFinalSession(job)) {
    evidence.push(
      createJobDisplaySnapshotEvidenceIncomplete({
        message: 'The terminal bootstrap job does not include a final session payload.',
        reason: 'final_session_missing',
        section: 'summary',
        severity: 'warning',
      })
    );
  }
  if (artifacts.refs.some((artifact) => artifact.truncated)) {
    evidence.push(
      createJobDisplaySnapshotEvidenceIncomplete({
        message: 'One or more retained artifacts were truncated.',
        reason: 'snapshot_truncated',
        section: 'artifacts',
        severity: 'warning',
      })
    );
  }
  return evidence;
}

function collectSourceRefs(eventList: JobProcessEventListResult): JobDisplaySnapshotEvidenceItem[] {
  const refs = new Set<string>();
  for (const event of eventList.events) {
    for (const ref of collectSourceRefsFromValue(event.metadata)) {
      refs.add(ref);
    }
  }
  return [...refs].map((ref) => ({
    artifactRefs: [],
    id: `source-ref:${ref}`,
    metadata: {},
    sourceRef: ref,
    summary: ref,
    title: ref,
  }));
}

function collectEvidenceItems(
  eventList: JobProcessEventListResult,
  field: 'candidates' | 'findings'
): JobDisplaySnapshotEvidenceItem[] {
  const items: JobDisplaySnapshotEvidenceItem[] = [];
  for (const event of eventList.events) {
    const values = Array.isArray(event.metadata[field]) ? event.metadata[field] : [];
    for (const [index, value] of values.entries()) {
      const record = isRecord(value) ? value : { title: String(value) };
      const title = stringFromUnknown(record.title) || stringFromUnknown(record.summary) || field;
      items.push({
        artifactRefs: event.artifactRefs.map((artifactRef) =>
          createJobDisplaySnapshotArtifactRef(artifactRef)
        ),
        id: `${event.id}:${field}:${index}`,
        metadata: { ...record },
        sourceRef: stringFromUnknown(record.sourceRef),
        summary: stringFromUnknown(record.summary),
        title,
      });
    }
  }
  return items;
}

function collectSourceRefsFromValue(value: unknown): string[] {
  const refs = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (typeof item === 'string' && item.trim()) {
          refs.add(item.trim());
        }
      }
      return;
    }
    if (!isRecord(candidate)) {
      return;
    }
    visit(candidate.sourceRefs);
    visit(candidate.sourceRef ? [candidate.sourceRef] : undefined);
    visit(candidate.traceEnvelope);
    visit(candidate.pcvNodeEvidence);
    visit(
      isRecord(candidate.pcvN9Observability) ? candidate.pcvN9Observability.evidenceLinks : null
    );
  };
  visit(value);
  return [...refs];
}

function warningFromEvidence(
  evidence: JobDisplaySnapshotEvidenceIncomplete
): JobDisplaySnapshotWarning {
  return {
    code: `evidence.${evidence.reason}`,
    evidenceIncompleteReason: evidence.reason,
    message: evidence.message,
    section: evidence.section,
    severity: evidence.severity,
  };
}

function createEmptyEventList(jobId: string): JobProcessEventListResult {
  return {
    count: 0,
    developerViews: [],
    endpointCapability: {
      available: true,
      contractVersion: 1,
      defaultRetention: 'job-retained',
      developerFacingDefaultDisplayPolicy: 'full',
      endpoint: '/api/v1/jobs/:jobId/events',
      supportedDisplayPolicies: ['full', 'summary-only', 'hidden'],
      supportedKinds: [],
      supportedRetentionPolicies: ['transient', 'job-retained'],
      supportedSourceClasses: [],
    },
    events: [],
    hiddenCount: 0,
    jobId,
    nextSequence: 0,
    retainedCount: 0,
  };
}

function hasFinalSession(job: DaemonJobRecord): boolean {
  const result = isRecord(job.result) ? job.result : null;
  return Boolean(result?.finalSession || result?.bootstrapSession);
}

function isTerminalJobStatus(status: DaemonJobRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isLlmIoKind(kind: unknown): kind is JobDisplaySnapshotLlmIoKind {
  return kind === 'llm.input' || kind === 'llm.reflection' || kind === 'llm.output';
}

function artifactIdFromRef(ref: string): string | null {
  const marker = '/artifacts/';
  const index = ref.indexOf(marker);
  if (index < 0) {
    return null;
  }
  try {
    return decodeURIComponent(ref.slice(index + marker.length));
  } catch {
    return null;
  }
}

function normalizeRedactionState(value: unknown): JobDisplaySnapshotArtifactRef['redactionState'] {
  if (value === 'not-redacted' || value === 'none') {
    return 'not-redacted';
  }
  if (value === 'partially-redacted') {
    return 'partially-redacted';
  }
  if (typeof value === 'string' && value.includes('redacted')) {
    return 'redacted';
  }
  return 'unknown';
}

function isTruncated(originalChars: number | null, retainedChars: number | null): boolean {
  return (
    typeof originalChars === 'number' &&
    typeof retainedChars === 'number' &&
    retainedChars < originalChars
  );
}

function numberFromUnknown(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function isSafePathPart(value: string): boolean {
  return /^[a-zA-Z0-9._:-]{1,220}$/.test(value);
}

function assertPathInside(candidatePath: string, root: string): void {
  const normalizedRoot = path.resolve(root);
  const normalizedPath = path.resolve(candidatePath);
  if (
    normalizedPath !== normalizedRoot &&
    !normalizedPath.startsWith(`${normalizedRoot}${path.sep}`)
  ) {
    throw new Error('Job display snapshot path escaped the job snapshot root.');
  }
}
