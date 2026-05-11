import {
  addEngineeringDiscoveryDiagnostic,
  createEngineeringDiscoveryResult,
  type EngineeringDiscoveryParseInput,
  type EngineeringDiscoveryParseResult,
  finalizeEngineeringDiscoveryResult,
  toDiscoveryId,
} from "./EngineeringDiscoveryParserTypes.js";

export interface ParsedCMakeProject {
  readonly projectName: string;
  readonly version?: string | undefined;
  readonly subdirectories: readonly string[];
  readonly targets: readonly CMakeTarget[];
  readonly packages: readonly string[];
  readonly includeDirectories: readonly string[];
}

export interface CMakeTarget {
  readonly name: string;
  readonly type: "executable" | "static-library" | "shared-library" | "interface-library";
  readonly sources: readonly string[];
  readonly linkDependencies: readonly CMakeLinkDep[];
  readonly includeDirectories: readonly string[];
}

export interface CMakeLinkDep {
  readonly target: string;
  readonly scope: "PUBLIC" | "PRIVATE" | "INTERFACE";
}

interface CMakeCall {
  readonly name: string;
  readonly args: string;
  readonly startLine: number;
  readonly closed: boolean;
}

const LIBRARY_TYPES = new Set(["STATIC", "SHARED", "INTERFACE", "MODULE", "OBJECT"]);
const LINK_SCOPES = new Set(["PUBLIC", "PRIVATE", "INTERFACE"]);
const SOURCE_EXT_RE = /\.(?:c|cc|cpp|cxx|m|mm|h|hh|hpp|hxx|swift|rs|go)$/i;

export function parseCMakeDiscoveryFile(
  input: EngineeringDiscoveryParseInput,
): EngineeringDiscoveryParseResult {
  const result = createEngineeringDiscoveryResult("cmake", input, "cmake");
  try {
    const parsed = parseCMakeProject(input.content);
    const projectName = parsed.projectName || "cmake";
    const projectId = toDiscoveryId("project", projectName);
    result.projects.push({
      id: projectId,
      name: projectName,
      kind: "project",
      type: "cmake-project",
      version: parsed.version,
      language: "cpp",
      confidence: parsed.projectName ? 0.9 : 0.55,
      source: result.source,
    });

    for (const subdir of parsed.subdirectories) {
      const moduleId = toDiscoveryId("module", subdir);
      result.modules.push({
        id: moduleId,
        name: subdir,
        kind: "module",
        type: "cmake-subdirectory",
        path: subdir,
        local: true,
        confidence: 0.82,
        source: result.source,
      });
      result.dependencies.push({
        from: projectId,
        to: moduleId,
        kind: "includes",
        confidence: 0.82,
        source: result.source,
      });
    }

    for (const pkg of parsed.packages) {
      const packageId = toDiscoveryId("package", pkg);
      result.packages.push({
        id: packageId,
        name: pkg,
        kind: "package",
        type: "cmake-find-package",
        confidence: 0.75,
        source: result.source,
      });
      result.dependencies.push({
        from: projectId,
        to: packageId,
        kind: "package",
        confidence: 0.75,
        source: result.source,
      });
    }

    for (const target of parsed.targets) {
      const targetId = toDiscoveryId("target", target.name);
      result.targets.push({
        id: targetId,
        name: target.name,
        kind: "target",
        type: target.type,
        language: "cpp",
        local: true,
        confidence: 0.9,
        source: result.source,
        metadata: {
          sources: target.sources,
          includeDirectories: target.includeDirectories.concat(parsed.includeDirectories),
        },
      });
      result.modules.push({
        id: toDiscoveryId("module", target.name),
        name: target.name,
        kind: "module",
        type: target.type,
        language: "cpp",
        local: true,
        confidence: 0.72,
        source: result.source,
      });
      for (const link of target.linkDependencies) {
        result.dependencies.push({
          from: targetId,
          to: cmakeDependencyId(link.target),
          kind: cmakeDependencyKind(link.target),
          scope: link.scope,
          confidence: 0.86,
          source: result.source,
        });
      }
    }

    for (const diagnostic of parsedDiagnostics(input.content)) {
      addEngineeringDiscoveryDiagnostic(result, "warning", diagnostic);
    }
    result.confidence = parsed.targets.length + parsed.subdirectories.length > 0 ? 0.9 : 0.55;
  } catch (error) {
    addEngineeringDiscoveryDiagnostic(
      result,
      "error",
      diagnosticMessage("CMake parse failed", error),
    );
  }
  return finalizeEngineeringDiscoveryResult(result);
}

