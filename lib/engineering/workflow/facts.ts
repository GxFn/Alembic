import type {
  EngineeringCodeAstFileSummaryInput,
  EngineeringCodeAstSummaryInput,
} from "../code/types.js";
import type { EngineeringImportFact } from "../panorama/module-discoverer.js";
import { isEngineeringGeneratedArtifact } from "./core/core.js";
import type {
  EngineeringWorkflowDiscoveryResult,
  EngineeringWorkflowFactBundle,
  EngineeringWorkflowInput,
} from "./types.js";

export function discoveryShellFacts(
  input: EngineeringWorkflowInput,
  discovery: EngineeringWorkflowDiscoveryResult,
): EngineeringWorkflowFactBundle {
  const { astSummaries: _astSummaries, ...withoutAstSummaries } = input;
  void _astSummaries;
  return collectFacts({ ...withoutAstSummaries, importFacts: [], fileContents: {} }, discovery);
}

export function collectFacts(
  input: EngineeringWorkflowInput,
  discovery: EngineeringWorkflowDiscoveryResult,
): EngineeringWorkflowFactBundle {
  const maxFiles = input.maxFiles ?? Number.POSITIVE_INFINITY;
  const generatedArtifactPaths: string[] = [];
  const files = [];

  for (const file of discovery.files) {
    const key = file.relativePath || file.path;
    if (isEngineeringGeneratedArtifact(key) || isEngineeringGeneratedArtifact(file.path)) {
      generatedArtifactPaths.push(key);
      continue;
    }
    if (files.length >= maxFiles) {
      continue;
    }
    files.push(file);
  }

  const filePathSet = new Set(files.flatMap((file) => [file.relativePath, file.path]));
  const fileContents = Object.fromEntries(
    Object.entries(input.fileContents ?? {}).filter(([filePath]) => filePathSet.has(filePath)),
  );
  const importFacts = dedupeImportFacts([
    ...(input.importFacts ?? []),
    ...extractImportFacts(input.astSummaries, filePathSet),
  ]);

  return {
    files,
    fileContents,
    importFacts,
    ...(input.astSummaries === undefined ? {} : { astSummaries: input.astSummaries }),
    generatedArtifactPaths,
  };
}

export function emptyFacts(): EngineeringWorkflowFactBundle {
  return {
    files: [],
    fileContents: {},
    importFacts: [],
    generatedArtifactPaths: [],
  };
}

export function astSummariesFrom(
  input: EngineeringCodeAstSummaryInput,
): readonly EngineeringCodeAstFileSummaryInput[] {
  if (Array.isArray(input)) {
    return input;
  }
  const container = input as Exclude<
    EngineeringCodeAstSummaryInput,
    readonly EngineeringCodeAstFileSummaryInput[]
  >;
  return (
    container.fileSummaries ?? container.files ?? container.astProjectSummary?.fileSummaries ?? []
  );
}

export function countAstSummaries(input: EngineeringCodeAstSummaryInput | undefined): number {
  return input === undefined ? 0 : astSummariesFrom(input).length;
}

function extractImportFacts(
  input: EngineeringCodeAstSummaryInput | undefined,
  filePathSet: ReadonlySet<string>,
): readonly EngineeringImportFact[] {
  if (!input) {
    return [];
  }
  const facts: EngineeringImportFact[] = [];
  for (const summary of astSummariesFrom(input)) {
    const filePath = stringValue(summary.file ?? summary.path ?? summary.filePath);
    if (!filePath || !filePathSet.has(filePath)) {
      continue;
    }
    for (const rawImport of Array.isArray(summary.imports) ? summary.imports : []) {
      const record: Record<string, unknown> = isRecord(rawImport) ? rawImport : { path: rawImport };
      const specifier = stringValue(
        record.specifier ?? record.path ?? record.module ?? record.source,
      );
      if (!specifier) {
        continue;
      }
      facts.push({
        filePath,
        specifier,
        ...(typeof record.kind === "string" ? { kind: record.kind } : {}),
      });
    }
  }
  return facts;
}

function dedupeImportFacts(
  facts: readonly EngineeringImportFact[],
): readonly EngineeringImportFact[] {
  const byKey = new Map<string, EngineeringImportFact>();
  for (const fact of facts) {
    byKey.set(`${fact.filePath}\0${fact.specifier}\0${fact.kind ?? ""}`, fact);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.filePath.localeCompare(right.filePath) ||
      left.specifier.localeCompare(right.specifier) ||
      (left.kind ?? "").localeCompare(right.kind ?? ""),
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
