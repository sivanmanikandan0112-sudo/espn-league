"""Pull an ESPN fantasy football league (every season) and write the static site's data.

Usage:  python3 build.py              # all seasons (reads ESPN_LEAGUE_ID / ESPN_S2 / ESPN_SWID from .env)
        python3 build.py --only-current

Writes site/data/index.js (season list + all-time history) and site/data/<season>.js.
The cookies stay on this machine / in GitHub secrets: the site only ever sees the built data.
"""
import argparse
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.request
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import power  # noqa: E402
import stats  # noqa: E402

ROOT = os.path.dirname(os.path.abspath(__file__))
API = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{league}"
DATA_DIR = os.path.join(ROOT, "site", "data")
LOGO_DIR = os.path.join(ROOT, "site", "logos")

POS = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST"}
SLOT = {0: "QB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP", 16: "D/ST", 17: "K",
        20: "BE", 21: "IR", 23: "FLEX"}
SLOT_ORDER = {0: 0, 2: 1, 4: 2, 6: 3, 3: 4, 5: 4, 23: 4, 7: 4, 16: 5, 17: 6, 20: 7, 21: 8}
PRO = {0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET",
       9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN",
       17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC",
       25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU"}
POWER_POSITIONS = ["QB", "RB", "WR", "TE"]
TRADE_MESSAGE = 244  # activity-feed message type for "player traded"


# ---------------------------------------------------------------- ESPN access

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


def _cookie():
    return "espn_s2=%s; SWID=%s" % (os.environ["ESPN_S2"], os.environ["ESPN_SWID"])


def fetch(season, path="", params=None, headers=None):
    url = API.format(season=season, league=os.environ["ESPN_LEAGUE_ID"]) + path
    if params:
        url += "?" + "&".join("%s=%s" % kv for kv in params)
    req = urllib.request.Request(url, headers={"Cookie": _cookie(), "User-Agent": "espn-league-site", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            sys.exit("ESPN said 401: the cookies in .env have probably expired. Copy fresh ones.")
        raise


def bye_weeks(season):
    url = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/%d?view=proTeamSchedules_wl" % season
    req = urllib.request.Request(url, headers={"User-Agent": "espn-league-site"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return {t["id"]: t.get("byeWeek") for t in json.load(r)["settings"]["proTeams"]}


def stat_line(player, season, source, period=0, split=0):
    """ESPN stat line. source 1 = projection, 0 = actual. period 0 + split 0 = whole (rest of) season."""
    for s in player.get("stats", []):
        if (s.get("statSourceId") == source and s.get("seasonId") == season
                and s.get("scoringPeriodId") == period and s.get("statSplitTypeId") == split):
            return s
    return {}


def player_pool(season):
    filt = json.dumps({"players": {"filterSlotIds": {"value": [0, 2, 4, 6, 16, 17]}, "limit": 1000,
                                   "sortPercOwned": {"sortPriority": 1, "sortAsc": False}}})
    return fetch(season, params=[("view", "kona_player_info")], headers={"X-Fantasy-Filter": filt}).get("players", [])


def player_info(season, ids):
    if not ids:
        return {}
    filt = json.dumps({"players": {"filterIds": {"value": list(ids)}}})
    out = {}
    for e in fetch(season, params=[("view", "kona_player_info")], headers={"X-Fantasy-Filter": filt}).get("players", []):
        p = e["player"]
        out[p["id"]] = {"name": p["fullName"], "pos": POS.get(p.get("defaultPositionId"), "?"),
                        "team": PRO.get(p.get("proTeamId"), ""),
                        "pts": stat_line(p, season, 0).get("appliedTotal") or 0.0}
    return out


def download_logo(season, team_id, url):
    """Custom ESPN logos need the login cookies, so they're saved next to the site."""
    if not url:
        return ""
    try:
        req = urllib.request.Request(url, headers={"Cookie": _cookie(), "User-Agent": "espn-league-site"})
        with urllib.request.urlopen(req, timeout=20) as r:
            ctype = r.headers.get("Content-Type", "")
            ext = ".png" if "png" in ctype else ".svg" if "svg" in ctype else ".gif" if "gif" in ctype else ".jpg"
            name = "%d-team-%d%s" % (season, team_id, ext)
            with open(os.path.join(LOGO_DIR, name), "wb") as f:
                f.write(r.read())
        return "logos/" + name
    except Exception as e:  # keep going; the site falls back to initials
        print("  logo for team %d failed: %s" % (team_id, e))
        return ""


# ---------------------------------------------------------------- members

def member_directory(seasons):
    """Every member who has ever been in the league, keyed by ESPN account id (stable across seasons,
    unlike team slots, which ESPN reuses when someone leaves and a new manager joins)."""
    raw = {}
    for season in seasons:
        for m in fetch(season, params=[("view", "mTeam")]).get("members", []):
            raw.setdefault(m["id"], m)
    first_counts = defaultdict(int)
    for m in raw.values():
        first_counts[(m.get("firstName") or "").strip().lower()] += 1
    names = {}
    for mid, m in raw.items():
        first, last = (m.get("firstName") or "").strip(), (m.get("lastName") or "").strip()
        if not first:
            names[mid] = m.get("displayName") or "Manager"
        elif first_counts[first.lower()] > 1 and last:
            names[mid] = "%s %s." % (first, last[0])
        else:
            names[mid] = first
    return names


# ---------------------------------------------------------------- one season

def player_row(entry, season, week):
    ppe = entry["playerPoolEntry"]
    p = ppe["player"]
    actual = stat_line(p, season, 0, week, 1) or None
    if actual is None:
        for s in p.get("stats", []):
            if s.get("statSourceId") == 0 and s.get("scoringPeriodId") == week and s.get("seasonId") == season:
                actual = s
    pts = (actual or {}).get("appliedTotal")
    injury = p.get("injuryStatus")
    return {
        "id": p["id"], "name": p["fullName"],
        "pos": POS.get(p.get("defaultPositionId"), "?"),
        "team": PRO.get(p.get("proTeamId"), ""),
        "slot": SLOT.get(entry["lineupSlotId"], "BE"),
        "slotOrder": SLOT_ORDER.get(entry["lineupSlotId"], 9),
        "pts": round(pts if pts is not None else ppe.get("appliedStatTotal") or 0, 2),
        "injury": injury if injury not in (None, "ACTIVE", "NORMAL") else None,
    }


# Raw stats kept for the player stat panel (everything that scores is kept too, see week_stats).
STAT_LINE_IDS = {0, 1, 3, 4, 19, 20, 23, 24, 25, 26, 42, 43, 44, 53, 58, 62, 72, 74, 75, 77, 78, 80, 81, 83, 84, 86, 87,
                 95, 96, 97, 98, 99, 101, 102, 103, 104, 120, 127}


def week_stats(entry, season, week):
    """A player's real stats for one week and the fantasy points each one earned under this league's scoring."""
    p = entry["playerPoolEntry"]["player"]
    for s in p.get("stats", []):
        if s.get("statSourceId") == 0 and s.get("scoringPeriodId") == week and s.get("seasonId") == season:
            applied = {k: round(v, 2) for k, v in (s.get("appliedStats") or {}).items() if v}
            raw = {k: round(v, 2) for k, v in (s.get("stats") or {}).items() if v and (int(k) in STAT_LINE_IDS or k in applied)}
            return {"r": raw, "a": applied}
    return None


def season_status(main, is_current):
    status = main["status"]
    final_week = status.get("finalScoringPeriod") or 17
    over = (not is_current) or status.get("latestScoringPeriod", 0) > final_week
    return status, final_week, over


def build_season(season, is_current, names):
    print("== %d ==" % season, flush=True)
    main = fetch(season, params=[("view", v) for v in ("mTeam", "mRoster", "mSettings", "mStandings", "mMatchupScore")])
    status, final_week, over = season_status(main, is_current)
    settings = main["settings"]
    sched = settings["scheduleSettings"]
    regular = sched["matchupPeriodCount"]
    matchup_periods = sorted(int(k) for k in sched.get("matchupPeriods", {}) or {}) or list(range(1, final_week + 1))
    current_week = status["currentMatchupPeriod"] if not over else matchup_periods[-1]
    latest = status["latestScoringPeriod"] if not over else final_week
    slot_counts = {int(k): int(v) for k, v in settings["rosterSettings"]["lineupSlotCounts"].items() if int(v) > 0}

    # -- player pool: position ranks (rest of season now; final finish for past seasons)
    pool = player_pool(season)
    by_pos, best_fa = defaultdict(list), {}
    actual = {}  # season points so far (or final) for everyone in the pool: draft review & rankings
    for e in pool:
        p = e["player"]
        pos = POS.get(p.get("defaultPositionId"), "?")
        actual[p["id"]] = {"name": p["fullName"], "pos": pos, "team": PRO.get(p.get("proTeamId"), ""),
                           "pts": stat_line(p, season, 0).get("appliedTotal") or 0.0}
        line = stat_line(p, season, 1) if not over else stat_line(p, season, 0)
        total = line.get("appliedTotal") or 0.0
        if total > 0:
            by_pos[pos].append((total, p["id"]))
            if not over and not e.get("onTeamId") and total > best_fa.get(pos, (0, 0))[0]:
                best_fa[pos] = (total, line.get("appliedAverage") or 0.0)
    pos_rank = {pid: i + 1 for rows in by_pos.values() for i, (_, pid) in enumerate(sorted(rows, reverse=True))}

    # -- teams
    teams = {}
    for t in main["teams"]:
        rec = t["record"]["overall"]
        roster = []
        for e in t["roster"]["entries"]:
            row = player_row(e, season, latest)
            pl = e["playerPoolEntry"]["player"]
            del row["pts"]
            if over:
                row["seasonPts"] = round(stat_line(pl, season, 0).get("appliedTotal") or 0.0, 1)
                row["posRank"] = pos_rank.get(row["id"])
            else:
                line = stat_line(pl, season, 1)
                row["ros"] = round(line.get("appliedTotal") or 0.0, 1)
                row["rosRank"] = pos_rank.get(row["id"])
                row["_sim"] = {"rosTotal": line.get("appliedTotal") or 0.0, "rosAvg": line.get("appliedAverage") or 0.0,
                               "seasonAvg": stat_line(pl, season, 0).get("appliedAverage") or 0.0,
                               "injury": row["injury"], "proTeam": pl.get("proTeamId")}
            roster.append(row)
        roster.sort(key=lambda r: (r["slotOrder"], r.get("rosRank") or r.get("posRank") or 999))
        owners = t.get("owners", [])
        teams[t["id"]] = {
            "id": t["id"], "name": t["name"].strip(), "abbrev": t.get("abbrev", ""),
            "owners": owners, "manager": " & ".join(names.get(o, "Manager") for o in owners) or "Manager",
            "logo": download_logo(season, t["id"], t.get("logo", "")),
            "wins": rec["wins"], "losses": rec["losses"], "ties": rec["ties"],
            "pf": round(rec["pointsFor"], 2), "pa": round(rec["pointsAgainst"], 2),
            "streak": "%s%d" % ((rec.get("streakType") or " ")[0], rec.get("streakLength") or 0),
            "seed": t.get("playoffSeed"),
            "finalRank": t.get("rankCalculatedFinal") or None if over else None,
            "roster": roster,
        }
    for i, t in enumerate(sorted(teams.values(), key=lambda t: (-(t["wins"] + t["ties"] / 2), -t["pf"]))):
        t["standing"] = i + 1

    # -- matchups with box scores
    weeks = []
    names_seen = {}
    player_stats = {}  # "week|player id" -> {r: raw stats, a: points per stat}; written to its own file
    for w in [p for p in matchup_periods if p <= current_week]:
        print("  week %d" % w, flush=True)
        data = fetch(season, params=[("view", "mMatchupScore"), ("view", "mBoxscore"), ("scoringPeriodId", w)])
        games = []
        for m in data["schedule"]:
            if m["matchupPeriodId"] != w:
                continue
            tier = m.get("playoffTierType", "NONE")
            g = {"id": m["id"], "winner": m.get("winner", "UNDECIDED"), "playoff": tier != "NONE",
                 "tier": tier, "sides": []}
            for side in ("home", "away"):
                s = m.get(side)
                if not s:
                    continue
                live = not over and w == current_week and m.get("winner") == "UNDECIDED"
                pts = s.get("totalPointsLive") if live and s.get("totalPointsLive") is not None else s.get("totalPoints", 0)
                entries = (s.get("rosterForCurrentScoringPeriod") or {}).get("entries", [])
                lineup = [player_row(e, season, w) for e in entries]
                for e in entries:
                    st = week_stats(e, season, w)
                    if st:
                        player_stats["%d|%d" % (w, e["playerId"])] = st
                lineup.sort(key=lambda r: (r["slotOrder"], -r["pts"]))
                for r in lineup:
                    names_seen[r["id"]] = r
                g["sides"].append({
                    "team": s["teamId"], "pts": round(pts or 0, 2),
                    "proj": round(s.get("totalProjectedPointsLive") or 0, 2) if live else None,
                    "winProb": s.get("winProbability") if live else None,
                    "lineup": lineup,
                })
            games.append(g)
        weeks.append({"week": w, "final": over or w < current_week, "playoffs": w > regular, "games": games})

    # -- trades
    trades = current_trades(season, teams, names_seen) if is_current else past_trades(season, weeks, final_week, names_seen)

    data = {
        "league": {"id": main["id"], "name": settings["name"], "season": season, "size": len(teams),
                   "currentWeek": current_week, "regularSeasonWeeks": regular, "finalWeek": final_week,
                   "playoffTeams": sched.get("playoffTeamCount"), "playoffRounds": max(1, final_week - regular),
                   "over": over, "isCurrent": is_current},
        "updated": dt.datetime.now(dt.timezone.utc).isoformat(),
        "teams": list(teams.values()),
        "weeks": weeks,
        "trades": trades,
        "_stats": player_stats,
    }

    # -- power / position strength
    if not over:
        add_power(data, teams, slot_counts, best_fa, latest, final_week, season)
    else:
        add_season_strength(data, teams, regular, slot_counts)

    # -- analytics
    luck = stats.all_play_and_luck(data)
    eff, per_week = stats.efficiency(data, slot_counts)
    for tid, t in teams.items():
        t.update(luck.get(tid, {}))
        t.update(eff.get(tid, {}))
    data["recaps"] = stats.weekly_recaps(data, per_week, {tid: t["name"] for tid, t in teams.items()})
    remaining = strength = None
    if is_current and not over and current_week <= regular:
        remaining, strength = add_playoff_odds(data, main, teams, regular, current_week)
    sos = stats.schedule_strength(data, remaining, strength)
    for tid, t in teams.items():
        t["sos"] = sos.get(tid)
    data["trades"] = stats.grade_trades(data, data["trades"])
    data["scheduleSwap"] = stats.schedule_swap(data)
    add_draft(data, season, actual)

    for t in teams.values():
        for r in t["roster"]:
            r.pop("slotOrder", None); r.pop("_sim", None)
    for w in weeks:
        for g in w["games"]:
            for s in g["sides"]:
                for r in s["lineup"]:
                    r.pop("slotOrder", None)
    data["teams"] = sorted(teams.values(), key=lambda t: t["standing"])
    return data


def add_power(data, teams, slot_counts, best_fa, latest, final_week, season):
    """Current season: expected starting-lineup points over the remaining weeks (see power.py)."""
    power_weeks = list(range(latest + 1, final_week + 1)) or [final_week]
    slots = {"QB": slot_counts.get(0, 0), "RB": slot_counts.get(2, 0), "WR": slot_counts.get(4, 0), "TE": slot_counts.get(6, 0)}
    fallback = {pos: best_fa.get(pos, (0, 0))[1] for pos in POWER_POSITIONS}
    byes = bye_weeks(season)
    print("  simulating weeks %d-%d for power..." % (power_weeks[0], power_weeks[-1]), flush=True)
    for t in teams.values():
        sim_players = []
        for r in t["roster"]:
            if r["pos"] not in POWER_POSITIONS:
                continue
            wk, back = power.availability(r["_sim"], power_weeks, latest, 18, byes.get(r["_sim"]["proTeam"]))
            if back and r["_sim"]["rosTotal"] <= 0:
                r["returns"] = back
            sim_players.append({"key": r["id"], "pos": r["pos"], "wk": wk})
        total, credit, starts, groups = power.team_power(sim_players, power_weeks, slots, slot_counts.get(23, 0), fallback)
        t["power"] = round(total)
        for r in t["roster"]:
            if r["id"] in credit:
                r["starts"] = round(starts[r["id"]], 1)
        # position bars: each position group rated on the same spots for every team (power.group_spots)
        t["posPower"] = {k: round(groups.get(k, 0.0), 1) for k in POWER_POSITIONS}
    rank_positions(teams)
    for i, t in enumerate(sorted(teams.values(), key=lambda t: -t["power"])):
        t["powerRank"] = i + 1
    data["league"]["powerWeeks"] = [power_weeks[0], power_weeks[-1]]


def add_season_strength(data, teams, regular, slot_counts):
    """Past seasons: position bars = what each position group actually produced, rated on the same spots as the
    current season (best QB, 3 RBs, 3 WRs, 1 TE on the roster each regular-season week)."""
    slots = {"QB": slot_counts.get(0, 0), "RB": slot_counts.get(2, 0), "WR": slot_counts.get(4, 0), "TE": slot_counts.get(6, 0)}
    spots = power.group_spots(slots, slot_counts.get(23, 0) + slot_counts.get(3, 0) + slot_counts.get(5, 0))
    for t in teams.values():
        t["posPower"] = {pos: 0.0 for pos in POWER_POSITIONS}
    for w in data["weeks"]:
        if w["week"] > regular:
            continue
        for g in w["games"]:
            for s in g["sides"]:
                if s["team"] not in teams:
                    continue
                for pos, k in spots.items():
                    best = sorted((p["pts"] for p in s["lineup"] if p["pos"] == pos and p["slot"] != "IR"), reverse=True)[:k]
                    teams[s["team"]]["posPower"][pos] += sum(best)
    for t in teams.values():
        t["posPower"] = {k: round(v, 1) for k, v in t["posPower"].items()}
    rank_positions(teams)


def rank_positions(teams):
    for pos in POWER_POSITIONS:
        for i, t in enumerate(sorted(teams.values(), key=lambda t: -t["posPower"][pos])):
            t.setdefault("posRank", {})[pos] = i + 1


def add_playoff_odds(data, main, teams, regular, current_week):
    print("  simulating playoff odds...", flush=True)
    schedule, live = [], {}
    for m in main["schedule"]:
        w = m["matchupPeriodId"]
        if w > regular or w < current_week or m.get("winner", "UNDECIDED") != "UNDECIDED":
            continue
        if not (m.get("home") and m.get("away")):
            continue
        schedule.append((w, m["home"]["teamId"], m["away"]["teamId"]))
    cur = next((wk for wk in data["weeks"] if wk["week"] == current_week), None)
    if cur:
        for g in cur["games"]:
            for s in g["sides"]:
                if s.get("proj"):
                    live[s["team"]] = (current_week, s["proj"], s["pts"], s.get("winProb"))
    pw = data["league"].get("powerWeeks")
    n_power_weeks = (pw[1] - pw[0] + 1) if pw else 0
    strength = stats.team_strengths(data, {tid: t.get("power", 0) for tid, t in teams.items()}, n_power_weeks, live)
    odds = stats.playoff_odds(data, schedule, strength)
    for tid, o in odds.items():
        teams[tid]["odds"] = o
    return schedule, strength


def add_draft(data, season, actual):
    try:
        picks = fetch(season, params=[("view", "mDraftDetail")]).get("draftDetail", {}).get("picks", [])
    except Exception as e:
        print("  draft unavailable: %s" % e)
        return
    if not picks:
        return
    players = dict(actual)
    players.update(player_info(season, {p["playerId"] for p in picks if p["playerId"] not in players}))
    rank_pool = defaultdict(list)
    for x in players.values():
        rank_pool[x["pos"]].append(x["pts"])
    for v in rank_pool.values():
        v.sort(reverse=True)
    data["draft"] = stats.draft_review(picks, players, rank_pool)


# ---------------------------------------------------------------- trades

def current_trades(season, teams, names_seen):
    """The league activity feed: each completed trade is one topic with a 'traded' message per player
    (from = giving team, to = receiving team). Only available for the current season."""
    filt = json.dumps({"topicsByType": {"ACTIVITY_TRANSACTIONS": {"limit": 2000, "sortMessageDate": {"sortPriority": 1, "sortAsc": False}}}})
    feed = fetch(season, path="/communication/", params=[("view", "kona_league_communication")], headers={"X-Fantasy-Filter": filt})
    topics = [(t, [m for m in t.get("messages", []) if m.get("messageTypeId") == TRADE_MESSAGE]) for t in feed.get("topics", [])]
    topics = [(t, ms) for t, ms in topics if ms]
    names = dict(names_seen)
    for t in teams.values():
        for r in t["roster"]:
            names[r["id"]] = r
    names.update(player_info(season, {m["targetId"] for _, ms in topics for m in ms if m["targetId"] not in names}))
    trades = []
    for topic, moves in topics:
        trades.append(make_trade(topic["id"], topic["date"], [(m["targetId"], m["from"], m["to"]) for m in moves], names))
    return sorted(trades, key=lambda t: -t["date"])


def past_trades(season, weeks, final_week, names_seen):
    """Past seasons have no activity feed. Rebuild trades from week-to-week roster swaps (team A's player
    shows up on team B the next week and vice versa), kept only when the transaction log has an accepted,
    un-vetoed trade by one of those teams around that week. Exact records are used where the log has them."""
    tx = {}
    for p in range(0, final_week + 1):
        for t in fetch(season, params=[("view", "mTransactions2"), ("scoringPeriodId", p)]).get("transactions", []):
            tx[t["id"]] = t
    vetoed = {t.get("relatedTransactionId") for t in tx.values() if t["type"] == "TRADE_VETO"}
    accepts = [t for t in tx.values() if t["type"] == "TRADE_ACCEPT" and t.get("relatedTransactionId") not in vetoed]

    trades, covered = [], set()
    for a in accepts:  # exact records
        items = [i for i in (a.get("items") or tx.get(a.get("relatedTransactionId"), {}).get("items") or []) if i.get("type") == "TRADE"]
        if items and a.get("status") == "EXECUTED":
            moves = [(i["playerId"], i["fromTeamId"], i["toTeamId"]) for i in items]
            trades.append((a.get("processDate") or a.get("proposedDate"), a["id"], moves, a["scoringPeriodId"]))
            covered.add((a["scoringPeriodId"], frozenset(x for _, f, t in moves for x in (f, t))))

    owner = {}
    for w in weeks:
        owner[w["week"]] = {p["id"]: s["team"] for g in w["games"] for s in g["sides"] for p in s["lineup"]}
    accept_weeks = defaultdict(set)
    for a in accepts:
        accept_weeks[a["teamId"]].add(a["scoringPeriodId"])
    ws = sorted(owner)
    for prev, w in zip(ws, ws[1:]):
        moves = defaultdict(list)
        for pid, to in owner[w].items():
            frm = owner[prev].get(pid)
            if frm and frm != to:
                moves[(frm, to)].append(pid)
        for (a, b), ps in moves.items():
            if a > b or (b, a) not in moves:
                continue
            pair = frozenset((a, b))
            near = {prev, w, w - 1}
            if any((wk, pair) in covered for wk in near):
                continue
            if not (accept_weeks[a] & near or accept_weeks[b] & near):
                continue
            mv = [(pid, a, b) for pid in ps] + [(pid, b, a) for pid in moves[(b, a)]]
            trades.append((None, "w%d-%d-%d" % (w, a, b), mv, w))

    names = dict(names_seen)
    names.update(player_info(season, {pid for t in trades for pid, _, _ in t[2] if pid not in names}))
    out = []
    for date, tid, moves, week in trades:
        tr = make_trade(tid, date, moves, names)
        tr["week"] = week
        out.append(tr)
    return sorted(out, key=lambda t: (-t["week"], -(t["date"] or 0)))


def make_trade(tid, date, moves, names):
    sides = defaultdict(list)
    for pid, frm, to in moves:
        info = names.get(pid, {"name": "Player #%s" % pid, "pos": "", "team": ""})
        sides[to].append({"id": pid, "name": info["name"], "pos": info["pos"], "team": info["team"], "from": frm})
    return {"id": tid, "date": date, "sides": [{"team": k, "gets": v} for k, v in sorted(sides.items())]}


# ---------------------------------------------------------------- all-time history

def build_history(seasons_data, names, current_members):
    """All-time records per member (ESPN account), so people who left keep their history and
    new members start fresh, regardless of which team slot they inherited."""
    rec = defaultdict(lambda: {"seasons": [], "w": 0, "l": 0, "t": 0, "pf": 0.0, "pa": 0.0, "titles": 0,
                               "finals": 0, "playoffs": 0, "best": None, "pw": 0, "pl": 0})
    h2h = defaultdict(lambda: [0, 0, 0, 0.0, 0.0])  # (a, b) -> wins, losses, ties, pf, pa (a's view)
    champions = []
    for data in sorted(seasons_data, key=lambda d: d["league"]["season"]):
        lg = data["league"]
        tm = {t["id"]: t for t in data["teams"]}
        for t in data["teams"]:
            for o in t["owners"]:
                r = rec[o]
                r["seasons"].append({"season": lg["season"], "team": t["name"], "logo": t["logo"], "teamId": t["id"],
                                     "w": t["wins"], "l": t["losses"], "t": t["ties"], "pf": t["pf"],
                                     "finish": t.get("finalRank"), "standing": t["standing"]})
                r["w"] += t["wins"]; r["l"] += t["losses"]; r["t"] += t["ties"]
                r["pf"] += t["pf"]; r["pa"] += t["pa"]
                if lg["over"] and t.get("finalRank"):
                    r["best"] = t["finalRank"] if r["best"] is None else min(r["best"], t["finalRank"])
                    if t["finalRank"] == 1:
                        r["titles"] += 1
                    if t["finalRank"] <= 2:
                        r["finals"] += 1
                if lg["over"] and t.get("seed") and t["seed"] <= (lg["playoffTeams"] or 0):
                    r["playoffs"] += 1
        if lg["over"]:
            champ = next((t for t in data["teams"] if t.get("finalRank") == 1), None)
            runner = next((t for t in data["teams"] if t.get("finalRank") == 2), None)
            if champ:
                champions.append({"season": lg["season"], "team": champ["name"], "logo": champ["logo"],
                                  "owners": champ["owners"], "record": "%d-%d" % (champ["wins"], champ["losses"]),
                                  "runnerUp": runner and {"team": runner["name"], "owners": runner["owners"]}})
        for w in data["weeks"]:
            if not w["final"]:
                continue
            for g in w["games"]:
                if len(g["sides"]) != 2 or g["tier"] not in ("NONE", "WINNERS_BRACKET"):
                    continue
                a, b = g["sides"]
                for me, opp in ((a, b), (b, a)):
                    for o1 in tm.get(me["team"], {}).get("owners", []):
                        for o2 in tm.get(opp["team"], {}).get("owners", []):
                            h = h2h[(o1, o2)]
                            h[0 if me["pts"] > opp["pts"] else 1 if me["pts"] < opp["pts"] else 2] += 1
                            h[3] += me["pts"]; h[4] += opp["pts"]
                    if g["tier"] == "WINNERS_BRACKET":
                        for o in tm.get(me["team"], {}).get("owners", []):
                            rec[o]["pw" if me["pts"] > opp["pts"] else "pl"] += 1

    members = []
    for mid, r in rec.items():
        games = r["w"] + r["l"] + r["t"]
        members.append({"id": mid, "name": names.get(mid, "Manager"), "active": mid in current_members,
                        "seasons": r["seasons"], "w": r["w"], "l": r["l"], "t": r["t"],
                        "pct": round((r["w"] + r["t"] / 2) / games, 3) if games else 0,
                        "pf": round(r["pf"], 2), "pa": round(r["pa"], 2),
                        "ppg": round(r["pf"] / games, 1) if games else 0,
                        "titles": r["titles"], "finals": r["finals"], "playoffs": r["playoffs"], "best": r["best"],
                        "playoffW": r["pw"], "playoffL": r["pl"]})
    members.sort(key=lambda m: (-m["titles"], -m["pct"]))
    return {"members": members, "champions": sorted(champions, key=lambda c: -c["season"]),
            "h2h": {"%s|%s" % k: [v[0], v[1], v[2], round(v[3], 1), round(v[4], 1)] for k, v in h2h.items()},
            "records": record_book(seasons_data), "rivalries": rivalries(h2h)}


def record_book(seasons_data, top=5):
    """League records across every season (all matchups, playoffs included)."""
    scores, games, players, bench = [], [], [], []
    for data in seasons_data:
        lg = data["league"]
        tm = {t["id"]: t for t in data["teams"]}
        ref = lambda tid: {"team": tm[tid]["name"], "owners": tm[tid]["owners"], "logo": tm[tid]["logo"]}
        for w in data["weeks"]:
            if not w["final"]:
                continue
            for g in w["games"]:
                if len(g["sides"]) != 2:
                    continue
                a, b = g["sides"]
                if a["pts"] <= 0 or b["pts"] <= 0:
                    continue
                where = {"season": lg["season"], "week": w["week"], "playoff": g["tier"] == "WINNERS_BRACKET", "game": g["id"]}
                for s in (a, b):
                    scores.append(dict(where, pts=s["pts"], teamId=s["team"], **ref(s["team"])))
                    for p in s["lineup"]:
                        row = dict(where, name=p["name"], pos=p["pos"], pts=p["pts"], pid=p["id"], teamId=s["team"], **ref(s["team"]))
                        (players if stats.is_starter(p) else bench if p["slot"] != "IR" else []).append(row)
                win, lose = sorted((a, b), key=lambda s: -s["pts"])
                games.append(dict(where, teamId=win["team"], winner=ref(win["team"]), loser=ref(lose["team"]), winPts=win["pts"],
                                  losePts=lose["pts"], margin=round(win["pts"] - lose["pts"], 2),
                                  combined=round(win["pts"] + lose["pts"], 2)))
    return {
        "highScores": sorted(scores, key=lambda x: -x["pts"])[:top],
        "lowScores": sorted(scores, key=lambda x: x["pts"])[:top],
        "blowouts": sorted(games, key=lambda x: -x["margin"])[:top],
        "closest": sorted(games, key=lambda x: x["margin"])[:top],
        "shootouts": sorted(games, key=lambda x: -x["combined"])[:top],
        "playerGames": sorted(players, key=lambda x: -x["pts"])[:top],
        "benchGames": sorted(bench, key=lambda x: -x["pts"])[:top],
    }


def rivalries(h2h, top=6):
    """Pairs of members, from the all-time head-to-head table."""
    pairs = []
    for (a, b), v in h2h.items():
        if a >= b:
            continue
        games = v[0] + v[1] + v[2]
        if games < 2:
            continue
        pairs.append({"a": a, "b": b, "aW": v[0], "bW": v[1], "t": v[2], "games": games,
                      "aPts": round(v[3], 1), "bPts": round(v[4], 1), "diffPerGame": round(abs(v[3] - v[4]) / games, 1)})
    most = sorted(pairs, key=lambda p: (-p["games"], p["diffPerGame"]))[:top]
    closest = sorted([p for p in pairs if p["games"] >= 3], key=lambda p: (abs(p["aW"] - p["bW"]), p["diffPerGame"]))[:top]
    lopsided = sorted([p for p in pairs if p["games"] >= 3],
                      key=lambda p: (-abs(p["aW"] - p["bW"]) / p["games"], -p["diffPerGame"]))[:top]
    return {"mostPlayed": most, "closest": closest, "lopsided": lopsided}


# ---------------------------------------------------------------- main

def write_js(path, var, key, obj):
    with open(path, "w") as f:
        f.write("window.%s=window.%s||{};window.%s[%s]=" % (var, var, var, json.dumps(key)))
        json.dump(obj, f, separators=(",", ":"))
        f.write(";\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=dt.date.today().year if dt.date.today().month >= 8 else dt.date.today().year - 1)
    args = ap.parse_args()
    load_env()
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(LOGO_DIR, exist_ok=True)

    status = fetch(args.season, params=[("view", "mStatus")])["status"]
    seasons = sorted(set(status.get("previousSeasons", [])) | {args.season}, reverse=True)
    names = member_directory(seasons)

    built = []
    for season in seasons:
        data = build_season(season, season == args.season, names)
        stats_blob = data.pop("_stats", {})
        write_js(os.path.join(DATA_DIR, "%d.js" % season), "LEAGUE_DATA", season, data)
        # player stat lines load only when someone opens a player, so they live in their own file
        write_js(os.path.join(DATA_DIR, "%d-stats.js" % season), "LEAGUE_STATS", season, stats_blob)
        built.append(data)
        print("  wrote data/%d.js (%d KB)" % (season, os.path.getsize(os.path.join(DATA_DIR, "%d.js" % season)) // 1024))

    current = next(d for d in built if d["league"]["season"] == args.season)
    current_members = {o for t in current["teams"] for o in t["owners"]}
    index = {"seasons": seasons, "current": args.season, "name": current["league"]["name"],
             "updated": current["updated"], "build": (os.environ.get("GITHUB_SHA") or "dev")[:7],
             "history": build_history(built, names, current_members)}
    with open(os.path.join(DATA_DIR, "index.js"), "w") as f:
        f.write("window.LEAGUE_INDEX=")
        json.dump(index, f, separators=(",", ":"))
        f.write(";\n")
    print("Wrote data/index.js: seasons %s, %d members all-time" % (seasons, len(index["history"]["members"])))


if __name__ == "__main__":
    main()
