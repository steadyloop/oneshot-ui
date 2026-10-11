"""Build Chris's dated application queue from the ignored research artifacts.

Only public job metadata and concise review paraphrases reach the browser.
This script never reads credentials or writes applications to the tracker.
"""
import html
import json
import re
from collections import Counter, defaultdict
from datetime import date, datetime
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
START, END = date(2026, 9, 22), date(2026, 10, 11)
PACIFIC = ZoneInfo("America/Los_Angeles")
COMPANY_NAMES = {
    "globalhr": "RTX", "biibhr": "Biogen", "bostonscientific": "Boston Scientific",
    "cmu": "Carnegie Mellon University", "gartner": "Gartner", "generac": "Generac",
    "gmppu": "GM Performance Power Units", "greenheckgroup": "Greenheck Group",
    "grow-therapy": "Grow Therapy", "guidestone": "GuideStone", "hcsc": "Health Care Service Corporation",
    "hccg.fa.us2": "SI Group", "hcrb.fa.us2": "Boston Beer Company",
    "ibqbjb.fa.ocs": "Honeywell Technologies", "hermeus": "Hermeus", "hyvee": "Hy-Vee",
    "icf": "ICF", "igsenergy": "IGS Energy", "interdigital": "InterDigital",
    "ipconfigure": "IPConfigure", "irhythmtech": "iRhythm Technologies", "itron": "Itron",
    "ivytech": "Ivy Tech Community College", "jabil": "Jabil", "kitware": "Kitware",
    "leantechniques": "Lean TECHniques", "livanova": "LivaNova", "mach9": "Mach9",
    "manulife": "Manulife", "nelnet": "Nelnet", "nxp": "NXP", "osu": "The Ohio State University",
    "pacificlife": "Pacific Life", "pae": "Amentum", "pentair": "Pentair", "permianres": "Permian Resources",
    "primient": "Primient", "q2ebanking": "Q2", "radiancetech": "Radiance Technologies",
    "range": "Range", "rbc": "RBC", "relay": "Relay", "revel": "Revel", "revvity": "Revvity",
    "rhsc": "Delta Dental of Michigan, Ohio, and Indiana", "rivet": "Rivet",
    "sbdinc": "Stanley Black & Decker", "sephora": "Sephora", "solopulseco": "SoloPulse",
    "southstatebank": "SouthState Bank", "spartannash": "SpartanNash", "swirecc": "Swire Coca-Cola",
    "symbotic": "Symbotic", "synnex": "TD SYNNEX", "tcenergy": "TC Energy", "td": "TD",
    "tencent": "Tencent", "texasfarm": "Texas Farm Bureau", "ukg": "UKG", "viget": "Viget",
    "dukeenergy": "Duke Energy", "modmed": "Modernizing Medicine", "my7elevenhr": "7-Eleven",
    "fa-elpm-saasfaprod1.fa.ocs": "Ulterra", "fa-esbv-saasfaprod1.fa.ocs": "First Solar",
    "fa-etum-saasfaprod1.fa.ocs": "Florida Blue / GuideWell", "cbha.fa.us2": "Ricoh",
    "cbabd1ae-568b-4f70-933b-3f462f76c1b5/19000101_000001": "Hidden Level",
    "cva.fa.us1": "StandardAero", "ejko.fa.us2": "Blue Cross Blue Shield of Michigan",
    "fa-ewkd-saasfaprod1.fa.ocs": "USF Institute of Applied Engineering",
    "wexinc": "WEX", "axcelis": "Axcelis", "boseallaboutme": "Bose", "gdit": "General Dynamics Information Technology",
    "myhrabc": "Cencora", "firstnational": "First National Bank of Omaha", "thrivent": "Thrivent",
    "americancentury": "American Century Investments", "mckesson": "McKesson", "abglobal": "AllianceBernstein",
    "assurant": "Assurant", "midlandsb": "Midland States Bank", "chartermfg": "Charter Manufacturing",
    "directsupply": "Direct Supply", "axos": "Axos Bank", "cokeflorida": "Coca-Cola Beverages Florida",
    "volarisgroup": "Volaris Group", "veteransunited": "Veterans United", "costar": "CoStar Group",
    "thomsonreuters": "Thomson Reuters", "copart": "Copart", "wasatchproperty": "Wasatch Property Management",
    "dtna": "Daimler Truck North America", "alston": "Alston & Bird", "birdseyeaccount": "Birdseye",
    "commercebank": "Commerce Bank", "gaig": "Great American Insurance Group", "bankeasy": "First Bank & Trust",
    "modernatx": "Moderna", "wintrust": "Wintrust", "aep": "American Electric Power",
    "bcbsms": "Blue Cross & Blue Shield of Mississippi", "athene": "Athene", "entrust": "Entrust",
    "borgwarner": "BorgWarner", "cae": "CAE", "astroforge-io": "AstroForge", "shopback-2": "ShopBack",
    "bracco": "Bracco Medical Technologies", "woodmenlife": "WoodmenLife", "fhlbc": "FHLBank Chicago",
    "bristolmyerssquibb": "Bristol Myers Squibb", "freese": "Freese and Nichols", "dmainc": "DMA",
    "valeo": "Valeo", "theocc": "OCC", "thehartford": "The Hartford", "centene": "Centene",
    "builders": "Builders FirstSource", "ffive": "F5", "dynama-ai": "Dynama", "cswg": "C&S Wholesale Grocers",
    "fhlb": "FHLB Dallas", "flir": "Teledyne FLIR", "tractian-technologies-inc-": "TRACTIAN",
    "chemours": "Chemours", "crabi-robotics-com": "CRABI Robotics", "barrywehmiller": "Barry-Wehmiller",
    "rcu": "Redwood Credit Union",
}


