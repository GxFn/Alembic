import type {
  EngineeringCodeAstCallSiteFact,
  EngineeringCodeAstExportFact,
  EngineeringCodeAstImportFact,
  EngineeringCodeAstLanguageId,
  EngineeringCodeAstTextFact,
} from "./facts.js";
import {
  arrayRecords,
  asRecord,
  compareCallSite,
  normalizeLanguageId,
  numberOrNull,
  stringOrNull,
} from "./normalizer-utils.js";

export function importsFromTextFacts(
  facts: readonly EngineeringCodeAstTextFact[],
  languageId: EngineeringCodeAstLanguageId | string,
): EngineeringCodeAstImportFact[] {
  return facts.flatMap((fact) => parseImportText(fact.text, fact.languageId ?? languageId));
}

export function callSitesFromTextFacts(
  facts: readonly EngineeringCodeAstTextFact[],
  filePath: string,
  languageId: EngineeringCodeAstLanguageId | string,
): EngineeringCodeAstCallSiteFact[] {
  return facts.flatMap((fact) =>
    parseCallSitesFromText(fact.text, {
      filePath: fact.filePath ?? filePath,
      languageId: fact.languageId ?? languageId,
      callerClass: fact.callerClass ?? null,
      callerMethod: fact.callerMethod ?? "(top-level)",
      line: fact.line ?? null,
    }),
  );
}

export function importsFromTreeSitterNodes(
  value: unknown,
  languageId: EngineeringCodeAstLanguageId | string,
): EngineeringCodeAstImportFact[] {
  return flattenTreeSitterNodes(value)
    .filter((node) => importLikeNodeTypes.has(node.type))
    .flatMap((node) => parseImportText(node.text, languageId));
}

export function callSitesFromTreeSitterNodes(
  value: unknown,
  filePath: string,
  languageId: EngineeringCodeAstLanguageId | string,
): EngineeringCodeAstCallSiteFact[] {
  return flattenTreeSitterNodes(value)
    .filter((node) => callLikeNodeTypes.has(node.type))
    .flatMap((node) => {
      const row = numberOrNull(asRecord(node.startPosition).row);
      return parseCallSitesFromText(node.text, {
        filePath,
        languageId,
        callerClass: null,
        callerMethod: "(top-level)",
        line: row === null ? null : row + 1,
      });
    });
}

export function parseImportText(
  text: string,
  languageId: EngineeringCodeAstLanguageId | string,
): EngineeringCodeAstImportFact[] {
  const imports: EngineeringCodeAstImportFact[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const normalizedLanguage = normalizeLanguageId(languageId);

  for (const line of lines) {
    if (["typescript", "javascript", "tsx"].includes(normalizedLanguage)) {
      imports.push(...parseEcmaImport(line));
    } else if (normalizedLanguage === "python") {
      imports.push(...parsePythonImport(line));
    } else if (normalizedLanguage === "swift") {
      imports.push(...parseSwiftImport(line));
    } else if (["objective-c", "objc"].includes(normalizedLanguage)) {
      imports.push(...parseObjCImport(line));
    } else if (["java", "kotlin"].includes(normalizedLanguage)) {
      imports.push(...parseJvmImport(line, normalizedLanguage));
    } else if (normalizedLanguage === "go") {
      imports.push(...parseGoImport(line));
    } else if (normalizedLanguage === "rust") {
      imports.push(...parseRustImport(line));
    } else if (normalizedLanguage === "dart") {
      imports.push(...parseDartImport(line));
    } else {
      imports.push(...parseEcmaImport(line), ...parsePythonImport(line), ...parseSwiftImport(line));
    }
  }

  return dedupeImports(imports);
}

export function parseExportText(
  text: string,
  languageId: EngineeringCodeAstLanguageId | string,
  filePath: string,
): EngineeringCodeAstExportFact[] {
  const exports: EngineeringCodeAstExportFact[] = [];
  if (["typescript", "javascript", "tsx"].includes(normalizeLanguageId(languageId))) {
    const declaration = text.match(
      /export\s+(?:default\s+)?(?:abstract\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    );
    if (declaration?.[1]) {
      exports.push({ name: declaration[1], kind: "declaration", filePath, line: null, text });
    }
    const named = text.match(/export\s*\{([^}]+)\}/);
    if (named?.[1]) {
      for (const name of symbolsFromBraceClause(`{${named[1]}}`)) {
        exports.push({ name, kind: "named", filePath, line: null, text });
      }
    }
    if (text.includes("export default")) {
      exports.push({ name: "default", kind: "default", filePath, line: null, text });
    }
  }
  return exports;
}

export function parseCallSitesFromText(
  text: string,
  context: {
    readonly filePath: string;
    readonly languageId: string;
    readonly callerClass: string | null;
    readonly callerMethod: string;
    readonly line: number | null;
  },
): EngineeringCodeAstCallSiteFact[] {
  if (["objective-c", "objc"].includes(normalizeLanguageId(context.languageId))) {
    return parseObjCCallSites(text, context);
  }
  const calls: EngineeringCodeAstCallSiteFact[] = [];
  const pattern =
    /\b(?:(await)\s+)?(?:(new)\s+)?([A-Za-z_$][\w$]*(?:(?:\.|::)[A-Za-z_$][\w$]*)*)\s*\(([^)]*)\)/g;
  for (const match of text.matchAll(pattern)) {
    const expression = match[3] ?? "";
    if (!expression || isCallNoise(expression)) {
      continue;
    }
    const separator = expression.includes("::") ? "::" : ".";
    const parts = expression.split(separator);
    const callee = parts.at(-1) ?? expression;
    const receiver = parts.length > 1 ? parts.slice(0, -1).join(separator) : null;
    const isConstructor = Boolean(match[2]) || (!receiver && /^[A-Z]/.test(callee));
    calls.push({
      callee,
      callerMethod: context.callerMethod,
      callerClass: context.callerClass,
      callType: match[2]
        ? "constructor"
        : receiver === "super"
          ? "super"
          : receiver && /^[A-Z]/.test(receiver)
            ? "static"
            : receiver
              ? "method"
              : isConstructor
                ? "constructor"
                : "function",
      receiver,
      receiverType: isConstructor ? callee : receiver && /^[A-Z]/.test(receiver) ? receiver : null,
      argCount: countArguments(match[4] ?? ""),
      line: context.line,
      isAwait: Boolean(match[1]),
      filePath: context.filePath,
      snippet: text,
      languageId: context.languageId,
    });
  }
  return calls;
}

