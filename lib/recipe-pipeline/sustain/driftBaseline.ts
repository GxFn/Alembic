/**
 * P-C(2026-07-11 主体/Plugin parity):reconcile 的 P3 精判基线来源。
 *
 * git_diff_checkpoints 是双宿主共享的"统一演化处理到的 commit"记录(同表同键,
 * BiliDili 实证:Plugin 链 guard 推进的行 folderId='root'/scopeId='single-folder')。
 * 此前主体 reconcile 不带 gitReader/baselineCommit → drifted 无 line-shift/
 * content-change 细分(Plugin knowledge-index-rebuild 链已接)。
 *
 * scope 归一走 Core 单源 buildGitDiffCheckpointScope(2026-07-11 下沉完成):
 * folderId=trim(currentFolderId)||'root',scopeId=trim(projectScopeId)||'single-folder',
 * 与 Plugin(knowledge-index-rebuild/guard 推进/posture 读取)读写同键。
 */
import { readFileAtCommit } from '@alembic/core';
import { buildGitDiffCheckpointScope } from '@alembic/core/evolution';

export interface DriftBaselineDeps {
  gitDiffCheckpointRepository: {
    get(input: { folderId: string; projectRoot: string; scopeId: string }): {
      checkpointCommit: string | null;
    } | null;
  };
}

export function resolveMainDriftBaselineCommit(
  deps: DriftBaselineDeps,
  projectRoot: string,
  scope: { currentFolderId?: string | null; projectScopeId?: string | null } = {}
): string | null {
  try {
    const row = deps.gitDiffCheckpointRepository.get(
      buildGitDiffCheckpointScope({
        currentFolderId: scope.currentFolderId ?? null,
        projectRoot,
        projectScopeId: scope.projectScopeId ?? null,
      })
    );
    const commit = row?.checkpointCommit ?? null;
    return typeof commit === 'string' && commit.length > 0 ? commit : null;
  } catch {
    // checkpoint 读取失败 → 无基线:reconcile 退回无精判的 drifted 标记(旧行为)。
    return null;
  }
}

/** reconcile 的 gitReader 注入(与 Plugin KnowledgeModule 同款封装)。 */
export function createMainDriftGitReader(projectRoot: string) {
  return (commit: string, relPath: string): string | null =>
    readFileAtCommit(projectRoot, commit, relPath);
}
