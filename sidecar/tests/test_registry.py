"""Tests for the backend registry: lookup errors, caching, and thread safety."""

from __future__ import annotations

import threading
import time

import pytest

from monocle_sidecar import registry as registry_module
from monocle_sidecar.registry import Registry


def test_unknown_backend_raises_with_the_id_named() -> None:
    registry = Registry.load()
    with pytest.raises(KeyError, match="unknown backend: nope"):
        registry.instantiate("nope")


def test_instantiate_caches_one_instance_per_backend() -> None:
    registry = Registry.load()
    first = registry.instantiate("synthetic")
    second = registry.instantiate("synthetic")
    assert first is second


def test_concurrent_instantiate_builds_the_backend_once(monkeypatch) -> None:
    # Reconstruct requests run on worker threads, so two racing requests must
    # not each import and construct the same backend. The slow import widens the
    # race window; without the registry lock this reliably double-builds.
    registry = Registry.load()
    calls: list[str] = []
    real_import = registry_module._import_backend

    def slow_import(config):  # type: ignore[no-untyped-def]
        calls.append(config.id)
        time.sleep(0.05)
        return real_import(config)

    monkeypatch.setattr(registry_module, "_import_backend", slow_import)

    results: list[object] = [None] * 4

    def work(slot: int) -> None:
        results[slot] = registry.instantiate("synthetic")

    threads = [threading.Thread(target=work, args=(slot,)) for slot in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert calls == ["synthetic"]
    assert all(result is results[0] for result in results)
