import path from "node:path";
import type { EngineeringTreeSitterLanguageId } from "./types.js";

const ALIASES: Readonly<Record<string, EngineeringTreeSitterLanguageId>> = Object.freeze({
  dart: "dart",
  go: "go",
  golang: "go",
  java: "java",
  js: "javascript",
  javascript: "javascript",
  jsx: "javascript",
  kotlin: "kotlin",
  kt: "kotlin",
  kts: "kotlin",
  mjs: "javascript",
  cjs: "javascript",
  objc: "objectivec",
  "objective-c": "objectivec",
  objectivec: "objectivec",
  rs: "rust",
  rust: "rust",
  swift: "swift",
  py: "python",
  python: "python",
  python3: "python",
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
});

const EXTENSIONS: Readonly<Record<string, EngineeringTreeSitterLanguageId>> = Object.freeze({
  ".cjs": "javascript",
  ".dart": "dart",
  ".go": "go",
  ".h": "objectivec",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "javascript",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".m": "objectivec",
  ".mm": "objectivec",
  ".mjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".swift": "swift",
  ".ts": "typescript",
  ".tsx": "tsx",
});

export function normalizeTreeSitterLanguageId(
  value: string | undefined,
): EngineeringTreeSitterLanguageId | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return ALIASES[normalized] ?? null;
}

export function inferTreeSitterLanguageId(
  filePath: string,
): EngineeringTreeSitterLanguageId | null {
  return EXTENSIONS[path.extname(filePath).toLowerCase()] ?? null;
}

export function resolveTreeSitterLanguageId(
  value: string | undefined,
  filePath: string | undefined,
): EngineeringTreeSitterLanguageId | null {
  // 中文说明：TSX 必须优先按扩展名分流，否则 TypeScript grammar 会解析失败。
  const byPath = filePath ? inferTreeSitterLanguageId(filePath) : null;
  if (byPath === "tsx") {
    return "tsx";
  }
  return normalizeTreeSitterLanguageId(value) ?? byPath;
}
