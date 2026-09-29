"""PostgreSQL persistence for the live OneShot UI.

The repository speaks only the tables declared in the root ``schema.sql``.
Harvesting and canonicalization belong to the core pipeline; OneShot is a
reader for jobs and a writer for the single-user application tracker.
"""

import asyncio
import functools
import json
from datetime import date, datetime, time, timedelta, timezone
from time import monotonic
from typing import Any, Iterable
from urllib.parse import urlsplit
from uuid import UUID

import asyncpg

from oneshot_taxonomy.bioengineering import (
    BIOENGINEERING_FILTER,
    DIRECT_DOMAIN_PATTERN,
    GENERIC_TECHNICAL_PATTERN,
    NONTECHNICAL_PATTERN,
    TECHNICAL_OR_STUDENT_PATTERN,
)
from oneshot_taxonomy.job_domain import (
    ADJACENT_DISCIPLINE_PATTERN,
    FINANCE_FILTER,
    FINANCE_FUNCTION_PATTERN,
    IT_ROLE_PATTERN,
    PROGRAM_NOISE_PATTERN,
    QUANT_PATTERN,
    QUANT_ROLE_PATTERN,
    SOFTWARE_FILTER,
    SOFTWARE_RESCUE_PATTERN,
    SOFTWARE_STRONG_PATTERN,
    SOFTWARE_WEAK_PATTERN,
    STUDENT_DOMAIN_GUARD_PATTERN,
    STUDENT_DOMAIN_PATTERN,
    UNLABELED_FILTER,
)
from oneshot_taxonomy.job_domain import NONTECHNICAL_PATTERN as DOMAIN_NONTECHNICAL_PATTERN
from oneshot_taxonomy.coverage_snapshot import board_state as _board_state
from oneshot_taxonomy.coverage_snapshot import empty_snapshot
from oneshot_taxonomy.degrees import canon as degree_canon
from oneshot_taxonomy.skill_labels import labels as skill_labels
from oneshot_taxonomy.skills import canon

