"""Device selection and output routing for the Depth Anything 3 backend.

These run without model weights or a GPU: `_resolve_device` and `_select_device`
are pure functions exercised with a fake torch, and the reconstruct output routing
is checked by stubbing inference (`_infer_da3`) and the native exporters so no
heavy forward pass runs. The heavy gaussian path that truly needs a giant
checkpoint on a GPU is marked skipped with a reason.
"""

from __future__ import annotations

import types
from pathlib import Path

import pytest

from monocle_sidecar.backends import da3_outputs
from monocle_sidecar.backends import multiview as mv
from monocle_sidecar.backends.base import require_mesh_output
from monocle_sidecar.registry import Registry


def _noop(method: str, params: dict) -> None:
    pass


def _fake_torch(cuda: bool = False, mps: bool | None = False) -> object:
    """A stand-in torch exposing just the availability probes _resolve_device reads.

    mps=None models a build with no torch.backends.mps attribute at all (older or
    CPU-only wheels), which must be treated as unavailable, not crash.
    """
    cuda_ns = types.SimpleNamespace(is_available=lambda: cuda)
    if mps is None:
        backends = types.SimpleNamespace()
    else:
        backends = types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: mps))
    return types.SimpleNamespace(cuda=cuda_ns, backends=backends)


# _resolve_device: mapping and graceful fallback


def test_auto_prefers_cuda_then_mps_then_cpu() -> None:
    assert mv._resolve_device(_fake_torch(cuda=True, mps=True), "auto") == "cuda"
    assert mv._resolve_device(_fake_torch(cuda=False, mps=True), "auto") == "mps"
    assert mv._resolve_device(_fake_torch(cuda=False, mps=False), "auto") == "cpu"


def test_cpu_is_always_honored() -> None:
    assert mv._resolve_device(_fake_torch(cuda=True, mps=True), "cpu") == "cpu"


def test_explicit_cuda_is_honored_when_available() -> None:
    assert mv._resolve_device(_fake_torch(cuda=True), "cuda") == "cuda"


def test_cuda_request_falls_back_when_unavailable(caplog) -> None:
    with caplog.at_level("WARNING"):
        # No CUDA, but MPS present -> best available fallback is mps.
        assert mv._resolve_device(_fake_torch(cuda=False, mps=True), "cuda") == "mps"
        # Nothing available -> cpu.
        assert mv._resolve_device(_fake_torch(cuda=False, mps=False), "cuda") == "cpu"
    assert "CUDA" in caplog.text


def test_mps_request_falls_back_when_unavailable(caplog) -> None:
    with caplog.at_level("WARNING"):
        assert mv._resolve_device(_fake_torch(cuda=True, mps=False), "mps") == "cuda"
        assert mv._resolve_device(_fake_torch(cuda=False, mps=False), "mps") == "cpu"
        # No mps attribute at all is treated as unavailable.
        assert mv._resolve_device(_fake_torch(cuda=False, mps=None), "mps") == "cpu"
    assert "MPS" in caplog.text


# _select_device: params override the configured device


def test_explicit_param_device_overrides_config() -> None:
    assert mv._select_device({"device": "mps"}, "auto") == "mps"
    assert mv._select_device({"device": "cpu"}, "cuda") == "cpu"


def test_auto_or_missing_param_defers_to_config() -> None:
    assert mv._select_device({"device": "auto"}, "cuda") == "cuda"
    assert mv._select_device({}, "mps") == "mps"


# reconstruct output routing


def _stub_backend(monkeypatch, prediction, capture: dict):
    """A DA3 backend with frame IO and inference stubbed; records the infer call."""
    backend = Registry.load().instantiate("depth-anything-3")
    monkeypatch.setattr(mv, "_require_torch", lambda: object())
    monkeypatch.setattr(mv, "_select_frame_paths", lambda d: [Path("frame_00000.png")])
    monkeypatch.setattr(mv, "_load_images", lambda paths, notify, sc: [object()])

    def fake_infer(images, torch, device, dtype, checkpoint=None, infer_gs=False):
        capture["device"] = device
        capture["infer_gs"] = infer_gs
        capture["checkpoint"] = checkpoint
        return prediction

    monkeypatch.setattr(mv, "_infer_da3", fake_infer)
    return backend


def _guard_native(monkeypatch) -> None:
    """Make every native exporter fail if called, for the mesh-path assertion."""

    def forbidden(*args, **kwargs):
        raise AssertionError("native exporter must not run for a mesh output")

    monkeypatch.setattr(mv.da3_outputs, "export_point_cloud", forbidden)
    monkeypatch.setattr(mv.da3_outputs, "export_colmap", forbidden)
    monkeypatch.setattr(mv.da3_outputs, "export_gaussian", forbidden)


def test_mesh_output_fuses_and_skips_native_exporters(tmp_path, monkeypatch) -> None:
    prediction = object()
    capture: dict = {}
    backend = _stub_backend(monkeypatch, prediction, capture)
    _guard_native(monkeypatch)

    monkeypatch.setattr(mv, "_prediction_to_views", lambda pred, images: [])
    monkeypatch.setattr(mv, "_to_posed_frames", lambda images, views, color: [])
    monkeypatch.setattr(mv, "_fuse", lambda posed: "MESH")
    monkeypatch.setattr(mv, "_cleanup", lambda mesh, quality: mesh)
    monkeypatch.setattr(mv, "_is_empty", lambda mesh: False)
    monkeypatch.setattr(
        mv, "_write", lambda mesh, out, color: {"meshPath": str(out / "scan.stl"), "triangleCount": 12}
    )

    params = {"framesDir": str(tmp_path), "outputDir": str(tmp_path / "out")}
    result = backend.reconstruct(params, _noop, lambda: False)

    assert result["triangleCount"] == 12
    # mesh output never asks for gaussians.
    assert capture["infer_gs"] is False


