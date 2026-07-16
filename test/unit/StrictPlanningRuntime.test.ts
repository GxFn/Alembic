import { describe, expect, it } from 'vitest';
import type {
  MainCertifiedProjectFactsCarrier,
  MainCertifiedProjectionPayload,
} from '../../lib/project-facts/CertifiedProjectFactsRuntime.js';
import { buildCertifiedPlanningFacts } from '../../lib/recipe-pipeline/generate/strict/StrictPlanningRuntime.js';

describe('strict certified planning projection', () => {
  it('conserves every certified module and owned file without a top-N/floor projection', () => {
    const projection = fixtureProjection();
    const result = buildCertifiedPlanningFacts(carrier(), projection);

    expect(result.modules).toHaveLength(2);
    expect(result.modules.map((module) => module.moduleId)).toEqual(['api', 'core']);
    expect(result.modules.map((module) => module.ownedProductionFileCount)).toEqual([1, 2]);
    expect(result.modules[0]?.roles).toContain('application');
    expect(result.modules[0]?.frameworks).toContain('express');
    expect(result.modules[1]?.publicSurfaceRefs).toHaveLength(2);
    expect(result.sourceArtifactHash).toBe(carrier().certificationBindingHash);
  });

  it('fails closed when the module ownership projection does not match frozen files', () => {
    const projection = fixtureProjection();
    const apiModule = projection.modules.find((module) => module.moduleId === 'api');
    expect(apiModule).toBeDefined();
    if (!apiModule) {
      throw new Error('fixture api module missing');
    }
    apiModule.ownedFiles = ['src/api/server.ts', 'src/api/missing.ts'];
    expect(() => buildCertifiedPlanningFacts(carrier(), projection)).toThrow(
      'STRICT_PLANNING_MODULE_OWNERSHIP_INCOMPLETE:api'
    );
  });
});

function fixtureProjection(): MainCertifiedProjectionPayload {
  return {
    canonicalScopeHash: sha('scope'),
    consumer: 'recipe-generation',
    requestKinds: [],
    envelopes: [],
    modules: [
      {
        moduleId: 'core',
        moduleName: 'core',
        ownedFiles: ['src/core/index.ts', 'src/core/model.ts'],
        repoId: 'repo-main',
      },
      {
        moduleId: 'api',
        moduleName: 'api',
        ownedFiles: ['src/api/server.ts'],
        repoId: 'repo-main',
      },
    ],
    files: [
      file('src/core/index.ts', 'export { Model } from "./model.js";', ['core']),
      file('src/core/model.ts', 'export class Model {}', ['core']),
      file('src/api/server.ts', 'import express from "express"; export const app = express();', [
        'api',
      ]),
    ],
  };
}

function file(relativePath: string, content: string, moduleIds: string[]) {
  return {
    blobHash: sha(relativePath),
    byteLength: Buffer.byteLength(content),
    contentBase64: Buffer.from(content).toString('base64'),
    language: 'typescript',
    moduleIds,
    relativePath,
    repositoryRelativeRoot: '.',
    repoId: 'repo-main',
  };
}

function carrier(): MainCertifiedProjectFactsCarrier {
  return {
    artifactId: `cpf-v1:${'a'.repeat(64)}`,
    baseReadbackUnchanged: true,
    canonicalScopeHash: sha('scope'),
    certificationBindingHash: sha('binding'),
    counters: {
      cappedModuleProjectionCount: 0,
      directProjectContextCallCount: 0,
      rawFilesystemFallbackCount: 0,
      synthesizedProjectScopeFactCount: 0,
    },
    factsContentHash: sha('facts'),
    instrumentation: [],
    receipts: {},
    sourceVectorHash: sha('source'),
  };
}

function sha(value: string): `sha256:${string}` {
  return `sha256:${Buffer.from(value).toString('hex').padEnd(64, '0').slice(0, 64)}`;
}
