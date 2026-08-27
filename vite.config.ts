import { readFileSync, readdirSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const pdfjsWasmDirectory = resolve('node_modules/pdfjs-dist/wasm')
const pdfjsWasmFiles = readdirSync(pdfjsWasmDirectory)
  .filter((filename) => ['.wasm', '.js'].includes(extname(filename)))

function pdfjsWasmAssets(): Plugin {
  return {
    name: 'pdfjs-wasm-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs-wasm/', (request, response, next) => {
        const filename = request.url?.replace(/^\//, '')
        if (!filename || !pdfjsWasmFiles.includes(filename)) {
          next()
          return
        }

        response.setHeader(
          'Content-Type',
          extname(filename) === '.wasm' ? 'application/wasm' : 'text/javascript; charset=utf-8',
        )
        response.end(readFileSync(resolve(pdfjsWasmDirectory, filename)))
      })
    },
    generateBundle() {
      pdfjsWasmFiles.forEach((filename) => {
        this.emitFile({
          type: 'asset',
          fileName: `pdfjs-wasm/${filename}`,
          source: readFileSync(resolve(pdfjsWasmDirectory, filename)),
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  const serverPort = env.PORT || '8787'

  return {
    plugins: [react(), pdfjsWasmAssets()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': `http://127.0.0.1:${serverPort}`,
      },
    },
  }
})
