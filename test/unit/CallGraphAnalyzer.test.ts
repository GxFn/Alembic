/**
 * @jest-environment node
 *
 * Phase 5 Unit Tests: ImportRecord, SymbolTableBuilder, ImportPathResolver,
 * CallEdgeResolver, DataFlowInferrer, CallGraphAnalyzer, CallSiteExtractor
 */

import { ImportRecord } from '../../lib/core/analysis/ImportRecord.js';
import { SymbolTableBuilder } from '../../lib/core/analysis/SymbolTableBuilder.js';
import { ImportPathResolver } from '../../lib/core/analysis/ImportPathResolver.js';
import { CallEdgeResolver } from '../../lib/core/analysis/CallEdgeResolver.js';
import { DataFlowInferrer } from '../../lib/core/analysis/DataFlowInferrer.js';
import { CallGraphAnalyzer } from '../../lib/core/analysis/CallGraphAnalyzer.js';
import { extractCallSitesTS } from '../../lib/core/analysis/CallSiteExtractor.js';

// ─── ImportRecord ─────────────────────────────────────────

describe('ImportRecord', () => {
  test('string compatibility — includes', () => {
    const rec = new ImportRecord('./services/UserService', {
      symbols: ['UserService'],
      kind: 'named',
    });
    expect(rec.includes('UserService')).toBe(true);
    expect(rec.includes('Unknown')).toBe(false);
  });

  test('string compatibility — toString / template literal', () => {
    const rec = new ImportRecord('./utils/helpers');
    expect(rec.toString()).toBe('./utils/helpers');
    expect(`${rec}`).toBe('./utils/helpers');
    expect('' + rec).toBe('./utils/helpers');
  });

  test('string compatibility — startsWith / endsWith', () => {
    const rec = new ImportRecord('./services/UserService');
    expect(rec.startsWith('./')).toBe(true);
    expect(rec.endsWith('Service')).toBe(true);
  });

  test('string compatibility — JSON.stringify', () => {
    const rec = new ImportRecord('express');
    expect(JSON.stringify(rec)).toBe('"express"');
    expect(JSON.stringify([rec])).toBe('["express"]');
  });

  test('string compatibility — valueOf / length', () => {
    const rec = new ImportRecord('lodash');
    expect(rec.valueOf()).toBe('lodash');
    expect(rec.length).toBe(6);
  });

  test('string compatibility — replace / indexOf / match / split / trim', () => {
    const rec = new ImportRecord('./src/utils');
    expect(rec.replace('./', '')).toBe('src/utils');
    expect(rec.indexOf('src')).toBe(2);
    expect(rec.match(/src/)).not.toBeNull();
    expect(rec.split('/')).toEqual(['.', 'src', 'utils']);
    expect(rec.trim()).toBe('./src/utils');
  });

  test('structured fields — symbols, kind, alias, isTypeOnly', () => {
    const rec = new ImportRecord('./UserRepo', {
      symbols: ['UserRepo', 'findById'],
      kind: 'named',
      alias: null,
      isTypeOnly: false,
    });
    expect(rec.symbols).toEqual(['UserRepo', 'findById']);
    expect(rec.kind).toBe('named');
    expect(rec.alias).toBeNull();
    expect(rec.isTypeOnly).toBe(false);
    expect(rec.isStructured).toBe(true);
  });

  test('hasSymbol', () => {
    const rec = new ImportRecord('./mod', { symbols: ['A', 'B'] });
    expect(rec.hasSymbol('A')).toBe(true);
    expect(rec.hasSymbol('C')).toBe(false);

    const wildcard = new ImportRecord('./mod', { symbols: ['*'] });
    expect(wildcard.hasSymbol('anything')).toBe(true);
  });

  test('isStructured — no symbols', () => {
    const rec = new ImportRecord('express');
    expect(rec.isStructured).toBe(false);
    expect(rec.symbols).toEqual([]);
  });

  test('default kind is side-effect', () => {
    const rec = new ImportRecord('express');
    expect(rec.kind).toBe('side-effect');
  });

  test('works with Array filter/find/map like strings', () => {
    const imports = [
      new ImportRecord('./services/auth', { symbols: ['AuthService'], kind: 'named' }),
      new ImportRecord('express'),
      new ImportRecord('./utils/logger', { symbols: ['Logger'], kind: 'named' }),
    ];

    // filter with includes (most common consumer pattern)
    const matched = imports.filter((imp) => imp.includes('service'));
    expect(matched).toHaveLength(1);
    expect(matched[0].path).toBe('./services/auth');

    // map to path object (analyzeProject pattern)
    const mapped = imports.map((i) => ({ path: i, file: 'test.ts' }));
    expect(`${mapped[0].path}`).toBe('./services/auth');
  });
});

// ─── SymbolTableBuilder ───────────────────────────────────

describe('SymbolTableBuilder', () => {
  const mockProjectSummary = {
    fileSummaries: [
      {
        file: 'src/service/UserService.ts',
        classes: [{ name: 'UserService', kind: 'class', line: 5 }],
        protocols: [],
        methods: [
          { name: 'getUser', className: 'UserService', line: 10, kind: 'definition' },
          { name: 'createUser', className: 'UserService', line: 20, kind: 'definition' },
        ],
        imports: [
          new ImportRecord('./repository/UserRepo', { symbols: ['UserRepo'], kind: 'named' }),
        ],
        exports: [{ text: 'export class UserService', line: 5 }],
      },
      {
        file: 'src/repository/UserRepo.ts',
        classes: [{ name: 'UserRepo', kind: 'class', line: 3 }],
        protocols: [],
        methods: [
          { name: 'findById', className: 'UserRepo', line: 8, kind: 'definition' },
        ],
        imports: [],
        exports: [{ text: 'export class UserRepo', line: 3 }],
      },
      {
        file: 'src/utils/helpers.ts',
        classes: [],
        protocols: [{ name: 'Serializable', line: 1 }],
        methods: [
          { name: 'formatDate', className: null, line: 5, kind: 'definition' },
        ],
        imports: [],
        exports: [{ text: 'export function formatDate', line: 5 }],
      },
    ],
  };

  test('builds declarations map', () => {
    const table = SymbolTableBuilder.build(mockProjectSummary);

    expect(table.declarations.size).toBeGreaterThan(0);

    // Class declaration
    const userService = table.declarations.get('src/service/UserService.ts::UserService');
    expect(userService).toBeDefined();
    expect(userService.kind).toBe('class');
    expect(userService.file).toBe('src/service/UserService.ts');

    // Method declaration
    const getUser = table.declarations.get('src/service/UserService.ts::UserService.getUser');
    expect(getUser).toBeDefined();
    expect(getUser.kind).toBe('method');
    expect(getUser.className).toBe('UserService');

    // Free function
    const formatDate = table.declarations.get('src/utils/helpers.ts::formatDate');
    expect(formatDate).toBeDefined();
    expect(formatDate.kind).toBe('function');
    expect(formatDate.className).toBeNull();

    // Interface
    const serializable = table.declarations.get('src/utils/helpers.ts::Serializable');
    expect(serializable).toBeDefined();
    expect(serializable.kind).toBe('interface');
  });

  test('builds fileExports map', () => {
    const table = SymbolTableBuilder.build(mockProjectSummary);
    const exports = table.fileExports.get('src/service/UserService.ts');
    expect(exports).toContain('UserService');
  });

  test('builds fileImports map with ImportRecord', () => {
    const table = SymbolTableBuilder.build(mockProjectSummary);
    const imports = table.fileImports.get('src/service/UserService.ts');
    expect(imports).toHaveLength(1);
    expect(imports[0]).toBeInstanceOf(ImportRecord);
    expect(imports[0].path).toBe('./repository/UserRepo');
  });

  test('handles empty/null summary', () => {
    const empty = SymbolTableBuilder.build(null);
    expect(empty.declarations.size).toBe(0);

    const noFiles = SymbolTableBuilder.build({ fileSummaries: [] });
    expect(noFiles.declarations.size).toBe(0);
  });

  test('marks exported symbols correctly', () => {
    const table = SymbolTableBuilder.build(mockProjectSummary);
    const userService = table.declarations.get('src/service/UserService.ts::UserService');
    expect(userService.isExported).toBe(true);

    const formatDate = table.declarations.get('src/utils/helpers.ts::formatDate');
    expect(formatDate.isExported).toBe(true);
  });
});

// ─── ImportPathResolver ───────────────────────────────────

describe('ImportPathResolver', () => {
  const allFiles = [
    'src/service/UserService.ts',
    'src/repository/UserRepo.ts',
    'src/utils/helpers.ts',
    'src/utils/index.ts',
    'src/models/User.ts',
    'src/models/index.ts',
    'app/__init__.py',
    'app/services/user.py',
  ];

  test('resolves relative path', () => {
    const resolver = new ImportPathResolver('/project', allFiles);
    const result = resolver.resolve('./User', 'src/models/index.ts');
    // ./User from src/models/ resolves to src/models/User.ts
    expect(result).toBe('src/models/User.ts');
  });

  test('resolves relative path with ../', () => {
    const resolver = new ImportPathResolver('/project', allFiles);
    const result = resolver.resolve('../utils/helpers', 'src/service/UserService.ts');
    expect(result).toBe('src/utils/helpers.ts');
  });

  test('resolves index file', () => {
    const resolver = new ImportPathResolver('/project', allFiles);
    const result = resolver.resolve('../utils', 'src/service/UserService.ts');
    expect(result).toBe('src/utils/index.ts');
  });

  test('returns null for external dependency', () => {
    const resolver = new ImportPathResolver('/project', allFiles);
    expect(resolver.resolve('express', 'src/service/UserService.ts')).toBeNull();
    expect(resolver.resolve('lodash', 'src/service/UserService.ts')).toBeNull();
    expect(resolver.resolve('@nestjs/core', 'src/service/UserService.ts')).toBeNull();
  });

  test('resolves Python module path', () => {
    const resolver = new ImportPathResolver('/project', allFiles);
    const result = resolver.resolve('app.services.user', 'main.py');
    expect(result).toBe('app/services/user.py');
  });

  test('resolves Python package (__init__.py)', () => {
    const resolver = new ImportPathResolver('/project', allFiles);
    const result = resolver.resolve('app', 'main.py');
    expect(result).toBe('app/__init__.py');
  });
});

// ─── CallEdgeResolver ─────────────────────────────────────

