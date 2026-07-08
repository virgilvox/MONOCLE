"""Tests for the fusion contract.

Two layers: the guard behavior when Open3D is absent (always runs, no heavy
deps), and an end-to-end integrate-and-export when Open3D is importable
(skipped in CI where it is not installed).
"""

from __future__ import annotations

import importlib.util

import pytest

from monocle_sidecar.fusion import export, tsdf

_HAS_OPEN3D = importlib.util.find_spec("open3d") is not None


def test_frames_module_imports_without_open3d() -> None:
    # PosedDepthFrame only needs numpy, so it must import on the plain test env.
    from monocle_sidecar.fusion.frames import PosedDepthFrame

    assert PosedDepthFrame.__dataclass_fields__.keys() >= {
        "depth",
        "intrinsics",
        "pose",
        "color",
    }


@pytest.mark.skipif(_HAS_OPEN3D, reason="guard only raises when Open3D is missing")
def test_integrate_guard_names_reconstruct_extra() -> None:
    with pytest.raises(RuntimeError, match="reconstruct"):
        tsdf.integrate_depth_frames([])


@pytest.mark.skipif(_HAS_OPEN3D, reason="guard only raises when Open3D is missing")
def test_write_mesh_guard_names_reconstruct_extra(tmp_path) -> None:
    with pytest.raises(RuntimeError, match="reconstruct"):
        export.write_mesh(object(), tmp_path)


@pytest.mark.skipif(not _HAS_OPEN3D, reason="Open3D not installed")
def test_integrate_and_export_round_trip(tmp_path) -> None:
    import numpy as np

    from monocle_sidecar.fusion.frames import PosedDepthFrame

    width, height = 64, 48
    intrinsics = {
        "fx": 50.0,
        "fy": 50.0,
        "cx": width / 2.0,
        "cy": height / 2.0,
        "width": width,
        "height": height,
    }
    # A flat wall one meter in front of the camera fills the whole frame.
    depth = np.full((height, width), 1.0, dtype=np.float32)
    color = np.full((height, width, 3), 200, dtype=np.uint8)
    frame = PosedDepthFrame(
        depth=depth,
        intrinsics=intrinsics,
        pose=np.eye(4, dtype=np.float64),
        color=color,
    )

    mesh = tsdf.integrate_depth_frames([frame], voxel_size=0.01, sdf_trunc=0.04)
    assert mesh.has_vertex_normals()

    result = export.write_mesh(mesh, tmp_path, name="wall")
    assert result["meshPath"].endswith("wall.stl")
    assert result["pointCloudPath"].endswith("wall.ply")
    assert result["vertexCount"] == len(mesh.vertices)
    assert result["triangleCount"] == len(mesh.triangles)
    from pathlib import Path

    assert Path(result["meshPath"]).exists()
    assert Path(result["pointCloudPath"]).exists()
