import path from "node:path";
import { normalizeMainlinePosixPath } from "./PathIdentity.js";

const GENERATED_BASENAMES = new Set(["AGENTS.md", "CLAUDE.md", "copilot-instructions.md"]);

/**
 * 主线统一排除 Alembic/Codex 生成的宿主指导文件。
 * 它们可以被 surface 层生成，但不能反向成为内容挖掘和运行期上下文的事实来源。
 */
export function isMainlineGeneratedProjectFile(filePath: string): boolean {
  const normalized = normalizeMainlinePosixPath(filePath);
  const base = path.posix.basename(normalized);
  if (GENERATED_BASENAMES.has(base) || base.endsWith(".mdc")) {
    return true;
  }
  return (
    normalized.includes("/.cursor/") ||
    normalized.endsWith("/.github/copilot-instructions.md") ||
    normalized === ".github/copilot-instructions.md"
  );
}

export function filterMainlineGeneratedFiles<T extends { path?: string; relativePath?: string }>(
  files: readonly T[],
): T[] {
  return files.filter((file) => {
    const pathLike = file.relativePath ?? file.path ?? "";
    return !isMainlineGeneratedProjectFile(pathLike);
  });
}
