"""Typst rendering, page-count enforcement, and lint for generated resumes.

Both workspace designs use a single column and selectable text. Main retains
the serif format; Barlow uses bundled sans-serif fonts and a left-aligned header.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

SECTION_ORDER = ("education", "experience", "research", "project", "leadership")
SECTION_TITLES = {
    "education": "Education",
    "experience": "Experience",
    "research": "Research",
    "project": "Projects",
    "leadership": "Leadership & Activities",
}
SKILL_GROUP_TITLES = {
    "language": "Languages",
    "framework": "Frameworks & Libraries",
    "tool": "Tools",
    "math": "Math & Methods",
}

_FILLER_PHRASES = (
    "responsible for", "helped with", "worked on", "assisted with",
    "participated in", "various", "duties included",
)

_ESCAPES = str.maketrans({c: f"\\{c}" for c in "\\#$*_`@<>[]~"})

# A URL is interpolated into a Typst *string literal*, not into content, so the
# escapes above are both wrong and insufficient there: what ends a literal early
# is a quote or a backslash, and a newline. Without this a URL containing `")`
# closed the #link( call and compiled the rest of the value as Typst markup.
_STRING_ESCAPES = str.maketrans(
    {"\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r"}
)


def typst_escape(text: str) -> str:
    return text.translate(_ESCAPES)


def typst_string(value: str) -> str:
    """Escape a value for use inside a Typst string literal, e.g. #link("…")."""
    return value.translate(_STRING_ESCAPES)


def typst_available() -> bool:
    """Always true: the compiler is a wheel dependency, not a system binary.

    Kept as a function because it is on the wire — ``GET /resumes`` returns it
    and the studio hides its "install Typst" badge on it. The browser-local
    store still answers false, because a guest workspace is never sent to the
    server to be compiled.
    """
    return True


def _dates(entry: dict[str, Any]) -> str:
    start, end = entry.get("start_date", ""), entry.get("end_date", "")
    if start and end:
        return f"{start} -- {end}"
    return start or end or ""


def build_typst_source(
    profile: dict[str, Any],
    resume: dict[str, Any],
    entries: list[dict[str, Any]],
    skills: list[dict[str, Any]],
) -> str:
    """Assemble the .typ document from the resume's selection."""
    selection = resume.get("selection") or {}
    chosen_entries = list(selection.get("entries", []))
    chosen_skill_ids = set(selection.get("skills", []))
    template = selection.get("template") or resume.get("template") or "main"

    # Education is always shown in the workspace; older selections only stored
    # its GPA visibility when the user changed it. Include these existing banks
    # without rewriting their saved selections.
    chosen_entry_ids = {picked.get("entry_id") for picked in chosen_entries}
    chosen_entries.extend(
        {"entry_id": entry["id"], "bullets": []}
        for entry in entries
        if entry["kind"] == "education" and entry["id"] not in chosen_entry_ids
    )

    entry_by_id = {entry["id"]: entry for entry in entries}
    bullet_by_id = {
        bullet["id"]: bullet for entry in entries for bullet in entry.get("bullets", [])
    }

    sections: dict[str, list[str]] = {kind: [] for kind in SECTION_ORDER}
    for picked in chosen_entries:
        entry = entry_by_id.get(picked.get("entry_id"))
        if entry is None:
            continue
        entry = dict(entry)
        for field in ("org", "role", "location", "start_date", "end_date", "detail"):
            if picked.get(field) is not None:
                entry[field] = picked[field]
        if picked.get("show_detail") is False:
            entry["detail"] = ""
        block = [_entry_header(entry)]
        if entry["kind"] == "education":
            block.extend(_education_extras(resume, entry, skills, chosen_skill_ids))
        for picked_bullet in picked.get("bullets", []):
            bullet = bullet_by_id.get(picked_bullet.get("bullet_id"))
            if bullet is None:
                continue
            text = picked_bullet.get("text_override") or bullet["text"]
            block.append(f"- {typst_escape(text)}")
        sections[entry["kind"]].append("\n".join(block))

    parts = [_preamble(template), _header_block(profile, resume.get("availability_line", ""), template)]
    for kind in SECTION_ORDER:
        blocks = sections[kind]
        if not blocks:
            continue
        parts.append(f"== {SECTION_TITLES[kind]}")
        parts.append("\n#v(2pt)\n".join(blocks))
    skills_block = _skills_block(skills, chosen_skill_ids)
    if skills_block:
        parts.append("== Skills")
        parts.append(skills_block)
    return "\n\n".join(parts) + "\n"


