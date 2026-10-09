"""Build data/players.json: every NBA All-Star with career averages and accolades.

Candidates come from Wikipedia's "List of NBA All-Stars"; bio, stats and awards
come from stats.nba.com via nba_api. Responses are cached in scripts/.cache so
the run can be interrupted and resumed. Run from a residential connection:
stats.nba.com tends to block cloud/datacenter IPs.

Usage:
    python scripts/fetch_players.py [--limit N] [--refresh] [--delay SECONDS]
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import time
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import requests
from nba_api.stats.endpoints import commonplayerinfo, playerawards, playercareerstats
from nba_api.stats.static import players as static_players

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = Path(__file__).resolve().parent / ".cache"
OUTPUT = ROOT / "data" / "players.json"
WIKI_URL = "https://en.wikipedia.org/wiki/List_of_NBA_All-Stars"
USER_AGENT = "nba-ranker/0.1 (https://github.com/zateutsch/nba-ranker)"
HEADSHOT_URL = "https://cdn.nba.com/headshots/nba/latest/1040x760/{id}.png"

# Wikipedia name -> NBA.com player ID, for names that don't match automatically.
MANUAL_IDS: dict[str, int] = {
    "Jo Jo White": 78510,
    "Jimmy Butler": 202710,
    "Penny Hardaway": 358,
    "Dwight Eddleman": 76636,
    "Fat Lever": 77376,
    "Fred Scolari": 78094,
    "B. J. Armstrong": 769,
    "Nathaniel Clifton": 76404,
    "World B. Free": 76753,
    "Steve Smith": 120,
}

# Awards missing from NBA.com's PlayerAwards data, keyed by NBA.com player ID.
# Merged in before summarizing; skipped if NBA.com later adds the same entry.
AWARD_CORRECTIONS: dict[int, list[dict]] = {
    2572: [{"DESCRIPTION": "NBA All-Star", "SEASON": "2006-07"}],   # Josh Howard, 2007 ASG
    77134: [{"DESCRIPTION": "NBA All-Star", "SEASON": "1987-88"}],  # Steve Johnson, 1988 ASG
}

STAT_FIELDS = [
    "GP", "GS", "MIN", "PTS", "REB", "AST", "STL", "BLK", "TOV",
    "FG_PCT", "FG3_PCT", "FT_PCT", "FGM", "FGA", "FG3M", "FG3A", "FTM", "FTA",
    "OREB", "DREB", "PF",
]

# NBA.com award DESCRIPTION -> accolade key. Weekly/monthly awards are ignored.
AWARD_KEYS = {
    "NBA All-Star": "allStar",
    "NBA Champion": "championships",
    "NBA Most Valuable Player": "mvp",
    "NBA Finals Most Valuable Player": "finalsMvp",
    "NBA Defensive Player of the Year": "dpoy",
    "NBA Rookie of the Year": "roy",
    "NBA Sixth Man of the Year": "sixthMan",
    "NBA Most Improved Player": "mip",
    "NBA Clutch Player of the Year": "clutchPoy",
    "NBA All-Star Most Valuable Player": "allStarMvp",
    "All-NBA": "allNba",
    "All-Defensive Team": "allDefensive",
    "All-Rookie Team": "allRookie",
    "NBA Cup Most Valuable Player": "nbaCupMvp",
    "Olympic Gold Medal": "olympicGold",
    "Eastern Conference Finals Most Valuable Player": "conferenceFinalsMvp",
    "Western Conference Finals Most Valuable Player": "conferenceFinalsMvp",
    "Hall of Fame Inductee": "hallOfFame",
}


def normalize(name: str) -> str:
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    name = re.sub(r"[^a-z0-9 ]", "", name.lower().replace("-", " "))
    return re.sub(r"\s+", " ", name).strip()


def clean_wiki_name(raw: str) -> str:
    name = re.sub(r"\[.*?\]", "", str(raw))  # footnotes like [a]
    return re.sub(r"[*^†‡§#+~]", "", name).strip()


def fetch_all_star_names() -> list[str]:
    resp = requests.get(WIKI_URL, headers={"User-Agent": USER_AGENT}, timeout=30)
    resp.raise_for_status()
    tables = pd.read_html(io.StringIO(resp.text))
    table = next(t for t in tables if "Player" in t.columns and len(t) > 100)
    names = [clean_wiki_name(n) for n in table["Player"].dropna()]
    return list(dict.fromkeys(n for n in names if n))


def cached_call(key: str, fetch, refresh: bool, delay: float, retries: int = 4):
    path = CACHE_DIR / f"{key}.json"
    if path.exists() and not refresh:
        return json.loads(path.read_text(encoding="utf-8"))
    for attempt in range(retries):
        try:
            data = fetch()
            break
        except Exception as exc:  # network errors, timeouts, throttling
            if attempt == retries - 1:
                raise
            wait = delay * 2 ** (attempt + 2)
            print(f"    retry {key} in {wait:.0f}s ({exc.__class__.__name__})")
            time.sleep(wait)
    path.write_text(json.dumps(data), encoding="utf-8")
    time.sleep(delay)
    return data


def get_awards(pid: int, refresh: bool, delay: float) -> list[dict]:
    return cached_call(
        f"awards_{pid}",
        lambda: playerawards.PlayerAwards(player_id=pid, timeout=30)
        .get_normalized_dict()["PlayerAwards"],
        refresh, delay,
    )


def get_career(pid: int, refresh: bool, delay: float) -> dict:
    return cached_call(
        f"career_{pid}",
        lambda: playercareerstats.PlayerCareerStats(
            player_id=pid, per_mode36="PerGame", timeout=30
        ).get_normalized_dict(),
        refresh, delay,
    )


def get_info(pid: int, refresh: bool, delay: float) -> dict:
    return cached_call(
        f"info_{pid}",
        lambda: commonplayerinfo.CommonPlayerInfo(player_id=pid, timeout=30)
        .get_normalized_dict()["CommonPlayerInfo"][0],
        refresh, delay,
    )


def resolve_ids(names: list[str], refresh: bool, delay: float) -> tuple[dict[str, int], list[str]]:
    by_name: dict[str, list[dict]] = {}
    for p in static_players.get_players():
        by_name.setdefault(normalize(p["full_name"]), []).append(p)

    resolved, unmatched = {}, []
    for name in names:
        if name in MANUAL_IDS:
            resolved[name] = MANUAL_IDS[name]
            continue
        matches = by_name.get(normalize(name), [])
        if len(matches) == 1:
            resolved[name] = matches[0]["id"]
        elif len(matches) > 1:
            # Same-name players: pick the one with an All-Star selection.
            stars = [
                m["id"] for m in matches
                if any(a["DESCRIPTION"] == "NBA All-Star" for a in get_awards(m["id"], refresh, delay))
            ]
            if len(stars) == 1:
                resolved[name] = stars[0]
            else:
                unmatched.append(f"{name} (ambiguous: {[m['id'] for m in matches]})")
        else:
            unmatched.append(name)
    return resolved, unmatched


def pick_stats(rows: list[dict]) -> dict | None:
    if not rows:
        return None
    row = rows[0]
    return {k.lower(): row.get(k) for k in STAT_FIELDS}


def summarize_awards(awards: list[dict]) -> dict:
    counts: Counter[str] = Counter()
    seasons: dict[str, list[str]] = {}
    all_nba_teams: Counter[str] = Counter()
    all_def_teams: Counter[str] = Counter()
    for a in awards:
        key = AWARD_KEYS.get(a["DESCRIPTION"])
        if not key:
            continue
        counts[key] += 1
        seasons.setdefault(key, []).append(a["SEASON"])
        team_no = str(a.get("ALL_NBA_TEAM_NUMBER") or "").strip()
        if key in ("allNba", "allDefensive") and team_no:
            (all_nba_teams if key == "allNba" else all_def_teams)[team_no] += 1
            seasons.setdefault(f"{key}{team_no}", []).append(a["SEASON"])  # e.g. allNba1
    summary = {key: counts.get(key, 0) for key in AWARD_KEYS.values()}
    summary["allNbaByTeam"] = {t: all_nba_teams.get(t, 0) for t in ("1", "2", "3")}
    summary["allDefensiveByTeam"] = {t: all_def_teams.get(t, 0) for t in ("1", "2")}
    summary["seasons"] = {k: sorted(v) for k, v in seasons.items()}
    return summary


def build_player(pid: int, refresh: bool, delay: float) -> dict:
    info = get_info(pid, refresh, delay)
    career = get_career(pid, refresh, delay)
    awards = get_awards(pid, refresh, delay)
    seen = {(a["DESCRIPTION"], a["SEASON"]) for a in awards}
    awards = awards + [
        a for a in AWARD_CORRECTIONS.get(pid, []) if (a["DESCRIPTION"], a["SEASON"]) not in seen
    ]
    draft_year = info.get("DRAFT_YEAR")
    return {
        "id": pid,
        "name": info["DISPLAY_FIRST_LAST"],
        "slug": info.get("PLAYER_SLUG"),
        "position": info.get("POSITION") or None,
        "height": info.get("HEIGHT") or None,
        "weight": info.get("WEIGHT") or None,
        "country": info.get("COUNTRY") or None,
        "birthdate": (info.get("BIRTHDATE") or "")[:10] or None,
        "fromYear": info.get("FROM_YEAR"),
        "toYear": info.get("TO_YEAR"),
        "active": info.get("ROSTERSTATUS") == "Active",
        "lastTeam": " ".join(filter(None, [info.get("TEAM_CITY"), info.get("TEAM_NAME")])) or None,
        "draft": None if draft_year in (None, "", "Undrafted") else {
            "year": draft_year,
            "round": info.get("DRAFT_ROUND"),
            "pick": info.get("DRAFT_NUMBER"),
        },
        "greatest75": info.get("GREATEST_75_FLAG") == "Y",
        "headshot": HEADSHOT_URL.format(id=pid),
        "careerRegularSeason": pick_stats(career.get("CareerTotalsRegularSeason", [])),
        "careerPlayoffs": pick_stats(career.get("CareerTotalsPostSeason", [])),
        "accolades": summarize_awards(awards),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, help="only process the first N All-Stars (for testing)")
    parser.add_argument("--refresh", action="store_true", help="ignore cached responses")
    parser.add_argument("--delay", type=float, default=0.6, help="seconds between stats.nba.com calls")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")  # player names include non-ASCII characters

    CACHE_DIR.mkdir(exist_ok=True)
    OUTPUT.parent.mkdir(exist_ok=True)

    print("Fetching All-Star list from Wikipedia...")
    names = fetch_all_star_names()
    if args.limit:
        names = names[: args.limit]
    print(f"  {len(names)} All-Stars")

    ids, unmatched = resolve_ids(names, args.refresh, args.delay)
    print(f"  matched {len(ids)} to NBA.com IDs, {len(unmatched)} unmatched")

    output, failed = [], []
    for i, (name, pid) in enumerate(ids.items(), 1):
        print(f"[{i}/{len(ids)}] {name}")
        try:
            player = build_player(pid, args.refresh, args.delay)
        except Exception as exc:
            print(f"    FAILED: {exc}")
            failed.append(name)
            continue
        if player["accolades"]["allStar"] == 0:
            print("    note: NBA.com lists no All-Star selection for this player")
        output.append(player)

    output.sort(key=lambda p: p["name"])
    OUTPUT.write_text(
        json.dumps(
            {
                "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "sources": {
                    "players": WIKI_URL,
                    "stats": "stats.nba.com (via nba_api)",
                },
                "count": len(output),
                "players": output,
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    print(f"\nWrote {len(output)} players to {OUTPUT.relative_to(ROOT)}")
    if unmatched:
        print("Unmatched (add to MANUAL_IDS):\n  " + "\n  ".join(unmatched))
    if failed:
        print("Failed (re-run to retry):\n  " + "\n  ".join(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
