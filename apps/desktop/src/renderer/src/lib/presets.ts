/**
 * The scan presets and their vocabulary: how frames are gathered, the quality
 * tiers, and the preset table itself. Pure data with no store or DOM ties, so
 * the picker components and the capture store read the same source.
 */

/** How the app gathers frames before handing them to a backend. */
export type CaptureStrategy = 'single' | 'multi-view' | 'synthetic'

/** Reconstruction quality tier, mapped to sidecar resolution and decimation. */
export type Quality = 'fast' | 'balanced' | 'high'

/**
 * A benefit-worded scan preset. Each option bundles the capture strategy, the
 * backend, and the export settings so a user picks an outcome, not a model.
 */
export interface ScanPreset {
  id: string
  label: string
  description: string
  captureStrategy: CaptureStrategy
  backend: string
  quality: Quality
  color: boolean
  /** How many good keyframes the HUD aims for. Zero means no capture step. */
  targetFrames: number
}

export const SCAN_PRESETS: ScanPreset[] = [
  {
    id: 'object-scan',
    label: 'Object scan',
    description: 'Walk the camera around an object. The best method is chosen for your machine.',
    captureStrategy: 'multi-view',
    backend: 'depth-anything-v2-walk',
    quality: 'balanced',
    color: true,
    targetFrames: 40,
  },
  {
    id: 'quick-depth',
    label: 'Quick depth snapshot',
    description: 'One sharp frame turns into a depth mesh. Fastest way to a result.',
    captureStrategy: 'single',
    backend: 'depth-anything-v2-small',
    quality: 'balanced',
    color: true,
    targetFrames: 1,
  },
  {
    id: 'synthetic',
    label: 'Synthetic test',
    description: 'Generate a known test mesh with no camera. Good for checking the pipeline.',
    captureStrategy: 'synthetic',
    backend: 'synthetic',
    quality: 'balanced',
    color: false,
    targetFrames: 0,
  },
]

/** The default preset: an object scan with Depth Anything V2. */
export const DEFAULT_PRESET = SCAN_PRESETS[0]!

/** Presets shown as cards. Synthetic is a diagnostic, offered as an Advanced
 * button rather than a card. */
export const CARD_PRESETS = SCAN_PRESETS.filter((p) => p.id !== 'synthetic')

/** Quality tiers a user can pick from in the advanced controls. */
export const QUALITY_TIERS: { id: Quality; label: string }[] = [
  { id: 'fast', label: 'Fast' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'high', label: 'High detail' },
]