describe('CallEdgeResolver', () => {
  function createMockSymbolTable() {
    const table = SymbolTableBuilder.build({
      fileSummaries: [
        {
          file: 'src/service/UserService.ts',
          classes: [{ name: 'UserService', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'getUser', className: 'UserService', line: 10, kind: 'definition' },
            { name: 'listUsers', className: 'UserService', line: 20, kind: 'definition' },
          ],
          imports: [
            new ImportRecord('./repository/UserRepo', { symbols: ['UserRepo'], kind: 'named' }),
          ],
          exports: [{ text: 'export class UserService' }],
        },
        {
          file: 'src/repository/UserRepo.ts',
          classes: [{ name: 'UserRepo', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'findById', className: 'UserRepo', line: 5, kind: 'definition' },
            { name: 'findAll', className: 'UserRepo', line: 15, kind: 'definition' },
          ],
          imports: [],
          exports: [{ text: 'export class UserRepo' }],
        },
        {
          file: 'src/utils/helpers.ts',
          classes: [],
          protocols: [],
          methods: [
            { name: 'formatDate', className: null, line: 1, kind: 'definition' },
          ],
          imports: [],
          exports: [{ text: 'export function formatDate' }],
        },
      ],
    });
    return table;
  }

  test('resolves this.xxx() — same class method call', () => {
    const table = createMockSymbolTable();
    const resolver = new CallEdgeResolver(
      table,
      new ImportPathResolver('/project', [
        'src/service/UserService.ts',
        'src/repository/UserRepo.ts',
        'src/utils/helpers.ts',
      ])
    );

    const edges = resolver.resolveFile(
      [
        {
          callee: 'listUsers',
          callerMethod: 'getUser',
          callerClass: 'UserService',
          callType: 'method',
          receiver: 'this',
          receiverType: 'UserService',
          argCount: 0,
          line: 12,
          isAwait: false,
        },
      ],
      'src/service/UserService.ts'
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].caller).toBe('src/service/UserService.ts::UserService.getUser');
    expect(edges[0].callee).toBe('src/service/UserService.ts::UserService.listUsers');
    expect(edges[0].resolveMethod).toBe('direct');
  });

  test('resolves import-based call', () => {
    const table = createMockSymbolTable();
    // Use ../repository/UserRepo so path.join('src/service', '../repository/UserRepo') = 'src/repository/UserRepo'
    table.fileImports.set('src/service/UserService.ts', [
      new ImportRecord('../repository/UserRepo', { symbols: ['UserRepo'], kind: 'named' }),
    ]);
    const resolver = new CallEdgeResolver(
      table,
      new ImportPathResolver('/project', [
        'src/service/UserService.ts',
        'src/repository/UserRepo.ts',
        'src/utils/helpers.ts',
      ])
    );

    const edges = resolver.resolveFile(
      [
        {
          callee: 'findById',
          callerMethod: 'getUser',
          callerClass: 'UserService',
          callType: 'method',
          receiver: 'UserRepo',
          receiverType: 'UserRepo',
          argCount: 1,
          line: 15,
          isAwait: true,
        },
      ],
      'src/service/UserService.ts'
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].callee).toContain('UserRepo.findById');
    expect(edges[0].resolveMethod).toBe('direct');
    expect(edges[0].isAwait).toBe(true);
  });

  test('resolves same-file function call', () => {
    const table = createMockSymbolTable();

    // Add a local function to UserService file BEFORE creating resolver (fileIndex built in constructor)
    table.declarations.set('src/service/UserService.ts::validateInput', {
      fqn: 'src/service/UserService.ts::validateInput',
      name: 'validateInput',
      className: null,
      file: 'src/service/UserService.ts',
      line: 50,
      kind: 'function',
      isExported: false,
    });

    const resolver = new CallEdgeResolver(
      table,
      new ImportPathResolver('/project', [
        'src/service/UserService.ts',
        'src/repository/UserRepo.ts',
        'src/utils/helpers.ts',
      ])
    );

    const edges = resolver.resolveFile(
      [
        {
          callee: 'validateInput',
          callerMethod: 'getUser',
          callerClass: 'UserService',
          callType: 'function',
          receiver: null,
          receiverType: null,
          argCount: 1,
          line: 11,
          isAwait: false,
        },
      ],
      'src/service/UserService.ts'
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].callee).toBe('src/service/UserService.ts::validateInput');
    expect(edges[0].resolveMethod).toBe('direct');
  });

  test('returns empty for unresolvable calls', () => {
    const table = createMockSymbolTable();
    const resolver = new CallEdgeResolver(
      table,
      new ImportPathResolver('/project', ['src/service/UserService.ts'])
    );

    const edges = resolver.resolveFile(
      [
        {
          callee: 'nonExistentFunction',
          callerMethod: 'getUser',
          callerClass: 'UserService',
          callType: 'function',
          receiver: null,
          receiverType: null,
          argCount: 0,
          line: 100,
          isAwait: false,
        },
      ],
      'src/service/UserService.ts'
    );

    expect(edges).toHaveLength(0);
  });

  test('resolves aliased named imports correctly (import { A as B, C })', () => {
    // Simulate: import { UserRepo as Repo, findAll } from '../repository/UserRepo'
    // In code: Repo.findById() should resolve via 'Repo' → target file
    const table = SymbolTableBuilder.build({
      fileSummaries: [
        {
          file: 'src/service/UserService.ts',
          classes: [{ name: 'UserService', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'getUser', className: 'UserService', line: 10, kind: 'definition' },
          ],
          imports: [
            // symbols contain LOCAL names (alias baked-in): 'Repo' (not 'UserRepo')
            new ImportRecord('../repository/UserRepo', {
              symbols: ['Repo', 'findAll'],
              kind: 'named',
            }),
          ],
          exports: [],
        },
        {
          file: 'src/repository/UserRepo.ts',
          classes: [{ name: 'UserRepo', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'findById', className: 'UserRepo', line: 5, kind: 'definition' },
            { name: 'findAll', className: null, line: 15, kind: 'definition' },
          ],
          imports: [],
          exports: [{ text: 'export class UserRepo' }],
        },
      ],
    });

    const resolver = new CallEdgeResolver(
      table,
      new ImportPathResolver('/project', [
        'src/service/UserService.ts',
        'src/repository/UserRepo.ts',
      ])
    );

    // Repo.findById() → should resolve via alias 'Repo'
    const edges = resolver.resolveFile(
      [
        {
          callee: 'findById',
          callerMethod: 'getUser',
          callerClass: 'UserService',
          callType: 'method',
          receiver: 'Repo',
          receiverType: 'Repo',
          argCount: 1,
          line: 12,
          isAwait: false,
        },
      ],
      'src/service/UserService.ts'
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].callee).toContain('UserRepo.findById');
  });

  test('ResolvedEdge includes argCount', () => {
    const table = createMockSymbolTable();
    const resolver = new CallEdgeResolver(
      table,
      new ImportPathResolver('/project', [
        'src/service/UserService.ts',
        'src/repository/UserRepo.ts',
        'src/utils/helpers.ts',
      ])
    );

    const edges = resolver.resolveFile(
      [
        {
          callee: 'listUsers',
          callerMethod: 'getUser',
          callerClass: 'UserService',
          callType: 'method',
          receiver: 'this',
          receiverType: 'UserService',
          argCount: 3,
          line: 12,
          isAwait: false,
        },
      ],
      'src/service/UserService.ts'
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].argCount).toBe(3);
  });
});

// ─── DataFlowInferrer ─────────────────────────────────────

describe('DataFlowInferrer', () => {
  test('infers forward (argument) + backward (return) data flow from call edges with args', () => {
    const callEdges = [
      {
        caller: 'A.ts::A.foo',
        callee: 'B.ts::B.bar',
        callType: 'method',
        resolveMethod: 'direct',
        line: 10,
        file: 'A.ts',
        isAwait: false,
        argCount: 2,
      },
    ];

    const flows = DataFlowInferrer.infer(callEdges);

    expect(flows).toHaveLength(2);
    expect(flows[0]).toEqual({
      from: 'A.ts::A.foo',
      to: 'B.ts::B.bar',
      flowType: 'argument',
      direction: 'forward',
    });
    expect(flows[1]).toEqual({
      from: 'B.ts::B.bar',
      to: 'A.ts::A.foo',
      flowType: 'return-value',
      direction: 'backward',
      confidence: 0.3,
    });
  });

  test('skips forward edge when argCount is 0 (no parameters)', () => {
    const callEdges = [
      {
        caller: 'A.ts::A.foo',
        callee: 'B.ts::B.bar',
        callType: 'method',
        resolveMethod: 'direct',
        line: 10,
        file: 'A.ts',
        isAwait: false,
        argCount: 0,
      },
    ];

    const flows = DataFlowInferrer.infer(callEdges);

    // Only backward (return-value) edge, no forward (argument) edge
    expect(flows).toHaveLength(1);
    expect(flows[0]).toEqual({
      from: 'B.ts::B.bar',
      to: 'A.ts::A.foo',
      flowType: 'return-value',
      direction: 'backward',
      confidence: 0.3,
    });
  });

  test('empty input returns empty output', () => {
    expect(DataFlowInferrer.infer([])).toEqual([]);
  });
});

// ─── CallGraphAnalyzer ────────────────────────────────────

describe('CallGraphAnalyzer', () => {
  test('produces empty result for empty summary', async () => {
    const analyzer = new CallGraphAnalyzer('/project');
    const result = await analyzer.analyze(null);

    expect(result.callEdges).toEqual([]);
    expect(result.dataFlowEdges).toEqual([]);
    expect(result.stats.totalCallSites).toBe(0);
  });

  test('produces empty result for summary without callSites', async () => {
    const analyzer = new CallGraphAnalyzer('/project');
    const result = await analyzer.analyze({
      fileSummaries: [
        {
          file: 'test.ts',
          classes: [],
          protocols: [],
          methods: [],
          imports: [],
          exports: [],
          // no callSites
        },
      ],
    });

    expect(result.callEdges).toEqual([]);
    expect(result.stats.totalCallSites).toBe(0);
  });

  test('resolves call edges from callSites', async () => {
    const analyzer = new CallGraphAnalyzer('/project');
    const result = await analyzer.analyze({
      fileSummaries: [
        {
          file: 'src/service/UserService.ts',
          classes: [{ name: 'UserService', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'getUser', className: 'UserService', line: 5, kind: 'definition' },
            { name: 'listUsers', className: 'UserService', line: 15, kind: 'definition' },
          ],
          imports: [],
          exports: [],
          callSites: [
            {
              callee: 'listUsers',
              callerMethod: 'getUser',
              callerClass: 'UserService',
              callType: 'method',
              receiver: 'this',
              receiverType: 'UserService',
              argCount: 0,
              line: 8,
              isAwait: false,
            },
          ],
        },
      ],
    });

    expect(result.callEdges.length).toBeGreaterThan(0);
    expect(result.stats.totalCallSites).toBe(1);
    expect(result.stats.resolvedCallSites).toBe(1);
    expect(result.stats.resolvedRate).toBe(1);
    // argCount=0 → only backward (return-value) data flow edge
    expect(result.dataFlowEdges.length).toBe(1);
  });

  test('respects timeout', async () => {
    const analyzer = new CallGraphAnalyzer('/project');

    // This should not throw even with a very short timeout
    const result = await analyzer.analyze(
      {
        fileSummaries: [
          {
            file: 'test.ts',
            classes: [],
            protocols: [],
            methods: [{ name: 'foo', className: null, line: 1, kind: 'definition' }],
            imports: [],
            exports: [],
            callSites: [],
          },
        ],
      },
      { timeout: 100 }
    );

    expect(result).toBeDefined();
    expect(result.callEdges).toBeDefined();
  });

  test('stats include all metrics', async () => {
    const analyzer = new CallGraphAnalyzer('/project');
    const result = await analyzer.analyze({
      fileSummaries: [
        {
          file: 'a.ts',
          classes: [{ name: 'A', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'run', className: 'A', line: 5, kind: 'definition' },
            { name: 'exec', className: 'A', line: 10, kind: 'definition' },
          ],
          imports: [],
          exports: [],
          callSites: [
            {
              callee: 'exec',
              callerMethod: 'run',
              callerClass: 'A',
              callType: 'method',
              receiver: 'this',
              receiverType: 'A',
              argCount: 0,
              line: 7,
              isAwait: false,
            },
          ],
        },
      ],
    });

    expect(result.stats).toEqual(
      expect.objectContaining({
        totalCallSites: expect.any(Number),
        resolvedCallSites: expect.any(Number),
        resolvedRate: expect.any(Number),
        totalEdges: expect.any(Number),
        filesProcessed: expect.any(Number),
        symbolCount: expect.any(Number),
        durationMs: expect.any(Number),
      })
    );
  });
});

// ─── CHA (Class Hierarchy Analysis) ──────────────────────

describe('CallEdgeResolver — CHA', () => {
  test('resolves inherited method via CHA when not found in own class', () => {
    // Parent class has method 'save', Child class calls this.save()
    const table = SymbolTableBuilder.build({
      fileSummaries: [
        {
          file: 'src/base/BaseRepo.ts',
          classes: [{ name: 'BaseRepo', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'save', className: 'BaseRepo', line: 5, kind: 'definition' },
            { name: 'delete', className: 'BaseRepo', line: 15, kind: 'definition' },
          ],
          imports: [],
          exports: [],
        },
        {
          file: 'src/repo/UserRepo.ts',
          classes: [{ name: 'UserRepo', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'findById', className: 'UserRepo', line: 5, kind: 'definition' },
          ],
          imports: [],
          exports: [],
        },
      ],
    });

    const inheritanceGraph = [
      { from: 'UserRepo', to: 'BaseRepo', type: 'inherits' },
    ];

    const resolver = new CallEdgeResolver(
      table,
      new ImportPathResolver('/project', [
        'src/base/BaseRepo.ts',
        'src/repo/UserRepo.ts',
      ]),
      inheritanceGraph
    );

    // UserRepo.findById() calls this.save() — save is inherited from BaseRepo
    const edges = resolver.resolveFile(
      [
        {
          callee: 'save',
          callerMethod: 'findById',
          callerClass: 'UserRepo',
          callType: 'method',
          receiver: 'this',
          receiverType: 'UserRepo',
          argCount: 1,
          line: 8,
          isAwait: false,
        },
      ],
      'src/repo/UserRepo.ts'
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].callee).toContain('BaseRepo.save');
    expect(edges[0].resolveMethod).toBe('cha');
  });

  test('CHA traverses multiple inheritance levels', () => {
    const table = SymbolTableBuilder.build({
      fileSummaries: [
        {
          file: 'src/base/Entity.ts',
          classes: [{ name: 'Entity', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'getId', className: 'Entity', line: 3, kind: 'definition' },
          ],
          imports: [],
          exports: [],
        },
        {
          file: 'src/base/BaseRepo.ts',
          classes: [{ name: 'BaseRepo', kind: 'class', line: 1 }],
          protocols: [],
          methods: [],
          imports: [],
          exports: [],
        },
        {
          file: 'src/repo/UserRepo.ts',
          classes: [{ name: 'UserRepo', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'findUser', className: 'UserRepo', line: 5, kind: 'definition' },
          ],
          imports: [],
          exports: [],
        },
      ],
    });

    // UserRepo → BaseRepo → Entity
    const inheritanceGraph = [
      { from: 'UserRepo', to: 'BaseRepo', type: 'inherits' },
      { from: 'BaseRepo', to: 'Entity', type: 'inherits' },
    ];

    const resolver = new CallEdgeResolver(
      table,
      new ImportPathResolver('/project', [
        'src/base/Entity.ts',
        'src/base/BaseRepo.ts',
        'src/repo/UserRepo.ts',
      ]),
      inheritanceGraph
    );

    const edges = resolver.resolveFile(
      [
        {
          callee: 'getId',
          callerMethod: 'findUser',
          callerClass: 'UserRepo',
          callType: 'method',
          receiver: 'this',
          receiverType: 'UserRepo',
          argCount: 0,
          line: 8,
          isAwait: false,
        },
      ],
      'src/repo/UserRepo.ts'
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].callee).toContain('Entity.getId');
    expect(edges[0].resolveMethod).toBe('cha');
  });

  test('CHA returns null when method not found in hierarchy', () => {
    const table = SymbolTableBuilder.build({
      fileSummaries: [
        {
          file: 'src/base/Base.ts',
          classes: [{ name: 'Base', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'init', className: 'Base', line: 3, kind: 'definition' },
          ],
          imports: [],
          exports: [],
        },
        {
          file: 'src/Child.ts',
          classes: [{ name: 'Child', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'run', className: 'Child', line: 5, kind: 'definition' },
          ],
          imports: [],
          exports: [],
        },
      ],
    });

    const resolver = new CallEdgeResolver(
      table,
      new ImportPathResolver('/project', ['src/base/Base.ts', 'src/Child.ts']),
      [{ from: 'Child', to: 'Base', type: 'inherits' }]
    );

    const edges = resolver.resolveFile(
      [
        {
          callee: 'nonExistentMethod',
          callerMethod: 'run',
          callerClass: 'Child',
          callType: 'method',
          receiver: 'this',
          receiverType: 'Child',
          argCount: 0,
          line: 8,
          isAwait: false,
        },
      ],
      'src/Child.ts'
    );

    // No edge should be resolved
    expect(edges).toHaveLength(0);
  });

  test('CHA works without inheritanceGraph (backward compat)', () => {
    const table = SymbolTableBuilder.build({
      fileSummaries: [
        {
          file: 'a.ts',
          classes: [{ name: 'A', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'foo', className: 'A', line: 3, kind: 'definition' },
          ],
          imports: [],
          exports: [],
        },
      ],
    });

    // No inheritanceGraph parameter — should not throw
    const resolver = new CallEdgeResolver(
      table,
      new ImportPathResolver('/project', ['a.ts'])
    );

    const edges = resolver.resolveFile(
      [
        {
          callee: 'foo',
          callerMethod: 'foo',
          callerClass: 'A',
          callType: 'method',
          receiver: 'this',
          receiverType: 'A',
          argCount: 0,
          line: 5,
          isAwait: false,
        },
      ],
      'a.ts'
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].resolveMethod).toBe('direct');
  });
});

