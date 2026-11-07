# League HQ

A standings / matchups / trade-history site for our ESPN fantasy football league.

## Refresh the data

```bash
python3 build.py
```

This reads `ESPN_LEAGUE_ID`, `ESPN_S2` and `ESPN_SWID` from `.env`, pulls the league from ESPN,
and writes `site/data.js` plus team logos into `site/logos/`. Re-run it whenever you want fresh scores.
If it says **401**, the cookies have expired — copy new `espn_s2` / `SWID` values into `.env`.

## View it

```bash
python3 -m http.server 8765 --directory site
```

Then open http://localhost:8765. The `site/` folder is plain static files, so it can be hosted anywhere
(GitHub Pages, Netlify, Cloudflare Pages). The cookies never leave `.env`; only the built data is published.

## Notes

- **Power value** = value over replacement. Each QB/RB/WR/TE is worth his ESPN rest-of-season projection
  minus the best free agent's at his position (floor 0). The team's best legal lineup (QB, RB, WR, TE, FLEX)
  counts in full; everyone else counts at `BENCH_WEIGHT` (0.3). K and D/ST are excluded.
  For display, that edge is added to a free-agent-only lineup's projection and scaled so the top team
  shows `POWER_TOP` (2,500). This keeps the order and gives familiar numbers.
  Bar segments are each position's share; the number is the team's rank at that position.
- **Roster cards** show each player's rest-of-season rank at their position (e.g. "ROS RB 12"), from ESPN's
  rest-of-season projections across the 1,000 most-rostered players. "—" means ESPN projects no more points (out/IR).
- **Trade history** comes from the league activity feed (completed trades only).
- Standings order: wins, then points for (this league seeds playoffs by total points).

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
