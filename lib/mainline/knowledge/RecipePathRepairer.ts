import type { SourceRefRepairPlan, SourceRefRepairRename } from "../compile/SourceRefRepairPlan.js";
import { createRecipe, type Recipe } from "./Recipe.js";
import type { RecipeKnowledgePayload } from "./RecipeKnowledgePayload.js";

export interface MainlineRecipePathRepairResult {
  readonly recipe: Recipe;
  readonly changed: boolean;
  readonly updatedFields: readonly string[];
  readonly appliedRenames: readonly SourceRefRepairRename[];
}

export interface MainlineMarkdownPathRepairResult {
  readonly markdown: string;
  readonly changed: boolean;
  readonly appliedRenames: readonly SourceRefRepairRename[];
}

type RenameInput = SourceRefRepairPlan | readonly SourceRefRepairRename[];

/**
 * RecipePathRepairer 是 SourceRef repair 的显式执行器。
 * 它只改传入的 Recipe/Markdown 文本，不读写文件；调用者确认后再决定是否持久化。
 */
export class MainlineRecipePathRepairer {
  repairRecipe(recipe: Recipe, input: RenameInput): MainlineRecipePathRepairResult {
    const renames = applicableRenames(recipe, normalizeRenames(input));
    if (renames.length === 0) {
      return { recipe, changed: false, updatedFields: [], appliedRenames: [] };
    }

    const updatedFields: string[] = [];
    const sourceRefIds = rewriteSourceRefIds(recipe.sourceRefIds, renames);
    if (!sameStringList(sourceRefIds, recipe.sourceRefIds)) {
      updatedFields.push("sourceRefIds");
    }

    const knowledgeResult = recipe.knowledge
      ? repairKnowledgePayload(recipe.knowledge, renames)
      : { knowledge: undefined, fields: [] };
    updatedFields.push(...knowledgeResult.fields);

    if (updatedFields.length === 0) {
      return { recipe, changed: false, updatedFields: [], appliedRenames: [] };
    }

    return {
      recipe: createRecipe({
        ...recipe,
        sourceRefIds,
        knowledge: knowledgeResult.knowledge ?? recipe.knowledge,
      }),
      changed: true,
      updatedFields: [...new Set(updatedFields)],
      appliedRenames: renames,
    };
  }

  repairMarkdown(markdown: string, input: RenameInput): MainlineMarkdownPathRepairResult {
    const renames = normalizeRenames(input);
    const repaired = rewriteText(markdown, renames);
    const changed = repaired !== markdown;
    return {
      markdown: repaired,
      changed,
      appliedRenames: changed ? renames : [],
    };
  }
}

function normalizeRenames(input: RenameInput): readonly SourceRefRepairRename[] {
  return isRepairPlan(input) ? input.renames : input;
}

function isRepairPlan(input: RenameInput): input is SourceRefRepairPlan {
  return !Array.isArray(input) && "renames" in input;
}

function applicableRenames(
  recipe: Recipe,
  renames: readonly SourceRefRepairRename[],
): SourceRefRepairRename[] {
  return renames.filter(
    (rename) =>
      rename.recipeIds.length === 0 ||
      rename.recipeIds.includes(recipe.id) ||
      recipe.sourceRefIds.includes(rename.sourceRefId) ||
      recipe.sourceRefIds.includes(rename.oldPath),
  );
}

function rewriteSourceRefIds(
  sourceRefIds: readonly string[],
  renames: readonly SourceRefRepairRename[],
): string[] {
  return uniqueStrings(
    sourceRefIds.map((sourceRefId) => {
      const direct = renames.find((rename) => rename.sourceRefId === sourceRefId);
      if (direct) {
        return direct.candidateSourceRefId;
      }
      return rewriteText(sourceRefId, renames);
    }),
  );
}

function repairKnowledgePayload(
  knowledge: RecipeKnowledgePayload,
  renames: readonly SourceRefRepairRename[],
): { knowledge: RecipeKnowledgePayload; fields: string[] } {
  const fields: string[] = [];
  const reasoningSources = rewriteStringList(knowledge.reasoning.sources, renames);
  if (!sameStringList(reasoningSources, knowledge.reasoning.sources)) {
    fields.push("knowledge.reasoning.sources");
  }

  const delivery = {
    ...knowledge.delivery,
    coreCode: rewriteOptionalField(
      knowledge.delivery.coreCode,
      renames,
      fields,
      "knowledge.delivery.coreCode",
    ),
  };
  const bodyMarkdown = rewriteOptionalField(
    knowledge.body.markdown,
    renames,
    fields,
    "knowledge.body.markdown",
  );
  const bodyPattern = rewriteOptionalField(
    knowledge.body.pattern,
    renames,
    fields,
    "knowledge.body.pattern",
  );
  const steps = knowledge.body.steps.map((step, index) => {
    const code = rewriteText(step.code ?? "", renames);
    if (code !== (step.code ?? "")) {
      fields.push(`knowledge.body.steps.${index}.code`);
      return { ...step, code };
    }
    return step;
  });
  const codeChanges = knowledge.body.codeChanges.map((change, index) => {
    const repaired = {
      file: rewriteText(change.file, renames),
      before: rewriteText(change.before, renames),
      after: rewriteText(change.after, renames),
      explanation: rewriteText(change.explanation, renames),
    };
    if (
      repaired.file !== change.file ||
      repaired.before !== change.before ||
      repaired.after !== change.after ||
      repaired.explanation !== change.explanation
    ) {
      fields.push(`knowledge.body.codeChanges.${index}`);
      return repaired;
    }
    return change;
  });
  const sourceFile = rewriteNullableField(
    knowledge.source.sourceFile,
    renames,
    fields,
    "knowledge.source.sourceFile",
  );

  return {
    knowledge: {
      ...knowledge,
      delivery,
      body: {
        ...knowledge.body,
        markdown: bodyMarkdown,
        pattern: bodyPattern,
        steps,
        codeChanges,
      },
      reasoning: {
        ...knowledge.reasoning,
        sources: reasoningSources,
      },
      source: {
        ...knowledge.source,
        sourceFile,
      },
    },
    fields,
  };
}

function rewriteOptionalField(
  value: string | undefined,
  renames: readonly SourceRefRepairRename[],
  fields: string[],
  field: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const next = rewriteText(value, renames);
  if (next !== value) {
    fields.push(field);
  }
  return next;
}

function rewriteNullableField(
  value: string | null | undefined,
  renames: readonly SourceRefRepairRename[],
  fields: string[],
  field: string,
): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  const next = rewriteText(value, renames);
  if (next !== value) {
    fields.push(field);
  }
  return next;
}

function rewriteStringList(
  values: readonly string[],
  renames: readonly SourceRefRepairRename[],
): string[] {
  return uniqueStrings(values.map((value) => rewriteText(value, renames)));
}

function rewriteText(value: string, renames: readonly SourceRefRepairRename[]): string {
  let next = value;
  for (const rename of renames) {
    next = next.split(rename.oldPath).join(rename.newPath);
  }
  return next;
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
