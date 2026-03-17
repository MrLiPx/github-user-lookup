/**
 * GitHub User Insights v2.0
 * Logic & API Core
 */

const UI = {
    input: document.getElementById('usernameInput'),
    loading: document.getElementById('loadingUI'),
    content: document.getElementById('profileContent'),
    errors: document.getElementById('errorContainer'),
    reposView: document.getElementById('reposView'),
    starsView: document.getElementById('starsView'),
    starsGrid: document.getElementById('starsGrid'),
    starsLoading: document.getElementById('starsLoading')
};

const API_HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
};

let state = {
    username: "",
    cachedStars: new Map()
};

// --- Initialization ---

window.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const user = params.get('usn') || params.get('username');
    
    if (user) {
        UI.input.value = user;
        if (!window.location.hash) window.location.hash = 'repos';
        fetchProfile(user);
    }

    handleHashChange();
    
    // Global Keyboard Shortcuts
    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
            e.preventDefault();
            UI.input.focus();
        }
    });

    UI.input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleSearch();
    });
});

window.addEventListener('hashchange', handleHashChange);

// --- Core Actions ---

function handleSearch() {
    const query = UI.input.value.trim();
    if (!query) return;

    // Fix for GitHub Pages subfolder hosting
    const url = new URL(window.location.href);
    url.searchParams.set('usn', query);
    url.hash = 'repos';
    
    // Using pushState with the updated search params and hash
    window.history.pushState({}, '', url.pathname + url.search + url.hash);
    fetchProfile(query);
}

async function fetchProfile(username) {
    const cacheKey = `gh_insight_${username.toLowerCase()}`;
    const cached = sessionStorage.getItem(cacheKey);

    if (cached) {
        const data = JSON.parse(cached);
        state.username = data.user.login;
        renderDashboard(data.user, data.repos);
        return;
    }

    setUIState('loading');

    try {
        const userRes = await fetch(`https://api.github.com/users/${username}`, { headers: API_HEADERS });
        
        if (!userRes.ok) {
            handleError(userRes.status);
            return;
        }

        const user = await userRes.json();
        const repoRes = await fetch(`https://api.github.com/users/${user.login}/repos?sort=updated&per_page=50`, { headers: API_HEADERS });
        const repos = repoRes.ok ? await repoRes.json() : [];

        sessionStorage.setItem(cacheKey, JSON.stringify({ user, repos }));
        state.username = user.login;
        renderDashboard(user, repos);
    } catch (err) {
        handleError(0);
    }
}

async function fetchStars(username) {
    if (state.cachedStars.has(username)) return;
    
    UI.starsGrid.innerHTML = '';
    UI.starsLoading.classList.remove('hidden');

    try {
        const res = await fetch(`https://api.github.com/users/${username}/starred?per_page=30`, { headers: API_HEADERS });
        if (res.ok) {
            const stars = await res.json();
            state.cachedStars.set(username, stars);
            renderGrid('starsGrid', stars);
        }
    } catch (e) {
        UI.starsGrid.innerHTML = `<p class="col-span-full text-center text-rose-400">Database connection failed.</p>`;
    } finally {
        UI.starsLoading.classList.add('hidden');
    }
}

// --- View Rendering ---

function renderDashboard(user, repos) {
    setUIState('content');

    // Hero Data
    document.getElementById('avatar').src = user.avatar_url;
    document.getElementById('fullName').textContent = user.name || user.login;
    document.getElementById('loginId').textContent = user.login;
    document.getElementById('bioText').textContent = user.bio || "Crafting digital experiences through code.";
    
    // Hireable badge
    document.getElementById('hireableStatus').classList.toggle('hidden', !user.hireable);

    // Numeric Metrics
    document.getElementById('statFollowers').textContent = user.followers.toLocaleString();
    document.getElementById('statFollowing').textContent = user.following.toLocaleString();
    document.getElementById('statRepos').textContent = user.public_repos.toLocaleString();
    document.getElementById('statGists').textContent = user.public_gists.toLocaleString();

    // Date
    const joined = new Date(user.created_at).toLocaleDateString(undefined, { 
        year: 'numeric', month: 'long' 
    });
    document.getElementById('valJoined').textContent = joined;

    // Achievements
    const achBox = document.getElementById('achievementsList');
    achBox.innerHTML = '';
    if (user.public_repos > 50) achBox.innerHTML += badge('Arch-Architect', 'fi-rr-bolt');
    if (user.followers > 1000) achBox.innerHTML += badge('Global Influence', 'fi-rr-star');
    if (user.site_admin) achBox.innerHTML += badge('GitHub Staff', 'fi-rr-shield-check');
    if (user.followers > 100 && user.followers < 1000) achBox.innerHTML += badge('Rising Star', 'fi-rr-flame');

    // Metadata
    updateMeta('valLocation', user.location, 'locBox');
    updateMeta('valBlog', user.blog, 'linkBox', true);
    updateMeta('valCompany', user.company, 'compBox');

    renderGrid('reposView', repos);

    // Sync current tab
    if (window.location.hash === '#stars') fetchStars(user.login);
}

