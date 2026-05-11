import type { EngineeringCodeGraphReader } from "../code/EngineeringCodeGraphModel.js";
import type {
  EngineeringDependencyGraph,
  EngineeringFile,
} from "../foundation/EngineeringCoreTypes.js";
import {
  type EngineeringImportFact,
  EngineeringModuleDiscoverer,
  type EngineeringModuleDiscovererInput,
} from "./EngineeringModuleDiscoverer.js";
import { EngineeringPanoramaRefiner } from "./EngineeringPanoramaRefiner.js";
import {
  buildEngineeringPanoramaSnapshot,
  type EngineeringPanoramaSnapshotBuilderInput,
} from "./EngineeringPanoramaSnapshot.js";
import type {
  EngineeringPanoramaModuleDetail,
  EngineeringPanoramaOverview,
  EngineeringPanoramaSnapshot,
  EngineeringRecipeCoverageFact,
} from "./EngineeringPanoramaTypes.js";

export interface EngineeringPanoramaServiceInput {
  readonly projectRoot: string;
  readonly files: readonly EngineeringFile[];
  readonly dependencyGraph: EngineeringDependencyGraph;
  readonly codeGraph?: EngineeringCodeGraphReader;
  readonly importFacts?: readonly EngineeringImportFact[];
  readonly recipeFacts?: readonly EngineeringRecipeCoverageFact[];
  readonly generatedAt?: number | null;
  readonly computedAt?: number;
  readonly staleAfterMs?: number | null;
  readonly stale?: boolean;
}

export class EngineeringPanoramaService {
  readonly #discoverer: EngineeringModuleDiscoverer;
  readonly #refiner: EngineeringPanoramaRefiner;

  constructor(options?: {
    readonly discoverer?: EngineeringModuleDiscoverer;
    readonly refiner?: EngineeringPanoramaRefiner;
  }) {
    this.#discoverer = options?.discoverer ?? new EngineeringModuleDiscoverer();
    this.#refiner = options?.refiner ?? new EngineeringPanoramaRefiner();
  }

  buildSnapshot(input: EngineeringPanoramaServiceInput): EngineeringPanoramaSnapshot {
    const codeGraph = input.codeGraph ?? emptyCodeGraph();
    const discovererInput: EngineeringModuleDiscovererInput = {
      projectRoot: input.projectRoot,
      files: input.files,
      dependencyGraph: input.dependencyGraph,
      codeGraph,
      ...(input.importFacts !== undefined ? { importFacts: input.importFacts } : {}),
    };
    const discovery = this.#discoverer.discover(discovererInput);
    const refinement = this.#refiner.refine({
      projectRoot: input.projectRoot,
      files: input.files,
      dependencyGraph: discovery.dependencyGraph,
      panorama: discovery.panorama,
      relationships: discovery.relationships,
      codeGraph,
    });
    const snapshotInput: EngineeringPanoramaSnapshotBuilderInput = {
      projectRoot: input.projectRoot,
      files: input.files,
      dependencyGraph: discovery.dependencyGraph,
      discovery,
      refinement,
      codeGraph,
      ...(input.importFacts !== undefined ? { importFacts: input.importFacts } : {}),
      ...(input.recipeFacts !== undefined ? { recipeFacts: input.recipeFacts } : {}),
      ...(input.generatedAt !== undefined ? { generatedAt: input.generatedAt } : {}),
      ...(input.computedAt !== undefined ? { computedAt: input.computedAt } : {}),
      ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
      ...(input.stale !== undefined ? { stale: input.stale } : {}),
    };
    return buildEngineeringPanoramaSnapshot(snapshotInput);
  }

  getOverview(input: EngineeringPanoramaServiceInput): EngineeringPanoramaOverview {
    return this.buildSnapshot(input).overview;
  }

  getModule(
    input: EngineeringPanoramaServiceInput,
    moduleName: string,
  ): EngineeringPanoramaModuleDetail | null {
    return this.buildSnapshot(input).modules.find((module) => module.name === moduleName) ?? null;
  }
}

function emptyCodeGraph(): EngineeringCodeGraphReader {
  return {
    getFileSymbols: () => null,
    getClassInfo: () => null,
    getProtocolInfo: () => null,
    getInheritanceChain: () => [],
    getSubclasses: () => [],
    getAllDescendants: () => [],
    getCategoryExtensions: () => [],
    getMethodOverrides: () => [],
    getClassMethods: () => [],
    getAllFilePaths: () => [],
    searchClasses: () => [],
    getOverview: () => ({
      totalFiles: 0,
      totalClasses: 0,
      totalProtocols: 0,
      totalCategories: 0,
      totalMethods: 0,
      topLevelModules: [],
      entryPoints: [],
      classesPerModule: {},
    }),
    getAllClassNames: () => [],
    getAllProtocolNames: () => [],
    upsertFileSummary: () => "ignored",
    deleteFileSummary: () => false,
    incrementalUpdate: () => ({ added: 0, updated: 0, deleted: 0 }),
    getCallGraphEdges: () => [],
    getCallEdgesByFile: () => [],
    getCallEdgesForSymbol: () => [],
    getCallEdgesForClass: () => [],
    getCallEdgesForMethod: () => [],
    getDataFlowEdges: () => [],
    findCallExpressions: () => [],
    findPatternInContext: () => [],
    checkProtocolConformance: () => ({
      conforms: false,
      classFound: false,
      classDeclLine: null,
      direct: false,
      viaCategory: false,
      viaInheritedProtocol: false,
    }),
    toJSON: () => ({ classes: [], protocols: [], categories: [], files: [] }),
  };
}
