"""The content bank, as pure data.

``resume_workspace`` stores the profile, every entry (with its bullets nested),
and every skill in a single jsonb row, so nearly all of the studio's remaining
work is list manipulation rather than SQL. Keeping that work here — with no
database, no clock, and no I/O — means the Postgres store and the in-memory test
fake run the *same* ordering, position, and uniqueness rules, and a fake can only
drift on the load/save shell.

Ids for entries, bullets, and skills are drawn from one shared ``next_item_id``
counter, so a `resume_document.selection` stays valid without a table per content
type. Every mutator edits the workspace in place and returns a deep copy, so a
caller can never hold a reference into stored state.
"""

from __future__ import annotations

from copy import deepcopy
import re
from typing import Any

PROFILE_FIELDS = ("full_name", "email", "phone", "location", "links")
ENTRY_FIELDS = (
    "kind", "org", "role", "location", "start_date", "end_date", "url", "detail",
)
ENTRY_UPDATABLE = frozenset(ENTRY_FIELDS) | {"position"}
BULLET_UPDATABLE = frozenset({"text", "audience", "tags", "defense_notes", "position"})

# The audience every bullet and skill matches, whatever variant is being built.
# Reserved: it can never be one of the account's own variant keys.
ALL_AUDIENCES = "all"
VARIANT_KEY_MAX = 40
VARIANT_LABEL_MAX = 80


def blank_workspace() -> dict[str, Any]:
    return {
        "profile": {"full_name": "", "email": "", "phone": "", "location": "", "links": []},
        "entries": [],
        "skills": [],
        # Empty, not seeded with someone else's career shape. A new account
        # declares its own variants; until it does, every bullet is "all" and
        # the studio simply offers no variant filter.
        "variants": [],
        # Seeded, because an empty vocabulary silently turns the "missing from
        # bank" half of coverage analysis off with no way to tell that from a
        # JD that genuinely named nothing.
        "vocabulary": list(DEFAULT_VOCABULARY),
        "next_item_id": 1,
    }


def normalize(workspace: dict[str, Any] | None) -> dict[str, Any]:
    """Fill in anything missing and repair ``next_item_id``.

    The counter is raised past every id actually present. That protects against
    a hand-edited row or a half-finished import handing out an id that is
    already in use, which would silently merge two bullets.
    """
    state = blank_workspace() if not workspace else dict(workspace)
    profile = dict(state.get("profile") or {})
    for key in PROFILE_FIELDS:
        profile.setdefault(key, [] if key == "links" else "")
    state["profile"] = profile
    state["entries"] = list(state.get("entries") or [])
    state["skills"] = list(state.get("skills") or [])
    state["variants"] = normalize_variants(state.get("variants"))
    # A row written before this column existed decodes as None, not as a
    # deliberate empty list, so it inherits the default rather than losing
    # coverage analysis on the next save.
    raw_vocabulary = state.get("vocabulary")
    state["vocabulary"] = (
        list(DEFAULT_VOCABULARY) if raw_vocabulary is None else _clean_terms(raw_vocabulary)
    )

    highest = 0
    for entry in state["entries"]:
        entry.setdefault("bullets", [])
        highest = max(highest, int(entry.get("id") or 0))
        for bullet in entry["bullets"]:
            highest = max(highest, int(bullet.get("id") or 0))
    for skill in state["skills"]:
        highest = max(highest, int(skill.get("id") or 0))
    state["next_item_id"] = max(int(state.get("next_item_id") or 1), highest + 1)
    return state


def allocate(workspace: dict[str, Any]) -> int:
    item_id = int(workspace["next_item_id"])
    workspace["next_item_id"] = item_id + 1
    return item_id


# -- variants ------------------------------------------------------------


def _clean_terms(raw: Any) -> list[str]:
    """A deduplicated, order-preserving list of non-empty strings."""
    seen: set[str] = set()
    terms: list[str] = []
    for value in raw or []:
        term = str(value).strip()
        folded = term.lower()
        if term and folded not in seen:
            seen.add(folded)
            terms.append(term)
    return terms


def normalize_variants(raw: Any) -> list[dict[str, str]]:
    """Coerce stored variants to ``[{key, label}]``, deduplicated on key.

    Keys are compared case-insensitively and stored lowercased, because they are
    matched against a bullet's ``audience`` on every render of the builder; two
    keys differing only in case would dim bullets unpredictably. ``all`` is
    dropped rather than rejected -- it is the reserved audience, so accepting it
    as a variant would make every bullet match every resume.
    """
    seen: set[str] = set()
    variants: list[dict[str, str]] = []
    for item in raw or []:
        if isinstance(item, str):
            item = {"key": item, "label": item}
        if not isinstance(item, dict):
            continue
        key = str(item.get("key") or "").strip().lower()[:VARIANT_KEY_MAX]
        if not key or key == ALL_AUDIENCES or key in seen:
            continue
        label = str(item.get("label") or "").strip()[:VARIANT_LABEL_MAX] or key
        seen.add(key)
        variants.append({"key": key, "label": label})
    return variants


