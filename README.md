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
- **Playoffs** (`#/playoffs`, `renderPlayoffs` / `playoffTabs` in app.js, right of Standings): *Picture* (the playoff
  picture and the tiebreaker race, which used to sit under the standings), *Odds* (playoff / bye / title odds; past
  seasons: final results), *Seed odds*, *Scenario builder* and *Bracket*. Opens on Picture during the regular season
  and on Bracket once the playoffs start or for a finished season. Old links redirect: `#/insights/race` (and its
  `?at=seeds` / `?at=build` views) and `#/matchups/bracket`; `?at=form` goes to Insights → Hot & cold.
- **Insights** (6 pages, code in `stats.py`): *Luck* (`luck`: Luck, Close
  games, Upset tracker, Vs. projection, Injury toll), *Hot & cold* (`form`), *Schedule* (`schedule`: strength of schedule, Byes ahead), *Lineups* (`lineups`: Efficiency,
  You vs. autopilot), *Draft* (`draft`, `?view=redraft` for the hindsight redraft) and *What ifs* (`whatif`: Rules lab,
  Schedule swap). A page with several views shows one at a time, with a pill switch at the top (like Pick 4's);
  `?at=<view>` picks it. Old single-view links (`#/insights/close`, `/rules`, `/byes`, ...) redirect to their page
  with `?at=<view>` (`INSIGHT_GROUPS` / `INSIGHT_ALIAS` in `site/app.js`). The views:
  - *Injury toll* (on Luck): points each team lost to starters missing games (`injuries` per team, `injury_toll` in
    `stats.py`). A miss = on the roster, NFL team not on bye, empty stat line; only players in that team's starting
    lineup in at least half the games they played for it; valued at their average before the miss (or healthy
    average). Regular season.
  - *Seed odds* (Playoffs → Seed odds): each team's chance of every seed 1-N from the same simulations (`odds.seeds`),
    as a shaded grid with divider lines at the bye and playoff cuts.
  - *Playoff odds* (Playoffs → Odds): playoff / bye / title odds from 10,000 simulated finishes (team strengths shrunk halfway to
    the league average, `STRENGTH_SHRINK`; the week in progress uses ESPN's live win probabilities).
    Past seasons show final results.
  - *Luck* (actual vs. all-play expected wins), *Close games* (record in games decided by under 10 points), *Schedule* (opponent strength so far and remaining),
    *Schedule swap* (every team's record on every other team's schedule, best and worst),
    *Hot & cold* (last 3 weeks vs. season average, adjusted for the league-wide swing),
    *Upset tracker* (each team's record as ESPN's pre-game favorite and underdog by lineup projection, net upsets,
    biggest upset win and worst loss as a favorite; computed in the browser from each side's `projected`, `upsetModel()`),
    *Vs. projection* (points scored vs. ESPN's pre-game projection for the lineup started, plus *Starters who beat it*:
    the share of individual starts that beat the player's own projection, from each side's `beat: [n, starters]` in
    `build.py`),
    *Efficiency* (points started vs. best lineup), plus *You vs. autopilot*: each team's real lineups vs. the lineup
    ESPN's pre-game projections would have started from the same roster (IR excluded), with games those calls swung
    (`stats.autopilot`, from each side's `auto` score built in `build_season`).
  - *Rules lab*: every team's record this season (completed regular-season weeks, same lineups, each player's real
    stats rescored from the stat lines) under half-PPR, full PPR and standard ESPN scoring, with an extra weekly
    win/loss against the league median, or as best ball (best possible lineup counts). Plus what the league's own
    scoring does to each position's share of points started (`rules_lab` in `stats.py`; D/ST keeps league rules).
  - *Draft*: each pick vs. players at the same position drafted around the same spot; team grades, steals, busts.
  - *Redraft*: the draft redone with hindsight (`hindsight_redraft`): skill players ranked by points above
    replacement level at their position fill the real draft's non-K/DST pick slots in order, drafted or not.
    Shows the redraft board, each team's picks with where they'd go now and who the redraft takes in that slot,
    biggest climbs/falls and undrafted players the redraft takes. Kickers and defenses aren't redrafted.
- **Matchups**: box scores for every week, plus a recap of each completed week (top/low score, blowout, closest
  game, player of the week, most points left on the bench, best bench performance).
- **Playoff bracket** (Playoffs → Bracket): every season's bracket with seeds, byes and scores; live during
  the playoffs; before them, "if the season ended today" with each team's playoff odds.
- **Player stat lines**: tap any player in a box score for his real stat line and the fantasy points each stat earned
  under that season's scoring. Stored per season in `data/<season>-stats.js`, loaded only when a player is opened.
- **Player history** (History → Player history, `#/history/players`): search any player who's been on a league roster to see every
  league team that had him in any season, how he got there (drafted with the pick, traded for, picked up), when he
  left (dropped, traded away) and his points in that team's starting lineup. With no player picked it lists the
  most-traveled players (kickers and defenses aside). Built from the weekly rosters (`player_passport` in `stats.py`)
  into `data/players.js`, loaded only when the tab is opened. The player panel links to it ("League history ›").
- **Compare players** (Trades → Compare players): any two players on a league roster that season, side by side under
  the league's scoring: points per game, last 3, total, games, best/worst week, 15+/20+ games, rest-of-season
  projection and rank (or season finish), plus week-by-week bars. Only weeks on a league roster are known; weeks
  without a game are left out. Open it from "Compare with…" in the player panel.
- **Career luck** (History → Champions & standings): each manager's regular-season wins minus the wins their all-play
  record predicts, summed over every season (`careerLuck` in `data/index.js`, `build_history`).
- **Nemesis players** (History → Record book with a manager picked, and a tile on My team): the NFL players who've
  scored the most against that member in the opposing starting lineup, all-time (`nemesis` in `data/records.js`).
- **Badges** (History → Badges, and "Your badges" on My team): 18 achievements per member across every season
  (titles, top score of the week, 200 club, perfect lineup, nail-biters, heartbreakers, robbed/stolen wins, 5-game
  streaks, duds, last place…), each with how many managers have it (`badges` in `stats.py`, stored in `index.js`).
- **Monday-night math** (Weekly matchups): when the only starters left in an undecided matchup are in games that
  haven't kicked off (Sunday night into Monday, at most 6 players), the card says what the trailing team needs from
  whom, how often a lone player has scored that this season, and a win chance from replaying each remaining
  player's own games this season (`gameLogs` in the current season's data; seeded so it doesn't jump each minute).
- **Share cards**: Share buttons on weekly recaps, matchups, trades and the bracket draw a 1080px image in the browser
  (canvas, no server) to share, copy or download.
- **Game-day alerts** (Settings → Alerts): Web Push notifications from the live worker, following the team claimed on
  My team. Lead changes (at most one per matchup every 10 minutes), "down to the wire" (nobody playing, 1–4 starters
  left in later games, the trailing team among them), final results, big plays (TDs, 40+ yd plays, 50+ yd FGs, D/ST
  scores: yours, against you, or league-wide), a lineup check 90 min before each kickoff (starter out / IR / suspended;
  byes and empty spots before Sunday's 1 p.m. games), waiver results and trades (checked when the league fingerprint
  changes), and an optional reminder 3 h before Pick'em locks and before Sunday's games for Pick 4. Each device gets
  one notification per minute at most (several alerts combine), with optional quiet hours. Runs on its own cron
  (`0-59 * * * *`, the same minute as the feed but a separate run). Subscriptions are in KV `push:subs` (max 36);
  state in `push:game:*`, `push:sent:*`, `push:tx`. Needs the `VAPID_PRIVATE` secret: run `worker/set-push-key.sh`
  once. iPhone/iPad: only from the Home Screen app (Share → Add to Home Screen).
- **Trash talk** (under every matchup card, weekly recap and trade, current season): short comment threads posted as
  your team with name + PIN (max 280 characters, one post per 10 seconds). Stored per week in KV `talk:<season>:w<N>`
  (matchups `g:<id>`, recap `r:<week>`) and `talk:<season>:trades` (`t:<id>`), last 100 per thread. The author or the
  commissioner (ADMIN_MEMBERS) can delete a post. A post on a matchup in the current week alerts both teams' devices
  (alert kind `talk`, on by default). Posts show in League pulse.
- **Tale of the tape** (History → Tale of the tape, `#/history/h2h?a=<member>&b=<member>`; replaced the old Head to
  head picker): two managers side by side across every season - seasons, record, win %, championships (with years),
  finals, playoff trips and record, average finish and best season (completed seasons), longest win streak (from
  `records.js`), points per game, career luck - with the better value highlighted and a "leads the tape" count. Below:
  the head-to-head series (record, points, current streak, each side's biggest win, every meeting linking to its box
  score; `meetings` in `index.js` history, keyed by the two member ids in sorted order), season by season, and each
  one's record against common opponents. Opens on you vs. your most-played opponent; Share makes an image. The
  personal Record book links to it.
- **Usage, roles and practice reports** (`nfldata.py`, current season, `nfl` in the season file): public nflverse
  files downloaded at build (ffverse expected fantasy points, PFR snap counts, weekly target share, the official
  injury report), matched to ESPN ids with DynastyProcess's player id table. *▲ Due / ▼ Hot* (last 5 games, 3+
  games, 3+ points a game from usage-expected), *Role ↑ / ↓* (last 2 games vs. the 3 before: snaps ±15 or targets ±8
  points; not QBs) on My team's roster, Waiver targets and the Trade block; a usage line and snap/target strip in the
  player card; this week's practice status / game status / injury on the roster and under the lineup check, with a
  day-by-day log the build carries over in `data/practice.json`; *Vs. usage* under Insights → Luck (starters'
  points vs. expected, regular season, PPR). The worker sends a "Practice report" alert (kind `practice`) on
  Thursday and Friday at 6 p.m. ET for starters who missed or were limited in practice or are Q/D/Out. Any file
  that fails to download is simply left out.
- **Personal record books**: History → Record book has a picker (whole league or any member); a member's book lists
  their highest/lowest scores, biggest wins, worst losses, closest games, longest win streaks and best player/bench
  games across every season. My team shows the #1 of each as tiles linking to the box score. Built by
  `personal_records` in `build.py` into `data/records.js`, loaded only when opened.
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
  with ROS ranks, and **Player news**: ESPN's fantasy news blurbs (Rotowire) for your rostered players, fetched
  in the browser from `site.api.espn.com/apis/fantasy/v2/games/ffl/news/players` (last 14 days, 3 per player, "New"
  since your previous visit on that device). **Lineup check** under your matchup flags starters who are out, on IR,
  suspended or on a bye, with a link to your team on ESPN; Byes ahead and Waiver targets link to ESPN's add-players page
  ("Fix it on ESPN" links, `ESPN_TEAM` / `ESPN_ADD`). **Why your power moved** (also in each Standings team card, with
  ▲/▼ next to the power rank when sorted by power): each change to the power value since the current power window
  started, split into injuries, roster moves, projection changes and the lineup reshuffle they cause. Built by
  `add_power_moves()` in `build.py` from each player's power credit (expected lineup points he adds); the baseline
  (`powerBase` in the season file) is carried from build to build by reading the live data file back, and resets when
  the power window moves on (about once a week). **Customize** reorders or hides the sections (per device,
  `lhq:me-layout`; on a computer Schedule stays in the right column). Your team is also highlighted on Standings, Matchups (your game first), Insights tables and the
  watch guide. Works in past seasons too (member ids are ESPN accounts). On phones Settings moves to a gear in the header.
- **This week in league history** (Weekly matchups): a swipeable strip of the same week's notable moments from the
  other seasons (top/low score, closest game, blowout, best player game), with all-time ranks; each card opens that
  box score (`this_week_history` in `stats.py`, stored in `index.js`; up to 3 per season-week from the top third).
- **Big plays** (Matchups → Big plays, or tap "Recent big plays" on the Weekly tab, which shows the newest 5):
  every big play this week, grouped by NFL game (default) or by fantasy matchup — a switch at the top, remembered
  on each device. Touchdowns, field goals worth 5+ points, turnovers, defensive plays worth 5+ points (defensive/return TDs),
  and single plays of 30+ yards (50+ for a pass). The live worker compares stats once a minute, so a gain only counts
  when exactly one carry, catch or completion happened in that minute.
  Touchdowns and field goals show their exact yards ("47-yd receiving TD"), matched by player and time to the
  scoring plays in ESPN's public NFL game summary.
  Each play's "+points" is only that play, priced from the league's scoring (TD + its yards + the catch + any
  long-TD bonus), not everything the player gained in that minute.
  When ESPN takes a play back (a fumble or interception overturned, a TD ruled short), that play is removed from
  the feed rather than shown again with the opposite points.
- **Watch the play**: big plays get a "▶ Watch" link to ESPN's highlight clip when one exists. The live worker
  matches each play to the first clip in ESPN's public game summary whose headline names the player, posted from
  just before the play to 3 hours after (`addPlayVideos` in `worker/src/index.js`). Clips expire after ~2 days, and
  the link disappears with them. Team defenses and stat corrections aren't matched.
- **Score ticker**: while any NFL game is being played, a thin crawl along the bottom of every page (above the
  phone tab bar) shows every matchup score, each matchup in its own box (yours first, in green; the leader in bold);
  tap it for Matchups.
  Hover pauses it; with reduced motion turned on it's a still, swipeable strip.
- **Watch guide** (Matchups → Watch guide): this week's real NFL games ranked by how much they matter to the league:
  every league starter in the game, weighted by ESPN's projection and by how close his fantasy matchup is (0.35 for a
  lopsided one up to 1.0 for a toss-up), scaled so the biggest game is 100. Kickoffs come from ESPN's NFL schedule.
- **Waiver targets** (My team, current season): free agents and players on waivers (`add_free_agents` in `build.py`:
  the top 25 unrostered QB/RB/WR/TE by expected points, projected week by week like power value) compared with your
  roster. Three parts: the pickups that would most improve next week's best lineup (and whom they'd start over), the
  best rest-of-season adds after dropping your least-needed bench player (shown with what that drop costs), and the
  best fill-in for each short-handed week ahead (byes/injuries). "Up next" is the current week until its first
  game kicks off (`waiverWeeks`), then the week after. **Kickers & defenses** use ESPN's matchup-based weekly projections (from the same
  player download) and each week's opponent (`opponents` in `build.py`): a warning with the 3 best available when
  yours is on bye/out next week, a heads-up for byes in the 3 weeks after, and a stream only when a free agent is
  projected at least +3 (defense) / +2 (kicker) better next week, with what to swap and whether it's a free agent or a
  waiver claim.
