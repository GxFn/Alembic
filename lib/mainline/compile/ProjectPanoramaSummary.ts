import path from "node:path";
import type {
  MainlineProjectGraphExternalDependency,
  MainlineProjectIntelligenceArtifact,
  MainlineProjectIntelligenceFile,
} from "../graph/index.js";

export type MainlineProjectModuleRole =
  | "core"
  | "interface"
  | "data"
  | "service"
  | "agent-orchestration"
  | "test"
  | "documentation"
  | "operations";

export interface MainlineProjectLanguageSummary {
  readonly languageId: string;
  readonly fileCount: number;
  readonly parsedFileCount: number;
  readonly symbolCount: number;
}

export interface MainlineProjectModuleSummary {
  readonly name: string;
  readonly role: MainlineProjectModuleRole;
  readonly fileCount: number;
  readonly sourceFileCount: number;
  readonly testFileCount: number;
  readonly docFileCount: number;
  readonly symbolCount: number;
  readonly dependencyCount: number;
  readonly dependentCount: number;
  readonly externalDependencyCount: number;
  readonly languages: readonly string[];
  readonly representativePaths: readonly string[];
}

export interface MainlineExternalDependencySummary {
  readonly specifier: string;
  readonly count: number;
  readonly kinds: readonly string[];
  readonly fromPaths: readonly string[];
}

export interface MainlineProjectPanoramaSummary {
  readonly projectRoot?: string;
  readonly generatedAt?: number;
  readonly fileCount: number;
  readonly parsedFileCount: number;
  readonly unsupportedFileCount: number;
  readonly failedFileCount: number;
  readonly sourceFileCount: number;
  readonly testFileCount: number;
  readonly docFileCount: number;
  readonly testSourceRatio: number;
  readonly symbolCount: number;
  readonly callSiteCount: number;
  readonly dominantLanguage?: string;
  readonly languages: readonly MainlineProjectLanguageSummary[];
  readonly modules: readonly MainlineProjectModuleSummary[];
  readonly externalDependencies: readonly MainlineExternalDependencySummary[];
  readonly unresolvedDependencyCount: number;
  readonly dependencyCycles: readonly string[][];
  readonly cycleCount: number;
}

interface ModuleAccumulator {
  readonly name: string;
  readonly files: MainlineProjectIntelligenceFile[];
  readonly dependencies: Set<string>;
  readonly dependents: Set<string>;
  readonly externalDependencies: Set<string>;
}

/**
 * ProjectPanoramaSummary 从 ProjectIntelligence artifact 生成项目全景摘要。
 * 它只整理已编译事实，不回扫文件系统，也不承接旧 panorama 的多入口分析状态。
 */
export class ProjectPanoramaSummary {
  summarize(artifact: MainlineProjectIntelligenceArtifact): MainlineProjectPanoramaSummary {
    const files = [...artifact.files].sort((left, right) => left.path.localeCompare(right.path));
    const symbolCountByFile = countSymbolsByFile(artifact);
    const modules = buildModuleSummaries(artifact, symbolCountByFile);
    const languages = buildLanguageSummaries(artifact);
    const sourceFileCount = files.filter(isSourceFile).length;
    const testFileCount = files.filter(isTestFile).length;
    const docFileCount = files.filter(isDocFile).length;
    const dominantLanguage = languages[0]?.languageId;

    return {
      ...(artifact.projectRoot === undefined ? {} : { projectRoot: artifact.projectRoot }),
      ...(artifact.generatedAt === undefined ? {} : { generatedAt: artifact.generatedAt }),
      fileCount: files.length,
      parsedFileCount: files.filter((file) => file.status === "parsed").length,
      unsupportedFileCount: files.filter((file) => file.status === "unsupported").length,
      failedFileCount: files.filter((file) => file.status === "failed").length,
      sourceFileCount,
      testFileCount,
      docFileCount,
      testSourceRatio: roundRatio(testFileCount, sourceFileCount),
      symbolCount: artifact.symbols.length,
      callSiteCount: artifact.callSites.length,
      ...(dominantLanguage === undefined ? {} : { dominantLanguage }),
      languages,
      modules,
      externalDependencies: summarizeExternalDependencies(
        artifact.projectGraph.externalDependencies,
      ),
      unresolvedDependencyCount: artifact.projectGraph.unresolvedDependencies.length,
      dependencyCycles: artifact.projectGraph.cycles.map((cycle) => [...cycle]),
      cycleCount: artifact.projectGraph.cycles.length,
    };
  }
}

