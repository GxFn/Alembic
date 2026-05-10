import path from "node:path";

/**
 * 主线内部统一使用相对项目根的 POSIX path。
 * 这个文件是路径身份的唯一底层规则，data/compile/runtime 都不再各写一套归一逻辑。
 */
export function normalizeMainlinePosixPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return "";
  }

  const normalized = path.posix.normalize(trimmed.replaceAll("\\", "/")).replace(/^\.\//, "");
  return normalized === "." ? "" : normalized;
}

export function toMainlineProjectRelativePath(projectRoot: string, filePath: string): string {
  const root = path.resolve(projectRoot);
  const absolute = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(root, filePath);
  return normalizeMainlinePosixPath(path.relative(root, absolute));
}

export function isMainlineProjectRelativePath(filePath: string): boolean {
  const normalized = normalizeMainlinePosixPath(filePath);
  return (
    normalized.length > 0 &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    !path.isAbsolute(normalized)
  );
}

export function uniqueMainlinePosixPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const filePath of paths) {
    const normalized = normalizeMainlinePosixPath(filePath);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
