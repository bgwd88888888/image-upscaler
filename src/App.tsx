import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import {
  OUTPUT_LABEL,
  SHARPEN_LABEL,
  targetOutputSize,
  type OutputPreset,
  type SharpenLevel,
} from './lanczos.ts'
import {
  upscaleImage,
  type EnhanceMode,
  type UpscaleBackend,
  type UpscaleStatus,
} from './upscale.ts'
import Lightbox from './Lightbox.tsx'

type SourceImage = {
  fileName: string
  url: string
  width: number
  height: number
}

type MainView = 'original' | 'output'

const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/bmp,image/avif,image/heic,image/heif'
const SHARPEN_LEVELS: SharpenLevel[] = ['off', 'light', 'strong']

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const [source, setSource] = useState<SourceImage | null>(null)
  const [mode, setMode] = useState<EnhanceMode>('classic')
  const [preset, setPreset] = useState<OutputPreset>('2k')
  const [sharpen, setSharpen] = useState<SharpenLevel>('light')
  const [mainView, setMainView] = useState<MainView>('output')
  const [dragging, setDragging] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState(false)
  const [upscale, setUpscale] = useState<UpscaleStatus>({ phase: 'loading' })
  const ready = upscale.phase === 'ready'
  const presetLabel = OUTPUT_LABEL[preset]
  const aiMode = mode !== 'classic'
  const modeLabel = enhanceModeLabel(mode)
  const outputLabel = `${modeLabel} · ${presetLabel}`
  const mainOutput = mainView === 'output' && upscale.phase === 'ready' ? upscale : null
  const showingMainOutput = mainOutput !== null

  useEffect(() => {
    if (!source) return
    return upscaleImage(source.url, { mode, preset, sharpen }, setUpscale)
  }, [source, mode, preset, sharpen])

  const imageSrc = source ? (mainOutput ? mainOutput.url : source.url) : ''
  const imageW = source ? (mainOutput ? mainOutput.width : source.width) : 0
  const imageH = source ? (mainOutput ? mainOutput.height : source.height) : 0
  const target = source ? targetOutputSize(source.width, source.height, preset) : null
  const downloadFileName = source
    ? toDownloadName(source.fileName, preset, mode)
    : `photo-${mode}-${preset}.png`

  function selectMode(next: EnhanceMode) {
    if (next === mode) return
    setMode(next)
    setMainView('output')
    setLightbox(false)
    if (source) setUpscale({ phase: 'loading' })
  }

  function selectPreset(next: OutputPreset) {
    if (next === preset) return
    setPreset(next)
    setMainView('output')
    if (source) setUpscale({ phase: 'loading' })
  }

  function selectSharpen(next: SharpenLevel) {
    if (next === sharpen) return
    setSharpen(next)
    setMainView('output')
    if (source) setUpscale({ phase: 'loading' })
  }

  async function applyFile(file: File) {
    try {
      const next = await loadLocalImage(file)
      const previous = source
      setFileError(null)
      setMainView('output')
      setLightbox(false)
      setUpscale({ phase: 'loading' })
      setSource(next)
      if (previous) window.setTimeout(() => URL.revokeObjectURL(previous.url), 0)
    } catch (error) {
      const message = error instanceof Error ? error.message : '图片读取失败'
      setFileError(message)
    }
  }

  function openPicker() {
    inputRef.current?.click()
  }

  function resetApp() {
    const previous = source
    dragDepth.current = 0
    if (inputRef.current) inputRef.current.value = ''
    setSource(null)
    setMode('classic')
    setPreset('2k')
    setSharpen('light')
    setMainView('output')
    setDragging(false)
    setFileError(null)
    setLightbox(false)
    setUpscale({ phase: 'loading' })
    if (previous) window.setTimeout(() => URL.revokeObjectURL(previous.url), 0)
  }

  function onInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void applyFile(file)
  }

  function onDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    dragDepth.current += 1
    if (hasImageFile(event.dataTransfer)) setDragging(true)
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    if (hasImageFile(event.dataTransfer)) {
      event.dataTransfer.dropEffect = 'copy'
    }
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    const file = pickImageFile(event.dataTransfer)
    if (file) {
      void applyFile(file)
      return
    }
    setFileError('请拖入 JPG、PNG、WebP 等图片文件')
  }

  return (
    <div
      className={['page', dragging ? 'dragging' : '', source ? 'has-source' : ''].filter(Boolean).join(' ')}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        accept={ACCEPT}
        onChange={onInputChange}
      />

      <header className="top">
        <div className="brand">
          <p className="kicker">
            {aiMode
              ? '本地 AI · Real-ESRGAN · WebGPU / WASM'
              : '前端 Worker · Lanczos-3 · 线性光重采样'}
          </p>
          <h1>本地转 2K / 4K</h1>
          <p className="meta">
            {source && target
              ? aiMode
                ? mode === 'ai-max'
                  ? `原图 ${source.width}×${source.height}，以更强 AI 细节层输出 ${presetLabel} ${target.width}×${target.height}，适合低清或模糊图片。`
                  : `原图 ${source.width}×${source.height}，保留经典高清底图，只叠加自然 AI 细节层并输出 ${presetLabel} ${target.width}×${target.height}。`
                : `原图 ${source.width}×${source.height}，按原比例放大到 ${presetLabel} ${target.width}×${target.height}，导出 PNG，不裁切。`
              : aiMode
                ? mode === 'ai-max'
                  ? 'AI 极清释放更强的 Real-ESRGAN 细节，适合需要明显修复的图片；全程本地处理。'
                  : 'AI 只增强与原图方向一致的细节，不替换真实纹理；图片不会上传。'
                : '上传本地图片，可选经典高清或 AI 补细节，全程不经过服务器。'}
          </p>
        </div>

        <div className="actions">
          <button type="button" className="download secondary" onClick={openPicker}>
            {source ? '更换图片' : '选择图片'}
          </button>
          <button type="button" className="download secondary" disabled={!source} onClick={resetApp}>
            重置
          </button>
          <div className="toggle mode-toggle" role="radiogroup" aria-label="高清算法">
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'classic'}
              className={mode === 'classic' ? 'on' : ''}
              onClick={() => selectMode('classic')}
            >
              经典高清
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'ai'}
              className={mode === 'ai' ? 'on' : ''}
              onClick={() => selectMode('ai')}
              title="以经典高清为底图，只叠加克制的 AI 高频细节"
            >
              AI 超清
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'ai-max'}
              className={mode === 'ai-max' ? 'on max' : 'max'}
              onClick={() => selectMode('ai-max')}
              title="提高 AI 细节强度，适合低清、模糊或需要更明显增强的图片"
            >
              AI 极清
            </button>
          </div>
          <div className="toggle" role="radiogroup" aria-label="输出分辨率">
            <button
              type="button"
              role="radio"
              aria-checked={preset === '2k'}
              className={preset === '2k' ? 'on' : ''}
              onClick={() => selectPreset('2k')}
            >
              2K
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={preset === '4k'}
              className={preset === '4k' ? 'on' : ''}
              onClick={() => selectPreset('4k')}
            >
              4K
            </button>
          </div>
          <div
            className={`toggle labeled${aiMode ? ' is-disabled' : ''}`}
            role="radiogroup"
            aria-label="锐化强度"
            title={aiMode ? `${modeLabel}会自动增强细节，无需额外锐化` : undefined}
          >
            <span className="toggle-label">锐化</span>
            {SHARPEN_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={sharpen === level}
                className={sharpen === level ? 'on' : ''}
                disabled={aiMode}
                onClick={() => selectSharpen(level)}
              >
                {SHARPEN_LABEL[level]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="download secondary"
            disabled={!source}
            onClick={() => setLightbox(true)}
          >
            预览
          </button>
          {ready ? (
            <a className="download" href={upscale.url} download={downloadFileName}>
              下载 {presetLabel} PNG
            </a>
          ) : (
            <button type="button" className="download" disabled>
              下载 {presetLabel} PNG
            </button>
          )}
        </div>
      </header>

      <main className="stage">
        {fileError ? (
          <p className="status error" role="alert">
            {fileError}
          </p>
        ) : null}

        {!source ? (
          <button type="button" className="dropzone" onClick={openPicker}>
            <span className="dropzone-title">把图片拖到这里，或点击上传</span>
            <span className="dropzone-hint">支持 JPG / PNG / WebP 等常见格式，保持原比例转为 2K 或 4K PNG</span>
          </button>
        ) : (
          <>
            <StatusBanner status={upscale} />
            <div className="stage-view-toggle toggle" role="radiogroup" aria-label="切换中间展示图片">
              <button
                type="button"
                role="radio"
                aria-checked={!showingMainOutput}
                className={!showingMainOutput ? 'on' : ''}
                onClick={() => setMainView('original')}
              >
                原图
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={showingMainOutput}
                className={showingMainOutput ? 'on' : ''}
                disabled={!ready}
                onClick={() => setMainView('output')}
              >
                效果图
              </button>
            </div>
            <figure>
              <div className="image-frame">
                <img
                  src={imageSrc}
                  alt={
                    showingMainOutput
                      ? `${modeLabel}处理后的照片，${imageW}×${imageH}`
                      : `原始照片，${source.width}×${source.height}`
                  }
                  width={imageW}
                  height={imageH}
                />
              </div>
              <figcaption>
                {showingMainOutput
                  ? aiMode
                    ? `当前：经典高清底图 + ${mode === 'ai-max' ? '强效 ' : ''}Real-ESRGAN 细节层 · ${backendLabel(mainOutput.backend)} · ${presetLabel} ${imageW}×${imageH} · PNG`
                    : `当前：前端 Lanczos-3 · ${presetLabel} ${imageW}×${imageH} · 锐化${SHARPEN_LABEL[sharpen]} · 未裁切、保持原比例 · PNG`
                  : `当前：原图 · ${source.width}×${source.height} · 目标 ${presetLabel} ${target?.width}×${target?.height}`}
              </figcaption>
            </figure>
          </>
        )}
      </main>

      {lightbox && source ? (
        <Lightbox
          original={{ url: source.url, width: source.width, height: source.height }}
          output={ready ? { url: upscale.url, width: upscale.width, height: upscale.height } : null}
          outputLabel={outputLabel}
          onClose={() => setLightbox(false)}
        />
      ) : null}
    </div>
  )
}

