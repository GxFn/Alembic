import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const distDir = join(process.cwd(), 'dist');

await rm(distDir, { force: true, recursive: true });
