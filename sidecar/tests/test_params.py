"""Tests for the shared RPC param validation helpers."""

from __future__ import annotations

import pytest

from monocle_sidecar.params import require_depth_window, require_params


def test_missing_key_names_the_method_and_key() -> None:
    with pytest.raises(RuntimeError, match="reconstruct requires 'framesDir'"):
        require_params({"outputDir": "/scans/out"}, "reconstruct", "framesDir", "outputDir")


def test_absent_params_dict_is_treated_as_missing() -> None:
    with pytest.raises(RuntimeError, match="prepareMedia requires 'source'"):
        require_params(None, "prepareMedia", "source", "framesDir")


def test_null_and_empty_values_are_rejected() -> None:
    with pytest.raises(RuntimeError, match="reconstruct requires 'backend'"):
        require_params({"backend": None}, "reconstruct", "backend")
    with pytest.raises(RuntimeError, match="reconstruct requires 'backend'"):
        require_params({"backend": ""}, "reconstruct", "backend")


def test_present_keys_pass() -> None:
    require_params(
        {"backend": "synthetic", "outputDir": "/scans/out"},
        "reconstruct",
        "backend",
        "outputDir",
    )


def test_depth_window_rejects_non_positive_near() -> None:
    with pytest.raises(RuntimeError, match="nearMeters must be greater than 0"):
        require_depth_window(0.0, 0.6)
    with pytest.raises(RuntimeError, match="nearMeters must be greater than 0"):
        require_depth_window(-0.1, 0.6)


def test_depth_window_rejects_inverted_or_degenerate_window() -> None:
    # A swapped window would silently invert depth downstream, so it must fail.
    with pytest.raises(RuntimeError, match="nearMeters must be less than farMeters"):
        require_depth_window(0.7, 0.6)
    with pytest.raises(RuntimeError, match="nearMeters must be less than farMeters"):
        require_depth_window(0.6, 0.6)


def test_depth_window_accepts_the_defaults() -> None:
    require_depth_window(0.2, 0.6)
