/**
 * RecipePathRewriter — 统一的 Recipe 路径重写服务
 *
 * 将 rename（oldPath → newPath）写入 Recipe 的所有文本字段 + .md 文件。
 * 被 FileChangeHandler（实时修复）和 SourceRefReconciler（批量兜底修复）共享。
 *
 * 更新范围：
 *   1. reasoning.sources 数组项
 *   2. content.markdown 全文
 *   3. coreCode 全文
 *   4. .md 源文件（磁盘）
 *
 * @module service/knowledge/RecipePathRewriter
 */

import fs from 'node:fs';
import path from 'node:path';
import Logger from '../../infrastructure/logging/Logger.js';
import type KnowledgeRepositoryImpl from '../../repository/knowledge/KnowledgeRepository.impl.js';

export interface PathRename {
  oldPath: string;
  newPath: string;
}

export interface RewriteResult {
  /** 被更新的 DB 字段名列表 */
  updatedFields: string[];
  /** .md 文件是否被更新 */
  mdFileUpdated: boolean;
}

const logger = Logger.getInstance();

/**
 * 将一组路径 rename 应用到 Recipe 的所有文本字段和 .md 源文件。
 *
 * @param knowledgeRepo  KnowledgeRepository 实例
 * @param recipeId       目标 Recipe ID
 * @param renames        路径变更列表（支持批量）
 * @param baseDir        .md 文件的根目录（用于 resolve sourceFile 相对路径）
 */
export async function rewriteRecipePaths(
  knowledgeRepo: KnowledgeRepositoryImpl,
  recipeId: string,
  renames: PathRename[],
  baseDir: string
): Promise<RewriteResult> {
  const result: RewriteResult = { updatedFields: [], mdFileUpdated: false };

  if (renames.length === 0) {
    return result;
  }

  const entry = await knowledgeRepo.findById(recipeId);
  if (!entry) {
    return result;
  }

  const updates: Record<string, unknown> = {};

  // ── 1. reasoning.sources 数组替换 ──
  const reasoning = entry.reasoning;
  if (reasoning) {
    const sources = [...reasoning.sources];
    let modified = false;
    for (const { oldPath, newPath } of renames) {
      const idx = sources.indexOf(oldPath);
      if (idx >= 0) {
        sources[idx] = newPath;
        modified = true;
      }
    }
    if (modified) {
      updates.reasoning = { ...reasoning.toJSON(), sources };
      result.updatedFields.push('reasoning.sources');
    }
  }

  // ── 2. content.markdown 全文替换 ──
  const content = entry.content;
  if (content) {
    let markdown = content.markdown;
    let modified = false;
    for (const { oldPath, newPath } of renames) {
      if (markdown.includes(oldPath)) {
        markdown = markdown.replaceAll(oldPath, newPath);
        modified = true;
      }
    }
    if (modified) {
      const contentJson = content.toJSON();
      contentJson.markdown = markdown;
      updates.content = contentJson;
      result.updatedFields.push('content.markdown');
    }
  }

  // ── 3. coreCode 全文替换 ──
  if (entry.coreCode) {
    let coreCode = entry.coreCode;
    let modified = false;
    for (const { oldPath, newPath } of renames) {
      if (coreCode.includes(oldPath)) {
        coreCode = coreCode.replaceAll(oldPath, newPath);
        modified = true;
      }
    }
    if (modified) {
      updates.coreCode = coreCode;
      result.updatedFields.push('coreCode');
    }
  }

  // ── 4. 写回 DB ──
  if (result.updatedFields.length > 0) {
    await knowledgeRepo.update(recipeId, updates);
  }

  // ── 5. 同步更新 .md 源文件 ──
  if (entry.sourceFile) {
    const mdPath = path.resolve(baseDir, entry.sourceFile);
    if (fs.existsSync(mdPath)) {
      let mdContent = fs.readFileSync(mdPath, 'utf8');
      let modified = false;
      for (const { oldPath, newPath } of renames) {
        if (mdContent.includes(oldPath)) {
          mdContent = mdContent.replaceAll(oldPath, newPath);
          modified = true;
        }
      }
      if (modified) {
        fs.writeFileSync(mdPath, mdContent, 'utf8');
        result.mdFileUpdated = true;
      }
    }
  }

  if (result.updatedFields.length > 0 || result.mdFileUpdated) {
    logger.info('[RecipePathRewriter] Paths rewritten', {
      recipeId,
      fields: result.updatedFields,
      mdFile: result.mdFileUpdated,
      renames: renames.map((r) => `${r.oldPath} → ${r.newPath}`),
    });
  }

  return result;
}