export function summarizeMainlineProjectPanorama(
  artifact: MainlineProjectIntelligenceArtifact,
): MainlineProjectPanoramaSummary {
  return new ProjectPanoramaSummary().summarize(artifact);
}

function buildLanguageSummaries(
  artifact: MainlineProjectIntelligenceArtifact,
): MainlineProjectLanguageSummary[] {
  const symbolCountByFile = countSymbolsByFile(artifact);
  const byLanguage = new Map<string, MainlineProjectLanguageSummary>();
  for (const file of artifact.files) {
    const current =
      byLanguage.get(file.languageId) ??
      ({
        languageId: file.languageId,
        fileCount: 0,
        parsedFileCount: 0,
        symbolCount: 0,
      } satisfies MainlineProjectLanguageSummary);
    byLanguage.set(file.languageId, {
      languageId: file.languageId,
      fileCount: current.fileCount + 1,
      parsedFileCount: current.parsedFileCount + (file.status === "parsed" ? 1 : 0),
      symbolCount: current.symbolCount + (symbolCountByFile.get(file.path) ?? 0),
    });
  }
  return [...byLanguage.values()].sort(
    (left, right) =>
      right.fileCount - left.fileCount ||
      right.symbolCount - left.symbolCount ||
      left.languageId.localeCompare(right.languageId),
  );
}

function buildModuleSummaries(
  artifact: MainlineProjectIntelligenceArtifact,
  symbolCountByFile: ReadonlyMap<string, number>,
): MainlineProjectModuleSummary[] {
  const modules = new Map<string, ModuleAccumulator>();
  for (const file of artifact.files) {
    const name = mainlineModuleNameForPath(file.path);
    const accumulator = modules.get(name) ?? {
      name,
      files: [],
      dependencies: new Set<string>(),
      dependents: new Set<string>(),
      externalDependencies: new Set<string>(),
    };
    accumulator.files.push(file);
    modules.set(name, accumulator);
  }

  for (const edge of artifact.projectGraph.edges) {
    if (!edge.from.startsWith("file:") || !edge.to.startsWith("file:")) {
      continue;
    }
    const fromModule = mainlineModuleNameForPath(edge.from.slice("file:".length));
    const toModule = mainlineModuleNameForPath(edge.to.slice("file:".length));
    if (!fromModule || !toModule || fromModule === toModule) {
      continue;
    }
    modules.get(fromModule)?.dependencies.add(toModule);
    modules.get(toModule)?.dependents.add(fromModule);
  }

  for (const dependency of artifact.projectGraph.externalDependencies) {
    modules
      .get(mainlineModuleNameForPath(dependency.fromPath))
      ?.externalDependencies.add(dependency.specifier);
  }

  return [...modules.values()]
    .map((module) => {
      const files = module.files.sort((left, right) => left.path.localeCompare(right.path));
      const sourceFileCount = files.filter(isSourceFile).length;
      const testFileCount = files.filter(isTestFile).length;
      const docFileCount = files.filter(isDocFile).length;
      return {
        name: module.name,
        role: inferModuleRole(module.name, files),
        fileCount: files.length,
        sourceFileCount,
        testFileCount,
        docFileCount,
        symbolCount: files.reduce((sum, file) => sum + (symbolCountByFile.get(file.path) ?? 0), 0),
        dependencyCount: module.dependencies.size,
        dependentCount: module.dependents.size,
        externalDependencyCount: module.externalDependencies.size,
        languages: [...new Set(files.map((file) => file.languageId))].sort(),
        representativePaths: files.slice(0, 5).map((file) => file.path),
      } satisfies MainlineProjectModuleSummary;
    })
    .sort(
      (left, right) =>
        right.fileCount - left.fileCount ||
        right.symbolCount - left.symbolCount ||
        left.name.localeCompare(right.name),
    );
}

