import type { EngineeringCodeGraphReader } from "../code/EngineeringCodeGraphModel.js";
import type {
  EngineeringDependencyGraph,
  EngineeringFile,
  EngineeringLayerLevel,
  EngineeringLayerViolation,
  EngineeringModuleCycle,
  EngineeringModuleRelationEdge,
  EngineeringRelationshipGraph,
} from "../foundation/EngineeringCoreTypes.js";

export interface EngineeringPanoramaModuleSummary {
  readonly name: string;
  readonly role: string;
  readonly fileCount: number;
  readonly sourceFileCount: number;
  readonly testFileCount: number;
  readonly docFileCount: number;
  readonly symbolCount: number;
  readonly dependencyCount: number;
  readonly dependentCount: number;
  readonly externalDependencyCount: number;
  readonly languages: readonly string[];
  readonly representativePaths: readonly string[];
}

export interface EngineeringPanoramaSummary {
  readonly modules: readonly EngineeringPanoramaModuleSummary[];
}

export interface EngineeringCouplingEdge {
  readonly from: string;
  readonly to: string;
  readonly relation: string;
  readonly weight: number;
  readonly sources: readonly EngineeringModuleRelationEdge["source"][];
}

export interface EngineeringCouplingMetrics {
  readonly fanIn: number;
  readonly fanOut: number;
  readonly weightedFanIn: number;
  readonly weightedFanOut: number;
}

export interface EngineeringExternalDependencyRefinement {
  readonly name: string;
  readonly fanIn: number;
  readonly dependedBy: readonly string[];
  readonly weight: number;
}

export interface EngineeringRoleSignal {
  readonly role: string;
  readonly confidence: number;
  readonly weight: number;
  readonly source: string;
}

export type EngineeringRoleResolution = "clear" | "uncertain" | "fallback";

export interface EngineeringRefinedRole {
  readonly refinedRole: string;
  readonly confidence: number;
  readonly resolution: EngineeringRoleResolution;
  readonly alternatives: readonly [string, number][];
  readonly signals: readonly EngineeringRoleSignal[];
}

export interface EngineeringPanoramaRefinement {
  readonly edges: readonly EngineeringCouplingEdge[];
  readonly cycles: readonly EngineeringModuleCycle[];
  readonly metrics: ReadonlyMap<string, EngineeringCouplingMetrics>;
  readonly externalDeps: readonly EngineeringExternalDependencyRefinement[];
  readonly roles: ReadonlyMap<string, EngineeringRefinedRole>;
  readonly layers: readonly EngineeringLayerLevel[];
  readonly layerViolations: readonly EngineeringLayerViolation[];
  readonly configBasedLayers: boolean;
}

export interface EngineeringPanoramaRefinerInput {
  readonly projectRoot: string;
  readonly files: readonly EngineeringFile[];
  readonly dependencyGraph: EngineeringDependencyGraph;
  readonly panorama: EngineeringPanoramaSummary;
  readonly relationships: EngineeringRelationshipGraph;
  readonly codeGraph: EngineeringCodeGraphReader;
}

export interface EngineeringPanoramaFileGroups {
  readonly source: readonly string[];
  readonly test: readonly string[];
  readonly doc: readonly string[];
  readonly config: readonly string[];
  readonly byDirectory: readonly EngineeringPanoramaDirectoryFileGroup[];
}

export interface EngineeringPanoramaDirectoryFileGroup {
  readonly group: string;
  readonly files: readonly string[];
  readonly count: number;
}

export interface EngineeringPanoramaModuleNeighbors {
  readonly dependencies: readonly string[];
  readonly dependents: readonly string[];
  readonly externalDependencies: readonly string[];
}

export interface EngineeringPanoramaNeighborEdge {
  readonly name: string;
  readonly direction: "incoming" | "outgoing";
  readonly relation: string;
  readonly weight: number;
  readonly sources: readonly EngineeringModuleRelationEdge["source"][];
}

export interface EngineeringPanoramaExternalDependencyProfile {
  readonly name: string;
  readonly fanIn: number;
  readonly dependedBy: readonly string[];
  readonly weight: number;
  readonly category?: string | undefined;
  readonly version?: string | undefined;
  readonly source?: string | undefined;
}

