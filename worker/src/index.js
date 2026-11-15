import { sendPush, vapidPublic } from "./push.js";
import { makeQuiz } from "./trivia.js";
// League HQ live worker.
//
//   GET /live   -> the current week's matchups, lineups and player stat lines, straight from ESPN,
//                  cached for 60 seconds so the whole league refreshing at once is still one ESPN call.
//   cron        -> every minute: the big-play feed, and a GitHub rebuild of the full site whenever anything besides
//                  live scores changes on ESPN (plus every 5 min during games and every 30 min regardless).
//
//   /push/*     -> game-day alerts: subscribe, unsubscribe, test (see "game-day alerts" near the end).
//
// Secrets (set with `wrangler secret put`): ESPN_S2, ESPN_SWID, optionally GITHUB_TOKEN, and VAPID_PRIVATE for alerts.
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
  if (url.pathname === "/pickem/claim") {
    // "My team": check the PIN (setting it on first use, same as pick'em), nothing else
    const err = await checkPin(env, st.season, member, body.pin);
    if (err) return json(env, req, { error: err }, 403);
    return json(env, req, { ok: true });
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
    await pulse(env, st.season, { m: member, k: "pickem", w: st.week });
    return json(env, req, { ok: true, picks, count: Object.keys(picks).length, of: st.games.length });
  }
  return json(env, req, { error: "Not found" }, 404);
}

// ---------------------------------------------------------------- weekly league trivia
// 5 questions a week from the site's own history files, frozen in KV on first request. One try per member per
// week (same name + PIN as pick'em); the season leaderboard is one KV value updated on each submit.

const SITE_DATA = env => env.SITE_DATA || "https://sivanmanikandan0112-sudo.github.io/espn-league/data/";
const parseAssigned = t => JSON.parse(t.slice(t.indexOf('={"') + 1, t.lastIndexOf("}") + 1));

async function triviaQuiz(env, st) {
  const key = `trivia-q:${st.season}:${st.week}`;
  const have = await env.PICKEM.get(key, "json");
  if (have) return have;
  const [ix, rec] = await Promise.all(["index.js", "records.js"].map(f => fetch(SITE_DATA(env) + f, { cf: { cacheTtl: 300 } }).then(r => r.text())));
  const I = parseAssigned(ix), R = parseAssigned(rec);
  const asked = new Set();
  for (let w = 1; w < st.week; w++) {
    const old = await env.PICKEM.get(`trivia-q:${st.season}:${w}`, "json");
    if (old) old.questions.forEach(q => asked.add(q.q));
  }
  const questions = makeQuiz({ ...I.history, seasonsList: I.seasons }, R, st.season, st.week, 5, asked);
  if (questions.length < 5) throw new Error("Couldn't build this week's trivia.");
  const quiz = { season: st.season, week: st.week, made: new Date().toISOString(), questions };
  await env.PICKEM.put(key, JSON.stringify(quiz));
  return quiz;
}

function triviaResult(quiz, answers) {
  return quiz.questions.map((q, i) => ({ yours: answers[i], answer: q.answer, why: q.why }));
}

async function handleTrivia(req, env, url) {
  if (!env.PICKEM) return json(env, req, { error: "Trivia storage isn't set up yet." }, 503);
  const st = await pickemWeek(env);
  if (st.over) return json(env, req, { season: st.season, over: true, board: (await env.PICKEM.get(`trivia-board:${st.season}`, "json")) || {} });
  const quiz = await triviaQuiz(env, st);
  const board = (await env.PICKEM.get(`trivia-board:${st.season}`, "json")) || {};
  if (req.method === "GET" && url.pathname === "/trivia") {
    const submitted = Object.keys(board).filter(m => board[m].weeks && board[m].weeks[st.week] != null);
    return json(env, req, { season: st.season, week: st.week, questions: quiz.questions.map(q => ({ q: q.q, options: q.options, level: q.level })), submitted, board });
  }
  if (req.method !== "POST") return json(env, req, { error: "Not found" }, 404);
  let body;
  try { body = await req.json(); } catch (_) { return json(env, req, { error: "Bad request" }, 400); }
  const member = String(body.member || "");
  if (!st.members.includes(member)) return json(env, req, { error: "That name isn't in the league." }, 400);
  const mineKey = `trivia:${st.season}:${st.week}:${member}`;
  if (url.pathname === "/trivia/mine") {
    if (!(await env.PICKEM.get(`pin:${st.season}:${member}`))) return json(env, req, { submitted: false, newPin: true });
    const err = await checkPin(env, st.season, member, body.pin);
    if (err) return json(env, req, { error: err }, 403);
    const v = await env.PICKEM.get(mineKey, "json");
    return json(env, req, v ? { submitted: true, score: v.score, result: triviaResult(quiz, v.answers) } : { submitted: false });
  }
  if (url.pathname === "/trivia/submit") {
    const answers = quiz.questions.map((q, i) => Number((body.answers || [])[i]));
    if (answers.some((a, i) => !(a >= 0 && a < quiz.questions[i].options.length))) return json(env, req, { error: "Answer every question first." }, 400);
    const err = await checkPin(env, st.season, member, body.pin);
    if (err) return json(env, req, { error: err }, 403);
    const prev = await env.PICKEM.get(mineKey, "json");
    if (prev) return json(env, req, { submitted: true, already: true, score: prev.score, result: triviaResult(quiz, prev.answers) });
    const score = answers.filter((a, i) => a === quiz.questions[i].answer).length;
    await env.PICKEM.put(mineKey, JSON.stringify({ answers, score, at: new Date().toISOString() }));
    const b = (await env.PICKEM.get(`trivia-board:${st.season}`, "json")) || {};
    const row = b[member] = b[member] || { total: 0, weeks: {} };
    row.weeks[st.week] = score;
    row.total = Object.values(row.weeks).reduce((n, x) => n + x, 0);
    await env.PICKEM.put(`trivia-board:${st.season}`, JSON.stringify(b));
    await pulse(env, st.season, { m: member, k: "trivia", w: st.week });
    return json(env, req, { submitted: true, score, result: triviaResult(quiz, answers) });
  }
  return json(env, req, { error: "Not found" }, 404);
}

// ---------------------------------------------------------------- Pick 3 (Games)
// A weekly side game: pick one QB, RB, WR and TE from any NFL team under a salary cap; score = their real fantasy points
// under the league's scoring. Salaries come from ESPN's projection for the week (league scoring), the same price per
// projected point for every position, and move with the news until each player's game starts; a saved pick keeps the
// price it was bought at. Each pick locks at its own
// player's kickoff: you can change a spot only while both the player in it and the one replacing him haven't played.

const P3_PER_PT = 400;        // $ per projected point, every position
const P3_MIN_PROJ = 5;        // players projected under this aren't on the slate
const P3_CAP_SHARE = 0.8;     // cap = 80% of the priciest QB + RB + WR + TE: a star or two, then mid-priced players
const P3_SLOTS = ["QB", "RB", "WR", "TE"];
const P3_REFRESH_MIN = 30;    // re-price from ESPN's latest projections (injury news) this often during the week
// two versions share all of this: "all" (any NFL player) and "fa" (the waiver wire challenge: only players who were
// free agents or on waivers in this league when the week's slate opened). Each has its own slate, entries and season.
const P3_MODES = {
  all: { prefix: "p3", slate: "p3-slate4", minProj: P3_MIN_PROJ, fa: false },
  fa: { prefix: "p3fa", slate: "p3fa-slate", minProj: 3, fa: true },
};

async function espnFiltered(env, yr, params, filter) {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${yr}/segments/0/leagues/${env.LEAGUE_ID}?${params}`;
  const r = await fetch(url, { headers: { Cookie: `espn_s2=${env.ESPN_S2}; SWID=${env.ESPN_SWID}`, "User-Agent": "league-hq-live",
    "X-Fantasy-Filter": JSON.stringify(filter) } });
  if (r.status === 401) throw new Error("ESPN login expired");
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  return r.json();
}

// scoring period -> pro team id -> { at: kickoff ms, opp: "vs NYG" / "@ DAL" }
async function proGames(yr) {
  return cached(`pro-games-${yr}`, 6 * 3600, async () => {
    const r = await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${yr}?view=proTeamSchedules_wl`);
    const d = await r.json();
    const out = {};
    for (const t of d.settings.proTeams) {
      for (const [sp, games] of Object.entries(t.proGamesByScoringPeriod || {})) {
        const g = games[0];
        if (!g) continue;
        const home = g.homeProTeamId === t.id, other = home ? g.awayProTeamId : g.homeProTeamId;
        (out[sp] = out[sp] || {})[t.id] = { at: g.date, opp: `${home ? "vs" : "@"} ${PRO[other] || "?"}` };
      }
    }
    return out;
  });
}

// The week's slate: made when the week opens, then re-priced every P3_REFRESH_MIN minutes from ESPN's latest
// projections (which move with injury news) until the last game kicks off. A player's price stops moving once his
// game starts. Injury status rides along (Q / D / OUT); OUT players can't be added. The waiver wire version also
// re-checks who's unrostered: newly dropped players join, players picked up in the league leave (but stay in any
// lineup that already has them). The cap is set once, when the week opens.
async function p3Slate(env, st, cfg) {
  const key = `${cfg.slate}:${st.season}:${st.week}`;
  const have = await env.PICKEM.get(key, "json");
  const now = Date.now();
  if (have) {
    const fresh = now - Date.parse(have.made) < P3_REFRESH_MIN * 60e3;
    const allStarted = have.players.length && have.players.every(p => now >= p.at);
    if (fresh || allStarted) return have;
  }
  const status = (await espn(env, st.season, "view=mStatus")).status;
  const sp = have ? have.sp : status.latestScoringPeriod;
  const games = (await proGames(st.season))[String(sp)] || {};
  const prev = Object.fromEntries(((have && have.players) || []).map(p => [p.id, p]));
  // the same query the site build uses for the player pool (it carries this week's projections)
  const d = await espnFiltered(env, st.season, `view=kona_player_info&scoringPeriodId=${sp}`, { players: {
    filterSlotIds: { value: [0, 2, 4, 6] }, limit: 600, sortPercOwned: { sortPriority: 1, sortAsc: false } } });
  const players = [], seen = new Set();
  for (const e of d.players || []) {
    const p = e.player || {};
    const pos = POS[p.defaultPositionId];
    if (!P3_SLOTS.includes(pos)) continue;
    const old = prev[p.id];
    if (old && now >= old.at) continue; // his game has started: keep the old record below, price frozen
    if (cfg.fa && e.onTeamId) continue; // waiver wire: unrostered players only (picked-up players drop off)
    if (["INJURY_RESERVE", "SUSPENSION"].includes(p.injuryStatus)) continue;
    const g = games[p.proTeamId];
    if (!g) continue; // bye
    const line = (p.stats || []).find(x => x.statSourceId === 1 && x.scoringPeriodId === sp && x.seasonId === st.season);
    const proj = line ? line.appliedTotal || 0 : 0;
    const out = p.injuryStatus === "OUT";
    // new players need the minimum projection; players already listed stay (re-priced, or marked out)
    if (!old && (out || proj < cfg.minProj)) continue;
    const sal = Math.max(1000, Math.round(proj * P3_PER_PT / 100) * 100);
    const inj = { QUESTIONABLE: "Q", DOUBTFUL: "D", OUT: "OUT" }[p.injuryStatus] || "";
    players.push({ id: p.id, n: p.fullName, pos, team: PRO[p.proTeamId] || "", opp: g.opp, at: g.at,
      proj: Math.round(proj * 10) / 10, sal: out && old ? old.sal : sal, sal0: old ? (old.sal0 || old.sal) : sal, inj });
    seen.add(p.id);
  }
  for (const old of Object.values(prev)) if (!seen.has(old.id) && now >= old.at) players.push(old); // started: frozen
  players.sort((a, b) => b.sal - a.sal || a.n.localeCompare(b.n));
  let cap = have && have.cap;
  if (!cap) {
    const top = P3_SLOTS.map(pos => (players.find(x => x.pos === pos) || { sal: 0 }).sal);
    if (top.some(x => !x)) throw new Error("This week's Pick 4 players aren't ready yet (no ESPN projections). Try again soon.");
    cap = Math.round(P3_CAP_SHARE * top.reduce((a, b) => a + b, 0) / 500) * 500;
  }
  const slate = { season: st.season, week: st.week, sp, cap, perPt: P3_PER_PT, fa: cfg.fa, opened: (have && (have.opened || have.made)) || new Date().toISOString(),
    made: new Date().toISOString(), players };
  await env.PICKEM.put(key, JSON.stringify(slate));
  return slate;
}

