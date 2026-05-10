import type { ContextBundle } from "../knowledge/index.js";
import {
  type RecipeInjectionCompressedBundle,
  RecipeInjectionCompressor,
} from "../runtime/RecipeInjectionCompressor.js";
import { AgentContextPresenter } from "./AgentContextPresenter.js";

export interface AgentInjectionPlan {
  readonly bundle: ContextBundle;
  readonly compressed: RecipeInjectionCompressedBundle;
  readonly markdown: string;
  readonly recipeIds: readonly string[];
  readonly warningCount: number;
}

export interface AgentInjectionPlannerOptions {
  readonly compressor?: RecipeInjectionCompressor;
  readonly presenter?: AgentContextPresenter;
}

export class AgentInjectionPlanner {
  readonly #compressor: RecipeInjectionCompressor;
  readonly #presenter: AgentContextPresenter;

  constructor(options: AgentInjectionPlannerOptions = {}) {
    this.#compressor = options.compressor ?? new RecipeInjectionCompressor();
    this.#presenter = options.presenter ?? new AgentContextPresenter();
  }

  plan(bundle: ContextBundle): AgentInjectionPlan {
    const compressed = this.#compressor.compress(bundle);
    return {
      bundle,
      compressed,
      markdown: this.#presenter.render(compressed),
      recipeIds: compressed.recipes.map((recipe) => recipe.id),
      warningCount: compressed.warnings.length,
    };
  }
}
