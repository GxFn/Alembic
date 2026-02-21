/**
 * @module ast/ensure-grammars
 * @description 按需安装缺失的 tree-sitter 语法包
 *
 * 在冷启动检测到项目语言后，检查对应 tree-sitter 包是否已安装，
 * 未安装时自动通过 npm install 补装，然后重新加载 AST 插件。
 *
 * 使用方式:
 *   import { ensureGrammars } from '../core/ast/ensure-grammars.js';
 *   const result = await ensureGrammars(['typescript', 'javascript'], { logger });
 */

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { LanguageService } from '../../shared/LanguageService.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/**
 * 语言 ID → npm 包名映射
 */
const LANG_TO_PACKAGE = {
  objectivec: 'tree-sitter-objc',
  swift: 'tree-sitter-swift',
  typescript: 'tree-sitter-typescript',
  tsx: 'tree-sitter-typescript', // tsx 与 typescript 共用同一个包
  javascript: 'tree-sitter-javascript',
  python: 'tree-sitter-python',
  java: 'tree-sitter-java',
  kotlin: 'tree-sitter-kotlin',
  go: 'tree-sitter-go',
  dart: 'tree-sitter-dart',
};

/**
 * package.json 中声明的版本范围（保持和 optionalDependencies 一致）
 */
const PACKAGE_VERSIONS = {
  'tree-sitter-objc': '^3.0.2',
  'tree-sitter-swift': '^0.7.1',
  'tree-sitter-typescript': '^0.23.2',
  'tree-sitter-javascript': '^0.23.1',
  'tree-sitter-python': '^0.23.5',
  'tree-sitter-java': '^0.23.4',
  'tree-sitter-kotlin': '^0.3.8',
  'tree-sitter-go': '^0.25.0',
  'tree-sitter-dart': '^1.0.0',
};

/**
 * 检测某个 npm 包是否已安装可用
 */
