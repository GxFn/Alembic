#!/usr/bin/env node
/**
 * migrate-md-to-knowledge.mjs — 将旧格式 .md 文件迁移为统一 Knowledge 格式
 *
 * 扫描 AutoSnippet/candidates/ 和 AutoSnippet/recipes/ 下的旧格式 .md 文件，
 * 用旧 parser 解析 → 转换为 KnowledgeEntry → 用 KnowledgeFileWriter 重新序列化。
 *
 * 旧文件会备份到 AutoSnippet/_backup/{candidates|recipes}/ 目录下。
 *
 * 用法:
 *   node scripts/migrate-md-to-knowledge.mjs [projectRoot]
 *
 *   --dry-run    只报告，不写入
 *   --no-backup  不创建备份
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 解析命令行 ──
const args = process.argv.slice(2);
const dryRun   = args.includes('--dry-run');
const noBackup = args.includes('--no-backup');
const projectRoot = args.find(a => !a.startsWith('--')) || process.cwd();

// ── 动态导入（兼容 ESM） ──
const { parseRecipeMarkdown }    = await import('../lib/service/recipe/RecipeFileWriter.js');
const { parseCandidateMarkdown } = await import('../lib/service/candidate/CandidateFileWriter.js');
const { KnowledgeEntry }         = await import('../lib/domain/knowledge/KnowledgeEntry.js');
const { KnowledgeFileWriter }    = await import('../lib/service/knowledge/KnowledgeFileWriter.js');
const { Lifecycle }              = await import('../lib/domain/knowledge/Lifecycle.js');
const { inferKind: inferKindV3 } = await import('../lib/domain/knowledge/Lifecycle.js');

const RECIPES_DIR    = 'AutoSnippet/recipes';
const CANDIDATES_DIR = 'AutoSnippet/candidates';
const BACKUP_DIR     = 'AutoSnippet/_backup';

const recipesDir    = path.join(projectRoot, RECIPES_DIR);
const candidatesDir = path.join(projectRoot, CANDIDATES_DIR);
const backupDir     = path.join(projectRoot, BACKUP_DIR);

const report = {
  recipes:    { total: 0, migrated: 0, skipped: 0, errors: [] },
  candidates: { total: 0, migrated: 0, skipped: 0, errors: [] },
};

// ── 工具函数 ──

function collectMdFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  const walk = (curDir, base) => {
    for (const entry of fs.readdirSync(curDir, { withFileTypes: true })) {
      const full = path.join(curDir, entry.name);
      const rel  = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
        results.push({ absPath: full, relPath: rel });
      }
    }
  };
  walk(dir, '');
  return results;
}

function backupFile(absPath, type) {
  if (noBackup || dryRun) return;
  const rel = path.relative(
    type === 'recipe' ? recipesDir : candidatesDir,
    absPath
  );
  const dest = path.join(backupDir, type === 'recipe' ? 'recipes' : 'candidates', rel);
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(absPath, dest);
}

/**
 * 判断文件是否已经是新格式（包含 lifecycle 和 _content 字段）
 */
function isAlreadyNewFormat(content) {
  const fm = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return false;
  return fm[1].includes('lifecycle:') && fm[1].includes('_content:');
}

// ═══ Recipe 迁移 ═══

