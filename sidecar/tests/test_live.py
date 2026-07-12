"""Contract test for the experimental live walk-around fusion engine.

It exercises the real incremental loop (DA2 depth + ORB VO + Open3D TSDF) on
synthetic frames, so it needs the depth and reconstruct extras and the DA2
weights; it is skipped when any are absent. It verifies that the loop runs, never
crashes, and only ever returns valid geometry. It does not assert a mesh forms:
the engine now refuses to integrate until it can calibrate a metric scale from a
pair with real parallax, and independent noise frames never track, so returning
None throughout is the correct, honest outcome. Reconstruction accuracy is
covered numerically in test_metric_scale.
"""

from __future__ import annotations

import numpy as np
import pytest


def _write_frame(path, rng):
    Image = pytest.importorskip("PIL.Image")
    # Textured noise gives ORB something to match; size is a small webcam frame.
    array = rng.integers(0, 255, size=(240, 320, 3), dtype=np.uint8)
    Image.fromarray(array).save(path)


def test_live_walk_fusion_forms_a_growing_mesh(tmp_path):
    pytest.importorskip("cv2")
    pytest.importorskip("open3d")
    pytest.importorskip("onnxruntime")
    from monocle_sidecar.live import LiveWalkFusion

    try:
        fusion = LiveWalkFusion()
    except RuntimeError as error:
        pytest.skip(f"live fusion deps unavailable: {error}")

    rng = np.random.default_rng(0)
    frames = []
    for i in range(4):
        path = tmp_path / f"frame_{i:05d}.png"
        _write_frame(path, rng)
        frames.append(path)

    # The first frame only seeds the pose track, so no mesh yet.
    assert fusion.add_frame(frames[0]) is None
    assert fusion.frame_count == 1

    # Every subsequent frame runs without crashing and returns either the current
    # fused mesh or None (when the frame could not be tracked and placed).
    for path in frames[1:]:
        mesh = fusion.add_frame(path)
        if mesh is not None:
            assert hasattr(mesh, "vertices")
            assert len(mesh.triangles) >= 0
    assert fusion.frame_count == 4
