#!/usr/bin/env node
/**
 * Fetch the live depth model and the onnxruntime-web wasm binaries into the
 * desktop renderer's public directory so the app runs fully offline.
 *
 * Downloads:
 *   - onnx-community/depth-anything-v2-small-ONNX  onnx/model_fp16.onnx
 *   - the sibling external-data file model_fp16.onnx_data
 * Copies from node_modules:
 *   - onnxruntime-web/dist/ort-*.wasm and ort-*.mjs
 *
 * Uses only Node built-ins. Run it once after installing dependencies:
 *   node scripts/fetch-models.mjs   (or: pnpm fetch:models)
 */
import { createWriteStream } from 'node:fs'
import { mkdir, copyFile, readdir, access, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

const PUBLIC_DIR = resolve(repoRoot, 'apps/desktop/src/renderer/public/models')
const MODEL_DIR = join(PUBLIC_DIR, 'depth-anything-v2-small')
const ORT_DIR = join(PUBLIC_DIR, 'ort')

const HF_BASE =
  'https://huggingface.co/onnx-community/depth-anything-v2-small-ONNX/resolve/main/onnx'

const MODEL_FILES = [
  // fp16 for the WebGPU path (fast, half the size), with its external-data file.
  { url: `${HF_BASE}/model_fp16.onnx`, name: 'model_fp16.onnx' },
  { url: `${HF_BASE}/model_fp16.onnx_data`, name: 'model_fp16.onnx_data' },
  // fp32 for the wasm fallback: the wasm EP's fp16 support is weak, so the
  // no-WebGPU path (Linux, Raspberry Pi) needs a full-precision model to run.
  { url: `${HF_BASE}/model.onnx`, name: 'model_fp32.onnx' },
]

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function download(url, destination) {
  process.stdout.write(`  downloading ${url}\n`)
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`failed to fetch ${url}: ${response.status} ${response.statusText}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
  const info = await stat(destination)
  process.stdout.write(`  saved ${destination} (${(info.size / 1e6).toFixed(1)} MB)\n`)
}

async function resolveOrtDist() {
  const candidates = [
    resolve(repoRoot, 'apps/desktop/node_modules/onnxruntime-web/dist'),
    resolve(repoRoot, 'node_modules/onnxruntime-web/dist'),
  ]
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  throw new Error(
    'onnxruntime-web not found in node_modules. Install dependencies first, then rerun.',
  )
}

async function copyOrtRuntime() {
  const dist = await resolveOrtDist()
  const entries = await readdir(dist)
  const wanted = entries.filter((name) => /^ort-.*\.(wasm|mjs)$/.test(name))
  if (wanted.length === 0) {
    throw new Error(`no ort-*.wasm/.mjs files found in ${dist}`)
  }
  for (const name of wanted) {
    await copyFile(join(dist, name), join(ORT_DIR, name))
    process.stdout.write(`  copied ${name}\n`)
  }
}

async function main() {
  await mkdir(MODEL_DIR, { recursive: true })
  await mkdir(ORT_DIR, { recursive: true })

  process.stdout.write('Fetching depth model...\n')
  for (const file of MODEL_FILES) {
    await download(file.url, join(MODEL_DIR, file.name))
  }

  process.stdout.write('Copying onnxruntime-web binaries...\n')
  await copyOrtRuntime()

  process.stdout.write('Done. Live depth assets are ready.\n')
}

main().catch((error) => {
  process.stderr.write(`fetch-models failed: ${error.message}\n`)
  process.exitCode = 1
})
