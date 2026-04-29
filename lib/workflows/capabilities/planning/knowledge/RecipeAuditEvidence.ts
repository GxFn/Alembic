import type { AstSummary, DependencyGraph } from '#types/project-snapshot.js';

export function extractCodeEntities(
  astProjectSummary: AstSummary | null | undefined
): Array<{ name: string; kind?: string; file?: string }> {
  const entities: Array<{ name: string; kind?: string; file?: string }> = [];
  if (!astProjectSummary) {
    return entities;
  }

  for (const cls of astProjectSummary.classes || []) {
    entities.push({ name: cls.name, kind: 'class', file: cls.relativePath || cls.file });
  }
  for (const proto of astProjectSummary.protocols || []) {
    entities.push({ name: proto.name, kind: 'protocol', file: proto.relativePath || proto.file });
  }
  if (astProjectSummary.categories) {
    for (const cat of astProjectSummary.categories) {
      entities.push({ name: cat.name || '', kind: 'category', file: cat.relativePath || cat.file });
    }
  }

  return entities;
}

export function extractDependencyEdges(
  depGraphData: DependencyGraph | null | undefined
): Array<{ from: string; to: string }> {
  const edges: Array<{ from: string; to: string }> = [];
  if (!depGraphData?.edges) {
    return edges;
  }

  for (const edge of depGraphData.edges) {
    if (edge.from && edge.to) {
      edges.push({ from: edge.from, to: edge.to });
    }
  }

  return edges;
}
