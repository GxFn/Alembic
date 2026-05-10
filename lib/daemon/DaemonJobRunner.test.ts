import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonJobRunner } from "./DaemonJobRunner.js";
import { JsonDaemonJobStore } from "./JobStore.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("daemon job runner", () => {
  it("runs queued jobs through the registered workflow handler", async () => {
    const root = await makeTempRoot();
    const store = new JsonDaemonJobStore(root);
    const runner = new DaemonJobRunner(store, {
      handlers: {
        bootstrap: async (job) => {
          expect(job.progress).toMatchObject({ phase: "running", percent: 5 });

          return {
            kind: job.kind,
            filesScanned: 2,
          };
        },
      },
    });

    const queued = await runner.enqueue({ kind: "bootstrap", input: { force: true } });
    const completed = await runner.run(queued.id);

    expect(completed).toMatchObject({
      id: queued.id,
      status: "completed",
      result: { kind: "bootstrap", filesScanned: 2 },
      progress: { phase: "completed", percent: 100 },
    });
    expect(completed.startedAt).toEqual(expect.any(String));
    expect(completed.completedAt).toEqual(expect.any(String));
  });

  it("lets handlers report progress and preserves progress steps on completion", async () => {
    const root = await makeTempRoot();
    const store = new JsonDaemonJobStore(root);
    const runner = new DaemonJobRunner(store, {
      handlers: {
        bootstrap: async (_job, context) => {
          await context.reportProgress({
            phase: "compile:running",
            message: "Compiling workspace.",
            percent: 50,
            steps: [{ phase: "scan", status: "completed", message: "2 files", percent: 100 }],
          });

          return { ok: true };
        },
      },
    });

    const queued = await runner.enqueue({ kind: "bootstrap" });
    const completed = await runner.run(queued.id);
    const persisted = await store.get(queued.id);

    expect(completed).toMatchObject({
      status: "completed",
      progress: {
        phase: "completed",
        percent: 100,
        steps: [{ phase: "scan", status: "completed", message: "2 files", percent: 100 }],
      },
    });
    expect(persisted?.progress).toEqual(completed.progress);
  });

  it("does not overwrite cancellation with completion", async () => {
    const root = await makeTempRoot();
    const store = new JsonDaemonJobStore(root);
    const runner = new DaemonJobRunner(store, {
      handlers: {
        rescan: async (job, context) => {
          await store.cancel(job.id);
          await context.reportProgress({ phase: "compile:running", percent: 80 });
          return { ignored: true };
        },
      },
    });

    const queued = await runner.enqueue({ kind: "rescan" });
    const cancelled = await runner.run(queued.id);

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.progress).toMatchObject({ phase: "cancelled", message: "Job cancelled." });
    expect(cancelled.result).toBeUndefined();
  });

  it("marks progress failed when a workflow handler throws", async () => {
    const root = await makeTempRoot();
    const runner = new DaemonJobRunner(new JsonDaemonJobStore(root), {
      handlers: {
        bootstrap: async () => {
          throw new Error("compile exploded");
        },
      },
    });
    const queued = await runner.enqueue({ kind: "bootstrap" });

    const failed = await runner.run(queued.id);

    expect(failed).toMatchObject({
      status: "failed",
      error: { code: "WORKFLOW_FAILED", message: "compile exploded" },
      progress: { phase: "failed", message: "compile exploded" },
    });
  });

  it("fails jobs without a registered handler when explicitly run", async () => {
    const root = await makeTempRoot();
    const runner = new DaemonJobRunner(new JsonDaemonJobStore(root));
    const queued = await runner.enqueue({ kind: "bootstrap" });

    const failed = await runner.run(queued.id);

    expect(failed).toMatchObject({
      status: "failed",
      error: { code: "WORKFLOW_HANDLER_UNAVAILABLE" },
      progress: { phase: "failed" },
    });
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-daemon-runner-"));
  tempRoots.push(root);
  return root;
}
