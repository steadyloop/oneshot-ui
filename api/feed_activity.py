"""Read-only, account-independent aggregates for the feed overview.

Today is a Pacific calendar day. Closure time is the earliest recorded ATS,
dead-link or closed-page signal; a missing-from-board signal alone is not a
closure. No posting records are changed by this reader.
"""

import asyncio
from datetime import datetime, timezone
from time import monotonic
from typing import Any
from zoneinfo import ZoneInfo

from .location_policy import RECENCY_TIME_ZONE


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

JOB_TYPES = ("intern", "coop", "student", "new_grad", "research", "unclassified")


def activity_payload(rows: Any, computed_at: datetime) -> dict[str, Any]:
    appeared = dict.fromkeys(JOB_TYPES, 0)
    closed = dict.fromkeys(JOB_TYPES, 0)
    total = students = 0
    provider_discover_counts: dict[str, int] = {}
    for row in rows:
        key = row["job_type"]
        appeared[key] += int(row["appeared"])
        closed[key] += int(row["closed"])
        total += int(row["total"])
        students += int(row["student_roles"])
        provider = row["provider"]
        provider_discover_counts[provider] = (
            provider_discover_counts.get(provider, 0) + int(row["student_roles"])
        )
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
    """Share a five-minute aggregate and one in-flight query across readers."""

    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.expires_at = 0.0
        self.day = None
        self.payload: dict[str, Any] | None = None

    async def get(self, pool: Any) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        local = now.astimezone(ZoneInfo(RECENCY_TIME_ZONE))
        day = local.date()
        if self.payload is not None and self.day == day and monotonic() < self.expires_at:
            return self.payload
        async with self.lock:
            if self.payload is not None and self.day == day and monotonic() < self.expires_at:
                return self.payload
            start = local.replace(hour=0, minute=0, second=0, microsecond=0)
            rows = await pool.fetch(ACTIVITY_SQL, start, now, timeout=6)
            self.payload = activity_payload(rows, now)
            self.day = day
            self.expires_at = monotonic() + 300
            return self.payload
