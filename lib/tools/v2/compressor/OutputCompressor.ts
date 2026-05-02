/**
 * @module tools/v2/compressor/OutputCompressor
 *
 * 终端输出压缩器 — 根据命令模式匹配专用解析器，
 * 将原始 stdout/stderr 转换为 LLM 友好的紧凑结构化文本。
 *
 * 流水线: ANSI strip → 重复行折叠 → 专用解析器 / 通用截断
 */

import type { CompressOpts } from '../types.js';
import { cleanOutput, truncateOutput } from './strip.js';

type Parser = (raw: string) => string | null;

interface ParserEntry {
  pattern: RegExp;
  name: string;
  parse: Parser;
}

const parsers: ParserEntry[] = [];
let parsersLoaded = false;

/**
 * 延迟加载所有解析器（避免启动时 import 全部模块）。
 * 幂等 — 多次调用只执行一次。
 */
async function ensureParsers(): Promise<void> {
  if (parsersLoaded) {
    return;
  }
  parsersLoaded = true;

  const modules = await Promise.allSettled([
    import('./parsers/GitStatusParser.js'),
    import('./parsers/GitDiffParser.js'),
    import('./parsers/GitLogParser.js'),
    import('./parsers/TestOutputParser.js'),
    import('./parsers/LintOutputParser.js'),
    import('./parsers/GrepParser.js'),
    import('./parsers/TreeParser.js'),
    import('./parsers/PackageParser.js'),
  ]);

  const PARSER_PATTERNS: Array<[RegExp, string, number]> = [
    [/^git\s+status/, 'git-status', 0],
    [/^git\s+diff/, 'git-diff', 1],
    [/^git\s+log/, 'git-log', 2],
    [
      /^(vitest|jest|mocha|pytest|npx\s+vitest|npx\s+jest|npm\s+test|pnpm\s+test)\b/,
      'test-output',
      3,
    ],
    [/^(eslint|biome|tsc|npx\s+tsc)\b/, 'lint-output', 4],
    [/^(rg|grep|ag|ack)\b/, 'grep', 5],
    [/^(ls|find|tree)\b/, 'tree', 6],
    [/^(npm|pnpm|yarn|bun)\s+(install|add|remove|update)\b/, 'package', 7],
  ];

  for (const [pattern, name, idx] of PARSER_PATTERNS) {
    const m = modules[idx];
    if (m.status === 'fulfilled' && m.value?.parse) {
      parsers.push({ pattern, name, parse: m.value.parse });
    }
  }
}

export class OutputCompressor {
  /**
   * 压缩终端输出。
   *
   * @param raw - 原始 stdout + stderr
   * @param opts - 压缩选项
   * @returns 压缩后的文本
   */
  async compress(raw: string, opts: CompressOpts = {}): Promise<string> {
    if (!raw || raw.length === 0) {
      return raw;
    }

    await ensureParsers();

    const cleaned = cleanOutput(raw);
    const command = opts.command ?? '';
    const tokenBudget = opts.tokenBudget ?? 4000;
    const maxChars = tokenBudget * 4;

    for (const entry of parsers) {
      if (entry.pattern.test(command)) {
        try {
          const result = entry.parse(cleaned);
          if (result !== null) {
            if (result.length <= maxChars) {
              return result;
            }
            return truncateOutput(result, maxChars);
          }
        } catch {
          // 解析失败，fallback 到通用截断
        }
        break;
      }
    }

    if (cleaned.length <= maxChars) {
      return cleaned;
    }
    return truncateOutput(cleaned, maxChars);
  }

  /**
   * 同步版本 — 假设解析器已加载。
   * 适用于确定已调用过 compress() 之后的场景。
   */
  compressSync(raw: string, opts: CompressOpts = {}): string {
    if (!raw || raw.length === 0) {
      return raw;
    }

    const cleaned = cleanOutput(raw);
    const command = opts.command ?? '';
    const tokenBudget = opts.tokenBudget ?? 4000;
    const maxChars = tokenBudget * 4;

    for (const entry of parsers) {
      if (entry.pattern.test(command)) {
        try {
          const result = entry.parse(cleaned);
          if (result !== null) {
            if (result.length <= maxChars) {
              return result;
            }
            return truncateOutput(result, maxChars);
          }
        } catch {
          break;
        }
        break;
      }
    }

    if (cleaned.length <= maxChars) {
      return cleaned;
    }
    return truncateOutput(cleaned, maxChars);
  }
}
