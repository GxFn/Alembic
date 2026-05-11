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
  graphFromParseResults,
  type MutableEngineeringDependencyGraph,
  packageNameFromDependency,
  targetByName,
  targetsFromParseResults,
} from "./helpers.js";
import { parseGradleDiscoveryFile } from "./parsers/index.js";
import { ProjectDiscoverer, type ProjectDiscovererOptions } from "./project.js";

const JVM_EXTENSIONS = new Set([".java", ".kt", ".kts"]);
const CONFIG_FILES = ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts"];

export class JvmDiscoverer extends ProjectDiscoverer {
  readonly id = "jvm";
  #targets: readonly EngineeringTarget[] = [];
  #depGraph: EngineeringDependencyGraph = { nodes: [], edges: [] };
  #buildSystem: "gradle" | "maven" | null = null;

  constructor(options: ProjectDiscovererOptions = {}) {
    super(options);
  }

  get displayName(): string {
    return `JVM (${this.#buildSystem === "maven" ? "Maven" : "Gradle"})`;
  }

  async detect(projectRoot: string): Promise<EngineeringDetection> {
    let confidence = 0;
    const reasons: string[] = [];
    if (
      (await this.exists(projectRoot, "build.gradle")) ||
      (await this.exists(projectRoot, "build.gradle.kts")) ||
      (await this.exists(projectRoot, "settings.gradle")) ||
      (await this.exists(projectRoot, "settings.gradle.kts"))
    ) {
      confidence = 0.9;
      reasons.push("build.gradle(.kts) exists");
    }
    if (
      (await this.exists(projectRoot, "settings.gradle")) ||
      (await this.exists(projectRoot, "settings.gradle.kts"))
    ) {
      confidence = Math.min(Math.max(confidence, 0.85) + 0.05, 1);
      reasons.push("settings.gradle(.kts) exists");
    }
    if (await this.exists(projectRoot, "pom.xml")) {
      confidence = Math.max(confidence, 0.85);
      reasons.push("pom.xml exists");
    }
    return {
      match: confidence > 0,
      confidence,
      reason: reasons.join(", ") || "No JVM markers found",
    };
  }

  async load(projectRoot: string): Promise<void> {
    this.projectRoot = projectRoot;
    const parseResults = [];
    for (const fileName of CONFIG_FILES) {
      const filePath = path.join(projectRoot, fileName);
      const content = await this.readText(filePath);
      if (content !== null) {
        parseResults.push(parseGradleDiscoveryFile({ filePath, content }));
      }
    }

    if (
      (await this.exists(projectRoot, "build.gradle")) ||
      (await this.exists(projectRoot, "build.gradle.kts")) ||
      (await this.exists(projectRoot, "settings.gradle")) ||
      (await this.exists(projectRoot, "settings.gradle.kts"))
    ) {
      this.#buildSystem = "gradle";
      await this.#loadGradle(projectRoot, parseResults);
    } else if (await this.exists(projectRoot, "pom.xml")) {
      this.#buildSystem = "maven";
      await this.#loadMaven(projectRoot);
    } else {
      this.#targets = [];
      this.#depGraph = { nodes: [], edges: [] };
    }
  }

  async listTargets(): Promise<readonly EngineeringTarget[]> {
    return this.#targets;
  }

