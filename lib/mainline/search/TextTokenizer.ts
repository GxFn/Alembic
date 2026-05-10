const CJK_CHARACTER_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
const CJK_SEQUENCE_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g;

const CJK_STOPWORDS = new Set([
  "的",
  "了",
  "着",
  "过",
  "吗",
  "呢",
  "吧",
  "啊",
  "呀",
  "在",
  "和",
  "与",
  "及",
  "或",
  "而",
  "但",
  "是",
  "有",
  "为",
  "以",
  "从",
  "到",
  "对",
  "于",
  "个",
  "些",
]);

const EN_STOPWORDS = new Set([
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "must",
  "can",
  "could",
  "an",
  "and",
  "or",
  "but",
  "if",
  "so",
  "at",
  "by",
  "for",
  "in",
  "of",
  "on",
  "to",
  "up",
  "it",
  "its",
  "as",
  "that",
  "this",
  "with",
  "from",
  "into",
  "about",
]);

/**
 * 新主干搜索分词器。
 * 这里保留旧搜索里最有收益的部分：代码标识符拆分、英文停用词过滤、
 * CJK 单字/bigram/完整片段覆盖；不引入重型分词词典，确保冷启动和测试稳定。
 */
export function tokenizeMainlineSearchText(text: string): string[] {
  if (!text.trim()) {
    return [];
  }

  const expanded = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const normalized = expanded.toLowerCase().replace(/[^\p{L}\p{N}\s_$.-]/gu, " ");
  const rawTokens = normalized.split(/[\s_$.-]+/).filter(Boolean);
  const tokens: string[] = [];

  for (const rawToken of rawTokens) {
    if (CJK_CHARACTER_RE.test(rawToken)) {
      collectCjkTokens(rawToken, tokens);
      collectNonCjkTokens(rawToken, tokens);
      continue;
    }

    if (rawToken.length >= 2 && !EN_STOPWORDS.has(rawToken)) {
      tokens.push(rawToken);
    }
  }

  return uniqueTokens(tokens);
}

function collectCjkTokens(rawToken: string, tokens: string[]): void {
  const segments = rawToken.match(CJK_SEQUENCE_RE) ?? [];
  for (const segment of segments) {
    for (const character of segment) {
      if (!CJK_STOPWORDS.has(character)) {
        tokens.push(character);
      }
    }

    for (let index = 0; index < segment.length - 1; index++) {
      const left = segment[index];
      const right = segment[index + 1];
      if (left === undefined || right === undefined) {
        continue;
      }
      if (!CJK_STOPWORDS.has(left) || !CJK_STOPWORDS.has(right)) {
        tokens.push(`${left}${right}`);
      }
    }

    if (segment.length >= 3) {
      tokens.push(segment);
    }
  }
}

function collectNonCjkTokens(rawToken: string, tokens: string[]): void {
  const nonCjkText = rawToken.replace(CJK_SEQUENCE_RE, " ");
  for (const token of nonCjkText.split(/\s+/)) {
    if (token.length >= 2 && !EN_STOPWORDS.has(token)) {
      tokens.push(token);
    }
  }
}

function uniqueTokens(tokens: readonly string[]): string[] {
  return [...new Set(tokens.map((token) => token.trim()).filter(Boolean))];
}
