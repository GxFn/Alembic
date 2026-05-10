import { describe, expect, it } from "vitest";
import { InMemoryContextIndex } from "../mainline/data/index.js";
import { MainlineProjectIntelligenceBuilder } from "../mainline/graph/index.js";
import { createRecipe, createSourceRef } from "../mainline/knowledge/index.js";
import { InMemoryMainlineSearchIndex } from "../mainline/search/index.js";
import { createDefaultToolRegistry, ToolRouter } from "./index.js";
import type { ToolFailureEnvelope, ToolResultEnvelope, ToolSuccessEnvelope } from "./types.js";

describe("new tools registry and router", () => {
  it("registers exactly the six resource tools and rejects unknown tools", async () => {
    const registry = createDefaultToolRegistry();

    expect(registry.list().map((tool) => tool.name)).toEqual([
      "code.query",
      "code.guard",
      "terminal.execute",
      "knowledge.search",
      "graph.query",
      "memory.query",
      "meta.capabilities",
    ]);
    expect(registry.get("code.query")?.availability.status).toBe("unavailable");
    expect(registry.get("terminal.execute")?.availability.status).toBe("policy_required");

    const result = await new ToolRouter({ registry }).invoke({ name: "legacy.v2" });
    expectFailure(result);
    expect(result.error.code).toBe("unknown_tool");
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
    expect(data.tools.map((tool) => tool.name)).toEqual([
      "code.query",
      "code.guard",
      "terminal.execute",
      "knowledge.search",
      "graph.query",
      "memory.query",
      "meta.capabilities",
    ]);
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

describe("knowledge.search", () => {
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

    const result = await new ToolRouter({
      dependencies: { searchIndex, contextIndex },
    }).invoke({
      name: "knowledge.search",
      input: { query: "ghost workspace", limit: 5 },
    });

    expectOk(result);
    const data = result.data as {
      readonly hits: ReadonlyArray<{ readonly document: { readonly id: string } }>;
      readonly context: {
        readonly included: boolean;
        readonly recipeIds: readonly string[];
        readonly recipeFiles: ReadonlyArray<{ readonly relativePath: string }>;
        readonly sourceRefs: ReadonlyArray<{ readonly id: string }>;
      };
    };
    expect(data.hits[0]?.document.id).toBe("recipe:ghost-init");
    expect(data.context.included).toBe(true);
    expect(data.context.recipeIds).toEqual(["ghost-init"]);
    expect(data.context.recipeFiles[0]?.relativePath).toBe("recipes/ghost-init.md");
    expect(data.context.sourceRefs[0]?.id).toBe("lib/codex/workspace.ts");
  });
});

describe("graph.query", () => {
  it("uses project intelligence queries through an artifact provider", async () => {
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

    const result = await new ToolRouter({
      dependencies: { projectIntelligenceArtifactProvider: async () => artifact },
    }).invoke({
      name: "graph.query",
      input: { operation: "callees", ref: "src/app.ts::App" },
    });

    expectOk(result);
    const data = result.data as {
      readonly operation: string;
      readonly result: ReadonlyArray<{ readonly symbol: { readonly fqn: string } }>;
    };
    expect(data.operation).toBe("callees");
    expect(data.result.map((relation) => relation.symbol.fqn)).toEqual(["src/app.ts::render"]);
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
