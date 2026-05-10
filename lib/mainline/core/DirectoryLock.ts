import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MainlineTimeoutError } from "./Errors.js";

export interface MainlineDirectoryLockOptions {
  readonly waitMs?: number;
  readonly staleMs?: number;
  readonly pollMs?: number;
  readonly owner?: Record<string, unknown>;
}

export interface MainlineDirectoryLockHandle {
  readonly lockDir: string;
  readonly acquiredAt: string;
  release(): Promise<void>;
}

/**
 * MainlineDirectoryLock 是轻量目录锁。
 * 旧 daemon 的 owner/stale 思路被保留，但不带 job runner、supervisor 或进程管理。
 */
export class MainlineDirectoryLock {
  async acquire(
    lockDir: string,
    options: MainlineDirectoryLockOptions = {},
  ): Promise<MainlineDirectoryLockHandle> {
    const waitMs = options.waitMs ?? 5_000;
    const staleMs = options.staleMs ?? 60_000;
    const pollMs = options.pollMs ?? 50;
    const deadline = Date.now() + waitMs;
    const resolvedLockDir = path.resolve(lockDir);

    await fs.mkdir(path.dirname(resolvedLockDir), { recursive: true });

    while (true) {
      try {
        await fs.mkdir(resolvedLockDir, { mode: 0o700 });
        const acquiredAt = new Date().toISOString();
        await fs.writeFile(
          path.join(resolvedLockDir, "owner.json"),
          `${JSON.stringify(
            {
              host: os.hostname(),
              pid: process.pid,
              acquiredAt,
              ...options.owner,
            },
            null,
            2,
          )}\n`,
          { mode: 0o600 },
        );
        return {
          lockDir: resolvedLockDir,
          acquiredAt,
          release: async () => {
            await fs.rm(resolvedLockDir, { recursive: true, force: true });
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        if (await isStale(resolvedLockDir, staleMs)) {
          await fs.rm(resolvedLockDir, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new MainlineTimeoutError("Timed out waiting for mainline directory lock.", {
            lockDir: resolvedLockDir,
            waitMs,
          });
        }
        await sleep(pollMs);
      }
    }
  }

  async withLock<T>(
    lockDir: string,
    options: MainlineDirectoryLockOptions,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const handle = await this.acquire(lockDir, options);
    try {
      return await fn();
    } finally {
      await handle.release();
    }
  }
}

async function isStale(lockDir: string, staleMs: number): Promise<boolean> {
  try {
    const stat = await fs.stat(lockDir);
    return Date.now() - stat.mtimeMs > staleMs;
  } catch {
    return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
