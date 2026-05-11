import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  handleDaemonHttpBridgeRequest,
  isAuthorizedDaemonRequestHeaders,
} from "./DaemonHttpBridge.js";
import { DaemonJobRunner } from "./DaemonJobRunner.js";
import type { DaemonState } from "./DaemonState.js";
import { JsonDaemonJobStore } from "./JobStore.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("daemon HTTP bridge auth", () => {
  it("accepts the daemon token from the dedicated header or bearer auth", () => {
    expect(
      isAuthorizedDaemonRequestHeaders(
        { "x-alembic-daemon-token": "bridge-token" },
        "bridge-token",
      ),
    ).toBe(true);
    expect(
      isAuthorizedDaemonRequestHeaders({ authorization: "Bearer bridge-token" }, "bridge-token"),
    ).toBe(true);
  });

  it("rejects missing or mismatched daemon tokens", () => {
    expect(isAuthorizedDaemonRequestHeaders({}, "bridge-token")).toBe(false);
    expect(
      isAuthorizedDaemonRequestHeaders({ "x-alembic-daemon-token": "wrong-token" }, "bridge-token"),
    ).toBe(false);
    expect(
      isAuthorizedDaemonRequestHeaders({ authorization: "Bearer wrong-token" }, "bridge-token"),
    ).toBe(false);
  });
});

describe("daemon HTTP bridge job routes", () => {
  it("protects health and job routes with daemon token auth", async () => {
    const context = await makeRouteContext();

    await expect(route(context, "GET", "/api/v1/daemon/health")).resolves.toMatchObject({
      statusCode: 401,
      body: { success: false, error: { message: "Unauthorized daemon request" } },
    });
    await expect(
      route(context, "GET", "/api/v1/daemon/health", auth(context.state)),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: { success: true, data: { projectRoot: context.state.projectRoot, mode: "daemon" } },
    });
  });

  it("enqueues, lists, gets, and cancels bootstrap/rescan jobs through HTTP", async () => {
    const context = await makeRouteContext();

    const bootstrap = await route(context, "POST", "/api/v1/jobs/bootstrap", auth(context.state), {
      force: true,
      agentFill: true,
      maxAgentTasks: 2,
    });
    expect(bootstrap).toMatchObject({
      statusCode: 202,
      body: {
        success: true,
        data: {
          job: {
            kind: "bootstrap",
            status: "queued",
            input: { force: true, agentFill: true, maxAgentTasks: 2 },
            progress: { phase: "queued", percent: 0 },
          },
        },
      },
    });
    const bootstrapId = jobId(bootstrap.body);

    const rescan = await route(context, "POST", "/api/v1/jobs/rescan", auth(context.state), {
      changedFiles: ["src/app.ts"],
      removedFiles: ["src/old.ts"],
      includeEvolution: true,
    });
    expect(rescan).toMatchObject({
      statusCode: 202,
      body: {
        success: true,
        data: {
          job: {
            kind: "rescan",
            status: "queued",
            input: {
              changedFiles: ["src/app.ts"],
              removedFiles: ["src/old.ts"],
              includeEvolution: true,
            },
          },
        },
      },
    });

    await expect(route(context, "GET", "/api/v1/jobs", auth(context.state))).resolves.toMatchObject(
      {
        statusCode: 200,
        body: {
          success: true,
          data: {
            jobs: [
              expect.objectContaining({ id: bootstrapId, kind: "bootstrap", status: "queued" }),
              expect.objectContaining({ kind: "rescan", status: "queued" }),
            ],
          },
        },
      },
    );
    await expect(
      route(context, "GET", `/api/v1/jobs/${bootstrapId}`, auth(context.state)),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: { success: true, data: { job: { id: bootstrapId, kind: "bootstrap" } } },
    });
    await expect(
      route(context, "POST", `/api/v1/jobs/${bootstrapId}/cancel`, auth(context.state)),
    ).resolves.toMatchObject({
      statusCode: 200,
      body: {
        success: true,
        data: { job: { id: bootstrapId, status: "cancelled", progress: { phase: "cancelled" } } },
      },
    });
  });
});

interface RouteContext {
  readonly state: DaemonState;
  readonly jobStore: JsonDaemonJobStore;
  readonly jobRunner: DaemonJobRunner;
}

async function makeState(): Promise<DaemonState> {
  const projectRoot = await makeTempRoot("alembic-daemon-bridge-project-");
  const dataRoot = await makeTempRoot("alembic-daemon-bridge-data-");
  return {
    pid: process.pid,
    port: 0,
    token: "bridge-token",
    projectRoot,
    dataRoot,
    projectId: "bridge-project",
    databasePath: path.join(dataRoot, "alembic.db"),
    version: "0.1.0-test",
    startedAt: "2026-05-11T00:00:00.000Z",
    updatedAt: "2026-05-11T00:00:00.000Z",
  };
}

async function makeRouteContext(): Promise<RouteContext> {
  const state = await makeState();
  const jobStore = new JsonDaemonJobStore(state.dataRoot);
  return {
    state,
    jobStore,
    jobRunner: new DaemonJobRunner(jobStore),
  };
}

function auth(state: DaemonState): Record<string, string> {
  return { "x-alembic-daemon-token": state.token };
}

function route(
  context: RouteContext,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
) {
  return handleDaemonHttpBridgeRequest({
    method,
    path,
    headers,
    ...(body === undefined ? {} : { body }),
    stateProvider: () => context.state,
    jobStore: context.jobStore,
    jobRunner: context.jobRunner,
  });
}

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function jobId(body: unknown): string {
  if (!isRecord(body)) {
    throw new Error("Expected bridge response body.");
  }
  const data = body.data;
  if (!isRecord(data) || !isRecord(data.job) || typeof data.job.id !== "string") {
    throw new Error("Expected bridge response job id.");
  }
  return data.job.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
