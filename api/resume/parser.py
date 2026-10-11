"""Deterministic, local resume extraction; importing this module changes no state.

parse_text and parse_document return drafts, not commands to save. Empty fields
and uncategorized skills deliberately require review. SourceBlock.fields uses
dot paths into the result; structural/ignored labels contain a colon.
All extracted text is retained in sources, including unsupported content.

Run: uv run python -m api.resume.parser resume.pdf
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from functools import lru_cache
from io import BytesIO
from pathlib import Path
import re
import sys
from typing import Literal
from urllib.parse import urlsplit
from zipfile import BadZipFile, ZipFile

from pydantic import BaseModel, Field, ValidationError

from .models import BulletCreate, EntryCreate, EntryKind, ProfileUpdate, SkillCategory, SkillCreate

MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_EXTRACTED_CHARS = 2_000_000


class ParseError(ValueError):
    """Fatal input/extraction error; code is stable for a future upload UI."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


class DraftLink(BaseModel):
    label: str = ""
    url: str


class SourceBlock(BaseModel):
    id: int
    text: str
    page: int | None = None
    line: int | None = None
    column: int = 0
    container: str = ""
    bbox: tuple[float, float, float, float] | None = None
    bold: bool = False
    font_size: float | None = None
    indent: float = 0
    gap_before: bool = False
    bullet: bool = False
    links: list[DraftLink] = Field(default_factory=list)
    review_only: bool = False
    ignored: str = ""
    fields: list[str] = Field(default_factory=list)


class DraftProfile(BaseModel):
    full_name: str = ""
    email: str = ""
    phone: str = ""
    location: str = ""
    links: list[DraftLink] = Field(default_factory=list)


class DraftBullet(BaseModel):
    text: str
    audience: Literal["all"] = "all"


class DraftEntry(BaseModel):
    kind: EntryKind
    org: str = ""
    role: str = ""
    location: str = ""
    start_date: str = ""
    end_date: str = ""
    url: str = ""
    detail: str = ""
    bullets: list[DraftBullet] = Field(default_factory=list)


class DraftSkill(BaseModel):
    name: str
    category: SkillCategory | None = None
    audience: Literal["all"] = "all"


class UnparsedBlock(BaseModel):
    text: str
    source_ids: list[int]
    reason: str


class ParseWarning(BaseModel):
    code: str
    message: str
    field: str | None = None
    source_ids: list[int] = Field(default_factory=list)


class ParsedResume(BaseModel):
    profile: DraftProfile = Field(default_factory=DraftProfile)
    entries: list[DraftEntry] = Field(default_factory=list)
    skills: list[DraftSkill] = Field(default_factory=list)
    sources: list[SourceBlock] = Field(default_factory=list)
    unparsed: list[UnparsedBlock] = Field(default_factory=list)
    warnings: list[ParseWarning] = Field(default_factory=list)


_SECTION_ALIASES = {
    "contact": ("contact", "contact information", "personal information", "profile"),
    "education": ("education", "academic background", "academic qualifications", "educational background"),
    "experience": ("experience", "work experience", "professional experience", "employment",
                   "employment history", "work history", "relevant experience", "industry experience"),
    "project": ("projects", "project experience", "personal projects", "academic projects",
                "selected projects", "technical projects"),
    "research": ("research", "research experience", "research projects"),
    "leadership": ("leadership", "leadership experience", "leadership and activities",
                   "leadership activities", "activities", "extracurricular activities",
                   "volunteer experience", "volunteering", "community involvement"),
    "skills": ("skills", "technical skills", "technical expertise", "technical proficiencies",
               "skills and technologies", "skills and interests", "core competencies"),
    "coursework": ("coursework", "relevant coursework", "selected coursework", "courses"),
    "unsupported": ("summary", "professional summary", "objective", "career objective",
                    "awards", "honors", "honors and awards", "certifications", "certificates",
                    "publications", "interests", "references", "professional memberships",
                    "awards and certifications", "certifications and awards"),
}


def _heading_key(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().rstrip(":").replace("&", "and")).casefold()


