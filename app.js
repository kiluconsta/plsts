/* ══════════════════════════════════════════════════════════
   Kilu's Plst Player — app.js (v3)
   v2: lazy-loaded /playlists/, local & URL open, auto-skip
   v3 additions:
   - Virtualized list rendering (handles 1000+ items smoothly)
   - localStorage persistence (playlist, position, volume, prefs)
   - Swipe-down to close mobile drawer
   - Volume slider
   - "Clean" button removes entries that failed this session
   - Comfortable/compact density toggle
   v4: 3x3 pattern unlock replaces the age-gate splash
   ══════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════
   PATTERN LOCK  (replaces the old age-gate splash)

   Dots are numbered like a phone keypad:

        1  2  3
        4  5  6
        7  8  9

   Unlike a phone lock, a dot may be used more than once — the
   only rule is you can't select the same dot twice in a row. So
   1-2-3-5-2 is a legal pattern: it comes back up to 2 at the end.

   The unlock pattern is stored as a salted hash of that digit
   sequence, so the raw pattern isn't sitting in the source. To
   change it: open the site, run  plstHash("12352")  in the
   browser console with your own digits, and paste the result
   into PATTERN_HASH below.

   NOTE: this is a client-side lock — a doorbell, not a deadbolt.
   Anyone determined can read app.js or hit playlists/*.m3u
   directly. It keeps casual eyes off the player, nothing more.
   ══════════════════════════════════════════════════════════ */
const PATTERN_SALT   = "plst-lock-v1:";
const PATTERN_HASH   = "447ed841";     // 1-2-3-5-2
const MIN_DOTS       = 4;
const MAX_ATTEMPTS   = 5;              // before a cooldown kicks in
const COOLDOWN_MS    = 20000;
const UNLOCK_KEY     = "plst_unlocked_v1";

/* Resolves once the user is in — init() waits on this so nothing
   starts playing behind the lock screen. */
let markUnlocked;
const unlocked = new Promise(res => { markUnlocked = res; });

