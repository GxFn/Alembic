import path from "node:path";
import type {
  EngineeringDependencyEdge,
  EngineeringDependencyGraph,
  EngineeringDependencyNode,
  EngineeringDetection,
  EngineeringFile,
  EngineeringTarget,
} from "../foundation/EngineeringCoreTypes.js";
import { EngineeringLanguageService } from "../language/EngineeringLanguageService.js";
import {
  type CustomConfigProfile,
  type CustomConfigProfileMatch,
  CustomConfigProfileRegistry,
} from "./CustomConfigProfiles.js";
import {
  COMMON_EXCLUDE_DIRS,
  collectSourceFiles,
  dedupeGraph,
  dedupeTargets,
  globBase,
} from "./DiscoveryHelpers.js";
import { ProjectDiscoverer, type ProjectDiscovererOptions } from "./ProjectDiscoverer.js";
import {
  type EngineeringDiscoveryDependency,
  type EngineeringDiscoveryEntity,
  type EngineeringDiscoveryParseResult,
  parseCMakeDiscoveryFile,
  parseGradleDiscoveryFile,
  parseJsonDiscoveryFile,
  parseRubyDiscoveryFile,
  parseStarlarkDiscoveryFile,
  parseYamlDiscoveryFile,
} from "./parsers/index.js";

const CONFIG_SCAN_EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  ...COMMON_EXCLUDE_DIRS,
  ".easybox",
  ".gradle",
  ".nx",
  "DerivedData",
  "Pods",
]);