// real fantasy points (league scoring) for these players in scoring period sp, cached a minute
async function p3Points(env, yr, sp, ids) {
  if (!ids.length) return {};
  const key = `p3-pts-${yr}-${sp}-${ids.slice().sort((a, b) => a - b).join(",")}`;
  return cached(key, 60, async () => {
    const d = await espnFiltered(env, yr, `view=kona_player_info&scoringPeriodId=${sp}`, { players: { filterIds: { value: ids } } });
    const out = {};
    for (const e of d.players || []) {
      const p = e.player || {};
      const line = (p.stats || []).find(x => x.statSourceId === 0 && x.scoringPeriodId === sp && x.seasonId === yr);
      out[p.id] = line ? Math.round((line.appliedTotal || 0) * 100) / 100 : 0;
    }
    return out;
  });
}

// a saved pick is a snapshot of the player at the price paid ({id, sal, n, pos, team, opp, at}); early entries
// stored just the id, priced at the week's opening price
const P3_SNAP = ["id", "sal", "n", "pos", "team", "opp", "at"];
function p3Norm(x, byId) {
  if (!x) return null;
  if (typeof x === "number") { const p = byId[x] || {}; return { id: x, sal: p.sal0 || p.sal || 0, n: p.n, pos: p.pos, team: p.team, opp: p.opp, at: p.at }; }
  return x;
}

async function p3Finalize(env, st, cfg) {
  // weeks with entries that are now over get their final scores written into the season record once
  const sKey = `${cfg.prefix}-season:${st.season}`;
  const S = (await env.PICKEM.get(sKey, "json")) || { weeks: {}, open: [] };
  const due = S.open.filter(w => w < st.week);
  if (!due.length) return S;
  for (const w of due) {
    const E = (await env.PICKEM.get(`${cfg.prefix}-entries:${st.season}:${w}`, "json")) || {};
    const slate = await env.PICKEM.get(`${cfg.slate}:${st.season}:${w}`, "json");
    if (!slate) continue;
    const byId = Object.fromEntries(slate.players.map(p => [p.id, p]));
    const picks = x => P3_SLOTS.map(k => p3Norm(x[k], byId)).filter(Boolean);
    const ids = [...new Set(Object.values(E).flatMap(x => picks(x).map(p => p.id)))];
    const pts = await p3Points(env, st.season, slate.sp, ids);
    S.weeks[w] = Object.fromEntries(Object.entries(E).map(([m, x]) => [m, {
      pts: Math.round(picks(x).reduce((n, p) => n + (pts[p.id] || 0), 0) * 100) / 100,
      sal: picks(x).reduce((n, p) => n + p.sal, 0) }]));
  }
  S.open = S.open.filter(w => !due.includes(w));
  await env.PICKEM.put(sKey, JSON.stringify(S));
  return S;
}

async function handlePick3(req, env, url) {
  if (!env.PICKEM) return json(env, req, { error: "Pick 4 storage isn't set up yet." }, 503);
  const st = await pickemWeek(env);
  let body = null;
  if (req.method === "POST") { try { body = await req.json(); } catch (_) { return json(env, req, { error: "Bad request" }, 400); } }
  const mode = (body ? body.mode : url.searchParams.get("mode")) === "fa" ? "fa" : "all";
  const cfg = P3_MODES[mode];
  const S = await p3Finalize(env, st, cfg);
  if (st.over) return json(env, req, { season: st.season, mode, over: true, history: S.weeks });
  const slate = await p3Slate(env, st, cfg);
  const now = Date.now();
  const byId = Object.fromEntries(slate.players.map(p => [p.id, p]));
  const started = x => x && x.at != null && now >= x.at;
  const eKey = `${cfg.prefix}-entries:${st.season}:${st.week}`;
  const E = (await env.PICKEM.get(eKey, "json")) || {};
  const norm = x => Object.fromEntries(P3_SLOTS.map(k => [k, p3Norm(x[k], byId)]));
  if (req.method === "GET" && url.pathname === "/pick3") {
    const ids = [...new Set(Object.values(E).flatMap(x => Object.values(norm(x)).filter(p => p && started(p)).map(p => p.id)))];
    const pts = await p3Points(env, st.season, slate.sp, ids);
    // other people's players show only once that player's game has started (it's locked by then)
    const entries = Object.fromEntries(Object.entries(E).map(([m, x]) => { const n = norm(x); return [m, Object.fromEntries(P3_SLOTS.map(k => [k,
      !n[k] ? null : started(n[k]) ? { id: n[k].id, n: n[k].n, pts: pts[n[k].id] || 0 } : { hidden: true }]))]; }));
    return json(env, req, { season: st.season, mode, week: st.week, cap: slate.cap, perPt: slate.perPt, made: slate.made, opened: slate.opened || slate.made,
      refreshMin: P3_REFRESH_MIN, now, players: slate.players, entries, history: S.weeks });
  }
  if (req.method !== "POST") return json(env, req, { error: "Not found" }, 404);
  const member = String(body.member || "");
  if (!st.members.includes(member)) return json(env, req, { error: "That name isn't in the league." }, 400);
  const mine = norm(E[member] || {});
  const withPts = async x => {
    const ids = P3_SLOTS.map(k => x[k]).filter(p => p && started(p)).map(p => p.id);
    const pts = await p3Points(env, st.season, slate.sp, ids);
    return Object.fromEntries(P3_SLOTS.map(k => [k, x[k] ? { ...x[k], pts: started(x[k]) ? pts[x[k].id] || 0 : null } : null]));
  };
  if (url.pathname === "/pick3/mine") {
    if (!(await env.PICKEM.get(`pin:${st.season}:${member}`))) return json(env, req, { picks: {}, newPin: true });
    const err = await checkPin(env, st.season, member, body.pin);
    if (err) return json(env, req, { error: err }, 403);
    return json(env, req, { picks: await withPts(mine) });
  }
  if (url.pathname === "/pick3/save") {
    // a spot you don't change keeps the player at the price you paid; a new player costs today's price
    const next = {};
    for (const k of P3_SLOTS) {
      const id = Number((body.picks || {})[k]) || null;
      const cur = mine[k];
      if (cur && id === cur.id) { next[k] = cur; continue; }
      if (cur && started(cur)) return json(env, req, { error: `${cur.n}'s game has started, so your ${k} is locked.` }, 409);
      if (!id) { next[k] = null; continue; }
      const p = byId[id];
      if (!p || p.pos !== k) return json(env, req, { error: cfg.fa ? `That ${k} isn't available on the waiver wire anymore.` : `That ${k} isn't on this week's list.` }, 400);
      if (started(p)) return json(env, req, { error: `${p.n}'s game has already started. Pick someone who hasn't played yet.` }, 409);
      if (p.inj === "OUT") return json(env, req, { error: `${p.n} has been ruled out this week.` }, 400);
      next[k] = Object.fromEntries(P3_SNAP.map(f => [f, p[f]]));
    }
    const total = P3_SLOTS.reduce((n, k) => n + (next[k] ? next[k].sal : 0), 0);
    if (total > slate.cap) return json(env, req, { error: `That's $${total.toLocaleString()}, over the $${slate.cap.toLocaleString()} cap.` }, 400);
    if (!P3_SLOTS.some(k => next[k])) return json(env, req, { error: "Pick at least one player." }, 400);
    const err = await checkPin(env, st.season, member, body.pin);
    if (err) return json(env, req, { error: err }, 403);
    const fresh = (await env.PICKEM.get(eKey, "json")) || {};
    fresh[member] = { ...next, at: new Date().toISOString() };
    await env.PICKEM.put(eKey, JSON.stringify(fresh));
    await pulse(env, st.season, { m: member, k: cfg.fa ? "fa" : "pick4", w: st.week });
    if (!S.open.includes(st.week)) {
      const S2 = (await env.PICKEM.get(`${cfg.prefix}-season:${st.season}`, "json")) || { weeks: {}, open: [] };
      if (!S2.open.includes(st.week)) { S2.open.push(st.week); await env.PICKEM.put(`${cfg.prefix}-season:${st.season}`, JSON.stringify(S2)); }
    }
    return json(env, req, { ok: true, picks: await withPts(next), salary: total });
  }
  return json(env, req, { error: "Not found" }, 404);
}

// ---------------------------------------------------------------- Bullseye and Rank 'em (Games)
// Both borrow Pick 4's weekly player list (ESPN's projections under league scoring, injury tags, kickoff times), so
// they add no ESPN calls beyond the points lookups. Same name + PIN as every other game.

// a small seeded random generator, so a week's target / players are the same no matter who asks first
function seeded(str) {
  let h = 2166136261;
  for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1e6) / 1e6; };
}
const round2 = n => Math.round(n * 100) / 100;

// weeks that had entries get their final results written into the season record once the week is over
async function gameFinalize(env, st, prefix, score) {
  const sKey = `${prefix}-season:${st.season}`;
  const S = (await env.PICKEM.get(sKey, "json")) || { weeks: {}, open: [] };
  const due = S.open.filter(w => w < st.week);
  if (!due.length) return S;
  for (const w of due) { const r = await score(w); if (r) S.weeks[w] = r; }
  S.open = S.open.filter(w => !due.includes(w));
  await env.PICKEM.put(sKey, JSON.stringify(S));
  return S;
}
async function markOpen(env, prefix, season, week) {
  const sKey = `${prefix}-season:${season}`;
  const S = (await env.PICKEM.get(sKey, "json")) || { weeks: {}, open: [] };
  if (!S.open.includes(week)) { S.open.push(week); await env.PICKEM.put(sKey, JSON.stringify(S)); }
}
async function postBody(req) { try { return await req.json(); } catch (_) { return null; } }

// Bullseye: a random target each week (40.0-70.0). Pick up to 5 players whose real points add up as close to it as
// possible without going over. Each player locks at his own kickoff, like Pick 4.
const BULL_MAX = 5;
const BULL_SNAP = ["id", "n", "pos", "team", "opp", "at", "proj"];
const bullTarget = (season, week) => 40 + Math.floor(seeded(`bull|${season}|${week}`)() * 61) / 2;

async function handleBull(req, env, url) {
  if (!env.PICKEM) return json(env, req, { error: "Game storage isn't set up yet." }, 503);
  const st = await pickemWeek(env);
  const body = req.method === "POST" ? await postBody(req) : null;
  if (req.method === "POST" && !body) return json(env, req, { error: "Bad request" }, 400);
  const S = await gameFinalize(env, st, "bull", async w => {
    const E = await env.PICKEM.get(`bull-entries:${st.season}:${w}`, "json");
    if (!E) return null;
    const ids = [...new Set(Object.values(E.e).flatMap(x => x.picks.map(p => p.id)))];
    const pts = await p3Points(env, st.season, E.sp, ids);
    return { target: E.target, rows: Object.fromEntries(Object.entries(E.e).map(([m, x]) => [m, round2(x.picks.reduce((n, p) => n + (pts[p.id] || 0), 0))])) };
  });
  if (st.over) return json(env, req, { season: st.season, over: true, history: S.weeks });
  const slate = await p3Slate(env, st, P3_MODES.all);
  const target = bullTarget(st.season, st.week);
  const now = Date.now();
  const started = p => p && p.at != null && now >= p.at;
  const byId = Object.fromEntries(slate.players.map(p => [p.id, p]));
  const eKey = `bull-entries:${st.season}:${st.week}`;
  const E = (await env.PICKEM.get(eKey, "json")) || { sp: slate.sp, target, e: {} };
  const ptsFor = async picks => p3Points(env, st.season, slate.sp, [...new Set(picks.filter(started).map(p => p.id))]);
  if (req.method === "GET" && url.pathname === "/bull") {
    const pts = await ptsFor(Object.values(E.e).flatMap(x => x.picks));
    // other people's players show once that player's game has started (he's locked by then)
    const entries = Object.fromEntries(Object.entries(E.e).map(([m, x]) => [m, x.picks.map(p => started(p) ? { id: p.id, n: p.n, pos: p.pos, pts: pts[p.id] || 0 } : { hidden: true })]));
    const players = slate.players.map(p => ({ id: p.id, n: p.n, pos: p.pos, team: p.team, opp: p.opp, at: p.at, proj: p.proj, inj: p.inj }));
    return json(env, req, { season: st.season, week: st.week, target, max: BULL_MAX, now, made: slate.made, players, entries, history: S.weeks });
  }
  if (req.method !== "POST") return json(env, req, { error: "Not found" }, 404);
  const member = String(body.member || "");
  if (!st.members.includes(member)) return json(env, req, { error: "That name isn't in the league." }, 400);
  const mine = (E.e[member] || { picks: [] }).picks;
  const withPts = async picks => { const pts = await ptsFor(picks); return picks.map(p => ({ ...p, pts: started(p) ? pts[p.id] || 0 : null })); };
  if (url.pathname === "/bull/mine") {
    if (!(await env.PICKEM.get(`pin:${st.season}:${member}`))) return json(env, req, { picks: [], newPin: true });
    const err = await checkPin(env, st.season, member, body.pin);
    if (err) return json(env, req, { error: err }, 403);
    return json(env, req, { picks: await withPts(mine) });
  }
  if (url.pathname === "/bull/save") {
    const want = [...new Set((Array.isArray(body.picks) ? body.picks : []).map(Number).filter(Boolean))];
    if (want.length > BULL_MAX) return json(env, req, { error: `Pick at most ${BULL_MAX} players.` }, 400);
    for (const p of mine) if (started(p) && !want.includes(p.id)) return json(env, req, { error: `${p.n}'s game has started, so he stays in.` }, 409);
    const next = [];
    for (const id of want) {
      const have = mine.find(p => p.id === id);
      if (have) { next.push(have); continue; }
      const p = byId[id];
      if (!p) return json(env, req, { error: "That player isn't on this week's list." }, 400);
      if (started(p)) return json(env, req, { error: `${p.n}'s game has already started. Pick someone who hasn't played yet.` }, 409);
      if (p.inj === "OUT") return json(env, req, { error: `${p.n} has been ruled out this week.` }, 400);
      next.push(Object.fromEntries(BULL_SNAP.map(f => [f, p[f]])));
    }
    if (!next.length) return json(env, req, { error: "Pick at least one player." }, 400);
    const err = await checkPin(env, st.season, member, body.pin);
    if (err) return json(env, req, { error: err }, 403);
    const fresh = (await env.PICKEM.get(eKey, "json")) || { sp: slate.sp, target, e: {} };
    fresh.e[member] = { picks: next, at: new Date().toISOString() };
    await env.PICKEM.put(eKey, JSON.stringify(fresh));
    await pulse(env, st.season, { m: member, k: "bull", w: st.week });
    await markOpen(env, "bull", st.season, st.week);
    return json(env, req, { ok: true, picks: await withPts(next) });
  }
  return json(env, req, { error: "Not found" }, 404);
}

