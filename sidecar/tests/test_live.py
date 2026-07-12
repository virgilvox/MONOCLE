"""Contract test for the experimental live walk-around fusion engine.

It exercises the real incremental loop (DA2 depth + ORB VO + Open3D TSDF) on
synthetic frames, so it needs the depth and reconstruct extras and the DA2
weights; it is skipped when any are absent. It verifies that the loop runs and
that a mesh forms after the first frame, not reconstruction accuracy.
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
    for i in range(3):
        path = tmp_path / f"frame_{i:05d}.png"
        _write_frame(path, rng)
        frames.append(path)

    # The first frame seeds the pose track and returns no mesh yet.
    assert fusion.add_frame(frames[0]) is None
    assert fusion.frame_count == 1

    # Subsequent frames return the current fused mesh.
    mesh = fusion.add_frame(frames[1])
    assert mesh is not None
    assert hasattr(mesh, "vertices")
    fusion.add_frame(frames[2])
    assert fusion.frame_count == 3
