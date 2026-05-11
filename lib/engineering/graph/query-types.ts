export type EngineeringGraphTraversalDirection = "incoming" | "outgoing" | "both";

export type EngineeringGraphQueryOperation =
  | "callers"
  | "callees"
  | "impact"
  | "path"
  | "topology"
  | "callImpact"
  | "entities"
  | "edges"
  | "conformances"
  | "dependencies"
  | "cycles"
  | "class"
  | "protocol"
  | "hierarchy"
  | "overrides"
  | "extensions"
  | "search";

export interface EngineeringGraphQueryInput {
  readonly operation: EngineeringGraphQueryOperation;
  readonly ref?: string;
  readonly entity?: string;
  readonly from?: string;
  readonly to?: string;
  readonly relation?: string;
  readonly entityType?: string;
  readonly query?: string;
  readonly maxDepth?: number;
  readonly limit?: number;
  readonly direction?: EngineeringGraphTraversalDirection;
  readonly includeStart?: boolean;
}

export interface EngineeringGraphOverviewResult {
  readonly source: "engineering";
  readonly projectRoot: string;
  readonly files: {
    readonly total: number;
    readonly byLanguage: Readonly<Record<string, number>>;
  };
  readonly targets: readonly string[];
  readonly code: {
    readonly totalFiles: number;
    readonly totalClasses: number;
    readonly totalProtocols: number;
    readonly totalMethods: number;
    readonly callEdges: number;
    readonly dataFlowEdges: number;
  };
  readonly dependencies: {
    readonly nodes: number;
    readonly edges: number;
    readonly cycles: number;
  };
  readonly entities: {
    readonly total: number;
    readonly edges: number;
    readonly byType: Readonly<Record<string, number>>;
  };
  readonly panorama: {
    readonly moduleCount: number;
    readonly externalDependencyCount: number;
    readonly healthScore: number | null;
    readonly gaps: number;
  };
}

export interface EngineeringGraphQueryResult {
  readonly operation: EngineeringGraphQueryOperation;
  readonly ref?: string;
  readonly entity?: string;
  readonly result: unknown;
}

export interface EngineeringGraphQueryProvider {
  overview(): Promise<EngineeringGraphOverviewResult> | EngineeringGraphOverviewResult;
  query(
    input: EngineeringGraphQueryInput,
  ): Promise<EngineeringGraphQueryResult> | EngineeringGraphQueryResult;
}
