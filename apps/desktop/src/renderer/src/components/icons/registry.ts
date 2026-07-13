/**
 * The app's icon vocabulary. Every icon is referenced by an intent name (what
 * it means here), not by its Lucide export, so swapping the underlying glyph is
 * a one-line change and call sites stay readable. Lucide icons are imported by
 * name so the bundler tree-shakes the rest of the set away.
 */
import {
  Ban,
  Camera,
  Check,
  ChevronRight,
  Cpu,
  Download,
  DownloadCloud,
  FolderInput,
  FolderOpen,
  Gauge,
  Grip,
  Info,
  Layers,
  Monitor,
  Moon,
  Palette,
  Play,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
  Square,
  Sun,
  TriangleAlert,
  X,
} from '@lucide/vue'
import { opticalGlyphs } from './optical'

export const icons = {
  // Bespoke optical glyphs.
  ...opticalGlyphs,

  // Workflow and controls.
  camera: Camera,
  play: Play,
  stop: Square,
  save: Download,
  import: FolderInput,
  reveal: FolderOpen,
  cancel: X,
  disabled: Ban,
  reset: RotateCcw,
  update: DownloadCloud,
  advanced: SlidersHorizontal,
  diagnostics: Settings2,

  // Viewer modes and toggles.
  shaded: 'lens',
  points: Grip,
  'light-bg': Sun,
  'dark-bg': Moon,

  // Meta and status affordances.
  quality: Gauge,
  color: Palette,
  frames: Layers,
  engine: Cpu,
  rendering: Monitor,
  info: Info,
  check: Check,
  alert: TriangleAlert,
  chevron: ChevronRight,
} as const

// Resolve string aliases (e.g. shaded -> the bespoke lens) to their component.
type RawName = keyof typeof icons
export type IconName = RawName

export function resolveIcon(name: IconName): unknown {
  const entry = icons[name]
  return typeof entry === 'string' ? icons[entry as RawName] : entry
}
