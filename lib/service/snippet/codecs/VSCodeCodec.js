/**
 * VSCodeCodec — VSCode .code-snippets (JSON) 生成器
 *
 * 特性:
 *   - 项目级 .vscode/autosnippet.code-snippets 单 bundle 文件
 *   - 兼容 Cursor (100% VSCode snippet 格式)
 *   - Xcode 占位符 <#…#> 自动转换为 VSCode ${N:…}
 *   - 多语言 scope 自动映射
 */

import { join } from 'node:path';
import { PlaceholderConverter } from '../../../platform/ios/snippet/PlaceholderConverter.js';
import { SnippetCodec } from './SnippetCodec.js';

/** AutoSnippet language → VSCode snippet scope */
const VSCODE_LANGUAGE_MAP = {
  swift: 'swift',
  'objective-c': 'objective-c',
  objc: 'objective-c',
  c: 'c',
  'c++': 'cpp',
  go: 'go',
  python: 'python',
  java: 'java',
  kotlin: 'kotlin',
  javascript: 'javascript,javascriptreact',
  typescript: 'typescript,typescriptreact',
  rust: 'rust',
  ruby: 'ruby',
};

const BUNDLE_FILENAME = 'autosnippet.code-snippets';

export class VSCodeCodec extends SnippetCodec {
  get id() {
    return 'vscode';
  }

  get fileExtension() {
    return '.code-snippets';
  }

  /**
   * 单个 SnippetSpec → JSON 字符串
   */
  generate(spec) {
    const entry = this.#specToEntry(spec);
    return JSON.stringify({ [spec.title || spec.identifier]: entry }, null, 2);
  }

  /**
   * VSCode: 所有 snippets 合并为单个 JSON bundle 文件
   * @returns {string} JSON 字符串
   */
  generateBundle(specs) {
    const bundle = {};
    for (const spec of specs) {
      const key = `Recipe: ${spec.title || spec.identifier}`;
      bundle[key] = this.#specToEntry(spec);
    }
    return `${JSON.stringify(bundle, null, 2)}\n`;
  }

  /**
   * VSCode snippets 安装目录 = 项目级 .vscode/
   */
  getInstallDir(projectRoot) {
    return join(projectRoot, '.vscode');
  }

  mapLanguage(lang) {
    return VSCODE_LANGUAGE_MAP[lang?.toLowerCase()] || '';
  }

  getBundleFilename() {
    return BUNDLE_FILENAME;
  }

  /**
   * @private SnippetSpec → VSCode snippet entry
   */
  #specToEntry(spec) {
    const code = Array.isArray(spec.code) ? spec.code.join('\n') : spec.code || '';
    // 自动将 Xcode 占位符转为 VSCode 格式
    const converted = PlaceholderConverter.xcodeToVSCode(code);
    const body = converted.split('\n');

    const entry = {
      prefix: spec.completion || spec.trigger || spec.identifier,
      body,
      description: spec.summary || '',
    };

    // 添加语言 scope (空字符串 = 所有语言)
    const scope = this.mapLanguage(spec.language);
    if (scope) {
      entry.scope = scope;
    }

    return entry;
  }
}
