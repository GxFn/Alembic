/** HeaderHandler — 处理 // as:include / // as:import 指令 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export async function handleHeader(
  watcher: import('../FileWatcher.js').FileWatcher,
  fullPath: string,
  headerLine: string,
  importArray: string[],
  isSwift: boolean
) {
  try {
    const HeaderResolver = await import('../../../platform/ios/xcode/HeaderResolver.js');
    const parsed = HeaderResolver.parseImportLine(headerLine);

    if (!parsed) {
      return;
    }

    const resolved = await HeaderResolver.resolveHeadersForText(
      watcher.projectRoot,
      basename(fullPath),
      readFileSync(fullPath, 'utf8')
    );

    if (!resolved || !resolved.headers || resolved.headers.length === 0) {
      return;
    }

    const { insertHeaders } = await import('../../../platform/ios/xcode/XcodeIntegration.js');
    const result = await insertHeaders(watcher, fullPath, resolved.headers, {
      isSwift,
      moduleName: resolved.moduleName || null,
    });

    if (result.cancelled) {
      return;
    }
    if (result.inserted.length === 0 && result.skipped.length > 0) {
    }
  } catch (err: unknown) {
    console.warn(`  ⚠️ Header 处理失败: ${(err as Error).message}`);
    if (process.env.ASD_DEBUG === '1') {
      console.error((err as Error).stack);
    }
  }
}
