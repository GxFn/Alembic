/**
 * KnowledgeFileWriter + KnowledgeSyncService 单元测试
 *
 * 覆盖：
 *  - serialize: KnowledgeEntry → .md (frontmatter + body)
 *  - parse: .md → wire format JSON
 *  - round-trip: serialize → parse → fromJSON → toJSON → 字段一致性
 *  - persist / remove: 文件操作
 *  - moveOnLifecycleChange: lifecycle 切换时文件移动
 *  - computeKnowledgeHash: 内容 hash 一致性
 *  - KnowledgeSyncService._buildDbRow: wire format → DB row 映射
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeSyncService } from '../../lib/cli/KnowledgeSyncService.js';
import { KnowledgeEntry } from '../../lib/domain/knowledge/KnowledgeEntry.js';
import { Lifecycle } from '../../lib/domain/knowledge/Lifecycle.js';
import {
  computeKnowledgeHash,
  KnowledgeFileWriter,
  parseKnowledgeMarkdown,
} from '../../lib/service/knowledge/KnowledgeFileWriter.js';

/* ═══ 测试数据 ═══ */

function makeEntry(overrides = {}) {
  return new KnowledgeEntry({
    id: 'test-id-001',
    title: 'Singleton Pattern',
    trigger: '@singleton',
    description: 'Standard singleton implementation',
    lifecycle: Lifecycle.ACTIVE,
    language: 'swift',
    category: 'Architecture',
    kind: 'pattern',
    knowledgeType: 'code-pattern',
    complexity: 'intermediate',
    scope: 'universal',
    difficulty: 'intermediate',
    tags: ['singleton', 'design-pattern'],
    summaryCn: '使用单例模式确保全局唯一性',
    summaryEn: 'Use singleton pattern for global uniqueness',
    usageGuideCn: '通过 sharedInstance 访问',
    usageGuideEn: 'Access via sharedInstance',
    content: {
      pattern: '+ (instancetype)sharedInstance { ... }',
      markdown: '',
      rationale: '确保全局唯一实例',
      steps: [{ title: '创建', description: '添加 sharedInstance 方法', code: '...' }],
      codeChanges: [],
      verification: { method: 'unit_test', expected_result: 'a === b' },
    },
    relations: {
      extends: [{ target: '@factory', description: '可作为工厂基础' }],
      related: [{ target: '@manager', description: '常配合 Manager 使用' }],
    },
    constraints: {
      guards: [
        {
          id: 'no-direct-init',
          type: 'regex',
          pattern: '\\[\\[\\w+ alloc\\] init\\]',
          message: '禁止直接 alloc init',
          severity: 'warning',
        },
      ],
      boundaries: ['线程安全'],
      preconditions: ['已导入 Foundation'],
      sideEffects: ['全局状态'],
    },
    reasoning: {
      whyStandard: '项目大量使用此模式',
      sources: ['Manager.swift:22'],
      confidence: 0.85,
    },
    quality: {
      completeness: 0.8,
      adaptation: 0.7,
      documentation: 0.9,
      overall: 0.8,
      grade: 'B',
    },
    stats: {
      views: 100,
      adoptions: 5,
      applications: 3,
      guardHits: 12,
      searchHits: 42,
      authority: 3.5,
    },
    headers: ['#import <Foundation/Foundation.h>'],
    headerPaths: ['Foundation/Foundation.h'],
    moduleName: 'Foundation',
    includeHeaders: true,
    agentNotes: ['AI 建议增加线程安全注释'],
    aiInsight: '此模式在项目中出现 10+ 次',
    reviewedBy: 'reviewer-001',
    reviewedAt: 1739779200,
    source: 'bootstrap',
    sourceFile: 'AutoSnippet/recipes/architecture/singleton.md',
    createdBy: 'agent',
    createdAt: 1739692800,
    updatedAt: 1739779200,
    publishedAt: 1739779200,
    publishedBy: 'reviewer-001',
    ...overrides,
  });
}

/* ═══ 测试套件 ═══ */

