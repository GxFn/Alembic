/**
 * 集成测试：Zod Schemas — MCP/HTTP/Config 运行时校验
 *
 * 覆盖范围:
 *   - common.ts 基础 schema（PaginationSchema, ContentSchema, ReasoningSchema 等）
 *   - mcp-tools.ts MCP 工具输入 schema（SearchInput, KnowledgeInput 等）
 *   - http-requests.ts HTTP 路由 schema（CRUD + 批量 + 搜索）
 *   - config.ts 配置文件 schema（AppConfigSchema）
 *   - TOOL_SCHEMAS 映射表完整性
 */

// ── common schemas ──────────────────────────────────
// ── config schemas ──────────────────────────────────
import {
  AppConfigSchema,
  ComplexityEnum,
  ContentSchema,
  IdField,
  KindEnum,
  KnowledgeTypeEnum,
  LanguageField,
  PaginationSchema,
  ReasoningSchema,
  ScopeEnum,
  StrictKindEnum,
  TitleField,
} from '@alembic/core/shared';
import { z } from 'zod';

// ── HTTP request schemas ────────────────────────────
import {
  BatchPublishBody,
  CreateGuardRuleBody,
  CreateKnowledgeBody,
  ResidentSearchBody,
  SearchQuery,
  UpdateKnowledgeBody,
} from '../../lib/shared/schemas/http-requests.js';
// ── MCP tools schemas ───────────────────────────────
import {
  GraphInput,
  GuardInput,
  HealthInput,
  KnowledgeInput,
  RescanInput,
  SearchInput,
  SkillInput,
  StructureInput,
  SubmitKnowledgeInput,
  TOOL_SCHEMAS,
} from '../../lib/shared/schemas/mcp-tools.js';

describe('Integration: Zod Schemas — common.ts', () => {
  describe('PaginationSchema', () => {
    test('should apply defaults', () => {
      const result = PaginationSchema.parse({});
      expect(result.limit).toBe(20);
      expect(result.offset).toBe(0);
    });

    test('should accept valid values', () => {
      const result = PaginationSchema.parse({ limit: 50, offset: 100 });
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(100);
    });

    test('should reject out-of-range values', () => {
      expect(() => PaginationSchema.parse({ limit: 0 })).toThrow();
      expect(() => PaginationSchema.parse({ limit: 201 })).toThrow();
      expect(() => PaginationSchema.parse({ offset: -1 })).toThrow();
    });
  });

  describe('Enums', () => {
    test('KindEnum should accept valid values', () => {
      expect(KindEnum.parse('all')).toBe('all');
      expect(KindEnum.parse('rule')).toBe('rule');
      expect(KindEnum.parse('pattern')).toBe('pattern');
      expect(KindEnum.parse('fact')).toBe('fact');
    });

    test('KindEnum should reject invalid values', () => {
      expect(() => KindEnum.parse('invalid')).toThrow();
    });

    test('StrictKindEnum should not accept "all"', () => {
      expect(() => StrictKindEnum.parse('all')).toThrow();
      expect(StrictKindEnum.parse('rule')).toBe('rule');
    });

    test('KnowledgeTypeEnum should accept all knowledge types', () => {
      const validTypes = [
        'code-pattern',
        'architecture',
        'best-practice',
        'code-standard',
        'code-style',
        'code-relation',
        'data-flow',
        'event-and-data-flow',
        'module-dependency',
        'boundary-constraint',
        'solution',
        'anti-pattern',
      ];
      for (const t of validTypes) {
        expect(KnowledgeTypeEnum.parse(t)).toBe(t);
      }
    });

    test('ComplexityEnum should accept valid values', () => {
      expect(ComplexityEnum.parse('beginner')).toBe('beginner');
      expect(ComplexityEnum.parse('intermediate')).toBe('intermediate');
      expect(ComplexityEnum.parse('advanced')).toBe('advanced');
    });

    test('ScopeEnum should accept valid values', () => {
      expect(ScopeEnum.parse('universal')).toBe('universal');
      expect(ScopeEnum.parse('project-specific')).toBe('project-specific');
    });
  });

  describe('ContentSchema', () => {
    test('should accept valid content with pattern', () => {
      const result = ContentSchema.parse({
        pattern: 'some pattern',
        rationale: 'because',
      });
      expect(result.pattern).toBe('some pattern');
    });

    test('should accept valid content with markdown', () => {
      const result = ContentSchema.parse({
        markdown: '# Title',
        rationale: 'because',
      });
      expect(result.markdown).toBe('# Title');
    });

    test('should reject content without pattern or markdown', () => {
      expect(() => ContentSchema.parse({ rationale: 'because' })).toThrow();
    });

    test('should reject content without rationale', () => {
      expect(() => ContentSchema.parse({ pattern: 'some' })).toThrow();
    });
  });

  describe('ReasoningSchema', () => {
    test('should accept valid reasoning', () => {
      const result = ReasoningSchema.parse({
        whyStandard: 'Industry best practice',
        sources: ['doc.md'],
        confidence: 0.9,
      });
      expect(result.whyStandard).toBe('Industry best practice');
      expect(result.confidence).toBe(0.9);
    });

    test('should reject empty sources', () => {
      expect(() =>
        ReasoningSchema.parse({
          whyStandard: 'x',
          sources: [],
          confidence: 0.5,
        })
      ).toThrow();
    });

    test('should reject confidence out of range', () => {
      expect(() =>
        ReasoningSchema.parse({
          whyStandard: 'x',
          sources: ['a'],
          confidence: 1.5,
        })
      ).toThrow();
    });
  });

  describe('Field schemas', () => {
    test('IdField should reject empty string', () => {
      expect(() => IdField.parse('')).toThrow();
      expect(IdField.parse('abc')).toBe('abc');
    });

    test('TitleField should reject empty string', () => {
      expect(() => TitleField.parse('')).toThrow();
    });

    test('LanguageField should reject empty string', () => {
      expect(() => LanguageField.parse('')).toThrow();
    });
  });
});

