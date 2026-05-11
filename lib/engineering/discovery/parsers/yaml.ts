import yaml from "js-yaml";
import {
  addEngineeringDiscoveryDiagnostic,
  asRecord,
  asStringArray,
  createEngineeringDiscoveryResult,
  type EngineeringDiscoveryParseInput,
  type EngineeringDiscoveryParseResult,
  finalizeEngineeringDiscoveryResult,
  objectKeys,
  toDiscoveryId,
} from "./types.js";

const XCODEGEN_TARGET_LAYERS: Readonly<Record<string, string>> = {
  application: "App",
  "app-extension": "Extension",
  framework: "Framework",
  "static-library": "Library",
  "dynamic-library": "Library",
  bundle: "Resource",
  "unit-test": "Test",
  "ui-test": "Test",
  tool: "Tool",
};

export function parseYamlDiscoveryFile(
  input: EngineeringDiscoveryParseInput,
): EngineeringDiscoveryParseResult {
  const result = createEngineeringDiscoveryResult("yaml-config", input, "yaml");
  let doc: unknown;
  try {
    doc = yaml.load(input.content, { schema: yaml.CORE_SCHEMA });
  } catch (error) {
    addEngineeringDiscoveryDiagnostic(result, "error", yamlDiagnosticMessage(error), result.source);
    return finalizeEngineeringDiscoveryResult(result);
  }

  const record = asRecord(doc);
  if (record === null) {
    addEngineeringDiscoveryDiagnostic(result, "warning", "YAML document is empty or not a mapping");
    return finalizeEngineeringDiscoveryResult(result);
  }

  const filePath = input.filePath ?? "";
  if (isXcodeGenProject(record)) {
    parseXcodeGen(record, result);
  } else if (/melos\.ya?ml$/i.test(filePath) || isMelosConfig(record)) {
    parseMelos(record, result);
  } else if (/pnpm-workspace\.ya?ml$/i.test(filePath)) {
    parseWorkspaceYaml(record, "pnpm", result);
  } else if (isFlutterPubspec(record)) {
    parsePubspec(record, result);
  } else if (isKubernetesResource(record)) {
    parseKubernetesResource(record, result);
  } else {
    parseGenericYaml(record, result);
  }

  return finalizeEngineeringDiscoveryResult(result);
}

function parseXcodeGen(
  record: Record<string, unknown>,
  result: ReturnType<typeof createEngineeringDiscoveryResult>,
): void {
  const name = stringValue(record.name);
  if (name) {
    result.projects.push({
      id: toDiscoveryId("project", name),
      name,
      kind: "project",
      type: "xcodegen",
      confidence: 0.9,
      source: result.source,
    });
  }

  const targets = asRecord(record.targets);
  const layerOrder = new Map<string, number>();
  if (targets !== null) {
    for (const [targetName, targetValue] of Object.entries(targets)) {
      const target = asRecord(targetValue) ?? {};
      const targetType = stringValue(target.type) ?? "framework";
      const layer = XCODEGEN_TARGET_LAYERS[targetType] ?? "Other";
      if (!layerOrder.has(layer)) {
        layerOrder.set(layer, layerOrder.size);
        result.layers.push({
          name: layer,
          order: layerOrder.get(layer) ?? 0,
          accessibleLayers: [],
          source: result.source,
        });
      }
      const sourcePath = firstSourcePath(target.sources);
      result.targets.push({
        id: toDiscoveryId("target", targetName),
        name: targetName,
        kind: "target",
        type: targetType,
        language: "swift",
        path: sourcePath,
        layer,
        local: true,
        confidence: 0.9,
        source: result.source,
        metadata: {
          platform: target.platform,
          deploymentTarget: target.deploymentTarget,
        },
      });
      result.modules.push({
        id: toDiscoveryId("module", targetName),
        name: targetName,
        kind: "module",
        type: targetType,
        path: sourcePath,
        layer,
        local: true,
        confidence: 0.85,
        source: result.source,
      });
      for (const dependency of xcodeGenDependencies(target.dependencies)) {
        result.dependencies.push({
          from: toDiscoveryId("target", targetName),
          to: toDiscoveryId(dependency.kind === "target" ? "target" : "package", dependency.name),
          kind: dependency.kind,
          confidence: 0.9,
          source: result.source,
        });
      }
    }
  }

  const packages = asRecord(record.packages);
  if (packages !== null) {
    for (const [packageName, packageValue] of Object.entries(packages)) {
      const pkg = asRecord(packageValue) ?? {};
      result.packages.push({
        id: toDiscoveryId("package", packageName),
        name: packageName,
        kind: "package",
        type: "swift-package",
        version: stringValue(pkg.from) ?? stringValue(pkg.version) ?? stringValue(pkg.branch),
        path: stringValue(pkg.path),
        local: typeof pkg.path === "string",
        confidence: 0.85,
        source: result.source,
        metadata: {
          url: pkg.url,
          revision: pkg.revision,
        },
      });
    }
  }

  for (const includePath of extractYamlIncludePaths(record.include)) {
    result.dependencies.push({
      from: name ? toDiscoveryId("project", name) : toDiscoveryId("workspace", "xcodegen"),
      to: includePath,
      kind: "includes",
      confidence: 0.75,
      source: result.source,
    });
  }
  result.confidence = 0.92;
}

