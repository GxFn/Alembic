import path from "node:path";
import type { EngineeringCodeImportPathHints, EngineeringCodeImportResolution } from "./types.js";
import { normalizePath } from "./utils.js";

const DEFAULT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".swift",
  ".m",
  ".mm",
  ".h",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
];

export interface ImportPathResolverOptions {
  readonly knownFiles: readonly string[];
  readonly projectRoot?: string;
  readonly pathHints?: EngineeringCodeImportPathHints;
}

export class ImportPathResolver {
  readonly #fileIndex = new Map<string, string>();
  readonly #pathAliases: readonly {
    readonly prefix: string;
    readonly targets: readonly string[];
  }[];
  readonly #extensions: readonly string[];

  constructor(
    options: ImportPathResolverOptions | readonly string[],
    pathHints?: EngineeringCodeImportPathHints,
  ) {
    let normalizedOptions: ImportPathResolverOptions;
    if ("knownFiles" in options) {
      normalizedOptions = options;
    } else {
      normalizedOptions = pathHints ? { knownFiles: options, pathHints } : { knownFiles: options };
    }
    this.#extensions = normalizedOptions.pathHints?.extensions ?? DEFAULT_EXTENSIONS;
    this.#pathAliases = buildPathAliases(normalizedOptions.pathHints);
    for (const file of normalizedOptions.knownFiles) {
      this.#indexFile(normalizePath(file));
    }
  }

  resolve(importPath: string, importerFile: string): EngineeringCodeImportResolution {
    const specifier = importPath.trim();
    const importer = normalizePath(importerFile);
    if (!specifier) {
      return unresolved(specifier, importer, "empty import path");
    }

    if (specifier.startsWith(".")) {
      const joined = normalizePath(path.posix.join(path.posix.dirname(importer), specifier));
      const resolvedPath = this.#lookup(joined);
      return resolvedPath
        ? resolved(specifier, importer, resolvedPath, "relative import")
        : unresolved(specifier, importer, "relative target not found");
    }

    const aliasPath = this.#resolveAlias(specifier);
    if (aliasPath) {
      return resolved(specifier, importer, aliasPath, "path alias");
    }

    const direct = this.#lookup(specifier);
    if (direct) {
      return resolved(specifier, importer, direct, "project file");
    }

    const pythonModule =
      specifier.includes(".") && !specifier.includes("/")
        ? this.#lookup(specifier.replace(/\./g, "/"))
        : null;
    if (pythonModule) {
      return resolved(specifier, importer, pythonModule, "python module path");
    }

    return external(specifier, importer, externalPackageName(specifier));
  }

  resolvePath(importPath: string, importerFile: string): string | null {
    return this.resolve(importPath, importerFile).resolvedPath;
  }

  #indexFile(filePath: string): void {
    this.#fileIndex.set(filePath, filePath);
    const withoutExtension = stripKnownExtension(filePath, this.#extensions);
    this.#fileIndex.set(withoutExtension, filePath);
    if (filePath.match(/\/index\.[^.]+$/)) {
      this.#fileIndex.set(filePath.replace(/\/index\.[^.]+$/, ""), filePath);
    }
    if (filePath.endsWith("/__init__.py")) {
      this.#fileIndex.set(filePath.replace(/\/__init__\.py$/, ""), filePath);
    }
  }

  #lookup(candidate: string): string | null {
    const normalized = normalizePath(candidate);
    if (this.#fileIndex.has(normalized)) {
      return this.#fileIndex.get(normalized) ?? null;
    }
    for (const ext of this.#extensions) {
      const withExt = `${normalized}${ext}`;
      if (this.#fileIndex.has(withExt)) {
        return this.#fileIndex.get(withExt) ?? null;
      }
    }
    return null;
  }

  #resolveAlias(specifier: string): string | null {
    for (const alias of this.#pathAliases) {
      if (specifier !== alias.prefix && !specifier.startsWith(`${alias.prefix}/`)) {
        continue;
      }
      const rest = specifier === alias.prefix ? "" : specifier.slice(alias.prefix.length + 1);
      for (const target of alias.targets) {
        const candidate = rest
          ? normalizePath(path.posix.join(target, rest))
          : normalizePath(target);
        const resolvedPath = this.#lookup(candidate);
        if (resolvedPath) {
          return resolvedPath;
        }
      }
    }
    return null;
  }
}

function buildPathAliases(
  hints: EngineeringCodeImportPathHints | undefined,
): readonly { readonly prefix: string; readonly targets: readonly string[] }[] {
  const aliases: { prefix: string; targets: string[] }[] = [];
  const baseUrl = normalizePath(hints?.baseUrl ?? ".");
  for (const source of [hints?.paths, hints?.aliases]) {
    for (const [pattern, rawTargets] of Object.entries(source ?? {})) {
      const prefix = pattern.replace(/\/?\*$/, "");
      const targetList = Array.isArray(rawTargets) ? rawTargets : [rawTargets];
      const targets = targetList.map((target) =>
        normalizePath(path.posix.join(baseUrl, String(target).replace(/\/?\*$/, ""))),
      );
      if (prefix && targets.length > 0) {
        aliases.push({ prefix, targets });
      }
    }
  }
  return aliases;
}

function stripKnownExtension(filePath: string, extensions: readonly string[]): string {
  const extension = extensions.find((candidate) => filePath.endsWith(candidate));
  return extension ? filePath.slice(0, -extension.length) : filePath;
}

function resolved(
  importPath: string,
  importerFile: string,
  resolvedPath: string,
  reason: string,
): EngineeringCodeImportResolution {
  return {
    importPath,
    importerFile,
    status: "resolved",
    resolvedPath,
    externalPackage: null,
    reason,
    confidence: 0.95,
  };
}

function unresolved(
  importPath: string,
  importerFile: string,
  reason: string,
): EngineeringCodeImportResolution {
  return {
    importPath,
    importerFile,
    status: "unresolved",
    resolvedPath: null,
    externalPackage: null,
    reason,
    confidence: 0.1,
  };
}

function external(
  importPath: string,
  importerFile: string,
  externalPackage: string,
): EngineeringCodeImportResolution {
  return {
    importPath,
    importerFile,
    status: "external",
    resolvedPath: null,
    externalPackage,
    reason: "bare external package",
    confidence: 0.85,
  };
}

function externalPackageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    return specifier.split("/").slice(0, 2).join("/");
  }
  return specifier.split("/")[0] ?? specifier;
}

export default ImportPathResolver;