function summarizeExternalDependencies(
  dependencies: readonly MainlineProjectGraphExternalDependency[],
): MainlineExternalDependencySummary[] {
  const bySpecifier = new Map<
    string,
    { readonly kinds: Set<string>; readonly fromPaths: Set<string>; count: number }
  >();
  for (const dependency of dependencies) {
    const current = bySpecifier.get(dependency.specifier) ?? {
      kinds: new Set<string>(),
      fromPaths: new Set<string>(),
      count: 0,
    };
    current.kinds.add(dependency.kind);
    current.fromPaths.add(dependency.fromPath);
    current.count += 1;
    bySpecifier.set(dependency.specifier, current);
  }
  return [...bySpecifier.entries()]
    .map(([specifier, summary]) => ({
      specifier,
      count: summary.count,
      kinds: [...summary.kinds].sort(),
      fromPaths: [...summary.fromPaths].sort(),
    }))
    .sort(
      (left, right) => right.count - left.count || left.specifier.localeCompare(right.specifier),
    );
}

function countSymbolsByFile(artifact: MainlineProjectIntelligenceArtifact): Map<string, number> {
  const counts = new Map<string, number>();
  for (const symbol of artifact.symbols) {
    counts.set(symbol.file, (counts.get(symbol.file) ?? 0) + 1);
  }
  return counts;
}

export function mainlineModuleNameForPath(filePath: string): string {
  const segments = filePath.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return path.posix.dirname(filePath) === "." ? "(root)" : path.posix.dirname(filePath);
  }
  if (["apps", "packages"].includes(segments[0] ?? "") && segments[1]) {
    return `${segments[0]}/${segments[1]}`;
  }
  if (["lib", "src", "app"].includes(segments[0] ?? "") && segments[1]) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0] ?? "(root)";
}

function inferModuleRole(
  moduleName: string,
  files: readonly MainlineProjectIntelligenceFile[],
): MainlineProjectModuleRole {
  const haystack = `${moduleName}/${files.map((file) => file.path).join("/")}`.toLowerCase();
  if (files.every(isTestFile) || /(^|\/)(__tests__|tests?|spec)(\/|$)/.test(haystack)) {
    return "test";
  }
  if (files.every(isDocFile) || /(^|\/)(docs?|documentation)(\/|$)/.test(haystack)) {
    return "documentation";
  }
  if (/(^|\/)(agent|agents|workflow|workflows|runtime)(\/|$)/.test(haystack)) {
    return "agent-orchestration";
  }
  if (/(^|\/)(component|components|pages|screens|views|ui)(\/|$)/.test(haystack)) {
    return "interface";
  }
  if (/(^|\/)(db|data|database|model|models|schema|repository|repositories)(\/|$)/.test(haystack)) {
    return "data";
  }
  if (/(^|\/)(api|client|service|services|server|network)(\/|$)/.test(haystack)) {
    return "service";
  }
  if (/(^|\/)(config|scripts?|bin|cli)(\/|$)/.test(haystack)) {
    return "operations";
  }
  return "core";
}

function isSourceFile(file: MainlineProjectIntelligenceFile): boolean {
  return !isTestFile(file) && !isDocFile(file) && file.status === "parsed";
}

function isTestFile(file: MainlineProjectIntelligenceFile): boolean {
  return /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[a-z0-9]+$/i.test(file.path);
}

function isDocFile(file: MainlineProjectIntelligenceFile): boolean {
  return /(^|\/)(docs?|documentation)(\/|$)|\.(md|mdx|rst)$/i.test(file.path);
}

function roundRatio(left: number, right: number): number {
  if (right <= 0) {
    return left > 0 ? 1 : 0;
  }
  return Math.round((left / right) * 1000) / 1000;
}
