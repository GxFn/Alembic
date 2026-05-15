import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import Logger from '../../../infrastructure/logging/Logger.js';
import type { FileChangeEvent, FileChangeEventSource } from '../../../types/reactive-evolution.js';
import type { GitDiffScanStatus } from './GitDiffCheckpointStatus.js';
import {
  isSafeProjectRelativePath,
  normalizeProjectRelativePath,
  shouldIgnoreProjectPath,
} from './ProjectDiffIgnore.js';

const GIT_TIMEOUT_MS = 5000;

type AppLogger = ReturnType<typeof Logger.getInstance>;

export interface GitDiffScannerOptions {
  execGit?: (args: string[], cwd: string) => Promise<string>;
  logger?: Pick<AppLogger, 'warn'>;
  projectRoot: string;
}

export interface GitDiffScanOptions {
  previousHead?: string | null;
}

export interface GitDiffScanResult {
  dirtyPathCount: number;
  events: FileChangeEvent[];
  head: string | null;
  headChanged: boolean;
  scanned: boolean;
  scannedAt: string;
  signature: string | null;
}

interface WorktreeSnapshot {
  eventsByKey: Map<string, FileChangeEvent>;
  keys: Set<string>;
  signature: string;
}

export class GitDiffScanner {
  readonly #execGit: (args: string[], cwd: string) => Promise<string>;
  readonly #logger: Pick<AppLogger, 'warn'>;
  readonly #projectRoot: string;

