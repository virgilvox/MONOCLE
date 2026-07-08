import { encodeMessage, MessageDecoder } from './framing'
import {
  isFailure,
  isNotification,
  isSuccess,
  type JsonRpcId,
  type JsonRpcMessage,
} from './jsonrpc'

/**
 * A byte-stream transport. The Electron main process implements this over the
 * sidecar's stdin/stdout; tests implement it with an in-memory pair.
 */
export interface Transport {
  send(data: Uint8Array): void
  onData(listener: (data: Uint8Array) => void): void
  onClose?(listener: () => void): void
}

/** An error carrying the JSON-RPC error code and optional data payload. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

type NotificationHandler = (params: unknown) => void

/**
 * A small JSON-RPC 2.0 client over a framed byte transport. Handles request and
 * response correlation and dispatches server-to-client notifications (progress,
 * logs) to registered handlers.
 */
export class RpcClient {
  private nextId = 1
  private readonly pending = new Map<
    JsonRpcId,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>()
  private readonly decoder = new MessageDecoder()

  constructor(private readonly transport: Transport) {
    transport.onData((data) => {
      for (const message of this.decoder.push(data)) this.handle(message)
    })
    transport.onClose?.(() => this.rejectAll(new RpcError('transport closed', -32000)))
  }

  /** Send a request and resolve with its result, or reject with an RpcError. */
  request<R = unknown, P = unknown>(method: string, params?: P): Promise<R> {
    const id = this.nextId++
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      try {
        this.transport.send(encodeMessage({ jsonrpc: '2.0', id, method, params }))
      } catch (error) {
        // A closed or broken transport must not leak the pending entry.
        this.pending.delete(id)
        reject(error instanceof Error ? error : new RpcError(String(error), -32000))
      }
    })
  }

  /** Fire a notification with no reply expected. */
  notify<P = unknown>(method: string, params?: P): void {
    this.transport.send(encodeMessage({ jsonrpc: '2.0', method, params }))
  }

  /** Subscribe to a server-sent notification method. Returns an unsubscribe. */
  onNotification<P = unknown>(method: string, handler: (params: P) => void): () => void {
    const set = this.notificationHandlers.get(method) ?? new Set<NotificationHandler>()
    set.add(handler as NotificationHandler)
    this.notificationHandlers.set(method, set)
    return () => {
      set.delete(handler as NotificationHandler)
    }
  }

  private handle(message: JsonRpcMessage): void {
    if (isSuccess(message)) {
      const entry = this.pending.get(message.id)
      if (entry) {
        this.pending.delete(message.id)
        entry.resolve(message.result)
      }
      return
    }
    if (isFailure(message)) {
      if (message.id === null) return
      const entry = this.pending.get(message.id)
      if (entry) {
        this.pending.delete(message.id)
        entry.reject(new RpcError(message.error.message, message.error.code, message.error.data))
      }
      return
    }
    if (isNotification(message)) {
      const set = this.notificationHandlers.get(message.method)
      if (set) for (const handler of [...set]) handler(message.params)
    }
  }

  private rejectAll(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error)
    this.pending.clear()
  }
}
