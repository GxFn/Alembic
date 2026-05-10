import { sourceRefsFromProjectIntelligence } from "../compile/ProjectIntelligenceMaterializer.js";
import {
  type SourceRefReconcileReport,
  SourceRefReconcileReporter,
} from "../compile/SourceRefReconcileReport.js";
import {
  buildMainlineSourceRefRepairPlan,
  type SourceRefRepairPlan,
} from "../compile/SourceRefRepairPlan.js";
import type { ContextIndexSnapshot, ContextIndexWriteResult } from "../data/index.js";
import type { MainlineProjectIntelligenceArtifact } from "../graph/index.js";
import type { Recipe } from "./Recipe.js";
import type { RecipeMarkdownStore, RecipeMarkdownWriteResult } from "./RecipeMarkdownStore.js";
import { MainlineRecipePathRepairer } from "./RecipePathRepairer.js";
import type { SourceRef } from "./SourceRef.js";

export interface MainlineSourceRefRepairIndex {
  snapshot(): ContextIndexSnapshot;
  upsertContextArtifacts(batch: {
    readonly recipes?: readonly Recipe[];
    readonly recipeFiles?: readonly MainlineSourceRefRepairRecipeFile[];
    readonly sourceRefs?: readonly SourceRef[];
  }): Promise<ContextIndexWriteResult>;
}

export interface MainlineSourceRefRepairRecipeFile {
  readonly recipeId: string;
  readonly bucket: "candidates" | "recipes";
  readonly relativePath: string;
  readonly contentHash: string;
  readonly updatedAt?: number;
}

export interface MainlineSourceRefRepairServiceOptions {
  readonly apply?: boolean;
  readonly minConfidence?: number;
  readonly syncMarkdown?: boolean;
  readonly projectIntelligence?: MainlineProjectIntelligenceArtifact | null;
}

export interface MainlineSourceRefRepairRecipeChange {
  readonly recipeId: string;
  readonly changed: boolean;
  readonly updatedFields: readonly string[];
  readonly appliedRenameCount: number;
}

export interface MainlineSourceRefRepairApplyReport {
  readonly requested: boolean;
  readonly applied: boolean;
  readonly changedRecipes: readonly MainlineSourceRefRepairRecipeChange[];
  readonly unchangedRecipes: readonly MainlineSourceRefRepairRecipeChange[];
  readonly markdownWrites: readonly RecipeMarkdownWriteResult[];
  readonly contextIndexWrite?: ContextIndexWriteResult;
  readonly warnings: readonly string[];
}

export interface MainlineSourceRefRepairServiceReport {
  readonly mode: "report" | "apply";
  readonly reconcile: SourceRefReconcileReport;
  readonly plan: SourceRefRepairPlan;
  readonly apply: MainlineSourceRefRepairApplyReport;
}

export interface MainlineSourceRefRepairServiceDependencies {
  readonly reporter?: SourceRefReconcileReporter;
  readonly repairer?: MainlineRecipePathRepairer;
  readonly markdownStore?: RecipeMarkdownStore;
  readonly now?: () => number;
}

/**
 * SourceRef repair 的正式入口。默认只报告；只有 apply=true 才会改 Recipe、
 * Markdown 和 ContextIndex，避免隐式路径重写。
 */
export class MainlineSourceRefRepairService {
  readonly #index: MainlineSourceRefRepairIndex;
  readonly #reporter: SourceRefReconcileReporter;
  readonly #repairer: MainlineRecipePathRepairer;
  readonly #markdownStore: RecipeMarkdownStore | undefined;
  readonly #now: () => number;

