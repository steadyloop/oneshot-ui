"""Serving defaults and board status for published coverage snapshots."""

from datetime import datetime
from typing import Any

FAILING_STRIKES = 3
STALE_INTERVAL_MULTIPLE = 3


def board_state(
    strikes: int,
    last_poll_at: datetime | None,
    paused_at: datetime | None,
    interval_s: int,
    now: datetime,
) -> str:
    """Classify one polling feed for the fleet heatmap."""
    if paused_at is not None:
        return "paused"
    strikes = int(strikes or 0)
    if strikes >= FAILING_STRIKES:
        return "failing"
    if strikes > 0:
        return "degraded"
    if last_poll_at is None:
        return "never"
    if interval_s and (
        now - last_poll_at
    ).total_seconds() > STALE_INTERVAL_MULTIPLE * interval_s:
        return "stale"
    return "ok"


def empty_snapshot() -> dict[str, Any]:
    """The stable API shape before the first pipeline refresh."""
    return {
        "source_coverage": {
            "sources": [],
            "source_count": 0,
            "total_coverage": 0,
            "total_added_today": 0,
        },
        "board_map": {
            "providers": [],
            "totals": {
                "boards": 0,
                "providers": 0,
                "ok": 0,
                "erroring": 0,
                "stale": 0,
                "paused": 0,
                "never": 0,
                "active_postings": 0,
                "added_today": 0,
                "companies_added_today": 0,
            },
            "latest_jobs": [],
            "new_feeds": {"latest": []},
        },
    }

