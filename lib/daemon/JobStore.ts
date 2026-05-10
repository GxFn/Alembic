import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { daemonStateDirectory } from "./DaemonState.js";

export type DaemonJobKind = "bootstrap" | "rescan";
export type DaemonJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface DaemonJobError {
  code: string;
  message: string;
}

export interface DaemonJobProgressStep {
  phase: string;
  status?: string;
  message?: string;
  percent?: number;
}

// 中文注释：progress 只服务 daemon/job 可观测性，不决定业务流程或编译结果。
export interface DaemonJobProgress {
  phase: string;
  message?: string;
  percent?: number;
  steps?: DaemonJobProgressStep[];
  updatedAt: string;
}

export type DaemonJobProgressInput = Omit<DaemonJobProgress, "updatedAt"> & {
  updatedAt?: string;
};

export interface DaemonJob {
  id: string;
  kind: DaemonJobKind;
  status: DaemonJobStatus;
  input?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: DaemonJobError;
  progress?: DaemonJobProgress;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
}

export interface CreateDaemonJobInput {
  kind: DaemonJobKind;
  input?: Record<string, unknown>;
}

export interface UpdateDaemonJobInput {
  status?: DaemonJobStatus;
  input?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: DaemonJobError;
  progress?: DaemonJobProgressInput;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
}

interface DaemonJobFile {
  version: 1;
  jobs: DaemonJob[];
}

const daemonJobsFileName = "jobs.json";
const interruptedErrorCode = "DAEMON_RESTARTED";

export function daemonJobsPath(dataRoot: string): string {
  return path.join(daemonStateDirectory(dataRoot), daemonJobsFileName);
}

export class JsonDaemonJobStore {
  readonly filePath: string;

  constructor(readonly dataRoot: string) {
    this.filePath = daemonJobsPath(dataRoot);
  }

  async create(input: CreateDaemonJobInput): Promise<DaemonJob> {
    const file = await this.readFile();
    const now = new Date().toISOString();
    const job: DaemonJob = {
      id: createJobId(input.kind),
      kind: input.kind,
      status: "queued",
      progress: normalizeJobProgress({
        phase: "queued",
        message: `${input.kind} job queued.`,
        percent: 0,
        updatedAt: now,
      }),
      createdAt: now,
      updatedAt: now,
      ...(input.input === undefined ? {} : { input: input.input }),
    };

    file.jobs.push(job);
    await this.writeFile(file);

    return job;
  }

  async get(id: string): Promise<DaemonJob | undefined> {
    const file = await this.readFile();
    return file.jobs.find((job) => job.id === id);
  }

  async list(): Promise<DaemonJob[]> {
    const file = await this.readFile();
    return [...file.jobs].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async update(id: string, input: UpdateDaemonJobInput): Promise<DaemonJob> {
    const file = await this.readFile();
    const index = file.jobs.findIndex((job) => job.id === id);

    if (index === -1) {
      throw new Error(`Daemon job not found: ${id}`);
    }

    const current = file.jobs[index];
    if (current === undefined) {
      throw new Error(`Daemon job not found: ${id}`);
    }

    const update = withoutProgress(withoutUndefined(input));
    const updated: DaemonJob = {
      ...current,
      ...update,
      ...(input.progress === undefined ? {} : { progress: normalizeJobProgress(input.progress) }),
      updatedAt: new Date().toISOString(),
    };

    file.jobs[index] = updated;
    await this.writeFile(file);

    return updated;
  }

  async cancel(id: string): Promise<DaemonJob> {
    const job = await this.getRequired(id);

    if (isTerminal(job.status)) {
      return job;
    }

    return this.update(id, {
      status: "cancelled",
      cancelledAt: new Date().toISOString(),
      progress: terminalProgress("cancelled", "Job cancelled.", job.progress),
    });
  }

  async markInterrupted(): Promise<DaemonJob[]> {
    const file = await this.readFile();
    const now = new Date().toISOString();
    let changed = false;

    const jobs = file.jobs.map((job) => {
      if (job.status !== "queued" && job.status !== "running") {
        return job;
      }

      changed = true;

      return {
        ...job,
        status: "failed" as const,
        updatedAt: now,
        completedAt: now,
        error: {
          code: interruptedErrorCode,
          message: "Daemon restarted before the job finished.",
        },
        progress: normalizeJobProgress(
          terminalProgress(
            "failed",
            "Daemon restarted before the job finished.",
            job.progress,
            now,
          ),
          now,
        ),
      };
    });

    if (changed) {
      await this.writeFile({ ...file, jobs });
    }

    return jobs.filter((job) => job.error?.code === interruptedErrorCode && job.updatedAt === now);
  }

  private async getRequired(id: string): Promise<DaemonJob> {
    const job = await this.get(id);

    if (job === undefined) {
      throw new Error(`Daemon job not found: ${id}`);
    }

    return job;
  }

  private async readFile(): Promise<DaemonJobFile> {
    let raw: string;

    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, jobs: [] };
      }

