import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EvidenceCollector } from '@alembic/agent/domain';
import { ToolRouterAdapter } from '@alembic/agent/tools/runtime';
import { SourceGraphLifecycleService } from '@alembic/core';
import { openAlembicDatabase } from '@alembic/core/database';
import { pathGuard } from '@alembic/core/io';
import { validateAgainst } from '@alembic/core/knowledge';
import {
  createProjectRelations,
  type ProjectEvidenceContext,
  type ProjectRelations,
  parseRelationGraphRef,
} from '@alembic/core/project-context';
import { createAlembicRepositories } from '@alembic/core/repositories';
import { resolveDataRoot, WorkspaceResolver } from '@alembic/core/workspace';
import { afterEach, describe, expect, test } from 'vitest';
import * as AgentModule from '../../lib/injection/modules/AgentModule.js';
import { ServiceContainer } from '../../lib/injection/ServiceContainer.js';
import { resolveSourceIndexOptions } from '../../lib/project-scope/ProjectScopeAnalysis.js';
import {
  createProjectGraphPorts,
  type GraphCallList,
  type GraphHierarchy,
  type GraphImpact,
  type GraphOverview,
  type GraphProtocolInfo,
  type GraphSearchResult,
  type GraphTypeInfo,
  type GraphUnresolved,
} from '../../lib/tools/ProjectGraphPorts.js';
import { ToolContextFactory } from '../../lib/tools/ToolContextFactory.js';

/**
 * 一个小项目：跨文件的函数调用、类的继承与接口实现、两个同名函数、根目录下的文件，
 * 以及名字与路径里带 pending 的声明（图门禁曾经把这种字眼当成"引用待定"）。
 */
const PROJECT_FILES: Record<string, string> = {
  'package.json': '{ "name": "graph-fixture", "type": "module" }\n',
  'src/store.ts': [
    'export function readValue(key: string): string {',
    '  return key.trim();',
    '}',
    '',
    'export class Base {',
    '  describe(): string {',
    "    return 'base';",
    '  }',
    '}',
    '',
    'export interface Readable {',
    '  read(key: string): string;',
    '}',
    '',
    'export class Store extends Base implements Readable {',
    '  size = 0;',
    '  read(key: string): string {',
    '    return readValue(key);',
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/cache.ts': [
    "import { readValue, Store } from './store.js';",
    '',
    'export function load(key: string): string {',
    '  return readValue(key);',
    '}',
    '',
    'export function warm(): Store {',
    '  return new Store();',
    '}',
    '',
  ].join('\n'),
  'src/other.ts': ['export function load(): number {', '  return 1;', '}', ''].join('\n'),
  'src/pending/queue.ts': [
    "import { load } from '../cache.js';",
    '',
    'export function pending(key: string): string {',
    '  return load(key);',
    '}',
    '',
  ].join('\n'),
  'main.ts': [
    "import { pending } from './src/pending/queue.js';",
    '',
    'export function run(): string {',
    "  return pending('a');",
    '}',
    '',
  ].join('\n'),
};

interface Fixture {
  projectRoot: string;
  relations: ProjectRelations;
  /** 经 Agent 的工具路由执行一次 graph 调用，返回整个回执。 */
  graph(
    params: { type: string; entity: string; limit?: number } | 'overview'
  ): ReturnType<ToolRouterAdapter['execute']>;
  /** 回执里的查询结果。 */
  query<T>(type: string, entity: string, limit?: number): Promise<T>;
  factory: ToolContextFactory;
  advance(ms: number): void;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
  pathGuard._reset();
});

