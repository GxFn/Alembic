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

export function parseJsonDiscoveryFile(
  input: EngineeringDiscoveryParseInput,
): EngineeringDiscoveryParseResult {
  const result = createEngineeringDiscoveryResult("json-config", input, "json");
  let json: unknown;
  try {
    json = JSON.parse(input.content);
  } catch (error) {
    addEngineeringDiscoveryDiagnostic(result, "error", jsonDiagnosticMessage(error));
    return finalizeEngineeringDiscoveryResult(result);
  }

  const record = asRecord(json);
  if (record === null) {
    addEngineeringDiscoveryDiagnostic(result, "warning", "JSON document is not an object");
    return finalizeEngineeringDiscoveryResult(result);
  }

  const filePath = input.filePath ?? "";
  if (/package\.json$/i.test(filePath) || isPackageJson(record)) {
    parsePackageJson(record, result);
  } else if (/tsconfig(?:\.[^.]+)?\.json$/i.test(filePath) || Array.isArray(record.references)) {
    parseTsConfig(record, result);
  } else if (/project\.json$/i.test(filePath) || isNxProject(record)) {
    parseNxProjectJson(record, result);
  } else if (/nx\.json$/i.test(filePath) || asRecord(record.projects) !== null) {
    parseNxWorkspaceJson(record, result);
  } else {
    parseGenericJson(record, result);
  }

  return finalizeEngineeringDiscoveryResult(result);
}

function parsePackageJson(
  record: Record<string, unknown>,
  result: ReturnType<typeof createEngineeringDiscoveryResult>,
): void {
  const name = stringValue(record.name) ?? "package";
  result.projects.push({
    id: toDiscoveryId("project", name),
    name,
    kind: "project",
    type: "node-package",
    version: stringValue(record.version),
    language: "typescript",
    confidence: 0.85,
    source: result.source,
  });
  result.modules.push({
    id: toDiscoveryId("module", name),
    name,
    kind: "module",
    type: "node-package",
    version: stringValue(record.version),
    language: "typescript",
    confidence: 0.8,
    source: result.source,
  });

  for (const pattern of packageWorkspacePatterns(record.workspaces)) {
    result.modules.push({
      id: toDiscoveryId("module-glob", pattern),
      name: pattern,
      kind: "module",
      type: "node-workspace-glob",
      path: pattern,
      language: "typescript",
      confidence: 0.82,
      source: result.source,
    });
    result.dependencies.push({
      from: toDiscoveryId("project", name),
      to: toDiscoveryId("module-glob", pattern),
      kind: "workspace",
      confidence: 0.82,
      source: result.source,
    });
  }

  const dependencyNames = [
    ...objectKeys(record.dependencies),
    ...objectKeys(record.devDependencies),
    ...objectKeys(record.peerDependencies),
    ...objectKeys(record.optionalDependencies),
  ];
  for (const dependencyName of new Set(dependencyNames)) {
    result.packages.push({
      id: toDiscoveryId("package", dependencyName),
      name: dependencyName,
      kind: "package",
      type: "npm-package",
      confidence: 0.7,
      source: result.source,
    });
    result.dependencies.push({
      from: toDiscoveryId("module", name),
      to: toDiscoveryId("package", dependencyName),
      kind: "package",
      confidence: 0.75,
      source: result.source,
    });
  }
  result.confidence = 0.86;
}

function parseTsConfig(
  record: Record<string, unknown>,
  result: ReturnType<typeof createEngineeringDiscoveryResult>,
): void {
  const compilerOptions = asRecord(record.compilerOptions);
  const baseUrl = stringValue(compilerOptions?.baseUrl);
  const projectName = "tsconfig";
  result.projects.push({
    id: toDiscoveryId("project", projectName),
    name: projectName,
    kind: "project",
    type: "typescript-config",
    language: "typescript",
    path: baseUrl,
    confidence: 0.75,
    source: result.source,
  });
  for (const reference of tsConfigReferences(record.references)) {
    result.modules.push({
      id: toDiscoveryId("module", reference),
      name: reference,
      kind: "module",
      type: "typescript-project-reference",
      path: reference,
      language: "typescript",
      confidence: 0.86,
      source: result.source,
    });
    result.dependencies.push({
      from: toDiscoveryId("project", projectName),
      to: toDiscoveryId("module", reference),
      kind: "reference",
      confidence: 0.9,
      source: result.source,
    });
  }
  const paths = asRecord(compilerOptions?.paths);
  if (paths !== null) {
    for (const [alias, values] of Object.entries(paths)) {
      result.dependencies.push({
        from: toDiscoveryId("project", projectName),
        to: alias,
        kind: "includes",
        confidence: 0.65,
        source: result.source,
        metadata: { paths: asStringArray(values) },
      });
    }
  }
  result.confidence = 0.78;
}

