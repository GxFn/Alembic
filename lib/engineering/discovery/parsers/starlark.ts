import {
  addEngineeringDiscoveryDiagnostic,
  createEngineeringDiscoveryResult,
  type EngineeringDiscoveryParseInput,
  type EngineeringDiscoveryParseResult,
  finalizeEngineeringDiscoveryResult,
  toDiscoveryId,
} from "./types.js";

export interface StarlarkTarget {
  readonly rule: string;
  readonly name: string;
  readonly srcs: readonly string[];
  readonly deps: readonly string[];
  readonly visibility: readonly string[];
  readonly testonly?: boolean | undefined;
}

export interface LoadStatement {
  readonly repository: string;
  readonly path: string;
  readonly symbols: readonly string[];
}

export interface ParsedBuildFile {
  readonly targets: readonly StarlarkTarget[];
  readonly loads: readonly LoadStatement[];
}

interface StarlarkCall {
  readonly name: string;
  readonly body: string;
  readonly startLine: number;
  readonly closed: boolean;
}

export const RULE_TO_LANGUAGE: Readonly<Record<string, string>> = {
  swift_library: "swift",
  swift_binary: "swift",
  swift_test: "swift",
  cc_library: "cpp",
  cc_binary: "cpp",
  cc_test: "cpp",
  cxx_library: "cpp",
  cxx_binary: "cpp",
  cxx_test: "cpp",
  java_library: "java",
  java_binary: "java",
  java_test: "java",
  kt_jvm_library: "kotlin",
  kt_jvm_binary: "kotlin",
  android_library: "kotlin",
  android_binary: "kotlin",
  py_library: "python",
  py_binary: "python",
  py_test: "python",
  python_library: "python",
  python_binary: "python",
  python_source: "python",
  python_sources: "python",
  go_library: "go",
  go_binary: "go",
  go_test: "go",
  rust_library: "rust",
  rust_binary: "rust",
  rust_test: "rust",
  ts_project: "typescript",
  proto_library: "protobuf",
  apple_library: "swift",
  apple_binary: "swift",
  docker_image: "docker",
};

const TOP_LEVEL_NON_TARGET_CALLS = new Set([
  "bazel_dep",
  "git_repository",
  "http_archive",
  "load",
  "maven_install",
  "module",
  "package",
  "register_toolchains",
  "workspace",
]);

export function parseStarlarkDiscoveryFile(
  input: EngineeringDiscoveryParseInput,
): EngineeringDiscoveryParseResult {
  const result = createEngineeringDiscoveryResult("starlark", input, starlarkFormat(input));
  try {
    if (/MODULE\.bazel$/i.test(input.filePath ?? "")) {
      parseBazelModuleFile(input.content, result);
    } else if (/(^|\/)WORKSPACE(?:\.bazel)?$/i.test(input.filePath ?? "")) {
      parseBazelWorkspaceFile(input.content, result);
    } else {
      parseBazelBuildFile(input.content, input.filePath ?? "", result);
    }

    if (result.targets.length + result.packages.length + result.projects.length === 0) {
      addEngineeringDiscoveryDiagnostic(
        result,
        "warning",
        "Starlark parser did not find Bazel declarations",
      );
      result.confidence = Math.max(result.confidence, 0.2);
    }
  } catch (error) {
    addEngineeringDiscoveryDiagnostic(
      result,
      "error",
      diagnosticMessage("Starlark parse failed", error),
    );
  }
  return finalizeEngineeringDiscoveryResult(result);
}

export function parseStarlarkBuildFile(content: string): ParsedBuildFile {
  const calls = collectStarlarkCalls(content);
  return {
    loads: calls.filter((call) => call.name === "load").flatMap(parseLoadCall),
    targets: calls
      .filter((call) => call.name !== "load" && call.name !== "package")
      .flatMap((call) => parseTargetCall(call) ?? []),
  };
}

