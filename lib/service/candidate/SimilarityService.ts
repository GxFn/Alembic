import fs from 'node:fs';
import path from 'node:path';
import { getProjectRecipesPath } from '../../infrastructure/config/Paths.js';
import { jaccardSimilarity, tokenizeForSimilarity } from '../../shared/similarity.js';

/**
 * SimilarityService — 轻量级 Recipe 相似度检测
 * 基于 Jaccard 相似度对候选与已有 Recipe 进行去重检测
 */

/**
 * 计算候选与单个 Recipe 的综合相似度
 */
function computeSimilarity(candidate: any, recipe: any) {
  const titleSim = jaccardSimilarity(
    tokenizeForSimilarity(candidate.title),
    tokenizeForSimilarity(recipe.title)
  );
  const summarySim = jaccardSimilarity(
    tokenizeForSimilarity(candidate.summary || candidate.description),
    tokenizeForSimilarity(recipe.summary || recipe.description)
  );
  const codeSim = jaccardSimilarity(
    tokenizeForSimilarity(candidate.code, 3),
    tokenizeForSimilarity(recipe.code, 3)
  );
  // 加权: title 30%, summary 30%, code 40%
  return titleSim * 0.3 + summarySim * 0.3 + codeSim * 0.4;
}

/**
 * 从磁盘读取所有 Recipe MD 文件并提取基本结构
 */
function loadRecipesFromDisk(recipesDir: any) {
  const recipes: { file: string; title: string; summary: string; code: string }[] = [];
  if (!fs.existsSync(recipesDir)) {
    return recipes;
  }

  const walk = (dir: any) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const content = fs.readFileSync(full, 'utf8');
          const titleMatch = content.match(/^#\s+(.+)/m);
          const _fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          const codeMatch = content.match(/```\w*\n([\s\S]*?)```/);
          const summaryMatch = content.match(/summary[_cn]*:\s*(.+)/i);
          recipes.push({
            file: path.relative(recipesDir, full),
            title: titleMatch?.[1]?.trim() || path.basename(full, '.md'),
            summary: summaryMatch?.[1]?.trim() || '',
            code: codeMatch?.[1]?.trim() || '',
          });
        } catch {
          /* skip unreadable */
        }
      }
    }
  };
  walk(recipesDir);
  return recipes;
}

/**
 * 在项目知识库中查找与候选相似的 Recipe
 * @param {string} projectRoot 项目根目录
 * @param {object} candidate - { title, summary, usageGuide, code }
 * @param {object} [opts] - { threshold: 0.7, topK: 5 }
 * @returns {Array<{file, title, similarity}>}
 */
export function findSimilarRecipes(projectRoot: any, candidate: any, opts: any = {}) {
  const threshold = opts.threshold ?? 0.7;
  const topK = opts.topK ?? 5;
  const recipesDir = getProjectRecipesPath(projectRoot);
  const recipes = loadRecipesFromDisk(recipesDir);

  const results: { file: any; title: any; similarity: number }[] = [];
  for (const recipe of recipes) {
    const sim = computeSimilarity(candidate, recipe);
    if (sim >= threshold) {
      results.push({
        file: recipe.file,
        title: recipe.title,
        similarity: Math.round(sim * 1000) / 1000,
      });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, topK);
}

export default { findSimilarRecipes };
