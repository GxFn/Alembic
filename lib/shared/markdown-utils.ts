/**
 * markdown-utils — Markdown 代码块提取工具
 *
 * 从 Markdown 文本中提取 fenced code blocks，
 * 供 ContentImpactAnalyzer 等模块提取 Recipe 中嵌入的真实代码。
 *
 * 提取自 RecipeExtractor.#extractCodeBlocks 的公共版本。
 *
 * @module shared/markdown-utils
 */

export interface CodeBlock {
  language: string;
  code: string;
  startIndex: number;
}

/**
 * 从 Markdown 文本中提取所有 fenced code blocks。
 *
 * 匹配 ``` 开头的代码块，可带语言标识符。
 *
 * @param markdown Markdown 文本
 * @returns 提取的代码块数组
 */
export function extractCodeBlocksFromMarkdown(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    blocks.push({
      language: match[1] || 'text',
      code: match[2].trim(),
      startIndex: match.index,
    });
  }
  return blocks;
}
