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
  type MutableEngineeringDependencyGraph,
  targetByName,
} from "./helpers.js";
import { ProjectDiscoverer, type ProjectDiscovererOptions } from "./project.js";

const RUST_EXTENSIONS = new Set([".rs"]);
const RUST_EXCLUDE = new Set([
  ".git",
  "target",
  "node_modules",
  ".cargo",
  ".idea",
  ".vscode",
  "dist",
  "build",
  ".cursor",
]);

interface CargoInfo {
  readonly name: string | undefined;
  readonly edition: string | undefined;
  readonly isBin: boolean;
  readonly isLib: boolean;
}

export class RustDiscoverer extends ProjectDiscoverer {
  readonly id = "rust";
  readonly displayName = "Rust (Cargo)";
  #targets: readonly EngineeringTarget[] = [];
  #depGraph: EngineeringDependencyGraph = { nodes: [], edges: [] };
  #crateName: string | null = null;

  constructor(options: ProjectDiscovererOptions = {}) {
    super(options);
  }

  async detect(projectRoot: string): Promise<EngineeringDetection> {
    let confidence = 0;
    const reasons: string[] = [];
    if (await this.exists(projectRoot, "Cargo.toml")) {
      confidence = 0.92;
      reasons.push("Cargo.toml exists");
    }
    if (await this.exists(projectRoot, "Cargo.lock")) {
      confidence = Math.max(confidence, 0.7);
      if (confidence < 0.92) confidence += 0.1;
      reasons.push("Cargo.lock exists");
    }
    if (
      (await this.exists(projectRoot, "rust-toolchain.toml")) ||
      (await this.exists(projectRoot, "rust-toolchain"))
    ) {
      confidence = Math.max(confidence, 0.85);
      reasons.push("rust-toolchain exists");
    }
    if (
      confidence === 0 &&
      (await this.readDir(projectRoot)).some((entry) => entry.isFile && entry.name.endsWith(".rs"))
    ) {
      confidence = 0.5;
      reasons.push("*.rs files found at root");
    }
    return {
      match: confidence > 0,
      confidence,
      reason: reasons.join(", ") || "No Rust markers found",
    };
  }