export function dedupeImports(
  imports: readonly EngineeringCodeAstImportFact[],
): EngineeringCodeAstImportFact[] {
  return dedupeBy(
    imports.filter((item) => item.path),
    (item) =>
      [
        item.path,
        item.kind ?? "",
        item.alias ?? "",
        item.symbols.join(","),
        item.isExportOnly ? "export" : "",
      ].join("\0"),
  );
}

export function dedupeCallSites(
  callSites: readonly EngineeringCodeAstCallSiteFact[],
): EngineeringCodeAstCallSiteFact[] {
  return dedupeBy(callSites, (item) =>
    [
      item.filePath,
      item.line ?? "",
      item.callerClass ?? "",
      item.callerMethod,
      item.receiver ?? "",
      item.callee,
      item.argCount,
    ].join("\0"),
  ).sort(compareCallSite);
}

export function inferCallType(callee: string, receiver: string | null): string {
  if (receiver === "super") {
    return "super";
  }
  if (receiver) {
    return /^[A-Z]/.test(receiver) ? "static" : "method";
  }
  return /^[A-Z]/.test(callee) ? "constructor" : "function";
}

function parseEcmaImport(line: string): EngineeringCodeAstImportFact[] {
  const importFrom = line.match(/^(import|export)\s+(type\s+)?(.+?)\s+from\s+["']([^"']+)["']/);
  const bare = line.match(/^import\s+["']([^"']+)["']/);
  const dynamic = line.match(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/);
  if (bare?.[1]) {
    return [{ path: bare[1], kind: "side-effect", symbols: [], alias: null, raw: line }];
  }
  if (dynamic?.[1]) {
    return [{ path: dynamic[1], kind: "dynamic", symbols: [], alias: null, raw: line }];
  }
  if (!importFrom?.[4]) {
    return [];
  }
  const clause = importFrom[3]?.trim() ?? "";
  const symbols = symbolsFromBraceClause(clause);
  const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  const defaultImport = clause.match(/^([A-Za-z_$][\w$]*)(?:\s*,|$)/);
  const alias = namespace?.[1] ?? (symbols.length === 0 ? defaultImport?.[1] : undefined) ?? null;
  const kind = namespace
    ? "namespace"
    : symbols.length > 0
      ? "named"
      : defaultImport
        ? "default"
        : "side-effect";
  return [
    {
      path: importFrom[4],
      kind,
      symbols: symbols.length > 0 ? symbols : defaultImport?.[1] ? [defaultImport[1]] : [],
      alias,
      isTypeOnly: Boolean(importFrom[2]) || /^type\b/.test(clause),
      isExportOnly: importFrom[1] === "export",
      raw: line,
    },
  ];
}

