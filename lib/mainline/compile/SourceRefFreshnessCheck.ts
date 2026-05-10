import type { SourceRef } from "../knowledge/index.js";

export interface SourceRefFreshnessFinding {
  readonly sourceRefId: string;
  readonly status: SourceRef["status"];
  readonly fresh: boolean;
  readonly reason: string;
}

/**
 * SourceRef freshness 是主线中替代重型 ReverseGuard 的轻量健康判断。
 * 它只看已经归一化的 SourceRef 状态，不启动扫描、不读文件、不访问旧服务。
 */
export class SourceRefFreshnessCheck {
  check(sourceRefs: readonly SourceRef[]): SourceRefFreshnessFinding[] {
    return sourceRefs.map((sourceRef) => ({
      sourceRefId: sourceRef.id,
      status: sourceRef.status,
      fresh:
        sourceRef.status === "active" ||
        sourceRef.status === "repaired" ||
        sourceRef.status === "renamed",
      reason: reasonForStatus(sourceRef.status),
    }));
  }
}

function reasonForStatus(status: SourceRef["status"]): string {
  switch (status) {
    case "active":
      return "Source reference is active.";
    case "repaired":
      return "Source reference was repaired by the incremental SourceRef repair chain.";
    case "renamed":
      return "Source reference was renamed but is still usable.";
    case "stale":
      return "Source reference is stale and should be refreshed.";
    case "missing":
      return "Source reference points to a missing file or symbol.";
    case "unknown":
      return "Source reference has not been verified yet.";
  }
}
