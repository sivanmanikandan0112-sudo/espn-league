"""Season analytics built from weekly box scores: all-play/luck, lineup efficiency,
weekly recaps, and playoff odds."""
import random
import statistics
from collections import defaultdict

# Which player positions each ESPN lineup slot accepts.
SLOT_ELIGIBLE = {
    0: {"QB"}, 2: {"RB"}, 4: {"WR"}, 6: {"TE"}, 16: {"D/ST"}, 17: {"K"},
    3: {"RB", "WR"}, 5: {"WR", "TE"}, 23: {"RB", "WR", "TE"}, 7: {"QB", "RB", "WR", "TE"},
}
STARTING_SLOTS = ("QB", "RB", "WR", "TE", "FLEX", "D/ST", "K", "RB/WR", "WR/TE", "OP")


def is_starter(p):
    return p["slot"] not in ("BE", "IR")


def optimal_points(lineup, slot_counts):
    """Best possible starting score from the players a team had that week (hindsight)."""
    slots = []
    for sid, n in slot_counts.items():
        if sid in SLOT_ELIGIBLE:
            slots += [SLOT_ELIGIBLE[sid]] * n
    slots.sort(key=len)  # fill the most restrictive slots first
    pool = sorted(lineup, key=lambda p: -p["pts"])
    used, total = set(), 0.0
    for elig in slots:
        for p in pool:
            if p["id"] not in used and p["pos"] in elig:
                used.add(p["id"]); total += p["pts"]
                break
    return total


def regular_weeks(season):
    rs = season["league"]["regularSeasonWeeks"]
    return [w for w in season["weeks"] if w["week"] <= rs and w["final"]]


def all_play_and_luck(season):
    """All-play: every week, each team 'plays' every other team. Luck = actual wins - expected."""
    out = defaultdict(lambda: {"apW": 0.0, "apL": 0.0, "games": 0, "wins": 0.0})
    for w in regular_weeks(season):
        scores = [(s["team"], s["pts"]) for g in w["games"] for s in g["sides"]]
        for team, pts in scores:
            for other, opp in scores:
                if other == team:
                    continue
                if pts > opp:
                    out[team]["apW"] += 1
                elif pts < opp:
                    out[team]["apL"] += 1
                else:
                    out[team]["apW"] += 0.5; out[team]["apL"] += 0.5
        for g in w["games"]:
            if len(g["sides"]) != 2:
                continue
            a, b = g["sides"]
            for me, opp in ((a, b), (b, a)):
                out[me["team"]]["games"] += 1
                out[me["team"]]["wins"] += 1 if me["pts"] > opp["pts"] else 0.5 if me["pts"] == opp["pts"] else 0
    result = {}
    for team, r in out.items():
        total = r["apW"] + r["apL"]
        pct = r["apW"] / total if total else 0
        expected = pct * r["games"]
        result[team] = {"allPlayW": round(r["apW"]), "allPlayL": round(r["apL"]), "allPlayPct": round(pct, 3),
                        "expectedWins": round(expected, 1), "luck": round(r["wins"] - expected, 1)}
    return result


def efficiency(season, slot_counts):
    """Points actually started vs. the best possible lineup, regular season."""
    agg = defaultdict(lambda: {"actual": 0.0, "optimal": 0.0})
    per_week = {}
    for w in regular_weeks(season):
        for g in w["games"]:
            for s in g["sides"]:
                if not s["lineup"]:
                    continue
                actual = sum(p["pts"] for p in s["lineup"] if is_starter(p))
                best = max(optimal_points(s["lineup"], slot_counts), actual)
                agg[s["team"]]["actual"] += actual
                agg[s["team"]]["optimal"] += best
                per_week[(w["week"], s["team"])] = (actual, best)
    result = {}
    for team, a in agg.items():
        result[team] = {"efficiency": round(100 * a["actual"] / a["optimal"], 1) if a["optimal"] else None,
                        "benchLeft": round(a["optimal"] - a["actual"], 1)}
    return result, per_week


def weekly_recaps(season, per_week_eff, team_names):
    recaps = {}
    for w in season["weeks"]:
        if not w["final"]:
            continue
        sides = [s for g in w["games"] for s in g["sides"]]
        if not sides:
            continue
        games = [g for g in w["games"] if len(g["sides"]) == 2]
        hi = max(sides, key=lambda s: s["pts"])
        lo = min(sides, key=lambda s: s["pts"])
        r = {"high": {"team": hi["team"], "pts": hi["pts"]}, "low": {"team": lo["team"], "pts": lo["pts"]}}
        if games:
            margin = lambda g: abs(g["sides"][0]["pts"] - g["sides"][1]["pts"])
            for key, g in (("blowout", max(games, key=margin)), ("closest", min(games, key=margin))):
                win, lose = sorted(g["sides"], key=lambda s: -s["pts"])
                r[key] = {"winner": win["team"], "loser": lose["team"], "winPts": win["pts"],
                          "losePts": lose["pts"], "margin": round(margin(g), 2)}
        starters = [(p, s["team"]) for s in sides for p in s["lineup"] if is_starter(p)]
        if starters:
            p, team = max(starters, key=lambda x: x[0]["pts"])
            r["topPlayer"] = {"name": p["name"], "pos": p["pos"], "pts": p["pts"], "team": team}
        bench = [(p, s["team"]) for s in sides for p in s["lineup"] if not is_starter(p) and p["slot"] != "IR"]
        if bench:
            p, team = max(bench, key=lambda x: x[0]["pts"])
            r["benchStar"] = {"name": p["name"], "pos": p["pos"], "pts": p["pts"], "team": team}
        left = [(team, best - act) for (wk, team), (act, best) in per_week_eff.items() if wk == w["week"]]
        if left:
            team, pts = max(left, key=lambda x: x[1])
            r["mostLeft"] = {"team": team, "pts": round(pts, 2)}
        recaps[w["week"]] = r
    return recaps


