export interface EngineeringCodeMethod {
  readonly name: string;
  readonly selector: string;
  readonly filePath: string;
  readonly line: number | null;
  readonly isClassMethod: boolean;
  readonly returnType: string | null;
  readonly paramCount: number;
  readonly bodyLines: number;
  readonly complexity: number;
}

export interface EngineeringCodeCallSite {
  readonly callee: string;
  readonly callerMethod: string;
  readonly callerClass: string | null;
  readonly callType: string;
  readonly receiver: string | null;
  readonly receiverType: string | null;
  readonly argCount: number;
  readonly line: number | null;
  readonly isAwait: boolean;
  readonly filePath: string;
  readonly snippet: string | null;
}

export interface EngineeringCodeReference {
  readonly name: string;
  readonly kind: string | null;
  readonly filePath: string;
  readonly line: number | null;
  readonly context: string | null;
  readonly target: string | null;
  readonly snippet: string | null;
}

export interface EngineeringCodeExport {
  readonly name: string;
  readonly kind: string | null;
  readonly filePath: string;
  readonly line: number | null;
  readonly text: string | null;
}

export interface EngineeringCodePattern {
  readonly type: string;
  readonly className: string | null;
  readonly methodName: string | null;
  readonly propertyName: string | null;
  readonly isWeakRef: boolean | null;
  readonly line: number | null;
  readonly confidence: number | null;
  readonly filePath: string;
  readonly context: string | null;
  readonly snippet: string | null;
}

export interface EngineeringCodeMetrics {
  readonly methodCount: number;
  readonly avgBodyLines: number;
  readonly maxComplexity: number;
  readonly maxNestingDepth: number;
  readonly longMethods: readonly EngineeringCodeMethod[];
  readonly complexMethods: readonly EngineeringCodeMethod[];
}

export interface EngineeringCodeCallGraphEdge {
  readonly caller: string;
  readonly callee: string;
  readonly callType: string;
  readonly resolveMethod: string;
  readonly line: number | null;
  readonly filePath: string;
  readonly isAwait: boolean;
  readonly argCount: number;
  readonly sourceFilePath: string | null;
  readonly targetFilePath: string | null;
}

export interface EngineeringCodeDataFlowEdge {
  readonly from: string;
  readonly to: string;
  readonly flowType: string;
  readonly direction: string;
  readonly confidence: number | null;
  readonly filePath: string | null;
  readonly line: number | null;
  readonly source: string | null;
  readonly sink: string | null;
}

export interface EngineeringCodeCallEdgeQuery {
  readonly filePath?: string;
  readonly symbol?: string;
  readonly className?: string;
  readonly methodName?: string;
  readonly caller?: string;
  readonly callee?: string;
}

export interface EngineeringCodeDataFlowQuery {
  readonly from?: string;
  readonly to?: string;
  readonly source?: string;
  readonly sink?: string;
  readonly filePath?: string;
  readonly flowType?: string;
  readonly direction?: string;
}

export interface EngineeringCodePatternContextFilter {
  readonly forbiddenContext?: string;
  readonly requiredContext?: string;
}

export interface EngineeringCodeCallExpressionMatch {
  readonly filePath: string;
  readonly line: number | null;
  readonly snippet: string;
  readonly enclosingClass: string | null;
  readonly callSite: EngineeringCodeCallSite;
}

export interface EngineeringCodePatternContextMatch {
  readonly filePath: string;
  readonly line: number | null;
  readonly snippet: string;
  readonly context: string | null;
  readonly pattern: EngineeringCodePattern | EngineeringCodeReference | EngineeringCodeCallSite;
}

export interface EngineeringCodeProtocolConformanceResult {
  readonly conforms: boolean;
  readonly classFound: boolean;
  readonly classDeclLine: number | null;
  readonly direct: boolean;
  readonly viaCategory: boolean;
  readonly viaInheritedProtocol: boolean;
}

export interface EngineeringCodeProperty {
  readonly name: string;
  readonly type: string | null;
  readonly line: number | null;
  readonly attributes: readonly string[];
}