def read(name, default=None):
    path = BUILD / name
    return json.loads(path.read_text()) if path.exists() else default


def plain(value):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", value or ""))).strip()


def calendar_day(value):
    if not value:
        return None
    if len(value) == 10:
        return date.fromisoformat(value)
    value = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", value.replace("Z", "+00:00"))
    stamp = datetime.fromisoformat(value)
    return stamp.astimezone(PACIFIC).date() if stamp.tzinfo else stamp.date()


def identity(job):
    parsed = urlsplit(job.get("source_url") or job.get("apply_url") or "")
    qs = parse_qs(parsed.query)
    if qs.get("gh_jid"):
        return ("greenhouse", qs["gh_jid"][0])
    if "greenhouse.io" in parsed.netloc:
        found = re.search(r"/jobs/(\d+)", parsed.path)
        if found:
            return ("greenhouse", found[1])
    if "eightfold" in job["source"] or "/careers/job/" in parsed.path:
        found = re.search(r"/careers/job/(\d+)", parsed.path)
        if found:
            return ("eightfold", parsed.netloc.lower(), found[1])
    if "myworkdayjobs.com" in parsed.netloc:
        return (parsed.netloc.lower(), parsed.path.rsplit("_", 1)[-1].lower())
    if "ashbyhq.com" in parsed.netloc or "lever.co" in parsed.netloc:
        ids = re.findall(r"[a-f0-9]{8}-[a-f0-9-]{27,}", parsed.path, re.I)
        if ids:
            return ("ats_uuid", ids[0].lower())
    if "workable.com" in parsed.netloc:
        found = re.search(r"/j/([A-Z0-9]+)", parsed.path, re.I)
        if found:
            return ("workable", found[1].upper())
    keys = {"id", "job", "jobid", "domain", "opportunityid", "pid", "cid", "ccid"}
    return (parsed.netloc.lower(), parsed.path.rstrip("/").lower(), tuple(sorted((k.lower(), v[0]) for k, v in qs.items() if k.lower() in keys)))


def gpa_requirements(description):
    text = plain(description)
    required, preferred = [], []
    headings = re.compile(r"preferred qualifications|qualifications we prefer|qualifications we desire|desired qualifications|how you can stand out|what will our ideal candidate have|skills that will help you stand|preferred skills and experience|minimum qualifications|basic qualifications|minimum requirements|qualifications you must have|required qualifications|what you need to be successful", re.I)
    for match in re.finditer(r"\bG\.?P\.?A\.?\b", text, re.I):
        beginning = max(0, match.start() - 70)
        nearby = text[beginning:match.end() + 80]
        numbers = [m for m in re.finditer(r"[0-4]\.\d{1,2}", nearby) if float(m[0]) < 4.0]
        if not numbers:
            continue
        position = match.start() - beginning
        number = min(numbers, key=lambda m: min(abs(m.start() - position), abs(m.end() - position)))
        value = float(number[0])
        preceding = list(headings.finditer(text[:match.start()]))
        preference = bool(preceding and re.search(r"prefer|desire|stand out|ideal candidate|help you stand", preceding[-1][0], re.I))
        local = nearby[max(0, min(position, number.start()) - 25):max(position, number.end()) + 28]
        if re.search(r"preferred|not required", local, re.I):
            preference = True
        if re.search(r"must|is required|required:|minimum cumulative", local, re.I) and not re.search(r"not required|preferred", local, re.I):
            preference = False
        (preferred if preference else required).append(value)
    return {"gpa_min": max(required) if required else None, "gpa_preferred": max(preferred) if preferred else None}


