import {
  addEngineeringDiscoveryDiagnostic,
  createEngineeringDiscoveryResult,
  createEngineeringDiscoverySource,
  type EngineeringDiscoveryEntity,
  type EngineeringDiscoveryLayer,
  type EngineeringDiscoveryParseInput,
  type EngineeringDiscoveryParseResult,
  finalizeEngineeringDiscoveryResult,
  toDiscoveryId,
} from "./EngineeringDiscoveryParserTypes.js";

export interface RubyDslModuleSpec {
  readonly name: string;
  readonly version: string;
  readonly sources: readonly string[];
  readonly resources: readonly string[];
  readonly dependencies: readonly string[];
  readonly publicHeaders: readonly string[];
  readonly deploymentTarget?: string | undefined;
}

interface RubyLayerBlock {
  readonly name: string;
  readonly body: string;
  readonly startIndex: number;
  readonly endIndex: number;
}

interface RubyBoxDeclaration {
  readonly name: string;
  readonly version?: string | undefined;
  readonly localPath?: string | undefined;
  readonly group?: string | undefined;
}

export function parseRubyDiscoveryFile(
  input: EngineeringDiscoveryParseInput,
): EngineeringDiscoveryParseResult {
  const filePath = input.filePath ?? "";
  if (/\.(boxspec|podspec)$/i.test(filePath)) {
    return parseRubyModuleSpec(input);
  }
  return parseEasyBoxBoxfile(input);
}

