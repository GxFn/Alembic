import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  ALEMBIC_PROVIDER_ROUTE_CONTRACTS,
  ALEMBIC_PROVIDER_ROUTE_MOUNTS,
} from '../../lib/http/provider-contracts.js';
import { TOOL_SCHEMAS } from '../../lib/shared/schemas/mcp-tools.js';

const repoRoot = process.cwd();

describe('Panorama surface deletes (P5)', () => {
  test('route and provider-contract surfaces do not expose Panorama', () => {
    expect(existsSync(join(repoRoot, 'lib/http/routes/panorama.ts'))).toBe(false);
    expect(
      ALEMBIC_PROVIDER_ROUTE_CONTRACTS.some((contract) =>
        String(contract.path).includes('panorama')
      )
    ).toBe(false);
    expect(
      ALEMBIC_PROVIDER_ROUTE_MOUNTS.some((mount) => String(mount.fullPath).includes('panorama'))
    ).toBe(false);
  });

  test('tool schema and legacy direct tests do not keep the retired surface alive', () => {
    expect(TOOL_SCHEMAS.alembic_panorama).toBeUndefined();
    expect(existsSync(join(repoRoot, 'test/helpers/panorama-mocks.ts'))).toBe(false);
    expect(existsSync(join(repoRoot, 'test/integration/PanoramaIntegration.test.ts'))).toBe(false);
    expect(existsSync(join(repoRoot, 'test/unit/CouplingAnalyzer.test.ts'))).toBe(false);
    expect(existsSync(join(repoRoot, 'test/unit/ModuleDiscoverer.test.ts'))).toBe(false);
    expect(existsSync(join(repoRoot, 'test/unit/RoleRefiner.test.ts'))).toBe(false);
  });
});
