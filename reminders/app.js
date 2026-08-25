/* Reminders Mirror: reads a JSON snapshot an iOS Shortcut commits to a private repo.
   The page itself is public, so the read-only token lives in localStorage per device. */

const STORE_KEY = 'reminders-config';
const DEFAULTS = { repo: 'ideal-knee/reminder-data', path: 'reminders.json', branch: 'main', token: '' };

const state = {
  config: loadConfig(),
  data: null,
  error: null,
  loading: false,
  demo: false,
  query: '',
  list: ''
};

const view = document.getElementById('view');
const stamp = document.getElementById('stamp');
const modeTag = document.getElementById('mode');

/* ---------- config ---------- */

function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(config) {
  state.config = { ...DEFAULTS, ...config };
  localStorage.setItem(STORE_KEY, JSON.stringify(state.config));
}

function configured() {
  const { repo, path, token } = state.config;
  return Boolean(repo && path && token);
}

/* ---------- data ---------- */

async function fetchSnapshot() {
  const { repo, path, branch, token } = state.config;
  const url = `https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch || 'main')}&t=${Date.now()}`;
  // The raw media type returns the file body itself rather than base64 in a wrapper.
  const res = await fetch(url, {
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.raw+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (res.status === 401) throw new Error('token rejected (401) — expired or revoked?');
  if (res.status === 403) throw new Error('forbidden (403) — token lacks Contents: Read on this repo');
  if (res.status === 404) throw new Error('not found (404) — check the repo, branch and file path');
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function load() {
  state.loading = true;
  state.error = null;
  render();
  try {
    if (configured()) {
      state.demo = false;
      state.data = await fetchSnapshot();
    } else {
      state.demo = true;
      const res = await fetch('sample.json', { cache: 'no-store' });
      state.data = await res.json();
    }
    if (!Array.isArray(state.data.reminders)) throw new Error('no "reminders" array in the JSON');
  } catch (err) {
    state.error = err.message;
  } finally {
    state.loading = false;
    render();
  }
}

/* ---------- helpers ---------- */

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d) ? null : d;
}

function dueLabel(d) {
  const now = new Date();
  const days = Math.round((d - now) / 86400000);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d < now) return `overdue \u2014 ${d.toLocaleDateString()}`;
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  return `${d.toLocaleDateString()} ${time}`;
}

function visible(reminders, showCompleted) {
  const q = state.query.trim().toLowerCase();
  return reminders
    .filter(r => showCompleted || !r.completed)
    .filter(r => !state.list || (r.list || '') === state.list)
    .filter(r => !q || [r.title, r.list, r.notes].some(v => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => {
      if (!!a.completed !== !!b.completed) return a.completed ? 1 : -1;
      const da = parseDate(a.due);
      const db = parseDate(b.due);
      if (da && db) return da - db;
      if (da) return -1;
      if (db) return 1;
      return (a.title || '').localeCompare(b.title || '');
    });
}

/* ---------- list view ---------- */

function renderItems(showCompleted) {
  const items = document.getElementById('items');
  const empty = document.getElementById('empty');
  const status = document.getElementById('status');

  status.classList.remove('error');
  if (state.loading) {
    status.textContent = 'Loading\u2026';
  } else if (state.error) {
    status.textContent = `Could not load the snapshot \u2014 ${state.error}`;
    status.classList.add('error');
  } else if (state.demo) {
    status.innerHTML = 'Showing sample data. <a href="#/settings">Connect your private repo</a> to see real reminders.';
  } else {
    status.textContent = '';
  }

  items.innerHTML = '';
  const rows = state.data ? visible(state.data.reminders || [], showCompleted) : [];
  empty.hidden = rows.length > 0 || state.loading || !!state.error;

  for (const r of rows) {
    const li = document.createElement('li');
    li.className = `item${r.completed ? ' done' : ''}`;

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = r.title || '(untitled)';
    li.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const tags = [];
    if (r.list) tags.push({ text: r.list });
    const due = parseDate(r.due);
    if (due) tags.push({ text: dueLabel(due), cls: due < new Date() ? 'due-soon' : '' });
    if (r.flagged) tags.push({ text: 'flagged', cls: 'flag' });
    if (r.priority) tags.push({ text: `priority ${r.priority}` });
    for (const t of tags) {
      const span = document.createElement('span');
      span.className = `tag ${t.cls || ''}`.trim();
      span.textContent = t.text;
      meta.appendChild(span);
    }
    if (meta.childElementCount) li.appendChild(meta);

    if (r.notes) {
      const p = document.createElement('p');
      p.className = 'notes';
      p.textContent = r.notes;
      li.appendChild(p);
    }
    items.appendChild(li);
  }
}

function mountList(showCompleted) {
  const q = document.getElementById('q');
  const listFilter = document.getElementById('list-filter');

  q.value = state.query;
  const lists = state.data
    ? [...new Set((state.data.reminders || []).map(r => r.list).filter(Boolean))].sort()
    : [];
  for (const name of lists) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    listFilter.appendChild(opt);
  }
  listFilter.value = lists.includes(state.list) ? state.list : '';

  q.addEventListener('input', () => { state.query = q.value; renderItems(showCompleted); });
  listFilter.addEventListener('change', () => { state.list = listFilter.value; renderItems(showCompleted); });
  document.getElementById('refresh').addEventListener('click', load);

  renderItems(showCompleted);
}

