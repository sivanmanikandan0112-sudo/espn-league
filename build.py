"""Pull an ESPN fantasy football league and write it to site/data.js.

Usage:  python3 build.py            (reads ESPN_LEAGUE_ID / ESPN_S2 / ESPN_SWID from .env)
        python3 build.py --season 2026

The cookies stay on this machine: the site only ever sees the slimmed-down data.js.
"""
import argparse
import datetime as dt
import json
import os
import sys
import urllib.request
from collections import defaultdict

ROOT = os.path.dirname(os.path.abspath(__file__))
API = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{league}"

POS = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST"}
SLOT = {0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "D/ST", 17: "K", 20: "BE", 21: "IR", 23: "FLEX"}
SLOT_ORDER = {0: 0, 2: 1, 4: 2, 6: 3, 23: 4, 16: 5, 17: 6, 20: 7, 21: 8}
PRO = {0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET",
       9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN",
       17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC",
       25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU"}
POWER_POSITIONS = ["QB", "RB", "WR", "TE"]
BENCH_WEIGHT = 0.3
POWER_TOP = 2500  # displayed power value of the #1 team


def load_env():
    path = os.path.join(ROOT, ".env")
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())
    missing = [k for k in ("ESPN_LEAGUE_ID", "ESPN_S2", "ESPN_SWID") if not os.environ.get(k)]
    if missing:
        sys.exit("Missing in .env: " + ", ".join(missing))


