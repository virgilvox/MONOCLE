// Bundle a relocatable Python interpreter with the sidecar installed, so a
// shipped build can reconstruct a real scan with no local Python setup. This is
// the fix for the release blocker in docs/AUDIT.md.
//
// It downloads a python-build-standalone "install_only" interpreter for the
// current platform, verifies its checksum, extracts it to
// apps/desktop/resources/python, and pip-installs the sidecar with the chosen
// extras into it. electron-builder copies resources/python into the app, and
// the main process prefers it (see src/main/python.ts).
//
//   node scripts/bundle-python.mjs [--extras depth,reconstruct] [--force]
//
// Pins are overridable for a newer interpreter:
//   MONOCLE_PBS_RELEASE (default 20241016), MONOCLE_PY_VERSION (default 3.12.7).
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')
const repoRoot = join(appDir, '..', '..')
const sidecarDir = join(repoRoot, 'sidecar')
const destDir = join(appDir, 'resources', 'python')

const RELEASE = process.env.MONOCLE_PBS_RELEASE ?? '20241016'
const PY_VERSION = process.env.MONOCLE_PY_VERSION ?? '3.12.7'

// Map the running platform to a python-build-standalone target triple. Override
// the whole build on a machine by cross-bundling is out of scope: run this on
// each target in CI (see docs/BUILD.md).
const TRIPLES = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc',
}

const args = process.argv.slice(2)
const force = args.includes('--force')
const extrasArg = args[args.indexOf('--extras') + 1]
const extras = args.includes('--extras') && extrasArg ? extrasArg : 'depth'

const isWindows = process.platform === 'win32'
const interpreter = isWindows ? join(destDir, 'python.exe') : join(destDir, 'bin', 'python3')

function run(cmd, cmdArgs, opts = {}) {
  execFileSync(cmd, cmdArgs, { stdio: 'inherit', ...opts })
}

async function download(url, outPath) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  writeFileSync(outPath, buffer)
  return buffer
}

async function main() {
  const key = `${process.platform}-${process.arch}`
  const triple = TRIPLES[key]
  if (!triple) throw new Error(`no python-build-standalone target for ${key}`)

  if (existsSync(interpreter) && !force) {
    console.log(`interpreter already present at ${interpreter}; reinstalling sidecar only`)
  } else {
    rmSync(destDir, { recursive: true, force: true })
    mkdirSync(dirname(destDir), { recursive: true })

    const asset = `cpython-${PY_VERSION}+${RELEASE}-${triple}-install_only.tar.gz`
    const base = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}`
    const archive = join(dirname(destDir), asset)

    console.log(`downloading ${asset}`)
    const buffer = await download(`${base}/${asset}`, archive)

    // Verify against the published checksum so a corrupted or swapped asset
    // cannot slip into a release build. Check the fetch succeeded first, so a
    // renamed or missing checksum asset is a clear error rather than a spurious
    // "checksum mismatch" against a 404 page.
    const sumRes = await fetch(`${base}/${asset}.sha256`)
    if (!sumRes.ok) {
      throw new Error(`checksum fetch failed ${sumRes.status}: ${base}/${asset}.sha256`)
    }
    const expected = (await sumRes.text()).trim().split(/\s+/)[0]
    const actual = createHash('sha256').update(buffer).digest('hex')
    if (expected && actual !== expected) {
      throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`)
    }

    // The install_only archive extracts to a top-level `python/` directory.
    console.log('extracting')
    run('tar', ['-xzf', archive, '-C', dirname(destDir)])
    rmSync(archive, { force: true })
  }

  if (!existsSync(interpreter)) {
    throw new Error(`interpreter not found after extraction: ${interpreter}`)
  }

  // The extraction wiped resources/python, including the committed .gitkeep that
  // keeps the directory (and its ignore exception) in the repo. Restore it so
  // running this script never shows up as a deleted tracked file.
  writeFileSync(
    join(destDir, '.gitkeep'),
    '# Placeholder so electron-builder always finds resources/python.\n' +
      '# The relocatable interpreter tree is produced by scripts/bundle-python.mjs\n' +
      '# and is gitignored. See docs/BUILD.md.\n',
  )

  // Install the sidecar and the requested extras into the standalone tree. The
  // interpreter is relocatable, so the resulting app resolves its own packages.
  console.log(`installing sidecar[${extras}]`)
  run(interpreter, ['-m', 'pip', 'install', '--upgrade', 'pip'])
  run(interpreter, ['-m', 'pip', 'install', `${sidecarDir}[${extras}]`])

  const version = execFileSync(interpreter, ['--version']).toString().trim()
  console.log(`bundled ${version} at ${interpreter}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
