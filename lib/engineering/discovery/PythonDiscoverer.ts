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

const PY_EXTENSIONS = new Set([".py"]);
const PY_EXCLUDE_DIRS = new Set([
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".eggs",
  "dist",
  "build",
  "node_modules",
  ".nox",
  ".ruff_cache",
  ".cursor",
]);

export class PythonDiscoverer extends ProjectDiscoverer {
  readonly id = "python";
  readonly displayName = "Python (pip/poetry/pdm)";
  #targets: readonly EngineeringTarget[] = [];
  #depGraph: EngineeringDependencyGraph = { nodes: [], edges: [] };
  #projectName: string | null = null;

  constructor(options: ProjectDiscovererOptions = {}) {
    super(options);
  }

  async detect(projectRoot: string): Promise<EngineeringDetection> {
    let confidence = 0;
    const reasons: string[] = [];
    if (await this.exists(projectRoot, "pyproject.toml")) {
      confidence = 0.9;
      reasons.push("pyproject.toml exists");
    }
    if (await this.exists(projectRoot, "setup.py")) {
      confidence = Math.max(confidence, 0.8);
      reasons.push("setup.py exists");
    }
    if (await this.exists(projectRoot, "setup.cfg")) {
      confidence = Math.max(confidence, 0.8);
      reasons.push("setup.cfg exists");
    }
    if (await this.exists(projectRoot, "requirements.txt")) {
      confidence = Math.max(confidence, 0.6);
      reasons.push("requirements.txt exists");
    }
    if (confidence === 0) {
      const entries = await this.readDir(projectRoot);
      if (entries.some((entry) => entry.isFile && entry.name.endsWith(".py"))) {
        confidence = 0.4;
        reasons.push("*.py files found at root");
      }
    }
    return {
      match: confidence > 0,
      confidence,
      reason: reasons.join(", ") || "No Python markers found",
    };
  }

  async load(projectRoot: string): Promise<void> {
    this.projectRoot = projectRoot;
    const pyproject = this.#parsePyprojectToml(
      (await this.readText(projectRoot, "pyproject.toml")) ?? "",
    );
    this.#projectName =
      pyproject.name ?? (await this.#parseSetupCfgName(projectRoot)) ?? path.basename(projectRoot);
    const packages = await this.#discoverPackages(projectRoot);
    const framework = await this.#detectFramework(projectRoot, pyproject.dependencies);
    const targets = packages.map((pkg) => ({
      name: pkg.name,
      path: pkg.path,
      type: pkg.isTest ? "test" : "library",
      language: "python",
      framework,
      metadata: { pyproject },
    }));
    if (targets.length === 0) {
      targets.push({
        name: this.#projectName,
        path: projectRoot,
        type: "library",
        language: "python",
        framework,
        metadata: { pyproject },
      });
    }

    const rootName = targets[0]?.name ?? this.#projectName;
    const graph: MutableEngineeringDependencyGraph = {
      nodes: targets.map((target) => target.name),
      edges: (await this.#dependencyNames(projectRoot, pyproject.dependencies)).map(
        (dependency) => ({
          from: rootName,
          to: dependency,
          type: "depends_on",
        }),
      ),
    };
    this.#targets = dedupeTargets(targets);
    this.#depGraph = dedupeGraph(graph);
  }

  async listTargets(): Promise<readonly EngineeringTarget[]> {
    return this.#targets;
  }

