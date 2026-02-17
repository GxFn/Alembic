import { jest } from '@jest/globals';
import { estimateTokens, truncateToTokenBudget, BUDGET } from '../../lib/service/cursor/TokenBudget.js';
import { KnowledgeCompressor } from '../../lib/service/cursor/KnowledgeCompressor.js';
import { TopicClassifier } from '../../lib/service/cursor/TopicClassifier.js';
import { RulesGenerator } from '../../lib/service/cursor/RulesGenerator.js';
import { SkillsSyncer } from '../../lib/service/cursor/SkillsSyncer.js';
import { CursorDeliveryPipeline } from '../../lib/service/cursor/CursorDeliveryPipeline.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/* ════════════════════════════════════════════
 *  TokenBudget
 * ════════════════════════════════════════════ */

describe('TokenBudget', () => {
  test('estimateTokens — English text', () => {
    const tokens = estimateTokens('Hello world this is a test');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(20);
  });

  test('estimateTokens — CJK text costs more tokens per char', () => {
    const en = estimateTokens('abc'); // 3 chars → ~0.75 → 1 token
    const cjk = estimateTokens('你好啊'); // 3 CJK chars → ~1.5 → 2 tokens
    expect(cjk).toBeGreaterThan(en);
  });

  test('estimateTokens — empty/null', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  test('truncateToTokenBudget — keeps within budget', () => {
    const lines = Array(50).fill('This is a line with some tokens');
    const result = truncateToTokenBudget(lines, 50);
    expect(result.tokensUsed).toBeLessThanOrEqual(50);
    expect(result.kept.length).toBeLessThan(50);
    expect(result.dropped).toBeGreaterThan(0);
  });

  test('truncateToTokenBudget — keeps all if within budget', () => {
    const lines = ['short', 'text'];
    const result = truncateToTokenBudget(lines, 5000);
    expect(result.kept).toEqual(lines);
    expect(result.dropped).toBe(0);
  });

  test('BUDGET constants are set', () => {
    expect(BUDGET.CHANNEL_A_MAX).toBe(400);
    expect(BUDGET.CHANNEL_B_MAX_PER_FILE).toBe(750);
    expect(BUDGET.CHANNEL_A_MAX_RULES).toBe(8);
    expect(BUDGET.CHANNEL_B_MAX_PATTERNS).toBe(5);
  });
});

/* ════════════════════════════════════════════
 *  KnowledgeCompressor
 * ════════════════════════════════════════════ */

describe('KnowledgeCompressor', () => {
  let compressor;

  beforeEach(() => {
    compressor = new KnowledgeCompressor();
  });

  const makeEntry = (overrides = {}) => ({
    title: '[Bootstrap] best-practice/单例模式',
    description: 'Use dispatch_once for singletons',
    kind: 'rule',
    lifecycle: 'active',
    trigger: '@singleton',
    doClause: 'Use dispatch_once for all singleton implementations',
    dontClause: 'use init directly for singleton classes',
    whenClause: 'Implementing singleton pattern',
    coreCode: '+ (instancetype)sharedInstance {\n  static id _inst;\n  dispatch_once(&t, ^{ _inst = [[self alloc] init]; });\n  return _inst;\n}',
    content: {
      markdown: '## 单例模式\n\n本项目中有 42 个类采用 dispatch_once 单例模式...',
      pattern: '',
    },
    quality: { confidence: 0.9, authorityScore: 0.8 },
    stats: { useCount: 5 },
    tags: ['singleton'],
    ...overrides,
  });

  describe('compressToRuleLine', () => {
    test('produces one-line rules from doClause', () => {
      const entries = [makeEntry()];
      const lines = compressor.compressToRuleLine(entries);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^- /);
      expect(lines[0]).toContain('dispatch_once');
    });

    test('includes dontClause as Do NOT', () => {
      const entries = [makeEntry()];
      const lines = compressor.compressToRuleLine(entries);
      expect(lines[0]).toContain('Do NOT');
      expect(lines[0]).toContain('use init directly');
    });

    test('skips entries without doClause', () => {
      const entries = [makeEntry({ doClause: '' })];
      const lines = compressor.compressToRuleLine(entries);
      expect(lines).toHaveLength(0);
    });
  });

  describe('compressToWhenDoDont', () => {
    test('produces structured output from delivery fields', () => {
      const entries = [makeEntry({ kind: 'pattern' })];
      const results = compressor.compressToWhenDoDont(entries);
      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('trigger', '@singleton');
      expect(results[0]).toHaveProperty('when', 'Implementing singleton pattern');
      expect(results[0]).toHaveProperty('do', 'Use dispatch_once for all singleton implementations');
      expect(results[0]).toHaveProperty('dont', 'use init directly for singleton classes');
      expect(results[0]).toHaveProperty('template');
      expect(results[0].template).toContain('sharedInstance');
    });

    test('skips entries missing required fields', () => {
      const entries = [makeEntry({ trigger: '' })];
      const results = compressor.compressToWhenDoDont(entries);
      expect(results).toHaveLength(0);
    });

    test('deduplicates triggers with suffix', () => {
      const entries = [makeEntry(), makeEntry()];
      const results = compressor.compressToWhenDoDont(entries);
      expect(results).toHaveLength(2);
      expect(results[0].trigger).toBe('@singleton');
      expect(results[1].trigger).toBe('@singleton-2');
    });
  });

  describe('formatWhenDoDont', () => {
    test('formats to Markdown with code block', () => {
      const compressed = [{
        trigger: '@test-pattern',
        when: 'Testing',
        do: 'Use test pattern',
        dont: 'Skip validation',
        template: 'test()',
      }];
      const md = compressor.formatWhenDoDont(compressed);
      expect(md).toContain('### @test-pattern');
      expect(md).toContain('**When**: Testing');
      expect(md).toContain('**Do**: Use test pattern');
      expect(md).toContain("**Don't**: Skip validation");
      expect(md).toContain('```');
      expect(md).toContain('test()');
    });

    test('omits code block when template is empty', () => {
      const compressed = [{
        trigger: '@no-code',
        when: 'Something',
        do: 'Do it',
        dont: '',
        template: '',
      }];
      const md = compressor.formatWhenDoDont(compressed);
      expect(md).not.toContain('```');
      expect(md).not.toContain("Don't");
    });
  });
});

