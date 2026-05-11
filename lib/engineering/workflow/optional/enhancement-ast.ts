import type { EngineeringCodeAstFileSummaryInput } from "../../code/types.js";
import type {
  AstClassInfo,
  AstMethodInfo,
  AstPatternInfo,
  AstProtocolInfo,
  AstSummary,
  DetectedPattern,
  EnhancementPack,
} from "../../enhancement/index.js";
import { getEngineeringEnhancementPackMatcher } from "../../enhancement/matchers.js";
import type { EngineeringWorkflowEnhancementPatternCandidate } from "./types.js";

export interface EngineeringEnhancementAstContext {
  readonly importSpecifiers: readonly {
    readonly specifier: string;
    readonly filePath?: string;
  }[];
  readonly astFiles: readonly EngineeringCodeAstFileSummaryInput[];
}

export function detectPatternCandidates(
  pack: EnhancementPack,
  context: EngineeringEnhancementAstContext,
): readonly EngineeringWorkflowEnhancementPatternCandidate[] {
  const patterns: EngineeringWorkflowEnhancementPatternCandidate[] = [];
  const matcher = getEngineeringEnhancementPackMatcher(pack.id);

  for (const fact of context.importSpecifiers) {
    if (matchesAnyAlias(fact.specifier, matcher.aliases)) {
      patterns.push({
        type: `${pack.id}-ecosystem-usage`,
        packId: pack.id,
        confidence: 0.78,
        source: "import",
        evidence: [fact.specifier],
        ...(fact.filePath === undefined ? {} : { filePath: fact.filePath }),
      });
    }
  }

  for (const astFile of context.astFiles) {
    const filePath = stringValue(astFile.file ?? astFile.path ?? astFile.filePath);
    const summary = astSummaryForFile(astFile);
    for (const pattern of pack.detectPatterns(summary)) {
      patterns.push(toPatternCandidate(pattern, pack.id, filePath));
    }
  }
  return dedupePatterns(patterns);
}

export function importsForAstFile(astFile: EngineeringCodeAstFileSummaryInput): readonly string[] {
  const imports: string[] = [];
  for (const rawImport of Array.isArray(astFile.imports) ? astFile.imports : []) {
    const record: Record<string, unknown> = isRecord(rawImport) ? rawImport : { path: rawImport };
    const specifier = stringValue(
      record.specifier ?? record.path ?? record.module ?? record.source,
    );
    if (specifier) {
      imports.push(specifier);
    }
  }
  for (const rawImport of Array.isArray(astFile.importFacts) ? astFile.importFacts : []) {
    const record: Record<string, unknown> = isRecord(rawImport) ? rawImport : { path: rawImport };
    const specifier = stringValue(
      record.specifier ?? record.path ?? record.module ?? record.source,
    );
    if (specifier) {
      imports.push(specifier);
    }
  }
  return [...new Set(imports)];
}

function astSummaryForFile(astFile: EngineeringCodeAstFileSummaryInput): AstSummary {
  return {
    methods: arrayRecords(astFile.methods).map(toAstMethod),
    classes: arrayRecords(astFile.classes).map(toAstClass),
    protocols: arrayRecords(astFile.protocols).map(toAstProtocol),
    imports: importsForAstFile(astFile),
    patterns: arrayRecords(astFile.patterns).map(toAstPattern),
  };
}

function toAstMethod(record: Record<string, unknown>): AstMethodInfo {
  return compactObject({
    name: stringValue(record.name),
    className: optionalString(record.className),
    line: numberValue(record.line),
    paramCount: numberValue(record.paramCount),
    isAsync: booleanValue(record.isAsync),
    isExported: booleanValue(record.isExported),
    isClassMethod: booleanValue(record.isClassMethod),
    decorators: optionalStringArray(record.decorators),
    annotations: optionalStringArray(record.annotations),
  });
}

function toAstClass(record: Record<string, unknown>): AstClassInfo {
  return compactObject({
    name: stringValue(record.name),
    line: numberValue(record.line),
    superclass: optionalString(record.superclass ?? record.superClass),
    kind: optionalString(record.kind),
    methods: optionalStringArray(record.methods),
    interfaces: optionalStringArray(record.interfaces),
    annotations: optionalStringArray(record.annotations),
    decorators: optionalStringArray(record.decorators),
    embeddedTypes: optionalStringArray(record.embeddedTypes),
    fieldCount: numberValue(record.fieldCount),
    derives: optionalStringArray(record.derives),
    traitName: optionalString(record.traitName),
  });
}

function toAstProtocol(record: Record<string, unknown>): AstProtocolInfo {
  return compactObject({
    name: stringValue(record.name),
    line: numberValue(record.line),
    methods: optionalStringArray(record.methods),
  });
}

function toAstPattern(record: Record<string, unknown>): AstPatternInfo {
  return compactObject({
    type: stringValue(record.type),
    count: numberValue(record.count),
    confidence: numberValue(record.confidence),
  });
}

function toPatternCandidate(
  pattern: DetectedPattern,
  packId: string,
  filePath: string,
): EngineeringWorkflowEnhancementPatternCandidate {
  const metadata = patternMetadata(pattern);
  return {
    type: pattern.type,
    packId,
    confidence: pattern.confidence,
    source: "ast",
    evidence: patternEvidence(pattern),
    ...(filePath ? { filePath } : {}),
    ...(pattern.line === undefined ? {} : { line: pattern.line }),
    ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
  };
}

function patternMetadata(pattern: DetectedPattern): Readonly<Record<string, unknown>> {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(pattern)) {
    if (!["type", "className", "methodName", "line", "confidence"].includes(key)) {
      metadata[key] = value;
    }
  }
  return metadata;
}

function patternEvidence(pattern: DetectedPattern): readonly string[] {
  return [
    pattern.methodName,
    pattern.className,
    typeof pattern.importName === "string" ? pattern.importName : undefined,
    pattern.type,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

function dedupePatterns(
  patterns: readonly EngineeringWorkflowEnhancementPatternCandidate[],
): readonly EngineeringWorkflowEnhancementPatternCandidate[] {
  const byKey = new Map<string, EngineeringWorkflowEnhancementPatternCandidate>();
  for (const pattern of patterns) {
    byKey.set(
      `${pattern.packId}\0${pattern.type}\0${pattern.filePath ?? ""}\0${pattern.line ?? ""}`,
      pattern,
    );
  }
  return [...byKey.values()];
}

function matchesAnyAlias(value: string, aliases: readonly string[]): boolean {
  const normalized = value.toLowerCase();
  return aliases.some((alias) => normalized.includes(alias.toLowerCase()));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

function arrayRecords(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactObject<T extends Record<string, unknown>>(input: T): T {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output as T;
}
