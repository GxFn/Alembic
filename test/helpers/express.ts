import type { NextFunction, Request, Response, Router } from 'express';

export interface InvokeRouterOptions {
  method?: string;
  mountPath?: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface InvokeRouterResult {
  status: number;
  body: Record<string, unknown>;
  text: string;
  headers: Record<string, string>;
}

type TestResponse = Response & {
  statusCode: number;
  locals: Record<string, unknown>;
};

export async function getRouter(
  router: Router,
  path: string,
  options: Omit<InvokeRouterOptions, 'method' | 'path'> = {}
): Promise<InvokeRouterResult> {
  return invokeRouter(router, { ...options, method: 'GET', path });
}

export async function invokeRouter(
  router: Router,
  {
    method = 'GET',
    mountPath = '',
    path,
    body,
    headers = {},
    timeoutMs = 1_000,
  }: InvokeRouterOptions
): Promise<InvokeRouterResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const chunks: Buffer[] = [];
    const responseHeaders: Record<string, string> = {};
    const url = new URL(path, 'http://alembic.test');
    const routeUrl = routeUrlFor(url, mountPath);

    const timer = setTimeout(() => {
      finish(
        reject,
        new Error(`Express test request timed out after ${timeoutMs}ms: ${method} ${path}`)
      );
    }, timeoutMs);
    timer.unref?.();

    const finish = (
      complete: typeof resolve | typeof reject,
      value: InvokeRouterResult | Error
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      complete(value as never);
    };

    const req = {
      body,
      headers,
      method: method.toUpperCase(),
      url: routeUrl,
      originalUrl: url.pathname + url.search,
      baseUrl: mountPath,
      params: {},
      query: queryObject(url.searchParams),
      get(name: string) {
        return headers[name.toLowerCase()] ?? headers[name];
      },
    } as unknown as Request;

    const res = {
      statusCode: 200,
      locals: {},
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      set(field: string | Record<string, string>, value?: string) {
        if (typeof field === 'string') {
          responseHeaders[field.toLowerCase()] = value ?? '';
        } else {
          for (const [key, headerValue] of Object.entries(field)) {
            responseHeaders[key.toLowerCase()] = headerValue;
          }
        }
        return this;
      },
      header(field: string | Record<string, string>, value?: string) {
        return this.set(field, value);
      },
      setHeader(field: string, value: number | string | readonly string[]) {
        responseHeaders[field.toLowerCase()] = Array.isArray(value)
          ? value.join(', ')
          : String(value);
      },
      getHeader(field: string) {
        return responseHeaders[field.toLowerCase()];
      },
      type(value: string) {
        responseHeaders['content-type'] = value;
        return this;
      },
      write(chunk: unknown) {
        chunks.push(toBuffer(chunk));
        return true;
      },
      end(chunk?: unknown) {
        if (chunk !== undefined) {
          chunks.push(toBuffer(chunk));
        }
        const text = Buffer.concat(chunks).toString('utf8');
        finish(resolve, {
          status: this.statusCode,
          body: parseJsonObject(text),
          text,
          headers: responseHeaders,
        });
        return this;
      },
      json(payload: Record<string, unknown>) {
        responseHeaders['content-type'] = 'application/json; charset=utf-8';
        return this.end(JSON.stringify(payload));
      },
      send(payload?: unknown) {
        if (typeof payload === 'object' && payload !== null && !Buffer.isBuffer(payload)) {
          return this.json(payload as Record<string, unknown>);
        }
        return this.end(payload);
      },
      sendStatus(code: number) {
        this.statusCode = code;
        return this.end(String(code));
      },
    } as TestResponse;

    const next: NextFunction = (err?: unknown) => {
      if (err) {
        finish(reject, err instanceof Error ? err : new Error(String(err)));
        return;
      }
      finish(reject, new Error(`No Express route handled: ${method} ${path}`));
    };

    try {
      router.handle(req, res, next);
    } catch (err) {
      finish(reject, err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function routeUrlFor(url: URL, mountPath: string): string {
  if (!mountPath) {
    return url.pathname + url.search;
  }
  if (!url.pathname.startsWith(mountPath)) {
    throw new Error(`Test request path "${url.pathname}" does not start with "${mountPath}"`);
  }
  const routePath = url.pathname.slice(mountPath.length) || '/';
  return routePath + url.search;
}

function queryObject(searchParams: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of searchParams) {
    const existing = query[key];
    if (existing === undefined) {
      query[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      query[key] = [existing, value];
    }
  }
  return query;
}

function parseJsonObject(text: string): Record<string, unknown> {
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  return Buffer.from(String(chunk));
}