/* ════════════════════════════════════════════
 *  TopicClassifier
 * ════════════════════════════════════════════ */

describe('TopicClassifier', () => {
  let classifier;

  beforeEach(() => {
    classifier = new TopicClassifier('TestProject');
  });

  test('groups entries by topicHint', () => {
    const entries = [
      { title: 'Network Request', description: 'HTTP API request handling', topicHint: 'networking', tags: [] },
      { title: 'UI Layout', description: 'View controller layout setup', topicHint: 'ui', tags: [] },
    ];
    const grouped = classifier.group(entries);
    expect(grouped.networking).toHaveLength(1);
    expect(grouped.ui).toHaveLength(1);
  });

  test('entries without topicHint go to general', () => {
    const entries = [{ title: 'Something Unique', description: 'no topic hint', tags: [] }];
    const grouped = classifier.group(entries);
    expect(grouped.general).toHaveLength(1);
  });

  test('buildDescription includes project name and keywords', () => {
    const entries = [{ title: 'API Client', description: 'HTTP handling' }];
    const desc = classifier.buildDescription('networking', entries);
    expect(desc).toContain('TestProject');
    expect(desc).toContain('network');
    expect(desc).toContain('HTTP');
  });

  test('empty entries returns empty groups', () => {
    const grouped = classifier.group([]);
    expect(Object.keys(grouped)).toHaveLength(0);
  });
});

/* ════════════════════════════════════════════
 *  RulesGenerator
 * ════════════════════════════════════════════ */

describe('RulesGenerator', () => {
  let tmpDir;
  let generator;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-rules-test-'));
    generator = new RulesGenerator(tmpDir, 'TestProject');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('writeAlwaysOnRules', () => {
    test('creates .mdc file with alwaysApply: true', () => {
      const lines = [
        '- Use dispatch_once for singletons.',
        '- All HTTP calls go through NetworkManager.',
      ];
      const result = generator.writeAlwaysOnRules(lines);
      expect(result.rulesCount).toBe(2);
      expect(result.tokensUsed).toBeGreaterThan(0);
      expect(result.tokensUsed).toBeLessThanOrEqual(BUDGET.CHANNEL_A_MAX);

      const content = fs.readFileSync(result.filePath, 'utf8');
      expect(content).toContain('alwaysApply: true');
      expect(content).toContain('TestProject');
      expect(content).toContain('dispatch_once');
      expect(content).toContain('autosnippet_search');
    });

    test('respects max rules budget', () => {
      const lines = Array(20).fill('- A rule that should be truncated.');
      const result = generator.writeAlwaysOnRules(lines);
      expect(result.rulesCount).toBeLessThanOrEqual(BUDGET.CHANNEL_A_MAX_RULES);
    });
  });

  describe('writeSmartRules', () => {
    test('creates .mdc file with alwaysApply: false', () => {
      const body = '### @test\n- **When**: Testing\n- **Do**: Use patterns';
      const desc = 'Test patterns for TestProject - testing, validation';
      const result = generator.writeSmartRules('testing', body, desc);
      expect(result.tokensUsed).toBeGreaterThan(0);

      const content = fs.readFileSync(result.filePath, 'utf8');
      expect(content).toContain('alwaysApply: false');
      expect(content).toContain('Testing Patterns');
      expect(content).toContain('@test');
    });

    test('file name includes topic', () => {
      const result = generator.writeSmartRules('networking', 'body', 'desc');
      expect(path.basename(result.filePath)).toBe('autosnippet-patterns-networking.mdc');
    });
  });

  describe('cleanDynamicFiles', () => {
    test('removes dynamic files, keeps static', () => {
      const rulesDir = path.join(tmpDir, '.cursor', 'rules');
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(path.join(rulesDir, 'autosnippet-project-rules.mdc'), 'dynamic');
      fs.writeFileSync(path.join(rulesDir, 'autosnippet-patterns-ui.mdc'), 'dynamic');
      fs.writeFileSync(path.join(rulesDir, 'autosnippet-conventions.mdc'), 'static');

      generator.cleanDynamicFiles();

      expect(fs.existsSync(path.join(rulesDir, 'autosnippet-project-rules.mdc'))).toBe(false);
      expect(fs.existsSync(path.join(rulesDir, 'autosnippet-patterns-ui.mdc'))).toBe(false);
      expect(fs.existsSync(path.join(rulesDir, 'autosnippet-conventions.mdc'))).toBe(true);
    });
  });
});

