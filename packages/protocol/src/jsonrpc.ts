/** Minimal JSON-RPC 2.0 message types used across the sidecar boundary. */

export type JsonRpcId = number | string

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: P
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: '2.0'
  method: string
  params?: P
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: R
}

export interface JsonRpcErrorObject {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcFailure {
  jsonrpc: '2.0'
  id: JsonRpcId | null
  error: JsonRpcErrorObject
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure

export function isSuccess(message: JsonRpcMessage): message is JsonRpcSuccess {
  return 'id' in message && 'result' in message
}

export function isFailure(message: JsonRpcMessage): message is JsonRpcFailure {
  return 'error' in message
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'id' in message && 'method' in message
}

export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return !('id' in message) && 'method' in message
}
