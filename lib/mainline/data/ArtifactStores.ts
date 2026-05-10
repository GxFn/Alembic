import type { Recipe, RecipeEdge, SourceRef } from "../knowledge/index.js";

export type { Recipe, RecipeEdge, SourceRef };

export type RecipeMarkdownFileBucket = "candidates" | "recipes";

export interface RecipeMarkdownFileIndex {
  readonly recipeId: string;
  readonly bucket: RecipeMarkdownFileBucket;
  readonly relativePath: string;
  readonly contentHash: string;
  readonly updatedAt?: number;
}

/**
 * CompiledContextSnapshot 是 data boundary 的可序列化快照。
 * 运行期只消费已经编译出的 artifact，不回扫 Markdown 目录重建上下文。
 */
export interface CompiledContextSnapshot {
  recipes: Recipe[];
  edges: RecipeEdge[];
  sourceRefs: SourceRef[];
}

export interface RecipeDeleteResult {
  readonly recipeIds: readonly string[];
  readonly sourceRefIds: readonly string[];
  readonly recipeFiles: readonly RecipeMarkdownFileIndex[];
}

export interface SourceRefStore {
  upsertSourceRefs(sourceRefs: readonly SourceRef[]): Promise<void>;
  findSourceRefsByIds(sourceRefIds: readonly string[]): Promise<SourceRef[]>;
  findSourceRefsByPaths(paths: readonly string[]): Promise<SourceRef[]>;
}

export interface RecipeStore {
  upsertRecipes(recipes: readonly Recipe[]): Promise<void>;
  deleteRecipes(recipeIds: readonly string[]): Promise<RecipeDeleteResult>;
  /** 运行期列表只读取已经编译好的 Recipe payload，不回扫 Markdown 或旧 repository。 */
  listRecipes(limit?: number): Promise<Recipe[]>;
  findRecipesByIds(recipeIds: readonly string[]): Promise<Recipe[]>;
  findRecipesBySourceRefIds(sourceRefIds: readonly string[], limit?: number): Promise<Recipe[]>;
}

/** Recipe 文件来源索引。查询热路径读 artifact index，不在运行期重新扫描 Markdown。 */
export interface RecipeFileStore {
  upsertRecipeFiles(files: readonly RecipeMarkdownFileIndex[]): Promise<void>;
  findRecipeFilesByRecipeIds(recipeIds: readonly string[]): Promise<RecipeMarkdownFileIndex[]>;
  findRecipesByMarkdownPaths(paths: readonly string[], limit?: number): Promise<Recipe[]>;
}

export interface RecipeEdgeStore {
  upsertEdges(edges: readonly RecipeEdge[]): Promise<void>;
  findRecipeEdgesByIds(edgeIds: readonly string[]): Promise<RecipeEdge[]>;
  findRecipeEdges(recipeIds: readonly string[]): Promise<RecipeEdge[]>;
}

export interface ArtifactStores
  extends SourceRefStore,
    RecipeStore,
    RecipeFileStore,
    RecipeEdgeStore {}
