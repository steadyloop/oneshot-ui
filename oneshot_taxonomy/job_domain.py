"""Title evidence for software and quantitative-finance opportunity labels.

Title-only, like `bioengineering`: descriptions are saturated with degree
boilerplate ("BS in Computer Science or related field") and EEO text, so they
admit far more than they resolve.  Staying on the title also keeps every
pattern bindable into SQL, which is why these labels need no stored column.

The cascade order is the design.  Strong software evidence outranks the
nontechnical veto, because the veto words are frequently *program* names rather
than role nouns -- Amazon posts applied-science roles under "Student Science
Recruiting", Salesforce under "Emerging Talent", and a trading desk is titled
"Sales and Trading".  `PROGRAM_NOISE_PATTERN` strips that scheduling and
program vocabulary before any rule sees the title; the remaining veto then runs
against role nouns only.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

__all__ = [
    "FINANCE_FILTER",
    "FINANCE_FUNCTION_PATTERN",
    "IT_ROLE_PATTERN",
    "NONTECHNICAL_PATTERN",
    "PROGRAM_NOISE_PATTERN",
    "QUANT_PATTERN",
    "QUANT_ROLE_PATTERN",
    "SOFTWARE_FILTER",
    "SOFTWARE_RESCUE_PATTERN",
    "SOFTWARE_STRONG_PATTERN",
    "SOFTWARE_WEAK_PATTERN",
    "STUDENT_DOMAIN_GUARD_PATTERN",
    "STUDENT_DOMAIN_PATTERN",
    "UNLABELED_FILTER",
    "ADJACENT_DISCIPLINE_PATTERN",
    "DomainEvidence",
    "classify",
    "normalize_title",
]

SOFTWARE_FILTER = "software"
FINANCE_FILTER = "finance"
UNLABELED_FILTER = "unlabeled"


def _bounded(expression: str) -> str:
    """Use boundaries understood by both Python and PostgreSQL regex engines."""
    return rf"(^|[^a-z0-9])(?:{expression})([^a-z0-9]|$)"


# Scheduling and program vocabulary, stripped before any rule reads the title.
# Without this the veto below fires on posting-program names, not on roles.
PROGRAM_NOISE_PATTERN = (
    r"\b(?:"
    r"emerging talent"                       # Salesforce, Nebius program name
    r"|early talent"                         # same shape
    r"|student science recruiting"           # Amazon applied-science wrapper
    r"|science recruiting"                   # same, shortened
    r"|university recruiting"                # campus program name
    r"|campus recruiting"                    # campus program name
    r"|early career"                         # seniority marker, not a role
    r"|talent acquisition"                   # program name
    r"|leadership development program"       # rotational program name
    r"|rotational program"                   # rotational program name
    r"|development program"                  # rotational program name
    r"|internship program"                   # program name
    r"|20\d\d(?:[-/]\d{2,4})?"               # posting year and year ranges
    r"|summer|fall|winter|spring"            # season
    r")\b"
)

# Unambiguous software evidence.  Outranks NONTECHNICAL_PATTERN.
SOFTWARE_STRONG_PATTERN = _bounded(
    r"software"                                          # head term
    r"|swe|sde|sre"                                      # role abbreviations
    r"|devops|site reliability"                          # ops-side engineering
    r"|distributed systems|operating systems|kernel"     # systems software
    r"|compiler"                                         # systems software
    r"|firmware|embedded software"                       # embedded software
    r"|artificial intelligence|nlp|computer vision"      # AI subfields
    r"|(?:machine|deep|reinforcement) learning"          # ML subfields
    r"|security engineer[a-z]*"                          # security engineering
    r"|cyber ?securit[a-z]*"                             # spaced and closed form
    r"|robotics software"                                # software-qualified
    r"|(?:web|mobile|application|software|game|systems) deve[a-z]*"  # developer roles
    r"|data (?:engineer|scien|architect|platform)[a-z]*"             # data engineering
    r"|(?:applied|research|computer|data|machine learning) scien[a-z]*"  # scientist roles
    r"|computer (?:scien|engineer)[a-z]*"                # CS/CE field name
    r"|(?:front|back)[- ]?end|full[- ]?stack"            # web-stack position
    r"|programm(?:er|ing)[a-z]*"                         # excludes British "programme"
)

# Software evidence too weak to outrank the veto: "Human Resources Intern,
# Digital & AI" is an HR role.  Read only after NONTECHNICAL_PATTERN clears.
SOFTWARE_WEAK_PATTERN = _bounded(
    r"ai|ml"                                             # bare initialisms
    r"|android|ios"                                      # mobile platform alone
    r"|application deve[a-z]*"                           # generic in enterprise IT
    r"|data analy[a-z]*"                                 # analyst, not engineer
    r"|(?:cloud|platform|infrastructure|test|automation|qa|devops|reliability)"
    r"[ -]+engineer[a-z]*"                               # qualifier carries the meaning
)

# Domain nouns that mean software when a student role noun sits beside them.
# Each is ambiguous alone -- `Infrastructure Sales`, `Infrastructure Fund`,
# `Foundry Technology Engineer`, `DRAM Device & Cell Technology Engineer` -- so
# the *pairing* carries the label.  This stage is deliberately never widened to
# the bare domain noun; that is what the guard list below exists to hold.
STUDENT_DOMAIN_PATTERN = _bounded(
    r"(?:technolog(?:y|ies)|infrastructure|devops|kubernetes|observability)"
    r"[ -]+(?:intern(?:ship)?s?|co[- ]?ops?)"  # adjacency is load-bearing: without
)                                              # it, "Pharmaceutical Technology ...
                                               # Internship" and "Yield Technology"
                                               # follow the domain noun in.

# Qualifiers that make such a pairing something other than software.
STUDENT_DOMAIN_GUARD_PATTERN = _bounded(
    r"surgical|assistive"                    # clinical and accessibility equipment
    r"|information[a-z]* technology"         # IT administration, excluded by scope
    r"|data cent(?:er|re)[a-z]*"             # a building, not a platform
    r"|bank[a-z]*|financial?|fund"           # infrastructure as an asset class
    r"|invest[a-z]*|procurement|category"    # infrastructure as a spend category
    r"|electrical|hardware|civil|acoustic"   # physical infrastructure
    r"|construction|composites"              # physical infrastructure
    r"|maintenance|facilit[a-z]*|support"    # operations, not engineering
)

# Disciplines that share vocabulary with software but are not software.
# Blocks "Analog Test Engineer" and "Environmental Test Engineer".
ADJACENT_DISCIPLINE_PATTERN = _bounded(
    r"analog|electrical"                     # circuit design
    r"|mechanic[a-z]*"                       # mechanical engineering
    r"|environmental|civil|chemical"         # other engineering disciplines
    r"|structural|materials|thermal"         # other engineering disciplines
    r"|hvac|acoustic"                        # building and audio systems
    r"|flight test|wafer"                    # aerospace and fab process
)

# Re-admits a title the adjacent-discipline guard would otherwise steal:
# "Electronic Design Automation" is software, "Analog Test Engineer" is not.
SOFTWARE_RESCUE_PATTERN = _bounded(
    r"software"                              # head term survives any qualifier
    r"|computer science"                     # field name
    r"|machine learning"                     # ML subfield
    r"|ai|ml"                                # bare initialisms
    r"|firmware|embedded software"           # embedded software
    r"|data scien[a-z]*"                     # data science
)

# Nontechnical roles.  Terminal veto, read after strong software evidence.
NONTECHNICAL_PATTERN = _bounded(
    r"human resources|hr|people operations"  # HR function
    r"|recruit[a-z]*"                        # talent function
    r"|legal|counsel|paralegal"              # legal function
    r"|marketing|brand|public relations"     # marketing function
    r"|social media|content|copywrit[a-z]*"  # content function
    r"|graphic design"                       # design function
    r"|account executive"                    # sales role
    r"|customer success|customer support"    # post-sales function
    r"|technical support|help desk"          # support desk, not engineering
    r"|hospitality|retail|store"             # storefront operations
    r"|merchandis[a-z]*"                     # retail merchandising
    r"|supply chain|logistics|warehouse"     # supply-chain operations
    r"|facilities|driver"                    # facilities and transport
    r"|nurse|counselor|therapist|teacher"    # clinical and education
    r"|administrative|receptionist"          # administrative support
    r"|payroll|benefits"                     # HR-adjacent finance function
)

# Quantitative / applied-math finance.  Not the corporate finance function.
QUANT_PATTERN = _bounded(
    r"quantitative|quant"                    # bounded form excludes "quantum"
    r"|trad(?:ing|er[a-z]*)"                 # trading desk
    r"|market mak[a-z]*"                     # market making
    r"|systematic|derivatives|fixed income"  # strategy and asset class
    r"|portfolio (?:manage|analy|construction|implementation"
    r"|research|strateg|solutions?|control|officer)[a-z]*"  # not product portfolios
    r"|equity (?:research|analy[a-z]*|derivativ[a-z]*)"  # equity desk
    r"|investment (?:analyst|research|management)"       # narrow: not "operations"
    r"|risk model[a-z]*"                     # risk modeling
    r"|financial engineer[a-z]*"             # financial engineering
    r"|econometric[a-z]*"                    # econometrics
    r"|actuar[a-z]*"                         # actuarial
    r"|macro analyst"                        # macro research
)

# Corporate finance function: out of scope even at a quant employer.
FINANCE_FUNCTION_PATTERN = _bounded(
    r"account(?:ing|ant[a-z]*)"              # accounting function
    r"|audit[a-z]*"                          # audit function
    r"|tax|treasury|fp&a"                    # corporate finance function
    r"|controller|financial reporting"       # corporate finance function
    r"|payroll"                              # payroll function
)

# Role nouns that carry quant meaning once the employer prior supplies domain.
QUANT_ROLE_PATTERN = _bounded(
    r"quant[a-z]*|research[a-z]*"            # research-side roles
    r"|trading|trader|macro"                 # trading-side roles
    r"|investment|portfolio|credit"          # investment-side roles
    r"|modeler|actuarial"                    # modeling roles
)

# Infrastructure roles at a quant employer are not quant roles.
IT_ROLE_PATTERN = _bounded(
    r"network|linux|windows"                 # platform administration
    r"|sysadmin|system administrat[a-z]*"    # platform administration
    r"|identity management"                  # access administration
    r"|security governance"                  # policy, not engineering
    r"|help ?desk|desktop"                   # support desk
)

_PROGRAM_NOISE = re.compile(PROGRAM_NOISE_PATTERN, re.IGNORECASE)
_SOFTWARE_STRONG = re.compile(SOFTWARE_STRONG_PATTERN, re.IGNORECASE)
_SOFTWARE_WEAK = re.compile(SOFTWARE_WEAK_PATTERN, re.IGNORECASE)
_STUDENT_DOMAIN = re.compile(STUDENT_DOMAIN_PATTERN, re.IGNORECASE)
_STUDENT_DOMAIN_GUARD = re.compile(STUDENT_DOMAIN_GUARD_PATTERN, re.IGNORECASE)
_ADJACENT_DISCIPLINE = re.compile(ADJACENT_DISCIPLINE_PATTERN, re.IGNORECASE)
_SOFTWARE_RESCUE = re.compile(SOFTWARE_RESCUE_PATTERN, re.IGNORECASE)
_NONTECHNICAL = re.compile(NONTECHNICAL_PATTERN, re.IGNORECASE)
_QUANT = re.compile(QUANT_PATTERN, re.IGNORECASE)
_FINANCE_FUNCTION = re.compile(FINANCE_FUNCTION_PATTERN, re.IGNORECASE)
_QUANT_ROLE = re.compile(QUANT_ROLE_PATTERN, re.IGNORECASE)
_IT_ROLE = re.compile(IT_ROLE_PATTERN, re.IGNORECASE)

_WHITESPACE = re.compile(r"\s+")


def normalize_title(title: str) -> str:
    """Strip program and scheduling vocabulary so the veto reads role nouns."""
    return _WHITESPACE.sub(" ", _PROGRAM_NOISE.sub(" ", title)).strip()


@dataclass(frozen=True, slots=True)
class DomainEvidence:
    label: str | None
    reason: str | None = None


def classify(title: str, *, quant_employer: bool = False) -> DomainEvidence:
    """Label a posting `software`, `finance`, or neither, from its title."""
    normalized = normalize_title(title)
    if _SOFTWARE_STRONG.search(normalized) and not (
        _ADJACENT_DISCIPLINE.search(normalized)
        and not _SOFTWARE_RESCUE.search(normalized)
    ):
        return DomainEvidence(SOFTWARE_FILTER, "software_title")
    if _NONTECHNICAL.search(normalized):
        return DomainEvidence(None, "nontechnical_veto")
    if _SOFTWARE_WEAK.search(normalized) and not _ADJACENT_DISCIPLINE.search(normalized):
        return DomainEvidence(SOFTWARE_FILTER, "software_weak_title")
    if (
        _STUDENT_DOMAIN.search(normalized)
        and not _STUDENT_DOMAIN_GUARD.search(normalized)
    ):
        return DomainEvidence(SOFTWARE_FILTER, "student_domain_title")
    if _QUANT.search(normalized) and not _FINANCE_FUNCTION.search(normalized):
        return DomainEvidence(FINANCE_FILTER, "quant_title")
    if (
        quant_employer
        and _QUANT_ROLE.search(normalized)
        and not _FINANCE_FUNCTION.search(normalized)
        and not _IT_ROLE.search(normalized)
    ):
        return DomainEvidence(FINANCE_FILTER, "quant_employer_title")
    return DomainEvidence(None)