function migrateRecipe(absPath, relPath) {
  const content = fs.readFileSync(absPath, 'utf8');

  // 跳过已迁移的文件
  if (isAlreadyNewFormat(content)) {
    report.recipes.skipped++;
    return;
  }

  const parsed = parseRecipeMarkdown(content, relPath);

  // 映射旧 Recipe 字段 → KnowledgeEntry wire format
  const statusMap = {
    active:     Lifecycle.ACTIVE,
    deprecated: Lifecycle.DEPRECATED,
    draft:      Lifecycle.DRAFT,
  };

  // 提取旧 dimensions
  const quality = parsed.quality || {};
  const stats   = parsed.statistics || {};

  const wireData = {
    id:                  parsed.id,
    title:               parsed.title,
    trigger:             parsed.trigger || '',
    description:         parsed.summaryCn || parsed.summaryEn || '',
    lifecycle:           statusMap[parsed.status] || Lifecycle.ACTIVE,
    lifecycle_history:   [],
    probation:           false,
    language:            parsed.language || 'swift',
    category:            parsed.category || 'general',
    kind:                parsed.kind || inferKindV3(parsed.knowledgeType || 'code-pattern'),
    knowledge_type:      parsed.knowledgeType || 'code-pattern',
    complexity:          parsed.complexity || 'intermediate',
    scope:               parsed.scope || 'universal',
    difficulty:          parsed.difficulty || null,
    tags:                parsed.tags || [],
    summary_cn:          parsed.summaryCn || '',
    summary_en:          parsed.summaryEn || '',
    usage_guide_cn:      parsed.usageGuideCn || '',
    usage_guide_en:      parsed.usageGuideEn || '',
    content:             {
      pattern:   '',
      markdown:  '',
      rationale: '',
      steps:     [],
      code_changes: [],
      verification: null,
    },
    relations:           parsed.relations || {},
    constraints:         parsed.constraints || {},
    reasoning:           {},
    quality: {
      completeness:  quality.codeCompleteness  ?? quality.completeness  ?? 0,
      adaptation:    quality.projectAdaptation  ?? quality.adaptation    ?? 0,
      documentation: quality.documentationClarity ?? quality.documentation ?? 0,
      overall:       quality.overall ?? 0,
      grade:         quality.grade   || 'F',
    },
    stats: {
      views:        stats.viewCount        ?? stats.views        ?? 0,
      adoptions:    stats.adoptionCount    ?? stats.adoptions    ?? 0,
      applications: stats.applicationCount ?? stats.applications ?? 0,
      guard_hits:   stats.guardHitCount    ?? stats.guard_hits   ?? 0,
      search_hits:  stats.searchHits       ?? stats.search_hits  ?? 0,
      authority:    parsed.authority        ?? stats.authority    ?? 0,
    },
    headers:             parsed.headers || [],
    header_paths:        [],
    module_name:         '',
    include_headers:     false,
    agent_notes:         null,
    ai_insight:          null,
    reviewed_by:         null,
    reviewed_at:         null,
    rejection_reason:    parsed.deprecationReason || null,
    source:              'migration',
    source_file:         `${RECIPES_DIR}/${relPath}`,
    source_candidate_id: parsed.sourceCandidate || null,
    created_by:          parsed.createdBy || 'system',
    created_at:          parsed.createdAt || Math.floor(Date.now() / 1000),
    updated_at:          parsed.updatedAt || Math.floor(Date.now() / 1000),
    published_at:        parsed.publishedAt || null,
    published_by:        parsed.publishedBy || null,
  };

  // 提取 body 内容到 content
  const bodyMatch = content.match(/^---[\s\S]*?---\s*\r?\n([\s\S]*)$/);
  if (bodyMatch) {
    const body = bodyMatch[1].trim();
    const codeMatch = body.match(/```\w*\n([\s\S]*?)```/);
    if (codeMatch) {
      wireData.content.pattern = codeMatch[1].trimEnd();
    }
    // 如果有完整 markdown 内容（项目特写）
    if (body.includes('— 项目特写') || (body.length > 500 && body.startsWith('#'))) {
      wireData.content.markdown = body;
      wireData.content.pattern = '';
    }
  }

  // 构建实体并重新序列化
  const entry = KnowledgeEntry.fromJSON(wireData);
  const writer = new KnowledgeFileWriter(projectRoot);
  const newMarkdown = writer.serialize(entry);

  if (!dryRun) {
    backupFile(absPath, 'recipe');
    fs.writeFileSync(absPath, newMarkdown, 'utf8');
  }

  report.recipes.migrated++;
}

// ═══ Candidate 迁移 ═══

