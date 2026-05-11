import {
  addEngineeringDiscoveryDiagnostic,
  createEngineeringDiscoveryResult,
  type EngineeringDiscoveryEntity,
  type EngineeringDiscoveryParseInput,
  type EngineeringDiscoveryParseResult,
  finalizeEngineeringDiscoveryResult,
  toDiscoveryId,
} from "./EngineeringDiscoveryParserTypes.js";

export interface ParsedGradleProject {
  readonly rootProjectName: string;
  readonly includedModules: readonly GradleModule[];
  readonly versionCatalog?: string | undefined;
}

export interface GradleModule {
  readonly path: string;
  readonly directory: string;
  readonly conventionPlugin?: string | undefined;
  readonly dependencies: readonly GradleDep[];
}

export interface GradleDep {
  readonly configuration: string;
  readonly target: string;
  readonly isProject: boolean;
}

interface GradlePluginUse {
  readonly id: string;
  readonly version?: string | undefined;
  readonly alias?: boolean | undefined;
}

interface GradleExternalDependency {
  readonly configuration: string;
  readonly notation: string;
}

const ROOT_NAME_RE = /rootProject\.name\s*=\s*["']([^"']+)["']/;
const INCLUDE_CALL_RE = /\binclude\s*(?:\(([\s\S]*?)\)|((?:\s*["'][^"']+["']\s*,?)+))/g;
const INCLUDE_BUILD_RE = /\bincludeBuild\s*\(\s*["']([^"']+)["']\s*\)/g;
const PROJECT_DIR_RE =
  /project\s*\(\s*["']([^"']+)["']\s*\)\.projectDir\s*=\s*(?:file|File|new\s+File)\s*\(([\s\S]*?)\)/g;
const PROJECT_DEP_RE =
  /\b([A-Za-z_][\w-]*)\s*(?:\(\s*)?project\s*\(\s*["']([^"']+)["']\s*\)\s*\)?/g;
