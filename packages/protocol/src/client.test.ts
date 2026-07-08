import { describe, expect, it, vi } from 'vitest'
import { RpcClient, RpcError, type Transport } from './client'
import { encodeMessage, MessageDecoder } from './framing'
import type { JsonRpcMessage } from './jsonrpc'

/** A loopback transport that lets a fake server reply to what the client sends. */
function makePair(): {
  transport: Transport
  serverReceive: (onMessage: (m: JsonRpcMessage) => void) => void
  serverSend: (m: JsonRpcMessage) => void
} {
  let clientOnData: (data: Uint8Array) => void = () => {}
  const serverDecoder = new MessageDecoder()
  let serverHandler: (m: JsonRpcMessage) => void = () => {}

  const transport: Transport = {
    send: (data) => {
      for (const message of serverDecoder.push(data)) serverHandler(message)
    },
    onData: (listener) => {
      clientOnData = listener
    },
  }
  return {
    transport,
    serverReceive: (onMessage) => {
      serverHandler = onMessage
    },
    serverSend: (message) => clientOnData(encodeMessage(message)),
  }
}

describe('RpcClient', () => {
  it('resolves a request with the matching response result', async () => {
    const pair = makePair()
    pair.serverReceive((message) => {
      if ('id' in message) pair.serverSend({ jsonrpc: '2.0', id: message.id, result: { ok: true } })
    })
    const client = new RpcClient(pair.transport)
    await expect(client.request('health')).resolves.toEqual({ ok: true })
  })

  it('rejects with an RpcError carrying the code', async () => {
    const pair = makePair()
    pair.serverReceive((message) => {
      if ('id' in message) {
        pair.serverSend({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'no method' },
        })
      }
    })
    const client = new RpcClient(pair.transport)
    await expect(client.request('missing')).rejects.toBeInstanceOf(RpcError)
    await expect(client.request('missing')).rejects.toMatchObject({ code: -32601 })
  })

  it('dispatches notifications to subscribers', () => {
    const pair = makePair()
    const client = new RpcClient(pair.transport)
    const handler = vi.fn()
    client.onNotification('progress', handler)
    pair.serverSend({ jsonrpc: '2.0', method: 'progress', params: { ratio: 0.5 } })
    expect(handler).toHaveBeenCalledWith({ ratio: 0.5 })
  })
})