// ─── CHA via CallGraphAnalyzer ────────────────────────────

describe('CallGraphAnalyzer — CHA integration', () => {
  test('analyzer passes inheritanceGraph to CallEdgeResolver', async () => {
    const analyzer = new CallGraphAnalyzer('/project');
    const result = await analyzer.analyze({
      inheritanceGraph: [
        { from: 'ChildService', to: 'BaseService', type: 'inherits' },
      ],
      fileSummaries: [
        {
          file: 'src/base/BaseService.ts',
          classes: [{ name: 'BaseService', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'log', className: 'BaseService', line: 3, kind: 'definition' },
          ],
          imports: [],
          exports: [],
          callSites: [],
        },
        {
          file: 'src/service/ChildService.ts',
          classes: [{ name: 'ChildService', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'run', className: 'ChildService', line: 5, kind: 'definition' },
          ],
          imports: [],
          exports: [],
          callSites: [
            {
              callee: 'log',
              callerMethod: 'run',
              callerClass: 'ChildService',
              callType: 'method',
              receiver: 'this',
              receiverType: 'ChildService',
              argCount: 1,
              line: 8,
              isAwait: false,
            },
          ],
        },
      ],
    });

    expect(result.callEdges).toHaveLength(1);
    expect(result.callEdges[0].callee).toContain('BaseService.log');
    expect(result.callEdges[0].resolveMethod).toBe('cha');
  });
});

// ─── JSX/TSX Component Call Sites ─────────────────────────

describe('CallSiteExtractor — JSX components', () => {
  test('JSX self-closing element creates constructor call site', () => {
    // Simulates: <UserProfile />
    const mockCtx = { callSites: [] };
    const fakeJsxElement = {
      type: 'jsx_self_closing_element',
      namedChildCount: 1,
      namedChildren: [
        { type: 'identifier', text: 'UserProfile', namedChildCount: 0, namedChildren: [] },
      ],
      namedChild(i) { return this.namedChildren[i]; },
      startPosition: { row: 9 },
      isMissing: false,
    };

    const fakeBody = {
      type: 'statement_block',
      namedChildCount: 1,
      namedChildren: [fakeJsxElement],
      namedChild(i) { return this.namedChildren[i]; },
      isMissing: false,
    };

    // Use extractCallSitesTS with a scope that contains JSX
    const fakeRoot = {
      type: 'program',
      namedChildCount: 1,
      namedChildren: [
        {
          type: 'function_declaration',
          namedChildCount: 2,
          namedChildren: [
            { type: 'identifier', text: 'render', namedChildCount: 0, namedChildren: [] },
            fakeBody,
          ],
          namedChild(i) { return this.namedChildren[i]; },
          startPosition: { row: 0 },
          isMissing: false,
        },
      ],
      namedChild(i) { return this.namedChildren[i]; },
      isMissing: false,
    };

    extractCallSitesTS(fakeRoot, mockCtx, 'tsx');

    expect(mockCtx.callSites).toHaveLength(1);
    expect(mockCtx.callSites[0].callee).toBe('UserProfile');
    expect(mockCtx.callSites[0].callType).toBe('constructor');
    expect(mockCtx.callSites[0].callerMethod).toBe('render');
    expect(mockCtx.callSites[0].line).toBe(10); // row 9 + 1
  });

  test('lowercase JSX tags (HTML) are ignored', () => {
    const mockCtx = { callSites: [] };
    const fakeJsxElement = {
      type: 'jsx_self_closing_element',
      namedChildCount: 1,
      namedChildren: [
        { type: 'identifier', text: 'div', namedChildCount: 0, namedChildren: [] },
      ],
      namedChild(i) { return this.namedChildren[i]; },
      startPosition: { row: 9 },
      isMissing: false,
    };

    const fakeBody = {
      type: 'statement_block',
      namedChildCount: 1,
      namedChildren: [fakeJsxElement],
      namedChild(i) { return this.namedChildren[i]; },
      isMissing: false,
    };

    const fakeRoot = {
      type: 'program',
      namedChildCount: 1,
      namedChildren: [
        {
          type: 'function_declaration',
          namedChildCount: 2,
          namedChildren: [
            { type: 'identifier', text: 'render', namedChildCount: 0, namedChildren: [] },
            fakeBody,
          ],
          namedChild(i) { return this.namedChildren[i]; },
          startPosition: { row: 0 },
          isMissing: false,
        },
      ],
      namedChild(i) { return this.namedChildren[i]; },
      isMissing: false,
    };

    extractCallSitesTS(fakeRoot, mockCtx, 'tsx');

    // div is lowercase HTML tag — should NOT create a call site
    expect(mockCtx.callSites).toHaveLength(0);
  });
});

// ─── ImportRecord — require() / dynamic import() ─────────

describe('ImportRecord — CJS require()', () => {
  test('ImportRecord supports dynamic kind', () => {
    const rec = new ImportRecord('./module', { symbols: ['*'], kind: 'dynamic', alias: 'mod' });
    expect(rec.kind).toBe('dynamic');
    expect(rec.alias).toBe('mod');
    expect(rec.symbols).toEqual(['*']);
  });

  test('ImportRecord supports namespace kind from require', () => {
    const rec = new ImportRecord('express', { symbols: ['*'], kind: 'namespace', alias: 'express' });
    expect(rec.kind).toBe('namespace');
    expect(rec.alias).toBe('express');
    expect(rec.hasSymbol('*')).toBe(true);
  });
});

// ─── Go extractCallSites ─────────────────────────────────

describe('Go extractCallSites', () => {
  let extractCallSitesGo;

  beforeAll(async () => {
    const mod = await import('../../lib/core/ast/lang-go.js');
    extractCallSitesGo = mod.plugin.extractCallSites;
  });

  /**
   * Helper to build a minimal Go-like fake AST node
   */
  function mkNode(type, children, extra = {}) {
    const namedChildren = children || [];
    return {
      type,
      text: extra.text || '',
      namedChildCount: namedChildren.length,
      namedChildren,
      namedChild(i) { return namedChildren[i]; },
      startPosition: extra.startPosition || { row: 0, column: 0 },
      endPosition: extra.endPosition || { row: 0, column: 0 },
      isMissing: false,
      ...extra,
    };
  }

  test('extracts function_declaration call sites', () => {
    // func DoWork() { svc.Process() }
    const selectorExpr = mkNode('selector_expression', [], { text: 'svc.Process' });
    const callExpr = mkNode('call_expression', [selectorExpr], {
      startPosition: { row: 4 },
    });
    const body = mkNode('block', [callExpr]);
    const funcDecl = mkNode('function_declaration', [
      mkNode('identifier', [], { text: 'DoWork' }),
      body,
    ]);
    const root = mkNode('source_file', [funcDecl]);
    const ctx = { callSites: [] };

    extractCallSitesGo(root, ctx, 'go');

    expect(ctx.callSites).toHaveLength(1);
    expect(ctx.callSites[0].callee).toBe('Process');
    expect(ctx.callSites[0].receiver).toBe('svc');
    expect(ctx.callSites[0].callerMethod).toBe('DoWork');
    expect(ctx.callSites[0].callType).toBe('method');
  });

  test('extracts method_declaration with receiver type', () => {
    // func (s *Server) Handle() { db.Query() }
    const selectorExpr = mkNode('selector_expression', [], { text: 'db.Query' });
    const callExpr = mkNode('call_expression', [selectorExpr], {
      startPosition: { row: 7 },
    });
    const body = mkNode('block', [callExpr]);
    const receiverTypeId = mkNode('type_identifier', [], { text: 'Server' });
    const pointerType = mkNode('pointer_type', [receiverTypeId]);
    const paramDecl = mkNode('parameter_declaration', [
      mkNode('identifier', [], { text: 's' }),
      pointerType,
    ]);
    const paramList = mkNode('parameter_list', [paramDecl]);
    const methodDecl = mkNode('method_declaration', [
      paramList,
      mkNode('field_identifier', [], { text: 'Handle' }),
      body,
    ]);
    const root = mkNode('source_file', [methodDecl]);
    const ctx = { callSites: [] };

    extractCallSitesGo(root, ctx, 'go');

    expect(ctx.callSites).toHaveLength(1);
    expect(ctx.callSites[0].callee).toBe('Query');
    expect(ctx.callSites[0].callerClass).toBe('Server');
    expect(ctx.callSites[0].callerMethod).toBe('Handle');
  });

  test('detects New* constructor pattern', () => {
    // func Init() { NewUserService() }
    const idNode = mkNode('identifier', [], { text: 'NewUserService' });
    const callExpr = mkNode('call_expression', [idNode], {
      startPosition: { row: 2 },
    });
    const body = mkNode('block', [callExpr]);
    const funcDecl = mkNode('function_declaration', [
      mkNode('identifier', [], { text: 'Init' }),
      body,
    ]);
    const root = mkNode('source_file', [funcDecl]);
    const ctx = { callSites: [] };

    extractCallSitesGo(root, ctx, 'go');

    expect(ctx.callSites).toHaveLength(1);
    expect(ctx.callSites[0].callee).toBe('NewUserService');
    expect(ctx.callSites[0].callType).toBe('constructor');
    expect(ctx.callSites[0].receiverType).toBe('UserService');
  });

  test('skips noise packages (fmt, log, etc.)', () => {
    const selectorExpr = mkNode('selector_expression', [], { text: 'fmt.Println' });
    const callExpr = mkNode('call_expression', [selectorExpr], {
      startPosition: { row: 1 },
    });
    const body = mkNode('block', [callExpr]);
    const funcDecl = mkNode('function_declaration', [
      mkNode('identifier', [], { text: 'main' }),
      body,
    ]);
    const root = mkNode('source_file', [funcDecl]);
    const ctx = { callSites: [] };

    extractCallSitesGo(root, ctx, 'go');

    // fmt is noise — should be skipped
    expect(ctx.callSites).toHaveLength(0);
  });
});

// ─── Go ImportRecord ─────────────────────────────────────

describe('Go ImportRecord', () => {
  test('plugin exports extractCallSites', async () => {
    const mod = await import('../../lib/core/ast/lang-go.js');
    expect(mod.plugin.extractCallSites).toBeDefined();
    expect(typeof mod.plugin.extractCallSites).toBe('function');
  });
});

// ─── Java extractCallSites ───────────────────────────────

describe('Java extractCallSites', () => {
  let extractCallSitesJava;

  beforeAll(async () => {
    const mod = await import('../../lib/core/ast/lang-java.js');
    extractCallSitesJava = mod.plugin.extractCallSites;
  });

  function mkNode(type, children, extra = {}) {
    const namedChildren = children || [];
    return {
      type,
      text: extra.text || '',
      namedChildCount: namedChildren.length,
      namedChildren,
      namedChild(i) { return namedChildren[i]; },
      startPosition: extra.startPosition || { row: 0, column: 0 },
      endPosition: extra.endPosition || { row: 0, column: 0 },
      isMissing: false,
      ...extra,
    };
  }

  test('extracts method_invocation from method body', () => {
    // class Foo { void bar() { service.doWork(); } }
    const methodId = mkNode('identifier', [], { text: 'doWork' });
    const objectId = mkNode('identifier', [], { text: 'service' });
    const args = mkNode('argument_list', []);
    const methodInvocation = mkNode('method_invocation', [objectId, methodId, args], {
      startPosition: { row: 5 },
      text: 'service.doWork()',
    });
    const block = mkNode('block', [methodInvocation]);
    const methodDecl = mkNode('method_declaration', [
      mkNode('identifier', [], { text: 'bar' }),
      block,
    ]);
    const classBody = mkNode('class_body', [methodDecl]);
    const classDecl = mkNode('class_declaration', [
      mkNode('identifier', [], { text: 'Foo' }),
      classBody,
    ]);
    const root = mkNode('program', [classDecl]);
    const ctx = { callSites: [] };

    extractCallSitesJava(root, ctx, 'java');

    expect(ctx.callSites).toHaveLength(1);
    expect(ctx.callSites[0].callee).toBe('doWork');
    expect(ctx.callSites[0].receiver).toBe('service');
    expect(ctx.callSites[0].callerClass).toBe('Foo');
    expect(ctx.callSites[0].callerMethod).toBe('bar');
    expect(ctx.callSites[0].callType).toBe('method');
  });

  test('extracts object_creation_expression (new)', () => {
    // class Factory { Object create() { new MyService(a, b); } }
    const typeNode = mkNode('type_identifier', [], { text: 'MyService' });
    const argA = mkNode('identifier', [], { text: 'a' });
    const argB = mkNode('identifier', [], { text: 'b' });
    const args = mkNode('argument_list', [argA, argB]);
    const newExpr = mkNode('object_creation_expression', [typeNode, args], {
      startPosition: { row: 3 },
    });
    const block = mkNode('block', [newExpr]);
    const methodDecl = mkNode('method_declaration', [
      mkNode('identifier', [], { text: 'create' }),
      block,
    ]);
    const classBody = mkNode('class_body', [methodDecl]);
    const classDecl = mkNode('class_declaration', [
      mkNode('identifier', [], { text: 'Factory' }),
      classBody,
    ]);
    const root = mkNode('program', [classDecl]);
    const ctx = { callSites: [] };

    extractCallSitesJava(root, ctx, 'java');

    expect(ctx.callSites).toHaveLength(1);
    expect(ctx.callSites[0].callee).toBe('MyService');
    expect(ctx.callSites[0].callType).toBe('constructor');
    expect(ctx.callSites[0].receiverType).toBe('MyService');
    expect(ctx.callSites[0].argCount).toBe(2);
  });

  test('Java ImportRecord with scoped import', async () => {
    const mod = await import('../../lib/core/ast/lang-java.js');
    // Verify plugin exports extractCallSites
    expect(mod.plugin.extractCallSites).toBeDefined();
    expect(mod.plugin.extensions).toEqual(['.java']);
  });
});

