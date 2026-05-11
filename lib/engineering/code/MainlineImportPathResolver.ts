import fs from "node:fs";
import path from "node:path";
import type { MainlineImportRecord } from "./AstPort.js";

export type MainlineImportPathResolutionStatus = "resolved" | "unresolved" | "external";

export interface MainlineImportPathAlias {
  readonly pattern: string;
  readonly targets: readonly string[];
  readonly baseUrl?: string;
}

export interface MainlineImportPathResolutionRequest {
  readonly projectRoot: string;
  readonly knownFiles: readonly string[];
  readonly importRecords: readonly MainlineImportRecord[];
  readonly fromPath: string;
  readonly languageId: string;
  readonly pathAliases?: readonly MainlineImportPathAlias[];
}

export interface MainlineImportPathResolution {
  readonly status: MainlineImportPathResolutionStatus;
  readonly importPath: string;
  readonly fromPath: string;
  readonly languageId: string;
  readonly record: MainlineImportRecord;
  readonly resolvedPath: string | null;
  readonly externalPackage: string | null;
  readonly reason?: string;
}

interface TsconfigAliasRule {
  readonly pattern: string;
  readonly targets: readonly string[];
}

interface ResolverContext {
  readonly projectRoot: string;
  readonly fileIndex: Map<string, string>;
  readonly pathAliases: readonly TsconfigAliasRule[];
  readonly baseUrls: readonly string[];
  readonly knownTopLevelDirs: ReadonlySet<string>;
}

const SOURCE_EXTENSIONS = [
  ".d.ts",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".m",
  ".dart",
];

