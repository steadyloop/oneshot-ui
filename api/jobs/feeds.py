"""The feeds overview: the pipeline's published coverage snapshot, plus today's activity.

Today is a Pacific calendar day. A closure is the earliest ATS, dead-link or
closed-page signal; missing from a board alone is not one. Nothing is written.
"""

import asyncio
import logging
from datetime import datetime, timezone
from time import monotonic
from typing import Any
from zoneinfo import ZoneInfo

import asyncpg

from ..db import iso, json_as
from .listing import DEFAULT_JOB_TYPES, UNCLASSIFIED
from .locations import RECENCY_TIME_ZONE

log = logging.getLogger(__name__)

ACTIVITY_SQL = """
WITH representatives AS MATERIALIZED (
    SELECT g.id, member.id AS posting_id
    FROM job_posting_dup_group g
    JOIN LATERAL (
        SELECT j.id
        FROM job_posting j
        WHERE j.dup_group_id = g.id
        ORDER BY
            (j.status = 'active') DESC,
            (j.id = g.primary_posting_id) DESC,
            COALESCE(j.posted_at, j.first_seen_at) DESC,
            j.id DESC
        LIMIT 1
    ) member ON true
    WHERE g.primary_posting_id IS NOT NULL AND g.state <> 'rejected'
), postings AS (
    SELECT j.*,
        (r.posting_id IS NULL OR r.posting_id = j.id) AS representative,
        LEAST(j.ats_closed_at, j.linked_dead_at, j.paged_closed_at) AS closed_at
    FROM job_posting j
    LEFT JOIN representatives r ON r.id = j.dup_group_id
)
SELECT COALESCE(job_type, 'unclassified') AS job_type,
    split_part(source, ':', 1) AS provider,
    COUNT(*) FILTER (WHERE status = 'active') AS total,
    COUNT(*) FILTER (
        WHERE representative AND first_seen_at >= $1 AND first_seen_at <= $2
    ) AS appeared,
    COUNT(*) FILTER (
        WHERE representative AND status = 'closed'
          AND closed_at >= $1 AND closed_at <= $2
    ) AS closed,
    COUNT(*) FILTER (
        WHERE representative AND status = 'active' AND job_type IS NOT NULL
          AND (locations = '[]'::jsonb OR locations @> '[{"country":"US"}]'::jsonb)
    ) AS student_roles
FROM postings
GROUP BY job_type, split_part(source, ':', 1)
"""


def activity_payload(rows: Any, computed_at: datetime) -> dict[str, Any]:
    appeared = dict.fromkeys((*DEFAULT_JOB_TYPES, UNCLASSIFIED), 0)
    closed = dict(appeared)
    total = students = 0
    provider_discover_counts: dict[str, int] = {}
    for row in rows:
        appeared[row["job_type"]] += int(row["appeared"])
        closed[row["job_type"]] += int(row["closed"])
        total += int(row["total"])
        students += int(row["student_roles"])
        provider = row["provider"]
        provider_discover_counts[provider] = provider_discover_counts.get(provider, 0) + int(row["student_roles"])
    return {
        "classification": {"total": total, "student_roles": students},
        "provider_discover_counts": provider_discover_counts,
        "today_breakdown": {
            "total": sum(appeared.values()),
            "types": appeared,
            "disappeared": {"total": sum(closed.values()), "types": closed},
            "computed_at": computed_at.isoformat(),
            "time_zone": RECENCY_TIME_ZONE,
        },
    }


class FeedActivityCache:
    """One five-minute aggregate per Pacific day, shared by every reader and computed once."""

    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.day = None
        self.expires_at = 0.0
        self.payload: dict[str, Any] | None = None

    def _fresh(self, day: Any) -> bool:
        return self.payload is not None and self.day == day and monotonic() < self.expires_at

    async def get(self, pool: Any) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        local = now.astimezone(ZoneInfo(RECENCY_TIME_ZONE))
        if self._fresh(local.date()):
            return self.payload
        async with self.lock:
            if not self._fresh(local.date()):
                start = local.replace(hour=0, minute=0, second=0, microsecond=0)
                rows = await pool.fetch(ACTIVITY_SQL, start, now, timeout=6)
                self.payload, self.day, self.expires_at = activity_payload(rows, now), local.date(), monotonic() + 300
            return self.payload


activity = FeedActivityCache()


def empty_snapshot() -> dict[str, Any]:
    """The published shape before the pipeline's first refresh."""
    return {
        "source_coverage": {"sources": [], "source_count": 0, "total_coverage": 0, "total_added_today": 0},
        "board_map": {
            "providers": [],
            "totals": {
                "boards": 0, "providers": 0, "ok": 0, "erroring": 0, "stale": 0, "paused": 0, "never": 0,
                "active_postings": 0, "added_today": 0, "companies_added_today": 0,
            },
            "latest_jobs": [],
            "new_feeds": {"latest": []},
        },
    }


async def _published(pool: Any, section: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """The newest snapshot, and a copy of one section stamped with its computed_at."""
    row = await pool.fetchrow("SELECT payload, computed_at FROM coverage_snapshot ORDER BY computed_at DESC LIMIT 1")
    snapshot = empty_snapshot() if row is None else json_as(row["payload"], dict)
    payload = snapshot.get(section)
    result = dict(payload) if isinstance(payload, dict) else empty_snapshot()[section]
    result["computed_at"] = None if row is None else iso(row["computed_at"])
    return snapshot, result


async def source_coverage(pool: Any) -> dict[str, Any]:
    return (await _published(pool, "source_coverage"))[1]


async def board_map(pool: Any) -> dict[str, Any]:
    snapshot, result = await _published(pool, "board_map")
    # Fleet size is the pipeline's count, not the published student subset. Older
    # snapshots predate it; their source coverage still counts the whole pipeline.
    totals = dict(result.get("totals", {}))
    pipeline_total = totals.get("active_postings")
    if type(pipeline_total) is not int or pipeline_total < 0:
        pipeline_total = snapshot.get("source_coverage", {}).get("total_coverage")
    if type(pipeline_total) is int and pipeline_total >= 0:
        totals["active_postings"] = pipeline_total
    else:
        pipeline_total = None
        totals.pop("active_postings", None)
    result["totals"] = totals
    try:
        today = await activity.get(pool)
    except (asyncpg.PostgresError, TimeoutError):
        # Keep the heatmap; an unknown closure count must never read as zero.
        log.warning("Feed activity aggregation unavailable", exc_info=True)
        return result
    result.update(today)
    if pipeline_total is None:
        result.pop("classification", None)  # the subset is no stand-in for an unknown total
    else:
        result["classification"] = {**today["classification"], "total": pipeline_total}
    result["providers"] = [
        {**provider, "discover_jobs": today["provider_discover_counts"].get(provider["source"], 0)}
        for provider in result.get("providers", [])
    ]
    result["totals"] = {
        **result.get("totals", {}),
        "added_today": today["today_breakdown"]["total"],
        "disappeared_today": today["today_breakdown"]["disappeared"]["total"],
    }
    return result
