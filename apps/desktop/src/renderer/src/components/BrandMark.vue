<script setup lang="ts">
/**
 * The MONOCLE mark: a lens bezel with a low-poly surface reconstructed inside
 * the glass, one face solved in the accent and the vertices punctuated in it.
 * The output of a scan, framed by the instrument. The ring and wireframe take
 * the ink color; the solved face and vertex dots take the accent.
 */
withDefaults(defineProps<{ size?: number }>(), { size: 22 })
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 200 200"
    fill="none"
    class="mark"
    role="img"
    aria-label="MONOCLE"
  >
    <circle cx="100" cy="100" r="64" fill="none" stroke="var(--ink-hi)" stroke-width="12" />
    <polygon points="84,68 132,80 100,120" fill="var(--accent)" />
    <path
      d="M56,122 L84,68 L100,120 Z M84,68 L132,80 L100,120 M132,80 L146,114 L100,120"
      fill="none"
      stroke="var(--ink-hi)"
      stroke-width="6"
      stroke-linejoin="round"
      stroke-linecap="round"
    />
    <circle cx="56" cy="122" r="6" fill="var(--accent)" />
    <circle cx="146" cy="114" r="6" fill="var(--accent)" />
  </svg>
</template>

<style scoped>
.mark {
  display: block;
  flex: none;
}
</style>
