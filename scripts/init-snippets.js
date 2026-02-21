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
    vscodeBody: ['// as:search ${1:keyword}'],
  },
  {
    id: 'com.autosnippet.create',
    shortcut: 'asc',
    title: 'AutoSnippet: Create Recipe',
    summary: 'Create new Recipe (Dashboard or clipboard/file)',
    xcodeContent: '// as:create <#-c or -f#>',
    vscodeBody: ['// as:create ${1:-c or -f}'],
  },
  {
    id: 'com.autosnippet.audit',
    shortcut: 'asa',
    title: 'AutoSnippet: Audit Code',
    summary: 'AI code review against knowledge base',
    xcodeContent: '// as:audit <#keyword or scope (file/target/project)#>',
    vscodeBody: ['// as:audit ${1:keyword or scope (file/target/project)}'],
  },
];

// ─── Xcode 初始化器 ─────────────────────

class XcodeInitializer {
  constructor() {
    this.snippetsDir = path.join(os.homedir(), 'Library/Developer/Xcode/UserData/CodeSnippets');
  }

  isAvailable() {
    if (process.platform !== 'darwin') return false;
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

  generatePlist(snippet) {
    const escape = (s) =>
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
  <string>${escape(snippet.shortcut)}</string>
  <key>IDECodeSnippetCompletionScopes</key>
  <array>
    <string>All</string>
  </array>
  <key>IDECodeSnippetContents</key>
  <string>${escape(snippet.xcodeContent)}</string>
  <key>IDECodeSnippetIdentifier</key>
  <string>${escape(snippet.id)}</string>
  <key>IDECodeSnippetLanguage</key>
  <string>Xcode.SourceCodeLanguage.Generic</string>
  <key>IDECodeSnippetSummary</key>
  <string>${escape(snippet.summary)}</string>
  <key>IDECodeSnippetTitle</key>
  <string>${escape(snippet.title)}</string>
  <key>IDECodeSnippetUserSnippet</key>
  <true/>
  <key>IDECodeSnippetVersion</key>
  <integer>2</integer>
</dict>
</plist>`;
  }

  init() {
    if (!this.isAvailable()) return { skipped: true, reason: 'Xcode not available' };
    if (!this.ensureDir()) return { skipped: true, reason: 'Cannot create snippets dir' };

    let count = 0;
    for (const snippet of TRIGGER_SNIPPETS) {
      const filePath = path.join(this.snippetsDir, `${snippet.id}.codesnippet`);
      fs.writeFileSync(filePath, this.generatePlist(snippet), 'utf-8');
      count++;
    }
    return { success: true, count };
  }

  list() {
    if (!fs.existsSync(this.snippetsDir)) return [];
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
  constructor(projectRoot) {
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
    if (!this.ensureDir()) return { skipped: true, reason: 'Cannot create .vscode dir' };

    const bundle = {};
    for (const snippet of TRIGGER_SNIPPETS) {
      bundle[snippet.title] = {
        prefix: snippet.shortcut,
        body: snippet.vscodeBody,
        description: snippet.summary,
      };
    }

    const filePath = path.join(this.vscodeDir, this.filename);
    fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
    return { success: true, count: TRIGGER_SNIPPETS.length, path: filePath };
  }

  list() {
    const filePath = path.join(this.vscodeDir, this.filename);
    if (!fs.existsSync(filePath)) return [];
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
  constructor(projectRoot) {
    this.xcode = new XcodeInitializer();
    this.vscode = new VSCodeInitializer(projectRoot);
  }

  /**
   * 初始化 snippet 到指定目标
   * @param {string} target — 'xcode' | 'vscode' | 'all'
   * @returns {{ xcode?: object, vscode?: object }}
   */
  async initialize(target = 'all') {
    const result = {};

    if (target === 'all' || target === 'xcode') {
      result.xcode = this.xcode.init();
    }
    if (target === 'all' || target === 'vscode') {
      result.vscode = this.vscode.init();
    }

    return result;
  }

  list(target = 'all') {
    const result = {};
    if (target === 'all' || target === 'xcode') result.xcode = this.xcode.list();
    if (target === 'all' || target === 'vscode') result.vscode = this.vscode.list();
    return result;
  }

  remove(target = 'all') {
    const result = {};
    if (target === 'all' || target === 'xcode') result.xcode = this.xcode.remove();
    if (target === 'all' || target === 'vscode') result.vscode = this.vscode.remove();
    return result;
  }
}

// 导出供其他脚本使用
export default {
  SnippetInitializer,
  initialize: async (projectRoot, target) => {
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
      const result = await init.initialize(target);
      console.log('✅ Snippets initialized:', JSON.stringify(result, null, 2));
      break;
    }
    case 'list': {
      const result = init.list(target);
      console.log('📋 Installed snippets:', JSON.stringify(result, null, 2));
      break;
    }
    case 'remove': {
      const result = init.remove(target);
      console.log('🗑️  Snippets removed:', JSON.stringify(result, null, 2));
      break;
    }
    case 'help':
      console.log(`Usage: init-snippets.js [init|list|remove] [--target=xcode|vscode|all]`);
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
