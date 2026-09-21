#!/usr/bin/env python3
"""Fetch NSN Vermont football broadcasts and build the static site's data file.

NSN (nsnsports.net) is a WordPress site whose broadcast lists are rendered
client-side from `ajax.php?action=nsn_schedule`, scoped to a site slug
(`nsnvermont` is the Vermont high school hub). This script walks every page of
that endpoint, keeps the football broadcasts, parses the two schools out of
each title, and writes docs/data/games.json for the static site to read.

    python3 scripts/fetch_games.py                 # fetch from NSN and rebuild
    python3 scripts/fetch_games.py --from-cache    # rebuild from the saved raw copy

The raw API response is cached to data/raw_broadcasts.json so the parsing rules
below can be reworked without hammering someone else's server.
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ENDPOINT = "https://www.nsnsports.net/ajax.php"
SITE_SLUG = "nsnvermont"
PER_PAGE = 50            # the endpoint silently caps page size at 50
MAX_PAGES = 400          # stop runaway paging if last_page never arrives
USER_AGENT = "nsn-football-videos/1.0 (+https://github.com/jamesjnadeau/nsn-football-videos)"

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = REPO_ROOT / "docs" / "data" / "games.json"
CACHE_PATH = REPO_ROOT / "data" / "raw_broadcasts.json"

# Broadcasts that live in the football section but aren't games.
NOT_A_GAME = re.compile(r"inside the game with eric berry|\bpodcast\b|\bpress conference\b", re.I)

# NSN writes "Away vs. Home" -- the visiting team is named first.
#
# Verified two ways. Three Sept 2026 games check out against MaxPreps schedules
# (Mt. Abraham hosted BFA/Lamoille, Spaulding travelled to Missisquoi, Hartford
# travelled to Burr & Burton). And across every seeded playoff title in the
# archive -- 192 of them, all sports, 2018-2026 -- the worse seed is listed
# first without a single exception, which only holds if the first team is the
# visitor, since VPA seeding gives the better seed the home field.
#
# Separators longest/most specific first so " vs. " wins over " v. ". "A @ B"
# and "A at B" already mean the same thing, so they need no special case.
SEPARATOR = re.compile(r"\s+(?:vs\.?|v\.?|@|at)\s+", re.I)

# A trailing " - VPA DIV II Semifinal" style tag describes the game, not the school.
ROUND_SUFFIX = re.compile(
    r"\s*[-–—]\s*("
    r"(?:vpa|vhsl)\b.*"                                    # "VPA Division II Football Semifinals"
    r"|(?:d-?\s*[1-4iv]+|div(?:ision)?\.?\s*[1-4iv]+)\b.*"  # "DIV II Quarterfinal"
    r"|(?:state|regional|youth football|wild ?card|semi|quarter|shrine)\b.*"
    r"|(?:semi-?|quarter-?)?finals?"
    r"|championship.*|playoffs?.*"
    r")$",
    re.I,
)

# "FB - St. Johnsbury vs Lyndon Institute" — a section tag on the front.
LEADING_TAG = re.compile(r"^\s*(?:fb|football|hs)\s*[-–—:]\s*", re.I)

# A tournament seed: "#3 Colchester", "(4) Rutland".
SEED_PREFIX = re.compile(r"^[(\[#]?\s*#?\s*(\d{1,2})\s*[)\]#]?\s+(?=\D)")

# A trailing " 2" / " 3" marks the second or third recording of one game,
# not a different school.
PART_SUFFIX = re.compile(r"\s+([2-9])\s*$")

# Punctuation/abbreviation variants of the same program. Keys are compared
# after casefolding and collapsing punctuation, so only real aliases go here.
SCHOOL_ALIASES = {
    "lyndon": "Lyndon Institute",
    "li": "Lyndon Institute",
    "rice": "Rice Memorial",
    "bfa st albans": "BFA-St. Albans",
    "bfa fairfax": "BFA-Fairfax",
    "st johnsbury academy": "St. Johnsbury",
    "stj": "St. Johnsbury",
    "mt abraham vergennes": "Mt. Abraham/Vergennes",
    "mt abraham": "Mt. Abraham/Vergennes",
    "mount anthony": "Mt. Anthony",
    "mount mansfield": "Mt. Mansfield",
    "champlain valley": "CVU",
    "u 32": "U-32",
    "u32": "U-32",
    "fairfax": "BFA-Fairfax",
    "burr and burton": "Burr & Burton",
    "burr burton": "Burr & Burton",
    "vermont seawolves": "Seawolves",
}


def fetch_page(list_name, page, retries=4):
    url = (
        f"{ENDPOINT}?action=nsn_schedule&list={list_name}"
        f"&per_page={PER_PAGE}&page={page}&keep_list=1&sites={SITE_SLUG}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    delay = 2
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError) as exc:
            if attempt == retries - 1:
                raise SystemExit(f"failed {list_name} page {page}: {exc}")
            print(f"  retry {list_name} p{page} after {exc}", file=sys.stderr)
            time.sleep(delay)
            delay *= 2
    return {}


def fetch_list(list_name):
    """Page through one list until the endpoint says we're done."""
    out, seen = [], set()
    for page in range(1, MAX_PAGES + 1):
        data = fetch_page(list_name, page)
        broadcasts = data.get("broadcasts") or []
        if not broadcasts:
            break
        fresh = [b for b in broadcasts if b.get("id") not in seen]
        seen.update(b.get("id") for b in broadcasts)
        out.extend(fresh)
        print(f"  {list_name} page {page}: {len(broadcasts)} ({len(out)} total)", file=sys.stderr)
        if data.get("last_page") or not fresh:
            break
        time.sleep(0.3)   # be a polite guest on someone else's server
    return out


