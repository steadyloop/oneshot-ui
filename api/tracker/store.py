"""PostgreSQL persistence for the live OneShot UI.

The repository uses the serving contract declared in xjobscore's ``frontend.sql``.
Harvesting and canonicalization belong to the core pipeline; OneShot is a
reader for jobs and a writer for the account-scoped application tracker.
"""

import asyncio
import functools
import json
import logging
from datetime import date, datetime, time, timezone
from typing import Any, Iterable
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import asyncpg

from api.taxonomy.coverage_snapshot import board_state as _board_state
from api.taxonomy.coverage_snapshot import empty_snapshot
from api.taxonomy.degrees import canon as degree_canon
from api.taxonomy.skill_labels import labels as skill_labels
from api.taxonomy.skills import canon

from ..taxonomy import (
    BIOENGINEERING_FILTER, FOCUS_FILTERS, SOFTWARE_FILTER, FINANCE_FILTER, UNLABELED_FILTER,
)

from ..jobs.locations import (
    RECENCY_TIME_ZONE,
    US_HUB_CITIES,
    US_HUB_KEYS,
    US_NORCAL_CITIES,
    US_NORCAL_KEYS,
    US_SEATTLE_CITIES,
    US_SEATTLE_KEYS,
    US_SOCAL_CITIES,
    US_SOCAL_KEYS,
    US_SUBURB_CITIES,
    US_SUBURB_KEYS,
)
from ..jobs.feeds import FeedActivityCache
from ..jobs.present import JOB_COLUMNS


def _remote(column: str | None, attributes: dict[str, Any]) -> str:
    """Prefer the parse-time column; fall back while vendors are migrated."""
    if column and column != "unknown":
        return column
    return attributes.get("remote") or "unknown"


LOCAL_ACCOUNT_ID = UUID("00000000-0000-0000-0000-000000000001")

# `job_type` is a parse-time column now, not a registry-derived enrichment, so
# the contract is spelled out here and pinned to schema.sql's CHECK by test.
DEFAULT_JOB_TYPES = ("intern", "coop", "student", "new_grad", "research")
# API-only token: storage says NULL for "no signal", but the query parameter
# keeps a name so the unclassified pool stays addressable.
UNCLASSIFIED = "unclassified"
VALID_JOB_TYPES = frozenset((*DEFAULT_JOB_TYPES, UNCLASSIFIED))
# Domain labels are published by the pipeline; NULL remains addressable for review.
DOMAIN_FILTERS = (SOFTWARE_FILTER, FINANCE_FILTER, UNLABELED_FILTER)
VALID_DEGREE_FIELDS = frozenset(
    {
        *(field.name for field in degree_canon()),
        BIOENGINEERING_FILTER,
        *DOMAIN_FILTERS,
    }
)
VALID_APPLICATION_STAGES = frozenset(
    {"applied", "replied", "assessment", "interview", "offer", "closed"}
)
VALID_CLOSED_REASONS = frozenset({"rejected", "withdrawn", "no_reply"})

_COUNTRY_NAMES = {"US": "United States"}
_LOCATION_FIELDS = ("country", "state", "city")
_LOCATION_DISPLAY_LIMIT = 3


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        decoded = json.loads(value)
        return decoded if isinstance(decoded, dict) else {}
    return {}


