"""Presentation of official websites, including companies sharing a domain."""

from typing import Any
from urllib.parse import urlsplit


def company_website(domain: str | None, tags: dict[str, Any]) -> str | None:
    resolution = tags.get("company_resolution")
    official = resolution.get("website") if isinstance(resolution, dict) else None
    candidates = [official, f"https://{domain}" if domain else None]
    for candidate in candidates:
        if not isinstance(candidate, str) or any(c.isspace() or ord(c) < 32 for c in candidate):
            continue
        try:
            url = urlsplit(candidate)
            if url.scheme in ("http", "https") and url.hostname and not url.username and not url.password:
                # Accessing port also rejects malformed URLs.
                url.port
                return candidate
        except ValueError:
            continue
    return None
