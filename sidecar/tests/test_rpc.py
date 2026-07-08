"""Round-trip tests for the framing and the server dispatch, no heavy deps."""

from __future__ import annotations

import io
import sys

import json

from monocle_sidecar import PROTOCOL_VERSION
from monocle_sidecar.rpc import FramedStream, RpcServer
from monocle_sidecar.server import build_server


def frame(message: dict) -> bytes:
    body = json.dumps(message).encode("utf-8")
    return f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body


def read_frame(raw: bytes) -> dict:
    header, _, body = raw.partition(b"\r\n\r\n")
    length = int(header.split(b":", 1)[1].strip())
    return json.loads(body[:length].decode("utf-8"))


def test_framed_stream_round_trip() -> None:
    reader = io.BytesIO(frame({"jsonrpc": "2.0", "id": 1, "method": "ping"}))
    writer = io.BytesIO()
    stream = FramedStream(reader, writer)

    message = stream.read_message()
    assert message == {"jsonrpc": "2.0", "id": 1, "method": "ping"}

    stream.write_message({"jsonrpc": "2.0", "id": 1, "result": "pong"})
    assert read_frame(writer.getvalue()) == {"jsonrpc": "2.0", "id": 1, "result": "pong"}


def test_health_reports_matching_protocol_version() -> None:
    reader = io.BytesIO(frame({"jsonrpc": "2.0", "id": 7, "method": "health"}))
    writer = io.BytesIO()
    build_server(FramedStream(reader, writer)).serve_forever()

    response = read_frame(writer.getvalue())
    assert response["id"] == 7
    assert response["result"]["protocolVersion"] == PROTOCOL_VERSION
    assert response["result"]["status"] == "ready"


def test_list_backends_returns_depth_anything() -> None:
    reader = io.BytesIO(frame({"jsonrpc": "2.0", "id": 2, "method": "listBackends"}))
    writer = io.BytesIO()
    build_server(FramedStream(reader, writer)).serve_forever()

    backends = read_frame(writer.getvalue())["result"]
    ids = [backend["id"] for backend in backends]
    assert "depth-anything-v2-small" in ids
    depth = next(b for b in backends if b["id"] == "depth-anything-v2-small")
    assert depth["capabilities"]["mono"] is True
    assert depth["commercialUse"] is True


def test_unknown_method_returns_error() -> None:
    reader = io.BytesIO(frame({"jsonrpc": "2.0", "id": 3, "method": "nope"}))
    writer = io.BytesIO()
    build_server(FramedStream(reader, writer)).serve_forever()

    response = read_frame(writer.getvalue())
    assert response["error"]["code"] == -32601


def test_stdout_writes_do_not_corrupt_framing() -> None:
    # The transport writer is independent of sys.stdout, so a handler that
    # prints (as native libraries like Open3D do) cannot inject unframed bytes
    # into the RPC stream. The process-level fd redirect in __main__ extends this
    # guarantee to C-level writes to fd 1.
    reader = io.BytesIO(frame({"jsonrpc": "2.0", "id": 1, "method": "noisy"}))
    writer = io.BytesIO()
    server = RpcServer(FramedStream(reader, writer))

    @server.method("noisy")
    def noisy(_params, _request_id):  # type: ignore[no-untyped-def]
        print("open3d-style noise on stdout")
        sys.stdout.write("more noise\n")
        return {"ok": True}

    server.serve_forever()

    out = writer.getvalue()
    assert b"noise" not in out
    assert read_frame(out) == {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}
