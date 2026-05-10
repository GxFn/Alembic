import { describe, expect, it } from "vitest";
import {
  createRecipe,
  mainlineRecipeCodeFingerprint,
  normalizeRecipeSubmissionToInput,
  type Recipe,
  RecipeMarkdownCodec,
  RecipeSimilarityPolicy,
  type RecipeSubmission,
  RecipeSubmissionPolicy,
} from "./index.js";

describe("RecipeMarkdownCodec", () => {
  it("round-trips managed Recipe fields through markdown frontmatter and body sections", () => {
    const recipe = createRecipe(normalizeRecipeSubmissionToInput(validSubmission()));
    const codec = new RecipeMarkdownCodec();

    const markdown = codec.toMarkdown(recipe);
    const parsed = codec.toRecipe(markdown, { updatedAt: 1234 });

    expect(markdown).toContain("<!-- alembic:field knowledge.delivery.doClause -->");
    expect(parsed).toMatchObject({
      id: recipe.id,
      title: recipe.title,
      kind: recipe.kind,
      summary: recipe.summary,
      trigger: recipe.trigger,
      dimensionIds: recipe.dimensionIds,
      sourceRefIds: recipe.sourceRefIds,
    });
    expect(parsed.knowledge?.delivery).toMatchObject({
      whenClause: recipe.knowledge?.delivery.whenClause,
      doClause: recipe.knowledge?.delivery.doClause,
      dontClause: recipe.knowledge?.delivery.dontClause,
      coreCode: recipe.knowledge?.delivery.coreCode,
      usageGuide: recipe.knowledge?.delivery.usageGuide,
    });
    expect(parsed.knowledge?.body).toMatchObject({
      markdown: recipe.knowledge?.body.markdown,
      rationale: recipe.knowledge?.body.rationale,
      pattern: recipe.knowledge?.body.pattern,
    });
  });

  it("lets managed body sections override stale frontmatter values", () => {
    const recipe = createRecipe(normalizeRecipeSubmissionToInput(validSubmission()));
    const codec = new RecipeMarkdownCodec();
    const markdown = codec
      .toMarkdown(recipe)
      .replace(
        /(<!-- alembic:field knowledge\.delivery\.doClause -->\n)[\s\S]*?(\n<!-- \/alembic:field -->)/,
        "$1Call the replacement adapter.$2",
      );

    const submission = codec.toSubmission(markdown);

    expect(submission.knowledge?.delivery?.doClause).toBe("Call the replacement adapter.");
  });
});

describe("RecipeSubmissionPolicy", () => {
  it("rejects duplicate title, trigger, and core code fingerprints", () => {
    const existing = recipeFromSubmission(
      validSubmission({
        id: "recipe-existing",
        title: "Use scoped event bus for mainline coordination",
      }),
    );
    const result = new RecipeSubmissionPolicy().evaluate(
      validSubmission({
        id: "recipe-candidate",
        title: existing.title,
      }),
      {
        existingRecipes: [existing],
        existingCodeFingerprints: [
          mainlineRecipeCodeFingerprint(existing.knowledge?.delivery.coreCode),
        ],
        skipSimilarity: true,
        nowMs: 1000,
      },
    );

    expect(result.accepted).toBe(false);
    expect(result.decision).toBe("reject");
    expect(result.errors).toEqual(
      expect.arrayContaining([
        `标题重复: "${existing.title}"`,
        `trigger 重复: "${existing.trigger}"`,
        "代码模式重复 — 已存在相同核心代码的 Recipe。请提交不同的代码片段。",
      ]),
    );
  });

  it("blocks low-substance submissions before admission", () => {
    const result = new RecipeSubmissionPolicy().evaluate(
      validSubmission({
        id: "recipe-thin",
        title: "Use mainline helper for tiny thing",
        content: { markdown: "Too short." },
        doClause: "Use it.",
        dontClause: "Skip old path.",
        whenClause: "When touching this area.",
        coreCode: "helper()",
        reasoning: { whyStandard: "Keeps behavior consistent.", sources: [] },
      }),
      { minSubstanceScore: 0.9, skipSimilarity: true, skipUniqueness: true, nowMs: 1000 },
    );

    expect(result.accepted).toBe(false);
    expect(result.decision).toBe("insufficient");
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("content.markdown 过短"),
        expect.stringContaining("Recipe 内容实质不足"),
      ]),
    );
  });

  it("routes complete trusted submissions to staging with quality metadata", () => {
    const result = new RecipeSubmissionPolicy().evaluate(validSubmission(), {
      skipSimilarity: true,
      skipUniqueness: true,
      nowMs: 1000,
    });

    expect(result.accepted).toBe(true);
    expect(result.decision).toBe("create");
    expect(result.recipeInput?.knowledge?.governance).toMatchObject({
      lifecycle: "staging",
      autoApprovable: true,
      stagingDeadline: 1000 + 72 * 60 * 60 * 1000,
    });
    expect(result.recipeInput?.knowledge?.quality.overall).toBeGreaterThanOrEqual(0.3);
  });
});

