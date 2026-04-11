/**
 * CouplingAnalyzer 单元测试
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CouplingAnalyzer } from '../../lib/service/panorama/CouplingAnalyzer.js';
import { createMockRepos, type MockEdge, type MockEntity } from '../helpers/panorama-mocks.js';

/* ═══ Helper ══════════════════════════════════════════════ */

function makeAnalyzer(edges: MockEdge[] = [], entities: MockEntity[] = []) {
  const repos = createMockRepos({ edges, entities });
  return new CouplingAnalyzer(repos.edgeRepo, repos.entityRepo, '/test');
}

/* ═══ Tests ═══════════════════════════════════════════════ */

describe('CouplingAnalyzer', () => {
  it('should return empty result for no modules', async () => {
    const analyzer = makeAnalyzer();
    const result = await analyzer.analyze(new Map());

    expect(result.cycles).toHaveLength(0);
    expect(result.metrics.size).toBe(0);
    expect(result.edges).toHaveLength(0);
  });

  it('should detect module-to-module depends_on edges', async () => {
    const analyzer = makeAnalyzer([
      {
        from_id: 'ModA',
        from_type: 'module',
        to_id: 'ModB',
        to_type: 'module',
        relation: 'depends_on',
      },
    ]);

    const moduleFiles = new Map([
      ['ModA', ['/test/a.swift']],
      ['ModB', ['/test/b.swift']],
    ]);

    const result = await analyzer.analyze(moduleFiles);

    expect(result.edges.length).toBeGreaterThanOrEqual(1);
    const edge = result.edges.find((e) => e.from === 'ModA' && e.to === 'ModB');
    expect(edge).toBeDefined();
    expect(edge!.weight).toBe(0.5); // depends_on weight
  });

  it('should compute fanIn/fanOut correctly', async () => {
    const analyzer = makeAnalyzer([
      {
        from_id: 'ModA',
        from_type: 'module',
        to_id: 'ModB',
        to_type: 'module',
        relation: 'depends_on',
      },
      {
        from_id: 'ModA',
        from_type: 'module',
        to_id: 'ModC',
        to_type: 'module',
        relation: 'depends_on',
      },
      {
        from_id: 'ModC',
        from_type: 'module',
        to_id: 'ModB',
        to_type: 'module',
        relation: 'depends_on',
      },
    ]);

    const moduleFiles = new Map([
      ['ModA', ['/test/a.swift']],
      ['ModB', ['/test/b.swift']],
      ['ModC', ['/test/c.swift']],
    ]);

    const result = await analyzer.analyze(moduleFiles);

    // ModB: fanIn=2 (from A and C), fanOut=0
    expect(result.metrics.get('ModB')!.fanIn).toBe(2);
    expect(result.metrics.get('ModB')!.fanOut).toBe(0);

    // ModA: fanIn=0, fanOut=2 (to B and C)
    expect(result.metrics.get('ModA')!.fanIn).toBe(0);
    expect(result.metrics.get('ModA')!.fanOut).toBe(2);
  });

  it('should detect cyclic dependencies via Tarjan SCC', async () => {
    const analyzer = makeAnalyzer([
      {
        from_id: 'ModA',
        from_type: 'module',
        to_id: 'ModB',
        to_type: 'module',
        relation: 'depends_on',
      },
      {
        from_id: 'ModB',
        from_type: 'module',
        to_id: 'ModC',
        to_type: 'module',
        relation: 'depends_on',
      },
      {
        from_id: 'ModC',
        from_type: 'module',
        to_id: 'ModA',
        to_type: 'module',
        relation: 'depends_on',
      },
    ]);

    const moduleFiles = new Map([
      ['ModA', []],
      ['ModB', []],
      ['ModC', []],
    ]);

    const result = await analyzer.analyze(moduleFiles);

    expect(result.cycles.length).toBeGreaterThanOrEqual(1);
    const cycle = result.cycles[0];
    expect(cycle.cycle).toHaveLength(3);
    expect(cycle.severity).toBe('warning'); // 3 nodes = warning
  });

  it('should mark large cycles as error severity', async () => {
    const analyzer = makeAnalyzer([
      { from_id: 'A', from_type: 'module', to_id: 'B', to_type: 'module', relation: 'depends_on' },
      { from_id: 'B', from_type: 'module', to_id: 'C', to_type: 'module', relation: 'depends_on' },
      { from_id: 'C', from_type: 'module', to_id: 'D', to_type: 'module', relation: 'depends_on' },
      { from_id: 'D', from_type: 'module', to_id: 'A', to_type: 'module', relation: 'depends_on' },
    ]);

    const moduleFiles = new Map([
      ['A', []],
      ['B', []],
      ['C', []],
      ['D', []],
    ]);

    const result = await analyzer.analyze(moduleFiles);

    expect(result.cycles.length).toBeGreaterThanOrEqual(1);
    expect(result.cycles[0].severity).toBe('error'); // >3 nodes
  });

  it('should resolve entity-to-entity edges to module edges', async () => {
    const analyzer = makeAnalyzer(
      [
        {
          from_id: 'ClassA',
          from_type: 'method',
          to_id: 'ClassB',
          to_type: 'method',
          relation: 'calls',
        },
      ],
      [
        { entity_id: 'ClassA', file_path: '/test/modA/a.swift' },
        { entity_id: 'ClassB', file_path: '/test/modB/b.swift' },
      ]
    );

    const moduleFiles = new Map([
      ['ModA', ['/test/modA/a.swift']],
      ['ModB', ['/test/modB/b.swift']],
    ]);

    const result = await analyzer.analyze(moduleFiles);

    const edge = result.edges.find((e) => e.from === 'ModA' && e.to === 'ModB');
    expect(edge).toBeDefined();
    expect(edge!.weight).toBe(1.0); // calls weight
  });

  it('should skip self-edges', async () => {
    const analyzer = makeAnalyzer([
      {
        from_id: 'ModA',
        from_type: 'module',
        to_id: 'ModA',
        to_type: 'module',
        relation: 'depends_on',
      },
    ]);

    const moduleFiles = new Map([['ModA', []]]);
    const result = await analyzer.analyze(moduleFiles);

    expect(result.edges).toHaveLength(0);
  });

  /* ═══ Import-based inference tests ═══════════════════════ */

  describe('import-based dependency inference', () => {
    const tmpBase = join(tmpdir(), 'coupling-analyzer-test');

    beforeAll(() => {
      mkdirSync(join(tmpBase, 'Search'), { recursive: true });
      mkdirSync(join(tmpBase, 'Message'), { recursive: true });
      mkdirSync(join(tmpBase, 'Player'), { recursive: true });
      mkdirSync(join(tmpBase, 'UserService'), { recursive: true });
      mkdirSync(join(tmpBase, 'WebApp'), { recursive: true });
      mkdirSync(join(tmpBase, 'GoHandler'), { recursive: true });
      mkdirSync(join(tmpBase, 'RustService'), { recursive: true });
      mkdirSync(join(tmpBase, 'PyModule'), { recursive: true });
      mkdirSync(join(tmpBase, 'CSharpMod'), { recursive: true });

      // ObjC #import <Framework/Header.h>
      writeFileSync(
        join(tmpBase, 'Search', 'SearchVC.m'),
        `#import "SearchVC.h"\n#import <BDMVService/BDMVLogService.h>\n#import <Foundation/Foundation.h>\n`
      );

      // @import ModuleName;
      writeFileSync(
        join(tmpBase, 'Message', 'MsgManager.m'),
        `#import "MsgManager.h"\n@import BDMVService;\n@import UIKit;\n`
      );

      // Swift import
      writeFileSync(
        join(tmpBase, 'Player', 'PlayerVC.swift'),
        `import UIKit\nimport BDMVService\nimport Masonry\n`
      );

      // Java import
      writeFileSync(
        join(tmpBase, 'UserService', 'UserController.java'),
        `package com.example.user;\n\nimport retrofit2.Call;\nimport okhttp3.OkHttpClient;\nimport com.example.auth.AuthManager;\n`
      );

      // TypeScript ESM import
      writeFileSync(
        join(tmpBase, 'WebApp', 'index.ts'),
        `import express from 'express';\nimport { prisma } from 'prisma';\nimport { auth } from './local';\nconst lodash = require('lodash');\n`
      );

      // Go import
      writeFileSync(
        join(tmpBase, 'GoHandler', 'handler.go'),
        `package handler\n\nimport (\n\t"fmt"\n\t"github.com/gin-gonic/gin"\n\t"myproject/auth"\n)\n`
      );

      // Rust use
      writeFileSync(
        join(tmpBase, 'RustService', 'main.rs'),
        `use tokio::runtime;\nuse serde::Serialize;\nextern crate diesel;\n`
      );

      // Python import
      writeFileSync(
        join(tmpBase, 'PyModule', 'views.py'),
        `import requests\nfrom sqlalchemy import Column\nimport auth\n`
      );

      // C# using
      writeFileSync(
        join(tmpBase, 'CSharpMod', 'Service.cs'),
        `using System.Collections;\nusing Newtonsoft.Json;\nusing MyProject.Auth;\n`
      );

      // Non-source file (should be skipped)
      writeFileSync(join(tmpBase, 'Search', 'readme.md'), `# Search module\n`);
    });

    afterAll(() => {
      rmSync(tmpBase, { recursive: true, force: true });
    });

    it('should infer depends_on edges from ObjC #import <Module/Header.h>', async () => {
      const analyzer = makeAnalyzer();

      const moduleFiles = new Map([
        ['Search', [join(tmpBase, 'Search', 'SearchVC.m')]],
        ['BDMVService', ['/test/BDMVService/Service.m']],
      ]);

      const result = await analyzer.analyze(moduleFiles);

      const edge = result.edges.find((e) => e.from === 'Search' && e.to === 'BDMVService');
      expect(edge).toBeDefined();
      expect(edge!.weight).toBe(0.5);
      expect(edge!.relation).toBe('depends_on');
    });

    it('should infer depends_on edges from @import ModuleName', async () => {
      const analyzer = makeAnalyzer();

      const moduleFiles = new Map([
        ['Message', [join(tmpBase, 'Message', 'MsgManager.m')]],
        ['BDMVService', ['/test/BDMVService/Service.m']],
      ]);

      const result = await analyzer.analyze(moduleFiles);

      const edge = result.edges.find((e) => e.from === 'Message' && e.to === 'BDMVService');
      expect(edge).toBeDefined();
    });

    it('should infer depends_on edges from Swift import', async () => {
      const analyzer = makeAnalyzer();

      const moduleFiles = new Map([
        ['Player', [join(tmpBase, 'Player', 'PlayerVC.swift')]],
        ['BDMVService', ['/test/BDMVService/Service.m']],
        ['Masonry', ['/test/Masonry/Masonry.h']],
      ]);

      const result = await analyzer.analyze(moduleFiles);

      expect(result.edges.find((e) => e.from === 'Player' && e.to === 'BDMVService')).toBeDefined();
      expect(result.edges.find((e) => e.from === 'Player' && e.to === 'Masonry')).toBeDefined();
    });

    it('should NOT create self-edges from imports', async () => {
      const analyzer = makeAnalyzer();

      const moduleFiles = new Map([['BDMVService', [join(tmpBase, 'Search', 'SearchVC.m')]]]);

      const result = await analyzer.analyze(moduleFiles);

      expect(
        result.edges.find((e) => e.from === 'BDMVService' && e.to === 'BDMVService')
      ).toBeUndefined();
    });

    it('should skip import inference for modules that already have DB edges', async () => {
      const analyzer = makeAnalyzer([
        {
          from_id: 'Search',
          from_type: 'module',
          to_id: 'CoreLib',
          to_type: 'module',
          relation: 'depends_on',
        },
      ]);

      const moduleFiles = new Map([
        ['Search', [join(tmpBase, 'Search', 'SearchVC.m')]],
        ['CoreLib', ['/test/CoreLib/core.m']],
        ['BDMVService', ['/test/BDMVService/Service.m']],
      ]);

      const result = await analyzer.analyze(moduleFiles);

      // Should have CoreLib edge from DB
      expect(result.edges.find((e) => e.from === 'Search' && e.to === 'CoreLib')).toBeDefined();
      // Should NOT have BDMVService edge from import inference (skipped because module has DB edges)
      expect(
        result.edges.find((e) => e.from === 'Search' && e.to === 'BDMVService')
      ).toBeUndefined();
    });

    it('should ignore imports targeting unknown modules', async () => {
      const analyzer = makeAnalyzer();

      const moduleFiles = new Map([['Search', [join(tmpBase, 'Search', 'SearchVC.m')]]]);

      const result = await analyzer.analyze(moduleFiles);

      expect(result.edges).toHaveLength(0);
    });

    it('should skip non-source files during import scanning', async () => {
      const analyzer = makeAnalyzer();

      const moduleFiles = new Map([
        ['Search', [join(tmpBase, 'Search', 'readme.md')]],
        ['BDMVService', ['/test/BDMVService/Service.m']],
      ]);

      const result = await analyzer.analyze(moduleFiles);

      expect(result.edges).toHaveLength(0);
    });

    /* ─── Multi-language import tests ────────────────── */

    it('should infer deps from Java import statements', async () => {
      const analyzer = makeAnalyzer();

      const moduleFiles = new Map([
        ['UserService', [join(tmpBase, 'UserService', 'UserController.java')]],
        ['retrofit2', ['/test/retrofit2/Retrofit.java']],
        ['okhttp3', ['/test/okhttp3/Client.java']],
        ['auth', ['/test/auth/AuthManager.java']],
      ]);

      const result = await analyzer.analyze(moduleFiles);

      expect(
        result.edges.find((e) => e.from === 'UserService' && e.to === 'retrofit2')
      ).toBeDefined();
      expect(
        result.edges.find((e) => e.from === 'UserService' && e.to === 'okhttp3')
      ).toBeDefined();
      expect(result.edges.find((e) => e.from === 'UserService' && e.to === 'auth')).toBeDefined();
    });

    it('should infer deps from TypeScript/JS import and require', async () => {
      const analyzer = makeAnalyzer();

      const moduleFiles = new Map([
        ['WebApp', [join(tmpBase, 'WebApp', 'index.ts')]],
        ['express', ['/test/express/index.js']],
        ['prisma', ['/test/prisma/index.js']],
        ['lodash', ['/test/lodash/index.js']],
      ]);

      const result = await analyzer.analyze(moduleFiles);

      expect(result.edges.find((e) => e.from === 'WebApp' && e.to === 'express')).toBeDefined();
      expect(result.edges.find((e) => e.from === 'WebApp' && e.to === 'prisma')).toBeDefined();
      expect(result.edges.find((e) => e.from === 'WebApp' && e.to === 'lodash')).toBeDefined();
    });

    it('should infer deps from Go import statements', async () => {
      const analyzer = makeAnalyzer();

      const moduleFiles = new Map([
        ['GoHandler', [join(tmpBase, 'GoHandler', 'handler.go')]],
        ['gin', ['/test/gin/gin.go']],
        ['auth', ['/test/auth/auth.go']],
      ]);

      const result = await analyzer.analyze(moduleFiles);

      expect(result.edges.find((e) => e.from === 'GoHandler' && e.to === 'gin')).toBeDefined();
      expect(result.edges.find((e) => e.from === 'GoHandler' && e.to === 'auth')).toBeDefined();
    });

    it('should infer deps from Rust use/extern crate', async () => {
      const analyzer = makeAnalyzer();

      const moduleFiles = new Map([
        ['RustService', [join(tmpBase, 'RustService', 'main.rs')]],
        ['tokio', ['/test/tokio/lib.rs']],
        ['serde', ['/test/serde/lib.rs']],
        ['diesel', ['/test/diesel/lib.rs']],
      ]);

      const result = await analyzer.analyze(moduleFiles);

      expect(result.edges.find((e) => e.from === 'RustService' && e.to === 'tokio')).toBeDefined();
      expect(result.edges.find((e) => e.from === 'RustService' && e.to === 'serde')).toBeDefined();
      expect(result.edges.find((e) => e.from === 'RustService' && e.to === 'diesel')).toBeDefined();
    });

    it('should infer deps from Python import/from', async () => {
      const analyzer = makeAnalyzer();

      const moduleFiles = new Map([
        ['PyModule', [join(tmpBase, 'PyModule', 'views.py')]],
        ['requests', ['/test/requests/__init__.py']],
        ['sqlalchemy', ['/test/sqlalchemy/__init__.py']],
        ['auth', ['/test/auth/__init__.py']],
      ]);

      const result = await analyzer.analyze(moduleFiles);

      expect(result.edges.find((e) => e.from === 'PyModule' && e.to === 'requests')).toBeDefined();
      expect(
        result.edges.find((e) => e.from === 'PyModule' && e.to === 'sqlalchemy')
      ).toBeDefined();
      expect(result.edges.find((e) => e.from === 'PyModule' && e.to === 'auth')).toBeDefined();
    });

    it('should infer deps from C# using statements', async () => {
      const analyzer = makeAnalyzer();

      const moduleFiles = new Map([
        ['CSharpMod', [join(tmpBase, 'CSharpMod', 'Service.cs')]],
        ['Newtonsoft', ['/test/Newtonsoft/Json.cs']],
        ['MyProject', ['/test/MyProject/Auth.cs']],
      ]);

      const result = await analyzer.analyze(moduleFiles);

      expect(
        result.edges.find((e) => e.from === 'CSharpMod' && e.to === 'Newtonsoft')
      ).toBeDefined();
      expect(
        result.edges.find((e) => e.from === 'CSharpMod' && e.to === 'MyProject')
      ).toBeDefined();
      // System namespace should NOT create edge (no module named System in map)
      expect(result.edges.find((e) => e.to === 'System')).toBeUndefined();
    });
  });
});