def fetch(season, path="", params=None, headers=None):
    league = os.environ["ESPN_LEAGUE_ID"]
    url = API.format(season=season, league=league) + path
    if params:
        url += "?" + "&".join("%s=%s" % kv for kv in params)
    req = urllib.request.Request(url, headers={
        "Cookie": "espn_s2=%s; SWID=%s" % (os.environ["ESPN_S2"], os.environ["ESPN_SWID"]),
        "User-Agent": "espn-league-site",
        **(headers or {}),
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            sys.exit("ESPN said 401: the cookies in .env have probably expired. Copy fresh ones.")
        raise


def proj(player, season, period, split):
    """ESPN projection (statSourceId 1).
    period 0 + split 0 = rest of season (remaining games); split 1 = a single week."""
    for s in player.get("stats", []):
        if (s.get("statSourceId") == 1 and s.get("seasonId") == season
                and s.get("scoringPeriodId") == period and s.get("statSplitTypeId") == split):
            return s.get("appliedTotal") or 0.0
    return 0.0


def player_row(entry, season, week):
    ppe = entry["playerPoolEntry"]
    p = ppe["player"]
    actual = None
    for s in p.get("stats", []):
        if (s.get("statSourceId") == 0 and s.get("scoringPeriodId") == week
                and s.get("seasonId") == season):
            actual = s.get("appliedTotal")
    return {
        "id": p["id"],
        "name": p["fullName"],
        "pos": POS.get(p.get("defaultPositionId"), "?"),
        "team": PRO.get(p.get("proTeamId"), ""),
        "slot": SLOT.get(entry["lineupSlotId"], "BE"),
        "slotOrder": SLOT_ORDER.get(entry["lineupSlotId"], 9),
        "pts": round(actual if actual is not None else ppe.get("appliedStatTotal") or 0, 2),
        "proj": round(proj(p, season, week, 1), 2),
        "injury": p.get("injuryStatus") if p.get("injuryStatus") not in (None, "ACTIVE", "NORMAL") else None,
    }


def build(season):
    print("Fetching league...", flush=True)
    main = fetch(season, params=[("view", v) for v in
                                 ("mTeam", "mRoster", "mSettings", "mStandings", "mMatchupScore")])
    status = main["status"]
    current_week = status["currentMatchupPeriod"]
    latest = status["latestScoringPeriod"]
    sched_settings = main["settings"]["scheduleSettings"]

    members = {m["id"]: m for m in main.get("members", [])}

    def manager(team):
        names = []
        for oid in team.get("owners", []):
            m = members.get(oid, {})
            names.append(m.get("firstName") or m.get("displayName") or "Manager")
        return " & ".join(names) or "Manager"

    # ---- rest-of-season position ranks, across the whole player pool ----
    print("Fetching player pool for rest-of-season ranks...", flush=True)
    filt = json.dumps({"players": {"filterSlotIds": {"value": [0, 2, 4, 6, 16, 17]}, "limit": 1000,
                                   "sortPercOwned": {"sortPriority": 1, "sortAsc": False}}})
    pool = fetch(season, params=[("view", "kona_player_info")], headers={"X-Fantasy-Filter": filt})
    by_pos = defaultdict(list)
    replacement = defaultdict(float)  # best unrostered (free agent / waivers) projection per position
    for e in pool.get("players", []):
        p = e["player"]
        ros = proj(p, season, 0, 0)
        pos = POS.get(p.get("defaultPositionId"), "?")
        if ros > 0:
            by_pos[pos].append((ros, p["id"]))
        if not e.get("onTeamId"):
            replacement[pos] = max(replacement[pos], ros)
    ros_rank = {}
    for pos, rows in by_pos.items():
        for i, (_, pid) in enumerate(sorted(rows, reverse=True)):
            ros_rank[pid] = i + 1

    # ---- teams, rosters, power ----
    teams = {}
    for t in main["teams"]:
        rec = t["record"]["overall"]
        roster = []
        for e in t["roster"]["entries"]:
            row = player_row(e, season, latest)
            row["ros"] = round(proj(e["playerPoolEntry"]["player"], season, 0, 0), 1)
            row["rosRank"] = ros_rank.get(row["id"])
            del row["pts"]  # season-to-date points per week live on the matchups page
            roster.append(row)
        roster.sort(key=lambda r: (r["slotOrder"], r["rosRank"] or 999))
        teams[t["id"]] = {
            "id": t["id"],
            "name": t["name"].strip(),
            "abbrev": t.get("abbrev", ""),
            "manager": manager(t),
            "logo": t.get("logo", ""),
            "wins": rec["wins"], "losses": rec["losses"], "ties": rec["ties"],
            "pf": round(rec["pointsFor"], 2), "pa": round(rec["pointsAgainst"], 2),
            "streak": "%s%d" % ((rec.get("streakType") or " ")[0], rec.get("streakLength") or 0),
            "seed": t.get("playoffSeed"),
            "roster": roster,
        }

    # Power value = value over replacement (VOR).
    #  - A player's value = his rest-of-season projection minus the best free agent's at his position
    #    (never below 0): what he gives you over someone you could pick up today.
    #  - Starters (the best legal QB/RB/WR/TE/FLEX lineup by projection) count in full;
    #    everyone else counts at BENCH_WEIGHT, since bench players only matter for byes/injuries.
    #  - K and D/ST are left out: they're close to random week to week.
    slot_counts = {int(k): int(v) for k, v in main["settings"]["rosterSettings"]["lineupSlotCounts"].items()}
    fixed_slots = {"QB": slot_counts.get(0, 0), "RB": slot_counts.get(2, 0),
                   "WR": slot_counts.get(4, 0), "TE": slot_counts.get(6, 0)}
    flex_slots = slot_counts.get(23, 0)  # RB/WR/TE flex
    for t in teams.values():
        players = [r for r in t["roster"] if r["pos"] in POWER_POSITIONS]
        for r in players:
            r["vor"] = round(max(0.0, r["ros"] - replacement[r["pos"]]), 1)
        starters = set()
        for pos, n in fixed_slots.items():
            best = sorted((r for r in players if r["pos"] == pos and r["ros"] > 0), key=lambda r: -r["ros"])
            starters.update(r["id"] for r in best[:n])
        flex_pool = sorted((r for r in players if r["id"] not in starters and r["ros"] > 0
                            and r["pos"] in ("RB", "WR", "TE")), key=lambda r: -r["ros"])
        starters.update(r["id"] for r in flex_pool[:flex_slots])
        t["posPower"] = {pos: 0.0 for pos in POWER_POSITIONS}
        for r in players:
            t["posPower"][r["pos"]] += r["vor"] * (1.0 if r["id"] in starters else BENCH_WEIGHT)
        t["posPower"] = {k: round(v, 1) for k, v in t["posPower"].items()}
        t["vorTotal"] = sum(t["posPower"].values())

    # Displayed power = (a free-agent-only starting lineup's projection + the team's edge over it),
    # scaled so the top team shows POWER_TOP. Same order as the raw edge; friendlier numbers.
    baseline = sum(replacement[pos] * n for pos, n in fixed_slots.items())
    baseline += flex_slots * max(replacement["RB"], replacement["WR"], replacement["TE"])
    scale = POWER_TOP / max(baseline + t["vorTotal"] for t in teams.values())
    for t in teams.values():
        t["power"] = round((baseline + t.pop("vorTotal")) * scale)
    print("Power: free-agent lineup baseline %.0f pts, scale x%.2f" % (baseline, scale))
    for pos in POWER_POSITIONS:
        ranked = sorted(teams.values(), key=lambda t: -t["posPower"][pos])
        for i, t in enumerate(ranked):
            t.setdefault("posRank", {})[pos] = i + 1
    for i, t in enumerate(sorted(teams.values(), key=lambda t: -t["power"])):
        t["powerRank"] = i + 1
    for i, t in enumerate(sorted(teams.values(), key=lambda t: (-(t["wins"] + t["ties"] / 2), -t["pf"]))):
        t["standing"] = i + 1

    # ---- matchups, week by week, with box scores ----
    weeks = {}
    last_week = min(current_week, sched_settings["matchupPeriodCount"] + 3)
    for w in range(1, last_week + 1):
        print("Fetching week %d box scores..." % w, flush=True)
        data = fetch(season, params=[("view", "mMatchupScore"), ("view", "mBoxscore"),
                                     ("scoringPeriodId", w)])
        games = []
        for m in data["schedule"]:
            if m["matchupPeriodId"] != w:
                continue
            g = {"id": m["id"], "winner": m.get("winner", "UNDECIDED"),
                 "playoff": m.get("playoffTierType", "NONE") != "NONE", "sides": []}
            for side in ("home", "away"):
                s = m.get(side)
                if not s:
                    continue
                live = w == current_week and m.get("winner") == "UNDECIDED"
                pts = s.get("totalPointsLive") if live and s.get("totalPointsLive") is not None else s.get("totalPoints", 0)
                lineup = []
                r = s.get("rosterForCurrentScoringPeriod") or {}
                for e in r.get("entries", []):
                    lineup.append(player_row(e, season, w))
                lineup.sort(key=lambda r: (r["slotOrder"], -r["pts"]))
                g["sides"].append({
                    "team": s["teamId"],
                    "pts": round(pts or 0, 2),
                    "proj": round(s.get("totalProjectedPointsLive") or 0, 2) if live else None,
                    "winProb": s.get("winProbability") if live else None,
                    "lineup": lineup,
                })
            games.append(g)
        weeks[w] = {"week": w, "final": w < current_week, "games": games}

    # ---- trades ----
    # The league activity feed is the reliable record: each completed trade is one topic,
    # with a "traded" message (type 244) per player: from = giving team, to = receiving team.
    print("Fetching trade history...", flush=True)
    filt = json.dumps({"topicsByType": {"ACTIVITY_TRANSACTIONS": {
        "limit": 2000, "sortMessageDate": {"sortPriority": 1, "sortAsc": False}}}})
    feed = fetch(season, path="/communication/", params=[("view", "kona_league_communication")],
                 headers={"X-Fantasy-Filter": filt})
    trade_topics = []
    for topic in feed.get("topics", []):
        moves = [m for m in topic.get("messages", []) if m.get("messageTypeId") == 244]
        if moves:
            trade_topics.append((topic, moves))

    names = {}
    for t in teams.values():
        for r in t["roster"]:
            names[r["id"]] = r
    missing = list({m["targetId"] for _, ms in trade_topics for m in ms if m["targetId"] not in names})
    if missing:
        filt = json.dumps({"players": {"filterIds": {"value": missing}}})
        pl = fetch(season, params=[("view", "kona_player_info")], headers={"X-Fantasy-Filter": filt})
        for e in pl.get("players", []):
            p = e["player"]
            names[p["id"]] = {"name": p["fullName"], "pos": POS.get(p.get("defaultPositionId"), "?"),
                              "team": PRO.get(p.get("proTeamId"), "")}
    trades = []
    for topic, moves in trade_topics:
        sides = defaultdict(list)
        for m in moves:
            info = names.get(m["targetId"], {"name": "Player #%s" % m["targetId"], "pos": "", "team": ""})
            sides[m["to"]].append({"name": info["name"], "pos": info["pos"], "team": info["team"],
                                   "from": m["from"]})
        trades.append({"id": topic["id"], "date": topic["date"],
                       "sides": [{"team": tid, "gets": got} for tid, got in sorted(sides.items())]})
    trades.sort(key=lambda t: -t["date"])

    # Custom ESPN logos need the login cookies, so download them next to the site.
    logo_dir = os.path.join(ROOT, "site", "logos")
    os.makedirs(logo_dir, exist_ok=True)
    for t in teams.values():
        url = t["logo"]
        if not url:
            continue
        try:
            req = urllib.request.Request(url, headers={
                "Cookie": "espn_s2=%s; SWID=%s" % (os.environ["ESPN_S2"], os.environ["ESPN_SWID"]),
                "User-Agent": "espn-league-site"})
            with urllib.request.urlopen(req, timeout=20) as r:
                ctype = r.headers.get("Content-Type", "")
                ext = ".png" if "png" in ctype else ".svg" if "svg" in ctype else ".gif" if "gif" in ctype else ".jpg"
                name = "team-%d%s" % (t["id"], ext)
                with open(os.path.join(logo_dir, name), "wb") as f:
                    f.write(r.read())
            t["logo"] = "logos/" + name
        except Exception as e:  # keep going; the site falls back to initials
            print("  logo for %s failed: %s" % (t["name"], e))
            t["logo"] = ""

    for t in teams.values():
        for r in t["roster"]:
            r.pop("slotOrder", None)
    for w in weeks.values():
        for g in w["games"]:
            for s in g["sides"]:
                for r in s["lineup"]:
                    r.pop("slotOrder", None)

    return {
        "league": {"id": main["id"], "name": main["settings"]["name"], "season": season,
                   "size": len(teams), "currentWeek": current_week,
                   "regularSeasonWeeks": sched_settings["matchupPeriodCount"],
                   "playoffTeams": sched_settings.get("playoffTeamCount")},
        "updated": dt.datetime.now(dt.timezone.utc).isoformat(),
        "teams": sorted(teams.values(), key=lambda t: t["standing"]),
        "weeks": [weeks[w] for w in sorted(weeks)],
        "trades": trades,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=dt.date.today().year if dt.date.today().month >= 8
                    else dt.date.today().year - 1)
    args = ap.parse_args()
    load_env()
    data = build(args.season)
    out = os.path.join(ROOT, "site", "data.js")
    with open(out, "w") as f:
        f.write("window.LEAGUE = ")
        json.dump(data, f, separators=(",", ":"))
        f.write(";\n")
    print("Wrote %s (%d KB): %d teams, %d weeks, %d trades" % (
        os.path.relpath(out, ROOT), os.path.getsize(out) // 1024,
        len(data["teams"]), len(data["weeks"]), len(data["trades"])))


if __name__ == "__main__":
    main()
