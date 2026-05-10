import { createHash } from "node:crypto";
import {
  createRecipe,
  createSourceRef,
  type RecipeInput,
  RecipeLifecycleStore,
  RecipeSubmissionPolicy,
  type SourceRef,
} from "../mainline/knowledge/index.js";
import { projectMainlineSearchDocuments } from "../mainline/search/index.js";
import { createMainlineWorkflowPersistence } from "../workflows/mainline/MainlineWorkflowPersistence.js";
import { inspectWorkspace } from "./workspace.js";

export interface CodexKnowledgeSubmissionResult {
  readonly status: "completed" | "uninitialized" | "error";
  readonly accepted: number;
  readonly rejected: number;
  readonly items: readonly CodexKnowledgeSubmissionItemResult[];
  readonly dataRoot: string;
  readonly projectRoot: string;
  readonly candidatesDir: string;
  readonly message?: string | undefined;
}

export interface CodexKnowledgeSubmissionItemResult {
  readonly index: number;
  readonly accepted: boolean;
  readonly id?: string | undefined;
  readonly path?: string | undefined;
  readonly decision: string;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Codex 默认 tier 只提交知识候选，不发布 Recipe；写入边界限定在 Ghost dataRoot。
 */
export async function submitCodexKnowledge(
  args: Record<string, unknown> = {},
): Promise<CodexKnowledgeSubmissionResult> {
  const projectRoot = stringValue(args.projectRoot);
  const workspace = inspectWorkspace(projectRoot);
  if (!workspace.initialized) {
    return {
      status: "uninitialized",
      accepted: 0,
      rejected: 0,
      items: [],
      dataRoot: workspace.dataRoot,
      projectRoot: workspace.projectRoot,
      candidatesDir: workspace.candidatesDir,
      message:
        "Alembic workspace is not initialized. Run alembic init before submitting candidates.",
    };
  }

  const rawItems = submissionItems(args);
  if (rawItems.length === 0) {
    return {
      status: "completed",
      accepted: 0,
      rejected: 1,
      items: [
        {
          index: 0,
          accepted: false,
          decision: "reject",
          errors: ["items must be an array, or args must look like one knowledge item."],
          warnings: [],
        },
      ],
      dataRoot: workspace.dataRoot,
      projectRoot: workspace.projectRoot,
      candidatesDir: workspace.candidatesDir,
    };
  }

  try {
    const persistence = await createMainlineWorkflowPersistence({
      projectRoot: workspace.projectRoot,
      dataRoot: workspace.dataRoot,
    });
    const lifecycleStore = new RecipeLifecycleStore(persistence.writeBoundary);
    const snapshot = persistence.contextIndex.snapshot();
    const lifecycleRecords = await lifecycleStore.list({ status: "all" });
    const existingRecipes = uniqueRecipesById([
      ...snapshot.recipes,
      ...lifecycleRecords.map((record) => record.recipe),
    ]);
    const usedIds = new Set(existingRecipes.map((recipe) => recipe.id));
    const results: CodexKnowledgeSubmissionItemResult[] = [];

    for (const [index, rawItem] of rawItems.entries()) {
      if (!isRecord(rawItem)) {
        results.push({
          index,
          accepted: false,
          decision: "reject",
          errors: ["Knowledge item must be an object."],
          warnings: [],
        });
        continue;
      }

      const id = uniqueCandidateId(rawItem, usedIds);
      usedIds.add(id);
      const updatedAt = Math.floor(Date.now() / 1000);
      const sourceRefs = sourceRefsFromSubmission(rawItem, id, updatedAt);
      const submission = withSystemFields(rawItem, id, sourceRefs, updatedAt);
      const policy = new RecipeSubmissionPolicy().evaluate(submission, {
        existingRecipes,
        id,
        status: "candidate",
        updatedAt,
        metadata: {
          codex: {
            tier: "candidate-only",
            storageBoundary: "ghost-data-root",
          },
        },
      });

      if (!policy.accepted || !policy.recipeInput) {
        results.push({
          index,
          accepted: false,
          id,
          decision: policy.decision,
          errors: policy.errors,
          warnings: policy.warnings,
        });
        continue;
      }

      const recipeInput = ensureCandidateRecipeInput(policy.recipeInput, id, sourceRefs, updatedAt);
      const recipe = createRecipe(recipeInput);
      // 中文注释：Codex submit 只写 lifecycle candidate，不调用 publish()，
      // 因此不会进入 RecipeLifecycleStore 默认 active 可用语义。
      const record = await lifecycleStore.writeCandidate(recipe, {
        now: updatedAt,
        submittedBy: "codex",
      });
      const file = record.file;
      if (!file) {
        throw new Error(`RecipeLifecycleStore did not return a candidate file for ${record.id}.`);
      }

      await persistence.contextIndex.upsertContextArtifacts({
        recipes: [record.recipe],
        sourceRefs,
        recipeFiles: [
          {
            recipeId: file.recipeId,
            bucket: file.bucket,
            relativePath: file.relativePath,
            contentHash: file.contentHash,
            updatedAt,
          },
        ],
      });
      persistence.searchIndex.upsert(
        projectMainlineSearchDocuments({ recipes: [record.recipe], sourceRefs }),
      );
      await persistence.searchIndex.flush();

      results.push({
        index,
        accepted: true,
        id: record.recipe.id,
        path: file.absolutePath,
        decision: policy.decision,
        errors: [],
        warnings: policy.warnings,
      });
    }

    return {
      status: "completed",
      accepted: results.filter((item) => item.accepted).length,
      rejected: results.filter((item) => !item.accepted).length,
      items: results,
      dataRoot: workspace.dataRoot,
      projectRoot: workspace.projectRoot,
      candidatesDir: workspace.candidatesDir,
    };
  } catch (error) {
    return {
      status: "error",
      accepted: 0,
      rejected: rawItems.length,
      items: [],
      dataRoot: workspace.dataRoot,
      projectRoot: workspace.projectRoot,
      candidatesDir: workspace.candidatesDir,
      message: error instanceof Error ? error.message : "submitCodexKnowledge failed.",
    };
  }
}

function submissionItems(args: Record<string, unknown>): readonly unknown[] {
  if (Array.isArray(args.items)) {
    return args.items;
  }
  return looksLikeSubmission(args) ? [args] : [];
}

function looksLikeSubmission(args: Record<string, unknown>): boolean {
  return ["title", "content", "description", "trigger", "kind"].some((key) => key in args);
}

function withSystemFields(
  item: Record<string, unknown>,
  id: string,
  sourceRefs: readonly SourceRef[],
  updatedAt: number,
): Record<string, unknown> {
  const sourceRefIds = uniqueStrings([
    ...stringList(item.sourceRefIds),
    ...stringList(item.sourceRefs),
    ...sourceRefs.map((sourceRef) => sourceRef.id),
  ]);
  return {
    ...item,
    id,
    status: stringValue(item.status) ?? "candidate",
    updatedAt: item.updatedAt ?? updatedAt,
    sourceRefIds,
  };
}

function ensureCandidateRecipeInput(
  input: RecipeInput,
  id: string,
  sourceRefs: readonly SourceRef[],
  updatedAt: number,
): RecipeInput {
  return {
    ...input,
    id,
    status: "candidate",
    updatedAt: input.updatedAt ?? updatedAt,
    sourceRefIds: uniqueStrings([
      ...(input.sourceRefIds ?? []),
      ...sourceRefs.map((sourceRef) => sourceRef.id),
    ]),
  };
}

function uniqueCandidateId(item: Record<string, unknown>, usedIds: ReadonlySet<string>): string {
  const title = stringValue(item.title) ?? "codex-knowledge";
  const content = stableJson({
    title,
    content: item.content,
    knowledge: item.knowledge,
    trigger: item.trigger,
    doClause: item.doClause,
    dontClause: item.dontClause,
    whenClause: item.whenClause,
    coreCode: item.coreCode,
  });
  const base = `${slugify(title)}-${sha256(content).slice(0, 10)}`;
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function sourceRefsFromSubmission(
  item: Record<string, unknown>,
  recipeId: string,
  verifiedAt: number,
): SourceRef[] {
  const paths = uniqueStrings([
    ...sourcePathList(recordValue(item.reasoning).sources),
    ...sourcePathList(item.sourceRefs),
    ...sourcePathList(item.sourceRefIds),
  ]);
  return paths.map((path) =>
    createSourceRef({
      path,
      status: "unknown",
      verifiedAt,
      metadata: { recipeId, submittedBy: "codex" },
    }),
  );
}

function sourcePathList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return typeof value === "string" && looksLikePath(value) ? [value.trim()] : [];
  }
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      return looksLikePath(entry) ? [entry.trim()] : [];
    }
    if (!isRecord(entry)) {
      return [];
    }
    const path =
      stringValue(entry.path) ?? stringValue(entry.file) ?? stringValue(entry.sourceFile);
    return path && looksLikePath(path) ? [path] : [];
  });
}

function looksLikePath(value: string): boolean {
  const text = value.trim();
  return (
    text.length > 0 &&
    !text.startsWith("recipe:") &&
    !text.startsWith("source-ref:") &&
    (text.includes("/") || /\.\w{1,10}(:\d+)?$/.test(text))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueRecipesById<T extends { readonly id: string }>(recipes: readonly T[]): T[] {
  return [...new Map(recipes.map((recipe) => [recipe.id, recipe])).values()];
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "codex-knowledge"
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
