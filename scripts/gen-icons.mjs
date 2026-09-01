// One-off: rasterize the SVG logo into the PNG icons the PWA manifest needs.
//   npm i -D sharp && node scripts/gen-icons.mjs
import sharp from 'sharp'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pub = join(root, 'public')
const svg = readFileSync(join(pub, 'icon.svg'))

const BG = '#313235'

// Standard ("any") icons: the branded rounded-square logo on a transparent
// canvas, shown as-is where the platform does not mask icons. High density so
// the upscale from the small source SVG stays crisp.
await sharp(svg, { density: 1024 }).resize(192, 192).png().toFile(join(pub, 'pwa-192.png'))
await sharp(svg, { density: 1024 }).resize(512, 512).png().toFile(join(pub, 'pwa-512.png'))

// Full-bleed variants for platforms that apply their own mask (Android / Chrome
// OS "maskable", iOS home screen). The ENTIRE canvas is the solid brand colour
// with no transparency anywhere, and the logo sits well inside the safe zone so
// a circular mask never clips it. `flatten` drops the alpha channel outright, so
// no pixel can ever render as white/black behind the mask.
const fullBleed = (scale) =>
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512">' +
      `<rect width="64" height="64" fill="${BG}"/>` +
      `<g transform="translate(32 32) scale(${scale}) translate(-32 -32)">` +
      '<rect x="12" y="18" width="40" height="28" rx="4" fill="none" stroke="#26d07c" stroke-width="3"/>' +
      '<path d="M13 21 L32 35 L51 21" fill="none" stroke="#26d07c" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</g></svg>',
  )

// Maskable: extra padding (smaller logo) to survive an aggressive circular mask.
const maskable = fullBleed(0.78)
await sharp(maskable).resize(192, 192).flatten({ background: BG }).png().toFile(join(pub, 'pwa-192-maskable.png'))
await sharp(maskable).resize(512, 512).flatten({ background: BG }).png().toFile(join(pub, 'pwa-512-maskable.png'))

// Apple touch icon: iOS rounds the corners gently, so the logo can be larger.
await sharp(fullBleed(0.9)).resize(180, 180).flatten({ background: BG }).png().toFile(join(pub, 'apple-touch-icon.png'))

console.log('Generated PWA PNG icons in public/')