def list_variants(workspace: dict[str, Any]) -> list[dict[str, str]]:
    return deepcopy(workspace["variants"])


def variant_keys(workspace: dict[str, Any]) -> set[str]:
    return {variant["key"] for variant in workspace["variants"]}


def audience_is_valid(workspace: dict[str, Any], audience: str) -> bool:
    return audience == ALL_AUDIENCES or audience in variant_keys(workspace)


def check_audience(workspace: dict[str, Any], audience: Any) -> None:
    """Raise ValueError unless ``audience`` is 'all' or a declared variant key.

    Lives here, not in the store, for the same reason every other rule does:
    the Postgres store and the in-memory test fake must refuse the same values
    with the same message, or the fake stops proving anything.
    """
    if audience is None:
        return
    if not audience_is_valid(workspace, audience):
        declared = ", ".join(sorted(variant_keys(workspace))) or "none defined yet"
        raise ValueError(
            f"Unknown audience {audience!r}. Use 'all' or a declared variant ({declared})."
        )


def check_variant(workspace: dict[str, Any], variant: Any) -> None:
    """Raise ValueError unless ``variant`` is '' or a declared variant key.

    Unlike an audience, a resume variant may not be 'all': a resume is built
    *for* one variant. '' means none, which is the only sensible state before
    any variants exist.
    """
    if variant is None or variant == "":
        return
    if variant not in variant_keys(workspace):
        declared = ", ".join(sorted(variant_keys(workspace))) or "none defined yet"
        raise ValueError(f"Unknown variant {variant!r}. Declared variants: {declared}.")


def variant_usage(workspace: dict[str, Any], key: str) -> int:
    """How many bullets and skills are tagged with this variant.

    Used to refuse a delete that would orphan them: an orphaned audience is
    invisible in the builder, because it matches no variant the user can pick.
    """
    used = sum(
        1
        for entry in workspace["entries"]
        for bullet in entry.get("bullets", [])
        if bullet.get("audience") == key
    )
    return used + sum(1 for skill in workspace["skills"] if skill.get("audience") == key)


def set_variants(workspace: dict[str, Any], raw: Any) -> list[dict[str, str]]:
    """Replace the variant list wholesale. Raises ValueError on orphaning."""
    incoming = normalize_variants(raw)
    dropped = variant_keys(workspace) - {variant["key"] for variant in incoming}
    in_use = {key: variant_usage(workspace, key) for key in dropped}
    orphaning = {key: count for key, count in in_use.items() if count}
    if orphaning:
        detail = ", ".join(f"{key} ({count})" for key, count in sorted(orphaning.items()))
        raise ValueError(f"variant still in use: {detail}")
    workspace["variants"] = incoming
    return list_variants(workspace)


def list_vocabulary(workspace: dict[str, Any]) -> list[str]:
    return list(workspace["vocabulary"])


def set_vocabulary(workspace: dict[str, Any], raw: Any) -> list[str]:
    workspace["vocabulary"] = _clean_terms(raw)
    return list_vocabulary(workspace)


# -- profile -------------------------------------------------------------


def public_profile(workspace: dict[str, Any]) -> dict[str, Any]:
    # No "id": the SQLite table needed a singleton primary key, the jsonb column
    # does not, and the client never read it.
    return deepcopy(workspace["profile"])


def apply_profile(workspace: dict[str, Any], fields: dict[str, Any]) -> dict[str, Any]:
    for key, value in fields.items():
        if key in PROFILE_FIELDS and value is not None:
            workspace["profile"][key] = value
    return public_profile(workspace)


# -- entries and bullets -------------------------------------------------


def _public_bullet(bullet: dict[str, Any], entry_id: int) -> dict[str, Any]:
    # entry_id is derived from the nesting rather than stored, so the two can
    # never disagree. It is emitted because the SQLite shape carried it.
    return deepcopy(bullet) | {"entry_id": entry_id}


def _public_entry(entry: dict[str, Any]) -> dict[str, Any]:
    ordered = sorted(entry.get("bullets", []), key=lambda b: (b["position"], b["id"]))
    return deepcopy(entry) | {
        "bullets": [_public_bullet(bullet, entry["id"]) for bullet in ordered]
    }


def _find_entry(workspace: dict[str, Any], entry_id: int) -> dict[str, Any] | None:
    return next((e for e in workspace["entries"] if e["id"] == entry_id), None)


