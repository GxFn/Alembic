export interface EngineeringWeightedEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: string;
  readonly weight: number;
}

export interface EngineeringGraphCycle {
  readonly cycle: readonly string[];
  readonly severity: "warning" | "error";
}

export interface EngineeringFanMetrics {
  readonly fanIn: number;
  readonly fanOut: number;
  readonly weightedFanIn: number;
  readonly weightedFanOut: number;
}

export function mergeEngineeringWeightedEdges(
  edges: readonly EngineeringWeightedEdge[],
): EngineeringWeightedEdge[] {
  const byKey = new Map<string, EngineeringWeightedEdge>();
  for (const edge of edges) {
    if (!edge.from || !edge.to || edge.from === edge.to) {
      continue;
    }
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.relation}`;
    const current = byKey.get(key);
    byKey.set(key, {
      from: edge.from,
      to: edge.to,
      relation: edge.relation,
      weight: roundWeight((current?.weight ?? 0) + edge.weight),
    });
  }
  return [...byKey.values()].sort(compareEdges);
}

export function findEngineeringCycles(
  edges: readonly EngineeringWeightedEdge[],
  nodes: readonly string[] = [],
): EngineeringGraphCycle[] {
  const allNodes = new Set(nodes);
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    allNodes.add(edge.from);
    allNodes.add(edge.to);
    adjacency.set(edge.from, adjacency.get(edge.from) ?? new Set());
    adjacency.get(edge.from)?.add(edge.to);
  }
  for (const node of allNodes) {
    adjacency.set(node, adjacency.get(node) ?? new Set());
  }

  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const cycles: EngineeringGraphCycle[] = [];

  const visit = (node: string): void => {
    indices.set(node, index);
    lowlinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of [...(adjacency.get(node) ?? [])].sort()) {
      if (!indices.has(next)) {
        visit(next);
        lowlinks.set(node, Math.min(lowlinks.get(node) ?? 0, lowlinks.get(next) ?? 0));
      } else if (onStack.has(next)) {
        lowlinks.set(node, Math.min(lowlinks.get(node) ?? 0, indices.get(next) ?? 0));
      }
    }

    if (lowlinks.get(node) === indices.get(node)) {
      const component: string[] = [];
      let current: string | undefined;
      do {
        current = stack.pop();
        if (current) {
          onStack.delete(current);
          component.push(current);
        }
      } while (current && current !== node);

      if (component.length > 1) {
        const cycle = canonicalizeCycle(component);
        cycles.push({ cycle, severity: cycle.length > 3 ? "error" : "warning" });
      }
    }
  };

  for (const node of [...allNodes].sort()) {
    if (!indices.has(node)) {
      visit(node);
    }
  }

  return dedupeCycles(cycles);
}

export function computeEngineeringFanMetrics(
  edges: readonly EngineeringWeightedEdge[],
  nodes: readonly string[],
): ReadonlyMap<string, EngineeringFanMetrics> {
  const metrics = new Map<string, EngineeringFanMetrics>();
  for (const node of nodes) {
    metrics.set(node, { fanIn: 0, fanOut: 0, weightedFanIn: 0, weightedFanOut: 0 });
  }
  const seen = new Set<string>();
  for (const edge of edges) {
    if (metrics.has(edge.from)) {
      const current = metrics.get(edge.from) ?? zeroMetrics();
      const key = `${edge.from}\u0000${edge.to}\u0000out`;
      metrics.set(edge.from, {
        ...current,
        fanOut: current.fanOut + (seen.has(key) ? 0 : 1),
        weightedFanOut: roundWeight(current.weightedFanOut + edge.weight),
      });
      seen.add(key);
    }
    if (metrics.has(edge.to)) {
      const current = metrics.get(edge.to) ?? zeroMetrics();
      const key = `${edge.to}\u0000${edge.from}\u0000in`;
      metrics.set(edge.to, {
        ...current,
        fanIn: current.fanIn + (seen.has(key) ? 0 : 1),
        weightedFanIn: roundWeight(current.weightedFanIn + edge.weight),
      });
      seen.add(key);
    }
  }
  return new Map([...metrics.entries()].sort((left, right) => left[0].localeCompare(right[0])));
}

function zeroMetrics(): EngineeringFanMetrics {
  return { fanIn: 0, fanOut: 0, weightedFanIn: 0, weightedFanOut: 0 };
}

function compareEdges(left: EngineeringWeightedEdge, right: EngineeringWeightedEdge): number {
  return (
    left.from.localeCompare(right.from) ||
    left.to.localeCompare(right.to) ||
    left.relation.localeCompare(right.relation)
  );
}

function canonicalizeCycle(cycle: readonly string[]): string[] {
  if (cycle.length === 0) {
    return [];
  }
  const rotations = cycle.map((_, index) => [...cycle.slice(index), ...cycle.slice(0, index)]);
  return (
    rotations.sort((left, right) => left.join("\u0000").localeCompare(right.join("\u0000")))[0] ??
    []
  );
}

function dedupeCycles(cycles: readonly EngineeringGraphCycle[]): EngineeringGraphCycle[] {
  return [
    ...new Map(
      cycles.map((cycle) => [canonicalizeCycle(cycle.cycle).join("\u0000"), cycle]),
    ).values(),
  ].sort((left, right) => left.cycle.join("\u0000").localeCompare(right.cycle.join("\u0000")));
}

function roundWeight(value: number): number {
  return Math.round(value * 1000) / 1000;
}
