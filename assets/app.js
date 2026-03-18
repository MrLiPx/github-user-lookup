/**
 * github-user-search — app.js
 * Build: IDewhVtoy4
 *
 * Copyright (c) MrLiPx. All rights reserved.
 */

'use strict';

// ─── Config ───────────────────────────────────────────────────────────────────

const API      = 'https://api.github.com';
const HDRS     = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const TIMEOUT  = 9_000;
const CACHE_MS = 5 * 60 * 1000; // 5 min session cache

const LANG_COLORS = {
  JavaScript:'#f1e05a', TypeScript:'#3178c6', Python:'#3572a5',
  HTML:'#e34c26', CSS:'#563d7c', Rust:'#dea584', Go:'#00add8',
  Java:'#b07219', 'C#':'#178600', 'C++':'#f34b7d', C:'#555',
  Ruby:'#701516', PHP:'#4f5d95', Shell:'#89e051', Kotlin:'#a97bff',
  Swift:'#f05138', Dart:'#00b4ab', Vue:'#41b883', Svelte:'#ff3e00',
  Dockerfile:'#384d54', Lua:'#000080', Perl:'#0298c3', R:'#198ce7',
};

// ─── DOM ──────────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const ui = {
  input:      () => $('usernameInput'),
  btn:        () => $('searchBtn'),
  landing:    () => $('landingUI'),
  loading:    () => $('loadingUI'),
  content:    () => $('profileContent'),
  errors:     () => $('errorContainer'),
  reposPanel: () => $('reposView'),
  starsPanel: () => $('starsView'),
  starsGrid:  () => $('starsGrid'),
  starsLoad:  () => $('starsLoading'),
};

// ─── State ────────────────────────────────────────────────────────────────────

let activeUser  = '';
let starsReady  = false;

// ─── Utils ────────────────────────────────────────────────────────────────────

/** XSS-safe HTML escaping */
const esc = s => String(s ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

/** Format large numbers: 1234 → 1.2k, 1500000 → 1.5M */
function fmt(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n/1_000_000).toFixed(1).replace(/\.0$/,'')+'M';
  if (n >= 1_000)     return (n/1_000)    .toFixed(1).replace(/\.0$/,'')+'k';
  return n.toLocaleString();
}

/** Format ISO date to e.g. "June 2020" */
const fmtDate = iso =>
  new Date(iso).toLocaleDateString(undefined, { year:'numeric', month:'long' });

// ─── API fetch with timeout + session cache ───────────────────────────────────

async function apiFetch(url) {
  const key = `gus_${url}`;

  try {
    const hit = sessionStorage.getItem(key);
    if (hit) {
      const { ts, data } = JSON.parse(hit);
      if (Date.now() - ts < CACHE_MS) return data;
    }
  } catch { /* storage unavailable */ }

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

    const data = await res.json();
    try { sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch { }
    return data;

  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('timeout');
    throw err;
  }
}

// ─── UI state ─────────────────────────────────────────────────────────────────

function setState(mode) {
  ['landing','loading','content','errors'].forEach(k => {
    const el = { landing:ui.landing(), loading:ui.loading(), content:ui.content(), errors:ui.errors() }[k];
    el?.classList.toggle('hidden', mode !== k);
  });
}

// ─── Error display ────────────────────────────────────────────────────────────

function showError(err) {
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
      : 'GitHub API rate limit exceeded. Please wait a few minutes and try again.';
  } else if (err.message === 'timeout') {
    icon  = 'fi-rr-wifi-slash';
    title = 'Request timed out';
    msg   = 'GitHub took too long to respond. Check your connection and try again.';
  }

  ui.errors().innerHTML =
    `<div class="error-card">
       <div class="error-icon-wrap"><i class="fi ${esc(icon)}" aria-hidden="true"></i></div>
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
  const u = new URL(location.href);
  u.searchParams.set('usn', q);
  u.hash = 'repos';
  history.pushState({}, '', u.pathname + u.search + u.hash);
  loadUser(q);
}

function resetToLanding() {
  history.pushState({}, '', location.pathname);
  ui.input().value = '';
  activeUser = '';
  starsReady = false;
  document.title = 'GitHub User Search — Developer Profile Explorer';
  setState('landing');
}

// ─── Load profile ─────────────────────────────────────────────────────────────

async function loadUser(username) {
  if (!username) return;
  setState('loading');
  starsReady = false;

  try {
    const [user, repos] = await Promise.all([
      apiFetch(`${API}/users/${username}`),
      apiFetch(`${API}/users/${username}/repos?sort=updated&per_page=100`),
    ]);

    activeUser = user.login;
    renderProfile(user, repos);
    setState('content');
    syncTabs();

    document.title = `${user.name || user.login} (@${user.login}) — GitHub User Search`;

  } catch (err) {
    showError(err);
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderProfile(user, repos) {
  // Avatar
  const img = $('avatar');
  img.src = user.avatar_url;
  img.alt = `${user.login} on GitHub`;

  // Name & handle
  $('fullName').textContent = user.name || user.login;
  $('loginId') .textContent = user.login;
  const lnk = $('loginLink');
  lnk.href = user.html_url;
  lnk.setAttribute('aria-label', `@${user.login} on GitHub (opens in new tab)`);

  // Hireable badge
  $('hireableStatus').classList.toggle('hidden', !user.hireable);

  // Bio
  $('bioText').textContent = user.bio || '';

  // Stats
  $('statFollowers').textContent = fmt(user.followers);
  $('statFollowing').textContent = fmt(user.following);
  $('statRepos')    .textContent = fmt(user.public_repos);
  $('statGists')    .textContent = fmt(user.public_gists);

  // Meta
  $('valJoined').textContent = `Joined ${fmtDate(user.created_at)}`;
  setMeta('valLocation', user.location, 'locBox');
  setMeta('valCompany',  user.company,  'compBox');
  setLink('valBlog',     user.blog,     'linkBox');

  // Badges
  renderBadges(user);

  // Repos — own repos sorted by stars, forks shown separately
  const own  = repos.filter(r => !r.fork).sort((a,b) => b.stargazers_count - a.stargazers_count);
  renderCards('reposView', own.length ? own : repos);
}

function setMeta(elId, val, boxId) {
  const box = $(boxId);
  if (val) { $(elId).textContent = val; box.classList.remove('hidden'); }
  else     { box.classList.add('hidden'); }
}

function setLink(elId, val, boxId) {
  const box = $(boxId);
  const el  = $(elId);
  if (val) {
    el.href        = val.startsWith('http') ? val : `https://${val}`;
    el.textContent = val.replace(/^https?:\/\//, '').replace(/\/$/, '');
    box.classList.remove('hidden');
  } else {
    box.classList.add('hidden');
  }
}

