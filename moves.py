"""Two features built from ESPN's transaction log (every add, drop, waiver claim, trade and lineup move, with times):

  - manager style (My team): how each manager actually runs a team, compared with the rest of the league, boiled
    down to a short type like "Late-night waiver hawk".
  - butterfly effect (Insights -> What ifs): take any one move away (a waiver or free-agent pickup, a drop, a trade)
    and replay the regular season without it: which games flip and where everyone would stand.

Both work on one season at a time and only on what the site already knows: the weekly box scores (every rostered
player's points and projection each week) and the log.
"""
import datetime as dt
import statistics
from collections import Counter, defaultdict
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
ROBOT = "NightlyLeagueUpdateTaskProcessor"  # ESPN's overnight job that runs waivers
ELIGIBLE = {"QB": {"QB"}, "RB": {"RB"}, "WR": {"WR"}, "TE": {"TE"}, "K": {"K"}, "D/ST": {"D/ST"},
            "RB/WR": {"RB", "WR"}, "WR/TE": {"WR", "TE"}, "FLEX": {"RB", "WR", "TE"}, "OP": {"QB", "RB", "WR", "TE"}}
GUT_GAP = 2.0


def _proj(p):
    """ESPN's pre-game projection: kept on past weeks' rows only during the build ("_proj")."""
    v = p.get("proj")
    return v if v is not None else p.get("_proj")  # a "gut call": starting someone projected at least this many points below an eligible bench player


def normalize(raw):
    """ESPN's transactions (all scoring periods, de-duplicated) -> the executed moves and every manager action."""
    moves, actions = [], []
    for t in raw:
        member = t.get("memberId") or ""
        if member and member != ROBOT and t.get("proposedDate") and t["type"] in ("FREEAGENT", "WAIVER", "ROSTER", "FUTURE_ROSTER", "TRADE_PROPOSAL"):
            actions.append((t["teamId"], t["proposedDate"], t["type"]))
        if t.get("status") != "EXECUTED":
            continue
        items = t.get("items") or []
        if t["type"] in ("WAIVER", "FREEAGENT"):
            adds = [i["playerId"] for i in items if i["type"] == "ADD" and i["playerId"] > 0]
            drops = [i["playerId"] for i in items if i["type"] == "DROP" and i["playerId"] > 0]
            if adds or drops:
                moves.append({"id": t["id"], "kind": "waiver" if t["type"] == "WAIVER" else "fa", "team": t["teamId"],
                              "period": t.get("scoringPeriodId") or 0, "t": t.get("processDate") or t.get("proposedDate"), "adds": adds, "drops": drops})
        elif t["type"] in ("ROSTER", "FUTURE_ROSTER") and any(i["type"] == "LINEUP" for i in items):
            moves.append({"id": t["id"], "kind": "lineup", "team": t["teamId"], "period": t.get("scoringPeriodId") or 0, "t": t.get("proposedDate")})
    return moves, actions


def _weeks(season):
    lg = season["league"]
    return [w for w in season["weeks"] if w["final"] and w["week"] <= lg["regularSeasonWeeks"]]


def _owners(season):
    """week -> {player id: (team, lineup row)} for every rostered player, every week (bench included)."""
    out = {}
    for w in season["weeks"]:
        out[w["week"]] = {p["id"]: (s["team"], p) for g in w["games"] for s in g["sides"] for p in s["lineup"]}
    return out


def _stint(owners, pid, team, start, last):
    """The weeks a player stayed on a team, from `start` until he left."""
    out = []
    for w in range(start, last + 1):
        o = owners.get(w, {}).get(pid)
        if not o or o[0] != team:
            if out or w > start + 1:  # allow one week's lag between the move and the first box score
                break
            continue
        out.append(w)
    return out


# ---------------------------------------------------------------- manager style

TRAITS = {  # key: (adjective, noun, what it means)
    "hawk": ("Waiver-hungry", "waiver hawk", "adds more players than almost anyone"),
    "holder": ("Draft-loyal", "draft loyalist", "barely touches the waiver wire"),
    "tinker": ("Tinkering", "tinkerer", "changes the lineup constantly"),
    "steady": ("Set-and-forget", "set-and-forget manager", "rarely touches the lineup"),
    "owl": ("Late-night", "night owl", "makes moves after midnight"),
    "gameday": ("Sunday-morning", "game-day decider", "leaves decisions for game day"),
    "planner": ("Early-week", "planner", "gets moves done early in the week"),
    "gut": ("Gut-feel", "gut player", "starts players the projections don't like"),
    "book": ("By-the-numbers", "projection follower", "starts whoever ESPN projects highest"),
    "trigger": ("Quick-trigger", "quick cutter", "drops pickups fast"),
    "patient": ("Patient", "loyalist", "sticks with pickups for weeks"),
    "dealer": ("Deal-making", "dealmaker", "trades more than anyone"),
}


