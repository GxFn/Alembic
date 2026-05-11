import { CallEdgeResolver } from "./call-edge-resolver.js";
import { CallSiteExtractor } from "./call-site-extractor.js";
import { DataFlowInferrer } from "./data-flow.js";
import { ImportPathResolver } from "./import-path-resolver.js";
import { SymbolTableBuilder } from "./symbol-table.js";
import type {
  EngineeringCodeAnalysisInput,
  EngineeringCodeImportPathHints,
  EngineeringCodeInferredDataFlowEdge,
  EngineeringCodeResolvedCallEdge,
  EngineeringCodeSymbolTable,
} from "./types.js";
import { filePathForSummary, fileSummariesFromAnalysisInput, normalizePath } from "./utils.js";

export interface EngineeringCodeCallGraphAnalysisOptions {
  readonly pathHints?: EngineeringCodeImportPathHints;
  readonly maxCallSitesPerFile?: number;
  readonly timeout?: number;
  readonly minConfidence?: number;
}

export interface EngineeringCodeCallGraphAnalysisResult {
  readonly symbolTable: EngineeringCodeSymbolTable;
  readonly callEdges: readonly EngineeringCodeResolvedCallEdge[];
  readonly dataFlowEdges: readonly EngineeringCodeInferredDataFlowEdge[];
  readonly stats: {
    readonly filesProcessed: number;
    readonly symbolCount: number;
    readonly totalCallSites: number;
    readonly resolvedCallSites: number;
    readonly unresolvedCallSites: number;
    readonly dataFlowEdges: number;
    readonly durationMs?: number;
    readonly resolvedRate?: number;
    readonly totalEdges?: number;
    readonly tier?: "full-cha" | "full" | "sampled" | "import-only";
    readonly partial?: boolean;
  };
}

export class CallGraphAnalyzer {
  readonly #projectRoot: string;

  constructor(projectRoot = "/") {
    this.#projectRoot = projectRoot;
  }

  analyze(
    input: EngineeringCodeAnalysisInput,
    options: EngineeringCodeCallGraphAnalysisOptions = {},
  ): EngineeringCodeCallGraphAnalysisResult {
    const startedAt = Date.now();
    const deadline = startedAt + (options.timeout ?? Number.POSITIVE_INFINITY);
    const summaries = fileSummariesFromAnalysisInput(input);
    const tier = analysisTier(summaries.length);
    if (tier === "import-only") {
      return {
        symbolTable: SymbolTableBuilder.build(input),
        callEdges: [],
        dataFlowEdges: [],
        stats: {
          filesProcessed: summaries.length,
          symbolCount: 0,
          totalCallSites: 0,
          resolvedCallSites: 0,
          unresolvedCallSites: 0,
          dataFlowEdges: 0,
          durationMs: Date.now() - startedAt,
          resolvedRate: 0,
          totalEdges: 0,
          tier,
        },
      };
    }
    const summariesForResolution = tier === "sampled" ? sampleCoreFiles(summaries, 500) : summaries;
    const symbolTable = SymbolTableBuilder.build(input);
    const importResolver = new ImportPathResolver({
      knownFiles: summaries.map((summary) => normalizePath(filePathForSummary(summary))),
      projectRoot: this.#projectRoot,
      ...(options.pathHints ? { pathHints: options.pathHints } : {}),
    });
    const callResolver = new CallEdgeResolver(symbolTable, importResolver);
    const extractor = new CallSiteExtractor();
    const callEdges: EngineeringCodeResolvedCallEdge[] = [];
    let totalCallSites = 0;
    let filesProcessed = 0;
    const maxCallSites = options.maxCallSitesPerFile ?? 500;

    let partial = false;
    for (const summary of summariesForResolution) {
      if (Date.now() > deadline) {
        partial = true;
        break;
      }
      const filePath = normalizePath(filePathForSummary(summary));
      if (!filePath || filePath === "(unknown)") {
        continue;
      }
      const callSites = extractor.extractFile(summary).slice(0, maxCallSites);
      totalCallSites += callSites.length;
      callEdges.push(...callResolver.resolveFile(callSites, filePath));
      filesProcessed++;
    }

    const dataFlowEdges = DataFlowInferrer.infer(callEdges);
    const unresolvedCallSites = callEdges.filter((edge) => edge.tier === "unresolved").length;
    return {
      symbolTable,
      callEdges,
      dataFlowEdges,
      stats: {
        filesProcessed,
        symbolCount: symbolTable.declarations.size,
        totalCallSites,
        resolvedCallSites: callEdges.length - unresolvedCallSites,
        unresolvedCallSites,
        dataFlowEdges: dataFlowEdges.length,
        durationMs: Date.now() - startedAt,
        resolvedRate:
          totalCallSites === 0 ? 0 : (callEdges.length - unresolvedCallSites) / totalCallSites,
        totalEdges: callEdges.length + dataFlowEdges.length,
        tier,
        ...(partial ? { partial } : {}),
      },
    };
  }
}

function analysisTier(fileCount: number): "full-cha" | "full" | "sampled" | "import-only" {
  if (fileCount < 100) {
    return "full-cha";
  }
  if (fileCount <= 500) {
    return "full";
  }
  if (fileCount <= 2000) {
    return "sampled";
  }
  return "import-only";
}

function sampleCoreFiles<
  T extends {
    readonly file?: unknown;
    readonly filePath?: unknown;
    readonly path?: unknown;
    readonly callSites?: readonly unknown[];
  },
>(summaries: readonly T[], limit: number): readonly T[] {
  const coreDirectoryPattern =
    /\/(src|lib|app|core|pkg|internal|domain|service|controller|handler|api)\//i;
  return [...summaries]
    .map((summary) => {
      const filePath = String(summary.file ?? summary.filePath ?? summary.path ?? "");
      return {
        summary,
        score: coreDirectoryPattern.test(filePath) ? 2 : 1,
        callSiteCount: summary.callSites?.length ?? 0,
      };
    })
    .sort((left, right) => right.score - left.score || right.callSiteCount - left.callSiteCount)
    .slice(0, limit)
    .map((entry) => entry.summary);
}

export default CallGraphAnalyzer;
