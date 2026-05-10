import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MainlineWorkflowEntrypoint } from "../workflows/mainline/MainlineWorkflowEntrypoint.js";
import { createMainlineWorkflowPersistence } from "../workflows/mainline/MainlineWorkflowPersistence.js";
import { runCodexPrime } from "./prime.js";

const tempRoots: string[] = [];

let previousProjectDir: string | undefined;

beforeEach(() => {
  previousProjectDir = process.env.ALEMBIC_PROJECT_DIR;
});

afterEach(async () => {
  if (previousProjectDir === undefined) {
    delete process.env.ALEMBIC_PROJECT_DIR;
  } else {
    process.env.ALEMBIC_PROJECT_DIR = previousProjectDir;
  }
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })),
  );
});

describe("runCodexPrime", () => {
  it("reads dataRoot runtime snapshots produced by bootstrap without scanning Markdown", async () => {
    const projectRoot = await makeFixtureProject();
    process.env.ALEMBIC_PROJECT_DIR = projectRoot;

    const persistence = await createMainlineWorkflowPersistence({
      projectRoot,
      dataRoot: projectRoot,
    });
    const bootstrap = await new MainlineWorkflowEntrypoint(persistence.dependencies).run({
      kind: "bootstrap",
      projectRoot,
    });

    expect(bootstrap.status).toBe("completed");

    const result = await runCodexPrime({
      task: "find app entrypoint",
      files: ["src/app.ts", 42, "", "src/app.ts"],
      symbols: ["app"],
      diagnostics: [{ message: "example diagnostic", file: "src/app.ts", line: 1 }],
      limit: 5,
    });

    expect(result.status).toBe("completed");
    expect(result.projectRoot).toBe(projectRoot);
    expect(result.dataRoot).toBe(projectRoot);
    expect(result.searchHitCount).toBeGreaterThan(0);
    expect(result.activeContext).toMatchObject({
      taskText: "find app entrypoint",
      files: ["src/app.ts"],
      symbols: ["app"],
      errorCount: 1,
    });
  });

  it("returns a readable uninitialized status without creating runtime data", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-prime-empty-"));
    tempRoots.push(projectRoot);
    process.env.ALEMBIC_PROJECT_DIR = projectRoot;

    const result = await runCodexPrime({ task: "anything" });

    expect(result.status).toBe("uninitialized");
    expect(result.message).toContain("not initialized");
    expect(result.markdown).toBe("");
    await expect(fs.stat(path.join(projectRoot, ".asd"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

async function makeFixtureProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "alembic-prime-"));
  tempRoots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "Alembic"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "app.ts"),
    ['import { helper } from "./util";', "export function app() { return helper(); }", ""].join(
      "\n",
    ),
  );
  await fs.writeFile(path.join(root, "src", "util.ts"), "export function helper() { return 1; }\n");
  await fs.writeFile(path.join(root, "README.md"), "# Markdown should not be scanned by prime\n");
  return root;
}
