import type {
  MainlineAstParseRequest,
  MainlineAstParseResult,
  MainlineAstParser,
  MainlineSourceSymbol,
} from "./AstPort.js";
import { defaultMainlineLanguageCatalog, type MainlineLanguageCatalog } from "./LanguageCatalog.js";
import {
  defaultMainlineCallSiteExtractor,
  type MainlineCallSiteExtractor,
} from "./MainlineCallSiteExtractor.js";
import { defaultMainlineImportParser, type MainlineImportParser } from "./MainlineImportParser.js";

type SymbolKind = MainlineSourceSymbol["kind"];

interface SymbolPattern {
  readonly regex: RegExp;
  readonly kind: SymbolKind | ((match: RegExpMatchArray, content: string) => SymbolKind);
  readonly nameGroup?: number;
}

/**
 * StructuralMainlineAstParser 是新主干的第一版真实源码结构解析器。
 * 它不依赖旧 AstAnalyzer/ProjectGraph，也不启动 tree-sitter 运行时；先稳定产出跨语言符号骨架。
 */
export class StructuralMainlineAstParser implements MainlineAstParser {
  readonly #catalog: MainlineLanguageCatalog;
  readonly #imports: MainlineImportParser;
  readonly #calls: MainlineCallSiteExtractor;

  constructor(
    catalog: MainlineLanguageCatalog = defaultMainlineLanguageCatalog,
    imports: MainlineImportParser = defaultMainlineImportParser,
    calls: MainlineCallSiteExtractor = defaultMainlineCallSiteExtractor,
  ) {
    this.#catalog = catalog;
    this.#imports = imports;
    this.#calls = calls;
  }

  async parse(request: MainlineAstParseRequest): Promise<MainlineAstParseResult> {
    const languageId = this.#catalog.normalize(
      request.language?.languageId ?? this.#catalog.inferLanguageId(request.path),
    );
    const patterns = symbolPatternsFor(languageId);
    if (!patterns) {
      return {
        path: request.path,
        languageId,
        status: "unsupported",
        symbols: [],
        imports: [],
        callSites: [],
        reason: `Mainline structural AST parser does not support language: ${languageId}.`,
      };
    }

    const symbols = extractSymbols(request.content, patterns, languageId);
    const imports = this.#imports.parse(request.content, languageId);
    return {
      path: request.path,
      languageId,
      status: "parsed",
      symbols,
      imports,
      callSites: this.#calls.extract({
        path: request.path,
        content: request.content,
        languageId,
        symbols,
      }),
    };
  }
}

function symbolPatternsFor(languageId: string): readonly SymbolPattern[] | undefined {
  switch (languageId) {
    case "javascript":
    case "typescript":
      return TS_JS_PATTERNS;
    case "python":
      return PYTHON_PATTERNS;
    case "swift":
      return SWIFT_PATTERNS;
    case "rust":
      return RUST_PATTERNS;
    case "go":
      return GO_PATTERNS;
    case "java":
      return JAVA_PATTERNS;
    case "kotlin":
      return KOTLIN_PATTERNS;
    default:
      return undefined;
  }
}