  constructor(
    index: MainlineSourceRefRepairIndex,
    dependencies: MainlineSourceRefRepairServiceDependencies = {},
  ) {
    this.#index = index;
    this.#reporter = dependencies.reporter ?? new SourceRefReconcileReporter();
    this.#repairer = dependencies.repairer ?? new MainlineRecipePathRepairer();
    this.#markdownStore = dependencies.markdownStore;
    this.#now = dependencies.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async repair(
    options: MainlineSourceRefRepairServiceOptions = {},
  ): Promise<MainlineSourceRefRepairServiceReport> {
    const snapshot = this.#index.snapshot();
    const reconcile = this.#reporter.report({
      contextSnapshot: snapshot,
      ...(options.projectIntelligence == null
        ? {}
        : { projectIntelligence: options.projectIntelligence }),
    });
    const plan = buildMainlineSourceRefRepairPlan(
      reconcile,
      options.minConfidence === undefined ? {} : { minConfidence: options.minConfidence },
    );

    if (options.apply !== true) {
      return {
        mode: "report",
        reconcile,
        plan,
        apply: emptyApplyReport(false),
      };
    }

    const apply = await this.#apply(snapshot, plan, {
      syncMarkdown: options.syncMarkdown !== false,
      ...(options.projectIntelligence == null
        ? {}
        : { projectIntelligence: options.projectIntelligence }),
    });
    return { mode: "apply", reconcile, plan, apply };
  }

  async #apply(
    snapshot: ContextIndexSnapshot,
    plan: SourceRefRepairPlan,
    options: {
      readonly syncMarkdown: boolean;
      readonly projectIntelligence?: MainlineProjectIntelligenceArtifact;
    },
  ): Promise<MainlineSourceRefRepairApplyReport> {
    const warnings: string[] = [];
    if (plan.renames.length === 0) {
      return { ...emptyApplyReport(true), warnings };
    }

    const changedRecipes: MainlineSourceRefRepairRecipeChange[] = [];
    const unchangedRecipes: MainlineSourceRefRepairRecipeChange[] = [];
    const repairedRecipes: Recipe[] = [];

    for (const recipe of snapshot.recipes) {
      const result = this.#repairer.repairRecipe(recipe, plan);
      const change = {
        recipeId: recipe.id,
        changed: result.changed,
        updatedFields: result.updatedFields,
        appliedRenameCount: result.appliedRenames.length,
      };
      if (result.changed) {
        changedRecipes.push(change);
        repairedRecipes.push(result.recipe);
      } else if (result.appliedRenames.length > 0) {
        unchangedRecipes.push(change);
      }
    }

    const markdownWrites = await this.#writeMarkdown(repairedRecipes, options, warnings);
    const sourceRefs = targetSourceRefsForPlan(plan, options.projectIntelligence);
    const contextIndexWrite =
      repairedRecipes.length > 0 || markdownWrites.length > 0 || sourceRefs.length > 0
        ? await this.#index.upsertContextArtifacts({
            recipes: repairedRecipes,
            recipeFiles: markdownWrites.map((write) =>
              recipeFileFromMarkdownWrite(write, this.#now()),
            ),
            sourceRefs,
          })
        : undefined;

    return {
      requested: true,
      applied: changedRecipes.length > 0 || markdownWrites.length > 0 || sourceRefs.length > 0,
      changedRecipes: changedRecipes.sort((left, right) =>
        left.recipeId.localeCompare(right.recipeId),
      ),
      unchangedRecipes: unchangedRecipes.sort((left, right) =>
        left.recipeId.localeCompare(right.recipeId),
      ),
      markdownWrites,
      ...(contextIndexWrite === undefined ? {} : { contextIndexWrite }),
      warnings,
    };
  }

  async #writeMarkdown(
    recipes: readonly Recipe[],
    options: { readonly syncMarkdown: boolean },
    warnings: string[],
  ): Promise<RecipeMarkdownWriteResult[]> {
    if (recipes.length === 0 || !options.syncMarkdown) {
      return [];
    }
    if (!this.#markdownStore) {
      warnings.push("Markdown sync requested, but no RecipeMarkdownStore was configured.");
      return [];
    }
    return this.#markdownStore.writeMany(recipes);
  }
}

function emptyApplyReport(requested: boolean): MainlineSourceRefRepairApplyReport {
  return {
    requested,
    applied: false,
    changedRecipes: [],
    unchangedRecipes: [],
    markdownWrites: [],
    warnings: [],
  };
}

function targetSourceRefsForPlan(
  plan: SourceRefRepairPlan,
  projectIntelligence: MainlineProjectIntelligenceArtifact | undefined,
): SourceRef[] {
  if (!projectIntelligence || plan.renames.length === 0) {
    return [];
  }
  const wantedIds = new Set(plan.renames.map((rename) => rename.candidateSourceRefId));
  return sourceRefsFromProjectIntelligence(projectIntelligence).filter((sourceRef) =>
    wantedIds.has(sourceRef.id),
  );
}

function recipeFileFromMarkdownWrite(
  write: RecipeMarkdownWriteResult,
  updatedAt: number,
): MainlineSourceRefRepairRecipeFile {
  return {
    recipeId: write.recipeId,
    bucket: write.bucket,
    relativePath: write.relativePath,
    contentHash: write.contentHash,
    updatedAt,
  };
}