      throw error;
    }

    return parseJobFile(JSON.parse(raw));
  }

  private async writeFile(file: DaemonJobFile): Promise<void> {
    // Jobs 是 daemon/job 的持久边界：重启后只能从这里恢复队列、失败和取消状态。
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(parseJobFile(file), null, 2)}\n`, "utf8");
  }
}

export const JobStore = JsonDaemonJobStore;

function parseJobFile(value: unknown): DaemonJobFile {
  assertRecord(value, "daemon job file");

  if (value.version !== 1) {
    throw new Error("Invalid daemon job file: expected version 1");
  }

  const jobs = value.jobs;
  if (!Array.isArray(jobs)) {
    throw new Error("Invalid daemon job file: expected jobs array");
  }

  return {
    version: 1,
    jobs: jobs.map(parseJob),
  };
}

function parseJob(value: unknown): DaemonJob {
  assertRecord(value, "daemon job");

  const input = optionalRecord(value.input, "input");
  const result = optionalRecord(value.result, "result");
  const error = optionalJobError(value.error);
  const progress = optionalJobProgress(value.progress);

  return {
    id: requireString(value, "id"),
    kind: requireJobKind(value.kind),
    status: requireJobStatus(value.status),
    createdAt: requireString(value, "createdAt"),
    updatedAt: requireString(value, "updatedAt"),
    ...(input === undefined ? {} : { input }),
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
    ...(progress === undefined ? {} : { progress }),
    ...optionalStringField(value, "startedAt"),
    ...optionalStringField(value, "completedAt"),
    ...optionalStringField(value, "cancelledAt"),
  };
}

function optionalJobError(value: unknown): DaemonJobError | undefined {
  if (value === undefined) {
    return undefined;
  }

  assertRecord(value, "daemon job error");

  return {
    code: requireString(value, "code"),
    message: requireString(value, "message"),
  };
}

function optionalJobProgress(value: unknown): DaemonJobProgress | undefined {
  if (value === undefined) {
    return undefined;
  }

  assertRecord(value, "daemon job progress");

  return normalizeJobProgress({
    phase: requireString(value, "phase"),
    ...optionalNonEmptyStringField(value, "message"),
    ...optionalPercentField(value, "percent"),
    ...optionalProgressStepsField(value),
    updatedAt: requireString(value, "updatedAt"),
  });
}

function requireJobKind(value: unknown): DaemonJobKind {
  if (value === "bootstrap" || value === "rescan") {
    return value;
  }

  throw new Error("Invalid daemon job: expected kind bootstrap or rescan");
}

function requireJobStatus(value: unknown): DaemonJobStatus {
  if (
    value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }

  throw new Error("Invalid daemon job: unexpected status");
}

function optionalRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  assertRecord(value, `daemon job ${key}`);

  return value;
}

function optionalStringField(value: Record<string, unknown>, key: string): Record<string, string> {
  const field = value[key];

  if (field === undefined) {
    return {};
  }

  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Invalid daemon job: expected non-empty string field "${key}"`);
  }

  return { [key]: field };
}

