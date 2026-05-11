import type { EngineeringDependencyGraph } from "../foundation/types.js";
import type { EngineeringPanoramaSnapshot } from "../panorama/types.js";

export function dependencyAdjacency(
  dependencyGraph: EngineeringDependencyGraph,
  ref?: string,
): readonly unknown[] {
  const nodeIds = dependencyGraph.nodes.map((node) => (typeof node === "string" ? node : node.id));
  const selected = ref ? nodeIds.filter((nodeId) => nodeMatchesRef(nodeId, ref)) : nodeIds;
  return selected.sort().map((nodeId) => ({
    node: nodeId,
    dependencies: dependencyGraph.edges
      .filter((edge) => edge.from === nodeId)
      .sort(compareDependencyEdge),
    dependents: dependencyGraph.edges
      .filter((edge) => edge.to === nodeId)
      .sort(compareDependencyEdge),
  }));
}

export function dependencyCycles(
  dependencyGraph: EngineeringDependencyGraph,
  panorama: EngineeringPanoramaSnapshot | null,
  ref?: string,
): readonly unknown[] {
  const panoramaCycles =
    panorama?.cycles.map((cycle) => ({
      kind: "module",
      nodes: cycle.cycle,
      severity: cycle.severity,
    })) ?? [];
  const graphCycles = findDependencyCycles(dependencyGraph).map((cycle) => ({
    kind: "dependency",
    nodes: cycle,
    severity: "warning",
  }));
  return [...panoramaCycles, ...graphCycles]
    .filter((cycle) => !ref || cycle.nodes.some((node) => nodeMatchesRef(node, ref)))
    .sort((left, right) => left.nodes.join("\0").localeCompare(right.nodes.join("\0")));
}

function findDependencyCycles(dependencyGraph: EngineeringDependencyGraph): readonly string[][] {
  const adjacency = new Map<string, string[]>();
  for (const edge of dependencyGraph.edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to].sort());
  }
  const cycles = new Map<string, string[]>();
  for (const start of [...adjacency.keys()].sort()) {
    visitCycle(start, start, adjacency, [], cycles);
  }
  return [...cycles.values()].sort((left, right) =>
    left.join("\0").localeCompare(right.join("\0")),
  );
}

function visitCycle(
  start: string,
  current: string,
  adjacency: ReadonlyMap<string, readonly string[]>,
  path: readonly string[],
  cycles: Map<string, string[]>,
): void {
  if (path.includes(current)) {
    return;
  }
  const nextPath = [...path, current];
  for (const next of adjacency.get(current) ?? []) {
    if (next === start && nextPath.length > 1) {
      const cycle = canonicalCycle(nextPath);
      cycles.set(cycle.join("\0"), cycle);
      continue;
    }
    if (nextPath.length < 12) {
      visitCycle(start, next, adjacency, nextPath, cycles);
    }
  }
}

function canonicalCycle(cycle: readonly string[]): string[] {
  const rotations = cycle.map((_, index) => [...cycle.slice(index), ...cycle.slice(0, index)]);
  return rotations.sort((left, right) => left.join("\0").localeCompare(right.join("\0")))[0] ?? [];
}

function compareDependencyEdge(
  left: EngineeringDependencyGraph["edges"][number],
  right: EngineeringDependencyGraph["edges"][number],
): number {
  return (
    left.from.localeCompare(right.from) ||
    left.to.localeCompare(right.to) ||
    left.type.localeCompare(right.type)
  );
}

function nodeMatchesRef(nodeId: string, ref: string): boolean {
  const clean = ref.startsWith("file:") ? ref.slice("file:".length) : ref;
  return nodeId === ref || nodeId === clean || nodeId.endsWith(`:${clean}`);
}
