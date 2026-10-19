"""Fetch and normalize NBA regular-season schedules for the static site."""

from __future__ import annotations

import json
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "schedules.json"
SOURCE_ROOT = "https://fixturedownload.com/feed/json"

SEASONS = (
    ("2026-27", "2026–27", "nba-2026", True),
    ("2025-26", "2025–26", "nba-2025", False),
)

TEAMS = {
    "Atlanta Hawks",
    "Boston Celtics",
    "Brooklyn Nets",
    "Charlotte Hornets",
    "Chicago Bulls",
    "Cleveland Cavaliers",
    "Dallas Mavericks",
    "Denver Nuggets",
    "Detroit Pistons",
    "Golden State Warriors",
    "Houston Rockets",
    "Indiana Pacers",
    "LA Clippers",
    "Los Angeles Lakers",
    "Memphis Grizzlies",
    "Miami Heat",
    "Milwaukee Bucks",
    "Minnesota Timberwolves",
    "New Orleans Pelicans",
    "New York Knicks",
    "Oklahoma City Thunder",
    "Orlando Magic",
    "Philadelphia 76ers",
    "Phoenix Suns",
    "Portland Trail Blazers",
    "Sacramento Kings",
    "San Antonio Spurs",
    "Toronto Raptors",
    "Utah Jazz",
    "Washington Wizards",
}


def fetch_json(url: str) -> list[dict]:
    request = Request(url, headers={"User-Agent": "nba-ranker schedule updater"})
    error = None
    for attempt in range(3):
        try:
            with urlopen(request, timeout=120) as response:
                return json.load(response)
        except (OSError, TimeoutError) as exc:
            error = exc
            if attempt < 2:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"Could not fetch {url}") from error


def normalize_season(
    season_id: str, label: str, feed: str, prediction_available: bool
) -> dict:
    source_url = f"{SOURCE_ROOT}/{feed}"
    raw_games = fetch_json(source_url)
    games = []

    for raw in raw_games:
        home = raw["HomeTeam"]
        away = raw["AwayTeam"]

        # Before NBA Cup knockout teams are known, the feed contains TBA slots.
        if home not in TEAMS or away not in TEAMS:
            continue

        winner = raw.get("Winner")
        home_score = raw.get("HomeTeamScore")
        away_score = raw.get("AwayTeamScore")
        is_final = (
            winner in {home, away}
            and isinstance(home_score, int)
            and not isinstance(home_score, bool)
            and home_score >= 0
            and isinstance(away_score, int)
            and not isinstance(away_score, bool)
            and away_score >= 0
        )

        games.append(
            {
                "id": f"{season_id}:{raw['MatchNumber']}",
                "dateUtc": raw["DateUtc"].replace(" ", "T"),
                "venue": raw.get("Location") or "",
                "homeTeam": home,
                "awayTeam": away,
                "homeScore": home_score if is_final else None,
                "awayScore": away_score if is_final else None,
            }
        )

    counts = Counter()
    for game in games:
        counts[game["homeTeam"]] += 1
        counts[game["awayTeam"]] += 1

    # Cup semifinal games in Las Vegas count in the standings; the final does
    # not. Finalists are the only teams with 83 games, so remove their latest
    # head-to-head game at T-Mobile Arena.
    over_limit = {team for team, count in counts.items() if count > 82}
    cup_finals = [
        game
        for game in games
        if game["venue"] == "T-Mobile Arena"
        and game["homeTeam"] in over_limit
        and game["awayTeam"] in over_limit
    ]
    if cup_finals:
        games.remove(max(cup_finals, key=lambda game: game["dateUtc"]))
        counts = Counter()
        for game in games:
            counts[game["homeTeam"]] += 1
            counts[game["awayTeam"]] += 1

    games.sort(key=lambda game: (game["dateUtc"], game["id"]))
    known_counts = sorted(set(counts.values()))
    complete = len(counts) == len(TEAMS) and known_counts == [82]

    return {
        "id": season_id,
        "label": label,
        "predictionAvailable": prediction_available,
        "complete": complete,
        "expectedGamesPerTeam": 82,
        "knownGamesPerTeam": min(counts.values()) if counts else 0,
        "teamGameCounts": dict(sorted(counts.items())),
        "source": source_url,
        "games": games,
    }


def main() -> None:
    attribution = {
        "name": "Fixture Download",
        "url": "https://fixturedownload.com/",
    }
    seasons = [normalize_season(*season) for season in SEASONS]

    if OUTPUT.exists():
        try:
            existing = json.loads(OUTPUT.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            existing = None
        if (
            existing
            and existing.get("attribution") == attribution
            and existing.get("seasons") == seasons
        ):
            print(f"No schedule changes in {OUTPUT.relative_to(ROOT)}")
            return

    data = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "attribution": attribution,
        "seasons": seasons,
    }
    OUTPUT.write_text(json.dumps(data, separators=(",", ":")) + "\n", encoding="utf-8")

    for season in data["seasons"]:
        state = "complete" if season["complete"] else "partial"
        print(
            f"{season['label']}: {len(season['games'])} games, "
            f"{season['knownGamesPerTeam']} per team ({state})"
        )
    print(f"Wrote {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
