"""The Discover feed: one SQL builder for its filters, tab counts and ordering.

Postings are read as the xjobscore pipeline published them; nothing is classified
again per request. Duplicate groups show one representative posting.
"""

import asyncio
from typing import Any, Iterable
from uuid import UUID

from ..db import Db, ilike
from ..taxonomy import (
    BIOENGINEERING_FILTER, FINANCE_FILTER, FOCUS_FILTERS, SOFTWARE_FILTER, UNLABELED_FILTER,
    degree_fields, skill_ids_matching,
)
from .locations import (
    RECENCY_TIME_ZONE, US_HUB_KEYS, US_NORCAL_KEYS, US_SEATTLE_KEYS, US_SOCAL_KEYS, US_SUBURB_KEYS,
)
from .present import JOB_COLUMNS, job

DEFAULT_JOB_TYPES = ("intern", "coop", "student", "new_grad", "research")
UNCLASSIFIED = "unclassified"  # the API's name for the NULL job_type pool
VALID_JOB_TYPES = frozenset((*DEFAULT_JOB_TYPES, UNCLASSIFIED))
DOMAIN_FILTERS = (SOFTWARE_FILTER, FINANCE_FILTER, UNLABELED_FILTER)
VALID_DEGREE_FIELDS = frozenset({*degree_fields(), BIOENGINEERING_FILTER, *DOMAIN_FILTERS})

TABLES = """
    FROM job_posting j
    JOIN company c ON c.id = j.company_id
    LEFT JOIN job_posting_dup_group g ON g.id = j.dup_group_id
"""
COLLAPSIBLE = "g.primary_posting_id IS NOT NULL AND g.state <> 'rejected'"

# A collapsible group shows its stored primary while that is active, else its
# most recent active member.
REPRESENTATIVE = f"""(
    NOT ({COLLAPSIBLE})
    OR j.id = g.primary_posting_id
    OR (
        NOT EXISTS (
            SELECT 1 FROM job_posting stored_primary
            WHERE stored_primary.id = g.primary_posting_id
              AND stored_primary.dup_group_id = g.id
              AND stored_primary.status = 'active'
        )
        AND j.id = (
            SELECT active_member.id FROM job_posting active_member
            WHERE active_member.dup_group_id = g.id AND active_member.status = 'active'
            ORDER BY COALESCE(active_member.posted_at, active_member.first_seen_at) DESC, active_member.id DESC
            LIMIT 1
        )
    )
)"""

# Active duplicates of the page's postings, newest first, for "also posted on".
ALTERNATES = f"""
    LEFT JOIN LATERAL (
        SELECT jsonb_agg(
            jsonb_build_object(
                'source', sibling.source,
                'url', COALESCE(NULLIF(BTRIM(sibling.source_url), ''), NULLIF(BTRIM(sibling.apply_url), '')),
                'posted_at', sibling.posted_at,
                'first_seen_at', sibling.first_seen_at
            )
            ORDER BY COALESCE(sibling.posted_at, sibling.first_seen_at) DESC, sibling.id DESC
        ) AS other_sources
        FROM job_posting sibling
        WHERE {COLLAPSIBLE}
          AND sibling.dup_group_id = j.dup_group_id
          AND sibling.id <> j.id
          AND sibling.status = 'active'
          AND COALESCE(NULLIF(BTRIM(sibling.apply_url), ''), NULLIF(BTRIM(sibling.source_url), '')) IS NOT NULL
    ) alternates ON true
"""


def _without_group_of(source: str, condition: str) -> str:
    """Drop postings `p` that `condition` selects, together with their duplicate group."""
    return (
        f"NOT EXISTS (SELECT 1 FROM {source} WHERE {condition} AND "
        f"(p.id = j.id OR ({COLLAPSIBLE} AND p.dup_group_id = j.dup_group_id)))"
    )


def _in_region(keys: str) -> str:
    return (
        "EXISTS (SELECT 1 FROM jsonb_array_elements(j.locations) location "
        "WHERE upper(location ->> 'country') = 'US' "
        f"AND concat(upper(location ->> 'state'), '|', location ->> 'city') = ANY({keys}::text[]))"
    )


