"""Tests for the pure keyframe selector.

Frames are synthesised in tmp_path with numpy and PIL: high-frequency noise
stands in for a sharp frame, a constant fill for a blurred one. No model, no
heavy dependency, no real video.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from monocle_sidecar.media.selection import (
    select_keyframes,
    sharpness_scores,
    variance_of_laplacian,
)

np = pytest.importorskip("numpy")
pytest.importorskip("PIL")


def _write_frame(path: Path, array) -> Path:
    from PIL import Image

    Image.fromarray(array.astype("uint8"), mode="L").save(path)
    return path


def _sharp(path: Path, size: int = 32, seed: int = 0) -> Path:
    """A high-frequency noise frame: a large Laplacian variance."""
    rng = np.random.default_rng(seed)
    return _write_frame(path, rng.integers(0, 256, size=(size, size)))


def _blurred(path: Path, size: int = 32, value: int = 128) -> Path:
    """A constant frame: a near-zero Laplacian variance."""
    return _write_frame(path, np.full((size, size), value))


def test_variance_of_laplacian_ranks_noise_above_flat() -> None:
    noise = np.random.default_rng(1).integers(0, 256, size=(16, 16)).astype("float64")
    flat = np.full((16, 16), 128.0)
    assert variance_of_laplacian(np, noise) > variance_of_laplacian(np, flat)


def test_variance_of_laplacian_small_image_uses_intensity_variance() -> None:
    tiny = np.array([[0.0, 255.0]], dtype="float64")  # 1x2, no interior pixel
    assert variance_of_laplacian(np, tiny) == pytest.approx(tiny.var())


def test_sharpness_scores_track_input_order(tmp_path: Path) -> None:
    paths = [
        _blurred(tmp_path / "frame_00000.png"),
        _sharp(tmp_path / "frame_00001.png", seed=7),
        _blurred(tmp_path / "frame_00002.png"),
    ]
    scores = sharpness_scores(paths)
    assert len(scores) == 3
    assert scores[1] > scores[0]
    assert scores[1] > scores[2]


def test_select_returns_exactly_target_when_input_is_larger(tmp_path: Path) -> None:
    paths = [_sharp(tmp_path / f"frame_{i:05d}.png", seed=i) for i in range(10)]
    picked = select_keyframes(paths, target=3)
    assert len(picked) == 3


def test_select_prefers_the_sharp_frame_in_each_bucket(tmp_path: Path) -> None:
    # Two buckets of two: a blurred then a sharp frame in each. Expect the sharp.
    paths = [
        _blurred(tmp_path / "frame_00000.png"),
        _sharp(tmp_path / "frame_00001.png", seed=1),
        _blurred(tmp_path / "frame_00002.png"),
        _sharp(tmp_path / "frame_00003.png", seed=2),
    ]
    picked = select_keyframes(paths, target=2)
    assert picked == [paths[1], paths[3]]


def test_select_preserves_input_order(tmp_path: Path) -> None:
    paths = [_sharp(tmp_path / f"frame_{i:05d}.png", seed=i) for i in range(12)]
    picked = select_keyframes(paths, target=4)
    order = [paths.index(p) for p in picked]
    assert order == sorted(order)
    assert len(set(picked)) == len(picked)  # no duplicates


def test_select_returns_all_when_input_not_larger_than_target(tmp_path: Path) -> None:
    paths = [_sharp(tmp_path / f"frame_{i:05d}.png", seed=i) for i in range(3)]
    assert select_keyframes(paths, target=5) == paths
    assert select_keyframes(paths, target=3) == paths


def test_select_single_frame_is_returned(tmp_path: Path) -> None:
    only = [_sharp(tmp_path / "frame_00000.png")]
    assert select_keyframes(only, target=4) == only


def test_select_empty_input_returns_empty() -> None:
    assert select_keyframes([], target=4) == []


def test_select_non_positive_target_returns_empty(tmp_path: Path) -> None:
    paths = [_sharp(tmp_path / f"frame_{i:05d}.png", seed=i) for i in range(5)]
    assert select_keyframes(paths, target=0) == []
    assert select_keyframes(paths, target=-2) == []


def test_select_min_gap_enforces_spacing(tmp_path: Path) -> None:
    # Sharpest frames cluster at the start; a wide gap forces spread-out picks.
    scores = [100, 99, 98, 1, 1, 1, 1, 1, 1, 1]
    paths = []
    for i, sharp in enumerate(scores):
        if sharp > 10:
            paths.append(_sharp(tmp_path / f"frame_{i:05d}.png", seed=i))
        else:
            paths.append(_blurred(tmp_path / f"frame_{i:05d}.png"))
    picked = select_keyframes(paths, target=3, min_gap=3)
    indices = [paths.index(p) for p in picked]
    assert all(b - a >= 3 for a, b in zip(indices, indices[1:]))


def test_select_returns_path_objects(tmp_path: Path) -> None:
    paths = [str(_sharp(tmp_path / f"frame_{i:05d}.png", seed=i)) for i in range(6)]
    picked = select_keyframes(paths, target=2)
    assert all(isinstance(p, Path) for p in picked)
