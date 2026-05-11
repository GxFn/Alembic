import type {
  EngineeringCodeAstFileSummaryInput,
  EngineeringCodeAstSummaryInput,
  EngineeringCodeCallGraphEdge,
  EngineeringCodeCallSite,
  EngineeringCodeDataFlowEdge,
  EngineeringCodeGraphReader,
} from "../EngineeringCodeGraphModel.js";

export type EngineeringCodeAnalysisTier =
  | "direct"
  | "import"
  | "class-method"
  | "inheritance"
  | "override"
  | "protocol"
  | "conformance"
  | "rta"
  | "inferred"
  | "unresolved";

export type EngineeringCodeSymbolKind =
  | "module"
  | "class"
  | "protocol"
  | "interface"
  | "category"
  | "method"
  | "function"
  | "property"
  | "type";

export interface EngineeringCodeSymbolDeclaration {
  readonly fqn: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: EngineeringCodeSymbolKind;
  readonly filePath: string;
  readonly line: number | null;
  readonly containerName: string | null;
  readonly className: string | null;
  readonly isExported: boolean;
  readonly languageId: string;
  readonly returnType?: string | null;
  readonly paramCount?: number | null;
  readonly protocols?: readonly string[];
  readonly superClass?: string | null;
}

export interface EngineeringCodeImportRecord {
  readonly path: string;
  readonly kind: string | null;
  readonly symbols: readonly string[];
  readonly alias: string | null;
  readonly exportedName?: string | null;
  readonly isTypeOnly?: boolean;
  readonly isExportOnly?: boolean;
  readonly raw?: unknown;
}

export interface EngineeringCodeInheritanceEdge {
  readonly from: string;
  readonly to: string;
  readonly type: "inherits" | "conforms" | "protocol-inherits" | "category-conforms";
}

export interface EngineeringCodeSymbolTable {
  readonly declarations: Map<string, EngineeringCodeSymbolDeclaration>;
  readonly fileExports: Map<string, readonly string[]>;
  readonly fileImports: Map<string, readonly EngineeringCodeImportRecord[]>;
  readonly declarationsByName: Map<string, readonly string[]>;
  readonly declarationsByFile: Map<string, readonly string[]>;
  readonly classNames: Set<string>;
  readonly protocolNames: Set<string>;
  readonly instantiatedClasses: Set<string>;
  readonly propertyTypes: Map<string, Map<string, string>>;
  readonly inheritanceEdges: readonly EngineeringCodeInheritanceEdge[];
}

export interface EngineeringCodeImportPathHints {
  readonly baseUrl?: string;
  readonly paths?: Readonly<Record<string, readonly string[] | string>>;
  readonly aliases?: Readonly<Record<string, readonly string[] | string>>;
  readonly extensions?: readonly string[];
}

export interface EngineeringCodeImportResolution {
  readonly importPath: string;
  readonly importerFile: string;
  readonly status: "resolved" | "external" | "unresolved";
  readonly resolvedPath: string | null;
  readonly externalPackage: string | null;
  readonly reason: string;
  readonly confidence: number;
}

export interface EngineeringCodeNormalizedCallSite extends EngineeringCodeCallSite {
  readonly confidence: number;
  readonly origin: "summary" | "text-fact";
}

export interface EngineeringCodeResolvedCallEdge extends EngineeringCodeCallGraphEdge {
  readonly confidence: number;
  readonly tier: EngineeringCodeAnalysisTier;
  readonly targetSymbolKind: EngineeringCodeSymbolKind | "external" | "unknown";
  readonly unresolvedReason?: string;
}

export interface EngineeringCodeInferredDataFlowEdge extends EngineeringCodeDataFlowEdge {
  readonly confidence: number | null;
  readonly viaCallEdge?: string;
  readonly tier?: EngineeringCodeAnalysisTier;
}

export interface EngineeringCodeAnalysisSummary {
  readonly fileSummaries: readonly EngineeringCodeAstFileSummaryInput[];
}

export type EngineeringCodeAnalysisInput =
  | EngineeringCodeAstSummaryInput
  | EngineeringCodeGraphReader
  | EngineeringCodeAnalysisSummary;

export function isGraphReader(
  input: EngineeringCodeAnalysisInput,
): input is EngineeringCodeGraphReader {
  return (
    typeof input === "object" &&
    input !== null &&
    "getAllFilePaths" in input &&
    "getFileSymbols" in input &&
    "toJSON" in input
  );
}
