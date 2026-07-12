"""The core must stay dependency-free.

health and listBackends run before any extra is installed, so importing the
server (and the registry it builds) must not pull in numpy, torch, OpenCV, or any
other heavy dependency. A fresh subprocess makes the check honest even when those
packages are installed in the test environment.
"""

from __future__ import annotations

import subprocess
import sys


def test_server_import_pulls_in_no_heavy_deps():
    code = (
        "import sys\n"
        "import monocle_sidecar.server\n"
        "from monocle_sidecar.registry import Registry\n"
        "Registry.load().describe_all()\n"
        "heavy = [m for m in ('numpy', 'cv2', 'torch', 'onnxruntime', 'open3d') "
        "if m in sys.modules]\n"
        "assert not heavy, heavy\n"
    )
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