export interface EngineeringPanoramaModuleDetail {
  readonly name: string;
  readonly kind: "local" | "host" | "external" | "fallback";
  readonly role: string;
  readonly inferredRole: string;
  readonly roleConfidence: number;
  readonly roleResolution: EngineeringRoleResolution;
  readonly roleSignals: readonly EngineeringRoleSignal[];
  readonly uncertainSignals: readonly string[];
  readonly fallbackSignals: readonly string[];
  readonly discoverySignals: readonly string[];
  readonly configLayer?: string | undefined;
  readonly layer: EngineeringLayerLevel | null;
  readonly files: readonly string[];
  readonly fileCount: number;
  readonly sourceFileCount: number;
  readonly testFileCount: number;
  readonly docFileCount: number;
  readonly symbolCount: number;
  readonly languages: readonly string[];
  readonly fileGroups: EngineeringPanoramaFileGroups;
  readonly neighbors: EngineeringPanoramaModuleNeighbors;
  readonly incoming: readonly EngineeringPanoramaNeighborEdge[];
  readonly outgoing: readonly EngineeringPanoramaNeighborEdge[];
  readonly externalDeps: readonly EngineeringPanoramaExternalDependencyProfile[];
  readonly fanIn: number;
  readonly fanOut: number;
  readonly weightedFanIn: number;
  readonly weightedFanOut: number;
  readonly summary: string;
}

export interface EngineeringPanoramaCoverageSummary {
  readonly source: "structural-placeholder" | "pure-analysis";
  readonly coveredModuleCount: number;
  readonly totalModuleCount: number;
  readonly ratio: number;
  readonly weakModuleCount?: number;
  readonly recipeCoverageRatio?: number;
}

export type EngineeringPanoramaHealthStatus = "healthy" | "watch" | "risk" | "critical";
export type EngineeringPanoramaGapPriority = "high" | "medium" | "low";
export type EngineeringPanoramaGapType =
  | "architecture-cycle"
  | "external-dependency-hotspot"
  | "layer-conflict"
  | "recipe-coverage"
  | "role-uncertainty"
  | "structural-coverage";

export interface EngineeringPanoramaGap {
  readonly id: string;
  readonly type: EngineeringPanoramaGapType;
  readonly priority: EngineeringPanoramaGapPriority;
  readonly title: string;
  readonly reason: string;
  readonly module?: string | undefined;
  readonly dimension?: string | undefined;
  readonly evidence: readonly string[];
  readonly scoreImpact: number;
}

export interface EngineeringPanoramaHealthSummary {
  readonly status: EngineeringPanoramaHealthStatus;
  readonly reason: string;
  readonly score: number;
  readonly gaps: readonly EngineeringPanoramaGap[];
}

export interface EngineeringTechStackItem {
  readonly name: string;
  readonly category:
    | "language"
    | "framework"
    | "library"
    | "runtime"
    | "storage"
    | "test"
    | "devops"
    | "other";
  readonly source: string;
  readonly count: number;
  readonly fanIn: number;
  readonly dependedBy: readonly string[];
  readonly modules: readonly string[];
  readonly confidence: number;
  readonly version?: string | undefined;
}

export interface EngineeringTechStackCategory {
  readonly name: EngineeringTechStackItem["category"];
  readonly items: readonly EngineeringTechStackItem[];
}

export interface EngineeringTechStackHotspot {
  readonly name: string;
  readonly category: EngineeringTechStackItem["category"];
  readonly fanIn: number;
  readonly dependedBy: readonly string[];
  readonly reason: string;
}

export interface EngineeringTechStackProfile {
  readonly categories: readonly EngineeringTechStackCategory[];
  readonly hotspots: readonly EngineeringTechStackHotspot[];
  readonly totalExternalDeps: number;
  readonly totalFacts: number;
  readonly primaryLanguages: readonly string[];
}

export interface EngineeringRecipeCoverageFact {
  readonly title: string;
  readonly dimensionId?: string | undefined;
  readonly category?: string | undefined;
  readonly knowledgeType?: string | undefined;
  readonly topicHint?: string | undefined;
  readonly kind?: string | undefined;
  readonly roles?: readonly string[] | undefined;
}

export interface EngineeringHealthDimension {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly score: number;
  readonly status: "strong" | "adequate" | "weak" | "missing";
  readonly level: "adopt" | "trial" | "assess" | "hold";
  readonly recipeCount: number;
  readonly affectedModules: readonly string[];
  readonly topRecipes: readonly string[];
}

export interface EngineeringDimensionWeakArea {
  readonly id: string;
  readonly dimension: string;
  readonly status: "weak" | "missing";
  readonly priority: EngineeringPanoramaGapPriority;
  readonly reason: string;
  readonly affectedModules: readonly string[];
  readonly suggestedTopics: readonly string[];
}

export interface EngineeringModuleDimensionCoverage {
  readonly totalModules: number;
  readonly coveredModules: number;
  readonly weakModules: readonly string[];
  readonly ratio: number;
}

export interface EngineeringLanguageDimensionCoverage {
  readonly languages: readonly { readonly name: string; readonly fileCount: number }[];
  readonly primaryLanguages: readonly string[];
  readonly mixedLanguage: boolean;
}

export interface EngineeringArchitectureDimensionCoverage {
  readonly layerCount: number;
  readonly cycleCount: number;
  readonly layerViolationCount: number;
  readonly externalDependencyCount: number;
  readonly configBasedLayers: boolean;
}

