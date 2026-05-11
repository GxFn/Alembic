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

const GO_EXTENSIONS = new Set([".go"]);
const GO_EXCLUDE = new Set([
  ".git",
  ".cursor",
  "vendor",
  "node_modules",
  "testdata",
  ".cache",
  "dist",
  "build",
  "_output",
]);

export class GoDiscoverer extends ProjectDiscoverer {
  readonly id = "go";
  readonly displayName = "Go (modules)";
  #targets: readonly EngineeringTarget[] = [];
  #depGraph: EngineeringDependencyGraph = { nodes: [], edges: [] };
  #modulePath: string | null = null;

  constructor(options: ProjectDiscovererOptions = {}) {
    super(options);
  }

  async detect(projectRoot: string): Promise<EngineeringDetection> {
    let confidence = 0;
    const reasons: string[] = [];
    if (await this.exists(projectRoot, "go.mod")) {
      confidence = 0.92;
      reasons.push("go.mod exists");
    }
    if (await this.exists(projectRoot, "go.sum")) {
      confidence = Math.max(confidence, 0.7);
      if (confidence < 0.92) confidence += 0.1;
      reasons.push("go.sum exists");
    }
    if (await this.exists(projectRoot, "go.work")) {
      confidence = Math.max(confidence, 0.95);
      reasons.push("go.work exists (workspace)");
    }
    if (
      confidence === 0 &&
      (await this.readDir(projectRoot)).some((entry) => entry.isFile && entry.name.endsWith(".go"))
    ) {
      confidence = 0.5;
      reasons.push("*.go files found at root");
    }
    return {
      match: confidence > 0,
      confidence,
      reason: reasons.join(", ") || "No Go markers found",
    };
  }

  async load(projectRoot: string): Promise<void> {
    this.projectRoot = projectRoot;
    const goMod = await this.readText(projectRoot, "go.mod");
    this.#modulePath = goMod?.match(/^module\s+(\S+)/m)?.[1] ?? null;
    const projectName = this.#modulePath?.split("/").at(-1) ?? path.basename(projectRoot);
    const framework = goMod === null ? null : detectGoFramework(goMod);
    const targets: EngineeringTarget[] = [
      {
        name: projectName,
        path: projectRoot,
        type: "library",
        language: "go",
        framework,
        metadata: { modulePath: this.#modulePath },
      },
      ...(await this.#discoverCmdTargets(projectRoot, framework)),
    ];
    for (const testDir of ["test", "tests", "e2e"]) {
      const testPath = path.join(projectRoot, testDir);
      if (
        (await this.reader.exists(testPath)) &&
        !targets.some((target) => target.name === testDir)
      ) {
        targets.push({ name: testDir, path: testPath, type: "test", language: "go" });
      }
    }
    const graph: MutableEngineeringDependencyGraph = {
      nodes: targets.map((target) => target.name),
      edges: [],
    };
    this.#targets = dedupeTargets(targets);
    await this.#discoverInternalPackages(projectRoot, graph);
    this.#parseGoDependencies(goMod ?? "", projectName, graph);
    await this.#parseInternalImports(projectRoot, projectName, graph);
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
      extensions: GO_EXTENSIONS,
      language: "go",
      excludeDirs: GO_EXCLUDE,
    });
  }

  async getDependencyGraph(): Promise<EngineeringDependencyGraph> {
    return this.#depGraph;
  }

