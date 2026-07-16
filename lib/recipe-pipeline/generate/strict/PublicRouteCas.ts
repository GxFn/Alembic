import { randomUUID } from 'node:crypto';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { hashCanonicalJson } from '@alembic/core/project-context-foundation';

export interface InspectedPublicRouteV1 {
  readonly bytes: string;
  readonly hash: string;
}

export interface PreparedPublicRouteBytesV1 {
  readonly bytes: string;
  readonly hash: string;
}

export async function inspectPublicRoute(
  routePath: string
): Promise<InspectedPublicRouteV1 | null> {
  let bytes: string;
  try {
    bytes = await fsp.readFile(routePath, 'utf8');
  } catch (error: unknown) {
    if (readCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error('STRICT_PUBLIC_ROUTE_INVALID_JSON');
  }
  return Object.freeze({ bytes, hash: hashCanonicalJson(value) });
}

/** The public pointer's only writer: acquire lock, compare current, atomically replace, fsync, read back. */
export async function commitPreparedPublicRoute(input: {
  readonly expectedCurrentHash: string | null;
  readonly prepared: PreparedPublicRouteBytesV1;
  readonly routePath: string;
}): Promise<{ readonly status: 'committed' | 'recovered'; readonly routeHash: string }> {
  assertPrepared(input.prepared);
  await fsp.mkdir(path.dirname(input.routePath), { recursive: true });
  const lockPath = `${input.routePath}.lock`;
  let lock: FileHandle;
  try {
    lock = await fsp.open(lockPath, 'wx', 0o600);
  } catch (error: unknown) {
    if (readCode(error) === 'EEXIST') {
      throw new Error('STRICT_PUBLIC_ROUTE_CAS_BUSY');
    }
    throw error;
  }
  try {
    const current = await inspectPublicRoute(input.routePath);
    if (current?.bytes === input.prepared.bytes && current.hash === input.prepared.hash) {
      return { status: 'recovered', routeHash: current.hash };
    }
    if ((current?.hash ?? null) !== input.expectedCurrentHash) {
      throw new Error('STRICT_PUBLIC_ROUTE_CAS_CONFLICT');
    }
    const tempPath = `${input.routePath}.tmp-${randomUUID()}`;
    const temp = await fsp.open(tempPath, 'wx', 0o600);
    try {
      await temp.writeFile(input.prepared.bytes, 'utf8');
      await temp.sync();
    } finally {
      await temp.close();
    }
    await fsp.rename(tempPath, input.routePath);
    const directory = await fsp.open(path.dirname(input.routePath), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    const readback = await inspectPublicRoute(input.routePath);
    if (
      !readback ||
      readback.hash !== input.prepared.hash ||
      readback.bytes !== input.prepared.bytes
    ) {
      throw new Error('STRICT_PUBLIC_ROUTE_READBACK_DIVERGENCE');
    }
    return { status: 'committed', routeHash: readback.hash };
  } finally {
    await lock.close();
    await fsp.rm(lockPath, { force: true });
  }
}

function assertPrepared(prepared: PreparedPublicRouteBytesV1): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(prepared.bytes);
  } catch {
    throw new Error('STRICT_PUBLIC_ROUTE_PREPARED_INVALID');
  }
  if (hashCanonicalJson(parsed) !== prepared.hash) {
    throw new Error('STRICT_PUBLIC_ROUTE_PREPARED_HASH_MISMATCH');
  }
}

function readCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
