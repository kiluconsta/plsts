#!/usr/bin/env python3
"""Find dead entries in the playlists.

Most of these URLs live on CDNs that expire them (video.twimg.com and
friends), so playlists rot steadily. This checks every entry with a cheap
ranged GET, writes a report, and can prune the dead ones.

    python3 tools/check-links.py                     # check everything, write report
    python3 tools/check-links.py --file X3.m3u       # just one playlist
    python3 tools/check-links.py --sample 50         # spot-check 50 random URLs
    python3 tools/check-links.py --prune             # rewrite playlists, dead entries removed

Pruning always writes the removed lines to playlists/<name>.m3u.dead first,
so nothing is lost — and the repo is under git anyway. It also appends a
run summary to tools/prune-log.md.

A ranged GET from a datacenter IP isn't the same as a request from a
browser: a host that blocks the runner will look like a wall of dead
links. So --prune refuses to run when more than --max-dead-pct of the
library comes back dead, which is the shape of a blocked check rather
than genuine rot.
"""
import argparse
import collections
import json
import pathlib
import random
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import m3u

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLAYLIST_DIR = ROOT / "playlists"
REPORT = ROOT / "tools" / "dead-links.json"
LOG = ROOT / "tools" / "prune-log.md"

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
TIMEOUT = 15


def check(url, _retry=True):
    """Return (url, status) — status is an HTTP code, or a short error string."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Range": "bytes=0-1"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return url, r.status
    except urllib.error.HTTPError as e:
        return url, e.code                      # a real answer, don't retry
    except Exception as e:                      # DNS, TLS, timeout, refused…
        if _retry:
            time.sleep(1.5)
            return check(url, _retry=False)
        return url, type(e).__name__


def alive(status):
    return isinstance(status, int) and status < 400


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", help="check a single playlist (filename in playlists/)")
    ap.add_argument("--sample", type=int, help="check only N randomly chosen URLs")
    ap.add_argument("--workers", type=int, default=16, help="concurrent requests (default 16)")
    ap.add_argument("--prune", action="store_true", help="rewrite playlists without the dead entries")
    ap.add_argument("--max-dead-pct", type=float, default=20.0,
                    help="refuse to prune if more than this %% comes back dead (default 20)")
    args = ap.parse_args()

    paths = [PLAYLIST_DIR / args.file] if args.file else sorted(PLAYLIST_DIR.glob("*.m3u"))
    lists = {p: m3u.read(p) for p in paths}
    urls = sorted({e.url for _, entries, _ in lists.values() for e in entries})

    if args.sample:
        urls = random.sample(urls, min(args.sample, len(urls)))
    print(f"checking {len(urls)} URLs across {len(paths)} playlist(s) with {args.workers} workers…\n")

    results, done = {}, 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for url, status in pool.map(check, urls):
            results[url] = status
            done += 1
            if done % 100 == 0 or done == len(urls):
                dead = sum(1 for s in results.values() if not alive(s))
                print(f"  {done}/{len(urls)} checked · {dead} dead", flush=True)

    dead_urls = {u for u, s in results.items() if not alive(s)}
    by_status = collections.Counter(results.values())

    print("\nstatus breakdown:")
    for status, n in by_status.most_common():
        print(f"  {n:6d}  {status}")
    print(f"\n{len(dead_urls)} dead of {len(results)} checked ({len(dead_urls) / max(len(results), 1):.1%})")

    per_file = {}
    for path, (_, entries, _) in lists.items():
        n = sum(1 for e in entries if e.url in dead_urls)
        if n:
            per_file[path.name] = n
    if per_file:
        print("\nworst playlists:")
        for name, n in sorted(per_file.items(), key=lambda kv: -kv[1])[:10]:
            print(f"  {n:5d}  {name}")

    REPORT.write_text(json.dumps(
        {"checked": len(results), "dead": sorted(dead_urls), "per_file": per_file},
        indent=2), encoding="utf-8")
    print(f"\nreport written to {REPORT.relative_to(ROOT)}")

    if not args.prune:
        if dead_urls:
            print("(re-run with --prune to remove them)")
        return 0
    if args.sample:
        print("refusing to prune from a sample — run a full check first")
        return 1

    dead_pct = 100 * len(dead_urls) / max(len(results), 1)
    if dead_pct > args.max_dead_pct:
        print(f"\nrefusing to prune: {dead_pct:.1f}% dead is over the {args.max_dead_pct}% limit.")
        print("that usually means the checker is being blocked, not that the library rotted.")
        return 2

    removed_by_file = {}

    for path, (preamble, entries, trailer) in lists.items():
        keep = [e for e in entries if e.url not in dead_urls]
        gone = [e for e in entries if e.url in dead_urls]
        if not gone:
            continue
        with (path.with_suffix(".m3u.dead")).open("a", encoding="utf-8") as f:
            for e in gone:
                f.write("\n".join(e.raw) + "\n")
        m3u.write(path, preamble, keep, trailer)
        removed_by_file[path.name] = len(gone)
        print(f"  pruned {len(gone)} from {path.name}")

    write_log(len(results), len(dead_urls), dead_pct, removed_by_file, by_status)
    return 0


def write_log(checked, dead, dead_pct, removed_by_file, by_status):
    """Append a run summary to tools/prune-log.md (newest run at the bottom)."""
    total = sum(removed_by_file.values())
    lines = [
        f"## {date.today().isoformat()}",
        "",
        f"Checked {checked:,} URLs · {dead:,} dead ({dead_pct:.1f}%) · "
        f"{total:,} entries removed from {len(removed_by_file)} playlist(s).",
        "",
    ]
    if removed_by_file:
        lines += ["| playlist | removed |", "| --- | ---: |"]
        lines += [f"| {name} | {n} |" for name, n in sorted(removed_by_file.items(), key=lambda kv: -kv[1])]
        lines += ["", "Removed entries are kept in the matching `playlists/*.m3u.dead` file.", ""]

    status_bits = ", ".join(f"{n}×{s}" for s, n in by_status.most_common(6))
    lines += [f"Status codes: {status_bits}", "", "---", ""]

    header = "" if LOG.exists() else "# Prune log\n\nWhat the scheduled link check removed, newest at the bottom.\n\n"
    with LOG.open("a", encoding="utf-8") as f:
        f.write(header + "\n".join(lines) + "\n")
    print(f"logged to {LOG.relative_to(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
