import { Emitter } from './emitter'
import type { ScanBackends } from './stages'
import { type Frame, isFusable } from '../types/frame'
import type { Mesh } from '../types/mesh'

/** Events emitted across a scan session. Subscribe with engine.on(...). */
export interface ScanEngineEvents extends Record<string, unknown> {
  /** A new frame entered the pipeline. */
  frame: { frame: Frame }
  /** A pose was accepted for a frame. */
  pose: { id: number; confidence: number }
  /** A frame was integrated into the fusion volume. */
  integrated: { id: number; count: number }
  /** Cumulative progress after each frame, whether or not it was integrated. */
  progress: { processed: number; integrated: number }
  /** A named stage of the session began (for example "mesh"). */
  stage: { stage: string }
  /** The final mesh was extracted. */
  mesh: { mesh: Mesh }
  /** A recoverable per-frame error. The session continues. */
  error: { error: unknown; frameId?: number }
}

export interface ScanEngineOptions {
  /** Drop frames whose pose confidence is below this threshold. */
  minPoseConfidence?: number
  /** Abort the session early. */
  signal?: AbortSignal
}

/**
 * Drives one scan from a stream of frames to a mesh. The engine is backend
 * agnostic: swap the pose, geometry, fusion, and mesher implementations to
 * switch scanning methods without touching this control flow.
 */
export class ScanEngine<TImage = unknown> extends Emitter<ScanEngineEvents> {
  constructor(private readonly backends: ScanBackends<TImage>) {
    super()
  }

  async run(source: AsyncIterable<Frame<TImage>>, options: ScanEngineOptions = {}): Promise<Mesh> {
    const { pose, geometry, fusion, mesher } = this.backends
    fusion.reset()
    pose.reset?.()

    let processed = 0
    let integrated = 0

    for await (const frame of source) {
      if (options.signal?.aborted) break
      this.emit('frame', { frame })

      try {
        const poseResult = await pose.estimate(frame)
        if (poseResult && this.poseAccepted(poseResult.confidence, options)) {
          frame.pose = poseResult.pose
          if (poseResult.intrinsics) frame.intrinsics = poseResult.intrinsics
          this.emit('pose', { id: frame.id, confidence: poseResult.confidence ?? 1 })

          const geom = await geometry.compute(frame)
          if (geom.mask) frame.mask = geom.mask
          if (geom.depth) frame.depth = geom.depth

          if (isFusable(frame)) {
            await fusion.integrate(frame)
            integrated++
            this.emit('integrated', { id: frame.id, count: integrated })
          }
        }
      } catch (error) {
        this.emit('error', { error, frameId: frame.id })
      } finally {
        processed++
        this.emit('progress', { processed, integrated })
      }
    }

    this.emit('stage', { stage: 'mesh' })
    const mesh = await mesher.extract()
    this.emit('mesh', { mesh })
    return mesh
  }

  private poseAccepted(confidence: number | undefined, options: ScanEngineOptions): boolean {
    if (options.minPoseConfidence === undefined) return true
    return (confidence ?? 1) >= options.minPoseConfidence
  }
}
