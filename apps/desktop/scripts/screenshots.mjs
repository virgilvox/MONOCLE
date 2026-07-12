// Capture README screenshots by driving the built Electron app with Playwright.
// Deterministic: uses a fake camera and the synthetic reconstruction, so it needs
// no real webcam or model. Build first:
//   pnpm build:libs && pnpm --filter @monoclejs/desktop build
// then: pnpm --filter @monoclejs/desktop screenshots
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')
const root = join(appDir, '..', '..')
const outDir = join(root, 'docs', 'screenshots')
await mkdir(outDir, { recursive: true })

const app = await electron.launch({
  executablePath: electronPath,
  args: [
    appDir,
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--enable-unsafe-webgpu',
  ],
  env: { ...process.env, ELECTRON_RENDERER_URL: '' },
})

const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1500)

async function shot(name) {
  await page.screenshot({ path: join(outDir, name) })
  console.log('captured', name)
}

async function step(label, fn) {
  try {
    await fn()
  } catch (error) {
    console.log('skip', label, '-', String(error.message).split('\n')[0])
  }
}

const tab = (name) => page.getByRole('tab', { name, exact: false })

await step('start camera', async () => {
  await page.getByRole('button', { name: /start camera/i }).click({ timeout: 6000 })
  await page.waitForTimeout(2500)
})

await step('select synthetic preset', () =>
  page.getByText('Synthetic test', { exact: false }).first().click({ timeout: 6000 }),
)
await step('wait for engine ready', () =>
  page.getByText('Ready', { exact: false }).first().waitFor({ timeout: 45000 }),
)
await step('reconstruct', async () => {
  await page.getByRole('button', { name: 'Reconstruct' }).click({ timeout: 6000 })
  await page.waitForTimeout(5000)
})

// Hero: the reconstructed mesh in the 3D preview.
await step('open 3D preview', async () => {
  await tab('3D Preview').click({ timeout: 5000 })
  await page.waitForTimeout(2500)
})
await shot('01-preview.png')

// The capture UI with a live camera feed.
await step('open camera tab', async () => {
  await tab('Camera').click({ timeout: 5000 })
  await page.waitForTimeout(1500)
})
await shot('02-camera.png')

// The realtime depth preview.
await step('open live depth tab', async () => {
  await tab('Live depth').click({ timeout: 5000 })
  await page.waitForTimeout(9000)
})
await shot('03-live-depth.png')

await app.close()
console.log('done')
