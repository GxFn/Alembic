/**
 * asd_panorama MCP Handler — 单元测试
 */
import { describe, expect, it } from 'vitest';
import { panoramaHandler } from '../../lib/external/mcp/handlers/panorama.js';

/* ─── Mock PanoramaService ──────────────────────────── */

function makeMockPanoramaService() {
  return {
    async ensureData() {},
    getOverview() {
      return {
        projectRoot: '/test',
        moduleCount: 3,
        layerCount: 2,
        totalFiles: 42,
        totalRecipes: 10,
        overallCoverage: 0.24,
        layers: [
          {
            level: 0,
            name: 'Foundation',
            modules: [{ name: 'Core', role: 'core', fileCount: 15, recipeCount: 5 }],
          },
          {
            level: 1,
            name: 'UI',
            modules: [{ name: 'UIKit', role: 'ui', fileCount: 27, recipeCount: 5 }],
          },
        ],
        cycleCount: 1,
        gapCount: 2,
        healthRadar: {
          dimensions: [],
          overallScore: 30,
          totalRecipes: 10,
          coveredDimensions: 3,
          totalDimensions: 11,
          dimensionCoverage: 0.27,
        },
        computedAt: Date.now(),
        stale: false,
      };
    },
    getModule(name: string) {
      if (name === 'Core') {
        return {
          module: {
            name: 'Core',
            inferredRole: 'core',
            refinedRole: 'core',
            roleConfidence: 0.95,
            layer: 0,
            fanIn: 10,
            fanOut: 2,
            files: ['a.ts', 'b.ts'],
            fileCount: 2,
            recipeCount: 1,
            coverageRatio: 0.5,
          },
          layerName: 'Foundation',
          neighbors: [{ name: 'UIKit', direction: 'in' as const, weight: 3 }],
          fileGroups: [{ group: '(root)', files: ['a.ts', 'b.ts'], count: 2 }],
          recipes: [{ id: 'r1', title: 'Core Pattern', trigger: '@core', kind: 'pattern' }],
          uncoveredFileCount: 0,
          summary:
            'Core is a Foundation layer module (role: core, confidence: 95%). Contains 2 files in 1 groups: (root)(2). Used by: UIKit. Knowledge coverage: 1 recipes matched, 50% estimated coverage.',
        };
      }
      return null;
    },
    getGaps() {
      return [
        {
          dimension: 'error-handling',
          dimensionName: '错误处理',
          recipeCount: 0,
          status: 'missing',
          priority: 'high',
          suggestedTopics: ['exception-pattern'],
          affectedRoles: ['service'],
        },
        {
          dimension: 'concurrency',
          dimensionName: '并发与线程',
          recipeCount: 1,
          status: 'weak',
          priority: 'medium',
          suggestedTopics: ['thread-safety'],
          affectedRoles: [],
        },
      ];
    },
    getHealth() {
      return {
        healthRadar: {
          dimensions: [],
          overallScore: 30,
          totalRecipes: 10,
          coveredDimensions: 3,
          totalDimensions: 11,
          dimensionCoverage: 0.27,
        },
        avgCoupling: 6.5,
        cycleCount: 1,
        gapCount: 2,
        highPriorityGaps: 1,
        moduleCount: 3,
        healthScore: 62,
      };
    },
  };
}

function makeCtx(hasPanorama: boolean) {
  const panoramaService = hasPanorama ? makeMockPanoramaService() : undefined;
  return {
    container: {
      get(name: string) {
        if (name === 'panoramaService') {
          return panoramaService;
        }
        return undefined;
      },
    },
  };
}

/* ─── Tests ────────────────────────────────────────── */

describe('asd_panorama', () => {
  describe('overview', () => {
    it('returns project overview with layers and modules', async () => {
      const result = (await panoramaHandler(makeCtx(true), { operation: 'overview' })) as Record<
        string,
        unknown
      >;
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.moduleCount).toBe(3);
      expect(data.layerCount).toBe(2);
      expect(data.totalFiles).toBe(42);
      expect(Array.isArray(data.layers)).toBe(true);
    });

    it('defaults to overview when no operation given', async () => {
      const result = (await panoramaHandler(makeCtx(true), {})) as Record<string, unknown>;
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.moduleCount).toBe(3);
    });
  });

  describe('module', () => {
    it('returns module detail with neighbors and enriched data', async () => {
      const result = (await panoramaHandler(makeCtx(true), {
        operation: 'module',
        module: 'Core',
      })) as Record<string, unknown>;
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect((data.module as Record<string, unknown>).name).toBe('Core');
      expect(data.layerName).toBe('Foundation');
      expect(Array.isArray(data.neighbors)).toBe(true);
      expect(Array.isArray(data.fileGroups)).toBe(true);
      expect(Array.isArray(data.recipes)).toBe(true);
      expect(typeof data.summary).toBe('string');
      expect(typeof data.uncoveredFileCount).toBe('number');
    });

    it('fails when module param is missing', async () => {
      const result = (await panoramaHandler(makeCtx(true), { operation: 'module' })) as Record<
        string,
        unknown
      >;
      expect(result.success).toBe(false);
      expect(result.message).toContain('module');
    });

    it('fails when module not found', async () => {
      const result = (await panoramaHandler(makeCtx(true), {
        operation: 'module',
        module: 'NonExistent',
      })) as Record<string, unknown>;
      expect(result.success).toBe(false);
      expect(result.message).toContain('NonExistent');
    });
  });

  describe('gaps', () => {
    it('returns knowledge gaps list', async () => {
      const result = (await panoramaHandler(makeCtx(true), { operation: 'gaps' })) as Record<
        string,
        unknown
      >;
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      const gaps = data.gaps as Array<Record<string, unknown>>;
      expect(gaps).toHaveLength(2);
      expect(gaps[0].dimension).toBe('error-handling');
      expect(gaps[0].priority).toBe('high');
    });
  });

  describe('health', () => {
    it('returns health metrics with healthScore', async () => {
      const result = (await panoramaHandler(makeCtx(true), { operation: 'health' })) as Record<
        string,
        unknown
      >;
      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.healthScore).toBe(62);
      expect(data.healthScore).toBe(62);
      expect(data.cycleCount).toBe(1);
    });
  });

  describe('error handling', () => {
    it('returns error when panoramaService not available', async () => {
      const result = (await panoramaHandler(makeCtx(false), { operation: 'overview' })) as Record<
        string,
        unknown
      >;
      expect(result.success).toBe(false);
      expect(result.message).toContain('not initialized');
    });

    it('throws on unknown operation', async () => {
      await expect(panoramaHandler(makeCtx(true), { operation: 'unknown' })).rejects.toThrow(
        'Unknown panorama operation'
      );
    });
  });
});
