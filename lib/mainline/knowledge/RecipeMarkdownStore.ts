import fs from "node:fs/promises";
import path from "node:path";
import {
  computeMainlineContentHash,
  MainlineAtomicFileStore,
  type MainlineWriteBoundary,
} from "../core/index.js";
import type { Recipe } from "./Recipe.js";
import { RecipeMarkdownCodec } from "./RecipeMarkdownCodec.js";

export type RecipeMarkdownBucket = "candidates" | "recipes";

const RECIPE_MARKDOWN_BUCKETS: readonly RecipeMarkdownBucket[] = ["candidates", "recipes"];

export interface RecipeMarkdownWriteResult {
  readonly recipeId: string;
  readonly bucket: RecipeMarkdownBucket;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly contentHash: string;
}

export interface RecipeMarkdownReadFile {
  readonly recipeId: string;
  readonly bucket: RecipeMarkdownBucket;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly contentHash: string;
}

export interface RecipeMarkdownLoadWarning {
  readonly bucket: RecipeMarkdownBucket;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly message: string;
}

export interface RecipeMarkdownLoadResult {
  readonly recipes: readonly Recipe[];
  readonly files: readonly RecipeMarkdownReadFile[];
  readonly warnings: readonly RecipeMarkdownLoadWarning[];
}

export interface RecipeMarkdownStoreDependencies {
  readonly codec?: RecipeMarkdownCodec;
  readonly fileStore?: MainlineAtomicFileStore;
}

/**
 * RecipeMarkdownStore 是 Recipe 的轻量文件外显层。
 * 中文注释：它只负责把已归一化 Recipe 读写为 Ghost dataRoot 下的 Markdown；
 * 不参与 DB、搜索、AI 生成或审核状态机，避免把旧 KnowledgeService 搬进新主线。
 */
export class RecipeMarkdownStore {
  readonly #writeBoundary: MainlineWriteBoundary;
  readonly #codec: RecipeMarkdownCodec;
  readonly #fileStore: MainlineAtomicFileStore;

  constructor(
    writeBoundary: MainlineWriteBoundary,
    dependencies: RecipeMarkdownStoreDependencies = {},
  ) {
    this.#writeBoundary = writeBoundary;
    this.#codec = dependencies.codec ?? new RecipeMarkdownCodec();
    this.#fileStore = dependencies.fileStore ?? new MainlineAtomicFileStore();
  }

  async write(recipe: Recipe): Promise<RecipeMarkdownWriteResult> {
    const bucket = recipeMarkdownBucket(recipe);
    const relativePath = recipeMarkdownRelativePath(recipe);
    const target = this.#writeBoundary.knowledge(relativePath);
    const markdown = this.#codec.toMarkdown(stripMarkdownSourceMetadata(recipe));
    await this.#fileStore.writeTextAtomic(target, markdown);

    return {
      recipeId: recipe.id,
      bucket,
      relativePath: target.relative,
      absolutePath: target.absolute,
      contentHash: computeMainlineContentHash(markdown),
    };
  }

  async writeMany(recipes: readonly Recipe[]): Promise<RecipeMarkdownWriteResult[]> {
    const results: RecipeMarkdownWriteResult[] = [];
    for (const recipe of recipes) {
      results.push(await this.write(recipe));
    }
    return results;
  }

  async loadAll(): Promise<RecipeMarkdownLoadResult> {
    const recipes: Recipe[] = [];
    const files: RecipeMarkdownReadFile[] = [];
    const warnings: RecipeMarkdownLoadWarning[] = [];

    for (const bucket of RECIPE_MARKDOWN_BUCKETS) {
      const base = this.#writeBoundary.knowledge(bucket);
      for (const absolutePath of await listMarkdownFiles(base.absolute)) {
        const relativeInsideBucket = toPosix(path.relative(base.absolute, absolutePath));
        const target = this.#writeBoundary.knowledge(path.posix.join(bucket, relativeInsideBucket));
        try {
          const markdown = await fs.readFile(target.absolute, "utf8");
          const contentHash = computeMainlineContentHash(markdown);
          const recipe = this.#codec.toRecipe(markdown);
          recipes.push(recipe);
          files.push({
            recipeId: recipe.id,
            bucket,
            relativePath: target.relative,
            absolutePath: target.absolute,
            contentHash,
          });
        } catch (error) {
          warnings.push({
            bucket,
            relativePath: target.relative,
            absolutePath: target.absolute,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return { recipes, files, warnings };
  }
}

export function recipeMarkdownBucket(recipe: Recipe): RecipeMarkdownBucket {
  return recipe.status === "active" || recipe.status === "stale" || recipe.status === "superseded"
    ? "recipes"
    : "candidates";
}

export function recipeMarkdownRelativePath(recipe: Recipe): string {
  const bucket = recipeMarkdownBucket(recipe);
  const group = slugSegment(
    recipe.dimensionIds[0] ?? recipe.knowledge?.classification.category ?? recipe.kind,
  );
  const basename = slugSegment(recipe.trigger ?? recipe.title ?? recipe.id);
  const identity = slugSegment(recipe.id).slice(0, 48);
  return path.posix.join(bucket, group, `${basename}-${identity}.md`);
}

function stripMarkdownSourceMetadata(recipe: Recipe): Recipe {
  if (!recipe.metadata || !("markdownSource" in recipe.metadata)) {
    return recipe;
  }
  const { markdownSource: _markdownSource, ...metadata } = recipe.metadata;
  return {
    ...recipe,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

function slugSegment(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "recipe";
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  let entries: DirectoryEntry[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(absolutePath)));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(absolutePath);
    }
  }
  return files;
}

interface DirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
