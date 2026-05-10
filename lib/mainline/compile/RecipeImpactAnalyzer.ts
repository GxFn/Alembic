import { normalizeMainlinePosixPath, uniqueMainlinePosixPaths } from "../core/index.js";
import { extractMainlineMarkdownCodeBlocks } from "../core/Markdown.js";
import { extractMainlineApiTokens } from "../core/TextAnalysis.js";
import type { Recipe, SourceRef } from "../knowledge/index.js";
import { parseMainlineUnifiedDiff, tokenizeMainlineDiff } from "./DiffParser.js";
import type {
  MainlineRecipeImpact,
  MainlineRecipeImpactIgnored,
  MainlineRecipeImpactLevel,
  MainlineRecipeImpactPlan,
  MainlineRecipeImpactReason,
  MainlineRecipeImpactSuggestedAction,
} from "./RecipeImpactPlan.js";
import { summarizeMainlineRecipeImpacts } from "./RecipeImpactPlan.js";
import type { MainlineSourceRefMovedFile } from "./RecipePathRepairer.js";

export interface MainlineRecipeImpactAnalyzeRequest {
  readonly recipes: readonly Recipe[];
  readonly changedFiles?: readonly string[];
  readonly deletedFiles?: readonly string[];
  readonly createdFiles?: readonly string[];
  readonly diffTextByPath?: Record<string, string>;
  readonly fileContentByPath?: Record<string, string>;
  readonly sourceRefs?: readonly SourceRef[];
  readonly movedFiles?: readonly MainlineSourceRefMovedFile[];
}

export interface MainlineRecipeImpactAssessment {
  readonly impactLevel: MainlineRecipeImpactLevel;
  readonly impactScore: number;
  readonly matchedTokens: readonly string[];
}

const DIFF_PATTERN_THRESHOLD = 0.3;
const FULL_CONTENT_PATTERN_THRESHOLD = 0.5;

/**
 * RecipeImpactAnalyzer 只判断“这次文件变化触碰了哪些 Recipe”。
 * 它不创建 proposal、不改 Markdown、不调用旧 FileChangeHandler，后续 AI 审查由上层编排决定。
 */
export class RecipeImpactAnalyzer {
  analyze(request: MainlineRecipeImpactAnalyzeRequest): MainlineRecipeImpactPlan {
    const sourceRefPathById = sourceRefPathMap(request.sourceRefs ?? []);
    const changedFiles = uniqueMainlinePosixPaths([
      ...(request.changedFiles ?? []),
      ...Object.keys(request.diffTextByPath ?? {}),
    ]);
    const deletedFiles = uniqueMainlinePosixPaths(request.deletedFiles ?? []);
    const createdFiles = uniqueMainlinePosixPaths(request.createdFiles ?? []);
    const createdSet = new Set(createdFiles);
    const movedFiles = normalizeMovedFiles(request.movedFiles ?? []);
    const movedFromPaths = new Set(movedFiles.map((move) => move.fromPath));
    const recipesByPath = recipesByEvidencePath(request.recipes, sourceRefPathById);
    const impacts: MainlineRecipeImpact[] = [];
    const ignored: MainlineRecipeImpactIgnored[] = [];

    for (const movedFile of movedFiles) {
      const recipes = recipesByPath.get(movedFile.fromPath) ?? [];
      if (recipes.length === 0) {
        ignored.push({ changedPath: movedFile.fromPath, reason: "no-recipe-reference" });
        continue;
      }

      for (const recipe of recipes) {
        if (!isRecipeImpactTrackable(recipe)) {
          ignored.push({ changedPath: movedFile.fromPath, reason: "recipe-not-trackable" });
          continue;
        }
        impacts.push(
          createImpact({
            recipe,
            changedPath: movedFile.fromPath,
            targetPath: movedFile.toPath,
            reason: "source-moved",
            assessment: {
              impactLevel: "reference",
              impactScore: 0.8,
              matchedTokens: [],
            },
            suggestedAction: "verify",
          }),
        );
      }
    }

    for (const changedPath of changedFiles) {
      if (createdSet.has(changedPath)) {
        ignored.push({ changedPath, reason: "created-file" });
        continue;
      }
      const recipes = recipesByPath.get(changedPath) ?? [];
      if (recipes.length === 0) {
        ignored.push({ changedPath, reason: "no-recipe-reference" });
        continue;
      }

      for (const recipe of recipes) {
        if (!isRecipeImpactTrackable(recipe)) {
          ignored.push({ changedPath, reason: "recipe-not-trackable" });
          continue;
        }
        const assessment = assessModifiedPathImpact(recipe, changedPath, request);
        impacts.push(
          createImpact({
            recipe,
            changedPath,
            reason: reasonForModifiedImpact(assessment.impactLevel),
            assessment,
            suggestedAction: suggestedActionForModifiedImpact(assessment.impactLevel),
          }),
        );
      }
    }

    for (const deletedPath of deletedFiles) {
      if (movedFromPaths.has(deletedPath)) {
        continue;
      }
      const recipes = recipesByPath.get(deletedPath) ?? [];
      if (recipes.length === 0) {
        ignored.push({ changedPath: deletedPath, reason: "no-recipe-reference" });
        continue;
      }

      for (const recipe of recipes) {
        if (!isRecipeImpactTrackable(recipe)) {
          ignored.push({ changedPath: deletedPath, reason: "recipe-not-trackable" });
          continue;
        }
        const evidencePaths = recipeEvidencePaths(recipe, sourceRefPathById);
        const remainingRefs = evidencePaths.filter((filePath) => !deletedFiles.includes(filePath));
        const fullDelete = remainingRefs.length === 0;
        impacts.push(
          createImpact({
            recipe,
            changedPath: deletedPath,
            reason: fullDelete ? "source-deleted" : "source-deleted-partial",
            assessment: {
              impactLevel: fullDelete ? "pattern" : "reference",
              impactScore: fullDelete ? 1 : 0.7,
              matchedTokens: [],
            },
            suggestedAction: fullDelete ? "deprecate" : "verify",
          }),
        );
      }
    }

    const allChangedFiles = uniqueMainlinePosixPaths([
      ...changedFiles,
      ...deletedFiles,
      ...movedFiles.flatMap((movedFile) => [movedFile.fromPath, movedFile.toPath]),
    ]);
    const sortedImpacts = impacts.sort(compareImpacts);
    const sortedIgnored = ignored.sort(
      (left, right) =>
        left.changedPath.localeCompare(right.changedPath) ||
        left.reason.localeCompare(right.reason),
    );

    return {
      impacts: sortedImpacts,
      ignored: sortedIgnored,
      summary: summarizeMainlineRecipeImpacts({
        changedFiles: allChangedFiles,
        impacts: sortedImpacts,
        ignored: sortedIgnored,
      }),
    };
  }
}

