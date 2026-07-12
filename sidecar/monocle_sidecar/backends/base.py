"""The narrow interface every reconstruction backend implements.

Keeping the surface small (describe, reconstruct) is what lets the pipeline stay
model-agnostic: a new model is a new module plus a models.toml entry, never a
change to the server or fusion code.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Callable

# Emit a progress or log notification to the app.
Notify = Callable[[str, dict[str, Any]], None]
# Poll for cooperative cancellation; a backend should check it between stages.
ShouldCancel = Callable[[], bool]


class Cancelled(Exception):
    """Raised by a backend when it observes cancellation and stops early."""


@dataclass(frozen=True)
class BackendConfig:
    id: str
    label: str
    module: str
    license: str
    commercial_use: bool
    mono: bool
    multiview: bool
    needs_poses: bool
    device: str
    dtype: str


def require_mesh_output(params: dict[str, Any]) -> None:
    """Reject a non-mesh output on a backend that only produces meshes.

    Only the Depth Anything 3 multi-view backend exports the native point cloud,
    COLMAP, and Gaussian outputs. Every other backend fuses a mesh, so a request
    for another output kind is surfaced plainly rather than silently returning a
    mesh the caller did not ask for. `mesh` (the default) and an absent output
    both pass.
    """
    output = str(params.get("output", "mesh"))
    if output != "mesh":
        raise RuntimeError(
            f"this backend only produces a mesh; output '{output}' is available "
            f"only on the Depth Anything 3 multi-view backend"
        )


def backend_info(config: BackendConfig) -> dict[str, Any]:
    """The BackendInfo shape the app expects, mirroring @monoclejs/protocol.

    Single source of truth so the registry and Backend.describe cannot drift.
    """
    return {
        "id": config.id,
        "label": config.label,
        "license": config.license,
        "commercialUse": config.commercial_use,
        "capabilities": {
            "mono": config.mono,
            "multiview": config.multiview,
            "needsPoses": config.needs_poses,
        },
    }


class Backend(ABC):
    def __init__(self, config: BackendConfig) -> None:
        self.config = config

    def describe(self) -> dict[str, Any]:
        return backend_info(self.config)

    @abstractmethod
    def reconstruct(
        self, params: dict[str, Any], notify: Notify, should_cancel: ShouldCancel
    ) -> dict[str, Any]:
        """Read frames from params['framesDir'], write a mesh to params['outputDir'],
        and return a ReconstructResult. Check should_cancel between stages and raise
        Cancelled to stop early."""
        raise NotImplementedError