def _preamble(template: str = "main") -> str:
    source = """\
#set page(paper: "us-letter", margin: (x: 0.55in, y: 0.5in))
#set text(font: "New Computer Modern", size: 10pt)
#set par(leading: 0.5em, justify: false)
#set list(tight: true, spacing: 0.55em, indent: 6pt, body-indent: 5pt)
#show heading.where(level: 2): it => block(width: 100%, above: 9pt, below: 7pt)[
  #set text(size: 10.5pt, weight: "bold")
  #smallcaps(it.body)
  #v(-7pt)
  #line(length: 100%, stroke: 0.6pt)
]
#show link: set text(fill: rgb("#1a3d6d"))"""
    return source.replace('font: "New Computer Modern"', 'font: "Barlow"') if template == "barlow" else source


def _header_block(profile: dict[str, Any], availability: str = "", template: str = "main") -> str:
    name = typst_escape(profile.get("full_name") or "Your Name")
    contact_bits = [
        typst_escape(value)
        for value in (profile.get("location"), profile.get("phone"), profile.get("email"))
        if value
    ]
    for link in profile.get("links", []):
        url, label = link.get("url", ""), link.get("label") or link.get("url", "")
        if url:
            contact_bits.append(f'#link("{typst_string(url)}")[{typst_escape(label)}]')
    contact = " #h(4pt)|#h(4pt) ".join(contact_bits)
    return (
        f"#align({'left' if template == 'barlow' else 'center'})[\n"
        f"  #text(size: 19pt, weight: \"bold\")[{name}]\n"
        f"  #v(-2pt)\n  {contact}\n"
        + (f"  #v(3pt)\n  _{typst_escape(availability)}_\n" if availability else "")
        + ("  #v(5pt)\n  #line(length: 100%, stroke: 0.8pt)\n" if template == "barlow" else "")
        + "]"
    )


def _entry_header(entry: dict[str, Any]) -> str:
    org = typst_escape(entry.get("org", ""))
    role = typst_escape(entry.get("role", ""))
    location = typst_escape(entry.get("location", ""))
    dates = typst_escape(_dates(entry))
    detail = typst_escape(entry.get("detail", ""))
    left_top = f"*{org}*" if org else ""
    if entry.get("url"):
        left_top += (
            f' #text(size: 8.5pt)[(#link("{typst_string(entry["url"])}")[link])]'
        )
    left_bottom = f"_{role}_" if role else ""
    if detail:
        left_bottom = f"{left_bottom} — {detail}" if left_bottom else detail
    right_top = f"*{dates}*" if dates else ""
    right_bottom = f"_{location}_" if location else ""
    return (
        "#grid(columns: (1fr, auto), row-gutter: 2pt,\n"
        f"  [{left_top}], [#align(right)[{right_top}]],\n"
        f"  [{left_bottom}], [#align(right)[{right_bottom}]],\n)"
    )


def _education_extras(
    resume: dict[str, Any],
    entry: dict[str, Any],
    skills: list[dict[str, Any]],
    chosen_skill_ids: set[int],
) -> list[str]:
    extras = []
    note = resume.get("education_note", "")
    if note:
        extras.append(typst_escape(note) + " \\")
    courses = [
        typst_escape(skill["name"])
        for skill in skills
        if skill["category"] == "coursework" and skill["id"] in chosen_skill_ids
    ]
    if courses:
        extras.append("*Coursework:* " + ", ".join(courses))
    return extras


