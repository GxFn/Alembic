import type { MainlineCallSite, MainlineCallType, MainlineSourceSymbol } from "./AstPort.js";

interface CallMatchInput {
  readonly callee: string;
  readonly callType: MainlineCallType;
  readonly receiver: string | null;
  readonly offset: number;
  readonly openParenOffset: number;
}

/**
 * MainlineCallSiteExtractor 只做保守调用点识别：直接调用、成员调用、new 构造调用。
 * 这一层服务主干调用图的早期事实收集，不承担完整语义解析；复杂泛型、动态 callee
 * 和跨文件解析留给后续 tree-sitter adapter/解析器组合处理。
 */
export class MainlineCallSiteExtractor {
  extract(input: {
    readonly path: string;
    readonly content: string;
    readonly languageId: string;
    readonly symbols: readonly MainlineSourceSymbol[];
  }): MainlineCallSite[] {
    switch (input.languageId) {
      case "javascript":
      case "typescript":
        return uniqueCallSites(extractTsJsCallSites(input));
      case "python":
        return uniqueCallSites(extractPythonCallSites(input));
      default:
        return [];
    }
  }
}

export const defaultMainlineCallSiteExtractor = new MainlineCallSiteExtractor();

function extractTsJsCallSites(input: {
  readonly path: string;
  readonly content: string;
  readonly symbols: readonly MainlineSourceSymbol[];
}): MainlineCallSite[] {
  const masked = maskCommentsAndStrings(input.content);
  const matches: CallMatchInput[] = [];

  for (const match of masked.matchAll(/\bnew\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\s*\(/g)) {
    const openParenOffset = (match.index ?? 0) + match[0].lastIndexOf("(");
    matches.push({
      callee: match[1] ?? "",
      callType: "constructor",
      receiver: null,
      offset: match.index ?? 0,
      openParenOffset,
    });
  }

  for (const match of masked.matchAll(
    /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*)\s*\(/g,
  )) {
    const receiver = match[1] ?? "";
    const method = match[2] ?? "";
    if (!receiver || !method || isTsJsDeclarationLine(masked, match.index ?? 0, method)) {
      continue;
    }
    matches.push({
      callee: `${receiver}.${method}`,
      callType: "method",
      receiver,
      offset: match.index ?? 0,
      openParenOffset: (match.index ?? 0) + match[0].lastIndexOf("("),
    });
  }

  for (const match of masked.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1] ?? "";
    const offset = match.index ?? 0;
    if (
      !name ||
      TS_JS_CALL_SKIP_WORDS.has(name) ||
      isPropertyAccess(masked, offset) ||
      isNewExpressionPrefix(masked, offset) ||
      isTsJsDeclarationLine(masked, offset, name)
    ) {
      continue;
    }
    matches.push({
      callee: name,
      callType: "function",
      receiver: null,
      offset,
      openParenOffset: offset + match[0].lastIndexOf("("),
    });
  }

  return matches.map((match) => toCallSite(input, match));
}

