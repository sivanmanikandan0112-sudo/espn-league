(function () {
  "use strict";
  const D = window.LEAGUE;
  const main = document.getElementById("main");
  if (!D) {
    main.innerHTML = '<div class="empty">No league data yet. Run <code>python3 build.py</code>.</div>';
    return;
  }
  const POS = ["QB", "RB", "WR", "TE"];
  const INJ = { QUESTIONABLE: "Q", DOUBTFUL: "D", OUT: "OUT", INJURY_RESERVE: "IR", SUSPENSION: "SUSP", PROBABLE: "P", DAY_TO_DAY: "DTD" };
  const teamById = Object.fromEntries(D.teams.map(t => [t.id, t]));
  const L = D.league;
  const pad = n => String(n).padStart(2, "0");
  const fmt = n => Number(n).toFixed(2);
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const record = t => t.wins + "–" + t.losses + (t.ties ? "–" + t.ties : "");
  const initials = name => name.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";
  const logo = t => t.logo
    ? `<img class="logo" src="${esc(t.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-ini="${esc(initials(t.name))}">`
    : `<span class="logo">${esc(initials(t.name))}</span>`;
  const chev = '<svg class="chev" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 4l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

  // Broken logo -> initials bubble
  document.addEventListener("error", e => {
    const img = e.target;
    if (img.tagName === "IMG" && img.classList.contains("logo")) {
      const span = document.createElement("span");
      span.className = "logo";
      span.textContent = img.dataset.ini || "?";
      img.replaceWith(span);
    }
  }, true);

  // ---- header ----
  document.title = L.name + " · Standings, Matchups & Trades";
  document.getElementById("league-name").textContent = L.name;
  document.getElementById("season-label").textContent = L.season + " season";
  document.getElementById("week-label").textContent = L.currentWeek > L.regularSeasonWeeks ? "PLAYOFFS" : "WEEK " + pad(L.currentWeek);
  document.getElementById("teams-label").textContent = L.size + " teams · ESPN Fantasy";
  document.getElementById("tabs-season").textContent = L.season + (L.currentWeek > L.regularSeasonWeeks ? " Postseason" : " Regular season");
  document.getElementById("updated").textContent = "Data snapshot · " + new Date(D.updated).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

  // ---- remembered UI state (per viewer, best effort) ----
  const store = {
    get(k, d) { try { const v = localStorage.getItem("lhq:" + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem("lhq:" + k, JSON.stringify(v)); } catch (_) { /* ignore */ } },
  };
  const state = { sort: store.get("sort", "standing"), q: "", open: new Set(), sideWeek: L.currentWeek };

  // ---- standings ----
  const SORTS = {
    standing: ["League standing", (a, b) => a.standing - b.standing],
    power: ["Power ranking", (a, b) => a.powerRank - b.powerRank],
    pf: ["Points scored", (a, b) => b.pf - a.pf],
    QB: ["QB power", (a, b) => a.posRank.QB - b.posRank.QB],
    RB: ["RB power", (a, b) => a.posRank.RB - b.posRank.RB],
    WR: ["WR power", (a, b) => a.posRank.WR - b.posRank.WR],
    TE: ["TE power", (a, b) => a.posRank.TE - b.posRank.TE],
  };
  const maxPower = Math.max(...D.teams.map(t => POS.reduce((s, p) => s + t.posPower[p], 0)));

  function rankFor(t, i) {
    if (state.sort === "standing") return t.standing;
    if (state.sort === "power") return t.powerRank;
    if (POS.includes(state.sort)) return t.posRank[state.sort];
    return i + 1;
  }

  function playerCard(p) {
    const bench = p.slot === "BE" || p.slot === "IR";
    return `<div class="pcard${bench ? " bench" : ""}">
      <div class="pcard-top"><span class="slot ${esc(p.slot === "FLEX" ? p.pos : p.slot)}">${esc(p.slot)}</span><span>${esc(p.pos)}${p.team ? " · " + esc(p.team) : ""}</span></div>
      <div class="pname" title="${esc(p.name)}">${esc(p.name)}</div>
      <div class="pmeta"><span class="num" title="Rest-of-season rank among all ${esc(p.pos)}s, by ESPN projection (${Math.round(p.ros)} pts)">${p.rosRank ? "ROS " + esc(p.pos) + " " + p.rosRank : "ROS —"}</span>${p.injury ? `<span class="inj" title="${esc(p.injury.replace(/_/g, " "))}">${esc(INJ[p.injury] || p.injury.replace(/_/g, " "))}</span>` : ""}</div>
    </div>`;
  }

  function teamCard(t, i) {
    const open = state.open.has(t.id);
    const segs = POS.map(p => {
      const w = (t.posPower[p] / maxPower) * 100;
      return `<span class="seg ${p}" style="width:${w.toFixed(2)}%" title="${p}: ${Math.round(t.posPower[p])} projected pts · #${t.posRank[p]} in league">${t.posRank[p]}</span>`;
    }).join("");
    const starters = t.roster.filter(p => p.slot !== "BE" && p.slot !== "IR");
    const bench = t.roster.filter(p => p.slot === "BE" || p.slot === "IR");
    return `<article class="team${open ? " open" : ""}" data-id="${t.id}">
      <button class="team-head" aria-expanded="${open}" data-toggle="${t.id}">
        <span class="rank">${pad(rankFor(t, i))}</span>
        ${logo(t)}
        <span style="min-width:0"><div class="team-name">${esc(t.name)}</div><div class="team-mgr">${esc(t.manager)}</div></span>
        <span class="stats">
          <span class="stat"><div class="stat-k">Record</div><div class="stat-v">${record(t)}</div></span>
          <span class="stat"><div class="stat-k">Points for</div><div class="stat-v">${fmt(t.pf)}</div></span>
          <span class="stat"><div class="stat-k">Power value</div><div class="stat-v">${t.power.toLocaleString()}</div></span>
        </span>
        ${chev}
      </button>
      <div class="bar" aria-label="Position ranks: ${POS.map(p => p + " " + t.posRank[p]).join(", ")}">${segs}</div>
      ${open ? `<div class="team-body">
        <div class="facts">
          <span>League standing <b>#${t.standing}</b></span><span>Power rank <b>#${t.powerRank}</b></span>
          <span>Record <b>${record(t)}</b></span><span>Points for <b>${fmt(t.pf)}</b></span>
          <span>Points against <b>${fmt(t.pa)}</b></span><span>Streak <b>${esc(t.streak)}</b></span>
          <span><b>${t.roster.length}</b> players</span>
        </div>
        <div class="roster-title"><h3>Starting lineup</h3><span class="muted" style="font-size:12px">Rest-of-season position rank</span></div>
        <div class="roster">${starters.map(playerCard).join("")}</div>
        <div class="roster-title" style="margin-top:14px"><h3>Bench</h3></div>
        <div class="roster">${bench.map(playerCard).join("") || '<span class="muted">Empty</span>'}</div>
      </div>` : ""}
    </article>`;
  }

  function weekResults(w) {
    const wk = D.weeks.find(x => x.week === w);
    const rows = [];
    (wk ? wk.games : []).forEach(g => g.sides.forEach(s => rows.push({ team: teamById[s.team], pts: s.pts })));
    return { wk, rows };
  }

  function sidebar() {
    const { wk, rows } = weekResults(state.sideWeek);
    let winners = "";
    if (rows.length) {
      const hi = Math.max(...rows.map(r => r.pts)), lo = Math.min(...rows.map(r => r.pts));
      const tops = rows.filter(r => r.pts === hi), bots = rows.filter(r => r.pts === lo);
      const block = (label, val, list) => `
        <div class="panel-row"><span class="kicker">${label}</span>${list.length > 1 ? '<span class="kicker">Tied</span>' : ""}</div>
        <div class="big">${fmt(val)}<small>PTS</small></div>
        ${list.map(r => `<div class="mini-team">${logo(r.team)}${esc(r.team.name)}</div>`).join("")}`;
      winners = block("Highest score", hi, tops) + '<hr class="divider">' + block("Lowest score", lo, bots);
    }
    const opts = D.weeks.slice().reverse().map(w => `<option value="${w.week}"${w.week === state.sideWeek ? " selected" : ""}>Week ${w.week}</option>`).join("");
    const pl = D.teams.slice().sort((a, b) => a.powerRank - b.powerRank)[0];
    const pf = D.teams.slice().sort((a, b) => b.pf - a.pf)[0];
    return `<aside class="side">
      <section>
        <div class="section-head"><h2>Weekly winners &amp; losers</h2></div>
        <div class="panel">
          <label class="field" style="justify-content:space-between">Scoring week <select id="side-week">${opts}</select></label>
          <p class="note${wk && !wk.final ? " live" : ""}">${wk && !wk.final ? "Provisional · week in progress" : "Final"}</p>
          <hr class="divider">
          ${winners}
          <a class="cta" href="#/matchups?week=${state.sideWeek}">View Week ${state.sideWeek} matchups</a>
        </div>
      </section>
      <section>
        <div class="section-head"><h2>Setting the pace</h2></div>
        <div class="panel">
          <div class="leader"><span class="kicker">Power leader</span><span class="crown">01</span>
            <span><div class="mini-team">${logo(pl)}${esc(pl.name)}</div><div class="val">${pl.power.toLocaleString()} roster value</div></span></div>
          <div class="leader"><span class="kicker">Most points scored</span><span class="crown">01</span>
            <span><div class="mini-team">${logo(pf)}${esc(pf.name)}</div><div class="val">${fmt(pf.pf)} season points</div></span></div>
        </div>
      </section>
    </aside>`;
  }

  function renderStandings() {
    const q = state.q.trim().toLowerCase();
    let list = D.teams.slice().sort(SORTS[state.sort][1]);
    const ranked = list.map((t, i) => [t, i]);
    const shown = q ? ranked.filter(([t]) =>
      t.name.toLowerCase().includes(q) || t.manager.toLowerCase().includes(q) ||
      t.roster.some(p => p.name.toLowerCase().includes(q))) : ranked;
    const allOpen = D.teams.every(t => state.open.has(t.id));
    main.innerHTML = `<div class="layout">
      <section>
        <div class="section-head">
          <div><h1>League standings <span class="pill">${L.size} teams</span></h1>
          <p class="sub">The whole league. Every roster. All the power.</p></div>
          <button class="linkbtn" id="expand-all">${allOpen ? "Collapse all" : "Expand all"} →</button>
        </div>
        <div class="controls">
          <label class="search"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3.5 3.5" stroke="currentColor" stroke-width="1.6"/></svg>
            <input id="q" type="search" placeholder="Find a team, manager or player" value="${esc(state.q)}" aria-label="Search teams, managers, or players"></label>
          <label class="field">Sort by <select id="sort">${Object.entries(SORTS).map(([k, [label]]) => `<option value="${k}"${k === state.sort ? " selected" : ""}>${label}</option>`).join("")}</select></label>
        </div>
        <div class="legend"><span>Team / ${esc(SORTS[state.sort][0])}</span>${POS.map(p => `<span><i class="dot ${p}"></i>${p}</span>`).join("")}<span class="right">Bar numbers = position rank</span></div>
        <div class="teams" id="teams">${shown.length ? shown.map(([t, i]) => teamCard(t, i)).join("") : '<div class="empty">No team, manager or player matches that.</div>'}</div>
      </section>
      ${sidebar()}
    </div>`;
  }

  // ---- matchups ----
  function boxCol(side) {
    const t = teamById[side.team];
    const start = side.lineup.filter(p => p.slot !== "BE" && p.slot !== "IR");
    const bench = side.lineup.filter(p => p.slot === "BE" || p.slot === "IR");
    const line = (p, b) => `<div class="box-line${b ? " bench" : ""}"><span class="slot ${esc(p.slot === "FLEX" || b ? p.pos : p.slot)}" style="font-size:10px;font-weight:700;text-align:center">${esc(p.slot)}</span><span class="pn" title="${esc(p.name)} · ${esc(p.pos)} ${esc(p.team)}">${esc(p.name)}</span><span class="pp">${fmt(p.pts)}</span></div>`;
    return `<div class="box-col"><h4>${esc(t.name)}</h4>${start.map(p => line(p, false)).join("")}${bench.length ? '<div class="box-sep">BENCH</div>' + bench.map(p => line(p, true)).join("") : ""}</div>`;
  }

  function renderMatchups(params) {
    const w = Math.min(Math.max(parseInt(params.get("week"), 10) || L.currentWeek, 1), D.weeks.length);
    const wk = D.weeks.find(x => x.week === w);
    const open = params.get("game");
    const games = wk.games.map(g => {
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
      const live = !wk.final;
      const wp = live && a && a.winProb != null ? `${teamById[a.team].abbrev || "Home"} ${Math.round(a.winProb * 100)}% to win` : "";
      return `<article class="game">
        <button class="game-btn" data-game="${g.id}" aria-expanded="${isOpen}">${row(a)}${row(b)}
          <div class="game-foot"><span>${g.playoff ? "Playoffs · " : ""}${live ? "In progress" : "Final"}${wp ? " · " + esc(wp) : ""}</span><span>${isOpen ? "Hide box score ↑" : "Box score ↓"}</span></div>
        </button>
        ${isOpen && a && b ? `<div class="box">${boxCol(a)}${boxCol(b)}</div>` : ""}
      </article>`;
    }).join("");
    main.innerHTML = `
      <div class="section-head"><div><h1>Week ${w} matchups</h1><p class="sub">${wk.final ? "Final scores." : "Live scores · week in progress."} Tap a matchup for the box score.</p></div></div>
      <div class="week-strip" role="tablist">${D.weeks.map(x => `<button data-week="${x.week}" class="${x.week === w ? "active" : ""}" role="tab" aria-selected="${x.week === w}">Wk ${x.week}</button>`).join("")}</div>
      <div class="games">${games}</div>`;
    const active = main.querySelector(".week-strip .active");
    if (active) active.scrollIntoView({ block: "nearest", inline: "center" });
  }

  // ---- trades ----
  function renderTrades() {
    const body = D.trades.map(tr => {
      const sides = tr.sides.map(s => {
        const t = teamById[s.team];
        return `<div class="trade-side"><div class="mini-team">${logo(t)}<span><div>${esc(t.name)}</div><div class="team-mgr">${esc(t.manager)}</div></span></div>
          <div class="gets">Receives</div>
          ${s.gets.map(p => `<div class="tplayer"><span class="slot ${esc(p.pos)}" style="font-size:11px;font-weight:700">${esc(p.pos || "—")}</span>${esc(p.name)}<span class="muted" style="font-size:12px">${esc(p.team)}</span></div>`).join("")}</div>`;
      });
      const swap = '<div class="swap"><svg width="22" height="22" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5h11l-3-3M14 11H3l3 3" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></div>';
      return `<article class="trade"><div class="trade-head"><span>${new Date(tr.date).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</span><span>${tr.sides.reduce((n, s) => n + s.gets.length, 0)} players</span></div>
        <div class="trade-body">${sides.join(swap)}</div></article>`;
    }).join("");
    main.innerHTML = `<div class="section-head"><div><h1>Trade history <span class="pill">${D.trades.length} trades</span></h1><p class="sub">Every deal that went through this season, newest first.</p></div></div>
      <div class="trades">${body || '<div class="empty">No trades yet this season.</div>'}</div>`;
  }

  // ---- routing ----
  function route() {
    const hash = location.hash.replace(/^#/, "") || "/";
    const [path, qs] = hash.split("?");
    const params = new URLSearchParams(qs || "");
    const tab = path.startsWith("/matchups") ? "matchups" : path.startsWith("/trades") ? "trades" : "standings";
    document.querySelectorAll(".tabs a").forEach(a => {
      a.classList.toggle("active", a.dataset.tab === tab);
      if (a.dataset.tab === tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (tab === "matchups") renderMatchups(params);
    else if (tab === "trades") renderTrades();
    else renderStandings();
  }
  window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });

  // ---- events (delegated) ----
  main.addEventListener("click", e => {
    const toggle = e.target.closest("[data-toggle]");
    if (toggle) {
      const id = Number(toggle.dataset.toggle);
      state.open.has(id) ? state.open.delete(id) : state.open.add(id);
      const t = teamById[id];
      const i = D.teams.slice().sort(SORTS[state.sort][1]).indexOf(t);
      toggle.closest(".team").outerHTML = teamCard(t, i);
      return;
    }
    if (e.target.closest("#expand-all")) {
      const allOpen = D.teams.every(t => state.open.has(t.id));
      state.open = allOpen ? new Set() : new Set(D.teams.map(t => t.id));
      renderStandings();
      return;
    }
    const wkBtn = e.target.closest("[data-week]");
    if (wkBtn) { location.hash = "#/matchups?week=" + wkBtn.dataset.week; return; }
    const game = e.target.closest("[data-game]");
    if (game) {
      const params = new URLSearchParams((location.hash.split("?")[1]) || "");
      params.set("game", params.get("game") === game.dataset.game ? "" : game.dataset.game);
      if (!params.get("game")) params.delete("game");
      history.replaceState(null, "", "#/matchups?" + params.toString());
      renderMatchups(params);
    }
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
    if (e.target.id === "side-week") {
      state.sideWeek = Number(e.target.value);
      document.querySelector(".side").outerHTML = sidebar();
    }
  });

  route();
})();
