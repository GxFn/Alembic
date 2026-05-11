import path from "node:path";
import type {
  MainlineAstParseRequest,
  MainlineAstParseResult,
  MainlineAstParser,
  MainlineCallSite,
  MainlineCallType,
  MainlineImportKind,
  MainlineImportRecord,
  MainlineSourceSymbol,
} from "./AstPort.js";
import { defaultMainlineLanguageCatalog, type MainlineLanguageCatalog } from "./LanguageCatalog.js";

interface LegacyAstSummary {
  readonly classes?: readonly LegacyClassRecord[];
  readonly protocols?: readonly LegacyProtocolRecord[];
  readonly categories?: readonly LegacyCategoryRecord[];
  readonly methods?: readonly LegacyMethodRecord[];
  readonly properties?: readonly LegacyPropertyRecord[];
  readonly imports?: readonly LegacyImportRecord[];
  readonly exports?: readonly LegacyExportRecord[];
  readonly callSites?: readonly LegacyCallSiteRecord[];
  readonly inheritanceGraph?: readonly LegacyInheritanceEdge[];
  readonly metrics?: unknown;
  readonly patterns?: readonly unknown[];
  readonly references?: readonly unknown[];
}

interface LegacyClassRecord {
  readonly name?: string;
  readonly kind?: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly superclass?: string | null;
  readonly protocols?: readonly string[];
  readonly isDataclass?: boolean;
  readonly decorators?: readonly string[];
}

interface LegacyProtocolRecord {
  readonly name?: string;
  readonly line?: number;
}

interface LegacyCategoryRecord {
  readonly className?: string;
  readonly categoryName?: string;
  readonly name?: string;
  readonly line?: number;
}

interface LegacyMethodRecord {
  readonly name?: string;
  readonly className?: string | null;
  readonly line?: number;
  readonly bodyLines?: number;
  readonly complexity?: number;
  readonly nestingDepth?: number;
  readonly kind?: string;
  readonly isClassMethod?: boolean;
  readonly isAsync?: boolean;
}

interface LegacyPropertyRecord {
  readonly name?: string;
  readonly className?: string | null;
  readonly line?: number;
  readonly typeAnnotation?: string | null;
  readonly isStatic?: boolean;
  readonly isReadonly?: boolean;
}

type LegacyImportRecord =
  | string
  | {
      readonly path?: string;
      readonly kind?: string;
      readonly symbols?: readonly string[];
      readonly alias?: string | null;
      readonly isTypeOnly?: boolean;
      readonly line?: number;
      toString?(): string;
    };

type LegacyExportRecord = string | { readonly name?: string; readonly text?: string };

interface LegacyInheritanceEdge {
  readonly from?: string;
  readonly to?: string;
  readonly type?: string;
}

interface LegacyCallSiteRecord {
  readonly callee?: string;
  readonly callerMethod?: string;
  readonly callerClass?: string | null;
  readonly callType?: string;
  readonly receiver?: string | null;
  readonly argCount?: number;
  readonly line?: number;
  readonly isAwait?: boolean;
}

type LegacyAnalyzeFile = (
  source: string,
  lang: string,
  options?: { readonly extractCallSites?: boolean },
) => LegacyAstSummary | null;

const TREE_SITTER_LANGUAGES = new Set([
  "dart",
  "go",
  "java",
  "javascript",
  "kotlin",
  "objectivec",
  "python",
  "rust",
  "swift",
  "tsx",
  "typescript",
]);

const IMPORT_KINDS = new Set<MainlineImportKind>([
  "named",
  "default",
  "namespace",
  "side-effect",
  "dynamic",
  "commonjs",
  "export",
]);

/**
 * TreeSitterMainlineAstParser 是从 Alembic-legacy 迁入的新主线 AST 核心。
 * 中文说明：冷启动前的工程事实层默认走 web-tree-sitter + legacy language plugins；
 * 轻量 StructuralAstParser 只保留为旧过渡文件，不再作为 ProjectIntelligence 默认核心。
 */
export class TreeSitterMainlineAstParser implements MainlineAstParser {
  readonly #catalog: MainlineLanguageCatalog;

  constructor(catalog: MainlineLanguageCatalog = defaultMainlineLanguageCatalog) {
    this.#catalog = catalog;
  }

  async parse(request: MainlineAstParseRequest): Promise<MainlineAstParseResult> {
    const languageId = this.#catalog.normalize(
      request.language?.languageId ?? this.#catalog.inferLanguageId(request.path),
    );
    const parserLanguageId = treeSitterLanguageId(request.path, languageId);

    if (!TREE_SITTER_LANGUAGES.has(parserLanguageId)) {
      return {
        path: request.path,
        languageId,
        status: "unsupported",
        symbols: [],
        imports: [],
        callSites: [],
        reason: `Tree-sitter mainline parser does not support language: ${languageId}.`,
      };
    }