describe("RecipeSimilarityPolicy", () => {
  it("scores matching title, clauses, code, content tokens, and guard pattern", () => {
    const policy = new RecipeSimilarityPolicy();
    const result = policy.compute(
      similarityLike("Use MainlineEventBus for coordination"),
      similarityLike("Use MainlineEventBus for coordination"),
    );

    expect(result.similarity).toBe(1);
    expect(result.dimensions).toEqual({
      title: 1,
      clause: 1,
      code: 1,
      content: 1,
      guard: 1,
    });
    expect(result.fields).toMatchObject({
      triggerConflict: true,
      doClauseSubset: true,
      coreCodeOverlap: 1,
      categoryMatch: true,
    });
  });

  it("finds similar recipes above threshold and orders by similarity", () => {
    const policy = new RecipeSimilarityPolicy();
    const close = recipeFromSubmission(
      validSubmission({
        id: "recipe-close",
        title: "Use MainlineEventBus for async coordination",
      }),
    );
    const distant = recipeFromSubmission(
      validSubmission({
        id: "recipe-distant",
        title: "Normalize workspace paths before writes",
        trigger: "@mainline-paths",
        doClause: "Normalize project-relative paths through MainlinePathScope.",
        dontClause: "Do not compare raw absolute paths.",
        coreCode: 'scope.resolve("generated/file.json")',
        category: "paths",
        content: {
          markdown:
            'Path normalization belongs to the core path helpers, not the knowledge policy tests.\n\n```ts\nscope.resolve("generated/file.json");\n```\n\nSource: lib/mainline/core/PathScope.ts:1',
          rationale: "Path identity should stay segment-aware.",
          pattern: "scope.resolve(relativePath)",
        },
      }),
    );

    const matches = policy.findSimilar(validSubmission(), [distant, close], {
      threshold: 0.35,
      limit: 2,
    });

    expect(matches.map((match) => match.recipe.id)).toEqual(["recipe-close"]);
    expect(matches[0]?.similarity).toBeGreaterThanOrEqual(0.35);
  });
});

function recipeFromSubmission(submission: RecipeSubmission): Recipe {
  return createRecipe(normalizeRecipeSubmissionToInput(submission));
}

function validSubmission(overrides: Partial<RecipeSubmission> = {}): RecipeSubmission {
  return {
    id: "recipe-event-bus",
    title: "Use MainlineEventBus for coordination",
    kind: "pattern",
    status: "candidate",
    description: "Use the typed mainline event bus for in-memory coordination.",
    trigger: "@mainline-event-bus",
    dimensionId: "core-coordination",
    tags: ["mainline", "coordination"],
    confidence: 0.88,
    language: "typescript",
    category: "coordination",
    knowledgeType: "code-pattern",
    topicHint: "mainline event dispatch",
    whenClause: "When a mainline primitive needs in-memory fan-out without repository coupling.",
    doClause:
      "Publish typed events through MainlineEventBus and subscribe with exact or wildcard topics.",
    dontClause: "Do not call service or workflow layers from the knowledge policy boundary.",
    coreCode:
      'const bus = new MainlineEventBus(); bus.subscribe("recipe.created", handleEvent); bus.send("recipe.created", "knowledge", payload);',
    usageGuide:
      "Keep payloads serializable and unsubscribe listeners in tests that own subscriptions.",
    headers: ["MainlineEventBus"],
    source: "bootstrap",
    sourceFile: "lib/mainline/core/EventBus.ts",
    content: {
      markdown:
        'Mainline knowledge tests rely on focused core primitives and should keep coordination local to the policy boundary. The event bus gives callers typed fan-out without reaching service, repository, workflow, or compile layers, which keeps Recipe admission tests deterministic and cheap.\n\n```ts\nconst bus = new MainlineEventBus();\nbus.subscribe("recipe.created", handleEvent);\nbus.send("recipe.created", "knowledge", payload);\n```\n\nSource: lib/mainline/core/EventBus.ts:1',
      rationale:
        "The event bus keeps policy behavior observable while preserving the mainline boundary around knowledge code.",
      pattern: 'const bus = new MainlineEventBus(); bus.subscribe("recipe.created", handleEvent);',
    },
    reasoning: {
      whyStandard: "It keeps knowledge logic independently testable and avoids lifecycle coupling.",
      sources: ["lib/mainline/core/EventBus.ts:1"],
      confidence: 0.88,
    },
    ...overrides,
  };
}

function similarityLike(title: string) {
  return {
    title,
    trigger: "@mainline-event-bus",
    category: "coordination",
    doClause: "Publish typed events through MainlineEventBus.",
    dontClause: "Do not call service layers.",
    coreCode: 'const bus = new MainlineEventBus(); bus.subscribe("recipe.created", handleEvent);',
    guardPattern: "MainlineEventBus subscription pattern",
    content: {
      markdown:
        'Use the local bus for fan-out.\n\n```ts\nconst bus = new MainlineEventBus();\nbus.subscribe("recipe.created", handleEvent);\n```\n',
      pattern: "MainlineEventBus subscription pattern",
    },
  };
}
