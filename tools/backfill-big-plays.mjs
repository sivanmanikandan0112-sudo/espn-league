// One-time rebuild of big plays for weeks the live feed didn't run, from ESPN's public NFL play-by-play,
// Usage (from a folder with live2026.js and live2026-stats.js downloaded from the site): node backfill-big-plays.mjs 1 2 3
// Writes backfill.json ({week: [plays]}); store each week with wrangler kv key put "plays-week:2026:<w>" --remote.
// using the live feed's rules (same labels, same thresholds, same per-play points).
import fs from "fs";
globalThis.window = {};
(0, eval)(fs.readFileSync("live2026.js", "utf8"));
const D = window.LEAGUE_DATA[2026];
(0, eval)(fs.readFileSync("live2026-stats.js", "utf8"));
const ST = window.LEAGUE_STATS[2026];
// the stat that has to be on a player's official week line for a play to be his: [raw stat id, minimum]
const NEEDS = { "passing TD": [4, 1], "receiving TD": [43, 1], "rushing TD": [25, 1], "interception thrown": [20, 1], "fumble lost": [72, 1], "2-pt conversion": null, "return TD": [[93, 101, 102, 103, 104], 1] };
const countOf = (r, ids) => (Array.isArray(ids) ? ids : [ids]).reduce((n, id) => n + (r[id] || 0), 0);
const S = {}, SD = {};
for (const x of D.settings.scoring) { S[x.stat] = x.pts; SD[x.stat] = x.dst ?? x.pts; }
const s = id => S[id] || 0;
const NFL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const get = async u => { for (let i = 0; i < 3; i++) { try { const r = await fetch(u); if (r.ok) return r.json(); } catch (_) {} await new Promise(r => setTimeout(r, 800)); } throw new Error("fetch " + u); };
function playPoints(kind, y) {
  const long = (b40, b50) => (y >= 40 ? s(b40) : 0) + (y >= 50 ? s(b50) : 0);
  switch (kind) {
    case "receiving TD": return s(43) + y * s(42) + s(53) + long(45, 46);
    case "rushing TD": return s(25) + y * s(24) + s(23) + long(35, 36);
    case "passing TD": return s(4) + y * s(3) + s(1) + long(15, 16);
    case "catch": return y * s(42) + s(53);
    case "run": return y * s(24) + s(23);
    case "pass": return y * s(3) + s(1);
    case "field goal": return s(83) + (y >= 60 ? (S[201] ?? S[198] ?? s(74)) : y >= 50 ? (S[198] ?? s(74)) : y >= 40 ? s(77) : s(80));
  }
}
const SUFFIX = /\b(jr|sr|ii|iii|iv|v)\b\.?/gi;
const clean = n => String(n).replace(SUFFIX, "").toLowerCase().replace(/[^a-z]/g, "");
// "J.Chase" / "Ja.Williams" / "A.St. Brown" -> {first: "j", last: "chase"}
function tok(t) { const i = t.indexOf("."); return i < 0 ? null : { first: t.slice(0, i).toLowerCase(), last: clean(t.slice(i + 1)) }; }
const NAME = "([A-Z][A-Za-z]{0,2}\\.(?:St\\. ?)?[A-Z][A-Za-z'’-]+(?:-[A-Z][a-z]+)?)";

