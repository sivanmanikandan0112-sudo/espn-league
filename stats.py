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
    team_strength: team -> {"mean": weekly mean, "sd": weekly sd, "live": {week: (mean, sd, win_prob)}}
    For the week in progress, the winner is drawn from ESPN's live win probability (which knows how much of
    each lineup has already played); points for the tiebreaker come from the live projection.
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

    def draw(tid, week):
        st = team_strength[tid]
        mean, sd = st["live"].get(week, (st["mean"], st["sd"], None))[:2]
        return rng.gauss(mean, sd)

    def live_win_prob(home, away, week):
        h, a = team_strength[home]["live"].get(week), team_strength[away]["live"].get(week)
        if h and a and h[2] is not None and a[2] is not None and h[2] + a[2] > 0:
            return h[2] / (h[2] + a[2])
        return None

    def play(a, b):
        sa, sb = rng.gauss(team_strength[a]["mean"], team_strength[a]["sd"]), rng.gauss(team_strength[b]["mean"], team_strength[b]["sd"])
        return a if sa >= sb else b

    for _ in range(PLAYOFF_SIMS):
        wins = {tid: t["wins"] + t["ties"] / 2 for tid, t in teams.items()}
        pf = {tid: t["pf"] for tid, t in teams.items()}
        for week, home, away in schedule:
            sh, sa = draw(home, week), draw(away, week)
            pf[home] += sh; pf[away] += sa
            wp = live_win_prob(home, away, week)
            if wp is not None:
                winner = home if rng.random() < wp else away
            else:
                winner = home if sh > sa else away
            wins[winner] += 1
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
                  "avgSeed": round(v["seed"] / n, 1), "gamesLeft": games_left[tid]}
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
            week, proj, scored, win_prob = live_week_proj[tid]
            # spread shrinks as the week is played out: only the unplayed share of the projection is uncertain
            unplayed = max(0.1, 1 - scored / proj) if proj else 1.0
            out[tid]["live"][week] = (proj, max(6.0, league_sd * unplayed ** 0.5), win_prob)
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


# ---------------------------------------------------------------- schedule swap

def schedule_swap(season):
    """Every team's record if it had played every other team's schedule (regular season, completed weeks).
    Team A on B's schedule: each week A's score vs. the score of B's opponent that week; when B's opponent
    was A itself, A plays B instead. The diagonal is each team's actual record."""
    sc = {}  # (week, team) -> (pts, opponent)
    for w in regular_weeks(season):
        for g in w["games"]:
            if len(g["sides"]) != 2:
                continue
            a, b = g["sides"]
            sc[(w["week"], a["team"])] = (a["pts"], b["team"])
            sc[(w["week"], b["team"])] = (b["pts"], a["team"])
    weeks = sorted({w for w, _ in sc})
    teams = sorted({t for _, t in sc})
    grid = {}
    for A in teams:
        grid[A] = {}
        for B in teams:
            w_ = l_ = t_ = 0
            for wk in weeks:
                if (wk, A) not in sc or (wk, B) not in sc:
                    continue
                mine = sc[(wk, A)][0]
                opp = sc[(wk, B)][1]
                if opp == A:
                    opp = B
                theirs = sc[(wk, opp)][0]
                if mine > theirs:
                    w_ += 1
                elif mine < theirs:
                    l_ += 1
                else:
                    t_ += 1
            grid[A][B] = [w_, l_, t_]
    return {"teams": teams, "weeks": len(weeks), "grid": {str(a): {str(b): v for b, v in row.items()} for a, row in grid.items()}}


# ---------------------------------------------------------------- hot & cold, vs. projection

def hot_and_cold(season, recent=3):
    """Each team's last few completed regular-season weeks against its own season average, adjusted for the
    league-wide change over those same weeks (byes and injuries move everyone's scoring together)."""
    sc = team_scores(season)
    all_weeks = sorted({g[0] for games in sc.values() for g in games})
    if len(all_weeks) < recent + 1:
        return {}
    last_weeks = set(all_weeks[-recent:])
    every = [g[1] for games in sc.values() for g in games]
    league_season = sum(every) / len(every)
    recent_pts = [g[1] for games in sc.values() for g in games if g[0] in last_weeks]
    league_last = sum(recent_pts) / len(recent_pts)
    out = {}
    for t, games in sc.items():
        games = sorted(games)
        last = [g for g in games if g[0] in last_weeks]
        if len(last) < recent:
            continue
        season_avg = sum(g[1] for g in games) / len(games)
        last_avg = sum(g[1] for g in last) / len(last)
        out[t] = {"seasonAvg": round(season_avg, 1), "lastAvg": round(last_avg, 1),
                  "change": round(last_avg - season_avg, 1),
                  "diff": round((last_avg - season_avg) - (league_last - league_season), 1),  # vs. the league's own swing
                  "leagueChange": round(league_last - league_season, 1),
                  "lastW": sum(1 for g in last if g[1] > g[3]), "lastL": sum(1 for g in last if g[1] < g[3]),
                  "weeks": [g[0] for g in last], "lastPts": [round(g[1], 1) for g in last]}
    return out


