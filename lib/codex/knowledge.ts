import { sourceRefsFromRecipe } from "../mainline/compile/index.js";
import type { RecipeMarkdownFileIndex } from "../mainline/data/index.js";
import {
  type RecipeLifecycleRecord,
  type RecipeLifecycleStatus,
  RecipeLifecycleStore,
} from "../mainline/knowledge/index.js";
import { projectMainlineSearchDocuments } from "../mainline/search/index.js";
import { createMainlineWorkflowPersistence } from "../workflows/mainline/MainlineWorkflowPersistence.js";
import { inspectWorkspace } from "./workspace.js";

export type CodexKnowledgeOperation = "list" | "publish" | "reject";
export type CodexKnowledgeResultStatus = "completed" | "invalid-input" | "uninitialized" | "error";
export type CodexKnowledgeStatusFilter = RecipeLifecycleStatus | "all";

export interface CodexKnowledgeResult {
  readonly status: CodexKnowledgeResultStatus;
  readonly operation: CodexKnowledgeOperation;
  readonly records: readonly CodexKnowledgeRecord[];
  readonly items: readonly CodexKnowledgeRecord[];
  readonly warnings: readonly string[];
  readonly dataRoot: string;
  readonly projectRoot: string;
  readonly message?: string | undefined;
}

export interface CodexKnowledgeRecord {
  readonly id: string;
  readonly status: RecipeLifecycleStatus;
  readonly title: string;
  readonly kind: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly sourceRefIds: readonly string[];
  readonly confidence: number;
  readonly trigger?: string | undefined;
  readonly updatedAt?: number | undefined;
  readonly metadata: Record<string, unknown>;
  readonly file?: CodexKnowledgeFile | undefined;
}

export interface CodexKnowledgeFile {
  readonly bucket: "candidates" | "recipes";
  readonly relativePath: string;
  readonly path: string;
  readonly contentHash: string;
}

interface ParsedKnowledgeInput {
  readonly operation: CodexKnowledgeOperation;
  readonly projectRoot?: string;
  readonly status?: CodexKnowledgeStatusFilter;
  readonly limit?: number;
  readonly recipeId?: string;
  readonly reason?: string;
  readonly publishedBy?: string;
  readonly rejectedBy?: string;
}

const KNOWLEDGE_OPERATIONS = new Set(["list", "publish", "reject"]);
const KNOWLEDGE_STATUSES = new Set(["candidate", "active", "rejected", "all"]);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * 中文注释：这是 Codex public lifecycle adapter，只暴露 MCP 友好的 alembic_knowledge；
 * 它调用 mainline RecipeLifecycleStore 和 read-model persistence，不导入 internal Agent tools，
 * 也不返回内部 Agent 的 resource.action envelope。
 */
export async function runCodexKnowledge(
  args: Record<string, unknown> = {},
): Promise<CodexKnowledgeResult> {
  const parsed = parseKnowledgeInput(args);
  const workspace = inspectWorkspace(parsed.projectRoot);
  const warnings: string[] = [];

  if (parsed.status === "invalid-input") {
    return stableResult({
      status: "invalid-input",
      operation: parsed.operation,
      workspace,
      warnings,
      message: parsed.message,
    });
  }

  if (!workspace.initialized) {
    warnings.push("workspace_uninitialized");
    return stableResult({
      status: "uninitialized",
      operation: parsed.input.operation,
      workspace,
      warnings,
      message: "Alembic workspace is not initialized.",
    });
  }

  try {
    const persistence = await createMainlineWorkflowPersistence({
      projectRoot: workspace.projectRoot,
      dataRoot: workspace.dataRoot,
      mode: workspace.mode,
    });
    const lifecycle = new RecipeLifecycleStore(persistence.writeBoundary);

    switch (parsed.input.operation) {
      case "list": {
        const listOptions =
          parsed.input.status === undefined
            ? { limit: parsed.input.limit ?? DEFAULT_LIMIT }
            : { status: parsed.input.status, limit: parsed.input.limit ?? DEFAULT_LIMIT };
        const records = await lifecycle.list(listOptions);
        return stableResult({
          status: "completed",
          operation: "list",
          workspace,
          warnings,
          records: records.map(summarizeLifecycleRecord),
          message: "Knowledge records listed.",
        });
      }
      case "publish": {
        const record = await lifecycle.publish(parsed.input.recipeId ?? "", {
          ...(parsed.input.publishedBy ? { publishedBy: parsed.input.publishedBy } : {}),
        });
        const sourceRefs = sourceRefsFromRecipe(record.recipe, "codex-knowledge-publish");
        await persistence.contextIndex.upsertContextArtifacts({
          recipes: [record.recipe],
          sourceRefs,
          recipeFiles: recipeFilesFromRecord(record),
        });
        persistence.searchIndex.upsert(
          projectMainlineSearchDocuments({ recipes: [record.recipe], sourceRefs }),
        );
        await persistence.searchIndex.flush();

        return stableResult({
          status: "completed",
          operation: "publish",
          workspace,
          warnings,
          records: [summarizeLifecycleRecord(record)],
          message: "Knowledge candidate published.",
        });
      }
      case "reject": {
        const record = await lifecycle.reject(parsed.input.recipeId ?? "", {
          ...(parsed.input.reason ? { reason: parsed.input.reason } : {}),
          ...(parsed.input.rejectedBy ? { rejectedBy: parsed.input.rejectedBy } : {}),
        });
        const deleted = await persistence.contextIndex.deleteRecipes([record.id]);
        persistence.searchIndex.remove([
          `recipe:${record.id}`,
          ...deleted.sourceRefIds.map((sourceRefId) => `source-ref:${sourceRefId}`),
          ...record.recipe.sourceRefIds.map((sourceRefId) => `source-ref:${sourceRefId}`),
        ]);
        await Promise.all([persistence.contextIndex.flush(), persistence.searchIndex.flush()]);

        return stableResult({
          status: "completed",
          operation: "reject",
          workspace,
          warnings,
          records: [summarizeLifecycleRecord(record)],
          message: "Knowledge candidate rejected.",
        });
      }
    }
  } catch (error) {
    warnings.push("knowledge_lifecycle_operation_failed");
    return stableResult({
      status: "error",
      operation: parsed.input.operation,
      workspace,
      warnings,
      message: error instanceof Error ? error.message : "alembic_knowledge failed.",
    });
  }
}

