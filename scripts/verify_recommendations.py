"""Read official job pages, recover structured descriptions, and cache evidence.

Uses public GETs only. HTTP failures and JavaScript shells stay unknown; they
are never represented as employer-confirmed closures.
"""
import asyncio
import html
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

import httpx

BUILD = Path(__file__).resolve().parents[1] / "build"


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.structured, self.scripts = [], [], []
        self.hidden = 0
        self.ld = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in {"script", "style", "noscript"}:
            self.hidden += 1
        if tag == "script" and "ld+json" in attrs.get("type", ""):
            self.ld = True
            self.scripts = []
        if tag in {"p", "li", "h1", "h2", "h3", "br", "div"}:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag == "script" and self.ld:
            try:
                self.structured.append(json.loads("".join(self.scripts)))
            except (ValueError, TypeError):
                pass
            self.ld = False
        if tag in {"script", "style", "noscript"}:
            self.hidden = max(0, self.hidden - 1)

    def handle_data(self, data):
        if self.ld:
            self.scripts.append(data)
        elif not self.hidden:
            self.parts.append(data)


def plain(raw):
    p = Page()
    p.feed(raw or "")
    return "\n".join(s.strip() for s in "".join(p.parts).splitlines() if s.strip())


def posting(node):
    if isinstance(node, dict):
        if "JobPosting" in str(node.get("@type", "")):
            return node
        for value in node.values():
            found = posting(value)
            if found:
                return found
    elif isinstance(node, list):
        for value in node:
            found = posting(value)
            if found:
                return found


async def main():
    jobs = json.loads((BUILD / "recommendations-review-dedup.json").read_text())
    extra_path = BUILD / "recommendations-extra-audit-broad-a.json"
    if extra_path.exists():
        jobs.extend(json.loads(extra_path.read_text()))
    tail_path = BUILD / "recommendations-completeness-tail.json"
    if tail_path.exists():
        jobs.extend(json.loads(tail_path.read_text()))
    path = BUILD / "recommendations-live-evidence.json"
    cache = json.loads(path.read_text()) if path.exists() else {}
    sem = asyncio.Semaphore(10)
    hosts = defaultdict(lambda: asyncio.Semaphore(2))
    count = 0
    async with httpx.AsyncClient(follow_redirects=True, timeout=20, headers={"User-Agent":"Mozilla/5.0"}, limits=httpx.Limits(max_connections=12)) as client:
        async def check(job):
            nonlocal count
            key = str(job["id"])
            if key in cache:
                return
            url = job["source_url"] or job["apply_url"]
            parsed = urlsplit(url)
            evidence = {"url": url, "checked_at": datetime.now(timezone.utc).isoformat(), "state":"unknown"}
            if "myworkdayjobs.com" in parsed.netloc and "/job/" in parsed.path:
                tenant = parsed.netloc.split(".")[0]
                board = parsed.path.strip("/").split("/")[0]
                url = f"https://{parsed.netloc}/wday/cxs/{tenant}/{board}/job/" + parsed.path.split("/job/",1)[-1]
            try:
                async with sem, hosts[parsed.netloc]:
                    response = await client.get(url)
                evidence.update(status=response.status_code, final_url=str(response.url))
                if response.status_code in {404, 410}:
                    evidence["state"] = "closed"
                elif response.is_success:
                    body = response.text
                    obj = None
                    if "myworkdayjobs.com" in parsed.netloc:
                        info = response.json().get("jobPostingInfo", {})
                        obj = {"title":info.get("title"),"description":info.get("jobDescription"),"datePosted":info.get("startDate"),"validThrough":info.get("endDate")}
                        evidence["requisition"] = info.get("jobReqId")
                    else:
                        page = Page(); page.feed(body)
                        obj = posting(page.structured)
                    if obj and obj.get("description"):
                        evidence.update(state="verified",description=plain(obj["description"]),title=obj.get("title"),posted_at=obj.get("datePosted"),deadline=obj.get("validThrough"),location=obj.get("jobLocation"),employment_type=obj.get("employmentType"))
                    else:
                        clean = plain(body)
                        evidence["page_text"] = clean[:45000]
                        closed = re.search(r"this (?:job|position|opportunity) (?:is no longer (?:available|open)|has been (?:filled|closed))|job (?:you are looking for (?:does not exist|is no longer available)|has been closed)|no longer accepting applications|jobnotfound",clean,re.I)
                        if closed:
                            evidence["state"] = "closed"
                            evidence["closure_signal"] = closed.group(0)
                        elif len(clean) > 600 and job["title"].strip().casefold() in clean.casefold():
                            evidence["state"] = "page_available"
            except Exception as exc:
                evidence["error"] = type(exc).__name__
            cache[key] = evidence
            count += 1
            if count % 50 == 0:
                path.write_text(json.dumps(cache,indent=2))
                print("Checked",len(cache),"/",len(jobs),dict(Counter(x["state"] for x in cache.values())),flush=True)
        await asyncio.gather(*(check(job) for job in jobs))
    path.write_text(json.dumps(cache,indent=2))
    print("Complete",len(cache),dict(Counter(x["state"] for x in cache.values())),flush=True)


if __name__ == "__main__":
    asyncio.run(main())
