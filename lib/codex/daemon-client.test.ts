import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonState } from "../daemon/DaemonState.js";
import type { DaemonStatus } from "../daemon/DaemonSupervisor.js";

const supervisorState = vi.hoisted(() => ({
  status: undefined as DaemonStatus | undefined,
  starts: [] as Array<{ projectRoot?: string }>,
  statuses: [] as Array<string | undefined>,
}));

vi.mock("../daemon/DaemonSupervisor.js", () => ({
  DaemonSupervisor: class {
    start(options: { projectRoot?: string } = {}) {
      supervisorState.starts.push(options);
      if (supervisorState.status === undefined) {
        throw new Error("test supervisor status not configured");
      }
      return Promise.resolve(supervisorState.status);
    }

    status(projectRoot?: string) {
      supervisorState.statuses.push(projectRoot);
      if (supervisorState.status === undefined) {
        throw new Error("test supervisor status not configured");
      }
      return Promise.resolve(supervisorState.status);
    }
  },
}));

const tempRoots: string[] = [];

beforeEach(() => {
  supervisorState.status = undefined;
  supervisorState.starts = [];
  supervisorState.statuses = [];
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("Codex daemon HTTP client", () => {
  it("delegates status and ensure to the daemon supervisor", async () => {
    const projectRoot = await makeTempRoot("alembic-codex-project-");
    supervisorState.status = makeStatus({ projectRoot, port: 9_999 });
    const client = await import("./daemon-client.js");

    await expect(client.ensureCodexDaemon(projectRoot)).resolves.toMatchObject({
      ready: true,
      projectRoot,
    });
    await expect(client.getCodexDaemonStatus(projectRoot)).resolves.toMatchObject({
      ready: true,
      projectRoot,
    });
    expect(supervisorState.starts).toEqual([{ projectRoot }]);
    expect(supervisorState.statuses).toEqual([projectRoot]);
  });

  it("enqueues, lists, gets, and cancels jobs through the bridge JSON API", async () => {
    const projectRoot = await makeTempRoot("alembic-codex-project-");
    const dataRoot = await makeTempRoot("alembic-codex-data-");
    const port = 45_123;
    supervisorState.status = makeStatus({ projectRoot, dataRoot, port });
    const job = makeJob("bootstrap_123", "bootstrap");
    const jobWithInput = { ...job, input: { force: true } };
    const fetchMock = stubFetch((url, init) => {
      expect(new Headers(init?.headers).get("x-alembic-daemon-token")).toBe("test-token");
      if (url.endsWith("/api/v1/jobs/bootstrap")) {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBe(JSON.stringify({ force: true }));
        return { data: { job: jobWithInput } };
      }
      if (url.endsWith("/api/v1/jobs/bootstrap_123/cancel")) {
        expect(init?.method).toBe("POST");
        return { data: { job: { ...jobWithInput, status: "cancelled" } } };
      }
      if (url.endsWith("/api/v1/jobs/bootstrap_123")) {
        return { data: { job: jobWithInput } };
      }
      if (url.endsWith("/api/v1/jobs")) {
        return { data: { jobs: [jobWithInput] } };
      }
      return { status: 404, success: false, message: `unexpected url ${url}` };
    });
    const client = await import("./daemon-client.js");

    const enqueued = await client.enqueueCodexDaemonJob("bootstrap", { force: true }, projectRoot);
    const listed = await client.listCodexDaemonJobs(projectRoot);
    const fetched = await client.getCodexDaemonJob(enqueued.id, projectRoot);
    const cancelled = await client.cancelCodexDaemonJob(enqueued.id, projectRoot);

    expect(enqueued).toMatchObject({
      kind: "bootstrap",
      status: "queued",
      input: { force: true },
    });
    expect(listed).toEqual([enqueued]);
    expect(fetched).toEqual(enqueued);
    expect(cancelled).toMatchObject({
      id: enqueued.id,
      status: "cancelled",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      `http://127.0.0.1:${port}/api/v1/jobs/bootstrap`,
      `http://127.0.0.1:${port}/api/v1/jobs`,
      `http://127.0.0.1:${port}/api/v1/jobs/bootstrap_123`,
      `http://127.0.0.1:${port}/api/v1/jobs/bootstrap_123/cancel`,
    ]);
    expect(supervisorState.starts).toHaveLength(4);
  });

  it("fails before HTTP calls when the daemon is not ready", async () => {
    const projectRoot = await makeTempRoot("alembic-codex-project-");
    supervisorState.status = {
      ...makeStatus({ projectRoot, port: 9_999 }),
      ready: false,
      status: "failed",
      state: undefined,
      message: "daemon unavailable",
    };
    const client = await import("./daemon-client.js");

    await expect(client.listCodexDaemonJobs(projectRoot)).rejects.toThrow("daemon unavailable");
  });

  it("surfaces HTTP and unsuccessful envelope errors", async () => {
    const projectRoot = await makeTempRoot("alembic-codex-project-");
    const port = 45_124;
    supervisorState.status = makeStatus({ projectRoot, port });
    stubFetch(() => ({ status: 500, success: false, message: "bridge failed" }));
    const client = await import("./daemon-client.js");

    await expect(client.listCodexDaemonJobs(projectRoot)).rejects.toThrow("bridge failed");
  });

  it("surfaces unsuccessful 2xx envelope errors", async () => {
    const projectRoot = await makeTempRoot("alembic-codex-project-");
    const port = 45_125;
    supervisorState.status = makeStatus({ projectRoot, port });
    stubFetch(() => ({ success: false, message: "job rejected" }));
    const client = await import("./daemon-client.js");

    await expect(client.listCodexDaemonJobs(projectRoot)).rejects.toThrow("job rejected");
  });
});

function makeStatus(options: {
  projectRoot: string;
  dataRoot?: string;
  port: number;
  state?: DaemonState;
}): DaemonStatus {
  const dataRoot = options.dataRoot ?? options.projectRoot;
  const state = options.state ?? makeState({ ...options, dataRoot });
  return {
    status: "ready",
    ready: true,
    projectRoot: options.projectRoot,
    dataRoot,
    state,
    pidAlive: true,
    health: { success: true },
  };
}

function makeState(options: { projectRoot: string; dataRoot: string; port: number }): DaemonState {
  return {
    pid: process.pid,
    port: options.port,
    token: "test-token",
    projectRoot: options.projectRoot,
    dataRoot: options.dataRoot,
    projectId: "test-project",
    databasePath: path.join(options.dataRoot, "alembic.db"),
    version: "0.1.0-test",
    startedAt: "2026-05-10T00:00:00.000Z",
    updatedAt: "2026-05-10T00:00:00.000Z",
  };
}

function makeJob(id: string, kind: "bootstrap" | "rescan") {
  return {
    id,
    kind,
    status: "queued" as const,
    createdAt: "2026-05-10T00:00:00.000Z",
    updatedAt: "2026-05-10T00:00:00.000Z",
  };
}

function stubFetch(
  handler: (
    url: string,
    init: RequestInit | undefined,
  ) => { data?: unknown; message?: string; status?: number; success?: boolean },
) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const result = handler(url, init);
    const status = result.status ?? 200;
    const success = result.success ?? status >= 200;
    return new Response(
      JSON.stringify({
        success,
        ...(result.data === undefined ? {} : { data: result.data }),
        ...(result.message === undefined ? {} : { error: { message: result.message } }),
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
