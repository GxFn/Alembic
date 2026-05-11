import path from "node:path";
import { EngineeringLanguageService } from "../language/service.js";
import { toEngineeringRelativePath } from "../workspace/paths.js";
import { normalizeImportPackage } from "./module-discovery-rules.js";
import type {
  EngineeringImportFact,
  EngineeringModuleDiscovererInput,
  EngineeringModuleRelationEdge,
  ModuleIndex,
  NormalizedModuleFile,
} from "./module-discovery-types.js";

/** 从 import 事实补齐配置图未声明的模块依赖。 */
export function inferImportFallbackEdges(
  input: EngineeringModuleDiscovererInput,
  files: readonly NormalizedModuleFile[],
  moduleIndex: ModuleIndex,
  existingEdges: readonly EngineeringModuleRelationEdge[],
): EngineeringModuleRelationEdge[] {
  const knownEdges = new Set(existingEdges.map((edge) => edgeKey(edge.from, edge.to)));
  const imports = collectImportFacts(input, files);
  const result: EngineeringModuleRelationEdge[] = [];
  const emitted = new Set<string>();

  for (const importFact of imports) {
    const relativePath = toEngineeringRelativePath(input.projectRoot, importFact.filePath);
    const from = moduleIndex.fileToModule.get(relativePath);
    if (!from) {
      continue;
    }
    const to = resolveImportSpecifier(importFact.specifier, relativePath, files, moduleIndex);
    if (!to || from === to) {
      continue;
    }
    const key = edgeKey(from, to);
    if (knownEdges.has(key) || emitted.has(key)) {
      continue;
    }
    emitted.add(key);
    result.push({ from, to, relation: "depends_on", source: "import", weight: 0.5 });
  }

  return result.sort(
    (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
}

function collectImportFacts(
  input: EngineeringModuleDiscovererInput,
  files: readonly NormalizedModuleFile[],
): EngineeringImportFact[] {
  const facts: EngineeringImportFact[] = [...(input.importFacts ?? [])];
  if (!input.codeGraph) {
    return facts;
  }
  for (const file of files) {
    const symbols = input.codeGraph.getFileSymbols(file.relativePath);
    for (const importRecord of symbols?.imports ?? []) {
      for (const specifier of importSpecifiers(importRecord)) {
        facts.push({ filePath: file.relativePath, specifier, kind: "codeGraph" });
      }
    }
  }
  return facts;
}

function importSpecifiers(importRecord: unknown): string[] {
  if (typeof importRecord === "string") {
    return [importRecord];
  }
  if (!importRecord || typeof importRecord !== "object") {
    return [];
  }
  const record = importRecord as Readonly<Record<string, unknown>>;
  return ["specifier", "module", "source", "path", "name", "imported"]
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function resolveImportSpecifier(
  specifier: string,
  fromFile: string,
  files: readonly NormalizedModuleFile[],
  moduleIndex: ModuleIndex,
): string | undefined {
  const local = resolveLocalImport(specifier, fromFile, files, moduleIndex);
  if (local) {
    return local;
  }
  const normalized = normalizeImportPackage(specifier);
  for (const moduleName of moduleIndex.localNames) {
    if (specifier === moduleName || specifier.startsWith(`${moduleName}/`)) {
      return moduleName;
    }
    const lastSegment = moduleName.split("/").filter(Boolean).at(-1);
    if (lastSegment && normalized === lastSegment) {
      return moduleName;
    }
  }
  return normalized || undefined;
}

function resolveLocalImport(
  specifier: string,
  fromFile: string,
  files: readonly NormalizedModuleFile[],
  moduleIndex: ModuleIndex,
): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  const filePaths = new Set(files.map((file) => file.relativePath));
  const candidates = [
    base,
    ...[...EngineeringLanguageService.sourceExts].map((ext) => `${base}${ext}`),
  ];
  for (const ext of EngineeringLanguageService.sourceExts) {
    candidates.push(`${base}/index${ext}`);
  }
  const targetPath = candidates.find((candidate) => filePaths.has(candidate));
  return targetPath ? moduleIndex.fileToModule.get(targetPath) : undefined;
}

function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}