export interface EngineeringCodeClassInfo {
  readonly name: string;
  readonly filePath: string;
  readonly line: number | null;
  readonly endLine: number | null;
  readonly superClass: string | null;
  readonly protocols: readonly string[];
  readonly properties: readonly EngineeringCodeProperty[];
  readonly methods: readonly EngineeringCodeMethod[];
  readonly imports: readonly unknown[];
}

export interface EngineeringCodeProtocolInfo {
  readonly name: string;
  readonly filePath: string;
  readonly line: number | null;
  readonly inherits: readonly string[];
  readonly requiredMethods: readonly EngineeringCodeMethod[];
  readonly optionalMethods: readonly EngineeringCodeMethod[];
  readonly conformers: readonly string[];
}

export interface EngineeringCodeCategoryInfo {
  readonly className: string;
  readonly categoryName: string;
  readonly filePath: string;
  readonly line: number | null;
  readonly methods: readonly EngineeringCodeMethod[];
  readonly properties: readonly EngineeringCodeProperty[];
  readonly protocols: readonly string[];
}

export interface EngineeringCodeFileSymbols {
  readonly path: string;
  readonly languageId: string;
  readonly classes: readonly string[];
  readonly protocols: readonly string[];
  readonly categories: readonly string[];
  readonly imports: readonly unknown[];
  readonly exports: readonly EngineeringCodeExport[];
  readonly callSites: readonly EngineeringCodeCallSite[];
  readonly references: readonly EngineeringCodeReference[];
  readonly patterns: readonly EngineeringCodePattern[];
  readonly metrics: EngineeringCodeMetrics | null;
}

export interface EngineeringCodeGraphOverview {
  readonly totalFiles: number;
  readonly totalClasses: number;
  readonly totalProtocols: number;
  readonly totalCategories: number;
  readonly totalMethods: number;
  readonly topLevelModules: readonly string[];
  readonly entryPoints: readonly string[];
  readonly classesPerModule: Readonly<Record<string, number>>;
}

export interface EngineeringCodeAstClassInput {
  readonly name?: unknown;
  readonly filePath?: unknown;
  readonly file?: unknown;
  readonly line?: unknown;
  readonly endLine?: unknown;
  readonly superclass?: unknown;
  readonly superClass?: unknown;
  readonly protocols?: unknown;
  readonly properties?: unknown;
  readonly methods?: unknown;
  readonly imports?: unknown;
}

export interface EngineeringCodeAstProtocolInput {
  readonly name?: unknown;
  readonly filePath?: unknown;
  readonly file?: unknown;
  readonly line?: unknown;
  readonly inherits?: unknown;
  readonly requiredMethods?: unknown;
  readonly optionalMethods?: unknown;
  readonly methods?: unknown;
}

export interface EngineeringCodeAstCategoryInput {
  readonly className?: unknown;
  readonly name?: unknown;
  readonly categoryName?: unknown;
  readonly filePath?: unknown;
  readonly file?: unknown;
  readonly line?: unknown;
  readonly methods?: unknown;
  readonly properties?: unknown;
  readonly protocols?: unknown;
}

export interface EngineeringCodeAstFileSummaryInput {
  readonly file?: unknown;
  readonly path?: unknown;
  readonly filePath?: unknown;
  readonly lang?: unknown;
  readonly languageId?: unknown;
  readonly classes?: readonly EngineeringCodeAstClassInput[];
  readonly protocols?: readonly EngineeringCodeAstProtocolInput[];
  readonly categories?: readonly EngineeringCodeAstCategoryInput[];
  readonly methods?: unknown;
  readonly properties?: unknown;
  readonly imports?: readonly unknown[];
  readonly importFacts?: readonly unknown[];
  readonly exports?: readonly unknown[];
  readonly callSites?: readonly unknown[];
  readonly references?: readonly unknown[];
  readonly textFacts?: readonly unknown[];
  readonly lightweightFacts?: readonly unknown[];
  readonly propertyTypes?: unknown;
  readonly receiverTypes?: unknown;
  readonly patterns?: readonly unknown[];
  readonly metrics?: unknown;
  readonly callEdges?: readonly unknown[];
  readonly callGraphEdges?: readonly unknown[];
  readonly dataFlowEdges?: readonly unknown[];
}

