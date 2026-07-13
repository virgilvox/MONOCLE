"""Unit tests for the native Depth Anything 3 output exporters.

These cover the Gaussian-capability gate and the ReconstructResult shape each
exporter returns, without the DA3 model or its weights: the one call into
depth_anything_3.api.export is isolated in da3_outputs._export, so the tests stub
that and assert the routing, kwargs, and result dicts around it.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from monocle_sidecar.backends import da3_outputs


def test_is_gaussian_capable_matches_only_giant_checkpoints() -> None:
    assert da3_outputs.is_gaussian_capable("depth-anything/DA3-GIANT")
    assert da3_outputs.is_gaussian_capable("depth-anything/DA3NESTED-GIANT-LARGE-1.1")
    # BASE and LARGE carry no Gaussian head.
    assert not da3_outputs.is_gaussian_capable("depth-anything/DA3-BASE")
    assert not da3_outputs.is_gaussian_capable("depth-anything/DA3-LARGE")


def test_require_gaussian_capable_rejects_base_with_clear_message() -> None:
    with pytest.raises(RuntimeError, match="Gaussian-capable"):
        da3_outputs.require_gaussian_capable("depth-anything/DA3-BASE")


def test_require_gaussian_capable_passes_giant() -> None:
    da3_outputs.require_gaussian_capable("depth-anything/DA3-GIANT")  # no raise


def test_export_point_cloud_returns_glb_result(tmp_path, monkeypatch) -> None:
    out = tmp_path / "out"

    def fake_export(prediction, export_format, export_dir, **kwargs):
        assert export_format == "glb"
        (Path(export_dir) / "scene.glb").write_bytes(b"glb")

    monkeypatch.setattr(da3_outputs, "_export", fake_export)
    monkeypatch.setattr(da3_outputs, "_glb_point_count", lambda path: 42)

    result = da3_outputs.export_point_cloud(object(), out)

    glb = str(out / "scene.glb")
    assert result["output"] == "pointCloud"
    assert result["meshPath"] == glb
    assert result["previewPath"] == glb
    assert result["vertexCount"] == 42
    assert result["triangleCount"] == 0
    assert result["artifacts"] == {"glb": glb}


def test_export_point_cloud_raises_when_glb_missing(tmp_path, monkeypatch) -> None:
    # _export writing nothing must surface as a clear error, not a bogus result.
    monkeypatch.setattr(da3_outputs, "_export", lambda *a, **k: None)
    with pytest.raises(RuntimeError, match="scene.glb"):
        da3_outputs.export_point_cloud(object(), tmp_path / "out")


def test_export_colmap_passes_image_paths_and_returns_dir(tmp_path, monkeypatch) -> None:
    out = tmp_path / "out"
    captured: dict = {}

    def fake_export(prediction, export_format, export_dir, **kwargs):
        captured["format"] = export_format
        captured["dir"] = str(export_dir)
        captured["kwargs"] = kwargs

    monkeypatch.setattr(da3_outputs, "_export", fake_export)

    paths = ["/frames/frame_00000.png", "/frames/frame_00001.png"]
    result = da3_outputs.export_colmap(object(), out, paths)

    colmap_dir = str(out / "colmap")
    assert captured["format"] == "colmap"
    assert captured["dir"] == colmap_dir
    # DA3 nests per-format options under the format name.
    assert captured["kwargs"] == {"colmap": {"image_paths": paths}}
    assert result["output"] == "colmap"
    assert result["triangleCount"] == 0
    assert result["artifacts"] == {"colmap": colmap_dir}


def test_export_gaussian_returns_ply_result(tmp_path, monkeypatch) -> None:
    out = tmp_path / "out"

    def fake_export(prediction, export_format, export_dir, **kwargs):
        assert export_format == "gs_ply"
        gs_dir = Path(export_dir) / "gs_ply"
        gs_dir.mkdir(parents=True, exist_ok=True)
        (gs_dir / "0000.ply").write_bytes(b"ply")

    monkeypatch.setattr(da3_outputs, "_export", fake_export)

    result = da3_outputs.export_gaussian(object(), out)

    ply = str(out / "gs_ply" / "0000.ply")
    assert result["output"] == "gaussian"
    assert result["meshPath"] == ply
    assert result["triangleCount"] == 0
    assert result["artifacts"] == {"gsPly": ply}


def test_export_gaussian_raises_when_ply_missing(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(da3_outputs, "_export", lambda *a, **k: None)
    with pytest.raises(RuntimeError, match="0000.ply"):
        da3_outputs.export_gaussian(object(), tmp_path / "out")


def test_export_point_cloud_result_marks_color_and_pointcloud_path(
    tmp_path, monkeypatch
) -> None:
    # The renderer treats a point cloud as previewable points, so the result must
    # nominate the GLB as both the point cloud and the preview and flag color.
    out = tmp_path / "out"
    monkeypatch.setattr(
        da3_outputs,
        "_export",
        lambda pred, fmt, d, **k: (Path(d) / "scene.glb").write_bytes(b"glb"),
    )
    monkeypatch.setattr(da3_outputs, "_glb_point_count", lambda path: 5)

    result = da3_outputs.export_point_cloud(object(), out)

    glb = str(out / "scene.glb")
    assert result["pointCloudPath"] == glb
    assert result["previewPath"] == glb
    assert result["hasColor"] is True


def test_export_colmap_result_is_folder_without_preview_or_color(
    tmp_path, monkeypatch
) -> None:
    # A COLMAP model is a folder, not a previewable single file: the renderer marks
    # it non-previewable with no count, so the result must omit previewPath,
    # pointCloudPath, and hasColor, and point meshPath at the directory itself.
    out = tmp_path / "out"
    monkeypatch.setattr(da3_outputs, "_export", lambda *a, **k: None)

    result = da3_outputs.export_colmap(object(), out, ["/frames/frame_00000.png"])

    colmap_dir = str(out / "colmap")
    assert result["meshPath"] == colmap_dir
    assert result["artifacts"] == {"colmap": colmap_dir}
    assert "previewPath" not in result
    assert "pointCloudPath" not in result
    assert "hasColor" not in result
    # The COLMAP export writes into a directory the exporter created, never a file.
    assert (out / "colmap").is_dir()


def test_export_gaussian_result_shape_and_paths(tmp_path, monkeypatch) -> None:
    # A splat PLY is the primary, point cloud, and preview file, flagged colored,
    # with the splat recorded under the gsPly artifact key the protocol defines.
    out = tmp_path / "out"

    def fake_export(prediction, export_format, export_dir, **kwargs):
        gs_dir = Path(export_dir) / "gs_ply"
        gs_dir.mkdir(parents=True, exist_ok=True)
        (gs_dir / "0000.ply").write_bytes(b"ply")

    monkeypatch.setattr(da3_outputs, "_export", fake_export)

    result = da3_outputs.export_gaussian(object(), out)

    ply = str(out / "gs_ply" / "0000.ply")
    assert result["pointCloudPath"] == ply
    assert result["previewPath"] == ply
    assert result["hasColor"] is True
    assert result["artifacts"] == {"gsPly": ply}


def test_glb_point_count_counts_pointcloud_vertices(tmp_path) -> None:
    # The point-cloud vertexCount is read back from the exported GLB. Exercise the
    # real reader (not the stub) so the point-count wiring is covered end to end.
    trimesh = pytest.importorskip("trimesh")
    import numpy as np

    glb = tmp_path / "scene.glb"
    scene = trimesh.Scene()
    scene.add_geometry(trimesh.PointCloud(np.zeros((6, 3))))
    scene.export(str(glb))

    assert da3_outputs._glb_point_count(glb) == 6


def test_glb_point_count_returns_zero_on_unreadable_file(tmp_path) -> None:
    # A missing or unreadable GLB must yield 0, never raise: the count is a nicety.
    assert da3_outputs._glb_point_count(tmp_path / "does_not_exist.glb") == 0


def test_export_without_da3_package_raises_helpful_error(tmp_path, monkeypatch) -> None:
    # Force the depth_anything_3 import to fail so the missing-extra path is covered.
    import builtins

    real_import = builtins.__import__

    def blocked(name, *args, **kwargs):
        if name == "depth_anything_3.api" or name.startswith("depth_anything_3"):
            raise ImportError("depth_anything_3 blocked for test")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", blocked)
    with pytest.raises(RuntimeError, match="reconstruct"):
        da3_outputs._export(object(), "glb", tmp_path)