(function patternLock() {
  const lockEl   = document.getElementById("lock");
  const gridEl   = document.getElementById("pattern");
  const trailEl  = document.getElementById("pattern-trail");
  const liveEl   = document.getElementById("pattern-live");
  const statusEl = document.getElementById("lock-status");
  const subEl    = document.getElementById("lock-sub");
  const dots     = Array.from(gridEl.querySelectorAll(".dot"));

  /* Dot centres in the SVG's 300×300 coordinate space */
  const CENTRES = dots.map((_, i) => ({
    x: 50 + (i % 3) * 100,
    y: 50 + Math.floor(i / 3) * 100,
  }));
  const HIT_RADIUS = 44;

  let seq = [];              // selected dot indices, 0-based
  let drawing = false;
  let moved = false;         // did this gesture drag, or was it a tap?
  let lastWasDrag = false;
  let downPt = null;
  let attempts = 0;
  let cooldownUntil = 0;
  let settleTimer = null;

  /* FNV-1a (32-bit) — Math.imul keeps the multiply exactly 32-bit */
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }
  window.plstHash = (digits) => hash(PATTERN_SALT + String(digits).replace(/\D/g, ""));

  function toSvgPoint(e) {
    const r = gridEl.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * 300,
      y: ((e.clientY - r.top) / r.height) * 300,
    };
  }

  function dotAt(pt) {
    for (let i = 0; i < CENTRES.length; i++) {
      const dx = pt.x - CENTRES[i].x, dy = pt.y - CENTRES[i].y;
      if (dx * dx + dy * dy <= HIT_RADIUS * HIT_RADIUS) return i;
    }
    return -1;
  }

  /* Dragging 1→3 should also catch 2, the way phone patterns do */
  function midpointBetween(a, b) {
    const r1 = Math.floor(a / 3), c1 = a % 3;
    const r2 = Math.floor(b / 3), c2 = b % 3;
    if ((r1 + r2) % 2 || (c1 + c2) % 2) return -1;
    const mid = ((r1 + r2) / 2) * 3 + (c1 + c2) / 2;
    return mid === a || mid === b ? -1 : mid;
  }

  function addDot(i) {
    if (i < 0 || i === seq[seq.length - 1]) return;   // no immediate repeats
    if (!seq.length) setStatus("");
    if (seq.length) {
      const mid = midpointBetween(seq[seq.length - 1], i);
      if (mid >= 0 && mid !== seq[seq.length - 1]) {
        seq.push(mid);
        dots[mid].classList.add("on");
      }
    }
    seq.push(i);
    dots[i].classList.add("on");
    if (navigator.vibrate) navigator.vibrate(8);
    drawTrail();
  }

  /* Re-light the dots from scratch — a dot can appear twice, so
     undoing one step doesn't necessarily dim it */
  function paintDots() {
    dots.forEach((d, i) => d.classList.toggle("on", seq.includes(i)));
  }

  function drawTrail() {
    trailEl.setAttribute("points", seq.map(i => `${CENTRES[i].x},${CENTRES[i].y}`).join(" "));
  }

  function drawLive(pt) {
    if (!seq.length || !pt) { liveEl.setAttribute("x2", liveEl.getAttribute("x1") || 0); return; }
    const last = CENTRES[seq[seq.length - 1]];
    liveEl.setAttribute("x1", last.x);
    liveEl.setAttribute("y1", last.y);
    liveEl.setAttribute("x2", pt.x);
    liveEl.setAttribute("y2", pt.y);
  }

  function reset(keepStatus) {
    clearTimeout(settleTimer);
    seq = [];
    moved = false;
    downPt = null;
    dots.forEach(d => d.classList.remove("on"));
    gridEl.classList.remove("error", "ok", "shake", "drawing");
    trailEl.setAttribute("points", "");
    liveEl.setAttribute("x2", liveEl.getAttribute("x1") || 0);
    liveEl.setAttribute("y2", liveEl.getAttribute("y1") || 0);
    if (!keepStatus) setStatus("");
  }

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = kind || "";
  }

  function coolingDown() {
    const left = cooldownUntil - Date.now();
    if (left <= 0) return false;
    setStatus(`Too many tries — wait ${Math.ceil(left / 1000)}s`, "bad");
    return true;
  }

  function startCooldown() {
    cooldownUntil = Date.now() + COOLDOWN_MS;
    const tick = () => {
      const left = cooldownUntil - Date.now();
      if (left <= 0) { attempts = 0; setStatus(""); return; }
      setStatus(`Too many tries — wait ${Math.ceil(left / 1000)}s`, "bad");
      setTimeout(tick, 500);
    };
    tick();
  }

  /* Tapping shouldn't punish you mid-pattern — just open up when it matches */
  function quietCheck() {
    if (seq.length < MIN_DOTS || !matches()) return false;
    succeed();
    return true;
  }

  function matches() {
    return hash(PATTERN_SALT + seq.map(i => i + 1).join("")) === PATTERN_HASH;
  }

  function submit() {
    if (!seq.length) return;
    drawLive(null);

    if (seq.length < MIN_DOTS) {
      fail(`Use at least ${MIN_DOTS} dots`);
      return;
    }
    if (matches()) {
      succeed();
    } else {
      attempts++;
      fail(attempts >= MAX_ATTEMPTS ? null : "Wrong pattern");
      if (attempts >= MAX_ATTEMPTS) startCooldown();
    }
  }

  function fail(msg) {
    gridEl.classList.add("error", "shake");
    if (msg) setStatus(msg, "bad");
    if (navigator.vibrate) navigator.vibrate([30, 60, 30]);
    settleTimer = setTimeout(() => reset(true), 650);
  }

  function succeed() {
    gridEl.classList.add("ok");
    setStatus("Unlocked", "good");
    try { sessionStorage.setItem(UNLOCK_KEY, "1"); } catch {}
    setTimeout(hideLock, 380);
  }

  function hideLock() {
    lockEl.classList.add("hidden");
    lockEl.setAttribute("aria-hidden", "true");
    dots.forEach(d => (d.tabIndex = -1));
    markUnlocked();
    document.dispatchEvent(new CustomEvent("plst:unlock"));
  }

  function showLock() {
    reset();
    attempts = 0;
    cooldownUntil = 0;
    lockEl.classList.remove("hidden");
    lockEl.removeAttribute("aria-hidden");
    dots.forEach(d => (d.tabIndex = 0));
    dots[0].focus({ preventScroll: true });
    try { sessionStorage.removeItem(UNLOCK_KEY); } catch {}
  }

  /* ── Pointer (mouse / touch / pen) ── */
  gridEl.addEventListener("pointerdown", (e) => {
    if (coolingDown()) return;
    e.preventDefault();
    /* A finished drag (or a rejected attempt) starts over; a run of taps builds up */
    if (lastWasDrag || gridEl.classList.contains("error")) reset();
    lastWasDrag = false;
    drawing = true;
    moved = false;
    downPt = toSvgPoint(e);
    gridEl.classList.add("drawing");
    gridEl.setPointerCapture(e.pointerId);
    addDot(dotAt(downPt));
  });

  gridEl.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const pt = toSvgPoint(e);
    if (downPt && Math.hypot(pt.x - downPt.x, pt.y - downPt.y) > 12) moved = true;
    addDot(dotAt(pt));
    drawLive(pt);
  });

  const endDraw = (e) => {
    if (!drawing) return;
    drawing = false;
    gridEl.classList.remove("drawing");
    try { gridEl.releasePointerCapture(e.pointerId); } catch {}
    drawLive(null);
    if (moved) { lastWasDrag = true; submit(); }
    else if (!quietCheck() && seq.length) setStatus("Tap the dots, then press Enter");
  };
  gridEl.addEventListener("pointerup", endDraw);
  gridEl.addEventListener("pointercancel", endDraw);

  document.addEventListener("keydown", (e) => {
    if (lockEl.classList.contains("hidden")) return;
    if (e.key >= "1" && e.key <= "9") {
      if (coolingDown()) return;
      if (gridEl.classList.contains("error")) reset();
      lastWasDrag = false;
      addDot(+e.key - 1);
      quietCheck();
      return;
    }
    if (e.key === "Enter") { e.preventDefault(); submit(); return; }
    if (e.key === "Backspace") {
      e.preventDefault();
      seq.pop();
      paintDots();
      drawTrail();
      return;
    }
    if (e.key === "Escape") reset();
  });

  /* Clicking the empty space around the grid clears a half-drawn attempt */
  lockEl.addEventListener("pointerdown", (e) => {
    if (!gridEl.contains(e.target) && seq.length && !drawing) reset();
  });

  /* ── Boot ── */
  let alreadyIn = false;
  try { alreadyIn = sessionStorage.getItem(UNLOCK_KEY) === "1"; } catch {}
  if (alreadyIn) {
    lockEl.classList.add("hidden");
    lockEl.setAttribute("aria-hidden", "true");
    dots.forEach(d => (d.tabIndex = -1));
    markUnlocked();
  } else {
    subEl.textContent = "Draw your pattern to unlock";
    dots[0].focus({ preventScroll: true });
  }

  window.PlstLock = { lock: showLock };
})();