export interface EngineeringRecipeCoveragePlaceholder {
  readonly source: "input-facts" | "placeholder";
  readonly totalRecipes: number;
  readonly coveredDimensions: number;
  readonly totalDimensions: number;
  readonly ratio: number;
  readonly reason: string;
}

export interface EngineeringDimensionAnalysis {
  readonly dimensions: readonly EngineeringHealthDimension[];
  readonly overallScore: number;
  readonly moduleCoverage: EngineeringModuleDimensionCoverage;
  readonly languageCoverage: EngineeringLanguageDimensionCoverage;
  readonly architectureCoverage: EngineeringArchitectureDimensionCoverage;
  readonly recipeCoverage: EngineeringRecipeCoveragePlaceholder;
  readonly weakAreas: readonly EngineeringDimensionWeakArea[];
}

export interface EngineeringCallFlowItem {
  readonly id: string;
  readonly count: number;
  readonly modules: readonly string[];
}

export interface EngineeringModuleCallFlow {
  readonly from: string;
  readonly to: string;
  readonly relation: "calls" | "data_flow";
  readonly count: number;
  readonly weight: number;
}

export interface EngineeringCallFlowSummary {
  readonly edgeCounts: {
    readonly calls: number;
    readonly dataFlows: number;
    readonly relationshipCalls: number;
    readonly relationshipDataFlows: number;
  };
  readonly topCalled: readonly EngineeringCallFlowItem[];
  readonly entryPoints: readonly EngineeringCallFlowItem[];
  readonly dataProducers: readonly EngineeringCallFlowItem[];
  readonly dataConsumers: readonly EngineeringCallFlowItem[];
  readonly moduleFlows: readonly EngineeringModuleCallFlow[];
}

export interface EngineeringPanoramaHotspot {
  readonly module: string;
  readonly fanIn: number;
  readonly fanOut: number;
  readonly weightedFanIn: number;
  readonly weightedFanOut: number;
  readonly cycleCount: number;
  readonly reason: string;
}

export interface EngineeringPanoramaOverview {
  readonly projectRoot: string;
  readonly moduleCount: number;
  readonly localModuleCount: number;
  readonly hostModuleCount: number;
  readonly fallbackModuleCount: number;
  readonly localDependencyCount: number;
  readonly externalDependencyCount: number;
  readonly cycleCount: number;
  readonly layerCount: number;
  readonly totalFileCount: number;
  readonly sourceFileCount: number;
  readonly testFileCount: number;
  readonly docFileCount: number;
  readonly coverage: EngineeringPanoramaCoverageSummary;
  readonly health: EngineeringPanoramaHealthSummary;
  readonly hotspots: readonly EngineeringPanoramaHotspot[];
}

export interface EngineeringPanoramaRelationshipSnapshot {
  readonly moduleEdges: readonly EngineeringModuleRelationEdge[];
  readonly couplingEdges: readonly EngineeringCouplingEdge[];
  readonly layerViolations: readonly EngineeringLayerViolation[];
}

export interface EngineeringPanoramaRoleProfile {
  readonly module: string;
  readonly role: string;
  readonly confidence: number;
  readonly resolution: EngineeringRoleResolution;
  readonly alternatives: readonly [string, number][];
  readonly signals: readonly EngineeringRoleSignal[];
}

export interface EngineeringPanoramaConfidence {
  readonly overall: number;
  readonly moduleDiscovery: number;
  readonly roleRefinement: number;
  readonly relationshipInference: number;
}

export interface EngineeringPanoramaCacheMarkers {
  readonly enabled: false;
  readonly stale: boolean;
  readonly reason: string;
  readonly generatedAt: number | null;
  readonly computedAt: number;
  readonly staleAfterMs: number | null;
}

export interface EngineeringPanoramaSnapshot {
  readonly projectRoot: string;
  readonly generatedAt: number | null;
  readonly computedAt: number;
  readonly overview: EngineeringPanoramaOverview;
  readonly modules: readonly EngineeringPanoramaModuleDetail[];
  readonly relationships: EngineeringPanoramaRelationshipSnapshot;
  readonly layers: readonly EngineeringLayerLevel[];
  readonly cycles: readonly EngineeringModuleCycle[];
  readonly externalDeps: readonly EngineeringPanoramaExternalDependencyProfile[];
  readonly techStack: EngineeringTechStackProfile;
  readonly dimensions: EngineeringDimensionAnalysis;
  readonly health: EngineeringPanoramaHealthSummary;
  readonly gaps: readonly EngineeringPanoramaGap[];
  readonly callFlow: EngineeringCallFlowSummary;
  readonly roles: readonly EngineeringPanoramaRoleProfile[];
  readonly confidence: EngineeringPanoramaConfidence;
  readonly stale: boolean;
  readonly cache: EngineeringPanoramaCacheMarkers;
}
