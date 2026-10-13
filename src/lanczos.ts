/** Lanczos-3 lobe count. ffmpeg `flags=lanczos` uses the same 3-lobe window. */
export const LANCZOS_A = 3

export type OutputPreset = '2k' | '4k'

/** 2K QHD / 4K UHD long side, keep aspect ratio. */
export const OUTPUT_LONG_SIDE = {
  '2k': 2560,
  '4k': 3840,
} as const

export const OUTPUT_LABEL = {
  '2k': '2K',
  '4k': '4K',
} as const

export type SharpenLevel = 'off' | 'light' | 'strong'

/** Unsharp-mask amount applied in linear light after resampling. */
export const SHARPEN_AMOUNT = {
  off: 0,
  light: 0.35,
  strong: 0.7,
} as const

export const SHARPEN_LABEL = {
  off: '无',
  light: '轻',
  strong: '强',
} as const

export function targetOutputSize(
  srcW: number,
  srcH: number,
  preset: OutputPreset,
): { width: number; height: number } {
  const long = OUTPUT_LONG_SIDE[preset]
  if (srcH >= srcW) {
    return { width: Math.round((srcW * long) / srcH), height: long }
  }
  return { width: long, height: Math.round((srcH * long) / srcW) }
}

function sinc(x: number): number {
  if (x === 0) return 1
  const px = Math.PI * x
  return Math.sin(px) / px
}

export function lanczos(x: number, a: number): number {
  const abs = Math.abs(x)
  if (abs >= a) return 0
  return sinc(x) * sinc(x / a)
}

// ---------------------------------------------------------------------------
// sRGB <-> linear light
//
// Filtering gamma-encoded bytes darkens high-contrast edges and produces grey
// fringes. Resample in linear light instead: decode with a 256-entry table,
// encode back with a 16-bit table so the round trip is exact for every byte.
// ---------------------------------------------------------------------------

const ENCODE_STEPS = 65535

function srgbToLinear(byte: number): number {
  const c = byte / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
}

const SRGB_TO_LINEAR = (() => {
  const table = new Float32Array(256)
  for (let i = 0; i < 256; i++) table[i] = srgbToLinear(i)
  return table
})()

const LINEAR_TO_SRGB8 = (() => {
  const table = new Uint8Array(ENCODE_STEPS + 1)
  for (let i = 0; i <= ENCODE_STEPS; i++) {
    table[i] = Math.round(linearToSrgb(i / ENCODE_STEPS) * 255)
  }
  return table
})()

function encodeLinear(v: number): number {
  if (v <= 0) return 0
  if (v >= 1) return 255
  return LINEAR_TO_SRGB8[(v * ENCODE_STEPS + 0.5) | 0]
}

// ---------------------------------------------------------------------------
// Kernels
// ---------------------------------------------------------------------------

/** Flat kernel table: taps for output `i` live in `[offsets[i], offsets[i + 1])`. */
type KernelTable = {
  offsets: Int32Array
  indices: Int32Array
  weights: Float32Array
  maxTaps: number
}

function buildKernels(srcSize: number, dstSize: number, a: number): KernelTable {
  const scale = srcSize / dstSize
  // Upsample: radius `a` in source pixels. Downsample: widen to filter aliases.
  const support = scale > 1 ? a * scale : a
  const invScale = scale > 1 ? 1 / scale : 1

  const offsets = new Int32Array(dstSize + 1)
  const indices: number[] = []
  const weights: number[] = []
  let maxTaps = 0

  for (let dst = 0; dst < dstSize; dst++) {
    const center = (dst + 0.5) * scale - 0.5
    const first = Math.ceil(center - support)
    const last = Math.floor(center + support)
    const start = indices.length
    let sum = 0

    for (let i = first; i <= last; i++) {
      const w = lanczos((center - i) * invScale, a)
      if (w === 0) continue
      indices.push(i < 0 ? 0 : i >= srcSize ? srcSize - 1 : i)
      weights.push(w)
      sum += w
    }

    if (sum === 0) {
      indices.length = start
      weights.length = start
      indices.push(Math.min(srcSize - 1, Math.max(0, Math.round(center))))
      weights.push(1)
    } else {
      for (let t = start; t < weights.length; t++) weights[t] /= sum
    }
    offsets[dst + 1] = indices.length
    maxTaps = Math.max(maxTaps, indices.length - start)
  }

  return {
    offsets,
    indices: Int32Array.from(indices),
    weights: Float32Array.from(weights),
    maxTaps,
  }
}

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

export type ResizeOptions = {
  /** Lanczos lobes, default 3. */
  a?: number
  /** Unsharp-mask amount in linear light, 0 disables. */
  sharpen?: number
  onProgress?: (percent: number) => void
}