    await import("./tree-sitter/ast/index.js");
    const astAnalyzer = (await import("./tree-sitter/AstAnalyzer.js")) as {
      readonly analyzeFile: LegacyAnalyzeFile;
      readonly isAvailable: () => boolean;
    };
    if (!astAnalyzer.isAvailable()) {
      throw new Error("Tree-sitter AST analyzer is not available after plugin loading.");
    }

    const summary = astAnalyzer.analyzeFile(request.content, parserLanguageId, {
      extractCallSites: true,
    });
    if (!summary) {
      throw new Error(`Tree-sitter AST analyzer returned no summary for ${request.path}.`);
    }

    const symbols = toMainlineSymbols(summary);
    return {
      path: request.path,
      languageId,
      status: "parsed",
      symbols,
      imports: toMainlineImports(summary.imports ?? []),
      callSites: toMainlineCallSites(request.path, summary.callSites ?? [], symbols),
      legacySummary: summary,
    };
  }
}

function treeSitterLanguageId(filePath: string, languageId: string): string {
  if (path.extname(filePath).toLowerCase() === ".tsx") {
    return "tsx";
  }
  return languageId;
}

function toMainlineSymbols(summary: LegacyAstSummary): MainlineSourceSymbol[] {
  const symbols: MainlineSourceSymbol[] = [];
  const exportNames = legacyExportNames(summary.exports ?? []);

  for (const cls of summary.classes ?? []) {
    const name = cleanName(cls.name);
    if (!name) {
      continue;
    }
    symbols.push({
      name,
      kind: classKind(cls.kind),
      ...(cls.line === undefined ? {} : { startLine: cls.line }),
      ...(cls.endLine === undefined ? {} : { endLine: cls.endLine }),
      isExported: exportNames.has(name),
    });
  }

  for (const protocol of summary.protocols ?? []) {
    const name = cleanName(protocol.name);
    if (!name) {
      continue;
    }
    symbols.push({
      name,
      kind: "interface",
      ...(protocol.line === undefined ? {} : { startLine: protocol.line }),
      isExported: exportNames.has(name),
    });
  }

  for (const category of summary.categories ?? []) {
    const name = categorySymbolName(category);
    if (!name) {
      continue;
    }
    symbols.push({
      name,
      kind: "type",
      ...(category.line === undefined ? {} : { startLine: category.line }),
      isExported: exportNames.has(name),
    });
  }

  for (const method of summary.methods ?? []) {
    const name = cleanName(method.name);
    if (!name) {
      continue;
    }
    const containerName = cleanName(method.className ?? undefined);
    symbols.push({
      name,
      kind: containerName ? "method" : "function",
      ...(method.line === undefined ? {} : { startLine: method.line }),
      ...(containerName ? { containerName } : {}),
      isExported: !containerName && exportNames.has(name),
    });
  }

  for (const property of summary.properties ?? []) {
    const name = cleanName(property.name);
    if (!name) {
      continue;
    }
    const containerName = cleanName(property.className ?? undefined);
    symbols.push({
      name,
      kind: "variable",
      ...(property.line === undefined ? {} : { startLine: property.line }),
      ...(containerName ? { containerName } : {}),
      isExported: !containerName && exportNames.has(name),
    });
  }

  // 中文说明：legacy TS walker 会把 `export const x = true` 记录到 exports，
  // 但不会把普通变量声明放进 properties。这里补成变量符号，保证增量 SourceRef 不丢。
  const declaredNames = new Set(symbols.map((symbol) => symbol.name));
  for (const exportName of exportNames) {
    if (exportName === "default" || declaredNames.has(exportName)) {
      continue;
    }
    symbols.push({
      name: exportName,
      kind: "variable",
      isExported: true,
    });
  }

  return uniqueSymbols(symbols).sort(
    (left, right) =>
      (left.startLine ?? 0) - (right.startLine ?? 0) ||
      left.name.localeCompare(right.name) ||
      left.kind.localeCompare(right.kind),
  );
}

