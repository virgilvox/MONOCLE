"""Depth Anything V2 (Small) backend.

The Small checkpoint is Apache-2.0, which is why it is the default: shippable in
a commercial build where the Base and Large checkpoints (CC-BY-NC) are not. This
module declares its metadata unconditionally; the heavy path raises a clear error
until the `depth` extra and model weights are present, so the app can list and
select it before anything is downloaded.
"""

from __future__ import annotations

from typing import Any

from .base import Backend, Notify, ShouldCancel


class DepthAnythingV2Backend(Backend):
    def reconstruct(
        self, params: dict[str, Any], notify: Notify, should_cancel: ShouldCancel
    ) -> dict[str, Any]:
        try:
            import onnxruntime  # noqa: F401
        except ImportError as error:
            raise RuntimeError(
                "Depth path unavailable: install the 'depth' extra "
                "(pip install -e '.[depth]') and fetch the model weights."
            ) from error

        notify("progress", {"stage": "depth", "ratio": 0.0, "message": "not yet implemented"})
        raise RuntimeError(
            "reconstruct is not implemented in the foundation build. "
            "The depth, fusion, and meshing stages land with the pipeline milestone."
        )