export function parseEasyBoxBoxfile(
  input: EngineeringDiscoveryParseInput,
): EngineeringDiscoveryParseResult {
  const result = createEngineeringDiscoveryResult("ruby-dsl", input, "easybox-boxfile");
  try {
    const hostApp = input.content.match(/host_app\s+['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"])?/);
    if (hostApp?.[1]) {
      result.projects.push({
        id: toDiscoveryId("project", hostApp[1]),
        name: hostApp[1],
        kind: "project",
        version: hostApp[2] ?? "0.0.0",
        confidence: 0.9,
        source: result.source,
      });
    }

    const sources = extractQuotedDirectiveValues(input.content, "source");
    for (const sourceValue of sources) {
      result.packages.push({
        id: toDiscoveryId("package-source", sourceValue),
        name: sourceValue,
        kind: "package",
        type: "ruby-source",
        confidence: 0.65,
        source: result.source,
      });
    }

    const includes = extractQuotedDirectiveValues(input.content, "include");
    for (const includeValue of includes) {
      result.dependencies.push({
        from: result.projects[0]?.id ?? toDiscoveryId("workspace", "easybox"),
        to: includeValue,
        kind: "includes",
        confidence: 0.65,
        source: result.source,
      });
    }

    const layerBlocks = extractLayerBlocks(input.content);
    for (const [order, block] of layerBlocks.entries()) {
      const layerSource = createEngineeringDiscoverySource(
        "ruby-dsl",
        input,
        "easybox-layer",
        `layer:${block.name}`,
      );
      const layer: EngineeringDiscoveryLayer = {
        name: block.name,
        order,
        accessibleLayers: extractAccessLayers(block.body),
        source: layerSource,
      };
      result.layers.push(layer);
      for (const moduleDecl of extractBoxDeclarations(block.body)) {
        result.modules.push(boxToEntity(moduleDecl, block.name, result.source));
      }
    }

    const outsideLayerContent = removeLayerBlocks(input.content);
    for (const moduleDecl of extractBoxDeclarations(outsideLayerContent)) {
      result.modules.push(boxToEntity(moduleDecl, undefined, result.source));
    }

    result.confidence = result.layers.length > 0 || result.modules.length > 0 ? 0.9 : 0.2;
  } catch (error) {
    addEngineeringDiscoveryDiagnostic(
      result,
      "error",
      diagnosticMessage("Ruby DSL parse failed", error),
    );
  }
  return finalizeEngineeringDiscoveryResult(result);
}

export function parseRubyModuleSpec(
  input: EngineeringDiscoveryParseInput,
): EngineeringDiscoveryParseResult {
  const result = createEngineeringDiscoveryResult("ruby-dsl", input, "ruby-module-spec");
  try {
    const spec = extractRubyModuleSpec(input.content);
    const moduleId = toDiscoveryId("module", spec.name);
    result.modules.push({
      id: moduleId,
      name: spec.name,
      kind: "module",
      version: spec.version,
      local: true,
      confidence: spec.name === "unknown" ? 0.35 : 0.9,
      source: result.source,
      metadata: {
        sources: spec.sources,
        resources: spec.resources,
        publicHeaders: spec.publicHeaders,
        ...(spec.deploymentTarget === undefined ? {} : { deploymentTarget: spec.deploymentTarget }),
      },
    });
    result.targets.push({
      id: toDiscoveryId("target", spec.name),
      name: spec.name,
      kind: "target",
      type: "module-spec",
      version: spec.version,
      path: spec.sources[0],
      confidence: spec.name === "unknown" ? 0.3 : 0.85,
      source: result.source,
    });
    for (const dependency of spec.dependencies) {
      result.dependencies.push({
        from: moduleId,
        to: toDiscoveryId("module", dependency),
        kind: "depends_on",
        confidence: 0.9,
        source: result.source,
      });
    }
    result.confidence = spec.name === "unknown" ? 0.35 : 0.9;
  } catch (error) {
    addEngineeringDiscoveryDiagnostic(
      result,
      "error",
      diagnosticMessage("Ruby module spec parse failed", error),
    );
  }
  return finalizeEngineeringDiscoveryResult(result);
}

export function extractRubyModuleSpec(content: string): RubyDslModuleSpec {
  return {
    name: extractSpecField(content, "name") ?? "unknown",
    version: extractSpecField(content, "version") ?? "0.0.0",
    sources: firstNonEmptyArray(
      extractSpecArrayOrStringField(content, "source_files"),
      extractSpecArrayOrStringField(content, "sources"),
      extractSpecArrayOrStringField(content, "source"),
    ),
    resources: firstNonEmptyArray(
      extractSpecArrayOrStringField(content, "resources"),
      extractSpecArrayOrStringField(content, "resource"),
      extractResourceBundleValues(content),
    ),
    dependencies: extractSpecDependencies(content),
    publicHeaders: firstNonEmptyArray(
      extractSpecArrayOrStringField(content, "public_headers"),
      extractSpecArrayOrStringField(content, "public_header_files"),
    ),
    ...(extractSpecDeploymentTarget(content) === undefined
      ? {}
      : { deploymentTarget: extractSpecDeploymentTarget(content) }),
  };
}

function boxToEntity(
  box: RubyBoxDeclaration,
  layer: string | undefined,
  source: EngineeringDiscoveryEntity["source"],
): EngineeringDiscoveryEntity {
  return {
    id: toDiscoveryId("module", box.name),
    name: box.name,
    kind: "module",
    version: box.version ?? "",
    path: box.localPath,
    local: box.localPath !== undefined,
    layer,
    group: box.group,
    confidence: 0.85,
    source,
  };
}

function extractLayerBlocks(content: string): RubyLayerBlock[] {
  const blocks: RubyLayerBlock[] = [];
  const layerRe = /layer\s+['"]([^'"]+)['"]\s+do\b/g;
  let match = layerRe.exec(content);
  while (match !== null) {
    const name = match[1];
    if (!name) {
      match = layerRe.exec(content);
      continue;
    }
    const bodyStart = match.index + match[0].length;
    const endIndex = findMatchingRubyEnd(content, bodyStart);
    if (endIndex === -1) {
      match = layerRe.exec(content);
      continue;
    }
    blocks.push({
      name,
      body: content.substring(bodyStart, endIndex),
      startIndex: match.index,
      endIndex: endIndex + 3,
    });
    match = layerRe.exec(content);
  }
  return blocks;
}

function findMatchingRubyEnd(content: string, startPos: number): number {
  let depth = 1;
  let position = startPos;
  for (const line of content.substring(startPos).split("\n")) {
    const code = stripRubyComment(line).trim();
    if (code.length === 0) {
      position += line.length + 1;
      continue;
    }
    if (/\bdo\b\s*$/.test(code) || /\{\s*$/.test(code)) {
      depth += 1;
    }
    if (/^end\b/.test(code) || /^\}/.test(code)) {
      depth -= 1;
      if (depth === 0) {
        return position;
      }
    }
    position += line.length + 1;
  }
  return -1;
}

function removeLayerBlocks(content: string): string {
  const blocks = extractLayerBlocks(content);
  if (blocks.length === 0) {
    return content;
  }
  let result = "";
  let lastEnd = 0;
  for (const block of blocks) {
    result += content.substring(lastEnd, block.startIndex);
    lastEnd = block.endIndex;
  }
  return result + content.substring(lastEnd);
}

function extractBoxDeclarations(content: string): RubyBoxDeclaration[] {
  const modules: RubyBoxDeclaration[] = [];
  const seen = new Set<string>();
  const groupStack: string[] = [];
  for (const line of content.split("\n")) {
    const code = stripRubyComment(line).trim();
    if (code.length === 0) {
      continue;
    }
    const groupMatch = code.match(/^group\s+['"]([^'"]+)['"]\s+do\b/);
    if (groupMatch?.[1]) {
      groupStack.push(groupMatch[1]);
      continue;
    }
    if (/^end\b/.test(code) && groupStack.length > 0) {
      groupStack.pop();
      continue;
    }
    const boxMatch = code.match(/^(?:box|pod|dependency)\s+['"]([^'"]+)['"]/);
    if (!boxMatch?.[1] || seen.has(boxMatch[1])) {
      continue;
    }
    const name = boxMatch[1];
    seen.add(name);
    const rest = code.substring(boxMatch[0].length);
    const pathMatch = rest.match(/(?::path\s*=>|path:)\s*['"]([^'"]+)['"]/);
    const versionMatch = rest.match(/,\s*['"]([^'"]+)['"]/);
    modules.push({
      name,
      ...(versionMatch?.[1] && !versionMatch[1].includes("/") ? { version: versionMatch[1] } : {}),
      ...(pathMatch?.[1] ? { localPath: pathMatch[1] } : {}),
      ...(groupStack.at(-1) === undefined ? {} : { group: groupStack.at(-1) }),
    });
  }
  return modules;
}

function extractAccessLayers(content: string): string[] {
  const layers: string[] = [];
  const accessRe = /access\s+(.+)/g;
  let match = accessRe.exec(content);
  while (match !== null) {
    const rest = match[1] ?? "";
    const quoted = /['"]([^'"]+)['"]/g;
    let layerMatch = quoted.exec(rest);
    while (layerMatch !== null) {
      if (layerMatch[1] && !layers.includes(layerMatch[1])) {
        layers.push(layerMatch[1]);
      }
      layerMatch = quoted.exec(rest);
    }
    match = accessRe.exec(content);
  }
  return layers;
}

function extractQuotedDirectiveValues(content: string, directive: string): string[] {
  const values: string[] = [];
  const re = new RegExp(`^\\s*${directive}\\s+['"]([^'"]+)['"]`, "gm");
  let match = re.exec(content);
  while (match !== null) {
    if (match[1] && !values.includes(match[1])) {
      values.push(match[1]);
    }
    match = re.exec(content);
  }
  return values;
}

function extractSpecField(content: string, field: string): string | undefined {
  const match = content.match(new RegExp(`\\b\\w+\\.${field}\\s*=\\s*['"]([^'"]+)['"]`, "i"));
  return match?.[1];
}

function extractSpecDependencies(content: string): string[] {
  const deps: string[] = [];
  const re = /\b\w+\.dependency\s+['"]([^'"]+)['"]/g;
  let match = re.exec(content);
  while (match !== null) {
    if (match[1] && !deps.includes(match[1])) {
      deps.push(match[1]);
    }
    match = re.exec(content);
  }
  return deps;
}

function extractSpecArrayOrStringField(content: string, field: string): string[] {
  const arrayMatch = content.match(new RegExp(`\\b\\w+\\.${field}\\s*=\\s*\\[([^\\]]+)\\]`, "is"));
  if (arrayMatch?.[1]) {
    return extractQuotedValues(arrayMatch[1]);
  }
  const stringMatch = content.match(new RegExp(`\\b\\w+\\.${field}\\s*=\\s*['"]([^'"]+)['"]`, "i"));
  return stringMatch?.[1] ? [stringMatch[1]] : [];
}

function extractResourceBundleValues(content: string): string[] {
  const match = content.match(/\b\w+\.resource_bundles\s*=\s*\{([\s\S]*?)\}/);
  return match?.[1] ? extractQuotedValues(match[1]) : [];
}

function extractQuotedValues(content: string): string[] {
  const values: string[] = [];
  const itemRe = /['"]([^'"]+)['"]/g;
  let match = itemRe.exec(content);
  while (match !== null) {
    if (match[1]) {
      values.push(match[1]);
    }
    match = itemRe.exec(content);
  }
  return values;
}

function extractSpecDeploymentTarget(content: string): string | undefined {
  return content.match(/\b\w+\.ios\.deployment_target\s*=\s*['"]([^'"]+)['"]/)?.[1];
}

function firstNonEmptyArray(...values: readonly string[][]): string[] {
  return values.find((value) => value.length > 0) ?? [];
}

function stripRubyComment(line: string): string {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === "'" || char === '"') && line[index - 1] !== "\\") {
      quote = quote === char ? null : (quote ?? char);
    }
    if (char === "#" && quote === null) {
      return line.slice(0, index);
    }
  }
  return line;
}

function diagnosticMessage(prefix: string, error: unknown): string {
  return error instanceof Error ? `${prefix}: ${error.message}` : prefix;
}