def manager_style(season, moves, actions, trades):
    weeks = _weeks(season)
    teams = [t["id"] for t in season["teams"]]
    if not weeks or not (moves or actions):
        return {}
    n_weeks = len(weeks)
    owners = _owners(season)
    last = max(owners) if owners else 0
    m = {tid: {"adds": 0, "lineup": 0, "acts": 0, "night": 0, "gameday": 0, "early": 0, "gut": 0, "gutWon": 0,
               "stays": [], "quick": 0, "judged": 0, "trades": 0, "days": [0] * 7, "hours": [0] * 24} for tid in teams}
    for mv in moves:
        if mv["team"] not in m:
            continue
        if mv["kind"] in ("waiver", "fa"):
            m[mv["team"]]["adds"] += len(mv["adds"])
            for pid in mv["adds"]:
                stay = _stint(owners, pid, mv["team"], max(1, mv["period"]), last)
                if mv["period"] <= last - 2:  # only pickups old enough to judge
                    m[mv["team"]]["judged"] += 1
                    m[mv["team"]]["stays"].append(len(stay))
                    if len(stay) <= 1:
                        m[mv["team"]]["quick"] += 1
        elif mv["kind"] == "lineup":
            m[mv["team"]]["lineup"] += 1
    for tid, ms, kind in actions:
        if tid not in m:
            continue
        t = dt.datetime.fromtimestamp(ms / 1000, ET)
        r = m[tid]
        r["acts"] += 1
        r["days"][t.weekday()] += 1
        r["hours"][t.hour] += 1
        if t.hour < 5:
            r["night"] += 1
        if t.weekday() == 6:
            r["gameday"] += 1
        if t.weekday() in (1, 2):  # Tuesday, Wednesday
            r["early"] += 1
    for tr in trades:
        for s in tr.get("sides", []):
            if s["team"] in m:
                m[s["team"]]["trades"] += 1
    # gut calls: a starter projected well below an eligible bench player (healthy and playing that week)
    for w in weeks:
        for g in w["games"]:
            for s in g["sides"]:
                if s["team"] not in m:
                    continue
                bench = [p for p in s["lineup"] if p["slot"] == "BE" and (_proj(p) or 0) > 0]
                for p in s["lineup"]:
                    if p["slot"] in ("BE", "IR") or _proj(p) is None:
                        continue
                    elig = ELIGIBLE.get(p["slot"], set())
                    alt = max((b for b in bench if b["pos"] in elig), key=_proj, default=None)
                    if alt and _proj(alt) - _proj(p) >= GUT_GAP:
                        m[s["team"]]["gut"] += 1
                        if p["pts"] > alt["pts"]:
                            m[s["team"]]["gutWon"] += 1

    def share(r, k):
        return r[k] / r["acts"] if r["acts"] >= 8 else None

    metrics = {  # metric -> (value per team, high trait, low trait)
        "adds": ({t: m[t]["adds"] / n_weeks for t in teams}, "hawk", "holder"),
        # older seasons' logs are missing most lineup moves; then this one says nothing
        "lineup": ({t: m[t]["lineup"] / n_weeks if sum(1 for x in teams if m[x]["lineup"]) >= len(teams) * 0.75 else None for t in teams}, "tinker", "steady"),
        "night": ({t: share(m[t], "night") for t in teams}, "owl", None),
        "gameday": ({t: share(m[t], "gameday") for t in teams}, "gameday", None),
        "early": ({t: share(m[t], "early") for t in teams}, "planner", None),
        "gut": ({t: m[t]["gut"] / n_weeks for t in teams}, "gut", "book"),
        "quick": ({t: (m[t]["quick"] / m[t]["judged"]) if m[t]["judged"] >= 4 else None for t in teams}, "trigger", "patient"),
        "trades": ({t: float(m[t]["trades"]) for t in teams}, "dealer", None),
    }
    z = defaultdict(list)  # team -> [(strength, trait)]
    ranks = {}
    for key, (vals, hi, lo) in metrics.items():
        known = {t: v for t, v in vals.items() if v is not None}
        if len(known) < 4:
            continue
        mu, sd = statistics.mean(known.values()), statistics.pstdev(known.values())
        order = sorted(known, key=lambda t: -known[t])
        for i, t in enumerate(order):
            ranks.setdefault(t, {})[key] = i + 1
        if sd <= 0:
            continue
        for t, v in known.items():
            score = (v - mu) / sd
            if key == "trades" and v == 0:
                continue
            if score >= 1.0 and ranks[t][key] <= 3:
                z[t].append((score, hi))
            elif lo and score <= -1.0 and ranks[t][key] >= len(known) - 2:
                z[t].append((-score, lo))
    clash = {frozenset(x) for x in (("hawk", "holder"), ("tinker", "steady"), ("gameday", "planner"), ("gut", "book"),
                                    ("trigger", "patient"), ("holder", "trigger"), ("steady", "tinker"))}
    out = {}
    for t in teams:
        traits = [k for _, k in sorted(z[t], reverse=True)]
        picked = []
        for k in traits:
            if all(frozenset((k, p)) not in clash for p in picked):
                picked.append(k)
        if len(picked) >= 2:
            name = "%s %s" % (TRAITS[picked[1]][0], TRAITS[picked[0]][1])
        elif picked:
            name = "The " + TRAITS[picked[0]][1]
        else:
            name = "The all-rounder"
        r = m[t]
        out[t] = {"type": name[0].upper() + name[1:], "traits": [[k, TRAITS[k][1], TRAITS[k][2]] for k in picked[:3]],
                  "adds": r["adds"], "lineup": r["lineup"] if metrics["lineup"][0][t] is not None else None, "trades": r["trades"], "acts": r["acts"],
                  "night": round(100 * share(r, "night")) if share(r, "night") is not None else None,
                  "gameday": round(100 * share(r, "gameday")) if share(r, "gameday") is not None else None,
                  "early": round(100 * share(r, "early")) if share(r, "early") is not None else None,
                  "gut": r["gut"], "gutWon": r["gutWon"],
                  "quick": round(100 * r["quick"] / r["judged"]) if r["judged"] >= 4 else None,
                  "stay": round(statistics.mean(r["stays"]), 1) if r["stays"] else None,
                  "days": r["days"], "hours": r["hours"], "ranks": ranks.get(t, {}), "weeks": n_weeks}
    return out


