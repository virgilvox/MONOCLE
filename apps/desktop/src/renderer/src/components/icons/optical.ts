/**
 * Bespoke optical glyphs, hand-drawn on the same 24px grid Lucide uses so they
 * sit beside the standard set without seams. These carry MONOCLE's instrument
 * character: an iris, a lens, a sighting reticle, an autofocus box, an orbit,
 * and a faceted wireframe.
 *
 * Each is a functional component with the same prop surface as a Lucide icon
 * (size, strokeWidth, color), so the shared Icon renderer treats both alike.
 * strokeWidth is kept optically constant across sizes, matching Lucide's
 * absoluteStrokeWidth behavior.
 */
import { defineComponent, h, type VNode } from 'vue'

type Child = [tag: string, attrs: Record<string, string | number>]

function glyph(name: string, children: Child[]) {
  return defineComponent({
    name,
    props: {
      size: { type: [Number, String], default: 24 },
      strokeWidth: { type: [Number, String], default: 2 },
      color: { type: String, default: 'currentColor' },
    },
    setup(props) {
      return (): VNode => {
        const size = Number(props.size)
        // Hold the stroke visually constant regardless of render size.
        const width = (Number(props.strokeWidth) * 24) / size
        return h(
          'svg',
          {
            xmlns: 'http://www.w3.org/2000/svg',
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: props.color,
            'stroke-width': width,
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
          },
          children.map(([tag, attrs]) => h(tag, attrs)),
        )
      }
    },
  })
}

/** A mechanical iris: outer rim, hexagonal opening, and six blades. */
export const Iris = glyph('Iris', [
  ['circle', { cx: 12, cy: 12, r: 9 }],
  ['path', { d: 'M12 8 L15.5 10 L15.5 14 L12 16 L8.5 14 L8.5 10 Z' }],
  ['line', { x1: 12, y1: 8, x2: 12, y2: 3 }],
  ['line', { x1: 15.5, y1: 10, x2: 20, y2: 7.5 }],
  ['line', { x1: 15.5, y1: 14, x2: 20, y2: 16.5 }],
  ['line', { x1: 12, y1: 16, x2: 12, y2: 21 }],
  ['line', { x1: 8.5, y1: 14, x2: 4, y2: 16.5 }],
  ['line', { x1: 8.5, y1: 10, x2: 4, y2: 7.5 }],
])

/** A coated lens: rim, coating ring, and a reflection highlight. */
export const Lens = glyph('Lens', [
  ['circle', { cx: 12, cy: 12, r: 9 }],
  ['circle', { cx: 12, cy: 12, r: 3.25 }],
  ['path', { d: 'M7.5 8.5 A 6 6 0 0 1 13 6.2' }],
])

/** A sighting reticle: ring, four edge ticks, and a center pip. */
export const Reticle = glyph('Reticle', [
  ['circle', { cx: 12, cy: 12, r: 8.5 }],
  ['line', { x1: 12, y1: 2.5, x2: 12, y2: 6 }],
  ['line', { x1: 12, y1: 18, x2: 12, y2: 21.5 }],
  ['line', { x1: 2.5, y1: 12, x2: 6, y2: 12 }],
  ['line', { x1: 18, y1: 12, x2: 21.5, y2: 12 }],
  ['circle', { cx: 12, cy: 12, r: 1.25 }],
])

/** An autofocus box: four corner brackets around a center point. */
export const FocusBox = glyph('FocusBox', [
  ['path', { d: 'M5 9 V6 a1 1 0 0 1 1 -1 H9' }],
  ['path', { d: 'M15 5 H18 a1 1 0 0 1 1 1 V9' }],
  ['path', { d: 'M19 15 V18 a1 1 0 0 1 -1 1 H15' }],
  ['path', { d: 'M9 19 H6 a1 1 0 0 1 -1 -1 V15' }],
  ['circle', { cx: 12, cy: 12, r: 1.5 }],
])

/** An orbit: an inclined path, a body at center, and a moving point. */
export const Orbit = glyph('Orbit', [
  ['ellipse', { cx: 12, cy: 12, rx: 10, ry: 4.5, transform: 'rotate(-28 12 12)' }],
  ['circle', { cx: 12, cy: 12, r: 2.5 }],
  ['circle', { cx: 19.4, cy: 8.6, r: 1.4 }],
])

/** A faceted wireframe dome: a hexagonal hull with interior edges. */
export const Wireframe = glyph('Wireframe', [
  ['path', { d: 'M12 3 L20 7.5 L20 16.5 L12 21 L4 16.5 L4 7.5 Z' }],
  ['line', { x1: 12, y1: 3, x2: 12, y2: 21 }],
  ['line', { x1: 4, y1: 7.5, x2: 20, y2: 16.5 }],
  ['line', { x1: 20, y1: 7.5, x2: 4, y2: 16.5 }],
])

/** Registry of the bespoke set, keyed by the name the Icon renderer accepts. */
export const opticalGlyphs = {
  iris: Iris,
  lens: Lens,
  reticle: Reticle,
  'focus-box': FocusBox,
  orbit: Orbit,
  wireframe: Wireframe,
} as const

export type OpticalGlyphName = keyof typeof opticalGlyphs
