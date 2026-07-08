"""Loads the backend registry from models.toml.

Metadata is read without importing any model module; the module named in each
entry is imported lazily the first time a backend is needed for reconstruction.
"""

from __future__ import annotations

import importlib
import tomllib
from pathlib import Path
from typing import Any

from .backends.base import Backend, BackendConfig, backend_info

_MODELS_FILE = Path(__file__).with_name("models.toml")


class Registry:
    def __init__(self, configs: list[BackendConfig]) -> None:
        self._configs = {config.id: config for config in configs}
        self._instances: dict[str, Backend] = {}

    @classmethod
    def load(cls, path: Path = _MODELS_FILE) -> "Registry":
        data = tomllib.loads(path.read_text(encoding="utf-8"))
        configs = [_parse_config(entry) for entry in data.get("backend", [])]
        return cls(configs)

    def describe_all(self) -> list[dict[str, Any]]:
        return [backend_info(config) for config in self._configs.values()]

    def instantiate(self, backend_id: str) -> Backend:
        if backend_id in self._instances:
            return self._instances[backend_id]
        config = self._configs.get(backend_id)
        if config is None:
            raise KeyError(f"unknown backend: {backend_id}")
        backend = _import_backend(config)
        self._instances[backend_id] = backend
        return backend


def _parse_config(entry: dict[str, Any]) -> BackendConfig:
    return BackendConfig(
        id=entry["id"],
        label=entry["label"],
        module=entry["module"],
        license=entry["license"],
        commercial_use=bool(entry["commercial_use"]),
        mono=bool(entry.get("mono", False)),
        multiview=bool(entry.get("multiview", False)),
        needs_poses=bool(entry.get("needs_poses", False)),
        device=entry.get("device", "auto"),
        dtype=entry.get("dtype", "fp32"),
    )


def _import_backend(config: BackendConfig) -> Backend:
    # config.module is "package.module:ClassName".
    module_path, _, class_name = config.module.partition(":")
    module = importlib.import_module(module_path)
    backend_class = getattr(module, class_name)
    return backend_class(config)
