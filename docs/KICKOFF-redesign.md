# Redesign kickoff prompt

Paste the block below into a fresh Claude Code session opened in the MONOCLE
repo. It briefs a UI/UX and visual-design overhaul grounded in the rules, the
handoff, and the design audit.

---

You are picking up MONOCLE, a webcam-first 3D scanning desktop app (Electron +
Vue 3 renderer + Python inference sidecar) at this repo. This session's mission
is a UI/UX and visual-design overhaul: a centralized theme and a consistent,
characterful design DNA that is modern and not cliche.

Before writing any code:

1. Read CLAUDE.md in full and follow it exactly as binding rules: no emojis where
   icons belong, no emdashes or double hyphens, no typical AI/LLM language
   patterns, no cliche design (no dark-neon, no glassmorphism-by-default), smart
   separation of concerns and modularity, well-tested code, proper docs, and
   never add AI attribution or credit Claude as an author in git commits.
2. Read docs/HANDOFF.md (full project state, how to run, backends, environment
   notes) and docs/UX-AUDIT.md (the design audit and the proposed direction).
   Skim docs/AUDIT.md (open functional issues) so the redesign does not regress
   them, and docs/architecture.md and docs/roadmap.md.
3. Run the app and use it so you understand the current experience:
   `pnpm install`, `pnpm build`, then `pnpm dev:desktop`. Try the Synthetic test
   preset, the camera and live-depth tabs, and a reconstruction.

Then do deep research with web search before you design:

- Similar apps and tools: how the best 3D scanning apps present capture and
  results (Polycam, KIRI Engine, Scaniverse, RealityScan, Luma, Creality Scan),
  and desktop creative or technical tools with strong, non-generic interfaces
  (Blender 4.x, Rhino, Cursor, Linear, Raycast, Arc, Figma). Note what makes them
  feel like considered instruments rather than templates.
- Design craft: current best practices for design tokens and design systems in a
  Vue app, accessible color and focus states, type systems with tabular figures,
  and self-hosted icon systems. Verify current library versions.

Write a short research summary of what you will borrow and what you will
deliberately avoid: the cliche AI-app aesthetic (purple or neon gradients,
glassmorphism by default, emoji icons, generic dark dashboards, Inter-everywhere
sameness).

Design goal: a centralized theme and a consistent design DNA with genuine
character, modern but not cliche, highly readable and well thought out. MONOCLE
is a precision optics instrument: lens, aperture, reticle, ground glass, machined
graphite, tabular telemetry. docs/UX-AUDIT.md proposes a concrete starting
direction (graphite surfaces, a desaturated optical-cyan accent, a brass
signature color, IBM Plex Sans and Mono with tabular figures, a Lucide plus
bespoke-optical-glyph icon set, tighter radii, restrained intentional motion).
Treat that as a strong proposal, not a cage: refine it with your research and a
clear rationale, but do not drift into the generic look the audit warns against.

Scope of work:

1. Build one centralized design system: CSS custom-property token scales (color
   as semantic foreground/tint/line sets, space on a 4px base, a type scale plus
   families and tabular figures, radius, elevation, motion, stroke, z-index) and
   a shared theme module (for example theme.ts) exported so the Three.js viewport
   (MeshViewer, LiveDepthView) reads the same palette as the chrome. Bundle the
   fonts; do not rely on system fonts.
2. Refactor every renderer component to consume tokens and eliminate the
   hardcoded color, space, radius, type, and motion literals catalogued in
   docs/UX-AUDIT.md.
3. Add a self-hosted icon system plus a few bespoke optical glyphs; retire the
   CSS status dots, the CSS chevron, and the ring brand mark; back controls with
   icon and label.
4. Fix accessibility: focus-visible on all interactive elements, a contrast
   ladder that passes WCAG AA at 11 to 12px, prefers-reduced-motion handling,
   proper tab roles and aria state, and status conveyed by shape or glyph, not
   color alone.
5. Re-tier the sidebar information architecture (a Workflow group and a demoted,
   collapsible Diagnostics group), give the current step and the primary action
   dominant weight, and art-direct the camera and 3D surfaces (corner brackets, a
   measured grid, a ground plane, a subtle vignette) as the signature.
6. Redesign the brand mark as an aperture or monocle glyph, and give the empty,
   error, and loading states character.

Constraints:

- Do not break functionality. Every existing flow must still work: preset to
  camera to scan to reconstruct to preview to export, plus live depth and the
  synthetic test. Verify with `pnpm typecheck`, `pnpm test`, the sidecar tests
  (`cd sidecar && .venv/bin/python -m pytest tests -q`),
  `pnpm exec prettier --check .`, and `pnpm --filter @monoclejs/desktop build`.
  Run the app, and regenerate the README screenshots with
  `pnpm --filter @monoclejs/desktop screenshots`.
- Keep it modular and tested; add tests for new logic (the theme module and any
  new composables). Preserve the working capture-gate UX and the reconstruct
  flow. This is a redesign, not a rebuild.
- Commit in logical chunks with no AI attribution.

Deliverables: a coherent design system, a redesigned interface with a distinctive
optics identity, updated screenshots, a short DESIGN.md documenting the system,
and all checks green. Start by reading the rules and the handoff, then present a
short design plan (proposed tokens, direction, and before-and-after intent) for
review before you implement broadly.
