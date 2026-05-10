import type {
  ArtifactStores,
  CompiledContextSnapshot,
  Recipe,
  RecipeEdge,
  RecipeEdgeStore,
  RecipeFileStore,
  RecipeMarkdownFileIndex,
  RecipeStore,
  SourceRef,
  SourceRefStore,
} from "./ArtifactStores.js";

/**
 * ContextIndex 是编译期和运行期之间的 data boundary。
 * 写入边界：编译期只拿 ContextIndexWriter 写 artifact，运行期只拿 ContextIndexReader 读 artifact。
 */
export type ContextIndexSnapshot = CompiledContextSnapshot;

export interface ContextIndexReader {
  findRecipesByFiles(files: readonly string[], limit?: number): Promise<Recipe[]>;
  findRecipesByMarkdownPaths(paths: readonly string[], limit?: number): Promise<Recipe[]>;
  findRecipeFilesByRecipeIds(recipeIds: readonly string[]): Promise<RecipeMarkdownFileIndex[]>;
  findRecipeEdges(recipeIds: readonly string[]): Promise<RecipeEdge[]>;
  findSourceRefs(recipeIds: readonly string[]): Promise<SourceRef[]>;
}

export interface ContextIndexWriter
  extends Pick<SourceRefStore, "upsertSourceRefs">,
    Pick<RecipeStore, "upsertRecipes" | "deleteRecipes">,
    Pick<RecipeFileStore, "upsertRecipeFiles">,
    Pick<RecipeEdgeStore, "upsertEdges"> {
  upsertContextArtifacts(batch: ContextIndexWriteBatch): Promise<ContextIndexWriteResult>;
}

export interface ContextIndexWriteBatch {
  readonly recipes?: readonly Recipe[];
  readonly recipeFiles?: readonly RecipeMarkdownFileIndex[];
  readonly edges?: readonly RecipeEdge[];
  readonly sourceRefs?: readonly SourceRef[];
}

export interface ContextIndexWriteResult {
  readonly recipeCount: number;
  readonly recipeFileCount: number;
  readonly edgeCount: number;
  readonly sourceRefCount: number;
}

export interface ContextIndex extends ContextIndexReader, ContextIndexWriter, ArtifactStores {}

export class InMemoryContextIndex implements ContextIndex {
  readonly #recipes = new Map<string, Recipe>();
  readonly #recipeFiles = new Map<string, RecipeMarkdownFileIndex>();
  readonly #edges = new Map<string, RecipeEdge>();
  readonly #sourceRefs = new Map<string, SourceRef>();

  constructor(snapshot?: Partial<ContextIndexSnapshot>) {
    for (const recipe of snapshot?.recipes ?? []) {
      this.#recipes.set(recipe.id, recipe);
    }
    for (const edge of snapshot?.edges ?? []) {
      this.#edges.set(edge.id, edge);
    }
    for (const sourceRef of snapshot?.sourceRefs ?? []) {
      this.#sourceRefs.set(sourceRef.id, sourceRef);
    }
  }

  async findRecipesByFiles(files: readonly string[], limit = 20): Promise<Recipe[]> {
    const sourceRefs = await this.findSourceRefsByPaths(files);
    return this.findRecipesBySourceRefIds(
      sourceRefs.map((sourceRef) => sourceRef.id),
      limit,
    );
  }