const SOURCE_GLOB_CHARS = /[*{[]/;

export interface CustomConfigDiscovererOptions extends ProjectDiscovererOptions {
  readonly profileRegistry?: CustomConfigProfileRegistry;
}

interface LoadedParseResult {
  readonly profileId: string;
  readonly result: EngineeringDiscoveryParseResult;
}

export class CustomConfigDiscoverer extends ProjectDiscoverer {
  readonly id = "customConfig";

  readonly #profileRegistry: CustomConfigProfileRegistry;
  #activeProfiles: readonly CustomConfigProfileMatch[] = [];
  #parseResults: LoadedParseResult[] = [];
  #targets: readonly EngineeringTarget[] = [];

  constructor(options: CustomConfigDiscovererOptions = {}) {
    super(options);
    this.#profileRegistry = options.profileRegistry ?? new CustomConfigProfileRegistry();
  }

  get displayName(): string {
    const first = this.#activeProfiles[0]?.profile.displayName;
    return first === undefined ? "Custom Config" : `Custom Config (${first})`;
  }

  async detect(projectRoot: string): Promise<EngineeringDetection> {
    const matches = await this.#profileRegistry.detectAll(projectRoot, this.reader);
    const first = matches[0];
    if (first !== undefined) {
      return { match: true, confidence: first.confidence, reason: first.reason };
    }

    const heuristic = await this.#detectHeuristic(projectRoot);
    if (heuristic.match) {
      return heuristic;
    }
    return { match: false, confidence: 0, reason: "No custom config detected" };
  }

  async load(projectRoot: string): Promise<void> {
    this.projectRoot = projectRoot;
    this.#activeProfiles = await this.#profileRegistry.detectAll(projectRoot, this.reader);
    this.#parseResults = [];
    this.#targets = [];

    for (const match of this.#activeProfiles) {
      const results = await this.#loadProfile(projectRoot, match.profile);
      this.#parseResults.push(
        ...results.map((result) => ({ profileId: match.profile.id, result })),
      );
    }

    if (this.#parseResults.length === 0) {
      this.#targets = await this.#loadHeuristicTargets(projectRoot);
      return;
    }

    this.#targets = this.#targetsFromParseResults(projectRoot, this.#parseResults);
  }

  async listTargets(): Promise<readonly EngineeringTarget[]> {
    return this.#targets;
  }

  async getTargetFiles(target: EngineeringTarget | string): Promise<readonly EngineeringFile[]> {
    const resolvedTarget =
      typeof target === "string"
        ? this.#targets.find((candidate) => candidate.name === target)
        : target;
    if (resolvedTarget === undefined) {
      return [];
    }

    const sourceRoots = await this.#sourceRootsForTarget(resolvedTarget);
    const files: EngineeringFile[] = [];
    for (const sourceRoot of sourceRoots) {
      const collected = await collectSourceFiles(this.reader, sourceRoot, {
        rootDir: resolvedTarget.path,
        excludeDirs: CONFIG_SCAN_EXCLUDE_DIRS,
        ...(resolvedTarget.language === undefined ? {} : { language: resolvedTarget.language }),
      });
      files.push(
        ...collected.map((file) => ({
          ...file,
          targetName: resolvedTarget.name,
        })),
      );
    }
    const byPath = new Map(files.map((file) => [file.path, file]));
    return [...byPath.values()].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
  }

  async getDependencyGraph(): Promise<EngineeringDependencyGraph> {
    const nodes = new Map<string, EngineeringDependencyNode>();
    const edges: EngineeringDependencyEdge[] = [];
    const layers = new Map<string, NonNullable<EngineeringDependencyGraph["layers"]>[number]>();

    for (const loaded of this.#parseResults) {
      for (const layer of loaded.result.layers) {
        layers.set(layer.name, {
          name: layer.name,
          order: layer.order,
          accessibleLayers: layer.accessibleLayers,
        });
      }
      for (const entity of [
        ...loaded.result.projects,
        ...loaded.result.targets,
        ...loaded.result.modules,
        ...loaded.result.packages,
      ]) {
        nodes.set(entity.id, this.#nodeFromEntity(entity, loaded.profileId));
      }
      for (const dependency of loaded.result.dependencies) {
        edges.push(edgeFromDependency(dependency));
      }
    }

    for (const target of this.#targets) {
      const id = stringMetadata(target, "id") ?? target.name;
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          label: target.name,
          type: target.type,
          fullPath: target.path,
          ...(target.metadata ?? {}),
        });
      }
    }

    return dedupeGraph({
      nodes: [...nodes.values()],
      edges,
      ...(layers.size === 0 ? {} : { layers: [...layers.values()] }),
    });
  }

  async #loadProfile(
    projectRoot: string,
    profile: CustomConfigProfile,
  ): Promise<readonly EngineeringDiscoveryParseResult[]> {
    switch (profile.parser) {
      case "ruby-dsl":
        return this.#loadRubyDsl(projectRoot, profile);
      case "yaml":
        return this.#loadYaml(projectRoot, profile);
      case "starlark":
        return this.#loadStarlark(projectRoot, profile);
      case "gradle-dsl":
        return this.#loadGradle(projectRoot);
      case "cmake":
        return this.#loadCMake(projectRoot);
      case "json-config":
        return this.#loadJsonConfig(projectRoot, profile);
      case "swift-dsl":
        return this.#loadSwiftDsl(projectRoot, profile);
    }
  }

  async #loadRubyDsl(
    projectRoot: string,
    profile: CustomConfigProfile,
  ): Promise<readonly EngineeringDiscoveryParseResult[]> {
    const results: EngineeringDiscoveryParseResult[] = [];
    for (const fileName of profile.id === "easybox"
      ? ["Boxfile", "Boxfile.local", "Boxfile.overlay"]
      : profile.markers) {
      const filePath = path.join(projectRoot, fileName);
      const content = await this.readText(filePath);
      if (content !== null) {
        results.push(parseRubyDiscoveryFile({ filePath: fileName, content }));
      }
    }

    const moduleEntities = mergeEntities(results.flatMap((result) => result.modules));
    const specFiles = new Set<string>();
    for (const entity of moduleEntities) {
      if (entity.local !== true || entity.path === undefined) {
        continue;
      }
      const specFile = await this.#findRubySpecFile(
        path.join(projectRoot, entity.path),
        entity.name,
      );
      if (specFile !== null) {
        specFiles.add(specFile);
      }
    }
    if (profile.moduleSpecPattern !== null) {
      for (const specFile of await this.#findFiles(projectRoot, [".boxspec", ".podspec"], 8)) {
        specFiles.add(specFile);
      }
    }

    for (const specFile of [...specFiles].sort()) {
      const content = await this.readText(specFile);
      if (content !== null) {
        results.push(
          parseRubyDiscoveryFile({
            filePath: path.relative(projectRoot, specFile),
            content,
          }),
        );
      }
    }
    return results;
  }

  async #loadYaml(
    projectRoot: string,
    profile: CustomConfigProfile,
  ): Promise<readonly EngineeringDiscoveryParseResult[]> {
    if (profile.id === "xcodegen") {
      return this.#loadXcodeGen(projectRoot, profile);
    }

    const results: EngineeringDiscoveryParseResult[] = [];
    for (const marker of profile.markers) {
      const filePath = path.join(projectRoot, marker);
      const content = await this.readText(filePath);
      if (content !== null) {
        results.push(parseYamlDiscoveryFile({ filePath: marker, content }));
      }
    }

    if (profile.id === "melos") {
      for (const pubspec of await this.#findNamedFiles(projectRoot, "pubspec.yaml", 6)) {
        if (pubspec === path.join(projectRoot, "pubspec.yaml")) {
          continue;
        }
        const content = await this.readText(pubspec);
        if (content !== null) {
          results.push(
            parseYamlDiscoveryFile({
              filePath: path.relative(projectRoot, pubspec),
              content,
            }),
          );
        }
      }
    }
    return results;
  }

  async #loadXcodeGen(
    projectRoot: string,
    profile: CustomConfigProfile,
  ): Promise<readonly EngineeringDiscoveryParseResult[]> {
    const roots = profile.markers.map((marker) => path.join(projectRoot, marker));
    const queue = [...roots];
    const seen = new Set<string>();
    const results: EngineeringDiscoveryParseResult[] = [];

    while (queue.length > 0) {
      const filePath = queue.shift();
      if (filePath === undefined || seen.has(filePath)) {
        continue;
      }
      seen.add(filePath);
      const content = await this.readText(filePath);
      if (content === null) {
        continue;
      }
      const relativePath = path.relative(projectRoot, filePath);
      const parsed = parseYamlDiscoveryFile({ filePath: relativePath, content });
      results.push(parsed);
      for (const includePath of parsed.dependencies
        .filter((dependency) => dependency.kind === "includes")
        .map((dependency) => dependency.to)) {
        queue.push(path.resolve(path.dirname(filePath), includePath));
      }
    }
    return results;
  }

  async #loadStarlark(
    projectRoot: string,
    profile: CustomConfigProfile,
  ): Promise<readonly EngineeringDiscoveryParseResult[]> {
    const names =
      profile.moduleSpecPattern === "BUCK"
        ? ["BUCK"]
        : profile.id === "pants"
          ? ["BUILD"]
          : ["BUILD.bazel", "BUILD"];
    const files = [
      ...profile.markers.map((marker) => path.join(projectRoot, marker)),
      ...(await this.#findNamedFiles(projectRoot, names, 8)),
    ];
    return this.#parseFiles(projectRoot, files, parseStarlarkDiscoveryFile);
  }

  async #loadGradle(projectRoot: string): Promise<readonly EngineeringDiscoveryParseResult[]> {
    const files = [
      path.join(projectRoot, "settings.gradle"),
      path.join(projectRoot, "settings.gradle.kts"),
      path.join(projectRoot, "gradle/libs.versions.toml"),
      ...(await this.#findNamedFiles(projectRoot, ["build.gradle", "build.gradle.kts"], 8)),
    ];
    return this.#parseFiles(projectRoot, files, parseGradleDiscoveryFile);
  }

  async #loadCMake(projectRoot: string): Promise<readonly EngineeringDiscoveryParseResult[]> {
    const files = await this.#findNamedFiles(projectRoot, "CMakeLists.txt", 8);
    return this.#parseFiles(projectRoot, files, parseCMakeDiscoveryFile);
  }

  async #loadJsonConfig(
    projectRoot: string,
    profile: CustomConfigProfile,
  ): Promise<readonly EngineeringDiscoveryParseResult[]> {
    const files: string[] = [];
    if (profile.id === "nx-monorepo") {
      files.push(path.join(projectRoot, "nx.json"));
      files.push(...(await this.#findNamedFiles(projectRoot, "project.json", 8)));
    } else if (profile.id === "flutter-add-to-app") {
      files.push(path.join(projectRoot, ".flutter-plugins-dependencies"));
      files.push(...(await this.#findNamedFiles(projectRoot, "pubspec.yaml", 6)));
    } else {
      files.push(...profile.markers.map((marker) => path.join(projectRoot, marker)));
    }
    return this.#parseFiles(projectRoot, files, parseJsonDiscoveryFile);
  }

  async #loadSwiftDsl(
    projectRoot: string,
    profile: CustomConfigProfile,
  ): Promise<readonly EngineeringDiscoveryParseResult[]> {
    const targets: EngineeringTarget[] = [];
    for (const marker of profile.markers) {
      const filePath = path.join(projectRoot, marker);
      if (!(await this.exists(filePath))) {
        continue;
      }
      const targetPath = marker === "Project.swift" ? projectRoot : path.dirname(filePath);
      targets.push({
        name: path.basename(targetPath),
        path: targetPath,
        type: "swift-dsl",
        language: "swift",
        metadata: {
          profileId: profile.id,
          sourceFile: marker,
          conventionRole: "project",
        },
      });
    }
    this.#targets = dedupeTargets([...this.#targets, ...targets]);
    return [];
  }

  async #parseFiles(
    projectRoot: string,
    files: readonly string[],
    parser: (input: {
      readonly filePath: string;
      readonly content: string;
    }) => EngineeringDiscoveryParseResult,
  ): Promise<readonly EngineeringDiscoveryParseResult[]> {
    const results: EngineeringDiscoveryParseResult[] = [];
    const seen = new Set<string>();
    for (const filePath of files) {
      if (seen.has(filePath)) {
        continue;
      }
      seen.add(filePath);
      const content = await this.readText(filePath);
      if (content === null) {
        continue;
      }
      results.push(parser({ filePath: path.relative(projectRoot, filePath), content }));
    }
    return results;
  }

  #targetsFromParseResults(
    projectRoot: string,
    loadedResults: readonly LoadedParseResult[],
  ): readonly EngineeringTarget[] {
    const targets = new Map<string, EngineeringTarget>();
    for (const loaded of loadedResults) {
      for (const entity of [...loaded.result.targets, ...loaded.result.modules]) {
        if (entity.kind === "module" && entity.type?.endsWith("-glob")) {
          continue;
        }
        const target = this.#targetFromEntity(projectRoot, entity, loaded);
        if (target === null) {
          continue;
        }
        const existing = targets.get(target.name);
        if (existing === undefined || shouldReplaceTarget(existing, target)) {
          targets.set(target.name, target);
        }
      }
    }
    return dedupeTargets([...targets.values()]);
  }

  #targetFromEntity(
    projectRoot: string,
    entity: EngineeringDiscoveryEntity,
    loaded: LoadedParseResult,
  ): EngineeringTarget | null {
    const relativePath = preferredEntityPath(entity);
    const sourceFile = entity.source?.filePath;
    const fallbackPath =
      sourceFile === undefined
        ? "."
        : path.dirname(sourceFile) === "."
          ? "."
          : path.dirname(sourceFile);
    const targetPath = path.resolve(projectRoot, relativePath ?? fallbackPath);
    const local = entity.local ?? (entity.kind !== "package" && entity.kind !== "resource");
    if (!local || SOURCE_GLOB_CHARS.test(targetPath)) {
      return null;
    }
    return {
      name: entity.name,
      path: targetPath,
      type: normalizeTargetType(entity),
      language: entity.language ?? languageForProfile(loaded.profileId) ?? "unknown",
      framework: loaded.profileId,
      metadata: {
        profileId: loaded.profileId,
        id: entity.id,
        parser: loaded.result.parser,
        confidence: entity.confidence,
        sourceFile,
        ...(entity.layer === undefined ? {} : { layer: entity.layer }),
        ...(entity.group === undefined ? {} : { group: entity.group }),
        ...(entity.version === undefined ? {} : { version: entity.version }),
        ...(entity.metadata ?? {}),
        ...(conventionRole(entity) === undefined ? {} : { conventionRole: conventionRole(entity) }),
      },
    };
  }

  #nodeFromEntity(
    entity: EngineeringDiscoveryEntity,
    profileId: string,
  ): EngineeringDependencyNode {
    const metadata = entity.metadata ?? {};
    const tags = asStringArray(metadata.tags);
    const visibility = asStringArray(metadata.visibility);
    const role = conventionRole(entity);
    return {
      id: entity.id,
      label: entity.name,
      type: entity.type ?? entity.kind,
      ...(entity.path === undefined ? {} : { fullPath: entity.path }),
      ...(entity.version === undefined ? {} : { version: entity.version }),
      ...(entity.type === undefined ? {} : { targetType: entity.type }),
      ...(entity.layer === undefined ? {} : { layer: entity.layer }),
      ...(entity.group === undefined ? {} : { group: entity.group }),
      ...(tags.length === 0 ? {} : { tags }),
      ...(visibility.length === 0 ? {} : { visibility }),
      ...(role === undefined ? {} : { conventionRole: role }),
      profileId,
      ...metadata,
    };
  }

  async #sourceRootsForTarget(target: EngineeringTarget): Promise<readonly string[]> {
    const roots = new Set<string>();
    const sourceValues = asStringArray(target.metadata?.sources);
    for (const sourceValue of sourceValues) {
      const base = globBase(sourceValue);
      const sourceRoot = path.resolve(target.path, base);
      if ((await this.stat(sourceRoot))?.isDirectory === true) {
        roots.add(sourceRoot);
      }
    }
    if (roots.size === 0) {
      roots.add(target.path);
    }
    return [...roots];
  }

  async #findRubySpecFile(modulePath: string, moduleName: string): Promise<string | null> {
    for (const ext of [".boxspec", ".podspec"]) {
      const exactPath = path.join(modulePath, `${moduleName}${ext}`);
      if ((await this.stat(exactPath))?.isFile === true) {
        return exactPath;
      }
    }
    const entries = await this.readDir(modulePath);
    const spec = entries.find(
      (entry) => entry.isFile && /\.(?:boxspec|podspec)$/i.test(entry.name),
    );
    return spec === undefined ? null : path.join(modulePath, spec.name);
  }

  async #findNamedFiles(
    dir: string,
    names: string | readonly string[],
    maxDepth: number,
  ): Promise<readonly string[]> {
    const wanted = new Set(typeof names === "string" ? [names] : names);
    const results: string[] = [];
    await this.#walkFiles(dir, maxDepth, (filePath, fileName) => {
      if (wanted.has(fileName)) {
        results.push(filePath);
      }
    });
    return results.sort();
  }

  async #findFiles(
    dir: string,
    extensions: readonly string[],
    maxDepth: number,
  ): Promise<readonly string[]> {
    const results: string[] = [];
    await this.#walkFiles(dir, maxDepth, (matchedPath) => {
      if (extensions.some((extension) => matchedPath.endsWith(extension))) {
        results.push(matchedPath);
      }
    });
    return results.sort();
  }

  async #walkFiles(
    dir: string,
    maxDepth: number,
    visit: (filePath: string, fileName: string) => void,
    depth = 0,
  ): Promise<void> {
    if (depth > maxDepth) {
      return;
    }
    const entries = await this.readDir(dir);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || CONFIG_SCAN_EXCLUDE_DIRS.has(entry.name)) {
        continue;
      }
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory) {
        await this.#walkFiles(filePath, maxDepth, visit, depth + 1);
      } else if (entry.isFile) {
        visit(filePath, entry.name);
      }
    }
  }

  async #detectHeuristic(projectRoot: string): Promise<EngineeringDetection> {
    const entries = await this.readDir(projectRoot);
    let score = 0.35;
    const signals: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (/^(Local)?Modules?$|^Packages$/i.test(entry.name) && entry.isDirectory) {
        const subdirs = (await this.readDir(path.join(projectRoot, entry.name))).filter(
          (candidate) => candidate.isDirectory,
        ).length;
        if (subdirs >= 2) {
          score += 0.15;
          signals.push(entry.name);
        }
      } else if (/^[A-Z]\w+file$/.test(entry.name) && entry.isFile) {
        score += 0.2;
        signals.push(entry.name);
      } else if (/\.\w+spec$/.test(entry.name)) {
        score += 0.2;
        signals.push(entry.name);
      }
    }
    score = Math.min(score, 0.65);
    return score >= 0.5 && signals.length >= 2
      ? { match: true, confidence: score, reason: `Heuristic signals: ${signals.join(", ")}` }
      : { match: false, confidence: 0, reason: "No custom config detected" };
  }

  async #loadHeuristicTargets(projectRoot: string): Promise<readonly EngineeringTarget[]> {
    const targets: EngineeringTarget[] = [];
    const entries = await this.readDir(projectRoot);
    for (const entry of entries) {
      if (
        !entry.isDirectory ||
        entry.name.startsWith(".") ||
        CONFIG_SCAN_EXCLUDE_DIRS.has(entry.name)
      ) {
        continue;
      }
      const targetPath = path.join(projectRoot, entry.name);
      const files = await collectSourceFiles(this.reader, targetPath, { maxDepth: 3 });
      if (files.length > 0) {
        targets.push({
          name: entry.name,
          path: targetPath,
          type: "module",
          language: dominantLanguage(files),
          metadata: { profileId: "heuristic" },
        });
      }
    }
    return dedupeTargets(targets);
  }
}

