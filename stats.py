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
    games_left = defaultdict(int)
    for _, h, a in schedule:
        games_left[h] += 1; games_left[a] += 1
    by_wins = {tid: defaultdict(lambda: [0, 0]) for tid in teams}  # remaining wins -> [sims, made playoffs]
    seeds = {tid: [0] * len(teams) for tid in teams}

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
        won = defaultdict(int)
        for week, home, away in schedule:
            sh, sa = draw(home, week), draw(away, week)
            pf[home] += sh; pf[away] += sa
            winner = home if sh > sa else away
            wins[winner] += 1
            won[winner] += 1
        order = sorted(teams, key=lambda tid: (-wins[tid], -pf[tid]))
        for i, tid in enumerate(order):
            tally[tid]["wins"] += wins[tid]
            tally[tid]["seed"] += i + 1
            seeds[tid][i] += 1
            b = by_wins[tid][won[tid]]
            b[0] += 1
            b[1] += 1 if i < playoff_teams else 0
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
    out = {}
    for tid, v in tally.items():
        cond = {}
        for k in range(games_left[tid] + 1):
            sims, made = by_wins[tid].get(k, [0, 0])
            # how often this team wins exactly k more games, and its playoff odds when it does
            cond[k] = {"chance": round(100 * sims / n, 1), "playoffPct": round(100 * made / sims, 1) if sims >= 30 else None}
        out[tid] = {"playoffPct": round(100 * v["playoffs"] / n, 1), "byePct": round(100 * v["bye"] / n, 1),
                    "titlePct": round(100 * v["title"] / n, 1), "projWins": round(v["wins"] / n, 1),
                    "avgSeed": round(v["seed"] / n, 1), "gamesLeft": games_left[tid], "byWins": cond,
                    "seeds": [round(100 * c / n, 1) for c in seeds[tid]]}
    return out


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


# ---------------------------------------------------------------- roster movement helpers

def ownership(season, final_only=True):
    """week -> {player id: (team, started, pts)} from the weekly box scores."""
    own = {}
    for w in season["weeks"]:
        if final_only and not w["final"]:
            continue
        m = {}
        for g in w["games"]:
            for s in g["sides"]:
                for p in s["lineup"]:
                    m[p["id"]] = (s["team"], is_starter(p), p["pts"])
        own[w["week"]] = m
    return own


def _stint(own, weeks, pid, team, start):
    """Started points / starts / total points for a player from `start` while he stays on `team`."""
    started = total = 0.0
    starts = 0
    for w in weeks:
        if w < start:
            continue
        x = own[w].get(pid)
        if not x or x[0] != team:
            break
        total += x[2]
        if x[1]:
            started += x[2]; starts += 1
    return round(started, 1), starts, round(total, 1)


# ---------------------------------------------------------------- waiver MVPs

def waiver_pickups(season):
    """A pickup = a player on a team this week who wasn't on anyone's roster the week before.
    Credit = points he scored in that team's starting lineup until he left it."""
    rs = season["league"]["regularSeasonWeeks"]
    own = ownership(season)
    weeks = sorted(w for w in own if w <= rs)
    picks = []
    for prev, w in zip(weeks, weeks[1:]):
        for pid, (team, _, _) in own[w].items():
            if pid in own[prev]:
                continue
            started, starts, total = _stint(own, weeks, pid, team, w)
            picks.append({"id": pid, "team": team, "week": w, "started": started, "starts": starts, "total": total})
    by_team = defaultdict(lambda: {"started": 0.0, "pickups": 0})
    for p in picks:
        by_team[p["team"]]["started"] += p["started"]
        by_team[p["team"]]["pickups"] += 1
    return picks, {t: {"started": round(v["started"], 1), "pickups": v["pickups"]} for t, v in by_team.items()}


# ---------------------------------------------------------------- trade grades

def grade_trades(season, trades):
    """Points each side got from the players it received, while they stayed on that team.
    'Started' counts only weeks the player was in the starting lineup."""
    own = ownership(season)
    weeks = sorted(own)

    def arrival(pid, to, frm, not_before):
        """First week the player shows up on `to` (preferably straight from `frm`) at or after not_before."""
        moves = [(prev, w) for prev, w in zip(weeks, weeks[1:])
                 if w >= not_before and own[w].get(pid, (None,))[0] == to and own[prev].get(pid, (None,))[0] != to]
        direct = [w for prev, w in moves if own[prev].get(pid, (None,))[0] == frm]
        return (direct or [w for _, w in moves] or [None])[0]

    for tr in trades:
        known = tr.get("week")
        starts = []
        for side in tr["sides"]:
            for p in side["gets"]:
                p["_start"] = arrival(p.get("id"), side["team"], p.get("from"), (known - 1) if known else 0)
                if p["_start"]:
                    starts.append(p["_start"])
        tr["week"] = known or (min(starts) if starts else None)
        for side in tr["sides"]:
            side["started"] = side["total"] = 0.0
            for p in side["gets"]:
                start = p.pop("_start")
                if start is None:
                    p["started"], p["starts"], p["total"] = 0.0, 0, 0.0
                    continue
                p["started"], p["starts"], p["total"] = _stint(own, weeks, p["id"], side["team"], start)
                side["started"] = round(side["started"] + p["started"], 1)
                side["total"] = round(side["total"] + p["total"], 1)
        tr["weeksSince"] = len([w for w in weeks if tr["week"] and w >= tr["week"]])
    return trades


# ---------------------------------------------------------------- schedule & consistency

