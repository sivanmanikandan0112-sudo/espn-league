// Full pre-publish check: open the freshly built site in Chrome and click through it like a member would.
// Every page reachable from a link (current season, plus the main tabs of past seasons), with a team claimed, then a
// few taps (a team card, a player card). Fails (exit 1) if any page throws an error or renders nothing, so the
// previous good version stays live. Runs in GitHub Actions only when the site's code changed since the last pass.
//
//   npm install --no-save playwright-core@1.48.2 axe-core@4.10.2 && node check_site.mjs [site_dir]
// After the pass/fail part it prints a report that never blocks: an accessibility scan of the main pages (axe-core)
// and a cold first load on a throttled phone (also written to the GitHub run's summary page).
// Uses the installed Google Chrome (CHROME_PATH to point at another one).
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "site"));
const MAX_PAGES = { desktop: 140, phone: 45 }, SETTLE_MS = 250, PAGE_TIMEOUT = 15000;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };

const server = createServer(async (req, res) => {
  let path = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  if (path.endsWith("/")) path += "index.html";
  try {
    const body = await readFile(join(SITE, path));
    const type = TYPES[extname(path)] || "application/octet-stream";
    const zip = /gzip/.test(req.headers["accept-encoding"] || "") && /text|javascript|json|svg|manifest/.test(type);
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", ...(zip ? { "Content-Encoding": "gzip" } : {}) });
    res.end(zip ? gzipSync(body) : body);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

// can't start Chrome = a problem with the build machine, not the site: warn and let the build publish (unchecked,
// so the check runs again next build)
let browser;
try {
  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" });
} catch (e) {
  console.log(`::warning::Browser check skipped: couldn't start Chrome (${String(e.message || e).split("\n")[0]})`);
  server.close();
  process.exit(0);
}
const problems = [], warnings = [];
const NETWORK = /^(TypeError: )?(Failed to fetch|Load failed|NetworkError|load failed)/i;
const SITE_ORIGIN = "https://sivanmanikandan0112-sudo.github.io";
let visited = 0;

async function run({ viewport, claim, label, cap }) {
  let n = 0;
  const ctx = await browser.newContext({ viewport, serviceWorkers: "block" });
  // the live worker only allows the real site's origin, so pass its calls through and allow this one
  const live = await readFile(join(SITE, "config.js"), "utf8").then(t => (t.match(/liveApi:\s*"([^"]+)"/) || [])[1]).catch(() => null);
  if (live) {
    await ctx.route(live.replace(/\/$/, "") + "/**", async route => {
      try {
        const r = await route.fetch({ headers: { ...route.request().headers(), origin: SITE_ORIGIN } });
        await route.fulfill({ response: r, headers: { ...r.headers(), "access-control-allow-origin": origin } });
      } catch { await route.abort(); }
    });
  }
  const page = await ctx.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT);
  let where = "";
  page.on("pageerror", e => {
    const msg = String(e.message || e).split("\n")[0];
    // a network call that failed (the worker or ESPN briefly down) isn't a code problem; report it, don't block
    (NETWORK.test(msg) ? warnings : problems).push(`${label} ${where || "(loading)"}: ${msg}`);
  });
  await page.goto(origin + "/");
  await page.waitForFunction(() => window.LEAGUE_INDEX && document.querySelector("#main") && document.querySelector("#main").children.length);
  const idx = await page.evaluate(() => window.LEAGUE_INDEX);
  if (claim) {
    // claim the first team (local to this throwaway browser) so My team, alerts settings etc. render fully
    const owner = await page.evaluate(() => { const d = window.LEAGUE_DATA[window.LEAGUE_INDEX.current]; return ((d.teams[0] || {}).owners || [])[0] || ""; });
    await page.evaluate(o => localStorage.setItem("lhq:me", JSON.stringify(o)), owner);
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#main") && document.querySelector("#main").children.length);
  }

  // one visit per page: path + which parameters it has (+ the view and season), not every week or game
  const key = h => {
    const [p, q] = h.replace(/^#/, "").split("?"), ps = new URLSearchParams(q || "");
    return [p || "/", [...ps.keys()].sort().join(","), ps.get("at") || "", ps.get("season") || ""].join("|");
  };
  const queue = ["#/"], seen = new Set([key("#/")]);
  for (const s of idx.seasons.filter(s => s !== idx.current)) {
    for (const t of ["", "playoffs", "matchups", "insights", "trades", "history", "history/yearbook", "myteam"]) {
      const h = `#/${t}?season=${s}`;
      if (!seen.has(key(h))) { seen.add(key(h)); queue.push(h); }
    }
  }
  while (queue.length && n < cap) {
    const h = queue.shift();
    where = h; visited++; n++;
    await page.evaluate(x => { location.hash = x; }, h);
    await page.waitForTimeout(SETTLE_MS);
    const { text, links } = await page.evaluate(() => {
      const m = document.querySelector("#main");
      return { text: (m && m.innerText || "").trim(), links: [...document.querySelectorAll('a[href^="#/"]')].map(a => a.getAttribute("href")) };
    });
    if (text.length < 20) problems.push(`${label} ${h}: the page came out empty`);
    const cur = new URLSearchParams(h.split("?")[1] || "").get("season");
    for (const l of links) {
      const ls = new URLSearchParams(l.split("?")[1] || "").get("season");
      if (cur || ls) continue; // follow links in the current season only (past seasons: their main tabs, listed above)
      const k = key(l);
      if (!seen.has(k)) { seen.add(k); queue.push(l); }
    }
  }

  // a few taps: open a team card on Standings, a game and then a player card on Matchups
  const tap = async (h, sel, wait) => {
    where = `${h} (tap ${sel})`;
    await page.evaluate(x => { location.hash = x; }, h);
    await page.waitForTimeout(SETTLE_MS);
    await page.evaluate(q => { const el = document.querySelector(q); if (el) el.click(); }, sel);
    await page.waitForTimeout(wait || SETTLE_MS);
  };
  await tap("#/", ".team-head");
  await tap("#/matchups", "[data-stat]", 800);
  await ctx.close();
}

try {
  await run({ viewport: { width: 1280, height: 900 }, claim: true, label: "[desktop]", cap: MAX_PAGES.desktop });
  await run({ viewport: { width: 375, height: 812 }, claim: false, label: "[phone]", cap: MAX_PAGES.phone });
} catch (e) {
  problems.push(`check crashed: ${String(e.message || e).split("\n")[0]}`);
}
// ---- report only (never blocks): accessibility of the main pages, and a cold first load on a slow phone
const report = [];
const MAIN_PAGES = ["#/", "#/playoffs", "#/playoffs/odds", "#/myteam", "#/matchups", "#/matchups/watch", "#/games", "#/insights", "#/trades", "#/history", "#/settings", "#/whatsnew", "#/glossary"];
try {
  const axeSrc = await readFile(join(dirname(fileURLToPath(import.meta.url)), "node_modules/axe-core/axe.min.js"), "utf8");
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  await page.goto(origin + "/");
  await page.waitForFunction(() => document.querySelector("#main") && document.querySelector("#main").children.length);
  await page.addScriptTag({ content: axeSrc });
  const byRule = new Map();
  for (const h of MAIN_PAGES) {
    await page.evaluate(x => { location.hash = x; }, h);
    await page.waitForTimeout(400);
    const v = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ["violations"] })).violations
      .map(x => ({ id: x.id, impact: x.impact, help: x.help, n: x.nodes.length, eg: (x.nodes[0] || {}).target })));
    for (const x of v) {
      const r = byRule.get(x.id) || { ...x, n: 0, pages: [] };
      r.n += x.n; r.pages.push(h); byRule.set(x.id, r);
    }
  }
  await ctx.close();
  const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  const rules = [...byRule.values()].sort((a, b) => (order[a.impact] ?? 4) - (order[b.impact] ?? 4) || b.n - a.n);
  report.push(`### Accessibility (${MAIN_PAGES.length} main pages, axe-core)`, "");
  if (!rules.length) report.push("No issues found.");
  else {
    report.push(`${rules.length} kinds of issue, ${rules.reduce((x, r) => x + r.n, 0)} spots in all.`, "", "| Impact | Issue | Spots | Pages | Example |", "|---|---|---|---|---|");
    for (const r of rules) report.push(`| ${r.impact || ""} | ${r.help} (${r.id}) | ${r.n} | ${r.pages.length} | \`${String((r.eg || [])[0] || "").slice(0, 60).replace(/\|/g, "\\|")}\` |`);
  }
} catch (e) { report.push(`Accessibility scan skipped: ${String(e.message || e).split("\n")[0]}`); }

