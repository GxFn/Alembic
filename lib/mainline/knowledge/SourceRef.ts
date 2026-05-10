import { requireNonEmptyString } from "./internal/assert.js";

/**
 * SourceRef 是新主线的证据锚点。
 * Recipe 应通过它指向真实代码、文档、diff 或 finding，
 * 而不是携带不可结构化追踪的来源文本。
 */
export type SourceRefStatus = "active" | "repaired" | "stale" | "renamed" | "missing" | "unknown";

export type SourceRefKind =
  | "file"
  | "symbol"
  | "diff"
  | "test"
  | "doc"
  | "guard-finding"
  | "user-note";

export interface SourceRefLocation {
  path: string;
  startLine?: number | undefined;
  endLine?: number | undefined;
  symbol?: string | undefined;
}

export interface SourceRef {
  id: string;
  kind: SourceRefKind;
  location: SourceRefLocation;
  status: SourceRefStatus;
  verifiedAt?: number | undefined;
  contentHash?: string | undefined;
  summary?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface SourceRefInput {
  id?: string | undefined;
  kind?: SourceRefKind | undefined;
  path: string;
  startLine?: number | undefined;
  endLine?: number | undefined;
  symbol?: string | undefined;
  status?: SourceRefStatus | undefined;
  verifiedAt?: number | undefined;
  contentHash?: string | undefined;
  summary?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * 创建最小可用的 SourceRef。
 * 这里刻意保持纯函数，让编译期扫描器和 legacy adapter 不依赖数据库也能调用。
 */
export function createSourceRef(input: SourceRefInput): SourceRef {
  const path = requireNonEmptyString(input.path, "sourceRef.path");
  const id = input.id?.trim() || sourceRefIdForPath(path, input.symbol);

  return {
    id,
    kind: input.kind ?? (input.symbol ? "symbol" : "file"),
    location: {
      path,
      startLine: input.startLine,
      endLine: input.endLine,
      symbol: input.symbol,
    },
    status: input.status ?? "unknown",
    verifiedAt: input.verifiedAt,
    contentHash: input.contentHash,
    summary: input.summary,
    metadata: input.metadata,
  };
}

export function sourceRefIdForPath(path: string, symbol?: string): string {
  return symbol ? `${path}#${symbol}` : path;
}

/** freshness 是主线中替代 ReverseGuard 的轻量健康判断。 */
export function isFreshSourceRef(sourceRef: SourceRef): boolean {
  return (
    sourceRef.status === "active" ||
    sourceRef.status === "repaired" ||
    sourceRef.status === "renamed"
  );
}