/* ════════════════════════════════════════════
 *  SkillsSyncer
 * ════════════════════════════════════════════ */

describe('SkillsSyncer', () => {
  let tmpDir;
  let syncer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-skills-test-'));
    syncer = new SkillsSyncer(tmpDir, 'TestProject');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('sync returns empty when source dir missing', async () => {
    const result = await syncer.sync();
    expect(result.synced).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test('sync converts SKILL.md to Cursor format', async () => {
    // Create source skill
    const srcDir = path.join(tmpDir, 'AutoSnippet', 'skills', 'project-architecture');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'SKILL.md'), [
      '---',
      'name: project-architecture',
      'description: Auto-generated skill',
      'createdBy: bootstrap-v3',
      '---',
      '',
      '# Architecture',
      '',
      'The project uses modular architecture.',
    ].join('\n'));

    const result = await syncer.sync();
    expect(result.synced).toContain('autosnippet-architecture');

    // Check output
    const outputPath = path.join(tmpDir, '.cursor', 'skills', 'autosnippet-architecture', 'SKILL.md');
    expect(fs.existsSync(outputPath)).toBe(true);

    const content = fs.readFileSync(outputPath, 'utf8');
    expect(content).toContain('name: autosnippet-architecture');
    expect(content).toContain('TestProject');
    expect(content).toContain('modular architecture');
    expect(content).toContain('autosnippet_search');

    // Check references/RECIPES.md exists
    const recipesPath = path.join(tmpDir, '.cursor', 'skills', 'autosnippet-architecture', 'references', 'RECIPES.md');
    expect(fs.existsSync(recipesPath)).toBe(true);
  });

  test('sync skips dirs without SKILL.md', async () => {
    const srcDir = path.join(tmpDir, 'AutoSnippet', 'skills', 'empty-skill');
    fs.mkdirSync(srcDir, { recursive: true });

    const result = await syncer.sync();
    expect(result.skipped).toContain('empty-skill');
  });
});

/* ════════════════════════════════════════════
 *  CursorDeliveryPipeline (Integration)
 * ════════════════════════════════════════════ */