function parseMelos(
  record: Record<string, unknown>,
  result: ReturnType<typeof createEngineeringDiscoveryResult>,
): void {
  const name = stringValue(record.name) ?? "melos-workspace";
  result.projects.push({
    id: toDiscoveryId("project", name),
    name,
    kind: "project",
    type: "melos",
    language: "dart",
    confidence: 0.9,
    source: result.source,
  });
  for (const pattern of asStringArray(record.packages)) {
    result.modules.push({
      id: toDiscoveryId("module-glob", pattern),
      name: pattern,
      kind: "module",
      type: "melos-package-glob",
      path: pattern,
      language: "dart",
      confidence: 0.8,
      source: result.source,
    });
    result.dependencies.push({
      from: toDiscoveryId("project", name),
      to: toDiscoveryId("module-glob", pattern),
      kind: "workspace",
      confidence: 0.8,
      source: result.source,
    });
  }
  for (const scriptName of objectKeys(record.scripts)) {
    result.packages.push({
      id: toDiscoveryId("resource", `script:${scriptName}`),
      name: scriptName,
      kind: "resource",
      type: "melos-script",
      confidence: 0.55,
      source: result.source,
    });
  }
  result.confidence = 0.9;
}

function parseWorkspaceYaml(
  record: Record<string, unknown>,
  workspaceType: string,
  result: ReturnType<typeof createEngineeringDiscoveryResult>,
): void {
  result.projects.push({
    id: toDiscoveryId("workspace", workspaceType),
    name: workspaceType,
    kind: "workspace",
    type: `${workspaceType}-workspace`,
    confidence: 0.85,
    source: result.source,
  });
  for (const pattern of asStringArray(record.packages).concat(asStringArray(record.workspaces))) {
    result.modules.push({
      id: toDiscoveryId("module-glob", pattern),
      name: pattern,
      kind: "module",
      path: pattern,
      type: `${workspaceType}-workspace-glob`,
      confidence: 0.8,
      source: result.source,
    });
  }
  result.confidence = 0.85;
}

function parsePubspec(
  record: Record<string, unknown>,
  result: ReturnType<typeof createEngineeringDiscoveryResult>,
): void {
  const name = stringValue(record.name) ?? "pubspec";
  result.projects.push({
    id: toDiscoveryId("project", name),
    name,
    kind: "project",
    type: record.flutter === undefined ? "dart-package" : "flutter-package",
    language: "dart",
    confidence: 0.85,
    source: result.source,
  });
  for (const depName of objectKeys(record.dependencies).concat(
    objectKeys(record.dev_dependencies),
  )) {
    if (depName === "flutter") {
      continue;
    }
    result.packages.push({
      id: toDiscoveryId("package", depName),
      name: depName,
      kind: "package",
      type: "pub-package",
      confidence: 0.7,
      source: result.source,
    });
    result.dependencies.push({
      from: toDiscoveryId("project", name),
      to: toDiscoveryId("package", depName),
      kind: "package",
      confidence: 0.8,
      source: result.source,
    });
  }
  result.confidence = 0.82;
}

function parseKubernetesResource(
  record: Record<string, unknown>,
  result: ReturnType<typeof createEngineeringDiscoveryResult>,
): void {
  const kind = stringValue(record.kind) ?? "KubernetesResource";
  const metadata = asRecord(record.metadata);
  const name = stringValue(metadata?.name) ?? kind;
  result.modules.push({
    id: toDiscoveryId("resource", `${kind}/${name}`),
    name,
    kind: "resource",
    type: kind,
    confidence: 0.75,
    source: result.source,
    metadata: { apiVersion: record.apiVersion },
  });
  for (const image of extractContainerImages(record)) {
    result.packages.push({
      id: toDiscoveryId("package", image),
      name: image,
      kind: "package",
      type: "container-image",
      confidence: 0.65,
      source: result.source,
    });
  }
  result.confidence = 0.75;
}

