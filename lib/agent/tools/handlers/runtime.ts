import { KnowledgeInjectionRunner } from "../../../mainline/agent/index.js";
import type { MainlineProjectIntelligenceArtifact } from "../../../mainline/graph/index.js";
import {
  type MainlineSourceRefRepairIndex,
  MainlineSourceRefRepairService,
  type Recipe,
  type SourceRef,
} from "../../../mainline/knowledge/index.js";
import {
  GuardFindingBuilder,
  type GuardFindingBuilderInput,
  type LightweightGuardRisk,
  type LightweightGuardRule,
} from "../../../mainline/runtime/index.js";
import type { ToolHandler, ToolRuntimeDependencies } from "../types.js";
import { isRecord, toolFailure, toolSuccess } from "../types.js";

type Severity = "info" | "warning" | "error";
type GuardFindingRuntimeContext = { readonly recipes: Recipe[]; readonly sourceRefs: SourceRef[] };

export const runtimeInjectContextHandler: ToolHandler = async (invocation, context) => {
  if (!context.dependencies.contextIndex || !context.dependencies.searchIndex) {
    return toolFailure(context.descriptor, "unavailable", {
      code: "runtime_index_unavailable",
      message: "runtime.inject_context requires ContextIndexReader and MainlineSearchIndex.",
    });
  }

  if (!isRecord(invocation.input)) {
    return toolFailure(context.descriptor, "error", {
      code: "invalid_input",
      message: "runtime.inject_context input must be an object.",
    });
  }

  const projectRoot = stringValue(invocation.input.projectRoot) ?? context.dependencies.projectRoot;
  if (!projectRoot) {
    return toolFailure(context.descriptor, "unavailable", {
      code: "project_root_unavailable",
      message: "runtime.inject_context requires projectRoot in input or dependencies.",
    });
  }

  const runner = new KnowledgeInjectionRunner(context.dependencies.contextIndex, {
    searchIndex: context.dependencies.searchIndex,
  });
  const activeWorkContext = { projectRoot, ...definedWorkContextFields(invocation.input) };
  const result = await runner.run({
    activeWorkContext,
  });

  return toolSuccess(context.descriptor, {
    activeContext: result.activeContext,
    recipeIds: result.plan.recipeIds,
    warningCount: result.plan.warningCount,
    searchHitCount: result.bundle.metadata?.searchHitCount,
    bundle: {
      id: result.bundle.id,
      recipeCount: result.bundle.recipes.length,
      sourceRefCount: result.bundle.sourceRefs.length,
      edgeCount: result.bundle.edges.length,
      riskCount: result.bundle.risks.length,
      actionCount: result.bundle.suggestedActions.length,
      capturePromptCount: result.bundle.capturePrompts.length,
    },
    markdown: result.markdown,
  });
};

export const runtimeGuardFindingHandler: ToolHandler = async (invocation, context) => {
  const parsed = parseGuardFindingInput(invocation.input);
  if (!parsed.ok) {
    return toolFailure(context.descriptor, "error", parsed.error);
  }

  const runtimeContext = await loadGuardFindingContext(context.dependencies, parsed.input);
  const finding = new GuardFindingBuilder().build(parsed.input, runtimeContext);
  return toolSuccess(context.descriptor, {
    finding,
    evidenceCount: finding.evidence.length,
    hasCaptureDraft: Boolean(finding.captureDraft),
    hasRescanRequest: Boolean(finding.rescanRequest),
  });
};

export const runtimeSourceRefRepairHandler: ToolHandler = async (invocation, context) => {
  const input = isRecord(invocation.input) ? invocation.input : {};
  const repairIndex =
    context.dependencies.sourceRefRepairIndex ?? repairIndexFromDependencies(context.dependencies);
  if (!repairIndex) {
    return toolFailure(context.descriptor, "unavailable", {
      code: "source_ref_repair_index_unavailable",
      message:
        "runtime.source_ref_repair requires sourceRefRepairIndex or a contextIndex with snapshot/upsertContextArtifacts.",
    });
  }

  const includeProjectIntelligence = input.includeProjectIntelligence !== false;
  const projectIntelligence = includeProjectIntelligence
    ? await loadProjectIntelligence(context.dependencies)
    : null;
  const report = await new MainlineSourceRefRepairService(repairIndex, {
    ...(context.dependencies.sourceRefRepairMarkdownStore
      ? { markdownStore: context.dependencies.sourceRefRepairMarkdownStore }
      : {}),
    ...(context.dependencies.now ? { now: context.dependencies.now } : {}),
  }).repair({
    apply: input.apply === true,
    ...(typeof input.minConfidence === "number" ? { minConfidence: input.minConfidence } : {}),
    syncMarkdown: input.syncMarkdown !== false,
    ...(projectIntelligence === null ? {} : { projectIntelligence }),
  });

  return toolSuccess(context.descriptor, report);
};

async function loadGuardFindingContext(
  dependencies: ToolRuntimeDependencies,
  input: GuardFindingBuilderInput,
): Promise<GuardFindingRuntimeContext | undefined> {
  const contextIndex = dependencies.contextIndex;
  const lookup = contextIndex as
    | (ToolRuntimeDependencies["contextIndex"] & {
        findRecipesByIds?(recipeIds: readonly string[]): Promise<Recipe[]>;
        findSourceRefsByIds?(sourceRefIds: readonly string[]): Promise<SourceRef[]>;
      })
    | undefined;
  if (!contextIndex || !lookup?.findRecipesByIds) {
    return undefined;
  }

  const recipes = await lookup.findRecipesByIds([input.rule.recipeId]);
  const recipeSourceRefs = await contextIndex.findSourceRefs([input.rule.recipeId]);
  const requestedSourceRefIds = [
    ...(input.rule.sourceRefIds ?? []),
    ...(input.risk.sourceRefIds ?? []),
    ...(input.location?.sourceRefIds ?? []),
  ];
  const directSourceRefs = lookup.findSourceRefsByIds
    ? await lookup.findSourceRefsByIds(requestedSourceRefIds)
    : [];

  return {
    recipes,
    sourceRefs: [...recipeSourceRefs, ...directSourceRefs],
  };
}