  async load(projectRoot: string): Promise<void> {
    this.projectRoot = projectRoot;
    const cargoToml = await this.readText(projectRoot, "Cargo.toml");
    const cargoInfo = await this.#parseCargoToml(projectRoot);
    this.#crateName = cargoInfo?.name ?? path.basename(projectRoot);
    const framework = detectRustFramework(cargoToml ?? "");
    const targets: EngineeringTarget[] = [
      {
        name: this.#crateName,
        path: projectRoot,
        type: cargoInfo?.isBin === true ? "application" : "library",
        language: "rust",
        framework,
        metadata: { edition: cargoInfo?.edition ?? null, crateName: this.#crateName },
      },
      ...(await this.#discoverWorkspaceMembers(projectRoot)),
      ...(await this.#discoverExamples(projectRoot, framework)),
      ...(await this.#discoverBenches(projectRoot)),
    ];
    const testsDir = path.join(projectRoot, "tests");
    if (await this.reader.exists(testsDir)) {
      targets.push({ name: "tests", path: testsDir, type: "test", language: "rust" });
    }
    const graph: MutableEngineeringDependencyGraph = {
      nodes: targets.map((target) => target.name),
      edges: [],
    };
    this.#parseDependencies(cargoToml ?? "", this.#crateName, graph);
    await this.#discoverInternalModules(projectRoot, graph);
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
      extensions: RUST_EXTENSIONS,
      language: "rust",
      excludeDirs: RUST_EXCLUDE,
    });
  }

  async getDependencyGraph(): Promise<EngineeringDependencyGraph> {
    return this.#depGraph;
  }

  async #parseCargoToml(projectRoot: string): Promise<CargoInfo | null> {
    const content = await this.readText(projectRoot, "Cargo.toml");
    if (content === null) return null;
    return {
      name: content.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1],
      edition: content.match(/^\s*edition\s*=\s*"([^"]+)"/m)?.[1],
      isBin: (await this.exists(projectRoot, "src", "main.rs")) || /\[\[bin\]\]/.test(content),
      isLib: await this.exists(projectRoot, "src", "lib.rs"),
    };
  }

  async #discoverWorkspaceMembers(projectRoot: string): Promise<readonly EngineeringTarget[]> {
    const content = await this.readText(projectRoot, "Cargo.toml");
    const membersLine = content
      ?.match(/\[workspace\]([\s\S]*?)(?:\n\[|\s*$)/)?.[1]
      ?.match(/members\s*=\s*\[([\s\S]*?)\]/)?.[1];
    if (membersLine === undefined) return [];
    const targets: EngineeringTarget[] = [];
    for (const pattern of membersLine
      .split(",")
      .map((item) => item.replace(/["\s]/g, ""))
      .filter(Boolean)) {
      const memberPaths = pattern.includes("*")
        ? await this.#expandMemberGlob(projectRoot, pattern)
        : [path.join(projectRoot, pattern)];
      for (const memberPath of memberPaths) {
        if (!(await this.exists(memberPath, "Cargo.toml"))) continue;
        const info = await this.#parseCargoToml(memberPath);
        targets.push({
          name: info?.name ?? path.basename(memberPath),
          path: memberPath,
          type: info?.isBin === true ? "application" : "library",
          language: "rust",
          metadata: { edition: info?.edition, isWorkspaceMember: true },
        });
      }
    }
    return targets;
  }

  async #expandMemberGlob(projectRoot: string, pattern: string): Promise<readonly string[]> {
    const parent = path.join(projectRoot, pattern.replace("/*", ""));
    return (await this.readDir(parent))
      .filter((entry) => entry.isDirectory && !entry.name.startsWith("."))
      .map((entry) => path.join(parent, entry.name));
  }

  async #discoverExamples(
    projectRoot: string,
    framework: string | null,
  ): Promise<readonly EngineeringTarget[]> {
    const examplesDir = path.join(projectRoot, "examples");
    const entries = await this.readDir(examplesDir);
    if (entries.length === 0) return [];
    const targets: EngineeringTarget[] = entries
      .filter((entry) => entry.isDirectory)
      .map((entry) => ({
        name: `examples/${entry.name}`,
        path: path.join(examplesDir, entry.name),
        type: "example",
        language: "rust",
        framework,
      }));
    if (entries.some((entry) => entry.isFile && entry.name.endsWith(".rs"))) {
      targets.push({ name: "examples", path: examplesDir, type: "example", language: "rust" });
    }
    return targets;
  }

  async #discoverBenches(projectRoot: string): Promise<readonly EngineeringTarget[]> {
    const benchDir = path.join(projectRoot, "benches");
    const hasBench = (await this.readDir(benchDir)).some(
      (entry) => entry.isFile && entry.name.endsWith(".rs"),
    );
    return hasBench
      ? [{ name: "benches", path: benchDir, type: "benchmark", language: "rust" }]
      : [];
  }

  #parseDependencies(
    content: string,
    rootNode: string,
    graph: MutableEngineeringDependencyGraph,
  ): void {
    for (const section of content.matchAll(
      /\[((?:dev-|build-)?dependencies)\]([\s\S]*?)(?=\n\[|$)/g,
    )) {
      const sectionType = section[1] ?? "dependencies";
      for (const rawLine of (section[2] ?? "").split("\n")) {
        const line = rawLine.trim();
        const depName = line.match(/^(\S+)\s*=/)?.[1]?.replace(/"/g, "");
        if (
          depName === undefined ||
          depName.length === 0 ||
          line.startsWith("#") ||
          line.startsWith("[")
        )
          continue;
        graph.nodes.push({
          id: depName,
          label: depName,
          type: "external",
          isDev: sectionType.startsWith("dev-"),
          isBuild: sectionType.startsWith("build-"),
        });
        graph.edges.push({
          from: rootNode,
          to: depName,
          type: sectionType.startsWith("dev-")
            ? "dev-dependency"
            : sectionType.startsWith("build-")
              ? "build-dependency"
              : "dependency",
        });
      }
    }
  }

  async #discoverInternalModules(
    projectRoot: string,
    graph: MutableEngineeringDependencyGraph,
  ): Promise<void> {
    const srcDir = path.join(projectRoot, "src");
    const nodeSet = new Set(graph.nodes.map((node) => (typeof node === "string" ? node : node.id)));
    const walk = async (dir: string, relPath: string, depth: number): Promise<void> => {
      if (depth > 6) return;
      for (const entry of await this.readDir(dir)) {
        if (!entry.isDirectory || entry.name.startsWith(".") || RUST_EXCLUDE.has(entry.name))
          continue;
        const subDir = path.join(dir, entry.name);
        const subRel = relPath ? `${relPath}/${entry.name}` : entry.name;
        if (
          (await this.readDir(subDir)).some(
            (candidate) => candidate.isFile && candidate.name.endsWith(".rs"),
          ) &&
          !nodeSet.has(subRel)
        ) {
          graph.nodes.push({ id: subRel, label: subRel, type: "internal" });
          nodeSet.add(subRel);
        }
        await walk(subDir, subRel, depth + 1);
      }
    };
    await walk(srcDir, "", 0);
  }
}

function detectRustFramework(cargoToml: string): string | null {
  if (/\bactix-web\b/.test(cargoToml)) return "actix-web";
  if (/\baxum\b/.test(cargoToml)) return "axum";
  if (/\brocket\b/.test(cargoToml)) return "rocket";
  if (/\bwarp\b/.test(cargoToml)) return "warp";
  if (/\btokio\b/.test(cargoToml) && /\bhyper\b/.test(cargoToml)) return "hyper";
  if (/\btokio\b/.test(cargoToml)) return "tokio";
  if (/\basync-std\b/.test(cargoToml)) return "async-std";
  if (/\btauri\b/.test(cargoToml)) return "tauri";
  if (/\bbevy\b/.test(cargoToml)) return "bevy";
  if (/\bclap\b/.test(cargoToml)) return "clap-cli";
  if (/\bserde\b/.test(cargoToml)) return "serde";
  return null;
}
