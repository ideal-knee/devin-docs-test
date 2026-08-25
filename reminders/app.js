/* Reminders Mirror: reads a JSON snapshot that an iOS Shortcut commits to this repo. */

const DEFAULT_REPO = { owner: 'ideal-knee', repo: 'devin-docs-test', branch: 'main' };
const DATA_PATH = 'data/reminders.json';

const state = {
  data: null,
  error: null,
  loading: false,
  query: '',
  list: '',
  source: localStorage.getItem('reminders-source') === 'raw' ? 'raw' : 'pages'
};

const view = document.getElementById('view');
const srcSelect = document.getElementById('src');
const stamp = document.getElementById('stamp');

/* ---------- data ---------- */

function repoInfo() {
  // On <owner>.github.io/<repo>/ the URL identifies the repo; elsewhere fall back.
  const host = location.hostname;
  const seg = location.pathname.split('/').filter(Boolean)[0];
  if (host.endsWith('.github.io') && seg) {
    return { owner: host.replace('.github.io', ''), repo: seg, branch: DEFAULT_REPO.branch };
  }
  return DEFAULT_REPO;
}

function dataUrl() {
  if (state.source === 'raw') {
    const { owner, repo, branch } = repoInfo();
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${DATA_PATH}`;
  }
  return new URL(`../${DATA_PATH}`, location.href).href;
}

async function load() {
  state.loading = true;
  state.error = null;
  render();
  try {
    const res = await fetch(`${dataUrl()}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const json = await res.json();
    if (!Array.isArray(json.reminders)) throw new Error('no "reminders" array in the JSON');
    state.data = json;
  } catch (err) {
    state.error = err.message;
  } finally {
    state.loading = false;
    render();
  }
}

/* ---------- helpers ---------- */

function parseDue(value) {
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
      const da = parseDue(a.due);
      const db = parseDue(b.due);
      if (da && db) return da - db;
      if (da) return -1;
      if (db) return 1;
      return (a.title || '').localeCompare(b.title || '');
    });
}

/* ---------- rendering ---------- */

function renderItems(showCompleted) {
  const items = document.getElementById('items');
  const empty = document.getElementById('empty');
  const status = document.getElementById('status');

  if (state.loading) status.textContent = 'Loading\u2026';
  else if (state.error) {
    status.textContent = `Could not load ${dataUrl()} \u2014 ${state.error}`;
    status.classList.add('error');
  } else status.textContent = '';

  items.innerHTML = '';
  const rows = state.data ? visible(state.data.reminders, showCompleted) : [];
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
    const due = parseDue(r.due);
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
    ? [...new Set(state.data.reminders.map(r => r.list).filter(Boolean))].sort()
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

function currentRoute() {
  const r = location.hash.replace(/^#/, '');
  return ['/open', '/all', '/setup'].includes(r) ? r : '/open';
}

function render() {
  const route = currentRoute();
  for (const a of document.querySelectorAll('nav a')) {
    a.classList.toggle('active', a.dataset.route === route);
  }

  const tpl = document.getElementById(route === '/setup' ? 'tpl-setup' : 'tpl-list');
  view.replaceChildren(tpl.content.cloneNode(true));

  if (route !== '/setup') mountList(route === '/all');

  const generated = state.data && state.data.generated_at ? parseDue(state.data.generated_at) : null;
  stamp.textContent = generated
    ? `snapshot ${generated.toLocaleString()}${state.data.source ? ` \u00b7 ${state.data.source}` : ''}`
    : '';
}

srcSelect.value = state.source;
srcSelect.addEventListener('change', () => {
  state.source = srcSelect.value;
  localStorage.setItem('reminders-source', state.source);
  load();
});

window.addEventListener('hashchange', render);

render();
load();
