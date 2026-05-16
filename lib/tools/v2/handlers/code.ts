/**
 * @module tools/v2/handlers/code
 *
 * 代码智能工具 — Agent 与项目源码交互的统一入口。
 * Actions: search, read, outline, structure, write
 *
 * 引擎: ripgrep (搜索), Tree-sitter via AstAnalyzer (骨架), fs (读写)
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { estimateTokens, fail, ok, type ToolContext, type ToolResult } from '../types.js';

export async function handle(
  action: string,
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  switch (action) {
    case 'search':
      return handleSearch(params, ctx);
    case 'read':
      return handleRead(params, ctx);
    case 'outline':
      return handleOutline(params, ctx);
    case 'structure':
      return handleStructure(params, ctx);
    case 'write':
      return handleWrite(params, ctx);
    default:
      return fail(`Unknown code action: ${action}`);
  }
}

/* ================================================================== */
/*  code.search                                                        */
/* ================================================================== */

interface SearchMatch {
  file: string;
  line: number;
  content: string;
  context?: string[];
}

async function handleSearch(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const patterns =
    (params.patterns as string[]) ?? (params.pattern ? [params.pattern as string] : []);
  if (patterns.length === 0) {
    return fail('code.search requires patterns[]');
  }
  if (patterns.length > 10) {
    return fail('code.search: max 10 patterns per call');
  }

  const glob = params.glob as string | undefined;
  const maxResults = Math.min((params.maxResults as number) || 10, 50);
  const contextLines = (params.contextLines as number) ?? 2;
  const regex = (params.regex as boolean) ?? false;

  const allMatches: SearchMatch[] = [];
  const startMs = Date.now();
  let totalCount = 0;

  for (const pattern of patterns) {
    if (ctx.abortSignal?.aborted) {
      break;
    }

    const cacheKey = `${pattern}|${glob ?? ''}|${regex ? 'r' : 'l'}`;
    const cached = ctx.searchCache?.get(cacheKey);
    if (cached) {
      const cachedResult = cached as { matches: SearchMatch[]; total: number };
      allMatches.push(...cachedResult.matches);
      totalCount += cachedResult.total;
      continue;
    }

    try {
      const result = await ripgrepSearch(pattern, ctx.projectRoot, {
        glob,
        maxResults,
        contextLines,
        regex,
      });
      allMatches.push(...result.matches);
      totalCount += result.total;
      ctx.searchCache?.set(cacheKey, { matches: result.matches, total: result.total });
    } catch {
      const result = await fallbackRegexSearch(pattern, ctx.projectRoot, {
        glob,
        maxResults,
        contextLines,
        regex,
      });
      allMatches.push(...result.matches);
      totalCount += result.total;
    }
  }

  const deduped = deduplicateMatches(allMatches).slice(0, maxResults);
  const output = formatSearchOutput(deduped, totalCount);

  return ok(output, {
    tokensEstimate: estimateTokens(output),
    durationMs: Date.now() - startMs,
  });
}

interface RipgrepResult {
  matches: SearchMatch[];
  total: number;
}

/** ripgrep 排除的噪音目录 — 与 IGNORED_DIRS 对齐 */
const RG_EXCLUDE_GLOBS = [
  '!.git',
  '!node_modules',
  '!.build',
  '!dist',
  '!build',
  '!.next',
  '!__pycache__',
  '!.venv',
  '!venv',
  '!Pods',
  '!Carthage',
  '!.gradle',
  '!DerivedData',
  '!coverage',
  '!.turbo',
];

async function ripgrepSearch(
  pattern: string,
  cwd: string,
  opts: { glob?: string; maxResults: number; contextLines: number; regex: boolean }
): Promise<RipgrepResult> {
  const args = [
    '--json',
    '--max-count',
    String(opts.maxResults),
    ...(opts.contextLines > 0 ? ['--context', String(opts.contextLines)] : []),
    '--no-heading',
    '--color',
    'never',
  ];
  for (const excl of RG_EXCLUDE_GLOBS) {
    args.push('--glob', excl);
  }
  if (opts.glob) {
    args.push('--glob', opts.glob);
  }
  if (!opts.regex) {
    args.push('--fixed-strings');
  }
  args.push('--', pattern, './');

  return spawnRg(args, cwd, 15000);
}

