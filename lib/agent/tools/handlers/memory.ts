import type { ToolHandler, ToolMemoryRecord } from "../types.js";
import { isRecord, toolFailure, toolSuccess } from "../types.js";

export const memorySaveHandler: ToolHandler = async (invocation, context) => {
  const store = context.dependencies.memoryStore;
  if (!store) {
    return memoryUnavailable(context.descriptor);
  }
  const parsed = parseSaveInput(invocation.input);
  if (!parsed.ok) {
    return toolFailure(context.descriptor, "error", parsed.error);
  }

  const saved = await store.save(parsed.input);
  return toolSuccess(context.descriptor, { saved: formatRecord(saved) });
};

export const memoryRecallHandler: ToolHandler = async (invocation, context) => {
  const store = context.dependencies.memoryStore;
  if (!store) {
    return memoryUnavailable(context.descriptor);
  }
  const parsed = parseRecallInput(invocation.input);
  if (!parsed.ok) {
    return toolFailure(context.descriptor, "error", parsed.error);
  }

  const records = await store.recall(parsed.input);
  return toolSuccess(context.descriptor, {
    count: records.length,
    records: records.map(formatRecord),
  });
};

export const memoryNoteFindingHandler: ToolHandler = async (invocation, context) => {
  const parsed = parseNoteFindingInput(invocation.input);
  if (!parsed.ok) {
    return toolFailure(context.descriptor, "error", parsed.error);
  }

  const coordinator = context.dependencies.memoryCoordinator;
  if (coordinator) {
    const id = coordinator.noteFinding(
      parsed.input.finding,
      parsed.input.evidence,
      parsed.input.importance,
      parsed.input.round,
      parsed.input.scopeId,
    );
    return toolSuccess(context.descriptor, { id, routed: "memoryCoordinator" });
  }

  const store = context.dependencies.memoryStore;
  if (!store) {
    return memoryUnavailable(context.descriptor);
  }
  const saved = await store.save({
    key: stableFindingKey(parsed.input.finding, parsed.input.evidence),
    content: parsed.input.finding,
    tags: ["finding"],
    category: "agent-finding",
    metadata: {
      evidence: parsed.input.evidence,
      importance: parsed.input.importance,
      round: parsed.input.round,
      ...(parsed.input.scopeId ? { scopeId: parsed.input.scopeId } : {}),
    },
  });
  return toolSuccess(context.descriptor, { saved: formatRecord(saved), routed: "memoryStore" });
};

export const memoryPreviousEvidenceHandler: ToolHandler = async (invocation, context) => {
  const parsed = parsePreviousEvidenceInput(invocation.input);
  if (!parsed.ok) {
    return toolFailure(context.descriptor, "error", parsed.error);
  }

  const coordinator = context.dependencies.memoryCoordinator;
  if (coordinator?.searchEvidence) {
    const evidence = coordinator.searchEvidence(parsed.input.query, parsed.input.dimId);
    return toolSuccess(context.descriptor, { query: parsed.input.query, evidence });
  }

  const store = context.dependencies.memoryStore;
  if (!store) {
    return memoryUnavailable(context.descriptor);
  }
  const records = await store.recall({ query: parsed.input.query, tags: ["finding"], limit: 20 });
  return toolSuccess(context.descriptor, {
    query: parsed.input.query,
    evidence: records.map((record) => ({
      filePath: stringValue(record.metadata?.evidence) ?? "",
      evidence: {
        finding: record.content,
        importance: numberValue(record.metadata?.importance),
      },
    })),
  });
};

function parseSaveInput(input: unknown):
  | {
      readonly ok: true;
      readonly input: Omit<ToolMemoryRecord, "createdAt" | "updatedAt">;
    }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "memory.save input must be an object." },
    };
  }
  const key = stringValue(input.key);
  const content = stringValue(input.content);
  if (!key || !content) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "memory.save requires key and content." },
    };
  }
  const category = stringValue(input.category);
  return {
    ok: true,
    input: {
      key,
      content,
      tags: stringArray(input.tags),
      ...(category ? { category } : {}),
    },
  };
}

function parseRecallInput(input: unknown):
  | {
      readonly ok: true;
      readonly input: {
        readonly query?: string;
        readonly tags?: readonly string[];
        readonly limit: number;
      };
    }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (input !== undefined && !isRecord(input)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "memory.recall input must be an object." },
    };
  }
  const record = (input ?? {}) as Record<string, unknown>;
  const limit = boundedInteger(record.limit, 10, 50);
  if (limit === undefined) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "memory.recall limit is invalid." },
    };
  }
  const query = stringValue(record.query);
  const tags = stringArray(record.tags);
  return {
    ok: true,
    input: {
      ...(query ? { query } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      limit,
    },
  };
}

function parseNoteFindingInput(input: unknown):
  | {
      readonly ok: true;
      readonly input: {
        readonly finding: string;
        readonly evidence: string;
        readonly importance: number;
        readonly round: number;
        readonly scopeId?: string;
      };
    }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "memory.note_finding input must be an object." },
    };
  }
  const finding = stringValue(input.finding);
  if (!finding) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "memory.note_finding requires finding." },
    };
  }
  const importance = boundedInteger(input.importance, 5, 10);
  const round = boundedInteger(input.round, 1, Number.MAX_SAFE_INTEGER);
  if (importance === undefined || round === undefined) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "memory.note_finding numeric options are invalid." },
    };
  }
  const scopeId = stringValue(input.scopeId);
  return {
    ok: true,
    input: {
      finding,
      evidence: stringValue(input.evidence) ?? "",
      importance,
      round,
      ...(scopeId ? { scopeId } : {}),
    },
  };
}

function parsePreviousEvidenceInput(
  input: unknown,
):
  | { readonly ok: true; readonly input: { readonly query: string; readonly dimId?: string } }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  if (!isRecord(input)) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: "memory.get_previous_evidence input must be an object.",
      },
    };
  }
  const query = stringValue(input.query);
  if (!query) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "memory.get_previous_evidence requires query." },
    };
  }
  const dimId = stringValue(input.dimId);
  return {
    ok: true,
    input: {
      query,
      ...(dimId ? { dimId } : {}),
    },
  };
}

function memoryUnavailable(identity: Parameters<typeof toolFailure>[0]) {
  return toolFailure(identity, "unavailable", {
    code: "memory_store_unavailable",
    message: "Memory tools require ToolRuntimeDependencies.memoryStore.",
  });
}

function formatRecord(record: ToolMemoryRecord) {
  return {
    key: record.key,
    content: record.content,
    tags: record.tags,
    ...(record.category ? { category: record.category } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.metadata ? { metadata: record.metadata } : {}),
  };
}

function stableFindingKey(finding: string, evidence: string): string {
  const raw = `${finding}\n${evidence}`.toLowerCase();
  let hash = 0;
  for (const char of raw) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return `finding-${hash.toString(16)}`;
}

function boundedInteger(value: unknown, fallback: number, max: number): number | undefined {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return undefined;
  }
  return Math.min(value, max);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
