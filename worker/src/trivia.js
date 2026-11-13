// Weekly league-history trivia: 5 multiple-choice questions generated from the site's own public history files
// (data/index.js and data/records.js), frozen in KV the first time a week's quiz is asked for, so the answers
// never change mid-week. Answers stay on the server: the page only gets them back after you submit.

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const pts = n => Number(n).toFixed(2).replace(/\.?0+$/, "");
const wk = r => `week ${r.week}${r.playoff ? " (playoffs)" : ""} of ${r.season}`;

export function makeQuiz(H, R, season, week, count = 5) {
  const rand = rng(season * 1000 + week * 7 + 13);
  const pick = a => a[Math.floor(rand() * a.length)];
  const shuffle = a => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  const members = H.members || [];
  const name = id => (members.find(m => m.id === id) || {}).name || "A former member";
  const inSeason = yr => members.filter(m => (m.seasons || []).some(s => s.season === yr)).map(m => m.id);
  const done = yr => yr < season; // finished seasons only for season-total questions
  // a question whose answer is one manager: 3 other managers from that season as the wrong options
  const who = (q, answerId, yr, why, exclude = []) => {
    const pool = shuffle((yr ? inSeason(yr) : members.map(m => m.id)).filter(id => id !== answerId && !exclude.includes(id)));
    if (pool.length < 3) return null;
    const opts = shuffle([answerId, ...pool.slice(0, 3)]);
    return { q, options: opts.map(name), answer: opts.indexOf(answerId), why };
  };
  const recs = key => Object.entries(R || {}).flatMap(([id, r]) => (r[key] || []).map(x => ({ id, ...x })));

  const T = {
    teamName() {
      const m = pick(members.filter(m => (m.seasons || []).length));
      const s = pick(m.seasons);
      return who(`Whose team was called “${s.team}” in ${s.season}?`, m.id, s.season,
        `${m.name} ran “${s.team}” in ${s.season} and went ${s.w}–${s.l}${s.t ? "–" + s.t : ""}.`);
    },
    highScore() {
      const r = pick(recs("highScores"));
      return r && who(`Who scored ${pts(r.pts)} points in ${wk(r)}?`, r.id, r.season, `${name(r.id)} (${r.team}) put up ${pts(r.pts)} that week.`);
    },
    lowScore() {
      const r = pick(recs("lowScores"));
      return r && who(`Who scored just ${pts(r.pts)} points in ${wk(r)}?`, r.id, r.season, `That was ${name(r.id)} (${r.team}).`);
    },
    playerGame() {
      const r = pick(recs("playerGames"));
      return r && who(`${r.name} (${r.pos}) scored ${pts(r.pts)} in ${wk(r)}. Whose lineup was he in?`, r.id, r.season, `He was starting for ${name(r.id)} (${r.team}).`);
    },
    benchGame() {
      const r = pick(recs("benchGames"));
      return r && who(`${r.name} (${r.pos}) scored ${pts(r.pts)} in ${wk(r)}, on whose bench?`, r.id, r.season, `${name(r.id)} (${r.team}) left him on the bench.`);
    },
    blowout() {
      const r = pick(recs("bigWins"));
      if (!r) return null;
      return who(`Who beat ${name(r.loser.owners[0])} by ${pts(r.margin)} points in ${wk(r)}?`, r.id, r.season,
        `${name(r.id)} won ${pts(r.winPts)}–${pts(r.losePts)}.`);
    },
    champion() {
      const c = pick(H.champions || []);
      if (!c) return null;
      return who(`Who won the ${c.season} championship?`, c.owners[0], c.season,
        `${name(c.owners[0])} won it with “${c.team}”${c.runnerUp ? `, beating ${name(c.runnerUp.owners[0])} in the final` : ""}.`);
    },
    mostPoints() {
      const yrs = (H.seasonsList || []).filter(done);
      if (!yrs.length) return null;
      const yr = pick(yrs);
      const rows = members.flatMap(m => (m.seasons || []).filter(s => s.season === yr).map(s => ({ id: m.id, pf: s.pf })));
      rows.sort((a, b) => b.pf - a.pf);
      if (rows.length < 4 || rows[0].pf === rows[1].pf) return null;
      return who(`Who scored the most points in the ${yr} season?`, rows[0].id, yr, `${name(rows[0].id)} scored ${pts(rows[0].pf)}, ${pts(rows[0].pf - rows[1].pf)} more than ${name(rows[1].id)}.`);
    },
    streak() {
      const r = pick(recs("streaks").filter(x => x.len >= 3));
      if (!r) return null;
      // anyone else on a run covering the same weeks would also be right: keep them out of the options
      const also = recs("streaks").filter(x => x.id !== r.id && x.season === r.season && x.from <= r.from && x.to >= r.to).map(x => x.id);
      return who(`Who won ${r.len} straight games (weeks ${r.from}–${r.to}) in ${r.season}?`, r.id, r.season, `${name(r.id)} did it with “${r.team}”.`, also);
    },
    headToHead() {
      const active = new Set(members.filter(m => m.active).map(m => m.id));
      const pairs = Object.entries(H.h2h || {}).filter(([k, v]) => { const [a, b] = k.split("|"); return active.has(a) && active.has(b) && v[0] + v[1] + v[2] >= 3; });
      if (!pairs.length) return null;
      const [k, v] = pick(pairs);
      const [a, b] = k.split("|");
      const fmt = (w, l, t) => `${w}–${l}${t ? "–" + t : ""}`;
      const right = fmt(v[0], v[1], v[2]);
      const alts = [fmt(v[1], v[0], v[2]), fmt(v[0] + 1, Math.max(0, v[1] - 1), v[2]), fmt(Math.max(0, v[0] - 1), v[1] + 1, v[2]),
        fmt(v[0] + 2, Math.max(0, v[1] - 2), v[2]), fmt(Math.max(0, v[0] - 2), v[1] + 2, v[2]), fmt(v[0] + 1, v[1] + 1, v[2])];
      const wrong = [...new Set(alts.filter(x => x !== right))].slice(0, 3);
      if (wrong.length < 3) return null;
      const opts = shuffle([right, ...wrong]);
      return { q: `What is ${name(a)}'s all-time record against ${name(b)}?`, options: opts, answer: opts.indexOf(right),
        why: `${name(a)} is ${right} against ${name(b)}, scoring ${pts(v[3])} to ${pts(v[4])}.` };
    },
  };

  const out = [], seenQ = new Set();
  const order = shuffle(Object.keys(T));
  // one of each kind first, then any kind again if some came up empty
  for (let pass = 0; pass < 3 && out.length < count; pass++) {
    for (const k of order) {
      if (out.length >= count) break;
      let q = null;
      try { q = T[k](); } catch (_) { q = null; }
      if (q && !seenQ.has(q.q)) { seenQ.add(q.q); out.push({ kind: k, ...q }); }
    }
  }
  return out;
}
