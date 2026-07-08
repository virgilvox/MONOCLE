import { existsSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SessionManager } from './session'

describe('SessionManager', () => {
  it('stages two concurrent frames as distinct files with distinct counts', async () => {
    const sessions = new SessionManager()
    const { sessionId, framesDir } = await sessions.createSession()

    // Fire both stageFrame calls before awaiting either, so the second starts
    // while the first is still mid-write. The pre-await index reservation must
    // hand each a different slot.
    const [countA, countB] = await Promise.all([
      sessions.stageFrame(sessionId, new Uint8Array([1])),
      sessions.stageFrame(sessionId, new Uint8Array([2])),
    ])

    expect(countA).not.toBe(countB)
    expect(new Set([countA, countB])).toEqual(new Set([1, 2]))

    const written = readdirSync(framesDir).sort()
    expect(written).toEqual(['frame_00000.png', 'frame_00001.png'])

    sessions.cleanupAll()
  })

  it('cleanupAll removes every session directory', async () => {
    const sessions = new SessionManager()
    const first = await sessions.createSession()
    const second = await sessions.createSession()

    expect(existsSync(first.sessionId)).toBe(true)
    expect(existsSync(second.sessionId)).toBe(true)

    sessions.cleanupAll()

    expect(existsSync(first.sessionId)).toBe(false)
    expect(existsSync(second.sessionId)).toBe(false)
  })

  it('cleanupAll still removes a session that was ended (files kept until quit)', async () => {
    const sessions = new SessionManager()
    const { sessionId } = await sessions.createSession()

    // endSession without cleanup forgets the session but keeps files on disk.
    await sessions.endSession(sessionId)
    expect(existsSync(sessionId)).toBe(true)

    sessions.cleanupAll()
    expect(existsSync(sessionId)).toBe(false)
  })
})
