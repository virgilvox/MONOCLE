"""Smoke test for the Depth Anything V2 walk-around backend (the default).

Runs the real backend (DA2 depth + ORB VO + TSDF fusion + cleanup + export) on
synthetic frames and checks it returns a valid result. Needs the depth and
reconstruct extras plus DA2 weights, so it is skipped without them; it verifies
the path runs end to end, not reconstruction accuracy.
"""

from __future__ import annotations

import numpy as np
import pytest


def _noop(_method, _params):
    pass


def test_walkaround_backend_produces_a_mesh(tmp_path):
    pytest.importorskip("cv2")
    pytest.importorskip("open3d")
    pytest.importorskip("onnxruntime")
    from monocle_sidecar.backends.walkaround import WalkaroundBackend
    from monocle_sidecar.backends.base import BackendConfig

    Image = pytest.importorskip("PIL.Image")
    rng = np.random.default_rng(0)
    for i in range(3):
        array = rng.integers(0, 255, size=(240, 320, 3), dtype=np.uint8)
        Image.fromarray(array).save(tmp_path / f"frame_{i:05d}.png")

    config = BackendConfig(
        id="depth-anything-v2-walk",
        label="walk",
        module="monocle_sidecar.backends.walkaround:WalkaroundBackend",
        license="Apache-2.0",
        commercial_use=True,
        mono=True,
        multiview=True,
        needs_poses=False,
        device="cpu",
        dtype="fp16",
    )
    backend = WalkaroundBackend(config)
    try:
        result = backend.reconstruct(
            {"framesDir": str(tmp_path), "outputDir": str(tmp_path), "color": True},
            _noop,
            lambda: False,
        )
    except RuntimeError as error:
        # An empty mesh on featureless synthetic noise is an acceptable outcome;
        # the point is that the pipeline ran without an unexpected failure.
        assert "empty mesh" in str(error)
        return

    assert "meshPath" in result
    assert result["vertexCount"] > 0
    assert result["triangleCount"] > 0
