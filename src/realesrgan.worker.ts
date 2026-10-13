import * as ort from 'onnxruntime-web/webgpu'
import { resizeRgbaLanczos } from './lanczos.ts'
import {
  AI_DETAIL_PROFILE,
  AI_MODEL_NAME,
  AI_OUTPUT_TILE_SIZE,
  AI_TILE_SIZE,
  aiInputSize,
  compositeAiTile,
  extractAiTile,
  planAiTiles,
  type AiBackend,
  type AiDetailProfile,
} from './realesrgan.ts'

type AiResizeRequest = {
  type: 'resize'
  width: number
  height: number
  dstWidth: number
  dstHeight: number
  buffer: ArrayBuffer
  assetBaseUrl: string
  forceWasm: boolean
  detailProfile: AiDetailProfile
}

type AiStage = 'model' | 'preparing' | 'inferencing' | 'finishing'

type ProgressMessage = {
  type: 'progress'
  stage: AiStage
  percent: number
  backend?: AiBackend
}

type DoneMessage = {
  type: 'done'
  width: number
  height: number
  backend: AiBackend
  buffer: ArrayBuffer
}

type ErrorMessage = { type: 'error'; message: string }

const MODEL_FILE = 'real_esrgan_general_x4v3.onnx'
const MODEL_DATA_FILE = 'real_esrgan_general_x4v3.data'

addEventListener('message', (event: MessageEvent<AiResizeRequest>) => {
  const request = event.data
  if (!request || request.type !== 'resize') return

  void run(request).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : '未知错误'
    const message: ErrorMessage = { type: 'error', message: `AI 超清失败：${reason}` }
    postMessage(message)
  })
})

async function run(request: AiResizeRequest) {
  const base = ensureTrailingSlash(request.assetBaseUrl)
  const modelBase = new URL('models/', base)
  const runtimeBase = new URL('ort/', base)

  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
  ort.env.wasm.wasmPaths = runtimeBase.href
  ort.env.webgpu.powerPreference = 'high-performance'

  postProgress('model', 0)
  const model = await fetchBytes(new URL(MODEL_FILE, modelBase), (percent) => {
    postProgress('model', Math.round(percent * 0.04))
  })
  const modelData = await fetchBytes(new URL(MODEL_DATA_FILE, modelBase), (percent) => {
    postProgress('model', 4 + Math.round(percent * 0.96))
  })

  const source = new Uint8ClampedArray(request.buffer)
  postProgress('preparing', 0)
  const classic = resizeRgbaLanczos(
    source,
    request.width,
    request.height,
    request.dstWidth,
    request.dstHeight,
    {
      onProgress: (percent) => postProgress('preparing', Math.round(percent * 0.65)),
    },
  )

  const inputSize = aiInputSize(request.dstWidth, request.dstHeight)
  const aiInput = resizeRgbaLanczos(
    source,
    request.width,
    request.height,
    inputSize.width,
    inputSize.height,
    {
      onProgress: (percent) => postProgress('preparing', 65 + Math.round(percent * 0.35)),
    },
  )

  let backend: AiBackend = request.forceWasm || !('gpu' in navigator) ? 'wasm' : 'webgpu'
  let session: ort.InferenceSession
  try {
    session = await createSession(backend, model, modelData)
  } catch (error) {
    if (backend === 'wasm') throw error
    backend = 'wasm'
    postProgress('preparing', 100, backend)
    session = await createSession(backend, model, modelData)
  }

  const tiles = planAiTiles(inputSize.width, inputSize.height)
  const detail = AI_DETAIL_PROFILE[request.detailProfile]
  postProgress('inferencing', 0, backend)

  try {
    for (let index = 0; index < tiles.length; index++) {
      const tile = tiles[index]
      const tensorData = extractAiTile(aiInput, inputSize.width, inputSize.height, tile)
      let output: Float32Array

      try {
        output = await inferTile(session, tensorData)
      } catch (error) {
        if (backend === 'wasm') throw error
        await session.release()
        backend = 'wasm'
        postProgress('preparing', 100, backend)
        session = await createSession(backend, model, modelData)
        output = await inferTile(session, tensorData)
      }

      compositeAiTile(
        output,
        aiInput,
        inputSize.width,
        inputSize.height,
        classic,
        request.dstWidth,
        request.dstHeight,
        tile,
        detail.strength,
        detail.limit,
      )
      postProgress('inferencing', Math.round(((index + 1) / tiles.length) * 100), backend)
    }
  } finally {
    await session.release()
  }

  postProgress('finishing', 100, backend)
  const raw = classic.buffer
  if (!(raw instanceof ArrayBuffer)) throw new Error('AI 输出缓冲区异常')

  const done: DoneMessage = {
    type: 'done',
    width: request.dstWidth,
    height: request.dstHeight,
    backend,
    buffer: raw,
  }
  const send = postMessage as (message: unknown, transfer?: Transferable[]) => void
  send(done, [raw])
}

async function createSession(
  backend: AiBackend,
  model: Uint8Array,
  modelData: Uint8Array,
): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(model, {
    executionProviders: [backend],
    graphOptimizationLevel: 'all',
    externalData: [{ path: MODEL_DATA_FILE, data: modelData }],
  })
}

async function inferTile(session: ort.InferenceSession, data: Float32Array) {
  const input = new ort.Tensor('float32', data, [1, 3, AI_TILE_SIZE, AI_TILE_SIZE])
  try {
    const outputs = await session.run({ [session.inputNames[0]]: input })
    const tensor = outputs[session.outputNames[0]]
    if (!tensor) throw new Error(`${AI_MODEL_NAME} 没有返回图像`)
    try {
      if (
        tensor.dims.length !== 4 ||
        tensor.dims[1] !== 3 ||
        tensor.dims[2] !== AI_OUTPUT_TILE_SIZE ||
        tensor.dims[3] !== AI_OUTPUT_TILE_SIZE
      ) {
        throw new Error(`模型输出尺寸异常：${tensor.dims.join('×')}`)
      }
      const output = await tensor.getData()
      if (!(output instanceof Float32Array)) throw new Error('模型输出格式不是 float32')
      return output
    } finally {
      tensor.dispose()
    }
  } finally {
    input.dispose()
  }
}

async function fetchBytes(url: URL, onProgress: (percent: number) => void): Promise<Uint8Array> {
  const response = await fetch(url, { cache: 'force-cache' })
  if (!response.ok) throw new Error(`模型加载失败（HTTP ${response.status}）`)

  const length = Number(response.headers.get('content-length')) || 0
  if (!response.body || length === 0) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    onProgress(100)
    return bytes
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.byteLength
    onProgress(Math.min(100, Math.round((received / length) * 100)))
  }

  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  onProgress(100)
  return bytes
}

function postProgress(stage: AiStage, percent: number, backend?: AiBackend) {
  const message: ProgressMessage = { type: 'progress', stage, percent, backend }
  postMessage(message)
}

function ensureTrailingSlash(url: string) {
  return url.endsWith('/') ? url : `${url}/`
}