function optionalNonEmptyStringField(
  value: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const field = value[key];

  if (field === undefined) {
    return {};
  }

  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Invalid daemon job: expected non-empty string field "${key}"`);
  }

  return { [key]: field };
}

function optionalPercentField(value: Record<string, unknown>, key: string): Record<string, number> {
  const field = value[key];

  if (field === undefined) {
    return {};
  }

  return { [key]: requirePercent(field, key) };
}

function optionalProgressStepsField(
  value: Record<string, unknown>,
): Partial<Record<"steps", DaemonJobProgressStep[]>> {
  const steps = value.steps;

  if (steps === undefined) {
    return {};
  }

  if (!Array.isArray(steps)) {
    throw new Error("Invalid daemon job progress: expected steps array");
  }

  return { steps: steps.map(parseProgressStep) };
}

function parseProgressStep(value: unknown): DaemonJobProgressStep {
  assertRecord(value, "daemon job progress step");

  return {
    phase: requireString(value, "phase"),
    ...optionalNonEmptyStringField(value, "status"),
    ...optionalNonEmptyStringField(value, "message"),
    ...optionalPercentField(value, "percent"),
  };
}

function normalizeJobProgress(
  progress: DaemonJobProgressInput,
  updatedAt = new Date().toISOString(),
): DaemonJobProgress {
  return {
    phase: requireNonEmptyString(progress.phase, "progress.phase"),
    ...(progress.message === undefined
      ? {}
      : { message: requireNonEmptyString(progress.message, "progress.message") }),
    ...(progress.percent === undefined
      ? {}
      : { percent: requirePercent(progress.percent, "percent") }),
    ...(progress.steps === undefined ? {} : { steps: progress.steps.map(normalizeProgressStep) }),
    updatedAt: progress.updatedAt ?? updatedAt,
  };
}

function normalizeProgressStep(step: DaemonJobProgressStep): DaemonJobProgressStep {
  return {
    phase: requireNonEmptyString(step.phase, "progress step phase"),
    ...(step.status === undefined
      ? {}
      : { status: requireNonEmptyString(step.status, "progress step status") }),
    ...(step.message === undefined
      ? {}
      : { message: requireNonEmptyString(step.message, "progress step message") }),
    ...(step.percent === undefined
      ? {}
      : { percent: requirePercent(step.percent, "step percent") }),
  };
}

function terminalProgress(
  phase: "failed" | "cancelled",
  message: string,
  current: DaemonJobProgress | undefined,
  updatedAt?: string,
): DaemonJobProgressInput {
  return {
    phase,
    message,
    ...(current?.percent === undefined ? {} : { percent: current.percent }),
    ...(current?.steps === undefined ? {} : { steps: current.steps }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

function withoutUndefined(input: UpdateDaemonJobInput): UpdateDaemonJobInput {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as UpdateDaemonJobInput;
}

function withoutProgress(input: UpdateDaemonJobInput): Omit<UpdateDaemonJobInput, "progress"> {
  const { progress, ...rest } = input;
  void progress;
  return rest;
}

function isTerminal(status: DaemonJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function createJobId(kind: DaemonJobKind): string {
  return `${kind}_${Date.now().toString(36)}_${randomUUID()}`;
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
}

function requireString(value: Record<string, unknown>, key: string): string {
  const field = value[key];

  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Invalid daemon job: expected non-empty string field "${key}"`);
  }

  return field;
}

function requireNonEmptyString(value: string, label: string): string {
  if (value.length === 0) {
    throw new Error(`Invalid daemon job: expected non-empty string field "${label}"`);
  }

  return value;
}

function requirePercent(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`Invalid daemon job progress: expected ${label} percent between 0 and 100`);
  }

  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