def vs_projection(season):
    """Actual points vs. ESPN's pre-game projection for the lineup each team started, regular season."""
    agg = {}
    for w in regular_weeks(season):
        for g in w["games"]:
            for s in g["sides"]:
                if not s.get("projected"):
                    continue
                a = agg.setdefault(s["team"], {"actual": 0.0, "proj": 0.0, "weeks": 0, "beat": 0, "best": None, "worst": None})
                d = s["pts"] - s["projected"]
                a["actual"] += s["pts"]; a["proj"] += s["projected"]; a["weeks"] += 1
                a["beat"] += 1 if d > 0 else 0
                if a["best"] is None or d > a["best"][1]:
                    a["best"] = [w["week"], round(d, 1)]
                if a["worst"] is None or d < a["worst"][1]:
                    a["worst"] = [w["week"], round(d, 1)]
    return {t: {"actual": round(a["actual"], 1), "proj": round(a["proj"], 1), "diff": round(a["actual"] - a["proj"], 1),
                "perWeek": round((a["actual"] - a["proj"]) / a["weeks"], 1), "weeks": a["weeks"], "beat": a["beat"],
                "best": a["best"], "worst": a["worst"]} for t, a in agg.items()}


# ---------------------------------------------------------------- rules lab

# ESPN's standard (non-PPR) scoring for offense and kickers. D/ST keeps the league's own rules in every version,
# and anything the league scores that isn't listed in LEAGUE_ONLY keeps its league value too.
STANDARD = {3: 0.04, 4: 4, 19: 2, 20: -2, 24: 0.1, 25: 6, 26: 2, 42: 0.1, 43: 6, 44: 2, 72: -2,
            80: 3, 77: 4, 74: 5, 85: -1, 86: 1}
# league rules standard scoring doesn't have (completions, receptions, long-TD bonuses, 50-59 / 60+ FG brackets,
# missed PAT): dropped and replaced by STANDARD
LEAGUE_ONLY = {1, 15, 35, 45, 53, 88, 198, 201}
RULE_VERSIONS = [
    ("actual", "Your league"), ("half", "Half-PPR"), ("ppr", "Full PPR"), ("standard", "Standard"),
    ("median", "+ median win"), ("bestball", "Best ball"),
]


def rescore(p, st, ppr):
    """A player's week under standard scoring plus `ppr` per catch. st = {r: raw stats, a: league points per stat}."""
    if p["pos"] == "D/ST" or not st:
        return p["pts"]
    raw, applied = st["r"], st["a"]
    pts = sum(v for k, v in applied.items() if int(k) not in LEAGUE_ONLY and int(k) not in STANDARD)
    pts += sum(raw.get(str(k), 0) * v for k, v in STANDARD.items())
    return pts + ppr * raw.get("53", 0)


