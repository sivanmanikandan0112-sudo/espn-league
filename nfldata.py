"""NFL usage data from nflverse (public files, refreshed about daily), matched to ESPN player ids.

Three things, for the current season only:
  - expected fantasy points (ffverse ffopportunity): what each player's usage (targets, carries, air yards, where on
    the field) should have scored, vs. what he scored, in the model's own PPR scoring. Per player (last 5 games, for
    the "due" / "hot" tags) and per league team (its starters, regular season, for Insights -> Luck -> Vs. usage).
  - role: snap share (Pro Football Reference via nflverse) and target share, the last 4 weeks, with a "role up" /
    "role down" flag when the last 2 games differ clearly from the 3 before.
  - practice: this week's official injury report (practice participation, game status, injury). nflverse keeps one
    practice status per player per week (the latest), so the build keeps its own log of how it changed day to day,
    carried over from the previous build (data/practice.json, which the live worker also reads for alerts).

Everything here is best effort: if a file can't be downloaded the site simply goes without that part.
"""
import csv
import datetime as dt
import io
import urllib.request
from collections import defaultdict
from zoneinfo import ZoneInfo

NFLVERSE = "https://github.com/nflverse/nflverse-data/releases/download/"
URLS = {
    "ep": "https://github.com/ffverse/ffopportunity/releases/download/latest-data/ep_weekly_%d.csv",
    "injuries": NFLVERSE + "injuries/injuries_%d.csv",
    "snaps": NFLVERSE + "snap_counts/snap_counts_%d.csv",
    "stats": NFLVERSE + "stats_player/stats_player_week_%d.csv",
    "ids": "https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv",
}
PRACTICE = {"Did Not Participate In Practice": "DNP", "Limited Participation in Practice": "LP",
            "Full Participation in Practice": "FP"}
SKILL = {"QB", "RB", "WR", "TE"}
ET = ZoneInfo("America/New_York")

# "due" / "hot": over the last 5 weeks, at least 3 games, averaging 3+ points a game away from what the usage was
# worth, for players who matter (8+ expected or actual points a game)
TAG_GAMES, TAG_WINDOW, TAG_GAP, TAG_MIN = 3, 5, 3.0, 8.0
# role up / down: the last 2 games vs. the 3 before (snap share in points of 100, target share likewise)
ROLE_SNAP, ROLE_TGT = 15, 8


def _csv(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "espn-league-site"})
        with urllib.request.urlopen(req, timeout=90) as r:
            text = r.read().decode("utf-8")
        return list(csv.DictReader(io.StringIO(text)))
    except Exception as e:  # noqa: BLE001 - optional data, never break the build
        print("  nflverse: couldn't load %s (%s)" % (url.rsplit("/", 1)[-1], e))
        return None


