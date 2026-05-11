import path from "node:path";
import type {
  EngineeringDependencyGraph,
  EngineeringDetection,
  EngineeringFile,
  EngineeringTarget,
} from "../foundation/EngineeringCoreTypes.js";
import {
  collectSourceFiles,
  dedupeGraph,
  dedupeTargets,
  type MutableEngineeringDependencyGraph,
  targetByName,
} from "./DiscoveryHelpers.js";
import { ProjectDiscoverer, type ProjectDiscovererOptions } from "./ProjectDiscoverer.js";

interface ParsedPackage {
  readonly path: string;
  readonly name: string;
  readonly version: string;
  readonly targets: readonly {
    readonly name: string;
    readonly type: string;
    readonly path: string | null;
    readonly dependencies: readonly string[];
  }[];
  readonly dependencies: readonly (
    | { readonly url: string; readonly version: string | null; readonly type: "package" }
    | { readonly path: string; readonly type: "local" }
  )[];
  readonly products: readonly { readonly name: string; readonly type: string }[];
  readonly platforms: readonly { readonly name: string; readonly version: string }[];
}

const SPM_EXTENSIONS = new Set([".swift", ".m", ".h", ".c", ".cpp", ".mm"]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "Build",
  ".build",
  ".swiftpm",
  "Pods",
  "DerivedData",
  "Carthage",
  ".cursor",
]);

export class SpmDiscoverer extends ProjectDiscoverer {
  readonly id = "spm";
  readonly displayName = "Swift Package Manager (SPM)";
  #packages: readonly { readonly pkgPath: string; readonly parsed: ParsedPackage }[] = [];

  constructor(options: ProjectDiscovererOptions = {}) {
    super(options);
  }

  async detect(projectRoot: string): Promise<EngineeringDetection> {
    if (await this.exists(projectRoot, "Package.swift")) {
      return { match: true, confidence: 0.95, reason: "Package.swift found at project root" };
    }
    for (const entry of await this.readDir(projectRoot)) {
      if (
        entry.isDirectory &&
        !entry.name.startsWith(".") &&
        (await this.exists(projectRoot, entry.name, "Package.swift"))
      ) {
        return { match: true, confidence: 0.85, reason: `Package.swift found in ${entry.name}/` };
      }
    }
    return { match: false, confidence: 0, reason: "No Package.swift found" };
  }

  async load(projectRoot: string): Promise<void> {
    this.projectRoot = projectRoot;
    const packagePaths = await this.#findAllPackageSwifts(projectRoot);
    const parsed = [];
    for (const pkgPath of packagePaths) {
      const content = await this.readText(pkgPath);
      if (content !== null) {
        parsed.push({ pkgPath, parsed: this.#parsePackageSwift(pkgPath, content) });
      }
    }
    this.#packages = parsed;
  }

  async listTargets(): Promise<readonly EngineeringTarget[]> {
    return dedupeTargets(
      this.#packages.flatMap(({ pkgPath, parsed }) =>
        parsed.targets.map((target) => ({
          name: target.name,
          path: path.dirname(pkgPath),
          type: target.type,
          language: "swift",
          metadata: {
            ...target,
            packageName: parsed.name,
            packagePath: pkgPath,
            products: parsed.products,
            platforms: parsed.platforms,
          },
        })),
      ),
    );
  }

  async getTargetFiles(target: EngineeringTarget | string): Promise<readonly EngineeringFile[]> {
    const targets = await this.listTargets();
    const targetObj = targetByName(targets, target, this.projectRoot);
    if (targetObj === null) {
      return [];
    }
    const targetName = targetObj.name;
    for (const { pkgPath, parsed } of this.#packages) {
      const match = parsed.targets.find((candidate) => candidate.name === targetName);
      if (match === undefined) {
        continue;
      }
      const pkgDir = path.dirname(pkgPath);
      const candidates = [
        ...(match.path === null ? [] : [path.join(pkgDir, match.path)]),
        path.join(pkgDir, "Sources", targetName),
        path.join(pkgDir, targetName),
      ];
      for (const candidate of candidates) {
        if (await this.reader.exists(candidate)) {
          return collectSourceFiles(this.reader, candidate, {
            extensions: SPM_EXTENSIONS,
            maxFiles: 300,
            excludeDirs: SKIP_DIRS,
          });
        }
      }
    }
    return [];
  }

  async getDependencyGraph(): Promise<EngineeringDependencyGraph> {
    const nodes: MutableEngineeringDependencyGraph["nodes"] = [];
    const edges: MutableEngineeringDependencyGraph["edges"] = [];
    const packageNames = new Set<string>();
    const targetToPackage = new Map<string, string>();

    for (const { pkgPath, parsed } of this.#packages) {
      if (packageNames.has(parsed.name)) {
        continue;
      }
      packageNames.add(parsed.name);
      nodes.push({
        id: parsed.name,
        label: parsed.name,
        type: "package",
        fullPath: path.dirname(pkgPath),
        targetCount: parsed.targets.length,
      });
      for (const target of parsed.targets) {
        nodes.push({
          id: target.name,
          label: target.name,
          type: "target",
          parent: parsed.name,
          targetType: target.type,
        });
        targetToPackage.set(target.name, parsed.name);
      }
      for (const product of parsed.products) {
        targetToPackage.set(product.name, parsed.name);
      }
    }

    for (const { pkgPath, parsed } of this.#packages) {
      const pkgDir = path.dirname(pkgPath);
      for (const dependency of parsed.dependencies) {
        if (dependency.type === "local") {
          const depPkgPath = path.resolve(pkgDir, dependency.path, "Package.swift");
          const depContent = await this.readText(depPkgPath);
          const depName =
            depContent === null
              ? path.basename(dependency.path)
              : this.#parsePackageSwift(depPkgPath, depContent).name;
          edges.push({ from: parsed.name, to: depName, type: "depends_on" });
        } else {
          const remoteName = path.basename(dependency.url).replace(/\.git$/, "");
          nodes.push({ id: remoteName, label: remoteName, type: "remote", indirect: true });
          edges.push({ from: parsed.name, to: remoteName, type: "depends_on" });
        }
      }
      for (const target of parsed.targets) {
        edges.push({ from: parsed.name, to: target.name, type: "contains" });
        for (const depName of target.dependencies) {
          edges.push({ from: target.name, to: depName, type: "depends_on" });
        }
      }
    }

    return dedupeGraph({ nodes, edges });
  }

  async #findAllPackageSwifts(rootDir: string): Promise<readonly string[]> {
    const results: string[] = [];
    const scan = async (dir: string, depth: number): Promise<void> => {
      if (depth > 5) {
        return;
      }
      for (const entry of await this.readDir(dir)) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory && !SKIP_DIRS.has(entry.name)) {
          await scan(fullPath, depth + 1);
        } else if (entry.isFile && entry.name === "Package.swift") {
          results.push(fullPath);
        }
      }
    };
    await scan(rootDir, 0);
    return results.sort();
  }

  #parsePackageSwift(packagePath: string, content: string): ParsedPackage {
    return {
      path: packagePath,
      name: content.match(/name\s*:\s*"([^"]+)"/)?.[1] ?? "unknown",
      version: content.match(/version\s*:\s*"([^"]+)"/)?.[1] ?? "0.0.0",
      targets: extractTargets(content),
      dependencies: extractDependencies(content),
      products: extractProducts(content),
      platforms: extractPlatforms(content),
    };
  }
}

