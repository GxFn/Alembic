/**
 * XcodeCodec — Xcode .codesnippet (plist XML) 生成器
 *
 * 从原 SnippetFactory 提取的 Xcode 专用逻辑:
 *   - XML plist 模板
 *   - Xcode 语言 ID 映射
 *   - XML 转义
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { SnippetCodec, type SnippetSpec } from '#service/snippet/codecs/SnippetCodec.js';

const XCODE_LANGUAGE_MAP = {
  swift: 'Xcode.SourceCodeLanguage.Swift',
  'objective-c': 'Xcode.SourceCodeLanguage.Objective-C',
  objc: 'Xcode.SourceCodeLanguage.Objective-C',
  c: 'Xcode.SourceCodeLanguage.C',
  'c++': 'Xcode.SourceCodeLanguage.C-Plus-Plus',
  javascript: 'Xcode.SourceCodeLanguage.JavaScript',
};

const PLIST_TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>IDECodeSnippetCompletionPrefix</key>
\t<string>{completion}</string>
\t<key>IDECodeSnippetCompletionScopes</key>
\t<array>
\t\t<string>All</string>
\t</array>
\t<key>IDECodeSnippetContents</key>
\t<string>{content}</string>
\t<key>IDECodeSnippetIdentifier</key>
\t<string>{identifier}</string>
\t<key>IDECodeSnippetLanguage</key>
\t<string>{language}</string>
\t<key>IDECodeSnippetSummary</key>
\t<string>{summary}</string>
\t<key>IDECodeSnippetTitle</key>
\t<string>{title}</string>
\t<key>IDECodeSnippetUserSnippet</key>
\t<true/>
\t<key>IDECodeSnippetVersion</key>
\t<integer>2</integer>
</dict>
</plist>`;

export class XcodeCodec extends SnippetCodec {
  get id() {
    return 'xcode';
  }

  get fileExtension() {
    return '.codesnippet';
  }

  /** SnippetSpec → plist XML 字符串 */
  generate(spec: SnippetSpec): string {
    if (!spec?.identifier || !spec?.code) {
      throw new Error('Snippet spec must have identifier and code');
    }

    const content = Array.isArray(spec.code) ? spec.code.join('\n') : spec.code;
    const languageKey = this.mapLanguage(spec.language);

    let xml = PLIST_TEMPLATE;
    xml = xml.replace('{identifier}', escapeXml(spec.identifier));
    xml = xml.replace('{title}', escapeXml(spec.title || spec.identifier));
    xml = xml.replace('{completion}', escapeXml(spec.completion || spec.identifier));
    xml = xml.replace('{summary}', escapeXml(spec.summary || ''));
    xml = xml.replace('{content}', escapeXml(content));
    xml = xml.replace('{language}', languageKey);

    return xml;
  }

  /** Xcode: 每个 snippet 一个文件 → 返回 Array<{ filename, content }> */
  generateBundle(specs: SnippetSpec[]): Array<{ filename: string; content: string }> {
    return specs.map((spec: SnippetSpec) => ({
      filename: `${spec.identifier}${this.fileExtension}`,
      content: this.generate(spec),
    }));
  }

  /** Xcode snippets 全局目录 (macOS only) */
  getInstallDir(_projectRoot: string | undefined) {
    return join(homedir(), 'Library/Developer/Xcode/UserData/CodeSnippets');
  }

  mapLanguage(lang: string | undefined) {
    return (
      (XCODE_LANGUAGE_MAP as Record<string, string>)[lang?.toLowerCase() ?? ''] ||
      XCODE_LANGUAGE_MAP.swift
    );
  }
}

/** XML 特殊字符转义 */
function escapeXml(str: string | null | undefined) {
  if (!str) {
    return '';
  }
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