function renderGrid(containerId, items) {
    const container = document.getElementById(containerId);
    if (!items || items.length === 0) {
        container.innerHTML = `<div class="col-span-full py-24 text-center text-gray-600 font-bold uppercase tracking-widest text-xs">No Records Found</div>`;
        return;
    }

    container.innerHTML = items.map(item => `
        <article class="repo-card group">
            <div>
                <div class="flex items-start justify-between gap-4 mb-4">
                    <a href="${item.html_url}" target="_blank" class="text-lg font-bold text-white group-hover:text-blue-400 transition-colors line-clamp-1">${item.name}</a>
                    <span class="px-2 py-1 bg-white/5 border border-white/10 rounded-lg text-[10px] font-black text-gray-500 uppercase">${item.language || 'Code'}</span>
                </div>
                <p class="text-sm text-gray-400 line-clamp-2 leading-relaxed mb-6 opacity-80">${item.description || 'System documentation not provided for this node.'}</p>
            </div>
            <div class="flex items-center gap-6 pt-5 border-t border-white/5 text-[11px] font-black text-gray-500">
                <span class="flex items-center gap-2"><i class="fi fi-rr-star text-amber-500/70"></i> ${item.stargazers_count}</span>
                <span class="flex items-center gap-2"><i class="fi fi-rr-git-fork text-blue-500/70"></i> ${item.forks_count}</span>
                <i class="fi fi-rr-arrow-right ml-auto text-gray-800 group-hover:text-blue-500 group-hover:translate-x-1 transition-all"></i>
            </div>
        </article>
    `).join('');
}

// --- Utilities ---

function handleHashChange() {
    const hash = window.location.hash || '#repos';
    const tab = hash.substring(1);
    
    // Toggle UI visibility
    UI.reposView.classList.toggle('hidden', tab !== 'repos');
    UI.starsView.classList.toggle('hidden', tab !== 'stars');
    
    // Toggle active links
    document.querySelectorAll('.tab-link').forEach(link => {
        link.classList.toggle('active', link.id === `tab-${tab}`);
    });

    if (tab === 'stars' && state.username) fetchStars(state.username);
}

function setUIState(mode) {
    UI.loading.classList.toggle('hidden', mode !== 'loading');
    UI.content.classList.toggle('hidden', mode !== 'content');
    UI.errors.classList.toggle('hidden', mode !== 'error');
}

function handleError(status) {
    setUIState('error');
    let message = "A system anomaly occurred.";
    let icon = "fi-rr-wifi-slash";

    if (status === 404) {
        message = "Subject identifier not found in database.";
        icon = "fi-rr-exclamation";
    } else if (status === 403) {
        message = "Neural link saturated. API rate limit exceeded.";
        icon = "fi-rr-hourglass-end";
    }

    UI.errors.innerHTML = `
        <div class="p-6 bg-rose-500/10 border border-rose-500/20 rounded-3xl flex items-center gap-5 text-rose-400">
            <div class="p-3 bg-rose-500/10 rounded-2xl"><i class="fi ${icon} text-2xl"></i></div>
            <div>
                <h4 class="font-bold text-lg">Transmission Error</h4>
                <p class="text-sm opacity-80">${message}</p>
            </div>
        </div>
    `;
}

function badge(text, icon) {
    return `<div class="achievement-badge flex items-center gap-2"><i class="fi ${icon}"></i> ${text}</div>`;
}

function updateMeta(id, value, boxId, isLink = false) {
    const el = document.getElementById(id);
    const box = document.getElementById(boxId);
    if (value) {
        if (isLink) {
            el.href = value.startsWith('http') ? value : `https://${value}`;
            el.textContent = value.replace(/^https?:\/\//, '').split('/')[0];
        } else {
            el.textContent = value;
        }
        box.classList.remove('hidden');
    } else {
        box.classList.add('hidden');
    }
}