def priority(row, description):
    score = {1: 140, 2: 95, 3: 45}[row["fit"]]
    score += {"Backend": 22, "Infrastructure": 20, "Data engineering": 19, "Full stack": 15, "General SWE": 13, "Embedded": 10, "ML engineering": 8, "Security": 6}.get(row["category"], 0)
    signals = [(r"distributed|back.end|microservice|rest(ful)? api|server.side", 8), (r"data pipeline|ingestion|etl|large.scale data|data infrastructure", 8), (r"postgres|relational database|sql", 5), (r"\bgo\b|golang", 4), (r"\bpython\b", 3), (r"concurrency|asynchronous|fault.toler|reliability|observability", 6), (r"linux|networking|tcp|rpc", 3), (r"streaming|ffmpeg|hls|video", 6)]
    score += min(32, sum(points for pattern, points in signals if re.search(pattern, plain(description), re.I)))
    age = (END - date.fromisoformat(row["posted_day"])).days
    score += 5 if age <= 3 else 3 if age <= 7 else 1
    if re.search(r"winter|spring|jan", row["term"], re.I):
        score += 6
    if row.get("deadline_day"):
        remaining = (date.fromisoformat(row["deadline_day"]) - END).days
        score += 40 if 0 <= remaining <= 2 else 15 if 0 <= remaining <= 7 else 0
    return score


