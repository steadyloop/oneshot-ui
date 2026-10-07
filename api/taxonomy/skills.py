"""Load validated skill metadata for API display and search."""

from __future__ import annotations

import functools
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import yaml

__all__ = ["CATEGORIES", "SKILLS_PATH", "Skill", "SkillsError", "canon"]

SKILLS_PATH = Path(__file__).parent / "registry" / "job-posting" / "skills.yaml"
CATEGORIES = (
    "language",
    "library",
    "tool",
    "platform",
    "method",
    "concept",
    "framework",
    "datastore",
    "protocol",
    "format",
    "hardware",
)

_FIELDS = {
    "id",
    "name",
    "category",
    "aliases",
    "case_sensitive_aliases",
    "ambiguous_aliases",
    # Retained for compatibility with older custom dictionaries. New files
    # should put only the aliases that require exact case in the field above.
    "case_sensitive",
}
_GROUP_FIELDS = {"id", "name", "skill_ids"}
_ID = re.compile(r"[a-z0-9][a-z0-9-]*\Z")


class SkillsError(ValueError):
    """The skill canon is malformed or internally inconsistent."""


@dataclass(frozen=True, slots=True)
class Skill:
    """One validated entry in the skill canon."""

    id: str
    name: str
    category: str
    aliases: tuple[str, ...]
    ambiguous_aliases: tuple[str, ...]
    case_sensitive: bool
    case_sensitive_aliases: tuple[str, ...] = ()


    @property
    def patterns(self) -> tuple[str, ...]:
        """Spellings eligible for automatic matching."""
        return self.aliases + self.case_sensitive_aliases


