"""Log rules: how a log line is read, which user agents are bots, which networks are hosting providers.
Copied from petervarga-site/tools/stats/rules.py (the Portland AI Works admin), so both sites agree
about who is a person. Keep the two in step."""
import re

LINE = re.compile(r'^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d{3}) (\S+) "([^"]*)" "([^"]*)"')
BOT_TOKENS = ["rootevidence", "domainbox", "undici", "bot", "crawl", "spider", "slurp", "curl", "wget", "python", "go-http", "httpclient", "headless",
              "scrapy", "facebookexternalhit", "preview", "monitor", "uptime", "google-extended", "claude-user",
              "perplexity-user", "chatgpt-user", "meta-externalagent", "setup-check", "feedfetcher", "fetch",
              "ips-agent", "censys", "expanse", "palo alto", "zgrab", "masscan", "nmap", "java/", "okhttp", "axios",
              "libwww", "httrack", "nutch", "lighthouse", "pingdom", "site24x7", "statuscake", "gtmetrix", "pagespeed",
              "dataforseo", "ahrefs", "semrush", "mj12", "petal", "bytespider", "imagesift", "timpi", "ccbot", "diffbot",
              "anthropic-ai", "cohere", "omgili", "yandex", "baidu", "sogou", "seznam", "qwant", "ia_archiver", "archive.org",
              "netsystemsresearch", "internetmeasurement", "l9explore", "odin",
              "iphone os 13_2_3", "opera/9.80"]  # the last two are scanner fingerprints, not real 2026 browsers
HOSTING = ["internet-archive", "it7net", "carinet", "railway", "quickpacket", "glesys", "velia", "opendns", "cisco-umbrella", "amazon", "aws", "google", "microsoft", "azure", "hetzner", "digitalocean", "linode", "akamai", "ovh",
           "vultr", "choopa", "constant", "contabo", "tencent", "alibaba", "aliyun", "alicloud", "huawei", "oracle",
           "hosting", "host", "server", "cloud", "datacenter", "data center", "vps", "colo", "leaseweb", "scaleway",
           "online s.a.s", "ionos", "godaddy", "hostinger", "dreamhost", "m247", "datacamp", "cdn77", "sprious",
           "rayobyte", "shodan", "verisign", "quadranet", "psychz", "zenlayer", "ucloud", "kamatera", "vercel",
           "netlify", "equinix", "limestone", "hivelocity", "reliablesite", "webnx", "servermania", "fdcservers",
           "ucloud", "gcore", "g-core", "stark", "clouvider", "packethub", "performive", "hostpapa", "hostwinds",
           "interserver", "liquid web", "rackspace", "softlayer", "ibm", "upcloud", "exoscale", "fasthosts", "ihor",
           "gtt", "global connections", "zkillu", "eveo", "cogent", "backbone", "transit", "proxy", "vpn", "meerfarbig",
           "netcup", "runtime collective", "brandwatch", "techties", "1337 services", "massivegrid", "custodian",
           "level 3 parent", "tritan", "hostinger", "servers.com", "nforce", "worldstream", "psychz", "colocrossing",
           "hostroyale", "hostpapa", "cloudsigma", "layer host", "bitlaunch", "flokinet", "privatelayer", "hostkey",
           "ionos", "strato", "webhosting", "leaseweb", "serverion", "nocix", "datacamp", "rackdog", "hivelocity"]
NOT_HOSTING = ["fiber", "cloudflare", "telecom", "cable", "wireless", "mobile", "broadband", "comcast", "charter",
               "verizon", "at&t", "t-mobile", "cox", "frontier", "centurylink", "lumen", "ziply", "spectrum"]
def hosting_name(name):
    n = (name or "").lower()
    return bool(n) and not any(t in n for t in NOT_HOSTING) and any(t in n for t in HOSTING)

def is_crawler(ua):
    u = ua.lower()
    return ua == "-" or any(t in u for t in BOT_TOKENS)