/**
 * 通过 spawn 调用 ripgrep，关闭 stdin 防止 rg 等待输入。
 *
 * 关键：ripgrep 检测到 stdin 可读时会从 stdin 读取（而不是搜索目录），
 * Node.js exec/execFile 默认保持 stdin 打开 → rg 永远挂起。
 * 解决方案：stdio: ['ignore', 'pipe', 'pipe'] + 显式传入 './' 搜索路径。
 * see: https://github.com/BurntSushi/ripgrep/issues/2056
 */
function spawnRg(args: string[], cwd: string, timeout: number): Promise<RipgrepResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('rg', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
    });

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const MAX_BUFFER = 2 * 1024 * 1024;

    child.stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes <= MAX_BUFFER) {
        chunks.push(chunk);
      }
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString('utf-8');

      if (code === 0 || code === 2) {
        resolve(parseRipgrepJson(stdout, cwd));
      } else if (code === 1) {
        // rg exit code 1 = no matches
        resolve({ matches: [], total: 0 });
      } else {
        // timeout killed or other error — return partial if any
        const partial = parseRipgrepJson(stdout, cwd);
        if (partial.matches.length > 0) {
          resolve(partial);
        } else {
          reject(new Error(`rg exited with code ${code}`));
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function parseRipgrepJson(jsonOutput: string, _cwd: string): RipgrepResult {
  const matches: SearchMatch[] = [];
  let total = 0;

  for (const line of jsonOutput.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'match') {
        const data = obj.data;
        const rawPath = (data.path?.text ?? '') as string;
        const relPath = rawPath.startsWith('./') ? rawPath.slice(2) : rawPath;
        matches.push({
          file: relPath,
          line: data.line_number ?? 0,
          content: (data.lines?.text ?? '').trimEnd(),
        });
        total++;
      } else if (obj.type === 'summary') {
        total = obj.data?.stats?.matches ?? total;
      }
    } catch {
      // 跳过无法解析的行
    }
  }

  return { matches, total };
}

async function fallbackRegexSearch(
  pattern: string,
  cwd: string,
  opts: { glob?: string; maxResults: number; contextLines: number; regex: boolean }
): Promise<RipgrepResult> {
  const matches: SearchMatch[] = [];
  let searchRe: RegExp;
  try {
    searchRe = opts.regex ? new RegExp(pattern, 'gi') : new RegExp(escapeRegex(pattern), 'gi');
  } catch {
    return { matches: [], total: 0 };
  }

  const files = await collectFiles(cwd, opts.glob);
  let total = 0;

  for (const file of files) {
    if (matches.length >= opts.maxResults) {
      break;
    }
    try {
      const content = await fs.readFile(path.join(cwd, file), 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        searchRe.lastIndex = 0;
        if (searchRe.test(lines[i])) {
          total++;
          if (matches.length < opts.maxResults) {
            matches.push({ file, line: i + 1, content: lines[i].trimEnd() });
          }
        }
      }
    } catch {
      // 读取失败跳过
    }
  }

  return { matches, total };
}

