import path from "node:path";
import type {
  EngineeringDependencyGraph,
  EngineeringDetection,
  EngineeringFile,
  EngineeringTarget,
} from "../foundation/EngineeringCoreTypes.js";
import { EngineeringLanguageService } from "../language/EngineeringLanguageService.js";
import {
  COMMON_EXCLUDE_DIRS,
  collectSourceFiles,
  dedupeTargets,
  targetByName,
} from "./DiscoveryHelpers.js";
import { ProjectDiscoverer, type ProjectDiscovererOptions } from "./ProjectDiscoverer.js";

export class GenericDiscoverer extends ProjectDiscoverer {
  readonly id = "generic";
  readonly displayName = "Generic (directory scan)";
  #targets: readonly EngineeringTarget[] = [];
  #primaryLang = "unknown";

  constructor(options: ProjectDiscovererOptions = {}) {
    super(options);
  }

  async detect(_projectRoot: string): Promise<EngineeringDetection> {
    return { match: true, confidence: 0.1, reason: "Generic fallback discoverer" };
  }

  async load(projectRoot: string): Promise<void> {
    this.projectRoot = projectRoot;
    this.#primaryLang = await this.#detectPrimaryLanguage(projectRoot);
    const targetDirs = new Set(["src", "lib", "app", "pkg", "cmd", "internal", "test", "tests"]);
    const targets: EngineeringTarget[] = [];
    for (const entry of await this.readDir(projectRoot)) {
      if (!entry.isDirectory || entry.name.startsWith(".") || COMMON_EXCLUDE_DIRS.has(entry.name))
        continue;
      if (targetDirs.has(entry.name.toLowerCase())) {
        targets.push({
          name: entry.name,
          path: path.join(projectRoot, entry.name),
          type: /^tests?$/.test(entry.name) ? "test" : "library",
          language: this.#primaryLang,
        });
      }
    }
    if (targets.length === 0) {
      targets.push({
        name: path.basename(projectRoot),
        path: projectRoot,
        type: "library",
        language: this.#primaryLang,
      });
    }
    this.#targets = dedupeTargets(targets);
  }

  async listTargets(): Promise<readonly EngineeringTarget[]> {
    return this.#targets;
  }

  async getTargetFiles(target: EngineeringTarget | string): Promise<readonly EngineeringFile[]> {
    const targetObj = targetByName(this.#targets, target, this.projectRoot);
    if (targetObj === null || !(await this.reader.exists(targetObj.path))) return [];
    return collectSourceFiles(this.reader, targetObj.path);
  }

  async getDependencyGraph(): Promise<EngineeringDependencyGraph> {
    return { nodes: this.#targets.map((target) => target.name), edges: [] };
  }

  async #detectPrimaryLanguage(projectRoot: string): Promise<string> {
    const stats = new Map<string, number>();
    const scan = async (dir: string, depth: number): Promise<void> => {
      if (depth > 5) return;
      for (const entry of await this.readDir(dir)) {
        if (entry.name.startsWith(".") || COMMON_EXCLUDE_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory) {
          await scan(fullPath, depth + 1);
        } else if (
          entry.isFile &&
          EngineeringLanguageService.sourceExts.has(path.extname(entry.name).toLowerCase())
        ) {
          const language = EngineeringLanguageService.inferLang(entry.name);
          stats.set(language, (stats.get(language) ?? 0) + 1);
        }
      }
    };
    await scan(projectRoot, 0);
    return [...stats.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "unknown";
  }
}
