import type { ContextIndexWriter, RecipeMarkdownFileIndex } from "../data/index.js";
import type { Recipe, RecipeEdge, SourceRef } from "../knowledge/index.js";

export interface CompileArtifacts {
  readonly recipes?: readonly Recipe[];
  readonly recipeFiles?: readonly RecipeMarkdownFileIndex[];
  readonly edges?: readonly RecipeEdge[];
  readonly sourceRefs?: readonly SourceRef[];
}

/**
 * CompileArtifactWriter 是编译期唯一负责写入主线 artifact 的对象。
 * 中文注释：scanner、miner、AI task 只产出 artifact；真正落入 ContextIndex
 * 必须集中到这里，避免未来 SQLite/事务边界被绕开。
 */
export class CompileArtifactWriter {
  readonly #index: ContextIndexWriter;

  constructor(index: ContextIndexWriter) {
    this.#index = index;
  }

  async write(artifacts: CompileArtifacts): Promise<void> {
    await this.#index.upsertContextArtifacts({
      ...(artifacts.sourceRefs ? { sourceRefs: artifacts.sourceRefs } : {}),
      ...(artifacts.recipes ? { recipes: artifacts.recipes } : {}),
      ...(artifacts.recipeFiles ? { recipeFiles: artifacts.recipeFiles } : {}),
      ...(artifacts.edges ? { edges: artifacts.edges } : {}),
    });
  }
}
