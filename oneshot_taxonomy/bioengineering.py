"""Title evidence for bioengineering opportunity recommendations.

Degree fields remain broad discovery labels.  These rules are intentionally
title-only so company descriptions and legal/EEO boilerplate cannot admit a
posting into the recommendation set.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

__all__ = [
    "BIOENGINEERING_FILTER",
    "DIRECT_DOMAIN_PATTERN",
    "GENERIC_TECHNICAL_PATTERN",
    "NONTECHNICAL_PATTERN",
    "TECHNICAL_OR_STUDENT_PATTERN",
    "TitleEvidence",
    "title_evidence",
]

BIOENGINEERING_FILTER = "bioengineering"


def _bounded(expression: str) -> str:
    """Use boundaries understood by both Python and PostgreSQL regex engines."""
    return rf"(^|[^a-z0-9])(?:{expression})([^a-z0-9]|$)"


DIRECT_DOMAIN_PATTERN = _bounded(
    r"bio[- ]?engineer(?:ing)?"
    r"|bio[- ]?medical[ -]+engineer(?:ing)?"
    r"|biological[ -]+engineering"
    r"|biochemical[ -]+engineering"
    r"|biosystems?[ -]+engineering"
    r"|clinical[ -]+engineering"
    r"|neuro[- ]?engineer(?:ing)?"
    r"|neural[ -]+engineer(?:ing)?"
    r"|biomechanics?"
    r"|bio[- ]?materials?"
    r"|tissue[ -]+engineering"
    r"|regenerative[ -]+medicine"
    r"|bio[- ]?sensors?"
    r"|bio[- ]?informatics?"
    r"|computational[ -]+biology"
    r"|bio[- ]?statistics?"
    r"|bio[- ]?statisticians?"
    r"|immunology"
    r"|neuroscience"
    r"|neurobiology"
    r"|pharmacology"
    r"|toxicology"
    r"|microbiology"
    r"|molecular[ -]+biology"
    r"|biochemistry"
    r"|biophysics"
    r"|pharmaceutical[ -]+sciences?"
    r"|drug[ -]+(?:discovery|development|delivery)"
    r"|assay[ -]+development"
    r"|cell[ -]+(?:biology|culture|engineering)"
    r"|protein[ -]+(?:design|engineering)"
    r"|bio[- ]?process(?:ing|es|[ -]+engineering)"
    r"|bio[- ]?manufacturing"
    r"|bio[- ]?refiner(?:y|ies)"
    r"|(?:upstream|downstream)[ -]+process(?:ing|es)?"
    r"|fermentation"
    r"|lab(?:oratory)?[ -]+automation"
    r"|microfluidics?"
    r"|bio[- ]?technology"
    r"|bio[- ]?tech"
    r"|medical[ -]+devices?"
    r"|medical[ -]+imaging"
    r"|diagnostic[ -]+imaging"
    r"|bio[- ]?medical[ -]+equipment"
    r"|medical[ -]+equipment"
    r"|surgical[ -]+robotics?"
    r"|neural[ -]+interfaces?"
    r"|brain[- ]+(?:computer|machine)[ -]+interfaces?"
    r"|prosthetics?"
    r"|orthotics?"
    r"|medical[ -]+implants?"
    r"|clinical[ -]+(?:research|trials?|operations?|development|affairs?)"
    r"|regulatory[ -]+(?:affairs?|science)"
)

TECHNICAL_OR_STUDENT_PATTERN = _bounded(
    r"(?:bio|neuro)?[- ]?engineer(?:ing)?"
    r"|scientists?"
    r"|research(?:er)?"
    r"|associates?"
    r"|assistants?"
    r"|technicians?"
    r"|technologists?"
    r"|analysts?"
    r"|developers?"
    r"|programmers?"
    r"|clinical"
    r"|regulatory"
    r"|lab(?:oratory)?"
    r"|process"
    r"|manufacturing"
    r"|quality"
    r"|validation"
    r"|specialists?"
    r"|intern(?:ship)?s?"
    r"|co[- ]?ops?"
    r"|students?"
    r"|trainees?"
    r"|apprentices?"
)

NONTECHNICAL_PATTERN = _bounded(
    r"sales"
    r"|marketing"
    r"|brand"
    r"|commercial"
    r"|finance"
    r"|accounting"
    r"|recruit(?:er|ing|ment)"
    r"|human[ -]+resources?"
    r"|legal"
    r"|counsel"
    r"|communications?"
    r"|business[ -]+technology"
    r"|business[ -]+development"
    r"|customer[ -]+success"
    r"|account[ -]+executives?"
    r"|product[ -]+specialists?"
    r"|administrative"
    r"|executive[ -]+assistants?"
    r"|video(?:graphy|grapher|grapher)?"
    r"|partnerships?"
)

GENERIC_TECHNICAL_PATTERN = _bounded(
    r"research[ -]+(?:scientist|associate|assistant|engineer|technician)s?"
    r"|r[& ]?d[ -]+(?:engineer|scientist|associate|technician|intern)s?"
    r"|(?:process|manufacturing|product[ -]+development)[ -]+"
    r"(?:engineer|scientist|associate|technician)s?"
    r"|(?:quality|qa|qc|validation)[ -]+"
    r"(?:engineer|scientist|associate|specialist|technician|intern)s?"
    r"|(?:lab|laboratory)[ -]+"
    r"(?:scientist|associate|assistant|engineer|technician|technologist|intern)s?"
    r"|(?:clinical|regulatory)[ -]+"
    r"(?:engineer|scientist|associate|specialist|technologist|coordinator|intern)s?"
    r"|(?:systems?|mechanical|electrical|mechatronics|materials?|software|data|"
    r"machine[- ]+learning|automation)[ -]+engineer(?:ing|s)?"
    r"|field[ -]+(?:service|technical)[ -]+(?:engineer|technician)s?"
    r"|engineering[ -]+(?:intern|co[- ]?op|trainee|apprentice)s?"
)

_DIRECT_DOMAIN = re.compile(DIRECT_DOMAIN_PATTERN, re.IGNORECASE)
_TECHNICAL_OR_STUDENT = re.compile(TECHNICAL_OR_STUDENT_PATTERN, re.IGNORECASE)
_NONTECHNICAL = re.compile(NONTECHNICAL_PATTERN, re.IGNORECASE)
_GENERIC_TECHNICAL = re.compile(GENERIC_TECHNICAL_PATTERN, re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class TitleEvidence:
    recommend: bool
    reason: str | None = None


def title_evidence(title: str, *, bio_employer: bool) -> TitleEvidence:
    """Classify role evidence without consulting description text."""
    if _NONTECHNICAL.search(title):
        return TitleEvidence(False)
    if _DIRECT_DOMAIN.search(title) and _TECHNICAL_OR_STUDENT.search(title):
        return TitleEvidence(True, "direct_bio_title")
    if bio_employer and _GENERIC_TECHNICAL.search(title):
        return TitleEvidence(True, "bio_employer_technical_title")
    return TitleEvidence(False)