function legacyExportNames(exports: readonly LegacyExportRecord[]): Set<string> {
  const names = new Set<string>();
  for (const entry of exports) {
    if (typeof entry === "string") {
      const name = cleanName(entry);
      if (name) {
        names.add(name);
      }
      continue;
    }
    const explicitName = cleanName(entry.name);
    if (explicitName) {
      names.add(explicitName);
      continue;
    }
    const text = cleanName(entry.text);
    const match = text?.match(
      /export\s+(?:default\s+)?(?:class|function|const|let|var|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/,
    );
    if (match?.[1]) {
      names.add(match[1]);
    }
  }
  return names;
}

function classKind(kind: string | undefined): MainlineSourceSymbol["kind"] {
  switch (kind) {
    case "interface":
      return "interface";
    case "type":
    case "enum":
      return "type";
    default:
      return "class";
  }
}

function categorySymbolName(category: LegacyCategoryRecord): string | undefined {
  const className = cleanName(category.className);
  const categoryName = cleanName(category.categoryName ?? category.name);
  if (className && categoryName) {
    return `${className}(${categoryName})`;
  }
  return className ?? categoryName;
}

function toMainlineImports(imports: readonly LegacyImportRecord[]): MainlineImportRecord[] {
  return uniqueImports(
    imports.flatMap((entry) => {
      const pathValue = importPath(entry);
      if (!pathValue) {
        return [];
      }
      const record = typeof entry === "string" ? {} : entry;
      const kind = importKind(record.kind);
      return [
        {
          path: pathValue,
          kind,
          symbols: stringArray(record.symbols),
          alias: cleanName(record.alias ?? undefined) ?? null,
          specifiers: [],
          isTypeOnly: record.isTypeOnly ?? false,
          isExportOnly: kind === "export",
          ...(record.line === undefined ? {} : { line: record.line }),
        },
      ];
    }),
  );
}

function importPath(entry: LegacyImportRecord): string | undefined {
  if (typeof entry === "string") {
    return cleanName(entry);
  }
  return cleanName(entry.path) ?? cleanName(entry.toString?.());
}

function importKind(kind: string | undefined): MainlineImportKind {
  if (kind && IMPORT_KINDS.has(kind as MainlineImportKind)) {
    return kind as MainlineImportKind;
  }
  return "side-effect";
}

function toMainlineCallSites(
  filePath: string,
  callSites: readonly LegacyCallSiteRecord[],
  symbols: readonly MainlineSourceSymbol[],
): MainlineCallSite[] {
  return uniqueCallSites(
    callSites.flatMap((callSite) => {
      const callee = cleanName(callSite.callee);
      const line = callSite.line;
      if (!callee || line === undefined) {
        return [];
      }
      const target = resolveSameFileTarget(callee, callSite.callType, symbols);
      const callerSymbol = callerFqn(filePath, callSite);
      return [
        {
          callee,
          callType: callType(callSite.callType),
          receiver: cleanName(callSite.receiver ?? undefined) ?? null,
          line,
          argCount: callSite.argCount ?? 0,
          isAwait: callSite.isAwait ?? false,
          ...(callerSymbol === undefined ? {} : { callerSymbol }),
          ...(target === undefined
            ? { resolution: "unresolved" as const }
            : { targetFqn: symbolFqn(filePath, target), resolution: "same-file" as const }),
        },
      ];
    }),
  );
}

function callType(value: string | undefined): MainlineCallType {
  return value === "constructor" ? "constructor" : value === "function" ? "function" : "method";
}

function callerFqn(filePath: string, callSite: LegacyCallSiteRecord): string | undefined {
  const method = cleanName(callSite.callerMethod);
  if (!method) {
    return undefined;
  }
  const cls = cleanName(callSite.callerClass ?? undefined);
  return `${filePath}::${cls ? `${cls}.` : ""}${method}`;
}

function resolveSameFileTarget(
  callee: string,
  type: string | undefined,
  symbols: readonly MainlineSourceSymbol[],
): MainlineSourceSymbol | undefined {
  const shortName = callee.split(".").pop() ?? callee;
  if (type === "constructor") {
    return symbols.find((symbol) => symbol.kind === "class" && symbol.name === shortName);
  }
  return symbols.find(
    (symbol) =>
      symbol.name === shortName &&
      (symbol.kind === "function" || symbol.kind === "method" || symbol.kind === "class"),
  );
}

function symbolFqn(filePath: string, symbol: MainlineSourceSymbol): string {
  return `${filePath}::${symbol.containerName ? `${symbol.containerName}.` : ""}${symbol.name}`;
}

function cleanName(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function stringArray(value: readonly string[] | undefined): string[] {
  return [...new Set((value ?? []).map((entry) => entry.trim()).filter(Boolean))];
}

function uniqueSymbols(symbols: readonly MainlineSourceSymbol[]): MainlineSourceSymbol[] {
  return [
    ...new Map(
      symbols.map((symbol) => [
        `${symbol.kind}\u0000${symbol.name}\u0000${symbol.containerName ?? ""}\u0000${symbol.startLine ?? 0}`,
        symbol,
      ]),
    ).values(),
  ];
}

function uniqueImports(imports: readonly MainlineImportRecord[]): MainlineImportRecord[] {
  return [
    ...new Map(
      imports.map((record) => [
        `${record.kind}\u0000${record.path}\u0000${record.symbols.join(",")}\u0000${record.alias ?? ""}\u0000${record.line ?? 0}`,
        record,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      (left.line ?? 0) - (right.line ?? 0) ||
      left.path.localeCompare(right.path) ||
      left.kind.localeCompare(right.kind),
  );
}

function uniqueCallSites(callSites: readonly MainlineCallSite[]): MainlineCallSite[] {
  return [
    ...new Map(
      callSites.map((callSite) => [
        `${callSite.callee}\u0000${callSite.callType}\u0000${callSite.line}\u0000${callSite.receiver ?? ""}\u0000${callSite.callerSymbol ?? ""}`,
        callSite,
      ]),
    ).values(),
  ].sort(
    (left, right) =>
      left.line - right.line ||
      left.callee.localeCompare(right.callee) ||
      left.callType.localeCompare(right.callType),
  );
}