def test_point_cloud_output_routes_to_glb_exporter(tmp_path, monkeypatch) -> None:
    prediction = object()
    capture: dict = {}
    backend = _stub_backend(monkeypatch, prediction, capture)

    seen: dict = {}

    def fake_pc(pred, out_dir):
        seen["pred"] = pred
        seen["out"] = out_dir
        return {"output": "pointCloud", "meshPath": "scene.glb", "vertexCount": 3, "triangleCount": 0}

    monkeypatch.setattr(mv.da3_outputs, "export_point_cloud", fake_pc)

    params = {"framesDir": str(tmp_path), "outputDir": str(tmp_path / "out"), "output": "pointCloud"}
    result = backend.reconstruct(params, _noop, lambda: False)

    assert result["output"] == "pointCloud"
    assert seen["pred"] is prediction
    assert seen["out"] == tmp_path / "out"
    assert capture["infer_gs"] is False


def test_colmap_output_routes_with_frame_paths(tmp_path, monkeypatch) -> None:
    prediction = object()
    capture: dict = {}
    backend = _stub_backend(monkeypatch, prediction, capture)
    # A concrete frame path so the string list handed to the exporter is checked.
    monkeypatch.setattr(mv, "_select_frame_paths", lambda d: [Path("/frames/frame_00000.png")])

    seen: dict = {}

    def fake_colmap(pred, out_dir, image_paths):
        seen["image_paths"] = image_paths
        return {"output": "colmap", "meshPath": str(out_dir / "colmap"), "triangleCount": 0}

    monkeypatch.setattr(mv.da3_outputs, "export_colmap", fake_colmap)

    params = {"framesDir": str(tmp_path), "outputDir": str(tmp_path / "out"), "output": "colmap"}
    result = backend.reconstruct(params, _noop, lambda: False)

    assert result["output"] == "colmap"
    assert seen["image_paths"] == ["/frames/frame_00000.png"]


def test_gaussian_output_requests_gs_and_routes(tmp_path, monkeypatch) -> None:
    prediction = object()
    capture: dict = {}
    backend = _stub_backend(monkeypatch, prediction, capture)

    seen: dict = {}

    def fake_gaussian(pred, out_dir):
        seen["out"] = out_dir
        return {"output": "gaussian", "triangleCount": 0}

    monkeypatch.setattr(mv.da3_outputs, "export_gaussian", fake_gaussian)

    params = {
        "framesDir": str(tmp_path),
        "outputDir": str(tmp_path / "out"),
        "output": "gaussian",
        "checkpoint": "giant",  # Gaussian-capable, passes the gate.
    }
    result = backend.reconstruct(params, _noop, lambda: False)

    assert result["output"] == "gaussian"
    # A gaussian output must ask inference for the Gaussian head.
    assert capture["infer_gs"] is True


def test_gaussian_output_rejects_non_capable_checkpoint(tmp_path, monkeypatch) -> None:
    backend = Registry.load().instantiate("depth-anything-3")
    monkeypatch.setattr(mv, "_require_torch", lambda: object())
    monkeypatch.delenv("MONOCLE_DA3_CKPT", raising=False)

    # No checkpoint -> BASE default, which has no Gaussian head. The gate fires
    # before any frame IO or inference runs.
    def fail_infer(*args, **kwargs):
        raise AssertionError("inference must not run when the gaussian gate rejects")

    monkeypatch.setattr(mv, "_infer_da3", fail_infer)

    params = {"framesDir": str(tmp_path), "outputDir": str(tmp_path / "out"), "output": "gaussian"}
    with pytest.raises(RuntimeError, match="Gaussian-capable"):
        backend.reconstruct(params, _noop, lambda: False)


def test_unknown_output_is_rejected(tmp_path, monkeypatch) -> None:
    backend = Registry.load().instantiate("depth-anything-3")
    monkeypatch.setattr(mv, "_require_torch", lambda: object())

    params = {"framesDir": str(tmp_path), "outputDir": str(tmp_path / "out"), "output": "voxels"}
    with pytest.raises(RuntimeError, match="unknown output"):
        backend.reconstruct(params, _noop, lambda: False)


# mesh-only backends reject native outputs


def test_require_mesh_output_passes_mesh_and_default() -> None:
    require_mesh_output({})  # no raise
    require_mesh_output({"output": "mesh"})  # no raise


def test_require_mesh_output_rejects_non_mesh() -> None:
    with pytest.raises(RuntimeError, match="only produces a mesh"):
        require_mesh_output({"output": "pointCloud"})


def test_synthetic_backend_rejects_non_mesh_output(tmp_path) -> None:
    backend = Registry.load().instantiate("synthetic")
    params = {"outputDir": str(tmp_path / "out"), "output": "gaussian"}
    with pytest.raises(RuntimeError, match="only produces a mesh"):
        backend.reconstruct(params, _noop, lambda: False)


@pytest.mark.skip(
    reason="needs a Gaussian-capable giant checkpoint and a GPU; not available in CI"
)
def test_gaussian_end_to_end_with_giant_checkpoint() -> None:
    # Documents the heavy path: DA3 giant inference with infer_gs=True followed by
    # a real gs_ply export. Unrunnable here (no GPU, no giant weights).
    raise AssertionError("unreachable: skipped")
