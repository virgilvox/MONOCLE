"""Entry point: serve JSON-RPC over stdio until the stream closes.

The JSON-RPC framing owns file descriptor 1. Native libraries (Open3D, torch)
print to fd 1 directly, which would inject unframed bytes into the protocol and
wedge the client. So we dup the real stdout to a private fd used only for the
transport, then redirect fd 1 to stderr: any stray prints go to the log channel,
never the RPC stream.
"""

from __future__ import annotations

import os
import sys

from .rpc import FramedStream
from .server import build_server


def main() -> None:
    saved_stdout_fd = os.dup(1)
    writer = os.fdopen(saved_stdout_fd, "wb")
    os.dup2(2, 1)  # anything printed to stdout now lands on stderr
    stream = FramedStream(sys.stdin.buffer, writer)
    build_server(stream).serve_forever()


if __name__ == "__main__":
    main()
