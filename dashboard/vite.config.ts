import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        timeout: 300000,      // 5 分钟（AI 扫描需要较长时间）
        configure: (proxy) => {
          proxy.on('error', (err) => {
            console.log('[vite-proxy] error:', err.message);
          });
        },
      },
      '/socket.io': {
        target: 'http://127.0.0.1:3000',
        ws: true,             // WebSocket 升级
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('error', () => {});  // 静默 EPIPE / 连接重置错误
        },
      },
    }
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