def _f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def build(season, wanted_ids, weeks, current_week, regular_weeks, prev_practice, now=None):
    """wanted_ids: ESPN ids to keep per-player data for (rosters + free agents). weeks: the season's weekly matchups
    (for team usage). Returns (nfl data for the season file, practice file) or (None, None) if nothing loaded."""
    ids = _csv(URLS["ids"])
    if not ids:
        return None, None
    gsis, pfr = {}, {}
    for r in ids:
        e = (r.get("espn_id") or "").strip()
        if not e.isdigit():
            continue
        if r.get("gsis_id"):
            gsis[r["gsis_id"]] = int(e)
        if r.get("pfr_id"):
            pfr[r["pfr_id"]] = int(e)
    wanted = {int(x) for x in wanted_ids}
    players = defaultdict(dict)

    # -- expected fantasy points
    ep = _csv(URLS["ep"] % season) or []
    by_player = defaultdict(dict)  # espn id -> week -> [pts, expected, tds, expected tds]
    for r in ep:
        e = gsis.get(r.get("player_id"))
        wk = _f(r.get("week"))
        fp, xfp = _f(r.get("total_fantasy_points")), _f(r.get("total_fantasy_points_exp"))
        if e is None or wk is None or fp is None or xfp is None or wk > current_week:
            continue
        by_player[e][int(wk)] = [round(fp, 1), round(xfp, 1), _f(r.get("total_touchdown")) or 0.0, _f(r.get("total_touchdown_exp")) or 0.0]
    for e, wks in by_player.items():
        if e not in wanted:
            continue
        recent = [wks[w] for w in sorted(wks) if w > current_week - TAG_WINDOW - 1][-TAG_WINDOW:]
        x = {"x": [[w, wks[w][0], wks[w][1]] for w in sorted(wks)][-6:]}
        if len(recent) >= TAG_GAMES:
            fp = sum(r[0] for r in recent) / len(recent)
            xfp = sum(r[1] for r in recent) / len(recent)
            x["avg"] = [round(fp, 1), round(xfp, 1), len(recent)]
            if max(fp, xfp) >= TAG_MIN and abs(fp - xfp) >= TAG_GAP:
                x["tag"] = "due" if fp < xfp else "hot"
        players[e].update(x)

    # -- team usage: each league team's starters, regular season, final weeks
    teams = {}
    for w in weeks:
        if not w.get("final") or w["week"] > regular_weeks:
            continue
        for g in w["games"]:
            for s in g["sides"]:
                t = teams.setdefault(s["team"], {"fp": 0.0, "xfp": 0.0, "td": 0.0, "tdx": 0.0, "games": 0, "p": defaultdict(lambda: [0.0, 0, ""])})
                for p in s["lineup"]:
                    if p["slot"] in ("BE", "IR") or p["pos"] not in SKILL:
                        continue
                    row = by_player.get(int(p["id"]), {}).get(w["week"])
                    if not row:
                        continue
                    t["fp"] += row[0]; t["xfp"] += row[1]; t["td"] += row[2]; t["tdx"] += row[3]; t["games"] += 1
                    pp = t["p"][p["id"]]
                    pp[0] += row[0] - row[1]; pp[1] += 1; pp[2] = p["name"]
    team_out = {}
    for tid, t in teams.items():
        if not t["games"]:
            continue
        ranked = sorted(t["p"].values(), key=lambda v: v[0])
        team_out[tid] = {"fp": round(t["fp"], 1), "xfp": round(t["xfp"], 1), "diff": round(t["fp"] - t["xfp"], 1),
                         "td": round(t["td"], 1), "tdx": round(t["tdx"], 1), "games": t["games"],
                         "over": [ranked[-1][2], round(ranked[-1][0], 1)] if ranked and ranked[-1][0] > 0 else None,
                         "under": [ranked[0][2], round(ranked[0][0], 1)] if ranked and ranked[0][0] < 0 else None}

    # -- role: snap share and target share
    snaps = defaultdict(dict)
    for r in _csv(URLS["snaps"] % season) or []:
        e = pfr.get(r.get("pfr_player_id"))
        wk, pct = _f(r.get("week")), _f(r.get("offense_pct"))
        if e in wanted and wk is not None and pct is not None and wk <= current_week and r.get("game_type", "REG") in ("REG", "WC", "DIV", "CON", "SB"):
            snaps[e][int(wk)] = round(pct * 100 if pct <= 1 else pct)
    tshare = defaultdict(dict)
    for r in _csv(URLS["stats"] % season) or []:
        e = gsis.get(r.get("player_id"))
        wk, ts = _f(r.get("week")), _f(r.get("target_share"))
        if e in wanted and wk is not None and ts is not None and wk <= current_week:
            tshare[e][int(wk)] = round(ts * 100)
    qbs = {gsis[r["player_id"]] for r in ep if r.get("position") == "QB" and r.get("player_id") in gsis}
    for e in set(snaps) | set(tshare):
        wks = sorted(set(snaps[e]) | set(tshare[e]))
        if not wks:
            continue
        players[e]["u"] = [[w, snaps[e].get(w), tshare[e].get(w)] for w in wks][-4:]
        sw = sorted(snaps[e])
        last, before = sw[-2:], sw[-5:-2]
        if len(last) == 2 and len(before) >= 2 and e not in qbs:  # a QB's snaps say nothing about his role
            avg = lambda d, ks: sum(d[k] for k in ks) / len(ks)  # noqa: E731
            s_now, s_then = avg(snaps[e], last), avg(snaps[e], before)
            t_now = avg(tshare[e], [k for k in last if k in tshare[e]]) if any(k in tshare[e] for k in last) else None
            t_then = avg(tshare[e], [k for k in before if k in tshare[e]]) if any(k in tshare[e] for k in before) else None
            up = (s_now - s_then >= ROLE_SNAP and s_now >= 45) or (t_now is not None and t_then is not None and t_now - t_then >= ROLE_TGT and t_now >= 15)
            down = (s_then - s_now >= ROLE_SNAP and s_then >= 50) or (t_now is not None and t_then is not None and t_then - t_now >= ROLE_TGT and t_then >= 18)
            if up != down:
                players[e]["role"] = "up" if up else "down"
                players[e]["roleWhy"] = [round(s_then), round(s_now), round(t_then) if t_then is not None else None, round(t_now) if t_now is not None else None]

    # -- practice: this week's report, with a day-by-day log carried from the previous build
    now = now or dt.datetime.now(dt.timezone.utc)
    day = (now.astimezone(ET) - dt.timedelta(hours=14)).strftime("%a")  # the file each morning covers the day before
    prev = prev_practice if prev_practice and prev_practice.get("season") == season and prev_practice.get("week") == current_week else {}
    prev_log = (prev or {}).get("players", {})
    practice = {}
    for r in _csv(URLS["injuries"] % season) or []:
        e = gsis.get(r.get("gsis_id"))
        wk = _f(r.get("week"))
        if e is None or wk is None or int(wk) != current_week:
            continue
        s = PRACTICE.get(r.get("practice_status") or "")
        g = (r.get("report_status") or "").strip() or None
        if not s and not g:
            continue
        log = [list(x) for x in (prev_log.get(str(e), {}).get("log") or [])]
        if s and (not log or log[-1][1] != s):
            log.append([day, s])
        practice[str(e)] = {"s": s, "g": g, "i": (r.get("practice_primary_injury") or r.get("report_primary_injury") or "").strip() or None, "log": log[-4:]}
    for e, v in practice.items():
        if int(e) in wanted:
            players[int(e)]["pr"] = v

    if not players and not team_out:
        return None, None
    nfl = {"week": current_week, "asOf": now.isoformat(), "players": {str(k): v for k, v in players.items()}, "teams": team_out}
    return nfl, {"season": season, "week": current_week, "asOf": now.isoformat(), "players": practice}
