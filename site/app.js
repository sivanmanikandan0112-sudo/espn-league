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
    h2hA: null, h2hB: null, openMember: null, storyTeam: store.get("story-team", null),
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
    const tab = ["myteam", "matchups", "insights", "trades", "history", "settings"].find(t => path.startsWith("/" + t)) || "standings";
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
    renderTicker();
    if (tab === "matchups") renderMatchups();
    else if (tab === "insights") renderInsights();
    else if (tab === "trades") renderTrades();
    else if (tab === "history") renderHistory();
    else if (tab === "settings") renderSettings();
    else if (tab === "myteam") renderMyTeam();
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
    if (!navigator.onLine) {
      el.innerHTML = `<div class="banner offline" role="status"><strong>You're offline.</strong> Showing the last saved scores (updated ${esc(ago(IDX.updated))}). They'll refresh when you're back online.</div>`;
      return;
    }
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
    return `<article class="team${open ? " open" : ""}${isMine(t) ? " mine" : ""}" data-id="${t.id}">
      <button class="team-head" aria-expanded="${open}" data-toggle="${t.id}">
        <span class="rank">${pad(rankFor(t, i))}</span>
        ${logo(t)}
        <span style="min-width:0"><div class="team-name">${isMine(t) ? '<span class="me-tag">You</span>' : ""}${esc(t.name)}</div><div class="team-mgr">${esc(t.manager)}</div></span>
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
  // ---- "Since your last visit": compares the league now with a snapshot saved on this device last visit
  const SINCE_GAP_MS = 3 * 3600e3;
  const since = { prev: null, shown: false, dismissed: false };
  function leagueSnapshot() {
    const cur = window.LEAGUE_DATA[IDX.current];
    return {
      at: Date.now(), season: IDX.current, week: cur.league.currentWeek,
      finals: cur.weeks.filter(w => w.final).map(w => w.week),
      ranks: Object.fromEntries(cur.teams.map(t => [t.id, t.standing])),
      odds: Object.fromEntries(cur.teams.filter(t => t.odds).map(t => [t.id, t.odds.playoffPct])),
      trades: cur.trades.map(t => String(t.id)),
    };
  }
  function initSince() {
    if (since.prev !== null) return;
    const now = leagueSnapshot();
    const last = store.get("last-visit", null);
    let base = store.get("since-base", null);       // the comparison point stays until "Got it", so reloads keep the card
    if (last && last.season === now.season && Date.now() - last.at >= SINCE_GAP_MS) {
      base = base && base.season === now.season ? base : last;
      store.set("since-base", base);
    }
    if (!last || last.season !== now.season || Date.now() - last.at >= SINCE_GAP_MS) store.set("last-visit", now);
    since.prev = base && base.season === now.season ? base : false;
  }
  function myTeamId() {
    const cur = window.LEAGUE_DATA[IDX.current];
    const m = store.get("pk-member", "");
    const t = m && cur.teams.find(x => (x.owners || []).includes(m));
    return t ? t.id : null;
  }
  function sinceCard() {
    if (state.season !== IDX.current || since.dismissed) return "";
    initSince();
    const prev = since.prev;
    if (!prev) return "";
    const cur = window.LEAGUE_DATA[IDX.current];
    const tb = id => cur.teams.find(t => t.id === Number(id)) || { name: "?" };
    const me = myTeamId();
    const items = [];
    // weeks that finished since then
    cur.weeks.filter(w => w.final && !prev.finals.includes(w.week)).forEach(w => {
      const g = me != null && w.games.find(x => x.sides.some(s => s.team === me));
      if (g && g.sides.length === 2) {
        const mine = g.sides.find(s => s.team === me), opp = g.sides.find(s => s.team !== me);
        const won = mine.pts > opp.pts;
        items.push(`<b>Week ${w.week}:</b> you ${won ? "beat" : mine.pts < opp.pts ? "lost to" : "tied"} ${esc(tb(opp.team).name)} <span class="num">${fmt(mine.pts)}–${fmt(opp.pts)}</span> <a class="wk-link" href="${href("matchups", { week: w.week, game: g.id })}">box score</a>`);
      } else {
        const sides = w.games.flatMap(x => x.sides);
        const hi = sides.reduce((a, b) => (b.pts > a.pts ? b : a), sides[0]);
        if (hi) items.push(`<b>Week ${w.week} is final.</b> Top score: ${esc(tb(hi.team).name)} with ${fmt(hi.pts)}. <a class="wk-link" href="${href("matchups", { week: w.week })}">recap</a>`);
      }
    });
    // standings
    if (me != null && prev.ranks[me] && prev.ranks[me] !== tb(me).standing) {
      const a = prev.ranks[me], b = tb(me).standing;
      items.push(`You ${b < a ? "climbed" : "slipped"} from <b>${ordinal(a)}</b> to <b>${ordinal(b)}</b> in the standings.`);
    } else {
      const moves = cur.teams.map(t => ({ t, d: (prev.ranks[t.id] || t.standing) - t.standing })).filter(x => x.d).sort((a, b) => b.d - a.d);
      if (moves.length) items.push(`Biggest climb: <b>${esc(moves[0].t.name)}</b> up ${moves[0].d} to ${ordinal(moves[0].t.standing)}${moves.length > 1 && moves[moves.length - 1].d < 0 ? `; biggest drop: <b>${esc(moves[moves.length - 1].t.name)}</b> down ${-moves[moves.length - 1].d}` : ""}.`);
    }
    // playoff odds
    if (cur.teams.some(t => t.odds)) {
      if (me != null && prev.odds[me] != null) {
        const a = prev.odds[me], b = tb(me).odds.playoffPct;
        if (Math.abs(b - a) >= 1) items.push(`Your playoff odds: <b>${pct(a)} → ${pct(b)}</b>. <a class="wk-link" href="${href("insights", {}, "race")}">playoff race</a>`);
      } else {
        const mv = cur.teams.filter(t => t.odds && prev.odds[t.id] != null).map(t => ({ t, d: t.odds.playoffPct - prev.odds[t.id] })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d))[0];
        if (mv && Math.abs(mv.d) >= 3) items.push(`Biggest playoff-odds swing: <b>${esc(mv.t.name)}</b> ${pct(prev.odds[mv.t.id])} → ${pct(mv.t.odds.playoffPct)}.`);
      }
    }
    // trades
    const newTrades = cur.trades.filter(t => !prev.trades.includes(String(t.id)));
    if (newTrades.length) items.push(`${newTrades.length} new trade${newTrades.length === 1 ? "" : "s"}: ${newTrades.slice(0, 2).map(t => t.sides.map(s => esc(tb(s.team).name)).join(" ⇄ ")).join("; ")}${newTrades.length > 2 ? "…" : ""} <a class="wk-link" href="${href("trades")}">see trades</a>`);
    // new week: pick'em window
    // new week: mention pick'em only if picks are actually still open (checked with the live worker after render)
    const askPickem = cur.league.currentWeek > prev.week && !cur.league.over && LIVE_API_BASE();
    if (!items.length && !askPickem) return "";
    const when = new Date(prev.at).toLocaleDateString([], { weekday: "long" });
    const who = me != null ? `Showing for <b>${esc(tb(me).name)}</b>.` : `<label class="since-who">Personalize: <select id="since-team"><option value="">Which team is yours?</option>${cur.teams.map(t => `<option value="${esc((t.owners || [])[0] || "")}">${esc(t.name)}</option>`).join("")}</select></label>`;
    return `<section class="since" aria-label="Since your last visit"><div class="since-head"><h2>Since ${esc(when)}</h2><button type="button" class="linkbtn" data-since="dismiss">Got it</button></div>
      <ul>${items.map(i => `<li>${i}</li>`).join("")}${askPickem ? '<li id="since-pickem" hidden></li>' : ""}</ul><p class="note">${who}</p></section>`;
  }

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

  // ---- season storyline: every team's place in the standings after each completed regular-season week
  function weeklyRanks() {
    const rs = L.regularSeasonWeeks;
    const weeks = D.weeks.filter(w => w.final && w.week <= rs).map(w => w.week).sort((a, b) => a - b);
    const acc = {};
    D.teams.forEach(t => { acc[t.id] = { w: 0, l: 0, t: 0, pf: 0 }; });
    const out = {};
    weeks.forEach(wk => {
      D.weeks.find(x => x.week === wk).games.forEach(g => {
        if (g.sides.length !== 2) return;
        const [a, b] = g.sides;
        if (!acc[a.team] || !acc[b.team]) return;
        acc[a.team].pf += a.pts; acc[b.team].pf += b.pts;
        if (a.pts > b.pts) { acc[a.team].w++; acc[b.team].l++; }
        else if (b.pts > a.pts) { acc[b.team].w++; acc[a.team].l++; }
        else { acc[a.team].t++; acc[b.team].t++; }
      });
      Object.keys(acc).sort((x, y) => (acc[y].w + acc[y].t / 2) - (acc[x].w + acc[x].t / 2) || acc[y].pf - acc[x].pf)
        .forEach((tid, i) => (out[tid] = out[tid] || []).push({ week: wk, rank: i + 1, rec: `${acc[tid].w}–${acc[tid].l}${acc[tid].t ? "–" + acc[tid].t : ""}` }));
    });
    return { weeks, ranks: out };
  }

  function storyline() {
    const { weeks, ranks } = weeklyRanks();
    if (weeks.length < 2) return "";
    const n = D.teams.length, W = 760, left = 34, right = 190, top = 14, row = 26, bottom = 30;
    const H = top + n * row + bottom, plotW = W - left - right;
    const x = i => left + (weeks.length === 1 ? 0 : i * plotW / (weeks.length - 1));
    const y = r => top + (r - 1) * row + row / 2;
    const sel = state.storyTeam != null ? String(state.storyTeam) : "";
    const grid = Array.from({ length: n }, (_, i) => `<text class="sl-axis" x="${left - 12}" y="${y(i + 1) + 4}" text-anchor="end">${i + 1}</text>`).join("")
      + weeks.map((wk, i) => `<line class="sl-grid" x1="${x(i)}" x2="${x(i)}" y1="${top}" y2="${top + n * row}"/><text class="sl-axis" x="${x(i)}" y="${H - 10}" text-anchor="middle">${wk}</text>`).join("")
      + `<text class="sl-axis" x="${left - 12}" y="${H - 10}" text-anchor="end">Wk</text>`;
    const lines = D.teams.map(t => {
      const pts = ranks[t.id] || [];
      const on = sel === String(t.id) ? " on" : "";
      const path = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.rank).toFixed(1)}`).join(" ");
      const last = pts[pts.length - 1];
      const dots = pts.map((p, i) => `<circle class="sl-dot" data-team="${t.id}" cx="${x(i).toFixed(1)}" cy="${y(p.rank).toFixed(1)}" r="5"><title>${esc(t.name)} · week ${p.week}: ${ordinal(p.rank)} (${p.rec})</title></circle>`).join("");
      const name = t.name.length > 22 ? t.name.slice(0, 21) + "…" : t.name;
      return `<g class="sl-team${on}" data-team="${t.id}" data-sl="${t.id}">
        <polyline class="sl-hit" points="${path}"/><polyline class="sl-line" points="${path}"/>${dots}
        <text class="sl-label" x="${W - right + 12}" y="${y(last.rank) + 4}">${last.rank}. ${esc(name)}</text></g>`;
    }).join("");
    return `<section class="insight storyline-sec"><div class="section-head"><div><h2>Season storyline</h2>
      ${expl("Where every team stood after each week. Tap a team to follow it.", "Each line is a team's place in the standings after every completed regular-season week (wins first, then points for). Hover or tap a line or name to highlight a team's path; hover a dot for its record that week.")}</div></div>
      <div class="sl-wrap"><svg class="storyline${sel ? " has-on" : ""}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Standings position by week for every team">${grid}${lines}</svg></div></section>`;
  }

  function slHighlight(id) {
    const svg = main.querySelector("svg.storyline");
    if (!svg) return;
    svg.querySelectorAll(".sl-team").forEach(g => g.classList.toggle("on", id != null && g.dataset.team === String(id)));
    svg.classList.toggle("has-on", id != null);
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
    main.innerHTML = `${sinceCard()}${tiles()}<div class="layout">
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
        ${storyline()}
      </section>
      ${sidebar()}
    </div>`;
    const sp = main.querySelector("#since-pickem");
    if (sp) pkApi("/pickem").then(d => {
      if (d && d.open && document.body.contains(sp)) {
        const lock = new Date(d.lockAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
        sp.innerHTML = `Week ${d.week} pick'em is open until ${esc(lock)}. <a class="wk-link" href="${href("matchups", {}, "pickem")}">Make your picks</a>`;
        sp.hidden = false;
      } else if (document.body.contains(sp)) {
        const card = sp.closest(".since"); sp.remove();
        if (card && !card.querySelector("li")) card.remove();
      }
    }).catch(() => {});
    const sl = main.querySelector(".sl-wrap");
    if (sl) sl.scrollLeft = sl.scrollWidth; // phones: open on the latest weeks, where the team names are
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

  const MATCHUP_TABS = [["", "Weekly"], ["plays", "Big plays"], ["watch", "Watch guide"], ["bracket", "Playoff bracket"], ["pickem", "Pick'em"]];

  // Big plays from the live worker (TDs, field goals, turnovers, defensive plays, big gains), newest first.
  function feedFor(week, gameId) {
    const f = window.LIVE_FEED;
    if (!f || f.week !== week || state.season !== IDX.current) return [];
    return f.events.filter(e => gameId == null || String(e.game) === String(gameId)).sort((a, b) => b.t - a.t);
  }
  // highlight clip on ESPN for the play, when the worker found one (clips expire after about 2 days)
  const watchLink = e => e.vid && /^https:\/\/www\.espn\.com\//.test(e.vid.u) && !(e.vid.x && Date.now() > e.vid.x)
    ? ` <a class="play-vid" href="${esc(e.vid.u)}" target="_blank" rel="noopener" aria-label="Watch the highlight on ESPN">▶ Watch</a>` : "";
  function playLine(e) {
    const t = teamById[e.team] || { name: "Team " + e.team }, o = teamById[e.opp] || { name: "opponent" };
    const lead = e.score[0] - e.score[1];
    const status = Math.abs(lead) < 0.005 ? `ties ${esc(o.name)}` : `${lead > 0 ? "leads" : "trails"} ${esc(o.name)} by ${Math.abs(lead).toFixed(2)}`;
    const when = new Date(e.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `<div class="play${e.starter ? "" : " bench"}"><span class="play-t">${when}</span>
      <span class="play-what"><b>${esc(e.name)}</b> <span class="muted">${esc(e.pos)}${e.nfl ? " · " + esc(e.nfl) : ""}</span> · ${esc(e.label)}${e.starter ? "" : ' <span class="muted">(bench)</span>'}${watchLink(e)}
      <span class="team-mgr">${esc(t.name)} ${status}</span></span>
      <span class="play-d ${e.delta >= 0 ? "pos" : "neg"}">${e.delta >= 0 ? "+" : ""}${e.delta.toFixed(2)}</span></div>`;
  }
  function feedPanel(week) {
    const ev = feedFor(week);
    if (!ev.length) return "";
    const FEED_SHOWN = 5; // newest plays shown here, so the feed doesn't crowd the matchups; the heading opens them all
    const all = href("matchups", {}, "plays");
    return `<section class="feed"><div class="section-head"><div><h2><a class="feed-title" href="${all}">Recent big plays <span aria-hidden="true">›</span></a></h2><p class="sub">Touchdowns, long field goals, turnovers and big gains, newest first. Updated every minute during games.</p></div></div>
      <div class="plays">${ev.slice(0, FEED_SHOWN).map(playLine).join("")}</div></section>`;
  }

  // Every big play this week, grouped by fantasy matchup (your matchup first, then the busiest).
  // Every big play this week, grouped by real NFL game (default) or by fantasy matchup; the choice is remembered.
  function renderPlays() {
    const asked = state.params.get("by");
    const by = asked === "fantasy" || asked === "nfl" ? asked : store.get("plays-by", "nfl") === "fantasy" ? "fantasy" : "nfl";
    if (asked) store.set("plays-by", by);
    const head = `<div class="section-head"><div><h1>Big plays</h1>${expl("Every big play this week, by NFL game or by fantasy matchup.",
      "Touchdowns, field goals worth 5+ points, turnovers, defensive plays worth 5+ points (in practice defensive and return TDs), and single plays of 30+ yards (50+ for a pass), caught live from ESPN every minute during games. Each play shows the fantasy points that play alone was worth and where its fantasy matchup stood right after it. Bench players are marked.")}</div></div>${subnav("matchups", MATCHUP_TABS, "plays")}`;
    const wk = state.season === IDX.current ? D.weeks.find(x => x.week === L.currentWeek) : null;
    if (!wk || L.over) { main.innerHTML = head + `<div class="empty">Big plays are tracked live for the current week while the season is in progress.${state.season !== IDX.current ? ` <a href="#/matchups/plays">Go to this week</a>` : ""}</div>`; return; }
    if (!window.LIVE_FEED) { main.innerHTML = head + `<div class="empty">Loading this week's plays…</div>`; return; }
    const all = feedFor(wk.week);
    const toggle = `<div class="pg-by" role="tablist" aria-label="Group big plays">${[["nfl", "By NFL game"], ["fantasy", "By fantasy matchup"]].map(([k, lab]) =>
      `<a role="tab" aria-selected="${by === k}" class="${by === k ? "active" : ""}" href="${href("matchups", { by: k }, "plays")}">${lab}</a>`).join("")}</div>`;
    const foot = (n, link) => `<div class="pg-foot"><span>${n} big play${n === 1 ? "" : "s"}</span>${link || ""}</div>`;
    const plays = ev => ev.length ? `<div class="plays pg-plays">${ev.map(playLine).join("")}</div>` : `<p class="pg-none">No big plays yet.</p>`;
    let body;
    if (by === "fantasy") {
      const games = wk.games.filter(g => g.sides.length === 2).map(g => ({ g, ev: all.filter(e => String(e.game) === String(g.id)) }))
        .sort((x, y) => (y.g.sides.some(s => isMine(teamById[s.team])) - x.g.sides.some(s => isMine(teamById[s.team]))) || y.ev.length - x.ev.length);
      body = games.map(({ g, ev }) => {
        const [a, b] = g.sides;
        const side = s => { const t = teamById[s.team]; return `<span class="pg-side">${logo(t)}<span class="pg-name">${esc(t.name)}</span><b class="num">${fmt(s.pts)}</b></span>`; };
        const box = href("matchups", { week: wk.week, game: g.id });
        return `<article class="pg-card${g.sides.some(s => isMine(teamById[s.team])) ? " mine" : ""}">
          <a class="pg-head" href="${box}">${side(a)}${side(b)}</a>${plays(ev)}${foot(ev.length, `<a href="${box}">Box score →</a>`)}</article>`;
      }).join("");
      body = `<div class="pg-grid">${body}</div>`;
    } else {
      // real NFL games this week; a play belongs to the game its player's NFL team is in
      const nfl = (D.nflGames || []).map(g => ({ g, ev: all.filter(e => e.nfl === g.home || e.nfl === g.away) }));
      const placed = new Set(nfl.flatMap(x => x.ev));
      const other = all.filter(e => !placed.has(e));
      const now = Date.now();
      const stateOf = g => { const k = Date.parse(g.date); return now < k ? "upcoming" : now < k + 4.25 * 3600e3 ? "live" : "final"; };
      const when = g => g.tbd ? "Time TBD" : new Date(g.date).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
      const withPlays = nfl.filter(x => x.ev.length).sort((x, y) => y.ev[0].t - x.ev[0].t); // most recent action first
      const quiet = nfl.filter(x => !x.ev.length && stateOf(x.g) !== "upcoming");
      const later = nfl.filter(x => !x.ev.length && stateOf(x.g) === "upcoming");
      const card = ({ g, ev }) => {
        const st = stateOf(g);
        const mine = ev.some(e => isMine(teamById[e.team]));
        return `<article class="pg-card${mine ? " mine" : ""}"><div class="pg-head pg-nfl"><span class="pg-teams">${esc(g.away)} <span class="pg-at">@</span> ${esc(g.home)}</span>
          <span class="pg-st ${st}">${st === "live" ? "Live" : st === "final" ? "Final" : when(g)}</span></div>${plays(ev)}${foot(ev.length)}</article>`;
      };
      const list = (label, xs) => xs.length ? `<p class="pg-quiet"><b>${label}:</b> ${xs.map(({ g }) => `${esc(g.away)} @ ${esc(g.home)}`).join(" · ")}</p>` : "";
      body = `<div class="pg-grid">${withPlays.map(card).join("")}${other.length ? card({ g: { away: "Other", home: "", date: 0 }, ev: other }).replace(" <span class=\"pg-at\">@</span> ", "") : ""}</div>
        ${list("No league big plays", quiet)}${list("Still to play", later)}`;
      if (!withPlays.length && !other.length) body = `<p class="pg-none">No big plays yet this week.</p>` + list("Still to play", later);
    }
    main.innerHTML = head + toggle + `<p class="pg-sum">Week ${wk.week} · ${all.length} big play${all.length === 1 ? "" : "s"} so far${wk.final ? "" : " · updates every minute during games"}</p>` + body;
  }

  // Monday-night math: once the only league starters left in a matchup are in games that haven't kicked off
  // (Sunday night into Monday), what each side needs and a win chance drawn from those players' own game logs.
  const NFL_GAME_MS = 4 * 3600e3;
  function mondayMath(g, wk) {
    if (wk.final || wk.week !== L.currentWeek || !L.isCurrent || g.sides.length !== 2 || g.winner !== "UNDECIDED" && g.winner) return null;
    const now = window.__now || Date.now();
    const kick = {};
    (D.nflGames || []).forEach(x => { if (!x.tbd && x.date) kick[x.home] = kick[x.away] = new Date(x.date).getTime(); });
    let playing = false, done = 0;
    const sides = g.sides.map(sd => {
      const left = [];
      sd.lineup.filter(p => p.slot !== "BE" && p.slot !== "IR").forEach(p => {
        const k = kick[p.team];
        if (k == null || now >= k + NFL_GAME_MS) done++;
        else if (now >= k) playing = true;
        else left.push(p);
      });
      return { sd, t: teamById[sd.team], left };
    });
    const nLeft = sides[0].left.length + sides[1].left.length;
    if (playing || !nLeft || nLeft > 6 || !done) return null;
    const logs = D.gameLogs || {};
    const avg = p => { const l = logs[p.id] || []; return l.length ? l.reduce((a, b) => a + b, 0) / l.length : (p.proj || 0); };
    const draw = p => {
      const l = logs[p.id] || [];
      if (l.length >= 3) return l[Math.floor(rnd() * l.length)];
      const m = p.proj != null ? p.proj : avg(p);
      let z = 0; for (let i = 0; i < 6; i++) z += rnd(); // ~normal
      return Math.max(-2, m + (z - 3) * m * 0.45);
    };
    // seeded, so the numbers don't wobble every time the scores refresh
    let seed = (g.id * 2654435761 + Math.round((g.sides[0].pts + g.sides[1].pts) * 100)) >>> 0;
    const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const N = 6000;
    let aWins = 0;
    const [A, B] = sides;
    for (let i = 0; i < N; i++) {
      let a = A.sd.pts, b = B.sd.pts;
      A.left.forEach(p => { a += draw(p); });
      B.left.forEach(p => { b += draw(p); });
      if (a > b) aWins++; else if (a === b) aWins += 0.5;
    }
    const pa = Math.round(aWins / N * 100), chance = [pa, 100 - pa];
    const behind = A.sd.pts < B.sd.pts ? A : B, ahead = behind === A ? B : A;
    const gap = Math.abs(A.sd.pts - B.sd.pts);
    const names = list => list.map(p => `${esc(p.name)} <span class="muted">${p.pos === "D/ST" ? "" : esc(p.pos) + ", "}avg ${avg(p).toFixed(1)}</span>`).join(" + ");
    let need;
    if (!behind.left.length) return `<div class="mm" data-mm><div class="mm-h"><span>🔒 Locked up</span></div>
      <p><b>${esc(behind.t.name)}</b> has nobody left to play, so <b>${esc(ahead.t.name)}</b> has this one won.</p></div>`;
    if (!ahead.left.length) {
      const target = gap + 0.01;
      const solo = behind.left.length === 1 ? (logs[behind.left[0].id] || []) : [];
      const hit = solo.filter(x => x >= target).length;
      need = `<b>${esc(behind.t.name)}</b> needs <b>${target.toFixed(2)}</b> from ${names(behind.left)}` +
        (solo.length >= 3 ? `. He's scored that in <b>${hit} of ${solo.length}</b> games this season.` : ".");
    } else if (gap < 0.005) {
      need = `Tied. ${names(A.left)} for ${esc(A.t.name)} vs ${names(B.left)} for ${esc(B.t.name)} decides it.`;
    } else {
      need = `<b>${esc(behind.t.name)}</b> is down <b>${gap.toFixed(2)}</b>: ${names(behind.left)} must outscore ${names(ahead.left)} by more than that.`;
    }
    return `<div class="mm" data-mm><div class="mm-h"><span>🧮 What it takes</span><span class="mm-wp">${esc(A.t.name)} <b>${chance[0]}%</b> · ${esc(B.t.name)} <b>${chance[1]}%</b></span></div>
      <p>${need}</p><p class="mm-note">Win chances: each player left gets a random game from his own scoring this season, ${N.toLocaleString()} times over.</p></div>`;
  }

  // This week in league history: notable moments from the same week of the other seasons
  function thisWeekStrip(w) {
    const rows = ((IDX.history.thisWeek || {})[w] || []).filter(r => r[0] !== L.season);
    if (!rows.length) return "";
    const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
    const LABEL = { high: ["highest score", "Top score that week"], low: ["lowest score", "Low score that week"],
      close: ["closest game", "Closest game that week"], blowout: ["biggest blowout", "Biggest win that week"], player: ["best player game", "Best player game that week"] };
    const ranked = (kind, r) => r === 1 ? `The ${LABEL[kind][0]} in league history` : r <= 10 ? `${ord(r)}-${LABEL[kind][0]} ever` : LABEL[kind][1];
    const v = x => x.toFixed(2);
    const line = r => {
      const [yr, wk, kind, team, own, val, other, gid, rank, tid] = r;
      const who = `<b>${esc(team)}</b>`;
      const text = kind === "high" ? `${who} put up <b>${v(val)}</b>` : kind === "low" ? `${who} managed just <b>${v(val)}</b>`
        : kind === "close" ? `${who} beat ${esc(other)} by <b>${v(val)}</b>` : kind === "blowout" ? `${who} beat ${esc(other)} by <b>${v(val)}</b>`
        : `<b>${esc(other)}</b> scored <b>${v(val)}</b> for ${esc(team)}`;
      const p = new URLSearchParams({ week: wk, game: gid, team: tid });
      if (yr !== IDX.current) p.set("season", yr);
      return `<a class="tw-card" href="#/matchups?${p}"><span class="kicker">${yr} · Week ${wk}</span><span class="tw-text">${text}</span>
        <span class="team-mgr">${esc((own || []).map(memberName).join(" & "))} · ${rank <= 10 ? `<b class="tw-rank">${ranked(kind, rank)}</b>` : ranked(kind, rank)}</span></a>`;
    };
    rows.sort((a, b) => b[0] - a[0] || a[8] - b[8]);
    return `<section class="tw"><h2 class="tw-h">This week in league history</h2><div class="tw-strip">${rows.slice(0, 6).map(line).join("")}</div></section>`;
  }

  function renderMatchups() {
    if (state.sub === "bracket") return renderBracket();
    if (state.sub === "pickem") return renderPickem();
    if (state.sub === "watch") return renderWatch();
    if (state.sub === "plays") return renderPlays();
    const weeks = D.weeks.map(x => x.week);
    let w = parseInt(state.params.get("week"), 10);
    if (!weeks.includes(w)) w = L.over ? weeks[weeks.length - 1] : L.currentWeek;
    if (!weeks.includes(w)) w = weeks[weeks.length - 1];
    const wk = D.weeks.find(x => x.week === w);
    const open = state.params.get("game");
    const focusTeam = Number(state.params.get("team")) || null;   // set by Record book links
    const focusPlayer = state.params.get("player");
    const mineFirst = g => g.sides.some(s => isMine(teamById[s.team])) ? 0 : 1;
    const games = wk.games.slice().sort((a, b) => mineFirst(a) - mineFirst(b) || (a.tier === "WINNERS_BRACKET" ? 0 : 1) - (b.tier === "WINNERS_BRACKET" ? 0 : 1)).map(g => {
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
      return `<article class="game${g.tier && g.tier !== "NONE" && g.tier !== "WINNERS_BRACKET" ? " consolation" : ""}${g.sides.some(s => isMine(teamById[s.team])) ? " mine" : ""}">
        <button class="game-btn" data-game="${g.id}" aria-expanded="${isOpen}">${row(a)}${row(b)}
          ${isOpen ? wpBar : ""}${mondayMath(g, wk) || ""}<div class="game-foot"><span>${tier ? tier + " · " : ""}${liveG ? "In progress" : "Final"}</span><span>${isOpen ? "Hide box score ↑" : "Box score ↓"}</span></div>
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
      ${feedPanel(w)}
      ${thisWeekStrip(w)}
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


  // ---------------------------------------------------------------- weekly pick'em
  // Picks live on the live worker. It enforces the lock (first NFL kickoff of the week), hides everyone's
  // picks until then, and checks each person's 4-digit PIN (set the first time they pick).
  const PK = { data: null, sel: {}, member: store.get("pk-member", ""), pin: store.get("pk-pin", ""), ready: false, msg: "", err: false, loading: false };

  const pkApi = (path, body) => fetch(LIVE_API_BASE() + path, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" }
    : { cache: "no-store" }).then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok && !j.error) j.error = "Something went wrong (" + r.status + ")."; return j; });
  function LIVE_API_BASE() { return ((window.LEAGUE_CONFIG || {}).liveApi || "").replace(/\/$/, ""); }

  function pkMembers() {
    const cur = window.LEAGUE_DATA[IDX.current];
    const ids = [...new Set(((cur || D).teams || []).flatMap(t => t.owners || []))];
    return ids.map(id => ({ id, name: memberName(id) })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async function renderPickem() {
    const head = (title, sub) => `<div class="section-head"><div><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ""}</div></div>${subnav("matchups", MATCHUP_TABS, "pickem")}`;
    if (state.season !== IDX.current) {
      main.innerHTML = head("Pick'em", "") + `<div class="empty">Pick'em started in ${IDX.current}. <a href="#/matchups/pickem">Go to this season's pick'em</a></div>`;
      return;
    }
    if (!LIVE_API_BASE()) { main.innerHTML = head("Pick'em", "") + '<div class="empty">Pick\'em needs the live worker, which isn\'t set up.</div>'; return; }
    if (!PK.data || Date.now() - (PK.at || 0) > 60000) {
      if (!PK.data) main.innerHTML = head("Pick'em", "") + '<div class="empty">Loading pick\'em…</div>';
      PK.data = await pkApi("/pickem");
      PK.at = Date.now();
      if (state.tab !== "matchups" || state.sub !== "pickem") return;
    }
    pickemView();
  }

  function pickemView() {
    const P = PK.data;
    const head = (title, sub) => `<div class="section-head"><div><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ""}</div></div>${subnav("matchups", MATCHUP_TABS, "pickem")}`;
    if (!P || P.error) { main.innerHTML = head("Pick'em", "") + `<div class="empty">${esc((P && P.error) || "Couldn't load pick'em.")} <button type="button" class="linkbtn" data-pk="reload">Try again</button></div>`; return; }
    const cur = window.LEAGUE_DATA[IDX.current];
    const tb = id => (cur.teams.find(t => t.id === id) || { name: "Team " + id, logo: "", manager: "" });
    const lock = P.lockAt ? new Date(P.lockAt) : null;
    const lockText = lock ? lock.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    const members = pkMembers();
    const nameOf = id => (members.find(m => m.id === id) || { name: memberName(id) }).name;

    // results: who won each game (final), or who's ahead (live)
    const result = (week, gid) => {
      const wk = cur.weeks.find(w => w.week === Number(week));
      const g = wk && wk.games.find(x => String(x.id) === String(gid));
      if (!g || g.sides.length !== 2) return null;
      const [a, b] = g.sides;
      if (g.winner === "HOME") return { team: a.team, final: true };
      if (g.winner === "AWAY") return { team: b.team, final: true };
      if (wk.final) return { team: null, final: true }; // tie
      if (a.pts === b.pts) return null;
      return { team: a.pts > b.pts ? a.team : b.team, final: false };
    };

    // season leaderboard from every locked week
    const board = {};
    const weekBest = {};
    Object.entries(P.weeks || {}).forEach(([w, byMember]) => {
      Object.entries(byMember).forEach(([m, picks]) => {
        const row = board[m] = board[m] || { m, right: 0, decided: 0, made: 0, weeksWon: 0 };
        let right = 0;
        Object.entries(picks).forEach(([gid, team]) => {
          row.made++;
          const r = result(w, gid);
          if (r && r.final) { row.decided++; if (r.team === team) { row.right++; right++; } }
        });
        (weekBest[w] = weekBest[w] || []).push({ m, right });
      });
    });
    Object.entries(weekBest).forEach(([w, rows]) => {
      const wk = cur.weeks.find(x => x.week === Number(w));
      if (!wk || !wk.final) return;
      const top = Math.max(...rows.map(r => r.right));
      if (top > 0) rows.filter(r => r.right === top).forEach(r => board[r.m].weeksWon++);
    });
    const leaders = Object.values(board).sort((a, b) => b.right - a.right || b.weeksWon - a.weeksWon || a.decided - b.decided);
    const leaderboard = leaders.length ? section("Season leaderboard", "One point per correct pick, counted once each game is final.", table([
      { label: "Picker", cell: r => `<b>${esc(nameOf(r.m))}</b>` },
      { label: "Correct", num: 1, cell: r => `${r.right}–${r.decided - r.right}` },
      { label: "Hit rate", num: 1, cell: r => (r.decided ? (100 * r.right / r.decided).toFixed(0) + "%" : "—") },
      { label: "Weeks won", num: 1, cell: r => r.weeksWon },
    ], leaders)) : "";

    let body = "";
    if (P.open) {
      const sub = `Open · locks <b>${esc(lockText)}</b> at the week's first kickoff. Pick a winner for every matchup; you can change picks until the lock. Nobody sees anyone's picks until then.`;
      const who = `<div class="panel pk-who">
        <label class="field">Who are you? <select id="pk-member"><option value="">Choose your name</option>${members.map(m => `<option value="${esc(m.id)}"${m.id === PK.member ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</select></label>
        <label class="field">PIN <input id="pk-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="4" pattern="[0-9]*" placeholder="4 digits" value="${esc(PK.pin)}"></label>
        <label class="field pk-remember"><input id="pk-remember" type="checkbox"${store.get("pk-pin", "") ? " checked" : ""}> Remember me on this device</label>
        <button type="button" class="cta" data-pk="continue">${PK.ready ? "Switch" : "Continue"}</button>
        <p class="note">First time? The PIN you enter becomes yours for the season, so nobody else can pick for you.</p></div>`;
      let games = "";
      if (PK.ready) {
        const n = Object.keys(PK.sel).length;
        games = `<div class="pk-games">${P.games.map((g, i) => `<div class="pk-game" role="group" aria-label="Matchup ${i + 1}"><div class="pk-game-h">Matchup ${i + 1}</div>${[g.away, g.home].map(tid => {
          const t = tb(tid), on = PK.sel[g.id] === tid;
          return `<button type="button" class="pk-team${on ? " on" : ""}" data-pk-game="${g.id}" data-pk-team="${tid}" aria-pressed="${on}">${logo(t)}<span><b>${esc(t.name)}</b><span class="team-mgr">${esc(t.manager)} · ${record(t)}</span></span></button>`;
        }).join('<span class="pk-vs">vs</span>')}</div>`).join("")}</div>
          <div class="pk-save"><button type="button" class="cta" data-pk="save">Save picks (${n} of ${P.games.length})</button></div>`;
      }
      const msg = PK.msg ? `<p class="note${PK.err ? " live" : ""}">${esc(PK.msg)}</p>` : "";
      const inList = (P.submitted || []).map(nameOf).sort();
      const subm = `<p class="note">Picks in (${inList.length} of ${members.length}): ${inList.length ? esc(inList.join(", ")) : "nobody yet"}</p>`;
      body = head(`Week ${P.week} pick'em`, sub) + who + msg + games + subm + leaderboard;
    } else {
      const picks = (P.weeks || {})[P.week] || {};
      const pickers = Object.keys(picks).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
      const wk = cur.weeks.find(w => w.week === P.week);
      const status = wk && wk.final ? "Final" : "Locked · games in progress";
      let grid = '<div class="empty">Nobody made picks this week.</div>';
      if (pickers.length) {
        const rows = pickers.map(m => {
          let right = 0;
          const cells = P.games.map(g => {
            const t = picks[m][g.id], r = result(P.week, g.id);
            const cls = !t || !r ? "" : r.team === t ? (r.final ? "right" : "ahead") : r.team == null ? "" : (r.final ? "wrong" : "behind");
            if (r && r.final && r.team === t) right++;
            return `<td class="pk-cell ${cls}" title="${t ? esc(tb(t).name) : "no pick"}">${t ? logo(tb(t)) : "—"}</td>`;
          }).join("");
          return `<tr><th>${esc(nameOf(m))}</th>${cells}<td class="n"><b>${right}</b></td></tr>`;
        }).join("");
        const heads = P.games.map(g => `<th title="${esc(tb(g.away).name)} vs ${esc(tb(g.home).name)}">${logo(tb(g.away))}<span class="muted">v</span>${logo(tb(g.home))}</th>`).join("");
        grid = `<div class="sg-wrap"><table class="pk-grid"><thead><tr><th></th>${heads}<th class="n">Right</th></tr></thead><tbody>${rows}</tbody></table></div>
          <p class="note">Green = right, red = wrong; lighter shades mean that pick is currently ahead or behind in a live game.</p>`;
      }
      const next = P.lockAt && Date.now() >= P.lockAt ? " Next week's picks open early Wednesday morning, once this week is final." : "";
      body = head(`Week ${P.week} pick'em`, `${status}.${next}`) + section("This week's picks", "", grid) + leaderboard;
    }
    main.innerHTML = body;
  }

  async function pkContinue() {
    const member = document.getElementById("pk-member").value;
    const pin = document.getElementById("pk-pin").value.trim();
    const remember = document.getElementById("pk-remember").checked;
    if (!member) { PK.msg = "Choose your name first."; PK.err = true; return pickemView(); }
    if (!/^\d{4}$/.test(pin)) { PK.msg = "Enter a 4-digit PIN."; PK.err = true; return pickemView(); }
    const r = await pkApi("/pickem/mine", { member, pin });
    if (r.error) { PK.msg = r.error; PK.err = true; PK.ready = false; return pickemView(); }
    PK.member = member; PK.pin = pin; PK.ready = true; PK.err = false;
    PK.sel = {};
    Object.entries(r.picks || {}).forEach(([g, t]) => { PK.sel[g] = Number(t); });
    PK.msg = r.newPin ? "Welcome! Your PIN will be saved with your first picks." : Object.keys(PK.sel).length ? "Your saved picks are loaded. Change anything before the lock." : "";
    store.set("pk-member", member);
    store.set("pk-pin", remember ? pin : "");
    pickemView();
  }

  async function pkSave() {
    const r = await pkApi("/pickem/submit", { member: PK.member, pin: PK.pin, picks: PK.sel });
    if (r.error) { PK.msg = r.error; PK.err = true; return pickemView(); }
    PK.msg = `Saved ${r.count} of ${r.of} picks. You can change them until the lock.`;
    PK.err = false;
    PK.data = await pkApi("/pickem");
    PK.at = Date.now();
    pickemView();
  }

  main.addEventListener("click", e => {
    const t = e.target.closest("[data-pk-team]");
    if (t) {
      PK.sel[t.dataset.pkGame] = Number(t.dataset.pkTeam);
      PK.msg = "";
      t.closest(".pk-game").querySelectorAll(".pk-team").forEach(b => { const on = b === t; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
      const save = main.querySelector('[data-pk="save"]');
      if (save) save.textContent = `Save picks (${Object.keys(PK.sel).length} of ${PK.data.games.length})`;
      return;
    }
    const a = e.target.closest("[data-pk]");
    if (!a) return;
    if (a.dataset.pk === "continue") pkContinue();
    if (a.dataset.pk === "save") pkSave();
    if (a.dataset.pk === "reload") { PK.data = null; renderPickem(); }
  });

  // ---------------------------------------------------------------- insights
  function table(cols, rows) {
    return `<div class="table-wrap"><table class="tbl"><thead><tr>${cols.map(c => `<th class="${c.num ? "n" : ""}">${c.label}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(r => `<tr>${cols.map((c, i) => `<td class="${c.num ? "n" : ""}${i === 0 ? " lead" : ""}${c.wide ? " wide" : ""}" data-label="${c.label}">${c.cell(r)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  const teamCell = t => `<span class="tcell${isMine(t) ? " mine" : ""}">${logo(t)}<span><span class="tname">${esc(t.name)}</span><span class="team-mgr">${esc(t.manager)}</span></span></span>`;
  const barCell = (v, cls) => `<span class="pbar"><span class="pbar-fill ${cls || ""}" style="width:${Math.min(100, v || 0)}%"></span><span class="pbar-v">${pct(v)}</span></span>`;
  const signedPts = (n, goodHigh) => `<b class="${(goodHigh ? n > 0.05 : n < -0.05) ? "pos" : (goodHigh ? n < -0.05 : n > 0.05) ? "neg" : ""}">${signed(n)}</b>`;
  const tname = id => (teamById[id] || { name: "Team " + id }).name;
  const poss = name => name + (/s$/i.test(name.trim()) ? "’" : "’s"); // Avengers' / Club's
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
    t.push(["luck", "Luck"], ["close", "Close games"]);
    if (D.teams.some(x => x.form)) t.push(["form", "Hot & cold"]);
    t.push(["schedule", "Schedule"]);
    if (D.scheduleSwap && D.scheduleSwap.weeks) t.push(["swap", "Schedule swap"]);
    if (D.rulesLab && D.rulesLab.weeks) t.push(["rules", "Rules lab"]);
    if (D.teams.some(x => x.vsProj)) t.push(["projection", "Vs. projection"]);
    if (D.teams.some(x => x.byeCrunch && x.byeCrunch.length)) t.push(["byes", "Byes ahead"]);
    t.push(["efficiency", "Efficiency"]);
    if (D.draft) t.push(["draft", "Draft"]);
    if (D.draft && D.draft.redraft) t.push(["redraft", "Redraft"]);
    t.push(["players", "Player history"]);
    return t;
  }

  const INSIGHTS = {
    players() {
      const pid = state.params.get("player") || "";
      setTimeout(() => fillPlayerHistory(main.querySelector(".ph-box"), pid), 0);
      return section("Player history", { short: "Every league team a player has been on, all seasons.", full: "Pick any player who has been on a league roster: every team that had him in any season, how he got there (drafted with the pick, traded for, picked up), when he left (dropped, traded away) and the points he scored in that team's starting lineup (bench points shown separately). Covers every season, whichever season is picked at the top." },
        `<label class="field ph-pick">Player <input id="ph-search" list="ph-list" type="search" placeholder="Type a name" autocomplete="off"></label><datalist id="ph-list"></datalist><div class="ph-box"><div class="empty">Loading…</div></div>`);
    },

    rules() {
      const R = D.rulesLab;
      const RULE_INFO = {
        half: "Standard ESPN scoring plus 0.5 per catch: 25 passing yards and 10 rushing/receiving yards per point, −2 per interception or lost fumble, no points for completions, no long-TD bonuses, field goals 3/4/5 by distance.",
        ppr: "Standard ESPN scoring plus 1 per catch: 25 passing yards and 10 rushing/receiving yards per point, −2 per interception or lost fumble, no points for completions, no long-TD bonuses, field goals 3/4/5 by distance.",
        standard: "Standard ESPN scoring, no points per catch: 25 passing yards and 10 rushing/receiving yards per point, −2 per interception or lost fumble, no points for completions, no long-TD bonuses, field goals 3/4/5 by distance.",
        median: "Your league's scoring, plus a second result every week against the league's median score: finish in the top half for an extra win, the bottom half for an extra loss.",
        bestball: "Your league's scoring, but every team's best possible lineup from its roster counts automatically each week, so start/sit decisions don't matter.",
      };
      const vers = R.versions.filter(v => v.key !== "actual" && RULE_INFO[v.key]);
      const asked = state.params.get("rule");
      const saved = store.get("rule", "half");
      const key = vers.some(v => v.key === asked) ? asked : vers.some(v => v.key === saved) ? saved : "half";
      if (asked) store.set("rule", key);
      const A = R.versions.find(v => v.key === "actual"), V = R.versions.find(v => v.key === key);
      const pctOf = r => (r[0] + r[2] / 2) / Math.max(1, r[0] + r[1] + r[2]);
      const ranks = ver => Object.fromEntries(Object.keys(ver.teams).sort((a, b) => pctOf(ver.teams[b]) - pctOf(ver.teams[a]) || ver.teams[b][3] - ver.teams[a][3]).map((id, i) => [id, i + 1]));
      const ra = ranks(A), rv = ranks(V), cut = L.playoffTeams || 0;
      const rec = r => `${r[0]}–${r[1]}${r[2] ? "–" + r[2] : ""}`;
      const rows = Object.keys(V.teams).filter(id => teamById[id]).sort((a, b) => rv[a] - rv[b]).map(id => ({ id, t: teamById[id], a: A.teams[id], v: V.teams[id], ra: ra[id], rv: rv[id] }));
      const move = r => { const d = r.ra - r.rv; return d ? `<span class="rl-move ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"}${Math.abs(d)}</span>` : `<span class="rl-move">–</span>`; };
      const po = r => !cut ? "" : r.rv <= cut && r.ra > cut ? '<span class="badge new">Now in</span>' : r.rv > cut && r.ra <= cut ? '<span class="badge cold">Now out</span>' : r.rv <= cut ? '<span class="badge">In</span>' : "";
      const winDiff = r => { const d = (r.v[0] + r.v[2] / 2) - (r.a[0] + r.a[2] / 2); return d; };
      const toggle = `<nav class="pg-by rl-by" aria-label="Rules to compare">${vers.map(v => `<a href="${href("insights", { rule: v.key }, "rules")}" class="${v.key === key ? "active" : ""}"${v.key === key ? ' aria-current="true"' : ""}>${esc(v.name)}</a>`).join("")}</nav>`;
      const cols = [
        { label: "Team", cell: r => teamCell(r.t) },
        { label: "Rank", num: 1, cell: r => `<b>#${r.rv}</b> ${move(r)}` },
        { label: "Your rules", num: 1, cell: r => `${rec(r.a)} <span class="muted">#${r.ra}</span>` },
        { label: esc(V.name), num: 1, cell: r => `<b>${rec(r.v)}</b>` },
      ];
      const wd = d => `<b class="${d > 0 ? "pos" : d < 0 ? "neg" : ""}">${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d) % 1 ? Math.abs(d).toFixed(1) : Math.abs(d)}</b>`;
      if (key !== "median") cols.push({ label: "Wins", num: 1, cell: r => wd(winDiff(r)) });
      cols.push({ label: "Points", num: 1, cell: r => Math.round(r.v[3]).toLocaleString() });
      if (cut) cols.push({ label: "Playoffs", num: 1, cell: po });
      const swingers = rows.filter(r => r.ra !== r.rv).sort((x, y) => Math.abs(y.ra - y.rv) - Math.abs(x.ra - x.rv));
      const headline = !swingers.length ? "Same order as the real standings." :
        swingers.slice(0, 2).map(r => `<b>${esc(r.t.name)}</b> ${r.rv < r.ra ? "climbs" : "drops"} from #${r.ra} to #${r.rv}`).join("; ") + ".";
      // how much each position is worth under your scoring vs the comparison
      const P = R.positions, order = ["QB", "RB", "WR", "TE", "K", "D/ST"].filter(p => P[p]);
      const cmp = ["half", "ppr", "standard"].includes(key) ? key : "half";
      const cmpName = R.versions.find(v => v.key === cmp).name;
      const tot = k => order.reduce((s, p) => s + (P[p][k] || 0), 0);
      const ta = tot("actual"), tc = tot(cmp);
      const posRows = order.map(p => ({ p, a: P[p].actual, c: P[p][cmp], sa: P[p].actual / ta * 100, sc: P[p][cmp] / tc * 100 }));
      const posTable = table([
        { label: "Position", cell: r => `<span class="slot ${esc(r.p)}">${esc(r.p)}</span>` },
        { label: "Your scoring", num: 1, cell: r => `${Math.round(r.a).toLocaleString()} <span class="muted">${r.sa.toFixed(0)}%</span>` },
        { label: esc(cmpName), num: 1, cell: r => `${Math.round(r.c).toLocaleString()} <span class="muted">${r.sc.toFixed(0)}%</span>` },
        { label: "Share change", num: 1, cell: r => signedPts(r.sa - r.sc, true).replace(/(\d)<\/b>/, "$1%</b>") },
      ], posRows);
      return section("Rules lab", { short: `This season's standings under other rules, same lineups (${R.weeks} completed weeks).`, full: `Every team's regular-season record (${R.weeks} completed weeks) if the league used different rules, with the exact lineups each team started and each player's real stats rescored. Defenses keep your league's rules in every version. Ties in the order go to points.` },
          `${toggle}<p class="rl-desc">${RULE_INFO[key]}</p><p class="rl-head">${headline}</p>${table(cols, rows)}`) +
        section("What your scoring rewards", { short: `Points started by position: your league vs. ${cmpName}.`, full: `Total points every team started at each position this season under your league's scoring and under ${cmpName}, with each position's share of all points started. A positive share change means your rules make that position matter more than ${cmpName} would.` }, posTable);
    },

    redraft() {
      const dr = D.draft, R = dr.redraft;
      const hr = Object.fromEntries(R.picks.map(x => [x.pick, x]));
      const atPick = Object.fromEntries(R.board.map(c => [c.at, c]));
      const size = L.size || 12, sofar = L.over ? "" : " so far";
      const rp = n => `R${Math.ceil(n / size)}.${((n - 1) % size) + 1}`;
      const nth = n => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
      const where = c => c.pick ? `went ${nth(c.pick)} to ${esc(tname(c.team))}` : "went undrafted";
      const mv = (from, to) => { const d = from - to; return d > 0 ? `<b class="pos">▲${d}</b>` : d < 0 ? `<b class="neg">▼${-d}</b>` : "–"; };
      const line = (no, pos, name, sub, v) => `<div class="pick"><span class="pick-no">${no}</span><span class="slot ${esc(pos)}">${esc(pos)}</span>
        <span class="pick-name"><b>${esc(name)}</b>${sub}</span><span class="pick-v">${v}</span></div>`;
      const boardLine = c => line(rp(c.at), c.pos, c.name, `<span class="team-mgr">${esc(c.nfl)} · ${c.pts.toFixed(1)} pts · ${where(c)}</span>`,
        c.pick ? mv(c.pick, c.at) : '<span class="badge hot">Undrafted</span>');
      if (!state.redraftRounds) state.redraftRounds = 2;
      const shown = R.board.filter(c => c.at <= state.redraftRounds * size);
      const more = R.board.length > shown.length ? `<button type="button" class="more-btn" id="redraft-more">Show more rounds</button>` : "";
      // per team: each real pick, where it goes now, and who the redraft puts in that slot
      const teams = Object.keys(dr.teams).concat(dr.picks.map(p => String(p.team))).filter((id, i, a) => a.indexOf(id) === i)
        .map(id => teamById[id]).filter(Boolean).sort((a, b) => a.standing - b.standing);
      if (!state.draftTeam || !teams.some(t => String(t.id) === state.draftTeam)) state.draftTeam = String((myTeam() || teams[0] || {}).id || "");
      const teamLine = p => {
        const no = `R${p.round}.${p.roundPick}`, h = hr[p.pick];
        if (!h) return line(no, p.pos, p.name, `<span class="team-mgr">${p.pts.toFixed(1)} pts${sofar} · kickers and defenses aren't redrafted</span>`, "");
        const alt = atPick[p.pick];
        const now = h.at ? `now goes ${rp(h.at)}` : "wouldn't be drafted";
        const should = alt && alt.id !== p.id ? `<span class="team-mgr rd-alt">Redraft pick here: <b>${esc(alt.name)}</b> (${esc(alt.pos)}, ${where(alt)})</span>` : `<span class="team-mgr rd-alt">Still the pick here</span>`;
        return line(no, p.pos, p.name, `<span class="team-mgr">${p.pts.toFixed(1)} pts${sofar} · ${now}</span>${should}`, h.at ? mv(p.pick, h.at) : '<b class="neg">Out</b>');
      };
      const mine = dr.picks.filter(p => String(p.team) === state.draftTeam);
      const last = dr.picks.length + 1;
      const graded = dr.picks.filter(p => hr[p.pick]).map(p => Object.assign({ to: hr[p.pick].at || last }, p));
      const climbs = graded.slice().sort((a, b) => (b.pick - b.to) - (a.pick - a.to)).slice(0, 6);
      const falls = graded.filter(p => p.round <= 6).sort((a, b) => (b.to - b.pick) - (a.to - a.pick)).slice(0, 6);
      const moveLine = p => line(`R${p.round}.${p.roundPick}`, p.pos, p.name, `<span class="team-mgr">${esc(tname(p.team))} · ${p.to < last ? "now " + rp(p.to) : "wouldn't be drafted"}</span>`, mv(p.pick, p.to));
      const gems = R.board.filter(c => !c.pick).slice(0, 6);
      return section("Hindsight redraft", { short: `The draft redone knowing every player's points${sofar}.`, full: `The draft redone knowing how the season went${sofar}: each pick goes to the most valuable player left, drafted or not. Value is points${sofar} above a replacement-level player at the same position (the best one left once every team's starting lineup is filled), so QBs don't go first just because QBs score the most. ▲/▼ is how far a player moves from his real draft spot. Kickers and defenses keep their real picks and aren't redrafted, and the redraft ranks players only; it doesn't build balanced rosters.` },
          `<div class="picks">${shown.map(boardLine).join("")}</div>${more}`) +
        section("Each team's picks, redone", "", `<label class="field">Team <select id="draft-team">${teams.map(t => `<option value="${t.id}"${String(t.id) === state.draftTeam ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>
          <div class="picks" style="margin-top:10px">${mine.map(teamLine).join("")}</div>`) +
        `<div class="two-col">${section("Biggest climbs", "Picks that would go much earlier now.", `<div class="picks">${climbs.map(moveLine).join("")}</div>`)}
          ${section("Biggest falls", "Rounds 1–6 picks that would go much later.", `<div class="picks">${falls.map(moveLine).join("")}</div>`)}</div>` +
        (gems.length ? section("Missed by everyone", "Undrafted players the redraft takes.", `<div class="picks">${gems.map(boardLine).join("")}</div>`) : "");
    },

    byes() {
      // only weeks where some team is short (byes are over by the playoffs)
      const weeks = D.teams[0].byeCrunch.map(x => x.w).filter(w => D.teams.some(t => t.byeCrunch.some(x => x.w === w && (x.lost >= 0.5 || x.need.length))));
      if (!weeks.length) return section("Byes ahead", "", `<div class="empty">No bye weeks left this season.</div>`);
      const rows = D.teams.map(t => ({ t, total: t.byeCrunch.reduce((s, x) => s + x.lost, 0) })).sort((a, b) => b.total - a.total);
      const max = Math.max(1, ...D.teams.flatMap(t => t.byeCrunch.map(x => x.lost)));
      const who = x => x.out.map(p => `${p.name} (${p.pos}${p.bye ? ", bye" : ", out"})`).join(", ");
      const cell = (t, x) => {
        const tip = `${t.name}, week ${x.w}: ` + (x.lost >= 0.5 ? `−${x.lost.toFixed(1)} pts. ${who(x)}` : "full strength") + (x.need.length ? `. No ${x.need.join(" or ")} that week` : "");
        return `<div class="bc-cell" style="--a:${(x.lost / max).toFixed(2)}" title="${esc(tip)}">${x.lost >= 0.5 ? "−" + x.lost.toFixed(0) : ""}${x.need.length ? `<i>${esc(x.need.join("/"))}</i>` : ""}</div>`;
      };
      const grid = `<div class="bc-wrap"><div class="bc-grid" style="--n:${weeks.length}">
        <div class="bc-h bc-first">Team</div>${weeks.map(w => `<div class="bc-h">${w > L.regularSeasonWeeks ? "PO" : "Wk"} ${w}</div>`).join("")}<div class="bc-h">Total</div>
        ${rows.map(({ t, total }) => `<div class="bc-team bc-first${isMine(t) ? " mine" : ""}">${logo(t)}<span class="tname">${esc(t.name)}</span></div>${t.byeCrunch.filter(x => weeks.includes(x.w)).map(x => cell(t, x)).join("")}<div class="bc-tot">${total >= 0.5 ? "−" + total.toFixed(0) : "0"}</div>`).join("")}
      </div></div>`;
      const worst = D.teams.flatMap(t => t.byeCrunch.map(x => Object.assign({ t }, x))).filter(x => x.lost >= 3 || x.need.length)
        .sort((a, b) => b.lost - a.lost).slice(0, 10);
      const line = x => `<div class="rec"><span class="rec-v">${x.lost >= 0.5 ? "−" + x.lost.toFixed(1) : "0"}</span><span class="rec-who">${logo(x.t)}<span><b>${esc(x.t.name)}</b>
        <span class="team-mgr">Week ${x.w}: ${esc(who(x))}${x.need.length ? `${x.out.length ? " · " : ""}no ${esc(x.need.join(" or "))}` : ""}</span></span></span></div>`;
      return section("Byes ahead", { short: "Projected points each team's best lineup loses to byes in the weeks left.", full: "For every week still to play: how many projected points each team's best lineup loses compared with its full-strength lineup, because starters are on bye (or ESPN expects them to miss the game). Bench depth counts: if a backup fills in well, little is lost. K or D/ST means every kicker or defense on the roster is on bye that week, so one has to be picked up. Tap or hover a cell for who's missing." }, grid) +
        (worst.length ? section("Toughest weeks", "The biggest holes coming up.", `<div class="rec-card wrap">${worst.map(line).join("")}</div>`) : "");
    },

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

    close() {
      const LIMIT = 10;
      const rs = L.regularSeasonWeeks;
      const rec = {};
      D.teams.forEach(t => { rec[t.id] = { t, w: 0, l: 0, games: 0, bestW: null, worstL: null }; });
      D.weeks.filter(w => w.final && w.week <= rs).forEach(w => w.games.forEach(g => {
        if (g.sides.length !== 2) return;
        g.sides.forEach((me, i) => {
          const opp = g.sides[1 - i], r = rec[me.team];
          if (!r) return;
          r.games++;
          const m = me.pts - opp.pts;
          if (Math.abs(m) >= LIMIT || m === 0) return;
          const game = { m: Math.abs(m), week: w.week, opp: opp.team, game: g.id };
          if (m > 0) { r.w++; if (!r.bestW || game.m < r.bestW.m) r.bestW = game; }
          else { r.l++; if (!r.worstL || game.m < r.worstL.m) r.worstL = game; }
        });
      }));
      const rows = Object.values(rec).filter(r => r.games).sort((a, b) => (b.w - b.l) - (a.w - a.l) || b.w - a.w);
      const total = rows.reduce((n, r) => n + r.w, 0);
      const gameLink = (g, verb) => g ? `${verb} by <b>${g.m.toFixed(2)}</b> <span class="muted">vs ${esc(tname(g.opp))}, <a class="wk-link" href="${href("matchups", { week: g.week, game: g.game })}">wk ${g.week}</a></span>` : '<span class="muted">—</span>';
      return section("Close games", { short: `Records in games decided by under ${LIMIT} points.`, full: `Every regular-season game decided by less than ${LIMIT} points (${total} so far this season). These usually come down to one play, so a team well above or below .500 here has been getting, or missing, the breaks.` }, table([
        { label: "Team", cell: r => teamCell(r.t) },
        { label: "Close record", num: 1, cell: r => `<b>${r.w}–${r.l}</b>` },
        { label: "Of all games", num: 1, cell: r => `${r.w + r.l} of ${r.games}` },
        { label: "Closest win", wide: 1, cell: r => gameLink(r.bestW, "won") },
        { label: "Closest loss", wide: 1, cell: r => gameLink(r.worstL, "lost") },
      ], rows));
    },

    form() {
      const rows = D.teams.filter(t => t.form).sort((a, b) => b.form.diff - a.form.diff);
      const lc = rows.length ? rows[0].form.leagueChange : 0;
      const tag = d => d >= 8 ? '<span class="badge hot">Hot</span>' : d <= -8 ? '<span class="badge cold">Cold</span>' : '<span class="badge">Steady</span>';
      const wks = rows.length ? rows[0].form.weeks : [];
      return section("Hot & cold", { short: `Last ${wks.length} weeks vs. each team's season average.`, full: `Each team's average over the last ${wks.length} completed weeks (weeks ${wks.join(", ")}) compared with its season average. Scoring across the whole league moved ${signed(lc)} a week over that stretch (byes and injuries hit everyone), so <b>Trend</b> takes that out: it's how much better or worse a team is doing than the league's own swing.` }, table([
        { label: "Team", cell: teamCell },
        { label: `Last ${wks.length} weeks`, num: 1, cell: t => `<span class="muted">${t.form.lastPts.map(x => x.toFixed(0)).join(" · ")}</span>` },
        { label: "Recent avg", num: 1, cell: t => t.form.lastAvg.toFixed(1) },
        { label: "Season avg", num: 1, cell: t => t.form.seasonAvg.toFixed(1) },
        { label: "Trend", num: 1, cell: t => `${signedPts(t.form.diff, true)} ${tag(t.form.diff)}` },
        { label: "Recent record", num: 1, cell: t => `${t.form.lastW}–${t.form.lastL}` },
      ], rows));
    },

    projection() {
      const rows = D.teams.filter(t => t.vsProj).sort((a, b) => b.vsProj.diff - a.vsProj.diff);
      return section("Vs. projection", { short: "Points scored vs. what ESPN projected for the lineup each week.", full: "Each week, the points a team's starters actually scored compared with ESPN's pre-game projection for that same lineup. Positive means its players beat their projections; it's about how the players performed, not lineup choices (that's Efficiency) or opponents (that's Luck). Regular season." }, table([
        { label: "Team", cell: teamCell },
        { label: "Projected", num: 1, cell: t => t.vsProj.proj.toFixed(1) },
        { label: "Actual", num: 1, cell: t => t.vsProj.actual.toFixed(1) },
        { label: "Difference", num: 1, cell: t => signedPts(t.vsProj.diff, true) },
        { label: "Per week", num: 1, cell: t => signedPts(t.vsProj.perWeek, true) },
        { label: "Beat it", num: 1, cell: t => `${t.vsProj.beat} of ${t.vsProj.weeks} wks` },
        { label: "Best week", num: 1, cell: t => t.vsProj.best ? `${signed(t.vsProj.best[1])} <span class="muted">wk ${t.vsProj.best[0]}</span>` : "—" },
        { label: "Worst week", num: 1, cell: t => t.vsProj.worst ? `${signed(t.vsProj.worst[1])} <span class="muted">wk ${t.vsProj.worst[0]}</span>` : "—" },
      ], rows));
    },

    swap() {
      const S = D.scheduleSwap, G = S.grid;
      const rec = v => `${v[0]}–${v[1]}${v[2] ? "–" + v[2] : ""}`;
      const order = S.teams.map(id => teamById[id]).filter(Boolean).sort((a, b) => a.standing - b.standing);
      const ids = order.map(t => String(t.id));
      // per team: its best and worst possible schedule (record, luck and expected wins live on the Luck tab)
      const sum = order.map(t => {
        const row = G[t.id], cells = ids.map(b => ({ b, v: row[b] }));
        const best = cells.reduce((x, y) => (y.v[0] - y.v[1] > x.v[0] - x.v[1] ? y : x));
        const worst = cells.reduce((x, y) => (y.v[0] - y.v[1] < x.v[0] - x.v[1] ? y : x));
        return { t, best, worst };
      });
      const summary = table([
        { label: "Team", cell: r => teamCell(r.t) },
        { label: "Best schedule", num: 1, cell: r => `${rec(r.best.v)} <span class="muted">${r.best.b === String(r.t.id) ? "their own schedule" : "with " + esc(poss(tname(r.best.b)))}</span>` },
        { label: "Worst schedule", num: 1, cell: r => `${rec(r.worst.v)} <span class="muted">${r.worst.b === String(r.t.id) ? "their own schedule" : "with " + esc(poss(tname(r.worst.b)))}</span>` },
      ], sum);
      // full grid: rows = whose scores, columns = whose schedule
      const maxW = S.weeks;
      const heat = v => { const f = (v[0] + v[2] / 2) / maxW; return `background: color-mix(in srgb, var(--accent) ${Math.round(f * 55)}%, var(--surface));`; };
      const head = `<tr><th class="sg-corner">Scores ↓ · Schedule →</th>${order.map(t => `<th title="${esc(poss(t.name))} schedule">${logo(t)}<span>${esc(t.abbrev || initials(t.name))}</span></th>`).join("")}</tr>`;
      const body = order.map(a => `<tr><th class="sg-row">${logo(a)}<span>${esc(a.name)}</span></th>${order.map(b => {
        const v = G[a.id][b.id], self = a.id === b.id;
        return `<td class="${self ? "self" : ""}" style="${heat(v)}" title="${esc(a.name)} with ${esc(poss(b.name))} schedule: ${rec(v)}${self ? " (actual)" : ""}">${rec(v)}</td>`;
      }).join("")}</tr>`).join("");
      if (!state.swapTeam || !G[state.swapTeam]) state.swapTeam = String(order[0].id);
      const pickRow = ids.map(b => ({ b, v: G[state.swapTeam][b] })).sort((x, y) => (y.v[0] - y.v[1]) - (x.v[0] - x.v[1]));
      const picker = `<div class="sg-pick"><label class="field">Team <select id="swap-team">${order.map(t => `<option value="${t.id}"${String(t.id) === state.swapTeam ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select></label>
        <div class="picks" style="margin-top:10px">${pickRow.map(c => `<div class="pick"><span class="pick-no">${rec(c.v)}</span>${logo(teamById[c.b])}<span class="pick-name"><b>${esc(poss(tname(c.b)))} schedule</b>${c.b === state.swapTeam ? '<span class="team-mgr">actual record</span>' : ""}</span></div>`).join("")}</div></div>`;
      return section("Schedule swap", { short: "Each team's record with every other team's schedule.", full: `Each team's record if it had played every other team's schedule, using its real weekly scores (${S.weeks} completed regular-season weeks). When the other schedule had a game against this team, it plays that team instead. For actual records and luck, see the Luck tab.` }, summary) +
        section("Every schedule", "Rows are each team's scores; columns are whose schedule they play. The outlined cell is the real record. Greener means more wins.",
          `<div class="sg-wrap"><table class="swap-grid"><thead>${head}</thead><tbody>${body}</tbody></table></div>${picker}`);
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
  const TRADE_TABS = [["", "Trade history"], ["block", "Trade block"], ["ideas", "Trade ideas"], ["compare", "Compare players"]];

  function renderTrades() {
    if (state.sub === "block") return renderBlock();
    if (state.sub === "ideas") return renderTradeIdeas();
    if (state.sub === "compare") return renderCompare();
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
      ${subnav("trades", TRADE_TABS, "")}
      <div class="trades">${body || '<div class="empty">No trades this season.</div>'}</div>`;
  }

  // ---------------------------------------------------------------- trade ideas (matchmaker)
  // Pairs teams whose rosters fit: each has a spare player (beyond its starters) at a position where the other's
  // starter is weak, and the two spares are worth about the same rest-of-season. Both lineups get better.
  const TRADE_POS = ["QB", "RB", "WR", "TE"];
  function tradeIdeas(minGain = 10, tol = 0.25) {
    if (!L.isCurrent || L.over) return null;
    const spots = {};
    (D.settings.slots || []).forEach(x => { if (TRADE_POS.includes(x.slot)) spots[x.slot] = x.count; });
    const healthy = p => p.ros > 0 && p.injury !== "INJURY_RESERVE" && p.slot !== "IR";
    const depth = {};
    D.teams.forEach(t => {
      depth[t.id] = {};
      TRADE_POS.forEach(pos => {
        const list = t.roster.filter(p => p.pos === pos && healthy(p)).sort((a, b) => b.ros - a.ros);
        const n = spots[pos] || 1;
        depth[t.id][pos] = { weakest: list[n - 1] || null, weakestRos: list[n - 1] ? list[n - 1].ros : 0, spares: list.slice(n, n + 2) };
      });
    });
    const deals = [];
    for (const a of D.teams) for (const b of D.teams) {
      if (a.id >= b.id) continue;
      let best = null;
      for (const x of TRADE_POS) for (const y of TRADE_POS) {
        if (x === y) continue;
        for (const pa of depth[a.id][x].spares) for (const pb of depth[b.id][y].spares) {
          const gainB = pa.ros - depth[b.id][x].weakestRos, gainA = pb.ros - depth[a.id][y].weakestRos;
          if (gainA < minGain || gainB < minGain) continue;              // both starting lineups must improve
          if (Math.abs(pa.ros - pb.ros) > tol * Math.max(pa.ros, pb.ros)) continue; // roughly even value
          const score = Math.min(gainA, gainB);
          if (!best || score > best.score) best = { a, b, pa, pb, x, y, gainA, gainB, score,
            outA: depth[a.id][y].weakest, outB: depth[b.id][x].weakest };
        }
      }
      if (best) deals.push(best);
    }
    return deals.sort((p, q) => q.score - p.score);
  }
  function renderTradeIdeas() {
    const head = `<div class="section-head"><div><h1>Trade ideas</h1>${expl("Teams whose rosters fit, with a swap that makes both lineups better.", "For every pair of teams: one has a spare player (beyond its starters) at a position where the other team's weakest starter is much worse, and the other way around. The two players are worth about the same rest-of-season (ESPN's projected points, within 25%), and each one would beat the starter he replaces by 10+ points. Injured-reserve players aren't included. These are ideas, not verdicts: needs, byes and the playoff schedule still matter.")}</div></div>${subnav("trades", TRADE_TABS, "ideas")}`;
    const deals = tradeIdeas();
    if (!deals) { main.innerHTML = head + `<div class="empty">Trade ideas are for the current season, while trades are still open.</div>`; return; }
    const deadline = D.settings.tradeDeadline ? new Date(D.settings.tradeDeadline) : null;
    const closed = deadline && Date.now() > deadline.getTime();
    const pl = p => `<span class="slot ${esc(p.pos)}">${esc(p.pos)}</span> <b>${esc(p.name)}</b> <span class="muted">${esc(p.team)} · ${p.ros.toFixed(0)} ROS</span>`;
    const card = d => {
      const side = (t, gets, gain, out) => `<div class="ti-side${isMine(t) ? " mine" : ""}"><div class="mini-team">${logo(t)}<span><div>${esc(t.name)}</div><div class="team-mgr">${esc(t.manager)}</div></span></div>
        <div class="ti-gets">Gets ${pl(gets)}</div>
        <div class="team-mgr">Replaces ${out ? `${esc(out.name)} (${out.ros.toFixed(0)} ROS)` : "an empty spot"} · <b class="pos">+${gain.toFixed(0)}</b> ROS pts</div></div>`;
      return `<article class="ti-card">${side(d.a, d.pb, d.gainA, d.outA)}<div class="ti-swap" aria-hidden="true">⇄</div>${side(d.b, d.pa, d.gainB, d.outB)}
        <a class="ti-cmp wk-link" href="${href("trades", { a: d.pa.id, b: d.pb.id }, "compare")}">Compare these two ›</a></article>`;
    };
    const me = D.teams.find(t => isMine(t));
    // your own partners: a looser bar (5+ points each way, values within 35%) so there's usually something to look at
    const mine = me ? tradeIdeas(5, 0.35).filter(d => d.a === me || d.b === me).slice(0, 3) : [];
    const top = deals.slice(0, 8);
    main.innerHTML = head + (closed ? `<p class="note live">The trade deadline (${deadline.toLocaleDateString([], { month: "short", day: "numeric" })}) has passed; these are for fun.</p>` : deadline ? `<p class="note">Trade deadline: ${deadline.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}.</p>` : "") +
      (me ? section("Your best trade partners", "Same idea with a slightly looser bar: both lineups gain 5+ points.", mine.length ? `<div class="ti-list">${mine.map(card).join("")}</div>` : `<div class="empty">No clean one-for-one fits for your roster right now.${(() => {
        const spare = TRADE_POS.map(pos => {
          const n = ((D.settings.slots || []).find(x => x.slot === pos) || {}).count || 1;
          return me.roster.filter(p => p.pos === pos && p.ros > 0 && p.slot !== "IR" && p.injury !== "INJURY_RESERVE").sort((a, b) => b.ros - a.ros)[n];
        }).filter(Boolean).sort((a, b) => b.ros - a.ros).slice(0, 2);
        return spare.length ? ` Your best spare players (${spare.map(p => `${esc(p.name)}, ${p.ros.toFixed(0)} ROS`).join("; ")}) wouldn't start for the teams that need them, so a fair swap would take a 2-for-1 or a bigger name.` : "";
      })()}</div>`) : "") +
      section("Best fits in the league", me ? "" : "Tip: claim your team on My team to see your own best partners first.", top.length ? `<div class="ti-list">${top.map(card).join("")}</div>` : `<div class="empty">No clean fits right now.</div>`);
  }

  // ---------------------------------------------------------------- compare players
  // Any two players who've been on a league roster this season, side by side under the league's scoring. Weekly
  // points come from the box scores, so only weeks a player was on a league team are known.
  function seasonPlayers() {
    const m = {};
    D.weeks.forEach(w => w.games.forEach(g => g.sides.forEach(sd => sd.lineup.forEach(p => {
      const x = m[p.id] || (m[p.id] = { id: String(p.id), name: p.name, pos: p.pos, nfl: p.team, wk: {} });
      x.nfl = p.team;
      x.wk[w.week] = { pts: p.pts, team: sd.team, final: w.final };
    }))));
    D.teams.forEach(t => t.roster.forEach(r => { const x = m[r.id]; if (x) Object.assign(x, { owner: t.id, ros: r.ros, rosRank: r.rosRank, seasonPts: r.seasonPts, posRank: r.posRank, injury: r.injury }); }));
    return m;
  }
  async function renderCompare() {
    const head = `<div class="section-head"><div><h1>Compare players</h1>${expl("Two players side by side under this league's scoring.", `Any two players who've been on a league roster in ${L.season}, compared week by week with this league's scoring. Only weeks a player was on a league team are known (that's where the stats come from), and weeks he didn't play (bye, injury) are left out of the averages.`)}</div></div>${subnav("trades", TRADE_TABS, "compare")}`;
    const M = seasonPlayers();
    const ids = Object.keys(M);
    const label = x => `${x.name} · ${x.pos} · ${x.nfl}`;
    const a = M[state.params.get("a")], b = M[state.params.get("b")];
    const picker = (key, x) => `<label class="field cmp-field">${key === "a" ? "Player 1" : "Player 2"} <input type="search" class="cmp-in" data-cmp="${key}" list="cmp-list" placeholder="Type a name" autocomplete="off" value="${x ? esc(label(x)) : ""}"></label>`;
    const pickers = `<div class="cmp-pick">${picker("a", a)}<span class="cmp-vs">vs</span>${picker("b", b)}</div>
      <datalist id="cmp-list">${ids.map(id => M[id]).sort((p, q) => p.name.localeCompare(q.name)).map(x => `<option value="${esc(label(x))}"></option>`).join("")}</datalist>`;
    main.innerHTML = head + pickers + `<div class="cmp-body">${a && b ? '<div class="empty">Loading stats…</div>' : '<div class="empty">Pick two players to compare. Tip: tap a player in any box score and choose "Compare with…".</div>'}</div>`;
    main.querySelectorAll(".cmp-in").forEach(inp => inp.addEventListener("change", () => {
      const v = inp.value.trim().toLowerCase();
      const hit = ids.find(id => label(M[id]).toLowerCase() === v) || ids.find(id => M[id].name.toLowerCase() === v) || ids.find(id => M[id].name.toLowerCase().includes(v));
      if (!hit) return;
      const p = new URLSearchParams(state.params);
      p.set(inp.dataset.cmp, hit);
      if (state.season !== IDX.current) p.set("season", state.season); else p.delete("season");
      location.hash = href("trades", Object.fromEntries(p), "compare");
    }));
    if (!(a && b)) return;
    let ST = {};
    try { ST = await loadStats(L.season); } catch (_) { /* weeks without a stat line still show the box-score points */ }
    const weeks = D.weeks.filter(w => w.final).map(w => w.week);
    const played = (x, w) => x.wk[w] && (ST[w + "|" + x.id] || Math.abs(x.wk[w].pts) > 0.01);
    const sum = x => {
      const g = weeks.filter(w => played(x, w)).map(w => ({ w, pts: x.wk[w].pts }));
      const tot = g.reduce((n, r) => n + r.pts, 0);
      const best = g.reduce((m, r) => (!m || r.pts > m.pts ? r : m), null), worst = g.reduce((m, r) => (!m || r.pts < m.pts ? r : m), null);
      const last = g.slice(-3);
      return { g, n: g.length, tot, ppg: g.length ? tot / g.length : 0, best, worst, o15: g.filter(r => r.pts >= 15).length, o20: g.filter(r => r.pts >= 20).length,
        last3: last.length ? last.reduce((n, r) => n + r.pts, 0) / last.length : 0, tracked: weeks.filter(w => x.wk[w]).length };
    };
    const A = sum(a), B = sum(b);
    const owner = x => x.owner ? esc((teamById[x.owner] || {}).name || "") : "Free agent / not on a league team";
    const row = (lbl, va, vb, fmtv, hiGood = true) => {
      const better = va === vb || va == null || vb == null ? 0 : (va > vb) === hiGood ? 1 : 2;
      return `<tr><td class="${better === 1 ? "cmp-win" : ""}">${va == null ? "—" : fmtv(va)}</td><th>${lbl}</th><td class="${better === 2 ? "cmp-win" : ""}">${vb == null ? "—" : fmtv(vb)}</td></tr>`;
    };
    const f1 = v => v.toFixed(1), f0 = v => String(v);
    const cur = L.isCurrent && !L.over;
    const card = x => `<div class="cmp-card"><span class="slot ${esc(x.pos)}">${esc(x.pos)}</span><div style="min-width:0"><b>${esc(x.name)}</b><span class="team-mgr">${esc(x.nfl)}${x.injury ? " · " + esc(x.injury.replace(/_/g, " ").toLowerCase()) : ""} · ${owner(x)}</span></div></div>`;
    const table = `<table class="cmp-tbl"><thead><tr><th>${card(a)}</th><th></th><th>${card(b)}</th></tr></thead><tbody>
      ${row("Points per game", A.ppg, B.ppg, f1)}
      ${row("Last 3 games", A.n ? A.last3 : null, B.n ? B.last3 : null, f1)}
      ${row("Total points", A.tot, B.tot, f1)}
      ${row("Games", A.n, B.n, f0)}
      ${row("Best week", A.best ? A.best.pts : null, B.best ? B.best.pts : null, f1)}
      ${row("Worst week", A.worst ? A.worst.pts : null, B.worst ? B.worst.pts : null, f1)}
      ${row("15+ point games", A.o15, B.o15, f0)}
      ${row("20+ point games", A.o20, B.o20, f0)}
      ${cur ? row("Rest-of-season proj.", a.ros, b.ros, f1) : row("Season finish", a.posRank, b.posRank, v => a.pos === b.pos ? "#" + v : String(v), false)}
      ${cur ? row("ROS rank", a.rosRank, b.rosRank, v => "#" + v, false) : ""}
    </tbody></table>`;
    // week-by-week bars (two per week), missing weeks marked
    const all = weeks.flatMap(w => [a, b].map(x => played(x, w) ? x.wk[w].pts : 0));
    const max = Math.max(10, ...all), H = 150, bw = 9, gap = 6, W = weeks.length * (bw * 2 + gap) + 30;
    const bar = (x, w, i, off, cls) => {
      if (!played(x, w)) return `<text x="${30 + i * (bw * 2 + gap) + off + bw / 2}" y="${H - 4}" class="cmp-miss" text-anchor="middle">·</text>`;
      const v = Math.max(0, x.wk[w].pts), h = Math.max(1, v / max * (H - 20));
      return `<rect class="${cls}" x="${30 + i * (bw * 2 + gap) + off}" y="${H - h}" width="${bw}" height="${h}" rx="2"><title>${esc(x.name)}, week ${w}: ${x.wk[w].pts.toFixed(1)}</title></rect>`;
    };
    const ticks = [0, Math.round(max / 2), Math.round(max)].map(v => `<text x="24" y="${H - v / max * (H - 20) + 3}" text-anchor="end" class="cmp-axis">${v}</text><line x1="28" x2="${W}" y1="${H - v / max * (H - 20)}" y2="${H - v / max * (H - 20)}" class="cmp-grid"/>`).join("");
    const chart = `<div class="cmp-chart"><div class="cmp-legend"><span><i class="cmp-a"></i>${esc(a.name)}</span><span><i class="cmp-b"></i>${esc(b.name)}</span><span class="muted">· = not on a league roster or didn't play</span></div>
      <div class="cmp-scroll"><svg viewBox="0 0 ${W} ${H + 18}" width="${W}" height="${H + 18}" role="img" aria-label="Weekly points">${ticks}
      ${weeks.map((w, i) => bar(a, w, i, 0, "cmp-a") + bar(b, w, i, bw, "cmp-b") + `<text x="${30 + i * (bw * 2 + gap) + bw}" y="${H + 14}" text-anchor="middle" class="cmp-axis">${w}</text>`).join("")}</svg></div></div>`;
    const box = main.querySelector(".cmp-body");
    if (box) box.innerHTML = table + section("Week by week", "", chart);
  }

  // ---------------------------------------------------------------- trade block
  // Each team lists players it's shopping, positions it needs and a note (stored on the live worker; editing uses
  // the same name + PIN as pick'em). The page points out teams whose block and needs line up with each other.
  const TB = { data: null, at: 0, editing: false, msg: "", err: false };
  const BLOCK_POS = ["QB", "RB", "WR", "TE", "K", "D/ST"];

  async function renderBlock() {
    const head = `<div class="section-head"><div><h1>Trade block</h1>${expl("Who's on the block, who's untouchable, and who needs what.", "Every player's trade status comes straight from ESPN (On the block, Normal, Untouchable). Managers can also change statuses here and add the positions they're looking for plus a note; changes made here don't go back to ESPN, and if a player's status is later changed on ESPN, that wins. Possible fits are pairs of teams where one has what the other needs. Editing uses the same name and PIN as pick'em.")}</div></div>${subnav("trades", TRADE_TABS, "block")}`;
    if (state.season !== IDX.current) { main.innerHTML = head + `<div class="empty">The trade block is for the current season. <a href="#/trades/block">Go to ${IDX.current}</a></div>`; return; }
    if (!LIVE_API_BASE()) { main.innerHTML = head + '<div class="empty">The trade block needs the live worker, which isn\'t set up.</div>'; return; }
    if (!TB.data || Date.now() - TB.at > 60000) {
      if (!TB.data) main.innerHTML = head + '<div class="empty">Loading the trade block…</div>';
      TB.data = await pkApi("/block");
      TB.at = Date.now();
      if (state.tab !== "trades" || state.sub !== "block") return;
    }
    blockView(head);
  }

  function blockView(head) {
    head = head || main.querySelector(".section-head").outerHTML + subnav("trades", TRADE_TABS, "block");
    if (!TB.data || TB.data.error) { main.innerHTML = head + `<div class="empty">${esc((TB.data && TB.data.error) || "Couldn't load the trade block.")}</div>`; return; }
    const cur = window.LEAGUE_DATA[IDX.current];
    const teamOf = id => cur.teams.find(t => String(t.id) === String(id));
    const player = (t, pid) => t.roster.find(p => p.id === pid);
    // per team: players on the block / untouchable (ESPN settings merged with changes made here) + needs and note
    const L2 = {};
    cur.teams.forEach(t => {
      const st = (TB.data.statuses || {})[t.id] || {};
      const info = (TB.data.listings || {})[t.id] || { needs: [], note: "" };
      const pick = s => Object.entries(st).filter(([, v]) => v.s === s).map(([pid, v]) => Object.assign({ src: v.src }, player(t, Number(pid)))).filter(p => p.name);
      const players = pick("ON_THE_BLOCK"), untouchable = pick("UNTOUCHABLE");
      if (players.length || untouchable.length || info.needs.length || info.note) L2[t.id] = { t, players, untouchable, needs: info.needs, note: info.note, at: info.at };
    });
    // matches: A shops a position B needs, and B shops a position A needs (two-way), or one-way
    const has = (l, pos) => l.players.filter(p => p.pos === pos);
    const fits = [];
    const ids = Object.keys(L2);
    ids.forEach((a, i) => ids.slice(i + 1).forEach(b => {
      const A = L2[a], B = L2[b];
      const aGives = B.needs.flatMap(pos => has(A, pos)), bGives = A.needs.flatMap(pos => has(B, pos));
      if (aGives.length || bGives.length) fits.push({ A, B, aGives, bGives, two: aGives.length > 0 && bGives.length > 0 });
    }));
    fits.sort((x, y) => (y.two - x.two) || (y.aGives.length + y.bGives.length) - (x.aGives.length + x.bGives.length));
    const chip = p => `<span class="tb-chip" title="${p.src === "espn" ? "Set on ESPN" : "Set here"}"><span class="slot ${esc(p.pos)}">${esc(p.pos)}</span>${esc(p.name)}${p.rosRank ? ` <span class="muted">${esc(p.pos)}${p.rosRank}</span>` : ""}<span class="tb-src">${p.src === "espn" ? "ESPN" : "here"}</span></span>`;
    const fitLine = f => {
      const gives = (who, list) => list.length ? `<b>${esc(who.t.name)}</b> has ${list.map(p => esc(p.name) + " (" + esc(p.pos) + ")").join(", ")}` : "";
      const parts = [gives(f.A, f.aGives) && gives(f.A, f.aGives) + ` for ${esc(f.B.t.name)}`, gives(f.B, f.bGives) && gives(f.B, f.bGives) + ` for ${esc(f.A.t.name)}`].filter(Boolean);
      return `<div class="tb-fit${f.two ? " two" : ""}"><span class="badge${f.two ? " new" : ""}">${f.two ? "Two-way fit" : "One-way fit"}</span> ${parts.join(" · ")}</div>`;
    };
    const card = t => {
      const l = L2[t.id];
      if (!l) return `<article class="tb-card empty-card">${logo(t)}<div><b>${esc(t.name)}</b><div class="team-mgr">${esc(t.manager)} · no listing yet</div></div></article>`;
      const when = l.at ? " · note updated " + ago(l.at) : "";
      return `<article class="tb-card"><div class="tb-head">${logo(t)}<div style="min-width:0"><b>${esc(t.name)}</b><div class="team-mgr">${esc(t.manager)}${esc(when)}</div></div></div>
        ${l.players.length ? `<div class="tb-row"><span class="kicker">On the block</span><div class="tb-chips">${l.players.map(chip).join("")}</div></div>` : ""}
        ${l.untouchable.length ? `<p class="tb-untouch"><span class="kicker">Untouchable</span> ${l.untouchable.map(p => esc(p.name)).join(", ")}</p>` : ""}
        ${l.needs.length ? `<div class="tb-row"><span class="kicker">Looking for</span><div class="tb-chips">${l.needs.map(p => `<span class="tb-chip need"><span class="slot ${esc(p)}">${esc(p)}</span></span>`).join("")}</div></div>` : ""}
        ${l.note ? `<p class="tb-note">“${esc(l.note)}”</p>` : ""}</article>`;
    };
    const order = cur.teams.slice().sort((a, b) => (L2[b.id] ? 1 : 0) - (L2[a.id] ? 1 : 0) || a.standing - b.standing);

    // editor
    let editor;
    const members = pkMembers();
    if (!TB.editing) {
      editor = `<button type="button" class="cta tb-edit-btn" data-tb="edit">Edit my listing</button>`;
    } else {
      const myTeam = PK.member ? cur.teams.find(t => (t.owners || []).includes(PK.member)) : null;
      const mine = myTeam && TB.data.listings[myTeam.id] || { needs: [], note: "" };
      const myStatus = myTeam ? (TB.data.statuses || {})[myTeam.id] || {} : {};
      const statusOf = pid => (myStatus[pid] || { s: "NORMAL" }).s;
      const roster = myTeam ? myTeam.roster.slice().sort((a, b) => POS.concat(["K", "D/ST"]).indexOf(a.pos) - POS.concat(["K", "D/ST"]).indexOf(b.pos) || (a.rosRank || 999) - (b.rosRank || 999)) : [];
      editor = `<div class="panel tb-editor">
        <div class="pk-who" style="margin:0 0 10px">
          <label class="field">Who are you? <select id="pk-member" data-tb="who"><option value="">Choose your name</option>${members.map(m => `<option value="${esc(m.id)}"${m.id === PK.member ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</select></label>
          <label class="field">PIN <input id="pk-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="4" pattern="[0-9]*" placeholder="4 digits" value="${esc(PK.pin)}"></label>
          <p class="note">Same PIN as pick'em. First time? The PIN you enter becomes yours for the season.</p></div>
        ${myTeam ? `<div class="tb-row"><span class="kicker">Trade status · ${esc(myTeam.name)}</span>
            <p class="note" style="margin:0 0 8px">Starts from your ESPN settings. Changes here show on this site only; they aren't sent to ESPN. If you later change a player on ESPN, that wins.</p>
            <div class="tb-status-list">${roster.map(p => `<div class="tb-status-row" data-pid="${p.id}"><span class="slot ${esc(p.pos)}">${esc(p.pos)}</span><span class="tb-sname">${esc(p.name)}${p.rosRank ? ` <span class="muted">${esc(p.pos)}${p.rosRank}</span>` : ""}</span>
              <span class="seg3" role="radiogroup" aria-label="${esc(p.name)} trade status">${[["UNTOUCHABLE", "Untouchable"], ["NORMAL", "Normal"], ["ON_THE_BLOCK", "On the block"]].map(([v, lab]) =>
                `<label><input type="radio" name="tb-s-${p.id}" value="${v}"${statusOf(p.id) === v ? " checked" : ""}><span>${lab}</span></label>`).join("")}</span></div>`).join("")}</div></div>
          <div class="tb-row"><span class="kicker">Looking for</span><div class="tb-pick pos">${BLOCK_POS.map(p => `<label class="tb-opt"><input type="checkbox" name="tb-need" value="${p}"${mine.needs.includes(p) ? " checked" : ""}><span class="slot ${esc(p)}">${esc(p)}</span></label>`).join("")}</div></div>
          <label class="field tb-notefield">Note (optional) <textarea id="tb-note" maxlength="200" rows="2" placeholder="e.g. Want a starting TE, will overpay at RB">${esc(mine.note || "")}</textarea></label>
          <div class="tb-actions"><button type="button" class="cta" data-tb="save">Save listing</button><button type="button" class="linkbtn" data-tb="clear">Reset to my ESPN settings</button><button type="button" class="linkbtn" data-tb="cancel">Cancel</button></div>`
        : `<p class="muted">Choose your name to edit your team's listing.</p>`}
      </div>`;
    }
    const msg = TB.msg ? `<p class="note${TB.err ? " live" : ""}">${esc(TB.msg)}</p>` : "";
    main.innerHTML = head + editor + msg +
      (fits.length ? section("Possible fits", "Pairs where one team is shopping a position the other is looking for.", `<div class="tb-fits">${fits.slice(0, 12).map(fitLine).join("")}</div>`) : "") +
      section("Listings", "", `<div class="tb-cards">${order.map(card).join("")}</div>`);
  }

  async function blockSave(clear) {
    const member = PK.member;
    const pin = (document.getElementById("pk-pin") || {}).value || "";
    if (!member) { TB.msg = "Choose your name first."; TB.err = true; return blockView(); }
    const statuses = {};
    document.querySelectorAll(".tb-status-row").forEach(row => {
      const on = row.querySelector("input:checked");
      if (!clear) statuses[row.dataset.pid] = on ? on.value : "NORMAL";
    });
    const body = clear ? { member, pin, reset: true, needs: [], note: "" } : {
      member, pin, statuses,
      needs: [...document.querySelectorAll('input[name="tb-need"]:checked')].map(i => i.value),
      note: (document.getElementById("tb-note") || {}).value || "",
    };
    const r = await pkApi("/block/save", body);
    if (r.error) { TB.msg = r.error; TB.err = true; return blockView(); }
    PK.pin = pin;
    if (store.get("pk-pin", "")) store.set("pk-pin", pin);
    TB.msg = clear ? "Cleared. Your players are back to Normal here (ESPN settings still apply)." : "Saved. Your listing is live for the whole league.";
    TB.err = false; TB.editing = false;
    TB.data = await pkApi("/block"); TB.at = Date.now();
    blockView();
  }

  main.addEventListener("click", e => {
    const b = e.target.closest("[data-tb]");
    if (!b || b.tagName === "SELECT") return;
    if (b.dataset.tb === "edit") { TB.editing = true; TB.msg = ""; blockView(); }
    if (b.dataset.tb === "cancel") { TB.editing = false; TB.msg = ""; blockView(); }
    if (b.dataset.tb === "save") blockSave(false);
    if (b.dataset.tb === "clear") blockSave(true);
  });
  main.addEventListener("change", e => {
    if (e.target.matches('[data-tb="who"]')) { PK.member = e.target.value; store.set("pk-member", PK.member); PK.pin = (document.getElementById("pk-pin") || {}).value || PK.pin; blockView(); }
  });

  // ---------------------------------------------------------------- history
  const HISTORY_TABS = [["overview", "Champions & standings"], ["h2h", "Head to head"], ["rivalries", "Rivalries"], ["records", "Record book"], ["badges", "Badges"]];
  const BADGE_ICON = { champ: "🏆", runner: "🥈", seed1: "👑", pfking: "💰", comeback: "🔄", streak: "🔥", weektop: "⭐", seasonhigh: "🚀",
    club200: "💯", perfect: "🎯", blowout: "💥", nailbiter: "😅", heartbreak: "💔", robbed: "😤", stolen: "🍀", beatall: "⚔️", dud: "🧊", basement: "🪦" };
  // one member's badges: [{def, list: [[badge, season, week, game, detail]...] newest first}] in the badge order
  function badgeShelf(memberId) {
    const B = IDX.history.badges;
    if (!B) return [];
    const mine = (B.earned[memberId] || []);
    return B.defs.map(d => ({ d, list: mine.filter(e => e[0] === d.id).sort((a, b) => (b[1] || 0) - (a[1] || 0) || (b[2] || 0) - (a[2] || 0)) })).filter(x => x.list.length);
  }
  const badgeWhen = e => {
    if (!e[1]) return "";
    if (e[2] == null) return String(e[1]);
    const p = new URLSearchParams({ week: e[2] });
    if (e[1] !== IDX.current) p.set("season", e[1]);
    if (e[3] != null) p.set("game", e[3]);
    return `<a class="wk-link" href="#/matchups?${p}">${e[1]} wk ${e[2]}</a>`;
  };
  function badgeTiles(memberId) {
    const shelf = badgeShelf(memberId);
    if (!shelf.length) return `<div class="empty">No badges yet.</div>`;
    return `<div class="bdg-shelf">${shelf.map(({ d, list }) => `<div class="bdg" title="${esc(d.desc)}">
      <span class="bdg-i" aria-hidden="true">${BADGE_ICON[d.id] || "🏅"}</span>
      <span class="bdg-t"><b>${esc(d.name)}${list.length > 1 ? ` <span class="bdg-n">×${list.length}</span>` : ""}</b>
      <span class="team-mgr">${esc(list[0][4] || d.desc)}${list[0][1] ? " · " + badgeWhen(list[0]) : ""}</span></span></div>`).join("")}</div>`;
  }
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
    badges(H) {
      const B = H.badges;
      if (!B) return `<div class="empty">Badges appear after the next site update.</div>`;
      const active = H.members.filter(m => m.active), all = H.members;
      if (!state.badgeMember || !all.some(m => m.id === state.badgeMember)) state.badgeMember = (ME.member && all.some(m => m.id === ME.member) ? ME.member : (active[0] || all[0]).id);
      const holders = id => all.map(m => ({ m, n: (B.earned[m.id] || []).filter(e => e[0] === id).length })).filter(x => x.n)
        .sort((a, b) => (b.m.active - a.m.active) || b.n - a.n);
      const cards = B.defs.map(d => {
        const h = holders(d.id);
        return `<div class="bdg-card${h.length ? "" : " none"}"><div class="bdg-head"><span class="bdg-i" aria-hidden="true">${BADGE_ICON[d.id] || "🏅"}</span>
          <span><b>${esc(d.name)}</b><span class="team-mgr">${esc(d.desc)}</span></span>
          <span class="bdg-rare">${h.length ? `${h.length} of ${all.length}` : "Nobody yet"}</span></div>
          ${h.length ? `<div class="bdg-who">${h.map(x => `<span class="${x.m.active ? "" : "muted"}${x.m.id === state.badgeMember ? " me" : ""}">${esc(x.m.name)}${x.n > 1 ? " ×" + x.n : ""}</span>`).join("")}</div>` : ""}</div>`;
      }).join("");
      const pick = `<label class="field">Manager <select id="badge-member">${all.map(m => `<option value="${esc(m.id)}"${m.id === state.badgeMember ? " selected" : ""}>${esc(m.name)}${m.active ? "" : " (former)"}</option>`).join("")}</select></label>`;
      const count = (B.earned[state.badgeMember] || []).length;
      return section("Badge shelf", "Every badge a manager has earned, across all seasons. The line under each is the latest time.",
          `${pick}<p class="sub" style="margin:8px 0 10px">${count} earned · ${badgeShelf(state.badgeMember).length} of ${B.defs.length} different badges</p>${badgeTiles(state.badgeMember)}`) +
        section("Every badge", "How many of the league's managers have each one (all-time; former members in gray).", `<div class="bdg-grid">${cards}</div>`);
    },

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
      const members = H.members.slice().sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
      const who = state.params.get("member") || state.recMember || "";
      state.recMember = members.some(m => m.id === who) ? who : "";
      const pick = `<label class="field rec-pick">Record book <select id="rec-member"><option value="">Whole league</option>${members.map(m => `<option value="${esc(m.id)}"${m.id === state.recMember ? " selected" : ""}>${esc(m.name)}${m.active ? "" : " (former)"}</option>`).join("")}</select></label>`;
      if (state.recMember) {
        const box = `<div class="rec-mine" data-rec-member="${esc(state.recMember)}"><div class="empty">Loading…</div></div>`;
        setTimeout(() => fillPersonalBook(main.querySelector(".rec-mine")), 0);
        return pick + box;
      }
      return pick + leagueRecordBook(H);
    },
  };

  function loadRecords() {
    if (window.LEAGUE_RECORDS && window.LEAGUE_RECORDS.all) return Promise.resolve(window.LEAGUE_RECORDS.all);
    return new Promise((resolve, reject) => {
      const sc = document.createElement("script");
      sc.src = "data/records.js?b=" + encodeURIComponent(IDX.updated || IDX.build || "");
      sc.onload = () => (window.LEAGUE_RECORDS && window.LEAGUE_RECORDS.all ? resolve(window.LEAGUE_RECORDS.all) : reject(new Error("empty")));
      sc.onerror = () => reject(new Error("load failed"));
      document.head.appendChild(sc);
    });
  }
  const recTeamLine = (r, val) => `<div class="rec"><span class="rec-v">${val}</span><span class="rec-who">${logoImg(r.logo, r.team)}<span><b>${esc(r.team)}</b><span class="team-mgr">${owners(r.owners)}</span></span></span>${whenLink(r)}</div>`;
  const recGameLine = (r, val) => `<div class="rec"><span class="rec-v">${val}</span><span class="rec-who"><span><b>${esc(r.winner.team)}</b> ${fmt(r.winPts)} – ${fmt(r.losePts)} <b>${esc(r.loser.team)}</b><span class="team-mgr">${owners(r.winner.owners)} over ${owners(r.loser.owners)}</span></span></span>${whenLink(r)}</div>`;
  const recPlayerLine = r => `<div class="rec"><span class="rec-v">${fmt(r.pts)}</span><span class="rec-who"><span class="slot ${esc(r.pos)}">${esc(r.pos)}</span><span><b>${esc(r.name)}</b><span class="team-mgr">${esc(r.team)} · ${owners(r.owners)}</span></span></span>${whenLink(r)}</div>`;
  const recCard = (title, rows) => `<section class="rec-card"><h3>${title}</h3>${rows || '<p class="muted" style="margin:6px 0">None yet.</p>'}</section>`;
  function leagueRecordBook(H) {
    const R = H.records;
    return `<div class="rec-grid">
        ${recCard("Highest scores", R.highScores.map(r => recTeamLine(r, fmt(r.pts))).join(""))}
        ${recCard("Lowest scores", R.lowScores.map(r => recTeamLine(r, fmt(r.pts))).join(""))}
        ${recCard("Biggest blowouts", R.blowouts.map(r => recGameLine(r, "+" + r.margin.toFixed(1))).join(""))}
        ${recCard("Closest games", R.closest.map(r => recGameLine(r, r.margin.toFixed(2))).join(""))}
        ${recCard("Highest-scoring games", R.shootouts.map(r => recGameLine(r, r.combined.toFixed(1))).join(""))}
        ${recCard("Best player games", R.playerGames.map(recPlayerLine).join(""))}
        ${recCard("Best games on the bench", R.benchGames.map(recPlayerLine).join(""))}
      </div>`;
  }
  // one member's own record book (History → Record book with a manager picked)
  function personalBookHtml(R, m) {
    const lossLine = r => recGameLine(Object.assign({}, r, { teamId: r.loserId }), "−" + r.margin.toFixed(1));
    const closeLine = r => recGameLine(Object.assign({}, r, (r.loser.owners || []).includes(m) ? { teamId: r.loserId } : {}), ((r.winner.owners || []).includes(m) ? "W " : "L ") + r.margin.toFixed(2));
    const streakLine = r => `<div class="rec"><span class="rec-v">${r.len}</span><span class="rec-who">${logoImg(r.logo, r.team)}<span><b>${esc(r.team)}</b><span class="team-mgr">${r.len} straight wins · weeks ${r.from}–${r.to}</span></span></span><span class="when"><span>${r.season}</span></span></div>`;
    return `<div class="rec-grid">
        ${recCard("Highest scores", R.highScores.map(r => recTeamLine(r, fmt(r.pts))).join(""))}
        ${recCard("Lowest scores", R.lowScores.map(r => recTeamLine(r, fmt(r.pts))).join(""))}
        ${recCard("Biggest wins", R.bigWins.map(r => recGameLine(r, "+" + r.margin.toFixed(1))).join(""))}
        ${recCard("Worst losses", R.worstLosses.map(lossLine).join(""))}
        ${recCard("Closest games", R.closest.map(closeLine).join(""))}
        ${recCard("Longest win streaks", R.streaks.map(streakLine).join(""))}
        ${recCard("Best player games", R.playerGames.map(recPlayerLine).join(""))}
        ${recCard("Best games on the bench", R.benchGames.map(recPlayerLine).join(""))}
      </div>`;
  }
  async function fillPersonalBook(box) {
    if (!box) return;
    const m = box.dataset.recMember;
    let all = null;
    try { all = await loadRecords(); } catch (_) { box.innerHTML = `<div class="empty">Couldn't load the record book. Try again in a minute.</div>`; return; }
    box.innerHTML = all[m] ? `<p class="sub" style="margin:0 0 10px">${esc(memberName(m))}'s records across every season, playoffs included.</p>` + personalBookHtml(all[m], m) : `<div class="empty">No games yet.</div>`;
  }
  // My team: the #1 of each list, linking to the full book
  async function fillMyRecords(box) {
    if (!box) return;
    const m = box.dataset.recMember;
    let all = null;
    try { all = await loadRecords(); } catch (_) { box.innerHTML = ""; return; }
    const R = all[m];
    if (!R) { box.innerHTML = `<div class="empty">No games yet.</div>`; return; }
    const tile = (label, val, sub, r) => `<a class="me-rec" href="${r && r.week != null ? whenLink(r).match(/href="([^"]+)"/)[1] : href("history", { member: m }, "records")}"><span class="kicker">${label}</span><b>${val}</b><span class="team-mgr">${sub}</span></a>`;
    const at = r => `${r.season} · ${r.playoff ? "Playoffs" : "Wk"} ${r.week}`;
    const tiles = [];
    const hi = R.highScores[0], lo = R.lowScores[0], bw = R.bigWins[0], wl = R.worstLosses[0], pg = R.playerGames[0], st = R.streaks[0];
    const cw = R.closest.find(g => (g.winner.owners || []).includes(m)), cl = R.closest.find(g => (g.loser.owners || []).includes(m));
    if (hi) tiles.push(tile("Best score", fmt(hi.pts), at(hi), hi));
    if (lo) tiles.push(tile("Worst score", fmt(lo.pts), at(lo), lo));
    if (bw) tiles.push(tile("Biggest win", "+" + bw.margin.toFixed(1), `vs ${esc(bw.loser.team)} · ${at(bw)}`, bw));
    if (wl) tiles.push(tile("Worst loss", "−" + wl.margin.toFixed(1), `vs ${esc(wl.winner.team)} · ${at(wl)}`, Object.assign({}, wl, { teamId: wl.loserId })));
    if (cw) tiles.push(tile("Closest win", "+" + cw.margin.toFixed(2), `vs ${esc(cw.loser.team)} · ${at(cw)}`, cw));
    if (cl) tiles.push(tile("Closest loss", "−" + cl.margin.toFixed(2), `vs ${esc(cl.winner.team)} · ${at(cl)}`, Object.assign({}, cl, { teamId: cl.loserId })));
    if (pg) tiles.push(tile("Best player game", fmt(pg.pts), `${esc(pg.name)} · ${at(pg)}`, pg));
    if (st) tiles.push(tile("Longest win streak", st.len + " wins", `${st.season} · weeks ${st.from}–${st.to}`, null));
    box.innerHTML = `<div class="me-recs">${tiles.join("")}</div>`;
  }

  function renderHistory() {
    const H = IDX.history;
    const sub = HISTORY_TABS.some(([k]) => k === state.sub) ? state.sub : "overview";
    main.innerHTML = `<div class="section-head"><div><h1>League history</h1><p class="sub">${IDX.seasons.length} seasons · ${H.members.length} members all-time</p></div></div>
      ${subnav("history", HISTORY_TABS, sub)}${HISTORY[sub](H)}`;
  }

  // ---------------------------------------------------------------- watch guide
  // Which real NFL games matter most this week: every league starter playing in each game, weighted by his
  // projection and by how close his fantasy matchup is (a toss-up counts more than a blowout).
  function watchModel() {
    if (!L.isCurrent || L.over || !(D.nflGames || []).length) return null;
    const wk = D.weeks.find(w => w.week === L.currentWeek);
    if (!wk) return null;
    const now = Date.now();
    const games = D.nflGames.map(g => Object.assign({}, g, { at: g.date ? new Date(g.date).getTime() : 0, rows: [], stake: 0, starters: 0, proj: 0 }));
    const byTeam = {};
    games.forEach(g => { byTeam[g.home] = g; byTeam[g.away] = g; });
    wk.games.filter(m => m.sides.length === 2).forEach(m => {
      const [a, b] = m.sides;
      const close = a.winProb != null && b.winProb != null ? 1 - Math.abs(a.winProb - b.winProb)
        : Math.max(0, 1 - Math.abs((a.proj != null ? a.proj : a.projected) - (b.proj != null ? b.proj : b.projected)) / 50);
      [a, b].forEach((s, i) => s.lineup.filter(p => p.slot !== "BE" && p.slot !== "IR").forEach(p => {
        const g = byTeam[p.team];
        if (!g) return;
        const pr = p.proj || 0;
        g.starters++; g.proj += pr; g.stake += pr * (0.35 + 0.65 * close);
        let row = g.rows.find(r => r.game === m.id);
        if (!row) g.rows.push(row = { game: m.id, close, sides: [{ team: a.team, players: [] }, { team: b.team, players: [] }] });
        row.sides[i].players.push(p);
      }));
    });
    const max = Math.max(1, ...games.map(g => g.stake));
    games.forEach(g => {
      g.score = Math.round(100 * g.stake / max);
      g.state = !g.at || now < g.at ? "upcoming" : now < g.at + 4.25 * 3600e3 ? "live" : "final";
      g.rows.sort((x, y) => y.close - x.close);
    });
    return { week: wk.week, games };
  }
  const kickText = g => g.state === "live" ? "Live now" : g.state === "final" ? "Final" : g.tbd ? "Time TBD"
    : new Date(g.at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  const closeText = c => c >= 0.8 ? "Toss-up" : c >= 0.5 ? "Close" : "Leaning";
  const lastName = n => /D\/ST$/.test(n) ? n.replace(" D/ST", " D") : n.split(" ").slice(1).join(" ") || n;
  const plist = (ps, done) => ps.map(p => `${esc(lastName(p.name))} <span class="muted">${done ? fmt(p.pts) : (p.proj || 0).toFixed(1)}</span>`).join(", ");

  function renderWatch() {
    const head = `<div class="section-head"><div><h1>Watch guide</h1>${expl("The real NFL games that matter most to the league this week.",
      "Each game is rated by the league starters playing in it, weighted by their projections and by how close their fantasy matchups are: a player in a toss-up counts almost three times as much as one in a lopsided matchup. 100 = the week's biggest game. Numbers next to players are ESPN's projections (points once their game is over).")}</div></div>${subnav("matchups", MATCHUP_TABS, "watch")}`;
    const M = watchModel();
    if (!M) { main.innerHTML = head + `<div class="empty">The watch guide covers the current week while the season is in progress.${state.season !== IDX.current ? ` <a href="#/matchups/watch">Go to this week's guide</a>` : ""}</div>`; return; }
    const me = myTeam();
    const card = g => {
      const mineHere = me && g.rows.some(r => r.sides.some(s => s.team === me.id && s.players.length));
      const rows = g.rows.map(r => {
        const [x, y] = r.sides.map(s => Object.assign({ t: teamById[s.team] }, s));
        const side = s => `<span class="wg-side${isMine(s.t) ? " me" : ""}"><b>${esc(s.t.name)}</b>${s.players.length ? " " + plist(s.players, g.state === "final") : ' <span class="muted">none</span>'}</span>`;
        return `<div class="wg-row">${side(x)}<span class="wg-vs">vs</span>${side(y)}<span class="wg-close c${r.close >= 0.8 ? 3 : r.close >= 0.5 ? 2 : 1}">${closeText(r.close)}</span></div>`;
      }).join("");
      return `<article class="wg-game ${g.state}${mineHere ? " mine" : ""}">
        <div class="wg-top"><span class="wg-teams">${esc(g.away)} <span class="muted">at</span> ${esc(g.home)}</span><span class="wg-when${g.state === "live" ? " live" : ""}">${esc(kickText(g))}</span></div>
        <div class="wg-meter"><span class="wg-score" title="Importance this week (100 = biggest game)">${g.score}</span><span class="wg-bar" aria-hidden="true"><i style="width:${g.score}%"></i></span>
          <span class="team-mgr">${g.starters} league starter${g.starters === 1 ? "" : "s"} · ${g.proj.toFixed(0)} projected pts${mineHere ? " · <b>you have players here</b>" : ""}</span></div>
        ${rows ? `<div class="wg-rows">${rows}</div>` : ""}</article>`;
    };
    const left = M.games.filter(g => g.state !== "final" && g.starters);
    const top = left.slice().sort((a, b) => b.stake - a.stake).slice(0, 3);
    const days = {};
    M.games.filter(g => g.state !== "final" && g.starters && !top.includes(g)).forEach(g => {
      const k = g.at ? new Date(g.at).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }) : "Time TBD";
      (days[k] = days[k] || []).push(g);
    });
    const done = M.games.filter(g => g.state === "final" && g.starters);
    const none = M.games.filter(g => !g.starters);
    main.innerHTML = head +
      (top.length ? section("Must-watch", "", `<div class="wg-list">${top.map(card).join("")}</div>`) : `<div class="empty">Every game with league starters has been played this week.</div>`) +
      Object.entries(days).map(([d, gs]) => section(esc(d), "", `<div class="wg-list">${gs.map(card).join("")}</div>`)).join("") +
      (done.length ? section("Already played", "", `<div class="wg-list">${done.map(card).join("")}</div>`) : "") +
      (none.length ? `<p class="sub">No league starters: ${none.map(g => esc(g.away + " at " + g.home)).join(", ")}.</p>` : "");
  }

  // ---------------------------------------------------------------- my team
  // Claimed with the same name + PIN as pick'em (checked by the live worker) and remembered on this device.
  // The member id is an ESPN account, so it finds the right team in every season.
  const ME = { member: store.get("me", ""), pick: "", msg: "", err: false, busy: false };
  if (ME.member && !PK.member) PK.member = ME.member;
  function myTeam(data) { return ME.member ? (((data || D) || {}).teams || []).find(t => (t.owners || []).includes(ME.member)) || null : null; }
  function isMine(t) { return !!(t && ME.member && (t.owners || []).includes(ME.member)); }

  function renderMyTeam() {
    const head = (title, sub, extra) => `<div class="section-head"><div><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ""}</div>${extra || ""}</div>`;
    const switchBtn = `<button type="button" class="linkbtn" data-me="switch">Not you? Switch</button>`;
    if (!ME.member) {
      const members = pkMembers();
      main.innerHTML = head("My team", "Tell the site which team is yours. This page gets built around it, and your team is highlighted everywhere else.") +
        `<form class="panel me-claim" id="me-claim">
          <label class="field">Who are you? <select id="me-member"><option value="">Choose your name</option>${members.map(m => `<option value="${esc(m.id)}"${m.id === (ME.pick || PK.member) ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</select></label>
          <label class="field">PIN <input id="me-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="4" pattern="[0-9]*" placeholder="4 digits"></label>
          <button type="submit" class="cta"${ME.busy ? " disabled" : ""}>${ME.busy ? "Checking…" : "This is me"}</button>
          ${ME.msg ? `<p class="pk-msg${ME.err ? " err" : ""}">${esc(ME.msg)}</p>` : ""}
          <p class="sub">Same name and PIN as pick'em and the trade block. Never set one? Choose a 4-digit PIN now and it becomes yours.</p>
        </form>`;
      return;
    }
    const t = myTeam();
    if (!t) { main.innerHTML = head("My team", `${esc(memberName(ME.member))} wasn't in the league in ${L.season}.`, switchBtn); return; }
    const cur = L.isCurrent && !L.over;

    // at a glance
    const tiles = [["Standing", L.over && t.finalRank ? `#${t.finalRank} final` : `#${t.standing} of ${L.size}`, record(t) + (t.streak ? " · " + t.streak : "")]];
    if (t.powerRank) tiles.push(["Power rank", `#${t.powerRank}`, cur ? `${Math.round(t.power)} proj pts left` : ""]);
    if (t.odds) tiles.push(["Playoff odds", pct(t.odds.playoffPct), "Title " + pct(t.odds.titlePct)]);
    if (t.luck != null) tiles.push(["Luck", (t.luck > 0 ? "+" : t.luck < 0 ? "−" : "") + Math.abs(t.luck) + " W", `${t.expectedWins} expected wins`]);
    if (t.efficiency != null) tiles.push(["Lineups", t.efficiency.toFixed(1) + "%", `${Number(t.benchLeft).toFixed(0)} pts left on bench`]);
    const dg = D.draft && D.draft.teams[t.id];
    if (dg) tiles.push(["Draft grade", dg.grade, `#${dg.rank} in league`]);
    const glance = `<div class="set-tiles">${tiles.map(([k, v, s]) => `<div class="set-tile"><span class="set-tile-k">${k}</span><span class="set-tile-v">${esc(String(v))}</span>${s ? `<span class="team-mgr">${esc(s)}</span>` : ""}</div>`).join("")}</div>`;

    // this week
    let week = "";
    const wkNow = D.weeks.find(w => w.week === L.currentWeek);
    const g = cur && wkNow && wkNow.games.find(x => x.sides.some(s => s.team === t.id));
    if (cur && !g) week = section(`Week ${L.currentWeek}`, "", `<div class="panel">No game this week.</div>`);
    if (g) {
      const mine = g.sides.find(s => s.team === t.id), opp = g.sides.find(s => s.team !== t.id);
      if (!opp) week = section(`Week ${wkNow.week}`, "", `<div class="panel">Bye this week.</div>`);
      else {
        const o = teamById[opp.team];
        const wp = mine.winProb != null ? Math.round(mine.winProb * 100) : null;
        const side = (s, tt) => `<div class="side-row">${logo(tt)}<span style="min-width:0"><div class="team-name">${esc(tt.name)}</div><div class="team-mgr">${esc(tt.manager)} · ${record(tt)}</div></span><span></span>
          <span class="score">${fmt(s.pts)}${s.proj != null ? `<small>proj ${fmt(s.proj)}</small>` : ""}</span></div>`;
        const h = IDX.history.h2h[`${ME.member}|${(o.owners || [])[0]}`];
        week = section(`Week ${wkNow.week}: your matchup`, wp != null ? `ESPN gives you a ${wp}% chance to win.` : "",
          `<a class="game me-match" href="${href("matchups", { week: wkNow.week, game: g.id })}">${side(mine, t)}${side(opp, o)}
            ${wp != null ? `<div class="wp-bar" aria-hidden="true"><span style="width:${wp}%"></span></div>` : ""}
            <div class="game-foot"><span>${h ? `All-time vs ${esc(memberName(o.owners[0]))}: ${h[0]}–${h[1]}${h[2] ? "–" + h[2] : ""}` : "First meeting"}</span><span>Box score →</span></div></a>`);
      }
    }

    // NFL games with my players this week
    let watch = "";
    const M = cur ? watchModel() : null;
    if (M) {
      const gs = M.games.filter(x => x.state !== "final" && x.rows.some(r => r.sides.some(s => s.team === t.id && s.players.length)));
      const lines = gs.map(x => {
        const r = x.rows.find(r => r.sides.some(s => s.team === t.id));
        const ms = r.sides.find(s => s.team === t.id), os = r.sides.find(s => s.team !== t.id);
        return `<div class="rec"><span class="rec-v me-kick">${esc(kickText(x))}</span><span class="rec-who"><span><b>${esc(x.away)} at ${esc(x.home)}</b>
          <span class="team-mgr">You: ${plist(ms.players)}${os.players.length ? " · Them: " + plist(os.players) : ""}</span></span></span></div>`;
      });
      watch = section("Your games to watch", "Real NFL games still to play with your starters in them.", lines.length ? `<div class="rec-card wrap">${lines.join("")}</div>` : `<div class="panel">All your starters have played.</div>`);
    }

    // byes ahead
    let byes = "";
    if (cur && t.byeCrunch) {
      const bc = t.byeCrunch.filter(x => x.lost >= 0.5 || x.need.length);
      byes = section("Byes ahead", "Weeks your best lineup is short-handed, compared with full strength.", bc.length
        ? `<div class="rec-card wrap">${bc.map(x => `<div class="rec"><span class="rec-v">${x.lost >= 0.5 ? "−" + x.lost.toFixed(1) : "0"}</span><span class="rec-who"><span><b>Week ${x.w}</b>
            <span class="team-mgr">${esc(x.out.map(p => `${p.name} (${p.pos}${p.bye ? ", bye" : ", out"})`).join(", "))}${x.need.length ? `${x.out.length ? " · " : ""}<b class="neg">No ${esc(x.need.join(" or "))}</b>` : ""}</span></span></span></div>`).join("")}</div>`
        : `<div class="panel">No bye trouble the rest of the way.</div>`);
    }

    // schedule
    const sched = D.weeks.map(w => {
      const gm = w.games.find(x => x.sides.some(s => s.team === t.id));
      if (!gm) return "";
      const mine = gm.sides.find(s => s.team === t.id), opp = gm.sides.find(s => s.team !== t.id);
      const o = opp && teamById[opp.team];
      const winnerSide = gm.winner === "HOME" ? gm.sides[0] : gm.winner === "AWAY" ? gm.sides[1] : null;
      let res = "", cls = "";
      if (w.final && opp) { cls = winnerSide ? (winnerSide.team === t.id ? "w" : "l") : "t"; res = `${cls.toUpperCase()} ${fmt(mine.pts)}–${fmt(opp.pts)}`; }
      else if (w.week === L.currentWeek && opp && !L.over) { cls = "now"; res = `${fmt(mine.pts)}–${fmt(opp.pts)}`; }
      else res = "";
      return `<a class="me-wk ${cls}" href="${href("matchups", { week: w.week, game: gm.id })}"><span class="me-wk-n">${w.playoffs ? "PO" : "Wk"} ${w.week}</span>
        <span class="me-wk-o">${o ? `${logo(o)}<span>${esc(o.name)}</span>` : "Bye"}</span><span class="me-wk-r">${res}</span></a>`;
    }).join("");
    const later = (D.upcoming || []).filter(u => u.teams.includes(t.id)).sort((a, b) => a.week - b.week).map(u => {
      const o = teamById[u.teams.find(x => x !== t.id)];
      const po = u.week > L.regularSeasonWeeks;
      return `<div class="me-wk later"><span class="me-wk-n">${po ? "PO" : "Wk"} ${u.week}</span>
        <span class="me-wk-o">${o ? `${logo(o)}<span>${esc(o.name)}</span>` : "Bye"}</span><span class="me-wk-r">${o ? record(o) : ""}</span></div>`;
    }).join("");
    const schedule = section("Schedule", later ? "Results so far, then who's left (with their records)." : "", `<div class="me-sched">${sched}${later}</div>`);

    // roster
    const rank = p => cur ? p.rosRank : p.posRank, pts = p => cur ? p.ros : p.seasonPts;
    const roster = section("Roster", cur ? "Rest-of-season rank and projected points." : "Where each player finished.", table([
      { label: "Player", cell: p => `<span class="tcell"><span class="slot ${esc(POS.includes(p.slot) ? p.slot : p.pos)}" style="font-size:10px;font-weight:700">${esc(p.slot)}</span><span><span class="tname">${esc(p.name)}</span><span class="team-mgr">${esc(p.pos)} · ${esc(p.team)}${p.injury ? " · " + esc(p.injury.replace(/_/g, " ").toLowerCase()) : ""}</span></span></span>` },
      { label: cur ? "ROS rank" : "Finish", num: 1, cell: p => rank(p) ? esc(p.pos) + rank(p) : "—" },
      { label: cur ? "ROS pts" : "Season pts", num: 1, cell: p => pts(p) != null ? Number(pts(p)).toFixed(1) : "—" },
    ], t.roster));

    main.innerHTML = `<div class="section-head me-head"><div class="me-id">${logo(t)}<div><h1>${esc(t.name)}</h1><p class="sub">${esc(t.manager)} · ${L.season} season</p></div></div>${switchBtn}</div>
      ${glance}
      <div class="me-grid"><div>${week}${watch}${byes}</div><div>${schedule}</div></div>
      ${IDX.history.badges ? section(`Your badges <a class="wk-link" href="${href("history", {}, "badges")}">all badges ›</a>`, "Earned across every season you've played.", badgeTiles(ME.member)) : ""}
      ${section(`Your record book <a class="wk-link" href="${href("history", { member: ME.member }, "records")}">full record book ›</a>`, "Your bests and worsts across every season you've played. Tap one for the box score.", `<div class="me-recs-box" data-rec-member="${esc(ME.member)}"><div class="empty">Loading…</div></div>`)}
      ${roster}`;
    fillMyRecords(main.querySelector(".me-recs-box"));
  }

  main.addEventListener("submit", async e => {
    if (e.target.id !== "me-claim") return;
    e.preventDefault();
    const member = document.getElementById("me-member").value;
    const pin = document.getElementById("me-pin").value.trim();
    ME.pick = member; ME.err = true;
    if (!member) { ME.msg = "Choose your name."; return renderMyTeam(); }
    if (!/^\d{4}$/.test(pin)) { ME.msg = "Enter a 4-digit PIN."; return renderMyTeam(); }
    if (!LIVE_API_BASE()) { ME.msg = "This needs the live worker, which isn't set up."; return renderMyTeam(); }
    ME.busy = true; ME.msg = ""; renderMyTeam();
    const r = await pkApi("/pickem/claim", { member, pin }).catch(() => ({ error: "Couldn't reach the server. Try again." }));
    ME.busy = false;
    if (r.error) { ME.msg = r.error; return renderMyTeam(); }
    ME.member = member; ME.msg = ""; ME.err = false;
    store.set("me", member);
    PK.member = member; PK.pin = pin; store.set("pk-member", member);
    route();
  });
  document.addEventListener("click", e => {
    const b = e.target.closest('[data-me="switch"]');
    if (!b) return;
    ME.member = ""; ME.pick = ""; store.set("me", "");
    route();
  });

  // ---------------------------------------------------------------- league settings
  const SCORE_GROUPS = [
    ["Passing", [3, 4, 1, 0, 2, 20, 19, 15, 16, 64]],
    ["Rushing", [24, 25, 23, 26, 35, 36, 37, 38]],
    ["Receiving", [53, 42, 43, 44, 45, 46, 56, 57, 58, 41]],
    ["Kicking", [80, 79, 78, 77, 76, 75, 74, 198, 199, 200, 201, 81, 82, 83, 84, 85, 86, 87, 88]],
    ["Turnovers & other", [63, 68, 72, 114, 115]],
  ];
  const PTS_ALLOWED = [89, 90, 91, 92, 121, 122, 123, 124, 125];
  const YDS_ALLOWED = [128, 129, 130, 131, 132, 133, 134, 135, 136];
  const PER_YARD = new Set([3, 24, 42, 114, 115]);
  const DAY = { SUNDAY: "Sun", MONDAY: "Mon", TUESDAY: "Tue", WEDNESDAY: "Wed", THURSDAY: "Thu", FRIDAY: "Fri", SATURDAY: "Sat" };
  const DAY_ORDER = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];

  function renderSettings() {
    const S = D.settings;
    if (!S) { main.innerHTML = '<div class="empty">Settings for this season aren\'t available yet. They\'ll show after the next refresh.</div>'; return; }
    const num = x => (Math.round(x * 100) / 100).toString();
    const signed = x => (x > 0 ? "+" : x < 0 ? "−" : "") + num(Math.abs(x));
    const row = (label, value, note) => `<div class="set-row"><span class="set-k">${label}${note ? `<span class="team-mgr">${note}</span>` : ""}</span><span class="set-v">${value}</span></div>`;
    const card = (title, rows, extra) => `<section class="rec-card set-card"><h3>${title}</h3>${rows}${extra || ""}</section>`;
    const date = iso => iso ? new Date(iso).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "None";
    const time = iso => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const items = Object.fromEntries(S.scoring.map(i => [i.stat, i]));
    const label = id => STAT[id] || "Stat #" + id;

    // at a glance
    const ppr = (items[53] || {}).pts;
    const fmtName = S.rankType === "PPR" || ppr === 1 ? "Full PPR" : ppr === 0.5 ? "Half PPR" : ppr ? ppr + " PPR" : "Standard";
    const playoffStart = S.regularWeeks + 1, playoffEnd = L.finalWeek;
    const tiles = [
      ["Format", S.scoringType === "H2H_POINTS" ? "H2H points" : (S.scoringType || "").replace(/_/g, " ").toLowerCase(), "Head to head"],
      ["Scoring", fmtName, ppr ? `${num(ppr)} pt per catch` : ""],
      ["Teams", S.size || L.size, S.divisions.length > 1 ? S.divisions.length + " divisions" : "One division"],
      ["Regular season", `${S.regularWeeks} weeks`, `Weeks 1–${S.regularWeeks}`],
      ["Playoffs", `${S.playoffTeams} teams`, `Weeks ${playoffStart}–${playoffEnd}`],
      ["Trade deadline", S.tradeDeadline ? new Date(S.tradeDeadline).toLocaleDateString([], { month: "short", day: "numeric" }) : "None",
        S.tradeDeadline ? new Date(S.tradeDeadline).toLocaleDateString([], { weekday: "long" }) : ""],
    ];
    const glance = `<div class="set-tiles">${tiles.map(([k, v, sub]) => `<div class="set-tile"><span class="set-tile-k">${k}</span><span class="set-tile-v">${esc(String(v))}</span>${sub ? `<span class="team-mgr">${esc(sub)}</span>` : ""}</div>`).join("")}</div>`;

    // roster
    const chips = S.slots.map(s => `<span class="set-chip"><span class="slot ${esc(s.slot)}">${esc(s.slot === "BE" ? "Bench" : s.slot)}</span><b>${s.slot === "BE" && S.benchUnlimited ? s.count : s.count}</b></span>`).join("");
    const starters = S.slots.filter(s => !["BE", "IR"].includes(s.slot)).reduce((a, s) => a + s.count, 0);
    const total = S.slots.filter(s => s.slot !== "IR").reduce((a, s) => a + s.count, 0);
    const flex = S.slots.find(s => s.slot === "FLEX") ? row("FLEX spot", "RB, WR or TE") : "";
    const limits = Object.entries(S.positionLimits);
    const roster = card("Roster", `<div class="set-chips">${chips}</div>` +
      row("Starters", starters) + row("Roster size", total + (S.slots.find(s => s.slot === "IR") ? " + IR" : "")) + flex +
      (limits.length ? row("Max per position", limits.map(([p, n]) => `<span class="nw">${esc(p)} ${n}</span>`).join(" · ")) : "") +
      row("Lineup lock", S.lockType === "INDIVIDUAL_GAME" ? "At each player's kickoff" : S.lockType === "FIRST_GAME" ? "At the week's first kickoff" : esc(String(S.lockType || "—"))) +
      (S.undroppable ? row("Undroppable list", "On", "ESPN's list of players who can't be dropped") : ""));

    // scoring
    const scoreRow = id => {
      const v = items[id].pts;
      if (PER_YARD.has(id)) return row(label(id), `${signed(v)} / yd`, v ? `1 pt every ${num(1 / v)} yds` : "");
      return row(label(id), signed(v));
    };
    const used = new Set();
    const groups = SCORE_GROUPS.map(([title, ids]) => {
      const present = ids.filter(id => items[id] && items[id].pts);
      present.forEach(id => used.add(id));
      return present.length ? card(title, present.map(scoreRow).join("")) : "";
    });
    const dstVal = id => items[id] ? (items[id].dst != null ? items[id].dst : items[id].pts) : 0;
    const dstIds = S.scoring.map(i => i.stat).filter(id => !PTS_ALLOWED.includes(id) && !YDS_ALLOWED.includes(id) && !used.has(id) && items[id].dst != null && dstVal(id));
    const DST_ORDER = [99, 95, 96, 98, 97, 93, 101, 102, 103, 104, 206];
    dstIds.sort((a, b) => (DST_ORDER.indexOf(a) + 1 || 99) - (DST_ORDER.indexOf(b) + 1 || 99));
    const both = dstIds.some(id => items[id].pts && id >= 101 && id <= 104);
    const dstPlays = dstIds.map(id => row(label(id), signed(dstVal(id)))).join("") +
      (both ? `<p class="team-mgr set-note">Return TDs score the same for a player who makes them.</p>` : "");
    const bracket = (title, ids) => ids.some(id => dstVal(id)) ? `<h4 class="set-sub">${title}</h4><div class="set-bracket">${ids.map(id =>
      `<div><span>${esc(label(id).replace(/ ?\(0 pts allowed\)| pts allowed| yds allowed/g, ""))}</span><b class="${dstVal(id) > 0 ? "pos" : dstVal(id) < 0 ? "neg" : ""}">${signed(dstVal(id)) || "0"}</b></div>`).join("")}</div>` : "";
    const dst = card("Defense / special teams", dstPlays, bracket("Points allowed", PTS_ALLOWED) + bracket("Yards allowed", YDS_ALLOWED));
    const otherIds = S.scoring.map(i => i.stat).filter(id => !used.has(id) && items[id].dst == null && items[id].pts && !SCORE_GROUPS.some(([, ids]) => ids.includes(id)));
    const other = otherIds.length ? card("Other", otherIds.map(scoreRow).join("")) : "";

    // schedule & playoffs
    const seedTie = { TOTAL_POINTS_SCORED: "Total points scored", H2H_RECORD: "Head-to-head record", INTRA_DIVISION_RECORD: "Division record" }[S.seedingRule] || esc(String(S.seedingRule || "—"));
    const tie = S.tieRule === "NONE" ? "Games can end in a tie" : S.tieRule === "SLOT_POINTS" ? (S.tieRuleBy === 20 ? "Bench points break the tie" : "Points from one lineup spot break the tie") : esc(String(S.tieRule).replace(/_/g, " ").toLowerCase());
    const rounds = Math.ceil(Math.log2(Math.max(2, S.playoffTeams || 2)));
    const byes = S.playoffTeams && (2 ** rounds - S.playoffTeams);
    const schedule = card("Schedule & playoffs",
      row("Regular season", `Weeks 1–${S.regularWeeks}`) +
      row("Playoff teams", `${S.playoffTeams}` + (byes ? ` (top ${byes} get a bye)` : "")) +
      row("Playoff weeks", `${playoffStart}–${playoffEnd}`, S.playoffRoundWeeks > 1 ? `${S.playoffRoundWeeks} weeks per round` : "1 week per round") +
      row("Seeding", "By record", "Tiebreak: " + seedTie) +
      row("Reseeding", S.reseed ? "Yes" : "No", S.reseed ? "Top seed left always plays the lowest seed left" : "") +
      row("Consolation bracket", S.consolation ? "Yes" : "No") +
      row("Regular-season ties", tie) +
      row("Playoff ties", S.playoffTieRule === "NONE" ? "Higher seed advances" : esc(String(S.playoffTieRule).replace(/_/g, " ").toLowerCase())) +
      (S.homeBonus ? row("Home-team bonus", signed(S.homeBonus)) : "") +
      (S.divisions.length > 1 ? row("Divisions", S.divisions.map(esc).join(", ")) : ""));

    // draft
    const order = S.draftOrder.length ? `<h4 class="set-sub">Draft order</h4><ol class="set-order">${S.draftOrder.map(id => {
      const t = teamById[id];
      return t ? `<li>${logoImg(t.logo, t.name)}<span><b>${esc(t.name)}</b><span class="team-mgr">${esc(t.manager || "")}</span></span></li>` : "";
    }).join("")}</ol>` : "";
    const draft = card("Draft",
      row("Type", S.draftType === "SNAKE" ? "Snake" : S.draftType === "AUCTION" ? "Auction" : esc(String(S.draftType || "—"))) +
      (S.draftDate ? row("Date", `${date(S.draftDate)}`, time(S.draftDate)) : "") +
      (S.pickSeconds ? row("Time per pick", S.pickSeconds >= 60 ? `${num(S.pickSeconds / 60)} min` : `${S.pickSeconds} sec`) : "") +
      (S.auctionBudget ? row("Auction budget", "$" + S.auctionBudget) : "") +
      row("Keepers", S.keepers || "None"), order);

    // waivers & trades
    const days = DAY_ORDER.filter(d => S.waiverDays.includes(d)).map(d => DAY[d]);
    const limit = n => n == null || n < 0 ? "No limit" : n;
    const moves = card("Waivers & trades",
      row("Waivers", S.faab != null ? `Free-agent budget ($${S.faab})` : "Waiver priority order", S.waiverReset ? "Order resets each week" : "Rolling: using a claim moves you to the back") +
      row("Time on waivers", S.waiverHours ? `${S.waiverHours} hours after a drop` : "None") +
      (days.length ? row("Claims run", days.length === 7 ? "Every day" : days.join(", ")) : "") +
      row("Pickups", limit(S.acqLimit) === "No limit" ? "No limit" : `${S.acqLimit} per season`) +
      row("Trade deadline", date(S.tradeDeadline)) +
      row("Trade review", S.tradeReviewHours ? `${S.tradeReviewHours} hours` : "None", S.vetoVotes ? `${S.vetoVotes} league votes veto a trade` : "") +
      (S.entryFee ? row("Entry fee", "$" + num(S.entryFee)) : ""));

    main.innerHTML = `<div class="section-head"><div><h1>League settings</h1><p class="sub">${L.season} season · straight from ESPN · updated ${esc(ago(D.updated))}</p></div></div>
      ${glance}
      <h2 class="set-h">Roster & season</h2><div class="rec-grid set-grid">${roster}${schedule}${moves}${draft}</div>
      <h2 class="set-h">Scoring</h2><div class="rec-grid set-grid">${groups.join("")}${other}${dst}</div>`;
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
  main.addEventListener("mouseover", e => {
    const g = e.target.closest && e.target.closest("[data-sl]");
    if (g) slHighlight(g.dataset.sl);
  });
  main.addEventListener("mouseout", e => {
    const g = e.target.closest && e.target.closest("[data-sl]");
    if (g && !(e.relatedTarget && g.contains(e.relatedTarget))) slHighlight(state.storyTeam);
  });
  main.addEventListener("click", e => {
    if (e.target.closest('[data-since="dismiss"]')) {
      since.dismissed = true;
      store.set("last-visit", leagueSnapshot());
      store.set("since-base", null);
      const card = main.querySelector(".since");
      if (card) card.remove();
      return;
    }
    const sl = e.target.closest("[data-sl]");
    if (sl) {
      state.storyTeam = String(state.storyTeam) === sl.dataset.sl ? null : sl.dataset.sl;
      store.set("story-team", state.storyTeam);
      slHighlight(state.storyTeam);
      return;
    }
    const toggle = e.target.closest("[data-toggle]");
    if (toggle) {
      const id = Number(toggle.dataset.toggle);
      state.open.has(id) ? state.open.delete(id) : state.open.add(id);
      renderKeepScroll(renderStandings);
      return;
    }
    if (e.target.closest("#redraft-more")) { state.redraftRounds = (state.redraftRounds || 2) + 3; renderKeepScroll(renderInsights); return; }
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
    if (e.target.id === "since-team" && e.target.value) { store.set("pk-member", e.target.value); PK.member = e.target.value; renderKeepScroll(renderStandings); return; }
    if (e.target.id === "sort") { state.sort = e.target.value; store.set("sort", state.sort); renderStandings(); }
    if (e.target.id === "side-week") { state.sideWeek = Number(e.target.value); document.querySelector(".side").outerHTML = sidebar(); }
    if (e.target.id === "swap-team") { state.swapTeam = e.target.value; renderKeepScroll(renderInsights); }
    if (e.target.id === "draft-team") { state.draftTeam = e.target.value; renderKeepScroll(renderInsights); }
    if (e.target.id === "rec-member") { location.hash = href("history", e.target.value ? { member: e.target.value } : {}, "records"); return; }
    if (e.target.id === "badge-member") { state.badgeMember = e.target.value; renderKeepScroll(renderHistory); }
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

  function loadPlayers() {
    if (window.LEAGUE_PLAYERS && window.LEAGUE_PLAYERS.all) return Promise.resolve(window.LEAGUE_PLAYERS.all);
    return new Promise((resolve, reject) => {
      const sc = document.createElement("script");
      sc.src = "data/players.js?b=" + encodeURIComponent(IDX.updated || IDX.build || "");
      sc.onload = () => (window.LEAGUE_PLAYERS && window.LEAGUE_PLAYERS.all ? resolve(window.LEAGUE_PLAYERS.all) : reject(new Error("empty")));
      sc.onerror = () => reject(new Error("load failed"));
      document.head.appendChild(sc);
    });
  }

  // Player passport: every league team that has had this player, all seasons
  async function renderPassport(box, pid, full) {
    let P = null;
    try { P = await loadPlayers(); } catch (_) { box.innerHTML = ""; return; }
    const me = P.players[String(pid)];
    if (!me || !me.s.length) { box.innerHTML = ""; return; }
    const HOW = { T: "Traded for", W: "Picked up", K: "On the roster from week 1" };
    const OUT = { X: "dropped", T: "traded away", E: "", N: "still there" };
    const stints = me.s.slice().reverse();
    const seasons = new Set(me.s.map(x => x[0])).size;
    const owners = new Set(me.s.flatMap(x => (P.teams[x[0] + "|" + x[1]] || ["", []])[1])).size;
    const started = me.s.reduce((n, x) => n + x[4], 0);
    const rows = stints.map(x => {
      const [yr, tid, first, last, st, starts, total, how, out] = x;
      const t = P.teams[yr + "|" + tid] || ["Team " + tid, []];
      const came = how[0] === "D" ? "Drafted " + how.replace("D", "R") : HOW[how] || "";
      const span = first === last ? `wk ${first}` : `wk ${first}–${last}`;
      const left = out === "X" ? `dropped after wk ${last}` : out === "T" ? `traded away after wk ${last}` : OUT[out];
      return `<li class="pp-row"><span class="pp-yr">${yr}</span><span class="pp-body"><b>${esc(t[0])}</b> <span class="muted">${esc(t[1].map(memberName).join(" & "))}</span>
        <span class="team-mgr">${esc(came)} · ${span}${left ? " · " + left : ""}</span></span>
        <span class="pp-pts">${st.toFixed(1)}<small>${starts} start${starts === 1 ? "" : "s"}${total - st >= 0.05 ? ` · ${(total - st).toFixed(1)} benched` : ""}</small></span></li>`;
    }).join("");
    box.innerHTML = `<h3 class="pp-h">${full ? `${esc(me.n)} <span class="muted">${esc(me.p)}</span>` : "In this league"}</h3>
      <p class="pp-sum">${me.s.length} stint${me.s.length === 1 ? "" : "s"} · ${owners} manager${owners === 1 ? "" : "s"} · ${seasons} season${seasons === 1 ? "" : "s"} · <b>${started.toFixed(1)}</b> pts in starting lineups</p>
      <ol class="pp-list">${rows}</ol>`;
  }

  // Insights → Player history: search + one player's stints, or the most-traveled players to start with
  async function fillPlayerHistory(box, pid) {
    if (!box) return;
    let P = null;
    try { P = await loadPlayers(); } catch (_) { box.innerHTML = `<div class="empty">Couldn't load player history. Try again in a minute.</div>`; return; }
    const ids = Object.keys(P.players);
    const label = id => { const x = P.players[id]; return `${x.n} · ${x.p}`; };
    const dl = document.getElementById("ph-list");
    if (dl && !dl.children.length) dl.innerHTML = ids.slice().sort((a, b) => P.players[a].n.localeCompare(P.players[b].n)).map(id => `<option value="${esc(label(id))}"></option>`).join("");
    const input = document.getElementById("ph-search");
    if (input) {
      input.dataset.map = "1";
      input.onchange = () => {
        const v = input.value.trim().toLowerCase();
        const hit = ids.find(id => label(id).toLowerCase() === v) || ids.find(id => P.players[id].n.toLowerCase() === v)
          || ids.find(id => P.players[id].n.toLowerCase().includes(v));
        if (hit) location.hash = href("insights", { player: hit }, "players");
      };
      if (pid && P.players[pid]) input.value = label(pid);
    }
    if (pid && P.players[pid]) {
      box.innerHTML = `<div class="ph-one"></div><p style="margin-top:10px"><a class="wk-link" href="${href("insights", {}, "players")}">‹ Most-traveled players</a> · <a class="wk-link" href="${href("trades", { a: pid }, "compare")}">Compare this season ›</a></p>`;
      return renderPassport(box.querySelector(".ph-one"), pid, true);
    }
    const managers = x => new Set(x.s.flatMap(s => (P.teams[s[0] + "|" + s[1]] || ["", []])[1])).size;
    const rows = ids.filter(id => !["K", "D/ST"].includes(P.players[id].p)).map(id => ({ id, x: P.players[id], m: managers(P.players[id]), n: P.players[id].s.length, pts: P.players[id].s.reduce((a, s) => a + s[4], 0) }))
      .sort((a, b) => b.m - a.m || b.n - a.n || b.pts - a.pts).slice(0, 12);
    box.innerHTML = `<h3 class="pp-h" style="margin-top:6px">Most-traveled players</h3><p class="pp-sum">The players who've been through the most managers' hands (kickers and defenses aside, since they get streamed). Tap one for his full history.</p>
      <div class="picks">${rows.map(r => `<a class="pick ph-row" href="${href("insights", { player: r.id }, "players")}"><span class="pick-no">${r.m}</span><span class="slot ${esc(r.x.p)}">${esc(r.x.p)}</span>
        <span class="pick-name"><b>${esc(r.x.n)}</b><span class="team-mgr">${r.m} managers · ${r.n} stints · ${r.pts.toFixed(0)} pts started</span></span><span class="pick-v">›</span></a>`).join("")}</div>`;
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
      <div class="stat-actions"><a class="cta stat-cmp" href="${href("trades", { a: p.id }, "compare")}">Compare with…</a>
        <a class="linkbtn" href="${href("insights", { player: p.id }, "players")}">League history ›</a></div>
      <button type="button" class="linkbtn share-close">Close</button></div>`;
    document.body.appendChild(sheet);
    const close = () => { sheet.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = e => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    sheet.addEventListener("click", e => { if (e.target === sheet || e.target.closest(".share-close") || e.target.closest(".stat-actions a")) close(); });
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
  // While the current season is in progress, check for a fresh build every minute. The live worker rebuilds the
  // site as soon as anything besides scores changes on ESPN, and every 5 minutes during games.
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
      // the live feed has scores but not ESPN's pre-game projections: carry those over (watch guide uses them)
      const proj = {};
      wk.games.forEach(g => g.sides.forEach(sd => sd.lineup.forEach(p => { if (p.proj != null) proj[p.id] = p.proj; })));
      lv.games.forEach(g => g.sides.forEach(sd => sd.lineup.forEach(p => { if (p.proj == null && proj[p.id] != null) p.proj = proj[p.id]; })));
      wk.games = lv.games;
      window.LIVE_FEED = { week: lv.week, events: lv.feed || [] };
      if (window.LEAGUE_STATS && window.LEAGUE_STATS[IDX.current]) Object.assign(window.LEAGUE_STATS[IDX.current], lv.stats);
      liveAsOf = lv.updated;
      updateLiveChip();
      await checkNflStatus();
      renderTicker();
      const typing = document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
      if (state.season === IDX.current && ["standings", "matchups"].includes(state.tab) && state.sub !== "pickem" && !typing) {
        const y = window.scrollY;
        await route();
        window.scrollTo(0, y);
      }
    } catch (_) { /* network blip: next minute */ }
  }
  // Score ticker: while NFL games are being played, a thin crawl along the bottom of every page with every
  // matchup's score (yours first), each matchup in its own box. Tap it for the matchups.
  const NFL_STATUS = { at: 0, live: true };
  async function checkNflStatus() {
    const cur = window.LEAGUE_DATA && window.LEAGUE_DATA[IDX.current], now = Date.now();
    if (!cur || !(cur.nflGames || []).some(g => !g.tbd && g.date && now >= Date.parse(g.date) && now < Date.parse(g.date) + 4 * 3600e3)) return;
    try {
      const d = await (await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard", { cache: "no-store" })).json();
      NFL_STATUS.live = (d.events || []).some(e => ((e.status || {}).type || {}).state === "in");
      NFL_STATUS.at = Date.now();
    } catch (_) { /* unknown: fall back to the kickoff-time window */ }
  }
  function renderTicker() {
    let el = document.getElementById("ticker");
    const cur = window.LEAGUE_DATA && window.LEAGUE_DATA[IDX.current];
    const now = Date.now();
    const window4h = cur && !cur.league.over && (cur.nflGames || []).some(g => !g.tbd && g.date && now >= Date.parse(g.date) && now < Date.parse(g.date) + 4 * 3600e3);
    // inside a game window, ESPN's NFL scoreboard (checked each minute) says whether a game is actually still on,
    // so the bar goes away as soon as the last game ends instead of 4 hours after its kickoff
    const on = window4h && (NFL_STATUS.at && now - NFL_STATUS.at < 5 * 60e3 ? NFL_STATUS.live : true);
    const wk = on && cur.weeks.find(w => w.week === cur.league.currentWeek && !w.final);
    if (!wk) { if (el) { el.remove(); document.body.classList.remove("has-ticker"); } return; }
    const tm = Object.fromEntries(cur.teams.map(t => [t.id, t]));
    const short = t => esc(t ? (t.abbrev || t.name.slice(0, 4)).toUpperCase() : "?");
    const mine = g => g.sides.some(sd => isMine(tm[sd.team])) ? 0 : 1;
    const games = wk.games.filter(g => g.sides.length === 2).sort((a, b) => mine(a) - mine(b)).map(g => {
      const [a, b] = g.sides, lead = a.pts > b.pts ? 0 : b.pts > a.pts ? 1 : -1;
      const side = (sd, i) => `<span class="tk-side${lead === i ? " tk-lead" : ""}"><span class="tk-abbr">${short(tm[sd.team])}</span><span class="tk-pts">${sd.pts.toFixed(1)}</span></span>`;
      return `<span class="tk-game${mine(g) ? "" : " mine"}">${side(a, 0)}${side(b, 1)}</span>`;
    });
    const run = games.join("");
    if (!el) {
      el = document.createElement("a");
      el.id = "ticker"; el.className = "ticker";
      document.body.appendChild(el);
      document.body.classList.add("has-ticker");
    }
    el.href = "#/matchups";
    el.setAttribute("aria-label", "Live scores: open matchups");
    // two copies back to back so the crawl loops without a gap; the speed follows the length
    el.innerHTML = `<span class="tk-live">LIVE</span><span class="tk-track" style="--tk-dur:${Math.max(25, games.length * 7)}s"><span class="tk-run">${run}</span><span class="tk-run" aria-hidden="true">${run}</span></span>`;
  }
  function updateLiveChip() {
    const chip = document.getElementById("live-chip");
    if (!chip || !live.on) return;
    chip.className = "live-chip on";
    chip.textContent = LIVE_API
      ? "Live · scores update every minute" + (liveAsOf ? " · as of " + new Date(liveAsOf).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "")
      : "Live · checking every minute";
  }
  function startLive() {
    const cur = window.LEAGUE_DATA[IDX.current];
    if (!cur || cur.league.over || live.timer) return;
    live.on = true;
    live.timer = setInterval(poll, 60000);
    if (LIVE_API) { liveTick(); setInterval(liveTick, 60000); }
    updateLiveChip();
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { poll(); liveTick(); } });
  }

  // offline support (sw.js): keeps a saved copy of the site and its data on this device
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  // Pull to refresh, only when opened from the home screen: an installed app has no refresh button and iOS gives
  // it no pull-down gesture. Pulling down from the top of the page reloads everything fresh.
  // (?ptr=1 turns it on in a normal browser tab, for testing.)
  (function pullToRefresh() {
    const standalone = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
    if (!standalone && !/[?&]ptr=1/.test(location.search)) return;
    const el = document.createElement("div");
    el.className = "ptr";
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = '<span class="ptr-spin"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg></span><span class="ptr-txt">Pull to refresh</span>';
    document.body.appendChild(el);
    const txt = el.querySelector(".ptr-txt"), spin = el.querySelector(".ptr-spin");
    const TRIGGER = 80, MAX = 120;
    let startY = null, startX = 0, dist = 0, pulling = false, busy = false;
    function show(d) {
      el.style.transform = "translate(-50%," + (Math.min(d, MAX) - 60) + "px)";
      el.style.opacity = Math.min(1, d / 50);
      const ready = d >= TRIGGER;
      el.classList.toggle("ready", ready);
      spin.style.transform = "rotate(" + (ready ? 180 : 0) + "deg)";
      txt.textContent = ready ? "Release to refresh" : "Pull to refresh";
    }
    function reset() {
      el.classList.add("back");
      el.style.transform = ""; el.style.opacity = "";
      setTimeout(() => el.classList.remove("back", "ready"), 250);
    }
    document.addEventListener("touchstart", e => {
      if (busy || e.touches.length !== 1 || window.scrollY > 0 || document.querySelector(".share-modal")) { startY = null; return; }
      startY = e.touches[0].clientY; startX = e.touches[0].clientX; dist = 0; pulling = false;
    }, { passive: true });
    document.addEventListener("touchmove", e => {
      if (startY == null) return;
      const dy = e.touches[0].clientY - startY, dx = Math.abs(e.touches[0].clientX - startX);
      if (!pulling) {
        if (dy < 8 && dx < 8) return;
        if (dy <= 0 || dx > dy || window.scrollY > 0) { startY = null; return; } // scrolling up or swiping sideways
        pulling = true;
      }
      dist = Math.max(0, dy * 0.6); // some resistance, like the native gesture
      show(dist);
    }, { passive: true });
    function end() {
      if (startY == null || !pulling) { startY = null; return; }
      startY = null; pulling = false;
      if (dist < TRIGGER) { reset(); return; }
      busy = true;
      el.classList.add("busy");
      el.style.transform = "translate(-50%," + (TRIGGER - 60) + "px)";
      spin.style.transform = "";
      txt.textContent = "Refreshing…";
      // a full reload: the offline worker fetches pages and data from the network first, so this gets fresh copies
      setTimeout(() => location.reload(), 200);
    }
    document.addEventListener("touchend", end, { passive: true });
    document.addEventListener("touchcancel", end, { passive: true });
  })();

  window.addEventListener("offline", () => renderBanner());
  window.addEventListener("online", () => { renderBanner(); poll(); liveTick(); });

  // Opening the site with no page picked (the home-screen app always starts this way): on days with NFL games it
  // starts on Matchups, so checking scores takes no tapping; other days it starts on Standings. Links to a page,
  // reloads and pull-to-refresh keep whatever page is in the address.
  async function startPage() {
    if (location.hash && location.hash !== "#") return; // a page was picked (including "#/" = Standings)
    try {
      const cur = await loadSeason(IDX.current);
      const today = new Date().toDateString();
      const gameToday = !cur.league.over && (cur.nflGames || []).some(g => !g.tbd && new Date(g.date).toDateString() === today);
      if (gameToday) history.replaceState(null, "", location.pathname + location.search + "#/matchups");
    } catch (_) { /* no data: just open Standings */ }
  }

  startPage().then(route).then(startLive);
})();
