import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryContextIndex } from "../../mainline/data/index.js";
import { MainlineProjectIntelligenceBuilder } from "../../mainline/graph/index.js";
import { createRecipe, createSourceRef } from "../../mainline/knowledge/index.js";
import { InMemoryMainlineSearchIndex } from "../../mainline/search/index.js";
import { createDefaultToolHandlers, createDefaultToolRegistry, ToolRouter } from "./index.js";
import type { ToolFailureEnvelope, ToolResultEnvelope, ToolSuccessEnvelope } from "./types.js";

const EXPECTED_TOOLS = [
  "code.search",
  "code.read",
  "code.outline",
  "code.structure",
  "code.write",
  "code.guard",
  "terminal.execute",
  "knowledge.search",
  "knowledge.detail",
  "knowledge.submit",
  "knowledge.manage",
  "graph.overview",
  "graph.query",
  "memory.save",
  "memory.recall",
  "memory.note_finding",
  "memory.get_previous_evidence",
  "meta.capabilities",
  "meta.plan",
  "meta.review",
] as const;

describe("new tools registry and router", () => {
  it("registers the internal Agent resource.action surface and rejects unknown tools", async () => {
    const registry = createDefaultToolRegistry();

    expect(registry.list().map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
    expect(registry.get("code.write")?.availability.status).toBe("policy_required");
    expect(registry.get("terminal.execute")?.availability.status).toBe("policy_required");

    const result = await new ToolRouter({ registry }).invoke({ name: "legacy.v2" });
    expectFailure(result);
    expect(result.error.code).toBe("unknown_tool");
  });

  it("has a handler for every registered tool", () => {
    const registry = createDefaultToolRegistry();
    const handlers = createDefaultToolHandlers();

    expect(registry.list().map((tool) => [tool.name, handlers.has(tool.name)])).toEqual(
      EXPECTED_TOOLS.map((tool) => [tool, true]),
    );
  });

  it("reports capabilities from the registry", async () => {
    const result = await new ToolRouter().invoke({ name: "meta.capabilities" });

    expectOk(result);
    const data = result.data as {
      readonly compatibility: string;
      readonly resources: readonly string[];
      readonly tools: ReadonlyArray<{ readonly name: string }>;
    };
    expect(data.compatibility).toBe("no-legacy-v1-v2");
    expect(data.resources).toEqual(["code", "graph", "knowledge", "memory", "meta", "terminal"]);
    expect(data.tools.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
  });

  it("parses resource + action function call envelopes without legacy fallback", () => {
    const router = new ToolRouter();
    expect(
      router.parseToolCall("code", { action: "read", params: { path: "src/app.ts" } }),
    ).toEqual({
      name: "code.read",
      input: { path: "src/app.ts" },
    });
    expect(router.parseToolCall("code", { action: "missing", params: {} })).toEqual({
      error: "Unknown tool: code.missing",
    });
  });
});

describe("code tools", () => {
  it("searches, reads, outlines, and lists project structure", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "alembic-agent-tools-"));
    await mkdir(path.join(root, "src"));
    await writeFile(
      path.join(root, "src", "app.ts"),
      [
        'import { helper } from "./util";',
        "export class App {",
        "  render() {",
        "    return helper();",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "src", "util.ts"),
      "export function helper() { return true; }\n",
    );

    const router = new ToolRouter({ dependencies: { projectRoot: root } });
    const search = await router.invoke({
      name: "code.search",
      input: { patterns: ["helper"], glob: "*.ts", maxResults: 5 },
    });
    expectOk(search);
    expect((search.data as { count: number }).count).toBeGreaterThan(0);

    const read = await router.invoke({
      name: "code.read",
      input: { path: "src/app.ts", startLine: 2, endLine: 3 },
    });
    expectOk(read);
    expect((read.data as { content: string }).content).toContain("export class App");

    const outline = await router.invoke({ name: "code.outline", input: { path: "src/app.ts" } });
    expectOk(outline);
    expect((outline.data as { symbols: ReadonlyArray<{ name: string }> }).symbols[0]).toMatchObject(
      {
        name: "App",
      },
    );

    const structure = await router.invoke({ name: "code.structure", input: { depth: 2 } });
    expectOk(structure);
    expect(JSON.stringify(structure.data)).toContain("src/app.ts");
  });

  it("policy-gates file writes", async () => {
    const result = await new ToolRouter().invoke({
      name: "code.write",
      input: { path: "src/app.ts", content: "x" },
    });

    expectFailure(result);
    expect(result.status).toBe("policy_required");
    expect(result.error.details).toMatchObject({ executesWrites: false });
  });
});

