export interface EngineeringDetection {
  readonly match: boolean;
  readonly confidence: number;
  readonly reason: string;
}

export interface EngineeringTarget {
  readonly name: string;
  readonly path: string;
  readonly type: string;
  readonly language?: string;
  readonly framework?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface EngineeringFile {
  readonly name: string;
  readonly path: string;
  readonly relativePath: string;
  readonly language: string;
  readonly targetName?: string;
  readonly isTest?: boolean;
}

export interface EngineeringDependencyEdge {
  readonly from: string;
  readonly to: string;
  readonly type: string;
  readonly scope?: string;
  readonly configuration?: string;
  readonly bridgeType?: string;
  readonly weight?: number;
}

export interface EngineeringDependencyGraphLayer {
  readonly name: string;
  readonly order: number;
  readonly accessibleLayers: readonly string[];
}

export interface EngineeringDependencyNode {
  readonly id: string;
  readonly label?: string;
  readonly type?: string;
  readonly fullPath?: string;
  readonly indirect?: boolean;
  readonly parent?: string;
  readonly targetType?: string;
  readonly tags?: readonly string[];
  readonly visibility?: readonly string[];
  readonly conventionRole?: string;
  readonly layer?: string;
  readonly [key: string]: unknown;
}

export interface EngineeringDependencyGraph {
  readonly nodes: readonly (EngineeringDependencyNode | string)[];
  readonly edges: readonly EngineeringDependencyEdge[];
  readonly layers?: readonly EngineeringDependencyGraphLayer[];
}

export interface EngineeringLayerLevel {
  readonly level: number;
  readonly name: string;
  readonly modules: readonly string[];
  readonly source: "config" | "topology";
}

export interface EngineeringModuleRelationEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: string;
  readonly source: "config" | "import" | "call" | "data_flow";
  readonly weight: number;
}

export interface EngineeringModuleCycle {
  readonly cycle: readonly string[];
  readonly severity: "warning" | "error";
}

export interface EngineeringLayerViolation {
  readonly from: string;
  readonly to: string;
  readonly fromLayer: number;
  readonly toLayer: number;
  readonly relation: string;
}

export interface EngineeringRelationshipGraph {
  readonly moduleEdges: readonly EngineeringModuleRelationEdge[];
  readonly cycles: readonly EngineeringModuleCycle[];
  readonly layers: readonly EngineeringLayerLevel[];
  readonly layerViolations: readonly EngineeringLayerViolation[];
}

export interface EngineeringDiscoverer {
  readonly id: string;
  readonly displayName: string;
  detect(projectRoot: string): Promise<EngineeringDetection>;
  load(projectRoot: string): Promise<void>;
  listTargets(): Promise<readonly EngineeringTarget[]>;
  getTargetFiles(target: EngineeringTarget | string): Promise<readonly EngineeringFile[]>;
  getDependencyGraph(): Promise<EngineeringDependencyGraph>;
}

export function normalizeEngineeringDependencyNode(
  node: EngineeringDependencyNode | string,
): EngineeringDependencyNode {
  return typeof node === "string" ? { id: node, label: node } : node;
}

export function isExternalEngineeringDependencyNode(node: EngineeringDependencyNode): boolean {
  return node.type === "external" || node.type === "remote" || node.indirect === true;
}
