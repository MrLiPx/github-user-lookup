/**
 * github-user-search — app.js
 * Build: ncDTRRVzwl
 * Copyright (c) MrLiPx. All rights reserved.
 */

'use strict';

// ─── Config ───────────────────────────────────────────────────────────────────

const API           = 'https://api.github.com';
const HDRS          = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const TIMEOUT_MS    = 9_000;
const CACHE_MS      = 5 * 60 * 1000;
const PER_PAGE      = 10;
const PREVIEW_DELAY = 280;

const LANG_COLORS = {
  JavaScript:'#f1e05a', TypeScript:'#3178c6', Python:'#3572a5',
  HTML:'#e34c26', CSS:'#563d7c', Rust:'#dea584', Go:'#00add8',
  Java:'#b07219', 'C#':'#178600', 'C++':'#f34b7d', C:'#555555',
  Ruby:'#701516', PHP:'#4f5d95', Shell:'#89e051', Kotlin:'#a97bff',
  Swift:'#f05138', Dart:'#00b4ab', Vue:'#41b883', Svelte:'#ff3e00',
  Dockerfile:'#384d54', Lua:'#000080', Perl:'#0298c3', R:'#198ce7',
};

// ─── DOM ──────────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const ui = {
  input:      () => $('usernameInput'),
  btn:        () => $('searchBtn'),
  field:      () => $('searchField'),
  landing:    () => $('landingUI'),
  loading:    () => $('loadingUI'),
  preview:    () => $('typingPreview'),
  content:    () => $('profileContent'),
  errors:     () => $('errorContainer'),
  reposPanel: () => $('reposView'),
  starsPanel: () => $('starsView'),
  starsGrid:  () => $('starsGrid'),
  starsLoad:  () => $('starsLoading'),
};

// ─── State ────────────────────────────────────────────────────────────────────

let activeUser    = '';
let currentMode   = 'landing';
let previewTimer  = null;
let allRepos      = [];    // all repos fetched, sorted
let allStars      = [];    // stars fetched so far
let starsDone     = false; // true when all stars have been fetched
let starsFetching = false;
let starsGhPage   = 0;     // last GitHub API page fetched for stars

// ─── Utils ────────────────────────────────────────────────────────────────────

const esc = s => String(s ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

function fmt(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)     return (n / 1_000    ).toFixed(1).replace(/\.0$/, '') + 'k';
  return n.toLocaleString();
}

const fmtDate = iso =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });

function parseLinkHeader(header) {
  if (!header) return {};
  const links = {};
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (m) links[m[2]] = m[1];
  }
  return links;
}

