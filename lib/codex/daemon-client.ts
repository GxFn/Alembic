import { daemonBaseUrl } from "../daemon/DaemonState.js";
import type { DaemonStatus } from "../daemon/DaemonSupervisor.js";
import { DaemonSupervisor } from "../daemon/DaemonSupervisor.js";
import type { DaemonJob, DaemonJobKind } from "../daemon/JobStore.js";

export interface CodexDaemonJobsResponse {
  readonly jobs: DaemonJob[];
}

export interface CodexDaemonJobResponse {
  readonly job: DaemonJob;
}

interface DaemonEnvelope<T> {
  readonly success?: boolean;
  readonly data?: T;
  readonly error?: {
    readonly message?: string;
  };
}

export async function ensureCodexDaemon(projectRoot?: string): Promise<DaemonStatus> {
  const supervisor = new DaemonSupervisor();
  return supervisor.start(projectRoot === undefined ? {} : { projectRoot });
}

export async function getCodexDaemonStatus(projectRoot?: string): Promise<DaemonStatus> {
  const supervisor = new DaemonSupervisor();
  return supervisor.status(projectRoot);
}

export async function enqueueCodexDaemonJob(
  kind: DaemonJobKind,
  input: Record<string, unknown> = {},
  projectRoot?: string,
): Promise<DaemonJob> {
  const data = await requestCodexDaemon<CodexDaemonJobResponse>(
    projectRoot,
    `/api/v1/jobs/${kind}`,
    {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
    },
  );
  return data.job;
}

export async function listCodexDaemonJobs(projectRoot?: string): Promise<DaemonJob[]> {
  const data = await requestCodexDaemon<CodexDaemonJobsResponse>(projectRoot, "/api/v1/jobs");
  return data.jobs;
}

export async function getCodexDaemonJob(jobId: string, projectRoot?: string): Promise<DaemonJob> {
  const data = await requestCodexDaemon<CodexDaemonJobResponse>(
    projectRoot,
    `/api/v1/jobs/${encodeURIComponent(jobId)}`,
  );
  return data.job;
}

export async function cancelCodexDaemonJob(
  jobId: string,
  projectRoot?: string,
): Promise<DaemonJob> {
  const data = await requestCodexDaemon<CodexDaemonJobResponse>(
    projectRoot,
    `/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`,
    { method: "POST" },
  );
  return data.job;
}

async function requestCodexDaemon<T>(
  projectRoot: string | undefined,
  pathname: string,
  init: RequestInit = {},
): Promise<T> {
  const status = await ensureCodexDaemon(projectRoot);
  if (!status.ready || status.state === undefined) {
    throw new Error(status.message ?? `Alembic daemon is not ready: ${status.status}`);
  }

  // MCP stdio 只负责排队/查询，bootstrap/rescan 这类长任务交给 daemon 在后台执行。
  const response = await fetch(
    `${daemonBaseUrl(status.state)}${pathname}`,
    withDaemonToken(init, status.state.token),
  );
  const envelope = await readDaemonEnvelope<T>(response);
  if (!response.ok) {
    throw new Error(envelope.error?.message ?? `Alembic daemon HTTP ${response.status}`);
  }
  if (envelope.success !== true || envelope.data === undefined) {
    throw new Error(envelope.error?.message ?? "Alembic daemon returned an unsuccessful response.");
  }

  return envelope.data;
}

function withDaemonToken(init: RequestInit, token: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("x-alembic-daemon-token", token);
  return { ...init, headers };
}

async function readDaemonEnvelope<T>(response: Response): Promise<DaemonEnvelope<T>> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return {};
  }

  try {
    return JSON.parse(text) as DaemonEnvelope<T>;
  } catch {
    return {
      success: false,
      error: { message: `Alembic daemon returned non-JSON HTTP ${response.status}` },
    };
  }
}
