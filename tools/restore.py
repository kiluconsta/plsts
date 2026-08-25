#!/usr/bin/env python3
"""Put pruned entries back.

check-links.py appends whatever it removes to playlists/<name>.m3u.dead.
This reads those sidecars and merges the entries back into the playlist
they came from, in case a sweep took out something that was only
temporarily unreachable.

    python3 tools/restore.py                        # what would come back
    python3 tools/restore.py --apply                # restore everything
    python3 tools/restore.py --file X3.m3u --apply  # just one playlist
    python3 tools/restore.py --apply --keep-dead    # don't clear the sidecars

Restored entries are appended to the end of the playlist rather than
threaded back into their original position — the order in these lists
isn't meaningful, and appending can't corrupt what's already there.
"""
import argparse
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import m3u

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLAYLIST_DIR = ROOT / "playlists"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write the playlists")
    ap.add_argument("--file", help="restore into a single playlist (filename in playlists/)")
    ap.add_argument("--keep-dead", action="store_true", help="leave the .dead sidecars in place")
    args = ap.parse_args()

    sidecars = ([PLAYLIST_DIR / (args.file + ".dead")] if args.file
                else sorted(PLAYLIST_DIR.glob("*.m3u.dead")))
    sidecars = [s for s in sidecars if s.exists()]
    if not sidecars:
        print("nothing to restore — no .dead sidecars found")
        return 0

    total = 0
    for dead_path in sidecars:
        playlist = dead_path.with_suffix("")          # X3.m3u.dead -> X3.m3u
        if not playlist.exists():
            print(f"  ! {playlist.name} is gone, skipping {dead_path.name}")
            continue

        preamble, entries, trailer = m3u.read(playlist)
        _, dead_entries, _ = m3u.read(dead_path)

        have = {e.key for e in entries}
        back = [e for e in dead_entries if e.key not in have]
        if not back:
            print(f"  = {playlist.name}: already has all {len(dead_entries)} entries")
            continue

        total += len(back)
        print(f"  + {playlist.name}: {len(back)} entries")
        if args.apply:
            m3u.write(playlist, preamble, entries + back, trailer)
            if not args.keep_dead:
                dead_path.unlink()

    print(f"\n{total} entries" + (" restored" if args.apply else " would come back (re-run with --apply)"))
    if args.apply and total:
        print("remember to re-run build-manifest.py --apply to refresh the counts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
