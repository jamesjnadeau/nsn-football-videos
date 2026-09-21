#!/usr/bin/env python3
"""Checks for the title parsing in fetch_games.py.

Run with: python3 scripts/test_parse.py

The home/away cases are anchored to schedules verified against MaxPreps, since
NSN's API carries no home/away field -- the only signal is the order of the two
names in the title, and getting it backwards is silent and invisible.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_games import parse_title, season_for, slugify  # noqa: E402

from datetime import datetime, timezone  # noqa: E402

# (title, away, home, round, part)
CASES = [
    # NSN names the visitor first. Confirmed against MaxPreps: Mt. Abraham
    # hosted BFA/Lamoille, Spaulding travelled to Missisquoi, Hartford
    # travelled to Burr & Burton -- all on 2026-09-19.
    ("Fairfax/Lamoille vs. Mt. Abraham", "Fairfax/Lamoille", "Mt. Abraham/Vergennes", "", None),
    ("Spaulding vs. Missisquoi", "Spaulding", "Missisquoi", "", None),
    ("Hartford vs. Burr & Burton", "Hartford", "Burr & Burton", "", None),

    # Seeds are stripped; the better seed hosts, which is why it is named last.
    ("#3 Colchester vs #2 Lyndon - VPA DIV II Semifinal",
     "Colchester", "Lyndon Institute", "VPA DIV II Semifinal", None),
    ("#8 BFA-St. Albans vs #1 Middlebury - VPA DIV I Wild Card Round",
     "BFA-St. Albans", "Middlebury", "VPA DIV I Wild Card Round", None),

    # "@" and "at" already put the visitor first, so they need no special case.
    ("Milton @ Woodstock", "Milton", "Woodstock", "", None),

    # A trailing digit is a second recording of one game, not a school.
    ("St. Johnsbury vs Colchester 2", "St. Johnsbury", "Colchester", "", 2),

    # Leading section tag.
    ("FB - St. Johnsbury vs Lyndon Institute",
     "St. Johnsbury", "Lyndon Institute", "", None),

    # Alias folding.
    ("Rice vs U32", "Rice Memorial", "U-32", "", None),

    # All-star games name states, not schools -- no split expected.
    ("2026 Shrine Maple Sugar Bowl", None, None, "", None),
]


def main():
    failures = []

    for title, want_away, want_home, want_round, want_part in CASES:
        away, home, rnd, part = parse_title(title)
        got, want = (away, home, rnd, part), (want_away, want_home, want_round, want_part)
        if got != want:
            failures.append(f"parse_title({title!r})\n     got  {got}\n     want {want}")

    # A September game belongs to that calendar year's season.
    if season_for(datetime(2026, 9, 19, tzinfo=timezone.utc)) != 2026:
        failures.append("season_for: September 2026 should be the 2026 season")
    # January belongs to the season that started the previous autumn.
    if season_for(datetime(2026, 1, 5, tzinfo=timezone.utc)) != 2025:
        failures.append("season_for: January 2026 should be the 2025 season")

    if slugify("Mt. Abraham/Vergennes") != "mt-abraham-vergennes":
        failures.append("slugify: unexpected slug for Mt. Abraham/Vergennes")

    for f in failures:
        print("FAIL " + f)
    print(f"\n{len(CASES) + 3 - len(failures)} passed, {len(failures)} failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