_HEADINGS = {label: kind for kind, labels in _SECTION_ALIASES.items() for label in labels}
_GROUPS = {
    "languages": "language", "programming languages": "language",
    "frameworks": "framework", "libraries": "framework", "frameworks and libraries": "framework",
    "databases": "data", "data": "data", "datastores": "data", "data tools": "data",
    "tools": "tool", "tools and systems": "tool", "technologies": "tool",
    "platforms": "tool", "developer tools": "tool",
    "math": "math", "mathematics": "math", "math and methods": "math",
    "coursework": "coursework", "relevant coursework": "coursework", "courses": "coursework",
}
_BULLET = re.compile(r"^\s*(?:[•●▪◦‣⁃➤∙]\s*|[-–*]\s+|\d+[.)]\s+)")
_EMAIL = re.compile(r"(?<![\w.+-])[\w.+-]+@(?:[\w-]+\.)+[A-Za-z]{2,}(?![\w-])")
_PHONE = re.compile(
    r"(?<![\w+])(?:\+\d{1,3}[\s.-]*)?"
    r"(?:\(\d{2,4}\)[\s.-]*|\d{2,4}[\s.-]+)\d{3,4}[\s.-]+\d{3,4}"
    r"(?:\s*(?:ext\.?|x)\s*\d{1,6})?(?!\w)|(?<!\w)\+?\d{10,15}(?!\w)",
    re.I,
)
_URL = re.compile(
    r"(?<![@\w])(?:https?://[^\s|<>]+|www\.[^\s|<>]+|"
    r"(?:[\w-]+\.)+(?:com|org|net|io|dev|me|edu|ai|co)(?:/[^\s|<>]*)?)",
    re.I,
)
_MONTH = r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
_DATE = rf"(?:{_MONTH}\.?\s+\d{{4}}|(?:Spring|Summer|Fall|Autumn|Winter)\s+\d{{4}}|(?:0?[1-9]|1[0-2])[/.-]\d{{4}}|\d{{4}}[-/](?:0?[1-9]|1[0-2])|\d{{4}}|Present|Current|Now)"
_DATES = re.compile(rf"(?<!\w)(?P<start>{_DATE})(?:\s*(?:[–—-]|\bto\b)\s*(?P<end>{_DATE}))?(?!\w)", re.I)
_GPA = re.compile(r"\b(?:cumulative\s+)?GPA\s*[:=]?\s*(\d{1,3}(?:\.\d+)?(?:\s*/\s*\d{1,3}(?:\.\d+)?)?)", re.I)
_DEGREE = re.compile(
    r"\b(?:bachelor|master|doctor|associate|diploma|Ph\.?D\.?|B\.?Sc\.?|B\.?S\.?|B\.?A\.?|"
    r"M\.?Sc\.?|M\.?S\.?|M\.?A\.?|MBA|B\.?Eng\.?|M\.?Eng\.?)(?=\W|$)", re.I,
)
_SCHOOL = re.compile(r"\b(?:university|college|institute|polytechnic|academy|school|MIT)\b", re.I)
_ROLE = re.compile(
    r"\b(?:intern|internship|engineer|developer|researcher|assistant|analyst|manager|director|"
    r"president|vice president|coordinator|consultant|designer|scientist|fellow|officer|"
    r"founder|lead|leader|chair|treasurer|secretary|specialist|technician|professor)\b", re.I,
)
_ORG = re.compile(r"\b(?:inc\.?|llc|ltd\.?|corp\.?|corporation|company|labs?|laboratory|"
                  r"chapter|society|association|club|foundation|group|university|institute)\b", re.I)
_LOCATION = re.compile(
    r"^(?:Remote|Hybrid|On[- ]site|[^\d|:]+,\s*(?:[A-Z]{2,3}|USA|United States|United Kingdom|"
    r"Canada|France|Germany|India|Australia|Singapore|Ireland|Netherlands))$"
)


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("\u00a0", " ")).strip()


def _section(text: str) -> str | None:
    return _HEADINGS.get(_heading_key(text))


def _source(blocks: list[SourceBlock], text: str, **metadata) -> None:
    if text.strip():
        blocks.append(SourceBlock(id=len(blocks) + 1, text=text, **metadata))
        if len(text) > MAX_EXTRACTED_CHARS:
            raise ParseError("extraction_limit", "Extracted content is too large to parse.")


def _text_blocks(text: str) -> list[SourceBlock]:
    blocks: list[SourceBlock] = []
    gap = True
    for line, raw in enumerate(text.splitlines(), 1):
        if raw.strip():
            prefix = raw[:len(raw) - len(raw.lstrip())]
            _source(blocks, raw.rstrip(), line=line, indent=len(prefix.expandtabs(4)), gap_before=gap)
        gap = not raw.strip()
    return blocks