function StatusBanner({ status }: { status: UpscaleStatus }) {
  if (status.phase === 'ready') {
    return (
      <p className="status ok">
        {status.mode !== 'classic'
          ? `已在浏览器中完成${enhanceModeLabel(status.mode)}（${backendLabel(status.backend)}）：${status.width}×${status.height}`
          : `已在浏览器中完成经典高清：${status.width}×${status.height}`}
      </p>
    )
  }
  if (status.phase === 'error') {
    return (
      <p className="status error" role="alert">
        {status.message}
      </p>
    )
  }

  let percent = 0
  let label = '正在读取原图像素…'
  if (status.phase === 'model-loading') {
    percent = Math.round(status.percent * 0.1)
    label = `正在加载本地 AI 模型… ${status.percent}%`
  } else if (status.phase === 'preparing') {
    percent = 10 + Math.round(status.percent * 0.1)
    label =
      status.backend === 'wasm'
        ? `WebGPU 不可用，正在准备 WASM 回退… ${status.percent}%`
        : `正在准备 AI 输入与经典基线… ${status.percent}%`
  } else if (status.phase === 'resizing') {
    percent = status.percent
    label = `正在 Lanczos 插值… ${status.percent}%`
  } else if (status.phase === 'inferencing') {
    percent = 20 + Math.round(status.percent * 0.75)
    label = `正在用 ${backendLabel(status.backend)} 提取 AI 细节层… ${status.percent}%`
  } else if (status.phase === 'finishing') {
    percent = 96
    label = '正在把 AI 细节层叠加到经典高清底图…'
  } else if (status.phase === 'encoding') {
    percent = 100
    label = '正在编码 PNG…'
  }

  return (
    <div className="progress" role="status">
      <p className="status">{label}</p>
      <div className="bar" aria-hidden="true">
        <span style={{ width: `${Math.max(percent, 4)}%` }} />
      </div>
    </div>
  )
}

