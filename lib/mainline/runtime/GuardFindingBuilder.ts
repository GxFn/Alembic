import { requireNonEmptyString, uniqueStrings } from "../core/assert.js";
import {
  type ContextBundle,
  createSourceRef,
  type GuardFinding,
  type GuardFindingSeverity,
  type SourceRef,
} from "../knowledge/index.js";

/**
 * LightweightGuardRule 是编译后 guard recipe 面向运行期的形态。
 * 运行期只接收规则身份和文字说明；它不能回头调用编译期 scanner
 * 或 legacy GuardService 去临时制造更多上下文。
 */
export interface LightweightGuardRule {
  recipeId: string;
  message: string;
  severity?: GuardFindingSeverity;
  sourceRefIds?: readonly string[];
  suggestedFix?: string;
  metadata?: Record<string, unknown>;
}

/** 当前 file、diff、command 或 error 中检测到的具体风险。 */
export interface LightweightGuardRisk {
  message: string;
  severity?: GuardFindingSeverity;
  sourceRefIds?: readonly string[];
  suggestedFix?: string;
  metadata?: Record<string, unknown>;
}

/** 运行期文件定位刻意保持小而适合编辑器消费。 */
export interface GuardFindingLocation {
  file?: string;
  line?: number;
  symbol?: string;
  sourceRefIds?: readonly string[];
}

export interface GuardFindingCaptureInput {
  title?: string;
  body?: string;
  suggestedRecipeId?: string;
  metadata?: Record<string, unknown>;
}

export interface GuardFindingRescanInput {
  reason?: string;
  files?: readonly string[];
  recipeIds?: readonly string[];
  metadata?: Record<string, unknown>;
}

export interface GuardFindingFeedbackInput {
  capture?: GuardFindingCaptureInput;
  rescan?: GuardFindingRescanInput;
}

export interface GuardFindingBuilderInput {
  rule: LightweightGuardRule;
  risk: LightweightGuardRisk;
  location?: GuardFindingLocation;
  message?: string;
  suggestedFix?: string;
  feedback?: GuardFindingFeedbackInput;
  metadata?: Record<string, unknown>;
}

export type GuardFindingBuilderContext = Pick<ContextBundle, "recipes" | "sourceRefs">;

/**
 * GuardFindingBuilder 是运行期解释层。
 * 它把已知规则、当前风险和文件位置转换成窄 GuardFinding 契约。
 * 它可以草拟反馈对象，但绝不写 Recipe、不生成 wiki、不触发编译期 rescan。
 */
export class GuardFindingBuilder {
  build(input: GuardFindingBuilderInput, context?: GuardFindingBuilderContext): GuardFinding {
    const ruleRecipeId = requireNonEmptyString(input.rule.recipeId, "guardFinding.ruleRecipeId");
    const message = requireNonEmptyString(
      input.message ?? `${input.rule.message}: ${input.risk.message}`,
      "guardFinding.message",
    );
    const evidence = resolveEvidence(input, context);
    const severity = input.risk.severity ?? input.rule.severity ?? "warning";
    const suggestedFix = input.suggestedFix ?? input.risk.suggestedFix ?? input.rule.suggestedFix;

    return {
      id: guardFindingId(ruleRecipeId, input.location, message),
      severity,
      ruleRecipeId,
      message,
      file: trimOptional(input.location?.file),
      line: input.location?.line,
      evidence,
      suggestedFix,
      captureDraft: buildCaptureDraft(input, ruleRecipeId, message, evidence),
      rescanRequest: buildRescanRequest(input, ruleRecipeId, evidence),
      metadata: {
        boundary: "runtime-forward-guard",
        rule: input.rule.metadata,
        risk: input.risk.metadata,
        ...input.metadata,
      },
    };
  }
}

