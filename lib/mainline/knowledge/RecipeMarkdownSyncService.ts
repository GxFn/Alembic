import { epochSecondsNow, normalizeMainlinePosixPath } from "../core/index.js";
import type {
  ContextIndexReader,
  ContextIndexSnapshot,
  ContextIndexWriter,
  RecipeMarkdownFileIndex,
} from "../data/index.js";
import type { Recipe } from "./Recipe.js";
import {
  type RecipeMarkdownLoadWarning,
  type RecipeMarkdownReadFile,
  type RecipeMarkdownStore,
  recipeMarkdownBucket,
} from "./RecipeMarkdownStore.js";

export interface RecipeMarkdownSyncContextIndex
  extends ContextIndexReader,
    Pick<ContextIndexWriter, "upsertContextArtifacts"> {
  snapshot(): ContextIndexSnapshot;
}

export interface RecipeMarkdownSyncServiceDependencies {
  readonly now?: () => number;
}

export interface RecipeMarkdownSyncReport {
  readonly loaded: number;
  readonly upserted: number;
  readonly unchanged: number;
  readonly staleFiles: readonly RecipeMarkdownSyncStaleFile[];
  readonly conflicts: readonly RecipeMarkdownSyncConflict[];
  readonly warnings: readonly RecipeMarkdownSyncWarning[];
}

export interface RecipeMarkdownSyncStaleFile {
  readonly recipeId: string;
  readonly bucket: RecipeMarkdownFileIndex["bucket"];
  readonly relativePath: string;
  readonly contentHash: string;
  readonly updatedAt?: number;
}

export interface RecipeMarkdownSyncConflict {
  readonly recipeId: string;
  readonly paths: readonly string[];
  readonly message: string;
}

export interface RecipeMarkdownSyncWarning {
  readonly recipeId?: string;
  readonly bucket?: string;
  readonly relativePath?: string;
  readonly message: string;
}

/**
 * RecipeMarkdownSyncService reconciles the human-maintained Markdown layer into ContextIndex.
 * It only performs safe upserts for unambiguous Markdown files; stale DB file indexes and
 * multi-path recipe ids are reported for a later repair pass instead of being deleted.
 */
export class RecipeMarkdownSyncService {
  readonly #store: RecipeMarkdownStore;
  readonly #index: RecipeMarkdownSyncContextIndex;
  readonly #now: () => number;

  constructor(
    store: RecipeMarkdownStore,
    index: RecipeMarkdownSyncContextIndex,
    dependencies: RecipeMarkdownSyncServiceDependencies = {},
  ) {
    this.#store = store;
    this.#index = index;
    this.#now = dependencies.now ?? epochSecondsNow;
  }

  async sync(): Promise<RecipeMarkdownSyncReport> {
    const loaded = await this.#store.loadAll();
    const warnings = loaded.warnings.map(syncWarningFromLoadWarning);
    const recipesById = uniqueRecipesById(loaded.recipes);
    const filesByRecipeId = groupFilesByRecipeId(loaded.files);
    const conflicts = recipeFileConflicts(filesByRecipeId);
    const conflictedRecipeIds = new Set(conflicts.map((conflict) => conflict.recipeId));
    const loadedRecipeIds = uniqueStrings(loaded.files.map((file) => file.recipeId));
    const indexedRecipeIds = uniqueStrings([
      ...this.#index.snapshot().recipes.map((recipe) => recipe.id),
      ...loadedRecipeIds,
    ]);
    const indexedFiles = await this.#index.findRecipeFilesByRecipeIds(indexedRecipeIds);
    const indexedFilesByRecipeId = new Map(indexedFiles.map((file) => [file.recipeId, file]));
    const knownMarkdownPaths = new Set(
      [
        ...loaded.files.map((file) => file.relativePath),
        ...loaded.warnings.map((warning) => warning.relativePath),
      ]
        .map(normalizeMainlinePosixPath)
        .filter(Boolean),
    );
    const staleFiles = indexedFiles
      .filter((file) => !knownMarkdownPaths.has(normalizeMainlinePosixPath(file.relativePath)))
      .map(syncStaleFile);

    const filesToUpsert: RecipeMarkdownFileIndex[] = [];
    const recipesToUpsert: Recipe[] = [];
    let unchanged = 0;

    for (const file of loaded.files) {
      if (conflictedRecipeIds.has(file.recipeId)) {
        continue;
      }

      const recipe = recipesById.get(file.recipeId);
      if (!recipe) {
        warnings.push({
          recipeId: file.recipeId,
          bucket: file.bucket,
          relativePath: file.relativePath,
          message: `Recipe Markdown file ${file.relativePath} parsed without a matching Recipe payload.`,
        });
        continue;
      }

      warnings.push(...validateLoadedFile(file, recipe, indexedFilesByRecipeId.get(file.recipeId)));

      const indexedFile = indexedFilesByRecipeId.get(file.recipeId);
      if (indexedFile && sameRecipeFileIndex(indexedFile, file)) {
        unchanged += 1;
        continue;
      }

      recipesToUpsert.push(recipe);
      filesToUpsert.push(recipeFileIndexFromReadFile(file, this.#now()));
    }

    if (recipesToUpsert.length > 0 || filesToUpsert.length > 0) {
      await this.#index.upsertContextArtifacts({
        recipes: recipesToUpsert,
        recipeFiles: filesToUpsert,
      });
    }

    return {
      loaded: loaded.recipes.length,
      upserted: filesToUpsert.length,
      unchanged,
      staleFiles,
      conflicts,
      warnings,
    };
  }
}

