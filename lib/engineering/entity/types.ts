import type {
  EngineeringCodeCallGraphEdge,
  EngineeringCodeDataFlowEdge,
  EngineeringCodeGraphReader,
} from "../code/types.js";
import type {
  EngineeringDependencyGraph,
  EngineeringFile,
  EngineeringTarget,
} from "../foundation/types.js";

export type EngineeringEntityType =
  | "file"
  | "target"
  | "module"
  | "external"
  | "class"
  | "protocol"
  | "category"
  | "method"
  | "property"
  | "symbol"
  | "pattern"
  | "recipe";

export type EngineeringEntityRelation =
  | "contains"
  | "defines"
  | "depends_on"
  | "imports"
  | "inherits"
  | "conforms"
  | "extends"
  | "calls"
  | "data_flow"
  | "references"
  | "matches"
  | "uses_pattern"
  | "is_part_of"
  | string;

export interface EngineeringEntity {
  readonly id: string;
  readonly type: EngineeringEntityType;
  readonly name: string;
  readonly filePath: string | null;
  readonly line: number | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface EngineeringEntityEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: EngineeringEntityRelation;
  readonly weight: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface EngineeringEntityGraphInput {
  readonly targets: readonly EngineeringTarget[];
  readonly files: readonly EngineeringFile[];
  readonly dependencyGraph: EngineeringDependencyGraph;
  readonly codeGraph?: EngineeringCodeGraphReader;
  readonly callGraph?: readonly EngineeringCodeCallGraphEdge[];
  readonly dataFlow?: readonly EngineeringCodeDataFlowEdge[];
  readonly patternStats?: EngineeringPatternStats;
  readonly candidateRelations?: readonly EngineeringCandidateWithRelations[];
}

export interface EngineeringPatternInstance {
  readonly className?: string;
  readonly name?: string;
  readonly file?: string;
  readonly filePath?: string;
}

export interface EngineeringPatternStat {
  readonly count: number;
  readonly files?: readonly string[];
  readonly instances?: readonly EngineeringPatternInstance[];
}

export type EngineeringPatternStats = Readonly<Record<string, EngineeringPatternStat>>;

export interface EngineeringCandidateRelation {
  readonly type: string;
  readonly target: string;
  readonly description?: string;
}

export interface EngineeringCandidateWithRelations {
  readonly title?: string;
  readonly id?: string;
  readonly relations?: unknown;
}

export interface EngineeringEntityPath {
  readonly nodes: readonly string[];
  readonly edges: readonly EngineeringEntityEdge[];
  readonly distance: number;
}

export interface EngineeringImpactRadius {
  readonly root: string;
  readonly depth: number;
  readonly direction: "outgoing" | "incoming" | "both";
  readonly nodes: readonly EngineeringEntity[];
  readonly edges: readonly EngineeringEntityEdge[];
  readonly distanceById: Readonly<Record<string, number>>;
}

export interface EngineeringEntityTopology {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly roots: readonly string[];
  readonly leaves: readonly string[];
  readonly isolated: readonly string[];
  readonly components: readonly (readonly string[])[];
  readonly cycles: readonly (readonly string[])[];
}

export interface EngineeringHotNode {
  readonly id: string;
  readonly degree: number;
  readonly fanIn: number;
  readonly fanOut: number;
  readonly weightedDegree: number;
}

export interface EngineeringCallReference {
  readonly entity: EngineeringEntity;
  readonly edge: EngineeringEntityEdge;
  readonly depth: number;
  readonly callType: string;
}

export interface EngineeringCallImpactRadius extends EngineeringImpactRadius {
  readonly relationCounts: Readonly<Record<string, number>>;
  readonly affectedFiles: readonly string[];
  readonly directCallers: number;
  readonly transitiveCallers: number;
}

export interface EngineeringFileCleanupResult {
  readonly deletedEntities: number;
  readonly deletedEdges: number;
  readonly entityIds: readonly string[];
}

export interface EngineeringEdgeCleanupResult {
  readonly deletedEdges: number;
}

export interface EngineeringAgentContextOptions {
  readonly maxHotNodes?: number;
  readonly maxPaths?: number;
  readonly maxDependencies?: number;
  readonly maxRiskModules?: number;
}

export interface EngineeringAgentContext {
  readonly stats: {
    readonly entityCount: number;
    readonly edgeCount: number;
    readonly entitiesByType: Readonly<Record<EngineeringEntityType, number>>;
    readonly edgesByRelation: Readonly<Record<string, number>>;
  };
  readonly hotNodes: readonly EngineeringHotNode[];
  readonly criticalPaths: readonly EngineeringEntityPath[];
  readonly externalDependencies: readonly {
    readonly entity: EngineeringEntity;
    readonly incoming: readonly EngineeringEntityEdge[];
  }[];
  readonly callAndDataFlowSummary: {
    readonly calls: number;
    readonly dataFlows: number;
    readonly hotCallees: readonly {
      readonly entity: EngineeringEntity;
      readonly callerCount: number;
      readonly callers: readonly EngineeringEntity[];
    }[];
    readonly dataFlowSources: readonly {
      readonly entity: EngineeringEntity;
      readonly outgoingCount: number;
    }[];
  };
  readonly riskModules: readonly {
    readonly entity: EngineeringEntity;
    readonly score: number;
    readonly reasons: readonly string[];
  }[];
}
