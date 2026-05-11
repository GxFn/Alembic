import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EngineeringPathGuard, EngineeringPathGuardError } from "./path-guard.js";
import { EngineeringProjectRegistry } from "./project-registry.js";
import { EngineeringWorkspaceResolver } from "./resolver.js";

describe("engineering workspace migration", () => {
  it("inspects, registers, lists, and unregisters standard projects through a pure file registry", () => {
    const { projectRoot, registry } = createWorkspaceFixture();

    const initialInspection = registry.inspect(projectRoot);
    expect(initialInspection).toMatchObject({
      registered: false,
      ghost: false,
      mode: "standard",
      dataRoot: projectRoot,
      dataRootSource: "project-root",
    });

    const entry = registry.register(projectRoot, { ghost: false });
    expect(entry).toEqual({
      id: registry.projectId(projectRoot),
      ghost: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const registeredInspection = registry.inspect(projectRoot);
    expect(registeredInspection).toMatchObject({
      registered: true,
      projectId: entry.id,
      ghost: false,
      dataRoot: projectRoot,
      workspaceExists: true,
    });
    expect(registry.list()).toEqual([{ projectRoot: registeredInspection.projectRealpath, entry }]);

    expect(registry.unregister(projectRoot)).toBe(true);
    expect(registry.unregister(projectRoot)).toBe(false);
    expect(registry.inspect(projectRoot).registered).toBe(false);
  });

  it("resolves ghost workspaces and emits WorkspaceFacts with dataRoot paths", () => {
    const { projectRoot, registry } = createWorkspaceFixture();
    const entry = registry.register(projectRoot, { ghost: true });
    const ghostDataRoot = registry.ghostWorkspacePath(entry.id);
    fs.mkdirSync(ghostDataRoot, { recursive: true });

    const resolver = EngineeringWorkspaceResolver.fromProject(projectRoot, { registry });
    const facts = resolver.toFacts();

    expect(facts).toMatchObject({
      targetProjectRoot: projectRoot,
      registered: true,
      mode: "ghost",
      ghost: true,
      projectId: entry.id,
      dataRoot: ghostDataRoot,
      dataRootSource: "ghost-registry",
      workspaceExists: true,
      runtimeDir: path.join(ghostDataRoot, ".asd"),
      databasePath: path.join(ghostDataRoot, ".asd", "alembic.db"),
      knowledgeBaseDir: "Alembic",
      knowledgeDir: path.join(ghostDataRoot, "Alembic"),
      recipesDir: path.join(ghostDataRoot, "Alembic", "recipes"),
      skillsDir: path.join(ghostDataRoot, "Alembic", "skills"),
      candidatesDir: path.join(ghostDataRoot, "Alembic", "candidates"),
      wikiDir: path.join(ghostDataRoot, "Alembic", "wiki"),
    });
    expect(facts.ghostMarker).toEqual({
      kind: "project-registry",
      registryPath: registry.registryPath,
      projectRoot: facts.projectRealpath,
      projectId: entry.id,
    });
  });

  it("keeps standard WorkspaceFacts on projectRoot and detects custom knowledge roots", () => {
    const { projectRoot, registry } = createWorkspaceFixture();
    fs.mkdirSync(path.join(projectRoot, "Knowledge"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "Knowledge", "Alembic.boxspec.json"), "{}\n");

    const resolver = EngineeringWorkspaceResolver.fromProject(projectRoot, { registry });
    const facts = resolver.toFacts();

    expect(facts).toMatchObject({
      mode: "standard",
      ghost: false,
      projectId: null,
      dataRoot: projectRoot,
      dataRootSource: "project-root",
      runtimeDir: path.join(projectRoot, ".asd"),
      knowledgeBaseDir: "Knowledge",
      knowledgeDir: path.join(projectRoot, "Knowledge"),
      recipesDir: path.join(projectRoot, "Knowledge", "recipes"),
    });
  });

  it("guards project writes while allowing ghost dataRoot through explicit allow paths", () => {
    const { projectRoot, registry } = createWorkspaceFixture();
    const ghostDataRoot = registry.ghostWorkspacePath(registry.projectId(projectRoot));
    const guard = new EngineeringPathGuard({
      projectRoot,
      extraAllowPaths: [ghostDataRoot],
    });

    expect(() => guard.assertSafe(path.join(projectRoot, "src", "App.ts"))).not.toThrow();
    expect(() =>
      guard.assertProjectWriteSafe(path.join(projectRoot, ".asd", "alembic.db")),
    ).not.toThrow();
    expect(() =>
      guard.assertProjectWriteSafe(path.join(projectRoot, "Alembic", "recipes", "index.json")),
    ).not.toThrow();
    expect(() =>
      guard.assertProjectWriteSafe(path.join(ghostDataRoot, ".asd", "alembic.db")),
    ).not.toThrow();
    expect(() =>
      guard.assertProjectWriteSafe(path.join(projectRoot, "src", "generated.ts")),
    ).toThrow(EngineeringPathGuardError);
    expect(() => guard.assertSafe(path.join(path.dirname(projectRoot), "outside.txt"))).toThrow(
      EngineeringPathGuardError,
    );
  });

  it("blocks runtime and knowledge writes in excluded projects but keeps IDE scopes open", () => {
    const { projectRoot } = createWorkspaceFixture();
    fs.writeFileSync(path.join(projectRoot, ".asd-skip"), "\n");

    const guard = new EngineeringPathGuard({ projectRoot });

    expect(guard.excludedProject).toEqual({
      excluded: true,
      reason: "项目包含 .asd-skip 标记",
    });
    expect(() =>
      guard.assertProjectWriteSafe(path.join(projectRoot, ".asd", "alembic.db")),
    ).toThrow(/排除项目保护/);
    expect(() =>
      guard.assertProjectWriteSafe(path.join(projectRoot, "Alembic", "recipes", "index.json")),
    ).toThrow(/排除项目保护/);
    expect(() =>
      guard.assertProjectWriteSafe(path.join(projectRoot, ".cursor", "rules", "alembic.mdc")),
    ).not.toThrow();
    expect(() => guard.assertProjectWriteSafe(path.join(projectRoot, ".gitignore"))).not.toThrow();
  });
});

function createWorkspaceFixture(): {
  readonly projectRoot: string;
  readonly registry: EngineeringProjectRegistry;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "alembic-engineering-workspace-"));
  const projectRoot = path.join(root, "project");
  const homeDir = path.join(root, "home");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  return {
    projectRoot,
    registry: new EngineeringProjectRegistry({
      homeDir,
      now: () => "2026-01-01T00:00:00.000Z",
    }),
  };
}