function resolveEvidence(
  input: GuardFindingBuilderInput,
  context?: GuardFindingBuilderContext,
): SourceRef[] {
  const sourceRefs = context?.sourceRefs ?? [];
  const refsById = new Map(sourceRefs.map((sourceRef) => [sourceRef.id, sourceRef]));
  const ruleSourceRefIds =
    context?.recipes.find((recipe) => recipe.id === input.rule.recipeId)?.sourceRefIds ?? [];
  const requestedIds = uniqueStrings([
    ...ruleSourceRefIds,
    ...(input.rule.sourceRefIds ?? []),
    ...(input.risk.sourceRefIds ?? []),
    ...(input.location?.sourceRefIds ?? []),
  ]);
  const evidence: SourceRef[] = [];
  const seenIds = new Set<string>();

  for (const sourceRefId of requestedIds) {
    const sourceRef = refsById.get(sourceRefId);
    if (sourceRef) {
      evidence.push(sourceRef);
      seenIds.add(sourceRef.id);
    }
  }

  const file = trimOptional(input.location?.file);
  if (file) {
    for (const sourceRef of sourceRefs) {
      if (sourceRef.location.path === file && !seenIds.has(sourceRef.id)) {
        evidence.push(sourceRef);
        seenIds.add(sourceRef.id);
      }
    }
  }

  if (evidence.length === 0 && file) {
    // 即使紧凑 bundle 没携带匹配的 SourceRef，运行期 finding 仍然可以指向活动文件。
    // 这是 evidence annotation，不是编译期 indexing。
    evidence.push(
      createSourceRef({
        id: runtimeLocationSourceRefId(file, input.location?.line, input.location?.symbol),
        path: file,
        startLine: input.location?.line,
        endLine: input.location?.line,
        symbol: trimOptional(input.location?.symbol),
        status: "unknown",
        summary: `Runtime guard location for ${input.rule.recipeId}`,
      }),
    );
  }

  return evidence;
}

function buildCaptureDraft(
  input: GuardFindingBuilderInput,
  ruleRecipeId: string,
  message: string,
  evidence: readonly SourceRef[],
): GuardFinding["captureDraft"] {
  const capture = input.feedback?.capture;
  if (!capture) {
    return undefined;
  }

  return {
    id: `capture:${stableHash(`${ruleRecipeId}:${message}`)}`,
    title: requireNonEmptyString(
      capture.title ?? `Guard finding for ${ruleRecipeId}`,
      "guardFinding.capture.title",
    ),
    body: requireNonEmptyString(capture.body ?? message, "guardFinding.capture.body"),
    sourceRefIds: evidence.map((sourceRef) => sourceRef.id),
    suggestedRecipeId: capture.suggestedRecipeId ?? ruleRecipeId,
    metadata: {
      boundary: "runtime-capture-draft",
      ...capture.metadata,
    },
  };
}

function buildRescanRequest(
  input: GuardFindingBuilderInput,
  ruleRecipeId: string,
  evidence: readonly SourceRef[],
): GuardFinding["rescanRequest"] {
  const rescan = input.feedback?.rescan;
  if (!rescan) {
    return undefined;
  }

  const files = uniqueStrings([
    ...(rescan.files ?? []),
    input.location?.file ?? "",
    ...evidence.map((sourceRef) => sourceRef.location.path),
  ]);
  if (files.length === 0) {
    throw new Error("guardFinding.rescan.files must identify at least one focused file");
  }

  const recipeIds = uniqueStrings([ruleRecipeId, ...(rescan.recipeIds ?? [])]);
  const reason = requireNonEmptyString(
    rescan.reason ?? `Refresh focused evidence for ${ruleRecipeId}`,
    "guardFinding.rescan.reason",
  );

  return {
    id: `rescan:${stableHash(`${reason}:${files.join("|")}:${recipeIds.join("|")}`)}`,
    reason,
    files,
    recipeIds,
    metadata: {
      boundary: "runtime-file-scoped-rescan-request",
      ...rescan.metadata,
    },
  };
}

function guardFindingId(
  ruleRecipeId: string,
  location: GuardFindingLocation | undefined,
  message: string,
): string {
  return `finding:${stableHash(
    `${ruleRecipeId}:${location?.file ?? "workspace"}:${location?.line ?? 0}:${message}`,
  )}`;
}

function runtimeLocationSourceRefId(file: string, line?: number, symbol?: string): string {
  const suffix = symbol ? `#${symbol}` : `:${line ?? 0}`;
  return `runtime-guard:${file}${suffix}`;
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function stableHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}
