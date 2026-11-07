(function () {
  "use strict";
  const IDX = window.LEAGUE_INDEX;
  const APP_BUILD = "dev"; // replaced with the commit id at deploy time
  // A browser can keep serving an older copy of this file for a few minutes after a deploy. The data index is
  // always fetched fresh, so if it says a newer version is live, reload once to pick up the new code.
  function newerBuildLive(build) {
    if (!build || APP_BUILD === "dev" || build === "dev" || build === APP_BUILD) return false;
    try {
      if (sessionStorage.getItem("lhq:reloaded-for") === build) return false;
      sessionStorage.setItem("lhq:reloaded-for", build);
    } catch (_) { /* storage blocked: reload anyway, once per page load */ }
    location.reload();
    return true;
  }
  if (IDX && newerBuildLive(IDX.build)) return;
  const main = document.getElementById("main");
  if (!IDX) {
    main.innerHTML = '<div class="empty">No league data yet. Run <code>python3 build.py</code>.</div>';
    return;
  }
  window.LEAGUE_DATA = window.LEAGUE_DATA || {};

  // ---------------------------------------------------------------- helpers
  const POS = ["QB", "RB", "WR", "TE"];
  const SEGS = () => POS; // position-bar segments
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

  function href(tab, extra, sub) {
    const p = new URLSearchParams(extra || {});
    if (state.season !== IDX.current) p.set("season", state.season);
    const qs = p.toString();
    return "#/" + (tab === "standings" ? "" : tab) + (sub ? "/" + sub : "") + (qs ? "?" + qs : "");
  }

  async function route() {
    const hash = location.hash.replace(/^#/, "") || "/";
    const [path, qs] = hash.split("?");
    const params = new URLSearchParams(qs || "");
    const tab = ["matchups", "insights", "trades", "history"].find(t => path.startsWith("/" + t)) || "standings";
    const season = Number(params.get("season")) || IDX.current;
    state.tab = tab;
    state.sub = path.split("/")[2] || "";
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
    document.querySelectorAll("a[data-tab]").forEach(a => {
      const t = a.dataset.tab;
      a.setAttribute("href", href(t));
      a.classList.toggle("active", t === state.tab);
      if (t === state.tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    const sel = document.getElementById("season-select");
    sel.innerHTML = IDX.seasons.map(s => `<option value="${s}"${s === state.season ? " selected" : ""}>${s} season${s === IDX.current ? "" : ""}</option>`).join("");
    const wide = !window.matchMedia || window.matchMedia("(min-width: 641px)").matches;
    document.getElementById("footer-notes").innerHTML = `<details class="how"${wide ? " open" : ""}><summary>How these numbers work</summary>${footerNotes()}</details>`;
    document.getElementById("updated").innerHTML = "Data snapshot · " + esc(new Date(D.updated).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })) +
      (isCur && !L.over ? ` <span class="live-chip${live.on ? " on" : ""}" id="live-chip"></span>` : "");
    updateLiveChip();
    renderBanner();
  }

  function footerNotes() {
    if (state.tab === "history") {
      return `<p><strong>All-time records</strong> follow each member's ESPN account, not the team slot, so people who left keep their history and new members start fresh.
        Head-to-head counts regular-season and championship-bracket games; consolation games are left out.</p>`;
    }
    if (state.tab === "insights") {
      return `<p>Each insight explains its method at the top. Unless noted, stats use regular-season games only${L.over ? "" : ", and update with every refresh"}.</p>`;
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
        "Starts X of Y wks" on each player is how often he makes that lineup. The bars rate each position group on its own: expected points from the team's best QB, best 3 RBs, best 3 WRs (their two spots plus FLEX) and best TE each week, the same spots for every team; the number is the team's rank at that position.</p>`;
    }
    return `<p><strong>${L.season} season.</strong> The bars rate each position group by what it actually produced in the regular season: each week's best QB, 3 RBs, 3 WRs and TE on the roster; the number is the team's rank at that position.
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
    SEGS().forEach(p => { s[p] = [p + (L.over ? " points" : " power"), (a, b) => a.posRank[p] - b.posRank[p]]; });
    return s;
  }

  function rankFor(t, i) {
    if (state.sort === "standing") return t.standing;
    if (state.sort === "power") return t.powerRank;
    if (state.sort === "finish") return t.finalRank || i + 1;
    if (SEGS().includes(state.sort)) return t.posRank[state.sort];
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
    const segs = SEGS().map(p => {
      const w = maxPos ? (t.posPower[p] / maxPos) * 100 : 0;
      return `<span class="seg ${p}" style="width:${w.toFixed(2)}%" title="${p} group: ${Math.round(t.posPower[p])} ${L.over ? "pts produced" : "projected pts"} · #${t.posRank[p]} in league">${t.posRank[p]}</span>`;
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
      <div class="bar" aria-label="Position ranks: ${SEGS().map(p => p + " " + t.posRank[p]).join(", ")}">${segs}</div>
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
        ${list.slice(0, 3).map(r => `<div class="mini-team">${logo(r.team)}${esc(r.team.name)}</div>`).join("")}
        ${list.length > 3 ? `<div class="note" title="${esc(list.slice(3).map(r => r.team.name).join(", "))}">+${list.length - 3} more tied</div>` : ""}`;
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
      oddsLead = `<div class="leader"><span class="kicker">Title favorite</span><span class="crown">01</span><span><div class="mini-team">${logo(fav)}${esc(fav.name)}</div><div class="val">${pct(fav.odds.titlePct)} to win it all · <a href="${href("insights", {}, "race")}">all odds</a></div></span></div>`;
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

  // phones: the sidebar's highlights as a row of small tappable tiles
  function tiles() {
    const wk = D.weeks.find(x => x.week === state.sideWeek);
    const rows = [];
    (wk ? wk.games : []).forEach(g => g.sides.forEach(s => teamById[s.team] && rows.push({ team: teamById[s.team], pts: s.pts })));
    const items = [];
    const tile = (kicker, value, who, link) => `<a class="tile" href="${link}"><span class="kicker">${kicker}</span><span class="tile-v">${value}</span><span class="tile-who">${who}</span></a>`;
    if (rows.length) {
      const hi = Math.max(...rows.map(r => r.pts)), lo = Math.min(...rows.map(r => r.pts));
      const his = rows.filter(r => r.pts === hi), los = rows.filter(r => r.pts === lo);
      const wkLink = href("matchups", { week: state.sideWeek });
      const label = `Wk ${state.sideWeek}${wk && !wk.final ? " · live" : ""}`;
      items.push(tile(`High · ${label}`, fmt(hi), his.length > 1 ? his.length + " tied" : esc(his[0].team.name), wkLink));
      items.push(tile(`Low · ${label}`, fmt(lo), los.length > 1 ? los.length + " tied" : esc(los[0].team.name), wkLink));
    }
    if (L.over) {
      const c = D.teams.find(t => t.finalRank === 1);
      if (c) items.push(tile("Champion", record(c), esc(c.name), href("insights", {}, "race")));
    } else {
      const pl = D.teams.slice().sort((a, b) => a.powerRank - b.powerRank)[0];
      items.push(tile("Power leader", pl.power.toLocaleString(), esc(pl.name), href("standings")));
    }
    if (D.teams.some(t => t.odds)) {
      const fav = D.teams.slice().sort((a, b) => b.odds.titlePct - a.odds.titlePct)[0];
      items.push(tile("Title favorite", pct(fav.odds.titlePct), esc(fav.name), href("insights", {}, "race")));
    }
    const pf = D.teams.slice().sort((a, b) => b.pf - a.pf)[0];
    items.push(tile("Most points", Math.round(pf.pf).toLocaleString(), esc(pf.name), href("insights", {}, "luck")));
    return `<div class="tiles" aria-label="This week's highlights">${items.join("")}</div>`;
  }

  function renderStandings() {
    const S = sorts();
    if (!S[state.sort]) state.sort = "standing";
    const q = state.q.trim().toLowerCase();
    const ranked = D.teams.slice().sort(S[state.sort][1]).map((t, i) => [t, i]);
    const shown = q ? ranked.filter(([t]) => t.name.toLowerCase().includes(q) || t.manager.toLowerCase().includes(q) ||
      t.roster.some(p => p.name.toLowerCase().includes(q))) : ranked;
    const maxPos = Math.max(...D.teams.map(t => SEGS().reduce((s, p) => s + (t.posPower[p] || 0), 0)));
    const allOpen = D.teams.every(t => state.open.has(t.id));
    main.innerHTML = `${tiles()}<div class="layout">
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
        <div class="legend"><span>Team / ${esc(S[state.sort][0])}</span>${SEGS().map(p => `<span><i class="dot ${p}"></i>${p}</span>`).join("")}<span class="right">Bar numbers = position rank</span></div>
        <div class="teams" id="teams">${shown.length ? shown.map(([t, i]) => teamCard(t, i, maxPos)).join("") : '<div class="empty">No team, manager or player matches that.</div>'}</div>
      </section>
      ${sidebar()}
    </div>`;
  }

  // ---------------------------------------------------------------- matchups
  const TIER = { WINNERS_BRACKET: "Playoffs", WINNERS_CONSOLATION_LADDER: "Consolation", LOSERS_CONSOLATION_LADDER: "Consolation" };

  function boxCol(side, hl, week) {
    const t = teamById[side.team];
    const start = side.lineup.filter(p => p.slot !== "BE" && p.slot !== "IR");
    const bench = side.lineup.filter(p => p.slot === "BE" || p.slot === "IR");
    const line = (p, b) => `<div class="box-line${b ? " bench" : ""}${hl && String(p.id) === hl ? " hl" : ""}" role="button" tabindex="0" data-stat="${p.id}" data-stat-week="${week}" title="See ${esc(p.name)}'s stat line"><span class="slot ${esc(POS.includes(p.slot) ? p.slot : p.pos)}" style="font-size:10px;font-weight:700;text-align:center">${esc(p.slot)}</span><span class="pn" title="${esc(p.name)} · ${esc(p.pos)} ${esc(p.team)}">${esc(p.name)}</span><span class="pp">${fmt(p.pts)}</span></div>`;
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
    return `<section class="recap"><div class="section-head"><h2>Week ${w} recap</h2><button type="button" class="share-btn" data-share="recap" data-week="${w}">${SHARE_ICON}Share</button></div><div class="recap-grid">${items.join("")}</div></section>`;
  }

  const MATCHUP_TABS = [["", "Weekly"], ["bracket", "Playoff bracket"]];

  function renderMatchups() {
    if (state.sub === "bracket") return renderBracket();
    const weeks = D.weeks.map(x => x.week);
    let w = parseInt(state.params.get("week"), 10);
    if (!weeks.includes(w)) w = L.over ? weeks[weeks.length - 1] : L.currentWeek;
    if (!weeks.includes(w)) w = weeks[weeks.length - 1];
    const wk = D.weeks.find(x => x.week === w);
    const open = state.params.get("game");
    const focusTeam = Number(state.params.get("team")) || null;   // set by Record book links
    const focusPlayer = state.params.get("player");
    const games = wk.games.slice().sort((a, b) => (a.tier === "WINNERS_BRACKET" ? 0 : 1) - (b.tier === "WINNERS_BRACKET" ? 0 : 1)).map(g => {
      const [a, b] = g.sides;
      const winnerId = g.winner === "HOME" ? a && a.team : g.winner === "AWAY" ? b && b.team : null;
      const row = s => {
        if (!s) return `<div class="side-row"><span class="logo">—</span><b>Bye</b><span></span></div>`;
        const t = teamById[s.team];
        const won = winnerId === s.team, lost = winnerId && !won;
        const other = s === a ? b : a;
        const wpv = !wk.final && s.winProb != null ? Math.round(s.winProb * 100) : null;
        const fav = wpv != null && other && other.winProb != null && s.winProb > other.winProb;
        return `<div class="side-row${lost ? " lost" : ""}">${logo(t)}
          <span style="min-width:0"><div class="team-name">${esc(t.name)}${won ? '<span class="win-tag">W</span>' : ""}</div><div class="team-mgr">${esc(t.manager)} · ${record(t)}</div></span>
          ${wpv != null ? `<span class="wp${fav ? " fav" : ""}" title="ESPN live win probability">${wpv}% <small>to win</small></span>` : "<span></span>"}
          <span class="score">${fmt(s.pts)}${s.proj != null ? `<small>proj ${fmt(s.proj)}</small>` : ""}</span></div>`;
      };
      const isOpen = open === String(g.id);
      const liveG = !wk.final;
      const wpBar = liveG && a && b && a.winProb != null && b.winProb != null
        ? `<div class="wp-bar" aria-hidden="true"><span style="width:${(100 * a.winProb / (a.winProb + b.winProb)).toFixed(1)}%"></span></div>` : "";
      const tier = TIER[g.tier] || (g.playoff ? "Playoffs" : "");
      return `<article class="game${g.tier && g.tier !== "NONE" && g.tier !== "WINNERS_BRACKET" ? " consolation" : ""}">
        <button class="game-btn" data-game="${g.id}" aria-expanded="${isOpen}">${row(a)}${row(b)}
          ${isOpen ? wpBar : ""}<div class="game-foot"><span>${tier ? tier + " · " : ""}${liveG ? "In progress" : "Final"}</span><span>${isOpen ? "Hide box score ↑" : "Box score ↓"}</span></div>
        </button>
        ${isOpen && a && b ? (() => {
          const showB = focusTeam != null && b.team === focusTeam ? 1 : 0;
          return `<div class="box-actions"><button type="button" class="share-btn" data-share="game" data-week="${w}" data-game="${g.id}">${SHARE_ICON}Share ${wk.final ? "result" : "score"}</button></div>
          <div class="box-toggle" role="tablist" aria-label="Show lineup">
            <button type="button" role="tab" data-boxside="0" aria-selected="${!showB}" class="${showB ? "" : "active"}">${esc(teamById[a.team].name)}</button>
            <button type="button" role="tab" data-boxside="1" aria-selected="${!!showB}" class="${showB ? "active" : ""}">${esc(teamById[b.team].name)}</button></div>
          <div class="box" data-show="${showB}">${boxCol(a, focusPlayer, w)}${boxCol(b, focusPlayer, w)}</div>`;
        })() : ""}
      </article>`;
    }).join("");
    main.innerHTML = `
      <div class="section-head"><div><h1>Week ${w} matchups</h1><p class="sub">${wk.final ? "Final scores." : "Live scores · week in progress."} Tap a matchup for the box score.</p></div></div>
      ${subnav("matchups", MATCHUP_TABS, "")}
      <div class="week-strip" role="tablist">${D.weeks.map(x => `<button data-week="${x.week}" class="${x.week === w ? "active" : ""}${x.playoffs ? " po" : ""}" role="tab" aria-selected="${x.week === w}">${x.playoffs ? "PO " : "Wk "}${x.week}</button>`).join("")}</div>
      ${wk.final ? recapCard(w) : ""}
      <div class="games">${games}</div>`;
    const active = main.querySelector(".week-strip .active");
    if (active) active.scrollIntoView({ block: "nearest", inline: "center" });
    if (focusTeam && open) {  // arrived from the Record book: bring that game into view
      const card = main.querySelector(`[data-game="${CSS.escape(open)}"]`);
      if (card) {
        const art = card.closest(".game");
        art.classList.add("focus");
        (art.querySelector(".box-line.hl") || art).scrollIntoView({ block: "center" });
      }
    }
  }


  // ---------------------------------------------------------------- playoff bracket
  function bracketModel() {
    const rs = L.regularSeasonWeeks, R = L.playoffRounds, n = L.playoffTeams;
    const size = 2 ** R, byes = Math.max(0, size - n);
    const wb = w => (D.weeks.find(x => x.week === w) || { games: [] }).games.filter(g => g.tier === "WINNERS_BRACKET");
    const started = wb(rs + 1).length > 0;
    const seed = {};
    if (started || L.over) D.teams.forEach(t => { if (t.seed && t.seed <= n) seed[t.id] = t.seed; });
    else D.teams.slice().sort((a, b) => a.standing - b.standing).slice(0, n).forEach((t, i) => { seed[t.id] = i + 1; });
    const byId = Object.fromEntries(Object.entries(seed).map(([tid, sd]) => [sd, Number(tid)]));
    const roundName = r => (R - r === 0 ? "Championship" : R - r === 1 ? "Semifinals" : R - r === 2 ? "Quarterfinals" : "Round " + r);
    const rounds = [];
    let champion = null;
    for (let r = 1; r <= R; r++) {
      const week = rs + r;
      const wk = D.weeks.find(x => x.week === week);
      const games = wb(week);
      let matches;
      if (games.length) {
        matches = games.map(g => {
          const win = g.winner === "HOME" ? 0 : g.winner === "AWAY" ? 1 : -1;
          const entries = g.sides.map((s, i) => ({ team: s.team, seed: seed[s.team], pts: s.pts, won: win === i, lost: win !== -1 && win !== i }));
          return { game: g.id, week, bye: g.sides.length === 1, live: !(wk && wk.final), entries };
        });
        if (r === R) {
          const f = matches.find(m => !m.bye && m.entries.some(e => e.won));
          if (f && !f.live) champion = f.entries.find(e => e.won).team;
        }
      } else if (r === 1) {
        // projected first round: byes for the top seeds, then best remaining seed vs worst
        matches = [];
        for (let s = 1; s <= byes; s++) if (byId[s]) matches.push({ bye: true, projected: true, entries: [{ team: byId[s], seed: s }] });
        const rest = [];
        for (let s = byes + 1; s <= n; s++) if (byId[s]) rest.push(s);
        for (let i = 0; i < rest.length / 2; i++) matches.push({ projected: true, entries: [{ team: byId[rest[i]], seed: rest[i] }, { team: byId[rest[rest.length - 1 - i]], seed: rest[rest.length - 1 - i] }] });
      } else {
        matches = Array.from({ length: size / 2 ** r }, () => ({ tbd: true, entries: [] }));
      }
      matches.sort((a, b) => Math.min(...a.entries.map(e => e.seed || 99), 99) - Math.min(...b.entries.map(e => e.seed || 99), 99));
      rounds.push({ r, week, name: roundName(r), matches, live: wk && !wk.final && games.length > 0 });
    }
    return { rounds, champion, started, projected: !started && !L.over, byes, size };
  }

  function renderBracket() {
    const M = bracketModel();
    const teamLine = (e, m) => {
      const t = teamById[e.team];
      const odds = M.projected && t.odds ? `<span class="bm-odds" title="Chance to make the playoffs">${pct(t.odds.playoffPct)}</span>` : "";
      const score = e.pts != null && !m.bye ? `<span class="bm-pts">${fmt(e.pts)}</span>` : odds;
      return `<div class="bm-row${e.won ? " won" : ""}${e.lost ? " lost" : ""}"><span class="bm-seed">${e.seed || ""}</span>${logo(t)}<span class="bm-name">${esc(t.name)}</span>${score}</div>`;
    };
    const matchBox = m => {
      if (m.tbd) return `<div class="bm tbd"><div class="bm-row"><span class="bm-name muted">TBD</span></div><div class="bm-row"><span class="bm-name muted">TBD</span></div></div>`;
      if (m.bye) return `<div class="bm bye">${teamLine(m.entries[0], m)}<div class="bm-foot">First-round bye</div></div>`;
      const link = m.game != null ? `<a class="bm-foot" href="${href("matchups", { week: m.week, game: m.game })}">${m.live ? "Live · box score →" : "Box score →"}</a>` : `<div class="bm-foot">${M.projected ? "If the season ended today" : ""}</div>`;
      return `<div class="bm${m.live ? " live" : ""}">${m.entries.map(e => teamLine(e, m)).join("")}${link}</div>`;
    };
    const cols = M.rounds.map(r => `<div class="b-round"><div class="b-head"><span class="kicker">${r.name}</span><span class="b-week">Week ${r.week}${r.live ? ' · <b class="neg">live</b>' : ""}</span></div><div class="b-matches">${r.matches.map(matchBox).join("")}</div></div>`).join("");
    const champ = M.champion ? teamById[M.champion] : null;
    const champCol = `<div class="b-round b-champ"><div class="b-head"><span class="kicker">Champion</span></div><div class="b-matches">${champ
      ? `<div class="bm champ-box">${logoImg(champ.logo, champ.name, "lg")}<div class="champ-team">${esc(champ.name)}</div><div class="team-mgr">${esc(champ.manager)} · ${champ.seed ? ordinal(champ.seed) + " seed" : ""}</div></div>`
      : `<div class="bm tbd champ-box"><div class="champ-team muted">TBD</div></div>`}</div></div>`;
    const sub = M.projected
      ? `If the season ended today. Top ${L.playoffTeams} make it${M.byes ? `; top ${M.byes} get a first-round bye` : ""}, reseeded each round so the best seed left plays the worst. Percentages are each team's playoff odds.`
      : L.over ? `How the ${L.season} playoffs played out.` : "The playoffs are underway. Live scores update with every refresh.";
    main.innerHTML = `<div class="section-head"><div><h1>Playoff bracket</h1><p class="sub">${sub}</p></div>${M.started || L.over ? `<button type="button" class="share-btn" data-share="bracket">${SHARE_ICON}Share</button>` : ""}</div>
      ${subnav("matchups", MATCHUP_TABS, "bracket")}
      <div class="bracket">${cols}${champCol}</div>`;
  }

  // ---------------------------------------------------------------- insights
  function table(cols, rows) {
    return `<div class="table-wrap"><table class="tbl"><thead><tr>${cols.map(c => `<th class="${c.num ? "n" : ""}">${c.label}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(r => `<tr>${cols.map((c, i) => `<td class="${c.num ? "n" : ""}${i === 0 ? " lead" : ""}" data-label="${c.label}">${c.cell(r)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  const teamCell = t => `<span class="tcell">${logo(t)}<span><span class="tname">${esc(t.name)}</span><span class="team-mgr">${esc(t.manager)}</span></span></span>`;
  const barCell = (v, cls) => `<span class="pbar"><span class="pbar-fill ${cls || ""}" style="width:${Math.min(100, v || 0)}%"></span><span class="pbar-v">${pct(v)}</span></span>`;
  const signedPts = (n, goodHigh) => `<b class="${(goodHigh ? n > 0.05 : n < -0.05) ? "pos" : (goodHigh ? n < -0.05 : n > 0.05) ? "neg" : ""}">${signed(n)}</b>`;
  const tname = id => (teamById[id] || { name: "Team " + id }).name;
  // explanation that shows in full on desktop; on phones a one-line summary with an ⓘ that expands it
  const expl = (short, full) => `<p class="sub expl"><span class="expl-short">${short}</span><span class="expl-full">${full}</span>
    <button type="button" class="info-btn" aria-expanded="false" aria-label="How this works">i</button></p>`;
  const section = (title, sub, body) => `<section class="insight"><div class="section-head"><div><h2>${title}</h2>${!sub ? "" : typeof sub === "string" ? `<p class="sub">${sub}</p>` : expl(sub.short, sub.full)}</div></div>${body}</section>`;

  function subnav(tab, items, cur) {
    return `<nav class="subnav" aria-label="${tab[0].toUpperCase() + tab.slice(1)} sections">${items.map(([k, label]) =>
      `<a href="${href(tab, {}, k)}" class="${k === cur ? "active" : ""}"${k === cur ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
  }

  function insightTabs() {
    const hasOdds = D.teams.some(t => t.odds);
    const t = [["race", hasOdds || !L.over ? "Playoff race" : "Final results"]];
    t.push(["luck", "Luck"], ["schedule", "Schedule"], ["efficiency", "Efficiency"]);
    if (D.draft) t.push(["draft", "Draft"]);
    return t;
  }

  const INSIGHTS = {
    race() {
      if (D.teams.some(t => t.odds)) {
        const rows = D.teams.slice().sort((a, b) => b.odds.playoffPct - a.odds.playoffPct || b.odds.titlePct - a.odds.titlePct);
        return section("Playoff race", { short: `Top ${L.playoffTeams} make it${L.playoffTeams < 2 ** L.playoffRounds ? ` · top ${2 ** L.playoffRounds - L.playoffTeams} get a bye` : ""}.`, full: `Top ${L.playoffTeams} make the playoffs${L.playoffTeams < 2 ** L.playoffRounds ? `; top ${2 ** L.playoffRounds - L.playoffTeams} get a first-round bye` : ""}. Odds from 10,000 simulated finishes of the rest of the regular season and the bracket; this week's games use ESPN's live win probabilities.` },
          table([
            { label: "Team", cell: teamCell },
            { label: "Record", num: 1, cell: t => record(t) },
            { label: "Proj. wins", num: 1, cell: t => t.odds.projWins.toFixed(1) },
            { label: "Playoffs", num: 1, cell: t => barCell(t.odds.playoffPct) },
            { label: "Bye", num: 1, cell: t => barCell(t.odds.byePct, "bye") },
            { label: "Title", num: 1, cell: t => barCell(t.odds.titlePct, "title") },
          ], rows));
      }
      if (!L.over) return `<div class="empty">Playoff odds appear during the regular season. The bracket is set; follow it on the Matchups tab.</div>`;
      const rows = D.teams.slice().sort((a, b) => (a.finalRank || 99) - (b.finalRank || 99));
      return section("Final results", `How the ${L.season} season ended.`, table([
        { label: "Finish", num: 1, cell: t => `<b class="${t.finalRank === 1 ? "champ" : ""}">${finishText(t.finalRank)}</b>` },
        { label: "Team", cell: teamCell },
        { label: "Record", num: 1, cell: t => record(t) },
        { label: "Seed", num: 1, cell: t => (t.seed && t.seed <= L.playoffTeams ? "#" + t.seed : "—") },
        { label: "Points for", num: 1, cell: t => fmt(t.pf) },
      ], rows));
    },

    luck() {
      const rows = D.teams.filter(t => t.allPlayW != null).sort((a, b) => b.luck - a.luck);
      return section("Luck", { short: "Actual wins vs. what your scoring deserved.", full: "All-play is the record you'd have playing every team every week. Luck = actual wins minus the wins that rate predicts." }, table([
        { label: "Team", cell: teamCell },
        { label: "Record", num: 1, cell: t => record(t) },
        { label: "All-play", num: 1, cell: t => `${t.allPlayW}–${t.allPlayL} <span class="muted">(${(t.allPlayPct * 100).toFixed(0)}%)</span>` },
        { label: "Expected wins", num: 1, cell: t => t.expectedWins.toFixed(1) },
        { label: "Luck", num: 1, cell: t => signedPts(t.luck, true) },
      ], rows));
    },

    schedule() {
      const rows = D.teams.filter(t => t.sos).sort((a, b) => b.sos.oppVsAvg - a.sos.oppVsAvg);
      const hasLeft = rows.some(t => t.sos.remainingVsAvg != null);
      const cols = [
        { label: "Team", cell: teamCell },
        { label: "Record", num: 1, cell: t => record(t) },
        { label: "Opponents so far", num: 1, cell: t => `${signed(t.sos.oppVsAvg)} <span class="muted">#${t.sos.oppVsAvgRank}</span>` },
        { label: "They scored vs you", num: 1, cell: t => signedPts(t.sos.facedVsAvg, false) },
      ];
      if (hasLeft) cols.push({ label: "Opponents left", num: 1, cell: t => t.sos.remainingVsAvg == null ? "—" : `${signed(t.sos.remainingVsAvg)} <span class="muted">#${t.sos.remainingVsAvgRank}</span>` });
      return section("Strength of schedule", { short: "How tough each team's opponents have been (#1 = toughest).", full: `<b>Opponents so far</b>: how much the teams you've faced score per week compared with the league average (#1 = toughest). <b>They scored vs you</b>: how those opponents actually played against you; high means you kept running into hot weeks.${hasLeft ? " <b>Opponents left</b>: projected strength of the rest of your schedule." : ""}` }, table(cols, rows));
    },

    efficiency() {
      const rows = D.teams.filter(t => t.efficiency != null).sort((a, b) => b.efficiency - a.efficiency);
      return section("Manager efficiency", { short: "Points started vs. the best possible lineup.", full: "Points started as a share of the best possible lineup each week, in hindsight. Regular season." }, table([
        { label: "Team", cell: teamCell },
        { label: "Efficiency", num: 1, cell: t => `<span class="pbar"><span class="pbar-fill eff" style="width:${Math.max(0, (t.efficiency - 70) / 30 * 100)}%"></span><span class="pbar-v">${t.efficiency.toFixed(1)}%</span></span>` },
        { label: "Bench pts left", num: 1, cell: t => Number(t.benchLeft).toFixed(1) },
        { label: "Points for", num: 1, cell: t => fmt(t.pf) },
      ], rows));
    },

    draft() {
      const dr = D.draft;
      const byPick = Object.fromEntries(dr.picks.map(p => [p.pick, p]));
      const sofar = L.over ? "" : " so far";
      const grades = Object.entries(dr.teams).map(([tid, g]) => Object.assign({ t: teamById[tid] }, g)).filter(r => r.t).sort((a, b) => a.rank - b.rank);
      const pickLine = p => `<div class="pick"><span class="pick-no">R${p.round}.${p.roundPick}</span><span class="slot ${esc(p.pos)}">${esc(p.pos)}</span>
        <span class="pick-name"><b>${esc(p.name)}</b>${p.keeper ? ' <span class="badge former">Keeper</span>' : ""}<span class="team-mgr">${esc(tname(p.team))} · drafted ${esc(p.pos)}${p.draftPosRank} · ${L.over ? "finished" : "now"} ${esc(p.pos)}${p.finishPosRank}</span></span>
        <span class="pick-v">${signedPts(p.value, true)}</span></div>`;
      if (!state.draftTeam || !dr.teams[state.draftTeam]) state.draftTeam = String((grades[0] || {}).t ? grades[0].t.id : "");
      const mine = dr.picks.filter(p => String(p.team) === state.draftTeam);
      return section("Draft grades", { short: `Each pick vs. same-position players drafted around it${sofar}.`, full: `Each pick is compared with players at the same position drafted around the same spot (a QB18 against QBs 16–20), using points scored${sofar}. Kickers and defenses aren't graded.` }, table([
          { label: "Grade", num: 1, cell: r => `<b class="grade g${r.grade[0]}">${r.grade}</b>` },
          { label: "Team", cell: r => teamCell(r.t) },
          { label: "Vs. expected", num: 1, cell: r => signedPts(r.value, true) },
          { label: "Points from picks", num: 1, cell: r => r.pts.toFixed(1) },
        ], grades)) +
        `<div class="two-col">${section("Steals", "Biggest gains over draft slot.", `<div class="picks">${dr.steals.map(p => pickLine(byPick[p])).join("")}</div>`)}
          ${section("Busts", "Biggest shortfalls, rounds 1–8.", `<div class="picks">${dr.busts.map(p => pickLine(byPick[p])).join("")}</div>`)}</div>` +
        section("Draft board", "", `<label class="field">Team <select id="draft-team">${grades.map(r => `<option value="${r.t.id}"${String(r.t.id) === state.draftTeam ? " selected" : ""}>${esc(r.t.name)}</option>`).join("")}</select></label>
          <div class="picks" style="margin-top:10px">${mine.map(p => pickLine(p)).join("")}</div>`);
    },

  };

  function renderInsights() {
    if (state.sub === "trades") { location.replace(href("trades")); return; } // trade grades moved to the Trades tab
    const tabs = insightTabs();
    const sub = tabs.some(([k]) => k === state.sub) ? state.sub : tabs[0][0];
    main.innerHTML = `<div class="section-head"><div><h1>Insights</h1><p class="sub">${L.over ? L.season + " season in review." : "Who's in, who's lucky, who's setting good lineups, and who drafted well."}</p></div></div>
      ${subnav("insights", tabs, sub)}${INSIGHTS[sub]()}`;
    const a = main.querySelector(".subnav .active");
    if (a) a.scrollIntoView({ block: "nearest", inline: "center" });
  }

  // ---------------------------------------------------------------- trades
  function renderTrades() {
    const swap = '<div class="swap"><svg width="22" height="22" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5h11l-3-3M14 11H3l3 3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></div>';
    const body = D.trades.map(tr => {
      const early = !tr.weeksSince;
      const [a, b] = tr.sides;
      let verdict = "Too early to grade: no completed weeks since the trade.";
      if (!early && a && b) {
        const diff = a.started - b.started;
        verdict = Math.abs(diff) < 5 ? `Even so far: ${a.started.toFixed(1)} to ${b.started.toFixed(1)} started points.`
          : `<b>${esc(tname(diff > 0 ? a.team : b.team))}</b> ${L.over ? "won" : "is winning"} by ${Math.abs(diff).toFixed(1)} started points over ${tr.weeksSince} week${tr.weeksSince === 1 ? "" : "s"}.`;
      }
      const sides = tr.sides.map(s => {
        const t = teamById[s.team] || { name: "Team " + s.team, manager: "" };
        const win = !early && a && b && s.started === Math.max(a.started, b.started) && Math.abs(a.started - b.started) >= 5;
        return `<div class="trade-side${win ? " won" : ""}"><div class="mini-team">${logo(t)}<span><div>${esc(t.name)}</div><div class="team-mgr">${esc(t.manager)}</div></span></div>
          <div class="gets">Receives${early ? "" : " · " + s.started.toFixed(1) + " pts started"}</div>
          ${s.gets.map(p => `<div class="tplayer"><span class="slot ${esc(p.pos)}" style="font-size:11px;font-weight:700">${esc(p.pos || "—")}</span>${esc(p.name)}<span class="muted" style="font-size:12px">${esc(p.team)}</span>${early ? "" : `<span class="muted" style="font-size:12px;margin-left:auto" title="Points scored in the starting lineup after the trade · starts">${(p.started || 0).toFixed(1)} · ${p.starts || 0} st</span>`}</div>`).join("")}</div>`;
      });
      const date = tr.date ? new Date(tr.date).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : "";
      const when = [date, tr.week ? "Week " + tr.week : ""].filter(Boolean).join(" · ");
      return `<article class="trade"><div class="trade-head"><span>${when}</span><span class="trade-head-r">${tr.sides.reduce((n, s) => n + s.gets.length, 0)} players<button type="button" class="share-btn sm" data-share="trade" data-trade="${esc(tr.id)}" aria-label="Share this trade">${SHARE_ICON}</button></span></div>
        <div class="trade-body">${sides.join(swap)}</div><div class="verdict">${verdict}</div></article>`;
    }).join("");
    main.innerHTML = `<div class="section-head"><div><h1>Trade history <span class="pill">${D.trades.length} trades</span></h1>
        ${expl(`Every ${L.season} deal, graded by points scored in the new team's lineup.`, `Every deal that went through in ${L.season}, newest first, graded by points the received players scored in the new team's starting lineup for as long as they stayed. Bench points don't count: a trade only pays off if you play them.`)}</div></div>
      <div class="trades">${body || '<div class="empty">No trades this season.</div>'}</div>`;
  }

  // ---------------------------------------------------------------- history
  const HISTORY_TABS = [["overview", "Champions & standings"], ["h2h", "Head to head"], ["rivalries", "Rivalries"], ["records", "Record book"]];
  const owners = ids => esc((ids || []).map(memberName).join(" & "));
  const whenLink = r => {
    const p = new URLSearchParams({ week: r.week });
    if (r.season !== IDX.current) p.set("season", r.season);
    if (r.game != null) p.set("game", r.game);
    if (r.teamId != null) p.set("team", r.teamId);
    if (r.pid != null) p.set("player", r.pid);
    return `<a class="when" href="#/matchups?${p}" title="Open this box score"><span>${r.season} · ${r.playoff ? "Playoffs" : "Wk"} ${r.week}</span>${r.game != null ? '<span class="go">Box score →</span>' : ""}</a>`;
  };

  const HISTORY = {
    overview(H) {
      const champs = H.champions.map(c => `<article class="champ-card">
        ${logoImg(c.logo, c.team, "lg")}
        <div><div class="kicker">${c.season} champion</div><div class="champ-team">${esc(c.team)}</div>
        <div class="team-mgr">${owners(c.owners)} · ${esc(c.record)}</div>
        ${c.runnerUp ? `<div class="team-mgr">Runner-up: ${esc(c.runnerUp.team)} (${owners(c.runnerUp.owners)})</div>` : ""}</div>
      </article>`).join("");
      const rows = H.members.map(x => {
        const open = state.openMember === x.id;
        const seasons = open ? `<tr class="sub-row"><td colspan="9"><div class="member-seasons">${x.seasons.slice().reverse().map(s => `
          <a class="ms" href="#/?season=${s.season}">${logoImg(s.logo, s.team)}<span><b>${s.season}</b> · ${esc(s.team)}<br><span class="team-mgr">${s.w}–${s.l}${s.t ? "–" + s.t : ""} · ${s.finish ? finishText(s.finish) : "in progress (#" + s.standing + ")"}</span></span></a>`).join("")}</div></td></tr>` : "";
        return `<tr class="member-row${open ? " open" : ""}" data-member="${esc(x.id)}" tabindex="0" aria-expanded="${open}">
          <td class="lead" data-label="Manager"><span class="mname">${esc(x.name)}</span>${x.active ? (x.seasons.length === 1 ? ' <span class="badge new">New</span>' : "") : ' <span class="badge former">Former</span>'}</td>
          <td class="n" data-label="Seasons">${x.seasons.length}</td><td class="n" data-label="Record">${x.w}–${x.l}${x.t ? "–" + x.t : ""}</td><td class="n" data-label="Win %">${(x.pct * 100).toFixed(1)}%</td>
          <td class="n" data-label="Pts/game">${x.ppg.toFixed(1)}</td><td class="n" data-label="Titles">${x.titles ? `<b class="champ">${x.titles}</b>` : "0"}</td>
          <td class="n" data-label="Finals">${x.finals}</td><td class="n" data-label="Playoffs">${x.playoffs}</td><td class="n" data-label="Best">${x.best ? finishText(x.best) : "—"}</td></tr>${seasons}`;
      }).join("");
      return section("Champions", "", `<div class="champs">${champs || '<div class="empty">No completed seasons yet.</div>'}</div>`) +
        section("All-time standings", "By member, across every season they played. Tap a row for their seasons.",
          `<div class="table-wrap"><table class="tbl members"><thead><tr><th>Manager</th><th class="n">Seasons</th><th class="n">Record</th><th class="n">Win %</th><th class="n">Pts/game</th><th class="n">Titles</th><th class="n">Finals</th><th class="n">Playoffs</th><th class="n">Best</th></tr></thead><tbody>${rows}</tbody></table></div>`);
    },

    h2h(H) {
      const m = H.members, active = m.filter(x => x.active);
      if (!state.h2hA) state.h2hA = (active[0] || m[0]).id;
      if (!state.h2hB) state.h2hB = (active[1] || m[1] || m[0]).id;
      const opt = sel => m.map(x => `<option value="${esc(x.id)}"${x.id === sel ? " selected" : ""}>${esc(x.name)}${x.active ? "" : " (former)"}</option>`).join("");
      const h = H.h2h[state.h2hA + "|" + state.h2hB];
      const a = m.find(x => x.id === state.h2hA), b = m.find(x => x.id === state.h2hB);
      let body;
      if (state.h2hA === state.h2hB) body = '<p class="muted">Pick two different members.</p>';
      else if (!h || h[0] + h[1] + h[2] === 0) body = `<p class="muted">${esc(a.name)} and ${esc(b.name)} have never played each other.</p>`;
      else {
        const g = h[0] + h[1] + h[2];
        const lead = h[0] > h[1] ? a.name + " leads" : h[1] > h[0] ? b.name + " leads" : "All square";
        body = `<div class="h2h-score"><div><div class="big">${h[0]}</div><div class="kicker">${esc(a.name)}</div></div><div class="h2h-dash">–</div><div><div class="big">${h[1]}</div><div class="kicker">${esc(b.name)}</div></div></div>
          <p class="note">${esc(lead)}${h[2] ? " · " + h[2] + " tie" + (h[2] > 1 ? "s" : "") : ""} · Points ${h[3].toFixed(1)} – ${h[4].toFixed(1)} · ${(h[3] / g).toFixed(1)} vs ${(h[4] / g).toFixed(1)} per game</p>`;
      }
      return section("Head to head", `Every regular-season and playoff meeting since ${IDX.seasons[IDX.seasons.length - 1]}.`,
        `<div class="panel h2h"><div class="h2h-pick"><select id="h2h-a" aria-label="First manager">${opt(state.h2hA)}</select><span class="muted">vs</span><select id="h2h-b" aria-label="Second manager">${opt(state.h2hB)}</select></div>${body}</div>`);
    },

    rivalries(H) {
      const R = H.rivalries;
      const row = p => {
        const lead = p.aW > p.bW ? memberName(p.a) + " leads" : p.bW > p.aW ? memberName(p.b) + " leads" : "Dead even";
        return `<div class="rival"><div class="rival-names"><b>${esc(memberName(p.a))}</b> <span class="muted">vs</span> <b>${esc(memberName(p.b))}</b></div>
          <div class="rival-rec"><span class="big-sm">${p.aW}–${p.bW}${p.t ? "–" + p.t : ""}</span><span class="team-mgr">${esc(lead)} · ${p.games} games · ${p.diffPerGame.toFixed(1)} pts/game apart</span></div></div>`;
      };
      const list = (title, sub, rows) => section(title, sub, `<div class="rivals">${rows.map(row).join("") || '<p class="muted">Not enough games yet.</p>'}</div>`);
      return list("Most played", "The pairs that keep meeting.", R.mostPlayed) +
        list("Closest", "Three or more meetings, nearly even records and scores.", R.closest) +
        list("Most one-sided", "Three or more meetings, one member keeps winning.", R.lopsided);
    },

    records(H) {
      const R = H.records;
      const teamLine = (r, val) => `<div class="rec"><span class="rec-v">${val}</span><span class="rec-who">${logoImg(r.logo, r.team)}<span><b>${esc(r.team)}</b><span class="team-mgr">${owners(r.owners)}</span></span></span>${whenLink(r)}</div>`;
      const gameLine = (r, val) => `<div class="rec"><span class="rec-v">${val}</span><span class="rec-who"><span><b>${esc(r.winner.team)}</b> ${fmt(r.winPts)} – ${fmt(r.losePts)} <b>${esc(r.loser.team)}</b><span class="team-mgr">${owners(r.winner.owners)} over ${owners(r.loser.owners)}</span></span></span>${whenLink(r)}</div>`;
      const playerLine = r => `<div class="rec"><span class="rec-v">${fmt(r.pts)}</span><span class="rec-who"><span class="slot ${esc(r.pos)}">${esc(r.pos)}</span><span><b>${esc(r.name)}</b><span class="team-mgr">${esc(r.team)} · ${owners(r.owners)}</span></span></span>${whenLink(r)}</div>`;
      const card = (title, rows) => `<section class="rec-card"><h3>${title}</h3>${rows}</section>`;
      return `<div class="rec-grid">
        ${card("Highest scores", R.highScores.map(r => teamLine(r, fmt(r.pts))).join(""))}
        ${card("Lowest scores", R.lowScores.map(r => teamLine(r, fmt(r.pts))).join(""))}
        ${card("Biggest blowouts", R.blowouts.map(r => gameLine(r, "+" + r.margin.toFixed(1))).join(""))}
        ${card("Closest games", R.closest.map(r => gameLine(r, r.margin.toFixed(2))).join(""))}
        ${card("Highest-scoring games", R.shootouts.map(r => gameLine(r, r.combined.toFixed(1))).join(""))}
        ${card("Best player games", R.playerGames.map(playerLine).join(""))}
        ${card("Best games on the bench", R.benchGames.map(playerLine).join(""))}
      </div>`;
    },
  };

  function renderHistory() {
    const H = IDX.history;
    const sub = HISTORY_TABS.some(([k]) => k === state.sub) ? state.sub : "overview";
    main.innerHTML = `<div class="section-head"><div><h1>League history</h1><p class="sub">${IDX.seasons.length} seasons · ${H.members.length} members all-time</p></div></div>
      ${subnav("history", HISTORY_TABS, sub)}${HISTORY[sub](H)}`;
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

  document.addEventListener("click", e => {
    const btn = e.target.closest(".info-btn");
    if (!btn) return;
    const p = btn.closest(".expl");
    const open = !p.classList.contains("open");
    p.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", open);
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
    const side = e.target.closest("[data-boxside]");
    if (side) {
      const art = side.closest(".game");
      art.querySelector(".box").dataset.show = side.dataset.boxside;
      art.querySelectorAll("[data-boxside]").forEach(b => {
        const on = b === side;
        b.classList.toggle("active", on);
        b.setAttribute("aria-selected", on);
      });
      return;
    }
    const game = e.target.closest("[data-game]");
    if (game) {
      const p = new URLSearchParams(state.params);
      p.get("game") === game.dataset.game ? p.delete("game") : p.set("game", game.dataset.game);
      ["team", "player"].forEach(k => p.delete(k));
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
    if (e.target.id === "draft-team") { state.draftTeam = e.target.value; renderKeepScroll(renderInsights); }
    if (e.target.id === "h2h-a") { state.h2hA = e.target.value; renderKeepScroll(renderHistory); }
    if (e.target.id === "h2h-b") { state.h2hB = e.target.value; renderKeepScroll(renderHistory); }
  });

  function renderKeepScroll(fn) {
    const y = window.scrollY;
    fn();
    window.scrollTo(0, y);
  }



  // ---------------------------------------------------------------- player stat lines
  // ESPN stat ids -> labels for the scoring breakdown (every id that scores in this league is covered)
  const STAT = {
    0: "Pass attempts", 1: "Completions", 3: "Passing yards", 4: "Passing TDs", 15: "40+ yd TD pass bonus", 16: "50+ yd TD pass bonus",
    19: "2-pt pass", 20: "Interceptions thrown", 23: "Rushes", 24: "Rushing yards", 25: "Rushing TDs", 26: "2-pt rush",
    35: "40+ yd TD run bonus", 36: "50+ yd TD run bonus", 37: "100-199 rush yd bonus", 38: "200+ rush yd bonus",
    42: "Receiving yards", 43: "Receiving TDs", 44: "2-pt catch", 45: "40+ yd TD catch bonus", 46: "50+ yd TD catch bonus",
    53: "Receptions", 56: "100-199 rec yd bonus", 57: "200+ rec yd bonus", 58: "Targets", 63: "Fumble recovered for TD", 72: "Fumbles lost",
    77: "FG made 40-49", 80: "FG made 0-39", 85: "FG missed", 86: "Extra points", 88: "Extra point missed", 198: "FG made 50-59", 201: "FG made 60+",
    89: "Shutout (0 pts allowed)", 90: "1-6 pts allowed", 91: "7-13 pts allowed", 92: "14-17 pts allowed", 121: "18-21 pts allowed",
    122: "22-27 pts allowed", 123: "28-34 pts allowed", 124: "35-45 pts allowed", 125: "46+ pts allowed",
    93: "Blocked kick return TD", 95: "Interceptions", 96: "Fumbles recovered", 97: "Blocked kicks", 98: "Safeties", 99: "Sacks",
    101: "Kickoff return TD", 102: "Punt return TD", 103: "Interception return TD", 104: "Fumble return TD", 113: "Passes defended",
    114: "Kick return yards", 115: "Punt return yards", 206: "Defensive 2-pt return",
    128: "0-99 yds allowed", 129: "100-199 yds allowed", 130: "200-299 yds allowed", 131: "300-349 yds allowed", 132: "350-399 yds allowed",
    133: "400-449 yds allowed", 134: "450-499 yds allowed", 135: "500-549 yds allowed", 136: "550+ yds allowed",
  };
  const BRACKET = new Set([89, 90, 91, 92, 121, 122, 123, 124, 125, 128, 129, 130, 131, 132, 133, 134, 135, 136]);

  function loadStats(season) {
    window.LEAGUE_STATS = window.LEAGUE_STATS || {};
    if (window.LEAGUE_STATS[season]) return Promise.resolve(window.LEAGUE_STATS[season]);
    return new Promise((resolve, reject) => {
      const sc = document.createElement("script");
      sc.src = "data/" + season + "-stats.js?t=" + Date.now();
      sc.onload = () => (window.LEAGUE_STATS[season] ? resolve(window.LEAGUE_STATS[season]) : reject(new Error("empty")));
      sc.onerror = () => reject(new Error("load failed"));
      document.head.appendChild(sc);
    });
  }

  // a box-score style one-liner from the raw stats
  function statLine(pos, r) {
    const n = id => Number(r[id] || 0);
    const v = x => (Math.round(x * 10) / 10).toLocaleString();
    const parts = [];
    const pass = () => { if (n(0) || n(1) || n(3)) parts.push(`${v(n(1))}/${v(n(0))}, ${v(n(3))} pass yds${n(4) ? ", " + n(4) + " TD" : ""}${n(20) ? ", " + n(20) + " INT" : ""}`); };
    const rush = () => { if (n(23) || n(24)) parts.push(`${v(n(23))} rush, ${v(n(24))} yds${n(25) ? ", " + n(25) + " TD" : ""}`); };
    const rec = () => { if (n(53) || n(58) || n(42)) parts.push(`${v(n(53))} rec${n(58) ? ` (${v(n(58))} tgt)` : ""}, ${v(n(42))} yds${n(43) ? ", " + n(43) + " TD" : ""}`); };
    if (pos === "K") {
      parts.push(`FG ${v(n(83))}/${v(n(84))}`, `XP ${v(n(86))}/${v(n(87))}`);
    } else if (pos === "D/ST") {
      if (n(99)) parts.push(`${v(n(99))} sack${n(99) === 1 ? "" : "s"}`);
      if (n(95)) parts.push(`${v(n(95))} INT`);
      if (n(96)) parts.push(`${v(n(96))} fumble rec`);
      const tds = n(93) + n(101) + n(102) + n(103) + n(104);
      if (tds) parts.push(`${tds} TD`);
      if (r[120] != null) parts.push(`${v(n(120))} pts allowed`);
      if (r[127] != null) parts.push(`${v(n(127))} yds allowed`);
    } else {
      if (pos === "QB") { pass(); rush(); rec(); }
      else if (pos === "RB") { rush(); rec(); pass(); }
      else { rec(); rush(); pass(); }
      if (n(72)) parts.push(`${v(n(72))} fumble${n(72) === 1 ? "" : "s"} lost`);
    }
    return parts.join(" · ");
  }

  async function openPlayerStats(pid, week) {
    const wk = D.weeks.find(x => x.week === week);
    let p = null, team = null;
    (wk ? wk.games : []).forEach(g => g.sides.forEach(sd => sd.lineup.forEach(x => { if (String(x.id) === String(pid)) { p = x; team = sd.team; } })));
    if (!p) return;
    const sheet = document.createElement("div");
    sheet.className = "share-modal stat-modal";
    sheet.innerHTML = `<div class="share-sheet stat-sheet" role="dialog" aria-modal="true" aria-label="${esc(p.name)} stat line">
      <div class="stat-head"><span class="slot ${esc(p.pos)}">${esc(p.pos)}</span><div style="min-width:0"><div class="stat-name">${esc(p.name)}</div>
      <div class="team-mgr">${esc(p.team)} · Week ${week}${L.season !== IDX.current ? ", " + L.season : ""} · ${esc((teamById[team] || {}).name || "")}${p.slot === "BE" || p.slot === "IR" ? " (bench)" : ""}</div></div>
      <div class="stat-pts">${fmt(p.pts)}<small>fantasy pts</small></div></div>
      <div class="stat-body"><div class="empty">Loading stats…</div></div>
      <button type="button" class="linkbtn share-close">Close</button></div>`;
    document.body.appendChild(sheet);
    const close = () => { sheet.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = e => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    sheet.addEventListener("click", e => { if (e.target === sheet || e.target.closest(".share-close")) close(); });
    let st = null;
    try { st = (await loadStats(L.season))[week + "|" + pid]; } catch (_) { /* shown below */ }
    const body = sheet.querySelector(".stat-body");
    if (!st) { body.innerHTML = `<p class="muted">${Math.abs(p.pts) < 0.01 ? "No stats this week (didn't play, bye or inactive)." : "Stats aren't available for this week."}</p>`; return; }
    const r = st.r, a = st.a;
    const rows = Object.keys(a).map(Number).sort((x, y) => Math.abs(a[y]) - Math.abs(a[x])).map(id => {
      const label = STAT[id] || "Stat #" + id;
      const raw = BRACKET.has(id) ? "" : (r[id] != null ? (Math.round(r[id] * 10) / 10).toLocaleString() : "");
      return `<tr><td>${esc(label)}</td><td class="n muted">${raw}</td><td class="n"><b class="${a[id] < 0 ? "neg" : ""}">${a[id] > 0 ? "+" : ""}${a[id].toFixed(2)}</b></td></tr>`;
    }).join("");
    const total = Object.values(a).reduce((x, y) => x + y, 0);
    const live = !wk.final ? `<p class="note live">Live · updates with each refresh during games</p>` : "";
    body.innerHTML = `<div class="stat-line">${esc(statLine(p.pos, r)) || "No recorded stats"}</div>${live}
      <table class="stat-tbl"><thead><tr><th>Scoring</th><th class="n">Stat</th><th class="n">Pts</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="muted">No scoring plays</td></tr>'}</tbody>
      <tfoot><tr><td>Total</td><td></td><td class="n"><b>${total.toFixed(2)}</b></td></tr></tfoot></table>`;
  }

  document.addEventListener("click", e => {
    const line = e.target.closest("[data-stat]");
    if (!line) return;
    openPlayerStats(line.dataset.stat, Number(line.dataset.statWeek));
  });
  document.addEventListener("keydown", e => {
    const line = e.target.closest && e.target.closest("[data-stat]");
    if (line && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); line.click(); }
  });

  // ---------------------------------------------------------------- shareable image cards
  const SHARE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 10V2M5 5l3-3 3 3M3 8v5h10V8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
  const SITE_URL = location.host.endsWith("github.io") ? location.host + location.pathname.replace(/index\.html$/, "") : location.host;

  // Loads a logo onto its own small canvas. Some ESPN logo SVGs reference outside images, which would "taint"
  // the share card and block exporting it, so any logo that can't be read back falls back to initials.
  function loadImg(src) {
    return new Promise(res => {
      if (!src) return res(null);
      const im = new Image();
      im.onload = () => {
        try {
          const cv = document.createElement("canvas");
          cv.width = cv.height = 152;
          const cx = cv.getContext("2d");
          cx.drawImage(im, 0, 0, 152, 152);
          cx.getImageData(0, 0, 1, 1);
          res(cv);
        } catch (_) { res(null); }
      };
      im.onerror = () => res(null);
      im.src = src;
      setTimeout(() => res(null), 4000);
    });
  }

  // Draws a 1080px-wide card: brand header, a title, then rows of {logo, title, sub, value, hi}.
  async function drawCard(spec) {
    try { await Promise.all(["900 40px Archivo", "800 40px Archivo", "600 20px Inter", "700 20px Inter"].map(f => document.fonts.load(f))); } catch (_) { /* system fonts */ }
    const W = 1080, PAD = 64, ROW = 132, GAP = 16, HEAD = 200;
    const rows = spec.rows;
    const noteH = spec.note ? 120 : 0;
    const H = HEAD + 150 + rows.length * (ROW + GAP) + noteH + 110;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    const C = { head: "#0c2a20", accent: "#2bc47b", bg: "#f1f4f2", card: "#ffffff", ink: "#0f1a16", ink2: "#56645e", line: "#d5ddd8", hot: "#e2522f" };
    const font = (w, px, fam) => `${w} ${px}px ${fam === "a" ? "Archivo, Inter, sans-serif" : "Inter, system-ui, sans-serif"}`;
    const fit = (text, max) => { text = String(text); if (c.measureText(text).width <= max) return text; while (text.length > 1 && c.measureText(text + "…").width > max) text = text.slice(0, -1); return text + "…"; };
    const rr = (x, y, w, h, r) => { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); };
    // background + header
    c.fillStyle = C.bg; c.fillRect(0, 0, W, H);
    c.fillStyle = C.head; c.fillRect(0, 0, W, HEAD);
    c.fillStyle = C.accent; c.fillRect(0, HEAD - 8, W, 8);
    c.strokeStyle = C.accent; c.lineWidth = 7; c.lineJoin = "round";
    const mk = (x, y, s) => { c.beginPath(); c.moveTo(x + 6 * s, y + 30 * s); c.lineTo(x + 20 * s, y + 8 * s); c.lineTo(x + 34 * s, y + 30 * s); c.closePath(); c.stroke(); c.beginPath(); c.moveTo(x + 13 * s, y + 30 * s); c.lineTo(x + 20 * s, y + 19 * s); c.lineTo(x + 27 * s, y + 30 * s); c.stroke(); };
    mk(PAD - 14, 52, 2.4);
    c.fillStyle = "rgba(234,245,239,.7)"; c.font = font(700, 22); c.textBaseline = "alphabetic";
    c.fillText("LEAGUE HQ", PAD + 92, 86);
    c.fillStyle = "#eaf5ef"; c.font = font(900, 44, "a");
    c.fillText(fit(IDX.name.toUpperCase(), W - PAD * 2 - 92), PAD + 92, 138);
    // title block
    c.fillStyle = C.accent; c.font = font(800, 24);
    c.fillText(spec.kicker.toUpperCase(), PAD, HEAD + 62);
    c.fillStyle = C.ink; c.font = font(900, 50, "a");
    c.fillText(fit(spec.title, W - PAD * 2), PAD, HEAD + 120);
    // rows
    let y = HEAD + 150;
    for (const r of rows) {
      rr(PAD, y, W - PAD * 2, ROW, 22); c.fillStyle = r.hi ? "#e3f6ec" : C.card; c.fill();
      c.lineWidth = r.hi ? 3 : 2; c.strokeStyle = r.hi ? C.accent : C.line; c.stroke();
      let x = PAD + 28;
      if (r.logo !== undefined) {
        const im = await loadImg(r.logo);
        const cx = x + 38, cy = y + ROW / 2;
        c.save(); c.beginPath(); c.arc(cx, cy, 38, 0, Math.PI * 2); c.closePath(); c.clip();
        if (im) c.drawImage(im, cx - 38, cy - 38, 76, 76);
        else { c.fillStyle = "#e8eeea"; c.fillRect(cx - 38, cy - 38, 76, 76); c.fillStyle = C.ink2; c.font = font(800, 28); c.textAlign = "center"; c.fillText(initials(r.title), cx, cy + 10); c.textAlign = "left"; }
        c.restore();
        x += 100;
      }
      c.font = font(900, 50, "a");
      const vW = r.value ? c.measureText(r.value).width : 0;
      const textMax = W - PAD - 28 - x - (vW ? vW + 24 : 0);
      if (r.label) { c.fillStyle = C.ink2; c.font = font(800, 19); c.fillText(fit(r.label.toUpperCase(), textMax), x, y + 40); }
      c.fillStyle = C.ink; c.font = font(700, 34);
      c.fillText(fit(r.title, textMax), x, y + (r.label ? 82 : r.sub ? 62 : 78));
      if (r.sub) { c.fillStyle = C.ink2; c.font = font(600, 24); c.fillText(fit(r.sub, textMax), x, y + (r.label ? 112 : 100)); }
      if (r.value) { c.fillStyle = r.hi ? "#14824e" : C.ink; c.font = font(900, 50, "a"); c.textAlign = "right"; c.fillText(r.value, W - PAD - 28, y + ROW / 2 + 18); c.textAlign = "left"; }
      y += ROW + GAP;
    }
    if (spec.note) {
      c.fillStyle = C.ink; c.font = font(700, 30);
      const words = spec.note.split(" "); let line = "", ly = y + 44;
      for (const wd of words) { if (c.measureText(line + wd).width > W - PAD * 2) { c.fillText(line.trim(), PAD, ly); line = ""; ly += 40; } line += wd + " "; }
      c.fillText(line.trim(), PAD, ly);
    }
    c.fillStyle = C.ink2; c.font = font(600, 22);
    c.fillText(SITE_URL, PAD, H - 48);
    c.textAlign = "right"; c.fillText(`${L.season} season`, W - PAD, H - 48); c.textAlign = "left";
    return new Promise(res => cv.toBlob(res, "image/png"));
  }

  function shareSpec(kind, el) {
    const tn = id => (teamById[id] || { name: "?" }).name;
    const tl = id => (teamById[id] || {}).logo || "";
    if (kind === "recap") {
      const w = Number(el.dataset.week), r = D.recaps[w];
      const rows = [{ label: "Top score", logo: tl(r.high.team), title: tn(r.high.team), value: fmt(r.high.pts), hi: true },
        { label: "Low score", logo: tl(r.low.team), title: tn(r.low.team), value: fmt(r.low.pts) }];
      if (r.blowout) rows.push({ label: "Biggest blowout", logo: tl(r.blowout.winner), title: tn(r.blowout.winner), sub: "beat " + tn(r.blowout.loser), value: "+" + Number(r.blowout.margin).toFixed(1) });
      if (r.closest) rows.push({ label: "Closest game", logo: tl(r.closest.winner), title: tn(r.closest.winner), sub: "edged " + tn(r.closest.loser), value: "+" + Number(r.closest.margin).toFixed(2) });
      if (r.topPlayer) rows.push({ label: "Player of the week", title: r.topPlayer.name, sub: r.topPlayer.pos + " · " + tn(r.topPlayer.team), value: fmt(r.topPlayer.pts) });
      if (r.mostLeft && r.mostLeft.pts > 0) rows.push({ label: "Most left on the bench", logo: tl(r.mostLeft.team), title: tn(r.mostLeft.team), value: fmt(r.mostLeft.pts) });
      return { file: `week-${w}-recap`, kicker: `Week ${w} recap`, title: `${L.season} · Week ${w}`, rows };
    }
    if (kind === "game") {
      const w = Number(el.dataset.week), wk = D.weeks.find(x => x.week === w);
      const g = wk.games.find(x => String(x.id) === el.dataset.game);
      const win = g.winner === "HOME" ? 0 : g.winner === "AWAY" ? 1 : -1;
      const rows = g.sides.map((s, i) => {
        const top = s.lineup.filter(p => p.slot !== "BE" && p.slot !== "IR").sort((a, b) => b.pts - a.pts)[0];
        return { logo: tl(s.team), title: tn(s.team), sub: (teamById[s.team] || {}).manager + (top ? ` · top: ${top.name} ${fmt(top.pts)}` : ""), value: fmt(s.pts), hi: wk.final ? win === i : false };
      });
      const tier = TIER[g.tier] || "";
      const note = wk.final && win !== -1 ? `${tn(g.sides[win].team)} wins by ${Math.abs(g.sides[0].pts - g.sides[1].pts).toFixed(2)}.` : !wk.final ? "Live score · week in progress." : "";
      return { file: `week-${w}-matchup`, kicker: `${tier ? tier + " · " : ""}Week ${w} · ${wk.final ? "Final" : "Live"}`, title: `${tn(g.sides[0].team)} vs ${tn(g.sides[1].team)}`, rows, note };
    }
    if (kind === "trade") {
      const tr = D.trades.find(x => String(x.id) === el.dataset.trade);
      const graded = tr.weeksSince > 0;
      const best = graded ? Math.max(...tr.sides.map(s => s.started)) : null;
      const rows = tr.sides.map(s => ({ label: "Receives", logo: tl(s.team), title: tn(s.team), sub: s.gets.map(p => p.name).join(", "),
        value: graded ? s.started.toFixed(1) : "", hi: graded && s.started === best && Math.abs(tr.sides[0].started - tr.sides[1].started) >= 5 }));
      let note = "Too early to grade: no completed weeks since the trade.";
      if (graded && tr.sides.length === 2) {
        const d = tr.sides[0].started - tr.sides[1].started;
        note = Math.abs(d) < 5 ? "Even so far in started points." : `${tn(tr.sides[d > 0 ? 0 : 1].team)} ${L.over ? "won" : "is winning"} by ${Math.abs(d).toFixed(1)} started points over ${tr.weeksSince} week${tr.weeksSince === 1 ? "" : "s"}.`;
      }
      return { file: `trade-week-${tr.week || ""}`, kicker: `Trade grade${tr.week ? " · Week " + tr.week : ""}`, title: tr.sides.map(s => tn(s.team)).join(" ⇄ "), rows, note };
    }
    if (kind === "bracket") {
      const M = bracketModel();
      const rows = [];
      M.rounds.forEach(r => r.matches.filter(m => !m.bye && !m.tbd && m.entries.length === 2).forEach(m => {
        const [a, b] = m.entries, w = a.won ? a : b.won ? b : null;
        rows.push({ label: r.name, logo: tl((w || a).team), title: `${a.seed ? "#" + a.seed + " " : ""}${tn(a.team)} vs ${b.seed ? "#" + b.seed + " " : ""}${tn(b.team)}`,
          sub: w ? `${tn(w.team)} advances` : "in progress", value: `${fmt(a.pts)}–${fmt(b.pts)}`.replace(/\.\d+/g, ""), hi: r.r === M.rounds.length && !!w });
      }));
      const champ = M.champion ? tn(M.champion) : null;
      return { file: `${L.season}-playoffs`, kicker: `${L.season} playoffs`, title: champ ? `Champion: ${champ}` : "Playoff bracket", rows };
    }
    return null;
  }

  async function openShare(kind, el) {
    const spec = shareSpec(kind, el);
    if (!spec) return;
    const modal = document.createElement("div");
    modal.className = "share-modal";
    modal.innerHTML = `<div class="share-sheet" role="dialog" aria-modal="true" aria-label="Share image"><div class="share-preview"><div class="empty">Making the image…</div></div>
      <div class="share-actions"></div><button type="button" class="linkbtn share-close">Close</button></div>`;
    document.body.appendChild(modal);
    const close = () => { modal.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = e => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    modal.addEventListener("click", e => { if (e.target === modal || e.target.closest(".share-close")) close(); });
    let blob;
    try { blob = await drawCard(spec); } catch (_) { blob = null; }
    if (!document.body.contains(modal)) return;
    if (!blob) { modal.querySelector(".share-preview").innerHTML = '<div class="empty">Couldn\'t make the image. Try again.</div>'; return; }
    const name = `league-hq-${spec.file}.png`.replace(/[^a-z0-9.-]+/gi, "-").toLowerCase();
    const url = URL.createObjectURL(blob);
    modal.querySelector(".share-preview").innerHTML = `<img src="${url}" alt="${esc(spec.title)}">`;
    const file = new File([blob], name, { type: "image/png" });
    const acts = [];
    if (navigator.canShare && navigator.canShare({ files: [file] })) acts.push('<button type="button" class="cta" data-act="share">Share…</button>');
    if (navigator.clipboard && window.ClipboardItem) acts.push('<button type="button" class="cta alt" data-act="copy">Copy image</button>');
    acts.push(`<a class="cta alt" data-act="download" href="${url}" download="${name}">Download</a>`);
    const box = modal.querySelector(".share-actions");
    box.innerHTML = acts.join("");
    box.addEventListener("click", async e => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      try {
        if (b.dataset.act === "share") await navigator.share({ files: [file], title: spec.title });
        if (b.dataset.act === "copy") { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); b.textContent = "Copied!"; }
      } catch (_) { /* cancelled */ }
    });
  }

  document.addEventListener("click", e => {
    const b = e.target.closest(".share-btn");
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    openShare(b.dataset.share, b);
  }, true);

  // ---------------------------------------------------------------- live updates
  // While the current season is in progress, re-check for fresh data every 2 minutes
  // (the site itself refreshes from ESPN every 15 minutes during games).
  const live = { on: false, timer: null };
  async function poll() {
    if (document.hidden) return;
    try {
      const idxText = await (await fetch("data/index.js?t=" + Date.now(), { cache: "no-store" })).text();
      const fresh = parseAssigned(idxText);
      if (newerBuildLive(fresh.build)) return;
      if (fresh.updated === IDX.updated) { renderBanner(); return; }
      const seasonText = await (await fetch("data/" + fresh.current + ".js?t=" + Date.now(), { cache: "no-store" })).text();
      window.LEAGUE_DATA[fresh.current] = parseAssigned(seasonText);
      if (window.LEAGUE_STATS) delete window.LEAGUE_STATS[fresh.current];
      Object.assign(IDX, fresh);
      if (state.season === IDX.current || state.tab === "history") {
        const y = window.scrollY;
        await route();
        window.scrollTo(0, y);
      }
    } catch (_) { /* offline or mid-deploy: try again next time */ }
  }
  // Minute-by-minute scores: the live worker returns the current week's matchups, lineups and stat lines
  // straight from ESPN (cached 60s on its side). The full site still rebuilds on its own schedule.
  const LIVE_API = ((window.LEAGUE_CONFIG || {}).liveApi || "").replace(/\/$/, "");
  let liveAsOf = null;
  async function liveTick() {
    if (document.hidden || !LIVE_API) return;
    const cur = window.LEAGUE_DATA[IDX.current];
    if (!cur || cur.league.over) return;
    try {
      const r = await fetch(LIVE_API + "/live", { cache: "no-store" });
      if (!r.ok) return;
      const lv = await r.json();
      if (lv.error || lv.season !== IDX.current) return;
      if (lv.week !== cur.league.currentWeek) { poll(); return; } // ESPN moved on to a new week: reload everything
      const wk = cur.weeks.find(w => w.week === lv.week);
      if (!wk || wk.final) return;
      wk.games = lv.games;
      if (window.LEAGUE_STATS && window.LEAGUE_STATS[IDX.current]) Object.assign(window.LEAGUE_STATS[IDX.current], lv.stats);
      liveAsOf = lv.updated;
      updateLiveChip();
      const typing = document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
      if (state.season === IDX.current && ["standings", "matchups"].includes(state.tab) && !typing) {
        const y = window.scrollY;
        await route();
        window.scrollTo(0, y);
      }
    } catch (_) { /* network blip: next minute */ }
  }
  function updateLiveChip() {
    const chip = document.getElementById("live-chip");
    if (!chip || !live.on) return;
    chip.className = "live-chip on";
    chip.textContent = LIVE_API
      ? "Live · scores update every minute" + (liveAsOf ? " · as of " + new Date(liveAsOf).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "")
      : "Live · checking every 2 min";
  }
  function startLive() {
    const cur = window.LEAGUE_DATA[IDX.current];
    if (!cur || cur.league.over || live.timer) return;
    live.on = true;
    live.timer = setInterval(poll, 120000);
    if (LIVE_API) { liveTick(); setInterval(liveTick, 60000); }
    updateLiveChip();
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { poll(); liveTick(); } });
  }

  route().then(startLive);
})();
