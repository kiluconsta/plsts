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
   ══════════════════════════════════════════════════════════ */

/* ── Age Gate ── */
(function () {
  const VERIFIED_KEY = "age_verified_v1";

  function redirectAway() {
    window.location.replace("https://www.youtube.com");
  }

  function dismissSplash() {
    sessionStorage.setItem(VERIFIED_KEY, "1");
    const splash = document.getElementById("splash");
    splash.style.transition = "opacity 0.4s";
    splash.style.opacity = "0";
    setTimeout(() => splash.remove(), 420);
  }

  window.addEventListener("DOMContentLoaded", function () {
    if (sessionStorage.getItem(VERIFIED_KEY)) {
      document.getElementById("splash").remove();
    } else {
      document.getElementById("btn-enter").addEventListener("click", dismissSplash);
      document.getElementById("btn-leave").addEventListener("click", redirectAway);
    }
  });
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
let searchQuery = "";
let hls = null;
let density = "comfortable";          // or "compact"
const failedUrls = new Set();          // dead entries this session

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
const searchInput  = document.getElementById("searchInput");
const shuffleBtn   = document.getElementById("shuffleBtn");
const autoBtn      = document.getElementById("autoBtn");
const densityBtn   = document.getElementById("densityBtn");
const cleanBtn     = document.getElementById("cleanBtn");
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

/* ── Persistence ── */
function savePrefs() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      playlist: selectEl.value !== "__external__" ? selectEl.value : null,
      index: currentIndex,
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
  searchQuery = "";
  searchInput.value = "";
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
  searchQuery = "";
  searchInput.value = "";
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

/* ── Filtering ── */
function applyFilter() {
  const q = searchQuery.toLowerCase();
  filteredList = q ? currentList.filter(i => i.title.toLowerCase().includes(q)) : currentList;
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
  const total = filteredList.length;
  const shown = searchQuery ? `${total} of ${currentList.length}` : total;
  const dead = filteredList.filter(i => failedUrls.has(i.url)).length;
  statsEl.textContent = `${shown} videos` + (dead ? ` · ${dead} dead` : "");
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
  const url = WORKER + "?url=" + encodeURIComponent(item.url);

  loader.classList.add("visible");
  nowTitle.textContent = item.title;
  indexBadge.textContent = `${i + 1} / ${filteredList.length}`;
  highlightActive();
  iconPath.setAttribute("d", pausePath);
  savePrefs();

  if (hls) { hls.destroy(); hls = null; }

  if (item.url.includes(".m3u8") && typeof Hls !== "undefined" && Hls.isSupported()) {
    hls = new Hls({ maxBufferLength: 20 });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (data.fatal) handleVideoFailure(`HLS ${data.type}`);
    });
  } else {
    video.src = url;
    video.play().catch(() => { video.muted = true; video.play().catch(() => {}); });
  }
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
  if (video.currentSrc) handleVideoFailure("video error");
});

let stallTimer = null;
video.addEventListener("loadstart", () => {
  clearTimeout(stallTimer);
  stallTimer = setTimeout(() => {
    if (video.readyState < 2 && !video.paused) handleVideoFailure("stalled");
  }, 20000);
});

video.addEventListener("playing", () => {
  consecutiveFailures = 0;
  clearTimeout(stallTimer);
  loader.classList.remove("visible");
});

video.addEventListener("canplay", () => loader.classList.remove("visible"));
video.addEventListener("waiting", () => loader.classList.add("visible"));

video.addEventListener("click", () => {
  if (video.requestFullscreen) video.requestFullscreen();
  else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
});

/* Throttled progress updates */
let lastProgressUpdate = 0;
video.addEventListener("timeupdate", () => {
  const now = performance.now();
  if (now - lastProgressUpdate < 500) return;
  lastProgressUpdate = now;
  if (!video.duration) return;
  progressFill.style.width = (video.currentTime / video.duration) * 100 + "%";
  timeCur.textContent = fmtTime(video.currentTime);
  timeDur.textContent = fmtTime(video.duration);
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

/* ── Search (debounced) ── */
let searchTimer;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchQuery = searchInput.value.trim();
    currentIndex = 0;
    applyFilter();
    if (filteredList.length) playIndex(0);
  }, 250);
});

/* ── Keyboard shortcuts ── */
document.addEventListener("keydown", (e) => {
  if (e.target === searchInput) return;
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
  playIndex(startIdx);
})();
