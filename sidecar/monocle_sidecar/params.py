"""Validation for RPC request params, shared by the server handlers and backends.

JSON-RPC params arrive as a plain dict from the app. Indexing a missing key
surfaces as a bare KeyError whose message is just the key name, which is useless
in a field log; these helpers turn the common cases into RuntimeErrors that name
the method and what it needs.
"""

from __future__ import annotations

from typing import Any


def require_params(params: dict[str, Any] | None, method: str, *keys: str) -> None:
    """Raise RuntimeError naming ``method`` and the first missing key.

    A key counts as missing when the params dict is absent, the key is not
    present, or its value is null or an empty string (every required param here
    is a path, an id, or a backend name, so an empty value is never usable).
    """
    for key in keys:
        value = (params or {}).get(key)
        if value is None or value == "":
            raise RuntimeError(f"{method} requires '{key}'")


def require_depth_window(near: float, far: float) -> None:
    """Reject a metric depth window that would invert or degenerate the depth.

    The single-view depth backend maps normalised disparity into ``near..far``
    assuming ``0 < near < far``. A swapped window does not fail there: it
    silently inverts the depth (near surfaces land far), so it is rejected here
    with a message naming both values.
    """
    if near <= 0:
        raise RuntimeError(f"nearMeters must be greater than 0, got {near}")
    if near >= far:
        raise RuntimeError(
            f"nearMeters must be less than farMeters, got near={near}, far={far}"
        )
