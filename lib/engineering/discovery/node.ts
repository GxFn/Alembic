import path from "node:path";
import type {
  EngineeringDependencyGraph,
  EngineeringDetection,
  EngineeringFile,
  EngineeringTarget,
} from "../foundation/types.js";
import {
  collectSourceFiles,
  dedupeGraph,
  dedupeTargets,
  expandSimpleWorkspacePatterns,
  graphFromParseResults,
  type MutableEngineeringDependencyGraph,
  objectKeys,
  recordValue,
  stringValue,
  targetByName,
  targetsFromParseResults,
} from "./helpers.js";
import { parseJsonDiscoveryFile, parseYamlDiscoveryFile } from "./parsers/index.js";
import { ProjectDiscoverer, type ProjectDiscovererOptions } from "./project.js";

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
]);

export class NodeDiscoverer extends ProjectDiscoverer {
  readonly id = "node";
  readonly displayName = "Node.js (npm/pnpm/yarn)";
  #packageJson: Record<string, unknown> = {};
  #targets: readonly EngineeringTarget[] = [];
  #depGraph: EngineeringDependencyGraph = { nodes: [], edges: [] };

  constructor(options: ProjectDiscovererOptions = {}) {
    super(options);
  }

  async detect(projectRoot: string): Promise<EngineeringDetection> {
    let confidence = 0;
    const reasons: string[] = [];
    if (await this.exists(projectRoot, "package.json")) {
      confidence = 0.9;
      reasons.push("package.json exists");
    }
    if (await this.exists(projectRoot, "tsconfig.json")) {
      confidence = Math.max(confidence, 0.9) + 0.05;
      reasons.push("tsconfig.json exists");
    }
    if (await this.exists(projectRoot, "node_modules")) {
      confidence += 0.05;
      reasons.push("node_modules/ exists");
    }
    if (confidence > 0) {
      if (
        (await this.exists(projectRoot, "Gemfile")) ||
        (await this.exists(projectRoot, "Rakefile"))
      ) {
        confidence *= 0.05;
        reasons.push("Ruby marker found; confidence reduced");
      } else if (
        (await this.exists(projectRoot, "Cargo.toml")) ||
        (await this.exists(projectRoot, "go.mod"))
      ) {
        confidence *= (await this.exists(projectRoot, "tsconfig.json")) ? 0.5 : 0.05;
        reasons.push("another primary ecosystem marker found; confidence reduced");
      }
    }
    return {
      match: confidence > 0,
      confidence: Math.min(confidence, 1),
      reason: reasons.join(", ") || "No Node.js markers found",
    };
  }

