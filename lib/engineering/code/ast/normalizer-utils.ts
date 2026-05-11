import type { EngineeringCodeAstCallSiteFact, EngineeringCodeAstLanguageId } from "./facts.js";

export function normalizeLanguageId(value: unknown): EngineeringCodeAstLanguageId | string {
  const language = stringValue(value, "unknown").toLowerCase();
  if (["ts", "typescript"].includes(language)) return "typescript";
  if (["js", "javascript"].includes(language)) return "javascript";
  if (["tsx"].includes(language)) return "tsx";
  if (["swift"].includes(language)) return "swift";
  if (["objectivec", "objective-c", "objc", "obj-c"].includes(language)) return "objective-c";
  if (["py", "python"].includes(language)) return "python";
  if (["java"].includes(language)) return "java";
  if (["kt", "kotlin"].includes(language)) return "kotlin";
  if (["go", "golang"].includes(language)) return "go";
  if (["rs", "rust"].includes(language)) return "rust";
  if (["dart"].includes(language)) return "dart";
  return language || "unknown";
}

export function languageForPath(filePath: string): EngineeringCodeAstLanguageId {
  const ext = filePath.split(".").at(-1)?.toLowerCase();
  if (ext === "ts") return "typescript";
  if (ext === "tsx") return "tsx";
  if (["js", "jsx", "mjs", "cjs"].includes(ext ?? "")) return "javascript";
  if (ext === "swift") return "swift";
  if (["m", "mm", "h"].includes(ext ?? "")) return "objective-c";
  if (ext === "py") return "python";
  if (ext === "java") return "java";
  if (ext === "kt") return "kotlin";
  if (ext === "go") return "go";
  if (ext === "rs") return "rust";
  if (ext === "dart") return "dart";
  return "unknown";
}

export function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => stringValue(item, "")).filter(Boolean) : [];
}

export function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function compareByName(
  left: { readonly name: string },
  right: { readonly name: string },
): number {
  return left.name.localeCompare(right.name);
}

export function compareCallSite(
  left: EngineeringCodeAstCallSiteFact,
  right: EngineeringCodeAstCallSiteFact,
): number {
  return (
    left.filePath.localeCompare(right.filePath) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    left.callee.localeCompare(right.callee)
  );
}
