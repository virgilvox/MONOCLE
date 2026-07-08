import { onBeforeUnmount, ref, shallowRef } from 'vue'

export interface CameraDevice {
  deviceId: string
  label: string
}

/**
 * Manage the webcam lifecycle: device enumeration, stream start/stop, and a
 * single-frame grab. Exposure and focus are locked where the device allows it,
 * which matters for stable geometry across a scan.
 */
export function useCamera() {
  const stream = shallowRef<MediaStream | null>(null)
  const devices = ref<CameraDevice[]>([])
  const activeDeviceId = ref<string | null>(null)
  const error = ref<string | null>(null)
  const active = ref(false)

  async function listDevices(): Promise<void> {
    const all = await navigator.mediaDevices.enumerateDevices()
    devices.value = all
      .filter((device) => device.kind === 'videoinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Camera ${index + 1}`,
      }))
  }

  async function start(deviceId?: string): Promise<void> {
    stop()
    try {
      const video: MediaTrackConstraints = {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      }
      const media = await navigator.mediaDevices.getUserMedia({ video, audio: false })
      stream.value = media
      active.value = true
      error.value = null
      activeDeviceId.value = deviceId ?? media.getVideoTracks()[0]?.getSettings().deviceId ?? null
      await lockExposureAndFocus(media)
      // Labels are only populated after permission is granted.
      await listDevices()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      active.value = false
    }
  }

  function stop(): void {
    for (const track of stream.value?.getTracks() ?? []) track.stop()
    stream.value = null
    active.value = false
  }

  onBeforeUnmount(stop)

  return { stream, devices, activeDeviceId, error, active, listDevices, start, stop }
}

async function lockExposureAndFocus(media: MediaStream): Promise<void> {
  const track = media.getVideoTracks()[0]
  if (!track) return
  // Constraints beyond the standard set are device-specific; ignore rejections.
  const advanced = [
    { exposureMode: 'manual' },
    { focusMode: 'manual' },
  ] as unknown as MediaTrackConstraintSet[]
  try {
    await track.applyConstraints({ advanced })
  } catch {
    // The camera does not support manual control; the browser default stands.
  }
}
