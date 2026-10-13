export const AI_MODEL_NAME = 'Real-ESRGAN-General-x4v3'
export const AI_SCALE = 4
export const AI_TILE_SIZE = 128
export const AI_TILE_PADDING = 16
export const AI_TILE_CORE = AI_TILE_SIZE - AI_TILE_PADDING * 2
export const AI_OUTPUT_TILE_SIZE = AI_TILE_SIZE * AI_SCALE
// AI contributes only a restrained high-frequency residual. The classic
// result remains the base image, so real texture and colour are never replaced.
export const AI_DETAIL_STRENGTH = 0.32
export const AI_DETAIL_LIMIT = 48
export const AI_MAX_DETAIL_STRENGTH = 0.68
export const AI_MAX_DETAIL_LIMIT = 72

export type AiBackend = 'webgpu' | 'wasm'
export type AiDetailProfile = 'balanced' | 'max'

export const AI_DETAIL_PROFILE = {
  balanced: {
    strength: AI_DETAIL_STRENGTH,
    limit: AI_DETAIL_LIMIT,
  },
  max: {
    strength: AI_MAX_DETAIL_STRENGTH,
    limit: AI_MAX_DETAIL_LIMIT,
  },
} satisfies Record<AiDetailProfile, { strength: number; limit: number }>

export type AiTile = {
  coreX: number
  coreY: number
  coreWidth: number
  coreHeight: number
}

export function aiInputSize(targetWidth: number, targetHeight: number) {
  return {
    width: Math.ceil(targetWidth / AI_SCALE),
    height: Math.ceil(targetHeight / AI_SCALE),
  }
}

export function planAiTiles(width: number, height: number): AiTile[] {
  const tiles: AiTile[] = []
  for (let coreY = 0; coreY < height; coreY += AI_TILE_CORE) {
    for (let coreX = 0; coreX < width; coreX += AI_TILE_CORE) {
      tiles.push({
        coreX,
        coreY,
        coreWidth: Math.min(AI_TILE_CORE, width - coreX),
        coreHeight: Math.min(AI_TILE_CORE, height - coreY),
      })
    }
  }
  return tiles
}

/**
 * Extract one 128×128 RGB tile as planar NCHW float data. The 16px context
 * border is clamped at image edges and discarded after inference.
 */
export function extractAiTile(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  tile: AiTile,
): Float32Array {
  const plane = AI_TILE_SIZE * AI_TILE_SIZE
  const tensor = new Float32Array(plane * 3)
  let p = 0

  for (let y = 0; y < AI_TILE_SIZE; y++) {
    const sy = clamp(tile.coreY + y - AI_TILE_PADDING, 0, height - 1)
    for (let x = 0; x < AI_TILE_SIZE; x++) {
      const sx = clamp(tile.coreX + x - AI_TILE_PADDING, 0, width - 1)
      const source = (sy * width + sx) * 4
      tensor[p] = rgba[source] / 255
      tensor[plane + p] = rgba[source + 1] / 255
      tensor[plane * 2 + p] = rgba[source + 2] / 255
      p++
    }
  }

  return tensor
}

/**
 * Add the model's high-frequency residual to the classic result. The reference
 * is a bilinear reconstruction of the exact low-resolution image seen by the
 * model, so low-frequency AI colour/lighting is removed. A residual that would
 * cancel existing source detail is ignored; alpha is never modified.
 */
export function compositeAiTile(
  output: Float32Array,
  aiInput: Uint8ClampedArray,
  aiInputWidth: number,
  aiInputHeight: number,
  destination: Uint8ClampedArray,
  destinationWidth: number,
  destinationHeight: number,
  tile: AiTile,
  strength = AI_DETAIL_STRENGTH,
  detailLimit = AI_DETAIL_LIMIT,
) {
  const plane = AI_OUTPUT_TILE_SIZE * AI_OUTPUT_TILE_SIZE
  const sourceStart = AI_TILE_PADDING * AI_SCALE
  const writeWidth = Math.min(tile.coreWidth * AI_SCALE, destinationWidth - tile.coreX * AI_SCALE)
  const writeHeight = Math.min(tile.coreHeight * AI_SCALE, destinationHeight - tile.coreY * AI_SCALE)

  for (let y = 0; y < writeHeight; y++) {
    const sourceY = sourceStart + y
    const destinationY = tile.coreY * AI_SCALE + y
    const inputY = clamp((destinationY + 0.5) / AI_SCALE - 0.5, 0, aiInputHeight - 1)
    const y0 = Math.floor(inputY)
    const y1 = Math.min(aiInputHeight - 1, y0 + 1)
    const fy = inputY - y0
    for (let x = 0; x < writeWidth; x++) {
      const sourcePixel = sourceY * AI_OUTPUT_TILE_SIZE + sourceStart + x
      const destinationPixel = (destinationY * destinationWidth + tile.coreX * AI_SCALE + x) * 4
      const red = clampByte(output[sourcePixel] * 255)
      const green = clampByte(output[plane + sourcePixel] * 255)
      const blue = clampByte(output[plane * 2 + sourcePixel] * 255)
      const inputX = clamp(
        (tile.coreX * AI_SCALE + x + 0.5) / AI_SCALE - 0.5,
        0,
        aiInputWidth - 1,
      )
      const x0 = Math.floor(inputX)
      const x1 = Math.min(aiInputWidth - 1, x0 + 1)
      const fx = inputX - x0
      const w00 = (1 - fx) * (1 - fy)
      const w10 = fx * (1 - fy)
      const w01 = (1 - fx) * fy
      const w11 = fx * fy
      const i00 = (y0 * aiInputWidth + x0) * 4
      const i10 = (y0 * aiInputWidth + x1) * 4
      const i01 = (y1 * aiInputWidth + x0) * 4
      const i11 = (y1 * aiInputWidth + x1) * 4
      const referenceRed =
        aiInput[i00] * w00 + aiInput[i10] * w10 + aiInput[i01] * w01 + aiInput[i11] * w11
      const referenceGreen =
        aiInput[i00 + 1] * w00 +
        aiInput[i10 + 1] * w10 +
        aiInput[i01 + 1] * w01 +
        aiInput[i11 + 1] * w11
      const referenceBlue =
        aiInput[i00 + 2] * w00 +
        aiInput[i10 + 2] * w10 +
        aiInput[i01 + 2] * w01 +
        aiInput[i11 + 2] * w11
      destination[destinationPixel] = addCompatibleDetail(
        destination[destinationPixel],
        referenceRed,
        red,
        strength,
        detailLimit,
      )
      destination[destinationPixel + 1] = addCompatibleDetail(
        destination[destinationPixel + 1],
        referenceGreen,
        green,
        strength,
        detailLimit,
      )
      destination[destinationPixel + 2] = addCompatibleDetail(
        destination[destinationPixel + 2],
        referenceBlue,
        blue,
        strength,
        detailLimit,
      )
    }
  }
}

function addCompatibleDetail(
  base: number,
  reference: number,
  ai: number,
  strength: number,
  detailLimit: number,
) {
  const existingDetail = base - reference
  const aiDetail = ai - reference
  if (existingDetail !== 0 && existingDetail * aiDetail < 0) return base
  const limited = clamp(aiDetail, -detailLimit, detailLimit)
  return clampByte(base + limited * strength)
}

function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value
}

function clampByte(value: number) {
  return value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value)
}
