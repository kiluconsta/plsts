# plsts

Kilu's Plst Player — a static m3u playlist player. No build step: plain HTML, CSS
and one `app.js`, served from GitHub Pages.

```
index.html            markup (lock screen, sidebar, player)
app.js                pattern lock, m3u parsing, virtualized list, playback
styles.css            everything visual
playlists/*.m3u       the playlists
playlists/index.json  manifest: display name -> file
tools/*.py            maintenance scripts (stdlib only, no deps)
```

## Adding a playlist

Drop the `.m3u` into `playlists/` and rebuild the manifest:

```bash
python3 tools/build-manifest.py --apply
```

New files are added with the filename as their display name; edit
`playlists/index.json` if you want something prettier. Existing names and
their order are left alone, and entries whose file is gone get dropped. The
player loads playlists lazily, so the manifest is the only index.

## Pattern lock

The site opens on a 3x3 pattern lock instead of a click-through age gate. Dots
are numbered like a phone keypad:

```
1  2  3
4  5  6
7  8  9
```

You can drag across the dots, tap them one at a time, or type the digits and
press Enter. Dragging in a straight line picks up the dot in between (1 to 3
also selects 2), like a phone. Minimum 4 dots; 5 wrong tries triggers a 20
second cooldown. The unlock lasts for the browser session — the 🔒 Lock button
(or pressing `L`) re-locks and pauses playback.

Unlike a phone lock, a dot may be used **more than once** — the only rule is
you can't select the same dot twice in a row.

**Pattern: 1-2-3-5-2** — across the top row, down-left to the middle, then
back up to the top-middle dot.

To change it, open the site, run this in the browser console with your own
digits, and paste the result into `PATTERN_HASH` at the top of `app.js`:

```js
plstHash("12352")
```

This is a doorbell, not a deadbolt — it's a client-side check, and the playlist
files stay publicly readable at `playlists/*.m3u` regardless. It keeps casual
eyes off the player, nothing more.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `space` | play / pause |
| `←` `→` or `p` `n` | previous / next |
| `↑` `↓` | volume |
| `m` | mute |
| `f` | fullscreen |
| `l` | lock |

## Sidebar buttons

| Button | What it does |
| --- | --- |
| ⇄ Shuffle | shuffles the loaded playlist |
| ↻ Auto | auto-advance to the next video |
| 📂 Open File / ☁ From URL | load an m3u from disk or a direct URL |
| ▤ Compact | denser list rows |
| 🧹 Clean | drop entries that failed this session |
| 🔒 Lock | re-lock and pause |
| ⤓ Export | download the current list as .m3u (after Clean, this saves the pruned version) |

## Playback routing

Some hosts serve video directly; `twimg.com` and `redgifs.com` refuse
hotlinks and only work through the Cloudflare Worker. The player remembers
which is which per host in localStorage, so known-blocked hosts go straight
to the proxy and direct-capable hosts (lpsg, bsky, monstercockland) skip it
entirely. Unknown hosts get one direct attempt, then fall back. HLS
(`.m3u8`) always goes through the Worker — its segments need the CORS
headers.

The next clip is prefetched while the current one plays.

## Maintenance

```bash
python3 tools/build-manifest.py --apply   # sync index.json with playlists/
python3 tools/dedupe.py                   # report repeated entries
python3 tools/dedupe.py --apply           # remove within-playlist duplicates
python3 tools/check-links.py --sample 50  # spot-check for rot
python3 tools/check-links.py              # full sweep, writes tools/dead-links.json
python3 tools/check-links.py --prune      # remove dead entries (backs up to *.m3u.dead)
```

`dedupe.py` only treats entries as duplicates when the URL *and* the `#EXT`
directives match — `mc.m3u` and `MeatSenpaii.m3u` list the same video several
times with different `#EXTVLCOPT` start/stop times, and those are separate
clips.

A full `check-links.py` sweep makes one request per entry (~6k), so it takes
a while; a `--sample` run is the quick health check. A spot check of 40 URLs
came back 5% dead.

## Automated sweep

[`.github/workflows/link-check.yml`](.github/workflows/link-check.yml) runs
the full check every Monday at 05:17 UTC, prunes what's gone, and commits the
result. You can also start it by hand from the Actions tab — untick *prune*
there to get a report without changing anything.

Every run appends to [`tools/prune-log.md`](tools/prune-log.md): date, how
many URLs were checked, how many were dead, and how many entries came out of
each playlist. The entries themselves are appended to
`playlists/<name>.m3u.dead`, so anything removed can be put back.

If more than 20% of the library comes back dead the run **refuses to prune**
and fails. That's almost always a host blocking the GitHub runner rather than
the library rotting overnight — a datacenter IP gets a different reception
than your browser does. Raise or lower the bar with `--max-dead-pct`.
