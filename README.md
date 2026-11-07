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
  Position bars rate each position group on its own, by player position, on the same spots for every team:
  best QB, best 3 RBs, best 3 WRs (their two spots + FLEX) and best TE each week, in the same simulation. They
  rate the groups, so they don't sum to the power value (a FLEX-capable player counts in his own group).
- **Insights** (its own tabs, each linkable as `#/insights/<name>`, code in `stats.py`):
  - *Playoff race*: playoff / bye / title odds from 10,000 simulated finishes (team strengths shrunk halfway to
    the league average, `STRENGTH_SHRINK`; the week in progress uses ESPN's live win probabilities).
    Past seasons show final results.
  - *Luck* (actual vs. all-play expected wins), *Schedule* (opponent strength so far and remaining),
    *Schedule swap* (every team's record on every other team's schedule, with schedule luck),
    *Efficiency* (points started vs. best lineup).
  - *Draft*: each pick vs. players at the same position drafted around the same spot; team grades, steals, busts.
- **Matchups**: box scores for every week, plus a recap of each completed week (top/low score, blowout, closest
  game, player of the week, most points left on the bench, best bench performance).
- **Playoff bracket** (Matchups → Playoff bracket): every season's bracket with seeds, byes and scores; live during
  the playoffs; before them, "if the season ended today" with each team's playoff odds.
- **Player stat lines**: tap any player in a box score for his real stat line and the fantasy points each stat earned
  under that season's scoring. Stored per season in `data/<season>-stats.js`, loaded only when a player is opened.
- **Share cards**: Share buttons on weekly recaps, matchups, trades and the bracket draw a 1080px image in the browser
  (canvas, no server) to share, copy or download.
- **Trades**: every trade with its grade: points each side's received players scored in its starting lineup after
  the trade. The current season's trades come from the league activity feed (exact). ESPN doesn't keep that feed for past
  seasons, so those trades are rebuilt from week-to-week roster swaps confirmed against the transaction log.
- **History** (tabs): champions & all-time standings, head to head, rivalries (most played, closest, most
  one-sided) and a record book (high/low scores, blowouts, closest games, shootouts, best player and bench games),
  all keyed by each member's ESPN account rather than team slot, so former members keep their records.
- **Phones**: below 640px wide the site switches to an app-style layout (bottom tab bar, one-line header, tables as
  cards, one-team-at-a-time box scores, swipeable weekly-winners strip). It can be added to a home screen (iPhone:
  Share → Add to Home Screen; Android/Chrome: Install app; Mac Safari: File → Add to Dock) via `manifest.webmanifest`
  and `site/icons/`.
- **Live updates**: while the current season is in progress, open pages re-check for new data every 2 minutes.
  If the data is more than 8 hours old in-season, a banner warns that the refresh (usually the cookies) may be broken.

## Auto-refresh (GitHub Pages)

`.github/workflows/refresh.yml` rebuilds and redeploys the site on a schedule: every 15 minutes during
Sunday, Monday and Thursday game windows, and every 3 hours otherwise. To refresh right now, open the
repo's **Actions** tab → **Refresh league site** → **Run workflow**.

**When a week counts as finished:** ESPN closes each week early Wednesday morning (Eastern), after Monday Night
Football and Tuesday's stat corrections, at the same time waivers run. The hourly Wednesday-morning refresh picks
that up, and from then on the week is included everywhere: standings, luck, efficiency, recaps, all-time records,
head-to-head, rivalries and the record book. A week in progress shows live scores but is left out of all of those.
Champions, titles and playoff appearances are added when a season ends.

It needs three repository secrets (Settings → Secrets and variables → Actions):
`ESPN_LEAGUE_ID`, `ESPN_S2`, `ESPN_SWID`. When the cookies expire the workflow fails (GitHub emails you);
copy fresh cookies into `.env` and re-run:

```bash
gh secret set -f .env
```

GitHub pauses scheduled workflows after 60 days with no commits; re-enable it from the Actions tab if that happens.

## Live worker (minute-by-minute scores)

`worker/` is a small Cloudflare Worker (free plan). `GET /live` returns the current week's matchups, lineups and
player stat lines straight from ESPN, cached for 60 seconds; open pages fetch it every minute during the week.
Its cron (every 30 min) also triggers the GitHub rebuild, since GitHub's own scheduler skips runs when busy.
The ESPN cookies live only in the Worker's secrets.

```bash
cd worker
npx wrangler login
npx wrangler deploy
sh set-secrets.sh                      # stores ESPN_S2 / ESPN_SWID from ../.env (never printed)
npx wrangler secret put GITHUB_TOKEN   # optional: fine-grained token, this repo only, Actions read/write
```

Then put the Worker's URL in `site/config.js` (`liveApi`). When the ESPN cookies expire, re-run the two
`sh worker/set-secrets.sh` (and `gh secret set -f .env` for the GitHub build).
