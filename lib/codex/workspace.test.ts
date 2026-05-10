import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { initializeCodexWorkspace, inspectWorkspace } from "./workspace.js";

let home: string;
let projectRoot: string;
let previousHome: string | undefined;
let previousAlembicHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "alembic-home-"));
  projectRoot = mkdtempSync(join(tmpdir(), "alembic-project-"));
  previousHome = process.env.HOME;
  previousAlembicHome = process.env.ALEMBIC_HOME;
  process.env.HOME = home;
  delete process.env.ALEMBIC_HOME;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  if (previousAlembicHome === undefined) {
    delete process.env.ALEMBIC_HOME;
  } else {
    process.env.ALEMBIC_HOME = previousAlembicHome;
  }
  rmSync(home, { force: true, recursive: true });
  rmSync(projectRoot, { force: true, recursive: true });
});

test("initializes Ghost workspace without project-local artifacts", () => {
  const workspace = initializeCodexWorkspace({ projectRoot });

  expect(workspace.ghost).toBe(true);
  expect(workspace.initialized).toBe(true);
  expect(workspace.dataRoot).not.toBe(projectRoot);
  expect(existsSync(workspace.runtimeDir)).toBe(true);
  expect(existsSync(workspace.recipesDir)).toBe(true);
  expect(existsSync(join(projectRoot, ".asd"))).toBe(false);
  expect(existsSync(join(projectRoot, "Alembic"))).toBe(false);
  expect(existsSync(join(projectRoot, ".cursor"))).toBe(false);
  expect(existsSync(join(projectRoot, ".vscode", "mcp.json"))).toBe(false);
});

test("status inspects an uninitialized project without creating files", () => {
  const workspace = inspectWorkspace(projectRoot);

  expect(workspace.initialized).toBe(false);
  expect(workspace.registered).toBe(false);
  expect(existsSync(join(projectRoot, ".asd"))).toBe(false);
  expect(existsSync(join(projectRoot, "Alembic"))).toBe(false);
});
