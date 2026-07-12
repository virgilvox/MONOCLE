export type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcSuccess,
  JsonRpcFailure,
  JsonRpcErrorObject,
  JsonRpcMessage,
} from './jsonrpc'
export { isSuccess, isFailure, isRequest, isNotification } from './jsonrpc'

export { encodeMessage, MessageDecoder } from './framing'
export { RpcClient, RpcError } from './client'
export type { Transport } from './client'

export { PROTOCOL_VERSION, SidecarMethod, SidecarNotification } from './sidecar-contract'
export type {
  BackendCapabilities,
  BackendInfo,
  HealthResult,
  Intrinsics,
  ReconstructParams,
  ReconstructQuality,
  ReconstructResult,
  ReconstructDevice,
  ReconstructOutput,
  PrepareMediaParams,
  PrepareMediaResult,
  LiveReconstructParams,
  MeshUpdateNote,
  ProgressNote,
  LogNote,
} from './sidecar-contract'