- **Byes ahead** (Insights → Schedule): for every week left, projected points each team's best lineup loses vs. full strength to
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
- **Opens on Matchups on game days**: opening the site with no page picked (the home-screen app always does) starts on
  Matchups when an NFL game is played today (local time), and on Standings otherwise.
- **Pull to refresh** in the home-screen app: pull down from the top of any page to reload it fresh (only when
  opened from the home screen, where there's no refresh button; add `?ptr=1` to the address to try it in a browser).

## Auto-refresh (GitHub Pages)

`.github/workflows/refresh.yml` rebuilds and redeploys the site (about a minute per run). The live worker starts it:

- **as soon as something changes on ESPN** other than live scores: an add, drop, trade, waiver claim, lineup move,
  a new week, records, team names or league settings. The worker checks every minute and keeps a fingerprint of
  those in KV (`watch:fp`), so changes reach the site in about 2-3 minutes;
- **every 5 minutes while NFL games are on**, so standings, power and playoff odds follow the live scores;
- **every 30 minutes** regardless, as a safety net.

Two minutes after each of those slots the worker asks GitHub for the newest rebuild that didn't fail, and starts
one if it's late (older than 6½ minutes during games, 31½ otherwise), so a failed dispatch, a skipped cron tick or
a failed build costs a couple of minutes, not a whole interval. An ESPN error in the change check no longer stops
the time-based rebuilds.

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

### Pre-publish checks

Each build checks itself before publishing; if a check fails, the job stops and the last good version stays live.

- **Every build** (`check_site.py`, a second or two): every season's data file loads, has its teams (as many as the
  league has), and has weeks once the season is under way; `index.js` and `status.json` load; `app.js` and `sw.js`
  parse. It only fails on a clearly broken build.
