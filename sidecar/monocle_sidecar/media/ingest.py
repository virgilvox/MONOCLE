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

import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..backends.base import Cancelled

# Still-image extensions accepted in a source directory (matched case-insensitively).
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
# Container extensions routed to the video decoder (matched case-insensitively).
_VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".webm"}

# Never treat "no cancel" as a cost: a callable that is always False.
ShouldCancel = Callable[[], bool]


def _never_cancel() -> bool:
    return False


def ingest_media(
    source: str | Path,
    frames_dir: str | Path,
    max_frames: int | None = None,
    should_cancel: ShouldCancel = _never_cancel,
) -> int:
    """Turn a video file or image directory into a ``frame_%05d.png`` sequence.

    Args:
        source: a directory of still images, or a single video file.
        frames_dir: destination directory for the frames. Created if missing.
        max_frames: optional cap on frames written. When the source has more
            frames than this, they are sampled evenly across the whole span, not
            truncated to the first ``max_frames``.
        should_cancel: polled during decode; when it returns True the ingest
            aborts by raising Cancelled, so a long video can be stopped.

    Returns:
        The number of frames written.

    Raises:
        RuntimeError: the source is missing, empty, unreadable, or an
            unsupported type.
        Cancelled: ``should_cancel`` returned True during the ingest.
    """
    src = Path(source)
    out = Path(frames_dir)
    out.mkdir(parents=True, exist_ok=True)

    if src.is_dir():
        return _ingest_directory(src, out, max_frames, should_cancel)
    if src.is_file():
        if src.suffix.lower() in _VIDEO_EXTENSIONS:
            return _ingest_video(src, out, max_frames, should_cancel)
        raise RuntimeError(
            f"unsupported source file type: {src.suffix or src.name!r} "
            f"(expected one of {sorted(_VIDEO_EXTENSIONS)})"
        )
    raise RuntimeError(f"source does not exist: {src}")


def _natural_key(path: Path) -> list[object]:
    """Sort key that orders embedded numbers numerically, not lexically.

    A folder written as img1.jpg .. img12.jpg must order img2 before img10; a
    plain string sort puts img10 first, silently scrambling the capture order the
    downstream pose track depends on. Splitting into digit and non-digit runs and
    comparing digit runs as ints fixes that, and leaves zero-padded and
    non-numeric names in their existing order.
    """
    return [
        int(token) if token.isdigit() else token
        for token in re.split(r"(\d+)", path.name.lower())
    ]


def _ingest_directory(
    src: Path, out: Path, max_frames: int | None, should_cancel: ShouldCancel
) -> int:
    """Copy a directory's images out as RGB ``frame_%05d.png``, in natural order."""
    Image = _require_pillow()

    paths = sorted(
        (p for p in src.iterdir() if p.is_file() and p.suffix.lower() in _IMAGE_EXTENSIONS),
        key=_natural_key,
    )
    if not paths:
        raise RuntimeError(
            f"no images found in {src} (expected one of {sorted(_IMAGE_EXTENSIONS)})"
        )

    selected = [paths[i] for i in _even_indices(len(paths), max_frames)]
    for index, path in enumerate(selected):
        _check_cancel(should_cancel)
        try:
            image = Image.open(path)
            image.load()
        except Exception as error:
            raise RuntimeError(f"unreadable image: {path}") from error
        image.convert("RGB").save(_frame_path(out, index), format="PNG")
    return len(selected)


def _ingest_video(
    src: Path, out: Path, max_frames: int | None, should_cancel: ShouldCancel
) -> int:
    """Decode a video and write its frames as RGB ``frame_%05d.png``.

    A container's reported frame count is often metadata-derived and disagrees
    with the frames actually decoded (variable frame rate, truncated or streamed
    files), so selection is driven off the true decoded frames, not the reported
    count. When a subset is requested this decodes in two passes: a cheap count of
    the frames that actually decode, then a second pass that writes the evenly
    spaced ones. Only one frame is held in memory at a time, so a long clip never
    materializes.
    """
    imageio, Image = _require_imageio()

    if max_frames is None:
        # Keep every frame: a single streaming pass, no count needed.
        return _decode_all(imageio, Image, src, out, should_cancel)

    total = _count_decoded(imageio, src, should_cancel)
    if total == 0:
        raise RuntimeError(f"no frames decoded from video: {src}")
    wanted = set(_even_indices(total, max_frames))

    reader = _open_reader(imageio, src)
    try:
        written = 0
        for source_index, frame in enumerate(reader):
            _check_cancel(should_cancel)
            if source_index in wanted:
                Image.fromarray(frame).convert("RGB").save(_frame_path(out, written), format="PNG")
                written += 1
    finally:
        reader.close()
    return written


def _decode_all(
    imageio: Any, Image: Any, src: Path, out: Path, should_cancel: ShouldCancel
) -> int:
    """Write every decoded frame in order, one at a time."""
    reader = _open_reader(imageio, src)
    try:
        written = 0
        for frame in reader:
            _check_cancel(should_cancel)
            Image.fromarray(frame).convert("RGB").save(_frame_path(out, written), format="PNG")
            written += 1
    finally:
        reader.close()
    if written == 0:
        raise RuntimeError(f"no frames decoded from video: {src}")
    return written


def _count_decoded(imageio: Any, src: Path, should_cancel: ShouldCancel) -> int:
    """Count the frames that actually decode, ignoring unreliable metadata counts."""
    reader = _open_reader(imageio, src)
    try:
        count = 0
        for _ in reader:
            _check_cancel(should_cancel)
            count += 1
    finally:
        reader.close()
    return count


def _open_reader(imageio: Any, src: Path) -> Any:
    try:
        return imageio.get_reader(str(src))
    except Exception as error:
        raise RuntimeError(f"could not open video: {src}") from error


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


def _check_cancel(should_cancel: ShouldCancel) -> None:
    if should_cancel():
        raise Cancelled()


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
