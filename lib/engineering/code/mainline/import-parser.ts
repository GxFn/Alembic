import type {
  MainlineImportKind,
  MainlineImportRecord,
  MainlineImportSpecifier,
} from "./ast-port.js";

interface ImportRecordInput {
  readonly path: string;
  readonly kind: MainlineImportKind;
  readonly symbols?: string[];
  readonly alias?: string | null;
  readonly specifiers?: MainlineImportSpecifier[];
  readonly isTypeOnly?: boolean;
  readonly isExportOnly?: boolean;
  readonly exportedName?: string;
  readonly line?: number;
}

/**
 * MainlineImportParser 是新主干的轻量导入解析层。
 * 它只用稳定字符串规则抽取 import/export/require 的可用事实，避免把旧 AstAnalyzer
 * 或 tree-sitter 运行时提前绑进主干；未来 tree-sitter adapter 可以复用同一批输出类型。
 */
export class MainlineImportParser {
  parse(content: string, languageId: string): MainlineImportRecord[] {
    switch (languageId) {
      case "javascript":
      case "typescript":
        return uniqueImports(parseTsJsImports(content));
      case "python":
        return uniqueImports(parsePythonImports(content));
      default:
        return [];
    }
  }
}

export const defaultMainlineImportParser = new MainlineImportParser();