# ---------------- playoff odds ----------------

PLAYOFF_SIMS = 10000
PLAYOFF_SEED = 7
# Half a season of scores is a noisy read on how good a team really is, so each team's estimated
# weekly strength is pulled this far back toward the league average before simulating.
STRENGTH_SHRINK = 0.5


def playoff_odds(season, schedule, team_strength):
    """Monte Carlo the rest of the regular season and the playoff bracket.

    schedule: [(week, home, away)] for every regular-season game not yet final.
    team_strength: team -> {"mean": weekly mean, "sd": weekly sd, "live": {week: (mean, sd)}}
    """
    lg = season["league"]
    teams = {t["id"]: t for t in season["teams"]}
    playoff_teams = lg["playoffTeams"]
    rounds = max(1, lg["playoffRounds"])
    byes = max(0, 2 ** rounds - playoff_teams)
    rng = random.Random(PLAYOFF_SEED)
    tally = {tid: {"playoffs": 0, "bye": 0, "title": 0, "wins": 0.0, "seed": 0.0} for tid in teams}

    def draw(tid, week):
        st = team_strength[tid]
        mean, sd = st["live"].get(week, (st["mean"], st["sd"]))
        return rng.gauss(mean, sd)

    def play(a, b):
        sa, sb = rng.gauss(team_strength[a]["mean"], team_strength[a]["sd"]), rng.gauss(team_strength[b]["mean"], team_strength[b]["sd"])
        return a if sa >= sb else b

    for _ in range(PLAYOFF_SIMS):
        wins = {tid: t["wins"] + t["ties"] / 2 for tid, t in teams.items()}
        pf = {tid: t["pf"] for tid, t in teams.items()}
        for week, home, away in schedule:
            sh, sa = draw(home, week), draw(away, week)
            pf[home] += sh; pf[away] += sa
            if sh > sa:
                wins[home] += 1
            else:
                wins[away] += 1
        order = sorted(teams, key=lambda tid: (-wins[tid], -pf[tid]))
        for i, tid in enumerate(order):
            tally[tid]["wins"] += wins[tid]
            tally[tid]["seed"] += i + 1
        field = order[:playoff_teams]
        for i, tid in enumerate(field):
            tally[tid]["playoffs"] += 1
            if i < byes:
                tally[tid]["bye"] += 1
        # bracket, reseeded each round: best remaining seed plays the worst
        seed_of = {tid: i for i, tid in enumerate(field)}
        alive, waiting = field[byes:], field[:byes]
        while len(alive) + len(waiting) > 1:
            alive.sort(key=lambda t: seed_of[t])
            nxt = [play(alive[i], alive[-1 - i]) for i in range(len(alive) // 2)]
            if len(alive) % 2:
                nxt.append(alive[len(alive) // 2])
            alive, waiting = sorted(nxt + waiting, key=lambda t: seed_of[t]), []
        tally[alive[0]]["title"] += 1

    n = float(PLAYOFF_SIMS)
    return {tid: {"playoffPct": round(100 * v["playoffs"] / n, 1), "byePct": round(100 * v["bye"] / n, 1),
                  "titlePct": round(100 * v["title"] / n, 1), "projWins": round(v["wins"] / n, 1),
                  "avgSeed": round(v["seed"] / n, 1)}
            for tid, v in tally.items()}


def team_strengths(season, power_by_team, power_weeks, live_week_proj):
    """Weekly scoring model per team: blend season scoring with projected lineup strength."""
    scores = defaultdict(list)
    kdst = defaultdict(list)
    for w in regular_weeks(season):
        for g in w["games"]:
            for s in g["sides"]:
                scores[s["team"]].append(s["pts"])
                kdst[s["team"]].append(sum(p["pts"] for p in s["lineup"] if is_starter(p) and p["pos"] in ("K", "D/ST")))
    all_scores = [x for v in scores.values() for x in v]
    league_sd = statistics.pstdev(all_scores) if all_scores else 25.0
    league_avg = statistics.mean(all_scores) if all_scores else 0.0
    out = {}
    for t in season["teams"]:
        tid = t["id"]
        hist = scores.get(tid) or [0.0]
        ppg = sum(hist) / len(hist)
        mean = ppg
        if tid in power_by_team and power_weeks:
            projected = power_by_team[tid] / power_weeks + (sum(kdst[tid]) / len(kdst[tid]) if kdst.get(tid) else 0)
            mean = 0.5 * ppg + 0.5 * projected
        if all_scores:
            mean = league_avg + (1 - STRENGTH_SHRINK) * (mean - league_avg)
        sd = statistics.pstdev(hist) if len(hist) > 2 else league_sd
        sd = max(15.0, 0.5 * sd + 0.5 * league_sd)
        out[tid] = {"mean": mean, "sd": sd, "live": {}}
        if tid in live_week_proj:
            week, proj = live_week_proj[tid]
            out[tid]["live"][week] = (proj, 12.0)
    return out
