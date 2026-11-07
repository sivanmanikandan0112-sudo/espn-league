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

function cors(env, req) {
  const origin = req.headers.get("Origin") || "";
  const allowed = [env.SITE_ORIGIN, "http://localhost:8765"].includes(origin) ? origin : env.SITE_ORIGIN;
  return { "Access-Control-Allow-Origin": allowed, "Vary": "Origin", "Access-Control-Allow-Methods": "GET, OPTIONS" };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(env, req) });
    if (url.pathname !== "/live") return new Response("League HQ live worker. Try /live", { status: 404 });

    const cache = caches.default;
    const key = new Request(url.origin + "/live", { method: "GET" });
    let res = await cache.match(key);
    if (!res) {
      try {
        const body = JSON.stringify(await liveWeek(env));
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
