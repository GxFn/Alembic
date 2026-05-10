export interface MainlineMarkdownCodeBlock {
  readonly language: string;
  readonly code: string;
  readonly startIndex: number;
}

export function extractMainlineMarkdownCodeBlocks(markdown: string): MainlineMarkdownCodeBlock[] {
  const blocks: MainlineMarkdownCodeBlock[] = [];
  const regex = /(^|\n)(`{3,}|~{3,})([^\r\n]*)\r?\n([\s\S]*?)\r?\n\2/g;
  let match = regex.exec(markdown || "");
  while (match !== null) {
    blocks.push({
      language: match[3]?.trim().split(/\s+/)[0] || "text",
      code: match[4]?.trim() ?? "",
      startIndex: match.index + (match[1]?.length ?? 0),
    });
    match = regex.exec(markdown || "");
  }
  return blocks;
}