def _find_bullet(
    workspace: dict[str, Any], bullet_id: int
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    for entry in workspace["entries"]:
        for bullet in entry.get("bullets", []):
            if bullet["id"] == bullet_id:
                return entry, bullet
    return None


def list_entries(workspace: dict[str, Any]) -> list[dict[str, Any]]:
    # (position, id) across ALL entries, not within each kind. Position is
    # *allocated* per kind, so kinds interleave — sorting per kind and
    # concatenating produces a different order.
    ordered = sorted(workspace["entries"], key=lambda e: (e["position"], e["id"]))
    return [_public_entry(entry) for entry in ordered]


def add_entry(workspace: dict[str, Any], fields: dict[str, Any]) -> dict[str, Any]:
    kind = fields["kind"]
    position = max(
        (e["position"] for e in workspace["entries"] if e["kind"] == kind),
        default=0,
    ) + 1
    entry = {
        "id": allocate(workspace),
        "kind": kind,
        "org": fields["org"],
        "role": fields.get("role", ""),
        "location": fields.get("location", ""),
        "start_date": fields.get("start_date", ""),
        "end_date": fields.get("end_date", ""),
        "url": fields.get("url", ""),
        "detail": fields.get("detail", ""),
        "position": position,
        "bullets": [],
    }
    workspace["entries"].append(entry)
    return _public_entry(entry)


def edit_entry(
    workspace: dict[str, Any], entry_id: int, fields: dict[str, Any]
) -> dict[str, Any] | None:
    entry = _find_entry(workspace, entry_id)
    if entry is None:
        return None
    for key, value in fields.items():
        if key in ENTRY_UPDATABLE and value is not None:
            entry[key] = value
    return _public_entry(entry)


def remove_entry(workspace: dict[str, Any], entry_id: int) -> bool:
    before = len(workspace["entries"])
    # Bullets are nested, so they go with the entry — SQLite got this from
    # ON DELETE CASCADE.
    workspace["entries"] = [e for e in workspace["entries"] if e["id"] != entry_id]
    return len(workspace["entries"]) != before


def add_bullet(
    workspace: dict[str, Any], entry_id: int, fields: dict[str, Any]
) -> dict[str, Any] | None:
    entry = _find_entry(workspace, entry_id)
    if entry is None:
        return None
    position = max((b["position"] for b in entry["bullets"]), default=0) + 1
    bullet = {
        "id": allocate(workspace),
        "text": fields["text"],
        "audience": fields.get("audience", "all"),
        "tags": fields.get("tags", []),
        "defense_notes": fields.get("defense_notes", ""),
        "position": position,
    }
    entry["bullets"].append(bullet)
    return _public_bullet(bullet, entry["id"])


def edit_bullet(
    workspace: dict[str, Any], bullet_id: int, fields: dict[str, Any]
) -> dict[str, Any] | None:
    found = _find_bullet(workspace, bullet_id)
    if found is None:
        return None
    entry, bullet = found
    for key, value in fields.items():
        if key in BULLET_UPDATABLE and value is not None:
            bullet[key] = value
    return _public_bullet(bullet, entry["id"])


def remove_bullet(workspace: dict[str, Any], bullet_id: int) -> bool:
    found = _find_bullet(workspace, bullet_id)
    if found is None:
        return False
    entry, bullet = found
    entry["bullets"] = [b for b in entry["bullets"] if b["id"] != bullet_id]
    return True


# -- skills --------------------------------------------------------------


def list_skills(workspace: dict[str, Any]) -> list[dict[str, Any]]:
    # SQLite's BINARY collation is byte order, which matches Python's default
    # string comparison. Do not casefold: that would reorder mixed-case names.
    return deepcopy(sorted(workspace["skills"], key=lambda s: (s["category"], s["name"])))


def add_skill(workspace: dict[str, Any], fields: dict[str, Any]) -> dict[str, Any] | None:
    category, name = fields["category"], fields["name"]
    # UNIQUE (category, name) under BINARY collation is an exact match, so this
    # check is case-sensitive too. Returning None becomes a 409.
    if any(s["category"] == category and s["name"] == name for s in workspace["skills"]):
        return None
    skill = {
        "id": allocate(workspace),
        "category": category,
        "name": name,
        "audience": fields.get("audience", "all"),
    }
    workspace["skills"].append(skill)
    return deepcopy(skill)


def remove_skill(workspace: dict[str, Any], skill_id: int) -> bool:
    before = len(workspace["skills"])
    workspace["skills"] = [s for s in workspace["skills"] if s["id"] != skill_id]
    return len(workspace["skills"]) != before


# -- keyword coverage ----------------------------------------------------


def compute_coverage(
    job: dict[str, Any],
    skills: list[dict[str, Any]],
    shown_ids: set[int],
    vocabulary: list[str] | None = None,
) -> dict[str, Any]:
    """Compare a JD against the skill bank and (optionally) one resume.

    matched: bank skills named in the JD and shown on the resume.
    have_not_shown: bank skills named in the JD but not on the resume —
      candidates to mirror in the JD's own words.
    missing: JD vocabulary with no bank skill at all. Never faked in;
      surfaced so the gap is a conscious decision.

    ``vocabulary`` is the account's own term list. It falls back to the seed list
    only so the pure-function tests and any caller predating per-account
    vocabularies keep working; the store always passes the workspace's own,
    because a term list is a statement about one person's field.
    """
    jd = (job.get("jd_text") or "").lower()

    # `+`, `#` and `&` count as part of the surrounding word, not as boundaries:
    # without them a bank skill named "C" matched the C in "C++" and "C#", and
    # "R" matched the R in "R&D". `.` is deliberately NOT in the set — it ends
    # sentences far more often than it joins a name, and excluding it would stop
    # "Backend in Go." from matching Go at all.
    boundary = "[a-z0-9+#&]"

    def mentioned(name: str) -> bool:
        pattern = rf"(?<!{boundary}){re.escape(name.lower())}(?!{boundary})"
        return re.search(pattern, jd) is not None

    in_jd = [skill for skill in skills if skill["name"] and mentioned(skill["name"])]
    bank_names = {skill["name"].lower() for skill in skills}
    terms = DEFAULT_VOCABULARY if vocabulary is None else vocabulary
    vocabulary_hits = sorted(
        term for term in terms
        if term.lower() not in bank_names and mentioned(term)
    )
    return {
        "job_id": job["id"],
        "matched": [s for s in in_jd if s["id"] in shown_ids],
        "have_not_shown": [s for s in in_jd if s["id"] not in shown_ids],
        "missing": vocabulary_hits,
    }


# The seed vocabulary a *new* workspace starts with: terms a JD may name that
# deserve a "missing from bank" flag. Curated, not exhaustive — coverage of
# arbitrary vocabulary would need NLP and would invite keyword-stuffing, which
# the strategy doc explicitly rejects.
#
# This list is software/GPU/quant shaped. It is a starting point, not the
# vocabulary: each account owns an editable copy in `resume_workspace.vocabulary`,
# so a user in another field replaces it rather than working around it.
DEFAULT_VOCABULARY = [
    "Python", "C", "C++", "C#", "Java", "JavaScript", "TypeScript", "Go", "Rust",
    "Kotlin", "Swift", "Scala", "R", "Julia", "MATLAB", "SQL", "Bash", "OCaml",
    "Haskell", "React", "Vue", "Angular", "Node.js", "Django", "Flask", "FastAPI",
    "Spring", "NumPy", "pandas", "SciPy", "scikit-learn", "PyTorch", "TensorFlow",
    "JAX", "Keras", "XGBoost", "Spark", "Hadoop", "Kafka", "Airflow", "dbt",
    "PostgreSQL", "MySQL", "SQLite", "MongoDB", "Redis", "DuckDB", "Snowflake",
    "Docker", "Kubernetes", "Terraform", "AWS", "GCP", "Azure", "Linux", "Git",
    "CI/CD", "GraphQL", "gRPC", "REST", "WebSocket", "CUDA", "OpenMP", "MPI",
    "machine learning", "deep learning", "reinforcement learning", "NLP",
    "computer vision", "linear algebra", "probability", "statistics",
    "stochastic processes", "optimization", "numerical methods", "PDE",
    "Monte Carlo", "time series", "regression", "A/B testing", "data structures",
    "algorithms", "distributed systems", "operating systems", "networking",
    "concurrency", "functional programming", "object-oriented",
    # GPU / ML systems
    "Triton", "CUTLASS", "cuBLAS", "NCCL", "TensorRT", "vLLM", "SGLang", "PTX",
    "ROCm", "HIP", "MLIR", "LLVM", "XLA", "TVM", "Nsight", "GPU", "tensor cores",
    "kernel optimization", "quantization", "mixed precision", "FP8", "FP4", "GEMM",
    "attention", "transformers", "KV cache", "inference", "model serving",
    "batching", "roofline", "memory bandwidth", "SIMD", "vectorization", "HPC",
    "parallel computing", "RDMA", "InfiniBand", "profiling", "compilers",
    "computer architecture",
    # Low latency / trading systems
    "low latency", "lock-free", "kernel bypass", "DPDK", "io_uring", "NUMA",
    "cache optimization", "market data", "order book", "market microstructure",
    "FIX protocol", "ITCH", "floating point", "numerical linear algebra",
    "queueing theory",
    # Infrastructure
    "eBPF", "CMake", "Bazel", "gdb", "Raft", "consensus", "Prometheus", "Grafana",
]
