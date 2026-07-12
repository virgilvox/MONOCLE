"""Keyframe selection: choose a bounded set of sharp, well-spread frames.

Video and dense image folders hold far more frames than a reconstruction needs,
and many are motion-blurred or near-duplicates of their neighbours. This module
picks a small subset that stays spread across the sequence (so coverage is even)
while dropping the blurry frames (so each pick is worth meshing).

It generalises the single-frame ``_pick_sharpest`` heuristic in the Depth
Anything V2 backend: the same 4-neighbour Laplacian-variance focus measure, run
per frame, using only numpy and PIL. The selector is pure and deterministic and
knows nothing about any reconstruction backend, so ingestion and live capture
can both route their frames through it before handing off.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable, Sequence

_DEPS_HINT = (
    "Keyframe selection needs numpy and pillow: install the 'depth' extra "
    "(pip install -e '.[depth]')."
)


def _require_deps() -> tuple[Any, Any]:
    """Import numpy and PIL.Image, raising one clear error if either is missing."""
    try:
        import numpy as np
        from PIL import Image
    except ImportError as error:
        raise RuntimeError(_DEPS_HINT) from error
    return np, Image


def variance_of_laplacian(np: Any, gray: Any) -> float:
    """Return the variance of a grayscale image's Laplacian, a focus measure.

    The Laplacian is a 4-neighbour discrete approximation computed by array
    slicing, so no opencv or scipy is required. A sharp, high-frequency frame
    yields a large variance; a blurred or flat frame yields a small one. This is
    the same metric the depth backend uses to pick its single sharpest frame.

    Args:
        np: The numpy module.
        gray: A 2-D array of grayscale intensities.

    Returns:
        The Laplacian variance. Arrays smaller than 3x3, which have no interior
        pixel, fall back to the plain intensity variance.
    """
    if gray.shape[0] < 3 or gray.shape[1] < 3:
        return float(gray.var())
    center = gray[1:-1, 1:-1]
    laplacian = (
        4.0 * center
        - gray[:-2, 1:-1]
        - gray[2:, 1:-1]
        - gray[1:-1, :-2]
        - gray[1:-1, 2:]
    )
    return float(laplacian.var())


def sharpness_scores(paths: Sequence[Path | str]) -> list[float]:
    """Compute the focus measure of each image, in input order.

    Each frame is opened, converted to grayscale, and scored with
    :func:`variance_of_laplacian`. Loading dominates the cost, so scoring is a
    single pass with no image kept in memory beyond its own iteration.

    Args:
        paths: Ordered image file paths.

    Returns:
        One sharpness score per path, aligned to the input order.
    """
    np, Image = _require_deps()
    scores: list[float] = []
    for path in paths:
        gray = np.asarray(Image.open(path).convert("L"), dtype=np.float64)
        scores.append(variance_of_laplacian(np, gray))
    return scores


def select_keyframes(
    paths: Sequence[Path | str], target: int, min_gap: int = 1
) -> list[Path]:
    """Select up to ``target`` sharp, evenly spread keyframes.

    The ordered input is split into ``target`` contiguous buckets of near-equal
    length, and the sharpest frame in each bucket is kept. Bucketing keeps the
    picks spread across the whole sequence; sharpest-in-bucket drops the blur.
    Picks come from distinct buckets, so the result preserves input order and
    never repeats a frame.

    Args:
        paths: Ordered image file paths to choose from.
        target: Maximum number of keyframes to return.
        min_gap: Minimum index distance required between consecutive picks. The
            default of 1 imposes no constraint beyond distinct frames. A larger
            gap enforces extra spacing: within a bucket the selector falls to the
            next-sharpest frame that satisfies the gap, and skips the bucket if
            none does, so the result can hold fewer than ``target`` frames.

    Returns:
        The selected paths as :class:`~pathlib.Path`, in input order. Empty input
        or ``target <= 0`` returns an empty list; when the input has at most
        ``target`` frames every frame is returned unchanged.
    """
    items = [Path(p) for p in paths]
    if target <= 0 or not items:
        return []
    if len(items) <= target:
        return items

    scores = sharpness_scores(items)
    gap = max(1, min_gap)

    selected: list[Path] = []
    last_index = -gap  # so the first pick is never rejected by the gap test.
    n = len(items)
    for bucket in range(target):
        start = bucket * n // target
        end = (bucket + 1) * n // target
        # Sharpest first; ties resolve to the earlier index to stay deterministic.
        order = sorted(range(start, end), key=lambda i: (-scores[i], i))
        for index in order:
            if index - last_index >= gap:
                selected.append(items[index])
                last_index = index
                break
    return selected
