#!/usr/bin/env python3
"""Regenerate playlists/index.json from what's actually on disk.

Existing entries keep their display name and their position in the list;
new .m3u files are appended using the filename stem as the name, and
entries whose file has disappeared are dropped.

    python3 tools/build-manifest.py            # show what would change
    python3 tools/build-manifest.py --apply    # write index.json
"""
import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLAYLIST_DIR = ROOT / "playlists"
MANIFEST = PLAYLIST_DIR / "index.json"


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