export function assessMainlineRecipeDiffImpact(
  recipe: Recipe,
  diffTokens: ReadonlySet<string>,
): MainlineRecipeImpactAssessment {
  return assessTokenImpact(recipe, diffTokens, DIFF_PATTERN_THRESHOLD);
}

export function extractMainlineRecipeImpactTokens(recipe: Recipe): Set<string> {
  const tokens = new Set<string>();
  const knowledge = recipe.knowledge;
  for (const token of extractMainlineApiTokens(knowledge?.delivery.coreCode ?? "")) {
    tokens.add(token);
  }
  for (const block of extractMainlineMarkdownCodeBlocks(knowledge?.body.markdown ?? "")) {
    for (const token of extractMainlineApiTokens(block.code)) {
      tokens.add(token);
    }
  }
  for (const token of extractMainlineApiTokens(knowledge?.body.pattern ?? "")) {
    tokens.add(token);
  }
  for (const step of knowledge?.body.steps ?? []) {
    for (const token of extractMainlineApiTokens(step.code ?? "")) {
      tokens.add(token);
    }
  }
  return tokens;
}

function assessModifiedPathImpact(
  recipe: Recipe,
  changedPath: string,
  request: MainlineRecipeImpactAnalyzeRequest,
): MainlineRecipeImpactAssessment {
  const diffText = lookupPathText(request.diffTextByPath, changedPath);
  if (diffText?.trim()) {
    return assessMainlineRecipeDiffImpact(
      recipe,
      tokenizeMainlineDiff(parseMainlineUnifiedDiff(diffText)),
    );
  }

  const fileContent = lookupPathText(request.fileContentByPath, changedPath);
  if (fileContent?.trim()) {
    return assessTokenImpact(
      recipe,
      new Set(extractMainlineApiTokens(fileContent)),
      FULL_CONTENT_PATTERN_THRESHOLD,
    );
  }

  // 只要 SourceRef 仍指向该文件但没有 diff/full-content，就保守交给上层 verify。
  return { impactLevel: "reference", impactScore: 0, matchedTokens: [] };
}

function assessTokenImpact(
  recipe: Recipe,
  changedTokens: ReadonlySet<string>,
  patternThreshold: number,
): MainlineRecipeImpactAssessment {
  const recipeTokens = extractMainlineRecipeImpactTokens(recipe);
  if (recipeTokens.size === 0) {
    return { impactLevel: "reference", impactScore: 0, matchedTokens: [] };
  }
  const matchedTokens = [...recipeTokens].filter((token) => changedTokens.has(token)).sort();
  const impactScore = roundImpactScore(matchedTokens.length / recipeTokens.size);
  if (impactScore >= patternThreshold) {
    return { impactLevel: "pattern", impactScore, matchedTokens };
  }
  if (impactScore > 0 || changedTokens.size > 0) {
    return { impactLevel: "reference", impactScore, matchedTokens };
  }
  return { impactLevel: "none", impactScore: 0, matchedTokens: [] };
}

