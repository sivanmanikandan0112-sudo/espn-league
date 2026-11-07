// League HQ live worker.
//
//   GET /live   -> the current week's matchups, lineups and player stat lines, straight from ESPN,
//                  cached for 60 seconds so the whole league refreshing at once is still one ESPN call.
//   cron        -> asks GitHub to rebuild the full site (standings, insights, history) on a reliable schedule.
//
// Secrets (set with `wrangler secret put`): ESPN_S2, ESPN_SWID, and optionally GITHUB_TOKEN.
// Vars (wrangler.toml): LEAGUE_ID, SITE_ORIGIN, GITHUB_REPO, GITHUB_WORKFLOW.

const POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };
const SLOT = { 0: "QB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE", 7: "OP", 16: "D/ST", 17: "K", 20: "BE", 21: "IR", 23: "FLEX" };
const SLOT_ORDER = { 0: 0, 2: 1, 4: 2, 6: 3, 3: 4, 5: 4, 23: 4, 7: 4, 16: 5, 17: 6, 20: 7, 21: 8 };
const PRO = { 0: "FA", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND",
  12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT",
  24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU" };
// raw stats kept for the stat line (everything that scores is kept too) - same list as build.py
const STAT_LINE_IDS = new Set([0, 1, 3, 4, 19, 20, 23, 24, 25, 26, 42, 43, 44, 53, 58, 62, 72, 74, 75, 77, 78, 80, 81, 83, 84, 86, 87,
  95, 96, 97, 98, 99, 101, 102, 103, 104, 120, 127]);
const CACHE_SECONDS = 60;

function season() {
  const now = new Date();
  return now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

async function espn(env, yr, params) {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${yr}/segments/0/leagues/${env.LEAGUE_ID}?${params}`;
  const r = await fetch(url, { headers: { Cookie: `espn_s2=${env.ESPN_S2}; SWID=${env.ESPN_SWID}`, "User-Agent": "league-hq-live" } });
  if (r.status === 401) throw new Error("ESPN login expired");
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  return r.json();
}

const r2 = x => Math.round(x * 100) / 100;

function playerRow(entry, yr, week, statsOut) {
  const ppe = entry.playerPoolEntry, p = ppe.player;
  let line = null;
  for (const s of p.stats || []) {
    if (s.statSourceId === 0 && s.scoringPeriodId === week && s.seasonId === yr) line = s;
  }
  if (line) {
    const a = {}, r = {};
    for (const [k, v] of Object.entries(line.appliedStats || {})) if (v) a[k] = r2(v);
    for (const [k, v] of Object.entries(line.stats || {})) if (v && (STAT_LINE_IDS.has(Number(k)) || k in a)) r[k] = r2(v);
    statsOut[`${week}|${p.id}`] = { r, a };
  }
  const injury = p.injuryStatus && !["ACTIVE", "NORMAL"].includes(p.injuryStatus) ? p.injuryStatus : null;
  return {
    id: p.id, name: p.fullName, pos: POS[p.defaultPositionId] || "?", team: PRO[p.proTeamId] || "",
    slot: SLOT[entry.lineupSlotId] || "BE", _o: SLOT_ORDER[entry.lineupSlotId] ?? 9,
    pts: r2(line ? line.appliedTotal || 0 : ppe.appliedStatTotal || 0), injury,
  };
}

async function liveWeek(env) {
  const yr = season();
  const status = (await espn(env, yr, "view=mStatus")).status;
  const week = status.currentMatchupPeriod;
  const data = await espn(env, yr, `view=mMatchupScore&view=mBoxscore&scoringPeriodId=${week}`);
  const stats = {};
  const games = [];
  for (const m of data.schedule || []) {
    if (m.matchupPeriodId !== week) continue;
    const live = (m.winner || "UNDECIDED") === "UNDECIDED";
    const sides = [];
    for (const side of ["home", "away"]) {
      const s = m[side];
      if (!s) continue;
      const lineup = ((s.rosterForCurrentScoringPeriod || {}).entries || []).map(e => playerRow(e, yr, week, stats));
      lineup.sort((x, y) => x._o - y._o || y.pts - x.pts);
      lineup.forEach(x => delete x._o);
      const pts = live && s.totalPointsLive != null ? s.totalPointsLive : s.totalPoints || 0;
      sides.push({
        team: s.teamId, pts: r2(pts),
        proj: live ? r2(s.totalProjectedPointsLive || 0) : null,
        winProb: live ? s.winProbability ?? null : null,
        lineup,
      });
    }
    games.push({ id: m.id, winner: m.winner || "UNDECIDED", playoff: (m.playoffTierType || "NONE") !== "NONE", tier: m.playoffTierType || "NONE", sides });
  }
  return { season: yr, week, latestScoringPeriod: status.latestScoringPeriod, updated: new Date().toISOString(), games, stats };
}

// ---------------------------------------------------------------- weekly pick'em
// Picks for a week are open from when ESPN moves on to that week (early Wednesday) until its first NFL kickoff.
// Everyone's picks stay hidden until that lock; a 4-digit PIN (set on first use) stops people picking as someone else.

const json = (env, req, body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(env, req) } });

async function cached(key, seconds, make) {
  const cache = caches.default;
  const k = new Request("https://cache.local/" + key);
  const hit = await cache.match(k);
  if (hit) return hit.json();
  const val = await make();
  await cache.put(k, new Response(JSON.stringify(val), { headers: { "Cache-Control": `public, max-age=${seconds}` } }));
  return val;
}

async function kickoffs(yr) {
  // week -> sorted kickoff times (ms) of every NFL game that week
  return cached(`pro-kickoffs-${yr}`, 6 * 3600, async () => {
    const r = await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${yr}?view=proTeamSchedules_wl`);
    const d = await r.json();
    const byWeek = {};
    for (const t of d.settings.proTeams) {
      for (const [wk, games] of Object.entries(t.proGamesByScoringPeriod || {})) {
        for (const g of games) (byWeek[wk] = byWeek[wk] || new Set()).add(g.date);
      }
    }
    return Object.fromEntries(Object.entries(byWeek).map(([wk, set]) => [wk, [...set].sort((a, b) => a - b)]));
  });
}

