/** SearchHandler — 处理 // as:s 指令 */

import Logger from '#infra/logging/Logger.js';

export async function handleSearch(
  watcher: import('../FileWatcher.js').FileWatcher,
  fullPath: string,
  relativePath: string,
  searchLine: string
) {
  const query = searchLine.replace(/^\/\/\s*(?:autosnippet|as):(?:search|s)\s*/, '').trim();

  if (!query) {
    return;
  }

  let searchResult: { items?: unknown[] } | unknown[] | null = null;
  try {
    const { ServiceContainer } = await import('../../../injection/ServiceContainer.js');
    const container = ServiceContainer.getInstance();
    const searchEngine = container.get('searchEngine');

    // 确保索引已构建
    searchEngine.ensureIndex();

    // auto (BM25+semantic 融合 + Ranking Pipeline) → keyword (SQL LIKE) 降级链
    // Xcode/IDE 场景: 传递 generate intent，让排序器使用代码生成权重
    try {
      searchResult = await searchEngine.search(query, {
        limit: 10,
        mode: 'auto',
        rank: true,
        context: { intent: 'generate' },
      });
      // auto 零结果 → keyword (SQL LIKE) 兜底
      const resultItems = Array.isArray(searchResult)
        ? searchResult
        : ((searchResult as Record<string, unknown>)?.items as unknown[]) || [];
      if (resultItems.length === 0) {
        searchResult = await searchEngine.search(query, { limit: 10, mode: 'keyword' });
      }
    } catch {
      try {
        searchResult = await searchEngine.search(query, { limit: 10, mode: 'keyword' });
      } catch {
        /* 全部失败 */
      }
    }
  } catch (err: unknown) {
    Logger.getInstance().warn('搜索失败', { query, error: (err as Error).message });
    watcher._notify(`搜索「${query}」失败: ${(err as Error).message}`);
    return;
  }

  const items = normalizeSearchResults(searchResult);

  // Xcode 代码插入场景: 有实际代码的结果优先展示
  items.sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
    const aHasCode = a.code && a.code !== '(无预览内容)' && (a.code as string).length > 30 ? 1 : 0;
    const bHasCode = b.code && b.code !== '(无预览内容)' && (b.code as string).length > 30 ? 1 : 0;
    return bHasCode - aHasCode;
  });

  if (items.length === 0) {
    watcher._notify(`未找到「${query}」的相关结果`);
    return;
  }

  // NativeUI 交互选择
  const NU = await import('../../../platform/NativeUi.js');
  const selectedIndex = NU.showCombinedWindow(items, query);

  if (selectedIndex < 0 || selectedIndex >= items.length) {
    return;
  }

  const selected = items[selectedIndex];

  // 如果 selected 没有 moduleName，尝试从当前文件路径推断
  if (!selected.moduleName && selected.headers && selected.headers.length > 0) {
    try {
      const HeaderResolver = await import('../../../platform/ios/xcode/HeaderResolver.js');
      const resolved = await HeaderResolver.resolveHeadersForText(
        watcher.projectRoot,
        relativePath,
        (await import('node:fs')).readFileSync(fullPath, 'utf8')
      );
      if (resolved?.moduleName) {
        selected.moduleName = resolved.moduleName;
      }
    } catch {
      /* 解析失败不阻塞 */
    }
  }

  // Xcode 代码自动插入（osascript 跳转 + 粘贴）
  const { insertCodeToXcode } = await import('../../../platform/ios/xcode/XcodeIntegration.js');
  await insertCodeToXcode(watcher, fullPath, selected, searchLine);
}

