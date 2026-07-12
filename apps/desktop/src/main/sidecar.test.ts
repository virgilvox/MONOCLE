import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A controllable fake child so the supervisor's restart logic can be tested
// without spawning a real interpreter. spawn() hands out the queued children in
// order; the health handshake never completes, which drives the failure path.
const hoisted = vi.hoisted(() => {
  const queue: unknown[] = []
  return { queue }
})

vi.mock('node:child_process', () => ({
  spawn: () => hoisted.queue.shift(),
}))

import { SidecarSupervisor } from './sidecar'

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: string | null = null
  kill = vi.fn(() => true)
  stdin = { write: vi.fn() }
  stdout = new EventEmitter()
  stderr = new EventEmitter()
}

describe('SidecarSupervisor restart races', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    hoisted.queue.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not let a deliberately-killed child tear down its replacement', async () => {
    const child1 = new FakeChild()
    const child2 = new FakeChild()
    hoisted.queue.push(child1, child2)

    const supervisor = new SidecarSupervisor('/tmp/sidecar', 'python')
    const statuses: string[] = []
    supervisor.on('status', (s) => statuses.push(s as string))

    // launch 1: spawns child1, then awaits a health handshake that never lands.
    void supervisor.start()
    // child1 fails to start, so it is killed and a restart is scheduled.
    child1.emit('error', new Error('boom'))
    expect(statuses).toContain('error')
    expect(child1.kill).toHaveBeenCalled()

    // The scheduled restart fires and spawns child2 (the healthy replacement).
    await vi.advanceTimersByTimeAsync(600)
    expect(hoisted.queue.length).toBe(0)

    const child2KillsBefore = child2.kill.mock.calls.length
    const statusCountBefore = statuses.length

    // The already-killed child1 now exits late. Its lifecycle listeners were
    // detached on kill, so this must not disturb child2 or flap the status.
    child1.emit('exit', 1)

    expect(child2.kill.mock.calls.length).toBe(child2KillsBefore)
    expect(statuses.length).toBe(statusCountBefore)
  })

  it('keeps a single pending restart timer across repeated failures', async () => {
    const children = [new FakeChild(), new FakeChild(), new FakeChild()]
    hoisted.queue.push(...children)

    const supervisor = new SidecarSupervisor('/tmp/sidecar', 'python')
    void supervisor.start()

    // Two failures back to back must not stack two timers that both spawn.
    children[0]!.emit('error', new Error('first'))
    children[0]!.emit('exit', 1) // the stale exit is now inert, so no extra schedule

    const queueBefore = hoisted.queue.length
    await vi.advanceTimersByTimeAsync(600)
    // Exactly one relaunch consumed exactly one queued child.
    expect(hoisted.queue.length).toBe(queueBefore - 1)
  })
})