describe('Integration: Zod Schemas — mcp-tools.ts', () => {
  describe('HealthInput', () => {
    test('should accept empty object', () => {
      expect(HealthInput.parse({})).toEqual({});
    });
  });

  describe('SearchInput', () => {
    test('should apply defaults', () => {
      const result = SearchInput.parse({ query: 'auth' });
      expect(result.query).toBe('auth');
      expect(result.mode).toBe('auto');
      expect(result.kind).toBe('all');
      expect(result.limit).toBe(10);
    });

    test('should reject empty query', () => {
      expect(() => SearchInput.parse({ query: '' })).toThrow();
    });

    test('should reject invalid mode', () => {
      expect(() => SearchInput.parse({ query: 'x', mode: 'invalid' })).toThrow();
    });

    test('should accept explicit metadata filter fields', () => {
      const result = SearchInput.parse({
        dimensionId: 'dim-1',
        filters: { scope: 'project-specific' },
        knowledgeType: 'code-pattern',
        language: 'typescript',
        query: 'test',
        tags: ['search', 'telemetry'],
      });
      expect(result.dimensionId).toBe('dim-1');
      expect(result.filters).toEqual({ scope: 'project-specific' });
      expect(result.knowledgeType).toBe('code-pattern');
      expect(result.language).toBe('typescript');
      expect(result.tags).toEqual(['search', 'telemetry']);
    });

    test('should reject retired public search modes', () => {
      expect(() => SearchInput.parse({ query: 'x', mode: 'bm25' })).toThrow();
      expect(() => SearchInput.parse({ query: 'x', mode: 'context' })).toThrow();
    });
  });

  describe('KnowledgeInput', () => {
    test('should default to list operation', () => {
      const result = KnowledgeInput.parse({});
      expect(result.operation).toBe('list');
    });

    test('should require id for get operation', () => {
      expect(() => KnowledgeInput.parse({ operation: 'get' })).toThrow();
    });

    test('should accept get with id', () => {
      const result = KnowledgeInput.parse({ operation: 'get', id: 'k-1' });
      expect(result.id).toBe('k-1');
    });
  });

  describe('StructureInput', () => {
    test('should apply defaults', () => {
      const result = StructureInput.parse({});
      expect(result.operation).toBe('targets');
      expect(result.includeSummary).toBe(true);
      expect(result.includeContent).toBe(false);
    });
  });

  describe('GraphInput', () => {
    test('should require operation', () => {
      expect(() => GraphInput.parse({})).toThrow();
    });

    test('should accept valid operation', () => {
      const result = GraphInput.parse({ operation: 'stats' });
      expect(result.direction).toBe('both');
      expect(result.maxDepth).toBe(3);
    });
  });

  describe('GuardInput', () => {
    test('should accept empty input', () => {
      const result = GuardInput.parse({});
      expect(result).toBeDefined();
    });

    test('should accept code + language', () => {
      const result = GuardInput.parse({ code: 'console.log("x")', language: 'js' });
      expect(result.code).toBe('console.log("x")');
    });
  });

  describe('SubmitKnowledgeInput', () => {
    test('accepts source-backed production metadata and session references', () => {
      const result = SubmitKnowledgeInput.parse({
        bootstrapSessionRef: 'bootstrap-session:bs-asq',
        items: [
          {
            graphRefs: ['sourceGraph:search-handler'],
            headerPaths: ['lib/resident/tool-handlers/consolidated.ts'],
            includeHeaders: true,
            moduleName: 'resident-tools',
            relations: { related: [{ target: 'knowledge:k-asq' }] },
            sourceCandidateId: 'cand-asq',
            sourceFile: 'lib/resident/tool-handlers/consolidated.ts',
            sourceGraph: { ref: 'sourceGraph:search-handler' },
            sourceGraphRefs: ['sourceGraph:search-handler'],
            sourceRefs: ['lib/resident/tool-handlers/consolidated.ts:220'],
            title: 'ASQ source-backed publication route',
          },
        ],
        requireProductionSession: true,
        sessionId: 'bs-asq',
      });

      expect(result.sessionId).toBe('bs-asq');
      expect(result.bootstrapSessionRef).toBe('bootstrap-session:bs-asq');
      expect(result.requireProductionSession).toBe(true);
      expect(result.items[0]).toMatchObject({
        graphRefs: ['sourceGraph:search-handler'],
        moduleName: 'resident-tools',
        sourceCandidateId: 'cand-asq',
        sourceFile: 'lib/resident/tool-handlers/consolidated.ts',
        sourceGraphRefs: ['sourceGraph:search-handler'],
      });
    });
  });

  describe('RescanInput', () => {
    test('accepts controller-authorized produce session route input', () => {
      const result = RescanInput.parse({
        produceSession: {
          controllerAuthorized: true,
          gaps: [
            {
              createBudget: 2,
              dimensionId: 'asq-publication',
              gapId: 'asq4b1b-knowledge-pack',
              triggerPrefix: 'asq4b1b',
            },
          ],
          source: 'asq-controller',
        },
        reason: 'asq-produce-session-route',
      });

      expect(result.produceSession?.gaps?.[0]).toMatchObject({
        createBudget: 2,
        dimensionId: 'asq-publication',
        gapId: 'asq4b1b-knowledge-pack',
      });
    });
  });

  describe('SkillInput', () => {
    test('should require operation', () => {
      expect(() => SkillInput.parse({})).toThrow();
    });

    test('should accept valid operation', () => {
      const result = SkillInput.parse({ operation: 'list' });
      expect(result.operation).toBe('list');
      expect(result.overwrite).toBe(false);
    });
  });

  describe('TOOL_SCHEMAS mapping', () => {
    test('should have schema for every MCP tool', () => {
      const expectedTools = [
        'alembic_health',
        'alembic_search',
        'alembic_knowledge',
        'alembic_structure',
        'alembic_graph',
        'alembic_call_context',
        'alembic_guard',
        'alembic_submit_knowledge',
        'alembic_skill',
        'alembic_bootstrap',
        'alembic_dimension_complete',
        'alembic_knowledge_lifecycle',
      ];
      for (const tool of expectedTools) {
        expect(TOOL_SCHEMAS[tool]).toBeDefined();
        expect(TOOL_SCHEMAS[tool]).toBeInstanceOf(z.ZodType);
      }
    });

    test('DCR-deleted tools stay absent from the schema map', () => {
      // Train B DCR wave: P0 all-delete verdicts with zero external consumers.
      expect(TOOL_SCHEMAS.alembic_wiki).toBeUndefined();
      expect(TOOL_SCHEMAS.alembic_enrich_candidates).toBeUndefined();
    });

    test('should have at least 13 entries', () => {
      expect(Object.keys(TOOL_SCHEMAS).length).toBeGreaterThanOrEqual(13);
    });
  });
});

