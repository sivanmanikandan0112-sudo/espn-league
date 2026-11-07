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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import power  # noqa: E402

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


def proj_stat(player, season, source, period=0, split=0):
    """Raw ESPN stat line: source 1 = projection, 0 = actual. period 0 + split 0 = whole (rest of) season."""
    for s in player.get("stats", []):
        if (s.get("statSourceId") == source and s.get("seasonId") == season
                and s.get("scoringPeriodId") == period and s.get("statSplitTypeId") == split):
            return s
    return {}


def bye_weeks(season):
    url = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/%d?view=proTeamSchedules_wl" % season
    req = urllib.request.Request(url, headers={"User-Agent": "espn-league-site"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return {t["id"]: t.get("byeWeek") for t in json.load(r)["settings"]["proTeams"]}


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
    best_fa = {}  # pos -> (ros total, per-game) of the best unrostered player: the empty-slot fill-in
    for e in pool.get("players", []):
        p = e["player"]
        line = proj_stat(p, season, 1)
        ros = line.get("appliedTotal") or 0.0
        pos = POS.get(p.get("defaultPositionId"), "?")
        if ros > 0:
            by_pos[pos].append((ros, p["id"]))
            if not e.get("onTeamId") and ros > best_fa.get(pos, (0, 0))[0]:
                best_fa[pos] = (ros, line.get("appliedAverage") or 0.0)
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
            pl = e["playerPoolEntry"]["player"]
            line = proj_stat(pl, season, 1)
            row["ros"] = round(line.get("appliedTotal") or 0.0, 1)
            row["_sim"] = {"rosTotal": line.get("appliedTotal") or 0.0, "rosAvg": line.get("appliedAverage") or 0.0,
                           "seasonAvg": proj_stat(pl, season, 0).get("appliedAverage") or 0.0,
                           "injury": row["injury"], "proTeam": pl.get("proTeamId")}
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

    # Power value = expected starting-lineup points for the rest of the fantasy season (see power.py).
    final_week = status.get("finalScoringPeriod") or 17
    power_weeks = list(range(latest + 1, final_week + 1)) or [final_week]
    slot_counts = {int(k): int(v) for k, v in main["settings"]["rosterSettings"]["lineupSlotCounts"].items()}
    slots = {"QB": slot_counts.get(0, 0), "RB": slot_counts.get(2, 0), "WR": slot_counts.get(4, 0), "TE": slot_counts.get(6, 0)}
    fallback = {pos: best_fa.get(pos, (0, 0))[1] for pos in POWER_POSITIONS}
    byes = bye_weeks(season)
    print("Simulating weeks %d-%d (%d runs per team)..." % (power_weeks[0], power_weeks[-1], power.SIMULATIONS), flush=True)
    for t in teams.values():
        sim_players = []
        for r in t["roster"]:
            if r["pos"] not in POWER_POSITIONS:
                continue
            wk, back = power.availability(r["_sim"], power_weeks, latest, 18, byes.get(r["_sim"]["proTeam"]))
            if back and r["_sim"]["rosTotal"] <= 0:
                r["returns"] = back  # stash rule applied
            sim_players.append({"key": r["id"], "pos": r["pos"], "wk": wk})
        total, credit, starts = power.team_power(sim_players, power_weeks, slots, slot_counts.get(23, 0), fallback)
        t["power"] = round(total)
        t["posPower"] = {pos: 0.0 for pos in POWER_POSITIONS}
        for r in t["roster"]:
            if r["id"] in credit:
                r["starts"] = round(starts[r["id"]], 1)
                t["posPower"][r["pos"]] += credit[r["id"]]
        t["posPower"] = {k: round(v, 1) for k, v in t["posPower"].items()}
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
            r.pop("_sim", None)
    for w in weeks.values():
        for g in w["games"]:
            for s in g["sides"]:
                for r in s["lineup"]:
                    r.pop("slotOrder", None)

    return {
        "league": {"id": main["id"], "name": main["settings"]["name"], "season": season,
                   "size": len(teams), "currentWeek": current_week,
                   "regularSeasonWeeks": sched_settings["matchupPeriodCount"],
                   "playoffTeams": sched_settings.get("playoffTeamCount"),
                   "powerWeeks": [power_weeks[0], power_weeks[-1]]},
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
