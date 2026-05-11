import path from "node:path";
import yaml from "js-yaml";
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
  recordValue,
  targetByName,
} from "./DiscoveryHelpers.js";
import { ProjectDiscoverer, type ProjectDiscovererOptions } from "./ProjectDiscoverer.js";
import { parseYamlDiscoveryFile } from "./parsers/index.js";

const DART_EXTENSIONS = new Set([".dart"]);
const DART_EXCLUDE = new Set([
  ".git",
  ".dart_tool",
  ".fvm",
  "build",
  "node_modules",
  ".idea",
  ".vscode",
  "ios",
  "android",
  "macos",
  "windows",
  "linux",
  "web",
  ".pub-cache",
  ".pub",
  ".cursor",
]);

export class DartDiscoverer extends ProjectDiscoverer {
  readonly id = "dart";
  readonly displayName = "Dart / Flutter";
  #targets: readonly EngineeringTarget[] = [];
  #depGraph: EngineeringDependencyGraph = { nodes: [], edges: [] };
  #packageName: string | null = null;

  constructor(options: ProjectDiscovererOptions = {}) {
    super(options);
  }

  async detect(projectRoot: string): Promise<EngineeringDetection> {
    let confidence = 0;
    const reasons: string[] = [];
    if (await this.exists(projectRoot, "pubspec.yaml")) {
      confidence = 0.92;
      reasons.push("pubspec.yaml exists");
    }
    if (await this.exists(projectRoot, "pubspec.lock")) {
      confidence = Math.max(confidence, 0.7);
      if (confidence < 0.92) confidence += 0.1;
      reasons.push("pubspec.lock exists");
    }
    if (await this.exists(projectRoot, ".dart_tool")) {
      confidence = Math.max(confidence, 0.6);
      reasons.push(".dart_tool exists");
    }
    if (await this.exists(projectRoot, "melos.yaml")) {
      confidence = Math.max(confidence, 0.95);
      reasons.push("melos.yaml exists (workspace)");
    }
    if (
      confidence === 0 &&
      (await this.readDir(projectRoot)).some(
        (entry) => entry.isFile && entry.name.endsWith(".dart"),
      )
    ) {
      confidence = 0.5;
      reasons.push("*.dart files found at root");
    }
    return {
      match: confidence > 0,
      confidence,
      reason: reasons.join(", ") || "No Dart markers found",
    };
  }