def rules_lab(season, player_stats, slot_counts):
    """Every team's regular-season record (completed weeks) under other scoring and formats, same lineups."""
    weeks = regular_weeks(season)
    if not weeks:
        return None
    rec = {k: defaultdict(lambda: [0, 0, 0, 0.0]) for k, _ in RULE_VERSIONS}
    pos_pts = defaultdict(lambda: defaultdict(float))  # pos -> version -> points started

    def tally(ver, a, b, pa, pb):
        ra, rb = rec[ver][a], rec[ver][b]
        ra[3] += pa; rb[3] += pb
        if abs(pa - pb) < 1e-9:
            ra[2] += 1; rb[2] += 1
        elif pa > pb:
            ra[0] += 1; rb[1] += 1
        else:
            ra[1] += 1; rb[0] += 1

    for w in weeks:
        scores = {}
        for g in w["games"]:
            if len(g["sides"]) != 2:
                continue
            sc = []
            for s in g["sides"]:
                v = {"actual": 0.0, "half": 0.0, "ppr": 0.0, "standard": 0.0}
                for p in s["lineup"]:
                    if not is_starter(p):
                        continue
                    st = player_stats.get("%d|%d" % (w["week"], p["id"]))
                    std = rescore(p, st, 0)
                    catches = (st or {}).get("r", {}).get("53", 0) if p["pos"] != "D/ST" else 0
                    for ver, x in (("actual", p["pts"]), ("standard", std), ("half", std + 0.5 * catches), ("ppr", std + catches)):
                        v[ver] += x
                        pos_pts[p["pos"]][ver] += x
                v["bestball"] = optimal_points(s["lineup"], slot_counts)
                sc.append((s["team"], v))
                scores[s["team"]] = s["pts"]
            (a, va), (b, vb) = sc
            for ver in ("actual", "half", "ppr", "standard", "bestball"):
                tally(ver, a, b, va[ver], vb[ver])
            tally("median", a, b, va["actual"], vb["actual"])
        # + median: one more game each week against the league's middle score
        med = statistics.median(scores.values())
        for t, pts in scores.items():
            r = rec["median"][t]
            r[0 if pts > med else 1 if pts < med else 2] += 1
    out = []
    for ver, name in RULE_VERSIONS:
        out.append({"key": ver, "name": name,
                    "teams": {t: [r[0], r[1], r[2], round(r[3], 2)] for t, r in rec[ver].items()}})
    return {"weeks": len(weeks), "versions": out,
            "positions": {pos: {k: round(v, 1) for k, v in d.items()} for pos, d in pos_pts.items()}}


# ---------------------------------------------------------------- hindsight redraft

def hindsight_redraft(draft, players, slot_counts, n_teams):
    """Re-run the draft knowing how the season went. Value = season points minus the replacement level at the
    position (the best player left over once every team's starting lineup is filled with season totals).
    draft: draft_review output. players: id -> {name, pos, team, pts} for the whole player pool."""
    slots = []
    for sid, n in slot_counts.items():
        if sid in SLOT_ELIGIBLE:
            slots += [SLOT_ELIGIBLE[sid]] * (n * n_teams)
    slots.sort(key=len)
    pool = sorted(((pid, x) for pid, x in players.items() if x["pos"] not in ("?",)), key=lambda kv: -kv[1]["pts"])
    used = set()
    for elig in slots:
        for pid, x in pool:
            if pid not in used and x["pos"] in elig:
                used.add(pid)
                break
    repl = {}
    for pid, x in pool:
        if pid not in used and x["pos"] not in repl:
            repl[x["pos"]] = x["pts"]
    vor = {pid: x["pts"] - repl.get(x["pos"], 0.0) for pid, x in pool}
    # kickers and defenses aren't redrafted (their season totals overrate them: good weeks are easy to stream),
    # so the redraft fills the real draft's other pick slots in order with the most valuable players left
    picks = draft["picks"]
    slots_at = [p["pick"] for p in picks if p["pos"] not in ("K", "D/ST")]
    ranked = sorted((pid for pid in vor if players[pid]["pos"] not in ("K", "D/ST")), key=lambda pid: -vor[pid])
    new_at = {pid: slots_at[i] for i, pid in enumerate(ranked[:len(slots_at)])}
    drafted_at = {p["id"]: p["pick"] for p in picks}
    team_of = {p["id"]: p["team"] for p in picks}

    def card(pid):
        x = players[pid]
        return {"id": pid, "name": x["name"], "pos": x["pos"], "nfl": x.get("team", ""), "pts": round(x["pts"], 1),
                "value": round(vor[pid], 1), "at": new_at[pid], "pick": drafted_at.get(pid), "team": team_of.get(pid)}

    rows = [{"pick": p["pick"], "at": new_at.get(p["id"]), "value": round(vor[p["id"]], 1) if p["id"] in vor else None}
            for p in picks if p["pos"] not in ("K", "D/ST")]
    return {"board": [card(pid) for pid in ranked[:len(slots_at)]], "picks": rows,
            "replacement": {k: round(v, 1) for k, v in repl.items()}}


# ---------------------------------------------------------------- player passport

