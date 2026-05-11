import {
  filePathForSummary,
  fileSummariesFromAnalysisInput,
  normalizePath,
} from "./analysisUtils.js";
import { CallEdgeResolver } from "./CallEdgeResolver.js";
import { CallSiteExtractor } from "./CallSiteExtractor.js";
import { DataFlowInferrer } from "./DataFlowInferrer.js";
import type {
  EngineeringCodeAnalysisInput,
  EngineeringCodeImportPathHints,
  EngineeringCodeInferredDataFlowEdge,
  EngineeringCodeResolvedCallEdge,
  EngineeringCodeSymbolTable,
} from "./EngineeringCodeAnalysisTypes.js";
import { ImportPathResolver } from "./ImportPathResolver.js";
import { SymbolTableBuilder } from "./SymbolTableBuilder.js";

export interface EngineeringCodeCallGraphAnalysisOptions {
  readonly pathHints?: EngineeringCodeImportPathHints;
  readonly maxCallSitesPerFile?: number;
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
  };
}

export class CallGraphAnalyzer {
  analyze(
    input: EngineeringCodeAnalysisInput,
    options: EngineeringCodeCallGraphAnalysisOptions = {},
  ): EngineeringCodeCallGraphAnalysisResult {
    const summaries = fileSummariesFromAnalysisInput(input);
    const symbolTable = SymbolTableBuilder.build(input);
    const importResolver = new ImportPathResolver({
      knownFiles: summaries.map((summary) => normalizePath(filePathForSummary(summary))),
      ...(options.pathHints ? { pathHints: options.pathHints } : {}),
    });
    const callResolver = new CallEdgeResolver(symbolTable, importResolver);
    const extractor = new CallSiteExtractor();
    const callEdges: EngineeringCodeResolvedCallEdge[] = [];
    let totalCallSites = 0;
    let filesProcessed = 0;
    const maxCallSites = options.maxCallSitesPerFile ?? 500;

    for (const summary of summaries) {
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
      },
    };
  }
}

export default CallGraphAnalyzer;
