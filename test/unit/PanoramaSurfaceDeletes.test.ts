import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  ALEMBIC_PROVIDER_ROUTE_CONTRACTS,
  ALEMBIC_PROVIDER_ROUTE_MOUNTS,
} from '../../lib/http/provider-contracts.js';

const repoRoot = process.cwd();

describe('Panorama surface boundary', () => {
  test('HTTP route and provider contracts expose only the restored endpoint family', () => {
    expect(existsSync(join(repoRoot, 'lib/http/routes/panorama.ts'))).toBe(true);
    expect(
      ALEMBIC_PROVIDER_ROUTE_CONTRACTS.filter((contract) =>
        String(contract.path).includes('panorama')
      ).map((contract) => `${contract.method} ${contract.path}`)
    ).toEqual(['get /panorama', 'get /panorama/health', 'get /panorama/gaps']);
    expect(
      ALEMBIC_PROVIDER_ROUTE_MOUNTS.filter((mount) =>
        String(mount.fullPath).includes('panorama')
      ).map((mount) => mount.fullPath)
    ).toEqual(['/api/v1/panorama']);
  });

  test('legacy engines and legacy direct tests stay retired', () => {
    expect(existsSync(join(repoRoot, 'lib/service/panorama'))).toBe(false);
    expect(existsSync(join(repoRoot, 'lib/project-facts/PanoramaService.ts'))).toBe(false);
    expect(existsSync(join(repoRoot, 'lib/project-facts/PanoramaAggregator.ts'))).toBe(false);
    expect(existsSync(join(repoRoot, 'test/helpers/panorama-mocks.ts'))).toBe(false);
    expect(existsSync(join(repoRoot, 'test/integration/PanoramaIntegration.test.ts'))).toBe(false);
    expect(existsSync(join(repoRoot, 'test/unit/CouplingAnalyzer.test.ts'))).toBe(false);
    expect(existsSync(join(repoRoot, 'test/unit/ModuleDiscoverer.test.ts'))).toBe(false);
    expect(existsSync(join(repoRoot, 'test/unit/RoleRefiner.test.ts'))).toBe(false);
  });
});