  async listRecipes(limit?: number): Promise<Recipe[]> {
    const recipes = [...this.#recipes.values()];
    return limit == null || limit <= 0 ? recipes : recipes.slice(0, limit);
  }

  async findRecipeEdges(recipeIds: readonly string[]): Promise<RecipeEdge[]> {
    const idSet = new Set(recipeIds);
    return [...this.#edges.values()].filter(
      (edge) => idSet.has(edge.fromRecipeId) || idSet.has(edge.toRecipeId),
    );
  }

  async findRecipeEdgesByIds(edgeIds: readonly string[]): Promise<RecipeEdge[]> {
    return uniqueByInputOrder(edgeIds, (edgeId) => this.#edges.get(edgeId));
  }

  async findSourceRefs(recipeIds: readonly string[]): Promise<SourceRef[]> {
    const sourceRefIds = new Set<string>();
    for (const recipeId of recipeIds) {
      for (const sourceRefId of this.#recipes.get(recipeId)?.sourceRefIds ?? []) {
        sourceRefIds.add(sourceRefId);
      }
    }
    return this.findSourceRefsByIds([...sourceRefIds]);
  }

  async findSourceRefsByIds(sourceRefIds: readonly string[]): Promise<SourceRef[]> {
    return uniqueByInputOrder(sourceRefIds, (sourceRefId) => this.#sourceRefs.get(sourceRefId));
  }

  async findSourceRefsByPaths(paths: readonly string[]): Promise<SourceRef[]> {
    const pathSet = new Set(paths);
    return [...this.#sourceRefs.values()].filter((sourceRef) =>
      pathSet.has(sourceRef.location.path),
    );
  }

  async findRecipesByIds(recipeIds: readonly string[]): Promise<Recipe[]> {
    return uniqueByInputOrder(recipeIds, (recipeId) => this.#recipes.get(recipeId));
  }

  async findRecipeFilesByRecipeIds(
    recipeIds: readonly string[],
  ): Promise<RecipeMarkdownFileIndex[]> {
    return uniqueByInputOrder(recipeIds, (recipeId) => this.#recipeFiles.get(recipeId));
  }

  async findRecipesByMarkdownPaths(paths: readonly string[], limit = 20): Promise<Recipe[]> {
    const pathSet = new Set(paths);
    const recipeIds: string[] = [];
    for (const file of this.#recipeFiles.values()) {
      if (pathSet.has(file.relativePath)) {
        recipeIds.push(file.recipeId);
      }
      if (recipeIds.length >= limit) {
        break;
      }
    }
    return this.findRecipesByIds(recipeIds);
  }

  async findRecipesBySourceRefIds(sourceRefIds: readonly string[], limit = 20): Promise<Recipe[]> {
    const sourceRefIdSet = new Set(sourceRefIds);
    const recipes: Recipe[] = [];
    for (const recipe of this.#recipes.values()) {
      if (recipe.sourceRefIds.some((sourceRefId) => sourceRefIdSet.has(sourceRefId))) {
        recipes.push(recipe);
      }
      if (recipes.length >= limit) {
        break;
      }
    }
    return recipes;
  }

  async upsertRecipes(recipes: readonly Recipe[]): Promise<void> {
    await this.upsertContextArtifacts({ recipes });
  }

  async deleteRecipes(recipeIds: readonly string[]) {
    const recipeIdsToDelete = uniqueStrings(recipeIds);
    const recipeFiles = await this.findRecipeFilesByRecipeIds(recipeIdsToDelete);
    const sourceRefs = await this.findSourceRefs(recipeIdsToDelete);
    const candidateSourceRefIds = new Set(sourceRefs.map((sourceRef) => sourceRef.id));
    const deletedRecipeIds: string[] = [];

    for (const recipeId of recipeIdsToDelete) {
      if (!this.#recipes.has(recipeId)) {
        continue;
      }
      deletedRecipeIds.push(recipeId);
      this.#recipes.delete(recipeId);
      this.#recipeFiles.delete(recipeId);
    }

    const deletedRecipeIdSet = new Set(deletedRecipeIds);
    for (const edge of [...this.#edges.values()]) {
      if (deletedRecipeIdSet.has(edge.fromRecipeId) || deletedRecipeIdSet.has(edge.toRecipeId)) {
        this.#edges.delete(edge.id);
      }
    }

    for (const recipe of this.#recipes.values()) {
      for (const sourceRefId of recipe.sourceRefIds) {
        candidateSourceRefIds.delete(sourceRefId);
      }
    }
    const deletedSourceRefIds = [...candidateSourceRefIds].filter((sourceRefId) =>
      isSourceRefOwnedByDeletedRecipe(this.#sourceRefs.get(sourceRefId), deletedRecipeIdSet),
    );
    for (const sourceRefId of deletedSourceRefIds) {
      this.#sourceRefs.delete(sourceRefId);
    }

    return { recipeIds: deletedRecipeIds, sourceRefIds: deletedSourceRefIds, recipeFiles };
  }

  async upsertRecipeFiles(files: readonly RecipeMarkdownFileIndex[]): Promise<void> {
    await this.upsertContextArtifacts({ recipeFiles: files });
  }

  async upsertEdges(edges: readonly RecipeEdge[]): Promise<void> {
    await this.upsertContextArtifacts({ edges });
  }

  async upsertSourceRefs(sourceRefs: readonly SourceRef[]): Promise<void> {
    await this.upsertContextArtifacts({ sourceRefs });
  }

  async upsertContextArtifacts(batch: ContextIndexWriteBatch): Promise<ContextIndexWriteResult> {
    // 写入边界：内存实现也按单批次提交，和未来 SQLite adapter 的事务语义对齐。
    for (const sourceRef of batch.sourceRefs ?? []) {
      this.#sourceRefs.set(sourceRef.id, sourceRef);
    }
    for (const recipe of batch.recipes ?? []) {
      this.#recipes.set(recipe.id, recipe);
    }
    for (const file of batch.recipeFiles ?? []) {
      this.#recipeFiles.set(file.recipeId, file);
    }
    for (const edge of batch.edges ?? []) {
      this.#edges.set(edge.id, edge);
    }
    return {
      recipeCount: batch.recipes?.length ?? 0,
      recipeFileCount: batch.recipeFiles?.length ?? 0,
      edgeCount: batch.edges?.length ?? 0,
      sourceRefCount: batch.sourceRefs?.length ?? 0,
    };
  }

  snapshot(): ContextIndexSnapshot {
    return {
      recipes: [...this.#recipes.values()],
      edges: [...this.#edges.values()],
      sourceRefs: [...this.#sourceRefs.values()],
    };
  }
}

function uniqueByInputOrder<T>(ids: readonly string[], lookup: (id: string) => T | undefined): T[] {
  const seenIds = new Set<string>();
  const values: T[] = [];
  for (const id of ids) {
    if (seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);
    const value = lookup(id);
    if (value) {
      values.push(value);
    }
  }
  return values;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function isSourceRefOwnedByDeletedRecipe(
  sourceRef: SourceRef | undefined,
  recipeIds: ReadonlySet<string>,
): boolean {
  const recipeId = sourceRef?.metadata?.recipeId;
  return typeof recipeId === "string" && recipeIds.has(recipeId);
}