function deduplicateMatches(matches: SearchMatch[]): SearchMatch[] {
  const seen = new Set<string>();
  return matches.filter((m) => {
    const key = `${m.file}:${m.line}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function formatSearchOutput(matches: SearchMatch[], total: number): string {
  const lines = matches.map((m) => `${m.file}:${m.line}: ${m.content}`);
  return `${total} matches (showing ${matches.length})\n\n${lines.join('\n')}`;
}

/* ================================================================== */
/*  code.read                                                          */
/* ================================================================== */

async function handleRead(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const filePath = params.path as string;
  if (!filePath) {
    return fail('code.read requires path');
  }

  const startLine = params.startLine as number | undefined;
  const endLine = params.endLine as number | undefined;

  const absPath = path.resolve(ctx.projectRoot, filePath);
  if (!absPath.startsWith(ctx.projectRoot)) {
    return fail('Access denied: path is outside project root');
  }

  let content: string;
  try {
    content = await fs.readFile(absPath, 'utf-8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`Cannot read file: ${msg}`);
  }

  const lines = content.split('\n');
  const lineCount = lines.length;

  if (ctx.deltaCache) {
    const delta = ctx.deltaCache.check(filePath, content);
    if (delta.mode === 'unchanged') {
      return ok(delta.content, { tokensEstimate: 5 });
    }
    if (delta.mode === 'delta' && !startLine && !endLine) {
      return ok(delta.content, { tokensEstimate: estimateTokens(delta.content) });
    }
  }

  if (startLine || endLine) {
    const start = Math.max(1, startLine ?? 1);
    const end = Math.min(lineCount, endLine ?? lineCount);
    const slice = lines
      .slice(start - 1, end)
      .map((l, i) => `${start + i}|${l}`)
      .join('\n');
    return ok(slice, { tokensEstimate: estimateTokens(slice) });
  }

  if (lineCount <= 500) {
    const numbered = lines.map((l, i) => `${i + 1}|${l}`).join('\n');
    return ok(numbered, { tokensEstimate: estimateTokens(numbered) });
  }

  const outline = await generateOutlineForRead(absPath, filePath, lineCount, ctx);
  return ok(outline, {
    tokensEstimate: estimateTokens(outline),
  });
}

async function generateOutlineForRead(
  absPath: string,
  relPath: string,
  lineCount: number,
  ctx: ToolContext
): Promise<string> {
  try {
    const outline = await buildAstOutline(absPath, relPath, ctx);
    if (outline) {
      return `${outline}\n\nFile has ${lineCount} lines. Showing outline. Use startLine/endLine to read specific sections.`;
    }
  } catch {
    // AST 不可用，使用头尾预览
  }

  const content = await fs.readFile(absPath, 'utf-8');
  const lines = content.split('\n');
  const headCount = 30;
  const tailCount = 15;

  const head = lines
    .slice(0, headCount)
    .map((l, i) => `${i + 1}|${l}`)
    .join('\n');
  const tail = lines
    .slice(-tailCount)
    .map((l, i) => `${lineCount - tailCount + i + 1}|${l}`)
    .join('\n');

  return [
    `// ${relPath} — ${lineCount} lines (showing head + tail)`,
    '',
    head,
    '',
    `  ... [${lineCount - headCount - tailCount} lines omitted] ...`,
    '',
    tail,
    '',
    'Use startLine/endLine to read specific sections.',
  ].join('\n');
}

/* ================================================================== */
/*  code.outline                                                       */
/* ================================================================== */

async function handleOutline(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const filePath = params.path as string;
  if (!filePath) {
    return fail('code.outline requires path');
  }

  const absPath = path.resolve(ctx.projectRoot, filePath);
  if (!absPath.startsWith(ctx.projectRoot)) {
    return fail('Access denied: path is outside project root');
  }

  try {
    await fs.access(absPath);
  } catch {
    return fail(`File not found: ${filePath}`);
  }

  const outline = await buildAstOutline(absPath, filePath, ctx);
  if (outline) {
    return ok(outline, { tokensEstimate: estimateTokens(outline) });
  }

  return fail(
    `Cannot generate outline for ${filePath} — AST analyzer not available or language not supported`
  );
}

/**
 * 通过 AstAnalyzer 生成文件骨架。
 * AstAnalyzer 接口来自 lib/core/AstAnalyzer.ts。
 */
async function buildAstOutline(
  absPath: string,
  relPath: string,
  ctx: ToolContext
): Promise<string | null> {
  const analyzer = ctx.astAnalyzer as
    | {
        analyzeFile?: (filePath: string) => Promise<AstFileResult | null>;
      }
    | undefined;

  if (!analyzer?.analyzeFile) {
    return null;
  }

  try {
    const result = await analyzer.analyzeFile(absPath);
    if (!result || !result.definitions || result.definitions.length === 0) {
      return null;
    }

    const content = await fs.readFile(absPath, 'utf-8');
    const lineCount = content.split('\n').length;
    const lang = detectLanguage(relPath);

    const outlineLines = [`// ${lineCount} lines, ${lang}, Tree-sitter AST`, ''];

    for (const def of result.definitions) {
      const indent = '  '.repeat(def.depth ?? 0);
      const lineRange = def.endLine ? `[${def.startLine}-${def.endLine}]` : `[${def.startLine}]`;
      const signature = def.signature ?? def.name;
      outlineLines.push(`${indent}${signature} ${lineRange}`);
    }

    return outlineLines.join('\n');
  } catch {
    return null;
  }
}

interface AstFileResult {
  definitions: Array<{
    name: string;
    kind: string;
    startLine: number;
    endLine?: number;
    signature?: string;
    depth?: number;
  }>;
}

/* ================================================================== */
/*  code.structure                                                     */
/* ================================================================== */

async function handleStructure(
  params: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const directory = (params.directory as string) || '.';
  const depth = Math.min((params.depth as number) || 3, 5);

  const absDir = path.resolve(ctx.projectRoot, directory);
  if (!absDir.startsWith(ctx.projectRoot)) {
    return fail('Access denied: path is outside project root');
  }

  try {
    const tree = await buildDirectoryTree(absDir, ctx.projectRoot, depth, 0);
    return ok(tree, { tokensEstimate: estimateTokens(tree) });
  } catch (err: unknown) {
    return fail(`Cannot list structure: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.build',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
  'Pods',
  'Carthage',
  '.gradle',
  'DerivedData',
  '.idea',
  '.vscode',
  'coverage',
  '.turbo',
  'Packages',
  '.swiftpm',
]);

async function buildDirectoryTree(
  absDir: string,
  projectRoot: string,
  maxDepth: number,
  currentDepth: number
): Promise<string> {
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const relDir = path.relative(projectRoot, absDir) || '.';
  const lines: string[] = currentDepth === 0 ? [`${relDir}/`] : [];
  const indent = '  '.repeat(currentDepth + (currentDepth === 0 ? 0 : 1));

  const dirs: string[] = [];
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') {
      continue;
    }
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        dirs.push(entry.name);
      }
    } else {
      files.push(entry.name);
    }
  }

  dirs.sort();
  files.sort();

  for (const dir of dirs) {
    lines.push(`${indent}${dir}/`);
    if (currentDepth < maxDepth - 1) {
      const subTree = await buildDirectoryTree(
        path.join(absDir, dir),
        projectRoot,
        maxDepth,
        currentDepth + 1
      );
      if (subTree) {
        lines.push(subTree);
      }
    }
  }

  for (const file of files) {
    lines.push(`${indent}${file}`);
  }

  return lines.join('\n');
}

/* ================================================================== */
/*  code.write                                                         */
/* ================================================================== */

const PROTECTED_PATHS = ['.git', 'node_modules', '.env'];

async function handleWrite(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const filePath = params.path as string;
  const content = params.content as string;
  const createDirs = (params.createDirectories as boolean) ?? false;

  if (!filePath || content === undefined) {
    return fail('code.write requires path and content');
  }

  const absPath = path.resolve(ctx.projectRoot, filePath);
  if (!absPath.startsWith(ctx.projectRoot)) {
    return fail('Access denied: path is outside project root');
  }

  for (const p of PROTECTED_PATHS) {
    if (filePath.startsWith(p) || filePath.includes(`/${p}/`)) {
      return fail(`Write denied: ${p} is a protected path`);
    }
  }

  try {
    if (createDirs) {
      await fs.mkdir(path.dirname(absPath), { recursive: true });
    }
    await fs.writeFile(absPath, content, 'utf-8');
    return ok({ written: filePath, bytes: Buffer.byteLength(content) });
  } catch (err: unknown) {
    return fail(`Write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ================================================================== */
/*  Helpers                                                            */
/* ================================================================== */

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const MAP: Record<string, string> = {
    '.ts': 'TypeScript',
    '.tsx': 'TSX',
    '.js': 'JavaScript',
    '.jsx': 'JSX',
    '.py': 'Python',
    '.java': 'Java',
    '.kt': 'Kotlin',
    '.go': 'Go',
    '.rs': 'Rust',
    '.swift': 'Swift',
    '.m': 'Objective-C',
    '.dart': 'Dart',
    '.rb': 'Ruby',
    '.c': 'C',
    '.cpp': 'C++',
    '.cs': 'C#',
  };
  return MAP[ext] ?? ext.slice(1) ?? 'Unknown';
}

async function collectFiles(cwd: string, glob?: string): Promise<string[]> {
  const files: string[] = [];
  const extensions = glob
    ? glob
        .replace(/\*/g, '')
        .split(',')
        .map((e) => e.trim())
    : null;

  async function walk(dir: string, relDir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) {
        continue;
      }
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relPath);
      } else if (!extensions || extensions.some((ext) => entry.name.endsWith(ext))) {
        files.push(relPath);
        if (files.length >= 5000) {
          return;
        }
      }
    }
  }

  await walk(cwd, '');
  return files;
}
