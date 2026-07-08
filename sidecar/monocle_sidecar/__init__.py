"""MONOCLE inference sidecar.

Speaks JSON-RPC 2.0 over stdio with Content-Length framing, mirroring the
@monoclejs/protocol contract on the app side. The core has no third-party
dependencies; monocular depth and multi-view reconstruction live behind the
optional `depth` and `reconstruct` extras.
"""

PROTOCOL_VERSION = 1