/** 将搜索结果标准化为 NativeUI 可展示格式 */
export function normalizeSearchResults(results: unknown) {
  if (!results) {
    return [];
  }
  const arr: Record<string, string>[] = Array.isArray(results)
    ? results
    : ((results as Record<string, unknown>).items as Record<string, string>[]) || [];

  return arr
    .map((r: Record<string, string>) => {
      let code = '';
      let explanation = '';
      let headers: string[] = [];
      if (r.content) {
        try {
          const content = typeof r.content === 'string' ? JSON.parse(r.content) : r.content;
          // 注意: 不直接使用 content.markdown —— markdown 是完整文档，不是纯代码
          code =
            content.code ||
            content.pattern ||
            content.content ||
            content.body ||
            content.snippet ||
            content.solution ||
            content.example ||
            '';
          explanation =
            content.rationale ||
            content.description ||
            content.summary ||
            content.explanation ||
            '';
          if (Array.isArray(content.headers) && content.headers.length > 0) {
            headers = content.headers;
          }
          // 如果主字段为空，尝试从 Markdown 内容提取代码块
          if (!code && content.markdown) {
            code = _extractCodeFromMarkdown(content.markdown);
            // 若 markdown 中提取不出代码，且 explanation 为空，用 markdown 生成摘要
            if (!code && !explanation) {
              explanation = _stripMarkdownFormatting(content.markdown).substring(0, 500);
            }
          }
        } catch {
          // content 不是 JSON，可能是纯文本/代码 — 直接使用
          if (typeof r.content === 'string' && r.content.length > 10) {
            code = r.content.substring(0, 2000);
          }
        }
      }
      // 如果 Ranking Pipeline 已提取 code 字段，优先使用
      if (!code && r.code && r.code.length > 5) {
        code = r.code;
      }
      // V3: headers 是独立 JSON 列（字符串），优先解析
      if (headers.length === 0 && r.headers) {
        try {
          const parsed = typeof r.headers === 'string' ? JSON.parse(r.headers) : r.headers;
          if (Array.isArray(parsed) && parsed.length > 0) {
            headers = parsed;
          }
        } catch {
          /* ignore */
        }
      }
      // moduleName: 优先从独立列取
      let moduleName = r.moduleName || null;
      if (!moduleName && r.content) {
        try {
          const content = typeof r.content === 'string' ? JSON.parse(r.content) : r.content;
          moduleName = content.moduleName || null;
        } catch {
          /* ignore */
        }
      }
      if (!moduleName) {
        moduleName = r.moduleName || null;
      }

      // ── 从 code 中分离 #import / @import / import 行，归入 headers ──
      const finalCode = code || r.code || r.description || r.trigger || '(无预览内容)';
      const { cleanedCode, extractedHeaders } = _separateImportsFromCode(String(finalCode));
      if (extractedHeaders.length > 0) {
        for (const h of extractedHeaders) {
          if (!headers.some((existing) => existing.trim() === h.trim())) {
            headers.push(h);
          }
        }
      }

      return {
        title: r.title || r.name || r.id || 'Recipe',
        code: cleanedCode || '(无预览内容)',
        explanation: explanation || r.summary || r.description || '',
        headers,
        moduleName,
        trigger: r.trigger || r.completionKey || '',
      };
    })
    .filter(
      (item: {
        title: string;
        code: string;
        explanation: string;
        headers: string[];
        moduleName: string | null;
        trigger: string;
      }) => item.title
    );
}

/**
 * 从代码文本中分离出 import/include 行
 *
 * 只提取位于代码开头的连续 import 块（含中间空行），
 * 代码正文中的 import（如注释或字符串里的）不做处理。
 *
 * 支持: #import, @import, #include, import (Swift)
 */
function _separateImportsFromCode(code: string) {
  if (!code || code === '(无预览内容)') {
    return { cleanedCode: code, extractedHeaders: [] };
  }
  const lines = code.split(/\r?\n/);
  const importRe = /^\s*(#import\s|@import\s|#include\s|import\s)/;
  const extractedHeaders: string[] = [];
  let lastImportIdx = -1;

  // 从开头扫描连续 import 块（允许中间有空行）
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      // 空行：如果前面已有 import，继续扫描
      if (lastImportIdx >= 0) {
        continue;
      }
      // 前面没 import，遇到前导空行也继续
      continue;
    }
    if (importRe.test(trimmed)) {
      extractedHeaders.push(trimmed);
      lastImportIdx = i;
    } else {
      // 遇到非 import 非空行，停止扫描
      break;
    }
  }

  if (extractedHeaders.length === 0) {
    return { cleanedCode: code, extractedHeaders: [] };
  }

  // 移除开头的 import 行和紧随的空行
  const remaining = lines.slice(lastImportIdx + 1);
  // 去掉残留的前导空行
  while (remaining.length > 0 && !remaining[0].trim()) {
    remaining.shift();
  }
  const cleanedCode = remaining.join('\n').trim();
  return { cleanedCode, extractedHeaders };
}

/**
 * 从 Markdown 文本中提取所有 fenced code blocks，合并为纯代码
 *
 * 支持 ```lang\n...\n``` 格式，提取多个代码块并用空行分隔。
 * 如果没有找到代码块，返回空字符串。
 *
 * @param md Markdown 文本
 * @returns 提取出的纯代码，或空字符串
 */
function _extractCodeFromMarkdown(md: string) {
  if (!md) {
    return '';
  }
  const fencedRe = /```[\w]*\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = fencedRe.exec(md)) !== null) {
    const block = match[1].trim();
    if (block) {
      blocks.push(block);
    }
  }
  return blocks.join('\n\n');
}

/**
 * 移除 Markdown 格式标记，返回纯文本摘要
 *
 * 用于在无法提取代码时，从 markdown 生成 explanation 文本。
 *
 * @param md Markdown 文本
 * @returns 纯文本
 */
function _stripMarkdownFormatting(md: string) {
  if (!md) {
    return '';
  }
  return md
    .replace(/```[\w]*\n[\s\S]*?```/g, '') // 移除代码块
    .replace(/^#{1,6}\s+/gm, '') // 移除标题标记
    .replace(/\*\*([^*]+)\*\*/g, '$1') // 移除粗体
    .replace(/\*([^*]+)\*/g, '$1') // 移除斜体
    .replace(/`([^`]+)`/g, '$1') // 移除行内代码
    .replace(/^\s*[-*+]\s+/gm, '') // 移除列表标记
    .replace(/^\s*\d+\.\s+/gm, '') // 移除有序列表
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // 移除链接，保留文字
    .replace(/\n{3,}/g, '\n\n') // 压缩多余空行
    .trim();
}
