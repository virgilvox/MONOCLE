# MONOCLE UI/UX and design audit

A design audit of the current renderer, and the brief for a redesign. This is
the reference the redesign kickoff prompt points at. Read alongside
[HANDOFF.md](HANDOFF.md) and [CLAUDE.md](../CLAUDE.md).

## Verdict: clean, but no point of view

The current UI is a competent, restrained dark dashboard. It avoids the cliche
AI-app look (no purple/neon gradients, no glassmorphism-by-default, no emoji
icons, calm surfaces, mono for numbers). That restraint is worth keeping. But it
has almost no identity: the accent is the default SaaS blue (`#4c8dff`), the
brand mark is a bare ring, the type is the system font, and the 3D and camera
surfaces are anonymous. Nothing says optics, lens, or precision instrument,
which the name MONOCLE invites.

## The centralization problem

`main.css` defines only a thin token set: colors, two radii, one spacing value
(`--gap: 16px`), two font stacks. Everything else is hand-authored per component,
so the theme is not actually centralized. Representative leaks:

- Hardcoded colors that bypass tokens: `CameraView.vue` (`#05070b`, accent and
  `--bad` re-typed as literal rgba), `CaptureHud.vue` (three semantic colors as
  literal rgba), `LiveDepthView.vue` (`#c4cddf`, an overlay rgba, and `rem` units
  while the app is on `px`), `ReconstructPanel.vue`.
- The Three.js surfaces (`MeshViewer.vue`, `LiveDepthView.vue`) hardcode hex
  colors (`0x0e1119`, `0x2b4a8a`, `0x9fb2d4`, ...) that duplicate CSS token
  values with no shared source, so the viewport drifts from the chrome.
- Radii: `999px` and `3px` re-typed in several files despite `--radius` tokens.
- Spacing: only `--gap` is a token; raw 4/5/6/8/10/12/14px appear dozens of times.
- Type: no size/weight/leading tokens; font sizes are scattered literals; letter
  spacing hardcoded three different ways.
- Motion: durations are literals; no easing or duration tokens. No elevation
  system.

## Accessibility gaps (fix regardless of the redesign)

- No `:focus-visible` anywhere. Keyboard focus is invisible. Highest-priority.
- No `prefers-reduced-motion` handling.
- `--text-faint (#64708a)` is about 3.9:1 on the background, below the 4.5:1 AA
  floor, and it is used for the smallest 11 to 12px text throughout.
- Status is conveyed by color-only dots; pair them with shape or a glyph.
- Stage tabs are plain buttons with no `role="tab"` / `aria-selected`.

## What works and should be preserved

- The keyframe gate to HUD loop (`useKeyframeGate.ts` plus `CaptureHud.vue`) is
  genuinely good product design: sharpness and motion become plain guidance with
  a coverage bar and focus meter, plus a manual capture override. This is the
  most instrument-like part of the app and should anchor the identity.
- The reconstruct flow is coherent: disabled-with-reason, progress with stage and
  percent, cancel, result counts, format select, save, and reveal.
- The restraint: no neon, no emoji, calm surfaces, mono numerics.

## Design direction: a precision optics instrument

Mine the vocabulary of sighting instruments and camera bodies: machined
graphite and gunmetal, engraved type, reticles and corner brackets, focus and
aperture rings, ground glass, lens-coating colors, and tabular telemetry
readouts. Amplify the corner-bracket framing already faintly present on the
camera view; retire the rounded-SaaS-dashboard language.

### Design system (author as CSS variables and a shared TS module)

Export the shared subset from one `theme.ts` that `MeshViewer` and
`LiveDepthView` import, so CSS and Three.js never diverge.

- Surfaces: graphite, off the current blue cast. `--surface-0 #0c0e10`,
  `--surface-1 #14171a`, `--surface-2 #1b1f23`, `--viewport #0a0c0e`.
- Ink ladder that passes AA at 11 to 12px: `--ink-hi #eef1f4`, `--ink #b9c0c7`,
  `--ink-lo #7d868f` (raised from the failing faint value).
- Line: `--line #262b30`, `--line-strong #3a424a`.
- Accent: a desaturated optical-coating cyan, not neon. `--accent #3fb6c4`,
  `--accent-press #2a808b`, `--accent-tint rgba(63,182,196,.14)`.
- Signature: machined brass/amber for the wordmark, reticle, and focus cue, used
  sparingly. `--brass #c8a15a`.
- Semantic sets, each with fg / tint / line: `--ok`, `--warn`, `--danger` (danger
  doubles as the record color).
- Space: 4px base scale (`--space-1 4` through `--space-8 48`); retire `--gap`.
- Radius: tighter for an instrument feel (`--r-sm 6`, `--r-md 8/10`, `--r-full`).
- Type: bundle IBM Plex Sans + IBM Plex Mono (engineering heritage, free,
  avoids both system-default and the Inter/AI look); optional Space Grotesk for
  the wordmark and large readouts. Define a size scale, two line heights, a caps
  tracking token, and enforce tabular figures (`font-feature-settings: "tnum"`)
  on all telemetry.
- Elevation: one or two tight, near-black lifts for the HUD and menus.
- Motion: `--dur-fast 120ms`, `--dur 180ms`, `--ease cubic-bezier(.2,.6,.2,1)`,
  plus a global reduced-motion override.
- Add stroke-width and z-index scales.

### Iconography

Adopt one self-hosted line set (Lucide, MIT, ~1.5 to 2px stroke) and hand-draw
4 to 6 bespoke optical glyphs: aperture, lens, reticle/crosshair, focus ring,
orbit, wireframe. Monoline on a 24px grid, accent only when active. Replace the
CSS chevron, the ring brand mark (to an aperture/monocle glyph), and back the
viewer toolbar, camera, and reconstruct controls with icon plus label.

### Information architecture

Split the overloaded, flat sidebar into a Workflow group (Preset, Camera,
Capture, Reconstruct) and a demoted, collapsible Diagnostics group (Rendering,
Inference engine). Give the current step and the primary action (Reconstruct)
dominant weight; consider expressing the linear flow as a light stepper rather
than six identical cards. Art-direct the camera and 3D surfaces with corner
brackets, a measured grid, a ground plane, and a subtle vignette so both read as
one instrument.

## Prioritized changes

1. Add `:focus-visible` across all interactives and `prefers-reduced-motion`.
2. Fix the text contrast ladder to pass AA at small sizes.
3. Introduce full token scales (space, type, radius, motion, semantic
   fg/tint/line) and replace the hardcoded literals. This is the centralization.
4. Bundle IBM Plex Sans + Mono; enforce tabular figures on all numerics.
5. Re-tune the palette to graphite + optical-cyan accent + brass signature.
6. One shared theme module feeding both CSS and Three.js.
7. Icon system (Lucide plus bespoke optical glyphs); retire CSS dots/triangle/ring.
8. Re-tier the sidebar IA; elevate the primary action.
9. Art-direct the viewport and live-depth surfaces.
10. A few intentional, tokenized, reduced-motion-aware transitions.

Keep the restraint and the excellent capture-gate UX; centralize everything into
real token scales; inject precision-optics character through typography, palette,
a bespoke icon set, and instrument framing; and close the focus, contrast, and
reduced-motion gaps.