const WORKER = "https://young-truth-052a.kiluconsta.workers.dev/";
const PLAYLIST_DIR = "playlists/";
const MANIFEST_URL = PLAYLIST_DIR + "index.json";
const STORE_KEY = "plst_prefs_v1";

/* ── State ── */
let manifest = [];
const playlistCache = {};
let currentList = [];
let filteredList = [];
let currentIndex = 0;
let shuffle = false;
let auto = true;
let hls = null;
let density = "comfortable";          // or "compact"
const failedUrls = new Set();          // dead entries this session

/* Playback source. Some hosts serve us fine directly (lpsg, bsky,
   monstercockland); twimg and redgifs refuse hotlinks and only work
   through the Worker. Rather than proxy everything — or waste a failed
   load on every twimg clip — we learn which is which per host and
   remember it. Unknown hosts get one direct attempt, then fall back. */
const HOSTS_KEY = "plst_hosts_v1";
const ALWAYS_PROXY = ["twimg.com", "redgifs.com"];
let hostMode = {};
let pendingSrc = null;                 // { url, viaWorker }
let prefetchEl = null;                 // hidden <video> warming the next clip
let savedTime = 0;                     // playback position, persisted
let resumeTime = 0;                    // position to restore on first load

/* Auto-skip state */
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 10;
let skipTimer = null;

/* ── DOM refs ── */
const video        = document.getElementById("video");
const listWrap     = document.getElementById("list-wrap");
const listDiv      = document.getElementById("list");
const statsEl      = document.getElementById("stats");
const selectEl     = document.getElementById("playlistSelect");
const shuffleBtn   = document.getElementById("shuffleBtn");
const autoBtn      = document.getElementById("autoBtn");
const densityBtn   = document.getElementById("densityBtn");
const cleanBtn     = document.getElementById("cleanBtn");
const exportBtn    = document.getElementById("exportBtn");
const lockBtn      = document.getElementById("lockBtn");
const prevBtn      = document.getElementById("prevBtn");
const nextBtn      = document.getElementById("nextBtn");
const playBtn      = document.getElementById("playBtn");
const nowTitle     = document.getElementById("now-playing-title");
const indexBadge   = document.getElementById("index-badge");
const loader       = document.getElementById("loader");
const progressBg   = document.getElementById("progress-bar-bg");
const progressFill = document.getElementById("progress-bar-fill");
const timeCur      = document.getElementById("time-cur");
const timeDur      = document.getElementById("time-dur");
const toastEl      = document.getElementById("toast");
const fileInput    = document.getElementById("fileInput");
const openLocalBtn = document.getElementById("openLocalBtn");
const openUrlBtn   = document.getElementById("openUrlBtn");
const volumeSlider = document.getElementById("volumeSlider");
const sidebar      = document.getElementById("sidebar");
const drawerToggle = document.getElementById("drawer-toggle");
const drawerBackdrop = document.getElementById("drawer-backdrop");

