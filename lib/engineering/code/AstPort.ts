import type { LanguageDetection } from "./LanguageServicePort.js";

export type MainlineAstStatus = "parsed" | "unsupported" | "failed";

export interface MainlineSourceSymbol {
  name: string;
  kind: "class" | "function" | "method" | "interface" | "type" | "variable" | "unknown";
  startLine?: number;
  endLine?: number;
  containerName?: string | null;
  isExported?: boolean;
  exportName?: string;
}

export interface MainlineImportSpecifier {
  readonly imported: string;
  readonly local: string;
  readonly isTypeOnly?: boolean;
}

export type MainlineImportKind =
  | "named"
  | "default"
  | "namespace"
  | "side-effect"
  | "dynamic"
  | "commonjs"
  | "export";

export interface MainlineImportRecord {
  readonly path: string;
  readonly kind: MainlineImportKind;
  readonly symbols: string[];
  readonly alias: string | null;
  readonly specifiers: MainlineImportSpecifier[];
  readonly isTypeOnly: boolean;
  readonly isExportOnly: boolean;
  readonly exportedName?: string;
  readonly line?: number;
}

export type MainlineCallType = "function" | "method" | "constructor";
export type MainlineCallResolution = "same-file" | "unresolved";

export interface MainlineCallSite {
  readonly callee: string;
  readonly callType: MainlineCallType;
  readonly receiver: string | null;
  readonly line: number;
  readonly argCount: number;
  readonly isAwait: boolean;
  readonly callerSymbol?: string;
  readonly targetFqn?: string;
  readonly resolution: MainlineCallResolution;
}

export interface MainlineAstParseRequest {
  path: string;
  content: string;
  language?: LanguageDetection;
}

export interface MainlineAstParseResult {
  path: string;
  languageId: string;
  status: MainlineAstStatus;
  symbols: MainlineSourceSymbol[];
  imports: MainlineImportRecord[];
  callSites: MainlineCallSite[];
  /**
   * 从 Alembic-legacy 迁入的成熟 AST 原始摘要。
   * 中文说明：ProjectIntelligence/CallGraph/Panorama 会优先消费这个结构化事实，
   * 避免再从薄层 symbol/import 结果里二次猜测工程关系。
   */
  legacySummary?: unknown;
  reason?: string;
}

export interface MainlineAstParser {
  parse(request: MainlineAstParseRequest): Promise<MainlineAstParseResult>;
}

/**
 * UnavailableAstParser 显式表达 AST 端口尚未接入。
 * 新主线可以继续 deterministic pipeline，但不会伪造 AST 结果。
 */
export class UnavailableAstParser implements MainlineAstParser {
  async parse(request: MainlineAstParseRequest): Promise<MainlineAstParseResult> {
    return {
      path: request.path,
      languageId: request.language?.languageId ?? "unknown",
      status: "unsupported",
      symbols: [],
      imports: [],
      callSites: [],
      reason: "Mainline AST parser adapter is not configured.",
    };
  }
}