def _pdf_blocks(data: bytes) -> list[SourceBlock]:
    import pdfplumber
    from pdfplumber.utils.exceptions import MalformedPDFException, PdfminerException
    from pdfminer.pdfdocument import PDFPasswordIncorrect
    from pdfminer.pdfexceptions import PDFException
    from pdfminer.psexceptions import PSException

    blocks: list[SourceBlock] = []
    margins: dict[str, list[SourceBlock]] = defaultdict(list)
    image_pages: list[int] = []
    try:
        with pdfplumber.open(BytesIO(data)) as pdf:
            if pdf.doc.encryption:
                raise ParseError("encrypted", "Password-protected PDFs are not supported.")
            if len(pdf.pages) > 100:
                raise ParseError("extraction_limit", "The document exceeds 100 pages.")
            for page_no, original in enumerate(pdf.pages, 1):
                page = original.dedupe_chars()
                words = page.extract_words(extra_attrs=["fontname", "size"], return_chars=True)
                if not words and original.images:
                    image_pages.append(page_no)
                rows: list[list[dict]] = []
                for word in sorted(words, key=lambda w: (round(w["top"], 1), w["x0"])):
                    if not rows or abs(word["top"] - rows[-1][0]["top"]) > 3:
                        rows.append([])
                    rows[-1].append(word)
                for row in rows:
                    row.sort(key=lambda w: w["x0"])
                cut = _column_cut(rows, page.width)
                heading_tops = [row[0]["top"] for row in rows
                                if any(_section(_word_text(part)) for part in _row_parts(row, cut))]
                body_top = min(heading_tops, default=float("inf"))
                pieces = []
                for row in rows:
                    # Content above the first section spans the page's columns.
                    parts = [row] if row[0]["top"] < body_top else _row_parts(row, cut)
                    for part in parts:
                        if part:
                            column = -1 if row[0]["top"] < body_top else int(bool(cut and part[0]["x0"] >= cut))
                            pieces.append((column, part))
                previous_bottom: dict[int, float] = {}
                for column, part in sorted(pieces, key=lambda item: (item[0], item[1][0]["top"])):
                    x0, top = min(w["x0"] for w in part), min(w["top"] for w in part)
                    x1, bottom = max(w["x1"] for w in part), max(w["bottom"] for w in part)
                    bbox = (x0, top, x1, bottom)
                    links = []
                    for link in original.hyperlinks:
                        uri = link.get("uri")
                        if uri and _overlaps(bbox, (link["x0"], link["top"], link["x1"], link["bottom"])):
                            label = _word_text([w for w in part if _overlaps(
                                (w["x0"], w["top"], w["x1"], w["bottom"]),
                                (link["x0"], link["top"], link["x1"], link["bottom"]))])
                            links.append(DraftLink(label=label, url=uri))
                    text = _word_text(part)
                    _source(blocks, text, page=page_no, column=column, bbox=bbox, indent=x0,
                            bold=all("bold" in w["fontname"].casefold() for w in part),
                            font_size=max(w["size"] for w in part), links=links,
                            gap_before=top - previous_bottom.get(column, top) > max(w["size"] for w in part))
                    previous_bottom[column] = bottom
                    block = blocks[-1]
                    if re.fullmatch(r"(?:Page\s+)?\d+(?:\s+(?:of|/)\s+\d+)?", text, re.I) and (
                        top < 50 or bottom > page.height - 50
                    ):
                        block.ignored = "page_number"
                    elif (top < 65 or bottom > page.height - 65) and not _section(text):
                        margins[_clean(text)].append(block)
                original.close()
    except PDFPasswordIncorrect as exc:
        raise ParseError("encrypted", "Password-protected PDFs are not supported.") from exc
    except PdfminerException as exc:
        if isinstance(exc.__context__, PDFPasswordIncorrect):
            raise ParseError("encrypted", "Password-protected PDFs are not supported.") from exc
        raise ParseError("malformed", "The PDF could not be read.") from exc
    except ParseError:
        raise
    except (PDFException, PSException, MalformedPDFException, ValueError, TypeError, KeyError, IndexError, OSError) as exc:
        raise ParseError("malformed", "The PDF could not be read.") from exc
    for repeated in margins.values():
        if len({b.page for b in repeated}) > 1:
            for block in repeated[1:]:
                block.ignored = "repeated_header_footer"
    if not blocks and image_pages:
        raise ParseError("image_only", "This PDF is a scan. Paste its text instead.")
    for page in image_pages:
        _source(blocks, f"[Image-only page {page}]", page=page, review_only=True, container="image")
    return blocks


def _word_text(words: list[dict]) -> str:
    text = ""
    previous = None
    for word in words:
        gap = word["x0"] - previous["x1"] if previous else 0
        separator = " \t " if previous and gap > max(20, word["size"] * 2) else " "
        text += (separator if text else "") + word["text"]
        previous = word
    return text


def _row_parts(row: list[dict], cut: float | None) -> list[list[dict]]:
    if cut is None or any(w["x0"] < cut < w["x1"] for w in row):
        return [row]
    return [[w for w in row if w["x0"] < cut], [w for w in row if w["x0"] >= cut]]


def _column_cut(rows: list[list[dict]], width: float) -> float | None:
    # A date column is metadata, not a second stream of resume content.
    candidates = {round(width * n / 100, 1) for n in range(25, 76, 2)}
    for row in rows:
        for left, right in zip(row, row[1:]):
            midpoint = (left["x1"] + right["x0"]) / 2
            if right["x0"] - left["x1"] > 35 and width * .25 < midpoint < width * .75:
                candidates.add(round(midpoint, 1))
    best, best_score = None, 0
    for cut in sorted(candidates):
        counts = [0, 0]
        crossing = 0
        headings = set()
        body_top = min((row[0]["top"] for row in rows
                        if any(_section(_word_text(part)) for part in _row_parts(row, cut))),
                       default=float("inf"))
        for row in rows:
            if row[0]["top"] < body_top:
                continue
            parts = _row_parts(row, cut)
            if len(parts) != 2:
                crossing += 1
                continue
            left, right = map(_word_text, parts)
            if _section(left):
                headings.add(0)
            if _section(right):
                headings.add(1)
            for column, text in enumerate((left, right)):
                remainder = _DATES.sub("", text).strip(" \t|,–—-")
                if remainder and not _LOCATION.fullmatch(_clean(remainder)):
                    counts[column] += 1
        score = min(counts) * 2 - crossing * 3
        if min(counts) >= 3 and len(headings) == 2 and score > best_score:
            best, best_score = cut, score
    return best