export type EngineeringCodeAstSummaryInput =
  | readonly EngineeringCodeAstFileSummaryInput[]
  | {
      readonly fileSummaries?: readonly EngineeringCodeAstFileSummaryInput[];
      readonly files?: readonly EngineeringCodeAstFileSummaryInput[];
      readonly astProjectSummary?: {
        readonly fileSummaries?: readonly EngineeringCodeAstFileSummaryInput[];
      };
      readonly callEdges?: readonly unknown[];
      readonly callGraphEdges?: readonly unknown[];
      readonly dataFlowEdges?: readonly unknown[];
    };

export interface EngineeringCodeGraphReader {
  getFileSymbols(relativePath: string): EngineeringCodeFileSymbols | null;
  getClassInfo(className: string): EngineeringCodeClassInfo | null;
  getProtocolInfo(protocolName: string): EngineeringCodeProtocolInfo | null;
  getInheritanceChain(className: string): readonly string[];
  getSubclasses(className: string): readonly string[];
  getAllDescendants(className: string): readonly string[];
  getCategoryExtensions(className: string): readonly EngineeringCodeCategoryInfo[];
  getMethodOverrides(
    className: string,
    methodName: string,
  ): readonly { readonly className: string; readonly method: EngineeringCodeMethod }[];
  getClassMethods(className: string): readonly EngineeringCodeMethod[];
  getAllFilePaths(): readonly string[];
  searchClasses(query: string, limit?: number): readonly string[];
  getOverview(): EngineeringCodeGraphOverview;
  getAllClassNames(): readonly string[];
  getAllProtocolNames(): readonly string[];
  upsertFileSummary(summary: EngineeringCodeAstFileSummaryInput): "added" | "updated" | "ignored";
  deleteFileSummary(relativePath: string): boolean;
  incrementalUpdate(
    changedSummaries?: EngineeringCodeAstSummaryInput,
    deletedPaths?: readonly string[],
  ): { readonly added: number; readonly updated: number; readonly deleted: number };
  getCallGraphEdges(query?: EngineeringCodeCallEdgeQuery): readonly EngineeringCodeCallGraphEdge[];
  getCallEdgesByFile(filePath: string): readonly EngineeringCodeCallGraphEdge[];
  getCallEdgesForSymbol(symbol: string): readonly EngineeringCodeCallGraphEdge[];
  getCallEdgesForClass(className: string): readonly EngineeringCodeCallGraphEdge[];
  getCallEdgesForMethod(
    classNameOrMethod: string,
    methodName?: string,
  ): readonly EngineeringCodeCallGraphEdge[];
  getDataFlowEdges(query?: EngineeringCodeDataFlowQuery): readonly EngineeringCodeDataFlowEdge[];
  findCallExpressions(
    targetCallee: string,
    options?: { readonly filePath?: string; readonly className?: string },
  ): readonly EngineeringCodeCallExpressionMatch[];
  findPatternInContext(
    pattern: string,
    contextFilter?: EngineeringCodePatternContextFilter,
  ): readonly EngineeringCodePatternContextMatch[];
  checkProtocolConformance(
    className: string,
    protocolName: string,
  ): EngineeringCodeProtocolConformanceResult;
  toJSON(): EngineeringCodeGraphSnapshot;
}

export interface EngineeringCodeGraphSnapshot {
  readonly classes: readonly EngineeringCodeClassInfo[];
  readonly protocols: readonly EngineeringCodeProtocolInfo[];
  readonly categories: readonly EngineeringCodeCategoryInfo[];
  readonly files: readonly EngineeringCodeFileSymbols[];
  readonly callGraphEdges?: readonly EngineeringCodeCallGraphEdge[];
  readonly dataFlowEdges?: readonly EngineeringCodeDataFlowEdge[];
  readonly overview?: EngineeringCodeGraphOverview;
}

