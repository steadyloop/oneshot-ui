"""Build and persist the current OneShot source-coverage view.

``feed`` and ``job_posting`` remain the source of truth.  This module reduces
them to one replaceable JSON document so serving the public dashboard never
has to repeat the aggregation and a thin deployment needs no pipeline tables.
"""

from __future__ import annotations

import heapq
from datetime import date, datetime, timezone
from typing import TYPE_CHECKING, Any, Iterable, Mapping

if TYPE_CHECKING:
    from asyncpg import Pool


FAILING_STRIKES = 3
STALE_INTERVAL_MULTIPLE = 3
LATEST_FEEDS = 10
LATEST_JOBS = 3


def _iso(value: Any) -> Any:
    return value.isoformat() if isinstance(value, (date, datetime)) else value


def is_display_name(name: str | None) -> bool:
    """A company name fit for the public card, not a token slug.

    Keyscan imports name thousands of companies after their token (``pwc``,
    ``edsv.fa.us2``), reviewed or not, so the verdict cannot tell them apart.
    """
    return (
        bool(name)
        and any(character.isupper() for character in name)
        and not any(character in "./_" for character in name)
    )


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
                "added_today": 0,
                "companies_added_today": 0,
            },
            "latest_jobs": [],
            "new_feeds": {"latest": []},
        },
    }


_CURRENT_ROWS_SQL = """
WITH posting_stats AS (
    SELECT
        source,
        COUNT(*) FILTER (WHERE status = 'active') AS coverage,
        COUNT(*) FILTER (
            WHERE first_seen_at >= date_trunc('day', $1::timestamptz)
        ) AS added_today
    FROM job_posting
    GROUP BY source
), global_stats AS (
    SELECT COUNT(*) FILTER (
        WHERE first_seen_at >= date_trunc('day', $1::timestamptz)
    ) AS added_today
    FROM job_posting
)
SELECT
    f.source,
    f.key,
    f.polling,
    f.strikes,
    f.last_poll_at,
    f.paused_at,
    f.interval_s,
    f.due_at,
    f.hold_until,
    t.company_id,
    c.name AS company_name,
    c.reviewed = 'verified' AS verified,
    -- Pacific, the zone the pipeline's clock runs in; the card shows the day only.
    (t.discovered_at AT TIME ZONE 'America/Los_Angeles')::date AS discovered_on,
    COALESCE(p.coverage, 0) AS coverage,
    COALESCE(p.added_today, 0) AS added_today,
    g.added_today AS global_added_today
FROM global_stats g
LEFT JOIN feed f ON true
LEFT JOIN token t ON t.ats = f.source AND t.token = f.key
LEFT JOIN company c ON c.id = t.company_id
LEFT JOIN posting_stats p ON p.source = f.source || ':' || f.key
ORDER BY f.source, f.key
"""

# A day's window keeps the sort off the full table. Feeds land postings in
# batches, so the 60 newest collapse to a few companies once each keeps one.
_LATEST_JOBS_SQL = """
SELECT c.name AS company_name, j.title, j.first_seen_at
FROM job_posting j
JOIN company c ON c.id = j.company_id
LEFT JOIN job_posting_dup_group g ON g.id = j.dup_group_id
WHERE j.status = 'active'
  AND j.first_seen_at >= $1::timestamptz - interval '1 day'
  AND (
      g.primary_posting_id IS NULL
      OR g.state = 'rejected'
      OR g.primary_posting_id = j.id
  )
ORDER BY j.first_seen_at DESC, j.id DESC
LIMIT 60
"""