- **New code only** (`check_site.mjs`, about a minute): serves the built site locally, opens it in the runner's
  Google Chrome (via `playwright-core`) with a team claimed, visits every page linked from the current season (plus
  the main tabs of each past season), taps open a team card and a player card, then does the main pages again at
  phone size. Any uncaught error or empty page fails it; a failed network call (the worker or ESPN briefly down) is
  only reported. Calls to the live worker are passed through with the real site's origin. After a pass, a
  fingerprint of the code files (`site/*.js|css|html|webmanifest` and the check itself, not the data) is saved in
  the Actions cache, so the 5-minute data refreshes skip it until the code changes again. Run it locally with
  `npm install --no-save playwright-core@1.48.2 && node check_site.mjs`.
- If the browser check is wrongly blocking a good build: **Run workflow** with **Skip the browser check** ticked.
- **Report, never blocking** (end of `check_site.mjs`, new code only): an accessibility scan of the 11 main pages with
  `axe-core` (issues grouped by rule, with impact, count and an example element) and a cold first load of Standings
  on a throttled phone (Chrome's slow 4G, 4x slower CPU, empty cache, files gzipped like GitHub Pages), printed in
  the log and on the run's summary page. A first load over 10 seconds adds a warning.
- **Numbers audit** (`audit_season` in build.py, every build, never blocking): each season's finished regular-season
  box scores are added back up into every team's record, points for and points against and compared with ESPN's
  standings, and every box score is checked against the sum of its starters. All seasons go to the build log; the
  current season's mismatches go into `data/status.json`, where the watchdog alerts on them (if they last 30
  minutes, so a week ESPN is mid-way through closing doesn't count). Known: 2023 week 10 has one team's score 48
  points above its starters, most likely a commissioner adjustment.

### Watchdog (admin alerts)

Every 5 minutes the worker (`watchdog`) checks that the site is still updating and pushes the league admins'
alert devices (`ADMIN_MEMBERS`, alerts on in Settings) when: the last 2+ builds failed (naming the failed step, with
a hint: ESPN cookies for the data step, the log for a check), the live data (`data/status.json`) is over 20 minutes
old during games or 75 otherwise, ESPN rejects the worker's cookies (10 minutes in a row), GitHub rejects the
worker's token, or the token expires within 7 days (and again within 1, from GitHub's
`github-authentication-token-expiration` header). One alert per problem (repeated after 12 hours if it's still
there), a "fixed" alert when it clears, quiet hours respected (held alerts go out after). State lives in KV
`watchdog`, written only when a problem starts, alerts or clears.

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

