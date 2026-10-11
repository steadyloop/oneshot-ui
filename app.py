"""Vercel entrypoint: the FastAPI app, which also serves web/."""

from api.app import app

__all__ = ["app"]