def player_passport(seasons_data):
    """Every player's stints on league teams across all seasons: when, how he arrived and left, and the points he
    scored there (started = counted in the lineup). Written to its own file, loaded when a player is opened."""
    players, teams = {}, {}
    for data in sorted(seasons_data, key=lambda d: d["league"]["season"]):
        yr = data["league"]["season"]
        for t in data["teams"]:
            teams["%d|%d" % (yr, t["id"])] = [t["name"], t["owners"]]
        own = ownership(data, final_only=False)
        weeks = sorted(own)
        if not weeks:
            continue
        last = weeks[-1]
        done = data["league"]["over"]
        drafted = {p["id"]: p for p in (data.get("draft") or {}).get("picks", [])}
        traded = {}  # (player, to team) -> True
        for tr in data.get("trades") or []:
            for side in tr["sides"]:
                for p in side["gets"]:
                    traded[(p.get("id"), side["team"])] = True
        # who was on a team each week; a team-less week ends a stint
        runs = defaultdict(list)  # pid -> [[team, first, last, started, starts, total]]
        info = {}
        playing = {w: {s["team"] for x in data["weeks"] if x["week"] == w for g in x["games"] for s in g["sides"]} for w in weeks}
        for w in weeks:
            for g in data["weeks"][[x["week"] for x in data["weeks"]].index(w)]["games"]:
                for s in g["sides"]:
                    for p in s["lineup"]:
                        info[p["id"]] = (p["name"], p["pos"])
            for pid, (team, started, pts) in own[w].items():
                r = runs[pid]
                if r and r[-1][0] == team and r[-1][2] == weeks[weeks.index(w) - 1]:
                    cur = r[-1]
                else:
                    cur = [team, w, w, 0.0, 0, 0.0]
                    r.append(cur)
                cur[2] = w
                cur[5] += pts
                if started:
                    cur[3] += pts; cur[4] += 1
        for pid, r in runs.items():
            name, pos = info[pid]
            entry = players.setdefault(pid, {"n": name, "p": pos, "s": []})
            entry["n"], entry["p"] = name, pos
            for i, (team, first, lw, started, starts, total) in enumerate(r):
                d = drafted.get(pid)
                if d and d["team"] == team and i == 0 and first == weeks[0]:
                    how = "D%d.%d" % (d["round"], d["roundPick"])
                elif traded.get((pid, team)):
                    how = "T"
                elif first == weeks[0]:
                    how = "K"  # on the roster from week 1 without a draft record (keeper / unknown)
                else:
                    how = "W"
                nxt = r[i + 1] if i + 1 < len(r) else None
                if nxt and nxt[1] == weeks[weeks.index(lw) + 1] and traded.get((pid, nxt[0])):
                    out = "T"
                elif lw == last or team not in playing[weeks[weeks.index(lw) + 1]]:
                    out = "E" if done or lw != last else "N"  # season over for that team / still there
                else:
                    out = "X"  # dropped
                entry["s"].append([yr, team, first, lw, round(started, 1), starts, round(total, 1), how, out])
    return {"teams": teams, "players": {str(k): v for k, v in players.items()}}


# ---------------------------------------------------------------- badges

SLOT_IDS = {"QB": 0, "RB": 2, "WR": 4, "TE": 6, "FLEX": 23, "D/ST": 16, "K": 17, "RB/WR": 3, "WR/TE": 5, "OP": 7}
BADGES = [
    ("champ", "Champion", "Won the league title."),
    ("runner", "Runner-up", "Made the championship game."),
    ("seed1", "No. 1 seed", "Finished the regular season in first."),
    ("pfking", "Points king", "Scored the most points in a season."),
    ("comeback", "Comeback kid", "Started 0–3 or worse and still made the playoffs."),
    ("streak", "On fire", "Won 5 regular-season games in a row."),
    ("weektop", "Top score", "Highest score in the league that week."),
    ("seasonhigh", "Season high", "The highest single-week score of a season."),
    ("club200", "200 club", "Scored 200+ in a week."),
    ("perfect", "Perfect lineup", "Started the best possible lineup from the roster."),
    ("blowout", "Blowout", "Won by 75+ points."),
    ("nailbiter", "Nail-biter", "Won by under 2 points."),
    ("heartbreak", "Heartbreaker", "Lost by under 2 points."),
    ("robbed", "Robbed", "Lost with one of the week's top 3 scores."),
    ("stolen", "Stolen win", "Won with one of the week's bottom 3 scores."),
    ("beatall", "Beat 'em all", "Has beaten every current member at least once."),
    ("dud", "Dud", "Scored under 100 in a week."),
    ("basement", "Basement", "Finished a season in last place."),
]


