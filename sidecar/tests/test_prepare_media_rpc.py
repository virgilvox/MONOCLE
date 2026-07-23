"""prepareMedia through the RPC server: wiring, progress, and cancellation.

The real media pipeline is exercised in test_media_prepare.py; here the staging
function is faked so the tests cover the server seam alone (param passing,
progress notifications, the cancel mapping, and validation errors), matching the
fake-backend style of test_reconstruct.py.
"""

from __future__ import annotations

import io
import json
import time
from pathlib import Path

from monocle_sidecar.backends.base import Cancelled
from monocle_sidecar.media import prepare as prepare_module
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


def test_prepare_media_wires_params_and_streams_progress(monkeypatch, tmp_path: Path) -> None:
    seen: dict = {}

    def fake_prepare(source, frames_dir, max_frames, should_cancel):  # type: ignore[no-untyped-def]
        seen["source"] = Path(source)
        seen["framesDir"] = Path(frames_dir)
        seen["maxFrames"] = max_frames
        return 7

    monkeypatch.setattr(prepare_module, "prepare_media", fake_prepare)
    request = _frame(
        {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "prepareMedia",
            "params": {
                "source": str(tmp_path / "clip.mov"),
                "framesDir": str(tmp_path / "frames"),
                "maxFrames": 12,
            },
        }
    )
    writer = io.BytesIO()
    build_server(FramedStream(io.BytesIO(request), writer)).serve_forever()

    frames = _wait_for_reply(writer, 4)
    response = next(f for f in frames if f.get("id") == 4)
    assert response["result"] == {"frameCount": 7}
    assert seen == {
        "source": tmp_path / "clip.mov",
        "framesDir": tmp_path / "frames",
        "maxFrames": 12,
    }

    progress = [f["params"] for f in frames if f.get("method") == "progress"]
    assert progress[0] == {"stage": "import", "ratio": 0.0, "message": "reading media"}
    assert progress[-1] == {"stage": "import", "ratio": 1.0, "message": "selected 7 keyframes"}


def test_prepare_media_cancel_maps_to_cancelled_code(monkeypatch, tmp_path: Path) -> None:
    def stalling_prepare(source, frames_dir, max_frames, should_cancel):  # type: ignore[no-untyped-def]
        while not should_cancel():
            time.sleep(0.005)
        raise Cancelled()

    monkeypatch.setattr(prepare_module, "prepare_media", stalling_prepare)
    requests = _frame(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "prepareMedia",
            "params": {"source": str(tmp_path / "clip.mov"), "framesDir": str(tmp_path)},
        }
    ) + _frame({"jsonrpc": "2.0", "id": 2, "method": "cancel"})
    writer = io.BytesIO()
    build_server(FramedStream(io.BytesIO(requests), writer)).serve_forever()

    frames = _wait_for_reply(writer, 1)
    cancel_response = next(f for f in frames if f.get("id") == 2)
    assert cancel_response["result"]["cancelled"] is True
    response = next(f for f in frames if f.get("id") == 1)
    assert response["error"]["code"] == CANCELLED_CODE


def test_prepare_media_missing_source_is_a_clear_error(tmp_path: Path) -> None:
    request = _frame(
        {
            "jsonrpc": "2.0",
            "id": 9,
            "method": "prepareMedia",
            "params": {"framesDir": str(tmp_path)},
        }
    )
    writer = io.BytesIO()
    build_server(FramedStream(io.BytesIO(request), writer)).serve_forever()

    response = next(f for f in _read_frames(writer.getvalue()) if f.get("id") == 9)
    assert response["error"]["code"] == -32000
    assert response["error"]["message"] == "prepareMedia requires 'source'"
