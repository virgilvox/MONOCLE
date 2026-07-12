"""Tests for the media preparation step (ingest + keyframe selection).

Uses an image directory so no video codec is required; numpy + PIL only.
"""

from __future__ import annotations

import numpy as np
import pytest


def _write_image(path, sharp: bool, rng) -> None:
    Image = pytest.importorskip("PIL.Image")
    if sharp:
        array = rng.integers(0, 255, size=(64, 64, 3), dtype=np.uint8)  # high frequency
    else:
        array = np.full((64, 64, 3), 128, dtype=np.uint8)  # flat, low sharpness
    Image.fromarray(array).save(path)


def test_prepare_selects_budget_from_a_folder(tmp_path):
    pytest.importorskip("PIL.Image")
    from monocle_sidecar.media.prepare import prepare_media

    src = tmp_path / "src"
    src.mkdir()
    rng = np.random.default_rng(0)
    for i in range(30):
        _write_image(src / f"img_{i:03d}.png", sharp=True, rng=rng)

    frames = tmp_path / "frames"
    count = prepare_media(src, frames, max_frames=6)

    assert count == 6
    written = sorted(frames.glob("frame_*.png"))
    assert len(written) == 6
    # Renumbered contiguously from zero, discoverable by the backend glob.
    assert written[0].name == "frame_00000.png"
    assert written[-1].name == "frame_00005.png"


def test_prepare_prefers_sharp_frames(tmp_path):
    pytest.importorskip("PIL.Image")
    from monocle_sidecar.media.prepare import prepare_media

    # Alternate sharp and flat frames; with one bucket the sharp one must win.
    src = tmp_path / "src"
    src.mkdir()
    rng = np.random.default_rng(1)
    _write_image(src / "img_000.png", sharp=False, rng=rng)
    _write_image(src / "img_001.png", sharp=True, rng=rng)

    frames = tmp_path / "frames"
    count = prepare_media(src, frames, max_frames=1)
    assert count == 1

    from monocle_sidecar.media.selection import sharpness_scores

    kept = sorted(frames.glob("frame_*.png"))
    assert sharpness_scores(kept)[0] > 100.0  # kept the textured (sharp) frame


def test_prepare_without_budget_keeps_all(tmp_path):
    pytest.importorskip("PIL.Image")
    from monocle_sidecar.media.prepare import prepare_media

    src = tmp_path / "src"
    src.mkdir()
    rng = np.random.default_rng(2)
    for i in range(5):
        _write_image(src / f"img_{i:03d}.png", sharp=True, rng=rng)

    frames = tmp_path / "frames"
    assert prepare_media(src, frames, max_frames=None) == 5
    assert len(list(frames.glob("frame_*.png"))) == 5


def test_prepare_missing_source_raises(tmp_path):
    from monocle_sidecar.media.prepare import prepare_media

    with pytest.raises(RuntimeError):
        prepare_media(tmp_path / "nope", tmp_path / "frames", max_frames=4)
