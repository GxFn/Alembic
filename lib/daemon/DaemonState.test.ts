import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearDaemonState,
  type DaemonState,
  daemonStateDirectory,
  daemonStatePath,
  readDaemonState,
  writeDaemonState,
} from "./DaemonState.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("daemon state persistence", () => {
  it("builds stable daemon state paths", async () => {
    const root = await makeTempRoot();

    expect(daemonStateDirectory(root)).toBe(path.join(root, ".asd", "daemon"));
    expect(daemonStatePath(root)).toBe(path.join(root, ".asd", "daemon", "state.json"));
  });

  it("writes, reads, and clears daemon state", async () => {
    const root = await makeTempRoot();
    const state: DaemonState = {
      pid: 1234,
      port: 8765,
      token: "token",
      projectRoot: path.join(root, "project"),
      dataRoot: root,
      projectId: "project-id",
      databasePath: path.join(root, "db.sqlite"),
      version: "0.1.0",
      startedAt: "2026-05-10T00:00:00.000Z",
      updatedAt: "2026-05-10T00:00:01.000Z",
    };

    await expect(readDaemonState(root)).resolves.toBeUndefined();

    await writeDaemonState(state);
    await expect(readDaemonState(root)).resolves.toEqual(state);

    await clearDaemonState(root);
    await expect(readDaemonState(root)).resolves.toBeUndefined();
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-daemon-state-"));
  tempRoots.push(root);
  return root;
}
