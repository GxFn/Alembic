import type { EngineeringCodeAstFactsFileSummary } from "../ast/index.js";
import { asRecord, stringValue } from "../ast/normalizer-utils.js";

export interface EngineeringInheritanceEdge {
  readonly from: string;
  readonly to: string;
  readonly type: "inherits" | "conforms" | "extends";
}

export function buildPatternStats(
  fileSummaries: readonly EngineeringCodeAstFactsFileSummary[],
): Record<string, { count: number; files: string[]; instances: Record<string, unknown>[] }> {
  const stats: Record<
    string,
    { count: number; files: string[]; instances: Record<string, unknown>[] }
  > = {};
  for (const summary of fileSummaries) {
    const summaryRecord = summary as unknown as Record<string, unknown>;
    const patterns = Array.isArray(summaryRecord.patterns)
      ? (summaryRecord.patterns as readonly unknown[])
      : [];
    for (const pattern of patterns) {
      const patternRecord = asRecord(pattern);
      if (Object.keys(patternRecord).length === 0) {
        continue;
      }
      const type = stringValue(patternRecord.type, "unknown");
      stats[type] ??= { count: 0, files: [], instances: [] };
      stats[type].count += 1;
      if (!stats[type].files.includes(summary.file)) {
        stats[type].files.push(summary.file);
      }
      stats[type].instances.push({ ...patternRecord, file: summary.file });
    }
  }
  return stats;
}

export function aggregateProjectMetrics(
  fileSummaries: readonly EngineeringCodeAstFactsFileSummary[],
): Record<string, unknown> {
  const classes = fileSummaries.flatMap((summary) => summary.classes);
  const methods = fileSummaries.flatMap((summary) => summary.methods);
  const definitionMethods = methods.filter(
    (method) => stringValue(asRecord(method).kind, "") !== "call-site",
  );
  const totalMethods = definitionMethods.length;
  return {
    methodCount: totalMethods,
    avgMethodsPerClass: classes.length > 0 ? totalMethods / classes.length : 0,
    avgBodyLines:
      totalMethods > 0
        ? definitionMethods.reduce((sum, method) => sum + (method.bodyLines ?? 0), 0) / totalMethods
        : 0,
    maxComplexity: maxNumeric(definitionMethods, "complexity"),
    maxNestingDepth: maxNumeric(definitionMethods, "nestingDepth"),
    importCount: fileSummaries.reduce((sum, summary) => sum + summary.imports.length, 0),
    callSiteCount: fileSummaries.reduce((sum, summary) => sum + summary.callSites.length, 0),
  };
}

export function dominantLanguage(
  fileSummaries: readonly EngineeringCodeAstFactsFileSummary[],
): string {
  const counts = new Map<string, number>();
  for (const summary of fileSummaries) {
    counts.set(summary.languageId, (counts.get(summary.languageId) ?? 0) + 1);
  }
  return (
    [...counts.entries()].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )[0]?.[0] ?? "unknown"
  );
}

export function withFile<T extends object>(
  records: readonly T[],
  file: string,
): Array<T & { file: string }> {
  return records.map((record) => ({ ...record, file }));
}

function maxNumeric(records: readonly unknown[], key: string): number {
  return records.reduce<number>(
    (max, record) => Math.max(max, numericValue(asRecord(record)[key])),
    0,
  );
}

function numericValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
