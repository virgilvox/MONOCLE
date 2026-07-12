<script setup lang="ts">
/**
 * The MONOCLE mark: a calibrated lens rim in brass with an optical iris in the
 * accent coating color, and a single index tick at twelve o'clock so it reads
 * as a measuring instrument rather than a plain ring. Two-tone by design; both
 * colors come from tokens.
 */
withDefaults(defineProps<{ size?: number }>(), { size: 22 })
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 32 32"
    fill="none"
    class="mark"
    role="img"
    aria-label="MONOCLE"
  >
    <!-- Lens rim and its index tick. -->
    <circle cx="16" cy="16" r="13" stroke="var(--brass)" stroke-width="1.8" />
    <line
      x1="16"
      y1="1.5"
      x2="16"
      y2="4.5"
      stroke="var(--brass)"
      stroke-width="1.8"
      stroke-linecap="round"
    />
    <!-- Iris opening and blades. -->
    <path
      d="M16 11 L20.3 13.5 L20.3 18.5 L16 21 L11.7 18.5 L11.7 13.5 Z"
      stroke="var(--accent)"
      stroke-width="1.6"
      stroke-linejoin="round"
    />
    <g stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round">
      <line x1="16" y1="11" x2="16" y2="6" />
      <line x1="20.3" y1="13.5" x2="24.6" y2="11" />
      <line x1="20.3" y1="18.5" x2="24.6" y2="21" />
      <line x1="16" y1="21" x2="16" y2="26" />
      <line x1="11.7" y1="18.5" x2="7.4" y2="21" />
      <line x1="11.7" y1="13.5" x2="7.4" y2="11" />
    </g>
  </svg>
</template>

<style scoped>
.mark {
  display: block;
  flex: none;
}
</style>
