"""Wires the RPC methods to the registry. Transport-agnostic for testability."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

from . import PROTOCOL_VERSION
from .backends.base import Cancelled
from .registry import Registry
from .rpc import FramedStream, RpcServer

# JSON-RPC error code the app maps to a cancelled reconstruction.
CANCELLED_CODE = -32001


def build_server(stream: FramedStream, registry: Registry | None = None) -> RpcServer:
    server = RpcServer(stream)
    backends = registry or Registry.load()

    @server.method("health")
    def health(_params: Any, _request_id: Any) -> dict[str, Any]:
        return {
            "status": "ready",
            "protocolVersion": PROTOCOL_VERSION,
            "torchDevice": detect_device(),
        }

    @server.method("listBackends")
    def list_backends(_params: Any, _request_id: Any) -> list[dict[str, Any]]:
        return backends.describe_all()

    @server.method("reconstruct")
    def reconstruct(params: dict[str, Any], request_id: Any) -> Any:
        # Run on a worker thread so the read loop stays responsive and a cancel
        # request can be received while this is in flight.
        backend = backends.instantiate(params["backend"])
        cancel_event = server.register_cancel(request_id)

        def run() -> None:
            try:
                # A backend that needs external poses gets them from a configured
                # estimator first; the poses land in poses.json for it to read.
                # Imported lazily so the core (health, listBackends) stays
                # dependency-free and runs on a bare Python without numpy.
                if backend.config.needs_poses and "framesDir" in params:
                    from .pose.pipeline import run_pose_stage

                    run_pose_stage(
                        Path(params["framesDir"]),
                        str(params.get("poseEstimator", "orb")),
                        server.notify,
                    )
                result = backend.reconstruct(params, server.notify, cancel_event.is_set)
                server.respond(request_id, result)
            except Cancelled:
                server.respond_error(request_id, CANCELLED_CODE, "cancelled")
            except Exception as error:  # noqa: BLE001 - surface any failure to the app
                server.respond_error(request_id, -32000, str(error))
            finally:
                server.clear_cancel(request_id)

        threading.Thread(target=run, daemon=True).start()
        return server.DEFERRED

    @server.method("cancel")
    def cancel(_params: Any, _request_id: Any) -> dict[str, Any]:
        cancelled = server.cancel_active()
        return {"cancelled": cancelled > 0}

    return server


def detect_device() -> str:
    try:
        import torch

        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
        return "cpu"
    except Exception:  # noqa: BLE001 - torch is optional; report absence plainly
        return "cpu (torch not installed)"
