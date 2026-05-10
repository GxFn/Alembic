import type { MainlineWriteBoundary } from "../core/index.js";
import {
  epochSecondsNow,
  MainlineAtomicFileStore,
  MainlineValidationError,
} from "../core/index.js";
import { createRecipe, type Recipe } from "./Recipe.js";
import {
  type RecipeMarkdownReadFile,
  RecipeMarkdownStore,
  type RecipeMarkdownWriteResult,
} from "./RecipeMarkdownStore.js";

export type RecipeLifecycleStatus = "candidate" | "active" | "rejected";

export interface RecipeLifecycleMetadata {
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly submittedBy?: string;
  readonly publishedAt?: number;
  readonly publishedBy?: string;
  readonly rejectedAt?: number;
  readonly rejectedBy?: string;
  readonly rejectionReason?: string;
}

export interface RecipeLifecycleRecord {
  readonly id: string;
  readonly status: RecipeLifecycleStatus;
  readonly recipe: Recipe;
  readonly metadata: RecipeLifecycleMetadata;
  readonly file?: RecipeMarkdownReadFile;
}

export interface RecipeLifecycleStorePort {
  writeCandidate(
    recipe: Recipe,
    options?: RecipeLifecycleCandidateOptions,
  ): Promise<RecipeLifecycleRecord>;
  publish(
    recipeId: string,
    options?: RecipeLifecyclePublishOptions,
  ): Promise<RecipeLifecycleRecord>;
  reject(recipeId: string, options?: RecipeLifecycleRejectOptions): Promise<RecipeLifecycleRecord>;
  list(options?: RecipeLifecycleListOptions): Promise<RecipeLifecycleRecord[]>;
  load(
    recipeId: string,
    options?: RecipeLifecycleLoadOptions,
  ): Promise<RecipeLifecycleRecord | null>;
}

export interface RecipeLifecycleStoreDependencies {
  readonly markdownStore?: RecipeMarkdownStore;
  readonly fileStore?: MainlineAtomicFileStore;
}

export interface RecipeLifecycleTransitionOptions {
  readonly now?: number;
}

export interface RecipeLifecycleCandidateOptions extends RecipeLifecycleTransitionOptions {
  readonly submittedBy?: string;
}

export interface RecipeLifecyclePublishOptions extends RecipeLifecycleTransitionOptions {
  readonly publishedBy?: string;
}

export interface RecipeLifecycleRejectOptions extends RecipeLifecycleTransitionOptions {
  readonly rejectedBy?: string;
  readonly reason?: string;
}

export interface RecipeLifecycleListOptions {
  readonly status?: RecipeLifecycleStatus | readonly RecipeLifecycleStatus[] | "all";
  readonly limit?: number;
}

export interface RecipeLifecycleLoadOptions {
  readonly status?: RecipeLifecycleStatus | readonly RecipeLifecycleStatus[] | "all";
}

const LIFECYCLE_METADATA_KEY = "recipeLifecycle";

/**
 * RecipeLifecycleStore 管理 Recipe 从 candidate 到 active/rejected 的最小状态机。
 * 中文注释：candidate 是待审核草稿，只能留在候选边界；只有 publish() 会创建 active
 * 记录并进入默认可用集合，避免 prime/guard/search 自动消费未发布知识。
 */
export class RecipeLifecycleStore implements RecipeLifecycleStorePort {
  readonly #markdownStore: RecipeMarkdownStore;

  constructor(
    writeBoundary: MainlineWriteBoundary,
    dependencies: RecipeLifecycleStoreDependencies = {},
  ) {
    this.#markdownStore =
      dependencies.markdownStore ??
      new RecipeMarkdownStore(writeBoundary, {
        fileStore: dependencies.fileStore ?? new MainlineAtomicFileStore(),
      });
  }