function parseKnowledgeInput(args: Record<string, unknown>):
  | { readonly status: "ok"; readonly input: ParsedKnowledgeInput; readonly projectRoot?: string }
  | {
      readonly status: "invalid-input";
      readonly operation: CodexKnowledgeOperation;
      readonly projectRoot?: string;
      readonly message: string;
    } {
  const projectRoot = stringValue(args.projectRoot);
  const operation = stringValue(args.operation) ?? "list";
  const normalizedOperation = isKnowledgeOperation(operation) ? operation : null;
  if (!normalizedOperation) {
    return {
      status: "invalid-input",
      operation: "list",
      ...(projectRoot ? { projectRoot } : {}),
      message: `Unsupported alembic_knowledge operation: ${operation}`,
    };
  }

  const rawStatus = stringValue(args.status);
  if (rawStatus && !isKnowledgeStatus(rawStatus)) {
    return {
      status: "invalid-input",
      operation: normalizedOperation,
      ...(projectRoot ? { projectRoot } : {}),
      message: `Unsupported alembic_knowledge status: ${rawStatus}`,
    };
  }
  const status = rawStatus && isKnowledgeStatus(rawStatus) ? rawStatus : undefined;

  const recipeId = stringValue(args.recipeId) ?? stringValue(args.id);
  if ((normalizedOperation === "publish" || normalizedOperation === "reject") && !recipeId) {
    return {
      status: "invalid-input",
      operation: normalizedOperation,
      ...(projectRoot ? { projectRoot } : {}),
      message: `alembic_knowledge ${normalizedOperation} requires recipeId or id.`,
    };
  }
  const reason = stringValue(args.reason);
  const publishedBy = stringValue(args.publishedBy ?? args.reviewer);
  const rejectedBy = stringValue(args.rejectedBy ?? args.reviewer);

  return {
    status: "ok",
    ...(projectRoot ? { projectRoot } : {}),
    input: {
      operation: normalizedOperation,
      ...(projectRoot ? { projectRoot } : {}),
      ...(status ? { status } : {}),
      ...(recipeId ? { recipeId } : {}),
      ...(reason ? { reason } : {}),
      ...(publishedBy ? { publishedBy } : {}),
      ...(rejectedBy ? { rejectedBy } : {}),
      limit: boundedInteger(args.limit, 1, MAX_LIMIT) ?? DEFAULT_LIMIT,
    },
  };
}

function stableResult(input: {
  readonly status: CodexKnowledgeResultStatus;
  readonly operation: CodexKnowledgeOperation;
  readonly workspace: ReturnType<typeof inspectWorkspace>;
  readonly warnings: readonly string[];
  readonly records?: readonly CodexKnowledgeRecord[];
  readonly message?: string | undefined;
}): CodexKnowledgeResult {
  const records = input.records ?? [];
  return {
    status: input.status,
    operation: input.operation,
    records,
    items: records,
    warnings: input.warnings,
    dataRoot: input.workspace.dataRoot,
    projectRoot: input.workspace.projectRoot,
    ...(input.message ? { message: input.message } : {}),
  };
}

function summarizeLifecycleRecord(record: RecipeLifecycleRecord): CodexKnowledgeRecord {
  return {
    id: record.id,
    status: record.status,
    title: record.recipe.title,
    kind: record.recipe.kind,
    summary: record.recipe.summary,
    tags: record.recipe.tags,
    sourceRefIds: record.recipe.sourceRefIds,
    confidence: record.recipe.confidence,
    ...(record.recipe.trigger ? { trigger: record.recipe.trigger } : {}),
    ...(record.recipe.updatedAt === undefined ? {} : { updatedAt: record.recipe.updatedAt }),
    metadata: { ...record.metadata },
    ...(record.file
      ? {
          file: {
            bucket: record.file.bucket,
            relativePath: record.file.relativePath,
            path: record.file.absolutePath,
            contentHash: record.file.contentHash,
          },
        }
      : {}),
  };
}

function recipeFilesFromRecord(record: RecipeLifecycleRecord): RecipeMarkdownFileIndex[] {
  if (!record.file) {
    return [];
  }
  return [
    {
      recipeId: record.id,
      bucket: record.file.bucket,
      relativePath: record.file.relativePath,
      contentHash: record.file.contentHash,
      ...(record.metadata.updatedAt === undefined ? {} : { updatedAt: record.metadata.updatedAt }),
    },
  ];
}

function isKnowledgeOperation(value: string): value is CodexKnowledgeOperation {
  return KNOWLEDGE_OPERATIONS.has(value);
}

function isKnowledgeStatus(value: string): value is CodexKnowledgeStatusFilter {
  return KNOWLEDGE_STATUSES.has(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}