function backendLabel(backend: UpscaleBackend) {
  if (backend === 'webgpu') return 'WebGPU'
  if (backend === 'wasm') return 'WASM'
  return 'Lanczos-3'
}

function enhanceModeLabel(mode: EnhanceMode) {
  if (mode === 'ai-max') return 'AI 极清'
  if (mode === 'ai') return 'AI 超清'
  return '经典高清'
}

function isImageFile(file: File) {
  if (file.type.startsWith('image/')) return true
  return /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/i.test(file.name)
}

function hasImageFile(data: DataTransfer) {
  return Array.from(data.files).some(isImageFile) || Array.from(data.items).some((item) => item.type.startsWith('image/'))
}

function pickImageFile(data: DataTransfer) {
  return Array.from(data.files).find(isImageFile) ?? null
}

function toDownloadName(fileName: string, output: OutputPreset, mode: EnhanceMode) {
  const stem = fileName.replace(/\.[^.]+$/, '').trim() || 'photo'
  const modeSuffix = mode === 'ai-max' ? 'ai-max-' : mode === 'ai' ? 'ai-' : ''
  return `${stem}-${modeSuffix}${output}.png`
}

function loadLocalImage(file: File): Promise<SourceImage> {
  return new Promise((resolve, reject) => {
    if (!isImageFile(file)) {
      reject(new Error('请选择 JPG、PNG、WebP 等图片文件'))
      return
    }
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const width = img.naturalWidth
      const height = img.naturalHeight
      if (width < 1 || height < 1) {
        URL.revokeObjectURL(url)
        reject(new Error('无法读取图片尺寸'))
        return
      }
      resolve({ fileName: file.name, url, width, height })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片无法解码，请换一张再试'))
    }
    img.src = url
  })
}