function extractPythonCallSites(input: {
  readonly path: string;
  readonly content: string;
  readonly symbols: readonly MainlineSourceSymbol[];
}): MainlineCallSite[] {
  const masked = maskPythonCommentsAndStrings(input.content);
  const matches: CallMatchInput[] = [];

  for (const match of masked.matchAll(
    /\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.([A-Za-z_]\w*)\s*\(/g,
  )) {
    const receiver = match[1] ?? "";
    const method = match[2] ?? "";
    if (!receiver || !method || isPythonDeclarationLine(masked, match.index ?? 0, method)) {
      continue;
    }
    matches.push({
      callee: `${receiver}.${method}`,
      callType: "method",
      receiver,
      offset: match.index ?? 0,
      openParenOffset: (match.index ?? 0) + match[0].lastIndexOf("("),
    });
  }

  for (const match of masked.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    const name = match[1] ?? "";
    const offset = match.index ?? 0;
    if (
      !name ||
      PYTHON_CALL_SKIP_WORDS.has(name) ||
      isPropertyAccess(masked, offset) ||
      isPythonDeclarationLine(masked, offset, name)
    ) {
      continue;
    }
    const sameFileClass = input.symbols.some(
      (symbol) => symbol.kind === "class" && symbol.name === name,
    );
    matches.push({
      callee: name,
      callType: sameFileClass ? "constructor" : "function",
      receiver: null,
      offset,
      openParenOffset: offset + match[0].lastIndexOf("("),
    });
  }

  return matches.map((match) => toCallSite(input, match));
}

function toCallSite(
  input: {
    readonly path: string;
    readonly content: string;
    readonly symbols: readonly MainlineSourceSymbol[];
  },
  match: CallMatchInput,
): MainlineCallSite {
  const line = lineNumberAt(input.content, match.offset);
  const target = resolveSameFileTarget(input.symbols, match);
  const caller = nearestCallerSymbol(input.path, input.symbols, line);
  return {
    callee: match.callee,
    callType: target?.kind === "class" ? "constructor" : match.callType,
    receiver: match.receiver,
    line,
    argCount: countArguments(input.content, match.openParenOffset),
    isAwait: isAwaited(input.content, match.offset),
    ...(caller ? { callerSymbol: caller } : {}),
    ...(target
      ? { targetFqn: symbolFqn(input.path, target), resolution: "same-file" }
      : { resolution: "unresolved" }),
  };
}

function resolveSameFileTarget(
  symbols: readonly MainlineSourceSymbol[],
  match: CallMatchInput,
): MainlineSourceSymbol | undefined {
  if (match.callType === "constructor") {
    const ctorName = match.callee.split(".").pop() ?? match.callee;
    return symbols.find((symbol) => symbol.kind === "class" && symbol.name === ctorName);
  }

  if (match.receiver) {
    return undefined;
  }

  return symbols.find(
    (symbol) =>
      symbol.name === match.callee &&
      (symbol.kind === "function" || symbol.kind === "method" || symbol.kind === "class"),
  );
}

function nearestCallerSymbol(
  path: string,
  symbols: readonly MainlineSourceSymbol[],
  line: number,
): string | undefined {
  const candidates = symbols
    .filter((symbol) => (symbol.startLine ?? 0) > 0 && (symbol.startLine ?? 0) <= line)
    .sort((left, right) => (right.startLine ?? 0) - (left.startLine ?? 0));
  const caller = candidates.find(
    (symbol) => symbol.kind === "function" || symbol.kind === "method",
  );
  return caller ? symbolFqn(path, caller) : undefined;
}

function symbolFqn(path: string, symbol: MainlineSourceSymbol): string {
  return `${path}::${symbol.containerName ? `${symbol.containerName}.` : ""}${symbol.name}`;
}

function isAwaited(content: string, offset: number): boolean {
  const before = content.slice(Math.max(0, offset - 16), offset);
  return /\bawait\s+$/.test(before);
}

function countArguments(content: string, openParenOffset: number): number {
  let depth = 0;
  let commas = 0;
  let hasContent = false;
  let quote: string | null = null;

  for (let index = openParenOffset; index < content.length; index++) {
    const char = content[index] ?? "";
    const previous = content[index - 1] ?? "";
    if (quote) {
      if (char === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      hasContent = true;
      continue;
    }
    if (char === "(") {
      depth += 1;
      if (depth > 1) {
        hasContent = true;
      }
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return hasContent ? commas + 1 : 0;
      }
      continue;
    }
    if (depth === 1) {
      if (char === ",") {
        commas += 1;
      } else if (!/\s/.test(char)) {
        hasContent = true;
      }
    }
  }
  return 0;
}

function isPropertyAccess(content: string, offset: number): boolean {
  return content[offset - 1] === ".";
}

function isNewExpressionPrefix(content: string, offset: number): boolean {
  return /\bnew\s+$/.test(content.slice(Math.max(0, offset - 8), offset));
}

function isTsJsDeclarationLine(content: string, offset: number, name: string): boolean {
  const line = lineAt(content, offset).trim();
  return (
    new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegExp(name)}\\s*\\(`).test(
      line,
    ) ||
    new RegExp(`^(?:export\\s+)?(?:abstract\\s+)?class\\s+${escapeRegExp(name)}\\b`).test(line) ||
    new RegExp(
      `^(?:public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+)*${escapeRegExp(name)}\\s*\\([^)]*\\)\\s*(?::[^=;{]+)?\\{\\s*$`,
    ).test(line)
  );
}

function isPythonDeclarationLine(content: string, offset: number, name: string): boolean {
  const line = lineAt(content, offset).trim();
  return (
    new RegExp(`^(?:async\\s+)?def\\s+${escapeRegExp(name)}\\s*\\(`).test(line) ||
    new RegExp(`^class\\s+${escapeRegExp(name)}\\b`).test(line)
  );
}

function lineAt(content: string, offset: number): string {
  const start = content.lastIndexOf("\n", offset) + 1;
  const end = content.indexOf("\n", offset);
  return content.slice(start, end === -1 ? content.length : end);
}

function lineNumberAt(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++) {
    if (content[index] === "\n") {
      line += 1;
    }
  }
  return line;
}

function maskCommentsAndStrings(content: string): string {
  let result = "";
  let mode: "code" | "line-comment" | "block-comment" | "single" | "double" | "template" = "code";
  for (let index = 0; index < content.length; index++) {
    const char = content[index] ?? "";
    const next = content[index + 1] ?? "";
    const previous = content[index - 1] ?? "";
    if (mode === "line-comment") {
      mode = char === "\n" ? "code" : mode;
      result += char === "\n" ? "\n" : " ";
      continue;
    }
    if (mode === "block-comment") {
      if (char === "*" && next === "/") {
        result += "  ";
        index += 1;
        mode = "code";
      } else {
        result += char === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (mode === "single" || mode === "double" || mode === "template") {
      const end = mode === "single" ? "'" : mode === "double" ? '"' : "`";
      if (char === end && previous !== "\\") {
        mode = "code";
      }
      result += char === "\n" ? "\n" : " ";
      continue;
    }
    if (char === "/" && next === "/") {
      result += "  ";
      index += 1;
      mode = "line-comment";
      continue;
    }
    if (char === "/" && next === "*") {
      result += "  ";
      index += 1;
      mode = "block-comment";
      continue;
    }
    if (char === "'") {
      result += " ";
      mode = "single";
      continue;
    }
    if (char === '"') {
      result += " ";
      mode = "double";
      continue;
    }
    if (char === "`") {
      result += " ";
      mode = "template";
      continue;
    }
    result += char;
  }
  return result;
}

function maskPythonCommentsAndStrings(content: string): string {
  let result = "";
  let quote: string | null = null;
  for (let index = 0; index < content.length; index++) {
    const char = content[index] ?? "";
    const previous = content[index - 1] ?? "";
    if (quote) {
      if (char === quote && previous !== "\\") {
        quote = null;
      }
      result += char === "\n" ? "\n" : " ";
      continue;
    }
    if (char === "#") {
      while (index < content.length && content[index] !== "\n") {
        result += " ";
        index += 1;
      }
      if (content[index] === "\n") {
        result += "\n";
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      result += " ";
      continue;
    }
    result += char;
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueCallSites(callSites: readonly MainlineCallSite[]): MainlineCallSite[] {
  return [
    ...new Map(
      callSites.map((callSite) => [
        `${callSite.callee}\u0000${callSite.callType}\u0000${callSite.line}\u0000${callSite.receiver ?? ""}`,
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

const TS_JS_CALL_SKIP_WORDS = new Set([
  "catch",
  "for",
  "function",
  "if",
  "import",
  "new",
  "return",
  "switch",
  "while",
]);

const PYTHON_CALL_SKIP_WORDS = new Set([
  "class",
  "def",
  "elif",
  "except",
  "for",
  "if",
  "return",
  "while",
]);