function migrateCandidate(absPath, relPath) {
  const content = fs.readFileSync(absPath, 'utf8');

  // 跳过已迁移的文件
  if (isAlreadyNewFormat(content)) {
    report.candidates.skipped++;
    return;
  }

  const parsed = parseCandidateMarkdown(content, relPath);

  // 映射旧 Candidate 状态 → lifecycle
  const statusMap = {
    pending:  Lifecycle.PENDING,
    approved: Lifecycle.APPROVED,
    rejected: Lifecycle.REJECTED,
    applied:  Lifecycle.ACTIVE,
    draft:    Lifecycle.DRAFT,
  };

  const meta      = parsed._metadata || {};
  const reasoning = parsed._reasoning || {};
  const code      = parsed._bodyCode || '';

  // 判断内容类型
  const isMarkdown = code && (
    code.includes('— 项目特写') || /^#{1,3}\s/.test(code.trimStart())
  );

  const wireData = {
    id:                  parsed.id,
    title:               meta.title || meta.description || (code ? code.substring(0, 60) : ''),
    trigger:             meta.trigger || '',
    description:         meta.description || '',
    lifecycle:           statusMap[parsed.status] || Lifecycle.PENDING,
    lifecycle_history:   parsed._statusHistory || [],
    probation:           false,
    language:            parsed.language || 'swift',
    category:            meta.category || parsed.category || 'general',
    kind:                inferKindV3(meta.knowledgeType || 'code-pattern'),
    knowledge_type:      meta.knowledgeType || 'code-pattern',
    complexity:          meta.complexity || 'intermediate',
    scope:               meta.scope || 'universal',
    difficulty:          meta.difficulty || null,
    tags:                meta.tags || [],
    summary_cn:          meta.summary || meta.summary_cn || '',
    summary_en:          meta.summary_en || '',
    usage_guide_cn:      meta.usageGuide || meta.usageGuide_cn || '',
    usage_guide_en:      meta.usageGuide_en || '',
    content: {
      pattern:      isMarkdown ? '' : code,
      markdown:     isMarkdown ? code : '',
      rationale:    meta.rationale || (typeof reasoning === 'object' ? reasoning.whyStandard : '') || '',
      steps:        meta.steps || [],
      code_changes: meta.codeChanges || [],
      verification: meta.verification || null,
    },
    relations: Array.isArray(meta.relations)
      ? { related: meta.relations.map(r => typeof r === 'string' ? { target: r, description: '' } : r) }
      : (meta.relations || {}),
    constraints:         meta.constraints || {},
    reasoning: {
      why_standard:    (typeof reasoning === 'object' ? reasoning.whyStandard : '') || '',
      sources:         (typeof reasoning === 'object' ? reasoning.sources : []) || [],
      confidence:      (typeof reasoning === 'object' ? reasoning.confidence : 0.7) ?? 0.7,
      quality_signals: (typeof reasoning === 'object' ? reasoning.qualitySignals : {}) || {},
      alternatives:    (typeof reasoning === 'object' ? reasoning.alternatives : []) || [],
    },
    quality:             meta.quality || {},
    stats:               {},
    headers:             meta.headers || [],
    header_paths:        [],
    module_name:         '',
    include_headers:     false,
    agent_notes:         null,
    ai_insight:          null,
    reviewed_by:         parsed.approvedBy || parsed.rejectedBy || null,
    reviewed_at:         parsed.approvedAt || null,
    rejection_reason:    parsed.rejectionReason || null,
    source:              parsed.source || 'migration',
    source_file:         `${CANDIDATES_DIR}/${relPath}`,
    source_candidate_id: null,
    created_by:          parsed.createdBy || 'system',
    created_at:          parsed.createdAt || Math.floor(Date.now() / 1000),
    updated_at:          parsed.updatedAt || Math.floor(Date.now() / 1000),
    published_at:        null,
    published_by:        null,
  };

  // 构建实体并重新序列化
  const entry = KnowledgeEntry.fromJSON(wireData);
  const writer = new KnowledgeFileWriter(projectRoot);
  const newMarkdown = writer.serialize(entry);

  if (!dryRun) {
    backupFile(absPath, 'candidate');
    fs.writeFileSync(absPath, newMarkdown, 'utf8');
  }

  report.candidates.migrated++;
}

// ═══ 主流程 ═══

console.log(`\n🔄 Knowledge .md Migration`);
console.log(`  Project: ${projectRoot}`);
console.log(`  Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
console.log(`  Backup: ${noBackup ? 'disabled' : 'enabled'}`);
console.log('');

// ── 迁移 Recipes ──
const recipeFiles = collectMdFiles(recipesDir);
report.recipes.total = recipeFiles.length;
console.log(`📦 Recipes: ${recipeFiles.length} files found`);

for (const { absPath, relPath } of recipeFiles) {
  try {
    migrateRecipe(absPath, relPath);
  } catch (err) {
    report.recipes.errors.push({ file: relPath, error: err.message });
    console.error(`  ❌ ${relPath}: ${err.message}`);
  }
}

// ── 迁移 Candidates ──
const candidateFiles = collectMdFiles(candidatesDir);
report.candidates.total = candidateFiles.length;
console.log(`📦 Candidates: ${candidateFiles.length} files found`);

for (const { absPath, relPath } of candidateFiles) {
  try {
    migrateCandidate(absPath, relPath);
  } catch (err) {
    report.candidates.errors.push({ file: relPath, error: err.message });
    console.error(`  ❌ ${relPath}: ${err.message}`);
  }
}

// ── 报告 ──
console.log('\n═══ Migration Report ═══');
console.log(`  Recipes:    ${report.recipes.migrated}/${report.recipes.total} migrated, ${report.recipes.skipped} already new format, ${report.recipes.errors.length} errors`);
console.log(`  Candidates: ${report.candidates.migrated}/${report.candidates.total} migrated, ${report.candidates.skipped} already new format, ${report.candidates.errors.length} errors`);

if (!noBackup && !dryRun) {
  console.log(`\n  Backups saved to: ${backupDir}`);
}

if (report.recipes.errors.length + report.candidates.errors.length > 0) {
  console.log('\n  Errors:');
  for (const e of [...report.recipes.errors, ...report.candidates.errors]) {
    console.log(`    - ${e.file}: ${e.error}`);
  }
}

console.log('');