export class EmptyEngineeringCodeGraph implements EngineeringCodeGraphReader {
  getFileSymbols(_relativePath: string): EngineeringCodeFileSymbols | null {
    return null;
  }

  getClassInfo(_className: string): EngineeringCodeClassInfo | null {
    return null;
  }

  getProtocolInfo(_protocolName: string): EngineeringCodeProtocolInfo | null {
    return null;
  }

  getInheritanceChain(_className: string): readonly string[] {
    return [];
  }

  getSubclasses(_className: string): readonly string[] {
    return [];
  }

  getAllDescendants(_className: string): readonly string[] {
    return [];
  }

  getCategoryExtensions(_className: string): readonly EngineeringCodeCategoryInfo[] {
    return [];
  }

  getMethodOverrides(
    _className: string,
    _methodName: string,
  ): readonly { readonly className: string; readonly method: EngineeringCodeMethod }[] {
    return [];
  }

  getClassMethods(_className: string): readonly EngineeringCodeMethod[] {
    return [];
  }

  getAllFilePaths(): readonly string[] {
    return [];
  }

  searchClasses(_query: string, _limit = 20): readonly string[] {
    return [];
  }

  getOverview(): EngineeringCodeGraphOverview {
    return {
      totalFiles: 0,
      totalClasses: 0,
      totalProtocols: 0,
      totalCategories: 0,
      totalMethods: 0,
      topLevelModules: [],
      entryPoints: [],
      classesPerModule: {},
    };
  }

  getAllClassNames(): readonly string[] {
    return [];
  }

  getAllProtocolNames(): readonly string[] {
    return [];
  }

  upsertFileSummary(_summary: EngineeringCodeAstFileSummaryInput): "added" | "updated" | "ignored" {
    return "ignored";
  }

  deleteFileSummary(_relativePath: string): boolean {
    return false;
  }

  incrementalUpdate(
    _changedSummaries: EngineeringCodeAstSummaryInput = [],
    _deletedPaths: readonly string[] = [],
  ): { readonly added: number; readonly updated: number; readonly deleted: number } {
    return { added: 0, updated: 0, deleted: 0 };
  }

  getCallGraphEdges(
    _query: EngineeringCodeCallEdgeQuery = {},
  ): readonly EngineeringCodeCallGraphEdge[] {
    return [];
  }

  getCallEdgesByFile(_filePath: string): readonly EngineeringCodeCallGraphEdge[] {
    return [];
  }

  getCallEdgesForSymbol(_symbol: string): readonly EngineeringCodeCallGraphEdge[] {
    return [];
  }

  getCallEdgesForClass(_className: string): readonly EngineeringCodeCallGraphEdge[] {
    return [];
  }

  getCallEdgesForMethod(
    _classNameOrMethod: string,
    _methodName?: string,
  ): readonly EngineeringCodeCallGraphEdge[] {
    return [];
  }

  getDataFlowEdges(
    _query: EngineeringCodeDataFlowQuery = {},
  ): readonly EngineeringCodeDataFlowEdge[] {
    return [];
  }

  findCallExpressions(
    _targetCallee: string,
    _options: { readonly filePath?: string; readonly className?: string } = {},
  ): readonly EngineeringCodeCallExpressionMatch[] {
    return [];
  }

  findPatternInContext(
    _pattern: string,
    _contextFilter: EngineeringCodePatternContextFilter = {},
  ): readonly EngineeringCodePatternContextMatch[] {
    return [];
  }

  checkProtocolConformance(
    _className: string,
    _protocolName: string,
  ): EngineeringCodeProtocolConformanceResult {
    return {
      conforms: false,
      classFound: false,
      classDeclLine: null,
      direct: false,
      viaCategory: false,
      viaInheritedProtocol: false,
    };
  }

  toJSON(): EngineeringCodeGraphSnapshot {
    return {
      classes: [],
      protocols: [],
      categories: [],
      files: [],
      callGraphEdges: [],
      dataFlowEdges: [],
      overview: this.getOverview(),
    };
  }
}
