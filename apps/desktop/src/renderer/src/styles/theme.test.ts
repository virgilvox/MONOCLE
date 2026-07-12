import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { hexToInt, palette, three, viewport } from './theme'

// theme.ts is the single source of truth for the colors the chrome (CSS) and
// the Three.js viewport share. tokens.css mirrors that subset into custom
// properties. This suite fails if the two drift apart, or if a shared color
// stops being a valid hex, so a one-sided edit cannot land.

const tokensCss = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8')

/** Palette key -> the CSS custom property it must equal in tokens.css. */
const CSS_MIRROR: Partial<Record<keyof typeof palette, string>> = {
  surface0: '--surface-0',
  surface1: '--surface-1',
  surface2: '--surface-2',
  viewport: '--viewport',
  ink: '--ink',
  inkHi: '--ink-hi',
  inkLo: '--ink-lo',
  line: '--line',
  lineStrong: '--line-strong',
  accent: '--accent',
  accentPress: '--accent-press',
  brass: '--brass',
}

function readToken(name: string): string {
  const match = tokensCss.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))
  if (!match) throw new Error(`token ${name} not found in tokens.css`)
  return match[1]!.toLowerCase()
}

describe('theme palette', () => {
  it('every shared color is a valid six-digit hex', () => {
    for (const value of Object.values(palette)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('mirrors tokens.css exactly, so CSS and Three.js never diverge', () => {
    for (const [key, cssVar] of Object.entries(CSS_MIRROR)) {
      expect(palette[key as keyof typeof palette]).toBe(readToken(cssVar!))
    }
  })

  it('exposes Three.js integers that round-trip the hex strings', () => {
    expect(hexToInt('#0a0c0e')).toBe(0x0a0c0e)
    expect(three.accent).toBe(hexToInt(palette.accent))
    expect(three.viewport).toBe(hexToInt(palette.viewport))
  })

  it('maps viewport roles to concrete palette integers', () => {
    expect(viewport.background).toBe(three.viewport)
    expect(viewport.reticle).toBe(three.accent)
    expect(viewport.signature).toBe(three.brass)
    expect(viewport.mesh).toBe(three.meshBase)
  })
})
