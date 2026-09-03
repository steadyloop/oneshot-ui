"""Match plain text against the canonical skills in ``registry/job-posting/skills.yaml``.

The matcher is a pure-Python Aho--Corasick automaton. It compiles the skill
aliases once and then scans each job description in linear time relative to the
description length plus the number of candidate hits.

Entries in ``aliases`` are matched case-insensitively, while entries in
``case_sensitive_aliases`` must match exactly. ``ambiguous_aliases`` document
spellings such as ``go`` and ``c`` that are intentionally excluded from
automatic extraction. The vocabulary is closed: no stemming, fuzzy matching,
or inferred synonyms are applied. Top-level ``skill_group`` entries are
display metadata and do not add patterns to the matcher.
"""

from __future__ import annotations

import functools
import hashlib
import re
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator

import yaml

__all__ = [
    "CATEGORIES",
    "SKILLS_PATH",
    "Skill",
    "SkillMatch",
    "SkillMatcher",
    "SkillsError",
    "canon",
    "extract",
    "finditer",
    "taxonomy_hash",
]

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
    def slug(self) -> str:
        """Backward-compatible name for the canonical skill identifier."""
        return self.id

    @property
    def patterns(self) -> tuple[str, ...]:
        """Spellings eligible for automatic matching."""
        return self.aliases + self.case_sensitive_aliases


@dataclass(frozen=True, slots=True)
class SkillMatch:
    """A non-overlapping skill occurrence in source text.

    ``start`` is inclusive and ``end`` is exclusive, matching Python's normal
    slice convention. ``text[start:end]`` is therefore always ``matched_text``.
    """

    skill_id: str
    alias: str
    matched_text: str
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class _Output:
    skill_id: str
    alias: str


@dataclass(slots=True)
class _Node:
    edges: dict[str, int]
    fail: int
    outputs: list[_Output]


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


@functools.lru_cache(maxsize=1)
def taxonomy_hash() -> str:
    """Return a stable fingerprint of the loaded taxonomy file revision."""
    try:
        payload = SKILLS_PATH.read_bytes()
    except OSError as exc:
        raise SkillsError(f"{SKILLS_PATH}: {exc}") from exc
    return hashlib.sha256(payload).hexdigest()


class _Automaton:
    """A compact Aho--Corasick trie for one case-sensitivity mode."""

    def __init__(self, patterns: Iterable[tuple[str, _Output]]) -> None:
        self._nodes = [_Node(edges={}, fail=0, outputs=[])]
        for pattern, output in patterns:
            state = 0
            for character in pattern:
                next_state = self._nodes[state].edges.get(character)
                if next_state is None:
                    next_state = len(self._nodes)
                    self._nodes[state].edges[character] = next_state
                    self._nodes.append(_Node(edges={}, fail=0, outputs=[]))
                state = next_state
            self._nodes[state].outputs.append(output)
        self._build_failure_links()

    def _build_failure_links(self) -> None:
        pending: deque[int] = deque(self._nodes[0].edges.values())
        while pending:
            state = pending.popleft()
            for character, child in self._nodes[state].edges.items():
                pending.append(child)
                fallback = self._nodes[state].fail
                while fallback and character not in self._nodes[fallback].edges:
                    fallback = self._nodes[fallback].fail
                self._nodes[child].fail = self._nodes[fallback].edges.get(character, 0)
                self._nodes[child].outputs.extend(
                    self._nodes[self._nodes[child].fail].outputs
                )

    def scan(self, text: str) -> Iterator[tuple[int, _Output]]:
        state = 0
        for end, character in enumerate(text, 1):
            while state and character not in self._nodes[state].edges:
                state = self._nodes[state].fail
            state = self._nodes[state].edges.get(character, 0)
            for output in self._nodes[state].outputs:
                yield end, output


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


class SkillMatcher:
    """Reusable Aho--Corasick matcher compiled from a skill canon."""

    def __init__(self, skills: Iterable[Skill]) -> None:
        insensitive: list[tuple[str, _Output]] = []
        sensitive: list[tuple[str, _Output]] = []
        for skill in skills:
            destination = sensitive if skill.case_sensitive else insensitive
            for alias in skill.aliases:
                pattern = alias if skill.case_sensitive else alias.casefold()
                destination.append((pattern, _Output(skill.id, alias)))
            for alias in skill.case_sensitive_aliases:
                sensitive.append((alias, _Output(skill.id, alias)))
        self._insensitive = _Automaton(insensitive)
        self._sensitive = _Automaton(sensitive)

    def _candidates(self, text: str) -> Iterator[SkillMatch]:
        folded, offsets = _casefold_with_offsets(text)
        for normalized_end, output in self._insensitive.scan(folded):
            normalized_start = normalized_end - len(output.alias.casefold())
            start = offsets[normalized_start]
            end = offsets[normalized_end - 1] + 1
            if _has_boundaries(text, start, end):
                yield SkillMatch(output.skill_id, output.alias, text[start:end], start, end)

        for end, output in self._sensitive.scan(text):
            start = end - len(output.alias)
            if _has_boundaries(text, start, end):
                yield SkillMatch(output.skill_id, output.alias, text[start:end], start, end)

    def finditer(self, text: str) -> Iterator[SkillMatch]:
        """Yield non-overlapping occurrences using leftmost-longest selection."""
        if not text:
            return

        # A list indexed by source offset keeps overlap resolution O(text + hits),
        # rather than sorting every hit and adding an O(hits log hits) tail to the
        # automaton scan. Job descriptions are small enough that one reference per
        # source character is a useful speed/memory tradeoff.
        candidates: list[SkillMatch | None] = [None] * len(text)
        for match in self._candidates(text):
            current = candidates[match.start]
            match_length = match.end - match.start
            current_length = 0 if current is None else current.end - current.start
            if current is None or match_length > current_length or (
                match_length == current_length and match.skill_id < current.skill_id
            ):
                candidates[match.start] = match

        cursor = 0
        for match in candidates:
            if match is None:
                continue
            if match.start < cursor:
                continue
            yield match
            cursor = match.end

    def extract(self, text: str) -> list[str]:
        """Return matched canonical ids, deduplicated and sorted."""
        return sorted({match.skill_id for match in self.finditer(text)})


@functools.lru_cache(maxsize=1)
def _matcher() -> SkillMatcher:
    return SkillMatcher(canon().values())


def finditer(text: str) -> Iterator[SkillMatch]:
    """Yield skill occurrences from the process-wide cached matcher."""
    return _matcher().finditer(text)


def extract(text: str) -> list[str]:
    """Return canonical skill ids named in plain ``text``."""
    return _matcher().extract(text)
