(function () {
  "use strict";
  const IDX = window.LEAGUE_INDEX;
  const main = document.getElementById("main");
  if (!IDX) {
    main.innerHTML = '<div class="empty">No league data yet. Run <code>python3 build.py</code>.</div>';
    return;
  }
  window.LEAGUE_DATA = window.LEAGUE_DATA || {};

  // ---------------------------------------------------------------- helpers
  const POS = ["QB", "RB", "WR", "TE"];
  const INJ = { QUESTIONABLE: "Q", DOUBTFUL: "D", OUT: "OUT", INJURY_RESERVE: "IR", SUSPENSION: "SUSP", PROBABLE: "P", DAY_TO_DAY: "DTD" };
  const pad = n => String(n).padStart(2, "0");
  const fmt = n => Number(n || 0).toFixed(2);
  const pct = n => (n == null ? "—" : (n >= 99.95 ? ">99.9" : n > 0 && n < 0.1 ? "<0.1" : Number(n).toFixed(1)) + "%");
  const signed = n => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(1);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const record = t => t.wins + "–" + t.losses + (t.ties ? "–" + t.ties : "");
  const ordinal = n => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
  const finishText = r => (r === 1 ? "Champion" : r ? ordinal(r) : "—");
  const initials = name => String(name).replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";
  const logoImg = (src, name, cls) => src
    ? `<img class="logo ${cls || ""}" src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-ini="${esc(initials(name))}">`
    : `<span class="logo ${cls || ""}">${esc(initials(name))}</span>`;
  const logo = t => logoImg(t.logo, t.name);
  const chev = '<svg class="chev" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
  const ago = iso => {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 2) return "just now";
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    if (h < 36) return h + " hour" + (h === 1 ? "" : "s") + " ago";
    return Math.round(h / 24) + " days ago";
  };
  const memberName = id => (IDX.history.members.find(m => m.id === id) || {}).name || "Manager";

  document.addEventListener("error", e => {
    const img = e.target;
    if (img.tagName === "IMG" && img.classList.contains("logo")) {
      const span = document.createElement("span");
      span.className = img.className;
      span.textContent = img.dataset.ini || "?";
      img.replaceWith(span);
    }
  }, true);

  const store = {
    get(k, d) { try { const v = localStorage.getItem("lhq:" + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem("lhq:" + k, JSON.stringify(v)); } catch (_) { /* ignore */ } },
  };

  // ---------------------------------------------------------------- data loading
  function parseAssigned(text) { return JSON.parse(text.slice(text.indexOf('={"') + 1, text.lastIndexOf("}") + 1)); }

  function loadSeason(season) {
    if (window.LEAGUE_DATA[season]) return Promise.resolve(window.LEAGUE_DATA[season]);
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "data/" + season + ".js?t=" + Date.now();
      s.onload = () => (window.LEAGUE_DATA[season] ? resolve(window.LEAGUE_DATA[season]) : reject(new Error("empty")));
      s.onerror = () => reject(new Error("load failed"));
      document.head.appendChild(s);
    });
  }

  // ---------------------------------------------------------------- state & routing
  const state = {
    season: IDX.current, tab: "standings", params: new URLSearchParams(),
    sort: store.get("sort", "standing"), q: "", open: new Set(), sideWeek: null,
    h2hA: null, h2hB: null, openMember: null,
  };
  let D = null, L = null, teamById = {};

  function href(tab, extra) {
    const p = new URLSearchParams(extra || {});
    if (state.season !== IDX.current) p.set("season", state.season);
    const qs = p.toString();
    return "#/" + (tab === "standings" ? "" : tab) + (qs ? "?" + qs : "");
  }

  async function route() {
    const hash = location.hash.replace(/^#/, "") || "/";
    const [path, qs] = hash.split("?");
    const params = new URLSearchParams(qs || "");
    const tab = ["matchups", "insights", "trades", "history"].find(t => path.startsWith("/" + t)) || "standings";
    const season = Number(params.get("season")) || IDX.current;
    state.tab = tab;
    state.params = params;
    if (!IDX.seasons.includes(season)) state.season = IDX.current;
    else if (season !== state.season || !D) {
      state.season = season;
      state.open = new Set();
      state.sideWeek = null;
    }
    try {
      D = await loadSeason(state.season);
    } catch (e) {
      main.innerHTML = '<div class="empty">Couldn\'t load the ' + state.season + " season. Try reloading.</div>";
      return;
    }
    L = D.league;
    teamById = Object.fromEntries(D.teams.map(t => [t.id, t]));
    if (state.sideWeek == null || !D.weeks.find(w => w.week === state.sideWeek)) {
      const finals = D.weeks.filter(w => w.week <= L.regularSeasonWeeks || L.over);
      state.sideWeek = (finals[finals.length - 1] || D.weeks[D.weeks.length - 1] || {}).week;
    }
    renderChrome();
    if (tab === "matchups") renderMatchups();
    else if (tab === "insights") renderInsights();
    else if (tab === "trades") renderTrades();
    else if (tab === "history") renderHistory();
    else renderStandings();
  }

  // ---------------------------------------------------------------- chrome (header, tabs, footer, banner)
  function renderChrome() {
    const isCur = L.isCurrent;
    document.title = IDX.name + (isCur ? "" : " · " + L.season) + " · Standings, Matchups & Trades";
    document.getElementById("league-name").textContent = IDX.name;
    document.getElementById("brand-link").setAttribute("href", href("standings"));
    document.getElementById("season-label").textContent = L.season + " season";
    const champ = D.teams.find(t => t.finalRank === 1);
    document.getElementById("week-label").textContent = L.over ? "FINAL" : L.currentWeek > L.regularSeasonWeeks ? "PLAYOFFS" : "WEEK " + pad(L.currentWeek);
    document.getElementById("teams-label").textContent = L.over && champ ? "Champion · " + champ.name : L.size + " teams · ESPN Fantasy";
    document.querySelectorAll(".tabs a").forEach(a => {
      const t = a.dataset.tab;
      a.setAttribute("href", href(t));
      a.classList.toggle("active", t === state.tab);
      if (t === state.tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    const sel = document.getElementById("season-select");
    sel.innerHTML = IDX.seasons.map(s => `<option value="${s}"${s === state.season ? " selected" : ""}>${s} season${s === IDX.current ? "" : ""}</option>`).join("");
    document.getElementById("footer-notes").innerHTML = footerNotes();
    document.getElementById("updated").innerHTML = "Data snapshot · " + esc(new Date(D.updated).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })) +
      (isCur && !L.over ? ` <span class="live-chip${live.on ? " on" : ""}" id="live-chip">${live.on ? "Live · checking every 2 min" : ""}</span>` : "");
    renderBanner();
  }

  function footerNotes() {
    if (state.tab === "history") {
      return `<p><strong>All-time records</strong> follow each member's ESPN account, not the team slot, so people who left keep their history and new members start fresh.
        Head-to-head counts regular-season and championship-bracket games; consolation games are left out.</p>`;
    }
    if (state.tab === "insights") {
      return `<p><strong>Playoff odds</strong> replay the rest of the regular season and the playoff bracket 10,000 times. Each team's weekly score is drawn from a blend of its scoring so far and its projected lineup strength, pulled halfway back toward the league average because half a season is a small sample.
        <strong>All-play</strong> is the record a team would have playing every other team every week; <strong>luck</strong> is actual wins minus the wins that all-play rate predicts.
        <strong>Efficiency</strong> is points started as a share of the best possible lineup in hindsight.</p>`;
    }
    if (state.tab === "trades" && !L.isCurrent) {
      return `<p>ESPN doesn't keep the league activity feed for past seasons, so ${L.season} trades are rebuilt from week-to-week roster swaps confirmed against the transaction log.
        A player traded twice in the same week can be missed.</p>`;
    }
    if (!L.over) {
      return `<p><strong>Power value</strong> is how many points a team's starting lineup is expected to score over the rest of the fantasy season.
        Each remaining week we start the best available QB, RBs, WRs, TE and FLEX by ESPN's projections, skipping byes and players ESPN expects to miss time,
        and replay the season 500 times with random injuries. So bench players count exactly as often as they'd really play: handcuffs earn credit when a starter goes down,
        stashed injured players earn it once they're back, and a backup QB who never sees the field adds almost nothing. Kickers and defenses are left out.
        "Starts X of Y wks" on each player is how often he makes that lineup. Bar segments are each position's share; the number is the team's rank there.</p>`;
    }
    return `<p><strong>${L.season} season.</strong> Bar segments show the points each team actually started at QB, RB, WR and TE in the regular season; the number is its rank at that position.
      Rosters are as they stood at the end of the season, with each player's final position rank.</p>`;
  }

  function renderBanner() {
    const el = document.getElementById("banner");
    const hours = (Date.now() - new Date(IDX.updated).getTime()) / 3600000;
    const cur = window.LEAGUE_DATA[IDX.current];
    const inSeason = cur ? !cur.league.over : true;
    if (state.season === IDX.current && inSeason && hours > 8) {
      el.innerHTML = `<div class="banner" role="status"><strong>Heads up:</strong> these scores were last updated ${esc(ago(IDX.updated))}.
        The automatic refresh may be failing, usually because the ESPN login it uses has expired.</div>`;
    } else if (state.season !== IDX.current) {
      el.innerHTML = `<div class="banner past">Viewing the <strong>${L.season}</strong> season. <a href="#/${state.tab === "standings" ? "" : state.tab}">Back to ${IDX.current}</a></div>`;
    } else {
      el.innerHTML = "";
    }
  }

  // ---------------------------------------------------------------- standings
  function sorts() {
    const s = { standing: ["League standing", (a, b) => a.standing - b.standing] };
    if (!L.over) s.power = ["Power ranking", (a, b) => a.powerRank - b.powerRank];
    if (L.over) s.finish = ["Final finish", (a, b) => (a.finalRank || 99) - (b.finalRank || 99)];
    if (D.teams.some(t => t.odds)) s.odds = ["Playoff odds", (a, b) => (b.odds ? b.odds.playoffPct : 0) - (a.odds ? a.odds.playoffPct : 0)];
    s.pf = ["Points scored", (a, b) => b.pf - a.pf];
    s.luck = ["Luck", (a, b) => (b.luck || 0) - (a.luck || 0)];
    s.eff = ["Lineup efficiency", (a, b) => (b.efficiency || 0) - (a.efficiency || 0)];
    POS.forEach(p => { s[p] = [p + (L.over ? " points" : " power"), (a, b) => a.posRank[p] - b.posRank[p]]; });
    return s;
  }

  function rankFor(t, i) {
    if (state.sort === "standing") return t.standing;
    if (state.sort === "power") return t.powerRank;
    if (state.sort === "finish") return t.finalRank || i + 1;
    if (POS.includes(state.sort)) return t.posRank[state.sort];
    return i + 1;
  }

  const powerWeekCount = () => (L.powerWeeks ? L.powerWeeks[1] - L.powerWeeks[0] + 1 : 0);
  const PW = () => (L.powerWeeks ? L.powerWeeks[0] + "–" + L.powerWeeks[1] : "");
  function startsText(p) {
    const s = p.starts;
    const n = s >= 0.95 ? Math.round(s) : s >= 0.05 ? "<1" : "0";
    return `Starts ${n} of ${powerWeekCount()} wks${p.returns ? ` · back ~wk ${p.returns}` : ""}`;
  }

  function playerCard(p) {
    const bench = p.slot === "BE" || p.slot === "IR";
    const slotCls = POS.includes(p.slot) ? p.slot : POS.includes(p.pos) && !bench ? p.pos : "";
    let rankLine, extra = "";
    if (L.over) {
      rankLine = `<span class="num" title="Where he finished among all ${esc(p.pos)}s in ${L.season}">${p.posRank ? L.season + " " + esc(p.pos) + " " + p.posRank : "—"}</span><span class="num">${Number(p.seasonPts || 0).toFixed(1)} pts</span>`;
    } else {
      rankLine = `<span class="num" title="Rest-of-season rank among all ${esc(p.pos)}s, by ESPN projection (${Math.round(p.ros || 0)} pts)">${p.rosRank ? "ROS " + esc(p.pos) + " " + p.rosRank : "ROS —"}</span>${p.injury ? `<span class="inj" title="${esc(p.injury.replace(/_/g, " "))}">${esc(INJ[p.injury] || p.injury.replace(/_/g, " "))}</span>` : ""}`;
      if (p.starts != null) extra = `<div class="pstarts" title="How often this player makes the best lineup in weeks ${PW()}, averaged over 500 simulated rest-of-seasons with injuries">${startsText(p)}</div>`;
    }
    return `<div class="pcard${bench ? " bench" : ""}">
      <div class="pcard-top"><span class="slot ${esc(slotCls)}">${esc(p.slot)}</span><span>${esc(p.pos)}${p.team ? " · " + esc(p.team) : ""}</span></div>
      <div class="pname" title="${esc(p.name)}">${esc(p.name)}</div>
      <div class="pmeta">${rankLine}</div>${extra}
    </div>`;
  }

  function teamCard(t, i, maxPos) {
    const open = state.open.has(t.id);
    const segs = POS.map(p => {
      const w = maxPos ? (t.posPower[p] / maxPos) * 100 : 0;
      return `<span class="seg ${p}" style="width:${w.toFixed(2)}%" title="${p}: ${Math.round(t.posPower[p])} ${L.over ? "points started" : "lineup pts"} · #${t.posRank[p]} in league">${t.posRank[p]}</span>`;
    }).join("");
    const starters = t.roster.filter(p => p.slot !== "BE" && p.slot !== "IR");
    const bench = t.roster.filter(p => p.slot === "BE" || p.slot === "IR");
    const third = L.over
      ? `<span class="stat"><div class="stat-k">Finish</div><div class="stat-v${t.finalRank === 1 ? " champ" : ""}">${finishText(t.finalRank)}</div></span>`
      : `<span class="stat"><div class="stat-k" title="Expected starting-lineup points, weeks ${PW()}">Power value</div><div class="stat-v">${(t.power || 0).toLocaleString()}</div></span>`;
    const odds = t.odds ? `<span>Playoff odds <b>${pct(t.odds.playoffPct)}</b></span><span>Title odds <b>${pct(t.odds.titlePct)}</b></span>` : "";
    return `<article class="team${open ? " open" : ""}" data-id="${t.id}">
      <button class="team-head" aria-expanded="${open}" data-toggle="${t.id}">
        <span class="rank">${pad(rankFor(t, i))}</span>
        ${logo(t)}
        <span style="min-width:0"><div class="team-name">${esc(t.name)}</div><div class="team-mgr">${esc(t.manager)}</div></span>
        <span class="stats">
          <span class="stat"><div class="stat-k">Record</div><div class="stat-v">${record(t)}</div></span>
          <span class="stat"><div class="stat-k">Points for</div><div class="stat-v">${fmt(t.pf)}</div></span>
          ${third}
        </span>
        ${chev}
      </button>
      <div class="bar" aria-label="Position ranks: ${POS.map(p => p + " " + t.posRank[p]).join(", ")}">${segs}</div>
      ${open ? `<div class="team-body">
        <div class="facts">
          <span>League standing <b>#${t.standing}</b></span>${L.over ? `<span>Finish <b>${finishText(t.finalRank)}</b></span>` : `<span>Power rank <b>#${t.powerRank}</b></span>`}
          <span>Points against <b>${fmt(t.pa)}</b></span><span>Streak <b>${esc(t.streak)}</b></span>
          ${t.allPlayW != null ? `<span>All-play <b>${t.allPlayW}–${t.allPlayL}</b></span><span>Luck <b class="${t.luck > 0 ? "pos" : t.luck < 0 ? "neg" : ""}">${signed(t.luck)} wins</b></span>` : ""}
          ${t.efficiency != null ? `<span>Lineup efficiency <b>${t.efficiency}%</b></span><span>Bench pts left <b>${Number(t.benchLeft).toFixed(1)}</b></span>` : ""}
          ${odds}
        </div>
        <div class="roster-title"><h3>${L.over ? "Final roster · starters" : "Starting lineup"}</h3><span class="muted" style="font-size:12px">${L.over ? "Final position rank · season points" : "ROS position rank · expected starts, weeks " + PW()}</span></div>
        <div class="roster">${starters.map(playerCard).join("")}</div>
        <div class="roster-title" style="margin-top:14px"><h3>Bench</h3></div>
        <div class="roster">${bench.map(playerCard).join("") || '<span class="muted">Empty</span>'}</div>
      </div>` : ""}
    </article>`;
  }

  function sidebar() {
    const wk = D.weeks.find(x => x.week === state.sideWeek);
    const rows = [];
    (wk ? wk.games : []).forEach(g => g.sides.forEach(s => teamById[s.team] && rows.push({ team: teamById[s.team], pts: s.pts })));
    let winners = "";
    if (rows.length) {
      const hi = Math.max(...rows.map(r => r.pts)), lo = Math.min(...rows.map(r => r.pts));
      const block = (label, val, list) => `
        <div class="panel-row"><span class="kicker">${label}</span>${list.length > 1 ? '<span class="kicker">Tied</span>' : ""}</div>
        <div class="big">${fmt(val)}<small>PTS</small></div>
        ${list.map(r => `<div class="mini-team">${logo(r.team)}${esc(r.team.name)}</div>`).join("")}`;
      winners = block("Highest score", hi, rows.filter(r => r.pts === hi)) + '<hr class="divider">' + block("Lowest score", lo, rows.filter(r => r.pts === lo));
    }
    const opts = D.weeks.slice().reverse().map(w => `<option value="${w.week}"${w.week === state.sideWeek ? " selected" : ""}>Week ${w.week}${w.playoffs ? " (playoffs)" : ""}</option>`).join("");
    const pf = D.teams.slice().sort((a, b) => b.pf - a.pf)[0];
    let first;
    if (L.over) {
      const c = D.teams.find(t => t.finalRank === 1) || D.teams[0];
      first = `<div class="leader"><span class="kicker">Champion</span><span class="crown">01</span><span><div class="mini-team">${logo(c)}${esc(c.name)}</div><div class="val">${esc(c.manager)} · ${record(c)}</div></span></div>`;
    } else {
      const pl = D.teams.slice().sort((a, b) => a.powerRank - b.powerRank)[0];
      first = `<div class="leader"><span class="kicker">Power leader</span><span class="crown">01</span><span><div class="mini-team">${logo(pl)}${esc(pl.name)}</div><div class="val">${pl.power.toLocaleString()} projected lineup pts</div></span></div>`;
    }
    let oddsLead = "";
    if (D.teams.some(t => t.odds)) {
      const fav = D.teams.slice().sort((a, b) => b.odds.titlePct - a.odds.titlePct)[0];
      oddsLead = `<div class="leader"><span class="kicker">Title favorite</span><span class="crown">01</span><span><div class="mini-team">${logo(fav)}${esc(fav.name)}</div><div class="val">${pct(fav.odds.titlePct)} to win it all · <a href="${href("insights")}">all odds</a></div></span></div>`;
    }
    return `<aside class="side">
      <section>
        <div class="section-head"><h2>Weekly winners &amp; losers</h2></div>
        <div class="panel">
          <label class="field" style="justify-content:space-between">Scoring week <select id="side-week">${opts}</select></label>
          <p class="note${wk && !wk.final ? " live" : ""}">${wk && !wk.final ? "Provisional · week in progress" : "Final"}</p>
          <hr class="divider">
          ${winners}
          <a class="cta" href="${href("matchups", { week: state.sideWeek })}">View Week ${state.sideWeek} matchups</a>
        </div>
      </section>
      <section>
        <div class="section-head"><h2>Setting the pace</h2></div>
        <div class="panel">
          ${first}${oddsLead}
          <div class="leader"><span class="kicker">Most points scored</span><span class="crown">01</span>
            <span><div class="mini-team">${logo(pf)}${esc(pf.name)}</div><div class="val">${fmt(pf.pf)} season points</div></span></div>
        </div>
      </section>
    </aside>`;
  }

  function renderStandings() {
    const S = sorts();
    if (!S[state.sort]) state.sort = "standing";
    const q = state.q.trim().toLowerCase();
    const ranked = D.teams.slice().sort(S[state.sort][1]).map((t, i) => [t, i]);
    const shown = q ? ranked.filter(([t]) => t.name.toLowerCase().includes(q) || t.manager.toLowerCase().includes(q) ||
      t.roster.some(p => p.name.toLowerCase().includes(q))) : ranked;
    const maxPos = Math.max(...D.teams.map(t => POS.reduce((s, p) => s + t.posPower[p], 0)));
    const allOpen = D.teams.every(t => state.open.has(t.id));
    main.innerHTML = `<div class="layout">
      <section>
        <div class="section-head">
          <div><h1>League standings <span class="pill">${L.size} teams</span></h1>
          <p class="sub">${L.over ? "How the " + L.season + " season finished." : "The whole league. Every roster. All the power."}</p></div>
          <button class="linkbtn" id="expand-all">${allOpen ? "Collapse all" : "Expand all"} →</button>
        </div>
        <div class="controls">
          <label class="search"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6"/></svg>
            <input id="q" type="search" placeholder="Find a team, manager or player" value="${esc(state.q)}" aria-label="Search teams, managers, or players"></label>
          <label class="field">Sort by <select id="sort">${Object.entries(S).map(([k, [label]]) => `<option value="${k}"${k === state.sort ? " selected" : ""}>${label}</option>`).join("")}</select></label>
        </div>
        <div class="legend"><span>Team / ${esc(S[state.sort][0])}</span>${POS.map(p => `<span><i class="dot ${p}"></i>${p}</span>`).join("")}<span class="right">Bar numbers = position rank</span></div>
        <div class="teams" id="teams">${shown.length ? shown.map(([t, i]) => teamCard(t, i, maxPos)).join("") : '<div class="empty">No team, manager or player matches that.</div>'}</div>
      </section>
      ${sidebar()}
    </div>`;
  }

  // ---------------------------------------------------------------- matchups
  const TIER = { WINNERS_BRACKET: "Playoffs", WINNERS_CONSOLATION_LADDER: "Consolation", LOSERS_CONSOLATION_LADDER: "Consolation" };

  function boxCol(side) {
    const t = teamById[side.team];
    const start = side.lineup.filter(p => p.slot !== "BE" && p.slot !== "IR");
    const bench = side.lineup.filter(p => p.slot === "BE" || p.slot === "IR");
    const line = (p, b) => `<div class="box-line${b ? " bench" : ""}"><span class="slot ${esc(POS.includes(p.slot) ? p.slot : p.pos)}" style="font-size:10px;font-weight:700;text-align:center">${esc(p.slot)}</span><span class="pn" title="${esc(p.name)} · ${esc(p.pos)} ${esc(p.team)}">${esc(p.name)}</span><span class="pp">${fmt(p.pts)}</span></div>`;
    return `<div class="box-col"><h4>${esc(t.name)}</h4>${start.map(p => line(p, false)).join("")}${bench.length ? '<div class="box-sep">BENCH</div>' + bench.map(p => line(p, true)).join("") : ""}</div>`;
  }

  function recapCard(w) {
    const r = (D.recaps || {})[w];
    if (!r) return "";
    const tn = id => esc((teamById[id] || {}).name || "?");
    const item = (k, title, body) => `<div class="recap-item"><div class="kicker">${k}</div><div class="recap-title">${title}</div><div class="recap-body">${body}</div></div>`;
    const items = [];
    items.push(item("Top score", tn(r.high.team), fmt(r.high.pts) + " pts"));
    items.push(item("Low score", tn(r.low.team), fmt(r.low.pts) + " pts"));
    if (r.blowout) items.push(item("Biggest blowout", tn(r.blowout.winner), `beat ${tn(r.blowout.loser)} by ${Number(r.blowout.margin).toFixed(2)}`));
    if (r.closest) items.push(item("Closest game", tn(r.closest.winner), `edged ${tn(r.closest.loser)} by ${Number(r.closest.margin).toFixed(2)}`));
    if (r.topPlayer) items.push(item("Player of the week", esc(r.topPlayer.name), `${esc(r.topPlayer.pos)} · ${fmt(r.topPlayer.pts)} pts for ${tn(r.topPlayer.team)}`));
    if (r.mostLeft && r.mostLeft.pts > 0) items.push(item("Most left on the bench", tn(r.mostLeft.team), `${fmt(r.mostLeft.pts)} pts better lineup available`));
    if (r.benchStar && r.benchStar.pts > 0) items.push(item("Best bench performance", esc(r.benchStar.name), `${fmt(r.benchStar.pts)} pts on ${tn(r.benchStar.team)}'s bench`));
    return `<section class="recap"><div class="section-head"><h2>Week ${w} recap</h2></div><div class="recap-grid">${items.join("")}</div></section>`;
  }

  function renderMatchups() {
    const weeks = D.weeks.map(x => x.week);
    let w = parseInt(state.params.get("week"), 10);
    if (!weeks.includes(w)) w = L.over ? weeks[weeks.length - 1] : L.currentWeek;
    if (!weeks.includes(w)) w = weeks[weeks.length - 1];
    const wk = D.weeks.find(x => x.week === w);
    const open = state.params.get("game");
    const games = wk.games.slice().sort((a, b) => (a.tier === "WINNERS_BRACKET" ? 0 : 1) - (b.tier === "WINNERS_BRACKET" ? 0 : 1)).map(g => {
      const [a, b] = g.sides;
      const winnerId = g.winner === "HOME" ? a && a.team : g.winner === "AWAY" ? b && b.team : null;
      const row = s => {
        if (!s) return `<div class="side-row"><span class="logo">—</span><b>Bye</b><span></span></div>`;
        const t = teamById[s.team];
        const won = winnerId === s.team, lost = winnerId && !won;
        return `<div class="side-row${lost ? " lost" : ""}">${logo(t)}
          <span style="min-width:0"><div class="team-name">${esc(t.name)}${won ? '<span class="win-tag">W</span>' : ""}</div><div class="team-mgr">${esc(t.manager)} · ${record(t)}</div></span>
          <span class="score">${fmt(s.pts)}${s.proj != null ? `<small>proj ${fmt(s.proj)}</small>` : ""}</span></div>`;
      };
      const isOpen = open === String(g.id);
      const liveG = !wk.final;
      const wp = liveG && a && a.winProb != null ? `${esc(teamById[a.team].abbrev || "Home")} ${Math.round(a.winProb * 100)}% to win` : "";
      const tier = TIER[g.tier] || (g.playoff ? "Playoffs" : "");
      return `<article class="game${g.tier && g.tier !== "NONE" && g.tier !== "WINNERS_BRACKET" ? " consolation" : ""}">
        <button class="game-btn" data-game="${g.id}" aria-expanded="${isOpen}">${row(a)}${row(b)}
          <div class="game-foot"><span>${tier ? tier + " · " : ""}${liveG ? "In progress" : "Final"}${wp ? " · " + wp : ""}</span><span>${isOpen ? "Hide box score ↑" : "Box score ↓"}</span></div>
        </button>
        ${isOpen && a && b ? `<div class="box">${boxCol(a)}${boxCol(b)}</div>` : ""}
      </article>`;
    }).join("");
    main.innerHTML = `
      <div class="section-head"><div><h1>Week ${w} matchups</h1><p class="sub">${wk.final ? "Final scores." : "Live scores · week in progress."} Tap a matchup for the box score.</p></div></div>
      <div class="week-strip" role="tablist">${D.weeks.map(x => `<button data-week="${x.week}" class="${x.week === w ? "active" : ""}${x.playoffs ? " po" : ""}" role="tab" aria-selected="${x.week === w}">${x.playoffs ? "PO " : "Wk "}${x.week}</button>`).join("")}</div>
      ${wk.final ? recapCard(w) : ""}
      <div class="games">${games}</div>`;
    const active = main.querySelector(".week-strip .active");
    if (active) active.scrollIntoView({ block: "nearest", inline: "center" });
  }

  // ---------------------------------------------------------------- insights
  function table(cols, rows) {
    return `<div class="table-wrap"><table class="tbl"><thead><tr>${cols.map(c => `<th class="${c.num ? "n" : ""}">${c.label}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(r => `<tr>${cols.map(c => `<td class="${c.num ? "n" : ""}">${c.cell(r)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  const teamCell = t => `<span class="tcell">${logo(t)}<span><span class="tname">${esc(t.name)}</span><span class="team-mgr">${esc(t.manager)}</span></span></span>`;
  const barCell = (v, cls) => `<span class="pbar"><span class="pbar-fill ${cls || ""}" style="width:${Math.min(100, v || 0)}%"></span><span class="pbar-v">${pct(v)}</span></span>`;

  function renderInsights() {
    let html = "";
    const hasOdds = D.teams.some(t => t.odds);
    if (hasOdds) {
      const rows = D.teams.slice().sort((a, b) => b.odds.playoffPct - a.odds.playoffPct || b.odds.titlePct - a.odds.titlePct);
      html += `<section class="insight"><div class="section-head"><div><h2>Playoff race</h2>
        <p class="sub">Top ${L.playoffTeams} make the playoffs${L.playoffTeams < 2 ** L.playoffRounds ? `; top ${2 ** L.playoffRounds - L.playoffTeams} get a first-round bye` : ""}. Odds from 10,000 simulated finishes.</p></div></div>
        ${table([
          { label: "Team", cell: teamCell },
          { label: "Record", num: 1, cell: t => record(t) },
          { label: "Proj. wins", num: 1, cell: t => t.odds.projWins.toFixed(1) },
          { label: "Playoffs", num: 1, cell: t => barCell(t.odds.playoffPct) },
          { label: "Bye", num: 1, cell: t => barCell(t.odds.byePct, "bye") },
          { label: "Title", num: 1, cell: t => barCell(t.odds.titlePct, "title") },
        ], rows)}</section>`;
    } else if (!L.over) {
      html += `<section class="insight"><div class="empty">Playoff odds appear during the regular season. The bracket is set; follow it on the Matchups tab.</div></section>`;
    } else {
      const rows = D.teams.slice().sort((a, b) => (a.finalRank || 99) - (b.finalRank || 99));
      html += `<section class="insight"><div class="section-head"><div><h2>Final results</h2><p class="sub">How the ${L.season} season ended.</p></div></div>
        ${table([
          { label: "Finish", num: 1, cell: t => `<b class="${t.finalRank === 1 ? "champ" : ""}">${finishText(t.finalRank)}</b>` },
          { label: "Team", cell: teamCell },
          { label: "Record", num: 1, cell: t => record(t) },
          { label: "Seed", num: 1, cell: t => (t.seed && t.seed <= L.playoffTeams ? "#" + t.seed : "—") },
          { label: "Points for", num: 1, cell: t => fmt(t.pf) },
        ], rows)}</section>`;
    }
    const luckRows = D.teams.filter(t => t.allPlayW != null).sort((a, b) => b.luck - a.luck);
    if (luckRows.length) {
      html += `<section class="insight"><div class="section-head"><div><h2>Luck</h2>
        <p class="sub">All-play is the record you'd have playing every team every week. Luck = actual wins minus the wins that rate predicts.</p></div></div>
        ${table([
          { label: "Team", cell: teamCell },
          { label: "Record", num: 1, cell: t => record(t) },
          { label: "All-play", num: 1, cell: t => `${t.allPlayW}–${t.allPlayL} <span class="muted">(${(t.allPlayPct * 100).toFixed(0)}%)</span>` },
          { label: "Expected wins", num: 1, cell: t => t.expectedWins.toFixed(1) },
          { label: "Luck", num: 1, cell: t => `<b class="${t.luck > 0.05 ? "pos" : t.luck < -0.05 ? "neg" : ""}">${signed(t.luck)}</b>` },
        ], luckRows)}</section>`;
    }
    const effRows = D.teams.filter(t => t.efficiency != null).sort((a, b) => b.efficiency - a.efficiency);
    if (effRows.length) {
      html += `<section class="insight"><div class="section-head"><div><h2>Manager efficiency</h2>
        <p class="sub">Points started as a share of the best possible lineup each week, in hindsight. Regular season.</p></div></div>
        ${table([
          { label: "Team", cell: teamCell },
          { label: "Efficiency", num: 1, cell: t => `<span class="pbar"><span class="pbar-fill eff" style="width:${Math.max(0, (t.efficiency - 70) / 30 * 100)}%"></span><span class="pbar-v">${t.efficiency.toFixed(1)}%</span></span>` },
          { label: "Bench pts left", num: 1, cell: t => Number(t.benchLeft).toFixed(1) },
          { label: "Points for", num: 1, cell: t => fmt(t.pf) },
        ], effRows)}</section>`;
    }
    main.innerHTML = `<div class="section-head"><div><h1>Insights</h1><p class="sub">${L.over ? L.season + " season in review." : "Who's in, who's lucky, and who's setting bad lineups."}</p></div></div>${html}`;
  }

  // ---------------------------------------------------------------- trades
  function renderTrades() {
    const body = D.trades.map(tr => {
      const sides = tr.sides.map(s => {
        const t = teamById[s.team] || { name: "Team " + s.team, manager: "" };
        return `<div class="trade-side"><div class="mini-team">${logo(t)}<span><div>${esc(t.name)}</div><div class="team-mgr">${esc(t.manager)}</div></span></div>
          <div class="gets">Receives</div>
          ${s.gets.map(p => `<div class="tplayer"><span class="slot ${esc(p.pos)}" style="font-size:11px;font-weight:700">${esc(p.pos || "—")}</span>${esc(p.name)}<span class="muted" style="font-size:12px">${esc(p.team)}</span></div>`).join("")}</div>`;
      });
      const swap = '<div class="swap"><svg width="22" height="22" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5h11l-3-3M14 11H3l3 3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></div>';
      const when = tr.date ? new Date(tr.date).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : "Week " + tr.week;
      return `<article class="trade"><div class="trade-head"><span>${when}</span><span>${tr.sides.reduce((n, s) => n + s.gets.length, 0)} players</span></div>
        <div class="trade-body">${sides.join(swap)}</div></article>`;
    }).join("");
    main.innerHTML = `<div class="section-head"><div><h1>Trade history <span class="pill">${D.trades.length} trades</span></h1><p class="sub">Every deal that went through in ${L.season}, newest first.</p></div></div>
      <div class="trades">${body || '<div class="empty">No trades this season.</div>'}</div>`;
  }

  // ---------------------------------------------------------------- history
  function renderHistory() {
    const H = IDX.history;
    const champs = H.champions.map(c => `<article class="champ-card">
      ${logoImg(c.logo, c.team, "lg")}
      <div><div class="kicker">${c.season} champion</div><div class="champ-team">${esc(c.team)}</div>
      <div class="team-mgr">${esc(c.owners.map(memberName).join(" & "))} · ${esc(c.record)}</div>
      ${c.runnerUp ? `<div class="team-mgr">Runner-up: ${esc(c.runnerUp.team)} (${esc(c.runnerUp.owners.map(memberName).join(" & "))})</div>` : ""}</div>
    </article>`).join("");
    const m = H.members;
    const rows = m.map(x => {
      const open = state.openMember === x.id;
      const seasons = open ? `<tr class="sub-row"><td colspan="9"><div class="member-seasons">${x.seasons.slice().reverse().map(s => `
        <a class="ms" href="#/?season=${s.season}">${logoImg(s.logo, s.team)}<span><b>${s.season}</b> · ${esc(s.team)}<br><span class="team-mgr">${s.w}–${s.l}${s.t ? "–" + s.t : ""} · ${s.finish ? finishText(s.finish) : "in progress (#" + s.standing + ")"}</span></span></a>`).join("")}</div></td></tr>` : "";
      return `<tr class="member-row${open ? " open" : ""}" data-member="${esc(x.id)}" tabindex="0" aria-expanded="${open}">
        <td><span class="mname">${esc(x.name)}</span>${x.active ? (x.seasons.length === 1 ? ' <span class="badge new">New</span>' : "") : ' <span class="badge former">Former</span>'}</td>
        <td class="n">${x.seasons.length}</td><td class="n">${x.w}–${x.l}${x.t ? "–" + x.t : ""}</td><td class="n">${(x.pct * 100).toFixed(1)}%</td>
        <td class="n">${x.ppg.toFixed(1)}</td><td class="n">${x.titles ? `<b class="champ">${x.titles}</b>` : "0"}</td>
        <td class="n">${x.finals}</td><td class="n">${x.playoffs}</td><td class="n">${x.best ? finishText(x.best) : "—"}</td></tr>${seasons}`;
    }).join("");
    const active = m.filter(x => x.active);
    if (!state.h2hA) state.h2hA = (active[0] || m[0]).id;
    if (!state.h2hB) state.h2hB = (active[1] || m[1] || m[0]).id;
    const opt = sel => m.map(x => `<option value="${esc(x.id)}"${x.id === sel ? " selected" : ""}>${esc(x.name)}${x.active ? "" : " (former)"}</option>`).join("");
    const h = H.h2h[state.h2hA + "|" + state.h2hB];
    const a = m.find(x => x.id === state.h2hA), b = m.find(x => x.id === state.h2hB);
    let h2hBody;
    if (state.h2hA === state.h2hB) h2hBody = '<p class="muted">Pick two different members.</p>';
    else if (!h || h[0] + h[1] + h[2] === 0) h2hBody = `<p class="muted">${esc(a.name)} and ${esc(b.name)} have never played each other.</p>`;
    else {
      const lead = h[0] > h[1] ? a.name + " leads" : h[1] > h[0] ? b.name + " leads" : "All square";
      h2hBody = `<div class="h2h-score"><div><div class="big">${h[0]}</div><div class="kicker">${esc(a.name)}</div></div><div class="h2h-dash">–</div><div><div class="big">${h[1]}</div><div class="kicker">${esc(b.name)}</div></div></div>
        <p class="note">${esc(lead)}${h[2] ? " · " + h[2] + " tie" + (h[2] > 1 ? "s" : "") : ""} · Points ${h[3].toFixed(1)} – ${h[4].toFixed(1)} · ${(h[3] / (h[0] + h[1] + h[2])).toFixed(1)} vs ${(h[4] / (h[0] + h[1] + h[2])).toFixed(1)} per game</p>`;
    }
    main.innerHTML = `<div class="section-head"><div><h1>League history</h1><p class="sub">${IDX.seasons.length} seasons · ${m.length} members all-time</p></div></div>
      <section class="insight"><div class="section-head"><h2>Champions</h2></div><div class="champs">${champs || '<div class="empty">No completed seasons yet.</div>'}</div></section>
      <section class="insight"><div class="section-head"><div><h2>All-time standings</h2><p class="sub">By member, across every season they played. Tap a row for their seasons.</p></div></div>
        <div class="table-wrap"><table class="tbl members"><thead><tr><th>Manager</th><th class="n">Seasons</th><th class="n">Record</th><th class="n">Win %</th><th class="n">Pts/game</th><th class="n">Titles</th><th class="n">Finals</th><th class="n">Playoffs</th><th class="n">Best</th></tr></thead>
        <tbody>${rows}</tbody></table></div></section>
      <section class="insight"><div class="section-head"><div><h2>Head to head</h2><p class="sub">Every regular-season and playoff meeting since ${IDX.seasons[IDX.seasons.length - 1]}.</p></div></div>
        <div class="panel h2h"><div class="h2h-pick"><select id="h2h-a" aria-label="First manager">${opt(state.h2hA)}</select><span class="muted">vs</span><select id="h2h-b" aria-label="Second manager">${opt(state.h2hB)}</select></div>${h2hBody}</div></section>`;
  }

  // ---------------------------------------------------------------- events
  window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });
  document.getElementById("season-select").addEventListener("change", e => {
    const s = Number(e.target.value);
    const p = new URLSearchParams();
    if (s !== IDX.current) p.set("season", s);
    const tab = state.tab === "standings" ? "" : state.tab;
    location.hash = "#/" + tab + (p.toString() ? "?" + p : "");
  });

  main.addEventListener("click", e => {
    const toggle = e.target.closest("[data-toggle]");
    if (toggle) {
      const id = Number(toggle.dataset.toggle);
      state.open.has(id) ? state.open.delete(id) : state.open.add(id);
      renderKeepScroll(renderStandings);
      return;
    }
    if (e.target.closest("#expand-all")) {
      const allOpen = D.teams.every(t => state.open.has(t.id));
      state.open = allOpen ? new Set() : new Set(D.teams.map(t => t.id));
      renderStandings();
      return;
    }
    const wkBtn = e.target.closest("[data-week]");
    if (wkBtn) { location.hash = href("matchups", { week: wkBtn.dataset.week }); return; }
    const game = e.target.closest("[data-game]");
    if (game) {
      const p = new URLSearchParams(state.params);
      p.get("game") === game.dataset.game ? p.delete("game") : p.set("game", game.dataset.game);
      history.replaceState(null, "", "#/matchups?" + p.toString());
      state.params = p;
      renderKeepScroll(renderMatchups);
      return;
    }
    const mem = e.target.closest("[data-member]");
    if (mem && !e.target.closest("a")) {
      state.openMember = state.openMember === mem.dataset.member ? null : mem.dataset.member;
      renderKeepScroll(renderHistory);
    }
  });
  main.addEventListener("keydown", e => {
    const mem = e.target.closest && e.target.closest("[data-member]");
    if (mem && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); mem.click(); }
  });
  main.addEventListener("input", e => {
    if (e.target.id === "q") {
      state.q = e.target.value;
      const pos = e.target.selectionStart;
      renderStandings();
      const q = document.getElementById("q");
      q.focus(); q.setSelectionRange(pos, pos);
    }
  });
  main.addEventListener("change", e => {
    if (e.target.id === "sort") { state.sort = e.target.value; store.set("sort", state.sort); renderStandings(); }
    if (e.target.id === "side-week") { state.sideWeek = Number(e.target.value); document.querySelector(".side").outerHTML = sidebar(); }
    if (e.target.id === "h2h-a") { state.h2hA = e.target.value; renderKeepScroll(renderHistory); }
    if (e.target.id === "h2h-b") { state.h2hB = e.target.value; renderKeepScroll(renderHistory); }
  });

  function renderKeepScroll(fn) {
    const y = window.scrollY;
    fn();
    window.scrollTo(0, y);
  }

  // ---------------------------------------------------------------- live updates
  // While the current season is in progress, re-check for fresh data every 2 minutes
  // (the site itself refreshes from ESPN every 15 minutes during games).
  const live = { on: false, timer: null };
  async function poll() {
    if (document.hidden) return;
    try {
      const idxText = await (await fetch("data/index.js?t=" + Date.now(), { cache: "no-store" })).text();
      const fresh = parseAssigned(idxText);
      if (fresh.updated === IDX.updated) { renderBanner(); return; }
      const seasonText = await (await fetch("data/" + fresh.current + ".js?t=" + Date.now(), { cache: "no-store" })).text();
      window.LEAGUE_DATA[fresh.current] = parseAssigned(seasonText);
      Object.assign(IDX, fresh);
      if (state.season === IDX.current || state.tab === "history") {
        const y = window.scrollY;
        await route();
        window.scrollTo(0, y);
      }
    } catch (_) { /* offline or mid-deploy: try again next time */ }
  }
  function startLive() {
    const cur = window.LEAGUE_DATA[IDX.current];
    if (!cur || cur.league.over || live.timer) return;
    live.on = true;
    live.timer = setInterval(poll, 120000);
    const chip = document.getElementById("live-chip");
    if (chip) { chip.className = "live-chip on"; chip.textContent = "Live · checking every 2 min"; }
    document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  }

  route().then(startLive);
})();
