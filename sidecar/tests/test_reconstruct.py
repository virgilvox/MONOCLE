"""Tests for reconstruction: the synthetic backend and threaded cancellation."""

from __future__ import annotations

import io
import json
import struct
import time
from pathlib import Path

import pytest

from monocle_sidecar.backends.base import Backend, BackendConfig, Cancelled
from monocle_sidecar.registry import Registry
from monocle_sidecar.rpc import FramedStream
from monocle_sidecar.server import CANCELLED_CODE, build_server


def _noop_notify(method: str, params: dict) -> None:
    pass


def test_synthetic_backend_writes_valid_stl(tmp_path: Path) -> None:
    backend = Registry.load().instantiate("synthetic")
    result = backend.reconstruct({"outputDir": str(tmp_path)}, _noop_notify, lambda: False)

    mesh = Path(result["meshPath"])
    assert mesh.exists()
    data = mesh.read_bytes()
    triangle_count = struct.unpack_from("<I", data, 80)[0]
    assert triangle_count == result["triangleCount"]
    assert len(data) == 84 + triangle_count * 50  # header + count + 50 per triangle
    assert result["vertexCount"] == 25 * 49  # (RINGS+1) * (SECTORS+1)


def test_synthetic_backend_honors_cancel(tmp_path: Path) -> None:
    backend = Registry.load().instantiate("synthetic")
    with pytest.raises(Cancelled):
        backend.reconstruct({"outputDir": str(tmp_path)}, _noop_notify, lambda: True)


class _StallBackend(Backend):
    """Blocks until cancellation is observed, then raises Cancelled."""

    def reconstruct(self, params, notify, should_cancel):  # type: ignore[no-untyped-def]
        while not should_cancel():
            time.sleep(0.005)
        raise Cancelled()


class _FakeRegistry:
    def __init__(self, backend: Backend) -> None:
        self._backend = backend

    def describe_all(self) -> list[dict]:
        return []

    def instantiate(self, _backend_id: str) -> Backend:
        return self._backend


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
        try:
            length = int(raw[i:j].split(b":", 1)[1].strip())
        except (ValueError, IndexError):
            break
        body = raw[j + 4 : j + 4 + length]
        if len(body) < length:
            break
        try:
            frames.append(json.loads(body))
        except json.JSONDecodeError:
            break
        i = j + 4 + length
    return frames


def test_reconstruct_runs_on_a_thread_and_is_cancellable(tmp_path: Path) -> None:
    config = BackendConfig(
        id="stall",
        label="stall",
        module="unused:Unused",
        license="MIT",
        commercial_use=True,
        mono=False,
        multiview=False,
        needs_poses=False,
        device="cpu",
        dtype="fp32",
    )
    requests = _frame(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "reconstruct",
            "params": {"backend": "stall", "outputDir": str(tmp_path)},
        }
    ) + _frame({"jsonrpc": "2.0", "id": 2, "method": "cancel"})

    reader = io.BytesIO(requests)
    writer = io.BytesIO()
    server = build_server(FramedStream(reader, writer), registry=_FakeRegistry(_StallBackend(config)))
    # serve_forever dispatches reconstruct (spawns a thread) then cancel (sets the
    # event), then returns at EOF. The worker writes its cancelled response after.
    server.serve_forever()

    deadline = time.time() + 3
    frames: list[dict] = []
    while time.time() < deadline:
        frames = _read_frames(writer.getvalue())
        if any(f.get("id") == 1 and "error" in f for f in frames):
            break
        time.sleep(0.02)

    cancel_response = next(f for f in frames if f.get("id") == 2)
    assert cancel_response["result"]["cancelled"] is True
    reconstruct_response = next(f for f in frames if f.get("id") == 1)
    assert reconstruct_response["error"]["code"] == CANCELLED_CODE
