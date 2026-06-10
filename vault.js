// ── Proxy config ──────────────────────────────────────────────
var PROXY = 'https://young-truth-052a.kiluconsta.workers.dev';

var PROXY_HOSTS = [
  'twimg.com', 'video.twimg.com', 'coomer.st', 'redgifs.com',
  'tumblr.com', 'lpsg.com', 'rule34.xxx', 'cartoonsworld.vip',
  'monstercockland.com', 'gayforfuns.com',
  'dropbox.com', 'dropboxusercontent.com'
];

function proxyUrl(url) {
  if (!url || !PROXY) return url;
  try {
    var host = new URL(url).hostname;
    var needsProxy = PROXY_HOSTS.some(function(h) {
      return host === h || host.endsWith('.' + h);
    });
    return needsProxy ? PROXY + '?url=' + encodeURIComponent(url) : url;
  } catch(e) { return url; }
}

// ── Slug helpers ──────────────────────────────────────────────
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/&amp;/g, 'and')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

var secIdToSlug = {};
var slugToTile  = {};

document.querySelectorAll('.home-tile').forEach(function(tile) {
  var secId   = tile.dataset.sec;
  var labelEl = tile.querySelector('.tile-label');
  if (secId && labelEl) {
    var slug = slugify(labelEl.textContent);
    secIdToSlug[secId] = slug;
    slugToTile[slug]   = tile;
  }
});

// ── Tile count badges ─────────────────────────────────────────
// Item counts per collection (update when adding/removing media)
var TILE_COUNTS = {
  "animations": 1906,
  "bluesky-likes": 249,
  "bomb-ass-dee-pt-2": 1113,
  "bomb-ass-dee": 636,
  "coomer": 48,
  "dropbox": 461,
  "gifs": 54,
  "images": 234,
  "meatsenpaii": 2,
  "sandf": 140,
  "show-off": 221,
  "tumblr": 819,
  "x-likes-long": 531,
  "x-likes-short": 299
};

Object.keys(slugToTile).forEach(function(slug) {
  var count = TILE_COUNTS[slug];
  if (!count) return;
  var badge = document.createElement('span');
  badge.className = 'tile-count';
  badge.textContent = count >= 1000 ? (count / 1000).toFixed(1).replace('.0','') + 'k' : count;
  slugToTile[slug].appendChild(badge);
});

// ── Recently viewed row ───────────────────────────────────────
(function() {
  var recent;
  try { recent = JSON.parse(localStorage.getItem('vault-recent') || '[]'); }
  catch(e) { recent = []; }
  if (!recent.length) return;

  var grid = document.querySelector('.home-grid');
  if (!grid) return;

  var row = document.createElement('div');
  row.className = 'recent-row';
  row.innerHTML = '<div class="recent-label">Recently viewed</div>';

  var strip = document.createElement('div');
  strip.className = 'recent-strip';

  recent.forEach(function(item) {
    var src = slugToTile[item.slug];
    if (!src) return;
    var mini = document.createElement('div');
    mini.className = 'recent-tile';
    mini.dataset.sec = src.dataset.sec;          // delegation handles click
    mini.style.setProperty('--accent', getComputedStyle(src).getPropertyValue('--accent'));
    var icon  = src.querySelector('.tile-icon');
    var label = src.querySelector('.tile-label');
    mini.innerHTML =
      '<span class="recent-icon">'  + (icon  ? icon.textContent  : '') + '</span>' +
      '<span class="recent-name">'  + (label ? label.textContent : '') + '</span>';
    strip.appendChild(mini);
  });

  if (strip.children.length) {
    row.appendChild(strip);
    grid.parentNode.insertBefore(row, grid);
  }
})();

// ── Navigation (event delegation — covers tiles + recent strip) ──
document.addEventListener('click', function(e) {
  var el = e.target.closest('[data-sec]');
  if (!el) return;
  var slug = secIdToSlug[el.dataset.sec];
  if (slug) window.location.href = 'pages/' + slug + '.html';
});

// ── Back button (called from inside page files) ───────────────
function showHome() {
  window.location.href = '/';
}