function createImpact(input: {
  readonly recipe: Recipe;
  readonly changedPath: string;
  readonly targetPath?: string;
  readonly reason: MainlineRecipeImpactReason;
  readonly assessment: MainlineRecipeImpactAssessment;
  readonly suggestedAction: MainlineRecipeImpactSuggestedAction;
}): MainlineRecipeImpact {
  return {
    recipeId: input.recipe.id,
    recipeTitle: input.recipe.title,
    changedPath: input.changedPath,
    ...(input.targetPath === undefined ? {} : { targetPath: input.targetPath }),
    reason: input.reason,
    impactLevel: input.assessment.impactLevel,
    impactScore: input.assessment.impactScore,
    matchedTokens: input.assessment.matchedTokens,
    suggestedAction: input.suggestedAction,
    sourceRefIds: input.recipe.sourceRefIds,
  };
}

function normalizeMovedFiles(
  movedFiles: readonly MainlineSourceRefMovedFile[],
): MainlineSourceRefMovedFile[] {
  const byFrom = new Map<string, MainlineSourceRefMovedFile>();
  for (const movedFile of movedFiles) {
    const fromPath = normalizeMainlinePosixPath(movedFile.fromPath);
    const toPath = normalizeMainlinePosixPath(movedFile.toPath);
    if (!fromPath || !toPath || byFrom.has(fromPath)) {
      continue;
    }
    byFrom.set(fromPath, {
      fromPath,
      toPath,
      ...(movedFile.contentHash === undefined ? {} : { contentHash: movedFile.contentHash }),
    });
  }
  return [...byFrom.values()].sort(
    (left, right) =>
      left.fromPath.localeCompare(right.fromPath) || left.toPath.localeCompare(right.toPath),
  );
}

function reasonForModifiedImpact(level: MainlineRecipeImpactLevel): MainlineRecipeImpactReason {
  if (level === "pattern") {
    return "source-modified-pattern";
  }
  if (level === "reference") {
    return "source-modified-reference";
  }
  return "source-modified-none";
}

function suggestedActionForModifiedImpact(
  level: MainlineRecipeImpactLevel,
): MainlineRecipeImpactSuggestedAction {
  if (level === "pattern") {
    return "update";
  }
  if (level === "reference") {
    return "verify";
  }
  return "none";
}

function recipesByEvidencePath(
  recipes: readonly Recipe[],
  sourceRefPathById: ReadonlyMap<string, string>,
): Map<string, Recipe[]> {
  const byPath = new Map<string, Recipe[]>();
  for (const recipe of recipes) {
    for (const filePath of recipeEvidencePaths(recipe, sourceRefPathById)) {
      byPath.set(filePath, [...(byPath.get(filePath) ?? []), recipe]);
    }
  }
  return byPath;
}

function recipeEvidencePaths(
  recipe: Recipe,
  sourceRefPathById: ReadonlyMap<string, string>,
): string[] {
  const reasoningSources =
    recipe.knowledge?.reasoning.sources.flatMap((source) => normalizeEvidencePath(source)) ?? [];
  return uniqueMainlinePosixPaths(
    [
      ...recipe.sourceRefIds.flatMap((sourceRefId) => [
        sourceRefPathById.get(sourceRefId),
        normalizeEvidencePath(sourceRefId),
      ]),
      ...reasoningSources,
      normalizeEvidencePath(recipe.knowledge?.source.sourceFile ?? ""),
    ].filter((value): value is string => Boolean(value)),
  );
}

function sourceRefPathMap(sourceRefs: readonly SourceRef[]): Map<string, string> {
  const byId = new Map<string, string>();
  for (const sourceRef of sourceRefs) {
    byId.set(sourceRef.id, normalizeMainlinePosixPath(sourceRef.location.path));
  }
  return byId;
}

function normalizeEvidencePath(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return null;
  }
  if (trimmed.startsWith("symbol:")) {
    const body = trimmed.slice("symbol:".length);
    const separator = body.includes("::") ? body.indexOf("::") : body.indexOf("#");
    return separator > 0 ? normalizeMainlinePosixPath(body.slice(0, separator)) : null;
  }
  const withoutPrefix = trimmed.replace(/^(file|diff):/, "");
  const withoutLine = withoutPrefix.replace(/:\d+(?::\d+)?$/, "");
  const withoutHash = withoutLine.replace(/#.+$/, "");
  return withoutHash ? normalizeMainlinePosixPath(withoutHash) : null;
}

function lookupPathText(records: Record<string, string> | undefined, filePath: string): string {
  if (!records) {
    return "";
  }
  return records[filePath] ?? records[normalizeMainlinePosixPath(filePath)] ?? "";
}

function isRecipeImpactTrackable(recipe: Recipe): boolean {
  return recipe.status === "active" || recipe.status === "candidate";
}

function compareImpacts(left: MainlineRecipeImpact, right: MainlineRecipeImpact): number {
  return (
    left.recipeId.localeCompare(right.recipeId) ||
    left.changedPath.localeCompare(right.changedPath) ||
    right.impactScore - left.impactScore
  );
}

function roundImpactScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}