function pageFromUrl(url) {
  const m = (url || '').match(/[?&]page=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// ─── URL helpers ──────────────────────────────────────────────────────────────
/*
 * URL scheme:  ?u=<username>#<tab>/<page>
 *
 *   ?u=torvalds            →  repos tab, page 1
 *   ?u=torvalds#stars      →  stars tab, page 1
 *   ?u=torvalds#repos/3    →  repos tab, page 3
 *   ?u=torvalds#stars/2    →  stars tab, page 2
 *
 * The hash carries both the active tab and the page number so the
 * query string stays short and readable.  Page 1 is omitted.
 */

function parseHash() {
  const raw  = location.hash.slice(1) || 'repos';        // e.g. "stars/2"
  const [tab, pg] = raw.split('/');
  return {
    tab:  (tab === 'stars') ? 'stars' : 'repos',
    page: Math.max(1, parseInt(pg || '1', 10)),
  };
}

function buildHash(tab, page) {
  return page > 1 ? `#${tab}/${page}` : `#${tab}`;
}

function getUsername() {
  const p = new URLSearchParams(location.search);
  return p.get('u') || p.get('usn') || p.get('username') || '';
}

function pushState(username, tab, page) {
  const q = username ? `?u=${encodeURIComponent(username)}` : '';
  history.pushState({}, '', `${location.pathname}${q}${buildHash(tab, page)}`);
}

function replaceState(username, tab, page) {
  const q = username ? `?u=${encodeURIComponent(username)}` : '';
  history.replaceState({}, '', `${location.pathname}${q}${buildHash(tab, page)}`);
}

// ─── API fetch — with session cache + Link header support ─────────────────────
/*
 * Returns { data: any, linkHeader: string|null }.
 * Cache stores only `data`; linkHeader is re-derived from the
 * cached URL on cache hit (Link headers aren't needed after first fetch
 * because we eagerly fetch all repo pages and accumulate stars).
 *
 * Bug in previous version: cache hit returned raw `data`, not the
 * `{ data, linkHeader }` wrapper — callers broke on cache hit.
 */

async function apiFetch(url) {
  const key = `gus2_${url}`;

  // ── Cache hit ──
  try {
    const hit = sessionStorage.getItem(key);
    if (hit) {
      const { ts, data } = JSON.parse(hit);
      if (Date.now() - ts < CACHE_MS) return { data, linkHeader: null };
    }
  } catch { /* storage blocked */ }

  // ── Network fetch ──
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { headers: HDRS, signal: ctrl.signal });
    clearTimeout(timer);

    // Rate limit
    if (res.status === 403) {
      const rem = res.headers.get('X-RateLimit-Remaining');
      if (rem === '0') {
        const reset = res.headers.get('X-RateLimit-Reset');
        const secs  = reset ? Math.ceil((+reset * 1000 - Date.now()) / 1000) : 0;
        const mins  = Math.ceil(secs / 60);
        throw Object.assign(new Error('rate_limit'), { secs, mins });
      }
    }

    if (!res.ok) throw Object.assign(new Error('http'), { status: res.status });

    const data       = await res.json();
    const linkHeader = res.headers.get('Link');

    try { sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch { }

    return { data, linkHeader };

  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw Object.assign(new Error('timeout'), {});
    throw err;
  }
}

// ─── UI state machine ─────────────────────────────────────────────────────────

function setState(mode) {
  currentMode = mode;
  const map = {
    landing: ui.landing(),
    loading: ui.loading(),
    preview: ui.preview(),
    content: ui.content(),
    errors:  ui.errors(),
  };
  for (const [k, el] of Object.entries(map)) {
    el?.classList.toggle('hidden', k !== mode);
  }
}

// ─── Error display ────────────────────────────────────────────────────────────

const ERROR_CONFIGS = {
  404: {
    icon:  'fi-rr-user-slash',
    title: 'User not found',
    msg:   q => `No GitHub account matches <strong>${esc(q)}</strong>. Double-check the username and try again.`,
    retry: false,
  },
  403: {
    icon:  'fi-rr-lock',
    title: 'Access denied',
    msg:   () => 'GitHub returned 403. If you\'re logged in elsewhere, your token may be invalid.',
    retry: true,
  },
  rate_limit: {
    icon:  'fi-rr-hourglass-end',
    title: 'Rate limit reached',
    msg:   err => err.mins
      ? `GitHub API limit hit. Resets in <strong>~${err.mins} min</strong>.`
      : 'GitHub API rate limit exceeded. Please wait a few minutes.',
    retry: false,
  },
  timeout: {
    icon:  'fi-rr-wifi-slash',
    title: 'Connection timed out',
    msg:   () => 'GitHub didn\'t respond in time. Check your connection and try again.',
    retry: true,
  },
  offline: {
    icon:  'fi-rr-wifi-slash',
    title: 'No internet connection',
    msg:   () => 'You appear to be offline. Connect to the internet and try again.',
    retry: true,
  },
  default: {
    icon:  'fi-rr-triangle-warning',
    title: 'Something went wrong',
    msg:   err => `An unexpected error occurred${err.status ? ` (HTTP ${err.status})` : ''}.`,
    retry: true,
  },
};

function showError(err, retryFn) {
  clearTypingState();
  setState('errors');

  const query = ui.input()?.value.trim() ?? '';

  let cfg;
  if (!navigator.onLine)          cfg = ERROR_CONFIGS.offline;
  else if (err.status === 404)    cfg = ERROR_CONFIGS[404];
  else if (err.status === 403)    cfg = ERROR_CONFIGS[403];
  else if (err.message === 'rate_limit') cfg = ERROR_CONFIGS.rate_limit;
  else if (err.message === 'timeout')    cfg = ERROR_CONFIGS.timeout;
  else                                   cfg = ERROR_CONFIGS.default;

  const msgHtml = cfg.msg(err.message === 'rate_limit' ? err : { status: err.status, query });
  const retryBtn = (cfg.retry && retryFn)
    ? `<button class="error-retry" onclick="(${retryFn.toString()})()">
         <i class="fi fi-rr-refresh" aria-hidden="true"></i>Try again
       </button>`
    : '';

  // Show rate-limit countdown if we know the reset time
  const countdown = (err.message === 'rate_limit' && err.secs > 0)
    ? `<div class="error-countdown" id="errCountdown">
         <i class="fi fi-rr-clock" aria-hidden="true"></i>
         <span id="errSecs">${err.secs}</span>s until reset
       </div>`
    : '';

  ui.errors().innerHTML =
    `<div class="error-card">
       <div class="error-icon-wrap">
         <i class="fi ${esc(cfg.icon)}" aria-hidden="true"></i>
       </div>
       <div class="error-body">
         <p class="error-title">${esc(cfg.title)}</p>
         <p class="error-msg">${msgHtml}</p>
         ${countdown}
         ${retryBtn}
       </div>
     </div>`;

  // Live rate-limit countdown
  if (err.message === 'rate_limit' && err.secs > 0) {
    let remaining = err.secs;
    const el = $('errSecs');
    const tick = setInterval(() => {
      remaining--;
      if (el) el.textContent = Math.max(0, remaining);
      if (remaining <= 0) clearInterval(tick);
    }, 1000);
  }
}

// ─── Typing preview ───────────────────────────────────────────────────────────

function showTypingPreview() {
  ui.field()?.classList.add('typing-active');
  ui.input().classList.add('is-typing');
  setState('preview');
}

function clearTypingState() {
  ui.field()?.classList.remove('typing-active');
  ui.input().classList.remove('is-typing');
  clearTimeout(previewTimer);
  previewTimer = null;
}

// ─── Search ───────────────────────────────────────────────────────────────────

function doSearch() {
  const q = ui.input().value.trim();
  if (!q) { ui.input().focus(); return; }
  clearTypingState();
  pushState(q, 'repos', 1);
  loadUser(q, 'repos', 1);
}

function resetToLanding() {
  clearTypingState();
  history.pushState({}, '', location.pathname);
  ui.input().value = '';
  activeUser    = '';
  allRepos      = [];
  allStars      = [];
  starsDone     = false;
  starsFetching = false;
  starsGhPage   = 0;
  document.title = 'GitHub User Search — Developer Profile Explorer';
  setState('landing');
}

// ─── Load user ────────────────────────────────────────────────────────────────

async function loadUser(username, tab, page) {
  if (!username) return;
  clearTypingState();
  setState('loading');

  // Reset per-user state
  allRepos      = [];
  allStars      = [];
  starsDone     = false;
  starsFetching = false;
  starsGhPage   = 0;

  try {
    // User profile + first 100 repos in parallel
    const [userResult, reposResult] = await Promise.all([
      apiFetch(`${API}/users/${username}`),
      apiFetch(`${API}/users/${username}/repos?sort=stars&direction=desc&per_page=100&page=1`),
    ]);

    const user  = userResult.data;
    let repos   = Array.isArray(reposResult.data) ? reposResult.data : [];

    // Fetch additional repo pages if needed (>100 repos)
    const links    = parseLinkHeader(reposResult.linkHeader);
    const lastGhPg = pageFromUrl(links.last);

    if (lastGhPg && lastGhPg > 1) {
      const extras = await Promise.allSettled(
        Array.from({ length: lastGhPg - 1 }, (_, i) =>
          apiFetch(`${API}/users/${username}/repos?sort=stars&direction=desc&per_page=100&page=${i + 2}`)
            .then(r => r.data)
        )
      );
      for (const r of extras) {
        if (r.status === 'fulfilled' && Array.isArray(r.value)) repos = repos.concat(r.value);
      }
    }

    // Sort: own repos (stars desc) then forks (stars desc)
    const own   = repos.filter(r => !r.fork).sort((a, b) => b.stargazers_count - a.stargazers_count);
    const forks = repos.filter(r =>  r.fork).sort((a, b) => b.stargazers_count - a.stargazers_count);
    allRepos = [...own, ...forks];

    activeUser = user.login;

    renderHero(user);
    setState('content');
    activateTab(tab || 'repos', page || 1);

    document.title = `${user.name || user.login} (@${user.login}) — GitHub User Search`;

  } catch (err) {
    showError(err, () => loadUser(username, tab, page));
  }
}

// ─── Hero ─────────────────────────────────────────────────────────────────────

function renderHero(user) {
  const img = $('avatar');
  img.src = user.avatar_url;
  img.alt = `${user.login} GitHub avatar`;

  $('fullName').textContent = user.name || user.login;
  $('loginId') .textContent = user.login;
  $('loginLink').href = user.html_url;
  $('loginLink').setAttribute('aria-label', `@${user.login} on GitHub`);
  $('hireableStatus').classList.toggle('hidden', !user.hireable);
  $('bioText').textContent = user.bio || '';

  $('statFollowers').textContent = fmt(user.followers);
  $('statFollowing').textContent = fmt(user.following);
  $('statRepos')    .textContent = fmt(user.public_repos);
  $('statGists')    .textContent = fmt(user.public_gists);

  $('valJoined').textContent = `Joined ${fmtDate(user.created_at)}`;
  setMeta('valLocation', user.location, 'locBox');
  setMeta('valCompany',  user.company,  'compBox');
  setLink('valBlog',     user.blog,     'linkBox');
  renderBadges(user);
}

function setMeta(elId, val, boxId) {
  const box = $(boxId);
  if (val) { $(elId).textContent = val; box.classList.remove('hidden'); }
  else     { box.classList.add('hidden'); }
}

function setLink(elId, val, boxId) {
  const box = $(boxId), el = $(elId);
  if (val) {
    el.href        = val.startsWith('http') ? val : `https://${val}`;
    el.textContent = val.replace(/^https?:\/\//, '').replace(/\/$/, '');
    box.classList.remove('hidden');
  } else {
    box.classList.add('hidden');
  }
}

function renderBadges(user) {
  const row  = $('achievementsList');
  const list = [];
  if (user.site_admin)          list.push(['fi-rr-shield-check', 'Staff',       'badge-blue']);
  if (user.followers >= 1000)   list.push(['fi-rr-star',         'Influencer',  'badge-amber']);
  else if(user.followers >= 100)list.push(['fi-rr-flame',        'Rising Star', 'badge-amber']);
  if (user.public_repos >= 50)  list.push(['fi-rr-layers',       'Prolific',    'badge-green']);
  if (user.hireable)            list.push(['fi-rr-bolt',         'For Hire',    'badge-green']);
  if (user.public_gists >= 20)  list.push(['fi-rr-code-branch',  'Gist Master', 'badge-purple']);

  row.innerHTML = list.map(([icon, label, cls]) =>
    `<span class="badge ${esc(cls)}" role="listitem">
       <i class="fi ${esc(icon)}" aria-hidden="true"></i>${esc(label)}
     </span>`
  ).join('');
}

// ─── Card template ────────────────────────────────────────────────────────────

function makeCard(item) {
  const lang  = item.language ?? '';
  const color = LANG_COLORS[lang] ?? '#46546a';
  const desc  = item.description ?? '';

  return `
    <a class="repo-card" href="${esc(item.html_url)}" target="_blank" rel="noopener noreferrer"
       aria-label="${esc(item.name)} — view on GitHub">
      <div class="repo-head">
        <span class="repo-name">${esc(item.name)}</span>
        ${item.fork ? `<span class="repo-badge">fork</span>` : ''}
      </div>
      <p class="repo-desc">${esc(desc) || '<span style="opacity:.5">No description.</span>'}</p>
      <div class="repo-foot">
        <span class="repo-stat" aria-label="${item.stargazers_count} stars">
          <i class="fi fi-rr-star" aria-hidden="true" style="color:var(--amber)"></i>
          ${esc(fmt(item.stargazers_count))}
        </span>
        <span class="repo-stat" aria-label="${item.forks_count} forks">
          <i class="fi fi-rr-code-fork" aria-hidden="true" style="color:var(--accent)"></i>
          ${esc(fmt(item.forks_count))}
        </span>
        ${lang ? `<span class="repo-lang">
            <span class="lang-dot" style="background:${esc(color)}" aria-hidden="true"></span>
            ${esc(lang)}
          </span>` : ''}
        <i class="fi fi-rr-arrow-right repo-arrow" aria-hidden="true"></i>
      </div>
    </a>`;
}

// ─── Repos ────────────────────────────────────────────────────────────────────

function renderReposPage(page) {
  page = clamp(page, 1, Math.max(1, Math.ceil(allRepos.length / PER_PAGE)));

  const container = $('reposView');
  container.replaceChildren();

  if (!allRepos.length) {
    container.innerHTML = emptyState('fi-rr-folder', 'No repositories found.');
    return;
  }

  const total = allRepos.length;
  const pages = Math.ceil(total / PER_PAGE);
  const start = (page - 1) * PER_PAGE;
  const slice = allRepos.slice(start, start + PER_PAGE);

  const grid = document.createElement('div');
  grid.className = 'repo-grid';
  grid.innerHTML  = slice.map(makeCard).join('');
  container.appendChild(grid);

  if (pages > 1) container.appendChild(buildPager(page, pages, total, 'repos'));

  replaceState(activeUser, 'repos', page);
}

// ─── Stars ────────────────────────────────────────────────────────────────────

async function renderStarsPage(page) {
  if (starsFetching) return;
  page = Math.max(1, page);

  const needed = page * PER_PAGE; // items needed to show this page

  // Fetch more from GitHub if we don't have enough yet
  if (!starsDone && allStars.length < needed) {
    starsFetching = true;
    ui.starsLoad()?.classList.remove('hidden');
    ui.starsGrid()?.classList.add('hidden');

    try {
      while (!starsDone && allStars.length < needed) {
        starsGhPage++;
        const result = await apiFetch(
          `${API}/users/${activeUser}/starred?per_page=30&page=${starsGhPage}`
        );
        const batch = Array.isArray(result.data) ? result.data : [];
        allStars = allStars.concat(batch);

        // Determine if we've reached the last GitHub page
        if (batch.length < 30) {
          starsDone = true;
        } else if (result.linkHeader) {
          const links = parseLinkHeader(result.linkHeader);
          if (!links.next) starsDone = true;
        }
      }
    } catch (err) {
      starsFetching = false;
      ui.starsLoad()?.classList.add('hidden');
      ui.starsGrid()?.classList.remove('hidden');
      $('starsGrid').innerHTML = errorState('fi-rr-exclamation', 'Could not load starred repositories.',
        () => renderStarsPage(page));
      return;
    }

    starsFetching = false;
    ui.starsLoad()?.classList.add('hidden');
    ui.starsGrid()?.classList.remove('hidden');
  }

  const total = allStars.length;
  const pages = starsDone ? Math.ceil(total / PER_PAGE) : null; // null = unknown total
  page  = clamp(page, 1, pages ?? page);

  const start = (page - 1) * PER_PAGE;
  const slice = allStars.slice(start, start + PER_PAGE);

  const container = $('starsGrid');
  container.replaceChildren();

  if (!total) {
    container.innerHTML = emptyState('fi-rr-star', 'No starred repositories found.');
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'repo-grid';
  grid.innerHTML  = slice.map(makeCard).join('');
  container.appendChild(grid);

  if (pages && pages > 1) container.appendChild(buildPager(page, pages, total, 'stars'));
  else if (!starsDone && slice.length === PER_PAGE) {
    // More pages exist but we don't know the total yet — show minimal next-only pager
    container.appendChild(buildPager(page, page + 1, null, 'stars'));
  }

  replaceState(activeUser, 'stars', page);
}

// ─── Tab activation ───────────────────────────────────────────────────────────

function activateTab(tab, page) {
  tab  = (tab === 'stars') ? 'stars' : 'repos';
  page = Math.max(1, page || 1);

  ui.reposPanel().classList.toggle('hidden', tab !== 'repos');
  ui.starsPanel().classList.toggle('hidden', tab !== 'stars');

  document.querySelectorAll('.tab').forEach(t => {
    const on = t.id === `tab-${tab}`;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });

  if (tab === 'repos') renderReposPage(page);
  else                 renderStarsPage(page);
}

// ─── Pager ────────────────────────────────────────────────────────────────────

function buildPager(current, total, itemCount, tab) {
  const wrap = document.createElement('nav');
  wrap.className = 'pager';
  wrap.setAttribute('aria-label', `${tab} pagination`);

  const totalKnown = itemCount !== null;
  const perPage    = PER_PAGE;
  const start      = (current - 1) * perPage + 1;
  const end        = Math.min(current * perPage, itemCount ?? current * perPage);

  // Prev
  wrap.appendChild(pagerBtn(null, current === 1, () => goPage(tab, current - 1),
    '<i class="fi fi-rr-angle-left" aria-hidden="true"></i>', 'Previous page'));

  // Page numbers
  const range = pageRange(current, total);
  for (const p of range) {
    if (p === '…') {
      const dots = Object.assign(document.createElement('span'), { className: 'pager-ellipsis', textContent: '…' });
      wrap.appendChild(dots);
    } else {
      const btn = pagerBtn(p, false, () => goPage(tab, p),
        String(p), `Page ${p}`);
      if (p === current) { btn.classList.add('active'); btn.setAttribute('aria-current', 'page'); }
      wrap.appendChild(btn);
    }
  }

  // Next (disabled if total known and we're on last page)
  const nextDisabled = totalKnown && current >= total;
  wrap.appendChild(pagerBtn(null, nextDisabled, () => goPage(tab, current + 1),
    '<i class="fi fi-rr-angle-right" aria-hidden="true"></i>', 'Next page'));

  // Info line
  if (totalKnown) {
    const info = Object.assign(document.createElement('p'), {
      className: 'pager-info',
      textContent: `${start}–${end} of ${fmt(itemCount)} ${tab}`,
    });
    wrap.appendChild(info);
  }

  return wrap;
}

function pagerBtn(label, disabled, onClick, html, ariaLabel) {
  const btn = document.createElement('button');
  btn.className = 'pager-btn';
  btn.disabled  = disabled;
  btn.innerHTML = html ?? String(label ?? '');
  if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
  if (!disabled) btn.addEventListener('click', onClick);
  return btn;
}

function pageRange(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const show = new Set([1, total, current, current - 1, current + 1].filter(p => p >= 1 && p <= total));
  const sorted = [...show].sort((a, b) => a - b);
  const result = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) result.push('…');
    result.push(sorted[i]);
  }
  return result;
}

function goPage(tab, page) {
  const anchor = $(tab === 'repos' ? 'reposView' : 'starsView');
  anchor?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  activateTab(tab, page);
}

function clamp(n, min, max) { return Math.min(Math.max(n, min), max); }

// ─── Empty / error state helpers ──────────────────────────────────────────────

function emptyState(icon, msg) {
  return `<div class="panel-empty">
    <i class="fi ${esc(icon)}" aria-hidden="true"></i>
    <p>${esc(msg)}</p>
  </div>`;
}

function errorState(icon, msg, retryFn) {
  return `<div class="panel-error">
    <i class="fi ${esc(icon)}" aria-hidden="true"></i>
    <p>${esc(msg)}</p>
    <button class="panel-retry" onclick="(${retryFn.toString()})()">
      <i class="fi fi-rr-refresh" aria-hidden="true"></i>Retry
    </button>
  </div>`;
}

// ─── Landing typing animation ─────────────────────────────────────────────────

function animateLandingTitle() {
  const el = $('landingTitle');
  if (!el) return;
  const full = el.dataset.text || el.textContent.trim();
  el.dataset.text = full;
  let i = 0;
  el.textContent = '';
  const cursor = Object.assign(document.createElement('span'), { className: 'cursor' });
  el.appendChild(cursor);
  const type = () => {
    if (i < full.length) { cursor.before(full[i++]); setTimeout(type, 45 + Math.random() * 25); }
  };
  setTimeout(type, 600);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const username = getUsername();
  const { tab, page } = parseHash();

  if (username) {
    ui.input().value = username;
    loadUser(username, tab, page);
  } else {
    setState('landing');
    animateLandingTitle();
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      ui.input().focus();
      ui.input().select();
    }
    if (e.key === 'Escape' && document.activeElement === ui.input()) {
      clearTypingState();
      if (!activeUser) setState('landing');
      ui.input().blur();
    }
  });

  ui.input().addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  ui.btn()  .addEventListener('click',   doSearch);

  // Typing debounce
  ui.input().addEventListener('input', () => {
    const q = ui.input().value.trim();
    clearTimeout(previewTimer);
    if (!q) {
      clearTypingState();
      if (!activeUser) setState('landing');
      return;
    }
    previewTimer = setTimeout(() => {
      if (currentMode !== 'content' && currentMode !== 'loading') showTypingPreview();
      else { ui.field()?.classList.add('typing-active'); ui.input().classList.add('is-typing'); }
    }, PREVIEW_DELAY);
  });

  document.querySelectorAll('.example-chip').forEach(chip =>
    chip.addEventListener('click', () => { ui.input().value = chip.dataset.user; doSearch(); })
  );

  // Tab click — intercept hash change to activate tab with page 1
  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', e => {
      if (!activeUser) return;
      e.preventDefault();
      const tab = t.id.replace('tab-', '');
      activateTab(tab, 1);
      pushState(activeUser, tab, 1);
    })
  );
});

window.addEventListener('popstate', () => {
  const username = getUsername();
  const { tab, page } = parseHash();
  if (username) {
    ui.input().value = username;
    if (username === activeUser) activateTab(tab, page);
    else loadUser(username, tab, page);
  } else {
    resetToLanding();
  }
});
