"""Entry point: serve JSON-RPC over stdio until the stream closes."""

from __future__ import annotations

import sys

from .rpc import FramedStream
from .server import build_server


def main() -> None:
    stream = FramedStream(sys.stdin.buffer, sys.stdout.buffer)
    build_server(stream).serve_forever()


if __name__ == "__main__":
    main()