def fetch_all():
    raw = []
    for list_name, hint in (("upcoming_or_streaming", "Upcoming"), ("archived", "Archived")):
        print(f"fetching {list_name}...", file=sys.stderr)
        for item in fetch_list(list_name):
            item["_list_hint"] = hint
            raw.append(item)
    return raw


def canonical(name):
    """Map punctuation/abbreviation variants onto one name per program."""
    key = re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()
    return SCHOOL_ALIASES.get(key, name)


def clean_school(name):
    name = SEED_PREFIX.sub("", name.strip())
    name = re.sub(r"\s+", " ", name).strip(" -–—,.")
    # Re-attach the period on "St"/"Mt" that the strip above may have eaten.
    name = re.sub(r"\b(St|Mt)$", r"\1.", name)
    return canonical(name) if name else ""


def parse_title(title):
    """Pull the schools, playoff round and recording part out of a title."""
    text = LEADING_TAG.sub("", title.strip())

    round_name = ""
    m = ROUND_SUFFIX.search(text)
    if m:
        round_name = re.sub(r"\s+", " ", m.group(1)).strip()
        text = text[: m.start()]

    part = None
    m = PART_SUFFIX.search(text)
    if m:
        part = int(m.group(1))
        text = text[: m.start()]

    away = home = None
    parts = SEPARATOR.split(text, maxsplit=1)
    if len(parts) == 2:
        first, second = clean_school(parts[0]), clean_school(parts[1])
        if first and second:
            away, home = first, second

    return away, home, round_name, part