describe('CursorDeliveryPipeline', () => {
  let tmpDir;
  let mockKnowledgeService;
  let pipeline;

  const makeEntries = () => [
    {
      id: '1', title: '[Bootstrap] code-standard/命名规范', kind: 'rule', lifecycle: 'active',
      description: 'Use camelCase for variables, PascalCase for classes',
      trigger: '@naming-convention',
      doClause: 'Use camelCase for variables and PascalCase for classes',
      dontClause: 'use snake_case naming',
      whenClause: 'Naming variables and classes',
      topicHint: 'conventions',
      content: { markdown: '## 命名规范\n\n本项目 50 个文件统一采用驼峰命名法', pattern: '' },
      quality: { confidence: 0.95, authorityScore: 0.9 },
      stats: { useCount: 10 },
      tags: ['naming'],
    },
    {
      id: '2', title: '[Bootstrap] architecture/单例模式', kind: 'rule', lifecycle: 'active',
      description: 'Use dispatch_once for singletons',
      trigger: '@singleton',
      doClause: 'Use dispatch_once for all singleton implementations',
      dontClause: 'use init directly for singleton classes',
      whenClause: 'Implementing singleton pattern',
      topicHint: 'architecture',
      content: { markdown: '## 单例\n\n42 个类使用 dispatch_once', pattern: '' },
      quality: { confidence: 0.9, authorityScore: 0.85 },
      stats: {},
      tags: ['singleton'],
    },
    {
      id: '3', title: '[Bootstrap] code-pattern/网络请求', kind: 'pattern', lifecycle: 'active',
      description: 'Use BLNetworkManager for all HTTP requests',
      trigger: '@network-request',
      doClause: 'Use BLNetworkManager for all HTTP requests',
      dontClause: 'use NSURLSession directly',
      whenClause: 'Making HTTP network requests',
      topicHint: 'networking',
      coreCode: '[[BLNetworkManager sharedInstance] GET:url params:params success:^(id data) {} failure:^(NSError *err) {}];',
      content: {
        markdown: '## 网络请求模式\n\n共 28 处使用此模式',
        pattern: '',
      },
      quality: { confidence: 0.88, authorityScore: 0.75 },
      stats: {},
      tags: ['network', 'api'],
    },
    {
      id: '4', title: '[Bootstrap] code-pattern/UI布局', kind: 'pattern', lifecycle: 'active',
      description: 'Use auto layout constraints for UI layout',
      trigger: '@ui-layout',
      doClause: 'Use Masonry framework for auto layout constraints',
      dontClause: 'set frames manually',
      whenClause: 'Setting up UI layout',
      topicHint: 'ui',
      content: { markdown: '## UI 布局\n\n使用 Masonry 框架设置 autolayout 约束', pattern: '' },
      quality: { confidence: 0.85, authorityScore: 0.7 },
      stats: {},
      tags: ['ui', 'layout'],
    },
  ];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asd-pipeline-test-'));
    mockKnowledgeService = {
      list: jest.fn().mockImplementation(async (filters) => {
        const entries = makeEntries();
        if (filters.lifecycle === 'active') return entries;
        if (filters.lifecycle === 'pending') return [];
        return entries;
      }),
    };
    pipeline = new CursorDeliveryPipeline({
      knowledgeService: mockKnowledgeService,
      projectRoot: tmpDir,
      projectName: 'TestProject',
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('deliver generates Channel A rules file', async () => {
    const result = await pipeline.deliver();
    expect(result.channelA.rulesCount).toBeGreaterThan(0);
    expect(result.channelA.tokensUsed).toBeGreaterThan(0);
    expect(result.channelA.tokensUsed).toBeLessThanOrEqual(BUDGET.CHANNEL_A_MAX);

    const filePath = path.join(tmpDir, '.cursor', 'rules', 'autosnippet-project-rules.mdc');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('alwaysApply: true');
  });

  test('deliver generates Channel B smart rules files', async () => {
    const result = await pipeline.deliver();
    expect(result.channelB.topicCount).toBeGreaterThan(0);
    expect(result.channelB.patternsCount).toBeGreaterThan(0);

    // Check at least one pattern file exists
    const rulesDir = path.join(tmpDir, '.cursor', 'rules');
    const files = fs.readdirSync(rulesDir).filter(f => f.startsWith('autosnippet-patterns-'));
    expect(files.length).toBeGreaterThan(0);

    const content = fs.readFileSync(path.join(rulesDir, files[0]), 'utf8');
    expect(content).toContain('alwaysApply: false');
  });

  test('deliver stats include duration', async () => {
    const result = await pipeline.deliver();
    expect(result.stats.duration).toBeGreaterThanOrEqual(0);
    expect(result.stats.totalTokensUsed).toBeGreaterThan(0);
  });

  test('deliver handles empty knowledge base', async () => {
    mockKnowledgeService.list.mockResolvedValue([]);
    const result = await pipeline.deliver();
    expect(result.channelA.rulesCount).toBe(0);
    expect(result.channelB.topicCount).toBe(0);
  });

  test('Channel A token budget stays within 400', async () => {
    // Create many rules to test budget enforcement
    const manyRules = Array(20).fill(null).map((_, i) => ({
      id: String(i), title: `Rule ${i}`, kind: 'rule', lifecycle: 'active',
      description: `Rule ${i} description with enough text to consume tokens`,
      doClause: `Rule ${i} doClause — always follow this convention in the project`,
      dontClause: `violate rule ${i}`,
      content: { markdown: `Rule ${i} content`, pattern: '' },
      quality: { confidence: 0.9, authorityScore: 0.5 },
      stats: {},
      tags: [],
    }));
    mockKnowledgeService.list.mockImplementation(async (filters) => {
      if (filters.lifecycle === 'active') return manyRules;
      return [];
    });

    const result = await pipeline.deliver();
    expect(result.channelA.tokensUsed).toBeLessThanOrEqual(BUDGET.CHANNEL_A_MAX);
    expect(result.channelA.rulesCount).toBeLessThanOrEqual(BUDGET.CHANNEL_A_MAX_RULES);
  });
});
