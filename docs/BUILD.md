# Building and releasing

MONOCLE ships as an Electron app with a Python inference sidecar. This covers
local builds, the CI/release pipeline, and code signing.

## Local build

```
pnpm install
pnpm build:libs
pnpm --filter @monoclejs/desktop fetch:models     # pre-fetch live-depth models (package runs this automatically)
pnpm --filter @monoclejs/desktop bundle:python    # bundle the interpreter (see below)
pnpm --filter @monoclejs/desktop package:bundled  # unsigned installer in apps/desktop/release/
```

`package` (without the interpreter) still works and produces a smaller build
that reconstructs only with a local Python; `package:bundled` runs
`bundle:python` first for a self-contained installer.

For a signed build, set the environment variables below and run
`scripts/build-signed.sh`.

## Release pipeline

`.github/workflows/release.yml` runs on a `v*.*.*` tag (or manual dispatch) and
builds installers on a matrix:

| Runner           | Output                                       |
| ---------------- | -------------------------------------------- |
| macos-14         | macOS `.dmg` + `.zip`, arm64 (Apple Silicon) |
| macos-13         | macOS `.dmg` + `.zip`, x64 (Intel)           |
| ubuntu-22.04     | Linux `.AppImage`, x64                       |
| ubuntu-24.04-arm | Linux `.AppImage`, arm64 (Raspberry Pi)      |
| windows-latest   | Windows NSIS installer, x64                  |

macOS is split into one job per architecture so the `bundle:python` step on each
runner fetches the matching relocatable interpreter; a single job cannot bundle
both arm64 and x64 interpreters at once. Each job runs `bundle:python` before
packaging, so every published installer is self-contained. Builds succeed
unsigned when no signing secrets are set, so the pipeline works before you have
certs.

Platform notes worth knowing:

- **Linux is AppImage only.** `.deb` is intentionally omitted: electron-builder's
  bundled `fpm` ships an x86 Ruby that cannot run on an arm64 runner, it does not
  honor the `--arm64` arch filter, and it derives the package filename from the
  scoped name `@monoclejs/desktop`. AppImage sidesteps all three and runs on
  Debian/Ubuntu and Raspberry Pi.
- **Linux runners free ~20 GB first.** The bundled torch/DA3 interpreter plus the
  AppImage staging exceed the runner's default disk, so a step reclaims the
  preinstalled Android/dotnet/GHC/CodeQL toolchains before building.
- **macOS raises the open-file limit** before signing (the interpreter has many
  small files; the default 256 limit hits EMFILE), and a verify step blocks the
  publish if the bundled numpy links Apple Accelerate instead of OpenBLAS (see
  "Bundling the Python sidecar").

`.github/workflows/ci.yml` runs typecheck, tests, format check, and a build on
every push and pull request to `main`.

Note: `ubuntu-24.04-arm` requires arm64 hosted runners. If your account lacks
them, drop that matrix entry or build Linux arm64 on a Raspberry Pi.

## GitHub secrets

Set these under Settings, Secrets and variables, Actions. All are optional;
missing ones just skip that platform's signing.

### macOS signing and notarization

| Secret                        | What it is                                                   | How to produce                          |
| ----------------------------- | ------------------------------------------------------------ | --------------------------------------- |
| `MAC_CSC_LINK`                | base64 of your Developer ID Application certificate (`.p12`) | `base64 -i DeveloperID.p12 \| pbcopy`   |
| `MAC_CSC_KEY_PASSWORD`        | the password you set when exporting the `.p12`               |                                         |
| `APPLE_ID`                    | your Apple ID email                                          | appleid.apple.com                       |
| `APPLE_APP_SPECIFIC_PASSWORD` | an app-specific password for that Apple ID                   | appleid.apple.com, Sign-In and Security |
| `APPLE_API_KEY_ID`            | your 10-char Team ID (reused for the Team ID here)           | developer.apple.com, Membership         |

Notarization uses the Apple ID plus an app-specific password. The workflow reads
the Team ID from `APPLE_API_KEY_ID` (that secret holds the team id here, reused so
it does not have to be set again), and electron-builder notarizes with notarytool
when `APPLE_ID` is present. Signing alone (no notarization) works with just the
two `MAC_CSC_*` secrets. To switch to the App Store Connect API-key method
instead, export `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` in the
signing step in place of the three Apple ID vars.

