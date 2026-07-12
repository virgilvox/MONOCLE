# MONOCLE design system

The visual language and the tokens behind it. MONOCLE is a precision optical
instrument, so the interface borrows from sighting instruments and camera
bodies: machined graphite, a light optical-blue accent, a brass signature,
engraved labels, reticles and corner brackets, and tabular telemetry. It is
deliberately not the generic AI-app look: no purple or neon gradients, no
glassmorphism by default, no emoji icons, no system-font sameness.

## Where it lives

- `apps/desktop/src/renderer/src/styles/tokens.css` is the centralized theme:
  every color, space, type, radius, elevation, motion, stroke, and z-index value
  is a CSS custom property here. Components read tokens and author no raw values.
- `styles/base.css` owns the reset, element defaults, the accessibility baseline
  (focus-visible, reduced-motion), and the shared layout and text utilities.
- `styles/theme.ts` is the single source of truth for the palette the chrome and
  the Three.js viewport share. `MeshViewer` and `LiveDepthView` import it, so the
  3D surfaces and the CSS never drift. `theme.test.ts` parses `tokens.css` and
  fails the build if the mirror diverges.
- `main.ts` bundles the fonts (per weight) and imports the style entry.

## Color

Neutral machined graphite surfaces, an ink ladder that clears WCAG AA at 11px,
one light optical-blue accent, and machined brass as a sparingly used
signature. Semantic states carry a foreground, a tint, and a line each, and are
always paired with a shape so status never depends on color alone.

| Role         | Token            | Value     | Notes                                |
| ------------ | ---------------- | --------- | ------------------------------------ |
| Surface 0    | `--surface-0`    | `#0c0e10` | app background, contrast baseline    |
| Surface 1    | `--surface-1`    | `#14171a` | raised panels                        |
| Surface 2    | `--surface-2`    | `#1b1f23` | insets, wells, tracks                |
| Viewport     | `--viewport`     | `#0a0c0e` | 3D and camera canvas                 |
| Ink hi       | `--ink-hi`       | `#eef1f4` | headings, active readouts (17:1)     |
| Ink          | `--ink`          | `#b9c0c7` | body (10.5:1)                        |
| Ink lo       | `--ink-lo`       | `#7d868f` | muted, smallest text (5.2:1)         |
| Line         | `--line`         | `#262b30` | hairlines                            |
| Line strong  | `--line-strong`  | `#3a424a` | control borders                      |
| Accent       | `--accent`       | `#8ed3ef` | light optical blue, the one accent   |
| Accent press | `--accent-press` | `#4fa3cc` | pressed, grid major                  |
| Brass        | `--brass`        | `#c8a15a` | wordmark, reticle, focus lock        |
| OK           | `--ok`           | `#4cc38a` | with `--ok-tint`, `--ok-line`        |
| Warn         | `--warn`         | `#e0a53a` | with `--warn-tint`, `--warn-line`    |
| Danger       | `--danger`       | `#e5645f` | doubles as record; tint and line too |

Every foreground clears AA (>= 4.5:1) even on `--surface-1`; `--ink-lo` at
4.87:1 is the floor and is only used at small sizes on raised panels.

## Type

Three bundled families, no system fallback in normal use:

- `--font-display` Space Mono: the wordmark.
- `--font-sans` IBM Plex Sans: the UI.
- `--font-mono` IBM Plex Mono: all telemetry.

The scale runs `--text-2xs` (11px) to `--text-3xl` (34px) with two line heights,
a caps-tracking token for engraved labels, and a wider tracking token for the
wordmark. Every numeric readout uses `--numeric` (`tnum` plus `zero`) and
`tabular-nums`, so digits never shift as values change.

## Space, radius, elevation, motion

- Space is a 4px base scale, `--space-1` (4px) through `--space-8` (48px). The
  old single `--gap` is gone.
- Radius is tight for an instrument feel: `--r-sm` 6, `--r-md` 8, `--r-lg` 10,
  `--r-full`.
- Elevation is one or two near-black lifts (`--elevation-1`, `--elevation-2`).
- Motion is two durations and one easing (`--dur-fast` 120ms, `--dur` 180ms,
  `--ease`), and a global `prefers-reduced-motion` override in base.css collapses
  every transition and animation.
- Stroke widths (`--stroke-1/2/3`, 1.75px is the icon default) and a z-index
  scale round out the system.

## Iconography

One self-hosted line set plus a bespoke optical set, all on a 24px grid with a
1.75px optically constant stroke:

- Standard UI icons come from `@lucide/vue`, imported by name so the bundler
  tree-shakes the rest.
- Six bespoke optical glyphs live in `components/icons/optical.ts`: `iris`,
  `lens`, `reticle`, `focus-box`, `orbit`, `wireframe`.
- `components/icons/registry.ts` maps intent names (what an icon means here) to
  either set, and `Icon.vue` renders both alike. Icons are decorative by default
  (`aria-hidden`); pass a `title` to name one that carries meaning.
- `BrandMark.vue` is the mesh mark: a lens bezel with a low-poly surface
  reconstructed inside the glass, one face and the vertices solved in the accent.
  The wordmark sets MONO in ink and CLE in the accent (Space Mono).
- `StatusIndicator.vue` conveys state by silhouette (disc, triangle, diamond,
  ring, sweeping arc), not color, and replaced the CSS status dots.

## Layout and instrument framing

The sidebar is tiered into a Workflow group, led by a light `WorkflowStepper`
(preset, camera, capture, reconstruct) that lights the current step, and a
demoted, collapsible Diagnostics group. The primary action carries the most
weight. The camera, live-depth, and 3D surfaces share instrument framing: corner
brackets, a measured grid, a recessed ground plane, a center reticle, and a
vignette, so all three read as one viewfinder.

## Accessibility

- `:focus-visible` draws one unmistakable ring on every keyboard-focused
  control; mouse clicks do not trigger it.
- Stage tabs use `role="tab"` and `aria-selected`; the reconstruct progress bar
  uses `role="progressbar"` with value attributes; disclosures use
  `aria-expanded` and `aria-controls`.
- The contrast ladder passes AA at the 11 to 12px sizes the app uses.
- `prefers-reduced-motion` is honored globally.
- Status is always shape plus color, never color alone.

## Extending it

Add a color, space, or type value as a token in `tokens.css`, never inline. If a
new color must appear in the 3D viewport, add it to `theme.ts` and mirror it in
`tokens.css`; the test enforces the pair. Add an icon by mapping an intent name
in `registry.ts`. Keep components reading tokens so the theme stays centralized.
