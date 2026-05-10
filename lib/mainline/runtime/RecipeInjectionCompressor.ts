import type { ContextBundle, Recipe } from "../knowledge/index.js";

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
}

/**
 * RecipeInjectionCompressor 只压缩注入文本，不改变 Recipe 数据。
 * when/do/dont/coreCode/usageGuide 是 Codex prime 必须保留的高信号字段。
 */
export class RecipeInjectionCompressor {
  compress(bundle: ContextBundle, maxRecipes = 8): RecipeInjectionCompressedBundle {
    return {
      recipes: bundle.recipes.slice(0, maxRecipes).map(compressRecipe),
      warnings: bundle.risks.map((risk) => risk.message),
    };
  }
}

function compressRecipe(recipe: Recipe): RecipeInjectionCompressedRecipe {
  const delivery = recipe.knowledge?.delivery;
  return {
    id: recipe.id,
    title: recipe.title,
    ...optionalText("when", oneLine(delivery?.whenClause ?? recipe.trigger ?? recipe.summary)),
    ...optionalText("do", oneLine(delivery?.doClause)),
    ...optionalText("dont", oneLine(delivery?.dontClause)),
    ...optionalText("coreCode", skeletonizeCoreCode(delivery?.coreCode)),
    ...optionalText("usageGuide", truncateLines(delivery?.usageGuide, 6)),
  };
}

function optionalText<Key extends string>(
  key: Key,
  value: string | undefined,
): Partial<Record<Key, string>> {
  return value ? ({ [key]: value } as Partial<Record<Key, string>>) : {};
}

function oneLine(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 240) : undefined;
}

function truncateLines(value: string | undefined, maxLines: number): string | undefined {
  const text = value?.trim();
  return text ? text.split("\n").slice(0, maxLines).join("\n") : undefined;
}

export function skeletonizeCoreCode(code: string | undefined, maxLines = 12): string | undefined {
  return truncateLines(code, maxLines);
}
