/**
 * ContentPatcher — Proposal suggestedChanges 消费引擎
 *
 * 核心职责：
 *   1. 从 Proposal.evidence 提取 suggestedChanges
 *   2. 解析为结构化 Patch（JSON 或降级为纯文本）
 *   3. 创建 Recipe 内容快照（before）
 *   4. 应用 patch 到 Recipe 字段
 *   5. 创建快照（after）
 *   6. 持久化更新
 *
 * 安全边界：
 *   - 只修改 Patch 指定的字段，不擅自变更其他内容
 *   - suggestedChanges 缺失或格式不合规时降级跳过（不阻塞状态转移）
 *   - 所有变更在 before/after 快照中可追溯
 *
 * @module service/evolution/ContentPatcher
 */

import Logger from '../../infrastructure/logging/Logger.js';
import type KnowledgeRepositoryImpl from '../../repository/knowledge/KnowledgeRepository.impl.js';
import type { RecipeSourceRefRepositoryImpl } from '../../repository/sourceref/RecipeSourceRefRepository.js';
import type {
  ContentPatchResult,
  PatchChange,
  RecipeContentSnapshot,
  StructuredPatch,
} from '../../types/evolution.js';

/* ────────────────────── Types ────────────────────── */

/** DB 行格式 */
interface RecipeRow {
  id: string;
  title: string;
  coreCode: string;
  doClause: string;
  dontClause: string;
  whenClause: string;
  content: string;
  sourceRefs: string;
  headers: string;
}

/** Proposal evidence 中携带 suggestedChanges 的项 */
interface EvidenceWithChanges {
  suggestedChanges?: string;
  sourceStatus?: string;
  currentCode?: string;
  newLocation?: string;
  [key: string]: unknown;
}

/* ────────────────────── Patchable Fields ────────────────────── */

/** 允许 patch 的顶层字段白名单 */
const PATCHABLE_FIELDS = new Set([
  'coreCode',
  'doClause',
  'dontClause',
  'whenClause',
  'content.markdown',
  'content.rationale',
  'sourceRefs',
  'headers',
]);

/* ────────────────────── Class ────────────────────── */

export class ContentPatcher {
  readonly #knowledgeRepo: KnowledgeRepositoryImpl;
  readonly #sourceRefRepo: RecipeSourceRefRepositoryImpl;
  readonly #logger = Logger.getInstance();

  constructor(
    knowledgeRepo: KnowledgeRepositoryImpl,
    sourceRefRepo: RecipeSourceRefRepositoryImpl
  ) {
    this.#knowledgeRepo = knowledgeRepo;
    this.#sourceRefRepo = sourceRefRepo;
  }

  /**
   * 从 Proposal evidence 提取 suggestedChanges 并应用到 Recipe
   *
   * @returns ContentPatchResult — success: 是否成功应用了至少一个 patch
   */
  async applyProposal(
    proposal: {
      id: string;
      type: string;
      targetRecipeId: string;
      evidence: Record<string, unknown>[];
    },
    patchSource: 'agent-suggestion' | 'correction' | 'merge' = 'agent-suggestion'
  ): Promise<ContentPatchResult> {
    const recipeId = proposal.targetRecipeId;

    // 1. 获取 Recipe 当前内容
    const recipe = await this.#getRecipe(recipeId);
    if (!recipe) {
      return this.#skipResult(recipeId, patchSource, 'Recipe not found');
    }

    // 2. 提取 suggestedChanges
    const rawChanges = this.#extractSuggestedChanges(proposal.evidence);
    if (!rawChanges) {
      return this.#skipResult(recipeId, patchSource, 'No suggestedChanges in proposal evidence');
    }

    // 3. 解析为结构化 Patch
    const patch = this.#parsePatch(rawChanges);
    if (!patch || patch.changes.length === 0) {
      return this.#skipResult(
        recipeId,
        patchSource,
        'suggestedChanges could not be parsed or empty'
      );
    }

    // 4. 创建 before 快照
    const beforeSnapshot = this.#createSnapshot(recipe);

    // 5. 应用 patch
    const fieldsPatched = this.#applyPatch(recipe, patch.changes);
    if (fieldsPatched.length === 0) {
      return this.#skipResult(recipeId, patchSource, 'No valid fields to patch');
    }

    // 6. 持久化
    await this.#persistRecipe(recipe);

    // 7. 创建 after 快照
    const afterSnapshot = this.#createSnapshot(recipe);

