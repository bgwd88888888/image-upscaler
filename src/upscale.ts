import LanczosWorker from './lanczos.worker.ts?worker&inline'
import {
  OUTPUT_LONG_SIDE,
  resizeRgbaLanczos,
  SHARPEN_AMOUNT,
  targetOutputSize,
  type OutputPreset,
  type SharpenLevel,
} from './lanczos.ts'
import type { AiBackend } from './realesrgan.ts'
import RealEsrganWorker from './realesrgan.worker.ts?worker&inline'

export type EnhanceMode = 'classic' | 'ai' | 'ai-max'
export type UpscaleBackend = 'lanczos' | AiBackend

export type UpscaleOptions = {
  mode: EnhanceMode
  preset: OutputPreset
  sharpen: SharpenLevel
}

export type UpscaleStatus =
  | { phase: 'loading' }
  | { phase: 'model-loading'; percent: number }
  | { phase: 'preparing'; percent: number; backend?: AiBackend }
  | { phase: 'resizing'; percent: number }
  | { phase: 'inferencing'; percent: number; backend: AiBackend }
  | { phase: 'finishing'; percent: number; backend: AiBackend }
  | { phase: 'encoding' }
  | {
      phase: 'ready'
      width: number
      height: number
      url: string
      mode: EnhanceMode
      backend: UpscaleBackend
    }
  | { phase: 'error'; message: string }

type WorkerOut =
  | { type: 'progress'; percent: number }
  | {
      type: 'progress'
      stage: 'model' | 'preparing' | 'inferencing' | 'finishing'
      percent: number
      backend?: AiBackend
    }
  | {
      type: 'done'
      width: number
      height: number
      buffer: ArrayBuffer
      backend?: AiBackend
    }
  | { type: 'error'; message: string }

type LoadedPixels = {
  data: ImageData
  originalWidth: number
  originalHeight: number
}

function loadImageData(url: string, maxLongSide?: number): Promise<LoadedPixels> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const originalWidth = img.naturalWidth
      const originalHeight = img.naturalHeight
      const longSide = Math.max(originalWidth, originalHeight)
      const scale = maxLongSide && longSide > maxLongSide ? maxLongSide / longSide : 1
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(originalWidth * scale))
      canvas.height = Math.max(1, Math.round(originalHeight * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('当前浏览器无法读取像素'))
        return
      }
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve({
        data: ctx.getImageData(0, 0, canvas.width, canvas.height),
        originalWidth,
        originalHeight,
      })
    }
    img.onerror = () => reject(new Error('原图加载失败'))
    img.src = url
  })
}

function encodePng(data: ImageData): Promise<string> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas')
    canvas.width = data.width
    canvas.height = data.height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      reject(new Error('当前浏览器无法导出 PNG'))
      return
    }
    ctx.putImageData(data, 0, 0)
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('PNG 编码失败'))
        return
      }
      resolve(URL.createObjectURL(blob))
    }, 'image/png')
  })
}