export function parseCMakeProject(content: string): ParsedCMakeProject {
  const calls = collectCMakeCalls(removeCMakeComments(content));
  const targets = new Map<string, CMakeTarget>();
  const subdirectories: string[] = [];
  const packages: string[] = [];
  const includeDirectories: string[] = [];
  let projectName = "";
  let version: string | undefined;

  for (const call of calls) {
    const tokens = tokenizeCMake(call.args);
    const command = call.name.toLowerCase();
    if (command === "project") {
      projectName = tokens.find((token) => !token.includes("=")) ?? projectName;
      version = valueAfterKeyword(tokens, "VERSION") ?? version;
    } else if (command === "add_subdirectory" && tokens[0]) {
      subdirectories.push(tokens[0]);
    } else if (command === "find_package" && tokens[0]) {
      packages.push(tokens[0]);
    } else if (command === "include_directories") {
      includeDirectories.push(...tokens.filter(isUsefulPathToken));
    } else if (command === "add_library" && tokens[0]) {
      targets.set(tokens[0], cmakeLibraryTarget(tokens[0], tokens.slice(1)));
    } else if (command === "add_executable" && tokens[0]) {
      targets.set(tokens[0], {
        name: tokens[0],
        type: "executable",
        sources: extractSourceFiles(tokens.slice(1)),
        linkDependencies: [],
        includeDirectories: [],
      });
    }
  }

  for (const call of calls) {
    const tokens = tokenizeCMake(call.args);
    const command = call.name.toLowerCase();
    const targetName = tokens[0];
    if (!targetName) {
      continue;
    }
    const target = targets.get(targetName);
    if (target === undefined) {
      continue;
    }
    if (command === "target_link_libraries") {
      targets.set(targetName, {
        ...target,
        linkDependencies: parseLinkDependencies(tokens.slice(1)),
      });
    } else if (command === "target_sources") {
      targets.set(targetName, {
        ...target,
        sources: unique(target.sources.concat(extractSourceFiles(tokens.slice(1)))),
      });
    } else if (command === "target_include_directories") {
      targets.set(targetName, {
        ...target,
        includeDirectories: unique(
          target.includeDirectories.concat(tokens.slice(1).filter(isUsefulPathToken)),
        ),
      });
    }
  }

  return {
    projectName,
    ...(version === undefined ? {} : { version }),
    subdirectories: unique(subdirectories),
    targets: [...targets.values()],
    packages: unique(packages),
    includeDirectories: unique(includeDirectories),
  };
}

function cmakeLibraryTarget(name: string, tokens: string[]): CMakeTarget {
  const firstType = tokens.find((token) => LIBRARY_TYPES.has(token.toUpperCase()));
  const type = cmakeLibraryType(firstType);
  return {
    name,
    type,
    sources: type === "interface-library" ? [] : extractSourceFiles(tokens),
    linkDependencies: [],
    includeDirectories: [],
  };
}

function cmakeLibraryType(type: string | undefined): CMakeTarget["type"] {
  switch (type?.toUpperCase()) {
    case "SHARED":
    case "MODULE":
      return "shared-library";
    case "INTERFACE":
      return "interface-library";
    default:
      return "static-library";
  }
}

function parseLinkDependencies(tokens: readonly string[]): CMakeLinkDep[] {
  const deps: CMakeLinkDep[] = [];
  let scope: CMakeLinkDep["scope"] = "PUBLIC";
  for (const token of tokens) {
    const upper = token.toUpperCase();
    if (LINK_SCOPES.has(upper)) {
      scope = upper as CMakeLinkDep["scope"];
      continue;
    }
    if (!isDependencyToken(token)) {
      continue;
    }
    deps.push({ target: token, scope });
  }
  return deps;
}