function renderBadges(user) {
  const row = $('achievementsList');
  const list = [];

  if (user.site_admin)       list.push(['fi-rr-shield-check', 'Staff',       'badge-blue']);
  if (user.followers >= 1000)list.push(['fi-rr-star',         'Influencer',  'badge-amber']);
  else if(user.followers>=100)list.push(['fi-rr-flame',       'Rising Star', 'badge-amber']);
  if (user.public_repos >= 50)list.push(['fi-rr-layers',      'Prolific',    'badge-green']);
  if (user.hireable)          list.push(['fi-rr-bolt',        'For Hire',    'badge-green']);
  if (user.public_gists >= 20)list.push(['fi-rr-code-branch', 'Gist Master', 'badge-purple']);

  row.innerHTML = list.map(([icon, label, cls]) =>
    `<span class="badge ${esc(cls)}" role="listitem">
       <i class="fi ${esc(icon)}" aria-hidden="true"></i>${esc(label)}
     </span>`
  ).join('');
}

// ─── Repo cards ───────────────────────────────────────────────────────────────

function makeCard(item) {
  const lang  = item.language ?? '';
  const color = LANG_COLORS[lang] ?? '#4a5568';
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
          <span class="lang-dot" style="background:${esc(color)}" aria-hidden="true"></span>${esc(lang)}
        </span>` : ''}
        <i class="fi fi-rr-arrow-right repo-arrow" aria-hidden="true"></i>
      </div>
    </a>`;
}

function renderCards(containerId, items) {
  const el = $(containerId);
  if (!items?.length) {
    el.innerHTML =
      `<div class="panel-empty">
         <i class="fi fi-rr-folder" aria-hidden="true"></i>
         <p>No repositories found.</p>
       </div>`;
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'repo-grid';
  grid.innerHTML = items.map(makeCard).join('');
  el.replaceChildren(grid);
}

// ─── Stars ────────────────────────────────────────────────────────────────────

async function loadStars(username) {
  if (starsReady) return;
  ui.starsGrid().replaceChildren();
  ui.starsLoad().classList.remove('hidden');

  try {
    const stars = await apiFetch(`${API}/users/${username}/starred?per_page=30`);
    starsReady = true;
    renderCards('starsGrid', stars);
  } catch {
    ui.starsGrid().innerHTML =
      `<div class="panel-empty">
         <i class="fi fi-rr-exclamation" aria-hidden="true"></i>
         <p>Could not load starred repositories.</p>
       </div>`;
  } finally {
    ui.starsLoad().classList.add('hidden');
  }
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function syncTabs() {
  const hash = (location.hash || '#repos').slice(1);

  ui.reposPanel().classList.toggle('hidden', hash !== 'repos');
  ui.starsPanel().classList.toggle('hidden', hash !== 'stars');

  document.querySelectorAll('.tab').forEach(t => {
    const on = t.id === `tab-${hash}`;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });

  if (hash === 'stars' && activeUser) loadStars(activeUser);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const initial = params.get('usn') || params.get('username');

  if (initial) {
    ui.input().value = initial;
    loadUser(initial);
  } else {
    setState('landing');
  }

  syncTabs();

  // Keyboard shortcut: Cmd/Ctrl + K → focus search
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      ui.input().focus();
      ui.input().select();
    }
    if (e.key === 'Escape' && document.activeElement === ui.input()) {
      ui.input().blur();
    }
  });

  ui.input().addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  ui.btn()  .addEventListener('click',   doSearch);

  document.querySelectorAll('.example-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      ui.input().value = chip.dataset.user;
      doSearch();
    });
  });
});

window.addEventListener('hashchange', syncTabs);

window.addEventListener('popstate', () => {
  const q = new URLSearchParams(location.search).get('usn');
  if (q) { ui.input().value = q; loadUser(q); }
  else   { resetToLanding(); }
});