async function openFixture(
  options: { relations?: (real: ProjectRelations) => ProjectRelations } = {}
): Promise<Fixture> {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-graph-')));
  const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-graph-data-')));
  cleanups.push(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
  for (const [relativePath, content] of Object.entries(PROJECT_FILES)) {
    const filePath = path.join(projectRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  pathGuard.configure({ projectRoot: dataRoot, knowledgeBaseDir: 'Alembic' });
  const runtime = await openAlembicDatabase({ path: path.join(dataRoot, '.asd', 'alembic.db') });
  cleanups.push(() => runtime.close());

  let clock = 1_000_000;
  const real = createProjectRelations({
    repository: createAlembicRepositories(runtime.connection).sourceGraphRepository,
    now: () => clock,
  });
  const ports = createProjectGraphPorts({
    relations: options.relations ? options.relations(real) : real,
    // 夹具里只用自有链接器，不启动外部引擎。
    indexOptions: () => ({ projectRoot }),
  });
  const factory = new ToolContextFactory({
    container: { get: (name) => (name === 'projectGraphPorts' ? ports : undefined) },
    projectRoot,
  });
  const router = new ToolRouterAdapter({ contextFactory: factory });
  const graph: Fixture['graph'] = (params) =>
    router.execute({
      actor: { role: 'runtime', user: 'test' },
      args: params === 'overview' ? { action: 'overview' } : { action: 'query', params },
      source: { kind: 'runtime', name: 'test' },
      surface: 'runtime',
      toolId: 'graph',
    });
  return {
    projectRoot,
    relations: real,
    graph,
    async query<T>(type: string, entity: string, limit?: number) {
      const envelope = await graph({ type, entity, ...(limit ? { limit } : {}) });
      expect(envelope.ok, envelope.text).toBe(true);
      expect(envelope.structuredContent).toMatchObject({ type, entity });
      return (envelope.structuredContent as { result: T }).result;
    },
    factory,
    advance(ms) {
      clock += ms;
    },
  };
}

const names = (entries: Array<{ name: string }>) => entries.map((entry) => entry.name);

describe('graph 工具的宿主端口：回答来自 Core 的源码索引', () => {
  test('数据库就绪时 graph 工具可用；没有后端的查询类型如实缺席', async () => {
    const { factory } = await openFixture();
    const availability = factory.getAvailability({});
    expect(availability.actions.graph).toEqual(expect.arrayContaining(['overview', 'query']));
    expect(availability.parameters?.graph?.query?.type).toEqual(
      expect.arrayContaining([
        'class',
        'protocol',
        'hierarchy',
        'callers',
        'callees',
        'impact',
        'search',
      ])
    );
    // 方法覆写与扩展 / 分类的查询还没有索引事实支撑，不装作可用。
    expect(availability.parameters?.graph?.query?.type).not.toContain('overrides');
    expect(availability.parameters?.graph?.query?.type).not.toContain('extensions');

    const withoutDatabase = new ToolContextFactory({
      container: { get: () => undefined },
      projectRoot: process.cwd(),
    });
    expect(withoutDatabase.getAvailability({}).actions.graph).toEqual([]);
  });

  test('谁调用了它 / 它调用了谁：跨文件，每一处调用带位置与可复核的图引用', async () => {
    const fixture = await openFixture();
    const callers = await fixture.query<GraphCallList>('callers', 'readValue');
    expect(callers).toMatchObject({
      entity: 'readValue',
      direction: 'callers',
      symbol: { name: 'readValue', kind: 'function', location: 'src/store.ts:1' },
      truncated: false,
      index: { freshness: 'fresh', coverageGaps: 0 },
    });
    expect(callers.calls).toEqual([
      expect.objectContaining({
        name: 'load',
        location: 'src/cache.ts:3',
        sites: ['src/cache.ts:4'],
        tier: 'certain',
      }),
      expect.objectContaining({
        name: 'Store.read',
        location: 'src/store.ts:17',
        sites: ['src/store.ts:18'],
      }),
    ]);

    // 图引用：一行读得懂的文本，方括号里的关系引用对着当前源码复核得过。
    expect(callers.graphRefs).toHaveLength(2);
    expect(callers.graphRefs[0]).toMatch(
      /^graph:calls load -> readValue \[relation-site:root:src\/cache\.ts:calls:readValue:L4-L4:[\d-]+:[a-f0-9]{16}\]$/
    );
    for (const graphRef of callers.graphRefs) {
      const cited = parseRelationGraphRef(graphRef);
      expect(cited).toMatchObject({ kind: 'calls', to: 'readValue', tier: 'certain' });
      const evidence = await fixture.relations.query({
        kind: 'evidence',
        scope: { projectRoot: fixture.projectRoot },
        target: { ref: cited?.refId },
        includeText: true,
      });
      expect(evidence.data as ProjectEvidenceContext).toMatchObject({
        current: true,
        text: expect.stringContaining('readValue(key)'),
      });
    }

    const callees = await fixture.query<GraphCallList>('callees', 'warm');
    expect(callees.direction).toBe('callees');
    expect(names(callees.calls)).toEqual(['Store']);
  });

  test('同名声明如实报告歧义并给出可重问的写法；没有的名字给相近的声明', async () => {
    const fixture = await openFixture();
    const ambiguous = await fixture.query<GraphUnresolved>('callers', 'load');
    expect(ambiguous).toMatchObject({ entity: 'load', resolved: false, reason: 'ambiguous' });
    expect(ambiguous.candidates.sort()).toEqual(['src/cache.ts#load', 'src/other.ts#load']);

    // 照着候选重问就唯一了；调用方在名字与路径都带 pending 的文件里。
    const narrowed = await fixture.query<GraphCallList>('callers', 'src/cache.ts#load');
    expect(names(narrowed.calls)).toEqual(['pending']);
    expect(narrowed.calls[0].sites).toEqual(['src/pending/queue.ts:4']);

    const missing = await fixture.query<GraphUnresolved>('callers', 'loadd');
    expect(missing).toMatchObject({ resolved: false, reason: 'not-found' });
    expect(missing.candidates).toEqual(
      expect.arrayContaining(['src/cache.ts#load', 'src/other.ts#load'])
    );
    expect(
      (await fixture.query<GraphUnresolved>('callers', 'NoSuchThingAnywhere')).candidates
    ).toEqual([]);
  });

  test('模型常用的几种写法都认：带括号、Type#member、路径:行号', async () => {
    const fixture = await openFixture();
    expect(names((await fixture.query<GraphCallList>('callers', 'readValue()')).calls)).toEqual([
      'load',
      'Store.read',
    ]);
    expect(names((await fixture.query<GraphCallList>('callees', 'Store#read')).calls)).toEqual([
      'readValue',
    ]);
    // 第 18 行在 Store.read 体内。
    expect(names((await fixture.query<GraphCallList>('callees', 'src/store.ts:18')).calls)).toEqual(
      ['readValue']
    );
    // 根目录下的文件名长得像 Type.member：当声明找不到，再当文件找。
    const fileLevel = await fixture.query<GraphCallList>('callees', 'main.ts');
    expect(fileLevel.filePath).toBe('main.ts');
    expect(names(fileLevel.calls)).toEqual(['pending']);
  });

  test('类、协议与层级：成员、书面父类型与项目内的继承关系', async () => {
    const fixture = await openFixture();
    const store = await fixture.query<GraphTypeInfo>('class', 'Store');
    expect(store).toMatchObject({
      className: 'Store',
      kind: 'class',
      filePath: 'src/store.ts',
      line: 15,
      superClass: 'Base',
      protocols: ['Readable'],
      methods: ['read'],
      properties: ['size'],
      memberCount: 2,
      subtypes: [],
    });
    expect(store.graphRefs.map((ref) => parseRelationGraphRef(ref))).toEqual([
      expect.objectContaining({ kind: 'extends', from: 'Store', to: 'Base' }),
      expect.objectContaining({ kind: 'implements', from: 'Store', to: 'Readable' }),
    ]);

    const readable = await fixture.query<GraphProtocolInfo>('protocol', 'Readable');
    expect(readable).toMatchObject({
      protocolName: 'Readable',
      filePath: 'src/store.ts',
      methods: ['read'],
      conformers: ['Store'],
    });
    expect(readable.graphRefs).toHaveLength(1);

    const hierarchy = await fixture.query<GraphHierarchy>('hierarchy', 'Base');
    expect(hierarchy.symbol).toMatchObject({ name: 'Base', location: 'src/store.ts:5' });
    expect(hierarchy.supertypes).toEqual([]);
    expect(hierarchy.subtypes).toEqual([
      expect.objectContaining({ name: 'Store', distance: 1, location: 'src/store.ts:15' }),
    ]);
    const upward = await fixture.query<GraphHierarchy>('hierarchy', 'Store');
    expect(upward.declared).toEqual({ extends: ['Base'], implements: ['Readable'] });
    expect(names(upward.supertypes).sort()).toEqual(['Base', 'Readable']);
  });

  test('影响面、搜索与概览', async () => {
    const fixture = await openFixture();
    // 改了 store.ts：导入它的文件，以及隔着几层依赖它的文件。
    const impact = await fixture.query<GraphImpact>('impact', 'src/store.ts');
    expect(impact.impactedFiles.sort()).toEqual([
      'main.ts',
      'src/cache.ts',
      'src/pending/queue.ts',
    ]);
    expect(names(impact.impactedSymbols)).toEqual(
      expect.arrayContaining(['load', 'warm', 'pending', 'run'])
    );
    // 引用名额先给跨文件的关系：第一条是别的文件对 store.ts 的依赖，不是它内部的调用。
    const firstCited = parseRelationGraphRef(impact.graphRefs[0]);
    expect(firstCited?.site.filePath).not.toBe('src/store.ts');
    expect(impact.graphRefs.length).toBeGreaterThan(1);
    // 只给符号：受影响的是用到它的地方。
    const symbolImpact = await fixture.query<GraphImpact>('impact', 'pending');
    expect(symbolImpact.impactedFiles).toEqual(['main.ts']);

    const search = await fixture.query<GraphSearchResult>('search', 'load');
    expect(search.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'load', kind: 'function', location: 'src/cache.ts:3' }),
        expect.objectContaining({ name: 'load', location: 'src/other.ts:1' }),
      ])
    );

    const envelope = await fixture.graph('overview');
    expect(envelope.ok, envelope.text).toBe(true);
    const overview = envelope.structuredContent as GraphOverview;
    expect(overview.index).toMatchObject({ freshness: 'fresh', coverageGaps: 0 });
    expect(overview.index.files).toBe(Object.keys(PROJECT_FILES).length);
    expect(overview.index.relations).toBeGreaterThan(0);
    expect(overview.modules.map((module) => module.name)).toEqual(expect.arrayContaining(['src']));
  });

  test('查询前把索引追到当前源码；短时间内的连续查询复用上一次追到的那一代', async () => {
    const fixture = await openFixture();
    expect(names((await fixture.query<GraphCallList>('callers', 'readValue')).calls)).toEqual([
      'load',
      'Store.read',
    ]);

    // 源码变了：复用期内看到的仍是上一次追到的那一代。
    fs.appendFileSync(
      path.join(fixture.projectRoot, 'src/other.ts'),
      "\nimport { readValue } from './store.js';\nexport function extra(): string {\n  return readValue('x');\n}\n"
    );
    expect(
      names((await fixture.query<GraphCallList>('callers', 'src/store.ts#readValue')).calls)
    ).toEqual(['load', 'Store.read']);

    // 过了复用期再问（换一种写法，绕开工具按参数做的会话缓存）：回答跟上新源码。
    fixture.advance(31_000);
    const refreshed = await fixture.query<GraphCallList>('callers', 'src/store.ts#readValue()');
    expect(names(refreshed.calls)).toEqual(expect.arrayContaining(['load', 'extra', 'Store.read']));
  });

  test('索引建不起来是故障，不是"没有结果"', async () => {
    const fixture = await openFixture({
      relations: (real) => ({
        ensureIndex: async () => ({
          available: false,
          freshness: 'uninitialized',
          coverageGaps: 0,
          externalEngine: 'absent',
          reason: 'fixture: index build failed',
        }),
        query: real.query,
      }),
    });
    const envelope = await fixture.graph({ type: 'callers', entity: 'readValue' });
    expect(envelope).toMatchObject({ ok: false, status: 'error' });
    expect(envelope.text).toContain('Source index is unavailable');
    expect(envelope.text).toContain('fixture: index build failed');
  });
});