function edgeFromDependency(dependency: EngineeringDiscoveryDependency): EngineeringDependencyEdge {
  return {
    from: dependency.from,
    to: dependency.to,
    type: dependency.kind,
    ...(dependency.scope === undefined
      ? {}
      : { scope: dependency.scope, configuration: dependency.scope }),
    ...(typeof dependency.metadata?.bridgeType === "string"
      ? { bridgeType: dependency.metadata.bridgeType }
      : {}),
    weight: dependency.confidence,
  };
}

function mergeEntities(
  entities: readonly EngineeringDiscoveryEntity[],
): readonly EngineeringDiscoveryEntity[] {
  return [...new Map(entities.map((entity) => [entity.id, entity])).values()];
}

function preferredEntityPath(entity: EngineeringDiscoveryEntity): string | undefined {
  if (entity.path === undefined || SOURCE_GLOB_CHARS.test(entity.path)) {
    return undefined;
  }
  return entity.path;
}

function normalizeTargetType(entity: EngineeringDiscoveryEntity): string {
  if (entity.type === "application" || entity.type === "executable") {
    return "application";
  }
  if (entity.type === "unit-test" || entity.type === "ui-test" || entity.type?.includes("test")) {
    return "test";
  }
  return entity.type ?? entity.kind;
}