const iconPath  = playBtn.querySelector("path");
const pausePath = "M2 2h4v12H2zm8 0h4v12h-4";
const playPath  = "M3 2l11 6-11 6z";

/* ── Host routing ── */
function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

function needsProxy(url) {
  const h = hostOf(url);
  if (hostMode[h]) return hostMode[h] === "proxy";
  return ALWAYS_PROXY.some(s => h === s || h.endsWith("." + s));
}

function rememberHost(url, mode) {
  const h = hostOf(url);
  if (!h || hostMode[h] === mode) return;
  hostMode[h] = mode;
  try { localStorage.setItem(HOSTS_KEY, JSON.stringify(hostMode)); } catch {}
}

/* ── Persistence ── */
function savePrefs() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      playlist: selectEl.value !== "__external__" ? selectEl.value : null,
      index: currentIndex,
      time: savedTime,
      volume: video.volume,
      muted: video.muted,
      shuffle, auto, density,
    }));
  } catch {}
}

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
  catch { return {}; }
}

/* ── Helpers ── */
function fmtTime(s) {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function fmtDur(d) { return d > 0 ? fmtTime(d) : ""; }

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("visible"), ms);
}

function isMobileLayout() {
  return window.matchMedia("(max-width: 640px), (orientation: landscape) and (max-height: 480px)").matches;
}

/* ── M3U parser ── */
function parseM3U(text) {
  if (!text || typeof text !== "string") return [];
  const lines = text.split("\n");
  const items = [];
  let title = "", dur = 0;
  for (let line of lines) {
    line = line.trim();
    if (line.startsWith("#EXTINF")) {
      const meta = line.slice(8);
      const comma = meta.indexOf(",");
      dur = parseInt(meta.slice(0, comma), 10) || 0;
      title = meta.slice(comma + 1) || "Untitled";
    } else if (line.startsWith("http")) {
      items.push({ title, url: line, dur });
      title = ""; dur = 0;
    }
  }
  return items;
}

/* ── Manifest + lazy playlist loading ── */
async function loadManifest() {
  try {
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) throw new Error(res.status);
    manifest = await res.json();
  } catch (e) {
    toast("⚠ Couldn't load playlist index");
    manifest = [];
  }

  selectEl.innerHTML = "";
  manifest.forEach(entry => {
    const opt = document.createElement("option");
    opt.value = entry.name;
    opt.textContent = entry.name;
    selectEl.appendChild(opt);
  });
}

async function fetchPlaylist(name) {
  if (playlistCache[name]) return playlistCache[name];
  const entry = manifest.find(m => m.name === name);
  if (!entry) return null;
  try {
    const res = await fetch(PLAYLIST_DIR + encodeURIComponent(entry.file));
    if (!res.ok) throw new Error(res.status);
    const text = await res.text();
    const items = parseM3U(text);
    playlistCache[name] = items;
    return items;
  } catch (e) {
    toast(`⚠ Failed to load "${name}"`);
    return null;
  }
}

async function loadPlaylist(name) {
  listDiv.innerHTML = "<div class='list-msg'>Loading…</div>";
  const items = await fetchPlaylist(name);
  if (!items) {
    listDiv.innerHTML = "<div class='list-msg error'>Playlist not found</div>";
    return false;
  }
  currentList = items.slice();
  if (shuffle) shuffleArray(currentList);
  consecutiveFailures = 0;
  applyFilter();
  return true;
}

