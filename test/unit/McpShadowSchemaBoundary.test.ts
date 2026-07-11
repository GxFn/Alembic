import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = process.cwd();

describe('Codex MCP schema ownership boundary', () => {
  test('Alembic does not ship a shadow Codex MCP schema map', () => {
    expect(existsSync(join(repoRoot, 'lib/shared/schemas/mcp-tools.ts'))).toBe(false);
  });
});
