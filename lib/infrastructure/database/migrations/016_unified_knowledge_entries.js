/**
 * Migration 016: Create knowledge_entries unified table
 *
 * 合并 candidates + recipes 为单表 knowledge_entries。
 * 所有字段统一命名（snake_case），消除 metadata_json 袋子模式。
 *
 * 数据迁移策略：
 *   1. 创建 knowledge_entries 表
 *   2. 从 recipes 迁移数据 → lifecycle = active/deprecated/draft
 *   3. 从 candidates 迁移数据 → lifecycle = 原 status 映射
 *   4. 更新 knowledge_edges 的 from_type/to_type
 *   5. 旧表重命名为 _legacy_* (保留回滚能力)
 */
export default function migrate(db) {
  // 1. 检查是否已存在
  const existing = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_entries'"
  ).get();

  if (existing) {
    process.stderr.write('  ℹ️  016: knowledge_entries already exists, skipping\n');
    return;
  }

  // 2. 建表
  db.exec(`
    CREATE TABLE knowledge_entries (
      id                    TEXT PRIMARY KEY,
      title                 TEXT NOT NULL DEFAULT '',
      trigger_key           TEXT DEFAULT '',
      description           TEXT DEFAULT '',

      lifecycle             TEXT NOT NULL DEFAULT 'draft',
      lifecycle_history     TEXT DEFAULT '[]',
      probation             INTEGER DEFAULT 0,

      language              TEXT NOT NULL DEFAULT '',
      category              TEXT NOT NULL DEFAULT '',
      kind                  TEXT DEFAULT 'pattern',
      knowledge_type        TEXT DEFAULT 'code-pattern',
      complexity            TEXT DEFAULT 'intermediate',
      scope                 TEXT DEFAULT 'universal',
      difficulty            TEXT,
      tags                  TEXT DEFAULT '[]',

      summary_cn            TEXT DEFAULT '',
      summary_en            TEXT DEFAULT '',
      usage_guide_cn        TEXT DEFAULT '',
      usage_guide_en        TEXT DEFAULT '',

      content               TEXT DEFAULT '{}',
      relations             TEXT DEFAULT '{}',
      constraints           TEXT DEFAULT '{}',
      reasoning             TEXT DEFAULT '{}',
      quality               TEXT DEFAULT '{}',
      stats                 TEXT DEFAULT '{}',

      headers               TEXT DEFAULT '[]',
      header_paths          TEXT DEFAULT '[]',
      module_name           TEXT DEFAULT '',
      include_headers       INTEGER DEFAULT 0,

      agent_notes           TEXT,
      ai_insight            TEXT,

      reviewed_by           TEXT,
      reviewed_at           INTEGER,
      rejection_reason      TEXT,

      source                TEXT DEFAULT 'manual',
      source_file           TEXT,
      source_candidate_id   TEXT,

      created_by            TEXT DEFAULT 'system',
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL,
      published_at          INTEGER,
      published_by          TEXT,

      content_hash          TEXT
    );

    CREATE INDEX idx_ke2_lifecycle      ON knowledge_entries(lifecycle);
    CREATE INDEX idx_ke2_language       ON knowledge_entries(language);
    CREATE INDEX idx_ke2_category       ON knowledge_entries(category);
    CREATE INDEX idx_ke2_kind           ON knowledge_entries(kind);
    CREATE INDEX idx_ke2_knowledge_type ON knowledge_entries(knowledge_type);
    CREATE INDEX idx_ke2_created_at     ON knowledge_entries(created_at);
    CREATE INDEX idx_ke2_trigger        ON knowledge_entries(trigger_key);
    CREATE INDEX idx_ke2_title          ON knowledge_entries(title);
    CREATE INDEX idx_ke2_source         ON knowledge_entries(source);
    CREATE INDEX idx_ke2_guard_active   ON knowledge_entries(kind, lifecycle);
  `);

  const now = Math.floor(Date.now() / 1000);
  let recipeCount = 0;
  let candidateCount = 0;

  // 3. 迁移 recipes → knowledge_entries
  try {
    const hasRecipes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='recipes'"
    ).get();

    if (hasRecipes) {
      const recipes = db.prepare('SELECT * FROM recipes').all();

      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO knowledge_entries (
          id, title, trigger_key, description,
          lifecycle, lifecycle_history, probation,
          language, category, kind, knowledge_type, complexity, scope, difficulty, tags,
          summary_cn, summary_en, usage_guide_cn, usage_guide_en,
          content, relations, constraints, reasoning, quality, stats,
          headers, header_paths, module_name, include_headers,
          source, source_file, source_candidate_id,
          created_by, created_at, updated_at, published_at, published_by,
          reviewed_by, reviewed_at
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?
        )
      `);

      for (const r of recipes) {
        const lifecycle = r.status === 'active' ? 'active'
                        : r.status === 'deprecated' ? 'deprecated'
                        : 'draft';

        const dims = _json(r.dimensions_json, {});
        const quality = JSON.stringify({
          completeness:  r.quality_code_completeness || 0,
          adaptation:    r.quality_project_adaptation || 0,
          documentation: r.quality_documentation_clarity || 0,
          overall:       r.quality_overall || 0,
          grade:         _calcGrade(r.quality_overall || 0),
        });
        const stats = JSON.stringify({
          views:        r.view_count || 0,
          adoptions:    r.adoption_count || 0,
          applications: r.application_count || 0,
          guard_hits:   r.guard_hit_count || 0,
          search_hits:  0,
          authority:    Math.min((r.quality_overall || 0) * 5, 5),
        });

        insertStmt.run(
          r.id,
          r.title || '',
          r.trigger || '',
          r.description || '',
          lifecycle,
          '[]',
          0,
          r.language || '',
          r.category || '',
          r.kind || _inferKind(r.knowledge_type),
          r.knowledge_type || 'code-pattern',
          r.complexity || 'intermediate',
          r.scope || 'universal',
          dims.difficulty || null,
          r.tags_json || '[]',
          r.summary_cn || '',
          r.summary_en || '',
          r.usage_guide_cn || '',
          r.usage_guide_en || '',
          r.content_json || '{}',
          r.relations_json || '{}',
          r.constraints_json || '{}',
          '{}',                           // reasoning (recipes 没有)
          quality,
          stats,
          JSON.stringify(dims.headers || []),
          '[]',
          '',
          0,
          'migration',
          r.source_file || null,
          r.source_candidate_id || null,
          r.created_by || 'system',
          r.created_at || now,
          r.updated_at || now,
          r.published_at || null,
          r.published_by || null,
          null,                           // reviewed_by
          null,                           // reviewed_at
        );
        recipeCount++;
      }
    }
  } catch (err) {
    process.stderr.write(`  ⚠️  016: Recipe migration error: ${err.message}\n`);
  }

  // 4. 迁移 candidates → knowledge_entries
  try {
    const hasCandidates = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='candidates'"
    ).get();

    if (hasCandidates) {
      const candidates = db.prepare('SELECT * FROM candidates').all();

      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO knowledge_entries (
          id, title, trigger_key, description,
          lifecycle, lifecycle_history, probation,
          language, category, kind, knowledge_type, complexity, scope, difficulty, tags,
          summary_cn, summary_en, usage_guide_cn, usage_guide_en,
          content, relations, constraints, reasoning, quality, stats,
          headers, header_paths, module_name, include_headers,
          source, source_file, source_candidate_id,
          created_by, created_at, updated_at,
          reviewed_by, reviewed_at, rejection_reason
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?
        )
      `);

      for (const c of candidates) {
        const meta = _json(c.metadata_json, {});
        const reasoning = _json(c.reasoning_json, {});

        // 状态映射: applied → active, 其余 1:1
        const lifecycle = c.status === 'applied' ? 'active' : (c.status || 'pending');

        // 判断内容类型
        const code = c.code || '';
        const isMarkdown = code && (
          code.includes('— 项目特写') || /^#{1,3}\s/.test(code.trimStart())
        );

        const content = JSON.stringify({
          pattern:      isMarkdown ? '' : code,
          markdown:     isMarkdown ? code : '',
          rationale:    meta.rationale || reasoning.whyStandard || '',
          steps:        meta.steps || [],
          code_changes: meta.codeChanges || [],
          verification: meta.verification || null,
        });

        // relations: 旧 candidate 可能是扁平数组
        let relations = '{}';
        if (meta.relations) {
          if (Array.isArray(meta.relations)) {
            const buckets = {};
            for (const rel of meta.relations) {
              const bucket = rel.type || 'related';
              if (!buckets[bucket]) buckets[bucket] = [];
              buckets[bucket].push({
                target: rel.target || '',
                description: rel.description || '',
              });
            }
            relations = JSON.stringify(buckets);
          } else {
            relations = JSON.stringify(meta.relations);
          }
        }

        const reasoningJson = JSON.stringify({
          why_standard:    reasoning.whyStandard || '',
          sources:         reasoning.sources || [],
          confidence:      reasoning.confidence ?? 0.7,
          quality_signals: reasoning.qualitySignals || {},
          alternatives:    reasoning.alternatives || [],
        });

        insertStmt.run(
          c.id,
          meta.title || code.substring(0, 60) || '',
          meta.trigger || '',
          meta.description || '',
          lifecycle,
          c.status_history_json || '[]',
          0,
          c.language || '',
          meta.category || c.category || 'general',
          _inferKind(meta.knowledgeType),
          meta.knowledgeType || 'code-pattern',
          meta.complexity || 'intermediate',
          meta.scope || 'universal',
          null,                           // difficulty
          JSON.stringify(meta.tags || []),
          meta.summary || meta.summary_cn || '',
          meta.summary_en || '',
          meta.usageGuide || meta.usageGuide_cn || '',
          meta.usageGuide_en || '',
          content,
          relations,
          JSON.stringify(meta.constraints || {}),
          reasoningJson,
          JSON.stringify(meta.quality || {}),
          '{}',                           // stats
          JSON.stringify(meta.headers || []),
          '[]',
          '',
          0,
          c.source || 'manual',
          meta.sourceFile || null,
          null,
          c.created_by || 'system',
          c.created_at || now,
          c.updated_at || now,
          c.approved_by || c.rejected_by || null,
          c.approved_at || null,
          c.rejection_reason || null,
        );
        candidateCount++;
      }
    }
  } catch (err) {
    process.stderr.write(`  ⚠️  016: Candidate migration error: ${err.message}\n`);
  }

  // 5. 更新 knowledge_edges 的 type 字段
  try {
    const hasEdges = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_edges'"
    ).get();
    if (hasEdges) {
      db.exec(`
        UPDATE knowledge_edges SET from_type = 'knowledge_entry' WHERE from_type = 'recipe';
        UPDATE knowledge_edges SET to_type = 'knowledge_entry' WHERE to_type = 'recipe';
      `);
    }
  } catch (err) {
    process.stderr.write(`  ⚠️  016: knowledge_edges update error: ${err.message}\n`);
  }

  // 6. 重命名旧表（不删除以保留回滚能力）
  try {
    const hasRecipes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='recipes'"
    ).get();
    if (hasRecipes) {
      db.exec(`ALTER TABLE recipes RENAME TO _legacy_recipes`);
    }
  } catch { /* already renamed or doesn't exist */ }

  try {
    const hasCandidates = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='candidates'"
    ).get();
    if (hasCandidates) {
      db.exec(`ALTER TABLE candidates RENAME TO _legacy_candidates`);
    }
  } catch { /* already renamed or doesn't exist */ }

  process.stderr.write(
    `  ✅ 016_unified_knowledge_entries: Created table, migrated ${recipeCount} recipes + ${candidateCount} candidates\n`
  );
}

/* ── 迁移辅助函数 ── */

function _json(str, fallback) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

function _inferKind(knowledgeType) {
  const map = {
    'code-standard': 'rule', 'code-style': 'rule', 'best-practice': 'rule',
    'boundary-constraint': 'rule',
    'code-pattern': 'pattern', 'architecture': 'pattern', 'solution': 'pattern',
    'anti-pattern': 'pattern',
    'code-relation': 'fact', 'inheritance': 'fact', 'call-chain': 'fact',
    'data-flow': 'fact', 'module-dependency': 'fact',
  };
  return map[knowledgeType] || 'pattern';
}

function _calcGrade(score) {
  if (score >= 0.9) return 'A';
  if (score >= 0.75) return 'B';
  if (score >= 0.6) return 'C';
  if (score >= 0.4) return 'D';
  return 'F';
}
