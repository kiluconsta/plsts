#!/usr/bin/env python3
"""Regenerate playlists/index.json from what's actually on disk.

Existing entries keep their display name and their position in the list;
new .m3u files are appended using the filename stem as the name, and
entries whose file has disappeared are dropped.

Each entry also carries a "count" and "seconds" total, computed here so
the player can show playlist sizes without fetching and parsing all 65
files in the browser.

    python3 tools/build-manifest.py            # show what would change
    python3 tools/build-manifest.py --apply    # write index.json
"""
import argparse
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import m3u

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLAYLIST_DIR = ROOT / "playlists"
MANIFEST = PLAYLIST_DIR / "index.json"


def stats(filename):
    """-> (entry count, total seconds of the entries that declare a duration)"""
    _, entries, _ = m3u.read(PLAYLIST_DIR / filename)
    seconds = 0
    for e in entries:
        for line in e.raw:
            hit = re.match(r"#EXTINF:(-?\d+)", line.strip())
            if hit:
                seconds += max(0, int(hit.group(1)))
                break
    return len(entries), seconds


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write the file instead of previewing")
    args = ap.parse_args()

    existing = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else []
    on_disk = sorted(p.name for p in PLAYLIST_DIR.glob("*.m3u"))

    kept = [e for e in existing if e["file"] in set(on_disk)]
    dropped = [e for e in existing if e["file"] not in set(on_disk)]
    known = {e["file"] for e in kept}
    added = [{"name": pathlib.Path(f).stem, "file": f} for f in on_disk if f not in known]

    manifest = kept + added
    for entry in manifest:
        entry["count"], entry["seconds"] = stats(entry["file"])

    for e in dropped:
        print(f"  - dropped  {e['file']}  ({e['name']})")
    for e in added:
        print(f"  + added    {e['file']}  ({e['name']})")
    if not dropped and not added:
        print("  manifest already matches the directory")

    print(f"\n{len(manifest)} entries")
    if args.apply:
        MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"wrote {MANIFEST.relative_to(ROOT)}")
    elif dropped or added:
        print("(preview only — re-run with --apply to write)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