function parseTsJsImports(content: string): MainlineImportRecord[] {
  const records: MainlineImportRecord[] = [];

  for (const match of content.matchAll(/^\s*import\s+(['"])([^'"]+)\1\s*;?/gm)) {
    records.push(
      createImportRecord({
        path: match[2] ?? "",
        kind: "side-effect",
        line: lineNumberAt(content, match.index ?? 0),
      }),
    );
  }

  for (const match of content.matchAll(
    /^\s*import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2\s*;?/gm,
  )) {
    const clause = normalizeWhitespace(match[1] ?? "");
    const path = match[3] ?? "";
    const line = lineNumberAt(content, match.index ?? 0);
    records.push(...parseTsImportClause(path, clause, line));
  }

  for (const match of content.matchAll(
    /^\s*export\s+(type\s+)?\{([\s\S]*?)\}\s*(?:from\s+(['"])([^'"]+)\3)?\s*;?/gm,
  )) {
    const isTypeOnly = Boolean(match[1]);
    const path = match[4] ?? "";
    const line = lineNumberAt(content, match.index ?? 0);
    for (const specifier of parseNamedSpecifiers(match[2] ?? "", isTypeOnly)) {
      records.push(
        createImportRecord({
          path,
          kind: "export",
          symbols: [specifier.imported],
          alias: specifier.local === specifier.imported ? null : specifier.local,
          specifiers: [specifier],
          isTypeOnly: specifier.isTypeOnly ?? isTypeOnly,
          isExportOnly: true,
          exportedName: specifier.local,
          line,
        }),
      );
    }
  }

  for (const match of content.matchAll(
    /^\s*export\s+\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s*)?from\s+(['"])([^'"]+)\2\s*;?/gm,
  )) {
    records.push(
      createImportRecord({
        path: match[3] ?? "",
        kind: "export",
        symbols: ["*"],
        alias: match[1] ?? null,
        isExportOnly: true,
        exportedName: match[1] ?? "*",
        line: lineNumberAt(content, match.index ?? 0),
      }),
    );
  }

  for (const match of content.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s*)?import\s*\(\s*(['"])([^'"]+)\2\s*\)/g,
  )) {
    records.push(
      createImportRecord({
        path: match[3] ?? "",
        kind: "dynamic",
        symbols: ["*"],
        alias: match[1] ?? null,
        line: lineNumberAt(content, match.index ?? 0),
      }),
    );
  }

  for (const match of content.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    records.push(
      createImportRecord({
        path: match[2] ?? "",
        kind: "dynamic",
        symbols: [],
        alias: null,
        line: lineNumberAt(content, match.index ?? 0),
      }),
    );
  }

  for (const match of content.matchAll(
    /\b(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\s*\(\s*(['"])([^'"]+)\2\s*\)/g,
  )) {
    const line = lineNumberAt(content, match.index ?? 0);
    for (const specifier of parseCommonJsDestructureSpecifiers(match[1] ?? "")) {
      records.push(
        createImportRecord({
          path: match[3] ?? "",
          kind: "commonjs",
          symbols: [specifier.imported],
          alias: specifier.local === specifier.imported ? null : specifier.local,
          specifiers: [specifier],
          line,
        }),
      );
    }
  }

  for (const match of content.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*(['"])([^'"]+)\2\s*\)/g,
  )) {
    records.push(
      createImportRecord({
        path: match[3] ?? "",
        kind: "commonjs",
        symbols: ["*"],
        alias: match[1] ?? null,
        line: lineNumberAt(content, match.index ?? 0),
      }),
    );
  }

  for (const match of content.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    records.push(
      createImportRecord({
        path: match[2] ?? "",
        kind: "commonjs",
        symbols: [],
        alias: null,
        line: lineNumberAt(content, match.index ?? 0),
      }),
    );
  }

  return records;
}

function parseTsImportClause(
  path: string,
  rawClause: string,
  line: number,
): MainlineImportRecord[] {
  const records: MainlineImportRecord[] = [];
  const clause = rawClause.startsWith("type ") ? rawClause.slice(5).trim() : rawClause;
  const isTypeOnly = rawClause.startsWith("type ");

  const namedMatch = clause.match(/\{([\s\S]*)\}/);
  if (namedMatch) {
    for (const specifier of parseNamedSpecifiers(namedMatch[1] ?? "", isTypeOnly)) {
      records.push(
        createImportRecord({
          path,
          kind: "named",
          symbols: [specifier.imported],
          alias: specifier.local === specifier.imported ? null : specifier.local,
          specifiers: [specifier],
          isTypeOnly: specifier.isTypeOnly ?? isTypeOnly,
          line,
        }),
      );
    }
  }

  const namespaceMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespaceMatch) {
    records.push(
      createImportRecord({
        path,
        kind: "namespace",
        symbols: ["*"],
        alias: namespaceMatch[1] ?? null,
        isTypeOnly,
        line,
      }),
    );
  }

  const defaultPart = clause.split(",")[0]?.trim() ?? "";
  if (
    defaultPart &&
    !defaultPart.startsWith("{") &&
    !defaultPart.startsWith("*") &&
    /^[A-Za-z_$][\w$]*$/.test(defaultPart)
  ) {
    records.push(
      createImportRecord({
        path,
        kind: "default",
        symbols: ["default"],
        alias: defaultPart,
        specifiers: [{ imported: "default", local: defaultPart, isTypeOnly }],
        isTypeOnly,
        line,
      }),
    );
  }

  return records;
}

function parseNamedSpecifiers(raw: string, inheritedTypeOnly = false): MainlineImportSpecifier[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const typeOnly = inheritedTypeOnly || part.startsWith("type ");
      const withoutType = part.replace(/^type\s+/, "").trim();
      const [importedRaw, localRaw] = withoutType.split(/\s+as\s+/);
      const imported = (importedRaw ?? "").trim();
      return {
        imported,
        local: (localRaw ?? imported).trim(),
        isTypeOnly: typeOnly,
      };
    })
    .filter((specifier) => Boolean(specifier.imported && specifier.local));
}

function parseCommonJsDestructureSpecifiers(raw: string): MainlineImportSpecifier[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [importedRaw, localRaw] = part.split(/\s*:\s*/);
      const imported = (importedRaw ?? "").trim();
      return {
        imported,
        local: (localRaw ?? imported).trim(),
      };
    })
    .filter((specifier) => Boolean(specifier.imported && specifier.local));
}

function parsePythonImports(content: string): MainlineImportRecord[] {
  const records: MainlineImportRecord[] = [];

  for (const match of content.matchAll(/^\s*import\s+(.+)$/gm)) {
    const line = lineNumberAt(content, match.index ?? 0);
    for (const part of (match[1] ?? "").split(",")) {
      const item = part.trim();
      if (!item) {
        continue;
      }
      const [pathRaw, aliasRaw] = item.split(/\s+as\s+/);
      const path = (pathRaw ?? "").trim();
      records.push(
        createImportRecord({
          path,
          kind: "namespace",
          symbols: ["*"],
          alias: (aliasRaw ?? defaultPythonImportAlias(path)).trim() || null,
          line,
        }),
      );
    }
  }

  for (const match of content.matchAll(/^\s*from\s+([.\w]+)\s+import\s+(.+)$/gm)) {
    const path = match[1] ?? "";
    const line = lineNumberAt(content, match.index ?? 0);
    for (const part of (match[2] ?? "").split(",")) {
      const item = part.trim();
      if (!item) {
        continue;
      }
      if (item === "*") {
        records.push(
          createImportRecord({
            path,
            kind: "namespace",
            symbols: ["*"],
            alias: null,
            line,
          }),
        );
        continue;
      }
      const [importedRaw, aliasRaw] = item.split(/\s+as\s+/);
      const imported = (importedRaw ?? "").trim();
      const alias = (aliasRaw ?? imported).trim();
      records.push(
        createImportRecord({
          path,
          kind: "named",
          symbols: [imported],
          alias: alias === imported ? null : alias,
          specifiers: [{ imported, local: alias }],
          line,
        }),
      );
    }
  }

  return records;
}

function defaultPythonImportAlias(path: string): string {
  return path.split(".")[0] ?? path;
}

function createImportRecord(input: ImportRecordInput): MainlineImportRecord {
  return {
    path: input.path,
    kind: input.kind,
    symbols: input.symbols ?? [],
    alias: input.alias ?? null,
    specifiers: input.specifiers ?? [],
    isTypeOnly: input.isTypeOnly ?? false,
    isExportOnly: input.isExportOnly ?? false,
    ...(input.exportedName ? { exportedName: input.exportedName } : {}),
    ...(input.line ? { line: input.line } : {}),
  };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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

function uniqueImports(records: readonly MainlineImportRecord[]): MainlineImportRecord[] {
  const meaningfulAssignments = new Set(
    records
      .filter(
        (record) =>
          (record.kind === "commonjs" || record.kind === "dynamic") &&
          (record.alias || record.symbols.length > 0),
      )
      .map((record) => `${record.kind}\u0000${record.path}\u0000${record.line ?? 0}`),
  );

  return [
    ...new Map(
      records
        .filter((record) => record.path || record.isExportOnly)
        .filter(
          (record) =>
            !(
              (record.kind === "commonjs" || record.kind === "dynamic") &&
              !record.alias &&
              record.symbols.length === 0 &&
              meaningfulAssignments.has(
                `${record.kind}\u0000${record.path}\u0000${record.line ?? 0}`,
              )
            ),
        )
        .map((record) => [
          [
            record.kind,
            record.path,
            record.symbols.join(","),
            record.alias ?? "",
            record.isTypeOnly ? "type" : "value",
            record.isExportOnly ? "export" : "import",
            record.exportedName ?? "",
            record.line ?? 0,
          ].join("\u0000"),
          record,
        ]),
    ).values(),
  ].sort(
    (left, right) =>
      (left.line ?? 0) - (right.line ?? 0) ||
      left.path.localeCompare(right.path) ||
      left.kind.localeCompare(right.kind) ||
      (left.alias ?? "").localeCompare(right.alias ?? ""),
  );
}
