"""Labels the xjobscore pipeline already computed, described by its mirrored registry/ YAML."""

import functools
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

REGISTRY = Path(__file__).parent / "registry" / "job-posting"

SOFTWARE_FILTER = "software"
FINANCE_FILTER = "finance"
UNLABELED_FILTER = "unlabeled"
BIOENGINEERING_FILTER = "bioengineering"
FOCUS_FILTERS = ("med_device", "clinical_affairs", "biotech")


def _registry(name: str) -> Any:
    return yaml.safe_load((REGISTRY / name).read_text(encoding="utf-8"))


@functools.cache
def degree_fields() -> tuple[str, ...]:
    return tuple(row["name"] for row in _registry("types.yaml")["degree"])


@dataclass(frozen=True, slots=True)
class Skill:
    id: str
    name: str
    label: str  # the compact display label, defaulting to the name
    category: str
    terms: tuple[str, ...]  # casefolded id, name, label and every alias, for search


@functools.cache
def skills() -> dict[str, Skill]:
    labels = _registry("skill-labels.yaml")["label"]
    result = {}
    for row in _registry("skills.yaml")["skill"]:
        label = labels.get(row["id"], row["name"])
        aliases = (row.get(key) or () for key in ("aliases", "case_sensitive_aliases", "ambiguous_aliases"))
        terms = (row["id"], row["name"], label, *(alias for group in aliases for alias in group))
        result[row["id"]] = Skill(row["id"], row["name"], label, row["category"], tuple(t.casefold() for t in terms))
    return result


@functools.cache
def _skills_by_name() -> dict[str, Skill]:
    return {skill.name.casefold(): skill for skill in skills().values()}


def skill_details(values: Any) -> list[dict[str, Any]]:
    """Display metadata for a posting's stored skills (canonical ids, or legacy names)."""
    if not isinstance(values, list):
        return []
    details: dict[str, dict[str, Any]] = {}  # first occurrence of each id, in order
    for value in values:
        if not isinstance(value, str) or not value.strip():
            continue
        raw = value.strip()
        skill = skills().get(raw) or _skills_by_name().get(raw.casefold())
        if skill is None:
            detail = {"id": raw, "name": raw, "label": raw, "category": None}
        else:
            detail = {"id": skill.id, "name": skill.name, "label": skill.label, "category": skill.category}
        details.setdefault(detail["id"], detail)
    return list(details.values())


def skill_ids_matching(text: str) -> tuple[str, ...]:
    """Skills a search term names: any spelling equal to it, or containing it once it is 3+ characters."""
    needle = text.strip().casefold()
    if not needle:
        return ()
    return tuple(
        skill.id for skill in skills().values()
        if any(needle == term or (len(needle) >= 3 and needle in term) for term in skill.terms)
    )
