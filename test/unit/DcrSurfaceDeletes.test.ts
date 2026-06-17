/**
 * Train B DCR deletion proofs (DCR7 standard).
 *
 * P0 all-delete verdicts with controller-verified zero external consumers:
 *   - resident tool alembic_enrich_candidates
 *   - resident tool alembic_wiki
 *   - HTTP route POST /candidates/enrich (provider contract row I22)
 *
 * These negatives keep the deletes regression-proof: a reintroduced schema
 * binding, contract row, or route layer fails this suite. (The unbound
 * resident MCP tool registry these once also checked was deleted in GD2/B1;
 * the live served surface is the TOOL_SCHEMAS schema map.)
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  ALEMBIC_PROVIDER_ROUTE_CONTRACTS,
  ALEMBIC_PROVIDER_ROUTE_MOUNTS,
} from '../../lib/http/provider-contracts.js';
import candidatesRouter from '../../lib/http/routes/candidates.js';
import { TOOL_SCHEMAS } from '../../lib/shared/schemas/mcp-tools.js';

const repoRoot = process.cwd();
const DELETED_TOOLS = ['alembic_enrich_candidates', 'alembic_wiki'];

describe('DCR surface deletes (Train B)', () => {
  test('schema-map negative: deleted tools have no schema binding', () => {
    for (const deleted of DELETED_TOOLS) {
      expect(TOOL_SCHEMAS[deleted]).toBeUndefined();
    }
  });

  test('route-negative: POST /candidates/enrich is gone from contracts and mounts', () => {
    const contractHit = ALEMBIC_PROVIDER_ROUTE_CONTRACTS.find(
      (contract) => contract.path === '/candidates/enrich'
    );
    expect(contractHit).toBeUndefined();
    const mountHit = ALEMBIC_PROVIDER_ROUTE_MOUNTS.find((mount) =>
      String(mount.path ?? '').includes('/candidates/enrich')
    );
    expect(mountHit).toBeUndefined();
  });

  test('route-negative: candidates router no longer registers an /enrich handler', () => {
    // Statically imported above: the express route module graph is heavy, and
    // loading it inside the test body flaked on the 10s timeout under
    // parallel-suite + cross-window load.
    const router = candidatesRouter;
    const layerPaths: string[] = [];
    for (const layer of router.stack ?? []) {
      if (layer.route?.path) {
        layerPaths.push(String(layer.route.path));
      }
    }
    expect(layerPaths.length).toBeGreaterThan(0);
    expect(layerPaths).not.toContain('/enrich');
  });

  test('handler-export negative: resident candidate handler surface is deleted (RIC-3)', () => {
    // RIC-3 (B1) deleted the whole lib/resident/ MCP-mirror layer, so the
    // enrichCandidates handler and its candidate.ts host no longer exist at all.
    expect(existsSync(join(repoRoot, 'lib/resident/tool-handlers/candidate.ts'))).toBe(false);
    expect(existsSync(join(repoRoot, 'lib/resident'))).toBe(false);
  });
});