def slugify(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def season_for(dt):
    """High school football runs Aug-Nov, so the calendar year is the season."""
    return dt.year if dt.month >= 3 else dt.year - 1


def normalize(raw):
    """Turn one API broadcast into the compact record the site consumes."""
    title = (raw.get("title") or "").strip()
    if not title or NOT_A_GAME.search(title):
        return None

    try:
        dt = datetime.fromtimestamp(int(raw.get("date")) / 1000, tz=timezone.utc)
    except (TypeError, ValueError):
        return None

    away, home, round_name, part = parse_title(title)
    teams = [t for t in (away, home) if t]   # kept in the title's own order

    rec = {
        "id": str(raw.get("id")),
        "title": title,
        "date": dt.isoformat().replace("+00:00", "Z"),
        "season": season_for(dt),
        "sport": raw.get("section_title") or "",
        "status": raw.get("status") or raw.get("_list_hint") or "",
        "home": home,
        "away": away,
        "teams": teams,
        "teamSlugs": [slugify(t) for t in teams],
        "round": round_name,
        # Bounds the play markers the site collects; costs one VMAP request per
        # broadcast, so it is fetched separately by add_durations().
        "durationSec": None,
        "embedUrl": raw.get("embed_code_src") or "",
        "thumbnail": raw.get("medium_image") or raw.get("small_image") or raw.get("large_image") or "",
        # Some broadcasts also carry a "download_url" that serves the video file
        # directly. It is deliberately not captured: it bypasses NSN's player and
        # with it the pre-roll/mid-roll ads and the view tracking that pay for
        # this coverage. Link to the player, never around it.
        #
        # page_link often points at whichever sponsor page carried the stream;
        # the Vermont hub plays any broadcast id, so it is the stabler link.
        "nsnUrl": f"https://www.nsnsports.net/high-schools/vermont/?bfplayvid={raw.get('id')}",
        "pageUrl": raw.get("page_link") or "",
        "requiresLogin": (raw.get("require_login") or "no").lower() != "no",
        "source": raw.get("site_title") or raw.get("site") or "",
    }
    if part:
        rec["part"] = part
    return rec


def build(raw_items, all_sports=False):
    records, seen = [], set()
    for raw in raw_items:
        rec = normalize(raw)
        if rec is None or rec["id"] in seen:
            continue
        if not all_sports and "football" not in rec["sport"].lower():
            continue
        seen.add(rec["id"])
        records.append(rec)
    records.sort(key=lambda r: (r["date"], r.get("part", 0)), reverse=True)
    return records


VMAP_URL = "https://vcloud.hudl.com/api/broadcast/vmap/{}?minify_js=1"


def add_durations(records, workers=8):
    """Fill in each broadcast's run time from its VMAP.

    One request per broadcast, so it runs only over records that do not already
    have a duration -- a refresh then costs a handful of calls, not 259.
    """
    import concurrent.futures as cf

    todo = [r for r in records if not r.get("durationSec")]
    if not todo:
        return
    print(f"fetching durations for {len(todo)} broadcast(s)...", file=sys.stderr)

    def one(rec):
        try:
            req = urllib.request.Request(VMAP_URL.format(rec["id"]),
                                         headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=25) as resp:
                xml = resp.read().decode("utf-8", "replace")
            m = re.search(r'<Content[^>]*duration="([^"]+)"', xml)
            if not m:
                return
            h, mi, sec = (m.group(1).split(":") + ["0", "0"])[:3]
            rec["durationSec"] = round(int(h) * 3600 + int(mi) * 60 + float(sec))
        except Exception as exc:                      # a missing duration is not fatal
            print(f"  duration failed for {rec['id']}: {exc}", file=sys.stderr)

    with cf.ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(one, todo))

    got = sum(1 for r in records if r.get("durationSec"))
    print(f"  durations known for {got}/{len(records)}", file=sys.stderr)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=OUT_PATH)
    ap.add_argument("--cache", type=Path, default=CACHE_PATH)
    ap.add_argument("--from-cache", action="store_true",
                    help="rebuild from the cached raw response instead of fetching")
    ap.add_argument("--all-sports", action="store_true",
                    help="keep every sport, not just football")
    ap.add_argument("--skip-durations", action="store_true",
                    help="do not fetch run times (one extra request per new broadcast)")
    args = ap.parse_args()

    if args.from_cache:
        if not args.cache.exists():
            raise SystemExit(f"no cache at {args.cache}; run without --from-cache first")
        raw_items = json.loads(args.cache.read_text(encoding="utf-8"))
    else:
        raw_items = fetch_all()
        args.cache.parent.mkdir(parents=True, exist_ok=True)
        args.cache.write_text(json.dumps(raw_items, indent=1) + "\n", encoding="utf-8")

    records = build(raw_items, all_sports=args.all_sports)

    # Carry forward durations already fetched, so a refresh only asks about new games.
    if args.out.exists():
        try:
            known = {g["id"]: g.get("durationSec")
                     for g in json.loads(args.out.read_text(encoding="utf-8")).get("games", [])}
            for r in records:
                if not r.get("durationSec") and known.get(r["id"]):
                    r["durationSec"] = known[r["id"]]
        except (json.JSONDecodeError, KeyError):
            pass

    if not args.skip_durations:
        add_durations(records)

    payload = {
        "generated": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": "https://www.nsnsports.net/high-schools/vermont/",
        "count": len(records),
        "games": records,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=1) + "\n", encoding="utf-8")

    unmatched = [r["title"] for r in records if len(r["teams"]) != 2]
    print(f"\nwrote {len(records)} games to {args.out}", file=sys.stderr)
    print(f"{len(unmatched)} title(s) did not split into two schools", file=sys.stderr)
    for t in unmatched:
        print(f"   {t}", file=sys.stderr)


if __name__ == "__main__":
    main()
