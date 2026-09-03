"""Build and persist the current OneShot source-coverage view.

``feed`` and ``job_posting`` remain the source of truth.  This module reduces
them to one replaceable JSON document so serving the public dashboard never
has to repeat the aggregation and a thin deployment needs no pipeline tables.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import TYPE_CHECKING, Any, Iterable, Mapping

if TYPE_CHECKING:
    from asyncpg import Pool


FAILING_STRIKES = 3
STALE_INTERVAL_MULTIPLE = 3


def _iso(value: Any) -> Any:
    return value.isoformat() if isinstance(value, (date, datetime)) else value


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
            },
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
    c.name AS company_name,
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


def build_snapshot(
    rows: Iterable[Mapping[str, Any]], *, computed_at: datetime
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
        if not polling:
            continue

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
            },
        },
    }


async def refresh(pool: Pool, *, computed_at: datetime | None = None) -> dict[str, Any]:
    """Replace the singleton snapshot from the pipeline's current tables."""
    now = computed_at or datetime.now(timezone.utc)
    async with pool.acquire() as conn:
        rows = await conn.fetch(_CURRENT_ROWS_SQL, now)
        payload = build_snapshot(rows, computed_at=now)
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
