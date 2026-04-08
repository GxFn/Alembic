/**
 * createSupersedeProposal — 统一的 supersede 提案创建逻辑
 *
 * 内部 Agent 路径 (lifecycle.ts / composite.ts) 和外部 MCP 路径 (consolidated.ts)
 * 共用此函数，确保知识替代的进化架构入口唯一。
 *
 * 流程：
 *   1. 从 DI 容器获取 ProposalRepository
 *   2. 验证旧 Recipe 存在
 *   3. 去重检查（ProposalRepository 内部）
 *   4. 创建 type='supersede' 提案，进入 72h 观察窗口
 */

import type {
  ProposalRecord,
  ProposalRepository,
  ProposalSource,
} from '../../repository/evolution/ProposalRepository.js';

/* ────────────────────── Types ────────────────────── */

/** 最小 DI 容器接口 — 兼容 ServiceContainer / McpServiceContainer / ToolHandlerContext.container */
interface MinimalContainer {
  get(name: string): unknown;
}

export interface SupersedeInput {
  /** 被替代的旧 Recipe ID */
  oldRecipeId: string;
  /** 新提交的 Recipe ID 列表 */
  newRecipeIds: string[];
  /** 来源标识：'ide-agent' | 'metabolism' | 'decay-scan' */
  source?: ProposalSource;
  /** 置信度，默认 0.8 */
  confidence?: number;
}

export interface SupersedeResult {
  proposalId: string;
  type: 'supersede';
  targetRecipe: { id: string };
  status: string;
  expiresAt: number;
  message: string;
}

/* ────────────────────── DB helper types ────────────────────── */

interface DatabaseLike {
  getDb(): {
    prepare(sql: string): { get(...p: unknown[]): unknown };
  };
}

/* ────────────────────── Main ────────────────────── */

/**
 * 在 DI 容器中查找 ProposalRepository，验证旧 Recipe 存在后创建 supersede 提案。
 *
 * @returns SupersedeResult（成功）| null（ProposalRepo 不可用 / 旧 Recipe 不存在 / 去重拒绝）
 */
export function createSupersedeProposal(
  container: MinimalContainer,
  input: SupersedeInput
): SupersedeResult | null {
  const { oldRecipeId, newRecipeIds, source = 'ide-agent', confidence = 0.8 } = input;

  if (!oldRecipeId || newRecipeIds.length === 0) {
    return null;
  }

  // 1. 获取 ProposalRepository
  let proposalRepo: ProposalRepository | null = null;
  try {
    proposalRepo = (container.get('proposalRepository') as ProposalRepository) ?? null;
  } catch {
    return null;
  }
  if (!proposalRepo) {
    return null;
  }

  // 2. 验证旧 Recipe 存在
  if (!verifyRecipeExists(container, oldRecipeId)) {
    return null;
  }

  // 3. 创建 supersede 提案（ProposalRepository 内部做去重检查）
  const proposal: ProposalRecord | null = proposalRepo.create({
    type: 'supersede',
    targetRecipeId: oldRecipeId,
    relatedRecipeIds: newRecipeIds,
    confidence,
    source,
    description: `Agent 声明新 Recipe [${newRecipeIds.join(', ')}] 替代旧 Recipe [${oldRecipeId}]。观察窗口内将对比新旧表现。`,
    evidence: [
      {
        snapshotAt: Date.now(),
        newRecipeIds,
        declaredBy: source,
      },
    ],
  });

  if (!proposal) {
    return null;
  }

  return {
    proposalId: proposal.id,
    type: 'supersede',
    targetRecipe: { id: oldRecipeId },
    status: proposal.status,
    expiresAt: proposal.expiresAt,
    message: `已创建替代提案：新 Recipe 将在观察窗口到期后自动替代旧 Recipe [${oldRecipeId}]。`,
  };
}

/* ────────────────────── Helpers ────────────────────── */

function verifyRecipeExists(container: MinimalContainer, recipeId: string): boolean {
  try {
    const db = container.get('database') as DatabaseLike | undefined;
    if (!db) {
      return false;
    }
    const rawDb = db.getDb();
    const row = rawDb.prepare('SELECT id FROM knowledge_entries WHERE id = ?').get(recipeId);
    return row !== undefined;
  } catch {
    return false;
  }
}