  async #discoverCmdTargets(
    projectRoot: string,
    framework: string | null,
  ): Promise<readonly EngineeringTarget[]> {
    const cmdDir = path.join(projectRoot, "cmd");
    if (!(await this.reader.exists(cmdDir))) {
      return [];
    }
    const entries = await this.readDir(cmdDir);
    const targets = entries
      .filter((entry) => entry.isDirectory && !entry.name.startsWith("."))
      .map((entry) => ({
        name: `cmd/${entry.name}`,
        path: path.join(cmdDir, entry.name),
        type: "application",
        language: "go",
        framework,
        metadata: { modulePath: this.#modulePath, isCmdBinary: true },
      }));
    if (
      targets.length === 0 &&
      entries.some((entry) => entry.isFile && entry.name.endsWith(".go"))
    ) {
      return [{ name: "cmd", path: cmdDir, type: "application", language: "go", framework }];
    }
    return targets;
  }

  async #discoverInternalPackages(
    projectRoot: string,
    graph: MutableEngineeringDependencyGraph,
  ): Promise<void> {
    const nodeSet = new Set(graph.nodes.map((node) => (typeof node === "string" ? node : node.id)));
    const walk = async (dir: string, relPath: string, depth: number): Promise<void> => {
      if (depth > 6) return;
      for (const entry of await this.readDir(dir)) {
        if (!entry.isDirectory || entry.name.startsWith(".") || GO_EXCLUDE.has(entry.name))
          continue;
        const subDir = path.join(dir, entry.name);
        const subRel = relPath ? `${relPath}/${entry.name}` : entry.name;
        if (
          (await this.readDir(subDir)).some(
            (candidate) => candidate.isFile && candidate.name.endsWith(".go"),
          ) &&
          !nodeSet.has(subRel)
        ) {
          graph.nodes.push({ id: subRel, label: subRel, type: "internal" });
          nodeSet.add(subRel);
        }
        await walk(subDir, subRel, depth + 1);
      }
    };
    await walk(projectRoot, "", 0);
  }

  #parseGoDependencies(
    content: string,
    rootNode: string,
    graph: MutableEngineeringDependencyGraph,
  ): void {
    const add = (fullPath: string, indirect: boolean): void => {
      const shortName = fullPath.split("/").at(-1) ?? fullPath;
      graph.nodes.push({ id: shortName, label: shortName, type: "external", fullPath, indirect });
      graph.edges.push({
        from: rootNode,
        to: shortName,
        type: indirect ? "indirect" : "dependency",
      });
    };
    for (const block of content.matchAll(/require\s*\(([\s\S]*?)\)/g)) {
      for (const line of (block[1] ?? "").split("\n")) {
        const trimmed = line.trim();
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2 && !trimmed.startsWith("//") && parts[0] !== undefined)
          add(parts[0], trimmed.includes("// indirect"));
      }
    }
    for (const match of content.matchAll(/^require\s+([^\s(]\S*)\s+\S+/gm)) {
      if (match[1] !== undefined) add(match[1], match[0].includes("// indirect"));
    }
  }

  async #parseInternalImports(
    projectRoot: string,
    rootNode: string,
    graph: MutableEngineeringDependencyGraph,
  ): Promise<void> {
    const modulePath = this.#modulePath;
    if (modulePath === null) return;
    const internalNodes = new Set(
      graph.nodes.flatMap((node) =>
        typeof node === "object" && node.type === "internal" ? [node.id] : [],
      ),
    );
    const edgeSet = new Set<string>();
    const scan = async (dir: string, pkgId: string): Promise<void> => {
      for (const entry of await this.readDir(dir)) {
        if (!entry.isFile || !entry.name.endsWith(".go")) continue;
        const content = await this.readText(path.join(dir, entry.name));
        for (const match of (content ?? "").matchAll(/"([^"]+)"/g)) {
          const importPath = match[1];
          if (importPath === undefined || !importPath.startsWith(`${modulePath}/`)) continue;
          const relImport = importPath.slice(modulePath.length + 1);
          const target = [...internalNodes].find(
            (nodeId) => relImport === nodeId || relImport.startsWith(`${nodeId}/`),
          );
          if (target !== undefined && target !== pkgId && !edgeSet.has(`${pkgId}->${target}`)) {
            edgeSet.add(`${pkgId}->${target}`);
            graph.edges.push({ from: pkgId, to: target, type: "internal" });
          }
        }
      }
    };
    await scan(projectRoot, rootNode);
    for (const nodeId of internalNodes) {
      await scan(path.join(projectRoot, nodeId), nodeId);
    }
    for (const target of this.#targets) {
      if (target.path !== projectRoot) await scan(target.path, target.name);
    }
  }
}

function detectGoFramework(goMod: string): string | null {
  if (/github\.com\/gin-gonic\/gin\b/.test(goMod)) return "gin";
  if (/github\.com\/labstack\/echo\b/.test(goMod)) return "echo";
  if (/github\.com\/gofiber\/fiber\b/.test(goMod)) return "fiber";
  if (/github\.com\/gorilla\/mux\b/.test(goMod)) return "gorilla";
  if (/google\.golang\.org\/grpc\b/.test(goMod)) return "grpc";
  if (/github\.com\/go-chi\/chi\b/.test(goMod)) return "chi";
  return null;
}
