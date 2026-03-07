#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Bootstrap from '../lib/bootstrap.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 初始化 AutoSnippet 数据库
 */
async function main() {
  try {
    const bootstrap = new Bootstrap({ env: process.env.NODE_ENV || 'development' });
    const components = await bootstrap.initialize();

    // 显示宪法信息
    const _constitutionInfo = components.constitution!.toJSON();

    await bootstrap.shutdown();
    process.exit(0);
  } catch (error: unknown) {
    console.error('\n❌ Initialization failed:', error instanceof Error ? error.message : error);
    console.error(error);
    process.exit(1);
  }
}

main();
