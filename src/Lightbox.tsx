import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

export type LightboxImage = {
  url: string
  width: number
  height: number
}

type Props = {
  original: LightboxImage
  output: LightboxImage | null
  outputLabel: string
  onClose: () => void
}

type PreviewView = 'output' | 'original' | 'compare'

type LensPosition = {
  x: number
  y: number
  visible: boolean
}

const LENS_MAX_WIDTH = 560
const LENS_MAX_HEIGHT = 320
const LENS_ZOOM = 1.5

function useViewport() {
  const [size, setSize] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))

  useEffect(() => {
    const update = () => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  return size
}

/**
 * Fullscreen viewer with original, output and draggable comparison modes.
 * The optional magnifier samples the native image over the pointer position.
 */
export default function Lightbox({ original, output, outputLabel, onClose }: Props) {
  const viewport = useViewport()
  const imageRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<PreviewView>(output ? 'compare' : 'original')
  const [split, setSplit] = useState(0.5)
  const [dragging, setDragging] = useState(false)
  const [magnifier, setMagnifier] = useState(false)
  const [lens, setLens] = useState<LensPosition>({ x: 0, y: 0, visible: false })

  const comparing = view === 'compare' && output !== null
  const showingOutput = view === 'output' && output !== null
  const shown = showingOutput || comparing ? (output ?? original) : original
  const aspect = shown.width / shown.height
  const stageW = viewport.width / viewport.height > aspect
    ? Math.round(viewport.height * aspect)
    : viewport.width
  const stageH = viewport.width / viewport.height > aspect
    ? viewport.height
    : Math.round(viewport.width / aspect)
  const lensWidth = Math.min(LENS_MAX_WIDTH, Math.max(160, stageW - 16))
  const lensHeight = Math.min(LENS_MAX_HEIGHT, Math.max(120, stageH - 16))
  const lensLeft = stageW <= lensWidth
    ? stageW / 2
    : Math.min(stageW - lensWidth / 2 - 4, Math.max(lensWidth / 2 + 4, lens.x))
  const lensTop = stageH <= lensHeight
    ? stageH / 2
    : Math.min(stageH - lensHeight / 2 - 4, Math.max(lensHeight / 2 + 4, lens.y))

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  function positionFromPointer(event: PointerEvent<HTMLDivElement>) {
    const rect = imageRef.current?.getBoundingClientRect()
    if (!rect) return null
    return {
      x: Math.min(rect.width, Math.max(0, event.clientX - rect.left)),
      y: Math.min(rect.height, Math.max(0, event.clientY - rect.top)),
    }
  }

  function updateLens(event: PointerEvent<HTMLDivElement>, visible = true) {
    if (!magnifier) return
    const point = positionFromPointer(event)
    if (point) setLens({ ...point, visible })
  }

  function updateSplit(event: PointerEvent<HTMLDivElement>) {
    const point = positionFromPointer(event)
    const rect = imageRef.current?.getBoundingClientRect()
    if (!point || !rect || rect.width === 0) return
    setSplit(point.x / rect.width)
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    updateLens(event)
    if (!comparing) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
    updateSplit(event)
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    updateLens(event)
    if (comparing && (event.buttons & 1) !== 0) updateSplit(event)
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  function onCompareKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!comparing) return
    const step = event.shiftKey ? 0.1 : 0.02
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setSplit((value) => Math.max(0, value - step))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setSplit((value) => Math.min(1, value + step))
    }
  }

  const splitPercent = split * 100
  const lensPanelWidth = lensWidth / 2
  const lensImageLeft = lensPanelWidth / 2 - lens.x * LENS_ZOOM
  const lensImageTop = lensHeight / 2 - lens.y * LENS_ZOOM

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="全屏图片预览与对比">
      <div className="lightbox-bar">
        <span className="lightbox-title">
          {comparing
            ? `原图 ${original.width}×${original.height} ↔ ${outputLabel} 效果图 ${output?.width}×${output?.height}`
            : `${showingOutput ? `${outputLabel} 效果图` : '原图'} · ${shown.width}×${shown.height}`}
        </span>
        <div className="toggle dark" role="tablist" aria-label="切换预览图片">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'original'}
            className={view === 'original' ? 'on' : ''}
            onClick={() => setView('original')}
          >
            原图
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={showingOutput}
            className={showingOutput ? 'on' : ''}
            disabled={!output}
            onClick={() => setView('output')}
          >
            效果图
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={comparing}
            className={comparing ? 'on' : ''}
            disabled={!output}
            onClick={() => setView('compare')}
          >
            对比
          </button>
        </div>
        <button
          type="button"
          className={magnifier ? 'lightbox-tool on' : 'lightbox-tool'}
          aria-pressed={magnifier}
          disabled={!output}
          onClick={() => {
            setMagnifier((value) => !value)
            setLens((value) => ({ ...value, visible: false }))
          }}
        >
          放大镜
        </button>
        <button type="button" className="lightbox-close" onClick={onClose} aria-label="关闭预览">
          ×
        </button>
      </div>

      <div
        className="lightbox-stage"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        <div
          ref={imageRef}
          className={[
            'lightbox-image-wrap',
            comparing ? 'is-comparing' : '',
            dragging ? 'is-dragging' : '',
            magnifier ? 'has-magnifier' : '',
          ].filter(Boolean).join(' ')}
          style={{ width: stageW, height: stageH }}
          role={comparing ? 'slider' : undefined}
          aria-label={comparing ? '拖动分界线对比原图和效果图' : undefined}
          aria-valuemin={comparing ? 0 : undefined}
          aria-valuemax={comparing ? 100 : undefined}
          aria-valuenow={comparing ? Math.round(splitPercent) : undefined}
          tabIndex={comparing ? 0 : -1}
          onKeyDown={onCompareKey}
          onPointerEnter={(event) => updateLens(event)}
          onPointerLeave={() => setLens((value) => ({ ...value, visible: false }))}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <img
            key={shown.url}
            className="lightbox-image"
            src={shown.url}
            alt={showingOutput || comparing ? `${outputLabel} 放大效果图` : '原图'}
            draggable={false}
          />

          {comparing ? (
            <>
              <img
                className="lightbox-image lightbox-original-layer"
                src={original.url}
                alt="原图"
                draggable={false}
                style={{ clipPath: `inset(0 ${100 - splitPercent}% 0 0)` }}
              />
              <span className="compare-tag left">原图</span>
              <span className="compare-tag right">{outputLabel} 效果图</span>
              <span className="compare-divider" style={{ left: `${splitPercent}%` }} aria-hidden="true">
                <span className="compare-handle">⇔</span>
              </span>
            </>
          ) : null}

          {magnifier && lens.visible && output ? (
            <span
              className="magnifier"
              style={{
                width: lensWidth,
                height: lensHeight,
                left: lensLeft,
                top: lensTop,
              }}
              aria-hidden="true"
            >
              <span className="magnifier-panel">
                <img
                  src={original.url}
                  alt=""
                  draggable={false}
                  style={{
                    width: stageW * LENS_ZOOM,
                    height: stageH * LENS_ZOOM,
                    left: lensImageLeft,
                    top: lensImageTop,
                  }}
                />
                <span className="magnifier-label">原图 · {LENS_ZOOM}×</span>
              </span>
              <span className="magnifier-panel">
                <img
                  src={output.url}
                  alt=""
                  draggable={false}
                  style={{
                    width: stageW * LENS_ZOOM,
                    height: stageH * LENS_ZOOM,
                    left: lensImageLeft,
                    top: lensImageTop,
                  }}
                />
                <span className="magnifier-label">{outputLabel} 效果图 · {LENS_ZOOM}×</span>
              </span>
              <span className="magnifier-divider" />
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}