try {
  // Chrome's "slow 4G": 150 ms round trips, 1.6 Mbps down, plus a 4x slower CPU (a mid-range phone); empty cache
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, serviceWorkers: "block", isMobile: true });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  let bytes = 0, reqs = 0;
  cdp.on("Network.loadingFinished", e => { bytes += e.encodedDataLength || 0; reqs++; });
  const t0 = Date.now();
  await page.goto(origin + "/", { timeout: 60000 });
  await page.waitForFunction(() => { const m = document.querySelector("#main"); return m && m.innerText.trim().length > 20; }, null, { timeout: 60000 });
  const first = (Date.now() - t0) / 1000;
  const kb = Math.round(bytes / 1024);
  report.push("", "### Speed (cold first load, slow 4G, 4x slower CPU)", "", `Standings readable after **${first.toFixed(1)} s**, ${kb} KB over ${reqs} requests (local copy, gzipped like GitHub Pages; the live worker's calls not included).`);
  if (first > 10) console.log(`::warning::Slow first load: ${first.toFixed(1)} s on slow 4G`);
  await ctx.close();
} catch (e) { report.push("", `Speed test skipped: ${String(e.message || e).split("\n")[0]}`); }

console.log("\n" + report.join("\n") + "\n");
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, "## Site check report\n\n" + report.join("\n") + "\n", { flag: "a" });

await browser.close();
server.close();

for (const w of [...new Set(warnings)].slice(0, 10)) console.log("  (network, not blocking) " + w);
const unique = [...new Set(problems)];
if (unique.length) {
  console.log(`Browser check FAILED on ${visited} page visits, so this build won't be published (the last good one stays live):`);
  for (const p of unique.slice(0, 40)) console.log("  - " + p);
  process.exit(1);
}
console.log(`Browser check passed: ${visited} page visits on desktop and phone, no errors.`);
// the marker the workflow caches, so this version of the code isn't checked again
await writeFile(join(dirname(fileURLToPath(import.meta.url)), ".site-check-ok"), new Date().toISOString() + "\n");
