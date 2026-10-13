import { resizeRgbaLanczos } from './lanczos.ts'

function assert(ok: boolean, message: string) {
  if (!ok) throw new Error(message)
}

// Flat colour stays flat when upscaled.
const red = new Uint8ClampedArray([
  255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
])
const up = resizeRgbaLanczos(red, 2, 2, 4, 4)
assert(up.length === 4 * 4 * 4, 'size')
for (let i = 0; i < up.length; i += 4) {
  assert(up[i] >= 250 && up[i + 1] <= 2 && up[i + 2] <= 2 && up[i + 3] >= 250, `pixel ${i}`)
}

// Same-size resize is the identity (sRGB -> linear -> sRGB round trip exact).
const identity = new Uint8ClampedArray(8 * 8 * 4)
for (let i = 0; i < identity.length; i++) identity[i] = i % 4 === 3 ? 255 : (i * 17) % 256
const same = resizeRgbaLanczos(identity, 8, 8, 8, 8)
let drift = 0
for (let i = 0; i < same.length; i++) drift = Math.max(drift, Math.abs(same[i] - identity[i]))
assert(drift <= 1, `identity drift ${drift}`)

// Linear light: averaging black and white gives 50% linear = sRGB 188, not 128.
const bw = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255])
const mid = resizeRgbaLanczos(bw, 2, 1, 1, 1)
assert(mid[0] >= 186 && mid[0] <= 190, `linear midpoint ${mid[0]}`)

// Premultiplied alpha: red next to transparent must not darken at the seam.
const fringe = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0])
const blend = resizeRgbaLanczos(fringe, 2, 1, 1, 1)
assert(blend[3] >= 126 && blend[3] <= 129, `alpha ${blend[3]}`)
assert(blend[0] >= 250 && blend[1] <= 2, `fringe rgb ${blend[0]},${blend[1]},${blend[2]}`)

// Sharpen leaves flat regions alone and steepens an edge.
const edge = new Uint8ClampedArray(8 * 8 * 4)
for (let y = 0; y < 8; y++) {
  for (let x = 0; x < 8; x++) {
    const o = (y * 8 + x) * 4
    const v = x < 4 ? 40 : 200
    edge[o] = edge[o + 1] = edge[o + 2] = v
    edge[o + 3] = 255
  }
}
const soft = resizeRgbaLanczos(edge, 8, 8, 16, 16)
const sharp = resizeRgbaLanczos(edge, 8, 8, 16, 16, { sharpen: 0.7 })
const px = (buf: Uint8ClampedArray, x: number, y: number) => buf[(y * 16 + x) * 4]
assert(Math.abs(px(sharp, 0, 8) - px(soft, 0, 8)) <= 1, 'sharpen changed flat area')
assert(px(sharp, 7, 8) <= px(soft, 7, 8) && px(sharp, 8, 8) >= px(soft, 8, 8), 'sharpen did not steepen edge')

console.log('lanczos checks passed')
