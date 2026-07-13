/** A tiny dependency-free typed event emitter for the main process. */
export type Listener<T> = (payload: T) => void

export class Emitter<Events extends Record<string, unknown>> {
  private readonly listeners: { [K in keyof Events]?: Set<Listener<Events[K]>> } = {}

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const set = (this.listeners[event] ??= new Set<Listener<Events[K]>>())
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  /** Emit an event to all current subscribers. */
  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners[event]
    if (!set) return
    for (const listener of [...set]) listener(payload)
  }

  /** Drop every subscriber. */
  clear(): void {
    for (const key of Object.keys(this.listeners) as (keyof Events)[]) {
      delete this.listeners[key]
    }
  }
}
