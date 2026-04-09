#!/usr/bin/env python3
"""
NCAAF Oracle v4.1 — Dataset Builder
Fetches historical game data from collegefootballdata.com and builds
the training dataset for the logistic regression meta-model.

Seasons: 2018-2024 (2020 COVID season down-weighted)
Features: 38 features matching TypeScript FEATURE_NAMES
"""

import os
import json
import requests
import numpy as np
import pandas as pd
from pathlib import Path
from typing import Optional

# ── Configuration ──────────────────────────────────────────────────────────────

CFBD_API_KEY = os.environ.get("CFBD_API_KEY", "")
CFBD_BASE = "https://api.collegefootballdata.com"
DATA_DIR = Path(__file__).parent.parent / "data"
DATASET_FILE = DATA_DIR / "training_dataset.parquet"
SEASONS = list(range(2018, 2025))  # 2018-2024

HEADERS = {"Authorization": f"Bearer {CFBD_API_KEY}", "Accept": "application/json"}

# ── API helpers ───────────────────────────────────────────────────────────────

def cfbd_get(endpoint: str, params: dict) -> list:
    """Fetch from CFBD API with retry."""
    import time
    url = f"{CFBD_BASE}{endpoint}"
    for attempt in range(3):
        try:
            r = requests.get(url, headers=HEADERS, params=params, timeout=30)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            if attempt == 2:
                print(f"  ERROR fetching {endpoint}: {e}")
                return []
            time.sleep(2 ** attempt)
    return []

# ── Data fetchers ─────────────────────────────────────────────────────────────

def fetch_games(season: int) -> list:
    return cfbd_get("/games", {"year": season, "division": "fbs", "seasonType": "regular"})

def fetch_sp_ratings(season: int) -> dict:
    data = cfbd_get("/ratings/sp", {"year": season})
    return {d["team"].lower(): d for d in data}

def fetch_epa(season: int) -> dict:
    data = cfbd_get("/ppa/teams", {"year": season, "excludeGarbageTime": "true"})
    return {d["team"].lower(): d for d in data}

def fetch_recruiting(season: int) -> dict:
    data = cfbd_get("/recruiting/teams", {"year": season})
    return {d["team"].lower(): d for d in data}

def fetch_returning(season: int) -> dict:
    data = cfbd_get("/player/returning", {"year": season})
    return {d["team"].lower(): d for d in data}

# ── Feature extraction ────────────────────────────────────────────────────────

def get_sp(sp_map: dict, team: str) -> dict:
    return sp_map.get(team.lower(), {})

def get_epa(epa_map: dict, team: str) -> dict:
    return epa_map.get(team.lower(), {})

def extract_features(game: dict, sp_map: dict, epa_map: dict,
                      recruit_map: dict, return_map: dict,
                      home_elo: float, away_elo: float) -> Optional[dict]:
    """Extract feature vector for one game."""
    # CFBD API returns camelCase keys
    home = game.get("homeTeam", game.get("home_team", "")).lower()
    away = game.get("awayTeam", game.get("away_team", "")).lower()
    home_pts = game.get("homePoints", game.get("home_points"))
    away_pts = game.get("awayPoints", game.get("away_points"))

    if home_pts is None or away_pts is None:
        return None

    home_sp = get_sp(sp_map, home)
    away_sp = get_sp(sp_map, away)
    home_epa = get_epa(epa_map, home)
    away_epa = get_epa(epa_map, away)
    home_rec = recruit_map.get(home, {})
    away_rec = recruit_map.get(away, {})
    home_ret = return_map.get(home, {})
    away_ret = return_map.get(away, {})

    def sp_val(d, *keys, default=0.0):
        v = d
        for k in keys:
            if isinstance(v, dict):
                v = v.get(k, {})
            else:
                return default
        return float(v) if v else default

    def epa_val(d, *keys, default=0.0):
        return sp_val(d, *keys, default=default)

    home_win = 1 if home_pts > away_pts else 0

    f = {
        # Team strength
        "elo_diff": home_elo - away_elo,
        "sp_plus_diff": sp_val(home_sp, "rating") - sp_val(away_sp, "rating"),
        "sp_plus_off_diff": sp_val(home_sp, "offense", "rating") - sp_val(away_sp, "offense", "rating"),
        "sp_plus_def_diff": sp_val(home_sp, "defense", "rating") - sp_val(away_sp, "defense", "rating"),
        "sp_plus_st_diff": sp_val(home_sp, "specialTeams", "rating") - sp_val(away_sp, "specialTeams", "rating"),
        "fpi_diff": 0.0,  # not available in historical CFBD
        "pythagorean_diff": (sp_val(home_sp, "rating") - sp_val(away_sp, "rating")) * 0.033,

        # EPA
        "qb_epa_diff": epa_val(home_epa, "offense", "passingPlays", "ppa") - epa_val(away_epa, "offense", "passingPlays", "ppa"),
        "pass_epa_diff": epa_val(home_epa, "offense", "passingPlays", "ppa") - epa_val(away_epa, "offense", "passingPlays", "ppa"),
        "rush_epa_diff": epa_val(home_epa, "offense", "rushingPlays", "ppa") - epa_val(away_epa, "offense", "rushingPlays", "ppa"),
        "off_epa_diff": epa_val(home_epa, "offense", "ppa") - epa_val(away_epa, "offense", "ppa"),
        "def_epa_diff": -(epa_val(home_epa, "defense", "ppa") - epa_val(away_epa, "defense", "ppa")),
        "success_rate_diff": epa_val(home_epa, "offense", "successRate") - epa_val(away_epa, "offense", "successRate"),
        "explosiveness_diff": epa_val(home_epa, "offense", "explosiveness") - epa_val(away_epa, "offense", "explosiveness"),
        "havoc_rate_diff": epa_val(home_epa, "defense", "havoc", "total") - epa_val(away_epa, "defense", "havoc", "total"),
        "finishing_drives_diff": epa_val(home_epa, "offense", "pointsPerOpportunity") - epa_val(away_epa, "offense", "pointsPerOpportunity"),
        "turnover_margin_diff": 0.0,  # approximate
        "line_yards_diff": epa_val(home_epa, "offense", "lineYards") - epa_val(away_epa, "offense", "lineYards"),

        # Recruiting / roster
        "recruiting_composite_diff": float(home_rec.get("points", 150)) - float(away_rec.get("points", 150)),
        "transfer_portal_impact_diff": 0.0,
        "returning_production_diff": float(home_ret.get("totalPercent", 0.5)) - float(away_ret.get("totalPercent", 0.5)),

        # Form / schedule
        "team_recent_epa_diff": 0.0,
        "rest_days_diff": 0.0,
        "sos_diff": sp_val(home_sp, "sos", default=0.0) - sp_val(away_sp, "sos", default=0.0),

        # Venue
        "is_neutral_site": 1.0 if game.get("neutral_site") else 0.0,
        "home_field_adj": 0.0 if game.get("neutral_site") else 3.5,

        # Weather (not available historically — use neutral)
        "wind_adj": 0.0,
        "precip_adj": 0.0,
        "temp_adj": 0.0,

        # Game context
        "is_rivalry": 0.0,
        "is_conference_game": 1.0 if game.get("conference_game") else 0.0,
        "is_bowl": 0.0,

        # Misc
        "pace_diff": 0.0,
        "coach_experience_diff": 0.0,
        "injury_qb_flag_home": 0.0,
        "injury_qb_flag_away": 0.0,

        # Vegas (not available historically)
        "vegas_home_prob": 0.0,
        "mc_win_pct": 0.5 + (sp_val(home_sp, "rating") - sp_val(away_sp, "rating")) * 0.033,

        # Target
        "home_win": home_win,
        "season": game.get("season", 0),
        "week": game.get("week", 0),
        "home_team": home,
        "away_team": away,
        "neutral_site": 1 if game.get("neutralSite", game.get("neutral_site", False)) else 0,
        "conference_game": 1 if game.get("conferenceGame", game.get("conference_game", False)) else 0,
    }

    return f