function loadFromText(text, label) {
  const items = parseM3U(text);
  if (!items.length) {
    toast("⚠ No valid entries found in that file");
    return false;
  }
  currentList = items;
  if (shuffle) shuffleArray(currentList);
  consecutiveFailures = 0;

  let opt = selectEl.querySelector('option[data-external="1"]');
  if (!opt) {
    opt = document.createElement("option");
    opt.dataset.external = "1";
    selectEl.prepend(opt);
  }
  opt.value = "__external__";
  opt.textContent = `📂 ${label}`;
  selectEl.value = "__external__";

  applyFilter();
  playIndex(0);
  toast(`Loaded ${items.length} videos from ${label}`);
  return true;
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/* ── Sync the rendered list with the working list ── */
function applyFilter() {
  filteredList = currentList;
  renderVirtualList();
  updateStats();
}

/* ══════════════════════════════════════════════
   VIRTUALIZED LIST
   Only renders rows visible in the scroll window
   (+ buffer). Fixed row height per density mode.
   ══════════════════════════════════════════════ */
const ROW_HEIGHTS = { comfortable: 36, compact: 26 };
const BUFFER_ROWS = 8;
let renderedRange = [-1, -1];

function rowH() { return ROW_HEIGHTS[density]; }

function renderVirtualList(force = false) {
  const total = filteredList.length;
  listDiv.style.height = (total * rowH()) + "px";

  if (!total) {
    listDiv.innerHTML = "<div class='list-msg'>No videos</div>";
    renderedRange = [-1, -1];
    return;
  }

  const scrollTop = listWrap.scrollTop;
  const viewH = listWrap.clientHeight;
  let start = Math.max(0, Math.floor(scrollTop / rowH()) - BUFFER_ROWS);
  let end   = Math.min(total, Math.ceil((scrollTop + viewH) / rowH()) + BUFFER_ROWS);

  if (!force && start === renderedRange[0] && end === renderedRange[1]) return;
  renderedRange = [start, end];

  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const item = filteredList[i];
    const div = document.createElement("div");
    div.className = "item" + (i === currentIndex ? " playing" : "") + (failedUrls.has(item.url) ? " dead" : "");
    div.dataset.idx = i;
    div.style.top = (i * rowH()) + "px";
    div.innerHTML = `
      <span class="item-num">${i + 1}</span>
      <span class="playing-dot"></span>
      <span class="item-title">${escapeHtml(item.title)}</span>
      <span class="item-dur">${fmtDur(item.dur)}</span>
    `;
    frag.appendChild(div);
  }
  listDiv.innerHTML = "";
  listDiv.appendChild(frag);
}

/* rAF-throttled scroll handler */
let scrollScheduled = false;
listWrap.addEventListener("scroll", () => {
  if (scrollScheduled) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    renderVirtualList();
  });
});

window.addEventListener("resize", () => renderVirtualList(true));

/* Event delegation for row clicks */
listDiv.addEventListener("click", (e) => {
  const row = e.target.closest(".item");
  if (!row) return;
  playIndex(parseInt(row.dataset.idx, 10));
  if (isMobileLayout()) closeDrawer();
});

function updateStats() {
  const dead = filteredList.filter(i => failedUrls.has(i.url)).length;
  statsEl.textContent = `${filteredList.length} videos` + (dead ? ` · ${dead} dead` : "");
}

function highlightActive() {
  renderVirtualList(true);
  // Ensure active row is visible
  const targetTop = currentIndex * rowH();
  const viewTop = listWrap.scrollTop;
  const viewBottom = viewTop + listWrap.clientHeight;
  if (targetTop < viewTop || targetTop + rowH() > viewBottom) {
    listWrap.scrollTo({ top: targetTop - listWrap.clientHeight / 2, behavior: "smooth" });
  }
}

/* ── Playback ── */
function playIndex(i) {
  if (!filteredList.length) return;
  if (i < 0 || i >= filteredList.length) return;
  clearTimeout(skipTimer);
  currentIndex = i;
  const item = filteredList[i];

  savedTime = 0;
  loader.classList.add("visible");
  nowTitle.textContent = item.title;
  indexBadge.textContent = `${i + 1} / ${filteredList.length}`;
  highlightActive();
  iconPath.setAttribute("d", pausePath);
  savePrefs();

  if (hls) { hls.destroy(); hls = null; }

  if (item.url.includes(".m3u8") && typeof Hls !== "undefined" && Hls.isSupported()) {
    /* HLS keeps going through the proxy — segments need the CORS headers */
    pendingSrc = null;
    hls = new Hls({ maxBufferLength: 20 });
    hls.loadSource(WORKER + "?url=" + encodeURIComponent(item.url));
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (data.fatal) handleVideoFailure(`HLS ${data.type}`);
    });
  } else {
    setVideoSource(item.url, needsProxy(item.url));
  }
}