def _other_sources(value: Any) -> list[dict[str, Any]]:
    """Shape active alternate postings into the narrow public provenance contract."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return []
    if not isinstance(value, list):
        return []

    result = []
    for item in value:
        if not isinstance(item, dict):
            continue
        source = item.get("source")
        url = item.get("url")
        if not isinstance(source, str) or not source.strip():
            continue
        if not isinstance(url, str) or not url.strip():
            continue
        result.append(
            {
                "source": source,
                "url": url,
                "posted_at": _iso(item.get("posted_at")),
                "first_seen_at": _iso(item.get("first_seen_at")),
            }
        )
    return result


def _locations(value: Any) -> list[dict[str, str | None]]:
    """Decode and bound the normalized location contract returned to clients."""
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return []
    if not isinstance(value, list):
        return []

    result: list[dict[str, str | None]] = []
    seen: set[tuple[str | None, str | None, str | None]] = set()
    for item in value:
        if not isinstance(item, dict):
            continue
        row = {
            field: str(item[field]).strip() if item.get(field) else None
            for field in _LOCATION_FIELDS
        }
        if row["country"]:
            row["country"] = row["country"].upper()
        key = tuple(row[field] for field in _LOCATION_FIELDS)
        if not any(key) or key in seen:
            continue
        seen.add(key)
        result.append(row)
    return result


def _us_location_bucket(value: Any) -> int | None:
    """Return the transient UI bucket, or ``None`` for a foreign-only job."""
    locations = _locations(value)
    if not locations:
        return 4
    us = [location for location in locations if location["country"] == "US"]
    if not us:
        return None
    keys = {(location["state"], location["city"]) for location in us}
    if keys & US_HUB_CITIES:
        return 1
    if keys & US_SUBURB_CITIES:
        return 2
    return 3


def _us_proximity_priority(value: Any) -> int:
    """Rank represented US regions: NorCal, SoCal, Seattle, then elsewhere."""
    keys = {
        (location["state"], location["city"])
        for location in _locations(value)
        if location["country"] == "US"
    }
    if keys & US_NORCAL_CITIES:
        return 1
    if keys & US_SOCAL_CITIES:
        return 2
    if keys & US_SEATTLE_CITIES:
        return 3
    return 4


def _location_label(value: Any) -> str | None:
    """Render a compact label from normalized locations, never raw source text."""
    labels: list[str] = []
    for location in _locations(value):
        country = location["country"]
        state = location["state"]
        city = location["city"]
        country_name = _COUNTRY_NAMES.get(country or "", country)
        if country == "US":
            label = ", ".join(part for part in (city, state) if part)
            if not label:
                label = country_name
            elif city is None and state:
                label = state
        elif city:
            label = city if city.casefold() == str(country_name or "").casefold() else ", ".join(
                part for part in (city, country_name) if part
            )
        else:
            label = ", ".join(part for part in (state, country_name) if part)
        if label and label not in labels:
            labels.append(label)

    visible = labels[:_LOCATION_DISPLAY_LIMIT]
    if len(labels) > _LOCATION_DISPLAY_LIMIT:
        visible.append(f"+{len(labels) - _LOCATION_DISPLAY_LIMIT} more")
    return " · ".join(visible) or None


@functools.lru_cache(maxsize=1)
def _skill_lookups() -> tuple[dict[str, Any], dict[str, Any]]:
    """Index the cached canon by stable id and case-insensitive display name."""
    by_id = canon()
    by_name = {skill.name.casefold(): skill for skill in by_id.values()}
    return by_id, by_name


def _skill_details(attributes: dict[str, Any]) -> list[dict[str, Any]]:
    """Derive display metadata without changing stored canonical skill ids."""
    values = attributes.get("skills")
    if not isinstance(values, list):
        return []

    by_id, by_name = _skill_lookups()
    display_labels = skill_labels()
    details: list[dict[str, Any]] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, str) or not value.strip():
            continue
        raw = value.strip()
        skill = by_id.get(raw) or by_name.get(raw.casefold())
        if skill is None:
            skill_id, name, label, category = raw, raw, raw, None
        else:
            skill_id, name, category = skill.id, skill.name, skill.category
            label = display_labels.get(skill_id, name)
        if skill_id in seen:
            continue
        seen.add(skill_id)
        details.append(
            {"id": skill_id, "name": name, "label": label, "category": category}
        )
    return details


def _skill_search_ids(value: str) -> tuple[str, ...]:
    """Resolve a UI keyword to the precomputed skill ids stored on postings."""
    needle = value.strip().casefold()
    if not needle:
        return ()
    matches = []
    display_labels = skill_labels()
    for skill in _skill_lookups()[0].values():
        terms = (
            skill.id,
            skill.name,
            display_labels.get(skill.id, skill.name),
            *skill.patterns,
            *skill.ambiguous_aliases,
        )
        if any(
            needle == term.casefold()
            or (len(needle) >= 3 and needle in term.casefold())
            for term in terms
        ):
            matches.append(skill.id)
    return tuple(matches)


def _iso(value: Any) -> Any:
    return value.isoformat() if isinstance(value, (date, datetime)) else value


def _ilike_pattern(value: str) -> str:
    """A substring pattern matching ``value`` literally.

    ``%`` and ``_`` are ILIKE wildcards, so a typed ``C_`` would otherwise match
    ``C#`` and a lone ``%`` would match the whole catalog. Backslash is
    PostgreSQL's default LIKE escape character, so no ESCAPE clause is needed —
    but it has to be escaped first, both to keep a typed backslash literal and
    because a pattern ending in a lone escape character is an error.
    """
    escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _timestamp(value: Any, *, end_of_day: bool = False) -> datetime | None:
    if value is None or not str(value).strip():
        return None
    raw = str(value).strip()
    try:
        if len(raw) == 10:
            clock = time.max if end_of_day else time.min
            return datetime.combine(date.fromisoformat(raw), clock, tzinfo=timezone.utc)
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("application dates must be ISO-8601 values") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


class PostgresRepository:
    """OneShot queries and commands over an ``asyncpg`` pool."""

    def __init__(
        self,
        dsn: str,
        *,
        account_id: UUID = LOCAL_ACCOUNT_ID,
        pool: asyncpg.Pool | None = None,
        jobs_dsn: str | None = None,
        jobs_pool: asyncpg.Pool | None = None,
        _feed_activity_cache: FeedActivityCache | None = None,
    ) -> None:
        self.dsn = dsn
        self.jobs_dsn = jobs_dsn or dsn
        self.jobs_pool = jobs_pool
        self._owns_jobs_pool = jobs_pool is None and self.jobs_dsn != dsn
        self.account_id = account_id
        self.pool = pool
        self._owns_pool = pool is None
        self._feed_activity_cache = _feed_activity_cache or FeedActivityCache()

    async def connect(self) -> None:
        if self.pool is None:
            if not self.dsn:
                raise RuntimeError("No PostgreSQL DSN. Set DATABASE_URL.")
            self.pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=8)
        if self.jobs_pool is None and self.jobs_dsn != self.dsn:
            try:
                self.jobs_pool = await asyncpg.create_pool(self.jobs_dsn, min_size=1, max_size=8)
            except BaseException:
                await self.close()
                raise

    async def close(self) -> None:
        if self.jobs_pool is not None and self._owns_jobs_pool:
            await self.jobs_pool.close()
            self.jobs_pool = None
        if self.pool is not None and self._owns_pool:
            await self.pool.close()
            self.pool = None

    def _ready(self) -> asyncpg.Pool:
        if self.pool is None:
            raise RuntimeError("PostgresRepository.connect() has not been called")
        return self.pool

    def _jobs_ready(self) -> asyncpg.Pool:
        return self.jobs_pool if self.jobs_pool is not None else self._ready()

    def for_account(self, account_id: UUID) -> "PostgresRepository":
        """A per-request view of the same pool, scoped to one account.

        Every query already filters on ``self.account_id``; this is the only
        thing that has to vary per request, so cloning the object is cheaper and
        far less invasive than threading an account through ten method
        signatures. The clone is handed the live pool, so ``_owns_pool`` is
        False and its ``close()`` is a no-op.

        Calls ``_ready()`` rather than reading ``self.pool`` so cloning before
        ``connect()`` fails loudly instead of yielding a half-dead store.
        """
        return PostgresRepository(
            self.dsn,
            account_id=account_id,
            pool=self._ready(),
            jobs_dsn=self.jobs_dsn,
            jobs_pool=self._jobs_ready(),
            _feed_activity_cache=self._feed_activity_cache,
        )


    @staticmethod
    def _job(row: asyncpg.Record | dict[str, Any]) -> dict[str, Any]:
        attributes = _json_object(row.get("attributes"))
        locations = _locations(row.get("locations"))
        summary = attributes.get("summary")
        return {
            "id": row["id"],
            "source": row.get("source"),
            "source_url": row.get("source_url"),
            "company": row.get("company_name") or "Unknown company",
            # Null when the harvest found nothing, which the client reads as
            # "draw the initials instead".
            "logo": (
                f"/api/companies/{row['company_id']}/logo"
                if row.get("has_logo")
                else None
            ),
            "title": row["title"],
            "summary": summary.strip() if isinstance(summary, str) and summary.strip() else None,
            "locations": locations,
            "location": _location_label(locations),
            # Posting page first: the stored apply_url (Lever /apply, Ashby
            # /application, ...) skips the description, and every posting
            # page carries its own Apply button.
            "apply_url": row.get("source_url") or row.get("apply_url"),
            "posted_at": _iso(row.get("posted_at")),
            # Most feeds publish no posting date, so the client falls back to
            # this to say "Added 2d ago" rather than "Posted date unavailable".
            # It is also what the "fresh" sort already orders by.
            "first_seen_at": _iso(row.get("first_seen_at")),
            "last_seen_at": _iso(row.get("last_seen_at")),
            "status": row.get("status"),
            # Parse-time columns. `remote` falls back to the legacy
            # attributes.remote for vendors whose parse-time rules have not
            # been transcribed yet, so the UI keeps its signal during the
            # per-vendor migration.
            "job_type": row.get("job_type"),
            "remote": _remote(row.get("remote"), attributes),
            # Schedule, orthogonal to job_type: a part-time internship reads
            # job_type "intern" and part_time "yes".
            "part_time": row.get("part_time") or "unknown",
            # Gold title domain (software, finance, unlabeled) or null when not
            # yet classified.
            "job_domain": row.get("job_domain"),
            # The Focus label the triage pane shows and a Mislabeled report
            # disputes: the pipeline's stored bioengineering chip when there is
            # one (MedTech, Regulatory, BioTech), else the domain label.
            "focus": next(
                (chip for chip in FOCUS_FILTERS if chip in (attributes.get("focus") or ())),
                row.get("job_domain"),
            ),
            "attributes": attributes,
            # Derived API presentation; attributes.skills remains the durable
            # JSONB array of canonical ids.
            "skills": _skill_details(attributes),
            # Active alternatives only. Group ids and review evidence remain an
            # internal pipeline concern; clients get just enough provenance to
            # offer another working source when one exists.
            "other_sources": _other_sources(row.get("other_sources")),
        }

    async def company_logo(self, company_id: int) -> bytes | None:
        """Return the stored logo, or None when the harvest found none."""
        pool = self._jobs_ready()
        return await pool.fetchval(
            "SELECT bytes FROM company_logo WHERE company_id = $1", company_id
        )

    # Pending edits are shown in the editor while Discover continues to use the
    # published row. xjobscore applies this queue before publishing its next
    # snapshot, preserving its stable identity checks even after a domain edit.
    _COMPANY_EDIT_SELECT = """
        SELECT c.id,
            CASE WHEN e.changes ? 'name' THEN e.changes->>'name' ELSE c.name END AS name,
            CASE WHEN e.changes ? 'domain' THEN e.changes->>'domain' ELSE c.domain END AS domain,
            CASE WHEN e.changes ? 'description' THEN e.changes->>'description' ELSE c.description END AS description,
            CASE WHEN e.changes ? 'tags' THEN e.changes->'tags' ELSE c.tags END AS tags,
            (e.company_id IS NOT NULL) AS sync_pending, e.sync_error
        FROM company c LEFT JOIN company_edit e ON e.company_id = c.id
    """

    @staticmethod
    def _company(row: asyncpg.Record) -> dict[str, Any]:
        return {
            "id": row["id"],
            "name": row["name"],
            "domain": row["domain"],
            "description": row["description"],
            "tags": _json_object(row["tags"]),
            "sync_pending": row["sync_pending"],
            "sync_error": row["sync_error"],
        }

    async def list_companies(self, *, q: str = "", limit: int = 50, offset: int = 0) -> dict[str, Any]:
        # Company maintenance follows the same database as Discover, including
        # configurations that separate jobs from accounts and resumes.
        pool = self._jobs_ready()
        q = q.strip()
        match = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        where = "($1 = '' OR name ILIKE $2 OR domain ILIKE $2 OR id::text = $1)"
        effective = f"({self._COMPANY_EDIT_SELECT}) AS effective"
        total, rows = await asyncio.gather(
            pool.fetchval(f"SELECT count(*) FROM {effective} WHERE {where}", q, match),
            pool.fetch(
                f"SELECT * FROM {effective} WHERE {where} "
                "ORDER BY lower(name), id LIMIT $3 OFFSET $4",
                q, match, limit, offset,
            ),
        )
        return {"companies": [self._company(row) for row in rows], "total": int(total)}

    async def update_company(self, company_id: int, changes: dict[str, Any]) -> dict[str, Any] | None:
        fields = ("name", "domain", "description", "tags")
        if not changes or set(changes) - set(fields):
            raise ValueError("Only name, domain, description and tags can be updated")
        async with self._jobs_ready().acquire() as connection, connection.transaction():
            if "domain" in changes and changes["domain"]:
                conflict = await connection.fetchval(
                    f"SELECT EXISTS (SELECT 1 FROM ({self._COMPANY_EDIT_SELECT}) effective "
                    "WHERE id <> $1 AND lower(domain) = lower($2))",
                    company_id, changes["domain"],
                )
                if conflict:
                    raise asyncpg.UniqueViolationError("Domain already assigned")
            queued = await connection.fetchval(
                """
                INSERT INTO company_edit(company_id, changes, edited_by, revision)
                SELECT id, $2::jsonb, $3, $4 FROM company WHERE id = $1
                ON CONFLICT (company_id) DO UPDATE
                SET changes = company_edit.changes || EXCLUDED.changes,
                    edited_by = EXCLUDED.edited_by, revision = EXCLUDED.revision,
                    updated_at = clock_timestamp(), sync_error = NULL
                RETURNING company_id
                """,
                company_id, json.dumps(changes), self.account_id, uuid4(),
            )
            if queued is None:
                return None
            row = await connection.fetchrow(self._COMPANY_EDIT_SELECT + " WHERE c.id = $1", company_id)
            return self._company(row)

    async def list_jobs(
        self,
        *,
        job_types: Iterable[str] = (),
        degree_fields: Iterable[str] = (),
        exclude_job_ids: Iterable[int] = (),
        hide_tracked: bool = True,
        q: str = "",
        season: str = "",
        sort: str = "fresh",
        limit: int = 100,
        offset: int = 0,
    ) -> dict[str, Any]:
        fields = tuple(dict.fromkeys(degree_fields))
        # MedTech, Regulatory and BioTech are the pipeline's stored
        # `attributes.focus` chips (the pipeline focus classifier). The
        # internal BioEngineering token stays valid for bookmarked requests
        # and means any of the three.
        focus_requested = tuple(
            dict.fromkeys(
                chip
                for field in fields
                for chip in (FOCUS_FILTERS if field == BIOENGINEERING_FILTER else (field,))
                if chip in FOCUS_FILTERS
            )
        )
        domains_requested = tuple(f for f in fields if f in DOMAIN_FILTERS)
        # Gold stores domain labels once; serving requests only filter them.
        if hide_tracked and self._jobs_ready() is not self._ready():
            hidden = await self._ready().fetch(
                "SELECT job_posting_id FROM job_application WHERE account_id=$1 AND job_posting_id IS NOT NULL "
                "UNION SELECT job_posting_id FROM job_feedback WHERE account_id=$1",
                self.account_id,
            )
            exclude_job_ids = (*exclude_job_ids, *(row["job_posting_id"] for row in hidden))
            hide_tracked = False
        params: list[Any] = []

        def bind(value: Any) -> str:
            params.append(value)
            return f"${len(params)}"

        collapsible = "g.primary_posting_id IS NOT NULL AND g.state <> 'rejected'"
        representative = f"""
            (
                NOT ({collapsible})
                OR j.id = g.primary_posting_id
                OR (
                    NOT EXISTS (
                        SELECT 1
                        FROM job_posting stored_primary
                        WHERE stored_primary.id = g.primary_posting_id
                          AND stored_primary.dup_group_id = g.id
                          AND stored_primary.status = 'active'
                    )
                    AND j.id = (
                        SELECT active_member.id
                        FROM job_posting active_member
                        WHERE active_member.dup_group_id = g.id
                          AND active_member.status = 'active'
                        ORDER BY
                            COALESCE(
                                active_member.posted_at,
                                active_member.first_seen_at
                            ) DESC,
                            active_member.id DESC
                        LIMIT 1
                    )
                )
            )
        """
        clauses = [
            "j.status = 'active'",
            representative,
            # OneShot is US-only for now. Empty normalized locations remain
            # visible in the final bucket; foreign-only postings do not.
            "(j.locations = '[]'::jsonb "
            "OR j.locations @> '[{\"country\": \"US\"}]'::jsonb)",
        ]
        if hide_tracked:
            account_marker = bind(self.account_id)
            clauses.append(
                "NOT EXISTS ("
                "SELECT 1 FROM job_application a "
                "JOIN job_posting tracked ON tracked.id = a.job_posting_id "
                f"WHERE a.account_id = {account_marker} AND ("
                "a.job_posting_id = j.id OR ("
                f"{collapsible} AND tracked.dup_group_id = j.dup_group_id"
                ")))"
            )
            # Skipped and mislabeled postings leave the feed the same way,
            # duplicate group included, until the account restores them.
            clauses.append(
                "NOT EXISTS ("
                "SELECT 1 FROM job_feedback f "
                "JOIN job_posting hidden ON hidden.id = f.job_posting_id "
                f"WHERE f.account_id = {account_marker} AND ("
                "f.job_posting_id = j.id OR ("
                f"{collapsible} AND hidden.dup_group_id = j.dup_group_id"
                ")))"
            )
        if fields:
            field_clauses = []
            # `degree` is NOT a gate. The tag is non-empty on 8.3% of
            # active postings -- it is absent on every description-less vendor
            # (workday-list, 149k rows, carries no description at all), and it
            # fires on boilerplate ("BS in Computer Science or related field")
            # in senior and non-technical reqs. Gating on it dropped 1,235 of
            # 1,691 student CS/finance roles while rescuing ~8 that a title
            # vocabulary misses. Selecting an ordinary focus area therefore
            # narrows nothing; it is kept as an accepted parameter so bookmarked
            # requests keep working. The bioengineering chips are different:
            # the pipeline derives them from title, employer and role-level
            # description evidence, so they are real filters.
            if focus_requested:
                focus_marker = bind(list(focus_requested))
                field_clauses.append(
                    f"(j.attributes -> 'focus') ?| {focus_marker}::text[]"
                )
            if domains_requested:
                field_clauses.append(
                    f"j.job_domain = ANY({bind(list(domains_requested))}::text[])"
                )
            # Only the focus chips and the domain labels contribute predicates, so
            # `field_clauses` is empty whenever an ordinary focus area is
            # selected alone. Appending an empty "()" would be a syntax error,
            # not a no-op.
            if field_clauses:
                clauses.append(f"({' OR '.join(field_clauses)})")
        excluded = tuple(dict.fromkeys(int(job_id) for job_id in exclude_job_ids))
        if excluded:
            marker = bind(list(excluded))
            clauses.append(
                "NOT EXISTS ("
                "SELECT 1 FROM job_posting excluded "
                f"WHERE excluded.id = ANY({marker}::bigint[]) AND ("
                "excluded.id = j.id OR ("
                f"{collapsible} AND excluded.dup_group_id = j.dup_group_id"
                ")))"
            )
        if q.strip():
            marker = bind(_ilike_pattern(q.strip()))
            search = [
                f"c.name ILIKE {marker}",
                f"j.title ILIKE {marker}",
                f"split_part(j.source, ':', 1) ILIKE {marker}",
                # Search every active source without changing the group's
                # representative or counting a duplicate more than once.
                f"""EXISTS (
                    SELECT 1 FROM job_posting search_source
                    WHERE {collapsible}
                      AND search_source.dup_group_id = j.dup_group_id
                      AND search_source.status = 'active'
                      AND split_part(search_source.source, ':', 1) ILIKE {marker}
                )""",
            ]
            skill_ids = _skill_search_ids(q)
            if skill_ids:
                skill_marker = bind(list(skill_ids))
                search.append(
                    f"(j.attributes -> 'skills') ?| {skill_marker}::text[]"
                )
            clauses.append(f"({' OR '.join(search)})")
        # Fall Only / Winter Only: the season is named in the title or the
        # stored summary. Whole words only, so "fallback" is not a fall role.
        if season in ("fall", "winter"):
            marker = bind(rf"\m{season}\M")
            clauses.append(
                f"(j.title ~* {marker} OR j.attributes ->> 'summary' ~* {marker})"
            )
        # Tab totals honor every non-type filter (search, degree field, and a
        # user's tracked postings), but do not inherit the selected tab's type
        # predicate or the other tabs would all read zero.
        counts_where = " AND ".join(clauses)
        counts_params = tuple(params)
        types = tuple(dict.fromkeys(job_types))
        if types:
            # `unclassified` is not a stored value -- it is the NULL pool, so it
            # cannot ride along in the ANY() list and needs its own disjunct.
            named = [value for value in types if value != UNCLASSIFIED]
            wanted = []
            if named:
                wanted.append(f"j.job_type = ANY({bind(named)}::text[])")
            if UNCLASSIFIED in types:
                wanted.append("j.job_type IS NULL")
            clauses.append(f"({' OR '.join(wanted)})")
        where = " AND ".join(clauses)
        pool = self._jobs_ready()
        # Counting and reading a page use the same filter predicate but
        # neither depends on the other. Run them on separate pool connections
        # so a large count does not hold the first visible results hostage.
        # Keep the filter arguments separate: binding LIMIT/OFFSET below must
        # not change the count query's positional parameters.
        filter_params = tuple(params)
        total_read = pool.fetchval(
            f"""
            SELECT COUNT(*)
            FROM job_posting j
            JOIN company c ON c.id = j.company_id
            LEFT JOIN job_posting_dup_group g ON g.id = j.dup_group_id
            WHERE {where}
            """,
            *filter_params,
        )
        type_counts_read = pool.fetchrow(
            f"""
            SELECT
                COUNT(*) FILTER (WHERE j.job_type = 'intern') AS intern,
                COUNT(*) FILTER (WHERE j.job_type = 'coop') AS coop,
                COUNT(*) FILTER (WHERE j.job_type = 'student') AS student,
                COUNT(*) FILTER (WHERE j.job_type = 'new_grad') AS new_grad,
                COUNT(*) FILTER (WHERE j.job_type = 'research') AS research
            FROM job_posting j
            JOIN company c ON c.id = j.company_id
            LEFT JOIN job_posting_dup_group g ON g.id = j.dup_group_id
            WHERE {counts_where}
              AND j.job_type = ANY(ARRAY[
                  'intern', 'coop', 'student', 'new_grad', 'research'
              ]::text[])
            """,
            *counts_params,
        )
        if sort == "company":
            ordering = "c.name, j.title, j.id"
        elif sort == "title":
            ordering = "j.title, c.name, j.id"
        else:
            # Oldest first reverses only the recency keys; the location
            # ranking within each day stays the same.
            direction = "ASC" if sort == "oldest" else "DESC"
            # Recency is the outer bucket. Within each calendar day, rank core
            # US hubs, then their suburbs, the rest of the US, and no location.
            # Bind the policy after the count reads: these values are page-only
            # and must not alter either count query's argument contract.
            hub_marker = bind(list(US_HUB_KEYS))
            suburb_marker = bind(list(US_SUBURB_KEYS))
            norcal_marker = bind(list(US_NORCAL_KEYS))
            socal_marker = bind(list(US_SOCAL_KEYS))
            seattle_marker = bind(list(US_SEATTLE_KEYS))
            location_key = (
                "concat(upper(location ->> 'state'), '|', location ->> 'city')"
            )
            ordering = f"""
                (COALESCE(j.posted_at, j.first_seen_at)
                    AT TIME ZONE '{RECENCY_TIME_ZONE}')::date {direction} NULLS LAST,
                CASE
                    WHEN EXISTS (
                        SELECT 1 FROM jsonb_array_elements(j.locations) location
                        WHERE upper(location ->> 'country') = 'US'
                          AND {location_key} = ANY({hub_marker}::text[])
                    ) THEN 1
                    WHEN EXISTS (
                        SELECT 1 FROM jsonb_array_elements(j.locations) location
                        WHERE upper(location ->> 'country') = 'US'
                          AND {location_key} = ANY({suburb_marker}::text[])
                    ) THEN 2
                    WHEN j.locations @> '[{{"country": "US"}}]'::jsonb THEN 3
                    ELSE 4
                END,
                CASE
                    WHEN EXISTS (
                        SELECT 1 FROM jsonb_array_elements(j.locations) location
                        WHERE upper(location ->> 'country') = 'US'
                          AND {location_key} = ANY({norcal_marker}::text[])
                    ) THEN 1
                    WHEN EXISTS (
                        SELECT 1 FROM jsonb_array_elements(j.locations) location
                        WHERE upper(location ->> 'country') = 'US'
                          AND {location_key} = ANY({socal_marker}::text[])
                    ) THEN 2
                    WHEN EXISTS (
                        SELECT 1 FROM jsonb_array_elements(j.locations) location
                        WHERE upper(location ->> 'country') = 'US'
                          AND {location_key} = ANY({seattle_marker}::text[])
                    ) THEN 3
                    ELSE 4
                END,
                COALESCE(j.posted_at, j.first_seen_at) {direction} NULLS LAST,
                j.id {direction}
            """
        limit_marker = bind(max(1, min(limit, 500)))
        offset_marker = bind(max(0, offset))
        page_read = pool.fetch(
            f"""
            SELECT
                j.id, j.source, c.name AS company_name, j.title,
                j.locations, j.source_url, j.apply_url, j.posted_at,
                j.first_seen_at, j.last_seen_at, j.status, j.attributes,
                j.job_type, j.remote, j.part_time, j.job_domain,
                j.company_id, (logo.bytes IS NOT NULL) AS has_logo,
                COALESCE(alternates.other_sources, '[]'::jsonb) AS other_sources
            FROM job_posting j
            JOIN company c ON c.id = j.company_id
            -- Presence only: the bytes are served by their own cacheable route,
            -- so a card that has no logo never fires a request that 404s.
            LEFT JOIN company_logo logo ON logo.company_id = j.company_id
            LEFT JOIN job_posting_dup_group g ON g.id = j.dup_group_id
            LEFT JOIN LATERAL (
                SELECT jsonb_agg(
                    jsonb_build_object(
                        'source', sibling.source,
                        'url', COALESCE(
                            NULLIF(BTRIM(sibling.source_url), ''),
                            NULLIF(BTRIM(sibling.apply_url), '')
                        ),
                        'posted_at', sibling.posted_at,
                        'first_seen_at', sibling.first_seen_at
                    )
                    ORDER BY
                        COALESCE(sibling.posted_at, sibling.first_seen_at) DESC,
                        sibling.id DESC
                ) AS other_sources
                FROM job_posting sibling
                WHERE {collapsible}
                  AND sibling.dup_group_id = j.dup_group_id
                  AND sibling.id <> j.id
                  AND sibling.status = 'active'
                  AND COALESCE(
                      NULLIF(BTRIM(sibling.apply_url), ''),
                      NULLIF(BTRIM(sibling.source_url), '')
                  ) IS NOT NULL
            ) alternates ON true
            WHERE {where}
            ORDER BY {ordering}
            LIMIT {limit_marker} OFFSET {offset_marker}
            """,
            *params,
        )
        total, type_counts, rows = await asyncio.gather(total_read, type_counts_read, page_read)
        return {
            "jobs": [self._job(row) for row in rows],
            "total": int(total or 0),
            "job_type_counts": {
                job_type: int(type_counts[job_type] or 0)
                for job_type in DEFAULT_JOB_TYPES
            },
            "limit": limit,
            "offset": offset,
        }

    async def _coverage_snapshot(self) -> tuple[dict[str, Any], Any]:
        row = await self._jobs_ready().fetchrow(
            """
            SELECT payload, computed_at
            FROM coverage_snapshot
            ORDER BY computed_at DESC
            LIMIT 1
            """
        )
        if row is None:
            return empty_snapshot(), None
        return _json_object(row["payload"]), _iso(row["computed_at"])

    async def source_coverage(self) -> dict[str, Any]:
        snapshot, computed_at = await self._coverage_snapshot()
        fallback = empty_snapshot()["source_coverage"]
        payload = snapshot.get("source_coverage", fallback)
        result = dict(payload) if isinstance(payload, dict) else dict(fallback)
        result["computed_at"] = computed_at
        return result

    async def board_map(self) -> dict[str, Any]:
        snapshot, computed_at = await self._coverage_snapshot()
        fallback = empty_snapshot()["board_map"]
        payload = snapshot.get("board_map", fallback)
        result = dict(payload) if isinstance(payload, dict) else dict(fallback)
        result["computed_at"] = computed_at
        # The serving database contains only the published student-job cohort.
        # Fleet size comes from the pipeline snapshot, including postings that
        # have no polling feed, classification, US location or dedup selection.
        totals = dict(result.get("totals", {}))
        pipeline_total = totals.get("active_postings")
        if type(pipeline_total) is not int or pipeline_total < 0:
            # Older snapshots predate the global count. Their source coverage
            # still covers the pipeline, including disabled feeds.
            pipeline_total = snapshot.get("source_coverage", {}).get("total_coverage")
        if type(pipeline_total) is int and pipeline_total >= 0:
            totals["active_postings"] = pipeline_total
        else:
            pipeline_total = None
            totals.pop("active_postings", None)
        result["totals"] = totals
        try:
            activity = await self._feed_activity_cache.get(self._jobs_ready())
        except (asyncpg.PostgresError, TimeoutError):
            # Preserve the heatmap if the optional aggregation is unavailable.
            # An unknown closure count must never be replaced with zero.
            logging.getLogger(__name__).warning("Feed activity aggregation unavailable", exc_info=True)
        else:
            result.update(activity)
            if pipeline_total is None:
                # An unknown fleet total must not be replaced by the subset.
                result.pop("classification", None)
            else:
                result["classification"] = {**activity["classification"], "total": pipeline_total}
            result["providers"] = [
                {**provider, "discover_jobs": activity["provider_discover_counts"].get(provider["source"], 0)}
                for provider in result.get("providers", [])
            ]
            result["totals"] = {
                **result.get("totals", {}),
                "added_today": activity["today_breakdown"]["total"],
                "disappeared_today": activity["today_breakdown"]["disappeared"]["total"],
            }
        return result

    @staticmethod
    def _application(row: asyncpg.Record | dict[str, Any]) -> dict[str, Any]:
        external = row.get("job_posting_id") is None
        return {
            "id": row["id"],
            "job_id": row.get("job_posting_id"),
            "external": external,
            "company": row["company_snapshot"],
            "title": row["title_snapshot"],
            "location": row.get("location_snapshot"),
            "stage": row["stage"],
            "closed_reason": row.get("closed_reason"),
            "apply_url_snapshot": row.get("apply_url_snapshot"),
            "resume_variant": row.get("resume_variant"),
            "submitted_at": _iso(row.get("submitted_at")),
            "next_action": row.get("next_action"),
            "task_state": row["task_state"],
            "waiting_for": row.get("waiting_for") or "",
            "last_open_stage": row["last_open_stage"],
            "next_due_at": _iso(row.get("next_due_at")),
            "note": row.get("note") or "",
            "updated_at": _iso(row.get("updated_at")),
        }

    async def _get_application(
        self, connection: asyncpg.Connection, application_id: int
    ) -> dict[str, Any] | None:
        row = await connection.fetchrow(
            """
            SELECT
                id, job_posting_id, company_snapshot, title_snapshot,
                location_snapshot, stage, closed_reason, apply_url_snapshot,
                resume_variant, submitted_at, next_action, next_due_at, note,
                task_state, waiting_for, last_open_stage,
                updated_at
            FROM job_application a
            WHERE a.id = $1 AND a.account_id = $2
            """,
            application_id,
            self.account_id,
        )
        if row is None:
            return None
        result = self._application(row)
        events = await connection.fetch(
            """
            SELECT id, event_type, to_stage, occurred_at, note
            FROM job_application_event
            WHERE job_application_id = $1
            ORDER BY occurred_at DESC, id DESC
            """,
            application_id,
        )
        result["events"] = [
            {
                "id": event["id"],
                "event_type": event["event_type"],
                "to_stage": event["to_stage"],
                "occurred_at": _iso(event["occurred_at"]),
                "note": event["note"],
            }
            for event in events
        ]
        return result

    async def list_applications(self) -> dict[str, Any]:
        rows = await self._ready().fetch(
            """
            SELECT
                id, job_posting_id, company_snapshot, title_snapshot,
                location_snapshot, stage, closed_reason, apply_url_snapshot,
                resume_variant, submitted_at, next_action, next_due_at, note,
                task_state, waiting_for, last_open_stage,
                updated_at
            FROM job_application a
            WHERE a.account_id = $1
            ORDER BY
                CASE a.stage
                    WHEN 'offer' THEN 1
                    WHEN 'interview' THEN 2
                    WHEN 'assessment' THEN 3
                    WHEN 'applied' THEN 4
                    WHEN 'replied' THEN 5
                    ELSE 6
                END,
                a.next_due_at NULLS LAST,
                a.updated_at DESC
            """,
            self.account_id,
        )
        return {"applications": [self._application(row) for row in rows]}

    async def get_application(self, application_id: int) -> dict[str, Any] | None:
        async with self._ready().acquire() as connection:
            return await self._get_application(connection, application_id)

    async def create_application(
        self,
        job_id: int,
        *,
        submitted_at: str | None = None,
    ) -> dict[str, Any] | None:
        pool = self._ready()
        async with pool.acquire() as connection, connection.transaction():
            # Discover's posting IDs belong to the jobs database. The accounts
            # database can have an older export, or no posting tables at all.
            split = self._jobs_ready() is not pool
            jobs = self._jobs_ready() if split else connection
            posting_lock = "" if split else "FOR SHARE OF j"
            job = await jobs.fetchrow(
                f"""
                SELECT
                    j.id, j.title, j.locations, j.source_url, j.apply_url,
                    j.dup_group_id,
                    (
                        g.primary_posting_id IS NOT NULL
                        AND g.state <> 'rejected'
                    ) AS collapsible,
                    c.name AS company_name
                FROM job_posting j
                JOIN company c ON c.id = j.company_id
                LEFT JOIN job_posting_dup_group g ON g.id = j.dup_group_id
                WHERE j.id = $1
                {posting_lock}
                """,
                job_id,
            )
            if job is None:
                return None
            group_id = job["dup_group_id"] if job["collapsible"] else None
            # Serialize repeated clicks and duplicate-group members in the
            # database that owns the application, without writing to jobs.
            identity = f"group:{group_id}" if group_id is not None else f"job:{job_id}"
            await connection.fetchval(
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                f"application:{self.account_id}:{identity}",
            )
            posting_ids = [job_id]
            if group_id is not None:
                members = await jobs.fetch(
                    "SELECT id FROM job_posting WHERE dup_group_id = $1",
                    group_id,
                )
                posting_ids.extend(row["id"] for row in members)
            existing = await connection.fetchrow(
                """
                SELECT a.id
                FROM job_application a
                WHERE a.account_id = $1
                  AND a.job_posting_id = ANY($2::bigint[])
                ORDER BY a.id
                LIMIT 1
                """,
                self.account_id,
                posting_ids,
            )
            if existing:
                result = await self._get_application(connection, existing["id"])
                assert result is not None
                result["already_exists"] = True
                return result
            application_id = await connection.fetchval(
                """
                INSERT INTO job_application(
                    account_id, job_posting_id, company_snapshot, title_snapshot,
                    location_snapshot, apply_url_snapshot, stage, submitted_at,
                    task_state, last_open_stage
                ) VALUES ($1, $2, $3, $4, $5, $6, 'applied', $7,
                          'waiting', 'applied')
                RETURNING id
                """,
                self.account_id,
                job_id,
                job["company_name"],
                job["title"],
                _location_label(job["locations"]),
                job["source_url"] or job["apply_url"],
                _timestamp(submitted_at) if submitted_at else datetime.combine(date.today(), time.min, timezone.utc),
            )
            await connection.execute(
                """
                INSERT INTO job_application_event(
                    job_application_id, event_type, to_stage, occurred_at, note
                ) VALUES ($1, $2, $3, COALESCE($4, now()), $5)
                """,
                application_id,
                "stage_changed",
                "applied",
                None,
                None,
            )
            return await self._get_application(connection, application_id)

    async def create_external_application(
        self,
        *,
        company: str,
        title: str,
        url: str = "",
        location: str = "",
        note: str = "",
        submitted_at: str | None = None,
    ) -> dict[str, Any]:
        company, title, url = company.strip(), title.strip(), url.strip()
        parsed = urlsplit(url)
        if not company or not title:
            raise ValueError("company and title are required")
        if url and (parsed.scheme not in {"http", "https"} or not parsed.hostname):
            raise ValueError("application URL must be HTTP(S)")
        submitted = _timestamp(submitted_at) if submitted_at else datetime.combine(date.today(), time.min, timezone.utc)
        pool = self._ready()
        async with pool.acquire() as connection, connection.transaction():
            application_id = await connection.fetchval(
                """
                INSERT INTO job_application(
                    account_id, job_posting_id, company_snapshot, title_snapshot,
                    location_snapshot, apply_url_snapshot, stage, note,
                    submitted_at, task_state, last_open_stage
                ) VALUES ($1, NULL, $2, $3, $4, $5, 'applied', $6,
                          $7, 'waiting', 'applied')
                RETURNING id
                """,
                self.account_id,
                company,
                title,
                location.strip(),
                url or None,
                note,
                submitted,
            )
            await connection.execute(
                """
                INSERT INTO job_application_event(
                    job_application_id, event_type, to_stage, note
                ) VALUES ($1, 'stage_changed', 'applied', $2)
                """,
                application_id,
                note or None,
            )
            result = await self._get_application(connection, application_id)
            assert result is not None
            return result

    async def update_application(
        self, application_id: int, changes: dict[str, Any]
    ) -> dict[str, Any] | None:
        pool = self._ready()
        async with pool.acquire() as connection, connection.transaction():
            current = await connection.fetchrow(
                """
                SELECT
                    job_posting_id, company_snapshot, title_snapshot,
                    location_snapshot, apply_url_snapshot, stage, closed_reason,
                    submitted_at, last_open_stage
                FROM job_application
                WHERE id = $1 AND account_id = $2
                FOR UPDATE
                """,
                application_id,
                self.account_id,
            )
            if current is None:
                return None
            external = current["job_posting_id"] is None
            for request_name, column in (
                ("company", "company_snapshot"),
                ("title", "title_snapshot"),
                ("location", "location_snapshot"),
                ("apply_url_snapshot", "apply_url_snapshot"),
            ):
                if not external and request_name in changes and changes[request_name] != current[column]:
                    raise ValueError("discovered application snapshots cannot be edited")

            stage = changes.get("stage", current["stage"])
            closed_reason = changes.get("closed_reason", current["closed_reason"])
            if stage not in VALID_APPLICATION_STAGES:
                raise ValueError("unknown application stage")
            if stage == "closed" and closed_reason not in VALID_CLOSED_REASONS:
                raise ValueError("closed_reason is required when stage is closed")
            if stage != "closed":
                if changes.get("closed_reason") is not None:
                    raise ValueError("closed_reason is only valid when stage is closed")
                closed_reason = None
            stage_changed = stage != current["stage"]

            values: dict[str, Any] = {
                "stage": stage,
                "closed_reason": closed_reason,
                "last_open_stage": (current["last_open_stage"] if current["stage"] == "closed" else current["stage"]) if stage == "closed" else stage,
            }
            if external:
                if "company" in changes:
                    company = str(changes["company"] or "").strip()
                    if not company:
                        raise ValueError("company is required")
                    values["company_snapshot"] = company
                if "title" in changes:
                    title = str(changes["title"] or "").strip()
                    if not title:
                        raise ValueError("title is required")
                    values["title_snapshot"] = title
                if "location" in changes:
                    values["location_snapshot"] = str(changes["location"] or "").strip()
                if "apply_url_snapshot" in changes:
                    url = str(changes["apply_url_snapshot"] or "").strip()
                    parsed = urlsplit(url)
                    if url and (parsed.scheme not in {"http", "https"} or not parsed.hostname):
                        raise ValueError("application URL must be HTTP(S)")
                    values["apply_url_snapshot"] = url or None
            for name in ("next_action", "note", "waiting_for"):
                if name in changes:
                    values[name] = changes[name] or ""
            if "task_state" in changes:
                if changes["task_state"] not in {"action", "waiting"}:
                    raise ValueError("unknown task state")
                values["task_state"] = changes["task_state"]
            if "resume_variant" in changes:
                values["resume_variant"] = str(changes["resume_variant"] or "").strip() or None
            if "submitted_at" in changes:
                values["submitted_at"] = _timestamp(changes["submitted_at"])
            if "next_due_at" in changes:
                values["next_due_at"] = _timestamp(changes["next_due_at"], end_of_day=True)

            assignments: list[str] = []
            params: list[Any] = []
            for column, value in values.items():
                params.append(value)
                assignments.append(f"{column} = ${len(params)}")
            params.extend((application_id, self.account_id))
            await connection.execute(
                f"""
                UPDATE job_application
                SET {', '.join(assignments)}, updated_at = now()
                WHERE id = ${len(params) - 1} AND account_id = ${len(params)}
                """,
                *params,
            )
            if stage_changed:
                await connection.execute(
                    """
                    INSERT INTO job_application_event(
                        job_application_id, event_type, to_stage, occurred_at, note
                    ) VALUES ($1, 'stage_changed', $2, now(), $3)
                    """,
                    application_id,
                    stage,
                    changes.get("activity") or None,
                )
            elif changes.get("activity"):
                await connection.execute(
                    """
                    INSERT INTO job_application_event(job_application_id, event_type, note)
                    VALUES ($1, 'details_updated', $2)
                    """,
                    application_id,
                    changes["activity"],
                )
            return await self._get_application(connection, application_id)

    async def delete_application(self, application_id: int) -> bool:
        result = await self._ready().execute(
            "DELETE FROM job_application WHERE id = $1 AND account_id = $2",
            application_id,
            self.account_id,
        )
        return result == "DELETE 1"

    @staticmethod
    def _feedback(row: asyncpg.Record | dict[str, Any]) -> dict[str, Any]:
        corrections = row.get("corrections")
        if isinstance(corrections, str):
            corrections = json.loads(corrections)
        return {
            "job_id": row["job_posting_id"],
            "kind": row["kind"],
            "skip_reason": row.get("skip_reason"),
            "corrections": corrections if isinstance(corrections, list) else [],
            "created_at": _iso(row.get("created_at")),
            "updated_at": _iso(row.get("updated_at")),
        }

    async def set_feedback(
        self,
        job_id: int,
        *,
        kind: str,
        skip_reason: str | None = None,
        corrections: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any] | None:
        """Hide a posting from this account's feed, or replace why it is hidden.

        Upsert, so a skip can gain its reason after the fact. ``created_at`` is
        kept on update: it orders the Hidden list by when the posting left the
        feed. Returns None when the posting does not exist.
        """
        # Posting existence belongs to the jobs database. Personal feedback can
        # refer to its ids without a local copy of the posting in the accounts DB.
        if not await self._jobs_ready().fetchval(
            "SELECT EXISTS (SELECT 1 FROM job_posting WHERE id = $1)", job_id
        ):
            return None
        row = await self._ready().fetchrow(
            """
            INSERT INTO job_feedback (
                account_id, job_posting_id, kind, skip_reason, corrections
            ) VALUES ($1, $2, $3, $4, $5::jsonb)
            ON CONFLICT (account_id, job_posting_id) DO UPDATE SET
                kind = EXCLUDED.kind,
                skip_reason = EXCLUDED.skip_reason,
                corrections = EXCLUDED.corrections,
                updated_at = now()
            RETURNING job_posting_id, kind, skip_reason, corrections,
                      created_at, updated_at
            """,
            self.account_id,
            job_id,
            kind,
            skip_reason,
            json.dumps(corrections or []),
        )
        return None if row is None else self._feedback(row)

    async def delete_feedback(self, job_id: int) -> bool:
        result = await self._ready().execute(
            "DELETE FROM job_feedback WHERE account_id = $1 AND job_posting_id = $2",
            self.account_id,
            job_id,
        )
        return result == "DELETE 1"

    async def list_feedback(
        self, *, limit: int = 100, offset: int = 0
    ) -> dict[str, Any]:
        """The account's Hidden list, most recently hidden first."""
        pool = self._ready()
        rows, total = await asyncio.gather(
            pool.fetch(
                """
                SELECT job_posting_id, kind, skip_reason, corrections, created_at, updated_at
                FROM job_feedback
                WHERE account_id = $1
                ORDER BY created_at DESC, job_posting_id DESC
                LIMIT $2 OFFSET $3
                """,
                self.account_id,
                max(1, min(limit, 500)),
                max(0, offset),
            ),
            pool.fetchval(
                "SELECT COUNT(*) FROM job_feedback WHERE account_id = $1",
                self.account_id,
            ),
        )
        jobs = await self._jobs_ready().fetch(
            f"""
            SELECT {JOB_COLUMNS}
            FROM job_posting j
            JOIN company c ON c.id = j.company_id
            LEFT JOIN company_logo logo ON logo.company_id = j.company_id
            WHERE j.id = ANY($1::bigint[])
            """,
            [row["job_posting_id"] for row in rows],
        ) if rows else []
        by_id = {job["id"]: self._job(job) for job in jobs}
        return {
            "total": total,
            "hidden": [
                {**self._feedback(row), "job": by_id[row["job_posting_id"]]}
                for row in rows if row["job_posting_id"] in by_id
            ],
        }
