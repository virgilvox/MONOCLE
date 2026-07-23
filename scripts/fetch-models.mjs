#!/usr/bin/env node
/**
 * Fetch the live depth models and the onnxruntime-web wasm binaries into the
 * desktop renderer's public directory so the app runs fully offline.
 *
 * Downloads:
 *   - onnx-community/depth-anything-v2-small-ONNX  onnx/model_fp16.onnx (+ _data)
 *     and onnx/model.onnx (renamed to model_fp32.onnx for the wasm fallback)
 *   - onnx-community/depth-anything-v3-small        onnx/model.onnx + its
 *     sibling external-data file model.onnx_data (fp32 only, opt-in second model)
 * Copies from node_modules:
 *   - onnxruntime-web/dist/ort-*.wasm and ort-*.mjs
 *
 * Uses only Node built-ins. Run it once after installing dependencies:
 *   node scripts/fetch-models.mjs   (or: pnpm fetch:models)
 */
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, copyFile, readdir, access, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

const PUBLIC_DIR = resolve(repoRoot, 'apps/desktop/src/renderer/public/models')
const V2_DIR = join(PUBLIC_DIR, 'depth-anything-v2-small')
const V3_DIR = join(PUBLIC_DIR, 'depth-anything-v3-small')
const ORT_DIR = join(PUBLIC_DIR, 'ort')

// Both repos are pinned to a specific revision, and every file is verified by
// size and sha256 (resolved from the HF API for these exact commits), so an
// upstream update or a corrupted transfer cannot land in the renderer bundle.
const V2_REVISION = 'c3b67641fd837b2368757101311e5d21e511441e'
const V3_REVISION = '0b6a7f3bf5595f9950b91389e0da3a0de130324c'
const V2_BASE = `https://huggingface.co/onnx-community/depth-anything-v2-small-ONNX/resolve/${V2_REVISION}/onnx`
const V3_BASE = `https://huggingface.co/onnx-community/depth-anything-v3-small/resolve/${V3_REVISION}/onnx`

// Each model's files and the directory they land in. Names on disk match what
// the worker's per-model config expects (fp16/fp32 split for DA2; the single
// fp32 graph plus its external-data sibling for DA3).
const MODELS = [
  {
    label: 'Depth Anything V2 Small',
    dir: V2_DIR,
    files: [
      // fp16 for the WebGPU path (fast, half the size), with its external-data file.
      {
        url: `${V2_BASE}/model_fp16.onnx`,
        name: 'model_fp16.onnx',
        sizeBytes: 180471,
        sha256: '3f220770bf259ef0cc1a8253f4f29419d4d15092902d78ded851669291d876e2',
      },
      {
        url: `${V2_BASE}/model_fp16.onnx_data`,
        name: 'model_fp16.onnx_data',
        sizeBytes: 50392064,
        sha256: '4c3b600a87aa247593ceaafb11cd1f40568dc391cd1305d6ad01075079297ddd',
      },
      // fp32 for the wasm fallback: the wasm EP's fp16 support is weak, so the
      // no-WebGPU path (Linux, Raspberry Pi) needs a full-precision model to run.
      {
        url: `${V2_BASE}/model.onnx`,
        name: 'model_fp32.onnx',
        sizeBytes: 127382,
        sha256: '345f249eda90f33e0548890f2fe1e89662c1dbb5a8b7c10a50492558f65e85a3',
      },
    ],
  },
  {
    label: 'Depth Anything 3 Small',
    dir: V3_DIR,
    files: [
      // fp32 only (no fp16 export). The graph file references model.onnx_data,
      // so keep both names verbatim.
      {
        url: `${V3_BASE}/model.onnx`,
        name: 'model.onnx',
        sizeBytes: 640691,
        sha256: '396008798244a074297fd88e450433b1357fc687f534939375c804ded86e7b2a',
      },
      {
        url: `${V3_BASE}/model.onnx_data`,
        name: 'model.onnx_data',
        sizeBytes: 104702464,
        sha256: '802bb24741e67f5bb2b369fc64d40afe11439cc895d676d658d65cfb75c9860f',
      },
    ],
  },
]

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** The size of a file, or null when it is missing. */
async function sizeOf(path) {
  try {
    return (await stat(path)).size
  } catch {
    return null
  }
}

async function download(url, destination, { sizeBytes, sha256 }) {
  process.stdout.write(`  downloading ${url}\n`)
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`failed to fetch ${url}: ${response.status} ${response.statusText}`)
  }
  // Hash while streaming, then check size and digest against the pins. A bad
  // file is deleted so the next run re-downloads instead of skipping it.
  const hash = createHash('sha256')
  const hashing = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body), hashing, createWriteStream(destination))
  try {
    const info = await stat(destination)
    if (info.size !== sizeBytes) {
      throw new Error(`size mismatch for ${url}: expected ${sizeBytes} bytes, got ${info.size}`)
    }
    const actual = hash.digest('hex')
    if (actual !== sha256) {
      throw new Error(`sha256 mismatch for ${url}: expected ${sha256}, got ${actual}`)
    }
    process.stdout.write(`  saved ${destination} (${(info.size / 1e6).toFixed(1)} MB)\n`)
  } catch (error) {
    await rm(destination, { force: true })
    throw error
  }
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
  await mkdir(ORT_DIR, { recursive: true })

  const force = process.argv.includes('--force')
  for (const model of MODELS) {
    await mkdir(model.dir, { recursive: true })
    process.stdout.write(`Fetching ${model.label}...\n`)
    for (const file of model.files) {
      const destination = join(model.dir, file.name)
      // Skip files already present so this is idempotent and cheap to run as
      // part of `package`: a repeat build re-uses the cached weights instead of
      // re-downloading hundreds of MB. Only a file whose size matches the pin
      // counts as present, so a truncated earlier fetch is re-downloaded. Pass
      // --force to re-fetch regardless.
      if (!force && (await sizeOf(destination)) === file.sizeBytes) {
        process.stdout.write(`  present ${file.name}\n`)
        continue
      }
      await download(file.url, destination, file)
    }
  }

  process.stdout.write('Copying onnxruntime-web binaries...\n')
  await copyOrtRuntime()

  process.stdout.write('Done. Live depth assets are ready.\n')
}

main().catch((error) => {
  process.stderr.write(`fetch-models failed: ${error.message}\n`)
  process.exitCode = 1
})
