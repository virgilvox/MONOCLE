"""liveReconstruct through the RPC server: wiring, cancel, and error mapping.

The real fusion loop needs Open3D and the depth model, so _run_live is faked and
the tests cover the server seam alone: param passing, meshUpdate notifications,
the cancel-ends-the-scan result, the Cancelled to CANCELLED_CODE mapping, and
validation errors. Matches the fake style of test_reconstruct.py.
"""

from __future__ import annotations

import io
import json
import time
from pathlib import Path

from monocle_sidecar import server as server_module
from monocle_sidecar.backends.base import Cancelled
from monocle_sidecar.rpc import FramedStream
from monocle_sidecar.server import CANCELLED_CODE, build_server


def _frame(message: dict) -> bytes:
    body = json.dumps(message).encode("utf-8")
    return f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body


def _read_frames(raw: bytes) -> list[dict]:
    frames: list[dict] = []
    i = 0
    while True:
        j = raw.find(b"\r\n\r\n", i)
        if j == -1:
            break
        length = int(raw[i:j].split(b":", 1)[1].strip())
        body = raw[j + 4 : j + 4 + length]
        if len(body) < length:
            break
        frames.append(json.loads(body))
        i = j + 4 + length
    return frames


def _wait_for_reply(writer: io.BytesIO, request_id: int) -> list[dict]:
    """Poll the wire until the worker thread has written the reply for the id."""
    deadline = time.time() + 3
    frames: list[dict] = []
    while time.time() < deadline:
        frames = _read_frames(writer.getvalue())
        if any(f.get("id") == request_id and ("result" in f or "error" in f) for f in frames):
            break
        time.sleep(0.02)
    return frames


def _live_request(tmp_path: Path, request_id: int = 1) -> bytes:
    return _frame(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "liveReconstruct",
            "params": {"framesDir": str(tmp_path), "outputDir": str(tmp_path / "out")},
        }
    )


def test_live_reconstruct_wires_params_and_streams_mesh_updates(
    monkeypatch, tmp_path: Path
) -> None:
    seen: dict = {}

    def fake_run_live(params, server, cancel_event):  # type: ignore[no-untyped-def]
        seen["framesDir"] = params["framesDir"]
        seen["outputDir"] = params["outputDir"]
        server.notify("meshUpdate", {"meshPath": "live_0001.ply", "vertexCount": 3})
        return {"cancelled": True, "frameCount": 5}

    monkeypatch.setattr(server_module, "_run_live", fake_run_live)
    writer = io.BytesIO()
    build_server(FramedStream(io.BytesIO(_live_request(tmp_path)), writer)).serve_forever()

    frames = _wait_for_reply(writer, 1)
    response = next(f for f in frames if f.get("id") == 1)
    assert response["result"] == {"cancelled": True, "frameCount": 5}
    assert seen == {"framesDir": str(tmp_path), "outputDir": str(tmp_path / "out")}

    updates = [f["params"] for f in frames if f.get("method") == "meshUpdate"]
    assert updates == [{"meshPath": "live_0001.ply", "vertexCount": 3}]


def test_live_reconstruct_cancel_ends_the_scan_with_a_result(
    monkeypatch, tmp_path: Path
) -> None:
    def waiting_run_live(params, server, cancel_event):  # type: ignore[no-untyped-def]
        while not cancel_event.is_set():
            time.sleep(0.005)
        return {"cancelled": True, "frameCount": 0}

    monkeypatch.setattr(server_module, "_run_live", waiting_run_live)
    requests = _live_request(tmp_path) + _frame({"jsonrpc": "2.0", "id": 2, "method": "cancel"})
    writer = io.BytesIO()
    build_server(FramedStream(io.BytesIO(requests), writer)).serve_forever()

    frames = _wait_for_reply(writer, 1)
    cancel_response = next(f for f in frames if f.get("id") == 2)
    assert cancel_response["result"]["cancelled"] is True
    # A live scan ends by cancel, so the reply is a summary result, not an error.
    response = next(f for f in frames if f.get("id") == 1)
    assert response["result"] == {"cancelled": True, "frameCount": 0}


def test_live_reconstruct_maps_cancelled_to_cancelled_code(
    monkeypatch, tmp_path: Path
) -> None:
    # A Cancelled escaping the fusion loop must map to the same code the other
    # long-running methods use, not the generic -32000.
    def cancelled_run_live(params, server, cancel_event):  # type: ignore[no-untyped-def]
        raise Cancelled()

    monkeypatch.setattr(server_module, "_run_live", cancelled_run_live)
    writer = io.BytesIO()
    build_server(FramedStream(io.BytesIO(_live_request(tmp_path)), writer)).serve_forever()

    frames = _wait_for_reply(writer, 1)
    response = next(f for f in frames if f.get("id") == 1)
    assert response["error"]["code"] == CANCELLED_CODE
    assert response["error"]["message"] == "cancelled"


def test_live_reconstruct_missing_frames_dir_is_a_clear_error(tmp_path: Path) -> None:
    request = _frame(
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "liveReconstruct",
            "params": {"outputDir": str(tmp_path)},
        }
    )
    writer = io.BytesIO()
    build_server(FramedStream(io.BytesIO(request), writer)).serve_forever()

    response = next(f for f in _read_frames(writer.getvalue()) if f.get("id") == 3)
    assert response["error"]["code"] == -32000
    assert response["error"]["message"] == "liveReconstruct requires 'framesDir'"