describe('图门禁的正向路径：真实 graph 查询 → 可复制的图引用 → 调用链论断放行', () => {
  /** 一条带调用链论断的候选；graphRefs 由用例给。 */
  const claim = (graphRefs: string[]) => ({
    title: 'Queue reads through the cache',
    kind: 'fact',
    description: 'pending is the only caller of load; the call chain ends in readValue.',
    reasoning: { graphRefs },
  });
  const graphCodes = (graphRefs: string[]) =>
    validateAgainst([claim(graphRefs)], { stage: 2, path: 'in-process', profile: 'opportunistic' })
      .map((violation) => violation.code)
      .filter((code) => code === 'GRAPH_REF_INVALID' || code === 'STALE_GRAPH');

  test('Agent 的证据采集把查询回执里的图引用收下，门禁据此放行', async () => {
    const fixture = await openFixture();
    const collector = new EvidenceCollector();
    const calls = [
      { type: 'callers', entity: 'src/cache.ts#load' },
      { type: 'callees', entity: 'pending' },
      { type: 'class', entity: 'Store' },
      // 没落到声明上的查询不产生引用。
      { type: 'callers', entity: 'load' },
    ];
    for (const [round, params] of calls.entries()) {
      const envelope = await fixture.graph(params);
      collector.processToolCall(
        { tool: 'graph', args: { action: 'query', params }, envelope },
        round
      );
    }
    const { graphEvidence, evidenceMap, explorationLog } = collector.build();

    // 每一条都是 Core 认得的图引用；名字与路径里的 pending 只是数据。
    expect(graphEvidence.length).toBeGreaterThanOrEqual(3);
    expect(graphEvidence.every((ref) => parseRelationGraphRef(ref) !== undefined)).toBe(true);
    expect(graphEvidence[0]).toMatch(
      /^graph:calls pending -> load \[relation-site:root:src\/pending\/queue\.ts:/
    );
    expect(evidenceMap.get('src/store.ts')).toMatchObject({ role: 'class-definition' });
    expect(explorationLog.map((entry) => entry.effective)).toEqual([true, true, true, false]);

    // 没有图引用的调用链论断被拦；带上真实查询得来的引用就放行——不靠改写措辞。
    expect(graphCodes([])).toEqual(['GRAPH_REF_INVALID']);
    expect(graphCodes(graphEvidence)).toEqual([]);
  });
});

describe('容器接线：AgentModule 把图端口接到宿主数据库的源码索引上', () => {
  test('挖掘准备阶段建好的索引，graph 工具直接读，不再重建', async () => {
    const projectRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-graph-wiring-'))
    );
    cleanups.push(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    const files = {
      ...PROJECT_FILES,
      // Swift 的跨文件关系由外部引擎解析；宿主的索引选项里启用了它。
      'Sources/App/Greeter.swift': 'protocol Greeter {\n    func greet() -> String\n}\n',
      'Sources/App/Service.swift':
        'final class Service: Greeter {\n    func greet() -> String {\n        return "hi"\n    }\n}\n',
    };
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = path.join(projectRoot, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
    pathGuard.configure({ projectRoot, knowledgeBaseDir: 'Alembic' });
    const runtime = await openAlembicDatabase({
      path: path.join(projectRoot, '.asd', 'alembic.db'),
    });
    cleanups.push(() => runtime.close());
    const repositories = createAlembicRepositories(runtime.connection);

    const container = new ServiceContainer();
    container.singletons._projectRoot = projectRoot;
    container.singletons._workspaceResolver = WorkspaceResolver.fromProject(projectRoot);
    AgentModule.register(container);
    container.register('sourceGraphRepository', () => repositories.sourceGraphRepository);

    // 挖掘准备阶段：用宿主的那一份选项把索引建起来。
    const indexOptions = resolveSourceIndexOptions(container, {
      projectRoot,
      dataRoot: resolveDataRoot(container),
    });
    const lifecycle = new SourceGraphLifecycleService(repositories.sourceGraphRepository);
    const built = await lifecycle.catchUpOnStartup(indexOptions);
    expect(built.action).toBe('built-full');

    // 之后 Agent 的 graph 工具经容器里的路由查询。
    const router = container.get('toolRouter') as ToolRouterAdapter;
    const envelope = await router.execute({
      actor: { role: 'runtime', user: 'test' },
      args: { action: 'query', params: { type: 'callers', entity: 'readValue' } },
      source: { kind: 'runtime', name: 'test' },
      surface: 'runtime',
      toolId: 'graph',
    });
    expect(envelope.ok, envelope.text).toBe(true);
    const result = (envelope.structuredContent as { result: GraphCallList }).result;
    expect(names(result.calls)).toEqual(['load', 'Store.read']);
    expect(result.graphRefs).toHaveLength(2);

    // Swift 的继承列表不区分父类与协议：项目内解析出 Greeter 是被遵循的，它就归到协议里；
    // 这条关系来自外部引擎，图引用如实标成可信档。
    const swift = await router.execute({
      actor: { role: 'runtime', user: 'test' },
      args: { action: 'query', params: { type: 'class', entity: 'Service' } },
      source: { kind: 'runtime', name: 'test' },
      surface: 'runtime',
      toolId: 'graph',
    });
    expect(swift.ok, swift.text).toBe(true);
    const service = (swift.structuredContent as { result: GraphTypeInfo }).result;
    expect(service).toMatchObject({
      className: 'Service',
      filePath: 'Sources/App/Service.swift',
      protocols: ['Greeter'],
      methods: ['greet'],
    });
    expect(service.superClass).toBeUndefined();
    expect(service.graphRefs).toEqual([
      expect.stringMatching(/^graph:implements Service -> Greeter \(trusted\) \[relation-site:/),
    ]);

    // 工具读的就是那一代：两处的选项一致，谁也不把对方的索引判成过期。
    const latest = await repositories.sourceGraphRepository.getLatestSnapshot(
      built.projectRoot,
      built.repoId
    );
    expect(latest?.generationId).toBe(built.generationId);
    expect((await lifecycle.catchUpOnStartup(indexOptions)).action).toBe('fresh-noop');
  }, 120_000);
});