const INDEX_FILE_PATTERN = /\/index\.(d\.ts|ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * MainlineImportPathResolver 是新主干的纯路径解析层。
 * 它只根据已知文件、导入记录和 tsconfig/jsconfig 路径配置做 deterministic matching，
 * 不启动旧 AST runtime，也不引入 tree-sitter；AST 层只负责产出 importRecords。
 */
export class MainlineImportPathResolver {
  resolveImports(request: MainlineImportPathResolutionRequest): MainlineImportPathResolution[] {
    const context = createResolverContext(request);
    const fromPath = toProjectPath(request.fromPath, request.projectRoot);
    const languageId = request.languageId.toLowerCase();

    return request.importRecords.map((record) =>
      this.resolveRecord(
        record,
        {
          ...request,
          fromPath,
          languageId,
        },
        context,
      ),
    );
  }

  resolveRecord(
    record: MainlineImportRecord,
    request: Omit<MainlineImportPathResolutionRequest, "importRecords">,
    context = createResolverContext({ ...request, importRecords: [record] }),
  ): MainlineImportPathResolution {
    const importPath = record.path.trim();
    const fromPath = toProjectPath(request.fromPath, request.projectRoot);
    const languageId = request.languageId.toLowerCase();

    if (!importPath) {
      return unresolved(record, importPath, fromPath, languageId, "empty-import-path");
    }

    if (isRelativeSpecifier(importPath) || importPath.startsWith("/")) {
      const candidate =
        languageId === "python" && importPath.startsWith(".")
          ? pythonRelativeCandidate(importPath, fromPath, record)
          : normalizeProjectPath(
              importPath.startsWith("/")
                ? importPath.slice(1)
                : path.posix.join(path.posix.dirname(fromPath), importPath),
            );
      const resolvedPath = context.fileIndex.get(candidate);
      return resolvedPath
        ? resolved(record, importPath, fromPath, languageId, resolvedPath)
        : unresolved(record, importPath, fromPath, languageId, "local-path-not-found");
    }

    const aliasResolution = resolveAliasImport(importPath, context);
    if (aliasResolution.status === "resolved") {
      return resolved(record, importPath, fromPath, languageId, aliasResolution.resolvedPath);
    }
    if (aliasResolution.status === "unresolved") {
      return unresolved(record, importPath, fromPath, languageId, "path-alias-target-not-found");
    }

    const baseUrlResolved = resolveBaseUrlImport(importPath, context);
    if (baseUrlResolved) {
      return resolved(record, importPath, fromPath, languageId, baseUrlResolved);
    }

    const directResolved = context.fileIndex.get(normalizeProjectPath(importPath));
    if (directResolved) {
      return resolved(record, importPath, fromPath, languageId, directResolved);
    }

    if (languageId === "python") {
      const pythonResolved = resolvePythonDottedImport(importPath, record, context);
      if (pythonResolved.status === "resolved") {
        return resolved(record, importPath, fromPath, languageId, pythonResolved.resolvedPath);
      }
      if (pythonResolved.status === "unresolved") {
        return unresolved(
          record,
          importPath,
          fromPath,
          languageId,
          "python-package-member-not-found",
        );
      }
    }

    return external(
      record,
      importPath,
      fromPath,
      languageId,
      externalPackageName(importPath, languageId),
      "bare-specifier",
    );
  }
}

export const defaultMainlineImportPathResolver = new MainlineImportPathResolver();

function createResolverContext(request: MainlineImportPathResolutionRequest): ResolverContext {
  const projectRoot = path.resolve(request.projectRoot);
  const normalizedFiles = request.knownFiles.map((file) => toProjectPath(file, projectRoot));
  const fileIndex = buildFileIndex(normalizedFiles);
  const config = loadTsconfigPathRules(projectRoot);
  const explicitAliases = (request.pathAliases ?? []).flatMap((alias) =>
    alias.targets.map((target) => ({
      pattern: alias.pattern,
      targets: [normalizeProjectPath(path.posix.join(alias.baseUrl ?? ".", target))],
    })),
  );

  return {
    projectRoot,
    fileIndex,
    pathAliases: [...explicitAliases, ...config.pathAliases].sort(
      (left, right) => aliasSpecificity(right.pattern) - aliasSpecificity(left.pattern),
    ),
    baseUrls: config.baseUrls,
    knownTopLevelDirs: new Set(
      normalizedFiles
        .map((file) => file.split("/")[0])
        .filter((segment): segment is string => Boolean(segment)),
    ),
  };
}

function buildFileIndex(files: readonly string[]): Map<string, string> {
  const index = new Map<string, string>();

  for (const file of files) {
    addIndexEntry(index, file, file);
    addIndexEntry(index, stripSourceExtension(file), file);
  }

  for (const file of files) {
    if (INDEX_FILE_PATTERN.test(file)) {
      addIndexEntry(index, file.replace(INDEX_FILE_PATTERN, ""), file);
    }
    if (file.endsWith("/__init__.py")) {
      addIndexEntry(index, file.slice(0, -"/__init__.py".length), file);
    }
  }

  return index;
}

function addIndexEntry(index: Map<string, string>, key: string, file: string): void {
  if (key && !index.has(key)) {
    index.set(key, file);
  }
}

function loadTsconfigPathRules(projectRoot: string): {
  readonly pathAliases: readonly TsconfigAliasRule[];
  readonly baseUrls: readonly string[];
} {
  const candidates = ["tsconfig.json", "tsconfig.app.json", "jsconfig.json"];
  for (const name of candidates) {
    const configPath = path.join(projectRoot, name);
    if (!fs.existsSync(configPath)) {
      continue;
    }

    try {
      const config = JSON.parse(
        stripJsonCommentsAndTrailingCommas(fs.readFileSync(configPath, "utf8")),
      );
      const compilerOptions = config?.compilerOptions ?? {};
      const baseUrl = normalizeProjectPath(String(compilerOptions.baseUrl ?? "."));
      const paths = compilerOptions.paths;
      const pathAliases: TsconfigAliasRule[] = [];

      if (paths && typeof paths === "object") {
        for (const [pattern, rawTargets] of Object.entries(paths)) {
          const targets = (Array.isArray(rawTargets) ? rawTargets : [rawTargets])
            .map((target) => normalizeProjectPath(path.posix.join(baseUrl, String(target))))
            .filter(Boolean);
          if (targets.length > 0) {
            pathAliases.push({ pattern, targets });
          }
        }
      }

      return {
        pathAliases,
        baseUrls: baseUrl === "." ? [] : [baseUrl],
      };
    } catch {
      return { pathAliases: [], baseUrls: [] };
    }
  }

  return { pathAliases: [], baseUrls: [] };
}

function resolveAliasImport(
  importPath: string,
  context: ResolverContext,
):
  | { readonly status: "resolved"; readonly resolvedPath: string }
  | { readonly status: "unresolved" }
  | { readonly status: "none" } {
  let matched = false;
  for (const alias of context.pathAliases) {
    const captures = matchPathPattern(alias.pattern, importPath);
    if (!captures) {
      continue;
    }
    matched = true;
    for (const target of alias.targets) {
      const candidate = applyTargetPattern(target, captures);
      const resolvedPath = context.fileIndex.get(candidate);
      if (resolvedPath) {
        return { status: "resolved", resolvedPath };
      }
    }
  }
  return matched ? { status: "unresolved" } : { status: "none" };
}

function resolveBaseUrlImport(importPath: string, context: ResolverContext): string | null {
  for (const baseUrl of context.baseUrls) {
    const resolvedPath = context.fileIndex.get(
      normalizeProjectPath(path.posix.join(baseUrl, importPath)),
    );
    if (resolvedPath) {
      return resolvedPath;
    }
  }
  return null;
}

function resolvePythonDottedImport(
  importPath: string,
  record: MainlineImportRecord,
  context: ResolverContext,
):
  | { readonly status: "resolved"; readonly resolvedPath: string }
  | { readonly status: "unresolved" }
  | { readonly status: "none" } {
  const topLevel = importPath.split(".")[0] ?? importPath;
  const modulePath = normalizeProjectPath(importPath.replace(/\./g, "/"));
  const symbol = record.symbols.length === 1 ? record.symbols[0] : null;

  if (symbol && symbol !== "*") {
    const memberModulePath = normalizeProjectPath(path.posix.join(modulePath, symbol));
    const memberResolved = context.fileIndex.get(memberModulePath);
    if (memberResolved) {
      return { status: "resolved", resolvedPath: memberResolved };
    }
  }

  const moduleResolved = context.fileIndex.get(modulePath);
  if (moduleResolved) {
    return { status: "resolved", resolvedPath: moduleResolved };
  }

  if (context.knownTopLevelDirs.has(topLevel)) {
    return { status: "unresolved" };
  }
  return { status: "none" };
}

function pythonRelativeCandidate(
  importPath: string,
  fromPath: string,
  record: MainlineImportRecord,
): string {
  const leadingDots = importPath.match(/^\.+/)?.[0].length ?? 0;
  const rest = importPath.slice(leadingDots).replace(/\./g, "/");
  let baseDir = path.posix.dirname(fromPath);
  for (let index = 1; index < leadingDots; index++) {
    baseDir = path.posix.dirname(baseDir);
  }

  const symbol = !rest && record.symbols.length === 1 ? record.symbols[0] : null;
  return normalizeProjectPath(path.posix.join(baseDir, rest || symbol || ""));
}

function matchPathPattern(pattern: string, importPath: string): readonly string[] | null {
  if (!pattern.includes("*")) {
    return pattern === importPath ? [] : null;
  }

  const [prefix, suffix = ""] = pattern.split("*");
  if (!importPath.startsWith(prefix ?? "") || !importPath.endsWith(suffix)) {
    return null;
  }
  return [importPath.slice((prefix ?? "").length, importPath.length - suffix.length)];
}

function applyTargetPattern(target: string, captures: readonly string[]): string {
  if (target.includes("*")) {
    return normalizeProjectPath(target.replace("*", captures[0] ?? ""));
  }
  if (captures[0]) {
    return normalizeProjectPath(path.posix.join(target, captures[0]));
  }
  return normalizeProjectPath(target);
}

function aliasSpecificity(pattern: string): number {
  return pattern.replace("*", "").length;
}

function stripSourceExtension(file: string): string {
  const extension = SOURCE_EXTENSIONS.find((candidate) => file.endsWith(candidate));
  return extension ? file.slice(0, -extension.length) : file;
}

function stripJsonCommentsAndTrailingCommas(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,\s*([}\]])/g, "$1");
}

