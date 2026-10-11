"""Assemble the dated, reviewed queue from local research artifacts.

Raw employer text and personal resume contacts stay in ignored build/ files.
The browser receives concise paraphrases, posting IDs, public URLs and source
provenance. Every candidate needs an explicit review decision; unknown opening
dates never enter the confirmed 20-day recommendation queue.
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
PACIFIC = ZoneInfo("America/Los_Angeles")
START, END = date(2026,9,22), date(2026,10,11)
COMPANY_NAMES = {
    "globalhr":"RTX", "biibhr":"Biogen", "bostonscientific":"Boston Scientific",
    "cmu":"Carnegie Mellon University", "gartner":"Gartner", "generac":"Generac",
    "gmppu":"GM Performance Power Units", "greenheckgroup":"Greenheck Group",
    "grow-therapy":"Grow Therapy", "guidestone":"GuideStone", "hcsc":"Health Care Service Corporation",
    "hccg.fa.us2":"SI Group", "hcrb.fa.us2":"Boston Beer Company",
    "ibqbjb.fa.ocs":"Honeywell Technologies", "hermeus":"Hermeus",
    "hyvee":"Hy-Vee", "icf":"ICF", "igsenergy":"IGS Energy", "interdigital":"InterDigital",
    "ipconfigure":"IPConfigure", "irhythmtech":"iRhythm Technologies", "itron":"Itron",
    "ivytech":"Ivy Tech Community College", "jabil":"Jabil", "kitware":"Kitware",
    "leantechniques":"Lean TECHniques", "livanova":"LivaNova", "mach9":"Mach9",
    "manulife":"Manulife", "nelnet":"Nelnet", "nxp":"NXP", "osu":"The Ohio State University",
    "pacificlife":"Pacific Life", "pae":"Amentum", "pentair":"Pentair", "permianres":"Permian Resources",
    "primient":"Primient", "q2ebanking":"Q2", "radiancetech":"Radiance Technologies",
    "range":"Range", "rbc":"RBC", "relay":"Relay", "revel":"Revel",
    "revvity":"Revvity", "rhsc":"Delta Dental of Michigan, Ohio, and Indiana", "rivet":"Rivet",
    "sbdinc":"Stanley Black & Decker", "sephora":"Sephora", "solopulseco":"SoloPulse",
    "southstatebank":"SouthState Bank", "spartannash":"SpartanNash", "swirecc":"Swire Coca-Cola",
    "symbotic":"Symbotic", "synnex":"TD SYNNEX", "tcenergy":"TC Energy", "td":"TD",
    "tencent":"Tencent", "texasfarm":"Texas Farm Bureau", "ukg":"UKG", "viget":"Viget",
}


def read(name):
    return json.loads((BUILD / name).read_text())


def calendar_day(value):
    if not value:
        return None
    if len(value) == 10:
        return date.fromisoformat(value)
    stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return stamp.astimezone(PACIFIC).date() if stamp.tzinfo else stamp.date()


def identity(job):
    parsed = urlsplit(job["source_url"] or job["apply_url"] or "")
    qs = parse_qs(parsed.query)
    gh = qs.get("gh_jid")
    if gh:
        return ("greenhouse",gh[0])
    if "greenhouse.io" in parsed.netloc:
        found = re.search(r"/jobs/(\d+)",parsed.path)
        if found:
            return ("greenhouse",found[1])
    if "eightfold" in job["source"] or "/careers/job/" in parsed.path:
        found = re.search(r"/careers/job/(\d+)",parsed.path)
        if found:
            return ("eightfold",found[1])
    if "myworkdayjobs.com" in parsed.netloc:
        return (parsed.netloc.lower(),parsed.path.rsplit("_",1)[-1].lower())
    if "ashbyhq.com" in parsed.netloc or "lever.co" in parsed.netloc:
        ids = re.findall(r"[a-f0-9]{8}-[a-f0-9-]{27,}",parsed.path,re.I)
        if ids:
            return ("ats_uuid",ids[0].lower())
    return (parsed.netloc.lower(),parsed.path.rstrip("/").lower(),tuple(sorted((k,v[0]) for k,v in qs.items() if k.lower() in {"id","job","jobid","domain","opportunityid","pid"})))


def priority(row, job):
    score = {1:140,2:95,3:45}.get(row["fit"],45)
    score += {"Backend":22,"Infrastructure":20,"Data engineering":19,"Full stack":15,"General SWE":13,"Embedded":10,"ML engineering":8,"Security":6}.get(row["category"],0)
    description = html.unescape(re.sub(r"<[^>]+>"," ",job["description"] or "")).lower()
    signals = [(r"distributed|back.end|microservice|rest(ful)? api|server.side",8),(r"data pipeline|ingestion|etl|large.scale data|data infrastructure",8),(r"postgres|relational database|sql",5),(r"\bgo\b|golang",4),(r"\bpython\b",3),(r"concurrency|asynchronous|fault.toler|reliability|observability",6),(r"linux|networking|tcp|rpc",3),(r"streaming|ffmpeg|hls|video",6)]
    score += min(32,sum(points for pattern,points in signals if re.search(pattern,description)))
    age = (END - date.fromisoformat(row["posted_day"])).days if row.get("posted_day") else 20
    score += 5 if age <= 3 else 3 if age <= 7 else 1
    if re.search(r"winter|spring|jan",row["term"],re.I):
        score += 6
    return score


def main():
    candidates = read("recommendations-2026-10-11-candidates.json")
    jobs = read("recommendations-review-dedup.json")
    decisions = []
    for letter in "abc":
        decisions.extend(read(f"recommendations-decisions-{letter}.json"))
    ids = [j["id"] for j in jobs]
    assert len(decisions) == len(jobs), "Every job must receive a complete review"
    assert len({d["id"] for d in decisions}) == len(ids)
    assert set(d["id"] for d in decisions) == set(ids)
    by_id = {d["id"]:d for d in decisions}
    live = read("recommendations-live-evidence.json")
    rendered_path = BUILD / "recommendations-rendered-evidence.json"
    rendered = json.loads(rendered_path.read_text()) if rendered_path.exists() else {}
    dates = read("recommendations-date-evidence.json")
    sources = read("recommendations-linked-source-evidence.json")
    by_url = defaultdict(list)
    for source in sources:
        for url in {source["source_url"],source["apply_url"]} - {None,""}:
            by_url[url].append(source)
    assembled = []
    for job in jobs:
        decision = by_id[job["id"]]
        link = dict(live.get(str(job["id"]),{}))
        if rendered.get(str(job["id"]),{}).get("state") != "unknown":
            link.update(rendered.get(str(job["id"]),{}))
        matches = {r["id"]:r for u in {job["source_url"],job["apply_url"]} for r in by_url.get(u,[])}
        original = [r for r in matches.values() if not r["source"].startswith("simplify:") and r["posted_at"]]
        employer_date = dates.get(str(job["id"]),{}).get("date") or link.get("posted_at")
        if not employer_date and original:
            employer_date = min(r["posted_at"] for r in original)
        if not employer_date and not job["source"].startswith("simplify:"):
            employer_date = job["posted_at"]
        source_day = calendar_day(employer_date)
        basis = "employer" if source_day else "listing" if job["posted_at"] else "discovery"
        display_day = source_day or calendar_day(job["posted_at"] or job["first_seen_at"])
        view = {"include":"ready","conditional":"conditional","exclude":"excluded","needs_details":"unverified","needs_date":"unverified"}[decision["decision"]]
        reason = decision["reason"]
        conditions = list(decision.get("conditions",[]))
        if view in {"ready","conditional"} and not source_day:
            view = "unverified"
            conditions.append("Employer opening date unconfirmed; recent listing/discovery alone does not meet the 20-day requirement.")
        if source_day and not START <= source_day <= END:
            view = "excluded"
            reason = f"Employer first-publication date is {source_day.isoformat()}, outside September 22–October 11. A newer aggregator listing does not make this a new opening."
        if link.get("state") == "closed":
            view = "excluded"
            reason = "The employer posting is unavailable or reports that applications are closed; do not spend time on this listing."
        deadline = link.get("deadline") or job["attributes"].get("deadline_at")
        if deadline:
            try:
                if calendar_day(deadline) < END:
                    view = "excluded"
                    reason = f"The employer's stated application deadline ({calendar_day(deadline).isoformat()}) has passed."
            except ValueError:
                pass
        aliases = sorted(({*job.get("aliases",[]),*matches.keys()} - {job["id"]}))
        row = {"id":job["id"],"aliases":aliases,"company":COMPANY_NAMES.get(job["company"],job["company"]),"title":job["title"].strip(),"location":job["location_text"] or "Location unspecified","locations":job["locations"],"term":decision.get("term") or "Term unspecified","job_type":job["job_type"],"fit":decision["fit"],"category":decision["category"],"view":view,"reason":reason,"conditions":list(dict.fromkeys(conditions)),"evidence":decision.get("evidence", ""),"skills":job["attributes"].get("skills",[]),"summary":job["attributes"].get("summary"),"posted_day":display_day.isoformat(),"posted_at":employer_date or job["posted_at"],"first_seen_at":job["first_seen_at"],"last_seen_at":job["last_seen_at"],"date_basis":basis,"link_state":link.get("state","unknown"),"apply_url":job["source_url"] or job["apply_url"],"source":job["source"]}
        row["_key"],row["_priority"] = identity(job),priority(row,job)
        assembled.append(row)
    groups = defaultdict(list)
    for row in assembled:
        groups[row["_key"]].append(row)
    rows, duplicates = [], 0
    for group in groups.values():
        group.sort(key=lambda r:(not r["source"].startswith("simplify:"),r["link_state"] == "verified",r["view"] in {"ready","conditional"},len(r["evidence"])),reverse=True)
        chosen = group[0]
        chosen["aliases"] = sorted({a for row in group for a in [row["id"],*row["aliases"]]} - {chosen["id"]})
        duplicates += len(group)-1
        # An employer-dated sibling wins over an aggregator-only duplicate.
        dated = [r for r in group if r["date_basis"] == "employer"]
        if dated:
            earliest = min(dated,key=lambda r:r["posted_day"])
            for key in ["posted_day","posted_at","date_basis"]:
                chosen[key] = earliest[key]
            if not START <= date.fromisoformat(earliest["posted_day"]) <= END:
                chosen["view"],chosen["reason"] = "excluded",earliest["reason"]
        if any(row["link_state"] == "closed" for row in group):
            chosen["view"] = "excluded"
            chosen["reason"] = "The employer posting is unavailable or reports that applications are closed; do not spend time on this listing."
        rows.append(chosen)
    rows.sort(key=lambda r:({"ready":0,"conditional":1,"unverified":2,"excluded":3}[r["view"]],-r["_priority"],r["company"].casefold(),r["title"],r["id"]))
    ranked = 0
    for row in rows:
        if row["view"] in {"ready","conditional"}:
            ranked += 1
            row["rank"] = ranked
            assert row["date_basis"] == "employer"
            assert START <= date.fromisoformat(row["posted_day"]) <= END
        row.pop("_key");row.pop("_priority")
    counts = Counter(r["view"] for r in rows)
    data = {"reviewed_at":"2026-10-11","window":{"start":START.isoformat(),"end":END.isoformat(),"timezone":"America/Los_Angeles","days":20},"metrics":{"recent_universe":len(candidates),"title_excluded":len(candidates)-len(jobs)-sum(len(j["aliases"]) for j in jobs),"full_reviews":len(jobs),"extra_duplicates_collapsed":duplicates,**dict(counts)},"methodology":[
        "Scope: OneShot's active U.S. feed, including postings whose normalized location is unknown. Every recent posting was screened; plausible technical roles received a description and eligibility review, including roles outside the Software label.",
        "The resume reviewed was career/resume/Chris_Kim_Resume_swe.pdf, cross-checked with its HTML source. Your updated preferences replace its summer-only availability line: all internship and co-op terms through December 2027; graduation can be extended; U.S. citizenship and unrestricted work authorization; relocation allowed.",
        "The confirmed queue uses employer publication dates within September 22–October 11, inclusive. First-publication data takes precedence over aggregator listing dates. Undated discoveries, missing eligibility details, and unresolved sources appear only under Needs verification. This is a dated snapshot, not a continuously rolling filter.",
        "Ordering favors demonstrated backend, distributed-systems, data-infrastructure and full-stack work, realistic undergraduate eligibility, fewer mandatory skill gaps, and freshness or upcoming terms. These are fit judgments, not estimates of offer probability. Selective companies remain when the role fits; preferences are not treated as hard requirements.",
        "Hard exclusions include graduate-only enrollment, incompatible graduation/start dates, required prior professional experience absent from the resume, unrelated specialties, school-specific enrollment, expired deadlines, and closed links. Graduation extensions and genuine eligibility uncertainties are displayed as conditions. The resume's 3.79 is a CS-major GPA; cumulative-GPA thresholds need confirmation.",
        "Public employer pages were checked, with structured descriptions recovered where possible. JavaScript pages and bot-protected links can remain unverified even when OneShot has a complete, active employer record. HTTP failures are not treated as proof of eligibility. Exact employer requisitions are collapsed across ATS and aggregator aliases.",
        "Add to Applied uses the existing OneShot account-scoped tracker, or the existing browser-local guest workspace while signed out. Already-tracked aliases disappear by default. You can show them, and Undo only removes a newly created record. No applications were added during research or testing."
    ],"jobs":rows}
    (ROOT / "web/recommendations/data.json").write_text(json.dumps(data,ensure_ascii=False,indent=2)+"\n")
    (BUILD / "recommendations-final-audit.json").write_text(json.dumps({"counts":dict(counts),"decisions":decisions},indent=2))
    print(json.dumps(data["metrics"],indent=2))
    for row in rows[:30]:
        print(row["rank"],row["id"],row["company"],row["title"],"|",row["term"],"|",row["reason"])


if __name__ == "__main__":
    main()