function parsePythonImport(line: string): EngineeringCodeAstImportFact[] {
  const fromImport = line.match(/^from\s+([\w.]+|\.+[\w.]*)\s+import\s+(.+)$/);
  if (fromImport?.[1] && fromImport[2]) {
    const symbols = fromImport[2]
      .split(",")
      .map((part) => part.trim().split(/\s+as\s+/i)[0] ?? "")
      .filter(Boolean);
    const alias = fromImport[2].match(/^\w+\s+as\s+(\w+)$/)?.[1] ?? null;
    return [
      {
        path: fromImport[1],
        kind: symbols.includes("*") ? "namespace" : "named",
        symbols,
        alias,
        raw: line,
      },
    ];
  }
  const importLine = line.match(/^import\s+(.+)$/);
  if (!importLine?.[1]) {
    return [];
  }
  return importLine[1].split(",").map((part) => {
    const [pathPart, aliasPart] = part.trim().split(/\s+as\s+/i);
    const path = pathPart ?? "";
    return {
      path,
      kind: "namespace",
      symbols: ["*"],
      alias: aliasPart ?? path.split(".").at(-1) ?? path,
      raw: line,
    };
  });
}

function parseSwiftImport(line: string): EngineeringCodeAstImportFact[] {
  const match = line.match(/^(?:@testable\s+)?import\s+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)/);
  if (!match?.[1]) {
    return [];
  }
  return [{ path: match[1], kind: "namespace", symbols: ["*"], alias: match[1], raw: line }];
}

function parseObjCImport(line: string): EngineeringCodeAstImportFact[] {
  const importMatch = line.match(/^#(?:import|include)\s+[<"]([^>"]+)[>"]/);
  if (importMatch?.[1]) {
    return [{ path: importMatch[1], kind: "header", symbols: [], alias: null, raw: line }];
  }
  const forward = line.match(/^@class\s+(.+);?$/);
  if (!forward?.[1]) {
    return [];
  }
  return [
    {
      path: "(forward-declaration)",
      kind: "forward-declare",
      symbols: forward[1]
        .replace(/;$/, "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
      alias: null,
      raw: line,
    },
  ];
}

function parseJvmImport(
  line: string,
  languageId: EngineeringCodeAstLanguageId | string,
): EngineeringCodeAstImportFact[] {
  const match = line.match(/^import\s+(static\s+)?([\w.*]+)(?:\s+as\s+(\w+))?;?$/);
  if (!match?.[2]) {
    return [];
  }
  const fullPath = match[2];
  const wildcard = fullPath.endsWith(".*");
  const parts = fullPath.split(".");
  const symbol = wildcard ? "*" : (parts.at(-1) ?? fullPath);
  return [
    {
      path: wildcard ? fullPath.replace(/\.\*$/, "") : parts.slice(0, -1).join(".") || fullPath,
      kind: wildcard ? "namespace" : match[1] ? "static" : "named",
      symbols: [symbol],
      alias: match[3] ?? null,
      raw: `${languageId}:${line}`,
    },
  ];
}

function parseGoImport(line: string): EngineeringCodeAstImportFact[] {
  const match = line.match(/^(?:import\s+)?(?:(\.|_|[A-Za-z_]\w*)\s+)?["`]([^"`]+)["`]$/);
  if (!match?.[2]) {
    return [];
  }
  const aliasToken = match[1] ?? null;
  const path = match[2];
  const alias =
    aliasToken && ![".", "_"].includes(aliasToken) ? aliasToken : (path.split("/").at(-1) ?? path);
  return [
    {
      path,
      kind: aliasToken === "_" ? "side-effect" : aliasToken === "." ? "named" : "namespace",
      symbols: aliasToken === "." ? ["*"] : [],
      alias,
      raw: line,
    },
  ];
}

function parseRustImport(line: string): EngineeringCodeAstImportFact[] {
  const match = line.match(/^(?:pub\s+)?use\s+(.+?);?$/);
  if (!match?.[1]) {
    return [];
  }
  const body = match[1].replace(/;$/, "");
  const brace = body.match(/^(.*)::\{(.+)\}$/);
  if (brace?.[1] && brace[2]) {
    return [
      {
        path: brace[1],
        kind: "named",
        symbols: brace[2]
          .split(",")
          .map((part) => part.trim().split(/\s+as\s+/)[0] ?? "")
          .filter(Boolean),
        alias: null,
        raw: line,
      },
    ];
  }
  const wildcard = body.endsWith("::*");
  return [
    {
      path: wildcard ? body.replace(/::\*$/, "") : body,
      kind: wildcard ? "namespace" : "named",
      symbols: wildcard ? ["*"] : [body.split("::").at(-1) ?? body],
      alias: body.match(/\s+as\s+(\w+)$/)?.[1] ?? null,
      raw: line,
    },
  ];
}

function parseDartImport(line: string): EngineeringCodeAstImportFact[] {
  const match = line.match(
    /^(import|export)\s+["']([^"']+)["'](?:\s+as\s+(\w+))?(?:\s+show\s+([^;]+))?/,
  );
  if (!match?.[2]) {
    return [];
  }
  const symbols =
    match[4]
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean) ?? [];
  return [
    {
      path: match[2],
      kind: match[3] ? "namespace" : symbols.length > 0 ? "named" : "namespace",
      symbols: symbols.length > 0 ? symbols : ["*"],
      alias: match[3] ?? null,
      isExportOnly: match[1] === "export",
      raw: line,
    },
  ];
}

function parseObjCCallSites(
  text: string,
  context: {
    readonly filePath: string;
    readonly languageId: string;
    readonly callerClass: string | null;
    readonly callerMethod: string;
    readonly line: number | null;
  },
): EngineeringCodeAstCallSiteFact[] {
  const calls: EngineeringCodeAstCallSiteFact[] = [];
  for (const match of text.matchAll(/\[([A-Za-z_]\w*)\s+([A-Za-z_]\w*:?)((?:\s+[^\]]*)?)\]/g)) {
    const receiver = match[1] ?? "";
    const selectorHead = (match[2] ?? "").replace(/:$/, "");
    if (!receiver || !selectorHead) {
      continue;
    }
    const selectorTail = match[3] ?? "";
    calls.push({
      callee: selectorHead,
      callerMethod: context.callerMethod,
      callerClass: context.callerClass,
      callType: receiver === "super" ? "super" : /^[A-Z]/.test(receiver) ? "static" : "method",
      receiver,
      receiverType: /^[A-Z]/.test(receiver) ? receiver : null,
      argCount: Math.max(
        0,
        (selectorTail.match(/:/g) ?? []).length + (match[2]?.includes(":") ? 1 : 0),
      ),
      line: context.line,
      isAwait: false,
      filePath: context.filePath,
      snippet: text,
      languageId: context.languageId,
    });
  }
  return calls;
}

