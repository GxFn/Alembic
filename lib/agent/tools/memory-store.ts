import type { ToolMemoryRecallOptions, ToolMemoryRecord, ToolMemoryStore } from "./types.js";

export class InMemoryToolMemoryStore implements ToolMemoryStore {
  readonly #records = new Map<string, ToolMemoryRecord>();
  readonly #now: () => number;

  constructor(options: { readonly now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  async save(record: Omit<ToolMemoryRecord, "createdAt" | "updatedAt">): Promise<ToolMemoryRecord> {
    const existing = this.#records.get(record.key);
    const now = this.#now();
    const next: ToolMemoryRecord = {
      ...record,
      tags: uniqueStrings(record.tags),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.#records.set(next.key, next);
    return next;
  }

  async recall(options: ToolMemoryRecallOptions = {}): Promise<ToolMemoryRecord[]> {
    const query = normalizeText(options.query);
    const tagSet = new Set((options.tags ?? []).map((tag) => tag.toLowerCase()));
    const limit = options.limit == null || options.limit <= 0 ? 20 : options.limit;
    const records = [...this.#records.values()]
      .filter((record) => {
        const matchesQuery =
          !query ||
          normalizeText(record.key).includes(query) ||
          normalizeText(record.content).includes(query) ||
          normalizeText(record.category).includes(query);
        const matchesTags =
          tagSet.size === 0 || record.tags.some((tag) => tagSet.has(tag.toLowerCase()));
        return matchesQuery && matchesTags;
      })
      .sort((left, right) => right.updatedAt - left.updatedAt);
    return records.slice(0, limit);
  }
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}
