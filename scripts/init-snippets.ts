#!/usr/bin/env node

/**
 * Snippet 统一初始化脚本
 *
 * 为 AutoSnippet 生成快速触发 Snippet（ass/asc/asa）到目标 IDE:
 *   - Xcode: ~/Library/Developer/Xcode/UserData/CodeSnippets/*.codesnippet
 *   - VSCode: .vscode/autosnippet-triggers.code-snippets (项目级)
 *
 * 用法:
 *   node scripts/init-snippets.js [init|list|remove] [--target xcode|vscode|all]
 *   npm run init:snippets
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ─── Trigger Snippet 定义 (IDE 无关) ─────────────────────

const TRIGGER_SNIPPETS = [
  {
    id: 'com.autosnippet.search.long',
    shortcut: 'ass',
    title: 'AutoSnippet: Search (Long)',
    summary: 'Search and insert Recipe/Snippet from knowledge base',
    xcodeContent: '// as:search <#keyword#>',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: VSCode snippet placeholder syntax
    vscodeBody: ['// as:search ${1:keyword}'],
  },
  {
    id: 'com.autosnippet.create',
    shortcut: 'asc',
    title: 'AutoSnippet: Create Recipe',
    summary: 'Create new Recipe (Dashboard or clipboard/file)',
    xcodeContent: '// as:create <#-c or -f#>',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: VSCode snippet placeholder syntax
    vscodeBody: ['// as:create ${1:-c or -f}'],
  },
  {
    id: 'com.autosnippet.audit',
    shortcut: 'asa',
    title: 'AutoSnippet: Audit Code',
    summary: 'AI code review against knowledge base',
    xcodeContent: '// as:audit <#keyword or scope (file/target/project)#>',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: VSCode snippet placeholder syntax
    vscodeBody: ['// as:audit ${1:keyword or scope (file/target/project)}'],
  },
];

// ─── Xcode 初始化器 ─────────────────────

class XcodeInitializer {
  snippetsDir: any;
  constructor() {
    this.snippetsDir = path.join(os.homedir(), 'Library/Developer/Xcode/UserData/CodeSnippets');
  }

  isAvailable() {
    if (process.platform !== 'darwin') {
      return false;
    }
    try {
      execSync('xcode-select -p', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  ensureDir() {
    if (!fs.existsSync(this.snippetsDir)) {
      try {
        fs.mkdirSync(this.snippetsDir, { recursive: true });
        return true;
      } catch {
        return false;
      }
    }
    return true;
  }

  generatePlist(snippet: any) {
    const escapeXml = (s: any) =>
      String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>IDECodeSnippetCompletionPrefix</key>
  <string>${escapeXml(snippet.shortcut)}</string>
  <key>IDECodeSnippetCompletionScopes</key>
  <array>
    <string>All</string>
  </array>
  <key>IDECodeSnippetContents</key>
  <string>${escapeXml(snippet.xcodeContent)}</string>
  <key>IDECodeSnippetIdentifier</key>
  <string>${escapeXml(snippet.id)}</string>
  <key>IDECodeSnippetLanguage</key>
  <string>Xcode.SourceCodeLanguage.Generic</string>
  <key>IDECodeSnippetSummary</key>
  <string>${escapeXml(snippet.summary)}</string>
  <key>IDECodeSnippetTitle</key>
  <string>${escapeXml(snippet.title)}</string>
  <key>IDECodeSnippetUserSnippet</key>
  <true/>
  <key>IDECodeSnippetVersion</key>
  <integer>2</integer>
</dict>
</plist>`;
  }

  init() {
    if (!this.isAvailable()) {
      return { skipped: true, reason: 'Xcode not available' };
    }
    if (!this.ensureDir()) {
      return { skipped: true, reason: 'Cannot create snippets dir' };
    }

    let count = 0;
    for (const snippet of TRIGGER_SNIPPETS) {
      const filePath = path.join(this.snippetsDir, `${snippet.id}.codesnippet`);
      fs.writeFileSync(filePath, this.generatePlist(snippet), 'utf-8');
      count++;
    }
    return { success: true, count };
  }

  list() {
    if (!fs.existsSync(this.snippetsDir)) {
      return [];
    }
    return fs
      .readdirSync(this.snippetsDir)
      .filter((f) => f.startsWith('com.autosnippet') && f.endsWith('.codesnippet'));
  }

  remove() {
    const files = this.list();
    let removed = 0;
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(this.snippetsDir, f));
        removed++;
      } catch {
        /* ignore */
      }
    }
    return { removed };
  }
}

