# Building and releasing

MONOCLE ships as an Electron app with a Python inference sidecar. This covers
local builds, the CI/release pipeline, and code signing.

## Local build

```
pnpm install
pnpm build:libs
pnpm --filter @monoclejs/desktop fetch:models     # optional: bundle live-depth model
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

| Runner           | Output                                           |
| ---------------- | ------------------------------------------------ |
| macos-14         | macOS `.dmg` + `.zip`, arm64 (Apple Silicon)     |
| macos-13         | macOS `.dmg` + `.zip`, x64 (Intel)               |
| ubuntu-22.04     | Linux `.AppImage` + `.deb`, x64                  |
| ubuntu-24.04-arm | Linux `.AppImage` + `.deb`, arm64 (Raspberry Pi) |
| windows-latest   | Windows NSIS installer, x64                      |

macOS is split into one job per architecture so the `bundle:python` step on each
runner fetches the matching relocatable interpreter; a single job cannot bundle
both arm64 and x64 interpreters at once. Each job runs `bundle:python` before
packaging, so every published installer is self-contained. Builds succeed
unsigned when no signing secrets are set, so the pipeline works before you have
certs.

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
it to `apps/desktop/resources/python`, and `pip install`s the sidecar with the
`depth` extra into it. electron-builder copies that tree into the app's
resources, and the main process prefers it (`src/main/python.ts` resolves, in
order: `MONOCLE_PYTHON` override, bundled interpreter, dev `.venv`, system
Python).

- The interpreter tree is large and platform-specific, so it is gitignored; only
  a `.gitkeep` placeholder is committed. Run `bundle:python` on each target
  platform in the release matrix.
- Extras are selectable: `node scripts/bundle-python.mjs --extras
depth,reconstruct` also bundles Open3D and torch for multi-view fusion (much
  larger). The default `depth` extra covers single-view depth reconstruction.
- Pins are overridable with `MONOCLE_PBS_RELEASE` and `MONOCLE_PY_VERSION`; the
  sidecar needs Python 3.12 (onnxruntime has no macOS 12 wheel for 3.13).
- Without the bundle, a plain `package` build still ships and runs the Electron
  shell, live-depth preview, capture UI, and the synthetic pipeline; only real
  reconstruction needs a local Python.

[pbs]: https://github.com/astral-sh/python-build-standalone
