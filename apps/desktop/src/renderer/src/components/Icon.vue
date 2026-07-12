<script setup lang="ts">
/**
 * One icon renderer for the whole app. Draws either a bespoke optical glyph or
 * a Lucide icon, both on the 24px grid with an optically constant stroke. Icons
 * are decorative by default (aria-hidden); pass a `title` to give an icon that
 * carries meaning on its own an accessible name.
 */
import { computed } from 'vue'
import { type IconName, resolveIcon } from './icons/registry'

const props = withDefaults(
  defineProps<{
    name: IconName
    size?: number
    strokeWidth?: number
    title?: string
  }>(),
  { size: 16, strokeWidth: 1.75 },
)

const component = computed(() => resolveIcon(props.name))
</script>

<template>
  <component
    :is="component"
    :size="size"
    :stroke-width="strokeWidth"
    :absolute-stroke-width="true"
    class="icon"
    :role="title ? 'img' : undefined"
    :aria-label="title"
    :aria-hidden="title ? undefined : true"
  />
</template>

<style scoped>
.icon {
  flex: none;
  display: block;
}
</style>