function parseGenericYaml(
  record: Record<string, unknown>,
  result: ReturnType<typeof createEngineeringDiscoveryResult>,
): void {
  const name = stringValue(record.name) ?? stringValue(asRecord(record.metadata)?.name);
  if (name) {
    result.projects.push({
      id: toDiscoveryId("project", name),
      name,
      kind: "project",
      type: "yaml-config",
      confidence: 0.45,
      source: result.source,
    });
  }
  for (const depName of objectKeys(record.dependencies)) {
    result.packages.push({
      id: toDiscoveryId("package", depName),
      name: depName,
      kind: "package",
      confidence: 0.45,
      source: result.source,
    });
  }
  result.confidence = result.projects.length + result.packages.length > 0 ? 0.45 : 0.2;
}

function isXcodeGenProject(record: Record<string, unknown>): boolean {
  const targets = asRecord(record.targets);
  return (
    targets !== null &&
    (record.options !== undefined ||
      record.schemes !== undefined ||
      record.packages !== undefined ||
      Object.values(targets).some(isXcodeGenTargetLike))
  );
}

function isXcodeGenTargetLike(value: unknown): boolean {
  const target = asRecord(value);
  return (
    target !== null &&
    (target.type !== undefined || target.sources !== undefined || target.dependencies !== undefined)
  );
}

function isMelosConfig(record: Record<string, unknown>): boolean {
  return (
    Array.isArray(record.packages) &&
    (record.command !== undefined || record.scripts !== undefined || record.ide !== undefined)
  );
}

function isFlutterPubspec(record: Record<string, unknown>): boolean {
  return (
    typeof record.name === "string" &&
    (record.environment !== undefined || record.flutter !== undefined) &&
    record.dependencies !== undefined
  );
}

function isKubernetesResource(record: Record<string, unknown>): boolean {
  return (
    typeof record.apiVersion === "string" &&
    typeof record.kind === "string" &&
    asRecord(record.metadata) !== null
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstSourcePath(value: unknown): string | undefined {
  const sources = Array.isArray(value) ? value : [];
  for (const source of sources) {
    if (typeof source === "string") {
      return source;
    }
    const sourceRecord = asRecord(source);
    const path = stringValue(sourceRecord?.path);
    if (path) {
      return path;
    }
  }
  return undefined;
}

function xcodeGenDependencies(
  value: unknown,
): Array<{ readonly name: string; readonly kind: "target" | "package" }> {
  const dependencies = Array.isArray(value) ? value : [];
  const extracted: Array<{ readonly name: string; readonly kind: "target" | "package" }> = [];
  for (const dependency of dependencies) {
    if (typeof dependency === "string") {
      extracted.push({ name: dependency, kind: "target" });
      continue;
    }
    const record = asRecord(dependency);
    const target = stringValue(record?.target);
    const packageName = stringValue(record?.package);
    const framework = stringValue(record?.framework);
    const carthage = stringValue(record?.carthage);
    if (target) {
      extracted.push({ name: target, kind: "target" });
    } else if (packageName ?? framework ?? carthage) {
      extracted.push({ name: packageName ?? framework ?? carthage ?? "", kind: "package" });
    }
  }
  return extracted.filter((dependency) => dependency.name.length > 0);
}

function extractYamlIncludePaths(value: unknown): string[] {
  const includes = Array.isArray(value) ? value : [];
  return includes.flatMap((include) => {
    if (typeof include === "string") {
      return [include];
    }
    const path = stringValue(asRecord(include)?.path);
    return path === undefined ? [] : [path];
  });
}

function extractContainerImages(record: Record<string, unknown>): string[] {
  const spec = asRecord(record.spec);
  const templateSpec = asRecord(asRecord(asRecord(spec?.template)?.spec));
  const directContainers = Array.isArray(spec?.containers) ? spec?.containers : [];
  const templateContainers = Array.isArray(templateSpec?.containers)
    ? templateSpec?.containers
    : [];
  return [...directContainers, ...templateContainers].flatMap((container) => {
    const image = stringValue(asRecord(container)?.image);
    return image === undefined ? [] : [image];
  });
}

function yamlDiagnosticMessage(error: unknown): string {
  return error instanceof Error ? `YAML parse failed: ${error.message}` : "YAML parse failed";
}