    this.#logger.info(
      `[ContentPatcher] Applied ${fieldsPatched.length} patches to recipe ${recipeId}: ${fieldsPatched.join(', ')}`
    );

    return {
      success: true,
      recipeId,
      fieldsPatched,
      beforeSnapshot,
      afterSnapshot,
      patchSource,
      skipped: false,
    };
  }

  /* ═══════════════════ Extract ═══════════════════ */

  #extractSuggestedChanges(evidence: Record<string, unknown>[]): string | null {
    for (const ev of evidence) {
      const cast = ev as EvidenceWithChanges;
      if (
        cast.suggestedChanges &&
        typeof cast.suggestedChanges === 'string' &&
        cast.suggestedChanges.trim().length > 0
      ) {
        return cast.suggestedChanges;
      }
    }
    return null;
  }

  /* ═══════════════════ Parse ═══════════════════ */

  /**
   * 解析 suggestedChanges — 优先 JSON，降级为纯文本全量替换
   */
  #parsePatch(raw: string): StructuredPatch | null {
    // 尝试 JSON 解析
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as Partial<StructuredPatch>;
        if (parsed.changes && Array.isArray(parsed.changes)) {
          // JSON 有效但 changes 为空 → 视为无 patch
          if (parsed.changes.length === 0) {
            return null;
          }
          return {
            patchVersion: parsed.patchVersion ?? 1,
            changes: parsed.changes,
            reasoning: parsed.reasoning ?? '',
          };
        }
      } catch {
        // JSON 解析失败，降级到纯文本
      }
    }

    // 降级：纯文本视为 content.markdown 全量替换（适用于旧格式 Agent 输出）
    if (trimmed.length >= 20) {
      return {
        patchVersion: 1,
        changes: [
          {
            field: 'content.markdown',
            action: 'replace',
            newValue: trimmed,
          },
        ],
        reasoning: 'Fallback: raw text treated as content.markdown replacement',
      };
    }

    return null;
  }

  /* ═══════════════════ Apply ═══════════════════ */

  #applyPatch(recipe: RecipeRow, changes: PatchChange[]): string[] {
    const patched: string[] = [];

    for (const change of changes) {
      if (!PATCHABLE_FIELDS.has(change.field)) {
        this.#logger.warn(`[ContentPatcher] Skipping non-patchable field: ${change.field}`);
        continue;
      }

      const success = this.#applyOneChange(recipe, change);
      if (success) {
        patched.push(change.field);
      }
    }

    return patched;
  }

  #applyOneChange(recipe: RecipeRow, change: PatchChange): boolean {
    const { field, action } = change;

    // content.* 嵌套字段
    if (field.startsWith('content.')) {
      return this.#applyContentChange(recipe, change);
    }

    // 顶层字段
    if (field === 'sourceRefs' || field === 'headers') {
      return this.#applyArrayChange(recipe, field, change);
    }

    // 简单字符串字段
    const key = field as keyof Pick<
      RecipeRow,
      'coreCode' | 'doClause' | 'dontClause' | 'whenClause'
    >;
    if (action === 'replace' && change.newValue !== undefined) {
      recipe[key] = change.newValue;
      return true;
    }
    if (action === 'append' && change.newValue !== undefined) {
      recipe[key] = `${recipe[key]}\n${change.newValue}`;
      return true;
    }

    return false;
  }

  #applyContentChange(recipe: RecipeRow, change: PatchChange): boolean {
    const contentObj = safeJsonParse<Record<string, unknown>>(recipe.content, {});
    const subField = change.field.split('.')[1]; // 'markdown' | 'rationale'
    if (!subField) {
      return false;
    }

    if (change.action === 'replace' && change.newValue !== undefined) {
      contentObj[subField] = change.newValue;
      recipe.content = JSON.stringify(contentObj);
      return true;
    }

    if (change.action === 'replace-section' && change.section && change.newContent) {
      const current = (contentObj[subField] as string) ?? '';
      const updated = this.#replaceSection(current, change.section, change.newContent);
      if (updated !== current) {
        contentObj[subField] = updated;
        recipe.content = JSON.stringify(contentObj);
        return true;
      }
      return false;
    }

    if (change.action === 'append' && change.newValue !== undefined) {
      const current = (contentObj[subField] as string) ?? '';
      contentObj[subField] = `${current}\n${change.newValue}`;
      recipe.content = JSON.stringify(contentObj);
      return true;
    }

    return false;
  }

  #applyArrayChange(
    recipe: RecipeRow,
    field: 'sourceRefs' | 'headers',
    change: PatchChange
  ): boolean {
    if (change.action === 'replace' && change.newValue !== undefined) {
      try {
        const newArr = JSON.parse(change.newValue);
        if (Array.isArray(newArr)) {
          recipe[field] = JSON.stringify(newArr);
          return true;
        }
      } catch {
        // invalid JSON array
      }
      return false;
    }

    // replace-item: 数组内单元素替换（rename 场景）
    if (
      change.action === 'replace-item' &&
      change.oldValue !== undefined &&
      change.newValue !== undefined
    ) {
      const arr = safeJsonParse<string[]>(recipe[field], []);
      const idx = arr.indexOf(change.oldValue);
      if (idx >= 0) {
        arr[idx] = change.newValue;
        recipe[field] = JSON.stringify(arr);
        return true;
      }
      return false;
    }

    return false;
  }

  /**
   * 替换 Markdown 中指定 section（基于标题行匹配）
   */
  #replaceSection(markdown: string, sectionTitle: string, newContent: string): string {
    const lines = markdown.split('\n');
    const titleLine = lines.findIndex((line) => line.trim() === sectionTitle.trim());
    if (titleLine === -1) {
      // Section 不存在 → 追加
      return `${markdown}\n\n${newContent}`;
    }

    // 找到 section 结尾（下一个同级或更高级标题）
    const headingLevel = (sectionTitle.match(/^#+/) ?? [''])[0].length;
    let endLine = lines.length;
    for (let i = titleLine + 1; i < lines.length; i++) {
      const match = lines[i].match(/^(#+)\s/);
      if (match && match[1].length <= headingLevel) {
        endLine = i;
        break;
      }
    }

    const before = lines.slice(0, titleLine);
    const after = lines.slice(endLine);
    return [...before, newContent, ...after].join('\n');
  }

  /* ═══════════════════ Snapshot ═══════════════════ */

  #createSnapshot(recipe: RecipeRow): RecipeContentSnapshot {
    const contentObj = safeJsonParse<Record<string, unknown>>(recipe.content, {});
    return {
      coreCode: recipe.coreCode,
      doClause: recipe.doClause,
      dontClause: recipe.dontClause,
      whenClause: recipe.whenClause,
      content: {
        markdown: (contentObj.markdown as string) ?? undefined,
        rationale: (contentObj.rationale as string) ?? undefined,
      },
      sourceRefs: safeJsonParse<string[]>(recipe.sourceRefs, []),
      headers: safeJsonParse<string[]>(recipe.headers, []),
    };
  }

  /* ═══════════════════ DB ═══════════════════ */

  async #getRecipe(recipeId: string): Promise<RecipeRow | null> {
    const entry = await this.#knowledgeRepo.findById(recipeId);
    if (!entry) {
      return null;
    }
    // 从 recipe_source_refs 表读取关联的源引用路径
    const refs = this.#sourceRefRepo.findByRecipeId(entry.id);
    const sourcePaths = refs.map((r) => r.sourcePath);

    return {
      id: entry.id,
      title: entry.title,
      coreCode: entry.coreCode || '',
      doClause: entry.doClause || '',
      dontClause: entry.dontClause || '',
      whenClause: entry.whenClause || '',
      content: JSON.stringify(entry.content || {}),
      sourceRefs: JSON.stringify(sourcePaths),
      headers: JSON.stringify(entry.headers || []),
    };
  }

  async #persistRecipe(recipe: RecipeRow): Promise<void> {
    await this.#knowledgeRepo.update(recipe.id, {
      coreCode: recipe.coreCode,
      doClause: recipe.doClause,
      dontClause: recipe.dontClause,
      whenClause: recipe.whenClause,
      content: safeJsonParse(recipe.content, {}),
      headers: safeJsonParse(recipe.headers, []),
    });

    // 同步 sourceRefs 到 recipe_source_refs 表
    const newPaths = safeJsonParse<string[]>(recipe.sourceRefs, []);
    const now = Math.floor(Date.now() / 1000);
    this.#sourceRefRepo.deleteByRecipeId(recipe.id);
    for (const sourcePath of newPaths) {
      this.#sourceRefRepo.upsert({
        recipeId: recipe.id,
        sourcePath,
        status: 'active',
        verifiedAt: now,
      });
    }
  }

  /* ═══════════════════ Helpers ═══════════════════ */

  #skipResult(
    recipeId: string,
    patchSource: 'agent-suggestion' | 'correction' | 'merge',
    reason: string
  ): ContentPatchResult {
    this.#logger.info(`[ContentPatcher] Skipped for ${recipeId}: ${reason}`);
    const emptySnapshot: RecipeContentSnapshot = {
      coreCode: '',
      doClause: '',
      dontClause: '',
      whenClause: '',
      content: {},
      sourceRefs: [],
      headers: [],
    };
    return {
      success: false,
      recipeId,
      fieldsPatched: [],
      beforeSnapshot: emptySnapshot,
      afterSnapshot: emptySnapshot,
      patchSource,
      skipped: true,
      skipReason: reason,
    };
  }
}

/* ────────────────────── Util ────────────────────── */

function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) {
    return fallback;
  }
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
