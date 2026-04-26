import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeProjectFile } from '../../lib/tools/handlers/system-interaction.js';

describe('system-interaction tools', () => {
  let projectRoot: string;
  let siblingRoot: string;

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'alembic-system-tools-'));
    projectRoot = path.join(base, 'app');
    siblingRoot = path.join(base, 'app2');
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(siblingRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(projectRoot), { recursive: true, force: true });
  });

  it('rejects write paths that only share the project path prefix', async () => {
    const result = await writeProjectFile.handler(
      {
        filePath: path.join(siblingRoot, 'outside.txt'),
        content: 'outside',
      },
      {
        projectRoot,
        container: null,
      } as never
    );

    expect(result).toEqual({ error: expect.stringContaining('超出项目范围') });
  });
});