### Windows signing

| Secret                     | What it is                                       | How to produce       |
| -------------------------- | ------------------------------------------------ | -------------------- |
| `WINDOWS_CSC_LINK`         | base64 of your code-signing certificate (`.pfx`) | `base64 -i cert.pfx` |
| `WINDOWS_CSC_KEY_PASSWORD` | the `.pfx` password                              |                      |

For newer certificates, Azure Trusted Signing is an alternative; wire it in the
Windows signing step in place of `CSC_LINK`.

### Automatic

`GITHUB_TOKEN` is provided by Actions and is used to publish the release. No
setup needed.

## Local signing env

`scripts/build-signed.sh` reads the same values, but as plain (not base64) env
vars where a file is expected:

- macOS: `CSC_LINK` (path or base64 of the `.p12`), `CSC_KEY_PASSWORD`, and for
  notarization `APPLE_API_KEY` (path to the `.p8`), `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER`.
- Windows: `CSC_LINK` (path or base64 of the `.pfx`), `CSC_KEY_PASSWORD`.

## Bundling the Python sidecar

A self-contained installer bundles a relocatable interpreter so an end user
reconstructs a real scan with no local Python setup.

`scripts/bundle-python.mjs` (run via `pnpm --filter @monoclejs/desktop
bundle:python`) downloads a [python-build-standalone][pbs] `install_only`
interpreter for the current platform, verifies its published SHA-256, extracts
it to `apps/desktop/resources/python`, and `pip install`s the sidecar into it.
electron-builder copies that tree into the app's resources, and the main process
prefers it (`src/main/python.ts` resolves, in order: `MONOCLE_PYTHON` override,
bundled interpreter, dev `.venv`, system Python).

- The default extra is `walk`: a lean build (~680 MB on macOS arm64) that runs
  the default Object scan (DA2 depth + visual odometry + Open3D TSDF, no torch)
  fully offline. The heavy Depth Anything 3 multi-view stack (torch + DA3 weights,
  ~3 GB) is **not** bundled; the app downloads it on demand into user app-data
  when the user opts in (`src/main/da3/pack.ts`), which also keeps the installer
  off the macOS 12 floor since torch's arm64-macOS wheels are macOS 14+ anyway.
  Pass `--extras walk,multiview` to bundle DA3 into the installer instead.
- The on-demand DA3 pack installs with the bundled interpreter's own pip into
  `<userData>/da3` (macOS `~/Library/Application Support/MONOCLE`, Windows
  `%APPDATA%`, Linux `~/.config`), so wheels match the platform and arch, and the
  sidecar picks it up via `PYTHONPATH` + `MONOCLE_DA3_CKPT` on its next restart.
  The mac entitlements enable `disable-library-validation` so the signed
  interpreter can load those runtime-installed native wheels.
- When `--extras walk,multiview` is passed, the multi-view install is
  best-effort: if a heavy dependency has no wheel on a platform (for example
  `pycolmap` on arm64 Linux), the script still ships the working walk-around
  build and the release step is `continue-on-error`.
- A release step scans every bundled wheel's macOS platform tag and fails the
  build if any required wheel targets macOS 13+, so a wheel built for a newer OS
  than the support floor can never ship (it would import on the macos-14 build
  host but fail to `dlopen` on an older Mac).
- On macOS the script re-pins numpy and scipy to their OpenBLAS wheels. numpy
  ships two macOS wheels per version, and pip on the macos-14 runner would
  otherwise pick the Apple Accelerate build, which uses LAPACK symbols that exist
  only on macOS 14+ and crashes on a user's macOS 11-13 the moment numpy imports.
  A release step verifies the pin took before publishing.
- The interpreter tree is large and platform-specific, so it is gitignored; only
  a `.gitkeep` placeholder is committed. Run `bundle:python` on each target
  platform in the release matrix.
- Pins are overridable with `MONOCLE_PBS_RELEASE` and `MONOCLE_PY_VERSION`; the
  sidecar needs Python 3.12 (onnxruntime has no macOS 12 wheel for 3.13).
- Without the bundle, a plain `package` build still ships and runs the Electron
  shell, live-depth preview, capture UI, and the synthetic pipeline; only real
  reconstruction needs a local Python.

[pbs]: https://github.com/astral-sh/python-build-standalone
