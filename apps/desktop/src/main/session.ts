import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The directories a capture session owns on disk. */
export interface SessionDirs {
  framesDir: string
  outputDir: string
}

/** A newly created session, plus its id, for the renderer to reference. */
export interface CreatedSession extends SessionDirs {
  sessionId: string
}

interface SessionState extends SessionDirs {
  root: string
  frameCount: number
}

/**
 * Owns capture sessions in the main process. Each session gets a private temp
 * directory with `frames/` and `output/` subdirs. The renderer streams encoded
 * keyframes in over IPC; we write them as zero-padded PNGs so the sidecar
 * backends can read them in capture order.
 */
export class SessionManager {
  private readonly sessions = new Map<string, SessionState>()

  /** Create a fresh session with its own frames and output directories. */
  async createSession(): Promise<CreatedSession> {
    const root = await mkdtemp(join(tmpdir(), 'monocle-scan-'))
    const framesDir = join(root, 'frames')
    const outputDir = join(root, 'output')
    await mkdir(framesDir, { recursive: true })
    await mkdir(outputDir, { recursive: true })

    const sessionId = root
    this.sessions.set(sessionId, { root, framesDir, outputDir, frameCount: 0 })
    return { sessionId, framesDir, outputDir }
  }

  /**
   * Write one encoded keyframe to the session's frames directory as
   * `frame_00000.png` (padded to five digits, incrementing per session).
   * Returns the new frame count.
   */
  async stageFrame(sessionId: string, data: Uint8Array): Promise<number> {
    const state = this.require(sessionId)
    const index = state.frameCount
    const name = `frame_${String(index).padStart(5, '0')}.png`
    await writeFile(join(state.framesDir, name), data)
    state.frameCount = index + 1
    return state.frameCount
  }

  /**
   * Resolve a session's directories for the reconstruct step. Reconstruction
   * usually runs after the scan has ended, so this falls back to deriving the
   * directories from the id (which is the session root) when the session is no
   * longer tracked. The staged files persist on disk until cleanup.
   */
  resolve(sessionId: string): SessionDirs {
    const state = this.sessions.get(sessionId)
    if (state) return { framesDir: state.framesDir, outputDir: state.outputDir }
    return { framesDir: join(sessionId, 'frames'), outputDir: join(sessionId, 'output') }
  }

  /**
   * Forget a session. Files are left on disk so a later reconstruct can still
   * read them; pass `cleanup` to delete the temp directory too.
   */
  async endSession(sessionId: string, cleanup = false): Promise<void> {
    const state = this.sessions.get(sessionId)
    this.sessions.delete(sessionId)
    if (cleanup && state) {
      await rm(state.root, { recursive: true, force: true })
    }
  }

  private require(sessionId: string): SessionState {
    const state = this.sessions.get(sessionId)
    if (!state) throw new Error(`unknown session: ${sessionId}`)
    return state
  }
}