def _overlaps(a, b) -> bool:
    return a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]


def _docx_blocks(data: bytes) -> list[SourceBlock]:
    from docx import Document
    from docx.opc.exceptions import PackageNotFoundError
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    from docx.oxml.ns import qn
    from lxml.etree import XMLSyntaxError

    if data.startswith(bytes.fromhex("d0cf11e0a1b11ae1")):
        raise ParseError("encrypted", "Encrypted Word documents and legacy .doc files are not supported.")
    try:
        with ZipFile(BytesIO(data)) as archive:
            if any(info.flag_bits & 1 for info in archive.infolist()):
                raise ParseError("encrypted", "Password-protected Word documents are not supported.")
            if sum(info.file_size for info in archive.infolist()) > 50 * 1024 * 1024:
                raise ParseError("extraction_limit", "The expanded Word document is too large.")
            if "word/document.xml" not in archive.namelist():
                raise ParseError("malformed", "This is not a DOCX document.")
        document = Document(BytesIO(data))
        blocks: list[SourceBlock] = []
        seen_cells: set[object] = set()
        parts = []

        def walk(parent, container: str, column: int = 0):
            gap = False
            for index, item in enumerate(parent.iter_inner_content()):
                path = f"{container}/{index}"
                if isinstance(item, Paragraph):
                    if not item.text.strip():
                        gap = True
                        continue
                    runs = [run for run in item.runs if run.text.strip()]
                    style = item.style.name if item.style else ""
                    ppr = item._p.pPr
                    numbered = ppr is not None and ppr.numPr is not None
                    links = [DraftLink(label=link.text, url=link.url) for link in item.hyperlinks if link.url]
                    for raw in item.text.splitlines():
                        _source(blocks, raw, container=path, column=column, gap_before=gap,
                                bold=style.startswith("Heading") or bool(runs and all(run.bold for run in runs)),
                                font_size=max((run.font.size.pt for run in runs if run.font.size), default=None),
                                indent=item.paragraph_format.left_indent.pt if item.paragraph_format.left_indent else 0,
                                bullet=numbered or style.startswith(("List Bullet", "List Number")), links=links)
                        gap = False
                elif isinstance(item, Table):
                    layout = len(item.columns) == 2 and all(
                        any(_section(p.text) for row in item.rows for p in row.cells[col].paragraphs)
                        for col in range(2))
                    cells = [(r, c, cell) for r, row in enumerate(item.rows) for c, cell in enumerate(row.cells)]
                    if layout:
                        cells.sort(key=lambda value: (value[1], value[0]))
                    for row, col, cell in cells:
                        # Merged cells are represented more than once by python-docx.
                        if cell._tc not in seen_cells:
                            seen_cells.add(cell._tc)
                            walk(cell, f"{path}/row:{row}/cell:{col}", col if layout else column)
                    gap = True

        seen_parts: set[str] = set()
        for section in document.sections:
            for header in (section.header, section.first_page_header, section.even_page_header):
                if str(header.part.partname) not in seen_parts:
                    seen_parts.add(str(header.part.partname))
                    parts.append(header.part)
                    walk(header, "header", -1)
        walk(document, "body")
        parts.append(document.part)
        for section in document.sections:
            for footer in (section.footer, section.first_page_footer, section.even_page_footer):
                if str(footer.part.partname) not in seen_parts:
                    seen_parts.add(str(footer.part.partname))
                    parts.append(footer.part)
                    walk(footer, "footer")
        for part in parts:
            for box in part.element.xpath(".//w:txbxContent"):
                for paragraph in box.iter(qn("w:p")):
                    _source(blocks, "".join(node.text or "" for node in paragraph.iter(qn("w:t"))),
                            container="textbox", review_only=True)
        if not blocks and document.part.element.xpath(".//w:drawing | .//w:pict"):
            raise ParseError("image_only", "This Word document contains only images. Paste its text instead.")
        return blocks
    except ParseError:
        raise
    except (BadZipFile, PackageNotFoundError, XMLSyntaxError, NotImplementedError,
            ValueError, KeyError, TypeError, OSError) as exc:
        raise ParseError("malformed", "The DOCX document could not be read.") from exc


