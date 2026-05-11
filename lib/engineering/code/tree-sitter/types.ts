import type { EngineeringCodeAstProtocolFact } from "../ast/facts.js";
import type {
  EngineeringCodeAstCallSiteFact,
  EngineeringCodeAstCategoryFact,
  EngineeringCodeAstClassFact,
  EngineeringCodeAstExportFact,
  EngineeringCodeAstFactsFileSummary,
  EngineeringCodeAstFactsProjectSummary,
  EngineeringCodeAstImportFact,
  EngineeringCodeAstLanguageId,
  EngineeringCodeAstMethodFact,
  EngineeringCodeAstPropertyFact,
  EngineeringCodeAstPropertyTypeFact,
  EngineeringCodeAstReceiverTypeFact,
  EngineeringCodeAstReferenceFact,
  EngineeringCodeAstTextFact,
} from "../ast/index.js";

export type EngineeringTreeSitterLanguageId = Extract<
  EngineeringCodeAstLanguageId,
  | "typescript"
  | "tsx"
  | "javascript"
  | "python"
  | "swift"
  | "objectivec"
  | "java"
  | "kotlin"
  | "go"
  | "dart"
  | "rust"
>;

export interface TreeSitterPosition {
  readonly row: number;
  readonly column: number;
}

export interface TreeSitterNode {
  readonly type: string;
  readonly text: string;
  readonly childCount: number;
  readonly namedChildCount: number;
  readonly children?: readonly TreeSitterNode[];
  readonly namedChildren: readonly TreeSitterNode[];
  readonly startPosition: TreeSitterPosition;
  readonly endPosition: TreeSitterPosition;
  readonly parent?: TreeSitterNode | null;
  readonly isMissing?: boolean;
  child(index: number): TreeSitterNode | null;
  namedChild(index: number): TreeSitterNode | null;
}

export interface TreeSitterTree {
  readonly rootNode: TreeSitterNode;
}

export interface TreeSitterParser {
  parse(input: string): TreeSitterTree;
  setLanguage(language: unknown): void;
}

export interface TreeSitterParserConstructor {
  new (): TreeSitterParser;
  init(): Promise<void>;
}

export interface EngineeringTreeSitterContext {
  readonly filePath: string;
  readonly languageId: EngineeringTreeSitterLanguageId;
  readonly source: string;
  readonly classes: EngineeringCodeAstClassFact[];
  readonly protocols: EngineeringCodeAstProtocolFact[];
  readonly categories: EngineeringCodeAstCategoryFact[];
  readonly methods: EngineeringCodeAstMethodFact[];
  readonly properties: EngineeringCodeAstPropertyFact[];
  readonly patterns: Record<string, unknown>[];
  readonly imports: EngineeringCodeAstImportFact[];
  readonly exports: Array<EngineeringCodeAstExportFact | Record<string, unknown> | string>;
  readonly callSites: EngineeringCodeAstCallSiteFact[];
  readonly references: EngineeringCodeAstReferenceFact[];
  readonly textFacts: EngineeringCodeAstTextFact[];
  readonly propertyTypes: EngineeringCodeAstPropertyTypeFact[];
  readonly receiverTypes: EngineeringCodeAstReceiverTypeFact[];
}

export interface EngineeringTreeSitterLanguagePlugin {
  readonly extensions: readonly string[];
  getGrammar(): unknown;
  walk(rootNode: TreeSitterNode, context: EngineeringTreeSitterContext): void;
  detectPatterns?(
    rootNode: TreeSitterNode,
    context: EngineeringTreeSitterContext,
  ): readonly Record<string, unknown>[];
  extractCallSites?(rootNode: TreeSitterNode, context: EngineeringTreeSitterContext): void;
}

export interface EngineeringTreeSitterParseResult {
  readonly rootNode: TreeSitterNode;
  readonly tree: TreeSitterTree;
}

export interface EngineeringTreeSitterAnalyzeFileOptions {
  readonly filePath?: string;
  readonly languageId?: string;
  readonly extractCallSites?: boolean;
}

export interface EngineeringTreeSitterAnalyzeFileRequest
  extends EngineeringTreeSitterAnalyzeFileOptions {
  readonly content?: string;
  readonly source?: string;
  readonly text?: string;
  readonly path?: string;
  readonly file?: string;
}

export interface EngineeringTreeSitterProjectFile {
  readonly name?: string;
  readonly relativePath?: string;
  readonly filePath?: string;
  readonly path?: string;
  readonly content?: string;
  readonly source?: string;
  readonly text?: string;
  readonly languageId?: string;
  readonly lang?: string;
}

export interface EngineeringTreeSitterAnalyzeProjectOptions {
  readonly languageId?: string;
  readonly extractCallSites?: boolean;
  readonly preprocessFile?: (
    content: string,
    extension: string,
    file: EngineeringTreeSitterProjectFile,
  ) => { readonly content: string; readonly languageId?: string } | null;
}

export type EngineeringTreeSitterFileSummary = EngineeringCodeAstFactsFileSummary;
export type EngineeringTreeSitterProjectSummary = EngineeringCodeAstFactsProjectSummary;
