import path from "node:path";
import type { MainlineScannedSourceFile } from "../../engineering/code/index.js";
import { normalizeMainlinePosixPath } from "../core/index.js";
import { createSourceRef, type SourceRef, type SourceRefStatus } from "../knowledge/index.js";
import { parseMainlineUnifiedDiff, tokenizeMainlineDiff } from "./DiffParser.js";

export interface MainlineGitChangedFile {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "renamed" | "untracked";
  readonly staged?: boolean;
  readonly oldPath?: string;
}

export interface SourceRefMaterializedDiff {
  readonly sourceRef: SourceRef;
  readonly tokens: string[];
  readonly hunkCount: number;
}

export interface SourceRefMaterializerPathInput {
  readonly path: string;
  readonly kind?: SourceRef["kind"];
  readonly status?: SourceRefStatus;
  readonly oldPath?: string;
  readonly contentHash?: string;
  readonly summary?: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * SourceRefMaterializer 把编译期材料归一成 SourceRef。
 * 中文注释：它只创建证据锚点，不读取旧 repository，也不写 ContextIndex；
 * 这样 cold-start、rescan 和未来 AgentRuntime 都能复用同一套证据入口。
 */
export class SourceRefMaterializer {
  fromScannedFile(file: MainlineScannedSourceFile): SourceRef {
    const relativePath = normalizeSourcePath(file.relativePath);
    const kind = file.kind === "doc" ? "doc" : file.isTest ? "test" : kindForPath(relativePath);
    return createSourceRef({
      path: relativePath,
      kind,
      status: "active",
      summary: kind === "doc" ? `${file.languageId} document` : `${file.languageId} source file`,
      metadata: {
        kind: file.kind,
        languageId: file.languageId,
        isTest: file.isTest,
        sizeBytes: file.sizeBytes,
        absolutePath: file.path,
      },
    });
  }

  fromGitChangedFile(file: MainlineGitChangedFile): SourceRef {
    const relativePath = normalizeSourcePath(file.path);
    const status = statusForGitChange(file.status);
    return this.fromPath({
      path: relativePath,
      status,
      metadata: {
        gitStatus: file.status,
        ...(file.staged !== undefined ? { staged: file.staged } : {}),
        ...(file.oldPath ? { oldPath: normalizeSourcePath(file.oldPath) } : {}),
      },
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    });
  }

  fromPath(input: SourceRefMaterializerPathInput): SourceRef {
    const relativePath = normalizeSourcePath(input.path);
    const oldPath = input.oldPath ? normalizeSourcePath(input.oldPath) : undefined;
    return createSourceRef({
      path: relativePath,
      kind: input.kind ?? kindForPath(relativePath),
      status: input.status ?? "active",
      contentHash: input.contentHash,
      summary: input.summary,
      metadata: {
        ...(input.metadata ?? {}),
        ...(oldPath ? { oldPath } : {}),
      },
    });
  }

  fromDiffText(
    filePath: string,
    diffText: string,
    status: SourceRefStatus = "active",
  ): SourceRefMaterializedDiff {
    const relativePath = normalizeSourcePath(filePath);
    const hunks = parseMainlineUnifiedDiff(diffText);
    const tokens = [...tokenizeMainlineDiff(hunks)].sort();
    return {
      sourceRef: createSourceRef({
        id: `diff:${relativePath}`,
        path: relativePath,
        kind: "diff",
        status,
        summary:
          tokens.length > 0
            ? `Diff touches ${tokens.slice(0, 6).join(", ")}`
            : "Diff hunk evidence",
        metadata: {
          hunkCount: hunks.length,
          addedLineCount: hunks.reduce((sum, hunk) => sum + hunk.addedLines.length, 0),
          removedLineCount: hunks.reduce((sum, hunk) => sum + hunk.removedLines.length, 0),
          tokens,
        },
      }),
      tokens,
      hunkCount: hunks.length,
    };
  }
}

export function normalizeSourcePath(filePath: string): string {
  return normalizeMainlinePosixPath(filePath);
}

function statusForGitChange(status: MainlineGitChangedFile["status"]): SourceRefStatus {
  switch (status) {
    case "deleted":
      return "missing";
    case "renamed":
      return "renamed";
    case "added":
    case "modified":
    case "untracked":
      return "active";
  }
}

function kindForPath(filePath: string): SourceRef["kind"] {
  const normalized = normalizeSourcePath(filePath);
  const base = path.posix.basename(normalized);
  if (/\.(md|mdx|markdown|txt|rst)$/.test(base)) {
    return "doc";
  }
  if (/(^|[/\\])(?:tests?|__tests__|spec|e2e|integration_test)[/\\]/.test(normalized)) {
    return "test";
  }
  if (/\.(test|spec)\.(cjs|js|jsx|mjs|ts|tsx)$/.test(base) || /(_test|Tests?)\./.test(base)) {
    return "test";
  }
  return "file";
}