function parseBazelBuildFile(
  content: string,
  filePath: string,
  result: ReturnType<typeof createEngineeringDiscoveryResult>,
): void {
  const packageName = packageNameFromBuildPath(filePath);
  const packageId = toDiscoveryId("package", `//${packageName}`);
  const calls = collectStarlarkCalls(content);

  const packageCall = calls.find((call) => call.name === "package");
  const defaultVisibility = packageCall
    ? extractStringList(packageCall.body, "default_visibility")
    : [];
  result.packages.push({
    id: packageId,
    name: `//${packageName}`,
    kind: "package",
    type: "bazel-package",
    path: packageName,
    confidence: 0.76,
    source: result.source,
    metadata: { defaultVisibility },
  });

  for (const call of calls) {
    if (!call.closed) {
      addEngineeringDiscoveryDiagnostic(
        result,
        "warning",
        `Incomplete Starlark call '${call.name}' starting at line ${call.startLine}`,
      );
    }
    if (call.name === "load") {
      for (const load of parseLoadCall(call)) {
        const loadId = toDiscoveryId("package", load.path);
        result.packages.push({
          id: loadId,
          name: load.path,
          kind: "package",
          type: "starlark-load",
          confidence: 0.7,
          source: result.source,
          metadata: { repository: load.repository, symbols: load.symbols },
        });
        result.dependencies.push({
          from: packageId,
          to: loadId,
          kind: "includes",
          confidence: 0.72,
          source: result.source,
        });
      }
      continue;
    }
    if (TOP_LEVEL_NON_TARGET_CALLS.has(call.name)) {
      continue;
    }

    const target = parseTargetCall(call);
    if (target === null) {
      continue;
    }
    const label = `//${packageName}:${target.name}`;
    const targetId = toDiscoveryId("target", label);
    result.targets.push({
      id: targetId,
      name: target.name,
      kind: "target",
      type: target.rule,
      path: packageName,
      language: RULE_TO_LANGUAGE[target.rule],
      local: true,
      confidence: RULE_TO_LANGUAGE[target.rule] === undefined ? 0.7 : 0.88,
      source: result.source,
      metadata: {
        rule: target.rule,
        srcs: target.srcs,
        visibility: target.visibility.length > 0 ? target.visibility : defaultVisibility,
        testonly: target.testonly === true,
      },
    });
    result.dependencies.push({
      from: packageId,
      to: targetId,
      kind: "target",
      confidence: 0.75,
      source: result.source,
    });
    for (const dep of target.deps) {
      result.dependencies.push({
        from: targetId,
        to: labelToDiscoveryId(dep, packageName),
        kind: dep.startsWith("@") ? "package" : "target",
        confidence: 0.86,
        source: result.source,
        metadata: { label: dep },
      });
    }
  }
  result.confidence = result.targets.length > 0 ? 0.88 : 0.55;
}

function parseBazelWorkspaceFile(
  content: string,
  result: ReturnType<typeof createEngineeringDiscoveryResult>,
): void {
  const calls = collectStarlarkCalls(content);
  const workspaceName =
    calls
      .find((call) => call.name === "workspace")
      ?.body.match(/\bname\s*=\s*["']([^"']+)["']/)?.[1] ?? "bazel-workspace";
  const workspaceId = toDiscoveryId("workspace", workspaceName);
  result.projects.push({
    id: workspaceId,
    name: workspaceName,
    kind: "workspace",
    type: "bazel-workspace",
    confidence: 0.82,
    source: result.source,
  });

  for (const call of calls.filter((item) => item.name !== "workspace" && item.name !== "load")) {
    const repoName = stringField(call.body, "name");
    if (!repoName) {
      continue;
    }
    const packageId = toDiscoveryId("package", repoName);
    result.packages.push({
      id: packageId,
      name: repoName,
      kind: "package",
      type: `bazel-${call.name}`,
      version: stringField(call.body, "version") ?? stringField(call.body, "tag"),
      confidence: 0.66,
      source: result.source,
      metadata: { rule: call.name, url: stringField(call.body, "url") },
    });
    result.dependencies.push({
      from: workspaceId,
      to: packageId,
      kind: "package",
      confidence: 0.68,
      source: result.source,
    });
  }
  result.confidence = 0.78;
}

function parseBazelModuleFile(
  content: string,
  result: ReturnType<typeof createEngineeringDiscoveryResult>,
): void {
  const calls = collectStarlarkCalls(content);
  const moduleCall = calls.find((call) => call.name === "module");
  const moduleName =
    moduleCall === undefined
      ? "bazel-module"
      : (stringField(moduleCall.body, "name") ?? "bazel-module");
  const moduleId = toDiscoveryId("workspace", moduleName);
  result.projects.push({
    id: moduleId,
    name: moduleName,
    kind: "workspace",
    type: "bazel-module",
    version: moduleCall === undefined ? undefined : stringField(moduleCall.body, "version"),
    confidence: moduleCall === undefined ? 0.55 : 0.85,
    source: result.source,
  });

  for (const bazelDep of calls.filter((call) => call.name === "bazel_dep")) {
    const name = stringField(bazelDep.body, "name");
    if (!name) {
      continue;
    }
    const packageId = toDiscoveryId("package", name);
    result.packages.push({
      id: packageId,
      name,
      kind: "package",
      type: "bazel-module-dependency",
      version: stringField(bazelDep.body, "version"),
      confidence: 0.78,
      source: result.source,
    });
    result.dependencies.push({
      from: moduleId,
      to: packageId,
      kind: "package",
      confidence: 0.8,
      source: result.source,
    });
  }
  result.confidence = 0.82;
}

