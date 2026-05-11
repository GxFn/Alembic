import type { EngineeringDependencyNode } from "../foundation/types.js";
import { isExternalEngineeringDependencyNode } from "../foundation/types.js";
import type {
  EngineeringCandidateRelation,
  EngineeringEntity,
  EngineeringEntityEdge,
  EngineeringEntityPath,
  EngineeringEntityRelation,
  EngineeringEntityType,
  EngineeringHotNode,
} from "./types.js";

export const entityTypes: readonly EngineeringEntityType[] = [
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

export function targetId(name: string): string {
  return `target:${name}`;
}

export function fileId(path: string): string {
  return `file:${path}`;
}

export function moduleId(name: string): string {
  return `module:${name}`;
}

export function classId(name: string): string {
  return `class:${name}`;
}

export function protocolId(name: string): string {
  return `protocol:${name}`;
}

export function categoryId(name: string): string {
  return `category:${name}`;
}

export function methodId(owner: string, name: string): string {
  return `method:${owner}.${name}`;
}

export function propertyId(owner: string, name: string): string {
  return `property:${owner}.${name}`;
}

export function patternId(name: string): string {
  return name.startsWith("pattern:") ? name : `pattern:${name}`;
}

export function recipeId(name: string): string {
  return name.startsWith("recipe:") ? name : `recipe:${name}`;
}

export function dependencyEntityType(node: EngineeringDependencyNode): EngineeringEntityType {
  return isExternalEngineeringDependencyNode(node) ? "external" : "module";
}

export function matchesRelation(
  edge: EngineeringEntityEdge,
  relation: EngineeringEntityRelation | undefined,
): boolean {
  return relation === undefined || edge.relation === relation;
}

export function countEdgesByRelation(
  edges: readonly EngineeringEntityEdge[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const edge of edges) {
    counts[edge.relation] = (counts[edge.relation] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function normalizedPathSet(paths: readonly string[]): ReadonlySet<string> {
  return new Set(paths.map((path) => path.trim()).filter(Boolean));
}

export function entityBelongsToFiles(
  entity: EngineeringEntity,
  paths: ReadonlySet<string>,
): boolean {
  return (
    (entity.filePath !== null && paths.has(entity.filePath)) ||
    (entity.type === "file" && paths.has(entity.id.replace(/^file:/, "")))
  );
}

export function edgeBelongsToFiles(
  edge: EngineeringEntityEdge,
  entities: ReadonlyMap<string, EngineeringEntity>,
  paths: ReadonlySet<string>,
): boolean {
  const from = entities.get(edge.from);
  const to = entities.get(edge.to);
  return (
    metadataReferencesFile(edge.metadata, paths) ||
    (from !== undefined && entityBelongsToFiles(from, paths)) ||
    (to !== undefined && entityBelongsToFiles(to, paths))
  );
}

export function isNonEmptyString(value: string | null): value is string {
  return typeof value === "string" && value.length > 0;
}

export function stringMetadata(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function firstString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function codeReferenceEntityId(ref: string, fallbackType: EngineeringEntityType): string {
  const clean = extractCodeEntityRef(ref);
  if (!clean) {
    return "";
  }
  return hasEntityPrefix(clean) ? clean : `${fallbackType}:${clean}`;
}

export function extractCodeEntityRef(ref: string): string {
  const clean = ref.trim();
  if (!clean) {
    return "";
  }
  const separator = clean.lastIndexOf("::");
  if (separator >= 0 && separator < clean.length - 2) {
    return clean.slice(separator + 2).trim();
  }
  return clean;
}

export function filePathFromCodeReference(ref: string): string | null {
  const clean = ref.trim();
  const separator = clean.lastIndexOf("::");
  if (separator <= 0) {
    return null;
  }
  return clean.slice(0, separator);
}

export function hasEntityPrefix(value: string): boolean {
  return entityTypes.some((type) => value.startsWith(`${type}:`));
}

export function entityTypeFromId(id: string): EngineeringEntityType | null {
  return entityTypes.find((type) => id.startsWith(`${type}:`)) ?? null;
}

export function entityNameFromId(id: string): string {
  const type = entityTypeFromId(id);
  return type ? id.slice(type.length + 1) : id;
}

export function flattenCandidateRelations(
  relations: unknown,
): readonly EngineeringCandidateRelation[] {
  if (!relations) {
    return [];
  }
  if (hasToFlatArray(relations)) {
    return flattenCandidateRelations(relations.toFlatArray());
  }
  if (Array.isArray(relations)) {
    return relations.flatMap((relation) => relationFromUnknown(relation, null));
  }
  if (isRecord(relations)) {
    const flattened: EngineeringCandidateRelation[] = [];
    for (const [type, list] of Object.entries(relations)) {
      for (const item of Array.isArray(list) ? list : [list]) {
        flattened.push(...relationFromUnknown(item, type));
      }
    }
    return flattened;
  }
  return [];
}

export function mapCandidateRelationType(type: string): string {
  const mapping: Readonly<Record<string, string>> = {
    inherits: "inherits",
    implements: "conforms",
    calls: "calls",
    depends_on: "depends_on",
    data_flow: "data_flow",
    conflicts: "conflicts",
    extends: "extends",
    related: "related",
    alternative: "related",
    prerequisite: "depends_on",
    deprecated_by: "related",
    solves: "related",
    enforces: "enforces",
    references: "references",
  };
  return mapping[type] ?? "related";
}

export function buildPath(
  from: string,
  to: string,
  previous: ReadonlyMap<string, EngineeringEntityEdge>,
): EngineeringEntityPath {
  const edges: EngineeringEntityEdge[] = [];
  let current = to;
  while (current !== from) {
    const edge = previous.get(current);
    if (!edge) {
      break;
    }
    edges.push(edge);
    current = edge.from;
  }
  edges.reverse();
  return {
    nodes: [from, ...edges.map((edge) => edge.to)],
    edges,
    distance: edges.length,
  };
}

export function connectedComponents(
  ids: readonly string[],
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): readonly (readonly string[])[] {
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const id of ids) {
    if (visited.has(id)) {
      continue;
    }
    const component: string[] = [];
    const stack = [id];
    visited.add(id);
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      component.push(current);
      for (const next of [...(adjacency.get(current) ?? [])].sort()) {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      }
    }
    components.push(component.sort());
  }
  return components.sort((left, right) => left[0]?.localeCompare(right[0] ?? "") ?? 0);
}

export function directedCycles(
  ids: readonly string[],
  edges: readonly EngineeringEntityEdge[],
): readonly (readonly string[])[] {
  const adjacency = new Map<string, string[]>();
  for (const id of ids) {
    adjacency.set(id, []);
  }
  for (const edge of edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to].sort());
  }

  const cycles = new Map<string, readonly string[]>();
  for (const start of ids) {
    visitCycle(start, start, adjacency, [], new Set(), cycles);
  }
  return [...cycles.values()].sort((left, right) =>
    left.join("\u0000").localeCompare(right.join("\u0000")),
  );
}

export function zeroHotNode(id: string): EngineeringHotNode {
  return { id, degree: 0, fanIn: 0, fanOut: 0, weightedDegree: 0 };
}

export function edgeKey(from: string, to: string, relation: EngineeringEntityRelation): string {
  return `${from}\u0000${to}\u0000${relation}`;
}

export function compareEntities(left: EngineeringEntity, right: EngineeringEntity): number {
  return left.id.localeCompare(right.id);
}

export function compareEdges(left: EngineeringEntityEdge, right: EngineeringEntityEdge): number {
  return (
    left.from.localeCompare(right.from) ||
    left.to.localeCompare(right.to) ||
    left.relation.localeCompare(right.relation)
  );
}

export function roundWeight(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function metadataReferencesFile(
  metadata: Readonly<Record<string, unknown>>,
  paths: ReadonlySet<string>,
): boolean {
  for (const key of ["file", "filePath", "path", "sourceFile"]) {
    const value = metadata[key];
    if (typeof value === "string" && paths.has(value)) {
      return true;
    }
  }
  return false;
}

function relationFromUnknown(
  value: unknown,
  fallbackType: string | null,
): EngineeringCandidateRelation[] {
  if (typeof value === "string" && fallbackType) {
    return [{ type: fallbackType, target: value }];
  }
  if (!isRecord(value)) {
    return [];
  }
  const type = firstString(value.type, fallbackType);
  const target = firstString(value.target, value.id, value.title);
  if (!type || !target) {
    return [];
  }
  const description = firstString(value.description);
  return [
    {
      type,
      target,
      ...(description ? { description } : {}),
    },
  ];
}

function hasToFlatArray(value: unknown): value is { toFlatArray: () => unknown } {
  return isRecord(value) && typeof value.toFlatArray === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function visitCycle(
  start: string,
  current: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
  path: readonly string[],
  seen: ReadonlySet<string>,
  cycles: Map<string, readonly string[]>,
): void {
  if (path.length > 24) {
    return;
  }
  const nextPath = [...path, current];
  const nextSeen = new Set(seen);
  nextSeen.add(current);
  for (const next of adjacency.get(current) ?? []) {
    if (next === start && nextPath.length > 1) {
      const cycle = canonicalCycle(nextPath);
      cycles.set(cycle.join("\u0000"), cycle);
    } else if (!nextSeen.has(next)) {
      visitCycle(start, next, adjacency, nextPath, nextSeen, cycles);
    }
  }
}

function canonicalCycle(cycle: readonly string[]): readonly string[] {
  const rotations = cycle.map((_, index) => [...cycle.slice(index), ...cycle.slice(0, index)]);
  return (
    rotations.sort((left, right) => left.join("\u0000").localeCompare(right.join("\u0000")))[0] ??
    []
  );
}