  async load(projectRoot: string): Promise<void> {
    this.projectRoot = projectRoot;
    const pubspecContent = await this.readText(projectRoot, "pubspec.yaml");
    const pubspec = parseYamlRecord(pubspecContent);
    this.#packageName = stringValue(pubspec.name) ?? path.basename(projectRoot);
    const framework = detectDartFramework(pubspec);
    const targets: EngineeringTarget[] = [
      {
        name: this.#packageName,
        path: path.join(projectRoot, "lib"),
        type: "library",
        language: "dart",
        framework,
        metadata: {
          packageName: this.#packageName,
          isFlutter: framework?.startsWith("flutter") ?? false,
        },
      },
    ];
    for (const [dirName, type] of [
      ["bin", "application"],
      ["test", "test"],
      ["test_driver", "test"],
      ["integration_test", "test"],
      ["example", "example"],
    ] as const) {
      const dir = path.join(projectRoot, dirName);
      if (await this.reader.exists(dir))
        targets.push({ name: dirName, path: dir, type, language: "dart", framework });
    }
    await this.#discoverMelosPackages(projectRoot, targets);

    const graph: MutableEngineeringDependencyGraph = {
      nodes: targets.map((target) => target.name),
      edges: [],
    };
    if (pubspecContent !== null) {
      const parsed = parseYamlDiscoveryFile({
        filePath: path.join(projectRoot, "pubspec.yaml"),
        content: pubspecContent,
      });
      graph.nodes.push(
        ...parsed.packages.map((pkg) => ({ id: pkg.name, label: pkg.name, type: "external" })),
      );
    }
    this.#parseDependencies(pubspec, graph);
    await this.#parseInternalImports(projectRoot, graph);
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
      extensions: DART_EXTENSIONS,
      language: "dart",
      excludeDirs: DART_EXCLUDE,
    });
  }

  async getDependencyGraph(): Promise<EngineeringDependencyGraph> {
    return this.#depGraph;
  }

  async #discoverMelosPackages(projectRoot: string, targets: EngineeringTarget[]): Promise<void> {
    if (!(await this.exists(projectRoot, "melos.yaml"))) return;
    for (const base of ["packages", "apps"]) {
      const baseDir = path.join(projectRoot, base);
      for (const entry of await this.readDir(baseDir)) {
        if (!entry.isDirectory || entry.name.startsWith(".")) continue;
        const pkgDir = path.join(baseDir, entry.name);
        if (!(await this.exists(pkgDir, "pubspec.yaml"))) continue;
        const pubspec = parseYamlRecord(await this.readText(pkgDir, "pubspec.yaml"));
        const packageName = stringValue(pubspec.name) ?? entry.name;
        targets.push({
          name: `${base}/${packageName}`,
          path: path.join(pkgDir, "lib"),
          type: base === "apps" ? "application" : "library",
          language: "dart",
          metadata: { isMelosPackage: true, packageName },
        });
      }
    }
  }

  #parseDependencies(
    pubspec: Record<string, unknown>,
    graph: MutableEngineeringDependencyGraph,
  ): void {
    if (this.#packageName === null) return;
    for (const [section, type] of [
      ["dependencies", "dependency"],
      ["dev_dependencies", "dev-dependency"],
    ] as const) {
      for (const depName of Object.keys(recordValue(pubspec[section]) ?? {})) {
        if (
          [
            "flutter",
            "flutter_test",
            "flutter_lints",
            "flutter_driver",
            "flutter_localizations",
          ].includes(depName)
        )
          continue;
        graph.nodes.push({
          id: depName,
          label: depName,
          type: "external",
          isDev: section === "dev_dependencies",
        });
        graph.edges.push({ from: this.#packageName, to: depName, type });
      }
    }
  }

  async #parseInternalImports(
    projectRoot: string,
    graph: MutableEngineeringDependencyGraph,
  ): Promise<void> {
    const packageName = this.#packageName;
    if (packageName === null) return;
    const libDir = path.join(projectRoot, "lib");
    if (!(await this.reader.exists(libDir))) return;
    const nodeSet = new Set(graph.nodes.map((node) => (typeof node === "string" ? node : node.id)));
    for (const entry of await this.readDir(libDir)) {
      if (entry.isDirectory && !entry.name.startsWith(".") && !entry.name.startsWith("_")) {
        const moduleId = `lib/${entry.name}`;
        graph.nodes.push({ id: moduleId, label: entry.name, type: "internal" });
        nodeSet.add(moduleId);
      }
    }
    const edgeSet = new Set<string>();
    const scan = async (dir: string): Promise<void> => {
      for (const entry of await this.readDir(dir)) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory && !DART_EXCLUDE.has(entry.name)) {
          await scan(fullPath);
        } else if (entry.isFile && entry.name.endsWith(".dart")) {
          const relDir = path.relative(libDir, dir);
          const fromModule = relDir ? `lib/${relDir.split(path.sep)[0]}` : packageName;
          const content = await this.readText(fullPath);
          for (const match of (content ?? "").matchAll(
            /import\s+['"]package:(\w+)\/([^'"]+)['"]/g,
          )) {
            const pkg = match[1];
            const filePath = match[2];
            if (pkg === packageName && filePath !== undefined) {
              const target = `lib/${filePath.split("/")[0]}`;
              if (
                target !== fromModule &&
                nodeSet.has(target) &&
                !edgeSet.has(`${fromModule}->${target}`)
              ) {
                edgeSet.add(`${fromModule}->${target}`);
                graph.edges.push({ from: fromModule, to: target, type: "internal" });
              }
            }
          }
        }
      }
    };
    await scan(libDir);
  }
}

function parseYamlRecord(content: string | null): Record<string, unknown> {
  if (content === null) return {};
  try {
    const parsed = yaml.load(content, { schema: yaml.CORE_SCHEMA });
    return recordValue(parsed) ?? {};
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function detectDartFramework(pubspec: Record<string, unknown>): string | null {
  const deps = {
    ...(recordValue(pubspec.dependencies) ?? {}),
    ...(recordValue(pubspec.dev_dependencies) ?? {}),
  };
  if (deps.flutter || deps.flutter_test) {
    if (deps.flutter_riverpod || deps.hooks_riverpod || deps.riverpod) return "flutter-riverpod";
    if (deps.flutter_bloc || deps.bloc) return "flutter-bloc";
    if (deps.get || deps.getx) return "flutter-getx";
    if (deps.provider) return "flutter-provider";
    return "flutter";
  }
  if (deps.shelf || deps.shelf_router) return "shelf";
  if (deps.dart_frog) return "dart-frog";
  if (deps.serverpod) return "serverpod";
  if (deps.args || deps.cli_util) return "dart-cli";
  return null;
}