def badges(seasons_data, h2h, current_members):
    """Achievements per member (ESPN account) across every season. earned: member -> [[badge, season, week,
    game id, detail]]; one entry per time it was earned."""
    earned = defaultdict(list)

    def give(owners, badge, yr, week=None, game=None, detail=""):
        for o in owners:
            earned[o].append([badge, yr, week, game, detail])

    for data in sorted(seasons_data, key=lambda d: d["league"]["season"]):
        lg, yr = data["league"], data["league"]["season"]
        tm = {t["id"]: t for t in data["teams"]}
        own = lambda tid: tm.get(tid, {}).get("owners", [])
        slot_counts = {SLOT_IDS[s["slot"]]: s["count"] for s in data["settings"]["slots"] if s["slot"] in SLOT_IDS}
        rs = lg["regularSeasonWeeks"]
        if lg["over"]:
            for t in data["teams"]:
                if t.get("finalRank") == 1:
                    give(t["owners"], "champ", yr, detail=t["name"])
                elif t.get("finalRank") == 2:
                    give(t["owners"], "runner", yr, detail=t["name"])
                if t.get("finalRank") == len(data["teams"]):
                    give(t["owners"], "basement", yr, detail=t["name"])
        season_scores, results = [], defaultdict(list)  # team -> regular-season W/L in order
        for w in data["weeks"]:
            if not w["final"]:
                continue
            week_scores = []
            for g in w["games"]:
                if len(g["sides"]) != 2:
                    continue
                a, b = g["sides"]
                if a["pts"] <= 0 or b["pts"] <= 0:
                    continue
                win, lose = sorted((a, b), key=lambda s: -s["pts"])
                margin = win["pts"] - lose["pts"]
                counts = g["tier"] in ("NONE", "WINNERS_BRACKET")
                if counts and margin > 0:
                    if margin >= 75:
                        give(own(win["team"]), "blowout", yr, w["week"], g["id"], "%.1f-pt win" % margin)
                    if margin < 2:
                        give(own(win["team"]), "nailbiter", yr, w["week"], g["id"], "won by %.2f" % margin)
                        give(own(lose["team"]), "heartbreak", yr, w["week"], g["id"], "lost by %.2f" % margin)
                for s in (a, b):
                    if s["pts"] >= 200:
                        give(own(s["team"]), "club200", yr, w["week"], g["id"], "%.2f pts" % s["pts"])
                    if s["pts"] < 100:
                        give(own(s["team"]), "dud", yr, w["week"], g["id"], "%.2f pts" % s["pts"])
                    if slot_counts and s["pts"] > 0 and abs(optimal_points(s["lineup"], slot_counts) - s["pts"]) < 0.01:
                        give(own(s["team"]), "perfect", yr, w["week"], g["id"], "%.2f pts" % s["pts"])
                if w["week"] <= rs:
                    for s, o in ((a, b), (b, a)):
                        week_scores.append((s["pts"], s["team"], g["id"], s["pts"] > o["pts"]))
                        results[s["team"]].append(s["pts"] > o["pts"])
                    season_scores += [(a["pts"], a["team"], w["week"], g["id"]), (b["pts"], b["team"], w["week"], g["id"])]
            if len(week_scores) >= 6:
                ranked = sorted(week_scores, key=lambda x: -x[0])
                give(own(ranked[0][1]), "weektop", yr, w["week"], ranked[0][2], "%.2f pts" % ranked[0][0])
                for pts, team, gid, won in ranked[:3]:
                    if not won:
                        give(own(team), "robbed", yr, w["week"], gid, "%.2f pts, #%d of %d" % (pts, ranked.index((pts, team, gid, won)) + 1, len(ranked)))
                for pts, team, gid, won in ranked[-3:]:
                    if won:
                        give(own(team), "stolen", yr, w["week"], gid, "%.2f pts, #%d of %d" % (pts, ranked.index((pts, team, gid, won)) + 1, len(ranked)))
        if season_scores and (lg["over"] or lg["currentWeek"] > rs):
            hi = max(season_scores)
            give(own(hi[1]), "seasonhigh", yr, hi[2], hi[3], "%.2f pts" % hi[0])
        for team, rr in results.items():
            run = best = 0
            for won in rr:
                run = run + 1 if won else 0
                best = max(best, run)
            if best >= 5:
                give(own(team), "streak", yr, detail="%d straight wins" % best)
        if lg["over"]:
            pf = max(data["teams"], key=lambda t: t["pf"])
            give(pf["owners"], "pfking", yr, detail="%.2f pts" % pf["pf"])
            for t in data["teams"]:
                if t.get("seed") == 1:
                    give(t["owners"], "seed1", yr, detail="%d-%d" % (t["wins"], t["losses"]))
                rr = results.get(t["id"], [])
                if len(rr) >= 3 and not any(rr[:3]) and t.get("seed") and t["seed"] <= (lg["playoffTeams"] or 0):
                    give(t["owners"], "comeback", yr, detail="started 0-3, finished %d-%d" % (t["wins"], t["losses"]))
    for m in current_members:
        others = [o for o in current_members if o != m]
        if others and all(h2h.get((m, o), [0])[0] > 0 for o in others):
            give([m], "beatall", None, detail="beat all %d current members" % len(others))
    return {"defs": [{"id": k, "name": n, "desc": d} for k, n, d in BADGES], "earned": dict(earned)}


