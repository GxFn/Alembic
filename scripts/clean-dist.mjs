#!/usr/bin/env node

import { rmSync } from 'node:fs';
import { join } from 'node:path';

const distRoot = join(import.meta.dirname, '..', 'dist');

rmSync(distRoot, { recursive: true, force: true });
