export type EngineeringDiscoveryParserKind =
  | "ruby-dsl"
  | "yaml-config"
  | "json-config"
  | "gradle-dsl"
  | "starlark"
  | "cmake";

export type EngineeringDiscoveryEntityKind =
  | "project"
  | "target"
  | "module"
  | "package"
  | "workspace"
  | "resource";

export type EngineeringDiscoveryDependencyKind =
  | "depends_on"
  | "workspace"
  | "target"
  | "package"
  | "reference"
  | "includes"
  | "uses";

export type EngineeringDiscoveryDiagnosticSeverity = "info" | "warning" | "error";

export interface EngineeringDiscoveryParseInput {
  readonly content: string;
  readonly filePath?: string;
  readonly parserHint?: string;
}

export interface EngineeringDiscoverySource {
  readonly filePath?: string | undefined;
  readonly parser: EngineeringDiscoveryParserKind;
  readonly format: string;
  readonly locator?: string | undefined;
}

export interface EngineeringDiscoveryDiagnostic {
  readonly severity: EngineeringDiscoveryDiagnosticSeverity;
  readonly message: string;
  readonly source?: EngineeringDiscoverySource | undefined;
}

export interface EngineeringDiscoveryEntity {
  readonly id: string;
  readonly name: string;
  readonly kind: EngineeringDiscoveryEntityKind;
  readonly path?: string | undefined;
  readonly version?: string | undefined;
  readonly type?: string | undefined;
  readonly language?: string | undefined;
  readonly layer?: string | undefined;
  readonly group?: string | undefined;
  readonly local?: boolean | undefined;
  readonly confidence: number;
  readonly source?: EngineeringDiscoverySource | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface EngineeringDiscoveryDependency {
  readonly from: string;
  readonly to: string;
  readonly kind: EngineeringDiscoveryDependencyKind;
  readonly scope?: string | undefined;
  readonly confidence: number;
  readonly source?: EngineeringDiscoverySource | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface EngineeringDiscoveryLayer {
  readonly name: string;
  readonly order: number;
  readonly accessibleLayers: readonly string[];
  readonly source?: EngineeringDiscoverySource | undefined;
}

export interface EngineeringDiscoveryParseResult {
  readonly parser: EngineeringDiscoveryParserKind;
  readonly confidence: number;
  readonly source?: EngineeringDiscoverySource | undefined;
  readonly projects: readonly EngineeringDiscoveryEntity[];
  readonly targets: readonly EngineeringDiscoveryEntity[];
  readonly modules: readonly EngineeringDiscoveryEntity[];
  readonly packages: readonly EngineeringDiscoveryEntity[];
  readonly layers: readonly EngineeringDiscoveryLayer[];
  readonly dependencies: readonly EngineeringDiscoveryDependency[];
  readonly diagnostics: readonly EngineeringDiscoveryDiagnostic[];
}

export interface MutableEngineeringDiscoveryParseResult {
  parser: EngineeringDiscoveryParserKind;
  confidence: number;
  source: EngineeringDiscoverySource;
  projects: EngineeringDiscoveryEntity[];
  targets: EngineeringDiscoveryEntity[];
  modules: EngineeringDiscoveryEntity[];
  packages: EngineeringDiscoveryEntity[];
  layers: EngineeringDiscoveryLayer[];
  dependencies: EngineeringDiscoveryDependency[];
  diagnostics: EngineeringDiscoveryDiagnostic[];
}

export function createEngineeringDiscoveryResult(
  parser: EngineeringDiscoveryParserKind,
  input: EngineeringDiscoveryParseInput,
  format: string,
): MutableEngineeringDiscoveryParseResult {
  const source = createEngineeringDiscoverySource(parser, input, format);
  return {
    parser,
    confidence: 0,
    source,
    projects: [],
    targets: [],
    modules: [],
    packages: [],
    layers: [],
    dependencies: [],
    diagnostics: [],
  };
}

export function createEngineeringDiscoverySource(
  parser: EngineeringDiscoveryParserKind,
  input: EngineeringDiscoveryParseInput,
  format: string,
  locator?: string,
): EngineeringDiscoverySource {
  const base: EngineeringDiscoverySource = {
    parser,
    format,
    ...(input.filePath === undefined ? {} : { filePath: input.filePath }),
    ...(locator === undefined ? {} : { locator }),
  };
  return base;
}

export function addEngineeringDiscoveryDiagnostic(
  result: MutableEngineeringDiscoveryParseResult,
  severity: EngineeringDiscoveryDiagnosticSeverity,
  message: string,
  source = result.source,
): void {
  result.diagnostics.push({
    severity,
    message,
    ...(source === undefined ? {} : { source }),
  });
}

export function finalizeEngineeringDiscoveryResult(
  result: MutableEngineeringDiscoveryParseResult,
): EngineeringDiscoveryParseResult {
  const projects = dedupeEntities(result.projects);
  const targets = dedupeEntities(result.targets);
  const modules = dedupeEntities(result.modules);
  const packages = dedupeEntities(result.packages);
  const dependencies = dedupeDependencies(result.dependencies);
  const signalCount =
    projects.length +
    targets.length +
    modules.length +
    packages.length +
    dependencies.length +
    result.layers.length;
  const hasErrors = result.diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const confidence =
    hasErrors && signalCount === 0
      ? 0
      : Math.max(result.confidence, Math.min(0.95, signalCount / 10));
  return {
    parser: result.parser,
    confidence,
    ...(result.source === undefined ? {} : { source: result.source }),
    projects,
    targets,
    modules,
    packages,
    layers: [...result.layers].sort(
      (left, right) => left.order - right.order || left.name.localeCompare(right.name),
    ),
    dependencies,
    diagnostics: [...result.diagnostics],
  };
}

export function toDiscoveryId(prefix: string, value: string): string {
  return `${prefix}:${value.trim()}`;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function objectKeys(value: unknown): string[] {
  const record = asRecord(value);
  return record === null ? [] : Object.keys(record);
}

function dedupeEntities(
  entities: readonly EngineeringDiscoveryEntity[],
): EngineeringDiscoveryEntity[] {
  return [...new Map(entities.map((entity) => [entity.id, entity])).values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

function dedupeDependencies(
  dependencies: readonly EngineeringDiscoveryDependency[],
): EngineeringDiscoveryDependency[] {
  const byKey = new Map<string, EngineeringDiscoveryDependency>();
  for (const dependency of dependencies) {
    if (!dependency.from || !dependency.to || dependency.from === dependency.to) {
      continue;
    }
    byKey.set(`${dependency.from}\u0000${dependency.to}\u0000${dependency.kind}`, dependency);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to) ||
      left.kind.localeCompare(right.kind),
  );
}