# ---------------------------------------------------------------- game logs (Monday-night math)

def game_logs(season, player_stats):
    """Current week's rostered players: fantasy points in each earlier week they played (from their stat lines)."""
    cur = season["league"]["currentWeek"]
    ids = {p["id"] for w in season["weeks"] if w["week"] == cur for g in w["games"] for s in g["sides"] for p in s["lineup"]}
    logs = defaultdict(list)
    for key, st in player_stats.items():
        wk, pid = key.split("|")
        if int(wk) < cur and int(pid) in ids:
            logs[int(pid)].append((int(wk), round(sum(st["a"].values()), 2)))
    return {str(pid): [p for _, p in sorted(v)] for pid, v in logs.items()}


# ---------------------------------------------------------------- this week in league history

def this_week_history(seasons_data):
    """week -> notable moments from that week of every season: top score, low score, closest game, blowout and
    best player game, each with its all-time rank (1 = most extreme ever) in its category.
    Row: [season, week, kind, team, owners, value, other, game id, rank, team id]."""
    rows = []
    for data in seasons_data:
        yr = data["league"]["season"]
        tm = {t["id"]: t for t in data["teams"]}
        for w in data["weeks"]:
            if not w["final"]:
                continue
            sides, games, players = [], [], []
            for g in w["games"]:
                if len(g["sides"]) != 2:
                    continue
                a, b = g["sides"]
                if a["pts"] <= 0 or b["pts"] <= 0:
                    continue
                win, lose = sorted((a, b), key=lambda s: -s["pts"])
                games.append((round(win["pts"] - lose["pts"], 2), win, lose, g["id"]))
                for s in (a, b):
                    sides.append((s["pts"], s, g["id"]))
                    for p in s["lineup"]:
                        if is_starter(p):
                            players.append((p["pts"], p, s, g["id"]))
            if not sides:
                continue
            t = lambda s: tm.get(s["team"], {"name": "Team %d" % s["team"], "owners": []})
            hi = max(sides, key=lambda x: x[0])
            lo = min(sides, key=lambda x: x[0])
            close = min(games, key=lambda x: x[0])
            blow = max(games, key=lambda x: x[0])
            best = max(players, key=lambda x: x[0])
            for kind, val, s, other, gid in (
                    ("high", hi[0], hi[1], "", hi[2]), ("low", lo[0], lo[1], "", lo[2]),
                    ("close", close[0], close[1], t(close[2])["name"], close[3]),
                    ("blowout", blow[0], blow[1], t(blow[2])["name"], blow[3]),
                    ("player", best[0], best[2], best[1]["name"], best[3])):
                rows.append([yr, w["week"], kind, t(s)["name"], t(s)["owners"], round(val, 2), other, gid, None, s["team"]])
    # all-time rank within each kind, across every week of every season (ties share a rank)
    for kind, high_first in (("high", True), ("low", False), ("close", False), ("blowout", True), ("player", True)):
        vals = sorted((r[5] for r in rows if r[2] == kind), reverse=high_first)
        for r in rows:
            if r[2] == kind:
                r[8] = 1 + sum(1 for v in vals if (v > r[5] if high_first else v < r[5]))
    # keep what's worth a mention: per season-week, the up-to-3 most extreme moments in the top third of their
    # category (always at least the single most extreme one)
    size = defaultdict(int)
    for r in rows:
        size[r[2]] += 1
    pct = lambda r: r[8] / size[r[2]]
    by_week = defaultdict(list)
    for r in rows:
        by_week[(r[0], r[1])].append(r)
    out = defaultdict(list)
    for (yr, wk), rs in by_week.items():
        rs.sort(key=pct)
        keep = [r for r in rs if pct(r) <= 0.33][:3] or rs[:1]
        out[str(wk)] += keep
    return dict(out)