def _skills_block(skills: list[dict[str, Any]], chosen_skill_ids: set[int]) -> str:
    lines = []
    for category, title in SKILL_GROUP_TITLES.items():
        names = [
            typst_escape(skill["name"])
            for skill in skills
            if skill["category"] == category and skill["id"] in chosen_skill_ids
        ]
        if names:
            lines.append(f"*{title}:* " + ", ".join(names) + " \\")
    if lines:
        lines[-1] = lines[-1].removesuffix(" \\")
    return "\n".join(lines)


def compile_pdf(source: str) -> tuple[bytes | None, int, str]:
    """Compile Typst source; returns (pdf_bytes, page_count, error).

    ``typst`` is the compiler itself, shipped as a binary wheel — no system
    install, no subprocess, no temp directory. Passing ``bytes`` compiles the
    source in memory; handing it a ``str`` would make it read a *path* instead.

    The subprocess this replaced carried a 30s timeout that a library call
    cannot: there is no way to interrupt the Rust compiler mid-run. The caller
    still runs it in a worker thread, so a pathological document ties up that
    thread rather than the event loop.
    """
    # Import the 60+ MB native compiler only when somebody requests an export,
    # not when every Opportunities request cold-starts the application.
    import typst

    try:
        pdf = typst.compile(
            source.encode("utf-8"),
            font_paths=[str(Path(__file__).with_name("fonts") / "barlow")],
            ignore_system_fonts=True,
        )
    except typst.TypstError as error:
        return None, 0, str(error).strip()
    pages = len(re.findall(rb"/Type\s*/Page\b(?!s)", pdf))
    return pdf, pages, ""


def lint_resume(
    profile: dict[str, Any],
    resume: dict[str, Any],
    entries: list[dict[str, Any]],
    page_count: int | None = None,
) -> list[dict[str, str]]:
    """Render-time checks for the rules a human reviewer would flag."""
    problems: list[dict[str, str]] = []

    def flag(level: str, message: str) -> None:
        problems.append({"level": level, "message": message})

    if page_count is not None and page_count > 1:
        flag("error", f"Resume is {page_count} pages — one page is non-negotiable for internships.")
    if not profile.get("email"):
        flag("error", "Profile has no email address.")
    if not resume.get("availability_line"):
        flag("warn", "No availability line (e.g. 'Available for Spring 2027 co-op') — "
                     "recruiters filter on legible availability.")

    selection = resume.get("selection") or {}
    bullet_by_id = {
        bullet["id"]: bullet for entry in entries for bullet in entry.get("bullets", [])
    }
    chosen: list[str] = []
    for picked in selection.get("entries", []):
        for picked_bullet in picked.get("bullets", []):
            bullet = bullet_by_id.get(picked_bullet.get("bullet_id"))
            if bullet is not None:
                chosen.append(picked_bullet.get("text_override") or bullet["text"])
    if not chosen:
        flag("error", "No bullets selected.")

    ends_with_period = 0
    for text in chosen:
        lowered = text.lower()
        for phrase in _FILLER_PHRASES:
            if phrase in lowered:
                flag("warn", f"Filler phrase '{phrase}' in: \"{text[:70]}…\"")
        if re.search(r"(?:^|\s)I(?:\s|'|,)", text):
            flag("warn", f"First person ('I') in: \"{text[:70]}…\"")
        if not re.search(r"\d", text):
            flag("info", f"No metric in: \"{text[:70]}…\" — quantify if honestly possible.")
        if len(text) > 240:
            flag("warn", f"Bullet likely wraps past 2 lines ({len(text)} chars): \"{text[:70]}…\"")
        if text.endswith("."):
            ends_with_period += 1
    if chosen and 0 < ends_with_period < len(chosen):
        flag("warn", "Inconsistent trailing periods across bullets — pick one style.")
    return problems
