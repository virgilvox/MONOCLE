import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

/**
 * A reactive elapsed-milliseconds clock that runs only while `active` is true.
 * It restarts from zero on each rising edge and ticks about once a second so a
 * long, quiet CPU run visibly advances instead of looking hung. The interval is
 * cleared when `active` goes false and on unmount.
 */
export function useElapsed(active: Ref<boolean>, tickMs = 1000): Ref<number> {
  const elapsed = ref(0)
  let startedAt = 0
  let timer: ReturnType<typeof setInterval> | null = null

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function start(): void {
    stop()
    startedAt = Date.now()
    elapsed.value = 0
    timer = setInterval(() => {
      elapsed.value = Date.now() - startedAt
    }, tickMs)
  }

  watch(
    active,
    (on) => {
      if (on) start()
      else stop()
    },
    { immediate: true },
  )

  onBeforeUnmount(stop)

  return elapsed
}
