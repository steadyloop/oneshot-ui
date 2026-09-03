"""Display-only labels for canonical job-posting skills."""

from __future__ import annotations

import functools
from pathlib import Path

import yaml

from oneshot_taxonomy.skills import SkillsError, canon

__all__ = ["SKILL_LABELS_PATH", "labels", "skill_label"]

SKILL_LABELS_PATH = (
    Path(__file__).parent / "registry" / "job-posting" / "skill-labels.yaml"
)
MAX_LABEL_LENGTH = 15


@functools.lru_cache(maxsize=1)
def labels() -> dict[str, str]:
    """Return validated compact labels keyed by stable canonical skill id."""
    try:
        with SKILL_LABELS_PATH.open(encoding="utf-8") as handle:
            document = yaml.safe_load(handle)
    except (OSError, yaml.YAMLError) as exc:
        raise SkillsError(f"{SKILL_LABELS_PATH}: {exc}") from exc

    if not isinstance(document, dict) or set(document) != {"label"}:
        raise SkillsError(f"{SKILL_LABELS_PATH}: root must contain only 'label'")
    rows = document["label"]
    if not isinstance(rows, dict):
        raise SkillsError(f"{SKILL_LABELS_PATH}: label must be a mapping")

    skills = canon()
    result: dict[str, str] = {}
    for skill_id, label in rows.items():
        if skill_id not in skills:
            raise SkillsError(f"{SKILL_LABELS_PATH}: unknown skill id {skill_id!r}")
        if not isinstance(label, str) or not label or label != label.strip():
            raise SkillsError(
                f"{SKILL_LABELS_PATH}: {skill_id!r} must have a non-empty trimmed label"
            )
        if len(label) > MAX_LABEL_LENGTH:
            raise SkillsError(
                f"{SKILL_LABELS_PATH}: {skill_id!r} label exceeds {MAX_LABEL_LENGTH} characters"
            )
        result[skill_id] = label

    projected = {
        skill_id: result.get(skill_id, skill.name)
        for skill_id, skill in skills.items()
    }
    seen: dict[str, str] = {}
    for skill_id, label in projected.items():
        key = label.casefold()
        if key in seen:
            raise SkillsError(
                f"{SKILL_LABELS_PATH}: label {label!r} is shared by "
                f"{seen[key]!r} and {skill_id!r}"
            )
        seen[key] = skill_id
    return result


def skill_label(skill_id: str, fallback: str) -> str:
    """Resolve a compact label without changing the canonical name."""
    return labels().get(skill_id, fallback)