# ---------------------------------------------------------------- butterfly effect

def _score(lineup, remove, extra):
    """A week's score with some players gone and others available. Open slots go to the best-projected eligible
    player left (the bench, plus anyone given back); someone given back also starts if he's projected above the
    weakest eligible starter. Projections only, never hindsight, so it's the call the manager would have made."""
    proj = lambda p: _proj(p) or 0.0  # noqa: E731
    starters = [dict(p) for p in lineup if p["slot"] not in ("BE", "IR") and p["id"] not in remove]
    open_slots = [p["slot"] for p in lineup if p["slot"] not in ("BE", "IR") and p["id"] in remove]
    pool = [p for p in lineup if p["slot"] == "BE" and p["id"] not in remove] + [dict(p, slot="BE") for p in extra]
    used = set()
    for slot in sorted(open_slots, key=lambda s: len(ELIGIBLE.get(s, ()))):
        c = max((p for p in pool if p["id"] not in used and p["pos"] in ELIGIBLE.get(slot, ())), key=proj, default=None)
        if c:
            used.add(c["id"])
            starters.append(dict(c, slot=slot))
    for p in extra:
        if p["id"] in used:
            continue
        weak = min((s for s in starters if p["pos"] in ELIGIBLE.get(s["slot"], ())), key=proj, default=None)
        if weak and proj(p) > proj(weak):
            starters.remove(weak)
            starters.append(dict(p, slot=weak["slot"]))
    return round(sum(p["pts"] for p in starters), 2)


def _standings(results, base):
    """results: [(week, home, away, home pts, away pts)] -> team -> [wins, losses, ties, pf]; then rank by record, points."""
    rec = {t: [0, 0, 0, 0.0] for t in base}
    for _, a, b, pa, pb in results:
        rec[a][3] += pa; rec[b][3] += pb
        if pa > pb:
            rec[a][0] += 1; rec[b][1] += 1
        elif pb > pa:
            rec[b][0] += 1; rec[a][1] += 1
        else:
            rec[a][2] += 1; rec[b][2] += 1
    order = sorted(rec, key=lambda t: (-(rec[t][0] + rec[t][2] / 2), -rec[t][3]))
    return rec, {t: i + 1 for i, t in enumerate(order)}


