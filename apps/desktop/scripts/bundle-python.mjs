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
// The default extra is `walk`: a lean (~680 MB) build that runs the default
// Object scan (DA2 depth + visual odometry + TSDF, Open3D) fully offline. The
// heavy Depth Anything 3 multi-view stack (torch + DA3 weights, ~3 GB) is NOT
// bundled; the app downloads it on demand into user app-data (src/main/da3/).
// Pass `--extras walk,multiview` to bundle DA3 into the installer anyway; the
// DA3 weights are fetched only when multiview is in the extras.
//
//   node scripts/bundle-python.mjs [--extras walk,multiview] [--force]
//
// Pins are overridable for a newer interpreter:
//   MONOCLE_PBS_RELEASE (default 20241016), MONOCLE_PY_VERSION (default 3.12.7).
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')
const repoRoot = join(appDir, '..', '..')
const sidecarDir = join(repoRoot, 'sidecar')
const destDir = join(appDir, 'resources', 'python')

const RELEASE = process.env.MONOCLE_PBS_RELEASE ?? '20241016'
const PY_VERSION = process.env.MONOCLE_PY_VERSION ?? '3.12.7'

// The single-view depth and walk-around backends run this Depth Anything V2
// (small) ONNX on the CPU provider. Bundling it makes a shipped build fully
// offline: without it the sidecar's _resolve_model_path falls back to a Hugging
// Face download on the first scan, which needs network and fails offline. It is
// the fp32 export (~94 MB) because the CPU provider's fp16 support is weak.
// Model URLs are pinned to specific Hugging Face revisions and verified by size
// and sha256 (resolved from the HF API for these exact commits), so an upstream
// repo update or a corrupted transfer cannot slip into a release build.
const modelsDir = join(appDir, 'resources', 'models')
const da2ModelPath = join(modelsDir, 'depth-anything-v2-small.onnx')
const DA2_MODEL_REVISION = '4472b7362082ad9968fee890ca0f1e5aca36b93d'
const DA2_MODEL_URL = `https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/${DA2_MODEL_REVISION}/onnx/model.onnx`
const DA2_MODEL_PIN = {
  sizeBytes: 99060839,
  sha256: 'afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c',
}

// Depth Anything 3 (BASE, Apache-2.0, ~517 MB) for the multi-view path. Bundled
// only when the multiview stack is in --extras, since without torch the weights
// are dead weight. from_pretrained loads a local directory, so the app points
// MONOCLE_DA3_CKPT at this folder. LARGE and GIANT are CC-BY-NC and stay opt-in.
const da3Dir = join(modelsDir, 'da3-base')
const DA3_REVISION = 'f4a6c9b3c95e41c82048423d3493a81ec3fa810e'
const DA3_REPO = `https://huggingface.co/depth-anything/DA3-BASE/resolve/${DA3_REVISION}`
const DA3_FILES = [
  // config.json is a small non-LFS file: the HF API publishes no sha256 for it,
  // so the pinned revision and size are its only anchors.
  { name: 'config.json', sizeBytes: 1205, sha256: '' },
  {
    name: 'model.safetensors',
    sizeBytes: 541518028,
    sha256: 'e01067dc1659613083d9145a9a2547ccdbe6ccbbf83c4fe7b3e8a4e2bdae78b5',
  },
]

// The DA3 model code from PyPI, pinned so a rebuild installs what was tested.
// Bump together with the on-demand pack's pin in src/main/da3/pack.ts.
const DA3_PYPI_VERSION = '0.1.1'

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
// Default to the lean `walk` build: the fast default Object scan (DA2 depth +
// visual odometry + Open3D TSDF, no torch), a ~680 MB installer. The heavy Depth
// Anything 3 multi-view stack (multiview: torch + DA3 runtime deps + weights,
// ~3 GB) is downloaded on demand into user app-data by the app (see
// src/main/da3/pack.ts), not bundled. Pass `--extras walk,multiview` to bundle
// DA3 into the installer anyway (a large build, mostly torch).
const extras = args.includes('--extras') && extrasArg ? extrasArg : 'walk'

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

