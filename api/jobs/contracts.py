"""Shared job columns and filter values used by the serving repository."""

from ..taxonomy import (
    BIOENGINEERING_FILTER, FINANCE_FILTER, SOFTWARE_FILTER, UNLABELED_FILTER,
)
from ..taxonomy.degrees import canon as degree_canon

DEFAULT_JOB_TYPES = ("intern", "coop", "student", "new_grad", "research")
# Storage uses NULL for an unclassified posting; the API exposes a named filter.
UNCLASSIFIED = "unclassified"
VALID_JOB_TYPES = frozenset((*DEFAULT_JOB_TYPES, UNCLASSIFIED))
DOMAIN_FILTERS = (SOFTWARE_FILTER, FINANCE_FILTER, UNLABELED_FILTER)
VALID_DEGREE_FIELDS = frozenset({
    *(field.name for field in degree_canon()), BIOENGINEERING_FILTER, *DOMAIN_FILTERS,
})

# Over job_posting j JOIN company c and LEFT JOIN company_logo logo.
JOB_COLUMNS = """
    j.id, j.source, c.name AS company_name, j.title,
    j.locations, j.source_url, j.apply_url, j.posted_at,
    j.first_seen_at, j.last_seen_at, j.status, j.attributes,
    j.job_type, j.remote, j.part_time, j.job_domain,
    j.company_id, (logo.bytes IS NOT NULL) AS has_logo
"""
