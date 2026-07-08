# Building and releasing

MONOCLE ships as an Electron app with a Python inference sidecar. This covers
local builds, the CI/release pipeline, and code signing.

## Local build

```
pnpm install
pnpm build:libs
pnpm --filter @monoclejs/desktop fetch:models   # optional: bundle live-depth model
pnpm --filter @monoclejs/desktop package         # unsigned installer in apps/desktop/release/
```

For a signed build, set the environment variables below and run
`scripts/build-signed.sh`.

## Release pipeline

`.github/workflows/release.yml` runs on a `v*.*.*` tag (or manual dispatch) and
builds installers on a matrix:

| Runner           | Output                                           |
| ---------------- | ------------------------------------------------ |
| macos-14         | macOS `.dmg` + `.zip`, arm64 and x64             |
| ubuntu-22.04     | Linux `.AppImage` + `.deb`, x64                  |
| ubuntu-24.04-arm | Linux `.AppImage` + `.deb`, arm64 (Raspberry Pi) |
| windows-latest   | Windows NSIS installer, x64                      |

Each job publishes to the GitHub Release for the tag. Builds succeed unsigned
when no signing secrets are set, so the pipeline works before you have certs.

`.github/workflows/ci.yml` runs typecheck, tests, format check, and a build on
every push and pull request to `main`.

Note: `ubuntu-24.04-arm` requires arm64 hosted runners. If your account lacks
them, drop that matrix entry or build Linux arm64 on a Raspberry Pi.

## GitHub secrets

Set these under Settings, Secrets and variables, Actions. All are optional;
missing ones just skip that platform's signing.

### macOS signing and notarization

| Secret                 | What it is                                                   | How to produce                                    |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| `MAC_CSC_LINK`         | base64 of your Developer ID Application certificate (`.p12`) | `base64 -i DeveloperID.p12 \| pbcopy`             |
| `MAC_CSC_KEY_PASSWORD` | the password you set when exporting the `.p12`               |                                                   |
| `APPLE_API_KEY_BASE64` | base64 of your App Store Connect API key (`.p8`)             | `base64 -i AuthKey_XXXX.p8 \| pbcopy`             |
| `APPLE_API_KEY_ID`     | the API key ID (the `XXXX` in the filename)                  | App Store Connect, Users and Access, Integrations |
| `APPLE_API_ISSUER`     | the issuer UUID for that key                                 | same page                                         |

The workflow decodes `APPLE_API_KEY_BASE64` to a file and points `APPLE_API_KEY`
at it; electron-builder notarizes with notarytool when all three Apple vars are
present. Signing alone (no notarization) works with just the two `MAC_CSC_*`
secrets.

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

## Known limitation: sidecar bundling

The installer currently copies the sidecar as Python source, not a bundled
interpreter, so a shipped app needs Python plus the sidecar extras available to
reconstruct. Bundling a relocatable interpreter per platform (python-build-
standalone or PyInstaller, one directory in `extraResources`) is the remaining
step to a fully self-contained distributable. The Electron shell, live-depth
preview, and capture UI work without it.
