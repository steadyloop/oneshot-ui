"""Vercel entrypoint for the web application.

The harvesting pipeline remains a separate process.  Importing this module only
constructs the request-facing FastAPI application, which reads and writes the
shared Neon database when an HTTP request requires it.
"""

from pathlib import Path
import os


FRONTEND_ROOT = Path(__file__).resolve().parent

# The deploy root itself contains the browser client.
os.environ.setdefault("ONESHOT_STATIC_DIR", str(FRONTEND_ROOT))

from oneshot_ui.app import app  # noqa: E402


__all__ = ["app"]
