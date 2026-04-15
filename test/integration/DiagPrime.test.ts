/**
 * Diagnostic: 诊断 BiliDili recipes 的搜索分数分布
 * 以 vitest 方式运行以支持路径别名
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { beforeAll, describe, it } from 'vitest';
import { parseKnowledgeMarkdown } from '../../lib/service/knowledge/KnowledgeFileWriter.js';
import { SearchEngine } from '../../lib/service/search/SearchEngine.js';
import { extract as extractIntent } from '../../lib/service/task/IntentExtractor.js';
import { PrimeSearchPipeline } from '../../lib/service/task/PrimeSearchPipeline.js';

const __dirname = import.meta.dirname;
const BILIDILI_ROOT = path.resolve(__dirname, '../../../BiliDili');
const RECIPES_DIR = path.join(BILIDILI_ROOT, 'Alembic/recipes');
const HAS_BILIDILI = fs.existsSync(RECIPES_DIR);

function createInMemoryDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_entries (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', description TEXT DEFAULT '',
      lifecycle TEXT NOT NULL DEFAULT 'pending', lifecycleHistory TEXT DEFAULT '[]',
      autoApprovable INTEGER DEFAULT 0, language TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'general', kind TEXT DEFAULT 'pattern',
      knowledgeType TEXT DEFAULT 'code-pattern', complexity TEXT DEFAULT 'intermediate',
      scope TEXT DEFAULT 'universal', difficulty TEXT, tags TEXT DEFAULT '[]',
      trigger TEXT DEFAULT '', topicHint TEXT DEFAULT '', whenClause TEXT DEFAULT '',
      doClause TEXT DEFAULT '', dontClause TEXT DEFAULT '', coreCode TEXT DEFAULT '',
      content TEXT DEFAULT '{}', relations TEXT DEFAULT '{}', constraints TEXT DEFAULT '{}',
      reasoning TEXT DEFAULT '{}', quality TEXT DEFAULT '{}', stats TEXT DEFAULT '{}',
      headers TEXT DEFAULT '[]', headerPaths TEXT DEFAULT '[]', moduleName TEXT DEFAULT '',
      includeHeaders INTEGER DEFAULT 0, agentNotes TEXT, aiInsight TEXT,
      reviewedBy TEXT, reviewedAt INTEGER, rejectionReason TEXT,
      source TEXT DEFAULT 'agent', sourceFile TEXT, sourceCandidateId TEXT,
      createdBy TEXT DEFAULT 'agent', createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      publishedAt INTEGER, publishedBy TEXT, contentHash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ke3_lifecycle ON knowledge_entries(lifecycle);
    CREATE INDEX IF NOT EXISTS idx_ke3_trigger ON knowledge_entries(trigger);
  `);
  return db;
}

function collectMdFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMdFiles(full));
    } else if (entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
      results.push(full);
    }
  }
  return results;
}

function insertEntry(
  db: ReturnType<typeof createInMemoryDb>,
  parsed: Record<string, unknown>,
  relPath: string
) {
  const now = Math.floor(Date.now() / 1000);
  const cols = [
    'id',
    'title',
    'trigger',
    'description',
    'lifecycle',
    'language',
    'category',
    'kind',
    'knowledgeType',
    'complexity',
    'scope',
    'tags',
    'topicHint',
    'whenClause',
    'doClause',
    'dontClause',
    'coreCode',
    'content',
    'relations',
    'constraints',
    'reasoning',
    'quality',
    'stats',
    'headers',
    'source',
    'sourceFile',
    'createdBy',
    'createdAt',
    'updatedAt',
    'publishedAt',
    'publishedBy',
  ];
  const row: Record<string, unknown> = {
    id: parsed.id,
    title: parsed.title || '',
    trigger: parsed.trigger || '',
    description: parsed.description || '',
    lifecycle: parsed.lifecycle || 'active',
    language: parsed.language || 'unknown',
    category: parsed.category || 'general',
    kind: parsed.kind || 'pattern',
    knowledgeType: parsed.knowledgeType || 'code-pattern',
    complexity: parsed.complexity || 'intermediate',
    scope: parsed.scope || 'universal',
    tags: JSON.stringify(parsed.tags || []),
    topicHint: parsed.topicHint || '',
    whenClause: parsed.whenClause || '',
    doClause: parsed.doClause || '',
    dontClause: parsed.dontClause || '',
    coreCode: parsed.coreCode || '',
    content: JSON.stringify(parsed._content || parsed.content || {}),
    relations: JSON.stringify(parsed._relations || {}),
    constraints: JSON.stringify(parsed._constraints || {}),
    reasoning: JSON.stringify(parsed._reasoning || {}),
    quality: JSON.stringify(parsed.quality || {}),
    stats: JSON.stringify(parsed.stats || {}),
    headers: JSON.stringify(parsed.headers || []),
    source: parsed.source || 'file-sync',
    sourceFile: relPath,
    createdBy: parsed.createdBy || 'file-sync',
    createdAt: parsed.createdAt || now,
    updatedAt: parsed.updatedAt || now,
    publishedAt: parsed.publishedAt || null,
    publishedBy: parsed.publishedBy || null,
  };
  const vals = cols.map((k) => row[k]);
  db.prepare(
    `INSERT OR REPLACE INTO knowledge_entries (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  ).run(...vals);
}

describe.skipIf(!HAS_BILIDILI)('Diagnostic: Raw Search Scores', () => {
  let db: ReturnType<typeof createInMemoryDb>;
  let engine: SearchEngine;
  let pipeline: PrimeSearchPipeline;

  beforeAll(() => {
    db = createInMemoryDb();
    const mdFiles = collectMdFiles(RECIPES_DIR);
    console.log(`Found ${mdFiles.length} recipe files`);

    let loaded = 0;
    for (const absPath of mdFiles) {
      const content = fs.readFileSync(absPath, 'utf8');
      const relPath = path.relative(BILIDILI_ROOT, absPath);
      try {
        const parsed = parseKnowledgeMarkdown(content, relPath) as Record<string, unknown>;
        if (parsed.id) {
          insertEntry(db, parsed, relPath);
          loaded++;
        }
      } catch {
        /* skip */
      }
    }
    console.log(`Loaded ${loaded} recipes`);

    engine = new SearchEngine(db);
    engine.buildIndex();
    console.log(`Index: ${engine.getStats().totalDocuments} docs`);

    pipeline = new PrimeSearchPipeline(engine);
  });

  const testQueries = [
    {
      q: '帮我写一个新的 ViewModel',
      file: 'Sources/Features/BDVideoFeed/VideoFeedViewModel.swift',
    },
    { q: 'implement SchemeRouter navigation', file: 'Sources/Features/BDHome/HomeVC.swift' },
    { q: '依赖注入怎么做' },
    { q: '线程安全' },
    { q: '错误展示 Toast' },
    { q: '弹幕 WebSocket' },
    { q: '单例模式' },
    { q: 'MVVM Input Output' },
    { q: 'Repository 模式' },
    { q: 'RxSwift 数据流绑定' },
  ];

  for (const { q, file } of testQueries) {
    it(`诊断: "${q}"`, async () => {
      const intent = extractIntent(q, file);
      console.log(`\n${'='.repeat(60)}`);
      console.log(`Query: "${q}" ${file ? `(file: ${file})` : ''}`);
      console.log(`  scenario=${intent.scenario}, lang=${intent.language}`);
      console.log(`  queries=${JSON.stringify(intent.queries)}`);
      console.log(`  keywordQueries=${JSON.stringify(intent.keywordQueries)}`);

      for (let i = 0; i < intent.queries.length; i++) {
        const query = intent.queries[i]!;
        const res = await engine.search(query, { mode: 'auto', limit: 8, rank: true });
        console.log(
          `\n  [Q${i + 1}] auto "${query.substring(0, 80)}" → ${res.items.length} results`
        );
        for (const item of res.items.slice(0, 5)) {
          console.log(`    ${item.score.toFixed(4)} | ${item.title} | kind=${item.kind}`);
        }
      }

      for (const kq of intent.keywordQueries) {
        const res = await engine.search(kq, { mode: 'keyword', limit: 8 });
        console.log(`\n  [KW] keyword "${kq.substring(0, 80)}" → ${res.items.length} results`);
        for (const item of res.items.slice(0, 5)) {
          console.log(`    ${item.score.toFixed(4)} | ${item.title} | kind=${item.kind}`);
        }
      }
    });
  }

  // ── Pipeline 诊断：完整 prime 流水线结果 ──
  for (const { q, file } of testQueries) {
    it(`Pipeline: "${q}"`, async () => {
      const intent = extractIntent(q, file);
      const result = await pipeline.search(intent);
      console.log(`\n[Pipeline] "${q}"`);
      console.log(`  numQueries=${intent.queries.length}, numKW=${intent.keywordQueries.length}`);
      if (result === null) {
        console.log('  result=null (all filtered by qualityFilter)');
      } else {
        console.log(
          `  knowledge=${result.relatedKnowledge.length}, rules=${result.guardRules.length}`
        );
        console.log(
          `  meta: resultCount=${result.searchMeta.resultCount}, filtered=${result.searchMeta.filteredCount}`
        );
        for (const r of result.relatedKnowledge) {
          console.log(`  ✓ [${r.score.toFixed(4)}] ${r.title} | kind=${r.kind}`);
        }
        for (const r of result.guardRules) {
          console.log(`  ⚑ [${r.score.toFixed(4)}] ${r.title} | kind=${r.kind}`);
        }
      }
    });
  }
});
