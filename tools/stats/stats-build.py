#!/usr/bin/env python3
"""Reads saybooks.io's nginx combined-format log on stdin, writes the /admin/visitors page on stdout.

Adapted from petervarga-site/tools/stats/stats-build.py (the Portland AI Works admin), which it
shares rules.py with. /admin starts counting at the sandbox; this page covers everyone before it:
who read which page, where they came from, and how far each one got.

Every request lands in one of six buckets, checked in this order:
  excluded    own addresses (STATS_HOME/exclude-ips.txt), any address the admin page answered
              for, and anything under /admin
  crawler     the user agent declares itself, or matches a known scanner fingerprint
  datacenter  a browser-looking user agent from a hosting or cloud network (ASN lookup via
              Team Cymru's DNS service, cached in STATS_HOME/asn-cache.json)
  norender    a browser string that never drew a page (see RENDER below)
  selfref     drew a page, but arrived saying it came from saybooks.io (see SELFREF below)
  person      everything else

How far a reader got, each step counted once per address and browser in the window:
  read        a public page          opened the app    GET /app
  did something  POST /api/cmd/...   signed in         /auth/google/callback
Connector attempts follow /authorize (the client named by its redirect_uri) to the consent
page and to the consent being given, by the same browser within 20 minutes.
Stdlib only. Days are bucketed in Portland time.
"""
import re, sys, html, json, os, subprocess
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit, parse_qs
try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("America/Los_Angeles")
except Exception:
    TZ = timezone.utc

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rules import LINE, hosting_name, is_crawler

HOME = os.environ.get("STATS_HOME", "/opt/saybooks-stats")
CACHE_PATH = os.path.join(HOME, "asn-cache.json")
EXCLUDE_PATH = os.path.join(HOME, "exclude-ips.txt")

NAMED = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "Claude-User",
         "PerplexityBot", "Perplexity-User", "Google-Extended", "Googlebot", "Bingbot", "LinkedInBot",
         "facebookexternalhit", "DuckDuckBot", "Applebot", "Amazonbot", "Bytespider", "meta-externalagent"]