class _Parser:
    def __init__(self, blocks: list[SourceBlock]):
        self.result = ParsedResume(sources=blocks)

    def mark(self, block: SourceBlock, field: str) -> None:
        if field not in block.fields:
            block.fields.append(field)

    def warn(self, code: str, message: str, blocks: list[SourceBlock], field: str | None = None) -> None:
        self.result.warnings.append(ParseWarning(
            code=code, message=message, field=field, source_ids=[b.id for b in blocks]))

    def unparsed(self, blocks: list[SourceBlock], reason: str, text: str | None = None) -> None:
        if blocks:
            self.result.unparsed.append(UnparsedBlock(
                text=text if text is not None else "\n".join(b.text for b in blocks),
                source_ids=[b.id for b in blocks], reason=reason))

    def choose(self, candidates: list[tuple[str, SourceBlock]], field: str) -> str:
        values = list(dict.fromkeys(value for value, _ in candidates if value))
        if len(values) == 1:
            for value, block in candidates:
                if value:
                    self.mark(block, field)
            return values[0]
        if len(values) > 1:
            blocks = list({block.id: block for _, block in candidates}.values())
            self.warn("ambiguous_field", "Conflicting candidates; review the original text.", blocks, field)
            self.unparsed(blocks, "ambiguous_field")
        return ""

    def parse(self) -> ParsedResume:
        segments: list[tuple[str | None, list[SourceBlock]]] = []
        kind: str | None = "contact"
        active: list[SourceBlock] = []
        previous: SourceBlock | None = None
        for block in self.result.sources:
            if block.ignored or block.container == "footer" and re.fullmatch(r"\d+", block.text.strip()):
                self.mark(block, f"ignored:{block.ignored or 'page_number'}")
                continue
            if block.review_only:
                self.unparsed([block], "unsupported_layout")
                self.warn("unsupported_layout", "Content needs manual review.", [block])
                continue
            if block.container.startswith("footer"):
                self.unparsed([block], "footer_content")
                continue
            heading = _section(block.text)
            changed_column = previous is not None and block.column >= 0 and previous.column >= 0 and block.column != previous.column and (
                block.page == previous.page or block.page is None
            )
            if heading or changed_column:
                if active:
                    segments.append((kind, active))
                    active = []
                if heading:
                    kind = heading
                    self.mark(block, f"section:{kind}")
                    if heading == "unsupported":
                        self.unparsed([block], "unsupported_section")
                        self.warn("unsupported_section", "This section has no destination in the current resume model.", [block])
                else:
                    kind = None
            if not heading:
                active.append(block)
            previous = block
        if active:
            segments.append((kind, active))
        contact = [block for segment, items in segments if segment == "contact" for block in items]
        self.contact(contact)
        for segment, items in segments:
            if segment == "contact":
                continue
            if segment in ("skills", "coursework"):
                self.skills(items, "coursework" if segment == "coursework" else None)
            elif segment in ("education", "experience", "project", "research", "leadership"):
                self.entries(items, segment)
            else:
                self.unparsed(items, "unsupported_section" if segment == "unsupported" else "unrecognized_section")
        accounted = {source_id for item in self.result.unparsed for source_id in item.source_ids}
        for block in self.result.sources:
            if not block.fields and block.id not in accounted:
                self.unparsed([block], "unrecognized_content")
        self.validate_lengths()
        if not (any(self.result.profile.model_dump().values()) or self.result.entries or self.result.skills):
            self.warn("limited_extraction", "No supported profile or resume content was confidently identified.", [])
        return self.result

    def contact(self, blocks: list[SourceBlock]) -> None:
        candidates: dict[str, list[tuple[str, SourceBlock]]] = defaultdict(list)
        leftovers: list[tuple[str, SourceBlock]] = []
        links: dict[str, int] = {}
        for block in blocks:
            text = block.text.strip()
            for link in block.links:
                if link.url.casefold().startswith("mailto:"):
                    address = link.url[7:].split("?", 1)[0]
                    if _EMAIL.fullmatch(address):
                        candidates["email"].append((address, block))
                        text = text.replace(link.label, "")
                elif link.url.casefold().startswith("tel:") and _PHONE.fullmatch(link.url[4:]):
                    candidates["phone"].append((link.url[4:], block))
                    text = text.replace(link.label, "")
            for field, pattern in (("email", _EMAIL), ("phone", _PHONE)):
                for match in pattern.finditer(text):
                    candidates[field].append((match.group(), block))
                text = pattern.sub("", text)
            for link in [*block.links, *(DraftLink(label=m.group(), url=m.group()) for m in _URL.finditer(text))]:
                url = _web_url(link.url)
                if url:
                    if url not in links:
                        links[url] = len(self.result.profile.links)
                        self.result.profile.links.append(DraftLink(label=link.label or link.url, url=url))
                    self.mark(block, f"profile.links.{links[url]}")
                    text = text.replace(link.url, "").replace(link.label, "") if link.label else text.replace(link.url, "")
            for part in re.split(r"\s*[|·•]\s*|\t+|\s{2,}", text):
                part = part.strip(" ,;|·")
                if not part:
                    continue
                labeled = re.match(r"^(Name|Full name|Location|Address|Based in)\s*:\s*(.+)$", part, re.I)
                if labeled:
                    field = "full_name" if labeled[1].casefold() in ("name", "full name") else "location"
                    candidates[field].append((labeled[2].strip(), block))
                elif _LOCATION.fullmatch(part):
                    candidates["location"].append((part, block))
                elif _looks_name(part) and not candidates["full_name"]:
                    # A name belongs in the introductory block, not arbitrary prose.
                    if block is blocks[0] or block.bold or block.font_size == max(
                        (b.font_size or 0 for b in blocks), default=0
                    ) and block.font_size:
                        candidates["full_name"].append((part, block))
                    else:
                        leftovers.append((part, block))
                elif not re.fullmatch(r"(?:E-?mail|Phone|Tel(?:ephone)?|Mobile|Website|Portfolio|LinkedIn|GitHub)\s*:?", part, re.I):
                    leftovers.append((part, block))
        for field in ("full_name", "email", "phone", "location"):
            setattr(self.result.profile, field, self.choose(candidates[field], f"profile.{field}"))
        for text, block in leftovers:
            self.unparsed([block], "unrecognized_contact", text)

    def skills(self, blocks: list[SourceBlock], default: SkillCategory | None = None) -> None:
        category = default
        for block in blocks:
            text = _BULLET.sub("", block.text.strip())
            key = _heading_key(text)
            if key in _GROUPS:
                category = _GROUPS[key]
                self.mark(block, "section:skill_group")
                continue
            for chunk in re.split(r"\s*[;|·]\s*(?=[A-Za-z][A-Za-z &/-]*:)", text):
                label, separator, values = chunk.partition(":")
                if separator and _heading_key(label) in _GROUPS:
                    category = _GROUPS[_heading_key(label)]
                    chunk = values.strip()
                # Unspaced slashes are meaningful in C/C++ and CI/CD.
                for name in re.split(r"\s*[,;|•·]\s*|\t+|\s{2,}|\s+/\s+", chunk):
                    name = name.strip()
                    if not name:
                        continue
                    resolved = category or _skill_category(name)
                    existing = next((index for index, skill in enumerate(self.result.skills)
                                     if skill.name.casefold() == name.casefold() and skill.category == resolved), None)
                    if existing is None:
                        existing = len(self.result.skills)
                        self.result.skills.append(DraftSkill(name=name, category=resolved))
                        if resolved is None:
                            self.warn("unresolved_skill_category", "The skill category needs review.",
                                      [block], f"skills.{existing}.category")
                    self.mark(block, f"skills.{existing}.name")
                    if resolved is not None:
                        self.mark(block, f"skills.{existing}.category")

    def entries(self, blocks: list[SourceBlock], kind: EntryKind) -> None:
        pending: list[SourceBlock] = []
        current: DraftEntry | None = None
        current_index = -1
        bullet_source: SourceBlock | None = None
        parent: tuple[str, SourceBlock] | None = None

        def emit() -> DraftEntry | None:
            nonlocal pending, current_index, parent
            if not pending:
                return None
            index = len(self.result.entries)
            entry = self.header(pending, kind, index, parent)
            if not any((entry.org, entry.role, entry.start_date, entry.end_date)):
                # A discarded header must not point into a later entry.
                prefix = f"entries.{index}"
                for source in self.result.sources:
                    source.fields = [field for field in source.fields if not field.startswith(prefix + ".")]
                for warning in self.result.warnings:
                    if warning.field and (warning.field == prefix or warning.field.startswith(prefix + ".")):
                        warning.field = None
                self.unparsed(pending, "ambiguous_entry_header")
                self.warn("ambiguous_entry_header", "An entry header could not be identified.", pending)
                pending = []
                return None
            self.result.entries.append(entry)
            current_index = index
            if entry.org:
                standalone = next((b for b in pending if _clean(b.text) == entry.org), None)
                if standalone:
                    parent = (entry.org, standalone)
                elif not parent or parent[0] != entry.org:
                    parent = None
            if not entry.org:
                self.warn("missing_org", "The organization or project name needs review.", pending, f"entries.{index}.org")
            pending = []
            return entry

        for block in blocks:
            text = block.text.strip()
            subgroup = text.partition(":")[0]
            if kind == "education" and _GROUPS.get(_heading_key(subgroup)) == "coursework":
                self.skills([block], "coursework")
                continue
            is_bullet = bool(_BULLET.match(text) or block.bullet)
            if is_bullet:
                if pending:
                    current = emit()
                if current is None:
                    self.unparsed([block], "orphan_bullet")
                    self.warn("orphan_bullet", "A bullet could not be associated with an entry.", [block])
                elif kind == "education":
                    self.unparsed([block], "unsupported_education_bullet")
                else:
                    current.bullets.append(DraftBullet(text=_clean(_BULLET.sub("", text))))
                    self.mark(block, f"entries.{current_index}.bullets.{len(current.bullets) - 1}.text")
                    bullet_source = block
                continue
            if current is not None and current.bullets and bullet_source is not None:
                same_stream = block.column == bullet_source.column
                if same_stream and not block.gap_before and block.indent > bullet_source.indent + 1 and not (
                    _DATES.search(text) or _ROLE.search(text) or _ORG.search(text) or _SCHOOL.search(text)
                ):
                    current.bullets[-1].text += " " + _clean(text)
                    self.mark(block, f"entries.{current_index}.bullets.{len(current.bullets) - 1}.text")
                    continue
                current = None
                bullet_source = None
            if pending and any(_DATES.search(b.text) for b in pending):
                # A second date anchor or a new explicit school/company begins
                # a new entry even when the previous entry had no bullets.
                new_anchor = (_DATES.search(text) and (_ROLE.search(text) or _SCHOOL.search(text) or _ORG.search(text)))
                new_org = (_SCHOOL.search(text) if kind == "education" else _ORG.search(text)) and not _DEGREE.search(text)
                if new_anchor or new_org:
                    emit()
            pending.append(block)
        emit()

    def header(self, blocks: list[SourceBlock], kind: EntryKind, index: int,
               parent: tuple[str, SourceBlock] | None) -> DraftEntry:
        entry = DraftEntry(kind=kind)
        values: dict[str, list[tuple[str, SourceBlock]]] = defaultdict(list)
        undecided: list[tuple[str, SourceBlock]] = []
        label_fields = {"company": "org", "employer": "org", "organization": "org", "school": "org",
                        "project": "org", "project name": "org", "role": "role", "title": "role",
                        "position": "role", "degree": "role", "location": "location",
                        "description": "role", "start": "start_date", "end": "end_date"}
        for block in blocks:
            text = block.text.strip()
            for match in _GPA.finditer(text):
                values["detail"].append((match[1], block))
            text = _GPA.sub("", text)
            for link in [*block.links, *(DraftLink(url=m.group()) for m in _URL.finditer(text))]:
                url = _web_url(link.url)
                if url:
                    values["url"].append((url, block))
                    text = text.replace(link.url, "").replace(link.label, "") if link.label else text.replace(link.url, "")
            explicit = re.match(r"^([^:]+):\s*(.+)$", text)
            if explicit and explicit[1].casefold().strip() in label_fields:
                values[label_fields[explicit[1].casefold().strip()]].append((explicit[2].strip(), block))
                continue
            for match in _DATES.finditer(text):
                if match["end"]:
                    values["start_date"].append((match["start"], block))
                    values["end_date"].append((match["end"], block))
                else:
                    values["end_date"].append((match["start"], block))
            text = _DATES.sub("", text)
            text = re.sub(r"\b(?:expected(?: graduation)?|graduation|graduated|class of|dates?)\s*:?", "", text, flags=re.I)
            raw_parts = re.split(r"\s*[|·]\s*|\t+|\s{2,}|\s+[–—-]\s+|\s+@\s+|\s+at\s+", text, flags=re.I)
            parts = []
            for raw in raw_parts:
                first, comma, rest = raw.partition(",")
                if comma and _LOCATION.fullmatch(rest.strip()) and (_ORG.search(first) or _SCHOOL.search(first)):
                    parts.extend((first, rest))
                elif comma and kind == "education" and _SCHOOL.search(first) and _DEGREE.search(rest):
                    parts.extend((first, rest))
                else:
                    parts.append(raw)
            for raw in parts:
                part = raw.strip(" \t,:;–—-()")
                if not part:
                    continue
                if _mixed_header(part, kind):
                    undecided.append((part, block))
                elif _LOCATION.fullmatch(part) and not (_ROLE.search(part) or _ORG.search(part)):
                    values["location"].append((part, block))
                elif kind == "education" and _DEGREE.search(part):
                    values["role"].append((part, block))
                elif kind == "education" and _SCHOOL.search(part):
                    values["org"].append((part, block))
                elif kind != "education" and _ROLE.search(part) and not _ORG.search(part):
                    values["role"].append((part, block))
                elif _ORG.search(part) or kind == "education" and part.isupper():
                    values["org"].append((part, block))
                else:
                    undecided.append((part, block))
        if kind == "project":
            if not values["org"] and undecided and _looks_title(undecided[0][0]):
                values["org"].append(undecided.pop(0))
            if not values["role"] and len(undecided) == 1 and _looks_title(undecided[0][0]):
                values["role"].append(undecided.pop())
        elif not values["org"] and len(undecided) == 1 and not _mixed_header(undecided[0][0], kind) and _looks_title(undecided[0][0]) and (
            values["role"] or kind == "education"
        ):
            values["org"].append(undecided.pop())
        if not values["org"] and parent and values["role"] and values["end_date"]:
            role_source = values["role"][0][1]
            if role_source.indent > parent[1].indent + 1 or parent[1].bold and not role_source.bold:
                values["org"].append(parent)
        for field in ("org", "role", "location", "start_date", "end_date", "url", "detail"):
            setattr(entry, field, self.choose(values[field], f"entries.{index}.{field}"))
        for text, block in undecided:
            self.unparsed([block], "ambiguous_entry_header", text)
            self.warn("ambiguous_entry_header", "Header content needs review.", [block], f"entries.{index}")
        return entry

    def validate_lengths(self) -> None:
        commands: list[tuple[str, type[BaseModel], dict]] = [
            ("profile", ProfileUpdate, self.result.profile.model_dump())]
        for index, entry in enumerate(self.result.entries):
            commands.append((f"entries.{index}", EntryCreate, entry.model_dump(exclude={"bullets"})))
            commands.extend((f"entries.{index}.bullets.{j}", BulletCreate, bullet.model_dump())
                            for j, bullet in enumerate(entry.bullets))
        # Category uncertainty must not suppress independent length validation.
        commands.extend((f"skills.{index}", SkillCreate, {**skill.model_dump(), "category": skill.category or "tool"})
                        for index, skill in enumerate(self.result.skills))
        for path, model, command in commands:
            try:
                model.model_validate(command)
            except ValidationError as exc:
                for error in exc.errors():
                    field = ".".join([path, *map(str, error["loc"])])
                    # Missing organization is already reported with its header.
                    if field.endswith(".org") and not command.get("org"):
                        continue
                    sources = [b for b in self.result.sources if any(
                        value == field or field.startswith(value + ".") for value in b.fields)]
                    self.warn("field_too_long" if error["type"] == "string_too_long" else "invalid_field",
                              error["msg"], sources, field)


