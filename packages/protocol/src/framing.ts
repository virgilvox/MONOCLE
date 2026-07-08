import type { JsonRpcMessage } from './jsonrpc'

/**
 * Content-Length framing, the same scheme the Language Server Protocol uses.
 * Each message is `Content-Length: N\r\n\r\n` followed by N bytes of UTF-8 JSON.
 * This survives arbitrary payloads (including newlines inside strings), which
 * newline-delimited JSON does not, and it is trivial to implement on the Python
 * sidecar side.
 */

const HEADER_SEPARATOR = '\r\n\r\n'
const CONTENT_LENGTH = 'content-length:'
// Reject an advertised body larger than this so a malformed or hostile header
// cannot make the decoder buffer without bound.
const MAX_BODY_BYTES = 256 * 1024 * 1024

/** Encode a message into a framed byte buffer ready to write to a stream. */
export function encodeMessage(message: JsonRpcMessage): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message))
  const header = new TextEncoder().encode(`Content-Length: ${body.length}${HEADER_SEPARATOR}`)
  const out = new Uint8Array(header.length + body.length)
  out.set(header, 0)
  out.set(body, header.length)
  return out
}

/**
 * Incremental decoder. Feed it stream chunks with `push`; it returns every
 * complete message it can parse, buffering any partial remainder for later.
 */
export class MessageDecoder {
  private buffer: Uint8Array = new Uint8Array(0)

  push(chunk: Uint8Array): JsonRpcMessage[] {
    this.buffer = concat(this.buffer, chunk)
    const messages: JsonRpcMessage[] = []

    for (;;) {
      const headerEnd = indexOfSeparator(this.buffer)
      if (headerEnd === -1) break

      const headerText = new TextDecoder().decode(this.buffer.subarray(0, headerEnd))
      const length = parseContentLength(headerText)
      if (length === null) {
        // Unparseable header: drop it so a single bad frame cannot wedge the stream.
        this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length)
        continue
      }

      const bodyStart = headerEnd + HEADER_SEPARATOR.length
      if (this.buffer.length < bodyStart + length) break // wait for more bytes

      const bodyBytes = this.buffer.subarray(bodyStart, bodyStart + length)
      this.buffer = this.buffer.subarray(bodyStart + length)
      try {
        messages.push(JSON.parse(new TextDecoder().decode(bodyBytes)) as JsonRpcMessage)
      } catch {
        // Skip a malformed body rather than throwing on the transport thread.
      }
    }
    return messages
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function indexOfSeparator(buffer: Uint8Array): number {
  // Look for \r\n\r\n (13 10 13 10).
  for (let i = 0; i + 3 < buffer.length; i++) {
    if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
      return i
    }
  }
  return -1
}

function parseContentLength(header: string): number | null {
  for (const line of header.split('\r\n')) {
    if (line.toLowerCase().startsWith(CONTENT_LENGTH)) {
      const raw = line.slice(CONTENT_LENGTH.length).trim()
      // Require a pure non-negative integer; reject "-5", "5x", NaN, and absurd
      // sizes so a bad header cannot rewind or unboundedly grow the buffer.
      if (!/^\d+$/.test(raw)) return null
      const value = Number.parseInt(raw, 10)
      if (!Number.isSafeInteger(value) || value > MAX_BODY_BYTES) return null
      return value
    }
  }
  return null
}
