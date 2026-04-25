import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runSafeCommand } from '../../lib/agent/tools/system-interaction.js';

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

  it('blocks shell compound syntax before execution', async () => {
    const result = await runSafeCommand.handler({ command: 'echo ok; echo unsafe' }, {
      projectRoot,
      container: null,
    } as never);

    expect(result).toEqual({ error: expect.stringContaining('shell 复合语法') });
  });

  it('rejects cwd paths that only share the project path prefix', async () => {
    const result = await runSafeCommand.handler({ command: 'pwd', cwd: siblingRoot }, {
      projectRoot,
      container: null,
    } as never);

    expect(result).toEqual({ error: expect.stringContaining('超出项目范围') });
  });
});