function conventionRole(entity: EngineeringDiscoveryEntity): string | undefined {
  if (entity.type === undefined) {
    return undefined;
  }
  const roles = new Set([
    "application",
    "app",
    "core",
    "data",
    "di",
    "domain",
    "feature",
    "library",
    "test",
    "ui",
  ]);
  return roles.has(entity.type) ? entity.type : undefined;
}

function languageForProfile(profileId: string): string | undefined {
  switch (profileId) {
    case "easybox":
    case "xcodegen":
    case "tuist":
      return "swift";
    case "gradle-convention":
    case "kotlin-multiplatform":
      return "kotlin";
    case "nx-monorepo":
    case "react-native-hybrid":
      return "typescript";
    case "cmake-multiproject":
      return "cpp";
    case "melos":
    case "flutter-add-to-app":
      return "dart";
    default:
      return undefined;
  }
}

function shouldReplaceTarget(existing: EngineeringTarget, next: EngineeringTarget): boolean {
  const existingSource = stringMetadata(existing, "sourceFile") ?? "";
  const nextSource = stringMetadata(next, "sourceFile") ?? "";
  if (nextSource.endsWith(".local") || nextSource.includes(".local.")) {
    return true;
  }
  if (/project\.json$/i.test(nextSource) || /build\.gradle(?:\.kts)?$/i.test(nextSource)) {
    return true;
  }
  if (existing.type === "nx-project" && next.type !== "nx-project") {
    return true;
  }
  if (existing.type === "gradle-module" && next.type !== "gradle-module") {
    return true;
  }
  if (existing.path.includes("*")) {
    return true;
  }
  return existingSource.endsWith(".boxspec") && !nextSource.endsWith(".boxspec");
}

function stringMetadata(target: EngineeringTarget, key: string): string | undefined {
  const value = target.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function dominantLanguage(files: readonly EngineeringFile[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    const language = file.language || EngineeringLanguageService.inferLang(file.name);
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "unknown";
}
