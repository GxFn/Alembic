import type { EngineeringCodeAstImportFact } from "../ast/index.js";

export type EngineeringTreeSitterImportKind =
  | "named"
  | "default"
  | "namespace"
  | "side-effect"
  | "dynamic";

export interface EngineeringTreeSitterImportMeta {
  readonly symbols?: readonly string[];
  readonly alias?: string | null;
  readonly kind?: EngineeringTreeSitterImportKind;
  readonly isTypeOnly?: boolean;
}

export function createImportFact(
  importPath: string,
  meta: EngineeringTreeSitterImportMeta = {},
): EngineeringCodeAstImportFact {
  return {
    path: importPath,
    kind: meta.kind ?? "side-effect",
    symbols: [...(meta.symbols ?? [])],
    alias: meta.alias ?? null,
    isTypeOnly: meta.isTypeOnly ?? false,
  };
}
