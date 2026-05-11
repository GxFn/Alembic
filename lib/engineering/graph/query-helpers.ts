import type { EngineeringCodeCallGraphEdge } from "../code/types.js";
import type { EngineeringEntity, EngineeringEntityType } from "../entity/graph.js";
import { EngineeringEntityGraph } from "../entity/graph.js";
import type { EngineeringEntityGraphSnapshot } from "../workflow/types.js";

export function entityGraphFromSnapshot(
  snapshot: EngineeringEntityGraphSnapshot,
): EngineeringEntityGraph {
  const graph = new EngineeringEntityGraph();
  for (const entity of snapshot.entities) {
    graph.addEntity(entity);
  }
  for (const edge of snapshot.edges) {
    graph.addEdge(edge);
  }
  return graph;
}

export function callRelation(edge: EngineeringCodeCallGraphEdge, side: "caller" | "callee") {
  return {
    symbol: side === "caller" ? edge.caller : edge.callee,
    edge,
  };
}

export function entityCallRelation(reference: {
  readonly entity: EngineeringEntity;
  readonly edge: unknown;
  readonly depth: number;
  readonly callType: string;
}) {
  const fqn = reference.entity.metadata.fqn;
  return {
    symbol: typeof fqn === "string" && fqn.length > 0 ? fqn : reference.entity.name,
    entity: reference.entity,
    edge: reference.edge,
    depth: reference.depth,
    callType: reference.callType,
  };
}

export function dedupeCallRelations(values: readonly unknown[]): readonly unknown[] {
  return [
    ...new Map(
      values.map((value) => {
        const record = isRecord(value) ? value : {};
        const symbol = record.symbol;
        return [
          typeof symbol === "string" && symbol.length > 0 ? symbol : JSON.stringify(value),
          value,
        ];
      }),
    ).values(),
  ];
}

export function splitMethodRef(ref: string): readonly [string, string | null] {
  const separator = ref.includes("#") ? ref.lastIndexOf("#") : ref.lastIndexOf(".");
  if (separator <= 0 || separator >= ref.length - 1) {
    return [ref, null];
  }
  return [ref.slice(0, separator), ref.slice(separator + 1)];
}

export function entityIdCandidates(ref: string): readonly string[] {
  const clean = ref.trim();
  if (!clean) {
    return [];
  }
  if (entityTypes.some((type) => clean.startsWith(`${type}:`))) {
    return [clean];
  }
  const codeRef = extractCodeEntityRef(clean);
  return [
    `class:${clean}`,
    `protocol:${clean}`,
    `category:${clean}`,
    `method:${clean}`,
    ...(codeRef === clean ? [] : [`method:${codeRef}`]),
    `property:${clean}`,
    `symbol:${clean}`,
    `file:${clean}`,
    `module:file:${clean}`,
    `module:${clean}`,
    `target:${clean}`,
    `external:${clean}`,
    `pattern:${clean}`,
    `recipe:${clean}`,
  ];
}

export function isEntityType(value: string): value is EngineeringEntityType {
  return entityTypes.includes(value as EngineeringEntityType);
}

export function conformanceResult(
  classId: string,
  protocolId: string,
  edge: unknown,
  graph: EngineeringEntityGraph,
) {
  return {
    class: graph.findEntity(classId)?.name ?? cleanEntityName(classId),
    protocol: graph.findEntity(protocolId)?.name ?? cleanEntityName(protocolId),
    edge,
    source: "entity-graph",
  };
}

export function dedupeConformanceResults(values: readonly unknown[]): readonly unknown[] {
  const keyed = new Map<string, unknown>();
  for (const value of values) {
    if (!isRecord(value)) {
      keyed.set(JSON.stringify(value), value);
      continue;
    }
    const className = typeof value.class === "string" ? value.class : "";
    const protocolName = typeof value.protocol === "string" ? value.protocol : "";
    const key =
      className && protocolName ? `${className}\u0000${protocolName}` : JSON.stringify(value);
    if (!keyed.has(key) || value.source === "entity-graph") {
      keyed.set(key, value);
    }
  }
  return [...keyed.values()];
}

export function cleanEntityName(ref: string): string {
  const codeRef = extractCodeEntityRef(ref);
  const separator = codeRef.indexOf(":");
  return separator >= 0 ? codeRef.slice(separator + 1) : codeRef;
}

export function requiredRef(operation: string, ref: string | undefined): string {
  if (!ref) {
    throw new Error(`${operation} requires ref.`);
  }
  return ref;
}

export function requiredEntity(operation: string, entity: string | undefined): string {
  if (!entity) {
    throw new Error(`${operation} requires entity or ref.`);
  }
  return entity;
}

export function bounded(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  return Math.min(Math.max(0, Math.floor(value)), max);
}

export function countBy(values: readonly string[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

export function panoramaHealthScore(
  panorama: { readonly health: { readonly score: number } } | null,
): number | null {
  return panorama?.health.score ?? null;
}

function extractCodeEntityRef(ref: string): string {
  const separator = ref.lastIndexOf("::");
  if (separator >= 0 && separator < ref.length - 2) {
    return ref.slice(separator + 2).trim();
  }
  return ref;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const entityTypes: readonly EngineeringEntityType[] = [
  "file",
  "target",
  "module",
  "external",
  "class",
  "protocol",
  "category",
  "method",
  "property",
  "symbol",
  "pattern",
  "recipe",
];
