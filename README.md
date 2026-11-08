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
- **Since your last visit** (Standings): coming back 3+ hours later shows what changed (finished weeks and your
  result, standings moves, playoff-odds swings, new trades, open pick'em). The device keeps the comparison point
  until "Got it"; it's personalized once the site knows your team (pick'em/trade block name, or the card's picker).
- **Season storyline** (Standings, below the teams): every team's standings position after each completed week;
  tap a team to follow its path.
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
  - *Luck* (actual vs. all-play expected wins), *Close games* (record in games decided by under 10 points), *Schedule* (opponent strength so far and remaining),
    *Schedule swap* (every team's record on every other team's schedule, best and worst),
    *Hot & cold* (last 3 weeks vs. season average, adjusted for the league-wide swing),
    *Vs. projection* (points scored vs. ESPN's pre-game projection for the lineup started),
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
- **Settings** (`#/settings`): the league's rules straight from ESPN's settings (`league_settings` in `build.py`):
  at-a-glance tiles, roster spots and limits, schedule & playoffs (seeding, reseeding, tiebreaks), waivers & trades,
  draft type/date/order, and every scoring rule grouped by passing, rushing, receiving, kicking and D/ST (with the
  points- and yards-allowed brackets). Follows the season switcher, so older seasons show the rules they used.
- **My team** (`#/myteam`): claim your team once with your pick'em name + PIN (checked by the worker's
  `/pickem/claim`; remembered on the device). The page shows your matchup and win chance, standing/power/odds/luck/
  lineup/draft tiles, your NFL games to watch, byes ahead, full schedule (results, then remaining opponents) and roster
  with ROS ranks. Your team is also highlighted on Standings, Matchups (your game first), Insights tables and the
  watch guide. Works in past seasons too (member ids are ESPN accounts). On phones Settings moves to a gear in the header.
- **Big plays** (Matchups → Big plays, or tap "Recent big plays" on the Weekly tab, which shows the newest 5):
  every big play this week grouped by matchup. Touchdowns, field goals worth 5+ points, turnovers, defensive plays,
  and single plays of 30+ yards (50+ for a pass). The live worker compares stats once a minute, so a gain only counts
  when exactly one carry, catch or completion happened in that minute.
  Touchdowns and field goals show their exact yards ("47-yd receiving TD"), matched by player and time to the
  scoring plays in ESPN's public NFL game summary.
  Each play's "+points" is only that play, priced from the league's scoring (TD + its yards + the catch + any
  long-TD bonus), not everything the player gained in that minute.
- **Watch guide** (Matchups → Watch guide): this week's real NFL games ranked by how much they matter to the league:
  every league starter in the game, weighted by ESPN's projection and by how close his fantasy matchup is (0.35 for a
  lopsided one up to 1.0 for a toss-up), scaled so the biggest game is 100. Kickoffs come from ESPN's NFL schedule.
- **Byes ahead** (Insights): for every week left, projected points each team's best lineup loses vs. full strength to
  byes (and players ESPN expects to miss), with K / D/ST flags when every kicker or defense is on bye
  (`add_bye_crunch` in `build.py`).
- **Phones**: below 640px wide the site switches to an app-style layout (bottom tab bar, one-line header, tables as
  cards, one-team-at-a-time box scores, swipeable weekly-winners strip). It can be added to a home screen (iPhone:
  Share → Add to Home Screen; Android/Chrome: Install app; Mac Safari: File → Add to Dock) via `manifest.webmanifest`
  and `site/icons/`.
- **Live updates**: while the current season is in progress, open pages re-check for new data every 2 minutes.
  If the data is more than 8 hours old in-season, a banner warns that the refresh (usually the cookies) may be broken.
- **Works offline** (`site/sw.js`): a service worker saves the pages, code and every season you've opened as you
  browse (newest copy first when online). With no signal the site still opens with the last saved scores and an
  "You're offline" banner; it refreshes itself when the connection comes back. Each deploy stamps `SW_BUILD`, so
  old saved copies are cleared automatically.
- **Pull to refresh** in the home-screen app: pull down from the top of any page to reload it fresh (only when
  opened from the home screen, where there's no refresh button; add `?ptr=1` to the address to try it in a browser).

## Auto-refresh (GitHub Pages)

`.github/workflows/refresh.yml` rebuilds and redeploys the site (about a minute per run). The live worker starts it:

- **as soon as something changes on ESPN** other than live scores: an add, drop, trade, waiver claim, lineup move,
  a new week, records, team names or league settings. The worker checks every minute and keeps a fingerprint of
  those in KV (`watch:fp`), so changes reach the site in about 2-3 minutes;
- **every 5 minutes while NFL games are on**, so standings, power and playoff odds follow the live scores;
- **every 30 minutes** regardless, as a safety net.

GitHub's own schedule in the workflow is a backup (it often skips runs when busy). Open pages check for a new
build every minute and swap it in. To refresh right now, open the repo's **Actions** tab → **Refresh league site**
→ **Run workflow**. `npx wrangler tail` in `worker/` shows each rebuild and why it started.

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
A second cron runs every minute during NFL game windows and turns each player's scoring changes into a
**big-play feed** (TDs, field goals, turnovers, defensive plays, and yardage: 30+ rushing/receiving or 50+
passing yards since the last check) shown on Matchups; it writes to KV only
when a play happens, to stay inside the free plan's daily write limit. `FEED_FORCE=1` in `.dev.vars` runs it off-hours
for local testing (`npx wrangler dev --test-scheduled`, then `curl "localhost:8787/__scheduled?cron=*+*+*+*+*"`).
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

## Weekly pick'em

Matchups → Pick'em. Picks for a week open when ESPN moves on to it (early Wednesday) and lock at that week's first
NFL kickoff; the worker enforces this and hides everyone's picks until the lock. Each member claims their name with a
4-digit PIN the first time they pick (stored hashed in the worker's `PICKEM` KV namespace). One point per correct
pick; the leaderboard and weekly winners count games once they're final.

If someone forgets their PIN (or someone else grabbed their name), clear it and they can set a new one:

```bash
cd worker && npx wrangler kv key delete --remote --binding PICKEM "pin:2026:{MEMBER-ID}"
```

(Member ids are the `{...}` ids in `site/data/index.js`; local testing can force picks open with
`PICKEM_FORCE_OPEN=1` in `worker/.dev.vars`.)

## Trade block

Trades → Trade block. Every player's trade status (On the block / Normal / Untouchable) is read from ESPN's own trade
block settings. Managers can also change statuses on the site (plus add positions they're looking for and a note);
those changes are stored in the worker's KV and are **not** sent back to ESPN. When the two disagree, the most recent
change wins: a site change records ESPN's status at that moment, and if ESPN's status changes later, ESPN takes over.
"Reset to my ESPN settings" drops a team's site changes. Editing uses the same name + PIN as pick'em.
