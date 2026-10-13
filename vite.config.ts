import fs from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const PHONE_ASSETS = '\0virtual:phone-assets'
const PHONE_FILE = '本地转2K.html'

function phonePack(): Plugin {
  return {
    name: 'phone-pack',
    resolveId(id) {
      if (id === 'virtual:phone-assets') return PHONE_ASSETS
    },
    load(id) {
      if (id !== PHONE_ASSETS) return
      if (this.environment.config.mode !== 'phone') return 'export default null\n'
      const root = this.environment.config.root
      const read = (rel: string) => fs.readFileSync(path.join(root, rel)).toString('base64')
      return `export default ${JSON.stringify({
        wasm: read('public/ort/ort-wasm-simd-threaded.asyncify.wasm'),
        mjs: read('public/ort/ort-wasm-simd-threaded.asyncify.mjs'),
        model: read('public/models/real_esrgan_general_x4v3.onnx'),
        modelData: read('public/models/real_esrgan_general_x4v3.data'),
      })}\n`
    },
    closeBundle() {
      const env = this.environment.config
      if (env.mode !== 'phone' || env.isWorker) return
      const dist = path.resolve(env.root, env.build.outDir)
      const htmlPath = path.join(dist, 'index.html')
      if (!fs.existsSync(htmlPath)) return
      let html = fs.readFileSync(htmlPath, 'utf8')
      html = html.replace(/<link rel="modulepreload"[^>]*>/g, '')
      html = html.replace(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_match, href: string) => {
        const css = fs.readFileSync(resolveDistFile(dist, href), 'utf8')
        return `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`
      })
      html = html.replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_match, src: string) => {
        let js = fs.readFileSync(resolveDistFile(dist, src), 'utf8')
        js = js.replaceAll('(self.URL || self.webkitURL).revokeObjectURL(self.location.href);', '')
        js = js.replaceAll('URL.revokeObjectURL(import.meta.url);', '')
        return `<script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script>`
      })
      if (html.includes('src="./assets/') || html.includes('src="/assets/')) {
        throw new Error('手机包仍在引用外部脚本，单文件打包失败')
      }
      fs.writeFileSync(path.join(env.root, PHONE_FILE), html)
    },
  }
}

function resolveDistFile(dist: string, url: string) {
  return path.join(dist, url.replace(/^\.\//, '').replace(/^\//, ''))
}

export default defineConfig(({ mode }) => {
  const phone = mode === 'phone'
  return {
    plugins: [react(), phonePack()],
    resolve: {
      conditions: ['onnxruntime-web-use-extern-wasm'],
    },
    base: phone ? './' : '/',
    worker: {
      format: 'iife',
      plugins: () => [phonePack()],
    },
    build: phone
      ? {
          cssCodeSplit: false,
          modulePreload: false,
          chunkSizeWarningLimit: 100000,
        }
      : undefined,
    server: {
      host: '0.0.0.0',
      port: 43180,
      strictPort: true,
    },
    preview: {
      host: '0.0.0.0',
      port: 43180,
      strictPort: true,
    },
  }
})