def team_scores(season):
    out = defaultdict(list)  # team -> [(week, pts, opp_team, opp_pts)]
    for w in regular_weeks(season):
        for g in w["games"]:
            if len(g["sides"]) != 2:
                continue
            a, b = g["sides"]
            out[a["team"]].append((w["week"], a["pts"], b["team"], b["pts"]))
            out[b["team"]].append((w["week"], b["pts"], a["team"], a["pts"]))
    return out


def schedule_strength(season, remaining=None, strength=None):
    """Past SOS = average scoring (ppg) of the opponents a team has faced; 'faced' = how much those
    opponents actually scored against them. Remaining SOS = average projected strength of opponents left."""
    sc = team_scores(season)
    ppg = {t: sum(x[1] for x in v) / len(v) for t, v in sc.items() if v}
    league = sum(ppg.values()) / len(ppg) if ppg else 0
    out = {}
    for t, games in sc.items():
        if not games:
            continue
        opp_ppg = sum(ppg.get(o, league) for _, _, o, _ in games) / len(games)
        faced = sum(op for _, _, _, op in games) / len(games)
        out[t] = {"oppPpg": round(opp_ppg, 1), "oppVsAvg": round(opp_ppg - league, 1),
                  "faced": round(faced, 1), "facedVsAvg": round(faced - league, 1)}
    if remaining and strength:
        avg = sum(s["mean"] for s in strength.values()) / len(strength)
        left = defaultdict(list)
        for _, h, a in remaining:
            left[h].append(strength[a]["mean"]); left[a].append(strength[h]["mean"])
        for t, opps in left.items():
            out.setdefault(t, {})
            out[t]["remaining"] = len(opps)
            out[t]["remainingVsAvg"] = round(sum(opps) / len(opps) - avg, 1)
    for key in ("oppVsAvg", "remainingVsAvg"):
        ranked = sorted((t for t in out if key in out[t]), key=lambda t: -out[t][key])
        for i, t in enumerate(ranked):
            out[t][key + "Rank"] = i + 1  # 1 = toughest
    return out


def consistency(season, close=10.0):
    sc = team_scores(season)
    out = {}
    for t, games in sc.items():
        pts = [g[1] for g in games]
        if not pts:
            continue
        cw = sum(1 for g in games if abs(g[1] - g[3]) < close and g[1] > g[3])
        cl = sum(1 for g in games if abs(g[1] - g[3]) < close and g[1] < g[3])
        out[t] = {"avg": round(statistics.mean(pts), 1), "median": round(statistics.median(pts), 1),
                  "floor": round(min(pts), 1), "ceiling": round(max(pts), 1),
                  "sd": round(statistics.pstdev(pts), 1) if len(pts) > 1 else 0.0,
                  "closeW": cw, "closeL": cl}
    return out


# ---------------------------------------------------------------- draft review

def draft_review(picks, players, rank_pool, pos_window=2):
    """picks: ESPN draft picks. players: id -> {name, pos, team, pts}. rank_pool: pos -> sorted desc season pts
    of the wider player pool (to place each pick's finish). Value = points scored minus the average of
    players at the same position drafted within ±pos_window positional slots (K and D/ST excluded)."""
    rows = []
    for p in sorted(picks, key=lambda p: p["overallPickNumber"]):
        info = players.get(p["playerId"], {"name": "Player #%s" % p["playerId"], "pos": "?", "team": "", "pts": 0.0})
        rows.append({"pick": p["overallPickNumber"], "round": p["roundId"], "roundPick": p["roundPickNumber"],
                     "team": p["teamId"], "id": p["playerId"], "name": info["name"], "pos": info["pos"],
                     "nfl": info["team"], "pts": round(info["pts"], 1), "keeper": bool(p.get("keeper"))})
    skill = [r for r in rows if r["pos"] not in ("K", "D/ST")]
    seen = defaultdict(int)
    for r in rows:
        seen[r["pos"]] += 1
        r["draftPosRank"] = seen[r["pos"]]
        pool = rank_pool.get(r["pos"], [])
        r["finishPosRank"] = 1 + sum(1 for x in pool if x > r["pts"] + 1e-9)
    for r in skill:
        # compare against players at the same position taken around the same positional slot
        # (QB18 vs QBs drafted 16th-20th), so high-scoring positions don't look like steals by default
        near = [x["pts"] for x in skill if x["pos"] == r["pos"] and abs(x["draftPosRank"] - r["draftPosRank"]) <= pos_window]
        r["expected"] = round(sum(near) / len(near), 1)
        r["value"] = round(r["pts"] - r["expected"], 1)
    teams = defaultdict(lambda: {"value": 0.0, "pts": 0.0, "picks": 0})
    for r in skill:
        teams[r["team"]]["value"] += r["value"]
        teams[r["team"]]["pts"] += r["pts"]
        teams[r["team"]]["picks"] += 1
    order = sorted(teams, key=lambda t: -teams[t]["value"])
    letters = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "F"]
    for i, t in enumerate(order):
        teams[t]["rank"] = i + 1
        teams[t]["grade"] = letters[min(len(letters) - 1, int(i * len(letters) / len(order)))]
        teams[t]["value"] = round(teams[t]["value"], 1)
        teams[t]["pts"] = round(teams[t]["pts"], 1)
    early = [r for r in skill if r["round"] <= 8]
    return {"picks": rows, "teams": dict(teams),
            "steals": [r["pick"] for r in sorted(skill, key=lambda r: -r["value"])[:6]],
            "busts": [r["pick"] for r in sorted(early, key=lambda r: r["value"])[:6]]}