def build_snapshot(
    rows: Iterable[Mapping[str, Any]],
    *,
    computed_at: datetime,
    latest_jobs: Iterable[Mapping[str, Any]] = (),
) -> dict[str, Any]:
    """Reduce one consistent query result to the two existing API payloads."""
    source_rows: dict[str, dict[str, Any]] = {}
    providers: dict[str, dict[str, Any]] = {}
    state_totals = {
        "ok": 0,
        "erroring": 0,
        "stale": 0,
        "paused": 0,
        "never": 0,
    }
    global_added_today = 0
    # One entry per company: tenants such as Workday split one employer into
    # several feeds, and the card should not list it twice.
    discovered: dict[str, tuple[date, bool, int, str, str]] = {}
    # Same reasoning for the day's count: a feed with no linked company
    # stands in for itself.
    companies_added_today: set[Any] = set()

    for row in rows:
        global_added_today = int(row["global_added_today"] or 0)
        if row["source"] is None:
            continue
        source = str(row["source"])
        polling = bool(row["polling"])
        coverage = int(row["coverage"] or 0)
        added_today = int(row["added_today"] or 0)
        summary = source_rows.setdefault(
            source,
            {
                "source": source,
                "type": "ATS",
                "board_count": 0,
                "polled_count": 0,
                "attention_count": 0,
                "last_poll_at": None,
                "coverage": 0,
                "added_today": 0,
            },
        )
        summary["coverage"] += coverage
        summary["added_today"] += added_today
        if added_today:
            companies_added_today.add(row.get("company_id") or f"{source}:{row['key']}")
        if not polling:
            continue
        if row.get("discovered_on") is not None and is_display_name(row["company_name"]):
            company = row["company_name"]
            entry = (row["discovered_on"], bool(row.get("verified")), coverage, company, source)
            discovered[company] = max(discovered.get(company, entry), entry)

        summary["board_count"] += 1
        last_poll_at = row["last_poll_at"]
        if last_poll_at is not None:
            summary["polled_count"] += 1
            if summary["last_poll_at"] is None or last_poll_at > summary["last_poll_at"]:
                summary["last_poll_at"] = last_poll_at
        hold_until = row["hold_until"]
        overdue = row["due_at"] < computed_at and (
            hold_until is None or hold_until < computed_at
        )
        if row["paused_at"] is None and (int(row["strikes"] or 0) > 0 or overdue):
            summary["attention_count"] += 1

        state = board_state(
            row["strikes"],
            last_poll_at,
            row["paused_at"],
            int(row["interval_s"] or 0),
            computed_at,
        )
        state_totals[
            "erroring" if state in {"failing", "degraded"} else state
        ] += 1
        provider = providers.setdefault(
            source,
            {"source": source, "board_count": 0, "err_count": 0, "boards": []},
        )
        provider["board_count"] += 1
        if state in {"failing", "degraded"}:
            provider["err_count"] += 1
        provider["boards"].append(
            {
                "key": row["key"],
                "company": row["company_name"] or row["key"],
                "state": state,
                "strikes": int(row["strikes"] or 0),
                "last_poll_at": _iso(last_poll_at),
                "coverage": coverage,
            }
        )

    sources = []
    for summary in source_rows.values():
        board_count = summary.pop("board_count")
        polled_count = summary.pop("polled_count")
        attention_count = summary.pop("attention_count")
        if board_count == 0:
            health = "Disabled"
        elif polled_count == 0:
            health = "Not polled"
        elif attention_count:
            health = "Needs attention"
        elif polled_count < board_count:
            health = "Partial"
        else:
            health = "Healthy"
        summary["board_count"] = board_count
        summary["last_poll_at"] = _iso(summary["last_poll_at"])
        summary["health"] = health
        sources.append(summary)
    sources.sort(key=lambda item: (-item["coverage"], item["source"]))

    ordered_providers = sorted(
        providers.values(), key=lambda item: (-item["board_count"], item["source"])
    )
    # Newest first, one posting per company: a feed lands its postings as a
    # batch, and three from one employer would read as one example, not three.
    jobs: list[dict[str, Any]] = []
    seen_companies: set[str] = set()
    for job in latest_jobs:
        company = job["company_name"]
        if not is_display_name(company) or company in seen_companies:
            continue
        seen_companies.add(company)
        jobs.append(
            {
                "company": company,
                "title": job["title"],
                "first_seen_at": _iso(job["first_seen_at"]),
            }
        )
        if len(jobs) == LATEST_JOBS:
            break
    return {
        "source_coverage": {
            "sources": sources,
            "source_count": len(sources),
            "total_coverage": sum(item["coverage"] for item in sources),
            "total_added_today": sum(item["added_today"] for item in sources),
        },
        "board_map": {
            "providers": ordered_providers,
            "totals": {
                "boards": sum(item["board_count"] for item in ordered_providers),
                "providers": len(ordered_providers),
                **state_totals,
                "added_today": global_added_today,
                "companies_added_today": len(companies_added_today),
            },
            "latest_jobs": jobs,
            # Bulk imports stamp thousands of feeds with one day, so ties go to
            # a reviewed name, then the most active postings.
            "new_feeds": {
                "latest": [
                    {"company": company, "source": source, "added_on": on.isoformat()}
                    for on, _, _, company, source in heapq.nlargest(
                        LATEST_FEEDS, discovered.values()
                    )
                ]
            },
        },
    }


async def refresh(pool: Pool, *, computed_at: datetime | None = None) -> dict[str, Any]:
    """Replace the singleton snapshot from the pipeline's current tables."""
    now = computed_at or datetime.now(timezone.utc)
    async with pool.acquire() as conn:
        rows = await conn.fetch(_CURRENT_ROWS_SQL, now)
        latest_jobs = await conn.fetch(_LATEST_JOBS_SQL, now)
        payload = build_snapshot(rows, computed_at=now, latest_jobs=latest_jobs)
        await conn.execute(
            """
            INSERT INTO coverage_snapshot (id, payload, computed_at)
            VALUES (true, $1::jsonb, $2)
            ON CONFLICT (id) DO UPDATE
            SET payload = EXCLUDED.payload,
                computed_at = EXCLUDED.computed_at
            WHERE coverage_snapshot.computed_at <= EXCLUDED.computed_at
            """,
            payload,
            now,
        )
    return payload
