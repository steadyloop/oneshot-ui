"""Vercel entrypoint for the web application.

The harvesting pipeline remains a separate process.  Importing this module only
constructs the request-facing FastAPI application, which reads and writes the
shared Neon database when an HTTP request requires it.
"""

from pathlib import Path
import os
import sys


FRONTEND_ROOT = Path(__file__).resolve().parent

# Keep this folder runnable before and after it becomes its own repository.  In
# the monorepo the package is available from the sibling source tree; in the
# standalone Vercel project it is installed by requirements.txt instead.
MONOREPO_UI = FRONTEND_ROOT.parent / "xjobscore" / "oneshot-ui"
if MONOREPO_UI.is_dir():
    sys.path.insert(0, str(FRONTEND_ROOT.parent))
    sys.path.insert(0, str(MONOREPO_UI))

# The API normally discovers repo-root/frontend from its source location.  Once
# this folder is a separate repository, the deploy root itself is the client.
os.environ.setdefault("XJOBSCORE_ONESHOT_STATIC_DIR", str(FRONTEND_ROOT))

from oneshot_ui.app import app  # noqa: E402


__all__ = ["app"]