/**
 * Separable Lanczos resize on RGBA, computed in premultiplied linear light.
 * Does not invent content: each output pixel is a weighted combination of
 * nearby source pixels, optionally followed by a 3×3 unsharp mask.
 */
export function resizeRgbaLanczos(
  src: Uint8ClampedArray | Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
  options: ResizeOptions = {},
): Uint8ClampedArray {
  if (srcW < 1 || srcH < 1 || dstW < 1 || dstH < 1) {
    throw new Error('invalid image size')
  }
  const a = options.a ?? LANCZOS_A
  const sharpen = options.sharpen ?? 0
  const onProgress = options.onProgress

  const hasAlpha = detectAlpha(src)
  const horiz = buildKernels(srcW, dstW, a)
  const vert = buildKernels(srcH, dstH, a)

  const srcStride = srcW * 4
  const dstStride = dstW * 4
  const lin = new Float32Array(srcStride)
  const tmp = new Float32Array(dstStride * srcH)
  const dst = new Uint8ClampedArray(dstStride * dstH)

  // Pass 1: horizontal. Decode each source row to premultiplied linear light,
  // then resample it into `tmp` (dstW × srcH).
  for (let y = 0; y < srcH; y++) {
    decodeRow(src, y * srcStride, lin, srcW, hasAlpha)
    const tmpRow = y * dstStride
    for (let x = 0; x < dstW; x++) {
      const end = horiz.offsets[x + 1]
      let r = 0
      let g = 0
      let b = 0
      let al = 0
      for (let t = horiz.offsets[x]; t < end; t++) {
        const i = horiz.indices[t] * 4
        const w = horiz.weights[t]
        r += lin[i] * w
        g += lin[i + 1] * w
        b += lin[i + 2] * w
        al += lin[i + 3] * w
      }
      const o = tmpRow + x * 4
      tmp[o] = r
      tmp[o + 1] = g
      tmp[o + 2] = b
      tmp[o + 3] = al
    }
    if (onProgress && (y & 31) === 0) {
      onProgress(Math.round((y / srcH) * 50))
    }
  }

  // Pass 2: vertical, produced one output row at a time so every inner loop
  // walks `tmp` contiguously. Rows go through a 3-row ring so the sharpen
  // step can see its vertical neighbours before the row is encoded.
  const ring = [new Float32Array(dstStride), new Float32Array(dstStride), new Float32Array(dstStride)]
  const blurRing = sharpen > 0 ? ring.map(() => new Float32Array(dstStride)) : null

  // Gather each output element from all taps in one go instead of doing one
  // accumulate sweep per tap; the 6-tap case (Lanczos-3 upsampling) is
  // unrolled because it is what nearly every row hits.
  const bases = new Int32Array(vert.maxTaps)
  const wts = new Float32Array(vert.maxTaps)
  const produceRow = (y: number, slot: number) => {
    const out = ring[slot]
    const start = vert.offsets[y]
    const n = vert.offsets[y + 1] - start
    for (let t = 0; t < n; t++) {
      bases[t] = vert.indices[start + t] * dstStride
      wts[t] = vert.weights[start + t]
    }
    if (n === 6) {
      const b0 = bases[0], b1 = bases[1], b2 = bases[2], b3 = bases[3], b4 = bases[4], b5 = bases[5]
      const w0 = wts[0], w1 = wts[1], w2 = wts[2], w3 = wts[3], w4 = wts[4], w5 = wts[5]
      for (let k = 0; k < dstStride; k++) {
        out[k] =
          tmp[b0 + k] * w0 +
          tmp[b1 + k] * w1 +
          tmp[b2 + k] * w2 +
          tmp[b3 + k] * w3 +
          tmp[b4 + k] * w4 +
          tmp[b5 + k] * w5
      }
    } else {
      for (let k = 0; k < dstStride; k++) {
        let acc = 0
        for (let t = 0; t < n; t++) acc += tmp[bases[t] + k] * wts[t]
        out[k] = acc
      }
    }
    if (blurRing) blurRowHorizontal(out, blurRing[slot], dstW)
  }

  const emitRow = (y: number, prev: number, cur: number, next: number) => {
    const row = ring[cur]
    if (blurRing) {
      sharpenRow(row, blurRing[prev], blurRing[cur], blurRing[next], sharpen, dstW)
    }
    encodeRow(row, dst, y * dstStride, dstW, hasAlpha)
  }

  produceRow(0, 0)
  for (let y = 0; y < dstH; y++) {
    const cur = y % 3
    const next = (y + 1) % 3
    const prev = (y + 2) % 3
    if (y + 1 < dstH) {
      produceRow(y + 1, next)
    } else {
      // Clamp bottom edge for the blur window.
      ring[next].set(ring[cur])
      blurRing?.[next].set(blurRing[cur])
    }
    emitRow(y, y === 0 ? cur : prev, cur, next)
    if (onProgress && (y & 31) === 0) {
      onProgress(50 + Math.round((y / dstH) * 50))
    }
  }

  onProgress?.(100)
  return dst
}

