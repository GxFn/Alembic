import type { ContextBundle, Recipe } from "../knowledge/index.js";
import { RuntimeTokenBudget } from "./RuntimeTokenBudget.js";

export interface RecipeInjectionCompressedRecipe {
  readonly id: string;
  readonly title: string;
  readonly when?: string;
  readonly do?: string;
  readonly dont?: string;
  readonly coreCode?: string;
  readonly usageGuide?: string;
}

export interface RecipeInjectionCompressedBundle {
  readonly recipes: RecipeInjectionCompressedRecipe[];
  readonly warnings: string[];
  readonly droppedRecipeIds: string[];
  readonly truncatedRecipeIds: string[];
  readonly tokensUsed: number;
}

export interface RecipeInjectionCompressorOptions {
  readonly maxRecipes?: number | undefined;
  readonly maxTokens?: number | undefined;
}

interface CompressedRecipeEntry {
  readonly recipe: RecipeInjectionCompressedRecipe;
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * RecipeInjectionCompressor 只压缩注入文本，不改变 Recipe 数据。
 * when/do/dont/coreCode/usageGuide 是 Codex prime 必须保留的高信号字段。
 */
export class RecipeInjectionCompressor {
  compress(
    bundle: ContextBundle,
    maxRecipesOrOptions: number | RecipeInjectionCompressorOptions = 8,
  ): RecipeInjectionCompressedBundle {
    const options =
      typeof maxRecipesOrOptions === "number"
        ? { maxRecipes: maxRecipesOrOptions }
        : maxRecipesOrOptions;
    const maxRecipes = options.maxRecipes ?? 8;
    const entries = bundle.recipes.slice(0, maxRecipes).map(compressRecipe);
    const budget = new RuntimeTokenBudget({ maxTokens: options.maxTokens ?? 2_000 }).apply(
      entries.map((entry) => ({
        id: entry.recipe.id,
        text: entry.text,
        entry,
      })),
    );
    const droppedRecipeIds = [
      ...bundle.recipes.slice(maxRecipes).map((recipe) => recipe.id),
      ...budget.dropped.map((item) => item.id),
    ];
    return {
      recipes: budget.kept.map((item) => item.entry.recipe),
      warnings: bundle.risks.map((risk) => risk.message),
      droppedRecipeIds,
      truncatedRecipeIds: entries
        .filter((entry) => entry.truncated)
        .map((entry) => entry.recipe.id),
      tokensUsed: budget.tokensUsed,
    };
  }
}

function compressRecipe(recipe: Recipe): CompressedRecipeEntry {
  const delivery = recipe.knowledge?.delivery;
  const when = oneLine(delivery?.whenClause ?? recipe.trigger ?? recipe.summary);
  const doClause = oneLine(delivery?.doClause);
  const dont = oneLine(delivery?.dontClause);
  const coreCode = skeletonizeCoreCodeWithMeta(delivery?.coreCode);
  const usageGuide = truncateLines(delivery?.usageGuide, 6);
  const compressed = {
    id: recipe.id,
    title: recipe.title,
    ...optionalText("when", when.value),
    ...optionalText("do", doClause.value),
    ...optionalText("dont", dont.value),
    ...optionalText("coreCode", coreCode.value),
    ...optionalText("usageGuide", usageGuide.value),
  };
  return {
    recipe: compressed,
    text: recipeInjectionText(compressed),
    truncated:
      when.truncated ||
      doClause.truncated ||
      dont.truncated ||
      coreCode.truncated ||
      usageGuide.truncated,
  };
}

function optionalText<Key extends string>(
  key: Key,
  value: string | undefined,
): Partial<Record<Key, string>> {
  return value ? ({ [key]: value } as Partial<Record<Key, string>>) : {};
}

interface TruncatedText {
  readonly value?: string | undefined;
  readonly truncated: boolean;
}

function oneLine(value: string | undefined): TruncatedText {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) {
    return { truncated: false };
  }
  const truncated = text.length > 240;
  return { value: text.slice(0, 240), truncated };
}

function truncateLines(value: string | undefined, maxLines: number): TruncatedText {
  const text = value?.trim();
  if (!text) {
    return { truncated: false };
  }
  const lines = text.split("\n");
  return { value: lines.slice(0, maxLines).join("\n"), truncated: lines.length > maxLines };
}

export function skeletonizeCoreCode(code: string | undefined, maxLines = 12): string | undefined {
  return skeletonizeCoreCodeWithMeta(code, maxLines).value;
}

function skeletonizeCoreCodeWithMeta(code: string | undefined, maxLines = 12): TruncatedText {
  return truncateLines(code, maxLines);
}

function recipeInjectionText(recipe: RecipeInjectionCompressedRecipe): string {
  return [recipe.title, recipe.when, recipe.do, recipe.dont, recipe.coreCode, recipe.usageGuide]
    .filter(Boolean)
    .join("\n");
}