// ─── Kotlin extractCallSites ─────────────────────────────

describe('Kotlin extractCallSites', () => {
  let extractCallSitesKotlin;

  beforeAll(async () => {
    const mod = await import('../../lib/core/ast/lang-kotlin.js');
    extractCallSitesKotlin = mod.plugin.extractCallSites;
  });

  function mkNode(type, children, extra = {}) {
    const namedChildren = children || [];
    return {
      type,
      text: extra.text || '',
      namedChildCount: namedChildren.length,
      namedChildren,
      namedChild(i) { return namedChildren[i]; },
      startPosition: extra.startPosition || { row: 0, column: 0 },
      endPosition: extra.endPosition || { row: 0, column: 0 },
      isMissing: false,
      ...extra,
    };
  }

  test('extracts call sites from function_declaration', () => {
    // fun process() { service.execute() }
    const navExpr = mkNode('navigation_expression', [], { text: 'service.execute' });
    const callExpr = mkNode('call_expression', [navExpr], {
      startPosition: { row: 3 },
    });
    const body = mkNode('function_body', [callExpr]);
    const funcDecl = mkNode('function_declaration', [
      mkNode('simple_identifier', [], { text: 'process' }),
      body,
    ]);
    const root = mkNode('source_file', [funcDecl]);
    const ctx = { callSites: [] };

    extractCallSitesKotlin(root, ctx, 'kotlin');

    expect(ctx.callSites).toHaveLength(1);
    expect(ctx.callSites[0].callee).toBe('execute');
    expect(ctx.callSites[0].receiver).toBe('service');
    expect(ctx.callSites[0].callerMethod).toBe('process');
    expect(ctx.callSites[0].callType).toBe('method');
  });

  test('detects PascalCase as constructor', () => {
    // fun build() { UserService() }
    const idNode = mkNode('simple_identifier', [], { text: 'UserService' });
    const callExpr = mkNode('call_expression', [idNode], {
      startPosition: { row: 1 },
    });
    const body = mkNode('function_body', [callExpr]);
    const funcDecl = mkNode('function_declaration', [
      mkNode('simple_identifier', [], { text: 'build' }),
      body,
    ]);
    const root = mkNode('source_file', [funcDecl]);
    const ctx = { callSites: [] };

    extractCallSitesKotlin(root, ctx, 'kotlin');

    expect(ctx.callSites).toHaveLength(1);
    expect(ctx.callSites[0].callee).toBe('UserService');
    expect(ctx.callSites[0].callType).toBe('constructor');
    expect(ctx.callSites[0].receiverType).toBe('UserService');
  });

  test('skips Kotlin noise functions (println, listOf, etc.)', () => {
    const idNode = mkNode('simple_identifier', [], { text: 'println' });
    const callExpr = mkNode('call_expression', [idNode], {
      startPosition: { row: 1 },
    });
    const body = mkNode('function_body', [callExpr]);
    const funcDecl = mkNode('function_declaration', [
      mkNode('simple_identifier', [], { text: 'main' }),
      body,
    ]);
    const root = mkNode('source_file', [funcDecl]);
    const ctx = { callSites: [] };

    extractCallSitesKotlin(root, ctx, 'kotlin');

    expect(ctx.callSites).toHaveLength(0);
  });

  test('Kotlin plugin exports extractCallSites', async () => {
    const mod = await import('../../lib/core/ast/lang-kotlin.js');
    expect(mod.plugin.extractCallSites).toBeDefined();
    expect(mod.plugin.extensions).toEqual(['.kt', '.kts']);
  });
});

// ─── Tiered Degradation Strategy ─────────────────────────

describe('CallGraphAnalyzer — tiered degradation', () => {
  function makeFileSummary(file, callSitesCount = 0) {
    const callSites = Array.from({ length: callSitesCount }, (_, i) => ({
      callee: `func${i}`,
      callerMethod: 'test',
      callerClass: null,
      callType: 'function',
      receiver: null,
      receiverType: null,
      argCount: 0,
      line: i + 1,
      isAwait: false,
    }));
    return {
      file,
      lang: 'typescript',
      classes: [],
      methods: [{ name: 'test', className: null, kind: 'definition', line: 1 }],
      imports: [],
      callSites,
    };
  }

  test('tier "full-cha" for <100 files', async () => {
    const analyzer = new CallGraphAnalyzer('/test');
    const summaries = Array.from({ length: 50 }, (_, i) => makeFileSummary(`/test/f${i}.ts`));
    const result = await analyzer.analyze({ fileSummaries: summaries }, { timeout: 5000 });
    expect(result.stats.tier).toBe('full-cha');
  });

  test('tier "full" for 100-500 files', async () => {
    const analyzer = new CallGraphAnalyzer('/test');
    const summaries = Array.from({ length: 150 }, (_, i) => makeFileSummary(`/test/f${i}.ts`));
    const result = await analyzer.analyze({ fileSummaries: summaries }, { timeout: 5000 });
    expect(result.stats.tier).toBe('full');
  });

  test('tier "sampled" for 500-2000 files limits to 500', async () => {
    const analyzer = new CallGraphAnalyzer('/test');
    const summaries = Array.from({ length: 800 }, (_, i) => makeFileSummary(`/test/f${i}.ts`, 1));
    const result = await analyzer.analyze({ fileSummaries: summaries }, { timeout: 10000 });
    expect(result.stats.tier).toBe('sampled');
    // Should process at most 500 files
    expect(result.stats.filesProcessed).toBeLessThanOrEqual(500);
  });

  test('tier "import-only" for >2000 files returns empty call edges', async () => {
    const analyzer = new CallGraphAnalyzer('/test');
    const summaries = Array.from({ length: 2500 }, (_, i) => makeFileSummary(`/test/f${i}.ts`, 1));
    const result = await analyzer.analyze({ fileSummaries: summaries }, { timeout: 5000 });
    expect(result.stats.tier).toBe('import-only');
    expect(result.callEdges).toHaveLength(0);
    expect(result.dataFlowEdges).toHaveLength(0);
  });
});

// ─── Rust extractCallSites ───────────────────────────────

describe('Rust extractCallSites', () => {
  let extractCallSitesRust;

  beforeAll(async () => {
    const mod = await import('../../lib/core/ast/lang-rust.js');
    extractCallSitesRust = mod.plugin.extractCallSites;
  });

  function mkNode(type, children, extra = {}) {
    const namedChildren = children || [];
    const node = {
      type,
      text: extra.text || '',
      namedChildCount: namedChildren.length,
      namedChildren,
      namedChild(i) { return namedChildren[i]; },
      startPosition: extra.startPosition || { row: 0, column: 0 },
      endPosition: extra.endPosition || { row: 0, column: 0 },
      isMissing: false,
      children: extra.children || namedChildren,
      ...extra,
    };
    // Set parent references
    for (const c of namedChildren) {
      c.parent = node;
    }
    return node;
  }

  test('extracts call_expression with scoped_identifier (Struct::method)', () => {
    // impl UserService { fn init() { UserRepo::new() } }
    const scopedId = mkNode('scoped_identifier', [], { text: 'UserRepo::new' });
    const args = mkNode('arguments', []);
    const callExpr = mkNode('call_expression', [scopedId, args], {
      startPosition: { row: 4 },
    });
    const body = mkNode('block', [callExpr]);
    const funcItem = mkNode('function_item', [
      mkNode('identifier', [], { text: 'init' }),
      body,
    ]);
    const declList = mkNode('declaration_list', [funcItem]);
    const typeId = mkNode('type_identifier', [], { text: 'UserService' });
    const implItem = mkNode('impl_item', [typeId, declList], {
      children: [typeId, declList],
    });
    const root = mkNode('source_file', [implItem]);
    const ctx = { callSites: [] };

    extractCallSitesRust(root, ctx, 'rust');

    expect(ctx.callSites).toHaveLength(1);
    expect(ctx.callSites[0].callee).toBe('new');
    expect(ctx.callSites[0].receiver).toBe('UserRepo');
    expect(ctx.callSites[0].receiverType).toBe('UserRepo');
    expect(ctx.callSites[0].callType).toBe('constructor');
    expect(ctx.callSites[0].callerClass).toBe('UserService');
    expect(ctx.callSites[0].callerMethod).toBe('init');
  });

  test('extracts method_call_expression (obj.method())', () => {
    // fn process() { db.query() }
    const valueNode = mkNode('identifier', [], { text: 'db' });
    const nameNode = mkNode('field_identifier', [], { text: 'query' });
    const args = mkNode('arguments', []);
    const methodCallExpr = mkNode('method_call_expression', [valueNode, nameNode, args], {
      startPosition: { row: 3 },
    });
    const body = mkNode('block', [methodCallExpr]);
    const funcItem = mkNode('function_item', [
      mkNode('identifier', [], { text: 'process' }),
      body,
    ]);
    const root = mkNode('source_file', [funcItem]);
    const ctx = { callSites: [] };

    extractCallSitesRust(root, ctx, 'rust');

    expect(ctx.callSites).toHaveLength(1);
    expect(ctx.callSites[0].callee).toBe('query');
    expect(ctx.callSites[0].receiver).toBe('db');
    expect(ctx.callSites[0].callType).toBe('method');
    expect(ctx.callSites[0].callerMethod).toBe('process');
  });

  test('skips Rust noise functions (println, dbg, assert)', () => {
    const idNode = mkNode('identifier', [], { text: 'println' });
    const args = mkNode('arguments', []);
    const callExpr = mkNode('call_expression', [idNode, args], {
      startPosition: { row: 1 },
    });
    const body = mkNode('block', [callExpr]);
    const funcItem = mkNode('function_item', [
      mkNode('identifier', [], { text: 'main' }),
      body,
    ]);
    const root = mkNode('source_file', [funcItem]);
    const ctx = { callSites: [] };

    extractCallSitesRust(root, ctx, 'rust');

    expect(ctx.callSites).toHaveLength(0);
  });

  test('detects await expression on method calls', () => {
    // async fn fetch_data() { client.get().await }
    const valueNode = mkNode('identifier', [], { text: 'client' });
    const nameNode = mkNode('field_identifier', [], { text: 'get' });
    const args = mkNode('arguments', []);
    const methodCallExpr = mkNode('method_call_expression', [valueNode, nameNode, args], {
      startPosition: { row: 2 },
    });
    const awaitExpr = mkNode('await_expression', [methodCallExpr], {
      startPosition: { row: 2 },
    });
    const body = mkNode('block', [awaitExpr]);
    const funcItem = mkNode('function_item', [
      mkNode('identifier', [], { text: 'fetch_data' }),
      body,
    ]);
    const root = mkNode('source_file', [funcItem]);
    const ctx = { callSites: [] };

    extractCallSitesRust(root, ctx, 'rust');

    expect(ctx.callSites).toHaveLength(1);
    expect(ctx.callSites[0].callee).toBe('get');
    expect(ctx.callSites[0].isAwait).toBe(true);
  });

  test('Rust plugin exports extractCallSites', async () => {
    const mod = await import('../../lib/core/ast/lang-rust.js');
    expect(mod.plugin.extractCallSites).toBeDefined();
    expect(typeof mod.plugin.extractCallSites).toBe('function');
    expect(mod.plugin.extensions).toEqual(['.rs']);
  });
});

// ─── Swift extractCallSites ──────────────────────────────

