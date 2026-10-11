"""The public JSON shape of a posting."""

from typing import Any

from ..db import iso, json_as
from ..taxonomy import FOCUS_FILTERS, skill_details

# Columns `job()` reads, over `job_posting j JOIN company c` and `LEFT JOIN company_logo logo`.
JOB_COLUMNS = """
    j.id, j.source, c.name AS company_name, j.title,
    j.locations, j.source_url, j.apply_url, j.posted_at,
    j.first_seen_at, j.last_seen_at, j.status, j.attributes,
    j.job_type, j.remote, j.part_time, j.job_domain,
    j.company_id, (logo.bytes IS NOT NULL) AS has_logo
"""

_LOCATION_FIELDS = ("country", "state", "city")
_COUNTRY_NAMES = {"US": "United States"}
_LOCATION_DISPLAY_LIMIT = 3


def locations(value: Any) -> list[dict[str, str | None]]:
    """Normalized locations: trimmed, country upper-cased, empty and repeated ones dropped."""
    result: list[dict[str, str | None]] = []
    for item in json_as(value, list):
        if not isinstance(item, dict):
            continue
        row = {field: str(item[field]).strip() if item.get(field) else None for field in _LOCATION_FIELDS}
        if row["country"]:
            row["country"] = row["country"].upper()
        if any(row.values()) and row not in result:
            result.append(row)
    return result


def location_label(value: Any) -> str | None:
    """A compact label from normalized locations, never from raw source text."""
    labels: list[str] = []
    for location in locations(value):
        country, state, city = location["country"], location["state"], location["city"]
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


def _other_sources(value: Any) -> list[dict[str, Any]]:
    """Active alternate postings, as just enough provenance to offer another source."""
    return [
        {
            "source": item["source"],
            "url": item["url"],
            "posted_at": iso(item.get("posted_at")),
            "first_seen_at": iso(item.get("first_seen_at")),
        }
        for item in json_as(value, list)
        if isinstance(item, dict)
        and all(isinstance(item.get(key), str) and item[key].strip() for key in ("source", "url"))
    ]


def job(row: Any) -> dict[str, Any]:
    attributes = json_as(row.get("attributes"), dict)
    normalized = locations(row.get("locations"))
    summary = attributes.get("summary")
    remote = row.get("remote")
    return {
        "id": row["id"],
        "source": row.get("source"),
        "source_url": row.get("source_url"),
        "company": row.get("company_name") or "Unknown company",
        # Null tells the client to draw initials instead.
        "logo": f"/api/companies/{row['company_id']}/logo" if row.get("has_logo") else None,
        "title": row["title"],
        "summary": summary.strip() if isinstance(summary, str) and summary.strip() else None,
        "locations": normalized,
        "location": location_label(normalized),
        # The posting page first: a stored apply_url skips the description.
        "apply_url": row.get("source_url") or row.get("apply_url"),
        "posted_at": iso(row.get("posted_at")),
        # Most feeds publish no posting date, so the client says "Added 2d ago" from this.
        "first_seen_at": iso(row.get("first_seen_at")),
        "last_seen_at": iso(row.get("last_seen_at")),
        "status": row.get("status"),
        "job_type": row.get("job_type"),
        # Vendors whose parse-time rules are not transcribed yet still carry attributes.remote.
        "remote": remote if remote and remote != "unknown" else attributes.get("remote") or "unknown",
        # Schedule, orthogonal to job_type: a part-time internship is "intern" and "yes".
        "part_time": row.get("part_time") or "unknown",
        "job_domain": row.get("job_domain"),
        # The Focus label: a bioengineering chip the pipeline stored, else the domain.
        "focus": next((chip for chip in FOCUS_FILTERS if chip in (attributes.get("focus") or ())), row.get("job_domain")),
        "attributes": attributes,
        "skills": skill_details(attributes.get("skills")),
        "other_sources": _other_sources(row.get("other_sources")),
    }