function detectAlpha(src: Uint8ClampedArray | Uint8Array): boolean {
  for (let i = 3; i < src.length; i += 4) {
    if (src[i] !== 255) return true
  }
  return false
}

/** Byte RGBA row -> premultiplied linear float RGBA row (alpha in 0..1). */
function decodeRow(
  src: Uint8ClampedArray | Uint8Array,
  offset: number,
  out: Float32Array,
  width: number,
  hasAlpha: boolean,
) {
  for (let x = 0; x < width; x++) {
    const i = offset + x * 4
    const o = x * 4
    if (hasAlpha) {
      const al = src[i + 3] / 255
      out[o] = SRGB_TO_LINEAR[src[i]] * al
      out[o + 1] = SRGB_TO_LINEAR[src[i + 1]] * al
      out[o + 2] = SRGB_TO_LINEAR[src[i + 2]] * al
      out[o + 3] = al
    } else {
      out[o] = SRGB_TO_LINEAR[src[i]]
      out[o + 1] = SRGB_TO_LINEAR[src[i + 1]]
      out[o + 2] = SRGB_TO_LINEAR[src[i + 2]]
      out[o + 3] = 1
    }
  }
}

/** Premultiplied linear float row -> straight-alpha sRGB bytes. */
function encodeRow(
  row: Float32Array,
  dst: Uint8ClampedArray,
  offset: number,
  width: number,
  hasAlpha: boolean,
) {
  for (let x = 0; x < width; x++) {
    const i = x * 4
    const o = offset + i
    if (!hasAlpha) {
      dst[o] = encodeLinear(row[i])
      dst[o + 1] = encodeLinear(row[i + 1])
      dst[o + 2] = encodeLinear(row[i + 2])
      dst[o + 3] = 255
      continue
    }
    const al = row[i + 3]
    if (al <= 0) {
      dst[o] = 0
      dst[o + 1] = 0
      dst[o + 2] = 0
      dst[o + 3] = 0
      continue
    }
    const inv = al >= 1 ? 1 : 1 / al
    dst[o] = encodeLinear(row[i] * inv)
    dst[o + 1] = encodeLinear(row[i + 1] * inv)
    dst[o + 2] = encodeLinear(row[i + 2] * inv)
    dst[o + 3] = al >= 1 ? 255 : Math.round(al * 255)
  }
}

/** [1 2 1] / 4 horizontal blur of RGB, edges clamped. Alpha is copied. */
function blurRowHorizontal(row: Float32Array, out: Float32Array, width: number) {
  for (let x = 0; x < width; x++) {
    const l = (x === 0 ? 0 : x - 1) * 4
    const c = x * 4
    const r = (x === width - 1 ? x : x + 1) * 4
    out[c] = (row[l] + 2 * row[c] + row[r]) * 0.25
    out[c + 1] = (row[l + 1] + 2 * row[c + 1] + row[r + 1]) * 0.25
    out[c + 2] = (row[l + 2] + 2 * row[c + 2] + row[r + 2]) * 0.25
    out[c + 3] = row[c + 3]
  }
}

/** Unsharp mask in place: v + amount · (v − blur3x3(v)) on RGB only. */
function sharpenRow(
  row: Float32Array,
  blurPrev: Float32Array,
  blurCur: Float32Array,
  blurNext: Float32Array,
  amount: number,
  width: number,
) {
  const gain = 1 + amount
  const k = amount * 0.25
  for (let x = 0; x < width; x++) {
    const i = x * 4
    // Keep premultiplied colour inside [0, alpha] so un-premultiply stays sane.
    const hi = row[i + 3]
    const r = row[i] * gain - (blurPrev[i] + 2 * blurCur[i] + blurNext[i]) * k
    const g = row[i + 1] * gain - (blurPrev[i + 1] + 2 * blurCur[i + 1] + blurNext[i + 1]) * k
    const b = row[i + 2] * gain - (blurPrev[i + 2] + 2 * blurCur[i + 2] + blurNext[i + 2]) * k
    row[i] = r < 0 ? 0 : r > hi ? hi : r
    row[i + 1] = g < 0 ? 0 : g > hi ? hi : g
    row[i + 2] = b < 0 ? 0 : b > hi ? hi : b
  }
}
