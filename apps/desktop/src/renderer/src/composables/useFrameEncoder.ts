/**
 * Encode a captured video frame to PNG bytes for staging to disk.
 *
 * We render off the main thread with an OffscreenCanvas so grabbing keyframes
 * during a scan does not stall the UI. The bytes are handed to the main process
 * over IPC, which writes them as the session's next keyframe.
 */
export async function encodeBitmapToPng(bitmap: ImageBitmap): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('failed to acquire 2d context for frame encoding')
  ctx.drawImage(bitmap, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}