function isRelativeSpecifier(importPath: string): boolean {
  return (
    importPath === "." ||
    importPath === ".." ||
    importPath.startsWith("./") ||
    importPath.startsWith("../")
  );
}

function toProjectPath(filePath: string, projectRoot: string): string {
  const slashPath = filePath.replace(/\\/g, "/");
  const slashRoot = path.resolve(projectRoot).replace(/\\/g, "/");
  if (path.isAbsolute(filePath) || slashPath.startsWith(`${slashRoot}/`)) {
    return normalizeProjectPath(path.relative(slashRoot, slashPath));
  }
  return normalizeProjectPath(slashPath);
}

function normalizeProjectPath(value: string): string {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
  return normalized === "." ? "" : normalized.replace(/^\/+/, "").replace(/\/+$/, "");
}

function externalPackageName(importPath: string, languageId: string): string {
  if (importPath.startsWith("node:")) {
    return importPath;
  }
  if (languageId === "python") {
    return importPath.split(".")[0] ?? importPath;
  }
  if (importPath.startsWith("@")) {
    const [scope, name] = importPath.split("/");
    return name ? `${scope}/${name}` : importPath;
  }
  return importPath.split("/")[0] ?? importPath;
}

function resolved(
  record: MainlineImportRecord,
  importPath: string,
  fromPath: string,
  languageId: string,
  resolvedPath: string,
): MainlineImportPathResolution {
  return {
    status: "resolved",
    importPath,
    fromPath,
    languageId,
    record,
    resolvedPath,
    externalPackage: null,
  };
}

function unresolved(
  record: MainlineImportRecord,
  importPath: string,
  fromPath: string,
  languageId: string,
  reason: string,
): MainlineImportPathResolution {
  return {
    status: "unresolved",
    importPath,
    fromPath,
    languageId,
    record,
    resolvedPath: null,
    externalPackage: null,
    reason,
  };
}

function external(
  record: MainlineImportRecord,
  importPath: string,
  fromPath: string,
  languageId: string,
  externalPackage: string,
  reason: string,
): MainlineImportPathResolution {
  return {
    status: "external",
    importPath,
    fromPath,
    languageId,
    record,
    resolvedPath: null,
    externalPackage,
    reason,
  };
}