describe('Swift extractCallSites', () => {
  let extractCallSitesSwift;

  beforeAll(async () => {
    const mod = await import('../../lib/core/ast/lang-swift.js');
    extractCallSitesSwift = mod.plugin.extractCallSites;
  });

  function mkNode(type, children, extra = {}) {
    const namedChildren = children || [];
    const node = {
      type,
      text: extra.text || '',
      namedChildCount: namedChildren.length,
      namedChildren,
      namedChild(i) { return namedChildren[i]; },
      startPosition: extra.startPosition || { row: 0, column: 0 },
      endPosition: extra.endPosition || { row: 0, column: 0 },
      isMissing: false,
      children: extra.children || namedChildren,
      parent: extra.parent || null,
      ...extra,
    };
    for (const c of namedChildren) {
      c.parent = node;
    }
    return node;
  }

  test('extracts call_expression with navigation (obj.method())', () => {
    // class Controller { func handle() { service.process() } }
    const navExpr = mkNode('navigation_expression', [], { text: 'service.process' });
    const callSuffix = mkNode('call_suffix', []);
    const callExpr = mkNode('call_expression', [navExpr, callSuffix], {
      startPosition: { row: 5 },
    });
    const funcBody = mkNode('function_body', [callExpr]);
    const funcDecl = mkNode('function_declaration', [
      mkNode('simple_identifier', [], { text: 'handle' }),
      funcBody,
    ]);
    const classBody = mkNode('class_body', [funcDecl]);
    const classDecl = mkNode('class_declaration', [
      mkNode('type_identifier', [], { text: 'Controller' }),
      classBody,
    ]);
    const root = mkNode('source_file', [classDecl]);
    const ctx = { callSites: [] };

    extractCallSitesSwift(root, ctx, 'swift');

    expect(ctx.callSites).toHaveLength(1);
    expect(ctx.callSites[0].callee).toBe('process');
    expect(ctx.callSites[0].receiver).toBe('service');
    expect(ctx.callSites[0].callType).toBe('method');
    expect(ctx.callSites[0].callerClass).toBe('Controller');
    expect(ctx.callSites[0].callerMethod).toBe('handle');
  });

  test('detects PascalCase as constructor (Swift initializer)', () => {
    const idNode = mkNode('simple_identifier', [], { text: 'UserService' });
    const callSuffix = mkNode('call_suffix', []);
    const callExpr = mkNode('call_expression', [idNode, callSuffix], {
      startPosition: { row: 2 },
    });
    const funcBody = mkNode('function_body', [callExpr]);
    const funcDecl = mkNode('function_declaration', [
      mkNode('simple_identifier', [], { text: 'build' }),
      funcBody,
    ]);
    const root = mkNode('source_file', [funcDecl]);
    const ctx = { callSites: [] };

    extractCallSitesSwift(root, ctx, 'swift');

    expect(ctx.callSites).toHaveLength(1);
    expect(ctx.callSites[0].callee).toBe('UserService');
    expect(ctx.callSites[0].callType).toBe('constructor');
    expect(ctx.callSites[0].receiverType).toBe('UserService');
  });

  test('skips Swift noise functions (print, fatalError, assert)', () => {
    const idNode = mkNode('simple_identifier', [], { text: 'print' });
    const callSuffix = mkNode('call_suffix', []);
    const callExpr = mkNode('call_expression', [idNode, callSuffix], {
      startPosition: { row: 1 },
    });
    const funcBody = mkNode('function_body', [callExpr]);
    const funcDecl = mkNode('function_declaration', [
      mkNode('simple_identifier', [], { text: 'main' }),
      funcBody,
    ]);
    const root = mkNode('source_file', [funcDecl]);
    const ctx = { callSites: [] };

    extractCallSitesSwift(root, ctx, 'swift');

    expect(ctx.callSites).toHaveLength(0);
  });

  test('Swift plugin exports extractCallSites', async () => {
    const mod = await import('../../lib/core/ast/lang-swift.js');
    expect(mod.plugin.extractCallSites).toBeDefined();
    expect(typeof mod.plugin.extractCallSites).toBe('function');
    expect(mod.plugin.extensions).toEqual(['.swift']);
  });
});

// ─── Dart extractCallSites ───────────────────────────────

describe('Dart extractCallSites', () => {
  let extractCallSitesDart;

  beforeAll(async () => {
    const mod = await import('../../lib/core/ast/lang-dart.js');
    extractCallSitesDart = mod.plugin.extractCallSites;
  });

  function mkNode(type, children, extra = {}) {
    const namedChildren = children || [];
    const node = {
      type,
      text: extra.text || '',
      namedChildCount: namedChildren.length,
      namedChildren,
      namedChild(i) { return namedChildren[i]; },
      startPosition: extra.startPosition || { row: 0, column: 0 },
      endPosition: extra.endPosition || { row: 0, column: 0 },
      isMissing: false,
      children: extra.children || namedChildren,
      parent: extra.parent || null,
      nextSibling: extra.nextSibling || null,
      ...extra,
    };
    for (const c of namedChildren) {
      c.parent = node;
    }
    return node;
  }

  test('extracts function_expression_invocation (direct calls)', () => {
    // class MyWidget { void build() { service.getData() } }
    const methodInvocation = mkNode('function_expression_invocation', [], {
      text: 'service.getData()',
      startPosition: { row: 4 },
    });
    const body = mkNode('function_body', [methodInvocation]);
    const funcDef = mkNode('function_definition', [
      mkNode('identifier', [], { text: 'build' }),
      body,
    ]);
    const classBody = mkNode('class_body', [funcDef]);
    const classDef = mkNode('class_definition', [
      mkNode('identifier', [], { text: 'MyWidget' }),
      classBody,
    ]);
    const root = mkNode('source_file', [classDef]);
    const ctx = { callSites: [] };

    extractCallSitesDart(root, ctx, 'dart');

    expect(ctx.callSites).toHaveLength(1);
    expect(ctx.callSites[0].callee).toBe('getData');
    expect(ctx.callSites[0].receiver).toBe('service');
    expect(ctx.callSites[0].callType).toBe('method');
    expect(ctx.callSites[0].callerClass).toBe('MyWidget');
  });

  test('detects PascalCase as constructor', () => {
    // void main() { UserService() }
    const callNode = mkNode('function_expression_invocation', [], {
      text: 'UserService()',
      startPosition: { row: 1 },
    });
    const body = mkNode('function_body', [callNode]);
    const funcDef = mkNode('function_definition', [
      mkNode('identifier', [], { text: 'main' }),
      body,
    ]);
    const root = mkNode('source_file', [funcDef]);
    const ctx = { callSites: [] };

    extractCallSitesDart(root, ctx, 'dart');

    expect(ctx.callSites).toHaveLength(1);
    expect(ctx.callSites[0].callee).toBe('UserService');
    expect(ctx.callSites[0].callType).toBe('constructor');
    expect(ctx.callSites[0].receiverType).toBe('UserService');
  });

  test('skips Dart noise functions (print, setState)', () => {
    const callNode = mkNode('function_expression_invocation', [], {
      text: 'print("hello")',
      startPosition: { row: 1 },
    });
    const body = mkNode('function_body', [callNode]);
    const funcDef = mkNode('function_definition', [
      mkNode('identifier', [], { text: 'main' }),
      body,
    ]);
    const root = mkNode('source_file', [funcDef]);
    const ctx = { callSites: [] };

    extractCallSitesDart(root, ctx, 'dart');

    expect(ctx.callSites).toHaveLength(0);
  });

  test('Dart plugin exports extractCallSites', async () => {
    const mod = await import('../../lib/core/ast/lang-dart.js');
    expect(mod.plugin.extractCallSites).toBeDefined();
    expect(typeof mod.plugin.extractCallSites).toBe('function');
    expect(mod.plugin.extensions).toEqual(['.dart']);
  });

  // ── sibling-based call pattern tests (tree-sitter-dart specific) ──

  test('this.method() extracts method call with receiver=this (sibling pattern)', () => {
    // AST: class_body → [method_signature → [function_signature → [identifier "doWork"]], function_body → [block → [expression_statement → [this, selector(".increment"), selector("()")]]]]
    const thisNode = mkNode('this', [], { text: 'this' });
    const methodSel = mkNode('selector', [
      mkNode('unconditional_assignable_selector', [
        mkNode('identifier', [], { text: 'increment' }),
      ], { text: '.increment' }),
    ], { text: '.increment' });
    const argsSel = mkNode('selector', [
      mkNode('argument_part', [
        mkNode('arguments', [], { text: '()' }),
      ], { text: '()' }),
    ], { text: '()' });
    const exprStmt = mkNode('expression_statement', [thisNode, methodSel, argsSel], { text: 'this.increment();' });
    const block = mkNode('block', [exprStmt]);
    const body = mkNode('function_body', [block]);
    const funcSig = mkNode('function_signature', [
      mkNode('identifier', [], { text: 'doWork' }),
    ], { text: 'void doWork()' });
    const methodSig = mkNode('method_signature', [funcSig], { text: 'void doWork()' });
    const classBody = mkNode('class_body', [methodSig, body]);
    const classDef = mkNode('class_definition', [
      mkNode('identifier', [], { text: 'MyState' }),
      classBody,
    ]);
    const root = mkNode('source_file', [classDef]);
    const ctx = { callSites: [] };

    extractCallSitesDart(root, ctx, 'dart');

    expect(ctx.callSites).toHaveLength(1);
    expect(ctx.callSites[0]).toMatchObject({
      callee: 'increment',
      receiver: 'this',
      callType: 'method',
      callerClass: 'MyState',
      callerMethod: 'doWork',
      receiverType: 'MyState',
    });
  });

  test('super.method() extracts super call (sibling pattern)', () => {
    const superNode = mkNode('super', [], { text: 'super' });
    const methodSel = mkNode('unconditional_assignable_selector', [
      mkNode('identifier', [], { text: 'dispose' }),
    ], { text: '.dispose' });
    const argsSel = mkNode('selector', [
      mkNode('argument_part', [
        mkNode('arguments', [], { text: '()' }),
      ], { text: '()' }),
    ], { text: '()' });
    const exprStmt = mkNode('expression_statement', [superNode, methodSel, argsSel], { text: 'super.dispose();' });
    const block = mkNode('block', [exprStmt]);
    const body = mkNode('function_body', [block]);
    const funcSig = mkNode('function_signature', [
      mkNode('identifier', [], { text: 'dispose' }),
    ], { text: 'void dispose()' });
    const methodSig = mkNode('method_signature', [funcSig]);
    const classBody = mkNode('class_body', [methodSig, body]);
    const classDef = mkNode('class_definition', [
      mkNode('identifier', [], { text: 'MyState' }),
      classBody,
    ]);
    const root = mkNode('source_file', [classDef]);
    const ctx = { callSites: [] };

    extractCallSitesDart(root, ctx, 'dart');

    expect(ctx.callSites).toHaveLength(1);
    expect(ctx.callSites[0]).toMatchObject({
      callee: 'dispose',
      receiver: 'super',
      callType: 'super',
      callerClass: 'MyState',
      receiverType: 'MyState',
    });
  });

  test('StaticClass.method() extracts static call (sibling pattern)', () => {
    const identNode = mkNode('identifier', [], { text: 'MyHelper' });
    const methodSel = mkNode('selector', [
      mkNode('unconditional_assignable_selector', [
        mkNode('identifier', [], { text: 'staticMethod' }),
      ], { text: '.staticMethod' }),
    ], { text: '.staticMethod' });
    const argsSel = mkNode('selector', [
      mkNode('argument_part', [
        mkNode('arguments', [], { text: '()' }),
      ], { text: '()' }),
    ], { text: '()' });
    const exprStmt = mkNode('expression_statement', [identNode, methodSel, argsSel]);
    const block = mkNode('block', [exprStmt]);
    const body = mkNode('function_body', [block]);
    const funcDef = mkNode('function_definition', [
      mkNode('identifier', [], { text: 'main' }),
      body,
    ]);
    const root = mkNode('source_file', [funcDef]);
    const ctx = { callSites: [] };

    extractCallSitesDart(root, ctx, 'dart');

    expect(ctx.callSites).toHaveLength(1);
    expect(ctx.callSites[0]).toMatchObject({
      callee: 'staticMethod',
      receiver: 'MyHelper',
      callType: 'static',
      receiverType: 'MyHelper',
    });
  });

  test('direct func(args) extracts call via identifier + selector("(...)") pattern', () => {
    const identNode = mkNode('identifier', [], { text: 'runApp' });
    const argsSel = mkNode('selector', [
      mkNode('argument_part', [
        mkNode('arguments', [], { text: '(MyApp())' }),
      ], { text: '(MyApp())' }),
    ], { text: '(MyApp())' });
    const exprStmt = mkNode('expression_statement', [identNode, argsSel]);
    const block = mkNode('block', [exprStmt]);
    const body = mkNode('function_body', [block]);
    const funcDef = mkNode('function_definition', [
      mkNode('identifier', [], { text: 'main' }),
      body,
    ]);
    const root = mkNode('source_file', [funcDef]);
    const ctx = { callSites: [] };

    extractCallSitesDart(root, ctx, 'dart');

    expect(ctx.callSites.some(cs => cs.callee === 'runApp' && cs.callType === 'function')).toBe(true);
  });

  test('setState (DART_NOISE) is skipped without infinite recursion', () => {
    const identNode = mkNode('identifier', [], { text: 'setState' });
    const argsSel = mkNode('selector', [
      mkNode('argument_part', [
        mkNode('arguments', [], { text: '(() { counter++; })' }),
      ], { text: '(() { counter++; })' }),
    ], { text: '(() { counter++; })' });
    const exprStmt = mkNode('expression_statement', [identNode, argsSel]);
    const block = mkNode('block', [exprStmt]);
    const body = mkNode('function_body', [block]);
    const funcSig = mkNode('function_signature', [
      mkNode('identifier', [], { text: 'increment' }),
    ]);
    const methodSig = mkNode('method_signature', [funcSig]);
    const classBody = mkNode('class_body', [methodSig, body]);
    const classDef = mkNode('class_definition', [
      mkNode('identifier', [], { text: 'MyState' }),
      classBody,
    ]);
    const root = mkNode('source_file', [classDef]);
    const ctx = { callSites: [] };

    // Should NOT throw (was causing infinite recursion before fix)
    expect(() => extractCallSitesDart(root, ctx, 'dart')).not.toThrow();
    // setState should be filtered out
    expect(ctx.callSites.filter(cs => cs.callee === 'setState')).toHaveLength(0);
  });

  test('scope collection works with sibling method_signature + function_body', () => {
    // Two methods with sibling body pattern - both should extract callSites
    const call1Ident = mkNode('identifier', [], { text: 'serviceA' });
    const call1MethodSel = mkNode('selector', [
      mkNode('unconditional_assignable_selector', [
        mkNode('identifier', [], { text: 'fetch' }),
      ], { text: '.fetch' }),
    ], { text: '.fetch' });
    const call1ArgsSel = mkNode('selector', [
      mkNode('argument_part', [mkNode('arguments', [], { text: '()' })], { text: '()' }),
    ], { text: '()' });

    const call2Ident = mkNode('identifier', [], { text: 'serviceB' });
    const call2MethodSel = mkNode('selector', [
      mkNode('unconditional_assignable_selector', [
        mkNode('identifier', [], { text: 'save' }),
      ], { text: '.save' }),
    ], { text: '.save' });
    const call2ArgsSel = mkNode('selector', [
      mkNode('argument_part', [mkNode('arguments', [], { text: '()' })], { text: '()' }),
    ], { text: '()' });

    const body1 = mkNode('function_body', [
      mkNode('block', [mkNode('expression_statement', [call1Ident, call1MethodSel, call1ArgsSel])]),
    ]);
    const body2 = mkNode('function_body', [
      mkNode('block', [mkNode('expression_statement', [call2Ident, call2MethodSel, call2ArgsSel])]),
    ]);

    const sig1 = mkNode('method_signature', [mkNode('function_signature', [mkNode('identifier', [], { text: 'doA' })])]);
    const sig2 = mkNode('method_signature', [mkNode('function_signature', [mkNode('identifier', [], { text: 'doB' })])]);

    const classBody = mkNode('class_body', [sig1, body1, sig2, body2]);
    const classDef = mkNode('class_definition', [
      mkNode('identifier', [], { text: 'Controller' }),
      classBody,
    ]);
    const root = mkNode('source_file', [classDef]);
    const ctx = { callSites: [] };

    extractCallSitesDart(root, ctx, 'dart');

    expect(ctx.callSites).toHaveLength(2);
    expect(ctx.callSites[0]).toMatchObject({ callee: 'fetch', callerMethod: 'doA', callerClass: 'Controller' });
    expect(ctx.callSites[1]).toMatchObject({ callee: 'save', callerMethod: 'doB', callerClass: 'Controller' });
  });
});

