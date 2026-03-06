#!/usr/bin/env node

/**
 * 从 target 目录生成 Recipe 草稿（非知识库目录）
 * 默认输出到 <projectRoot>/autosnippet-drafts/recipes
 */

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv: any) {
  const args: Record<string, any> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      continue;
    }
    const [k, v] = a.split('=');
    const key = k.replace(/^--/, '');
    if (v !== undefined) {
      args[key] = v;
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[key] = argv[i + 1];
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function ensureDir(dir: any) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function walk(dir: any, exts: any, out: any) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('.')) {
        continue;
      }
      walk(full, exts, out);
      continue;
    }
    if (!exts.includes(path.extname(e.name))) {
      continue;
    }
    out.push(full);
  }
}

function toTitle(base: any) {
  return base.replace(/[-_]+/g, ' ').replace(/\b\w/g, (s: any) => s.toUpperCase());
}

function toTrigger(base: any) {
  return base.replace(/\s+/g, '-').toLowerCase();
}

function readSnippet(filePath: any, maxChars: any) {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (raw.length <= maxChars) {
    return raw;
  }
  return `${raw.slice(0, maxChars)}\n// ... (truncated)`;
}

function detectLanguageByExt(ext: any) {
  const map = {
    '.swift': 'swift',
    '.m': 'objectivec',
    '.h': 'objectivec',
    '.mm': 'objectivec',
    '.js': 'javascript',
    '.mjs': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.py': 'python',
    '.java': 'java',
    '.kt': 'kotlin',
    '.go': 'go',
    '.rs': 'rust',
    '.rb': 'ruby',
  };
  return (map as Record<string, any>)[ext] || 'text';
}

function buildRecipe({ title, trigger, language, sourceFile, snippet }: any) {
  const fence = '```';
  return [
    '---',
    `title: ${title}`,
    `trigger: ${trigger}`,
    `language: ${language}`,
    'category: draft',
    `source: ${sourceFile}`,
    '---',
    '',
    '## Snippet / Code Reference',
    '',
    `${fence}${language}`,
    snippet,
    fence,
    '',
    '## AI Context / Usage Guide',
    '',
    '（待补充）',
    '',
  ].join('\n');
}

const DEFAULT_EXTS = '.swift,.m,.h,.mm,.js,.mjs,.jsx,.ts,.tsx,.py,.java,.kt,.go';

function printUsage() {}

function main() {
  const args: any = parseArgs(process.argv);

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const projectRoot = args.projectRoot ? path.resolve(args.projectRoot) : process.cwd();

  const targetDir = args.targetDir ? path.resolve(args.targetDir) : projectRoot;

  const outDir = args.outDir
    ? path.resolve(args.outDir)
    : path.join(projectRoot, 'autosnippet-drafts', 'recipes');

  const exts = String(args.exts || DEFAULT_EXTS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const maxChars = Number(args.maxChars || 4000);

  if (!fs.existsSync(targetDir)) {
    console.error(`targetDir 不存在: ${targetDir}`);
    process.exit(1);
  }

  ensureDir(outDir);

  const files: any[] = [];
  walk(targetDir, exts, files);

  let _count = 0;
  for (const filePath of files) {
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    const title = toTitle(base);
    const trigger = toTrigger(base);
    const language = detectLanguageByExt(ext);
    const snippet = readSnippet(filePath, maxChars);

    const rel = path.relative(projectRoot, filePath).replace(/\\/g, '/');
    const recipe = buildRecipe({
      title,
      trigger,
      language,
      sourceFile: rel,
      snippet,
    });

    const safeName = `${base}${ext}`.replace(/\./g, '_');
    const outFile = path.join(outDir, `${safeName}.md`);
    fs.writeFileSync(outFile, recipe, 'utf8');
    _count++;
  }
}

main();