// ─── VSCode 初始化器 ─────────────────────

class VSCodeInitializer {
  filename: any;
  projectRoot: any;
  vscodeDir: any;
  constructor(projectRoot: any) {
    this.projectRoot = projectRoot || process.cwd();
    this.vscodeDir = path.join(this.projectRoot, '.vscode');
    this.filename = 'autosnippet-triggers.code-snippets';
  }

  isAvailable() {
    // VSCode snippets 跨平台可用
    return true;
  }

  ensureDir() {
    if (!fs.existsSync(this.vscodeDir)) {
      try {
        fs.mkdirSync(this.vscodeDir, { recursive: true });
        return true;
      } catch {
        return false;
      }
    }
    return true;
  }

  init() {
    if (!this.ensureDir()) {
      return { skipped: true, reason: 'Cannot create .vscode dir' };
    }

    const bundle: Record<string, any> = {};
    for (const snippet of TRIGGER_SNIPPETS) {
      bundle[snippet.title] = {
        prefix: snippet.shortcut,
        body: snippet.vscodeBody,
        description: snippet.summary,
      };
    }

    const filePath = path.join(this.vscodeDir, this.filename);
    fs.writeFileSync(filePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
    return { success: true, count: TRIGGER_SNIPPETS.length, path: filePath };
  }

  list() {
    const filePath = path.join(this.vscodeDir, this.filename);
    if (!fs.existsSync(filePath)) {
      return [];
    }
    try {
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return Object.keys(content);
    } catch {
      return [];
    }
  }

  remove() {
    const filePath = path.join(this.vscodeDir, this.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return { removed: 1 };
    }
    return { removed: 0 };
  }
}

// ─── 统一入口 ─────────────────────

export class SnippetInitializer {
  vscode: any;
  xcode: any;
  constructor(projectRoot: any) {
    this.xcode = new XcodeInitializer();
    this.vscode = new VSCodeInitializer(projectRoot);
  }

  /**
   * 初始化 snippet 到指定目标
   * @param {string} target — 'xcode' | 'vscode' | 'all'
   * @returns {{ xcode?: object, vscode?: object }}
   */
  async initialize(target = 'all') {
    const result: any = {};

    if (target === 'all' || target === 'xcode') {
      result.xcode = this.xcode.init();
    }
    if (target === 'all' || target === 'vscode') {
      result.vscode = this.vscode.init();
    }

    return result;
  }

  list(target = 'all') {
    const result: any = {};
    if (target === 'all' || target === 'xcode') {
      result.xcode = this.xcode.list();
    }
    if (target === 'all' || target === 'vscode') {
      result.vscode = this.vscode.list();
    }
    return result;
  }

  remove(target = 'all') {
    const result: any = {};
    if (target === 'all' || target === 'xcode') {
      result.xcode = this.xcode.remove();
    }
    if (target === 'all' || target === 'vscode') {
      result.vscode = this.vscode.remove();
    }
    return result;
  }
}

// 导出供其他脚本使用
export default {
  SnippetInitializer,
  initialize: async (projectRoot: any, target: any) => {
    const init = new SnippetInitializer(projectRoot);
    return init.initialize(target);
  },
};

// ─── CLI 入口 ─────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args.find((a) => !a.startsWith('-')) || 'init';
  const targetFlag = args.find((a) => a.startsWith('--target='));
  const target = targetFlag ? targetFlag.split('=')[1] : 'all';

  const init = new SnippetInitializer(process.cwd());

  switch (command) {
    case 'init': {
      const _result = await init.initialize(target);
      break;
    }
    case 'list': {
      const _result = init.list(target);
      break;
    }
    case 'remove': {
      const _result = init.remove(target);
      break;
    }
    case 'help':
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error('❌ 初始化失败:', err.message);
    process.exit(1);
  });
}