function extractSourceFiles(tokens: readonly string[]): string[] {
  return tokens.filter(
    (token) =>
      !LIBRARY_TYPES.has(token.toUpperCase()) &&
      !LINK_SCOPES.has(token.toUpperCase()) &&
      token !== "WIN32" &&
      token !== "MACOSX_BUNDLE" &&
      token !== "EXCLUDE_FROM_ALL" &&
      (SOURCE_EXT_RE.test(token) || token.includes("${")),
  );
}

function collectCMakeCalls(content: string): CMakeCall[] {
  const calls: CMakeCall[] = [];
  const callRe = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let match = callRe.exec(content);
  while (match !== null) {
    const name = match[1];
    if (!name) {
      match = callRe.exec(content);
      continue;
    }
    const openIndex = callRe.lastIndex - 1;
    const closeIndex = findMatchingParen(content, openIndex);
    const startLine = content.slice(0, match.index).split("\n").length;
    if (closeIndex === -1) {
      calls.push({ name, args: content.slice(openIndex + 1), startLine, closed: false });
      break;
    }
    calls.push({
      name,
      args: content.slice(openIndex + 1, closeIndex),
      startLine,
      closed: true,
    });
    callRe.lastIndex = closeIndex + 1;
    match = callRe.exec(content);
  }
  return calls;
}

function findMatchingParen(content: string, openIndex: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = openIndex; index < content.length; index += 1) {
    const char = content[index];
    const prev = content[index - 1];
    if (char === '"' && prev !== "\\") {
      quote = quote === '"' ? undefined : (quote ?? '"');
      continue;
    }
    if (quote !== undefined) {
      continue;
    }
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function tokenizeCMake(args: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote = false;
  for (let index = 0; index < args.length; index += 1) {
    const char = args[index];
    const prev = args[index - 1];
    if (char === '"' && prev !== "\\") {
      quote = !quote;
      continue;
    }
    if (/\s/.test(char ?? "") && !quote) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens.filter((token) => token.length > 0);
}

function removeCMakeComments(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      let quote = false;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        const prev = line[index - 1];
        if (char === '"' && prev !== "\\") {
          quote = !quote;
        } else if (char === "#" && !quote) {
          return line.slice(0, index);
        }
      }
      return line;
    })
    .join("\n");
}

function parsedDiagnostics(content: string): string[] {
  return collectCMakeCalls(removeCMakeComments(content))
    .filter((call) => !call.closed)
    .map((call) => `Incomplete CMake call '${call.name}' starting at line ${call.startLine}`);
}

function valueAfterKeyword(tokens: readonly string[], keyword: string): string | undefined {
  const index = tokens.findIndex((token) => token.toUpperCase() === keyword);
  return index === -1 ? undefined : tokens[index + 1];
}

function isDependencyToken(token: string): boolean {
  return (
    token.length > 0 &&
    !token.startsWith("$<") &&
    !token.startsWith("${") &&
    token !== "debug" &&
    token !== "optimized" &&
    token !== "general"
  );
}

function isUsefulPathToken(token: string): boolean {
  return (
    token.length > 0 &&
    !LINK_SCOPES.has(token.toUpperCase()) &&
    !token.startsWith("$<") &&
    token !== "SYSTEM" &&
    token !== "BEFORE" &&
    token !== "AFTER"
  );
}

function cmakeDependencyId(target: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.-]*::/.test(target)
    ? toDiscoveryId("package", target)
    : toDiscoveryId("target", target);
}

function cmakeDependencyKind(target: string): "package" | "target" {
  return /^[A-Za-z_][A-Za-z0-9_.-]*::/.test(target) ? "package" : "target";
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function diagnosticMessage(prefix: string, error: unknown): string {
  return error instanceof Error ? `${prefix}: ${error.message}` : prefix;
}
