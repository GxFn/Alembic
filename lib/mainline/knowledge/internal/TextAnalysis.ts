const IDENTIFIER_KEYWORDS = new Set([
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "def",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "for",
  "from",
  "func",
  "function",
  "guard",
  "if",
  "import",
  "interface",
  "let",
  "null",
  "private",
  "public",
  "return",
  "self",
  "static",
  "struct",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "type",
  "undefined",
  "var",
  "void",
  "while",
]);

export function tokenizeMainlineIdentifiers(code: string): string[] {
  const cleaned = (code || "")
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  return cleaned.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g) ?? [];
}

export function extractMainlineApiTokens(code: string): string[] {
  return [
    ...new Set(
      tokenizeMainlineIdentifiers(code).filter((identifier) => {
        if (identifier.length < 4) {
          return false;
        }
        if (/^(My|Example|Sample|Test|Foo|Bar|Baz|Demo|Dummy)/i.test(identifier)) {
          return false;
        }
        return !IDENTIFIER_KEYWORDS.has(identifier.toLowerCase());
      }),
    ),
  ];
}

export function tokenizeMainlineSimilarity(text: string, n = 2): Set<string> {
  const normalized = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\u3400-\u4dbf]+/g, " ")
    .trim();
  const tokens = new Set<string>();

  for (const word of normalized.split(/\s+/).filter(Boolean)) {
    if (word.length >= n) {
      tokens.add(word);
    }
    for (let index = 0; index <= word.length - n; index++) {
      tokens.add(word.slice(index, index + n));
    }
  }

  return tokens;
}

export function mainlineJaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;
  let intersection = 0;
  for (const token of smaller) {
    if (larger.has(token)) {
      intersection += 1;
    }
  }
  return intersection / (left.size + right.size - intersection);
}
