export interface MainlineMarkdownCodeBlock {
  readonly language: string;
  readonly code: string;
  readonly startIndex: number;
}

export interface MainlineMarkdownHeading {
  readonly depth: number;
  readonly title: string;
  readonly line: number;
}

export interface MainlineMarkdownFrontmatter {
  readonly attributes: Record<string, string | boolean | number>;
  readonly body: string;
  readonly raw?: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function extractMainlineMarkdownCodeBlocks(markdown: string): MainlineMarkdownCodeBlock[] {
  const blocks: MainlineMarkdownCodeBlock[] = [];
  const regex = /(^|\n)(`{3,}|~{3,})([^\r\n]*)\r?\n([\s\S]*?)\r?\n\2/g;
  let match: RegExpExecArray | null;
  while (true) {
    match = regex.exec(markdown || "");
    if (match === null) {
      break;
    }
    const fencePrefix = match[1] ?? "";
    const info = match[3] ?? "";
    const code = match[4] ?? "";
    blocks.push({
      language: info.trim().split(/\s+/)[0] || "text",
      code: code.trim(),
      startIndex: match.index + fencePrefix.length,
    });
  }
  return blocks;
}

export function extractMainlineMarkdownHeadings(markdown: string): MainlineMarkdownHeading[] {
  return (markdown || "")
    .split(/\r?\n/)
    .map((line, index) => {
      const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      return match
        ? {
            depth: (match[1] ?? "").length,
            title: match[2] ?? "",
            line: index + 1,
          }
        : null;
    })
    .filter((heading): heading is MainlineMarkdownHeading => Boolean(heading));
}

export function splitMainlineMarkdownFrontmatter(markdown: string): MainlineMarkdownFrontmatter {
  const match = FRONTMATTER_RE.exec(markdown || "");
  if (!match) {
    return { attributes: {}, body: markdown || "" };
  }

  return {
    attributes: parseSimpleYamlAttributes(match[1] ?? ""),
    body: markdown.slice(match[0].length),
    ...(match[1] === undefined ? {} : { raw: match[1] }),
  };
}

export function injectMainlineManagedSection(
  markdown: string,
  section: string,
  options: { begin?: string; end?: string } = {},
): string {
  const begin = options.begin ?? "<!-- alembic:begin -->";
  const end = options.end ?? "<!-- alembic:end -->";
  const block = `${begin}\n${section.trim()}\n${end}`;
  const pattern = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}`);
  if (pattern.test(markdown)) {
    return markdown.replace(pattern, block);
  }
  return `${markdown.replace(/\s*$/, "")}\n\n${block}\n`;
}

function parseSimpleYamlAttributes(raw: string): Record<string, string | boolean | number> {
  const attributes: Record<string, string | boolean | number> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1];
    const value = match[2];
    if (key === undefined || value === undefined) {
      continue;
    }
    attributes[key] = coerceScalar(value);
  }
  return attributes;
}

function coerceScalar(value: string): string | boolean | number {
  const unquoted = value.replace(/^['"]|['"]$/g, "");
  if (unquoted === "true") {
    return true;
  }
  if (unquoted === "false") {
    return false;
  }
  const numeric = Number(unquoted);
  return Number.isFinite(numeric) && unquoted.trim() !== "" ? numeric : unquoted;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
