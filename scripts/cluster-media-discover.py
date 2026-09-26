#!/usr/bin/env python3
"""Find reusable Commons media on a cluster worker; emit a compact JSON manifest.

Each worker searches a separate result offset. No media is downloaded by this job.
Only explicit CC0, public-domain and CC BY 3.0/4.0 metadata is admitted; a
human must still inspect the source page and any depicted trademarks/people.
"""

import argparse
import html
import json
import re
import sys
from urllib.parse import urlencode
from urllib.request import Request, urlopen

API = "https://commons.wikimedia.org/w/api.php"
UA = "CurtClusterMediaDiscovery/1.0 (https://curtbrag.com/cluster/dashboard/)"
LICENSES = {
    "cc0": "CC0",
    "public domain": "Public domain",
    "cc by 3.0": "CC BY 3.0",
    "cc by 4.0": "CC BY 4.0",
}


def clean(value, length=160):
    value = re.sub(r"<[^>]*>", " ", html.unescape(str(value or "")))
    return re.sub(r"\s+", " ", value).strip()[:length]


def metadata(info, name):
    value = info.get("extmetadata", {}).get(name, {})
    return clean(value.get("value", "") if isinstance(value, dict) else value)


def fetch(params):
    url = API + "?" + urlencode({"action": "query", "format": "json", "formatversion": 2, **params})
    with urlopen(Request(url, headers={"User-Agent": UA}), timeout=20) as response:
        return json.load(response)


def discover(query, kind, offset, limit, fetcher=fetch):
    # Two small API calls per worker; offsets split the search across devices.
    search = fetcher({"list": "search", "srnamespace": 6, "srsearch": query,
                      "sroffset": offset, "srlimit": min(30, limit * 6)})
    titles = [row["title"] for row in search.get("query", {}).get("search", []) if row.get("title", "").startswith("File:")]
    if not titles:
        return []
    data = fetcher({"prop": "imageinfo", "titles": "|".join(titles),
                    "iiprop": "url|size|mime|sha1|extmetadata"})
    items = []
    for page in data.get("query", {}).get("pages", []):
        info = (page.get("imageinfo") or [{}])[0]
        mime = info.get("mime", "")
        if kind == "image" and not mime.startswith("image/"):
            continue
        if kind == "video" and not mime.startswith("video/"):
            continue
        if kind == "any" and not (mime.startswith("image/") or mime.startswith("video/")):
            continue
        if mime in ("image/svg+xml", "image/tiff", "image/gif"):
            continue
        license_name = LICENSES.get(metadata(info, "LicenseShortName").lower())
        url = info.get("url", "")
        page_url = info.get("descriptionurl", "")
        if not license_name or not url.startswith("https://upload.wikimedia.org/") or not page_url.startswith("https://commons.wikimedia.org/"):
            continue
        if int(info.get("width") or 0) < 720 or int(info.get("height") or 0) < 720:
            continue
        items.append({"title": clean(page.get("title"), 120), "url": url,
                      "page": page_url, "license": license_name,
                      "license_url": metadata(info, "LicenseUrl"),
                      "author": metadata(info, "Artist"),
                      "sha1": info.get("sha1", ""), "mime": mime,
                      "width": info.get("width"), "height": info.get("height"),
                      "bytes": info.get("size")})
        if len(items) >= limit:
            break
    return items


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--query", required=True)
    parser.add_argument("--kind", choices=("image", "video", "any"), default="any")
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--limit", type=int, default=3)
    args = parser.parse_args()
    if not 2 <= len(args.query) <= 100 or not 0 <= args.offset <= 5000 or not 1 <= args.limit <= 4:
        parser.error("query, offset, or limit outside allowed range")
    try:
        items = discover(args.query, args.kind, args.offset, args.limit)
        result = {"v": 1, "source": "Wikimedia Commons", "query": args.query,
                  "offset": args.offset, "items": items}
        payload = json.dumps(result, ensure_ascii=True, separators=(",", ":"))
        while len(payload) > 3900 and result["items"]:
            result["items"].pop()
            payload = json.dumps(result, ensure_ascii=True, separators=(",", ":"))
        print(payload)
    except Exception as exc:
        print(f"Media discovery failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
