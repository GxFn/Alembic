import { createHash } from "node:crypto";

export type MainlineHashAlgorithm = "sha256-hex16" | "sha256" | "md5";

/**
 * 统一内容哈希。默认沿用旧代码里最常见的 sha256 前 16 位 hex，
 * 用于 SourceRef、快照 diff、artifact cache key 等轻量指纹。
 */
export function computeMainlineContentHash(
  content: string | Buffer,
  algorithm: MainlineHashAlgorithm = "sha256-hex16",
): string {
  const hash = createHash(algorithm === "md5" ? "md5" : "sha256")
    .update(content || "")
    .digest("hex");
  return algorithm === "sha256-hex16" ? hash.slice(0, 16) : hash;
}