function parseNxProjectJson(
  record: Record<string, unknown>,
  result: ReturnType<typeof createEngineeringDiscoveryResult>,
): void {
  const name = stringValue(record.name) ?? stringValue(record.root) ?? "nx-project";
  const root = stringValue(record.root) ?? stringValue(record.sourceRoot) ?? ".";
  const projectType = stringValue(record.projectType) ?? "library";
  result.projects.push({
    id: toDiscoveryId("project", name),
    name,
    kind: "project",
    type: "nx-project",
    path: root,
    language: "typescript",
    confidence: 0.9,
    source: result.source,
    metadata: { tags: asStringArray(record.tags), projectType },
  });
  result.targets.push({
    id: toDiscoveryId("target", name),
    name,
    kind: "target",
    type: projectType,
    path: root,
    language: "typescript",
    confidence: 0.9,
    source: result.source,
    metadata: { tags: asStringArray(record.tags), projectType },
  });
  result.modules.push({
    id: toDiscoveryId("module", name),
    name,
    kind: "module",
    type: projectType,
    path: root,
    language: "typescript",
    confidence: 0.88,
    source: result.source,
    metadata: { tags: asStringArray(record.tags), projectType },
  });

  for (const dependency of nxProjectDependencies(record)) {
    result.dependencies.push({
      from: toDiscoveryId("module", name),
      to: toDiscoveryId("module", dependency),
      kind: "depends_on",
      confidence: 0.8,
      source: result.source,
    });
  }
  result.confidence = 0.9;
}

function parseNxWorkspaceJson(
  record: Record<string, unknown>,
  result: ReturnType<typeof createEngineeringDiscoveryResult>,
): void {
  result.projects.push({
    id: toDiscoveryId("workspace", "nx"),
    name: "nx",
    kind: "workspace",
    type: "nx-workspace",
    confidence: 0.78,
    source: result.source,
  });
  const projects = asRecord(record.projects);
  if (projects !== null) {
    for (const [projectName, value] of Object.entries(projects)) {
      const project = asRecord(value);
      const path = typeof value === "string" ? value : stringValue(project?.root);
      result.modules.push({
        id: toDiscoveryId("module", projectName),
        name: projectName,
        kind: "module",
        type: "nx-project",
        path,
        language: "typescript",
        confidence: 0.75,
        source: result.source,
        metadata: { tags: asStringArray(project?.tags) },
      });
    }
  }
  result.confidence = 0.78;
}

function parseGenericJson(
  record: Record<string, unknown>,
  result: ReturnType<typeof createEngineeringDiscoveryResult>,
): void {
  const schema = stringValue(record.$schema);
  const name =
    stringValue(record.name) ?? (schema === undefined ? undefined : schema.split("/").at(-1));
  if (name) {
    result.projects.push({
      id: toDiscoveryId("project", name),
      name,
      kind: "project",
      type: "json-config",
      confidence: 0.42,
      source: result.source,
      metadata: { schema },
    });
  }
  for (const dependency of objectKeys(record.dependencies)) {
    result.packages.push({
      id: toDiscoveryId("package", dependency),
      name: dependency,
      kind: "package",
      confidence: 0.42,
      source: result.source,
    });
  }
  result.confidence = result.projects.length + result.packages.length > 0 ? 0.42 : 0.2;
}

function isPackageJson(record: Record<string, unknown>): boolean {
  return (
    typeof record.name === "string" &&
    (record.dependencies !== undefined ||
      record.scripts !== undefined ||
      record.workspaces !== undefined)
  );
}

function isNxProject(record: Record<string, unknown>): boolean {
  return (
    typeof record.name === "string" &&
    (record.projectType !== undefined ||
      record.sourceRoot !== undefined ||
      record.targets !== undefined)
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function packageWorkspacePatterns(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  const record = asRecord(value);
  return asStringArray(record?.packages);
}

function tsConfigReferences(value: unknown): string[] {
  const references = Array.isArray(value) ? value : [];
  return references.flatMap((reference) => {
    const path = stringValue(asRecord(reference)?.path);
    return path === undefined ? [] : [path];
  });
}

function nxProjectDependencies(record: Record<string, unknown>): string[] {
  const deps = new Set<string>();
  for (const dep of asStringArray(record.implicitDependencies).concat(
    asStringArray(record.dependsOn),
  )) {
    deps.add(dep);
  }
  const targets = asRecord(record.targets);
  if (targets !== null) {
    for (const target of Object.values(targets)) {
      const targetRecord = asRecord(target);
      for (const dep of asStringArray(targetRecord?.dependsOn)) {
        deps.add(dep.replace(/^projects:/, ""));
      }
    }
  }
  const metadataDeps = asStringArray(asRecord(record.metadata)?.dependencies);
  for (const dep of metadataDeps) {
    deps.add(dep);
  }
  return [...deps].filter((dep) => dep.length > 0);
}

function jsonDiagnosticMessage(error: unknown): string {
  return error instanceof Error ? `JSON parse failed: ${error.message}` : "JSON parse failed";
}
