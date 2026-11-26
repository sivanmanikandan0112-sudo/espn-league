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
  // A brand-new visitor on this device (nothing saved yet): the getting-started tour opens for them. Read here, before
  // the first page render records a visit.
  const NEW_VISITOR = store.get("tour", null) == null && store.get("last-visit", null) == null && !store.get("me", "") && !store.get("pk-member", "");
  // Compact mode (per device): tighter tables, cards and spacing, one-line explanations everywhere
  function setCompact(on) {
    document.documentElement.classList.toggle("compact", on);
    store.set("compact", on);
    document.querySelectorAll("[data-compact]").forEach(b => { b.setAttribute("aria-pressed", on); if (b.type === "checkbox") b.checked = on; });
  }
  setCompact(!!store.get("compact", false));
  document.addEventListener("change", e => {
    if (e.target.matches && e.target.matches("input[data-compact]")) setCompact(e.target.checked);
  });

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
    const tab = ["playoffs", "myteam", "matchups", "games", "insights", "trades", "history", "settings", "whatsnew", "glossary", "feedback"].find(t => path.startsWith("/" + t)) || "standings";
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
    updateWhatsNewDot();
    if (tab === "playoffs") renderPlayoffs();
    else if (tab === "matchups") renderMatchups();
    else if (tab === "games") renderGames();
    else if (tab === "insights") renderInsights();
    else if (tab === "trades") renderTrades();
    else if (tab === "history") renderHistory();
    else if (tab === "settings") renderSettings();
    else if (tab === "whatsnew") renderWhatsNew();
    else if (tab === "glossary") renderGlossary();
    else if (tab === "feedback") renderFeedback();
    else if (tab === "myteam") renderMyTeam();
    else renderStandings();
    rxHydrate();
    talkHydrate();
    pulseLoad();
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
    document.getElementById("footer-notes").innerHTML = `<details class="how"${wide ? " open" : ""}><summary>How these numbers work</summary>${footerNotes()}</details><p class="foot-links"><a href="#/glossary">Glossary: every stat and term on the site ›</a><a href="#/feedback">Suggest something / report a problem ›</a></p>`;
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
    if (state.tab === "playoffs") {
      return `<p>Playoff, bye and title odds, seed odds and the tiebreaker race come from 10,000 simulated finishes of the rest of the regular season and the bracket; this week's games use ESPN's live win probabilities. Clinched and eliminated are exact, worked out from every possible result left. Ties in the standings go to total points.</p>`;
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


  // ---------------------------------------------------------------- nflverse usage, role and practice (build: nfldata.py)
  // Only in the current season's data (D.nfl). Expected points use the model's own PPR scoring, not this league's.
  const nflP = id => (L.isCurrent && D.nfl && D.nfl.players && D.nfl.players[String(id)]) || null;
  const PRAC = { DNP: "Did not practice", LP: "Limited", FP: "Full" };
  const pracInjury = i => i && /^Not injury related/i.test(i) ? "rest" : i;
  function usageChips(id) {
    const x = nflP(id);
    if (!x) return "";
    const out = [];
    if (x.tag && x.avg) out.push(`<span class="uchip ${x.tag}" title="Last ${x.avg[2]} games: ${x.avg[0].toFixed(1)} pts a game; his usage was worth ${x.avg[1].toFixed(1)} (expected points, PPR)">${x.tag === "due" ? "▲ Due" : "▼ Hot"}</span>`);
    if (x.role && x.roleWhy) {
      const [s0, s1, t0, t1] = x.roleWhy;
      out.push(`<span class="uchip role-${x.role}" title="Last 2 games vs. the 3 before: snaps ${s0}% → ${s1}%${t0 != null && t1 != null ? `, targets ${t0}% → ${t1}% of the team's` : ""}">Role ${x.role === "up" ? "↑" : "↓"}</span>`);
    }
    return out.join("");
  }
  function practiceText(id, short) {
    const x = nflP(id), pr = x && x.pr;
    if (!pr) return "";
    const log = (pr.log || []).map(([d, st]) => `${short ? st : PRAC[st] || st} ${esc(d)}`).join(" → ");
    const inj = pracInjury(pr.i);
    return [log ? (short ? log : "Practice: " + log) : "", pr.g ? `<b>${esc(pr.g)}</b>` : "", inj ? esc(inj) : ""].filter(Boolean).join(" · ");
  }
  const practiceWorry = id => { const pr = (nflP(id) || {}).pr; return !!pr && (["DNP", "LP"].includes(pr.s) || ["Out", "Doubtful", "Questionable"].includes(pr.g)); };
  function usagePanel(id) {
    const x = nflP(id);
    if (!x) return "";
    const parts = [];
    if (x.avg) parts.push(`<p class="u-line"><b>Usage:</b> ${x.avg[0].toFixed(1)} pts a game over his last ${x.avg[2]}; his usage was worth <b>${x.avg[1].toFixed(1)}</b>${x.tag ? ` ${usageChips(id).split("</span>")[0]}</span>` : ""}. <span class="muted">Expected points from targets, carries, air yards and field position (nflverse, PPR).</span></p>`);
    if (x.u && x.u.length) parts.push(`<table class="u-strip"><thead><tr><th></th>${x.u.map(r => `<th>Wk ${r[0]}</th>`).join("")}</tr></thead><tbody>
      <tr><th>Snaps</th>${x.u.map(r => `<td>${r[1] != null ? `<span class="u-bar"><span style="width:${r[1]}%"></span></span>${r[1]}%` : "—"}</td>`).join("")}</tr>
      ${x.u.some(r => r[2]) ? `<tr><th>Targets</th>${x.u.map(r => `<td>${r[2] != null ? r[2] + "%" : "—"}</td>`).join("")}</tr>` : ""}</tbody></table>`);
    if (x.pr) parts.push(`<p class="u-line">${practiceText(id)}</p>`);
    return parts.length ? `<div class="u-panel">${parts.join("")}</div>` : "";
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
      const chips = usageChips(p.id), prac = practiceText(p.id, true);
      if (chips) rankLine += chips;
      if (prac) extra += `<div class="pprac" title="This week's official injury report">${prac}</div>`;
    }
    return `<div class="pcard${bench ? " bench" : ""}">
      <div class="pcard-top"><span class="slot ${esc(slotCls)}">${esc(p.slot)}</span><span>${esc(p.pos)}${p.team ? " · " + esc(p.team) : ""}</span></div>
      <div class="pname" title="${esc(p.name)}">${esc(p.name)}</div>
      <div class="pmeta">${rankLine}</div>${extra}
    </div>`;
  }

  // Why a team's power moved since this power window started (build.py add_power_moves)
  const STATUS_WORD = { ACTIVE: "healthy", OUT: "out", INJURY_RESERVE: "on IR", QUESTIONABLE: "questionable", DOUBTFUL: "doubtful", SUSPENSION: "suspended", DAY_TO_DAY: "day to day", PROBABLE: "probable" };
  function movedArrow(t) {
    const M = t.moved;
    if (!M || L.over || !t.powerRank) return "";
    const d = M.rank0 - t.powerRank;
    return d ? `<span class="mv-arrow ${d > 0 ? "up" : "down"}" title="Power rank ${d > 0 ? "up" : "down"} ${Math.abs(d)} since ${esc(movedSince(M))}">${d > 0 ? "▲" : "▼"}${Math.abs(d)}</span>` : "";
  }
  const movedSince = M => new Date(M.since).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  function movedHtml(t) {
    const M = t.moved;
    if (!M || L.over) return "";
    const d = M.rank0 - t.powerRank;
    const rank = d ? `<b class="${d > 0 ? "pos" : "neg"}">${d > 0 ? "▲" : "▼"}${Math.abs(d)}</b> to #${t.powerRank}` : `steady at #${t.powerRank}`;
    const pts = x => `<b class="${x > 0 ? "pos" : x < 0 ? "neg" : ""}">${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(1)}</b>`;
    const sum = xs => xs.reduce((n, x) => n + x.pts, 0);
    const groups = [
      ["Injuries", M.injury, x => `${esc(x.n)} <span class="muted">(${esc(STATUS_WORD[x.was] || x.was)} → ${esc(STATUS_WORD[x.status] || x.status)})</span>`],
      ["Roster moves", M.moves, x => `${esc(x.how[0].toUpperCase() + x.how.slice(1))} ${esc(x.n)}`],
      ["Projection changes", M.proj, x => `${esc(x.n)} <span class="muted">(ESPN rest of season ${x.ros > 0 ? "+" : "−"}${Math.abs(x.ros).toFixed(1)})</span>`],
    ].filter(([, xs]) => xs.length);
    const lines = groups.map(([label, xs, item]) => `<div class="mv-g"><div class="mv-gh"><span>${label}</span>${pts(sum(xs))}</div>${xs.slice(0, 4).map(x => `<div class="mv-i"><span>${item(x)}</span>${pts(x.pts)}</div>`).join("")}${xs.length > 4 ? `<div class="mv-i muted">+${xs.length - 4} more</div>` : ""}</div>`);
    if (Math.abs(M.reshuffle) >= 1) lines.push(`<div class="mv-g"><div class="mv-gh"><span>Lineup reshuffle <span class="muted">(who starts when, after the changes above)</span></span>${pts(M.reshuffle)}</div></div>`);
    if (Math.abs(M.other) >= 1) lines.push(`<div class="mv-g"><div class="mv-gh"><span>Other <span class="muted">(empty lineup spots, rounding)</span></span>${pts(M.other)}</div></div>`);
    const head = `Since ${esc(movedSince(M))}: power ${M.power0.toLocaleString()} → ${t.power.toLocaleString()} (${pts(M.diff).replace(".0<", "<")}), rank ${rank}.`;
    return `<div class="mv">${expl(head, head + " Each line is how many expected lineup points (power value) that change added or cost. The rank can also move because other teams changed.", "moved")}${lines.length ? lines.join("") : '<p class="muted mv-none">Nothing has changed yet.</p>'}</div>`;
  }

  // ---------------------------------------------------------------- clinch & elimination (league.clinch, from the build)
  // Exact, with points tiebreakers treated as unknown: IN / BYE / OUT tags in Standings, the week's scenarios in plain
  // words (the Playoff picture section, and yours on My team).
  const clinchOf = tid => (L.clinch && L.isCurrent && !L.over && (L.clinch.teams || {})[String(tid)]) || null;
  function clinchTag(t) {
    const c = clinchOf(t.id);
    if (!c) return "";
    const n = c.now || {};
    if (n.bye === "in") return ' <span class="cl-tag in" title="Clinched a first-round bye">BYE</span>';
    if (n.po === "in") return ' <span class="cl-tag in" title="Clinched a playoff spot">IN</span>';
    if (n.po === "out") return ' <span class="cl-tag out" title="Eliminated from the playoffs">OUT</span>';
    return "";
  }
  // one way of getting there: "you win and Strib Club beats Drake ft. Drake"
  function clinchWay(way, tid, you) {
    const games = L.clinch.games;
    const bits = way.map(([i, side]) => {
      const [a, b] = games[i], w = side === 0 ? a : b, l = side === 0 ? b : a;
      if (w === tid) return [0, you ? "you win" : "they win"];
      if (l === tid) return [0, you ? "you lose" : "they lose"];
      return [1, `${esc(tname(w))} beats ${esc(tname(l))}`];
    }).sort((x, y) => x[0] - y[0]).map(x => x[1]);
    return bits.join(" and ");
  }
  function clinchLines(tid, you) {
    const c = clinchOf(tid);
    if (!c || !c.week) return [];
    const who = you ? "You" : esc(tname(tid));
    const verb = (lvl, goal) => goal === "in" ? `${you ? "clinch" : "clinches"} ${lvl === "bye" ? "a first-round bye" : "a playoff spot"}`
      : lvl === "po" ? `${you ? "are" : "is"} eliminated` : `${you ? "lose your" : "loses their"} shot at a bye`;
    return c.week.map(x => ({ goal: x.goal, level: x.level,
      html: `${who} ${verb(x.level, x.goal)} if ${x.ways.map(w => clinchWay(w, tid, you)).join(", <b>or</b> if ")}.` }));
  }
  function clinchSection() {
    const C = L.clinch;
    if (!C || !L.isCurrent || L.over || !C.teams) return "";
    const order = D.teams.slice().sort((a, b) => a.standing - b.standing);
    const settled = (lvl, goal) => order.filter(t => ((clinchOf(t.id) || {}).now || {})[lvl] === goal);
    const list = ts => ts.map(t => esc(t.name)).join(", ");
    const head = [
      settled("bye", "in").length ? `<b>Clinched a bye:</b> ${list(settled("bye", "in"))}` : "",
      settled("po", "in").filter(t => clinchOf(t.id).now.bye !== "in").length ? `<b>Clinched a playoff spot:</b> ${list(settled("po", "in").filter(t => clinchOf(t.id).now.bye !== "in"))}` : "",
      settled("po", "out").length ? `<b>Eliminated:</b> ${list(settled("po", "out"))}` : "",
    ].filter(Boolean);
    const rows = order.map(t => ({ t, lines: clinchLines(t.id, false) })).filter(r => r.lines.length);
    if (!head.length && !rows.length) return "";
    return section(`Playoff picture <span class="muted">· week ${C.week}</span>`, { short: "Who's clinched, who's out, and what this week's results can settle.",
      full: `Worked out exactly from the remaining schedule: a team has clinched only if no combination of results can push it out of the top ${L.playoffTeams || 6}, and it's eliminated only if none can get it in. Ties in the standings are broken by total points, which can't be known ahead of time, so they're treated as going against a team for clinching and in its favor for elimination; a team can still get in (or out) on points beyond what's shown (the Tiebreaker race below has the odds on that). The scenarios list the fewest results this week that settle it, whatever happens after.${C.byes ? ` The top ${C.byes} get a first-round bye.` : ""}` },
      `<div class="panel cl-pic">${head.length ? `<p class="cl-head">${head.join("<br>")}</p>` : ""}${rows.map(r => `<div class="cl-row"><div class="cl-team">${logo(r.t)}<b>${esc(r.t.name)}</b>${clinchTag(r.t)}</div>${r.lines.map(l => `<p class="cl-line ${l.goal}">${l.html}</p>`).join("")}</div>`).join("")}${insightHas("build") ? `<p class="cl-more"><a class="wk-link" href="${href("playoffs", {}, "scenarios")}">Build your own scenario ›</a></p>` : ""}</div>`);
  }

  // ---------------------------------------------------------------- tiebreaker race (league.tieRace + team.odds.ties/projPF, build)
  // Ties in the standings go to total points. From the same simulations as the playoff odds: how often each cut ends with
  // teams level on wins across it, who's usually in that tie, who wins it, and the points gap now and at projections.
  const TIE_CUTS = { po: ["playoff line", "the last playoff spot"], bye: ["bye line", "the last first-round bye"] };
  const tieRace = () => (L.tieRace && L.isCurrent && !L.over) ? L.tieRace : null;
  const pts1 = n => Math.abs(n).toFixed(1);
  // points for including this week's points so far (ESPN's total only counts finished weeks)
  const trWeek = () => (D.weeks || []).find(w => w.week === L.currentWeek && !w.final && w.week <= L.regularSeasonWeeks && w.games.some(g => g.sides.some(s => s.pts > 0)));
  function pfNow(t) {
    const w = trWeek(), s = w && w.games.flatMap(g => g.sides).find(x => x.team === t.id);
    return t.pf + (s ? s.pts || 0 : 0);
  }
  function tiePairLine(pair) {
    const [a, b, p, aw] = pair, A = teamById[a], B = teamById[b];
    if (!A || !B || !A.odds || !B.odds) return "";
    const [W, O] = aw >= 50 ? [A, B] : [B, A], wp = Math.max(aw, 100 - aw);
    const [P, Q] = A.odds.projPF >= B.odds.projPF ? [A, B] : [B, A];
    const now = pfNow(P) - pfNow(Q), fin = P.odds.projPF - Q.odds.projPF;
    const after = Math.max(0, (Q.odds.gamesLeft || 0) - (trWeek() ? 1 : 0));
    const nm = t => `<b>${esc(t.name)}</b>`;
    const lead = Math.abs(now) < 0.05 ? "They're even on points right now" : now > 0 ? `${nm(P)} leads by ${pts1(now)} points now` : `${nm(Q)} leads by ${pts1(now)} points now`;
    const gap = fin < 5 ? `${lead}, and they're within ${pts1(fin)} of each other at projections, so it's open.`
      : `${lead}${now > 0.05 ? " and projects" : `, but ${nm(P)} projects`} to finish ${pts1(fin)} ahead, so ${nm(Q)} would need to beat their projections by about ${pts1(fin)} points${after > 1 ? ` (${pts1(fin / after)} a week over the last ${after}${trWeek() ? " after this one" : ""})` : ""} to ${now < -0.05 ? "stay ahead" : "catch up"}.`;
    return `<p class="tr-pair">${nm(W)} vs. ${nm(O)}: level on wins across the line in ${pct(p)} of finishes. ${nm(W)} wins that on points ${pct(wp)} of the time. ${gap}</p>`;
  }
  function tieRaceSection() {
    const R = tieRace();
    if (!R) return "";
    const parts = ["po", "bye"].filter(k => R[k] && R[k].pct >= 3).map(k => {
      const rows = D.teams.filter(t => t.odds && t.odds.ties && t.odds.ties[k] && t.odds.ties[k][0] >= 2)
        .sort((a, b) => b.odds.ties[k][0] - a.odds.ties[k][0]);
      if (!rows.length) return "";
      const pairs = (R[k].pairs || []).filter(x => x[2] >= 3).slice(0, 3);
      return `<div class="tr-cut"><h3 class="tr-h">${k === "po" ? "Last playoff spot" : "Last bye"} <span class="muted">(#${R[k].cut})</span>: decided on points in <b>${pct(R[k].pct)}</b> of finishes</h3>
        ${table([
          { label: "Team", cell: teamCell },
          { label: "Record", num: 1, cell: t => record(t) },
          { label: "Points for", num: 1, cell: t => fmt(pfNow(t)) },
          { label: "Projected", num: 1, cell: t => t.odds.projPF.toFixed(1) },
          { label: "In a tie", num: 1, cell: t => pct(t.odds.ties[k][0]) },
          { label: "Wins it", num: 1, cell: t => t.odds.ties[k][1] == null ? '<span class="muted">—</span>' : pct(t.odds.ties[k][1]) },
        ], rows)}
        ${pairs.map(tiePairLine).join("")}</div>`;
    }).filter(Boolean);
    if (!parts.length) return "";
    return section("Tiebreaker race", { short: "When teams finish level on wins, total points decide it. How often that happens at the playoff and bye lines, and who's ahead.",
      full: `From the same 10,000 simulated finishes as the playoff odds. "In a tie" is how often a team ends level on wins with someone on the other side of the line, so the spot goes to whoever scored more; "Wins it" is how often it ends up on the right side when that happens (— when it's too rare to say). Points for includes this week's points so far; Projected adds the average of the simulated rest of the regular season (this week from ESPN's live projection). The pairs are the teams that meet in that tie most often.` },
      parts.join(""));
  }
  // My team: one line when points are likely to matter for your spot
  function tieRaceMine(t) {
    if (!tieRace() || !t.odds || !t.odds.ties) return "";
    const out = ["po", "bye"].map(k => {
      const x = t.odds.ties[k];
      if (!x || x[0] < 5) return "";
      const rival = ((tieRace()[k] || {}).pairs || []).filter(p => p[0] === t.id || p[1] === t.id).sort((a, b) => b[2] - a[2])[0];
      const rv = rival ? teamById[rival[0] === t.id ? rival[1] : rival[0]] : null;
      return `You finish level on wins at the ${TIE_CUTS[k][0]} in ${pct(x[0])} of finishes${rv ? `, most often with ${esc(rv.name)}` : ""}${x[1] != null ? `, and win it on points ${pct(x[1])} of the time` : ""}.`;
    }).filter(Boolean);
    return out.join(" ");
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
        <span class="rank">${pad(rankFor(t, i))}${state.sort === "power" ? movedArrow(t) : ""}</span>
        ${logo(t)}
        <span style="min-width:0"><div class="team-name">${isMine(t) ? '<span class="me-tag">You</span>' : ""}${esc(t.name)}${clinchTag(t)}</div><div class="team-mgr">${esc(t.manager)}</div></span>
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
        ${t.moved && !L.over ? `<div class="roster-title"><h3>Why the power ${t.moved.diff ? "moved" : "rank moved"}</h3></div>${movedHtml(t)}` : ""}
        <div class="roster-title"><h3>${L.over ? "Final roster · starters" : "Starting lineup"}</h3><span class="muted" style="font-size:12px">${L.over ? "Final position rank · season points" : "ROS position rank · expected starts, weeks " + PW()}</span></div>
        <div class="roster">${starters.map(playerCard).join("")}</div>
        <div class="roster-title" style="margin-top:14px"><h3>Bench</h3></div>
        <div class="roster">${bench.map(playerCard).join("") || '<span class="muted">Empty</span>'}</div>
      </div>` : ""}
    </article>`;
  }

  // ---------------------------------------------------------------- League pulse (Standings sidebar)
  // What people have been doing on the site lately, from the live worker (never what anyone picked).
  const PULSE = { events: null, at: 0, all: false };
  const pulseOn = () => state.season === IDX.current && !!LIVE_API_BASE();
  const PULSE_SHOWN = 6;
  function pulseAgo(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return "now";
    if (m < 60) return m + "m";
    if (m < 24 * 60) return Math.round(m / 60) + "h";
    return new Date(t).toLocaleDateString([], { weekday: "short" });
  }
  function pulseLine(e) {
    const who = `<b>${esc(nameOfMember(e.m))}</b>`;
    const cur = window.LEAGUE_DATA[IDX.current];
    let what = "", link = "#/games";
    if (e.k === "react") {
      const [kind, id] = String(e.i || "").split(":");
      let target = "something";
      if (kind === "g") {
        const g = cur && (cur.weeks.find(w => w.week === e.w) || { games: [] }).games.find(x => String(x.id) === id);
        const nm = t => esc(((cur.teams.find(x => x.id === t) || {}).name || "?"));
        target = g && g.sides.length === 2 ? `${nm(g.sides[0].team)} vs. ${nm(g.sides[1].team)}` : `a week ${e.w} matchup`;
        link = href("matchups", { week: e.w, game: id });
      } else if (kind === "p") {
        const [pid, t] = id.split("-");
        const play = window.LIVE_FEED && (window.LIVE_FEED.events || []).find(x => String(x.pid) === pid && String(x.t) === t);
        target = play ? `${esc(play.name)}'s ${esc(play.label)}` : "a big play";
        link = "#/matchups/plays";
      } else {
        target = `week ${e.w}'s ${kind === "hi" ? "high" : "low"} score`;
        link = "#/";
      }
      what = `reacted ${esc(e.e)} to ${target}`;
    } else if (e.k === "talk") {
      const [kind, id] = String(e.i || "").split(":");
      if (kind === "g") {
        const g = cur && (cur.weeks.find(w => w.week === e.w) || { games: [] }).games.find(x => String(x.id) === id);
        const nm = t => esc(((cur.teams.find(x => x.id === t) || {}).name || "?"));
        what = `talked trash on ${g && g.sides.length === 2 ? `${nm(g.sides[0].team)} vs. ${nm(g.sides[1].team)}` : `a week ${e.w} matchup`}`;
        link = href("matchups", { week: e.w });
      } else if (kind === "r") { what = `commented on the week ${id} recap`; link = href("matchups", { week: id }); }
      else { what = "commented on a trade"; link = "#/trades"; }
    } else {
      [what, link] = {
        pickem: [`made pick'em picks for week ${e.w}`, "#/games"],
        pick4: ["saved a Pick 4 lineup", "#/games/pick4"],
        fa: ["saved a waiver wire challenge lineup", "#/games/pick4"], // retired; old activity still says what happened
        bull: ["saved Bullseye picks", "#/games"], // Bullseye was retired; old activity still says what happened
        rank: ["ranked this week's Rank 'em", "#/games/rankem"],
        trivia: [`finished week ${e.w}'s trivia`, "#/games/trivia"],
        graph: ["played Guess the graph", "#/games/graph"],
        block: ["updated the trade block", "#/trades/block"],
      }[e.k] || ["did something", "#/"];
    }
    return `<a class="pulse-line" href="${link}"><span class="pulse-t">${pulseAgo(e.t)}</span><span>${who} ${what}</span></a>`;
  }
  const pulseSection = () => pulseOn() ? `<section class="pulse-sec"><div class="section-head"><h2>League pulse</h2></div><div class="panel pulse">${pulseInner()}</div></section>` : "";
  const pulsePaint = () => document.querySelectorAll(".pulse").forEach(b => { b.innerHTML = pulseInner(); });
  function pulseInner() {
    if (!PULSE.events) return '<p class="note">Loading…</p>';
    if (!PULSE.events.length) return '<p class="note">Nothing yet. Reactions, comments, game entries and trade block updates show up here.</p>';
    const list = PULSE.all ? PULSE.events : PULSE.events.slice(0, PULSE_SHOWN);
    return list.map(pulseLine).join("") + (PULSE.events.length > PULSE_SHOWN
      ? `<button type="button" class="linkbtn pulse-more" data-pulse-more>${PULSE.all ? "Show less" : `See all (${PULSE.events.length})`}</button>` : "");
  }
  async function pulseLoad() {
    if (!document.querySelector(".pulse") || !pulseOn()) return;
    if (PULSE.events && Date.now() - PULSE.at < 60000) return;
    const r = await pkApi("/pulse").catch(() => null);
    if (r && !r.error) { PULSE.events = r.events || []; PULSE.at = Date.now(); }
    else if (!PULSE.events) PULSE.events = [];
    pulsePaint();
  }
  document.addEventListener("click", e => {
    if (!e.target.closest("[data-pulse-more]")) return;
    PULSE.all = !PULSE.all;
    pulsePaint();
  });

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
      winners = block("Highest score", hi, rows.filter(r => r.pts === hi)) + rxRow(state.sideWeek, "hi:top") + '<hr class="divider">' + block("Lowest score", lo, rows.filter(r => r.pts === lo)) + rxRow(state.sideWeek, "lo:low");
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
      oddsLead = `<div class="leader"><span class="kicker">Title favorite</span><span class="crown">01</span><span><div class="mini-team">${logo(fav)}${esc(fav.name)}</div><div class="val">${pct(fav.odds.titlePct)} to win it all · <a href="${href("playoffs", {}, "odds")}">all odds</a></div></span></div>`;
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
      ${pulseSection()}
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
        if (Math.abs(b - a) >= 1) items.push(`Your playoff odds: <b>${pct(a)} → ${pct(b)}</b>. <a class="wk-link" href="${href("playoffs", {}, "odds")}">playoff race</a>`);
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
      if (c) items.push(tile("Champion", record(c), esc(c.name), href("playoffs", {}, "bracket")));
    } else {
      const pl = D.teams.slice().sort((a, b) => a.powerRank - b.powerRank)[0];
      items.push(tile("Power leader", pl.power.toLocaleString(), esc(pl.name), href("standings")));
    }
    if (D.teams.some(t => t.odds)) {
      const fav = D.teams.slice().sort((a, b) => b.odds.titlePct - a.odds.titlePct)[0];
      items.push(tile("Title favorite", pct(fav.odds.titlePct), esc(fav.name), href("playoffs", {}, "odds")));
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
        <div class="pulse-phone">${pulseSection()}</div>
      </section>
      ${sidebar()}
    </div>`;
    const sp = main.querySelector("#since-pickem");
    if (sp) pkApi("/pickem").then(d => {
      if (d && d.open && document.body.contains(sp)) {
        const lock = new Date(d.lockAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
        sp.innerHTML = `Week ${d.week} pick'em is open until ${esc(lock)}. <a class="wk-link" href="${href("games")}">Make your picks</a>`;
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
    const line = (p, b) => `<div class="box-line${b ? " bench" : ""}${hl && String(p.id) === hl ? " hl" : ""}" role="button" tabindex="0" data-stat="${p.id}" data-stat-week="${week}" title="See ${esc(p.name)}'s stat line"><span class="slot ${esc(POS.includes(p.slot) ? p.slot : p.pos)}" style="font-size:10px;font-weight:700;text-align:center">${esc(p.slot)}</span><span class="pn" title="${esc(p.name)} · ${esc(p.pos)} ${esc(p.team)}">${esc(p.name)}${hurtTag(p.id, week)}</span><span class="pp">${fmt(p.pts)}</span></div>`;
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
    return `<section class="recap"><div class="section-head"><h2>Week ${w} recap</h2><button type="button" class="share-btn" data-share="recap" data-week="${w}">${SHARE_ICON}Share</button></div><div class="recap-grid">${items.join("")}</div>${talkRow("w" + w, "r:" + w)}</section>`;
  }

  const MATCHUP_TABS = [["", "Weekly"], ["plays", "Big plays"], ["watch", "Watch guide"]];
  // The week the Matchups tabs show: ?week= when it's a week of this season, else this week (the last one once the
  // season is over). Weekly, Big plays and the Watch guide share it: their tabs and the week strip carry it along.
  function matchupWeek() {
    const weeks = D.weeks.map(x => x.week);
    let w = parseInt(state.params.get("week"), 10);
    if (!weeks.includes(w)) w = L.over ? weeks[weeks.length - 1] : L.currentWeek;
    if (!weeks.includes(w)) w = weeks[weeks.length - 1];
    return w;
  }
  const mWeekParam = () => { const w = state.params.get("week"); return w && D.weeks.some(x => String(x.week) === w) ? { week: w } : {}; };
  const matchupNav = cur => subnav("matchups", MATCHUP_TABS, cur, mWeekParam());
  const weekStrip = w => `<div class="week-strip" role="tablist">${D.weeks.map(x => `<button data-week="${x.week}" class="${x.week === w ? "active" : ""}${x.playoffs ? " po" : ""}" role="tab" aria-selected="${x.week === w}">${x.playoffs ? "PO " : "Wk "}${x.week}</button>`).join("")}</div>`;
  // the chosen week in the middle of the strip (sideways only, so the page doesn't jump)
  function centerWeekStrip() {
    const s = main.querySelector(".week-strip"), a = s && s.querySelector(".active");
    if (a) s.scrollLeft = a.offsetLeft - s.offsetLeft - (s.clientWidth - a.offsetWidth) / 2;
  }
  // is this the live week (the current season's week in progress)? Big plays and the Watch guide are live then
  const liveWeek = w => state.season === IDX.current && L.isCurrent && !L.over && w === L.currentWeek;
  // The NFL games of a week other than the live one (the build only has this week's): ESPN's scoreboard, read once
  // per week per visit. Returns the games, null while loading (the tab redraws when they arrive) or "error".
  const NFLWK = {};
  function nflGamesFor(week) {
    if (liveWeek(week)) return D.nflGames || [];
    const k = state.season + ":" + week;
    if (NFLWK[k] && NFLWK[k] !== "busy") return NFLWK[k];
    if (!NFLWK[k]) {
      NFLWK[k] = "busy";
      fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${state.season}&seasontype=2&week=${week}`)
        .then(r => r.json()).then(d => {
          NFLWK[k] = (d.events || []).map(e => {
            const c = (e.competitions || [])[0] || {};
            const side = h => (((c.competitors || []).find(x => x.homeAway === h) || {}).team || {}).abbreviation || "";
            return { id: e.id, date: e.date, tbd: false, home: side("home"), away: side("away") };
          }).sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.home.localeCompare(b.home));
        }).catch(() => { NFLWK[k] = "error"; })
        .then(() => { if (state.tab === "matchups" && (state.sub === "plays" || state.sub === "watch") && matchupWeek() === week) renderKeepScroll(renderMatchups); });
    }
    return null;
  }
  // Games: pick'em and league trivia (name + PIN), separate from the stats tabs
  const GAMES_TABS = [["", "Pick'em"], ["pick4", "Pick 4"], ["rankem", "Rank 'em"], ["graph", "Guess the graph"], ["trivia", "League trivia"]];
  function renderGames() {
    if (state.sub === "trivia") return renderTrivia();
    if (state.sub === "bullseye") { location.replace("#/games"); return; } // Bullseye was retired
    if (state.sub === "rankem") return renderRankem();
    if (state.sub === "graph") return renderGraph();
    if (state.sub === "pick4") return renderPick3();
    return renderPickem();
  }

  // Big plays from the live worker (TDs, field goals, turnovers, defensive plays, big gains), newest first.
  function feedFor(week, gameId) {
    const f = window.LIVE_FEED;
    if (!f || f.week !== week || state.season !== IDX.current) return [];
    return f.events.filter(e => gameId == null || String(e.game) === String(gameId)).sort((a, b) => b.t - a.t);
  }
  // highlight clip on ESPN for the play, when the worker found one (clips expire after about 2 days)
  const watchLink = e => e.vid && /^https:\/\/www\.espn\.com\//.test(e.vid.u) && !(e.vid.x && Date.now() > e.vid.x)
    ? ` <a class="play-vid" href="${esc(e.vid.u)}" target="_blank" rel="noopener" aria-label="Watch the highlight on ESPN">▶ Watch</a>` : "";
  // Links for a big play: that exact play on Real when Real lists it among the game's top plays (matched by player,
  // yards and kind; a passing TD by its catch, only when there's exactly one), otherwise the game on Real, plus ESPN
  // Gamecast. Current week only (the games are this week's).
  const normName = n => String(n || "").toLowerCase().replace(/['’.]/g, "").replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/[^a-z]+/g, " ").trim();
  function realPlayFor(e, g) {
    const yd = (/^(\d+)-yd/.exec(e.label || "") || [])[1];
    if (!yd || !g || !g.realPlays) return null;
    const cands = g.realPlays.map(([t, u]) => { const m = /^(.*?)\s+(\d+)-yd\s+(.*)$/.exec(t); return m ? { who: normName(m[1]), yd: m[2], what: m[3].toLowerCase(), u } : null; })
      .filter(c => c && c.yd === yd);
    if (e.kind === "passing TD") { const c = cands.filter(x => /\btd catch\b/.test(x.what)); return c.length === 1 ? c[0].u : null; }
    const mine = cands.filter(c => c.who === normName(e.name));
    return mine.length ? mine[0].u : null;
  }
  function playLinks(e) {
    try {
      if (!L.isCurrent || L.over || !e.nfl || (e.week && e.week !== L.currentWeek)) return "";
      const g = (D.nflGames || []).find(x => x.home === e.nfl || x.away === e.nfl);
      if (!g || !g.id) return "";
      // that exact play when it's in Real's top plays; otherwise the player's own game page on Real (where Real's
      // app lists his plays), otherwise the game
      const rp = realPlayFor(e, g), pp = !rp && g.realPlayers ? g.realPlayers[normName(e.name)] : null;
      return `<span class="play-links">${rp ? `<a class="play-ext real" href="${esc(rp)}" target="_blank" rel="noopener">This play on Real ↗</a>`
        : pp ? `<a class="play-ext real" href="${esc(pp)}" target="_blank" rel="noopener">His game on Real ↗</a>`
        : g.real ? `<a class="play-ext" href="${esc(g.real)}" target="_blank" rel="noopener">Game on Real ↗</a>` : ""}<a class="play-ext" href="https://www.espn.com/nfl/game/_/gameId/${encodeURIComponent(g.id)}" target="_blank" rel="noopener">Gamecast ↗</a></span>`;
    } catch (_) { return ""; }
  }
  function playLine(e) {
    const t = teamById[e.team] || { name: "Team " + e.team }, o = teamById[e.opp] || { name: "opponent" };
    const lead = e.score ? e.score[0] - e.score[1] : null;
    const status = lead == null ? "" : Math.abs(lead) < 0.005 ? `ties ${esc(o.name)}` : `${lead > 0 ? "leads" : "trails"} ${esc(o.name)} by ${Math.abs(lead).toFixed(2)}`;
    const when = new Date(e.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `<div class="play${e.starter ? "" : " bench"}"><span class="play-t">${when}</span>
      <span class="play-what"><b>${esc(e.name)}</b> <span class="muted">${esc(e.pos)}${e.nfl ? " · " + esc(e.nfl) : ""}</span> · ${esc(e.label)}${e.starter ? "" : ' <span class="muted">(bench)</span>'}${watchLink(e)}
      <span class="team-mgr">${esc(t.name)}${status ? " " + status : ""}</span>${playLinks(e)}${rxRow(e.week || L.currentWeek, `p:${e.pid}-${e.t}`)}</span>
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
  // Season view: totals from every week the live feed has covered (worker /plays)
  const PS = { data: null, at: 0 };
  const playsSwitch = cur => `<div class="pg-by ps-switch" role="tablist" aria-label="Big plays: one week or season">${[["", liveWeek(matchupWeek()) ? "This week" : "Week " + matchupWeek()], ["season", "Season"]].map(([k, lab]) =>
    `<a role="tab" aria-selected="${cur === k}" class="${cur === k ? "active" : ""}" href="${href("matchups", Object.assign(k ? { view: k } : {}, mWeekParam()), "plays")}">${lab}</a>`).join("")}</div>`;
  // an earlier week's plays from the worker (its stored copy of that week's feed), loaded once per visit
  const PWK = {};
  async function renderPlaysSeason(head) {
    if (state.season !== IDX.current || !LIVE_API_BASE()) { main.innerHTML = head + playsSwitch("season") + `<div class="empty">Season big plays are tracked for the current season.</div>`; return; }
    if (!PS.data || Date.now() - PS.at > 120000) {
      if (!PS.data) main.innerHTML = head + playsSwitch("season") + '<div class="empty">Adding up the season…</div>';
      PS.data = await pkApi("/plays").catch(() => ({ error: "Couldn't reach the server." })); PS.at = Date.now();
      if (state.tab !== "matchups" || state.sub !== "plays" || state.params.get("view") !== "season") return;
    }
    const S = PS.data;
    if (!S || S.error) { main.innerHTML = head + playsSwitch("season") + `<div class="empty">${esc((S && S.error) || "Couldn't load the season's big plays.")}</div>`; return; }
    if (!S.weeks.length) { main.innerHTML = head + playsSwitch("season") + '<div class="empty">No big plays recorded yet this season.</div>'; return; }
    const tn = id => { const t = teamById[id]; return t ? `<span class="tcell${isMine(t) ? " mine" : ""}">${logo(t)}<span class="tname">${esc(t.name)}</span></span>` : "?"; };
    const span = S.weeks.length === 1 ? `week ${S.weeks[0]}` : `weeks ${S.weeks[0]}–${S.weeks[S.weeks.length - 1]}`;
    const playRow = e => `<div class="rec"><span class="rec-v">+${e.delta.toFixed(1)}</span><span class="rec-who"><span class="slot ${esc(e.pos)}">${esc(e.pos)}</span><span><b>${esc(e.name)}</b> · ${esc(e.label)}<span class="team-mgr">${esc((teamById[e.team] || {}).name || "?")}${e.starter ? "" : " (bench)"}</span></span></span><a class="when" href="${href("matchups", { week: e.week, game: e.game, player: e.pid })}"><span>Wk ${e.week}</span><span class="go">Box score →</span></a></div>`;
    const teams = section("Team leaderboard", { short: `Big plays by each team's starters, ${span}.`, full: `Every big play from the live feed (touchdowns, 5+ point field goals, turnovers, big defensive plays, 30+ yard gains) by each team's players, ${span}${S.weeks[0] > 1 ? `; the feed started in week ${S.weeks[0]}` : ""}. <b>Points</b> is what those plays alone were worth. Bench plays are counted separately. Weeks 1–8 came before the live feed existed, so they were rebuilt from ESPN's play-by-play with the same rules and checked against each player's official stats.` }, table([
      { label: "Team", cell: r => tn(r.team) },
      { label: "Big plays", num: 1, cell: r => `<b>${r.plays}</b>` },
      { label: "TDs", num: 1, cell: r => r.tds },
      { label: "Points", num: 1, cell: r => r.pts.toFixed(1) },
      { label: "On the bench", num: 1, cell: r => r.bench ? `${r.bench} <span class="muted">(${r.benchPts.toFixed(1)} pts)</span>` : "0" },
    ], S.teams));
    // one position at a time (the overall list is all quarterbacks); old worker responses without byPos fall back to it
    const BP = S.byPos || null;
    const posKeys = BP ? ["QB", "RB", "WR", "TE", "K", "D/ST"].filter(k => (BP[k] || []).length).concat(Object.keys(BP).filter(k => !["QB", "RB", "WR", "TE", "K", "D/ST"].includes(k) && BP[k].length)) : [];
    const pos = posKeys.includes(store.get("plays-pos", "")) ? store.get("plays-pos", "") : posKeys[0];
    const playerTable = list => table([
      { label: "Player", cell: r => `<span class="tcell"><span class="slot ${esc(r.pos)}">${esc(r.pos)}</span><span><span class="tname">${esc(r.name)}</span><span class="team-mgr">${esc(r.nfl || "")} · ${r.teams.map(id => esc((teamById[id] || {}).name || "?")).join(", ")}</span></span></span>` },
      { label: "Big plays", num: 1, cell: r => `<b>${r.plays}</b>` },
      { label: "TDs", num: 1, cell: r => r.tds },
      { label: "Points", num: 1, cell: r => r.pts.toFixed(1) },
    ], list);
    const players = BP && posKeys.length
      ? section("Most big plays by position", { short: "The league's players with the most big plays at each position.", full: "Every league player's big plays this season (by whichever fantasy team had him at the time), top 10 at each position. Split by position because quarterbacks would fill the whole list: every touchdown pass and long completion counts for the passer too." },
          `<nav class="pg-by ins-switch bp-pos" aria-label="Position">${posKeys.map(k => `<a href="#" role="button" data-bp-pos="${esc(k)}" class="${k === pos ? "active" : ""}" aria-pressed="${k === pos}">${esc(k)}</a>`).join("")}</nav>`
          + posKeys.map(k => `<div class="bp-list" data-bp-list="${esc(k)}"${k === pos ? "" : " hidden"}>${playerTable(BP[k])}</div>`).join(""))
      : section("Most big plays by a player", "", playerTable(S.players));
    const big = section("Biggest single plays", "", `<div class="rec-card wrap">${S.biggest.map(playRow).join("")}</div>`);
    const bench = S.benchBest.length ? section("Best plays wasted on the bench", "", `<div class="rec-card wrap">${S.benchBest.map(playRow).join("")}</div>`) : "";
    main.innerHTML = head + playsSwitch("season") + `<p class="pg-sum">${L.season} season · ${span} · ${S.teams.reduce((n, t) => n + t.plays + t.bench, 0)} big plays</p>` + teams + big + players + bench;
    main.querySelectorAll("[data-bp-pos]").forEach(a => a.addEventListener("click", e => {
      e.preventDefault();
      const k = a.dataset.bpPos;
      store.set("plays-pos", k);
      main.querySelectorAll("[data-bp-pos]").forEach(x => { const on = x === a; x.classList.toggle("active", on); x.setAttribute("aria-pressed", on); });
      main.querySelectorAll("[data-bp-list]").forEach(x => { x.hidden = x.dataset.bpList !== k; });
    }));
  }

  function renderPlays() {
    const asked = state.params.get("by");
    const by = asked === "fantasy" || asked === "nfl" ? asked : store.get("plays-by", "nfl") === "fantasy" ? "fantasy" : "nfl";
    if (asked) store.set("plays-by", by);
    const w = matchupWeek(), live = liveWeek(w);
    const head = `<div class="section-head"><div><h1>Big plays</h1>${expl(`Every big play ${live ? "this week" : "in week " + w}, by NFL game or by fantasy matchup.`,
      "Touchdowns, field goals worth 5+ points, turnovers, defensive plays worth 5+ points (in practice defensive and return TDs), and single plays of 30+ yards (50+ for a pass), caught live from ESPN every minute during games. Each play shows the fantasy points that play alone was worth and where its fantasy matchup stood right after it. Bench players are marked.")}</div></div>${matchupNav("plays")}`;
    if (state.params.get("view") === "season") return renderPlaysSeason(head);
    const wk = D.weeks.find(x => x.week === w);
    const top = head + weekStrip(w);
    if (state.season !== IDX.current || !wk) { main.innerHTML = top + `<div class="empty">Big plays are kept for the current season only.${state.season !== IDX.current ? ` <a href="#/matchups/plays">Go to this week</a>` : ""}</div>`; return; }
    let all;
    if (live) {
      if (!window.LIVE_FEED) { main.innerHTML = top + `<div class="empty">Loading this week's plays…</div>`; return; }
      all = feedFor(w);
    } else {
      const P = PWK[w];
      if (!P || P === "busy") {
        main.innerHTML = top + `<div class="empty">Loading week ${w}'s plays…</div>`;
        if (!P && LIVE_API_BASE()) {
          PWK[w] = "busy";
          pkApi("/plays?week=" + w).catch(() => ({ error: "Couldn't reach the server." })).then(d => {
            PWK[w] = d && !d.error ? d : { error: (d && d.error) || "Couldn't load that week's plays." };
            if (state.tab === "matchups" && state.sub === "plays" && matchupWeek() === w && state.params.get("view") !== "season") renderKeepScroll(renderMatchups);
          });
        }
        return;
      }
      if (P.error) { delete PWK[w]; main.innerHTML = top + `<div class="empty">${esc(P.error)}</div>`; return; }
      if (!P.tracked) { main.innerHTML = top + `<div class="empty">No big plays were recorded for week ${w}.</div>`; return; }
      all = P.events.map(e => Object.assign({ week: w }, e)).sort((a, b) => b.t - a.t);
    }
    const nflList = by === "nfl" ? nflGamesFor(w) : [];
    if (nflList == null) { main.innerHTML = top + `<div class="empty">Loading week ${w}'s NFL games…</div>`; return; }
    const toggle = `<div class="pg-by" role="tablist" aria-label="Group big plays">${[["nfl", "By NFL game"], ["fantasy", "By fantasy matchup"]].map(([k, lab]) =>
      `<a role="tab" aria-selected="${by === k}" class="${by === k ? "active" : ""}" href="${href("matchups", Object.assign({ by: k }, mWeekParam()), "plays")}">${lab}</a>`).join("")}</div>`;
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
      const nfl = (Array.isArray(nflList) ? nflList : []).map(g => ({ g, ev: all.filter(e => e.nfl === g.home || e.nfl === g.away) }));
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
    main.innerHTML = top + playsSwitch("") + toggle + `<p class="pg-sum">Week ${w} · ${all.length} big play${all.length === 1 ? "" : "s"}${live ? " so far" : ""}${live && !wk.final ? " · updates every minute during games" : ""}</p>` + body;
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
    if (state.sub === "bracket") { location.replace(href("playoffs", {}, "bracket")); return; } // the bracket moved to Playoffs
    if (state.sub === "pickem") { location.replace("#/games"); return; } // old link: pick'em moved to Games
    if (state.sub === "watch" || state.sub === "plays") {
      const r = state.sub === "watch" ? renderWatch() : renderPlays();
      centerWeekStrip();
      return r;
    }
    const w = matchupWeek();
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
        ${a && b ? rxRow(w, "g:" + g.id) + talkRow("w" + w, "g:" + g.id) : ""}
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
      ${matchupNav("")}
      ${weekStrip(w)}
      ${wk.final ? recapCard(w) : ""}
      ${feedPanel(w)}
      ${thisWeekStrip(w)}
      <div class="games">${games}</div>
      ${rootForSection(w)}`;
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
    main.innerHTML = `${playoffsHead("bracket", sub, M.started || L.over ? `<button type="button" class="share-btn" data-share="bracket">${SHARE_ICON}Share</button>` : "")}
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
    const head = (title, sub) => `<div class="section-head"><div><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ""}</div></div>${subnav("games", GAMES_TABS, "")}`;
    if (state.season !== IDX.current) {
      main.innerHTML = head("Pick'em", "") + `<div class="empty">Pick'em started in ${IDX.current}. <a href="#/games">Go to this season's pick'em</a></div>`;
      return;
    }
    if (!LIVE_API_BASE()) { main.innerHTML = head("Pick'em", "") + '<div class="empty">Pick\'em needs the live worker, which isn\'t set up.</div>'; return; }
    if (!PK.data || Date.now() - (PK.at || 0) > 60000) {
      if (!PK.data) main.innerHTML = head("Pick'em", "") + '<div class="empty">Loading pick\'em…</div>';
      PK.data = await pkApi("/pickem");
      PK.at = Date.now();
      if (state.tab !== "games" || state.sub !== "") return;
    }
    pickemView();
  }

  function pickemView() {
    const P = PK.data;
    const head = (title, sub) => `<div class="section-head"><div><h1>${title}</h1>${sub ? `<p class="sub">${sub}</p>` : ""}</div></div>${subnav("games", GAMES_TABS, "")}`;
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
      const next = P.lockAt && Date.now() >= P.lockAt ? " Next week's picks open as soon as this week's last NFL game ends (usually late Monday night)." : "";
      body = head(`Week ${P.week} pick'em`, `${status}.${next}`) + section("This week's picks", "", grid) + leaderboard;
    }
    main.innerHTML = body;
  }

  // ---------------------------------------------------------------- league trivia (Games)
  // 5 multiple-choice questions a week about the league's own history, from the live worker. One try each week,
  // with the same name + PIN as pick'em; answers come back only after you submit.
  const TV = { data: null, at: 0, sel: [], result: null, score: null, ready: false, msg: "", err: false, auto: false };
  async function renderTrivia() {
    const head = sub => `<div class="section-head"><div><h1>League trivia</h1>${sub ? `<p class="sub">${sub}</p>` : ""}</div></div>${subnav("games", GAMES_TABS, "trivia")}`;
    if (state.season !== IDX.current) { main.innerHTML = head("") + `<div class="empty">Trivia runs in the current season. <a href="#/games/trivia">Go to this week's trivia</a></div>`; return; }
    if (!LIVE_API_BASE()) { main.innerHTML = head("") + '<div class="empty">Trivia needs the live worker, which isn\'t set up.</div>'; return; }
    if (!TV.data || Date.now() - TV.at > 60000) {
      if (!TV.data) main.innerHTML = head("") + '<div class="empty">Loading this week\'s trivia…</div>';
      const d = await pkApi("/trivia");
      if (TV.data && d.week !== TV.data.week) { TV.sel = []; TV.result = null; TV.score = null; } // a new week's quiz
      TV.data = d; TV.at = Date.now();
      if (state.tab !== "games" || state.sub !== "trivia") return;
    }
    // remembered name + PIN: load your answers without asking
    if (!TV.ready && !TV.auto && PK.member && PK.pin) {
      TV.auto = true;
      const r = await pkApi("/trivia/mine", { member: PK.member, pin: PK.pin });
      if (!r.error) tvLoad(r);
      if (state.tab !== "games" || state.sub !== "trivia") return;
    }
    triviaView(head);
  }
  function tvLoad(r) {
    TV.ready = true; TV.err = false;
    if (r.submitted) { TV.result = r.result; TV.score = r.score; } else { TV.result = null; TV.score = null; }
    TV.msg = r.newPin ? "Welcome! The PIN you entered becomes yours for the season when you submit." : "";
  }
  const TV_LEVEL = ["", "Easy", "Medium", "Tricky", "Hard", "Expert"];
  const tvLevel = q => q.level ? `<span class="tv-lvl l${q.level}">${TV_LEVEL[q.level]}</span>` : "";
  function triviaView(head) {
    head = head || (sub => `<div class="section-head"><div><h1>League trivia</h1>${sub ? `<p class="sub">${sub}</p>` : ""}</div></div>${subnav("games", GAMES_TABS, "trivia")}`);
    const T = TV.data;
    if (!T || T.error) { main.innerHTML = head("") + `<div class="empty">${esc((T && T.error) || "Couldn't load trivia.")} <button type="button" class="linkbtn" data-tv="reload">Try again</button></div>`; return; }
    const members = pkMembers();
    const nameOf = id => (members.find(m => m.id === id) || { name: memberName(id) }).name;
    const board = Object.entries(T.board || {}).map(([m, r]) => ({ m, total: r.total, weeks: r.weeks || {} }))
      .sort((a, b) => b.total - a.total || Object.keys(a.weeks).length - Object.keys(b.weeks).length || nameOf(a.m).localeCompare(nameOf(b.m)));
    const leaderboard = board.length ? section("Season leaderboard", "One point per right answer, every week added up.", table([
      { label: "Player", cell: r => `<b>${esc(nameOf(r.m))}</b>${r.m === PK.member ? ' <span class="badge new">You</span>' : ""}` },
      { label: "Points", num: 1, cell: r => `<b>${r.total}</b>` },
      { label: `Week ${T.week}`, num: 1, cell: r => r.weeks[T.week] != null ? `${r.weeks[T.week]}/5` : '<span class="muted">—</span>' },
      { label: "Weeks played", num: 1, cell: r => Object.keys(r.weeks).length },
      { label: "Perfect weeks", num: 1, cell: r => Object.values(r.weeks).filter(x => x === 5).length },
    ], board)) : "";
    if (T.over) { main.innerHTML = head("The season is over. Trivia is back next season.") + leaderboard; return; }
    const sub = `Week ${T.week}: 5 questions about your league's own history, ${T.questions.some(q => q.level) ? "from easy to expert, " : ""}new every week once the week's last NFL game ends (usually late Monday night). You get <b>one try</b>, so no peeking at the History tab.`;
    const who = `<div class="panel pk-who">
        <label class="field">Who are you? <select id="tv-member"><option value="">Choose your name</option>${members.map(m => `<option value="${esc(m.id)}"${m.id === PK.member ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</select></label>
        <label class="field">PIN <input id="tv-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="4" pattern="[0-9]*" placeholder="4 digits" value="${esc(PK.pin)}"></label>
        <label class="field pk-remember"><input id="tv-remember" type="checkbox"${store.get("pk-pin", "") ? " checked" : ""}> Remember me on this device</label>
        <button type="button" class="cta" data-tv="continue">${TV.ready ? "Switch" : "Start"}</button>
        <p class="note">Same name and PIN as pick'em.</p></div>`;
    let quiz = "";
    if (TV.ready && TV.result) {
      quiz = `<div class="tv-score"><b>You got ${TV.score} of 5</b>${TV.score === 5 ? " · perfect week!" : ""}</div><div class="tv-qs">${T.questions.map((q, i) => {
        const r = TV.result[i], right = r.yours === r.answer;
        return `<div class="tv-q ${right ? "right" : "wrong"}"><div class="tv-q-h"><span class="tv-n">${i + 1}</span><span>${tvLevel(q)}${esc(q.q)}</span><span class="tv-mark">${right ? "✓" : "✗"}</span></div>
          <div class="tv-opts">${q.options.map((o, j) => `<span class="tv-opt${j === r.answer ? " answer" : ""}${j === r.yours && !right ? " picked" : ""}">${esc(o)}</span>`).join("")}</div>
          <p class="note tv-why">${esc(r.why)}</p></div>`;
      }).join("")}</div>`;
    } else if (TV.ready) {
      const n = TV.sel.filter(x => x != null).length;
      quiz = `<div class="tv-qs">${T.questions.map((q, i) => `<div class="tv-q" role="group" aria-label="Question ${i + 1}"><div class="tv-q-h"><span class="tv-n">${i + 1}</span><span>${tvLevel(q)}${esc(q.q)}</span></div>
          <div class="tv-opts">${q.options.map((o, j) => `<button type="button" class="tv-opt${TV.sel[i] === j ? " on" : ""}" data-tv-q="${i}" data-tv-o="${j}" aria-pressed="${TV.sel[i] === j}">${esc(o)}</button>`).join("")}</div></div>`).join("")}</div>
        <div class="pk-save"><button type="button" class="cta" data-tv="submit"${n < T.questions.length ? " disabled" : ""}>Submit answers (${n} of ${T.questions.length})</button></div>`;
    }
    const msg = TV.msg ? `<p class="note${TV.err ? " live" : ""}">${esc(TV.msg)}</p>` : "";
    const done = (T.submitted || []).map(nameOf).sort();
    const subm = `<p class="note">Done this week (${done.length} of ${members.length}): ${done.length ? esc(done.join(", ")) : "nobody yet"}</p>`;
    main.innerHTML = head(sub) + who + msg + quiz + subm + leaderboard;
  }
  async function tvContinue() {
    const member = document.getElementById("tv-member").value;
    const pin = document.getElementById("tv-pin").value.trim();
    const remember = document.getElementById("tv-remember").checked;
    if (!member) { TV.msg = "Choose your name first."; TV.err = true; return triviaView(); }
    if (!/^\d{4}$/.test(pin)) { TV.msg = "Enter a 4-digit PIN."; TV.err = true; return triviaView(); }
    const r = await pkApi("/trivia/mine", { member, pin });
    if (r.error) { TV.msg = r.error; TV.err = true; TV.ready = false; return triviaView(); }
    if (member !== PK.member) { TV.sel = []; PK.ready = false; PK.sel = {}; P3.ready = false; P3.auto = false; P3.sel = {}; P3.saved = {}; }
    PK.member = member; PK.pin = pin;
    store.set("pk-member", member);
    store.set("pk-pin", remember ? pin : "");
    tvLoad(r);
    triviaView();
  }
  async function tvSubmit() {
    const btn = main.querySelector('[data-tv="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = "Checking…"; }
    const r = await pkApi("/trivia/submit", { member: PK.member, pin: PK.pin, answers: TV.sel });
    if (r.error) { TV.msg = r.error; TV.err = true; return triviaView(); }
    TV.result = r.result; TV.score = r.score; TV.msg = r.already ? "You'd already answered this week; here's how you did." : ""; TV.err = false;
    TV.data = await pkApi("/trivia"); TV.at = Date.now();
    triviaView();
  }
  main.addEventListener("click", e => {
    const o = e.target.closest("[data-tv-o]");
    if (o) {
      const q = Number(o.dataset.tvQ), j = Number(o.dataset.tvO);
      TV.sel[q] = j; TV.msg = "";
      o.closest(".tv-opts").querySelectorAll(".tv-opt").forEach(b => { const on = b === o; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
      const btn = main.querySelector('[data-tv="submit"]'), n = TV.sel.filter(x => x != null).length, of = TV.data.questions.length;
      if (btn) { btn.textContent = `Submit answers (${n} of ${of})`; btn.disabled = n < of; }
      return;
    }
    const a = e.target.closest("[data-tv]");
    if (!a) return;
    if (a.dataset.tv === "continue") tvContinue();
    if (a.dataset.tv === "submit") tvSubmit();
    if (a.dataset.tv === "reload") { TV.data = null; renderTrivia(); }
  });

  // ---------------------------------------------------------------- Pick 4 (Games)
  // A QB, RB, WR and TE from any NFL team under a salary cap; score = their real points this week under league
  // scoring. Prices are a flat $ per ESPN-projected point, frozen when the week opens. Each spot locks at its own
  // player's kickoff; until then it can be swapped for anyone who hasn't played yet. The worker enforces all of it.
  const P3_SLOTS = ["QB", "RB", "WR", "TE"];
  // (the waiver wire challenge, a free-agents-only version on the same page, was retired in November 2026)
  const P3 = { data: null, at: 0, sel: {}, saved: {}, ready: false, auto: false, msg: "", err: false, pos: "QB", q: "" };
  const p3Head = () => `<div class="section-head"><div><h1>Pick 4</h1></div></div>${subnav("games", GAMES_TABS, "pick4")}`;
  const money = n => "$" + Math.round(n).toLocaleString();
  async function renderPick3() {
    if (state.params.has("view")) { location.replace(href("games", {}, "pick4")); return; } // old waiver wire challenge link
    const head = sub => p3Head() + (sub ? `<p class="sub">${sub}</p>` : "");
    if (state.season !== IDX.current) { main.innerHTML = head("") + `<div class="empty">Pick 4 runs in the current season. <a href="#/games/pick4">Go to this week's Pick 4</a></div>`; return; }
    if (!LIVE_API_BASE()) { main.innerHTML = head("") + '<div class="empty">Pick 4 needs the live worker, which isn\'t set up.</div>'; return; }
    if (!P3.data || Date.now() - P3.at > 60000) {
      if (!P3.data) main.innerHTML = head("") + '<div class="empty">Loading this week\'s players…</div>';
      const d = await pkApi("/pick3").catch(() => ({ error: "Couldn't reach the server. Try again." }));
      if (P3.data && d.week !== P3.data.week) { P3.sel = {}; P3.saved = {}; P3.ready = false; P3.auto = false; }
      P3.data = d; P3.at = Date.now();
      if (state.tab !== "games" || state.sub !== "pick4") return;
    }
    if (!P3.ready && !P3.auto && PK.member && PK.pin && P3.data && !P3.data.error) {
      P3.auto = true;
      const r = await pkApi("/pick3/mine", { member: PK.member, pin: PK.pin }).catch(() => ({ error: "x" }));
      if (!r.error) p3Load(r);
      if (state.tab !== "games" || state.sub !== "pick4") return;
    }
    pick3View();
  }
  function p3Load(r) {
    P3.ready = true; P3.err = false;
    P3.saved = Object.fromEntries(P3_SLOTS.map(k => [k, r.picks && r.picks[k] ? r.picks[k] : null]));
    P3.sel = Object.fromEntries(P3_SLOTS.map(k => [k, P3.saved[k] ? P3.saved[k].id : null]));
    P3.pos = P3_SLOTS.find(k => !P3.sel[k]) || P3.pos; // open the picker on the first empty spot
    P3.msg = r.newPin ? "Welcome! The PIN you entered becomes yours for the season when you save." : "";
  }
  function pick3View() {
    const head = sub => p3Head() + (sub ? `<p class="sub">${sub}</p>` : "");
    const T = P3.data;
    if (!T || T.error) { main.innerHTML = head("") + `<div class="empty">${esc((T && T.error) || "Couldn't load Pick 4.")} <button type="button" class="linkbtn" data-p3="reload">Try again</button></div>`; return; }
    const members = pkMembers();
    const nameOf = id => (members.find(m => m.id === id) || { name: memberName(id) }).name;
    const hist = T.history || {};
    // season leaderboard: finished weeks (points, weekly wins; ties go to the cheaper lineup)
    const board = {};
    Object.entries(hist).forEach(([w, rows]) => {
      const list = Object.entries(rows).map(([m, r]) => ({ m, ...r })).sort((a, b) => b.pts - a.pts || a.sal - b.sal);
      list.forEach((r, i) => { const b = board[r.m] = board[r.m] || { m: r.m, total: 0, weeks: 0, wins: 0, best: 0 }; b.total += r.pts; b.weeks++; b.best = Math.max(b.best, r.pts); if (i === 0) b.wins++; });
    });
    const leaders = Object.values(board).sort((a, b) => b.total - a.total);
    const leaderboard = leaders.length ? section("Season leaderboard", "Points from every finished week added up.", table([
      { label: "Player", cell: r => `<b>${esc(nameOf(r.m))}</b>` },
      { label: "Points", num: 1, cell: r => `<b>${r.total.toFixed(1)}</b>` },
      { label: "Weeks won", num: 1, cell: r => r.wins },
      { label: "Weeks played", num: 1, cell: r => r.weeks },
      { label: "Best week", num: 1, cell: r => r.best.toFixed(1) },
    ], leaders)) : "";
    if (T.over) { main.innerHTML = head("The season is over. Back next season.") + leaderboard; return; }

    const now = Date.now();
    const byId = Object.fromEntries(T.players.map(p => [p.id, p]));
    const played = p => p && now >= p.at;
    const kick = p => new Date(p.at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
    // a saved pick keeps the price it was bought at; a new pick costs today's price
    const kept = k => P3.sel[k] && P3.saved[k] && P3.saved[k].id === P3.sel[k];
    const info = k => kept(k) ? Object.assign({}, P3.saved[k], byId[P3.sel[k]] ? { proj: byId[P3.sel[k]].proj, inj: byId[P3.sel[k]].inj } : {}) : byId[P3.sel[k]];
    const cost = k => !P3.sel[k] ? 0 : kept(k) ? P3.saved[k].sal : (byId[P3.sel[k]] || { sal: 0 }).sal;
    const lockedSlot = k => P3.saved[k] && played(P3.saved[k]);
    const spent = P3_SLOTS.reduce((n, k) => n + cost(k), 0);
    const injTag = x => x && x.inj ? ` <span class="p3-inj ${x.inj === "OUT" ? "out" : ""}">${esc(x.inj)}</span>` : "";
    const move = p => p.sal0 && p.sal !== p.sal0 ? `<span class="p3-mv ${p.sal > p.sal0 ? "up" : "down"}" title="Opened the week at ${money(p.sal0)}">${p.sal > p.sal0 ? "▲" : "▼"}${money(Math.abs(p.sal - p.sal0)).slice(1)}</span>` : "";
    const updated = new Date(T.made).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const left = T.cap - spent;
    const pricing = `Prices are ${money(T.perPt)} per point ESPN projects for a player this week (under our scoring), the same rate at every position, and they move with injury news and projection changes: they're updated every ${T.refreshMin || 30} minutes until each player's game starts (last update ${esc(updated)}; ▲/▼ is the change since the week opened). <b>Players you've saved keep the price you paid</b>; only a player you swap in costs today's price. The cap is set once when the week opens.`;
    const intro = expl(`Pick a QB, RB, WR and TE for ${money(T.cap)} or less. Score = their real points this week.`,
      `Pick a QB, RB, WR and TE from any NFL team for ${money(T.cap)} or less; your score is their real points this week under our scoring. ${pricing} Each spot locks when that player's game kicks off; until then you can swap in anyone who hasn't played yet, right up to the last game. Ties go to the cheaper lineup.`);
    const who = `<div class="panel pk-who">
        <label class="field">Who are you? <select id="p3-member"><option value="">Choose your name</option>${members.map(m => `<option value="${esc(m.id)}"${m.id === PK.member ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</select></label>
        <label class="field">PIN <input id="p3-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="4" pattern="[0-9]*" placeholder="4 digits" value="${esc(PK.pin)}"></label>
        <label class="field pk-remember"><input id="p3-remember" type="checkbox"${store.get("pk-pin", "") ? " checked" : ""}> Remember me on this device</label>
        <button type="button" class="cta" data-p3="continue">${P3.ready ? "Switch" : "Start"}</button>
        <p class="note">Same name and PIN as pick'em.</p></div>`;
    let game = "";
    if (P3.ready) {
      const changed = P3_SLOTS.some(k => (P3.sel[k] || null) !== (P3.saved[k] ? P3.saved[k].id : null));
      const slot = k => {
        const p = P3.sel[k] && info(k), lock = lockedSlot(k), sv = P3.saved[k];
        if (!p) return `<button type="button" class="p3-slot empty${P3.pos === k ? " on" : ""}" data-p3-pos="${k}"><span class="slot ${k}">${k}</span><span class="p3-sn">Pick a ${k}</span></button>`;
        const now$ = byId[p.id] && byId[p.id].sal;
        const priceTxt = kept(k) ? `paid ${money(sv.sal)}${now$ && now$ !== sv.sal && !lock ? ` · now ${money(now$)}` : ""}` : "";
        const pts = lock && sv && sv.pts != null ? `<b class="p3-pts">${sv.pts.toFixed(1)} pts</b>` : `<span class="p3-sal">${money(cost(k))}</span>`;
        // heads-up on a saved player who's been ruled out
        let warn = "";
        if (!lock && byId[p.id] && byId[p.id].inj === "OUT") warn = `<span class="p3-warn">Ruled out. Swap him before ${esc(kick(p))}.</span>`;
        return `<div class="p3-slot${lock ? " locked" : ""}${P3.pos === k ? " on" : ""}"><span class="slot ${k}">${k}</span><span class="p3-sn"><b>${esc(p.n)}${injTag(byId[p.id])}</b><span class="team-mgr">${esc(p.team)} ${esc(p.opp)} · ${lock ? "locked 🔒" : esc(kick(p))}${p.proj != null ? ` · proj ${p.proj.toFixed(1)}` : ""}${priceTxt ? " · " + priceTxt : ""}</span>${warn}</span>${pts}
          ${lock ? "" : `<button type="button" class="linkbtn" data-p3-pos="${k}">Change</button><button type="button" class="linkbtn" data-p3-clear="${k}" aria-label="Remove ${esc(p.n)}">✕</button>`}</div>`;
      };
      const pct = Math.min(100, 100 * spent / T.cap);
      const q = P3.q.trim().toLowerCase();
      const list = T.players.filter(p => p.pos === P3.pos && (!q || p.n.toLowerCase().includes(q) || p.team.toLowerCase() === q))
        .sort((a, b) => (a.inj === "OUT") - (b.inj === "OUT") || b.sal - a.sal);
      const curSal = cost(P3.pos);
      // keep enough back for the cheapest player still available at every other empty spot
      const cheapest = k => Math.min(...T.players.filter(p => p.pos === k && !played(p) && p.inj !== "OUT").map(p => p.sal));
      const reserve = P3_SLOTS.filter(k => k !== P3.pos && !P3.sel[k]).reduce((n, k) => n + (isFinite(cheapest(k)) ? cheapest(k) : 0), 0);
      const rows = list.map(p => {
        const picked = P3.sel[P3.pos] === p.id, gone = played(p), extra = p.sal - curSal;
        const over = !picked && extra > left, tight = !picked && !over && extra > left - reserve;
        const why = gone ? "played" : lockedSlot(P3.pos) ? "spot locked" : p.inj === "OUT" ? "out" : over ? "over cap" : tight ? "no room left" : "";
        return `<button type="button" class="p3-row${picked ? " on" : ""}" data-p3-pick="${p.id}"${why && !picked ? " disabled" : ""}>
          <span class="p3-rn"><b>${esc(p.n)}${injTag(p)}</b><span class="team-mgr">${esc(p.team)} ${esc(p.opp)} · ${gone ? "played" : esc(kick(p))}</span></span>
          <span class="p3-rp">proj ${p.proj.toFixed(1)}</span><span class="p3-rs">${money(picked && kept(P3.pos) ? P3.saved[P3.pos].sal : p.sal)}${picked && kept(P3.pos) ? "" : move(p)}</span><span class="p3-rw">${picked ? "✓" : why ? esc(why) : "Add"}</span></button>`;
      }).join("");
      game = `<div class="p3-wrap"><div class="p3-lineup">
          <div class="p3-cap"><div class="p3-cap-t"><span>Spent <b>${money(spent)}</b> of ${money(T.cap)}</span><span class="${left < 0 ? "neg" : ""}">${money(left)} left</span></div><div class="p3-bar"><span style="width:${pct}%"></span></div></div>
          ${P3_SLOTS.map(slot).join("")}
          <div class="pk-save"><button type="button" class="cta" data-p3="save"${changed ? "" : " disabled"}>${changed ? "Save lineup" : "Saved"}</button></div>
        </div>
        <div class="p3-pick"><nav class="pg-by p3-tabs" aria-label="Position">${P3_SLOTS.map(k => `<a href="#" data-p3-pos="${k}" class="${P3.pos === k ? "active" : ""}">${k}</a>`).join("")}</nav>
          <input id="p3-q" type="search" placeholder="Search ${P3.pos}s or a team (e.g. KC)" value="${esc(P3.q)}" autocomplete="off">
          <div class="p3-list">${rows || '<div class="empty">No players match.</div>'}</div></div></div>`;
    }
    const msg = P3.msg ? `<p class="note${P3.err ? " live" : ""}">${esc(P3.msg)}</p>` : "";
    // this week: everyone's lineup; other people's players show once their game has started
    const entries = Object.entries(T.entries || {}).map(([m, e]) => ({ m, e, pts: P3_SLOTS.reduce((n, k) => n + (e[k] && e[k].pts ? e[k].pts : 0), 0) }))
      .sort((a, b) => b.pts - a.pts);
    const week = entries.length ? section(`Week ${T.week} so far`, "Players show once their game starts; until then they're hidden.", `<div class="p3-board">${entries.map(({ m, e, pts }) =>
      `<div class="p3-entry"><div class="p3-eh"><b>${esc(nameOf(m))}</b><span>${pts.toFixed(1)}</span></div>${P3_SLOTS.map(k => {
        const x = e[k];
        if (!x) return `<div class="p3-ep muted"><span class="slot ${k}">${k}</span>none</div>`;
        if (x.hidden) return `<div class="p3-ep muted"><span class="slot ${k}">${k}</span>hidden until kickoff</div>`;
        const p = byId[x.id];
        return `<div class="p3-ep"><span class="slot ${k}">${k}</span><span class="p3-sn">${esc(x.n || (p ? p.n : "?"))}</span><b>${(x.pts || 0).toFixed(1)}</b></div>`;
      }).join("")}</div>`).join("")}</div>`) : "";
    main.innerHTML = head("").replace("</h1>", "</h1>" + intro) + who + msg + game + week + leaderboard;
    const qi = main.querySelector("#p3-q");
    if (qi && P3.focusQ) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); P3.focusQ = false; }
  }
  async function p3Continue() {
    const member = document.getElementById("p3-member").value;
    const pin = document.getElementById("p3-pin").value.trim();
    const remember = document.getElementById("p3-remember").checked;
    if (!member) { P3.msg = "Choose your name first."; P3.err = true; return pick3View(); }
    if (!/^\d{4}$/.test(pin)) { P3.msg = "Enter a 4-digit PIN."; P3.err = true; return pick3View(); }
    const r = await pkApi("/pick3/mine", { member, pin });
    if (r.error) { P3.msg = r.error; P3.err = true; P3.ready = false; return pick3View(); }
    if (member !== PK.member) { PK.ready = false; PK.sel = {}; TV.ready = false; TV.result = null; TV.sel = []; TV.auto = false; }
    PK.member = member; PK.pin = pin;
    store.set("pk-member", member);
    store.set("pk-pin", remember ? pin : "");
    p3Load(r);
    pick3View();
  }
  async function p3Save() {
    const btn = main.querySelector('[data-p3="save"]');
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    const r = await pkApi("/pick3/save", { member: PK.member, pin: PK.pin, picks: P3.sel });
    if (r.error) { P3.msg = r.error; P3.err = true; return pick3View(); }
    P3.saved = r.picks; P3.msg = `Saved: ${money(r.salary)} of ${money(P3.data.cap)}.`; P3.err = false;
    P3.data = await pkApi("/pick3"); P3.at = Date.now();
    pick3View();
  }
  main.addEventListener("click", e => {
    if (!(state.tab === "games" && state.sub === "pick4")) return;
    const pos = e.target.closest("[data-p3-pos]");
    if (pos) { e.preventDefault(); P3.pos = pos.dataset.p3Pos; P3.q = ""; return pick3View(); }
    const clr = e.target.closest("[data-p3-clear]");
    if (clr) { P3.sel[clr.dataset.p3Clear] = null; P3.msg = ""; return pick3View(); }
    const pk = e.target.closest("[data-p3-pick]");
    if (pk && !pk.disabled) {
      const id = Number(pk.dataset.p3Pick);
      P3.sel[P3.pos] = P3.sel[P3.pos] === id ? null : id; P3.msg = "";
      const next = P3_SLOTS.find(k => !P3.sel[k]);
      if (next && P3.sel[P3.pos]) { P3.pos = next; P3.q = ""; }
      return pick3View();
    }
    const a = e.target.closest("[data-p3]");
    if (!a) return;
    if (a.dataset.p3 === "continue") p3Continue();
    if (a.dataset.p3 === "save") p3Save();
    if (a.dataset.p3 === "reload") { P3.data = null; renderPick3(); }
  });
  main.addEventListener("input", e => {
    if (e.target.id !== "p3-q") return;
    P3.q = e.target.value; P3.focusQ = true; pick3View();
  });

  // ---------------------------------------------------------------- shared sign-in panel for the newer games
  // Same name + PIN (and "Remember me") as every other game; `prefix` keeps each page's form ids apart.
  function gameWho(prefix, ready, note) {
    const members = pkMembers();
    return `<div class="panel pk-who">
        <label class="field">Who are you? <select id="${prefix}-member"><option value="">Choose your name</option>${members.map(m => `<option value="${esc(m.id)}"${m.id === PK.member ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</select></label>
        <label class="field">PIN <input id="${prefix}-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="4" pattern="[0-9]*" placeholder="4 digits" value="${esc(PK.pin)}"></label>
        <label class="field pk-remember"><input id="${prefix}-remember" type="checkbox"${store.get("pk-pin", "") ? " checked" : ""}> Remember me on this device</label>
        <button type="button" class="cta" data-${prefix}="continue">${ready ? "Switch" : "Start"}</button>
        <p class="note">${note || "Same name and PIN as pick'em."}</p></div>`;
  }
  // reads the panel, checks the PIN with `path`, remembers the person; returns the server's answer or {error}
  async function gameSignIn(prefix, path, extra) {
    const member = document.getElementById(prefix + "-member").value;
    const pin = document.getElementById(prefix + "-pin").value.trim();
    const remember = document.getElementById(prefix + "-remember").checked;
    if (!member) return { error: "Choose your name first." };
    if (!/^\d{4}$/.test(pin)) return { error: "Enter a 4-digit PIN." };
    const r = await pkApi(path, Object.assign({ member, pin }, extra || {}));
    if (r.error) return r;
    if (member !== PK.member) { PK.ready = false; PK.sel = {}; TV.ready = false; TV.result = null; TV.sel = []; TV.auto = false; P3.ready = false; RK.ready = false; GG.ready = false; GG.guesses = {}; }
    PK.member = member; PK.pin = pin;
    store.set("pk-member", member);
    store.set("pk-pin", remember ? pin : "");
    return r;
  }
  const kickTime = at => new Date(at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  const nameOfMember = id => (pkMembers().find(m => m.id === id) || { name: memberName(id) }).name;
  function gameHead(sub, title, intro) {
    return `<div class="section-head"><div><h1>${title}</h1>${intro || ""}</div></div>${subnav("games", GAMES_TABS, sub)}`;
  }
  // loads a game's week from the worker (once a minute) and, when this device remembers a PIN, the person's entry
  async function gameLoad(S, sub, path, minePath, onMine) {
    if (!S.data || Date.now() - S.at > 60000) {
      const d = await pkApi(path).catch(() => ({ error: "Couldn't reach the server. Try again." }));
      if (S.data && d.week !== S.data.week) S.ready = false;
      S.data = d; S.at = Date.now();
      if (state.tab !== "games" || state.sub !== sub) return false;
    }
    if (!S.ready && !S.auto && PK.member && PK.pin && S.data && !S.data.error && !S.data.over) {
      S.auto = true;
      const r = await pkApi(minePath, { member: PK.member, pin: PK.pin }).catch(() => ({ error: "x" }));
      if (!r.error) onMine(r);
      if (state.tab !== "games" || state.sub !== sub) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- Rank 'em (Games)
  // Five players at one position; put them in order of the points they'll score. Locks at the first kickoff.
  const RK = { data: null, at: 0, order: [], saved: null, ready: false, auto: false, msg: "", err: false };
  const POS_WORD = { QB: "quarterbacks", RB: "running backs", WR: "wide receivers", TE: "tight ends" };
  function rankScoreOf(order, players, pts) {
    const vals = players.map(p => pts[p.id] || 0);
    return order.reduce((score, id, i) => {
      const v = pts[id] || 0, hi = vals.filter(x => x > v).length, lo = hi + vals.filter(x => x === v).length - 1;
      const d = i < hi ? hi - i : i > lo ? i - lo : 0;
      return score + (d === 0 ? 3 : d === 1 ? 1 : 0);
    }, 0);
  }
  async function renderRankem() {
    const head = gameHead("rankem", "Rank 'em");
    if (state.season !== IDX.current) { main.innerHTML = head + `<div class="empty">Rank 'em runs in the current season. <a href="#/games/rankem">Go to this week's Rank 'em</a></div>`; return; }
    if (!LIVE_API_BASE()) { main.innerHTML = head + '<div class="empty">Rank \'em needs the live worker, which isn\'t set up.</div>'; return; }
    if (!RK.data) main.innerHTML = head + '<div class="empty">Loading this week\'s players…</div>';
    if (!(await gameLoad(RK, "rankem", "/rank", "/rank/mine", rkLoad))) return;
    if (RK.data && RK.data.players && (!RK.order.length || RK.order.some(id => !RK.data.players.find(p => p.id === id)))) RK.order = (RK.saved || RK.data.players.map(p => p.id)).slice();
    rankView();
  }
  function rkLoad(r) {
    RK.ready = true; RK.err = false;
    RK.saved = r.order || null;
    if (RK.saved) RK.order = RK.saved.slice();
    else if (RK.data && RK.data.players) RK.order = RK.data.players.map(p => p.id);
    RK.msg = r.newPin ? "Welcome! The PIN you entered becomes yours for the season when you save." : "";
  }
  function rankView() {
    const T = RK.data;
    if (!T || T.error) { main.innerHTML = gameHead("rankem", "Rank 'em") + `<div class="empty">${esc((T && T.error) || "Couldn't load Rank 'em.")} <button type="button" class="linkbtn" data-rk="reload">Try again</button></div>`; return; }
    const board = {};
    Object.values(T.history || {}).forEach(({ rows }) => {
      const top = Math.max(...Object.values(rows));
      Object.entries(rows).forEach(([m, sc]) => {
        const b = board[m] = board[m] || { m, total: 0, weeks: 0, wins: 0, perfect: 0, best: 0 };
        b.total += sc; b.weeks++; b.best = Math.max(b.best, sc); if (sc === top) b.wins++; if (sc === 15) b.perfect++;
      });
    });
    const leaders = Object.values(board).sort((a, b) => b.total - a.total || b.wins - a.wins);
    const leaderboard = leaders.length ? section("Season leaderboard", "Points from every finished week added up (15 a week at most).", table([
      { label: "Player", cell: r => `<b>${esc(nameOfMember(r.m))}</b>` },
      { label: "Points", num: 1, cell: r => `<b>${r.total}</b>` },
      { label: "Weeks won", num: 1, cell: r => r.wins },
      { label: "Perfect", num: 1, cell: r => r.perfect },
      { label: "Best week", num: 1, cell: r => r.best },
      { label: "Weeks played", num: 1, cell: r => r.weeks },
    ], leaders)) : "";
    if (T.over) { main.innerHTML = gameHead("rankem", "Rank 'em", '<p class="sub">The season is over. Back next season.</p>') + leaderboard; return; }
    if (T.none) { main.innerHTML = gameHead("rankem", "Rank 'em") + `<div class="empty">There's no Rank 'em this week: not enough ${esc(POS_WORD[T.pos] || "players")} play Sunday or later with projections yet.</div>` + leaderboard; return; }
    const intro = expl(`Put these five ${POS_WORD[T.pos]} in order of the fantasy points they'll score this week. Locks ${esc(kickTime(T.lock))}.`,
      `Each week it's a different position (QB, RB, WR, TE in turn): five players whose ESPN projections are close together, all playing Sunday or later. Rank them from most to fewest points under our scoring. You get <b>3 points</b> for each player in exactly the right spot and <b>1 point</b> for one spot off (players who tie share their spots), so 15 is perfect. Everything locks when the first of the five kicks off, and nobody's order shows until then.`, "rankem");
    const byId = Object.fromEntries(T.players.map(p => [p.id, p]));
    const pts = Object.fromEntries(T.players.map(p => [p.id, p.pts || 0]));
    const myScore = T.locked && RK.saved ? rankScoreOf(RK.saved, T.players, pts) : null;
    let game = "";
    if (RK.ready) {
      const order = T.locked ? (RK.saved || []) : RK.order;
      const changed = !T.locked && RK.order.join(",") !== (RK.saved || []).join(",");
      const row = (id, i) => {
        const p = byId[id];
        // tied players share their spots (same rule as the score)
        const v = pts[id], hi = T.players.filter(x => pts[x.id] > v).length, lo = hi + T.players.filter(x => pts[x.id] === v).length - 1;
        const d = T.locked ? (i < hi ? hi - i : i > lo ? i - lo : 0) : null;
        const place = hi === lo ? `#${hi + 1}` : `T-${hi + 1}`;
        return `<div class="rk-row${T.locked ? (d === 0 ? " hit" : d === 1 ? " near" : " miss") : ""}"><span class="rk-n">${i + 1}</span>
          <span class="p3-sn"><b>${esc(p.n)}</b><span class="team-mgr">${esc(p.team)} ${esc(p.opp)} · ${T.locked ? (p.pts != null ? p.pts.toFixed(1) + " pts" : "not played yet") : esc(kickTime(p.at))}</span></span>
          ${T.locked ? `<span class="rk-act">actual ${place}</span>` : `<span class="rk-mv"><button type="button" class="linkbtn" data-rk-up="${i}"${i === 0 ? " disabled" : ""} aria-label="Move ${esc(p.n)} up">↑</button><button type="button" class="linkbtn" data-rk-down="${i}"${i === order.length - 1 ? " disabled" : ""} aria-label="Move ${esc(p.n)} down">↓</button></span>`}</div>`;
      };
      const espnOrder = T.players.slice().sort((a, b) => b.proj - a.proj).map(p => p.id);
      game = !order.length ? (T.locked ? '<div class="empty">You didn\'t rank this week. Back next week.</div>' : "") : `<div class="panel rk-list"><p class="kicker">${T.locked ? "Your order" : "Most points at the top"}</p>${order.map(row).join("")}
        ${T.locked ? `<p class="rk-score">Your score: <b>${myScore}</b> of 15${T.players.some(p => p.pts == null) ? " so far" : ""} · ESPN's projections would have ${rankScoreOf(espnOrder, T.players, pts)}</p>`
          : `<div class="pk-save"><button type="button" class="cta" data-rk="save"${changed || !RK.saved ? "" : " disabled"}>${changed || !RK.saved ? "Save order" : "Saved"}</button></div>`}</div>`;
    }
    if (!RK.ready) // signed out: still show this week's five
      game = `<div class="panel rk-list"><p class="kicker">This week's five${T.locked ? "" : " · sign in to rank them"}</p>${T.players.map(p => `<div class="rk-row"><span class="slot ${esc(p.pos)}">${esc(p.pos)}</span>
        <span class="p3-sn"><b>${esc(p.n)}</b><span class="team-mgr">${esc(p.team)} ${esc(p.opp)} · ${T.locked ? (p.pts != null ? p.pts.toFixed(1) + " pts" : "not played yet") : esc(kickTime(p.at))}</span></span></div>`).join("")}</div>`;
    const msg = RK.msg ? `<p class="note${RK.err ? " live" : ""}">${esc(RK.msg)}</p>` : "";
    const ent = Object.entries(T.entries || {});
    const week = !ent.length ? "" : T.locked
      ? section(`Week ${T.week} so far`, "Scores move as games finish.", table([
          { label: "Player", cell: ([m]) => `<b>${esc(nameOfMember(m))}</b>` },
          { label: "Order", cell: ([, x]) => x.order.map(id => esc((byId[id] || { n: "?" }).n.split(" ").slice(-1)[0])).join(" › ") },
          { label: "Score", num: 1, cell: ([, x]) => `<b>${x.score}</b>` },
        ], ent.sort((a, b) => b[1].score - a[1].score)))
      : section(`Week ${T.week}`, `${ent.length} ${ent.length === 1 ? "person has" : "people have"} ranked so far: ${ent.map(([m]) => esc(nameOfMember(m))).join(", ")}. Orders show at lock.`, "");
    main.innerHTML = gameHead("rankem", "Rank 'em", intro) + (T.locked && RK.ready ? "" : gameWho("rk", RK.ready, T.locked ? "Locked for this week. Sign in to see your score." : "")) + msg + game + week + leaderboard;
  }
  main.addEventListener("click", async e => {
    if (!(state.tab === "games" && state.sub === "rankem")) return;
    const up = e.target.closest("[data-rk-up],[data-rk-down]");
    if (up && !up.disabled) {
      const i = Number(up.dataset.rkUp != null ? up.dataset.rkUp : up.dataset.rkDown), j = i + (up.dataset.rkUp != null ? -1 : 1);
      [RK.order[i], RK.order[j]] = [RK.order[j], RK.order[i]]; RK.msg = "";
      return rankView();
    }
    const a = e.target.closest("[data-rk]");
    if (!a) return;
    if (a.dataset.rk === "reload") { RK.data = null; return renderRankem(); }
    if (a.dataset.rk === "continue") {
      const r = await gameSignIn("rk", "/rank/mine");
      if (r.error) { RK.msg = r.error; RK.err = true; RK.ready = false; return rankView(); }
      rkLoad(r); return rankView();
    }
    if (a.dataset.rk === "save") {
      a.disabled = true; a.textContent = "Saving…";
      const r = await pkApi("/rank/save", { member: PK.member, pin: PK.pin, order: RK.order });
      if (r.error) { RK.msg = r.error; RK.err = true; return rankView(); }
      RK.saved = r.order.slice(); RK.msg = "Saved your order. You can change it until lock."; RK.err = false;
      RK.data = await pkApi("/rank"); RK.at = Date.now();
      rankView();
    }
  });

  // ---------------------------------------------------------------- Guess the graph (Games)
  // Three puzzles a week (easy, medium, hard): a player's fantasy points every completed week, his position, and four
  // names. One guess per puzzle (1 / 2 / 3 points). The answer only comes back from the worker after you guess.
  const GG = { data: null, at: 0, guesses: {}, ready: false, auto: false, msg: "", err: false, busy: false, tip: {} };
  const GG_LABEL = { easy: "Easy", medium: "Medium", hard: "Hard" };
  async function renderGraph() {
    const head = gameHead("graph", "Guess the graph");
    if (state.season !== IDX.current) { main.innerHTML = head + `<div class="empty">Guess the graph runs in the current season. <a href="#/games/graph">Go to this week's graphs</a></div>`; return; }
    if (!LIVE_API_BASE()) { main.innerHTML = head + '<div class="empty">Guess the graph needs the live worker, which isn\'t set up.</div>'; return; }
    if (!GG.data) main.innerHTML = head + '<div class="empty">Loading this week\'s graphs…</div>';
    if (!(await gameLoad(GG, "graph", "/graph", "/graph/mine", ggLoad))) return;
    graphView();
  }
  function ggLoad(r) {
    GG.ready = true; GG.err = false; GG.guesses = r.guesses || {};
    GG.msg = r.newPin ? "Welcome! The PIN you entered becomes yours for the season with your first guess." : "";
  }
  // one player's weekly points as bars: thin rounded-top bars on a recessive grid, a dashed season average, and a
  // readout under the chart for the bar you hover or tap (weeks he didn't play show as a dash)
  function graphSvg(w, lvl) {
    const W = 600, H = 210, l = 34, r = 12, t = 12, b = 26;
    const vals = w.filter(v => v != null);
    const max = Math.max(10, ...vals), step = max > 60 ? 20 : 10, top = Math.ceil(max / step) * step;
    const y = v => t + (H - t - b) * (1 - v / top), slot = (W - l - r) / w.length, bw = Math.min(26, slot * 0.55);
    const grid = []; for (let v = 0; v <= top; v += step) grid.push(`<line x1="${l}" x2="${W - r}" y1="${y(v)}" y2="${y(v)}" class="gg-grid"/><text x="${l - 6}" y="${y(v) + 4}" class="gg-ax" text-anchor="end">${v}</text>`);
    const bars = w.map((v, i) => {
      const cx = l + slot * (i + 0.5);
      const label = `<text x="${cx}" y="${H - 8}" class="gg-ax" text-anchor="middle">${i + 1}</text>`;
      const hit = `<rect x="${cx - slot / 2}" y="${t}" width="${slot}" height="${H - t - b}" class="gg-hit" data-gg-bar="${lvl}" data-wk="${i + 1}" data-v="${v == null ? "" : v}"/>`;
      if (v == null) return `${label}<text x="${cx}" y="${y(0) - 4}" class="gg-ax" text-anchor="middle">–</text>${hit}`;
      const h = Math.max(1.5, y(0) - y(Math.max(0, v))), rad = Math.min(4, bw / 2, h);
      const x0 = cx - bw / 2, y0 = y(0) - h;
      return `${label}<path class="gg-bar" d="M${x0},${y(0)} V${y0 + rad} Q${x0},${y0} ${x0 + rad},${y0} H${x0 + bw - rad} Q${x0 + bw},${y0} ${x0 + bw},${y0 + rad} V${y(0)} Z"/>${hit}`;
    }).join("");
    const avg = vals.length ? vals.reduce((a, c) => a + c, 0) / vals.length : 0;
    const avgLine = vals.length ? `<line x1="${l}" x2="${W - r}" y1="${y(avg)}" y2="${y(avg)}" class="gg-avg"/>` : "";
    return `<svg class="gg-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Fantasy points by week: ${w.map((v, i) => `week ${i + 1} ${v == null ? "did not play" : v}`).join(", ")}">${grid.join("")}${avgLine}${bars}</svg>`;
  }
  function ggTip(lvl, P) {
    const tip = GG.tip[lvl];
    const vals = P.w.filter(v => v != null), total = vals.reduce((a, c) => a + c, 0);
    if (tip) return tip.v === "" ? `Week ${tip.wk}: didn't play` : `Week ${tip.wk}: <b>${Number(tip.v).toFixed(1)}</b> pts`;
    return `${vals.length} games · ${total.toFixed(1)} pts · <span class="gg-avg-key"></span> average ${(vals.length ? total / vals.length : 0).toFixed(1)}`;
  }
  function graphView() {
    const T = GG.data;
    if (!T || T.error) { main.innerHTML = gameHead("graph", "Guess the graph") + `<div class="empty">${esc((T && T.error) || "Couldn't load Guess the graph.")} <button type="button" class="linkbtn" data-gg="reload">Try again</button></div>`; return; }
    const B = T.board || {};
    const leaders = Object.entries(B).map(([m, r]) => ({ m, ...r })).sort((a, b) => b.total - a.total || b.right - a.right);
    const leaderboard = leaders.length ? section("Season leaderboard", "Easy 1 point, Medium 2, Hard 3.", table([
      { label: "Player", cell: r => `<b>${esc(nameOfMember(r.m))}</b>` },
      { label: "Points", num: 1, cell: r => `<b>${r.total}</b>` },
      { label: "Right", num: 1, cell: r => `${r.right} of ${r.tries}` },
      { label: "Weeks played", num: 1, cell: r => Object.keys(r.weeks || {}).length || "—" },
    ], leaders)) : "";
    if (T.over) { main.innerHTML = gameHead("graph", "Guess the graph", '<p class="sub">The season is over. Back next season.</p>') + leaderboard; return; }
    const intro = expl("Whose season is this? Each bar is one week's fantasy points. Three graphs a week: Easy, Medium and Hard.",
      `Each graph is one player's fantasy points (our scoring) in every completed week this season, with his position but not his team. Pick him from four names. <b>Easy</b> is one of the top players at his position against three much lower scorers; <b>Medium</b> is a top-16 player against players ranked near him; <b>Hard</b> is a deeper player against the three whose season totals are closest to his. One guess each, worth 1, 2 and 3 points. A dash is a week he didn't play (bye or injury); the dashed line is his average. New graphs every week, and no player is the answer twice in a season.`, "graph");
    const card = P => {
      const g = GG.guesses[P.level];
      const opts = P.options.map(o => {
        const cls = !g ? "" : o.id === g.answer ? " right" : o.id === g.guess ? " wrong" : " dim";
        return `<button type="button" class="gg-opt${cls}" data-gg-guess="${P.level}" data-id="${o.id}"${g || GG.busy ? " disabled" : ""}>${esc(o.n)}${g && o.id === g.answer ? " ✓" : g && o.id === g.guess ? " ✕" : ""}</button>`;
      }).join("");
      const res = g ? `<p class="gg-res ${g.right ? "pos" : "neg"}">${g.right ? `Got it: <b>${esc(g.name)}</b> · +${(T.pts || {})[P.level] || ""}` : `It was <b>${esc(g.name)}</b>`}</p>` : "";
      return `<article class="gg-card"><div class="gg-h"><span class="gg-lvl ${P.level}">${GG_LABEL[P.level]}</span><span class="slot ${esc(P.pos)}">${esc(P.pos)}</span><span class="team-mgr">${(T.pts || {})[P.level] || ""} pt${(T.pts || {})[P.level] === 1 ? "" : "s"} · weeks 1–${P.through}</span></div>
        ${graphSvg(P.w, P.level)}<p class="gg-tip" data-gg-tip="${P.level}">${ggTip(P.level, P)}</p>
        <div class="gg-opts">${opts}</div>${res}</article>`;
    };
    const results = Object.entries(T.results || {});
    const week = results.length ? section(`Week ${T.week} so far`, "", `<div class="gg-week">${results.map(([m, r]) => `<span><b>${esc(nameOfMember(m))}</b> ${["easy", "medium", "hard"].map(k => r[k] == null ? '<i class="gg-dot"></i>' : `<i class="gg-dot ${r[k] ? "y" : "n"}" title="${GG_LABEL[k]}: ${r[k] ? "right" : "wrong"}"></i>`).join("")}</span>`).join("")}</div>`) : "";
    const msg = GG.msg ? `<p class="note${GG.err ? " live" : ""}">${esc(GG.msg)}</p>` : "";
    main.innerHTML = gameHead("graph", "Guess the graph", intro) + (GG.ready ? "" : gameWho("gg", false, "Sign in to guess. Same name and PIN as pick'em.")) + msg +
      `<div class="gg-grid">${T.puzzles.map(card).join("")}</div>` + week + leaderboard;
  }
  main.addEventListener("click", async e => {
    if (!(state.tab === "games" && state.sub === "graph")) return;
    const bar = e.target.closest("[data-gg-bar]");
    if (bar) { GG.tip[bar.dataset.ggBar] = { wk: bar.dataset.wk, v: bar.dataset.v }; return ggPaintTip(bar.dataset.ggBar); }
    const a = e.target.closest("[data-gg]");
    if (a && a.dataset.gg === "reload") { GG.data = null; return renderGraph(); }
    if (a && a.dataset.gg === "continue") {
      const r = await gameSignIn("gg", "/graph/mine");
      if (r.error) { GG.msg = r.error; GG.err = true; GG.ready = false; return graphView(); }
      ggLoad(r); return graphView();
    }
    const g = e.target.closest("[data-gg-guess]");
    if (!g || g.disabled) return;
    if (!GG.ready) { GG.msg = "Sign in above first, then pick a name."; GG.err = true; return graphView(); }
    GG.busy = true; graphView();
    const r = await pkApi("/graph/guess", { member: PK.member, pin: PK.pin, level: g.dataset.ggGuess, id: Number(g.dataset.id) });
    GG.busy = false;
    if (r.guesses) GG.guesses = r.guesses;
    if (r.error) { GG.msg = r.error; GG.err = true; return graphView(); }
    GG.msg = ""; GG.err = false;
    if (r.board) GG.data.board = r.board;
    GG.data = await pkApi("/graph").catch(() => GG.data); GG.at = Date.now();
    graphView();
  });
  function ggPaintTip(lvl) {
    const el = main.querySelector(`[data-gg-tip="${lvl}"]`), P = GG.data && (GG.data.puzzles || []).find(x => x.level === lvl);
    if (el && P) el.innerHTML = ggTip(lvl, P);
    main.querySelectorAll(`[data-gg-bar="${lvl}"]`).forEach(h => h.classList.toggle("on", GG.tip[lvl] && h.dataset.wk === GG.tip[lvl].wk));
  }
  main.addEventListener("mouseover", e => {
    const bar = e.target.closest && e.target.closest("[data-gg-bar]");
    if (!bar) return;
    GG.tip[bar.dataset.ggBar] = { wk: bar.dataset.wk, v: bar.dataset.v };
    ggPaintTip(bar.dataset.ggBar);
  });
  main.addEventListener("mouseout", e => {
    const bar = e.target.closest && e.target.closest("[data-gg-bar]");
    if (!bar || (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(`[data-gg-bar="${bar.dataset.ggBar}"]`))) return;
    GG.tip[bar.dataset.ggBar] = null;
    ggPaintTip(bar.dataset.ggBar);
  });

  // ---------------------------------------------------------------- reactions
  // One-tap emoji under matchups, big plays and the weekly high / low score, as your team (name + PIN). Counts come
  // from the live worker, refreshed at most once a minute per week; tapping is shown right away and then saved.
  const RX = { weeks: {}, open: null, who: null, msg: "" };
  const RX_EMOJI = ["🔥", "😂", "💀", "👏", "🗑️"];
  const rxOn = () => state.season === IDX.current && !!LIVE_API_BASE();
  function rxRow(week, item) {
    if (!rxOn()) return "";
    return `<div class="rx" data-rx-week="${week}" data-rx-item="${esc(item)}">${rxInner(week, item)}</div>`;
  }
  function rxInner(week, item) {
    const it = ((RX.weeks[week] || {}).items || {})[item] || {};
    const me = PK.member;
    const open = RX.open === week + "|" + item;
    const used = RX_EMOJI.filter(em => (it[em] || []).length);
    const btn = em => {
      const who = it[em] || [];
      const names = who.map(nameOfMember).join(", ");
      return `<button type="button" class="rx-b${who.includes(me) ? " mine" : ""}" data-rx-em="${em}" title="${esc(names || "React with " + em)}" aria-label="${em} ${who.length}${names ? ": " + esc(names) : ""}">${em}${who.length ? `<span>${who.length}</span>` : ""}</button>`;
    };
    let pop = "";
    if (open) {
      pop = (PK.member && PK.pin) ? `<span class="rx-pick">${RX_EMOJI.filter(em => !used.includes(em)).map(btn).join("")}</span>`
        : `<span class="rx-sign"><select data-rx-member aria-label="Your name"><option value="">Your name</option>${pkMembers().map(m => `<option value="${esc(m.id)}"${m.id === PK.member ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</select>
          <input data-rx-pin type="password" inputmode="numeric" maxlength="4" placeholder="PIN" aria-label="PIN" autocomplete="off"><button type="button" class="linkbtn" data-rx-go>OK</button></span>`;
    }
    const who = RX.who === week + "|" + item ? `<span class="rx-who">${RX_EMOJI.filter(em => (it[em] || []).length).map(em => `${em} ${esc(it[em].map(nameOfMember).join(", "))}`).join(" · ")}</span>` : "";
    return `${used.map(btn).join("")}<button type="button" class="rx-add" data-rx-add aria-label="Add a reaction" aria-expanded="${open}">${open ? "×" : "☺+"}</button>${pop}${who}${RX.msg && open ? `<span class="rx-msg">${esc(RX.msg)}</span>` : ""}`;
  }
  function rxPaint(week) {
    document.querySelectorAll(`.rx[data-rx-week="${week}"]`).forEach(el => { el.innerHTML = rxInner(week, el.dataset.rxItem); });
  }
  async function rxHydrate() {
    if (!rxOn()) return;
    const weeks = [...new Set([...document.querySelectorAll(".rx")].map(el => el.dataset.rxWeek))];
    for (const w of weeks) {
      const have = RX.weeks[w];
      if (have && Date.now() - have.at < 60000) { rxPaint(w); continue; }
      const r = await pkApi(`/react?week=${w}`).catch(() => null);
      if (r && !r.error) RX.weeks[w] = { at: Date.now(), items: r.items || {} };
      rxPaint(w);
    }
  }
  async function rxToggle(week, item, em) {
    const W = RX.weeks[week] = RX.weeks[week] || { at: 0, items: {} };
    const it = W.items[item] = W.items[item] || {};
    const list = it[em] = (it[em] || []).slice();
    const i = list.indexOf(PK.member);
    if (i >= 0) list.splice(i, 1); else list.push(PK.member);
    RX.open = null; RX.msg = "";
    rxPaint(week);
    const r = await pkApi("/react/toggle", { member: PK.member, pin: PK.pin, week: Number(week), item, emoji: em });
    if (r.error) { RX.open = week + "|" + item; RX.msg = r.error; W.at = 0; if (/PIN/.test(r.error)) PK.pin = ""; }
    else W.items = r.items, W.at = Date.now();
    rxPaint(week);
  }
  let rxHold = null, rxHeld = false;
  document.addEventListener("pointerdown", e => {
    const b = e.target.closest(".rx-b");
    if (!b) return;
    const box = b.closest(".rx");
    rxHeld = false;
    rxHold = setTimeout(() => { rxHeld = true; RX.who = box.dataset.rxWeek + "|" + box.dataset.rxItem; rxPaint(box.dataset.rxWeek); }, 450);
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach(t => document.addEventListener(t, () => clearTimeout(rxHold), true));
  document.addEventListener("click", async e => {
    const box = e.target.closest(".rx");
    if (!box) { if (RX.who) { const w = RX.who.split("|")[0]; RX.who = null; rxPaint(w); } return; }
    e.stopPropagation(); // keep a tap here from also opening the matchup around it
    if (e.target.closest("select, input")) return;
    e.preventDefault();
    const week = box.dataset.rxWeek, item = box.dataset.rxItem, key = week + "|" + item;
    if (rxHeld) { rxHeld = false; return; }
    if (RX.who) { RX.who = null; rxPaint(week); }
    if (e.target.closest("[data-rx-add]")) { RX.open = RX.open === key ? null : key; RX.msg = ""; return rxPaint(week); }
    if (e.target.closest("[data-rx-go]")) {
      const member = box.querySelector("[data-rx-member]").value, pin = box.querySelector("[data-rx-pin]").value.trim();
      if (!member || !/^\d{4}$/.test(pin)) { RX.msg = "Choose your name and enter your 4-digit PIN."; return rxPaint(week); }
      const r = await pkApi("/pickem/claim", { member, pin });
      if (r.error) { RX.msg = r.error; return rxPaint(week); }
      PK.member = member; PK.pin = pin; store.set("pk-member", member); // the PIN stays in memory unless "Remember me" was ticked in a game
      if (store.get("pk-pin", "")) store.set("pk-pin", pin);
      RX.msg = ""; return rxPaint(week);
    }
    const b = e.target.closest("[data-rx-em]");
    if (!b) return;
    if (!PK.member || !PK.pin) { RX.open = key; return rxPaint(week); }
    rxToggle(week, item, b.dataset.rxEm);
  }, true);
  document.addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.matches && e.target.matches("[data-rx-pin]")) { e.preventDefault(); e.target.closest(".rx").querySelector("[data-rx-go]").click(); }
  });


  // ---------------------------------------------------------------- trash talk
  // A short comment thread under each matchup, weekly recap and trade (current season), posted as your team with
  // name + PIN like reactions. Threads are fetched per week (matchups + recap) or for all trades, at most once a minute.
  const TK = { scopes: {}, open: null, msg: "", busy: false, drafts: {}, admins: null };
  const TALK_MAX = 280;
  function talkRow(scope, item) {
    if (!rxOn()) return "";
    return `<div class="tk" data-tk-scope="${esc(scope)}" data-tk-item="${esc(item)}">${talkInner(scope, item)}</div>`;
  }
  function talkInner(scope, item) {
    const posts = ((TK.scopes[scope] || {}).items || {})[item] || [];
    const key = scope + "|" + item, open = TK.open === key;
    const n = posts.length;
    const last = posts[n - 1];
    const toggle = `<button type="button" class="tk-toggle" data-tk-toggle aria-expanded="${open}">💬 ${n ? `${n} comment${n === 1 ? "" : "s"}` : "Talk trash"}${open ? " ↑" : ""}</button>`;
    if (!open) return toggle + (last ? `<span class="tk-peek"><b>${esc(nameOfMember(last.m))}:</b> ${esc(last.x)}</span>` : "");
    const me = PK.member, admin = (TK.admins || []).includes(me);
    const list = posts.map(p => `<li class="tk-post${p.m === me ? " mine" : ""}"><div class="tk-meta"><b>${esc(nameOfMember(p.m))}</b><span class="team-mgr">${pulseAgo(p.t)}</span>
      ${p.m === me || admin ? `<button type="button" class="tk-del" data-tk-del="${esc(p.id)}" aria-label="Delete this comment" title="Delete">×</button>` : ""}</div><p>${esc(p.x)}</p></li>`).join("");
    const draft = TK.drafts[key] || "";
    const compose = PK.member && PK.pin
      ? `<div class="tk-compose"><textarea data-tk-text rows="2" maxlength="${TALK_MAX}" placeholder="Say something, ${esc(nameOfMember(me))}…" aria-label="Your comment">${esc(draft)}</textarea>
          <div class="tk-row"><span class="team-mgr tk-count">${[...draft].length}/${TALK_MAX}</span><button type="button" class="cta tk-send" data-tk-send${TK.busy ? " disabled" : ""}>Post</button></div></div>`
      : `<div class="tk-sign"><span class="team-mgr">Post as your team:</span><select data-tk-member aria-label="Your name"><option value="">Your name</option>${pkMembers().map(m => `<option value="${esc(m.id)}"${m.id === PK.member ? " selected" : ""}>${esc(m.name)}</option>`).join("")}</select>
          <input data-tk-pin type="password" inputmode="numeric" maxlength="4" placeholder="PIN" aria-label="PIN" autocomplete="off"><button type="button" class="linkbtn" data-tk-go>OK</button></div>`;
    return toggle + `<ul class="tk-list">${list || '<li class="team-mgr tk-empty">No comments yet. Start it.</li>'}</ul>${compose}${TK.msg ? `<p class="tk-msg" role="status">${esc(TK.msg)}</p>` : ""}`;
  }
  function talkPaint(scope, item) {
    document.querySelectorAll(`.tk[data-tk-scope="${scope}"]`).forEach(el => { if (!item || el.dataset.tkItem === item) el.innerHTML = talkInner(scope, el.dataset.tkItem); });
  }
  async function talkHydrate() {
    if (!rxOn()) return;
    const scopes = [...new Set([...document.querySelectorAll(".tk")].map(el => el.dataset.tkScope))];
    if (scopes.length && TK.admins == null) { TK.admins = []; pkApi("/feedback").then(r => { TK.admins = (r && r.admins) || []; }).catch(() => {}); }
    for (const sc of scopes) {
      const have = TK.scopes[sc];
      if (have && Date.now() - have.at < 60000) { talkPaint(sc); continue; }
      const r = await pkApi(`/talk?scope=${sc}`).catch(() => null);
      if (r && !r.error) TK.scopes[sc] = { at: Date.now(), items: r.items || {} };
      talkPaint(sc);
    }
  }
  async function talkSend(scope, item, body, path) {
    TK.busy = true; TK.msg = ""; talkPaint(scope, item);
    const r = await pkApi(path, { member: PK.member, pin: PK.pin, scope, item, ...body });
    TK.busy = false;
    if (r.error) { TK.msg = r.error; if (/PIN/.test(r.error)) PK.pin = ""; }
    else { TK.scopes[scope] = { at: Date.now(), items: r.items || {} }; if (path === "/talk/post") delete TK.drafts[scope + "|" + item]; }
    talkPaint(scope, item);
    if (!r.error && path === "/talk/post") { const t = document.querySelector(`.tk[data-tk-scope="${scope}"][data-tk-item="${item}"] [data-tk-text]`); if (t) t.focus(); }
  }
  document.addEventListener("click", async e => {
    const box = e.target.closest(".tk");
    if (!box) return;
    e.stopPropagation(); // keep a tap here from also opening the matchup around it
    if (e.target.closest("select, input, textarea")) return;
    e.preventDefault();
    const scope = box.dataset.tkScope, item = box.dataset.tkItem, key = scope + "|" + item;
    if (e.target.closest("[data-tk-toggle]")) {
      const prev = TK.open;
      TK.open = TK.open === key ? null : key; TK.msg = "";
      if (prev && prev !== key) { const [ps, pi] = [prev.slice(0, prev.indexOf("|")), prev.slice(prev.indexOf("|") + 1)]; talkPaint(ps, pi); }
      talkPaint(scope, item);
      if (TK.open) { const t = box.querySelector("[data-tk-text]"); if (t) t.focus(); }
      return;
    }
    if (e.target.closest("[data-tk-go]")) {
      const member = box.querySelector("[data-tk-member]").value, pin = box.querySelector("[data-tk-pin]").value.trim();
      if (!member || !/^\d{4}$/.test(pin)) { TK.msg = "Choose your name and enter your 4-digit PIN."; return talkPaint(scope, item); }
      const r = await pkApi("/pickem/claim", { member, pin });
      if (r.error) { TK.msg = r.error; return talkPaint(scope, item); }
      PK.member = member; PK.pin = pin; store.set("pk-member", member);
      if (store.get("pk-pin", "")) store.set("pk-pin", pin);
      TK.msg = ""; return talkPaint(scope, item);
    }
    if (e.target.closest("[data-tk-send]")) {
      const text = (TK.drafts[key] || "").trim();
      if (!text) { TK.msg = "Write something first."; return talkPaint(scope, item); }
      return talkSend(scope, item, { text }, "/talk/post");
    }
    const del = e.target.closest("[data-tk-del]");
    if (del && confirm("Delete this comment?")) talkSend(scope, item, { id: del.dataset.tkDel }, "/talk/delete");
  }, true);
  document.addEventListener("input", e => {
    if (!e.target.matches || !e.target.matches("[data-tk-text]")) return;
    const box = e.target.closest(".tk"), key = box.dataset.tkScope + "|" + box.dataset.tkItem;
    TK.drafts[key] = e.target.value;
    const c = box.querySelector(".tk-count"); if (c) c.textContent = `${[...e.target.value].length}/${TALK_MAX}`;
  });
  document.addEventListener("keydown", e => {
    if (!e.target.matches) return;
    if (e.key === "Enter" && e.target.matches("[data-tk-pin]")) { e.preventDefault(); e.target.closest(".tk").querySelector("[data-tk-go]").click(); }
    if (e.key === "Enter" && !e.shiftKey && e.target.matches("[data-tk-text]")) { e.preventDefault(); e.target.closest(".tk").querySelector("[data-tk-send]").click(); }
  });

  async function pkContinue() {
    const member = document.getElementById("pk-member").value;
    const pin = document.getElementById("pk-pin").value.trim();
    const remember = document.getElementById("pk-remember").checked;
    if (!member) { PK.msg = "Choose your name first."; PK.err = true; return pickemView(); }
    if (!/^\d{4}$/.test(pin)) { PK.msg = "Enter a 4-digit PIN."; PK.err = true; return pickemView(); }
    const r = await pkApi("/pickem/mine", { member, pin });
    if (r.error) { PK.msg = r.error; PK.err = true; PK.ready = false; return pickemView(); }
    if (member !== PK.member) { TV.ready = false; TV.result = null; TV.score = null; TV.sel = []; TV.auto = false; P3.ready = false; P3.auto = false; P3.sel = {}; P3.saved = {}; }
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
  // Efficiency tab: each team's real lineups vs. the lineup ESPN's projections would have started ("autopilot")
  function autopilotSection() {
    const rows = D.teams.filter(t => t.autopilot && t.autopilot.weeks).sort((a, b) => b.autopilot.diff - a.autopilot.diff);
    if (!rows.length) return "";
    const swung = a => {
      const n = a.won - a.lost;
      const parts = [];
      if (a.won) parts.push(`won ${a.won}`);
      if (a.lost) parts.push(`lost ${a.lost}`);
      return parts.length ? `<b class="${n > 0 ? "pos" : n < 0 ? "neg" : ""}">${n > 0 ? "+" : ""}${n}</b> <span class="muted">(${parts.join(", ")})</span>` : '<span class="muted">0</span>';
    };
    const call = (x, good) => x && (good ? x[1] > 0.05 : x[1] < -0.05) ? `Wk ${x[0]} ${signedPts(x[1], true)}` : '<span class="muted">none</span>';
    return section("You vs. autopilot", { short: "Your lineup calls vs. starting ESPN's projected best lineup every week.", full: "Autopilot starts the best lineup by ESPN's pre-game projections from the roster you actually had that week, and never makes a call of its own. <b>Your calls</b> is how many more (or fewer) points your real lineups scored than autopilot would have. <b>Games swung</b> counts games your calls won that autopilot would have lost, minus games autopilot would have won that you lost (the opponent's real score stays the same). Unlike efficiency, which compares you with a perfect lineup in hindsight, this only uses what was known before kickoff, so it measures your judgment. Regular season." }, table([
      { label: "Team", cell: teamCell },
      { label: "Your calls", num: 1, cell: t => signedPts(t.autopilot.diff, true) },
      { label: "Your lineups", num: 1, cell: t => t.autopilot.real.toFixed(1) },
      { label: "Autopilot", num: 1, cell: t => t.autopilot.auto.toFixed(1) },
      { label: "Games swung", num: 1, cell: t => swung(t.autopilot) },
      { label: "Best call", num: 1, cell: t => call(t.autopilot.best, true) },
      { label: "Worst call", num: 1, cell: t => call(t.autopilot.worst, false) },
    ], rows));
  }
  const teamCell = t => `<span class="tcell${isMine(t) ? " mine" : ""}">${logo(t)}<span><span class="tname">${esc(t.name)}</span><span class="team-mgr">${esc(t.manager)}</span></span></span>`;
  // the fill is a share of its own fixed-width track, so 50% is exactly half as long as 100%
  const barCell = (v, cls) => `<span class="pbar"><span class="pbar-track"><span class="pbar-fill ${cls || ""}" style="width:${Math.max(0, Math.min(100, v || 0))}%"></span></span><span class="pbar-v">${pct(v)}</span></span>`;
  const signedPts = (n, goodHigh) => `<b class="${(goodHigh ? n > 0.05 : n < -0.05) ? "pos" : (goodHigh ? n < -0.05 : n > 0.05) ? "neg" : ""}">${signed(n)}</b>`;
  const tname = id => (teamById[id] || { name: "Team " + id }).name;
  const poss = name => name + (/s$/i.test(name.trim()) ? "’" : "’s"); // Avengers' / Club's
  // explanation that shows in full on desktop; on phones a one-line summary with an ⓘ that expands it
  const expl = (short, full, term) => `<p class="sub expl"><span class="expl-short">${short}</span><span class="expl-full">${full}${term ? ` <a class="expl-g" href="#/glossary?t=${term}">In the glossary ›</a>` : ""}</span>
    <button type="button" class="info-btn" aria-expanded="false" aria-label="How this works">i</button></p>`;
  const section = (title, sub, body) => `<section class="insight"><div class="section-head"><div><h2>${title}</h2>${!sub ? "" : typeof sub === "string" ? `<p class="sub">${sub}</p>` : expl(sub.short, sub.full, GLOSSARY_BY_TITLE[String(title).replace(/<[^>]*>/g, "").trim()])}</div></div>${body}</section>`;

  function subnav(tab, items, cur, extra) {
    return `<nav class="subnav" aria-label="${tab[0].toUpperCase() + tab.slice(1)} sections">${items.map(([k, label]) =>
      `<a href="${href(tab, extra || {}, k)}" class="${k === cur ? "active" : ""}"${k === cur ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
  }

  // favorites and underdogs by ESPN's pre-game projection for each lineup (Insights -> Luck -> Upset tracker)
  function upsetModel() {
    const teams = {};
    let games = 0, favWins = 0;
    D.teams.forEach(t => { teams[t.id] = { games: 0, favW: 0, favL: 0, dogW: 0, dogL: 0, bestUpset: null, worstLoss: null }; });
    D.weeks.filter(w => w.final && w.week <= L.regularSeasonWeeks).forEach(w => w.games.forEach(g => {
      if (g.sides.length !== 2 || !["HOME", "AWAY"].includes(g.winner)) return;
      const [a, b] = g.sides;
      if (!a.projected || !b.projected || Math.abs(a.projected - b.projected) < 0.005) return;
      const fav = a.projected > b.projected ? a : b, dog = fav === a ? b : a;
      const winner = g.winner === "HOME" ? a : b, gap = Math.round((fav.projected - dog.projected) * 10) / 10;
      const F = teams[fav.team], U = teams[dog.team];
      if (!F || !U) return;
      games++; F.games++; U.games++;
      if (winner === fav) { favWins++; F.favW++; U.dogL++; return; }
      F.favL++; U.dogW++;
      if (!U.bestUpset || gap > U.bestUpset.gap) U.bestUpset = { gap, opp: fav.team, week: w.week, game: g.id };
      if (!F.worstLoss || gap > F.worstLoss.gap) F.worstLoss = { gap, opp: dog.team, week: w.week, game: g.id };
    }));
    return { teams, games, favWins };
  }

  // Insights pages. Each groups related views, shown one at a time with a switch at the top; the old one-view
  // sub-tabs still work as links (they open the page that holds them now, on that view).
  const INSIGHT_GROUPS = [
    ["luck", "Luck", ["luck", "close", "upsets", "projection", "usage", "injury"]],
    ["form", "Hot & cold", ["form"]],
    ["schedule", "Schedule", ["schedule", "byes"]],
    ["lineups", "Lineups", ["efficiency", "autopilot"]],
    ["draft", "Draft", ["draft"]],
    ["whatif", "What ifs", ["rules", "swap", "butterfly"]],
  ];
  const INSIGHT_ALIAS = { close: "luck", upsets: "luck", projection: "luck", usage: "luck", injury: "luck", byes: "schedule", efficiency: "lineups", autopilot: "lineups", redraft: "draft", rules: "whatif", swap: "whatif", butterfly: "whatif" };
  function insightHas(k) {
    return ({
      build: () => scnGames().length > 0, form: () => D.teams.some(x => x.form), seeds: () => D.teams.some(x => x.odds && x.odds.seeds), projection: () => D.teams.some(x => x.vsProj), upsets: () => upsetModel().games > 0, injury: () => D.teams.some(x => x.injuries), usage: () => !!(D.nfl && D.nfl.teams && Object.keys(D.nfl.teams).length), autopilot: () => D.teams.some(x => x.autopilot && x.autopilot.weeks),
      byes: () => D.teams.some(x => x.byeCrunch && x.byeCrunch.length), draft: () => !!D.draft,
      redraft: () => !!(D.draft && D.draft.redraft), rules: () => !!(D.rulesLab && D.rulesLab.weeks),
      swap: () => !!(D.scheduleSwap && D.scheduleSwap.weeks),
      butterfly: () => D.weeks.some(w => w.final && w.week <= L.regularSeasonWeeks),
    }[k] || (() => true))();
  }
  function insightPartLabel(k) {
    if (k === "race") return D.teams.some(t => t.odds) ? "Playoff odds" : "Final results";
    return { build: "Scenario builder", seeds: "Seed odds", form: "Hot & cold", luck: "Luck", close: "Close games", upsets: "Upset tracker", projection: "Vs. projection", usage: "Vs. usage",
      injury: "Injury toll", schedule: "Strength of schedule", byes: "Byes ahead", efficiency: "Efficiency", autopilot: "You vs. autopilot", rules: "Rules lab", swap: "Schedule swap", butterfly: "Butterfly effect" }[k] || k;
  }
  function insightTabs() {
    return INSIGHT_GROUPS.filter(([, , keys]) => keys.some(insightHas)).map(([k, label]) => [k, label]);
  }

  // ---------------------------------------------------------------- scenario builder (Playoffs → Scenario builder)
  // Pick the winner of every regular-season game left; the standings, seeds, byes and first round update as you go.
  // Ties in the standings go to total points: each team's projected final points (the playoff simulations' average,
  // this week's live projection included), which can be nudged. Favorites come from ESPN's live win probability this
  // week and the playoff odds' weekly scoring model after that. The picks live in the link (?s=week.picks), so a
  // scenario can be shared; an older link drops the weeks that have been played since.
  const SCN = { picks: null, sig: "", src: "", adj: {}, note: "" };
  const erf = x => { const t = 1 / (1 + 0.3275911 * Math.abs(x)), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
  function scnP(h, a) {
    const A = (teamById[h] || {}).odds, B = (teamById[a] || {}).odds;
    if (!A || !B || !A.wk || !B.wk) return 0.5;
    return 0.5 * (1 + erf((A.wk[0] - B.wk[0]) / Math.sqrt(A.wk[1] ** 2 + B.wk[1] ** 2 || 1) / Math.SQRT2));
  }
  function scnGames() {
    if (!L || !L.isCurrent || L.over || !D.teams.some(t => t.odds)) return [];
    const RS = L.regularSeasonWeeks, out = [];
    const cur = D.weeks.find(w => w.week === L.currentWeek && !w.final && w.week <= RS);
    if (cur) cur.games.filter(g => g.sides.length === 2 && !g.playoff).forEach(g => {
      const [h, a] = g.sides, wp = h.winProb != null && a.winProb != null && h.winProb + a.winProb > 0;
      const done = wp && (h.winProb === 1 || a.winProb === 1);
      out.push({ week: cur.week, h: h.team, a: a.team, pH: wp ? h.winProb / (h.winProb + a.winProb) : scnP(h.team, a.team), live: [h.pts, a.pts],
        locked: done ? (h.winProb === 1 ? 0 : 1) : null });
    });
    const after = cur ? cur.week : L.currentWeek - 1;
    (D.upcoming || []).filter(u => u.week > after && u.week <= RS && (u.teams || []).length === 2 && u.teams.every(t => teamById[t]))
      .forEach(u => out.push({ week: u.week, h: u.teams[0], a: u.teams[1], pH: scnP(u.teams[0], u.teams[1]) }));
    return out;
  }
  const scnFav = games => games.map(g => g.locked != null ? g.locked : g.pH >= 0.5 ? 0 : 1);
  // the picks for these games: from the link if it matches (dropping weeks played since it was made), else favorites
  function scnLoad(games) {
    const sig = games.map(g => g.week + ":" + g.h + "-" + g.a).join(",");
    const src = (state.params.get("s") || "") + "|" + (state.params.get("adj") || "");
    if (SCN.sig === sig && SCN.src === src && SCN.picks) return;
    SCN.sig = sig; SCN.src = src; SCN.picks = scnFav(games); SCN.adj = {}; SCN.note = "";
    const raw = state.params.get("s") || "";
    const m = raw.match(/^(\d+)\.([ha]+)$/);
    if (m && games.length) {
      const per = Math.max(1, Math.floor(L.size / 2)), skip = (games[0].week - Number(m[1])) * per;
      const chars = skip >= 0 ? m[2].slice(skip) : "";
      if (chars.length === games.length) chars.split("").forEach((c, i) => { if (games[i].locked == null) SCN.picks[i] = c === "h" ? 0 : 1; });
      else SCN.note = "That shared scenario doesn't match the games left anymore, so this starts from the favorites.";
      if (skip > 0 && chars.length === games.length) SCN.note = `That scenario was shared before week ${games[0].week}; the games played since are left out.`;
    }
    (state.params.get("adj") || "").split(",").forEach(x => { const [id, v] = x.split(":"); if (teamById[id] && isFinite(+v)) SCN.adj[id] = +v; });
  }
  function scnParams(games) {
    const p = {};
    if (games.length && SCN.picks.some((x, i) => x !== scnFav(games)[i])) p.s = games[0].week + "." + SCN.picks.map(x => x ? "a" : "h").join("");
    const adj = Object.entries(SCN.adj).filter(([, v]) => v).map(([k, v]) => k + ":" + v).join(",");
    if (adj) p.adj = adj;
    return p;
  }
  function scnStandings(games) {
    const rows = D.teams.map(t => ({ t, w: t.wins, l: t.losses, tie: t.ties || 0, pts: (t.odds && t.odds.projPF != null ? t.odds.projPF : t.pf) + (SCN.adj[t.id] || 0) }));
    const by = Object.fromEntries(rows.map(r => [r.t.id, r]));
    games.forEach((g, i) => { const [win, lose] = SCN.picks[i] === 0 ? [g.h, g.a] : [g.a, g.h]; by[win].w++; by[lose].l++; });
    const score = r => r.w + r.tie / 2;
    rows.sort((a, b) => score(b) - score(a) || b.pts - a.pts);
    const po = L.playoffTeams || 0, byes = Math.max(0, 2 ** (L.playoffRounds || 1) - po);
    rows.forEach((r, i) => {
      r.seed = i + 1;
      r.status = r.seed <= byes ? "bye" : r.seed <= po ? "po" : "out";
      // level on wins with someone on the other side of a cut it sits at = that spot came down to points
      r.onPts = [byes, po].some(c => c && rows.some((o, j) => o !== r && score(o) === score(r) && (j < c) !== (i < c)));
    });
    return { rows, po, byes };
  }
  function scnBody() {
    const games = scnGames();
    if (!games.length) return `<div class="panel">There are no regular-season games left to pick.</div>`;
    scnLoad(games);
    const { rows, po, byes } = scnStandings(games);
    const me = rows.find(r => isMine(r.t));
    const fav = scnFav(games), changed = SCN.picks.filter((x, i) => x !== fav[i]).length;
    const nm = id => esc(tname(id));
    const STAT = { bye: "Bye", po: "Playoffs", out: "Out" };
    let summary = "";
    if (me) {
      const first = me.status === "po" ? (() => { const opp = rows[po + byes - me.seed]; return opp && opp !== me ? `, first round against ${esc(opp.t.name)} (#${opp.seed})` : ""; })() : "";
      summary = `<p class="scn-me ${me.status}">In this scenario you finish <b>${ordinal(me.seed)}</b> at ${me.w}–${me.l}${me.tie ? "–" + me.tie : ""}: <b>${me.status === "bye" ? "a first-round bye" : me.status === "po" ? "in the playoffs" : "out of the playoffs"}</b>${first}${me.onPts ? (me.status === "out" ? ", missing out on points" : ", on points") : ""}.</p>`;
    }
    const weeks = [...new Set(games.map(g => g.week))];
    const gameHtml = (g, i) => {
      const pick = SCN.picks[i], lock = g.locked != null;
      const btn = (side, id, p) => `<button type="button" class="scn-b${pick === side ? " on" : ""}" data-scn="${i}:${side}" aria-pressed="${pick === side}"${lock ? " disabled" : ""}>${logo(teamById[id])}<span class="scn-n">${nm(id)}</span><span class="scn-p">${g.live && lock ? "" : Math.round(100 * p) + "%"}</span></button>`;
      return `<div class="scn-g${lock ? " locked" : ""}" role="group" aria-label="Week ${g.week}: ${esc(tname(g.h))} vs. ${esc(tname(g.a))}">${btn(0, g.h, g.pH)}${btn(1, g.a, 1 - g.pH)}${g.live ? `<p class="scn-live">${lock ? "Decided" : "Live"}: ${fmt(g.live[0])}–${fmt(g.live[1])}</p>` : ""}</div>`;
    };
    const cut = (r, i) => i + 1 === byes ? " cut-bye" : i + 1 === po ? " cut-po" : "";
    const moved = r => { const d = (r.t.standing || r.seed) - r.seed; return d > 0 ? `<span class="pos">▲${d}</span>` : d < 0 ? `<span class="neg">▼${-d}</span>` : '<span class="muted">–</span>'; };
    const firstRound = [];
    for (let s = byes + 1, e = po; s < e; s++, e--) firstRound.push(`<b>#${s}</b> ${esc(rows[s - 1].t.name)} vs. <b>#${e}</b> ${esc(rows[e - 1].t.name)}`);
    const adjRows = D.teams.slice().sort((a, b) => a.name.localeCompare(b.name)).map(t => `<label class="scn-adj"><span>${esc(t.name)}</span><input type="number" step="5" inputmode="decimal" data-scn-adj="${t.id}" value="${SCN.adj[t.id] || 0}" aria-label="Points to add to ${esc(t.name)}'s projection"></label>`).join("");
    return `${SCN.note ? `<p class="scn-note">${esc(SCN.note)}</p>` : ""}${summary}
      <div class="scn-bar">
        <button type="button" class="scn-act" data-scn="fav"${changed ? "" : " disabled"}>Favorites${changed ? ` <span class="muted">(${changed} changed)</span>` : ""}</button>
        ${me ? `<button type="button" class="scn-act" data-scn="winout">You win out</button><button type="button" class="scn-act" data-scn="loseout">You lose out</button>` : ""}
        <button type="button" class="scn-act share" data-scn="share">Share this scenario</button>
      </div>
      <div class="scn-grid">
        <div class="scn-games">${weeks.map(w => `<div class="scn-week"><h3 class="scn-wh">Week ${w}${w === L.currentWeek && games.some(g => g.live) ? ' <span class="muted">· in progress</span>' : ""}</h3>${games.map((g, i) => g.week === w ? gameHtml(g, i) : "").join("")}</div>`).join("")}</div>
        <div class="scn-res">
          <h3 class="scn-wh">Final standings in this scenario</h3>
          <div class="scn-table" role="table" aria-label="Standings in this scenario">
            <div class="scn-row head" role="row"><span role="columnheader" title="Seed">#</span><span role="columnheader">Team</span><span role="columnheader">Record</span><span role="columnheader" title="Projected final points for, the tiebreaker">Points</span><span role="columnheader" title="Change from the standings now">Now</span></div>
            ${rows.map((r, i) => `<div class="scn-row ${r.status}${cut(r, i)}${isMine(r.t) ? " mine" : ""}" role="row"><span role="cell" class="scn-seed">${r.seed}</span><span role="cell" class="scn-team">${logo(r.t)}<span><span class="tname">${esc(r.t.name)}</span><span class="scn-st ${r.status}">${STAT[r.status]}${r.onPts ? " · on points" : ""}</span></span></span><span role="cell">${r.w}–${r.l}${r.tie ? "–" + r.tie : ""}</span><span role="cell">${r.pts.toFixed(0)}</span><span role="cell">${moved(r)}</span></div>`).join("")}
          </div>
          ${firstRound.length ? `<p class="scn-fr"><span class="yb-label">First round</span>${firstRound.join("<br>")}${byes ? `<br><span class="muted">Byes: ${rows.slice(0, byes).map(r => esc(r.t.name)).join(", ")}</span>` : ""}</p>` : ""}
          <details class="scn-adjs"${Object.values(SCN.adj).some(Boolean) ? " open" : ""}><summary>Adjust projected points (tiebreaker)</summary><p class="muted">Add or take away points from a team's projected final total, to see how a tie on wins would go.</p><div class="scn-adj-grid">${adjRows}</div></details>
        </div>
      </div>`;
  }
  function scnUpdate() {
    const box = document.getElementById("scn");
    if (!box) return;
    const games = scnGames(), p = scnParams(games);
    state.params = new URLSearchParams(Object.assign(state.season !== IDX.current ? { season: state.season } : {}, p));
    SCN.src = (p.s || "") + "|" + (p.adj || "");
    history.replaceState(null, "", href("playoffs", p, "scenarios"));
    box.innerHTML = scnBody();
  }
  document.addEventListener("click", async e => {
    const b = e.target.closest("[data-scn]");
    if (!b || !document.getElementById("scn")) return;
    const games = scnGames(), v = b.dataset.scn;
    if (v === "fav") SCN.picks = scnFav(games);
    else if (v === "winout" || v === "loseout") games.forEach((g, i) => {
      if (g.locked != null) return;
      const mine = isMine(teamById[g.h]) ? 0 : isMine(teamById[g.a]) ? 1 : null;
      if (mine != null) SCN.picks[i] = v === "winout" ? mine : 1 - mine;
    });
    else if (v === "share") {
      const url = location.origin + location.pathname + href("playoffs", scnParams(games), "scenarios");
      try {
        if (navigator.share && matchMedia("(pointer: coarse)").matches) await navigator.share({ title: `${IDX.name}: my playoff scenario`, url });
        else { await navigator.clipboard.writeText(url); b.textContent = "Link copied"; setTimeout(() => { b.textContent = "Share this scenario"; }, 2000); }
      } catch { prompt("Copy this link:", url); }
      return;
    } else {
      const [i, side] = v.split(":").map(Number);
      if (games[i] && games[i].locked == null) SCN.picks[i] = side;
    }
    SCN.note = "";
    scnUpdate();
  });
  document.addEventListener("change", e => {
    if (!e.target.matches("[data-scn-adj]")) return;
    const v = Number(e.target.value);
    SCN.adj[e.target.dataset.scnAdj] = isFinite(v) ? v : 0;
    const open = e.target.closest("details");
    scnUpdate();
    const d = document.querySelector(".scn-adjs"); if (open && d) d.open = true;
  });

  const INSIGHTS = {
    build() {
      return section("Scenario builder", { short: "Pick the winner of every game left and see where everyone finishes.",
        full: "Start from the favorites (ESPN's live win odds this week, the playoff odds' scoring model after that) and tap a team to make it the winner. Teams level on wins are ordered by total points: each team's projected final points, which you can adjust at the bottom. Games already decided this week are locked. Share sends a link that opens on the same picks." },
        `<div class="scn" id="scn">${scnBody()}</div>`);
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
      const toggle = `<nav class="pg-by rl-by" aria-label="Rules to compare">${vers.map(v => `<a href="${href("insights", { rule: v.key, at: "rules" }, "whatif")}" class="${v.key === key ? "active" : ""}"${v.key === key ? ' aria-current="true"' : ""}>${esc(v.name)}</a>`).join("")}</nav>`;
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
      if (!L.over) return `<div class="empty">Playoff odds appear during the regular season. The bracket is set; follow it under Bracket.</div>`;
      const rows = D.teams.slice().sort((a, b) => (a.finalRank || 99) - (b.finalRank || 99));
      return section("Final results", `How the ${L.season} season ended.`, table([
        { label: "Finish", num: 1, cell: t => `<b class="${t.finalRank === 1 ? "champ" : ""}">${finishText(t.finalRank)}</b>` },
        { label: "Team", cell: teamCell },
        { label: "Record", num: 1, cell: t => record(t) },
        { label: "Seed", num: 1, cell: t => (t.seed && t.seed <= L.playoffTeams ? "#" + t.seed : "—") },
        { label: "Points for", num: 1, cell: t => fmt(t.pf) },
      ], rows));
    },

    seeds() {
      const rows = D.teams.filter(t => t.odds && t.odds.seeds).sort((a, b) => a.odds.avgSeed - b.odds.avgSeed);
      const n = rows[0].odds.seeds.length, po = L.playoffTeams || 0, byes = Math.max(0, 2 ** (L.playoffRounds || 1) - po);
      const cell = (t, i) => {
        const v = t.odds.seeds[i] || 0;
        const a = v <= 0 ? 0 : Math.round(12 + 78 * Math.min(1, v / 60)); // shade: 12-90% of the accent, full at 60%+
        return `<td class="sg-c${a > 55 ? " dark" : ""}" style="${a ? `background:color-mix(in srgb, var(--accent) ${a}%, transparent)` : ""}" title="${esc(t.name)}: ${v.toFixed(1)}% to be the ${i + 1} seed">${v >= 0.5 ? Math.round(v) : v > 0 ? "<1" : ""}</td>${cut(i, "td")}`;
      };
      // thin divider columns after the bye cut and the playoff cut
      const cut = (i, tag) => i + 1 === po ? `<${tag} class="sg-cut po" aria-hidden="true"></${tag}>` : i + 1 === byes ? `<${tag} class="sg-cut" aria-hidden="true"></${tag}>` : "";
      const head = Array.from({ length: n }, (_, i) => `<th class="sg-h">${i + 1}</th>${cut(i, "th")}`).join("");
      return section("Seed odds", { short: `Each team's chance of finishing at every seed (%).${po ? ` Seeds 1–${po} make the playoffs.` : ""}`,
        full: `From the same 10,000 simulated finishes as the playoff odds: how often each team ended the regular season at each seed, as a percentage (blank = never, <1 = under 1%). Darker cells are likelier.${byes ? ` The line after seed ${byes} is the first-round bye cut;` : ""}${po ? ` the line after seed ${po} is the playoff cut.` : ""} Teams are ordered by their average seed.` },
        `<div class="sg-wrap"><table class="sg"><thead><tr><th class="sg-t">Team</th>${head}<th class="sg-avg">Avg</th></tr></thead><tbody>${rows.map(t =>
          `<tr class="${isMine(t) ? "mine" : ""}"><th class="sg-t" scope="row">${logo(t)}<span>${esc(t.name)}</span></th>${t.odds.seeds.map((_, i) => cell(t, i)).join("")}<td class="sg-avg">${t.odds.avgSeed.toFixed(1)}</td></tr>`).join("")}</tbody></table></div>`);
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

    upsets() {
      const M = upsetModel();
      const rows = D.teams.map(t => ({ t, ...M.teams[t.id] })).filter(r => r.games)
        .sort((a, b) => (b.dogW - b.favL) - (a.dogW - a.favL) || b.dogW - a.dogW);
      const wl = (w, l) => `${w}–${l}`;
      const gap = (x, verb, side) => x ? `<a href="${href("matchups", { week: x.week, game: x.game })}">${verb} ${esc(teamById[x.opp].name)}</a> <span class="muted">projected ${x.gap.toFixed(1)} ${side} · wk ${x.week}</span>` : "—";
      const favPct = M.games ? Math.round(100 * M.favWins / M.games) : 0;
      return section("Upset tracker", { short: `Records as ESPN's pre-game favorite and underdog. Favorites have won ${M.favWins} of ${M.games} (${favPct}%).`,
        full: "Before each game, the team whose starting lineup ESPN projected for more points is the favorite and the other is the underdog. <b>As underdog</b> and <b>As favorite</b> are each team's records in those games. <b>Net</b> is upset wins minus upset losses: high means the team keeps beating expectations, low means it keeps losing games it was supposed to win. <b>Biggest upset</b> is the win where it was projected furthest behind; <b>Worst loss</b> is the loss where it was projected furthest ahead. Games with equal projections and ties are left out. Regular season." }, table([
        { label: "Team", cell: r => teamCell(r.t) },
        { label: "As underdog", num: 1, cell: r => wl(r.dogW, r.dogL) },
        { label: "As favorite", num: 1, cell: r => wl(r.favW, r.favL) },
        { label: "Net", num: 1, cell: r => signedPts(r.dogW - r.favL, true).replace(/\.0(?=<)/, "") },
        { label: "Biggest upset", cell: r => gap(r.bestUpset, "Beat", "behind") },
        { label: "Worst loss", cell: r => gap(r.worstLoss, "Lost to", "ahead") },
      ], rows));
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
      return section("Vs. projection", { short: "Points scored vs. what ESPN projected for the lineup each week.", full: "Each week, the points a team's starters actually scored compared with ESPN's pre-game projection for that same lineup. Positive means its players beat their projections; it's about how the players performed, not lineup choices (that's Efficiency) or opponents (that's Luck). <b>Starters who beat it</b> is the share of the team's individual starts where that player outscored his own projection: a high difference with a low share means one or two huge games carried it; a high share means the whole lineup has been beating expectations. Regular season." }, table([
        { label: "Team", cell: teamCell },
        { label: "Projected", num: 1, cell: t => t.vsProj.proj.toFixed(1) },
        { label: "Actual", num: 1, cell: t => t.vsProj.actual.toFixed(1) },
        { label: "Difference", num: 1, cell: t => signedPts(t.vsProj.diff, true) },
        { label: "Per week", num: 1, cell: t => signedPts(t.vsProj.perWeek, true) },
        { label: "Beat it", num: 1, cell: t => `${t.vsProj.beat} of ${t.vsProj.weeks} wks` },
        ...(rows.some(t => t.vsProj.starters) ? [{ label: "Starters who beat it", num: 1, cell: t => {
          const s = t.vsProj.starters;
          return s ? `<span title="${s[0]} of ${s[1]} starts">${Math.round(100 * s[0] / s[1])}%</span>` : "—";
        } }] : []),
        { label: "Best week", num: 1, cell: t => t.vsProj.best ? `${signed(t.vsProj.best[1])} <span class="muted">wk ${t.vsProj.best[0]}</span>` : "—" },
        { label: "Worst week", num: 1, cell: t => t.vsProj.worst ? `${signed(t.vsProj.worst[1])} <span class="muted">wk ${t.vsProj.worst[0]}</span>` : "—" },
      ], rows));
    },

    usage() {
      const U = D.nfl.teams;
      const rows = D.teams.filter(t => U[t.id]).sort((a, b) => U[b.id].diff - U[a.id].diff);
      const u = t => U[t.id];
      const top = rows[0], bot = rows[rows.length - 1];
      const lede = top && bot ? `<p class="note"><b>${esc(top.name)}</b>'s starters have scored ${signed(u(top).diff)} more than their usage was worth; <b>${esc(bot.name)}</b>'s ${signed(u(bot).diff)}.</p>` : "";
      return section("Vs. usage", { short: "Points your starters scored vs. what their usage was worth.", full: `For every regular-season week, each starter's fantasy points compared with his <b>expected points</b>: what a player with his exact usage (targets, carries, air yards, where on the field) scores on average, from nflverse's ffopportunity model. A team well above it has been getting extra touchdowns and big plays from the same work, which tends not to last; well below means the work is there and the points should follow. Unlike Vs. projection, this ignores ESPN's pre-game guess and looks at what actually happened on the field. Both numbers use the model's standard PPR scoring, not this league's, and leave out kickers and defenses. <b>TDs</b> are touchdowns scored vs. expected from the same usage.` }, lede + table([
        { label: "Team", cell: teamCell },
        { label: "Points", num: 1, cell: t => u(t).fp.toFixed(1) },
        { label: "Usage worth", num: 1, cell: t => u(t).xfp.toFixed(1) },
        { label: "Difference", num: 1, cell: t => signedPts(u(t).diff, true) },
        { label: "Per start", num: 1, cell: t => signedPts(u(t).diff / Math.max(1, u(t).games), true) },
        { label: "TDs vs. expected", num: 1, cell: t => `${u(t).td.toFixed(0)} <span class="muted">vs ${u(t).tdx.toFixed(1)}</span>` },
        { label: "Most above", cell: t => u(t).over ? `${esc(u(t).over[0])} <span class="muted">${signed(u(t).over[1])}</span>` : "—" },
        { label: "Most below", cell: t => u(t).under ? `${esc(u(t).under[0])} <span class="muted">${signed(u(t).under[1])}</span>` : "—" },
      ], rows)) + `<p class="note">On My team, Waiver targets and the Trade block, <span class="uchip due">▲ Due</span> marks a player scoring 3+ points a game below his usage over his last 5 games (likely to bounce back), <span class="uchip hot">▼ Hot</span> one scoring 3+ above it (likely to cool off).</p>`;
    },

    injury() {
      const rows = D.teams.filter(t => t.injuries).sort((a, b) => b.injuries.lost - a.injuries.lost);
      const avg = rows.reduce((n, t) => n + t.injuries.lost, 0) / Math.max(1, rows.length);
      const top = rows[0];
      const lede = top && top.injuries.lost > 0 ? `<p class="note">${esc(top.name)} lost the most: <b>${top.injuries.lost.toFixed(1)} points</b> over ${top.injuries.missed} missed game${top.injuries.missed === 1 ? "" : "s"} (league average ${avg.toFixed(1)}).</p>` : "";
      const hurt = t => t.injuries.players.length ? t.injuries.players.slice(0, 3).map(p => `<span class="nw">${esc(p.name)} <span class="muted">${p.missed} g · ${p.lost.toFixed(1)}</span></span>`).join("<br>") : '<span class="muted">None</span>';
      return section("Injury toll", { short: "Points each team lost to its starters missing games.", full: `Every regular-season week a player missed while he was on the team: his NFL team played, but he didn't record a single stat (almost always an injury). Only players who were starting for that team count (in its starting lineup in at least half the games he played for it). Each missed game is valued at what he averaged in the games he'd played before it this season, or his healthy average if he got hurt before playing. It's what the player usually scored, before counting whoever replaced him. <b>Luck</b> is wins minus expected wins, so you can see who's been unlucky both ways.` }, lede + table([
        { label: "Team", cell: teamCell },
        { label: "Points lost", num: 1, cell: t => `<b>${t.injuries.lost.toFixed(1)}</b>` },
        { label: "Games missed", num: 1, cell: t => t.injuries.missed },
        { label: "Per week", num: 1, cell: t => (t.injuries.lost / Math.max(1, (D.weeks.filter(w => w.final && !w.playoffs).length))).toFixed(1) },
        { label: "Costliest injuries", wide: 1, cell: hurt },
        ...(rows.some(t => t.luck != null) ? [{ label: "Luck", num: 1, cell: t => t.luck != null ? signedPts(t.luck, true) : "—" }] : []),
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
          `<div class="sg-wrap swap-wrap"><table class="swap-grid"><thead>${head}</thead><tbody>${body}</tbody></table></div>${picker}`);
    },

    efficiency() {
      const rows = D.teams.filter(t => t.efficiency != null).sort((a, b) => b.efficiency - a.efficiency);
      return section("Manager efficiency", { short: "Points started vs. the best possible lineup.", full: "Points started as a share of the best possible lineup each week, in hindsight. Regular season." }, table([
        { label: "Team", cell: teamCell },
        { label: "Efficiency", num: 1, cell: t => `<span class="pbar"><span class="pbar-track"><span class="pbar-fill eff" style="width:${Math.max(0, Math.min(100, (t.efficiency - 70) / 30 * 100))}%"></span></span><span class="pbar-v">${t.efficiency.toFixed(1)}%</span></span>` },
        { label: "Bench pts left", num: 1, cell: t => Number(t.benchLeft).toFixed(1) },
        { label: "Points for", num: 1, cell: t => fmt(t.pf) },
      ], rows));
    },

    autopilot() { return autopilotSection(); },

    butterfly() {
      setTimeout(bfxHydrate, 0); // after the page is in place (not rAF: it pauses in background tabs)
      return section("Butterfly effect", { short: "Take away any one move and replay the season without it.", full: "Pick any waiver claim, free-agent pickup, drop or trade, and the regular season is replayed as if it never happened. Players the move brought in come out of every lineup they started for that team, and the open spot goes to whoever on the bench ESPN projected highest that week. Players it sent away come back with the points they really scored elsewhere, and start if ESPN projected them above the weakest starter they could replace. A player dropped and then picked up by another league team leaves that team too. Projections only, never hindsight, so it's the lineup the manager would have set. Someone who wasn't on any league roster can't be scored, so a player dropped to free agency doesn't come back. Finished regular-season weeks; standings by record, then points for." },
        '<div id="bfx" class="bfx"><div class="empty">Loading every move of the season…</div></div>');
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
    const extra = Object.fromEntries([...state.params].filter(([k]) => k !== "season"));
    if (state.sub === "trades") { location.replace(href("trades")); return; } // trade grades moved to the Trades tab
    if (state.sub === "players") { location.replace(href("history", extra, "players")); return; } // player history moved to History
    // the playoff race (odds, seed odds, scenario builder) moved to the Playoffs tab; Hot & cold stayed here
    const at = state.sub === "race" ? state.params.get("at") || "odds" : state.sub;
    if (["race", "seeds", "build"].includes(state.sub)) {
      if (at === "form") { location.replace(href("insights", {}, "form")); return; }
      delete extra.at;
      location.replace(href("playoffs", extra, at === "build" ? "scenarios" : at === "seeds" ? "seeds" : "odds"));
      return;
    }
    if (INSIGHT_ALIAS[state.sub]) { // an old single-view link: open its page at that section
      const to = Object.assign(extra, state.sub === "redraft" ? { view: "redraft" } : { at: state.sub });
      location.replace(href("insights", to, INSIGHT_ALIAS[state.sub]));
      return;
    }
    const tabs = insightTabs();
    const sub = tabs.some(([k]) => k === state.sub) ? state.sub : tabs[0][0];
    const keys = INSIGHT_GROUPS.find(([k]) => k === sub)[2].filter(insightHas);
    let body;
    if (sub === "draft" && insightHas("redraft")) {
      // the real draft's grades or the hindsight redraft, one at a time
      const view = state.params.get("view") === "redraft" ? "redraft" : "draft";
      const sw = `<nav class="pg-by ins-switch" aria-label="Draft view">${[["draft", "Draft grades"], ["redraft", "Hindsight redraft"]].map(([k, label]) =>
        `<a href="${href("insights", k === "redraft" ? { view: k } : {}, "draft")}" class="${k === view ? "active" : ""}"${k === view ? ' aria-current="true"' : ""}>${label}</a>`).join("")}</nav>`;
      body = sw + INSIGHTS[view]();
    } else if (keys.length > 1) {
      // one part at a time, with a switch at the top (?at= picks the part, so old links and glossary links still work)
      const at = keys.includes(state.params.get("at")) ? state.params.get("at") : keys[0];
      const sw = `<nav class="pg-by ins-switch" aria-label="${esc(INSIGHT_GROUPS.find(([k]) => k === sub)[1])} views">${keys.map(k =>
        `<a href="${href("insights", k === keys[0] ? {} : { at: k }, sub)}" class="${k === at ? "active" : ""}"${k === at ? ' aria-current="true"' : ""}>${insightPartLabel(k)}</a>`).join("")}</nav>`;
      body = sw + `<div class="ins-part" id="ins-${at}">${INSIGHTS[at]()}</div>`;
    } else {
      body = keys.map(k => `<div class="ins-part" id="ins-${k}">${INSIGHTS[k]()}</div>`).join("");
    }
    main.innerHTML = `<div class="section-head"><div><h1>Insights</h1><p class="sub">${L.over ? L.season + " season in review." : "Who's in, who's lucky, who's setting good lineups, and who drafted well."}</p></div></div>
      ${subnav("insights", tabs, sub)}${body}`;
    const a = main.querySelector(".subnav .active");
    if (a) a.scrollIntoView({ block: "nearest", inline: "center" });
    const b = main.querySelector(".ins-switch .active");
    if (b) b.scrollIntoView({ block: "nearest", inline: "center" });
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- trade impact (Trades → Trade impact)
  // Pick two teams and the players each would send; see what the trade does to both teams' projected lineups and to
  // their playoff, bye and title odds (and anyone else's that moves). Each team's best lineup (QB, RB, WR, TE and FLEX
  // from the build's expected points per week, byes and injuries included) is worked out with and without the trade,
  // and half of the weekly change is added to that team's scoring model (the playoff odds pull every team's strength
  // halfway to the league average). The rest of the regular season and the bracket are then simulated here, both
  // ways, with the same random draws, so the difference is the trade's and not luck. The picks live in the link.
  const TI_POS = ["QB", "RB", "WR", "TE"], TI_SIMS = 10000, TI_SHRINK = 0.5;
  function tiSlots() {
    const n = k => ((((D.settings || {}).slots || []).find(s => s.slot === k)) || { count: 0 }).count;
    return { QB: n("QB"), RB: n("RB"), WR: n("WR"), TE: n("TE"), FLEX: n("FLEX") };
  }
  const tiCur = () => D.weeks.find(w => w.week === L.currentWeek && !w.final);
  const tiStarted = () => { const c = tiCur(); return !!(c && c.games.some(g => g.sides.some(s => s.pts > 0))); };
  // the weeks a trade made now would count for: from the first week nobody has played yet through the final
  function tiWeeks() {
    const out = [];
    for (let w = tiStarted() ? L.currentWeek + 1 : L.currentWeek; w <= L.finalWeek; w++) out.push(w);
    return out;
  }
  const tiPts = (p, w) => (p.wk && p.wk[w]) || 0;
  function tiLineup(players, w, S) {
    const left = players.filter(p => TI_POS.includes(p.pos) && tiPts(p, w) > 0).sort((a, b) => tiPts(b, w) - tiPts(a, w));
    const used = new Set();
    TI_POS.forEach(pos => left.filter(p => p.pos === pos).slice(0, S[pos]).forEach(p => used.add(p.id)));
    left.filter(p => !used.has(p.id) && p.pos !== "QB").slice(0, S.FLEX).forEach(p => used.add(p.id));
    const starters = left.filter(p => used.has(p.id));
    // positions this lineup can't fill (the FLEX can't stand in for a missing QB, RB, WR or TE spot)
    const short = TI_POS.filter(pos => starters.filter(p => p.pos === pos).length < S[pos] && left.filter(p => p.pos === pos).length < S[pos]);
    return { pts: starters.reduce((n, p) => n + tiPts(p, w), 0), ids: used, short };
  }
  // each side's lineup with and without the trade: change per week, weekly averages, and who moves in and out of
  // the first week's lineup
  function tiEffect(T) {
    const S = tiSlots(), weeks = tiWeeks(), A = teamById[T.a], B = teamById[T.b];
    const after = {
      [T.a]: A.roster.filter(p => !T.ga.includes(p.id)).concat(B.roster.filter(p => T.gb.includes(p.id))),
      [T.b]: B.roster.filter(p => !T.gb.includes(p.id)).concat(A.roster.filter(p => T.ga.includes(p.id))),
    };
    const out = {};
    [A, B].forEach(t => {
      const per = {};
      let s0 = 0, s1 = 0;
      weeks.forEach(w => { const x = tiLineup(t.roster, w, S).pts, y = tiLineup(after[t.id], w, S).pts; per[w] = y - x; s0 += x; s1 += y; });
      const w0 = weeks[0], X = tiLineup(t.roster, w0, S), Y = tiLineup(after[t.id], w0, S), x0 = X.ids, y0 = Y.ids;
      const byId = Object.fromEntries(t.roster.concat(after[t.id]).map(p => [p.id, p]));
      out[t.id] = { per, avg0: weeks.length ? s0 / weeks.length : 0, avg1: weeks.length ? s1 / weeks.length : 0, week: w0,
        into: [...y0].filter(x => !x0.has(x)).map(x => byId[x]), out: [...x0].filter(x => !y0.has(x)).map(x => byId[x]),
        holes: Y.short.filter(pos => !X.short.includes(pos)) };
    });
    return out;
  }
  // playoff, bye and title odds from TI_SIMS runs of the rest of the season and the bracket; delta = team id ->
  // {week: points added to that team's weekly mean}. A fixed seed and the same number of draws in every run, so two
  // calls differ only by the deltas.
  function tiSim(delta) {
    let s = 20261124;
    const rnd = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
    const teams = D.teams, po = L.playoffTeams, byes = Math.max(0, 2 ** L.playoffRounds - po), roundWeeks = (D.settings || {}).playoffRoundWeeks || 1;
    const M = Object.fromEntries(teams.map(t => [t.id, t.odds.wk]));
    const score = (id, w) => M[id][0] + ((delta[id] || {})[w] || 0) + M[id][1] * gauss();
    const cur = tiCur(), live = tiStarted(), proj = {};
    if (cur) cur.games.forEach(g => g.sides.forEach(sd => { proj[sd.team] = sd.proj != null ? sd.proj : sd.pts; }));
    const games = scnGames();
    const tally = Object.fromEntries(teams.map(t => [t.id, [0, 0, 0]]));
    for (let n = 0; n < TI_SIMS; n++) {
      const wins = {}, pf = {};
      teams.forEach(t => { wins[t.id] = t.wins + (t.ties || 0) / 2; pf[t.id] = t.pf; });
      for (const g of games) {
        let sh, sa, home;
        if (live && cur && g.week === cur.week) { // this week's games are under way: ESPN's live odds decide them
          const r = rnd();
          sh = proj[g.h] || 0; sa = proj[g.a] || 0;
          home = g.locked != null ? g.locked === 0 : r < g.pH;
        } else { sh = score(g.h, g.week); sa = score(g.a, g.week); home = sh >= sa; }
        pf[g.h] += sh; pf[g.a] += sa; wins[home ? g.h : g.a]++;
      }
      const field = teams.map(t => t.id).sort((x, y) => wins[y] - wins[x] || pf[y] - pf[x]).slice(0, po);
      field.forEach((id, i) => { tally[id][0]++; if (i < byes) tally[id][1]++; });
      const seed = Object.fromEntries(field.map((id, i) => [id, i]));
      let alive = field.slice(byes), waiting = field.slice(0, byes), w = L.regularSeasonWeeks + 1;
      while (alive.length + waiting.length > 1) { // reseeded each round: the best seed left plays the worst
        alive.sort((x, y) => seed[x] - seed[y]);
        const next = [];
        for (let i = 0; i < Math.floor(alive.length / 2); i++) {
          const x = alive[i], y = alive[alive.length - 1 - i], sx = score(x, w), sy = score(y, w);
          next.push(sx >= sy ? x : y);
        }
        if (alive.length % 2) next.push(alive[Math.floor(alive.length / 2)]);
        alive = next.concat(waiting).sort((x, y) => seed[x] - seed[y]);
        waiting = [];
        w += roundWeeks;
      }
      if (alive[0] != null) tally[alive[0]][2]++;
    }
    return Object.fromEntries(Object.entries(tally).map(([id, v]) => [id, v.map(x => 100 * x / TI_SIMS)]));
  }
  // the trade in the link: ?a=team&ga=players&b=team&gb=players (only QBs, RBs, WRs and TEs count)
  function tiState() {
    const P = state.params, ids = D.teams.map(t => t.id);
    const mine = (D.teams.find(isMine) || {}).id;
    let a = Number(P.get("a")), b = Number(P.get("b"));
    if (!ids.includes(b)) b = null;
    if (!ids.includes(a) || a === b) a = mine != null && mine !== b ? mine : ids.find(x => x !== b);
    if (b == null || b === a) b = ids.find(x => x !== a);
    const list = (k, t) => (P.get(k) || "").split(",").map(Number).filter(id => teamById[t].roster.some(p => p.id === id && TI_POS.includes(p.pos)));
    return { a, b, ga: list("ga", a), gb: list("gb", b) };
  }
  function tiParams(T) {
    const p = { a: T.a, b: T.b };
    if (T.ga.length) p.ga = T.ga.join(",");
    if (T.gb.length) p.gb = T.gb.join(",");
    return p;
  }
  // a link that opens this page on a trade (Compare players, Trade block)
  const tiHref = (a, ga, b, gb) => href("trades", tiParams({ a, b, ga: ga || [], gb: gb || [] }), "impact");
  function renderTradeImpact() {
    const head = `<div class="section-head"><div><h1>Trade impact</h1>${expl("What a trade does to both teams' lineups and playoff odds.",
      "Pick two teams and the players each would send. Each team's best weekly lineup (QB, RB, WR, TE and FLEX, from the same expected points per week as power value, byes and injuries included) is worked out with and without the trade for every week left, playoffs included. Half of each week's change goes into the team's weekly scoring model, because the playoff odds pull every team's strength halfway toward the league average. Then the rest of the regular season and the bracket are simulated 10,000 times both ways with the same random draws, so the difference is the trade's, not luck. \"Before\" comes from this same simulation, so it can differ from Playoffs → Odds by a point or so. Kickers and defenses aren't counted (they're left out of power value too), and a team getting more players than it sends would have to drop someone, which isn't counted either.", "tradeimpact")}</div></div>${subnav("trades", TRADE_TABS, "impact")}`;
    if (!L.isCurrent || L.over || !D.teams.every(t => t.odds && t.odds.wk) || !tiWeeks().length) {
      main.innerHTML = head + `<div class="empty">Trade impact works during the regular season, while there are playoff odds to move.${L.isCurrent ? "" : ` <a href="#/trades/impact">Go to ${IDX.current}</a>`}</div>`;
      return;
    }
    const T = tiState(), A = teamById[T.a], B = teamById[T.b], weeks = tiWeeks();
    const S = D.settings || {};
    const dl = S.tradeDeadline ? new Date(S.tradeDeadline) : null;
    const deadline = !dl ? "" : Date.now() > dl.getTime() ? `<p class="note">The trade deadline passed on ${esc(dl.toLocaleDateString([], { month: "short", day: "numeric" }))}, so this is a what-if now.</p>`
      : `<p class="note">Trade deadline: ${esc(dl.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}.</p>`;
    const avg = p => { const v = weeks.map(w => tiPts(p, w)); return v.length ? v.reduce((n, x) => n + x, 0) / v.length : 0; };
    const POS_ORDER = { QB: 0, RB: 1, WR: 2, TE: 3 };
    const side = (t, key, give) => {
      const rows = t.roster.filter(p => TI_POS.includes(p.pos)).sort((x, y) => POS_ORDER[x.pos] - POS_ORDER[y.pos] || avg(y) - avg(x));
      const sending = rows.filter(p => give.includes(p.id));
      return `<section class="ti-side"><label class="field">${key === "a" ? "Team 1" : "Team 2"} <select data-ti-team="${key}">${D.teams.map(o =>
        `<option value="${o.id}"${o.id === t.id ? " selected" : ""}${o.id === (key === "a" ? T.b : T.a) ? " disabled" : ""}>${esc(o.name)}</option>`).join("")}</select></label>
        <p class="ti-sends"><span class="kicker">Sends</span> ${sending.length ? sending.map(p => `<b>${esc(p.name)}</b>`).join(", ") : '<span class="muted">tap players below</span>'}</p>
        <div class="ti-list">${rows.map(p => { const on = give.includes(p.id);
          return `<button type="button" class="ti-p${on ? " on" : ""}" data-ti-p="${key}:${p.id}" aria-pressed="${on}"><span class="slot ${esc(p.pos)}">${esc(p.pos)}</span><span class="ti-n"><b>${esc(p.name)}</b><span class="team-mgr">${esc(p.team || "FA")}${p.injury ? " · " + esc(String(p.injury).replace(/_/g, " ").toLowerCase()) : ""}${p.slot === "IR" ? " · IR" : ""}</span></span><span class="ti-v">${avg(p).toFixed(1)}<span class="muted">/wk</span></span></button>`;
        }).join("")}</div></section>`;
    };
    let result = '<div class="panel ti-empty">Tap the players each team would send. The lineups and odds update as you go.</div>', sticky = "";
    if (T.ga.length || T.gb.length) {
      const E = tiEffect(T);
      const delta = Object.fromEntries(Object.entries(E).map(([id, e]) => [id, Object.fromEntries(Object.entries(e.per).map(([w, v]) => [w, TI_SHRINK * v]))]));
      const before = tiSim({}), after = tiSim(delta);
      const p1 = v => v >= 99.95 ? ">99.9%" : v > 0 && v < 0.05 ? "<0.1%" : v.toFixed(1) + "%";
      const chg = (x, y) => { const d = y - x; return Math.abs(d) < 0.05 ? '<span class="muted">no change</span>' : `<b class="${d > 0 ? "pos" : "neg"}">${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}</b>`; };
      const oddsRow = (label, id, k) => `<tr><th>${label}</th><td>${p1(before[id][k])}</td><td>${p1(after[id][k])}</td><td>${chg(before[id][k], after[id][k])}</td></tr>`;
      const names = list => list.map(p => esc(p.name)).join(", ");
      const card = t => {
        const e = E[t.id];
        const moves = [e.into.length ? `in: ${names(e.into)}` : "", e.out.length ? `out: ${names(e.out)}` : ""].filter(Boolean).join(" · ");
        return `<article class="ti-card${isMine(t) ? " mine" : ""}"><div class="ti-head">${logo(t)}<b>${esc(t.name)}</b></div>
          <p class="ti-line">Best lineup: <b>${e.avg0.toFixed(1)} → ${e.avg1.toFixed(1)}</b> projected points a week ${chg(e.avg0, e.avg1)}</p>
          <p class="team-mgr">Week ${e.week} lineup ${moves ? moves : "doesn't change"}</p>
          ${e.holes.length ? `<p class="ti-warn">Leaves no ${e.holes.join(" or ")} to start in week ${e.week}: they'd need a pickup.</p>` : ""}
          <table class="ti-odds"><thead><tr><th></th><th>Before</th><th>After</th><th>Change</th></tr></thead><tbody>
          ${oddsRow("Playoffs", t.id, 0)}${L.playoffTeams < 2 ** L.playoffRounds ? oddsRow("Bye", t.id, 1) : ""}${oddsRow("Title", t.id, 2)}</tbody></table></article>`;
      };
      const others = D.teams.filter(t => t.id !== T.a && t.id !== T.b && Math.abs(after[t.id][0] - before[t.id][0]) >= 1)
        .sort((x, y) => Math.abs(after[y.id][0] - before[y.id][0]) - Math.abs(after[x.id][0] - before[x.id][0])).slice(0, 4);
      const ripple = others.length ? `<p class="ti-ripple"><span class="kicker">Also moves</span> ${others.map(t => `${esc(t.name)}'s playoff odds ${p1(before[t.id][0])} → ${p1(after[t.id][0])}`).join(" · ")}</p>` : "";
      const short = t => { const x = before[t.id][0], y = after[t.id][0]; return `${esc(t.name)} ${p1(x)} → ${p1(y)}`; };
      sticky = `<div class="ti-sticky"><span class="kicker">Playoff odds</span> ${short(A)} · ${short(B)}</div>`;
      result = `<div class="ti-cards">${card(A)}${card(B)}</div>${ripple}`;
    }
    main.innerHTML = head + deadline + result + `<div class="ti-pick">${sticky}<div class="ti-sides">${side(A, "a", T.ga)}${side(B, "b", T.gb)}</div></div>`;
  }
  function tiGo(T) {
    const p = tiParams(T);
    state.params = new URLSearchParams(p);
    history.replaceState(null, "", href("trades", p, "impact"));
    renderKeepScroll(renderTradeImpact);
  }
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-ti-p]");
    if (!b || state.tab !== "trades" || state.sub !== "impact") return;
    const [k, id] = b.dataset.tiP.split(":"), T = tiState(), list = k === "a" ? T.ga : T.gb, pid = Number(id);
    const next = list.includes(pid) ? list.filter(x => x !== pid) : list.concat(pid);
    if (k === "a") T.ga = next; else T.gb = next;
    tiGo(T);
  });
  document.addEventListener("change", e => {
    const s = e.target.closest("[data-ti-team]");
    if (!s || state.tab !== "trades" || state.sub !== "impact") return;
    const T = tiState();
    if (s.dataset.tiTeam === "a") { T.a = Number(s.value); T.ga = []; } else { T.b = Number(s.value); T.gb = []; }
    tiGo(T);
  });

  // ---------------------------------------------------------------- playoffs
  // Everything about who makes it and who wins it: the playoff picture (clinch / eliminate scenarios) and tiebreaker
  // race, playoff and title odds, seed odds, the scenario builder, and the bracket. Opens on the picture during the
  // regular season and on the bracket once the playoffs start (or for a finished season).
  function playoffTabs() {
    const hasOdds = D.teams.some(t => t.odds);
    return [
      ["picture", "Picture", !!(clinchSection() || tieRaceSection())],
      ["odds", hasOdds || !L.over ? "Odds" : "Final results", true],
      ["seeds", "Seed odds", insightHas("seeds")],
      ["scenarios", "Scenario builder", insightHas("build")],
      ["bracket", "Bracket", true],
    ].filter(x => x[2]).map(([k, label]) => [k, label]);
  }
  function playoffsHead(sub, text, extra) {
    const line = text != null ? text : L.over ? `How the ${L.season} playoffs played out.`
      : `Top ${L.playoffTeams} make it${L.playoffTeams < 2 ** L.playoffRounds ? `, top ${2 ** L.playoffRounds - L.playoffTeams} get a first-round bye` : ""}. Ties in the standings go to total points.`;
    return `<div class="section-head"><div><h1>Playoffs</h1><p class="sub">${line}</p></div>${extra || ""}</div>${subnav("playoffs", playoffTabs(), sub)}`;
  }
  function renderPlayoffs() {
    const tabs = playoffTabs();
    const started = bracketModel().started;
    const first = L.over || started ? "bracket" : tabs[0][0];
    const sub = tabs.some(([k]) => k === state.sub) ? state.sub : first;
    if (sub === "bracket") renderBracket();
    else {
      const body = sub === "picture" ? clinchSection() + tieRaceSection()
        : sub === "seeds" ? INSIGHTS.seeds() : sub === "scenarios" ? INSIGHTS.build() : INSIGHTS.race();
      main.innerHTML = playoffsHead(sub) + body;
    }
    const a = main.querySelector(".subnav .active");
    if (a) a.scrollIntoView({ block: "nearest", inline: "center" });
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- trades
  const TRADE_TABS = [["", "Trade history"], ["block", "Trade block"], ["compare", "Compare players"], ["impact", "Trade impact"]];

  function renderTrades() {
    if (state.sub === "block") return renderBlock();
    if (state.sub === "compare") return renderCompare();
    if (state.sub === "impact") return renderTradeImpact();
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
        <div class="trade-body">${sides.join(swap)}</div><div class="verdict">${verdict}</div>${talkRow("trades", "t:" + String(tr.id).replace(/[^\w.-]/g, "").slice(0, 40))}</article>`;
    }).join("");
    main.innerHTML = `<div class="section-head"><div><h1>Trade history <span class="pill">${D.trades.length} trades</span></h1>
        ${expl(`Every ${L.season} deal, graded by points scored in the new team's lineup.`, `Every deal that went through in ${L.season}, newest first, graded by points the received players scored in the new team's starting lineup for as long as they stayed. Bench points don't count: a trade only pays off if you play them.`)}</div></div>
      ${subnav("trades", TRADE_TABS, "")}
      <div class="trades">${body || '<div class="empty">No trades this season.</div>'}</div>`;
  }

  const TRADE_POS = ["QB", "RB", "WR", "TE"];

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
    // two players on different league teams this season: one tap to see what swapping them does to the odds
    const swap = cur && a.owner && b.owner && a.owner !== b.owner && TI_POS.includes(a.pos) && TI_POS.includes(b.pos) && D.teams.every(t => t.odds && t.odds.wk)
      ? `<p class="cmp-ti"><a class="wk-link" href="${tiHref(a.owner, [a.id], b.owner, [b.id])}">What would this trade do to both teams' playoff odds? ›</a></p>` : "";
    const box = main.querySelector(".cmp-body");
    if (box) box.innerHTML = swap + table + section("Week by week", "", chart);
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
    const chip = p => `<span class="tb-chip" title="${p.src === "espn" ? "Set on ESPN" : "Set here"}"><span class="slot ${esc(p.pos)}">${esc(p.pos)}</span>${esc(p.name)}${p.rosRank ? ` <span class="muted">${esc(p.pos)}${p.rosRank}</span>` : ""}${usageChips(p.id)}<span class="tb-src">${p.src === "espn" ? "ESPN" : "here"}</span></span>`;
    const fitLine = f => {
      const gives = (who, list) => list.length ? `<b>${esc(who.t.name)}</b> has ${list.map(p => esc(p.name) + " (" + esc(p.pos) + ")").join(", ")}` : "";
      const parts = [gives(f.A, f.aGives) && gives(f.A, f.aGives) + ` for ${esc(f.B.t.name)}`, gives(f.B, f.bGives) && gives(f.B, f.bGives) + ` for ${esc(f.A.t.name)}`].filter(Boolean);
      const odds = L.isCurrent && !L.over && D.teams.every(t => t.odds && t.odds.wk) && tiWeeks().length;
      const tryIt = odds ? ` <a class="wk-link" href="${tiHref(f.A.t.id, f.aGives.filter(p => TI_POS.includes(p.pos)).map(p => p.id), f.B.t.id, f.bGives.filter(p => TI_POS.includes(p.pos)).map(p => p.id))}">See the odds impact ›</a>` : "";
      return `<div class="tb-fit${f.two ? " two" : ""}"><span class="badge${f.two ? " new" : ""}">${f.two ? "Two-way fit" : "One-way fit"}</span> ${parts.join(" · ")}${tryIt}</div>`;
    };
    // their block players into Trade impact (against your team when you've claimed one), to start building an offer
    const tryBlock = (t, l) => {
      const blockIds = l.players.filter(p => TI_POS.includes(p.pos)).map(p => p.id);
      if (!blockIds.length || !L.isCurrent || L.over || !D.teams.every(x => x.odds && x.odds.wk) || !tiWeeks().length) return "";
      const mine = D.teams.find(isMine), p = { b: t.id, gb: blockIds.join(",") };
      if (mine && mine.id !== t.id) p.a = mine.id;
      return `<p class="tb-try"><a class="wk-link" href="${href("trades", p, "impact")}">See what their block does to the odds ›</a></p>`;
    };
    const card = t => {
      const l = L2[t.id];
      if (!l) return `<article class="tb-card empty-card">${logo(t)}<div><b>${esc(t.name)}</b><div class="team-mgr">${esc(t.manager)} · no listing yet</div></div></article>`;
      const when = l.at ? " · note updated " + ago(l.at) : "";
      return `<article class="tb-card"><div class="tb-head">${logo(t)}<div style="min-width:0"><b>${esc(t.name)}</b><div class="team-mgr">${esc(t.manager)}${esc(when)}</div></div></div>
        ${l.players.length ? `<div class="tb-row"><span class="kicker">On the block</span><div class="tb-chips">${l.players.map(chip).join("")}</div></div>` : ""}
        ${l.untouchable.length ? `<p class="tb-untouch"><span class="kicker">Untouchable</span> ${l.untouchable.map(p => esc(p.name)).join(", ")}</p>` : ""}
        ${l.needs.length ? `<div class="tb-row"><span class="kicker">Looking for</span><div class="tb-chips">${l.needs.map(p => `<span class="tb-chip need"><span class="slot ${esc(p)}">${esc(p)}</span></span>`).join("")}</div></div>` : ""}
        ${l.note ? `<p class="tb-note">“${esc(l.note)}”</p>` : ""}${tryBlock(t, l)}</article>`;
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
  const HISTORY_TABS = [["overview", "Champions & standings"], ["h2h", "Tale of the tape"], ["rivalries", "Rivalries"], ["records", "Record book"], ["badges", "Badges"], ["players", "Player history"], ["wrapped", "Wrapped"]];
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

  // ---------------------------------------------------------------- League Wrapped (History → Wrapped)
  // Each manager's finished season as a full-screen story. One idea per slide, every number set against the league or
  // its history, with player photos (ESPN headshots), a guess-your-MVP slide, a Wrapped-style top 5, the road through
  // the standings, and the team's strongest optional slides (clutch, best move, the one that got away, the
  // heartbreaker, bench regret, luck, rivals, superlatives, trade of the year). The tone celebrates, with a light roast.
  // Ends with the league's champion and week of the year and a trading-card summary; every slide shares as an image.
  // Finished seasons only (the current one opens the day the championship is decided). All from data the site has.
  const WR_THEMES = {
    brand: { bg: "#0c2a20", ink: "#eaf5ef", ink2: "#9fc7b3", hi: "#2bc47b", sh: "#1d5a43" },
    sun: { bg: "#f6c344", ink: "#241a00", ink2: "#5e4a0c", hi: "#d9482a", sh: "#ffdf80" },
    sky: { bg: "#1f4fd1", ink: "#f2f5ff", ink2: "#bccbf7", hi: "#ffd84d", sh: "#3d6ef0" },
    berry: { bg: "#5b2368", ink: "#fbefff", ink2: "#dcb5e6", hi: "#ff9bd2", sh: "#7a3a8a" },
    coral: { bg: "#d9482a", ink: "#fff4ef", ink2: "#ffd0c2", hi: "#ffe066", sh: "#ee6a4c" },
    paper: { bg: "#f1f4f2", ink: "#0f1a16", ink2: "#56645e", hi: "#14824e", sh: "#dbe5df" },
    night: { bg: "#14112b", ink: "#f3f0ff", ink2: "#a9a3d6", hi: "#7cf2c5", sh: "#2a2457" },
  };
  const WR_LIGHT = ["paper", "sun"];
  const WR_MS = 6500; // time on each slide
  const WR_OPT = 3;   // optional slides per story
  const WR = { slides: [], i: 0, start: 0, pauseAt: 0, paused: false, raf: 0, el: null, holdT: 0 };
  const wrLink = (season, extra) => "#/history/wrapped" + (() => { const p = new URLSearchParams(extra || {}); if (season !== IDX.current) p.set("season", season); const s = p.toString(); return s ? "?" + s : ""; })();
  const wrReady = () => L.over;
  const wrPhoto = p => p.pos === "D/ST" ? `https://a.espncdn.com/i/teamlogos/nfl/500/${String(p.team || "").toLowerCase()}.png` : `https://a.espncdn.com/i/headshots/nfl/players/full/${p.id}.png`;
  const WR_TYPE_ICON = [["loyalist", "🫡"], ["waiver", "🦅"], ["tinker", "🔧"], ["night", "🦉"], ["gut", "🎲"], ["planner", "📋"], ["deal", "🤝"], ["projection", "📈"], ["game-day", "⏰"], ["sunday", "☕"], ["quick", "⚡"], ["patient", "🧘"], ["all-rounder", "⭐"]];
  const wrTypeIcon = type => (WR_TYPE_ICON.find(([k]) => String(type).toLowerCase().includes(k)) || [0, "🏈"])[1];

  // everything the slides need for one team, then the slides themselves
  function wrSlides(t, P, M, ST) {
    const RS = L.regularSeasonWeeks, f1 = n => Number(n || 0).toFixed(1), owner = (t.owners || [])[0];
    const tn = id => tname(id);
    const reg = D.weeks.filter(w => w.week <= RS && w.final);
    const pw = D.weeks.filter(w => w.week > RS && w.final && w.games.some(g => g.tier === "WINNERS_BRACKET"));
    const roundName = i => i === pw.length - 1 ? "the final" : i === pw.length - 2 ? "the semifinals" : i === 0 ? "the first round" : "round " + (i + 1);
    const wkName = w => { const i = pw.findIndex(x => x.week === w); return w > RS && i >= 0 ? roundName(i).replace(/^the /, "").replace(/^./, c => c.toUpperCase()) + ` (week ${w})` : `Week ${w}`; };
    const games = [];
    reg.concat(pw).forEach(w => w.games.filter(g => g.sides.length === 2 && (w.week <= RS || g.tier === "WINNERS_BRACKET")).forEach(g =>
      g.sides.forEach((sd, k) => games.push({ w: w.week, sd, op: g.sides[1 - k], po: w.week > RS }))));
    const mine = games.filter(x => x.sd.team === t.id);
    const regMine = mine.filter(x => !x.po);
    const won = x => x.sd.pts > x.op.pts, lost = x => x.sd.pts < x.op.pts;
    const starters = sd => sd.lineup.filter(p => !["BE", "IR"].includes(p.slot));
    const slides = [], add = s => slides.push(s);
    // ranks against the league, and a player's real stat line over a set of weeks (from the season's stat file)
    const rankOf = (f, x, hi = true) => 1 + D.teams.filter(o => hi ? f(o) > f(x) : f(o) < f(x)).length;
    const n0 = v => Math.round(v).toLocaleString();
    function pline(id, pos, weeks) {
      const sum = {};
      let g = 0;
      (weeks || []).forEach(w => { const r = ST && ST[w + "|" + id]; if (!r) return; g++; Object.entries(r.r || {}).forEach(([k, v]) => { sum[k] = (sum[k] || 0) + v; }); });
      if (!g) return [];
      const v = k => sum[k] || 0, td = v(4) + v(25) + v(43);
      if (pos === "QB") return [[n0(v(3)), "pass yds"], [String(v(4)), "pass TD"], [n0(v(24)), "rush yds"], [String(v(20)), "INT"]];
      if (pos === "RB") return [[n0(v(24) + v(42)), "scrimmage yds"], [String(td), "TD"], [n0(v(24)), "rush yds"], [String(v(53)), "catches"]];
      if (pos === "WR" || pos === "TE") return [[n0(v(42)), "rec yds"], [String(td), "TD"], [String(v(53)), "catches"], [String(v(58)), "targets"]];
      return [];
    }
    const range = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, k) => a + k);
    let seed = (t.id * 7919 + L.season) % 2147483647 || 1;
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;

    // player totals as a starter (regular season + winners bracket)
    const tot = {};
    let all = 0;
    mine.forEach(x => starters(x.sd).forEach(p => {
      const o = tot[p.id] || (tot[p.id] = { id: p.id, name: p.name, pos: p.pos, team: p.team, pts: 0, starts: 0, best: 0, bestW: 0, wks: [], big: 0 });
      o.pts += p.pts || 0; o.starts++; all += p.pts || 0; o.wks.push(x.w); if ((p.pts || 0) >= 20) o.big++;
      if ((p.pts || 0) > o.best) { o.best = p.pts || 0; o.bestW = x.w; }
    }));
    const ranked = Object.values(tot).sort((a, b) => b.pts - a.pts);
    const mvp = ranked[0];
    const starterTiles = p => { const ln = pline(p.id, p.pos, p.wks).slice(0, 2); return [[(p.pts / Math.max(1, p.starts)).toFixed(1), "pts per start"], [p.best.toFixed(1), `best game (wk ${p.bestW})`]].concat(ln.length ? ln : [[String(p.big), "20-pt games"]]); };

    // 1. cover
    add({ key: "cover", theme: "night", kicker: `${L.season} League Wrapped`, big: t.name, line: `${t.manager}, this was your season.`, logo: t.logo, cover: true });

    // 2. the road through the standings (rank after each regular-season week; W/L on each dot)
    {
      const W = {}, PF = {};
      D.teams.forEach(x => { W[x.id] = 0; PF[x.id] = 0; });
      const road = [];
      reg.forEach(w => {
        w.games.filter(g => g.sides.length === 2).forEach(g => {
          const [a, b] = g.sides; PF[a.team] += a.pts; PF[b.team] += b.pts;
          if (a.pts > b.pts) W[a.team]++; else if (b.pts > a.pts) W[b.team]++; else { W[a.team] += 0.5; W[b.team] += 0.5; }
        });
        const order = D.teams.map(x => x.id).sort((x, y) => W[y] - W[x] || PF[y] - PF[x]);
        const g = regMine.find(x => x.w === w.week);
        road.push({ w: w.week, r: order.indexOf(t.id) + 1, res: g ? (won(g) ? "W" : lost(g) ? "L" : "T") : "" });
      });
      if (road.length >= 3) {
        const first = road[0], last = road[road.length - 1];
        const top = road.reduce((m, x) => (x.r < m.r ? x : m)), low = road.reduce((m, x) => (x.r > m.r ? x : m));
        let line = `${ordinal(first.r)} after week ${first.w}`;
        if (top.r < first.r && top !== last) line += `, as high as ${ordinal(top.r)} in week ${top.w}`;
        if (low.r > first.r && low !== last && low.r > top.r + 2) line += `, as low as ${ordinal(low.r)} in week ${low.w}`;
        line += `, and ${ordinal(last.r)} when the regular season ended.`;
        if (t.finalRank === 1) line += " Then you won it all.";
        let run = 0, best = 0;
        regMine.forEach(x => { run = won(x) ? run + 1 : 0; best = Math.max(best, run); });
        const inSpot = road.filter(x => x.r <= L.playoffTeams).length;
        add({ key: "road", theme: "paper", kicker: "Your road", stats: [[`${inSpot}/${road.length}`, "weeks in a playoff spot"], [ordinal(top.r), `highest (wk ${top.w})`], [String(best), "longest win streak"]], big: first.r === last.r ? `${ordinal(last.r)}, start to finish` : `${ordinal(first.r)} → ${ordinal(last.r)}`, line,
          sub: `${record(t)} regular season${best >= 3 ? ` · longest win streak: ${best}` : ""}`, road, cut: L.playoffTeams });
      }
    }

    // 3. how it ended
    {
      const po = L.playoffTeams, order = D.teams.slice().sort((a, b) => (a.standing || 99) - (b.standing || 99));
      const finalG = pw.length ? mine.find(x => x.w === pw[pw.length - 1].week) : null;
      const beat = D.teams.filter(x => x.pf < t.pf).length;
      let big = finishText(t.finalRank), line = "", theme = "sky", confetti = false, emoji = "";
      if (t.finalRank === 1) {
        theme = "sun"; confetti = true; emoji = "🏆";
        line = finalG ? `Beat ${tn(finalG.op.team)} ${f1(finalG.sd.pts)}–${f1(finalG.op.pts)} in the final.` : "League champion.";
        const ch = ((IDX.history || {}).champions || []).filter(c => c.record);
        const pctOf = r => { const [w, l] = String(r).split("-").map(Number); return w / Math.max(1, w + l); };
        const me = ch.find(x => x.season === L.season);
        if (me && ch.length > 1 && ch.every(c => c === me || pctOf(c.record) > pctOf(me.record))) line += ` From a ${record(t)} regular season, the worst record of any champion in league history. Didn't matter.`;
      } else if (t.finalRank === 2 && finalG) {
        emoji = "🥈"; line = `Lost the final to ${tn(finalG.op.team)} by ${f1(finalG.op.pts - finalG.sd.pts)}. One game away.`;
      } else if (t.seed && t.seed <= po) {
        emoji = "🎟️";
        const out = mine.filter(x => x.po && lost(x)).pop();
        line = `Made the playoffs as the ${ordinal(t.seed)} seed${out ? `, then went out in ${roundName(pw.findIndex(w => w.week === out.w))} to ${tn(out.op.team)}` : ""}.`;
      } else {
        emoji = "📺";
        const last = order[po - 1];
        if (last && last.wins === t.wins) line = `Missed the playoffs on points: ${f1(last.pf - t.pf)} behind ${last.name} for the last spot. Brutal.`;
        else if (last) line = `Missed the playoffs by ${last.wins - t.wins} win${last.wins - t.wins === 1 ? "" : "s"}.`;
        if (t.finalRank === L.size) { line += " Last place. Somebody had to be."; theme = "coral"; emoji = "🪦"; }
      }
      const stats = [[`#${rankOf(x => x.pf, t)}`, "in points scored"], [`#${rankOf(x => x.pa, t)}`, "most points against"]];
      if (t.allPlayW != null) stats.push([`${t.allPlayW}–${t.allPlayL}`, "vs. everyone, every week"]);
      add({ key: "finish", theme, kicker: "How it ended", big, emoji, confetti, line: line.trim(), stats, sub: `${record(t)} · ${fmt(t.pf)} points, ${beat === L.size - 1 ? "the most in the league" : beat === 0 ? "the fewest in the league" : `more than ${beat} of the other ${L.size - 1} teams`}` });
    }

    // 4. guess your MVP, then 5. your top 5
    if (ranked.length >= 4) {
      const opts = ranked.slice(0, 4).map(p => ({ ...p })).sort(() => rand() - 0.5);
      add({ key: "quiz", theme: "berry", kicker: "Quick question", big: "Who scored the most for you?", quiz: { options: opts, answer: mvp.id },
        reveal: `${mvp.name}: ${f1(mvp.pts)} points, ${Math.round(100 * mvp.pts / Math.max(1, all))}% of everything you scored.`, face: mvp, stats: starterTiles(mvp) });
    }
    if (ranked.length >= 3) add({ key: "top5", theme: "brand", kicker: "Your top players", big: "Your top 5", top5: ranked.slice(0, 5).map(p => ({ ...p, share: Math.round(100 * p.pts / Math.max(1, all)) })) });
    // this or that: the two players (after the MVP, top 8) closest in points, ideally at different positions
    {
      const pool = ranked.slice(1, 8), pairs = [];
      pool.forEach((a, i) => pool.slice(i + 1).forEach(b => pairs.push([a, b, Math.abs(a.pts - b.pts) / Math.max(a.pts, b.pts) + (a.pos === b.pos ? 0.04 : 0)])));
      const pr = pairs.sort((x, y) => x[2] - y[2])[0];
      if (pr && pr[2] < 0.25) {
        const [a, b] = rand() < 0.5 ? [pr[0], pr[1]] : [pr[1], pr[0]], win = a.pts >= b.pts ? a : b, lose = win === a ? b : a;
        add({ key: "duel", theme: "coral", kicker: "This or that", big: "Who scored more for you?", quiz: { options: [a, b], answer: win.id, duel: true }, face: win,
          reveal: `${win.name}, by ${f1(win.pts - lose.pts)}: ${f1(win.pts)} to ${f1(lose.pts)}${win.starts !== lose.starts ? `, in ${win.starts} starts to ${lose.starts}` : ""}.`,
          stats: [[f1(win.pts / Math.max(1, win.starts)), `${win.name.split(" ").slice(-1)[0]} per start`], [f1(lose.pts / Math.max(1, lose.starts)), `${lose.name.split(" ").slice(-1)[0]} per start`], [win.best.toFixed(1), `${win.name.split(" ").slice(-1)[0]}'s best game`]] });
      }
    }

    // 6. peak and valley
    {
      const top = mine.reduce((m, x) => (!m || x.sd.pts > m.sd.pts ? x : m), null), low = mine.reduce((m, x) => (!m || x.sd.pts < m.sd.pts ? x : m), null);
      if (top) {
        const rank = 1 + games.filter(x => x.sd.pts > top.sd.pts).length;
        const where = rank === 1 ? "The highest score anyone put up all season." : `The ${ordinal(rank)}-best score of the ${games.length} this season.`;
        const star = starters(top.sd).sort((a, b) => (b.pts || 0) - (a.pts || 0))[0];
        add({ key: "peak", theme: "sky", kicker: "Your peak", big: f1(top.sd.pts), count: top.sd.pts,
          line: `${wkName(top.w)}${top.po ? ", when it counted most" : ""}. ${where}`, sub: star ? `${star.name} led the way with ${f1(star.pts)}.` : "",
          bars: mine.map(x => ({ v: x.sd.pts, hi: x === top, lo: x === low })), low: low && low !== top ? `Your low: ${f1(low.sd.pts)} in ${wkName(low.w).toLowerCase()}.` : "",
          stats: (() => { const avg = x => { const g = games.filter(y => y.sd.team === x.id && !y.po); return g.reduce((n, y) => n + y.sd.pts, 0) / Math.max(1, g.length); };
            const lgAvg = games.filter(y => !y.po).reduce((n, y) => n + y.sd.pts, 0) / Math.max(1, games.filter(y => !y.po).length);
            const tops = reg.filter(w => { const sc = games.filter(y => y.w === w.week); const mx = Math.max(...sc.map(y => y.sd.pts)); return sc.some(y => y.sd.team === t.id && y.sd.pts === mx); }).length;
            return [[f1(avg(t)), `points a week (#${rankOf(avg, t)})`], [`${regMine.filter(x => x.sd.pts > lgAvg).length}/${regMine.length}`, "weeks above the league average"], [String(tops), `week${tops === 1 ? "" : "s"} with the league's top score`]]; })() });
      }
    }

    // your position rooms: regular-season starter points by position, ranked
    {
      const POSN = [["QB", "quarterbacks"], ["RB", "running backs"], ["WR", "receivers"], ["TE", "tight ends"], ["K", "kickers"], ["D/ST", "defense"]];
      const room = {};
      games.filter(x => !x.po).forEach(x => starters(x.sd).forEach(p => { const r = room[x.sd.team] || (room[x.sd.team] = {}); r[p.pos] = (r[p.pos] || 0) + (p.pts || 0); }));
      const rows = POSN.filter(([k]) => D.teams.some(o => (room[o.id] || {})[k])).map(([k, word]) => {
        const v = (room[t.id] || {})[k] || 0, all2 = D.teams.map(o => (room[o.id] || {})[k] || 0);
        return { k, word, v, rank: 1 + all2.filter(x => x > v).length, max: Math.max(...all2) };
      });
      if (rows.length >= 4) {
        const bestR = rows.slice().sort((a, b) => a.rank - b.rank || b.v - a.v)[0], worstR = rows.slice().sort((a, b) => b.rank - a.rank || a.v - b.v)[0];
        add({ key: "rooms", theme: "night", kicker: "Your position rooms", big: `${bestR.k} room: #${bestR.rank}`, rooms: rows,
          line: `Your ${bestR.word} scored ${n0(bestR.v)} points, ${bestR.rank === 1 ? "the most in the league" : `#${bestR.rank} in the league`}. Your ${worstR.word}: #${worstR.rank}${worstR.rank >= L.size - 1 ? ". Yikes" : ""}.` });
      }
    }
    // optional slides (the team's strongest WR_OPT, kept in story order)
    {
      const pg = [];
      games.forEach(x => starters(x.sd).forEach(p => pg.push({ p, x })));
      const myBest = pg.filter(g => g.x.sd.team === t.id).sort((a, b) => (b.p.pts || 0) - (a.p.pts || 0))[0];
      if (myBest) {
        const rank = 1 + pg.filter(g => (g.p.pts || 0) > (myBest.p.pts || 0)).length;
        if (rank <= 10) add({ key: "game", opt: 11 - rank, theme: "sun", kicker: "Your best single game", big: f1(myBest.p.pts), count: myBest.p.pts, face: myBest.p,
          line: `${myBest.p.name}, ${wkName(myBest.x.w).toLowerCase()}. ${rank === 1 ? "The best game by any player in the league all season." : `The ${ordinal(rank)}-best game by any player in the league all season.`}`,
          stats: pline(myBest.p.id, myBest.p.pos, [myBest.x.w]).slice(0, 3).concat([[won(myBest.x) ? "W" : "L", `vs. ${tn(myBest.x.op.team)}`]]) });
      }
    }
    {
      const losses = mine.filter(lost), winsG = mine.filter(won);
      const hiL = losses.sort((a, b) => b.sd.pts - a.sd.pts)[0], loW = winsG.sort((a, b) => a.sd.pts - b.sd.pts)[0];
      const rkL = hiL ? 1 + games.filter(x => lost(x) && x.sd.pts > hiL.sd.pts).length : 99, rkW = loW ? 1 + games.filter(x => won(x) && x.sd.pts < loW.sd.pts).length : 99;
      if ((hiL && rkL <= 3) || (loW && rkW <= 3)) add({ key: "weird", opt: 9 - Math.min(rkL, rkW) * 2, theme: "paper", kicker: "Football is weird", big: "Weird results", rivals: [
        hiL && { label: "Most points in a loss", name: f1(hiL.sd.pts), rec: `lost to ${tn(hiL.op.team)} in ${wkName(hiL.w).toLowerCase()}`, yr: rkL === 1 ? "the most in a loss all season" : `#${rkL} in a loss all season`, emoji: "🤦", avg: `they scored ${f1(hiL.op.pts)}` },
        loW && { label: "Fewest points in a win", name: f1(loW.sd.pts), rec: `beat ${tn(loW.op.team)} in ${wkName(loW.w).toLowerCase()}`, yr: rkW === 1 ? "the fewest in a win all season" : `#${rkW} fewest in a win`, emoji: "🥷", avg: `they scored ${f1(loW.op.pts)}` }].filter(Boolean) });
    }
    if (t.sos && t.sos.facedVsAvg != null) {
      const byF = D.teams.filter(o => o.sos && o.sos.facedVsAvg != null).sort((a, b) => b.sos.facedVsAvg - a.sos.facedVsAvg), r = byF.indexOf(t);
      if (r >= 0 && (r < 2 || r >= byF.length - 2) && Math.abs(t.sos.facedVsAvg) >= 3) {
        const up = t.sos.facedVsAvg > 0;
        add({ key: "sched", opt: Math.abs(t.sos.facedVsAvg) / 1.5, theme: up ? "coral" : "sky", kicker: up ? "Everyone brought it against you" : "Opponents went quiet", big: `${signed(t.sos.facedVsAvg)} a week`, emoji: up ? "😠" : "😴",
          line: up ? `Your opponents scored ${f1(t.sos.facedVsAvg)} more a week against you than they did on average. ${r === 0 ? "No one in the league got that treatment more." : "Almost nobody got it worse."}`
            : `Your opponents scored ${f1(-t.sos.facedVsAvg)} less a week against you than they usually did. ${r === byF.length - 1 ? "The kindest schedule in the league." : "One of the kindest schedules in the league."}`,
          stats: [[f1(t.sos.faced), "scored against you a week"], [f1(t.sos.oppPpg), "your opponents' usual average"]] });
      }
    }
    {
      const decided = {};
      mine.filter(won).forEach(x => { const margin = x.sd.pts - x.op.pts; starters(x.sd).filter(p => (p.pts || 0) > margin).forEach(p => { (decided[p.id] = decided[p.id] || { ...p, n: 0 }).n++; }); });
      const c = Object.values(decided).sort((a, b) => b.n - a.n)[0], wins = mine.filter(won).length;
      if (c && c.n >= 3 && c.n >= 0.4 * wins) add({ key: "clutch", opt: 10 * c.n / wins, theme: "night", kicker: "Mr. Clutch", big: c.name, face: c,
        line: c.n === wins ? `Without his points you'd have lost every one of your ${wins} wins. Every one.` : `Without his points you'd have lost ${c.n} of your ${wins} wins.`, stats: tot[c.id] ? starterTiles(tot[c.id]) : null });
    }
    if (P) {
      const stints = Object.entries(P.players).flatMap(([id, x]) => x.s.filter(s => s[0] === L.season).map(s => ({ id: Number(id), n: x.n, p: x.p, s })));
      const teamOf = id => { for (const w of D.weeks) for (const g of w.games) for (const sd of g.sides) { const p = sd.lineup.find(q => q.id === id); if (p) return p.team; } return ""; };
      const bm = stints.filter(x => x.s[1] === t.id && (x.s[7] === "W" || x.s[7] === "T") && !["K", "D/ST"].includes(x.p)).sort((a, b) => b.s[4] - a.s[4])[0];
      if (bm && bm.s[4] >= 50) add({ key: "move", opt: bm.s[4] / 25, theme: "sun", kicker: "Your best move", big: bm.n, face: { id: bm.id, name: bm.n, pos: bm.p, team: teamOf(bm.id) },
        line: `${bm.s[7] === "T" ? "Traded for" : "Picked up"} in week ${bm.s[2]}, then ${f1(bm.s[4])} points in your lineup.`,
        stats: tot[bm.id] ? starterTiles(tot[bm.id]) : [[String(bm.s[5]), "starts for you"]].concat(pline(bm.id, bm.p, range(bm.s[2], bm.s[3])).slice(0, 3)) });
      const gone = stints.filter(x => x.s[1] === t.id && (x.s[8] === "X" || x.s[8] === "T") && !["K", "D/ST"].includes(x.p)).map(x => {
        const after = stints.filter(y => y.id === x.id && y.s[1] !== t.id && y.s[2] > x.s[3]);
        return { x, pts: after.reduce((n, y) => n + y.s[4], 0), to: after[0] };
      }).filter(g => g.to).sort((a, b) => b.pts - a.pts)[0];
      if (gone && gone.pts >= 60) {
        const champ = teamById[gone.to.s[1]] && teamById[gone.to.s[1]].finalRank === 1;
        add({ key: "away", opt: gone.pts / 20, theme: "coral", kicker: "The one that got away", big: gone.x.n, face: { id: gone.x.id, name: gone.x.n, pos: gone.x.p, team: teamOf(gone.x.id) },
          line: `You ${gone.x.s[8] === "T" ? "traded him away" : "dropped him"} after week ${gone.x.s[3]}. ${tn(gone.to.s[1])} started him for ${f1(gone.pts)} points${champ ? " on the way to the title" : ""}.`,
          stats: [[f1(gone.x.s[4]), "started pts for you"], [f1(gone.pts), "started pts after"]].concat(pline(gone.x.id, gone.x.p, range(gone.x.s[3] + 1, L.finalWeek)).slice(0, 2)) });
      }
    }
    {
      const close = mine.filter(lost).sort((a, b) => (a.op.pts - a.sd.pts) - (b.op.pts - b.sd.pts))[0];
      if (close && close.op.pts - close.sd.pts < 5) {
        const m = close.op.pts - close.sd.pts;
        const bench = close.sd.lineup.filter(p => p.slot === "BE" && (p.pts || 0) > m).sort((a, b) => b.pts - a.pts)[0];
        const cg = mine.filter(x => Math.abs(x.sd.pts - x.op.pts) < 10);
        add({ key: "heart", stats: [[`${cg.filter(won).length}–${cg.filter(lost).length}`, "in games decided by under 10"], [String(mine.filter(lost).length), "losses in all"]], opt: 10 - 1.5 * m + (close.po ? 4 : 0), theme: "berry", kicker: "The heartbreaker", big: m.toFixed(2), count: m, emoji: "💔",
          sub: "points. That's all it was.",
          line: `${tn(close.op.team)} beat you ${f1(close.op.pts)}–${f1(close.sd.pts)} in ${wkName(close.w).toLowerCase()}.${bench ? ` Meanwhile ${bench.name} scored ${f1(bench.pts)} on your bench.` : ""}` });
      }
    }
    {
      const fits = (bp, slot) => slot === bp.pos || (slot === "FLEX" && ["RB", "WR", "TE"].includes(bp.pos));
      const costly = mine.filter(lost).map(x => {
        let best = null;
        x.sd.lineup.filter(p => p.slot === "BE" && (p.pts || 0) > 0).forEach(bp => starters(x.sd).filter(sp => fits(bp, sp.slot)).forEach(sp => {
          const gain = (bp.pts || 0) - (sp.pts || 0);
          if (gain > x.op.pts - x.sd.pts && (!best || gain > best.gain)) best = { gain, bp, sp };
        }));
        return best && { x, ...best };
      }).filter(Boolean).sort((a, b) => (b.x.po - a.x.po) || (b.gain - a.gain));
      const r = costly[0];
      const all3 = D.teams.map(o => o.benchLeft).filter(v => v != null);
      if (t.benchLeft != null && all3.length > 2) {
        const max = Math.ceil(Math.max(...all3) * 1.3 / 50) * 50, rk = 1 + all3.filter(v => v > t.benchLeft).length;
        add({ key: "guess", theme: "berry", kicker: "Guess the number", big: "How many points did you leave on your bench?",
          slider: { min: 0, max, step: 5, answer: t.benchLeft, start: Math.round(max / 2 / 5) * 5 },
          reveal: `${f1(t.benchLeft)} points sat on your bench all season, ${rk === 1 ? "the most in the league" : rk === all3.length ? "the fewest in the league" : `#${rk} in the league`}.${r ? ` The costliest call: ${r.bp.name} (${f1(r.bp.pts)}) on the bench while ${r.sp.name} (${f1(r.sp.pts)}) started in ${wkName(r.x.w).toLowerCase()}, a game you lost.` : ""}`,
          stats: [[n0(t.benchLeft), "bench points"], [`#${rk}`, "most in league"], t.efficiency != null ? [`${Math.round(t.efficiency)}%`, `lineups (#${rankOf(x => x.efficiency || 0, t)})`] : [String(costly.length), "losses a swap flips"]] });
      }
      const benchStats = [t.benchLeft != null ? [f1(t.benchLeft), `left on the bench (#${rankOf(x => x.benchLeft || 0, t)})`] : null, t.efficiency != null ? [`${t.efficiency}%`, `lineup efficiency (#${rankOf(x => x.efficiency || 0, t)})`] : null].filter(Boolean);
      if (t.benchLeft == null && r && (costly.length >= 2 || r.x.po)) add({ key: "bench", stats: benchStats, opt: 3 * costly.length + (r.x.po ? 6 : 0), theme: "coral", kicker: "Bench regret", big: costly.length === 1 ? "1 loss" : `${costly.length} losses`, emoji: "🪑",
        line: `That's how many games one bench swap would have flipped. The worst: ${r.bp.name} (${f1(r.bp.pts)}) sat while ${r.sp.name} (${f1(r.sp.pts)}) started in ${wkName(r.x.w).toLowerCase()}.`, face: { id: r.bp.id, name: r.bp.name, pos: r.bp.pos, team: r.bp.team } });
      else if (t.benchLeft == null && !r && mine.filter(lost).length >= 4) add({ key: "bench", stats: benchStats, opt: 4, theme: "brand", kicker: "Lineup calls", big: "Clean sheet", emoji: "🧹", line: "Not one of your losses would have flipped with a different bench call. You just got outscored." });
    }
    if (t.luck != null) {
      const byLuck = D.teams.filter(x => x.luck != null).sort((a, b) => b.luck - a.luck), r = byLuck.indexOf(t);
      if (r >= 0 && (r < 3 || r >= byLuck.length - 3) && Math.abs(t.luck) >= 1) {
        const lucky = t.luck > 0;
        add({ key: "luck", stats: [t.allPlayW != null ? [`${t.allPlayW}–${t.allPlayL}`, "vs. everyone, every week"] : null, [n0(t.pa), `points against you (#${rankOf(x => x.pa, t)} most)`]].filter(Boolean), opt: 4 * Math.abs(t.luck), theme: lucky ? "sun" : "night", kicker: lucky ? "Luck" : "Bad luck", big: `${signed(t.luck)} wins`, emoji: lucky ? "🍀" : "🌧️",
          line: lucky ? `You won ${t.wins}; your scoring deserved about ${f1(t.expectedWins)}. The ${r === 0 ? "" : ordinal(r + 1) + "-"}luckiest team in the league. We all noticed.`
            : `You won ${t.wins}; your scoring deserved about ${f1(t.expectedWins)}. The ${r === byLuck.length - 1 ? "" : ordinal(byLuck.length - r) + "-"}unluckiest team in the league. The schedule had it out for you.` });
      }
    }
    {
      const H = (IDX.history || {}).h2h || {};
      const rows = Object.entries(H).filter(([k]) => k.split("|")[0] === owner).map(([k, v]) => ({ m: k.split("|")[1], w: v[0], l: v[1], g: v[0] + v[1] + v[2], pf: v[3], pa: v[4] })).filter(r => r.g >= 3);
      const nem = rows.filter(r => r.l > r.w).sort((a, b) => (b.l - b.w) - (a.l - a.w) || b.g - a.g)[0];
      const vic = rows.filter(r => r.w > r.l).sort((a, b) => (b.w - b.l) - (a.w - a.l) || b.g - a.g)[0];
      const thisYear = m => { const tm = D.teams.find(x => (x.owners || []).includes(m)); const gs = tm ? mine.filter(x => x.op.team === tm.id) : []; return gs.length ? `${gs.filter(won).length}–${gs.filter(lost).length} this season` : ""; };
      if (nem && vic) add({ key: "rivals", opt: 6, theme: "paper", kicker: "Your rivals", big: "Rivals", rivals: [
        { label: "Your nemesis", name: memberName(nem.m), rec: `${nem.w}–${nem.l} all-time`, yr: thisYear(nem.m), emoji: "😤", avg: `average ${f1(nem.pf / nem.g)}–${f1(nem.pa / nem.g)} in those games` },
        { label: "Your favorite victim", name: memberName(vic.m), rec: `${vic.w}–${vic.l} all-time`, yr: thisYear(vic.m), emoji: "😈", avg: `average ${f1(vic.pf / vic.g)}–${f1(vic.pa / vic.g)} in those games` }] });
    }
    {
      const by = f => D.teams.reduce((m, x) => (m == null || f(x) > f(m) ? x : m), null);
      const aw = [];
      if (by(x => x.pf) === t) aw.push(["💰", "Most points in the league"]);
      if (D.teams.some(x => x.efficiency != null) && by(x => x.efficiency || 0) === t) aw.push(["🎯", `Best lineups (${t.efficiency}% efficiency)`]);
      if (D.teams.some(x => x.benchLeft != null) && by(x => x.benchLeft || 0) === t) aw.push(["🪑", "Most points left on the bench"]);
      const B = (IDX.history || {}).badges || {}, defs = Object.fromEntries((B.defs || []).map(d => [d.id, d]));
      const seen = new Set();
      ((B.earned || {})[owner] || []).filter(e => e[1] === L.season && defs[e[0]] && !["champ", "runner"].includes(e[0])).forEach(e => {
        if (seen.has(e[0])) return; seen.add(e[0]);
        aw.push([BADGE_ICON[e[0]] || "🏅", `${defs[e[0]].name}${e[4] ? ` (${e[4]})` : ""}`]);
      });
      if (aw.length >= 2) add({ key: "awards", opt: 2 + 2 * aw.length, theme: "berry", kicker: "Your superlatives", big: `${aw.length} awards`, list: aw.slice(0, 5) });
    }
    {
      const tw = (D.trades || []).filter(tr => tr.sides && tr.sides.length === 2).map(tr => { const [a, b] = tr.sides.slice().sort((x, y) => (y.started || 0) - (x.started || 0)); return { a, b, edge: (a.started || 0) - (b.started || 0) }; })
        .sort((x, y) => y.edge - x.edge)[0];
      if (tw && tw.edge > 0 && (tw.a.team === t.id || tw.b.team === t.id)) {
        const mineWon = tw.a.team === t.id;
        add({ key: "ltrade", opt: 7, theme: mineWon ? "sun" : "coral", kicker: "The trade of the year", big: mineWon ? "You won it" : "You lost it", emoji: mineWon ? "🤝" : "🫠",
          line: `${tn(tw.a.team)} got ${tw.a.gets.map(g => g.name).join(", ")} from ${tn(tw.b.team)}: ${Math.round(tw.a.started || 0)} started points back, against ${Math.round(tw.b.started || 0)} the other way.` });
      }
    }

    // manager type (from the moves log)
    const style = M && M.style && M.style[t.id];
    const rk = k => style && style.ranks && style.ranks[k] ? ` (#${style.ranks[k]})` : "";
    if (style && style.type) add({ key: "type", theme: "sky", kicker: "Your manager type", big: style.type, emoji: wrTypeIcon(style.type),
      stats: [[String(style.adds || 0), `pickups${rk("adds")}`], [String(style.trades || 0), `trades${rk("trades")}`], [String(style.acts || 0), "moves in all"], style.days ? [["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][style.days.indexOf(Math.max(...style.days))], "busiest day"] : null].filter(Boolean),
      chips: (style.traits || []).map(x => x[2].replace(/^./, c => c.toUpperCase())), line: (style.traits || []).length ? "" : "From how you ran your team all season." });

    // the league's year (the same for everyone)
    {
      const champ = D.teams.find(x => x.finalRank === 1);
      const fin = pw.length && champ ? games.find(x => x.w === pw[pw.length - 1].week && x.sd.team === champ.id) : null;
      if (champ && champ !== t) add({ key: "lchamp", theme: "sun", kicker: `Your ${L.season} champion`, big: champ.name, emoji: "🏆", logo: champ.logo,
        stats: [[champ.seed ? ordinal(champ.seed) : "—", "seed"], [`#${rankOf(x => x.pf, champ)}`, "in points for"], [(() => { const h = ((IDX.history || {}).h2h || {})[`${owner}|${(champ.owners || [])[0]}`]; return h ? `${h[0]}–${h[1]}` : "—"; })(), "your all-time record vs. them"]],
        line: fin ? `Beat ${tn(fin.op.team)} ${f1(fin.sd.pts)}–${f1(fin.op.pts)} in the final, after a ${record(champ)} regular season.` : `${record(champ)} in the regular season.` });
      const hi = games.reduce((m, x) => (!m || x.sd.pts > m.sd.pts ? x : m), null);
      if (hi) {
        const star = starters(hi.sd).sort((a, b) => (b.pts || 0) - (a.pts || 0))[0];
        add({ key: "lweek", theme: "night", kicker: "The week of the year", big: f1(hi.sd.pts), count: hi.sd.pts,
          line: `${hi.sd.team === t.id ? "That was you" : tn(hi.sd.team)}, ${wkName(hi.w).toLowerCase()}. Nobody scored more all season.`, sub: star ? `Led by ${star.name}: ${f1(star.pts)} points` : "", face: star ? { id: star.id, name: star.name, pos: star.pos, team: star.team } : null,
          stats: star ? pline(star.id, star.pos, [hi.w]).slice(0, 3) : null });
      }
    }

    // the summary card
    const best = mine.reduce((m, x) => (!m || x.sd.pts > m.sd.pts ? x : m), null);
    add({ key: "summary", theme: "brand", kicker: `${L.season} League Wrapped`, big: t.name, logo: t.logo, face: mvp || null, card: {
      mvp: mvp ? [mvp.name, `${f1(mvp.pts)} pts`] : null,
      tiles: [["Finish", finishText(t.finalRank)], ["Record", record(t)], ["Best week", best ? f1(best.sd.pts) : "—"], ["Points", fmt(t.pf)],
        style && style.type ? ["Type", style.type] : null, t.luck != null ? ["Luck", `${signed(t.luck)} W`] : null].filter(Boolean) } });

    const keep = new Set(slides.filter(x => x.opt != null).sort((a, b) => b.opt - a.opt).slice(0, WR_OPT));
    return slides.filter(x => x.opt == null || keep.has(x));
  }

  // ---- slide markup
  const wrFace = (p, cls) => p ? `<span class="wr-face ${cls || ""}"><b>${esc(initials(p.name))}</b><img src="${esc(wrPhoto(p))}" alt="" onerror="this.remove()"></span>` : "";
  function wrRoadSvg(road, cut, th) {
    const n = road.length, W = 320, H = 170, padX = 14, padY = 16, maxR = L.size;
    const x = i => padX + i * (W - padX * 2) / Math.max(1, n - 1), y = r => padY + (r - 1) * (H - padY * 2) / Math.max(1, maxR - 1);
    const pts = road.map((p, i) => `${x(i).toFixed(1)},${y(p.r).toFixed(1)}`).join(" ");
    const cy = (y(cut) + y(cut + 1)) / 2;
    return `<svg class="wr-road" viewBox="0 0 ${W} ${H}" role="img" aria-label="Your place in the standings after each week">
      ${cut && cut < maxR ? `<line x1="0" x2="${W}" y1="${cy}" y2="${cy}" class="wr-cut"/><text x="${W - 2}" y="${cy - 5}" text-anchor="end" class="wr-cut-t">playoff line</text>` : ""}
      <polyline points="${pts}" class="wr-path" pathLength="1"/>
      ${road.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.r).toFixed(1)}" r="${i === n - 1 ? 7 : 5}" class="wr-dot ${p.res}" style="--d:${(0.5 + i * 0.06).toFixed(2)}s"/>`).join("")}
      <text x="${x(n - 1).toFixed(1)}" y="${(y(road[n - 1].r) + (road[n - 1].r > maxR / 2 ? -14 : 24)).toFixed(1)}" text-anchor="end" class="wr-road-t">${ordinal(road[n - 1].r)}</text>
    </svg>`;
  }
  function wrSlideHtml(s, idx) {
    const th = WR_THEMES[s.theme] || WR_THEMES.brand;
    const style = `--wr-bg:${th.bg};--wr-ink:${th.ink};--wr-ink2:${th.ink2};--wr-hi:${th.hi};--wr-sh:${th.sh}`;
    const long = String(s.big).length > 18, d = k => `style="--d:${k}s"`;
    let body = "";
    if (s.cover) {
      body = `<div class="wr-a wr-cover-logo" ${d(0.1)}>${logoImg(s.logo, s.big, "wr-lg")}</div>
        <p class="wr-a wr-kicker" ${d(0.3)}>${esc(s.kicker)}</p><p class="wr-a wr-big${long ? " long" : ""}" ${d(0.45)}>${esc(s.big)}</p><p class="wr-a wr-line" ${d(0.7)}>${esc(s.line)}</p>
        <p class="wr-a wr-hint" ${d(1.4)}>Tap to start ›</p>`;
    } else if (s.slider) {
      const g = s.answered != null ? s.answered : s.slider.start;
      body = `<p class="wr-a wr-kicker" ${d(0.1)}>${esc(s.kicker)}</p><p class="wr-a wr-big long" ${d(0.25)}>${esc(s.big)}</p>
        <div class="wr-a wr-slider${s.answered != null ? " done" : ""}" ${d(0.45)}>
          <output class="wr-guess-v">${g}</output>
          <input type="range" min="${s.slider.min}" max="${s.slider.max}" step="${s.slider.step}" value="${g}" aria-label="Your guess"${s.answered != null ? " disabled" : ""}>
          <div class="wr-slider-ends"><span>${s.slider.min}</span><span>${s.slider.max}</span></div>
          ${s.answered != null ? "" : `<button type="button" class="wr-lock" data-wr-lock>Lock it in</button>`}
        </div>
        <p class="wr-line wr-reveal"${s.answered != null ? "" : " hidden"}>${s.answered != null ? esc(wrVerdict(s)) : ""}</p>
        <div class="wr-reveal-stats"${s.answered != null ? "" : " hidden"}>${wrTiles(s.stats, 0.1)}</div>`;
    } else if (s.quiz) {
      body = `<p class="wr-a wr-kicker" ${d(0.1)}>${esc(s.kicker)}</p><p class="wr-a wr-big long" ${d(0.25)}>${esc(s.big)}</p>
        <div class="wr-quiz${s.quiz.duel ? " duel" : ""}${s.answered ? " done" : ""}">${s.quiz.options.map((p, k) => `<button type="button" class="wr-a wr-opt${s.answered ? (p.id === s.quiz.answer ? " right" : p.id === s.answered ? " wrong" : " dim") : ""}" data-wr-guess="${p.id}" ${d((0.45 + k * 0.1).toFixed(2))}>${wrFace(p)}<span>${esc(p.name)}</span></button>`).join("")}</div>
        <p class="wr-line wr-reveal"${s.answered ? "" : " hidden"}>${s.answered === s.quiz.answer ? "Nailed it. " : s.answered ? "Not quite. " : ""}${esc(s.reveal)}</p>
        <div class="wr-reveal-stats"${s.answered ? "" : " hidden"}>${s.stats ? wrTiles(s.stats, 0.1) : ""}</div>`;
    } else if (s.top5) {
      body = `<p class="wr-a wr-kicker" ${d(0.1)}>${esc(s.kicker)}</p><p class="wr-a wr-big" ${d(0.25)}>${esc(s.big)}</p>
        <ol class="wr-top5">${s.top5.map((p, k) => `<li class="wr-a${k === 0 ? " first" : ""}" ${d((0.5 + k * 0.18).toFixed(2))}><span class="wr-rank">${k + 1}</span>${wrFace(p)}<span class="wr-pn"><b>${esc(p.name)}</b><span>${esc(p.pos)} · ${p.share}% of your points · ${(p.pts / Math.max(1, p.starts)).toFixed(1)}/start</span></span><span class="wr-pp">${Math.round(p.pts)}</span></li>`).join("")}</ol>`;
    } else if (s.card) {
      body = `<div class="wr-a wr-card" ${d(0.1)}><div class="wr-card-h">${logoImg(s.logo, s.big, "wr-card-logo")}<div><p class="wr-kicker">${esc(s.kicker)}</p><p class="wr-card-name">${esc(s.big)}</p></div></div>
        ${s.card.mvp ? `<div class="wr-card-mvp">${wrFace(s.face, "lg")}<div><span>MVP</span><b>${esc(s.card.mvp[0])}</b><span>${esc(s.card.mvp[1])}</span></div></div>` : ""}
        <div class="wr-tiles">${s.card.tiles.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}</div>
        <p class="wr-site">${esc(SITE_URL)}</p></div>`;
    } else if (s.rivals) {
      body = `<p class="wr-a wr-kicker" ${d(0.1)}>${esc(s.kicker)}</p>
        <div class="wr-rivals">${s.rivals.map((r, k) => `<div class="wr-a wr-rival" ${d((0.3 + k * 0.35).toFixed(2))}><span class="wr-emoji sm">${r.emoji}</span><p class="wr-kicker">${esc(r.label)}</p><p class="wr-big long">${esc(r.name)}</p><p class="wr-line">${esc(r.rec)}${r.yr ? ` · ${esc(r.yr)}` : ""}</p>${r.avg ? `<p class="wr-sub">${esc(r.avg)}</p>` : ""}</div>`).join("")}</div>`;
    } else {
      const num = s.count != null ? ` data-count="${s.count}" data-dec="${String(s.big).includes(".") ? String(s.big).split(".")[1].length : 0}"` : "";
      body = `${s.emoji ? `<span class="wr-a wr-emoji" ${d(0.05)}>${s.emoji}</span>` : ""}${s.face && !s.card ? `<div class="wr-a" ${d(0.05)}>${wrFace(s.face, "hero")}</div>` : ""}
        ${s.logo && !s.cover ? `<div class="wr-a" ${d(0.05)}>${logoImg(s.logo, s.big, "wr-lg")}</div>` : ""}
        <p class="wr-a wr-kicker" ${d(0.15)}>${esc(s.kicker)}</p>
        <p class="wr-a wr-big${long ? " long" : ""}" ${d(0.3)}${num}>${esc(s.big)}</p>
        ${s.line ? `<p class="wr-a wr-line" ${d(0.55)}>${esc(s.line)}</p>` : ""}${s.sub ? `<p class="wr-a wr-sub" ${d(0.7)}>${esc(s.sub)}</p>` : ""}
        ${s.chips ? `<div class="wr-chips">${s.chips.map((c, k) => `<span class="wr-a" ${d((0.6 + k * 0.15).toFixed(2))}>${esc(c)}</span>`).join("")}</div>` : ""}
        ${s.road ? `<div class="wr-a" ${d(0.45)}>${wrRoadSvg(s.road, s.cut, th)}</div>` : ""}
        ${s.rooms ? `<div class="wr-rooms">${s.rooms.map((r, k) => `<div class="wr-a wr-room${r.rank <= 3 ? " good" : r.rank >= L.size - 2 ? " bad" : ""}" ${d((0.5 + k * 0.1).toFixed(2))}><span class="wr-room-k">${esc(r.k)}</span><span class="wr-room-bar"><i style="width:${Math.max(4, 100 * r.v / Math.max(1, r.max)).toFixed(0)}%;--d:${(0.7 + k * 0.1).toFixed(2)}s"></i></span><span class="wr-room-r">#${r.rank}</span></div>`).join("")}</div>` : ""}
        ${s.bars ? (() => { const mx = Math.max(...s.bars.map(b => b.v), 1); return `<div class="wr-bars-v" aria-hidden="true">${s.bars.map((b, k) => `<span class="wr-bar${b.hi ? " hi" : ""}${b.lo ? " lo" : ""}" style="height:${Math.max(6, 100 * b.v / mx).toFixed(0)}%;--d:${(0.6 + k * 0.04).toFixed(2)}s"></span>`).join("")}</div>${s.low ? `<p class="wr-a wr-sub" ${d(1.3)}>${esc(s.low)}</p>` : ""}`; })() : ""}
        ${s.stats && s.stats.length ? wrTiles(s.stats, 0.95) : ""}
        ${s.list ? `<ul class="wr-list">${s.list.map(([e, x], k) => `<li class="wr-a" ${d((0.5 + k * 0.18).toFixed(2))}><span>${e}</span>${esc(x)}</li>`).join("")}</ul>` : ""}`;
    }
    const deco = `<div class="wr-deco p${idx % 4}" aria-hidden="true"><i></i><i></i><i></i></div>`;
    const confetti = s.confetti ? `<div class="wr-confetti" aria-hidden="true">${Array.from({ length: 36 }, (_, k) => `<i style="left:${(k * 37) % 100}%;--c:${["#2bc47b", "#d9482a", "#1f4fd1", "#ffffff", "#5b2368"][k % 5]};--t:${(1.6 + (k % 7) * 0.25).toFixed(2)}s;--dl:${((k % 9) * 0.12).toFixed(2)}s;--r:${(k * 47) % 360}deg"></i>`).join("")}</div>` : "";
    return `<div class="wr-slide k-${s.key}${s.cover ? " cover" : ""}${s.slider && s.answered != null ? " revealed" : ""}" style="${style}">${deco}${confetti}<div class="wr-body">${body}</div></div>`;
  }
  const wrVerdict = s => { const off = Math.abs(s.answered - s.slider.answer), pct = off / Math.max(1, s.slider.answer);
    return `You said ${s.answered}. ${pct <= 0.05 ? "Spot on." : pct <= 0.15 ? `Close: off by ${Math.round(off)}.` : `Off by ${Math.round(off)}.`} ${s.reveal}`; };
  const wrTiles = (stats, d0) => `<div class="wr-stats">${stats.slice(0, 4).map(([v, k], i) => `<div class="wr-a" style="--d:${(d0 + i * 0.12).toFixed(2)}s"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join("")}</div>`;
  // numbers count up when their slide appears
  function wrCount(el) {
    const n = el.querySelector("[data-count]");
    if (!n || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = Number(n.dataset.count), dec = Number(n.dataset.dec || 0), t0 = performance.now(), dur = 1100, delay = 300;
    const step = now => {
      if (!document.body.contains(n)) return;
      const k = Math.min(1, Math.max(0, (now - t0 - delay) / dur)), e = 1 - Math.pow(1 - k, 3);
      n.textContent = (to * e).toFixed(dec);
      if (k < 1) requestAnimationFrame(step);
    };
    n.textContent = (0).toFixed(dec);
    requestAnimationFrame(step);
  }

  // ---- the story viewer
  const wrWaiting = () => { const s = WR.slides[WR.i]; return !!(s && ((s.quiz && !s.answered) || (s.slider && s.answered == null))); };
  function wrLock() {
    const s = WR.slides[WR.i], box = WR.el && WR.el.querySelector(".wr-stage");
    if (!s || !s.slider || s.answered != null || !box) return;
    s.answered = Number(box.querySelector(".wr-slider input").value);
    box.querySelector(".wr-slider").classList.add("done");
    box.querySelector(".wr-slide").classList.add("revealed");
    box.querySelector(".wr-slider input").disabled = true;
    const lk = box.querySelector("[data-wr-lock]"); if (lk) lk.remove();
    const rv = box.querySelector(".wr-reveal"); rv.textContent = wrVerdict(s); rv.hidden = false;
    box.querySelector(".wr-reveal-stats").hidden = false;
    WR.start = performance.now() - WR_MS * 0.1;
  }
  function wrShow(i) {
    WR.i = Math.max(0, Math.min(WR.slides.length - 1, i));
    WR.start = performance.now(); WR.pauseAt = 0;
    const s = WR.slides[WR.i], box = WR.el.querySelector(".wr-stage");
    box.innerHTML = wrSlideHtml(s, WR.i);
    wrCount(box);
    WR.el.querySelector(".wr-story").classList.toggle("light", WR_LIGHT.includes(s.theme));
    WR.el.querySelectorAll(".wr-prog i").forEach((b, k) => { b.style.width = k < WR.i ? "100%" : "0%"; });
    WR.el.querySelector(".wr-end").hidden = WR.i !== WR.slides.length - 1;
    WR.el.querySelector(".wr-count").textContent = `${WR.i + 1} / ${WR.slides.length}`;
  }
  function wrTick(now) {
    if (!WR.el) return;
    const paused = WR.paused || wrWaiting() || !!document.querySelector(".share-modal") || document.hidden;
    if (paused) { if (!WR.pauseAt) WR.pauseAt = now; }
    else if (WR.pauseAt) { WR.start += now - WR.pauseAt; WR.pauseAt = 0; }
    const t = paused ? WR.pauseAt - WR.start : now - WR.start;
    const last = WR.i === WR.slides.length - 1;
    const bar = WR.el.querySelectorAll(".wr-prog i")[WR.i];
    if (bar) bar.style.width = Math.min(100, 100 * t / WR_MS).toFixed(1) + "%";
    if (!paused && t >= WR_MS && !last) wrShow(WR.i + 1);
    WR.raf = requestAnimationFrame(wrTick);
  }
  function wrClose() {
    if (!WR.el) return;
    cancelAnimationFrame(WR.raf);
    WR.el.remove(); WR.el = null;
    document.documentElement.classList.remove("wr-open");
    document.removeEventListener("keydown", wrKey);
    if (state.params.has("play")) { const p = new URLSearchParams(state.params); p.delete("play"); state.params = p; history.replaceState(null, "", "#/history/wrapped" + (p.toString() ? "?" + p : "")); }
  }
  function wrKey(e) {
    if (document.querySelector(".share-modal") || (e.target && e.target.type === "range")) return;
    if (e.key === "Escape") wrClose();
    else if (e.key === "ArrowRight") wrShow(WR.i + 1);
    else if (e.key === "ArrowLeft") wrShow(WR.i - 1);
    else if (e.key === " ") { e.preventDefault(); WR.paused = !WR.paused; }
  }
  function wrGuess(id) {
    const s = WR.slides[WR.i];
    if (!s || !s.quiz || s.answered) return;
    s.answered = id;
    const box = WR.el.querySelector(".wr-stage");
    box.querySelectorAll(".wr-opt").forEach(b => { const v = Number(b.dataset.wrGuess); b.classList.add(v === s.quiz.answer ? "right" : v === id ? "wrong" : "dim"); });
    box.querySelector(".wr-quiz").classList.add("done");
    const rv = box.querySelector(".wr-reveal");
    rv.textContent = (id === s.quiz.answer ? "Nailed it. " : "Not quite. ") + s.reveal;
    rv.hidden = false;
    const rs = box.querySelector(".wr-reveal-stats");
    if (rs) rs.hidden = false;
    WR.start = performance.now() - WR_MS * 0.35; // a few seconds to take in the answer, then on
  }
  function wrOpen(t, slides) {
    wrClose();
    WR.slides = slides; WR.paused = false; WR.pauseAt = 0; WR.team = t;
    const el = document.createElement("div");
    el.className = "wr-overlay";
    el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", `${t.name}: League Wrapped ${L.season}`);
    el.innerHTML = `<div class="wr-story">
      <div class="wr-prog">${slides.map(() => "<span><i></i></span>").join("")}</div>
      <div class="wr-top"><span class="wr-who">${logo(t)}<b>${esc(t.name)}</b><span class="wr-count"></span></span>
        <button type="button" class="share-btn wr-ic" data-share="wrapped" aria-label="Share this slide">${SHARE_ICON}</button>
        <button type="button" class="wr-ic wr-x" aria-label="Close">✕</button></div>
      <div class="wr-stage" aria-live="polite"></div>
      <button type="button" class="wr-tap prev" aria-label="Previous slide"></button><button type="button" class="wr-tap next" aria-label="Next slide"></button>
      <div class="wr-end" hidden><button type="button" class="cta share-btn" data-share="wrapped">${SHARE_ICON}Share my card</button><button type="button" class="cta alt" data-wr="replay">Watch again</button><button type="button" class="linkbtn" data-wr="close">Close</button></div>
    </div>`;
    document.body.appendChild(el);
    WR.el = el;
    document.documentElement.classList.add("wr-open");
    document.addEventListener("keydown", wrKey);
    const story = el.querySelector(".wr-story");
    story.addEventListener("pointerdown", e => {
      if (e.target.closest("button:not(.wr-tap), input, .wr-slider")) return;
      WR.holdT = setTimeout(() => { WR.paused = true; WR.holding = true; }, 220);
    });
    const up = () => { clearTimeout(WR.holdT); if (WR.holding) { WR.holding = false; WR.paused = false; WR.suppress = true; } };
    story.addEventListener("pointerup", up); story.addEventListener("pointercancel", up); story.addEventListener("pointerleave", up);
    el.addEventListener("click", e => {
      if (WR.suppress) { WR.suppress = false; if (e.target.closest(".wr-tap")) return; }
      const g = e.target.closest("[data-wr-guess]");
      if (g) return wrGuess(Number(g.dataset.wrGuess));
      if (e.target.closest("[data-wr-lock]")) return wrLock();
      if (e.target.closest(".wr-slider")) return;
      if (e.target === el || e.target.closest(".wr-x") || e.target.closest('[data-wr="close"]')) return wrClose();
      if (e.target.closest('[data-wr="replay"]')) { WR.slides.forEach(s => { delete s.answered; }); return wrShow(0); }
      if (e.target.closest(".wr-tap.next")) return WR.i === WR.slides.length - 1 ? null : wrShow(WR.i + 1);
      if (e.target.closest(".wr-tap.prev")) return wrShow(WR.i - 1);
    });
    el.addEventListener("input", e => { if (e.target.type === "range") { const o = el.querySelector(".wr-guess-v"); if (o) o.textContent = e.target.value; } });
    wrShow(0);
    WR.raf = requestAnimationFrame(wrTick);
    const x = el.querySelector(".wr-x");
    if (x) x.focus({ preventScroll: true });
  }
  async function wrPlay(teamId, btn) {
    const t = teamById[teamId];
    if (!t || !wrReady()) return;
    if (btn) { btn.disabled = true; btn.dataset.label = btn.innerHTML; btn.textContent = "Loading…"; }
    const [P, M, ST] = await Promise.all([loadPlayers().catch(() => null), loadMoves(L.season).catch(() => null), loadStats(L.season).catch(() => null)]);
    if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset.label; }
    if (state.tab !== "history" || state.sub !== "wrapped") return;
    wrOpen(t, wrSlides(t, P, M, ST));
  }

  // ---- share: the slide on screen as a 1080x1350 image in its own colors (photos included; ESPN serves them openly)
  function wrShareSpec() {
    const s = WR.slides[WR.i], t = WR.team;
    if (!s || !t) return null;
    return { slide: s, file: `${L.season}-wrapped-${t.name}-${s.key}`, title: `${s.kicker}: ${s.big}`, team: t };
  }
  function wrImg(src) {
    return new Promise(res => {
      if (!src) return res(null);
      const im = new Image();
      im.crossOrigin = "anonymous";
      im.onload = () => res(im); im.onerror = () => res(null);
      im.src = src;
      setTimeout(() => res(null), 5000);
    });
  }
  async function drawSlide(spec) {
    try { await Promise.all(["900 40px Archivo", "800 40px Archivo", "600 20px Inter", "700 20px Inter"].map(f => document.fonts.load(f))); } catch (_) { /* system fonts */ }
    let s = spec.slide;
    if (s.quiz) s = { key: s.key, theme: s.theme, kicker: s.quiz.duel ? "This or that" : "Your MVP", big: s.face.name, line: s.reveal, face: s.face };
    else if (s.slider) s = { key: s.key, theme: s.theme, kicker: "Points left on your bench", big: Number(s.slider.answer).toFixed(1), line: s.answered != null ? wrVerdict(s) : s.reveal, emoji: "🪑" };
    const th = WR_THEMES[s.theme] || WR_THEMES.brand, W = 1080, H = 1350, PAD = 84;
    const hasTiles = !!(((spec.slide.quiz || spec.slide.slider ? spec.slide.stats : s.stats) || []).length), bottom = hasTiles ? H - 330 : H - 170;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    const font = (w, px, fam) => `${w} ${px}px ${fam === "a" ? "Archivo, Inter, sans-serif" : "Inter, system-ui, sans-serif"}`;
    const wrapAt = (text, x, max, lh, y, f) => {
      c.font = f; const words = String(text).split(/\s+/); let line = "", yy = y;
      for (const w of words) { const t2 = line ? line + " " + w : w; if (c.measureText(t2).width > max && line) { c.fillText(line, x, yy); line = w; yy += lh; } else line = t2; }
      if (line) c.fillText(line, x, yy);
      return yy + lh;
    };
    const wrap = (text, max, lh, y, f) => wrapAt(text, PAD, max, lh, y, f);
    const circle = (x, y, r, fill) => { c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = fill; c.fill(); };
    const face = async (p, cx, cy, r) => {
      circle(cx, cy, r + 8, th.hi); circle(cx, cy, r, th.sh);
      const im = p ? await wrImg(wrPhoto(p)) : null;
      c.save(); c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.clip();
      if (im) { const sc = Math.max(2 * r / im.width, 2 * r / im.height) * 1.05; const w = im.width * sc, h = im.height * sc; c.drawImage(im, cx - w / 2, cy - r * 1.02, w, h); }
      else if (p) { c.fillStyle = th.ink; c.font = font(900, r * 0.7, "a"); c.textAlign = "center"; c.fillText(initials(p.name), cx, cy + r * 0.25); c.textAlign = "left"; }
      c.restore();
    };
    // background and shapes
    c.fillStyle = th.bg; c.fillRect(0, 0, W, H);
    c.globalAlpha = 0.9; circle(W - 60, 140, 260, th.sh); circle(80, H - 120, 200, th.sh); c.globalAlpha = 1;
    c.strokeStyle = th.hi; c.lineWidth = 14; c.globalAlpha = 0.35; c.beginPath(); c.arc(-30, 330, 110, 0, Math.PI * 2); c.stroke(); c.globalAlpha = 1;
    c.fillStyle = th.ink2; c.font = font(800, 26); c.textBaseline = "alphabetic";
    c.fillText(("League HQ · " + IDX.name).toUpperCase().slice(0, 56), PAD, 100);
    let y = 210;
    if (s.card) {
      const lgo = await wrImg(s.logo ? new URL(s.logo, location.href).href : "");
      if (lgo) { c.save(); c.beginPath(); c.arc(PAD + 60, y + 40, 60, 0, Math.PI * 2); c.clip(); c.drawImage(lgo, PAD, y - 20, 120, 120); c.restore(); }
      c.fillStyle = th.hi; c.font = font(800, 30); c.fillText(String(s.kicker).toUpperCase(), PAD + (lgo ? 150 : 0), y + 22);
      c.fillStyle = th.ink; c.font = font(900, 58, "a"); let nm = String(s.big); while (c.measureText(nm).width > W - PAD * 2 - 150 && nm.length > 3) nm = nm.slice(0, -2) + "…"; c.fillText(nm, PAD + (lgo ? 150 : 0), y + 86);
      y += 180;
      if (s.card.mvp) { await face(s.face, PAD + 90, y + 90, 90); c.fillStyle = th.ink2; c.font = font(800, 28); c.fillText("MVP", PAD + 220, y + 60); c.fillStyle = th.ink; c.font = font(900, 54, "a"); c.fillText(s.card.mvp[0].slice(0, 22), PAD + 220, y + 120); c.fillStyle = th.ink2; c.font = font(700, 30); c.fillText(s.card.mvp[1], PAD + 220, y + 162); y += 240; }
      const tiles = s.card.tiles, tw = (W - PAD * 2 - 24) / 2, thh = 150;
      tiles.forEach(([k, v], i) => {
        const x = PAD + (i % 2) * (tw + 24), yy = y + Math.floor(i / 2) * (thh + 20);
        c.fillStyle = th.sh; c.beginPath(); c.roundRect ? c.roundRect(x, yy, tw, thh, 24) : c.rect(x, yy, tw, thh); c.fill();
        c.fillStyle = th.ink2; c.font = font(800, 26); c.fillText(k.toUpperCase(), x + 28, yy + 52);
        c.fillStyle = th.ink; let val = String(v), sz = 52; c.font = font(900, sz, "a"); while (c.measureText(val).width > tw - 56 && sz > 28) { sz -= 4; c.font = font(900, sz, "a"); } c.fillText(val, x + 28, yy + 118);
      });
    } else {
      if (s.face) { await face(s.face, W - PAD - 150, 330, 150); }
      else if (s.emoji) { c.font = font(400, 170); c.fillText(s.emoji, W - PAD - 190, 360); }
      c.fillStyle = th.hi; c.font = font(800, 34);
      c.fillText(String(s.kicker).toUpperCase(), PAD, y + 60);
      const maxW = s.face || s.emoji ? W - PAD * 2 - 330 : W - PAD * 2;
      c.fillStyle = th.ink;
      let size = 150, lines;
      const words = String(s.big).split(" ");
      for (; size > 50; size -= 6) {
        c.font = font(900, size, "a"); lines = [""];
        for (const w of words) { const t2 = lines[lines.length - 1] ? lines[lines.length - 1] + " " + w : w; if (c.measureText(t2).width > (lines.length === 1 ? maxW : W - PAD * 2) && lines[lines.length - 1]) lines.push(w); else lines[lines.length - 1] = t2; }
        if (lines.length <= 3 && lines.every((l, k) => c.measureText(l).width <= (k === 0 ? maxW : W - PAD * 2))) break;
      }
      y += 60 + size;
      lines.forEach(l => { c.fillText(l, PAD, y); y += size * 1.02; });
      y = Math.max(y, s.face || s.emoji ? 520 : 0);
      if (s.line) { c.fillStyle = th.ink; y = wrap(s.line, W - PAD * 2, 54, y + 30, font(600, 40)); }
      if (s.sub) { c.fillStyle = th.ink2; y = wrap(s.sub, W - PAD * 2, 44, y + 4, font(600, 32)); }
      y += 24;
      if (s.top5) {
        for (const [k, p] of s.top5.entries()) {
          c.fillStyle = th.hi; c.font = font(900, 64, "a"); c.fillText(String(k + 1), PAD, y + 70);
          await face(p, PAD + 150, y + 46, 46);
          c.fillStyle = th.ink; c.font = font(800, 40); c.fillText(p.name.slice(0, 22), PAD + 220, y + 44);
          c.fillStyle = th.ink2; c.font = font(600, 28); c.fillText(`${p.pos} · ${p.share}% of your points`, PAD + 220, y + 84);
          c.fillStyle = th.ink; c.font = font(900, 50, "a"); c.textAlign = "right"; c.fillText(String(Math.round(p.pts)), W - PAD, y + 66); c.textAlign = "left";
          y += 132;
        }
      }
      if (s.road) {
        const n = s.road.length, x0 = PAD, x1 = W - PAD, y0 = y + 20, y1 = Math.min(bottom, y0 + 420), maxR = L.size;
        const X = i => x0 + i * (x1 - x0) / Math.max(1, n - 1), Y = r => y0 + (r - 1) * (y1 - y0) / Math.max(1, maxR - 1);
        if (s.cut && s.cut < maxR) { const cy = (Y(s.cut) + Y(s.cut + 1)) / 2; c.setLineDash([14, 12]); c.strokeStyle = th.ink2; c.lineWidth = 3; c.beginPath(); c.moveTo(x0, cy); c.lineTo(x1, cy); c.stroke(); c.setLineDash([]); c.fillStyle = th.ink2; c.font = font(700, 24); c.textAlign = "right"; c.fillText("PLAYOFF LINE", x1, cy - 10); c.textAlign = "left"; }
        c.strokeStyle = th.ink; c.lineWidth = 7; c.lineJoin = "round"; c.beginPath(); s.road.forEach((p, i) => (i ? c.lineTo(X(i), Y(p.r)) : c.moveTo(X(i), Y(p.r)))); c.stroke();
        s.road.forEach((p, i) => circle(X(i), Y(p.r), i === n - 1 ? 18 : 13, p.res === "W" ? "#1f9d60" : p.res === "L" ? "#d9482a" : "#9aa3a0"));
      }
      if (s.bars) {
        const mx = Math.max(...s.bars.map(b => b.v), 1), n = s.bars.length, gap = 10, bw = (W - PAD * 2 - gap * (n - 1)) / n, bh = Math.max(120, bottom - 20 - y);
        s.bars.forEach((b, k) => { const h = Math.max(8, bh * b.v / mx); c.fillStyle = b.hi ? th.hi : b.lo ? th.ink : th.ink2; c.globalAlpha = b.hi || b.lo ? 1 : 0.45; c.fillRect(PAD + k * (bw + gap), y + bh - h, bw, h); c.globalAlpha = 1; });
      }
      if (s.rooms) {
        s.rooms.forEach(r => {
          c.fillStyle = th.ink; c.font = font(900, 36, "a"); c.fillText(r.k, PAD, y + 42);
          const bx = PAD + 150, bw = W - PAD * 2 - 150 - 110;
          c.fillStyle = th.sh; c.fillRect(bx, y + 16, bw, 28);
          c.fillStyle = r.rank <= 3 ? th.hi : r.rank >= L.size - 2 ? "#d9482a" : th.ink2; c.fillRect(bx, y + 16, Math.max(8, bw * r.v / Math.max(1, r.max)), 28);
          c.fillStyle = th.ink; c.font = font(900, 40, "a"); c.textAlign = "right"; c.fillText("#" + r.rank, W - PAD, y + 44); c.textAlign = "left";
          y += 54;
        });
      }
      if (s.chips) { s.chips.forEach(x => { c.fillStyle = th.ink; y = wrap("• " + x, W - PAD * 2, 50, y + 14, font(700, 38)); }); }
      if (s.list) { s.list.forEach(([e, x]) => { c.fillStyle = th.ink; y = wrap(`${e}  ${x}`, W - PAD * 2, 50, y + 14, font(700, 38)); }); }
      if (s.rivals) {
        s.rivals.forEach(r => {
          c.fillStyle = th.ink2; c.font = font(800, 30); c.fillText(`${r.emoji}  ${r.label.toUpperCase()}`, PAD, y + 40);
          c.fillStyle = th.ink; c.font = font(900, 74, "a"); c.fillText(r.name.slice(0, 20), PAD, y + 124);
          c.fillStyle = th.ink2; c.font = font(700, 34); c.fillText(`${r.rec}${r.yr ? " · " + r.yr : ""}`, PAD, y + 176);
          y += 240;
        });
      }
    }
    const tiles = (spec.slide.quiz || spec.slide.slider ? spec.slide.stats : s.stats) || [];
    if (!s.card && tiles.length) {
      const n = Math.min(4, tiles.length), gap = 18, tw = (W - PAD * 2 - gap * (n - 1)) / n, ty = H - 300;
      tiles.slice(0, n).forEach(([v, k], i) => {
        const x = PAD + i * (tw + gap);
        c.fillStyle = th.sh; c.beginPath(); c.roundRect ? c.roundRect(x, ty, tw, 170, 22) : c.rect(x, ty, tw, 170); c.fill();
        c.fillStyle = th.ink; let sz = 56; c.font = font(900, sz, "a"); while (c.measureText(String(v)).width > tw - 36 && sz > 26) { sz -= 4; c.font = font(900, sz, "a"); }
        c.fillText(String(v), x + 18, ty + 72);
        c.fillStyle = th.ink2; wrapAt(k, x + 18, tw - 36, 30, ty + 112, font(700, 24));
      });
    }
    c.fillStyle = th.ink2; c.font = font(700, 28);
    c.fillText(`${spec.team.name} · ${L.season}`.slice(0, 44), PAD, H - 70);
    c.textAlign = "right"; c.fillText(SITE_URL, W - PAD, H - 70); c.textAlign = "left";
    return new Promise(res => cv.toBlob(res, "image/png"));
  }

  // the Wrapped page: pick a season and a team (yours first)
  function wrappedPage() {
    const yrs = IDX.seasons.filter(y => y !== IDX.current || (state.season === IDX.current && L.over)).sort((a, b) => b - a);
    const picker = yrs.length ? `<nav class="yb-pick" aria-label="Wrapped seasons">${yrs.map(y => `<a href="${wrLink(y)}"${y === state.season ? ' class="active" aria-current="page"' : ""}>${y}</a>`).join("")}</nav>` : "";
    if (!wrReady()) return `<div class="panel wr-soon"><p><b>Your ${L.season} Wrapped arrives the day the championship is decided.</b> Your season as a story: your road through the standings, how it ended, your top 5, your peak, the one that got away, your rivals and more.${yrs.length ? " Until then, relive a past season:" : ""}</p>${picker}</div>`;
    const me = D.teams.find(isMine);
    const order = D.teams.slice().sort((a, b) => (isMine(b) - isMine(a)) || (a.finalRank || 99) - (b.finalRank || 99));
    const hero = me ? `<div class="wr-hero" style="--wr-bg:${WR_THEMES.night.bg};--wr-hi:${WR_THEMES.night.hi}"><div class="wr-hero-in">${logo(me)}<div><p class="wr-hero-k">${L.season} League Wrapped</p><h2>${esc(me.name)}</h2><p>${finishText(me.finalRank)} · ${record(me)}</p></div></div><button type="button" class="cta" data-wr-play="${me.id}">▶ Watch yours</button></div>`
      : `<p class="note">Claim your team on My team and yours shows up first. Or pick any team below.</p>`;
    setTimeout(() => { const pl = Number(state.params.get("play")); const id = pl || (state.params.get("play") === "me" && me ? me.id : 0); if (id && teamById[id] && !WR.el) wrPlay(id); }, 0);
    return section(`${L.season} League Wrapped`, { short: "Every manager's season as a story. Tap through, then share your card.", full: "Built from the season's box scores, every player's time on each team, ESPN's log of every move, and the league's history. Each story picks the slides worth showing for that team. Tap the right side to go on, the left to go back, hold to pause; every slide can be saved or shared as an image." },
      `<div class="yb-bar">${picker}</div>${hero}<div class="wr-teams">${order.map(t => `<button type="button" class="wr-team${isMine(t) ? " mine" : ""}${t.finalRank === 1 ? " champ" : ""}" data-wr-play="${t.id}">${logo(t)}<span><b>${esc(t.name)}</b><span class="team-mgr">${esc(t.manager)} · ${finishText(t.finalRank)}${t.finalRank === 1 ? " 🏆" : ""}</span></span><span class="wr-go" aria-hidden="true">▶</span></button>`).join("")}</div>`);
  }
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-wr-play]");
    if (!b) return;
    wrPlay(Number(b.dataset.wrPlay), b);
  });

  const HISTORY = {
    wrapped() { return wrappedPage(); },
    players() {
      const pid = state.params.get("player") || "";
      setTimeout(() => fillPlayerHistory(main.querySelector(".ph-box"), pid), 0);
      return section("Player history", { short: "Every league team a player has been on, all seasons.", full: "Pick any player who has been on a league roster: every team that had him in any season, how he got there (drafted with the pick, traded for, picked up), when he left (dropped, traded away) and the points he scored in that team's starting lineup (bench points shown separately). Covers every season." },
        `<label class="field ph-pick">Player <input id="ph-search" list="ph-list" type="search" placeholder="Type a name" autocomplete="off"></label><datalist id="ph-list"></datalist><div class="ph-box"><div class="empty">Loading…</div></div>`);
    },
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
          `<div class="table-wrap"><table class="tbl members"><thead><tr><th>Manager</th><th class="n">Seasons</th><th class="n">Record</th><th class="n">Win %</th><th class="n">Pts/game</th><th class="n">Titles</th><th class="n">Finals</th><th class="n">Playoffs</th><th class="n">Best</th></tr></thead><tbody>${rows}</tbody></table></div>`) +
        careerLuckSection(H);
    },

    // Tale of the tape: two owners side by side across every season, plus their head-to-head series
    h2h(H) {
      const m = H.members, active = m.filter(x => x.active);
      const has = id => m.some(x => x.id === id);
      if (has(state.params.get("a"))) state.h2hA = state.params.get("a");
      if (has(state.params.get("b"))) state.h2hB = state.params.get("b");
      if (!has(state.h2hA)) state.h2hA = (ME.member && has(ME.member) ? ME.member : (active[0] || m[0]).id);
      if (!has(state.h2hB) || state.h2hB === state.h2hA) state.h2hB = tapeRival(H, state.h2hA);
      const opt = sel => m.map(x => `<option value="${esc(x.id)}"${x.id === sel ? " selected" : ""}>${esc(x.name)}${x.active ? "" : " (former)"}</option>`).join("");
      const A = m.find(x => x.id === state.h2hA), B = m.find(x => x.id === state.h2hB);
      const pick = `<div class="panel h2h"><div class="h2h-pick"><select id="h2h-a" aria-label="First manager">${opt(A.id)}</select><span class="muted">vs</span><select id="h2h-b" aria-label="Second manager">${opt(B.id)}</select>
        <button type="button" class="share-btn" data-share="tape">${SHARE_ICON}Share</button></div></div>`;
      if (A.id === B.id) return section("Tale of the tape", "", pick + '<p class="muted">Pick two different managers.</p>');
      setTimeout(() => tapeStreaks(A.id, B.id), 0);
      return section("Tale of the tape", { short: `${esc(A.name)} vs. ${esc(B.name)} across every season since ${IDX.seasons[IDX.seasons.length - 1]}.`,
          full: "Each row compares the two managers' whole league careers; the better number is highlighted, and the line on top counts the rows each one wins. Average finish and best season use completed seasons only (a season in progress shows its current standing in the season table). Win streaks are within one regular season. Head to head counts regular-season and winners-bracket playoff games." },
          pick + tapeHtml(H, A, B)) +
        section("Head to head", "", tapeSeries(H, A, B)) +
        section("Season by season", "Each season's team, record and finish.", tapeSeasons(A, B)) +
        section("Common opponents", "Each one's all-time record against everyone else they've both played.", tapeCommon(H, A, B));
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


  // ---------------------------------------------------------------- tale of the tape (History → Tale of the tape)
  const tapeGames = (H, a, b) => (H.h2h[a + "|" + b] || [0, 0, 0]).slice(0, 3).reduce((x, y) => x + y, 0);
  function tapeRival(H, a) {
    const others = H.members.filter(x => x.id !== a);
    const best = others.slice().sort((x, y) => tapeGames(H, a, y.id) - tapeGames(H, a, x.id) || (y.active - x.active))[0];
    return (best || H.members[0]).id;
  }
  const doneSeasons = x => x.seasons.filter(s => s.finish);
  function tapeStats(H, x) {
    const done = doneSeasons(x);
    const avgFinish = done.length ? done.reduce((n, s) => n + s.finish, 0) / done.length : null;
    const pct = s => (s.w + s.t / 2) / Math.max(1, s.w + s.l + s.t);
    const best = done.slice().sort((p, q) => p.finish - q.finish || pct(q) - pct(p) || q.season - p.season)[0] || null;
    const years = H.champions.filter(c => (c.owners || []).includes(x.id)).map(c => c.season).sort();
    const luck = (H.careerLuck || []).find(c => c.id === x.id);
    return { avgFinish, best, years, luck: luck ? luck.luck : null };
  }
  function tapeRows(H, A, B) {
    const a = tapeStats(H, A), b = tapeStats(H, B);
    const rec = x => `${x.w}–${x.l}${x.t ? "–" + x.t : ""}`;
    const bestTxt = s => s ? `${s.season}: ${finishText(s.finish)} <span class="muted">${s.w}–${s.l}${s.t ? "–" + s.t : ""}</span>` : "—";
    // [label, a html, b html, a number, b number, higher is better (null = no winner)]
    return [
      ["Seasons", A.seasons.length, B.seasons.length, null, null, null],
      ["Record", rec(A), rec(B), null, null, null],
      ["Win %", (A.pct * 100).toFixed(1) + "%", (B.pct * 100).toFixed(1) + "%", A.pct, B.pct, true],
      ["Championships", A.titles + (a.years.length ? ` <span class="muted">${a.years.join(", ")}</span>` : ""), B.titles + (b.years.length ? ` <span class="muted">${b.years.join(", ")}</span>` : ""), A.titles, B.titles, true],
      ["Finals", A.finals, B.finals, A.finals, B.finals, true],
      ["Playoff trips", A.playoffs, B.playoffs, A.playoffs, B.playoffs, true],
      ["Playoff record", `${A.playoffW}–${A.playoffL}`, `${B.playoffW}–${B.playoffL}`, null, null, null],
      ["Average finish", a.avgFinish != null ? a.avgFinish.toFixed(1) : "—", b.avgFinish != null ? b.avgFinish.toFixed(1) : "—", a.avgFinish, b.avgFinish, false],
      ["Best season", bestTxt(a.best), bestTxt(b.best), a.best ? a.best.finish : null, b.best ? b.best.finish : null, false],
      ["Longest win streak", '<span data-tape-streak="a">…</span>', '<span data-tape-streak="b">…</span>', null, null, true, "streak"],
      ["Points per game", A.ppg.toFixed(1), B.ppg.toFixed(1), A.ppg, B.ppg, true],
      ["Career luck", a.luck != null ? `${a.luck > 0 ? "+" : a.luck < 0 ? "−" : ""}${Math.abs(a.luck).toFixed(1)} W` : "—", b.luck != null ? `${b.luck > 0 ? "+" : b.luck < 0 ? "−" : ""}${Math.abs(b.luck).toFixed(1)} W` : "—", null, null, null],
    ];
  }
  const tapeWinner = (r) => {
    const [, , , x, y, hi] = r;
    if (hi == null || x == null || y == null || x === y) return 0;
    return (hi ? x > y : x < y) ? 1 : 2;
  };
  function tapeHtml(H, A, B) {
    const rows = tapeRows(H, A, B);
    const won = [0, 0, 0];
    rows.forEach(r => { won[tapeWinner(r)]++; });
    const verdict = won[1] === won[2] ? `Dead even on the tape, ${won[1]}–${won[2]}` : `${esc((won[1] > won[2] ? A : B).name)} leads the tape ${Math.max(won[1], won[2])}–${Math.min(won[1], won[2])}`;
    return `<p class="tape-verdict" data-tape-verdict data-a="${won[1]}" data-b="${won[2]}">${verdict}</p>
      <div class="tape" role="table" aria-label="${esc(A.name)} vs. ${esc(B.name)}">
        <div class="tape-row tape-head" role="row"><b role="columnheader">${esc(A.name)}</b><span role="columnheader"></span><b role="columnheader">${esc(B.name)}</b></div>
        ${rows.map(r => { const w = tapeWinner(r); return `<div class="tape-row"${r[6] ? ` data-tape-row="${r[6]}"` : ""} role="row"><span class="tape-v${w === 1 ? " win" : ""}" role="cell">${r[1]}</span><span class="tape-k" role="rowheader">${r[0]}</span><span class="tape-v${w === 2 ? " win" : ""}" role="cell">${r[2]}</span></div>`; }).join("")}
      </div>`;
  }
  // longest win streaks come from the record book file, loaded when the page opens
  async function tapeStreaks(a, b) {
    let all = null;
    try { all = await loadRecords(); } catch (_) { /* leave the dashes */ }
    const box = main.querySelector('[data-tape-row="streak"]');
    if (!box) return;
    const st = id => ((all && all[id] && all[id].streaks) || [])[0];
    const sa = st(a), sb = st(b);
    const txt = x => x ? `${x.len} <span class="muted">${x.season}, wks ${x.from}–${x.to}</span>` : "—";
    box.querySelector('[data-tape-streak="a"]').innerHTML = txt(sa);
    box.querySelector('[data-tape-streak="b"]').innerHTML = txt(sb);
    const la = sa ? sa.len : 0, lb = sb ? sb.len : 0;
    const cells = box.querySelectorAll(".tape-v");
    if (la !== lb) {
      cells[la > lb ? 0 : 1].classList.add("win");
      const v = main.querySelector("[data-tape-verdict]");
      if (v) {
        const wa = +v.dataset.a + (la > lb ? 1 : 0), wb = +v.dataset.b + (lb > la ? 1 : 0);
        v.dataset.a = wa; v.dataset.b = wb;
        v.textContent = wa === wb ? `Dead even on the tape, ${wa}–${wb}` : `${(wa > wb ? memberName(a) : memberName(b))} leads the tape ${Math.max(wa, wb)}–${Math.min(wa, wb)}`;
      }
    }
  }
  function tapeMeetings(H, A, B) {
    const flip = A.id > B.id;
    const list = H.meetings ? (H.meetings[flip ? B.id + "|" + A.id : A.id + "|" + B.id] || []) : null;
    return list && list.map(([season, week, x, y, po, game]) => ({ season, week, a: flip ? y : x, b: flip ? x : y, playoff: !!po, game }));
  }
  function tapeSeries(H, A, B) {
    const h = H.h2h[A.id + "|" + B.id];
    if (!h || h[0] + h[1] + h[2] === 0) return `<p class="muted">${esc(A.name)} and ${esc(B.name)} have never played each other.</p>`;
    const g = h[0] + h[1] + h[2];
    const lead = h[0] > h[1] ? A.name + " leads" : h[1] > h[0] ? B.name + " leads" : "All square";
    const score = `<div class="h2h-score"><div><div class="big">${h[0]}</div><div class="kicker">${esc(A.name)}</div></div><div class="h2h-dash">–</div><div><div class="big">${h[1]}</div><div class="kicker">${esc(B.name)}</div></div></div>
      <p class="note">${esc(lead)}${h[2] ? " · " + h[2] + " tie" + (h[2] > 1 ? "s" : "") : ""} · Points ${h[3].toFixed(1)} – ${h[4].toFixed(1)} · ${(h[3] / g).toFixed(1)} vs ${(h[4] / g).toFixed(1)} per game</p>`;
    const M = tapeMeetings(H, A, B);
    if (!M) return score + '<p class="muted">Every meeting shows here after the next site update.</p>';
    // current streak in the series (newest first)
    let streak = "";
    if (M.length) {
      const res = x => x.a > x.b ? "a" : x.b > x.a ? "b" : "t";
      const first = res(M[0]);
      let n = 0; while (n < M.length && res(M[n]) === first) n++;
      streak = first === "t" ? "Last meeting was a tie" : `${esc((first === "a" ? A : B).name)} has won ${n === 1 ? "the last meeting" : `the last ${n}`}`;
    }
    const big = side => M.filter(x => side === "a" ? x.a > x.b : x.b > x.a).sort((p, q) => Math.abs(q.a - q.b) - Math.abs(p.a - p.b))[0];
    const ba = big("a"), bb = big("b");
    const link = x => { const p = new URLSearchParams({ week: x.week }); if (x.season !== IDX.current) p.set("season", x.season); if (x.game != null) p.set("game", x.game); return "#/matchups?" + p; };
    const bigLine = (x, who) => x ? `<span>${esc(who.name)}'s biggest win: <b>+${Math.abs(x.a - x.b).toFixed(1)}</b> <a class="wk-link" href="${link(x)}">${x.season} ${x.playoff ? "playoffs" : "wk " + x.week}</a></span>` : "";
    const rows = M.map(x => {
      const w = x.a > x.b ? 1 : x.b > x.a ? 2 : 0;
      return `<a class="tape-game" href="${link(x)}"><span class="tape-when">${x.season} · ${x.playoff ? "Playoffs wk " : "Wk "}${x.week}${x.playoff ? ' <span class="badge po">PO</span>' : ""}</span>
        <span class="tape-sc${w === 1 ? " win" : ""}">${fmt(x.a)}</span><span class="muted">–</span><span class="tape-sc${w === 2 ? " win" : ""}">${fmt(x.b)}</span><span class="go">Box score →</span></a>`;
    }).join("");
    return score + `<div class="tape-facts">${[streak ? `<span>${streak}</span>` : "", bigLine(ba, A), bigLine(bb, B)].filter(Boolean).join("")}</div>
      <div class="tape-games"><div class="tape-games-h"><span>Every meeting</span><b>${esc(A.name)}</b><span></span><b>${esc(B.name)}</b><span></span></div>${rows}</div>`;
  }
  function tapeSeasons(A, B) {
    const years = [...new Set(A.seasons.concat(B.seasons).map(s => s.season))].sort((x, y) => y - x);
    const cell = (s, other) => {
      if (!s) return '<span class="muted">Not in the league</span>';
      const pos = s.finish || s.standing, opos = other ? other.finish || other.standing : null;
      const win = opos != null && pos < opos;
      return `<span class="tape-season${win ? " win" : ""}">${logoImg(s.logo, s.team)}<span><b>${esc(s.team)}</b><span class="team-mgr">${s.w}–${s.l}${s.t ? "–" + s.t : ""} · ${s.finish ? finishText(s.finish) : "#" + s.standing + " so far"}</span></span></span>`;
    };
    return `<div class="table-wrap"><table class="tbl tape-tbl"><thead><tr><th>Season</th><th>${esc(A.name)}</th><th>${esc(B.name)}</th></tr></thead><tbody>${years.map(y => {
      const a = A.seasons.find(s => s.season === y), b = B.seasons.find(s => s.season === y);
      return `<tr><td class="lead" data-label="Season"><a class="wk-link" href="#/${y === IDX.current ? "" : "?season=" + y}">${y}</a></td><td data-label="${esc(A.name)}">${cell(a, b)}</td><td data-label="${esc(B.name)}">${cell(b, a)}</td></tr>`;
    }).join("")}</tbody></table></div>`;
  }
  function tapeCommon(H, A, B) {
    const rec = (x, y) => H.h2h[x + "|" + y];
    const pct = r => r ? (r[0] + r[2] / 2) / Math.max(1, r[0] + r[1] + r[2]) : 0;
    const rows = H.members.filter(o => o.id !== A.id && o.id !== B.id).map(o => ({ o, a: rec(A.id, o.id), b: rec(B.id, o.id) }))
      .filter(r => r.a && r.b && r.a[0] + r.a[1] + r.a[2] && r.b[0] + r.b[1] + r.b[2]).sort((p, q) => (q.o.active - p.o.active) || p.o.name.localeCompare(q.o.name));
    if (!rows.length) return '<p class="muted">They haven\'t played any of the same managers yet.</p>';
    const tot = [0, 0];
    rows.forEach(r => { const d = pct(r.a) - pct(r.b); if (d > 1e-9) tot[0]++; else if (d < -1e-9) tot[1]++; });
    const fmtRec = r => `${r[0]}–${r[1]}${r[2] ? "–" + r[2] : ""}`;
    return `<p class="note">${esc(A.name)} has the better record against ${tot[0]}, ${esc(B.name)} against ${tot[1]}${rows.length - tot[0] - tot[1] ? `, even against ${rows.length - tot[0] - tot[1]}` : ""}.</p>` + table([
      { label: "Opponent", cell: r => `<b>${esc(r.o.name)}</b>${r.o.active ? "" : ' <span class="badge former">Former</span>'}` },
      { label: esc(A.name), num: 1, cell: r => `<span class="${pct(r.a) > pct(r.b) + 1e-9 ? "tape-win" : ""}">${fmtRec(r.a)}</span>` },
      { label: esc(B.name), num: 1, cell: r => `<span class="${pct(r.b) > pct(r.a) + 1e-9 ? "tape-win" : ""}">${fmtRec(r.b)}</span>` },
    ], rows);
  }

  // ---------------------------------------------------------------- who to root for (Matchups, My team)
  // From the playoff-odds simulation: each team's playoff chance given each result of this week's games
  // (D.league.rootFor). For your team: the games elsewhere whose result moves your odds, biggest first, with how
  // each is going live. When you're all but in, it switches to first-round-bye odds.
  function rootFor(tid) {
    const R = L.rootFor;
    if (!R || !L.isCurrent || L.over || !teamById[tid]) return null;
    const key = String(tid);
    const sure = R.games.every(g => (g.odds[key] || []).every(o => o && o[0] != null && o[0] >= 99.5));
    const k = sure ? 1 : 0; // 0 = playoff odds, 1 = bye odds
    const wk = D.weeks.find(w => w.week === R.week);
    const live = g => { const x = wk && wk.games.find(y => y.sides.length === 2 && y.sides.some(s => s.team === g.home) && y.sides.some(s => s.team === g.away)); return x ? Object.fromEntries(x.sides.map(s => [s.team, s.pts])) : null; };
    let own = null;
    const rows = [];
    for (const g of R.games) {
      const o = g.odds[key];
      if (!o || o[0][k] == null || o[1][k] == null) continue;
      if (g.home === tid || g.away === tid) {
        const me = g.home === tid ? 0 : 1;
        own = { win: o[me][k], lose: o[1 - me][k], opp: g.home === tid ? g.away : g.home, live: live(g) };
        continue;
      }
      const swing = o[0][k] - o[1][k];
      if (Math.abs(swing) < 1) continue;
      const pick = swing > 0 ? g.home : g.away, other = swing > 0 ? g.away : g.home;
      rows.push({ pick, other, swing: Math.abs(swing), ifWin: swing > 0 ? o[0][k] : o[1][k], ifLose: swing > 0 ? o[1][k] : o[0][k], live: live(g) });
    }
    rows.sort((a, b) => b.swing - a.swing);
    const t = teamById[tid];
    return { week: R.week, kind: sure ? "bye" : "playoff", now: t.odds ? (sure ? t.odds.byePct : t.odds.playoffPct) : null, own, rows };
  }
  function rootForHtml(tid) {
    const r = rootFor(tid);
    if (!r) return "";
    const what = r.kind === "bye" ? "first-round bye" : "playoff";
    const liveTag = (lv, a, b) => {
      if (!lv || !(lv[a] > 0 || lv[b] > 0)) return "";
      const d = lv[a] - lv[b];
      return `<span class="rf-live ${d > 0 ? "good" : d < 0 ? "bad" : ""}">${fmt(lv[a])}–${fmt(lv[b])}${d > 0 ? " · going your way" : d < 0 ? " · not yet" : ""}</span>`;
    };
    const going = r.rows.filter(x => x.live && (x.live[x.pick] > 0 || x.live[x.other] > 0));
    const sum = going.length ? ` <span class="rf-sum">${going.filter(x => x.live[x.pick] > x.live[x.other]).length} of ${going.length} going your way right now</span>` : "";
    const own = r.own ? `<div class="rf-own"><b>Your game</b> vs. ${esc(tname(r.own.opp))}: win and your ${what} odds are <b>${pct(r.own.win)}</b>, lose and they're <b>${pct(r.own.lose)}</b>.${liveTag(r.own.live, tid, r.own.opp) ? " " + liveTag(r.own.live, tid, r.own.opp) : ""}</div>` : "";
    const list = r.rows.length ? `<div class="rf-list">${r.rows.map(x => `<div class="rf-row">
        <span class="rf-who">${logo(teamById[x.pick])}<span><span class="rf-k">Root for</span> <b>${esc(tname(x.pick))}</b> <span class="muted">over ${esc(tname(x.other))}</span>
          <span class="team-mgr">If they win: ${pct(x.ifWin)} · if they lose: ${pct(x.ifLose)}</span>${liveTag(x.live, x.pick, x.other)}</span></span>
        <span class="rf-swing">+${x.swing.toFixed(x.swing < 10 ? 1 : 0)}%<small>your odds</small></span></div>`).join("")}</div>`
      : `<p class="muted">No other game this week moves your ${what} odds by a point or more.</p>`;
    return section(`Who to root for <span class="muted">· week ${r.week}</span>`, { short: `The other games this week that change your ${what} odds, and by how much.`,
      full: `From the same 10,000 simulated seasons as the playoff odds: for each of this week's games, your ${what} chance in the simulations where each team won. <b>Root for</b> the team whose win helps you; the number is how much that result adds to your odds (percentage points). Updates with every site refresh (every 5 minutes during games), so a game that's nearly over stops mattering.${r.kind === "bye" ? " You're all but certain to make the playoffs, so this shows first-round-bye odds instead." : ""}` },
      `<div class="panel rf">${r.now != null ? `<p class="rf-now">Your ${what} odds now: <b>${pct(r.now)}</b>${sum}</p>` : ""}${own}${list}</div>`);
  }
  function rootForSection(w) {
    if (!L.rootFor || L.rootFor.week !== w) return "";
    const t = myTeam();
    if (t) return rootForHtml(t.id);
    return section(`Who to root for <span class="muted">· week ${w}</span>`, "", `<div class="panel">See which of this week's other games help your playoff chances: <a href="#/myteam">claim your team on My team ›</a></div>`);
  }

  // ---------------------------------------------------------------- transaction-log features (data/<season>-moves.js)
  const MV = {};
  function loadMoves(season) {
    if (window.LEAGUE_MOVES && window.LEAGUE_MOVES[season]) return Promise.resolve(window.LEAGUE_MOVES[season]);
    if (!MV[season]) {
      MV[season] = new Promise((resolve, reject) => {
        const sc = document.createElement("script");
        sc.src = `data/${season}-moves.js?b=` + encodeURIComponent(IDX.updated || IDX.build || "");
        sc.onload = () => (window.LEAGUE_MOVES && window.LEAGUE_MOVES[season] ? resolve(window.LEAGUE_MOVES[season]) : reject(new Error("empty")));
        sc.onerror = () => reject(new Error("load failed"));
        document.head.appendChild(sc);
      }).catch(e => { delete MV[season]; throw e; });
    }
    return MV[season];
  }

  // Manager style (My team): how you run your team, from ESPN's log of every move, vs. the rest of the league
  const MS_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  function styleHtml(S, all, n) {
    const rk = k => S.ranks && S.ranks[k] ? `<span class="team-mgr">#${S.ranks[k]} of ${n}</span>` : "";
    const tiles = [
      ["Pickups", S.adds, rk("adds"), "Players added off waivers or free agency."],
      S.lineup != null ? ["Lineup changes", S.lineup, rk("lineup"), "Times you saved a change to your lineup."] : null,
      ["Gut calls", S.gut, S.gut ? `<span class="team-mgr">${S.gutWon} paid off</span>` : rk("gut"), `Starting a player ESPN projected at least 2 points below someone eligible on your bench. "Paid off" = he outscored that bench player.`],
      S.quick != null ? ["Cut within a week", S.quick + "%", rk("quick"), "Share of your pickups you dropped within about a week."] : null,
      ["Trades", S.trades, rk("trades"), "Trades completed."],
    ].filter(Boolean);
    const max = Math.max(1, ...S.days);
    const days = S.acts >= 8 ? `<div class="ms-when"><div class="ms-h">When you make moves <span class="muted">(${S.acts} moves, Eastern time)</span></div>
      <div class="ms-days">${S.days.map((v, i) => `<div class="ms-day" title="${MS_DAYS[i]}: ${v}"><span class="ms-bar"><i style="height:${Math.round(100 * v / max)}%"></i></span><small>${MS_DAYS[i]}</small></div>`).join("")}</div>
      <p class="team-mgr">${[S.night != null ? `${S.night}% after midnight` : "", S.gameday != null ? `${S.gameday}% on Sundays` : "", S.early != null ? `${S.early}% on Tuesday or Wednesday` : ""].filter(Boolean).join(" · ")}</p></div>` : "";
    const traits = S.traits.length ? `<ul class="ms-traits">${S.traits.map(([, noun, why]) => `<li><b>${esc(noun[0].toUpperCase() + noun.slice(1))}</b>: ${esc(why)}</li>`).join("")}</ul>`
      : `<p class="muted">Nothing about how you manage stands far out from the rest of the league.</p>`;
    const others = all.filter(x => x.t).sort((a, b) => a.t.standing - b.t.standing).map(x => `<div class="ms-other${isMine(x.t) ? " mine" : ""}">${logo(x.t)}<span><b>${esc(x.t.name)}</b><span class="team-mgr">${esc(x.s.type)}</span></span></div>`).join("");
    return `<div class="panel mstyle"><div class="ms-type">${esc(S.type)}</div>${traits}
      <div class="set-tiles ms-tiles">${tiles.map(([k, v, sub, tip]) => `<div class="set-tile" title="${esc(tip)}"><span class="set-tile-k">${k}</span><span class="set-tile-v">${esc(String(v))}</span>${sub}</div>`).join("")}</div>
      ${days}<details class="ms-all"><summary>Everyone's style</summary><div class="ms-others">${others}</div></details></div>`;
  }
  function fillStyle(box, t) {
    if (!box) return;
    loadMoves(L.season).then(M => {
      const S = M.style && M.style[t.id];
      if (!S) { box.innerHTML = '<div class="empty">Not enough moves yet this season.</div>'; return; }
      const all = Object.entries(M.style).map(([id, s]) => ({ t: teamById[id], s }));
      box.innerHTML = styleHtml(S, all, all.length);
    }).catch(() => { box.innerHTML = '<div class="empty">Couldn\'t load your moves. Try reloading.</div>'; });
  }

  // Butterfly effect (Insights -> What ifs): any single move taken out of the season, replayed
  function bfxLabel(m, side) {
    const list = a => a.join(" & ");
    if (m.kind === "trade") {
      const a = side === m.other ? m.gave : m.gets, b = side === m.other ? m.gets : m.gave;
      return `traded ${list(b)} for ${list(a)}`;
    }
    const verb = m.kind === "waiver" ? "claimed" : "added";
    return m.gets.length ? `${verb} ${list(m.gets)}${m.gave.length ? `, dropped ${list(m.gave)}` : ""}` : `dropped ${list(m.gave)}`;
  }
  function bfxDetail(B, m) {
    const tm = id => teamById[id];
    const who = m.kind === "trade" ? `${esc(tname(m.team))} and ${esc(tname(m.other))}` : esc(tname(m.team));
    const what = m.kind === "trade" ? `hadn't made their week ${m.week} trade (${esc(tname(m.team))} ${esc(bfxLabel(m, m.team))})` : `hadn't ${esc(bfxLabel(m, m.team))} in week ${m.week}`;
    const deltas = Object.entries(m.delta).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const flips = m.flips.map(([w, gid, a, apa, apb, b, bpa, bpb]) => {
      const nowA = apb > bpb, wasA = apa > bpa;
      return `<div class="bfx-flip"><a class="when" href="${href("matchups", { week: w, game: gid })}"><span>Wk ${w}</span><span class="go">Box score →</span></a>
        <span><span><b>${esc(tname(nowA ? a : b))}</b> would have beaten <b>${esc(tname(nowA ? b : a))}</b></span>
        <span class="team-mgr">${esc(tname(a))} ${fmt(apa)}${apb !== apa ? ` → ${fmt(apb)}` : ""} · ${esc(tname(b))} ${fmt(bpa)}${bpb !== bpa ? ` → ${fmt(bpb)}` : ""} · really ${esc(tname(wasA ? a : b))} won</span></span></div>`;
    }).join("");
    const rec = r => `${r[0]}–${r[1]}${r[2] ? "–" + r[2] : ""}`;
    const order = Object.keys(B.rank).sort((a, b) => ((m.ranks[a] || [0, B.rank[a]])[1]) - ((m.ranks[b] || [0, B.rank[b]])[1]));
    const rows = order.map(id => {
      const r = m.ranks[id], nr = r ? r[1] : B.rank[id], mv = r ? r[0] - r[1] : 0;
      return { id, t: tm(id), nr, old: B.rank[id], mv, rec: B.rec[id], newRec: m.rec[id] };
    }).filter(x => x.t);
    const tbl = table([
      { label: "Team", cell: x => `<span class="bfx-team"><b class="bfx-rk">${x.nr}</b>${teamCell(x.t)}</span>` },
      { label: "Record", num: 1, cell: x => x.newRec ? `${rec(x.newRec)} <span class="muted">(really ${rec(x.rec)})</span>` : rec(x.rec) },
      { label: "Move", num: 1, cell: x => x.mv ? `<b class="${x.mv > 0 ? "pos" : "neg"}">${x.mv > 0 ? "▲" : "▼"} ${Math.abs(x.mv)}</b> <span class="muted">from ${x.old}</span>` : `<span class="muted">—</span>` },
    ], rows);
    return `<div class="bfx-card"><h3 class="bfx-h">If ${who} ${what}…</h3>
      <div class="bfx-chips"><span class="bfx-chip"><b>${m.flips.length}</b> game${m.flips.length === 1 ? "" : "s"} flip</span>${deltas.map(([id, d]) => `<span class="bfx-chip">${esc(tname(Number(id)))} ${signedPts(d, true)} pts</span>`).join("")}<span class="bfx-chip"><b>${Object.keys(m.ranks).length}</b> team${Object.keys(m.ranks).length === 1 ? "" : "s"} move in the standings</span></div>
      ${flips ? `<div class="bfx-flips">${flips}</div>` : `<p class="muted">No game would have gone the other way, but the points add up: ${deltas.map(([id, d]) => `${esc(tname(Number(id)))} ${signed(d)}`).join(", ")}.</p>`}
      <h4 class="bfx-sub">Standings without it <span class="muted">· weeks ${B.weeks[0]}–${B.weeks[1]}, by record then points</span></h4>${tbl}</div>`;
  }
  function bfxHydrate() {
    const box = document.getElementById("bfx");
    if (!box) return;
    loadMoves(L.season).then(M => {
      const B = M.butterfly;
      if (!B || !B.moves || !B.moves.length) { box.innerHTML = '<div class="empty">No moves have changed a lineup yet this season.</div>'; return; }
      const mine = myTeam();
      const asked = state.params.get("move");
      let m = B.moves.find(x => x.id === asked);
      if (!m && mine) m = B.moves.find(x => x.team === mine.id || x.other === mine.id);
      m = m || B.moves[0];
      const teamsOrder = D.teams.slice().sort((a, b) => (isMine(b) ? 1 : 0) - (isMine(a) ? 1 : 0) || a.standing - b.standing);
      const opts = teamsOrder.map(t => {
        const list = B.moves.filter(x => x.team === t.id || x.other === t.id).sort((a, b) => a.week - b.week);
        return list.length ? `<optgroup label="${esc(t.name)}">${list.map(x => `<option value="${esc(x.id)}"${x.id === m.id ? " selected" : ""}>Wk ${x.week}: ${esc(bfxLabel(x, t.id))}${x.flips.length ? ` (${x.flips.length} flip${x.flips.length === 1 ? "" : "s"})` : ""}</option>`).join("")}</optgroup>` : "";
      }).join("");
      const top = B.moves.filter(x => x.flips.length).slice(0, 5);
      box.innerHTML = `<label class="field bfx-pick">Take away <select id="bfx-move">${opts}</select></label>
        <div id="bfx-detail">${bfxDetail(B, m)}</div>
        ${top.length ? `<div class="bfx-top"><div class="ms-h">Biggest butterflies this season</div>${top.map(x => `<button type="button" class="bfx-topbtn" data-bfx="${esc(x.id)}"><b>${x.flips.length} flip${x.flips.length === 1 ? "" : "s"}</b><span>${esc(tname(x.team))} ${esc(bfxLabel(x, x.team))} <span class="muted">· wk ${x.week}</span></span></button>`).join("")}</div>` : ""}`;
      const pick = id => {
        const x = B.moves.find(y => y.id === id);
        if (!x) return;
        document.getElementById("bfx-detail").innerHTML = bfxDetail(B, x);
        const sel = document.getElementById("bfx-move");
        if (sel) sel.value = id;
        const p = new URLSearchParams(state.params); p.set("move", id); state.params = p;
        history.replaceState(null, "", "#/insights/whatif?" + p.toString());
      };
      box.querySelector("#bfx-move").addEventListener("change", e => pick(e.target.value));
      box.querySelectorAll("[data-bfx]").forEach(b => b.addEventListener("click", () => { pick(b.dataset.bfx); document.getElementById("bfx-detail").scrollIntoView({ block: "start", behavior: "smooth" }); }));
    }).catch(() => { box.innerHTML = '<div class="empty">Couldn\'t load the season\'s moves. Try reloading.</div>'; });
  }

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
  // History → Champions & standings: every manager's luck across every season
  function careerLuckSection(H) {
    const C = H.careerLuck;
    if (!C || !C.length) return "";
    const seasonLine = x => `${x.season}${x.done ? "" : "*"} ${x.luck > 0 ? "+" : x.luck < 0 ? "−" : ""}${Math.abs(x.luck).toFixed(1)}`;
    const extreme = (r, f) => r.seasons.length ? r.seasons.reduce((a, b) => (f(b.luck, a.luck) ? b : a)) : null;
    return section("Career luck", { short: "Each manager's regular-season wins vs. the wins their scoring deserved, every season added up.",
      full: "For every season, a team's expected wins come from its all-play record (playing every team every week): a team that would beat 60% of the league each week is expected to win 60% of its games. <b>Luck</b> is actual wins minus expected wins, added up across every season the manager played (regular season only; * = season in progress). Positive means more wins than the scoring deserved." }, table([
      { label: "Manager", cell: r => `<b>${esc(r.name)}</b>${r.active ? "" : ' <span class="badge former">Former</span>'}` },
      { label: "Wins", num: 1, cell: r => r.wins.toFixed(0) },
      { label: "Expected", num: 1, cell: r => r.exp.toFixed(1) },
      { label: "Luck", num: 1, cell: r => signedPts(r.luck, true) },
      { label: "All-play", num: 1, cell: r => `${r.apW}–${r.apL}` },
      { label: "Luckiest season", cell: r => { const x = extreme(r, (a, b) => a > b); return x && x.luck > 0 ? esc(seasonLine(x)) : "—"; } },
      { label: "Unluckiest season", cell: r => { const x = extreme(r, (a, b) => a < b); return x && x.luck < 0 ? esc(seasonLine(x)) : "—"; } },
    ], C));
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
        ${recCard("Nemesis players", (R.nemesis || []).map(nemesisLine).join(""))}
      </div>`;
  }
  // an NFL player who's scored a lot against this member, all-time (in the opposing starting lineup)
  const nemesisLine = r => `<div class="rec"><span class="rec-v">${r.pts.toFixed(1)}</span><span class="rec-who"><span class="slot ${esc(r.pos)}">${esc(r.pos)}</span><span><b>${esc(r.name)}</b><span class="team-mgr">${r.games} game${r.games === 1 ? "" : "s"} against you · best ${Number(r.best.pts).toFixed(1)} for ${esc(r.best.team)}</span></span></span>${whenLink(Object.assign({ pid: r.pid }, r.best))}</div>`;
  async function fillPersonalBook(box) {
    if (!box) return;
    const m = box.dataset.recMember;
    let all = null;
    try { all = await loadRecords(); } catch (_) { box.innerHTML = `<div class="empty">Couldn't load the record book. Try again in a minute.</div>`; return; }
    box.innerHTML = all[m] ? `<p class="sub" style="margin:0 0 10px">${esc(memberName(m))}'s records across every season, playoffs included. <a class="wk-link" href="${href("history", { a: m }, "h2h")}">Compare with another manager ›</a></p>` + personalBookHtml(all[m], m) : `<div class="empty">No games yet.</div>`;
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
    const nm = (R.nemesis || [])[0];
    if (nm) tiles.push(tile("Your nemesis", esc(nm.name), `${nm.pts.toFixed(1)} pts against you in ${nm.games} game${nm.games === 1 ? "" : "s"}`, null));
    box.innerHTML = `<div class="me-recs">${tiles.join("")}</div>`;
  }

  function renderHistory() {
    const H = IDX.history;
    if (state.sub === "yearbook") { // the yearbook became League Wrapped
      const extra = Object.fromEntries([...state.params].filter(([k]) => k !== "season"));
      location.replace(href("history", extra, "wrapped"));
      return;
    }
    const sub = HISTORY_TABS.some(([k]) => k === state.sub) ? state.sub : "overview";
    main.innerHTML = `<div class="section-head"><div><h1>League history</h1><p class="sub">${IDX.seasons.length} seasons · ${H.members.length} members all-time</p></div></div>
      ${subnav("history", HISTORY_TABS, sub)}${HISTORY[sub](H)}`;
  }

  // ---------------------------------------------------------------- watch guide
  // Which real NFL games matter most this week: every league starter playing in each game, weighted by his
  // projection and by how close his fantasy matchup is (a toss-up counts more than a blowout).
  // For an earlier week (or a past season), the same rating with the points each starter actually scored in place
  // of his projection: which games mattered most that week.
  function watchModel(week) {
    const wk = D.weeks.find(w => w.week === week);
    if (!wk) return null;
    const live = liveWeek(week);
    const src = nflGamesFor(week);
    if (src == null) return { loading: true };
    if (src === "error") return { error: true };
    if (!src.length) return null;
    const now = Date.now();
    const games = src.map(g => Object.assign({}, g, { at: g.date ? new Date(g.date).getTime() : 0, rows: [], stake: 0, starters: 0, proj: 0 }));
    const byTeam = {};
    games.forEach(g => { byTeam[g.home] = g; byTeam[g.away] = g; });
    wk.games.filter(m => m.sides.length === 2).forEach(m => {
      const [a, b] = m.sides;
      const close = a.winProb != null && b.winProb != null ? 1 - Math.abs(a.winProb - b.winProb)
        : Math.max(0, 1 - Math.abs((a.proj != null ? a.proj : a.projected) - (b.proj != null ? b.proj : b.projected)) / 50);
      [a, b].forEach((s, i) => s.lineup.filter(p => p.slot !== "BE" && p.slot !== "IR").forEach(p => {
        const g = byTeam[p.team];
        if (!g) return;
        const pr = live ? p.proj || 0 : p.proj != null ? p.proj : p.pts || 0;
        g.starters++; g.proj += pr; g.stake += pr * (0.35 + 0.65 * close);
        let row = g.rows.find(r => r.game === m.id);
        if (!row) g.rows.push(row = { game: m.id, close, sides: [{ team: a.team, players: [] }, { team: b.team, players: [] }] });
        row.sides[i].players.push(p);
      }));
    });
    const max = Math.max(1, ...games.map(g => g.stake));
    games.forEach(g => {
      g.score = Math.round(100 * g.stake / max);
      // ESPN's scoreboard (checked each minute during games) says when a game is really over; without a fresh
      // check, a guess from the kickoff time
      const k = NFL_STATUS.games && now - NFL_STATUS.at < 5 * 60e3 ? NFL_STATUS.games[String(g.id)] : null;
      g.state = !live ? "final" : k ? (k[0] === "in" ? "live" : k[0] === "post" ? "final" : "upcoming")
        : !g.at || now < g.at ? "upcoming" : now < g.at + 3.5 * 3600e3 ? "live" : "final";
      g.detail = k && k[0] === "in" ? k[1] : "";
      g.rows.sort((x, y) => y.close - x.close);
    });
    return { week: wk.week, games, live };
  }
  const kickText = g => g.state === "live" ? (g.detail ? "Live · " + g.detail : "Live now") : g.state === "final" ? "Final" : g.tbd ? "Time TBD"
    : new Date(g.at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  const closeText = c => c >= 0.8 ? "Toss-up" : c >= 0.5 ? "Close" : "Leaning";
  const lastName = n => /D\/ST$/.test(n) ? n.replace(" D/ST", " D") : n.split(" ").slice(1).join(" ") || n;
  const plist = (ps, done) => ps.map(p => `${esc(lastName(p.name))} <span class="muted">${done ? fmt(p.pts) : (p.proj || 0).toFixed(1)}</span>`).join(", ");

  function renderWatch() {
    const w = matchupWeek(), live = liveWeek(w);
    const head = `<div class="section-head"><div><h1>Watch guide${live ? "" : ` <span class="muted">· week ${w}</span>`}</h1>${live ? expl("The real NFL games that matter most to the league this week.",
      "Each game is rated by the league starters playing in it, weighted by their projections and by how close their fantasy matchups are: a player in a toss-up counts almost three times as much as one in a lopsided matchup. 100 = the week's biggest game. Numbers next to players are ESPN's projections (points once their game is over).")
      : expl(`The real NFL games that mattered most to the league in week ${w}.`,
      `Each game is rated by the league starters who played in it, weighted by the points they scored and by how close their fantasy matchups were going in (by ESPN's projections): a player in a toss-up counts almost three times as much as one in a lopsided matchup. 100 = the week's biggest game. Numbers next to players are their points.`)}</div></div>${matchupNav("watch")}${weekStrip(w)}`;
    // opened between the minute checks: get the real game states now, then redraw once
    if (live && !(NFL_STATUS.games && Date.now() - NFL_STATUS.at < 5 * 60e3) && !NFL_STATUS.busy) {
      NFL_STATUS.busy = true;
      checkNflStatus().then(() => { NFL_STATUS.busy = false; if (NFL_STATUS.games && state.tab === "matchups" && state.sub === "watch") renderKeepScroll(renderWatch); });
    }
    const M = watchModel(w);
    if (!M) { main.innerHTML = head + `<div class="empty">No NFL games found for week ${w}.</div>`; return; }
    if (M.loading) { main.innerHTML = head + `<div class="empty">Loading week ${w}'s NFL games…</div>`; return; }
    if (M.error) { main.innerHTML = head + `<div class="empty">Couldn't reach ESPN for week ${w}'s NFL games. Try again in a bit.</div>`; delete NFLWK[state.season + ":" + w]; return; }
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
        ${condHtml(g) ? `<div class="wg-cond">${condHtml(g)}</div>` : ""}<div class="wg-links">${followLinks(g)}</div>
        <div class="wg-meter"><span class="wg-score" title="Importance this week (100 = biggest game)">${g.score}</span><span class="wg-bar" aria-hidden="true"><i style="width:${g.score}%"></i></span>
          <span class="team-mgr">${g.starters} league starter${g.starters === 1 ? "" : "s"} · ${g.proj.toFixed(0)} ${g.state === "final" && !liveWeek(matchupWeek()) ? "" : "projected "}pts${mineHere ? " · <b>you have players here</b>" : ""}</span></div>
        ${rows ? `<div class="wg-rows">${rows}</div>` : ""}</article>`;
    };
    if (!M.live) {
      const played = M.games.filter(g => g.starters).sort((a, b) => b.stake - a.stake);
      const none = M.games.filter(g => !g.starters);
      main.innerHTML = head + (played.length ? section(`Week ${w}'s biggest games`, "", `<div class="wg-list">${played.map(card).join("")}</div>`) : `<div class="empty">No league starters played in week ${w}'s NFL games.</div>`) +
        (none.length ? `<p class="sub">No league starters: ${none.map(g => esc(g.away + " at " + g.home)).join(", ")}.</p>` : "");
      return;
    }
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
  const ME = { member: store.get("me", ""), pick: "", msg: "", err: false, busy: false, cust: false };
  // My team layout (per device): the order of the sections below the at-a-glance tiles, and which are hidden
  const ME_PARTS = { glance: "At a glance", week: "This week's matchup", root: "Who to root for", style: "Your manager style", moved: "Why your power moved", news: "Player news", waivers: "Waiver targets", watch: "Your games to watch",
    byes: "Byes ahead", badges: "Your badges", records: "Your record book", roster: "Roster", schedule: "Schedule" };
  const ME_ORDER = ["week", "root", "moved", "news", "waivers", "watch", "byes", "style", "badges", "records", "roster", "schedule"];
  function meLayout() {
    const saved = store.get("me-layout", null) || {};
    const order = (Array.isArray(saved.order) ? saved.order : []).filter(k => ME_ORDER.includes(k));
    ME_ORDER.forEach((k, i) => { if (!order.includes(k)) order.splice(Math.min(i, order.length), 0, k); }); // new sections slot in
    return { order, hidden: (Array.isArray(saved.hidden) ? saved.hidden : []).filter(k => ME_PARTS[k]) };
  }
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-mecust],[data-mecust-up],[data-mecust-down]");
    if (!b || b.disabled) return;
    const lay = meLayout();
    if (b.dataset.mecust === "toggle") ME.cust = !ME.cust;
    else if (b.dataset.mecust === "reset") { store.set("me-layout", null); return renderKeepScroll(renderMyTeam); }
    else {
      const k = b.dataset.mecustUp || b.dataset.mecustDown, i = lay.order.indexOf(k), j = i + (b.dataset.mecustUp ? -1 : 1);
      if (j < 0 || j >= lay.order.length) return;
      [lay.order[i], lay.order[j]] = [lay.order[j], lay.order[i]];
      store.set("me-layout", lay);
    }
    renderKeepScroll(renderMyTeam);
  });
  document.addEventListener("change", e => {
    const k = e.target.dataset && e.target.dataset.mecustShow;
    if (!k) return;
    const lay = meLayout();
    lay.hidden = e.target.checked ? lay.hidden.filter(x => x !== k) : [...new Set([...lay.hidden, k])];
    store.set("me-layout", lay);
    renderKeepScroll(renderMyTeam);
  });
  if (ME.member && !PK.member) PK.member = ME.member;
  function myTeam(data) { return ME.member ? (((data || D) || {}).teams || []).find(t => (t.owners || []).includes(ME.member)) || null : null; }
  function isMine(t) { return !!(t && ME.member && (t.owners || []).includes(ME.member)); }
  // "Fix it on ESPN": open the exact ESPN page where the thing the site flagged gets fixed
  const ESPN_TEAM = t => `https://fantasy.espn.com/football/team?leagueId=${L.id}&seasonId=${L.season}&teamId=${t.id}`;
  const ESPN_ADD = () => `https://fantasy.espn.com/football/players/add?leagueId=${L.id}`;
  const espnBtn = (url, label) => `<a class="espn-fix" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)} <span aria-hidden="true">↗</span></a>`;
  // starters this week who won't play: ruled out, on IR or suspended, or on a bye (and haven't scored)
  function lineupProblems(side) {
    const teamsPlaying = new Set((D.nflGames || []).flatMap(g => [g.home, g.away]));
    return (side.lineup || []).filter(p => !["BE", "IR"].includes(p.slot) && !(p.pts > 0)).map(p => {
      if (["OUT", "INJURY_RESERVE", "SUSPENSION"].includes(p.injury)) return { p, why: { OUT: "ruled out", INJURY_RESERVE: "on IR", SUSPENSION: "suspended" }[p.injury] };
      if (teamsPlaying.size && p.team && !["D/ST"].includes(p.pos) && !teamsPlaying.has(p.team)) return { p, why: "on bye" };
      if (teamsPlaying.size && p.pos === "D/ST" && !teamsPlaying.has(p.team)) return { p, why: "on bye" };
      return null;
    }).filter(Boolean);
  }

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
            <div class="game-foot"><span>${h ? `All-time vs ${esc(memberName(o.owners[0]))}: ${h[0]}–${h[1]}${h[2] ? "–" + h[2] : ""}` : "First meeting"}</span><span>Box score →</span></div></a>
          ${(() => {
            const bad = lineupProblems(mine);
            return bad.length
              ? `<div class="me-fix warn"><span><b>Lineup check:</b> you're starting ${bad.map(x => `${esc(x.p.name)} (${x.why})`).join(", ")}.</span>${espnBtn(ESPN_TEAM(t), "Fix it on ESPN")}</div>`
              : `<div class="me-fix"><span>Lineup check: every starter is set to play.</span>${espnBtn(ESPN_TEAM(t), "Open lineup on ESPN")}</div>`;
          })()}${(() => {
            // this week's injury report for starters who haven't played yet (nflverse, updated each morning)
            const watch = (mine.lineup || []).filter(p => !["BE", "IR"].includes(p.slot) && !(p.pts > 0) && practiceWorry(p.id));
            return watch.length ? `<div class="me-fix prac"><span><b>Practice report:</b> ${watch.map(p => `${esc(p.name)} (${practiceText(p.id, true)})`).join("; ")}.</span></div>` : "";
          })()}${(() => {
            // weather that matters for starters who haven't played yet (wind and cold: kickers and passing; rain, snow: all)
            const by = new Map();
            (mine.lineup || []).filter(p => !["BE", "IR"].includes(p.slot) && !(p.pts > 0)).forEach(p => {
              const g = nflGameOf(p.team);
              if (!g || (g.date && Date.now() > Date.parse(g.date))) return;
              const hit = condFlags(g).filter(f => !f[2] || f[2].includes(p.pos));
              if (!hit.length) return;
              const k = g.id; if (!by.has(k)) by.set(k, { g, hit, ps: [] });
              by.get(k).ps.push(p.name);
            });
            return by.size ? `<div class="me-fix prac"><span><b>Game conditions:</b> ${[...by.values()].map(x => `${esc(x.g.away)} @ ${esc(x.g.home)} ${x.hit.map(f => f[1].toLowerCase()).join(", ")} (${esc(condText(x.g))}): ${x.ps.map(esc).join(", ")}`).join("; ")}.</span></div>` : "";
          })()}${(() => {
            const c = clinchOf(t.id), lines = clinchLines(t.id, true), n = (c || {}).now || {};
            const status = n.bye === "in" ? "You've clinched a first-round bye." : n.po === "in" ? "You've clinched a playoff spot." : n.po === "out" ? "You've been eliminated from the playoffs." : "";
            const tie = tieRaceMine(t);
            return status || lines.length || tie ? `<div class="me-fix prac"><span><b>Playoff picture:</b> ${[status].concat(lines.map(l => l.html), [tie]).filter(Boolean).join(" ")} <a class="wk-link" href="${href("playoffs")}">All scenarios ›</a>${insightHas("build") ? ` <a class="wk-link" href="${href("playoffs", {}, "scenarios")}">Build your own ›</a>` : ""}</span></div>` : "";
          })()}`);
      }
    }

    // NFL games with my players this week
    let watch = "";
    const M = cur && liveWeek(L.currentWeek) ? watchModel(L.currentWeek) : null;
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
      byes = section("Byes ahead", `Weeks your best lineup is short-handed, compared with full strength. ${bc.length ? espnBtn(ESPN_ADD(), "Find fill-ins on ESPN") : ""}`, bc.length
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
      { label: "Player", cell: p => `<span class="tcell"><span class="slot ${esc(POS.includes(p.slot) ? p.slot : p.pos)}" style="font-size:10px;font-weight:700">${esc(p.slot)}</span><span><span class="tname">${esc(p.name)}${cur ? usageChips(p.id) : ""}</span><span class="team-mgr">${esc(p.pos)} · ${esc(p.team)}${p.injury ? " · " + esc(p.injury.replace(/_/g, " ").toLowerCase()) : ""}</span>${cur && practiceText(p.id, true) ? `<span class="pprac">${practiceText(p.id, true)}</span>` : ""}</span></span>` },
      { label: cur ? "ROS rank" : "Finish", num: 1, cell: p => rank(p) ? esc(p.pos) + rank(p) : "—" },
      { label: cur ? "ROS pts" : "Season pts", num: 1, cell: p => pts(p) != null ? Number(pts(p)).toFixed(1) : "—" },
    ], t.roster));

    // every section, in the order and visibility this device has chosen (Customize)
    const parts = {
      glance, week, watch, byes, schedule, roster,
      moved: cur && t.moved ? section("Why your power moved", "", movedHtml(t)) : "",
      news: cur ? section("Player news", "The latest from ESPN on your players. New since your last visit is marked.", '<div class="me-news-box"><div class="empty">Loading…</div></div>') : "",
      waivers: waiverTargets(t),
      root: cur && L.rootFor ? rootForHtml(t.id) : "",
      style: section("Your manager style", { short: "How you actually run your team, from ESPN's log of every move.", full: "Built from ESPN's log of every move this season (pickups, drops, lineup changes, trades, with the time each was made), compared with the rest of the league. Your type comes from the two things that set you furthest apart from everyone else. Times are Eastern." }, '<div class="ms-box"><div class="empty">Loading…</div></div>'),
      badges: IDX.history.badges ? section(`Your badges <a class="wk-link" href="${href("history", {}, "badges")}">all badges ›</a>`, "Earned across every season you've played.", badgeTiles(ME.member)) : "",
      records: section(`Your record book <a class="wk-link" href="${href("history", { member: ME.member }, "records")}">full record book ›</a>`, "Your bests and worsts across every season you've played. Tap one for the box score.", `<div class="me-recs-box" data-rec-member="${esc(ME.member)}"><div class="empty">Loading…</div></div>`),
    };
    const lay = meLayout();
    const shown = k => parts[k] && !lay.hidden.includes(k);
    const part = k => `<div class="me-part" style="order:${lay.order.indexOf(k)}">${parts[k]}</div>`;
    const left = lay.order.filter(k => k !== "schedule" && shown(k)).map(part).join("");
    const right = shown("schedule") ? part("schedule") : "";
    const custBtn = `<button type="button" class="linkbtn" data-mecust="toggle">${ME.cust ? "Done" : "Customize"}</button>`;
    const cust = !ME.cust ? "" : `<div class="panel me-cust"><p class="sub">Choose what shows on this page and in what order. Saved on this device.</p>
      ${["glance", ...lay.order].map((k, i) => `<div class="me-cust-row${lay.hidden.includes(k) ? " off" : ""}"><label><input type="checkbox" data-mecust-show="${k}"${lay.hidden.includes(k) ? "" : " checked"}> ${esc(ME_PARTS[k])}${parts[k] ? "" : ' <span class="muted">(not showing right now)</span>'}</label>
        ${k === "glance" ? '<span class="muted me-cust-fixed">always on top</span>' : `<span class="me-cust-mv"><button type="button" class="linkbtn" data-mecust-up="${k}"${i === 1 ? " disabled" : ""} aria-label="Move ${esc(ME_PARTS[k])} up">↑</button><button type="button" class="linkbtn" data-mecust-down="${k}"${i === lay.order.length ? " disabled" : ""} aria-label="Move ${esc(ME_PARTS[k])} down">↓</button></span>`}</div>`).join("")}
      <div class="me-cust-foot"><button type="button" class="linkbtn" data-mecust="reset">Reset to default</button><button type="button" class="cta" data-mecust="toggle">Done</button></div>
      ${lay.order.includes("schedule") ? '<p class="note">On a computer, Schedule sits in the right-hand column; on a phone it follows the order above.</p>' : ""}</div>`;
    main.innerHTML = `<div class="section-head me-head"><div class="me-id">${logo(t)}<div><h1>${esc(t.name)}</h1><p class="sub">${esc(t.manager)} · ${L.season} season</p></div></div><span class="me-acts">${custBtn}${switchBtn}</span></div>
      ${cust}
      ${shown("glance") ? glance : ""}
      <div class="me-grid${right ? "" : " one"}"><div class="me-col">${left}</div><div class="me-col">${right}</div></div>`;
    fillMyRecords(main.querySelector(".me-recs-box"));
    fillStyle(main.querySelector(".ms-box"), t);
    if (cur) fillNews(main.querySelector(".me-news-box"), t);
  }

  // ---------------------------------------------------------------- player news (My team)
  // ESPN's fantasy news blurbs for the players on your roster, newest first. "New" = published since your
  // previous visit (remembered per device).
  const NEWS = { at: 0, key: "", items: null, seen: null };
  async function fillNews(box, t) {
    if (!box) return;
    const ids = t.roster.filter(p => p.id > 0).map(p => p.id);
    const key = ids.join(",");
    if (NEWS.seen == null) { NEWS.seen = store.get("news-seen", 0); store.set("news-seen", Date.now()); }
    if (NEWS.key !== key || Date.now() - NEWS.at > 10 * 60e3) {
      try {
        const r = await fetch("https://site.api.espn.com/apis/fantasy/v2/games/ffl/news/players?limit=100&" + ids.map(id => "playerId=" + id).join("&"));
        const d = await r.json();
        NEWS.items = (d.feed || []).filter(a => a.type === "Rotowire" && a.headline && a.playerId);
        NEWS.at = Date.now(); NEWS.key = key;
      } catch (_) {
        if (!NEWS.items) { box.innerHTML = '<div class="panel">Couldn\'t reach ESPN for news. Try again in a bit.</div>'; return; }
      }
    }
    if (!box.isConnected) return;
    const byId = Object.fromEntries(t.roster.map(p => [p.id, p]));
    const cutoff = Date.now() - 14 * 864e5, per = {};
    const items = NEWS.items.filter(a => byId[a.playerId] && Date.parse(a.published) >= cutoff)
      .sort((a, b) => Date.parse(b.published) - Date.parse(a.published))
      .filter(a => (per[a.playerId] = (per[a.playerId] || 0) + 1) <= 3);
    if (!items.length) { box.innerHTML = '<div class="panel">No news on your players in the last two weeks.</div>'; return; }
    const ago = ms => { const m = Math.round((Date.now() - ms) / 60e3); return m < 60 ? `${Math.max(1, m)}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
    const row = a => {
      const p = byId[a.playerId], when = Date.parse(a.published), isNew = when > NEWS.seen;
      return `<div class="news-item${isNew ? " new" : ""}"><div class="news-top"><span class="slot ${esc(p.pos)}">${esc(p.pos)}</span><b>${esc(p.name)}</b>
        ${isNew ? '<span class="badge new">New</span>' : ""}<span class="news-when muted">${ago(when)}</span></div>
        <p class="news-h">${esc(a.headline)}</p>${a.story ? `<details class="news-more"><summary>More</summary><p>${esc(a.story)}</p></details>` : ""}</div>`;
    };
    const first = items.slice(0, 6), rest = items.slice(6);
    box.innerHTML = `<div class="news-list">${first.map(row).join("")}${rest.length ? `<details class="news-rest"><summary>${rest.length} more</summary>${rest.map(row).join("")}</details>` : ""}</div>`;
  }

  // ---------------------------------------------------------------- waiver targets (My team)
  // Free agents / players on waivers compared with your roster, using the same weekly projections as power value
  // (ESPN's rest-of-season projection spread over the weeks each player is expected to play: byes and injuries out).
  function waiverTargets(t) {
    const FA = D.freeAgents;
    const pw = L.waiverWeeks || L.powerWeeks;
    if (!L.isCurrent || L.over || !FA || !FA.length || !pw) return "";
    // start with the current week until its first game kicks off, then look ahead from next week
    const started = (D.nflGames || []).some(g => !g.tbd && g.date && Date.now() >= Date.parse(g.date));
    const from = pw[0] === L.currentWeek && started ? pw[0] + 1 : pw[0];
    const weeks = []; for (let w = from; w <= pw[1]; w++) weeks.push(String(w));
    if (!weeks.length) return "";
    const slots = {}; let flex = 0;
    (D.settings.slots || []).forEach(x => { if (TRADE_POS.includes(x.slot)) slots[x.slot] = x.count; else if (x.slot === "FLEX") flex = x.count; });
    const mine = t.roster.filter(p => TRADE_POS.includes(p.pos)).map(p => ({ id: p.id, name: p.name, pos: p.pos, slot: p.slot, ros: p.ros || 0, injury: p.injury, wk: p.wk || {} }));
    if (!mine.some(p => Object.keys(p.wk).length)) return "";
    const lineup = (pl, w) => {
      const av = pl.filter(p => (p.wk[w] || 0) > 0).sort((a, b) => b.wk[w] - a.wk[w]);
      const used = new Set(); let pts = 0;
      for (const [pos, n] of Object.entries(slots)) av.filter(p => p.pos === pos).slice(0, n).forEach(p => { used.add(p.id); pts += p.wk[w]; });
      av.filter(p => !used.has(p.id) && p.pos !== "QB").slice(0, flex).forEach(p => { used.add(p.id); pts += p.wk[w]; });
      return { pts, used };
    };
    const total = pl => weeks.reduce((n, w) => n + lineup(pl, w).pts, 0);
    const next = weeks[0];
    const base = lineup(mine, next), baseTotal = total(mine);
    // the bench player you'd miss least over the rest of the season (an injured stash with no projection first)
    const bench = mine.filter(p => !base.used.has(p.id));
    const costs = bench.map(b => ({ b, cost: baseTotal - total(mine.filter(p => p !== b)) })).sort((x, y) => x.cost - y.cost || x.b.ros - y.b.ros);
    const drop = costs.length ? costs[0].b : null;
    const pool = FA.filter(f => TRADE_POS.includes(f.pos));
    const tag = f => `${f.waivers ? '<span class="badge">Waivers</span>' : '<span class="badge new">Free agent</span>'}${f.injury ? ` <span class="badge cold">${esc(f.injury.replace(/_/g, " ").toLowerCase())}</span>` : ""}`;
    const who = f => `<span class="slot ${esc(f.pos)}">${esc(f.pos)}</span><span class="pick-name"><b>${esc(f.name)}</b> ${tag(f)}${usageChips(f.id)}`;
    const out = (before, after, pl) => { const gone = [...before.used].filter(id => !after.used.has(id)); const p = pl.find(x => x.id === gone[0]); return p ? p.name : null; };
    // 1. next week
    const thisWeek = pool.map(f => { const after = lineup(mine.concat(f), next); return { f, gain: after.pts - base.pts, over: out(base, after, mine) }; })
      .filter(x => x.gain >= 1).sort((a, b) => b.gain - a.gain).slice(0, 4);
    // 2. rest of season, with the drop
    const keep = drop ? mine.filter(p => p !== drop) : mine;
    // only players who help in 2+ weeks: a one-week bye fill-in belongs in "short-handed weeks" below
    const keepWk = Object.fromEntries(weeks.map(w => [w, lineup(keep, w).pts]));
    const ros = pool.map(f => {
      const pl = keep.concat(f);
      const helps = weeks.filter(w => lineup(pl, w).pts - keepWk[w] >= 1).length;
      return { f, helps, gain: total(pl) - baseTotal };
    }).filter(x => x.gain >= 3 && x.helps >= 2).sort((a, b) => b.gain - a.gain).slice(0, 4);
    // 3. short-handed weeks ahead (byes / injuries), the best fill-in for each
    const full = Math.max(...weeks.map(w => lineup(mine, w).pts));
    // starters (as of next week) who are out a later week, and the best pickup at each position that's short
    const holes = weeks.slice(1, 6).map(w => {
      const have = lineup(mine, w), missing = mine.filter(p => base.used.has(p.id) && !(p.wk[w] > 0));
      const picks = [...new Set(missing.map(p => p.pos))].map(pos => pool.filter(f => f.pos === pos)
        .map(f => ({ f, gain: lineup(mine.concat(f), w).pts - have.pts })).sort((a, b) => b.gain - a.gain)[0]).filter(x => x && x.gain >= 2);
      return { w, missing, picks };
    }).filter(h => h.missing.length && h.picks.length);
    const line = (x, w, extra) => `<div class="pick wv-row">${who(x.f)}<span class="team-mgr">${esc(x.f.team)} · ${extra}</span></span><span class="pick-v"><b class="pos">+${x.gain.toFixed(1)}</b></span></div>`;
    const proj = (f, w) => (f.wk[w] || 0).toFixed(1);
    const nothing = msg => `<p class="muted wv-none">${msg}</p>`;
    const body = `
      <h3 class="wv-h">Up next: week ${next}</h3>
      ${thisWeek.length ? thisWeek.map(x => line(x, next, `proj ${proj(x.f, next)}${x.over ? ` · starts over ${esc(x.over)}` : ""}`)).join("") : nothing("Nobody available would beat your starters this week.")}
      <h3 class="wv-h">Rest of season</h3>
      ${ros.length ? ros.map(x => line(x, null, `${x.f.ros.toFixed(0)} ROS pts${x.f.bye && x.f.bye >= Number(weeks[0]) ? ` · bye wk ${x.f.bye}` : ""}`)).join("") : nothing("No pickup would add much over your current roster.")}
      ${drop ? `<p class="note wv-drop">Easiest drop: <b>${esc(drop.name)}</b> (${esc(drop.pos)}${drop.injury ? ", " + esc(drop.injury.replace(/_/g, " ").toLowerCase()) : ""}, ${drop.ros.toFixed(0)} ROS): ${costs[0].cost < 0.5 ? "your best lineup wouldn't miss him" : `costs your best lineup ${costs[0].cost.toFixed(1)} pts the rest of the way`}.</p>` : ""}
      ${holes.length ? `<h3 class="wv-h">Short-handed weeks ahead</h3>${holes.map(h => `<p class="wv-week"><b>Week ${h.w}</b> · out: ${esc(h.missing.map(p => `${p.name} (${p.pos})`).join(", "))}</p>` +
        h.picks.map(x => line(x, h.w, `${esc(x.f.pos)} fill-in for week ${h.w} · proj ${proj(x.f, h.w)}`)).join("")).join("")}` : ""}`;
    // kickers and defenses: a warning when yours is out (bye) next week or soon, and a stream only when a free agent
    // is projected clearly better next week (+3 for a defense, +2 for a kicker: their weeks swing a lot)
    const KD = [["D/ST", 16, 3, "defense"], ["K", 17, 2, "kicker"]];
    const when = f => f.waivers ? "on waivers: put in a claim before it clears" : "free agent: add now";
    const kdLine = (f, w, gainTxt, extra) => `<div class="pick wv-row">${who(f)}<span class="team-mgr">${esc(f.team)}${f.opp && f.opp[w] ? " " + esc(f.opp[w]) : ""} · proj ${proj(f, w)} · ${when(f)}${extra ? " · " + extra : ""}</span></span><span class="pick-v">${gainTxt}</span></div>`;
    let kdHtml = "";
    KD.forEach(([pos, , edge, word]) => {
      const need = (D.settings.slots || []).some(x => x.slot === pos && x.count > 0);
      if (!need) return;
      const have = t.roster.filter(p => p.pos === pos);
      const fas = FA.filter(f => f.pos === pos);
      if (!fas.length) return;
      const best = w => fas.slice().sort((a, b) => (b.wk[w] || 0) - (a.wk[w] || 0)).filter(f => (f.wk[w] || 0) > 0);
      const mineBest = w => have.reduce((m, p) => ((p.wk || {})[w] || 0) > ((m && m.wk[w]) || 0) ? p : m, null);
      const cur = mineBest(next), curPts = cur ? cur.wk[next] : 0;
      const label = have.length ? have.map(p => p.name).join(" / ") : `no ${word}`;
      if (!curPts) {
        kdHtml += `<p class="wv-week wv-alert"><b>You need a ${word} for week ${next}</b> · ${esc(label)}${have.length ? " " + (have.length === 1 ? "is" : "are") + " out (bye or not playing)" : ""}</p>` +
          best(next).slice(0, 3).map(f => kdLine(f, next, `<b class="pos">${proj(f, next)}</b>`)).join("");
      } else {
        const top = best(next)[0];
        if (top && top.wk[next] - curPts >= edge) {
          const swap = have.length > 1 ? `drop ${esc(have.slice().sort((a, b) => ((a.wk || {})[next] || 0) - ((b.wk || {})[next] || 0))[0].name)}` : `swap out ${esc(cur.name)}`;
          kdHtml += `<p class="wv-week">Stream a ${word} for week ${next}: yours, ${esc(cur.name)}${cur.opp && cur.opp[next] ? " " + esc(cur.opp[next]) : ""}, is projected ${curPts.toFixed(1)}</p>` +
            kdLine(top, next, `<b class="pos">+${(top.wk[next] - curPts).toFixed(1)}</b>`, swap);
        }
      }
      // the next 3 weeks after that: byes coming up
      weeks.slice(1, 4).forEach(w => {
        const m = mineBest(w);
        if (m && m.wk[w] > 0) return;
        const pick = best(w)[0];
        if (!pick) return;
        kdHtml += `<p class="wv-week"><b>Week ${w}</b> · ${esc(label)} on bye: plan a ${word}</p>` + kdLine(pick, w, `<b class="pos">${proj(pick, w)}</b>`);
      });
    });
    const kdBlock = kdHtml ? `<h3 class="wv-h">Kickers & defenses</h3>${kdHtml}` : `<h3 class="wv-h">Kickers & defenses</h3>${nothing(`Your kicker and defense are set for week ${next}; no free agent is projected clearly better (+2 K, +3 D/ST).`)}`;

    return section("Waiver targets", { short: "Pickups that would improve your lineup, by projected points.", full: `Free agents and players on waivers compared with your roster, using the same weekly projections as power value: ESPN's rest-of-season projection, minus byes and expected injury time. <b>+points</b> is how much your best lineup gains (that week, or added up over weeks ${weeks[0]}–${weeks[weeks.length - 1]} for rest of season, after dropping the suggested player). Rest of season only lists players who'd improve your lineup in at least two weeks; a one-week bye fill-in shows under short-handed weeks instead. Kickers and defenses use ESPN's matchup projection for each week: you're warned when yours is on bye, and a stream is suggested only when a free agent is projected at least 3 points (defense) or 2 points (kicker) better. Updates with every site refresh; claims are made in the ESPN app.` },
      `<div class="picks wv">${body}${kdBlock}<div class="me-fix">Claims are made on ESPN.${espnBtn(ESPN_ADD(), "Claim on ESPN")}</div></div>`);
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
    alertsResync();
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

  // ---------------------------------------------------------------- what's new
  // Every feature added to the site, grouped by the day it went live (newest first). Add new features at the top.
  // [title, where it lives, one-line description, link]
  const CHANGELOG = [
    ["2026-11-25", [
      ["One week across Matchups", "Matchups → Weekly, Big plays, Watch guide", "The week you pick now carries over to Big plays and the Watch guide, each with its own week strip. Earlier weeks show that week's big plays and the games that mattered most.", "#/matchups/plays"],
    ]],
    ["2026-11-24", [
      ["League Wrapped", "History → Wrapped", "Every manager's season as a story: your road through the standings, how it ended, guess your MVP, your top 5, this or that, your position rooms, guess your bench points, the one that got away, your rivals, your manager type and more, with player photos and stats, then a card to share. Past seasons are open now; 2026 opens the day the championship is decided, with an alert. It replaces the Yearbook.", "#/history/wrapped?season=2025"],
      ["Trade impact", "Trades → Trade impact", "Pick two teams and the players each would send: see both teams' best lineups and their playoff, bye and title odds before and after, plus anyone else's odds the trade moves. Linked from Compare players and the Trade block.", "#/trades/impact"],
      ["Playoffs tab", "Playoffs", "Everything about who makes it now lives in its own tab, right of Standings: the playoff picture and tiebreaker race (moved off Standings), playoff and seed odds and the scenario builder (from Insights), and the bracket (from Matchups). It opens on the bracket once the playoffs start.", "#/playoffs"],
      ["Games open Monday night", "Games", "Next week's pick'em, Pick 4, Rank 'em, trivia and Guess the graph now open as soon as the week's last NFL game ends, instead of early Wednesday.", "#/games"],
      ["Bullseye retired", "Games", "Bullseye has been removed from Games.", "#/games"],
      ["Waiver wire challenge retired", "Games → Pick 4", "The free-agents-only version of Pick 4 has been removed; Pick 4 itself is unchanged.", "#/games/pick4"],
      ["Rain from ESPN", "Watch guide, player card, lineup check", "Game conditions now include the condition ESPN reports (such as Showers or Rain), and flag Rain or Snow from it even when the hourly forecast numbers miss it.", "#/matchups/watch"],
      ["Seed odds on phones", "Playoffs → Seed odds", "The seed odds grid was hidden on phones; it now shows, with a narrower team column so seeds 1 through 8 fit on screen.", "#/insights/race?at=seeds"],
      ["Scenario builder", "Playoffs → Scenario builder", "Pick the winner of every game left and watch the standings, seeds, byes and first round update, with ties going to projected points (adjustable). Share a scenario as a link.", "#/insights/race?at=build"],
      ["Season yearbook", "History (replaced by League Wrapped)", "A keepsake for every finished season: the champion, final standings, the bracket, the season's extremes and awards, its spots in the all-time record book, and a page per team. Save it as a PDF or print it.", "#/history/wrapped?season=2025"],
      ["Tiebreaker race", "Playoffs → Picture, My team", "Ties in the standings go to total points. How often the playoff and bye lines come down to points, who's usually in that tie, who wins it, and the points gap now and at projections.", "#/"],
    ]],
    ["2026-11-23", [
      ["Playoff picture", "Playoffs → Picture, My team", "Who's clinched a playoff spot or a bye (IN / BYE tags), who's eliminated (OUT), and exactly which of this week's results would settle it, in plain words.", "#/"],
      ["Red zone alerts", "Settings → Alerts → Live games", "A notification when one of your starters' NFL teams gets inside the 20, once per drive, with the down and distance.", "#/settings?at=alerts"],
      ["Left the game", "Player card, box scores, Settings → Alerts", "When a starter is hurt during his game (questionable to return, ruled out, being evaluated), an alert, a HURT tag in box scores and the news on his player card; another alert if he comes back.", "#/settings?at=alerts"],
      ["Game conditions", "Watch guide, player card, lineup check", "Weather at kickoff for outdoor games (temperature, wind, rain, snow), flagged when it's bad enough to matter for kickers, passing or everyone.", "#/matchups/watch"],
    ]],
    ["2026-11-22", [
      ["Follow the game", "Any player card (tap a player in a box score), Matchups → Watch guide", "This week's players show their real NFL game, live or upcoming, with links to open it in the Real app or ESPN Gamecast. Every game in the Watch guide has the same links, and each big play links to that exact play on Real when Real lists it among the game's top plays (otherwise to the game).", "#/matchups/watch"],
    ]],
    ["2026-11-17", [
      ["Who to root for", "Matchups · My team", "The other games this week that change your playoff (or bye) odds, how much each result is worth, and how they're going live.", "#/matchups"],
      ["Your manager style", "My team", "How you actually run your team, from ESPN's log of every move: pickups, lineup changes, gut calls, when you make moves, boiled down to a type like \"Late-night waiver hawk\".", "#/myteam"],
      ["Butterfly effect", "Insights → What ifs", "Take away any single pickup, drop or trade and replay the season without it: which games flip and where everyone would stand.", "#/insights/whatif?at=butterfly"],
      ["Getting started tour", "Opens on a first visit · Settings → Display", "Five short steps for anyone new: what the site is, claim your team, turn on alerts, where everything lives, and the league games. Replay it any time from Settings.", "#/settings"],
    ]],
    ["2026-11-15", [
      ["Big plays by position", "Matchups → Big plays → Season", "The player leaderboard is now split by position (QB, RB, WR, TE, K, D/ST), top 10 each, since quarterbacks filled the whole list.", "#/matchups/plays?view=season"],
    ]],
    ["2026-11-14", [
      ["Usage, roles and practice reports", "My team, Waiver targets, Trade block, Insights → Luck", "▲ Due / ▼ Hot tags from expected fantasy points, Role ↑/↓ from snap and target share, this week's practice reports, a usage strip in the player card, and Vs. usage under Luck.", "#/insights/luck?at=usage"],
      ["Tale of the tape", "History → Tale of the tape", "Any two managers side by side across every season: win %, titles, average finish, best season, longest win streak, every head-to-head meeting and common opponents.", "#/history/h2h"],
      ["Injury toll", "Insights → Luck", "Points each team lost to its starters missing games, and its costliest injuries.", "#/insights/luck?at=injury"],
      ["One view at a time in Insights", "Insights", "Each Insights tab now has a switch at the top (like Pick 4's) instead of one long scroll.", "#/insights"],
      ["Trash talk", "Matchups, recaps, Trades", "Comment threads under every matchup, weekly recap and trade, posted as your team. Get an alert when someone posts on your matchup.", "#/matchups"],
      ["Game-day alerts", "Settings → Alerts", "Phone and browser notifications for lead changes, close finishes, final results, big plays, starters ruled out before kickoff, waiver results and trades. Pick which ones you want.", "#/settings"],
      ["Seed odds", "Insights → Playoff race", "Every team's chance of finishing at each seed, 1 through 12.", "#/insights/race?at=seeds"],
      ["Big plays: season", "Matchups → Big plays → Season", "Big plays added up by team and player, plus the biggest single plays of the season.", "#/matchups/plays?view=season"],
      ["Feedback box", "Header → Feedback", "Send the commissioner an idea or a problem report, privately.", "#/feedback"],
      ["Guess the graph", "Games → Guess the graph", "Whose season is this? Three bar charts of a player's weekly points every week (Easy, Medium, Hard); pick him from four names.", "#/games/graph"],
      ["Why you moved", "Standings, My team", "What changed a team's power value this week: injuries, roster moves, projection changes. ▲/▼ shows the power rank change.", "#/myteam"],
      ["Nemesis players", "History → Record book, My team", "The NFL players who've scored the most against you, all-time.", "#/history/records"],
      ["Career luck", "History", "Every manager's luck across every season: actual wins vs. the wins their scoring deserved.", "#/history"],
      ["Bullseye", "Games (retired November 2026)", "A new target every week: pick up to 5 players whose points add up as close to it as you can without going over.", "#/games"],
      ["Rank 'em", "Games → Rank 'em", "Put five players at one position in order of the points they'll score. 3 points per exact spot, 1 for one off.", "#/games/rankem"],
      ["Reactions", "Matchups, Big plays, Standings", "Tap an emoji under any matchup, big play or the weekly high and low score. Hold one to see who reacted.", "#/matchups"],
      ["Upset tracker", "Insights → Luck", "Every team's record as ESPN's favorite and as the underdog, with its biggest upset and worst loss.", "#/insights/luck?at=upsets"],
      ["Starters who beat it", "Insights → Luck → Vs. projection", "How often each team's individual starters outscore their own projection.", "#/insights/luck?at=projection"],
      ["Customize My team", "My team", "Reorder or hide the sections on My team. Saved on your device.", "#/myteam"],
      ["Fix it on ESPN", "My team", "A lineup check under your matchup, plus buttons that open the exact ESPN page to fix a lineup or claim a player.", "#/myteam"],
      ["Glossary", "Footer, every ⓘ", "Every stat and term on the site in one searchable page.", "#/glossary"],
      ["League pulse", "Standings", "What people have been up to on the site: reactions, game entries and trade block updates (never anyone's picks).", "#/"],
      ["Compact mode", "Settings → Display", "Tighter tables, cards and spacing so more fits on screen, with one-line explanations. Saved on your device.", "#/settings"],
    ]],
    ["2026-11-13", [
      ["Pick 4 prices follow the news", "Games → Pick 4", "Prices update every 30 minutes with ESPN's projections and injury news (Q / D / OUT tags, ▲/▼ since the week opened). Players already in your lineup keep the price you paid; the waiver wire list updates as players are dropped and picked up.", "#/games/pick4"],
      ["Trivia from easy to expert", "Games → League trivia", "Starting week 11, the 5 questions go in order of difficulty, Easy to Expert, and never repeat a question from earlier in the season.", "#/games/trivia"],
      ["Waiver wire challenge", "Games (retired November 2026)", "Pick 4 with only players who are free agents in our league: a weekly hunt for the pickups worth adding.", "#/games/pick4"],
      ["Pick 4", "Games → Pick 4", "A weekly side game: a QB, RB, WR and TE from any NFL team under a salary cap, scored with this week's real points. Each spot locks at its player's kickoff.", "#/games/pick4"],
      ["Insights regrouped", "Insights", "14 sub-tabs became 6 pages: Playoff race (with Hot & cold), Luck (with Close games and Vs. projection), Schedule (with Byes ahead), Lineups, Draft (grades or the hindsight redraft) and What ifs (Rules lab and Schedule swap). Player history moved to History. Old links still work.", "#/insights"],
      ["What's new", "this page", "Every feature added to the site, by day. A dot on the header link means something's new since your last look.", "#/whatsnew"],
      ["You vs. autopilot", "Insights → Lineups", "Your real lineups compared with the lineup ESPN's projections would have started from the same roster, and the games your calls swung.", "#/insights/lineups?at=autopilot"],
      ["Player news", "My team", "ESPN's latest news on your players (injuries, practice reports, game lines), with what's new since your last visit marked.", "#/myteam"],
      ["Games tab", "new tab", "Pick'em moved here from Matchups, next to the new trivia.", "#/games"],
      ["League trivia", "Games → League trivia", "5 questions a week about your league's own history. One try, same name and PIN as pick'em, season leaderboard.", "#/games/trivia"],
    ]],
    ["2026-11-11", [
      ["Waiver targets: smarter rest of season", "My team", "Rest of season only lists pickups that help in 2+ weeks; one-week bye fill-ins stay under short-handed weeks.", "#/myteam"],
    ]],
    ["2026-11-10", [
      ["Waiver targets", "My team", "Free agents that would improve your lineup next week and for the rest of the season, the easiest drop, and fill-ins for short-handed weeks.", "#/myteam"],
      ["Kicker & defense alerts", "My team → Waiver targets", "Warnings when your kicker or defense has a bye, with the best replacements, and streams only when one is clearly better.", "#/myteam"],
      ["Compare players", "Trades → Compare players", "Any two players side by side, week by week, under your league's scoring.", "#/trades/compare"],
      ["Personal record books", "History → Record book, My team", "Pick any manager to see their own bests and worsts; your top marks show as tiles on My team.", "#/history/records"],
      ["Player history", "History → Player history", "Search any player to see every league team he's been on, how he got there and how he left.", "#/history/players"],
      ["Pick'em matchup cards", "Games → Pick'em", "Each matchup in its own labeled card so it's clear who's playing who.", "#/games"],
      ["Odds bars to scale", "Insights → Playoff race", "Playoff, bye and title bars are now as long as their percentage.", "#/insights/race"],
    ]],
    ["2026-11-09", [
      ["Rules lab", "Insights → What ifs", "This season under half-PPR, full PPR, standard, a median-win format and best ball.", "#/insights/whatif?at=rules"],
      ["Hindsight redraft", "Insights → Draft", "Your draft redone knowing how every player has actually played.", "#/insights/draft?view=redraft"],
      ["Badges", "History → Badges, My team", "18 achievements earned across every season.", "#/history/badges"],
      ["Monday-night math", "Matchups", "What each team needs from its Monday players, or whether the game is already locked up.", "#/matchups"],
      ["This week in league history", "Matchups", "The same week's big moments from past seasons.", "#/matchups"],
      ["Watch the play", "Matchups → Big plays", "Highlight clips from ESPN on big plays.", "#/matchups/plays"],
      ["Live score ticker", "bottom of every page", "Every matchup's score while NFL games are on.", "#/matchups"],
    ]],
    ["2026-11-08", [
      ["Big plays", "Matchups → Big plays", "Every touchdown, turnover and big gain this week with the fantasy points each play was worth, grouped by NFL game or by matchup.", "#/matchups/plays"],
      ["Opens where the action is", "", "The site opens on Matchups on NFL game days and on Standings otherwise.", "#/"],
    ]],
    ["2026-11-07", [
      ["Live scores", "Matchups", "Scores update every minute during games.", "#/matchups"],
      ["Weekly pick'em", "Games → Pick'em", "Pick a winner for every matchup each week; picks lock at the first kickoff.", "#/games"],
      ["My team", "My team", "Your matchup, standing, odds, schedule, roster and games to watch, all in one place.", "#/myteam"],
      ["Watch guide", "Matchups → Watch guide", "Which real NFL games matter most to the league this week.", "#/matchups/watch"],
      ["Playoff bracket", "Matchups → Playoff bracket", "The bracket, plus shareable image cards.", "#/matchups/bracket"],
      ["Player stat lines", "any box score", "Tap a player to see his stat line and how each stat scored.", "#/matchups"],
      ["Trade block", "Trades → Trade block", "Who's shopping whom, and what each team needs.", "#/trades/block"],
      ["Schedule swap", "Insights → What ifs", "Every team's record on every other team's schedule.", "#/insights/whatif?at=swap"],
      ["Hot & cold, Vs. projection, Close games", "Insights → Playoff race, Luck", "Who's surging, who's beating ESPN's projections, and records in games decided by under 10.", "#/insights/race?at=form"],
      ["Byes ahead", "Insights → Schedule", "Upcoming weeks where byes hurt each team most.", "#/insights/schedule?at=byes"],
      ["Since your last visit", "Standings", "A summary card of what changed since you last opened the site.", "#/"],
      ["League settings", "Settings", "Your league's scoring, roster spots, playoff format and key dates.", "#/settings"],
      ["Works offline", "home-screen app", "Pages and data are saved on your phone, with pull to refresh.", "#/"],
    ]],
    ["2026-11-06", [
      ["League HQ launches", "", "Standings, matchups with box scores, and trade history.", "#/"],
      ["Power rankings", "Standings", "Each team's projected strength for the rest of the season, with position-by-position bars.", "#/"],
      ["Playoff odds, Luck, Efficiency, Schedule, Draft", "Insights", "Playoff chances from a season simulation, all-play luck, lineup efficiency, schedule strength and draft grades.", "#/insights/race"],
      ["Trade grades", "Trades", "How each trade has worked out for both sides.", "#/trades"],
      ["Past seasons & History", "History", "Every season since 2023: champions, head-to-head records, rivalries and the record book.", "#/history"],
      ["Phone layout", "everywhere", "A bottom tab bar, card tables and an installable home-screen app.", "#/"],
    ]],
  ];
  const WN_LATEST = CHANGELOG[0][0];
  function updateWhatsNewDot() {
    const dot = document.querySelector(".hdr-dot");
    if (dot) dot.hidden = store.get("wn-seen", "") >= WN_LATEST;
  }
  function renderWhatsNew() {
    const seen = store.get("wn-seen", "");
    store.set("wn-seen", WN_LATEST);
    updateWhatsNewDot();
    const day = d => new Date(d + "T12:00:00").toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    const n = CHANGELOG.reduce((k, [, items]) => k + items.length, 0);
    main.innerHTML = `<div class="section-head"><div><h1>What's new</h1><p class="sub">Everything added to the site, newest first (${n} features so far).</p></div></div>
      <a class="wn-fb" href="#/feedback"><span><b>Have an idea, or spotted a problem?</b><span class="team-mgr">Tell the commissioner privately. Nobody else sees it.</span></span><span class="wn-fb-go">Suggest something →</span></a>` +
      CHANGELOG.map(([d, items]) => `<section class="wn-day"><h2>${esc(day(d))}${seen && d > seen ? ' <span class="badge new">New</span>' : ""}<span class="team-mgr">${items.length} ${items.length === 1 ? "addition" : "additions"}</span></h2>
        <ul class="wn-list">${items.map(([title, where, desc, link]) => `<li><a href="${esc(link)}">${esc(title)}</a>${where ? `<span class="wn-where">${esc(where)}</span>` : ""}<p>${esc(desc)}</p></li>`).join("")}</ul></section>`).join("");
  }

  // ---------------------------------------------------------------- glossary
  // [id, term, where it lives, link, explanation, section titles whose ⓘ links here]
  const GLOSSARY = [
    ["Standings & power", [
      ["power", "Power value", "Standings", "#/", "How many points a team's starting lineup is expected to score over the rest of the fantasy season. Each remaining week starts the best available lineup by ESPN's projections (skipping byes and players expected to miss time) and the season is replayed 500 times with random injuries, so bench players count as often as they'd really play. Kickers and defenses are left out.", []],
      ["powerrank", "Power rank", "Standings", "#/", "Teams ordered by power value. #1 has the strongest expected lineup for the rest of the season.", []],
      ["posbars", "Position bars", "Standings", "#/", "Each team's rank at QB, RB, WR and TE: expected points from its best QB, 3 RBs, 3 WRs (two spots plus FLEX) and TE each week. After the season, what those groups actually produced.", []],
      ["moved", "Why you moved", "Standings → team cards, My team", "#/myteam", "How much each change since the current power window started (about once a week) added to or cost a team's power value: injuries, roster moves (added, dropped, traded), ESPN projection changes, and the lineup reshuffle those cause. ▲/▼ next to a power rank is the change over the same stretch.", ["Why your power moved"]],
      ["starts", "Starts X of Y wks", "Standings → team cards", "#/", "How often a player makes his team's best projected lineup in the weeks left.", []],
      ["odds", "Playoff and title odds", "Playoffs → Odds", "#/playoffs/odds", "From 10,000 simulated finishes of the regular season and the bracket. This week's games use ESPN's live win probabilities.", ["Playoff race"]],
      ["seeds", "Seed odds", "Playoffs → Seed odds", "#/playoffs/seeds", "Each team's chance of finishing the regular season at every seed, from the same 10,000 simulations as the playoff odds. Darker cells are likelier; lines mark the bye and playoff cuts.", ["Seed odds"]],
      ["form", "Hot & cold", "Insights → Hot & cold", "#/insights/form", "Each team's average over the last few completed weeks vs. its season average, with the league-wide swing taken out (Trend).", ["Hot & cold"]],
    ]],
    ["Luck & schedule", [
      ["allplay", "All-play record", "Insights → Luck", "#/insights/luck", "The record a team would have if it played every other team every week.", []],
      ["luck", "Luck and expected wins", "Insights → Luck", "#/insights/luck", "Expected wins are the wins a team's all-play rate predicts. Luck is actual wins minus expected wins: positive means more wins than its scoring deserved.", ["Luck"]],
      ["close", "Close games", "Insights → Luck", "#/insights/luck?at=close", "Records in regular-season games decided by under 10 points, which usually come down to one play.", ["Close games"]],
      ["upsets", "Upset tracker (favorite / underdog)", "Insights → Luck", "#/insights/luck?at=upsets", "Before each game, the team whose starting lineup ESPN projected for more points is the favorite. Each team's records as favorite and underdog, net upsets (upset wins minus upset losses), its biggest upset win and its worst loss as a favorite.", ["Upset tracker"]],
      ["vsproj", "Vs. projection", "Insights → Luck", "#/insights/luck?at=projection", "Points a team's starters scored compared with ESPN's pre-game projection for that same lineup. About how the players performed, not lineup choices or opponents.", ["Vs. projection"]],
      ["usage", "Vs. usage (expected points)", "Insights → Luck → Vs. usage", "#/insights/luck?at=usage", "Fantasy points compared with expected points: what a player's exact usage (targets, carries, air yards, field position) scores on average, from nflverse's ffopportunity model, in standard PPR scoring. Above it usually doesn't last; below it usually bounces back.", ["Vs. usage"]],
      ["duehot", "▲ Due / ▼ Hot", "My team, Waiver targets, Trade block", "#/insights/luck?at=usage", "A player scoring 3+ points a game below (Due) or above (Hot) what his usage was worth over his last 5 games, with at least 3 games played.", []],
      ["role", "Role ↑ / Role ↓", "My team, Waiver targets, Trade block", "#/myteam", "His last 2 games vs. the 3 before: snap share up or down 15+ points, or target share up or down 8+ points. Often the first sign a player gained or lost a job. Not shown for quarterbacks.", []],
      ["practice", "Practice report", "My team, lineup check, Alerts", "#/myteam", "This week's official NFL injury report: practice participation (did not practice, limited, full), the game status once it's set (Questionable, Doubtful, Out) and the injury. The site logs how it changes day to day.", []],
      ["injury", "Injury toll", "Insights → Luck → Injury toll", "#/insights/luck?at=injury", "Points a team lost to its starters missing games: each game a player who was starting for it sat out (his NFL team played, he recorded no stats), valued at what he'd averaged before. It's the player's usual output, before counting his replacement.", ["Injury toll"]],
      ["beatit", "Starters who beat it", "Insights → Luck → Vs. projection", "#/insights/luck?at=projection", "The share of a team's individual starts where the player outscored his own projection. A big difference from a low share means a few huge games; a high share means the whole lineup is beating expectations.", []],
      ["sos", "Strength of schedule", "Insights → Schedule", "#/insights/schedule", "How much a team's opponents score per week vs. the league average (#1 = toughest), how they scored against you, and the projected strength of the opponents left.", ["Strength of schedule"]],
      ["byes", "Byes ahead", "Insights → Schedule, My team", "#/insights/schedule?at=byes", "Projected points a team's best lineup loses in each remaining week because starters are on bye or expected to miss the game. Bench depth counts.", ["Byes ahead"]],
    ]],
    ["Lineups & draft", [
      ["efficiency", "Manager efficiency", "Insights → Lineups", "#/insights/lineups", "Points started as a share of the best possible lineup each week, in hindsight.", ["Manager efficiency"]],
      ["benchleft", "Points left on the bench", "My team, Insights → Lineups", "#/insights/lineups", "How many more points the best possible lineup would have scored than the one started.", []],
      ["autopilot", "You vs. autopilot", "Insights → Lineups", "#/insights/lineups?at=autopilot", "Autopilot starts the best lineup by ESPN's pre-game projections from your roster every week. Your calls is how many more (or fewer) points your real lineups scored; games swung counts games your calls won or lost compared with autopilot.", ["You vs. autopilot"]],
      ["draftgrade", "Draft grades, steals and busts", "Insights → Draft", "#/insights/draft", "Each pick compared with same-position players drafted around the same spot, using points scored. Kickers and defenses aren't graded.", ["Draft grades", "Steals", "Busts"]],
      ["redraft", "Hindsight redraft", "Insights → Draft", "#/insights/draft?view=redraft", "The draft redone knowing every player's points: each pick takes the most valuable player left, measured as points above a replacement-level player at his position.", ["Hindsight redraft"]],
    ]],
    ["What ifs", [
      ["rules", "Rules lab", "Insights → What ifs", "#/insights/whatif", "This season's standings under other scoring and formats (PPR, half PPR, standard, a median game, best ball), with the same lineups and real stats rescored.", ["Rules lab"]],
      ["careerluck", "Career luck", "History → Champions & standings", "#/history", "Each manager's regular-season wins minus the wins their all-play record predicts, added up across every season they've played.", ["Career luck"]],
      ["nemesis", "Nemesis players", "History → Record book, My team", "#/history/records", "The NFL players who've scored the most points against you all-time, counting only games where they were in your opponent's starting lineup.", []],
      ["swap", "Schedule swap", "Insights → What ifs", "#/insights/whatif?at=swap", "Each team's record if it had played every other team's schedule, using its real weekly scores.", ["Schedule swap"]],
    ]],
    ["My team & trades", [
      ["waivers", "Waiver targets", "My team", "#/myteam", "Free agents that would improve your best lineup next week or over the rest of the season (2+ weeks), using ESPN's projections, with the easiest drop. Kicker and defense streams only when clearly better.", ["Waiver targets"]],
      ["ros", "ROS rank and points", "My team → Roster", "#/myteam", "Rest-of-season position rank and projected points from ESPN.", []],
      ["block", "Trade block", "Trades → Trade block", "#/trades/block", "Players each team is shopping and the positions it needs, with possible fits between teams.", ["Listings", "Possible fits"]],
    ]],
    ["Matchups", [
      ["winprob", "Win probability", "Matchups", "#/matchups", "ESPN's live chance each team wins its matchup, shown while the week is in progress.", []],
      ["bigplays", "Big plays", "Matchups → Big plays", "#/matchups/plays", "Touchdowns, 5+ point field goals, turnovers, big defensive plays and 30+ yard gains (50+ for a pass) by league players, caught from ESPN every minute during games, with the fantasy points that play was worth. The Season view adds them up by team and player since the feed started.", ["Team leaderboard"]],
      ["monday", "Monday-night math", "Matchups", "#/matchups", "Once a matchup is down to players in games that haven't started, what each side needs and a win chance from those players' own game logs.", []],
      ["tradeimpact", "Trade impact", "Trades → Trade impact", "#/trades/impact", "What a trade would do to both teams: each one's best weekly lineup (QB, RB, WR, TE, FLEX by expected points, byes and injuries included) with and without it, and their playoff, bye and title odds from 10,000 simulations of the rest of the season and the bracket, run both ways with the same random draws. Half of the lineup change counts, the same pull toward the league average the playoff odds use. Kickers and defenses aren't counted.", ["Trade impact"]],
      ["build", "Scenario builder", "Playoffs → Scenario builder", "#/playoffs/scenarios", "Pick a winner for every regular-season game left and see the final standings, seeds, byes and first round. It starts from the favorites (ESPN's live win odds this week, the playoff odds' scoring model after). Teams level on wins are ordered by projected final points, which can be adjusted. The picks are saved in the link, so a scenario can be shared.", ["Scenario builder"]],
      ["tierace", "Tiebreaker race", "Playoffs → Picture, My team", "#/playoffs/picture", "Teams level on wins are separated by total points. From the playoff-odds simulations: how often a team ends level on wins with someone across the playoff (or bye) line (In a tie), how often it comes out ahead when that happens (Wins it), its projected final points, and the pairs that meet in that tie most often, with the gap now and at projections.", ["Tiebreaker race"]],
      ["clinch", "Clinched / eliminated", "Playoffs → Picture, My team", "#/playoffs/picture", "Exact, from the remaining schedule: clinched only if no combination of results can push a team out of the playoff spots (or bye spots), eliminated only if none can get it in. Points tiebreakers are treated as unknown (against a team for clinching, for it for elimination). The week's scenarios are the fewest results that settle it, whatever happens after.", ["Playoff picture"]],
      ["conditions", "Game conditions", "Watch guide, player card, lineup check", "#/matchups/watch", "Forecast for the first 3 hours of each outdoor game (Open-Meteo): temperature, wind and gusts, chance and amount of rain or snow, plus the condition ESPN reports (such as Showers). Flags: Windy (15+ mph or gusts 25+; hurts kickers and passing), Rain (likely, 0.1+ inch, or ESPN reports rain, showers or storms), Snow (0.2+ inch, or ESPN reports snow, flurries or sleet), Frigid (25°F or colder), Hot (88°F+). Domes and roofed stadiums show Indoors.", []],
      ["rootfor", "Who to root for", "Matchups, My team", "#/matchups", "For each of this week's other games, your playoff chance in the simulated seasons where each team won (the same 10,000 seasons as the playoff odds). Root for the team whose win helps you; the number is how many percentage points it's worth. Bye odds instead once you're all but in.", []],
      ["mstyle", "Manager style", "My team", "#/myteam", "How each manager runs a team, from ESPN's log of every move and lineup: pickups, lineup changes, gut calls (starting someone ESPN projected 2+ points below an eligible bench player), how fast pickups get cut, trades, and when moves happen (Eastern time). The type names the two habits that stand out most against the rest of the league.", []],
      ["butterfly", "Butterfly effect", "Insights → What ifs", "#/insights/whatif?at=butterfly", "One move taken out and the regular season replayed: players it brought in leave the lineups they started in, replaced by the best-projected bench player; players it sent away come back with their real points elsewhere and start if projected above the weakest eligible starter. Projections only, no hindsight.", []],
      ["reactions", "Reactions", "Matchups, Big plays, Standings", "#/matchups", "Tap an emoji under a matchup, a big play or the weekly high and low score to react as your team (same name and PIN as the games). Tap again to take it back; hold one to see who reacted.", []],
    ]],
    ["Games", [
      ["pickem", "Pick'em", "Games", "#/games", "Pick the winner of every league matchup before the week's first kickoff.", []],
      ["pick4", "Pick 4", "Games → Pick 4", "#/games/pick4", "Pick a QB, RB, WR and TE under a salary cap. Prices are $400 per projected point and move with the news; each spot locks at its player's kickoff.", []],
      ["rankem", "Rank 'em", "Games → Rank 'em", "#/games/rankem", "Put five players at one position in order of the points they'll score. 3 points per exact spot, 1 for one spot off, 15 max.", []],
      ["graph", "Guess the graph", "Games → Guess the graph", "#/games/graph", "Three graphs a week of one player's weekly fantasy points; pick him from four names. Easy, Medium and Hard are worth 1, 2 and 3 points.", []],
      ["trivia", "League trivia", "Games → League trivia", "#/games/trivia", "Five questions a week about league history, easy to expert. One try each.", []],
      ["pin", "Name and PIN", "Games, My team", "#/games", "Your 4-digit PIN, set the first time you use it, keeps anyone else from playing or reacting as you. One PIN works everywhere on the site.", []],
    ]],
  ];
  const GLOSSARY_BY_TITLE = {};
  GLOSSARY.forEach(([, items]) => items.forEach(([id, , , , , titles]) => titles.forEach(t => { GLOSSARY_BY_TITLE[t] = id; })));
  function renderGlossary() {
    const q = (state.params.get("q") || "").toLowerCase(), focus = state.params.get("t");
    const groups = GLOSSARY.map(([g, items]) => [g, items.filter(([, term, where, , text]) => !q || (term + " " + where + " " + text).toLowerCase().includes(q))]).filter(([, it]) => it.length);
    main.innerHTML = `<div class="section-head"><div><h1>Glossary</h1><p class="sub">Every stat and term on the site in one place. Tap a term's location to go there.</p></div></div>
      <input id="gl-q" type="search" class="gl-q" placeholder="Search terms (e.g. luck, autopilot)" value="${esc(q)}" autocomplete="off">
      ${groups.length ? groups.map(([g, items]) => `<section class="gl-group"><h2>${esc(g)}</h2><dl class="gl-list">${items.map(([id, term, where, link, text]) =>
        `<div class="gl-item${id === focus ? " on" : ""}" id="gl-${id}"><dt>${esc(term)} <a class="gl-where" href="${esc(link)}">${esc(where)} ›</a></dt><dd>${esc(text)}</dd></div>`).join("")}</dl></section>`).join("")
        : '<div class="empty">No terms match.</div>'}`;
    if (focus) { const el = document.getElementById("gl-" + focus); if (el) el.scrollIntoView({ block: "center" }); }
    if (GL_FOCUS) { const qi = document.getElementById("gl-q"); qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); GL_FOCUS = false; }
  }
  let GL_FOCUS = false;
  main.addEventListener("input", e => {
    if (e.target.id !== "gl-q") return;
    GL_FOCUS = true;
    const v = e.target.value.trim();
    history.replaceState(null, "", "#/glossary" + (v ? "?q=" + encodeURIComponent(v) : ""));
    state.params = new URLSearchParams(v ? "q=" + v : "");
    renderGlossary();
  });

  // ---------------------------------------------------------------- feedback box
  // Ideas and problem reports go to the commissioner's private inbox on the live worker (never shown to anyone else).
  // Sent with your name only when you're signed in to the games on this device; otherwise anonymous.
  const FB = { kind: "idea", text: "", anon: false, msg: "", err: false, busy: false, admins: null, inbox: null, from: "" };
  let lastPage = "";
  window.addEventListener("hashchange", e => { const h = (e.oldURL.split("#")[1] || "/"); if (!h.startsWith("/feedback")) lastPage = h; });
  async function renderFeedback() {
    if (FB.admins == null && LIVE_API_BASE()) {
      FB.admins = [];
      pkApi("/feedback").then(r => { FB.admins = (r && r.admins) || []; if (state.tab === "feedback") renderFeedback(); }).catch(() => {});
    }
    if (!FB.from) FB.from = lastPage;
    const signed = PK.member && PK.pin;
    const me = PK.member || ME.member;
    const isAdmin = (FB.admins || []).includes(me);
    const kinds = [["idea", "Idea"], ["problem", "Problem"]].map(([k, lab]) => `<button type="button" class="${FB.kind === k ? "active" : ""}" data-fb-kind="${k}" aria-pressed="${FB.kind === k}">${lab}</button>`).join("");
    const who = signed ? `<label class="fb-anon"><input type="checkbox" id="fb-anon"${FB.anon ? " checked" : ""}> Send anonymously <span class="muted">(otherwise it's from ${esc(nameOfMember(PK.member))})</span></label>`
      : `<p class="note">This sends anonymously. Sign in to any game first if you want your name on it.</p>`;
    let inbox = "";
    if (isAdmin) {
      const list = FB.inbox;
      inbox = section("Commissioner inbox", "Only you can see these.", !list ? `<div class="panel"><button type="button" class="cta fb-open" data-fb="inbox">Open inbox</button></div>`
        : list.length ? `<div class="fb-list">${list.map(x => `<article class="fb-msg"><div class="fb-mh"><span class="badge ${x.kind === "problem" ? "hot" : "new"}">${x.kind === "problem" ? "Problem" : "Idea"}</span>
            <b>${x.from ? esc(nameOfMember(x.from)) : "Anonymous"}</b><span class="team-mgr">${new Date(x.t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}${x.page ? ` · from <a href="#${esc(x.page)}">${esc(x.page)}</a>` : ""}</span>
            <button type="button" class="linkbtn fb-del" data-fb-del="${esc(x.id)}" aria-label="Delete this message">Delete</button></div><p>${esc(x.text).replace(/\n/g, "<br>")}</p></article>`).join("")}</div>`
        : '<div class="panel">No messages yet.</div>');
    }
    main.innerHTML = `<div class="section-head"><div><h1>Suggest something</h1><p class="sub">An idea for the site, or something that looks wrong? It goes straight to the commissioner and nobody else sees it.</p></div></div>
      <form class="panel fb-form" id="fb-form">
        <div class="pg-by fb-kinds" role="group" aria-label="What is it?">${kinds}</div>
        <label class="field fb-text"><span>${FB.kind === "problem" ? "What went wrong, and where?" : "What's your idea?"}</span>
          <textarea id="fb-text" rows="6" maxlength="1500" placeholder="${FB.kind === "problem" ? "e.g. My team's score on Matchups doesn't match ESPN." : "e.g. A page that shows…"}">${esc(FB.text)}</textarea></label>
        ${who}
        <button type="submit" class="cta"${FB.busy ? " disabled" : ""}>${FB.busy ? "Sending…" : "Send"}</button>
        ${FB.msg ? `<p class="pk-msg${FB.err ? " err" : ""}">${esc(FB.msg)}</p>` : ""}
      </form>${inbox}`;
  }
  main.addEventListener("input", e => { if (e.target.id === "fb-text") FB.text = e.target.value; });
  main.addEventListener("change", e => { if (e.target.id === "fb-anon") FB.anon = e.target.checked; });
  main.addEventListener("click", async e => {
    if (state.tab !== "feedback") return;
    const k = e.target.closest("[data-fb-kind]");
    if (k) { FB.kind = k.dataset.fbKind; return renderFeedback(); }
    const del = e.target.closest("[data-fb-del]");
    const open = e.target.closest('[data-fb="inbox"]');
    if (!del && !open) return;
    if (!PK.pin) { FB.msg = "Sign in to any game on this device first (name + PIN), then open the inbox."; FB.err = true; return renderFeedback(); }
    if (del && !confirm("Delete this message? This can't be undone.")) return;
    const r = await pkApi(del ? "/feedback/delete" : "/feedback/inbox", { member: PK.member, pin: PK.pin, id: del && del.dataset.fbDel });
    if (r.error) { FB.msg = r.error; FB.err = true; } else { FB.inbox = r.messages; FB.msg = ""; }
    renderFeedback();
  });
  main.addEventListener("submit", async e => {
    if (e.target.id !== "fb-form") return;
    e.preventDefault();
    FB.text = document.getElementById("fb-text").value;
    if (FB.text.trim().length < 3) { FB.msg = "Write a little more first."; FB.err = true; return renderFeedback(); }
    FB.busy = true; renderFeedback();
    const named = PK.member && PK.pin && !FB.anon;
    const r = await pkApi("/feedback/send", { kind: FB.kind, text: FB.text, page: FB.from, ...(named ? { member: PK.member, pin: PK.pin } : {}) }).catch(() => ({ error: "Couldn't reach the server. Try again." }));
    FB.busy = false;
    if (r.error) { FB.msg = r.error; FB.err = true; }
    else { FB.text = ""; FB.msg = `Sent${named ? "" : " anonymously"}. Thanks!`; FB.err = false; }
    renderFeedback();
  });

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

    const compactOn = document.documentElement.classList.contains("compact");
    const display = `<section class="panel set-display"><label class="set-switch"><input type="checkbox" data-compact${compactOn ? " checked" : ""}>
      <span><b>Compact mode</b><span class="team-mgr">Tighter tables, cards and spacing so more fits on screen, with one-line explanations (tap ⓘ for the rest). Saved on this device.</span></span></label>
      <div class="set-tour"><span><b>Getting started tour</b><span class="team-mgr">Claim your team, turn on alerts, and a quick map of the site.</span></span><button type="button" class="linkbtn" data-tour-start>Take the tour ›</button></div></section>`;
    main.innerHTML = `<div class="section-head"><div><h1>League settings</h1><p class="sub">${L.season} season · straight from ESPN · updated ${esc(ago(D.updated))}</p></div></div>
      <h2 class="set-h">Display</h2>${display}
      <h2 class="set-h" id="alerts">Alerts</h2><section class="panel set-alerts" id="alerts-panel"></section>
      ${glance}
      <h2 class="set-h">Roster & season</h2><div class="rec-grid set-grid">${roster}${schedule}${moves}${draft}</div>
      <h2 class="set-h">Scoring</h2><div class="rec-grid set-grid">${groups.join("")}${other}${dst}</div>`;
    initAlerts();
    if (state.params.get("at") === "alerts") requestAnimationFrame(() => document.getElementById("alerts").scrollIntoView({ block: "start" }));
  }


  // ---------------------------------------------------------------- game-day alerts (Settings → Alerts)
  // Notifications from the live worker (Web Push). Which alerts and the quiet hours are saved on this device and sent
  // to the worker with this browser's subscription; alerts follow the team claimed on My team.
  const ALERT_GROUPS = [
    ["Your matchup", [["lead", "Lead change", "When the lead in your matchup changes hands (at most once every 10 minutes)."],
      ["wire", "Down to the wire", "When your matchup comes down to the last few players, with who's left on each side."],
      ["final", "Final result", "Win or loss, the final score and your new record."],
      ["talk", "Trash talk on your matchup", "When someone posts a comment on your matchup this week."]]],
    ["Live games", [["redzone", "Red zone", "When one of your starters' NFL teams gets inside the 20, once per drive, with the down and distance."],
      ["redzoneAgainst", "Red zone against you", "The same for your opponent's starters."],
      ["hurt", "Left the game", "When one of your starters is hurt during his game (questionable to return, ruled out, being evaluated) and when he comes back."],
      ["hurtAgainst", "Opponent left the game", "The same for your opponent's starters."]]],
    ["Big plays", [["plays", "Your starters' big plays", "Touchdowns, 40+ yard plays, 50+ yard field goals and defensive scores."],
      ["playsAgainst", "Big plays against you", "The same plays by your opponent's starters."],
      ["playsAll", "Every big play in the league", "All of them, for every team. Busy on Sundays."]]],
    ["Your lineup", [["trouble", "Starter in trouble", "90 minutes before kickoff: a starter who's out, on IR, on a bye, or an empty lineup spot."],
      ["practice", "Practice report", "Thursday and Friday evenings: a starter who didn't practice or was limited, or is listed Questionable, Doubtful or Out."]]],
    ["Moves", [["waivers", "Waiver results", "Which claims you won or missed when waivers run."],
      ["trades", "Trades involving your team", "When one goes through."], ["tradesAll", "Any league trade", "Every trade in the league."]]],
    ["Site games", [["picks", "Picks reminder", "3 hours before Pick'em locks and before Sunday's games, if you haven't made your picks."]]],
    ["Season", [["wrapped", "League Wrapped is ready", "Once a season, the day after the championship: your season as a story to watch and share."]]],
  ];
  const ALERT_DEFAULTS = { lead: true, wire: true, final: true, plays: true, playsAgainst: false, playsAll: false, trouble: true, waivers: true, trades: true, tradesAll: false, picks: false, talk: true, practice: true , redzone: true, redzoneAgainst: false, hurt: true, hurtAgainst: false, wrapped: true };
  const AL = { key: undefined, sub: null, busy: false, msg: "", err: false };
  const alertCfg = () => {
    const c = store.get("alerts", {}) || {};
    return { prefs: Object.assign({}, ALERT_DEFAULTS, c.prefs || {}), quiet: Object.assign({ on: false, from: 23, to: 8 }, c.quiet || {}), member: c.member || "" };
  };
  const alertsSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = () => navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  const b64uBytes = s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
  async function pushApi(path, body) {
    const r = await fetch(LIVE_API_BASE() + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "The alerts server didn't answer.");
    return d;
  }
  async function alertSave() {
    const c = alertCfg();
    await pushApi("/push/save", { sub: AL.sub.toJSON(), member: ME.member, prefs: c.prefs, quiet: c.quiet, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
    store.set("alerts", { ...c, member: ME.member });
  }
  // the claimed team changed on My team: move this device's alerts to it
  async function alertsResync() {
    if (!alertsSupported() || !ME.member) return;
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      AL.sub = reg && await reg.pushManager.getSubscription();
      if (AL.sub && alertCfg().member !== ME.member) await alertSave();
    } catch (_) { /* tried again next time Settings opens */ }
  }
  function alertsHtml() {
    const el = document.getElementById("alerts-panel");
    if (!el) return;
    const intro = `<p class="team-mgr al-intro">Notifications on this device for your matchup, live games (red zone, starters leaving the game), big plays, your lineup and moves. They follow the team you've claimed on My team.</p>`;
    const status = AL.msg ? `<p class="al-msg${AL.err ? " err" : ""}" role="status">${esc(AL.msg)}</p>` : "";
    let body;
    if (!alertsSupported()) {
      body = isIos() && !isStandalone()
        ? `<p>On iPhone and iPad, alerts work once the site is on your Home Screen: tap <b>Share</b>, then <b>Add to Home Screen</b>, and open League HQ from there.</p>`
        : `<p>This browser can't show alerts. Try Chrome, Edge, Firefox or Safari.</p>`;
    } else if (isIos() && !isStandalone()) {
      body = `<p>On iPhone and iPad, alerts work once the site is on your Home Screen: tap <b>Share</b>, then <b>Add to Home Screen</b>, and open League HQ from there.</p>`;
    } else if (!ME.member) {
      body = `<p>Claim your team on <a href="#/myteam">My team</a> first, so alerts know which matchup is yours.</p>`;
    } else if (AL.key === undefined) {
      body = `<p class="team-mgr">Checking…</p>`;
    } else if (!AL.key) {
      body = `<p>Alerts aren't switched on for the site yet.</p>`;
    } else if (Notification.permission === "denied") {
      body = `<p>Notifications are blocked for this site. Allow them in your browser's site settings, then come back here.</p>`;
    } else if (!AL.sub) {
      body = `<button type="button" class="cta al-on" data-al="on"${AL.busy ? " disabled" : ""}>Turn on alerts</button>`;
    } else {
      const c = alertCfg();
      const hours = sel => Array.from({ length: 24 }, (_, h) => `<option value="${h}"${h === sel ? " selected" : ""}>${new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" })}</option>`).join("");
      body = ALERT_GROUPS.map(([g, items]) => `<fieldset class="al-group"><legend>${g}</legend>${items.map(([k, label, note]) =>
        `<label class="set-switch"><input type="checkbox" data-al-k="${k}"${c.prefs[k] ? " checked" : ""}><span><b>${label}</b><span class="team-mgr">${note}</span></span></label>`).join("")}</fieldset>`).join("") +
        `<fieldset class="al-group"><legend>Quiet hours</legend><label class="set-switch"><input type="checkbox" data-al-q="on"${c.quiet.on ? " checked" : ""}><span><b>Don't send alerts overnight</b><span class="team-mgr">Alerts during these hours are skipped, not saved for later.</span></span></label>
          <div class="al-quiet"><label>From <select data-al-q="from">${hours(c.quiet.from)}</select></label><label>to <select data-al-q="to">${hours(c.quiet.to)}</select></label></div></fieldset>
        <div class="al-actions"><button type="button" class="cta" data-al="test"${AL.busy ? " disabled" : ""}>Send a test alert</button><button type="button" class="wk-link al-off" data-al="off"${AL.busy ? " disabled" : ""}>Turn off alerts on this device</button></div>`;
    }
    el.innerHTML = intro + body + status;
  }
  async function initAlerts() {
    alertsHtml();
    if (!alertsSupported() || !ME.member) return;
    try {
      const [info, reg] = await Promise.all([pushApi("/push"), navigator.serviceWorker.getRegistration()]);
      AL.key = info.key || null;
      AL.sub = reg ? await reg.pushManager.getSubscription() : null;
      if (AL.sub && alertCfg().member !== ME.member) await alertSave();
    } catch (e) { AL.key = AL.key === undefined ? null : AL.key; AL.msg = e.message; AL.err = true; }
    alertsHtml();
  }
  async function alertAction(kind) {
    AL.busy = true; AL.msg = ""; AL.err = false; alertsHtml();
    try {
      if (kind === "on") {
        if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications weren't allowed, so alerts are off.");
        const reg = await navigator.serviceWorker.ready;
        AL.sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(AL.key) });
        await alertSave();
        AL.msg = "Alerts are on for this device.";
      } else if (kind === "off") {
        const sub = AL.sub;
        AL.sub = null;
        if (sub) { await pushApi("/push/remove", { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe().catch(() => {}); }
        AL.msg = "Alerts are off for this device.";
      } else if (kind === "test") {
        await pushApi("/push/test", { endpoint: AL.sub.endpoint });
        AL.msg = "Test sent. It should show up in a few seconds.";
      } else {
        await alertSave();
        AL.msg = "Saved.";
      }
    } catch (e) { AL.msg = e.message; AL.err = true; }
    AL.busy = false;
    alertsHtml();
  }
  document.addEventListener("click", e => {
    const b = e.target.closest && e.target.closest("[data-al]");
    if (b && !b.disabled) alertAction(b.dataset.al);
  });
  document.addEventListener("change", e => {
    const t = e.target;
    if (!t.matches || !t.closest("#alerts-panel")) return;
    const c = alertCfg();
    if (t.dataset.alK) c.prefs[t.dataset.alK] = t.checked;
    else if (t.dataset.alQ === "on") c.quiet.on = t.checked;
    else if (t.dataset.alQ) c.quiet[t.dataset.alQ] = Number(t.value);
    else return;
    store.set("alerts", c);
    alertAction("save");
  });

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
    if (wkBtn) { location.hash = href("matchups", { week: wkBtn.dataset.week }, state.tab === "matchups" && ["plays", "watch"].includes(state.sub) ? state.sub : ""); return; }
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
    if (e.target.id === "side-week") { state.sideWeek = Number(e.target.value); document.querySelector(".side").outerHTML = sidebar(); rxHydrate(); pulseLoad(); }
    if (e.target.id === "swap-team") { state.swapTeam = e.target.value; renderKeepScroll(renderInsights); }
    if (e.target.id === "draft-team") { state.draftTeam = e.target.value; renderKeepScroll(renderInsights); }
    if (e.target.id === "rec-member") { location.hash = href("history", e.target.value ? { member: e.target.value } : {}, "records"); return; }
    if (e.target.id === "badge-member") { state.badgeMember = e.target.value; renderKeepScroll(renderHistory); }
    if (e.target.id === "h2h-a" || e.target.id === "h2h-b") {
      const a = e.target.id === "h2h-a" ? e.target.value : state.h2hA, b = e.target.id === "h2h-b" ? e.target.value : state.h2hB;
      state.h2hA = a; state.h2hB = a === b ? null : b;
      history.replaceState(null, "", href("history", state.h2hB ? { a, b } : { a }, "h2h"));
      state.params = new URLSearchParams(location.hash.split("?")[1] || "");
      renderKeepScroll(renderHistory);
    }
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
        if (hit) location.hash = href("history", { player: hit }, "players");
      };
      if (pid && P.players[pid]) input.value = label(pid);
    }
    if (pid && P.players[pid]) {
      box.innerHTML = `<div class="ph-one"></div><p style="margin-top:10px"><a class="wk-link" href="${href("history", {}, "players")}">‹ Most-traveled players</a> · <a class="wk-link" href="${href("trades", { a: pid }, "compare")}">Compare this season ›</a></p>`;
      return renderPassport(box.querySelector(".ph-one"), pid, true);
    }
    const managers = x => new Set(x.s.flatMap(s => (P.teams[s[0] + "|" + s[1]] || ["", []])[1])).size;
    const rows = ids.filter(id => !["K", "D/ST"].includes(P.players[id].p)).map(id => ({ id, x: P.players[id], m: managers(P.players[id]), n: P.players[id].s.length, pts: P.players[id].s.reduce((a, s) => a + s[4], 0) }))
      .sort((a, b) => b.m - a.m || b.n - a.n || b.pts - a.pts).slice(0, 12);
    box.innerHTML = `<h3 class="pp-h" style="margin-top:6px">Most-traveled players</h3><p class="pp-sum">The players who've been through the most managers' hands (kickers and defenses aside, since they get streamed). Tap one for his full history.</p>
      <div class="picks">${rows.map(r => `<a class="pick ph-row" href="${href("history", { player: r.id }, "players")}"><span class="pick-no">${r.m}</span><span class="slot ${esc(r.x.p)}">${esc(r.x.p)}</span>
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

  // Game conditions: each outdoor game's weather at kickoff (from the build, Open-Meteo), as a short text plus the flags
  // that matter for fantasy. Wind and cold hurt kickers and passing; rain and snow, everyone.
  const nflGameOf = team => (D.nflGames || []).find(x => x.home === team || x.away === team);
  // ESPN's reported condition (g.sky, AccuWeather's text such as "Showers") also counts: it catches rain the numbers miss
  const SKY_SNOW = /snow|flurr|sleet|\bice\b/i, SKY_RAIN = /rain|shower|drizzle|storm/i;
  function condFlags(g) {
    if (!g || g.roof || !(g.wx || g.sky)) return [];
    const w = g.wx || {}, sky = g.sky || "", f = [];
    if (w.snow >= 0.2 || SKY_SNOW.test(sky)) f.push(["snow", "Snow", null]);
    if (w.wind >= 15 || w.gust >= 25) f.push(["wind", "Windy", ["K", "QB", "WR", "TE"]]);
    if ((w.rain >= 0.1 && w.pp >= 50) || SKY_RAIN.test(sky)) f.push(["rain", "Rain", null]);
    if (w.t <= 25) f.push(["cold", "Frigid", ["K", "QB", "WR", "TE"]]);
    if (w.t >= 88) f.push(["hot", "Hot", null]);
    return f;
  }
  function condText(g) {
    if (!g) return "";
    if (g.roof) return "Indoors";
    const w = g.wx, sky = g.sky || "", out = sky ? [sky] : [];
    if (w) {
      out.push(`${w.t}°F`, `wind ${w.wind} mph${w.gust >= w.wind + 8 ? `, gusts ${w.gust}` : ""}`);
      if (SKY_RAIN.test(sky) || SKY_SNOW.test(sky)) { /* the condition already names it */ }
      else if (w.snow >= 0.05) out.push(`snow ${w.snow}"`); else if (w.pp >= 30) out.push(`rain ${w.pp}%`);
    }
    return out.join(" · ");
  }
  const condHtml = g => { const t = condText(g); if (!t) return ""; const f = condFlags(g);
    return `<span class="cond${f.length ? " bad" : ""}" title="Forecast at kickoff (first 3 hours; condition from ESPN)">${f.map(x => `<b>${x[1]}</b> `).join("")}${esc(t)}</span>`; };

  // Left the game: the latest in-game injury news for a player this week (from the live worker), or null
  function inGameNews(pid, week) {
    const I = window.LIVE_INGAME;
    if (!I || I.week !== week || !L.isCurrent) return null;
    return (I.players || {})[String(pid)] || null;
  }
  const hurtTag = (pid, week) => { const h = inGameNews(pid, week); return h && h.s === "hurt" ? ' <span class="hurt-tag" title="' + esc(h.h) + '">HURT</span>' : ""; };

  // "Follow the game": the player's real NFL game this week, on the Real app (link found by the build, when Real lists
  // the game) and on ESPN Gamecast (always). Only for the current week; never breaks the card.
  function gameLinks(p, week) {
    try {
      if (!L.isCurrent || L.over || week !== L.currentWeek || !p.team) return "";
      const g = (D.nflGames || []).find(x => x.home === p.team || x.away === p.team);
      if (!g || !g.id) return "";
      const at = g.date && !g.tbd ? Date.parse(g.date) : null, now = Date.now();
      // ESPN's scoreboard (checked each minute during games) when it's fresh; otherwise a guess from the kickoff time
      const known = typeof NFL_STATUS !== "undefined" && NFL_STATUS.games && now - NFL_STATUS.at < 5 * 60e3 ? NFL_STATUS.games[String(g.id)] : null;
      const state = known && known[0] === "in" ? `<b class="sg-live">Live</b>${known[1] ? " · " + esc(known[1]) : ""}`
        : known && known[0] === "post" ? "Final"
        : at == null ? "Kickoff time not set" : now < at ? "Kickoff " + new Date(at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })
        : now < at + 3.5 * 3600e3 ? '<b class="sg-live">Live</b>' : "Final";
      const vs = `${esc(g.away)} @ ${esc(g.home)}`;
      // his own performance in this game on Real (the build finds it once the game is on), else the game
      const mine = g.realPlayers && g.realPlayers[normName(p.name)];
      const cond = condHtml(g);
      return `<div class="stat-game"><span class="stat-game-t">${vs} · ${state}${cond ? `<br>${cond}` : ""}</span>${followLinks(g, mine)}</div>`;
    } catch (_) { return ""; }
  }
  // the two buttons (player card, Watch guide): Real when the build found the game there, ESPN Gamecast always
  function followLinks(g, playerUrl) {
    if (!g || !g.id) return "";
    const real = playerUrl || g.real;
    return `<span class="stat-game-l">${real ? `<a class="sg-btn sg-real" href="${esc(real)}" target="_blank" rel="noopener">${playerUrl ? "His game on Real" : "Open in Real"} ↗</a>` : ""}<a class="sg-btn" href="https://www.espn.com/nfl/game/_/gameId/${encodeURIComponent(g.id)}" target="_blank" rel="noopener">ESPN Gamecast ↗</a></span>`;
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
      ${gameLinks(p, week)}${(() => { const h = inGameNews(p.id, week); return h ? `<div class="stat-hurt ${h.s}"><b>${h.s === "hurt" ? "Left the game" : "Back in the game"}</b> · ${esc(h.h)} <span class="muted">${new Date(h.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></div>` : ""; })()}<div class="stat-body"><div class="empty">Loading stats…</div></div>${usagePanel(p.id)}
      <div class="stat-actions"><a class="cta stat-cmp" href="${href("trades", { a: p.id }, "compare")}">Compare with…</a>
        <a class="linkbtn" href="${href("history", { player: p.id }, "players")}">League history ›</a></div>
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
    if (kind === "wrapped") return wrShareSpec();
    const tn = id => (teamById[id] || { name: "?" }).name;
    const tl = id => (teamById[id] || {}).logo || "";
    if (kind === "tape") {
      const H = IDX.history, A = H.members.find(x => x.id === state.h2hA), B = H.members.find(x => x.id === state.h2hB);
      const h = H.h2h[A.id + "|" + B.id] || [0, 0, 0];
      const rows = tapeRows(H, A, B).filter(r => r[3] != null && r[0] !== "Best season").slice(0, 5).map(r => {
        const w = tapeWinner(r), plain = v => String(v).replace(/<[^>]+>/g, "");
        return { label: r[0], title: `${A.name} ${plain(r[1])}`, sub: `${B.name} ${plain(r[2])}`, value: w ? (w === 1 ? A : B).name : "Even", hi: w === 1 };
      });
      rows.unshift({ label: "Head to head", title: `${A.name} ${h[0]} – ${h[1]} ${B.name}`, sub: h[2] ? `${h[2]} tie${h[2] > 1 ? "s" : ""}` : "", value: h[0] === h[1] ? "Even" : (h[0] > h[1] ? A : B).name, hi: h[0] > h[1] });
      return { file: `tale-of-the-tape`, kicker: "Tale of the tape", title: `${A.name} vs. ${B.name}`, rows };
    }
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
    try { blob = await (spec.slide ? drawSlide(spec) : drawCard(spec)); } catch (_) { blob = null; }
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
      window.LIVE_INGAME = { week: lv.week, players: lv.ingame || {} }; // starters who left / returned to their game
      if (window.LEAGUE_STATS && window.LEAGUE_STATS[IDX.current]) Object.assign(window.LEAGUE_STATS[IDX.current], lv.stats);
      liveAsOf = lv.updated;
      updateLiveChip();
      await checkNflStatus();
      renderTicker();
      const typing = document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
      const building = state.tab === "playoffs" && state.sub === "scenarios"; // don't redraw the scenario builder mid-pick
      if (state.season === IDX.current && ["standings", "matchups", "playoffs"].includes(state.tab) && state.sub !== "pickem" && !building && !typing) {
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
      // each game's state too (same request), for the player card's "Follow the game" line
      NFL_STATUS.games = Object.fromEntries((d.events || []).map(e => [String(e.id), [((e.status || {}).type || {}).state, ((e.status || {}).type || {}).shortDetail || ""]]));
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

  // ---------------------------------------------------------------- getting-started tour
  // Five short steps for someone new: what the site is, claim your team, alerts, where everything lives, and the
  // league games. It opens on a first visit and can be replayed from Settings. A step that sends you somewhere
  // (claiming a team, alerts) shrinks the tour to a small pill at the bottom; tap it to carry on. Saved per device:
  // "tour" = { step, min } while it's open, { done: true } once finished or skipped.
  const TOUR = { el: null, pill: null, push: null };
  const tourState = () => store.get("tour", null) || {};
  async function tourPushOn() {
    try {
      const reg = "serviceWorker" in navigator && await navigator.serviceWorker.getRegistration();
      return !!(reg && reg.pushManager && await reg.pushManager.getSubscription());
    } catch (_) { return false; }
  }
  const TOUR_TABS = [["Standings", "#/", "The table, power rankings, League pulse (what everyone's been up to) and what changed since your last visit."],
    ["Playoffs", "#/playoffs", "Who's clinched and who's out, playoff and seed odds, the tiebreaker race, a scenario builder, and the bracket."],
    ["My team", "#/myteam", "Built around your team: this week's matchup, lineup problems, player news, waiver targets and your record book."],
    ["Matchups", "#/matchups", "Live scores every minute on game day, box scores, every big play and a watch guide."],
    ["Games", "#/games", "Weekly pick'em, Pick 4, trivia and puzzles about this league, with season leaderboards."],
    ["Insights", "#/insights", "Luck, hot and cold teams, lineups, schedule, the draft and what-ifs. Each tab has a switch at the top for its views."],
    ["Trades", "#/trades", "Every trade with grades, the trade block, side-by-side player comparisons, and what a trade would do to both teams' playoff odds."],
    ["History", "#/history", "Every past season, the record book, player history, Tale of the tape for any two managers, and League Wrapped: your season as a story."]];
  function tourSteps() {
    const me = ME.member, pushOn = TOUR.push;
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent), canPush = "PushManager" in window && "serviceWorker" in navigator;
    const done = txt => `<p class="tour-done"><span aria-hidden="true">✓</span><span>${txt}</span></p>`;
    return [
      { t: `Welcome to ${esc(IDX.name)}`, b: `<p>This is the league's own site. It's rebuilt from ESPN every few minutes on game days, so scores, standings and playoff odds stay current, and it adds things ESPN doesn't have: luck, power rankings, league history, trash talk and games just for this league.</p><p>Four quick steps get you set up. It takes about a minute.</p>`, next: "Start" },
      { t: "Claim your team", b: me ? done(`You're set up as <b>${esc(memberName(me))}</b>. Your team is highlighted everywhere, and My team is built around it.`)
          : `<p>Pick your name and choose a 4-digit PIN. The site then highlights your team everywhere and builds My team around it.</p><p class="team-mgr">The same name and PIN work for pick'em, the trade block, trash talk and reactions. Never set one? The PIN you choose now becomes yours.</p>`,
        go: me ? null : ["Claim my team", "#/myteam"] },
      { t: "Turn on alerts", b: pushOn ? done("Alerts are on for this device. Pick which ones you want any time in Settings → Alerts.")
          : `<p>Get a notification for lead changes, close finishes and final results in your matchup, big plays, starters ruled out before kickoff, practice reports, waiver results and trades. You choose which ones.</p>`
            + (!canPush && ios ? `<p class="team-mgr">On iPhone, first add the site to your Home Screen (Share → Add to Home Screen), then open it from there. Apple only allows alerts that way.</p>`
              : !canPush ? `<p class="team-mgr">This browser can't show alerts. Try Chrome, Edge, Firefox or Safari.</p>` : ""),
        go: pushOn || !canPush ? null : ["Set up alerts", "#/settings?at=alerts"] },
      { t: "Where everything lives", b: `<div class="tour-tabs">${TOUR_TABS.map(([n, h, d]) => `<a href="${h}" data-tour-min><b>${n}</b><span>${d}</span></a>`).join("")}</div><p class="team-mgr">Tap any ⓘ for how a number works, or see the Glossary at the bottom of every page.</p>` },
      { t: "Join in", b: `<p>Make a pick in this week's <a href="#/games" data-tour-min>pick'em</a>, react to big plays with one tap, and post trash talk on any matchup or trade. It all shows up in League pulse for everyone.</p><p>New features land often: the ✦ <b>What's new</b> button in the header has the list.</p>`, next: "Done" },
    ];
  }
  function tourClose(finished) {
    store.set("tour", { done: true, finished: !!finished });
    if (TOUR.el) { TOUR.el.remove(); TOUR.el = null; }
    if (TOUR.pill) { TOUR.pill.remove(); TOUR.pill = null; }
    document.removeEventListener("keydown", tourKey);
  }
  function tourKey(e) { if (e.key === "Escape") tourMin(); }
  function tourMin() { const st = tourState(); if (st.done) return; store.set("tour", { ...st, min: true }); tourRender(); }
  function tourOpen(step) {
    store.set("tour", { step: step == null ? (tourState().step || 0) : step, min: false });
    tourRender();
  }
  async function tourRender() {
    const st = tourState();
    if (st.done) return;
    TOUR.push = await tourPushOn();
    const steps = tourSteps(), i = Math.max(0, Math.min(steps.length - 1, st.step || 0)), S = steps[i];
    if (st.min) {
      if (TOUR.el) { TOUR.el.remove(); TOUR.el = null; document.removeEventListener("keydown", tourKey); }
      if (!TOUR.pill) { TOUR.pill = document.createElement("div"); TOUR.pill.className = "tour-pill"; document.body.appendChild(TOUR.pill); }
      TOUR.pill.innerHTML = `<button type="button" class="tour-pill-go" data-tour="open">Getting started · step ${i + 1} of ${steps.length} <b>Continue ›</b></button><button type="button" class="tour-pill-x" data-tour="skip" aria-label="End the tour">✕</button>`;
      return;
    }
    if (TOUR.pill) { TOUR.pill.remove(); TOUR.pill = null; }
    if (!TOUR.el) {
      TOUR.el = document.createElement("div");
      TOUR.el.className = "share-modal tour-modal";
      document.body.appendChild(TOUR.el);
      document.addEventListener("keydown", tourKey);
    }
    const last = i === steps.length - 1;
    TOUR.el.innerHTML = `<div class="share-sheet tour-sheet" role="dialog" aria-modal="true" aria-labelledby="tour-h">
      <div class="tour-top"><span class="tour-n">Getting started · ${i + 1} of ${steps.length}</span><button type="button" class="linkbtn" data-tour="skip">${i === 0 ? "Not now" : "Skip tour"}</button></div>
      <div class="tour-dots" aria-hidden="true">${steps.map((_, k) => `<i class="${k === i ? "on" : k < i ? "past" : ""}"></i>`).join("")}</div>
      <h2 id="tour-h">${S.t}</h2><div class="tour-body">${S.b}</div>
      <div class="tour-actions">${i > 0 ? `<button type="button" class="linkbtn" data-tour="back">‹ Back</button>` : "<span></span>"}
        <span class="tour-right">${S.go ? `<a class="cta" href="${S.go[1]}" data-tour-min>${S.go[0]}</a><button type="button" class="linkbtn" data-tour="next">Skip this step</button>`
          : `<button type="button" class="cta" data-tour="${last ? "finish" : "next"}">${S.next || "Next"}</button>`}</span></div></div>`;
    const focus = TOUR.el.querySelector(".tour-actions .cta");
    if (focus) focus.focus({ preventScroll: true });
  }
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-tour],[data-tour-min],[data-tour-start]");
    if (b && b.dataset.tourStart != null) { e.preventDefault(); return tourOpen(0); }
    if (b && b.dataset.tourMin != null) { if (!tourState().done) store.set("tour", { ...tourState(), min: true }); setTimeout(tourRender, 0); return; } // the link itself navigates
    if (!b) { if (TOUR.el && e.target === TOUR.el) tourMin(); return; } // tap outside the card: tuck it away
    const st = tourState(), act = b.dataset.tour;
    if (act === "skip") return tourClose(false);
    if (act === "finish") return tourClose(true);
    if (act === "open") return tourOpen();
    if (act === "next" || act === "back") { store.set("tour", { step: (st.step || 0) + (act === "next" ? 1 : -1), min: false }); tourRender(); }
  });
  // after claiming a team or turning on alerts, the pill's step shows as done when it's reopened; keep it current
  window.addEventListener("hashchange", () => { if (TOUR.pill || TOUR.el) setTimeout(tourRender, 50); });
  function tourBoot() {
    const st = tourState();
    if (st.done) return;
    if (st.step != null) return tourRender(); // a tour in progress (e.g. after a reload)
    if (NEW_VISITOR) setTimeout(() => tourOpen(0), 600);
  }

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

  startPage().then(route).then(startLive).then(tourBoot);
})();
