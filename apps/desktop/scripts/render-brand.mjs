// Render the MONOCLE brand raster assets from the "mesh" mark with headless
// chromium. Two outputs:
//   build/icon.png   1024x1024 app icon (electron-builder derives platform icons)
//   docs/logo.png    horizontal lockup for the README, rendered at 2x for retina
//
// Run: node apps/desktop/scripts/render-brand.mjs
// (or: pnpm --filter @monoclejs/desktop render:brand)
import { mkdir, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')
const root = join(appDir, '..', '..')

// The mark, as inner SVG markup. FG is the line/foreground color, AC the accent.
function mark(fg, ac) {
  return `
    <circle cx="100" cy="100" r="64" fill="none" stroke="${fg}" stroke-width="12"/>
    <polygon points="84,68 132,80 100,120" fill="${ac}"/>
    <path d="M56,122 L84,68 L100,120 Z M84,68 L132,80 L100,120 M132,80 L146,114 L100,120" fill="none" stroke="${fg}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="56" cy="122" r="6" fill="${ac}"/>
    <circle cx="146" cy="114" r="6" fill="${ac}"/>`
}

const FG = '#eef1f4'
const AC = '#8ed3ef'
const GRAPHITE = '#14171a'
const BORDER = '#262b30'

function svg(size, fg, ac) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">${mark(fg, ac)}</svg>`
}

// Try to locate a Space Mono woff2 in a local @fontsource package. Absent here,
// so the wordmark falls back to monospace; this stays optional by design.
async function findSpaceMono() {
  const dirs = [
    join(root, 'apps', 'desktop', 'node_modules', '@fontsource', 'space-mono', 'files'),
    join(root, 'node_modules', '@fontsource', 'space-mono', 'files'),
  ]
  const candidates = ['space-mono-latin-700-normal.woff2', 'space-mono-latin-400-normal.woff2']
  for (const dir of dirs) {
    for (const name of candidates) {
      const file = join(dir, name)
      try {
        await access(file, constants.R_OK)
        return pathToFileURL(file).href
      } catch {
        // keep looking
      }
    }
  }
  return null
}

function fontFace(url) {
  if (!url) return ''
  return `@font-face {
    font-family: 'Space Mono';
    font-style: normal;
    font-weight: 700;
    src: url('${url}') format('woff2');
  }`
}

function iconPage(fontUrl) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${fontFace(fontUrl)}
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { background: transparent; }
    .card {
      width: 1024px; height: 1024px;
      background: ${GRAPHITE};
      border: 1px solid ${BORDER};
      border-radius: 224px;
      display: flex; align-items: center; justify-content: center;
    }
    .card svg { display: block; }
  </style></head><body>
    <div class="card">${svg(560, FG, AC)}</div>
  </body></html>`
}

function logoPage(fontUrl) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    ${fontFace(fontUrl)}
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { background: transparent; }
    .card {
      width: 760px; height: 240px;
      background: ${GRAPHITE};
      border-radius: 40px;
      display: flex; align-items: center; justify-content: center;
      gap: 30px;
    }
    .card svg { display: block; }
    .word {
      font-family: 'Space Mono', ui-monospace, monospace;
      font-weight: 700;
      font-size: 66px;
      letter-spacing: 0.14em;
      line-height: 1;
    }
    .word .mono { color: ${FG}; }
    .word .cle { color: ${AC}; }
  </style></head><body>
    <div class="card">
      ${svg(150, FG, AC)}
      <div class="word"><span class="mono">MONO</span><span class="cle">CLE</span></div>
    </div>
  </body></html>`
}

async function render(browser, { html, selector, deviceScaleFactor, scale, path }) {
  const context = await browser.newContext({ deviceScaleFactor })
  const page = await context.newPage()
  await page.setContent(html, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  const el = await page.$(selector)
  await el.screenshot({ path, omitBackground: true, scale })
  await context.close()
}

const fontUrl = await findSpaceMono()
console.log(fontUrl ? `Space Mono: ${fontUrl}` : 'Space Mono: not found, using monospace fallback')

// The app icon lives in electron-builder's build resources (apps/desktop/build).
const iconPath = join(root, 'apps', 'desktop', 'build', 'icon.png')
await mkdir(join(root, 'apps', 'desktop', 'build'), { recursive: true })
await mkdir(join(root, 'docs'), { recursive: true })

// Prefer Playwright's bundled chromium; fall back to the system Chrome channel
// when the matching bundle is not downloaded (older OS cannot fetch it).
async function launch() {
  try {
    return await chromium.launch()
  } catch {
    return await chromium.launch({ channel: 'chrome' })
  }
}
const browser = await launch()

// Icon: supersample at 3x and downsample to CSS pixels for a crisp 1024x1024.
await render(browser, {
  html: iconPage(fontUrl),
  selector: '.card',
  deviceScaleFactor: 3,
  scale: 'css',
  path: iconPath,
})

// Logo: render the 760x240 lockup at device scale 2 -> 1520x480 retina PNG.
await render(browser, {
  html: logoPage(fontUrl),
  selector: '.card',
  deviceScaleFactor: 2,
  scale: 'device',
  path: join(root, 'docs', 'logo.png'),
})

await browser.close()
console.log('rendered apps/desktop/build/icon.png and docs/logo.png')