/* ---------- settings view ---------- */

function mountSettings() {
  const form = document.getElementById('settings-form');
  const repo = document.getElementById('f-repo');
  const path = document.getElementById('f-path');
  const branch = document.getElementById('f-branch');
  const token = document.getElementById('f-token');
  const msg = document.getElementById('settings-msg');

  repo.value = state.config.repo;
  path.value = state.config.path;
  branch.value = state.config.branch;
  token.value = state.config.token;

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const value = repo.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
    if (!/^[\w.-]+\/[\w.-]+$/.test(value)) {
      msg.textContent = 'Repo should look like owner/name.';
      msg.classList.add('error');
      return;
    }
    saveConfig({
      repo: value,
      path: path.value.trim().replace(/^\//, '') || DEFAULTS.path,
      branch: branch.value.trim() || DEFAULTS.branch,
      token: token.value.trim()
    });
    msg.classList.remove('error');
    msg.textContent = 'Checking\u2026';
    await load();
    if (state.error) {
      msg.textContent = state.error;
      msg.classList.add('error');
    } else {
      location.hash = '#/open';
    }
  });

  document.getElementById('f-clear').addEventListener('click', () => {
    saveConfig({ ...state.config, token: '' });
    token.value = '';
    msg.classList.remove('error');
    msg.textContent = 'Token cleared from this browser.';
    load();
  });
}

/* ---------- routing ---------- */

function currentRoute() {
  const r = location.hash.replace(/^#/, '');
  return ['/open', '/all', '/settings', '/setup'].includes(r) ? r : '/open';
}

function templateFor(route) {
  if (route === '/settings') return 'tpl-settings';
  if (route === '/setup') return 'tpl-setup';
  return 'tpl-list';
}

function render() {
  const route = currentRoute();
  for (const a of document.querySelectorAll('nav a')) {
    a.classList.toggle('active', a.dataset.route === route);
  }

  view.replaceChildren(document.getElementById(templateFor(route)).content.cloneNode(true));

  if (route === '/settings') mountSettings();
  else if (route !== '/setup') mountList(route === '/all');

  modeTag.textContent = state.demo ? 'sample data' : state.config.repo || 'not connected';
  const generated = state.data && parseDate(state.data.generated_at);
  stamp.textContent = generated ? `snapshot ${generated.toLocaleString()}` : '';
}

window.addEventListener('hashchange', render);

render();
load();