const EXTERNAL_DEP_RE =
  /\b([A-Za-z_][\w-]*)\s*(?:\(\s*["']([^"']+:[^"']+)(?:["']\s*\))?|\s+["']([^"']+:[^"']+)["'])/g;
const PLUGIN_ID_RE = /\bid\s*(?:\(\s*)?["']([^"']+)["']\s*\)?(?:\s*version\s*["']([^"']+)["'])?/g;
const KOTLIN_PLUGIN_RE = /\bkotlin\s*\(\s*["']([^"']+)["']\s*\)(?:\s*version\s*["']([^"']+)["'])?/g;
const ALIAS_PLUGIN_RE = /\balias\s*\(\s*([^)]+)\)/g;

export function parseGradleDiscoveryFile(
  input: EngineeringDiscoveryParseInput,
): EngineeringDiscoveryParseResult {
  const result = createEngineeringDiscoveryResult("gradle-dsl", input, gradleFormat(input));
  try {
    const filePath = input.filePath ?? "";
    if (/libs\.versions\.toml$/i.test(filePath)) {
      parseVersionCatalog(input.content, result);
    } else if (/settings\.gradle(?:\.kts)?$/i.test(filePath)) {
      parseGradleSettings(input.content, result);
    } else {
      parseGradleBuild(input.content, result, moduleNameFromBuildPath(filePath));
    }

    if (result.projects.length + result.modules.length + result.targets.length === 0) {
      addEngineeringDiscoveryDiagnostic(
        result,
        "warning",
        "Gradle DSL parser did not find project structure declarations",
      );
      result.confidence = Math.max(result.confidence, 0.2);
    }
  } catch (error) {
    addEngineeringDiscoveryDiagnostic(
      result,
      "error",
      diagnosticMessage("Gradle DSL parse failed", error),
    );
  }
  return finalizeEngineeringDiscoveryResult(result);
}

export function parseGradleProject(
  content: string,
  existingModule?: GradleModule,
): ParsedGradleProject {
  if (existingModule) {
    return {
      rootProjectName: "",
      includedModules: [parseBuildFileForModule(content, existingModule)],
    };
  }

  const rootProjectName = content.match(ROOT_NAME_RE)?.[1] ?? "";
  const projectDirs = extractProjectDirs(content);
  const modules = new Map<string, GradleModule>();
  for (const path of extractIncludes(content)) {
    modules.set(path, {
      path,
      directory: projectDirs.get(path) ?? gradlePathToDirectory(path),
      dependencies: [],
    });
  }

  const parsed: ParsedGradleProject = {
    rootProjectName,
    includedModules: [...modules.values()],
    ...(detectVersionCatalogPath(content) === undefined
      ? {}
      : { versionCatalog: detectVersionCatalogPath(content) }),
  };
  return parsed;
}

export function isKmpBuildFile(content: string): boolean {
  return /\bkotlin\s*\(\s*["']multiplatform["']\s*\)/.test(content);
}

export function inferConventionRole(pluginId: string): string | undefined {
  const last = pluginId.split(".").at(-1);
  const roles: Readonly<Record<string, string>> = {
    feature: "feature",
    library: "library",
    app: "application",
    application: "application",
    core: "core",
    data: "data",
    domain: "domain",
    ui: "ui",
    test: "test",
    compose: "compose",
    hilt: "di",
  };
  return last === undefined ? undefined : roles[last];
}

function parseGradleSettings(
  content: string,
  result: ReturnType<typeof createEngineeringDiscoveryResult>,
): void {
  const projectName = content.match(ROOT_NAME_RE)?.[1] ?? "gradle";
  const projectId = toDiscoveryId("project", projectName);
  result.projects.push({
    id: projectId,
    name: projectName,
    kind: "project",
    type: "gradle-root",
    language: "kotlin",
    confidence: projectName === "gradle" ? 0.65 : 0.92,
    source: result.source,
    metadata: { format: result.source.format },
  });

  const projectDirs = extractProjectDirs(content);
  for (const modulePath of extractIncludes(content)) {
    const module = gradleModuleEntity(
      modulePath,
      projectDirs.get(modulePath) ?? gradlePathToDirectory(modulePath),
      result.source,
    );
    result.modules.push(module);
    result.dependencies.push({
      from: projectId,
      to: module.id,
      kind: "workspace",
      confidence: 0.9,
      source: result.source,
      metadata: { gradlePath: modulePath },
    });
  }

  for (const includedBuild of extractIncludeBuilds(content)) {
    const id = toDiscoveryId("module", includedBuild);
    result.modules.push({
      id,
      name: includedBuild,
      kind: "module",
      type: "gradle-included-build",
      path: includedBuild,
      local: true,
      confidence: 0.82,
      source: result.source,
    });
    result.dependencies.push({
      from: projectId,
      to: id,
      kind: "workspace",
      confidence: 0.82,
      source: result.source,
    });
  }

  const catalogPath = detectVersionCatalogPath(content);
  if (catalogPath) {
    result.packages.push({
      id: toDiscoveryId("resource", catalogPath),
      name: catalogPath,
      kind: "resource",
      type: "gradle-version-catalog",
      path: catalogPath,
      confidence: 0.78,
      source: result.source,
    });
    result.dependencies.push({
      from: projectId,
      to: toDiscoveryId("resource", catalogPath),
      kind: "includes",
      confidence: 0.78,
      source: result.source,
    });
  }
  result.confidence = 0.9;
}

function parseGradleBuild(
  content: string,
  result: ReturnType<typeof createEngineeringDiscoveryResult>,
  moduleName: string,
): void {
  const moduleId = toDiscoveryId("module", moduleName);
  const plugins = extractPlugins(content);
  const projectDeps = extractProjectDependencies(content);
  const externalDeps = extractExternalDependencies(content);
  const blockScopes = extractScopedBuildBlocks(content);
  const conventionPlugin = plugins.find((plugin) => inferConventionRole(plugin.id) !== undefined);

  result.modules.push({
    id: moduleId,
    name: moduleName,
    kind: "module",
    type: inferConventionRole(conventionPlugin?.id ?? "") ?? "gradle-module",
    path: moduleName === "root" ? "." : moduleName,
    language: inferGradleLanguage(plugins, content),
    local: true,
    confidence: 0.82,
    source: result.source,
    metadata: {
      gradlePath: directoryToGradlePath(moduleName),
      plugins: plugins.map((plugin) => plugin.id),
      scopedBlocks: blockScopes,
    },
  });

  for (const plugin of plugins) {
    result.packages.push({
      id: toDiscoveryId("package", plugin.id),
      name: plugin.id,
      kind: "package",
      type: plugin.alias === true ? "gradle-plugin-alias" : "gradle-plugin",
      version: plugin.version,
      confidence: 0.65,
      source: result.source,
    });
    result.dependencies.push({
      from: moduleId,
      to: toDiscoveryId("package", plugin.id),
      kind: "uses",
      confidence: 0.7,
      source: result.source,
    });
  }

  for (const dep of projectDeps) {
    result.dependencies.push({
      from: moduleId,
      to: toDiscoveryId("module", gradlePathToName(dep.target)),
      kind: "depends_on",
      scope: dep.configuration,
      confidence: 0.9,
      source: result.source,
      metadata: { gradlePath: dep.target },
    });
  }

  for (const dep of externalDeps) {
    const packageName = gradleDependencyName(dep.notation);
    result.packages.push({
      id: toDiscoveryId("package", packageName),
      name: packageName,
      kind: "package",
      type: "gradle-dependency",
      version: gradleDependencyVersion(dep.notation),
      confidence: 0.72,
      source: result.source,
      metadata: { notation: dep.notation },
    });
    result.dependencies.push({
      from: moduleId,
      to: toDiscoveryId("package", packageName),
      kind: "package",
      scope: dep.configuration,
      confidence: 0.78,
      source: result.source,
    });
  }

  result.confidence = plugins.length + projectDeps.length + externalDeps.length > 0 ? 0.82 : 0.35;
}

function parseVersionCatalog(
  content: string,
  result: ReturnType<typeof createEngineeringDiscoveryResult>,
): void {
  const catalogId = toDiscoveryId("resource", "gradle/libs.versions.toml");
  result.projects.push({
    id: toDiscoveryId("project", "gradle-version-catalog"),
    name: "gradle-version-catalog",
    kind: "project",
    type: "gradle-version-catalog",
    confidence: 0.65,
    source: result.source,
  });
  result.packages.push({
    id: catalogId,
    name: "gradle/libs.versions.toml",
    kind: "resource",
    type: "gradle-version-catalog",
    confidence: 0.82,
    source: result.source,
  });

  let section = "";
  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/#.*/, "").trim();
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch?.[1]) {
      section = sectionMatch[1];
      continue;
    }
    if (section !== "libraries" && section !== "plugins") {
      continue;
    }
    const aliasMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!aliasMatch?.[1] || !aliasMatch[2]) {
      continue;
    }
    const notation = extractCatalogNotation(aliasMatch[2]);
    const name = notation ?? aliasMatch[1];
    result.packages.push({
      id: toDiscoveryId("package", name),
      name,
      kind: "package",
      type: section === "plugins" ? "gradle-plugin" : "gradle-dependency",
      confidence: 0.62,
      source: result.source,
      metadata: { alias: aliasMatch[1] },
    });
    result.dependencies.push({
      from: catalogId,
      to: toDiscoveryId("package", name),
      kind: "includes",
      confidence: 0.62,
      source: result.source,
    });
  }
  result.confidence = 0.78;
}

function parseBuildFileForModule(content: string, module: GradleModule): GradleModule {
  const plugins = extractPlugins(content);
  return {
    ...module,
    conventionPlugin: plugins.find((plugin) => inferConventionRole(plugin.id) !== undefined)?.id,
    dependencies: extractProjectDependencies(content),
  };
}

function extractIncludes(content: string): string[] {
  const modules = new Set<string>();
  const includeRe = new RegExp(INCLUDE_CALL_RE.source, "g");
  let match = includeRe.exec(content);
  while (match !== null) {
    const values = match[1] ?? match[2] ?? "";
    for (const value of quotedValues(values)) {
      modules.add(value);
    }
    match = includeRe.exec(content);
  }
  return [...modules].sort();
}

function extractIncludeBuilds(content: string): string[] {
  const builds = new Set<string>();
  const re = new RegExp(INCLUDE_BUILD_RE.source, "g");
  let match = re.exec(content);
  while (match !== null) {
    if (match[1]) {
      builds.add(match[1]);
    }
    match = re.exec(content);
  }
  return [...builds].sort();
}

function extractProjectDirs(content: string): Map<string, string> {
  const dirs = new Map<string, string>();
  const re = new RegExp(PROJECT_DIR_RE.source, "g");
  let match = re.exec(content);
  while (match !== null) {
    if (!match[1] || !match[2]) {
      match = re.exec(content);
      continue;
    }
    const value = quotedValues(match[2]).at(-1);
    if (value) {
      dirs.set(match[1], value);
    }
    match = re.exec(content);
  }
  return dirs;
}

function extractPlugins(content: string): GradlePluginUse[] {
  const plugins = new Map<string, GradlePluginUse>();
  for (const block of extractNamedBlocks(content, "plugins")) {
    collectPluginUses(block, plugins);
  }
  collectPluginUses(content, plugins);
  return [...plugins.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function collectPluginUses(content: string, plugins: Map<string, GradlePluginUse>): void {
  const idRe = new RegExp(PLUGIN_ID_RE.source, "g");
  let match = idRe.exec(content);
  while (match !== null) {
    if (match[1]) {
      plugins.set(match[1], { id: match[1], version: match[2] });
    }
    match = idRe.exec(content);
  }
  const kotlinRe = new RegExp(KOTLIN_PLUGIN_RE.source, "g");
  match = kotlinRe.exec(content);
  while (match !== null) {
    if (match[1]) {
      plugins.set(`org.jetbrains.kotlin.${match[1]}`, {
        id: `org.jetbrains.kotlin.${match[1]}`,
        version: match[2],
      });
    }
    match = kotlinRe.exec(content);
  }
  const aliasRe = new RegExp(ALIAS_PLUGIN_RE.source, "g");
  match = aliasRe.exec(content);
  while (match !== null) {
    if (match[1]) {
      const alias = match[1].trim();
      plugins.set(alias, { id: alias, alias: true });
    }
    match = aliasRe.exec(content);
  }
}

function extractProjectDependencies(content: string): GradleDep[] {
  const deps = new Map<string, GradleDep>();
  const re = new RegExp(PROJECT_DEP_RE.source, "g");
  let match = re.exec(content);
  while (match !== null) {
    if (!match[1] || !match[2]) {
      match = re.exec(content);
      continue;
    }
    deps.set(`${match[1]}\u0000${match[2]}`, {
      configuration: match[1],
      target: match[2],
      isProject: true,
    });
    match = re.exec(content);
  }
  return [...deps.values()];
}

function extractExternalDependencies(content: string): GradleExternalDependency[] {
  const deps = new Map<string, GradleExternalDependency>();
  const re = new RegExp(EXTERNAL_DEP_RE.source, "g");
  let match = re.exec(content);
  while (match !== null) {
    const notation = match[2] ?? match[3];
    if (!match[1] || !notation || notation.startsWith("project:")) {
      match = re.exec(content);
      continue;
    }
    deps.set(`${match[1]}\u0000${notation}`, { configuration: match[1], notation });
    match = re.exec(content);
  }
  return [...deps.values()];
}

function extractScopedBuildBlocks(content: string): string[] {
  return ["subprojects", "allprojects"]
    .filter((name) => extractNamedBlocks(content, name).length > 0)
    .sort();
}

function extractNamedBlocks(content: string, name: string): string[] {
  const blocks: string[] = [];
  const re = new RegExp(`\\b${name}\\s*\\{`, "g");
  let match = re.exec(content);
  while (match !== null) {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = findMatchingBrace(content, bodyStart - 1);
    if (bodyEnd > bodyStart) {
      blocks.push(content.slice(bodyStart, bodyEnd));
    }
    match = re.exec(content);
  }
  return blocks;
}

function findMatchingBrace(content: string, openIndex: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = openIndex; index < content.length; index += 1) {
    const char = content[index];
    const prev = content[index - 1];
    if ((char === '"' || char === "'") && prev !== "\\") {
      quote = quote === char ? undefined : (quote ?? char);
      continue;
    }
    if (quote !== undefined) {
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function detectVersionCatalogPath(content: string): string | undefined {
  const explicit = content.match(/from\s*\(\s*files\s*\(\s*["']([^"']+)["']/)?.[1];
  if (explicit) {
    return explicit;
  }
  return content.includes("versionCatalogs") || content.includes("libs.versions.toml")
    ? "gradle/libs.versions.toml"
    : undefined;
}

function extractCatalogNotation(value: string): string | undefined {
  const moduleMatch = value.match(/module\s*=\s*["']([^"']+)["']/);
  if (moduleMatch?.[1]) {
    return moduleMatch[1];
  }
  const idMatch = value.match(/id\s*=\s*["']([^"']+)["']/);
  if (idMatch?.[1]) {
    return idMatch[1];
  }
  return value.match(/["']([^"']+:[^"']+)["']/)?.[1];
}

function quotedValues(value: string): string[] {
  const values: string[] = [];
  const re = /["']([^"']+)["']/g;
  let match = re.exec(value);
  while (match !== null) {
    if (match[1]) {
      values.push(match[1]);
    }
    match = re.exec(value);
  }
  return values;
}

function gradleModuleEntity(
  gradlePath: string,
  directory: string,
  source: EngineeringDiscoveryEntity["source"],
): EngineeringDiscoveryEntity {
  return {
    id: toDiscoveryId("module", gradlePathToName(gradlePath)),
    name: gradlePathToName(gradlePath),
    kind: "module",
    type: "gradle-module",
    path: directory,
    local: true,
    confidence: 0.9,
    source,
    metadata: { gradlePath },
  };
}

function gradlePathToDirectory(path: string): string {
  return path.replace(/^:/, "").replace(/:/g, "/");
}

function gradlePathToName(path: string): string {
  return path.replace(/^:/, "").replace(/:/g, ":");
}

function directoryToGradlePath(path: string): string {
  return path === "root" || path === "." ? ":" : `:${path.replace(/\//g, ":")}`;
}

function moduleNameFromBuildPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const parent = normalized.split("/").slice(0, -1).join("/");
  return parent.length === 0 ? "root" : parent;
}

function gradleDependencyName(notation: string): string {
  const parts = notation.split(":");
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : notation;
}

function gradleDependencyVersion(notation: string): string | undefined {
  return notation.split(":").at(2);
}

function inferGradleLanguage(
  plugins: readonly GradlePluginUse[],
  content: string,
): string | undefined {
  if (plugins.some((plugin) => plugin.id.includes("kotlin")) || isKmpBuildFile(content)) {
    return "kotlin";
  }
  if (plugins.some((plugin) => plugin.id.includes("android"))) {
    return "android";
  }
  if (plugins.some((plugin) => plugin.id === "java" || plugin.id.includes(".java"))) {
    return "java";
  }
  return undefined;
}

function gradleFormat(input: EngineeringDiscoveryParseInput): string {
  if (/libs\.versions\.toml$/i.test(input.filePath ?? "")) {
    return "gradle-version-catalog";
  }
  return /\.kts$/i.test(input.filePath ?? "") ? "gradle-kotlin-dsl" : "gradle-groovy-dsl";
}

function diagnosticMessage(prefix: string, error: unknown): string {
  return error instanceof Error ? `${prefix}: ${error.message}` : prefix;
}