## What's new

`#/whatsnew` (sparkle button in the header): every feature, grouped by the day it went live, from the `CHANGELOG`
list in `site/app.js`. Add new features at the top of that list. The header button shows a dot until the latest
day has been seen on that device (`lhq:wn-seen`).

## Big plays: season

Matchups → Big plays → Season (`?view=season`, worker `GET /plays`): every big play of the season, added up per fantasy team (starters' big plays, TDs, points those plays were worth, bench plays), the players
with the most, the biggest single plays and the best ones wasted on the bench. The feed (`feed:<season>:<week>`)
expires after 21 days, so each finished week is copied once, trimmed, into `plays-week:<season>:<week>` and kept; the
week in progress is read live. Cached 2 minutes. Weeks 1-8 of 2026 came before the live feed, so they were rebuilt
once from ESPN's public NFL play-by-play (scoreboard + game summary per week) with the feed's rules: TDs, 30+ yard
catches and runs, 50+ yard passes, interceptions thrown, fumbles lost, 5+ point field goals, D/ST return TDs and
2-point conversions, priced with the league's scoring. Each play was matched to a player in that week's league lineups
and kept only if his official week stats have that kind of play (no more TDs/turnovers than his line shows).

## Feedback box

The Feedback button in the header (speech bubble; icon-only on phones and mid-size screens), the prompt at the top of
What's new, or the footer link → "Suggest something" (`#/feedback`). Ideas and problem reports go to the worker
(`POST /feedback/send`) and into one private KV list, `feedback:inbox` (latest 300). A message carries a name only
when that member's PIN checks out (signed in to a game on the device, not ticked "anonymously"); otherwise it's
anonymous. 5 messages per hour per address. Members listed in `ADMIN_MEMBERS` (wrangler.toml) see a Commissioner inbox
on the same page after signing in (`/feedback/inbox`, `/feedback/delete`). Never shown in League pulse.

## Glossary

`#/glossary` (linked from every page's footer): every stat and term grouped by area, searchable, each with where it
lives. Sections whose title is listed in a glossary entry get an "In the glossary ›" link in their ⓘ explanation
(`GLOSSARY` / `GLOSSARY_BY_TITLE` in `site/app.js`).

## Reactions

One-tap emoji (🔥 😂 💀 👏 🗑️) under each matchup card, each big play and the weekly high / low score (current
season). You react as your team with the games' name + PIN; tap again to take it back, hold (or hover) for who reacted.
Worker `GET /react?week=N`, `POST /react/toggle {member, pin, week, item, emoji}`; one KV value per week,
`react:<season>:<week>` = `{ item: { emoji: [member ids] } }` with items `g:<matchup id>`, `p:<player id>-<time>`,
`hi:top`, `lo:low`. The page fetches a week's reactions at most once a minute.

## League pulse

Standings sidebar (and under the standings on phones): recent activity on the site, newest first, from the worker's
`GET /pulse`. Written by the worker whenever someone reacts (and removed if they take it back), saves pick'em, Pick 4
or Rank 'em entries (and Bullseye and the waiver wire challenge, until they were retired), finishes trivia or updates the trade block. Never what anyone
picked. One KV value per season, `pulse:<season>`, the last 40 events; the same person doing the same thing within
30 minutes moves back to the top instead of adding a line (`pulse()` in `worker/src/index.js`).

## Who to root for

Matchups (below this week's games) and My team. The playoff-odds simulation (`stats.playoff_odds`, 10,000 seasons)
also records, for each game of the first week that isn't settled yet, every team's playoff and bye chance in the
simulations where each side won (`league.rootFor`). The site shows your own game's stakes and the other games whose
result moves your odds by a point or more, with their live scores. Once your playoff odds are 99.5%+ either way it
switches to first-round-bye odds. Refreshes with every site build.

## Manager style and Butterfly effect

Both come from ESPN's transaction log (`mTransactions2`, every scoring period; `moves.py`) and are written to
`data/<season>-moves.js`, loaded only when someone opens them.

- **Manager style** (My team): pickups, lineup changes, gut calls (a starter ESPN projected 2+ points below an
  eligible bench player), share of pickups cut within about a week, trades, and when moves happen (Eastern time).
  The type pairs the two habits furthest from the league average (z-score of 1+ and top or bottom 3). Older seasons'
  logs are missing most lineup moves, so that measure is skipped when most teams have none.
- **Butterfly effect** (Insights → What ifs): any waiver claim, free-agent pickup, drop or trade, taken out of the
  regular season. Players it brought in come out of the lineups they started in (best-projected eligible bench
  player takes the slot); players it sent away come back with the points they really scored elsewhere and start if
  projected above the weakest eligible starter; a dropped player picked up by another league team leaves that team.
  Projections only (kept on past weeks' rows during the build as `_proj`, not written out). Standings by record,
  then points for.

## Playoff picture (clinch and elimination)

Standings (IN / BYE / OUT tags), Playoffs → Picture (the Playoff picture section) and My team. `add_clinch` in build.py runs after the
playoff odds; `stats.clinch_scenarios` works it out exactly from the remaining schedule, with points tiebreakers
treated as unknown (against a team for clinching, for it for elimination): clinched = no outcome lets enough other
teams reach its win total when it loses out (a Hall's-condition check over the games among them), eliminated = no
outcome keeps enough teams from passing it when it wins out. Every combination of this week's undecided games is
checked, and the smallest sets of results that settle each team's spot are written as plain-language scenarios. A
game already decided in all but name (live win probability 0 or 100) counts as played. Checked against brute force
on thousands of random small leagues.

## Tiebreaker race

Playoffs → Picture (a Tiebreaker race section after the Playoff picture) and a line in My team's Playoff picture. The league
breaks standings ties on total points, so `stats.playoff_odds` also tracks, in each of its 10,000 simulated finishes,
whether teams level on wins sit on both sides of a cut (the bye line and the playoff line). Per team, in
`odds.ties[cut]`: % of finishes in such a tie and % of those where it ends up on the right side (null under 50
cases), plus `odds.projPF` (average final points for). League-wide, `league.tieRace[cut]`: % of finishes decided on
points and the pairs (one in, one out) that meet there most often, with how often each wins. The site adds this
week's points so far to ESPN's points for and states the gap now, the gap at projections, and what the trailing team
would need beyond its projections.

## Red zone, Left the game and Game conditions

- **Red zone alerts** (worker, `redZoneAlerts`): on the once-a-minute alert check, ESPN's NFL scoreboard (already
  fetched for game states) says which offense is inside the 20; starters on that offense get one alert per drive
  (team + where the drive started), with the down and distance. Kinds `redzone` (yours, on) and `redzoneAgainst`.
- **Left the game** (worker, `hurtAlerts`): every other minute, ESPN's fantasy news for starters whose game is on;
  headlines like "questionable to return", "ruled out", "being evaluated" mark him hurt, "has returned to the game"
  marks him back. Only news from during his game counts; alerts go out when his status changes (news under 20
  minutes old). The latest status per player is kept in KV `ingame:<season>:<week>` and served in `/live` as
  `ingame`, which the site shows as a HURT tag in box scores and a line on the player card. Kinds `hurt` (on) and
  `hurtAgainst`.
- **Game conditions** (build, `add_game_conditions`): stadium from ESPN's scoreboard (domes and roofs = Indoors; a
  neutral site is placed by its city), forecast for the first 3 hours from Open-Meteo plus the condition ESPN reports (AccuWeather's text, e.g.
  "Showers"; rain, showers or storms there flag Rain even when the hourly numbers miss it), refreshed about hourly (every
  30 minutes on game day) until the game ends. Shown on Watch guide cards, the player card, and as a lineup-check
  line for starters affected (wind and cold: K, QB, WR, TE; rain and snow: everyone).

## Follow the game (player card)

Tapping a player this week shows his NFL game (kickoff time, live clock or final, from ESPN's scoreboard that the
ticker already checks each minute) with **Open in Real** and **ESPN Gamecast** links (every game in Matchups → Watch guide has them too). Real's game pages use its own
ids, so the build matches them by date and team names from Real's day pages (`realapp.com/nfl/<date>`,
`add_real_links` in build.py): links carry over between builds, so Real is only asked about new games, and any
failure just leaves that link out. Big plays (Matchups → Big plays and the recent-plays panel) link to **that exact play on Real** when Real lists it
among the game's top plays (about 5 per game, mostly touchdowns and long field goals; `add_real_plays` reads games that are on
first, then each once more after it ends, within 10 seconds per build, and keeps every play link it has ever found since Real
reshuffles its top 5), matched by player, yards and kind, with a
passing TD matched to its one catch. Other plays link to that player's own game page on Real (Real's app lists his plays there; its full
play-by-play feed is behind bot protection, so the site doesn't read it), or to the game, plus ESPN Gamecast. The player card's Real button opens **that player's own performance in that game** on Real ("Cam Ward Stats vs
Cowboys"), read from the same game pages (league-rostered players only); before his game starts it opens the game. Real's links are web links; whether they open the Real app or its website
depends on the phone.

## Scenario builder

Playoffs → Scenario builder (`#/playoffs/scenarios`, `scnBody` in app.js), linked from the Playoff picture and
My team. Every regular-season game left (this week's from the week's matchups, later ones from `upcoming`) is a pair
of buttons; tap the winner. It starts on the favorites: ESPN's live win probability this week, then the playoff
odds' weekly scoring model (`odds.wk` = mean and spread per team, from `team_strengths`). The standings are worked
out in the browser: wins first, then projected final points (`odds.projPF`, the tiebreaker race's numbers) plus any
adjustment typed in. It shows seeds, bye / playoffs / out, "on points" where a tie on wins decides a cut, the move
from today's standings, the first round, and a line for your team. "You win out / lose out" set your games;
"Favorites" resets. Picks are kept in the link (`?s=<first week>.<h|a per game>&adj=<team>:<points>`), updated as you
tap, so Share (the phone's share sheet, or copy) sends the same scenario; a link from an earlier week drops the
weeks played since. This week's games ESPN has already settled (win probability 0 or 100) are locked.

## League Wrapped

History → Wrapped (`#/history/wrapped`, `wrSlides` / `wrOpen` / `drawSlide` in app.js; it replaced the Season yearbook,
and old `#/history/yearbook` links redirect). Each manager's finished season as a full-screen story: tap the right side
to go on, the left to go back, hold to pause (arrow keys, space and Escape on a computer), progress bars on top, 6.5
seconds a slide. Bold colors per slide, moving shapes, staggered entrances, numbers that count up, player photos (ESPN
headshots, which allow cross-site use, so they also go into the share images), confetti for the champion. Most slides
carry a row of supporting stats, ranked against the league where that makes sense, and player slides show the
player's real stat line (passing / rushing / receiving yards and TDs, from `data/<season>-stats.js`).

- Always: cover; your road (place in the standings after every week as a line with W/L dots and the playoff line;
  weeks in a playoff spot, highest place, longest win streak); how it ended (champion / final / playoff exit / missed
  by N wins or on points, last place gets a light roast; rank in points scored and against, all-play record); guess
  your MVP (four of your top scorers as photos, tap one, then the answer with his stat line); your top 5 (photos,
  points, share of your points, points per start); your peak (best score and its rank among every score that season,
  bars for every week; average and its rank, weeks above the league average, weeks with the league's top score); your
  manager type (from the moves log's `style`: pickups, trades and all moves with ranks, busiest day); the league's
  champion (for everyone else; seed, points rank, your all-time record against them) and week of the year (with its
  top player's line); a trading-card summary.
- Optional, only when worth showing, and only the team's 3 strongest (`WR_OPT`, scored by `opt`): clutch (a player
  whose points decided 40%+ of your wins), best move (a pickup or trade worth 50+ started points), the one that got
  away (dropped or traded, then 60+ started points elsewhere), the heartbreaker (a loss by under 5; close-game
  record), bench regret (a bench swap that would have flipped a loss, twice or in the playoffs; or a clean sheet;
  points left on the bench and lineup efficiency with ranks), luck (3 luckiest / unluckiest, 1+ win either way),
  rivals (all-time nemesis and favorite victim, with average scores in those games), superlatives (2+ season awards
  and badges), and the trade of the year (for the two teams in it).

Every slide has a Share button: `drawSlide` draws it as a 1080x1350 image in the slide's colors (photos, the road,
bars, top 5, the summary card, the stat row) through the same share sheet as the other share cards. Finished seasons
only: the current one shows "arrives the day the championship is decided". The worker sends one "Your League Wrapped
is ready" alert per device (alert kind `wrapped`), once the season is over and the site has rebuilt after that,
between 10am and 9pm Eastern (`wrappedAlert`); it opens `#/history/wrapped?play=me`, which starts your story.

## Getting-started tour

A first-time visitor on a device (nothing saved from the site yet) gets a five-step card: what League HQ is, claim
your team (name + PIN), turn on alerts, where everything lives, and the league games. The steps that send you
somewhere (My team, Settings → Alerts) shrink the tour to a small "Continue" pill at the bottom, and those steps show
as done once you've claimed a team or turned alerts on. Skipping or finishing ends it for good on that device;
Settings → Display → **Take the tour** replays it. Saved in `localStorage` as `lhq:tour`.

## Compact mode

A per-device display setting (`lhq:compact`, the `compact` class on `<html>`): the switch in
Settings → Display. Tighter table rows, matchup cards, tiles, game lists and spacing, and the one-line explanation
with ⓘ on every screen size. Tap targets stay at least 36 px. Styles are the `.compact` rules at the end of
`site/style.css`.

## Games tab

`#/games`: Pick'em (moved from Matchups; old `#/matchups/pickem` links redirect) and **League trivia**
(`#/games/trivia`). Trivia is 5 multiple-choice questions a week about the league's own history (team names, record
scores, best player and bench games, blowouts, champions, season points leaders, win streaks, head-to-head records).
The worker builds them from the site's public `data/index.js` and `data/records.js` (`worker/src/trivia.js`, seeded by
season + week), one per difficulty level from Easy to Expert in order: each candidate is rated by how memorable its kind
of fact is (`BASE`, from this season's team names up to exact head-to-head records) plus half a level per season ago,
and questions already asked earlier in the season are never repeated, freezes them in KV as `trivia-q:<season>:<week>` on the first request, and only returns the answers
after a member submits. One try per week, same name + PIN as pick'em; the season leaderboard is one KV value,
`trivia-board:<season>`. A new quiz starts when ESPN moves to the next matchup week.

## Pick 4

Games → Pick 4 (`#/games/pick4`, worker `/pick3`, `/pick3/mine`, `/pick3/save`). Each week: one QB, RB, WR and TE
from any NFL team under a salary cap, scored with their real fantasy points that week under league scoring (ESPN's
`appliedTotal`). The week's slate is made on the first request (KV `p3-slate4:<season>:<week>`): every QB/RB/WR/TE
with a game, not on IR/suspended, projected 5+ by ESPN for the week, priced at **$400 per projected point** (rounded to
$100) at every position, so no position is cheaper per expected point. It's **re-priced every 30 minutes**
(`P3_REFRESH_MIN`) from ESPN's latest projections, so prices follow injury news, until each player's game starts (then
his price freezes). Injury tags ride along (Q / D / OUT; OUT players can't be added) and each player keeps `sal0`, his
opening price, for the ▲/▼ shown on the page. A saved pick is a snapshot `{id, sal, n, pos, team, opp, at}`: **players
already in a lineup keep the price they were bought at**; only a player swapped in costs the current price. The cap is 80% of the
priciest QB + RB + WR + TE (rounded to $500): you can't take every star, and any lineup that spends the cap projects
about the same, so the game is about who beats his projection. A spot can change only while both the player in it and
his replacement haven't kicked off; other members' players stay hidden until their game starts. Entries are one KV
value per week (`p3-entries:...`); finished weeks are scored once into `p3-season:<season>` (ties go to the cheaper
lineup). Change the price/cap rules with `P3_PER_PT`, `P3_MIN_PROJ` and `P3_CAP_SHARE` in `worker/src/index.js`.

**Waiver wire challenge (retired):** a free-agents-only version of Pick 4 on the same page, removed in November
2026. Its KV data (`p3fa-slate`, `p3fa-entries`, `p3fa-season`) was left untouched; old `#/games/pick4?view=fa` links
go to Pick 4, and the worker answers `mode: "fa"` requests with a "retired" error (410) so an old copy of the site
can't save a lineup into the wrong game.

## Bullseye (retired)

Removed in November 2026. Its stored data was left in KV untouched (`bull-entries:<season>:<week>`,
`bull-season:<season>`), and old `#/games/bullseye` links go to Games.

## Guess the graph

Games → Guess the graph (`#/games/graph`, worker `/graph`, `/graph/mine`, `/graph/guess`). Three puzzles a week: one
player's fantasy points (league scoring) in every completed week as a bar chart, his position (no team), and four
names. Easy: a top-6 player at his position against three players ranked 19th-40th; Medium: a top-16 player against
players ranked within 6 spots of him; Hard: a player ranked about 11th-32nd against the three with the closest season
totals. Each level uses a different position. One guess per puzzle, worth 1 / 2 / 3 points; no player is the answer
twice in a season (`graph-used:<season>`).

The pool is `data/graph.json`, written by `graph_pool()` in `build.py`: the 220 most-owned QBs/RBs/WRs/TEs with weekly
points from ESPN's `filterStatsForTopScoringPeriodIds` (null = didn't play). It's only re-fetched when another week is
complete (the build reads the live copy back first); a week is complete 6 hours after its last NFL kickoff
(`week_over`), not when ESPN rolls over on Wednesday. The games open the next week on Monday night, so the worker
won't freeze a week's puzzles until `graph.json` runs through the week before (it answers "not ready yet" meanwhile). The worker picks the week's puzzles with a seed that includes
`PIN_SALT`, freezes them in `graph-q:<season>:<week>`, and only returns an answer after that member's guess
(`graph-a:<season>:<week>`, season board `graph-board:<season>`).

## Rank 'em

Games → Rank 'em (`#/games/rankem`, worker `/rank`, `/rank/mine`, `/rank/save`). Each week one position (QB, RB, WR, TE
in turn by week number): 5 players picked from a run of 8 neighbours by ESPN projection (top 16 QB/TE, top 30 RB/WR),
all playing Sunday or later, frozen in KV `rank-slate:<season>:<week>`. Rank them by points; everything locks at the
first of their kickoffs and nobody's order shows until then. 3 points per exact spot, 1 for one spot off (tied players
share their spots), 15 max; the page also shows what ESPN's projected order would have scored. KV
`rank-entries:<season>:<week>`, `rank-season:<season>`.

## Weekly pick'em

Games → Pick'em. Picks for a week open as soon as the previous week's last NFL game ends (usually late Monday
night; the worker's `gamesWeek`, which every weekly game uses: 4 hours after the last kickoff with no game in progress,
or 6 hours after it regardless; in the playoffs pick'em waits for ESPN to set the next matchups) and lock at that
week's first NFL kickoff; the worker enforces this and hides everyone's picks until the lock. Each member claims their name with a
4-digit PIN the first time they pick (stored hashed in the worker's `PICKEM` KV namespace). One point per correct
pick; the leaderboard and weekly winners count games once they're final.

If someone forgets their PIN (or someone else grabbed their name), clear it and they can set a new one:

```bash
cd worker && npx wrangler kv key delete --remote --binding PICKEM "pin:2026:{MEMBER-ID}"
```

(Member ids are the `{...}` ids in `site/data/index.js`; local testing can force picks open with
`PICKEM_FORCE_OPEN=1` in `worker/.dev.vars`.)

## Trade impact

Trades → Trade impact (`#/trades/impact?a=<team>&ga=<players>&b=<team>&gb=<players>`, `renderTradeImpact` in app.js;
all in the browser, no build or worker changes). Pick two teams and the QBs, RBs, WRs and TEs each would send. For every
week left (from the first week nobody has played, through the final), each team's best lineup (QB, RB, WR, TE, FLEX
from the roster's expected points per week `wk`, the same numbers power value uses) is worked out with and without
the trade; half of each week's change (`TI_SHRINK`, matching `STRENGTH_SHRINK`) is added to that team's weekly scoring
model (`odds.wk`). `tiSim` then runs 10,000 seasons both ways (this week's games, once under way, use ESPN's live win
probability; then the regular season, standings by wins then points, and the reseeded bracket) with one fixed seed
and the same number of draws per run, so before and after differ only by the trade. Shows each team's lineup change,
the next week's lineup moves, a warning when it leaves a position with nobody to start, playoff / bye / title odds
before and after, and other teams whose playoff odds move a point or more. Linked from Compare players (two
players on different teams) and the Trade block (two-way and one-way fits, and each team's block). Kickers and
defenses aren't counted, and the drop a lopsided trade would force isn't modeled.

## Trade block

Trades → Trade block. Every player's trade status (On the block / Normal / Untouchable) is read from ESPN's own trade
block settings. Managers can also change statuses on the site (plus add positions they're looking for and a note);
those changes are stored in the worker's KV and are **not** sent back to ESPN. When the two disagree, the most recent
change wins: a site change records ESPN's status at that moment, and if ESPN's status changes later, ESPN takes over.
"Reset to my ESPN settings" drops a team's site changes. Editing uses the same name + PIN as pick'em.
