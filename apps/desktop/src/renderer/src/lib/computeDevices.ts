import type { ReconstructDevice } from '@monoclejs/protocol'

/** Compute devices the advanced lever can force. `auto` picks the best available. */
export const COMPUTE_DEVICES: { id: ReconstructDevice; label: string }[] = [
  { id: 'auto', label: 'Automatic' },
  { id: 'cpu', label: 'CPU' },
  { id: 'mps', label: 'Apple GPU (MPS)' },
  { id: 'cuda', label: 'NVIDIA GPU (CUDA)' },
]
