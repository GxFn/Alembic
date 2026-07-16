import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

describe('strict production main-chain boundary', () => {
  it('wires both supported server launchers through the executable startup-action boundary', async () => {
    const [daemonServer, apiServer] = await Promise.all([
      source('bin/daemon-server.ts'),
      source('bin/api-server.ts'),
    ]);

    expect(daemonServer).toContain('initializeServerRuntime(appRuntime)');
    expect(apiServer).toContain('initializeServerRuntime(appRuntime)');
  });

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

  it('engages the external setup authority before config/logger/database writes on every AppRuntime entry', async () => {
    const bootstrap = await source('lib/Bootstrap.ts');
    const initializeBody = bootstrap.slice(
      bootstrap.indexOf('async initialize()'),
      bootstrap.indexOf('/** 加载工作区设置')
    );
    const databaseBody = bootstrap.slice(
      bootstrap.indexOf('async initializeDatabase()'),
      bootstrap.indexOf('/** 初始化核心组件')
    );

    expect(initializeBody.indexOf('this.initializeWorkspaceResolver()')).toBeLessThan(
      initializeBody.indexOf('await this.initializeStrictExternalSetup()')
    );
    expect(initializeBody.indexOf('await this.initializeStrictExternalSetup()')).toBeLessThan(
      initializeBody.indexOf('await this.loadConfig()')
    );
    expect(initializeBody).toContain('if (!(await this.initializeStrictExternalSetup()))');
    expect(initializeBody.indexOf('return this.components')).toBeLessThan(
      initializeBody.indexOf('await this.loadConfig()')
    );
    expect(databaseBody.indexOf('await db.connect()')).toBeLessThan(
      databaseBody.indexOf('await executeStrictExternalSetupReset')
    );
    expect(databaseBody.indexOf('await executeStrictExternalSetupReset')).toBeLessThan(
      databaseBody.indexOf('await db.runMigrations()')
    );
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

  it('keeps Plugin ownership, candidate readers, and retired oracle semantics out of Main', async () => {
    const strictRoot = path.join(ROOT, 'lib/recipe-pipeline/generate/strict');
    const files = (await fsp.readdir(strictRoot)).filter((file) => file.endsWith('.ts'));
    const combined = (
      await Promise.all(files.map((file) => fsp.readFile(path.join(strictRoot, file), 'utf8')))
    ).join('\n');

    for (const forbidden of [
      ['@alembic', 'plugin'].join('/'),
      'AlembicPlugin',
      'EmbeddedToolExecutor',
      'ToolExecutionContext',
      'CandidatePublicationHandle',
      'candidateReader',
      'privateSnapshotResolver',
      'rootOverride',
      'pathOverride',
      'StrictCandidateOracleV1',
      'runCandidateFiveToolOracle',
      'candidateOracleHash',
      'CANDIDATE_ORACLE_PASSED',
      'candidateHandle',
    ]) {
      expect(combined).not.toContain(forbidden);
    }
  });
});

function source(relativePath: string): Promise<string> {
  return fsp.readFile(path.join(ROOT, relativePath), 'utf8');
}