async function week(w) {
  const wk = D.weeks.find(x => x.week === w);
  // rostered players that week, by NFL team
  const roster = {};
  for (const g of wk.games) for (const side of g.sides) for (const p of side.lineup) {
    (roster[p.team] = roster[p.team] || []).push({ p, game: g.id, team: side.team });
  }
  // a player in that week's league lineups: on this NFL team first; failing that, anyone in the league with that
  // name (lineups carry a player's current NFL team, so someone traded since would otherwise be missed)
  const everyone = Object.values(roster).flat();
  const nameHit = (x, list) => list.filter(({ p }) => p.pos !== "D/ST" && p.pos !== "K" && clean(p.name.split(" ").slice(1).join(" ")) === x.last && p.name.toLowerCase().startsWith(x.first));
  const find = (nfl, t) => {
    if (!t) return [];
    const x = tok(t); if (!x) return [];
    const same = nameHit(x, roster[nfl] || []);
    return same.length ? same : nameHit(x, everyone);
  };
  const sb = await get(`${NFL}/scoreboard?dates=2026&seasontype=2&week=${w}`);
  const out = [];
  var rejected = [];
  for (const ev of sb.events) {
    const sum = await get(`${NFL}/summary?event=${ev.id}`);
    const comp = sum.header.competitions[0];
    const abbr = Object.fromEntries(comp.competitors.map(c => [c.team.id, c.team.abbreviation]));
    const homeId = comp.competitors.find(c => c.homeAway === "home").team.id, awayId = comp.competitors.find(c => c.homeAway === "away").team.id;
    let hs = 0, as = 0;
    const plays = (sum.drives?.previous || []).flatMap(d => (d.plays || []).map(p => ({ ...p, drive: d.team?.abbreviation })));
    for (const pl of plays) {
      let text = pl.text || "";
      const scorer = pl.homeScore > hs ? abbr[homeId] : pl.awayScore > as ? abbr[awayId] : null;
      const gained = Math.max(pl.homeScore - hs, pl.awayScore - as);
      hs = pl.homeScore; as = pl.awayScore;
      if (/REVERSED\./.test(text)) text = text.slice(text.lastIndexOf("REVERSED.") + 9);
      if (/NO PLAY|No Play/.test(text)) continue;
      const type = pl.type?.text || "";
      const off = abbr[pl.start?.team?.id] || pl.drive || null;
      const t = Date.parse(pl.wallclock) || 0;
      const add = (hit, kind, label, delta) => { if (!hit) return; const { p, game, team } = hit;
        // check the play against his official stats that week (when the site has them)
        const line = ST[`${w}|${p.id}`], r = line && line.r;
        if (r) {
          // (a long gain needs a catch / carry / completion on his line; his week's total yards can be lower than one
          // play's because of losses on other plays)
          const need = NEEDS[kind] !== undefined ? NEEDS[kind] : /catch$/.test(kind) ? [53, 1] : /run$/.test(kind) ? [23, 1] : /pass$/.test(kind) ? [1, 1] : null;
          if (need && !(countOf(r, need[0]) >= need[1])) { rejected.push(`${p.name} ${label}`); return; }
          // never more touchdowns / turnovers than his line has (the play-by-play sometimes repeats a scoring row)
          if (need && NEEDS[kind] && out.filter(e => e.pid === p.id && e.kind === kind).length >= countOf(r, need[0])) { rejected.push(`${p.name} ${label} (repeat)`); return; }
        }
        if (out.some(e => e.pid === p.id && e.label === label && e.score === `${hs}-${as}`)) return; // the same row twice
        out.push({ t, team, pid: p.id, name: p.name, pos: p.pos, nfl: p.team, kind, label, delta: Math.round(delta * 100) / 100, starter: !["BE", "IR"].includes(p.slot), game, score: `${hs}-${as}` }); };
      // two league players with the same short name (B.Robinson): keep the one whose week stats have this kind of play
      const one = (list, stat) => {
        if (list.length > 1 && stat) list = list.filter(({ p }) => ((ST[`${w}|${p.id}`] || {}).r || {})[stat] > 0);
        return list.length === 1 ? list[0] : null;
      };
      // yards from the play text when it has them (a reviewed play's statYardage can be 0)
      const ym = text.match(/ for (-?\d+) yards?/), y = ym ? +ym[1] : / for no gain/.test(text) ? 0 : (pl.statYardage || 0);
      const full = text;
      text = text.split("TWO-POINT CONVERSION")[0]; // the play itself; a conversion try is handled below
      const pass = text.match(new RegExp(NAME + " pass (?:incomplete )?(?:short |deep )?(?:left |right |middle )?(?:intended for " + NAME + "|to " + NAME + ")"));
      const passer = pass && one(find(off, pass[1]), 1), receiver = pass && one(find(off, pass[3]), 53);
      const sacked = text.match(new RegExp(NAME + " sacked"));
      const runner = !pass && !sacked && text.match(new RegExp(NAME + " (?:up the middle|left (?:end|tackle|guard)|right (?:end|tackle|guard)|scrambles|rushes|to the [A-Z]{2,3} \\d+ for|for -?\\d+ yards?)"));
      const rusher = runner && one(find(off, runner[1]), 23);
      const td = /TOUCHDOWN/.test(text) && !/TOUCHDOWN NULLIFIED/.test(text);
      const intercepted = /INTERCEPTED/.test(text);
      // touchdowns and big gains (a touchdown wins: the live feed shows one play per player)
      if (pass && !intercepted && /pass .*?(?:to|for)/.test(text) && !/incomplete/.test(text.split(".")[0] + text)) {
        if (td && scorer === off) { add(passer, "passing TD", `${y}-yd passing TD`, playPoints("passing TD", y)); add(receiver, "receiving TD", `${y}-yd receiving TD`, playPoints("receiving TD", y)); }
        else {
          if (y >= 30) add(receiver, `${y}-yd catch`, `${y}-yd catch`, playPoints("catch", y));
          if (y >= 50) add(passer, `${y}-yd pass`, `${y}-yd pass`, playPoints("pass", y));
        }
      } else if (rusher && !/FUMBLES/.test(text)) {
        if (td && scorer === off) add(rusher, "rushing TD", `${y}-yd rushing TD`, playPoints("rushing TD", y));
        else if (y >= 30) add(rusher, `${y}-yd run`, `${y}-yd run`, playPoints("run", y));
      }
      if (intercepted && passer) add(passer, "interception thrown", "interception thrown", s(20));
      // fumbles lost: the other team recovered
      if (/FUMBLES/.test(text) && pl.isTurnover) {
        const who = sacked ? one(find(off, sacked[1])) : pass ? receiver : rusher || one(find(off, (text.match(new RegExp(NAME + "[^.]* FUMBLES")) || [])[1]));
        add(who, "fumble lost", "fumble lost", s(72));
      }
      // field goals worth 5+ points (50+ yards in this league)
      const fg = text.match(new RegExp(NAME + " (\\d+) yard field goal is GOOD"));
      if (fg) { const pts = playPoints("field goal", +fg[2]); if (pts >= 5) add(one((roster[off] || []).filter(({ p }) => p.pos === "K" && tok(fg[1]) && clean(p.name.split(" ").slice(1).join(" ")) === tok(fg[1]).last)), "50+ yd field goal", `${fg[2]}-yd field goal`, pts); }
      // defensive and special-teams touchdowns, for the scoring team's D/ST
      if (scorer && gained >= 6 && (scorer !== off || /Return Touchdown|Blocked .*Touchdown/.test(type))) {
        const both = type + " " + text;
        const stat = /Intercept/i.test(both) ? 103 : /Fumble/i.test(both) ? 104 : /Kickoff|Kick Return/i.test(both) ? 101 : /Punt Return/i.test(both) ? 102 : /Blocked/i.test(both) ? 93 : null;
        if (stat && scorer && gained >= 6) {
          const dst = one((roster[scorer] || []).filter(({ p }) => p.pos === "D/ST"));
          const pts = SD[stat] ?? 6;
          if (pts >= 5) add(dst, "return TD", "return TD", pts);
        }
      }
      // two-point conversions
      if (/ATTEMPT SUCCEEDS/.test(full)) {
        const tp = full.slice(full.indexOf("TWO-POINT CONVERSION ATTEMPT"));
        const p2 = tp.match(new RegExp(NAME + " pass to " + NAME));
        const r2 = !p2 && tp.match(new RegExp("ATTEMPT\\. " + NAME + " rushes"));
        if (p2) { add(one(find(scorer || off, p2[1])), "2-pt conversion", "2-pt conversion", s(19)); add(one(find(scorer || off, p2[2])), "2-pt conversion", "2-pt conversion", s(44)); }
        if (r2) add(one(find(scorer || off, r2[1])), "2-pt conversion", "2-pt conversion", s(26));
      }
    }
  }
  if (rejected.length) console.error(`week ${w}: dropped ${rejected.length} plays that don't match official stats:`, rejected.join("; "));
  return out.sort((a, b) => b.t - a.t);
}
const weeks = process.argv.slice(2).map(Number);
const res = {};
for (const w of weeks) { res[w] = await week(w); console.error("week", w, res[w].length, "plays"); }
fs.writeFileSync("backfill.json", JSON.stringify(res));
