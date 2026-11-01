#!/usr/bin/env python3
"""Pull Google Search Console data for sc-domain:saybooks.io into gsc.json for /admin/visitors.
Stdlib only; the service-account JWT is signed with the openssl binary. Run daily from cron.
Key: the Portland AI Works one (/opt/petervarga-site/gsc-key.json, root, 0600), whose service account
has Restricted (read-only) access to both properties. Adapted from petervarga-site/tools/stats/gsc-fetch.py."""
import base64, json, os, subprocess, tempfile, time, urllib.parse, urllib.request
from datetime import date, timedelta

HOME = os.environ.get("STATS_HOME", "/opt/saybooks-stats")
KEY = json.load(open(os.environ.get("GSC_KEY", "/opt/petervarga-site/gsc-key.json")))
SITE = "sc-domain:saybooks.io"
OUT = os.path.join(HOME, "gsc.json")

def b64(b): return base64.urlsafe_b64encode(b).rstrip(b"=")

def token():
    now = int(time.time())
    head = b64(json.dumps({"alg": "RS256", "typ": "JWT"}).encode())
    claims = b64(json.dumps({"iss": KEY["client_email"], "scope": "https://www.googleapis.com/auth/webmasters.readonly",
                             "aud": KEY["token_uri"], "iat": now, "exp": now + 3600}).encode())
    msg = head + b"." + claims
    with tempfile.NamedTemporaryFile("w", delete=False) as fh:
        os.chmod(fh.name, 0o600); fh.write(KEY["private_key"]); path = fh.name
    try:
        sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", path], input=msg, capture_output=True, check=True).stdout
    finally:
        os.unlink(path)
    body = urllib.parse.urlencode({"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                                   "assertion": (msg + b"." + b64(sig)).decode()}).encode()
    with urllib.request.urlopen(urllib.request.Request(KEY["token_uri"], data=body), timeout=30) as r:
        return json.load(r)["access_token"]

def query(tok, dims, start, end, limit=250):
    url = f"https://www.googleapis.com/webmasters/v3/sites/{urllib.parse.quote(SITE, safe='')}/searchAnalytics/query"
    req = urllib.request.Request(url, data=json.dumps({"startDate": str(start), "endDate": str(end), "dimensions": dims,
                                 "rowLimit": limit, "dataState": "all"}).encode(),
                                 headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r).get("rows", [])

tok = token()
end = date.today(); start = end - timedelta(days=27)
data = {"site": SITE, "fetched": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()), "start": str(start), "end": str(end),
        "by_date": query(tok, ["date"], date(2026, 9, 1), end),
        "queries": query(tok, ["query"], start, end),
        "query_page": query(tok, ["query", "page"], start, end),
        "pages": query(tok, ["page"], start, end)}
tmp = OUT + ".tmp"; json.dump(data, open(tmp, "w")); os.replace(tmp, OUT)
print(f"gsc: {len(data['queries'])} queries, {len(data['pages'])} pages, {len(data['by_date'])} days")
