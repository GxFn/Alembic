import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MainlineAtomicFileStore } from "./AtomicFileStore.js";
import { MainlineConcurrencyLimiter } from "./Concurrency.js";
import { MainlineDirectoryLock } from "./DirectoryLock.js";
import { MainlineTimeoutError } from "./Errors.js";
import { MainlineEventBus } from "./EventBus.js";
import {
  normalizeMainlinePosixPath,
  toMainlineProjectRelativePath,
  uniqueMainlinePosixPaths,
} from "./PathIdentity.js";
import { MainlinePathScope } from "./PathScope.js";
import { MainlineWorkspacePaths } from "./WorkspacePaths.js";
import { MainlineWriteBoundary, MainlineWriteBoundaryError } from "./WriteBoundary.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("mainline core path primitives", () => {
  it("normalizes project-relative path identity without accepting empty or escaping paths", async () => {
    const root = await makeTempRoot();

    expect(normalizeMainlinePosixPath(" ./src\\core/../core/index.ts ")).toBe("src/core/index.ts");
    expect(toMainlineProjectRelativePath(root, path.join(root, "src", "index.ts"))).toBe(
      "src/index.ts",
    );
    expect(uniqueMainlinePosixPaths(["src\\a.ts", "./src/a.ts", "", "src/b.ts"])).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("keeps path scope checks segment-aware", async () => {
    const root = await makeTempRoot();
    const scope = new MainlinePathScope(path.join(root, "app"));

    expect(scope.contains(path.join(root, "app", "nested"))).toBe(true);
    expect(scope.contains(path.join(root, "app2"))).toBe(false);
    expect(scope.resolve("nested/file.txt")).toBe(path.join(root, "app", "nested", "file.txt"));
    expect(() => scope.resolve("../escape.txt")).toThrow(MainlineWriteBoundaryError);
  });
});

describe("mainline write boundary", () => {
  it("separates project, data, runtime, knowledge, and global zones", async () => {
    const root = await makeTempRoot();
    const workspacePaths = new MainlineWorkspacePaths({
      projectRoot: path.join(root, "project"),
      dataRoot: path.join(root, "ghost-data"),
    });
    const boundary = new MainlineWriteBoundary({
      workspacePaths,
      globalRoot: path.join(root, "global"),
    });

    expect(boundary.project(".vscode/settings.json")).toMatchObject({
      zone: "project",
      relative: path.join(".vscode", "settings.json"),
    });
    expect(boundary.data("cache/state.json").absolute).toBe(
      path.join(root, "ghost-data", "cache", "state.json"),
    );
    expect(boundary.runtime("locks/main.lock").absolute).toBe(
      path.join(root, "ghost-data", ".asd", "locks", "main.lock"),
    );
    expect(boundary.knowledge("recipes/a.md").absolute).toBe(
      path.join(root, "ghost-data", "Alembic", "recipes", "a.md"),
    );
    expect(boundary.global("settings.json").absolute).toBe(
      path.join(root, "global", ".asd", "settings.json"),
    );
  });

  it("rejects project writes outside generated/config allowlist and path escapes", async () => {
    const root = await makeTempRoot();
    const boundary = new MainlineWriteBoundary({
      workspacePaths: new MainlineWorkspacePaths({ projectRoot: root }),
    });

    expect(() => boundary.project("src/index.ts")).toThrow(MainlineWriteBoundaryError);
    expect(() => boundary.project("../outside.txt")).toThrow(MainlineWriteBoundaryError);
    expect(() => boundary.data("/absolute.txt")).toThrow(MainlineWriteBoundaryError);
  });
});

describe("mainline atomic file store and directory lock", () => {
  it("writes JSON atomically and appends bounded JSONL records", async () => {
    const root = await makeTempRoot();
    const boundary = new MainlineWriteBoundary({
      workspacePaths: new MainlineWorkspacePaths({ projectRoot: root }),
    });
    const store = new MainlineAtomicFileStore();
    const stateFile = boundary.data("state/current.json");
    const logFile = boundary.data("events/events.jsonl");

    await store.writeJsonAtomic(stateFile, { ok: true, count: 1 });
    await store.appendJsonl(logFile, { id: 1 });
    await store.appendJsonl(logFile, { id: 2 });
    await store.appendJsonl(logFile, { id: 3 });

    await expect(store.readJson<{ ok: boolean; count: number }>(stateFile)).resolves.toEqual({
      ok: true,
      count: 1,
    });
    await expect(store.readJsonl<{ id: number }>(logFile, { limit: 2 })).resolves.toEqual([
      { id: 2 },
      { id: 3 },
    ]);
    await expect(fs.readdir(path.dirname(stateFile.absolute))).resolves.toEqual(["current.json"]);
  });

  it("times out on a held directory lock and releases after withLock", async () => {
    const root = await makeTempRoot();
    const lock = new MainlineDirectoryLock();
    const lockDir = path.join(root, ".asd", "locks", "compile.lock");
    const held = await lock.acquire(lockDir, { waitMs: 20, pollMs: 1, owner: { test: true } });

    await expect(lock.acquire(lockDir, { waitMs: 20, pollMs: 1 })).rejects.toBeInstanceOf(
      MainlineTimeoutError,
    );
    await held.release();

    await expect(
      lock.withLock(lockDir, { waitMs: 20, pollMs: 1 }, async () => "released"),
    ).resolves.toBe("released");
    await expect(fs.stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("mainline in-memory coordination primitives", () => {
  it("limits active tasks and drains the queue", async () => {
    const limiter = new MainlineConcurrencyLimiter(2);
    let active = 0;
    let maxActive = 0;

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        limiter.run(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(5);
          active -= 1;
          return index;
        }),
      ),
    );

    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(limiter.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it("supports exact, multi-type, wildcard, unsubscribe, and history cloning", async () => {
    const bus = new MainlineEventBus({ historyLimit: 2 });
    const received: string[] = [];
    const unsubscribe = bus.subscribe("alpha|beta", (event) => {
      received.push(`multi:${event.type}`);
    });
    bus.subscribe("*", (event) => {
      received.push(`wild:${event.type}`);
    });

    bus.send("alpha", "test", { value: 1 });
    unsubscribe();
    await bus.emitAsync({
      type: "beta",
      source: "test",
      payload: { value: 2 },
      timestamp: 2,
    });
    bus.send("gamma", "test", { value: 3 }, { timestamp: 3 });

    const history = bus.history(10);
    history[0].payload.value = "mutated";

    expect(received).toEqual(["multi:alpha", "wild:alpha", "wild:beta", "wild:gamma"]);
    expect(bus.history(10).map((event) => event.payload.value)).toEqual([2, 3]);
    expect(bus.snapshot()).toMatchObject({ emitCount: 3, historySize: 2 });
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-mainline-core-"));
  tempRoots.push(root);
  return root;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
