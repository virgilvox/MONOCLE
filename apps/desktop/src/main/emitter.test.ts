import { describe, expect, it, vi } from 'vitest'
import { Emitter } from './emitter'

interface Events extends Record<string, unknown> {
  ping: number
  pong: string
}

describe('Emitter', () => {
  it('delivers a payload to every subscriber', () => {
    const emitter = new Emitter<Events>()
    const a = vi.fn()
    const b = vi.fn()
    emitter.on('ping', a)
    emitter.on('ping', b)

    emitter.emit('ping', 42)

    expect(a).toHaveBeenCalledWith(42)
    expect(b).toHaveBeenCalledWith(42)
  })

  it('only notifies subscribers of the emitted event', () => {
    const emitter = new Emitter<Events>()
    const ping = vi.fn()
    const pong = vi.fn()
    emitter.on('ping', ping)
    emitter.on('pong', pong)

    emitter.emit('pong', 'hi')

    expect(ping).not.toHaveBeenCalled()
    expect(pong).toHaveBeenCalledWith('hi')
  })

  it('stops delivering after unsubscribe', () => {
    const emitter = new Emitter<Events>()
    const listener = vi.fn()
    const off = emitter.on('ping', listener)

    off()
    emitter.emit('ping', 1)

    expect(listener).not.toHaveBeenCalled()
  })

  it('drops every subscriber on clear', () => {
    const emitter = new Emitter<Events>()
    const listener = vi.fn()
    emitter.on('ping', listener)

    emitter.clear()
    emitter.emit('ping', 1)

    expect(listener).not.toHaveBeenCalled()
  })

  it('is safe to emit an event with no subscribers', () => {
    const emitter = new Emitter<Events>()
    expect(() => emitter.emit('ping', 1)).not.toThrow()
  })
})