function syncWarningFromLoadWarning(warning: RecipeMarkdownLoadWarning): RecipeMarkdownSyncWarning {
  return {
    bucket: warning.bucket,
    relativePath: warning.relativePath,
    message: warning.message,
  };
}

function uniqueRecipesById(recipes: readonly Recipe[]): Map<string, Recipe> {
  const values = new Map<string, Recipe>();
  for (const recipe of recipes) {
    if (!values.has(recipe.id)) {
      values.set(recipe.id, recipe);
    }
  }
  return values;
}

function groupFilesByRecipeId(
  files: readonly RecipeMarkdownReadFile[],
): Map<string, RecipeMarkdownReadFile[]> {
  const groups = new Map<string, RecipeMarkdownReadFile[]>();
  for (const file of files) {
    const group = groups.get(file.recipeId) ?? [];
    group.push(file);
    groups.set(file.recipeId, group);
  }
  return groups;
}

function recipeFileConflicts(
  filesByRecipeId: ReadonlyMap<string, readonly RecipeMarkdownReadFile[]>,
): RecipeMarkdownSyncConflict[] {
  const conflicts: RecipeMarkdownSyncConflict[] = [];
  for (const [recipeId, files] of filesByRecipeId) {
    const paths = uniqueStrings(files.map((file) => file.relativePath));
    if (paths.length <= 1) {
      continue;
    }
    conflicts.push({
      recipeId,
      paths,
      message: `Recipe ${recipeId} is present in multiple Markdown files.`,
    });
  }
  return conflicts;
}

function validateLoadedFile(
  file: RecipeMarkdownReadFile,
  recipe: Recipe,
  indexedFile: RecipeMarkdownFileIndex | undefined,
): RecipeMarkdownSyncWarning[] {
  const warnings: RecipeMarkdownSyncWarning[] = [];
  const expectedBucket = recipeMarkdownBucket(recipe);
  if (file.bucket !== expectedBucket) {
    warnings.push({
      recipeId: file.recipeId,
      bucket: file.bucket,
      relativePath: file.relativePath,
      message: `Recipe status ${recipe.status} expects Markdown bucket ${expectedBucket}, but file is under ${file.bucket}.`,
    });
  }

  if (!normalizeMainlinePosixPath(file.relativePath).startsWith(`Alembic/${file.bucket}/`)) {
    warnings.push({
      recipeId: file.recipeId,
      bucket: file.bucket,
      relativePath: file.relativePath,
      message: `Recipe Markdown path ${file.relativePath} does not match bucket ${file.bucket}.`,
    });
  }

  if (indexedFile && !sameRecipeFilePath(indexedFile, file)) {
    warnings.push({
      recipeId: file.recipeId,
      bucket: file.bucket,
      relativePath: file.relativePath,
      message: `ContextIndex recipe file path ${indexedFile.relativePath} differs from loaded Markdown path ${file.relativePath}.`,
    });
  }
  return warnings;
}

function sameRecipeFileIndex(
  indexedFile: RecipeMarkdownFileIndex,
  loadedFile: RecipeMarkdownReadFile,
): boolean {
  return (
    sameRecipeFilePath(indexedFile, loadedFile) &&
    indexedFile.contentHash === loadedFile.contentHash
  );
}

function sameRecipeFilePath(
  indexedFile: RecipeMarkdownFileIndex,
  loadedFile: RecipeMarkdownReadFile,
): boolean {
  return (
    indexedFile.bucket === loadedFile.bucket &&
    normalizeMainlinePosixPath(indexedFile.relativePath) ===
      normalizeMainlinePosixPath(loadedFile.relativePath)
  );
}

function recipeFileIndexFromReadFile(
  file: RecipeMarkdownReadFile,
  updatedAt: number,
): RecipeMarkdownFileIndex {
  return {
    recipeId: file.recipeId,
    bucket: file.bucket,
    relativePath: normalizeMainlinePosixPath(file.relativePath),
    contentHash: file.contentHash,
    updatedAt,
  };
}

function syncStaleFile(file: RecipeMarkdownFileIndex): RecipeMarkdownSyncStaleFile {
  return {
    recipeId: file.recipeId,
    bucket: file.bucket,
    relativePath: file.relativePath,
    contentHash: file.contentHash,
    ...(file.updatedAt === undefined ? {} : { updatedAt: file.updatedAt }),
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
