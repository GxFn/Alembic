import path from "node:path";
import type {
  EngineeringCodeAstFileSummaryInput,
  EngineeringCodeAstSummaryInput,
} from "../EngineeringCodeGraphModel.js";
import type {
  EngineeringCodeAnalysisInput,
  EngineeringCodeImportRecord,
} from "./EngineeringCodeAnalysisTypes.js";
import { isGraphReader } from "./EngineeringCodeAnalysisTypes.js";

export function fileSummariesFromAnalysisInput(
  input: EngineeringCodeAnalysisInput,
): readonly EngineeringCodeAstFileSummaryInput[] {
  if (isGraphReader(input)) {
    return input.toJSON().files.map((file) => ({
      file: file.path,
      languageId: file.languageId,
      imports: file.imports,
      exports: file.exports,
      callSites: file.callSites,
      references: file.references,
      patterns: file.patterns,
      classes: input
        .getAllClassNames()
        .map((className) => input.getClassInfo(className))
        .filter((classInfo): classInfo is NonNullable<typeof classInfo> =>
          Boolean(classInfo && classInfo.filePath === file.path),
        ),
      protocols: input
        .getAllProtocolNames()
        .map((protocolName) => input.getProtocolInfo(protocolName))
        .filter((protocol): protocol is NonNullable<typeof protocol> =>
          Boolean(protocol && protocol.filePath === file.path),
        ),
      categories: input
        .getAllClassNames()
        .flatMap((className) => input.getCategoryExtensions(className))
        .filter((category) => category.filePath === file.path),
      metrics: file.metrics,
    }));
  }
  return fileSummariesFromAstInput(input);
}

export function fileSummariesFromAstInput(
  input:
    | EngineeringCodeAstSummaryInput
    | { readonly fileSummaries?: readonly EngineeringCodeAstFileSummaryInput[] },
): readonly EngineeringCodeAstFileSummaryInput[] {
  if (Array.isArray(input)) {
    return input;
  }
  const container = input as Exclude<
    EngineeringCodeAstSummaryInput,
    readonly EngineeringCodeAstFileSummaryInput[]
  >;
  return (
    container.fileSummaries ?? container.files ?? container.astProjectSummary?.fileSummaries ?? []
  );
}

export function filePathForSummary(summary: EngineeringCodeAstFileSummaryInput): string {
  return stringValue(summary.file ?? summary.path ?? summary.filePath, "(unknown)");
}

export function languageForPath(filePath: string, fallback = "unknown"): string {
  const ext = path.extname(filePath).toLowerCase();
  if ([".ts", ".tsx"].includes(ext)) return "typescript";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "javascript";
  if (ext === ".swift") return "swift";
  if (ext === ".m" || ext === ".mm" || ext === ".h") return "objective-c";
  if (ext === ".py") return "python";
  return fallback;
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

export function arrayRecords(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => stringValue(item, "")).filter(Boolean);
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stringOrNull(value: unknown): string | null {
  const text = stringValue(value, "");
  return text ? text : null;
}

export function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeImportRecord(raw: unknown): EngineeringCodeImportRecord {
  if (typeof raw === "string") {
    return {
      path: raw,
      kind: null,
      symbols: [],
      alias: null,
      raw,
    };
  }
  if (!isRecord(raw)) {
    return {
      path: String(raw),
      kind: null,
      symbols: [],
      alias: null,
      raw,
    };
  }
  const importPath = stringValue(raw.path ?? raw.source ?? raw.module ?? raw.importPath, "");
  const symbols = stringArray(raw.symbols ?? raw.names);
  return {
    path: importPath || String(raw.text ?? raw.raw ?? ""),
    kind: stringOrNull(raw.kind ?? raw.type),
    symbols,
    alias: stringOrNull(raw.alias ?? raw.localName ?? raw.namespace),
    exportedName: stringOrNull(raw.exportedName),
    isTypeOnly: Boolean(raw.isTypeOnly),
    isExportOnly: Boolean(raw.isExportOnly),
    raw,
  };
}

export function extractExportNames(exportsValue: unknown): string[] {
  const names: string[] = [];
  for (const exp of Array.isArray(exportsValue) ? exportsValue : []) {
    if (typeof exp === "string") {
      names.push(exp);
      continue;
    }
    if (!isRecord(exp)) {
      continue;
    }
    const direct = stringOrNull(exp.name ?? exp.exportedName);
    if (direct) {
      names.push(direct);
      continue;
    }
    const text = stringOrNull(exp.text ?? exp.raw);
    if (!text) {
      continue;
    }
    const declaration = text.match(
      /export\s+(?:default\s+)?(?:abstract\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    );
    if (declaration?.[1]) {
      names.push(declaration[1]);
    }
    if (text.includes("export default")) {
      names.push("default");
    }
    const named = text.match(/export\s*\{([^}]+)\}/);
    if (named?.[1]) {
      names.push(
        ...named[1]
          .split(",")
          .map(
            (item) =>
              item
                .trim()
                .split(/\s+as\s+/i)
                .at(-1)
                ?.trim() ?? "",
          )
          .filter(Boolean),
      );
    }
  }
  return [...new Set(names)];
}

export function makeFqn(filePath: string, qualifiedName: string): string {
  return `${filePath}::${qualifiedName}`;
}
