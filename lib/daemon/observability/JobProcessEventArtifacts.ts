import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { JobProcessEventArtifactRef } from '@alembic/core/daemon';
import type { GenerateProcessEventTextArtifactCandidate } from '../../recipe-pipeline/generate/runtime/generate-event-types.js';

const JOB_ARTIFACT_ROOT = 'job-artifacts';
const ARTIFACT_FILE_MODE = 0o600;

export interface MaterializedJobProcessArtifact {
  artifactRef: JobProcessEventArtifactRef;
  metadata: Record<string, unknown>;
  relativePath: string;
}

export interface ReadJobProcessArtifactResult {
  absolutePath: string;
  content: string;
  mimeType: string;
}

export function materializeJobProcessEventTextArtifact({
  candidate,
  dataRoot,
  dimensionId,
  jobId,
  iteration,
}: {
  candidate: GenerateProcessEventTextArtifactCandidate;
  dataRoot: string;
  dimensionId?: string | null;
  jobId: string;
  iteration?: unknown;
}): MaterializedJobProcessArtifact {
  const artifactId = buildArtifactId({ candidate, dimensionId, iteration, jobId });
  const jobRoot = getJobArtifactRoot(dataRoot, jobId);
  const absolutePath = path.join(jobRoot, artifactId);
  assertPathInside(absolutePath, jobRoot);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(absolutePath, candidate.text, {
    encoding: 'utf8',
    mode: ARTIFACT_FILE_MODE,
  });

  const relativePath = path.join('.asd', JOB_ARTIFACT_ROOT, safePathPart(jobId), artifactId);
  const artifactRef: JobProcessEventArtifactRef = {
    kind: candidate.kind,
    label: candidate.label,
    mimeType: candidate.mimeType,
    ref: buildJobArtifactApiRef(jobId, artifactId),
  };
  const retainedChars = candidate.text.length;
  return {
    artifactRef,
    metadata: {
      artifactDataRootScoped: true,
      artifactId,
      artifactKind: candidate.kind,
      artifactOriginalChars: candidate.originalChars,
      artifactPath: relativePath,
      artifactRedactionState: candidate.redactionState,
      artifactRef: artifactRef.ref,
      artifactRetained: true,
      artifactRetainedChars: retainedChars,
      artifactStorage: 'ghost-data-root-job-artifacts',
    },
    relativePath,
  };
}

export function readJobProcessEventArtifact({
  artifactId,
  dataRoot,
  jobId,
}: {
  artifactId: string;
  dataRoot: string;
  jobId: string;
}): ReadJobProcessArtifactResult | null {
  if (!isSafeArtifactId(artifactId)) {
    return null;
  }
  const jobRoot = getJobArtifactRoot(dataRoot, jobId);
  const absolutePath = path.join(jobRoot, artifactId);
  assertPathInside(absolutePath, jobRoot);
  try {
    return {
      absolutePath,
      content: fs.readFileSync(absolutePath, 'utf8'),
      mimeType: mimeTypeForArtifact(artifactId),
    };
  } catch {
    return null;
  }
}

export function buildJobArtifactApiRef(jobId: string, artifactId: string): string {
  return `/api/v1/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactId)}`;
}

function buildArtifactId({
  candidate,
  dimensionId,
  iteration,
  jobId,
}: {
  candidate: GenerateProcessEventTextArtifactCandidate;
  dimensionId?: string | null;
  iteration?: unknown;
  jobId: string;
}): string {
  const extension = extensionForMimeType(candidate.mimeType);
  const hash = createHash('sha256')
    .update(jobId)
    .update('\0')
    .update(candidate.kind)
    .update('\0')
    .update(String(dimensionId || 'global'))
    .update('\0')
    .update(String(typeof iteration === 'number' ? iteration : 'unknown'))
    .update('\0')
    .update(candidate.text)
    .digest('hex')
    .slice(0, 16);
  const prefix = safePathPart(candidate.kind).slice(0, 48) || 'artifact';
  const dimension = safePathPart(dimensionId || 'global').slice(0, 48) || 'global';
  const iterationPart =
    typeof iteration === 'number' && Number.isFinite(iteration) ? `-i${iteration}` : '';
  return `${prefix}-${dimension}${iterationPart}-${hash}${extension}`;
}

function getJobArtifactRoot(dataRoot: string, jobId: string): string {
  return path.join(dataRoot, '.asd', JOB_ARTIFACT_ROOT, safePathPart(jobId));
}

function assertPathInside(candidatePath: string, root: string): void {
  const normalizedRoot = path.resolve(root);
  const normalizedPath = path.resolve(candidatePath);
  if (
    normalizedPath !== normalizedRoot &&
    !normalizedPath.startsWith(`${normalizedRoot}${path.sep}`)
  ) {
    throw new Error('Job process artifact path escaped the job artifact root.');
  }
}

function isSafeArtifactId(value: string): boolean {
  return /^[a-zA-Z0-9._-]{1,180}$/.test(value);
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function extensionForMimeType(mimeType: string | null): string {
  if (mimeType?.includes('json')) {
    return '.json';
  }
  if (mimeType?.includes('markdown')) {
    return '.md';
  }
  return '.txt';
}

function mimeTypeForArtifact(artifactId: string): string {
  if (artifactId.endsWith('.json')) {
    return 'application/json; charset=utf-8';
  }
  if (artifactId.endsWith('.md')) {
    return 'text/markdown; charset=utf-8';
  }
  return 'text/plain; charset=utf-8';
}
