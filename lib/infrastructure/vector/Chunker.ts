/**
 * Chunker v2 — 内容分块策略
 *
 * 支持 5 种策略：whole、section（按标题）、fixed（固定大小+重叠）、ast（语法感知）、auto（自适应）
 *
 * auto 策略决策树:
 *   content
 *     ├── estimateTokens() ≤ maxChunkTokens? → whole
 *     ├── isCode(language) && hasTreeSitterGrammar? → ast (ASTChunker)
 *     ├── isMarkdown()? → section (按标题分段)
 *     └── DEFAULT → fixed (固定大小 + 行边界对齐)
 */

import { estimateTokens } from '../../shared/token-utils.js';
import { chunkByAST, isASTChunkerAvailable } from './ASTChunker.js';

export { estimateTokens };

const DEFAULT_MAX_CHUNK_TOKENS = 512;
const DEFAULT_OVERLAP_TOKENS = 50;

/** 代码语言集合 (可使用 AST 分块) */
const CODE_LANGUAGES = new Set([
  'javascript', 'typescript', 'tsx', 'python', 'java', 'kotlin',
  'go', 'swift', 'rust', 'dart', 'objectivec', 'objective-c', 'objc',
]);

/**
 * 将内容分块
 * @param {string} content
 * @param {object} metadata - { type, sourcePath, language, ... }
 * @param {object} options - { strategy, maxChunkTokens, overlapTokens, useAST }
 * @returns {Array<{ content: string, metadata: object }>}
 */
export function chunk(content, metadata: any = {}, options: any = {}) {
  const {
    strategy = 'auto',
    maxChunkTokens = DEFAULT_MAX_CHUNK_TOKENS,
    overlapTokens = DEFAULT_OVERLAP_TOKENS,
    useAST = true,
  } = options;

  if (!content || content.trim().length === 0) {
    return [];
  }

  const tokens = estimateTokens(content);
  const language = metadata.language || '';

  // 选择策略
  let selectedStrategy = strategy;
  if (strategy === 'auto') {
    if (tokens <= maxChunkTokens) {
      selectedStrategy = 'whole';
    } else if (useAST && CODE_LANGUAGES.has(language) && isASTChunkerAvailable(language)) {
      selectedStrategy = 'ast';
    } else if (content.includes('# ') || content.includes('## ') || content.includes('### ')) {
      selectedStrategy = 'section';
    } else {
      selectedStrategy = 'fixed';
    }
  }

  switch (selectedStrategy) {
    case 'whole':
      return [{ content, metadata: { ...metadata, chunkIndex: 0, totalChunks: 1, chunkStrategy: 'whole' } }];
    case 'ast': {
      // AST 分块, 失败时 fallback 到 fixed
      const astChunks = chunkByAST(content, language, metadata, { maxChunkTokens });
      if (astChunks && astChunks.length > 0) {
        return astChunks;
      }
      // fallthrough to fixed
      return chunkFixed(content, metadata, maxChunkTokens, overlapTokens);
    }
    case 'section':
      return chunkBySection(content, metadata, maxChunkTokens);
    case 'fixed':
      return chunkFixed(content, metadata, maxChunkTokens, overlapTokens);
    default:
      return [{ content, metadata: { ...metadata, chunkIndex: 0, totalChunks: 1 } }];
  }
}

/**
 * 按 Markdown 标题分段
 */
function chunkBySection(content, metadata, maxChunkTokens) {
  const sections = [];
  const lines = content.split('\n');
  let currentTitle = '';
  let currentContent = [];

  for (const line of lines) {
    if (/^#{1,3}\s+/.test(line)) {
      // 新段落
      if (currentContent.length > 0) {
        sections.push({ title: currentTitle, content: currentContent.join('\n') });
      }
      currentTitle = line.replace(/^#+\s+/, '').trim();
      currentContent = [line];
    } else {
      currentContent.push(line);
    }
  }
  // 最后一段
  if (currentContent.length > 0) {
    sections.push({ title: currentTitle, content: currentContent.join('\n') });
  }

  // 合并过小段落
  const merged = [];
  let buffer = null;

  for (const section of sections) {
    if (!buffer) {
      buffer = section;
      continue;
    }
    const combined = `${buffer.content}\n${section.content}`;
    if (estimateTokens(combined) <= maxChunkTokens) {
      buffer = { title: buffer.title, content: combined };
    } else {
      merged.push(buffer);
      buffer = section;
    }
  }
  if (buffer) {
    merged.push(buffer);
  }

  // 对超大段落做 fixed 分割
  const results = [];
  for (let i = 0; i < merged.length; i++) {
    const section = merged[i];
    if (estimateTokens(section.content) > maxChunkTokens) {
      const subChunks = chunkFixed(section.content, metadata, maxChunkTokens, 0);
      for (const sub of subChunks) {
        results.push({
          content: sub.content,
          metadata: {
            ...metadata,
            ...sub.metadata,
            sectionTitle: section.title,
            chunkIndex: results.length,
          },
        });
      }
    } else {
      results.push({
        content: section.content,
        metadata: { ...metadata, sectionTitle: section.title, chunkIndex: results.length },
      });
    }
  }

  // 设置 totalChunks
  for (const chunk of results) {
    chunk.metadata.totalChunks = results.length;
  }
  return results;
}

/**
 * 固定大小分块（带重叠）
 */
function chunkFixed(content, metadata, maxChunkTokens, overlapTokens) {
  const maxChars = maxChunkTokens * 4;
  const overlapChars = overlapTokens * 4;
  const results = [];

  let start = 0;
  while (start < content.length) {
    let end = start + maxChars;

    // 尽量在句子边界切割
    if (end < content.length) {
      const boundary = content.lastIndexOf('\n', end);
      if (boundary > start + maxChars * 0.5) {
        end = boundary + 1;
      }
    } else {
      end = content.length;
    }

    results.push({
      content: content.slice(start, end),
      metadata: { ...metadata, chunkIndex: results.length },
    });

    // 下一个开始位置（含重叠）
    const nextStart = end - overlapChars;
    // 确保至少前进 1 字符，防止 overlap >= maxChars 时无限循环
    start = nextStart > start ? nextStart : end;
    if (start >= content.length) {
      break;
    }
  }

  for (const chunk of results) {
    chunk.metadata.totalChunks = results.length;
  }
  return results;
}

export { DEFAULT_MAX_CHUNK_TOKENS, DEFAULT_OVERLAP_TOKENS };