// Download a pinned model file and verify its size and sha256, retrying like
// the interpreter download below: a truncated or swapped file must fail the
// build, not ship. An empty pinned sha256 (a non-LFS file with no published
// hash) skips the hash comparison but never the size check.
async function downloadVerified(url, outPath, { sizeBytes, sha256 }) {
  const attempts = 3
  for (let attempt = 1; ; attempt += 1) {
    try {
      const buffer = await download(url, outPath)
      if (buffer.length !== sizeBytes) {
        throw new Error(
          `size mismatch for ${url}: expected ${sizeBytes} bytes, got ${buffer.length}`,
        )
      }
      if (sha256) {
        const actual = createHash('sha256').update(buffer).digest('hex')
        if (actual !== sha256) {
          throw new Error(`checksum mismatch for ${url}: expected ${sha256}, got ${actual}`)
        }
      }
      return
    } catch (error) {
      rmSync(outPath, { force: true })
      if (attempt >= attempts) throw error
      console.warn(`model download failed (${error.message}); retrying`)
    }
  }
}

/** The size of a regular file, or null when it is missing. */
function fileSize(path) {
  try {
    const info = statSync(path)
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

async function main() {
  const key = `${process.platform}-${process.arch}`
  const triple = TRIPLES[key]
  if (!triple) throw new Error(`no python-build-standalone target for ${key}`)

  if (existsSync(interpreter) && !force) {
    console.log(`interpreter already present at ${interpreter}; reinstalling sidecar only`)
  } else {
    const asset = `cpython-${PY_VERSION}+${RELEASE}-${triple}-install_only.tar.gz`
    const base = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}`
    const archive = join(dirname(destDir), asset)

    // Download, checksum, and extract, retrying a couple of times: a runner
    // occasionally truncates the write or trips a transient tar error ("Error is
    // not recoverable"), which would otherwise ship an installer with no
    // interpreter. Each attempt starts from a clean destination.
    const attempts = 3
    for (let attempt = 1; ; attempt += 1) {
      try {
        rmSync(destDir, { recursive: true, force: true })
        mkdirSync(dirname(destDir), { recursive: true })

        console.log(`downloading ${asset}${attempt > 1 ? ` (attempt ${attempt})` : ''}`)
        const buffer = await download(`${base}/${asset}`, archive)

        // Verify against the published checksum so a corrupted or swapped asset
        // cannot slip into a release build. Check the fetch succeeded first, so a
        // renamed or missing checksum asset is a clear error rather than a
        // spurious "checksum mismatch" against a 404 page.
        const sumRes = await fetch(`${base}/${asset}.sha256`)
        if (!sumRes.ok) {
          throw new Error(`checksum fetch failed ${sumRes.status}: ${base}/${asset}.sha256`)
        }
        const expected = (await sumRes.text()).trim().split(/\s+/)[0]
        if (!expected) {
          throw new Error(`empty checksum for ${asset}; refusing to skip verification`)
        }
        const actual = createHash('sha256').update(buffer).digest('hex')
        if (actual !== expected) {
          throw new Error(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`)
        }

        // The install_only archive extracts to a top-level `python/` directory.
        // Prefer Windows' bundled bsdtar (System32): the MSYS GNU tar from git
        // mishandles a D:\ path and forks an external gzip that fails on the
        // runner ("tar: Child returned status 128"). bsdtar handles Windows paths
        // and gzip internally, and -xf (no -z) auto-detects gzip on bsdtar and on
        // modern GNU tar alike, so it is correct on every platform.
        console.log('extracting')
        const tarBin = isWindows ? 'C:\\Windows\\System32\\tar.exe' : 'tar'
        run(tarBin, ['-xf', archive, '-C', dirname(destDir)])
        rmSync(archive, { force: true })
        break
      } catch (error) {
        rmSync(archive, { force: true })
        if (attempt >= attempts) throw error
        console.warn(`interpreter download/extract failed (${error.message}); retrying`)
      }
    }
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

  // Install the sidecar into the standalone tree. The lean base extras must
  // succeed; the heavy multi-view (DA3) stack is best-effort, because some
  // release platforms lack a prebuilt wheel for a multi-view dependency (Intel
  // macOS and arm64 Linux have no pycolmap wheel), and a platform that cannot
  // build DA3 should still ship the working walk-around build, not fail the
  // whole release. The interpreter is relocatable, so the app resolves its own
  // packages at runtime.
  run(interpreter, ['-m', 'pip', 'install', '--upgrade', 'pip'])

  const parts = extras
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
  const wantMultiview = parts.includes('multiview')
  const baseParts = parts.filter((e) => e !== 'multiview')
  const baseExtras = baseParts.length ? baseParts.join(',') : 'depth'

  console.log(`installing sidecar[${baseExtras}]`)
  run(interpreter, ['-m', 'pip', 'install', `${sidecarDir}[${baseExtras}]`])

  const version = execFileSync(interpreter, ['--version']).toString().trim()
  console.log(`bundled ${version} at ${interpreter}`)

  await bundleDa2Model()

  if (wantMultiview) {
    try {
      console.log('installing the Depth Anything 3 multi-view stack')
      run(interpreter, ['-m', 'pip', 'install', `${sidecarDir}[multiview]`])
      // bundleDa3Model installs depth-anything-3 itself (with --no-deps: its pins
      // do not build everywhere; the multiview extra supplies the real deps).
      await bundleDa3Model()
      console.log('bundled the Depth Anything 3 multi-view stack')
    } catch (error) {
      console.warn(
        'WARNING: the Depth Anything 3 multi-view stack could not be bundled on ' +
          `this platform (${error.message}). Shipping the walk-around build; the ` +
          'DA3 multi-view path is unavailable here.',
      )
    }
  }

  pinMacosPortableBlas()
}

