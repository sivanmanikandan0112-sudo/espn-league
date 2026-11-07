"""Team power: expected starting-lineup points over the rest of the fantasy season.

For every remaining week we pick each team's best legal lineup (QB, RB, WR, TE, FLEX) from the
players who are available that week, then add up what the starters score. The rest of the season
is replayed many times with random injuries, so bench players earn exactly as much credit as
they would actually step in:

  - a handcuff / backup RB gets credit for the weeks a starter goes down,
  - an injured star being stashed gets credit for every week after he's projected back,
  - a backup QB who never sees the field adds almost nothing.

Where a team has nobody healthy at a position, the slot is filled at the level of the best
free agent: a real manager would pick someone up rather than start an empty slot.
"""
import random

SIMULATIONS = 500
SEED = 2026  # fixed, so the rankings don't wobble between refreshes
# Chance a healthy player gets hurt in a given week, and how long he's out (weeks, uniform).
WEEKLY_INJURY_RATE = {"QB": 0.03, "RB": 0.06, "WR": 0.05, "TE": 0.05}
INJURY_LENGTH = (1, 4)
# ESPN projects 0 for some injured players with no return date; assume they come back after this
# many weeks, at this share of their season-to-date average.
STASH_RETURN_WEEKS = {"INJURY_RESERVE": 4, "OUT": 2}
STASH_RETURN_FACTOR = 0.85


def availability(p, weeks, current, nfl_last, bye_week):
    """{week: projected points} for the fantasy weeks a player is expected to play, and a note."""
    nfl_weeks = [w for w in range(current, nfl_last + 1) if w != bye_week]
    total, avg = p["rosTotal"], p["rosAvg"]
    if total > 0 and avg > 0:
        games = min(len(nfl_weeks), round(total / avg))
        play = nfl_weeks[len(nfl_weeks) - games:]  # missed games are the ones right now
        back = play[0] if play and play[0] > current else None
    elif p.get("injury") in STASH_RETURN_WEEKS and p["seasonAvg"] > 0:
        avg = p["seasonAvg"] * STASH_RETURN_FACTOR
        back = current + STASH_RETURN_WEEKS[p["injury"]]
        play = [w for w in nfl_weeks if w >= back]
    else:
        return {}, None
    return {w: avg for w in play if w in weeks}, back


def best_lineup(avail, slots, flex, fallback):
    """avail: list of (points, player_key, pos).
    Returns (points, [(player key, points, slot)], {slot: points}) where slot is QB/RB/WR/TE or FLEX,
    so position strength compares the same number of lineup spots for every team."""
    used, pts, starters = set(), 0.0, []
    by_slot = {pos: 0.0 for pos in slots}
    by_slot["FLEX"] = 0.0
    for pos, n in slots.items():
        best = sorted((a for a in avail if a[2] == pos), key=lambda a: -a[0])[:n]
        for v, key, _ in best:
            used.add(key); pts += v; starters.append((key, v, pos)); by_slot[pos] += v
        fill = fallback.get(pos, 0.0) * (n - len(best))  # empty slot: a free agent would be picked up
        pts += fill; by_slot[pos] += fill
    rest = sorted((a for a in avail if a[1] not in used and a[2] in ("RB", "WR", "TE")), key=lambda a: -a[0])[:flex]
    for v, key, _ in rest:
        pts += v; starters.append((key, v, "FLEX")); by_slot["FLEX"] += v
    fill = max(fallback.get(p, 0.0) for p in ("RB", "WR", "TE")) * (flex - len(rest))
    pts += fill; by_slot["FLEX"] += fill
    return pts, starters, by_slot


def group_spots(slots, flex):
    """Lineup spots each position group is rated on: its own slots, plus FLEX for RB and WR (the positions
    that realistically fill it). Same for every team, so groups compare fairly whoever ends up in FLEX."""
    return {pos: n + (flex if pos in ("RB", "WR") else 0) for pos, n in slots.items()}


def team_power(players, weeks, slots, flex, fallback):
    """players: [{key, pos, wk: {week: pts}}].
    Returns expected lineup total, per-player credit, per-player starts, and per-position group strength
    (expected points from that position's best players over its fixed spots, see group_spots)."""
    rng = random.Random(SEED)
    credit = {p["key"]: 0.0 for p in players}
    starts = {p["key"]: 0.0 for p in players}
    spots = group_spots(slots, flex)
    group = {pos: 0.0 for pos in slots}
    total = 0.0
    for _ in range(SIMULATIONS):
        out_until = {}
        for w in weeks:
            for p in players:
                if out_until.get(p["key"], 0) < w and w in p["wk"] and rng.random() < WEEKLY_INJURY_RATE[p["pos"]]:
                    out_until[p["key"]] = w + rng.randint(*INJURY_LENGTH) - 1
            avail = [(p["wk"][w], p["key"], p["pos"]) for p in players
                     if w in p["wk"] and out_until.get(p["key"], 0) < w]
            pts, starters, _ = best_lineup(avail, slots, flex, fallback)
            total += pts
            for key, v, _ in starters:
                credit[key] += v
                starts[key] += 1
            for pos, k in spots.items():
                best = sorted((a[0] for a in avail if a[2] == pos), reverse=True)[:k]
                group[pos] += sum(best) + fallback.get(pos, 0.0) * (k - len(best))
    n = float(SIMULATIONS)
    return (total / n, {k: v / n for k, v in credit.items()}, {k: v / n for k, v in starts.items()},
            {k: v / n for k, v in group.items()})
