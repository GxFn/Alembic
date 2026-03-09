/**
 * SnippetInstaller — Codec 驱动的 Snippet 安装器
 *
 * 支持:
 *   - Xcode: 每个 snippet 一个 .codesnippet 文件
 *   - VSCode: 所有 snippets 合并为单个 .code-snippets JSON 文件
 *
 * 行为由注入的 SnippetCodec 决定。
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { SnippetCodec, SnippetSpec } from './codecs/SnippetCodec.js';
import type { SnippetFactory } from './SnippetFactory.js';

interface RecipeLike {
  id?: string;
  title: string;
  trigger?: string;
  code: string;
  description?: string;
  summary?: string;
  language?: string;
  [key: string]: unknown;
}

interface InstallerOptions {
  codec?: SnippetCodec | null;
  snippetFactory?: SnippetFactory | null;
  snippetsDir?: string | null;
}

export class SnippetInstaller {
  #codec: SnippetCodec | null;
  #snippetFactory: SnippetFactory | null;
  #snippetsDirOverride: string | null;

  /**
   * @param options.codec IDE codec
   * @param [options.snippetsDir] 覆盖 codec 默认目录
   */
  constructor(options: InstallerOptions = {}) {
    this.#codec = options.codec || null;
    this.#snippetFactory = options.snippetFactory || null;
    this.#snippetsDirOverride = options.snippetsDir || null;
  }

  /** codec ID ('xcode' | 'vscode') */
  get target() {
    return this.#codec?.id || 'unknown';
  }

  /** 当前安装目录 */
  get snippetsDir() {
    return this.#snippetsDirOverride || this.#codec?.getInstallDir(process.cwd()) || '';
  }

  setSnippetFactory(factory: SnippetFactory) {
    this.#snippetFactory = factory;
  }

  setCodec(codec: SnippetCodec) {
    this.#codec = codec;
  }

  // ─────────────── 安装 ───────────────

  /**
   * 安装单个 snippet spec
   * @param spec SnippetSpec
   * @param [projectRoot] VSCode 需要 projectRoot 确定 .vscode/ 路径
   * @returns }
   */
  install(spec: SnippetSpec, projectRoot?: string) {
    this.#assertCodec();
    const codec = this.#codec!;
    try {
      const dir = this.#resolveDir(projectRoot);
      this.#ensureDir(dir);

      const bundleFilename = codec.getBundleFilename();
      if (bundleFilename) {
        // Bundle 模式 (VSCode): merge into single JSON file
        return this.#installToBundle(spec, dir, bundleFilename);
      }

      // Per-file 模式 (Xcode): 每个 snippet 一个文件
      const content = codec.generate(spec);
      const filename = `${spec.identifier}${codec.fileExtension}`;
      const filePath = join(dir, filename);
      writeFileSync(filePath, content);
      return { success: true, path: filePath, message: `Installed: ${filename}` };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, path: '', message };
    }
  }

  /**
   * 从 Recipe 批量安装
   * @returns }
   */
  installFromRecipes(recipes: RecipeLike[], projectRoot?: string) {
    this.#assertCodec();
    this.#assertFactory();
    const codec = this.#codec!;
    const factory = this.#snippetFactory!;

    const dir = this.#resolveDir(projectRoot);
    this.#ensureDir(dir);

    const specs = recipes.map((r: RecipeLike) => factory.fromRecipe(r));
    const bundleFilename = codec.getBundleFilename();

    if (bundleFilename) {
      // Bundle 模式: 一次性写入整个 bundle
      return this.#installBundleFromSpecs(specs, dir, bundleFilename, recipes.length);
    }

    // Per-file 模式
    const details: Array<{ success: boolean; path: string; message: string }> = [];
    let successCount = 0;
    let errorCount = 0;

    for (const spec of specs) {
      const result = this.install(spec, projectRoot);
      details.push(result);
      if (result.success) {
        successCount++;
      } else {
        errorCount++;
      }
    }

    return { success: errorCount === 0, count: recipes.length, successCount, errorCount, details };
  }

  // ─────────────── 查询 ───────────────

  /**
   * 列出已安装的 AutoSnippet 管理的 snippet
   * @returns >}
   */
  listInstalled(projectRoot?: string) {
    const dir = this.#resolveDir(projectRoot);
    if (!existsSync(dir)) {
      return [];
    }

    const bundleFilename = this.#codec?.getBundleFilename();
    if (bundleFilename) {
      // VSCode: 检查 bundle 文件是否存在
      const bundlePath = join(dir, bundleFilename);
      if (!existsSync(bundlePath)) {
        return [];
      }
      try {
        const content = JSON.parse(readFileSync(bundlePath, 'utf-8'));
        return Object.keys(content).map((key) => ({
          filename: key,
          path: bundlePath,
        }));
      } catch {
        return [];
      }
    }

    // Xcode: 列出 com.autosnippet.*.codesnippet 文件
    return readdirSync(dir)
      .filter(
        (f) =>
          f.startsWith('com.autosnippet.') &&
          f.endsWith(this.#codec?.fileExtension || '.codesnippet')
      )
      .map((f) => ({ filename: f, path: join(dir, f) }));
  }

  // ─────────────── 卸载 ───────────────

  /**
   * 卸载指定 snippet
   * @returns }
   */
  uninstall(identifier: string, projectRoot?: string) {
    const dir = this.#resolveDir(projectRoot);
    const bundleFilename = this.#codec?.getBundleFilename();

    if (bundleFilename) {
      // VSCode: 从 bundle JSON 中移除对应 key
      return this.#removeFromBundle(identifier, dir, bundleFilename);
    }

    // Xcode: 删除单个文件
    const ext = this.#codec?.fileExtension || '.codesnippet';
    const filename = identifier.endsWith(ext) ? identifier : `${identifier}${ext}`;
    const filePath = join(dir, filename);
    if (!existsSync(filePath)) {
      return { success: false, message: `Not found: ${filename}` };
    }
    unlinkSync(filePath);
    return { success: true, message: `Uninstalled: ${filename}` };
  }

  /**
   * 清除所有 AutoSnippet 管理的 snippet
   * @returns }
   */
  cleanAll(projectRoot?: string) {
    const dir = this.#resolveDir(projectRoot);
    const bundleFilename = this.#codec?.getBundleFilename();

    if (bundleFilename) {
      // VSCode: 删除整个 bundle 文件
      const bundlePath = join(dir, bundleFilename);
      if (existsSync(bundlePath)) {
        unlinkSync(bundlePath);
        return { success: true, removed: 1 };
      }
      return { success: true, removed: 0 };
    }

    // Xcode: 删除所有 com.autosnippet.* 文件
    const installed = this.listInstalled(projectRoot);
    let removed = 0;
    for (const { path: filePath } of installed) {
      try {
        unlinkSync(filePath);
        removed++;
      } catch {
        /* ignore */
      }
    }
    return { success: true, removed };
  }

  // ─────────────── Private ───────────────

  #assertCodec() {
    if (!this.#codec) {
      throw new Error('SnippetCodec not set');
    }
  }

  #assertFactory() {
    if (!this.#snippetFactory) {
      throw new Error('SnippetFactory not set');
    }
  }

  #resolveDir(projectRoot?: string) {
    if (this.#snippetsDirOverride) {
      return this.#snippetsDirOverride;
    }
    return this.#codec?.getInstallDir(projectRoot || process.cwd()) || '';
  }

  #ensureDir(dir: string) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /** VSCode bundle: 将单个 spec 追加/更新到 bundle JSON */
  #installToBundle(spec: SnippetSpec, dir: string, bundleFilename: string) {
    const bundlePath = join(dir, bundleFilename);
    let bundle: Record<string, Record<string, unknown>> = {};
    if (existsSync(bundlePath)) {
      try {
        bundle = JSON.parse(readFileSync(bundlePath, 'utf-8'));
      } catch {
        bundle = {};
      }
    }

    const key = `Recipe: ${spec.title || spec.identifier}`;
    const content = JSON.parse(this.#codec!.generate(spec));
    const entryKey = Object.keys(content)[0];
    bundle[key] = content[entryKey];

    writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
    return { success: true, path: bundlePath, message: `Installed: ${key}` };
  }

  /** VSCode bundle: 一次性写入完整 bundle */
  #installBundleFromSpecs(
    specs: SnippetSpec[],
    dir: string,
    bundleFilename: string,
    totalCount: number
  ) {
    try {
      const content = this.#codec!.generateBundle(specs);
      const bundlePath = join(dir, bundleFilename);
      writeFileSync(
        bundlePath,
        typeof content === 'string' ? content : JSON.stringify(content, null, 2)
      );
      return {
        success: true,
        count: totalCount,
        successCount: totalCount,
        errorCount: 0,
        details: [{ success: true, path: bundlePath, message: `Bundle: ${totalCount} snippets` }],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        count: totalCount,
        successCount: 0,
        errorCount: totalCount,
        details: [{ success: false, path: '', message }],
      };
    }
  }

  /** VSCode bundle: 从 JSON 中移除一个 snippet */
  #removeFromBundle(identifier: string, dir: string, bundleFilename: string) {
    const bundlePath = join(dir, bundleFilename);
    if (!existsSync(bundlePath)) {
      return { success: false, message: `Bundle not found: ${bundleFilename}` };
    }

    try {
      const bundle = JSON.parse(readFileSync(bundlePath, 'utf-8'));
      // 按 identifier 或 title 匹配
      const keyToRemove = Object.keys(bundle).find(
        (k) => k.includes(identifier) || k === `Recipe: ${identifier}`
      );
      if (!keyToRemove) {
        return { success: false, message: `Snippet not found in bundle: ${identifier}` };
      }
      delete bundle[keyToRemove];
      writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
      return { success: true, message: `Uninstalled: ${keyToRemove}` };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, message };
    }
  }
}
