import type { MainlineImportRecord, MainlineSourceSymbol } from "./AstPort.js";

export interface MainlineSymbolTableBuildInput {
  readonly path: string;
  readonly languageId: string;
  readonly symbols: readonly MainlineSourceSymbol[];
  readonly imports: readonly MainlineImportRecord[];
}

export interface MainlineSymbolDeclaration {
  readonly fqn: string;
  readonly name: string;
  readonly kind: MainlineSourceSymbol["kind"];
  readonly file: string;
  readonly languageId: string;
  readonly line: number;
  readonly containerName: string | null;
  readonly isExported: boolean;
}

export interface MainlineSymbolTable {
  readonly declarations: Map<string, MainlineSymbolDeclaration>;
  readonly fileImports: Map<string, MainlineImportRecord[]>;
  readonly fileExports: Map<string, string[]>;
}

/**
 * MainlineSymbolTableBuilder 将轻量解析得到的符号和导入组织成稳定 FQN。
 * 它是主干纯数据层：不解析 AST、不访问旧 core/ast，也不尝试替代未来更精确的
 * tree-sitter adapter，只负责把 Round 1 的事实变成可查询表。
 */
export class MainlineSymbolTableBuilder {
  build(
    input: MainlineSymbolTableBuildInput | readonly MainlineSymbolTableBuildInput[],
  ): MainlineSymbolTable {
    const files: readonly MainlineSymbolTableBuildInput[] = Array.isArray(input) ? input : [input];
    const declarations = new Map<string, MainlineSymbolDeclaration>();
    const fileImports = new Map<string, MainlineImportRecord[]>();
    const fileExports = new Map<string, string[]>();

    for (const file of files) {
      const normalizedPath = normalizePath(file.path);
      const exports = new Set<string>();
      fileImports.set(
        normalizedPath,
        file.imports.filter((record) => !record.isExportOnly).map((record) => ({ ...record })),
      );

      for (const symbol of file.symbols) {
        const fqn = symbolFqn(normalizedPath, symbol);
        const declaration: MainlineSymbolDeclaration = {
          fqn,
          name: symbol.name,
          kind: symbol.kind,
          file: normalizedPath,
          languageId: file.languageId,
          line: symbol.startLine ?? 0,
          containerName: symbol.containerName ?? null,
          isExported: symbol.isExported ?? false,
        };
        declarations.set(fqn, declaration);
        if (symbol.isExported) {
          exports.add(symbol.exportName ?? symbol.name);
        }
      }

      for (const record of file.imports) {
        if (record.isExportOnly && record.exportedName) {
          exports.add(record.exportedName);
        }
      }

      fileExports.set(normalizedPath, [...exports].sort());
    }

    return { declarations, fileImports, fileExports };
  }

  static build(
    input: MainlineSymbolTableBuildInput | readonly MainlineSymbolTableBuildInput[],
  ): MainlineSymbolTable {
    return new MainlineSymbolTableBuilder().build(input);
  }
}

function symbolFqn(path: string, symbol: MainlineSourceSymbol): string {
  return `${path}::${symbol.containerName ? `${symbol.containerName}.` : ""}${symbol.name}`;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}
