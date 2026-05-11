import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import type { Socket } from 'net'

// ── EPIPE/ECONNRESET 静默 ──────────────────────────────────────
// 问题: Vite 内部在 proxyReqWs 事件上注册 socket.on('error', logger),
// 注册顺序在 opts.configure() 之后。Node EventEmitter 会调用所有 listener,
// 用户添加的空 handler 无法阻止 Vite 的 logger.error() 输出。
// 解决: monkey-patch socket.emit, 在事件分发层面拦截 EPIPE/ECONNRESET,
// 使错误不到达任何 handler (包括 Vite 内部的)。
function silenceSocketEpipe(socket: Socket) {
  const origEmit = socket.emit.bind(socket)
  socket.emit = function (event: string, ...args: unknown[]) {
    if (event === 'error') {
      const err = args[0] as NodeJS.ErrnoException | undefined
      if (err?.code === 'EPIPE' || err?.code === 'ECONNRESET') {
        return true // 吞掉, 不传播给任何 listener
      }
    }
    return origEmit(event, ...args)
  } as Socket['emit']
  return socket
}

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        timeout: 300000,      // 5 分钟（AI 扫描需要较长时间）
        configure: (proxy) => {
          proxy.on('error', (err) => {
            if (err.message?.includes('EPIPE') || err.message?.includes('ECONNRESET')) return;
            console.log('[vite-proxy] error:', err.message);
          });
          // configure 中注册的 proxyReqWs 先于 Vite 内部的注册,
          // 在此 patch socket.emit 可拦截后续所有 error 事件
          proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
            silenceSocketEpipe(socket as Socket);
          });
        },
      },
      '/socket.io': {
        target: 'http://127.0.0.1:3000',
        ws: true,             // WebSocket 升级
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('error', () => {});
          proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
            silenceSocketEpipe(socket as Socket);
          });
        },
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('framer-motion')) return 'framer-motion';
          if (id.includes('lucide-react')) return 'icons';
          if (id.includes('axios')) return 'axios';
          if (id.includes('yaml')) return 'yaml';
          // react-syntax-highlighter 与 refractor/prismjs 有复杂的内部依赖
          // 单独拆分会产生循环引用 TDZ 错误，让它们跟随 vendor 一起打包
          return 'vendor';
        }
      }
    }
  }
})
