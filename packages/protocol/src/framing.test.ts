import { describe, expect, it } from 'vitest'
import { encodeMessage, MessageDecoder } from './framing'
import type { JsonRpcMessage } from './jsonrpc'

const request: JsonRpcMessage = { jsonrpc: '2.0', id: 1, method: 'health' }

describe('framing', () => {
  it('round-trips a single message', () => {
    const decoder = new MessageDecoder()
    const messages = decoder.push(encodeMessage(request))
    expect(messages).toEqual([request])
  })

  it('reassembles a message split across chunk boundaries', () => {
    const encoded = encodeMessage(request)
    const decoder = new MessageDecoder()
    const mid = Math.floor(encoded.length / 2)
    expect(decoder.push(encoded.subarray(0, mid))).toEqual([])
    expect(decoder.push(encoded.subarray(mid))).toEqual([request])
  })

  it('parses two messages arriving in one chunk', () => {
    const second: JsonRpcMessage = { jsonrpc: '2.0', method: 'log', params: { message: 'hi' } }
    const a = encodeMessage(request)
    const b = encodeMessage(second)
    const joined = new Uint8Array(a.length + b.length)
    joined.set(a, 0)
    joined.set(b, a.length)
    expect(new MessageDecoder().push(joined)).toEqual([request, second])
  })

  it('preserves newlines inside string payloads', () => {
    const withNewline: JsonRpcMessage = {
      jsonrpc: '2.0',
      method: 'log',
      params: { message: 'line one\r\nline two' },
    }
    const messages = new MessageDecoder().push(encodeMessage(withNewline))
    expect(messages).toEqual([withNewline])
  })

  it('round-trips multibyte payloads using byte length, not code-unit length', () => {
    const multibyte: JsonRpcMessage = {
      jsonrpc: '2.0',
      method: 'log',
      params: { message: 'héllo 🌍 世界' },
    }
    const messages = new MessageDecoder().push(encodeMessage(multibyte))
    expect(messages).toEqual([multibyte])
  })

  it('drops a frame with a negative Content-Length without corrupting the stream', () => {
    const bad = new TextEncoder().encode('Content-Length: -5\r\n\r\n')
    const good = encodeMessage(request)
    const joined = new Uint8Array(bad.length + good.length)
    joined.set(bad, 0)
    joined.set(good, bad.length)
    expect(new MessageDecoder().push(joined)).toEqual([request])
  })

  it('drops a frame with a non-numeric Content-Length', () => {
    const bad = new TextEncoder().encode('Content-Length: 5x\r\n\r\n')
    const good = encodeMessage(request)
    const joined = new Uint8Array(bad.length + good.length)
    joined.set(bad, 0)
    joined.set(good, bad.length)
    expect(new MessageDecoder().push(joined)).toEqual([request])
  })
})