describe("code.guard", () => {
  it("checks supplied files against injected mainline guard rules", async () => {
    const result = await new ToolRouter({
      dependencies: {
        guardRules: [
          {
            id: "no-console-log",
            ruleRecipeId: "guard-no-console-log",
            pattern: "console\\.log\\s*\\(",
            message: "不要在生产代码中保留 console.log。",
            severity: "warning",
            languages: ["typescript"],
            skipComments: true,
          },
        ],
      },
    }).invoke({
      name: "code.guard",
      input: {
        files: [
          {
            path: "src/app.ts",
            content: ["// console.log('comment')", "console.log('debug');"].join("\n"),
          },
        ],
      },
    });

    expectOk(result);
    const data = result.data as {
      readonly summary: { readonly findings: number; readonly warnings: number };
      readonly findings: ReadonlyArray<{ readonly ruleId: string; readonly line: number }>;
    };
    expect(data.summary).toMatchObject({ findings: 1, warnings: 1 });
    expect(data.findings[0]).toMatchObject({ ruleId: "no-console-log", line: 2 });
  });

  it("requires a mainline guard rule dependency", async () => {
    const result = await new ToolRouter().invoke({
      name: "code.guard",
      input: {
        files: [{ path: "src/app.ts", content: "console.log('debug');" }],
      },
    });

    expectFailure(result);
    expect(result.status).toBe("unavailable");
    expect(result.error.code).toBe("guard_rules_unavailable");
  });
});

describe("knowledge.search and knowledge.detail", () => {
  it("uses mainline search and context index ports", async () => {
    const searchIndex = new InMemoryMainlineSearchIndex();
    searchIndex.upsert([
      {
        id: "recipe:ghost-init",
        kind: "recipe",
        title: "Ghost workspace init",
        body: "Initialize Alembic without local IDE writes.",
        path: "lib/codex/workspace.ts",
        tags: ["ghost"],
      },
    ]);

    const contextIndex = new InMemoryContextIndex();
    await contextIndex.upsertContextArtifacts({
      recipes: [
        createRecipe({
          id: "ghost-init",
          title: "Ghost workspace init",
          summary: "Initialize Alembic without local IDE writes.",
          sourceRefIds: ["lib/codex/workspace.ts"],
          tags: ["ghost"],
        }),
      ],
      recipeFiles: [
        {
          recipeId: "ghost-init",
          bucket: "recipes",
          relativePath: "recipes/ghost-init.md",
          contentHash: "hash-1",
        },
      ],
      sourceRefs: [
        createSourceRef({
          id: "lib/codex/workspace.ts",
          path: "lib/codex/workspace.ts",
          status: "active",
        }),
      ],
    });

    const router = new ToolRouter({
      dependencies: { searchIndex, contextIndex },
    });
    const search = await router.invoke({
      name: "knowledge.search",
      input: { query: "ghost workspace", limit: 5 },
    });

    expectOk(search);
    const searchData = search.data as {
      readonly hits: ReadonlyArray<{ readonly document: { readonly id: string } }>;
      readonly context: {
        readonly included: boolean;
        readonly recipeIds: readonly string[];
        readonly recipeFiles: ReadonlyArray<{ readonly relativePath: string }>;
        readonly sourceRefs: ReadonlyArray<{ readonly id: string }>;
      };
    };
    expect(searchData.hits[0]?.document.id).toBe("recipe:ghost-init");
    expect(searchData.context.included).toBe(true);
    expect(searchData.context.recipeIds).toEqual(["ghost-init"]);
    expect(searchData.context.recipeFiles[0]?.relativePath).toBe("recipes/ghost-init.md");
    expect(searchData.context.sourceRefs[0]?.id).toBe("lib/codex/workspace.ts");

    const detail = await router.invoke({ name: "knowledge.detail", input: { id: "ghost-init" } });
    expectOk(detail);
    expect((detail.data as { recipe: { id: string } }).recipe.id).toBe("ghost-init");
  });
});