// Rank 'em: five players at one position (QB, RB, WR, TE in turn by week) with close projections, all playing Sunday
// or later. Put them in order of the points they'll score; everything locks at the first of their kickoffs.
// 3 points for each player in exactly the right spot, 1 for one spot off (tied players share their spots), 15 max.
const RANK_POS = ["QB", "RB", "WR", "TE"];
async function rankSlate(env, st) {
  const key = `rank-slate:${st.season}:${st.week}`;
  const have = await env.PICKEM.get(key, "json");
  if (have) return have;
  const P = await p3Slate(env, st, P3_MODES.all);
  const now = Date.now();
  const sunday = Math.min(...P.players.map(p => p.at).filter(a => new Date(a - 5 * 3600e3).getUTCDay() === 0));
  const pos = RANK_POS[st.week % 4];
  const rand = seeded(`rank|${st.season}|${st.week}`);
  const pool = P.players.filter(p => p.pos === pos && p.inj !== "OUT" && p.at >= sunday && p.at > now + 3600e3)
    .sort((a, b) => b.proj - a.proj).slice(0, pos === "QB" || pos === "TE" ? 16 : 30);
  let slate;
  if (pool.length < 5) slate = { none: true, pos };
  else {
    // a run of 8 neighbours by projection, then 5 of them: close enough that the order isn't obvious
    const start = Math.floor(rand() * (pool.length - Math.min(8, pool.length) + 1));
    const win = pool.slice(start, start + 8);
    while (win.length > 5) win.splice(Math.floor(rand() * win.length), 1);
    const players = win.map(p => ({ id: p.id, n: p.n, pos: p.pos, team: p.team, opp: p.opp, at: p.at, proj: p.proj }))
      .sort((a, b) => a.n.localeCompare(b.n));
    slate = { pos, sp: P.sp, lock: Math.min(...players.map(p => p.at)), players };
  }
  await env.PICKEM.put(key, JSON.stringify(slate));
  return slate;
}
function rankScore(order, players, pts) {
  const vals = players.map(p => pts[p.id] || 0);
  return order.reduce((score, id, i) => {
    const v = pts[id] || 0, hi = vals.filter(x => x > v).length, lo = hi + vals.filter(x => x === v).length - 1;
    const d = i < hi ? hi - i : i > lo ? i - lo : 0;
    return score + (d === 0 ? 3 : d === 1 ? 1 : 0);
  }, 0);
}

async function handleRank(req, env, url) {
  if (!env.PICKEM) return json(env, req, { error: "Game storage isn't set up yet." }, 503);
  const st = await pickemWeek(env);
  const body = req.method === "POST" ? await postBody(req) : null;
  if (req.method === "POST" && !body) return json(env, req, { error: "Bad request" }, 400);
  const S = await gameFinalize(env, st, "rank", async w => {
    const sl = await env.PICKEM.get(`rank-slate:${st.season}:${w}`, "json");
    const E = await env.PICKEM.get(`rank-entries:${st.season}:${w}`, "json");
    if (!sl || sl.none || !E) return null;
    const pts = await p3Points(env, st.season, sl.sp, sl.players.map(p => p.id));
    return { pos: sl.pos, rows: Object.fromEntries(Object.entries(E).map(([m, x]) => [m, rankScore(x.order, sl.players, pts)])) };
  });
  if (st.over) return json(env, req, { season: st.season, over: true, history: S.weeks });
  const sl = await rankSlate(env, st);
  const now = Date.now();
  const eKey = `rank-entries:${st.season}:${st.week}`;
  const E = (await env.PICKEM.get(eKey, "json")) || {};
  const locked = !sl.none && now >= sl.lock;
  const pts = locked ? await p3Points(env, st.season, sl.sp, sl.players.map(p => p.id)) : {};
  if (req.method === "GET" && url.pathname === "/rank") {
    if (sl.none) return json(env, req, { season: st.season, week: st.week, none: true, pos: sl.pos, history: S.weeks });
    // nobody's order shows until everything locks
    const entries = Object.fromEntries(Object.entries(E).map(([m, x]) => [m, locked ? { order: x.order, score: rankScore(x.order, sl.players, pts) } : { done: true }]));
    const players = sl.players.map(p => ({ ...p, pts: locked ? (now >= p.at ? pts[p.id] || 0 : null) : undefined }));
    return json(env, req, { season: st.season, week: st.week, pos: sl.pos, lock: sl.lock, locked, now, players, entries, history: S.weeks });
  }
  if (req.method !== "POST") return json(env, req, { error: "Not found" }, 404);
  const member = String(body.member || "");
  if (!st.members.includes(member)) return json(env, req, { error: "That name isn't in the league." }, 400);
  if (url.pathname === "/rank/mine") {
    if (!(await env.PICKEM.get(`pin:${st.season}:${member}`))) return json(env, req, { order: null, newPin: true });
    const err = await checkPin(env, st.season, member, body.pin);
    if (err) return json(env, req, { error: err }, 403);
    return json(env, req, { order: E[member] ? E[member].order : null });
  }
  if (url.pathname === "/rank/save") {
    if (sl.none) return json(env, req, { error: "There's no Rank 'em this week." }, 409);
    if (locked) return json(env, req, { error: "This week's Rank 'em has locked." }, 409);
    const order = (Array.isArray(body.order) ? body.order : []).map(Number);
    const ids = sl.players.map(p => p.id);
    if (order.length !== ids.length || new Set(order).size !== ids.length || !order.every(id => ids.includes(id)))
      return json(env, req, { error: "Put all five players in order." }, 400);
    const err = await checkPin(env, st.season, member, body.pin);
    if (err) return json(env, req, { error: err }, 403);
    const fresh = (await env.PICKEM.get(eKey, "json")) || {};
    fresh[member] = { order, at: new Date().toISOString() };
    await env.PICKEM.put(eKey, JSON.stringify(fresh));
    await pulse(env, st.season, { m: member, k: "rank", w: st.week });
    await markOpen(env, "rank", st.season, st.week);
    return json(env, req, { ok: true, order });
  }
  return json(env, req, { error: "Not found" }, 404);
}