  async writeCandidate(
    recipe: Recipe,
    options: RecipeLifecycleCandidateOptions = {},
  ): Promise<RecipeLifecycleRecord> {
    const existingActive = await this.load(recipe.id, { status: "active" });
    if (existingActive) {
      throw new MainlineValidationError("Cannot write a candidate over an active Recipe.", {
        recipeId: recipe.id,
      });
    }

    const now = options.now ?? epochSecondsNow();
    const existingMetadata = lifecycleMetadata(recipe);
    const next = withLifecycle(recipe, "candidate", {
      ...existingMetadata,
      createdAt: existingMetadata.createdAt ?? now,
      updatedAt: now,
      ...(options.submittedBy === undefined ? {} : { submittedBy: options.submittedBy }),
    });
    const write = await this.#markdownStore.write(next);
    return recordFromWrite(next, "candidate", write);
  }

  async publish(
    recipeId: string,
    options: RecipeLifecyclePublishOptions = {},
  ): Promise<RecipeLifecycleRecord> {
    const candidate = await this.load(recipeId, { status: "candidate" });
    if (!candidate) {
      throw new MainlineValidationError("Cannot publish a missing candidate Recipe.", {
        recipeId,
      });
    }

    const now = options.now ?? epochSecondsNow();
    const next = withLifecycle(candidate.recipe, "active", {
      ...candidate.metadata,
      updatedAt: now,
      publishedAt: now,
      ...(options.publishedBy === undefined ? {} : { publishedBy: options.publishedBy }),
    });
    const write = await this.#markdownStore.write(next);
    if (candidate.file) {
      await this.#markdownStore.deleteFile(candidate.file);
    }
    return recordFromWrite(next, "active", write);
  }

  async reject(
    recipeId: string,
    options: RecipeLifecycleRejectOptions = {},
  ): Promise<RecipeLifecycleRecord> {
    const candidate = await this.load(recipeId, { status: "candidate" });
    if (!candidate) {
      throw new MainlineValidationError("Cannot reject a missing candidate Recipe.", {
        recipeId,
      });
    }

    const now = options.now ?? epochSecondsNow();
    const next = withLifecycle(candidate.recipe, "rejected", {
      ...candidate.metadata,
      updatedAt: now,
      rejectedAt: now,
      ...(options.rejectedBy === undefined ? {} : { rejectedBy: options.rejectedBy }),
      ...(options.reason === undefined ? {} : { rejectionReason: options.reason }),
    });
    const write = await this.#markdownStore.write(next);
    return recordFromWrite(next, "rejected", write);
  }

  async list(options: RecipeLifecycleListOptions = {}): Promise<RecipeLifecycleRecord[]> {
    const statuses = lifecycleStatusFilter(options.status);
    const loaded = await this.#markdownStore.loadAll();
    const records = loaded.recipes
      .flatMap((recipe, index) => {
        const status = lifecycleStatus(recipe);
        if (!status || !statuses.has(status)) {
          return [];
        }
        return [recordFromRead(recipe, status, loaded.files[index])];
      })
      .sort(compareLifecycleRecords);

    return options.limit == null || options.limit <= 0 ? records : records.slice(0, options.limit);
  }

  async load(
    recipeId: string,
    options: RecipeLifecycleLoadOptions = {},
  ): Promise<RecipeLifecycleRecord | null> {
    const records = await this.list({ status: options.status ?? "active" });
    return records.find((record) => record.id === recipeId) ?? null;
  }
}

function withLifecycle(
  recipe: Recipe,
  status: RecipeLifecycleStatus,
  metadata: RecipeLifecycleMetadata,
): Recipe {
  return createRecipe({
    ...recipe,
    status,
    updatedAt: metadata.updatedAt ?? recipe.updatedAt,
    metadata: {
      ...recipe.metadata,
      [LIFECYCLE_METADATA_KEY]: metadata,
    },
  });
}

