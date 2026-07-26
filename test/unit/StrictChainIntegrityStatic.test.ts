import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

async function read(relativePath: string): Promise<string> {
  return fsp.readFile(path.join(ROOT, relativePath), 'utf8');
}

describe('strict cold-start chain integrity', () => {
  it('routes every frozen fact obligation through the accepted Core executor', async () => {
    const source = [
      await read('lib/recipe-pipeline/generate/strict/StrictAnalysisRuntime.ts'),
      await read('lib/recipe-pipeline/generate/strict/StrictFactExecutionRuntime.ts'),
    ].join('\n');

    expect(source).toContain('executeStrictFactScheduleV1');
    expect(source).not.toContain('function scanFrozenFamily(');
    expect(source).not.toContain('const primary = files[0]');
    expect(source).not.toContain('.slice(0, 256)');
  });

  it('keeps the Agent expansion port open across typed analysis epochs', async () => {
    const source = await read('lib/recipe-pipeline/generate/strict/StrictAnalysisRuntime.ts');

    expect(source).toContain('analysisLimits:');
    expect(source).toContain('expansionPort:');
    expect(source).toContain('readAnalysisEpoch()');
    expect(source.indexOf('validateAnalystResult')).toBeLessThan(
      source.indexOf('expansionPort.seal()')
    );
  });

  it('runs admission and independent G2 review inside the serial private-corpus loop', async () => {
    const analysis = await read('lib/recipe-pipeline/generate/strict/StrictAnalysisRuntime.ts');
    const corpus = await read('lib/recipe-pipeline/generate/strict/StrictPrivateCorpusRuntime.ts');

    expect(analysis).not.toContain('IndependentValueReviewer');
    expect(corpus).toContain('.admitCandidate(');
    expect(corpus).toContain('createStrictG2ReceiptV1');
    expect(corpus).toContain('zeroDisposition');
  });

  it('uses the Core canonical collision-safe publication snapshot id contract', async () => {
    const source = await read('lib/recipe-pipeline/generate/strict/StrictFinalizationRuntime.ts');

    expect(source).toContain('createStrictPublicationSnapshotIdV1');
    expect(source).not.toContain('input.baseSnapshotId');
  });
});
