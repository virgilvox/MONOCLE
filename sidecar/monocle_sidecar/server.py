"""Wires the RPC methods to the registry. Transport-agnostic for testability."""

from __future__ import annotations

import threading
import time
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

    @server.method("prepareMedia")
    def prepare_media_method(params: dict[str, Any], request_id: Any) -> Any:
        # Ingest a dropped-in video or image folder into keyframes on a worker
        # thread so a long video decode does not block the read loop.
        def run() -> None:
            try:
                # Lazy import: keeps the dependency-free core (health, listBackends)
                # importable on a bare Python without numpy or imageio.
                from .media.prepare import prepare_media

                server.notify(
                    "progress", {"stage": "import", "ratio": 0.0, "message": "reading media"}
                )
                count = prepare_media(
                    Path(params["source"]),
                    Path(params["framesDir"]),
                    params.get("maxFrames"),
                )
                server.notify(
                    "progress",
                    {"stage": "import", "ratio": 1.0, "message": f"selected {count} keyframes"},
                )
                server.respond(request_id, {"frameCount": count})
            except Exception as error:  # noqa: BLE001 - surface any failure to the app
                server.respond_error(request_id, -32000, str(error))

        threading.Thread(target=run, daemon=True).start()
        return server.DEFERRED

    @server.method("liveReconstruct")
    def live_reconstruct(params: dict[str, Any], request_id: Any) -> Any:
        # Experimental: incrementally fuse keyframes as they are staged and stream
        # a growing mesh, ending when the app sends cancel. Runs on a worker thread
        # so cancel can be received mid-scan.
        cancel_event = server.register_cancel(request_id)

        def run() -> None:
            try:
                result = _run_live(params, server, cancel_event)
                server.respond(request_id, result)
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


def _run_live(params: dict[str, Any], server: RpcServer, cancel_event: Any) -> dict[str, Any]:
    """Poll the frames directory, fuse each new keyframe, stream mesh updates.

    Returns a summary when the app cancels (which ends a live scan).
    """
    from .live import LiveWalkFusion

    import open3d as o3d

    frames_dir = Path(params["framesDir"])
    out_dir = Path(params["outputDir"])
    out_dir.mkdir(parents=True, exist_ok=True)

    fusion = LiveWalkFusion(frames_dir=frames_dir)
    processed = 0
    version = 0
    while not cancel_event.is_set():
        frames = sorted(frames_dir.glob("frame_*.png"))
        if len(frames) <= processed:
            time.sleep(0.25)
            continue
        for path in frames[processed:]:
            if cancel_event.is_set():
                break
            try:
                mesh = fusion.add_frame(path)
            except Exception as error:  # noqa: BLE001 - a bad frame must not kill the job
                server.notify(
                    "log", {"level": "warn", "message": f"live: skipped {path.name}: {error}"}
                )
                mesh = None
            processed += 1
            if mesh is None or len(mesh.triangles) == 0:
                continue
            version += 1
            # Versioned paths so the app reads a complete file, never one mid-write.
            mesh_path = out_dir / f"live_{version:04d}.ply"
            o3d.io.write_triangle_mesh(str(mesh_path), mesh, write_vertex_colors=True)
            server.notify(
                "meshUpdate",
                {
                    "meshPath": str(mesh_path),
                    "vertexCount": len(mesh.vertices),
                    "triangleCount": len(mesh.triangles),
                    "frameCount": fusion.frame_count,
                },
            )

    return {"cancelled": True, "frameCount": fusion.frame_count}


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
