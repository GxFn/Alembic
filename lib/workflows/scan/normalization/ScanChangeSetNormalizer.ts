import type { FileChangeEvent, FileChangeEventSource } from '#types/reactive-evolution.js';
import type { ScanChangeSet } from '#workflows/scan/ScanTypes.js';

const VALID_EVENT_TYPES = new Set(['created', 'renamed', 'deleted', 'modified']);
const VALID_EVENT_SOURCES = new Set<FileChangeEventSource>([
  'ide-edit',
  'git-head',
  'git-worktree',
]);

export interface NormalizedFileChangeEvents {
  events: FileChangeEvent[];
  inputCount: number;
  invalidCount: number;
  wasArray: boolean;
}

export function normalizeFileChangeEvents(value: unknown): NormalizedFileChangeEvents {
  if (!Array.isArray(value)) {
    return { events: [], inputCount: 0, invalidCount: 0, wasArray: false };
  }

  const events = value
    .map((item) => normalizeFileChangeEvent(item))
    .filter((event): event is FileChangeEvent => Boolean(event));

  return {
    events,
    inputCount: value.length,
    invalidCount: value.length - events.length,
    wasArray: true,
  };
}

export function normalizeScanChangeSet(value: unknown): ScanChangeSet | undefined {
  const body = asRecord(value);
  if (Object.keys(body).length === 0) {
    return undefined;
  }
  return {
    added: readStringArray(body.added),
    modified: readStringArray(body.modified),
    deleted: readStringArray(body.deleted),
    renamed: readRenames(body.renamed),
    source: readChangeSetSource(body.source),
  };
}

export function eventsToChangeSet(events: readonly FileChangeEvent[]): ScanChangeSet {
  return {
    added: events.filter((event) => event.type === 'created').map((event) => event.path),
    modified: events.filter((event) => event.type === 'modified').map((event) => event.path),
    deleted: events.filter((event) => event.type === 'deleted').map((event) => event.path),
    renamed: events
      .filter((event) => event.type === 'renamed')
      .map((event) => ({ oldPath: event.oldPath ?? event.path, newPath: event.path })),
    source: eventsToSource(events),
  };
}

export function eventsToSource(
  events: readonly FileChangeEvent[]
): FileChangeEventSource | undefined {
  return events.find((event) => event.eventSource)?.eventSource;
}

export function collectChangeSetFiles(changeSet: ScanChangeSet | null | undefined): string[] {
  if (!changeSet) {
    return [];
  }
  return [
    ...new Set([
      ...changeSet.added,
      ...changeSet.modified,
      ...changeSet.deleted,
      ...(changeSet.renamed ?? []).flatMap((rename) => [rename.oldPath, rename.newPath]),
    ]),
  ];
}

function normalizeFileChangeEvent(value: unknown): FileChangeEvent | null {
  const record = asRecord(value);
  const type = readString(record.type);
  const filePath = readString(record.path);
  if (!VALID_EVENT_TYPES.has(type) || !filePath) {
    return null;
  }

  const event: FileChangeEvent = { type: type as FileChangeEvent['type'], path: filePath };
  const oldPath = readOptionalString(record.oldPath);
  const eventSource = readEventSource(record.eventSource);
  if (oldPath) {
    event.oldPath = oldPath;
  }
  if (eventSource) {
    event.eventSource = eventSource;
  }
  return event;
}

function readRenames(value: unknown): Array<{ oldPath: string; newPath: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      const record = asRecord(item);
      const oldPath = readString(record.oldPath);
      const newPath = readString(record.newPath);
      return oldPath && newPath ? { oldPath, newPath } : null;
    })
    .filter((item): item is { oldPath: string; newPath: string } => Boolean(item));
}

function readChangeSetSource(value: unknown): ScanChangeSet['source'] {
  if (value === 'manual') {
    return value;
  }
  return readEventSource(value);
}

function readEventSource(value: unknown): FileChangeEventSource | undefined {
  return typeof value === 'string' && VALID_EVENT_SOURCES.has(value as FileChangeEventSource)
    ? (value as FileChangeEventSource)
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}