describe('Integration: Zod Schemas — http-requests.ts', () => {
  describe('CreateKnowledgeBody', () => {
    test('should accept minimal valid input', () => {
      const result = CreateKnowledgeBody.parse({
        title: 'My Pattern',
        content: 'Some content',
      });
      expect(result.title).toBe('My Pattern');
    });

    test('should accept object content', () => {
      const result = CreateKnowledgeBody.parse({
        title: 'Test',
        content: { pattern: 'x', markdown: 'y' },
      });
      expect(result.content).toEqual({ pattern: 'x', markdown: 'y' });
    });

    test('keeps caller metadata but strips unnamed public extras', () => {
      const result = CreateKnowledgeBody.parse({
        title: 'Test',
        content: 'Some content',
        metadata: { owner: 'client' },
        accidentalBackendField: 'not-public',
      });
      const record = result as Record<string, unknown>;
      expect(record.metadata).toEqual({ owner: 'client' });
      expect(record.accidentalBackendField).toBeUndefined();
    });

    test('should reject empty title', () => {
      expect(() => CreateKnowledgeBody.parse({ title: '', content: 'x' })).toThrow();
    });

    test('should reject empty string content', () => {
      expect(() => CreateKnowledgeBody.parse({ title: 'x', content: '' })).toThrow();
    });
  });

  describe('UpdateKnowledgeBody', () => {
    test('should accept partial updates', () => {
      const result = UpdateKnowledgeBody.parse({ title: 'New Title' });
      expect(result.title).toBe('New Title');
    });

    test('should reject empty object', () => {
      expect(() => UpdateKnowledgeBody.parse({})).toThrow();
    });
  });

  describe('BatchPublishBody', () => {
    test('should accept array of ids', () => {
      const result = BatchPublishBody.parse({ ids: ['a', 'b', 'c'] });
      expect(result.ids).toHaveLength(3);
    });

    test('should reject empty ids array', () => {
      expect(() => BatchPublishBody.parse({ ids: [] })).toThrow();
    });

    test('should reject empty string in ids', () => {
      expect(() => BatchPublishBody.parse({ ids: [''] })).toThrow();
    });
  });

  describe('CreateGuardRuleBody', () => {
    test('should accept with name and pattern', () => {
      const result = CreateGuardRuleBody.parse({
        name: 'no-eval',
        pattern: 'eval\\(',
      });
      expect(result.name).toBe('no-eval');
      expect(result.severity).toBe('warning'); // default
    });

    test('should require name or ruleId', () => {
      expect(() => CreateGuardRuleBody.parse({ pattern: 'x' })).toThrow();
    });

    test('should require pattern', () => {
      expect(() => CreateGuardRuleBody.parse({ name: 'test' })).toThrow();
    });
  });

  describe('SearchQuery', () => {
    test('should require query string', () => {
      expect(() => SearchQuery.parse({ q: '' })).toThrow();
    });

    test('should apply defaults', () => {
      const result = SearchQuery.parse({ q: 'auth' });
      expect(result.type).toBe('all');
      expect(result.mode).toBe('keyword');
    });

    test('should reject retired public GET modes', () => {
      expect(() => SearchQuery.parse({ q: 'auth', mode: 'bm25' })).toThrow();
      expect(() => SearchQuery.parse({ q: 'auth', mode: 'context' })).toThrow();
    });
  });

  describe('ResidentSearchBody', () => {
    test('should accept explicit metadata filter fields', () => {
      const result = ResidentSearchBody.parse({
        dimensionId: 'dim-1',
        filters: { scope: 'project-specific' },
        knowledgeType: 'code-pattern',
        mode: 'semantic',
        query: 'auth',
        tags: ['search', 'telemetry'],
      });

      expect(result.dimensionId).toBe('dim-1');
      expect(result.filters).toEqual({ scope: 'project-specific' });
      expect(result.knowledgeType).toBe('code-pattern');
      expect(result.mode).toBe('semantic');
      expect(result.tags).toEqual(['search', 'telemetry']);
    });

    test('should reject retired public POST modes', () => {
      expect(() => ResidentSearchBody.parse({ query: 'auth', mode: 'bm25' })).toThrow();
      expect(() => ResidentSearchBody.parse({ query: 'auth', mode: 'context' })).toThrow();
    });
  });
});

describe('Integration: Zod Schemas — config.ts', () => {
  describe('AppConfigSchema', () => {
    test('should accept empty config (all optional)', () => {
      const result = AppConfigSchema.parse({});
      expect(result).toBeDefined();
    });

    test('should accept full config', () => {
      const result = AppConfigSchema.parse({
        database: { type: 'sqlite', path: './test.db' },
        server: { port: 8080, host: '0.0.0.0' },
        logging: { level: 'debug', console: true },
      });
      expect(result.database?.type).toBe('sqlite');
      expect(result.server?.port).toBe(8080);
    });

    test('should reject invalid port', () => {
      expect(() =>
        AppConfigSchema.parse({
          server: { port: 99999 },
        })
      ).toThrow();
    });

    test('should reject invalid log level', () => {
      expect(() =>
        AppConfigSchema.parse({
          logging: { level: 'verbose' },
        })
      ).toThrow();
    });

    test('should allow passthrough fields', () => {
      const result = AppConfigSchema.parse({ customField: 'value' });
      expect((result as Record<string, unknown>).customField).toBe('value');
    });
  });
});