  async getTargetFiles(target: EngineeringTarget | string): Promise<readonly EngineeringFile[]> {
    const targetObj = targetByName(this.#targets, target, this.projectRoot);
    if (targetObj === null || !(await this.reader.exists(targetObj.path))) {
      return [];
    }
    const sourceDirs = [
      path.join(targetObj.path, "src", "main", "java"),
      path.join(targetObj.path, "src", "main", "kotlin"),
      path.join(targetObj.path, "src", "test", "java"),
      path.join(targetObj.path, "src", "test", "kotlin"),
    ];
    const existing = [];
    for (const dir of sourceDirs) {
      if (await this.reader.exists(dir)) {
        existing.push(dir);
      }
    }
    const roots = existing.length > 0 ? existing : [targetObj.path];
    const files = await Promise.all(
      roots.map((dir) =>
        collectSourceFiles(this.reader, dir, {
          rootDir: targetObj.path,
          extensions: JVM_EXTENSIONS,
        }),
      ),
    );
    return files.flat();
  }

  async getDependencyGraph(): Promise<EngineeringDependencyGraph> {
    return this.#depGraph;
  }

  async #loadGradle(
    projectRoot: string,
    parseResults: readonly ReturnType<typeof parseGradleDiscoveryFile>[],
  ): Promise<void> {
    const targets: EngineeringTarget[] = [];
    const modules = await this.#parseGradleSettings(projectRoot);
    if (modules.length > 0) {
      for (const moduleName of modules) {
        const modulePath = path.resolve(projectRoot, moduleName.replace(/:/g, "/"));
        if (!(await this.reader.exists(modulePath))) {
          continue;
        }
        targets.push({
          name: moduleName,
          path: modulePath,
          type: await this.#inferGradleTargetType(modulePath, moduleName),
          language: await this.#detectPrimaryLang(modulePath),
          framework: await this.#detectGradleFramework(modulePath),
          metadata: { buildSystem: "gradle", module: moduleName },
        });
      }
    } else {
      targets.push({
        name: path.basename(projectRoot),
        path: projectRoot,
        type: "app",
        language: await this.#detectPrimaryLang(projectRoot),
        framework: await this.#detectGradleFramework(projectRoot),
        metadata: { buildSystem: "gradle" },
      });
    }

    const parsedGraph = graphFromParseResults(parseResults);
    const graph: MutableEngineeringDependencyGraph = {
      nodes: [...parsedGraph.nodes],
      edges: [...parsedGraph.edges],
      ...(parsedGraph.layers === undefined ? {} : { layers: parsedGraph.layers }),
    };
    for (const target of targets) {
      graph.nodes.push(target.name);
    }
    graph.edges.push(
      ...(await this.#parseGradleModuleDeps(
        projectRoot,
        targets.map((target) => target.name),
      )),
    );
    graph.edges.push(...(await this.#parseGradleExternalDeps(projectRoot, targets[0]?.name)));
    this.#targets = dedupeTargets([
      ...targets,
      ...targetsFromParseResults(parseResults, projectRoot),
    ]);
    this.#depGraph = dedupeGraph(graph);
  }

  async #loadMaven(projectRoot: string): Promise<void> {
    const content = await this.readText(projectRoot, "pom.xml");
    if (content === null) {
      this.#targets = [];
      this.#depGraph = { nodes: [], edges: [] };
      return;
    }
    const modules = [...content.matchAll(/<module>([^<]+)<\/module>/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1].trim()],
    );
    const targets: EngineeringTarget[] = [];
    if (modules.length > 0) {
      for (const moduleName of modules) {
        const modulePath = path.resolve(projectRoot, moduleName);
        targets.push({
          name: moduleName,
          path: modulePath,
          type: /test/i.test(moduleName) ? "test" : "library",
          language: await this.#detectPrimaryLang(modulePath),
          framework: await this.#detectMavenFramework(modulePath),
          metadata: { buildSystem: "maven", module: moduleName },
        });
      }
    } else {
      const projectName = xmlValue(content, "artifactId") ?? path.basename(projectRoot);
      targets.push({
        name: projectName,
        path: projectRoot,
        type: "app",
        language: await this.#detectPrimaryLang(projectRoot),
        framework: await this.#detectMavenFramework(projectRoot),
        metadata: { buildSystem: "maven" },
      });
    }
    const rootName = targets[0]?.name ?? path.basename(projectRoot);
    const edges: MutableEngineeringDependencyGraph["edges"] = [
      ...content.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g),
    ].flatMap((block) => {
      const groupId = xmlValue(block[1] ?? "", "groupId");
      const artifactId = xmlValue(block[1] ?? "", "artifactId");
      return groupId === null || artifactId === null
        ? []
        : [{ from: rootName, to: `${groupId}:${artifactId}`, type: "depends_on" }];
    });
    this.#targets = dedupeTargets(targets);
    this.#depGraph = dedupeGraph({ nodes: targets.map((target) => target.name), edges });
  }

  async #parseGradleSettings(projectRoot: string): Promise<readonly string[]> {
    const modules = new Set<string>();
    for (const fileName of ["settings.gradle", "settings.gradle.kts"]) {
      const content = await this.readText(projectRoot, fileName);
      if (content === null) {
        continue;
      }
      for (const match of content.matchAll(
        /include\s*(?:\(([\s\S]*?)\)|((?:\s*["'][^"']+["']\s*,?)+))/g,
      )) {
        const values = match[1] ?? match[2] ?? "";
        for (const quoted of values.matchAll(/["']([^"']+)["']/g)) {
          if (quoted[1] !== undefined) modules.add(quoted[1].replace(/^:/, ""));
        }
      }
    }
    return [...modules].sort();
  }

  async #detectGradleFramework(dir: string): Promise<string | null> {
    const content =
      (await this.readText(dir, "build.gradle")) ??
      (await this.readText(dir, "build.gradle.kts")) ??
      "";
    if (/com\.android|android\s*\{|apply.*android/.test(content)) return "android";
    if (/org\.springframework|spring-boot/.test(content)) return "spring";
    if (/io\.ktor/.test(content)) return "ktor";
    if (/org\.jetbrains\.compose/.test(content)) return "compose";
    return null;
  }

  async #detectMavenFramework(dir: string): Promise<string | null> {
    const content = await this.readText(dir, "pom.xml");
    if (content === null) return null;
    if (/spring-boot|springframework/.test(content)) return "spring";
    if (/android/.test(content)) return "android";
    return null;
  }

  async #inferGradleTargetType(dir: string, name: string): Promise<string> {
    const content =
      (await this.readText(dir, "build.gradle")) ??
      (await this.readText(dir, "build.gradle.kts")) ??
      "";
    if (/application|com\.android\.application/.test(content)) return "app";
    if (/java-library|com\.android\.library/.test(content)) return "library";
    if (/test/i.test(name)) return "test";
    return "library";
  }

  async #parseGradleModuleDeps(
    projectRoot: string,
    submodules: readonly string[],
  ): Promise<MutableEngineeringDependencyGraph["edges"]> {
    const moduleSet = new Set(submodules);
    const edges: MutableEngineeringDependencyGraph["edges"] = [];
    for (const moduleName of submodules) {
      const modulePath = path.resolve(projectRoot, moduleName.replace(/:/g, "/"));
      const content =
        (await this.readText(modulePath, "build.gradle")) ??
        (await this.readText(modulePath, "build.gradle.kts")) ??
        "";
      for (const match of content.matchAll(/project\s*\(\s*['"][:.]?([^'"]+)['"]\s*\)/g)) {
        const dep = match[1]?.replace(/^:/, "");
        if (dep !== undefined && moduleSet.has(dep)) {
          edges.push({ from: moduleName, to: dep, type: "depends_on" });
        }
      }
    }
    return edges;
  }

  async #parseGradleExternalDeps(
    projectRoot: string,
    rootTarget: string | undefined,
  ): Promise<MutableEngineeringDependencyGraph["edges"]> {
    if (rootTarget === undefined) {
      return [];
    }
    const content =
      (await this.readText(projectRoot, "build.gradle")) ??
      (await this.readText(projectRoot, "build.gradle.kts")) ??
      "";
    return [
      ...content.matchAll(
        /(?:implementation|api|compileOnly|runtimeOnly)\s*[("']+([^)'"]+)[)'"]+/g,
      ),
    ].flatMap((match) =>
      match[1] === undefined
        ? []
        : [{ from: rootTarget, to: packageNameFromDependency(match[1]), type: "depends_on" }],
    );
  }

  async #detectPrimaryLang(dir: string): Promise<string> {
    let javaCount = 0;
    let kotlinCount = 0;
    if (await this.reader.exists(path.join(dir, "src", "main", "kotlin"))) kotlinCount += 10;
    if (await this.reader.exists(path.join(dir, "src", "main", "java"))) javaCount += 10;
    for (const sampleDir of [
      path.join(dir, "src", "main", "java"),
      path.join(dir, "src", "main", "kotlin"),
      dir,
    ]) {
      for (const entry of (await this.readDir(sampleDir)).slice(0, 20)) {
        if (entry.name.endsWith(".kt") || entry.name.endsWith(".kts")) kotlinCount += 1;
        if (entry.name.endsWith(".java")) javaCount += 1;
      }
    }
    return kotlinCount > javaCount ? "kotlin" : "java";
  }
}

function xmlValue(xml: string, tag: string): string | null {
  return xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1]?.trim() ?? null;
}
