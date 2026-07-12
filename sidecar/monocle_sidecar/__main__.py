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
    # Set the OpenMP coexistence guard before any native library loads. OpenCV,
    # Open3D, onnxruntime, and torch each bundle their own libomp; whichever loads
    # first wins, and a later duplicate would abort the process (OMP #15) or, on a
    # bad init order, segfault Open3D's TSDF integration (OMP #179). The sidecar is
    # a persistent process that serves single-view, walk-around, and multi-view
    # requests in one run, so the load order is not fixed; setting this here, at
    # the entry point before the first heavy import, protects every path uniformly.
    os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

    saved_stdout_fd = os.dup(1)
    writer = os.fdopen(saved_stdout_fd, "wb")
    os.dup2(2, 1)  # anything printed to stdout now lands on stderr

    # Pin Open3D's OpenMP runtime now, after the fd redirect so its import-time
    # native chatter goes to the log channel, and before any request can import
    # cv2. This must happen at startup, not lazily per backend: the sidecar is one
    # persistent process, and a single-view depth scan imports cv2 (its denoise
    # step) without Open3D, so a later walk-around would otherwise load Open3D
    # after cv2 (the order that segfaults TSDF, OMP #179). Pinning it here fixes
    # the load order for every request sequence.
    _pin_openmp_runtime()

    stream = FramedStream(sys.stdin.buffer, writer)
    build_server(stream).serve_forever()


def _pin_openmp_runtime() -> None:
    """Import Open3D first so its OpenMP runtime wins, or skip if it is absent.

    Guarded: a build with only the single-view `depth` extra has no Open3D, and
    must still serve the depth path, so a missing Open3D is not an error here. The
    fusion backends surface their own clear message when Open3D is truly needed.
    """
    try:
        import open3d  # noqa: F401
    except Exception:
        pass


if __name__ == "__main__":
    main()
