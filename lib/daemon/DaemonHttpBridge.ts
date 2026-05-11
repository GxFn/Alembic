import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  type DaemonJobHandler,
  DaemonJobRunner,
  type DaemonJobRunnerOptions,
} from "./DaemonJobRunner.js";
import { type DaemonState, daemonBaseUrl } from "./DaemonState.js";
import { type DaemonJobKind, JsonDaemonJobStore } from "./JobStore.js";

export interface DaemonHttpBridgeOptions {
  readonly state: DaemonState | (() => DaemonState);
  readonly host?: string;
  readonly requestedPort?: number;
  readonly jobHandlers?: Partial<Record<DaemonJobKind, DaemonJobHandler>>;
  readonly autoRunJobs?: boolean;
}

export interface DaemonHttpBridgeHandle {
  readonly server: http.Server;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export interface DaemonHttpBridgeRouteInput {
  readonly method: string;
  readonly path: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body?: unknown;
  readonly stateProvider: () => DaemonState;
  readonly jobStore: JsonDaemonJobStore;
  readonly jobRunner: DaemonJobRunner;
}

export interface DaemonHttpBridgeRouteResult {
  readonly statusCode: number;
  readonly body: unknown;
}

export async function startDaemonHttpBridge(
  options: DaemonHttpBridgeOptions,
): Promise<DaemonHttpBridgeHandle> {
  const host = options.host ?? "127.0.0.1";
  const stateProvider =
    typeof options.state === "function" ? options.state : () => options.state as DaemonState;
  const jobStore = new JsonDaemonJobStore(stateProvider().dataRoot);
  const runnerOptions: DaemonJobRunnerOptions = {
    ...(options.jobHandlers ? { handlers: options.jobHandlers } : {}),
    ...(options.autoRunJobs !== undefined ? { autoStart: options.autoRunJobs } : {}),
  };
  const jobRunner = new DaemonJobRunner(jobStore, runnerOptions);
  const server = http.createServer((request, response) => {
    handleRequest(request, response, stateProvider, jobStore, jobRunner).catch((error: unknown) => {
      writeJson(response, 500, {
        success: false,
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    });
  });

  await listen(server, options.requestedPort ?? 0, host);
  const port = listeningPort(server);
  return {
    server,
    port,
    url: daemonBaseUrl({ port }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  stateProvider: () => DaemonState,
  jobStore: JsonDaemonJobStore,
  jobRunner: DaemonJobRunner,
): Promise<void> {
  const state = stateProvider();
  if (!isAuthorizedDaemonRequestHeaders(request.headers, state.token)) {
    writeJson(response, 401, {
      success: false,
      error: { message: "Unauthorized daemon request" },
    });
    return;
  }

  const route = await handleDaemonHttpBridgeRequest({
    method: request.method ?? "GET",
    path: request.url ?? "/",
    headers: request.headers,
    body: request.method === "POST" ? await readRequestJson(request) : undefined,
    stateProvider: () => state,
    jobStore,
    jobRunner,
  });
  writeJson(response, route.statusCode, route.body);
}

export async function handleDaemonHttpBridgeRequest(
  input: DaemonHttpBridgeRouteInput,
): Promise<DaemonHttpBridgeRouteResult> {
  const state = input.stateProvider();
  const url = new URL(input.path, daemonBaseUrl(state));
  const method = input.method;

  if (!isAuthorizedDaemonRequestHeaders(input.headers, state.token)) {
    return jsonRoute(401, {
      success: false,
      error: { message: "Unauthorized daemon request" },
    });
  }

  if (method === "GET" && url.pathname === "/api/v1/daemon/health") {
    return jsonRoute(200, { success: true, data: { ...state, mode: "daemon" } });
  }

  if (method === "GET" && url.pathname === "/api/v1/jobs") {
    return jsonRoute(200, { success: true, data: { jobs: await input.jobStore.list() } });
  }

  const jobMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/);
  if (method === "GET" && jobMatch?.[1]) {
    const job = await input.jobStore.get(jobMatch[1]);
    return jsonRoute(job ? 200 : 404, job ? { success: true, data: { job } } : notFound());
  }

  if (method === "POST" && jobMatch?.[1] && url.pathname.endsWith("/cancel")) {
    return jsonRoute(404, notFound());
  }

  const cancelMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/cancel$/);
  if (method === "POST" && cancelMatch?.[1]) {
    const job = await input.jobRunner.cancel(cancelMatch[1]);
    return jsonRoute(200, { success: true, data: { job } });
  }

  const enqueueMatch = url.pathname.match(/^\/api\/v1\/jobs\/(bootstrap|rescan)$/);
  if (method === "POST" && enqueueMatch?.[1]) {
    const job = await input.jobRunner.enqueue({
      kind: enqueueMatch[1] as DaemonJobKind,
      input: isRecord(input.body) ? input.body : {},
    });
    return jsonRoute(202, { success: true, data: { job } });
  }

  return jsonRoute(404, notFound());
}

function jsonRoute(statusCode: number, body: unknown): DaemonHttpBridgeRouteResult {
  return { statusCode, body };
}

function notFound() {
  return { success: false, error: { message: "Not found" } };
}

async function readRequestJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as unknown;
}

function writeJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function listeningPort(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Daemon HTTP bridge did not bind to a TCP port.");
  }
  return (address as AddressInfo).port;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAuthorizedDaemonRequestHeaders(
  headers: http.IncomingHttpHeaders,
  expectedToken: string,
): boolean {
  const headerToken = firstHeaderValue(headers["x-alembic-daemon-token"]);
  if (headerToken === expectedToken) {
    return true;
  }
  const authorization = firstHeaderValue(headers.authorization);
  return authorization === `Bearer ${expectedToken}`;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
