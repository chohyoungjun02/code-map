import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { geminiProxy } from './server/gemini-proxy.js'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // No VITE_ prefix on purpose: only the server sees GEMINI_API_KEY, it is never bundled into the page.
  const { GEMINI_API_KEY } = loadEnv(mode, process.cwd(), '')
  return { plugins: [react(), geminiProxy(GEMINI_API_KEY)] }
})
