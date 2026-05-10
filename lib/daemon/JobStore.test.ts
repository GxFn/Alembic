import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { daemonJobsPath, JsonDaemonJobStore } from "./JobStore.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("JSON daemon job store", () => {
  it("creates, gets, and lists persisted jobs", async () => {
    const root = await makeTempRoot();
    const store = new JsonDaemonJobStore(root);

    const bootstrap = await store.create({ kind: "bootstrap", input: { force: true } });
    const rescan = await store.create({ kind: "rescan" });
    const restored = new JsonDaemonJobStore(root);

    await expect(restored.get(bootstrap.id)).resolves.toMatchObject({
      id: bootstrap.id,
      kind: "bootstrap",
      status: "queued",
      input: { force: true },
      progress: { phase: "queued", percent: 0 },
    });
    await expect(restored.list()).resolves.toMatchObject([{ id: bootstrap.id }, { id: rescan.id }]);
  });

  it("persists progress and parses older jobs without progress", async () => {
    const root = await makeTempRoot();
    const store = new JsonDaemonJobStore(root);
    const job = await store.create({ kind: "bootstrap" });

    const updated = await store.update(job.id, {
      progress: {
        phase: "compile:running",
        message: "Scanning workspace.",
        percent: 45,
        steps: [{ phase: "scan", status: "completed", message: "2 files", percent: 100 }],
      },
    });
    const restored = await new JsonDaemonJobStore(root).get(job.id);

    expect(updated.progress).toMatchObject({
      phase: "compile:running",
      message: "Scanning workspace.",
      percent: 45,
      steps: [{ phase: "scan", status: "completed", message: "2 files", percent: 100 }],
      updatedAt: expect.any(String),
    });
    expect(restored?.progress).toEqual(updated.progress);

    const legacyRoot = await makeTempRoot();
    const legacyFile = daemonJobsPath(legacyRoot);
    await fs.mkdir(path.dirname(legacyFile), { recursive: true });
    await fs.writeFile(
      legacyFile,
      `${JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "legacy_bootstrap",
              kind: "bootstrap",
              status: "queued",
              createdAt: "2026-05-10T00:00:00.000Z",
              updatedAt: "2026-05-10T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const legacyJob = await new JsonDaemonJobStore(legacyRoot).get("legacy_bootstrap");
    expect(legacyJob?.progress).toBeUndefined();
  });

  it("updates and cancels active jobs", async () => {
    const root = await makeTempRoot();
    const store = new JsonDaemonJobStore(root);
    const job = await store.create({ kind: "bootstrap" });

    await store.update(job.id, {
      status: "running",
      startedAt: "2026-05-10T00:00:00.000Z",
    });
    const cancelled = await store.cancel(job.id);

    expect(cancelled).toMatchObject({
      id: job.id,
      status: "cancelled",
      startedAt: "2026-05-10T00:00:00.000Z",
      progress: { phase: "cancelled", message: "Job cancelled." },
    });
    expect(cancelled.cancelledAt).toEqual(expect.any(String));
  });

  it("marks queued and running jobs interrupted after daemon restart", async () => {
    const root = await makeTempRoot();
    const store = new JsonDaemonJobStore(root);
    const queued = await store.create({ kind: "bootstrap" });
    const running = await store.create({ kind: "rescan" });
    const completed = await store.create({ kind: "rescan" });

    await store.update(running.id, { status: "running" });
    await store.update(completed.id, {
      status: "completed",
      completedAt: "2026-05-10T00:00:00.000Z",
    });

    const interrupted = await store.markInterrupted();
    const jobs = await store.list();
    const completedAfterRestart = jobs.find((job) => job.id === completed.id);

    expect(interrupted.map((job) => job.id).sort()).toEqual([queued.id, running.id].sort());
    expect(jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: queued.id,
          status: "failed",
          error: expect.objectContaining({ code: "DAEMON_RESTARTED" }),
          progress: expect.objectContaining({ phase: "failed" }),
        }),
        expect.objectContaining({
          id: running.id,
          status: "failed",
          error: expect.objectContaining({ code: "DAEMON_RESTARTED" }),
          progress: expect.objectContaining({ phase: "failed" }),
        }),
        expect.objectContaining({
          id: completed.id,
          status: "completed",
        }),
      ]),
    );
    expect(completedAfterRestart?.error).toBeUndefined();
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-daemon-jobs-"));
  tempRoots.push(root);
  return root;
}