function setVideoSource(url, viaWorker) {
  pendingSrc = { url, viaWorker };
  video.src = viaWorker ? WORKER + "?url=" + encodeURIComponent(url) : url;
  video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
}

/* One retry through the proxy before we call an entry dead */
function retryViaWorker() {
  if (!pendingSrc || pendingSrc.viaWorker) return false;
  rememberHost(pendingSrc.url, "proxy");
  loader.classList.add("visible");
  setVideoSource(pendingSrc.url, true);
  return true;
}

/* ── Prefetch the next clip so the gap between videos is shorter ── */
function prefetchNext() {
  if (filteredList.length < 2) return;
  const next = filteredList[currentIndex + 1 < filteredList.length ? currentIndex + 1 : 0];
  if (!next || next.url.includes(".m3u8") || failedUrls.has(next.url)) return;
  if (prefetchEl && prefetchEl.dataset.url === next.url) return;

  if (!prefetchEl) {
    prefetchEl = document.createElement("video");
    prefetchEl.muted = true;
    prefetchEl.preload = "auto";
    prefetchEl.style.display = "none";
    document.body.appendChild(prefetchEl);
  }
  prefetchEl.dataset.url = next.url;
  prefetchEl.src = needsProxy(next.url) ? WORKER + "?url=" + encodeURIComponent(next.url) : next.url;
  prefetchEl.load();
}

/* ── Auto-skip failed videos ── */
function handleVideoFailure(reason) {
  consecutiveFailures++;
  loader.classList.remove("visible");

  const failedItem = filteredList[currentIndex];
  if (failedItem) failedUrls.add(failedItem.url);
  updateStats();
  renderVirtualList(true);

  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    toast(`⚠ ${MAX_CONSECUTIVE_FAILURES} videos in a row failed — stopping auto-skip`);
    consecutiveFailures = 0;
    return;
  }

  toast(`⏭ Skipping "${failedItem?.title || "video"}" (failed to load)`);

  skipTimer = setTimeout(() => {
    const next = currentIndex + 1 < filteredList.length ? currentIndex + 1 : 0;
    playIndex(next);
  }, 900);
}

video.addEventListener("error", () => {
  if (!video.currentSrc) return;
  if (retryViaWorker()) return;
  handleVideoFailure("video error");
});

let stallTimer = null;
video.addEventListener("loadstart", () => {
  clearTimeout(stallTimer);
  stallTimer = setTimeout(() => {
    if (video.readyState >= 2 || video.paused) return;
    if (retryViaWorker()) return;
    handleVideoFailure("stalled");
  }, 20000);
});

video.addEventListener("playing", () => {
  consecutiveFailures = 0;
  clearTimeout(stallTimer);
  loader.classList.remove("visible");
  if (pendingSrc && !pendingSrc.viaWorker) rememberHost(pendingSrc.url, "direct");
  prefetchNext();
});

/* Pick up mid-clip after a reload */
video.addEventListener("loadedmetadata", () => {
  if (!resumeTime) return;
  const t = resumeTime;
  resumeTime = 0;
  if (isFinite(video.duration) && t < video.duration - 1) video.currentTime = t;
});

video.addEventListener("canplay", () => loader.classList.remove("visible"));
video.addEventListener("waiting", () => loader.classList.add("visible"));

video.addEventListener("click", () => {
  if (video.requestFullscreen) video.requestFullscreen();
  else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
});

/* Throttled progress updates */
let lastProgressUpdate = 0;
let lastTimeSave = 0;
video.addEventListener("timeupdate", () => {
  const now = performance.now();
  if (now - lastProgressUpdate < 500) return;
  lastProgressUpdate = now;
  if (!video.duration) return;
  progressFill.style.width = (video.currentTime / video.duration) * 100 + "%";
  timeCur.textContent = fmtTime(video.currentTime);
  timeDur.textContent = fmtTime(video.duration);

  /* Remember the position, but don't hammer localStorage */
  savedTime = video.currentTime;
  if (now - lastTimeSave > 5000) { lastTimeSave = now; savePrefs(); }
});

video.addEventListener("ended", () => {
  if (!auto) return;
  const next = currentIndex + 1 < filteredList.length ? currentIndex + 1 : 0;
  playIndex(next);
});

progressBg.addEventListener("click", (e) => {
  if (!video.duration) return;
  const rect = progressBg.getBoundingClientRect();
  video.currentTime = ((e.clientX - rect.left) / rect.width) * video.duration;
});

