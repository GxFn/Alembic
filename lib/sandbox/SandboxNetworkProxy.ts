import http from 'node:http';
import net from 'node:net';
import Logger from '#infra/logging/Logger.js';

/**
 * 域名白名单 HTTP/HTTPS CONNECT 代理。
 *
 * 工作原理:
 *   1. 沙箱 SBPL 仅允许连接 localhost:<proxyPort>
 *   2. 进程通过 http_proxy / https_proxy 指向此代理
 *   3. 代理接收 CONNECT 请求，检查目标域名是否在白名单
 *   4. 白名单内 → 建立 TCP 隧道；白名单外 → 403 拒绝
 *
 * 生命周期由 SandboxExecutor 管理：执行前 start()，执行后 stop()。
 */

export interface ProxyOptions {
  allowedDomains: string[];
  port?: number;
}

export interface ProxyHandle {
  port: number;
  address: string;
  stop: () => Promise<void>;
  connections: number;
  blocked: number;
}

export function startSandboxProxy(options: ProxyOptions): Promise<ProxyHandle> {
  return new Promise((resolve, reject) => {
    const domainSet = new Set(options.allowedDomains.map((d) => d.toLowerCase()));
    let connections = 0;
    let blocked = 0;

    const server = http.createServer((_req, res) => {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Only CONNECT method is supported');
    });

    server.on('connect', (req, clientSocket, head) => {
      const target = req.url || '';
      const [hostname, portStr] = target.split(':');
      const port = Number.parseInt(portStr || '443', 10);

      if (!isDomainAllowed(hostname, domainSet)) {
        blocked++;
        Logger.info(`[SandboxProxy] blocked: ${hostname}:${port}`);
        clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        clientSocket.end();
        return;
      }

      connections++;
      const serverSocket = net.connect(port, hostname, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        serverSocket.write(head);
        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);
      });

      serverSocket.on('error', (err) => {
        Logger.warn(`[SandboxProxy] upstream error for ${hostname}:${port}: ${err.message}`);
        clientSocket.end();
      });
      clientSocket.on('error', () => {
        serverSocket.destroy();
      });
    });

    server.on('error', reject);

    server.listen(options.port || 0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind proxy'));
        return;
      }
      const handle: ProxyHandle = {
        port: addr.port,
        address: `127.0.0.1:${addr.port}`,
        get connections() {
          return connections;
        },
        get blocked() {
          return blocked;
        },
        stop: () =>
          new Promise<void>((res) => {
            server.close(() => res());
            setTimeout(() => res(), 2000);
          }),
      };
      Logger.info(
        `[SandboxProxy] started on 127.0.0.1:${addr.port} (${domainSet.size} allowed domains)`
      );
      resolve(handle);
    });
  });
}

/**
 * 域名匹配：精确匹配或通配子域名。
 * 白名单 'github.com' 允许 'github.com' 和 'api.github.com'。
 */
function isDomainAllowed(hostname: string, allowed: Set<string>): boolean {
  const h = hostname.toLowerCase();
  if (allowed.has(h)) {
    return true;
  }
  for (const d of allowed) {
    if (h.endsWith(`.${d}`)) {
      return true;
    }
  }
  return false;
}