function isPackageInstalled(pkgName) {
  try {
    require.resolve(pkgName);
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取 AutoSnippet 包的安装根目录（npm install 的 cwd）
 */
function getPackageRoot() {
  const thisFile = fileURLToPath(import.meta.url);
  // lib/core/ast/ensure-grammars.js → 向上 3 级到包根
  return path.resolve(path.dirname(thisFile), '..', '..', '..');
}

/**
 * 按需安装缺失的 tree-sitter 语法包
 *
 * @param {string[]} detectedLanguages - 检测到的语言列表 (如 ['typescript', 'javascript', 'python'])
 * @param {object} [options]
 * @param {object} [options.logger] - Logger 实例（可选）
 * @param {number} [options.timeout=60000] - npm install 超时 (ms)
 * @returns {Promise<{installed: string[], skipped: string[], failed: string[], alreadyAvailable: string[]}>}
 */
export async function ensureGrammars(detectedLanguages, options = {}) {
  const { logger, timeout = 60_000 } = options;

  const result = {
    installed: [], // 本次新安装的包
    skipped: [], // 不需要安装（已有）
    failed: [], // 安装失败的包
    alreadyAvailable: [], // 已经可用的语言
  };

  if (!detectedLanguages || detectedLanguages.length === 0) {
    return result;
  }

  // 1) 去重: 多个语言可能映射到同一个包 (如 typescript + tsx → tree-sitter-typescript)
  const neededPackages = new Map(); // pkgName → [langIds]
  for (const lang of detectedLanguages) {
    const pkg = LANG_TO_PACKAGE[lang];
    if (!pkg) {
      continue;
    }
    if (!neededPackages.has(pkg)) {
      neededPackages.set(pkg, []);
    }
    neededPackages.get(pkg).push(lang);
  }

  // 2) 检查哪些已安装
  const toInstall = [];
  for (const [pkg, langs] of neededPackages) {
    if (isPackageInstalled(pkg)) {
      result.skipped.push(pkg);
      result.alreadyAvailable.push(...langs);
    } else {
      toInstall.push(pkg);
    }
  }

  if (toInstall.length === 0) {
    logger?.info?.('[ensure-grammars] All required grammars already installed');
    return result;
  }

  // 3) 批量安装缺失的包
  const pkgRoot = getPackageRoot();
  const installArgs = toInstall.map((pkg) => {
    const ver = PACKAGE_VERSIONS[pkg];
    return ver ? `${pkg}@${ver}` : pkg;
  });

  logger?.info?.(`[ensure-grammars] Installing missing grammars: ${toInstall.join(', ')}`);

  try {
    const { stderr } = await execFileAsync(
      'npm',
      ['install', '--no-save', '--no-audit', '--no-fund', ...installArgs],
      {
        cwd: pkgRoot,
        timeout,
        env: { ...process.env, NODE_ENV: '' }, // 避免 NODE_ENV=production 跳过 optional
      }
    );

    if (stderr && !stderr.includes('npm warn')) {
      logger?.warn?.(`[ensure-grammars] npm stderr: ${stderr.slice(0, 200)}`);
    }

    // 4) 逐个验证安装结果
    for (const pkg of toInstall) {
      // 清除 require cache 以便重新检测
      try {
        delete require.cache[require.resolve(pkg)];
      } catch {
        /* not cached */
      }

      if (isPackageInstalled(pkg)) {
        result.installed.push(pkg);
        const langs = neededPackages.get(pkg) || [];
        result.alreadyAvailable.push(...langs);
        logger?.info?.(`[ensure-grammars] ✓ ${pkg} installed successfully`);
      } else {
        result.failed.push(pkg);
        logger?.warn?.(
          `[ensure-grammars] ✗ ${pkg} install reported success but package not resolvable`
        );
      }
    }
  } catch (err) {
    logger?.warn?.(`[ensure-grammars] npm install failed: ${err.message}`);
    // 批量失败 → 逐个重试
    for (const pkg of toInstall) {
      try {
        const ver = PACKAGE_VERSIONS[pkg];
        const spec = ver ? `${pkg}@${ver}` : pkg;
        await execFileAsync('npm', ['install', '--no-save', '--no-audit', '--no-fund', spec], {
          cwd: pkgRoot,
          timeout: timeout / 2,
        });
        if (isPackageInstalled(pkg)) {
          result.installed.push(pkg);
          const langs = neededPackages.get(pkg) || [];
          result.alreadyAvailable.push(...langs);
          logger?.info?.(`[ensure-grammars] ✓ ${pkg} installed (retry)`);
        } else {
          result.failed.push(pkg);
        }
      } catch {
        result.failed.push(pkg);
        logger?.warn?.(`[ensure-grammars] ✗ ${pkg} install failed permanently`);
      }
    }
  }

  return result;
}

/**
 * 在安装新包后重新加载 AST 插件
 * 由于 loadPlugins() 是幂等的（_loaded 标志），需要重置标志后重新加载
 */
export async function reloadPlugins() {
  // 动态 import 获取模块并重置 _loaded 状态
  const astIndex = await import('./index.js');
  if (typeof astIndex._resetForReload === 'function') {
    astIndex._resetForReload();
  }
  await astIndex.loadPlugins();
}

/**
 * 从文件扩展名统计推断需要的语言列表
 *
 * @param {Record<string, number>} langStats - { swift: 120, m: 80, ts: 200 }
 * @returns {string[]} 需要的语言 ID 列表
 */
export function inferLanguagesFromStats(langStats) {
  // 从 LanguageService 派生，仅覆盖 tsx（tree-sitter 需要独立解析器）
  const bareMap = LanguageService.bareExtToLangMap;

  const langs = new Set();
  for (const ext of Object.keys(langStats)) {
    const lang = ext === 'tsx' ? 'tsx' : bareMap[ext];
    if (lang) {
      langs.add(lang);
    }
  }
  return [...langs];
}
