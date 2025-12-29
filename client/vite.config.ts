import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    // Windows 上部分低端口可能被系统保留/禁用（EACCES），默认改用更安全的 5180。
    // 可通过环境变量覆盖：$env:VITE_PORT="5180"
    port: Number(process.env.VITE_PORT) || 5180,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/ws': {
        // vite/http-proxy 这里使用 http(s) target，配合 ws:true 才能稳定代理 WebSocket
        target: 'http://localhost:4000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
