# League HQ

A standings / matchups / trade-history site for our ESPN fantasy football league.

## Refresh the data

```bash
python3 build.py
```

This reads `ESPN_LEAGUE_ID`, `ESPN_S2` and `ESPN_SWID` from `.env`, pulls **every season** of the league from ESPN,
and writes `site/data/<season>.js`, `site/data/index.js` (season list + all-time history) and team logos into
`site/logos/`. If it says **401**, the cookies have expired — copy new `espn_s2` / `SWID` values into `.env`.

## View it

```bash
python3 -m http.server 8765 --directory site
```

Then open http://localhost:8765. The `site/` folder is plain static files, so it can be hosted anywhere
(GitHub Pages, Netlify, Cloudflare Pages). The cookies never leave `.env`; only the built data is published.

## What's on the site

- **Season switcher** (top right of the tabs): every season back to the league's first, each with standings,
  matchups, insights and trades as they stood. Past seasons show final finishes, end-of-season rosters with each
  player's final position rank, and position bars built from points actually started.
- **Standings / Power value** (current season) = expected starting-lineup points over the remaining weeks
  (`power.py`): best QB/RB/WR/TE/FLEX each week from available players, replayed 500 times with random injuries,
  so bench players count as often as they'd really play. Roster cards show ROS position rank and expected starts.
- **Insights** (its own tabs, each linkable as `#/insights/<name>`, code in `stats.py`):
  - *Playoff race*: playoff / bye / title odds from 10,000 simulated finishes (team strengths shrunk halfway to
    the league average, `STRENGTH_SHRINK`; the week in progress uses ESPN's live win probabilities).
    Past seasons show final results.
  - *Luck* (actual vs. all-play expected wins), *Schedule* (opponent strength so far and remaining),
    *Efficiency* (points started vs. best lineup).
  - *Draft*: each pick vs. players at the same position drafted around the same spot; team grades, steals, busts.
  - *Trade grades*: points each side's received players scored in its starting lineup after the trade.
- **Matchups**: box scores for every week, plus a recap of each completed week (top/low score, blowout, closest
  game, player of the week, most points left on the bench, best bench performance).
- **Trades**: the current season comes from the league activity feed (exact). ESPN doesn't keep that feed for past
  seasons, so those trades are rebuilt from week-to-week roster swaps confirmed against the transaction log.
- **History** (tabs): champions & all-time standings, head to head, rivalries (most played, closest, most
  one-sided) and a record book (high/low scores, blowouts, closest games, shootouts, best player and bench games),
  all keyed by each member's ESPN account rather than team slot, so former members keep their records.
- **Live updates**: while the current season is in progress, open pages re-check for new data every 2 minutes.
  If the data is more than 8 hours old in-season, a banner warns that the refresh (usually the cookies) may be broken.

## Auto-refresh (GitHub Pages)

`.github/workflows/refresh.yml` rebuilds and redeploys the site on a schedule: every 15 minutes during
Sunday, Monday and Thursday game windows, and every 3 hours otherwise. To refresh right now, open the
repo's **Actions** tab → **Refresh league site** → **Run workflow**.

It needs three repository secrets (Settings → Secrets and variables → Actions):
`ESPN_LEAGUE_ID`, `ESPN_S2`, `ESPN_SWID`. When the cookies expire the workflow fails (GitHub emails you);
copy fresh cookies into `.env` and re-run:

```bash
gh secret set -f .env
```

GitHub pauses scheduled workflows after 60 days with no commits; re-enable it from the Actions tab if that happens.
