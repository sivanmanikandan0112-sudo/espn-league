// Full pre-publish check: open the freshly built site in Chrome and click through it like a member would.
// Every page reachable from a link (current season, plus the main tabs of past seasons), with a team claimed, then a
// few taps (a team card, a player card). Fails (exit 1) if any page throws an error or renders nothing, so the
// previous good version stays live. Runs in GitHub Actions only when the site's code changed since the last pass.
//
//   npm install --no-save playwright-core@1.48.2 && node check_site.mjs [site_dir]
// Uses the installed Google Chrome (CHROME_PATH to point at another one).
import { chromium } from "playwright-core";
import { createServer } from "node:http";
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
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
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
    for (const t of ["", "matchups", "insights", "trades", "history", "myteam"]) {
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