  #status: GitDiffScanStatus = {
    backend: 'git',
    dirtyPathCount: 0,
    healthy: false,
    lastError: null,
    lastEventCount: 0,
    lastHead: null,
    lastScanAt: null,
    lastSignature: null,
  };

  constructor(options: GitDiffScannerOptions) {
    this.#execGit = options.execGit ?? execGit;
    this.#logger = options.logger ?? Logger.getInstance();
    this.#projectRoot = options.projectRoot;
  }

  async scanOnce(now = Date.now(), options: GitDiffScanOptions = {}): Promise<GitDiffScanResult> {
    const scannedAt = new Date(now).toISOString();
    try {
      const isWorktree =
        (await this.#execGit(['rev-parse', '--is-inside-work-tree'], this.#projectRoot)).trim() ===
        'true';
      if (!isWorktree) {
        this.#markUnavailable(scannedAt, 'project is not a git worktree');
        return emptyResult(scannedAt);
      }

      const currentHead = normalizeHead(
        await this.#execGit(['rev-parse', 'HEAD'], this.#projectRoot)
      );
      const snapshot = await this.#collectSnapshot(currentHead);
      const events: FileChangeEvent[] = [...snapshot.eventsByKey.values()];
      const headChanged =
        Boolean(options.previousHead) &&
        Boolean(currentHead) &&
        options.previousHead !== currentHead;

      if (headChanged && options.previousHead && currentHead) {
        const headDiff = await this.#execGit(
          ['diff', '--name-status', `${options.previousHead}..${currentHead}`],
          this.#projectRoot
        );
        addNameStatusEvents(snapshot.eventsByKey, headDiff, 'git-head');
        for (const [key, event] of snapshot.eventsByKey) {
          if (key.startsWith('head:')) {
            events.push(event);
          }
        }
      }

      const filteredEvents = filterEvents(events);
      this.#status = {
        backend: 'git',
        dirtyPathCount: snapshot.keys.size,
        healthy: true,
        lastError: null,
        lastEventCount: filteredEvents.length,
        lastHead: currentHead,
        lastScanAt: scannedAt,
        lastSignature: snapshot.signature,
      };

      return {
        dirtyPathCount: snapshot.keys.size,
        events: filteredEvents,
        head: currentHead,
        headChanged,
        scanned: true,
        scannedAt,
        signature: snapshot.signature,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.warn('[git-diff-checkpoint] git diff scan failed', { error: message });
      this.#status = {
        ...this.#status,
        healthy: false,
        lastError: message,
        lastScanAt: scannedAt,
      };
      return emptyResult(scannedAt);
    }
  }

  getStatus(): GitDiffScanStatus {
    return { ...this.#status };
  }

  async #collectSnapshot(currentHead: string | null): Promise<WorktreeSnapshot> {
    const [unstagedStatus, stagedStatus, untracked, unstagedDiff, stagedDiff] = await Promise.all([
      this.#execGit(['diff', '--name-status'], this.#projectRoot),
      this.#execGit(['diff', '--name-status', '--cached'], this.#projectRoot),
      this.#execGit(['ls-files', '--others', '--exclude-standard'], this.#projectRoot),
      this.#execGit(['diff', '--no-ext-diff', '--binary'], this.#projectRoot),
      this.#execGit(['diff', '--cached', '--no-ext-diff', '--binary'], this.#projectRoot),
    ]);

    const eventsByKey = new Map<string, FileChangeEvent>();
    addNameStatusEvents(eventsByKey, unstagedStatus, 'git-worktree');
    addNameStatusEvents(eventsByKey, stagedStatus, 'git-worktree');
    const untrackedPaths = addUntrackedEvents(eventsByKey, untracked);
    return {
      eventsByKey,
      keys: new Set([...eventsByKey.keys()].filter((key) => !key.startsWith('head:'))),
      signature: await this.#buildSignature({
        currentHead,
        stagedDiff,
        unstagedDiff,
        untrackedPaths,
      }),
    };
  }

  async #buildSignature(input: {
    currentHead: string | null;
    stagedDiff: string;
    unstagedDiff: string;
    untrackedPaths: string[];
  }): Promise<string> {
    const hash = createHash('sha256');
    hash.update(`head:${input.currentHead ?? ''}\0`);
    hash.update('unstaged\0');
    hash.update(input.unstagedDiff);
    hash.update('\0staged\0');
    hash.update(input.stagedDiff);
    hash.update('\0untracked\0');
    for (const filePath of [...input.untrackedPaths].sort()) {
      hash.update(`${filePath}\0`);
      await this.#hashUntrackedFile(hash, filePath);
    }
    return hash.digest('hex');
  }

  async #hashUntrackedFile(hash: ReturnType<typeof createHash>, filePath: string): Promise<void> {
    try {
      const fileStat = await stat(join(this.#projectRoot, filePath));
      if (!fileStat.isFile()) {
        hash.update(`non-file:${fileStat.size}:${fileStat.mtimeMs}\0`);
        return;
      }
      hash.update(`file:${fileStat.size}\0`);
      hash.update(await readFile(join(this.#projectRoot, filePath)));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      hash.update(`unreadable:${message}\0`);
    }
  }

  #markUnavailable(scannedAt: string, message: string): void {
    this.#status = {
      ...this.#status,
      healthy: false,
      lastError: message,
      lastScanAt: scannedAt,
    };
  }
}

export function addNameStatusEvents(
  target: Map<string, FileChangeEvent>,
  output: string,
  eventSource: FileChangeEventSource
): void {
  for (const rawLine of splitLines(output)) {
    const parts = rawLine.split('\t');
    const status = parts[0] ?? '';
    const code = status[0];
    if (!code) {
      continue;
    }

    const keyPrefix = eventSource === 'git-head' ? 'head:' : '';
    if (code === 'R' && parts[1] && parts[2]) {
      const oldPath = normalizeProjectRelativePath(parts[1]);
      const newPath = normalizeProjectRelativePath(parts[2]);
      if (!isDispatchablePath(newPath)) {
        continue;
      }
      target.set(`${keyPrefix}renamed:${oldPath}:${newPath}`, {
        eventSource,
        oldPath,
        path: newPath,
        type: 'renamed',
      });
      continue;
    }

    const filePath = normalizeProjectRelativePath(parts[1] ?? '');
    if (!isDispatchablePath(filePath)) {
      continue;
    }
    const type: FileChangeEvent['type'] =
      code === 'A' ? 'created' : code === 'D' ? 'deleted' : 'modified';
    target.set(`${keyPrefix}${type}:${filePath}`, {
      eventSource,
      path: filePath,
      type,
    });
  }
}

function addUntrackedEvents(target: Map<string, FileChangeEvent>, output: string): string[] {
  const paths: string[] = [];
  for (const filePath of splitLines(output).map(normalizeProjectRelativePath)) {
    if (!isDispatchablePath(filePath)) {
      continue;
    }
    paths.push(filePath);
    target.set(`created:${filePath}`, {
      eventSource: 'git-worktree',
      path: filePath,
      type: 'created',
    });
  }
  return paths;
}

function emptyResult(scannedAt: string): GitDiffScanResult {
  return {
    dirtyPathCount: 0,
    events: [],
    head: null,
    headChanged: false,
    scanned: false,
    scannedAt,
    signature: null,
  };
}

function filterEvents(events: FileChangeEvent[]): FileChangeEvent[] {
  const seen = new Set<string>();
  const filtered: FileChangeEvent[] = [];
  for (const event of events) {
    if (!isDispatchablePath(event.path)) {
      continue;
    }
    const key =
      event.type === 'renamed'
        ? `${event.type}:${event.oldPath ?? ''}:${event.path}`
        : `${event.type}:${event.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    filtered.push(event);
  }
  return filtered;
}

function isDispatchablePath(filePath: string): boolean {
  return isSafeProjectRelativePath(filePath) && !shouldIgnoreProjectPath(filePath);
}

function normalizeHead(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function splitLines(output: string): string[] {
  return output.split(/\r?\n/).filter((line) => line.length > 0);
}

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS }, (error, stdout) => {
      if (error) {
        resolve('');
        return;
      }
      resolve(stdout);
    });
  });
}
