import { createHash } from "node:crypto";
import type { ToolDeltaCache, ToolDeltaCacheCheck, ToolSearchCache } from "./types.js";

export class InMemoryToolSearchCache implements ToolSearchCache {
  readonly #values = new Map<string, unknown>();

  get(key: string): unknown | undefined {
    return this.#values.get(key);
  }

  set(key: string, value: unknown): void {
    this.#values.set(key, value);
  }
}

export class InMemoryToolDeltaCache implements ToolDeltaCache {
  readonly #files = new Map<string, { readonly hash: string; readonly content: string }>();

  get(path: string): { readonly hash: string; readonly content: string } | undefined {
    return this.#files.get(path);
  }

  set(path: string, hash: string, content: string): void {
    this.#files.set(path, { hash, content });
  }

  check(path: string, currentContent: string): ToolDeltaCacheCheck {
    const hash = hashContent(currentContent);
    const previous = this.#files.get(path);
    this.set(path, hash, currentContent);
    const lineCount = currentContent.split(/\r?\n/).length;
    if (!previous) {
      return { mode: "full", content: currentContent, lineCount };
    }
    if (previous.hash === hash) {
      return { mode: "unchanged", content: "[unchanged]", lineCount };
    }
    const delta = buildLineDelta(previous.content, currentContent);
    return { mode: delta.large ? "full" : "delta", content: delta.content, lineCount };
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function buildLineDelta(
  previousContent: string,
  currentContent: string,
): { readonly large: boolean; readonly content: string } {
  const before = previousContent.split(/\r?\n/);
  const after = currentContent.split(/\r?\n/);
  const changedLines: number[] = [];
  const max = Math.max(before.length, after.length);
  for (let index = 0; index < max; index += 1) {
    if (before[index] !== after[index]) {
      changedLines.push(index + 1);
    }
  }
  if (changedLines.length === 0) {
    return { large: false, content: "[unchanged]" };
  }
  if (changedLines.length > Math.max(60, after.length * 0.35)) {
    return { large: true, content: currentContent };
  }

  const windows = mergeLineWindows(changedLines, 2);
  const chunks = windows.map(([start, end]) => {
    const lines = after.slice(start - 1, end).map((line, offset) => `${start + offset}|${line}`);
    return [`@@ ${start}-${end} @@`, ...lines].join("\n");
  });
  return {
    large: false,
    content: [`[delta: ${changedLines.length} changed line(s)]`, ...chunks].join("\n\n"),
  };
}

function mergeLineWindows(
  lines: readonly number[],
  context: number,
): Array<readonly [number, number]> {
  const windows: Array<[number, number]> = [];
  for (const line of lines) {
    const start = Math.max(1, line - context);
    const end = line + context;
    const last = windows.at(-1);
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      windows.push([start, end]);
    }
  }
  return windows;
}
