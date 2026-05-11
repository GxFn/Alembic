import type { EngineeringCodeGraphReader } from "../code/types.js";
import type {
  EngineeringDependencyGraph,
  EngineeringDependencyGraphLayer,
  EngineeringDependencyNode,
  EngineeringFile,
  EngineeringModuleRelationEdge,
  EngineeringRelationshipGraph,
} from "../foundation/types.js";
import type { EngineeringPanoramaSummary } from "./types.js";

export interface EngineeringImportFact {
  readonly filePath: string;
  readonly specifier: string;
  readonly kind?: string;
}

export type EngineeringModuleDiscoverySignalSource =
  | "config"
  | "dependency-graph"
  | "file-group"
  | "host-decomposition"
  | "import-fallback"
  | "unknown-fallback";

export interface EngineeringModuleDiscoverySignal {
  readonly source: EngineeringModuleDiscoverySignalSource;
  readonly module?: string;
  readonly message: string;
  readonly confidence: number;
}

export interface EngineeringDiscoveredModuleFileGroups {
  readonly source: readonly string[];
  readonly test: readonly string[];
  readonly doc: readonly string[];
  readonly config: readonly string[];
}

export interface EngineeringDiscoveredModuleNeighbors {
  readonly dependencies: readonly string[];
  readonly dependents: readonly string[];
  readonly externalDependencies: readonly string[];
}

export interface EngineeringDiscoveredModuleFact {
  readonly name: string;
  readonly role: string;
  readonly kind: "local" | "host" | "external" | "fallback";
  readonly files: readonly string[];
  readonly fileGroups: EngineeringDiscoveredModuleFileGroups;
  readonly neighbors: EngineeringDiscoveredModuleNeighbors;
  readonly configLayer?: string | undefined;
  readonly discoverySignals: readonly EngineeringModuleDiscoverySignalSource[];
}

export interface EngineeringModuleDiscovererInput {
  readonly projectRoot: string;
  readonly files: readonly EngineeringFile[];
  readonly dependencyGraph: EngineeringDependencyGraph;
  readonly codeGraph?: EngineeringCodeGraphReader;
  readonly importFacts?: readonly EngineeringImportFact[];
}

export interface EngineeringModuleDiscoveryResult {
  readonly modules: readonly EngineeringDiscoveredModuleFact[];
  readonly panorama: EngineeringPanoramaSummary;
  readonly relationships: EngineeringRelationshipGraph;
  readonly dependencyGraph: EngineeringDependencyGraph;
  readonly configLayers: readonly EngineeringDependencyGraphLayer[];
  readonly signals: readonly EngineeringModuleDiscoverySignal[];
}

export interface ModuleDraft {
  readonly name: string;
  kind: EngineeringDiscoveredModuleFact["kind"];
  role: string | undefined;
  configLayer: string | undefined;
  readonly files: Set<string>;
  readonly signals: Set<EngineeringModuleDiscoverySignalSource>;
}

export interface NormalizedModuleFile {
  readonly file: EngineeringFile;
  readonly relativePath: string;
}

export interface ModuleIndex {
  readonly modules: ReadonlyMap<string, ModuleDraft>;
  readonly fileToModule: ReadonlyMap<string, string>;
  readonly localNames: ReadonlySet<string>;
  readonly externalNames: ReadonlySet<string>;
}

export interface DependencyGraphModuleFacts {
  readonly localNodes: ReadonlyMap<string, EngineeringDependencyNode>;
  readonly externalNames: ReadonlySet<string>;
  readonly hostNames: ReadonlySet<string>;
}

export type { EngineeringModuleRelationEdge };