async function firstKickoff(yr, week) {
  const k = (await kickoffs(yr))[String(week)];
  return k && k.length ? k[0] : null;
}

// true while any NFL game this week could be in progress (kickoff to ~4h15m later)
async function gamesOn(yr, week, now = Date.now()) {
  const k = (await kickoffs(yr))[String(week)] || [];
  return k.some(t => now >= t - 5 * 60e3 && now <= t + 255 * 60e3);
}

async function pickemWeek(env) {
  const yr = season();
  return cached(`pickem-week-${yr}`, 120, async () => {
    const d = await espn(env, yr, "view=mStatus&view=mTeam&view=mMatchupScore");
    const week = d.status.currentMatchupPeriod;
    const games = (d.schedule || []).filter(m => m.matchupPeriodId === week && m.home && m.away)
      .map(m => ({ id: m.id, home: m.home.teamId, away: m.away.teamId }));
    const members = [...new Set((d.teams || []).flatMap(t => t.owners || []))];
    const over = d.status.latestScoringPeriod > (d.status.finalScoringPeriod || 17);
    return { season: yr, week, games, members, over };
  });
}

async function pinHash(env, season, member, pin) {
  const data = new TextEncoder().encode(`${env.PIN_SALT || "league-hq"}|${season}|${member}|${pin}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// returns null when the PIN is right (or was just set), otherwise an error message
async function checkPin(env, season, member, pin) {
  if (!/^\d{4}$/.test(String(pin || ""))) return "Enter a 4-digit PIN.";
  const failKey = `fails:${season}:${member}`;
  const fails = Number(await env.PICKEM.get(failKey)) || 0;
  if (fails >= 10) return "Too many wrong PINs. Try again in an hour.";
  const want = await env.PICKEM.get(`pin:${season}:${member}`);
  const got = await pinHash(env, season, member, pin);
  if (!want) { await env.PICKEM.put(`pin:${season}:${member}`, got); return null; } // first use claims the name
  if (want === got) return null;
  await env.PICKEM.put(failKey, String(fails + 1), { expirationTtl: 3600 });
  return "Wrong PIN for that name.";
}

async function pickemState(env, now = Date.now()) {
  const wk = await pickemWeek(env);
  const lockAt = await firstKickoff(wk.season, wk.week);
  const open = !wk.over && (env.PICKEM_FORCE_OPEN === "1" || (lockAt != null && now < lockAt));
  return { ...wk, lockAt, open };
}

async function allPicks(env, season) {
  const out = {};
  let cursor;
  do {
    const page = await env.PICKEM.list({ prefix: `picks:${season}:`, cursor });
    for (const k of page.keys) {
      const [, , week, member] = k.name.split(":");
      const v = await env.PICKEM.get(k.name, "json");
      if (v) (out[week] = out[week] || {})[member] = v.picks;
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out;
}

async function handlePickem(req, env, url) {
  if (!env.PICKEM) return json(env, req, { error: "Pick'em storage isn't set up yet." }, 503);
  const st = await pickemState(env);
  if (req.method === "GET" && url.pathname === "/pickem") {
    const picks = await allPicks(env, st.season);
    const submitted = Object.keys(picks[st.week] || {});
    if (st.open) delete picks[st.week]; // nobody sees this week's picks until they lock
    return json(env, req, { season: st.season, week: st.week, lockAt: st.lockAt, open: st.open, games: st.games, submitted, weeks: picks });
  }
  if (req.method !== "POST") return json(env, req, { error: "Not found" }, 404);
  let body;
  try { body = await req.json(); } catch (_) { return json(env, req, { error: "Bad request" }, 400); }
  const member = String(body.member || "");
  if (!st.members.includes(member)) return json(env, req, { error: "That name isn't in the league." }, 400);
  if (url.pathname === "/pickem/mine") {
    const exists = await env.PICKEM.get(`pin:${st.season}:${member}`);
    if (!exists) return json(env, req, { picks: {}, newPin: true });
    const err = await checkPin(env, st.season, member, body.pin);
    if (err) return json(env, req, { error: err }, 403);
    const v = await env.PICKEM.get(`picks:${st.season}:${st.week}:${member}`, "json");
    return json(env, req, { picks: (v && v.picks) || {} });
  }
  if (url.pathname === "/pickem/submit") {
    if (!st.open) return json(env, req, { error: "Picks for this week are locked." }, 409);
    const picks = {};
    for (const g of st.games) {
      const t = Number((body.picks || {})[g.id]);
      if (t === g.home || t === g.away) picks[g.id] = t;
    }
    if (!Object.keys(picks).length) return json(env, req, { error: "Pick at least one game." }, 400);
    const err = await checkPin(env, st.season, member, body.pin); // only after the picks are valid, so a bad try never claims a name
    if (err) return json(env, req, { error: err }, 403);
    await env.PICKEM.put(`picks:${st.season}:${st.week}:${member}`, JSON.stringify({ picks, at: new Date().toISOString() }));
    return json(env, req, { ok: true, picks, count: Object.keys(picks).length, of: st.games.length });
  }
  return json(env, req, { error: "Not found" }, 404);
}

// ---------------------------------------------------------------- live big-play feed
// Every minute during NFL games, compare each rostered player's scoring with the last snapshot and turn the
// changes into plays (TDs, field goals, turnovers, defensive plays, big gains). Stored in KV only when a play
// happens (or every 10 minutes), to stay well inside the free plan's daily write limit.

const PLAY = [
  // [stat ids, label, priority]
  [[4], "passing TD", 9], [[25], "rushing TD", 9], [[43], "receiving TD", 9], [[63], "fumble-return TD", 9],
  [[93, 101, 102, 103, 104], "return TD", 9], [[19, 26, 44], "2-pt conversion", 6],
  [[20], "interception thrown", 8], [[72], "fumble lost", 8],
  [[201], "60+ yd field goal", 7], [[198, 74], "50+ yd field goal", 7], [[77], "40-49 yd field goal", 7], [[80], "field goal", 7],
  [[85], "missed field goal", 6], [[88], "missed extra point", 5],
  [[95], "interception", 7], [[96], "fumble recovery", 7], [[98], "safety", 7], [[97], "blocked kick", 7], [[99], "sack", 4],
];

// Yardage gained since the last check: [raw stat id, label, minimum yards to count as a play]
const YARDS = [[42, "receiving yards", 30], [24, "rushing yards", 30], [3, "passing yards", 50]];

function yardagePlay(oldY, newY) {
  if (!oldY) return null; // first snapshot with yardage
  let best = null;
  for (const [id, label, min] of YARDS) {
    const gained = Math.round((newY[id] || 0) - (oldY[id] || 0));
    if (gained >= min && (!best || gained / min > best.ratio)) best = { label: `+${gained} ${label}`, ratio: gained / min };
  }
  return best;
}

function describePlay(oldA, newA) {
  let best = null;
  for (const [ids, label, pri] of PLAY) {
    const changed = ids.some(id => (newA[id] || 0) !== (oldA[id] || 0));
    if (changed && (!best || pri > best.pri)) best = { label, pri };
  }
  return best;
}

async function updateFeed(env) {
  const yr = season();
  const st = (await espn(env, yr, "view=mStatus")).status;
  if (env.FEED_FORCE !== "1" && !(await gamesOn(yr, st.currentMatchupPeriod))) return; // FEED_FORCE: local testing
  const lv = await liveWeek(env);
  const key = `feed:${lv.season}:${lv.week}`;
  const prev = (await env.PICKEM.get(key, "json")) || { snap: {}, events: [], savedAt: 0 };
  const snap = {};
  const events = [];
  for (const g of lv.games) {
    if (g.sides.length !== 2) continue;
    for (const [i, side] of g.sides.entries()) {
      const opp = g.sides[1 - i];
      for (const p of side.lineup) {
        const line = lv.stats[`${lv.week}|${p.id}`] || {};
        const a = line.a || {}, r = line.r || {};
        const y = { 3: r[3] || 0, 24: r[24] || 0, 42: r[42] || 0 };
        snap[p.id] = { p: p.pts, a, y };
        const old = prev.snap[p.id];
        if (!old) continue;
        const delta = Math.round((p.pts - old.p) * 100) / 100;
        if (Math.abs(delta) < 0.05) continue;
        const play = describePlay(old.a, a) || yardagePlay(old.y, y);
        if (!play && delta > -4) continue;                  // small yardage ticks aren't plays
        // (a 4+ point drop with no play behind it is almost always an official stat correction)
        events.push({
          t: Date.now(), game: g.id, team: side.team, opp: opp.team, pid: p.id, name: p.name, pos: p.pos, nfl: p.team,
          starter: !["BE", "IR"].includes(p.slot), label: play ? play.label : "stat correction",
          delta, pts: p.pts, score: [side.pts, opp.pts],
        });
      }
    }
  }
  const stale = Date.now() - (prev.savedAt || 0) > 10 * 60e3;
  if (!events.length && !stale && Object.keys(prev.snap).length) return; // nothing worth a write this minute
  events.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  const all = events.concat(prev.events || []).slice(0, 200);
  await env.PICKEM.put(key, JSON.stringify({ snap, events: all, savedAt: Date.now() }), { expirationTtl: 21 * 86400 });
}

// ---------------------------------------------------------------- trade block
// Each player's trade status uses ESPN's three settings: ON_THE_BLOCK, NORMAL, UNTOUCHABLE.
// ESPN's settings are read automatically. Managers can also change a status here (stored in KV, not sent back to
// ESPN). When the two disagree, the most recent change wins: a site change records what ESPN said at that moment,
// and if ESPN's setting changes after that, ESPN takes over again.
// A team's listing also holds the positions it's looking for and a short note (site only).
const BLOCK_POS = ["QB", "RB", "WR", "TE", "K", "D/ST"];
const STATUSES = ["ON_THE_BLOCK", "NORMAL", "UNTOUCHABLE"];

async function leagueRosters(env, fresh = false) {
  const yr = season();
  const load = async () => {
    const d = await espn(env, yr, "view=mTeam&view=mRoster");
    return { season: yr, teams: (d.teams || []).map(t => ({
      id: t.id, owners: t.owners || [],
      players: ((t.roster || {}).entries || []).map(e => e.playerId),
      espn: ((t.tradeBlock || {}).players) || {},
    })) };
  };
  return fresh ? load() : cached(`rosters-${yr}`, 120, load);
}

function effectiveStatuses(team, listing) {
  const out = {};
  const over = (listing && listing.statuses) || {};
  for (const pid of team.players) {
    const espnNow = team.espn[pid] || "NORMAL";
    const o = over[pid];
    const site = o && o.espnAt === espnNow; // ESPN hasn't changed since the site toggle: the site's setting stands
    const s = site ? o.s : espnNow;
    if (s !== "NORMAL") out[pid] = { s, src: site ? "site" : "espn" };
  }
  return out;
}

async function handleBlock(req, env, url) {
  if (!env.PICKEM) return json(env, req, { error: "Trade block storage isn't set up yet." }, 503);
  if (req.method === "GET" && url.pathname === "/block") {
    const R = await leagueRosters(env);
    const listings = {};
    let cursor;
    do {
      const page = await env.PICKEM.list({ prefix: `block:${R.season}:`, cursor });
      for (const k of page.keys) {
        const v = await env.PICKEM.get(k.name, "json");
        if (v) listings[k.name.split(":")[2]] = v;
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    const statuses = {}, info = {};
    for (const t of R.teams) {
      const l = listings[t.id];
      statuses[t.id] = effectiveStatuses(t, l);
      if (l && (l.needs.length || l.note)) info[t.id] = { needs: l.needs, note: l.note, at: l.at, by: l.by };
    }
    return json(env, req, { season: R.season, statuses, listings: info });
  }
  if (req.method !== "POST" || url.pathname !== "/block/save") return json(env, req, { error: "Not found" }, 404);
  let body;
  try { body = await req.json(); } catch (_) { return json(env, req, { error: "Bad request" }, 400); }
  const R = await leagueRosters(env, true); // compare against ESPN as it is right now
  const member = String(body.member || "");
  const team = R.teams.find(t => t.owners.includes(member));
  if (!team) return json(env, req, { error: "That name doesn't manage a team this season." }, 400);
  const needs = [...new Set((body.needs || []).map(String))].filter(p => BLOCK_POS.includes(p));
  const note = String(body.note || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);
  const err = await checkPin(env, R.season, member, body.pin);
  if (err) return json(env, req, { error: err }, 403);
  const key = `block:${R.season}:${team.id}`;
  const prev = (await env.PICKEM.get(key, "json")) || {};
  const statuses = body.reset ? {} : { ...(prev.statuses || {}) }; // reset: drop every change made here, back to ESPN
  const asked = body.statuses || {};
  for (const pid of team.players) {
    if (!(pid in asked) && !(String(pid) in asked)) continue;
    const want = String(asked[pid] ?? asked[String(pid)]);
    if (!STATUSES.includes(want)) continue;
    const espnNow = team.espn[pid] || "NORMAL";
    if (want === espnNow) delete statuses[pid];        // same as ESPN: nothing to override
    else statuses[pid] = { s: want, espnAt: espnNow, at: new Date().toISOString() };
  }
  for (const pid of Object.keys(statuses)) if (!team.players.includes(Number(pid))) delete statuses[pid]; // left the roster
  if (!Object.keys(statuses).length && !needs.length && !note) {
    await env.PICKEM.delete(key);
  } else {
    await env.PICKEM.put(key, JSON.stringify({ team: team.id, by: member, statuses, needs, note, at: new Date().toISOString() }));
  }
  await caches.default.delete(new Request(`https://cache.local/rosters-${R.season}`));
  return json(env, req, { ok: true, team: team.id, statuses: effectiveStatuses(team, { statuses }) });
}

function cors(env, req) {
  const origin = req.headers.get("Origin") || "";
  const allowed = [env.SITE_ORIGIN, "http://localhost:8765"].includes(origin) ? origin : env.SITE_ORIGIN;
  return { "Access-Control-Allow-Origin": allowed, "Vary": "Origin", "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type" };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(env, req) });
    if (url.pathname.startsWith("/block")) {
      try { return await handleBlock(req, env, url); }
      catch (e) { return json(env, req, { error: String(e.message || e) }, 502); }
    }
    if (url.pathname.startsWith("/pickem")) {
      try { return await handlePickem(req, env, url); }
      catch (e) { return json(env, req, { error: String(e.message || e) }, 502); }
    }
    if (url.pathname !== "/live") return new Response("League HQ live worker. Try /live", { status: 404 });

    const cache = caches.default;
    const key = new Request(url.origin + "/live", { method: "GET" });
    let res = await cache.match(key);
    if (!res) {
      try {
        const lv = await liveWeek(env);
        if (env.PICKEM) {
          const f = await env.PICKEM.get(`feed:${lv.season}:${lv.week}`, "json");
          lv.feed = f ? f.events.slice(0, 80) : [];
        }
        const body = JSON.stringify(lv);
        res = new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_SECONDS}` } });
        ctx.waitUntil(cache.put(key, res.clone()));
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 502, headers: { "Content-Type": "application/json", ...cors(env, req) } });
      }
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors(env, req))) out.headers.set(k, v);
    out.headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
    return out;
  },

  // Reliable scheduled rebuild of the whole site (GitHub's own scheduler skips runs when it's busy).
  async scheduled(event, env, ctx) {
    if (event.cron === "* * * * *") {
      if (env.PICKEM) ctx.waitUntil(updateFeed(env).catch(e => console.log("feed update failed", String(e))));
      return;
    }
    if (!env.GITHUB_TOKEN) return;
    const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "league-hq-live",
        "X-GitHub-Api-Version": "2022-11-28" },
      body: JSON.stringify({ ref: "main" }),
    });
    if (!r.ok) console.log("GitHub dispatch failed", r.status, await r.text());
  },
};
