/**
 * github-user-search — app.js
 * Build: IYwNhpt6h0
 * Copyright (c) MrLiPx. All rights reserved.
 */

'use strict';

// ─── Config ───────────────────────────────────────────────────────────────────

const API           = 'https://api.github.com';
const HDRS          = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const TIMEOUT       = 9_000;
const CACHE_MS      = 5 * 60 * 1000;
const PER_PAGE      = 10;         // repos / stars per page
const PREVIEW_DELAY = 280;        // ms before typing preview appears

const LANG_COLORS = {
  JavaScript:'#f1e05a', TypeScript:'#3178c6', Python:'#3572a5',
  HTML:'#e34c26', CSS:'#563d7c', Rust:'#dea584', Go:'#00add8',
  Java:'#b07219', 'C#':'#178600', 'C++':'#f34b7d', C:'#555555',
  Ruby:'#701516', PHP:'#4f5d95', Shell:'#89e051', Kotlin:'#a97bff',
  Swift:'#f05138', Dart:'#00b4ab', Vue:'#41b883', Svelte:'#ff3e00',
  Dockerfile:'#384d54', Lua:'#000080', Perl:'#0298c3', R:'#198ce7',
};

// ─── DOM helpers ──────────────────────────────────────────────────────────────

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

let activeUser   = '';
let currentMode  = 'landing';
let previewTimer = null;

// Full sorted repo list (own repos) — paginated client-side
let allRepos     = [];

// Stars are fetched page-by-page from the API
let allStars     = [];
let starsPage    = 1;
let starsTotal   = null;   // total starred count from Link header
let starsFetching = false;

// ─── Utils ────────────────────────────────────────────────────────────────────

const esc = s => String(s ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

function fmt(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return n.toLocaleString();
}

const fmtDate = iso =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });

// Parse Link header from GitHub API to get total page count
function parseLinkHeader(header) {
  if (!header) return {};
  const links = {};
  header.split(',').forEach(part => {
    const m = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (m) links[m[2]] = m[1];
  });
  return links;
}

