"""Stage a dropped-in video or image folder into reconstruction-ready keyframes.

This is the one composition step the drop-in reconstruction path needs: it ingests
the source (:mod:`monocle_sidecar.media.ingest`) and then selects a bounded set of
sharp, well-spread keyframes (:mod:`monocle_sidecar.media.selection`), writing them
into a frames directory as ``frame_%05d.png``. Every reconstruction backend already
reads that sequence, so imported media flows through the same engine as a live
capture with no backend changes.

The two stages are deliberate. Ingest samples a generous, evenly spaced candidate
set so a long video is never fully decoded; selection then keeps the sharpest frame
in each temporal bucket, so the final set is both spread out and in focus.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from .ingest import ShouldCancel, _never_cancel, ingest_media
from .selection import select_keyframes

# Candidate frames ingested per requested keyframe before sharpness selection. A
# few candidates per bucket give selection something to choose the sharpest from
# without decoding an entire clip.
_OVERSAMPLE = 3


def prepare_media(
    source: str | Path,
    frames_dir: str | Path,
    max_frames: int | None = None,
    oversample: int = _OVERSAMPLE,
    should_cancel: ShouldCancel = _never_cancel,
) -> int:
    """Ingest ``source`` and stage sharp, spread keyframes into ``frames_dir``.

    Args:
        source: a video file or a directory of images.
        frames_dir: destination for the selected ``frame_%05d.png`` keyframes.
            Created if missing.
        max_frames: keyframe budget. When None, every ingested frame is kept and
            no sharpness selection runs (the caller wants them all).
        oversample: candidate frames to ingest per kept keyframe before selection.
        should_cancel: polled during the ingest so a long decode can be stopped.

    Returns:
        The number of keyframes written into ``frames_dir``.

    Raises:
        RuntimeError: propagated from ingest for an empty or unreadable source.
        Cancelled: ``should_cancel`` returned True during the ingest.
    """
    frames_dir = Path(frames_dir)
    frames_dir.mkdir(parents=True, exist_ok=True)

    # No budget: ingest straight into the destination, nothing to select.
    if max_frames is None or max_frames <= 0:
        return ingest_media(source, frames_dir, should_cancel=should_cancel)

    # Stage candidates next to the destination (same filesystem, cheap to move),
    # select the sharpest, and copy those in renumbered. The staging directory is
    # always removed, success or failure.
    staging = Path(tempfile.mkdtemp(prefix="monocle-media-", dir=frames_dir.parent))
    try:
        ingest_media(
            source,
            staging,
            max_frames=max_frames * max(1, oversample),
            should_cancel=should_cancel,
        )
        candidates = sorted(staging.glob("frame_*.png"))
        selected = select_keyframes(candidates, max_frames)
        return _stage_selected(selected, frames_dir)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _stage_selected(selected: list[Path], frames_dir: Path) -> int:
    """Copy the selected keyframes into ``frames_dir``, renumbered from zero."""
    for index, path in enumerate(selected):
        shutil.copyfile(path, frames_dir / f"frame_{index:05d}.png")
    return len(selected)
