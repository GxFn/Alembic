import { MainlineLanguageCatalog } from "../mainline/code/index.js";
import { isUsableRecipe, type Recipe } from "../mainline/knowledge/index.js";
import type {
  MainlineGuardRecipeProvider,
  MainlineGuardRule,
  MainlineGuardRuleLoadResult,
  MainlineGuardRuleProvider,
} from "./types.js";

export interface RecipeGuardRuleLoaderOptions {
  readonly languageCatalog?: MainlineLanguageCatalog;
}

export class RecipeGuardRuleLoader {
  readonly #languageCatalog: MainlineLanguageCatalog;

  constructor(options: RecipeGuardRuleLoaderOptions = {}) {
    this.#languageCatalog = options.languageCatalog ?? new MainlineLanguageCatalog();
  }

  load(recipes: readonly Recipe[]): MainlineGuardRuleLoadResult {
    const rules: MainlineGuardRule[] = [];
    const warnings: string[] = [];

    for (const recipe of recipes) {
      if (recipe.kind !== "guard-rule" || !isUsableRecipe(recipe)) {
        continue;
      }

      const candidates = guardCandidatesFromRecipe(recipe);
      if (candidates.length === 0) {
        warnings.push(`guard recipe ${recipe.id} has no usable guard definition.`);
        continue;
      }

      candidates.forEach((candidate, index) => {
        const parsed = this.#parseCandidate(recipe, candidate, index);
        if (parsed.rule) {
          rules.push(parsed.rule);
        }
        warnings.push(...parsed.warnings);
      });
    }

    return { rules, warnings };
  }

  #parseCandidate(
    recipe: Recipe,
    candidate: Record<string, unknown>,
    index: number,
  ): { readonly rule?: MainlineGuardRule; readonly warnings: readonly string[] } {
    const warnings: string[] = [];
    const pattern = stringValue(candidate.pattern) ?? stringValue(candidate.regex);
    if (!pattern) {
      return {
        warnings: [`guard recipe ${recipe.id} rule #${index + 1} is missing pattern.`],
      };
    }

    const id =
      stringValue(candidate.id) ??
      stringValue(candidate.ruleId) ??
      stringValue(candidate.name) ??
      `${recipe.id}:guard:${index + 1}`;
    const severity = severityValue(candidate.severity) ?? "warning";
    const languages = this.#languages(recipe, candidate);
    const flags = regexFlags(candidate.flags);
    const category = stringValue(candidate.category);
    const dimension = stringValue(candidate.dimension);
    const fixSuggestion = stringValue(candidate.fixSuggestion);

    const rule: MainlineGuardRule = {
      id,
      ruleRecipeId: recipe.id,
      pattern,
      ...(flags ? { flags } : {}),
      message: stringValue(candidate.message) ?? (recipe.summary || recipe.title),
      severity,
      languages,
      ...(category ? { category } : {}),
      ...(dimension ? { dimension } : {}),
      ...(fixSuggestion ? { fixSuggestion } : {}),
      ...(candidate.skipComments === true ? { skipComments: true } : {}),
      ...(candidate.skipTestFiles === true ? { skipTestFiles: true } : {}),
      source: "recipe",
    };

    return { rule, warnings };
  }

  #languages(recipe: Recipe, candidate: Record<string, unknown>): string[] {
    const values = [
      ...stringList(candidate.languages),
      ...stringList(candidate.language),
      ...stringList(recipe.knowledge?.classification.language),
    ];
    return uniqueStrings(values.map((language) => this.#languageCatalog.normalize(language)));
  }
}

export class RecipeBackedGuardRuleProvider implements MainlineGuardRuleProvider {
  readonly #recipeProvider: MainlineGuardRecipeProvider | (() => Promise<readonly Recipe[]>);
  readonly #loader: RecipeGuardRuleLoader;

  constructor(
    recipeProvider: MainlineGuardRecipeProvider | (() => Promise<readonly Recipe[]>),
    options: RecipeGuardRuleLoaderOptions = {},
  ) {
    this.#recipeProvider = recipeProvider;
    this.#loader = new RecipeGuardRuleLoader(options);
  }

  async load(): Promise<MainlineGuardRuleLoadResult> {
    // Guard 运行期只消费已编译 Recipe，不在这里回扫 Markdown 或旧 repository。
    const recipes =
      typeof this.#recipeProvider === "function"
        ? await this.#recipeProvider()
        : await this.#recipeProvider.load();
    return this.#loader.load(recipes);
  }
}

export function loadGuardRulesFromRecipes(
  recipes: readonly Recipe[],
  options: RecipeGuardRuleLoaderOptions = {},
): MainlineGuardRuleLoadResult {
  return new RecipeGuardRuleLoader(options).load(recipes);
}

function guardCandidatesFromRecipe(recipe: Recipe): Record<string, unknown>[] {
  const fromConstraints = recipe.knowledge?.constraints.guards.filter(isRecord) ?? [];
  if (fromConstraints.length > 0) {
    return fromConstraints;
  }

  const metadataGuard = recordValue(recipe.metadata?.guard);
  if (Object.keys(metadataGuard).length > 0) {
    return [metadataGuard];
  }

  const pattern = stringValue(recipe.knowledge?.body.pattern);
  if (pattern) {
    return [{ pattern }];
  }

  return [];
}

function severityValue(value: unknown): MainlineGuardRule["severity"] | undefined {
  return value === "info" || value === "warning" || value === "error" ? value : undefined;
}

function regexFlags(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const flags = uniqueStrings(value.split("").filter((flag) => "imsu".includes(flag))).join("");
  return flags || undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueStrings(value.map(stringValue));
  }
  const single = stringValue(value);
  return single ? [single] : [];
}

function uniqueStrings(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string"))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