function recordFromWrite(
  recipe: Recipe,
  status: RecipeLifecycleStatus,
  write: RecipeMarkdownWriteResult,
): RecipeLifecycleRecord {
  return {
    id: recipe.id,
    status,
    recipe,
    metadata: lifecycleMetadata(recipe),
    file: {
      recipeId: write.recipeId,
      bucket: write.bucket,
      relativePath: write.relativePath,
      absolutePath: write.absolutePath,
      contentHash: write.contentHash,
    },
  };
}

function recordFromRead(
  recipe: Recipe,
  status: RecipeLifecycleStatus,
  file: RecipeMarkdownReadFile | undefined,
): RecipeLifecycleRecord {
  return {
    id: recipe.id,
    status,
    recipe,
    metadata: lifecycleMetadata(recipe),
    ...(file === undefined ? {} : { file }),
  };
}

function lifecycleStatus(recipe: Recipe): RecipeLifecycleStatus | null {
  switch (recipe.status) {
    case "candidate":
    case "active":
    case "rejected":
      return recipe.status;
    case "stale":
    case "superseded":
      return null;
  }
}

function lifecycleStatusFilter(
  status: RecipeLifecycleListOptions["status"],
): ReadonlySet<RecipeLifecycleStatus> {
  if (status === undefined) {
    return new Set(["active"]);
  }
  if (status === "all") {
    return new Set(["candidate", "active", "rejected"]);
  }
  return new Set(Array.isArray(status) ? status : [status]);
}

function lifecycleMetadata(recipe: Recipe): RecipeLifecycleMetadata {
  const raw = recordValue(recipe.metadata?.[LIFECYCLE_METADATA_KEY]);
  return compactLifecycleMetadata({
    createdAt: numberValue(raw.createdAt),
    updatedAt: numberValue(raw.updatedAt) ?? recipe.updatedAt,
    submittedBy: stringValue(raw.submittedBy),
    publishedAt: numberValue(raw.publishedAt),
    publishedBy: stringValue(raw.publishedBy),
    rejectedAt: numberValue(raw.rejectedAt),
    rejectedBy: stringValue(raw.rejectedBy),
    rejectionReason: stringValue(raw.rejectionReason),
  });
}

function compactLifecycleMetadata(metadata: {
  readonly createdAt?: number | undefined;
  readonly updatedAt?: number | undefined;
  readonly submittedBy?: string | undefined;
  readonly publishedAt?: number | undefined;
  readonly publishedBy?: string | undefined;
  readonly rejectedAt?: number | undefined;
  readonly rejectedBy?: string | undefined;
  readonly rejectionReason?: string | undefined;
}): RecipeLifecycleMetadata {
  return {
    ...(metadata.createdAt === undefined ? {} : { createdAt: metadata.createdAt }),
    ...(metadata.updatedAt === undefined ? {} : { updatedAt: metadata.updatedAt }),
    ...(metadata.submittedBy === undefined ? {} : { submittedBy: metadata.submittedBy }),
    ...(metadata.publishedAt === undefined ? {} : { publishedAt: metadata.publishedAt }),
    ...(metadata.publishedBy === undefined ? {} : { publishedBy: metadata.publishedBy }),
    ...(metadata.rejectedAt === undefined ? {} : { rejectedAt: metadata.rejectedAt }),
    ...(metadata.rejectedBy === undefined ? {} : { rejectedBy: metadata.rejectedBy }),
    ...(metadata.rejectionReason === undefined
      ? {}
      : { rejectionReason: metadata.rejectionReason }),
  };
}

function compareLifecycleRecords(
  left: RecipeLifecycleRecord,
  right: RecipeLifecycleRecord,
): number {
  return (
    lifecycleStatusRank(left.status) - lifecycleStatusRank(right.status) ||
    left.id.localeCompare(right.id)
  );
}

function lifecycleStatusRank(status: RecipeLifecycleStatus): number {
  switch (status) {
    case "active":
      return 0;
    case "candidate":
      return 1;
    case "rejected":
      return 2;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