/* ── Volume ── */
if (volumeSlider) {
  volumeSlider.addEventListener("input", () => {
    video.volume = parseFloat(volumeSlider.value);
    video.muted = video.volume === 0;
    savePrefs();
  });
  video.addEventListener("volumechange", () => {
    volumeSlider.value = video.muted ? 0 : video.volume;
  });
}

/* ── Controls ── */
shuffleBtn.addEventListener("click", () => {
  shuffle = !shuffle;
  shuffleBtn.classList.toggle("active", shuffle);
  if (shuffle) shuffleArray(currentList);
  else if (selectEl.value !== "__external__") {
    currentList = (playlistCache[selectEl.value] || currentList).slice();
  }
  applyFilter();
  playIndex(0);
  savePrefs();
});

autoBtn.addEventListener("click", () => {
  auto = !auto;
  autoBtn.classList.toggle("active", auto);
  savePrefs();
});

densityBtn.addEventListener("click", () => {
  density = density === "comfortable" ? "compact" : "comfortable";
  densityBtn.classList.toggle("active", density === "compact");
  document.body.dataset.density = density;
  renderVirtualList(true);
  savePrefs();
});

/* Remove entries that failed this session */
cleanBtn.addEventListener("click", () => {
  if (!failedUrls.size) { toast("Nothing to clean — no failed videos yet"); return; }
  const before = currentList.length;
  const playingUrl = filteredList[currentIndex]?.url;
  currentList = currentList.filter(i => !failedUrls.has(i.url));
  const removed = before - currentList.length;
  applyFilter();
  // Keep playing item selected if it survived
  const newIdx = filteredList.findIndex(i => i.url === playingUrl);
  currentIndex = newIdx >= 0 ? newIdx : 0;
  renderVirtualList(true);
  updateStats();
  toast(`🧹 Removed ${removed} dead ${removed === 1 ? "entry" : "entries"}`);
});

/* Re-lock the player */
let wasPlayingBeforeLock = false;
lockBtn.addEventListener("click", () => {
  wasPlayingBeforeLock = !video.paused;
  video.pause();
  iconPath.setAttribute("d", playPath);
  window.PlstLock.lock();
});

document.addEventListener("plst:unlock", () => {
  if (!wasPlayingBeforeLock) return;
  wasPlayingBeforeLock = false;
  video.play().then(() => iconPath.setAttribute("d", pausePath)).catch(() => {});
});

