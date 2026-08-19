"""Shared m3u reading/writing.

Entries keep their raw lines, so rewriting a playlist never drops
directives the player doesn't happen to use — mc.m3u and MeatSenpaii.m3u
carry #EXTVLCOPT start/stop times that slice one video into several
distinct entries, and those must survive a round trip.
"""
import pathlib


class Entry:
    __slots__ = ("raw", "url")

    def __init__(self, raw, url):
        self.raw = raw          # every line belonging to this entry, verbatim
        self.url = url

    @property
    def options(self):
        """#EXT directives other than the title line — what makes two
        entries with the same URL genuinely different."""
        return tuple(
            l.strip() for l in self.raw
            if l.strip().startswith("#EXT") and not l.strip().startswith("#EXTINF")
        )

    @property
    def key(self):
        return (self.url, self.options)

    @property
    def title(self):
        for l in self.raw:
            s = l.strip()
            if s.startswith("#EXTINF"):
                return s.split(",", 1)[1].strip() if "," in s else ""
        return ""


def read(path):
    """-> (preamble_lines, [Entry], trailer_lines)"""
    lines = pathlib.Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
    preamble, entries, cur = [], [], []
    seen_extinf = False

    for line in lines:
        s = line.strip()
        if s.startswith("#EXTINF"):
            if not seen_extinf:
                preamble, cur = cur, []
                seen_extinf = True
            cur.append(line)
        elif s.startswith("http"):
            cur.append(line)
            entries.append(Entry(cur, s))
            cur = []
        else:
            cur.append(line)

    return preamble, entries, cur


def write(path, preamble, entries, trailer):
    out = list(preamble)
    for e in entries:
        out.extend(e.raw)
    out.extend(trailer)
    text = "\n".join(out).rstrip("\n") + "\n"
    pathlib.Path(path).write_text(text, encoding="utf-8")