def _strings(value: object, field: str, where: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        raise SkillsError(f"{where}: {field} must be an array")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item:
            raise SkillsError(f"{where}: {field} must contain non-empty strings")
        result.append(item)
    return tuple(result)


def _entry(row: object, index: int, path: Path) -> Skill:
    where = f"{path}: skill[{index}]"
    if not isinstance(row, dict):
        raise SkillsError(f"{where} must be a mapping")

    unknown = sorted(set(row) - _FIELDS)
    if unknown:
        raise SkillsError(f"{where}: unknown key {unknown[0]!r}")

    skill_id = row.get("id")
    if not isinstance(skill_id, str) or not _ID.fullmatch(skill_id):
        raise SkillsError(f"{where}: {skill_id!r} is not a lowercase hyphenated id")

    name = row.get("name")
    if not isinstance(name, str) or not name:
        raise SkillsError(f"{where}: name must be a non-empty string")

    category = row.get("category")
    if category not in CATEGORIES:
        raise SkillsError(f"{where}: category must be one of {CATEGORIES}, got {category!r}")

    aliases = _strings(row.get("aliases", []), "aliases", where)
    sensitive_aliases = _strings(
        row.get("case_sensitive_aliases", []), "case_sensitive_aliases", where
    )
    ambiguous = _strings(row.get("ambiguous_aliases", []), "ambiguous_aliases", where)

    case_sensitive = row.get("case_sensitive", False)
    if not isinstance(case_sensitive, bool):
        raise SkillsError(f"{where}: case_sensitive must be a boolean")

    return Skill(
        id=skill_id,
        name=name,
        category=category,
        aliases=aliases,
        case_sensitive_aliases=sensitive_aliases,
        ambiguous_aliases=ambiguous,
        case_sensitive=case_sensitive,
    )


def _validate_claims(skills: Iterable[Skill], path: Path) -> None:
    """Reject aliases that could make resolution depend on declaration order."""
    exact: dict[str, str] = {}
    insensitive: dict[str, str] = {}

    for skill in skills:
        local: set[tuple[str, bool]] = set()
        claims = (
            *((alias, skill.case_sensitive) for alias in skill.aliases),
            *((alias, True) for alias in skill.case_sensitive_aliases),
            *((alias, False) for alias in skill.ambiguous_aliases),
        )
        for alias, case_sensitive in claims:
            key = (alias if case_sensitive else alias.casefold(), case_sensitive)
            if key in local:
                raise SkillsError(f"{path}: {alias!r} is repeated by {skill.id}")
            local.add(key)

            folded = alias.casefold()
            if case_sensitive:
                owner = exact.setdefault(alias, skill.id)
                # An insensitive spelling also matches this exact spelling.
                conflicting = insensitive.get(folded)
            else:
                owner = insensitive.setdefault(folded, skill.id)
                # Any exact spelling with the same case is reachable too.
                conflicting = next(
                    (claimed for text, claimed in exact.items() if text.casefold() == folded),
                    None,
                )

            if owner != skill.id:
                conflicting = owner
            if conflicting is not None and conflicting != skill.id:
                raise SkillsError(
                    f"{path}: {alias!r} is claimed by both {conflicting} and {skill.id}"
                )


def _validate_groups(groups: object, skill_ids: set[str], path: Path) -> None:
    """Validate display-only groups and their references to canonical skills."""
    if groups is None:
        return
    if not isinstance(groups, list):
        raise SkillsError(f"{path}: skill_group must be an array")

    seen: set[str] = set()
    for index, row in enumerate(groups):
        where = f"{path}: skill_group[{index}]"
        if not isinstance(row, dict):
            raise SkillsError(f"{where} must be a mapping")
        unknown = sorted(set(row) - _GROUP_FIELDS)
        if unknown:
            raise SkillsError(f"{where}: unknown key {unknown[0]!r}")

        group_id = row.get("id")
        if not isinstance(group_id, str) or not _ID.fullmatch(group_id):
            raise SkillsError(f"{where}: {group_id!r} is not a lowercase hyphenated id")
        if group_id in seen:
            raise SkillsError(f"{path}: duplicate skill group id {group_id!r}")
        seen.add(group_id)

        name = row.get("name")
        if not isinstance(name, str) or not name:
            raise SkillsError(f"{where}: name must be a non-empty string")
        members = _strings(row.get("skill_ids"), "skill_ids", where)
        if not members:
            raise SkillsError(f"{where}: skill_ids must not be empty")
        if len(set(members)) != len(members):
            raise SkillsError(f"{where}: skill_ids contains a duplicate")
        missing = next((member for member in members if member not in skill_ids), None)
        if missing is not None:
            raise SkillsError(f"{where}: unknown skill id {missing!r}")

def _load(path: Path) -> dict[str, Skill]:
    try:
        with path.open(encoding="utf-8") as handle:
            document = yaml.safe_load(handle)
    except (OSError, yaml.YAMLError) as exc:
        raise SkillsError(f"{path}: {exc}") from exc

    if not isinstance(document, dict):
        raise SkillsError(f"{path}: root must be a mapping")
    unknown_root = sorted(set(document) - {"skill", "skill_group"})
    if "skill" not in document or unknown_root:
        detail = (
            "missing 'skill'"
            if "skill" not in document
            else f"unknown key {unknown_root[0]!r}"
        )
        raise SkillsError(f"{path}: invalid root ({detail})")
    rows = document["skill"]
    if not isinstance(rows, list):
        raise SkillsError(f"{path}: skill must be an array")

    skills: dict[str, Skill] = {}
    for index, row in enumerate(rows):
        skill = _entry(row, index, path)
        if skill.id in skills:
            raise SkillsError(f"{path}: duplicate skill id {skill.id!r}")
        skills[skill.id] = skill

    if not skills:
        raise SkillsError(f"{path}: canon is empty")
    _validate_claims(skills.values(), path)
    _validate_groups(document.get("skill_group"), set(skills), path)
    return skills


@functools.lru_cache(maxsize=1)
def canon() -> dict[str, Skill]:
    """Return the validated canon keyed by skill id, loading it only once."""
    return _load(SKILLS_PATH)


def _casefold_with_offsets(text: str) -> tuple[str, list[int]]:
    """Casefold text while retaining normalized-index to source-index mapping."""
    parts: list[str] = []
    offsets: list[int] = []
    for source_index, character in enumerate(text):
        folded = character.casefold()
        parts.append(folded)
        offsets.extend([source_index] * len(folded))
    return "".join(parts), offsets


def _has_boundaries(text: str, start: int, end: int) -> bool:
    """Prevent aliases from matching inside larger alphanumeric tokens."""
    return (
        (start == 0 or not text[start - 1].isalnum())
        and (end == len(text) or not text[end].isalnum())
    )
