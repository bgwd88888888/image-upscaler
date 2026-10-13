import { resizeRgbaLanczos } from './lanczos.ts'

type ResizeRequest = {
  type: 'resize'
  width: number
  height: number
  dstWidth: number
  dstHeight: number
  sharpen: number
  buffer: ArrayBuffer
}

type ProgressMessage = { type: 'progress'; percent: number }
type DoneMessage = { type: 'done'; width: number; height: number; buffer: ArrayBuffer }
type ErrorMessage = { type: 'error'; message: string }

addEventListener('message', (event: MessageEvent<ResizeRequest>) => {
  const data = event.data
  if (!data || data.type !== 'resize') return

  try {
    const src = new Uint8ClampedArray(data.buffer)
    const out = resizeRgbaLanczos(src, data.width, data.height, data.dstWidth, data.dstHeight, {
      sharpen: data.sharpen,
      onProgress: (percent) => {
        const msg: ProgressMessage = { type: 'progress', percent }
        postMessage(msg)
      },
    })
    const raw = out.buffer
    if (!(raw instanceof ArrayBuffer)) {
      throw new Error('unexpected buffer type')
    }
    const msg: DoneMessage = {
      type: 'done',
      width: data.dstWidth,
      height: data.dstHeight,
      buffer: raw,
    }
    const post = postMessage as (message: unknown, transfer?: Transferable[]) => void
    post(msg, [raw])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Lanczos 放大失败'
    const msg: ErrorMessage = { type: 'error', message }
    postMessage(msg)
  }
})