describe("graph tools", () => {
  it("uses project intelligence through an artifact provider", async () => {
    const artifact = await new MainlineProjectIntelligenceBuilder().build({
      projectRoot: "/project",
      knownFiles: ["src/app.ts", "src/util.ts"],
      files: [
        {
          path: "src/app.ts",
          content: [
            'import { helper } from "./util";',
            "export function App() {",
            "  return render();",
            "}",
            "function render() {",
            "  return helper();",
            "}",
            "",
          ].join("\n"),
          languageId: "typescript",
        },
        {
          path: "src/util.ts",
          content: "export function helper() { return true; }\n",
          languageId: "typescript",
        },
      ],
      generatedAt: 1,
    });

    const router = new ToolRouter({
      dependencies: { projectIntelligenceArtifactProvider: async () => artifact },
    });
    const overview = await router.invoke({ name: "graph.overview" });
    expectOk(overview);
    expect((overview.data as { files: { total: number } }).files.total).toBe(2);

    const query = await router.invoke({
      name: "graph.query",
      input: { operation: "callees", ref: "src/app.ts::App" },
    });

    expectOk(query);
    const data = query.data as {
      readonly operation: string;
      readonly result: ReadonlyArray<{ readonly symbol: { readonly fqn: string } }>;
    };
    expect(data.operation).toBe("callees");
    expect(data.result.map((relation) => relation.symbol.fqn)).toEqual(["src/app.ts::render"]);
  });
});

describe("memory and meta tools", () => {
  it("saves, recalls, notes findings, and reports review metadata", async () => {
    const router = new ToolRouter({ dependencies: { now: () => 10 } });
    const save = await router.invoke({
      name: "memory.save",
      input: { key: "k1", content: "project uses Ghost mode", tags: ["workspace"] },
    });
    expectOk(save);

    const recall = await router.invoke({
      name: "memory.recall",
      input: { query: "ghost", limit: 5 },
    });
    expectOk(recall);
    expect((recall.data as { count: number }).count).toBe(1);

    const note = await router.invoke({
      name: "memory.note_finding",
      input: { finding: "SourceRef repair is needed", evidence: "lib/x.ts:1" },
    });
    expectOk(note);

    const plan = await router.invoke({
      name: "meta.plan",
      input: { strategy: "tool-first", steps: [{ id: 1, action: "read", tool: "code.read" }] },
    });
    expectOk(plan);
    expect((plan.data as { stepCount: number }).stepCount).toBe(1);

    const review = await router.invoke({ name: "meta.review" });
    expectOk(review);
    expect((review.data as { compatibility: string }).compatibility).toBe("no-legacy-v1-v2");
  });
});

describe("terminal.execute", () => {
  it("returns a policy gate envelope without executing commands", async () => {
    const result = await new ToolRouter().invoke({
      name: "terminal.execute",
      input: { command: "printf should-not-run" },
    });

    expectFailure(result);
    expect(result.status).toBe("policy_required");
    expect(result.error).toMatchObject({
      code: "policy_required",
      details: { executesCommands: false, commandPreview: "printf should-not-run" },
    });
  });
});

function expectOk<T>(result: ToolResultEnvelope<T>): asserts result is ToolSuccessEnvelope<T> {
  expect(result.ok).toBe(true);
}

function expectFailure(result: ToolResultEnvelope): asserts result is ToolFailureEnvelope {
  expect(result.ok).toBe(false);
}
