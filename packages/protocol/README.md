# @monoclejs/protocol

The wire protocol between the MONOCLE desktop app and its Python inference
sidecar. Transport-agnostic, so the same client drives a sidecar over stdio in
production and an in-memory pair in tests.

## Pieces

- **JSON-RPC 2.0 types** and guards (`isSuccess`, `isNotification`, ...).
- **Content-Length framing** (`encodeMessage`, `MessageDecoder`): the LSP scheme,
  chosen over newline-delimited JSON because it survives payloads that contain
  newlines and is simple to implement on the Python side.
- **`RpcClient`**: request/response correlation plus notification dispatch for
  streamed progress and logs, over any `Transport`.
- **Sidecar contract** (`sidecar-contract.ts`): the method names, params, and
  results the app and sidecar agree on, plus `PROTOCOL_VERSION` for handshake
  checks and `BackendInfo.commercialUse` so shippable builds can exclude
  non-commercial model weights.

```ts
import { RpcClient } from '@monoclejs/protocol'

const client = new RpcClient(stdioTransport)
client.onNotification('progress', (p) => updateBar(p))
const health = await client.request('health')
```

## Why framing, not raw stdout lines

Frames carry an explicit byte length, so a reconstruction log line with embedded
newlines can never be mistaken for a message boundary. Image payloads are passed
by temp-file path in the params, never inline, to keep the pipe light.