function extractTargets(content: string): ParsedPackage["targets"] {
  const targets: Array<{
    name: string;
    type: string;
    path: string | null;
    dependencies: string[];
  }> = [];
  const re = /\.(?:target|testTarget|executableTarget)\s*\(/g;
  let match = re.exec(content);
  while (match !== null) {
    const type = match[0].includes("testTarget")
      ? "testTarget"
      : match[0].includes("executableTarget")
        ? "executableTarget"
        : "target";
    const startPos = match.index + match[0].length;
    let depth = 1;
    let endPos = startPos;
    while (depth > 0 && endPos < content.length) {
      if (content[endPos] === "(") depth += 1;
      else if (content[endPos] === ")") depth -= 1;
      endPos += 1;
    }
    const block = content.slice(startPos, endPos - 1);
    const name = block.match(/name\s*:\s*"([^"]+)"/)?.[1];
    if (name === undefined) {
      continue;
    }
    const dependencies: string[] = [];
    const depsMatch = block.match(/dependencies\s*:\s*\[([^\]]*)\]/s);
    if (depsMatch?.[1]) {
      for (const dep of depsMatch[1].matchAll(
        /\.(?:product|target)\s*\(\s*name\s*:\s*"([^"]+)"/g,
      )) {
        if (dep[1] !== undefined) dependencies.push(dep[1]);
      }
      const shorthand = depsMatch[1].replace(/\.(?:product|target)\s*\([^)]*\)/g, "");
      for (const dep of shorthand.matchAll(/"([^"]+)"/g)) {
        if (dep[1] !== undefined) dependencies.push(dep[1]);
      }
    }
    targets.push({
      name,
      type,
      path: block.match(/path\s*:\s*"([^"]+)"/)?.[1] ?? null,
      dependencies,
    });
    match = re.exec(content);
  }
  return targets;
}

function extractDependencies(content: string): ParsedPackage["dependencies"] {
  const deps: Array<
    { url: string; version: string | null; type: "package" } | { path: string; type: "local" }
  > = [];
  for (const match of content.matchAll(/\.package\s*\(\s*url\s*:\s*"([^"]+)"[^)]*\)/g)) {
    const block = match[0];
    deps.push({
      url: match[1] ?? "",
      version:
        block.match(/from\s*:\s*"([^"]+)"/)?.[1] ??
        block.match(/exact\s*:\s*"([^"]+)"/)?.[1] ??
        null,
      type: "package",
    });
  }
  for (const match of content.matchAll(/\.package\s*\(\s*path\s*:\s*"([^"]+)"\s*\)/g)) {
    if (match[1] !== undefined) {
      deps.push({ path: match[1], type: "local" });
    }
  }
  return deps;
}

function extractProducts(content: string): ParsedPackage["products"] {
  return [...content.matchAll(/\.(library|executable)\s*\(\s*name\s*:\s*"([^"]+)"/g)].flatMap(
    (match) =>
      match[1] === undefined || match[2] === undefined ? [] : [{ name: match[2], type: match[1] }],
  );
}

function extractPlatforms(content: string): ParsedPackage["platforms"] {
  return [
    ...content.matchAll(/\.(iOS|macOS|tvOS|watchOS|visionOS)\s*\(\s*\.v(\d+(?:_\d+)?)\s*\)/g),
  ].flatMap((match) =>
    match[1] === undefined || match[2] === undefined
      ? []
      : [{ name: match[1], version: match[2].replace(/_/g, ".") }],
  );
}
