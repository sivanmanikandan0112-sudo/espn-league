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
- **Insights** (6 pages, code in `stats.py`): *Playoff race* (`race`, with Hot & cold), *Luck* (`luck`: Luck, Close
  games, Vs. projection), *Schedule* (`schedule`: strength of schedule, Byes ahead), *Lineups* (`lineups`: Efficiency,
  You vs. autopilot), *Draft* (`draft`, `?view=redraft` for the hindsight redraft) and *What ifs* (`whatif`: Rules lab,
  Schedule swap). Old single-view links (`#/insights/close`, `/rules`, `/byes`, ...) redirect to their page with
  `?at=<view>` to scroll there (`INSIGHT_GROUPS` / `INSIGHT_ALIAS` in `site/app.js`). The views:
  - *Playoff race*: playoff / bye / title odds from 10,000 simulated finishes (team strengths shrunk halfway to
    the league average, `STRENGTH_SHRINK`; the week in progress uses ESPN's live win probabilities).
    Past seasons show final results.
  - *Luck* (actual vs. all-play expected wins), *Close games* (record in games decided by under 10 points), *Schedule* (opponent strength so far and remaining),
    *Schedule swap* (every team's record on every other team's schedule, best and worst),
    *Hot & cold* (last 3 weeks vs. season average, adjusted for the league-wide swing),
    *Vs. projection* (points scored vs. ESPN's pre-game projection for the lineup started),
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
- **Playoff bracket** (Matchups → Playoff bracket): every season's bracket with seeds, byes and scores; live during
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
  without a game are left out. Open it from "Compare with…" in the player panel or "Compare these two" on Trade ideas.
- **Badges** (History → Badges, and "Your badges" on My team): 18 achievements per member across every season
  (titles, top score of the week, 200 club, perfect lineup, nail-biters, heartbreakers, robbed/stolen wins, 5-game
  streaks, duds, last place…), each with how many managers have it (`badges` in `stats.py`, stored in `index.js`).
- **Monday-night math** (Weekly matchups): when the only starters left in an undecided matchup are in games that
  haven't kicked off (Sunday night into Monday, at most 6 players), the card says what the trailing team needs from
  whom, how often a lone player has scored that this season, and a win chance from replaying each remaining
  player's own games this season (`gameLogs` in the current season's data; seeded so it doesn't jump each minute).
- **Share cards**: Share buttons on weekly recaps, matchups, trades and the bracket draw a 1080px image in the browser
  (canvas, no server) to share, copy or download.
- **Trade ideas** (Trades → Trade ideas, current season): pairs of teams whose rosters fit. Each has a spare player
  (beyond its starters at QB/RB/WR/TE) that would replace the other's weakest starter at that position by 10+ ROS
  points, and the two spares are within 25% of each other in rest-of-season value. "Your best trade partners" (once
  you've claimed your team) uses a looser bar (5+ points, 35%) and explains when there's no fit. Computed in the browser.
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
  since your previous visit on that device). Your team is also highlighted on Standings, Matchups (your game first), Insights tables and the
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
`appliedTotal`). When the week's slate is first requested the worker freezes it in KV (`p3-slate4:<season>:<week>`):
every QB/RB/WR/TE with a game, not out/IR/suspended, projected 5+ by ESPN for the week, priced at **$400 per projected
point** (rounded to $100) at every position, so no position is cheaper per expected point. The cap is 80% of the
priciest QB + RB + WR + TE (rounded to $500): you can't take every star, and any lineup that spends the cap projects
about the same, so the game is about who beats his projection. A spot can change only while both the player in it and
his replacement haven't kicked off; other members' players stay hidden until their game starts. Entries are one KV
value per week (`p3-entries:...`); finished weeks are scored once into `p3-season:<season>` (ties go to the cheaper
lineup). Change the price/cap rules with `P3_PER_PT`, `P3_MIN_PROJ` and `P3_CAP_SHARE` in `worker/src/index.js`.

**Waiver wire challenge** (the second view on the same page, `#/games/pick4?view=fa`, API `?mode=fa` / `"mode": "fa"`):
the same game, but the slate is only players who were unrostered in this league (free agents or on waivers) when the
week's slate opened, projected 3+. Same $400/point prices; the cap is 80% of the priciest free-agent QB + RB + WR + TE.
Its own KV keys (`p3fa-slate`, `p3fa-entries`, `p3fa-season`) and leaderboard (`P3_MODES` in the worker).

## Weekly pick'em

Games → Pick'em. Picks for a week open when ESPN moves on to it (early Wednesday) and lock at that week's first
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
