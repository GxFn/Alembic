import type { EngineeringCodeAstFileSummaryInput } from "../EngineeringCodeGraphModel.js";

export type EngineeringCodeAstLanguageId =
  | "typescript"
  | "javascript"
  | "tsx"
  | "swift"
  | "objective-c"
  | "objectivec"
  | "objc"
  | "python"
  | "java"
  | "kotlin"
  | "go"
  | "rust"
  | "dart"
  | "unknown";

export interface EngineeringCodeAstClassFact {
  readonly name: string;
  readonly kind?: string;
  readonly filePath?: string;
  readonly line?: number | null;
  readonly endLine?: number | null;
  readonly superClass?: string | null;
  readonly superclass?: string | null;
  readonly protocols?: readonly string[];
  readonly properties?: readonly EngineeringCodeAstPropertyFact[];
  readonly methods?: readonly EngineeringCodeAstMethodFact[];
  readonly imports?: readonly EngineeringCodeAstImportFact[];
}

export interface EngineeringCodeAstProtocolFact {
  readonly name: string;
  readonly filePath?: string;
  readonly line?: number | null;
  readonly inherits?: readonly string[];
  readonly requiredMethods?: readonly EngineeringCodeAstMethodFact[];
  readonly optionalMethods?: readonly EngineeringCodeAstMethodFact[];
  readonly methods?: readonly EngineeringCodeAstMethodFact[];
}

export interface EngineeringCodeAstCategoryFact {
  readonly className: string;
  readonly categoryName?: string;
  readonly filePath?: string;
  readonly line?: number | null;
  readonly methods?: readonly EngineeringCodeAstMethodFact[];
  readonly properties?: readonly EngineeringCodeAstPropertyFact[];
  readonly protocols?: readonly string[];
}

export interface EngineeringCodeAstMethodFact {
  readonly name: string;
  readonly selector?: string;
  readonly className?: string | null;
  readonly filePath?: string;
  readonly line?: number | null;
  readonly isClassMethod?: boolean;
  readonly returnType?: string | null;
  readonly paramCount?: number;
  readonly bodyLines?: number;
  readonly complexity?: number;
}

export interface EngineeringCodeAstPropertyFact {
  readonly name: string;
  readonly className?: string | null;
  readonly type?: string | null;
  readonly line?: number | null;
  readonly attributes?: readonly string[];
}

export interface EngineeringCodeAstImportFact {
  readonly path: string;
  readonly kind: string | null;
  readonly symbols: readonly string[];
  readonly alias: string | null;
  readonly exportedName?: string | null;
  readonly isTypeOnly?: boolean;
  readonly isExportOnly?: boolean;
  readonly raw?: unknown;
}

export interface EngineeringCodeAstExportFact {
  readonly name: string;
  readonly kind: string | null;
  readonly filePath?: string;
  readonly line?: number | null;
  readonly text?: string | null;
  readonly path?: string | null;
  readonly symbols?: readonly string[];
}

export interface EngineeringCodeAstCallSiteFact {
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
  readonly languageId?: string;
}

export interface EngineeringCodeAstReferenceFact {
  readonly name: string;
  readonly kind: string | null;
  readonly filePath?: string;
  readonly line?: number | null;
  readonly context?: string | null;
  readonly target?: string | null;
  readonly snippet?: string | null;
}

export interface EngineeringCodeAstTextFact {
  readonly text: string;
  readonly filePath?: string;
  readonly line?: number | null;
  readonly callerClass?: string | null;
  readonly callerMethod?: string | null;
  readonly languageId?: string;
  readonly kind?: string | null;
}

export interface EngineeringCodeAstPropertyTypeFact {
  readonly className: string;
  readonly propertyName: string;
  readonly type: string;
  readonly filePath?: string;
  readonly line?: number | null;
  readonly source?: string | null;
}

export interface EngineeringCodeAstReceiverTypeFact {
  readonly receiver: string;
  readonly receiverType: string;
  readonly callerClass?: string | null;
  readonly callerMethod?: string | null;
  readonly filePath?: string;
  readonly line?: number | null;
  readonly source?: string | null;
}

export interface EngineeringCodeAstMetricsFact {
  readonly methodCount: number;
  readonly avgBodyLines: number;
  readonly maxComplexity: number;
  readonly maxNestingDepth: number;
  readonly longMethods: readonly EngineeringCodeAstMethodFact[];
  readonly complexMethods: readonly EngineeringCodeAstMethodFact[];
}

export interface EngineeringCodeAstFactsFileSummary
  extends Omit<
    EngineeringCodeAstFileSummaryInput,
    "classes" | "protocols" | "categories" | "imports" | "exports" | "callSites"
  > {
  readonly file: string;
  readonly filePath: string;
  readonly languageId: EngineeringCodeAstLanguageId | string;
  readonly lang: EngineeringCodeAstLanguageId | string;
  readonly classes: readonly EngineeringCodeAstClassFact[];
  readonly protocols: readonly EngineeringCodeAstProtocolFact[];
  readonly categories: readonly EngineeringCodeAstCategoryFact[];
  readonly methods: readonly EngineeringCodeAstMethodFact[];
  readonly properties: readonly EngineeringCodeAstPropertyFact[];
  readonly imports: readonly EngineeringCodeAstImportFact[];
  readonly importFacts: readonly EngineeringCodeAstImportFact[];
  readonly exports: readonly EngineeringCodeAstExportFact[];
  readonly callSites: readonly EngineeringCodeAstCallSiteFact[];
  readonly references: readonly EngineeringCodeAstReferenceFact[];
  readonly textFacts: readonly EngineeringCodeAstTextFact[];
  readonly propertyTypes: readonly EngineeringCodeAstPropertyTypeFact[];
  readonly receiverTypes: readonly EngineeringCodeAstReceiverTypeFact[];
  readonly metrics: EngineeringCodeAstMetricsFact | null;
}

export interface EngineeringCodeAstFactsProjectSummary {
  readonly fileSummaries: readonly EngineeringCodeAstFactsFileSummary[];
}

export type EngineeringCodeAstRawInput =
  | readonly unknown[]
  | Record<string, unknown>
  | EngineeringCodeAstFileSummaryInput;