// ---------------------------------------------------------------- Guess the graph (Games)
// Three puzzles a week (easy, medium, hard): one player's fantasy points in every completed week as a bar chart, his
// position, and 4 names to choose from. No team shown. The pool is the site's data/graph.json (most-owned QBs, RBs,
// WRs and TEs with weekly points, written by the site build); the week's puzzles are picked here with a secret seed,
// frozen in KV, and the answer only comes back after you guess. One guess per puzzle; 1 / 2 / 3 points.
const GRAPH_LEVELS = ["easy", "medium", "hard"];
const GRAPH_PTS = { easy: 1, medium: 2, hard: 3 };
async function graphQuiz(env, st) {
  const key = `graph-q:${st.season}:${st.week}`;
  const have = await env.PICKEM.get(key, "json");
  if (have) return have;
  const r = await fetch(SITE_DATA(env) + "graph.json?t=" + Date.now());
  const G = r.ok ? await r.json() : null;
  if (!G || G.season !== st.season || !(G.players || []).length) throw new Error("This week's graphs aren't ready yet. Try again soon.");
  const usedKey = `graph-used:${st.season}`;
  const used = new Set((await env.PICKEM.get(usedKey, "json")) || []);
  const rand = seeded(`graph|${env.PIN_SALT || "league-hq"}|${st.season}|${st.week}`);
  const shuffle = a => { const x = a.slice(); for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
  const tot = p => p.w.reduce((n, v) => n + (v || 0), 0);
  const byPos = {};
  for (const p of G.players) (byPos[p.pos] = byPos[p.pos] || []).push(p);
  for (const k in byPos) byPos[k].sort((a, b) => tot(b) - tot(a));
  const range = (list, a, b) => list.slice(Math.min(a, Math.max(0, list.length - 4)), Math.min(b, list.length));
  // easy: a top-6 player against three low scorers; medium: a top-16 player against players ranked near him;
  // hard: a deeper player against the three whose season totals are closest to his
  const plan = {
    easy: list => ({ from: range(list, 0, 6), others: ans => range(list, 18, 40).filter(p => p !== ans) }),
    medium: list => ({ from: range(list, 4, 16), others: ans => { const i = list.indexOf(ans); return list.slice(Math.max(0, i - 6), i + 7).filter(p => p !== ans); } }),
    hard: list => ({ from: range(list, 10, 32), others: ans => list.filter(p => p !== ans).sort((a, b) => Math.abs(tot(a) - tot(ans)) - Math.abs(tot(b) - tot(ans))).slice(0, 3) }),
  };
  const positions = shuffle(["QB", "RB", "WR", "TE"].filter(k => (byPos[k] || []).length >= 8));
  const puzzles = GRAPH_LEVELS.map((level, i) => {
    const pos = positions[i % positions.length], list = byPos[pos];
    const P = plan[level](list);
    const fresh = P.from.filter(p => !used.has(p.id));
    const ans = (fresh.length ? fresh : P.from)[Math.floor(rand() * (fresh.length || P.from.length))];
    const others = shuffle(P.others(ans)).slice(0, 3);
    used.add(ans.id);
    return { level, pos, through: G.through, w: ans.w, answer: ans.id, options: shuffle([ans, ...others]).map(p => ({ id: p.id, n: p.n })) };
  });
  const quiz = { season: st.season, week: st.week, made: new Date().toISOString(), puzzles };
  await env.PICKEM.put(key, JSON.stringify(quiz));
  await env.PICKEM.put(usedKey, JSON.stringify([...used]));
  return quiz;
}
async function handleGraph(req, env, url) {
  if (!env.PICKEM) return json(env, req, { error: "Game storage isn't set up yet." }, 503);
  const st = await pickemWeek(env);
  const body = req.method === "POST" ? await postBody(req) : null;
  if (req.method === "POST" && !body) return json(env, req, { error: "Bad request" }, 400);
  const board = (await env.PICKEM.get(`graph-board:${st.season}`, "json")) || {};
  if (st.over) return json(env, req, { season: st.season, over: true, board });
  const quiz = await graphQuiz(env, st);
  const aKey = `graph-a:${st.season}:${st.week}`;
  const A = (await env.PICKEM.get(aKey, "json")) || {};
  const ansOf = lvl => quiz.puzzles.find(p => p.level === lvl);
  const reveal = (m) => Object.fromEntries(Object.entries(A[m] || {}).map(([lvl, id]) => {
    const p = ansOf(lvl), right = p.options.find(o => o.id === p.answer);
    return [lvl, { guess: id, right: id === p.answer, answer: p.answer, name: right ? right.n : "" }];
  }));
  if (req.method === "GET" && url.pathname === "/graph") {
    // everyone's results this week, without which name they chose
    const results = Object.fromEntries(Object.entries(A).map(([m, g]) => [m, Object.fromEntries(Object.entries(g).map(([lvl, id]) => [lvl, id === ansOf(lvl).answer]))]));
    return json(env, req, { season: st.season, week: st.week, puzzles: quiz.puzzles.map(({ answer, ...p }) => p), results, board, pts: GRAPH_PTS });
  }
  if (req.method !== "POST") return json(env, req, { error: "Not found" }, 404);
  const member = String(body.member || "");
  if (!st.members.includes(member)) return json(env, req, { error: "That name isn't in the league." }, 400);
  if (url.pathname === "/graph/mine") {
    if (!(await env.PICKEM.get(`pin:${st.season}:${member}`))) return json(env, req, { guesses: {}, newPin: true });
    const err = await checkPin(env, st.season, member, body.pin);
    if (err) return json(env, req, { error: err }, 403);
    return json(env, req, { guesses: reveal(member) });
  }
  if (url.pathname === "/graph/guess") {
    const level = String(body.level || ""), id = Number(body.id);
    const p = ansOf(level);
    if (!p) return json(env, req, { error: "No such puzzle." }, 400);
    if (!p.options.some(o => o.id === id)) return json(env, req, { error: "Pick one of the four names." }, 400);
    const err = await checkPin(env, st.season, member, body.pin);
    if (err) return json(env, req, { error: err }, 403);
    const fresh = (await env.PICKEM.get(aKey, "json")) || {};
    if (fresh[member] && fresh[member][level] != null) return json(env, req, { error: "You've already guessed this one.", guesses: reveal(member) }, 409);
    (fresh[member] = fresh[member] || {})[level] = id;
    await env.PICKEM.put(aKey, JSON.stringify(fresh));
    const B = (await env.PICKEM.get(`graph-board:${st.season}`, "json")) || {};
    const row = B[member] = B[member] || { total: 0, right: 0, tries: 0, weeks: {} };
    const right = id === p.answer;
    row.tries++; if (right) { row.right++; row.weeks[st.week] = (row.weeks[st.week] || 0) + GRAPH_PTS[level]; }
    row.total = Object.values(row.weeks).reduce((n, x) => n + x, 0);
    await env.PICKEM.put(`graph-board:${st.season}`, JSON.stringify(B));
    A[member] = fresh[member];
    await pulse(env, st.season, { m: member, k: "graph", w: st.week });
    return json(env, req, { ok: true, right, guesses: reveal(member), board: B });
  }
  return json(env, req, { error: "Not found" }, 404);
}

// ---------------------------------------------------------------- Big-play leaderboard (season)
// Season totals from the live big-play feed. Weeks 1-8 of 2026 (before the feed existed) were rebuilt once from ESPN's
// public NFL play-by-play with the feed's own rules, checked against each player's official stats, and stored the same
// way (see README). The feed itself expires 3 weeks after it's written, so each finished week
// is copied once (trimmed, without stat corrections) into `plays-week:<season>:<week>` and kept; the week in progress
// is read straight from its feed. The aggregate is cached for 2 minutes.
const trimPlays = events => (events || []).filter(e => e.kind !== "stat correction" && e.label !== "stat correction")
  .map(e => ({ t: e.t, team: e.team, pid: e.pid, name: e.name, pos: e.pos, nfl: e.nfl, kind: e.kind, label: e.label, delta: e.delta, starter: e.starter, game: e.game }));
async function handlePlays(req, env) {
  if (!env.PICKEM) return json(env, req, { error: "Storage isn't set up yet." }, 503);
  const st = await pickemWeek(env);
  const out = await cached(`plays-season-${st.season}-${st.week}`, 120, async () => {
    const weeks = [];
    for (let w = 1; w <= st.week; w++) {
      let ev = null;
      if (w < st.week) {
        ev = await env.PICKEM.get(`plays-week:${st.season}:${w}`, "json");
        if (!ev) {
          const f = await env.PICKEM.get(`feed:${st.season}:${w}`, "json");
          if (f) { ev = trimPlays(f.events); await env.PICKEM.put(`plays-week:${st.season}:${w}`, JSON.stringify(ev)); }
        }
      } else {
        const f = await env.PICKEM.get(`feed:${st.season}:${w}`, "json");
        if (f) ev = trimPlays(f.events);
      }
      if (ev) weeks.push({ week: w, plays: ev });
    }
    const teams = {}, players = {};
    const all = [];
    for (const { week, plays } of weeks) for (const e of plays) {
      if (e.label === "stat correction") continue;
      all.push({ ...e, week });
      const T = teams[e.team] = teams[e.team] || { team: e.team, plays: 0, tds: 0, pts: 0, bench: 0, benchPts: 0 };
      if (e.starter) { T.plays++; T.pts += e.delta; if (/TD/.test(e.kind)) T.tds++; }
      else { T.bench++; T.benchPts += e.delta; }
      const P = players[e.pid] = players[e.pid] || { pid: e.pid, name: e.name, pos: e.pos, nfl: e.nfl, plays: 0, tds: 0, pts: 0, teams: [] };
      P.plays++; P.pts += e.delta; if (/TD/.test(e.kind)) P.tds++;
      if (!P.teams.includes(e.team)) P.teams.push(e.team);
    }
    const r1 = n => Math.round(n * 10) / 10;
    return { season: st.season, weeks: weeks.map(w => w.week), current: st.week,
      teams: Object.values(teams).map(T => ({ ...T, pts: r1(T.pts), benchPts: r1(T.benchPts) })).sort((a, b) => b.plays - a.plays || b.pts - a.pts),
      players: Object.values(players).map(P => ({ ...P, pts: r1(P.pts) })).sort((a, b) => b.plays - a.plays || b.pts - a.pts).slice(0, 10),
      biggest: all.filter(e => e.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 10),
      benchBest: all.filter(e => !e.starter && e.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 5) };
  });
  return json(env, req, out);
}

// ---------------------------------------------------------------- Feedback box
// "Suggest something / report a problem" from the site footer. Messages go into one private KV list that only the
// members in ADMIN_MEMBERS can read (with their PIN); they never appear in League pulse. A message is from a named
// member only when that member's PIN checks out; otherwise it's anonymous. At most 5 messages per hour per address.
const FEEDBACK_MAX = 300;
const admins = env => String(env.ADMIN_MEMBERS || "").split(",").map(x => x.trim()).filter(Boolean);
async function handleFeedback(req, env, url) {
  if (!env.PICKEM) return json(env, req, { error: "Storage isn't set up yet." }, 503);
  const st = await pickemWeek(env);
  if (req.method === "GET" && url.pathname === "/feedback") return json(env, req, { admins: admins(env) });
  const body = req.method === "POST" ? await postBody(req) : null;
  if (!body) return json(env, req, { error: "Bad request" }, 400);
  const key = "feedback:inbox";
  if (url.pathname === "/feedback/send") {
    const text = String(body.text || "").trim().slice(0, 1500);
    if (text.length < 3) return json(env, req, { error: "Write a little more first." }, 400);
    const ip = req.headers.get("CF-Connecting-IP") || "?";
    const rKey = `fb-rate:${(await sha1(ip + (env.PIN_SALT || ""))).slice(0, 16)}`;
    const n = Number(await env.PICKEM.get(rKey)) || 0;
    if (n >= 5) return json(env, req, { error: "That's a lot of messages for one hour. Try again later." }, 429);
    let from = null;
    if (body.member && body.pin && st.members.includes(String(body.member))) {
      if (await checkPin(env, st.season, String(body.member), body.pin)) return json(env, req, { error: "That PIN didn't match. Send it anonymously or check your PIN." }, 403);
      from = String(body.member);
    }
    const list = (await env.PICKEM.get(key, "json")) || [];
    list.unshift({ id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`, t: Date.now(), kind: body.kind === "problem" ? "problem" : "idea",
      text, from, page: String(body.page || "").slice(0, 80) });
    await env.PICKEM.put(key, JSON.stringify(list.slice(0, FEEDBACK_MAX)));
    await env.PICKEM.put(rKey, String(n + 1), { expirationTtl: 3600 });
    return json(env, req, { ok: true });
  }
  // the inbox: admins only
  const member = String(body.member || "");
  if (!admins(env).includes(member)) return json(env, req, { error: "Only the commissioner can read the inbox." }, 403);
  const err = await checkPin(env, st.season, member, body.pin);
  if (err) return json(env, req, { error: err }, 403);
  let list = (await env.PICKEM.get(key, "json")) || [];
  if (url.pathname === "/feedback/delete") {
    list = list.filter(x => x.id !== String(body.id || ""));
    await env.PICKEM.put(key, JSON.stringify(list));
  } else if (url.pathname !== "/feedback/inbox") return json(env, req, { error: "Not found" }, 404);
  return json(env, req, { messages: list });
}

// ---------------------------------------------------------------- League pulse
// Recent activity on the site, newest first: who reacted, played a game or updated the trade block. Never what anyone
// picked (that stays hidden until it locks). One KV value per season, the last PULSE_MAX events; the same person doing
// the same thing again within 30 minutes just moves back to the top instead of adding a line.
const PULSE_MAX = 40;
async function pulse(env, season, ev, remove = false) {
  try {
    const key = `pulse:${season}`;
    const list = (await env.PICKEM.get(key, "json")) || [];
    const now = Date.now();
    const same = e => e.m === ev.m && e.k === ev.k && (e.x || "") === (ev.x || "");
    const i = list.findIndex(e => same(e) && (remove || now - e.t < 30 * 60e3));
    if (remove && i < 0) return;
    if (i >= 0) list.splice(i, 1);
    if (!remove) list.unshift({ ...ev, t: now });
    await env.PICKEM.put(key, JSON.stringify(list.slice(0, PULSE_MAX)));
  } catch (e) { console.log("pulse failed", String(e)); }
}
async function handlePulse(req, env) {
  if (!env.PICKEM) return json(env, req, { events: [] });
  const st = await pickemWeek(env);
  return json(env, req, { season: st.season, events: (await env.PICKEM.get(`pulse:${st.season}`, "json")) || [] });
}

// ---------------------------------------------------------------- reactions
// One-tap emoji on matchups, big plays and the weekly high / low score. One of each emoji per member per item; tapping
// again takes it back. One KV value per week: { item: { emoji: [member ids] } }.
const REACT_EMOJI = ["🔥", "😂", "💀", "👏", "🗑️"];
async function handleReact(req, env, url) {
  if (!env.PICKEM) return json(env, req, { error: "Reaction storage isn't set up yet." }, 503);
  const st = await pickemWeek(env);
  const body = req.method === "POST" ? await postBody(req) : null;
  const week = Number(body ? body.week : url.searchParams.get("week")) || st.week;
  if (!(week >= 1 && week <= Math.max(st.week, 1))) return json(env, req, { error: "No such week." }, 400);
  const key = `react:${st.season}:${week}`;
  if (req.method === "GET" && url.pathname === "/react") return json(env, req, { season: st.season, week, items: (await env.PICKEM.get(key, "json")) || {} });
  if (req.method !== "POST" || url.pathname !== "/react/toggle") return json(env, req, { error: "Not found" }, 404);
  if (!body) return json(env, req, { error: "Bad request" }, 400);
  const member = String(body.member || ""), item = String(body.item || ""), emoji = String(body.emoji || "");
  if (!st.members.includes(member)) return json(env, req, { error: "That name isn't in the league." }, 400);
  if (!/^(g|p|hi|lo):[\w.-]{1,40}$/.test(item) || !REACT_EMOJI.includes(emoji)) return json(env, req, { error: "Bad reaction." }, 400);
  const err = await checkPin(env, st.season, member, body.pin);
  if (err) return json(env, req, { error: err }, 403);
  const R = (await env.PICKEM.get(key, "json")) || {};
  const it = R[item] = R[item] || {};
  const list = it[emoji] = it[emoji] || [];
  const i = list.indexOf(member);
  if (i >= 0) list.splice(i, 1); else list.push(member);
  if (!list.length) delete it[emoji];
  if (!Object.keys(it).length) delete R[item];
  await env.PICKEM.put(key, JSON.stringify(R));
  await pulse(env, st.season, { m: member, k: "react", x: `${week}|${item}|${emoji}`, w: week, i: item, e: emoji }, i >= 0);
  return json(env, req, { ok: true, week, items: R });
}


// ---------------------------------------------------------------- trash talk
// Short comment threads under matchups, weekly recaps and trades (current season), posted as your team with
// name + PIN. One KV value per week ("w10": matchups and that week's recap) plus one for trades. The author or the
// commissioner can delete a post. Posts on a matchup this week alert both teams (Settings → Alerts, "talk").
const TALK_MAX = 280, TALK_KEEP = 100, TALK_GAP_MS = 10e3;
async function handleTalk(req, env, url) {
  if (!env.PICKEM) return json(env, req, { error: "Comment storage isn't set up yet." }, 503);
  const st = await pickemWeek(env);
  const body = req.method === "POST" ? await postBody(req) : null;
  if (req.method === "POST" && !body) return json(env, req, { error: "Bad request" }, 400);
  const scope = String(body ? body.scope : url.searchParams.get("scope") || "");
  const m = scope.match(/^w(\d{1,2})$/);
  if (!(scope === "trades" || (m && +m[1] >= 1 && +m[1] <= Math.max(st.week, 1)))) return json(env, req, { error: "No such thread." }, 400);
  const key = `talk:${st.season}:${scope}`;
  if (req.method === "GET" && url.pathname === "/talk") return json(env, req, { season: st.season, scope, items: (await env.PICKEM.get(key, "json")) || {} });
  if (req.method !== "POST") return json(env, req, { error: "Not found" }, 404);
  const member = String(body.member || ""), item = String(body.item || "");
  if (!st.members.includes(member)) return json(env, req, { error: "That name isn't in the league." }, 400);
  if (!/^(g|r|t):[\w.-]{1,40}$/.test(item) || (scope === "trades") !== item.startsWith("t:")) return json(env, req, { error: "Bad thread." }, 400);
  const err = await checkPin(env, st.season, member, body.pin);
  if (err) return json(env, req, { error: err }, 403);
  const T = (await env.PICKEM.get(key, "json")) || {};
  const list = T[item] = T[item] || [];
  if (url.pathname === "/talk/post") {
    const text = String(body.text || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    if (!text) return json(env, req, { error: "Write something first." }, 400);
    if ([...text].length > TALK_MAX) return json(env, req, { error: `Keep it under ${TALK_MAX} characters.` }, 400);
    const now = Date.now();
    if (Object.values(T).some(l => l.some(p => p.m === member && now - p.t < TALK_GAP_MS))) return json(env, req, { error: "Slow down: one post every 10 seconds." }, 429);
    const post = { id: crypto.randomUUID().slice(0, 8), m: member, x: text, t: now };
    list.push(post);
    T[item] = list.slice(-TALK_KEEP);
    await env.PICKEM.put(key, JSON.stringify(T));
    await pulse(env, st.season, { m: member, k: "talk", x: `${scope}|${item}|${post.id}`, w: m ? +m[1] : null, i: item });
    if (m && +m[1] === st.week && item.startsWith("g:")) {
      try { await talkAlert(env, st, item.slice(2), member, text); } catch (e) { console.log("talk alert failed", String(e)); }
    }
    return json(env, req, { ok: true, items: T });
  }
  if (url.pathname === "/talk/delete") {
    const i = list.findIndex(p => p.id === String(body.id || ""));
    if (i < 0) return json(env, req, { ok: true, items: T });
    if (list[i].m !== member && !admins(env).includes(member)) return json(env, req, { error: "Only the author or the commissioner can delete this." }, 403);
    const [gone] = list.splice(i, 1);
    if (!list.length) delete T[item];
    await env.PICKEM.put(key, JSON.stringify(T));
    await pulse(env, st.season, { m: gone.m, k: "talk", x: `${scope}|${item}|${gone.id}` }, true);
    return json(env, req, { ok: true, items: T });
  }
  return json(env, req, { error: "Not found" }, 404);
}

async function talkAlert(env, st, gameId, poster, text) {
  if (!vapidPublic(env)) return;
  const g = st.games.find(x => String(x.id) === String(gameId));
  if (!g) return;
  const subs = await loadSubs(env);
  if (!Object.keys(subs).length) return;
  const info = await teamInfo(env, st.season);
  const teamOf = {};
  for (const [id, t] of Object.entries(info.teams)) for (const o of t.owners) teamOf[o] = +id;
  const from = info.teams[teamOf[poster]];
  const box = outbox(subs, teamOf);
  box.add("talk", t => t === g.home || t === g.away, rec => rec.member === poster ? null : {
    title: `${from ? from.name : "Someone"} on your matchup`, body: `"${text}"`, url: "#/matchups", tag: `talk-${gameId}` });
  if (box.size()) await box.flush(env, Date.now());
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

// Big gains: [yards stat id, label, minimum yards, the stat counting the plays: carries / catches / completions].
// The feed only sees stats once a minute, so several plays can land between two checks. A gain only counts as a
// big play when exactly one carry, catch or completion happened since the last check, so it was all one play.
const YARDS = [[42, "catch", 30, 53], [24, "run", 30, 23], [3, "pass", 50, 1]];
const YARD_STATS = [...new Set(YARDS.flatMap(([y, , , n]) => [y, n]))];
const PLAY_IDS = [...new Set(PLAY.flatMap(([ids]) => ids))];

function yardagePlay(oldY, newY) {
  if (!oldY) return null; // first snapshot with yardage
  let best = null;
  for (const [id, label, min, plays] of YARDS) {
    if (oldY[plays] == null) continue; // snapshot from before play counts were saved: can't tell
    const gained = Math.round((newY[id] || 0) - (oldY[id] || 0));
    const n = (newY[plays] || 0) - (oldY[plays] || 0);
    if (n !== 1) continue;
    if (gained >= min && (!best || gained / min > best.ratio)) best = { label: `${gained}-yd ${label}`, ratio: gained / min };
  }
  return best;
}

// Kicks only make the feed when the field goal itself is worth this many fantasy points (with this league's
// scoring that's 50+ yards). Misses and short field goals are left out. Extra points never count.
const KICK_IDS = new Set([80, 77, 74, 198, 201, 85, 88]);
const FG_MADE = [80, 77, 74, 198, 201];
const KICK_MIN_PTS = 5;

function describePlay(oldA, newA) {
  let best = null;
  const kickPts = FG_MADE.reduce((sum, id) => sum + (newA[id] || 0) - (oldA[id] || 0), 0);
  for (const [ids, label, pri] of PLAY) {
    if (ids.some(id => KICK_IDS.has(id)) && kickPts < KICK_MIN_PTS) continue;
    // only a stat that grew is a new play; one that shrank is ESPN taking a play back (see reversedPlays)
    if (ids.some(id => grew(oldA, newA, id)) && (!best || pri > best.pri)) best = { label, pri, ids };
  }
  return best;
}

// Stats here are applied fantasy points (a lost fumble takes stat 72 from 0 to -3), so compare sizes, not signs.
const grew = (oldA, newA, id) => Math.abs(newA[id] || 0) > Math.abs(oldA[id] || 0) + 1e-9;
const shrank = (oldA, newA, id) => Math.abs(newA[id] || 0) < Math.abs(oldA[id] || 0) - 1e-9;

// Plays ESPN took back since the last check (a fumble overturned on review, a TD ruled short): the play's stat
// shrank. Returns their labels so the earlier feed entry can be removed instead of showing a second, opposite play.
function reversedPlays(oldA, newA) {
  return PLAY.filter(([ids]) => ids.some(id => shrank(oldA, newA, id)) && !ids.some(id => grew(oldA, newA, id)))
    .map(([, label]) => label);
}

// Is a feed event this kind of play? Labels gain yards later ("passing TD" -> "25-yd passing TD", "50+ yd field
// goal" -> "53-yd field goal"), so match on the kind saved with the event, or failing that the label's ending.
function isPlayKind(e, label) {
  if (e.kind) return e.kind === label;
  if (isFgLabel(label)) return isFgLabel(e.label);
  return e.label === label || e.label.endsWith(" " + label);
}

// ---- exact yardage for touchdowns and field goals
// ESPN's fantasy stats only say a TD or a 50+ yd kick happened. The public NFL game summary lists every scoring
// play with its exact yards and the time it happened, so each feed play is matched to the scoring play by the same
// player that happened closest before the feed noticed it.
const NFL_SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const YDS_LABEL = { "passing TD": "passer", "receiving TD": "receiver", "rushing TD": "rusher" };
const isFgLabel = l => / field goal$/.test(l) && !/^missed/.test(l);
const normName = n => String(n || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "").replace(/[^a-z]/g, "");

async function nflGameIds() {
  // NFL team abbreviation -> today's ESPN game id
  return cached("nfl-scoreboard", 60, async () => {
    const d = await (await fetch(`${NFL_SITE}/scoreboard`)).json();
    const out = {};
    for (const e of d.events || []) for (const c of (e.competitions || [])[0]?.competitors || []) out[c.team.abbreviation] = e.id;
    return out;
  });
}

async function gameSummary(gameId) {
  return cached(`nfl-summary-${gameId}`, 45, async () => (await fetch(`${NFL_SITE}/summary?event=${gameId}`)).json());
}

async function scoringPlays(gameId) {
  return cached(`nfl-scoring-${gameId}`, 45, async () => {
    const d = await gameSummary(gameId);
    const wall = {};
    for (const drv of (d.drives || {}).previous || []) for (const p of drv.plays || []) if (p.wallclock) wall[p.id] = Date.parse(p.wallclock);
    const out = [];
    for (const sp of d.scoringPlays || []) {
      const text = sp.text || "", w = wall[sp.id] || null;
      let m;
      if ((m = text.match(/^(.+?) (\d+) Yd pass from (.+?)(?: \(|$)/))) {
        out.push({ id: sp.id, role: "receiver", name: normName(m[1]), yds: +m[2], w });
        out.push({ id: sp.id, role: "passer", name: normName(m[3]), yds: +m[2], w });
      } else if ((m = text.match(/^(.+?) (\d+) Yd (?:Rush|Run)\b/))) {
        out.push({ id: sp.id, role: "rusher", name: normName(m[1]), yds: +m[2], w });
      } else if ((m = text.match(/^(.+?) (\d+) Yd Field Goal/))) {
        out.push({ id: sp.id, role: "kicker", name: normName(m[1]), yds: +m[2], w });
      }
    }
    return out;
  });
}

// Fill in yards on recent TD and field-goal plays that don't have them yet. Returns true if any changed.
async function addPlayYards(events) {
  const todo = events.filter(e => e.yds == null && Date.now() - e.t < 6 * 3600e3 && e.nfl &&
    (YDS_LABEL[e.label] || isFgLabel(e.label)));
  if (!todo.length) return false;
  const games = await nflGameIds();
  let changed = false;
  for (const e of todo) {
    const gid = games[e.nfl];
    if (!gid) continue;
    const role = YDS_LABEL[e.label] || "kicker";
    const taken = new Set(events.filter(x => x !== e && x.sp && x.pid === e.pid).map(x => x.sp));
    const cands = (await scoringPlays(gid)).filter(p => p.role === role && p.name === normName(e.name) && !taken.has(p.id)
      && (p.w == null || p.w <= e.t + 120e3));
    if (!cands.length) continue;
    const sp = cands.reduce((best, p) => (p.w || 0) > (best.w || 0) ? p : best);
    e.yds = sp.yds; e.sp = sp.id;
    e.label = role === "kicker" ? `${sp.yds}-yd field goal` : `${sp.yds}-yd ${e.label}`;
    changed = true;
  }
  return changed;
}

// ---- highlight clips
// ESPN posts short clips of most touchdowns (and some other big plays) to the game summary a few minutes after they
// happen, headlined with the players' names ("Patrick Mahomes finds Kenneth Walker III for a Chiefs TD"). A play gets
// the first clip naming its player that was posted from just before it to 3 hours after. Clips expire after ~2 days.
async function gameVideos(gameId) {
  return cached(`nfl-videos-${gameId}`, 60, async () => ((await gameSummary(gameId)).videos || []).map(v => ({
    u: ((v.links || {}).web || {}).href, h: normName(v.headline), raw: String(v.headline || "").toLowerCase(),
    p: Date.parse(v.originalPublishDate || v.lastModified || 0), d: v.duration || 0,
    x: Date.parse(((v.timeRestrictions || {}).expirationDate) || 0) || null,
  })).filter(v => v.u && v.p));
}

// the clip has to be about this kind of play: a TD clip for a touchdown, a pick/fumble clip for a turnover...
// (a player's name also shows up in recaps and in clips of other plays he was part of)
function clipFits(label, raw) {
  if (/\bTD\b/.test(label)) return /\btd\b|touchdown|scores?\b|end zone|runs it in|punches it in|house/.test(raw);
  if (/interception/.test(label)) return /pick|intercept/.test(raw);
  if (/fumble/.test(label)) return /fumble|strip|cough/.test(raw);
  if (/field goal/.test(label)) return /field goal|\bfg\b|kick|boot/.test(raw);
  return !/\btd\b|touchdown|pick|intercept|fumble/.test(raw); // a long gain: a clip of the play, not of a score
}

async function addPlayVideos(events) {
  // clips matched before the play-type check (vid without k) are matched again
  let changed = false;
  for (const e of events) if (e.vid && !e.vid.k) { delete e.vid; changed = true; }
  const todo = events.filter(e => !e.vid && e.nfl && e.pos !== "D/ST" && e.label !== "stat correction" && Date.now() - e.t < 4 * 3600e3)
    .sort((a, b) => a.t - b.t);
  if (!todo.length) return changed;
  const games = await nflGameIds();
  for (const e of todo) {
    const gid = games[e.nfl];
    const who = normName(e.name);
    if (!gid || who.length < 5) continue;
    const taken = new Set(events.filter(x => x.vid && x.pid === e.pid).map(x => x.vid.u));
    const clip = (await gameVideos(gid)).filter(v => v.h.includes(who) && !taken.has(v.u) && v.d <= 45 && clipFits(e.label, v.raw)
      && v.p >= e.t - 10 * 60e3 && v.p <= e.t + 3 * 3600e3)
      .sort((a, b) => a.p - b.p)[0];
    if (!clip) continue;
    e.vid = { u: clip.u, x: clip.x, k: 2 };
    changed = true;
  }
  return changed;
}

// ---- points for the play itself
// A player's points can move several times in the minute between checks (a catch, then the TD). A big play's
// "+points" is just that play, worked out from the league's own scoring: e.g. a 47-yd receiving TD is the TD,
// 47 yards, the catch and any long-TD bonus.
async function scoringMap(env, yr) {
  return cached(`scoring-${yr}`, 6 * 3600, async () => {
    const d = await espn(env, yr, "view=mSettings");
    const out = {};
    for (const i of ((d.settings || {}).scoringSettings || {}).scoringItems || []) if (Math.abs(i.points) < 1000) out[i.statId] = i.points;
    return out;
  });
}

function playPoints(label, S) {
  const m = String(label).match(/^(\d+)-yd (receiving TD|rushing TD|passing TD|field goal|catch|run|pass)$/);
  if (!m) return null;
  const y = +m[1], s = id => S[id] || 0;
  const long = (b40, b50) => (y >= 40 ? s(b40) : 0) + (y >= 50 ? s(b50) : 0);
  switch (m[2]) {
    case "receiving TD": return s(43) + y * s(42) + s(53) + long(45, 46);
    case "rushing TD": return s(25) + y * s(24) + s(23) + long(35, 36);
    case "passing TD": return s(4) + y * s(3) + s(1) + long(15, 16);
    case "catch": return y * s(42) + s(53);
    case "run": return y * s(24) + s(23);
    case "pass": return y * s(3) + s(1);
    case "field goal": return s(83) + (y >= 60 ? (S[201] ?? S[198] ?? s(74)) : y >= 50 ? (S[198] ?? s(74)) : y >= 40 ? s(77) : s(80));
  }
  return null;
}

async function pricePlays(env, events) {
  const recent = events.filter(e => Date.now() - e.t < 12 * 3600e3);
  if (!recent.some(e => /^\d+-yd /.test(e.label))) return false;
  const S = await scoringMap(env, season());
  let changed = false;
  for (const e of recent) {
    const pts = playPoints(e.label, S);
    if (pts == null) continue;
    const v = Math.round(pts * 100) / 100;
    if (Math.abs(v - e.delta) > 0.005) { e.delta = v; changed = true; }
  }
  return changed;
}

// Team defenses score a little on lots of plays (sacks, interceptions, fumble recoveries); only plays worth at least
// this many points make the feed, which in practice means defensive and return touchdowns.
const DST_MIN_PTS = 5;

async function updateFeed(env) {
  const yr = season();
  const st = (await espn(env, yr, "view=mStatus")).status;
  if (env.FEED_FORCE !== "1" && !(await gamesOn(yr, st.currentMatchupPeriod))) return; // FEED_FORCE: local testing
  const lv = await liveWeek(env);
  const key = `feed:${lv.season}:${lv.week}`;
  const prev = (await env.PICKEM.get(key, "json")) || { snap: {}, events: [], savedAt: 0 };
  const snap = {};
  const events = [];
  const takeBacks = []; // [player id, play label] for plays ESPN reversed this minute
  for (const g of lv.games) {
    if (g.sides.length !== 2) continue;
    for (const [i, side] of g.sides.entries()) {
      const opp = g.sides[1 - i];
      for (const p of side.lineup) {
        const line = lv.stats[`${lv.week}|${p.id}`] || {};
        const a = line.a || {}, r = line.r || {};
        const y = Object.fromEntries(YARD_STATS.map(k => [k, r[k] || 0]));
        const c = Object.fromEntries(PLAY_IDS.map(k => [k, r[k] || 0])); // how many of each play so far
        snap[p.id] = { p: p.pts, a, y, c };
        const old = prev.snap[p.id];
        if (!old) continue;
        const delta = Math.round((p.pts - old.p) * 100) / 100;
        if (Math.abs(delta) < 0.05) continue;
        const undone = reversedPlays(old.a || {}, a);
        for (const label of undone) takeBacks.push([p.id, label]);
        const play = describePlay(old.a, a) || yardagePlay(old.y, y);
        if (!play && undone.length) continue;               // a reversal removes the old entry; nothing new to show
        if (!play && delta > -4) continue;                  // small yardage ticks aren't plays
        // (a 4+ point drop with no play behind it is almost always an official stat correction)
        // points from the play itself (its own stats), not everything the player gained this minute; touchdowns,
        // field goals and long gains are priced exactly once their yards are known (playPoints below)
        const own = play && play.ids ? Math.round(play.ids.reduce((sum, id) => sum + (a[id] || 0) - ((old.a || {})[id] || 0), 0) * 100) / 100 : delta;
        // The snapshot is only saved when something gets written, so a quiet stretch (a defense's first interception,
        // which isn't a feed play) can leave it several minutes old, and two plays of the same kind then arrive
        // together. Count them from the raw stats so each is judged (and labeled) on its own.
        const count = play && play.ids && old.c ? Math.max(1, Math.round(play.ids.reduce((n, id) => n + (c[id] || 0) - (old.c[id] || 0), 0))) : 1;
        const each = own / count;
        if (p.pos === "D/ST" && !(play && each >= DST_MIN_PTS)) continue; // team defenses: only plays worth 5+ (TDs)
        events.push({
          t: Date.now(), game: g.id, team: side.team, opp: opp.team, pid: p.id, name: p.name, pos: p.pos, nfl: p.team,
          starter: !["BE", "IR"].includes(p.slot), label: play ? (count > 1 ? `${count}× ${play.label}` : play.label) : "stat correction",
          kind: play ? play.label : "stat correction",
          delta: own, minute: delta, pts: p.pts, score: [side.pts, opp.pts],
        });
      }
    }
  }
  // Reversed plays: drop that player's most recent matching entry, so an overturned fumble simply disappears instead
  // of showing as "fumble lost -3" followed by "fumble lost +3".
  const older = (prev.events || []).slice();
  for (const [pid, label] of takeBacks) {
    const i = older.findIndex(e => e.pid === pid && isPlayKind(e, label)); // newest first
    if (i >= 0) older.splice(i, 1);
  }
  const removed = older.length !== (prev.events || []).length;
  events.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  const all = events.concat(older).slice(0, 200);
  // the NFL scoring summary can trail the fantasy stats by a minute or two, so recent plays are retried each minute
  let yards = removed;
  // (also clears out defensive plays logged before the 5-point rule)
  const kept = all.filter(e => !(e.pos === "D/ST" && e.delta < DST_MIN_PTS));
  if (kept.length !== all.length) { all.length = 0; all.push(...kept); yards = true; }
  try { yards = (await addPlayYards(all)) || yards; } catch (e) { console.log("play yards failed", String(e)); }
  try { if (await pricePlays(env, all)) yards = true; } catch (e) { console.log("play points failed", String(e)); }
  try { if (await addPlayVideos(all)) yards = true; } catch (e) { console.log("play videos failed", String(e)); }
  const stale = Date.now() - (prev.savedAt || 0) > 10 * 60e3;
  if (!events.length && !yards && !stale && Object.keys(prev.snap).length) return; // nothing worth a write this minute
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
    await pulse(env, R.season, { m: member, k: "block" });
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
    if (url.pathname.startsWith("/pick3")) {
      try { return await handlePick3(req, env, url); }
      catch (e) { return json(env, req, { error: String(e.message || e) }, 502); }
    }
    for (const [pre, fn] of [["/bull", handleBull], ["/rank", handleRank], ["/react", handleReact], ["/pulse", handlePulse], ["/graph", handleGraph], ["/plays", handlePlays], ["/feedback", handleFeedback], ["/push", handlePush], ["/talk", handleTalk]]) {
      if (url.pathname.startsWith(pre)) {
        try { return await fn(req, env, url); }
        catch (e) { return json(env, req, { error: String(e.message || e) }, 502); }
      }
    }
    if (url.pathname.startsWith("/trivia")) {
      try { return await handleTrivia(req, env, url); }
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

  // Runs every minute: the big-play feed, plus deciding whether the full site needs rebuilding now.
  async scheduled(event, env, ctx) {
    // game-day alerts run on their own trigger, so their pushes don't share this run's request budget
    if (event.cron === ALERT_CRON) { ctx.waitUntil(runAlerts(env, event.scheduledTime).catch(e => console.log("alerts failed", String(e)))); return; }
    if (env.PICKEM) ctx.waitUntil(updateFeed(env).catch(e => console.log("feed update failed", String(e))));
    ctx.waitUntil(maybeRebuild(env, new Date(event.scheduledTime)).catch(e => console.log("rebuild check failed", String(e))));
  },
};

// ---------------------------------------------------------------- site rebuilds
// The full site (standings, power, odds, insights, rosters, trades) is built by GitHub Actions in about a minute.
// Rebuild as soon as anything besides live scores changes on ESPN, every 5 minutes while NFL games are on (so
// standings, power and playoff odds follow the scores), and every 30 minutes regardless as a safety net.
async function sha1(text) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// Everything the site shows that isn't a live score: the week, records, team names, rosters and lineup slots,
// transaction counts (adds, drops, trades, waiver claims), waiver order and the league settings.
async function leagueFingerprint(env) {
  const yr = season();
  const d = await espn(env, yr, "view=mStatus&view=mTeam&view=mRoster&view=mSettings");
  const st = d.status || {};
  const teams = (d.teams || []).map(t => {
    const rec = (t.record || {}).overall || {};
    return [t.id, t.name, t.abbrev, t.logo, (t.owners || []).join(","), rec.wins, rec.losses, rec.ties, t.waiverRank,
      t.transactionCounter || {}, ((t.roster || {}).entries || []).map(e => e.playerId + ":" + e.lineupSlotId).sort().join(" ")];
  }).sort((a, b) => a[0] - b[0]);
  const parts = { yr, week: st.currentMatchupPeriod, period: st.latestScoringPeriod, final: st.finalScoringPeriod,
    active: st.isActive, teams, settings: d.settings || {} };
  return { hash: await sha1(JSON.stringify(parts)), parts };
}

// Name the first thing that changed, for the log.
function whatChanged(a, b) {
  if (!a) return "first check";
  if (a.week !== b.week || a.period !== b.period || a.active !== b.active) return "new week";
  if (JSON.stringify(a.settings) !== JSON.stringify(b.settings)) return "league settings";
  const old = Object.fromEntries(a.teams.map(t => [t[0], t]));
  for (const t of b.teams) {
    const o = old[t[0]];
    if (!o) return "teams";
    if (o[10] !== t[10]) return `roster or lineup (team ${t[0]})`;
    if (JSON.stringify(o[9]) !== JSON.stringify(t[9])) return `transaction (team ${t[0]})`;
    if (o[5] !== t[5] || o[6] !== t[6] || o[7] !== t[7]) return "records";
    if (o[8] !== t[8]) return "waiver order";
    if (String(o.slice(1, 5)) !== String(t.slice(1, 5))) return `team details (team ${t[0]})`;
  }
  return "other";
}

async function dispatchRebuild(env, reason) {
  if (!env.GITHUB_TOKEN) return;
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`, {
    method: "POST", headers: githubHeaders(env), body: JSON.stringify({ ref: "main" }),
  });
  console.log(r.ok ? `rebuild started: ${reason}` : `GitHub dispatch failed (${reason}) ${r.status} ${await r.text()}`);
}

const githubHeaders = env => ({ Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json",
  "User-Agent": "league-hq-live", "X-GitHub-Api-Version": "2022-11-28" });

// Minutes since the newest site rebuild that hasn't failed was started (by any trigger: this worker, a push,
// GitHub's own schedule), or null if GitHub couldn't be asked.
async function lastRebuildAge(env, now) {
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/runs?per_page=10`,
    { headers: githubHeaders(env) });
  if (!r.ok) return null;
  const run = ((await r.json()).workflow_runs || []).find(x => !["failure", "timed_out", "startup_failure"].includes(x.conclusion));
  return run ? (now - Date.parse(run.created_at)) / 60e3 : null;
}

async function maybeRebuild(env, now) {
  const min = now.getUTCMinutes();
  const reasons = [];
  if (min % 30 === 0) reasons.push("every 30 minutes");
  let games = false;
  // KV is only written when something actually changed, so this stays far inside the daily write allowance
  if (env.PICKEM) {
    const prev = await env.PICKEM.get("watch:fp", "json");
    let parts = prev && prev.parts;
    // an ESPN hiccup here must not cancel the time-based rebuilds below, so it's caught and they still go out
    try {
      const fp = await leagueFingerprint(env);
      parts = fp.parts;
      if (!prev || prev.hash !== fp.hash) {
        await env.PICKEM.put("watch:fp", JSON.stringify(fp));
        if (prev) reasons.push(whatChanged(prev.parts, fp.parts));
      }
    } catch (e) { console.log("league check failed; time-based rebuilds still run", String(e)); }
    if (parts) {
      try { games = await gamesOn(parts.yr, parts.week, now.getTime()); } catch (e) { console.log("games-on check failed", String(e)); }
    }
    if (games && min % 5 === 0) reasons.push("games on");
  }
  // Safety net: two minutes after each expected slot, make sure a rebuild really started (a failed dispatch, a
  // skipped cron tick or a failed build would otherwise leave the site a whole interval behind). One GitHub read
  // every 5 minutes during games, every 30 otherwise.
  if (!reasons.length && env.GITHUB_TOKEN && min % (games ? 5 : 30) === 2) {
    const age = await lastRebuildAge(env, now).catch(e => { console.log("rebuild history check failed", String(e)); return null; });
    if (age != null && age > (games ? 6.5 : 31.5)) reasons.push(`catch-up: last rebuild ${Math.round(age)} min ago`);
  }
  if (reasons.length) await dispatchRebuild(env, reasons.join(", ")).catch(e => console.log("GitHub dispatch failed", String(e)));
}

// ---------------------------------------------------------------- game-day alerts (Web Push)
// Phones and browsers subscribe from Settings → Alerts. A separate once-a-minute check (ALERT_CRON) looks for:
// lead changes, "down to the wire" moments and final results in your matchup; big plays (yours, against you, or
// league-wide); a starter who's out, on a bye or an empty spot 90 minutes before kickoff; waiver results and trades;
// and an optional reminder before Pick'em locks / Sunday's Pick 4. Each subscriber gets at most one notification per
// minute (several alerts in the same minute are combined). KV is only written when something was sent or changed.
const ALERT_CRON = "0-59 * * * *";
const ALERT_KINDS = { lead: true, wire: true, final: true, plays: true, playsAgainst: false, playsAll: false, trouble: true,
  waivers: true, trades: true, tradesAll: false, picks: false, talk: true };
const SUBS_KEY = "push:subs";
const SUBS_MAX = 36; // each alert is one request; this keeps a busy minute inside the worker's per-run limit
const LEAD_GAP_MS = 10 * 60e3;   // at most one lead-change alert per matchup every 10 minutes
const TROUBLE_LEAD_MS = 90 * 60e3; // "starter in trouble" goes out 90 minutes before that player's kickoff
const BAD_STATUS = { OUT: "out", INJURY_RESERVE: "on IR", SUSPENSION: "suspended" };

const loadSubs = async env => (await env.PICKEM.get(SUBS_KEY, "json")) || {};
const subId = async endpoint => (await sha1(endpoint)).slice(0, 20);
const teamName = t => t.name || [t.location, t.nickname].filter(Boolean).join(" ") || `Team ${t.id}`;
const isStarterSlot = s => s !== 20 && s !== 21;
function validTz(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return String(tz); } catch (_) { return "America/New_York"; }
}
const hour = h => Number.isInteger(h) && h >= 0 && h <= 23;
const when = (ms, tz, withDay = true) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit",
  ...(withDay ? { weekday: "short" } : {}) }).format(ms);
const f1 = n => (Math.round(n * 10) / 10).toFixed(1);

async function handlePush(req, env, url) {
  if (!env.PICKEM) return json(env, req, { error: "Alerts storage isn't set up." }, 503);
  if (req.method === "GET" && url.pathname === "/push") return json(env, req, { key: vapidPublic(env), kinds: ALERT_KINDS });
  if (req.method !== "POST") return json(env, req, { error: "Not found" }, 404);
  const body = await postBody(req);
  if (!body) return json(env, req, { error: "Bad request" }, 400);
  const sub = body.sub || {};
  const endpoint = String(sub.endpoint || body.endpoint || "");
  if (!/^https:\/\/[^\s]+$/.test(endpoint) || endpoint.length > 1000) return json(env, req, { error: "Bad subscription" }, 400);
  const id = await subId(endpoint);
  const subs = await loadSubs(env);
  if (url.pathname === "/push/save") {
    if (!vapidPublic(env)) return json(env, req, { error: "Alerts aren't switched on for the site yet." }, 503);
    const keys = sub.keys || {};
    if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string" || keys.p256dh.length > 200 || keys.auth.length > 100)
      return json(env, req, { error: "Bad subscription" }, 400);
    const member = String(body.member || "");
    if (!(await pickemWeek(env)).members.includes(member)) return json(env, req, { error: "Claim your team on My team first." }, 400);
    if (!subs[id] && Object.keys(subs).length >= SUBS_MAX) return json(env, req, { error: "Too many devices have alerts on." }, 429);
    const p = body.prefs || {}, q = body.quiet || {};
    subs[id] = {
      sub: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }, member,
      prefs: Object.fromEntries(Object.entries(ALERT_KINDS).map(([k, d]) => [k, k in p ? !!p[k] : d])),
      quiet: { on: !!q.on, from: hour(q.from) ? q.from : 23, to: hour(q.to) ? q.to : 8 },
      tz: validTz(body.tz), at: (subs[id] || {}).at || Date.now(),
    };
    await env.PICKEM.put(SUBS_KEY, JSON.stringify(subs));
    return json(env, req, { ok: true });
  }
  if (url.pathname === "/push/remove") {
    if (subs[id]) { delete subs[id]; await env.PICKEM.put(SUBS_KEY, JSON.stringify(subs)); }
    return json(env, req, { ok: true });
  }
  if (url.pathname === "/push/test") {
    const rec = subs[id];
    if (!rec) return json(env, req, { error: "Turn alerts on first." }, 404);
    const rl = `push:test:${id}`;
    if (await env.PICKEM.get(rl)) return json(env, req, { error: "One test a minute." }, 429);
    await env.PICKEM.put(rl, "1", { expirationTtl: 60 });
    const status = await sendPush(env, rec.sub, { title: "League HQ alerts are on", body: "This is what an alert looks like. Tap it to open the site.", url: "#/settings", tag: "lhq-test" }, { ttl: 300 });
    if (status === 404 || status === 410) {
      delete subs[id];
      await env.PICKEM.put(SUBS_KEY, JSON.stringify(subs));
      return json(env, req, { error: "This device's alert sign-up expired. Turn alerts off and back on." }, 410);
    }
    return json(env, req, status < 300 ? { ok: true } : { error: `The push service said ${status}.` }, status < 300 ? 200 : 502);
  }
  return json(env, req, { error: "Not found" }, 404);
}

function quietNow(rec, now) {
  if (!rec.quiet || !rec.quiet.on) return false;
  const h = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: rec.tz }).format(now)) % 24;
  const { from, to } = rec.quiet;
  return from === to ? false : from < to ? h >= from && h < to : h >= from || h < to;
}

// Collects alerts per subscriber, then sends one notification each (several in one minute are combined).
function outbox(subs, teamOf) {
  const box = {};
  return {
    // who(team id) -> should this subscriber get it; make(rec) -> { title, body, url, tag }
    add(kind, who, make) {
      for (const [id, rec] of Object.entries(subs)) {
        const team = teamOf[rec.member];
        const on = kind in rec.prefs ? rec.prefs[kind] : ALERT_KINDS[kind]; // devices saved before a kind existed get its default
        if (team == null || !on || !who(team)) continue;
        const m = make(rec, team);
        if (m) (box[id] = box[id] || []).push(m);
      }
    },
    size: () => Object.keys(box).length,
    async flush(env, now) {
      const gone = [];
      await Promise.all(Object.entries(box).map(async ([id, msgs]) => {
        const rec = subs[id];
        if (quietNow(rec, now)) return;
        const msg = msgs.length === 1 ? msgs[0] : { title: `${msgs.length} League HQ alerts`, body: msgs.map(m => `${m.title}: ${m.body}`).join("\n"), url: msgs[0].url, tag: "lhq-batch" };
        msg.body = String(msg.body).slice(0, 1200);
        try {
          const s = await sendPush(env, rec.sub, msg);
          if (s === 404 || s === 410) gone.push(id);
          else if (s >= 300) console.log("push refused", s);
        } catch (e) { console.log("push failed", String(e)); }
      }));
      if (gone.length) {
        const fresh = await loadSubs(env);
        gone.forEach(id => delete fresh[id]);
        await env.PICKEM.put(SUBS_KEY, JSON.stringify(fresh));
      }
      return gone.length;
    },
  };
}

// Team names, owners, records and the current scoring period.
async function teamInfo(env, yr) {
  return cached(`alert-teams-${yr}`, 300, async () => {
    const d = await espn(env, yr, "view=mTeam&view=mStatus");
    const teams = {};
    for (const t of d.teams || []) {
      const r = (t.record || {}).overall || {};
      teams[t.id] = { name: teamName(t), owners: t.owners || [], w: r.wins || 0, l: r.losses || 0, t: r.ties || 0 };
    }
    return { sp: d.status.latestScoringPeriod, teams };
  });
}

// NFL team abbreviation -> { state: "pre" | "in" | "post", at: kickoff ms } for this week's games.
async function nflStatus() {
  return cached("nfl-status", 50, async () => {
    const d = await (await fetch(`${NFL_SITE}/scoreboard`)).json();
    const out = {};
    for (const e of d.events || []) {
      const c = (e.competitions || [])[0] || {};
      const state = ((c.status || e.status || {}).type || {}).state;
      for (const x of c.competitors || []) out[x.team.abbreviation] = { state, at: Date.parse(e.date) };
    }
    return out;
  });
}

// Feed plays worth an alert: touchdowns, 40+ yard plays (and 50+ yard field goals), and defensive scores.
function bigPlay(e) {
  if (!e.starter || e.kind === "stat correction" || e.label === "stat correction") return false;
  if (/TD\b/.test(e.label) || e.pos === "D/ST") return true;
  if (/^(50|60)\+ yd field goal/.test(e.label)) return true;
  const m = String(e.label).match(/^(\d+)-yd /);
  return !!(m && +m[1] >= 40);
}

async function matchupAlerts(env, box, info, yr, week, now) {
  if (!(await gamesOn(yr, week, now))) return;
  const [lv, nfl] = await Promise.all([cached("alert-live", 50, () => liveWeek(env)), nflStatus().catch(() => ({}))]);
  if (lv.week !== week) return;
  const key = `push:game:${yr}:${week}`;
  const prev = await env.PICKEM.get(key, "json");
  const S = prev || { lead: {}, leadAt: {}, final: {}, wire: {}, playT: now };
  let changed = !prev;
  const T = info.teams, nm = id => (T[id] ? T[id].name : `Team ${id}`);
  const stateOf = p => (nfl[p.team] || {}).state || "none"; // none = bye / no game this week
  for (const g of lv.games) {
    if (g.sides.length !== 2 || S.final[g.id]) continue;
    const [a, b] = g.sides;
    const lead = a.pts > b.pts ? a.team : b.pts > a.pts ? b.team : null;
    const both = t => t === a.team || t === b.team;
    const side = t => (t === a.team ? [a, b] : [b, a]);
    const starters = s => s.lineup.filter(p => !["BE", "IR"].includes(p.slot));
    const left = s => starters(s).filter(p => stateOf(p) === "pre");
    const playing = [a, b].some(s => starters(s).some(p => stateOf(p) === "in"));
    const anyKnown = Object.keys(nfl).length > 0;
    // final: every starter on both sides has finished (or has no game)
    if (anyKnown && !playing && !left(a).length && !left(b).length && starters(a).concat(starters(b)).some(p => stateOf(p) === "post")) {
      S.final[g.id] = 1; changed = true;
      box.add("final", both, (rec, t) => {
        const [me, op] = side(t), won = me.pts > op.pts, tie = me.pts === op.pts, r = T[t] || { w: 0, l: 0, t: 0 };
        const rec2 = [r.w + (won ? 1 : 0), r.l + (!won && !tie ? 1 : 0)].concat(r.t || tie ? [r.t + (tie ? 1 : 0)] : []).join("–");
        return { title: won ? "You won!" : tie ? "It's a tie" : "Final: a loss", tag: `final-${g.id}`, url: "#/matchups",
          body: `${f1(me.pts)} to ${f1(op.pts)} vs ${nm(op.team)}${g.playoff ? "" : `. You're now ${rec2}`}.` };
      });
      continue;
    }
    // lead change (the first lead of the week isn't a change)
    if (lead && S.lead[g.id] !== lead) {
      if (S.lead[g.id] && now - (S.leadAt[g.id] || 0) >= LEAD_GAP_MS) {
        S.leadAt[g.id] = now;
        box.add("lead", both, (rec, t) => {
          const [me, op] = side(t), up = lead === t;
          return { title: up ? "You took the lead" : `${nm(op.team)} took the lead`, tag: `lead-${g.id}`, url: "#/matchups",
            body: `${f1(me.pts)} to ${f1(op.pts)}${up ? "" : ` (down ${f1(op.pts - me.pts)})`}.` };
        });
      }
      S.lead[g.id] = lead; changed = true;
    }
    // down to the wire: nobody playing right now, 1-4 starters left in later games, the trailing team still has one
    const la = left(a), lb = left(b), rest = la.concat(lb);
    const trailing = a.pts < b.pts ? la : b.pts < a.pts ? lb : rest;
    if (anyKnown && !playing && rest.length >= 1 && rest.length <= 4 && trailing.length &&
        starters(a).concat(starters(b)).some(p => stateOf(p) === "post")) {
      const sig = rest.map(p => p.id).sort().join(",");
      if (S.wire[g.id] !== sig) {
        S.wire[g.id] = sig; changed = true;
        box.add("wire", both, (rec, t) => {
          const [me, op] = side(t), diff = me.pts - op.pts;
          const who = s => left(s).map(p => `${p.name} (${p.team}, ${when((nfl[p.team] || {}).at || now, rec.tz)})`).join(", ") || "nobody";
          return { title: "Down to the wire", tag: `wire-${g.id}`, url: "#/matchups",
            body: `${diff > 0 ? `You lead by ${f1(diff)}` : diff < 0 ? `You trail by ${f1(-diff)}` : "Tied"} vs ${nm(op.team)}. Left for you: ${who(me)}. For them: ${who(op)}.` };
        });
      }
    }
  }
  // big plays from the live feed (written by updateFeed each minute)
  const feed = await env.PICKEM.get(`feed:${yr}:${week}`, "json");
  const fresh = ((feed && feed.events) || []).filter(e => e.t > S.playT);
  if (fresh.length) {
    S.playT = Math.max(...fresh.map(e => e.t)); changed = true;
    for (const e of fresh.filter(bigPlay).sort((x, y) => x.t - y.t)) {
      const make = (title) => () => ({ title, tag: `play-${e.pid}-${e.t}`, url: "#/matchups",
        body: `${e.name} (${e.nfl}): ${e.label}, ${e.delta >= 0 ? "+" : ""}${f1(e.delta)} pts. ${nm(e.team)} ${f1(e.score[0])}, ${nm(e.opp)} ${f1(e.score[1])}.` });
      box.add("plays", t => t === e.team, make("Big play for you"));
      box.add("playsAgainst", t => t === e.opp, make("Big play against you"));
      box.add("playsAll", t => t !== e.team && t !== e.opp, make(`Big play: ${nm(e.team)}`));
    }
  }
  if (changed) await env.PICKEM.put(key, JSON.stringify(S), { expirationTtl: 21 * 86400 });
}

// The day of the week (in New York) a kickoff falls on, e.g. "Sun".
const etDay = ms => new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "America/New_York" }).format(ms);

async function scheduleAlerts(env, box, subs, teamOf, info, yr, week, now) {
  const sp = info.sp;
  const games = (await proGames(yr))[sp] || {};
  const kicks = [...new Set(Object.values(games).map(g => g.at))].sort((x, y) => x - y);
  const sundayMain = kicks.find(k => etDay(k) === "Sun");
  const lineupAt = kicks.find(k => now >= k - TROUBLE_LEAD_MS && now < k - TROUBLE_LEAD_MS + 15 * 60e3);
  const pickLock = kicks[0];
  const pickemDue = pickLock && now >= pickLock - 3 * 3600e3 && now < pickLock - 3 * 3600e3 + 15 * 60e3;
  const pick4Due = sundayMain && now >= sundayMain - 3 * 3600e3 && now < sundayMain - 3 * 3600e3 + 15 * 60e3;
  if (!lineupAt && !pickemDue && !pick4Due) return;
  const key = `push:sent:${yr}:${sp}`;
  const sent = (await env.PICKEM.get(key, "json")) || {};
  let changed = false;
  const T = info.teams;
  if (lineupAt) {
    const want = new Set(Object.values(subs).filter(r => r.prefs.trouble && teamOf[r.member] != null && !sent[`lu|${teamOf[r.member]}|${lineupAt}`]).map(r => teamOf[r.member]));
    if (want.size) {
      const d = await cached(`alert-rosters-${yr}-${sp}`, 120, () => espn(env, yr, `view=mRoster&view=mSettings&scoringPeriodId=${sp}`));
      const need = ((d.settings || {}).rosterSettings || {}).lineupSlotCounts || {};
      for (const t of d.teams || []) {
        if (!want.has(t.id)) continue;
        sent[`lu|${t.id}|${lineupAt}`] = 1; changed = true;
        const entries = ((t.roster || {}).entries || []).filter(e => isStarterSlot(e.lineupSlotId));
        const issues = [];
        for (const e of entries) {
          const p = (e.playerPoolEntry || {}).player || {}, g = games[p.proTeamId];
          if (g && g.at === lineupAt && BAD_STATUS[p.injuryStatus]) issues.push(`${p.fullName} is ${BAD_STATUS[p.injuryStatus]}`);
          if (!g && lineupAt === sundayMain) issues.push(`${p.fullName} is on a bye`);
        }
        if (lineupAt === sundayMain) {
          const filled = {};
          entries.forEach(e => { filled[e.lineupSlotId] = (filled[e.lineupSlotId] || 0) + 1; });
          const empty = Object.entries(need).filter(([s]) => isStarterSlot(+s)).reduce((n, [s, c]) => n + Math.max(0, c - (filled[s] || 0)), 0);
          if (empty) issues.push(`${empty} lineup spot${empty === 1 ? " is" : "s are"} empty`);
        }
        if (issues.length) box.add("trouble", x => x === t.id, rec => ({ title: "Lineup check", tag: `lineup-${lineupAt}`, url: "#/myteam",
          body: `Kickoff at ${when(lineupAt, rec.tz, false)}: ${issues.join("; ")}. Fix it on ESPN before then.` }));
      }
    }
  }
  if (pickemDue || pick4Due) {
    const members = [...new Set(Object.values(subs).filter(r => r.prefs.picks).map(r => r.member))];
    const p4 = pick4Due ? (await env.PICKEM.get(`p3-entries:${yr}:${week}`, "json")) || {} : {};
    for (const m of members) {
      if (pickemDue && !sent[`pk|${m}`]) {
        sent[`pk|${m}`] = 1; changed = true;
        if (!(await env.PICKEM.get(`picks:${yr}:${week}:${m}`))) box.add("picks", () => true, rec => rec.member === m ? { title: "Pick'em closes soon",
          tag: "picks-pickem", url: "#/games", body: `Picks lock at ${when(pickLock, rec.tz)}. You haven't made yours yet.` } : null);
      }
      if (pick4Due && !sent[`p4|${m}`]) {
        sent[`p4|${m}`] = 1; changed = true;
        const e = p4[m] || {};
        if (!P3_SLOTS.some(s => e[s])) box.add("picks", () => true, rec => rec.member === m ? { title: "Pick 4 reminder",
          tag: "picks-p4", url: "#/games/pick4", body: `Sunday's games start at ${when(sundayMain, rec.tz, false)}. You haven't set a Pick 4 lineup yet.` } : null);
      }
    }
  }
  if (changed) await env.PICKEM.put(key, JSON.stringify(sent), { expirationTtl: 21 * 86400 });
}

