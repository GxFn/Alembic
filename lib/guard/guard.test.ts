import { describe, expect, it } from "vitest";
import { createRecipe, createRecipeKnowledgePayload } from "../mainline/knowledge/index.js";
import {
  loadGuardRulesFromRecipes,
  MainlineGuardCheckEngine,
  RecipeBackedGuardRuleProvider,
} from "./index.js";

describe("mainline recipe guard rules", () => {
  it("loads guard-rule recipes and checks files without legacy services", async () => {
    const recipe = createRecipe({
      id: "guard-no-console-log",
      title: "No console.log in production code",
      kind: "guard-rule",
      status: "active",
      summary: "生产代码应使用日志设施，不直接保留 console.log。",
      confidence: 0.9,
      knowledge: createRecipeKnowledgePayload({
        language: "typescript",
        constraints: {
          guards: [
            {
              id: "no-console-log",
              pattern: "console\\.log\\s*\\(",
              message: "不要在生产代码中保留 console.log。",
              severity: "warning",
              fixSuggestion: "改用项目日志工具，或在提交前移除调试输出。",
              skipComments: true,
              skipTestFiles: true,
            },
          ],
        },
      }),
    });

    const loaded = loadGuardRulesFromRecipes([recipe]);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.rules).toHaveLength(1);
    expect(loaded.rules[0]).toMatchObject({
      id: "no-console-log",
      ruleRecipeId: "guard-no-console-log",
      severity: "warning",
      languages: ["typescript"],
    });
    await expect(new RecipeBackedGuardRuleProvider(async () => [recipe]).load()).resolves.toEqual(
      loaded,
    );

    const result = new MainlineGuardCheckEngine({ rules: loaded.rules }).check({
      files: [
        {
          path: "src/app.ts",
          content: ["// console.log is allowed in comments", "console.log('debug');"].join("\n"),
        },
        {
          path: "src/app.test.ts",
          content: "console.log('test');",
        },
      ],
    });

    expect(result.summary).toMatchObject({
      files: 2,
      rules: 1,
      findings: 1,
      warnings: 1,
    });
    expect(result.findings[0]).toMatchObject({
      ruleId: "no-console-log",
      ruleRecipeId: "guard-no-console-log",
      file: "src/app.ts",
      line: 2,
      language: "typescript",
      suggestedFix: "改用项目日志工具，或在提交前移除调试输出。",
    });
  });

  it("skips invalid Recipe guard patterns with a warning", () => {
    const recipe = createRecipe({
      id: "guard-invalid",
      title: "Invalid guard",
      kind: "guard-rule",
      status: "active",
      knowledge: createRecipeKnowledgePayload({
        constraints: {
          guards: [{ id: "bad-pattern", pattern: "(", message: "bad" }],
        },
      }),
    });

    const loaded = loadGuardRulesFromRecipes([recipe]);
    const result = new MainlineGuardCheckEngine({ rules: loaded.rules }).check({
      files: [{ path: "src/app.ts", content: "anything" }],
    });

    expect(result.summary.findings).toBe(0);
    expect(result.warnings[0]).toContain("bad-pattern");
  });
});
