import { extractMainlineApiTokens } from "../core/TextAnalysis.js";

export interface MainlineDiffHunk {
  readonly addedLines: string[];
  readonly removedLines: string[];
}

export function parseMainlineUnifiedDiff(diffText: string): MainlineDiffHunk[] {
  const hunks: MainlineDiffHunk[] = [];
  let current: { addedLines: string[]; removedLines: string[] } | null = null;

  for (const line of (diffText || "").split("\n")) {
    if (line.startsWith("@@")) {
      if (current && (current.addedLines.length > 0 || current.removedLines.length > 0)) {
        hunks.push(current);
      }
      current = { addedLines: [], removedLines: [] };
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      current.removedLines.push(line.slice(1));
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      current.addedLines.push(line.slice(1));
    }
  }

  if (current && (current.addedLines.length > 0 || current.removedLines.length > 0)) {
    hunks.push(current);
  }
  return hunks;
}

export function tokenizeMainlineDiff(hunks: readonly MainlineDiffHunk[]): Set<string> {
  return new Set(
    extractMainlineApiTokens(
      hunks.flatMap((hunk) => [...hunk.addedLines, ...hunk.removedLines]).join("\n"),
    ),
  );
}