export function upscaleImage(
  sourceUrl: string,
  { mode, preset, sharpen }: UpscaleOptions,
  onStatus: (status: UpscaleStatus) => void,
): () => void {
  let cancelled = false
  let objectUrl: string | null = null
  let worker: Worker | null = null
  const usesAi = mode !== 'classic'

  const cleanup = () => {
    cancelled = true
    worker?.terminate()
    worker = null
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = null
    }
  }

  void (async () => {
    try {
      onStatus({ phase: 'loading' })
      const source = await loadImageData(sourceUrl, usesAi ? OUTPUT_LONG_SIDE[preset] : undefined)
      if (cancelled) return

      const target = targetOutputSize(source.originalWidth, source.originalHeight, preset)
      const pixels = new Uint8ClampedArray(source.data.data)
      const classicPixels = usesAi ? null : pixels.slice()
      let workerStarted = false

      const finishClassic = async (src: Uint8ClampedArray) => {
        try {
          await new Promise((resolve) => {
            setTimeout(resolve, 0)
          })
          if (cancelled) return
          onStatus({ phase: 'resizing', percent: 0 })
          const out = resizeRgbaLanczos(src, source.data.width, source.data.height, target.width, target.height, {
            sharpen: SHARPEN_AMOUNT[sharpen],
            onProgress: (percent) => {
              if (!cancelled) onStatus({ phase: 'resizing', percent })
            },
          })
          if (cancelled) return
          const raw = out.buffer
          if (!(raw instanceof ArrayBuffer)) throw new Error('经典高清输出缓冲区异常')
          onStatus({ phase: 'encoding' })
          const url = await encodePng(new ImageData(new Uint8ClampedArray(raw, out.byteOffset, out.length), target.width, target.height))
          if (cancelled) {
            URL.revokeObjectURL(url)
            return
          }
          objectUrl = url
          onStatus({
            phase: 'ready',
            width: target.width,
            height: target.height,
            url,
            mode,
            backend: 'lanczos',
          })
        } catch (error) {
          if (cancelled) return
          const message = error instanceof Error ? error.message : '经典高清失败'
          onStatus({ phase: 'error', message })
        }
      }

      if (!usesAi && location.protocol === 'file:') {
        await finishClassic(pixels)
        return
      }

      try {
        worker = usesAi ? new RealEsrganWorker() : new LanczosWorker()
      } catch (error) {
        if (!usesAi && classicPixels) {
          await finishClassic(classicPixels)
          return
        }
        throw error
      }

      worker.onmessage = (event: MessageEvent<WorkerOut>) => {
        if (cancelled) return
        workerStarted = true
        const msg = event.data
        if (msg.type === 'progress') {
          if (!('stage' in msg)) {
            onStatus({ phase: 'resizing', percent: msg.percent })
          } else if (msg.stage === 'model') {
            onStatus({ phase: 'model-loading', percent: msg.percent })
          } else if (msg.stage === 'preparing') {
            onStatus({ phase: 'preparing', percent: msg.percent, backend: msg.backend })
          } else if (msg.stage === 'inferencing' && msg.backend) {
            onStatus({ phase: 'inferencing', percent: msg.percent, backend: msg.backend })
          } else if (msg.stage === 'finishing' && msg.backend) {
            onStatus({ phase: 'finishing', percent: msg.percent, backend: msg.backend })
          }
          return
        }
        if (msg.type === 'error') {
          onStatus({ phase: 'error', message: msg.message })
          worker?.terminate()
          worker = null
          return
        }

        onStatus({ phase: 'encoding' })
        const pixels = new Uint8ClampedArray(msg.buffer)
        const image = new ImageData(pixels, msg.width, msg.height)
        void encodePng(image)
          .then((url) => {
            if (cancelled) {
              URL.revokeObjectURL(url)
              return
            }
            objectUrl = url
            onStatus({
              phase: 'ready',
              width: msg.width,
              height: msg.height,
              url,
              mode,
              backend: usesAi ? (msg.backend ?? 'wasm') : 'lanczos',
            })
          })
          .catch((error: unknown) => {
            if (cancelled) return
            const message = error instanceof Error ? error.message : 'PNG 编码失败'
            onStatus({ phase: 'error', message })
          })
          .finally(() => {
            worker?.terminate()
            worker = null
          })
      }

      worker.onerror = () => {
        if (cancelled || workerStarted) return
        worker?.terminate()
        worker = null
        if (!usesAi && classicPixels) {
          void finishClassic(classicPixels)
          return
        }
        onStatus({
          phase: 'error',
          message: 'AI Worker 运行失败，请切换经典高清重试',
        })
      }

      const request =
        usesAi
          ? {
              type: 'resize',
              width: source.data.width,
              height: source.data.height,
              dstWidth: target.width,
              dstHeight: target.height,
              buffer: pixels.buffer,
              assetBaseUrl: new URL(import.meta.env.BASE_URL, window.location.origin).href,
              forceWasm: new URLSearchParams(window.location.search).get('ai-backend') === 'wasm',
              detailProfile: mode === 'ai-max' ? 'max' : 'balanced',
            }
          : {
              type: 'resize',
              width: source.data.width,
              height: source.data.height,
              dstWidth: target.width,
              dstHeight: target.height,
              sharpen: SHARPEN_AMOUNT[sharpen],
              buffer: pixels.buffer,
            }
      onStatus(usesAi ? { phase: 'model-loading', percent: 0 } : { phase: 'resizing', percent: 0 })
      worker.postMessage(request, [pixels.buffer])
    } catch (error) {
      if (cancelled) return
      const message = error instanceof Error ? error.message : '无法开始放大'
      onStatus({ phase: 'error', message })
    }
  })()

  return cleanup
}
