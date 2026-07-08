"""Round-trip tests for the framing and the server dispatch, no heavy deps."""

from __future__ import annotations

import io
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