def _web_url(value: str) -> str | None:
    raw = value.strip().rstrip(".,;)")
    url = raw if re.match(r"^[a-z][a-z0-9+.-]*:", raw, re.I) else f"https://{raw}"
    try:
        parsed = urlsplit(url)
        return url if parsed.scheme in ("http", "https") and parsed.hostname and "." in parsed.hostname else None
    except ValueError:
        return None


def _looks_name(text: str) -> bool:
    words = text.split()
    return (2 <= len(words) <= 5 and not (_ROLE.search(text) or _ORG.search(text) or _DEGREE.search(text))
            and all(re.fullmatch(r"[^\W\d_](?:[^\W\d_]|[.'’\-])*", word, re.UNICODE)
                    and (word[0].isupper() or word in ("de", "del", "van", "von", "da", "al"))
                    for word in words))


def _looks_title(text: str) -> bool:
    return bool(text and len(text.split()) <= 12 and not text.endswith((".", "!", "?")))


def _mixed_header(text: str, kind: EntryKind) -> bool:
    return bool(_SCHOOL.search(text) and _DEGREE.search(text) if kind == "education"
                else _ROLE.search(text) and _ORG.search(text))


@lru_cache(maxsize=1)
def _skill_aliases() -> tuple[dict[str, str], dict[str, str]]:
    from api.taxonomy.skills import canon

    exact, folded = {}, {}
    categories = {"language": "language", "library": "framework", "framework": "framework",
                  "datastore": "data", "tool": "tool", "platform": "tool", "hardware": "tool",
                  "protocol": "tool", "format": "tool"}
    for skill in canon().values():
        category = categories.get(skill.category)
        if category is None:
            continue
        for alias in (skill.name, *skill.aliases):
            (exact if skill.case_sensitive else folded)[alias if skill.case_sensitive else alias.casefold()] = category
        for alias in skill.case_sensitive_aliases:
            exact[alias] = category
    return exact, folded


