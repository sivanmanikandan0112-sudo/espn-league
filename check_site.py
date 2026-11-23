"""Quick pre-publish check of a freshly built site (every build, a second or two).

Fails (exit 1) only when the build is clearly broken, so the previous good version stays live instead:
a data file that doesn't load, a season with no teams, a team count that doesn't match the league, no weeks
while the season is under way, or app code with a syntax error. Anything else (an ESPN hiccup that leaves a
section empty, say) is the site's job to handle, not a reason to stop publishing.

    python3 check_site.py [site_dir]
"""
import json
import os
import subprocess
import sys

SITE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "site")
problems = []


def load_js(name, var):
    """window.VAR=...; or window.VAR=window.VAR||{};window.VAR[key]=...; -> the object"""
    path = os.path.join(SITE, "data", name)
    try:
        src = open(path, encoding="utf-8").read().strip()
    except OSError as e:
        problems.append("%s: missing (%s)" % (name, e))
        return None
    head = "window.%s=" % var
    if not src.startswith(head):
        problems.append("%s: doesn't start with %s" % (name, head))
        return None
    body = src[len(head):]
    if body.startswith("window.%s||{};" % var):
        body = body.split("]=", 1)[1] if "]=" in body else ""
    try:
        return json.loads(body.rstrip(";\n "))
    except ValueError as e:
        problems.append("%s: not valid data (%s)" % (name, e))
        return None


idx = load_js("index.js", "LEAGUE_INDEX")
if idx:
    if idx.get("current") not in idx.get("seasons", []):
        problems.append("index.js: current season %r isn't in the season list" % idx.get("current"))
    for season in idx.get("seasons", []):
        d = load_js("%s.js" % season, "LEAGUE_DATA")
        if not d:
            continue
        lg, teams = d.get("league") or {}, d.get("teams") or []
        if not teams:
            problems.append("%s.js: no teams" % season)
        elif lg.get("size") and len(teams) != lg["size"]:
            problems.append("%s.js: %d teams, but the league has %d" % (season, len(teams), lg["size"]))
        if any(not t.get("name") or "id" not in t for t in teams):
            problems.append("%s.js: a team without a name or id" % season)
        if (lg.get("currentWeek") or 0) > 1 and not d.get("weeks"):
            problems.append("%s.js: week %s but no weeks of results" % (season, lg.get("currentWeek")))
    try:
        json.load(open(os.path.join(SITE, "data", "status.json")))
    except (OSError, ValueError) as e:
        problems.append("status.json: %s" % e)

for js in ("app.js", "sw.js"):
    r = subprocess.run(["node", "--check", os.path.join(SITE, js)], capture_output=True, text=True)
    if r.returncode:
        problems.append("%s: syntax error\n%s" % (js, (r.stderr or r.stdout).strip()[:800]))

if problems:
    print("Pre-publish check FAILED, so this build won't be published (the last good one stays live):")
    for p in problems:
        print("  - " + p)
    sys.exit(1)
print("Pre-publish check passed: %d seasons of data load, app code parses." % len((idx or {}).get("seasons", [])))