/**
 * Force the OpenBLAS build of numpy and scipy on macOS.
 *
 * Both ship two macOS wheels per version: a portable `macosx_11_0` OpenBLAS
 * build and a `macosx_14_0` build linked against Apple's new Accelerate LAPACK,
 * whose `$NEWLAPACK$ILP64` symbols exist only on macOS 14+. The arm64 release is
 * built on the macos-14 runner, where pip prefers the Accelerate wheel; the
 * shipped interpreter then crashes on macOS 11-13 with "Symbol not found:
 * _cblas_caxpy$NEWLAPACK$ILP64" the moment numpy is imported (so every scan
 * fails, not just DA3). Re-download each package for a macOS 12 target -- which
 * resolves to the portable OpenBLAS wheel -- and force-reinstall it, keeping the
 * exact installed version so nothing built against that numpy ABI breaks.
 */
function pinMacosPortableBlas() {
  if (process.platform !== 'darwin') return
  const platformTag = process.arch === 'arm64' ? 'macosx_12_0_arm64' : 'macosx_12_0_x86_64'
  const pyTag = PY_VERSION.split('.').slice(0, 2).join('.')
  const abiTag = `cp${pyTag.replace('.', '')}`

  for (const pkg of ['numpy', 'scipy']) {
    const version = installedVersion(pkg)
    if (!version) continue
    console.log(`pinning ${pkg}==${version} to its portable ${platformTag} (OpenBLAS) wheel`)
    const wheelDir = join(dirname(destDir), `.wheel-${pkg}`)
    rmSync(wheelDir, { recursive: true, force: true })
    mkdirSync(wheelDir, { recursive: true })
    try {
      run(interpreter, [
        '-m',
        'pip',
        'download',
        `${pkg}==${version}`,
        '--no-deps',
        '--only-binary=:all:',
        '--platform',
        platformTag,
        '--implementation',
        'cp',
        '--python-version',
        pyTag,
        '--abi',
        abiTag,
        '-d',
        wheelDir,
      ])
      const wheel = readdirSync(wheelDir).find((name) => name.endsWith('.whl'))
      if (!wheel) throw new Error(`no ${platformTag} wheel downloaded`)
      // Guard against a future where only a macosx_14 (Accelerate) wheel resolves:
      // the portable build must carry a macOS 10/11/12 platform tag.
      if (!/macosx_1[012]_/.test(wheel)) {
        throw new Error(`resolved wheel is not a macOS 10-12 build: ${wheel}`)
      }
      run(interpreter, [
        '-m',
        'pip',
        'install',
        '--force-reinstall',
        '--no-deps',
        join(wheelDir, wheel),
      ])
    } catch (error) {
      // numpy failing to pin ships a build that crashes the moment it imports on
      // macOS 11-13 (invisible on the macOS 14 build host), so it is fatal. scipy
      // is best-effort. A verify step in release.yml is the authoritative gate.
      const message = `could not pin ${pkg} to a portable macOS wheel: ${error.message}`
      if (pkg === 'numpy') throw new Error(message)
      console.warn(`WARNING: ${message}`)
    } finally {
      rmSync(wheelDir, { recursive: true, force: true })
    }
  }
}

