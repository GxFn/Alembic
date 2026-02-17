import fs from 'node:fs';
import path from 'node:path';
import { getProjectRecipesPath } from '../../infrastructure/config/Paths.js';

/**
 * SimilarityService — 轻量级 Recipe 相似度检测
 * 基于 Jaccard / 余弦相似度对候选与已有 Recipe 进行去重检测
 */

/**
 * 将文本拆分为 n-gram token 集合
 */
function tokenize(text, n = 2) {
  if (!text) return new Set();
  const lower = text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();
  const tokens = new Set();
  const words = lower.split(/\s+/);
  for (const w of words) {
    if (w.length >= n) tokens.add(w);
    for (let i = 0; i <= w.length - n; i++) {
      tokens.add(w.slice(i, i + n));
    }
  }
  return tokens;
}

/**
 * 计算两个 token 集合的 Jaccard 相似度
 */
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

/**
 * 计算候选与单个 Recipe 的综合相似度
 */
function computeSimilarity(candidate, recipe) {
  const titleSim = jaccard(tokenize(candidate.title), tokenize(recipe.title));
  const summarySim = jaccard(
    tokenize(candidate.summary || candidate.description),
    tokenize(recipe.summary || recipe.description),
  );
  const codeSim = jaccard(tokenize(candidate.code, 3), tokenize(recipe.code, 3));
  // 加权: title 30%, summary 30%, code 40%
  return titleSim * 0.3 + summarySim * 0.3 + codeSim * 0.4;
}

/**
 * 从磁盘读取所有 Recipe MD 文件并提取基本结构
 */
function loadRecipesFromDisk(recipesDir) {
  const recipes = [];
  if (!fs.existsSync(recipesDir)) return recipes;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const content = fs.readFileSync(full, 'utf8');
          const titleMatch = content.match(/^#\s+(.+)/m);
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          const codeMatch = content.match(/```\w*\n([\s\S]*?)```/);
          const summaryMatch = content.match(/summary[_cn]*:\s*(.+)/i);
          recipes.push({
            file: path.relative(recipesDir, full),
            title: titleMatch?.[1]?.trim() || path.basename(full, '.md'),
            summary: summaryMatch?.[1]?.trim() || '',
            code: codeMatch?.[1]?.trim() || '',
          });
        } catch { /* skip unreadable */ }
      }
    }
  };
  walk(recipesDir);
  return recipes;
}

/**
 * 在项目知识库中查找与候选相似的 Recipe
 * @param {string} projectRoot - 项目根目录
 * @param {object} candidate - { title, summary, usageGuide, code }
 * @param {object} [opts] - { threshold: 0.7, topK: 5 }
 * @returns {Array<{file, title, similarity}>}
 */
export function findSimilarRecipes(projectRoot, candidate, opts = {}) {
  const threshold = opts.threshold ?? 0.7;
  const topK = opts.topK ?? 5;
  const recipesDir = getProjectRecipesPath(projectRoot);
  const recipes = loadRecipesFromDisk(recipesDir);

  const results = [];
  for (const recipe of recipes) {
    const sim = computeSimilarity(candidate, recipe);
    if (sim >= threshold) {
      results.push({ file: recipe.file, title: recipe.title, similarity: Math.round(sim * 1000) / 1000 });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, topK);
}

export default { findSimilarRecipes };
