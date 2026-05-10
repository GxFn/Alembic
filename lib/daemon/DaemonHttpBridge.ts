import http from "node:http";
import type { AddressInfo } from "node:net";
import { DaemonJobRunner } from "./DaemonJobRunner.js";
import { type DaemonState, daemonBaseUrl } from "./DaemonState.js";
import { type DaemonJobKind, JsonDaemonJobStore } from "./JobStore.js";

export interface DaemonHttpBridgeOptions {
  readonly state: DaemonState | (() => DaemonState);
  readonly host?: string;
  readonly requestedPort?: number;
}

export interface DaemonHttpBridgeHandle {
  readonly server: http.Server;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export async function startDaemonHttpBridge(
  options: DaemonHttpBridgeOptions,
): Promise<DaemonHttpBridgeHandle> {
  const host = options.host ?? "127.0.0.1";
  const stateProvider =
    typeof options.state === "function" ? options.state : () => options.state as DaemonState;
  const jobStore = new JsonDaemonJobStore(stateProvider().dataRoot);
  const jobRunner = new DaemonJobRunner(jobStore);
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
  const url = new URL(request.url ?? "/", daemonBaseUrl(state));
  const method = request.method ?? "GET";

  if (method === "GET" && url.pathname === "/api/v1/daemon/health") {
    writeJson(response, 200, { success: true, data: { ...state, mode: "daemon" } });
    return;
  }

  if (method === "GET" && url.pathname === "/api/v1/jobs") {
    writeJson(response, 200, { success: true, data: { jobs: await jobStore.list() } });
    return;
  }

  const jobMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/);
  if (method === "GET" && jobMatch?.[1]) {
    const job = await jobStore.get(jobMatch[1]);
    writeJson(response, job ? 200 : 404, job ? { success: true, data: { job } } : notFound());
    return;
  }

  if (method === "POST" && jobMatch?.[1] && url.pathname.endsWith("/cancel")) {
    writeJson(response, 404, notFound());
    return;
  }

  const cancelMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)\/cancel$/);
  if (method === "POST" && cancelMatch?.[1]) {
    const job = await jobRunner.cancel(cancelMatch[1]);
    writeJson(response, 200, { success: true, data: { job } });
    return;
  }

  const enqueueMatch = url.pathname.match(/^\/api\/v1\/jobs\/(bootstrap|rescan)$/);
  if (method === "POST" && enqueueMatch?.[1]) {
    const input = await readRequestJson(request);
    const job = await jobRunner.enqueue({
      kind: enqueueMatch[1] as DaemonJobKind,
      input: isRecord(input) ? input : {},
    });
    writeJson(response, 202, { success: true, data: { job } });
    return;
  }

  writeJson(response, 404, notFound());
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
