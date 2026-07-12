"""Tests for media ingestion: video or image directory to a frame sequence.

The video test synthesizes a tiny clip and is skipped when imageio-ffmpeg is
absent; the directory tests need only Pillow.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from monocle_sidecar.media.ingest import _even_indices, ingest_media

Image = pytest.importorskip("PIL.Image")


def _write_image(path: Path, color: tuple[int, int, int], size=(16, 12)) -> None:
    Image.new("RGB", size, color).save(path)


def test_directory_ingest_writes_rgb_frame_sequence(tmp_path: Path) -> None:
    src = tmp_path / "src"
    src.mkdir()
    # Names deliberately out of order to prove they are sorted by name.
    _write_image(src / "b.jpg", (10, 20, 30))
    _write_image(src / "a.png", (40, 50, 60))
    _write_image(src / "c.bmp", (70, 80, 90))
    frames = tmp_path / "frames"

    count = ingest_media(src, frames)

    assert count == 3
    for index in range(3):
        frame = frames / f"frame_{index:05d}.png"
        assert frame.exists()
        assert Image.open(frame).mode == "RGB"
    # The backends discover frames by this glob; it must find exactly our output.
    assert sorted(frames.glob("frame_*.png")) == [
        frames / "frame_00000.png",
        frames / "frame_00001.png",
        frames / "frame_00002.png",
    ]
    # Sorted by name: a.png is first, so its color lands in frame_00000.
    assert Image.open(frames / "frame_00000.png").getpixel((0, 0)) == (40, 50, 60)


def test_directory_ingest_samples_evenly(tmp_path: Path) -> None:
    src = tmp_path / "src"
    src.mkdir()
    for i in range(10):
        _write_image(src / f"img_{i:02d}.png", (i, i, i))
    frames = tmp_path / "frames"

    count = ingest_media(src, frames, max_frames=4)

    assert count == 4
    assert len(list(frames.glob("frame_*.png"))) == 4
    # Even spread across img_00..img_09 keeps the endpoints: indices 0, 3, 6, 9.
    reds = [Image.open(frames / f"frame_{i:05d}.png").getpixel((0, 0))[0] for i in range(4)]
    assert reds == [0, 3, 6, 9]


def test_even_indices_spread() -> None:
    assert _even_indices(10, 4) == [0, 3, 6, 9]
    assert _even_indices(5, None) == [0, 1, 2, 3, 4]
    assert _even_indices(3, 10) == [0, 1, 2]
    assert _even_indices(4, 1) == [0]
    assert _even_indices(0, 3) == []


def test_video_ingest_writes_frames(tmp_path: Path) -> None:
    pytest.importorskip("imageio_ffmpeg")
    import imageio.v2 as imageio
    import numpy as np

    video = tmp_path / "clip.mp4"
    writer = imageio.get_writer(str(video), fps=5)
    for i in range(6):
        writer.append_data(np.full((32, 48, 3), i * 30, dtype=np.uint8))
    writer.close()
    frames = tmp_path / "frames"

    count = ingest_media(video, frames)

    assert count == 6
    assert len(list(frames.glob("frame_*.png"))) == 6
    assert Image.open(frames / "frame_00000.png").mode == "RGB"


def test_video_ingest_samples_evenly(tmp_path: Path) -> None:
    pytest.importorskip("imageio_ffmpeg")
    import imageio.v2 as imageio
    import numpy as np

    video = tmp_path / "clip.mp4"
    writer = imageio.get_writer(str(video), fps=5)
    for i in range(8):
        writer.append_data(np.full((32, 48, 3), i, dtype=np.uint8))
    writer.close()
    frames = tmp_path / "frames"

    count = ingest_media(video, frames, max_frames=3)

    assert count == 3
    assert len(list(frames.glob("frame_*.png"))) == 3


def test_empty_directory_raises(tmp_path: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(RuntimeError, match="no images"):
        ingest_media(empty, tmp_path / "frames")


def test_missing_source_raises(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="does not exist"):
        ingest_media(tmp_path / "nope", tmp_path / "frames")


def test_unsupported_file_type_raises(tmp_path: Path) -> None:
    bogus = tmp_path / "notes.txt"
    bogus.write_text("not media", encoding="utf-8")
    with pytest.raises(RuntimeError, match="unsupported source file type"):
        ingest_media(bogus, tmp_path / "frames")


def test_directory_orders_unpadded_names_numerically(tmp_path: Path) -> None:
    # A folder of img1.jpg..img12.jpg must keep numeric order; a plain string
    # sort would put img10-img12 before img2 and scramble the capture sequence.
    np = pytest.importorskip("numpy")
    Image = pytest.importorskip("PIL.Image")
    src = tmp_path / "src"
    src.mkdir()
    for i in range(1, 13):
        # Encode the intended order in the red channel so we can read it back.
        array = np.full((8, 8, 3), 0, dtype=np.uint8)
        array[:, :, 0] = i * 10
        Image.fromarray(array).save(src / f"img{i}.jpg")

    frames = tmp_path / "frames"
    ingest_media(src, frames)

    written = sorted(frames.glob("frame_*.png"))
    reds = [int(np.asarray(Image.open(p))[0, 0, 0]) for p in written]
    # Monotonically increasing red means the frames came out in numeric order.
    assert reds == sorted(reds)
    assert reds[0] < reds[-1]