// Get page number from a GitHub API URL
function pageFromUrl(url) {
  if (!url) return null;
  const m = url.match(/[?&]page=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// ─── URL state helpers ────────────────────────────────────────────────────────

function getUrlParams() {
  const p = new URLSearchParams(location.search);
  return {
    usn:    p.get('usn') || p.get('username') || '',
    rpage:  Math.max(1, parseInt(p.get('rpage') || '1', 10)),
    spage:  Math.max(1, parseInt(p.get('spage') || '1', 10)),
  };
}

function pushUrlState(usn, rpage, spage, tab) {
  const p = new URLSearchParams();
  if (usn)   p.set('usn',   usn);
  if (rpage > 1) p.set('rpage', rpage);
  if (spage > 1) p.set('spage', spage);
  const hash = tab || (location.hash || '#repos').slice(1);
  history.pushState({}, '', `${location.pathname}?${p}#${hash}`);
}

function replaceUrlState(usn, rpage, spage, tab) {
  const p = new URLSearchParams();
  if (usn)   p.set('usn',   usn);
  if (rpage > 1) p.set('rpage', rpage);
  if (spage > 1) p.set('spage', spage);
  const hash = tab || (location.hash || '#repos').slice(1);
  history.replaceState({}, '', `${location.pathname}?${p}#${hash}`);
}

// ─── API ──────────────────────────────────────────────────────────────────────

async function apiFetch(url) {
  const key = `gus_${url}`;
  try {
    const hit = sessionStorage.getItem(key);
    if (hit) {
      const { ts, data } = JSON.parse(hit);
      if (Date.now() - ts < CACHE_MS) return data;
    }
  } catch { }

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);

  try {
    const res = await fetch(url, { headers: HDRS, signal: ctrl.signal });
    clearTimeout(timer);

    if (res.status === 403) {
      const rem = res.headers.get('X-RateLimit-Remaining');
      if (rem === '0') {
        const reset = res.headers.get('X-RateLimit-Reset');
        const mins  = reset ? Math.ceil((+reset * 1000 - Date.now()) / 60000) : null;
        throw Object.assign(new Error('rate_limit'), { rateMins: mins });
      }
    }

    if (!res.ok) throw Object.assign(new Error('http'), { status: res.status });

    // For stars we also need the full Response to read Link header
    const data = await res.json();
    const linkHeader = res.headers.get('Link');
    try { sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch { }
    return { data, linkHeader };

  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('timeout');
    throw err;
  }
}

// Convenience wrapper that returns just the data (for non-paginated calls)
async function fetchData(url) {
  const result = await apiFetch(url);
  return result.data;
}

// ─── State machine ────────────────────────────────────────────────────────────

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

// ─── Typing preview ───────────────────────────────────────────────────────────

function showTypingPreview() {
  const field = ui.field();
  if (field) { field.classList.add('typing-active'); }
  ui.input().classList.add('is-typing');
  setState('preview');
}

function clearTypingState() {
  const field = ui.field();
  if (field) { field.classList.remove('typing-active'); }
  ui.input().classList.remove('is-typing');
  clearTimeout(previewTimer);
  previewTimer = null;
}

// ─── Error ────────────────────────────────────────────────────────────────────

function showError(err) {
  clearTypingState();
  setState('errors');

  let icon  = 'fi-rr-exclamation';
  let title = 'Something went wrong';
  let msg   = 'An unexpected error occurred. Please try again.';

  if (err.status === 404) {
    icon  = 'fi-rr-search';
    title = 'User not found';
    msg   = `No GitHub account matches <strong>${esc(ui.input().value.trim())}</strong>. Check the spelling and try again.`;
  } else if (err.message === 'rate_limit') {
    icon  = 'fi-rr-hourglass-end';
    title = 'Rate limit reached';
    msg   = err.rateMins
      ? `GitHub API rate limit exceeded. Resets in ~${err.rateMins} min.`
      : 'GitHub API rate limit exceeded. Please wait a few minutes.';
  } else if (err.message === 'timeout') {
    icon  = 'fi-rr-wifi-slash';
    title = 'Request timed out';
    msg   = 'GitHub took too long to respond. Check your connection and try again.';
  }

  ui.errors().innerHTML =
    `<div class="error-card">
       <div class="error-icon"><i class="fi ${esc(icon)}" aria-hidden="true"></i></div>
       <div>
         <p class="error-title">${esc(title)}</p>
         <p class="error-msg">${msg}</p>
       </div>
     </div>`;
}

// ─── Search ───────────────────────────────────────────────────────────────────

function doSearch() {
  const q = ui.input().value.trim();
  if (!q) { ui.input().focus(); return; }
  clearTypingState();
  pushUrlState(q, 1, 1, 'repos');
  loadUser(q, 1, 1);
}

function resetToLanding() {
  clearTypingState();
  history.pushState({}, '', location.pathname);
  ui.input().value = '';
  activeUser    = '';
  allRepos      = [];
  allStars      = [];
  starsPage     = 1;
  starsTotal    = null;
  starsFetching = false;
  document.title = 'GitHub User Search — Developer Profile Explorer';
  setState('landing');
}

// ─── Load user ────────────────────────────────────────────────────────────────

async function loadUser(username, rpage = 1, spage = 1) {
  if (!username) return;
  clearTypingState();
  setState('loading');

  // Reset pagination state for new user
  allRepos      = [];
  allStars      = [];
  starsPage     = 1;
  starsTotal    = null;
  starsFetching = false;

  try {
    // Fetch user profile + first page of repos in parallel
    const [user, reposResult] = await Promise.all([
      fetchData(`${API}/users/${username}`),
      apiFetch(`${API}/users/${username}/repos?sort=stars&direction=desc&per_page=100&page=1`),
    ]);

    activeUser = user.login;

    // Store all repos (up to 100 from first fetch, sorted by stars desc)
    let repos = Array.isArray(reposResult.data) ? reposResult.data : [];

    // If user has more than 100 repos, fetch remaining pages
    const links     = parseLinkHeader(reposResult.linkHeader);
    const lastPage  = pageFromUrl(links.last);

    if (lastPage && lastPage > 1) {
      const extraFetches = [];
      for (let p = 2; p <= lastPage; p++) {
        extraFetches.push(
          apiFetch(`${API}/users/${username}/repos?sort=stars&direction=desc&per_page=100&page=${p}`)
            .then(r => r.data)
            .catch(() => [])
        );
      }
      const extras = await Promise.all(extraFetches);
      repos = repos.concat(...extras.filter(Array.isArray));
    }

    // Sort: own repos by stars desc, forks after
    const own   = repos.filter(r => !r.fork).sort((a, b) => b.stargazers_count - a.stargazers_count);
    const forks = repos.filter(r =>  r.fork).sort((a, b) => b.stargazers_count - a.stargazers_count);
    allRepos    = [...own, ...forks];

    renderProfile(user);
    setState('content');

    // Determine which tab to show from URL
    const tab = (location.hash || '#repos').slice(1);
    renderReposPage(rpage);
    syncTabs(tab === 'stars' ? spage : null);

    document.title = `${user.name || user.login} (@${user.login}) — GitHub User Search`;

  } catch (err) {
    showError(err);
  }
}

// ─── Render profile (hero only, no cards) ─────────────────────────────────────

function renderProfile(user) {
  const img = $('avatar');
  img.src = user.avatar_url;
  img.alt = `${user.login} GitHub avatar`;

  $('fullName').textContent = user.name || user.login;
  $('loginId') .textContent = user.login;

  const lnk = $('loginLink');
  lnk.href = user.html_url;
  lnk.setAttribute('aria-label', `@${user.login} on GitHub (opens in new tab)`);

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

// ─── Cards ────────────────────────────────────────────────────────────────────

function makeCard(item) {
  const lang  = item.language ?? '';
  const color = LANG_COLORS[lang] ?? '#46546a';
  const desc  = item.description ?? 'No description provided.';

  return `
    <a class="repo-card" href="${esc(item.html_url)}" target="_blank" rel="noopener noreferrer"
       aria-label="${esc(item.name)} — view on GitHub">
      <div class="repo-head">
        <span class="repo-name">${esc(item.name)}</span>
        ${item.fork ? `<span class="repo-badge">fork</span>` : ''}
      </div>
      <p class="repo-desc">${esc(desc)}</p>
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

// ─── Repos pagination ─────────────────────────────────────────────────────────

function renderReposPage(page) {
  page = Math.max(1, page || 1);

  const total     = allRepos.length;
  const totalPages = total > 0 ? Math.ceil(total / PER_PAGE) : 1;
  page            = Math.min(page, totalPages);

  const start  = (page - 1) * PER_PAGE;
  const slice  = allRepos.slice(start, start + PER_PAGE);

  const container = $('reposView');
  container.replaceChildren();

  if (!total) {
    container.innerHTML =
      `<div class="panel-empty">
         <i class="fi fi-rr-folder" aria-hidden="true"></i>
         <p>No repositories found.</p>
       </div>`;
    return;
  }

  // Cards grid
  const grid = document.createElement('div');
  grid.className = 'repo-grid';
  grid.innerHTML  = slice.map(makeCard).join('');
  container.appendChild(grid);

  // Pagination
  if (totalPages > 1) {
    container.appendChild(buildPager(page, totalPages, 'repos'));
  }

  // Update URL (replace so back button still works naturally)
  const { spage } = getUrlParams();
  replaceUrlState(activeUser, page, spage, 'repos');
}

// ─── Stars pagination ─────────────────────────────────────────────────────────

async function loadStarsPage(page) {
  if (starsFetching) return;
  page = Math.max(1, page || 1);

  // If we already have this page cached in allStars, just render
  const start = (page - 1) * PER_PAGE;
  const end   = start + PER_PAGE;

  // Check if we have all items needed
  if (allStars.length >= end || (starsTotal !== null && allStars.length >= starsTotal)) {
    renderStarsPage(page);
    return;
  }

  // Need to fetch more pages from GitHub
  // GitHub stars API uses its own page param with per_page
  // We convert our UI page to GitHub API page
  const ghPage = Math.ceil(end / 30); // GitHub default per_page for stars is 30

  starsFetching = true;
  ui.starsLoad().classList.remove('hidden');
  ui.starsGrid().classList.add('hidden');

  try {
    // Fetch all GitHub pages needed to cover our UI page
    const needed = Math.ceil(end / 30);
    const alreadyFetched = Math.floor(allStars.length / 30);

    for (let p = alreadyFetched + 1; p <= needed; p++) {
      const result = await apiFetch(
        `${API}/users/${activeUser}/starred?per_page=30&page=${p}`
      );
      const batch = Array.isArray(result.data) ? result.data : [];
      allStars = allStars.concat(batch);

      // Parse total from Link header on first fetch
      if (starsTotal === null) {
        const links    = parseLinkHeader(result.linkHeader);
        const lastPage = pageFromUrl(links.last);
        starsTotal = lastPage ? lastPage * 30 : batch.length;
      }

      if (batch.length < 30) {
        // Last page reached
        starsTotal = allStars.length;
        break;
      }
    }

    renderStarsPage(page);

  } catch (err) {
    ui.starsGrid().innerHTML =
      `<div class="panel-empty">
         <i class="fi fi-rr-exclamation" aria-hidden="true"></i>
         <p>Could not load starred repositories.</p>
       </div>`;
  } finally {
    starsFetching = false;
    ui.starsLoad().classList.add('hidden');
    ui.starsGrid().classList.remove('hidden');
  }
}

function renderStarsPage(page) {
  page = Math.max(1, page || 1);

  const total      = starsTotal ?? allStars.length;
  const totalPages  = total > 0 ? Math.ceil(total / PER_PAGE) : 1;
  page             = Math.min(page, totalPages);

  const start = (page - 1) * PER_PAGE;
  const slice = allStars.slice(start, start + PER_PAGE);

  const container = $('starsGrid');
  container.replaceChildren();

  if (!allStars.length) {
    container.innerHTML =
      `<div class="panel-empty">
         <i class="fi fi-rr-star" aria-hidden="true"></i>
         <p>No starred repositories found.</p>
       </div>`;
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'repo-grid';
  grid.innerHTML  = slice.map(makeCard).join('');
  container.appendChild(grid);

  if (totalPages > 1) {
    container.appendChild(buildPager(page, totalPages, 'stars'));
  }

  // Update URL
  const { rpage } = getUrlParams();
  replaceUrlState(activeUser, rpage, page, 'stars');
}

// ─── Pager component ─────────────────────────────────────────────────────────

/**
 * Builds a pagination bar.
 * @param {number} current  current page (1-based)
 * @param {number} total    total pages
 * @param {string} tab      'repos' or 'stars'
 */
function buildPager(current, total, tab) {
  const wrap = document.createElement('div');
  wrap.className = 'pager';
  wrap.setAttribute('role', 'navigation');
  wrap.setAttribute('aria-label', `${tab} pagination`);

  const perPageCount = PER_PAGE;
  const start = (current - 1) * perPageCount + 1;
  const end   = Math.min(current * perPageCount, tab === 'repos' ? allRepos.length : (starsTotal ?? allStars.length));
  const total_ = tab === 'repos' ? allRepos.length : (starsTotal ?? allStars.length);

  // Prev button
  const prev = makePageBtn('', current === 1, () => goPage(current - 1, tab));
  prev.innerHTML = '<i class="fi fi-rr-angle-left" aria-hidden="true"></i>';
  prev.setAttribute('aria-label', 'Previous page');
  wrap.appendChild(prev);

  // Page number buttons with ellipsis
  const pages = pageRange(current, total);
  for (const p of pages) {
    if (p === '…') {
      const dots = document.createElement('span');
      dots.className = 'pager-ellipsis';
      dots.textContent = '…';
      wrap.appendChild(dots);
    } else {
      const btn = makePageBtn(p, false, () => goPage(p, tab));
      if (p === current) btn.classList.add('active');
      btn.setAttribute('aria-label', `Page ${p}`);
      btn.setAttribute('aria-current', p === current ? 'page' : 'false');
      wrap.appendChild(btn);
    }
  }

  // Next button
  const next = makePageBtn('', current === total, () => goPage(current + 1, tab));
  next.innerHTML = '<i class="fi fi-rr-angle-right" aria-hidden="true"></i>';
  next.setAttribute('aria-label', 'Next page');
  wrap.appendChild(next);

  // Info line
  const info = document.createElement('p');
  info.className = 'pager-info';
  info.textContent = `${start}–${end} of ${total_} ${tab}`;
  wrap.appendChild(info);

  return wrap;
}

function makePageBtn(label, disabled, onClick) {
  const btn = document.createElement('button');
  btn.className = 'pager-btn';
  btn.textContent = label;
  btn.disabled = disabled;
  if (!disabled) btn.addEventListener('click', onClick);
  return btn;
}

/**
 * Returns an array of page numbers and '…' for ellipsis.
 * Always shows first, last, current±1.
 */
function pageRange(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);

  const pages = new Set([1, total, current, current - 1, current + 1]
    .filter(p => p >= 1 && p <= total));

  const sorted = [...pages].sort((a, b) => a - b);
  const result = [];

  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) result.push('…');
    result.push(sorted[i]);
  }

  return result;
}

function goPage(page, tab) {
  // Scroll repo/stars area into view
  const el = tab === 'repos' ? $('reposView') : $('starsView');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (tab === 'repos') {
    renderReposPage(page);
  } else {
    loadStarsPage(page);
  }
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function syncTabs(starPageOverride) {
  const hash = (location.hash || '#repos').slice(1);
  const tab  = (hash === 'stars') ? 'stars' : 'repos';

  ui.reposPanel().classList.toggle('hidden', tab !== 'repos');
  ui.starsPanel().classList.toggle('hidden', tab !== 'stars');

  document.querySelectorAll('.tab').forEach(t => {
    const on = t.id === `tab-${tab}`;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });

  if (tab === 'stars' && activeUser) {
    const page = starPageOverride ?? getUrlParams().spage;
    loadStarsPage(page);
  }
}

// ─── Landing typing animation ─────────────────────────────────────────────────

function animateLandingTitle() {
  const el = $('landingTitle');
  if (!el) return;
  const full = el.dataset.text || el.textContent.trim();
  el.dataset.text = full;
  let i = 0;
  el.textContent = '';
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  el.appendChild(cursor);
  const type = () => {
    if (i < full.length) {
      cursor.before(full[i++]);
      setTimeout(type, i === 1 ? 100 : 45 + Math.random() * 25);
    }
  };
  setTimeout(type, 500);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const { usn, rpage, spage } = getUrlParams();

  if (usn) {
    ui.input().value = usn;
    loadUser(usn, rpage, spage);
  } else {
    setState('landing');
    animateLandingTitle();
  }

  syncTabs();

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

  // Typing debounce — preview only, no API call
  ui.input().addEventListener('input', () => {
    const q = ui.input().value.trim();
    clearTimeout(previewTimer);

    if (!q) {
      clearTypingState();
      if (!activeUser) setState('landing');
      return;
    }

    previewTimer = setTimeout(() => {
      if (currentMode !== 'content' && currentMode !== 'loading') {
        showTypingPreview();
      } else {
        ui.field()?.classList.add('typing-active');
        ui.input().classList.add('is-typing');
      }
    }, PREVIEW_DELAY);
  });

  document.querySelectorAll('.example-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      ui.input().value = chip.dataset.user;
      doSearch();
    });
  });
});

window.addEventListener('hashchange', () => syncTabs());

window.addEventListener('popstate', () => {
  const { usn, rpage, spage } = getUrlParams();
  if (usn) {
    ui.input().value = usn;
    // If same user, just re-render the right page
    if (usn === activeUser) {
      const tab = (location.hash || '#repos').slice(1);
      if (tab === 'stars') {
        syncTabs(spage);
      } else {
        renderReposPage(rpage);
        syncTabs();
      }
    } else {
      loadUser(usn, rpage, spage);
    }
  } else {
    resetToLanding();
  }
});