from .location_policy import (
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
# Domain labels are computed from the title at query time, so -- like
# UNCLASSIFIED above -- nothing is stored and the residual pool still needs an
# addressable name for manual review.
DOMAIN_FILTERS = (SOFTWARE_FILTER, FINANCE_FILTER, UNLABELED_FILTER)
VALID_DEGREE_FIELDS = frozenset(
    {
        *(field.name for field in degree_canon()),
        BIOENGINEERING_FILTER,
        *DOMAIN_FILTERS,
    }
)
VALID_APPLICATION_STAGES = frozenset(
    {"considering", "applied", "assessment", "interview", "offer", "closed"}
)
VALID_CLOSED_REASONS = frozenset({"rejected", "withdrawn", "no_reply"})

_COUNTRY_NAMES = {"US": "United States"}
_LOCATION_FIELDS = ("country", "state", "city")
_LOCATION_DISPLAY_LIMIT = 3
_BIO_COMPANY_CACHE_SECONDS = 300


class _CompanyCohortCache:
    def __init__(self) -> None:
        self.ids: tuple[int, ...] = ()
        self.expires_at = 0.0
        self.lock = asyncio.Lock()


def _domain_predicates(
    bind: Any, quant_company_ids: Iterable[int], requested: Iterable[str]
) -> dict[str, str]:
    """Render `job_domain.classify` as SQL, one predicate per requested domain.

    `unlabeled` is derived from the other two rather than written out, so the
    review queue cannot drift away from the labels it is the complement of.

    Only the requested domains are built, and each pattern binds at most once:
    a parameter bound for a predicate that never reaches the SQL would be
    rejected by the server as an argument-count mismatch.
    """
    markers: dict[str, str] = {}
    employer_marker: list[str] = []

    def marker(pattern: str) -> str:
        # `job_domain` patterns are bounded for both engines, so the same
        # constant drives `re` in Python and `~*` here.
        if pattern not in markers:
            markers[pattern] = bind(pattern)
        return markers[pattern]

    def title() -> str:
        return f"regexp_replace(j.title, {marker(PROGRAM_NOISE_PATTERN)}, ' ', 'gi')"

    def matches(pattern: str) -> str:
        return f"{title()} ~* {marker(pattern)}"

    def software() -> str:
        # Stage 1: strong evidence, minus the adjacent-discipline steal.
        strong = (
            f"({matches(SOFTWARE_STRONG_PATTERN)} AND NOT "
            f"({matches(ADJACENT_DISCIPLINE_PATTERN)} AND NOT "
            f"{matches(SOFTWARE_RESCUE_PATTERN)}))"
        )
        # Stage 3: weak evidence, readable only once the stage 2 veto clears.
        weak = (
            f"(NOT {matches(DOMAIN_NONTECHNICAL_PATTERN)} AND "
            f"{matches(SOFTWARE_WEAK_PATTERN)} AND NOT "
            f"{matches(ADJACENT_DISCIPLINE_PATTERN)})"
        )
        # Stage 3b: a software domain noun paired with a student role noun,
        # minus its non-software qualifiers.  Narrow by design -- see
        # `STUDENT_DOMAIN_PATTERN`.
        program = (
            f"(NOT {matches(DOMAIN_NONTECHNICAL_PATTERN)} AND "
            f"{matches(STUDENT_DOMAIN_PATTERN)} AND NOT "
            f"{matches(STUDENT_DOMAIN_GUARD_PATTERN)})"
        )
        return f"({strong} OR {weak} OR {program})"

    def finance() -> str:
        # Stages 4 and 5 are reached only by falling through 1 to 3.
        strong = (
            f"({matches(SOFTWARE_STRONG_PATTERN)} AND NOT "
            f"({matches(ADJACENT_DISCIPLINE_PATTERN)} AND NOT "
            f"{matches(SOFTWARE_RESCUE_PATTERN)}))"
        )
        if not employer_marker:
            employer_marker.append(bind(list(quant_company_ids)))
        employer = f"c.id = ANY({employer_marker[0]}::bigint[])"
        return (
            f"(NOT {strong} AND NOT {matches(DOMAIN_NONTECHNICAL_PATTERN)} "
            f"AND NOT ({matches(SOFTWARE_WEAK_PATTERN)} AND NOT "
            f"{matches(ADJACENT_DISCIPLINE_PATTERN)}) "
            f"AND NOT ({matches(STUDENT_DOMAIN_PATTERN)} AND NOT "
            f"{matches(STUDENT_DOMAIN_GUARD_PATTERN)}) "
            f"AND NOT {matches(FINANCE_FUNCTION_PATTERN)} "
            f"AND ({matches(QUANT_PATTERN)} OR ({employer} AND "
            f"{matches(QUANT_ROLE_PATTERN)} AND NOT "
            f"{matches(IT_ROLE_PATTERN)})))"
        )

    predicates: dict[str, str] = {}
    for name in requested:
        if name == SOFTWARE_FILTER:
            predicates[name] = software()
        elif name == FINANCE_FILTER:
            predicates[name] = finance()
        elif name == UNLABELED_FILTER:
            predicates[name] = f"(NOT {software()} AND NOT {finance()})"
    return predicates


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
        _bio_company_cache: _CompanyCohortCache | None = None,
        _quant_company_cache: _CompanyCohortCache | None = None,
    ) -> None:
        self.dsn = dsn
        self.account_id = account_id
        self.pool = pool
        self._owns_pool = pool is None
        self._bio_company_cache = _bio_company_cache or _CompanyCohortCache()
        self._quant_company_cache = (
            _quant_company_cache or _CompanyCohortCache()
        )

    async def connect(self) -> None:
        if self.pool is not None:
            return
        if not self.dsn:
            raise RuntimeError(
                "No PostgreSQL DSN. Set DATABASE_URL."
            )
        self.pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=8)

    async def close(self) -> None:
        if self.pool is not None and self._owns_pool:
            await self.pool.close()
            self.pool = None

    def _ready(self) -> asyncpg.Pool:
        if self.pool is None:
            raise RuntimeError("PostgresRepository.connect() has not been called")
        return self.pool

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
            _bio_company_cache=self._bio_company_cache,
            _quant_company_cache=self._quant_company_cache,
        )

    async def _bioengineering_company_ids(self) -> tuple[int, ...]:
        """Return the measured bio-employer prior, shared briefly across requests."""
        cache = self._bio_company_cache
        if monotonic() < cache.expires_at:
            return cache.ids
        async with cache.lock:
            if monotonic() < cache.expires_at:
                return cache.ids
            rows = await self._ready().fetch(
                """
                WITH company_postings AS MATERIALIZED (
                    SELECT company_id, COUNT(*) AS posting_count
                    FROM job_posting
                    WHERE status = 'active'
                    GROUP BY company_id
                ), company_titles AS MATERIALIZED (
                    SELECT company_id, COUNT(*) AS direct_count
                    FROM job_posting
                    WHERE status = 'active'
                      AND (attributes -> 'degree') ?| ARRAY[
                          'biotech', 'med_device', 'clinical_affairs'
                      ]::text[]
                      AND title ~* $1
                    GROUP BY company_id
                )
                SELECT c.id
                FROM company c
                JOIN company_postings cp ON cp.company_id = c.id
                LEFT JOIN company_titles ct ON ct.company_id = c.id
                WHERE c.labels ? 'biotech'
                   OR (
                       COALESCE(ct.direct_count, 0) >= 5
                       AND ct.direct_count::numeric / cp.posting_count >= 0.02
                   )
                   OR (
                       COALESCE(ct.direct_count, 0) >= 3
                       AND ct.direct_count::numeric / cp.posting_count >= 0.04
                   )
                """,
                DIRECT_DOMAIN_PATTERN,
            )
            cache.ids = tuple(int(row["id"]) for row in rows)
            cache.expires_at = monotonic() + _BIO_COMPANY_CACHE_SECONDS
            return cache.ids

    async def _quant_company_ids(self) -> tuple[int, ...]:
        """Return the measured quant-employer prior, shared briefly across requests."""
        cache = self._quant_company_cache
        if monotonic() < cache.expires_at:
            return cache.ids
        async with cache.lock:
            if monotonic() < cache.expires_at:
                return cache.ids
            # Measured over every active posting rather than the student slice:
            # the same 40% threshold over the full corpus yields trading firms
            # only, while the student slice alone admits insurers on 3 rows.
            rows = await self._ready().fetch(
                """
                WITH company_postings AS MATERIALIZED (
                    SELECT company_id, COUNT(*) AS posting_count
                    FROM job_posting
                    WHERE status = 'active'
                    GROUP BY company_id
                ), company_titles AS MATERIALIZED (
                    SELECT company_id, COUNT(*) AS quant_count
                    FROM job_posting
                    WHERE status = 'active'
                      AND title ~* $1
                      AND NOT (title ~* $2)
                    GROUP BY company_id
                )
                SELECT c.id
                FROM company c
                JOIN company_postings cp ON cp.company_id = c.id
                JOIN company_titles ct ON ct.company_id = c.id
                WHERE cp.posting_count >= 3
                  AND ct.quant_count::numeric / cp.posting_count >= 0.40
                """,
                QUANT_PATTERN,
                FINANCE_FUNCTION_PATTERN,
            )
            cache.ids = tuple(int(row["id"]) for row in rows)
            cache.expires_at = monotonic() + _BIO_COMPANY_CACHE_SECONDS
            return cache.ids

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
            "apply_url": row.get("apply_url") or row.get("source_url"),
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
        pool = self._ready()
        return await pool.fetchval(
            "SELECT bytes FROM company_logo WHERE company_id = $1", company_id
        )

    async def list_jobs(
        self,
        *,
        job_types: Iterable[str] = (),
        degree_fields: Iterable[str] = (),
        exclude_job_ids: Iterable[int] = (),
        hide_tracked: bool = True,
        q: str = "",
        sort: str = "fresh",
        limit: int = 100,
        offset: int = 0,
    ) -> dict[str, Any]:
        fields = tuple(dict.fromkeys(degree_fields))
        # BioTech is the public umbrella.  It includes its broad parsed focus
        # tag as well as the stricter title/employer recommendation cohort that
        # formerly appeared as a separate BioEngineering filter.  Keep the
        # internal BioEngineering value working for bookmarked API requests.
        bioengineering_requested = (
            BIOENGINEERING_FILTER in fields or "biotech" in fields
        )
        bio_company_ids = (
            await self._bioengineering_company_ids()
            if bioengineering_requested
            else ()
        )
        domains_requested = tuple(f for f in fields if f in DOMAIN_FILTERS)
        quant_company_ids = (
            await self._quant_company_ids() if domains_requested else ()
        )
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
            # requests and the BioTech cohort below keep working.
            if bioengineering_requested:
                direct_marker = bind(DIRECT_DOMAIN_PATTERN)
                technical_marker = bind(TECHNICAL_OR_STUDENT_PATTERN)
                nontechnical_marker = bind(NONTECHNICAL_PATTERN)
                generic_marker = bind(GENERIC_TECHNICAL_PATTERN)
                company_marker = bind(list(bio_company_ids))
                bio_employer = f"c.id = ANY({company_marker}::bigint[])"
                recommendation = (
                    f"NOT (j.title ~* {nontechnical_marker}) AND ("
                    f"(j.title ~* {direct_marker} AND j.title ~* {technical_marker}) "
                    f"OR ({bio_employer} AND j.title ~* {generic_marker}))"
                )
                field_clauses.append(f"({recommendation})")
            if domains_requested:
                domain_sql = _domain_predicates(
                    bind, quant_company_ids, domains_requested
                )
                field_clauses.extend(domain_sql[name] for name in domains_requested)
            # Only BioTech and the domain labels contribute predicates, so
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
            search = [f"c.name ILIKE {marker}", f"j.title ILIKE {marker}"]
            skill_ids = _skill_search_ids(q)
            if skill_ids:
                skill_marker = bind(list(skill_ids))
                search.append(
                    f"(j.attributes -> 'skills') ?| {skill_marker}::text[]"
                )
            clauses.append(f"({' OR '.join(search)})")
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
        pool = self._ready()
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
                    AT TIME ZONE '{RECENCY_TIME_ZONE}')::date DESC NULLS LAST,
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
                COALESCE(j.posted_at, j.first_seen_at) DESC NULLS LAST,
                j.id DESC
            """
        limit_marker = bind(max(1, min(limit, 500)))
        offset_marker = bind(max(0, offset))
        page_read = pool.fetch(
            f"""
            SELECT
                j.id, j.source, c.name AS company_name, j.title,
                j.locations, j.source_url, j.apply_url, j.posted_at,
                j.first_seen_at, j.last_seen_at, j.status, j.attributes,
                j.job_type, j.remote, j.part_time,
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
                            NULLIF(BTRIM(sibling.apply_url), ''),
                            NULLIF(BTRIM(sibling.source_url), '')
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
        row = await self._ready().fetchrow(
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
                updated_at
            FROM job_application a
            WHERE a.account_id = $1
            ORDER BY
                CASE a.stage
                    WHEN 'offer' THEN 1
                    WHEN 'interview' THEN 2
                    WHEN 'assessment' THEN 3
                    WHEN 'applied' THEN 4
                    WHEN 'considering' THEN 5
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
    ) -> dict[str, Any] | None:
        pool = self._ready()
        async with pool.acquire() as connection, connection.transaction():
            job = await connection.fetchrow(
                """
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
                FOR SHARE OF j
                """,
                job_id,
            )
            if job is None:
                return None
            group_id = job["dup_group_id"] if job["collapsible"] else None
            if group_id is not None:
                # Requests for two members of one group must serialize before
                # checking for an existing application. The application table's
                # exact-posting UNIQUE cannot express this derived identity.
                await connection.fetchval(
                    "SELECT id FROM job_posting_dup_group WHERE id = $1 FOR UPDATE",
                    group_id,
                )
            existing = await connection.fetchrow(
                """
                SELECT a.id
                FROM job_application a
                JOIN job_posting tracked ON tracked.id = a.job_posting_id
                WHERE a.account_id = $1
                  AND (
                      a.job_posting_id = $2
                      OR (
                          $3::uuid IS NOT NULL
                          AND tracked.dup_group_id = $3::uuid
                      )
                  )
                ORDER BY a.id
                LIMIT 1
                """,
                self.account_id,
                job_id,
                group_id,
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
                    location_snapshot, apply_url_snapshot, stage
                ) VALUES ($1, $2, $3, $4, $5, $6, 'considering')
                RETURNING id
                """,
                self.account_id,
                job_id,
                job["company_name"],
                job["title"],
                _location_label(job["locations"]),
                job["apply_url"] or job["source_url"],
            )
            await connection.execute(
                """
                INSERT INTO job_application_event(
                    job_application_id, event_type, to_stage, occurred_at, note
                ) VALUES ($1, $2, $3, COALESCE($4, now()), $5)
                """,
                application_id,
                "stage_changed",
                "considering",
                None,
                None,
            )
            return await self._get_application(connection, application_id)

    async def create_external_application(
        self,
        *,
        company: str,
        title: str,
        url: str,
        location: str = "",
        note: str = "",
    ) -> dict[str, Any]:
        company, title, url = company.strip(), title.strip(), url.strip()
        parsed = urlsplit(url)
        if not company or not title:
            raise ValueError("company and title are required")
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("application URL must be HTTP(S)")
        pool = self._ready()
        async with pool.acquire() as connection, connection.transaction():
            application_id = await connection.fetchval(
                """
                INSERT INTO job_application(
                    account_id, job_posting_id, company_snapshot, title_snapshot,
                    location_snapshot, apply_url_snapshot, stage, note
                ) VALUES ($1, NULL, $2, $3, $4, $5, 'considering', $6)
                RETURNING id
                """,
                self.account_id,
                company,
                title,
                location.strip(),
                url,
                note,
            )
            await connection.execute(
                """
                INSERT INTO job_application_event(
                    job_application_id, event_type, to_stage, note
                ) VALUES ($1, 'stage_changed', 'considering', $2)
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
                    submitted_at
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
            for name in ("next_action", "note"):
                if name in changes:
                    values[name] = changes[name] or ""
            if "resume_variant" in changes:
                values["resume_variant"] = str(changes["resume_variant"] or "").strip() or None
            if "submitted_at" in changes:
                values["submitted_at"] = _timestamp(changes["submitted_at"])
            if "next_due_at" in changes:
                values["next_due_at"] = _timestamp(changes["next_due_at"], end_of_day=True)
            if stage_changed and stage == "applied":
                submitted = values.get("submitted_at") or current["submitted_at"] or datetime.now(timezone.utc)
                values["submitted_at"] = submitted
                values.setdefault("next_action", "Follow up if no response")
                values.setdefault("next_due_at", submitted + timedelta(days=14))

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
                    changes.get("note") or None,
                )
            return await self._get_application(connection, application_id)

    async def delete_application(self, application_id: int) -> bool:
        result = await self._ready().execute(
            "DELETE FROM job_application WHERE id = $1 AND account_id = $2",
            application_id,
            self.account_id,
        )
        return result == "DELETE 1"
