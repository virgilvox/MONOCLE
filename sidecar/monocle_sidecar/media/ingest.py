"""Normalize a dropped-in source into the ``frame_%05d.png`` sequence.

A source is either a video file or a directory of still images. Either way the
output is the same zero-padded, five-digit ``frame_00000.png`` run the capture
pipeline stages and every backend reads (see ``_list_frames`` in the depth
backend, which globs ``frame_*.png``). This is the one place that owns the
source-to-frame-sequence conversion; keyframe selection and reconstruction are
separate concerns downstream.

Heavy decoders (imageio, PIL) are imported lazily inside the helpers so importing
this package stays cheap and the missing-dependency error is clear.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

# Still-image extensions accepted in a source directory (matched case-insensitively).
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
# Container extensions routed to the video decoder (matched case-insensitively).
_VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".webm"}


def ingest_media(
    source: str | Path, frames_dir: str | Path, max_frames: int | None = None
) -> int:
    """Turn a video file or image directory into a ``frame_%05d.png`` sequence.

    Args:
        source: a directory of still images, or a single video file.
        frames_dir: destination directory for the frames. Created if missing.
        max_frames: optional cap on frames written. When the source has more
            frames than this, they are sampled evenly across the whole span, not
            truncated to the first ``max_frames``.

    Returns:
        The number of frames written.

    Raises:
        RuntimeError: the source is missing, empty, unreadable, or an
            unsupported type.
    """
    src = Path(source)
    out = Path(frames_dir)
    out.mkdir(parents=True, exist_ok=True)

    if src.is_dir():
        return _ingest_directory(src, out, max_frames)
    if src.is_file():
        if src.suffix.lower() in _VIDEO_EXTENSIONS:
            return _ingest_video(src, out, max_frames)
        raise RuntimeError(
            f"unsupported source file type: {src.suffix or src.name!r} "
            f"(expected one of {sorted(_VIDEO_EXTENSIONS)})"
        )
    raise RuntimeError(f"source does not exist: {src}")


def _ingest_directory(src: Path, out: Path, max_frames: int | None) -> int:
    """Copy a directory's images out as RGB ``frame_%05d.png``, sorted by name."""
    Image = _require_pillow()

    paths = sorted(
        p for p in src.iterdir() if p.is_file() and p.suffix.lower() in _IMAGE_EXTENSIONS
    )
    if not paths:
        raise RuntimeError(
            f"no images found in {src} (expected one of {sorted(_IMAGE_EXTENSIONS)})"
        )

    selected = [paths[i] for i in _even_indices(len(paths), max_frames)]
    for index, path in enumerate(selected):
        try:
            image = Image.open(path)
            image.load()
        except Exception as error:
            raise RuntimeError(f"unreadable image: {path}") from error
        image.convert("RGB").save(_frame_path(out, index), format="PNG")
    return len(selected)


def _ingest_video(src: Path, out: Path, max_frames: int | None) -> int:
    """Decode a video and write its frames as RGB ``frame_%05d.png``.

    Frames are read once in order; when ``max_frames`` selects a subset, only the
    chosen indices are written, so a long clip does not materialize in memory.
    """
    imageio, Image = _require_imageio()

    try:
        reader = imageio.get_reader(str(src))
    except Exception as error:
        raise RuntimeError(f"could not open video: {src}") from error

    try:
        total = reader.count_frames()
        wanted = set(_even_indices(total, max_frames))
        written = 0
        for source_index, frame in enumerate(reader):
            if source_index not in wanted:
                continue
            image = Image.fromarray(frame).convert("RGB")
            image.save(_frame_path(out, written), format="PNG")
            written += 1
    finally:
        reader.close()

    if written == 0:
        raise RuntimeError(f"no frames decoded from video: {src}")
    return written


def _even_indices(count: int, max_frames: int | None) -> list[int]:
    """Return up to ``max_frames`` indices spread evenly across ``range(count)``.

    With no cap, or a cap that is not smaller than ``count``, every index is
    returned in order. Otherwise the selected indices are spaced across the whole
    span so the first and last source frames are always included.
    """
    if count <= 0:
        return []
    if max_frames is None or max_frames >= count:
        return list(range(count))
    if max_frames <= 1:
        return [0]
    step = (count - 1) / (max_frames - 1)
    return [round(i * step) for i in range(max_frames)]


def _frame_path(out: Path, index: int) -> Path:
    return out / f"frame_{index:05d}.png"


def _require_pillow() -> Any:
    """Import Pillow, raising a clear error when it is missing."""
    try:
        from PIL import Image
    except ImportError as error:
        raise RuntimeError(
            "Media ingestion needs Pillow. Install it (part of the 'depth' extra) "
            "to read image directories."
        ) from error
    return Image


def _require_imageio() -> tuple[Any, Any]:
    """Import imageio (with the ffmpeg plugin) and Pillow, or raise a clear error."""
    try:
        import imageio.v2 as imageio
        import imageio_ffmpeg  # noqa: F401
        from PIL import Image
    except ImportError as error:
        raise RuntimeError(
            "Video ingestion needs imageio, imageio-ffmpeg and Pillow. Install "
            "them to decode video sources."
        ) from error
    return imageio, Image
