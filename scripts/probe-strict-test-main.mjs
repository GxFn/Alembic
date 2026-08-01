import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-strict-test-probe-'));
const outputPath = path.join(outputDirectory, 'result.json');

try {
  const result = spawnSync(
    path.join(process.cwd(), 'node_modules/.bin/vitest'),
    [
      'run',
      'test/integration/StrictTestDimensionPipeline.integration.test.ts',
      '-t',
      'serves real DI',
      '--reporter=dot',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, ALEMBIC_STRICT_TEST_MAIN_PROBE_OUTPUT: outputPath },
    }
  );
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.status ?? 1;
  } else {
    process.stdout.write(fs.readFileSync(outputPath, 'utf8'));
  }
} finally {
  fs.rmSync(outputDirectory, { force: true, recursive: true });
}