# ── Simple Elo tracking during dataset build ──────────────────────────────────

class EloTracker:
    def __init__(self, k=25, mean=1500):
        self.ratings: dict[str, float] = {}
        self.k = k
        self.mean = mean

    def get(self, team: str) -> float:
        return self.ratings.get(team.lower(), self.mean)

    def update(self, home: str, away: str, home_pts: int, away_pts: int):
        h, a = home.lower(), away.lower()
        hr, ar = self.get(h), self.get(a)
        exp = 1 / (1 + 10 ** ((ar - hr) / 400))
        actual = 1.0 if home_pts > away_pts else 0.0
        margin = min(abs(home_pts - away_pts), 28)
        mult = np.log(margin + 1) * 2.2
        change = self.k * mult * (actual - exp)
        self.ratings[h] = hr + change
        self.ratings[a] = ar - change

    def reset_offseason(self):
        """45% regression toward mean between seasons."""
        for team in self.ratings:
            self.ratings[team] = 0.55 * self.ratings[team] + 0.45 * self.mean


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if not CFBD_API_KEY:
        print("ERROR: CFBD_API_KEY not set. Get a free key at https://collegefootballdata.com/key")
        return

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    all_rows = []
    elo = EloTracker()

    for season in SEASONS:
        print(f"\n=== Season {season} ===")
        games = fetch_games(season)
        sp_map = fetch_sp_ratings(season)
        epa_map = fetch_epa(season)
        recruit_map = fetch_recruiting(season)
        return_map = fetch_returning(season)

        # Sort games by week to update Elo in order
        games.sort(key=lambda g: (g.get("week", 99), g.get("startDate", g.get("start_date", ""))))

        season_rows = []
        for game in games:
            home = game.get("homeTeam", game.get("home_team", "")).lower()
            away = game.get("awayTeam", game.get("away_team", "")).lower()
            home_elo = elo.get(home)
            away_elo = elo.get(away)

            feat = extract_features(game, sp_map, epa_map, recruit_map, return_map, home_elo, away_elo)
            if feat is None:
                continue

            # Down-weight 2020 COVID season
            feat["sample_weight"] = 0.4 if season == 2020 else 1.0

            season_rows.append(feat)

            # Update Elo
            h_pts = game.get("homePoints", game.get("home_points"))
            a_pts = game.get("awayPoints", game.get("away_points"))
            if h_pts is not None and a_pts is not None:
                elo.update(home, away, int(h_pts), int(a_pts))

        print(f"  {len(season_rows)} games processed")
        all_rows.extend(season_rows)
        elo.reset_offseason()

    df = pd.DataFrame(all_rows)
    print(f"\nTotal rows: {len(df)}")
    print(f"Feature columns: {[c for c in df.columns if c not in ['home_win', 'season', 'week', 'home_team', 'away_team', 'sample_weight']]}")

    df.to_parquet(DATASET_FILE, index=False)
    print(f"\nDataset saved to {DATASET_FILE}")

    # Also save as CSV for inspection
    df.to_csv(DATA_DIR / "training_dataset.csv", index=False)
    print(f"CSV saved to {DATA_DIR / 'training_dataset.csv'}")


if __name__ == "__main__":
    main()