/* Download the working list — handy after 🧹 Clean has pruned the dead ones */
exportBtn.addEventListener("click", () => {
  if (!currentList.length) { toast("Nothing to export"); return; }
  const body = currentList
    .map(i => `#EXTINF:${i.dur || -1}, ${i.title || "Untitled"}\n${i.url}`)
    .join("\n");
  const label = (selectEl.selectedOptions[0]?.textContent || "playlist")
    .replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "playlist";

  const url = URL.createObjectURL(new Blob(["#EXTM3U\n" + body + "\n"], { type: "audio/x-mpegurl" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${label}.m3u`;
  a.click();
  /* Safari can still be reading the blob when the click returns — give it a beat */
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast(`⤓ Exported ${currentList.length} entries`);
});

prevBtn.addEventListener("click", () => playIndex(currentIndex - 1 < 0 ? filteredList.length - 1 : currentIndex - 1));
nextBtn.addEventListener("click", () => playIndex(currentIndex + 1 < filteredList.length ? currentIndex + 1 : 0));
playBtn.addEventListener("click", () => {
  if (video.paused) { video.play(); iconPath.setAttribute("d", pausePath); }
  else { video.pause(); iconPath.setAttribute("d", playPath); }
});

/* ── Open local .m3u file ── */
openLocalBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  const text = await file.text();
  loadFromText(text, file.name);
  fileInput.value = "";
});

/* ── Open playlist from URL ── */
openUrlBtn.addEventListener("click", async () => {
  const url = prompt("Paste a direct URL to an .m3u / .m3u8 playlist file:\n(Dropbox/Drive links must be direct-download links)");
  if (!url) return;
  toast("Fetching playlist…");
  try {
    let res;
    try {
      res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
    } catch {
      res = await fetch(WORKER + "?url=" + encodeURIComponent(url));
      if (!res.ok) throw new Error(res.status);
    }
    const text = await res.text();
    const label = url.split("/").pop().split("?")[0] || "URL playlist";
    loadFromText(text, label);
  } catch (e) {
    toast("⚠ Couldn't fetch that URL (CORS or 404)");
  }
});

/* ── Keyboard shortcuts ── */
document.addEventListener("keydown", (e) => {
  if (!document.getElementById("lock").classList.contains("hidden")) return;
  if (e.key.toLowerCase() === "l") { lockBtn.click(); return; }
  if (e.key === "ArrowRight" || e.key === "n") nextBtn.click();
  if (e.key === "ArrowLeft"  || e.key === "p") prevBtn.click();
  if (e.key === " ") { e.preventDefault(); playBtn.click(); }
  if (e.key.toLowerCase() === "m") video.muted = !video.muted;
  if (e.key.toLowerCase() === "f") video.requestFullscreen?.();
  if (e.key === "ArrowUp")   { e.preventDefault(); video.volume = Math.min(1, video.volume + 0.05); }
  if (e.key === "ArrowDown") { e.preventDefault(); video.volume = Math.max(0, video.volume - 0.05); }
});

/* ── Playlist select ── */
selectEl.addEventListener("change", async () => {
  if (selectEl.value === "__external__") return;
  const ok = await loadPlaylist(selectEl.value);
  if (ok) { playIndex(0); savePrefs(); }
});

/* ══════════════════════════════════════════════
   MOBILE DRAWER (with swipe-down to close)
   ══════════════════════════════════════════════ */
function openDrawer() {
  sidebar.classList.add("open");
  drawerBackdrop.classList.add("visible");
  drawerToggle.textContent = "✕ Close";
}

function closeDrawer() {
  sidebar.classList.remove("open");
  drawerBackdrop.classList.remove("visible");
  drawerToggle.textContent = "☰ Playlist";
  sidebar.style.transform = "";
}

drawerToggle.addEventListener("click", () =>
  sidebar.classList.contains("open") ? closeDrawer() : openDrawer());
drawerBackdrop.addEventListener("click", closeDrawer);

/* Swipe-down gesture */
let touchStartY = null;
let touchDelta = 0;
let touchOnHeader = false;

sidebar.addEventListener("touchstart", (e) => {
  if (!isMobileLayout() || !sidebar.classList.contains("open")) return;
  // Only start drag from the header area, or when the list is scrolled to top
  const fromHeader = e.target.closest("#sidebar-header") || e.target === sidebar;
  touchOnHeader = !!fromHeader || listWrap.scrollTop === 0;
  touchStartY = e.touches[0].clientY;
  touchDelta = 0;
}, { passive: true });

sidebar.addEventListener("touchmove", (e) => {
  if (touchStartY === null || !touchOnHeader) return;
  touchDelta = e.touches[0].clientY - touchStartY;
  if (touchDelta > 0) {
    sidebar.style.transition = "none";
    sidebar.style.transform = `translateY(${touchDelta}px)`;
  }
}, { passive: true });

sidebar.addEventListener("touchend", () => {
  if (touchStartY === null) return;
  sidebar.style.transition = "";
  if (touchDelta > 80) closeDrawer();
  else sidebar.style.transform = "";
  touchStartY = null;
  touchDelta = 0;
});

/* ── Init ── */
(async function init() {
  await unlocked;
  try { hostMode = JSON.parse(localStorage.getItem(HOSTS_KEY)) || {}; } catch { hostMode = {}; }
  const prefs = loadPrefs();

  if (prefs.density === "compact") {
    density = "compact";
    densityBtn.classList.add("active");
    document.body.dataset.density = "compact";
  }
  if (prefs.shuffle) { shuffle = true; shuffleBtn.classList.add("active"); }
  if (prefs.auto === false) { auto = false; autoBtn.classList.remove("active"); }
  if (typeof prefs.volume === "number") {
    video.volume = prefs.volume;
    if (volumeSlider) volumeSlider.value = prefs.volume;
  }
  if (prefs.muted) video.muted = true;

  await loadManifest();
  if (!manifest.length) return;

  const startName = prefs.playlist && manifest.some(m => m.name === prefs.playlist)
    ? prefs.playlist
    : manifest[0].name;

  selectEl.value = startName;
  const ok = await loadPlaylist(startName);
  if (!ok) return;

  const startIdx = (Number.isInteger(prefs.index) && prefs.index >= 0 && prefs.index < filteredList.length)
    ? prefs.index : 0;
  if (typeof prefs.time === "number" && prefs.time > 1) resumeTime = prefs.time;
  playIndex(startIdx);
})();