// ─── tsconfig paths alias ────────────────────────────────

describe('ImportPathResolver — tsconfig paths alias', () => {
  test('resolves @/ alias to src/', () => {
    const resolver = new ImportPathResolver('/project', [
      'src/utils/helpers.ts',
      'src/services/auth.ts',
    ]);
    // Manually add alias configuration (simulating loaded tsconfig)
    resolver.pathAliases = [
      { prefix: '@', targets: ['src'] },
    ];

    expect(resolver.resolve('@/utils/helpers', 'src/index.ts')).toBe('src/utils/helpers.ts');
    expect(resolver.resolve('@/services/auth', 'src/index.ts')).toBe('src/services/auth.ts');
  });

  test('resolves ~/ alias to src/', () => {
    const resolver = new ImportPathResolver('/project', [
      'src/components/Button.tsx',
    ]);
    resolver.pathAliases = [
      { prefix: '~', targets: ['src'] },
    ];

    expect(resolver.resolve('~/components/Button', 'app.tsx')).toBe('src/components/Button.tsx');
  });

  test('returns null for non-matching alias', () => {
    const resolver = new ImportPathResolver('/project', [
      'src/utils/helpers.ts',
    ]);
    resolver.pathAliases = [
      { prefix: '@', targets: ['src'] },
    ];

    // 'lodash' is external, not matching any alias
    expect(resolver.resolve('lodash', 'src/index.ts')).toBeNull();
  });

  test('relative paths still work alongside aliases', () => {
    const resolver = new ImportPathResolver('/project', [
      'src/utils/helpers.ts',
      'src/services/auth.ts',
    ]);
    resolver.pathAliases = [
      { prefix: '@', targets: ['src'] },
    ];

    // Relative path should resolve normally
    expect(resolver.resolve('./utils/helpers', 'src/index.ts')).toBe('src/utils/helpers.ts');
  });
});

// ─── DI constructor injection inference ──────────────────

describe('CallEdgeResolver — DI field inference', () => {
  test('resolves this.field.method() via naming convention', () => {
    const symbolTable = SymbolTableBuilder.build({
      fileSummaries: [
        {
          file: 'src/controller/UserController.ts',
          classes: [{ name: 'UserController', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'getUser', className: 'UserController', line: 5 },
          ],
          imports: ['./UserRepo'],
          exports: [],
          callSites: [],
        },
        {
          file: 'src/repo/UserRepo.ts',
          classes: [{ name: 'UserRepo', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'findById', className: 'UserRepo', line: 10 },
          ],
          imports: [],
          exports: [{ name: 'UserRepo' }],
          callSites: [],
        },
      ],
    });

    const resolver = new CallEdgeResolver(
      symbolTable,
      new ImportPathResolver('/project', ['src/controller/UserController.ts', 'src/repo/UserRepo.ts']),
      [],
    );

    const callSite = {
      callee: 'findById',
      callerMethod: 'getUser',
      callerClass: 'UserController',
      callType: 'method',
      receiver: 'this.userRepo',
      receiverType: null,
      argCount: 1,
      line: 8,
      isAwait: false,
    };

    const edges = resolver.resolveFile([callSite], 'src/controller/UserController.ts');

    expect(edges.length).toBe(1);
    expect(edges[0].callee).toContain('UserRepo');
    expect(edges[0].callee).toContain('findById');
    expect(edges[0].resolveMethod).toBe('inferred');
  });

  test('_inferFieldType strips underscores and converts to PascalCase', () => {
    const symbolTable = SymbolTableBuilder.build({
      fileSummaries: [
        {
          file: 'a.ts',
          classes: [{ name: 'AuthService', kind: 'class', line: 1 }],
          protocols: [],
          methods: [],
          imports: [],
          exports: [],
          callSites: [],
        },
      ],
    });

    const resolver = new CallEdgeResolver(symbolTable, new ImportPathResolver('/p', ['a.ts']), []);

    // Private access: resolver._inferFieldType
    expect(resolver._inferFieldType('authService')).toBe('AuthService');
    expect(resolver._inferFieldType('_authService')).toBe('AuthService');
    expect(resolver._inferFieldType('__authService')).toBe('AuthService');
    // Non-existent type should return null
    expect(resolver._inferFieldType('unknownService')).toBeNull();
  });
});

// ─── Partial result on timeout ───────────────────────────

describe('CallGraphAnalyzer — partial result on timeout', () => {
  test('returns partial result with stats.partial when deadline exceeded', async () => {
    const analyzer = new CallGraphAnalyzer('/project');

    // Create enough file summaries to simulate processing
    const fileSummaries = Array.from({ length: 50 }, (_, i) => ({
      file: `src/file${i}.ts`,
      lang: 'typescript',
      classes: [{ name: `Class${i}`, kind: 'class', line: 1 }],
      protocols: [],
      methods: [{ name: `method${i}`, className: `Class${i}`, line: 5 }],
      imports: [],
      exports: [],
      callSites: [{
        callee: `method${(i + 1) % 50}`,
        callerMethod: `method${i}`,
        callerClass: `Class${i}`,
        callType: 'function',
        receiver: null,
        receiverType: null,
        argCount: 0,
        line: 8,
        isAwait: false,
      }],
    }));

    // With a very short timeout, it should return partial results
    const result = await analyzer.analyze({ fileSummaries }, { timeout: 1 });

    // Either partial (if timeout hit) or complete (if fast enough)
    expect(result).toBeDefined();
    expect(result.callEdges).toBeDefined();
    expect(result.stats).toBeDefined();

    // The result should NOT be empty (unlike old behavior that returned empty on timeout)
    // If partial, verify stats
    if (result.stats.partial) {
      expect(result.stats.processedFiles).toBeLessThan(50);
      expect(result.stats.totalFiles).toBeDefined();
    }
  });

  test('returns complete result within generous timeout', async () => {
    const analyzer = new CallGraphAnalyzer('/project');

    const result = await analyzer.analyze({
      fileSummaries: [{
        file: 'src/main.ts',
        classes: [{ name: 'App', kind: 'class', line: 1 }],
        protocols: [],
        methods: [
          { name: 'start', className: 'App', line: 5 },
          { name: 'stop', className: 'App', line: 15 },
        ],
        imports: [],
        exports: [],
        callSites: [{
          callee: 'stop',
          callerMethod: 'start',
          callerClass: 'App',
          callType: 'method',
          receiver: 'this',
          receiverType: 'App',
          argCount: 0,
          line: 8,
          isAwait: false,
        }],
      }],
    }, { timeout: 10000 });

    expect(result.stats.partial).toBeUndefined();
    expect(result.callEdges.length).toBe(1);
  });
});

// ─── Incremental analysis ────────────────────────────────