def _skill_category(name: str) -> SkillCategory | None:
    exact, folded = _skill_aliases()
    return exact.get(name) or folded.get(name.casefold())


def _parse(blocks: list[SourceBlock]) -> ParsedResume:
    if sum(len(block.text) for block in blocks) > MAX_EXTRACTED_CHARS:
        raise ParseError("extraction_limit", "Extracted content is too large to parse.")
    return _Parser(blocks).parse()


def parse_text(text: str) -> ParsedResume:
    """Parse English resume text without I/O; ambiguous content remains reviewable."""
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    try:
        size = len(text.encode("utf-8"))
    except UnicodeEncodeError as exc:
        raise ParseError("invalid_text", "Text contains invalid Unicode characters.") from exc
    if size > MAX_FILE_BYTES:
        raise ParseError("too_large", "Resume files must be 10 MB or smaller.")
    if len(text) > MAX_EXTRACTED_CHARS:
        raise ParseError("extraction_limit", "Extracted content is too large to parse.")
    return _parse(_text_blocks(text))


def parse_document(data: bytes, file_type: Literal["pdf", "docx"]) -> ParsedResume:
    """Extract and parse an in-memory document locally; no storage or network calls."""
    if file_type not in ("pdf", "docx"):
        raise ParseError("unsupported_type", "Supported document types are PDF and DOCX.")
    if not isinstance(data, bytes):
        raise TypeError("data must be bytes")
    if len(data) > MAX_FILE_BYTES:
        raise ParseError("too_large", "Resume files must be 10 MB or smaller.")
    return _parse(_pdf_blocks(data) if file_type == "pdf" else _docx_blocks(data))


def main(argv: list[str] | None = None) -> int:
    cli = argparse.ArgumentParser(description="Parse a resume locally and print a reviewable JSON draft.")
    cli.add_argument("file", type=Path, help="PDF, DOCX, or UTF-8 .txt file")
    args = cli.parse_args(argv)
    try:
        extension = args.file.suffix.casefold().removeprefix(".")
        if extension not in ("pdf", "docx", "txt"):
            raise ParseError("unsupported_type", "Choose a .pdf, .docx, or .txt file.")
        with args.file.open("rb") as stream:
            data = stream.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            raise ParseError("too_large", "Resume files must be 10 MB or smaller.")
        result = parse_text(data.decode("utf-8-sig")) if extension == "txt" else parse_document(data, extension)
        print(result.model_dump_json(indent=2))
        return 0
    except (ParseError, OSError, UnicodeError) as exc:
        print(f"{getattr(exc, 'code', 'input_error')}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