function collectStarlarkCalls(content: string): StarlarkCall[] {
  const calls: StarlarkCall[] = [];
  const lines = content.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = stripComment(lines[index] ?? "");
    const match = line.trim().match(/^([A-Za-z_]\w*)\s*\(/);
    if (!match?.[1]) {
      index += 1;
      continue;
    }

    const blockLines = [line];
    let depth = parenDelta(line);
    const startLine = index + 1;
    index += 1;
    while (index < lines.length && depth > 0) {
      const nextLine = stripComment(lines[index] ?? "");
      blockLines.push(nextLine);
      depth += parenDelta(nextLine);
      index += 1;
    }
    calls.push({
      name: match[1],
      body: blockLines.join("\n"),
      startLine,
      closed: depth <= 0,
    });
  }
  return calls;
}

function parseLoadCall(call: StarlarkCall): LoadStatement[] {
  const values = quotedValues(call.body);
  const label = values[0];
  if (!label) {
    return [];
  }
  const repository = label.startsWith("@") ? label.slice(0, label.indexOf("//")) : "";
  const path = repository.length > 0 ? label.slice(repository.length) : label;
  return [{ repository, path, symbols: values.slice(1) }];
}

function parseTargetCall(call: StarlarkCall): StarlarkTarget | null {
  const name = stringField(call.body, "name");
  if (!name) {
    return null;
  }
  return {
    rule: call.name,
    name,
    srcs: extractStringList(call.body, "srcs"),
    deps: extractStringList(call.body, "deps"),
    visibility: extractStringList(call.body, "visibility"),
    ...(/\btestonly\s*=\s*(?:True|1)/.test(call.body) ? { testonly: true } : {}),
  };
}

function extractStringList(block: string, field: string): string[] {
  const match = block.match(
    new RegExp(`\\b${field}\\s*=\\s*(?:glob\\s*\\(\\s*)?\\[([\\s\\S]*?)\\]`, "m"),
  );
  if (!match?.[1]) {
    const single = block.match(new RegExp(`\\b${field}\\s*=\\s*["']([^"']+)["']`))?.[1];
    return single === undefined ? [] : [single];
  }
  return quotedValues(match[1]);
}

function labelToDiscoveryId(label: string, packageName: string): string {
  if (label.startsWith("@")) {
    return toDiscoveryId("package", label);
  }
  if (label.startsWith(":")) {
    return toDiscoveryId("target", `//${packageName}${label}`);
  }
  return toDiscoveryId("target", label);
}

function packageNameFromBuildPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  const fileName = parts.at(-1) ?? "";
  if (/^BUILD(?:\.bazel)?$/i.test(fileName)) {
    return parts.slice(0, -1).join("/");
  }
  return parts.slice(0, -1).join("/");
}

function stringField(block: string, field: string): string | undefined {
  return block.match(new RegExp(`\\b${field}\\s*=\\s*["']([^"']+)["']`))?.[1];
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

function stripComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const prev = line[index - 1];
    if ((char === '"' || char === "'") && prev !== "\\") {
      quote = quote === char ? undefined : (quote ?? char);
      continue;
    }
    if (char === "#" && quote === undefined) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parenDelta(line: string): number {
  let quote: string | undefined;
  let delta = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const prev = line[index - 1];
    if ((char === '"' || char === "'") && prev !== "\\") {
      quote = quote === char ? undefined : (quote ?? char);
      continue;
    }
    if (quote !== undefined) {
      continue;
    }
    if (char === "(") {
      delta += 1;
    } else if (char === ")") {
      delta -= 1;
    }
  }
  return delta;
}

function starlarkFormat(input: EngineeringDiscoveryParseInput): string {
  const filePath = input.filePath ?? "";
  if (/MODULE\.bazel$/i.test(filePath)) {
    return "bazel-module";
  }
  if (/(^|\/)WORKSPACE(?:\.bazel)?$/i.test(filePath)) {
    return "bazel-workspace";
  }
  return "bazel-build";
}

function diagnosticMessage(prefix: string, error: unknown): string {
  return error instanceof Error ? `${prefix}: ${error.message}` : prefix;
}