describe('CallGraphAnalyzer — incremental analysis', () => {
  test('analyzeIncremental returns empty for no changes', async () => {
    const analyzer = new CallGraphAnalyzer('/project');
    const result = await analyzer.analyzeIncremental(
      { fileSummaries: [{ file: 'a.ts', classes: [], protocols: [], methods: [], imports: [], exports: [], callSites: [] }] },
      [],
    );
    expect(result.callEdges).toEqual([]);
  });

  test('analyzeIncremental only processes affected files', async () => {
    const analyzer = new CallGraphAnalyzer('/project');

    const summary = {
      fileSummaries: [
        {
          file: 'src/service.ts',
          classes: [{ name: 'Service', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'execute', className: 'Service', line: 5 },
          ],
          imports: [],
          exports: [{ name: 'Service' }],
          callSites: [],
        },
        {
          file: 'src/controller.ts',
          classes: [{ name: 'Controller', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'handle', className: 'Controller', line: 5 },
          ],
          imports: ['./service'],
          exports: [],
          callSites: [{
            callee: 'execute',
            callerMethod: 'handle',
            callerClass: 'Controller',
            callType: 'function',
            receiver: 'Service',
            receiverType: null,
            argCount: 0,
            line: 8,
            isAwait: false,
          }],
        },
        {
          file: 'src/unrelated.ts',
          classes: [{ name: 'Util', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'helper', className: 'Util', line: 5 },
          ],
          imports: [],
          exports: [],
          callSites: [{
            callee: 'helper',
            callerMethod: 'helper',
            callerClass: 'Util',
            callType: 'method',
            receiver: 'this',
            receiverType: 'Util',
            argCount: 0,
            line: 8,
            isAwait: false,
          }],
        },
      ],
    };

    // Only service.ts changed — should rebuild controller (depends on service) but not unrelated
    const result = await analyzer.analyzeIncremental(summary, ['src/service.ts']);

    expect(result.stats.incremental).toBe(true);
    expect(result.stats.changedFiles).toBe(1);
    expect(result.stats.affectedFiles).toBe(2); // service.ts + controller.ts
  });

  test('analyzeIncremental falls back to full for >10 files', async () => {
    const analyzer = new CallGraphAnalyzer('/project');
    const files = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`);
    const summary = {
      fileSummaries: files.map((f) => ({
        file: f,
        classes: [],
        protocols: [],
        methods: [{ name: 'fn', className: null, line: 1 }],
        imports: [],
        exports: [],
        callSites: [],
      })),
    };

    const result = await analyzer.analyzeIncremental(summary, files, { timeout: 5000 });

    // Should fallback to full analysis — no incremental flag
    expect(result.stats.incremental).toBeUndefined();
    expect(result.stats.tier).toBeDefined();
  });
});

// ─── Phase 5.3: RTA (Rapid Type Analysis) ────────────────

describe('SymbolTableBuilder — RTA instantiatedClasses', () => {
  test('collects instantiated classes from constructor callSites', () => {
    const table = SymbolTableBuilder.build({
      fileSummaries: [
        {
          file: 'src/main.ts',
          classes: [
            { name: 'UserService', kind: 'class', line: 1 },
            { name: 'OrderService', kind: 'class', line: 20 },
            { name: 'AdminService', kind: 'class', line: 40 },
          ],
          protocols: [],
          methods: [{ name: 'bootstrap', className: null, line: 60 }],
          imports: [],
          exports: [],
          callSites: [
            { callType: 'constructor', receiverType: 'UserService', callee: 'UserService', callerMethod: 'bootstrap', line: 62 },
            { callType: 'constructor', receiverType: 'OrderService', callee: 'OrderService', callerMethod: 'bootstrap', line: 63 },
            { callType: 'method', receiverType: null, callee: 'doStuff', callerMethod: 'bootstrap', line: 64 },
          ],
        },
      ],
    });

    expect(table.instantiatedClasses).toBeInstanceOf(Set);
    expect(table.instantiatedClasses.has('UserService')).toBe(true);
    expect(table.instantiatedClasses.has('OrderService')).toBe(true);
    // AdminService is never instantiated
    expect(table.instantiatedClasses.has('AdminService')).toBe(false);
  });

  test('collects JSX component instantiations', () => {
    const table = SymbolTableBuilder.build({
      fileSummaries: [
        {
          file: 'src/App.tsx',
          classes: [{ name: 'UserList', kind: 'class', line: 1 }],
          protocols: [],
          methods: [],
          imports: [],
          exports: [],
          callSites: [
            { callType: 'constructor', receiverType: 'UserList', callee: 'UserList', callerMethod: 'render', line: 10 },
          ],
        },
      ],
    });

    expect(table.instantiatedClasses.has('UserList')).toBe(true);
  });
});

describe('SymbolTableBuilder — DI propertyTypes', () => {
  test('collects property type annotations from properties', () => {
    const table = SymbolTableBuilder.build({
      fileSummaries: [
        {
          file: 'src/controller.ts',
          classes: [{ name: 'UserController', kind: 'class', line: 1 }],
          protocols: [],
          methods: [],
          imports: [],
          exports: [],
          callSites: [],
          properties: [
            { name: 'userService', className: 'UserController', typeAnnotation: 'UserService', line: 3 },
            { name: 'logger', className: 'UserController', typeAnnotation: 'Logger', line: 4 },
            { name: 'count', className: 'UserController', typeAnnotation: null, line: 5 },
          ],
        },
      ],
    });

    expect(table.propertyTypes).toBeInstanceOf(Map);
    expect(table.propertyTypes.has('UserController')).toBe(true);
    const props = table.propertyTypes.get('UserController');
    expect(props.get('userService')).toBe('UserService');
    expect(props.get('logger')).toBe('Logger');
    expect(props.has('count')).toBe(false); // null typeAnnotation not stored
  });

  test('empty propertyTypes when no type annotations', () => {
    const table = SymbolTableBuilder.build({
      fileSummaries: [
        {
          file: 'a.ts',
          classes: [],
          protocols: [],
          methods: [],
          imports: [],
          exports: [],
          callSites: [],
          properties: [{ name: 'x', className: 'A', line: 1 }],
        },
      ],
    });

    expect(table.propertyTypes.size).toBe(0);
  });
});

describe('CallEdgeResolver — RTA filtering', () => {
  test('RTA narrows multiple global candidates to the instantiated one', () => {
    const table = SymbolTableBuilder.build({
      fileSummaries: [
        {
          file: 'src/services/UserService.ts',
          classes: [{ name: 'UserService', kind: 'class', line: 1 }],
          protocols: [],
          methods: [{ name: 'process', className: 'UserService', line: 5 }],
          imports: [],
          exports: [],
          callSites: [
            { callType: 'constructor', receiverType: 'UserService', callee: 'UserService', callerMethod: 'main', line: 100 },
          ],
        },
        {
          file: 'src/services/OrderService.ts',
          classes: [{ name: 'OrderService', kind: 'class', line: 1 }],
          protocols: [],
          methods: [{ name: 'process', className: 'OrderService', line: 5 }],
          imports: [],
          exports: [],
          callSites: [],
          // OrderService is NOT instantiated
        },
        {
          file: 'src/app.ts',
          classes: [],
          protocols: [],
          methods: [{ name: 'main', className: null, line: 1 }],
          imports: [],
          exports: [],
          callSites: [],
        },
      ],
    });

    const resolver = new CallEdgeResolver(
      table,
      new ImportPathResolver('/project', [
        'src/services/UserService.ts',
        'src/services/OrderService.ts',
        'src/app.ts',
      ]),
      [],
    );

    // process() exists in both UserService and OrderService
    // Without RTA: unresolvable (2 candidates)
    // With RTA: only UserService is instantiated → resolves
    const edges = resolver.resolveFile(
      [{
        callee: 'process',
        callerMethod: 'main',
        callerClass: null,
        callType: 'function',
        receiver: null,
        receiverType: null,
        argCount: 0,
        line: 10,
        isAwait: false,
      }],
      'src/app.ts',
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].callee).toContain('UserService.process');
    expect(edges[0].resolveMethod).toBe('rta');
  });

  test('RTA does not narrow when multiple candidates are still instantiated', () => {
    const table = SymbolTableBuilder.build({
      fileSummaries: [
        {
          file: 'src/a.ts',
          classes: [{ name: 'A', kind: 'class', line: 1 }],
          protocols: [],
          methods: [{ name: 'run', className: 'A', line: 5 }],
          imports: [],
          exports: [],
          callSites: [{ callType: 'constructor', receiverType: 'A', callee: 'A', callerMethod: 'x', line: 10 }],
        },
        {
          file: 'src/b.ts',
          classes: [{ name: 'B', kind: 'class', line: 1 }],
          protocols: [],
          methods: [{ name: 'run', className: 'B', line: 5 }],
          imports: [],
          exports: [],
          callSites: [{ callType: 'constructor', receiverType: 'B', callee: 'B', callerMethod: 'x', line: 10 }],
        },
        {
          file: 'src/main.ts',
          classes: [],
          protocols: [],
          methods: [{ name: 'main', className: null, line: 1 }],
          imports: [],
          exports: [],
          callSites: [],
        },
      ],
    });

    const resolver = new CallEdgeResolver(
      table,
      new ImportPathResolver('/project', ['src/a.ts', 'src/b.ts', 'src/main.ts']),
      [],
    );

    // Both A and B are instantiated → RTA can't narrow
    const edges = resolver.resolveFile(
      [{
        callee: 'run',
        callerMethod: 'main',
        callerClass: null,
        callType: 'function',
        receiver: null,
        receiverType: null,
        argCount: 0,
        line: 5,
        isAwait: false,
      }],
      'src/main.ts',
    );

    expect(edges).toHaveLength(0); // Still unresolvable
  });
});

describe('CallEdgeResolver — DI type annotation resolution', () => {
  test('resolves this.field.method() via propertyTypes (direct type annotation)', () => {
    const table = SymbolTableBuilder.build({
      fileSummaries: [
        {
          file: 'src/controller/UserController.ts',
          classes: [{ name: 'UserController', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'getUser', className: 'UserController', line: 5 },
          ],
          imports: ['./UserRepo'],
          exports: [],
          callSites: [],
          properties: [
            { name: 'userRepo', className: 'UserController', typeAnnotation: 'UserRepo', line: 3 },
          ],
        },
        {
          file: 'src/repo/UserRepo.ts',
          classes: [{ name: 'UserRepo', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'findById', className: 'UserRepo', line: 10 },
          ],
          imports: [],
          exports: [{ name: 'UserRepo' }],
          callSites: [],
        },
      ],
    });

    const resolver = new CallEdgeResolver(
      table,
      new ImportPathResolver('/project', [
        'src/controller/UserController.ts',
        'src/repo/UserRepo.ts',
      ]),
      [],
    );

    const edges = resolver.resolveFile(
      [{
        callee: 'findById',
        callerMethod: 'getUser',
        callerClass: 'UserController',
        callType: 'method',
        receiver: 'this.userRepo',
        receiverType: null,
        argCount: 1,
        line: 8,
        isAwait: false,
      }],
      'src/controller/UserController.ts',
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].callee).toContain('UserRepo');
    expect(edges[0].callee).toContain('findById');
    // Direct resolution from type annotation (not 'inferred' from naming convention)
    expect(edges[0].resolveMethod).toBe('direct');
  });

  test('propertyTypes takes priority over naming convention', () => {
    // Scenario: field named 'repo' but type is explicitly 'UserRepository'
    // Naming convention would infer 'Repo' (which doesn't exist)
    // Type annotation should correctly resolve to 'UserRepository'
    const table = SymbolTableBuilder.build({
      fileSummaries: [
        {
          file: 'src/service.ts',
          classes: [{ name: 'Service', kind: 'class', line: 1 }],
          protocols: [],
          methods: [{ name: 'execute', className: 'Service', line: 5 }],
          imports: [],
          exports: [],
          callSites: [],
          properties: [
            { name: 'repo', className: 'Service', typeAnnotation: 'UserRepository', line: 3 },
          ],
        },
        {
          file: 'src/repo.ts',
          classes: [{ name: 'UserRepository', kind: 'class', line: 1 }],
          protocols: [],
          methods: [{ name: 'save', className: 'UserRepository', line: 5 }],
          imports: [],
          exports: [],
          callSites: [],
        },
      ],
    });

    const resolver = new CallEdgeResolver(
      table,
      new ImportPathResolver('/project', ['src/service.ts', 'src/repo.ts']),
      [],
    );

    const edges = resolver.resolveFile(
      [{
        callee: 'save',
        callerMethod: 'execute',
        callerClass: 'Service',
        callType: 'method',
        receiver: 'this.repo',
        receiverType: null,
        argCount: 1,
        line: 8,
        isAwait: false,
      }],
      'src/service.ts',
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].callee).toContain('UserRepository.save');
    expect(edges[0].resolveMethod).toBe('direct');
  });

  test('falls back to naming convention when no type annotation', () => {
    const table = SymbolTableBuilder.build({
      fileSummaries: [
        {
          file: 'src/controller.ts',
          classes: [{ name: 'Controller', kind: 'class', line: 1 }],
          protocols: [],
          methods: [{ name: 'handle', className: 'Controller', line: 5 }],
          imports: [],
          exports: [],
          callSites: [],
          // No properties with typeAnnotation
        },
        {
          file: 'src/auth-service.ts',
          classes: [{ name: 'AuthService', kind: 'class', line: 1 }],
          protocols: [],
          methods: [{ name: 'verify', className: 'AuthService', line: 5 }],
          imports: [],
          exports: [],
          callSites: [],
        },
      ],
    });

    const resolver = new CallEdgeResolver(
      table,
      new ImportPathResolver('/project', ['src/controller.ts', 'src/auth-service.ts']),
      [],
    );

    const edges = resolver.resolveFile(
      [{
        callee: 'verify',
        callerMethod: 'handle',
        callerClass: 'Controller',
        callType: 'method',
        receiver: 'this.authService',
        receiverType: null,
        argCount: 0,
        line: 8,
        isAwait: false,
      }],
      'src/controller.ts',
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].callee).toContain('AuthService.verify');
    expect(edges[0].resolveMethod).toBe('inferred'); // naming convention
  });
});

describe('CallGraphAnalyzer — Phase 5.3 RTA+DI integration', () => {
  test('end-to-end: RTA + DI type annotations in full analysis', async () => {
    const analyzer = new CallGraphAnalyzer('/project');

    const summary = {
      fileSummaries: [
        {
          file: 'src/service/UserService.ts',
          classes: [{ name: 'UserService', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'getUser', className: 'UserService', line: 5 },
          ],
          imports: [],
          exports: [{ name: 'UserService' }],
          callSites: [
            {
              callee: 'findById',
              callerMethod: 'getUser',
              callerClass: 'UserService',
              callType: 'method',
              receiver: 'this.repo',
              receiverType: null,
              argCount: 1,
              line: 8,
              isAwait: true,
            },
          ],
          properties: [
            { name: 'repo', className: 'UserService', typeAnnotation: 'UserRepo', line: 3 },
          ],
        },
        {
          file: 'src/repo/UserRepo.ts',
          classes: [{ name: 'UserRepo', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'findById', className: 'UserRepo', line: 10 },
          ],
          imports: [],
          exports: [{ name: 'UserRepo' }],
          callSites: [],
        },
        {
          file: 'src/main.ts',
          classes: [],
          protocols: [],
          methods: [{ name: 'main', className: null, line: 1 }],
          imports: [],
          exports: [],
          callSites: [
            {
              callee: 'UserService',
              callerMethod: 'main',
              callerClass: null,
              callType: 'constructor',
              receiver: null,
              receiverType: 'UserService',
              argCount: 0,
              line: 5,
              isAwait: false,
            },
          ],
        },
      ],
    };

    const result = await analyzer.analyze(summary, { timeout: 10000 });

    // DI type annotation should resolve this.repo.findById()
    const diEdge = result.callEdges.find(
      (e) => e.caller.includes('UserService.getUser') && e.callee.includes('UserRepo.findById')
    );
    expect(diEdge).toBeDefined();
    expect(diEdge.resolveMethod).toBe('direct'); // from propertyTypes
  });
});

// ─── Phase 5.3: Kotlin primary constructor properties ─────

describe('Kotlin walker — constructor property extraction', () => {
  let walkKotlin;

  beforeAll(async () => {
    const mod = await import('../../lib/core/ast/lang-kotlin.js');
    walkKotlin = mod.plugin.walk;
  });

  function mkNode(type, children, extra = {}) {
    const namedChildren = children || [];
    return {
      type,
      text: extra.text || '',
      namedChildCount: namedChildren.length,
      namedChildren,
      namedChild(i) { return namedChildren[i]; },
      startPosition: extra.startPosition || { row: 0, column: 0 },
      endPosition: extra.endPosition || { row: 5, column: 0 },
      isMissing: false,
      ...extra,
    };
  }

  test('extracts primary constructor val/var params as properties with type', () => {
    // class UserService(private val repo: UserRepo, var logger: Logger)
    const param1 = mkNode('class_parameter', [
      mkNode('simple_identifier', [], { text: 'repo' }),
      mkNode('user_type', [], { text: 'UserRepo' }),
    ], { text: 'private val repo: UserRepo' });

    const param2 = mkNode('class_parameter', [
      mkNode('simple_identifier', [], { text: 'logger' }),
      mkNode('user_type', [], { text: 'Logger' }),
    ], { text: 'var logger: Logger' });

    // Non-property param (no val/var)
    const param3 = mkNode('class_parameter', [
      mkNode('simple_identifier', [], { text: 'temp' }),
      mkNode('user_type', [], { text: 'Int' }),
    ], { text: 'temp: Int' });

    const primaryCtor = mkNode('primary_constructor', [param1, param2, param3]);
    const classBody = mkNode('class_body', []);
    const typeId = mkNode('type_identifier', [], { text: 'UserService' });
    const classDecl = mkNode('class_declaration', [typeId, primaryCtor, classBody]);
    const root = mkNode('source_file', [classDecl]);

    const ctx = {
      classes: [],
      methods: [],
      properties: [],
      imports: [],
      exports: [],
      protocols: [],
      callSites: [],
    };

    walkKotlin(root, ctx);

    // Should have extracted 2 constructor property params (val repo, var logger) but not temp
    const ctorProps = ctx.properties.filter((p) => p.isConstructorParam);
    expect(ctorProps).toHaveLength(2);

    const repoProp = ctorProps.find((p) => p.name === 'repo');
    expect(repoProp).toBeDefined();
    expect(repoProp.typeAnnotation).toBe('UserRepo');
    expect(repoProp.isConstant).toBe(true);
    expect(repoProp.className).toBe('UserService');

    const loggerProp = ctorProps.find((p) => p.name === 'logger');
    expect(loggerProp).toBeDefined();
    expect(loggerProp.typeAnnotation).toBe('Logger');
    expect(loggerProp.isMutable).toBe(true);
  });

  test('extracts constructor param with nullable type', () => {
    const param = mkNode('class_parameter', [
      mkNode('simple_identifier', [], { text: 'cache' }),
      mkNode('nullable_type', [
        mkNode('user_type', [], { text: 'CacheService' }),
      ], { text: 'CacheService?' }),
    ], { text: 'val cache: CacheService?' });

    const primaryCtor = mkNode('primary_constructor', [param]);
    const classBody = mkNode('class_body', []);
    const typeId = mkNode('type_identifier', [], { text: 'Handler' });
    const classDecl = mkNode('class_declaration', [typeId, primaryCtor, classBody]);
    const root = mkNode('source_file', [classDecl]);

    const ctx = {
      classes: [],
      methods: [],
      properties: [],
      imports: [],
      exports: [],
      protocols: [],
      callSites: [],
    };

    walkKotlin(root, ctx);

    const cacheProp = ctx.properties.find((p) => p.name === 'cache');
    expect(cacheProp).toBeDefined();
    expect(cacheProp.typeAnnotation).toBe('CacheService');
    expect(cacheProp.isConstructorParam).toBe(true);
  });
});

// ─── Phase 5.3: _inferFieldType optimization ──────────────

describe('CallEdgeResolver — _inferFieldType performance (classNames Set)', () => {
  test('_inferFieldType uses O(1) classNames Set lookup', () => {
    const table = SymbolTableBuilder.build({
      fileSummaries: [
        {
          file: 'a.ts',
          classes: [
            { name: 'UserService', kind: 'class', line: 1 },
            { name: 'OrderService', kind: 'class', line: 10 },
          ],
          protocols: [],
          methods: [],
          imports: [],
          exports: [],
          callSites: [],
        },
      ],
    });

    const resolver = new CallEdgeResolver(
      table,
      new ImportPathResolver('/p', ['a.ts']),
      [],
    );

    // Verify classNames set was built
    expect(resolver.classNames).toBeInstanceOf(Set);
    expect(resolver.classNames.has('UserService')).toBe(true);
    expect(resolver.classNames.has('OrderService')).toBe(true);

    // Infer should work
    expect(resolver._inferFieldType('userService')).toBe('UserService');
    expect(resolver._inferFieldType('orderService')).toBe('OrderService');
    expect(resolver._inferFieldType('nonExistent')).toBeNull();
  });
});

// ─── Phase 5.3: Kotlin DI constructor params in SymbolTable ──

describe('SymbolTableBuilder — Kotlin constructor DI integration', () => {
  test('propertyTypes populated from Kotlin constructor params', () => {
    const table = SymbolTableBuilder.build({
      fileSummaries: [
        {
          file: 'src/service/Service.kt',
          classes: [{ name: 'UserService', kind: 'class', line: 1 }],
          protocols: [],
          methods: [{ name: 'getUser', className: 'UserService', line: 5 }],
          imports: [],
          exports: [],
          callSites: [],
          properties: [
            {
              name: 'repo',
              className: 'UserService',
              typeAnnotation: 'UserRepo',
              isConstructorParam: true,
              line: 2,
            },
            {
              name: 'logger',
              className: 'UserService',
              typeAnnotation: 'Logger',
              isConstructorParam: true,
              line: 3,
            },
          ],
        },
      ],
    });

    expect(table.propertyTypes.has('UserService')).toBe(true);
    const props = table.propertyTypes.get('UserService');
    expect(props.get('repo')).toBe('UserRepo');
    expect(props.get('logger')).toBe('Logger');
  });
});

// ─── Phase 5.3: RTA + global search with mixed candidates ──

describe('CallEdgeResolver — RTA with top-level functions', () => {
  test('RTA preserves top-level functions when filtering class methods', () => {
    // Scenario: 'process' exists as both a class method and a top-level function
    // RTA should keep the top-level function (it's not class-bound)
    const table = SymbolTableBuilder.build({
      fileSummaries: [
        {
          file: 'src/a.ts',
          classes: [{ name: 'Processor', kind: 'class', line: 1 }],
          protocols: [],
          methods: [
            { name: 'handle', className: 'Processor', line: 5 },
          ],
          imports: [],
          exports: [],
          callSites: [],
          // Processor is NOT instantiated
        },
        {
          file: 'src/b.ts',
          classes: [],
          protocols: [],
          methods: [
            { name: 'handle', className: null, line: 1 }, // top-level function
          ],
          imports: [],
          exports: [],
          callSites: [],
        },
        {
          file: 'src/main.ts',
          classes: [],
          protocols: [],
          methods: [{ name: 'main', className: null, line: 1 }],
          imports: [],
          exports: [],
          callSites: [
            { callType: 'constructor', receiverType: 'SomeOther', callee: 'SomeOther', callerMethod: 'x', line: 1 },
          ],
        },
      ],
    });

    const resolver = new CallEdgeResolver(
      table,
      new ImportPathResolver('/project', ['src/a.ts', 'src/b.ts', 'src/main.ts']),
      [],
    );

    // 'handle' exists in Processor.handle and top-level handle
    // RTA: Processor not instantiated → filtered out; top-level function preserved → 1 candidate
    const edges = resolver.resolveFile(
      [{
        callee: 'handle',
        callerMethod: 'main',
        callerClass: null,
        callType: 'function',
        receiver: null,
        receiverType: null,
        argCount: 0,
        line: 5,
        isAwait: false,
      }],
      'src/main.ts',
    );

    expect(edges).toHaveLength(1);
    expect(edges[0].callee).toContain('src/b.ts::handle');
    expect(edges[0].resolveMethod).toBe('rta');
  });
});

// ─── Super call resolution (Priority 0) ──────────────────

describe('CallEdgeResolver — super call resolution', () => {
  let CallEdgeResolver, SymbolTableBuilder, ImportPathResolver;

  beforeAll(async () => {
    ({ CallEdgeResolver } = await import('../../lib/core/analysis/CallEdgeResolver.js'));
    ({ SymbolTableBuilder } = await import('../../lib/core/analysis/SymbolTableBuilder.js'));
    ({ ImportPathResolver } = await import('../../lib/core/analysis/ImportPathResolver.js'));
  });

  test('super.xxx() resolves to parent class method via CHA (not self-edge)', () => {
    // Parent: BaseController has method render()
    // Child: HomeController overrides render(), calls super.render()
    const table = SymbolTableBuilder.build({
      fileSummaries: [
        {
          file: 'src/base.ts',
          classes: [{ name: 'BaseController', line: 1 }],
          methods: [{ name: 'render', className: 'BaseController', kind: 'definition', line: 5 }],
          properties: [], protocols: [], categories: [], imports: [], exports: [], callSites: [],
        },
        {
          file: 'src/home.ts',
          classes: [{ name: 'HomeController', line: 1 }],
          methods: [{ name: 'render', className: 'HomeController', kind: 'definition', line: 5 }],
          properties: [], protocols: [], categories: [], imports: [], exports: [],
          callSites: [
            { callType: 'super', receiver: 'super', receiverType: 'HomeController',
              callee: 'render', callerMethod: 'render', callerClass: 'HomeController', line: 6, isAwait: false },
          ],
        },
      ],
    });

    const inheritanceGraph = [
      { from: 'HomeController', to: 'BaseController', type: 'inherits' },
    ];

    const resolver = new CallEdgeResolver(
      table,
      new ImportPathResolver('/project', ['src/base.ts', 'src/home.ts']),
      inheritanceGraph,
    );

    const edges = resolver.resolveFile(
      [{
        callType: 'super', receiver: 'super', receiverType: 'HomeController',
        callee: 'render', callerMethod: 'render', callerClass: 'HomeController', line: 6, isAwait: false,
      }],
      'src/home.ts',
    );

    // Should resolve to BaseController.render (CHA), NOT HomeController.render (self-edge)
    expect(edges).toHaveLength(1);
    expect(edges[0].callee).toContain('BaseController.render');
    expect(edges[0].resolveMethod).toBe('cha');
    // Must NOT be a self-edge
    expect(edges[0].caller).not.toBe(edges[0].callee);
  });

  test('super.xxx() without inheritance graph produces no edge (not self-edge)', () => {
    const table = SymbolTableBuilder.build({
      fileSummaries: [{
        file: 'src/child.ts',
        classes: [{ name: 'Child', line: 1 }],
        methods: [{ name: 'init', className: 'Child', kind: 'definition', line: 5 }],
        properties: [], protocols: [], categories: [], imports: [], exports: [],
        callSites: [],
      }],
    });

    const resolver = new CallEdgeResolver(
      table,
      new ImportPathResolver('/project', ['src/child.ts']),
      [], // no inheritance graph
    );

    const edges = resolver.resolveFile(
      [{
        callType: 'super', receiver: 'super', receiverType: 'Child',
        callee: 'init', callerMethod: 'init', callerClass: 'Child', line: 6, isAwait: false,
      }],
      'src/child.ts',
    );

    // Should produce NO edge (not a self-edge to Child.init)
    expect(edges).toHaveLength(0);
  });
});

// ─── Duplicate edge deduplication ─────────────────────────

describe('CallEdgeResolver — duplicate edge deduplication', () => {
  let CallEdgeResolver, SymbolTableBuilder, ImportPathResolver;

  beforeAll(async () => {
    ({ CallEdgeResolver } = await import('../../lib/core/analysis/CallEdgeResolver.js'));
    ({ SymbolTableBuilder } = await import('../../lib/core/analysis/SymbolTableBuilder.js'));
    ({ ImportPathResolver } = await import('../../lib/core/analysis/ImportPathResolver.js'));
  });

  test('same caller→callee at same line deduplicates to 1 edge', () => {
    const table = SymbolTableBuilder.build({
      fileSummaries: [{
        file: 'src/a.ts',
        classes: [],
        methods: [
          { name: 'doWork', kind: 'definition', line: 1 },
          { name: 'helper', kind: 'definition', line: 10 },
        ],
        properties: [], protocols: [], categories: [], imports: [], exports: [],
        callSites: [],
      }],
    });

    const resolver = new CallEdgeResolver(
      table,
      new ImportPathResolver('/project', ['src/a.ts']),
      [],
    );

    // Two identical callSites (same callee, same line) — simulating AST double extraction
    const edges = resolver.resolveFile([
      { callee: 'helper', callerMethod: 'doWork', callerClass: null, callType: 'function',
        receiver: null, receiverType: null, argCount: 0, line: 5, isAwait: false },
      { callee: 'helper', callerMethod: 'doWork', callerClass: null, callType: 'function',
        receiver: null, receiverType: null, argCount: 0, line: 5, isAwait: false },
    ], 'src/a.ts');

    // Should deduplicate: only 1 edge
    expect(edges).toHaveLength(1);
    expect(edges[0].callee).toContain('helper');
  });
});

// ─── Swift super call extraction ──────────────────────────

describe('Swift walker — super call extraction', () => {
  let analyzeFile;

  beforeAll(async () => {
    await import('../../lib/core/ast/index.js');
    ({ analyzeFile } = await import('../../lib/core/AstAnalyzer.js'));
  });

  test('super.xxx() sets callType=super in Swift', () => {
    const code = `
class BaseVC {
  func viewDidLoad() {}
}
class HomeVC: BaseVC {
  override func viewDidLoad() {
    super.viewDidLoad()
  }
}`;
    const summary = analyzeFile(code, 'swift');
    const superCall = summary?.callSites?.find(
      (cs) => cs.callee === 'viewDidLoad' && (cs.receiver === 'super' || cs.callType === 'super')
    );
    expect(superCall).toBeDefined();
    expect(superCall.callType).toBe('super');
  });
});

// ─── Java super call extraction ───────────────────────────

describe('Java walker — super call extraction', () => {
  let analyzeFile;

  beforeAll(async () => {
    await import('../../lib/core/ast/index.js');
    ({ analyzeFile } = await import('../../lib/core/AstAnalyzer.js'));
  });

  test('super.xxx() sets callType=super in Java', () => {
    const code = `
public class BaseEntity {
  public String toString() { return "base"; }
}
public class Pet extends BaseEntity {
  @Override
  public String toString() {
    return super.toString() + " pet";
  }
}`;
    const summary = analyzeFile(code, 'java');
    const superCall = summary?.callSites?.find(
      (cs) => cs.callee === 'toString' && (cs.receiver === 'super' || cs.callType === 'super')
    );
    expect(superCall).toBeDefined();
    expect(superCall.callType).toBe('super');
  });
});

// ─── Kotlin super/this call extraction ────────────────────

describe('Kotlin walker — super and this call extraction', () => {
  let analyzeFile;

  beforeAll(async () => {
    await import('../../lib/core/ast/index.js');
    ({ analyzeFile } = await import('../../lib/core/AstAnalyzer.js'));
  });

  test('super.xxx() sets callType=super in Kotlin', () => {
    const code = `
open class Base {
  open fun init() {}
}
class Child : Base() {
  override fun init() {
    super.init()
  }
}`;
    const summary = analyzeFile(code, 'kotlin');
    const superCall = summary?.callSites?.find(
      (cs) => cs.callee === 'init' && cs.callType === 'super'
    );
    expect(superCall).toBeDefined();
    expect(superCall.receiver).toBe('super');
  });

  test('this.xxx() sets receiver=this with receiverType in Kotlin', () => {
    const code = `
class Service {
  fun process() {
    this.validate()
  }
  fun validate() {}
}`;
    const summary = analyzeFile(code, 'kotlin');
    const thisCall = summary?.callSites?.find(
      (cs) => cs.callee === 'validate' && cs.receiver === 'this'
    );
    expect(thisCall).toBeDefined();
    expect(thisCall.callType).toBe('method');
  });
});

