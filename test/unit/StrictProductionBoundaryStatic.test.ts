import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

describe('strict production main-chain boundary', () => {
  it('branches before legacy Plan/fullReset and remains under the existing Facade/ColdStart entry', async () => {
    const facade = await source('lib/recipe-pipeline/RecipePipelineFacade.ts');
    const coldStart = await source('lib/recipe-pipeline/generate/ColdStartWorkflow.ts');

    expect(facade.indexOf('parseStrictProductionRequest')).toBeLessThan(
      facade.indexOf('runGeneratePlanGate(options)')
    );
    expect(coldStart.indexOf('if (args.strictProduction)')).toBeLessThan(
      coldStart.indexOf('createColdStartIntent(args)')
    );
    expect(coldStart.indexOf('if (args.strictProduction)')).toBeLessThan(
      coldStart.indexOf('await runFullResetPolicy(')
    );
    expect(facade).toContain('asyncFill: false');
  });

  it('uses only public Core/Agent facades and wires the required production receipts', async () => {
    const strictRoot = path.join(ROOT, 'lib/recipe-pipeline/generate/strict');
    const files = (await fsp.readdir(strictRoot)).filter((file) => file.endsWith('.ts'));
    const combined = (
      await Promise.all(files.map((file) => fsp.readFile(path.join(strictRoot, file), 'utf8')))
    ).join('\n');

    expect(combined).not.toMatch(/@alembic\/(?:agent|core)\/src\//u);
    for (const publicCall of [
      'runStrictPlanAgent',
      'compileColdStartPlan',
      'createStrictAnalysisFixpointV1',
      'createStrictProducerExpressionSetV1',
      'IndependentValueReviewer',
      'initializePrivateCorpusRevisionV1',
      'rehydratePrivateCorpusRevisionV1',
      'persistPreparedReviewedCandidate',
      'createCandidateCoverageReceiptV1',
      'createFinalCoverageBindingReceiptV1',
      'createServingSnapshotManifestV1',
      'preparePublicKnowledgeRouteV1',
      'commitPreparedPublicRoute',
    ]) {
      expect(combined).toContain(publicCall);
    }
  });

  it('keeps generic success/fallback tokens out of the strict implementation', async () => {
    const strictRoot = path.join(ROOT, 'lib/recipe-pipeline/generate/strict');
    const files = (await fsp.readdir(strictRoot)).filter((file) => file.endsWith('.ts'));
    const combined = (
      await Promise.all(files.map((file) => fsp.readFile(path.join(strictRoot, file), 'utf8')))
    ).join('\n');

    expect(combined).not.toContain('completed_with_errors');
    expect(combined).not.toContain('runFullResetPolicy');
    expect(combined).not.toContain('runPlanAgent');
    expect(combined).not.toContain('setImmediate');
    expect(combined).not.toContain('skipAsyncFill');
  });
});

function source(relativePath: string): Promise<string> {
  return fsp.readFile(path.join(ROOT, relativePath), 'utf8');
}