  async getTargetFiles(target: EngineeringTarget | string): Promise<readonly EngineeringFile[]> {
    const targetObj = targetByName(this.#targets, target, this.projectRoot);
    if (targetObj === null || !(await this.reader.exists(targetObj.path))) {
      return [];
    }
    return collectSourceFiles(this.reader, targetObj.path, {
      extensions: PY_EXTENSIONS,
      language: "python",
      excludeDirs: PY_EXCLUDE_DIRS,
    });
  }

  async getDependencyGraph(): Promise<EngineeringDependencyGraph> {
    return this.#depGraph;
  }

  async #discoverPackages(
    projectRoot: string,
  ): Promise<readonly { name: string; path: string; isTest: boolean }[]> {
    const packages: { name: string; path: string; isTest: boolean }[] = [];
    const srcDir = path.join(projectRoot, "src");
    for (const [baseDir, srcLayout] of [
      [srcDir, true],
      [projectRoot, false],
    ] as const) {
      if (packages.length > 0 || !(await this.reader.exists(baseDir))) {
        continue;
      }
      const entries = await this.readDir(baseDir);
      for (const entry of entries) {
        if (
          !entry.isDirectory ||
          entry.name.startsWith(".") ||
          entry.name.startsWith("_") ||
          PY_EXCLUDE_DIRS.has(entry.name)
        ) {
          continue;
        }
        const pkgDir = path.join(baseDir, entry.name);
        if (await this.reader.exists(path.join(pkgDir, "__init__.py"))) {
          packages.push({
            name: entry.name,
            path: pkgDir,
            isTest: srcLayout ? false : /^tests?$/.test(entry.name),
          });
        }
      }
    }
    for (const testDir of ["tests", "test"]) {
      const testPath = path.join(projectRoot, testDir);
      if ((await this.reader.exists(testPath)) && !packages.some((pkg) => pkg.name === testDir)) {
        packages.push({ name: testDir, path: testPath, isTest: true });
      }
    }
    return packages;
  }

  #parsePyprojectToml(content: string): {
    readonly name?: string;
    readonly dependencies: readonly string[];
  } {
    const name = content.match(/\[project\][\s\S]*?name\s*=\s*["']([^"']+)["']/)?.[1];
    const dependencies: string[] = [];
    const depsMatch = content.match(/\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
    if (depsMatch?.[1]) {
      for (const match of depsMatch[1].matchAll(/["']([^"']+)["']/g)) {
        if (match[1] !== undefined) {
          dependencies.push(match[1]);
        }
      }
    }
    return {
      ...(name === undefined ? {} : { name }),
      dependencies,
    };
  }

  async #parseSetupCfgName(projectRoot: string): Promise<string | null> {
    const content = await this.readText(projectRoot, "setup.cfg");
    return content?.match(/\[metadata\][\s\S]*?^name\s*=\s*(.+)$/m)?.[1]?.trim() ?? null;
  }

  async #dependencyNames(
    projectRoot: string,
    pyprojectDeps: readonly string[],
  ): Promise<readonly string[]> {
    const names = new Set(pyprojectDeps.map(cleanPythonDep).filter((dep) => dep.length > 0));
    const requirements = await this.readText(projectRoot, "requirements.txt");
    if (requirements !== null) {
      for (const rawLine of requirements.split("\n")) {
        const line = rawLine.trim();
        if (line.length > 0 && !line.startsWith("#") && !line.startsWith("-")) {
          const name = cleanPythonDep(line);
          if (name.length > 0) {
            names.add(name);
          }
        }
      }
    }
    return [...names].sort();
  }

  async #detectFramework(
    projectRoot: string,
    pyprojectDeps: readonly string[],
  ): Promise<string | null> {
    const deps = new Set(await this.#dependencyNames(projectRoot, pyprojectDeps));
    if (deps.has("django")) return "django";
    if (deps.has("flask")) return "flask";
    if (deps.has("fastapi")) return "fastapi";
    if (deps.has("langchain") || deps.has("langchain-core") || deps.has("langgraph"))
      return "langchain";
    if (deps.has("torch") || deps.has("tensorflow")) return "ml";
    if (deps.has("scrapy")) return "scrapy";
    if (deps.has("celery")) return "celery";
    return null;
  }
}

function cleanPythonDep(value: string): string {
  return value
    .replace(/[>=<![\]~;@\s].*/g, "")
    .trim()
    .toLowerCase();
}