def main():
    candidates = read("recommendations-2026-10-11-candidates.json")
    jobs = read("recommendations-review-dedup.json")
    decisions = [d for letter in "abc" for d in read(f"recommendations-decisions-{letter}.json")]
    extra = read("recommendations-extra-reviewed.json", {"jobs": [], "decisions": []})
    jobs.extend(extra["jobs"]); decisions.extend(extra["decisions"])
    assert len(decisions) == len(jobs), "Every candidate must receive a review"
    assert len({d["id"] for d in decisions}) == len(jobs)
    assert {d["id"] for d in decisions} == {j["id"] for j in jobs}
    by_id = {d["id"]: d for d in decisions}
    overrides = read("recommendations-parent-overrides.json", {})
    for job_id, override in overrides.items():
        assert int(job_id) in by_id
        by_id[int(job_id)] = {**by_id[int(job_id)], **override}
    live = read("recommendations-live-evidence.json")
    rendered = read("recommendations-rendered-evidence.json", {})
    dates = read("recommendations-date-evidence.json")
    gpa_overrides = read("recommendations-gpa-overrides.json", {})
    by_url = defaultdict(list)
    for source in read("recommendations-linked-source-evidence.json"):
        for url in {source["source_url"], source["apply_url"]} - {None, ""}:
            by_url[url].append(source)
    groups = defaultdict(list)
    for job in jobs:
        decision = by_id[job["id"]]
        link = dict(live.get(str(job["id"]), {}))
        browser = rendered.get(str(job["id"]), {})
        if browser.get("state") not in {None, "unknown"}:
            link.update(browser)
        matches = {r["id"]: r for u in {job["source_url"], job["apply_url"]} for r in by_url.get(u, [])}
        description = link.get("description") or job["description"] or max((r.get("description") or "" for r in matches.values()), key=len, default="")
        originals = [r for r in matches.values() if not r["source"].startswith("simplify:") and r["posted_at"]]
        employer_date = dates.get(str(job["id"]), {}).get("date") or link.get("posted_at")
        if not employer_date and originals:
            employer_date = min(r["posted_at"] for r in originals)
        if not employer_date and not job["source"].startswith("simplify:"):
            employer_date = job["posted_at"]
        body_dates = re.findall(r"(?:Date Posted|Posted Date|Original Posting Date)\s*:\s*(\d{4}-\d{2}-\d{2})", plain(description), re.I)
        if body_dates:
            employer_date = min([*body_dates, *([calendar_day(employer_date).isoformat()] if employer_date else [])])
        source_day = calendar_day(employer_date)
        basis = "employer" if source_day else "listing" if job["posted_at"] else "discovery"
        day = source_day or calendar_day(job["posted_at"] or job["first_seen_at"])
        view = {"include": "ready", "conditional": "conditional", "exclude": "excluded", "needs_details": "unverified", "needs_date": "unverified"}[decision["decision"]]
        reason, conditions = decision["reason"], list(decision.get("conditions", []))
        if view in {"ready", "conditional"} and not source_day:
            view = "unverified"
            conditions.append("Employer opening date unconfirmed; listing or discovery recency alone does not meet the 20-day requirement.")
        if source_day and not START <= source_day <= END:
            view = "excluded"
            reason = f"Employer first-publication date is {source_day.isoformat()}, outside September 22–October 11; a newer aggregator listing does not make this a new opening."
        if link.get("state") == "closed":
            view, reason = "excluded", "The employer posting is unavailable or reports that applications are closed; skip this listing."
        deadline = decision.get("deadline") or link.get("deadline") or job["attributes"].get("deadline_at")
        deadline_day = None
        if deadline:
            try:
                deadline_day = calendar_day(deadline)
                if deadline_day < END:
                    view, reason = "excluded", f"The employer's application deadline ({deadline_day.isoformat()}) has passed."
            except ValueError:
                pass
        # Academic thresholds remain visible at the user's request.
        gpa = {**gpa_requirements(description), **gpa_overrides.get(str(job["id"]), {})}
        if gpa["gpa_min"] is not None and gpa["gpa_min"] > 3.4 and view == "ready":
            view = "conditional"
        if gpa["gpa_min"] is not None and gpa["gpa_min"] >= 3.4 and view in {"ready", "conditional"}:
            conditions.append(f"Employer GPA minimum is {gpa['gpa_min']:g}; your cumulative GPA is approximately 3.4. Confirm the transcript value and whether major GPA is accepted. Retained at your request.")
        if job["company"].casefold() == "waymo":
            conditions.append("Waymo asks candidates to apply to their top three roles; choose the strongest matches here.")
        if job["company"].casefold() == "zipline":
            conditions.append("Zipline limits applications to three roles per 30 days; prioritize your strongest matches.")
        term = decision.get("term") or "Term unspecified"
        if not re.search(r"summer|spring|winter|fall|autumn|jan|feb|march|april|june|july|august|sept|october", term, re.I):
            title_term = re.search(r"(Summer|Spring|Winter|Fall|Autumn)\s*(202[67])", job["title"], re.I)
            if title_term:
                term = title_term[0]
        row = {
            "id": job["id"], "aliases": sorted(({*job.get("aliases", []), *matches.keys()} - {job["id"]})),
            "company": COMPANY_NAMES.get(job["company"], job["company"]), "title": job["title"].strip(),
            "location": job["location_text"] or "Location unspecified", "locations": job["locations"],
            "term": term, "job_type": job["job_type"], "fit": decision["fit"], "category": decision["category"],
            "view": view, "reason": reason, "conditions": list(dict.fromkeys(conditions)),
            "evidence": decision.get("evidence", ""), "skills": job["attributes"].get("skills", []),
            "posted_day": day.isoformat(), "posted_at": employer_date or job["posted_at"],
            "first_seen_at": job["first_seen_at"], "last_seen_at": job["last_seen_at"], "date_basis": basis,
            "deadline_day": deadline_day.isoformat() if deadline_day else None, "deadline": deadline,
            "link_state": link.get("state", "unknown"), "apply_url": job["source_url"] or job["apply_url"], "source": job["source"],
            **gpa,
        }
        row["gpa_note"] = gpa.get("gpa_note") or (f"Stated GPA minimum: {gpa['gpa_min']:g}." if gpa["gpa_min"] is not None else "No mandatory GPA threshold found in the reviewed description.")
        row["_priority"] = priority(row, description)
        groups[identity(job)].append(row)
    rows, duplicates = [], 0
    for group in groups.values():
        # A substantive review wins over a stub, then favor the original ATS.
        group.sort(key=lambda r: (r["view"] != "unverified", not r["source"].startswith("simplify:"), r["link_state"] == "verified", len(r["evidence"])), reverse=True)
        chosen = group[0]
        chosen["aliases"] = sorted({i for r in group for i in [r["id"], *r["aliases"]]} - {chosen["id"]})
        duplicates += len(group) - 1
        dated = [r for r in group if r["date_basis"] == "employer"]
        if dated:
            earliest = min(dated, key=lambda r: r["posted_day"])
            for key in ["posted_day", "posted_at", "date_basis"]:
                chosen[key] = earliest[key]
            if not START <= date.fromisoformat(earliest["posted_day"]) <= END:
                chosen["view"], chosen["reason"] = "excluded", earliest["reason"]
        if any(r["link_state"] == "closed" for r in group):
            chosen["view"], chosen["reason"] = "excluded", "The employer posting is unavailable or reports that applications are closed; skip this listing."
        rows.append(chosen)
    rows.sort(key=lambda r: ({"ready": 0, "conditional": 1, "unverified": 2, "excluded": 3}[r["view"]], -r["_priority"], r["company"].casefold(), r["title"], r["id"]))
    rank = 0
    for row in rows:
        if row["view"] in {"ready", "conditional"}:
            rank += 1
            row["rank"] = rank
            assert row["date_basis"] == "employer" and START <= date.fromisoformat(row["posted_day"]) <= END
        row.pop("_priority")
    counts = Counter(r["view"] for r in rows)
    data = {
        "reviewed_at": END.isoformat(), "window": {"start": START.isoformat(), "end": END.isoformat(), "timezone": "America/Los_Angeles", "days": 20},
        "metrics": {"recent_universe": len(candidates), "full_reviews": len(jobs), "extra_duplicates_collapsed": duplicates, **dict(counts)},
        "methodology": [
            "Scope: OneShot's active U.S. feed, including normalized locations marked unknown. Recent titles and descriptions were screened broadly, including technical work outside the Software label; plausible roles received a full eligibility review and a second completeness audit.",
            "Reviewed career/resume/Chris_Kim_Resume_swe.pdf and its HTML source: UCSD CS/Applied Math; OneShot's large-scale ingestion and reliability, TrueTone Go/video pipelines, ChainSense ML/data processing, NASA embedded firmware, and network-services teaching. Your updates replace summer-only availability: all terms through December 2027, extensible graduation, U.S. citizenship, no sponsorship, relocation allowed.",
            "Confirmed recommendations use employer publication dates within September 22–October 11, inclusive. Employer first-publication evidence takes precedence over aggregator listing dates. Undated discoveries and missing eligibility details stay under Needs verification. This is a dated snapshot, not a rolling feed.",
            "Ranking favors demonstrated backend, distributed-systems, data-infrastructure and full-stack work, realistic undergraduate eligibility, fewer mandatory skill gaps, and upcoming deadlines or terms. Fit scores are judgments, not offer probabilities; selective companies remain when the role fits. Preferences are distinguished from hard requirements.",
            "Removed closed links, expired deadlines, graduate-only programs, incompatible graduation/start dates, mandatory experience absent from the resume, unrelated specialties and school-specific enrollment. Graduation extensions and genuine uncertainties are explicit conditions. Long extensions are identified before you spend application time.",
            "You corrected CS-major GPA to 3.74 and reported cumulative GPA around 3.4. GPA-restricted roles are retained at your request; required thresholds above 3.4 are conditional and filterable. Preferred GPAs are separate. Use the exact transcript value when applying; GPA extraction is backed by review notes and employer evidence.",
            "Public employer pages were checked and missing structured descriptions recovered where possible. Some JavaScript or bot-protected links remain unverified even when OneShot holds a full active employer record; that limitation is displayed. Exact requisitions are collapsed across sources, with all posting IDs retained for tracker matching.",
            "Add to Applied uses OneShot's existing account tracker, or its browser-local guest workspace while signed out. Applied aliases are hidden by default and can be shown. Undo removes only a newly created record. No applications were added during research or testing.",
        ], "jobs": rows,
    }
    destination = ROOT / "web/recommendations/data.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    (BUILD / "recommendations-final-audit.json").write_text(json.dumps({"counts": dict(counts), "decisions": list(by_id.values())}, indent=2))
    print(json.dumps(data["metrics"], indent=2))
    for row in rows[:20]:
        print(row["rank"], row["company"], row["title"], "|", row["term"])


if __name__ == "__main__":
    main()