function symbolsFromBraceClause(clause: string): string[] {
  const match = clause.match(/\{([^}]+)\}/);
  if (!match?.[1]) {
    return [];
  }
  return match[1]
    .split(",")
    .map(
      (part) =>
        part
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/i)
          .at(-1) ?? "",
    )
    .filter(Boolean);
}

function flattenTreeSitterNodes(value: unknown): readonly TreeSitterLikeNode[] {
  const nodes: TreeSitterLikeNode[] = [];
  const queue = Array.isArray(value) ? [...value] : [value];
  while (queue.length > 0) {
    const item = queue.shift();
    const record = asRecord(item);
    const type = stringOrNull(record.type);
    const text = stringOrNull(record.text);
    if (type && text) {
      nodes.push({ type, text, startPosition: asRecord(record.startPosition) });
    }
    queue.push(...arrayRecords(record.namedChildren), ...arrayRecords(record.children));
  }
  return nodes;
}

interface TreeSitterLikeNode {
  readonly type: string;
  readonly text: string;
  readonly startPosition: Record<string, unknown>;
}

const importLikeNodeTypes = new Set([
  "import_statement",
  "export_statement",
  "import_declaration",
  "import_from_statement",
  "import_spec",
  "import_header",
  "import_directive",
  "use_declaration",
  "use_item",
  "library_import",
  "import_or_export",
]);

const callLikeNodeTypes = new Set([
  "call_expression",
  "new_expression",
  "method_invocation",
  "object_creation_expression",
  "method_call_expression",
  "function_expression_invocation",
  "selector_expression",
  "call",
]);

function dedupeBy<T>(items: readonly T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

function countArguments(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return trimmed.split(",").filter((part) => part.trim()).length;
}

function isCallNoise(expression: string): boolean {
  const receiver = expression.split(/[.:]/)[0] ?? expression;
  const callee = expression.split(/[.:]/).at(-1) ?? expression;
  return (
    ["console", "Math", "JSON", "Object", "Array", "String", "Number", "print"].includes(
      receiver,
    ) || ["log", "warn", "error", "require", "import", "len", "range", "print"].includes(callee)
  );
}
