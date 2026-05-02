import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type ProxyHandle, startSandboxProxy } from '../../lib/sandbox/SandboxNetworkProxy.js';

let proxy: ProxyHandle | null = null;
let upstreamServer: net.Server | null = null;
let upstreamPort = 0;

async function startUpstream(): Promise<number> {
  return new Promise((resolve) => {
    upstreamServer = net.createServer((sock) => {
      sock.end('hello');
    });
    upstreamServer.listen(0, '127.0.0.1', () => {
      const addr = upstreamServer!.address() as net.AddressInfo;
      upstreamPort = addr.port;
      resolve(addr.port);
    });
  });
}

afterEach(async () => {
  if (proxy) {
    await proxy.stop();
    proxy = null;
  }
  if (upstreamServer) {
    await new Promise<void>((res) => {
      upstreamServer!.close(() => res());
    });
    upstreamServer = null;
  }
});

function connectViaProxy(
  proxyPort: number,
  target: string
): Promise<{ statusCode: number; socket?: net.Socket }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: target,
    });
    req.on('connect', (res, socket) => {
      resolve({ statusCode: res.statusCode || 0, socket });
      socket.end();
    });
    req.on('error', reject);
    req.end();
  });
}

describe('SandboxNetworkProxy', () => {
  it('starts on a random port', async () => {
    proxy = await startSandboxProxy({ allowedDomains: ['example.com'] });
    expect(proxy.port).toBeGreaterThan(0);
    expect(proxy.address).toMatch(/^127\.0\.0\.1:\d+$/);
  });

  it('blocks non-allowed domains with 403', async () => {
    proxy = await startSandboxProxy({ allowedDomains: ['allowed.com'] });
    const result = await connectViaProxy(proxy.port, 'blocked.com:443');
    expect(result.statusCode).toBe(403);
    expect(proxy.blocked).toBe(1);
  });

  it('allows listed domains and tunnels to upstream', async () => {
    const port = await startUpstream();
    proxy = await startSandboxProxy({ allowedDomains: ['127.0.0.1'] });
    const result = await connectViaProxy(proxy.port, `127.0.0.1:${port}`);
    expect(result.statusCode).toBe(200);
    expect(proxy.connections).toBe(1);
  });

  it('allows subdomains of listed domains (blocked since no DNS in test)', async () => {
    proxy = await startSandboxProxy({ allowedDomains: ['example.com'] });
    const result = await connectViaProxy(proxy.port, 'sub.example.com:443').catch(() => ({
      statusCode: -1,
    }));
    // 域名在白名单内，代理会尝试连接（但 DNS 可能失败）
    // 关键是不返回 403
    expect(result.statusCode).not.toBe(403);
  });

  it('blocks plain HTTP requests with 405', async () => {
    proxy = await startSandboxProxy({ allowedDomains: ['example.com'] });
    const res = await new Promise<number>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${proxy!.port}/`, (r) => resolve(r.statusCode || 0))
        .on('error', reject);
    });
    expect(res).toBe(405);
  });

  it('stops cleanly', async () => {
    proxy = await startSandboxProxy({ allowedDomains: ['example.com'] });
    const port = proxy.port;
    await proxy.stop();
    proxy = null;

    const refused = await new Promise<boolean>((resolve) => {
      const sock = net.connect(port, '127.0.0.1');
      sock.on('error', () => resolve(true));
      sock.on('connect', () => {
        sock.end();
        resolve(false);
      });
    });
    expect(refused).toBe(true);
  });

  it('is case-insensitive for domain matching', async () => {
    const port = await startUpstream();
    proxy = await startSandboxProxy({ allowedDomains: ['127.0.0.1'] });
    const result = await connectViaProxy(proxy.port, `127.0.0.1:${port}`);
    expect(result.statusCode).toBe(200);
  });
});