def butterfly(season, moves, names):
    """Every waiver / free-agent move and trade that changed at least one regular-season lineup, replayed without it."""
    weeks = _weeks(season)
    if not weeks:
        return {}
    owners = _owners(season)
    names = dict(names or {})
    for wk in owners.values():
        for _, row in wk.values():
            names.setdefault(row["id"], row)
    last = max(w["week"] for w in weeks)
    teams = [t["id"] for t in season["teams"]]
    games = [(w["week"], g["id"], g["sides"][0], g["sides"][1]) for w in weeks for g in w["games"] if len(g["sides"]) == 2]
    actual = [(wk, a["team"], b["team"], a["pts"], b["pts"]) for wk, _, a, b in games]
    base_rec, base_rank = _standings(actual, teams)
    nm = lambda pid: names.get(pid, {}).get("name") or "Player #%s" % pid  # noqa: E731

    def where(pid, week):
        o = owners.get(week, {}).get(pid)
        return o if o else (None, None)

    # each move -> changes: (week, team) -> [removed player ids, rows given back]
    cases = []
    for mv in moves:
        if mv["kind"] not in ("waiver", "fa"):
            continue
        ch = defaultdict(lambda: [set(), []])
        start = max(1, mv["period"])
        for pid in mv["adds"]:
            for w in _stint(owners, pid, mv["team"], start, last):
                ch[(w, mv["team"])][0].add(pid)
        for pid in mv["drops"]:
            # kept instead: he's back on the team, playing (and scoring) as he did wherever he ended up; whoever picked
            # him up later loses him
            for w in range(start, last + 1):
                tm, row = where(pid, w)
                if row is None:
                    continue
                ch[(w, mv["team"])][1].append(row)
                if tm != mv["team"]:
                    ch[(w, tm)][0].add(pid)
        cases.append({"id": mv["id"], "kind": mv["kind"], "week": start, "team": mv["team"],
                      "gets": [nm(p) for p in mv["adds"]], "gave": [nm(p) for p in mv["drops"]], "ch": ch})
    for tr in season.get("trades", []):
        sides = tr.get("sides", [])
        moved = [(g["id"], g.get("from"), s["team"]) for s in sides for g in s.get("gets", [])]
        if len(sides) != 2 or not moved:
            continue
        # the week it took effect: the first week a traded player shows up on his new team
        wk = None
        for pid, frm, to in moved:
            for w in sorted(owners):
                if owners[w].get(pid, (None,))[0] == to and (w == 1 or owners.get(w - 1, {}).get(pid, (None,))[0] in (frm, None)):
                    if tr.get("week") is None or w >= tr["week"]:
                        wk = w if wk is None else min(wk, w)
                        break
        if wk is None or wk > last:
            continue
        ch = defaultdict(lambda: [set(), []])
        for pid, frm, to in moved:
            for w in _stint(owners, pid, to, wk, last):
                ch[(w, to)][0].add(pid)
                ch[(w, frm)][1].append(owners[w][pid][1])
        a, b = sides
        cases.append({"id": str(tr["id"]), "kind": "trade", "week": wk, "team": a["team"], "other": b["team"],
                      "gets": [g["name"] for g in a["gets"]], "gave": [g["name"] for g in b["gets"]], "ch": ch})

    lineups = {(wk, s["team"]): s for wk, _, a, b in games for s in (a, b)}
    out = []
    for c in cases:
        ch = {k: v for k, v in c["ch"].items() if k in lineups and (v[0] or v[1])}
        if not ch:
            continue
        new_pts = {k: _score(lineups[k]["lineup"], rem, extra) for k, (rem, extra) in ch.items()}
        delta = defaultdict(float)
        res, flips = [], []
        for (wk, gid, a, b), row in zip(games, actual):
            pa = new_pts.get((wk, a["team"]), a["pts"])
            pb = new_pts.get((wk, b["team"]), b["pts"])
            delta[a["team"]] += pa - a["pts"]; delta[b["team"]] += pb - b["pts"]
            res.append((wk, a["team"], b["team"], pa, pb))
            was = (a["pts"] > b["pts"]) - (a["pts"] < b["pts"])
            now = (pa > pb) - (pa < pb)
            if was != now:
                flips.append([wk, gid, a["team"], round(a["pts"], 2), round(pa, 2), b["team"], round(b["pts"], 2), round(pb, 2)])
        delta = {t: round(d, 1) for t, d in delta.items() if abs(d) >= 0.05}
        if not delta:
            continue
        rec, rank = _standings(res, teams)
        moved_rank = {t: [base_rank[t], rank[t]] for t in teams if rank[t] != base_rank[t]}
        newrec = {t: rec[t][:3] for t in teams if rec[t][:3] != base_rec[t][:3]}
        item = {k: v for k, v in c.items() if k != "ch"}
        item.update({"delta": delta, "flips": flips, "ranks": moved_rank, "rec": newrec})
        out.append(item)
    out.sort(key=lambda x: (-len(x["flips"]), -max(abs(v) for v in x["delta"].values())))
    return {"weeks": [weeks[0]["week"], last], "rank": base_rank, "rec": {t: base_rec[t][:3] for t in teams}, "moves": out}