describe('KnowledgeFileWriter', () => {
  let writer;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-kfw-'));
    // 创建必要的目录结构
    fs.mkdirSync(path.join(tmpDir, 'AutoSnippet', 'recipes'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'AutoSnippet', 'candidates'), { recursive: true });
    writer = new KnowledgeFileWriter(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /* ─── serialize ─────────────────────────── */

  describe('serialize', () => {
    it('应生成包含 frontmatter 和 body 的有效 .md', () => {
      const entry = makeEntry();
      const md = writer.serialize(entry);

      // 应以 --- 开头
      expect(md.startsWith('---\n')).toBe(true);
      // 应包含两个 --- 分隔符
      const fmMatches = md.match(/^---$/gm);
      expect(fmMatches.length).toBeGreaterThanOrEqual(2);
    });

    it('should include all scalar fields in frontmatter', () => {
      const entry = makeEntry();
      const md = writer.serialize(entry);

      expect(md).toContain('id: test-id-001');
      expect(md).toContain('title: Singleton Pattern');
      // @ 触发 YAML 引号包裹
      expect(md).toMatch(/trigger: "?@singleton"?/);
      expect(md).toContain('lifecycle: active');
      expect(md).toContain('language: swift');
      expect(md).toContain('category: Architecture');
      expect(md).toContain('kind: pattern');
      expect(md).toContain('knowledgeType: code-pattern');
      expect(md).toContain('complexity: intermediate');
      expect(md).toContain('scope: universal');
      expect(md).toContain('source: bootstrap');
      expect(md).toContain('createdBy: agent');
      expect(md).toContain('createdAt: 1739692800');
      expect(md).toContain('publishedAt: 1739779200');
      expect(md).toContain('publishedBy: reviewer-001');
      expect(md).toContain('reviewedBy: reviewer-001');
    });

    it('should include array fields as inline JSON', () => {
      const entry = makeEntry();
      const md = writer.serialize(entry);

      expect(md).toContain('tags: ["singleton","design-pattern"]');
      expect(md).toContain('headers: ["#import <Foundation/Foundation.h>"]');
      expect(md).toContain('headerPaths: ["Foundation/Foundation.h"]');
      expect(md).toContain('includeHeaders: true');
    });

    it('should include value objects as _ prefixed JSON', () => {
      const entry = makeEntry();
      const md = writer.serialize(entry);

      expect(md).toContain('_content: {');
      expect(md).toContain('_relations: {');
      expect(md).toContain('_constraints: {');
      expect(md).toContain('_reasoning: {');
      expect(md).toContain('_quality: {');
      expect(md).toContain('_stats: {');
      expect(md).toContain('_agentNotes: [');
    });

    it('should include content hash', () => {
      const entry = makeEntry();
      const md = writer.serialize(entry);

      expect(md).toMatch(/_contentHash: [a-f0-9]{16}/);
    });

    it('should build structured body when no markdown', () => {
      const entry = makeEntry();
      const md = writer.serialize(entry);
      const body = md.split(/^---$/m).slice(2).join('---').trim();

      expect(body).toContain('## Singleton Pattern');
      expect(body).toContain('> Standard singleton implementation');
      expect(body).toContain('```swift');
      expect(body).toContain('+ (instancetype)sharedInstance { ... }');
      expect(body).not.toContain('## 使用指南');
      expect(body).toContain('## 设计原理');
      expect(body).toContain('## 实施步骤');
      expect(body).toContain('## Why Standard');
    });

    it('should output markdown body directly when content.markdown is set', () => {
      const entry = makeEntry({
        content: {
          pattern: '',
          markdown: '# 项目特写 — Manager 管理\n\n这是一篇项目特写...',
          rationale: '',
          steps: [],
          codeChanges: [],
          verification: null,
        },
      });
      const md = writer.serialize(entry);
      const body = md.split(/^---$/m).slice(2).join('---').trim();

      expect(body).toContain('# 项目特写 — Manager 管理');
      expect(body).not.toContain('## Singleton Pattern');
    });

    it('should handle special characters in title by quoting', () => {
      const entry = makeEntry({ title: 'Title with: colon and #hash' });
      const md = writer.serialize(entry);

      expect(md).toContain('title: "Title with: colon and #hash"');
    });

    it('should skip empty/null fields', () => {
      const entry = makeEntry({
        difficulty: null,
        agentNotes: null,
        aiInsight: null,
        publishedAt: null,
        publishedBy: null,
      });
      const md = writer.serialize(entry);

      expect(md).not.toContain('difficulty:');
      expect(md).not.toContain('_agentNotes:');
      expect(md).not.toContain('_aiInsight:');
      expect(md).not.toContain('publishedAt:');
      expect(md).not.toContain('publishedBy:');
    });
  });

  /* ─── parse ─────────────────────────────── */

  describe('parseKnowledgeMarkdown', () => {
    it('should parse scalar fields from frontmatter', () => {
      const entry = makeEntry();
      const md = writer.serialize(entry);
      const parsed = parseKnowledgeMarkdown(md, 'architecture/singleton.md');

      expect(parsed.id).toBe('test-id-001');
      expect(parsed.title).toBe('Singleton Pattern');
      expect(parsed.trigger).toBe('@singleton');
      expect(parsed.lifecycle).toBe('active');
      expect(parsed.language).toBe('swift');
      expect(parsed.category).toBe('Architecture');
      expect(parsed.kind).toBe('pattern');
      expect(parsed.knowledgeType).toBe('code-pattern');
      expect(parsed.source).toBe('bootstrap');
      expect(parsed.createdAt).toBe(1739692800);
      expect(parsed.sourceFile).toBe('architecture/singleton.md');
    });

    it('should parse array fields', () => {
      const entry = makeEntry();
      const md = writer.serialize(entry);
      const parsed = parseKnowledgeMarkdown(md);

      expect(parsed.tags).toEqual(['singleton', 'design-pattern']);
      expect(parsed.headers).toEqual(['#import <Foundation/Foundation.h>']);
      expect(parsed.headerPaths).toEqual(['Foundation/Foundation.h']);
      expect(parsed.includeHeaders).toBe(true);
    });

    it('should parse _ prefixed JSON value objects', () => {
      const entry = makeEntry();
      const md = writer.serialize(entry);
      const parsed = parseKnowledgeMarkdown(md);

      // _content → content
      expect(parsed.content).toBeDefined();
      expect(parsed.content.pattern).toBe('+ (instancetype)sharedInstance { ... }');
      expect(parsed.content.rationale).toBe('确保全局唯一实例');

      // _relations → relations
      expect(parsed.relations).toBeDefined();
      expect(parsed.relations.extends).toHaveLength(1);
      expect(parsed.relations.extends[0].target).toBe('@factory');

      // _constraints → constraints
      expect(parsed.constraints).toBeDefined();
      expect(parsed.constraints.guards).toHaveLength(1);
      expect(parsed.constraints.guards[0].type).toBe('regex');

      // _reasoning → reasoning
      expect(parsed.reasoning).toBeDefined();
      expect(parsed.reasoning.whyStandard).toBe('项目大量使用此模式');
      expect(parsed.reasoning.confidence).toBe(0.85);

      // _quality → quality
      expect(parsed.quality).toBeDefined();
      expect(parsed.quality.overall).toBe(0.8);
      expect(parsed.quality.grade).toBe('B');

      // _stats → stats
      expect(parsed.stats).toBeDefined();
      expect(parsed.stats.views).toBe(100);
      expect(parsed.stats.guardHits).toBe(12);
    });

    it('should extract code from body when content.pattern is missing', () => {
      const md = `---
id: test-body
title: Test
lifecycle: active
language: swift
category: general
---

## Test

\`\`\`swift
let x = 42
\`\`\`
`;
      const parsed = parseKnowledgeMarkdown(md);
      expect(parsed.content.pattern).toBe('let x = 42');
    });

    it('should extract title from body heading when missing in frontmatter', () => {
      const md = `---
id: no-title
lifecycle: pending
language: swift
category: general
---

## My Heading Title

Some content here.
`;
      const parsed = parseKnowledgeMarkdown(md);
      expect(parsed.title).toBe('My Heading Title');
    });

    it('should handle boolean and numeric values', () => {
      const md = `---
id: types-test
title: Types
lifecycle: active
language: swift
category: general
probation: true
includeHeaders: false
createdAt: 1739692800
---
`;
      const parsed = parseKnowledgeMarkdown(md);
      expect(parsed.probation).toBe(true);
      expect(parsed.includeHeaders).toBe(false);
      expect(parsed.createdAt).toBe(1739692800);
    });

    it('should parse quoted string values', () => {
      const md = `---
id: quoted-test
title: "Title with: special chars"
lifecycle: active
language: swift
category: general
description: "包含冒号：和引号的描述"
---
`;
      const parsed = parseKnowledgeMarkdown(md);
      expect(parsed.title).toBe('Title with: special chars');
      expect(parsed.description).toBe('包含冒号：和引号的描述');
    });
  });

  /* ─── round-trip ────────────────────────── */

  describe('round-trip', () => {
    it('serialize → parse → fromJSON should preserve all fields', () => {
      const original = makeEntry();
      const md = writer.serialize(original);
      const parsed = parseKnowledgeMarkdown(md, 'architecture/singleton.md');
      const restored = KnowledgeEntry.fromJSON(parsed);

      // 标识
      expect(restored.id).toBe(original.id);
      expect(restored.title).toBe(original.title);
      expect(restored.trigger).toBe(original.trigger);
      expect(restored.description).toBe(original.description);

      // 生命周期
      expect(restored.lifecycle).toBe(original.lifecycle);

      // 分类
      expect(restored.language).toBe(original.language);
      expect(restored.category).toBe(original.category);
      expect(restored.kind).toBe(original.kind);
      expect(restored.knowledgeType).toBe(original.knowledgeType);
      expect(restored.complexity).toBe(original.complexity);
      expect(restored.scope).toBe(original.scope);
      expect(restored.tags).toEqual(original.tags);

      // 描述
      expect(restored.description).toBe(original.description);

      // 值对象
      expect(restored.content.toJSON()).toEqual(original.content.toJSON());
      expect(restored.relations.toJSON()).toEqual(original.relations.toJSON());
      expect(restored.constraints.toJSON()).toEqual(original.constraints.toJSON());
      expect(restored.reasoning.toJSON()).toEqual(original.reasoning.toJSON());
      expect(restored.quality.toJSON()).toEqual(original.quality.toJSON());
      expect(restored.stats.toJSON()).toEqual(original.stats.toJSON());

      // 头文件
      expect(restored.headers).toEqual(original.headers);
      expect(restored.headerPaths).toEqual(original.headerPaths);
      expect(restored.includeHeaders).toBe(original.includeHeaders);

      // 时间
      expect(restored.createdAt).toBe(original.createdAt);
      expect(restored.updatedAt).toBe(original.updatedAt);
      expect(restored.publishedAt).toBe(original.publishedAt);

      // 来源
      expect(restored.source).toBe(original.source);
      expect(restored.createdBy).toBe(original.createdBy);
    });

    it('应在 serialize → parse → serialize 中保持 hash 稳定', () => {
      const entry = makeEntry();
      const md1 = writer.serialize(entry);
      const parsed = parseKnowledgeMarkdown(md1);
      const entry2 = KnowledgeEntry.fromJSON(parsed);
      const md2 = writer.serialize(entry2);

      // 提取 hash 值
      const hash1 = md1.match(/_contentHash: ([a-f0-9]+)/)?.[1];
      const hash2 = md2.match(/_contentHash: ([a-f0-9]+)/)?.[1];

      expect(hash1).toBeDefined();
      expect(hash2).toBeDefined();
      // hash 应该相同（因为内容没变）
      expect(hash1).toBe(hash2);
    });

    it('candidate entry 的 round-trip 也应正常', () => {
      const entry = makeEntry({
        lifecycle: Lifecycle.PENDING,
        publishedAt: null,
        publishedBy: null,
      });
      const md = writer.serialize(entry);
      const parsed = parseKnowledgeMarkdown(md);
      const restored = KnowledgeEntry.fromJSON(parsed);

      expect(restored.lifecycle).toBe('pending');
      expect(restored.isCandidate()).toBe(true);
      expect(restored.content.toJSON()).toEqual(entry.content.toJSON());
    });
  });

  /* ─── computeKnowledgeHash ──────────────── */

  describe('computeKnowledgeHash', () => {
    it('should produce 16 char hex hash', () => {
      const hash = computeKnowledgeHash('hello world');
      expect(hash).toMatch(/^[a-f0-9]{16}$/);
    });

    it('should strip _contentHash line before hashing', () => {
      const content1 = 'line1\n_contentHash: abc123\nline2';
      const content2 = 'line1\nline2';
      expect(computeKnowledgeHash(content1)).toBe(computeKnowledgeHash(content2));
    });

    it('应对不同内容产生不同 hash', () => {
      const h1 = computeKnowledgeHash('content A');
      const h2 = computeKnowledgeHash('content B');
      expect(h1).not.toBe(h2);
    });
  });

  /* ─── persist ───────────────────────────── */

  describe('persist', () => {
    it('should write active entry to recipes directory', () => {
      const entry = makeEntry({ lifecycle: Lifecycle.ACTIVE });
      const result = writer.persist(entry);

      expect(result).not.toBeNull();
      expect(result).toContain('recipes');
      expect(result).toContain('architecture');
      expect(fs.existsSync(result)).toBe(true);

      const content = fs.readFileSync(result, 'utf8');
      expect(content).toContain('id: test-id-001');
    });

    it('should write candidate entry to candidates directory', () => {
      const entry = makeEntry({ lifecycle: Lifecycle.PENDING });
      const result = writer.persist(entry);

      expect(result).not.toBeNull();
      expect(result).toContain('candidates');
      expect(result).toContain('architecture');
      expect(fs.existsSync(result)).toBe(true);
    });

    it('should update sourceFile on entry after persist', () => {
      const entry = makeEntry({ lifecycle: Lifecycle.ACTIVE, sourceFile: null });
      writer.persist(entry);

      expect(entry.sourceFile).toBeDefined();
      expect(entry.sourceFile).toContain('AutoSnippet/recipes/architecture/');
    });

    it('should use trigger as filename when available', () => {
      const entry = makeEntry({ trigger: '@my-pattern', lifecycle: Lifecycle.ACTIVE });
      const result = writer.persist(entry);

      expect(path.basename(result)).toBe('my-pattern.md');
    });

    it('should use title slug when no trigger', () => {
      const entry = makeEntry({
        trigger: '',
        title: 'My Pattern Title',
        lifecycle: Lifecycle.ACTIVE,
      });
      const result = writer.persist(entry);

      expect(path.basename(result)).toBe('my-pattern-title.md');
    });

    it('should return null for entry without id or title', () => {
      const entry = makeEntry({ id: '', title: '' });
      const result = writer.persist(entry);
      expect(result).toBeNull();
    });
  });

  /* ─── remove ────────────────────────────── */

  describe('remove', () => {
    it('should remove persisted file', () => {
      const entry = makeEntry({ lifecycle: Lifecycle.ACTIVE });
      const filePath = writer.persist(entry);
      expect(fs.existsSync(filePath)).toBe(true);

      const result = writer.remove(entry);
      expect(result).toBe(true);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('should return false for entry without file', () => {
      const entry = makeEntry({ sourceFile: null, trigger: 'nonexistent-trigger' });
      const result = writer.remove(entry);
      expect(result).toBe(false);
    });
  });

  /* ─── moveOnLifecycleChange ─────────────── */

  describe('moveOnLifecycleChange', () => {
    it('应在 lifecycle 从 pending → active 时移动文件', () => {
      const entry = makeEntry({ lifecycle: Lifecycle.PENDING });
      const oldPath = writer.persist(entry);
      expect(oldPath).toContain('candidates');

      // 模拟 lifecycle 变更
      entry.lifecycle = Lifecycle.ACTIVE;
      const newPath = writer.moveOnLifecycleChange(entry);

      expect(newPath).toContain('recipes');
      expect(fs.existsSync(newPath)).toBe(true);
      // 旧文件应已删除
      expect(fs.existsSync(oldPath)).toBe(false);
    });
  });
});

/* ═══ KnowledgeSyncService ═══ */

describe('KnowledgeSyncService', () => {
  describe('_buildDbRow', () => {
    it('should map parsed wire format to DB row correctly', () => {
      const syncService = new KnowledgeSyncService('/tmp/test');
      const parsed = {
        id: 'sync-test-001',
        title: 'Test Entry',
        trigger: '@test',
        description: 'A test entry',
        lifecycle: 'active',
        lifecycleHistory: [{ from: 'pending', to: 'active', at: 123 }],
        probation: true,
        language: 'swift',
        category: 'View',
        kind: 'pattern',
        knowledgeType: 'code-pattern',
        complexity: 'intermediate',
        scope: 'universal',
        difficulty: 'beginner',
        tags: ['test'],
        content: { pattern: 'code', markdown: '' },
        relations: { related: [{ target: '@other', description: '' }] },
        constraints: { guards: [], boundaries: [] },
        reasoning: { whyStandard: 'reason', sources: ['a.swift'] },
        quality: { overall: 0.8 },
        stats: { views: 10 },
        headers: ['#import <UIKit/UIKit.h>'],
        headerPaths: ['UIKit/UIKit.h'],
        moduleName: 'UIKit',
        includeHeaders: true,
        agentNotes: ['note'],
        aiInsight: 'insight',
        reviewedBy: 'admin',
        reviewedAt: 1739779200,
        rejectionReason: null,
        source: 'mcp',
        sourceCandidateId: 'old-cand-001',
        createdBy: 'agent',
        createdAt: 1739692800,
        updatedAt: 1739779200,
        publishedAt: 1739779200,
        publishedBy: 'admin',
      };

      const rawContent = '---\nid: sync-test-001\n---\n\n## Test';
      const row = syncService._buildDbRow(parsed, 'AutoSnippet/recipes/view/test.md', rawContent);

      expect(row.id).toBe('sync-test-001');
      expect(row.title).toBe('Test Entry');
      expect(row.trigger).toBe('@test');
      expect(row.lifecycle).toBe('active');
      expect(row.language).toBe('swift');
      expect(row.category).toBe('View');
      expect(JSON.parse(row.tags)).toEqual(['test']);
      expect(JSON.parse(row.content)).toEqual({ pattern: 'code', markdown: '' });
      expect(JSON.parse(row.relations)).toEqual({
        related: [{ target: '@other', description: '' }],
      });
      expect(JSON.parse(row.reasoning)).toEqual({ whyStandard: 'reason', sources: ['a.swift'] });
      expect(row.includeHeaders).toBe(1);
      expect(JSON.parse(row.agentNotes)).toEqual(['note']);
      expect(row.sourceFile).toBe('AutoSnippet/recipes/view/test.md');
      expect(row.contentHash).toMatch(/^[a-f0-9]{16}$/);
    });

    it('should use defaults for missing fields', () => {
      const syncService = new KnowledgeSyncService('/tmp/test');
      const parsed = { id: 'min-001' };
      const row = syncService._buildDbRow(parsed, 'test.md', '---\nid: min-001\n---\n');

      expect(row.title).toBe('');
      expect(row.lifecycle).toBe('pending');
      expect(row.language).toBe('unknown');
      expect(row.category).toBe('general');
      expect(row.source).toBe('file-sync');
      expect(row.createdBy).toBe('file-sync');
    });
  });
});