AI_SOURCES = [
    ("ChatGPT", ["chatgpt.com", "chat.openai.com", "utm_source=chatgpt"]),
    ("Copilot", ["copilot.microsoft.com", "copilot.cloud.microsoft", "m365.cloud.microsoft", "utm_source=copilot"]),
    ("Perplexity", ["perplexity.ai", "utm_source=perplexity"]),
    ("Claude", ["claude.ai"]),
    ("Gemini", ["gemini.google.com", "bard.google.com", "utm_source=gemini"]),
]
ASSET = re.compile(r'\.(css|js|mjs|png|jpg|jpeg|gif|svg|ico|webmanifest|woff2?|map|mp4|pdf|zip|json|txt|xml)$', re.I)
# Not pages a person reads: the app's API, the MCP doors and the OAuth machinery, documents.
NOT_PAGE = re.compile(r'^/(api|mcp|oauth|auth|authorize|token|register|revoke|\.well-known|doc|journal|download)(/|$)')
OWN = ("saybooks.io",)
ICON_PATHS = {"/favicon.svg", "/favicon.ico", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/site.webmanifest", "/manifest.webmanifest"}
CLIENTS = [("Claude", ("claude.ai", "claude.com")), ("ChatGPT", ("chatgpt.com", "openai.com")),
           ("Gemini", ("googleusercontent.com",)), ("Claude Code or local", ("localhost", "127.0.0.1"))]


def load_excludes():
    ips = set()
    try:
        for line in open(EXCLUDE_PATH):
            line = line.split("#", 1)[0].strip()
            if line: ips.add(line)
    except FileNotFoundError:
        pass
    return ips

def load_cache():
    try: return json.load(open(CACHE_PATH))
    except Exception: return {}

def save_cache(c):
    try:
        tmp = CACHE_PATH + ".tmp"; json.dump(c, open(tmp, "w")); os.replace(tmp, CACHE_PATH)
    except Exception: pass

def dig_txt(name):
    try:
        out = subprocess.run(["dig", "+short", "+time=2", "+tries=1", "TXT", name], capture_output=True, text=True, timeout=6).stdout
        return out.strip().split("\n")[0].strip('"') if out.strip() else ""
    except Exception:
        return ""

def asn_for(ip, cache):
    """The cache holds only the looked-up ASN and name; the hosting verdict is recomputed every run."""
    if ip in cache:
        rec = cache[ip]; rec["hosting"] = hosting_name(rec.get("name")); return rec
    rec = {"asn": "", "name": "", "hosting": False}
    if re.match(r'^\d+\.\d+\.\d+\.\d+$', ip):
        a, b, c, d = ip.split(".")
        origin = dig_txt(f"{d}.{c}.{b}.{a}.origin.asn.cymru.com")
        if origin:
            asn = origin.split("|")[0].strip().split(" ")[0]
            rec["asn"] = asn
            desc = dig_txt(f"AS{asn}.asn.cymru.com")
            if desc: rec["name"] = desc.split("|")[-1].strip()
            rec["hosting"] = hosting_name(rec["name"])
    cache[ip] = rec
    return rec

def parse_ts(s):
    return datetime.strptime(s, "%d/%b/%Y:%H:%M:%S %z").astimezone(TZ)


# ---- read the log ----
lines = []
for line in sys.stdin:
    m = LINE.match(line)
    if not m: continue
    ip, ts, method, path, status, size, ref, ua = m.groups()
    try: dt = parse_ts(ts)
    except ValueError: continue
    p = path.split("?", 1)[0]
    if len(p) > 1 and p.endswith("/"): p = p.rstrip("/")
    lines.append((ip, dt, method, path, p, int(status), ref, ua))

# Whoever the admin endpoint answered for is Peter, on whatever address he is on that day.
excludes = load_excludes() | {l[0] for l in lines if l[4] == "/api/admin/stats" and l[5] == 200}
cache = load_cache()
rows = []
for ip, dt, method, path, p, status, ref, ua in lines:
    if ip in excludes or p.startswith("/admin") or p == "/api/admin/stats": kind = "excluded"
    elif is_crawler(ua): kind = "crawler"
    elif asn_for(ip, cache)["hosting"]: kind = "datacenter"
    else: kind = "person"
    rows.append({"ip": ip, "dt": dt, "method": method, "path": p, "raw": path, "status": status, "ref": ref, "ua": ua,
                 "kind": kind, "net": cache.get(ip, {}).get("name", ""), "key": (ip, ua)})
save_cache(cache)

# RENDER: a browser that draws a page fetches the site icon, and then either the public pages'
# stylesheet (sent no-store, so every page view fetches it) or, in the app, its first API call.
# Fetchers with a browser string do neither. A person who blocks icons is missed: a floor, not a count.
ok = lambda test: {r["key"] for r in rows if test(r) and r["status"] < 400}
rendered = ok(lambda r: r["path"] in ICON_PATHS) & (ok(lambda r: r["path"] == "/site.css") | ok(lambda r: r["path"].startswith("/api/")))
for r in rows:
    if r["kind"] == "person" and r["key"] not in rendered: r["kind"] = "norender"

now = datetime.now(TZ)
def is_page(r):
    return (200 <= r["status"] < 300 or r["status"] == 304) and r["method"] == "GET" and not ASSET.search(r["path"]) and not NOT_PAGE.match(r["path"])
def host_of(ref): return re.sub(r'^https?://', '', ref).split("/", 1)[0].split(":", 1)[0].lower()

# SELFREF: a reader whose first request is a page that says it came from saybooks.io, though this
# address and browser were never here before. Seen 1-2 Nov 2026: hourly at five past, a different
# home connection each time, old Chrome, the front page "from" the front page, then nothing. A person
# whose address changes mid-visit looks the same, so the same browser string seen on another address
# in the 30 minutes before keeps them a person.
firsts, recent = {}, defaultdict(list)
for r in rows:
    if r["key"] not in firsts: firsts[r["key"]] = r
    recent[r["ua"]].append(r)
def arrived_inside(r):
    if r["kind"] != "person" or not is_page(r) or host_of(r["ref"]) not in OWN: return False
    return not any(o["ip"] != r["ip"] and r["dt"] - timedelta(minutes=30) <= o["dt"] <= r["dt"] for o in recent[r["ua"]])
selfref_keys = {k for k, r in firsts.items() if arrived_inside(r)}
for r in rows:
    if r["kind"] == "person" and r["key"] in selfref_keys: r["kind"] = "selfref"

people_all = [r for r in rows if r["kind"] == "person"]
people = [r for r in people_all if is_page(r)]
dc = [r for r in rows if r["kind"] == "datacenter"]
crawlers = [r for r in rows if r["kind"] == "crawler"]
excluded = [r for r in rows if r["kind"] == "excluded"]
norender = [r for r in rows if r["kind"] == "norender" and is_page(r)]
selfref = [r for r in rows if r["kind"] == "selfref" and is_page(r)]
def visitors(rs): return len({r["key"] for r in rs})
def esc(s): return html.escape(str(s))
def num(n): return f"{n:,}"
def pct(a, b): return f"{round(100 * a / b)}%" if b else "n/a"
first = min((r["dt"] for r in rows), default=now); last = max((r["dt"] for r in rows), default=now)
today = now.date()

# ---- where a visit came from ----
def utm(raw):
    q = parse_qs(urlsplit(raw).query)
    return (q.get("utm_source") or [""])[0].lower()
def source_of(r):
    u = utm(r["raw"])
    if u: return {"youtube": "YouTube", "linkedin": "LinkedIn", "x": "X", "twitter": "X"}.get(u, u)
    ref = r["ref"]
    if ref in ("-", ""): return "Direct or app"
    h = host_of(ref)
    if any(h == o or h.endswith("." + o) for o in OWN): return None
    hay = ref.lower()
    for name, tokens in AI_SOURCES:
        if any(t in hay for t in tokens): return name
    if "youtube" in h or h == "youtu.be": return "YouTube"
    if "ycombinator" in h or h == "hn.algolia.com": return "Hacker News"
    if "linkedin" in h or h == "lnkd.in": return "LinkedIn"
    if h in ("t.co", "x.com", "twitter.com", "mobile.twitter.com"): return "X"
    if "reddit" in h: return "Reddit"
    if "github" in h: return "GitHub"
    if "portlandaiworks" in h: return "Portland AI Works"
    if "google." in h: return "Google"
    if "bing.com" in h: return "Bing"
    if "duckduckgo" in h: return "DuckDuckGo"
    return h[4:] if h.startswith("www.") else h

def short_net(net):
    if not net: return "unknown network"
    name = net.split(" - ", 1)[-1]
    org, _, cc = name.rpartition(", ")
    org = org or name
    org = re.sub(r",?\s+(LLC|Inc|Ltd|Limited|S\.A|GmbH|AG|B\.V|Corporation|Communications|Co|Pvt|Holding)\.*(?=\s|,|$)", "", org).strip(" ,.")
    return f"{org} ({cc})" if cc and len(cc) == 2 else org

# ---- visits: one address and browser, requests less than 30 minutes apart ----
# Built from every request a reader made (pages, app calls, sign-in), so a visit knows how far it got.
visits = []
by_key = defaultdict(list)
for r in sorted(people_all, key=lambda r: r["dt"]): by_key[r["key"]].append(r)
for key, rs in by_key.items():
    cur = [rs[0]]
    for r in rs[1:]:
        if r["dt"] - cur[-1]["dt"] > timedelta(minutes=30): visits.append(cur); cur = [r]
        else: cur.append(r)
    visits.append(cur)
visits = [v for v in visits if any(is_page(r) for r in v)]
visits.sort(key=lambda v: v[0]["dt"], reverse=True)
def first_page(v): return next(r for r in v if is_page(r))
def visit_source(v): return source_of(first_page(v)) or "Within the site"

STEPS = ["read", "opened the app", "did something", "signed in"]
def reached(rs):
    """How far a set of requests got, as an index into STEPS."""
    s = 0
    for r in rs:
        if r["path"] == "/app" and r["status"] < 400: s = max(s, 1)
        elif r["method"] == "POST" and r["path"].startswith("/api/cmd/") and r["status"] < 400: s = max(s, 2)
        elif r["path"] == "/auth/google/callback" and r["status"] < 400: s = max(s, 3)
    return s

def window(days, end=now): return [r for r in people if end - timedelta(days=days) <= r["dt"] < end]
last7, prev7, last30 = window(7), window(7, now - timedelta(days=7)), window(30)
vis30 = [v for v in visits if v[0]["dt"] >= now - timedelta(days=30)]

# Per reader (address and browser) over 30 days: the first visit's landing page and source, the furthest step.
readers30 = {}
for v in sorted(vis30, key=lambda v: v[0]["dt"]):
    k = v[0]["key"]
    if k not in readers30:
        readers30[k] = {"landing": first_page(v)["path"], "source": visit_source(v), "step": 0, "last_page": None}
    rd = readers30[k]
    rd["step"] = max(rd["step"], reached(v))
    pages = [r["path"] for r in v if is_page(r)]
    if pages: rd["last_page"] = pages[-1]
funnel = [sum(1 for rd in readers30.values() if rd["step"] >= i) for i in range(len(STEPS))]

def by_dim(dim):
    t = defaultdict(lambda: [0] * len(STEPS))
    for rd in readers30.values():
        for i in range(rd["step"] + 1): t[rd[dim]][i] += 1
    return sorted(t.items(), key=lambda kv: (-kv[1][0], kv[0]))
stopped = Counter(rd["last_page"] for rd in readers30.values() if rd["step"] == 0 and rd["last_page"]).most_common(10)

# ---- connector attempts: /authorize, then the consent page, then consent given ----
# Followed through every request from that browser, drawn page or not: the OAuth hops are redirects.
any_by_key = defaultdict(list)
for r in sorted(rows, key=lambda r: r["dt"]):
    if r["kind"] != "excluded": any_by_key[r["key"]].append(r)
attempts = []
for r in sorted([r for r in rows if r["kind"] != "excluded" and r["path"] == "/authorize" and r["method"] == "GET"], key=lambda r: r["dt"]):
    if r["dt"] < now - timedelta(days=30): continue
    ru = (parse_qs(urlsplit(r["raw"]).query).get("redirect_uri") or [""])[0]
    rh = host_of(ru)
    client = next((n for n, hs in CLIENTS if any(rh == h or rh.endswith("." + h) for h in hs)), rh or "unknown")
    later = [x for x in any_by_key[r["key"]] if r["dt"] <= x["dt"] <= r["dt"] + timedelta(minutes=20)]
    step = "stopped at the start"
    if any(x["path"] == "/auth/google/callback" for x in later): step = "signed in"
    if any(x["path"] == "/oauth/consent" and x["method"] == "GET" for x in later): step = "saw the consent page"
    if any(x["path"] == "/oauth/consent" and x["method"] == "POST" and x["status"] < 400 for x in later): step = "allowed"
    door = (parse_qs(urlsplit(r["raw"]).query).get("resource") or [""])[0]
    door = urlsplit(door).path or "/mcp"
    attempts.append({"dt": r["dt"], "client": client, "door": door, "step": step, "net": r["net"], "key": r["key"]})
# A client retrying the same browser within a minute is one attempt.
dedup = []
for a in attempts:
    if dedup and dedup[-1]["key"] == a["key"] and a["dt"] - dedup[-1]["dt"] < timedelta(minutes=1): dedup[-1] = a
    else: dedup.append(a)
attempts = sorted(dedup, key=lambda a: a["dt"], reverse=True)

# ---- charts ----
NAVY, ACC, LINE_C, MUT = "hsl(215 60% 22%)", "#b45309", "hsl(215 25% 88%)", "hsl(215 15% 46%)"
def columns(points, color=NAVY, height=170, unit="readers"):
    W, H, L, B, T = 1000, height, 34, 24, 10
    n = len(points); slot = (W - L) / max(n, 1); bw = max(3, slot * 0.62)
    mx = max([v for _, v in points] + [1]); step = 1 if mx <= 4 else (5 if mx <= 20 else (10 if mx <= 100 else 50)); top = -(-mx // step) * step
    if top // 2 % step and top > 4: top += step
    y = lambda v: T + (H - T - B) * (1 - v / top)
    s = [f'<svg viewBox="0 0 {W} {H}" width="100%" role="img" aria-label="{esc(unit)} per day" style="display:block">']
    for gv in sorted({0, top // 2 if top > 1 else 0, top}):
        s.append(f'<line x1="{L}" x2="{W}" y1="{y(gv):.1f}" y2="{y(gv):.1f}" stroke="{LINE_C}" stroke-width="1"/>'
                 f'<text x="{L-6}" y="{y(gv)+4:.1f}" font-size="11" fill="{MUT}" text-anchor="end">{gv}</text>')
    for i, (d, v) in enumerate(points):
        x = L + i * slot + (slot - bw) / 2
        s.append(f'<g><title>{esc(d.strftime("%a %b %d"))}: {v} {esc(unit)}</title><rect x="{L+i*slot:.1f}" y="{T}" width="{slot:.1f}" height="{H-T-B}" fill="transparent"/>')
        if v:
            h = (H - T - B) * v / top; r = min(4, bw / 2, h)
            s.append(f'<path d="M{x:.1f},{H-B} v{-(h-r):.1f} q0,{-r:.1f} {r:.1f},{-r:.1f} h{bw-2*r:.1f} q{r:.1f},0 {r:.1f},{r:.1f} v{h-r:.1f} z" fill="{color}"/>')
        s.append('</g>')
        if d.weekday() == 0 or i == n - 1:
            s.append(f'<text x="{x+bw/2:.1f}" y="{H-6}" font-size="11" fill="{MUT}" text-anchor="middle">{d.strftime("%b %d")}</text>')
    s.append("</svg>")
    return "".join(s)

def hbars(items, color=NAVY):
    if not items: return '<p class="none">None yet.</p>'
    mx = max(c for _, c in items) or 1
    return '<div class="hbars">' + "".join(
        f'<div class="hb"><span class="hl" title="{esc(k)}">{esc(k)}</span><span class="ht"><span style="width:{100*c/mx:.1f}%;background:{color}"></span></span><span class="hv">{num(c)}</span></div>'
        for k, c in items) + '</div>'

def step_table(title, items, head, limit=12):
    o = [f'<div class="card tw"><table><tr><th>{esc(head)}</th>' + "".join(f'<th class="r">{esc(s)}</th>' for s in STEPS) + '</tr>']
    for k, c in items[:limit]:
        o.append(f'<tr><td><code>{esc(k)}</code></td>' if head == "Landing page" else f'<tr><td>{esc(k)}</td>')
        o.append("".join(f'<td class="r">{num(n)}{f" <span class=mut>{pct(n, c[0])}</span>" if i and n else ""}</td>' for i, n in enumerate(c)) + '</tr>')
    if not items: o.append(f'<tr><td colspan="{len(STEPS)+1}" class="mut">No readers yet.</td></tr>')
    o.append('</table></div>')
    return f'<h2>{esc(title)}</h2>' + "".join(o)

G = None
gsc_path = os.path.join(HOME, "gsc.json")
if os.path.exists(gsc_path):
    try: G = json.load(open(gsc_path))
    except Exception: G = None

# ---- the page ----
out = [f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta http-equiv="refresh" content="300"><title>Saybooks · visitors</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<style>
*{{box-sizing:border-box;margin:0}}body{{font:14px/1.55 -apple-system,'Segoe UI',sans-serif;color:hsl(215 40% 16%);background:hsl(210 20% 98%);padding:2em 1.5em}}
.wrap{{max-width:1360px;margin:0 auto}}h1{{font-family:'IBM Plex Sans',sans-serif;font-weight:700;letter-spacing:-.02em;font-size:26px;margin-bottom:.2em}}
.asof{{color:{MUT};font-size:12.5px;margin-bottom:1.4em;max-width:110ch}}.asof a{{color:{NAVY};font-weight:600}}
h2{{font-family:'IBM Plex Sans',sans-serif;font-weight:700;letter-spacing:-.02em;font-size:18px;margin:1.8em 0 .6em}}
.card{{background:#fff;border:1px solid {LINE_C};border-radius:8px;padding:12px 14px}}
.cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}}
.stat b{{display:block;font-size:30px;font-family:'IBM Plex Sans',sans-serif;font-weight:700;letter-spacing:-.02em;color:{NAVY}}}.stat span{{font-size:11.5px;color:{MUT}}}.stat i{{display:block;font-style:normal;font-size:12px;margin-top:4px}}
.funnel{{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}}@media(max-width:720px){{.funnel{{grid-template-columns:repeat(2,minmax(0,1fr))}}}}
.funnel .bar{{height:8px;background:hsl(210 20% 94%);border-radius:4px;margin-top:8px;overflow:hidden}}.funnel .bar span{{display:block;height:100%;background:{NAVY}}}
.two{{display:grid;grid-template-columns:1fr 1fr;gap:16px}}.two>*{{min-width:0}}@media(max-width:860px){{.two{{grid-template-columns:1fr}}}}
table{{width:100%;border-collapse:collapse}}th{{text-align:left;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:{MUT};padding:7px 10px;border-bottom:1px solid {LINE_C}}}
td{{padding:6px 10px;border-bottom:1px solid hsl(215 25% 93%);font-size:13px;vertical-align:top}}tr:last-child td{{border-bottom:0}}
td.r,th.r{{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}}td.when{{white-space:nowrap;color:{MUT}}}.mut{{color:{MUT}}}
.tw{{overflow-x:auto}}code{{font-family:ui-monospace,monospace;font-size:12px;background:hsl(210 20% 95%);padding:1px 5px;border-radius:4px}}
.pages code{{margin:0 4px 3px 0;display:inline-block}}
.pill{{display:inline-block;background:hsl(210 20% 94%);border-radius:8px;padding:1px 9px;font-size:11.5px;white-space:nowrap}}
.pill.hot{{background:#fdf0dd;color:{ACC}}}.pill.s1{{background:#e3ecf7;color:#2c5282}}.pill.s2,.pill.s3,.pill.allowed{{background:#e2f3e8;color:#1e6b3f}}
.hbars{{display:grid;gap:7px}}.hb{{display:grid;grid-template-columns:minmax(0,40%) 1fr auto;gap:10px;align-items:center;font-size:13px}}
.hl{{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}.ht{{background:hsl(210 20% 94%);border-radius:3px;height:10px;overflow:hidden}}.ht span{{display:block;height:100%}}
.hv{{font-variant-numeric:tabular-nums;min-width:2.5em;text-align:right}}
.note{{color:{MUT};font-size:12px;margin:8px 0 0}}.none{{color:{MUT}}}
details{{margin:30px 0 10px}}summary{{cursor:pointer;font-weight:600;font-size:14px}}
footer{{color:{MUT};font-size:12px;font-style:italic;margin-top:1.8em;line-height:1.7;max-width:120ch}}
</style></head><body><div class="wrap">
<h1>Saybooks · visitors</h1>
<p class="asof">Rebuilt every 10 minutes from the saybooks.io web log; updated {esc(now.strftime('%a %b %d, %H:%M'))} Portland time. Everyone before the sandbox: what they read, where they came from, how far they got. <a href="/admin">Sandboxes and sign-ups are on /admin.</a></p>"""]

# 1. KPIs
d7, p7 = visitors(last7), visitors(prev7)
delta = d7 - p7
kp = [(visitors([r for r in people if r["dt"].date() == today]), "readers today", f"{len([r for r in people if r['dt'].date() == today])} page views"),
      (d7, "readers, last 7 days", "same as the week before" if delta == 0 else f"{delta:+d} on the week before"),
      (visitors(last30), "readers, last 30 days", f"{len(last30)} page views"),
      (funnel[1], "opened the app, 30 days", f"{pct(funnel[1], funnel[0])} of readers"),
      (len(attempts), "connector attempts, 30 days", f"{sum(1 for a in attempts if a['step'] == 'allowed')} allowed")]
out.append('<div class="cards">' + "".join(f'<div class="card stat"><b>{num(n)}</b><span>{esc(l)}</span><i>{esc(d)}</i></div>' for n, l, d in kp) + '</div>')

# 2. how far readers got
out.append('<h2>How far readers got, 30 days</h2><div class="funnel">' + "".join(
    f'<div class="card stat"><b>{num(n)}</b><span>{esc(s)}{"" if not i else " · " + pct(n, funnel[0]) + " of readers"}</span>'
    f'<div class="bar"><span style="width:{(100 * n / funnel[0]) if funnel[0] else 0:.1f}%"></span></div></div>'
    for i, (s, n) in enumerate(zip(STEPS, funnel))) + '</div>'
    '<p class="note">One reader is one address and browser. Opened the app is a GET of /app, did something is any command sent from it, signed in is a finished Google sign-in. A reader who switches device midway shows as two.</p>')

# 3. readers per day
pts = [(today - timedelta(days=i), visitors([r for r in people if r["dt"].date() == today - timedelta(days=i)])) for i in range(29, -1, -1)]
out.append(f'<h2>Readers per day, last 30 days</h2><div class="card">{columns(pts)}</div>')

# 4. by landing page and by source
out.append('<div class="two"><div>' + step_table("By landing page, 30 days", by_dim("landing"), "Landing page") + '</div><div>'
           + step_table("By source, 30 days", by_dim("source"), "Source") + '</div></div>')
out.append(f'<div class="two"><div><h2>Where readers stopped, 30 days</h2><div class="card">{hbars(stopped, ACC)}'
           '<p class="note">The last page read by readers who never opened the app.</p></div></div>'
           f'<div><h2>Most read pages, 30 days</h2><div class="card">{hbars(Counter(r["path"] for r in last30).most_common(10))}</div></div></div>')

# 5. recent visits
out.append('<h2>Recent visits</h2><div class="card tw"><table><tr><th>When</th><th>From</th><th>Network</th><th>Got to</th><th>Pages read</th></tr>')
for v in visits[:40]:
    src = visit_source(v); hot = src not in ("Direct or app", "Within the site")
    st = reached(v)
    paths = []
    for r in v:
        if is_page(r) and (not paths or paths[-1] != r["path"]): paths.append(r["path"])
    out.append(f'<tr><td class="when">{esc(v[0]["dt"].strftime("%a %b %d, %H:%M"))}</td><td><span class="pill{" hot" if hot else ""}">{esc(src)}</span></td>'
               f'<td class="mut">{esc(short_net(v[0]["net"]))}</td><td><span class="pill s{st}">{esc(STEPS[st])}</span></td>'
               f'<td class="pages">{"".join(f"<code>{esc(p)}</code>" for p in paths[:8])}{" …" if len(paths) > 8 else ""}</td></tr>')
if not visits: out.append('<tr><td colspan="5" class="mut">No visits yet.</td></tr>')
out.append('</table><p class="note">A visit is one address and browser, with requests less than 30 minutes apart. Network is the internet provider, not the person or company.</p></div>')

# 6. connector attempts
out.append('<h2>Connector attempts, 30 days</h2><div class="card tw"><table><tr><th>When</th><th>Client</th><th>Door</th><th>Got to</th><th>Network</th></tr>')
for a in attempts[:25]:
    out.append(f'<tr><td class="when">{esc(a["dt"].strftime("%a %b %d, %H:%M"))}</td><td>{esc(a["client"])}</td><td><code>{esc(a["door"])}</code></td>'
               f'<td><span class="pill{" allowed" if a["step"] == "allowed" else ""}">{esc(a["step"])}</span></td><td class="mut">{esc(short_net(a["net"]))}</td></tr>')
if not attempts: out.append('<tr><td colspan="5" class="mut">None in the last 30 days.</td></tr>')
out.append('</table><p class="note">An attempt starts when a client sends someone\'s browser to /authorize. It then needs a sign-in, the consent page, and Allow. The client is read from where it asked to be sent back.</p></div>')

# 7. AI assistants fetching a page for a person
AIU = [("Claude Code", "claude-code"), ("Claude", "claude-user"), ("ChatGPT", "chatgpt-user"), ("Perplexity", "perplexity-user")]
ai_reads = []
for r in rows:
    if r["dt"] < now - timedelta(days=30) or not is_page(r) or r["kind"] == "excluded": continue
    u = r["ua"].lower()
    for name, tok in AIU:
        if tok in u: ai_reads.append((r["dt"], name, r["path"])); break
ai_reads.sort(reverse=True)
out.append('<h2>AI assistants reading a page for someone, 30 days</h2><div class="card tw">')
out.append('<table><tr><th>When</th><th>Assistant</th><th>Page</th></tr>' + "".join(
    f'<tr><td class="when">{esc(d.strftime("%a %b %d, %H:%M"))}</td><td>{esc(n)}</td><td><code>{esc(p)}</code></td></tr>' for d, n, p in ai_reads[:12]) + '</table>'
    if ai_reads else '<p class="none">None in the last 30 days.</p>')
out.append('</div>')

# 8. Google Search
if G:
    q = G.get("queries", []); qp = G.get("query_page", [])
    imp = sum(r["impressions"] for r in q); clk = sum(r["clicks"] for r in q)
    days_ = [(datetime.strptime(r["keys"][0], "%Y-%m-%d").date(), r["impressions"]) for r in G.get("by_date", [])][-30:]
    out.append('<h2>Google Search, last 28 days</h2><div class="cards">' + "".join(
        f'<div class="card stat"><b>{num(n)}</b><span>{esc(l)}</span></div>' for n, l in
        [(imp, "times shown in results"), (clk, "clicks"), (len(q), "different searches"), (sum(1 for r in q if r["position"] <= 10), "searches averaging page one")]) + '</div>')
    if days_:
        out.append(f'<div class="card" style="margin-top:10px">{columns(days_, ACC, 140, "times shown")}<p class="note">Times shown in Google results per day, through {esc(days_[-1][0].strftime("%b %d"))}. Google reports two to three days late.</p></div>')
    best = {}
    for r in qp:
        k = r["keys"][0]
        if k not in best or r["impressions"] > best[k]["impressions"]: best[k] = r
    out.append('<div class="card tw" style="margin-top:10px"><table><tr><th>Search</th><th class="r">Shown</th><th class="r">Clicks</th><th class="r">Avg position</th><th>Page</th></tr>')
    for r in sorted(q, key=lambda r: (-r["impressions"], r["position"]))[:20]:
        k = r["keys"][0]; pg = best.get(k, {}).get("keys", ["", ""])[1].replace("https://saybooks.io", "") or "/"
        out.append(f'<tr><td>{esc(k)}</td><td class="r">{num(r["impressions"])}</td><td class="r">{num(r["clicks"])}</td><td class="r">{r["position"]:.1f}</td><td><code>{esc(pg)}</code></td></tr>')
    if not q: out.append('<tr><td colspan="5" class="mut">No searches yet.</td></tr>')
    out.append(f'</table><p class="note">From Search Console, fetched {esc(G.get("fetched", ""))}. Position is the average across every time the site was shown.</p></div>')

# 9. machines, collapsed
named = []
for name in NAMED:
    hits = [r for r in rows if name.lower() in r["ua"].lower()]
    if hits: named.append((name, len(hits), max(h["dt"] for h in hits)))
named.sort(key=lambda x: -x[1])
dc_nets = Counter(short_net(r["net"]) for r in dc).most_common(8)
probes = Counter(r["path"] for r in rows if r["status"] == 404).most_common(8)
out.append('<details><summary>Machines and filtering</summary><div class="cards" style="margin:12px 0">' + "".join(
    f'<div class="card stat"><b>{num(n)}</b><span>{esc(l)}</span></div>' for n, l in [(len(norender), "page views by browsers that never drew a page"),
    (len(selfref), "page views by browsers that arrived saying they came from saybooks.io"),
    (len(dc), "hits from hosting networks"), (len(crawlers), "declared crawler hits"), (len(excluded), "your own requests and admin views")]) + '</div>')
out.append('<div class="two"><div class="card tw"><table><tr><th>Crawler</th><th class="r">Hits</th><th>Last seen</th></tr>' +
           ("".join(f'<tr><td>{esc(n)}</td><td class="r">{num(c)}</td><td class="when">{esc(l.strftime("%b %d %H:%M"))}</td></tr>' for n, c, l in named) or '<tr><td colspan="3" class="mut">None.</td></tr>') +
           '</table></div><div class="card tw"><table><tr><th>Hosting network</th><th class="r">Hits</th></tr>' +
           ("".join(f'<tr><td class="mut">{esc(n)}</td><td class="r">{num(c)}</td></tr>' for n, c in dc_nets) or '<tr><td colspan="2" class="mut">None.</td></tr>') +
           '</table></div></div><div class="card tw" style="margin-top:10px"><table><tr><th>404 probes</th><th class="r">Hits</th></tr>' +
           ("".join(f'<tr><td><code>{esc(p[:70])}</code></td><td class="r">{num(c)}</td></tr>' for p, c in probes) or '<tr><td colspan="2" class="mut">None.</td></tr>') +
           '</table></div></details>')

out.append(f"""<footer>Log for {esc(first.strftime('%b %d'))} to {esc(last.strftime('%b %d, %Y'))}, {num(len(rows))} lines; the per-site log starts 1 November 2026, nothing before it was kept. A reader is one address plus one browser string that fetched the site icon and then the public stylesheet or an app call, from a network that is not a hosting provider, without a crawler's name. Someone who blocks the icon, or returns on a new address, is missed or split, so the numbers are close to a floor. Your own addresses: exclude-ips.txt on the host, plus any address the admin page answered for.</footer></div></body></html>""")
print("\n".join(out))
