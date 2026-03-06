#!/usr/bin/env node

/**
 * Recipe 审计脚本（只读）
 * - 扫描 AutoSnippet/recipes 目录
 * - 检查 Frontmatter 必填字段与格式
 * - 检查 Snippet / Usage Guide 标题是否存在
 * - 输出 reports/recipe-audit.json 与 reports/recipe-audit.md
 */

import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_FIELDS = [
  'title',
  'trigger',
  'category',
  'language',
  'summary_cn',
  'summary_en',
  'headers',
];

const CATEGORIES = new Set([
  'View',
  'Service',
  'Tool',
  'Model',
  'Network',
  'Storage',
  'UI',
  'Utility',
]);

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const SNIPPET_HEADING_RE = /##\s+Snippet\s*\/\s*Code\s+Reference/i;
const USAGE_HEADING_RE = /##\s+AI\s+Context\s*\/\s*Usage\s+Guide/i;
const FENCED_CODE_RE = /```(\w*)\r?\n([\s\S]*?)```/;

function findProjectRoot(startDir) {
  let current = startDir;
  while (current && current !== path.dirname(current)) {
    const candidate = path.join(current, 'AutoSnippet', 'AutoSnippet.boxspec.json');
    if (fs.existsSync(candidate)) {
      return current;
    }
    current = path.dirname(current);
  }
  return null;
}

function readAllMarkdownFiles(dir) {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...readAllMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

function parseFrontmatter(text) {
  const out: Record<string, any> = {};
  const match = text.match(FRONTMATTER_RE);
  if (!match || !match[1]) {
    return out;
  }
  const lines = match[1].split(/\r?\n/);
  let key: any = null;
  let valueLines: any[] = [];
  for (const line of lines) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) {
      if (key) {
        out[key] = normalizeValue(valueLines.join('\n'));
      }
      key = m[1];
      const rest = m[2].trim();
      if (rest.startsWith('[')) {
        out[key] = parseInlineArray(rest);
        key = null;
        valueLines = [];
      } else {
        valueLines = [rest];
      }
    } else if (key && line.match(/^\s*-\s+/)) {
      valueLines.push(line.trim().replace(/^[-\s]+/, ''));
    } else if (key && line.match(/^\s/)) {
      valueLines.push(line.trim());
    } else {
      if (key) {
        out[key] = normalizeValue(valueLines.join('\n'));
      }
      key = null;
      valueLines = [];
    }
  }
  if (key) {
    out[key] = normalizeValue(valueLines.join('\n'));
  }
  return out;
}

function parseInlineArray(str) {
  try {
    const parsed = JSON.parse(str.replace(/'/g, '"'));
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch (_: any) {
    return [str];
  }
}

function normalizeValue(value) {
  if (value == null) {
    return '';
  }
  const trimmed = String(value)
    .trim()
    .replace(/^['"]|['"]$/g, '');
  if (trimmed.includes('\n')) {
    const list = trimmed
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter(Boolean);
    return list.length > 0 ? list : trimmed;
  }
  return trimmed;
}

function toArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (!value) {
    return [];
  }
  return [String(value)];
}

function auditRecipe(filePath, content) {
  const issues: any[] = [];
  const fm: any = parseFrontmatter(content);
  const body = content.replace(FRONTMATTER_RE, '');
  const hasSnippetHeading = SNIPPET_HEADING_RE.test(content);
  const hasUsageHeading = USAGE_HEADING_RE.test(content);
  const hasCodeBlock = FENCED_CODE_RE.test(body);

  for (const field of REQUIRED_FIELDS) {
    const value = fm[field];
    if (!value || (Array.isArray(value) && value.length === 0)) {
      issues.push(`缺少必填字段: ${field}`);
    }
  }

  if (fm.trigger && !String(fm.trigger).startsWith('@')) {
    issues.push('trigger 必须以 @ 开头');
  }

  if (fm.category && !CATEGORIES.has(String(fm.category))) {
    issues.push(`category 非法: ${fm.category}`);
  }

  if (
    fm.language &&
    !['swift', 'objectivec', 'markdown'].includes(String(fm.language).toLowerCase())
  ) {
    issues.push(`language 非法: ${fm.language}`);
  }

  const headers = toArray(fm.headers);
  if (headers.length > 0) {
    const bad = headers.filter((h) => !/^#import\s+<.+>$/.test(h) && !/^import\s+\w+/.test(h));
    if (bad.length > 0) {
      issues.push('headers 包含非完整 import 语句');
    }
  }

  if (!hasUsageHeading) {
    issues.push('缺少 Usage Guide 标题');
  }
  if (!hasSnippetHeading && hasCodeBlock) {
    issues.push('存在代码块但缺少 Snippet 标题');
  }

  const introOnly = !hasCodeBlock;

  return {
    filePath,
    introOnly,
    issues,
  };
}

function main() {
  const projectRoot = findProjectRoot(process.cwd());
  if (!projectRoot) {
    console.error('未找到项目根（AutoSnippet/AutoSnippet.boxspec.json）。');
    process.exit(1);
  }

  const recipesDir = path.join(projectRoot, 'AutoSnippet', 'recipes');
  if (!fs.existsSync(recipesDir)) {
    console.error(`未找到 recipes 目录: ${recipesDir}`);
    process.exit(1);
  }

  const files = readAllMarkdownFiles(recipesDir);
  const results: any[] = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    results.push(auditRecipe(path.relative(projectRoot, file), content));
  }

  const withIssues = results.filter((r) => r.issues.length > 0);
  const summary = {
    checked: results.length,
    withIssues: withIssues.length,
    introOnly: results.filter((r) => r.introOnly).length,
  };

  const report = { summary, results: withIssues };
  const reportDir = path.join(projectRoot, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'recipe-audit.json'), JSON.stringify(report, null, 2));

  const mdLines = [
    '# Recipe 审计报告',
    '',
    `- 总数: ${summary.checked}`,
    `- 有问题: ${summary.withIssues}`,
    `- Intro-only: ${summary.introOnly}`,
    '',
    '## 需要处理的条目',
    '',
  ];

  for (const item of withIssues) {
    mdLines.push(`- ${item.filePath}`);
    for (const issue of item.issues) {
      mdLines.push(`  - ${issue}`);
    }
  }

  fs.writeFileSync(path.join(reportDir, 'recipe-audit.md'), mdLines.join('\n'));
}

if (require.main === module) {
  main();
}
