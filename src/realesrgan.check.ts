import {
  AI_DETAIL_PROFILE,
  AI_OUTPUT_TILE_SIZE,
  AI_SCALE,
  AI_TILE_CORE,
  AI_TILE_PADDING,
  aiInputSize,
  compositeAiTile,
  extractAiTile,
  planAiTiles,
} from './realesrgan.ts'

function assert(ok: boolean, message: string) {
  if (!ok) throw new Error(message)
}

const input = aiInputSize(1921, 2561)
assert(input.width === 481 && input.height === 641, `AI input size ${input.width}×${input.height}`)

// Tile cores must cover every input pixel exactly once, including partial
// right/bottom tiles.
const width = AI_TILE_CORE * 2 + 7
const height = AI_TILE_CORE + 5
const tiles = planAiTiles(width, height)
const coverage = new Uint8Array(width * height)
for (const tile of tiles) {
  for (let y = 0; y < tile.coreHeight; y++) {
    for (let x = 0; x < tile.coreWidth; x++) {
      coverage[(tile.coreY + y) * width + tile.coreX + x]++
    }
  }
}
assert(coverage.every((count) => count === 1), 'tile cores do not cover input exactly once')

// Context extraction clamps the top-left border and writes planar RGB.
const rgba = new Uint8ClampedArray([
  10, 20, 30, 255,
  40, 50, 60, 255,
  70, 80, 90, 255,
  100, 110, 120, 255,
])
const tinyTile = planAiTiles(2, 2)[0]
const tensor = extractAiTile(rgba, 2, 2, tinyTile)
const plane = 128 * 128
assert(Math.abs(tensor[0] - 10 / 255) < 1e-6, 'red border clamp')
assert(Math.abs(tensor[plane] - 20 / 255) < 1e-6, 'green planar channel')
assert(Math.abs(tensor[plane * 2] - 30 / 255) < 1e-6, 'blue planar channel')

// Composition crops the context border, reaches odd target edges and keeps
// Lanczos alpha untouched.
const targetWidth = 5
const targetHeight = 7
const destination = new Uint8ClampedArray(targetWidth * targetHeight * 4)
for (let i = 0; i < destination.length; i += 4) {
  destination[i] = 110
  destination[i + 1] = 90
  destination[i + 2] = 100
  destination[i + 3] = (i / 4) % 256
}
const baseline = destination.slice()
const beforeAlpha = destination.filter((_, index) => index % 4 === 3)
const residualInput = new Uint8ClampedArray(2 * 2 * 4)
for (let i = 0; i < residualInput.length; i += 4) {
  residualInput[i] = residualInput[i + 1] = residualInput[i + 2] = 100
  residualInput[i + 3] = 255
}
const modelOutput = new Float32Array(AI_OUTPUT_TILE_SIZE * AI_OUTPUT_TILE_SIZE * 3)
modelOutput.fill(100 / 255)
compositeAiTile(modelOutput, residualInput, 2, 2, destination, targetWidth, targetHeight, tinyTile, 1)
assert(destination.every((value, index) => value === baseline[index]), 'zero residual changed classic result')

modelOutput.fill(130 / 255)
compositeAiTile(modelOutput, residualInput, 2, 2, destination, targetWidth, targetHeight, tinyTile, 1)
for (let i = 0; i < destination.length; i += 4) {
  assert(destination[i] === 140, `matching red detail ${destination[i]}`)
  assert(destination[i + 1] === 90, `opposing green detail was not preserved ${destination[i + 1]}`)
  assert(destination[i + 2] === 130, `new blue detail ${destination[i + 2]}`)
  assert(destination[i + 3] === beforeAlpha[i / 4], `alpha changed at ${i}`)
}

assert(AI_TILE_PADDING * 2 + AI_TILE_CORE === 128, 'tile geometry')
assert(AI_SCALE === 4, 'model scale')
assert(
  AI_DETAIL_PROFILE.max.strength > AI_DETAIL_PROFILE.balanced.strength &&
    AI_DETAIL_PROFILE.max.limit > AI_DETAIL_PROFILE.balanced.limit,
  'max detail profile must be stronger than balanced',
)

console.log('realesrgan checks passed')
