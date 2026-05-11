import type {
  EngineeringCodeInferredDataFlowEdge,
  EngineeringCodeResolvedCallEdge,
} from "./types.js";

export class DataFlowInferrer {
  infer(
    callEdges: readonly EngineeringCodeResolvedCallEdge[],
  ): readonly EngineeringCodeInferredDataFlowEdge[] {
    const edges: EngineeringCodeInferredDataFlowEdge[] = [];
    const seen = new Set<string>();
    for (const edge of callEdges) {
      for (const flow of inferFlowsForEdge(edge)) {
        const key = [
          flow.from,
          flow.to,
          flow.flowType,
          flow.direction,
          flow.filePath ?? "",
          flow.line ?? "",
        ].join("\0");
        if (!seen.has(key)) {
          seen.add(key);
          edges.push(flow);
        }
      }
    }
    return edges;
  }

  static infer(
    callEdges: readonly EngineeringCodeResolvedCallEdge[],
  ): readonly EngineeringCodeInferredDataFlowEdge[] {
    return new DataFlowInferrer().infer(callEdges);
  }
}

function inferFlowsForEdge(
  edge: EngineeringCodeResolvedCallEdge,
): readonly EngineeringCodeInferredDataFlowEdge[] {
  const flows: EngineeringCodeInferredDataFlowEdge[] = [];
  const calleeName = edge.callee.toLowerCase();
  const sourceKind = sourceKindFor(calleeName);
  const sinkKind = sinkKindFor(calleeName);
  const transformKind = transformKindFor(calleeName);
  const storeKind = storeKindFor(calleeName);

  if (sourceKind) {
    flows.push(
      makeFlow(edge.callee, edge.caller, "source", "backward", edge, sourceKind, null, 0.58),
    );
  }
  if ((edge.argCount ?? 0) > 0) {
    flows.push(
      makeFlow(
        edge.caller,
        edge.callee,
        sinkKind ?? "argument",
        "forward",
        edge,
        null,
        sinkKind,
        sinkKind ? 0.72 : 0.64,
      ),
    );
  }
  if (transformKind) {
    flows.push(
      makeFlow(
        edge.caller,
        edge.caller,
        "transform",
        "internal",
        edge,
        transformKind,
        transformKind,
        0.48,
      ),
    );
  }
  if (storeKind) {
    flows.push(makeFlow(edge.caller, edge.callee, "store", "forward", edge, null, storeKind, 0.68));
  }

  flows.push(makeFlow(edge.callee, edge.caller, "return-value", "backward", edge, null, null, 0.3));
  return flows;
}

function makeFlow(
  from: string,
  to: string,
  flowType: string,
  direction: string,
  edge: EngineeringCodeResolvedCallEdge,
  source: string | null,
  sink: string | null,
  confidence: number,
): EngineeringCodeInferredDataFlowEdge {
  return {
    from,
    to,
    flowType,
    direction,
    confidence: Math.min(confidence, edge.confidence),
    filePath: edge.filePath,
    line: edge.line,
    source,
    sink,
    viaCallEdge: `${edge.caller}->${edge.callee}`,
    tier: edge.tier,
  };
}

function sourceKindFor(name: string): string | null {
  if (matchesAny(name, ["read", "fetch", "load", "get", "request", "receive", "input", "parse"])) {
    return "source";
  }
  return null;
}

function sinkKindFor(name: string): string | null {
  if (
    matchesAny(name, [
      "send",
      "post",
      "upload",
      "emit",
      "write",
      "save",
      "insert",
      "update",
      "delete",
      "log",
    ])
  ) {
    return "sink";
  }
  return null;
}

function transformKindFor(name: string): string | null {
  if (
    matchesAny(name, [
      "map",
      "reduce",
      "filter",
      "encode",
      "decode",
      "serialize",
      "deserialize",
      "convert",
      "transform",
    ])
  ) {
    return "transform";
  }
  return null;
}

function storeKindFor(name: string): string | null {
  if (matchesAny(name, ["cache", "store", "persist", "save", "write", "insert", "update"])) {
    return "store";
  }
  return null;
}

function matchesAny(name: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => name.includes(token));
}

export default DataFlowInferrer;
