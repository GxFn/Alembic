/**
 * IC2 Alembic-side drift gate (runs inside npm run check via test:unit):
 * regenerate the Dashboard api-types artifact and byte-compare it with the
 * committed text. Any change to the inputs (Core wire types, failure
 * taxonomy, provider-contracts route table, problem projection) without a
 * regenerated commit fails here.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  DASHBOARD_TYPES_ARTIFACT_RELPATH,
  generateDashboardApiTypes,
} from '../../scripts/generate-dashboard-types.js';

describe('Dashboard api-types drift gate (IC2)', () => {
  test('committed artifact matches regenerated output byte-for-byte', () => {
    const repoRoot = process.cwd();
    const artifactPath = path.join(repoRoot, DASHBOARD_TYPES_ARTIFACT_RELPATH);
    const committed = readFileSync(artifactPath, 'utf8');
    const regenerated = generateDashboardApiTypes(repoRoot);
    expect(committed.length).toBe(regenerated.length);
    expect(committed).toBe(regenerated);
  });
});
