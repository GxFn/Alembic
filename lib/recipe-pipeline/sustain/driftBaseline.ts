/**
 * P-C(2026-07-11 主体/Plugin parity):reconcile 的 P3 精判基线来源。
 *
 * git_diff_checkpoints 是双宿主共享的"统一演化处理到的 commit"记录(同表同键,
 * BiliDili 实证:Plugin 链 guard 推进的行 folderId='root'/scopeId='single-folder')。
 * 此前主体 reconcile 不带 gitReader/baselineCommit → drifted 无 line-shift/
 * content-change 细分(Plugin knowledge-index-rebuild 链已接)。
 *
 * scope 口径与 Plugin buildPluginGitDiffCheckpointScope 完全一致:
 * folderId=trim(currentFolderId)||'root',scopeId=trim(projectScopeId)||'single-folder'。
 * 登记后续:该口径下沉 Core 单源,两宿主转消费(现为声明一致的双实现)。
 */
import { readFileAtCommit } from '@alembic/core';

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
    const folderId = scope.currentFolderId?.trim() || 'root';
    const scopeId = scope.projectScopeId?.trim() || 'single-folder';
    const row = deps.gitDiffCheckpointRepository.get({ folderId, projectRoot, scopeId });
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
