#!/usr/bin/env python3
"""Drop repeated entries from playlists.

Two entries count as duplicates only when they share a URL *and* the same
#EXT directives — mc.m3u lists one video four times with different
#EXTVLCOPT start/stop times, and those are four different clips, not one
repeated four times.

By default only duplicates *within* a single playlist are removed, which is
always safe. Duplicates spanning two playlists are usually deliberate (the
same clip in two themed lists), so they're only reported.

    python3 tools/dedupe.py                  # report
    python3 tools/dedupe.py --apply          # rewrite the files
    python3 tools/dedupe.py --cross-file     # also report cross-playlist overlap
"""
import argparse
import collections
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import m3u

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLAYLIST_DIR = ROOT / "playlists"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="rewrite the playlist files")
    ap.add_argument("--cross-file", action="store_true", help="also report URLs shared between playlists")
    args = ap.parse_args()

    total_removed = 0
    seen_in = collections.defaultdict(set)

    for path in sorted(PLAYLIST_DIR.glob("*.m3u")):
        preamble, entries, trailer = m3u.read(path)
        seen, kept = set(), []
        for e in entries:
            if e.key in seen:
                continue
            seen.add(e.key)
            kept.append(e)
        for e in entries:
            seen_in[e.url].add(path.name)

        removed = len(entries) - len(kept)
        if not removed:
            continue
        total_removed += removed
        print(f"  {path.name}: {removed} duplicate{'s' if removed != 1 else ''} of {len(entries)}")
        if args.apply:
            m3u.write(path, preamble, kept, trailer)

    print(f"\n{total_removed} within-playlist duplicate{'s' if total_removed != 1 else ''}"
          + (" removed" if args.apply else " found (re-run with --apply to remove)"))

    if args.cross_file:
        shared = {u: f for u, f in seen_in.items() if len(f) > 1}
        print(f"{len(shared)} URLs appear in more than one playlist (left alone)")
        for url, files in list(shared.items())[:10]:
            print(f"  …{url[-60:]}  →  {', '.join(sorted(files))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