/** The installed version of a package, or null when it is not present. */
function installedVersion(pkg) {
  try {
    const out = execFileSync(interpreter, ['-m', 'pip', 'show', pkg]).toString()
    const match = out.match(/^Version:\s*(.+)$/m)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

async function bundleDa2Model() {
  mkdirSync(modelsDir, { recursive: true })
  // A committed .gitkeep keeps resources/models (gitignored otherwise) in the
  // repo so electron-builder always finds the directory, even before a bundle.
  writeFileSync(
    join(modelsDir, '.gitkeep'),
    '# Placeholder so electron-builder always finds resources/models.\n' +
      '# The Depth Anything V2 ONNX is produced by scripts/bundle-python.mjs and\n' +
      '# is gitignored (large). See docs/BUILD.md.\n',
  )
  // A cached file only skips the download when its size still matches the pin,
  // so a truncated earlier fetch cannot survive into a build.
  if (fileSize(da2ModelPath) === DA2_MODEL_PIN.sizeBytes && !force) {
    console.log(`DA2 model already present at ${da2ModelPath}`)
    return
  }
  console.log('downloading Depth Anything V2 (small) ONNX (~94 MB)')
  await downloadVerified(DA2_MODEL_URL, da2ModelPath, DA2_MODEL_PIN)
  console.log(`bundled DA2 model at ${da2ModelPath}`)
}

async function bundleDa3Model() {
  // Only when the multi-view (DA3) runtime is being bundled. A walk-only build
  // has no torch, so the DA3 weights would just bloat the installer.
  if (!extras.split(',').includes('multiview')) {
    console.log('skipping DA3 weights (multiview extra not bundled)')
    return
  }
  mkdirSync(da3Dir, { recursive: true })
  for (const file of DA3_FILES) {
    const out = join(da3Dir, file.name)
    if (fileSize(out) === file.sizeBytes && !force) {
      console.log(`DA3 ${file.name} already present`)
      continue
    }
    console.log(`downloading DA3-BASE ${file.name}`)
    await downloadVerified(`${DA3_REPO}/${file.name}`, out, file)
  }
  // The DA3 model code itself is not on the extra: its pins (xformers,
  // opencv-python) do not build everywhere, so it installs without deps, exactly
  // as docs and the multiview backend document. The multiview extra already
  // provides the real runtime dependencies.
  console.log(`installing depth-anything-3==${DA3_PYPI_VERSION} (--no-deps)`)
  run(interpreter, ['-m', 'pip', 'install', '--no-deps', `depth-anything-3==${DA3_PYPI_VERSION}`])
  console.log(`bundled DA3-BASE at ${da3Dir}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