// Waiver results and trades: checked only when the league fingerprint (maybeRebuild) has changed since last time.
async function moveAlerts(env, box, info, yr) {
  const fp = await env.PICKEM.get("watch:fp", "json");
  if (!fp) return;
  const st = await env.PICKEM.get("push:tx", "json");
  if (st && st.fp === fp.hash) return;
  const sp = info.sp;
  const lists = await Promise.all([sp, sp + 1].map(p => espn(env, yr, `view=mTransactions2&scoringPeriodId=${p}`).then(d => d.transactions || []).catch(() => [])));
  const all = lists.flat();
  const byId = Object.fromEntries(all.map(t => [t.id, t]));
  const done = t => t.status === "EXECUTED" || /^FAILED/.test(String(t.status));
  const ids = all.filter(done).map(t => t.id);
  if (!st) { await env.PICKEM.put("push:tx", JSON.stringify({ fp: fp.hash, seen: ids.slice(-600) })); return; }
  const seen = new Set(st.seen);
  const fresh = all.filter(t => done(t) && !seen.has(t.id));
  const waivers = fresh.filter(t => t.type === "WAIVER");
  const trades = [];
  const tradeKeys = new Set();
  for (const t of fresh) {
    if (!["TRADE_ACCEPT", "TRADE_UPHOLD"].includes(t.type) || t.status !== "EXECUTED") continue;
    const k = t.relatedTransactionId || t.id;
    if (tradeKeys.has(k) || seen.has("tr:" + k)) continue;
    const items = ((t.items || []).length ? t.items : (byId[t.relatedTransactionId] || {}).items || []).filter(i => i.type === "TRADE");
    if (!items.length) continue;
    tradeKeys.add(k);
    trades.push(items);
  }
  // player names: from the rosters, then ESPN's player lookup for anyone dropped
  const pids = [...new Set(waivers.flatMap(t => (t.items || []).map(i => i.playerId)).concat(trades.flat().map(i => i.playerId)))];
  const names = {};
  if (pids.length) {
    try {
      const d = await espnFiltered(env, yr, "view=kona_player_info", { players: { filterIds: { value: pids } } });
      for (const x of d.players || []) names[x.id] = (x.player || {}).fullName;
    } catch (e) { console.log("alert names failed", String(e)); }
  }
  const nm = id => names[id] || "a player";
  const T = info.teams, tn = id => (T[id] ? T[id].name : `Team ${id}`);
  const byTeam = {};
  for (const t of waivers) {
    const add = (t.items || []).find(i => i.type === "ADD"), drop = (t.items || []).find(i => i.type === "DROP");
    if (!add) continue;
    const r = byTeam[t.teamId] = byTeam[t.teamId] || { won: [], missed: [] };
    if (t.status === "EXECUTED") r.won.push(nm(add.playerId) + (drop ? ` (dropped ${nm(drop.playerId)})` : ""));
    else r.missed.push(nm(add.playerId));
  }
  for (const [team, r] of Object.entries(byTeam)) {
    box.add("waivers", t => t === +team, () => ({ title: "Waiver results", tag: "waivers", url: "#/myteam",
      body: [r.won.length ? `Won: ${r.won.join(", ")}.` : "", r.missed.length ? `Missed: ${r.missed.join(", ")}.` : ""].filter(Boolean).join(" ") }));
  }
  for (const items of trades) {
    const teams = [...new Set(items.map(i => i.toTeamId))];
    const gets = id => items.filter(i => i.toTeamId === id).map(i => nm(i.playerId)).join(", ") || "nothing";
    box.add("trades", t => teams.includes(t), (rec, t) => {
      const other = teams.filter(x => x !== t);
      return { title: "Trade done", tag: "trade", url: "#/trades", body: `With ${other.map(tn).join(" and ")}: you get ${gets(t)}; they get ${other.map(gets).join("; ")}.` };
    });
    box.add("tradesAll", t => !teams.includes(t), () => ({ title: "League trade", tag: "trade", url: "#/trades",
      body: teams.map(x => `${tn(x)} gets ${gets(x)}`).join("; ") + "." }));
  }
  const keep = st.seen.concat(fresh.map(t => t.id), [...tradeKeys].map(k => "tr:" + k)).slice(-600);
  await env.PICKEM.put("push:tx", JSON.stringify({ fp: fp.hash, seen: keep }));
}

async function runAlerts(env, now = Date.now()) {
  if (!env.PICKEM || !vapidPublic(env)) return;
  const subs = await loadSubs(env);
  if (!Object.keys(subs).length) return;
  const wk = await pickemWeek(env);
  if (wk.over) return;
  const info = await teamInfo(env, wk.season);
  const teamOf = {};
  for (const [id, t] of Object.entries(info.teams)) for (const o of t.owners) teamOf[o] = +id;
  const box = outbox(subs, teamOf);
  const step = (name, p) => p.catch(e => console.log(`alerts: ${name} failed`, String(e)));
  await Promise.all([
    step("matchups", matchupAlerts(env, box, info, wk.season, wk.week, now)),
    step("schedule", scheduleAlerts(env, box, subs, teamOf, info, wk.season, wk.week, now)),
    step("moves", moveAlerts(env, box, info, wk.season)),
  ]);
  if (box.size()) await box.flush(env, now);
}