async def list_jobs(
    db: Db,
    account_id: UUID | None,
    *,
    job_types: Iterable[str] = (),
    degree_fields: Iterable[str] = (),
    exclude_job_ids: Iterable[int] = (),
    q: str = "",
    season: str = "",
    sort: str = "fresh",
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    """One page of the feed. A signed-in account (`account_id`) also loses its tracked and hidden postings."""
    params: list[Any] = []

    def bind(value: Any) -> str:
        params.append(value)
        return f"${len(params)}"

    hide_tracked = account_id is not None
    if hide_tracked and db.jobs is not db.pool:
        # Applications and feedback live in the accounts database: exclude by id instead.
        hidden = await db.pool.fetch(
            "SELECT job_posting_id FROM job_application WHERE account_id=$1 AND job_posting_id IS NOT NULL "
            "UNION SELECT job_posting_id FROM job_feedback WHERE account_id=$1",
            account_id,
        )
        exclude_job_ids = (*exclude_job_ids, *(row["job_posting_id"] for row in hidden))
        hide_tracked = False

    clauses = [
        "j.status = 'active'",
        REPRESENTATIVE,
        # US only for now; postings with no normalized location stay visible.
        "(j.locations = '[]'::jsonb OR j.locations @> '[{\"country\": \"US\"}]'::jsonb)",
    ]
    if hide_tracked:
        account = bind(account_id)
        clauses.append(_without_group_of(
            "job_application a JOIN job_posting p ON p.id = a.job_posting_id", f"a.account_id = {account}"))
        clauses.append(_without_group_of(
            "job_feedback f JOIN job_posting p ON p.id = f.job_posting_id", f"f.account_id = {account}"))

    # Ordinary degree fields narrow nothing (the pipeline's degree tag is too
    # sparse to gate on); they stay accepted so bookmarked requests keep working.
    # The bioengineering chips and the domain labels are real filters, and the
    # internal BioEngineering token means any of the three chips.
    fields = tuple(dict.fromkeys(degree_fields))
    focus = tuple(dict.fromkeys(
        chip
        for field in fields
        for chip in (FOCUS_FILTERS if field == BIOENGINEERING_FILTER else (field,))
        if chip in FOCUS_FILTERS
    ))
    domains = tuple(field for field in fields if field in DOMAIN_FILTERS)
    wanted = []
    if focus:
        wanted.append(f"(j.attributes -> 'focus') ?| {bind(list(focus))}::text[]")
    if domains:
        wanted.append(f"j.job_domain = ANY({bind(list(domains))}::text[])")
    if wanted:
        clauses.append(f"({' OR '.join(wanted)})")

    excluded = tuple(dict.fromkeys(int(job_id) for job_id in exclude_job_ids))
    if excluded:
        clauses.append(_without_group_of("job_posting p", f"p.id = ANY({bind(list(excluded))}::bigint[])"))

    if q.strip():
        pattern = bind(ilike(q.strip()))
        search = [
            f"c.name ILIKE {pattern}",
            f"j.title ILIKE {pattern}",
            f"split_part(j.source, ':', 1) ILIKE {pattern}",
            # Any active source of the group, without changing its representative.
            f"""EXISTS (
                SELECT 1 FROM job_posting search_source
                WHERE {COLLAPSIBLE}
                  AND search_source.dup_group_id = j.dup_group_id
                  AND search_source.status = 'active'
                  AND split_part(search_source.source, ':', 1) ILIKE {pattern}
            )""",
        ]
        skill_ids = skill_ids_matching(q)
        if skill_ids:
            search.append(f"(j.attributes -> 'skills') ?| {bind(list(skill_ids))}::text[]")
        clauses.append(f"({' OR '.join(search)})")

    # Fall Only / Winter Only: the season as a whole word in the title or summary.
    if season in ("fall", "winter"):
        word = bind(rf"\m{season}\M")
        clauses.append(f"(j.title ~* {word} OR j.attributes ->> 'summary' ~* {word})")

    # Tab totals honor every filter except the selected tab's own type.
    counts_where, counts_params = " AND ".join(clauses), tuple(params)
    types = tuple(dict.fromkeys(job_types))
    if types:
        named = [value for value in types if value != UNCLASSIFIED]
        typed = [f"j.job_type = ANY({bind(named)}::text[])"] if named else []
        if UNCLASSIFIED in types:
            typed.append("j.job_type IS NULL")
        clauses.append(f"({' OR '.join(typed)})")
    where, filter_params = " AND ".join(clauses), tuple(params)

    if sort == "company":
        ordering = "c.name, j.title, j.id"
    elif sort == "title":
        ordering = "j.title, c.name, j.id"
    else:
        # Recency by Pacific day, then within a day: core US hubs, their suburbs,
        # the rest of the US, no location; then NorCal, SoCal, Seattle, elsewhere.
        direction = "ASC" if sort == "oldest" else "DESC"
        hub, suburb, norcal, socal, seattle = [
            bind(list(keys)) for keys in (US_HUB_KEYS, US_SUBURB_KEYS, US_NORCAL_KEYS, US_SOCAL_KEYS, US_SEATTLE_KEYS)
        ]
        ordering = f"""
            (COALESCE(j.posted_at, j.first_seen_at) AT TIME ZONE '{RECENCY_TIME_ZONE}')::date {direction} NULLS LAST,
            CASE
                WHEN {_in_region(hub)} THEN 1
                WHEN {_in_region(suburb)} THEN 2
                WHEN j.locations @> '[{{"country": "US"}}]'::jsonb THEN 3
                ELSE 4
            END,
            CASE
                WHEN {_in_region(norcal)} THEN 1
                WHEN {_in_region(socal)} THEN 2
                WHEN {_in_region(seattle)} THEN 3
                ELSE 4
            END,
            COALESCE(j.posted_at, j.first_seen_at) {direction} NULLS LAST,
            j.id {direction}
        """
    page = f"LIMIT {bind(max(1, min(limit, 500)))} OFFSET {bind(max(0, offset))}"

    # Three reads on separate connections, so a slow count never holds up the page.
    type_counts = ", ".join(f"COUNT(*) FILTER (WHERE j.job_type = '{name}') AS {name}" for name in DEFAULT_JOB_TYPES)
    counted_types = ", ".join(f"'{name}'" for name in DEFAULT_JOB_TYPES)
    total, counts, rows = await asyncio.gather(
        db.jobs.fetchval(f"SELECT COUNT(*) {TABLES} WHERE {where}", *filter_params),
        db.jobs.fetchrow(
            f"SELECT {type_counts} {TABLES} WHERE {counts_where} AND j.job_type IN ({counted_types})",
            *counts_params,
        ),
        db.jobs.fetch(
            f"""
            SELECT {JOB_COLUMNS}, COALESCE(alternates.other_sources, '[]'::jsonb) AS other_sources
            {TABLES}
            LEFT JOIN company_logo logo ON logo.company_id = j.company_id
            {ALTERNATES}
            WHERE {where}
            ORDER BY {ordering}
            {page}
            """,
            *params,
        ),
    )
    return {
        "jobs": [job(row) for row in rows],
        "total": int(total or 0),
        "job_type_counts": {name: int(counts[name] or 0) for name in DEFAULT_JOB_TYPES},
        "limit": limit,
        "offset": offset,
    }
