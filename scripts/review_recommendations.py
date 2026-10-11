"""Prepare the local evidence used for Chris's October 11 job review.

Reads a read-only OneShot export in build/. No application/account writes.
Final decisions and public page data are maintained separately.
"""
import hashlib
import html
import json
import re
from collections import Counter
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"


def text(value):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", value or ""))).strip()


def identity(job):
    url = urlsplit(job["source_url"] or job["apply_url"] or "")
    qs = parse_qs(url.query)
    for key in ("gh_jid", "jobId", "jobid", "requisitionId", "reqId"):
        if qs.get(key):
            return (job["company"].casefold(), key.casefold(), qs[key][0])
    if "myworkdayjobs.com" in url.netloc:
        return (job["company"].casefold(), "workday", url.path.rsplit("_", 1)[-1].lower())
    if "greenhouse.io" in url.netloc or "ashbyhq.com" in url.netloc or "lever.co" in url.netloc:
        return (job["company"].casefold(), "ats", url.path.strip("/").split("/")[-1])
    return (url.netloc.lower(), url.path.rstrip("/").lower(), tuple(sorted((k,v[0]) for k,v in qs.items() if k.lower() in {"id", "job", "domain", "opportunityid"})))


STRONG = re.compile(r"software|\bSWE\b|\bSDE\b|developer|programmer|back.end|front.end|full.stack|data engineer|data platform|data ops|machine learning|artificial intelligence|\bAI[/ -]?ML\b|\bAI\b|devops|site reliability|infrastructure (engineer|automat)|firmware|embedded (software|system|engineer)|quantitative developer|security (software|engineer)|test automat|compiler|comput(er|ing) engineer", re.I)
WRONG = re.compile(r"mechanical|civil|structural|thermal|chemical|material|industrial|electrical|supply chain|sales|product manag|business analy|marketing|human resources|ui/ux|UX/UI|graphic|product design|hardware|silicon|ASIC|VLSI|physical design|IC design|FPGA|analog|mixed.signal|chip|transistor|semiconductor|RF |radio|optical|photonic|SoC|Soils", re.I)


def title_screen(job):
    title, description = job["title"], text(job["description"])
    if re.search(r"Ph\.?D|doctoral|postdoc|post.doc|masters?\b|master\W+s\b|graduate student",title,re.I) and not re.search(r"bachelor|undergrad|\bBS\b|\bB.S",title,re.I):
        return "Graduate-only degree requirement in title"
    if WRONG.search(title) and not re.search(r"software|firmware|embedded software|data engineer|developer|compiler|AI[/ ]?ML|AI security",title,re.I):
        return "Specialty outside SWE resume"
    if not STRONG.search(title) and not (re.search(r"computer science|software engineering",description,re.I) and re.search(r"develop.{0,60}(software|application)|programming|python|javascript|java\b|\bSQL\b",description,re.I) and not WRONG.search(title)):
        return "No clear SWE implementation work"
    return None


def sentences(job):
    raw = html.unescape(re.sub(r"<[^>]+>", "\n", job["description"] or ""))
    return [text(s) for s in re.split(r"\n|(?<=[.!?;])\s+",raw) if text(s)]


def evidence(job):
    lines = sentences(job)
    requirements = [s for s in lines if re.search(r"pursuing|enrolled|graduat|citizen|sponsor|bachelor|master|PhD|clearance|U\.S\. person|GPA|minimum|require|must|qualifications|202[6789]|undergrad|experience",s,re.I)]
    return {"requirements": requirements, "summary": job["attributes"].get("summary"), "skills": job["attributes"].get("skills", [])}


def main():
    jobs = json.loads((BUILD / "recommendations-2026-10-11-candidates.json").read_text())
    excluded, groups = [], {}
    for job in jobs:
        reason = title_screen(job)
        if reason:
            excluded.append({"id":job["id"],"company":job["company"],"title":job["title"],"reason":reason})
            continue
        groups.setdefault(identity(job),[]).append(job)
    review = []
    for group in groups.values():
        group.sort(key=lambda j:(not j["source"].startswith("simplify:"), len(j["description"] or "")),reverse=True)
        job = group[0]
        job["aliases"] = [g["id"] for g in group[1:]]
        job["duplicate_sources"] = [g["source"] for g in group[1:]]
        job["evidence"] = evidence(job)
        review.append(job)
    review.sort(key=lambda j:(j["company"].casefold(),j["title"],j["id"]))
    (BUILD / "recommendations-review-dedup.json").write_text(json.dumps(review,indent=2))
    (BUILD / "recommendations-title-exclusions.json").write_text(json.dumps(excluded,indent=2))
    print("Recent universe:",len(jobs),"Title exclusions:",len(excluded),"Relevant unique URLs:",len(review),"Duplicate URLs:",sum(len(j["aliases"]) for j in review))
    print("Types:",Counter(j["job_type"] for j in review),"Empty descriptions:",sum(not j["description"] for j in review))


if __name__ == "__main__":
    main()
