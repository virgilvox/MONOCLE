/**
 * The single source of truth for MONOCLE's shared palette.
 *
 * The chrome (CSS) and the Three.js surfaces (MeshViewer, LiveDepthView) must
 * never drift apart, so the colors both sides share live here as canonical hex
 * strings. `styles/tokens.css` mirrors these same values into CSS custom
 * properties for the chrome; `theme.test.ts` parses that file and asserts the
 * two agree, so an edit to one without the other fails the build.
 *
 * Three.js wants integers, not strings, so every shared color is also exposed
 * pre-converted under `three`.
 */

/** Shared colors, as authored in `tokens.css`. Keep the keys in sync there. */
export const palette = {
  /** Deepest chrome surface and the base the contrast ladder is measured on. */
  surface0: '#0c0e10',
  /** Raised panels. */
  surface1: '#14171a',
  /** Highest inset (menus, wells). */
  surface2: '#1b1f23',
  /** The 3D canvas clear color: a touch below surface-0 so the viewport reads
   * as glass set into the instrument body. */
  viewport: '#0a0c0e',

  /** Primary reading ink. */
  ink: '#b9c0c7',
  /** Brightest ink, for headings and active readouts. */
  inkHi: '#eef1f4',
  /** Muted ink; still clears AA at 11px on surface-1. */
  inkLo: '#7d868f',

  /** Hairlines. */
  line: '#262b30',
  /** Emphasized hairlines and control borders. */
  lineStrong: '#3a424a',

  /** Desaturated optical-coating cyan. The one accent. */
  accent: '#3fb6c4',
  /** Pressed / dimmed accent, and the measured-grid major lines. */
  accentPress: '#2a808b',

  /** Machined brass. The signature color: reticle, focus lock, wordmark. */
  brass: '#c8a15a',

  /** Ground-glass grey for reconstructed mesh surfaces. Neutral, not blue. */
  meshBase: '#a6adb4',

  /** Viewer light-background mode. */
  viewportLight: '#e9edf0',
} as const

export type PaletteKey = keyof typeof palette

/** Parse a `#rrggbb` string into the `0xRRGGBB` integer Three.js expects. */
export function hexToInt(hex: string): number {
  return parseInt(hex.slice(1), 16)
}

/** The shared palette pre-converted to Three.js integers. */
export const three = Object.fromEntries(
  Object.entries(palette).map(([key, value]) => [key, hexToInt(value)]),
) as Record<PaletteKey, number>

/**
 * Roles the 3D surfaces reference by intent rather than by raw swatch, so a
 * viewport reads the same design language as the chrome without re-deciding
 * which token means what.
 */
export const viewport = {
  /** Clear color for the dark viewport. */
  background: three.viewport,
  /** Clear color when the viewer light background is toggled on. */
  backgroundLight: three.viewportLight,
  /** Measured-grid major and minor lines. */
  gridMajor: three.lineStrong,
  gridMinor: three.line,
  /** The recessed ground plane the subject sits on. */
  ground: three.surface1,
  /** Default shaded-mesh material. */
  mesh: three.meshBase,
  /** Point-cloud fallback color when a scan carries no vertex color. */
  points: hexToInt(palette.ink),
  /** Reticle brackets and framing. */
  reticle: three.accent,
  /** Focus-lock and center-mark signature. */
  signature: three.brass,
} as const