const TS_JS_PATTERNS: readonly SymbolPattern[] = [
  {
    regex: /\b(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    kind: "class",
  },
  { regex: /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g, kind: "interface" },
  { regex: /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/g, kind: "type" },
  {
    regex: /\b(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    kind: "function",
  },
  {
    regex: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
    kind: (match, content) => inferTsVariableKind(match, content),
  },
  {
    regex:
      /^[ \t]*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*{/gm,
    kind: (match) => (isReservedMethodName(match[1] ?? "") ? "unknown" : "method"),
  },
];

const PYTHON_PATTERNS: readonly SymbolPattern[] = [
  { regex: /^[ \t]*class\s+([A-Za-z_]\w*)/gm, kind: "class" },
  {
    regex: /^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm,
    kind: (match) => ((match[1]?.length ?? 0) > 0 ? "method" : "function"),
    nameGroup: 2,
  },
];

const SWIFT_PATTERNS: readonly SymbolPattern[] = [
  {
    regex: /\b(?:open|public|internal|fileprivate|private)?\s*class\s+([A-Za-z_]\w*)/g,
    kind: "class",
  },
  { regex: /\b(?:public|internal|fileprivate|private)?\s*struct\s+([A-Za-z_]\w*)/g, kind: "class" },
  { regex: /\b(?:public|internal|fileprivate|private)?\s*enum\s+([A-Za-z_]\w*)/g, kind: "type" },
  {
    regex: /\b(?:public|internal|fileprivate|private)?\s*protocol\s+([A-Za-z_]\w*)/g,
    kind: "interface",
  },
  {
    regex:
      /^([ \t]*)(?:open\s+|public\s+|internal\s+|fileprivate\s+|private\s+|static\s+|class\s+)*func\s+([A-Za-z_]\w*)\s*\(/gm,
    kind: (match) => ((match[1]?.length ?? 0) > 0 ? "method" : "function"),
    nameGroup: 2,
  },
  { regex: /\b(?:let|var)\s+([A-Za-z_]\w*)\b/g, kind: "variable" },
];

const RUST_PATTERNS: readonly SymbolPattern[] = [
  { regex: /\b(?:pub\s+)?struct\s+([A-Za-z_]\w*)/g, kind: "class" },
  { regex: /\b(?:pub\s+)?enum\s+([A-Za-z_]\w*)/g, kind: "type" },
  { regex: /\b(?:pub\s+)?trait\s+([A-Za-z_]\w*)/g, kind: "interface" },
  { regex: /\b(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(/g, kind: "function" },
  { regex: /\b(?:pub\s+)?(?:const|static)\s+([A-Za-z_]\w*)\b/g, kind: "variable" },
];

const GO_PATTERNS: readonly SymbolPattern[] = [
  { regex: /\btype\s+([A-Za-z_]\w*)\s+struct\b/g, kind: "class" },
  { regex: /\btype\s+([A-Za-z_]\w*)\s+interface\b/g, kind: "interface" },
  { regex: /\btype\s+([A-Za-z_]\w*)\b/g, kind: "type" },
  { regex: /\bfunc\s+\([^)]*\)\s*([A-Za-z_]\w*)\s*\(/g, kind: "method" },
  { regex: /\bfunc\s+([A-Za-z_]\w*)\s*\(/g, kind: "function" },
  { regex: /\b(?:var|const)\s+([A-Za-z_]\w*)\b/g, kind: "variable" },
];

const JAVA_PATTERNS: readonly SymbolPattern[] = [
  {
    regex: /\b(?:public|protected|private|abstract|final|static|\s)*class\s+([A-Za-z_]\w*)/g,
    kind: "class",
  },
  {
    regex: /\b(?:public|protected|private|abstract|static|\s)*interface\s+([A-Za-z_]\w*)/g,
    kind: "interface",
  },
  { regex: /\b(?:public|protected|private|static|final|\s)*enum\s+([A-Za-z_]\w*)/g, kind: "type" },
  {
    regex:
      /\b(?:public|protected|private|static|final|synchronized|abstract|\s)+[A-Za-z_<>,.?[\]\s]+\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*[{;]/g,
    kind: (match) => (isReservedMethodName(match[1] ?? "") ? "unknown" : "method"),
  },
];

const KOTLIN_PATTERNS: readonly SymbolPattern[] = [
  { regex: /\b(?:data\s+|sealed\s+|open\s+)?class\s+([A-Za-z_]\w*)/g, kind: "class" },
  { regex: /\binterface\s+([A-Za-z_]\w*)/g, kind: "interface" },
  { regex: /\btypealias\s+([A-Za-z_]\w*)/g, kind: "type" },
  { regex: /\bfun\s+([A-Za-z_]\w*)\s*\(/g, kind: "function" },
  { regex: /\b(?:val|var)\s+([A-Za-z_]\w*)\b/g, kind: "variable" },
];

function extractSymbols(
  content: string,
  patterns: readonly SymbolPattern[],
  languageId: string,
): MainlineSourceSymbol[] {
  const symbols: MainlineSourceSymbol[] = [];
  const lineIndex = createLineIndex(content);

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern.regex)) {
      const name = match[pattern.nameGroup ?? 1]?.trim();
      if (!name) {
        continue;
      }
      const kind = typeof pattern.kind === "function" ? pattern.kind(match, content) : pattern.kind;
      if (kind === "unknown") {
        continue;
      }
      symbols.push({
        name,
        kind,
        startLine: lineNumberAt(match.index ?? 0, lineIndex),
      });
    }
  }

  return enrichSymbols(uniqueSymbols(symbols), content, languageId).sort(
    (left, right) =>
      (left.startLine ?? 0) - (right.startLine ?? 0) ||
      left.name.localeCompare(right.name) ||
      left.kind.localeCompare(right.kind),
  );
}

function enrichSymbols(
  symbols: readonly MainlineSourceSymbol[],
  content: string,
  languageId: string,
): MainlineSourceSymbol[] {
  const localExports = collectLocalExportNames(content);
  const classSymbols = symbols
    .filter((symbol) => symbol.kind === "class")
    .sort((left, right) => (left.startLine ?? 0) - (right.startLine ?? 0));

  return symbols.map((symbol) => {
    const lineText = lineTextAt(content, symbol.startLine ?? 0);
    const exportedByDeclaration =
      languageId !== "python" && /^\s*export\b/.test(lineText) && !/^\s*export\s+\{/.test(lineText);
    const exportedByList = localExports.has(symbol.name);
    const containerName =
      symbol.kind === "method"
        ? nearestClassName(classSymbols, symbol.startLine ?? 0)
        : (symbol.containerName ?? null);
    return {
      ...symbol,
      ...(containerName ? { containerName } : {}),
      isExported: exportedByDeclaration || exportedByList || symbol.isExported === true,
      ...(exportedByDeclaration && /\bexport\s+default\b/.test(lineText)
        ? { exportName: "default" }
        : {}),
    };
  });
}

function collectLocalExportNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const match of content.matchAll(/^\s*export\s+(?:type\s+)?\{([^}]+)\}/gm)) {
    for (const part of (match[1] ?? "").split(",")) {
      const [localRaw] = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/);
      const local = (localRaw ?? "").trim();
      if (local) {
        names.add(local);
      }
    }
  }
  return names;
}

function nearestClassName(
  classSymbols: readonly MainlineSourceSymbol[],
  line: number,
): string | null {
  let nearest: MainlineSourceSymbol | undefined;
  for (const symbol of classSymbols) {
    if ((symbol.startLine ?? 0) < line) {
      nearest = symbol;
    }
  }
  return nearest?.name ?? null;
}

function lineTextAt(content: string, line: number): string {
  if (line <= 0) {
    return "";
  }
  return content.split(/\r?\n/)[line - 1] ?? "";
}

function inferTsVariableKind(match: RegExpMatchArray, content: string): SymbolKind {
  const afterMatch = content.slice(
    (match.index ?? 0) + match[0].length,
    (match.index ?? 0) + match[0].length + 80,
  );
  if (/^\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(afterMatch)) {
    return "function";
  }
  if (/^\s*function\b/.test(afterMatch)) {
    return "function";
  }
  return "variable";
}

function isReservedMethodName(name: string): boolean {
  return new Set(["if", "for", "while", "switch", "catch", "function"]).has(name);
}

function createLineIndex(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index++) {
    if (content[index] === "\n") {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineNumberAt(offset: number, lineStarts: readonly number[]): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const lineStart = lineStarts[mid] ?? 0;
    if (lineStart <= offset) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return high + 1;
}

function uniqueSymbols(symbols: readonly MainlineSourceSymbol[]): MainlineSourceSymbol[] {
  return [
    ...new Map(
      symbols.map((symbol) => [
        `${symbol.kind}\u0000${symbol.name}\u0000${symbol.startLine ?? 0}`,
        symbol,
      ]),
    ).values(),
  ];
}