  async load(projectRoot: string): Promise<void> {
    this.projectRoot = projectRoot;
    const parseResults = [];
    const packagePath = path.join(projectRoot, "package.json");
    const packageContent = await this.readText(packagePath);
    this.#packageJson =
      packageContent === null ? {} : (JSON.parse(packageContent) as Record<string, unknown>);
    if (packageContent !== null) {
      parseResults.push(parseJsonDiscoveryFile({ filePath: packagePath, content: packageContent }));
    }
    for (const fileName of ["tsconfig.json", "nx.json"]) {
      const filePath = path.join(projectRoot, fileName);
      const content = await this.readText(filePath);
      if (content !== null) {
        parseResults.push(parseJsonDiscoveryFile({ filePath, content }));
      }
    }
    const pnpmPath = path.join(projectRoot, "pnpm-workspace.yaml");
    const pnpmContent = await this.readText(pnpmPath);
    if (pnpmContent !== null) {
      parseResults.push(parseYamlDiscoveryFile({ filePath: pnpmPath, content: pnpmContent }));
    }

    const workspacePaths = await this.#resolveWorkspaces(projectRoot);
    const targets: EngineeringTarget[] = [];
    const parsedGraph = graphFromParseResults(parseResults);
    const graph: MutableEngineeringDependencyGraph = {
      nodes: [...parsedGraph.nodes],
      edges: [...parsedGraph.edges],
      ...(parsedGraph.layers === undefined ? {} : { layers: parsedGraph.layers }),
    };

    if (workspacePaths.length > 0) {
      for (const workspacePath of workspacePaths) {
        const absPath = path.resolve(projectRoot, workspacePath);
        const pkg = (await this.readJson(path.join(absPath, "package.json"))) ?? {};
        const name = stringValue(pkg.name) ?? path.basename(workspacePath);
        targets.push({
          name,
          path: absPath,
          type: this.#inferTargetType(pkg),
          language: "typescript",
          framework: this.#detectFramework(pkg),
          metadata: { packageJson: pkg, workspacePath },
        });
      }
      graph.edges.push(...this.#workspaceEdges(targets));
    } else {
      const name = stringValue(this.#packageJson.name) ?? path.basename(projectRoot);
      targets.push({
        name,
        path: projectRoot,
        type: this.#inferTargetType(this.#packageJson),
        language: "typescript",
        framework: this.#detectFramework(this.#packageJson),
        metadata: { packageJson: this.#packageJson },
      });
    }

    for (const target of targets) {
      graph.nodes.push(target.name);
    }
    const rootName = targets[0]?.name;
    if (rootName !== undefined) {
      for (const dependency of objectKeys(this.#packageJson.dependencies)) {
        graph.edges.push({ from: rootName, to: dependency, type: "depends_on" });
      }
      for (const dependency of objectKeys(this.#packageJson.devDependencies)) {
        graph.edges.push({ from: rootName, to: dependency, type: "dev_depends_on" });
      }
    }

    this.#targets = dedupeTargets([
      ...targets,
      ...targetsFromParseResults(parseResults, projectRoot),
    ]);
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
      extensions: SOURCE_EXTENSIONS,
    });
  }

  async getDependencyGraph(): Promise<EngineeringDependencyGraph> {
    return this.#depGraph;
  }

  async #resolveWorkspaces(projectRoot: string): Promise<readonly string[]> {
    const patterns: string[] = [];
    const workspaces = this.#packageJson.workspaces;
    if (Array.isArray(workspaces)) {
      patterns.push(...workspaces.filter((item): item is string => typeof item === "string"));
    } else {
      const workspaceRecord = recordValue(workspaces);
      const packages = workspaceRecord?.packages;
      if (Array.isArray(packages)) {
        patterns.push(...packages.filter((item): item is string => typeof item === "string"));
      }
    }
    if (patterns.length === 0) {
      const content = await this.readText(projectRoot, "pnpm-workspace.yaml");
      if (content !== null) {
        for (const match of content.matchAll(/^\s*-\s*['"]?([^'"#\n]+)['"]?/gm)) {
          if (match[1] !== undefined) {
            patterns.push(match[1].trim());
          }
        }
      }
    }
    if (patterns.length === 0) {
      const lerna = await this.readJson(path.join(projectRoot, "lerna.json"));
      const packages = lerna?.packages;
      if (Array.isArray(packages)) {
        patterns.push(...packages.filter((item): item is string => typeof item === "string"));
      }
    }
    return expandSimpleWorkspacePatterns(this.reader, projectRoot, patterns);
  }

  #workspaceEdges(
    targets: readonly EngineeringTarget[],
  ): MutableEngineeringDependencyGraph["edges"] {
    const workspaceNames = new Set(targets.map((target) => target.name));
    return targets.flatMap((target) => {
      const pkg = recordValue(target.metadata?.packageJson);
      const dependencies = recordValue(pkg?.dependencies) ?? {};
      const devDependencies = recordValue(pkg?.devDependencies) ?? {};
      return [...Object.keys(dependencies), ...Object.keys(devDependencies)].flatMap(
        (dependency) => {
          if (!workspaceNames.has(dependency)) {
            return [];
          }
          return [
            {
              from: target.name,
              to: dependency,
              type: Object.hasOwn(devDependencies, dependency) ? "dev_depends_on" : "depends_on",
            },
          ];
        },
      );
    });
  }

  #detectFramework(pkg: Record<string, unknown>): string | null {
    const deps = {
      ...(recordValue(pkg.dependencies) ?? {}),
      ...(recordValue(pkg.devDependencies) ?? {}),
    };
    if (deps.next) return "nextjs";
    if (deps.nuxt || deps.nuxt3) return "nuxt";
    if (deps["@angular/core"]) return "angular";
    if (deps.svelte) return "svelte";
    if (deps["react-native"]) return "react-native";
    if (deps.react || deps["react-dom"]) return "react";
    if (deps.vue) return "vue";
    if (deps["@nestjs/core"]) return "nestjs";
    if (deps.electron) return "electron";
    if (deps.express || deps.fastify || deps.koa || deps.hono) return "node-server";
    return null;
  }

  #inferTargetType(pkg: Record<string, unknown>): string {
    const deps = {
      ...(recordValue(pkg.dependencies) ?? {}),
      ...(recordValue(pkg.devDependencies) ?? {}),
    };
    if (pkg.bin !== undefined) return "executable";
    if (deps.react || deps.vue || deps["@angular/core"] || deps.svelte) return "app";
    if (deps.express || deps.fastify || deps.koa || deps["@nestjs/core"] || deps.electron)
      return "app";
    if (typeof pkg.name === "string" && pkg.name.includes("test")) return "test";
    return "library";
  }
}