function parseGuardFindingInput(
  input: unknown,
):
  | { readonly ok: true; readonly input: GuardFindingBuilderInput }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "runtime.guard_finding input must be an object." },
    };
  }
  const ruleRecord = isRecord(input.rule) ? input.rule : null;
  const riskRecord = isRecord(input.risk) ? input.risk : null;
  const ruleRecipeId = stringValue(ruleRecord?.recipeId);
  const ruleMessage = stringValue(ruleRecord?.message);
  const riskMessage = stringValue(riskRecord?.message);
  if (!ruleRecord || !ruleRecipeId || !ruleMessage || !riskRecord || !riskMessage) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: "runtime.guard_finding requires rule.recipeId, rule.message, and risk.message.",
      },
    };
  }

  const rule = buildLightweightRule(ruleRecipeId, ruleMessage, ruleRecord);
  const risk = buildLightweightRisk(riskMessage, riskRecord);
  const location = isRecord(input.location) ? buildLocation(input.location) : undefined;

  return {
    ok: true,
    input: {
      rule,
      risk,
      ...(location === undefined ? {} : { location }),
      ...guardFindingOptionalStrings(input),
      ...(isRecord(input.feedback)
        ? { feedback: input.feedback as NonNullable<GuardFindingBuilderInput["feedback"]> }
        : {}),
      ...(isRecord(input.metadata) ? { metadata: input.metadata } : {}),
    },
  };
}

function guardFindingOptionalStrings(input: Record<string, unknown>) {
  const message = stringValue(input.message);
  const suggestedFix = stringValue(input.suggestedFix);
  return {
    ...(message ? { message } : {}),
    ...(suggestedFix ? { suggestedFix } : {}),
  };
}

function definedWorkContextFields(input: Record<string, unknown>) {
  const prompt = stringValue(input.prompt);
  const taskText = stringValue(input.taskText);
  const activeFile = stringValue(input.activeFile);
  const files = stringArray(input.files);
  const symbols = stringArray(input.symbols);
  const diff = stringValue(input.diff);
  const commandIntent = stringValue(input.commandIntent);
  const userFocus = stringValue(input.userFocus);
  return {
    ...(prompt ? { prompt } : {}),
    ...(taskText ? { taskText } : {}),
    ...(activeFile ? { activeFile } : {}),
    ...(files.length > 0 ? { files } : {}),
    ...(symbols.length > 0 ? { symbols } : {}),
    ...(diff ? { diff } : {}),
    ...(commandIntent ? { commandIntent } : {}),
    ...(userFocus ? { userFocus } : {}),
  };
}

function buildLightweightRule(
  recipeId: string,
  message: string,
  record: Record<string, unknown>,
): LightweightGuardRule {
  const ruleSeverity = severity(record.severity);
  const sourceRefIds = stringArray(record.sourceRefIds);
  const suggestedFix = stringValue(record.suggestedFix);
  return {
    recipeId,
    message,
    ...(ruleSeverity ? { severity: ruleSeverity } : {}),
    ...(sourceRefIds.length > 0 ? { sourceRefIds } : {}),
    ...(suggestedFix ? { suggestedFix } : {}),
    ...(isRecord(record.metadata) ? { metadata: record.metadata } : {}),
  };
}

function buildLightweightRisk(
  message: string,
  record: Record<string, unknown>,
): LightweightGuardRisk {
  const riskSeverity = severity(record.severity);
  const sourceRefIds = stringArray(record.sourceRefIds);
  const suggestedFix = stringValue(record.suggestedFix);
  return {
    message,
    ...(riskSeverity ? { severity: riskSeverity } : {}),
    ...(sourceRefIds.length > 0 ? { sourceRefIds } : {}),
    ...(suggestedFix ? { suggestedFix } : {}),
    ...(isRecord(record.metadata) ? { metadata: record.metadata } : {}),
  };
}

function buildLocation(record: Record<string, unknown>): GuardFindingBuilderInput["location"] {
  const file = stringValue(record.file);
  const symbol = stringValue(record.symbol);
  const sourceRefIds = stringArray(record.sourceRefIds);
  return {
    ...(file ? { file } : {}),
    ...(typeof record.line === "number" ? { line: record.line } : {}),
    ...(symbol ? { symbol } : {}),
    ...(sourceRefIds.length > 0 ? { sourceRefIds } : {}),
  };
}

function repairIndexFromDependencies(
  dependencies: ToolRuntimeDependencies,
): MainlineSourceRefRepairIndex | undefined {
  const candidate = dependencies.contextIndex as unknown;
  return isRepairIndex(candidate) ? candidate : undefined;
}

function isRepairIndex(value: unknown): value is MainlineSourceRefRepairIndex {
  return (
    isRecord(value) &&
    typeof value.snapshot === "function" &&
    typeof value.upsertContextArtifacts === "function"
  );
}

async function loadProjectIntelligence(
  dependencies: ToolRuntimeDependencies,
): Promise<MainlineProjectIntelligenceArtifact | null> {
  const provider = dependencies.projectIntelligenceArtifactProvider;
  if (!provider) {
    return null;
  }
  return typeof provider === "function" ? provider() : provider.load();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function severity(value: unknown): Severity | undefined {
  return value === "info" || value === "warning" || value === "error" ? value : undefined;
}
